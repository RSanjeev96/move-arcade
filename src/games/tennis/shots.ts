/**
 * Pure swing → shot logic. A swing is described in body space (shoulder widths, +x = player's right,
 * +y = up), so it does not depend on distance to the camera.
 */
export type Handed = 'right' | 'left';
export type Stroke = 'forehand' | 'backhand';
export type ShotKind = 'flat' | 'topspin' | 'slice' | 'lob' | 'drop';
export type Difficulty = 'easy' | 'normal' | 'hard';

export interface SwingSample {
  /** Capture time (ms). */
  t: number;
  /** Racket-hand position in body space. */
  x: number;
  y: number;
}

export interface SwingFeatures {
  /** Capture time of peak hand speed (ms). */
  t: number;
  /** Peak velocity (shoulder widths per second). */
  vx: number;
  vy: number;
  speed: number;
  /** Hand position when the swing started (a few frames before the peak). */
  startX: number;
  startY: number;
  /** Hand position at the peak / end of the stroke. */
  endX: number;
  endY: number;
}

export interface SwingClass {
  stroke: Stroke;
  kind: ShotKind;
}

/** Minimum hand speed for a stroke (shoulder widths per second). */
export const MIN_SWING = 6.0;
export const MIN_SERVE = 5.0;

/**
 * Forehand: the racket hand sweeps across the body from the racket side. Backhand: it sweeps from the
 * opposite side back towards the racket side. Vertical direction picks the spin.
 */
export function classifySwing(f: SwingFeatures, handed: Handed): SwingClass {
  const s = handed === 'right' ? 1 : -1;
  // In the racket's frame: +u = towards the racket side.
  const vu = f.vx * s;
  const startU = f.startX * s;
  const horiz = Math.abs(f.vx);
  let stroke: Stroke;
  if (horiz > Math.abs(f.vy) * 0.35) stroke = vu < 0 ? 'forehand' : 'backhand';
  else stroke = startU > -0.1 ? 'forehand' : 'backhand';
  // A forehand starting far across the body is really a backhand follow-through (and vice versa).
  if (stroke === 'forehand' && startU < -0.9 && vu < 0) stroke = 'backhand';
  const up = f.vy / Math.max(1e-3, f.speed);
  let kind: ShotKind = 'flat';
  const highFinish = f.endY > 0.9;
  if (up > 0.62 || (up > 0.4 && highFinish)) kind = 'lob';
  else if (up > 0.2) kind = 'topspin';
  else if (up < -0.3) kind = f.speed < MIN_SWING * 1.45 ? 'drop' : 'slice';
  return { stroke, kind };
}

export interface Timing {
  /** Capture time minus ideal contact time, seconds (negative = early). */
  dt: number;
  /** -1 (very early) .. +1 (very late), relative to the window. */
  e: number;
  label: 'Perfect' | 'Great' | 'Early' | 'Late';
  /** 1 = perfect .. 0 = edge of the window. */
  quality: number;
}

export interface WindowSpec {
  early: number;
  late: number;
}

export const WINDOWS: Record<Difficulty, WindowSpec> = {
  easy: { early: 0.24, late: 0.24 },
  normal: { early: 0.2, late: 0.2 },
  hard: { early: 0.16, late: 0.16 },
};

export function judgeTiming(dt: number, w: WindowSpec): Timing | null {
  if (dt < -w.early || dt > w.late) return null;
  const e = dt < 0 ? dt / w.early : dt / w.late;
  const a = Math.abs(e);
  const label = a < 0.22 ? 'Perfect' : a < 0.45 ? 'Great' : e < 0 ? 'Early' : 'Late';
  return { dt, e, label, quality: 1 - a };
}

export interface ShotParams {
  kind: ShotKind;
  stroke: Stroke;
  /** Target x on the far court (m, world). */
  x: number;
  /** Target distance beyond the net (m). */
  depth: number;
  /** Launch speed (m/s). */
  speed: number;
  /** Topspin (rad/s; negative = slice). */
  spin: number;
  /** 1-sigma aim error (m). */
  error: number;
  /** Net clearance the solver should aim for. */
  clearance: number;
  high: boolean;
  /** Framed / mishit. */
  mishit: boolean;
}

