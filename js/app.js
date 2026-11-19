// AR FX Studio — main controller: camera → tracking → effects → canvas.
import { Tracker, MP_VERSION } from './tracker.js';
import { Camera, CameraError, explainCameraError } from './camera.js';
import { Face, IDX } from './face.js';
import { EFFECTS, EFFECT_MAP, RENDER_ORDER, defaultSettings, FILTER_OK } from './effects.js';
import { GestureController, GESTURE_LABELS, classifyHand, classifyFrame } from './gestures.js';
import { loadState, saveState, saveNow } from './store.js';

const $ = (s) => document.querySelector(s);
const app = $('#app'), canvas = $('#out'), video = $('#video');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

// MediaPipe's WASM routes its informational stderr through console.error; drop that one benign line.
const _cerr = console.error.bind(console);
console.error = (...a) => { if (typeof a[0] === 'string' && /^INFO: Created TensorFlow Lite XNNPACK delegate/.test(a[0])) return; _cerr(...a); };

const state = loadState();
const enabled = new Set(state.enabled);
const tracker = new Tracker();
const camera = new Camera(video);
const face = new Face();
const gestures = new GestureController();

const rt = {
  ready: false, running: false, raf: 0, W: 0, H: 0, scale: 1,
  faceOk: false, faceSeenAt: 0, hands: [], lastVideoTime: -1, frameNo: 0,
  burst: 0, burstStart: 0, lastT: 0, fps: 0, fpsFrames: 0, fpsSince: 0, lowFor: 0, highFor: 0,
  recorder: null, recChunks: [], recStart: 0, recTimer: 0, mirror: true, gpuFailing: false,
  pinchBase: 0, detectMs: 0, errors: [], fxErrors: new Set(), uiTick: 0,
};

/* ------------------------------------------------------------------ debug */
const fx = (window.__fx = {
  version: '1.0.0', mediapipe: MP_VERSION, ready: false, delegate: tracker.delegate,
  faceCount: 0, handCount: 0, lastGesture: null, gesture: null, gestureLog: [], fps: 0,
  renderScale: 1, size: [0, 0], enabled: [], active: state.active, camera: {}, frames: 0,
  lastScreenshot: null, lastRecording: null, recording: false, fullscreen: false, errors: rt.errors,
  filterSupported: FILTER_OK, classifyHand, classifyFrame,
});

