/**
 * Arcade vehicle model in track coordinates, AI drivers, car-to-car contact, steering smoothing and gearbox.
 * Pure logic (no rendering) so it can be unit-tested and stepped at a fixed rate.
 */
import { KERB_W, accelAt, curvAhead, gripAt, sampleAt, wrapS, type TrackData, type VehicleSpec } from './track';

export type Surface = 'road' | 'kerb' | 'grass' | 'gravel';

export interface CarState {
  /** Continuous progress along the circuit (m); negative = behind the start line on lap 1. */
  p: number;
  /** Lateral offset (m, + right). */
  d: number;
  /** Heading relative to the track tangent (rad, + right). */
  psi: number;
  /** Speed (m/s). */
  v: number;
  /** 0..1 how much the tyres are sliding (smoke, squeal). */
  slip: number;
  /** Rightward path curvature actually driven this step (1/m). */
  kAct: number;
  /** Lateral acceleration (m/s², + right). */
  lat: number;
  /** Longitudinal acceleration (m/s²). */
  lon: number;
  surface: Surface;
  /** Barrier impact speed this step (m/s, 0 = none) and side (+1 right, -1 left). */
  wallHit: number;
  wallSide: number;
  /** Remaining boost time (s). */
  boost: number;
  /** Tucked in behind the screen (bike). */
  tuck: boolean;
  /** Brake input this step (for brake lights / sound). */
  braking: number;
  throttle: number;
}

export interface DriveInput {
  /** Requested rightward path curvature (1/m). */
  curv: number;
  throttle: number;
  brake: number;
  tuck?: boolean;
}

