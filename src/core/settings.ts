import { local } from './storage';

export type Quality = 'auto' | 'high' | 'medium' | 'low';

export interface Settings {
  /** Tracking model: lite is faster, full is steadier. */
  model: 'lite' | 'full';
  /** Assumed camera delay when the browser gives no capture time (ms). */
  trackDelay: number;
  /** Extra audio delay, e.g. for TVs or Bluetooth speakers (ms). */
  audioOffset: number;
  quality: Quality;
  showCamera: boolean;
  musicVolume: number;
  sfxVolume: number;
}

const DEFAULTS: Settings = {
  model: 'lite',
  trackDelay: 60,
  audioOffset: 0,
  quality: 'auto',
  showCamera: true,
  musicVolume: 0.9,
  sfxVolume: 0.7,
};

const KEY = 'ma.settings';

export function loadSettings(): Settings {
  return local.get(KEY, DEFAULTS);
}

export function saveSettings(s: Settings): void {
  local.set(KEY, s);
}
