/**
 * Pure game logic for Goalkeeper: shot generation and flight, body → goal mapping, save judging,
 * deflections, shootout rules and ranking. No three.js, no DOM, so it can be unit-tested.
 *
 * World/goal coordinates (metres): x across the goal (+ = the keeper's right = screen right in the keeper
 * view), y up, z along the pitch. The goal line is z = 0 and the pitch extends toward -z. Shots fly toward +z.
 */
import type { V2 } from '../../core/types';

export type Difficulty = 'easy' | 'normal' | 'hard';
export type Mode = 'shootout' | 'rapid';
export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];
export const MODES: Mode[] = ['shootout', 'rapid'];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const GOAL = {
  /** Inner half width (post centre to post centre is 7.32 m + post). */
  halfW: 3.66,
  /** Crossbar height (underside). */
  h: 2.44,
  postR: 0.06,
  /** Net depth at the bottom. */
  depth: 2.0,
  /** Depth of the flat top net. */
  topDepth: 0.85,
};
export const BALL_R = 0.11;
export const GRAVITY = 9.81;
/** The plane where the keeper meets the ball: a little off the line. */
export const KEEPER_Z = -0.45;
/** Extra reach around gloves (tracking is not exact). */
export const SAVE_PAD = 0.25;
export const GLOVE_R = BALL_R + SAVE_PAD;
export const PENALTY_SPOT: Vec3 = { x: 0, y: BALL_R, z: -11 };
export const RAPID_SECONDS = 60;

// ---- random numbers ---------------------------------------------------------------------

export type Rng = () => number;

/** Small seeded PRNG (mulberry32). */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const range = (r: Rng, a: number, b: number) => a + (b - a) * r();

// ---- difficulty ------------------------------------------------------------------------------

export interface DiffProfile {
  /** Flight time (s) of a penalty from the spot at the start and at the end of a session. */
  flight: [number, number];
  /** How close to the corners shots go (0 centre .. 1 corner), start → end. */
  corner: [number, number];
  /** Maximum sideways bend at the goal (m), start → end. */
  curve: [number, number];
  /** Share of shots that go high, start → end. */
  high: [number, number];
  /** How strongly the shooter's body angle gives away the side (radians). */
  tell: number;
  /** Chance the body angle lies (disguised shot), start → end. */
  fake: [number, number];
  /** Chance of a stutter in the run-up. */
  stutter: number;
  chip: number;
  offTarget: number;
  post: number;
  /** Time scale while the ball passes the keeper (bullet time + room for tracking latency). */
  lineSlow: number;
  /** AI keeper: chance of guessing the right side on your penalties. */
  keeperGuess: number;
  /** Seconds between rapid-fire shots, start → end. */
  rapidGap: [number, number];
}

export const PROFILES: Record<Difficulty, DiffProfile> = {
  easy: {
    flight: [1.55, 1.3],
    corner: [0.35, 0.6],
    curve: [0.2, 0.6],
    high: [0.15, 0.3],
    tell: 0.42,
    fake: [0, 0.05],
    stutter: 0,
    chip: 0,
    offTarget: 0.06,
    post: 0.04,
    lineSlow: 0.32,
    keeperGuess: 0.3,
    rapidGap: [1.0, 0.6],
  },
  normal: {
    flight: [1.25, 1.02],
    corner: [0.5, 0.78],
    curve: [0.4, 1.1],
    high: [0.25, 0.45],
    tell: 0.28,
    fake: [0.1, 0.25],
    stutter: 0.12,
    chip: 0.05,
    offTarget: 0.06,
    post: 0.05,
    lineSlow: 0.4,
    keeperGuess: 0.42,
    rapidGap: [0.8, 0.4],
  },
  hard: {
    flight: [1.02, 0.84],
    corner: [0.68, 0.92],
    curve: [0.7, 1.6],
    high: [0.35, 0.55],
    tell: 0.2,
    fake: [0.3, 0.45],
    stutter: 0.25,
    chip: 0.08,
    offTarget: 0.04,
    post: 0.05,
    lineSlow: 0.5,
    keeperGuess: 0.55,
    rapidGap: [0.6, 0.25],
  },
};

// ---- shots ---------------------------------------------------------------------------------

