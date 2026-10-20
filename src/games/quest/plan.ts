/**
 * Route planning shared by the demo bot and the layout tests (pure): which lane to be in and when to jump.
 */
import { LANE_W, type JumpReq, type Lane, type LevelData } from './levels';
import type { Player } from './physics';

const clampLane = (l: number, a: number, z: number) => Math.max(a, Math.min(z, l)) as Lane;
const laneXOf = (l: number) => l * LANE_W;

export function lanesOfSolid(x0: number, x1: number): [Lane, Lane] {
  return [Math.round((x0 + LANE_W / 2) / LANE_W) as Lane, Math.round((x1 - LANE_W / 2) / LANE_W) as Lane];
}

export class Planner {
  private i = 0;
  /** The jump being flown (for its landing lanes). */
  active: JumpReq | null = null;

  constructor(readonly level: LevelData) {}

  /** Next requirement whose take-off point is still ahead (or just behind) of s. Never goes back (see reset). */
  next(s: number): JumpReq | undefined {
    const j = this.level.jumps;
    while (this.i < j.length && j[this.i].s < s - 0.6) this.i++;
    return j[this.i];
  }

  /** After a respawn. */
  reset(s: number): void {
    this.i = 0;
    this.active = null;
    this.next(s);
  }

  /** How far before the edge to start the jump (m). */
  static lead(r: JumpReq): number {
    if (r.why === 'spikes') return 0.55;
    if (r.why === 'step') return r.kind === 'big' ? 1.1 : 0.9;
    return 0.35;
  }

  /** Should the player jump now? Returns the kind (and marks it active) or null. */
  jumpNow(p: Player, extraLead = 0): JumpReq | null {
    if (!p.grounded) return null;
    const r = this.next(p.s);
    if (!r || r.kind === 'spring') return null;
    if (p.s >= r.s - Planner.lead(r) - extraLead && p.s < r.s + 1.0) {
      this.active = r;
      this.i++;
      return r;
    }
    return null;
  }

  /** Lane to steer to. `prefer` is the lane the bot would like (coins, avoiding enemies). */
  lane(p: Player, prefer: Lane): Lane {
    if (!p.grounded) {
      const a = this.active;
      return a && p.s < a.land1 ? clampLane(prefer, a.lanes[0], a.lanes[1]) : prefer;
    }
    const g = p.ground;
    if (!g) return prefer;
    const [gl0, gl1] = lanesOfSolid(g.x0, g.x1);
    let l = clampLane(prefer, gl0, gl1);
    const r = this.next(p.s);
    // Walk-on neighbours (no jump) also constrain the lane: e.g. a narrow bridge after a wide island.
    const walkOn = this.level.boxes.find((b) => !b.shoulder && b.kind !== 'mystery' && b.kind !== 'crate' && Math.abs(b.s0 - g.s1) < 0.05 && Math.abs(b.top - g.top) < 0.35);
    const nextLanes: [number, number] | null =
      r && r.s <= g.s1 + 0.6 && r.kind !== 'spring' ? r.lanes : walkOn && p.s > g.s1 - 10 ? [walkOn.l0, walkOn.l1] : null;
    if (nextLanes) {
      const o0 = Math.max(gl0, nextLanes[0]);
      const o1 = Math.min(gl1, nextLanes[1]);
      if (o0 <= o1) l = clampLane(l, o0, o1);
      else l = clampLane(nextLanes[0] > gl1 ? gl1 : gl0, gl0, gl1); // diagonal hop: wait at the nearest edge, lean at take-off
    }
    return l;
  }

  /** Is there a platform under (s, x) within `depth` metres below y? */
  groundBelow(s: number, x: number, y: number, depth: number): boolean {
    return this.level.boxes.some(
      (b) => b.kind !== 'mystery' && s >= b.s0 - 0.3 && s <= b.s1 + 0.3 && x >= laneXOf(b.l0) - 1.1 && x <= laneXOf(b.l1) + 1.1 && b.top <= y + 0.1 && b.top >= y - depth - (b.mover ? b.mover.amp : 0),
    );
  }

  /** Inside a duck zone (start ducking a little early). */
  duck(s: number): boolean {
    return this.level.ducks.some((d) => s > d.s0 - 1.6 && s < d.s1 + 0.4);
  }
}
