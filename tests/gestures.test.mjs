// Unit tests for the gesture classifier and controller using synthetic landmarks.
// Run: node tests/gestures.test.mjs
import { classifyHand, classifyFrame, classifyFrameDetailed, GestureController, GESTURES } from '../js/gestures.js';

/** Build a synthetic right hand (palm facing camera, fingers up). */
export function makeHand({ thumb = false, index = false, middle = false, ring = false, pinky = false, pinch = false } = {}, ox = 0.5, oy = 0.8, s = 0.2) {
  const P = (x, y) => ({ x: ox + x * s, y: oy + y * s, z: 0 });
  const lm = new Array(21);
  lm[0] = P(0, 0);
  const mcpX = [-0.35, -0.12, 0.1, 0.3]; // index..pinky
  const bases = [5, 9, 13, 17];
  const states = [index, middle, ring, pinky];
  for (let f = 0; f < 4; f++) {
    const b = bases[f], x = mcpX[f];
    lm[b] = P(x, -1.0);
    if (states[f]) {            // straight up
      lm[b + 1] = P(x, -1.4); lm[b + 2] = P(x, -1.7); lm[b + 3] = P(x, -1.95);
    } else {                    // curled back toward the palm
      lm[b + 1] = P(x, -1.3); lm[b + 2] = P(x, -1.05); lm[b + 3] = P(x, -0.85);
    }
  }
  // thumb
  lm[1] = P(-0.35, -0.2);
  if (thumb) { lm[2] = P(-0.6, -0.4); lm[3] = P(-0.8, -0.55); lm[4] = P(-1.0, -0.7); }
  else { lm[2] = P(-0.45, -0.45); lm[3] = P(-0.3, -0.65); lm[4] = P(-0.1, -0.7); }
  if (pinch) { // index bent forward, tip meeting the thumb tip
    lm[6] = P(-0.4, -1.4); lm[7] = P(-0.55, -1.45); lm[8] = P(-0.65, -1.3);
    lm[2] = P(-0.55, -0.5); lm[3] = P(-0.65, -0.9); lm[4] = P(-0.68, -1.24);
  }
  return lm;
}

let pass = 0, fail = 0;
const eq = (name, a, b) => { if (a === b) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name, '→', a, 'expected', b); } };

const H = {
  palm: makeHand({ thumb: true, index: true, middle: true, ring: true, pinky: true }),
  palmNoThumb: makeHand({ index: true, middle: true, ring: true, pinky: true }),
  fist: makeHand({}),
  two: makeHand({ index: true, middle: true }),
  twoThumb: makeHand({ index: true, middle: true, thumb: true }),
  three: makeHand({ index: true, middle: true, ring: true }),
  pinch: makeHand({ pinch: true, middle: true, ring: true, pinky: true }),
  pinchCurled: makeHand({ pinch: true }),
  point: makeHand({ index: true }),
};
// mirrored / rotated / scaled variants must classify the same
const mirror = (lm) => lm.map((p) => ({ x: 1 - p.x, y: p.y, z: 0 }));
const rotate = (lm, a) => lm.map((p) => { const x = p.x - 0.5, y = p.y - 0.5; return { x: 0.5 + x * Math.cos(a) - y * Math.sin(a), y: 0.5 + x * Math.sin(a) + y * Math.cos(a), z: 0 }; });

