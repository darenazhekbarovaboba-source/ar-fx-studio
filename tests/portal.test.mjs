// Unit tests for the Hand Portal logic (quad ordering, smoothing, ribbon geometry, mode switching).
// Run: node tests/portal.test.mjs
import { orderQuad, isSelfIntersecting, polyArea, handPose, PortalController, OneEuro, ribbonGeometry, ribbonWidth, MODE_IDS, VIDEO_CYCLE, portalDefaults, PORTAL_DEF } from '../js/portal.js';

let pass = 0, fail = 0;
const eq = (name, a, b) => { if (a === b) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name, '→', a, 'expected', b); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** Synthetic 21-point hand: thumb tip t4, index tip t8, wrist w (normalized coords). */
function hand(t4, t8, w) {
  const L = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: 0 });
  const tip = { x: (t4.x + t8.x) / 2, y: (t4.y + t8.y) / 2 }, h = new Array(21);
  h[0] = { ...w, z: 0 };
  for (let i = 1; i <= 4; i++) h[i] = L(w, t4, i / 4.4); h[4] = { ...t4, z: 0 };
  for (let f = 0; f < 4; f++) { const base = 5 + f * 4, end = f === 0 ? t8 : L(w, tip, 0.8 - f * 0.08); for (let j = 0; j < 4; j++) h[base + j] = L(w, end, 0.45 + j * 0.183); }
  h[8] = { ...t8, z: 0 };
  return h;
}
const P = (x, y) => ({ x, y });
// two "L" hands framing a face centred at (0.5, 0.45)
const Lleft = (dx = 0) => hand(P(0.42 - dx, 0.55), P(0.36 - dx, 0.3), P(0.2 - dx, 0.6));
const Lright = (dx = 0) => hand(P(0.58 + dx, 0.55), P(0.64 + dx, 0.3), P(0.8 + dx, 0.6));
const pinchHand = (x, y, side) => hand(P(x - side * 0.006, y + 0.003), P(x + side * 0.002, y - 0.003), P(x + side * 0.08, y + 0.18));
const closedHand = (side) => hand(P(0.5 + side * 0.13, 0.36), P(0.5 + side * 0.14, 0.3), P(0.5 + side * 0.3, 0.6)); // thumb up at the index tip: frame closed
const mirror = (hs) => hs.map((h) => h.map((p) => ({ x: 1 - p.x, y: p.y, z: 0 })));

/* ---------- quad ordering ---------- */
{
  const sq = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)];
  const perms = (a) => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
  const all = perms(sq);
  eq('24 permutations of the square', all.length, 24);
  eq('bow-tie input is detected as self-intersecting', isSelfIntersecting([P(0, 0), P(1, 1), P(1, 0), P(0, 1)]), true);
  eq('every permutation orders to a simple quad', all.every((p) => !isSelfIntersecting(orderQuad(p))), true);
  eq('ordered quad keeps the full area', all.every((p) => near(Math.abs(polyArea(orderQuad(p))), 1, 1e-9)), true);
  // the hand quad: [L index, R index, R thumb, L thumb] in any order
  const hq = [P(0.36, 0.3), P(0.58, 0.55), P(0.64, 0.3), P(0.42, 0.55)];
  eq('hand quad from crossed corner order is simple', !isSelfIntersecting(orderQuad(hq)), true);
  const tri = [P(0.4, 0.3), P(0.6, 0.3), P(0.5, 0.6), P(0.5, 0.6001)]; // thumbs touching: near-triangle
  eq('near-triangle (thumbs touching) stays simple', !isSelfIntersecting(orderQuad(tri)), true);
  const skew = all.map((p) => p.map((q) => P(q.x * 1.777, q.y)));
  eq('ordering survives aspect scaling', skew.every((p) => !isSelfIntersecting(orderQuad(p))), true);
  const mir = all.map((p) => p.map((q) => P(1 - q.x, q.y)));
  eq('ordering survives mirroring', mir.every((p) => !isSelfIntersecting(orderQuad(p))), true);
  const o = orderQuad(sq), sign = Math.sign(polyArea(o));
  eq('orderQuad output is consistently oriented', all.every((p) => Math.sign(polyArea(orderQuad(p))) === sign), true);
}

