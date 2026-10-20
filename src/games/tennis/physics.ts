/**
 * Tennis ball physics (pure, deterministic): gravity, quadratic air drag, Magnus lift from spin, bounces
 * with friction/spin transfer, net and wall collisions, plus in/out tests and a shot solver.
 *
 * World: metres, y up. The net lies on z = 0; the human plays on the near half (z > 0, facing -z),
 * the opponent on the far half (z < 0). x runs across the court (+x = right as seen from the near end).
 */
export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });

export const COURT = {
  halfLength: 11.885,
  halfSingles: 4.115,
  halfDoubles: 5.485,
  service: 6.4,
  netCentre: 0.914,
  netPost: 1.07,
  /** Net posts sit 0.914 m outside the doubles sidelines. */
  netHalfWidth: 6.4,
  lineWidth: 0.05,
  /** Stadium walls (the ball rebounds off them). */
  wallZ: 18.6,
  wallX: 10.4,
};

export const BALL_R = 0.033;
const G = 9.81;
/** 0.5 * rho * Cd * A / m. */
const DRAG = 0.0195;
/** Magnus coefficient: a = MAGNUS * (w x v). */
const MAGNUS = 0.00066;
/** Moment of inertia factor I = ALPHA m R^2 (thick-walled hollow ball). */
const ALPHA = 0.55;
const SPIN_DECAY = 0.08;
export const STEP = 1 / 240;

export interface Surface {
  name: 'hard' | 'grass';
  /** Vertical coefficient of restitution at low speed. */
  e: number;
  /** Sliding friction. */
  mu: number;
}

export const SURFACES: Record<'hard' | 'grass', Surface> = {
  hard: { name: 'hard', e: 0.83, mu: 0.62 },
  grass: { name: 'grass', e: 0.77, mu: 0.42 },
};

export interface BallState {
  p: V3;
  v: V3;
  /** Angular velocity (rad/s). */
  w: V3;
}

export const cloneState = (s: BallState): BallState => ({ p: { ...s.p }, v: { ...s.v }, w: { ...s.w } });

export type FlightEventKind = 'bounce' | 'net' | 'cord' | 'wall';

export interface FlightEvent {
  kind: FlightEventKind;
  /** Seconds after the flight started. */
  t: number;
  p: V3;
  /** Speed just before the event. */
  speed: number;
}

/** Net height (top of the tape) at a given x. The cord sags towards the centre strap. */
export function netHeight(x: number): number {
  const u = Math.min(1, Math.abs(x) / COURT.netHalfWidth);
  return COURT.netCentre + (COURT.netPost - COURT.netCentre) * u * u;
}

function accel(s: BallState, out: V3): void {
  const { v, w } = s;
  const speed = Math.hypot(v.x, v.y, v.z);
  const d = DRAG * speed;
  out.x = -d * v.x + MAGNUS * (w.y * v.z - w.z * v.y);
  out.y = -G - d * v.y + MAGNUS * (w.z * v.x - w.x * v.z);
  out.z = -d * v.z + MAGNUS * (w.x * v.y - w.y * v.x);
}

/** Bounce off the court: restitution vertically, friction + spin transfer horizontally. Mutates s. */
export function bounce(s: BallState, surf: Surface): void {
  const vy = s.v.y;
  if (vy >= 0) return;
  const impact = -vy;
  const e = Math.max(surf.e - 0.12, Math.min(surf.e, surf.e - 0.008 * (impact - 4)));
  // Contact-point velocity: v + w x r, with r = (0, -R, 0).
  const ux = s.v.x + BALL_R * s.w.z;
  const uz = s.v.z - BALL_R * s.w.x;
  const u = Math.hypot(ux, uz);
  let dvx = 0;
  let dvz = 0;
  if (u > 1e-6) {
    const grip = ALPHA / (1 + ALPHA);
    const maxDv = surf.mu * (1 + e) * impact;
    const dv = Math.min(grip * u, maxDv);
    dvx = (-ux / u) * dv;
    dvz = (-uz / u) * dv;
  }
  s.v.x += dvx;
  s.v.z += dvz;
  s.v.y = impact * e;
  // Spin change from the friction impulse at the contact point: dw = (r x dv) / (ALPHA R^2).
  // r x dv = (0,-R,0) x (dvx,0,dvz) = (-R dvz, 0, R dvx)
  const k = 1 / (ALPHA * BALL_R);
  s.w.x += -dvz * k;
  s.w.z += dvx * k;
  s.w.y *= 0.7;
  s.p.y = BALL_R;
}

export interface StepInfo {
  event: FlightEventKind | null;
}

/**
 * Advance the ball by dt (use STEP). Handles court bounces, the net and the stadium walls.
 * Returns the collision that happened during the step, if any.
 */
