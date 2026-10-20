import { describe, expect, it } from 'vitest';
import { BodyTracker, type Body } from '../src/core/body';
import { LM, type PoseFrame, type Pt, type V2 } from '../src/core/types';
import {
  BIG_APEX,
  FOOT,
  HOP_APEX,
  R,
  SPRING_APEX,
  SolidIndex,
  launch,
  newPlayer,
  requestBig,
  requestJump,
  stepPlayer,
  supportAt,
  jumpReach,
  type PhysCfg,
  type Player,
  type Solid,
} from '../src/games/quest/physics';
import { DIFFICULTIES, LANE_W, PROFILES, buildLevel, laneX, starsFor, type JumpReq, type LevelData } from '../src/games/quest/levels';
import { InputMapper } from '../src/games/quest/input';
import { Planner } from '../src/games/quest/plan';

// ---- helpers -----------------------------------------------------------------------------------------

const DT = 1 / 120;

/** Solid boxes of a level; moving platforms sit at the bottom (lift 0) or top (lift 1) of their travel. */
function solidsOf(level: Pick<LevelData, 'boxes'>, moverLift = 0): { idx: SolidIndex; list: Solid[] } {
  const idx = new SolidIndex();
  const list: Solid[] = [];
  level.boxes.forEach((b, id) => {
    const lift = b.mover ? b.mover.amp * moverLift : 0;
    const s: Solid = {
      id,
      s0: b.s0,
      s1: b.s1,
      x0: laneX(b.l0) - LANE_W / 2,
      x1: laneX(b.l1) + LANE_W / 2,
      top: b.top + lift,
      bottom: b.top + lift - b.depth,
      kind: b.kind,
      solid: true,
      dTop: 0,
    };
    list.push(s);
    idx.add(s);
  });
  return { idx, list };
}

function box(s0: number, s1: number, top: number, kind: Solid['kind'] = 'grass', x0 = -2.4, x1 = 2.4, depth = 1.6): Solid {
  return { id: Math.random(), s0, s1, x0, x1, top, bottom: top - depth, kind, solid: true, dTop: 0 };
}

function indexOf(...boxes: Solid[]): SolidIndex {
  const idx = new SolidIndex();
  boxes.forEach((b) => idx.add(b));
  return idx;
}

const cfgOf = (d: keyof typeof PROFILES): PhysCfg => ({ coyote: PROFILES[d].coyote, airMin: PROFILES[d].airMin, buffer: PROFILES[d].buffer });

/**
 * Run a player at `speed` toward a jump requirement in `lane`, jump when the player reaches `takeoff`
 * (boosting `boostDelay` s later for big jumps) and report where it lands.
 */
function tryReq(level: LevelData, req: JumpReq, cfg: PhysCfg, opts: { speed: number; lane: number; takeoff: number; boostDelay: number; latency?: number; lift?: number }) {
  // Crates are shot or stomped; they are not part of the jump test.
  const { idx } = solidsOf({ boxes: level.boxes.filter((b) => b.kind !== 'crate') }, opts.lift ?? 0);
  // Start in the lane of the take-off platform nearest the landing lane; lean across at take-off.
  const src = level.boxes.find((b) => b.kind !== 'mystery' && b.kind !== 'crate' && b.s0 <= req.s - 0.5 && b.s1 >= req.s - 0.5 && Math.abs(b.top - req.fromTop) < 0.01);
  const startLane = src ? Math.max(src.l0, Math.min(src.l1, opts.lane)) : opts.lane;
  const startY = req.fromTop + (src?.mover ? src.mover.amp * (opts.lift ?? 0) : 0);
  const p: Player = newPlayer(Math.max(src ? src.s0 + 0.3 : -1e9, req.s - 5), startY);
  p.x = laneX(startLane);
  p.vs = opts.speed;
  const sup = supportAt(idx, p.s, p.x, p.y + 0.05);
  p.ground = sup;
  let t = 0;
  let jumped = false;
  let boostAt = Infinity;
  const lat = opts.latency ?? 0.1;
  let pendingJump = Infinity;
  for (let i = 0; i < 120 * 6; i++) {
    t += DT;
    if (!jumped && p.s >= opts.takeoff) {
      jumped = true;
      pendingJump = t + lat; // the camera reports it later
    }
    if (t >= pendingJump) {
      pendingJump = Infinity;
      const r = requestJump(p, t - lat, t, cfg, idx);
      if (r === null) return { ok: false, why: 'no jump' };
      if (req.kind === 'big') boostAt = t + opts.boostDelay;
    }
    if (t >= boostAt) {
      boostAt = Infinity;
      requestBig(p, t - lat, t, cfg);
    }
    const ev = stepPlayer(p, { speed: opts.speed, x: laneX(jumped ? opts.lane : startLane), duck: false }, idx, DT, t, cfg);
    if (ev.landed && jumped && pendingJump === Infinity && boostAt === Infinity && p.s > req.s) {
      const onTarget = req.why === 'spikes' ? p.s > req.land0 : ev.landed.box.s0 >= req.land0 - 0.01 && ev.landed.box.s0 <= req.land1;
      return { ok: onTarget, why: `landed at s=${p.s.toFixed(2)} y=${p.y.toFixed(2)}`, s: p.s };
    }
    if (ev.mantle && ev.mantle.s0 >= req.land0 - 0.01) return { ok: true, why: 'mantle', s: p.s };
    if (p.y < req.toTop - 6 || p.y < req.fromTop - 6) return { ok: false, why: `fell at s=${p.s.toFixed(2)}` };
  }
  return { ok: false, why: 'timeout' };
}