/* ---------- pose ---------- */
{
  const l = handPose(Lleft()), p = handPose(pinchHand(0.3, 0.4, -1));
  eq('L hand: thumb–index spread > 1 palm', l.ti > 1 && l.indexUp, true);
  eq('pinch hand: spread < 0.24 palm', p.ti < 0.24, true);
  const c = new PortalController();
  eq('two L hands → portal', c.classify([Lleft(), Lright()]).kind, 'portal');
  eq('hand order does not matter', c.classify([Lright(), Lleft()]).kind, 'portal');
  eq('mirrored hands → portal', c.classify(mirror([Lleft(), Lright()])).kind, 'portal');
  eq('two pinches → ribbon', c.classify([pinchHand(0.3, 0.4, -1), pinchHand(0.7, 0.4, 1)]).kind, 'ribbon');
  eq('one L + one pinch → neither', c.classify([Lleft(), pinchHand(0.7, 0.4, 1)]).kind, 'hands');
  eq('one hand → hands', c.classify([Lleft()]).kind, 'hands');
  eq('no hands → none', c.classify([]).kind, 'none');
  eq('closed frame (thumbs at index) → not a portal', c.classify([closedHand(-1), closedHand(1)]).kind, 'hands');
}

/* ---------- mode switching ---------- */
const FR = [Lleft(), Lright()];
function run(c, hands, t0, t1, step = 33) { let r; for (let t = t0; t <= t1; t += step) r = c.update(hands, t); return r; }
{
  const c = new PortalController();
  let r = run(c, FR, 0, 600);
  eq('first frame shows the default fill (no switch)', r.state + ':' + r.mode + ':' + c.cycles, 'portal:magnify:0');
  eq('portal quad has 4 corners', r.quad.length, 4);
  eq('quad is simple', !isSelfIntersecting(r.quad), true);
  // short tracking drop-out (2 frames) must not count as a re-frame
  run(c, [], 633, 700); r = run(c, FR, 733, 1200);
  eq('100 ms drop-out keeps the portal and the fill', r.mode + ':' + c.cycles, 'magnify:0');
  // hands down for 0.8 s (a deliberate release), then frame again → next fill
  run(c, [], 1233, 1966); r = run(c, FR, 2000, 2300);
  eq('re-frame after a release → Pixel', r.mode, 'pixel');
  run(c, [Lleft()], 2333, 3200); r = run(c, FR, 3233, 3600);
  eq('re-frame after one hand drops → Red', r.mode, 'red');
  run(c, [closedHand(-1), closedHand(1)], 4833, 5000); r = run(c, FR, 5033, 5500);
  eq('closing the frame (thumbs to index) then reopening → wraps to Magnify', r.mode, 'magnify');
  eq('cycle counter', c.cycles, 3);
}
{
  const c = new PortalController(); c.cycle = 'all'; c.setMode('red');
  run(c, FR, 0, 300); run(c, [], 333, 1100); const r = run(c, FR, 1133, 1400);
  eq("cycle 'all' continues past Red to the bonus fills", r.mode, 'glitch');
}
{
  const c = new PortalController(); c.cycle = 'off';
  run(c, FR, 0, 300); run(c, [], 333, 1100); const r = run(c, FR, 1133, 1400);
  eq("cycle 'off' never switches on re-frame", r.mode + ':' + c.cycles, 'magnify:0');
}
{
  const c = new PortalController(); c.setMode('glitch');
  run(c, FR, 0, 300); run(c, [], 333, 1100); const r = run(c, FR, 1133, 1400);
  eq('a bonus fill re-frames back into the video cycle', r.mode, 'magnify');
}
{
  const c = new PortalController();
  run(c, FR, 0, 300); run(c, [], 333, 1100); run(c, FR, 1133, 1150); run(c, [closedHand(-1), closedHand(1)], 1166, 1300); run(c, FR, 1333, 1500);
  eq('dwell: a quick cue (closed frame) within 1.2 s of a switch does not switch again', c.cycles, 1);
  run(c, [], 1533, 2400); run(c, FR, 2433, 2600);
  eq('a full release 0.9 s later still switches (MIN_DWELL 0.5 s)', c.cycles, 2);
}
{
  const c = new PortalController();
  eq('manual next wraps forward', (c.setMode('invert'), c.next(1)), 'magnify');
  eq('manual previous wraps backward', c.next(-1), 'invert');
  eq('invalid mode ignored', c.setMode('nope'), 'invert');
  eq('7 portal fills', MODE_IDS.length, 7);
  eq('video cycle = Magnify, Pixel, Red', VIDEO_CYCLE.join(), 'magnify,pixel,red');
}
{
  const c = new PortalController();
  let r = c.update([], 0); eq('no hands at start → none (Blue Face)', r.state, 'none');
  run(c, FR, 33, 300); r = c.update([], 400); eq('hands just left → not yet Blue Face', r.state === 'portal' || r.state === 'hands', true);
  r = run(c, [], 433, 1100); eq('no hands past the grace → none (Blue Face)', r.state + ':' + r.blue, 'none:true');
  r = run(c, [Lleft()], 1133, 1400); eq('one idle hand → no portal/ribbon, Blue Face stays on', r.state + ':' + r.blue, 'hands:true');
}

