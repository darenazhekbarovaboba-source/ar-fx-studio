// Hand Portal — pure logic (no DOM, unit-tested): hand-pose classification, portal quad
// ordering, One Euro smoothing, static-ribbon geometry and the mode-switching state machine.
// Landmarks are MediaPipe Hands (0 wrist, 4 thumb tip, 6 index PIP, 8 index tip, 9 middle MCP)
// in normalized video space. `aspect` = videoWidth / videoHeight so distances are isotropic.

export const PORTAL_MODES = [
  { id: 'magnify', name: 'Magnify', glyph: '⌕' },
  { id: 'pixel', name: 'Pixel', glyph: '▦' },
  { id: 'red', name: 'Red', glyph: '■' },
  { id: 'glitch', name: 'Glitch', glyph: '≋' },
  { id: 'static', name: 'Static', glyph: '░' },
  { id: 'rainbow', name: 'Rainbow', glyph: '◑' },
  { id: 'invert', name: 'Invert', glyph: '◐' },
];
export const MODE_IDS = PORTAL_MODES.map((m) => m.id);
/** The three fills the reference video cycles through, in order. */
export const VIDEO_CYCLE = ['magnify', 'pixel', 'red'];

/** Settings definition for the Hand Portal (same shape as an effect's params). */
export const PORTAL_DEF = {
  id: 'portal', name: 'Hand Portal', short: 'Portal', glyph: '⬚', hasColor: true,
  params: [
    { key: 'intensity', label: 'Strength', type: 'range', min: 0, max: 100, step: 1, def: 60, unit: '%' },
    { key: 'cycle', label: 'Re-frame to switch fill', type: 'select', options: [['video', 'Magnify → Pixel → Red (like the reference)'], ['all', 'All 7 portal fills'], ['off', 'Off (tap a fill to change)']], def: 'video' },
    { key: 'border', label: 'Glow border (Magnify)', type: 'toggle', def: true },
    { key: 'blueFace', label: 'Blue Face when no frame or pinch', type: 'toggle', def: true },
    { key: 'color', label: 'Blue Face color', type: 'color', def: '#1fb2ff' },
    { key: 'ribbon', label: 'Static ribbon on two-hand pinch', type: 'toggle', def: true },
    { key: 'grain', label: 'Ribbon grain size', type: 'range', min: 0, max: 100, step: 1, def: 40, unit: '' },
    { key: 'smooth', label: 'Hand smoothing', type: 'range', min: 0, max: 100, step: 1, def: 50, unit: '' },
  ],
};
export function portalDefaults() { const o = {}; for (const p of PORTAL_DEF.params) o[p.key] = p.def; return o; }

/* ---------------------------------------------------------------- geometry */
const dist = (a, b, k = 1) => Math.hypot((a.x - b.x) * k, a.y - b.y);

/** Per-hand pose metrics. ti = thumb-tip↔index-tip distance in palm lengths. */
export function handPose(h, aspect = 1) {
  const size = dist(h[0], h[9], aspect) || 1e-6;
  const ti = dist(h[4], h[8], aspect) / size;
  const indexUp = dist(h[0], h[8], aspect) > dist(h[0], h[6], aspect) * 1.05;
  return { size, ti, indexUp };
}
export const FRAME_ON = 1.0, FRAME_OFF = 0.65; // thumb↔index spread (palm lengths) of an "L"; below = frame closed
export const PINCH_ON = 0.3, PINCH_OFF = 0.45; // thumb touching index (looser: real pinches read 0.1–0.35)
export const EDGE = 0.08; // a pinch this close to the frame edge gets a looser threshold (hand partly out of frame)
export const CLOSE = 0.6; // one hand's thumb back on its index (frame clearly closed) → deliberate release
export const COLLAPSE = 0.25; // a quad edge shorter than this fraction of the opposite edge = collapsed triangle reading

/** Signed area (shoelace) of a polygon given as [{x,y},…]. */
export function polyArea(p, k = 1) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q.x * k * r.y - r.x * k * q.y; }
  return a / 2;
}
function segCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
/** True when edges 0-1 / 2-3 or 1-2 / 3-0 cross (a "bow-tie"). */
export function isSelfIntersecting(q) { return segCross(q[0], q[1], q[2], q[3]) || segCross(q[1], q[2], q[3], q[0]); }
/**
 * Order 4 points into a simple (non-self-intersecting) quad: sort by angle around the centroid.
 * Linear maps (aspect scaling, mirroring) preserve or reverse this cyclic order, so it is safe
 * to order in normalized video space or in canvas space. Returns a new array (clockwise on screen).
 */
