/**
 * Reusable motion detectors built on body-space measurements (see body.ts).
 * Body space: origin at the shoulder centre, 1 unit = shoulder width, +x = player's right, +y = up.
 * Feed every detector each new Body (one per camera frame), in time order.
 */
import type { Body } from './body';
import type { V2 } from './types';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Steering from two hands holding an imaginary wheel. */
export interface WheelState {
  /** Both hands are up in front of the body, roughly a wheel's width apart. */
  holding: boolean;
  /** -1 (full left) .. +1 (full right). Turning the wheel clockwise steers right. */
  steer: number;
  /** Wheel tilt in radians (+ = clockwise). */
  angle: number;
  /** Hands height relative to the shoulders, in shoulder widths (higher hands = positive). */
  height: number;
  /** Distance between the hands in shoulder widths. */
  spread: number;
}

export function wheel(b: Body, maxAngle = 0.75): WheelState {
  const l = b.lWrist;
  const r = b.rWrist;
  const spread = Math.hypot(r.x - l.x, r.y - l.y);
  const height = (l.y + r.y) / 2;
  const visible = b.ok && b.lWristV > 0.4 && b.rWristV > 0.4;
  const holding = visible && spread > 0.5 && spread < 3.2 && height > -1.5 && r.x > l.x - 0.3;
  // Clockwise rotation lowers the right hand: angle = -(slope of the left→right hand line).
  const angle = Math.atan2(-(r.y - l.y), Math.max(0.2, r.x - l.x));
  return { holding, steer: clamp(angle / maxAngle, -1, 1), angle, height, spread };
}

/** Torso tilt from vertical in radians (+ = leaning to the player's right), from hips to shoulders. */
export function torsoTilt(b: Body): number {
  if (!b.ok || !b.hips) return 0;
  // Shoulder centre is the origin; the hip centre sits below it.
  return Math.atan2(-b.hip.x, -b.hip.y);
}

/** Combined lean for bike-style steering: sideways shift plus torso tilt, roughly -1..1. */
export function bodyLean(b: Body): number {
  return clamp(b.lean * 0.9 + torsoTilt(b) * 2.2, -1.5, 1.5);
}

export function handsUp(b: Body): boolean {
  return b.ok && b.lWrist.y > b.nose.y + 0.3 && b.rWrist.y > b.nose.y + 0.3;
}

/** Detects jumps from the hips rising above the standing reference (needs calibration). */
export class JumpDetector {
  private airborne = false;
  private peak = 0;
  private start = 0;
  private lastRise = 0;
  private lastT = 0;
  /** Called when a jump takes off (rise is still growing). */
  onTakeoff: (t: number) => void = () => {};
  /** Called on landing with the peak height (fraction of torso length; ~0.15 small hop, ~0.35+ big jump). */
  onLand: (peak: number, t: number) => void = () => {};

  constructor(
    private threshold = 0.08,
    private minVelocity = 0.6,
  ) {}

  update(b: Body): void {
    if (!b.ok || !b.hips) return;
    const dt = Math.max(1e-3, (b.t - this.lastT) / 1000);
    const vel = (b.rise - this.lastRise) / dt;
    this.lastT = b.t;
    this.lastRise = b.rise;
    if (!this.airborne && b.rise > this.threshold && vel > this.minVelocity) {
      this.airborne = true;
      this.peak = b.rise;
      this.start = b.t;
      this.onTakeoff(b.t);
    } else if (this.airborne) {
      this.peak = Math.max(this.peak, b.rise);
      if (b.rise < this.threshold * 0.6 || b.t - this.start > 1500) {
        this.airborne = false;
        this.onLand(this.peak, b.t);
      }
    }
  }

  get inAir(): boolean {
    return this.airborne;
  }

  get height(): number {
    return this.airborne ? this.peak : 0;
  }
}

export interface Swing {
  hand: 0 | 1;
  t: number;
  /** Peak hand velocity in shoulder widths per second. */
  vx: number;
  vy: number;
  speed: number;
  /** Hand position at the peak. */
  at: V2;
}

/** Detects fast hand swings (bats, rackets, slices). One event per swing, at peak speed. */
export class SwingDetector {
  private prev: [{ p: V2; t: number } | null, { p: V2; t: number } | null] = [null, null];
  private hist: [Swing[], Swing[]] = [[], []];
  private active: [boolean, boolean] = [false, false];
  private best: [Swing | null, Swing | null] = [null, null];
  onSwing: (s: Swing) => void = () => {};

  /** `minSpeed` and `endSpeed` are in shoulder widths per second. */
  constructor(
    private minSpeed = 6,
    private endSpeed = 3,
  ) {}

  /** Latest velocity of a hand (shoulder widths per second). */
  velocity(hand: 0 | 1): V2 {
    const h = this.hist[hand];
    return h.length ? { x: h[h.length - 1].vx, y: h[h.length - 1].vy } : { x: 0, y: 0 };
  }

