/**
 * Sky Quest platforming physics (pure, no three.js): a player cylinder running along a straight path
 * (s = forward metres, x = sideways metres, y = up) over axis-aligned boxes.
 *
 * Camera tracking is late (~100-200 ms from takeoff to detection) and noisy, so jumping is forgiving:
 * - coyote time: a jump captured shortly after running off an edge still counts (judged by capture time),
 * - latency compensation: a ground jump starts "in the past" at its capture time (up to MAX_LAG),
 * - jump buffering: a hop that arrives just before landing fires on touchdown,
 * - two-stage jumps: every jump starts as a hop; a big body jump or a second hop in the air boosts it,
 * - ledge assist: hitting a face whose top is a little above the feet pops the player onto it,
 * - lenient footing: the player stands on a box while the centre is within FOOT of its edge.
 */

export const G = 24;
export const HOP_APEX = 1.2;
export const BIG_APEX = 2.8;
export const SPRING_APEX = 5.4;
export const STOMP_APEX = 1.7;
export const STAND_H = 1.75;
export const DUCK_H = 1.0;
export const R = 0.3;
export const FOOT = 0.25;
export const STEP = 0.32;
export const MANTLE = 0.55;
/** A big body jump boosts the hop if it is recognised within this time after takeoff (s). */
export const BOOST_WINDOW = 0.6;
export const MAX_LAG = 0.12;
export const LATERAL_SPEED = 7.5;
/** Big jumps are capped in forward speed so a sprinting player does not overshoot short landings. */
export const AIR_MAX_BIG = 6.3;

export const vFor = (apex: number) => Math.sqrt(2 * G * apex);

export type BoxKind = 'grass' | 'stone' | 'wood' | 'mover' | 'crumble' | 'mystery' | 'crate' | 'castle' | 'cloud';

/** A solid box in path space. */
export interface Solid {
  id: number;
  s0: number;
  s1: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  kind: BoxKind;
  /** False once broken or fallen away. */
  solid: boolean;
  /** How much the top moved in the last update (moving platforms carry the player). */
  dTop: number;
}

export interface PhysCfg {
  /** Seconds after leaving the ground during which a jump still counts. */
  coyote: number;
  /** Forward speed floor while airborne from a jump, so gaps are fair at any running speed (m/s). */
  airMin: number;
  /** A jump that arrives this long before landing fires on touchdown (s). */
  buffer: number;
}

export interface Player {
  s: number;
  x: number;
  y: number;
  vy: number;
  /** Forward speed on the ground (m/s). */
  vs: number;
  grounded: boolean;
  ground: Solid | null;
  /** Game time of the last moment on the ground, and the height there. */
  lastGroundT: number;
  lastGroundY: number;
  /** Airborne because of a jump (not a fall or a bounce). */
  jumping: boolean;
  jumpT: number;
  jumpY: number;
  boosted: boolean;
  /** Forward speed while airborne. */
  airSpeed: number;
  bufferedAt: number;
  height: number;
  ducking: boolean;
}

export function newPlayer(s = 0, y = 0): Player {
  return {
    s,
    x: 0,
    y,
    vy: 0,
    vs: 0,
    grounded: true,
    ground: null,
    lastGroundT: 0,
    lastGroundY: y,
    jumping: false,
    jumpT: -10,
    jumpY: y,
    boosted: false,
    airSpeed: 0,
    bufferedAt: -10,
    height: STAND_H,
    ducking: false,
  };
}

/** Bucketed lookup of boxes along s. */
export class SolidIndex {
  private buckets = new Map<number, Solid[]>();
  readonly all: Solid[] = [];
  constructor(private size = 4) {}

  add(b: Solid): void {
    this.all.push(b);
    for (let k = Math.floor(b.s0 / this.size); k <= Math.floor(b.s1 / this.size); k++) {
      let list = this.buckets.get(k);
      if (!list) this.buckets.set(k, (list = []));
      list.push(b);
    }
  }

