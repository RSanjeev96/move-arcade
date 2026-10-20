import { Dir, DIR_VEC } from './mapgen';
import type { V2 } from '../../core/types';

/** World layout of the block grid at the hit plane. */
export const GRID = {
  colX: [-0.75, -0.25, 0.25, 0.75],
  rowY: [0.95, 1.4, 1.85],
  /** Block edge length. */
  size: 0.46,
  /** Extra reach around a block that still counts as a hit (camera tracking is not millimetre-exact). */
  margin: 0.15,
  /** z of the plane where blocks are cut. */
  hitZ: -0.6,
};

/** Body space (shoulder widths) to world space (metres-ish). */
export const BODY_TO_WORLD = { scale: 0.45, y0: 1.45 };

export function bodyToWorld(p: V2): V2 {
  return { x: p.x * BODY_TO_WORLD.scale, y: BODY_TO_WORLD.y0 + p.y * BODY_TO_WORLD.scale };
}

export function notePos(col: number, row: number): V2 {
  return { x: GRID.colX[col], y: GRID.rowY[row] };
}

/** Does segment a→b touch the axis-aligned square centred at c with half-size h? (Liang–Barsky) */
export function segmentHitsSquare(a: V2, b: V2, c: V2, h: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, a.x - (c.x - h)) &&
    clip(dx, c.x + h - a.x) &&
    clip(-dy, a.y - (c.y - h)) &&
    clip(dy, c.y + h - a.y) &&
    t0 <= t1
  );
}

/** Perpendicular distance from point c to the infinite line through a and b. */
function lineDistance(a: V2, b: V2, c: V2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return Math.hypot(c.x - a.x, c.y - a.y);
  return Math.abs(dy * (c.x - a.x) - dx * (c.y - a.y)) / len;
}

export const MIN_SWING_SPEED = 1.1;
/** cos(70°): how far off the arrow a swing may be and still count. */
export const DIR_TOLERANCE = 0.34;

export interface CutResult {
  /** The hand path crossed the block fast enough to count as a swing. */
  touched: boolean;
  /** The swing direction matched the arrow. */
  good: boolean;
  /** 0..100 points before the combo multiplier. */
  points: number;
  /** Swing speed in world units per second. */
  speed: number;
}

/**
 * Judge one tracked hand movement (a → b over dt seconds) against a block.
 * Returns touched=false when the hand did not pass through the block with a real swing.
 */
export function judgeCut(a: V2, b: V2, dt: number, block: V2, dir: Dir): CutResult {
  const half = GRID.size / 2 + GRID.margin;
  if (!segmentHitsSquare(a, b, block, half)) return { touched: false, good: false, points: 0, speed: 0 };
  const vx = (b.x - a.x) / Math.max(dt, 1e-3);
  const vy = (b.y - a.y) / Math.max(dt, 1e-3);
  const speed = Math.hypot(vx, vy);
  if (speed < MIN_SWING_SPEED) return { touched: false, good: false, points: 0, speed };
  let q1 = 1;
  if (dir !== Dir.Any) {
    const [ux, uy] = DIR_VEC[dir];
    const cos = (vx * ux + vy * uy) / speed;
    if (cos < DIR_TOLERANCE) return { touched: true, good: false, points: 0, speed };
    q1 = Math.min(1, (cos - DIR_TOLERANCE) / 0.56);
  }
  const q2 = 1 - Math.min(1, lineDistance(a, b, block) / half);
  const q3 = Math.min(1, speed / 3.5);
  const points = Math.round(55 + 20 * q1 + 15 * q2 + 10 * q3);
  return { touched: true, good: true, points, speed };
}

export type Judgement = 'Perfect' | 'Great' | 'Good';

export function judgement(points: number): Judgement {
  if (points >= 90) return 'Perfect';
  if (points >= 78) return 'Great';
  return 'Good';
}

/** Combo multiplier ladder: x1 → x2 after 2 hits, → x4 after 4 more, → x8 after 8 more. */
export class Multiplier {
  level = 0;
  progress = 0;
  static readonly STEPS = [2, 4, 8];
  get value(): number {
    return 1 << this.level;
  }
  /** 0..1 progress towards the next level. */
  get fill(): number {
    return this.level >= 3 ? 1 : this.progress / Multiplier.STEPS[this.level];
  }
  hit(): boolean {
    if (this.level >= 3) return false;
    this.progress++;
    if (this.progress >= Multiplier.STEPS[this.level]) {
      this.level++;
      this.progress = 0;
      return true;
    }
    return false;
  }
  miss(): void {
    if (this.level > 0) this.level--;
    this.progress = 0;
  }
  reset(): void {
    this.level = 0;
    this.progress = 0;
  }
}

export function rank(accuracy: number): string {
  if (accuracy >= 0.9) return 'SS';
  if (accuracy >= 0.8) return 'S';
  if (accuracy >= 0.65) return 'A';
  if (accuracy >= 0.5) return 'B';
  if (accuracy >= 0.35) return 'C';
  return 'D';
}

export function stars(accuracy: number, cleared: boolean): number {
  if (!cleared) return 0;
  if (accuracy >= 0.8) return 3;
  if (accuracy >= 0.6) return 2;
  return 1;
}
