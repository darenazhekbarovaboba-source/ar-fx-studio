// AR FX Studio — main controller: camera → tracking → effects → canvas.
import { Tracker, MP_VERSION } from './tracker.js';
import { Camera, CameraError, explainCameraError } from './camera.js';
import { Face, IDX } from './face.js';
import { EFFECTS, EFFECT_MAP, RENDER_ORDER, defaultSettings, FILTER_OK, getBuffer } from './effects.js';
import { GestureController, GESTURE_LABELS, classifyHand, classifyFrame } from './gestures.js';
import { loadState, saveState, saveNow } from './store.js';
import { PortalController, PORTAL_MODES, PORTAL_DEF, MODE_IDS, portalDefaults, ribbonGeometry, orderQuad, isSelfIntersecting } from './portal.js';
import { renderPortal, renderBlueFace, renderRibbon, quadBox } from './portalfx.js';
const PORTAL_MAP = Object.fromEntries(PORTAL_MODES.map((m) => [m.id, m]));

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
const faces = [new Face(), new Face(), new Face()];
const face = faces[0];
/** video → canvas mapping (crop + scale + mirror), shared by drawing and landmark projection */
const vmap = { vw: 1280, vh: 720, sx: 0, sy: 0, sw: 1280, sh: 720, k: 1, W: 2, H: 2, mirror: true };
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const gestures = new GestureController();
const portal = new PortalController();
portal.setMode(state.portalMode); portal.cycle = state.settings.portal.cycle; portal.setSmoothing(state.settings.portal.smooth);
// canvas-space portal geometry, reused every frame
const PQ = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], PP = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
const RIB = new Float32Array(4 * 25), EYE = { x: 0, y: 0 }, _ia = {}, _ib = {};

const rt = {
  ready: false, running: false, raf: 0, W: 0, H: 0, scale: 1,
  faceOk: false, faceSeenAt: 0, hands: [], lastVideoTime: -1, frameNo: 0,
  burst: 0, burstStart: 0, lastT: 0, fps: 0, fpsFrames: 0, fpsSince: 0, lowFor: 0, highFor: 0,
  recorder: null, recChunks: [], recStart: 0, recTimer: 0, mirror: true, gpuFailing: false,
  pinchBase: 0, detectMs: 0, errors: [], fxErrors: new Set(), uiTick: 0,
  faceN: 0, faceLms: [], captureFull: false, sheetReturn: null, vw: 0, vh: 0,
  testHands: null, view: 'none',
};