  update(b: Body): void {
    if (!b.ok) {
      this.prev = [null, null];
      return;
    }
    for (const hand of [0, 1] as const) {
      const p = hand === 0 ? b.lWrist : b.rWrist;
      const v = hand === 0 ? b.lWristV : b.rWristV;
      const prev = this.prev[hand];
      this.prev[hand] = v > 0.35 ? { p: { x: p.x + b.lean, y: p.y - b.duck }, t: b.t } : null;
      if (!prev || v <= 0.35) continue;
      const dt = (b.t - prev.t) / 1000;
      if (dt <= 0 || dt > 0.25) continue;
      const cur = this.prev[hand]!.p;
      const vx = (cur.x - prev.p.x) / dt;
      const vy = (cur.y - prev.p.y) / dt;
      const speed = Math.hypot(vx, vy);
      const s: Swing = { hand, t: b.t, vx, vy, speed, at: cur };
      const h = this.hist[hand];
      h.push(s);
      if (h.length > 12) h.shift();
      if (speed >= this.minSpeed) {
        this.active[hand] = true;
        if (!this.best[hand] || speed > this.best[hand]!.speed) this.best[hand] = s;
      } else if (this.active[hand] && speed < this.endSpeed) {
        this.active[hand] = false;
        if (this.best[hand]) this.onSwing(this.best[hand]!);
        this.best[hand] = null;
      }
    }
  }
}

/**
 * Detects punches: the wrist shoots out from the shoulder quickly. Uses depth when the camera provides it
 * (punching toward the TV) and arm extension otherwise.
 */
export class PunchDetector {
  private last: [{ ext: number; z: number; t: number } | null, { ext: number; z: number; t: number } | null] = [null, null];
  private cooldown: [number, number] = [0, 0];
  onPunch: (hand: 0 | 1, t: number, aim: V2) => void = () => {};

  update(b: Body): void {
    if (!b.ok) return;
    for (const hand of [0, 1] as const) {
      const w = hand === 0 ? b.lWrist : b.rWrist;
      const sh = hand === 0 ? b.lShoulder : b.rShoulder;
      const z = hand === 0 ? b.lWristZ : b.rWristZ;
      const ext = Math.hypot(w.x - sh.x, w.y - sh.y);
      const prev = this.last[hand];
      this.last[hand] = { ext, z, t: b.t };
      if (!prev || b.t < this.cooldown[hand]) continue;
      const dt = Math.max(1e-3, (b.t - prev.t) / 1000);
      const towardCamera = (prev.z - z) / dt; // shoulder widths/s toward the camera
      const outward = (ext - prev.ext) / dt;
      const raised = w.y > -1.0;
      if (raised && (towardCamera > 7 || (outward > 6 && ext > 1.1))) {
        this.cooldown[hand] = b.t + 280;
        this.onPunch(hand, b.t, { x: w.x, y: w.y });
      }
    }
  }
}

/** Running on the spot: counts knee lifts and estimates a 0..1 effort from the step rate. */
export class StepDetector {
  private up: [boolean, boolean] = [false, false];
  private steps: number[] = [];
  count = 0;
  onStep: (t: number) => void = () => {};

  update(b: Body): void {
    if (!b.ok || !b.full) return;
    // Knee height above its standing place (knees normally sit ~1.2 below the hips).
    const lift = (k: V2) => k.y - (b.hip.y - 1.2);
    for (const side of [0, 1] as const) {
      const v = lift(side === 0 ? b.lKnee : b.rKnee);
      if (!this.up[side] && v > 0.35) {
        this.up[side] = true;
        this.count++;
        this.steps.push(b.t);
        this.onStep(b.t);
      } else if (this.up[side] && v < 0.15) this.up[side] = false;
    }
    while (this.steps.length && b.t - this.steps[0] > 2000) this.steps.shift();
  }

  /** Steps per second over the last two seconds. */
  rate(now: number): number {
    const recent = this.steps.filter((t) => now - t < 2000);
    return recent.length / 2;
  }

  /** 0 (standing) .. 1 (fast running, ~3.5 steps per second). */
  effort(now: number): number {
    return clamp(this.rate(now) / 3.5, 0, 1);
  }
}

/** Holds a value for a while before reporting it (e.g. "hands up for 1.2 s"). */
export class Hold {
  private since = 0;
  constructor(private ms: number) {}
  /** Returns progress 0..1; 1 means held long enough. */
  update(active: boolean, now: number): number {
    if (!active) {
      this.since = 0;
      return 0;
    }
    if (!this.since) this.since = now;
    return Math.min(1, (now - this.since) / this.ms);
  }
  reset(): void {
    this.since = 0;
  }
}