export function stepBall(s: BallState, dt: number, surf: Surface, a: V3 = v3()): FlightEventKind | null {
  const prevZ = s.p.z;
  accel(s, a);
  s.v.x += a.x * dt;
  s.v.y += a.y * dt;
  s.v.z += a.z * dt;
  s.p.x += s.v.x * dt;
  s.p.y += s.v.y * dt;
  s.p.z += s.v.z * dt;
  const decay = 1 - SPIN_DECAY * dt;
  s.w.x *= decay;
  s.w.y *= decay;
  s.w.z *= decay;
  let ev: FlightEventKind | null = null;

  // Net: crossing the z = 0 plane between the posts.
  if ((prevZ > 0) !== (s.p.z > 0) && prevZ !== 0) {
    const f = prevZ / (prevZ - s.p.z);
    const x = s.p.x - s.v.x * dt * (1 - f);
    const y = s.p.y - s.v.y * dt * (1 - f);
    if (Math.abs(x) <= COURT.netHalfWidth) {
      const h = netHeight(x);
      if (y < h - BALL_R * 0.35) {
        // Into the net: it dies on the hitter's side.
        const side = Math.sign(prevZ);
        s.p.z = side * (BALL_R + 0.02);
        s.v.z = -s.v.z * 0.1;
        s.v.x *= 0.3;
        s.v.y = Math.min(s.v.y, 0) * 0.3;
        s.w = { x: 0, y: 0, z: 0 };
        ev = 'net';
      } else if (y < h + BALL_R) {
        // Clips the tape: loses pace and pops up. High contacts dribble over, low ones fall back.
        const frac = (y - (h - BALL_R * 0.35)) / (BALL_R * 1.35);
        const over = frac > 0.42;
        s.v.y = Math.abs(s.v.y) * 0.25 + 1.0 + frac * 1.2;
        s.v.x *= 0.55;
        s.w = { x: s.w.x * 0.2, y: 0, z: s.w.z * 0.2 };
        if (over) s.v.z *= 0.18 + 0.32 * frac;
        else {
          s.v.z *= -0.12;
          s.p.z = Math.sign(prevZ) * (BALL_R + 0.01);
        }
        s.p.y = Math.max(s.p.y, h + BALL_R * 0.5);
        ev = 'cord';
      }
    }
  }

  if (s.p.y < BALL_R && s.v.y < 0) {
    s.p.y = BALL_R;
    bounce(s, surf);
    ev = ev ?? 'bounce';
  }
  if (Math.abs(s.p.z) > COURT.wallZ && Math.sign(s.v.z) === Math.sign(s.p.z)) {
    s.p.z = Math.sign(s.p.z) * COURT.wallZ;
    s.v.z *= -0.35;
    s.v.x *= 0.6;
    s.v.y *= 0.6;
    ev = ev ?? 'wall';
  }
  if (Math.abs(s.p.x) > COURT.wallX && Math.sign(s.v.x) === Math.sign(s.p.x)) {
    s.p.x = Math.sign(s.p.x) * COURT.wallX;
    s.v.x *= -0.35;
    s.v.z *= 0.6;
    ev = ev ?? 'wall';
  }
  return ev;
}

/** A pre-computed flight: positions sampled every STEP from the moment the ball was struck. */
export class Flight {
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  readonly n: number;
  readonly events: FlightEvent[] = [];
  readonly duration: number;

  constructor(
    start: BallState,
    readonly surface: Surface,
    maxT = 6,
  ) {
    const n = Math.ceil(maxT / STEP) + 1;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    const s = cloneState(start);
    const a = v3();
    let i = 0;
    let rest = 0;
    for (; i < n; i++) {
      pos[i * 3] = s.p.x;
      pos[i * 3 + 1] = s.p.y;
      pos[i * 3 + 2] = s.p.z;
      vel[i * 3] = s.v.x;
      vel[i * 3 + 1] = s.v.y;
      vel[i * 3 + 2] = s.v.z;
      const speed = Math.hypot(s.v.x, s.v.y, s.v.z);
      const ev = stepBall(s, STEP, surface, a);
      if (ev) this.events.push({ kind: ev, t: (i + 1) * STEP, p: { ...s.p }, speed });
      // Rolling on the ground: stop once it has nearly come to rest.
      if (s.p.y <= BALL_R + 1e-3 && Math.abs(s.v.y) < 0.4) {
        s.v.y = 0;
        s.v.x *= 1 - 1.5 * STEP;
        s.v.z *= 1 - 1.5 * STEP;
        if (Math.hypot(s.v.x, s.v.z) < 0.3 && ++rest > 30) {
          i++;
          break;
        }
      }
    }
    this.n = Math.min(i, n);
    this.pos = pos;
    this.vel = vel;
    this.duration = (this.n - 1) * STEP;
  }

