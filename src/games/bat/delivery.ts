/**
 * Deliveries (cricket) and pitches (baseball): choosing them per difficulty and solving their flight so the ball
 * pitches / crosses the plate exactly where intended. Pure logic.
 *
 * Deliveries are planned in the batter's frame (off side / outside = +x) and mirrored for left-handers.
 */
import { BALL, DEG, clamp, ms, step, type BallState, type Sport, type V3 } from './physics';
import type { Rng } from './rng';

export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];
export type CricketKind = 'pace' | 'outswing' | 'inswing' | 'offspin' | 'legspin' | 'yorker' | 'bouncer' | 'slower';
export type PitchKind = 'fastball' | 'curveball' | 'slider' | 'changeup';
export type DeliveryKind = CricketKind | PitchKind;

export const CRICKET_GEOM = {
  stumpsZ: 1.22,
  bowlerStumpsZ: -18.9,
  bowlerCreaseZ: -17.68,
  stumpHalfW: 0.114,
  stumpH: 0.72,
  /** Plane in front of the popping crease where the bat meets the ball. */
  contactZ: -0.5,
  pitchHalfW: 1.52,
};

export const BASEBALL_GEOM = {
  /** Plane through the middle of home plate where balls and strikes are called. */
  plateZ: -0.215,
  zoneHalfW: 0.216,
  zoneLow: 0.46,
  zoneHigh: 1.07,
  contactZ: -0.55,
  rubberZ: -18.44,
  moundH: 0.25,
};

export interface Sample {
  t: number;
  p: V3;
  v: V3;
}

export interface Delivery {
  sport: Sport;
  kind: DeliveryKind;
  /** Display name: "Outswinger", "Curveball". */
  label: string;
  /** Release speed in km/h (what the speed gun shows). */
  speedKmh: number;
  release: V3;
  v0: V3;
  /** Constant extra acceleration in flight (swing, pitch break). */
  air: V3;
  /** First ground contact before the bat, if any. */
  bounce: Sample | null;
  /** Lateral velocity change at the bounce (seam or spin), m/s. */
  kick: number;
  /** Dense samples from release (t = 0 s). */
  path: Sample[];
  /** State when the ball reaches the contact plane. */
  arrive: Sample;
  /** State at the stumps (cricket) or the middle of the plate (baseball). */
  cross: Sample;
  /** Cricket: would hit the stumps if left alone. Baseball: crosses the strike zone. */
  onTarget: boolean;
  /** Short description for the HUD, e.g. "Good length" or "Low and away". */
  note: string;
}

export interface CricketSpec {
  kind: CricketKind;
  speedKmh: number;
  /** Where the ball pitches (batter frame). */
  bounceX: number;
  bounceZ: number;
  /** Lateral acceleration in the air (swing / drift), m/s², + = away from a right-hander. */
  swing: number;
  /** Lateral velocity change off the pitch (seam / spin), m/s. */
  kick: number;
  release: V3;
  /** Vertical restitution and horizontal speed kept at the bounce. */
  e: number;
  keep: number;
}

export interface PitchSpec {
  kind: PitchKind;
  speedKmh: number;
  /** Where the ball crosses the middle of the plate. */
  targetX: number;
  targetY: number;
  /** Break as a constant acceleration (m/s²) on top of gravity. */
  breakX: number;
  breakY: number;
  release: V3;
}

const SIM_DT = 1 / 1200;
const PATH_DT = 1 / 400;

// ---- generic flight --------------------------------------------------------------------------------

interface FlightOpts {
  sport: Sport;
  air: V3;
  /** Cricket pitch bounce parameters; baseball balls in the dirt use their own. */
  e: number;
  keep: number;
  kick: number;
  /** Ignore the ground (used while solving pitches). */
  noGround?: boolean;
}

