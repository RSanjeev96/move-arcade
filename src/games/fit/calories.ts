/**
 * Calorie and effort estimates. Energy = MET × body weight (kg) × hours, where the MET of the current move is
 * scaled by how much the player actually moves compared with the coach. Always shown as an estimate.
 */
import type { Obs } from './rig';

export const REST_MET = 1.3;

/** Effective MET: resting value plus the move's extra cost scaled by measured intensity (0..1.2). */
export function effectiveMet(met: number, intensity: number): number {
  const k = Math.max(0, Math.min(1.2, intensity));
  return REST_MET + Math.max(0, met - REST_MET) * k;
}

/** kcal burned over `seconds` at a MET for a body weight. */
export function kcal(met: number, weightKg: number, seconds: number): number {
  return (met * weightKg * seconds) / 3600;
}

/**
 * Movement energy over a list of observations: mean speed (shoulder widths per second) of the wrists, plus the
 * body's vertical and sideways motion and the knees when visible.
 */
export function motionEnergy(list: Obs[], maxGap = 0.3): number {
  if (list.length < 2) return 0;
  let acc = 0;
  let time = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    const dt = b.t - a.t;
    if (dt <= 0 || dt > maxGap || !a.ok || !b.ok) continue;
    const w = Math.hypot(b.lw.x - a.lw.x, b.lw.y - a.lw.y) + Math.hypot(b.rw.x - a.rw.x, b.rw.y - a.rw.y);
    const body = Math.abs(b.duck - a.duck) * 1.5 * 2 + Math.abs(b.lean - a.lean) + Math.max(0, b.rise - a.rise) * 1.5 * 2;
    const knees = a.full && b.full ? Math.abs(b.lk.y - a.lk.y) + Math.abs(b.rk.y - a.rk.y) : 0;
    acc += w * 0.5 + body + knees * 0.5;
    time += dt;
  }
  return time > 0 ? acc / time : 0;
}

/** Player intensity relative to the coach for the same moment, 0..1.2. */
export function intensity(playerEnergy: number, coachEnergy: number): number {
  if (coachEnergy < 0.15) return playerEnergy > 0.15 ? 1 : 0.5;
  return Math.max(0, Math.min(1.2, playerEnergy / coachEnergy));
}

export interface Zone {
  zone: 1 | 2 | 3 | 4 | 5;
  name: string;
  color: string;
}

export const ZONES: Zone[] = [
  { zone: 1, name: 'Warm-up', color: '#5ad1ff' },
  { zone: 2, name: 'Fat burn', color: '#3bffb4' },
  { zone: 3, name: 'Cardio', color: '#ffd04d' },
  { zone: 4, name: 'Peak', color: '#ff8a3d' },
  { zone: 5, name: 'Max', color: '#ff2d6a' },
];

/** Heart-rate-zone style band from an effort level 0..1 (roughly the share of max heart rate above 50%). */
export function zoneFor(effort: number): Zone {
  const e = Math.max(0, Math.min(1, effort));
  return ZONES[Math.min(4, Math.floor(e * 5))];
}

/** Estimated heart rate for a 0..1 effort (50–95% of an age-predicted max, Tanaka 208 − 0.7 × age). */
export function estHeartRate(age: number, effort: number): number {
  const max = 208 - 0.7 * age;
  return Math.round(max * (0.5 + 0.45 * Math.max(0, Math.min(1, effort))));
}

/** Instant effort from a MET value and intensity: ~0.15 walking, ~0.8 jumping jacks at full effort. */
export function effortFromMet(met: number): number {
  return Math.max(0, Math.min(1, (met - REST_MET) / 8.5));
}