  /** Boxes that may overlap [s0, s1]. */
  near(s0: number, s1: number, out: Solid[] = []): Solid[] {
    out.length = 0;
    const seen = new Set<Solid>();
    for (let k = Math.floor(s0 / this.size); k <= Math.floor(s1 / this.size); k++) {
      const list = this.buckets.get(k);
      if (!list) continue;
      for (const b of list) {
        if (!seen.has(b) && b.s1 >= s0 && b.s0 <= s1) {
          seen.add(b);
          out.push(b);
        }
      }
    }
    return out;
  }
}

/** Highest solid top under (s, x) that is at or below `y + tol`, or null. */
export function supportAt(idx: SolidIndex, s: number, x: number, y: number, tol = 0.05): Solid | null {
  let best: Solid | null = null;
  for (const b of idx.near(s - FOOT, s + FOOT, scratch)) {
    if (!b.solid) continue;
    if (s < b.s0 - FOOT || s > b.s1 + FOOT || x < b.x0 - FOOT || x > b.x1 + FOOT) continue;
    if (b.top > y + tol) continue;
    if (!best || b.top > best.top) best = b;
  }
  return best;
}

const scratch: Solid[] = [];

export interface StepInput {
  /** Desired forward speed on the ground (m/s). */
  speed: number;
  /** Desired sideways position (m). */
  x: number;
  duck: boolean;
}

export interface StepEvents {
  landed: { vy: number; box: Solid } | null;
  bonk: Solid | null;
  ceiling: Solid | null;
  mantle: Solid | null;
  leftGround: boolean;
  /** A buffered jump fired on landing. */
  bufferedJump: boolean;
}

const emptyEvents = (): StepEvents => ({ landed: null, bonk: null, ceiling: null, mantle: null, leftGround: false, bufferedJump: false });

/** Starts a jump from the ground (or within coyote time). `lag` is how long ago the body actually jumped. */
function groundJump(p: Player, now: number, lag: number, cfg: PhysCfg, captureT: number): void {
  const v0 = vFor(HOP_APEX);
  const baseY = p.grounded ? p.y : p.lastGroundY;
  const l = Math.max(0, Math.min(MAX_LAG, lag));
  p.vy = v0 - G * l;
  p.y = baseY + v0 * l - 0.5 * G * l * l;
  p.grounded = false;
  p.ground = null;
  p.jumping = true;
  p.jumpT = captureT;
  p.jumpY = baseY;
  p.boosted = false;
  p.airSpeed = Math.max(p.vs, cfg.airMin);
  void now;
}

/** Boost an airborne player into the high jump (big body jump or second hop). */
export function boost(p: Player, cfg: PhysCfg): void {
  const target = (p.jumping ? p.jumpY : p.y) + BIG_APEX;
  const need = Math.max(0.7, Math.min(BIG_APEX, target - p.y));
  p.vy = Math.max(p.vy, vFor(need));
  p.boosted = true;
  p.airSpeed = Math.min(Math.max(p.airSpeed, cfg.airMin), Math.max(cfg.airMin, AIR_MAX_BIG));
  if (!p.jumping) {
    p.jumping = true;
    p.jumpY = p.y;
  }
}

export type JumpResult = 'jump' | 'double' | 'buffered' | null;

/**
 * A takeoff seen by the camera, captured at `captureT` (game clock, seconds) and processed at `now`.
 * Hops on the ground (or within coyote time), double-jumps in the air, buffers if already boosted.
 */
export function requestJump(p: Player, captureT: number, now: number, cfg: PhysCfg, idx?: SolidIndex): JumpResult {
  const onGround = p.grounded || (!p.jumping && captureT <= p.lastGroundT + cfg.coyote && now - p.lastGroundT < cfg.coyote + 0.35);
  if (onGround) {
    groundJump(p, now, now - captureT, cfg, captureT);
    return 'jump';
  }
  // About to land: keep it for touchdown instead of spending the double jump.
  if (idx && p.vy < 0) {
    const below = supportAt(idx, p.s, p.x, p.y + 0.01, 0.01);
    if (below && p.y - below.top < Math.max(0.25, -p.vy * 0.12)) {
      p.bufferedAt = now;
      return 'buffered';
    }
  }
  if (!p.boosted) {
    boost(p, cfg);
    return 'double';
  }
  p.bufferedAt = now;
  return 'buffered';
}

