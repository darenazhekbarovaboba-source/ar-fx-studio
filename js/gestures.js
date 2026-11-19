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

/** Classify a frame (array of hands). Two hands visible => both_hands. */
export function classifyFrame(hands) {
  if (!hands || hands.length === 0) return null;
  if (hands.length >= 2) return GESTURES.BOTH;
  return classifyHand(hands[0]);
}

/**
 * Debounced gesture controller. Feed it hands per detection; it returns events.
 * One-shot gestures fire once after being held `holdMs`, then must be released
 * before they can fire again; a global cooldown separates one-shot events.
 * Pinch is continuous: it emits `pinch_move` with the vertical delta.
 */
export class GestureController {
  constructor(opts = {}) {
    this.holdMs = opts.holdMs ?? 400;
    this.pinchHoldMs = opts.pinchHoldMs ?? 220;
    this.cooldownMs = opts.cooldownMs ?? 800;
    this.releaseMs = opts.releaseMs ?? 150;
    this.reset();
  }
  reset() {
    this.candidate = null; this.since = 0; this.fired = null; this.lastFire = -1e9;
    this.noneSince = 0; this.pinching = false; this.pinchStartY = 0; this.current = null;
  }
  /** @returns {Array<{type:string, gesture?:string, dy?:number, y?:number}>} */
  update(hands, now) {
    const events = [];
    const g = classifyFrame(hands);
    this.current = g;
    if (g !== this.candidate) { this.candidate = g; this.since = now; }
    const held = now - this.since;

    // release tracking: allow re-fire after the fired gesture has been gone for releaseMs
    if (this.fired && g !== this.fired) {
      if (!this.noneSince) this.noneSince = now;
      if (now - this.noneSince >= this.releaseMs) { this.fired = null; this.noneSince = 0; }
    } else this.noneSince = 0;

    // pinch (continuous)
    if (g === GESTURES.PINCH && held >= this.pinchHoldMs) {
      const lm = hands[0];
      const y = (lm[4].y + lm[8].y) / 2;
      if (!this.pinching) {
        this.pinching = true; this.pinchStartY = y;
        events.push({ type: 'pinch_start', gesture: g, y });
      } else {
        events.push({ type: 'pinch_move', gesture: g, y, dy: this.pinchStartY - y });
      }
    } else if (this.pinching && g !== GESTURES.PINCH) {
      this.pinching = false;
      events.push({ type: 'pinch_end', gesture: GESTURES.PINCH });
    }

    if (g && g !== GESTURES.PINCH && held >= this.holdMs && this.fired !== g && now - this.lastFire >= this.cooldownMs) {
      this.fired = g; this.lastFire = now;
      events.push({ type: 'gesture', gesture: g });
    }
    return events;
  }
  /** 0..1 hold progress for the current candidate (for UI feedback). */
  progress(now) {
    if (!this.candidate || this.candidate === this.fired) return 0;
    const need = this.candidate === GESTURES.PINCH ? this.pinchHoldMs : this.holdMs;
    return Math.min(1, (now - this.since) / need);
  }
}
