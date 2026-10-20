/**
 * Swing detection from both wrists and contact judging (timing + height → shot). Pure logic.
 *
 * The player faces the TV and sweeps both hands together across the body. A right-hander sweeps from their
 * right to their left; the peak hand speed is the moment the bat meets the ball.
 */
import type { V2 } from '../../core/types';
import type { Difficulty } from './delivery';
import { clamp, type Sport, type V3 } from './physics';
import type { Rng } from './rng';

export interface Swing {
  /** Capture time (ms, performance.now clock) of the peak grip speed. */
  t: number;
  /** Peak grip speed in shoulder widths per second. */
  speed: number;
  /** +1 for a right-to-left sweep (right-handed), -1 for left-to-right. */
  dir: 1 | -1;
  /** Grip height in body space at the peak (0 = shoulders, -1.5 ≈ hips). */
  gripY: number;
  /** Vertical direction of the sweep at the peak: -1 chopping down … +1 swinging up. */
  up: number;
  /** Horizontal distance covered while the hands were fast (shoulder widths). */
  travel: number;
}

interface SpeedSample {
  t: number;
  s: number;
  vx: number;
  vy: number;
  g: V2;
}

/**
 * Turns a stream of grip positions (midpoint of both wrists, body space) into swing events at peak speed.
 * Frame rate independent: velocities are computed from capture timestamps, the peak time is refined with a
 * parabola through the samples around the fastest one.
 */
export class SwingTracker {
  private prev: { t: number; g: V2 } | null = null;
  private samples: SpeedSample[] = [];
  private raw: { t: number; g: V2 }[] = [];
  private active = false;
  private startT = 0;
  private sumDx = 0;
  private peak: SpeedSample | null = null;
  private lastEnd = -1e9;
  /** Latest grip speed and velocity. */
  speed = 0;
  vel: V2 = { x: 0, y: 0 };
  lastT = 0;

  constructor(
    public minSpeed = 5,
    public minTravel = 0.7,
    public cooldownMs = 280,
  ) {}

  reset(): void {
    this.prev = null;
    this.samples = [];
    this.raw = [];
    this.active = false;
    this.peak = null;
    this.speed = 0;
    this.vel = { x: 0, y: 0 };
  }

  /** Hands are moving fast or a swing is in progress (used to hold the ball at the bat while we wait). */
  intent(now: number): boolean {
    return this.active || (this.speed > 2.8 && now - this.lastT < 220);
  }

  get swinging(): boolean {
    return this.active;
  }

  update(t: number, g: V2 | null): Swing | null {
    if (!g) {
      const out = this.active ? this.finish(t) : null;
      this.prev = null;
      this.speed = 0;
      return out;
    }
    const prev = this.prev;
    this.prev = { t, g: { ...g } };
    this.raw.push({ t, g: { ...g } });
    if (this.raw.length > 24) this.raw.shift();
    if (!prev) return null;
    const dt = (t - prev.t) / 1000;
    if (dt <= 0) return null;
    if (dt > 0.3) {
      this.active = false;
      this.peak = null;
      return null;
    }
    const vx = (g.x - prev.g.x) / dt;
    const vy = (g.y - prev.g.y) / dt;
    // The sweep across the body is what meets the ball: weight horizontal speed, so the peak lands at the
    // bottom of the arc rather than on the fast downswing from the back-lift.
    const s = Math.hypot(vx, 0.35 * vy);
    this.speed = s;
    this.vel = { x: vx, y: vy };
    this.lastT = t;
    const smp: SpeedSample = { t: (t + prev.t) / 2, s, vx, vy, g: { x: (g.x + prev.g.x) / 2, y: (g.y + prev.g.y) / 2 } };
    this.samples.push(smp);
    if (this.samples.length > 24) this.samples.shift();

    if (!this.active) {
      if (s >= this.minSpeed && Math.abs(vx) >= 0.45 * s && t - this.lastEnd > this.cooldownMs) {
        this.active = true;
        this.startT = smp.t;
        this.sumDx = g.x - prev.g.x;
        this.peak = smp;
      }
      return null;
    }
    const dx = g.x - prev.g.x;
    const reversed = Math.sign(dx) !== Math.sign(this.sumDx) && Math.abs(vx) > 2.5;
    if (!reversed) this.sumDx += dx;
    if (!reversed && s > this.peak!.s) this.peak = smp;
    if (s < 0.6 * this.peak!.s || reversed || smp.t - this.startT > 650) {
      const out = this.finish(t);
      // A wind-up that turns straight into the real swing: start tracking the new direction at once.
      if (reversed && !out && s >= this.minSpeed && Math.abs(vx) >= 0.45 * s) {
        this.active = true;
        this.startT = smp.t;
        this.sumDx = dx;
        this.peak = smp;
      }
      return out;
    }
    return null;
  }

