// The 12 effects. Each renders onto the output canvas using face landmark geometry.
import { IDX } from './face.js';

/* ---------- helpers ---------- */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const _bufs = {};
/** Reusable offscreen canvas; grows but never shrinks (avoids per-frame allocation). */
function buf(name, w, h) {
  let b = _bufs[name];
  if (!b) { const c = document.createElement('canvas'); c.width = 2; c.height = 2; b = _bufs[name] = { c, ctx: c.getContext('2d') }; }
  w = Math.max(1, Math.ceil(w)); h = Math.max(1, Math.ceil(h));
  if (b.c.width < w || b.c.height < h) { b.c.width = Math.max(w, b.c.width); b.c.height = Math.max(h, b.c.height); }
  return b;
}
/** Copy a region of src into a buffer at 0,0. */
function grab(name, src, r) {
  const b = buf(name, r.w, r.h);
  b.ctx.globalCompositeOperation = 'copy'; b.ctx.globalAlpha = 1; b.ctx.filter = 'none';
  b.ctx.imageSmoothingEnabled = true;
  b.ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  b.ctx.globalCompositeOperation = 'source-over';
  return b;
}
const _r = { x: 0, y: 0, w: 0, h: 0 };
/** Integer rect clamped to the canvas; returns null when empty. */
function rect(x, y, w, h, W, H, out = _r) {
  const x0 = clamp(Math.floor(x), 0, W), y0 = clamp(Math.floor(y), 0, H);
  const x1 = clamp(Math.ceil(x + w), 0, W), y1 = clamp(Math.ceil(y + h), 0, H);
  out.x = x0; out.y = y0; out.w = x1 - x0; out.h = y1 - y0;
  return out.w > 1 && out.h > 1 ? out : null;
}
function faceRect(F, scale, W, H, pad = 0) {
  const w = F.w * scale + pad * 2, h = F.h * scale + pad * 2;
  return rect(F.cx - w / 2, F.cy - h / 2, w, h, W, H);
}
function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Reseedable RNG reused every frame (no per-frame closure allocation). */
const RNG = { a: 0, seed(v) { this.a = v | 0; return this; }, next() { let a = (this.a = (this.a + 0x6d2b79f5) | 0); let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; } };
const _bb = [{}, {}], _bar = { x: 0, y: 0, w: 0, h: 0 };
export function hexToHue(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  if (!m) return 0;
  const r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}
const hsl = (h, s = 100, l = 58, a = 1) => `hsla(${((h % 360) + 360) % 360},${s}%,${l}%,${a})`;

/** Pixelate region r of ctx.canvas, drawing through the current clip. */
function pixelate(ctx, r, block) {
  const sw = Math.max(1, Math.round(r.w / block)), sh = Math.max(1, Math.round(r.h / block));
  const b = buf('pix', sw, sh);
  b.ctx.globalCompositeOperation = 'copy'; b.ctx.imageSmoothingEnabled = true; b.ctx.imageSmoothingQuality = 'medium';
  b.ctx.drawImage(ctx.canvas, r.x, r.y, r.w, r.h, 0, 0, sw, sh);
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(b.c, 0, 0, sw, sh, r.x, r.y, r.w, r.h);
  ctx.imageSmoothingEnabled = prev;
}

/** Does this browser support ctx.filter (Safari < 18 did not)? */
export const FILTER_OK = (() => {
  try { const c = document.createElement('canvas').getContext('2d'); c.filter = 'blur(2px)'; return c.filter === 'blur(2px)'; } catch { return false; }
})();

/* ---------- parameter definitions ---------- */
const P = {
  // the dock shows "%" only for parameters that really are a percentage
  intensity: (def = 60, label = 'Intensity') => ({ key: 'intensity', label, type: 'range', min: 0, max: 100, step: 1, def, unit: ['Intensity', 'Strength', 'Color strength', 'Noise amount', 'Mesh brightness', 'Glow'].includes(label) ? '%' : '' }),
  opacity: (def = 100) => ({ key: 'opacity', label: 'Opacity', type: 'range', min: 5, max: 100, step: 1, def, unit: '%' }),
  speed: (def = 50, label = 'Speed') => ({ key: 'speed', label, type: 'range', min: 0, max: 100, step: 1, def, unit: '' }),
  anim: (def = 50) => ({ key: 'anim', label: 'Animation speed', type: 'range', min: 0, max: 100, step: 1, def, unit: '' }),
  size: (def = 50, label = 'Size', min = 0, max = 100) => ({ key: 'size', label, type: 'range', min, max, step: 1, def, unit: '' }),
  color: (def) => ({ key: 'color', label: 'Color', type: 'color', def }),
  select: (key, label, options, def) => ({ key, label, type: 'select', options, def }),
  toggle: (key, label, def) => ({ key, label, type: 'toggle', def }),
  num: (key, label, min, max, def) => ({ key, label, type: 'range', min, max, step: 1, def, unit: '' }),
};

