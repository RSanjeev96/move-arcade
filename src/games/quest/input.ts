/**
 * Turns body measurements into Sky Quest intents. Pure apart from the shared detectors, so it can be
 * tested with synthetic bodies.
 *  - run on the spot (StepDetector) → forward speed; auto-run when the legs are out of view
 *  - lean (bodyLean) → lane, with hysteresis
 *  - hop / big jump (JumpDetector: takeoff, then peak ≥ BIG_RISE while still in the air)
 *  - duck (shoulder drop)
 *  - punch (PunchDetector) → shot from that hand
 */
import type { Body } from '../../core/body';
import { bodyLean, JumpDetector, PunchDetector, StepDetector } from '../../core/gestures';
import type { V2 } from '../../core/types';
import type { Lane } from './levels';

/** Hip rise (fraction of torso) that counts as a big jump. */
export const BIG_RISE = 0.25;
export const LEAN_IN = 0.36;
export const LEAN_OUT = 0.22;
export const DUCK_IN = 0.22;
export const DUCK_OUT = 0.13;

export type Intent =
  | { type: 'takeoff'; t: number }
  | { type: 'big'; t: number }
  | { type: 'land'; t: number; peak: number }
  | { type: 'punch'; t: number; hand: 0 | 1; aim: V2 }
  | { type: 'step'; t: number };

export class InputMapper {
  readonly jump = new JumpDetector(0.08, 0.6);
  readonly steps = new StepDetector();
  readonly punch = new PunchDetector();
  lane: Lane = 0;
  lean = 0;
  duck = false;
  /** Legs are visible (with hysteresis), so running on the spot controls speed. */
  legs = true;
  seen = false;
  lastSeenT = 0;
  lastStepT = -1e9;
  private legsFlip = 0;
  private bigSent = false;
  private queue: Intent[] = [];
  private lastT = 0;

  constructor() {
    this.jump.onTakeoff = (t) => {
      this.bigSent = false;
      this.queue.push({ type: 'takeoff', t });
    };
    this.jump.onLand = (peak, t) => this.queue.push({ type: 'land', t, peak });
    this.punch.onPunch = (hand, t, aim) => this.queue.push({ type: 'punch', t, hand, aim });
    this.steps.onStep = (t) => {
      this.lastStepT = t;
      this.queue.push({ type: 'step', t });
    };
  }

  feed(b: Body): void {
    this.lastT = b.t;
    if (!b.ok) {
      this.seen = false;
      return;
    }
    this.seen = true;
    this.lastSeenT = b.t;
    this.jump.update(b);
    if (this.jump.inAir && !this.bigSent && this.jump.height >= BIG_RISE) {
      this.bigSent = true;
      this.queue.push({ type: 'big', t: b.t });
    }
    this.steps.update(b);
    // Arms pump while running and fling up on jumps: only count punches while standing fairly still vertically.
    if (!this.jump.inAir) this.punch.update(b);

    // Lean → lane (smoothed, with hysteresis so the lane does not flicker at the threshold).
    const raw = bodyLean(b);
    this.lean += 0.55 * (raw - this.lean);
    const v = this.lean;
    if (v < -LEAN_IN) this.lane = -1;
    else if (v > LEAN_IN) this.lane = 1;
    else if (Math.abs(v) < LEAN_OUT) this.lane = 0;

    // Duck (not while jumping: the landing squat is not a duck).
    if (this.jump.inAir) this.duck = false;
    else if (b.duck > DUCK_IN) this.duck = true;
    else if (b.duck < DUCK_OUT) this.duck = false;

    // Legs in view, with 1.2 s hysteresis.
    if (b.full !== this.legs) {
      if (!this.legsFlip) this.legsFlip = b.t;
      if (b.t - this.legsFlip > 1200) {
        this.legs = b.full;
        this.legsFlip = 0;
      }
    } else this.legsFlip = 0;
  }

  /** Running effort 0..1 from the step rate; 0 when no step for a while. */
  effort(now: number): number {
    if (now - this.lastStepT > 750) return 0;
    const rate = this.steps.rate(now);
    // A single fresh step already means "moving": ramp from a jog to a sprint.
    return Math.max(0.35, Math.min(1, rate / 3.2));
  }

  /** Target forward speed (m/s). */
  speed(now: number, maxSpeed: number, autoSpeed: number, autoRun: boolean): number {
    if (!this.seen && now - this.lastSeenT > 800) return 0;
    if (autoRun || !this.legs) return autoSpeed;
    const e = this.effort(now);
    return e <= 0 ? 0 : maxSpeed * (0.45 + 0.55 * e);
  }

  /** Intents since the last call, oldest first. */
  drain(): Intent[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }

  get time(): number {
    return this.lastT;
  }
}
