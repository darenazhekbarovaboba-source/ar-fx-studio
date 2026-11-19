// Settings persistence in localStorage.
import { EFFECTS, defaultSettings } from './effects.js';
const KEY = 'arfx.v1';

export function loadState() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  const settings = {};
  for (const fx of EFFECTS) {
    const def = defaultSettings(fx.id), s = saved.settings?.[fx.id] || {};
    settings[fx.id] = {};
    for (const p of fx.params) {
      let v = s[p.key];
      if (p.type === 'range') v = Number.isFinite(+v) ? Math.min(p.max, Math.max(p.min, +v)) : def[p.key];
      else if (p.type === 'toggle') v = typeof v === 'boolean' ? v : def[p.key];
      else if (p.type === 'color') v = /^#[0-9a-f]{6}$/i.test(v || '') ? v : def[p.key];
      else if (p.type === 'select') v = p.options.some((o) => o[0] === v) ? v : def[p.key];
      settings[fx.id][p.key] = v;
    }
  }
  const ids = EFFECTS.map((f) => f.id);
  return {
    settings,
    enabled: Array.isArray(saved.enabled) ? saved.enabled.filter((id) => ids.includes(id)) : ['neon'],
    active: ids.includes(saved.active) ? saved.active : 'neon',
    gestures: saved.gestures !== false,
    debug: !!saved.debug,
    mirror: ['auto', 'on', 'off'].includes(saved.mirror) ? saved.mirror : 'auto',
    perf: ['auto', 'high', 'low'].includes(saved.perf) ? saved.perf : 'auto',
    fit: ['auto', 'fill', 'fit'].includes(saved.fit) ? saved.fit : 'auto',
    faces: [1, 2, 3].includes(saved.faces) ? saved.faces : 2,
  };
}

let timer = 0;
export function saveState(state) {
  clearTimeout(timer);
  timer = setTimeout(() => saveNow(state), 150);
}
export function saveNow(state) {
  const { settings, enabled, active, gestures, debug, mirror, perf, fit, faces } = state;
  try { localStorage.setItem(KEY, JSON.stringify({ settings, enabled, active, gestures, debug, mirror, perf, fit, faces })); } catch {}
}
export const STORAGE_KEY = KEY;