export function orderQuad(pts) {
  let cx = 0, cy = 0; for (const p of pts) { cx += p.x; cy += p.y; } cx /= pts.length; cy /= pts.length;
  return pts.map((p) => ({ p, a: Math.atan2(p.y - cy, p.x - cx) })).sort((u, v) => u.a - v.a).map((o) => o.p);
}

/* ---------------------------------------------------------------- smoothing */
const alpha = (dt, cutoff) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };
/** One Euro filter (Casiez et al. 2012): low jitter at rest, low lag when moving. t in seconds. */
export class OneEuro {
  constructor(minCutoff = 1.5, beta = 4, dCutoff = 1) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; this.t = null; this.x = 0; this.dx = 0; }
  reset() { this.t = null; }
  filter(x, t) {
    if (this.t === null) { this.t = t; this.x = x; this.dx = 0; return x; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    this.dx += alpha(dt, this.dCutoff) * ((x - this.x) / dt - this.dx);
    this.x += alpha(dt, this.minCutoff + this.beta * Math.abs(this.dx)) * (x - this.x);
    return this.x;
  }
}
class PointFilter {
  constructor() { this.fx = new OneEuro(); this.fy = new OneEuro(); this.out = { x: 0, y: 0 }; }
  tune(minCutoff, beta) { this.fx.minCutoff = this.fy.minCutoff = minCutoff; this.fx.beta = this.fy.beta = beta; }
  reset() { this.fx.reset(); this.fy.reset(); }
  filter(p, t) { this.out.x = this.fx.filter(p.x, t); this.out.y = this.fy.filter(p.y, t); return this.out; }
}

/* ---------------------------------------------------------------- ribbon */
/**
 * Static-ribbon outline between two pinch points (canvas px). The centre line is a quadratic
 * curve that passes through the eyes (when they sit between the hands), so the ribbon starts as
 * a visor across the eyes. As the hands pull apart (stretch = current length / length when the
 * pinch started) it tapers toward ONE end — `taper: 'left' | 'right'` (the hand that pulls away,
 * as in the reference) — while the other end stays square at the full band width; 'both' tapers
 * symmetrically. At stretch 1 it is a uniform band.
 * Writes n+1 top-edge then n+1 bottom-edge points into `out` (Float32Array(4*(n+1))).
 */
export function ribbonGeometry(a, b, { eye = null, band = 40, stretch = 1, n = 24, taper = 'right' } = {}, out = new Float32Array(4 * (n + 1))) {
  let p1 = a, p2 = b; if (p1.x > p2.x) { p1 = b; p2 = a; }
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2, L = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
  let cx = mx, cy = my, ue = 0.5;
  if (eye && eye.x > p1.x && eye.x < p2.x) {
    // pass through the eyes at the parameter matching their position between the hands
    ue = Math.max(0.25, Math.min(0.75, (eye.x - p1.x) / ((p2.x - p1.x) || 1)));
    const ve = 1 - ue, lx = ve * p1.x + ue * p2.x, ly = ve * p1.y + ue * p2.y; // point on the straight line
    const off = Math.hypot(eye.x - lx, eye.y - ly), w = Math.max(0, Math.min(1, 1.25 - off / (0.5 * L)));
    const ex = lx + w * (eye.x - lx), ey = ly + w * (eye.y - ly), k = 2 * ue * ve;
    cx = (ex - ve * ve * p1.x - ue * ue * p2.x) / k; cy = (ey - ve * ve * p1.y - ue * ue * p2.y) / k;
  }
  for (let i = 0; i <= n; i++) {
    const u = i / n, v = 1 - u;
    const x = v * v * p1.x + 2 * v * u * cx + u * u * p2.x, y = v * v * p1.y + 2 * v * u * cy + u * u * p2.y;
    let tx = 2 * v * (cx - p1.x) + 2 * u * (p2.x - cx), ty = 2 * v * (cy - p1.y) + 2 * u * (p2.y - cy);
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const half = ribbonWidth(u, band, stretch, taper, ue) / 2;
    out[i * 2] = x - ty * half; out[i * 2 + 1] = y + tx * half; // top edge (normal = (-ty, tx))
    const j = (2 * n + 1 - i) * 2; out[j] = x + ty * half; out[j + 1] = y - tx * half; // bottom edge, reversed
  }
  return out;
}
/** Ribbon width at parameter u (0 = left pinch, 1 = right pinch). */
export function ribbonWidth(u, band, stretch, taper = 'right', ue = 0.5) {
  const r = Math.max(0.18, Math.min(1, 1 / Math.max(1e-3, stretch)));
  if (taper === 'both') { const s = u < ue ? (ue - u) / ue : (u - ue) / (1 - ue); return band * (r + (1 - r) * (1 - s * s)); }
  const s = taper === 'left' ? 1 - u : u; // 0 at the square end → 1 at the tapered end
  return band * (1 - (1 - r) * Math.pow(s, 1.3));
}

