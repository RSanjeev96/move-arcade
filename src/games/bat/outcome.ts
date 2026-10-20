/**
 * What happens after the bat meets the ball: flight and roll on the field, fielders reaching it, catches,
 * boundaries, runs (cricket) and hits/outs (baseball). Pure logic; the 3D scene replays the result.
 */
import { BALL, DEG, azimuthOf, clamp, flatDist, step, type BallState, type Sport, type V3 } from './physics';
import type { Rng } from './rng';

// ---- grounds ----------------------------------------------------------------------------------------

export const CRICKET_FIELD = {
  /** Centre of the ground (middle of the pitch). */
  cz: -8.84,
  /** Boundary rope ellipse semi-axes (m): across and along the pitch. */
  ax: 63,
  az: 67,
  /** Stands start this far behind the rope and rise with this slope. */
  standGap: 9,
  standSlope: 0.52,
  standH0: 2.2,
};

export const BASEBALL_PARK = {
  /** Fence distance from home at the foul lines and in centre field (m). */
  lines: 99,
  centre: 122,
  wallH: 3.0,
  standGap: 4,
  standSlope: 0.55,
  standH0: 3.6,
  /** Bases (batter frame), 27.43 m apart. */
  bases: [
    { x: 19.4, z: -19.4 },
    { x: 0, z: -38.8 },
    { x: -19.4, z: -19.4 },
    { x: 0, z: 0 },
  ],
};

/** Distance (from the field centre) to the cricket boundary in the direction of (x, z). */
export function ropeRadius(x: number, z: number): number {
  const F = CRICKET_FIELD;
  const dz = z - F.cz;
  const ang = Math.atan2(x, dz);
  const s = Math.sin(ang);
  const c = Math.cos(ang);
  return 1 / Math.sqrt((s * s) / (F.ax * F.ax) + (c * c) / (F.az * F.az));
}

/** How far beyond the rope a point is (negative = inside). */
export function beyondRope(x: number, z: number): number {
  const F = CRICKET_FIELD;
  return Math.hypot(x, z - F.cz) - ropeRadius(x, z);
}

/** Outfield fence distance from home plate at azimuth (deg). */
export function fenceDistance(azDeg: number): number {
  const P = BASEBALL_PARK;
  const a = clamp(Math.abs(azDeg), 0, 50);
  const c = Math.cos(2 * a * DEG);
  return P.lines + (P.centre - P.lines) * Math.max(0, c) ** 1.6;
}

export const isFair = (azDeg: number): boolean => Math.abs(azDeg) <= 45;

/** Height of the stands surface under a point (0 on the field). */
export function standHeight(sport: Sport, x: number, z: number): number {
  if (sport === 'cricket') {
    const F = CRICKET_FIELD;
    const b = beyondRope(x, z) - F.standGap;
    return b < 0 ? 0 : F.standH0 + b * F.standSlope;
  }
  const P = BASEBALL_PARK;
  const az = azimuthOf(x, z);
  const d = Math.hypot(x, z);
  if (z > 2 || Math.abs(az) > 95) return 0; // behind home, handled by the backstop
  const fence = Math.abs(az) <= 45 ? fenceDistance(az) : 99 * Math.cos((Math.abs(az) - 45) * DEG) + 18;
  const b = d - fence - P.standGap;
  return b < 0 ? 0 : P.standH0 + b * P.standSlope;
}

// ---- hit flight ---------------------------------------------------------------------------------------

export interface TrackPoint {
  t: number;
  p: V3;
}

export interface HitTrack {
  pts: TrackPoint[];
  /** First ground contact (or landing in the stands). */
  landT: number;
  landP: V3;
  /** Flat distance from the batter where the ball would come down at ground level ("carry"). */
  carry: number;
  apex: number;
  /** Ball left the field over the rope / fence without bouncing. */
  overAir: boolean;
  /** Ball crossed the rope after bouncing (cricket four) or the wall was hit (baseball). */
  overGround: boolean;
  /** Time it crossed the rope / fence line. */
  crossT: number;
  /** Baseball: bounced off the wall. */
  wallT: number;
  /** Ended in the crowd. */
  inStands: boolean;
  endT: number;
}

