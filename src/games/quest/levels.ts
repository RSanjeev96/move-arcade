/**
 * Sky Quest levels: data + a small builder DSL. Pure (no three.js) so layouts can be unit tested.
 * Path space: s = metres forward, lanes at x = -1.6 / 0 / +1.6, y = up (ground of the start island is 0).
 */
import type { BoxKind } from './physics';

export type Lane = -1 | 0 | 1;
export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];
export const LANE_W = 1.6;
export const laneX = (l: number) => l * LANE_W;

export type JumpKind = 'hop' | 'big' | 'spring';
export type PowerKind = 'triple' | 'shield' | 'magnet';
export type Contents = 'coins' | 'heart' | 'gem' | PowerKind;
export type EnemyKind = 'blob' | 'pink' | 'spiky' | 'bee' | 'glub';
export type HazardKind = 'spikes' | 'log';
export type PromptIcon = 'run' | 'lean' | 'hop' | 'big' | 'punch' | 'duck' | 'block' | 'spring' | 'stomp';
export type ThemeId = 'meadow' | 'falls' | 'sunset';

export interface BoxDef {
  s0: number;
  s1: number;
  l0: Lane;
  l1: Lane;
  top: number;
  depth: number;
  kind: BoxKind;
  /** Vertical movers rise `amp` above `top` and back every `period` seconds. */
  mover?: { amp: number; period: number; phase: number };
  contents?: Contents;
  /** Gets decorative island terraces beside the path (no gameplay). */
  shoulder?: boolean;
}

export interface ItemDef {
  kind: 'coin' | 'gem' | 'heart' | 'power';
  s: number;
  x: number;
  y: number;
  power?: PowerKind;
}

export interface EnemyDef {
  kind: EnemyKind;
  s: number;
  lane: Lane;
  /** Ground top (walkers) or hover height (flyers). */
  y: number;
  /** Sweeps sideways across this many lanes (0 = stays in its lane). */
  sweep: number;
  period: number;
  phase: number;
}

export interface HazardDef {
  kind: HazardKind;
  s0: number;
  s1: number;
  l0: Lane;
  l1: Lane;
  /** Ground top under the hazard. */
  y: number;
}

export interface SpringDef {
  s: number;
  lane: Lane;
  y: number;
}

export interface PromptDef {
  s0: number;
  s1: number;
  text: string;
  icon: PromptIcon;
}

/** Something the player must jump at: used by the bot and by layout tests. */
export interface JumpReq {
  /** Edge (or obstacle start) to jump at. */
  s: number;
  kind: JumpKind;
  why: 'gap' | 'step' | 'spikes' | 'wall';
  fromTop: number;
  toTop: number;
  /** Landing zone along s. */
  land0: number;
  land1: number;
  /** Lanes the landing zone covers. */
  lanes: [Lane, Lane];
}

export interface LevelData {
  id: number;
  name: string;
  tagline: string;
  theme: ThemeId;
  difficulty: Difficulty;
  boxes: BoxDef[];
  items: ItemDef[];
  enemies: EnemyDef[];
  hazards: HazardDef[];
  springs: SpringDef[];
  checkpoints: { s: number; y: number }[];
  prompts: PromptDef[];
  jumps: JumpReq[];
  ducks: { s0: number; s1: number }[];
  /** End gate. */
  goal: { s: number; y: number };
  length: number;
  par: number;
  coinTotal: number;
  gemTotal: number;
}

export interface DiffProfile {
  autoRun: boolean;
  /** Auto-run speed (also used when the legs are out of view). */
  autoSpeed: number;
  maxSpeed: number;
  enemySpeed: number;
  coyote: number;
  airMin: number;
  buffer: number;
  invuln: number;
  /** Hearts never drop below one. */
  noGameOver: boolean;
  gapScale: number;
}

export const PROFILES: Record<Difficulty, DiffProfile> = {
  easy: { autoRun: true, autoSpeed: 4.8, maxSpeed: 5.6, enemySpeed: 0.6, coyote: 0.3, airMin: 4.6, buffer: 0.3, invuln: 2.2, noGameOver: true, gapScale: 0.85 },
  normal: { autoRun: false, autoSpeed: 5.2, maxSpeed: 6.6, enemySpeed: 1, coyote: 0.22, airMin: 4.8, buffer: 0.25, invuln: 1.6, noGameOver: false, gapScale: 1 },
  hard: { autoRun: false, autoSpeed: 5.8, maxSpeed: 7.4, enemySpeed: 1.4, coyote: 0.17, airMin: 5.0, buffer: 0.22, invuln: 1.3, noGameOver: false, gapScale: 1.04 },
};

