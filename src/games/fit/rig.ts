/**
 * Canonical skeleton: turns a move Pose into 3D joint positions (2-bone IK for arms and legs), projects them to the
 * 2D body space the camera tracker measures, and converts them into SimPose parameters for the demo bot.
 * Units are shoulder widths; proportions match SimPose (torso 1.5, arm 1.55, legs 2.4).
 */
import type { Body } from '../../core/body';
import type { SimParams } from '../../core/pose';
import type { V2 } from '../../core/types';
import type { Pose, V3 } from './moves';

export const SK = {
  upper: 0.8,
  fore: 0.75,
  torso: 1.5,
  hipHalf: 0.32,
  thigh: 1.2,
  shin: 1.2,
  ankleX: 0.34,
  ankleY: -3.9,
  nose: 0.78,
};

export type M3 = [V3, V3, V3]; // rows

export interface Joints {
  pelvis: V3;
  S: V3;
  ls: V3;
  rs: V3;
  le: V3;
  re: V3;
  lw: V3;
  rw: V3;
  lh: V3;
  rh: V3;
  lk: V3;
  rk: V3;
  la: V3;
  ra: V3;
  nose: V3;
  /** Torso rotation (torso frame → world). */
  R: M3;
  pose: Pose;
}

// ---- tiny vector helpers --------------------------------------------------------------------

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function mul(m: M3, v: V3): V3 {
  return [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
}

function mm(a: M3, b: M3): M3 {
  const col = (j: number): V3 => [b[0][j], b[1][j], b[2][j]];
  const c0 = col(0);
  const c1 = col(1);
  const c2 = col(2);
  return [
    [dot(a[0], c0), dot(a[0], c1), dot(a[0], c2)],
    [dot(a[1], c0), dot(a[1], c1), dot(a[1], c2)],
    [dot(a[2], c0), dot(a[2], c1), dot(a[2], c2)],
  ];
}

const rotX = (t: number): M3 => [
  [1, 0, 0],
  [0, Math.cos(t), -Math.sin(t)],
  [0, Math.sin(t), Math.cos(t)],
];
const rotY = (t: number): M3 => [
  [Math.cos(t), 0, Math.sin(t)],
  [0, 1, 0],
  [-Math.sin(t), 0, Math.cos(t)],
];
const rotZ = (t: number): M3 => [
  [Math.cos(t), -Math.sin(t), 0],
  [Math.sin(t), Math.cos(t), 0],
  [0, 0, 1],
];

/** Torso rotation: twist (yaw), then forward pitch, then side tilt (+ = shoulders to the right). */
export function torsoRotation(tilt: number, pitch: number, twist: number): M3 {
  return mm(rotZ(-tilt), mm(rotX(pitch), rotY(twist)));
}

/**
 * Two-bone IK: returns [joint, end] for a chain from `a` toward `target` with segment lengths l1, l2; the middle joint
 * bends toward `pole`. The end is pulled in when the target is out of reach.
 */
export function ik2(a: V3, target: V3, l1: number, l2: number, pole: V3): [V3, V3] {
  let d = sub(target, a);
  let dist = len(d);
  const maxD = (l1 + l2) * 0.999;
  const minD = Math.abs(l1 - l2) + 1e-3;
  if (dist < 1e-6) d = [0, -1, 0];
  const dir = norm(d);
  dist = Math.min(maxD, Math.max(minD, dist));
  const end = add(a, scale(dir, dist));
  const along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  let p = sub(pole, scale(dir, dot(pole, dir)));
  if (len(p) < 1e-4) p = Math.abs(dir[1]) < 0.9 ? cross(dir, [0, 1, 0]) : cross(dir, [1, 0, 0]);
  p = norm(p);
  return [add(add(a, scale(dir, along)), scale(p, h)), end];
}

/** Solve the canonical skeleton for a pose. */
export function solve(pose: Pose): Joints {
  const R = torsoRotation(pose.tilt, pose.pitch, pose.twist);
  const pelvis: V3 = [pose.px, -SK.torso + pose.py, pose.pz];
  const S = add(pelvis, mul(R, [0, SK.torso, 0]));
  const ls = add(S, mul(R, [-0.5, 0, 0]));
  const rs = add(S, mul(R, [0.5, 0, 0]));
  const [le, lw] = ik2(ls, add(S, mul(R, pose.lw)), SK.upper, SK.fore, mul(R, pose.lp));
  const [re, rw] = ik2(rs, add(S, mul(R, pose.rw)), SK.upper, SK.fore, mul(R, pose.rp));
  const Rh = rotY(-pose.twist * 0.25);
  const lh = add(pelvis, mul(Rh, [-SK.hipHalf, 0, 0]));
  const rh = add(pelvis, mul(Rh, [SK.hipHalf, 0, 0]));
  const lift = Math.max(0, pose.py);
  const laT: V3 = [-SK.ankleX + pose.lf[0], SK.ankleY + pose.lf[1] + lift, pose.lf[2]];
  const raT: V3 = [SK.ankleX + pose.rf[0], SK.ankleY + pose.rf[1] + lift, pose.rf[2]];
  const [lk, la] = ik2(lh, laT, SK.thigh, SK.shin, pose.lkp);
  const [rk, ra] = ik2(rh, raT, SK.thigh, SK.shin, pose.rkp);
  const nose = add(S, mul(R, [0, SK.nose, 0.12 - pose.head * 0.2]));
  return { pelvis, S, ls, rs, le, re, lw, rw, lh, rh, lk, rk, la, ra, nose, R, pose };
}

// ---- 2D observations ------------------------------------------------------------------------

/** A pose as the camera tracker sees it: body space (relative to the shoulder centre, shoulder widths). */
export interface Obs {
  /** Song time (s). */
  t: number;
  ls: V2;
  rs: V2;
  le: V2;
  re: V2;
  lw: V2;
  rw: V2;
  hip: V2;
  lk: V2;
  rk: V2;
  la: V2;
  ra: V2;
  nose: V2;
  lean: number;
  duck: number;
  rise: number;
  ok: boolean;
  full: boolean;
  hips: boolean;
  /** Lowest wrist visibility. */
  wv: number;
}

export function obsFromJoints(j: Joints, t = 0): Obs {
  const sw = Math.hypot(j.rs[0] - j.ls[0], j.rs[1] - j.ls[1]);
  const torso2 = Math.hypot(j.pelvis[0] - j.S[0], j.pelvis[1] - j.S[1]);
  const s = Math.max(sw, torso2 * 0.62, 0.3);
  const p = (v: V3): V2 => ({ x: (v[0] - j.S[0]) / s, y: (v[1] - j.S[1]) / s });
  return {
    t,
    ls: p(j.ls),
    rs: p(j.rs),
    le: p(j.le),
    re: p(j.re),
    lw: p(j.lw),
    rw: p(j.rw),
    hip: p(j.pelvis),
    lk: p(j.lk),
    rk: p(j.rk),
    la: p(j.la),
    ra: p(j.ra),
    nose: p(j.nose),
    lean: j.S[0],
    duck: -j.S[1] / SK.torso,
    rise: (j.pelvis[1] + SK.torso) / SK.torso,
    ok: true,
    full: true,
    hips: true,
    wv: 1,
  };
}

export function obsFromBody(b: Body, t: number): Obs {
  return {
    t,
    ls: b.lShoulder,
    rs: b.rShoulder,
    le: b.lElbow,
    re: b.rElbow,
    lw: b.lWrist,
    rw: b.rWrist,
    hip: b.hip,
    lk: b.lKnee,
    rk: b.rKnee,
    la: b.lAnkle,
    ra: b.rAnkle,
    nose: b.nose,
    lean: b.lean,
    duck: b.duck,
    rise: b.rise,
    ok: b.ok,
    full: b.full,
    hips: b.hips,
    wv: Math.min(b.lWristV, b.rWristV),
  };
}

const lv = (a: V2, b: V2, k: number): V2 => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });

export function lerpObs(a: Obs, b: Obs, k: number): Obs {
  return {
    t: a.t + (b.t - a.t) * k,
    ls: lv(a.ls, b.ls, k),
    rs: lv(a.rs, b.rs, k),
    le: lv(a.le, b.le, k),
    re: lv(a.re, b.re, k),
    lw: lv(a.lw, b.lw, k),
    rw: lv(a.rw, b.rw, k),
    hip: lv(a.hip, b.hip, k),
    lk: lv(a.lk, b.lk, k),
    rk: lv(a.rk, b.rk, k),
    la: lv(a.la, b.la, k),
    ra: lv(a.ra, b.ra, k),
    nose: lv(a.nose, b.nose, k),
    lean: a.lean + (b.lean - a.lean) * k,
    duck: a.duck + (b.duck - a.duck) * k,
    rise: a.rise + (b.rise - a.rise) * k,
    ok: a.ok && b.ok,
    full: a.full && b.full,
    hips: a.hips && b.hips,
    wv: Math.min(a.wv, b.wv),
  };
}

// ---- demo bot -------------------------------------------------------------------------------

/** SimPose parameters that make the simulated tracker report the given joints (see SimPose.build). */
export function toSim(j: Joints): SimParams {
  const T = SK.torso;
  const tilt = Math.atan2(j.S[0] - j.pelvis[0], j.S[1] - j.pelvis[1]);
  const st = Math.sin(tilt);
  const ct = Math.cos(tilt);
  // SimPose rotates the upper body about the hips; this is where the rotated shoulder centre lands.
  const srot: V2 = { x: T * st, y: -T + T * ct };
  const v = -j.S[1] / T - (1 - ct);
  const duck = Math.max(0, v);
  const rise = Math.max(0, -v);
  const unrot = (p: V3): V2 => {
    const w = { x: p[0] - j.S[0], y: p[1] - j.S[1] };
    const q = { x: w.x + srot.x, y: w.y + srot.y };
    const dx = q.x;
    const dy = q.y + T;
    const r = { x: dx * ct - dy * st, y: -T + dx * st + dy * ct };
    return r.y >= -T ? r : q;
  };
  const kneeUp = (k: V3) => Math.max(-0.5, Math.min(1.6, k[1] - j.pelvis[1] + SK.thigh - 1.5 * duck));
  return {
    lWrist: unrot(j.lw),
    rWrist: unrot(j.rw),
    lElbow: unrot(j.le),
    rElbow: unrot(j.re),
    lean: j.S[0] - T * st,
    duck,
    rise,
    tilt,
    lWristZ: -(j.lw[2] - j.S[2]),
    rWristZ: -(j.rw[2] - j.S[2]),
    lKneeUp: kneeUp(j.lk),
    rKneeUp: kneeUp(j.rk),
  };
}