const HIT_DT = 1 / 240;

/** Simulate a batted ball from the bat until it stops, leaves the ground or lands in the stands. */
export function simulateHit(sport: Sport, from: V3, v0: V3, liftK = 1): HitTrack {
  const spec = BALL[sport];
  const r = spec.radius;
  const s: BallState = { p: { ...from }, v: { ...v0 } };
  let lift = spec.hitLift * liftK;
  const pts: TrackPoint[] = [{ t: 0, p: { ...from } }];
  let t = 0;
  let landT = -1;
  let landP: V3 = { ...from };
  let apex = from.y;
  let overAir = false;
  let overGround = false;
  let crossT = -1;
  let wallT = -1;
  let inStands = false;
  let bounced = false;
  let rolling = false;
  let carry = -1;
  // Ghost flight for the carry distance (ignores the stands).
  {
    const g: BallState = { p: { ...from }, v: { ...v0 } };
    let gl = lift;
    for (let i = 0; i < 4000 && g.p.y > 0; i++) {
      step(g, HIT_DT, spec.hitDrag, undefined, gl);
      gl *= 0.9985;
    }
    carry = flatDist(g.p);
  }
  for (let i = 0; i < 240 * 16; i++) {
    if (!rolling) {
      step(s, HIT_DT, spec.hitDrag, undefined, bounced ? 0 : lift);
      lift *= 0.9985;
    } else {
      const h = Math.hypot(s.v.x, s.v.z);
      // Rolling resistance on a fast outfield plus a little grass drag at speed.
      const dec = (sport === 'cricket' ? 1.4 : 2.2) + 0.004 * h * h;
      const nh = Math.max(0, h - dec * HIT_DT);
      const k = h > 1e-6 ? nh / h : 0;
      s.v.x *= k;
      s.v.z *= k;
      s.v.y = 0;
      s.p.x += s.v.x * HIT_DT;
      s.p.z += s.v.z * HIT_DT;
      s.p.y = r;
    }
    t += HIT_DT;
    apex = Math.max(apex, s.p.y);

    // Leaving the field.
    if (crossT < 0) {
      if (sport === 'cricket') {
        if (beyondRope(s.p.x, s.p.z) > 0) {
          crossT = t;
          if (!bounced) overAir = true;
          else overGround = true;
        }
      } else if (s.p.z < 0) {
        const az = azimuthOf(s.p.x, s.p.z);
        const fd = isFair(az) ? fenceDistance(az) : 1e9;
        if (Math.hypot(s.p.x, s.p.z) >= fd) {
          if (s.p.y > BASEBALL_PARK.wallH && !bounced) {
            crossT = t;
            overAir = true;
          } else if (wallT < 0) {
            // Off the wall: bounce back towards the infield.
            wallT = t;
            const d = Math.hypot(s.p.x, s.p.z);
            const nx = s.p.x / d;
            const nz = s.p.z / d;
            const vr = s.v.x * nx + s.v.z * nz;
            s.v.x = (s.v.x - vr * nx) * 0.55 - 0.35 * vr * nx;
            s.v.z = (s.v.z - vr * nz) * 0.55 - 0.35 * vr * nz;
            s.p.x = nx * (fd - 0.2);
            s.p.z = nz * (fd - 0.2);
            overGround = true;
          }
        }
      }
    }

    const floor = crossT >= 0 || sport === 'baseball' ? standHeight(sport, s.p.x, s.p.z) : 0;
    if (floor > 0 && s.p.y <= floor + r) {
      if (landT < 0) {
        landT = t;
        landP = { ...s.p };
      }
      inStands = true;
      pts.push({ t, p: { ...s.p } });
      break;
    }
    if (!rolling && s.p.y < r && s.v.y < 0) {
      if (landT < 0) {
        landT = t;
        landP = { ...s.p, y: r };
      }
      s.p.y = r;
      if (Math.abs(s.v.y) < 1.4) {
        rolling = true;
      } else {
        const e = sport === 'cricket' ? 0.4 : 0.45;
        const keep = bounced ? 0.82 : 0.7;
        s.v.y = -s.v.y * e;
        s.v.x *= keep;
        s.v.z *= keep;
      }
      bounced = true;
    }
    if (i % 2 === 1) pts.push({ t, p: { ...s.p } });
    const sp = Math.hypot(s.v.x, s.v.y, s.v.z);
    if (rolling && sp < 0.25) break;
    // Once it is over the rope on the ground, a few metres more is enough for the replay.
    if (overGround && sport === 'cricket' && t - crossT > 0.6) break;
  }
  if (landT < 0) {
    landT = t;
    landP = { ...s.p };
  }
  const last = pts[pts.length - 1];
  if (last.t < t) pts.push({ t, p: { ...s.p } });
  return { pts, landT, landP, carry, apex, overAir, overGround, crossT, wallT, inStands, endT: t };
}