  /** Interpolated position at t seconds after the strike. */
  at(t: number, out: V3 = v3()): V3 {
    const f = Math.max(0, Math.min(this.n - 1, t / STEP));
    const i = Math.min(this.n - 2, Math.floor(f));
    const k = f - i;
    const p = this.pos;
    if (i < 0) {
      out.x = p[0];
      out.y = p[1];
      out.z = p[2];
      return out;
    }
    out.x = p[i * 3] + (p[i * 3 + 3] - p[i * 3]) * k;
    out.y = p[i * 3 + 1] + (p[i * 3 + 4] - p[i * 3 + 1]) * k;
    out.z = p[i * 3 + 2] + (p[i * 3 + 5] - p[i * 3 + 2]) * k;
    return out;
  }

  velAt(t: number, out: V3 = v3()): V3 {
    const i = Math.max(0, Math.min(this.n - 1, Math.round(t / STEP)));
    out.x = this.vel[i * 3];
    out.y = this.vel[i * 3 + 1];
    out.z = this.vel[i * 3 + 2];
    return out;
  }

  /** The n-th court bounce (0-based) or null. */
  bounce(k = 0): FlightEvent | null {
    let c = 0;
    for (const e of this.events) {
      if (e.kind !== 'bounce') continue;
      if (c++ === k) return e;
    }
    return null;
  }

  firstOf(kind: FlightEventKind): FlightEvent | null {
    return this.events.find((e) => e.kind === kind) ?? null;
  }
}

// ---- court regions ------------------------------------------------------------------------------