/** Simulate from release; calls `visit` with every state until it returns false. */
function fly(release: V3, v0: V3, o: FlightOpts, dt: number, visit: (t: number, s: BallState, bounced: boolean) => boolean): Sample | null {
  const r = BALL[o.sport].radius;
  const drag = BALL[o.sport].drag;
  const s: BallState = { p: { ...release }, v: { ...v0 } };
  let t = 0;
  let bounce: Sample | null = null;
  const after = { x: o.air.x * 0.15, y: o.air.y * 0.15, z: o.air.z * 0.15 };
  for (let i = 0; i < 4000; i++) {
    const py = s.p.y;
    step(s, dt, drag, bounce ? after : o.air);
    t += dt;
    if (!o.noGround && s.p.y < r && s.v.y < 0) {
      // Pitch (or dirt) contact: back up to the exact moment of contact, reflect, lose speed, deviate.
      const k = py > r ? (py - r) / (py - s.p.y) : 1;
      const back = (1 - k) * dt;
      s.p.x -= s.v.x * back;
      s.p.z -= s.v.z * back;
      t -= back;
      s.p.y = r;
      if (!bounce) {
        bounce = { t, p: { ...s.p }, v: { ...s.v } };
        s.v.y = -s.v.y * o.e;
        s.v.x = s.v.x * o.keep + o.kick;
        s.v.z *= o.keep;
      } else {
        s.v.y = -s.v.y * 0.4;
        s.v.x *= 0.8;
        s.v.z *= 0.8;
      }
    }
    if (!visit(t, s, !!bounce)) break;
  }
  return bounce;
}

/** 2D Newton solve on (elevation, azimuth) of the release velocity so that err(v0) → 0. */
function solveAim(speed: number, release: V3, aimAt: V3, err: (v0: V3) => [number, number]): V3 {
  const dx = aimAt.x - release.x;
  const dz = aimAt.z - release.z;
  const dy = aimAt.y - release.y;
  let elev = Math.atan2(dy, Math.hypot(dx, dz)) + 2 * DEG;
  let az = Math.atan2(dx, -dz);
  const vec = (e: number, a: number): V3 => ({
    x: speed * Math.cos(e) * Math.sin(a),
    y: speed * Math.sin(e),
    z: -speed * Math.cos(e) * Math.cos(a),
  });
  const h = 0.0015;
  for (let it = 0; it < 10; it++) {
    const f = err(vec(elev, az));
    if (Math.hypot(f[0], f[1]) < 0.002) break;
    const fe = err(vec(elev + h, az));
    const fa = err(vec(elev, az + h));
    const j11 = (fe[0] - f[0]) / h;
    const j21 = (fe[1] - f[1]) / h;
    const j12 = (fa[0] - f[0]) / h;
    const j22 = (fa[1] - f[1]) / h;
    const det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-9) break;
    const de = (j22 * f[0] - j12 * f[1]) / det;
    const da = (-j21 * f[0] + j11 * f[1]) / det;
    elev -= clamp(de, -0.2, 0.2);
    az -= clamp(da, -0.2, 0.2);
  }
  return vec(elev, az);
}

function record(release: V3, v0: V3, o: FlightOpts, endZ: number): { path: Sample[]; bounce: Sample | null } {
  const path: Sample[] = [{ t: 0, p: { ...release }, v: { ...v0 } }];
  let next = PATH_DT;
  const bounce = fly(release, v0, o, 1 / 2000, (t, s) => {
    if (t >= next - 1e-9) {
      path.push({ t, p: { ...s.p }, v: { ...s.v } });
      next += PATH_DT;
    }
    return s.p.z < endZ && t < 3;
  });
  return { path, bounce };
}

/** Interpolated state where the path crosses the plane z = zc (or the last sample). */
export function crossAt(path: Sample[], zc: number): Sample {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (a.p.z <= zc && b.p.z > zc) {
      const k = (zc - a.p.z) / (b.p.z - a.p.z);
      return lerpSample(a, b, k);
    }
  }
  return path[path.length - 1];
}

function lerpSample(a: Sample, b: Sample, k: number): Sample {
  const l = (x: number, y: number) => x + (y - x) * k;
  return {
    t: l(a.t, b.t),
    p: { x: l(a.p.x, b.p.x), y: l(a.p.y, b.p.y), z: l(a.p.z, b.p.z) },
    v: { x: l(a.v.x, b.v.x), y: l(a.v.y, b.v.y), z: l(a.v.z, b.v.z) },
  };
}

