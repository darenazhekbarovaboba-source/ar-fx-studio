// Hand Portal rendering: portal fills inside the hand quad, Blue Face, static ribbon.
// All drawing reuses offscreen buffers and pre-computed noise tiles (no per-frame canvases).
import { IDX } from './face.js';
import { EFFECT_MAP, buf, grab, pixelate, hsl, RNG } from './effects.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const _r = { x: 0, y: 0, w: 0, h: 0 };
/** Integer bounding box of points (canvas-clamped), or null when empty. */
export function quadBox(q, W, H, pad = 0, out = _r) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of q) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  x0 = clamp(Math.floor(x0 - pad), 0, W); y0 = clamp(Math.floor(y0 - pad), 0, H);
  x1 = clamp(Math.ceil(x1 + pad), 0, W); y1 = clamp(Math.ceil(y1 + pad), 0, H);
  out.x = x0; out.y = y0; out.w = x1 - x0; out.h = y1 - y0;
  return out.w > 2 && out.h > 2 ? out : null;
}
export function quadPath(ctx, q) { ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); for (let i = 1; i < q.length; i++) ctx.lineTo(q[i].x, q[i].y); ctx.closePath(); }

/* ---------- colourful TV static: tiles pre-rendered once, 1 px per cell ---------- */
const STATIC_PALETTE = [
  [0, 0, 0, 38], [255, 255, 255, 13], [255, 0, 214, 15], [0, 238, 255, 13], [255, 236, 0, 14],
  [0, 255, 70, 5], [255, 30, 40, 3], [40, 60, 255, 3],
];
// the unstretched visor in the reference is a fine, greenish/violet RGB noise (less black, less contrast)
const VISOR_PALETTE = [
  [24, 26, 24, 9], [225, 230, 225, 7], [70, 215, 95, 22], [150, 70, 215, 15], [20, 190, 210, 14],
  [225, 85, 175, 11], [235, 215, 70, 9], [50, 95, 235, 10], [120, 160, 120, 8],
];
const TILESETS = {};
export function staticTiles(kind = 'chunky') {
  if (TILESETS[kind]) return TILESETS[kind];
  const PAL = kind === 'visor' ? VISOR_PALETTE : STATIC_PALETTE;
  const N = 128, total = PAL.reduce((s, c) => s + c[3], 0);
  RNG.seed(kind === 'visor' ? 777 : 4242); const TILES = TILESETS[kind] = [];
  for (let k = 0; k < 8; k++) {
    const c = document.createElement('canvas'); c.width = c.height = N;
    const x = c.getContext('2d'), img = x.createImageData(N, N), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let r = RNG.next() * total, j = 0; while (r > PAL[j][3]) { r -= PAL[j][3]; j++; }
      const col = PAL[j]; d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
    }
    x.putImageData(img, 0, 0); TILES.push({ c, pat: null });
  }
  return TILES;
}
/** Fill the current clip (bounding box r) with animated colourful static, `cell` px per noise cell. */
function fillStatic(ctx, r, cell, t, alpha = 1, tears = true, kind = 'chunky') {
  const T = staticTiles(kind), tick = Math.floor(t * 30);
  const tile = T[tick % T.length]; if (!tile.pat) tile.pat = ctx.createPattern(tile.c, 'repeat');
  RNG.seed(tick * 977 + 3);
  const prev = ctx.imageSmoothingEnabled; ctx.imageSmoothingEnabled = false;
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.translate(r.x - RNG.next() * 128 * cell, r.y - RNG.next() * 128 * cell); ctx.scale(cell, cell);
  ctx.fillStyle = tile.pat; ctx.fillRect(0, 0, r.w / cell + 260, r.h / cell + 260);
  ctx.restore();
  ctx.imageSmoothingEnabled = prev;
  if (!tears) return;
  // a couple of horizontal tear lines, like a detuned TV
  ctx.save(); ctx.globalAlpha = 0.55 * alpha;
  for (let k = 0; k < 3; k++) {
    const y = r.y + RNG.next() * r.h, h = Math.max(1, cell * (0.5 + RNG.next() * 1.5));
    ctx.fillStyle = RNG.next() < 0.5 ? '#000' : '#fff'; ctx.fillRect(r.x, y, r.w, h);
  }
  ctx.restore(); ctx.imageSmoothingEnabled = prev;
}