/* ---------- ribbon ---------- */
{
  const c = new PortalController();
  let r = run(c, [pinchHand(0.4, 0.4, -1), pinchHand(0.6, 0.4, 1)], 0, 300);
  eq('two pinches → ribbon state', r.state, 'ribbon');
  eq('ribbon starts unstretched', near(r.stretch, 1, 0.05), true);
  for (let t = 333, k = 0; t <= 1500; t += 33, k++) { const d = Math.min(0.2, k * 0.01); r = c.update([pinchHand(0.4 - d, 0.4, -1), pinchHand(0.6 + d, 0.4, 1)], t); }
  eq('pulling apart stretches the ribbon (~3x)', r.stretch > 2.4 && r.stretch < 3.3, true);
  eq('pinch points: one per hand', r.pinch.length, 2);
  eq('both hands pulled equally → similar displacement', Math.abs(c.moved[0] - c.moved[1]) < 0.02, true);
  const c2 = new PortalController(); run(c2, [pinchHand(0.4, 0.4, -1), pinchHand(0.6, 0.4, 1)], 0, 300);
  for (let t = 333, k = 0; t <= 1200; t += 33, k++) c2.update([pinchHand(0.4, 0.4, -1), pinchHand(0.6 + Math.min(0.25, k * 0.012), 0.4, 1)], t);
  eq('only the right hand pulls away → it is the one that moved', c2.moved[1] > 0.15 && c2.moved[0] < 0.02, true);
  const g = run(c, [Lleft(), Lright()], 1533, 1900);
  eq('ribbon → frame switches to the portal', g.state, 'portal');
}
{
  const n = 24, band = 40;
  const out = ribbonGeometry(P(100, 200), P(500, 200), { eye: P(300, 190), band, stretch: 1, n });
  eq('ribbon polygon size', out.length, 4 * (n + 1));
  const w0 = Math.hypot(out[0] - out[(2 * n + 1) * 2], out[1] - out[(2 * n + 1) * 2 + 1]);
  eq('unstretched ribbon: ends as wide as the eye band (visor)', near(w0, band, 0.5), true);
  const mid = n / 2, topY = out[mid * 2 + 1], botY = out[(2 * n + 1 - mid) * 2 + 1];
  eq('centre line passes through the eyes', near((topY + botY) / 2, 190, 0.5), true);
  const endW = (g, i) => { const j = 2 * n + 1 - i; return Math.hypot(g[i * 2] - g[j * 2], g[i * 2 + 1] - g[j * 2 + 1]); };
  const s2 = ribbonGeometry(P(100, 200), P(500, 200), { eye: P(300, 200), band, stretch: 2, n, taper: 'right' });
  eq('taper right (x2): left end stays square at the full band', near(endW(s2, 0), band, 0.5), true);
  eq('taper right (x2): right end narrows to half', near(endW(s2, n), band / 2, 0.5), true);
  let mono = true; for (let i = 1; i <= n; i++) if (endW(s2, i) > endW(s2, i - 1) + 1e-6) mono = false;
  eq('taper right: width shrinks monotonically toward the pulling hand', mono, true);
  const s3 = ribbonGeometry(P(100, 200), P(500, 200), { eye: P(300, 200), band, stretch: 2, n, taper: 'left' });
  eq('taper left (x2): right end square, left end half', near(endW(s3, n), band, 0.5) && near(endW(s3, 0), band / 2, 0.5), true);
  const s4 = ribbonGeometry(P(500, 200), P(100, 200), { band, stretch: 2, n, taper: 'right' });
  eq("taper side refers to the screen side, whatever the pinch order", endW(s4, n) < endW(s4, 0), true);
  const sb = ribbonGeometry(P(100, 200), P(500, 200), { eye: P(300, 200), band, stretch: 2, n, taper: 'both' });
  eq("taper 'both': symmetric ends at half, middle full", near(endW(sb, 0), band / 2, 0.5) && near(endW(sb, n), band / 2, 0.5) && near(endW(sb, n / 2), band, 0.5), true);
  eq('taper floor at 18%', near(ribbonWidth(1, 100, 50, 'right'), 18, 1e-6), true);
  eq('unstretched: uniform band (visor)', near(ribbonWidth(1, 100, 1, 'right'), 100, 1e-9) && near(ribbonWidth(0.3, 100, 1, 'left'), 100, 1e-9), true);
  const far = ribbonGeometry(P(100, 200), P(500, 200), { eye: P(300, 600), band, n });
  eq('eye far from the hands → straight ribbon', near((far[mid * 2 + 1] + far[(2 * n + 1 - mid) * 2 + 1]) / 2, 200, 0.5), true);
  const rev = ribbonGeometry(P(500, 200), P(100, 200), { band, n });
  eq('pinch order does not matter (left→right)', rev[0] < rev[n * 2], true);
  eq('no NaN', [...out, ...s2, ...s3, ...far].every(Number.isFinite), true);
  const off = ribbonGeometry(P(100, 200), P(500, 200), { eye: P(220, 215), band, n: 40 });
  let best = 1e9; for (let i = 0; i <= 40; i++) { const cx = (off[i * 2] + off[(81 - i) * 2]) / 2, cy = (off[i * 2 + 1] + off[(81 - i) * 2 + 1]) / 2; best = Math.min(best, Math.hypot(cx - 220, cy - 215)); }
  eq('off-centre eyes: centre line still passes through them', best < 3, true);
}

