// Hand gesture classification (pure, testable) + debounced controller.
// Landmark layout (MediaPipe Hands): 0 wrist, 1-4 thumb, 5-8 index, 9-12 middle,
// 13-16 ring, 17-20 pinky. Coordinates are normalized image space.

export const GESTURES = {
  OPEN_PALM: 'open_palm',
  FIST: 'fist',
  TWO: 'two_fingers',
  THREE: 'three_fingers',
  PINCH: 'pinch',
  BOTH: 'both_hands',
};

export const GESTURE_LABELS = {
  open_palm: 'Open palm',
  fist: 'Closed fist',
  two_fingers: 'Two fingers',
  three_fingers: 'Three fingers',
  pinch: 'Pinch',
  both_hands: 'Both hands',
};

const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Per-finger extension state for one hand. */
export function fingerStates(lm) {
  const wrist = lm[0];
  const size = d(lm[0], lm[9]) || 1e-6; // palm length
  const ext = (mcp, pip, dip, tip) => {
    // extended when the tip is clearly farther from the wrist than the PIP joint
    // and the finger is reasonably straight (tip far from MCP).
    const tipW = d(lm[tip], wrist), pipW = d(lm[pip], wrist);
    const straight = d(lm[tip], lm[mcp]) > 0.55 * size;
    return tipW > pipW * 1.12 && straight;
  };
  const index = ext(5, 6, 7, 8);
  const middle = ext(9, 10, 11, 12);
  const ring = ext(13, 14, 15, 16);
  const pinky = ext(17, 18, 19, 20);
  // thumb: tip away from the index MCP and from the palm centre
  const thumb = d(lm[4], lm[5]) > 0.55 * size && d(lm[4], lm[17]) > d(lm[3], lm[17]) * 1.05;
  return { thumb, index, middle, ring, pinky, size };
}

/** Classify one hand. Returns a GESTURES value or null. */
export function classifyHand(lm) {
  if (!lm || lm.length < 21) return null;
  const f = fingerStates(lm);
  const pinchDist = d(lm[4], lm[8]) / f.size;
  // Pinch: thumb tip touching index tip, while the other fingers are not all open
  // (the thumb tip must be out at the index tip, not resting on the knuckle as in a fist)
  const thumbOut = d(lm[4], lm[5]) > 0.32 * f.size;
  if (pinchDist < 0.25 && thumbOut) return GESTURES.PINCH;
  const n = (f.index ? 1 : 0) + (f.middle ? 1 : 0) + (f.ring ? 1 : 0) + (f.pinky ? 1 : 0);
  if (n === 4) return GESTURES.OPEN_PALM;
  if (n === 0) {
    // fist: fingertips curled near the palm
    const curl = (d(lm[8], lm[5]) + d(lm[12], lm[9]) + d(lm[16], lm[13]) + d(lm[20], lm[17])) / 4 / f.size;
    return curl < 0.75 ? GESTURES.FIST : null;
  }
  if (f.index && f.middle && !f.ring && !f.pinky) return GESTURES.TWO;
  if (f.index && f.middle && f.ring && !f.pinky) return GESTURES.THREE;
  return null;
}

/** One-hand gestures that may come from a "primary" hand while two hands are visible. */
const DISTINCT = new Set([GESTURES.FIST, GESTURES.TWO, GESTURES.THREE, GESTURES.PINCH]);

/**
 * Classify a frame (array of hands) and report which hand produced the gesture.
 * Two hands visible => both_hands, unless one hand (the primary hand) is clearly making a
 * distinct one-hand gesture (fist / two / three / pinch) — then that gesture wins, so
 * one-hand controls keep working with a second hand in view.
 * @returns {{gesture: string|null, hand: number}}
 */
export function classifyFrameDetailed(hands) {
  const valid = (hands || []).filter((h) => h && h.length >= 21);
  if (valid.length === 0) return { gesture: null, hand: -1 };
  if (valid.length === 1) return { gesture: classifyHand(valid[0]), hand: hands.indexOf(valid[0]) };
  const g0 = classifyHand(valid[0]), g1 = classifyHand(valid[1]);
  const d0 = DISTINCT.has(g0), d1 = DISTINCT.has(g1);
  if (d0 && !d1) return { gesture: g0, hand: hands.indexOf(valid[0]) };
  if (d1 && !d0) return { gesture: g1, hand: hands.indexOf(valid[1]) };
  if (d0 && d1 && g0 === g1) return { gesture: g0, hand: hands.indexOf(valid[0]) };
  return { gesture: GESTURES.BOTH, hand: -1 };
}

/** Classify a frame; returns just the gesture name (see classifyFrameDetailed). */
export function classifyFrame(hands) { return classifyFrameDetailed(hands).gesture; }