/* ------------------------------------------------------------------ debug */
const fx = (window.__fx = {
  version: '1.0.0', mediapipe: MP_VERSION, ready: false, delegate: tracker.delegate,
  faceCount: 0, handCount: 0, lastGesture: null, gesture: null, gestureLog: [], fps: 0,
  renderScale: 1, size: [0, 0], enabled: [], active: state.active, camera: {}, frames: 0,
  lastScreenshot: null, lastRecording: null, recording: false, fullscreen: false, errors: rt.errors,
  filterSupported: FILTER_OK, classifyHand, classifyFrame,
  portal: { tab: state.mode, on: state.portalOn, state: 'none', view: 'none', mode: state.portalMode, quad: null, pinch: null, stretch: 1, forms: 0, cycles: 0 },
  portalLog: [], portalModes: MODE_IDS,
});
Object.defineProperty(fx, 'reducedMotion', { get: () => REDUCED.matches });

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
    await tracker.load(setStage, { numFaces: state.faces, timeoutMs: +(new URLSearchParams(location.search).get('timeout')) || undefined });
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
/** Content box of the stage: the area between the top bar and the dock. */
function stageBox() {
  const st = $('#stage'), cs = getComputedStyle(st);
  return { w: st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), h: st.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) };
}
/** Fill (crop) when the screen and camera orientations disagree, e.g. a portrait phone with a landscape camera. */
function useFill(box, V) {
  if (state.fit === 'fill') return true;
  if (state.fit === 'fit' || !box.w || !box.h) return false;
  const A = box.w / box.h;
  return (A < 1 && V > 1.05) || (A > 1 && V < 0.95);
}
function sizeCanvas(force) {
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const box = stageBox(), V = vw / vh;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (useFill(box, V)) {
    const A = box.w / box.h;
    if (A < V) { sw = Math.max(2, Math.round(vh * A)); sx = Math.round((vw - sw) / 2); }
    else { sh = Math.max(2, Math.round(vw / A)); sy = Math.round((vh - sh) / 2); }
  }
  // Captures (screenshot / recording) always use the full native camera resolution.
  const s = rt.captureFull ? 1 : Math.min(1, 1280 / Math.max(sw, sh)) * targetScale();
  const W = Math.max(2, Math.round(sw * s)), H = Math.max(2, Math.round(sh * s));
  if (!force && rt.recorder && (W !== rt.W || H !== rt.H)) return; // keep stream size stable while recording
  Object.assign(vmap, { vw, vh, sx, sy, sw, sh, k: W / sw, W, H, mirror: rt.mirror });
  if (W !== canvas.width || H !== canvas.height) { canvas.width = W; canvas.height = H; }
  rt.W = W; rt.H = H;
  fx.size = [W, H]; fx.renderScale = +(W / sw).toFixed(3); fx.crop = [sx, sy, sw, sh]; fx.fill = sx > 0 || sy > 0;
  layoutCanvas(); remapFaces(); updatePerfInfo();
}
/** CSS size of the canvas: fit its aspect into the stage content box (no letterbox when filling). */
function layoutCanvas() {
  const box = stageBox(); if (!box.w || !box.h || !rt.W) return;
  const a = rt.W / rt.H; let w = box.w, h = w / a;
  if (h > box.h) { h = box.h; w = h * a; }
  canvas.style.width = `${Math.floor(w)}px`; canvas.style.height = `${Math.floor(h)}px`;
}
function remapFaces() { vmap.mirror = rt.mirror; for (let i = 0; i < rt.faceN; i++) faces[i].update(rt.faceLms[i], vmap); }
/** Measure the chrome so the stage (preview, idle card) sits between the top bar and the dock. */
function measureChrome() {
  const top = $('.topbar').getBoundingClientRect(), dock = $('.dock').getBoundingClientRect();
  document.documentElement.style.setProperty('--top-h', `${Math.ceil(top.bottom)}px`);
  document.documentElement.style.setProperty('--dock-h', `${Math.ceil(innerHeight - dock.top)}px`);
  if (rt.running && !rt.recorder) sizeCanvas(true); else layoutCanvas();
}
function adaptPerf(fps) {
  if (state.perf !== 'auto' || rt.recorder || rt.captureFull) return;
  if (fps < 20 && rt.scale > 0.5) { if (++rt.lowFor >= 2) { rt.scale = Math.max(0.5, rt.scale - 0.15); rt.lowFor = 0; sizeCanvas(); } } else rt.lowFor = 0;
  if (fps > 28 && rt.scale < 1) { if (++rt.highFor >= 4) { rt.scale = Math.min(1, rt.scale + 0.1); rt.highFor = 0; sizeCanvas(); } } else rt.highFor = 0;
}
function updatePerfInfo() {
  const d = tracker.delegate;
  $('#perf-info').textContent = `Rendering ${rt.W}×${rt.H} (${Math.round(fx.renderScale * 100)}%${fx.fill ? ', cropped to fill' : ''}) · captures at native resolution · Face ${d.face || '—'} · Hands ${d.hand || '—'} ${tracker.cpuReason ? `(${tracker.cpuReason}) ` : ''}· Blur: ${FILTER_OK ? 'native filter' : 'fallback'} · MediaPipe ${MP_VERSION}`;
}

