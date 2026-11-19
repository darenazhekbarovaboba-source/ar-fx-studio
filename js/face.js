// Face geometry from MediaPipe Face Landmarker (478 landmarks incl. irises).
export const IDX = {
  oval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  eyeR: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  eyeL: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  browR: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  browL: [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],
  lips: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
  lipsInner: [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191],
  nose: [168, 6, 197, 195, 5, 4, 1],
  noseBase: [98, 97, 2, 326, 327],
  irisR: 468, irisL: 473,
};

/** Mutable face geometry, reused every frame (no per-frame allocation). */
export class Face {
  constructor() {
    this.pts = new Float32Array(478 * 2);
    this.n = 0; this.valid = false;
    this.minX = 0; this.minY = 0; this.maxX = 0; this.maxY = 0;
    this.cx = 0; this.cy = 0; this.w = 0; this.h = 0;
    this.roll = 0; this.yaw = 0; this.pitch = 0;
  }
  update(lm, W, H, mirror) {
    const n = Math.min(lm.length, 478); this.n = n;
    const p = this.pts;
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (let i = 0; i < n; i++) {
      const x = (mirror ? 1 - lm[i].x : lm[i].x) * W, y = lm[i].y * H;
      p[i * 2] = x; p[i * 2 + 1] = y;
    }
    for (const i of IDX.oval) {
      const x = p[i * 2], y = p[i * 2 + 1];
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    this.minX = minX; this.minY = minY; this.maxX = maxX; this.maxY = maxY;
    this.w = maxX - minX; this.h = maxY - minY;
    this.cx = (minX + maxX) / 2; this.cy = (minY + maxY) / 2;
    // head pose (approximate, from 2D landmark geometry)
    const ex1 = p[33 * 2], ey1 = p[33 * 2 + 1], ex2 = p[263 * 2], ey2 = p[263 * 2 + 1];
    let roll = Math.atan2(ey2 - ey1, ex2 - ex1);
    if (roll > Math.PI / 2) roll -= Math.PI; else if (roll < -Math.PI / 2) roll += Math.PI;
    this.roll = roll;
    const lx = p[234 * 2], rx = p[454 * 2];
    const nose = 1;
    const mid = (lx + rx) / 2;
    this.yaw = ((p[nose * 2] - mid) / (Math.abs(rx - lx) || 1)) * 2; // ~ -1..1
    const eyeMidY = (ey1 + ey2) / 2, chinY = p[152 * 2 + 1];
    this.pitch = ((p[nose * 2 + 1] - eyeMidY) / ((chinY - eyeMidY) || 1) - 0.42) * 3;
    this.valid = true;
    return this;
  }
  x(i) { return this.pts[i * 2]; }
  y(i) { return this.pts[i * 2 + 1]; }
  /** Trace a polyline through landmark indices, optionally scaled about the face centre. */
  path(ctx, idx, close = true, scale = 1, begin = true) {
    if (begin) ctx.beginPath();
    const cx = this.cx, cy = this.cy, p = this.pts;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const x = cx + (p[i * 2] - cx) * scale, y = cy + (p[i * 2 + 1] - cy) * scale;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    if (close) ctx.closePath();
  }
  /** Bounding box of a set of indices, expanded by factor `pad` (fraction of size). */
  bbox(idx, pad = 0, out = {}) {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9; const p = this.pts;
    for (const i of idx) { const x = p[i * 2], y = p[i * 2 + 1]; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const w = maxX - minX, h = maxY - minY, px = w * pad, py = h * pad;
    out.x = minX - px; out.y = minY - py; out.w = w + px * 2; out.h = h + py * 2;
    return out;
  }
  irisCenter(which, out = {}) {
    const i = which === 'L' ? IDX.irisL : IDX.irisR;
    if (this.n >= 478) { out.x = this.x(i); out.y = this.y(i); }
    else { const b = this.bbox(which === 'L' ? IDX.eyeL : IDX.eyeR); out.x = b.x + b.w / 2; out.y = b.y + b.h / 2; }
    return out;
  }
}
