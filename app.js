(() => {
  // Range: keezh Pa (5 semitones below Sa) up to mel Pa (19 above Sa) = 25 keys
  const LOW = -5, HIGH = 19;
  const SWARA = ['S','R1','R2 / G1','R3 / G2','G3','M1','M2','P','D1','D2 / N1','D3 / N2','N3'];
  const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
  const KEYS = [];
  for (let s = LOW; s <= HIGH; s++) {
    const pc = ((s % 12) + 12) % 12;
    KEYS.push({ s, pc, white: !BLACK_PCS.has(pc), label: SWARA[pc], oct: Math.floor(s / 12) });
  }
  // Computer-keyboard shortcuts for the middle octave only (S .. upper S)
  const KEYCHARS = 'awsedftgyhujk';
  // Kattai (scale) numbers: C=1, C#=1.5, D=2 ... G=5, G#=5.5 ... B=7
  const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const KATTAI = ['1','1.5','2','2.5','3','4','4.5','5','5.5','6','6.5','7'];

  // ---------- UI ----------
  const kb = document.getElementById('keyboard');
  const saSel = document.getElementById('sa');
  const octVal = document.getElementById('octVal');
  const volEl = document.getElementById('vol');
  const droneBtn = document.getElementById('drone');
  const droneVol = { d1: document.getElementById('volSa'), d2: document.getElementById('volPa') };
  const droneGain = {}; // per-drone-note level nodes, created with the audio context

  NOTE_NAMES.forEach((n, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = `${KATTAI[i]}  (${n})`; saSel.appendChild(o);
  });
  saSel.value = localStorage.getItem('sa') ?? '7';
  let octave = 0;

  const WHITE_COUNT = KEYS.filter(k => k.white).length;
  let wi = 0;
  const els = new Map();
  KEYS.forEach(k => {
    const d = document.createElement('div');
    d.className = 'key ' + (k.white ? 'white' : 'black');
    d.dataset.semi = k.s;
    // octave marker: dot below = keezh sthayi, dot above = mel sthayi
    const dot = k.oct < 0 ? '<i class="dot low"></i>' : k.oct > 0 ? '<i class="dot high"></i>' : '';
    d.innerHTML = `<span class="sw">${k.label.replace(' / ', '<br>')}</span>${dot}<span class="west"></span>`;
    if (k.white) { wi++; }
    else d.dataset.after = wi; // number of white keys to its left
    kb.appendChild(d);
    els.set(k.s, d);
  });
  // Western note names follow the chosen Sa (e.g. Sa = 5 -> S is G)
  function updateWestern() {
    const sa = +saSel.value;
    KEYS.forEach(k => { els.get(k.s).querySelector('.west').textContent = NOTE_NAMES[(sa + k.pc) % 12]; });
  }
  updateWestern();
  function layoutBlacks() {
    const cs = getComputedStyle(kb);
    const pad = parseFloat(cs.paddingLeft);
    const inner = kb.clientWidth - pad * 2;
    const ww = inner / WHITE_COUNT;
    kb.querySelectorAll('.black').forEach(b => {
      const bw = ww * 0.62;
      b.style.width = bw + 'px';
      b.style.left = (pad + b.dataset.after * ww - bw / 2) + 'px';
    });
  }
  layoutBlacks();
  addEventListener('resize', layoutBlacks);
  addEventListener('orientationchange', () => setTimeout(layoutBlacks, 200));

  // ---------- Harmonium synth ----------
  let ctx, master, filter, tremolo;
  function initAudio() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = +volEl.value * 0.5;
    const comp = ctx.createDynamicsCompressor();
    // Reed body: low-pass to soften the buzz plus a nasal formant bump
    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 2600; filter.Q.value = 0.7;
    const formant = ctx.createBiquadFilter();
    formant.type = 'peaking'; formant.frequency.value = 1100; formant.Q.value = 1.2; formant.gain.value = 5;
    filter.connect(formant); formant.connect(master);
    for (const id of ['d1', 'd2']) {
      droneGain[id] = ctx.createGain();
      droneGain[id].gain.value = +droneVol[id].value;
      droneGain[id].connect(filter);
    }
    master.connect(comp); comp.connect(ctx.destination);
  }
  function unlock() {
    initAudio();
    if (ctx.state !== 'running') ctx.resume();
  }

  const voices = new Map(); // id -> voice
  function freqFor(semi) {
    const sa = 261.63 * Math.pow(2, +saSel.value / 12); // Sa pitch in octave around middle C
    return sa * Math.pow(2, (semi + 12 * octave) / 12);
  }

  function startVoice(id, semi, absolute) {
    if (voices.has(id)) return;
    unlock();
    const now = ctx.currentTime;
    const f = absolute ? 261.63 * Math.pow(2, +saSel.value / 12) * Math.pow(2, semi / 12) : freqFor(semi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(1, now + 0.05);
    g.connect(droneGain[id] || filter);
    // Reed set: two saws slightly detuned (beating like real reeds), plus an
    // octave-down square for the harmonium's body and a quiet octave-up reed.
    const parts = [
      ['sawtooth', 1,   -4, 0.35],
      ['sawtooth', 1,    5, 0.35],
      ['square',   0.5,  0, 0.18],
      ['sawtooth', 2,    2, 0.10],
    ];
    const oscs = parts.map(([type, mult, cents, level]) => {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = f * mult; o.detune.value = cents;
      const og = ctx.createGain(); og.gain.value = level;
      o.connect(og); og.connect(g); o.start(now);
      return o;
    });
    voices.set(id, { g, oscs });
  }
  function stopVoice(id) {
    const v = voices.get(id);
    if (!v) return;
    voices.delete(id);
    const now = ctx.currentTime;
    v.g.gain.cancelScheduledValues(now);
    v.g.gain.setValueAtTime(v.g.gain.value, now);
    v.g.gain.linearRampToValueAtTime(0, now + 0.12);
    v.oscs.forEach(o => o.stop(now + 0.15));
  }

  // ---------- Pointer handling (multi-touch + glissando) ----------
  const pointers = new Map(); // pointerId -> semi
  function semiAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const key = el && el.closest && el.closest('.key');
    return key ? +key.dataset.semi : null;
  }
  function press(semi) { els.get(semi).classList.add('active'); startVoice('k' + semi, semi); }
  function release(semi) { els.get(semi).classList.remove('active'); stopVoice('k' + semi); }
  function stillHeld(semi) { return [...pointers.values()].includes(semi) || heldKeys.has(semi); }

  kb.addEventListener('pointerdown', e => {
    e.preventDefault();
    const s = semiAt(e.clientX, e.clientY);
    if (s === null) return;
    kb.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, s);
    press(s);
  });
  kb.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const s = semiAt(e.clientX, e.clientY);
    if (s === null || s === prev) return;
    pointers.set(e.pointerId, s);
    if (!stillHeld(prev)) release(prev);
    press(s);
  });
  const up = e => {
    if (!pointers.has(e.pointerId)) return;
    const s = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (!stillHeld(s)) release(s);
  };
  kb.addEventListener('pointerup', up);
  kb.addEventListener('pointercancel', up);
  kb.addEventListener('contextmenu', e => e.preventDefault());

  // Computer keyboard
  const heldKeys = new Set();
  const keyMap = Object.fromEntries([...KEYCHARS].map((c, i) => [c, i]));
  addEventListener('keydown', e => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const s = keyMap[e.key.toLowerCase()];
    if (s === undefined) return;
    heldKeys.add(s); press(s);
  });
  addEventListener('keyup', e => {
    const s = keyMap[e.key.toLowerCase()];
    if (s === undefined) return;
    heldKeys.delete(s);
    if (!stillHeld(s)) release(s);
  });

  // ---------- Controls ----------
  // Stops played notes only; the drone (ids d1/d2) keeps going
  function stopAll() { [...voices.keys()].filter(id => id[0] === 'k').forEach(stopVoice); els.forEach(e => e.classList.remove('active')); pointers.clear(); heldKeys.clear(); }
  function restartDrone() {
    if (droneBtn.getAttribute('aria-pressed') !== 'true') return;
    stopVoice('d1'); stopVoice('d2');
    startVoice('d1', -12, true); startVoice('d2', -5, true);
  }
  saSel.addEventListener('change', () => {
    localStorage.setItem('sa', saSel.value); updateWestern(); stopAll(); restartDrone();
  });
  const setOct = n => { octave = Math.max(-2, Math.min(2, n)); octVal.textContent = octave > 0 ? '+' + octave : octave; stopAll(); };
  document.getElementById('octDown').onclick = () => setOct(octave - 1);
  document.getElementById('octUp').onclick = () => setOct(octave + 1);
  volEl.addEventListener('input', () => { if (master) master.gain.value = +volEl.value * 0.5; });
  for (const id of ['d1', 'd2']) {
    droneVol[id].addEventListener('input', () => { if (droneGain[id]) droneGain[id].gain.value = +droneVol[id].value; });
  }
  droneBtn.addEventListener('click', () => {
    const on = droneBtn.getAttribute('aria-pressed') !== 'true';
    droneBtn.setAttribute('aria-pressed', on);
    if (on) { unlock(); restartDrone(); } else { stopVoice('d1'); stopVoice('d2'); }
  });

  // Silence when the app goes to background (iOS suspends audio anyway)
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopAll(); });

  if ('serviceWorker' in navigator) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