eq('open palm', classifyHand(H.palm), GESTURES.OPEN_PALM);
eq('open palm (thumb tucked)', classifyHand(H.palmNoThumb), GESTURES.OPEN_PALM);
eq('closed fist', classifyHand(H.fist), GESTURES.FIST);
eq('two fingers', classifyHand(H.two), GESTURES.TWO);
eq('two fingers + thumb', classifyHand(H.twoThumb), GESTURES.TWO);
eq('three fingers', classifyHand(H.three), GESTURES.THREE);
eq('pinch (OK sign)', classifyHand(H.pinch), GESTURES.PINCH);
eq('pinch (others curled)', classifyHand(H.pinchCurled), GESTURES.PINCH);
eq('pointing = no gesture', classifyHand(H.point), null);
// fist with the thumb resting against the index knuckle must stay a fist, not a pinch
const fistThumbOnKnuckle = makeHand({}); fistThumbOnKnuckle[4] = { ...fistThumbOnKnuckle[5], x: fistThumbOnKnuckle[5].x + 0.01 }; fistThumbOnKnuckle[8] = { ...fistThumbOnKnuckle[5], y: fistThumbOnKnuckle[5].y + 0.02 };
eq('fist with thumb on knuckle is not pinch', classifyHand(fistThumbOnKnuckle), GESTURES.FIST);
eq('both hands (two open palms)', classifyFrame([H.palm, H.palm]), GESTURES.BOTH);
eq('both hands (palm + relaxed/pointing)', classifyFrame([H.palm, H.point]), GESTURES.BOTH);
eq('two hands: primary hand fist wins', classifyFrame([H.palm, H.fist]), GESTURES.FIST);
eq('two hands: primary hand two fingers wins', classifyFrame([H.two, H.palm]), GESTURES.TWO);
eq('two hands: primary hand three fingers wins', classifyFrame([H.point, H.three]), GESTURES.THREE);
eq('two hands: pinch hand index reported', classifyFrameDetailed([H.palm, H.pinch]).hand, 1);
eq('two hands: different distinct gestures → both', classifyFrame([H.fist, H.two]), GESTURES.BOTH);
eq('incomplete landmarks → null', classifyHand(H.palm.slice(0, 10)), null);
eq('incomplete second hand ignored', classifyFrame([H.fist, H.palm.slice(0, 5)]), GESTURES.FIST);
eq('no hands', classifyFrame([]), null);
for (const [k, lm] of Object.entries(H)) {
  eq(`mirror invariant: ${k}`, classifyHand(mirror(lm)), classifyHand(lm));
  eq(`rotation invariant (25°): ${k}`, classifyHand(rotate(lm, 0.44)), classifyHand(lm));
  eq(`scale invariant: ${k}`, classifyHand(lm.map((p) => ({ x: 0.5 + (p.x - 0.5) * 0.4, y: 0.5 + (p.y - 0.5) * 0.4, z: 0 }))), classifyHand(lm));
}

// Controller: debounce, hold, release, cooldown, pinch movement
const c = new GestureController({ holdMs: 400, cooldownMs: 800, releaseMs: 150, pinchHoldMs: 200 });
let ev = [];
const feed = (hands, from, to, step = 33) => { const out = []; for (let t = from; t <= to; t += step) out.push(...c.update(hands, t).map((e) => ({ ...e, t }))); return out; };
ev = feed([H.palm], 0, 300); eq('no event before hold time', ev.filter((e) => e.type === 'gesture').length, 0);
ev = feed([H.palm], 333, 2000); eq('fires once after 400ms hold', ev.filter((e) => e.type === 'gesture').length, 1);
eq('fired gesture is open palm', ev[0]?.gesture, GESTURES.OPEN_PALM);
ev = feed([], 2033, 2300); ev = feed([H.palm], 2333, 2900);
eq('re-fires after release', ev.filter((e) => e.type === 'gesture').length, 1);
ev = feed([H.two], 2933, 3200); eq('cooldown blocks immediate next', ev.filter((e) => e.type === 'gesture').length, 0);
ev = feed([H.two], 3233, 3900); eq('two fingers fires after cooldown', ev.filter((e) => e.gesture === GESTURES.TWO && e.type === 'gesture').length, 1);
// flicker (one frame of noise) must not trigger
c.reset(); ev = []; for (let t = 0; t < 1000; t += 33) ev.push(...c.update(t % 132 === 0 ? [H.fist] : [], t));
eq('flicker does not trigger', ev.filter((e) => e.type === 'gesture').length, 0);
// pinch movement
c.reset();
const pinchAt = (dy) => [makeHand({ pinch: true }, 0.5, 0.8 - dy)];
ev = []; for (let t = 0, i = 0; t <= 1200; t += 33, i++) ev.push(...c.update(pinchAt(Math.min(0.2, i * 0.01)), t));
eq('pinch_start emitted', ev.filter((e) => e.type === 'pinch_start').length, 1);
const moves = ev.filter((e) => e.type === 'pinch_move');
eq('pinch_move emitted', moves.length > 5, true);
eq('pinch upward gives positive dy', moves[moves.length - 1].dy > 0.1, true);
ev = c.update([], 1300); eq('pinch_end on release', ev.some((e) => e.type === 'pinch_end'), true);


