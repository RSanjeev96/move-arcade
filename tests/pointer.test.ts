import { describe, expect, it } from 'vitest';
import { pickTarget, rectDist, SwipeBack, type Rect } from '../src/core/pointer';

const R = (left: number, top: number, w: number, h: number): Rect => ({ left, top, right: left + w, bottom: top + h });

describe('pickTarget', () => {
  const a = R(100, 100, 200, 60);
  const b = R(310, 100, 200, 60);
  const rects = [a, b];
  const snap = 72;

  it('measures distance to a rectangle', () => {
    expect(rectDist(150, 120, a)).toBe(0);
    expect(rectDist(90, 120, a)).toBe(10);
    expect(rectDist(97, 97, a)).toBeCloseTo(Math.hypot(3, 3));
  });

  it('captures the nearest button within the snap radius', () => {
    expect(pickTarget(200, 200, rects, -1, snap)).toBe(0);
    expect(pickTarget(200, 300, rects, -1, snap)).toBe(-1);
  });

  it('holds the current button through small wobbles onto a neighbour', () => {
    expect(pickTarget(315, 130, rects, 0, snap)).toBe(0);
    expect(pickTarget(340, 130, rects, 0, snap)).toBe(1);
  });

  it('releases only well outside the snap radius', () => {
    expect(pickTarget(200, 160 + 90, rects, 0, snap)).toBe(0);
    expect(pickTarget(200, 160 + 120, rects, 0, snap)).toBe(-1);
  });
});

describe('SwipeBack', () => {
  const run = (path: [number, number][], ms: number) => {
    const s = new SwipeBack();
    let fired = false;
    const steps = Math.round(ms / 33);
    for (let i = 0; i <= steps + 3; i++) {
      const k = Math.min(1, i / steps);
      const seg = k * (path.length - 1);
      const j = Math.min(path.length - 2, Math.floor(seg));
      const f = seg - j;
      const x = path[j][0] + (path[j + 1][0] - path[j][0]) * f;
      const y = path[j][1] + (path[j + 1][1] - path[j][1]) * f;
      fired ||= s.update(x, y, 1000 + i * 33);
    }
    return fired;
  };

  it('fires on a quick flick off the left edge', () => {
    expect(run([[0.8, 0.5], [-0.15, 0.55]], 330)).toBe(true);
  });

  it('ignores a slow reach to the left edge', () => {
    expect(run([[0.8, 0.5], [0.02, 0.5]], 600)).toBe(false);
    expect(run([[0.8, 0.5], [-0.1, 0.5]], 1500)).toBe(false);
  });

  it('ignores short or mostly vertical moves', () => {
    expect(run([[0.3, 0.5], [-0.1, 0.5]], 200)).toBe(false);
    expect(run([[0.6, 0.0], [-0.05, 0.9]], 300)).toBe(false);
  });
});