export function pointAt(track: HitTrack, t: number): V3 {
  const pts = track.pts;
  if (t <= 0) return pts[0].p;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].p;
  let lo = 0;
  let hi = pts.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (pts[m].t <= t) lo = m;
    else hi = m;
  }
  const a = pts[lo];
  const b = pts[hi];
  const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return { x: a.p.x + (b.p.x - a.p.x) * k, y: a.p.y + (b.p.y - a.p.y) * k, z: a.p.z + (b.p.z - a.p.z) * k };
}

// ---- fielders ----------------------------------------------------------------------------------------

export interface Fielder {
  name: string;
  x: number;
  z: number;
  /** Top running speed (m/s), reaction time (s), reach without diving (m), catching skill 0..1. */
  speed: number;
  react: number;
  reach: number;
  hands: number;
  deep: boolean;
  role: 'fielder' | 'keeper' | 'bowler' | 'pitcher' | 'catcher';
}

interface Spot {
  name: string;
  az: number;
  /** Distance from the striker in metres, or a fraction of the boundary when <= 1. */
  r: number;
}

const CRICKET_SETS: Record<'standard' | 'death', Spot[]> = {
  standard: [
    { name: 'slip', az: 160, r: 17 },
    { name: 'point', az: 94, r: 24 },
    { name: 'cover', az: 54, r: 26 },
    { name: 'mid-off', az: 16, r: 25 },
    { name: 'mid-on', az: -16, r: 25 },
    { name: 'mid-wicket', az: -56, r: 26 },
    { name: 'square leg', az: -96, r: 24 },
    { name: 'fine leg', az: -148, r: 0.9 },
    { name: 'long-on', az: -22, r: 0.92 },
  ],
  death: [
    { name: 'point', az: 92, r: 25 },
    { name: 'extra cover', az: 38, r: 27 },
    { name: 'mid-wicket', az: -44, r: 26 },
    { name: 'short fine leg', az: -132, r: 19 },
    { name: 'deep cover', az: 62, r: 0.92 },
    { name: 'long-off', az: 13, r: 0.93 },
    { name: 'long-on', az: -15, r: 0.93 },
    { name: 'deep mid-wicket', az: -62, r: 0.92 },
    { name: 'deep square leg', az: -98, r: 0.91 },
  ],
};

