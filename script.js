// attention3 — blocs séparés (Alerte / Bruit / Capture), + mode FULL A→B→C
// - Pas de superposition : chaque mécanisme est mesuré séparément
// - 2AFC PLUS/MOINS
// - Logging CSV (block/cond/soaMs/event/background + indices impulsivité/persévération)
// - Alerte réellement pré-consigne : tone puis consigne 400ms après (bloc A, essais A1/A2)
// - Capture : sons familiers post-consigne (bloc C) tirés au sort parmi 3
// - Bruit de fond : OFF/LOW/MID (bloc B) en 3 segments égaux

const els = {
  status: document.getElementById("status"),
  timer: document.getElementById("timer"),
  cueLabel: document.getElementById("cueLabel"),
  cueSub: document.getElementById("cueSub"),
  btnPlus: document.getElementById("btnPlus"),
  btnMinus: document.getElementById("btnMinus"),
  startBtn: document.getElementById("startBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  resetBtn: document.getElementById("resetBtn"),
  modeSelect: document.getElementById("modeSelect"),
  blockDurationSelect: document.getElementById("blockDurationSelect"),
};

const CONFIG = {
  // Timing essais
  minISI: 2200,
  maxISI: 4200,
  pPlus: 0.5,
  avoidLongRuns: true,
  maxRunLength: 3,
  showCueTextMs: 700,

  // Réponses
  minInterTapMs: 120,
  anticipatoryMs: 250, // tablette

  // Audio - tone "warning"
  toneFreqHz: 880,
  toneDurationMs: 120,
  toneGainLow: 0.08,
  toneGainHigh: 0.18,

  // Alerte (bloc A) : SOA fixe avant consigne
  alertSOAMs: -400, // (tone) puis consigne 400 ms après

  // Capture (bloc C) : post-consigne dans fenêtre décisionnelle (SOA > 0)
  captureSOAChoicesMs: [200, 300, 400],

  // Proportions internes aux blocs
  pAlertTrials: 0.50,     // bloc A : 50% baseline, 50% alert (split low/high)
  pCaptureTrials: 0.30,   // bloc C : 30% distracteurs, 70% baseline

  // Bruit de fond (bloc B) : segments OFF/LOW/MID
  bgLevels: [
    { name: "B0_off", gain: 0.0 },
    { name: "B1_low", gain: 0.10 },
    { name: "B2_mid", gain: 0.22 }
  ],

  // Fichiers audio (si absents, l'épreuve tourne quand même)
  files: {
    bgLoop: "media/noise_classroom_loop.wav", // loop stationnaire
    capture1: "media/door.wav",               // familier bref
    capture2: "media/chair.wav",              // familier bref
    capture3: "media/honk.wav"                // familier bref (klaxon léger)
  }
};

const state = {
  running: false,
  finished: false,

  // block sequencing
  mode: "FULL",              // A, B, C, FULL
  blockOrder: ["A", "B", "C"],
  currentBlockIndex: 0,
  currentBlock: null,        // "A" / "B" / "C"
  blockStartPerf: 0,
  blockDurationMs: 150000,
  totalStartPerf: 0,

  // scheduling
  rafId: null,
  timeouts: [],

  // trial state
  lastTapPerf: 0,
  trialCount: 0,
  currentCue: null,
  lastCueLabel: null,
  lastRunLength: 0,

  // previous response (for perseveration)
  prevChoice: "",
  prevCueLabel: "",

  // for "trialAfterEvent"
  lastEventTrialIndex: null,

  logs: [],

  // audio
  audioCtx: null,
  masterGain: null,

  // background
  bgSource: null,
  bgGainNode: null,
  bgBuffer: null,
};

// ---------- Utils ----------
function nowPerf(){ return performance.now(); }

function schedule(fn, ms){
  const id = setTimeout(fn, ms);
  state.timeouts.push(id);
}

function clearScheduled(){
  state.timeouts.forEach(clearTimeout);
  state.timeouts = [];
  if(state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
}

function randBetween(a,b){ return a + Math.random()*(b-a); }

function fmtSeconds(ms){
  return (ms/1000).toFixed(1).padStart(4, "0") + "s";
}

function setStatus(t){ if(els.status) els.status.textContent = t; }
function setCue(a,b=""){ if(els.cueLabel) els.cueLabel.textContent=a; if(els.cueSub) els.cueSub.textContent=b; }

function speak(text){
  if(!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "fr-FR";
  u.rate = 1.0;
  u.pitch = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.speak(u);
}

// ---------- Random PLUS/MOINS ----------
function pickCueLabel(){
  let l = (Math.random() < CONFIG.pPlus) ? "PLUS" : "MOINS";
  if(CONFIG.avoidLongRuns && state.trialCount >= 1){
    const last = state.lastCueLabel;
    const runLen = state.lastRunLength || 1;
    if(l === last && runLen >= CONFIG.maxRunLength){
      l = (last === "PLUS") ? "MOINS" : "PLUS";
    }
  }
  return l;
}
function updateRunStats(l){
  if(l === state.lastCueLabel) state.lastRunLength = (state.lastRunLength || 1) + 1;
  else { state.lastRunLength = 1; state.lastCueLabel = l; }
}
function cueToCorrect(l){ return (l === "PLUS") ? "+" : "-"; }

// ---------- Audio helpers ----------
function initAudioIfNeeded(){
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if(!AudioContext) return;

  if(!state.audioCtx){
    state.audioCtx = new AudioContext();
    state.masterGain = state.audioCtx.createGain();
    state.masterGain.gain.value = 1.0;
    state.masterGain.connect(state.audioCtx.destination);
  }
  if(state.audioCtx.state === "suspended"){
    state.audioCtx.resume();
  }
}

function playTone(gainValue){
  try{
    initAudioIfNeeded();
    if(!state.audioCtx || !state.masterGain) return;

    const ctx = state.audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = CONFIG.toneFreqHz;

    const now = ctx.currentTime;
    const g = Math.max(0.0001, gainValue);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(g, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.03, CONFIG.toneDurationMs/1000));

    osc.connect(gain);
    gain.connect(state.masterGain);

    osc.start(now);
    osc.stop(now + Math.max(0.05, CONFIG.toneDurationMs/1000) + 0.02);
  } catch {}
}

async function loadBgBufferIfNeeded(){
  if(state.bgBuffer) return;
  initAudioIfNeeded();
  if(!state.audioCtx) return;

  try{
    const res = await fetch(CONFIG.files.bgLoop, { cache: "no-store" });
    const arr = await res.arrayBuffer();
    state.bgBuffer = await state.audioCtx.decodeAudioData(arr);
  } catch {
    state.bgBuffer = null;
  }
}

async function setBackgroundLevelByName(bgName){
  // bgName: B0_off/B1_low/B2_mid
  const level = CONFIG.bgLevels.find(x => x.name === bgName) || CONFIG.bgLevels[0];

  stopBackground();

  if(level.gain <= 0){
    return;
  }

  initAudioIfNeeded();
  await loadBgBufferIfNeeded();
  if(!state.bgBuffer || !state.audioCtx || !state.masterGain) return;

  try{
    const src = state.audioCtx.createBufferSource();
    src.buffer = state.bgBuffer;
    src.loop = true;

    const g = state.audioCtx.createGain();
    g.gain.value = level.gain;

    src.connect(g);
    g.connect(state.masterGain);

    src.start();
    state.bgSource = src;
    state.bgGainNode = g;
  } catch {}
}

function stopBackground(){
  try{
    if(state.bgSource){
      state.bgSource.stop();
      state.bgSource.disconnect();
    }
  } catch {}
  state.bgSource = null;
  state.bgGainNode = null;
}

function pickCaptureFile(){
  const files = [CONFIG.files.capture1, CONFIG.files.capture2, CONFIG.files.capture3].filter(Boolean);
  if(!files.length) return null;
  return files[Math.floor(Math.random() * files.length)];
}

function playCaptureSound(){
  initAudioIfNeeded();
  if(!state.audioCtx || !state.masterGain) return;

  const file = pickCaptureFile();
  if(!file) return;

  fetch(file, { cache: "no-store" })
    .then(r => r.arrayBuffer())
    .then(buf => state.audioCtx.decodeAudioData(buf))
    .then(decoded => {
      const src = state.audioCtx.createBufferSource();
      src.buffer = decoded;

      const g = state.audioCtx.createGain();
      g.gain.value = 0.35; // ajustable
      src.connect(g);
      g.connect(state.masterGain);
      src.start();
    })
    .catch(() => {});
}

// ---------- Block logic ----------
function computeBlockPlan(){
  const mode = els.modeSelect?.value || "FULL";
  state.mode = mode;
  state.blockOrder = (mode === "FULL") ? ["A","B","C"] : [mode];
  state.currentBlockIndex = 0;
}

function currentBlockName(){
  return state.blockOrder[state.currentBlockIndex] || null;
}

function runBackgroundScheduleForBlockB(){
  // split block in 3 equal segments: off -> low -> mid
  const seg = Math.floor(state.blockDurationMs / 3);

  setBackgroundLevelByName("B0_off");

  schedule(() => {
    if(!state.running || state.currentBlock !== "B") return;
    setBackgroundLevelByName("B1_low");
  }, seg);

  schedule(() => {
    if(!state.running || state.currentBlock !== "B") return;
    setBackgroundLevelByName("B2_mid");
  }, seg * 2);
}

function startNextBlock(){
  if(state.currentBlockIndex >= state.blockOrder.length){
    stopRun();
    return;
  }

  state.currentBlock = currentBlockName();
  state.blockStartPerf = nowPerf();

  // reset block-specific counters
  state.trialCount = 0;
  state.currentCue = null;
  state.lastCueLabel = null;
  state.lastRunLength = 0;
  state.prevChoice = "";
  state.prevCueLabel = "";
  state.lastEventTrialIndex = null;

  // UI hint
  const label = state.currentBlock === "A" ? "Bloc A (Alerte)"
              : state.currentBlock === "B" ? "Bloc B (Bruit)"
              : "Bloc C (Capture)";
  setStatus(`En cours — ${label}`);
  setCue(label, "Répondez + / −");

  if(state.currentBlock === "B"){
    runBackgroundScheduleForBlockB();
  } else {
    stopBackground();
  }

  presentCueWithBlockRules(); // first cue
  scheduleNextCue();

  schedule(() => endBlockAndAdvance(), state.blockDurationMs);
}

function endBlockAndAdvance(){
  if(state.currentCue && !state.currentCue.responded){
    logOmissionFromCue(state.currentCue);
  }

  stopBackground();

  state.currentBlockIndex += 1;

  if(state.currentBlockIndex < state.blockOrder.length){
    setCue("Pause", "On continue…");
    schedule(() => {
      if(!state.running) return;
      startNextBlock();
    }, 1500);
  } else {
    stopRun();
  }
}

// ---------- Trial plan ----------
function decideConditionForTrial(){
  const block = state.currentBlock;

  if(block === "A"){
    // 50% baseline, 50% alert split low/high
    const r = Math.random();
    if(r < 0.50) return { cond: "A0", preAlert: false, preAlertGain: 0, soaMs: "" };
    const high = (Math.random() < 0.5);
    return {
      cond: high ? "A2" : "A1",
      preAlert: true,
      preAlertGain: high ? CONFIG.toneGainHigh : CONFIG.toneGainLow,
      soaMs: CONFIG.alertSOAMs
    };
  }

  if(block === "B"){
    // condition is the current background segment
    const elapsed = nowPerf() - state.blockStartPerf;
    const seg = state.blockDurationMs / 3;
    const bg = (elapsed < seg) ? "B0" : (elapsed < seg*2) ? "B1" : "B2";
    return { cond: bg, preAlert: false, preAlertGain: 0, soaMs: "" };
  }

  // block C: 30% capture trials
  if(Math.random() < CONFIG.pCaptureTrials){
    const soa = CONFIG.captureSOAChoicesMs[Math.floor(Math.random()*CONFIG.captureSOAChoicesMs.length)];
    return { cond: "C1", postCapture: true, postSOA: soa, soaMs: soa };
  }
  return { cond: "C0", postCapture: false, soaMs: "" };
}

// ---------- Trial presentation ----------
function presentCueWithBlockRules(){
  // log omission previous
  if(state.currentCue && !state.currentCue.responded){
    logOmissionFromCue(state.currentCue);
  }

  const label = pickCueLabel();
  updateRunStats(label);

  const cueTimePerf = nowPerf();
  const cueTimeRelMs = Math.round(cueTimePerf - state.totalStartPerf);

  const plan = decideConditionForTrial();

  // background label for block B
  let backgroundLevel = "";
  if(state.currentBlock === "B"){
    backgroundLevel = plan.cond; // B0/B1/B2
  }

  // trialAfterEvent
  let trialAfterEvent = 0;
  if(state.lastEventTrialIndex !== null){
    const d = state.trialCount - state.lastEventTrialIndex;
    if(d === 1) trialAfterEvent = 1;
    else if(d === 2) trialAfterEvent = 2;
  }

  state.currentCue = {
    trialIndex: state.trialCount,
    block: state.currentBlock,
    condition: plan.cond,
    cueLabel: label,
    correct: cueToCorrect(label),
    cueTimePerf,
    cueTimeRelMs,
    responded: false,

    soaMs: plan.soaMs ?? "",
    eventType: "",
    eventSalience: "",
    backgroundLevel,
    trialAfterEvent,

    anticipatory: 0,
    perseveration: 0,
    sameAsPrevChoice: 0,
    omission: 0
  };

  const showCueNow = () => {
    setCue(`Consigne : ${label}`, "Répondez avec + / −");
    speak(label.toLowerCase());
    schedule(() => setCue("Continuez…", ""), CONFIG.showCueTextMs);
  };

  // --- Bloc A : alerte réellement pré-consigne ---
  if(state.currentBlock === "A" && plan.preAlert){
    state.currentCue.eventType = "alert_tone";
    state.currentCue.eventSalience = (plan.cond === "A2") ? "high" : "low";

    // 1) tone maintenant
    playTone(plan.preAlertGain);

    // 2) consigne après 400 ms
    const delay = Math.max(0, -CONFIG.alertSOAMs);
    schedule(() => {
      if(!state.running) return;
      showCueNow();
    }, delay);

  } else {
    // autres blocs ou essais baseline
    showCueNow();
  }

  // --- Bloc C : distracteur familier post-consigne ---
  if(state.currentBlock === "C" && plan.postCapture){
    state.currentCue.eventType = "capture_familiar";
    state.currentCue.eventSalience = "familiar";
    state.lastEventTrialIndex = state.trialCount;

    schedule(() => {
      if(!state.running) return;
      playCaptureSound();
    }, plan.postSOA);
  }

  state.trialCount += 1;
}

function scheduleNextCue(){
  if(!state.running) return;

  const elapsedBlock = nowPerf() - state.blockStartPerf;
  if(elapsedBlock >= state.blockDurationMs) return;

  const isi = Math.round(randBetween(CONFIG.minISI, CONFIG.maxISI));
  schedule(() => {
    if(!state.running) return;
    const e2 = nowPerf() - state.blockStartPerf;
    if(e2 >= state.blockDurationMs) return;
    presentCueWithBlockRules();
    scheduleNextCue();
  }, isi);
}

// ---------- Logging helpers ----------
function logOmissionFromCue(cue){
  state.logs.push({
    trialIndex: cue.trialIndex,
    block: cue.block,
    condition: cue.condition,
    cueLabel: cue.cueLabel,
    correctAnswer: cue.correct,
    choice: "",
    correct: "",
    rtMs: "",
    cueTimeRelMs: cue.cueTimeRelMs,
    minuteBin: Math.floor(cue.cueTimeRelMs/60000),
    soaMs: cue.soaMs ?? "",
    eventType: cue.eventType ?? "",
    eventSalience: cue.eventSalience ?? "",
    backgroundLevel: cue.backgroundLevel ?? "",
    trialAfterEvent: cue.trialAfterEvent ?? 0,
    anticipatory: "",
    perseveration: "",
    sameAsPrevChoice: "",
    omission: 1
  });
}

// ---------- Responses ----------
function flashAcknowledged(btn){
  const oldBg = btn.style.background;
  const oldBox = btn.style.boxShadow;

  btn.style.background = "rgba(140,255,140,0.95)";
  btn.style.boxShadow = "0 0 0 10px rgba(255,255,255,0.35), 0 12px 28px rgba(0,0,0,0.35)";

  schedule(() => {
    btn.style.background = oldBg || "";
    btn.style.boxShadow = oldBox || "";
  }, 160);
}

function handleResponse(choice){
  if(!state.running) return;
  if(state.finished) return;

  const t = nowPerf();
  if(t - state.lastTapPerf < CONFIG.minInterTapMs) return;
  state.lastTapPerf = t;

  const cue = state.currentCue;
  if(!cue || cue.responded) return;

  cue.responded = true;

  const rtMs = Math.round(t - cue.cueTimePerf);
  const correct = (choice === cue.correct) ? 1 : 0;

  const sameAsPrevChoice = (state.prevChoice && choice === state.prevChoice) ? 1 : 0;
  const perseveration = (state.prevCueLabel && state.prevCueLabel !== cue.cueLabel && sameAsPrevChoice) ? 1 : 0;
  const anticipatory = (rtMs > 0 && rtMs < CONFIG.anticipatoryMs) ? 1 : 0;

  state.logs.push({
    trialIndex: cue.trialIndex,
    block: cue.block,
    condition: cue.condition,
    cueLabel: cue.cueLabel,
    correctAnswer: cue.correct,
    choice,
    correct,
    rtMs,
    cueTimeRelMs: cue.cueTimeRelMs,
    minuteBin: Math.floor(cue.cueTimeRelMs/60000),
    soaMs: cue.soaMs ?? "",
    eventType: cue.eventType ?? "",
    eventSalience: cue.eventSalience ?? "",
    backgroundLevel: cue.backgroundLevel ?? "",
    trialAfterEvent: cue.trialAfterEvent ?? 0,
    anticipatory,
    perseveration,
    sameAsPrevChoice,
    omission: 0
  });

  state.prevChoice = choice;
  state.prevCueLabel = cue.cueLabel;

  flashAcknowledged(choice === "+" ? els.btnPlus : els.btnMinus);
}

// ---------- Timer ----------
function updateTimer(){
  if(!state.running) return;
  const elapsed = nowPerf() - state.totalStartPerf;
  if(els.timer) els.timer.textContent = fmtSeconds(elapsed);
  state.rafId = requestAnimationFrame(updateTimer);
}

// ---------- Run control ----------
function startRun(){
  if(state.running) return;

  state.finished = false;
  computeBlockPlan();
  state.blockDurationMs = Number(els.blockDurationSelect?.value || 150000);

  clearScheduled();
  state.logs = [];
  state.running = true;
  setStatus("En cours");
  setCue("Démarrage…", "Restez prêt.");

  if(els.downloadBtn) els.downloadBtn.disabled = true;

  if(els.btnPlus) els.btnPlus.disabled = false;
  if(els.btnMinus) els.btnMinus.disabled = false;

  // init audio after gesture
  initAudioIfNeeded();

  state.totalStartPerf = nowPerf();
  if(els.timer) els.timer.textContent = "00.0s";
  updateTimer();

  startNextBlock();
}

function stopRun(){
  if(!state.running) return;

  if(state.currentCue && !state.currentCue.responded){
    logOmissionFromCue(state.currentCue);
  }

  state.running = false;
  state.finished = true;
  clearScheduled();
  stopBackground();

  setStatus("Terminé");
  setCue("Terminé.", "Téléchargez le CSV.");

  if(els.downloadBtn) els.downloadBtn.disabled = false;
  if(els.btnPlus) els.btnPlus.disabled = true;
  if(els.btnMinus) els.btnMinus.disabled = true;
}

function resetAll(){
  clearScheduled();
  stopBackground();

  state.running = false;
  state.finished = false;
  state.logs = [];
  state.currentCue = null;
  state.currentBlock = null;
  state.currentBlockIndex = 0;

  if(els.timer) els.timer.textContent = "00.0s";
  setStatus("Prêt");
  setCue("Appuie sur + quand j'ai dit PLUS, et sur − quand j'ai dit MOINS.", "Réglages en haut, puis Démarrer.");

  if(els.downloadBtn) els.downloadBtn.disabled = true;
  if(els.btnPlus) els.btnPlus.disabled = false;
  if(els.btnMinus) els.btnMinus.disabled = false;
}

// ---------- CSV ----------
function exportCSV(){
  const header = [
    "trialIndex","block","condition",
    "cueLabel","correctAnswer","choice","correct",
    "rtMs","cueTimeRelMs","minuteBin",
    "soaMs","eventType","eventSalience","backgroundLevel","trialAfterEvent",
    "anticipatory","perseveration","sameAsPrevChoice","omission"
  ];

  const rows = [header.join(",")];

  for(const r of state.logs){
    rows.push([
      r.trialIndex ?? "",
      r.block ?? "",
      r.condition ?? "",
      r.cueLabel ?? "",
      r.correctAnswer ?? "",
      r.choice ?? "",
      r.correct ?? "",
      r.rtMs ?? "",
      r.cueTimeRelMs ?? "",
      r.minuteBin ?? "",
      r.soaMs ?? "",
      r.eventType ?? "",
      r.eventSalience ?? "",
      r.backgroundLevel ?? "",
      r.trialAfterEvent ?? 0,
      r.anticipatory ?? "",
      r.perseveration ?? "",
      r.sameAsPrevChoice ?? "",
      r.omission ?? ""
    ].join(","));
  }

  const blob = new Blob([rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `attention3_${new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- UI binding ----------
function bindUI(){
  if(els.btnPlus){
    els.btnPlus.addEventListener("click", () => {
      if(state.finished) return;
      if(!state.running) return;
      handleResponse("+");
    });
  }

  if(els.btnMinus){
    els.btnMinus.addEventListener("click", () => {
      if(state.finished) return;
      if(!state.running) return;
      handleResponse("-");
    });
  }

  if(els.startBtn) els.startBtn.addEventListener("click", startRun);
  if(els.downloadBtn) els.downloadBtn.addEventListener("click", exportCSV);
  if(els.resetBtn) els.resetBtn.addEventListener("click", resetAll);
}

(function main(){
  bindUI();
  resetAll();
})();
