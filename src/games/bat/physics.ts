/**
 * Ball physics shared by deliveries and hits. Pure functions, no three.js.
 *
 * World frame (metres): y up, the ball is delivered from -z towards +z, +x is screen-right in the batting view.
 * Cricket: the striker's popping crease is z = 0, the striker's stumps z = +1.22, the bowler's stumps z = -18.9.
 * Baseball: the back tip of home plate is the origin, the pitcher's rubber is at z = -18.44.
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
export const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const len = (a: V3): number => Math.hypot(a.x, a.y, a.z);
export const lerp3 = (a: V3, b: V3, k: number): V3 => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k });
export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const DEG = Math.PI / 180;
export const G = 9.81;

export type Sport = 'cricket' | 'baseball';

export interface BallSpec {
  radius: number;
  /** Quadratic drag constant k in a = -k |v| v (1/m) for deliveries. */
  drag: number;
  /** Drag and backspin lift constants for batted balls. */
  hitDrag: number;
  hitLift: number;
}

export const BALL: Record<Sport, BallSpec> = {
  // 156 g, 72 mm. Tuned so a delivery loses ~5% to drag over 18 m, as ball-tracking data shows.
  cricket: { radius: 0.036, drag: 0.0034, hitDrag: 0.0052, hitLift: 0.0012 },
  // 145 g, 73 mm. A 95 mph fastball arrives at ~88 mph.
  baseball: { radius: 0.0366, drag: 0.005, hitDrag: 0.0054, hitLift: 0.0016 },
};

export interface BallState {
  p: V3;
  v: V3;
}

/**
 * One semi-implicit Euler step with gravity, quadratic drag, a constant extra acceleration (swing / pitch break)
 * and a lift term perpendicular to the velocity in the vertical plane (backspin carry on batted balls).
 */
export function step(s: BallState, dt: number, drag: number, extra: V3 = { x: 0, y: 0, z: 0 }, lift = 0): void {
  const v = s.v;
  const sp = Math.hypot(v.x, v.y, v.z);
  let ax = extra.x - drag * sp * v.x;
  let ay = extra.y - G - drag * sp * v.y;
  let az = extra.z - drag * sp * v.z;
  if (lift > 0 && sp > 1) {
    // Unit vector perpendicular to v, in the vertical plane containing v, pointing up.
    const h = Math.hypot(v.x, v.z);
    if (h > 1e-3) {
      const nx = (-v.y * v.x) / h / sp;
      const ny = h / sp;
      const nz = (-v.y * v.z) / h / sp;
      const a = lift * sp * sp;
      ax += a * nx;
      ay += a * ny;
      az += a * nz;
    }
  }
  v.x += ax * dt;
  v.y += ay * dt;
  v.z += az * dt;
  s.p.x += v.x * dt;
  s.p.y += v.y * dt;
  s.p.z += v.z * dt;
}

/** Horizontal distance from a point on the ground plane. */
export const flatDist = (a: V3, b: V3 = { x: 0, y: 0, z: 0 }): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Direction (unit) for an azimuth in degrees: 0 = straight back down the ground (-z), + = towards +x. */
export function azimuthDir(deg: number): { x: number; z: number } {
  return { x: Math.sin(deg * DEG), z: -Math.cos(deg * DEG) };
}

/** Azimuth in degrees of a ground vector (inverse of azimuthDir). */
export function azimuthOf(x: number, z: number): number {
  return Math.atan2(x, -z) / DEG;
}

/** Velocity vector from speed (m/s), launch angle and azimuth (degrees). */
export function launchVector(speed: number, launchDeg: number, azimuthDeg: number): V3 {
  const c = Math.cos(launchDeg * DEG);
  const d = azimuthDir(azimuthDeg);
  return { x: speed * c * d.x, y: speed * Math.sin(launchDeg * DEG), z: speed * c * d.z };
}

export const kmh = (ms: number): number => ms * 3.6;
export const ms = (kmh: number): number => kmh / 3.6;