export type ShotKind = 'driven' | 'placed' | 'curler' | 'chip' | 'low' | 'power';

export interface Shot {
  id: number;
  from: Vec3;
  /** Where the ball would cross the goal line (z = 0). */
  target: { x: number; y: number };
  /** Flight time from the strike to the goal line (s). */
  T: number;
  v0: Vec3;
  /** Constant acceleration: gravity plus Magnus bend/dip plus drag along z. */
  acc: Vec3;
  kind: ShotKind;
  /** Spin (rad/s) around each axis, for visuals. */
  spin: Vec3;
  /** Inside the frame. */
  onTarget: boolean;
  /** Hits the woodwork if not saved: 'post' | 'bar' | null. */
  wood: 'post' | 'bar' | null;
  /** Shooter body angle at the strike (rad, + = turned toward the keeper's right). */
  tellYaw: number;
  /** The body angle points the wrong way. */
  fake: boolean;
  stutter: boolean;
}

/** Position of the ball t seconds after the strike (the same parabola continues past the goal line). */
export function shotPos(s: Shot, t: number): Vec3 {
  return {
    x: s.from.x + s.v0.x * t + 0.5 * s.acc.x * t * t,
    y: s.from.y + s.v0.y * t + 0.5 * s.acc.y * t * t,
    z: s.from.z + s.v0.z * t + 0.5 * s.acc.z * t * t,
  };
}

export function shotVel(s: Shot, t: number): Vec3 {
  return { x: s.v0.x + s.acc.x * t, y: s.v0.y + s.acc.y * t, z: s.v0.z + s.acc.z * t };
}

/** Time when the ball reaches depth z (first crossing), or NaN if never. */
export function timeAtZ(s: Shot, z: number): number {
  const a = 0.5 * s.acc.z;
  const b = s.v0.z;
  const c = s.from.z - z;
  if (Math.abs(a) < 1e-9) return b > 0 ? -c / b : NaN;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return NaN;
  const sq = Math.sqrt(disc);
  const r1 = (-b - sq) / (2 * a);
  const r2 = (-b + sq) / (2 * a);
  const ts = [r1, r2].filter((t) => t >= 0).sort((p, q) => p - q);
  return ts.length ? ts[0] : NaN;
}

/** Build a shot that leaves `from` and crosses the goal line at `target` after T seconds. */
export function buildShot(
  id: number,
  from: Vec3,
  target: { x: number; y: number },
  T: number,
  opts: { bend?: number; dip?: number; drag?: number; kind?: ShotKind; tellYaw?: number; fake?: boolean; stutter?: boolean; wood?: 'post' | 'bar' | null } = {},
): Shot {
  const dz = -from.z;
  // Drag slows the ball along its flight (~drag share of the average speed lost over the flight).
  const drag = opts.drag ?? 0.22;
  const az = (-drag * (dz / T)) / T;
  const ax = ((opts.bend ?? 0) * 2) / (T * T);
  const ay = -GRAVITY - (opts.dip ?? 0);
  const acc = { x: ax, y: ay, z: az };
  const v0 = {
    x: (target.x - from.x - 0.5 * ax * T * T) / T,
    y: (target.y - from.y - 0.5 * ay * T * T) / T,
    z: (dz - 0.5 * az * T * T) / T,
  };
  const onTarget = Math.abs(target.x) < GOAL.halfW - BALL_R * 0.5 && target.y < GOAL.h - BALL_R * 0.5 && target.y > 0;
  const speed = Math.hypot(v0.x, v0.y, v0.z);
  const kind = opts.kind ?? 'driven';
  const spin: Vec3 =
    kind === 'curler'
      ? { x: 4, y: -Math.sign(ax || 1) * 22, z: 0 }
      : kind === 'chip'
        ? { x: -14, y: 0, z: 0 }
        : { x: speed * 0.9, y: (ax ? -Math.sign(ax) : 0) * 6, z: 0 };
  return {
    id,
    from,
    target,
    T,
    v0,
    acc,
    kind,
    spin,
    onTarget: onTarget || opts.wood != null,
    wood: opts.wood ?? null,
    tellYaw: opts.tellYaw ?? 0,
    fake: !!opts.fake,
    stutter: !!opts.stutter,
  };
}