const BLOCK_H = 1.6;
/** Coins popped by one mystery block or crate. */
export const BLOCK_COINS = 5;
/** Crumbling ground is made of tiles that fall one by one. */
export const CRUMBLE_TILE = 1.6;

/** Helper bound to one platform: offsets are metres from the platform start, heights from its top. */
export class Plat {
  constructor(
    readonly b: LevelBuilder,
    readonly s0: number,
    readonly s1: number,
    readonly top: number,
    readonly lanes: [Lane, Lane],
  ) {}

  coins(a: number, z: number, lane: number, n?: number, h = 1.0): this {
    const count = n ?? Math.max(2, Math.round((z - a) / 1.6) + 1);
    for (let i = 0; i < count; i++) {
      const s = this.s0 + a + ((z - a) * i) / Math.max(1, count - 1);
      this.b.items.push({ kind: 'coin', s, x: laneX(lane), y: this.top + h });
    }
    return this;
  }

  /** Coins in an arc over a hazard on this platform (from a to z). */
  arcCoins(a: number, z: number, lane: number): this {
    const n = 4;
    for (let i = 0; i < n; i++) {
      const k = (i + 0.5) / n;
      this.b.items.push({ kind: 'coin', s: this.s0 + a + (z - a) * k, x: laneX(lane), y: this.top + 1.0 + 4 * k * (1 - k) });
    }
    return this;
  }

  /** Coins weaving from lane a to lane z. */
  weave(a: number, z: number, la: number, lz: number, n = 6): this {
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1);
      const e = k * k * (3 - 2 * k);
      this.b.items.push({ kind: 'coin', s: this.s0 + a + (z - a) * k, x: laneX(la + (lz - la) * e), y: this.top + 1.0 });
    }
    return this;
  }

  /** Ring of coins at head height (a little bonus). */
  ring(at: number, lane: number, h = 1.6): this {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      this.b.items.push({ kind: 'coin', s: this.s0 + at, x: laneX(lane) + Math.cos(a) * 0.55, y: this.top + h + Math.sin(a) * 0.55 });
    }
    return this;
  }

  enemy(kind: EnemyKind, at: number, lane: Lane, sweep = 0, period = 4, phase = 0, hardOnly = false): this {
    if (hardOnly && this.b.diff !== 'hard') return this;
    const fly = kind === 'bee' || kind === 'glub';
    this.b.enemies.push({ kind, s: this.s0 + at, lane, y: this.top + (fly ? 1.55 : 0), sweep, period, phase });
    return this;
  }

  spikes(at: number, len: number, l0: Lane = -1, l1: Lane = 1): this {
    const [a, z] = this.b.widen([l0, l1]);
    const full = a === -1 && z === 1;
    this.b.hazards.push({ kind: 'spikes', s0: this.s0 + at, s1: this.s0 + at + len, l0: full ? -1 : l0, l1: full ? 1 : l1, y: this.top });
    if (l0 === -1 && l1 === 1) {
      this.b.jumps.push({ s: this.s0 + at, kind: 'hop', why: 'spikes', fromTop: this.top, toTop: this.top, land0: this.s0 + at + len, land1: this.s1, lanes: this.lanes });
    }
    return this;
  }

  log(at: number): this {
    this.b.hazards.push({ kind: 'log', s0: this.s0 + at - 0.3, s1: this.s0 + at + 0.3, l0: -1, l1: 1, y: this.top });
    this.b.ducks.push({ s0: this.s0 + at - 0.3, s1: this.s0 + at + 0.3 });
    return this;
  }

  crate(at: number, lane: Lane, contents: Contents = 'coins'): this {
    this.b.boxes.push({ s0: this.s0 + at - 0.4, s1: this.s0 + at + 0.4, l0: lane, l1: lane, top: this.top + 0.8, depth: 0.8, kind: 'crate', contents });
    return this;
  }

  /** A floating mystery block, bottom `h` above the ground. Hop into it from below, or shoot it. */
  mystery(at: number, lane: Lane, contents: Contents = 'coins', h = 2.45): this {
    this.b.boxes.push({ s0: this.s0 + at - 0.5, s1: this.s0 + at + 0.5, l0: lane, l1: lane, top: this.top + h + 1, depth: 1, kind: 'mystery', contents });
    return this;
  }

  /** Bounce pads across every lane of the platform (a wall too tall to jump usually follows). */
  spring(at: number): this {
    for (let l = this.lanes[0]; l <= this.lanes[1]; l++) this.b.springs.push({ s: this.s0 + at, lane: l as Lane, y: this.top });
    return this;
  }

  checkpoint(at: number): this {
    this.b.checkpoints.push({ s: this.s0 + at, y: this.top });
    return this;
  }

  prompt(at: number, text: string, icon: PromptIcon, len = 12): this {
    this.b.prompts.push({ s0: this.s0 + at, s1: this.s0 + at + len, text, icon });
    return this;
  }

  gem(at: number, lane: number, h = 1.2): this {
    this.b.items.push({ kind: 'gem', s: this.s0 + at, x: laneX(lane), y: this.top + h });
    return this;
  }

  heart(at: number, lane: number, h = 1.1): this {
    this.b.items.push({ kind: 'heart', s: this.s0 + at, x: laneX(lane), y: this.top + h });
    return this;
  }

  power(at: number, lane: number, kind: PowerKind, h = 1.2): this {
    this.b.items.push({ kind: 'power', s: this.s0 + at, x: laneX(lane), y: this.top + h, power: kind });
    return this;
  }

  goal(at: number): this {
    this.b.goal = { s: this.s0 + at, y: this.top };
    return this;
  }
}