// ---- regression: both_hands must not re-fire on 2→1 hand tracking flicker (QA P1)
{
  const g = new GestureController();
  let fires = 0;
  for (let t = 0; t <= 8000; t += 33) {
    const drop = (t % 1200) >= 600 && (t % 1200) < 800; // 200 ms dropout to one hand every 1.2 s
    fires += g.update(drop ? [H.palm] : [H.palm, H.palm], t).filter((e) => e.type === 'gesture' && e.gesture === GESTURES.BOTH).length;
  }
  eq('both_hands fires once despite 200 ms 2→1 flicker every 1.2 s (8 s)', fires, 1);
}
{
  const g = new GestureController();
  let fires = 0;
  for (let t = 0; t <= 8000; t += 33) {
    const drop = (t % 1000) < 500; // 500 ms dropout (longer than the old 150 ms release)
    fires += g.update(drop ? [H.point] : [H.palm, H.palm], t).filter((e) => e.gesture === GESTURES.BOTH && e.type === 'gesture').length;
  }
  eq('both_hands fires once with 500 ms dropouts', fires, 1);
}
{
  const g = new GestureController(); const all = [];
  const run = (hands, a, b) => { for (let t = a; t <= b; t += 33) all.push(...g.update(hands, t).filter((e) => e.type === 'gesture').map((e) => ({ ...e, t }))); };
  run([H.palm, H.palm], 0, 1500);
  run([], 1533, 2500);                 // all hands gone > bothReleaseMs (fired at ~400 ms)
  run([H.palm, H.palm], 2533, 2850);   // back and held, but still inside the 2.5 s per-gesture cooldown
  eq('both_hands blocked by its own cooldown', all.filter((e) => e.gesture === GESTURES.BOTH).length, 1);
  run([H.palm, H.palm], 2883, 5000);
  eq('both_hands re-fires after release + cooldown', all.filter((e) => e.gesture === GESTURES.BOTH).length, 2);
}
{
  const g = new GestureController(); const all = [];
  const run = (hands, a, b) => { for (let t = a; t <= b; t += 33) all.push(...g.update(hands, t).filter((e) => e.type === 'gesture')); };
  run([H.palm, H.palm], 0, 900);
  run([H.palm], 933, 1200);  // brief drop: still latched → no open_palm
  eq('no one-hand gesture fires during the both-hands latch', all.filter((e) => e.gesture === GESTURES.OPEN_PALM).length, 0);
  run([H.palm], 1233, 3000); // one hand deliberately held alone → latch ends, palm can fire
  eq('one-hand gesture works after deliberately dropping a hand', all.filter((e) => e.gesture === GESTURES.OPEN_PALM).length, 1);
}
{
  const g = new GestureController(); const all = [];
  for (let t = 0; t <= 1500; t += 33) all.push(...g.update([H.palm, H.fist], t).filter((e) => e.type === 'gesture'));
  eq('fist fires while a second (open) hand is visible', all.map((e) => e.gesture).join(), GESTURES.FIST);
}
{
  const g = new GestureController(); const ev = [];
  for (let t = 0, i = 0; t <= 1200; t += 33, i++) ev.push(...g.update([H.palm, makeHand({ pinch: true }, 0.5, 0.8 - Math.min(0.2, i * 0.01))], t));
  const mv = ev.filter((e) => e.type === 'pinch_move');
  eq('pinch with two hands visible tracks the pinching hand', mv.length > 5 && mv[mv.length - 1].dy > 0.1, true);
}
{
  const g = new GestureController();
  eq('progress 0 with no candidate', g.progress(0), 0);
  g.update([H.two], 0); g.update([H.two], 200);
  eq('progress ~0.5 halfway through hold', Math.abs(g.progress(200) - 0.5) < 0.01, true);
  g.update([H.two], 450);
  eq('progress 0 after firing (until release)', g.progress(450), 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
