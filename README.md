# AR FX Studio

Real-time AR camera effects in the browser. Your webcam feed is tracked with **MediaPipe Face Landmarker** (478 face landmarks incl. irises) and **MediaPipe Hand Landmarker** (2 hands × 21 landmarks), and 12 effects are drawn on an HTML canvas — controlled by buttons, keyboard, or **hand gestures**.

**Live:** https://darenazhekbarovaboba-source.github.io/ar-fx-studio/

Plain HTML5 / CSS3 / JavaScript (ES modules). No frameworks, no build step, no server: all processing happens on your device and no video or image is ever uploaded.

## Features

- Live camera (WebRTC `getUserMedia`), front/back switching when the device has more than one camera, mirrored selfie preview
- Real face tracking + real hand tracking (MediaPipe Tasks Vision `@mediapipe/tasks-vision@1.2.3`, VIDEO mode, GPU delegate with automatic CPU fallback)
- 12 effects that can be stacked; each has its own persisted settings (intensity, speed, color, size, opacity, animation speed — whichever apply)
- Gesture controls with hold-to-confirm, cooldown and an on-screen hold ring + toast; can be switched off
- Screenshot (PNG), video recording (MP4 or WebM, whichever the browser supports) with timer, fullscreen
- Loading screen with real download progress for the runtime and both models; clear errors and Retry for permission denied, no camera, camera in use, insecure (non-HTTPS) page and model download failures
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

## Gestures

Hold a gesture for ~0.4 s (a ring fills while it is recognised). Each gesture fires once, then must be released.

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

<kbd>←</kbd>/<kbd>→</kbd> select effect · <kbd>Space</kbd> toggle · <kbd>↑</kbd>/<kbd>↓</kbd> intensity · <kbd>B</kbd> burst · <kbd>P</kbd> screenshot · <kbd>R</kbd> record · <kbd>F</kbd> fullscreen · <kbd>G</kbd> gestures · <kbd>S</kbd> settings · <kbd>?</kbd> guide · <kbd>Esc</kbd> close panels

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

URL options: `?cpu=1` forces the CPU backend, `?gpu=1` forces the GPU backend, `?manualblur=1` forces the blur fallback.

### Tests

```bash
node tests/gestures.test.mjs   # gesture classifier + debounce/cooldown/pinch logic on synthetic landmarks
```

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
js/store.js         localStorage persistence
tests/              Unit tests for gestures
```

## Known limitations

- Head pose (yaw / pitch / roll) is estimated from 2D landmarks, so it is approximate.
- Tracks one face (the effects are built for a single subject) and up to two hands.
- Speed depends on the device; low-end phones may run at reduced resolution (adaptive) or lower FPS.
- Front/back switching needs a device that exposes more than one camera.