interface PendingGap {
  s: number;
  kind: JumpKind;
  fromTop: number;
  arcLane: number | null;
}

export class LevelBuilder {
  s = 0;
  top = 0;
  boxes: BoxDef[] = [];
  items: ItemDef[] = [];
  enemies: EnemyDef[] = [];
  hazards: HazardDef[] = [];
  springs: SpringDef[] = [];
  checkpoints: { s: number; y: number }[] = [];
  prompts: PromptDef[] = [];
  jumps: JumpReq[] = [];
  ducks: { s0: number; s1: number }[] = [];
  goal = { s: 0, y: 0 };
  private pending: PendingGap | null = null;
  private lastLanes: [Lane, Lane] = [-1, 1];
  readonly prof: DiffProfile;

  constructor(readonly diff: Difficulty) {
    this.prof = PROFILES[diff];
  }

  widen(l: [Lane, Lane]): [Lane, Lane] {
    return this.diff === 'easy' ? [-1, 1] : l;
  }

  /**
   * A platform from the cursor. `top` defaults to the current height; a rise without a gap is a step
   * (hop for one block, big jump for two). `fill` places things on it.
   */
  ground(
    len: number,
    o: { top?: number; lanes?: [Lane, Lane]; kind?: BoxKind; depth?: number; mover?: BoxDef['mover']; shoulders?: boolean } = {},
    fill?: (p: Plat) => void,
  ): this {
    const top = o.top ?? this.top;
    const lanes = this.widen(o.lanes ?? [-1, 1]);
    const kind = o.kind ?? 'grass';
    const s0 = this.s;
    const s1 = s0 + len;
    const depth = o.depth ?? (kind === 'wood' ? 0.4 : kind === 'cloud' ? 0.8 : kind === 'mover' || kind === 'crumble' ? 0.6 : BLOCK_H);
    if (kind === 'crumble') {
      const n = Math.max(1, Math.round(len / CRUMBLE_TILE));
      for (let i = 0; i < n; i++) this.boxes.push({ s0: s0 + (len * i) / n, s1: s0 + (len * (i + 1)) / n, l0: lanes[0], l1: lanes[1], top, depth, kind });
    } else {
      // Wide islands get lower decorative terraces either side (outside the lanes, no gameplay).
      const shoulder = o.shoulders !== false && (kind === 'grass' || kind === 'stone' || kind === 'castle') && len >= 9 && lanes[0] === -1 && lanes[1] === 1;
      this.boxes.push({ s0, s1, l0: lanes[0], l1: lanes[1], top, depth, kind, mover: o.mover, shoulder });
    }
    const p = this.pending;
    if (p) {
      this.jumps.push({ s: p.s, kind: p.kind, why: 'gap', fromTop: p.fromTop, toTop: top, land0: s0, land1: s1, lanes });
      if (p.arcLane !== null && p.kind !== 'spring') this.arc(p, s0, top);
      this.pending = null;
    } else if (top > this.top + 0.35 && this.boxes.length > 1) {
      const dy = top - this.top;
      this.jumps.push({ s: s0, kind: dy > 3 ? 'spring' : dy > 0.9 ? 'big' : 'hop', why: dy > 3 ? 'wall' : 'step', fromTop: this.top, toTop: top, land0: s0, land1: s1, lanes });
    }
    this.top = top;
    this.lastLanes = lanes;
    this.s = s1;
    fill?.(new Plat(this, s0, s1, top, lanes));
    return this;
  }

  /** Empty air. `kind` is the jump needed; `arc` puts a coin trail along the jump (lane or null). */
  gap(len: number, kind: JumpKind, arc: number | null = 0): this {
    this.pending = { s: this.s, kind, fromTop: this.top, arcLane: arc };
    this.s += len * this.prof.gapScale;
    return this;
  }