export function newCar(p: number, d: number): CarState {
  return { p, d, psi: 0, v: 0, slip: 0, kAct: 0, lat: 0, lon: 0, surface: 'road', wallHit: 0, wallSide: 0, boost: 0, tuck: false, braking: 0, throttle: 0 };
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Curvature produced by full steering lock at speed v (speed-sensitive ratio). */
export function steerCurv(spec: VehicleSpec, v: number): number {
  return 1 / (spec.steerR0 + spec.steerK * v * v);
}

export function surfaceAt(t: TrackData, s: number, d: number): Surface {
  const ad = Math.abs(d);
  if (ad <= t.hw) return 'road';
  const right = d > 0;
  const kerb = sampleAt(t, right ? t.kerbR : t.kerbL, s) > 0.5;
  if (kerb && ad <= t.hw + KERB_W) return 'kerb';
  if (ad <= t.hw + 0.6) return 'road';
  const gravel = sampleAt(t, right ? t.gravelR : t.gravelL, s) > 0.5;
  return gravel && ad > t.hw + KERB_W ? 'gravel' : 'grass';
}

const GRIP_MUL: Record<Surface, number> = { road: 1, kerb: 0.92, grass: 0.55, gravel: 0.45 };

/** Advance one car by dt seconds. */
export function stepCar(t: TrackData, spec: VehicleSpec, c: CarState, inp: DriveInput, dt: number): void {
  const s = wrapS(t, c.p);
  const kt = sampleAt(t, t.curv, s);
  c.surface = surfaceAt(t, s, c.d);
  const v = c.v;
  const grip = gripAt(spec, v) * GRIP_MUL[c.surface];
  const kGrip = grip / Math.max(v * v, 4);
  const kReq = inp.curv;
  const kAct = clamp(kReq, -kGrip, kGrip);
  const over = Math.abs(kReq) > kGrip ? (Math.abs(kReq) - kGrip) / kGrip : 0;
  const slipTarget = clamp(over * 1.4 + (inp.brake > 0.6 && v > 25 ? 0.25 : 0), 0, 1) * clamp(v / 12, 0, 1);
  c.slip += (slipTarget - c.slip) * Math.min(1, dt * 10);
  c.kAct = kAct;

  // Longitudinal.
  c.tuck = !!inp.tuck;
  const boosting = c.boost > 0;
  if (boosting) c.boost = Math.max(0, c.boost - dt);
  let top = spec.vTop;
  if (spec.kind === 'f1' && boosting) top += spec.vBonus;
  if (spec.kind === 'moto') top = c.tuck ? spec.vTop + spec.vBonus : spec.vTop;
  if (c.surface === 'grass') top *= 0.55;
  if (c.surface === 'gravel') top *= 0.4;
  const thr = clamp(inp.throttle, 0, 1);
  const brk = clamp(inp.brake, 0, 1);
  let a = thr * accelAt(spec, v, top) * (boosting ? 1.35 : 1);
  if (v > top) a -= (v - top) * 0.6; // off-track or after boost: bleed off excess speed
  a -= brk * spec.brake * (v > 1 ? 1 : v);
  a -= 0.25 + (1 - thr) * 0.0016 * v * v; // rolling + engine braking when lifting
  if (c.surface === 'grass') a -= 3 + 0.1 * v;
  if (c.surface === 'gravel') a -= 7 + 0.22 * v;
  if (c.surface === 'kerb') a -= 0.6;
  a -= c.slip * (1.5 + 0.06 * v);
  c.v = Math.max(0, v + a * dt);
  c.lon = a;
  c.braking = brk;
  c.throttle = thr;

  // Kinematics in track coordinates.
  const vm = (v + c.v) / 2;
  const sdot = (vm * Math.cos(c.psi)) / Math.max(0.2, 1 + c.d * kt);
  c.p += sdot * dt;
  c.d += vm * Math.sin(c.psi) * dt;
  c.psi += (vm * kAct + kt * sdot) * dt;
  if (c.psi > Math.PI) c.psi -= 2 * Math.PI;
  if (c.psi < -Math.PI) c.psi += 2 * Math.PI;
  c.lat = vm * vm * kAct;

  // Barriers: deflect along the wall and scrub speed, never a dead stop.
  c.wallHit = 0;
  const s2 = wrapS(t, c.p);
  const halfW = spec.width / 2 + 0.15;
  const wr = sampleAt(t, t.wallR, s2) - halfW;
  const wl = -(sampleAt(t, t.wallL, s2) - halfW);
  if (c.d > wr || c.d < wl) {
    const side = c.d > wr ? 1 : -1;
    c.d = side > 0 ? wr : wl;
    const into = Math.sin(c.psi) * side; // > 0 when heading into the wall
    if (into > 0) {
      const vn = c.v * into;
      c.wallHit = Math.max(0.5, vn);
      c.wallSide = side;
      c.psi = -c.psi * 0.25;
      const keep = clamp(1 - 0.12 - into * 0.9, 0.42, 0.97);
      const before = c.v;
      c.v = Math.max(Math.min(before, 9), before * keep);
    } else {
      c.wallHit = 0;
    }
  }
}

// ---- following the road --------------------------------------------------------------------------

/**
 * Pure-pursuit curvature (rightward) that steers a car toward lateral offset `targetD` at `look` metres ahead,
 * including the road's own curvature as feed-forward.
 */
export function pursuitCurv(t: TrackData, c: CarState, targetD: number, look: number): number {
  const s = wrapS(t, c.p);
  const kt = curvAhead(t, s, look * 0.6);
  const e = targetD - c.d;
  const lat = e - look * Math.sin(c.psi);
  return -kt / Math.max(0.3, 1 + c.d * kt) + (2 * lat) / (look * look);
}

export function lookahead(v: number): number {
  return 9 + v * 0.42;
}

// ---- AI ---------------------------------------------------------------------------------------------

export interface Racer {
  car: CarState;
  /** True for the player. */
  human: boolean;
  finished: boolean;
}

export class AIDriver {
  private offset = 0;
  private wobble: number;
  /** Extra pace multiplier from rubber-banding (set by the race each frame). */
  band = 1;
  /** Launch delay after lights out (s). */
  reaction: number;

  constructor(
    /** 0.8 .. 1.02 fraction of the ideal speed profile. */
    public skill: number,
    seed: number,
  ) {
    this.wobble = (seed * 0.618) % 1;
    this.reaction = 0.15 + ((seed * 0.37) % 1) * 0.35;
  }

  drive(t: TrackData, profile: Float32Array, me: CarState, others: CarState[], dt: number, raceTime: number): DriveInput {
    const s = wrapS(t, me.p);
    const look = lookahead(me.v);
    const lineAhead = sampleAt(t, t.line, s + look);
    // Pace: profile a little ahead so braking starts on time.
    let vT = Math.min(sampleAt(t, profile, s + me.v * 0.12), sampleAt(t, profile, s + me.v * 0.35 + 4)) * this.skill * this.band;
    // Traffic: pass slower cars ahead, otherwise follow them.
    let want = 0;
    let side = 0;
    for (const o of others) {
      if (o === me) continue;
      let ds = o.p - me.p;
      if (ds < -t.length / 2) ds += t.length;
      if (ds > t.length / 2) ds -= t.length;
      const dd = o.d - me.d;
      // Alongside: hold a lane instead of squeezing into the other car.
      if (Math.abs(ds) < 7 && Math.abs(dd) < 2.8) side -= Math.sign(dd || 1) * (2.8 - Math.abs(dd)) * 1.3;
      if (ds <= 0 || ds > 30) continue;
      if (Math.abs(dd) > 3.4) continue;
      if (vT > o.v + 0.5) {
        // Pick the side with more room relative to the car ahead.
        const right = o.d < sampleAt(t, t.line, s + ds) ? 1 : -1;
        const room = right > 0 ? t.hw - 1.4 - o.d : t.hw - 1.4 + o.d;
        want = room > 2.6 ? right * 3.1 : -right * 3.1;
        want = o.d + want - lineAhead;
      }
      if (ds < 10 + me.v * 0.22 && Math.abs(dd) < 2.2) vT = Math.min(vT, o.v - 0.3 - (ds < 7 ? 2 : 0));
    }
    this.offset += (want + side - this.offset) * Math.min(1, dt * 1.6);
    const wob = Math.sin(raceTime * 0.35 + this.wobble * 20) * 0.35;
    const targetD = clamp(lineAhead + this.offset + wob, -t.hw + 1.2, t.hw - 1.2);
    const curv = pursuitCurv(t, me, targetD, look);
    let throttle = 1;
    let brake = 0;
    const err = vT - me.v;
    if (err < -1.2) {
      throttle = 0;
      brake = clamp(-err / 6, 0.15, 1);
    } else if (err < 0.5) throttle = clamp(0.4 + err, 0, 1);
    if (raceTime < this.reaction) {
      throttle = 0;
      brake = 1;
    }
    return { curv, throttle, brake, tuck: me.v > 50 && Math.abs(sampleAt(t, t.curv, s)) < 1 / 300 };
  }
}

// ---- contact between cars ------------------------------------------------------------------------------

export interface Contact {
  a: number;
  b: number;
  /** Closing speed (m/s). */
  strength: number;
  side: boolean;
}

/** Resolve overlaps between cars (in track coordinates). Returns the contacts that happened. */
export function collide(t: TrackData, cars: CarState[], len: number, wid: number): Contact[] {
  const out: Contact[] = [];
  const L = t.length;
  for (let i = 0; i < cars.length; i++)
    for (let j = i + 1; j < cars.length; j++) {
      const A = cars[i];
      const B = cars[j];
      let ds = B.p - A.p;
      ds -= Math.round(ds / L) * L;
      if (Math.abs(ds) >= len) continue;
      const dd = B.d - A.d;
      if (Math.abs(dd) >= wid) continue;
      const ox = wid - Math.abs(dd);
      const oy = len - Math.abs(ds);
      const front = ds > 0 ? B : A;
      const rear = ds > 0 ? A : B;
      if (ox < oy * 0.75) {
        // Side by side: push apart sideways.
        const push = ox / 2 + 0.02;
        const sgn = dd >= 0 ? 1 : -1;
        B.d += push * sgn;
        A.d -= push * sgn;
        const rel = Math.abs(Math.sin(A.psi) * A.v - Math.sin(B.psi) * B.v);
        A.psi *= 0.6;
        B.psi *= 0.6;
        A.v *= 0.995;
        B.v *= 0.995;
        out.push({ a: i, b: j, strength: Math.max(1, rel), side: true });
      } else {
        // Nose to tail: the rear car loses speed, the front one gets a nudge.
        const closing = rear.v - front.v;
        const fix = oy + 0.02;
        rear.p -= fix * 0.7;
        front.p += fix * 0.3;
        if (closing > 0) {
          rear.v = Math.max(0, front.v - closing * 0.35);
          front.v += closing * 0.25;
        }
        out.push({ a: i, b: j, strength: Math.max(0.5, closing), side: false });
      }
    }
  return out;
}

// ---- input smoothing --------------------------------------------------------------------------------------

/**
 * Smooths raw steering from the camera: small dead zone, gentle response curve near the centre, then a
 * speed-sensitive low-pass and rate limit so the car feels planted at speed instead of twitchy.
 */
export class SteerFilter {
  value = 0;
  constructor(
    private deadzone = 0.05,
    private expo = 1.35,
  ) {}

  shape(raw: number): number {
    const a = Math.abs(raw);
    if (a <= this.deadzone) return 0;
    const u = Math.min(1, (a - this.deadzone) / (1 - this.deadzone));
    return Math.sign(raw) * Math.pow(u, this.expo);
  }

  /** Raw input that produces shaped output u (inverse of `shape`), used by the demo bot. */
  unshape(u: number): number {
    const a = Math.min(1, Math.abs(u));
    if (a === 0) return 0;
    return Math.sign(u) * (this.deadzone + (1 - this.deadzone) * Math.pow(a, 1 / this.expo));
  }

  /** `speedFrac` = speed / top speed (0..1). */
  update(raw: number, speedFrac: number, dt: number): number {
    const target = this.shape(raw);
    const f = clamp(speedFrac, 0, 1);
    const tau = 0.07 + 0.12 * f;
    const k = 1 - Math.exp(-dt / tau);
    let next = this.value + (target - this.value) * k;
    const maxRate = (5.5 - 3 * f) * dt;
    next = this.value + clamp(next - this.value, -maxRate, maxRate);
    this.value = next;
    return next;
  }

  reset(): void {
    this.value = 0;
  }
}

// ---- gearbox (sound + HUD) -----------------------------------------------------------------------------

export class Gearbox {
  gear = 1;
  rpm: number;
  /** Seconds since the last shift (for the shift "cut"). */
  sinceShift = 1;
  private tops: number[];
  constructor(
    readonly gears: number,
    vTop: number,
    readonly idle: number,
    readonly redline: number,
  ) {
    this.rpm = idle;
    // Gear g tops out at vTop·((g / gears) ^ 0.78).
    this.tops = Array.from({ length: gears }, (_, i) => vTop * 1.04 * Math.pow((i + 1) / gears, 0.78));
  }

  /** Returns +1 on an upshift, -1 on a downshift, 0 otherwise. */
  update(v: number, throttle: number, dt: number): number {
    this.sinceShift += dt;
    let shifted = 0;
    const top = this.tops[this.gear - 1];
    if (v > top * 0.97 && this.gear < this.gears) {
      this.gear++;
      shifted = 1;
    } else if (this.gear > 1 && v < this.tops[this.gear - 2] * 0.72) {
      this.gear--;
      shifted = -1;
    }
    if (shifted) this.sinceShift = 0;
    const lo = this.gear === 1 ? 0 : this.tops[this.gear - 2] * 0.55;
    const hi = this.tops[this.gear - 1];
    const frac = clamp((v - lo) / (hi - lo), 0, 1.05);
    let target = this.idle + (this.redline - this.idle) * (0.28 + 0.72 * frac);
    if (v < 1) target = this.idle + (this.redline - this.idle) * 0.35 * throttle;
    const k = Math.min(1, dt * (shifted ? 30 : 12));
    this.rpm += (target - this.rpm) * k;
    return shifted;
  }
}