/** The body went high enough for a big jump: boost the current hop, or jump big from the ground. */
export function requestBig(p: Player, captureT: number, now: number, cfg: PhysCfg): JumpResult {
  if (p.jumping && !p.boosted && now - p.jumpT <= BOOST_WINDOW) {
    boost(p, cfg);
    return 'double';
  }
  if (p.grounded || (!p.jumping && captureT <= p.lastGroundT + cfg.coyote)) {
    groundJump(p, now, now - captureT, cfg, captureT);
    boost(p, cfg);
    return 'jump';
  }
  return null;
}

/** Launch straight up (springs, stomps). */
export function launch(p: Player, apex: number, cfg: PhysCfg): void {
  p.vy = vFor(apex);
  p.grounded = false;
  p.ground = null;
  p.jumping = false;
  p.boosted = false;
  p.airSpeed = Math.max(p.vs, cfg.airMin);
}

const overlapX = (p: Player, b: Solid, r: number) => p.x + r > b.x0 && p.x - r < b.x1;

/** What happens when the player's side touches a box face: walk up, pop up (ledge assist), or blocked. */
function contact(p: Player, b: Solid): 'none' | 'step' | 'mantle' | 'wall' {
  const rise = b.top - p.y;
  if (rise <= 0.001 || b.bottom >= p.y + p.height - 0.05) return 'none';
  if (p.grounded && rise <= STEP) return 'step';
  if (rise <= MANTLE && b.kind !== 'mystery' && b.kind !== 'crate') return 'mantle';
  return 'wall';
}

/**
 * Advance the player by dt seconds (call with small dt, ~1/120 s). `now` is the game clock after the step.
 * Moving boxes must be updated (top/bottom/dTop/solid) before calling.
 */
