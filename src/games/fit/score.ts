/**
 * Pose scoring: compares what the camera sees with the coach's target (joint angles, wrist and elbow positions in
 * body space, vertical motion, lean, torso tilt and — when the full body is visible — knees and feet). Judging
 * searches a ±200 ms time offset to absorb reaction time and camera latency.
 */
import type { V2 } from '../../core/types';
import type { Feature } from './moves';
import { motionEnergy } from './calories';
import { lerpObs, type Obs } from './rig';

export type Rating = 'perfect' | 'great' | 'ok' | 'miss';

export const RATING_MIN: Record<Exclude<Rating, 'miss'>, number> = { perfect: 0.8, great: 0.64, ok: 0.45 };

export function rate(sim: number): Rating {
  if (sim >= RATING_MIN.perfect) return 'perfect';
  if (sim >= RATING_MIN.great) return 'great';
  if (sim >= RATING_MIN.ok) return 'ok';
  return 'miss';
}

export const RATING_POINTS: Record<Rating, number> = { perfect: 100, great: 70, ok: 40, miss: 0 };

export interface SimOptions {
  /** Score knees and feet (the full body is visible). */
  legs: boolean;
  focus: Feature[];
  /** The player's running-average lean, so drifting across the room does not count against them. */
  playerLeanRef?: number;
  /** The move's average lean. */
  targetLeanRef?: number;
  /** Only use the focus features. */
  onlyFocus?: boolean;
  /** Multiply all tolerances. */
  tolScale?: number;
}

const d2 = (a: V2, b: V2) => Math.hypot(a.x - b.x, a.y - b.y);
const g = (err: number, tol: number) => Math.exp(-0.5 * (err / tol) * (err / tol));

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

const ang = (from: V2, to: V2) => Math.atan2(to.y - from.y, to.x - from.x);

/** Interior angle at b (radians), from 2D points. */
function joint(a: V2, b: V2, c: V2): number {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const l = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1;
  return Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / l)));
}

const torsoTiltOf = (o: Obs) => Math.atan2(-o.hip.x, -o.hip.y);

export interface SimParts {
  total: number;
  parts: Partial<Record<Feature, number>>;
}

/** Similarity 0..1 between the target pose and the player's pose (both in body space). */
export function similarity(target: Obs, player: Obs, o: SimOptions): SimParts {
  if (!player.ok) return { total: 0, parts: {} };
  const ts = o.tolScale ?? 1;
  const focus = new Set(o.focus);
  let wsum = 0;
  let acc = 0;
  const parts: Partial<Record<Feature, number>> = {};
  const add = (f: Feature, w: number, s: number) => {
    const isFocus = focus.has(f);
    if (o.onlyFocus && !isFocus) return;
    const ww = w * (isFocus ? 2 : 1);
    wsum += ww;
    acc += ww * s;
    parts[f] = s;
  };

  // Arms: wrist positions, elbow positions and the shoulder/elbow angles. Angles are unreliable when a segment
  // points at the camera (short in 2D), so they are weighted by the target's projected length.
  const handOk = player.wv > 0.3;
  for (const side of [0, 1] as const) {
    const tw = side ? target.rw : target.lw;
    const te = side ? target.re : target.le;
    const tsh = side ? target.rs : target.ls;
    const pw = side ? player.rw : player.lw;
    const pe = side ? player.re : player.le;
    const psh = side ? player.rs : player.ls;
    add('wrists', 1, handOk ? g(d2(tw, pw), 0.42 * ts) : 0);
    const upper = d2(tsh, te);
    const fore = d2(te, tw);
    const sElbow = g(d2(te, pe), 0.38 * ts);
    const rU = Math.min(1, upper / 0.5);
    const rF = Math.min(1, fore / 0.45, rU);
    const sShoulderAng = g(angleDiff(ang(tsh, te), ang(psh, pe)), 0.5 * ts);
    const sElbowAng = g(angleDiff(joint(tsh, te, tw), joint(psh, pe, pw)), 0.65 * ts);
    const wE = 0.5 + 0.3 * rU + 0.25 * rF;
    add('elbows', wE, handOk ? (0.5 * sElbow + 0.3 * rU * sShoulderAng + 0.25 * rF * sElbowAng) / wE : 0);
  }

  // Vertical motion (squats, ducks): shoulder drop.
  add('vertical', 0.8, g(target.duck - player.duck, 0.13 * ts));

  // Sideways motion relative to the player's own centre.
  const pl = player.lean - (o.playerLeanRef ?? 0);
  const tl = target.lean - (o.targetLeanRef ?? 0);
  add('lean', focus.has('lean') ? 0.6 : 0.25, g(pl - tl, 0.32 * ts));

  if (player.hips) {
    add('tilt', focus.has('tilt') ? 0.6 : 0.3, g(angleDiff(torsoTiltOf(target), torsoTiltOf(player)), 0.13 * ts));
    if (focus.has('jump')) add('jump', 0.5, g(Math.max(0, target.rise) - Math.max(0, player.rise), 0.09 * ts));
  }

  if (o.legs && player.full) {
    for (const side of [0, 1] as const) {
      const tk = side ? target.rk : target.lk;
      const ta = side ? target.ra : target.la;
      const pk = side ? player.rk : player.lk;
      const pa = side ? player.ra : player.la;
      const lift = g(tk.y - target.hip.y - (pk.y - player.hip.y), 0.3 * ts);
      const hx = side ? 0.3 : -0.3;
      const th = { x: target.hip.x + hx, y: target.hip.y };
      const ph = { x: player.hip.x + hx, y: player.hip.y };
      const bend = g(angleDiff(joint(th, tk, ta), joint(ph, pk, pa)), 0.6 * ts);
      add('knees', 0.55, 0.65 * lift + 0.35 * bend);
    }
    add('feet', 0.4, g(Math.abs(target.ra.x - target.la.x) - Math.abs(player.ra.x - player.la.x), 0.38 * ts));
  }
  return { total: wsum > 0 ? acc / wsum : 0, parts };
}