/** Ball state t seconds after release (clamped to the recorded path). */
export function sampleAt(d: Delivery, t: number): Sample {
  const path = d.path;
  if (t <= 0) return path[0];
  const i = Math.min(path.length - 1, Math.floor(t / PATH_DT));
  const a = path[i];
  const b = path[Math.min(path.length - 1, i + 1)];
  if (a === b) return a;
  return lerpSample(a, b, clamp((t - a.t) / Math.max(1e-6, b.t - a.t), 0, 1));
}

function mirror(d: Delivery, handed: 1 | -1): Delivery {
  if (handed === 1) return d;
  const mx = (v: V3): V3 => ({ x: -v.x, y: v.y, z: v.z });
  const ms_ = (s: Sample): Sample => ({ t: s.t, p: mx(s.p), v: mx(s.v) });
  return {
    ...d,
    release: mx(d.release),
    v0: mx(d.v0),
    air: mx(d.air),
    kick: -d.kick,
    bounce: d.bounce ? ms_(d.bounce) : null,
    path: d.path.map(ms_),
    arrive: ms_(d.arrive),
    cross: ms_(d.cross),
  };
}

// ---- cricket -----------------------------------------------------------------------------------------

export const CRICKET_LABEL: Record<CricketKind, string> = {
  pace: 'Seamer',
  outswing: 'Outswinger',
  inswing: 'Inswinger',
  offspin: 'Off-break',
  legspin: 'Leg-break',
  yorker: 'Yorker',
  bouncer: 'Bouncer',
  slower: 'Slower ball',
};

/** Length name from where the ball pitched (distance in front of the striker's stumps). */
export function lengthName(bounceZ: number | null): string {
  if (bounceZ === null) return 'Full toss';
  const L = CRICKET_GEOM.stumpsZ - bounceZ;
  if (L < 2.2) return 'Yorker';
  if (L < 4.6) return 'Full';
  if (L < 7) return 'Good length';
  if (L < 9.2) return 'Short';
  return 'Bouncer';
}

export function buildCricket(spec: CricketSpec, handed: 1 | -1 = 1): Delivery {
  const r = BALL.cricket.radius;
  const speed = ms(spec.speedKmh);
  const air: V3 = { x: spec.swing, y: 0, z: 0 };
  const o: FlightOpts = { sport: 'cricket', air, e: spec.e, keep: spec.keep, kick: spec.kick };
  const target: V3 = { x: spec.bounceX, y: r, z: spec.bounceZ };
  const v0 = solveAim(speed, spec.release, target, (v) => {
    let hit: V3 | null = null;
    let last: V3 = spec.release;
    fly(spec.release, v, { ...o }, SIM_DT, (_t, s, bounced) => {
      last = { ...s.p };
      if (bounced) {
        hit = { ...s.p };
        return false;
      }
      return s.p.z < 8;
    });
    const p: V3 = hit ?? last;
    return [p.z - target.z, p.x - target.x];
  });
  const { path, bounce } = record(spec.release, v0, o, 6);
  const arrive = crossAt(path, CRICKET_GEOM.contactZ);
  const cross = crossAt(path, CRICKET_GEOM.stumpsZ);
  const onTarget = cross.p.z >= CRICKET_GEOM.stumpsZ - 0.01 && Math.abs(cross.p.x) <= CRICKET_GEOM.stumpHalfW + r && cross.p.y <= CRICKET_GEOM.stumpH + r;
  const d: Delivery = {
    sport: 'cricket',
    kind: spec.kind,
    label: CRICKET_LABEL[spec.kind],
    speedKmh: spec.speedKmh,
    release: { ...spec.release },
    v0,
    air,
    bounce,
    kick: spec.kick,
    path,
    arrive,
    cross,
    onTarget,
    note: lengthName(bounce ? bounce.p.z : null),
  };
  return mirror(d, handed);
}

interface CricketProfile {
  pace: [number, number];
  spin: [number, number];
  weights: Partial<Record<CricketKind, number>>;
  /** Scale of swing, seam and turn. */
  move: number;
  /** Line spread (m) and share of balls aimed at the stumps. */
  lineSd: number;
  stumps: number;
}

