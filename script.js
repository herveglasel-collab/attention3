// attention3 — blocs séparés (Alerte / Bruit / Capture), + mode FULL A→B→C
// - Pas de superposition : chaque mécanisme est mesuré séparément
// - 2AFC PLUS/MOINS
// - Logging CSV (block/cond/soaMs/event/background + indices impulsivité/persévération)

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
  alertSOAMs: -400, // ms relatif à la consigne

  // Capture (bloc C) : post-consigne dans fenêtre décisionnelle (SOA > 0)
  captureSOAChoicesMs: [200, 300, 400],

  // Proportions internes aux blocs
  pAlertTrials: 0.50,     // dans bloc A : 50% baseline, 50% alert (split low/high)
  pCaptureTrials: 0.30,   // dans bloc C : 30% distracteurs, 70% baseline

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
  blockDurationMs: 150000,   // default from UI
  totalStartPerf: 0,

  // scheduling
  rafId: null,
  timeouts: [],

  // trial state
  startPerf: 0,              // alias totalStartPerf for consistency
  lastTapPerf: 0,
  trialCount: 0,
  currentCue: null,
  lastCueLabel: null,
  lastRunLength: 0,

  // previous response (for perseveration)
  prevChoice: "",
  prevCorrect: "",
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
  if(!state.audioCtx) initAudioIfNeeded();
  if(!state.audioCtx) return;

  try{
    const res = await fetch(CONFIG.files.bgLoop, { cache: "no-store" });
    const arr = await res.arrayBuffer();
    state.bgBuffer = await state.audioCtx.decodeAudioData(arr);
  } catch {
    state.bgBuffer = null;
  }
}