/**
 * Debounced gesture controller. Feed it hands per detection; it returns events.
 * - One-shot gestures fire once after being held `holdMs`, then must be released for
 *   `releaseMs` before they can fire again. Each gesture also has its own cooldown, and a
 *   global cooldown separates any two one-shot events.
 * - both_hands is latched: after it fires it stays "held" while at least one hand is still
 *   visible, so tracking flicker (2 → 1 → 2 hands) cannot re-fire it. The latch clears when
 *   all hands are gone for `bothReleaseMs`, or when a single hand has been alone for
 *   `bothSoloMs` (the user deliberately dropped one hand). While latched, other one-shot
 *   gestures are suppressed.
 * - Pinch is continuous: it emits `pinch_move` with the vertical delta of the pinching hand.
 */
export class GestureController {
  constructor(opts = {}) {
    this.holdMs = opts.holdMs ?? 400;
    this.pinchHoldMs = opts.pinchHoldMs ?? 220;
    this.cooldownMs = opts.cooldownMs ?? 800;
    this.releaseMs = opts.releaseMs ?? 250;
    this.bothReleaseMs = opts.bothReleaseMs ?? 900;
    this.bothSoloMs = opts.bothSoloMs ?? 700;
    this.perGestureCooldown = { both_hands: 2500, ...(opts.perGestureCooldown || {}) };
    this.reset();
  }
  reset() {
    this.candidate = null; this.since = 0; this.fired = null; this.lastFire = -1e9;
    this.noneSince = 0; this.pinching = false; this.pinchStartY = 0; this.current = null;
    this.lastFireBy = {}; this.bothLatched = false; this.emptySince = 0; this.soloSince = 0; this.hand = -1;
  }
  /** @returns {Array<{type:string, gesture?:string, dy?:number, y?:number}>} */
  update(hands, now) {
    const events = [];
    const n = (hands || []).filter((h) => h && h.length >= 21).length;
    const { gesture: g, hand } = classifyFrameDetailed(hands);
    this.current = g; this.hand = hand;
    if (g !== this.candidate) { this.candidate = g; this.since = now; }
    const held = now - this.since;

    // both_hands latch (hysteresis against 2→1 hand flicker)
    if (this.bothLatched) {
      if (n === 0) { if (!this.emptySince) this.emptySince = now; } else this.emptySince = 0;
      if (n === 1) { if (!this.soloSince) this.soloSince = now; } else this.soloSince = 0;
      if ((this.emptySince && now - this.emptySince >= this.bothReleaseMs) || (this.soloSince && now - this.soloSince >= this.bothSoloMs)) {
        this.bothLatched = false; this.emptySince = this.soloSince = 0;
        if (this.fired === GESTURES.BOTH) this.fired = null;
        this.since = now; // a gesture must be held afresh after the latch ends
      }
    }

    // release tracking for ordinary gestures
    if (this.fired && this.fired !== GESTURES.BOTH && g !== this.fired) {
      if (!this.noneSince) this.noneSince = now;
      if (now - this.noneSince >= this.releaseMs) { this.fired = null; this.noneSince = 0; }
    } else this.noneSince = 0;

    // pinch (continuous)
    if (g === GESTURES.PINCH && held >= this.pinchHoldMs && !this.bothLatched) {
      const lm = hands[hand];
      const y = (lm[4].y + lm[8].y) / 2;
      if (!this.pinching) { this.pinching = true; this.pinchStartY = y; events.push({ type: 'pinch_start', gesture: g, y }); }
      else events.push({ type: 'pinch_move', gesture: g, y, dy: this.pinchStartY - y });
    } else if (this.pinching && g !== GESTURES.PINCH) {
      this.pinching = false;
      events.push({ type: 'pinch_end', gesture: GESTURES.PINCH });
    }

    const own = this.perGestureCooldown[g] ?? 0;
    if (g && g !== GESTURES.PINCH && held >= this.holdMs && this.fired !== g && !this.bothLatched
        && now - this.lastFire >= this.cooldownMs && now - (this.lastFireBy[g] ?? -1e9) >= own) {
      this.fired = g; this.lastFire = now; this.lastFireBy[g] = now;
      if (g === GESTURES.BOTH) { this.bothLatched = true; this.emptySince = this.soloSince = 0; }
      events.push({ type: 'gesture', gesture: g });
    }
    return events;
  }
  /** 0..1 hold progress for the current candidate (for UI feedback). */
  progress(now) {
    if (!this.candidate || this.candidate === this.fired || this.bothLatched) return 0;
    const need = this.candidate === GESTURES.PINCH ? this.pinchHoldMs : this.holdMs;
    return Math.max(0, Math.min(1, (now - this.since) / need));
  }
}