/* ---------- portal fills ---------- */
const GLITCH_S = { intensity: 70, speed: 80, size: 45, area: 'full', opacity: 100 };
/**
 * Draw the portal fill `mode` inside quad q (4 canvas points, simple polygon).
 * s = portal settings, e = render env {W,H,t,reduced}.
 */
export function renderPortal(ctx, q, mode, s, e) {
  const r = quadBox(q, e.W, e.H); if (!r) return;
  const i = s.intensity / 100;
  let cx = 0, cy = 0; for (const p of q) { cx += p.x; cy += p.y; } cx /= 4; cy /= 4;
  ctx.save(); quadPath(ctx, q); ctx.clip();
  if (mode === 'magnify') {
    // crisp zoom centred on the quad (1.4x–1.6x), natural exposure, subtle lens bulge in the middle
    const m = 1.4 + 0.2 * i;
    const sx = cx + (r.x - cx) / m, sy = cy + (r.y - cy) / m, sw = r.w / m, sh = r.h / m;
    const pad = 2, src = grab('ptSrc', ctx.canvas, { x: Math.max(0, sx - pad), y: Math.max(0, sy - pad), w: Math.min(e.W, sw + pad * 2), h: Math.min(e.H, sh + pad * 2) });
    const ox = sx - Math.max(0, sx - pad), oy = sy - Math.max(0, sy - pad);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src.c, ox, oy, sw, sh, r.x, r.y, r.w, r.h);
    const rr = Math.min(r.w, r.h) * 0.42;
    if (rr > 8) {
      const B = buf('ptBulge', rr * 2, rr * 2), b = B.ctx, k = 1.07;
      b.globalCompositeOperation = 'copy'; b.filter = 'none'; b.imageSmoothingQuality = 'high';
      b.drawImage(src.c, ox + (cx - rr / k - r.x) / m, oy + (cy - rr / k - r.y) / m, (2 * rr) / k / m, (2 * rr) / k / m, 0, 0, rr * 2, rr * 2);
      b.globalCompositeOperation = 'destination-in';
      const g = b.createRadialGradient(rr, rr, rr * 0.25, rr, rr, rr); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      b.fillStyle = g; b.fillRect(0, 0, rr * 2, rr * 2); b.globalCompositeOperation = 'source-over';
      ctx.drawImage(B.c, 0, 0, rr * 2, rr * 2, cx - rr, cy - rr, rr * 2, rr * 2);
    }
  } else if (mode === 'pixel') {
    pixelate(ctx, r, Math.max(6, Math.round(e.W * (0.012 + 0.05 * i))));
  } else if (mode === 'red') {
    // overlay keeps the picture readable: darks turn deep red, lights glow orange-red
    // like the reference: the face goes deep red, the frame's sides warm to orange/yellow and yellow-green.
    // 'color' keeps the picture's luminance (bright wall → yellow, skin → red); 'overlay' adds the richness.
    const fc = e.faceC || { x: cx, y: cy }, R = Math.max(r.w, r.h) * 0.62;
    const g = ctx.createRadialGradient(fc.x, fc.y, 0, fc.x, fc.y, R);
    g.addColorStop(0, '#ff1e0e'); g.addColorStop(0.32, '#ff2a0c'); g.addColorStop(0.5, '#ff7a00'); g.addColorStop(0.7, '#ffcc00'); g.addColorStop(1, '#9fdc10');
    ctx.globalCompositeOperation = 'color'; ctx.fillStyle = g; ctx.globalAlpha = 0.7 + 0.3 * i; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.3 + 0.35 * i; ctx.fillRect(r.x, r.y, r.w, r.h);
  } else if (mode === 'glitch') {
    GLITCH_S.intensity = 30 + 70 * i;
    EFFECT_MAP.glitch.render(ctx, null, e, GLITCH_S);
  } else if (mode === 'static') {
    fillStatic(ctx, r, Math.max(2, Math.round(e.W * (0.002 + 0.008 * i))), e.reduced ? Math.floor(e.t * 4) / 4 : e.t, 0.92);
  } else if (mode === 'rainbow') {
    const n = 7, sw = r.w / 3.5, off = (e.t * 0.35 * sw * 3) % (sw * n);
    ctx.globalCompositeOperation = 'color'; ctx.globalAlpha = 0.45 + 0.5 * i;
    for (let k = -n; k < n * 2; k++) { const x = r.x - sw + k * sw + off; if (x > r.x + r.w || x + sw < r.x) continue; ctx.fillStyle = hsl((((k % n) + n) % n) * (360 / n), 100, 55); ctx.fillRect(x, r.y, sw + 0.5, r.h); }
  } else if (mode === 'invert') {
    ctx.globalCompositeOperation = 'difference'; ctx.fillStyle = '#fff'; ctx.globalAlpha = 0.6 + 0.4 * i; ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  ctx.restore();
  if (mode === 'magnify' && s.border) {
    // a thin, near-white edge with a faint warm glow (reference 0.4 s)
    const lw = clamp(e.W * 0.0016, 1.5, 3);
    ctx.save(); ctx.lineJoin = 'round'; quadPath(ctx, q);
    ctx.shadowColor = 'rgba(255,248,210,0.55)'; ctx.shadowBlur = lw * 1.6; ctx.strokeStyle = 'rgba(255,252,232,0.96)'; ctx.lineWidth = lw; ctx.stroke();
    ctx.restore();
  }
}