/** Pick a shot for this moment of the session. `progress` 0..1 ramps the difficulty up. */
export function makeShot(rng: Rng, diff: Difficulty, progress: number, from: Vec3 = PENALTY_SPOT, id = 0): Shot {
  const p = PROFILES[diff];
  const k = clamp(progress, 0, 1);
  const dist = Math.hypot(from.x, from.z);
  // Longer shots take longer, but not proportionally (they are struck harder).
  let T = lerp(p.flight[0], p.flight[1], k) * Math.pow(dist / 11, 0.62) * range(rng, 0.94, 1.06);
  const side = rng() < 0.5 ? -1 : 1;
  const cornerness = clamp(lerp(p.corner[0], p.corner[1], k) + (rng() - 0.5) * 0.45, 0, 1);
  const high = rng() < lerp(p.high[0], p.high[1], k);
  const low = !high && rng() < 0.5;
  let x = side * lerp(0.35, GOAL.halfW - BALL_R - 0.22, cornerness);
  let y = high ? range(rng, 1.65, GOAL.h - BALL_R - 0.12) : low ? range(rng, BALL_R + 0.02, 0.45) : range(rng, 0.5, 1.5);
  let kind: ShotKind = high ? 'placed' : low ? 'low' : 'driven';
  let bend = 0;
  let dip = 0;
  let wood: 'post' | 'bar' | null = null;
  // Occasionally straight down the middle: punishes keepers who always dive.
  if (rng() < 0.08 + 0.04 * k) {
    x = range(rng, -0.6, 0.6);
    kind = 'power';
    T *= 0.92;
  }
  const curveMax = lerp(p.curve[0], p.curve[1], k);
  if (kind !== 'power' && rng() < 0.45) {
    // Curl: the ball starts outside the target line and bends back in (Magnus).
    bend = side * curveMax * range(rng, 0.4, 1) * (rng() < 0.75 ? 1 : -1);
    kind = 'curler';
  }
  if (high && rng() < 0.4) dip = range(rng, 1.5, 4.5);
  if (rng() < p.chip * (0.5 + k)) {
    kind = 'chip';
    x = range(rng, -0.5, 0.5);
    y = range(rng, 1.3, 1.9);
    T *= 1.55;
    bend = 0;
    dip = 0;
  } else if (rng() < p.offTarget) {
    if (rng() < 0.5) x = side * range(rng, GOAL.halfW + 0.3, GOAL.halfW + 1.2);
    else y = range(rng, GOAL.h + 0.3, GOAL.h + 1.0);
  } else if (rng() < p.post) {
    if (rng() < 0.65) {
      wood = 'post';
      x = side * (GOAL.halfW - BALL_R * 0.35);
      y = range(rng, 0.3, 2.0);
    } else {
      wood = 'bar';
      y = GOAL.h - BALL_R * 0.3;
      x = side * range(rng, 0.8, 3.2);
    }
  }
  const fake = rng() < lerp(p.fake[0], p.fake[1], k);
  const tellSide = Math.abs(x) < 0.7 ? 0 : Math.sign(x);
  const tellYaw = (fake ? -1 : 1) * tellSide * p.tell * range(rng, 0.7, 1.15) + (rng() - 0.5) * 0.08;
  const stutter = rng() < p.stutter;
  return buildShot(id, from, { x, y }, T, { bend, dip, kind, tellYaw, fake, stutter, wood });
}

/** Where rapid-fire shooters stand: around the edge of the box. */
export const RAPID_SPOTS: Vec3[] = [
  { x: -9.5, y: BALL_R, z: -15 },
  { x: 0, y: BALL_R, z: -18 },
  { x: 9.5, y: BALL_R, z: -15 },
];

export function rapidGap(diff: Difficulty, progress: number): number {
  const g = PROFILES[diff].rapidGap;
  return lerp(g[0], g[1], clamp(progress, 0, 1));
}

// ---- body → goal mapping ---------------------------------------------------------------------

/** Body measurements the mapping needs (a subset of core Body). */
export interface BodyIn {
  ok: boolean;
  lWrist: V2;
  rWrist: V2;
  lElbow: V2;
  rElbow: V2;
  hip: V2;
  lean: number;
  duck: number;
  rise: number;
}

