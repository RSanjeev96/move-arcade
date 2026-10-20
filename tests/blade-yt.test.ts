import { describe, expect, it } from 'vitest';
import { gridAnalysis, parseYouTubeId, tapTempo } from '../src/games/blade/clock';
import { generateMap } from '../src/games/blade/mapgen';

describe('YouTube mode helpers', () => {
  it('parses links', () => {
    for (const u of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s',
      'https://youtu.be/dQw4w9WgXcQ?si=abc',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'dQw4w9WgXcQ',
    ])
      expect(parseYouTubeId(u)).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeId('hello')).toBeNull();
  });
  it('finds tempo from taps, tolerating jitter and a skipped tap', () => {
    const period = 60 / 124;
    const taps = [0, 1, 2, 3, 5, 6, 7, 8, 9].map((k) => 3.21 + k * period + (k % 2 ? 0.02 : -0.015));
    const r = tapTempo(taps)!;
    expect(Math.abs(r.bpm - 124)).toBeLessThan(1.5);
    const phaseErr = Math.abs(((r.firstBeat - 3.21) / period) % 1);
    expect(Math.min(phaseErr, 1 - phaseErr) * period).toBeLessThan(0.03);
  });
  it('builds a playable map from a tempo grid', () => {
    const a = gridAnalysis(128, 0.4, 200);
    const m = generateMap(a, 'normal', { walls: true });
    expect(m.notes.length).toBeGreaterThan(150);
    expect(m.walls.length).toBeGreaterThan(2);
  });
});