/* ---------- QA regressions: flicker, collapsed quads, face gate, ribbon robustness, Blue Face ---------- */
{
  // 300 ms 2→1 (and 2→0) flicker every 1.2 s for 8 s must not cycle the fill nor blink the quad off
  for (const [label, drop] of [['2→1', [Lleft()]], ['2→0', []]]) {
    const c = new PortalController(); let blinks = 0;
    for (let t = 0; t <= 8000; t += 33) { const r = c.update(t % 1200 >= 900 ? drop : FR, t); if (t > 100 && r.state !== 'portal') blinks++; }
    eq(`300 ms ${label} flicker every 1.2 s: fill never cycles`, c.mode + ':' + c.cycles, 'magnify:0');
    eq(`300 ms ${label} flicker every 1.2 s: the quad stays up (no re-forms)`, blinks + ':' + c.forms, '0:1');
  }
  const c = new PortalController(); run(c, FR, 0, 600); run(c, [], 633, 1066); const r = run(c, FR, 1100, 1500);
  eq('450 ms tracking loss keeps the portal and the fill', r.state + ':' + r.mode + ':' + c.forms, 'portal:magnify:1');
  // a brief mis-read as a pinch (132 ms / 200 ms) is flicker, not a ribbon or a release
  for (const ms of [132, 200]) {
    const c2 = new PortalController(); run(c2, FR, 0, 600); let st = new Set();
    for (let t = 633; t <= 633 + ms; t += 33) st.add(c2.update([pinchHand(0.4, 0.4, -1), pinchHand(0.6, 0.4, 1)], t).state);
    const r2 = run(c2, FR, 666 + ms, 1400);
    eq(`${ms} ms pinch mis-read: portal stays, no switch`, [...st].join() + ':' + r2.mode + ':' + c2.cycles, 'portal:magnify:0');
  }
}
{
  // deliberate release → switch, even when quick: frame closed for a moment, or re-framed somewhere else
  const c = new PortalController(); run(c, FR, 0, 900);
  run(c, [closedHand(-1), closedHand(1)], 933, 1066); let r = run(c, FR, 1100, 1500);
  eq('closing the frame for ~150 ms then reopening → next fill', r.mode, 'pixel');
  const c2 = new PortalController(); run(c2, FR, 0, 900); run(c2, [], 933, 1233);
  const up = [Lleft(), Lright()].map((h) => h.map((p) => ({ x: p.x, y: p.y - 0.25, z: 0 })));
  const big = [hand(P(0.35, 0.75), P(0.1, 0.15), P(0.0, 0.8)), hand(P(0.65, 0.75), P(0.9, 0.15), P(1.0, 0.8))];
  r = run(c2, big, 1266, 1600);
  eq('quick re-frame (300 ms) at a clearly different size → next fill', r.mode, 'pixel');
  const c3 = new PortalController(); run(c3, FR, 0, 900); run(c3, [], 933, 1233); r = run(c3, FR, 1266, 1600);
  eq('quick re-frame (300 ms) in the same place → same fill (flicker)', r.mode, 'magnify');
  eq('moved-up frame helper is valid', new PortalController().classify(up).kind, 'portal');
}
{
  // collapsed thumbs (triangle reading) are rejected; while the portal is up the last good quad is held
  const tri = [hand(P(0.49, 0.6), P(0.36, 0.3), P(0.2, 0.6)), hand(P(0.51, 0.6), P(0.64, 0.3), P(0.8, 0.6))];
  const c = new PortalController();
  eq('collapsed triangle on its own → not a portal', c.classify(tri).kind + '/' + c.classify(tri).why, 'hands/collapsed');
  run(c, FR, 0, 600); const q0 = c.quad.map((p) => p.x.toFixed(4) + ',' + p.y.toFixed(4)).join();
  const r = run(c, tri, 633, 900); const q1 = r.quad && r.quad.map((p) => p.x.toFixed(4) + ',' + p.y.toFixed(4)).join();
  eq('collapsed reading mid-portal: last good trapezoid held', r.state + ':' + (q1 === q0), 'portal:true');
  // face gate: with a face visible the quad must frame it
  const face = [{ x0: 0.42, y0: 0.3, x1: 0.58, y1: 0.55 }];
  eq('portal around the face → portal', c.classify(FR, 1, face).kind, 'portal');
  const chest = FR.map((h) => h.map((p) => ({ x: p.x, y: p.y + 0.45, z: 0 })));
  eq('same frame on the chest, face above → rejected', c.classify(chest, 1, face).kind + '/' + c.classify(chest, 1, face).why, 'hands/off-face');
  eq('no face visible → frame accepted anywhere', c.classify(chest, 1, null).kind, 'portal');
}
{
  // ribbon robustness on the pinch beat
  const loose = (x, y, side) => hand(P(x - side * 0.011, y + 0.0055), P(x + side * 0.0022, y - 0.0055), P(x + side * 0.08, y + 0.18));
  eq('a looser real-world pinch (ti≈0.28) counts', handPose(loose(0.3, 0.4, -1)).ti > 0.24 && new PortalController().classify([loose(0.3, 0.4, -1), loose(0.7, 0.4, 1)]).kind === 'ribbon', true);
  const c = new PortalController(); const PH = [pinchHand(0.1, 0.4, -1), pinchHand(0.9, 0.4, 1)];
  run(c, PH, 0, 400); let views = new Set(), blue = false;
  for (let t = 433; t <= 1033; t += 33) { const r = c.update([], t); views.add(r.state); blue = blue || r.blue; }
  eq('600 ms hand loss mid-ribbon: ribbon held, no Blue Face', [...views].join() + ':' + blue, 'ribbon:false');
  const c2 = new PortalController(); run(c2, [pinchHand(0.03, 0.4, -1), pinchHand(0.6, 0.4, 1)], 0, 400);
  let r; for (let t = 433; t <= 2500; t += 33) r = c2.update([pinchHand(0.6 + Math.min(0.3, (t - 433) * 0.0003), 0.4, 1)], t);
  eq('one pinching hand lost at the frame edge: ribbon kept and still follows the other hand', r.state === 'ribbon' && r.pinch[1].x > 0.85, true);
  const c3 = new PortalController(); run(c3, [pinchHand(0.4, 0.4, -1), pinchHand(0.6, 0.4, 1)], 0, 400);
  r = run(c3, [pinchHand(0.6, 0.4, 1)], 433, 1600);
  eq('one hand lost away from the edge: ribbon ends after its grace', r.state, 'hands');
}
{
  // Blue Face whenever neither the portal nor the ribbon is up (idle hands included), never during a grace hold
  const c = new PortalController(); run(c, FR, 0, 600);
  let r = c.update([Lleft()], 700); eq('portal grace (1 hand for 100 ms): no Blue Face yet', r.state + ':' + r.blue, 'portal:false');
  r = run(c, [Lleft()], 733, 1500); eq('portal over, one idle hand in view → Blue Face', r.state + ':' + r.blue, 'hands:true');
  r = run(c, [Lleft(), pinchHand(0.7, 0.4, 1)], 1533, 1800); eq('two idle hands (neither pose) → Blue Face', r.blue, true);
  r = run(c, FR, 1833, 2000); eq('framing again → Blue Face off', r.state + ':' + r.blue, 'portal:false');
}