  /** Coin trail along the jump arc from the edge: shows the player how the jump flies. */
  private arc(p: PendingGap, landS: number, landTop: number): void {
    const lane = p.arcLane ?? 0;
    const v = this.prof.airMin + 0.6;
    const apex = p.kind === 'big' ? 2.8 : 1.2;
    const g = 24;
    const take = p.s - 0.4;
    const v0 = Math.sqrt(2 * g * apex);
    const n = p.kind === 'big' ? 7 : 5;
    const span = Math.max(1, landS + 0.8 - take);
    for (let i = 1; i <= n; i++) {
      const s = take + (span * i) / (n + 1);
      const t = (s - take) / v;
      const y = p.fromTop + v0 * t - 0.5 * g * t * t;
      if (y < Math.min(p.fromTop, landTop) + 0.4) continue;
      this.items.push({ kind: 'coin', s, x: laneX(lane), y: y + 1.0 });
    }
  }

  /** Lanes of the previous platform (for placing things that need ground). */
  get lanes(): [Lane, Lane] {
    return this.lastLanes;
  }

  build(id: number, name: string, tagline: string, theme: ThemeId): LevelData {
    if (!this.goal.s) this.goal = { s: this.s - 8, y: this.top };
    const coinTotal =
      this.items.filter((i) => i.kind === 'coin').length +
      this.boxes.filter((b) => b.contents === 'coins').length * BLOCK_COINS;
    const length = this.goal.s;
    const p = this.prof;
    const nominal = p.autoRun ? p.autoSpeed : p.maxSpeed * 0.82;
    return {
      id,
      name,
      tagline,
      theme,
      difficulty: this.diff,
      boxes: this.boxes.sort((a, b) => a.s0 - b.s0),
      items: this.items,
      enemies: this.enemies.sort((a, b) => a.s - b.s),
      hazards: this.hazards,
      springs: this.springs,
      checkpoints: this.checkpoints.sort((a, b) => a.s - b.s),
      prompts: this.prompts,
      jumps: this.jumps.sort((a, b) => a.s - b.s),
      ducks: this.ducks,
      goal: this.goal,
      length,
      par: Math.round(length / nominal + 14),
      coinTotal,
      gemTotal: this.items.filter((i) => i.kind === 'gem').length,
    };
  }
}


// ---- level 1: Meadow Isles --------------------------------------------------------------------------