// ---- player history and time-offset judging --------------------------------------------------

/** Recent player observations, by song time. */
export class ObsBuffer {
  readonly list: Obs[] = [];
  constructor(private keep = 5) {}

  push(o: Obs): void {
    const l = this.list;
    if (l.length && o.t <= l[l.length - 1].t) return;
    l.push(o);
    while (l.length > 2 && l[0].t < o.t - this.keep) l.shift();
  }

  clear(): void {
    this.list.length = 0;
  }

  get latestT(): number {
    return this.list.length ? this.list[this.list.length - 1].t : -Infinity;
  }

  /** Interpolated observation at song time t, or null if tracking has a hole there. */
  at(t: number): Obs | null {
    const l = this.list;
    if (!l.length) return null;
    if (t <= l[0].t) return l[0].t - t < 0.12 ? l[0] : null;
    if (t >= l[l.length - 1].t) return t - l[l.length - 1].t < 0.12 ? l[l.length - 1] : null;
    let lo = 0;
    let hi = l.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (l[m].t <= t) lo = m;
      else hi = m;
    }
    const a = l[lo];
    const b = l[hi];
    if (b.t - a.t > 0.35) return t - a.t < 0.12 ? a : b.t - t < 0.12 ? b : null;
    return lerpObs(a, b, (t - a.t) / (b.t - a.t));
  }
}

export interface Judgement {
  sim: number;
  /** Best time offset (s): positive = the player was behind the coach. */
  offset: number;
  rating: Rating;
}

export const OFFSETS = [-0.2, -0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2];

/**
 * Judge one rating window [t0, t1] (song time): compares the target at sample times τ with the player at τ + δ and
 * keeps the best offset δ in ±200 ms.
 */
export function judgeWindow(
  targetAt: (t: number) => Obs,
  player: (t: number) => Obs | null,
  t0: number,
  t1: number,
  opts: SimOptions,
  samples = 7,
  offsets = OFFSETS,
): Judgement {
  const targets: Obs[] = [];
  for (let i = 0; i < samples; i++) targets.push(targetAt(t0 + ((i + 0.5) / samples) * (t1 - t0)));
  let best = 0;
  let bestOff = 0;
  for (const off of offsets) {
    let acc = 0;
    for (const tg of targets) {
      const p = player(tg.t + off);
      acc += p ? similarity(tg, p, opts).total : 0;
    }
    // A slight preference for small offsets breaks ties toward "on time".
    const s = acc / samples - Math.abs(off) * 0.02;
    if (s > best) {
      best = s;
      bestOff = off;
    }
  }
  let sim = Math.max(0, Math.min(1, best + Math.abs(bestOff) * 0.02));
  // Moving with the coach matters: if the coach moves a lot here and the player hardly moves, scale the rating down.
  const targetE = motionEnergy(targets, 5);
  if (targetE > 0.3) {
    const seen = targets.map((tg) => player(tg.t + bestOff)).filter((o): o is Obs => !!o);
    const playerE = motionEnergy(seen, 5);
    const k = Math.max(0, Math.min(1, playerE / (0.55 * targetE)));
    sim *= 0.3 + 0.7 * k;
  }
  return { sim, offset: bestOff, rating: rate(sim) };
}

// ---- score and combo ----------------------------------------------------------------------------

export class ScoreKeeper {
  score = 0;
  combo = 0;
  maxCombo = 0;
  ratings: Record<Rating, number> = { perfect: 0, great: 0, ok: 0, miss: 0 };
  private simSum = 0;
  judged = 0;

  /** Combo multiplier: +10% per 5 in a row, up to ×2. */
  get mult(): number {
    return Math.min(2, 1 + Math.floor(this.combo / 5) * 0.1);
  }

  add(j: Judgement): number {
    this.ratings[j.rating]++;
    this.judged++;
    this.simSum += j.sim;
    if (j.rating === 'miss') this.combo = 0;
    else this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    const pts = Math.round(RATING_POINTS[j.rating] * this.mult);
    this.score += pts;
    return pts;
  }

  /** Average similarity over all judged windows, 0..1. */
  get accuracy(): number {
    return this.judged ? this.simSum / this.judged : 0;
  }

  /** 0–3 stars from the share of Perfect/Great ratings. */
  get stars(): number {
    if (!this.judged) return 0;
    const q = (this.ratings.perfect + this.ratings.great * 0.75 + this.ratings.ok * 0.35) / this.judged;
    return q >= 0.8 ? 3 : q >= 0.6 ? 2 : q >= 0.35 ? 1 : 0;
  }

  get grade(): string {
    if (!this.judged) return '–';
    const q = (this.ratings.perfect + this.ratings.great * 0.75 + this.ratings.ok * 0.35) / this.judged;
    return q >= 0.92 ? 'S' : q >= 0.8 ? 'A' : q >= 0.6 ? 'B' : q >= 0.4 ? 'C' : 'D';
  }
}