/* ------------------------------------------------------------------ main loop */
function startLoop() { if (!rt.raf) { rt.lastT = performance.now(); rt.fpsSince = rt.lastT; rt.fpsFrames = 0; rt.raf = requestAnimationFrame(loop); } }
function stopLoop() { cancelAnimationFrame(rt.raf); rt.raf = 0; }
function needsFace() {
  if (state.debug || portalActive()) return true;
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
      const lms = r?.faceLandmarks || [];
      if (lms.length && lms[0].length) {
        rt.faceLms = lms; rt.faceN = Math.min(lms.length, state.faces, faces.length);
        remapFaces(); rt.faceOk = true; rt.faceSeenAt = now; fx.faceCount = lms.length;
      } else if (now - rt.faceSeenAt > 200) { rt.faceOk = false; rt.faceN = 0; fx.faceCount = 0; }
    } catch (e) { handleDetectError('face', e); }
  }
  // Hand Portal needs hands every frame; classic gestures are debounced so every 2nd/3rd frame is enough
  const pa = portalActive(), wantHands = pa || state.gestures || state.debug;
  const handEvery = pa ? 1 : state.perf === 'low' ? 3 : 2;
  if (wantHands && rt.frameNo % handEvery === 0) {
    try {
      const r = rt.testHands ? null : tracker.detectHands(video);
      rt.hands = rt.testHands || r?.landmarks || []; fx.handCount = rt.hands.length;
      if (pa) updatePortal(now);
      else if (state.gestures) for (const ev of gestures.update(rt.hands, now)) onGesture(ev);
      fx.gesture = pa ? null : gestures.current;
    } catch (e) { handleDetectError('hand', e); }
  } else if (!wantHands) { rt.hands = []; fx.handCount = 0; fx.gesture = null; }
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
  ctx.drawImage(video, vmap.sx, vmap.sy, vmap.sw, vmap.sh, 0, 0, rt.W, rt.H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
function renderEffects(ids, t, dt) {
  const motion = REDUCED.matches ? 0.3 : 1; // prefers-reduced-motion: slow every JS animation down
  env.t = t * motion; env.dt = dt * motion; env.W = rt.W; env.H = rt.H; env.burst = REDUCED.matches ? rt.burst * 0.4 : rt.burst;
  env.burstStart = rt.burstStart * motion; env.tess = tracker.tess; env.fps = rt.fps; env.reduced = REDUCED.matches;
  const n = rt.faceOk ? rt.faceN : 0;
  for (const id of RENDER_ORDER) {
    if (!ids.has(id)) continue;
    const effect = EFFECT_MAP[id], st = state.settings[id];
    const perFace = effect.needsFace || st.area === 'face';
    if (perFace && !n) continue;
    try {
      if (perFace) for (let i = 0; i < n; i++) effect.render(ctx, faces[i], env, st);
      else effect.render(ctx, n ? faces[0] : null, env, st);
    }
    catch (e) { if (!rt.fxErrors.has(id)) { rt.fxErrors.add(id); logError(`effect ${id}`, e); } }
    finally { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none'; ctx.shadowBlur = 0; }
  }
}
function draw(t, dt) {
  drawVideo();
  renderEffects(enabled, t, dt);
  drawPortal();
  if (state.debug) drawDebug();
}

/* ------------------------------------------------------------------ hand portal */
function portalActive() { return state.mode === 'portal' && state.portalOn; }
function updatePortal(now) {
  const res = portal.update(rt.hands, now, (video.videoWidth || 16) / (video.videoHeight || 9));
  if (res.switched) {
    state.portalMode = portal.mode; persist(); renderPortalLib(); renderActive();
    fx.portalLog.push({ mode: portal.mode, via: 'reframe', at: Date.now() }); if (fx.portalLog.length > 50) fx.portalLog.shift();
    toast(`${PORTAL_MAP[portal.mode].glyph} ${PORTAL_MAP[portal.mode].name} portal`, 900);
  }
}
function setPortalMode(id, via = 'tap') {
  if (!PORTAL_MAP[id]) return;
  portal.setMode(id); state.portalMode = id; persist(); renderPortalLib(); renderActive();
  fx.portalLog.push({ mode: id, via, at: Date.now() }); if (fx.portalLog.length > 50) fx.portalLog.shift();
}
/** Map the controller's normalized-video geometry into canvas space (mirror + crop aware). */
function mapPortal() {
  if (portal.quad) for (let i = 0; i < 4; i++) { PQ[i].x = X(portal.quad[i]); PQ[i].y = Y(portal.quad[i]); }
  if (portal.pinch) for (let i = 0; i < 2; i++) { PP[i].x = X(portal.pinch[i]); PP[i].y = Y(portal.pinch[i]); }
}
/** Ribbon width & eye anchor: the band covers brows → lower lids, as in the reference. */
function ribbonParams() {
  const L = Math.hypot(PP[1].x - PP[0].x, PP[1].y - PP[0].y);
  if (rt.faceOk) {
    const a = face.irisCenter('R', _ia), b = face.irisCenter('L', _ib);
    EYE.x = (a.x + b.x) / 2; EYE.y = (a.y + b.y) / 2;
    return { eye: EYE, band: Math.max(8, face.h * 0.2) };
  }
  return { eye: null, band: Math.max(8, (0.22 * L) / Math.max(1, portal.stretch)) };
}
function drawPortal() {
  const P = fx.portal;
  P.tab = state.mode; P.on = state.portalOn; P.mode = portal.mode; P.forms = portal.forms; P.cycles = portal.cycles; P.raw = portal.raw;
  if (!portalActive()) { P.state = P.view = rt.view = 'off'; P.quad = P.pinch = null; return; }
  const s = state.settings.portal, st = portal.state;
  let view = 'none';
  mapPortal();
  try {
    if (st === 'portal' && portal.quad) {
      renderPortal(ctx, PQ, portal.mode, s, env); view = 'portal';
    } else if (st === 'ribbon' && portal.pinch && s.ribbon) {
      const rp = ribbonParams();
      ribbonGeometry(PP[0], PP[1], { eye: rp.eye, band: rp.band, stretch: portal.stretch, n: 24 }, RIB);
      renderRibbon(ctx, RIB, rp.band, portal.stretch, s, env); view = 'ribbon'; P.band = +rp.band.toFixed(1);
    } else if (st === 'none' && s.blueFace && rt.faceOk) {
      for (let i = 0; i < rt.faceN; i++) renderBlueFace(ctx, faces[i], s, env);
      view = 'blueface';
    }
  } catch (e) { if (!rt.fxErrors.has('portal')) { rt.fxErrors.add('portal'); logError('portal', e); } }
  finally { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none'; ctx.shadowBlur = 0; }
  rt.view = view; P.state = st; P.view = view; P.stretch = +portal.stretch.toFixed(3);
  P.quad = portal.quad ? PQ.map((p) => [+p.x.toFixed(1), +p.y.toFixed(1)]) : null;
  P.pinch = portal.pinch ? PP.map((p) => [+p.x.toFixed(1), +p.y.toFixed(1)]) : null;
}
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
const X = (p) => { const x = (p.x * vmap.vw - vmap.sx) * vmap.k; return rt.mirror ? rt.W - x : x; };
const Y = (p) => (p.y * vmap.vh - vmap.sy) * vmap.k;
function drawDebug() {
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  if (rt.faceOk) for (let f = 0; f < rt.faceN; f++) { const p = faces[f].pts; for (let i = 0; i < faces[f].n; i++) ctx.fillRect(p[i * 2] - 1, p[i * 2 + 1] - 1, 2, 2); }
  ctx.lineWidth = 2; ctx.strokeStyle = '#b8b8b8'; ctx.fillStyle = '#ffffff';
  for (const h of rt.hands) {
    ctx.beginPath(); for (const [a, b] of BONES) { ctx.moveTo(X(h[a]), Y(h[a])); ctx.lineTo(X(h[b]), Y(h[b])); } ctx.stroke();
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
const VIEW_LABEL = { ribbon: '░ Static ribbon', blueface: '◉ Blue face' };
function updateGestureHud(now) {
  const hud = $('#gesture-hud');
  if (portalActive()) {
    const label = rt.view === 'portal' ? `${PORTAL_MAP[portal.mode].glyph} ${PORTAL_MAP[portal.mode].name} portal` : VIEW_LABEL[rt.view];
    hud.classList.toggle('show', !!label); hud.classList.add('portal-hud');
    if (label) { const el = $('#gesture-name'); if (el.textContent !== label) el.textContent = label; }
    return;
  }
  hud.classList.remove('portal-hud');
  const show = state.gestures && rt.hands.length > 0 && gestures.current;
  hud.classList.toggle('show', !!show);
  if (show) {
    const label = GESTURE_LABELS[gestures.current] || '—', el = $('#gesture-name');
    if (el.textContent !== label) el.textContent = label;
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
  if (id === 'portal') { if (key === 'cycle') portal.cycle = value; if (key === 'smooth') portal.setSmoothing(value); }
  if (id === cur().id) renderActive();
}
/** The definition shown in the dock / settings: the Hand Portal on the Portal tab, else the selected effect. */
function cur() { return state.mode === 'portal' ? PORTAL_DEF : EFFECT_MAP[state.active]; }
function isOn(id) { return id === 'portal' ? state.portalOn : enabled.has(id); }
function setPortalOn(on) { state.portalOn = on; persist(); if (!on) { portal.reset(); } renderActive(); renderPortalLib(); if (!$('#settings').hidden) renderSettings(); }
function setTab(mode) {
  if (!['portal', 'fx'].includes(mode)) return;
  state.mode = mode; persist(); portal.reset(); gestures.reset();
  for (const [id, m] of [['#tab-portal', 'portal'], ['#tab-fx', 'fx']]) { const b = $(id); b.setAttribute('aria-selected', String(m === mode)); b.classList.toggle('on', m === mode); b.tabIndex = m === mode ? 0 : -1; }
  $('#portal-lib').hidden = mode !== 'portal'; $('#library').hidden = mode !== 'fx';
  app.classList.toggle('mode-portal', mode === 'portal');
  renderActive(); renderPortalLib(); renderLibrary(); if (!$('#settings').hidden) renderSettings();
  fx.portal.tab = mode;
}
function renderPortalLib() {
  const lib = $('#portal-lib');
  if (!lib.children.length) {
    for (const m of PORTAL_MODES) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'fx'; b.dataset.id = m.id; b.title = `${m.name} portal`;
      b.innerHTML = `<span class="fx-glyph" aria-hidden="true">${m.glyph}</span><span class="fx-name">${m.name}</span><i class="fx-dot" aria-hidden="true"></i>`;
      b.addEventListener('click', () => { setPortalMode(m.id); if (!state.portalOn) setPortalOn(true); });
      lib.appendChild(b);
    }
  }
  for (const b of lib.children) {
    const sel = b.dataset.id === portal.mode;
    b.classList.toggle('selected', sel); b.classList.toggle('on', sel && state.portalOn);
    b.setAttribute('aria-pressed', String(sel));
    b.setAttribute('aria-label', `${PORTAL_MAP[b.dataset.id].name} portal fill${sel ? ', selected' : ''}`);
  }
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
  const f = cur(), s = state.settings[f.id];
  $('#active-name').textContent = f.id === 'portal' ? `Portal · ${PORTAL_MAP[portal.mode].name}` : f.name; $('#active-glyph').textContent = f.glyph;
  const sw = $('#btn-active-toggle'); sw.setAttribute('aria-checked', String(isOn(f.id))); sw.setAttribute('aria-label', `${f.name} on/off`);
  const ip = f.params.find((p) => p.key === 'intensity');
  const inp = $('#intensity'); inp.value = s.intensity; $('#intensity-val').textContent = `${s.intensity}${ip.unit}`;
  $('#intensity-label').textContent = ip.label;
  inp.setAttribute('aria-label', `${f.name} – ${ip.label}`); inp.title = ip.label;
  const col = $('#color');
  col.disabled = !f.hasColor; col.parentElement.classList.toggle('disabled', !f.hasColor);
  col.parentElement.title = f.id === 'portal' ? 'Blue Face color' : f.hasColor ? 'Effect color' : `${f.name} has no color setting`;
  if (f.hasColor) { col.value = s.color; col.parentElement.style.setProperty('--swatch', s.color); }
  else col.parentElement.style.setProperty('--swatch', '#2a2a2a');
}
function renderSettings() {
  const f = cur(), s = state.settings[f.id], form = $('#settings-form');
  $('#settings-name').textContent = f.name; $('#settings-glyph').textContent = f.glyph;
  $('#settings-state').textContent = f.id === 'portal' ? (state.portalOn ? `On · ${PORTAL_MAP[portal.mode].name} fill` : 'Off — tap the switch to turn it on')
    : enabled.has(f.id) ? 'On' : 'Off — tap the switch or the effect to turn it on';
  $('#btn-reset-fx').textContent = f.id === 'portal' ? 'Reset Hand Portal' : 'Reset this effect';
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
function openSheet(id, returnTo = null) {
  for (const other of ['settings', 'help']) if (other !== id) closeSheet(other, false);
  rt.sheetReturn = returnTo; // keyboard users get focus back on the opener; otherwise focus is released
  const el = $('#' + id); el.hidden = false; requestAnimationFrame(() => el.classList.add('open'));
  document.querySelectorAll(`[aria-controls="${id}"]`).forEach((b) => b.setAttribute('aria-expanded', 'true'));
  if (id === 'settings') renderSettings();
  el.querySelector('.sheet-head .icon-btn').focus({ preventScroll: true });
}
function closeSheet(id, restore = true) {
  const el = $('#' + id); if (el.hidden) return;
  if (restore && (el.contains(document.activeElement) || document.activeElement === document.body)) {
    if (rt.sheetReturn && document.contains(rt.sheetReturn)) rt.sheetReturn.focus({ preventScroll: true });
    else document.activeElement?.blur?.();
  }
  el.classList.remove('open'); setTimeout(() => { if (!el.classList.contains('open')) el.hidden = true; }, 260);
  document.querySelectorAll(`[aria-controls="${id}"]`).forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
const toggleSheet = (id, returnTo = null) => ($('#' + id).hidden ? openSheet(id, returnTo) : closeSheet(id));
/** Opener to restore focus to: only when the button was activated from the keyboard (click detail 0). */
const kbOpener = (e) => (e && e.detail === 0 ? e.currentTarget : null);

/* ------------------------------------------------------------------ capture */
function screenshot() {
  if (!rt.running) return;
  const f = $('#flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  // render one frame at the full native camera resolution, snapshot it, then restore the preview size
  const prev = rt.captureFull;
  if (!prev) { rt.captureFull = true; sizeCanvas(true); draw(performance.now() / 1000, 0); }
  const w = canvas.width, h = canvas.height;
  canvas.toBlob((blob) => {
    if (!blob) { toast('Screenshot failed'); return; }
    const name = `ar-fx-${stamp()}.png`;
    fx.lastScreenshot = { name, size: blob.size, type: blob.type, width: w, height: h, at: Date.now() };
    download(blob, name); toast('📸 Screenshot saved');
  }, 'image/png');
  if (!prev) { rt.captureFull = false; sizeCanvas(true); draw(performance.now() / 1000, 0); }
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
  rt.captureFull = true; sizeCanvas(true); draw(performance.now() / 1000, 0); // record at native resolution
  let rec;
  try {
    const stream = canvas.captureStream(30);
    rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
  } catch (e) { rt.captureFull = false; sizeCanvas(true); logError('record', e); toast('Could not start recording: ' + e.message, 3000); return; }
  const recSize = [canvas.width, canvas.height];
  rt.recChunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) rt.recChunks.push(e.data); };
  rec.onstop = () => {
    const type = rec.mimeType || mime || 'video/webm';
    const blob = new Blob(rt.recChunks, { type });
    const ext = /mp4/.test(type) ? 'mp4' : 'webm';
    const name = `ar-fx-${stamp()}.${ext}`;
    fx.lastRecording = { name, size: blob.size, type, width: recSize[0], height: recSize[1], duration: (performance.now() - rt.recStart) / 1000, at: Date.now() };
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
  rt.captureFull = false; if (rt.running) sizeCanvas(true);
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
  $('#btn-help').addEventListener('click', (e) => toggleSheet('help', kbOpener(e)));
  $('#btn-help-idle').addEventListener('click', (e) => openSheet('help', kbOpener(e)));
  $('#btn-settings').addEventListener('click', (e) => toggleSheet('settings', kbOpener(e)));
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet(b.dataset.close)));
  $('#btn-active-toggle').addEventListener('click', () => (state.mode === 'portal' ? setPortalOn(!state.portalOn) : toggleEffect()));
  $('#intensity').addEventListener('input', (e) => { const v = +e.target.value, f = cur(); $('#intensity-val').textContent = `${v}${f.params[0].unit}`; setSetting(f.id, 'intensity', v); syncSettingsField('intensity', v); });
  $('#color').addEventListener('input', (e) => { setSetting(cur().id, 'color', e.target.value); syncSettingsField('color', e.target.value); });
  $('#btn-reset-fx').addEventListener('click', () => {
    const id = cur().id; state.settings[id] = id === 'portal' ? portalDefaults() : defaultSettings(id);
    if (id === 'portal') { portal.cycle = state.settings.portal.cycle; portal.setSmoothing(state.settings.portal.smooth); }
    persist(); renderActive(); renderSettings(); toast(id === 'portal' ? 'Hand Portal reset' : 'Effect reset');
  });
  $('#tab-portal').addEventListener('click', () => setTab('portal'));
  $('#tab-fx').addEventListener('click', () => setTab('fx'));
  $('.tabs').addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); setTab(state.mode === 'portal' ? 'fx' : 'portal'); $(state.mode === 'portal' ? '#tab-portal' : '#tab-fx').focus(); } });
  $('#btn-reset-all').addEventListener('click', () => {
    if (!confirm('Reset every effect and studio setting to the defaults?')) return;
    for (const f of EFFECTS) state.settings[f.id] = defaultSettings(f.id);
    state.settings.portal = portalDefaults(); portal.cycle = 'video'; portal.setSmoothing(50); portal.setMode('magnify');
    enabled.clear(); state.active = 'neon'; state.mirror = 'auto'; state.perf = 'auto'; state.debug = false; state.fit = 'auto'; state.faces = 2;
    state.portalOn = true; state.portalMode = 'magnify';
    setGestures(true); saveNow(state); applyStudioControls(); setTab('portal'); renderSettings(); toast('All settings reset');
  });
  $('#opt-mirror').addEventListener('change', (e) => { state.mirror = e.target.value; persist(); rt.mirror = state.mirror === 'on' || (state.mirror === 'auto' && camera.facing !== 'environment'); if (rt.running) sizeCanvas(true); });
  $('#opt-perf').addEventListener('change', (e) => { state.perf = e.target.value; persist(); if (state.perf === 'auto') rt.scale = 1; sizeCanvas(true); });
  $('#opt-debug').addEventListener('change', (e) => { state.debug = e.target.checked; persist(); });
  $('#opt-fit').addEventListener('change', (e) => { state.fit = e.target.value; persist(); if (rt.running) sizeCanvas(true); });
  $('#opt-faces').addEventListener('change', async (e) => { state.faces = +e.target.value; persist(); await tracker.setNumFaces(state.faces).catch((err) => logError('faces', err)); });
  $('#opt-gestures').addEventListener('change', (e) => setGestures(e.target.checked));
  $('#btn-retry-load').addEventListener('click', loadEngine);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSheet('settings'); closeSheet('help'); return; }
    // focus trap inside an open sheet
    const open = ['settings', 'help'].map((i) => $('#' + i)).find((el) => !el.hidden);
    if (e.key === 'Tab' && open) {
      const f = [...open.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && x.offsetParent !== null);
      if (f.length) {
        const i = f.indexOf(document.activeElement);
        if (i === -1 || (e.shiftKey && i === 0) || (!e.shiftKey && i === f.length - 1)) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
      }
      return;
    }
    // ignore keys from elements that are hidden (e.g. a closed sheet's button that kept focus)
    if (e.target !== document.body && e.target.closest?.('[hidden]')) e.target.blur();
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (['input', 'select', 'textarea'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (tag === 'button' && (e.key === ' ' || e.key === 'Enter')) return;
    const k = e.key.toLowerCase(), P = state.mode === 'portal';
    if (k === 'arrowright') P ? setPortalMode(portal.next(1), 'key') : selectRelative(1);
    else if (k === 'arrowleft') P ? setPortalMode(portal.next(-1), 'key') : selectRelative(-1);
    else if (k === ' ') { e.preventDefault(); P ? setPortalOn(!state.portalOn) : toggleEffect(); }
    else if (k === 'arrowup' || k === 'arrowdown') { e.preventDefault(); const f = cur(), s = state.settings[f.id]; setSetting(f.id, 'intensity', Math.max(0, Math.min(100, s.intensity + (k === 'arrowup' ? 5 : -5)))); }
    else if (k === 't') setTab(P ? 'fx' : 'portal');
    else if (P && k >= '1' && k <= String(MODE_IDS.length)) setPortalMode(MODE_IDS[+k - 1], 'key');
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
  window.addEventListener('resize', measureChrome);
  window.addEventListener('orientationchange', () => setTimeout(measureChrome, 250));
  if ('ResizeObserver' in window) { const ro = new ResizeObserver(measureChrome); ro.observe($('.topbar')); ro.observe($('.dock')); }
}
function syncSettingsField(key, v) {
  if ($('#settings').hidden) return;
  const el = document.getElementById(`set-${cur().id}-${key}`); if (!el) return;
  el.value = v; const out = el.parentElement.querySelector('output');
  const unit = cur().params.find((p) => p.key === key)?.unit || '';
  if (out) out.textContent = v + unit;
}
function applyStudioControls() {
  setTab(state.mode);
  $('#opt-mirror').value = state.mirror; $('#opt-perf').value = state.perf; $('#opt-debug').checked = state.debug;
  $('#opt-fit').value = state.fit; $('#opt-faces').value = String(state.faces);
  setGestures(state.gestures);
}

/* ------------------------------------------------------------------ test hooks */
// Used by the automated test-suite: render the *same* camera frame with and without an effect
// and measure how many pixels inside the face region changed.
fx.test = {
  faceRect() { return rt.faceOk ? { x: face.minX, y: face.minY, w: face.w, h: face.h } : null; },
  faceRects() { return rt.faceOk ? faces.slice(0, rt.faceN).map((f) => ({ x: f.minX, y: f.minY, w: f.w, h: f.h })) : []; },
  vmap: () => ({ ...vmap }),
  /** alpha profile (0..255) across the middle row of the last Mirror Distortion output buffer */
  mirrorAlphaProfile(samples = 41) {
    const c = getBuffer('mirOut'), r = EFFECT_MAP.mirror.lastRect; if (!c || !r) return null;
    const row = c.getContext('2d').getImageData(0, Math.round(r.fy), r.w, 1).data, out = [];
    for (let i = 0; i < samples; i++) out.push(row[Math.min(r.w - 1, Math.round((i / (samples - 1)) * (r.w - 1))) * 4 + 3]);
    return out;
  },
  gestureController: gestures,
  diffEffect(id, settings, pad = 0) {
    if (!rt.faceOk) return { error: 'no face' };
    // region: the face box (optionally padded) or, with pad === 'eyes', just the eye area
    const reg = typeof pad === 'object' && pad ? pad : pad === 'eyes' ? face.bbox([...IDX.eyeR, ...IDX.eyeL], 0.25)
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
  /** Feed synthetic hand landmarks instead of the detector (null = back to the camera). */
  setHands(h) { rt.testHands = h; },
  /** Render the current frame now and return it as a data URL (same task, so the read-back is reliable). */
  snapshot(type = 'image/png', q = 0.92) { draw(performance.now() / 1000, 0); return canvas.toDataURL(type, q); },
  /** canvas px → normalized video coords (inverse of the preview mapping, mirror aware) */
  toVideo(x, y) { const cx = rt.mirror ? rt.W - x : x; return { x: (cx / vmap.k + vmap.sx) / vmap.vw, y: (y / vmap.k + vmap.sy) / vmap.vh }; },
  /** 21-point synthetic hand (normalized video coords) whose thumb & index tips sit at t4 / t8. */
  makeHand(t4, t8, wrist) {
    const L = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: 0 });
    const tip = { x: (t4.x + t8.x) / 2, y: (t4.y + t8.y) / 2 }, h = new Array(21);
    h[0] = { ...wrist, z: 0 };
    for (let i = 1; i <= 4; i++) h[i] = L(wrist, t4, i / 4.4); h[4] = { ...t4, z: 0 };
    for (let f = 0; f < 4; f++) { const base = 5 + f * 4, end = f === 0 ? t8 : L(wrist, tip, 0.8 - f * 0.08); for (let j = 0; j < 4; j++) h[base + j] = L(wrist, end, 0.45 + j * 0.183); }
    h[8] = { ...t8, z: 0 };
    return h;
  },
  /** Two synthetic pinching hands at eye level, `spread` face-widths from the eye midpoint. */
  pinchHandsAtEyes(spread = 0.6) {
    if (!rt.faceOk) return null;
    const a = face.irisCenter('R', {}), b = face.irisCenter('L', {}), ex = (a.x + b.x) / 2, ey = (a.y + b.y) / 2, w = face.w;
    const mk = (side) => {
      const px = ex + side * spread * w, py = ey, g = w * 0.025;
      const t4 = fx.test.toVideo(px - side * g, py + g * 0.3), t8 = fx.test.toVideo(px + side * g * 0.2, py - g * 0.3), wr = fx.test.toVideo(px + side * w * 0.3, py + w * 0.55);
      return fx.test.makeHand(t4, t8, wr);
    };
    return [mk(-1), mk(1)];
  },
  /** Two synthetic "L" hands framing the face (index tips above, thumb tips below the eyes). */
  frameHandsAroundFace(scale = 1) {
    if (!rt.faceOk) return null;
    const w = face.w * scale, cx = face.cx, cy = face.cy;
    const mk = (side) => {
      const t8 = fx.test.toVideo(cx + side * w * 0.55, cy - w * 0.45), t4 = fx.test.toVideo(cx + side * w * 0.2, cy + w * 0.35), wr = fx.test.toVideo(cx + side * w * 1.1, cy + w * 0.4);
      return fx.test.makeHand(t4, t8, wr);
    };
    return [mk(-1), mk(1)];
  },
  setTab, setPortalMode, setPortalOn,
  portalController: portal,
  portalLogic: { orderQuad, isSelfIntersecting },
  /**
   * Render the current camera frame with and without one Hand Portal output and measure the
   * change inside vs. outside the region (quad polygon, ribbon polygon or face oval).
   * kind: a portal fill id, 'ribbon' or 'blueface'.
   */
  diffPortal(kind, override = null) {
    const t = performance.now() / 1000, s = override ? { ...state.settings.portal, ...override } : state.settings.portal;
    drawVideo(); renderEffects(enabled, t, 1 / 30); mapPortal();
    let region = null, drawFn = null, box;
    if (MODE_IDS.includes(kind)) {
      if (!portal.quad) return { error: 'no quad', state: portal.state };
      region = (c) => { c.beginPath(); c.moveTo(PQ[0].x, PQ[0].y); for (let i = 1; i < 4; i++) c.lineTo(PQ[i].x, PQ[i].y); c.closePath(); };
      drawFn = () => renderPortal(ctx, PQ, kind, s, env); box = quadBox(PQ, rt.W, rt.H, 12);
    } else if (kind === 'ribbon') {
      if (!portal.pinch) return { error: 'no pinch', state: portal.state };
      const rp = ribbonParams(); ribbonGeometry(PP[0], PP[1], { eye: rp.eye, band: rp.band, stretch: portal.stretch, n: 24 }, RIB);
      region = (c) => { c.beginPath(); c.moveTo(RIB[0], RIB[1]); for (let i = 1; i < RIB.length / 2; i++) c.lineTo(RIB[i * 2], RIB[i * 2 + 1]); c.closePath(); };
      drawFn = () => renderRibbon(ctx, RIB, rp.band, portal.stretch, s, env);
      const pts = []; for (let i = 0; i < RIB.length / 2; i++) pts.push({ x: RIB[i * 2], y: RIB[i * 2 + 1] }); box = quadBox(pts, rt.W, rt.H, 12);
    } else if (kind === 'blueface') {
      if (!rt.faceOk) return { error: 'no face' };
      region = (c) => face.path(c, IDX.oval, true, 1.0);
      drawFn = () => renderBlueFace(ctx, face, s, env); box = quadBox([{ x: face.minX, y: face.minY }, { x: face.maxX, y: face.maxY }], rt.W, rt.H, 12);
    } else return { error: 'unknown kind' };
    if (!box) return { error: 'empty region' };
    const { x, y, w, h } = box;
    const a = ctx.getImageData(x, y, w, h).data;
    drawFn(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none'; ctx.shadowBlur = 0;
    const b = ctx.getImageData(x, y, w, h).data;
    const m = document.createElement('canvas'); m.width = w; m.height = h; const mc = m.getContext('2d');
    mc.translate(-x, -y); region(mc); mc.fillStyle = '#fff'; mc.fill(); const mask = mc.getImageData(0, 0, w, h).data;
    let inN = 0, inC = 0, outN = 0, outC = 0, inSum = 0, rS = 0, gS = 0, bS = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      if (mask[i + 3] > 200) { inN++; inSum += d; if (d > 30) inC++; rS += b[i]; gS += b[i + 1]; bS += b[i + 2]; }
      else if (mask[i + 3] === 0) { outN++; if (d > 30) outC++; }
    }
    return { kind, inside: +(inC / Math.max(1, inN)).toFixed(3), outside: +(outC / Math.max(1, outN)).toFixed(3), meanDiff: +(inSum / Math.max(1, inN) / 3).toFixed(1),
      meanRGB: [Math.round(rS / Math.max(1, inN)), Math.round(gS / Math.max(1, inN)), Math.round(bS / Math.max(1, inN))], px: inN, rect: [x, y, w, h], errors: [...rt.fxErrors] };
  },
  setEffects(ids) { enabled.clear(); ids.forEach((i) => enabled.add(i)); persist(); renderLibrary(); renderActive(); },
  burst: triggerBurst,
  gesture: (g) => onGesture({ type: 'gesture', gesture: g }),
  pinch: (dy) => { onGesture({ type: 'pinch_start' }); onGesture({ type: 'pinch_move', dy }); },
  state: () => JSON.parse(JSON.stringify({ ...state, enabled: [...enabled] })),
};

/* ------------------------------------------------------------------ boot */
bind(); applyStudioControls(); renderLibrary(); renderPortalLib(); renderActive(); syncDebug(); measureChrome(); syncFs();
loadEngine();