  private finish(t: number): Swing | null {
    this.active = false;
    const pk = this.peak;
    this.peak = null;
    if (!pk || pk.s < this.minSpeed || Math.abs(this.sumDx) < this.minTravel) return null;
    this.lastEnd = t;
    const i = this.samples.indexOf(pk);
    let tp = pk.t;
    if (i > 0 && i < this.samples.length - 1) {
      const a = this.samples[i - 1];
      const c = this.samples[i + 1];
      const num = (pk.t - a.t) ** 2 * (pk.s - c.s) - (pk.t - c.t) ** 2 * (pk.s - a.s);
      const den = (pk.t - a.t) * (pk.s - c.s) - (pk.t - c.t) * (pk.s - a.s);
      if (Math.abs(den) > 1e-9) tp = clamp(pk.t - 0.5 * (num / den), a.t, c.t);
    }
    // Grip height at the refined peak time, from the raw tracked positions.
    let gy = pk.g.y;
    for (let k = 1; k < this.raw.length; k++) {
      const a = this.raw[k - 1];
      const b = this.raw[k];
      if (a.t <= tp && b.t >= tp && b.t > a.t) {
        gy = a.g.y + (b.g.y - a.g.y) * ((tp - a.t) / (b.t - a.t));
        break;
      }
    }
    return {
      t: tp,
      speed: Math.hypot(pk.vx, pk.vy) * 0.6 + pk.s * 0.4,
      dir: this.sumDx < 0 ? 1 : -1,
      gripY: gy,
      up: clamp(pk.vy / Math.max(1e-3, pk.s), -1, 1),
      travel: Math.abs(this.sumDx),
    };
  }
}

// ---- judging -------------------------------------------------------------------------------------------

/** Timing windows in ms (|swing − arrival|) at Normal difficulty. */
export const WINDOWS = { perfect: 45, good: 120, edge: 220 };
/** Window and height tolerance scale per difficulty. */
export const TOLERANCE: Record<Difficulty, number> = { easy: 1.25, normal: 1, hard: 0.85 };
/** Height tolerances (m) for swing height − ball height at Normal. */
export const HEIGHT = { over: 0.42, ground: 0.14, middle: -0.1, lofted: -0.28, topEdge: -0.42 };

/** Height of the bat's sweet spot (m) when the grip is at body-space height gripY. */
export function swingHeight(gripY: number): number {
  return clamp(0.6 + 0.55 * (gripY + 1.15), 0.04, 2.2);
}

/** Inverse of swingHeight (used by the demo bot). */
export function gripForHeight(h: number): number {
  return (h - 0.6) / 0.55 - 1.15;
}

export type Timing = 'early' | 'perfect' | 'late';
export type Grade = 'perfect' | 'good' | 'edge' | 'miss';
export type Vert = 'middle' | 'ground' | 'lofted' | 'topEdge' | 'over' | 'under';

export interface Judgement {
  /** Swing peak minus ball arrival in ms (negative = early). */
  timingMs: number;
  timing: Timing;
  grade: Grade;
  vert: Vert;
  /** Swing height minus ball height (m). */
  heightDiff: number;
  hit: boolean;
  /** Middle of the bat with perfect timing: slow-motion moment. */
  sweet: boolean;
  /** 0..1 from swing speed. */
  power: number;
}

export function powerOf(speed: number): number {
  return clamp((speed - 4) / 11, 0.12, 1);
}

export function judge(swing: Swing, arrivalMs: number, ballH: number, diff: Difficulty): Judgement {
  const k = TOLERANCE[diff];
  const dt = swing.t - arrivalMs;
  const a = Math.abs(dt);
  const grade: Grade = a <= WINDOWS.perfect * k ? 'perfect' : a <= WINDOWS.good * k ? 'good' : a <= WINDOWS.edge * k ? 'edge' : 'miss';
  const timing: Timing = a <= WINDOWS.perfect * k ? 'perfect' : dt < 0 ? 'early' : 'late';
  const d = swingHeight(swing.gripY) - ballH;
  const kv = k * 1.08 - 0.08; // height tolerance scales a little less than timing
  const vert: Vert =
    d > HEIGHT.over * kv
      ? 'over'
      : d > HEIGHT.ground * kv
        ? 'ground'
        : d >= HEIGHT.middle * kv
          ? 'middle'
          : d >= HEIGHT.lofted * kv
            ? 'lofted'
            : d >= HEIGHT.topEdge * kv
              ? 'topEdge'
              : 'under';
  const power = powerOf(swing.speed);
  const hit = grade !== 'miss' && vert !== 'over' && vert !== 'under';
  return { timingMs: dt, timing, grade, vert, heightDiff: d, hit, sweet: hit && grade === 'perfect' && vert === 'middle' && power >= 0.45, power };
}