function meadow(d: Difficulty): LevelData {
  const b = new LevelBuilder(d);
  // A: run, lean, first hops, first block and first critter.
  b.ground(34, {}, (p) => p.prompt(1, 'Run on the spot!', 'run', 16).coins(14, 32, 0, 7))
    .ground(28, {}, (p) => p.prompt(0, 'Lean left and right', 'lean', 16).weave(2, 12, 0, -1, 5).weave(14, 26, -1, 1, 6))
    .ground(18, {}, (p) => p.prompt(4, 'Hop over the gap!', 'hop', 14).coins(2, 9, 1, 3))
    .gap(1.8, 'hop', 0)
    .ground(14, {}, (p) => p.coins(5, 12, 0, 3))
    .gap(2.0, 'hop', 0)
    .ground(14, {}, (p) => p.prompt(2, 'Hop up the step!', 'hop', 11).coins(3, 8, -1, 3))
    .ground(18, { top: 0.8 }, (p) => p.prompt(3, 'Hop into the star block!', 'block', 10).mystery(11, 0, 'coins').coins(14, 17, 1, 2))
    .ground(20, { top: 0.8 }, (p) => p.prompt(0, 'Punch to shoot!', 'punch', 13).enemy('blob', 15, 0).coins(17, 19, -1, 2).coins(17, 19, 1, 2))
    // B: big jumps, ducking, stepping stones.
    .ground(22, { top: 0.8 }, (p) => p.checkpoint(4).enemy('pink', 15, 1, 1, 5).coins(8, 18, -1, 5).heart(20, 0))
    .ground(12, { top: 0.8 }, (p) => p.prompt(-1, 'Big jump over the wide gap!', 'big', 13).coins(2, 9, 0, 3))
    .gap(3.6, 'big', 0)
    .ground(16, { top: 0.8 }, (p) => p.coins(4, 12, 0, 4).gem(14, 1, 1.0).prompt(2, 'Big jump up!', 'big', 12))
    .ground(14, { top: 2.4 }, (p) => p.coins(3, 12, 0, 4))
    .ground(24, { top: 2.4 }, (p) => p.prompt(0, 'Duck!', 'duck', 10).log(11).coins(10, 12, 0, 2, 0.5).enemy('blob', 20, -1, 2, 6))
    .gap(1.8, 'hop', -1)
    .ground(10, { top: 2.4, lanes: [-1, 0] }, (p) => p.coins(2, 8, -1, 3))
    .gap(1.8, 'hop', 0)
    .ground(10, { top: 2.4, lanes: [0, 1] }, (p) => p.coins(2, 8, 1, 3))
    .gap(1.8, 'hop', 0)
    // C: spikes, crates, a bridge, flyers and the spring up to the high meadow.
    .ground(28, { top: 2.4 }, (p) =>
      p.checkpoint(3).prompt(5, 'Hop over the spikes!', 'hop', 9).spikes(14, 1.6).arcCoins(13.2, 16.2, 0).prompt(18, 'Shoot the crates!', 'punch', 6).crate(24, -1).crate(24, 1, 'heart'),
    )
    .ground(12, { top: 2.4, kind: 'wood', lanes: [0, 0] }, (p) => p.coins(1, 11, 0, 6))
    .ground(20, { top: 2.4 }, (p) => p.prompt(0, 'Shoot the flyers!', 'punch', 12).enemy('bee', 12, -1, 2, 5).enemy('bee', 17, 1, 0, 4, 0.5))
    .ground(16, { top: 2.4 }, (p) => p.prompt(2, 'Bounce on the spring!', 'spring', 11).spring(13.6).coins(5, 10, 0, 3))
    .ground(12, { top: 6.4, depth: 4 }, (p) => p.coins(2, 9, 0, 4).ring(6, 0, 1.6))
    .ground(18, { top: 6.4 }, (p) => p.mystery(6, -1, 'shield').mystery(6, 1, 'coins').coins(10, 15, 0, 3))
    .gap(2.2, 'hop', 0)
    // D: windy meadow.
    .ground(26, { top: 5.6 }, (p) => p.checkpoint(3).enemy('blob', 12, 0, 1, 4).enemy('bee', 19, 1, 2, 5).weave(6, 22, -1, 1, 8))
    .gap(2.0, 'hop', 0)
    .ground(18, { top: 5.6 }, (p) => p.spikes(5, 1.6, 1, 1).crate(7, 0).coins(3, 9, -1, 4).enemy('pink', 14, 0, 2, 4))
    .gap(1.8, 'hop', 1)
    .ground(8, { top: 5.6, lanes: [0, 1] }, (p) => p.coins(2, 6, 1, 2))
    .gap(1.8, 'hop', 0)
    .ground(8, { top: 5.6, lanes: [-1, 0] }, (p) => p.coins(2, 6, 0, 2))
    .gap(1.8, 'hop', -1)
    .ground(8, { top: 5.6, lanes: [-1, -1] }, (p) => p.coins(2, 6, -1, 2).gem(5, -1, 2.2))
    .gap(3.4, 'big', 0)
    .ground(22, { top: 5.6 }, (p) => p.checkpoint(2).log(9).enemy('pink', 16, 0, 2, 4).coins(13, 20, 1, 4))
    .ground(18, { top: 6.4 }, (p) => p.enemy('bee', 9, 0, 2, 4).coins(2, 16, 0, 6).gem(16, 0, 2.6))
    .ground(16, { top: 6.4 }, (p) => p.mystery(8, 0, 'coins').enemy('blob', 13, -1).enemy('blob', 13, 1, 0, 4, 0, true).coins(3, 6, 0, 2))
    .ground(14, { top: 7.2 }, (p) => p.coins(2, 12, 0, 5))
    .ground(40, { top: 7.2 }, (p) => p.goal(26).coins(2, 22, 0, 9));
  return b.build(1, 'Meadow Isles', 'Learn the moves on sunny floating islands', 'meadow');
}

// ---- level 2: Waterfall Cliffs ---------------------------------------------------------------------

