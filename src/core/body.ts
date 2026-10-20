import { LM, type PoseFrame, type Pt, type V2 } from './types';

/** Standing reference captured on the calibration screen. */
export interface Calibration {
  /** Shoulder width in pixels. */
  sw: number;
  /** Shoulder-centre to hip-centre distance in pixels. */
  torso: number;
  /** Shoulder centre in pixels. */
  cx: number;
  cy: number;
  /** Hip centre y in pixels. */
  hipY: number;
}

export interface Body {
  t: number;
  /** Shoulders are visible, so body-space coordinates are meaningful. */
  ok: boolean;
  /** Shoulders, hips and at least one ankle are visible. */
  full: boolean;
  /** Hips visible. */
  hips: boolean;
  /** Current scale: pixels per body unit. */
  scale: number;
  /** Shoulder centre in pixels. */
  cx: number;
  cy: number;
  lWrist: V2;
  rWrist: V2;
  lElbow: V2;
  rElbow: V2;
  lShoulder: V2;
  rShoulder: V2;
  nose: V2;
  hip: V2;
  lKnee: V2;
  rKnee: V2;
  lAnkle: V2;
  rAnkle: V2;
  lWristV: number;
  rWristV: number;
  /** Sideways shift from the calibrated position, in calibrated shoulder widths (+ = right). */
  lean: number;
  /** How far the shoulders dropped, as a fraction of calibrated torso length. */
  duck: number;
  /** How far the hips rose, as a fraction of calibrated torso length (jumping). */
  rise: number;
  /** Frame size in pixels. */
  w: number;
  h: number;
}

const VIS = 0.45;

function vis(p: Pt | undefined): boolean {
  return !!p && p.v >= VIS;
}

/** Turns raw frames into body-space measurements that do not depend on distance from the camera. */
export class BodyTracker {
  calib: Calibration | null = null;
  private scaleEma = 0;

  reset(): void {
    this.scaleEma = 0;
  }

  measure(f: PoseFrame): Body {
    const lm = f.lm;
    const empty: Body = {
      t: f.t,
      ok: false,
      full: false,
      hips: false,
      scale: this.scaleEma || 100,
      cx: f.w / 2,
      cy: f.h / 2,
      lWrist: { x: -1, y: -1 },
      rWrist: { x: 1, y: -1 },
      lElbow: { x: -0.8, y: -0.6 },
      rElbow: { x: 0.8, y: -0.6 },
      lShoulder: { x: -0.5, y: 0 },
      rShoulder: { x: 0.5, y: 0 },
      nose: { x: 0, y: 0.6 },
      hip: { x: 0, y: -1.6 },
      lKnee: { x: -0.3, y: -2.8 },
      rKnee: { x: 0.3, y: -2.8 },
      lAnkle: { x: -0.3, y: -4 },
      rAnkle: { x: 0.3, y: -4 },
      lWristV: 0,
      rWristV: 0,
      lean: 0,
      duck: 0,
      rise: 0,
      w: f.w,
      h: f.h,
    };
    if (!lm) return empty;
    const ls = lm[LM.lShoulder];
    const rs = lm[LM.rShoulder];
    if (!vis(ls) || !vis(rs)) return empty;

    const cx = (ls.x + rs.x) / 2;
    const cy = (ls.y + rs.y) / 2;
    const shoulderDist = Math.hypot(rs.x - ls.x, rs.y - ls.y);
    const lh = lm[LM.lHip];
    const rh = lm[LM.rHip];
    const hips = vis(lh) && vis(rh);
    const hipX = hips ? (lh.x + rh.x) / 2 : cx;
    const hipY = hips ? (lh.y + rh.y) / 2 : cy + shoulderDist * 1.5;
    const torso = Math.hypot(hipX - cx, hipY - cy);
    // Turning sideways shrinks the shoulder line, so floor the scale with the torso length.
    const raw = Math.max(shoulderDist, hips ? torso * 0.62 : 0);
    this.scaleEma = this.scaleEma ? this.scaleEma + 0.15 * (raw - this.scaleEma) : raw;
    const s = this.scaleEma;

    const toBody = (p: Pt): V2 => ({ x: (p.x - cx) / s, y: -(p.y - cy) / s });
    const anyAnkle = vis(lm[LM.lAnkle]) || vis(lm[LM.rAnkle]);

    let lean = 0;
    let duck = 0;
    let rise = 0;
    const c = this.calib;
    if (c) {
      lean = (cx - c.cx) / c.sw;
      duck = (cy - c.cy) / c.torso;
      rise = hips ? (c.hipY - hipY) / c.torso : 0;
    }

    return {
      t: f.t,
      ok: true,
      full: hips && anyAnkle,
      hips,
      scale: s,
      cx,
      cy,
      lWrist: toBody(lm[LM.lWrist]),
      rWrist: toBody(lm[LM.rWrist]),
      lElbow: toBody(lm[LM.lElbow]),
      rElbow: toBody(lm[LM.rElbow]),
      lShoulder: toBody(ls),
      rShoulder: toBody(rs),
      nose: toBody(lm[LM.nose]),
      hip: { x: (hipX - cx) / s, y: -(hipY - cy) / s },
      lKnee: toBody(lm[LM.lKnee]),
      rKnee: toBody(lm[LM.rKnee]),
      lAnkle: toBody(lm[LM.lAnkle]),
      rAnkle: toBody(lm[LM.rAnkle]),
      lWristV: lm[LM.lWrist].v,
      rWristV: lm[LM.rWrist].v,
      lean,
      duck,
      rise,
      w: f.w,
      h: f.h,
    };
  }

  /** Capture the standing reference from a frame. Returns false if the body is not visible enough. */
  calibrate(f: PoseFrame): boolean {
    const lm = f.lm;
    if (!lm) return false;
    const ls = lm[LM.lShoulder];
    const rs = lm[LM.rShoulder];
    const lh = lm[LM.lHip];
    const rh = lm[LM.rHip];
    if (!vis(ls) || !vis(rs) || !vis(lh) || !vis(rh)) return false;
    const cx = (ls.x + rs.x) / 2;
    const cy = (ls.y + rs.y) / 2;
    const hipY = (lh.y + rh.y) / 2;
    const sw = Math.hypot(rs.x - ls.x, rs.y - ls.y);
    const torso = Math.hypot((lh.x + rh.x) / 2 - cx, hipY - cy);
    if (sw < 8 || torso < 8) return false;
    this.calib = { sw, torso, cx, cy, hipY };
    return true;
  }
}