export interface ShotContext {
  /** +1 when the stroke is played on the world +x side of the hitter (as seen from the near end). */
  sideSign: number;
  difficulty: Difficulty;
  /** Hitter's x position (m). */
  hitterX: number;
  /** True when the swing side did not match the ball's side. */
  wrongSide: boolean;
  /** Incoming ball speed at contact (m/s): harder balls are harder to control. */
  incoming: number;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Turn a classified, timed swing into shot parameters for the human player (near court, hitting to
 * the far court). Early contact pulls the ball cross-court, late contact pushes it down the line.
 */
export function shotFromSwing(sw: SwingClass, swingSpeed: number, timing: Timing, ctx: ShotContext): ShotParams {
  const d = ctx.difficulty;
  const pace01 = clamp((swingSpeed - MIN_SWING) / 13, 0, 1);
  const q = timing.quality;
  // Direction: early = cross-court (away from the stroke side), late = down the line.
  const e = clamp(timing.e * 1.25, -1, 1);
  let x = ctx.sideSign * e * 3.0 + -ctx.sideSign * 0.5 * (1 - Math.abs(e));
  // Hitting from a wide position naturally opens the angle a little.
  x += clamp(ctx.hitterX * 0.15, -0.6, 0.6);
  let kind = sw.kind;
  let depth = 9.6;
  let speed = lerp(21, 35, pace01) * lerp(0.86, 1, q);
  let spin = 160;
  let clearance = 0.35;
  let high = false;
  switch (kind) {
    case 'flat':
      spin = 70;
      clearance = 0.25;
      speed *= 1.04;
      break;
    case 'topspin':
      spin = lerp(220, 340, pace01);
      clearance = 0.55;
      depth = 9.9;
      break;
    case 'slice':
      spin = -lerp(120, 200, pace01);
      speed *= 0.8;
      clearance = 0.3;
      depth = 8.8;
      break;
    case 'lob':
      spin = 160;
      speed = lerp(17, 22, pace01);
      high = true;
      depth = 10.2;
      clearance = 2.5;
      break;
    case 'drop':
      spin = -180;
      speed = lerp(9, 12, pace01);
      depth = 2.6;
      clearance = 0.3;
      x *= 0.6;
      break;
  }
  // Aim error grows with lateness/earliness, pace and difficulty.
  const base = d === 'easy' ? 0.15 : d === 'normal' ? 0.52 : 0.68;
  let error = base * (0.5 + (1 - q) * 1.4) * (0.7 + pace01 * 0.6) * (1 + clamp((ctx.incoming - 18) / 25, 0, 0.6));
  let mishit = false;
  if (ctx.wrongSide && d !== 'easy') {
    // Wrong stroke for the ball's side: a weak, scrappy reply.
    speed *= 0.7;
    error *= 1.8;
    depth -= 1.6;
    mishit = d === 'hard';
  }
  if (d !== 'easy' && Math.abs(timing.e) > 0.88) {
    mishit = true;
  }
  if (mishit) {
    speed *= 0.6;
    error *= 2.2;
    spin *= 0.3;
    clearance = 0.1;
  }
  if (d === 'easy') {
    x = clamp(x, -3.2, 3.2);
    error = Math.min(error, 0.35);
  } else x = clamp(x, -3.9, 3.9);
  if (kind === 'drop' && d === 'easy') depth = 3.2;
  return { kind, stroke: sw.stroke, x, depth, speed, spin, error, clearance, high, mishit };
}

export interface ServeParams {
  speed: number;
  spin: number;
  /** -1 (towards the centre T) .. +1 (wide), as a fraction of the box. */
  aim: number;
  error: number;
}

/** Serve from a downward swing. `first` = first serve (faster, riskier). */
export function serveFromSwing(speed: number, vxRacket: number, timing: Timing, first: boolean, d: Difficulty): ServeParams {
  const p = clamp((speed - MIN_SERVE) / 12, 0, 1);
  const q = timing.quality;
  let v = first ? lerp(36, 52, p) : lerp(30, 40, p);
  v *= lerp(0.88, 1, q);
  const spin = first ? 60 : 240;
  const aim = clamp(vxRacket / Math.max(4, speed) * 1.6, -1, 1);
  const base = d === 'easy' ? 0.1 : d === 'normal' ? 0.38 : 0.5;
  const error = base * (first ? 1 : 0.6) * (0.55 + (1 - q) * 1.5) * (0.7 + p * 0.6);
  return { speed: v, spin, aim, error };
}

/** Deterministic pseudo-random generator (mulberry32) so matches and tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample from a uniform generator. */
export function gauss(r: () => number): number {
  const u = Math.max(1e-9, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Stars for a finished match. */
export function matchStars(won: boolean, pointsWon: number, pointsPlayed: number, gamesLost: number): number {
  if (!won) return pointsPlayed > 0 && pointsWon / pointsPlayed >= 0.45 ? 1 : 0;
  const pct = pointsPlayed ? pointsWon / pointsPlayed : 0;
  if (gamesLost === 0 || pct >= 0.68) return 3;
  if (pct >= 0.55) return 2;
  return 1;
}

/** Stars for a rally challenge score. */
export function rallyStars(score: number, d: Difficulty): number {
  const k = d === 'easy' ? 1 : d === 'normal' ? 1.4 : 1.8;
  if (score >= 1500 * k) return 3;
  if (score >= 700 * k) return 2;
  if (score >= 250 * k) return 1;
  return 0;
}