// ---- level layouts --------------------------------------------------------------------------------------

describe('level layouts', () => {
  for (const d of DIFFICULTIES) {
    for (const id of [1, 2, 3]) {
      const level = buildLevel(id, d);
      const cfg = cfgOf(d);
      const prof = PROFILES[d];

      it(`L${id} ${d}: sane structure`, () => {
        expect(level.length).toBeGreaterThan(450);
        expect(level.checkpoints.length).toBeGreaterThanOrEqual(3);
        expect(level.coinTotal).toBeGreaterThan(100);
        expect(level.gemTotal).toBe(3);
        const { idx } = solidsOf(level);
        // Start, checkpoints and the goal stand on solid ground in the centre lane.
        for (const c of [{ s: 0.5, y: 0 }, ...level.checkpoints, level.goal]) {
          const sup = supportAt(idx, c.s, 0, c.y + 0.05);
          expect(sup, `ground at s=${c.s}`).not.toBeNull();
          expect(Math.abs(sup!.top - c.y)).toBeLessThan(0.01);
        }
        // Coins are not buried in solid boxes.
        for (const it of level.items) {
          const inside = idx.near(it.s, it.s).some((b) => it.s > b.s0 && it.s < b.s1 && it.x > b.x0 && it.x < b.x1 && it.y > b.bottom && it.y < b.top);
          expect(inside, `item at s=${it.s.toFixed(1)} y=${it.y.toFixed(1)}`).toBe(false);
        }
        // Prompts point at things ahead, inside the level.
        for (const p of level.prompts) expect(p.s1).toBeLessThan(level.goal.s);
        // Crates (lane blockers to shoot) are kept clear of jump points.
        for (const c of level.boxes.filter((b) => b.kind === 'crate')) {
          for (const j of level.jumps) expect(c.s1 < j.s - 4 || c.s0 > j.land0 + 2, `crate at ${c.s0.toFixed(1)} near jump ${j.s.toFixed(1)}`).toBe(true);
        }
      });

      it(`L${id} ${d}: every gap and step is passable with the jump it asks for`, () => {
        const reqs = level.jumps.filter((j) => j.kind !== 'spring');
        expect(reqs.length).toBeGreaterThan(8);
        for (const req of reqs) {
          // The player may be in any lane shared by both sides; check the landing lanes.
          const lanes = [req.lanes[0], req.lanes[1]].filter((l, i, a) => a.indexOf(l) === i);
          for (const lane of lanes) {
            for (const speed of [Math.min(prof.autoSpeed, cfg.airMin), prof.maxSpeed]) {
              // Takeoff anywhere from 0.6 m early to a little late (inside coyote time).
              for (const early of [0.6, 0.0, -Math.min(0.5, cfg.coyote * speed * 0.6)]) {
                if (req.why === 'step' || req.why === 'spikes') {
                  if (early < 0) continue;
                }
                const takeoff = req.why === 'spikes' ? req.s - 0.2 - early : req.s - early - (req.why === 'step' ? 0.7 : 0);
                const movers = level.boxes.some((b) => b.mover && b.s1 > req.s - 6 && b.s0 < req.land1);
                for (const lift of movers ? [0, 1] : [0]) {
                  for (const boostDelay of req.kind === 'big' ? [0.05, 0.35] : [0]) {
                    const r = tryReq(level, req, cfg, { speed, lane, takeoff, boostDelay, lift });
                    expect(r.ok, `L${id} ${d} ${req.why} ${req.kind} at s=${req.s.toFixed(1)} lane ${lane} speed ${speed} early ${early} boost ${boostDelay} lift ${lift}: ${r.why}`).toBe(true);
                  }
                }
              }
            }
          }
        }
      });

      it(`L${id} ${d}: springs reach the walls they face`, () => {
        const reqs = level.jumps.filter((j) => j.kind === 'spring');
        for (const req of reqs) {
          const springs = level.springs.filter((s) => s.s < req.s && s.s > req.s - 8);
          expect(springs.length).toBe(req.lanes[1] - req.lanes[0] + 1 > 0 ? springs.length : 0);
          expect(springs.length).toBeGreaterThan(0);
          for (const sp of springs) {
            const { idx } = solidsOf(level);
            const p = newPlayer(sp.s, sp.y);
            p.x = laneX(sp.lane);
            launch(p, SPRING_APEX, cfg);
            let t = 0;
            let landed = false;
            for (let i = 0; i < 600 && !landed; i++) {
              t += DT;
              const ev = stepPlayer(p, { speed: prof.autoSpeed, x: p.x, duck: false }, idx, DT, t, cfg);
              if (ev.landed || ev.mantle) landed = true;
            }
            expect(landed).toBe(true);
            expect(Math.abs(p.y - req.toTop)).toBeLessThan(0.01);
          }
        }
      });

      it(`L${id} ${d}: the bot's route planner gets through to the goal`, () => {
        // Run the level at auto speed, steering and jumping with the demo bot's planner (perfect timing).
        // Crates are shot on the way, so they are left out.
        const { idx, list } = solidsOf({ boxes: level.boxes.filter((b) => b.kind !== 'crate') });
        const plan = new Planner(level);
        const p = newPlayer(0.5, 0);
        p.ground = supportAt(idx, 0.5, 0, 0.05);
        let t = 0;
        let boostAt = Infinity;
        const low = Math.min(...list.map((b) => b.top));
        for (let i = 0; i < 120 * 400 && p.s < level.goal.s; i++) {
          t += DT;
          const req = plan.jumpNow(p);
          if (req) {
            requestJump(p, t, t, cfg, idx);
            if (req.kind === 'big') boostAt = t + 0.2;
          }
          if (t >= boostAt) {
            boostAt = Infinity;
            requestBig(p, t, t, cfg);
          }
          if (p.grounded && level.springs.some((s) => Math.abs(s.s - p.s) < 0.6 && Math.abs(laneX(s.lane) - p.x) < 0.7)) launch(p, SPRING_APEX, cfg);
          const lane = plan.lane(p, 0);
          stepPlayer(p, { speed: prof.autoSpeed, x: laneX(lane), duck: plan.duck(p.s) }, idx, DT, t, cfg);
          if (p.y < low - 3) break;
        }
        expect(p.y, `fell near s=${p.s.toFixed(1)}`).toBeGreaterThan(low - 3);
        expect(p.s).toBeGreaterThanOrEqual(level.goal.s);
      });
    }
  }

  it('is deterministic', () => {
    expect(JSON.stringify(buildLevel(2, 'hard'))).toBe(JSON.stringify(buildLevel(2, 'hard')));
  });

  it('easy widens narrow platforms and shortens gaps', () => {
    const e = buildLevel(1, 'easy');
    const n = buildLevel(1, 'normal');
    expect(e.boxes.filter((b) => b.kind !== 'mystery' && b.kind !== 'crate').every((b) => b.l0 === -1 && b.l1 === 1)).toBe(true);
    expect(n.boxes.some((b) => b.l0 === b.l1 && b.kind !== 'mystery' && b.kind !== 'crate')).toBe(true);
    expect(e.length).toBeLessThan(n.length);
  });

  it('hard adds enemies', () => {
    expect(buildLevel(3, 'hard').enemies.length).toBeGreaterThan(buildLevel(3, 'normal').enemies.length);
  });

  it('stars: coins, time and no damage', () => {
    expect(starsFor(80, 100, 100, 120, false).n).toBe(3);
    expect(starsFor(70, 100, 100, 120, false)).toMatchObject({ coins: false, time: true, clean: true, n: 2 });
    expect(starsFor(100, 100, 130, 120, true).n).toBe(1);
  });
});

