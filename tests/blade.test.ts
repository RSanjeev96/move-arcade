import { describe, expect, it } from 'vitest';
import { analyze } from '../src/core/beat';
import { generateMap, DIFFICULTIES, PROFILES, Dir } from '../src/games/blade/mapgen';
import { judgeCut, segmentHitsSquare, Multiplier, notePos } from '../src/games/blade/hit';
import { synthForTest } from './synth';

const analysis = analyze([synthForTest(128, 0.4, 90)], 44100);

describe('map generator', () => {
  for (const d of DIFFICULTIES) {
    it(`${d}: respects spacing, parity and layout`, () => {
      const m = generateMap(analysis, d, { walls: true });
      const p = PROFILES[d];
      expect(m.notes.length).toBeGreaterThan(20);
      const nps = m.notes.length / 88;
      expect(nps).toBeLessThan(p.density * 1.3);
      for (const hand of [0, 1] as const) {
        const hn = m.notes.filter((n) => n.hand === hand);
        for (let i = 1; i < hn.length; i++) expect(hn[i].t - hn[i - 1].t).toBeGreaterThanOrEqual(p.handGap - 1e-6);
        for (const n of hn) expect(hand === 0 ? n.col <= 1 : n.col >= 2).toBe(true);
      }
      // sorted, and simultaneous notes only as left+right pairs
      for (let i = 1; i < m.notes.length; i++) {
        const dt = m.notes[i].t - m.notes[i - 1].t;
        expect(dt).toBeGreaterThanOrEqual(0);
        if (dt < 1e-6) expect(m.notes[i].hand).not.toBe(m.notes[i - 1].hand);
        else expect(dt).toBeGreaterThanOrEqual(p.anyGap - 1e-6);
      }
      for (const w of m.walls) {
        expect(m.notes.some((n) => n.t > w.t - 0.7 && n.t < w.t + w.dur + 0.6)).toBe(false);
      }
      if (d === 'easy') expect(m.walls.length).toBe(0);
      else expect(m.walls.length).toBeGreaterThan(1);
    });
  }
  it('is deterministic', () => {
    const a = generateMap(analysis, 'hard', { walls: true });
    const b = generateMap(analysis, 'hard', { walls: true });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('cut judging', () => {
  const block = notePos(1, 1);
  it('detects a downward swing through a down block', () => {
    const r = judgeCut({ x: block.x, y: block.y + 0.5 }, { x: block.x + 0.05, y: block.y - 0.5 }, 0.1, block, Dir.Down);
    expect(r.touched && r.good).toBe(true);
    expect(r.points).toBeGreaterThan(85);
  });
  it('rejects the wrong direction', () => {
    const r = judgeCut({ x: block.x, y: block.y - 0.5 }, { x: block.x, y: block.y + 0.5 }, 0.1, block, Dir.Down);
    expect(r.touched).toBe(true);
    expect(r.good).toBe(false);
  });
  it('ignores a resting hand', () => {
    const r = judgeCut({ x: block.x, y: block.y }, { x: block.x + 0.01, y: block.y }, 0.1, block, Dir.Any);
    expect(r.touched).toBe(false);
  });
  it('misses when the path is far away', () => {
    expect(segmentHitsSquare({ x: -2, y: 0 }, { x: -2, y: 3 }, block, 0.36)).toBe(false);
  });
  it('multiplier ladder', () => {
    const m = new Multiplier();
    for (let i = 0; i < 14; i++) m.hit();
    expect(m.value).toBe(8);
    m.miss();
    expect(m.value).toBe(4);
  });
});