async function setBackgroundLevel(name){
  // name in CONFIG.bgLevels[].name
  const level = CONFIG.bgLevels.find(x => x.name === name) || CONFIG.bgLevels[0];

  // stop existing
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

function playCaptureSound(){
  // plays one of two familiar sounds (optional)
  // if files missing, silently ignore
  initAudioIfNeeded();
  if(!state.audioCtx || !state.masterGain) return;

  const file = (Math.random() < 0.5) ? CONFIG.files.capture1 : CONFIG.files.capture2;
  fetch(file, { cache: "no-store" })
    .then(r => r.arrayBuffer())
    .then(buf => state.audioCtx.decodeAudioData(buf))
    .then(decoded => {
      const src = state.audioCtx.createBufferSource();
      src.buffer = decoded;

      const g = state.audioCtx.createGain();
      g.gain.value = 0.35; // fixed for now (familiers)
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

  if(mode === "FULL"){
    state.blockOrder = ["A","B","C"];
  } else {
    state.blockOrder = [mode];
  }

  state.currentBlockIndex = 0;
}

function currentBlockName(){
  return state.blockOrder[state.currentBlockIndex] || null;
}

function startNextBlock(){
  if(state.currentBlockIndex >= state.blockOrder.length){
    stopRun(); // full done
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
  state.prevCorrect = "";
  state.prevCueLabel = "";
  state.lastEventTrialIndex = null;

  // UI hint
  const label = state.currentBlock === "A" ? "Bloc A (Alerte)"
              : state.currentBlock === "B" ? "Bloc B (Bruit)"
              : "Bloc C (Capture)";
  setStatus(`En cours — ${label}`);
  setCue(label, "Répondez + / −");

  // configure background for block B (starts at B0, then changes over time)
  if(state.currentBlock === "B"){
    runBackgroundScheduleForBlockB();
  } else {
    stopBackground();
  }

  // schedule trials for this block
  presentCueWithBlockRules(); // immediate first cue
  scheduleNextCue();

  // stop this block after duration, then auto advance
  schedule(() => {
    endBlockAndAdvance();
  }, state.blockDurationMs);
}

function endBlockAndAdvance(){
  // finalize omission if needed
  if(state.currentCue && !state.currentCue.responded){
    logOmissionFromCue(state.currentCue);
  }

  // move to next block after a short pause (only in FULL)
  state.currentBlockIndex += 1;

  if(state.currentBlockIndex < state.blockOrder.length){
    // pause 2s with message
    stopBackground();
    setCue("Pause", "On continue…");
    schedule(() => {
      if(!state.running) return;
      startNextBlock();
    }, 1500);
  } else {
    stopRun();
  }
}

function runBackgroundScheduleForBlockB(){
  // split block in 3 equal segments: off -> low -> mid
  const seg = Math.floor(state.blockDurationMs / 3);

  // immediate B0_off
  setBackgroundLevel("B0_off");

  schedule(() => {
    if(!state.running || state.currentBlock !== "B") return;
    setBackgroundLevel("B1_low");
  }, seg);

  schedule(() => {
    if(!state.running || state.currentBlock !== "B") return;
    setBackgroundLevel("B2_mid");
  }, seg * 2);
}

// ---------- Trial presentation with block rules ----------
function decideConditionForTrial(){
  const block = state.currentBlock;

  if(block === "A"){
    // 50% baseline, 50% alert split low/high
    const r = Math.random();
    if(r < 0.50) return { cond: "A0", preAlert: false, preAlertGain: 0, soaMs: "" };
    // alert trial
    const high = (Math.random() < 0.5);
    return {
      cond: high ? "A2" : "A1",
      preAlert: true,
      preAlertGain: high ? CONFIG.toneGainHigh : CONFIG.toneGainLow,
      soaMs: CONFIG.alertSOAMs
    };
  }

  if(block === "B"){
    // background only: log bg segment as condition
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

function presentCueWithBlockRules(){
  // log omission from previous cue if needed
  if(state.currentCue && !state.currentCue.responded){
    logOmissionFromCue(state.currentCue);
  }

  const label = pickCueLabel();
  updateRunStats(label);

  const cueTimePerf = nowPerf();
  const cueTimeRelMs = Math.round(cueTimePerf - state.totalStartPerf);

  const plan = decideConditionForTrial();

  // For block A: schedule pre-alert relative to cue time
  let eventType = "";
  let eventSalience = "";
  let backgroundLevel = "";
  let trialAfterEvent = 0;

  // background label for block B
  if(state.currentBlock === "B"){
    backgroundLevel = plan.cond; // B0/B1/B2 (simple label)
  }

  // trialAfterEvent: based on lastEventTrialIndex
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
    eventType: eventType,
    eventSalience: eventSalience,
    backgroundLevel: backgroundLevel,
    trialAfterEvent: trialAfterEvent,

    // will be filled on response:
    anticipatory: 0,
    perseveration: 0,
    sameAsPrevChoice: 0,
  };

  // For pre-alert, fire tone before the spoken cue (SOA negative)
  if(plan.preAlert){
    state.currentCue.eventType = "alert_tone";
    state.currentCue.eventSalience = (plan.cond === "A2") ? "high" : "low";
    schedule(() => {
      if(!state.running) return;
      playTone(plan.preAlertGain);
    }, Math.max(0, -CONFIG.alertSOAMs)); // alertSOA=-400 => play after 400ms delay BEFORE cue shown
  }

  // Show cue now, speak now
  setCue(`Consigne : ${label}`, "Répondez avec + / −");
  speak(label.toLowerCase());
  schedule(() => setCue("Continuez…", ""), CONFIG.showCueTextMs);

  // Block C: schedule post-capture distractor after cue onset
  if(plan.postCapture){
    state.currentCue.eventType = "capture_familiar";
    state.currentCue.eventSalience = "familiar";
    state.lastEventTrialIndex = state.trialCount;

    schedule(() => {
      if(!state.running) return;
      // play brief familiar sound (optional)
      playCaptureSound();
    }, plan.postSOA);
  }

  state.trialCount += 1;
}

function scheduleNextCue(){
  if(!state.running) return;

  const elapsedBlock = nowPerf() - state.blockStartPerf;
  if(elapsedBlock >= state.blockDurationMs){
    return; // block end scheduled elsewhere
  }

  const isi = Math.round(randBetween(CONFIG.minISI, CONFIG.maxISI));
  schedule(() => {
    if(!state.running) return;
    // prevent overrun if block just ended
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

  // update prev
  state.prevChoice = choice;
  state.prevCorrect = cue.correct;
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

  // unlock
  state.finished = false;

  // read UI
  computeBlockPlan();
  state.blockDurationMs = Number(els.blockDurationSelect?.value || 150000);

  // init
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
  state.startPerf = state.totalStartPerf;
  if(els.timer) els.timer.textContent = "00.0s";
  updateTimer();

  // start first block
  startNextBlock();
}

function stopRun(){
  if(!state.running) return;

  // finalize last omission
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

  // no implicit start on pointerdown
  document.addEventListener("pointerdown", () => {
    if(state.finished) return;
  }, { passive: true });
}

(function main(){
  bindUI();
  resetAll();
})();