export const MAP = {
  /** Metres per shoulder width of a typical adult. */
  sw: 0.4,
  /** Sideways step gain: a 1 m step moves the keeper ~2.3 m across the goal. */
  lean: 2.3,
  /** Arm reach gain across the goal. */
  arm: 1.45,
  /** Vertical gain. */
  vert: 1.12,
  /** Keeper shoulder height standing (m). */
  shoulderY: 1.5,
  /** Jumping counts extra, so the crossbar is reachable. */
  rise: 1.8,
  /** How far past the wrist the palm centre sits, as a fraction of the forearm. */
  palm: 0.25,
  torsoR: 0.24,
  headR: 0.15,
  legR: 0.13,
};

export interface KeeperPose {
  ok: boolean;
  l: V2;
  r: V2;
  lElbow: V2;
  rElbow: V2;
  /** Shoulder centre. */
  sh: V2;
  hip: V2;
  head: V2;
  /** Feet (on the ground). */
  lFoot: V2;
  rFoot: V2;
}

/** Map body space (shoulder widths, relative to the shoulders) onto the goal mouth. */
export function bodyToGoal(b: BodyIn, torsoRatio = 1.5): KeeperPose {
  const k = MAP.sw;
  const shX = b.lean * k * MAP.lean;
  const vertical = (Math.max(0, b.rise) * MAP.rise - Math.max(-0.3, b.duck)) * torsoRatio;
  const shY = MAP.shoulderY + vertical * k * MAP.vert;
  const toGoal = (p: V2): V2 => ({ x: shX + p.x * k * MAP.arm, y: shY + p.y * k * MAP.vert });
  const palm = (w: V2, e: V2): V2 => ({ x: w.x + (w.x - e.x) * MAP.palm, y: w.y + (w.y - e.y) * MAP.palm });
  const hip = { x: shX + b.hip.x * k * MAP.arm * 0.6, y: Math.max(0.35, shY + b.hip.y * k * MAP.vert) };
  const footSpread = 0.28;
  return {
    ok: b.ok,
    l: toGoal(palm(b.lWrist, b.lElbow)),
    r: toGoal(palm(b.rWrist, b.rElbow)),
    lElbow: toGoal(b.lElbow),
    rElbow: toGoal(b.rElbow),
    sh: { x: shX, y: shY },
    hip,
    head: { x: shX + (shX - hip.x) * 0.25, y: shY + 0.3 },
    lFoot: { x: hip.x - footSpread, y: 0.05 },
    rFoot: { x: hip.x + footSpread, y: 0.05 },
  };
}

/** SimPose's elbow model (see core/pose.ts), used by the bot inverse. */
function simElbow(w: V2, side: number): V2 {
  return { x: side * 0.5 + (w.x - side * 0.5) * 0.5, y: w.y * 0.5 - 0.05 };
}

export interface BotPose {
  lWrist: V2;
  rWrist: V2;
  lean: number;
  duck: number;
  rise: number;
}

/**
 * Inverse of bodyToGoal for the demo bot: body-space wrists, lean, duck and rise that put the gloves at
 * `l` and `r` (goal coordinates). Uses SimPose's elbow model.
 */
export function goalToBody(l: V2, r: V2, torsoRatio = 1.5): BotPose {
  const k = MAP.sw;
  const midX = (l.x + r.x) / 2;
  const lowY = Math.min(l.y, r.y);
  const highY = Math.max(l.y, r.y);
  // Step most of the way, reach the rest.
  const lean = clamp((midX * 0.6) / (k * MAP.lean), -2.6, 2.6);
  const duck = clamp((0.95 - lowY) / 0.9, 0, 0.75);
  const rise = clamp((highY - 2.25) / 0.9, 0, 0.35);
  const vertical = (rise * MAP.rise - duck) * torsoRatio;
  const shX = lean * k * MAP.lean;
  const shY = MAP.shoulderY + vertical * k * MAP.vert;
  const solve = (g: V2, side: number): V2 => {
    const want = { x: (g.x - shX) / (k * MAP.arm), y: (g.y - shY) / (k * MAP.vert) };
    let w = { ...want };
    for (let i = 0; i < 12; i++) {
      const e = simElbow(w, side);
      const p = { x: w.x + (w.x - e.x) * MAP.palm, y: w.y + (w.y - e.y) * MAP.palm };
      w = { x: w.x + (want.x - p.x) * 0.9, y: w.y + (want.y - p.y) * 0.9 };
    }
    return w;
  };
  return { lWrist: solve(l, -1), rWrist: solve(r, 1), lean, duck, rise };
}