export const CRICKET_PROFILES: Record<Difficulty, CricketProfile> = {
  easy: { pace: [112, 124], spin: [74, 82], weights: { pace: 6, outswing: 2, inswing: 1, offspin: 1.5, slower: 1, yorker: 0.6 }, move: 0.55, lineSd: 0.12, stumps: 0.55 },
  normal: {
    pace: [126, 140],
    spin: [79, 89],
    weights: { pace: 4, outswing: 2, inswing: 1.5, offspin: 1.5, legspin: 1.5, yorker: 1.3, bouncer: 1.1, slower: 1 },
    move: 1,
    lineSd: 0.16,
    stumps: 0.5,
  },
  hard: {
    pace: [136, 150],
    spin: [84, 95],
    weights: { pace: 3, outswing: 2.2, inswing: 2, offspin: 1.4, legspin: 1.6, yorker: 2, bouncer: 1.6, slower: 1.2 },
    move: 1.45,
    lineSd: 0.2,
    stumps: 0.45,
  },
};

const isSpin = (k: CricketKind) => k === 'offspin' || k === 'legspin';

export function specCricket(rng: Rng, diff: Difficulty, first = false): CricketSpec {
  const prof = CRICKET_PROFILES[diff];
  const kind: CricketKind = first ? 'pace' : rng.pick(prof.weights);
  const spin = isSpin(kind);
  const [lo, hi] = spin ? prof.spin : prof.pace;
  let speedKmh = rng.range(lo, hi);
  if (kind === 'slower') speedKmh = rng.range(lo - 22, lo - 12);
  if (kind === 'yorker') speedKmh = rng.range((lo + hi) / 2, hi + 2);
  if (kind === 'bouncer') speedKmh = rng.range((lo + hi) / 2, hi + 3);
  if (first) speedKmh = Math.min(speedKmh, lo + 2);
  const release: V3 = { x: spin ? 0.28 : 0.34 + rng.range(-0.05, 0.08), y: spin ? rng.range(1.95, 2.05) : rng.range(2.12, 2.28), z: CRICKET_GEOM.bowlerCreaseZ + 0.45 };
  // Length: distance in front of the striker's stumps where the ball pitches.
  let L: number;
  if (first) L = 3.6;
  else if (kind === 'yorker') L = rng.range(0.9, 1.9);
  else if (kind === 'bouncer') L = rng.range(10.4, 12.4);
  else if (spin) L = rng.range(3.0, 5.6);
  else L = rng.pick({ full: 3, good: 5, short: diff === 'easy' ? 0.5 : 2 }) === 'full' ? rng.range(2.6, 4.4) : rng.range(4.6, 8.2);
  // Line at the stumps: mostly stump-to-stump or the off-stump channel.
  const onStumps = first || rng.chance(prof.stumps);
  let line = onStumps ? rng.gauss(0.03, 0.05) : rng.range(0.16, 0.42 + prof.lineSd);
  if (kind === 'bouncer') line = rng.gauss(0.0, 0.25);
  let swing = 0;
  let kick = 0;
  const m = prof.move;
  if (kind === 'outswing') swing = rng.range(2.2, 3.6) * m;
  if (kind === 'inswing') swing = -rng.range(2.2, 3.6) * m;
  if (kind === 'pace' || kind === 'bouncer' || kind === 'slower') kick = rng.gauss(0, 0.45 * m);
  if (kind === 'offspin') {
    kick = -rng.range(1.2, 2.4) * m;
    swing = rng.range(0.2, 0.8) * m; // drift away before turning back in
  }
  if (kind === 'legspin') {
    kick = rng.range(1.2, 2.4) * m;
    swing = -rng.range(0.2, 0.8) * m;
  }
  if (first) {
    swing = 0;
    kick = 0;
  }
  const bounceZ = CRICKET_GEOM.stumpsZ - L;
  // Aim along the line from the release point to the intended line at the stumps, then take out the
  // sideways movement the ball will pick up (swing before pitching, seam or turn after).
  const v = ms(speedKmh) * 0.94;
  const zs = CRICKET_GEOM.stumpsZ;
  const tAir = Math.max(0.05, (bounceZ - release.z) / v);
  const after = Math.max(0, (zs - bounceZ) / (v * 0.9));
  const k = (bounceZ - release.z) / (zs - release.z);
  const bounceX = release.x + (line - release.x) * k - kick * after - swing * tAir * after * 0.8;
  return {
    kind,
    speedKmh: Math.round(speedKmh),
    bounceX,
    bounceZ,
    swing,
    kick,
    release,
    e: spin ? 0.5 : kind === 'slower' ? 0.5 : kind === 'bouncer' ? 0.62 : 0.56,
    keep: spin ? 0.86 : 0.93,
  };
}