/** The fielding side for a right-handed (handed = 1) or left-handed (-1) striker. */
export function cricketField(set: 'standard' | 'death', handed: 1 | -1, spin = false): Fielder[] {
  const out: Fielder[] = CRICKET_SETS[set].map((s) => {
    const az = s.az * handed;
    const dx = Math.sin(az * DEG);
    const dz = -Math.cos(az * DEG);
    let r = s.r;
    if (r <= 1) {
      // Fraction of the boundary distance in that direction (measured from the striker).
      let lo = 5;
      let hi = 120;
      for (let i = 0; i < 30; i++) {
        const m = (lo + hi) / 2;
        if (beyondRope(dx * m, dz * m) > 0) hi = m;
        else lo = m;
      }
      r = lo * r;
    }
    const deep = s.r <= 1;
    return { name: s.name, x: dx * r, z: dz * r, speed: deep ? 7.4 : 6.9, react: deep ? 0.42 : 0.3, reach: deep ? 1.5 : 1.3, hands: 0.9, deep, role: 'fielder' as const };
  });
  out.push({ name: 'keeper', x: (spin ? 0.9 : 0.4) * handed, z: spin ? 2.1 : 13, speed: 5.5, react: 0.2, reach: 1.7, hands: 0.94, deep: false, role: 'keeper' });
  out.push({ name: 'bowler', x: 1.2, z: -14.2, speed: 5.5, react: 0.28, reach: 1.1, hands: 0.86, deep: false, role: 'bowler' });
  return out;
}

/** The defence. Baseball fields do not mirror: first base is always on the right as seen from home. */
export function baseballField(): Fielder[] {
  const P = (name: string, x: number, z: number, deep: boolean, role: Fielder['role'] = 'fielder'): Fielder => ({
    name,
    x,
    z,
    speed: deep ? 7.6 : 6.6,
    react: deep ? 0.38 : 0.28,
    reach: deep ? 1.6 : 1.25,
    hands: deep ? 0.97 : 0.95,
    deep,
    role,
  });
  return [
    P('pitcher', 0.6, -17.2, false, 'pitcher'),
    P('catcher', 0.1, 1.55, false, 'catcher'),
    P('first base', 17.8, -23.5, false),
    P('second base', 9.5, -34.5, false),
    P('shortstop', -10, -33.5, false),
    P('third base', -17.8, -23.5, false),
    P('left field', -32, -76, true),
    P('center field', 0, -92, true),
    P('right field', 32, -76, true),
  ];
}

/** Time (s after contact) a fielder needs to get to point p. */
export function timeToReach(f: Fielder, p: { x: number; z: number }, reach = f.reach): number {
  const d = Math.max(0, Math.hypot(p.x - f.x, p.z - f.z) - reach);
  // Short acceleration phase, then top speed.
  return f.react + (d < 3 ? d / (f.speed * 0.65) : 3 / (f.speed * 0.65) + (d - 3) / f.speed);
}

export interface Play {
  kind: 'catch' | 'drop' | 'field' | 'none';
  fielder: number;
  /** Time (after contact) the fielder catches / collects the ball. */
  t: number;
  at: V3;
  /** Diving effort. */
  dive: boolean;
}

const CATCH_H = 2.5;
const DIVE_EXTRA = 1.3;

/** Best catch chance on the airborne part of the track: the fielder with the most time to spare. */
function findCatch(track: HitTrack, fielders: Fielder[], tMin: number): { f: number; i: number; margin: number; dive: boolean } | null {
  let best: { f: number; i: number; margin: number; dive: boolean } | null = null;
  for (let f = 0; f < fielders.length; f++) {
    const fd = fielders[f];
    let mine: { i: number; margin: number; dive: boolean } | null = null;
    for (let i = 1; i < track.pts.length; i++) {
      const pt = track.pts[i];
      if (pt.t > track.landT) break;
      if (track.crossT >= 0 && pt.t >= track.crossT) break;
      if (pt.t < tMin || pt.p.y > CATCH_H || pt.p.y < 0.12) continue;
      const m = pt.t - timeToReach(fd, pt.p);
      if (m >= 0) {
        if (!mine || mine.dive || m >= mine.margin) mine = { i, margin: m, dive: false };
      } else if (!mine) {
        const md = pt.t - timeToReach(fd, pt.p, fd.reach + DIVE_EXTRA);
        if (md >= 0) mine = { i, margin: md, dive: true };
      }
    }
    if (!mine) continue;
    if (!best || (best.dive && !mine.dive) || (best.dive === mine.dive && mine.margin > best.margin)) best = { f, ...mine };
  }
  return best;
}

