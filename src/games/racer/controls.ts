/**
 * Body → driving controls for the two modes, plus the demo bot's pose generator.
 * Body space: origin at the shoulder centre, 1 unit = shoulder width, +x = player's right, +y = up.
 */
import type { Body } from '../../core/body';
import { bodyLean, wheel } from '../../core/gestures';
import type { SimParams } from '../../core/pose';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export interface Controls {
  /** Player is in a driving pose (hands on the wheel / body visible). */
  holding: boolean;
  /** Raw steering -1..1 (+ = right). */
  steer: number;
  /** 0..1 brake. */
  brake: number;
  /** Set for one update when the boost gesture is made. */
  boost: boolean;
  /** Bike: crouched behind the screen. */
  tuck: boolean;
  /** Hands height relative to the shoulders (F1) — for the HUD wheel icon. */
  height: number;
  /** Seconds since the controls were last valid. */
  lostFor: number;
}

export interface ControlMapper {
  readonly c: Controls;
  /** While true (grid and start lights) the mapper learns the player's neutral pose; no brake/boost. */
  calibrating: boolean;
  update(b: Body): void;
}

/** F1: hold an imaginary wheel. Lower hands = brake, raise hands above the shoulders = boost. */
export class WheelControls implements ControlMapper {
  readonly c: Controls = { holding: false, steer: 0, brake: 0, boost: false, tuck: false, height: 0, lostFor: 0 };
  /** Typical driving height of the hands, learnt on the grid and while driving. */
  neutral = -0.3;
  calibrating = false;
  private raisedSince = 0;
  private boostArmed = true;
  private lastOk = 0;
  private lastT = 0;

  update(b: Body): void {
    const c = this.c;
    c.boost = false;
    const w = wheel(b);
    const visible = b.ok && b.lWristV > 0.4 && b.rWristV > 0.4;
    const dt = this.lastT ? Math.min(0.5, (b.t - this.lastT) / 1000) : 0;
    this.lastT = b.t;
    if (!visible) {
      c.lostFor += dt;
      if (c.lostFor > 0.35) c.holding = false;
      c.brake = Math.max(0, c.brake - dt * 4);
      return;
    }
    if (this.calibrating && b.lWristV > 0.4 && b.rWristV > 0.4 && w.spread > 0.45 && w.spread < 3.4 && w.height > -1.4 && w.height < 0.4) {
      this.neutral = clamp(this.neutral + (w.height - this.neutral) * 0.08, -1.0, 0.2);
    }
    const brakeLine = Math.min(-0.55, this.neutral - 0.55);
    const boostLine = Math.max(0.35, this.neutral + 0.7);
    c.height = w.height;
    const spreadOk = w.spread > 0.45 && w.spread < 3.4;
    const brakeAmt = spreadOk ? smoothstep(brakeLine + 0.05, brakeLine - 0.35, w.height) : 0;
    const holding = (w.holding || brakeAmt > 0) && spreadOk;
    if (holding) {
      c.lostFor = 0;
      this.lastOk = b.t;
    } else c.lostFor = (b.t - this.lastOk) / 1000;
    c.holding = holding || c.lostFor < 0.35;
    // Learn the player's comfortable driving height (only from clearly neutral samples).
    if (holding && w.height > brakeLine + 0.15 && w.height < boostLine - 0.15) {
      this.neutral = clamp(this.neutral + (w.height - this.neutral) * 0.03, -0.8, 0.2);
    }
    c.steer = holding ? clamp(w.steer, -1, 1) : c.steer * 0.8;
    c.brake = this.calibrating ? 0 : brakeAmt;
    // Boost: hands pushed up above the shoulders briefly (≥ 120 ms), re-armed once lowered.
    const raised = w.height > boostLine && spreadOk;
    if (raised) {
      if (!this.raisedSince) this.raisedSince = b.t;
      if (this.boostArmed && !this.calibrating && b.t - this.raisedSince >= 120) {
        c.boost = true;
        this.boostArmed = false;
      }
    } else {
      this.raisedSince = 0;
      if (w.height < boostLine - 0.2) this.boostArmed = true;
    }
  }
}

/** MotoGP: lean the body to steer, crouch to tuck, drop both hands to the hips (standing tall) to brake. */
export class LeanControls implements ControlMapper {
  readonly c: Controls = { holding: false, steer: 0, brake: 0, boost: false, tuck: false, height: 0, lostFor: 0 };
  calibrating = false;
  /** Neutral lean and crouch, learnt while standing on the grid. */
  leanZero = 0;
  duckZero = 0;
  private lastT = 0;

  update(b: Body): void {
    const c = this.c;
    c.boost = false;
    const dt = this.lastT ? Math.min(0.5, (b.t - this.lastT) / 1000) : 0;
    this.lastT = b.t;
    if (!b.ok) {
      c.lostFor += dt;
      c.holding = c.lostFor < 0.4;
      c.steer *= 0.9;
      c.brake = Math.max(0, c.brake - dt * 4);
      return;
    }
    c.lostFor = 0;
    c.holding = true;
    const lean = bodyLean(b);
    if (this.calibrating) {
      this.leanZero = clamp(this.leanZero + (lean - this.leanZero) * 0.06, -0.4, 0.4);
      this.duckZero = clamp(this.duckZero + (b.duck - this.duckZero) * 0.06, -0.15, 0.15);
    }
    c.steer = clamp((lean - this.leanZero) / 0.7, -1, 1);
    const duck = b.duck - this.duckZero;
    // Tuck with hysteresis.
    if (!c.tuck && duck > 0.25) c.tuck = true;
    else if (c.tuck && duck < 0.18) c.tuck = false;
    if (this.calibrating) c.tuck = false;
    const wristsSeen = b.lWristV > 0.4 && b.rWristV > 0.4;
    const low = wristsSeen ? Math.max(b.lWrist.y, b.rWrist.y) : 0;
    c.height = low;
    const down = wristsSeen ? smoothstep(-1.2, -1.5, low) : 0;
    c.brake = this.calibrating ? 0 : down * (duck < 0.2 ? 1 : 0.5);
  }
}

// ---- demo bot -------------------------------------------------------------------------------------

/** Hands on a virtual wheel turned to `u` (-1..1); `yC` = hands height. */
export function wheelPose(u: number, yC: number, maxAngle = 0.75): SimParams {
  const a = clamp(u, -1, 1) * maxAngle;
  const R = 0.85;
  return {
    lWrist: { x: -R * Math.cos(a), y: yC + R * Math.sin(a) },
    rWrist: { x: R * Math.cos(a), y: yC - R * Math.sin(a) },
  };
}

/** Rider pose: body lean `u` (-1..1 of full steer), tuck amount, braking hands. */
export function leanPose(u: number, tuck: boolean, brake: boolean): SimParams {
  const target = clamp(u, -1, 1) * 0.7;
  const tilt = target / 3.55;
  const hands = brake
    ? { l: { x: -0.55, y: -1.95 }, r: { x: 0.55, y: -1.95 } }
    : { l: { x: -0.45, y: -0.85 }, r: { x: 0.45, y: -0.85 } };
  return { lWrist: hands.l, rWrist: hands.r, tilt, duck: brake ? 0 : tuck ? 0.38 : 0.05 };
}