/* ---------------------------------------------------------------- state machine */
const boxHit = (q, f, pad) => {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of q) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const px = (f.x1 - f.x0) * pad, py = (f.y1 - f.y0) * pad;
  return x0 <= f.x1 + px && x1 >= f.x0 - px && y0 <= f.y1 + py && y1 >= f.y0 - py;
};
const nearEdge = (p) => p.x < EDGE || p.x > 1 - EDGE || p.y < EDGE || p.y > 1 - EDGE;
/**
 * Decides, per frame, what the Hand Portal shows:
 *   'portal' — two hands framing (thumb + index "L" each): quad from both index & thumb tips
 *   'ribbon' — two hands pinching: static ribbon between the pinch points
 *   'none'   — no hands for NO_HANDS_MS
 *   'hands'  — hands visible but in neither pose
 * `blue` is true whenever neither the portal nor the ribbon is up (and hasn't been for NO_HANDS_MS):
 * the app then shows Blue Face on a visible face — idle hands in view included, like the reference.
 * Mode switching: the fill advances when the frame is RE-FORMED after a deliberate release — the portal
 * was gone for at least BREAK_MS. Tracking flicker shorter than GRACE_MS (hands lost, 2→1, a collapsed
 * triangle reading, a brief mis-read as a pinch) keeps the portal up and never counts as a release.
 */
export class PortalController {
  constructor(opts = {}) {
    this.GRACE_MS = opts.graceMs ?? 500; this.BREAK_MS = opts.breakMs ?? 800; this.NO_HANDS_MS = opts.noHandsMs ?? 250;
    this.MIN_DWELL_MS = opts.minDwellMs ?? 500; this.QUICK_DWELL_MS = opts.quickDwellMs ?? 1200; this.RIBBON_CONFIRM_MS = opts.ribbonConfirmMs ?? 250; this.RIBBON_GRACE_MS = opts.ribbonGraceMs ?? 900;
    this.mode = 'magnify'; this.cycle = 'video'; this.state = 'none'; this.blue = true;
    this.quad = null; this.pinch = null; this.stretch = 1; this.forms = 0; this.cycles = 0; this.moved = [0, 0]; this.pinchStart = null;
    this.lastPortalAt = -1e9; this.portalEndAt = -1e9; this.lastRibbonAt = -1e9; this.handsAt = -1e9; this.switchAt = -1e9;
    this.ribbonSeenAt = null; this.offAt = -1e9; this.closedN = 0; this.released = false; this._held = null; this.ribbonLen0 = 0; this.raw = 'none'; this.reason = '';
    this.f = Array.from({ length: 6 }, () => new PointFilter());
    this._q = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
    this._p = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    this.setSmoothing(50);
  }
  /** 0 = raw landmarks, 100 = heavy smoothing. */
  setSmoothing(v) {
    const k = Math.max(0, Math.min(100, v)) / 100;
    const minCutoff = 6 - 5.2 * k, beta = 10 - 7 * k;
    for (const f of this.f) f.tune(minCutoff, beta);
  }
  cycleList() { return this.cycle === 'all' ? MODE_IDS : VIDEO_CYCLE; }
  setMode(id) { if (MODE_IDS.includes(id)) this.mode = id; return this.mode; }
  /** Advance to the next fill (step ±1). Manual taps use the full list; re-frames use the cycle. */
  next(step = 1, list = MODE_IDS) {
    const i = list.indexOf(this.mode);
    this.mode = list[i === -1 ? 0 : (i + step + list.length) % list.length];
    return this.mode;
  }
  reset() { this.state = 'none'; this.blue = true; this.quad = this.pinch = null; this.forms = 0; this.ribbonSeenAt = null; this.lastPortalAt = this.portalEndAt = this.lastRibbonAt = this.handsAt = this.offAt = -1e9; for (const f of this.f) f.reset(); }

