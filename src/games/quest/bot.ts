/**
 * Demo bot: drives the SimPose like a real player would move (knee lifts to run, lean for lanes, hip
 * rise for hops and big jumps, shoulder drop to duck, fist thrusts toward the camera to shoot).
 * It plays well but not perfectly: it sometimes jumps late at a gap and sometimes forgets to shoot.
 */
import type { SimParams } from '../../core/pose';
import type { V2 } from '../../core/types';
import { laneX, type Lane, type LevelData } from './levels';
import type { Player } from './physics';
import type { Planner } from './plan';
import { rng } from './terrain';

export interface BotTarget {
  id: number;
  x: number;
  y: number;
  /** Path distance s. */
  s: number;
  kind: 'enemy' | 'crate' | 'block';
}

export interface BotView {
  readonly player: Player;
  readonly level: LevelData;
  readonly planner: Planner;
  /** True while the player can act (not in the countdown, paused, falling or finished). */
  active(): boolean;
  finished(): boolean;
  targets(): BotTarget[];
}

interface JumpMove {
  t0: number;
  big: boolean;
  dur: number;
  peak: number;
}

const smooth = (a: number, b: number, x: number) => {
  const k = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

export class QuestBot {
  private r: () => number;
  private jump: JumpMove | null = null;
  private delayed: { at: number; big: boolean } | null = null;
  private punch: { t0: number; hand: 0 | 1 } | null = null;
  private lastPunch = 0;
  private lean = 0;
  private duck = 0;
  private phase = 0;
  private lastT = 0;
  private falls = 0;
  private skipped = 0;
  /** Deliberate slips: miss one jump (fall, respawn) and forget to shoot one critter. */
  private slipJump = false;
  private slipShoot = false;
  private gapCount = 0;
  private slipAt = 2;
  private slipS = -1e9;
  private lastRescue = -10;
  private skip = new Set<number>();
  private shots = new Map<number, number>();
  private lane: Lane = 0;
  private lastS = 0;
  private lastReqS = 0;
  readonly maxFalls: number;

  constructor(
    private view: BotView,
    seed: number,
    private mistakes = true,
  ) {
    this.r = rng(seed);
    this.maxFalls = mistakes ? 1 : 0;
    this.slipAt = 2 + Math.floor(this.r() * 2);
  }

  /** Called after a respawn. */
  respawned(): void {
    this.jump = null;
    this.delayed = null;
    this.falls++;
  }

  private preferLane(p: Player): Lane {
    const lv = this.view.level;
    const score = [0, 0, 0];
    for (const it of lv.items) {
      if (it.s < p.s + 1.5 || it.s > p.s + 14) continue;
      const l = Math.round(it.x / 1.6);
      if (l >= -1 && l <= 1) score[l + 1] += it.kind === 'coin' ? 1 : 4;
    }
    for (const h of lv.hazards) {
      if (h.kind !== 'spikes' || h.s1 < p.s - 0.5 || h.s0 > p.s + 9) continue;
      if (h.l0 === -1 && h.l1 === 1) continue;
      for (let l = h.l0; l <= h.l1; l++) score[l + 1] -= 20;
    }
    for (const b of lv.boxes) {
      if (b.kind !== 'crate' || b.s1 < p.s || b.s0 > p.s + 7) continue;
      score[b.l0 + 1] -= 8;
    }
    // Steer clear of critters that are about to reach us (they are shot from further away).
    for (const g of this.view.targets()) {
      if (g.kind !== 'enemy' || g.s < p.s + 0.5 || g.s > p.s + 7) continue;
      const l = Math.max(-1, Math.min(1, Math.round(g.x / 1.6)));
      score[l + 1] -= 6;
    }
    score[this.lane + 1] += 1.5;
    let best: Lane = this.lane;
    for (const l of [-1, 0, 1] as Lane[]) if (score[l + 1] > score[best + 1]) best = l;
    return best;
  }

  drive(tMs: number): SimParams {
    const dt = Math.max(0, Math.min(0.3, (tMs - this.lastT) / 1000));
    this.lastT = tMs;
    const v = this.view;
    const p = v.player;
    const t = tMs / 1000;
    if (!v.active()) {
      const cheer = v.finished();
      const wave = Math.sin(t * 8) * 0.15;
      this.lean *= 0.9;
      return cheer
        ? { lWrist: { x: -0.9, y: 0.2 + wave }, rWrist: { x: 0.9, y: 0.2 - wave }, lean: this.lean }
        : { lWrist: { x: -0.6, y: -1.4 }, rWrist: { x: 0.6, y: -1.4 }, lean: this.lean };
    }
    if (p.s < this.lastS - 3) {
      // Respawned at a checkpoint.
      this.jump = null;
      this.delayed = null;
      this.lastReqS = 0;
    }
    this.lastS = p.s;

    // Run on the spot: alternate knee lifts (held briefly at the top so slow camera rates still see them).
    this.phase += dt * Math.PI * 2 * 1.55;
    const k = Math.sin(this.phase);
    const lKnee = smooth(0.1, 0.55, k) * 0.66;
    const rKnee = smooth(0.1, 0.55, -k) * 0.66;

    // Lanes.
    this.lane = v.planner.lane(p, this.preferLane(p));
    const wantLean = this.lane * 0.8;
    this.lean += (wantLean - this.lean) * Math.min(1, dt * 10);

    // Jumps: start the body jump a touch early to cover detection delay.
    if (!this.jump && !this.delayed) {
      const req = v.planner.jumpNow(p, p.vs * 0.1 + 0.15);
      if (req) {
        const big = req.kind === 'big';
        this.lastReqS = req.s;
        const eligible = req.why === 'gap' && !big && p.s > 150;
        if (eligible) this.gapCount++;
        const late = this.mistakes && eligible && !this.slipJump && this.gapCount === this.slipAt;
        if (late) {
          this.slipJump = true;
          this.slipS = req.s;
        }
        // A "mistake": miss the jump completely and fall (a late hop would be saved by the double jump).
        if (late) this.delayed = { at: Infinity, big };
        else this.jump = { t0: t, big, dur: big ? 0.66 : 0.5, peak: big ? 0.44 : 0.18 };
      }
    }
    if (this.delayed && p.s > this.lastReqS + 3) this.delayed = null;
    // Dropping off an edge we missed: hop anyway, the game turns it into a rescue double jump.
    if (!this.jump && !p.grounded && !p.jumping && p.vy < -1.5 && t - this.lastRescue > 1 && Math.abs(p.s - this.slipS) > 6 && !v.planner.groundBelow(p.s, p.x, p.y, 3)) {
      this.lastRescue = t;
      this.jump = { t0: t, big: true, dur: 0.66, peak: 0.44 };
    }
    let rise = 0;
    if (this.jump) {
      // Quick rise, a held top (so even a slow camera sees it), quick landing.
      const x = (t - this.jump.t0) / this.jump.dur;
      if (x >= 1) this.jump = null;
      else rise = this.jump.peak * (x < 0.22 ? Math.sin((x / 0.22) * Math.PI * 0.5) : x > 0.78 ? Math.sin(((1 - x) / 0.22) * Math.PI * 0.5) : 1);
    }

    // Duck under logs.
    const wantDuck = v.planner.duck(p.s) || v.planner.duck(p.s + p.vs * 0.25) ? 0.5 : 0;
    this.duck += (wantDuck - this.duck) * Math.min(1, dt * 12);

    // Shoot whatever is ahead in (or near) our lane.
    if (!this.punch && !this.jump && t - this.lastPunch > 0.42) {
      let best: BotTarget | null = null;
      for (const g of v.targets()) {
        const ahead = g.s - p.s;
        // Crates right in front (we bumped into one) are always fair game.
        const blocking = g.kind === 'crate' && ahead < 3 && Math.abs(g.x - p.x) < 0.9;
        if (!blocking && (ahead < 3 || ahead > 20 || Math.abs(g.x - laneX(this.lane)) > 2.0)) continue;
        if (this.skip.has(g.id)) continue;
        if (!blocking && (this.shots.get(g.id) ?? 0) >= 3) continue;
        if (g.kind === 'enemy' && this.mistakes && !this.slipShoot && !this.shots.has(g.id) && p.s > 250) {
          this.skip.add(g.id);
          this.slipShoot = true;
          this.skipped++;
          continue;
        }
        if (!best || ahead < best.s - p.s) best = g;
      }
      if (best) {
        const hand: 0 | 1 = best.x < p.x - 0.3 ? 0 : best.x > p.x + 0.3 ? 1 : this.shots.size % 2 ? 0 : 1;
        this.punch = { t0: t, hand };
        this.lastPunch = t;
        this.shots.set(best.id, (this.shots.get(best.id) ?? 0) + 1);
      }
    }

    // Arms: pumping while running; one fist thrusts toward the camera to shoot.
    const pump = Math.sin(this.phase) * 0.2;
    let lWrist: V2 = { x: -0.55, y: -0.72 + pump };
    let rWrist: V2 = { x: 0.55, y: -0.72 - pump };
    let lZ = 0;
    let rZ = 0;
    if (this.punch) {
      const x = (t - this.punch.t0) / 0.38;
      if (x >= 1) this.punch = null;
      else if (x < 0.55) {
        if (this.punch.hand === 0) {
          lWrist = { x: -0.3, y: 0.15 };
          lZ = -1.9;
        } else {
          rWrist = { x: 0.3, y: 0.15 };
          rZ = -1.9;
        }
      }
    }
    return { lWrist, rWrist, lWristZ: lZ, rWristZ: rZ, lean: this.lean, duck: this.duck, rise, lKneeUp: lKnee, rKneeUp: rKnee };
  }
}