export function planCricket(rng: Rng, diff: Difficulty, handed: 1 | -1, first = false): Delivery {
  return buildCricket(specCricket(rng, diff, first), handed);
}

// ---- baseball ----------------------------------------------------------------------------------------

export const PITCH_LABEL: Record<PitchKind, string> = {
  fastball: 'Fastball',
  curveball: 'Curveball',
  slider: 'Slider',
  changeup: 'Changeup',
};

/** Typical break (m/s² on top of gravity) for a right-handed pitcher, batter frame (+x = away from a righty). */
export const PITCH_BREAK: Record<PitchKind, { x: number; y: number }> = {
  fastball: { x: -1.8, y: 4.6 },
  curveball: { x: 2.6, y: -3.8 },
  slider: { x: 4.4, y: -0.9 },
  changeup: { x: -3.4, y: 1.8 },
};

/** Pitches are not mirrored for left-handed batters (the pitcher is a right-hander); only the notes are. */
export function buildPitch(spec: PitchSpec, handed: 1 | -1 = 1): Delivery {
  const r = BALL.baseball.radius;
  const speed = ms(spec.speedKmh);
  const air: V3 = { x: spec.breakX, y: spec.breakY, z: 0 };
  const o: FlightOpts = { sport: 'baseball', air, e: 0.35, keep: 0.7, kick: 0 };
  const zc = BASEBALL_GEOM.plateZ;
  const target: V3 = { x: spec.targetX, y: spec.targetY, z: zc };
  const v0 = solveAim(speed, spec.release, target, (v) => {
    let prev: BallState | null = null;
    let res: V3 = spec.release;
    fly(spec.release, v, { ...o, noGround: true }, SIM_DT, (_t, s) => {
      if (s.p.z >= zc) {
        const k = prev ? (zc - prev.p.z) / (s.p.z - prev.p.z) : 1;
        const a = prev ? prev.p : s.p;
        res = { x: a.x + (s.p.x - a.x) * k, y: a.y + (s.p.y - a.y) * k, z: zc };
        return false;
      }
      prev = { p: { ...s.p }, v: { ...s.v } };
      return true;
    });
    return [res.y - target.y, res.x - target.x];
  });
  const { path, bounce } = record(spec.release, v0, o, 1.55);
  const arrive = crossAt(path, BASEBALL_GEOM.contactZ);
  const cross = crossAt(path, zc);
  const g = BASEBALL_GEOM;
  const onTarget = Math.abs(cross.p.x) <= g.zoneHalfW + r && cross.p.y >= g.zoneLow - r && cross.p.y <= g.zoneHigh + r && !bounce;
  const d: Delivery = {
    sport: 'baseball',
    kind: spec.kind,
    label: PITCH_LABEL[spec.kind],
    speedKmh: Math.round(spec.speedKmh),
    release: { ...spec.release },
    v0,
    air,
    bounce: bounce && bounce.p.z < zc ? bounce : null,
    kick: 0,
    path,
    arrive,
    cross,
    onTarget,
    note: zoneNote(cross.p.x * handed, cross.p.y),
  };
  return d;
}