  /**
   * Classify the raw pose of this frame. Returns {kind, hands:[A,B], why} with A the left-most hand in video x.
   * @param faces optional face boxes {x0,y0,x1,y1} (normalized video space): when given, a portal must frame one of them
   */
  classify(hands, aspect = 1, faces = null) {
    if (!hands || hands.length === 0) return { kind: 'none' };
    if (hands.length < 2) return { kind: 'hands', why: 'one hand' };
    let A = hands[0], B = hands[1];
    if (A[0].x > B[0].x) { const t = A; A = B; B = t; }
    const pa = handPose(A, aspect), pb = handPose(B, aspect);
    const pinchTh = this.state === 'ribbon' ? PINCH_OFF : PINCH_ON;
    const pm = (h) => ({ x: (h[4].x + h[8].x) / 2, y: (h[4].y + h[8].y) / 2 });
    const thA = nearEdge(pm(A)) ? pinchTh * 1.3 : pinchTh, thB = nearEdge(pm(B)) ? pinchTh * 1.3 : pinchTh;
    if (pa.ti < thA && pb.ti < thB) return { kind: 'ribbon', A, B, pa, pb };
    const closed = Math.min(pa.ti, pb.ti) < CLOSE;
    const frameTh = this.state === 'portal' ? FRAME_OFF : FRAME_ON;
    if (pa.ti > frameTh && pb.ti > frameTh && pa.indexUp && pb.indexUp) {
      const q = [A[8], B[8], B[4], A[4]];
      const area = Math.abs(polyArea(orderQuad(q), aspect)), s = (pa.size + pb.size) / 2;
      const top = dist(A[8], B[8], aspect), bot = dist(A[4], B[4], aspect);
      const apart = top > 0.25 * s || bot > 0.25 * s;
      if (!(area > 0.2 * s * s && apart)) return { kind: 'hands', why: 'small' };
      if (Math.min(top, bot) < COLLAPSE * Math.max(top, bot)) return { kind: 'hands', why: 'collapsed' };
      if (faces && faces.length && !faces.some((f) => boxHit(q, f, 0.15))) return { kind: 'hands', why: 'off-face' };
      return { kind: 'portal', A, B, pa, pb };
    }
    return { kind: 'hands', why: closed ? 'closed' : 'pose' };
  }