/* ---------- Blue Face: tint masked to the face mesh (oval incl. forehead, eyes, lips) ---------- */
export function renderBlueFace(ctx, F, s, e) {
  const i = s.intensity / 100;
  ctx.save(); F.path(ctx, IDX.oval, true, 1.0); ctx.clip();
  const x = F.minX - 4, y = F.minY - 4, w = F.w + 8, h = F.h + 8;
  ctx.globalCompositeOperation = 'color'; ctx.globalAlpha = 0.6 + 0.35 * i; ctx.fillStyle = s.color; ctx.fillRect(x, y, w, h);
  ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = 0.06 + 0.14 * i; ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/* ---------- static ribbon ---------- */
/** poly = Float32Array from ribbonGeometry (top edge then bottom edge). band = mid width (px). */
export function renderRibbon(ctx, poly, band, stretch, s, e) {
  const n = poly.length / 2;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  ctx.save(); ctx.beginPath();
  for (let k = 0; k < n; k++) {
    const x = poly[k * 2], y = poly[k * 2 + 1];
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  ctx.closePath(); ctx.clip();
  _r.x = Math.floor(x0); _r.y = Math.floor(y0); _r.w = Math.ceil(x1 - x0) + 1; _r.h = Math.ceil(y1 - y0) + 1;
  // fine greenish static as a visor (1–2 px cells), cross-fading to chunky saturated pixels as it is pulled out
  const g = s.grain / 100, t = e.reduced ? Math.floor(e.t * 4) / 4 : e.t;
  const fine = Math.max(1, Math.round(band * (0.008 + 0.03 * g)));
  const chunky = Math.max(2, Math.round(band * (0.03 + 0.09 * g) * clamp(0.6 + stretch * 0.5, 1, 2.6)));
  const mix = clamp((stretch - 1.15) / 0.55, 0, 1);
  if (mix < 1) fillStatic(ctx, _r, fine, t, 1, false, 'visor');
  if (mix > 0) fillStatic(ctx, _r, chunky, t, mix, false, 'chunky');
  ctx.restore();
}