/* ------------------------------------------------------------------ helpers */
function toast(msg, ms = 1500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
function persist() { state.enabled = [...enabled]; saveState(state); syncDebug(); }
function syncDebug() { fx.enabled = [...enabled]; fx.active = state.active; }
function logError(where, e) {
  const msg = `${where}: ${e?.message || e}`;
  rt.errors.push(msg); if (rt.errors.length > 30) rt.errors.shift();
  console.error('[ar-fx]', msg);
}

/* ------------------------------------------------------------------ loading */
function setStage(stage, p, info) {
  const li = document.querySelector(`.stages li[data-stage="${stage}"]`); if (!li) return;
  li.querySelector('.bar i').style.transform = `scaleX(${Math.max(0.02, Math.min(1, p))})`;
  li.querySelector('small').textContent = info || `${Math.round(p * 100)}%`;
  li.classList.toggle('done', p >= 1); li.classList.toggle('active', p > 0 && p < 1);
}
async function loadEngine() {
  $('#loader').hidden = false; $('#loader-error').hidden = true; $('#btn-retry-load').hidden = true;
  $('#loader-title').textContent = 'Preparing AR engine';
  try {
    await tracker.load(setStage);
    rt.ready = fx.ready = true; fx.cpuReason = tracker.cpuReason;
    app.classList.remove('is-loading');
    $('#loader').classList.add('fade'); setTimeout(() => { $('#loader').hidden = true; }, 350);
    const start = $('#btn-start'); start.disabled = false;
    updateDelegate();
    try { Camera.checkSupport(); } catch (e) { showIdleError(e.message); start.disabled = true; }
  } catch (e) {
    logError('load', e);
    $('#loader-title').textContent = 'Could not start the AR engine';
    const box = $('#loader-error'); box.hidden = false;
    box.textContent = (e.message || 'Model loading failed.') + ' Press Retry to try again.';
    $('#btn-retry-load').hidden = false;
  }
}
function updateDelegate() {
  const d = tracker.delegate;
  $('#st-delegate').textContent = d.face ? (d.face === d.hand ? d.face : `${d.face}/${d.hand}`) : '—';
}

/* ------------------------------------------------------------------ camera */
function showIdleError(msg) { const b = $('#idle-error'); b.textContent = msg; b.hidden = !msg; }
async function startCamera(opts) {
  if (!rt.ready) return;
  const btns = [$('#btn-start'), $('#btn-camera')];
  btns.forEach((b) => (b.disabled = true));
  $('#btn-start span').textContent = 'Starting…';
  showIdleError('');
  try {
    const info = await camera.start(opts);
    rt.running = true; app.classList.add('is-running');
    rt.mirror = state.mirror === 'on' || (state.mirror === 'auto' && info.facing !== 'environment');
    sizeCanvas(true);
    gestures.reset(); rt.faceOk = false; rt.lastVideoTime = -1;
    startLoop();
    $('#camera-label').textContent = 'Stop';
    $('#btn-camera').classList.add('on');
    $('#btn-shot').disabled = false;
    $('#btn-record').disabled = !canRecord();
    const sw = $('#btn-switch');
    sw.disabled = !camera.canSwitch;
    sw.title = camera.canSwitch ? `Switch camera (${camera.devices.length} found)` : 'Only one camera found';
    fx.camera = { running: true, label: info.label, facing: info.facing, devices: camera.devices.length, width: info.width, height: info.height };
    camera.onEnded = () => { if (rt.running) { stopCamera(); showIdleError('The camera stopped (it was unplugged or taken by another app). Press Start to reconnect.'); } };
  } catch (e) {
    const err = explainCameraError(e);
    logError('camera', err);
    rt.running = false; app.classList.remove('is-running');
    showIdleError(err.message);
    $('#btn-start span').textContent = 'Retry';
    fx.camera = { running: false, error: err.code };
    btns.forEach((b) => (b.disabled = false));
    return;
  }
  btns.forEach((b) => (b.disabled = false));
  $('#btn-start span').textContent = 'Start camera';
}
function stopCamera() {
  if (rt.recorder) stopRecording();
  camera.stop(); rt.running = false; stopLoop();
  app.classList.remove('is-running');
  $('#camera-label').textContent = 'Start'; $('#btn-camera').classList.remove('on');
  ['#btn-shot', '#btn-record', '#btn-switch'].forEach((s) => ($(s).disabled = true));
  rt.faceOk = false; rt.hands = []; fx.faceCount = fx.handCount = 0;
  fx.camera = { ...fx.camera, running: false };
  updateChips(true);
}
async function switchCamera() {
  if (!rt.running) return;
  const b = $('#btn-switch'); b.disabled = true;
  try {
    const info = await camera.switch();
    rt.mirror = state.mirror === 'on' || (state.mirror === 'auto' && info.facing !== 'environment');
    sizeCanvas(true); rt.lastVideoTime = -1;
    fx.camera = { running: true, label: info.label, facing: info.facing, devices: camera.devices.length, width: info.width, height: info.height };
    toast(`Camera: ${info.label}`);
  } catch (e) { const err = explainCameraError(e); logError('switch', err); toast(err.message, 3500); await startCamera().catch(() => {}); }
  b.disabled = !camera.canSwitch;
}

/* ------------------------------------------------------------------ sizing / perf */
function targetScale() { return state.perf === 'high' ? 1 : state.perf === 'low' ? 0.6 : rt.scale; }
function sizeCanvas(force) {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const cap = Math.min(1, 1280 / Math.max(vw, vh));
  const s = cap * targetScale();
  const W = Math.max(2, Math.round(vw * s)), H = Math.max(2, Math.round(vh * s));
  if (force || W !== rt.W || H !== rt.H) {
    if (rt.recorder && !force) return; // keep stream size stable while recording
    canvas.width = rt.W = W; canvas.height = rt.H = H;
    fx.size = [W, H]; fx.renderScale = +s.toFixed(2);
    canvas.style.aspectRatio = `${W} / ${H}`;
    updatePerfInfo();
  }
}
function adaptPerf(fps) {
  if (state.perf !== 'auto' || rt.recorder) return;
  if (fps < 20 && rt.scale > 0.5) { if (++rt.lowFor >= 2) { rt.scale = Math.max(0.5, rt.scale - 0.15); rt.lowFor = 0; sizeCanvas(); } } else rt.lowFor = 0;
  if (fps > 28 && rt.scale < 1) { if (++rt.highFor >= 4) { rt.scale = Math.min(1, rt.scale + 0.1); rt.highFor = 0; sizeCanvas(); } } else rt.highFor = 0;
}
function updatePerfInfo() {
  const d = tracker.delegate;
  $('#perf-info').textContent = `Rendering ${rt.W}×${rt.H} (${Math.round(fx.renderScale * 100)}%) · Face ${d.face || '—'} · Hands ${d.hand || '—'} ${tracker.cpuReason ? `(${tracker.cpuReason}) ` : ''}· Blur: ${FILTER_OK ? 'native filter' : 'fallback'} · MediaPipe ${MP_VERSION}`;
}

/* ------------------------------------------------------------------ main loop */
function startLoop() { if (!rt.raf) { rt.lastT = performance.now(); rt.fpsSince = rt.lastT; rt.fpsFrames = 0; rt.raf = requestAnimationFrame(loop); } }
function stopLoop() { cancelAnimationFrame(rt.raf); rt.raf = 0; }
function needsFace() {
  if (state.debug) return true;
  for (const id of enabled) { const f = EFFECT_MAP[id]; if (f.needsFace || (id === 'glitch' && state.settings.glitch.area === 'face') || state.settings[id].area === 'face') return true; }
  return false;
}
function loop(now) {
  rt.raf = requestAnimationFrame(loop);
  if (video.readyState < 2 || !rt.running) return;
  const vt = video.currentTime;
  if (vt === rt.lastVideoTime) return; // render once per new camera frame
  rt.lastVideoTime = vt;
  rt.frameNo++;
  const dt = Math.min(0.1, (now - rt.lastT) / 1000); rt.lastT = now;
  if (video.videoWidth !== rt.vw || video.videoHeight !== rt.vh) { rt.vw = video.videoWidth; rt.vh = video.videoHeight; sizeCanvas(true); }
  detect(now);
  draw(now / 1000, dt);
  rt.burst = Math.max(0, rt.burst - dt / 0.9);
  // fps
  rt.fpsFrames++;
  if (now - rt.fpsSince >= 1000) {
    rt.fps = fx.fps = Math.round((rt.fpsFrames * 1000) / (now - rt.fpsSince));
    rt.fpsFrames = 0; rt.fpsSince = now; adaptPerf(rt.fps);
  }
  fx.frames = rt.frameNo;
  if (now - rt.uiTick > 250) { rt.uiTick = now; updateChips(); }
  updateGestureHud(now);
}

function detect(now) {
  if (rt.gpuFailing) return;
  const t0 = performance.now();
  const wantFace = needsFace() || rt.frameNo % 6 === 0;
  if (wantFace) {
    try {
      const r = tracker.detectFace(video);
      const lm = r?.faceLandmarks?.[0];
      if (lm && lm.length) { face.update(lm, rt.W, rt.H, rt.mirror); rt.faceOk = true; rt.faceSeenAt = now; fx.faceCount = r.faceLandmarks.length; }
      else if (now - rt.faceSeenAt > 200) { rt.faceOk = false; fx.faceCount = 0; }
    } catch (e) { handleDetectError('face', e); }
  }
  const handEvery = state.perf === 'low' ? 3 : 2;
  if ((state.gestures || state.debug) && rt.frameNo % handEvery === 0) {
    try {
      const r = tracker.detectHands(video);
      rt.hands = r?.landmarks || []; fx.handCount = rt.hands.length;
      if (state.gestures) for (const ev of gestures.update(rt.hands, now)) onGesture(ev);
      fx.gesture = gestures.current;
    } catch (e) { handleDetectError('hand', e); }
  } else if (!state.gestures && !state.debug) { rt.hands = []; fx.handCount = 0; fx.gesture = null; }
  rt.detectMs = fx.detectMs = +(performance.now() - t0).toFixed(1);
}
async function handleDetectError(key, e) {
  logError(`detect-${key}`, e);
  if (tracker.delegate[key] === 'GPU' && !rt.gpuFailing) {
    rt.gpuFailing = true; toast('GPU tracking failed — switching to CPU…', 2500);
    try { await tracker.fallbackToCPU(key); updateDelegate(); updatePerfInfo(); } catch (err) { logError('cpu-fallback', err); }
    rt.gpuFailing = false;
  }
}

const env = { t: 0, dt: 0, W: 0, H: 0, burst: 0, burstStart: 0, tess: null, fps: 0, forceManualBlur: /[?&]manualblur=1/.test(location.search) };
function drawVideo() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none'; ctx.shadowBlur = 0;
  if (rt.mirror) { ctx.translate(rt.W, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, 0, 0, rt.W, rt.H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
function renderEffects(ids, t, dt) {
  env.t = t; env.dt = dt; env.W = rt.W; env.H = rt.H; env.burst = rt.burst; env.burstStart = rt.burstStart; env.tess = tracker.tess; env.fps = rt.fps;
  const F = rt.faceOk ? face : null;
  for (const id of RENDER_ORDER) {
    if (!ids.has(id)) continue;
    const effect = EFFECT_MAP[id];
    if (effect.needsFace && !F) continue;
    try { effect.render(ctx, F, env, state.settings[id]); }
    catch (e) { if (!rt.fxErrors.has(id)) { rt.fxErrors.add(id); logError(`effect ${id}`, e); } }
    finally { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none'; ctx.shadowBlur = 0; }
  }
}
function draw(t, dt) {
  drawVideo();
  renderEffects(enabled, t, dt);
  if (state.debug) drawDebug();
}
function drawDebug() {
  ctx.save();
  if (rt.faceOk) { ctx.fillStyle = 'rgba(255,255,255,0.8)'; const p = face.pts; for (let i = 0; i < face.n; i++) ctx.fillRect(p[i * 2] - 1, p[i * 2 + 1] - 1, 2, 2); }
  const C = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
  ctx.lineWidth = 2; ctx.strokeStyle = '#e8dccf'; ctx.fillStyle = '#ffffff';
  for (const h of rt.hands) {
    const X = (p) => (rt.mirror ? 1 - p.x : p.x) * rt.W, Y = (p) => p.y * rt.H;
    ctx.beginPath(); for (const [a, b] of C) { ctx.moveTo(X(h[a]), Y(h[a])); ctx.lineTo(X(h[b]), Y(h[b])); } ctx.stroke();
    for (const p of h) { ctx.beginPath(); ctx.arc(X(p), Y(p), 3, 0, Math.PI * 2); ctx.fill(); }
    const g = classifyHand(h);
    if (g) { ctx.font = '600 14px ui-monospace, monospace'; ctx.fillText(GESTURE_LABELS[g], X(h[0]) + 8, Y(h[0]) + 18); }
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ status UI */
function updateChips(force) {
  $('#st-fps').textContent = rt.running ? rt.fps : 0;
  $('#st-face').textContent = fx.faceCount; $('#st-hand').textContent = fx.handCount;
  $('#st-face-dot').classList.toggle('on', rt.running && rt.faceOk);
  $('#st-hand-dot').classList.toggle('on', rt.running && fx.handCount > 0);
}
function updateGestureHud(now) {
  const hud = $('#gesture-hud');
  const show = state.gestures && rt.hands.length > 0 && gestures.current;
  hud.classList.toggle('show', !!show);
  if (show) {
    $('#gesture-name').textContent = GESTURE_LABELS[gestures.current] || '—';
    const p = gestures.progress(now);
    $('#hold-ring').style.strokeDashoffset = String(94.25 * (1 - p));
  }
}

/* ------------------------------------------------------------------ effects actions */
function select(id) {
  state.active = id; persist(); renderLibrary(); renderActive(); if (!$('#settings').hidden) renderSettings();
}
function setEnabled(id, on) {
  if (on) enabled.add(id); else enabled.delete(id);
  persist(); renderLibrary(); renderActive(); if (!$('#settings').hidden) renderSettings();
}
function toggleEffect(id = state.active) { setEnabled(id, !enabled.has(id)); return enabled.has(id); }
function selectRelative(step) {
  const i = EFFECTS.findIndex((f) => f.id === state.active);
  const next = EFFECTS[(i + step + EFFECTS.length) % EFFECTS.length];
  select(next.id);
  return next;
}
function setSetting(id, key, value) {
  state.settings[id][key] = value; persist();
  if (id === state.active) renderActive();
}
function triggerBurst() { rt.burst = 1; rt.burstStart = performance.now() / 1000; fx.lastBurst = Date.now(); }
const PALETTE = ['#ff2bd6', '#2b9bff', '#20f0a8', '#ffd21f', '#ff4b1f', '#a46bff', '#ffffff', '#ff0040'];
function cycleColor() {
  let id = state.active;
  if (!EFFECT_MAP[id].hasColor) { const withColor = [...enabled].find((e) => EFFECT_MAP[e].hasColor); if (!withColor) return null; id = withColor; }
  const cur = state.settings[id].color.toLowerCase();
  const next = PALETTE[(PALETTE.indexOf(cur) + 1) % PALETTE.length];
  setSetting(id, 'color', next);
  if (!$('#settings').hidden) renderSettings();
  return { id, color: next };
}

/* ------------------------------------------------------------------ gestures */
const G_ICON = { open_palm: '🖐', fist: '✊', two_fingers: '✌️', three_fingers: '🤟', pinch: '🤏', both_hands: '🙌' };
function onGesture(ev) {
  const active = EFFECT_MAP[state.active];
  let action = '';
  if (ev.type === 'gesture') {
    switch (ev.gesture) {
      case 'open_palm': action = `${active.name} ${toggleEffect() ? 'ON' : 'OFF'}`; break;
      case 'fist': triggerBurst(); action = 'Animation burst'; break;
      case 'two_fingers': action = `Next: ${selectRelative(1).name}`; break;
      case 'three_fingers': action = `Previous: ${selectRelative(-1).name}`; break;
      case 'both_hands': { const c = cycleColor(); action = c ? `${EFFECT_MAP[c.id].name} color ${c.color}` : 'No colorable effect on'; break; }
    }
  } else if (ev.type === 'pinch_start') { rt.pinchBase = state.settings[state.active].intensity; action = `Pinch: intensity ${rt.pinchBase}%`; }
  else if (ev.type === 'pinch_move') {
    const v = Math.round(Math.max(0, Math.min(100, rt.pinchBase + ev.dy * 250)));
    if (v !== state.settings[state.active].intensity) { setSetting(state.active, 'intensity', v); }
    toast(`🤏 Intensity ${v}%`, 700); fx.lastGesture = 'pinch'; return;
  } else if (ev.type === 'pinch_end') return;
  if (!action) return;
  fx.lastGesture = ev.gesture;
  fx.gestureLog.push({ gesture: ev.gesture, action, at: Date.now() }); if (fx.gestureLog.length > 50) fx.gestureLog.shift();
  toast(`${G_ICON[ev.gesture] || ''} ${GESTURE_LABELS[ev.gesture]} → ${action}`);
}
function setGestures(on) {
  state.gestures = on; persist(); gestures.reset();
  $('#btn-gestures').setAttribute('aria-pressed', String(on)); $('#btn-gestures').classList.toggle('on', on);
  $('#opt-gestures').checked = on;
}

/* ------------------------------------------------------------------ library + panels */
function renderLibrary() {
  const lib = $('#library');
  if (!lib.children.length) {
    for (const f of EFFECTS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'fx'; b.dataset.id = f.id;
      b.innerHTML = `<span class="fx-glyph" aria-hidden="true">${f.glyph}</span><span class="fx-name">${f.short}</span><i class="fx-dot" aria-hidden="true"></i>`;
      b.title = f.name;
      b.addEventListener('click', () => {
        if (state.active !== f.id) { state.active = f.id; if (!enabled.has(f.id)) enabled.add(f.id); persist(); renderLibrary(); renderActive(); if (!$('#settings').hidden) renderSettings(); }
        else toggleEffect(f.id);
      });
      lib.appendChild(b);
    }
  }
  for (const b of lib.children) {
    const id = b.dataset.id, on = enabled.has(id);
    b.classList.toggle('on', on); b.classList.toggle('selected', id === state.active);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', `${EFFECT_MAP[id].name}${on ? ', on' : ', off'}${id === state.active ? ', selected' : ''}`);
  }
  const sel = lib.querySelector('.selected');
  if (sel && renderLibrary._last !== state.active) { renderLibrary._last = state.active; sel.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); }
}
function renderActive() {
  const f = EFFECT_MAP[state.active], s = state.settings[f.id];
  $('#active-name').textContent = f.name; $('#active-glyph').textContent = f.glyph;
  const sw = $('#btn-active-toggle'); sw.setAttribute('aria-checked', String(enabled.has(f.id))); sw.setAttribute('aria-label', `${f.name} on/off`);
  const ip = f.params.find((p) => p.key === 'intensity');
  const inp = $('#intensity'); inp.value = s.intensity; $('#intensity-val').textContent = `${s.intensity}%`;
  inp.setAttribute('aria-label', `${f.name} – ${ip.label}`); inp.title = ip.label;
  const col = $('#color');
  col.disabled = !f.hasColor; col.parentElement.classList.toggle('disabled', !f.hasColor);
  col.parentElement.title = f.hasColor ? 'Effect color' : `${f.name} has no color setting`;
  if (f.hasColor) { col.value = s.color; col.parentElement.style.setProperty('--swatch', s.color); }
  else col.parentElement.style.setProperty('--swatch', '#2a2a2a');
}
function renderSettings() {
  const f = EFFECT_MAP[state.active], s = state.settings[f.id], form = $('#settings-form');
  $('#settings-name').textContent = f.name; $('#settings-glyph').textContent = f.glyph;
  $('#settings-state').textContent = enabled.has(f.id) ? 'On' : 'Off — tap the switch or the effect to turn it on';
  form.innerHTML = '';
  for (const p of f.params) {
    const id = `set-${f.id}-${p.key}`, row = document.createElement('div');
    row.className = 'field' + (p.type === 'toggle' ? ' row' : '');
    const label = `<label for="${id}">${p.label}</label>`;
    if (p.type === 'range') {
      row.innerHTML = `${label}<div class="range-row"><input id="${id}" type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${s[p.key]}"><output>${s[p.key]}${p.unit}</output></div>`;
      const inp = row.querySelector('input'), out = row.querySelector('output');
      inp.addEventListener('input', () => { out.textContent = inp.value + p.unit; setSetting(f.id, p.key, +inp.value); });
    } else if (p.type === 'color') {
      row.innerHTML = `${label}<input id="${id}" type="color" value="${s[p.key]}">`;
      const inp = row.querySelector('input'); inp.addEventListener('input', () => setSetting(f.id, p.key, inp.value));
    } else if (p.type === 'select') {
      row.innerHTML = `${label}<select id="${id}">${p.options.map(([v, l]) => `<option value="${v}"${v === s[p.key] ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
      const inp = row.querySelector('select'); inp.addEventListener('change', () => setSetting(f.id, p.key, inp.value));
    } else if (p.type === 'toggle') {
      row.innerHTML = `${label}<input id="${id}" type="checkbox" class="tgl"${s[p.key] ? ' checked' : ''}>`;
      const inp = row.querySelector('input'); inp.addEventListener('change', () => setSetting(f.id, p.key, inp.checked));
    }
    form.appendChild(row);
  }
}
function openSheet(id) {
  for (const other of ['settings', 'help']) if (other !== id) closeSheet(other);
  const el = $('#' + id); el.hidden = false; requestAnimationFrame(() => el.classList.add('open'));
  document.querySelectorAll(`[aria-controls="${id}"]`).forEach((b) => b.setAttribute('aria-expanded', 'true'));
  if (id === 'settings') renderSettings();
  el.querySelector('.sheet-head .icon-btn').focus({ preventScroll: true });
}
function closeSheet(id) {
  const el = $('#' + id); if (el.hidden) return;
  el.classList.remove('open'); setTimeout(() => { if (!el.classList.contains('open')) el.hidden = true; }, 260);
  document.querySelectorAll(`[aria-controls="${id}"]`).forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
const toggleSheet = (id) => ($('#' + id).hidden ? openSheet(id) : closeSheet(id));

/* ------------------------------------------------------------------ capture */
function screenshot() {
  if (!rt.running) return;
  const f = $('#flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  canvas.toBlob((blob) => {
    if (!blob) { toast('Screenshot failed'); return; }
    const name = `ar-fx-${stamp()}.png`;
    fx.lastScreenshot = { name, size: blob.size, type: blob.type, at: Date.now() };
    download(blob, name); toast('📸 Screenshot saved');
  }, 'image/png');
}
function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const c = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  return c.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
}
function canRecord() { return typeof MediaRecorder !== 'undefined' && typeof canvas.captureStream === 'function'; }
function startRecording() {
  if (!rt.running || rt.recorder) return;
  if (!canRecord()) { toast('Recording is not supported in this browser', 3000); return; }
  const mime = pickMime();
  let rec;
  try {
    const stream = canvas.captureStream(30);
    rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
  } catch (e) { logError('record', e); toast('Could not start recording: ' + e.message, 3000); return; }
  rt.recChunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) rt.recChunks.push(e.data); };
  rec.onstop = () => {
    const type = rec.mimeType || mime || 'video/webm';
    const blob = new Blob(rt.recChunks, { type });
    const ext = /mp4/.test(type) ? 'mp4' : 'webm';
    const name = `ar-fx-${stamp()}.${ext}`;
    fx.lastRecording = { name, size: blob.size, type, duration: (performance.now() - rt.recStart) / 1000, at: Date.now() };
    if (blob.size) { download(blob, name); toast(`🎬 Video saved (${(blob.size / 1048576).toFixed(1)} MB)`); }
    else toast('Recording was empty');
    rt.recChunks = [];
  };
  rec.onerror = (e) => { logError('recorder', e.error || e); };
  rec.start(250);
  rt.recorder = rec; rt.recStart = performance.now(); fx.recording = true;
  $('#rec-badge').hidden = false; $('#record-label').textContent = 'Stop';
  $('#btn-record').classList.add('recording'); $('#btn-record').setAttribute('aria-pressed', 'true');
  const tick = () => { const s = Math.floor((performance.now() - rt.recStart) / 1000); $('#rec-time').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  tick(); rt.recTimer = setInterval(tick, 500);
}
function stopRecording() {
  const rec = rt.recorder; if (!rec) return;
  rt.recorder = null; fx.recording = false; clearInterval(rt.recTimer);
  try { if (rec.state !== 'inactive') { rec.requestData?.(); rec.stop(); } } catch (e) { logError('record-stop', e); }
  rec.stream?.getTracks().forEach((t) => t.stop());
  $('#rec-badge').hidden = true; $('#record-label').textContent = 'Record';
  $('#btn-record').classList.remove('recording'); $('#btn-record').setAttribute('aria-pressed', 'false');
}

/* ------------------------------------------------------------------ fullscreen */
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
async function toggleFullscreen() {
  try {
    if (fsEl()) { await (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
    else if (app.classList.contains('pseudo-fs')) { app.classList.remove('pseudo-fs'); }
    else if (app.requestFullscreen) { await app.requestFullscreen(); }
    else if (app.webkitRequestFullscreen) { app.webkitRequestFullscreen(); }
    else app.classList.add('pseudo-fs'); // iPhone Safari: no element fullscreen
  } catch (e) { app.classList.toggle('pseudo-fs'); }
  setTimeout(syncFs, 60);
}
function syncFs() {
  const on = !!fsEl() || app.classList.contains('pseudo-fs');
  fx.fullscreen = on; $('#btn-fullscreen').classList.toggle('on', on);
  $('#btn-fullscreen').setAttribute('aria-pressed', String(on));
}
document.addEventListener('fullscreenchange', syncFs);
document.addEventListener('webkitfullscreenchange', syncFs);

/* ------------------------------------------------------------------ wiring */
function bind() {
  $('#btn-start').addEventListener('click', () => startCamera());
  $('#btn-camera').addEventListener('click', () => (rt.running ? stopCamera() : startCamera()));
  $('#btn-switch').addEventListener('click', switchCamera);
  $('#btn-shot').addEventListener('click', screenshot);
  $('#btn-record').addEventListener('click', () => (rt.recorder ? stopRecording() : startRecording()));
  $('#btn-clear').addEventListener('click', () => { enabled.clear(); persist(); renderLibrary(); renderActive(); toast('All effects off'); });
  $('#btn-fullscreen').addEventListener('click', toggleFullscreen);
  $('#btn-gestures').addEventListener('click', () => { setGestures(!state.gestures); toast(`Gesture controls ${state.gestures ? 'on' : 'off'}`); });
  $('#btn-help').addEventListener('click', () => toggleSheet('help'));
  $('#btn-help-idle').addEventListener('click', () => openSheet('help'));
  $('#btn-settings').addEventListener('click', () => toggleSheet('settings'));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet(b.dataset.close)));
  $('#btn-active-toggle').addEventListener('click', () => toggleEffect());
  $('#intensity').addEventListener('input', (e) => { const v = +e.target.value; $('#intensity-val').textContent = `${v}%`; setSetting(state.active, 'intensity', v); syncSettingsField('intensity', v); });
  $('#color').addEventListener('input', (e) => { setSetting(state.active, 'color', e.target.value); syncSettingsField('color', e.target.value); });
  $('#btn-reset-fx').addEventListener('click', () => { state.settings[state.active] = defaultSettings(state.active); persist(); renderActive(); renderSettings(); toast('Effect reset'); });
  $('#btn-reset-all').addEventListener('click', () => {
    if (!confirm('Reset every effect and studio setting to the defaults?')) return;
    for (const f of EFFECTS) state.settings[f.id] = defaultSettings(f.id);
    enabled.clear(); enabled.add('neon'); state.active = 'neon'; state.mirror = 'auto'; state.perf = 'auto'; state.debug = false;
    setGestures(true); saveNow(state); applyStudioControls(); renderLibrary(); renderActive(); renderSettings(); toast('All settings reset');
  });
  $('#opt-mirror').addEventListener('change', (e) => { state.mirror = e.target.value; persist(); rt.mirror = state.mirror === 'on' || (state.mirror === 'auto' && camera.facing !== 'environment'); });
  $('#opt-perf').addEventListener('change', (e) => { state.perf = e.target.value; persist(); if (state.perf === 'auto') rt.scale = 1; sizeCanvas(true); });
  $('#opt-debug').addEventListener('change', (e) => { state.debug = e.target.checked; persist(); });
  $('#opt-gestures').addEventListener('change', (e) => setGestures(e.target.checked));
  $('#btn-retry-load').addEventListener('click', loadEngine);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSheet('settings'); closeSheet('help'); return; }
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (tag === 'button' && (e.key === ' ' || e.key === 'Enter')) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowright') selectRelative(1);
    else if (k === 'arrowleft') selectRelative(-1);
    else if (k === ' ') { e.preventDefault(); toggleEffect(); }
    else if (k === 'arrowup' || k === 'arrowdown') { e.preventDefault(); const s = state.settings[state.active]; setSetting(state.active, 'intensity', Math.max(0, Math.min(100, s.intensity + (k === 'arrowup' ? 5 : -5)))); }
    else if (k === 'b') { triggerBurst(); toast('✊ Animation burst'); }
    else if (k === 'p') screenshot();
    else if (k === 'r') (rt.recorder ? stopRecording() : startRecording());
    else if (k === 'f') toggleFullscreen();
    else if (k === 'g') { setGestures(!state.gestures); toast(`Gesture controls ${state.gestures ? 'on' : 'off'}`); }
    else if (k === 's') toggleSheet('settings');
    else if (k === '?') toggleSheet('help');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopLoop(); }
    else if (rt.running) { rt.lastVideoTime = -1; startLoop(); }
  });
  window.addEventListener('pagehide', () => saveNow(state));
}
function syncSettingsField(key, v) {
  if ($('#settings').hidden) return;
  const el = document.getElementById(`set-${state.active}-${key}`); if (!el) return;
  el.value = v; const out = el.parentElement.querySelector('output'); if (out) out.textContent = v + (key === 'intensity' ? '%' : '');
}
function applyStudioControls() {
  $('#opt-mirror').value = state.mirror; $('#opt-perf').value = state.perf; $('#opt-debug').checked = state.debug;
  setGestures(state.gestures);
}

