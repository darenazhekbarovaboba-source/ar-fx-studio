// MediaPipe Tasks Vision: Face Landmarker + Hand Landmarker (VIDEO mode).
export const MP_VERSION = '1.2.3';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
export const MODELS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};

/** Download a file with real byte progress. */
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status} while downloading ${url.split('/').pop()}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !res.body.getReader) { const b = new Uint8Array(await res.arrayBuffer()); onProgress(1, b.length, b.length); return b; }
  const reader = res.body.getReader(); const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(total ? got / total : 0, got, total);
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  onProgress(1, got, got || total);
  return out;
}

/** Detect software-emulated WebGL (SwiftShader / llvmpipe), where the GPU delegate is slower than CPU. */
export function softwareGL() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    if (!gl) return 'no-webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|software|basic render/i.test(r) ? r : null;
  } catch { return null; }
}

export class Tracker {
  constructor() {
    this.vision = null; this.face = null; this.hand = null;
    this.delegate = { face: null, hand: null };
    this.tess = null; this.lastTs = 0; this.forceCPU = /[?&]cpu=1/.test(location.search);
    this.forceGPU = /[?&]gpu=1/.test(location.search);
    this.cpuReason = this.forceCPU ? 'forced (?cpu=1)' : null;
  }
  /** @param {(stage:string, progress:number, info?:string)=>void} onStage */
  async load(onStage) {
    onStage('wasm', 0, 'Loading vision runtime');
    let mod;
    try { mod = await import(`${CDN}/vision_bundle.mjs`); }
    catch (e) { throw Object.assign(new Error('Could not load the MediaPipe library from the CDN. Check your connection or content blockers.'), { code: 'cdn', cause: e }); }
    this.mod = mod;
    this.vision = await mod.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
    onStage('wasm', 1, 'Runtime ready');
    const t = mod.FaceLandmarker.FACE_LANDMARKS_TESSELATION;
    this.tess = new Uint16Array(t.length * 2); t.forEach((c, i) => { this.tess[i * 2] = c.start; this.tess[i * 2 + 1] = c.end; });

    const fmt = (got, total) => `${(got / 1048576).toFixed(1)} / ${(total / 1048576 || 0).toFixed(1)} MB`;
    let faceBuf, handBuf;
    try {
      [faceBuf, handBuf] = await Promise.all([
        fetchWithProgress(MODELS.face, (p, g, t) => onStage('face', p * 0.9, fmt(g, t))),
        fetchWithProgress(MODELS.hand, (p, g, t) => onStage('hand', p * 0.9, fmt(g, t))),
      ]);
    } catch (e) { throw Object.assign(new Error('Could not download the face/hand models. ' + e.message), { code: 'model', cause: e }); }

    onStage('face', 0.92, 'Initialising face tracker');
    this.face = await this._create(mod.FaceLandmarker, faceBuf, (d) => ({
      runningMode: 'VIDEO', numFaces: 1, minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false,
    }), 'face');
    onStage('face', 1, `Ready (${this.delegate.face})`);
    onStage('hand', 0.92, 'Initialising hand tracker');
    this.hand = await this._create(mod.HandLandmarker, handBuf, () => ({
      runningMode: 'VIDEO', numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    }), 'hand');
    onStage('hand', 1, `Ready (${this.delegate.hand})`);
    this.bufs = { face: faceBuf, hand: handBuf };
  }
  async _create(Cls, buffer, opts, key) {
    const tryWith = (delegate) => Cls.createFromOptions(this.vision, { baseOptions: { modelAssetBuffer: buffer, delegate }, ...opts(delegate) });
    if (!this.forceCPU && !this.forceGPU && this._sw === undefined) {
      this._sw = softwareGL();
      if (this._sw) this.cpuReason = `software WebGL (${this._sw}) — CPU is faster`;
    }
    if (!this.forceCPU && (this.forceGPU || !this._sw)) {
      try { const r = await tryWith('GPU'); this.delegate[key] = 'GPU'; return r; }
      catch (e) { this.cpuReason = 'GPU delegate failed to start'; console.warn(`[ar-fx] GPU delegate unavailable for ${key}, using CPU`, e?.message || e); }
    }
    const r = await tryWith('CPU'); this.delegate[key] = 'CPU'; return r;
  }
  /** Rebuild a landmarker on CPU if the GPU path fails at runtime. */
  async fallbackToCPU(key) {
    const Cls = key === 'face' ? this.mod.FaceLandmarker : this.mod.HandLandmarker;
    try { this[key]?.close(); } catch {}
    this[key] = null;
    const opts = key === 'face'
      ? { runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: false }
      : { runningMode: 'VIDEO', numHands: 2 };
    this[key] = await Cls.createFromOptions(this.vision, { baseOptions: { modelAssetBuffer: this.bufs[key], delegate: 'CPU' }, ...opts });
    this.delegate[key] = 'CPU';
  }
  _ts() { const t = performance.now(); this.lastTs = t > this.lastTs ? t : this.lastTs + 0.01; return this.lastTs; }
  detectFace(video) { return this.face ? this.face.detectForVideo(video, this._ts()) : null; }
  detectHands(video) { return this.hand ? this.hand.detectForVideo(video, this._ts()) : null; }
}