// ---- jump physics ------------------------------------------------------------------------------------------

describe('jump physics', () => {
  const cfg: PhysCfg = { coyote: 0.2, airMin: 4.8, buffer: 0.25 };

  it('hop and big jump reach the designed heights and distances', () => {
    const idx = indexOf(box(-10, 100, 0));
    const p = newPlayer(0, 0);
    p.ground = supportAt(idx, 0, 0, 0.05);
    expect(requestJump(p, 0, 0, cfg, idx)).toBe('jump');
    let peak = 0;
    let t = 0;
    for (let i = 0; i < 240 && (i < 2 || !p.grounded); i++) {
      t += DT;
      stepPlayer(p, { speed: 0, x: 0, duck: false }, idx, DT, t, cfg);
      peak = Math.max(peak, p.y);
    }
    expect(peak).toBeGreaterThan(HOP_APEX - 0.05);
    expect(peak).toBeLessThan(HOP_APEX + 0.05);
    expect(t).toBeGreaterThan(0.55);
    expect(t).toBeLessThan(0.7);
    // Standing jumps still carry the player forward at the air speed floor.
    expect(p.s).toBeGreaterThan(cfg.airMin * 0.55);
    expect(jumpReach('big', 5, 0, 0.3)).toBeGreaterThan(jumpReach('hop', 5) * 1.5);
  });

  it('a big rise while in the air boosts the hop to the high jump', () => {
    const idx = indexOf(box(-10, 100, 0));
    const p = newPlayer(0, 0);
    p.ground = supportAt(idx, 0, 0, 0.05);
    requestJump(p, 0, 0, cfg, idx);
    let peak = 0;
    let t = 0;
    for (let i = 0; i < 360 && (i < 2 || !p.grounded); i++) {
      t += DT;
      if (Math.abs(t - 0.25) < DT / 2) expect(requestBig(p, t - 0.1, t, cfg)).toBe('double');
      stepPlayer(p, { speed: 0, x: 0, duck: false }, idx, DT, t, cfg);
      peak = Math.max(peak, p.y);
    }
    expect(peak).toBeGreaterThan(BIG_APEX - 0.1);
    expect(peak).toBeLessThan(BIG_APEX + 0.1);
  });

  it('a second hop in the air is a double jump, only once', () => {
    const idx = indexOf(box(-10, 100, 0));
    const p = newPlayer(0, 0);
    p.ground = supportAt(idx, 0, 0, 0.05);
    requestJump(p, 0, 0, cfg, idx);
    let t = 0;
    for (let i = 0; i < 30; i++) stepPlayer(p, { speed: 0, x: 0, duck: false }, idx, DT, (t += DT), cfg);
    expect(requestJump(p, t, t, cfg, idx)).toBe('double');
    expect(p.vy).toBeGreaterThan(8);
    for (let i = 0; i < 20; i++) stepPlayer(p, { speed: 0, x: 0, duck: false }, idx, DT, (t += DT), cfg);
    expect(requestJump(p, t, t, cfg, idx)).toBe('buffered');
  });

  it('coyote time: a jump captured just after running off an edge still counts', () => {
    const idx = indexOf(box(-10, 10, 0), box(14, 30, 0));
    const run = (lateBy: number) => {
      const p = newPlayer(8, 0);
      p.vs = 5;
      p.ground = supportAt(idx, 8, 0, 0.05);
      let t = 0;
      let leftAt = -1;
      for (let i = 0; i < 400; i++) {
        t += DT;
        const ev = stepPlayer(p, { speed: 5, x: 0, duck: false }, idx, DT, t, cfg);
        if (ev.leftGround) leftAt = t;
        if (leftAt > 0 && t >= leftAt + lateBy) return requestJump(p, leftAt + lateBy, t + 0.1, cfg, idx);
      }
      return null;
    };
    expect(run(0.1)).toBe('jump');
    expect(run(0.35)).toBe('double');
  });

  it('latency compensation: a jump seen late starts from where it would have been', () => {
    const idx = indexOf(box(-10, 100, 0));
    const a = newPlayer(0, 0);
    const b = newPlayer(0, 0);
    a.ground = b.ground = supportAt(idx, 0, 0, 0.05);
    requestJump(a, 1.0, 1.0, cfg, idx);
    requestJump(b, 0.9, 1.0, cfg, idx);
    expect(b.y).toBeGreaterThan(a.y + 0.5);
    expect(b.vy).toBeLessThan(a.vy);
  });

  it('jump buffering: a hop just before landing fires on touchdown', () => {
    const idx = indexOf(box(-10, 100, 0));
    const p = newPlayer(0, 0);
    p.ground = supportAt(idx, 0, 0, 0.05);
    requestJump(p, 0, 0, cfg, idx);
    let t = 0;
    let fired = false;
    for (let i = 0; i < 200; i++) {
      t += DT;
      if (p.vy < 0 && p.y < 0.25 && p.y > 0.05 && !fired) {
        expect(requestJump(p, t, t, cfg, idx)).toBe('buffered');
        fired = true;
      }
      const ev = stepPlayer(p, { speed: 0, x: 0, duck: false }, idx, DT, t, cfg);
      if (ev.landed) {
        expect(ev.bufferedJump).toBe(true);
        expect(p.vy).toBeGreaterThan(5);
        return;
      }
    }
    throw new Error('never landed');
  });
});