/** Earliest point on the track (after it has come down to fieldable height) a fielder can collect it. */
function findStop(track: HitTrack, fielders: Fielder[], tMin: number): { f: number; i: number } | null {
  for (let i = 1; i < track.pts.length; i++) {
    const pt = track.pts[i];
    if (pt.t < tMin || pt.p.y > 1.1) continue;
    if (track.crossT >= 0 && pt.t >= track.crossT) return null;
    let best = -1;
    let bestNeed = 1e9;
    for (let f = 0; f < fielders.length; f++) {
      const fd = fielders[f];
      const need = timeToReach(fd, pt.p, fd.reach + (fd.deep ? 0.4 : 0.6));
      if (need <= pt.t && need < bestNeed) {
        best = f;
        bestNeed = need;
      }
    }
    if (best >= 0) return { f: best, i };
  }
  return null;
}

// ---- cricket ---------------------------------------------------------------------------------------

export type CricketResult = 'six' | 'four' | 'caught' | 'runs';

export interface CricketOutcome {
  result: CricketResult;
  runs: number;
  /** Carry distance for the readout (m). */
  distance: number;
  play: Play;
  /** Ball returned to the stumps (s after contact), when fielded. */
  returnT: number;
  /** Where the ball is thrown to. */
  throwTo: V3;
  /** Human text, e.g. "Caught at long-on". */
  label: string;
}

/** Times (s after contact) at which the batters complete each run. */
export const RUN_TIMES = [3.5, 6.5, 9.5, 12.6];

export function resolveCricket(track: HitTrack, fielders: Fielder[], rng: Rng, edge: boolean): CricketOutcome {
  const none: Play = { kind: 'none', fielder: -1, t: 0, at: track.landP, dive: false };
  const dist = Math.round(track.carry);
  // Airborne chances first (edges to the keeper and slip, skiers, boundary catches).
  const c = findCatch(track, fielders, 0.08);
  if (c) {
    const fd = fielders[c.f];
    const pt = track.pts[c.i];
    const ballSpeed = estSpeed(track, c.i);
    let p = fd.hands * (c.dive ? 0.42 : 0.62 + 0.36 * clamp(c.margin / 0.7, 0, 1));
    if (ballSpeed > 24) p *= clamp(1 - (ballSpeed - 24) / 40, 0.55, 1);
    if (edge && fd.role === 'keeper') p = Math.max(p, 0.86);
    if (rng.chance(p)) {
      return {
        result: 'caught',
        runs: 0,
        distance: dist,
        play: { kind: 'catch', fielder: c.f, t: pt.t, at: { ...pt.p }, dive: c.dive },
        returnT: pt.t,
        throwTo: pt.p,
        label: fd.role === 'keeper' ? 'Caught behind' : fd.role === 'bowler' ? 'Caught and bowled' : `Caught at ${fd.name}`,
      };
    }
    // Dropped: the ball spills near the fielder, who gathers it a moment later.
    if (!track.overAir) {
      const at = { ...pt.p, y: 0.04 };
      const tCollect = pt.t + 0.9;
      return fieldedRuns(track, fielders, c.f, tCollect, at, dist, rng, `Dropped by ${fd.name}!`, true);
    }
  }
  if (track.overAir) return { result: 'six', runs: 6, distance: dist, play: none, returnT: 0, throwTo: track.landP, label: `${dist} m` };
  const stop = findStop(track, fielders, 0.1);
  if (!stop) {
    return { result: 'four', runs: 4, distance: dist, play: none, returnT: 0, throwTo: track.landP, label: track.landT < 0.6 ? 'Along the ground' : 'One bounce' };
  }
  const pt = track.pts[stop.i];
  let tCollect = pt.t + 0.35;
  let label = '';
  const fast = estSpeed(track, stop.i) > 16;
  if (fast && rng.chance(0.07)) {
    tCollect += 1.1;
    label = 'Misfield!';
  }
  return fieldedRuns(track, fielders, stop.f, tCollect, { ...pt.p, y: 0.04 }, dist, rng, label, false);
}

