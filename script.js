// attention3 v3.2 — STABLE
// Blocs séparés A (alerte) / B (bruit) / C (capture)
// ISI strictement identique dans tous les blocs
// Pré-délai AVANT consigne identique partout (évite télescopage)
// Alerte jouée DANS ce délai en bloc A
// Capture strictement POST-consigne en bloc C

/* =======================
   ELEMENTS DOM
======================= */
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
  blockDurationSelect: document.getElementById("blockDurationSelect")
};

/* =======================
   CONFIGURATION
======================= */
const CONFIG = {
  // ISI réel (identique A/B/C)
  minISI: 2400,
  maxISI: 4800,

  // Délai systématique AVANT consigne
  preCueDelayMs: 400,

  // Réponses
  pPlus: 0.5,
  avoidLongRuns: true,
  maxRunLength: 3,
  minInterTapMs: 120,
  anticipatoryMs: 250,

  // Alerte (bloc A)
  toneFreqHz: 880,
  toneDurationMs: 120,
  toneGainLow: 0.08,
  toneGainHigh: 0.18,

  // Capture (bloc C)
  captureSOAs: [200, 300, 400],
  pCaptureTrials: 0.30,

  // Bruit de fond (bloc B)
  bgLevels: [
    { name: "B0_off", gain: 0.0 },
    { name: "B1_low", gain: 0.10 },
    { name: "B2_mid", gain: 0.22 }
  ],

  // Fichiers audio
  files: {
    bgLoop: "media/noise_classroom_loop.wav",
    capture1: "media/door.wav",
    capture2: "media/chair.wav",
    capture3: "media/honk.wav"
  }
};

/* =======================
   ETAT
======================= */
const state = {
  running: false,
  finished: false,

  blockOrder: ["A","B","C"],
  currentBlockIndex: 0,
  currentBlock: null,
  blockStartPerf: 0,
  blockDurationMs: 180000,

  totalStartPerf: 0,
  rafId: null,
  timeouts: [],

  trialCount: 0,
  currentCue: null,
  lastCueLabel: null,
  lastRunLength: 0,

  prevChoice: "",
  prevCueLabel: "",
  lastEventTrialIndex: null,

  logs: [],

  audioCtx: null,
  masterGain: null,
  bgSource: null,
  bgBuffer: null
};

/* =======================
   UTILS
======================= */
function now(){ return performance.now(); }

function schedule(fn, ms){
  const id = setTimeout(fn, ms);
  state.timeouts.push(id);
}