// ---- save judging ------------------------------------------------------------------------------

export type SaveKind = 'catch' | 'parry' | 'tip' | 'block' | 'none';

export interface Contact {
  kind: SaveKind;
  hand: 'l' | 'r' | 'both' | 'body' | null;
  /** Distance from the contact centre to the ball (m). */
  dist: number;
  /** Unit vector from the contact centre to the ball (in the goal plane). */
  n: V2;
}

function segDist(p: V2, a: V2, b: V2): { d: number; c: V2 } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 1e-9 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
  const c = { x: a.x + dx * t, y: a.y + dy * t };
  return { d: Math.hypot(p.x - c.x, p.y - c.y), c };
}

function unit(v: V2): V2 {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-6 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 1 };
}

/** Does the keeper (gloves or body) stop a ball crossing the keeper plane at `ball`? */
export function judgeSave(k: KeeperPose, ball: V2, pad = SAVE_PAD): Contact {
  const none: Contact = { kind: 'none', hand: null, dist: Infinity, n: { x: 0, y: 1 } };
  if (!k.ok) return none;
  const R = BALL_R + pad;
  const dl = Math.hypot(ball.x - k.l.x, ball.y - k.l.y);
  const dr = Math.hypot(ball.x - k.r.x, ball.y - k.r.y);
  const handGap = Math.hypot(k.l.x - k.r.x, k.l.y - k.r.y);
  if (dl < R && dr < R && handGap < 0.8) {
    const mid = { x: (k.l.x + k.r.x) / 2, y: (k.l.y + k.r.y) / 2 };
    return { kind: 'catch', hand: 'both', dist: Math.hypot(ball.x - mid.x, ball.y - mid.y), n: unit({ x: ball.x - mid.x, y: ball.y - mid.y }) };
  }
  const near = dl <= dr ? 'l' : 'r';
  const d = Math.min(dl, dr);
  const g = near === 'l' ? k.l : k.r;
  if (d < R) {
    // A ball that hits the middle of one glove with the other close by is still held.
    const other = near === 'l' ? dr : dl;
    if (d < 0.14 && other < R * 1.7) return { kind: 'catch', hand: 'both', dist: d, n: unit({ x: ball.x - g.x, y: ball.y - g.y }) };
    return { kind: d > R * 0.62 ? 'tip' : 'parry', hand: near, dist: d, n: unit({ x: ball.x - g.x, y: ball.y - g.y }) };
  }
  // Body: torso capsule, head, legs.
  const parts: { a: V2; b: V2; r: number }[] = [
    { a: k.hip, b: k.sh, r: MAP.torsoR },
    { a: k.head, b: k.head, r: MAP.headR },
    { a: k.hip, b: k.lFoot, r: MAP.legR },
    { a: k.hip, b: k.rFoot, r: MAP.legR },
    { a: k.sh, b: k.lElbow, r: 0.09 },
    { a: k.sh, b: k.rElbow, r: 0.09 },
    { a: k.lElbow, b: k.l, r: 0.08 },
    { a: k.rElbow, b: k.r, r: 0.08 },
  ];
  let best: Contact = none;
  for (const p of parts) {
    const s = segDist(ball, p.a, p.b);
    if (s.d < p.r + BALL_R + 0.06 && s.d < best.dist) best = { kind: 'block', hand: 'body', dist: s.d, n: unit({ x: ball.x - s.c.x, y: ball.y - s.c.y }) };
  }
  return best;
}

/** A save at the top corners, a fingertip save or a full-stretch save is a great save. */
export function isGreatSave(c: Contact, ball: V2, k: KeeperPose): boolean {
  if (c.kind === 'none') return false;
  const corner = Math.abs(ball.x) > 2.6 && (ball.y > 1.75 || ball.y < 0.45);
  const stretch = Math.abs(ball.x - k.sh.x) > 1.5;
  return c.kind === 'tip' || (corner && c.kind !== 'block') || (stretch && c.kind !== 'block' && Math.abs(ball.x) > 2.2);
}