function fieldedRuns(track: HitTrack, fielders: Fielder[], f: number, tCollect: number, at: V3, dist: number, rng: Rng, label: string, dropped: boolean): CricketOutcome {
  const fd = fielders[f];
  // Throw to whichever end is closer.
  const ends: V3[] = [
    { x: 0, y: 0.6, z: 1.22 },
    { x: 0, y: 0.6, z: -18.9 },
  ];
  const to = ends.reduce((a, b) => (flatDist(at, a) < flatDist(at, b) ? a : b));
  const d = flatDist(at, to);
  const returnT = tCollect + 0.4 + d / 27 + (d > 55 ? 0.35 : 0);
  let runs = 0;
  for (const rt of RUN_TIMES) if (rt + 0.3 <= returnT) runs++;
  runs = Math.min(runs, 3);
  if (runs === 3 && rng.chance(0.4)) runs = 2; // batters are not always that brave
  void track;
  return {
    result: 'runs',
    runs,
    distance: dist,
    play: { kind: dropped ? 'drop' : 'field', fielder: f, t: tCollect, at, dive: false },
    returnT,
    throwTo: to,
    label: label || (runs === 0 ? `Fielded at ${fd.name}` : runs === 1 ? 'Quick single' : runs === 2 ? 'Two runs' : 'Three runs'),
  };
}

function estSpeed(track: HitTrack, i: number): number {
  const a = track.pts[Math.max(0, i - 1)];
  const b = track.pts[Math.min(track.pts.length - 1, i + 1)];
  const dt = b.t - a.t;
  return dt > 0 ? Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y, b.p.z - a.p.z) / dt : 0;
}

// ---- baseball -------------------------------------------------------------------------------------

export type BaseballResult = 'hr' | 'single' | 'double' | 'triple' | 'out' | 'foul';

export interface BaseballOutcome {
  result: BaseballResult;
  outKind?: 'fly' | 'line' | 'ground' | 'pop' | 'foul';
  /** Bases reached by the batter (0 for an out or foul, 4 for a home run). */
  bases: number;
  distance: number;
  play: Play;
  /** For runners: a deep fly ball lets a runner on third tag up. */
  deep: boolean;
  label: string;
  /** Throw target after the fielder collects the ball. */
  throwTo: V3;
}

/** Times (s after contact) the batter-runner reaches first, second, third and home. */
export const BASE_TIMES = [4.25, 8.3, 12.4, 16.5];

const FIELD_NAMES: Record<string, string> = {
  pitcher: 'the pitcher',
  catcher: 'the catcher',
  'first base': 'first',
  'second base': 'second',
  shortstop: 'short',
  'third base': 'third',
  'left field': 'left',
  'center field': 'center',
  'right field': 'right',
};

function fieldName(f: Fielder): string {
  return FIELD_NAMES[f.name] ?? f.name;
}