  /**
   * @param hands MediaPipe hand landmarks (normalized video space)
   * @param now   milliseconds
   * @param faces optional face boxes (see classify)
   * @returns {{state, mode, quad, pinch, stretch, switched, blue}} quad/pinch in normalized video space
   */
  update(hands, now, aspect = 1, faces = null) {
    const t = now / 1000; let c = this.classify(hands, aspect, faces); this.raw = c.kind; this.reason = c.why || '';
    let switched = false;
    if (hands && hands.length) this.handsAt = now;
    // a brief mis-read as a pinch while the portal is up is flicker, not a pose change
    if (c.kind === 'ribbon') { if (this.ribbonSeenAt === null) this.ribbonSeenAt = now; } else this.ribbonSeenAt = null;
    if (c.kind === 'ribbon' && this.state === 'portal' && now - this.ribbonSeenAt < this.RIBBON_CONFIRM_MS) c = { kind: 'hands', why: 'pinch?' };
    // ribbon with one hand lost at the frame edge: keep it, the visible pinch keeps steering its end
    if (this.state === 'ribbon' && hands && hands.length === 1 && this.pinch) {
      const h = hands[0], hp = handPose(h, aspect), m = { x: (h[4].x + h[8].x) / 2, y: (h[4].y + h[8].y) / 2 };
      const i = dist(m, this._p[0], aspect) <= dist(m, this._p[1], aspect) ? 0 : 1;
      if (hp.ti < PINCH_OFF * 1.3 && nearEdge(this._p[1 - i])) {
        const p = this.f[4 + i].filter(m, t); this._p[i].x = p.x; this._p[i].y = p.y;
        this.lastRibbonAt = now; c = { kind: 'ribbon-hold' };
      }
    }
    // a deliberate release: the frame is visibly CLOSED (thumb back on the index) for 2+ frames
    this.closedN = c.why === 'closed' ? this.closedN + 1 : 0;
    if (this.closedN >= 2 && this.forms > 0) this.released = true;
    if (c.kind === 'portal') {
      const gap = now - this.lastPortalAt, wasOn = this.state === 'portal';
      // a deliberate re-frame: hands down for BREAK_MS, the frame visibly closed, or (after a short gap)
      // the hands came back framing somewhere clearly different. Same-pose flicker is none of these.
      // quick cues (closed / jump) need QUICK_DWELL_MS since the last switch; a full release only MIN_DWELL_MS
      const since = now - this.switchAt;
      const why = this.forms === 0 ? '' : gap >= this.BREAK_MS ? (since >= this.MIN_DWELL_MS ? 'break' : '')
        : since < this.QUICK_DWELL_MS ? '' : this.released ? 'closed' : gap >= 250 && this._jump(c, aspect) ? 'jump' : '';
      if (why && this.cycle !== 'off') {
        this.next(1, this.cycleList()); this.cycles++; this.switchAt = now; switched = true; this.switchWhy = why;
      }
      if (!wasOn || switched) this.forms++;
      if (gap > this.GRACE_MS || switched) for (let i = 0; i < 4; i++) this.f[i].reset();
      this.released = false;
      const src = [c.A[8], c.B[8], c.B[4], c.A[4]];
      for (let i = 0; i < 4; i++) { const p = this.f[i].filter(src[i], t); this._q[i].x = p.x; this._q[i].y = p.y; }
      this.quad = orderQuad(this._q); this._held = this.quad.map((p) => ({ x: p.x, y: p.y })); this.state = 'portal'; this.lastPortalAt = now; this.pinch = null;
    } else if (c.kind === 'ribbon') {
      if (this.state === 'portal') { this.portalEndAt = this.lastPortalAt; this.released = true; } // pinching = the frame was let go
      if (this.state !== 'ribbon') { if (now - this.lastRibbonAt > this.RIBBON_GRACE_MS) { this.f[4].reset(); this.f[5].reset(); this.ribbonLen0 = 0; } }
      const mids = [c.A, c.B].map((h) => ({ x: (h[4].x + h[8].x) / 2, y: (h[4].y + h[8].y) / 2 }));
      for (let i = 0; i < 2; i++) { const p = this.f[4 + i].filter(mids[i], t); this._p[i].x = p.x; this._p[i].y = p.y; }
      this._ribbon(aspect); this.state = 'ribbon'; this.lastRibbonAt = now; this.quad = null;
    } else if (c.kind === 'ribbon-hold') {
      this._ribbon(aspect);
    } else {
      // keep the last portal / ribbon alive through tracking flicker
      if (this.state === 'portal' && now - this.lastPortalAt <= this.GRACE_MS) { /* hold */ }
      else if (this.state === 'ribbon' && now - this.lastRibbonAt <= this.RIBBON_GRACE_MS) { /* hold */ }
      else {
        if (this.state === 'portal') this.portalEndAt = this.lastPortalAt;
        if (this.state === 'portal' || this.state === 'ribbon') this.offAt = now;
        this.quad = null; this.pinch = null;
        this.state = c.kind === 'none' && now - this.handsAt >= this.NO_HANDS_MS ? 'none' : 'hands';
      }
    }
    if (this.state === 'portal' || this.state === 'ribbon') this.offAt = now;
    this.blue = this.state !== 'portal' && this.state !== 'ribbon' && (now - this.offAt >= this.NO_HANDS_MS || this.state === 'none');
    return { state: this.state, mode: this.mode, quad: this.quad, pinch: this.pinch, stretch: this.stretch, switched, blue: this.blue };
  }
  /** the new raw frame is far from the last shown quad (moved by > 80% of its size, or area ×/÷ 3) */
  _jump(c, aspect) {
    const last = this.quad || this._held; if (!last) return true;
    const box = (q) => { const xs = q.map((p) => p.x), ys = q.map((p) => p.y); const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys); return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: (x1 - x0) * aspect, h: y1 - y0 }; };
    const a = box(last), b = box([c.A[8], c.B[8], c.B[4], c.A[4]]);
    const shift = Math.hypot((a.cx - b.cx) * aspect, a.cy - b.cy), r = (b.w * b.h) / Math.max(1e-6, a.w * a.h);
    return shift > 0.8 * Math.max(a.w, a.h) || r > 3 || r < 1 / 3;
  }
  _ribbon(aspect) {
    const len = dist(this._p[0], this._p[1], aspect);
    if (!this.ribbonLen0) { this.ribbonLen0 = Math.max(len, 1e-3); this.pinchStart = [{ ...this._p[0] }, { ...this._p[1] }]; }
    this.moved = [0, 1].map((i) => dist(this._p[i], this.pinchStart[i], aspect)); // which hand pulled away
    this.stretch = len / this.ribbonLen0; this.pinch = this._p;
  }
}