export interface Region {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Singles court half on the given side (far = the opponent's half, z < 0). */
export function singlesHalf(far: boolean): Region {
  return far
    ? { x0: -COURT.halfSingles, x1: COURT.halfSingles, z0: -COURT.halfLength, z1: 0 }
    : { x0: -COURT.halfSingles, x1: COURT.halfSingles, z0: 0, z1: COURT.halfLength };
}

/**
 * Service box the serve must land in. `serverNear` = the server plays on the near half.
 * Deuce court = the receiver's right-hand box.
 */
export function serviceBox(serverNear: boolean, side: 'deuce' | 'ad'): Region {
  // Receiver on the far half faces +z, so their right is -x. Receiver on the near half faces -z: right is +x.
  const rightIsNegX = serverNear;
  const deuceNeg = rightIsNegX;
  const neg = side === 'deuce' ? deuceNeg : !deuceNeg;
  const x0 = neg ? -COURT.halfSingles : 0;
  const x1 = neg ? 0 : COURT.halfSingles;
  return serverNear ? { x0, x1, z0: -COURT.service, z1: 0 } : { x0, x1, z0: 0, z1: COURT.service };
}

/** The ball counts as in when its contact patch touches the region (lines are part of it). */
export const IN_MARGIN = 0.015;

export function isIn(p: { x: number; z: number }, r: Region, margin = IN_MARGIN): boolean {
  return p.x >= r.x0 - margin && p.x <= r.x1 + margin && p.z >= r.z0 - margin && p.z <= r.z1 + margin;
}

/** How far outside the region (m, 0 when in). Used for "close call" reactions. */
export function outDistance(p: { x: number; z: number }, r: Region): number {
  const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1);
  const dz = Math.max(r.z0 - p.z, 0, p.z - r.z1);
  return Math.hypot(dx, dz);
}

/** True when the bounce touched a painted line (for chalk puffs). */
export function onLine(p: { x: number; z: number }): boolean {
  const w = COURT.lineWidth + BALL_R;
  const ax = Math.abs(p.x);
  const az = Math.abs(p.z);
  const inLen = az <= COURT.halfLength + w;
  const inWid = ax <= COURT.halfDoubles + w;
  const sidelines = inLen && (Math.abs(ax - COURT.halfSingles) < w || Math.abs(ax - COURT.halfDoubles) < w);
  const baseline = inWid && Math.abs(az - COURT.halfLength) < w;
  const service = ax <= COURT.halfSingles + w && Math.abs(az - COURT.service) < w;
  const centre = az <= COURT.service + w && ax < w;
  return sidelines || baseline || service || centre;
}

// ---- shot solver ---------------------------------------------------------------------------------

export interface ShotSpec {
  from: V3;
  /** Desired first bounce. */
  target: { x: number; z: number };
  /** Launch speed (m/s). */
  speed: number;
  /** Topspin (rad/s, negative = backspin/slice). */
  spin: number;
  /** Take the high (lob) solution. */
  high?: boolean;
  /** Minimum net clearance to aim for (m above the tape). */
  clearance?: number;
}

export interface ShotSolution {
  state: BallState;
  /** Where the solved trajectory first bounces. */
  landing: V3;
  /** Clearance over the net (negative = into the net). */
  clearance: number;
  /** Final launch speed (may be lowered to clear the net or raised to reach the target). */
  speed: number;
}

/** Topspin axis for a ball travelling along horizontal direction (dx, dz): w = s * (up x d). */
export function spinVector(dx: number, dz: number, topspin: number): V3 {
  const l = Math.hypot(dx, dz) || 1;
  // up x d = (0,1,0) x (dx,0,dz) = (dz, 0, -dx)
  return { x: (dz / l) * topspin, y: 0, z: (-dx / l) * topspin };
}

interface Probe {
  dist: number;
  clearance: number;
  landing: V3;
}

/** Simulate until the first bounce; reports the distance travelled along the aim and net clearance. */
function probe(from: V3, dir: { x: number; z: number }, speed: number, elev: number, spin: number, surf: Surface): Probe {
  const c = Math.cos(elev);
  const s: BallState = {
    p: { ...from },
    v: { x: dir.x * speed * c, y: speed * Math.sin(elev), z: dir.z * speed * c },
    w: spinVector(dir.x, dir.z, spin),
  };
  const a = v3();
  let clearance = 99;
  for (let i = 0; i < 2400; i++) {
    const prevZ = s.p.z;
    const ev = stepBall(s, STEP, surf, a);
    if ((prevZ > 0) !== (s.p.z > 0) || ev === 'net' || ev === 'cord') {
      if (ev === 'net') clearance = -1;
      else if (ev === 'cord') clearance = Math.min(clearance, 0);
      else clearance = Math.min(clearance, s.p.y - BALL_R - netHeight(s.p.x));
    }
    if (ev === 'net') {
      const d = (s.p.x - from.x) * dir.x + (s.p.z - from.z) * dir.z;
      return { dist: d, clearance: -1, landing: { ...s.p } };
    }
    if (ev === 'bounce') {
      const d = (s.p.x - from.x) * dir.x + (s.p.z - from.z) * dir.z;
      return { dist: d, clearance, landing: { ...s.p } };
    }
  }
  return { dist: 99, clearance, landing: { ...s.p } };
}

/**
 * Find launch velocity so the ball first lands at `target` with the given speed and spin.
 * Lowers the speed if the low solution would not clear the net by `clearance`; raises it if the
 * target is out of reach.
 */
export function solveShot(spec: ShotSpec, surf: Surface): ShotSolution {
  const dx = spec.target.x - spec.from.x;
  const dz = spec.target.z - spec.from.z;
  const D = Math.hypot(dx, dz);
  const dir = { x: dx / D, z: dz / D };
  const wantClear = spec.clearance ?? 0.12;
  let speed = spec.speed;
  let best: { elev: number; p: Probe } | null = null;
  for (let attempt = 0; attempt < 14; attempt++) {
    // Coarse scan to find the elevation of maximum range.
    let maxE = 0;
    let maxD = -1;
    for (let e = -0.25; e <= 1.2; e += 0.06) {
      const p = probe(spec.from, dir, speed, e, spec.spin, surf);
      if (p.dist > maxD) {
        maxD = p.dist;
        maxE = e;
      }
    }
    if (maxD < D) {
      speed *= 1.12;
      continue;
    }
    let lo = spec.high ? maxE : -0.3;
    let hi = spec.high ? 1.45 : maxE;
    // dist(e) rises on [lo, maxE] and falls on [maxE, hi].
    for (let it = 0; it < 26; it++) {
      const mid = (lo + hi) / 2;
      const p = probe(spec.from, dir, speed, mid, spec.spin, surf);
      const short = p.dist < D;
      if (spec.high ? !short : short) lo = mid;
      else hi = mid;
    }
    const elev = (lo + hi) / 2;
    const p = probe(spec.from, dir, speed, elev, spec.spin, surf);
    best = { elev, p };
    if (!spec.high && p.clearance < wantClear && attempt < 13) {
      speed *= 0.93;
      continue;
    }
    break;
  }
  const elev = best ? best.elev : 0.2;
  const c = Math.cos(elev);
  const state: BallState = {
    p: { ...spec.from },
    v: { x: dir.x * speed * c, y: speed * Math.sin(elev), z: dir.z * speed * c },
    w: spinVector(dir.x, dir.z, spec.spin),
  };
  return { state, landing: best ? best.p.landing : { ...spec.target, y: 0 }, clearance: best ? best.p.clearance : 0, speed };
}

/** Speed in km/h for display. */
export const kmh = (ms: number): number => Math.round(ms * 3.6);
