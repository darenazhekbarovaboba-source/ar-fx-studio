// Camera access (getUserMedia) with device switching and friendly errors.
export class CameraError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function explainCameraError(e) {
  if (e instanceof CameraError) return e;
  const n = e?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError')
    return new CameraError('denied', 'Camera permission was blocked. Allow camera access for this site in your browser settings (the camera icon in the address bar), then press Retry.');
  if (n === 'OverconstrainedError' || n === 'ConstraintNotSatisfiedError')
    return new CameraError('constraints', 'Your camera does not support the requested mode (camera direction or resolution). Press Retry to try again with default settings, or pick another camera.');
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError')
    return new CameraError('nocam', 'No camera was found. Connect a webcam (or close the app that is using it) and press Retry.');
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError')
    return new CameraError('busy', 'The camera is in use by another app or tab, or the hardware failed to start. Close other apps using the camera and press Retry.');
  return new CameraError('unknown', `Could not start the camera: ${e?.message || n || 'unknown error'}`);
}

export class Camera {
  constructor(video) {
    this.video = video; this.stream = null; this.devices = []; this.deviceId = null;
    this.facing = 'user'; // requested facing mode
  }
  static checkSupport() {
    if (!window.isSecureContext) throw new CameraError('insecure', 'Camera access needs a secure (HTTPS) connection. Open the https:// version of this page, or run it on localhost.');
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('unsupported', 'This browser does not support camera access (getUserMedia). Try a current version of Chrome, Edge, Firefox or Safari.');
  }
  get running() { return !!this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live'); }
  async refreshDevices() {
    try { this.devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); }
    catch { this.devices = []; }
    return this.devices;
  }
  /** True when switching makes sense: several cameras, or a touch/mobile device with facingMode support. */
  get canSwitch() {
    if (this.devices.length > 1) return true;
    const facing = !!navigator.mediaDevices?.getSupportedConstraints?.().facingMode;
    const mobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    return facing && mobile;
  }
  async start({ deviceId, facing } = {}) {
    Camera.checkSupport();
    this.stop();
    const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = facing || this.facing;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video, audio: false }); }
    catch (e) {
      if (e?.name === 'OverconstrainedError') stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }).catch((e2) => { throw explainCameraError(e2); });
      else throw explainCameraError(e);
    }
    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    const st = track.getSettings ? track.getSettings() : {};
    this.deviceId = st.deviceId || deviceId || null;
    this.label = track.label || 'Camera';
    if (st.facingMode) this.facing = st.facingMode;
    else if (/back|rear|environment/i.test(this.label)) this.facing = 'environment';
    else this.facing = 'user';
    this.video.srcObject = stream;
    this.video.muted = true; this.video.playsInline = true;
    await this.video.play().catch(() => {});
    if (!this.video.videoWidth) await new Promise((res) => this.video.addEventListener('loadedmetadata', res, { once: true }));
    await this.refreshDevices();
    track.addEventListener('ended', () => this.onEnded?.());
    return { width: this.video.videoWidth, height: this.video.videoHeight, label: this.label, facing: this.facing };
  }
  /** Cycle to the next camera. Uses deviceIds when known, otherwise flips facingMode. */
  async switch() {
    if (this.devices.length > 1) {
      const i = this.devices.findIndex((d) => d.deviceId === this.deviceId);
      const next = this.devices[(i + 1) % this.devices.length];
      return this.start({ deviceId: next.deviceId });
    }
    return this.start({ facing: this.facing === 'user' ? 'environment' : 'user' });
  }
  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
  }
}