// ---- collisions ------------------------------------------------------------------------------------------

describe('player capsule vs platforms', () => {
  const cfg: PhysCfg = { coyote: 0.2, airMin: 4.8, buffer: 0.25 };

  it('walls stop the player; low ledges are mantled', () => {
    const idx = indexOf(box(-10, 10, 0), box(10, 20, 1.6), box(20, 30, 2.0));
    const p = newPlayer(5, 0);
    p.ground = supportAt(idx, 5, 0, 0.05);
    let t = 0;
    let bonk = false;
    for (let i = 0; i < 240; i++) if (stepPlayer(p, { speed: 6, x: 0, duck: false }, idx, DT, (t += DT), cfg).bonk) bonk = true;
    expect(bonk).toBe(true);
    expect(p.s).toBeCloseTo(10 - R, 3);
    expect(p.vs).toBe(0);
    // Up onto the 1.6 m block with a big jump, then the 0.4 m rise is mantled while running.
    requestJump(p, t, t, cfg, idx);
    requestBig(p, t, t, cfg);
    for (let i = 0; i < 400; i++) stepPlayer(p, { speed: 6, x: 0, duck: false }, idx, DT, (t += DT), cfg);
    expect(p.grounded).toBe(true);
    expect(p.y).toBeCloseTo(2.0, 3);
  });

  it('lands on tops, falls off edges, bumps ceilings', () => {
    const block = box(4.5, 5.5, 3.45, 'mystery', -0.5, 0.5, 1);
    const idx = indexOf(box(-10, 8, 0), block);
    const p = newPlayer(5, 0);
    p.ground = supportAt(idx, 5, 0, 0.05);
    requestJump(p, 0, 0, cfg, idx);
    let t = 0;
    let bumped = false;
    for (let i = 0; i < 30; i++) {
      const ev = stepPlayer(p, { speed: 0, x: 0, duck: false }, idx, DT, (t += DT), cfg);
      if (ev.ceiling === block) bumped = true;
    }
    expect(bumped).toBe(true);
    expect(p.vy).toBeLessThan(0);
    // Run off the end of the platform and fall.
    for (let i = 0; i < 400; i++) stepPlayer(p, { speed: 6, x: 0, duck: false }, idx, DT, (t += DT), cfg);
    expect(p.grounded).toBe(false);
    expect(p.y).toBeLessThan(-3);
  });

  it('lenient footing near edges, but not beyond', () => {
    const idx = indexOf(box(0, 10, 0));
    expect(supportAt(idx, 10 + FOOT * 0.9, 0, 0.05)).not.toBeNull();
    expect(supportAt(idx, 10 + FOOT * 1.1, 0, 0.05)).toBeNull();
  });

  it('ducking lowers the capsule; standing waits for headroom', () => {
    const idx = indexOf(box(-10, 20, 0), box(4, 6, 2.0, 'stone', -2.4, 2.4, 0.8));
    const p = newPlayer(4.5, 0);
    p.ground = supportAt(idx, 4.5, 0, 0.05);
    p.height = 1.0;
    let t = 0;
    for (let i = 0; i < 30; i++) stepPlayer(p, { speed: 0, x: 0, duck: false }, idx, DT, (t += DT), cfg);
    expect(p.height).toBeLessThanOrEqual(1.2 + 1e-6);
    for (let i = 0; i < 120; i++) stepPlayer(p, { speed: 3, x: 0, duck: false }, idx, DT, (t += DT), cfg);
    expect(p.height).toBeGreaterThan(1.7);
  });

  it('sideways moves are blocked by tall sides and moving platforms carry the player', () => {
    const idx = indexOf(box(-10, 20, 0), box(0, 10, 1.6, 'stone', 0.8, 2.4));
    const p = newPlayer(5, 0);
    p.ground = supportAt(idx, 5, 0, 0.05);
    let t = 0;
    for (let i = 0; i < 120; i++) stepPlayer(p, { speed: 0, x: 1.6, duck: false }, idx, DT, (t += DT), cfg);
    expect(p.x).toBeCloseTo(0.8 - R, 3);
    const mover = box(0, 10, 0, 'mover', -2.4, 2.4, 0.6);
    const idx2 = indexOf(mover);
    const q = newPlayer(5, 0);
    q.ground = mover;
    for (let i = 0; i < 60; i++) {
      mover.dTop = 0.01;
      mover.top += 0.01;
      mover.bottom += 0.01;
      stepPlayer(q, { speed: 0, x: 0, duck: false }, idx2, DT, (t += DT), cfg);
    }
    expect(q.grounded).toBe(true);
    expect(q.y).toBeCloseTo(0.6, 2);
  });
});

