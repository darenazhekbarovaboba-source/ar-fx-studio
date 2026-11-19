# AR FX Studio

Real-time AR camera effects in the browser. Your webcam feed is tracked with **MediaPipe Face Landmarker** (478 face landmarks incl. irises) and **MediaPipe Hand Landmarker** (2 hands × 21 landmarks), and drawn on an HTML canvas. The headline mode is the **Hand Portal**: frame your face with both hands to open a portal (Magnify, Pixel, Red …), drop and re-frame to switch it, pinch with both hands to pull a ribbon of colourful TV static across your eyes, and get a Blue Face whenever your hands are out of view. The 12 classic face effects are one tab away.

**Live:** https://darenazhekbarovaboba-source.github.io/ar-fx-studio/

Plain HTML5 / CSS3 / JavaScript (ES modules). No frameworks, no build step, no server: all processing happens on your device and no video or image is ever uploaded.

## Hand Portal (default)

| What you do | What you get |
|---|---|
| **Frame your face** with both hands: index fingers up, thumbs pointing in (two “L” shapes) | A **portal**: a quad whose 4 corners are your two index fingertips and two thumb tips, filled with the current fill |
| **Drop your hands (~0.6 s), close the frame (thumbs back to your index fingers), or re-frame somewhere clearly different** | The **next fill** — Magnify → Pixel → Red, as hard cuts (or all 7 fills, or off — see settings). Tracking flicker shorter than ~0.5 s (a hand lost for a moment, a brief mis-read as a pinch, a collapsed thumb reading) keeps the portal and the fill |
| **Pinch** with both hands near your eyes and **pull apart** | A **static ribbon** between the two pinch points: starts as a fine, greenish static visor across the eyes (also when a pinching hand sits at the very frame edge, and through ~0.9 s tracking loss), stretches as you pull and tapers toward the hand that pulls away (the other end stays square), filled with fast saturated TV static |
| **Neither a frame nor a pinch** (no hands, or idle hands in view) | **Blue Face** — a bright semi-transparent tint masked to the face mesh (forehead, cheeks, nose, chin, lips, eyes); background and clothes untouched; colour selectable |

With a face in view the frame has to be around it (a frame held on the chest is ignored), and a collapsed "triangle" reading where both thumbs land on one point is rejected while the last good trapezoid is held.