function falls(d: Difficulty): LevelData {
  const b = new LevelBuilder(d);
  // A: stepping stones and a bobbing lift.
  b.ground(30, {}, (p) => p.prompt(2, 'Run on the spot!', 'run', 10).coins(10, 28, 0, 7))
    .ground(18, {}, (p) => p.enemy('blob', 10, -1, 2, 5).coins(4, 14, 1, 4))
    .gap(2.0, 'hop', 0)
    .ground(10, { lanes: [-1, 0] }, (p) => p.coins(2, 8, -1, 3))
    .gap(2.0, 'hop', 0)
    .ground(10, { lanes: [0, 1] }, (p) => p.coins(2, 8, 1, 3))
    .gap(2.0, 'hop', 0)
    .ground(22, {}, (p) => p.mystery(6, 0, 'coins').crate(12, -1).enemy('pink', 15, 1, 1, 4).coins(16, 20, 0, 3))
    .ground(12, { top: 0.8 }, (p) => p.coins(2, 10, 0, 4))
    .ground(16, { top: 2.4 }, (p) => p.prompt(-12, "Spiky ones: shoot, don't stomp!", 'punch', 14).enemy('spiky', 9, 0).coins(3, 14, -1, 5))
    .gap(3.4, 'big', 0)
    .ground(6, { top: 2.4, kind: 'mover', mover: { amp: 0.8, period: 3.2, phase: 0 } }, (p) => p.coins(1, 5, 0, 3, 1.4))
    .gap(3.0, 'big', 0)
    // B: crumbling ledge, logs and spikes, a spring.
    .ground(22, { top: 2.4 }, (p) => p.checkpoint(4).enemy('bee', 14, -1, 2, 5).enemy('bee', 18, 1, 2, 5, 0.5).coins(6, 20, 0, 7))
    .ground(14, { top: 2.4, kind: 'crumble' }, (p) => p.prompt(-8, 'Keep moving: it crumbles!', 'run', 10).coins(1, 13, 0, 6))
    .gap(2.0, 'hop', 0)
    .ground(22, { top: 2.4 }, (p) => p.log(7).spikes(13, 1.8).arcCoins(12.2, 15.6, 0).power(19, 0, 'triple'))
    .ground(18, { top: 2.4 }, (p) => p.enemy('glub', 9, 0, 2, 5).enemy('blob', 13, -1).enemy('blob', 13, 1).coins(2, 7, 0, 3))
    .ground(12, { top: 3.2 }, (p) => p.coins(2, 10, -1, 4))
    .ground(12, { top: 4.0 }, (p) => p.coins(2, 10, 1, 4))
    .ground(16, { top: 4.0 }, (p) => p.spring(13.6).coins(3, 8, 0, 3).enemy('spiky', 5, -1, 0, 4, 0, true))
    // C: rope bridges above the falls.
    .ground(20, { top: 8.0, depth: 4 }, (p) => p.checkpoint(3).coins(6, 16, 0, 5).gem(13, 1, 1.0))
    .gap(2.0, 'hop', -1)
    .ground(8, { top: 8.0, lanes: [-1, 0], kind: 'wood' }, (p) => p.coins(2, 6, -1, 3))
    .gap(1.8, 'hop', 0)
    .ground(8, { top: 8.0, lanes: [0, 0], kind: 'wood' }, (p) => p.coins(2, 6, 0, 3))
    .gap(1.8, 'hop', 1)
    .ground(8, { top: 8.0, lanes: [0, 1], kind: 'wood' }, (p) => p.coins(2, 6, 1, 3))
    .gap(2.2, 'hop', 0)
    .ground(24, { top: 7.2 }, (p) => p.enemy('bee', 10, 0, 2, 4).enemy('glub', 17, 1, 1, 4).mystery(14, -1, 'magnet').coins(4, 22, -1, 7))
    .ground(10, { top: 7.2, kind: 'mover', mover: { amp: 1.6, period: 4, phase: 0.25 } }, (p) => p.coins(2, 8, 0, 4, 1.2))
    .gap(2.4, 'big', 0)
    .ground(18, { top: 8.0 }, (p) => p.log(6).enemy('pink', 12, 0, 2, 3).coins(9, 16, 1, 4))
    // D: the gorge.
    .ground(20, { top: 8.0 }, (p) => p.checkpoint(2).spikes(8, 1.8).arcCoins(7.2, 10.6, 0).crate(14, 0, 'heart').enemy('spiky', 14, 1, 0, 4, 0, true))
    .gap(3.6, 'big', 1)
    .ground(10, { top: 8.0, lanes: [0, 1] }, (p) => p.coins(2, 8, 1, 3).gem(6, 0, 2.4))
    .gap(2.0, 'hop', 0)
    .ground(12, { top: 8.0, kind: 'crumble' }, (p) => p.coins(1, 11, 0, 5))
    .gap(2.0, 'hop', 0)
    .ground(22, { top: 8.8 }, (p) => p.enemy('glub', 8, -1, 2, 4).enemy('bee', 15, 1, 2, 4).coins(3, 20, 0, 7).mystery(11, 0, 'coins'))
    .ground(14, { top: 9.6 }, (p) => p.enemy('blob', 8, 0, 2, 3).coins(2, 12, -1, 4))
    .gap(3.4, 'big', 0)
    .ground(12, { top: 10.4 }, (p) => p.coins(2, 10, 0, 4).gem(8, 1, 2.2))
    .ground(26, { top: 10.4 }, (p) => p.checkpoint(2).spikes(9, 1.8, -1, 0).enemy('bee', 14, 1, 1, 4).weave(4, 22, 1, -1, 8).enemy('pink', 21, 0, 2, 3))
    .gap(2.2, 'hop', 0)
    .ground(10, { top: 10.4, lanes: [-1, 0] }, (p) => p.coins(2, 8, -1, 3))
    .gap(2.0, 'hop', 0)
    .ground(10, { top: 10.4, kind: 'mover', lanes: [0, 1], mover: { amp: 0.8, period: 3, phase: 0.5 } }, (p) => p.coins(2, 8, 1, 3, 1.4))
    .gap(2.6, 'big', 0)
    .ground(22, { top: 11.2 }, (p) => p.log(8).enemy('glub', 14, 0, 2, 3).coins(10, 20, -1, 5))
    .ground(36, { top: 11.2 }, (p) => p.goal(24).coins(2, 20, 0, 8));
  return b.build(2, 'Waterfall Cliffs', 'Leap across tumbling falls and crumbling ledges', 'falls');
}