/** "Low and away", "Up and in", "Middle"… in the batter frame. */
export function zoneNote(x: number, y: number): string {
  const g = BASEBALL_GEOM;
  const v = y > g.zoneHigh ? 'High' : y < g.zoneLow ? 'Low' : y > 0.86 ? 'Up' : y < 0.66 ? 'Down' : '';
  const h = x > g.zoneHalfW ? 'outside' : x < -g.zoneHalfW ? 'inside' : x > 0.08 ? 'away' : x < -0.08 ? 'in' : '';
  if (!v && !h) return 'Middle';
  if (!v) return h[0].toUpperCase() + h.slice(1);
  if (!h) return v;
  return `${v} and ${h}`;
}

interface PitchProfile {
  speed: Record<PitchKind, [number, number]>;
  weights: Partial<Record<PitchKind, number>>;
  zone: number;
  move: number;
}

export const PITCH_PROFILES: Record<Difficulty, PitchProfile> = {
  easy: {
    speed: { fastball: [122, 132], curveball: [104, 110], slider: [112, 118], changeup: [108, 116] },
    weights: { fastball: 6, changeup: 2, curveball: 1 },
    zone: 0.74,
    move: 0.6,
  },
  normal: {
    speed: { fastball: [140, 150], curveball: [118, 127], slider: [130, 137], changeup: [126, 133] },
    weights: { fastball: 5, curveball: 2, slider: 2, changeup: 2 },
    zone: 0.6,
    move: 1,
  },
  hard: {
    speed: { fastball: [150, 160], curveball: [124, 132], slider: [135, 142], changeup: [131, 138] },
    weights: { fastball: 4, curveball: 2.4, slider: 2.6, changeup: 2.2 },
    zone: 0.5,
    move: 1.2,
  },
};

export function specPitch(rng: Rng, diff: Difficulty, count: { balls: number; strikes: number } = { balls: 0, strikes: 0 }, first = false): PitchSpec {
  const prof = PITCH_PROFILES[diff];
  let kind: PitchKind = first ? 'fastball' : rng.pick(prof.weights);
  // Behind in the count the pitcher grooves a fastball; ahead he expands the zone.
  if (count.balls === 3 && count.strikes < 2 && rng.chance(0.6)) kind = 'fastball';
  const [lo, hi] = prof.speed[kind];
  let speedKmh = rng.range(lo, hi);
  if (first) speedKmh = lo;
  const brk = PITCH_BREAK[kind];
  const k = prof.move * rng.range(0.8, 1.15);
  let zoneP = prof.zone;
  if (count.balls === 3) zoneP = 0.85;
  if (count.strikes === 2 && count.balls < 2) zoneP *= 0.6;
  const g = BASEBALL_GEOM;
  let tx: number;
  let ty: number;
  if (first) {
    tx = 0;
    ty = 0.78;
  } else if (rng.chance(zoneP)) {
    tx = rng.range(-g.zoneHalfW + 0.03, g.zoneHalfW - 0.03);
    ty = rng.range(g.zoneLow + 0.04, g.zoneHigh - 0.04);
    if (kind === 'curveball' || kind === 'changeup') ty = Math.min(ty, rng.range(0.55, 0.8));
  } else {
    const side = rng.pick({ away: 3, in: 1.5, low: 3, high: 1.2 });
    tx = rng.range(-0.15, 0.15);
    ty = rng.range(0.6, 0.9);
    if (side === 'away') tx = rng.range(0.27, 0.48);
    if (side === 'in') tx = -rng.range(0.27, 0.42);
    if (side === 'low') ty = rng.range(0.2, 0.4);
    if (side === 'high') ty = rng.range(1.15, 1.32);
  }
  return {
    kind,
    speedKmh: Math.round(speedKmh),
    targetX: tx,
    targetY: ty,
    breakX: first ? 0 : brk.x * k,
    breakY: first ? brk.y * 0.6 : brk.y * k,
    release: { x: -0.52, y: 1.82, z: BASEBALL_GEOM.rubberZ + 1.6 },
  };
}

export function planPitch(rng: Rng, diff: Difficulty, handed: 1 | -1, count?: { balls: number; strikes: number }, first = false): Delivery {
  return buildPitch(specPitch(rng, diff, count, first), handed);
}

/** Time (s) from release until the ball reaches the contact plane. */
export const flightTime = (d: Delivery): number => d.arrive.t;