export interface Shot {
  /** Exit speed m/s. */
  speed: number;
  /** Launch angle (deg above horizontal). */
  launch: number;
  /** Azimuth (deg): 0 = straight back past the bowler, + = towards +x. */
  azimuth: number;
  /** Backspin lift factor (multiplies the ball's hitLift). */
  lift: number;
  edge: boolean;
  quality: number;
}

/**
 * Exit velocity of the ball. Timing sets the direction (early → pulled to the leg/left side for a right-hander,
 * late → off/right side, perfect → straight), height sets the launch angle, swing speed sets the power.
 */
export function shotFrom(j: Judgement, swing: Swing, ball: { p: V3; v: V3 }, sport: Sport, diff: Difficulty, rng: Rng): Shot {
  const k = TOLERANCE[diff];
  const hand = swing.dir;
  const u = j.timingMs / (WINDOWS.good * k);
  const edge = j.grade === 'edge';
  const cricket = sport === 'cricket';
  const spread = cricket ? 52 : 38;
  let az: number;
  if (!edge) az = hand * clamp(u, -1, 1) * spread + rng.gauss(0, 4);
  else {
    const over = clamp((Math.abs(u) - 1) / (WINDOWS.edge / WINDOWS.good - 1), 0, 1);
    az = hand * Math.sign(u) * ((cricket ? 64 : 48) + over * (cricket ? 72 : 60)) + rng.gauss(0, 9);
  }
  // The line of the ball matters: wide balls go square, balls at the body go to the leg side.
  az += clamp(ball.p.x, -0.6, 0.6) * (cricket ? 26 : 18);

  let launch: number;
  let q: number;
  let lift = 1;
  switch (j.vert) {
    case 'ground':
      launch = rng.range(-7, 5) + swing.up * 6;
      q = 0.9;
      lift = 0.1;
      break;
    case 'lofted':
      launch = rng.range(36, 50) + swing.up * 10;
      q = 0.86;
      break;
    case 'topEdge':
      launch = rng.range(52, 76);
      q = 0.42;
      lift = 0.3;
      // Skied off the top edge, usually behind square on the side the bat was coming from.
      az = -hand * rng.range(cricket ? 120 : 95, cricket ? 175 : 175) * (rng.chance(0.75) ? 1 : -0.4);
      break;
    default:
      launch = (cricket ? 10 : 13) + swing.up * 18 + (j.grade === 'perfect' ? 9 : 0) + rng.gauss(0, 4);
      q = j.sweet ? 1.1 : 1;
  }
  if (edge) {
    q *= 0.58;
    launch = launch * 0.6 + rng.range(-4, 14);
  }
  const ballSpeed = Math.hypot(ball.v.x, ball.v.y, ball.v.z);
  const base = cricket ? 13 + 21 * j.power : 18 + 22 * j.power;
  const speed = base * q + ballSpeed * (cricket ? 0.22 : 0.18);
  return {
    speed,
    launch: clamp(launch, -10, 78),
    azimuth: az,
    lift: launch > 8 ? lift : lift * 0.3,
    edge: edge || j.vert === 'topEdge',
    quality: q,
  };
}

/** Commentary name for a cricket shot in the batter's frame (handed: +1 right-hander). */
export function cricketShotName(shot: Shot, handed: 1 | -1): string {
  const a = shot.azimuth * handed; // + = off side
  if (shot.edge && Math.abs(a) > 100) return a > 0 ? 'Thick edge' : 'Top edge';
  const lofted = shot.launch > 22;
  const L = lofted ? 'Lofted ' : '';
  if (a > 140) return 'Outside edge';
  if (a > 100) return 'Late cut';
  if (a > 68) return lofted ? 'Upper cut' : 'Square cut';
  if (a > 32) return `${L}Cover drive`;
  if (a > 9) return `${L}Off drive`;
  if (a > -9) return lofted ? 'Straight hit' : 'Straight drive';
  if (a > -32) return `${L}On drive`;
  if (a > -68) return lofted ? 'Slog over mid-wicket' : 'Whip to mid-wicket';
  if (a > -110) return shot.launch > 14 ? 'Pull shot' : 'Flick';
  return 'Glance';
}
