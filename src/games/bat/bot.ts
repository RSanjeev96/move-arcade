/**
 * Demo bot: drives the simulated pose with both wrists sweeping across the body, timed to the ball.
 * It makes human mistakes on purpose (early, late, wrong height, leaving straight balls) so every outcome shows up.
 */
import type { SimParams } from '../../core/pose';
import type { V2 } from '../../core/types';
import { gripForHeight } from './contact';
import type { Delivery } from './delivery';
import type { Rng } from './rng';

interface Plan {
  /** Real time (ms) of peak hand speed. */
  T: number;
  /** Body-space grip height to pass through at the peak. */
  y: number;
  /** Time constant of the sweep (s): smaller = faster swing. */
  tau: number;
  /** Where the bottom of the arc sits (0.5 = level swing, < 0.5 = swinging up). */
  sb: number;
  swing: boolean;
}

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export class Bot {
  private plan: Plan | null = null;
  /** Right-handed sweep goes from the player's right (+x) to their left. */
  constructor(
    private handed: 1 | -1,
    private sport: 'cricket' | 'baseball',
  ) {}

  private stance(): V2 {
    const h = this.handed;
    return this.sport === 'cricket' ? { x: 0.38 * h, y: -1.25 } : { x: 0.6 * h, y: -0.15 };
  }

  private loaded(): V2 {
    const h = this.handed;
    return this.sport === 'cricket' ? { x: 1.0 * h, y: 0.05 } : { x: 0.95 * h, y: 0.12 };
  }

  /** Decide what to do with this ball. arrivalMs = real time the ball reaches the bat. */
  decide(d: Delivery, arrivalMs: number, rng: Rng, mode: string, outs = 0): { swing: boolean; errMs: number } {
    let swing = true;
    if (this.sport === 'cricket') {
      const wide = Math.abs(d.arrive.p.x) > 0.32;
      if (mode !== 'sixes' && !d.onTarget && wide && rng.chance(0.55)) swing = false;
      if (mode !== 'sixes' && d.onTarget && rng.chance(0.04)) swing = false; // shoulder arms… and lose the off stump
    } else {
      const strike = d.onTarget;
      if (!strike && rng.chance(mode === 'derby' ? 0.8 : 0.68)) swing = false;
      if (strike && rng.chance(0.08)) swing = false;
      void outs;
    }
    let err = rng.gauss(0, mode === 'sixes' || mode === 'derby' ? 55 : this.sport === 'baseball' ? 50 : 38);
    const r = rng.next();
    if (r < 0.06) err = -rng.range(150, 300);
    else if (r < 0.12) err = rng.range(140, 290);
    else if (r < 0.22) err = rng.gauss(0, 90);
    let h = d.arrive.p.y + rng.gauss(0, 0.09);
    if (rng.chance(0.08)) h += rng.chance(0.5) ? 0.35 : -0.3;
    // In a chase it often tries to keep the ball down and pierce the field.
    if (mode === 'chase' && rng.chance(0.3)) h += rng.range(0.16, 0.3);
    // In six-hitting the bot tries to get under it and swing up.
    const lofted = mode === 'sixes' || mode === 'derby';
    const sb = lofted ? rng.range(0.38, 0.46) : rng.range(0.45, 0.56);
    if (lofted) h -= 0.05;
    const power = rng.range(0.65, 1);
    this.plan = { T: arrivalMs + err, y: gripForHeight(h), tau: 0.028 + (1 - power) * 0.02, sb, swing };
    return { swing, errMs: err };
  }

  clear(): void {
    this.plan = null;
  }

  /** Simulated pose at real time tMs. */
  drive(tMs: number): SimParams {
    const st = this.stance();
    let g: V2 = { x: st.x + Math.sin(tMs / 700) * 0.03, y: st.y + Math.sin(tMs / 530) * 0.02 };
    const p = this.plan;
    if (p && p.swing) {
      const dt = (tMs - p.T) / 1000;
      const A = this.loaded();
      const C = { x: -1.05 * this.handed, y: p.y + (this.sport === 'cricket' ? 1.05 : 0.7) };
      if (dt < -0.6) {
        // stance
      } else if (dt < -0.2) {
        const k = ease((dt + 0.6) / 0.35);
        g = { x: g.x + (A.x - g.x) * k, y: g.y + (A.y - g.y) * k };
      } else if (dt < 1.6) {
        const s = 1 / (1 + Math.exp(-dt / p.tau));
        const s0 = 1 / (1 + Math.exp(0.2 / p.tau));
        const u = (s - s0) / (1 - s0);
        const sb = p.sb;
        const w = sb < 0.5 ? ((0.5 - sb) / (1 - sb)) ** 2 : ((sb - 0.5) / sb) ** 2;
        const yb = sb < 0.5 ? (p.y - C.y * w) / (1 - w) : (p.y - A.y * w) / (1 - w);
        const y = u < sb ? yb + (A.y - yb) * ((sb - u) / sb) ** 2 : yb + (C.y - yb) * ((u - sb) / (1 - sb)) ** 2;
        g = { x: A.x + (C.x - A.x) * u, y };
        if (dt > 0.5) {
          // Unhurried return to the stance (slow enough not to read as another swing).
          const k = ease((dt - 0.5) / 1.05);
          g = { x: g.x + (st.x - g.x) * k, y: g.y + (st.y - g.y) * k };
        }
      }
    }
    const off = 0.075;
    return {
      lWrist: { x: g.x - off, y: g.y + 0.05 },
      rWrist: { x: g.x + off, y: g.y - 0.05 },
    };
  }
}