function clearAllTimers(){
  state.timeouts.forEach(clearTimeout);
  state.timeouts = [];
  if(state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
}

function randBetween(a,b){ return a + Math.random()*(b-a); }

function setStatus(t){ els.status.textContent = t; }
function setCue(a,b=""){ els.cueLabel.textContent=a; els.cueSub.textContent=b; }

function speak(txt){
  if(!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(txt);
  u.lang="fr-FR"; u.rate=1; u.pitch=1; u.volume=1;
  speechSynthesis.speak(u);
}

/* =======================
   AUDIO
======================= */
function initAudio(){
  if(state.audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if(!AC) return;
  state.audioCtx = new AC();
  state.masterGain = state.audioCtx.createGain();
  state.masterGain.gain.value = 1;
  state.masterGain.connect(state.audioCtx.destination);
}

function playTone(g){
  initAudio();
  const ctx = state.audioCtx;
  if(!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = CONFIG.toneFreqHz;

  const t = ctx.currentTime;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(g, t+0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t+CONFIG.toneDurationMs/1000);

  osc.connect(gain);
  gain.connect(state.masterGain);
  osc.start(t);
  osc.stop(t+0.2);
}

function playCapture(){
  initAudio();
  const files=[CONFIG.files.capture1,CONFIG.files.capture2,CONFIG.files.capture3];
  const f=files[Math.floor(Math.random()*files.length)];
  fetch(f).then(r=>r.arrayBuffer()).then(b=>state.audioCtx.decodeAudioData(b)).then(buf=>{
    const s=state.audioCtx.createBufferSource();
    const g=state.audioCtx.createGain();
    g.gain.value=0.35;
    s.buffer=buf; s.connect(g); g.connect(state.masterGain); s.start();
  }).catch(()=>{});
}

/* =======================
   LOGIQUE ESSAIS
======================= */
function pickCue(){
  let l = Math.random()<CONFIG.pPlus ? "PLUS":"MOINS";
  if(CONFIG.avoidLongRuns && l===state.lastCueLabel && state.lastRunLength>=CONFIG.maxRunLength){
    l = l==="PLUS"?"MOINS":"PLUS";
  }
  state.lastRunLength = l===state.lastCueLabel ? state.lastRunLength+1 : 1;
  state.lastCueLabel = l;
  return l;
}

function decideTrialPlan(){
  if(state.currentBlock==="A"){
    if(Math.random()<0.5) return {cond:"A0"};
    const high=Math.random()<0.5;
    return {cond:high?"A2":"A1", alert:true, gain:high?CONFIG.toneGainHigh:CONFIG.toneGainLow};
  }
  if(state.currentBlock==="C" && Math.random()<CONFIG.pCaptureTrials){
    return {cond:"C1", capture:true, soa:CONFIG.captureSOAs[Math.floor(Math.random()*CONFIG.captureSOAs.length)]};
  }
  return {cond:state.currentBlock+"0"};
}

/* =======================
   PRESENTATION ESSAI
======================= */
function presentTrial(){
  if(state.currentCue && !state.currentCue.responded){
    logOmission(state.currentCue);
  }

  const plan = decideTrialPlan();
  const label = pickCue();
  const cueTimePerf = now();
  const cueTimeRelMs = Math.round(cueTimePerf - state.totalStartPerf);

  state.currentCue = {
    trialIndex: state.trialCount,
    block: state.currentBlock,
    condition: plan.cond,
    cueLabel: label,
    correct: label==="PLUS"?"+":"-",
    cueTimeRelMs,
    responded:false,
    eventType:"",
    soaMs:"",
    omission:0
  };

  // === PRE-DELAI UNIFORME ===
  if(plan.alert){
    state.currentCue.eventType="alert";
    playTone(plan.gain);
  }

  schedule(()=>{
    if(!state.running) return;

    setCue(`Consigne : ${label}`,"Répondez avec + / −");
    speak(label.toLowerCase());

    if(plan.capture){
      state.currentCue.eventType="capture";
      state.currentCue.soaMs=plan.soa;
      state.lastEventTrialIndex=state.trialCount;
      schedule(()=>{ if(state.running) playCapture(); }, plan.soa);
    }

    schedule(()=>setCue("Continuez…",""),700);

  }, CONFIG.preCueDelayMs);

  state.trialCount++;
}

/* =======================
   CHAINE ISI
======================= */
function scheduleNextTrial(){
  if(!state.running) return;
  const isi = randBetween(CONFIG.minISI,CONFIG.maxISI);
  schedule(()=>{
    if(!state.running) return;
    const elapsed = now()-state.blockStartPerf;
    if(elapsed>=state.blockDurationMs) return;
    presentTrial();
    scheduleNextTrial();
  }, isi);
}

/* =======================
   BLOCS
======================= */
function startBlock(){
  clearAllTimers();
  state.trialCount=0;
  state.currentCue=null;
  state.lastCueLabel=null;
  state.lastRunLength=0;
  state.blockStartPerf=now();

  setStatus(`Bloc ${state.currentBlock}`);
  presentTrial();
  scheduleNextTrial();

  schedule(()=>endBlock(), state.blockDurationMs);
}

function endBlock(){
  clearAllTimers();
  state.currentBlockIndex++;
  if(state.currentBlockIndex<state.blockOrder.length){
    state.currentBlock=state.blockOrder[state.currentBlockIndex];
    schedule(startBlock,1500);
  } else stopRun();
}

/* =======================
   REPONSES
======================= */
function handleResponse(choice){
  if(!state.running||state.finished) return;
  const t=now();
  const cue=state.currentCue;
  if(!cue||cue.responded) return;

  cue.responded=true;
  const rt=t-(state.totalStartPerf+cue.cueTimeRelMs);

  state.logs.push({
    trialIndex: cue.trialIndex,
    block: cue.block,
    condition: cue.condition,
    cueLabel: cue.cueLabel,
    choice,
    correct: choice===cue.correct?1:0,
    rtMs: Math.round(rt),
    cueTimeRelMs: cue.cueTimeRelMs,
    eventType: cue.eventType,
    soaMs: cue.soaMs,
    omission:0
  });
}

/* =======================
   OMISSION
======================= */
function logOmission(cue){
  state.logs.push({
    trialIndex: cue.trialIndex,
    block: cue.block,
    condition: cue.condition,
    cueLabel: cue.cueLabel,
    omission:1
  });
}

/* =======================
   RUN CONTROL
======================= */
function startRun(){
  if(state.running) return;
  state.running=true;
  state.finished=false;
  state.logs=[];
  state.totalStartPerf=now();
  state.blockDurationMs=Number(els.blockDurationSelect.value||180000);
  state.currentBlockIndex=0;
  state.currentBlock=state.blockOrder[0];
  startBlock();
}

function stopRun(){
  clearAllTimers();
  state.running=false;
  state.finished=true;
  setStatus("Terminé");
  setCue("Terminé.","Télécharger le CSV");
  els.downloadBtn.disabled=false;
}

/* =======================
   CSV
======================= */
function exportCSV(){
  const h=["trialIndex","block","condition","cueLabel","choice","correct","rtMs","cueTimeRelMs","eventType","soaMs","omission"];
  const r=[h.join(",")];
  state.logs.forEach(o=>{
    r.push(h.map(k=>o[k]??"").join(","));
  });
  const blob=new Blob([r.join("\n")],{type:"text/csv"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download="attention3.csv";
  a.click();
}

/* =======================
   UI
======================= */
function bindUI(){
  els.btnPlus.onclick=()=>handleResponse("+");
  els.btnMinus.onclick=()=>handleResponse("-");
  els.startBtn.onclick=startRun;
  els.downloadBtn.onclick=exportCSV;
}

bindUI();