// ---- level 3: Sunset Citadel ------------------------------------------------------------------------

function sunset(d: Difficulty): LevelData {
  const b = new LevelBuilder(d);
  // A: the outer walls.
  b.ground(28, { kind: 'stone' }, (p) => p.prompt(2, 'Run on the spot!', 'run', 10).coins(10, 26, 0, 6))
    .ground(16, { kind: 'stone' }, (p) => p.enemy('bee', 8, 0, 2, 4).enemy('bee', 12, 1, 0, 4, 0.5, true).coins(2, 6, -1, 3))
    .gap(2.2, 'hop', 0)
    .ground(10, { kind: 'stone', top: 0.8 }, (p) => p.coins(2, 8, 0, 3))
    .gap(3.6, 'big', 0)
    .ground(18, { kind: 'stone', top: 0.8 }, (p) => p.spikes(4, 1.8, -1, 0).enemy('blob', 10, 1, 1, 3).coins(2, 15, 1, 5))
    .ground(14, { kind: 'stone', top: 2.4 }, (p) => p.log(5).enemy('spiky', 10, 0).coins(1, 4, 0, 2))
    .gap(2.0, 'hop', 0)
    .ground(6, { kind: 'mover', top: 2.4, lanes: [0, 0], mover: { amp: 0.8, period: 2.8, phase: 0 } }, (p) => p.coins(1, 5, 0, 2, 1.4))
    .gap(2.4, 'big', 0)
    // B: crumbling causeway.
    .ground(22, { kind: 'stone', top: 2.4 }, (p) => p.checkpoint(3).enemy('glub', 12, 0, 2, 3).enemy('glub', 16, -1, 2, 4, 0.5, true).power(19, 1, 'triple').coins(6, 18, -1, 6))
    .ground(10, { kind: 'crumble', top: 2.4 }, (p) => p.coins(1, 9, 0, 4))
    .gap(1.8, 'hop', 0)
    .ground(10, { kind: 'crumble', top: 2.4 }, (p) => p.coins(1, 9, 0, 4))
    .gap(2.4, 'hop', 0)
    .ground(24, { kind: 'stone', top: 2.4 }, (p) => p.spikes(5, 1.8).arcCoins(4.2, 7.6, 0).log(13).enemy('pink', 18, 0, 2, 3).crate(16.5, 1, 'heart'))
    .ground(14, { kind: 'stone', top: 4.0 }, (p) => p.enemy('spiky', 9, -1).enemy('spiky', 9, 1, 0, 4, 0, true).coins(3, 12, 0, 4))
    .ground(16, { kind: 'stone', top: 4.0 }, (p) => p.spring(13.6).coins(3, 8, 0, 3))
    // C: the ramparts.
    .ground(18, { kind: 'castle', top: 8.0, depth: 4 }, (p) => p.checkpoint(3).mystery(9, 0, 'shield').enemy('bee', 14, -1, 2, 3).coins(5, 16, 1, 5))
    .gap(2.2, 'hop', 1)
    .ground(8, { kind: 'stone', top: 8.0, lanes: [1, 1] }, (p) => p.coins(2, 6, 1, 3))
    .gap(2.0, 'hop', 0)
    .ground(8, { kind: 'stone', top: 8.0, lanes: [0, 0] }, (p) => p.coins(2, 6, 0, 3))
    .gap(3.4, 'big', -1)
    .ground(8, { kind: 'stone', top: 8.0, lanes: [-1, -1] }, (p) => p.coins(2, 6, -1, 3).gem(4, -1, 2.4))
    .gap(2.0, 'hop', 0)
    .ground(22, { kind: 'castle', top: 8.8 }, (p) => p.enemy('glub', 9, 0, 2, 3).enemy('bee', 14, 1, 2, 3).log(18).coins(2, 15, -1, 6))
    .ground(10, { kind: 'mover', top: 8.8, mover: { amp: 1.6, period: 3.6, phase: 0.3 } }, (p) => p.coins(2, 8, 0, 4, 1.2))
    .gap(2.4, 'big', 0)
    // D: the courtyard.
    .ground(20, { kind: 'castle', top: 9.6 }, (p) => p.checkpoint(2).spikes(8, 1.8).arcCoins(7.2, 10.6, 0).enemy('spiky', 15, 0).enemy('blob', 15, -1, 0, 4, 0, true).coins(12, 18, 1, 3))
    .ground(12, { kind: 'castle', top: 11.2 }, (p) => p.enemy('bee', 7, 0, 2, 3).coins(2, 10, 0, 4).gem(10, 1, 2.2))
    .gap(2.0, 'hop', 0)
    .ground(10, { kind: 'crumble', top: 11.2 }, (p) => p.coins(1, 9, 0, 4))
    .gap(3.4, 'big', 0)
    .ground(18, { kind: 'castle', top: 11.2 }, (p) => p.enemy('glub', 8, -1, 2, 3).enemy('glub', 11, 1, 2, 3, 0.5).log(14).coins(2, 16, 0, 6))
    .ground(24, { kind: 'castle', top: 11.2 }, (p) => p.checkpoint(2).mystery(8, 1, 'coins').crate(12, -1).enemy('spiky', 16, 0, 1, 3).spikes(19, 1.6, 1, 1).coins(4, 10, 0, 4))
    .gap(2.0, 'hop', -1)
    .ground(8, { kind: 'stone', top: 11.2, lanes: [-1, 0] }, (p) => p.coins(2, 6, -1, 3))
    .gap(2.0, 'hop', 0)
    .ground(8, { kind: 'stone', top: 11.2, lanes: [0, 1] }, (p) => p.coins(2, 6, 1, 3))
    .gap(3.4, 'big', 0)
    .ground(16, { kind: 'castle', top: 12.0 }, (p) => p.enemy('bee', 8, -1, 2, 3).enemy('bee', 12, 1, 2, 3, 0.5).coins(2, 14, 0, 6))
    .ground(14, { kind: 'castle', top: 12.8 }, (p) => p.enemy('pink', 9, 0, 2, 3).coins(2, 7, 1, 3))
    // E: the keep.
    .ground(22, { kind: 'castle', top: 12.8 }, (p) => p.checkpoint(2).log(8).enemy('glub', 13, 0, 2, 3).enemy('bee', 17, -1, 2, 3, 0.4).coins(10, 20, 1, 5))
    .gap(2.2, 'hop', 0)
    .ground(6, { kind: 'mover', top: 12.8, lanes: [-1, 0], mover: { amp: 0.8, period: 2.6, phase: 0 } }, (p) => p.coins(1, 5, 0, 2, 1.4))
    .gap(2.6, 'big', 0)
    .ground(10, { kind: 'crumble', top: 12.8 }, (p) => p.coins(1, 9, 0, 4))
    .gap(2.0, 'hop', 1)
    .ground(8, { kind: 'stone', top: 12.8, lanes: [1, 1] }, (p) => p.coins(2, 6, 1, 2).gem(5, 1, 2.4))
    .gap(2.0, 'hop', 0)
    .ground(18, { kind: 'castle', top: 12.8 }, (p) => p.spikes(5, 1.6).arcCoins(4.2, 7.4, 0).enemy('spiky', 12, -1).enemy('spiky', 12, 1).mystery(15, 0, 'coins'))
    .ground(14, { kind: 'castle', top: 13.6 }, (p) => p.enemy('blob', 8, 0, 2, 3).coins(2, 12, -1, 5))
    .ground(40, { kind: 'castle', top: 13.6 }, (p) => p.goal(26).coins(2, 22, 0, 9));
  return b.build(3, 'Sunset Citadel', 'Storm the castle in the clouds at golden hour', 'sunset');
}

export const LEVELS = [meadow, falls, sunset];
export const LEVEL_INFO = [
  { id: 1, name: 'Meadow Isles', tagline: 'Learn the moves on sunny floating islands', theme: 'meadow' as ThemeId },
  { id: 2, name: 'Waterfall Cliffs', tagline: 'Leap across tumbling falls and crumbling ledges', theme: 'falls' as ThemeId },
  { id: 3, name: 'Sunset Citadel', tagline: 'Storm the castle in the clouds at golden hour', theme: 'sunset' as ThemeId },
];

export function buildLevel(id: number, d: Difficulty): LevelData {
  const f = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, id - 1))];
  return f(d);
}

/** Stars: coins (≥ 75 %), time (≤ par), no damage. */
export function starsFor(coins: number, coinTotal: number, time: number, par: number, damaged: boolean): { coins: boolean; time: boolean; clean: boolean; n: number } {
  const c = coinTotal > 0 && coins >= Math.ceil(coinTotal * 0.75);
  const t = time <= par;
  const k = !damaged;
  return { coins: c, time: t, clean: k, n: (c ? 1 : 0) + (t ? 1 : 0) + (k ? 1 : 0) };
}
