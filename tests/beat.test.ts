import { describe, expect, it } from 'vitest';
import { analyze } from '../src/core/beat';

function synth(bpm: number, offset: number, seconds: number, sr = 44100, swing = 0): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sr));
  const period = 60 / bpm;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 0.01;
  for (let b = 0; offset + b * period < seconds - 0.3; b++) {
    const t0 = offset + b * period;
    const kick = Math.floor(t0 * sr);
    for (let i = 0; i < sr * 0.15 && kick + i < out.length; i++) {
      const t = i / sr;
      out[kick + i] += Math.sin(2 * Math.PI * (120 - 400 * t) * t) * Math.exp(-t * 25) * 0.9;
    }
    // off-beat hats
    const hat = Math.floor((t0 + period / 2 + swing) * sr);
    for (let i = 0; i < sr * 0.04 && hat + i < out.length; i++) out[hat + i] += rnd() * Math.exp(-(i / sr) * 120) * 0.25;
  }
  return out;
}

describe('beat analysis', () => {
  for (const [bpm, offset] of [
    [128, 0.37],
    [96, 1.1],
    [150, 0.5],
    [174, 0.2],
  ] as const) {
    it(`finds ${bpm} BPM and its beats`, () => {
      const a = analyze([synth(bpm, offset, 40)], 44100);
      // Half or double tempo is musically valid (half-time feel); the map generator handles both.
      const ratio = [1, 0.5, 2].find((m) => Math.abs(a.bpm - bpm * m) < 2.5 * m);
      expect(ratio).toBeDefined();
      const period = 60 / bpm;
      const errs = a.beats.slice(2, -2).map((b) => {
        const k = Math.round((b - offset) / period);
        return Math.abs(b - (offset + k * period));
      });
      const median = errs.sort((x, y) => x - y)[Math.floor(errs.length / 2)];
      expect(median).toBeLessThan(0.03);
      expect(a.beats.length).toBeGreaterThan(((40 - offset) / period) * (ratio ?? 1) - 4);
      expect(a.onsets.length).toBeGreaterThan(10);
    });
  }
});