export function resolveBaseball(track: HitTrack, fielders: Fielder[], rng: Rng, launch: number): BaseballOutcome {
  const P = BASEBALL_PARK;
  const dist = Math.round(track.carry);
  const none: Play = { kind: 'none', fielder: -1, t: 0, at: track.landP, dive: false };
  const landAz = azimuthOf(track.landP.x, track.landP.z);
  const first = P.bases[0];
  const firstV: V3 = { x: first.x, y: 1.2, z: first.z };
  // Fair or foul is decided where the ball lands (or passes the bases on the ground).
  const passBases = track.pts.find((p) => Math.hypot(p.p.x, p.p.z) > 28 && p.p.y < 1.5);
  const judgeAz = track.landT > 0 && flatDist(track.landP) > 28 ? landAz : passBases ? azimuthOf(passBases.p.x, passBases.p.z) : landAz;
  const foul = !isFair(judgeAz) || track.landP.z > 0.3;
  if (track.overAir && !foul) {
    return { result: 'hr', bases: 4, distance: dist, play: none, deep: true, label: `${dist} m · ${Math.round(dist * 3.281)} ft`, throwTo: track.landP };
  }
  const c = findCatch(track, fielders, 0.15);
  if (c) {
    const fd = fielders[c.f];
    const pt = track.pts[c.i];
    const spd = estSpeed(track, c.i);
    let p = fd.hands * (c.dive ? 0.45 : 0.82 + 0.16 * clamp(c.margin / 0.6, 0, 1));
    if (spd > 30) p *= 0.75;
    const foulBall = !isFair(azimuthOf(pt.p.x, pt.p.z)) || pt.p.z > 0.3;
    if (foulBall) p *= 0.85;
    if (rng.chance(p)) {
      const kind = foulBall ? 'foul' : launch > 50 ? 'pop' : launch < 16 ? 'line' : 'fly';
      const what = kind === 'pop' ? 'Pop out' : kind === 'line' ? 'Line out' : kind === 'foul' ? 'Foul out' : 'Fly out';
      return {
        result: 'out',
        outKind: kind,
        bases: 0,
        distance: dist,
        play: { kind: 'catch', fielder: c.f, t: pt.t, at: { ...pt.p }, dive: c.dive },
        deep: flatDist(pt.p) > 70,
        label: `${what} to ${fieldName(fd)}`,
        throwTo: { x: 0, y: 1.2, z: -38.8 },
      };
    }
  }
  if (foul) return { result: 'foul', bases: 0, distance: dist, play: none, deep: false, label: 'Foul ball', throwTo: track.landP };
  const stop = findStop(track, fielders, 0.12);
  if (!stop) {
    // Nobody got there before it stopped (rare): a long hit.
    return { result: 'double', bases: 2, distance: dist, play: none, deep: true, label: 'Into the gap', throwTo: track.landP };
  }
  const fd = fielders[stop.f];
  const pt = track.pts[stop.i];
  const tCollect = pt.t + 0.35;
  const at: V3 = { ...pt.p, y: 0.04 };
  const play: Play = { kind: 'field', fielder: stop.f, t: tCollect, at, dive: false };
  if (!fd.deep && flatDist(at) < 45) {
    // Infielder: race the throw to first.
    const throwT = tCollect + 0.5 + flatDist(at, firstV) / 34;
    const safe = BASE_TIMES[0] + rng.gauss(0, 0.12) < throwT || rng.chance(0.04);
    if (!safe) return { result: 'out', outKind: 'ground', bases: 0, distance: dist, play, deep: false, label: `Ground out to ${fieldName(fd)}`, throwTo: firstV };
    return { result: 'single', bases: 1, distance: dist, play, deep: false, label: 'Infield single', throwTo: firstV };
  }
  // Outfield: how far can the batter get before the throw arrives?
  let bases = 1;
  for (let k = 1; k < 3; k++) {
    const b = P.bases[k];
    const throwD = flatDist(at, { x: b.x, y: 0, z: b.z });
    const arrive = tCollect + 0.55 + throwD / 31 + (throwD > 65 ? 0.4 : 0);
    if (BASE_TIMES[k] + 0.25 < arrive) bases = k + 1;
    else break;
  }
  const res: BaseballResult = bases === 1 ? 'single' : bases === 2 ? 'double' : 'triple';
  const where = landAz < -15 ? 'left' : landAz > 15 ? 'right' : 'center';
  const tgt = P.bases[Math.min(bases, 2)];
  return {
    result: res,
    bases,
    distance: dist,
    play,
    deep: true,
    label: `${res === 'single' ? 'Single' : res === 'double' ? 'Double' : 'Triple'} to ${track.wallT > 0 && track.wallT < tCollect ? 'the wall in ' : ''}${where}`,
    throwTo: { x: tgt.x, y: 1.2, z: tgt.z },
  };
}