export function stepPlayer(p: Player, inp: StepInput, idx: SolidIndex, dt: number, now: number, cfg: PhysCfg): StepEvents {
  const ev = emptyEvents();

  // Crouch height eases; standing up is blocked under a low ceiling.
  const wantH = inp.duck ? DUCK_H : STAND_H;
  p.ducking = inp.duck;
  if (wantH > p.height) {
    let ceiling = Infinity;
    for (const b of idx.near(p.s - R, p.s + R, scratch)) {
      if (b.solid && overlapX(p, b, R * 0.8) && p.s + R > b.s0 && p.s - R < b.s1 && b.bottom >= p.y + p.height - 0.01) ceiling = Math.min(ceiling, b.bottom);
    }
    p.height = Math.min(wantH, p.height + dt * 6, ceiling - p.y);
  } else p.height = Math.max(wantH, p.height - dt * 8);

  // Sideways, toward the requested position.
  const dx = Math.max(-LATERAL_SPEED * dt, Math.min(LATERAL_SPEED * dt, inp.x - p.x));
  if (dx !== 0) {
    let x = p.x + dx;
    for (const b of idx.near(p.s - R, p.s + R, scratch)) {
      if (!b.solid || p.s + R <= b.s0 || p.s - R >= b.s1) continue;
      const hit = dx > 0 ? p.x + R <= b.x0 + 1e-6 && x + R > b.x0 : p.x - R >= b.x1 - 1e-6 && x - R < b.x1;
      if (!hit) continue;
      const c = contact(p, b);
      if (c === 'none') continue;
      if (c === 'wall') x = dx > 0 ? Math.min(x, b.x0 - R) : Math.max(x, b.x1 + R);
      else {
        p.y = b.top;
        if (c === 'mantle') ev.mantle = b;
        land(p, b, now, ev);
      }
    }
    p.x = x;
  }

  // Forward.
  if (p.grounded) {
    const a = inp.speed > p.vs ? 9 : 12;
    p.vs += Math.max(-a * dt, Math.min(a * dt, inp.speed - p.vs));
  }
  const v = p.grounded ? p.vs : Math.max(p.airSpeed, 0);
  let ns = p.s + v * dt;
  if (v > 0) {
    for (const b of idx.near(p.s, ns + R + 0.01, scratch)) {
      if (!b.solid || !overlapX(p, b, R * 0.8)) continue;
      if (!(p.s + R <= b.s0 + 1e-6 && ns + R > b.s0)) continue;
      const c = contact(p, b);
      if (c === 'none') continue;
      if (c === 'wall') {
        ns = Math.min(ns, b.s0 - R);
        ev.bonk = b;
      } else {
        p.y = b.top;
        if (c === 'mantle') ev.mantle = b;
        land(p, b, now, ev);
      }
    }
    // Against a wall on the ground the run stops; in the air the player keeps pressing on and slides over the top.
    if (ev.bonk && p.grounded) p.vs = 0;
  }
  p.s = ns;

  // Vertical.
  if (p.grounded) {
    const g = p.ground && p.ground.solid ? p.ground : null;
    if (g) p.y = g.top;
    const sup = supportAt(idx, p.s, p.x, p.y + Math.max(0.06, g ? g.dTop + 0.06 : 0.06), 0.06);
    if (sup && sup.top >= p.y - 0.12) {
      p.y = sup.top;
      p.ground = sup;
      p.lastGroundT = now;
      p.lastGroundY = p.y;
    } else {
      p.grounded = false;
      p.ground = null;
      p.jumping = false;
      p.boosted = false;
      p.vy = Math.min(0, g ? g.dTop / Math.max(dt, 1e-3) : 0);
      p.airSpeed = p.vs;
      p.lastGroundT = now;
      p.lastGroundY = p.y;
      ev.leftGround = true;
    }
  } else {
    const prevY = p.y;
    p.vy -= G * dt;
    let ny = p.y + p.vy * dt;
    if (p.vy <= 0) {
      let best: Solid | null = null;
      for (const b of idx.near(p.s - FOOT, p.s + FOOT, scratch)) {
        if (!b.solid) continue;
        if (p.s < b.s0 - FOOT || p.s > b.s1 + FOOT || p.x < b.x0 - FOOT || p.x > b.x1 + FOOT) continue;
        if (b.top > prevY + 0.02 + Math.max(0, b.dTop) || b.top < ny - 0.001) continue;
        if (!best || b.top > best.top) best = b;
      }
      if (best) {
        ev.landed = { vy: p.vy, box: best };
        ny = best.top;
        p.y = ny;
        land(p, best, now, ev);
        if (now - p.bufferedAt <= cfg.buffer) {
          p.bufferedAt = -10;
          groundJump(p, now, 0, cfg, now);
          ev.bufferedJump = true;
        }
      }
    } else {
      for (const b of idx.near(p.s - R, p.s + R, scratch)) {
        if (!b.solid || !overlapX(p, b, R * 0.7) || p.s + R * 0.7 <= b.s0 || p.s - R * 0.7 >= b.s1) continue;
        if (b.bottom >= prevY + p.height - 0.02 && b.bottom <= ny + p.height) {
          ny = b.bottom - p.height;
          p.vy = Math.min(0, -1);
          ev.ceiling = b;
        }
      }
    }
    if (!p.grounded) p.y = ny;
  }
  return ev;
}

function land(p: Player, b: Solid, now: number, _ev: StepEvents): void {
  p.grounded = true;
  p.ground = b;
  p.vy = 0;
  p.jumping = false;
  p.boosted = false;
  p.lastGroundT = now;
  p.lastGroundY = b.top;
  p.vs = Math.max(p.vs, Math.min(p.airSpeed, p.vs + 1));
}

/** Horizontal distance covered by a jump launched at `speed`, landing `dy` above the takeoff height. */
export function jumpReach(kind: 'hop' | 'big', speed: number, dy = 0, boostAt = 0.25): number {
  const dt = 1 / 240;
  let y = 0;
  let vy = vFor(HOP_APEX);
  let t = 0;
  let boosted = kind === 'hop';
  let peaked = false;
  for (let i = 0; i < 2400; i++) {
    if (!boosted && t >= boostAt) {
      vy = Math.max(vy, vFor(Math.max(0.7, Math.min(BIG_APEX, BIG_APEX - y))));
      boosted = true;
    }
    vy -= G * dt;
    y += vy * dt;
    t += dt;
    if (vy < 0) peaked = true;
    if (peaked && boosted && y <= dy) return speed * t;
  }
  return 0;
}