/* ---------- static data ---------- */
const SHAPES = (() => { const r = mulberry32(7); return Array.from({ length: 40 }, () => ({ a: r() * TAU, y: (r() - 0.5) * 1.3, s: 0.6 + r() * 0.8, n: [3, 3, 3, 4, 6][Math.floor(r() * 5)], rot: r() * TAU, spin: (r() - 0.5) * 3, dir: r() < 0.8 ? 1 : -1, ring: 0.85 + r() * 0.4, hue: r() * 40 - 20 })); })();
let NOISE = null;
function noiseTiles() {
  if (NOISE) return NOISE;
  const r = mulberry32(99); NOISE = [];
  for (let k = 0; k < 6; k++) {
    const c = document.createElement('canvas'); c.width = c.height = 160;
    const x = c.getContext('2d'), img = x.createImageData(160, 160), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const v = (r() * 255) | 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    x.putImageData(img, 0, 0); NOISE.push({ c, pat: null });
  }
  const s = document.createElement('canvas'); s.width = 1; s.height = 4;
  const sx = s.getContext('2d'); sx.fillStyle = 'rgba(0,0,0,0.55)'; sx.fillRect(0, 0, 1, 2);
  NOISE.scan = s;
  return NOISE;
}

/* ---------- effects ---------- */
export const EFFECTS = [
  {
    id: 'pixelate', name: 'Face Pixelation', short: 'Pixel', glyph: '▦', needsFace: true, hasColor: false,
    params: [P.intensity(55, 'Block size'), P.size(100, 'Mask size', 70, 150), P.opacity(100), P.select('shape', 'Shape', [['oval', 'Face oval'], ['box', 'Box']], 'oval')],
    render(ctx, F, e, s) {
      const sc = s.size / 100, r = faceRect(F, sc, e.W, e.H, 2); if (!r) return;
      const block = Math.max(2, F.w * (0.015 + 0.12 * s.intensity / 100) * (1 + e.burst * 0.8));
      ctx.save(); ctx.globalAlpha = s.opacity / 100;
      if (s.shape === 'box') { ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); } else F.path(ctx, IDX.oval, true, sc);
      ctx.clip(); pixelate(ctx, r, block); ctx.restore();
    },
  },
  {
    id: 'eyePixel', name: 'Eye Pixelation', short: 'Eyes', glyph: '◫', needsFace: true, hasColor: false,
    params: [P.intensity(70, 'Block size'), P.size(50, 'Region size'), P.opacity(100), P.select('shape', 'Shape', [['eyes', 'Each eye'], ['bar', 'Censor bar']], 'eyes')],
    render(ctx, F, e, s) {
      const sz = 0.6 + s.size / 50 * 0.6; // 0.6..1.8
      const ax = F.x(33), ay = F.y(33), bx = F.x(263), by = F.y(263);
      const dist = Math.hypot(bx - ax, by - ay), ang = Math.atan2(by - ay, bx - ax);
      const block = Math.max(3, dist * (0.05 + 0.22 * s.intensity / 100) * (1 + e.burst));
      ctx.save(); ctx.globalAlpha = s.opacity / 100; ctx.beginPath();
      let r;
      if (s.shape === 'bar') {
        const mx = (ax + bx) / 2, my = (ay + by) / 2, hw = dist * (0.75 + 0.35 * sz), hh = dist * 0.22 * sz;
        const c = Math.cos(ang), si = Math.sin(ang);
        const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [mx + x * c - y * si, my + x * si + y * c]);
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
        const ext = Math.hypot(hw, hh);
        r = rect(mx - ext, my - ext, ext * 2, ext * 2, e.W, e.H);
      } else {
        let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        for (let q = 0; q < 2; q++) {
          const b = F.bbox(q ? IDX.eyeL : IDX.eyeR, 0, _bb[q]); const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
          const rx = Math.max(b.w, dist * 0.3) * 0.62 * sz, ry = Math.max(b.h * 2.2, dist * 0.2) * 0.62 * sz;
          ctx.moveTo(cx + rx, cy); ctx.ellipse(cx, cy, rx, ry, ang, 0, TAU);
          minX = Math.min(minX, cx - rx); maxX = Math.max(maxX, cx + rx); minY = Math.min(minY, cy - Math.max(rx, ry)); maxY = Math.max(maxY, cy + Math.max(rx, ry));
        }
        r = rect(minX, minY, maxX - minX, maxY - minY, e.W, e.H);
      }
      if (r) { ctx.clip(); pixelate(ctx, r, block); }
      ctx.restore();
    },
  },
  {
    id: 'blur', name: 'Face Blur', short: 'Blur', glyph: '◌', needsFace: true, hasColor: false,
    params: [P.intensity(60, 'Blur amount'), P.size(100, 'Mask size', 70, 150), P.opacity(100)],
    render(ctx, F, e, s) {
      const sc = s.size / 100;
      const radius = Math.max(1, (1 + 24 * s.intensity / 100) * (F.w / 220) * (1 + e.burst));
      const r = faceRect(F, sc, e.W, e.H, radius * 2); if (!r) return;
      const src = grab('blurSrc', ctx.canvas, r);
      ctx.save(); ctx.globalAlpha = s.opacity / 100; F.path(ctx, IDX.oval, true, sc); ctx.clip();
      if (FILTER_OK && !e.forceManualBlur) {
        ctx.filter = `blur(${radius.toFixed(1)}px)`;
        ctx.drawImage(src.c, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
        ctx.filter = 'none';
      } else {
        // Fallback: two-step downscale / upscale blur (Safari without ctx.filter)
        const f = Math.max(2, radius / 1.2);
        const w1 = Math.max(1, Math.round(r.w / f)), h1 = Math.max(1, Math.round(r.h / f));
        const a = buf('blurA', w1, h1), b = buf('blurB', Math.max(1, w1 >> 1), Math.max(1, h1 >> 1));
        a.ctx.globalCompositeOperation = b.ctx.globalCompositeOperation = 'copy';
        a.ctx.imageSmoothingEnabled = b.ctx.imageSmoothingEnabled = true;
        a.ctx.drawImage(src.c, 0, 0, r.w, r.h, 0, 0, w1, h1);
        b.ctx.drawImage(a.c, 0, 0, w1, h1, 0, 0, Math.max(1, w1 >> 1), Math.max(1, h1 >> 1));
        a.ctx.drawImage(b.c, 0, 0, Math.max(1, w1 >> 1), Math.max(1, h1 >> 1), 0, 0, w1, h1);
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(a.c, 0, 0, w1, h1, r.x, r.y, r.w, r.h);
      }
      ctx.restore();
    },
  },
  {
    id: 'glitch', name: 'RGB Glitch', short: 'Glitch', glyph: '≋', needsFace: false, hasColor: false,
    params: [P.intensity(55, 'Channel offset'), P.speed(55, 'Glitch rate'), P.size(40, 'Slice height'), P.select('area', 'Area', [['face', 'Face'], ['full', 'Full frame']], 'face'), P.opacity(100)],
    render(ctx, F, e, s) {
      const r = s.area === 'face' && F ? faceRect(F, 1.35, e.W, e.H) : rect(0, 0, e.W, e.H, e.W, e.H); if (!r) return;
      const i = s.intensity / 100, rate = 2 + s.speed / 6;
      const tick = Math.floor(e.t * rate); RNG.seed(tick * 7919 + 13 + Math.round(F ? F.cx : 0)); const rnd = () => RNG.next();
      const active = e.burst > 0.05 || rnd() < 0.35 + s.speed / 160;
      const dx = Math.round((2 + e.W * 0.016 * i) * (active ? 1 + rnd() : 0.6) * (1 + e.burst * 2));
      const src = grab('glA', ctx.canvas, r);
      const out = buf('glOut', r.w + dx * 2, r.h);
      const ch = ['#ff0000', '#00ff00', '#0000ff'], offs = [-dx, 0, dx];
      const o = out.ctx; o.globalCompositeOperation = 'source-over'; o.fillStyle = '#000'; o.fillRect(0, 0, r.w, r.h);
      for (let k = 0; k < 3; k++) {
        const cb = buf('glC' + k, r.w, r.h);
        cb.ctx.globalCompositeOperation = 'copy'; cb.ctx.drawImage(src.c, 0, 0, r.w, r.h, 0, 0, r.w, r.h);
        cb.ctx.globalCompositeOperation = 'multiply'; cb.ctx.fillStyle = ch[k]; cb.ctx.fillRect(0, 0, r.w, r.h);
        o.globalCompositeOperation = 'lighter';
        o.drawImage(cb.c, 0, 0, r.w, r.h, offs[k], k === 1 ? 0 : Math.round(offs[k] * 0.15), r.w, r.h);
      }
      o.globalCompositeOperation = 'source-over';
      ctx.save(); ctx.globalAlpha = s.opacity / 100;
      if (s.area === 'face' && F) F.path(ctx, IDX.oval, true, 1.18); else { ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); }
      ctx.clip();
      ctx.drawImage(out.c, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
      if (active) {
        const n = 2 + Math.round(8 * i);
        for (let k = 0; k < n; k++) {
          const sh = Math.max(2, Math.round(r.h * (0.01 + 0.09 * s.size / 100) * (0.4 + rnd())));
          const sy = Math.floor(rnd() * (r.h - sh));
          const shift = Math.round((rnd() - 0.5) * dx * 6);
          ctx.drawImage(out.c, 0, sy, r.w, sh, r.x + shift, r.y + sy, r.w, sh);
        }
        // a few digital blocks
        ctx.globalCompositeOperation = 'difference';
        for (let k = 0; k < Math.round(3 * i); k++) {
          ctx.fillStyle = ch[k % 3];
          ctx.fillRect(r.x + rnd() * r.w, r.y + rnd() * r.h, r.w * (0.05 + rnd() * 0.2), Math.max(2, r.h * 0.02 * rnd()));
        }
      }
      ctx.restore();
    },
  },
  {
    id: 'neon', name: 'Neon Face', short: 'Neon', glyph: '◎', needsFace: true, hasColor: true,
    params: [P.intensity(70, 'Glow'), P.size(40, 'Line width'), P.color('#ff2bd6'), P.toggle('rainbow', 'Rainbow cycle', true), P.anim(45), P.select('detail', 'Detail', [['full', 'Full face'], ['outline', 'Outline only']], 'full'), P.opacity(100)],
    render(ctx, F, e, s) {
      const base = hexToHue(s.color), cyc = s.rainbow ? e.t * (10 + s.anim * 2.5) : 0;
      const pulse = 0.8 + 0.2 * Math.sin(e.t * (1 + s.anim / 12));
      const k = F.w / 300, lw = Math.max(1.5, k * (1.5 + s.size / 12));
      const glow = (4 + 40 * s.intensity / 100) * k * pulse * (1 + e.burst * 1.5);
      const groups = s.detail === 'outline' ? [[IDX.oval]] : [[IDX.oval], [IDX.eyeR, IDX.eyeL, IDX.browR, IDX.browL], [IDX.lips, IDX.nose]];
      ctx.save(); ctx.globalAlpha = s.opacity / 100; ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      groups.forEach((g, gi) => {
        const c = hsl(base + cyc + gi * (s.rainbow ? 110 : 0), 100, 60);
        ctx.beginPath();
        for (const idx of g) F.path(ctx, idx, idx !== IDX.nose && idx !== IDX.browR && idx !== IDX.browL, 1, false);
        ctx.shadowBlur = glow; ctx.shadowColor = c; ctx.strokeStyle = c; ctx.lineWidth = lw * 2; ctx.stroke();
        ctx.shadowBlur = glow * 0.4; ctx.lineWidth = lw * 3.5; ctx.globalAlpha = s.opacity / 100 * 0.35; ctx.stroke();
        ctx.globalAlpha = s.opacity / 100; ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = lw * 0.6; ctx.stroke();
      });
      ctx.restore();
    },
  },
  {
    id: 'geometric', name: 'Geometric Mask', short: 'Geo', glyph: '△', needsFace: true, hasColor: true,
    params: [P.intensity(55, 'Orbit radius'), P.num('count', 'Shapes', 4, 40, 16), P.size(50, 'Shape size'), P.speed(45, 'Orbit speed'), P.color('#ff4fd8'), P.select('style', 'Style', [['mixed', 'Mixed'], ['outline', 'Outline'], ['filled', 'Filled']], 'mixed'), P.opacity(95)],
    render(ctx, F, e, s) {
      const R = F.w * (0.55 + 0.6 * s.intensity / 100) * (1 + e.burst * 0.6);
      const cr = Math.cos(F.roll), sr = Math.sin(F.roll), base = hexToHue(s.color);
      const n = Math.min(SHAPES.length, s.count | 0), sp = 0.15 + s.speed / 40;
      const lw = Math.max(1.5, F.w / 80);
      ctx.save(); ctx.lineJoin = 'round'; ctx.lineWidth = lw;
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 0; k < n; k++) {
          const sh = SHAPES[k];
          const th = sh.a + e.t * sp * sh.dir + F.yaw * 0.9;
          const z = Math.sin(th);
          if ((pass === 0) !== (z < 0)) continue;
          const lx = Math.cos(th) * R * sh.ring;
          const ly = sh.y * F.h * 0.75 + z * R * 0.16 + Math.sin(e.t * 1.3 + sh.a) * F.h * 0.04 - F.pitch * F.h * 0.1;
          const x = F.cx + lx * cr - ly * sr, y = F.cy + lx * sr + ly * cr;
          const ds = 0.75 + 0.3 * z, rr = F.w * 0.1 * (0.3 + s.size / 50) * sh.s * ds * (1 + e.burst * 0.5);
          const rot = sh.rot + e.t * sh.spin * (0.2 + s.speed / 50);
          ctx.beginPath();
          for (let v = 0; v <= sh.n; v++) { const a = rot + (v / sh.n) * TAU; const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr; v ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
          ctx.closePath();
          const alpha = (s.opacity / 100) * (z < 0 ? 0.35 : 1);
          const col = hsl(base + sh.hue, 95, 62, alpha);
          const fill = s.style === 'filled' || (s.style === 'mixed' && k % 3 === 0);
          if (fill) { ctx.fillStyle = hsl(base + sh.hue, 95, 60, alpha * 0.55); ctx.fill(); }
          ctx.strokeStyle = col; ctx.shadowBlur = z > 0 ? F.w / 25 * (1 + e.burst * 2) : 0; ctx.shadowColor = col; ctx.stroke();
        }
      }
      ctx.restore();
    },
  },
  {
    id: 'laser', name: 'Laser Eyes', short: 'Laser', glyph: '⟿', needsFace: true, hasColor: true,
    params: [P.intensity(70, 'Glow'), P.size(45, 'Beam width'), P.num('length', 'Beam length', 0, 100, 70), P.color('#ff2a1a'), P.speed(50, 'Flicker speed'), P.opacity(100)],
    render(ctx, F, e, s) {
      let vx = (F.x(1) - F.cx) / F.w * 3.2, vy = (F.y(1) - F.cy) / F.h * 3.2 + 0.3;
      const vl = Math.hypot(vx, vy) || 1; vx /= vl; vy /= vl;
      const t = e.t * (1 + s.speed / 10);
      const flick = 0.82 + 0.12 * Math.sin(t * 3.1) + 0.06 * Math.sin(t * 7.7);
      const L = e.W * (0.08 + 0.9 * s.length / 100) * (1 + e.burst * 0.8);
      const eyeDist = Math.hypot(F.x(263) - F.x(33), F.y(263) - F.y(33));
      const bw = eyeDist * 0.06 * (0.4 + s.size / 40) * (1 + e.burst * 1.2) * flick;
      const hue = hexToHue(s.color), col = (a) => hsl(hue, 100, 55, a);
      const nx = -vy, ny = vx;
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = s.opacity / 100;
      for (const w of ['R', 'L']) {
        const c = F.irisCenter(w, w === 'R' ? (this._a ||= {}) : (this._b ||= {}));
        const ex = c.x + vx * L, ey = c.y + vy * L;
        // beam body
        const g = ctx.createLinearGradient(c.x, c.y, ex, ey);
        g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.06, col(0.9)); g.addColorStop(1, col(0));
        ctx.fillStyle = g; ctx.beginPath();
        ctx.moveTo(c.x + nx * bw * 0.5, c.y + ny * bw * 0.5); ctx.lineTo(ex + nx * bw * 2.6, ey + ny * bw * 2.6);
        ctx.lineTo(ex - nx * bw * 2.6, ey - ny * bw * 2.6); ctx.lineTo(c.x - nx * bw * 0.5, c.y - ny * bw * 0.5); ctx.closePath(); ctx.fill();
        // hot core
        const g2 = ctx.createLinearGradient(c.x, c.y, ex, ey);
        g2.addColorStop(0, 'rgba(255,255,255,0.9)'); g2.addColorStop(0.6, 'rgba(255,255,255,0)');
        ctx.fillStyle = g2; ctx.beginPath();
        ctx.moveTo(c.x + nx * bw * 0.18, c.y + ny * bw * 0.18); ctx.lineTo(ex + nx * bw * 0.5, ey + ny * bw * 0.5);
        ctx.lineTo(ex - nx * bw * 0.5, ey - ny * bw * 0.5); ctx.lineTo(c.x - nx * bw * 0.18, c.y - ny * bw * 0.18); ctx.closePath(); ctx.fill();
        // iris glow + flare
        const gr = eyeDist * (0.12 + 0.25 * s.intensity / 100) * flick * (1 + e.burst);
        const rg = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, gr);
        rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.25, col(0.9)); rg.addColorStop(1, col(0));
        ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(c.x, c.y, gr, 0, TAU); ctx.fill();
        ctx.fillStyle = col(0.35 * s.intensity / 100 * flick);
        ctx.beginPath(); ctx.ellipse(c.x, c.y, gr * 2.4, gr * 0.12, F.roll, 0, TAU); ctx.fill();
      }
      ctx.restore();
    },
  },
  {
    id: 'colorSplit', name: 'Color Split', short: 'Split', glyph: '◑', needsFace: true, hasColor: true,
    params: [P.intensity(65, 'Color strength'), P.num('sections', 'Sections', 2, 8, 4), P.select('mode', 'Layout', [['stripes', 'Vertical stripes'], ['bands', 'Horizontal bands'], ['pie', 'Pie sectors']], 'stripes'), P.color('#ff3b6b'), P.anim(30), P.select('blend', 'Blend', [['color', 'Color'], ['overlay', 'Overlay'], ['screen', 'Screen']], 'color'), P.opacity(100)],
    render(ctx, F, e, s) {
      const n = s.sections | 0, base = hexToHue(s.color), R = Math.max(F.w, F.h) * 0.75;
      ctx.save(); F.path(ctx, IDX.oval, true, 1.03); ctx.clip();
      ctx.globalCompositeOperation = s.blend; ctx.globalAlpha = (0.15 + 0.85 * s.intensity / 100) * (s.opacity / 100) * (1 - e.burst * 0.3);
      ctx.translate(F.cx, F.cy); ctx.rotate(F.roll);
      const sw = (2 * R) / n, off = ((e.t * s.anim * 0.02 + e.burst) * sw) % (sw * n);
      if (s.mode === 'pie') {
        const rot = e.t * s.anim * 0.03;
        for (let i = 0; i < n; i++) { ctx.fillStyle = hsl(base + (i * 360) / n, 100, 55); ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R * 1.5, rot + (i / n) * TAU, rot + ((i + 1) / n) * TAU); ctx.closePath(); ctx.fill(); }
      } else {
        for (let i = -n; i < n * 2; i++) {
          const p = -R + i * sw + off; if (p > R || p + sw < -R) continue;
          ctx.fillStyle = hsl(base + ((((i % n) + n) % n) * 360) / n, 100, 55);
          if (s.mode === 'bands') ctx.fillRect(-R, p, 2 * R, sw + 0.5); else ctx.fillRect(p, -R, sw + 0.5, 2 * R);
        }
      }
      ctx.restore();
    },
  },
  {
    id: 'static', name: 'Digital Static', short: 'Static', glyph: '░', needsFace: false, hasColor: true,
    params: [P.intensity(40, 'Noise amount'), P.size(25, 'Grain size'), P.speed(70, 'Flicker speed'), P.select('area', 'Area', [['full', 'Full frame'], ['face', 'Face only']], 'full'), P.toggle('scanlines', 'Scanlines', true), P.color('#ffffff'), P.opacity(100)],
    render(ctx, F, e, s) {
      const T = noiseTiles(), rate = 4 + s.speed / 2.5, tick = Math.floor(e.t * rate);
      RNG.seed(tick * 31 + 5); const rnd = () => RNG.next(); const tile = T[tick % T.length];
      if (!tile.pat) tile.pat = ctx.createPattern(tile.c, 'repeat');
      const a = Math.min(1, (0.05 + 0.75 * s.intensity / 100 + e.burst * 0.6)) * (s.opacity / 100);
      const g = 1 + s.size / 20;
      ctx.save();
      if (s.area === 'face') { if (!F) { ctx.restore(); return; } F.path(ctx, IDX.oval, true, 1.08); ctx.clip(); }
      ctx.globalAlpha = a;
      ctx.save(); ctx.translate(-rnd() * 160 * g, -rnd() * 160 * g); ctx.scale(g, g);
      ctx.fillStyle = tile.pat; ctx.fillRect(0, 0, e.W / g + 320, e.H / g + 320); ctx.restore();
      if (s.color.toLowerCase() !== '#ffffff') { ctx.globalCompositeOperation = 'color'; ctx.globalAlpha = a * 0.8; ctx.fillStyle = s.color; ctx.fillRect(0, 0, e.W, e.H); ctx.globalCompositeOperation = 'source-over'; }
      // rolling bar
      const by = ((e.t * (0.15 + s.speed / 300)) % 1.3 - 0.15) * e.H;
      const gr = ctx.createLinearGradient(0, by - e.H * 0.08, 0, by + e.H * 0.08);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.18)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = s.opacity / 100; ctx.fillStyle = gr; ctx.fillRect(0, by - e.H * 0.08, e.W, e.H * 0.16);
      if (s.scanlines) { if (!T.scanPat) T.scanPat = ctx.createPattern(T.scan, 'repeat'); ctx.globalAlpha = 0.5 * (s.opacity / 100); ctx.fillStyle = T.scanPat; ctx.fillRect(0, 0, e.W, e.H); }
      ctx.restore();
    },
  },
  {
    id: 'scanner', name: 'Face Scanner', short: 'Scan', glyph: '⌖', needsFace: true, hasColor: true,
    params: [P.intensity(55, 'Mesh brightness'), P.speed(40, 'Scan speed'), P.size(50, 'HUD size'), P.color('#8ff7ff'), P.toggle('mesh', 'Show mesh', true), P.toggle('hud', 'Show HUD text', true), P.opacity(90)],
    render(ctx, F, e, s) {
      const k = F.w / 300, op = s.opacity / 100, col = s.color;
      ctx.save(); ctx.strokeStyle = col; ctx.fillStyle = col;
      if (s.mesh && e.tess) {
        ctx.globalAlpha = (0.08 + 0.45 * s.intensity / 100) * op; ctx.lineWidth = Math.max(0.5, 0.6 * k);
        ctx.beginPath(); const t = e.tess, p = F.pts, n = F.n;
        for (let i = 0; i < t.length; i += 2) { const a = t[i], b = t[i + 1]; if (a >= n || b >= n) continue; ctx.moveTo(p[a * 2], p[a * 2 + 1]); ctx.lineTo(p[b * 2], p[b * 2 + 1]); }
        ctx.stroke();
      }
      // scan sweep
      const period = 3 - 2.4 * s.speed / 100;
      const ph = (((e.t - (e.burstStart || 0)) / period) % 1 + 1) % 1;
      const top = F.minY - F.h * 0.1, sy = top + ph * F.h * 1.2, band = F.h * 0.07;
      ctx.save(); F.path(ctx, IDX.oval, true, 1.06); ctx.clip();
      const g = ctx.createLinearGradient(0, sy - band * 3, 0, sy + band * 0.3);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.85, col); g.addColorStop(1, 'rgba(255,255,255,0.95)');
      ctx.globalAlpha = 0.35 * op; ctx.fillStyle = g; ctx.fillRect(F.minX - 20, sy - band * 3, F.w + 40, band * 3.3);
      ctx.restore();
      ctx.globalAlpha = op; ctx.lineWidth = Math.max(1, 1.5 * k);
      ctx.beginPath(); ctx.moveTo(F.minX - F.w * 0.15, sy); ctx.lineTo(F.maxX + F.w * 0.15, sy); ctx.stroke();
      ctx.fillStyle = '#ffffff'; const p = F.pts, dsz = Math.max(1.5, 2 * k);
      for (let i = 0; i < F.n; i += 2) { const y = p[i * 2 + 1]; if (Math.abs(y - sy) < band) ctx.fillRect(p[i * 2] - dsz / 2, y - dsz / 2, dsz, dsz); }
      // corner brackets
      const pad = F.w * 0.15, x0 = F.minX - pad, y0 = F.minY - pad, x1 = F.maxX + pad, y1 = F.maxY + pad;
      const bl = F.w * 0.12 * (0.5 + s.size / 50), pulse = 1 + 0.04 * Math.sin(e.t * 4) + e.burst * 0.1;
      ctx.strokeStyle = col; ctx.lineWidth = Math.max(1.5, 2.5 * k);
      ctx.save(); ctx.translate(F.cx, F.cy); ctx.scale(pulse, pulse); ctx.translate(-F.cx, -F.cy);
      ctx.beginPath();
      ctx.moveTo(x0, y0 + bl); ctx.lineTo(x0, y0); ctx.lineTo(x0 + bl, y0);
      ctx.moveTo(x1 - bl, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + bl);
      ctx.moveTo(x1, y1 - bl); ctx.lineTo(x1, y1); ctx.lineTo(x1 - bl, y1);
      ctx.moveTo(x0 + bl, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - bl);
      ctx.stroke(); ctx.restore();
      if (s.hud) {
        const fs = Math.max(10, Math.round(11 * k * (0.6 + s.size / 60)));
        ctx.font = `600 ${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`; ctx.fillStyle = col; ctx.textBaseline = 'bottom';
        const deg = (v) => Math.round(v);
        ctx.fillText(e.burst > 0.05 ? 'RESCANNING…' : 'FACE LOCK', x0, y0 - fs * 0.4);
        ctx.textBaseline = 'top';
        ctx.fillText(`YAW ${deg(F.yaw * 45)}°  PITCH ${deg(F.pitch * 30)}°  ROLL ${deg(F.roll * 57.3)}°`, x0, y1 + fs * 0.4);
        ctx.fillText(`${F.n} PTS · ${Math.round(e.fps)} FPS`, x0, y1 + fs * 1.7);
      }
      ctx.restore();
    },
  },
  {
    id: 'mirror', name: 'Mirror Distortion', short: 'Warp', glyph: '⧖', needsFace: true, hasColor: false,
    params: [P.intensity(50, 'Distortion'), P.size(50, 'Wavelength'), P.speed(50, 'Speed'), P.select('mode', 'Mode', [['wave', 'Wave'], ['ripple', 'Ripple'], ['mirror', 'Mirror']], 'wave'), P.opacity(100)],
    render(ctx, F, e, s) {
      const r = faceRect(F, 1.3, e.W, e.H); if (!r) return;
      const src = grab('mirSrc', ctx.canvas, r);
      const i = s.intensity / 100, sp = 0.5 + s.speed / 12;
      // Warp into an offscreen buffer (same size as the region), then blend it back through a
      // soft elliptical mask so there is no hard seam at the edge of the face.
      const out = buf('mirOut', r.w, r.h), o = out.ctx;
      const lr = (this.lastRect ||= {}); lr.x = r.x; lr.y = r.y; lr.w = r.w; lr.h = r.h; lr.fy = F.cy - r.y;
      o.setTransform(1, 0, 0, 1, 0, 0); o.globalCompositeOperation = 'copy';
      o.drawImage(src.c, 0, 0, r.w, r.h, 0, 0, r.w, r.h);
      o.globalCompositeOperation = 'source-over';
      if (s.mode === 'mirror') {
        const axis = F.cx - r.x + Math.sin(e.t * sp * 0.4) * F.w * 0.22 * i;
        const lw = Math.max(1, Math.round(axis));
        o.save(); o.beginPath(); o.rect(axis, 0, r.w, r.h); o.clip();
        o.translate(axis * 2, 0); o.scale(-1, 1);
        o.drawImage(src.c, 0, 0, lw, r.h, 0, 0, lw, r.h); o.restore();
      } else {
        const strip = Math.max(2, Math.round(e.H / 240));
        const amp = F.w * 0.14 * i * (1 + e.burst), wl = F.h * (0.12 + 0.6 * s.size / 100);
        const ph = e.t * sp;
        if (s.mode === 'ripple') {
          for (let x = 0; x < r.w; x += strip) { const dy = amp * 0.7 * Math.sin((x / wl) * TAU + ph); o.drawImage(src.c, x, 0, strip + 1, r.h, x, dy, strip + 1, r.h); }
        } else {
          for (let y = 0; y < r.h; y += strip) { const env = Math.sin((y / r.h) * Math.PI); const dx = amp * env * Math.sin((y / wl) * TAU + ph); o.drawImage(src.c, 0, y, r.w, strip + 1, dx, y, r.w, strip + 1); }
        }
      }
      // feathered elliptical mask (opaque centre → transparent edge), rotated with the head
      o.globalCompositeOperation = 'destination-in';
      o.save(); o.translate(F.cx - r.x, F.cy - r.y); o.rotate(F.roll); o.scale(F.w * 0.62, F.h * 0.66);
      if (!_bufs._mirGrad) { const g = o.createRadialGradient(0, 0, 0, 0, 0, 1); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.72, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)'); _bufs._mirGrad = g; }
      o.fillStyle = _bufs._mirGrad; o.fillRect(-2, -2, 4, 4); o.restore();
      o.globalCompositeOperation = 'source-over';
      ctx.save(); ctx.globalAlpha = s.opacity / 100;
      ctx.drawImage(out.c, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
      ctx.restore();
    },
  },
  {
    id: 'colorFlash', name: 'Color Flash', short: 'Flash', glyph: '✺', needsFace: false, hasColor: true,
    params: [P.intensity(45, 'Strength'), P.speed(45, 'Speed'), P.select('mode', 'Mode', [['cycle', 'Smooth RGB cycle'], ['rgb', 'R / G / B steps'], ['strobe', 'Strobe']], 'cycle'), P.color('#ff0040'), P.select('area', 'Area', [['full', 'Full frame'], ['face', 'Face only']], 'full'), P.select('blend', 'Blend', [['overlay', 'Overlay'], ['screen', 'Screen'], ['color', 'Color']], 'overlay'), P.opacity(100)],
    render(ctx, F, e, s) {
      const base = hexToHue(s.color), sp = s.speed / 10;
      let hue = base, a = 0.1 + 0.9 * s.intensity / 100;
      if (s.mode === 'cycle') { hue = base + e.t * sp * 40; a *= 0.7 + 0.3 * Math.abs(Math.sin(e.t * sp)); }
      else if (s.mode === 'rgb') hue = [0, 120, 240][Math.floor(e.t * sp * 1.5) % 3];
      else if (!e.reduced && Math.floor(e.t * sp * 2) % 2) a *= 0.08;
      ctx.save();
      if (s.area === 'face') { if (!F) { ctx.restore(); return; } F.path(ctx, IDX.oval, true, 1.1); ctx.clip(); }
      ctx.globalCompositeOperation = s.blend; ctx.globalAlpha = Math.min(1, a) * (s.opacity / 100);
      ctx.fillStyle = hsl(hue, 100, 50); ctx.fillRect(0, 0, e.W, e.H);
      if (e.burst > 0.02 && !e.reduced) { ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = e.burst * 0.7; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, e.W, e.H); }
      ctx.restore();
    },
  },
];

/** Test helper: read a reusable offscreen buffer by name. */
export const getBuffer = (name) => _bufs[name]?.c || null;
export const EFFECT_MAP = Object.fromEntries(EFFECTS.map((f) => [f.id, f]));
/** Render order: pixel-processing effects first, overlays last. */
export const RENDER_ORDER = ['mirror', 'blur', 'pixelate', 'eyePixel', 'glitch', 'colorSplit', 'colorFlash', 'static', 'neon', 'scanner', 'geometric', 'laser'];
export function defaultSettings(id) { const o = {}; for (const p of EFFECT_MAP[id].params) o[p.key] = p.def; return o; }