/* ---------- smoothing ---------- */
{
  const f = new OneEuro(1.5, 4);
  let v; for (let i = 0; i < 30; i++) v = f.filter(0.5, i / 30);
  eq('One Euro: constant in → constant out', near(v, 0.5, 1e-9), true);
  const g = new OneEuro(1.0, 0.5); let s = 0, s2 = 0, n = 0, seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.01;
  for (let i = 0; i < 300; i++) { const y = g.filter(0.5 + rnd(), i / 30); if (i > 30) { s += y - 0.5; s2 += (y - 0.5) ** 2; n++; } }
  const sd = Math.sqrt(s2 / n - (s / n) ** 2);
  eq('One Euro: jitter reduced by > 3x at rest', sd < 0.0029 / 3, true);
  const h = new OneEuro(1.5, 4); h.filter(0, 0); let y = 0; for (let i = 1; i <= 15; i++) y = h.filter(1, i / 30);
  eq('One Euro: follows a fast move within 0.5 s', y > 0.95, true);
  const c = new PortalController(); c.setSmoothing(0); const c2 = new PortalController(); c2.setSmoothing(100);
  eq('smoothing setting lowers the cutoff', c2.f[0].fx.minCutoff < c.f[0].fx.minCutoff, true);
}
{
  const d = portalDefaults();
  eq('portal defaults: video cycle, blue face, ribbon on', d.cycle + d.blueFace + d.ribbon, 'videotruetrue');
  eq('portal settings define a colour (Blue Face)', PORTAL_DEF.hasColor && /^#[0-9a-f]{6}$/i.test(d.color), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