/* ------------------------------------------------------------------ test hooks */
// Used by the automated test-suite: render the *same* camera frame with and without an effect
// and measure how many pixels inside the face region changed.
fx.test = {
  faceRect() { return rt.faceOk ? { x: face.minX, y: face.minY, w: face.w, h: face.h } : null; },
  diffEffect(id, settings, pad = 0) {
    if (!rt.faceOk) return { error: 'no face' };
    // region: the face box (optionally padded) or, with pad === 'eyes', just the eye area
    const reg = pad === 'eyes' ? face.bbox([...IDX.eyeR, ...IDX.eyeL], 0.25)
      : { x: face.minX - face.w * pad, y: face.minY - face.h * pad, w: face.w * (1 + 2 * pad), h: face.h * (1 + 2 * pad) };
    const x = Math.max(0, Math.floor(reg.x)), y = Math.max(0, Math.floor(reg.y));
    const w = Math.min(rt.W - x, Math.ceil(reg.w)), h = Math.min(rt.H - y, Math.ceil(reg.h));
    const saved = settings ? { ...state.settings[id] } : null;
    if (settings) Object.assign(state.settings[id], settings);
    const t = performance.now() / 1000;
    drawVideo(); const a = ctx.getImageData(x, y, w, h).data;
    renderEffects(new Set([id]), t, 1 / 30); const b = ctx.getImageData(x, y, w, h).data;
    if (saved) state.settings[id] = saved;
    let sum = 0, changed = 0;
    for (let i = 0; i < a.length; i += 4) { const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); sum += d; if (d > 30) changed++; }
    const n = a.length / 4;
    return { id, meanDiff: +(sum / n / 3).toFixed(2), changedRatio: +(changed / n).toFixed(3), rect: [x, y, w, h], errors: [...rt.fxErrors] };
  },
  setEffects(ids) { enabled.clear(); ids.forEach((i) => enabled.add(i)); persist(); renderLibrary(); renderActive(); },
  burst: triggerBurst,
  gesture: (g) => onGesture({ type: 'gesture', gesture: g }),
  pinch: (dy) => { onGesture({ type: 'pinch_start' }); onGesture({ type: 'pinch_move', dy }); },
  state: () => JSON.parse(JSON.stringify({ ...state, enabled: [...enabled] })),
};

/* ------------------------------------------------------------------ boot */
bind(); applyStudioControls(); renderLibrary(); renderActive(); syncDebug();
loadEngine();