/** Ball velocity after a save. `v` is the incoming velocity. */
export function deflect(c: Contact, pos: Vec3, v: Vec3, rng: Rng): Vec3 {
  const speed = Math.hypot(v.x, v.y, v.z);
  if (c.kind === 'catch' || c.kind === 'none') return { x: 0, y: 0, z: 0 };
  if (c.kind === 'tip') {
    // Fingertips: keep most of the pace, pushed out of the frame (over the bar or round the post).
    const overBar = pos.y > 1.7 && (c.n.y > -0.2 || Math.abs(pos.x) < 2.8);
    if (overBar) return { x: v.x * 0.6, y: Math.max(3.5, Math.abs(v.y) + 3.5 + rng() * 1.5), z: v.z * 0.55 };
    const out = Math.sign(pos.x || c.n.x || 1);
    return { x: out * (3 + rng() * 2) + v.x * 0.3, y: Math.max(0.5, v.y * 0.4 + 1), z: v.z * 0.55 };
  }
  if (c.kind === 'parry') {
    // Palmed away: mostly back out and to the side.
    const nx = c.n.x + (Math.abs(pos.x) > 2.4 ? Math.sign(pos.x) * 0.6 : 0);
    const ny = Math.max(-0.2, c.n.y) + 0.35;
    const s = speed * range(rng, 0.35, 0.5);
    return { x: nx * s * 0.8, y: ny * s * 0.7 + 1.2, z: -Math.abs(v.z) * range(rng, 0.25, 0.4) };
  }
  // Body block: rebounds back into play.
  return { x: c.n.x * speed * 0.2 + v.x * 0.1, y: Math.max(0.8, c.n.y * speed * 0.2 + 1.5), z: -Math.abs(v.z) * range(rng, 0.3, 0.45) };
}

/** Where a shot meets the woodwork, and the bounce. */
export function woodworkBounce(s: Shot, v: Vec3, rng: Rng): { v: Vec3; inGoal: boolean } {
  if (s.wood === 'bar') return { v: { x: v.x * 0.6, y: Math.abs(v.y) * 0.4 + 2.5, z: -Math.abs(v.z) * 0.45 }, inGoal: false };
  const inGoal = rng() < 0.3;
  const side = Math.sign(s.target.x || 1);
  if (inGoal) return { v: { x: -side * Math.abs(v.z) * 0.35, y: v.y * 0.5, z: Math.abs(v.z) * 0.6 }, inGoal };
  return { v: { x: side * Math.abs(v.z) * 0.35 + v.x * 0.2, y: v.y * 0.5 + 0.5, z: -Math.abs(v.z) * 0.35 }, inGoal };
}

// ---- your penalties vs the AI keeper ------------------------------------------------------------

export interface KeeperDive {
  /** -1 left, 0 stays, 1 right (goal x sign). */
  side: -1 | 0 | 1;
  /** Where the keeper's hands end up. */
  reach: { x: number; y: number };
  saved: boolean;
}

/** Decide what the AI keeper does against your penalty aimed at `t` (goal coordinates). */
export function aiKeeper(t: { x: number; y: number }, diff: Difficulty, rng: Rng): KeeperDive {
  const onTarget = Math.abs(t.x) < GOAL.halfW - BALL_R * 0.5 && t.y < GOAL.h - BALL_R * 0.5;
  const guessRight = rng() < PROFILES[diff].keeperGuess;
  const centre = Math.abs(t.x) < 0.9;
  let side: -1 | 0 | 1;
  if (centre) side = rng() < 0.3 ? 0 : rng() < 0.5 ? -1 : 1;
  else side = guessRight ? (Math.sign(t.x) as -1 | 1) : rng() < 0.2 ? 0 : (-Math.sign(t.x) as -1 | 1);
  // Reach envelope of a diving keeper: about 3 m sideways at mid height, less in the top corners.
  const reachX = side === 0 ? 0.9 : 2.95 - Math.max(0, t.y - 1.6) * 0.9 - Math.max(0, 0.35 - t.y) * 0.8;
  const sameSide = side === 0 ? centre : Math.sign(t.x) === side;
  const reachable = sameSide && Math.abs(t.x) <= reachX + 0.15 && t.y < 2.3;
  const saved = onTarget && reachable && rng() < (side === 0 ? 0.9 : 0.8);
  const rx = side === 0 ? clamp(t.x, -0.6, 0.6) : side * Math.min(Math.abs(t.x), reachX);
  return { side, reach: { x: saved ? t.x : rx, y: saved ? t.y : clamp(t.y, 0.4, 1.9) }, saved };
}