Portal fills: **Magnify** (crisp 1.4–1.6× zoom centred on the frame, natural exposure, subtle bulge, thin near-white 1.5–3 px edge with a faint warm glow), **Pixel** (big mosaic), **Red** (face-centred deep red that warms to orange / yellow / yellow-green toward the frame's sides, like the reference), plus bonus fills that reuse the effect engine: **Glitch** (RGB glitch), **Static**, **Rainbow** (colour split stripes), **Invert**.

How it works:

- The quad's corners come from the two hands' thumb tip (landmark 4) and index tip (8), smoothed with a **One Euro filter** (low jitter at rest, low lag when moving; “Hand smoothing” setting) and ordered by angle around their centroid so the polygon is never self-intersecting — whichever way the hands cross, and whether or not the preview is mirrored.
- Pose rules use distances in palm lengths (wrist → middle-finger knuckle), so they work at any distance from the camera: an “L” is thumb↔index > 1.0 palm (released below 0.8), a pinch is < 0.24 (released above 0.36).
- **Why re-frame to switch:** it is what the reference video does (hands drop, then a new fill appears) and it never fires by accident while you hold a frame. A frame only counts as *re-formed* after it was gone for ~0.3 s (150 ms grace for tracking drop-outs + 150 ms release), and fills switch at most every 0.5 s. You can also tap a fill, press <kbd>1</kbd>–<kbd>7</kbd> or <kbd>←</kbd>/<kbd>→</kbd>.
- Priority: two-hand pinch (ribbon) → two-hand frame (portal) → no hands for 250 ms (Blue Face) → otherwise nothing.
- Fast path: while the Portal tab is active the hand landmarker runs on every camera frame (classic gestures run every 2nd frame); all buffers are reused and the colourful static comes from 8 pre-rendered noise tiles.
- The dock switch turns the portal on/off, the slider sets the fill strength, the colour picker sets the Blue Face colour; the settings sheet has the re-frame cycle, the magnify border, Blue Face / ribbon on/off, ribbon grain and smoothing. Classic effects you turn on in the Effects tab keep rendering underneath the portal; classic gestures are paused while the Portal tab is open (so framing your face doesn't toggle effects).

## Features

- Live camera (WebRTC `getUserMedia`), front/back switching (several cameras, or front/back `facingMode` on phones), mirrored selfie preview
- Preview fills portrait phone screens (crops the camera frame; effects stay locked to the face) — or shows the whole frame, selectable in settings
- Tracks up to 3 faces (default 2): face effects are applied to every tracked face
- Real face tracking + real hand tracking (MediaPipe Tasks Vision `@mediapipe/tasks-vision@1.2.3`, VIDEO mode, GPU delegate with automatic CPU fallback)
- Hand Portal mode (above) + 12 classic effects that can be stacked; each has its own persisted settings (intensity, speed, color, size, opacity, animation speed — whichever apply)
- Gesture controls with hold-to-confirm, cooldown and an on-screen hold ring + toast; can be switched off
- Screenshot (PNG) and video recording (MP4 or WebM, whichever the browser supports) at the camera's full native resolution, even when the live preview is running at reduced resolution; fullscreen
- Loading screen with real download progress for the runtime and both models; downloads time out (no data for 20 s, or 2 min total) instead of hanging; clear errors and Retry for permission denied, no camera, camera in use, unsupported camera mode, insecure (non-HTTPS) page and model/CDN failures
- FPS / face / hand / backend status, adaptive render resolution when FPS drops, processing paused while the tab is hidden
- Optional landmark debug overlay; keyboard shortcuts; mobile-first responsive layout

## Effects

| # | Effect | What it does | Settings |
|---|--------|--------------|----------|
| 1 | Face Pixelation | Pixelates the face oval (or box) | block size, mask size, opacity, shape |
| 2 | Eye Pixelation | Pixelates only the eyes, or a rotated censor bar | block size, region size, opacity, shape |
| 3 | Face Blur | Blurs the face oval (native canvas filter; manual down/up-scale fallback for browsers without `ctx.filter`) | blur amount, mask size, opacity |
| 4 | RGB Glitch | R/G/B channel separation plus random slice displacement and digital blocks | offset, glitch rate, slice height, area, opacity |
| 5 | Neon Face | Glowing outline of face oval, eyes, brows, lips and nose | glow, line width, color, rainbow cycle, animation speed, detail, opacity |
| 6 | Geometric Mask | Triangles, squares and hexagons orbiting the head, following head roll/yaw/pitch | orbit radius, shape count, size, speed, color, style, opacity |
| 7 | Laser Eyes | Beams and glow from the irises, aimed by head pose | glow, beam width, length, color, flicker speed, opacity |
| 8 | Color Split | Face divided into colored stripes, bands or rotating pie sectors | strength, sections, layout, color, animation speed, blend, opacity |
| 9 | Digital Static | TV noise (pre-computed noise tiles), rolling bar, scanlines | amount, grain size, flicker speed, area, scanlines, tint, opacity |
| 10 | Face Scanner | Landmark mesh, sweeping scan line, corner brackets and live pose HUD | mesh brightness, scan speed, HUD size, color, mesh, HUD text, opacity |
| 11 | Mirror Distortion | Animated wave / ripple warp, or a moving mirror axis | distortion, wavelength, speed, mode, opacity |
| 12 | Color Flash | Cycling RGB light, R/G/B steps or strobe | strength, speed, mode, color, area, blend, opacity |

Tap an effect to select it and turn it on; tap the selected effect again to turn it off. Several effects can be on at once. The intensity slider and color picker in the dock control the selected effect; the settings panel (sliders icon) shows all of its options.

## Gestures (Effects tab)

Hold a gesture for ~0.4 s (a ring fills while it is recognised). Each gesture fires once, then must be released.

With two hands in view, a clear one-hand gesture (fist, two/three fingers, pinch) from either hand still works; otherwise two hands count as **Both hands**. Both hands fires once and stays latched until your hands leave the frame (or you keep just one hand up for ~0.7 s), so tracking flicker cannot re-trigger it; it also has a 2.5 s cooldown.

| Gesture | Action |
|---------|--------|
| 🖐 Open palm (4 fingers up) | Turn the selected effect on / off |
| ✊ Closed fist | Trigger an animation burst (every effect reacts) |
| ✌️ Two fingers (index + middle) | Next effect |
| 🤟 Three fingers (index + middle + ring) | Previous effect |
| 🤏 Pinch (thumb + index tip) then move up / down | Raise / lower intensity |
| 🙌 Both hands visible | Cycle the effect color |

Gesture controls can be disabled with the hand button in the top bar, the toggle in settings, or <kbd>G</kbd>. When they are off, hand tracking stops entirely to save power.

### Keyboard

<kbd>T</kbd> Portal / Effects tab · <kbd>←</kbd>/<kbd>→</kbd> select fill or effect · <kbd>1</kbd>–<kbd>7</kbd> portal fill · <kbd>Space</kbd> toggle portal or effect · <kbd>↑</kbd>/<kbd>↓</kbd> strength / intensity · <kbd>B</kbd> burst · <kbd>P</kbd> screenshot · <kbd>R</kbd> record · <kbd>F</kbd> fullscreen · <kbd>G</kbd> gestures · <kbd>S</kbd> settings · <kbd>?</kbd> guide · <kbd>Esc</kbd> close panels

## Usage

1. Open the live site (HTTPS is required for camera access).
2. Wait for the engine to load (≈ 12 MB the first time, cached afterwards).
3. Press **Start camera** and allow camera access.
4. Pick effects, adjust them, use gestures, take screenshots or record.

## Run locally

Any static file server works; `localhost` counts as a secure context, so the camera is allowed.

```bash
git clone https://github.com/darenazhekbarovaboba-source/ar-fx-studio.git
cd ar-fx-studio
npx serve .            # or: python3 -m http.server 8080
# open http://localhost:3000 (serve) or http://localhost:8080 (python)
```

Opening `index.html` directly from disk (`file://`) will not work because ES modules and the camera need an http(s) origin.

URL options: `?cpu=1` forces the CPU backend, `?gpu=1` forces the GPU backend, `?manualblur=1` forces the blur fallback, `?timeout=<ms>` shortens download timeouts (testing).

### Tests

```bash
node tests/gestures.test.mjs   # gesture classifier + debounce/cooldown/pinch logic on synthetic landmarks
node tests/portal.test.mjs     # Hand Portal: quad ordering, One Euro smoothing, ribbon geometry, re-frame mode switching
```

The end-to-end browser suite feeds a real clip of hands framing a face as the fake webcam and checks, through `window.__fx`, that the portal quad is detected, every fill changes the pixels inside the quad only, the fill auto-switches on re-frame, Blue Face appears with no hands, and the pinch ribbon renders between the pinch points (`__fx.test.diffPortal(kind)`, `__fx.test.setHands(landmarks)` for synthetic hands).

The app exposes `window.__fx` (face/hand counts, current and last gesture, FPS, backend, last screenshot/recording) for automated browser testing.

## Browser support

- **Chrome / Edge (desktop & Android):** full support (GPU backend, MP4 or WebM recording).
- **Firefox:** supported; recording saves WebM.
- **Safari (macOS / iOS 15+):** supported; recording saves MP4. On iPhone, element fullscreen is not available, so the fullscreen button switches to an in-page fullscreen layout. Older Safari versions without `ctx.filter` use the built-in blur fallback.
- Needs WebAssembly, ES modules and `getUserMedia`. On machines with only software WebGL the app automatically uses the CPU backend.

## Privacy

Video frames are processed locally in your browser by MediaPipe (WebAssembly / WebGL). Nothing is uploaded or stored on a server. Screenshots and recordings are saved straight to your device. Settings are kept in `localStorage`. The only network requests are for the app files, the MediaPipe library (jsDelivr) and the two official model files (Google Cloud Storage).

## Structure

```
index.html          UI markup
css/style.css       Styles (palette #050505, #FFFFFF, #241B17, #49372D, greys)
js/app.js           Main controller: camera → tracking → effects → canvas, UI, capture
js/tracker.js       MediaPipe loading (with progress), GPU/CPU delegate selection
js/camera.js        getUserMedia, device switching, error messages
js/face.js          Face landmark geometry (indices, bounding box, head pose)
js/effects.js       The 12 effects and their settings schema
js/gestures.js      Gesture classifier + debounced gesture controller
js/portal.js        Hand Portal logic (pure): pose rules, quad ordering, One Euro filter, ribbon geometry, mode switching
js/portalfx.js      Hand Portal drawing: portal fills, Blue Face, static ribbon
js/store.js         localStorage persistence
tests/              Unit tests for gestures and the Hand Portal
```

## Known limitations

- Hand Portal needs both hands fully in view; fingers cut off by the frame edge (as in a close-up pinch at the screen edge) cannot be tracked.
- Blue Face covers the face mesh only (MediaPipe has no neck/ears landmarks).
- Head pose (yaw / pitch / roll) is estimated from 2D landmarks, so it is approximate.
- Faces that are small in the frame (roughly under 1/10 of the frame width) may not be detected; the face detector is a short-range model.
- "Fill screen" crops the camera frame, so a face near the left/right edge of a landscape camera can fall outside a portrait preview; captures match what you see.
- Respects `prefers-reduced-motion` by slowing all effect animation and disabling strobe/flash bursts.
- Speed depends on the device; low-end phones may run at reduced resolution (adaptive) or lower FPS.
- Front/back switching needs a device that exposes more than one camera.