// ---- input mapping -------------------------------------------------------------------------------------------

interface Pose {
  lean?: number;
  duck?: number;
  rise?: number;
  lKnee?: number;
  rKnee?: number;
  lWrist?: V2;
  rWrist?: V2;
  rWristZ?: number;
  legs?: boolean;
}

/** Build a camera frame in pixels from body-space parameters (mirrors SimPose.build). */
function frame(t: number, p: Pose): PoseFrame {
  const s = 105;
  const torso = 1.5 * s;
  const cx = 640 + (p.lean ?? 0) * s;
  const cy = 250 + (p.duck ?? 0) * torso - (p.rise ?? 0) * torso;
  const px = (v: V2, z = 0, vis = 0.98): Pt => ({ x: cx + v.x * s, y: cy - v.y * s, z: z * s, v: vis });
  const lm: Pt[] = new Array(33).fill(null).map(() => px({ x: 0, y: 0.8 }));
  const lw = p.lWrist ?? { x: -0.75, y: -1.55 };
  const rw = p.rWrist ?? { x: 0.75, y: -1.55 };
  lm[LM.nose] = px({ x: 0, y: 0.78 });
  lm[LM.lShoulder] = px({ x: -0.5, y: 0 });
  lm[LM.rShoulder] = px({ x: 0.5, y: 0 });
  lm[LM.lElbow] = px({ x: -0.6, y: -0.8 });
  lm[LM.rElbow] = px({ x: 0.6, y: -0.8 });
  lm[LM.lWrist] = px(lw);
  lm[LM.rWrist] = px(rw, p.rWristZ ?? 0);
  lm[LM.lHip] = px({ x: -0.32, y: -1.5 });
  lm[LM.rHip] = px({ x: 0.32, y: -1.5 });
  const legV = p.legs === false ? 0.1 : 0.98;
  lm[LM.lKnee] = px({ x: -0.34, y: -2.7 + (p.lKnee ?? 0) }, 0, legV);
  lm[LM.rKnee] = px({ x: 0.34, y: -2.7 + (p.rKnee ?? 0) }, 0, legV);
  lm[LM.lAnkle] = px({ x: -0.34, y: -3.9 }, 0, legV);
  lm[LM.rAnkle] = px({ x: 0.34, y: -3.9 }, 0, legV);
  return { t, lm, w: 1280, h: 720 };
}