/** Aim from the pointing hand during your penalty (body space → goal), with lean helping. */
export function aimFromHand(w: V2, lean: number): { x: number; y: number } {
  return {
    x: clamp(((w.x + lean * 0.6) / 1.9) * GOAL.halfW, -GOAL.halfW - 1.2, GOAL.halfW + 1.2),
    y: clamp(((w.y + 1.2) / 3.0) * GOAL.h, 0.12, GOAL.h + 0.9),
  };
}

/** Your shot misses its aim a little; more when you go for the corners. */
export function aimError(aim: { x: number; y: number }, rng: Rng, diff: Difficulty): { x: number; y: number } {
  const corner = clamp(Math.abs(aim.x) / GOAL.halfW, 0, 1.2) * 0.6 + clamp(aim.y / GOAL.h, 0, 1.2) * 0.4;
  const s = (diff === 'easy' ? 0.12 : diff === 'normal' ? 0.18 : 0.24) * (0.6 + corner);
  const g = () => (rng() + rng() + rng() - 1.5) * 1.15;
  return { x: aim.x + g() * s, y: Math.max(BALL_R, aim.y + g() * s * 0.8) };
}

// ---- shootout ----------------------------------------------------------------------------------

/**
 * Shootout winner once it is decided, else null. `home` and `away` are the results of each kick taken so
 * far (true = scored). The away side kicks first. Five kicks each, then sudden death.
 */
export function shootoutWinner(home: boolean[], away: boolean[], kicks = 5): 'home' | 'away' | null {
  const hg = home.filter(Boolean).length;
  const ag = away.filter(Boolean).length;
  const n = Math.max(home.length, away.length);
  if (n <= kicks) {
    const hLeft = kicks - home.length;
    const aLeft = kicks - away.length;
    if (hg > ag + aLeft) return 'home';
    if (ag > hg + hLeft) return 'away';
    return null;
  }
  if (home.length === away.length) {
    if (hg > ag) return 'home';
    if (ag > hg) return 'away';
  }
  return null;
}

/** Who kicks next: the away side kicks first in every round. */
export function nextKicker(home: boolean[], away: boolean[]): 'home' | 'away' {
  return away.length <= home.length ? 'away' : 'home';
}

// ---- results ---------------------------------------------------------------------------------

export interface Tally {
  shots: number;
  saves: number;
  goals: number;
  misses: number;
  catches: number;
  great: number;
  bestStreak: number;
}

/** Points for a save: streak multiplier and bonuses. */
export function savePoints(kind: SaveKind, great: boolean, streak: number): number {
  const base = kind === 'catch' ? 150 : kind === 'tip' ? 130 : 100;
  const mult = 1 + Math.min(4, Math.floor(Math.max(0, streak - 1) / 2)) * 0.5;
  return Math.round((base + (great ? 150 : 0)) * mult);
}

export function streakMult(streak: number): number {
  return 1 + Math.min(4, Math.floor(Math.max(0, streak - 1) / 2)) * 0.5;
}

/** Share of on-target shots kept out. */
export function savePct(t: Tally): number {
  const faced = t.saves + t.goals;
  return faced > 0 ? t.saves / faced : 0;
}

export function rankFor(pct: number, mode: Mode, won?: boolean): { badge: string; stars: number; tone: 'gold' | 'blue' | 'red' } {
  let stars = pct >= 0.8 ? 3 : pct >= 0.6 ? 2 : pct >= 0.35 ? 1 : 0;
  if (mode === 'shootout') stars = won ? Math.max(1, stars) : Math.min(stars, 1);
  const badge = pct >= 0.9 ? 'S' : pct >= 0.75 ? 'A' : pct >= 0.55 ? 'B' : pct >= 0.35 ? 'C' : 'D';
  const tone = badge === 'S' ? 'blue' : badge === 'D' ? 'red' : 'gold';
  return { badge, stars, tone };
}
