/**
 * The player's batter: maps the tracked grip (midpoint of both wrists, body space) to a 3D bat and poses the
 * batter around it with arm IK. Shared by the game and the pose contact sheet.
 */
import * as THREE from 'three';
import type { V2 } from '../../core/types';
import { swingHeight } from './contact';
import type { Sport } from './physics';
import type { Figure } from './world/figure';
import { BAT } from './world/props';

const clamp = THREE.MathUtils.clamp;
const smooth = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/** Where the batter's feet are: leg side of the stumps (cricket) or in the box (baseball). */
export function batterHome(sport: Sport, handed: 1 | -1): THREE.Vector3 {
  return sport === 'cricket' ? new THREE.Vector3(-0.4 * handed, 0, 0.32) : new THREE.Vector3(-0.85 * handed, 0, -0.25);
}

/**
 * Grip position and bat direction (unit, grip → toe). The bat swings in a plane through the hands; it is upright
 * for drives when the hands are low and flattens for pulls / baseball swings. The player's back-lift side (their
 * right for a right-hander) maps to behind the batter, the follow-through to in front.
 */
export function batPose(g: V2, sport: Sport, handed: 1 | -1): { grip: THREE.Vector3; dir: THREE.Vector3 } {
  const h = handed;
  const cricket = sport === 'cricket';
  const home = batterHome(sport, handed);
  const S = new THREE.Vector3(home.x, 1.38, home.z);
  const f = new THREE.Vector3(h, 0, 0); // facing (off side / over the plate)
  const b = new THREE.Vector3(0, 0, 1); // towards the keeper / catcher
  const U = new THREE.Vector3(0, 1, 0);
  const sx = clamp(g.x * h, -1.6, 1.6);
  const gy = clamp(g.y, -2.2, 1.0);
  const flat = cricket ? clamp((gy + 0.9) / 0.6, 0, 0.85) : 0.86;
  // Grip height chosen so the sweet spot passes at swingHeight(gy) at the bottom of the arc, which is what the
  // timing/height judgement uses.
  const bottomY = swingHeight(gy) + 0.55 * (1 - flat) + 0.06 * flat;
  const edge = smooth((Math.abs(sx) - 0.4) / 0.9);
  const gripY = bottomY + edge * 0.15;
  const reach = (cricket ? 0.42 : 0.38) - 0.22 * smooth(Math.abs(sx));
  const grip = new THREE.Vector3(S.x, gripY, S.z).addScaledVector(f, reach).addScaledVector(b, 0.28 * clamp(sx, -1.2, 1.2));
  // Bat angle in the swing plane (B = back, U = up): 0 = hanging down (contact / stance), +135° = back-lift
  // over the back shoulder, -145° = follow-through over the front shoulder.
  const side = Math.tanh(sx * 3);
  const elev = smooth((gy + 1.3) / 1.3);
  const alpha = elev * side * (side >= 0 ? 135 : 145) * (Math.PI / 180);
  const B = new THREE.Vector3(0.42 * h, 0, 1).normalize();
  const dir = U.clone().multiplyScalar(-Math.cos(alpha)).addScaledVector(B, Math.sin(alpha));
  // Flat bat across the line for pulls and baseball swings when the hands come through high.
  const flatK = flat * (1 - Math.abs(side));
  if (flatK > 0) dir.lerp(f.clone().addScaledVector(U, -0.15), flatK);
  dir.normalize();
  return { grip, dir };
}

/** Pose the batter's body and arms around the bat and place the bat mesh (local -y = grip → toe). */
export function poseBatter(fig: Figure, bat: THREE.Object3D, g: V2, sport: Sport, handed: 1 | -1): { grip: THREE.Vector3; dir: THREE.Vector3 } {
  const h = handed;
  const { grip, dir } = batPose(g, sport, handed);
  const sx = clamp(g.x * h, -1.6, 1.6);
  fig.reset();
  // Stance: knees flexed, weight forward into the swing, chest coils and opens with the hands.
  const stride = smooth((-sx + 0.2) / 1.2) * 0.3;
  fig.setHips(-0.06 - stride * 0.15);
  fig.r('thighL', -0.3 - stride, 0, 0.2);
  fig.r('thighR', -0.18, 0, -0.16);
  fig.r('shinL', 0.5 + stride * 0.6);
  fig.r('shinR', 0.42);
  fig.r('footL', -0.2);
  fig.r('footR', -0.2);
  const coil = clamp(-sx * 0.45, -0.7, 0.7) * h;
  fig.r('spine', 0.22, coil * 0.45, 0, 'YXZ');
  fig.r('chest', 0.1, coil * 0.55, 0, 'YXZ');
  fig.r('head', 0.08, ((Math.PI / 2) * 0.92) * h - coil, 0, 'YXZ');
  const home = batterHome(sport, handed);
  fig.root.position.copy(home);
  fig.root.rotation.y = (Math.PI / 2) * h;
  fig.root.updateMatrixWorld(true);
  const B = BAT[sport];
  const top = grip.clone().addScaledVector(dir, B.hands[0]);
  const bottom = grip.clone().addScaledVector(dir, B.hands[1]);
  const topSide: 'L' | 'R' = h > 0 ? 'L' : 'R';
  const botSide: 'L' | 'R' = h > 0 ? 'R' : 'L';
  fig.reachArm(topSide, top, new THREE.Vector3(home.x - 0.5 * h, 0.6, home.z - 0.6));
  fig.reachArm(botSide, bottom, new THREE.Vector3(home.x - 0.2 * h, 0.5, home.z + 0.8));
  bat.position.copy(grip);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
  // Twist about the handle so the face (local +z) points down the pitch.
  const face = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  const want = new THREE.Vector3(0, 0, -1).sub(dir.clone().multiplyScalar(-dir.z)).normalize();
  if (want.lengthSq() > 0.01) {
    const axis = dir.clone().negate();
    const ang = Math.atan2(new THREE.Vector3().crossVectors(face, want).dot(axis), face.dot(want));
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, ang));
  }
  bat.quaternion.copy(q);
  return { grip, dir };
}