function tracker(): BodyTracker {
  const bt = new BodyTracker();
  bt.calibrate(frame(0, {}));
  return bt;
}

function feedAll(m: InputMapper, bt: BodyTracker, from: number, to: number, pose: (t: number) => Pose, hz = 30): Body[] {
  const out: Body[] = [];
  for (let t = from; t <= to; t += 1000 / hz) {
    const b = bt.measure(frame(t, pose(t)));
    m.feed(b);
    out.push(b);
  }
  return out;
}

describe('input mapping from detectors', () => {
  it('running on the spot sets a speed; standing still stops', () => {
    const m = new InputMapper();
    const bt = tracker();
    feedAll(m, bt, 0, 3000, (t) => {
      const ph = (t / 1000) * Math.PI * 3;
      return { lKnee: Math.max(0, Math.sin(ph)) * 0.6, rKnee: Math.max(0, -Math.sin(ph)) * 0.6 };
    });
    const steps = m.drain().filter((i) => i.type === 'step').length;
    expect(steps).toBeGreaterThan(6);
    expect(m.speed(3000, 6.6, 5.2, false)).toBeGreaterThan(4);
    feedAll(m, bt, 3033, 4500, () => ({}));
    expect(m.speed(4500, 6.6, 5.2, false)).toBe(0);
    expect(m.speed(4500, 6.6, 5.2, true)).toBe(5.2);
  });

  it('legs out of view switches to auto-run after a moment', () => {
    const m = new InputMapper();
    const bt = tracker();
    feedAll(m, bt, 0, 600, () => ({ legs: false }));
    expect(m.legs).toBe(true);
    feedAll(m, bt, 633, 2000, () => ({ legs: false }));
    expect(m.legs).toBe(false);
    expect(m.speed(2000, 6.6, 5.2, false)).toBe(5.2);
  });

  it('lean maps to lanes with hysteresis', () => {
    const m = new InputMapper();
    const bt = tracker();
    feedAll(m, bt, 0, 500, () => ({ lean: 0.8 }));
    expect(m.lane).toBe(1);
    feedAll(m, bt, 533, 900, () => ({ lean: 0.3 }));
    expect(m.lane).toBe(1);
    feedAll(m, bt, 933, 1400, () => ({ lean: 0 }));
    expect(m.lane).toBe(0);
    feedAll(m, bt, 1433, 1900, () => ({ lean: -0.8 }));
    expect(m.lane).toBe(-1);
  });

  const hop = (peak: number, dur: number) => (t: number): Pose => {
    const k = (t - 500) / dur;
    return { rise: k > 0 && k < 1 ? peak * Math.sin(Math.PI * k) : 0 };
  };

  it('a small hop is a takeoff without a big jump', () => {
    const m = new InputMapper();
    const bt = tracker();
    feedAll(m, bt, 0, 1500, hop(0.16, 380));
    const ev = m.drain().map((i) => i.type);
    expect(ev).toContain('takeoff');
    expect(ev).toContain('land');
    expect(ev).not.toContain('big');
  });

  it('a big jump is a takeoff then a big intent while still in the air', () => {
    const m = new InputMapper();
    const bt = tracker();
    feedAll(m, bt, 0, 1800, hop(0.42, 520));
    const ev = m.drain();
    const types = ev.map((i) => i.type);
    expect(types.indexOf('takeoff')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('big')).toBeGreaterThan(types.indexOf('takeoff'));
    expect(types.indexOf('land')).toBeGreaterThan(types.indexOf('big'));
    const take = ev.find((i) => i.type === 'takeoff')!.t;
    const big = ev.find((i) => i.type === 'big')!.t;
    expect(big - take).toBeLessThan(400);
  });

  it('two quick hops give two takeoffs (the game turns the second into a double jump)', () => {
    const m = new InputMapper();
    const bt = tracker();
    feedAll(m, bt, 0, 2000, (t) => {
      const a = hop(0.16, 330)(t).rise ?? 0;
      const b = hop(0.16, 330)(t - 420).rise ?? 0;
      return { rise: Math.max(a, b) };
    });
    expect(m.drain().filter((i) => i.type === 'takeoff').length).toBe(2);
  });

  it('duck and punches', () => {
    const m = new InputMapper();
    const bt = tracker();
    feedAll(m, bt, 0, 500, () => ({ duck: 0.45 }));
    expect(m.duck).toBe(true);
    feedAll(m, bt, 533, 900, () => ({}));
    expect(m.duck).toBe(false);
    m.drain();
    // Right fist thrust toward the camera.
    feedAll(m, bt, 933, 1500, (t) => (t > 1150 && t < 1350 ? { rWrist: { x: 0.4, y: 0.2 }, rWristZ: -1.8 } : { rWrist: { x: 0.6, y: -0.6 } }));
    const punches = m.drain().filter((i) => i.type === 'punch');
    expect(punches.length).toBe(1);
    expect(punches[0].type === 'punch' && punches[0].hand).toBe(1);
  });
});
