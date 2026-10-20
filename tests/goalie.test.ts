import { describe, expect, it } from 'vitest';
import {
  BALL_R,
  DIFFICULTIES,
  GOAL,
  GLOVE_R,
  KEEPER_Z,
  PENALTY_SPOT,
  RAPID_SPOTS,
  aiKeeper,
  aimFromHand,
  bodyToGoal,
  buildShot,
  deflect,
  goalToBody,
  isGreatSave,
  judgeSave,
  makeRng,
  makeShot,
  nextKicker,
  rankFor,
  savePoints,
  shootoutWinner,
  shotPos,
  shotVel,
  timeAtZ,
  type BodyIn,
  type KeeperPose,
} from '../src/games/goalie/logic';
import type { V2 } from '../src/core/types';

/** A standing body like SimPose's rest pose, with SimPose's elbow model. */
function body(lw: V2, rw: V2, extra: Partial<BodyIn> = {}): BodyIn {
  const elbow = (w: V2, side: number): V2 => ({ x: side * 0.5 + (w.x - side * 0.5) * 0.5, y: w.y * 0.5 - 0.05 });
  return { ok: true, lWrist: lw, rWrist: rw, lElbow: elbow(lw, -1), rElbow: elbow(rw, 1), hip: { x: 0, y: -1.5 }, lean: 0, duck: 0, rise: 0, ...extra };
}

describe('shot trajectory', () => {
  it('crosses the goal line at the target after T seconds', () => {
    const s = buildShot(1, PENALTY_SPOT, { x: 2.8, y: 2.0 }, 1.1, { bend: 0.9, dip: 2 });
    const p = shotPos(s, s.T);
    expect(p.z).toBeCloseTo(0, 6);
    expect(p.x).toBeCloseTo(2.8, 6);
    expect(p.y).toBeCloseTo(2.0, 6);
    expect(timeAtZ(s, 0)).toBeCloseTo(1.1, 6);
    expect(timeAtZ(s, KEEPER_Z)).toBeLessThan(1.1);
  });

  it('bends sideways (Magnus) and slows down (drag)', () => {
    const straight = buildShot(1, PENALTY_SPOT, { x: 2, y: 1 }, 1, { bend: 0 });
    const curl = buildShot(2, PENALTY_SPOT, { x: 2, y: 1 }, 1, { bend: 1.2 });
    // Halfway, a ball bending toward +x is still left of the straight line.
    expect(shotPos(curl, 0.5).x).toBeLessThan(shotPos(straight, 0.5).x - 0.2);
    expect(Math.abs(shotVel(curl, 1).z)).toBeLessThan(Math.abs(shotVel(curl, 0).z));
  });

  it('never dips below the ground on the way', () => {
    const rng = makeRng(7);
    for (const d of DIFFICULTIES) {
      for (let i = 0; i < 200; i++) {
        const s = makeShot(rng, d, i / 200, i % 2 ? PENALTY_SPOT : RAPID_SPOTS[i % 3], i);
        for (let t = 0; t <= s.T; t += s.T / 40) expect(shotPos(s, t).y).toBeGreaterThan(BALL_R * 0.9);
        expect(shotPos(s, s.T).z).toBeCloseTo(0, 5);
      }
    }
  });

  it('is deterministic for a seed', () => {
    const a = makeShot(makeRng(42), 'hard', 0.5);
    const b = makeShot(makeRng(42), 'hard', 0.5);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('gets faster and closer to the corners over a session and with difficulty', () => {
    const avg = (d: (typeof DIFFICULTIES)[number], p: number) => {
      const rng = makeRng(3);
      let T = 0;
      let corner = 0;
      const n = 400;
      for (let i = 0; i < n; i++) {
        const s = makeShot(rng, d, p);
        if (s.kind === 'chip') continue;
        T += s.T;
        corner += Math.abs(s.target.x);
      }
      return { T: T / n, corner: corner / n };
    };
    expect(avg('normal', 1).T).toBeLessThan(avg('normal', 0).T);
    expect(avg('normal', 1).corner).toBeGreaterThan(avg('normal', 0).corner);
    expect(avg('hard', 0.5).T).toBeLessThan(avg('easy', 0.5).T);
    expect(avg('hard', 0.5).corner).toBeGreaterThan(avg('easy', 0.5).corner);
  });

  it('mostly hits the target, sometimes misses or hits the woodwork', () => {
    const rng = makeRng(11);
    let on = 0;
    let wood = 0;
    const n = 1000;
    for (let i = 0; i < n; i++) {
      const s = makeShot(rng, 'normal', 0.5);
      if (s.onTarget) on++;
      if (s.wood) wood++;
    }
    expect(on / n).toBeGreaterThan(0.85);
    expect(on / n).toBeLessThan(0.99);
    expect(wood).toBeGreaterThan(5);
  });

  it('gives away the side with the body angle on easy, not reliably on hard', () => {
    const honest = (d: (typeof DIFFICULTIES)[number]) => {
      const rng = makeRng(5);
      let ok = 0;
      let n = 0;
      for (let i = 0; i < 600; i++) {
        const s = makeShot(rng, d, 0.6);
        if (Math.abs(s.target.x) < 1 || !s.onTarget) continue;
        n++;
        if (Math.sign(s.tellYaw) === Math.sign(s.target.x)) ok++;
      }
      return ok / n;
    };
    expect(honest('easy')).toBeGreaterThan(0.9);
    expect(honest('hard')).toBeLessThan(0.8);
  });
});

describe('body → goal mapping', () => {
  it('puts a standing keeper in the middle with hands at waist height', () => {
    const k = bodyToGoal(body({ x: -0.75, y: -1.55 }, { x: 0.75, y: -1.55 }));
    expect(Math.abs(k.sh.x)).toBeLessThan(1e-9);
    expect(k.l.x).toBeLessThan(0);
    expect(k.r.x).toBeGreaterThan(0);
    expect(k.l.y).toBeGreaterThan(0.5);
    expect(k.l.y).toBeLessThan(1.1);
  });

  it('a ~1 m step plus an outstretched arm reaches the post', () => {
    // 1 m ≈ 2.5 shoulder widths.
    const k = bodyToGoal(body({ x: -0.6, y: -1.2 }, { x: 2.0, y: 0.1 }, { lean: 2.5 }));
    expect(k.r.x + GLOVE_R).toBeGreaterThan(GOAL.halfW);
    const m = bodyToGoal(body({ x: -2.0, y: 0.1 }, { x: 0.6, y: -1.2 }, { lean: -2.5 }));
    expect(m.l.x - GLOVE_R).toBeLessThan(-GOAL.halfW);
  });

  it('raising the hands reaches the crossbar and ducking reaches the ground', () => {
    const up = bodyToGoal(body({ x: -0.3, y: 1.9 }, { x: 0.3, y: 1.9 }));
    expect(up.l.y + GLOVE_R).toBeGreaterThan(GOAL.h);
    const jump = bodyToGoal(body({ x: -0.3, y: 1.7 }, { x: 0.3, y: 1.7 }, { rise: 0.25 }));
    expect(jump.l.y).toBeGreaterThan(up.l.y - 0.1);
    const low = bodyToGoal(body({ x: -0.6, y: -2.0 }, { x: 0.6, y: -2.0 }, { duck: 0.6 }));
    expect(low.l.y - GLOVE_R).toBeLessThan(BALL_R);
  });

  it('is mirror symmetric', () => {
    const a = bodyToGoal(body({ x: -1.2, y: 0.4 }, { x: 0.9, y: -0.2 }, { lean: 1.1 }));
    const b = bodyToGoal(body({ x: -0.9, y: -0.2 }, { x: 1.2, y: 0.4 }, { lean: -1.1 }));
    expect(a.l.x).toBeCloseTo(-b.r.x, 9);
    expect(a.l.y).toBeCloseTo(b.r.y, 9);
  });

  it('the bot inverse puts the gloves where it wants them', () => {
    const targets: [V2, V2][] = [
      [{ x: 2.9, y: 2.1 }, { x: 3.2, y: 2.0 }],
      [{ x: -3.3, y: 0.25 }, { x: -3.0, y: 0.2 }],
      [{ x: -0.2, y: 1.2 }, { x: 0.2, y: 1.2 }],
      [{ x: 1.4, y: 0.6 }, { x: 1.7, y: 0.65 }],
    ];
    for (const [l, r] of targets) {
      const p = goalToBody(l, r);
      const k = bodyToGoal(body(p.lWrist, p.rWrist, { lean: p.lean, duck: p.duck, rise: p.rise }));
      expect(Math.hypot(k.l.x - l.x, k.l.y - l.y)).toBeLessThan(0.03);
      expect(Math.hypot(k.r.x - r.x, k.r.y - r.y)).toBeLessThan(0.03);
    }
  });
});

describe('save judging', () => {
  const pose = (l: V2, r: V2, sh: V2 = { x: 0, y: 1.5 }): KeeperPose => ({
    ok: true,
    l,
    r,
    lElbow: { x: (l.x + sh.x) / 2, y: (l.y + sh.y) / 2 },
    rElbow: { x: (r.x + sh.x) / 2, y: (r.y + sh.y) / 2 },
    sh,
    hip: { x: sh.x, y: sh.y - 0.7 },
    head: { x: sh.x, y: sh.y + 0.3 },
    lFoot: { x: sh.x - 0.28, y: 0.05 },
    rFoot: { x: sh.x + 0.28, y: 0.05 },
  });

  it('catches a ball between both gloves', () => {
    const c = judgeSave(pose({ x: 1.85, y: 1.6 }, { x: 2.15, y: 1.6 }, { x: 1.9, y: 1.4 }), { x: 2.0, y: 1.65 });
    expect(c.kind).toBe('catch');
    expect(c.hand).toBe('both');
  });

  it('parries with one glove and tips with the fingertips', () => {
    const k = pose({ x: -0.8, y: 0.8 }, { x: 2.9, y: 2.0 }, { x: 1.6, y: 1.5 });
    const parry = judgeSave(k, { x: 3.0, y: 2.05 });
    expect(parry.kind).toBe('parry');
    expect(parry.hand).toBe('r');
    const tip = judgeSave(k, { x: 2.9 + 0.3, y: 2.0 + 0.1 });
    expect(tip.kind).toBe('tip');
  });

  it('uses the generous radius (ball radius + 25 cm) and no more', () => {
    const k = pose({ x: -3, y: 1 }, { x: -2.6, y: 1 }, { x: -2.4, y: 1.4 });
    expect(judgeSave(k, { x: 2.6 + 0.0, y: 1 }).kind).toBe('none');
    expect(judgeSave(k, { x: -2.6 + GLOVE_R - 0.01 - 0.0, y: 1 }).kind).not.toBe('none');
    expect(judgeSave(pose({ x: -3, y: 1 }, { x: -2.2, y: 2.3 }, { x: -2.6, y: 1.5 }), { x: -2.2, y: 2.3 + GLOVE_R + 0.02 }).kind).toBe('none');
  });

  it('blocks with the body', () => {
    const k = pose({ x: -1.5, y: 2.2 }, { x: 1.5, y: 2.2 });
    const c = judgeSave(k, { x: 0.1, y: 1.1 });
    expect(c.kind).toBe('block');
    expect(judgeSave(k, { x: 0.15, y: 0.25 }).kind).toBe('block'); // legs
  });

  it('flags top-corner saves as great saves', () => {
    const k = pose({ x: 1, y: 1 }, { x: 3.2, y: 2.15 }, { x: 1.3, y: 1.5 });
    const ball = { x: 3.25, y: 2.1 };
    const c = judgeSave(k, ball);
    expect(c.kind).not.toBe('none');
    expect(isGreatSave(c, ball, k)).toBe(true);
    const easy = pose({ x: -0.15, y: 1.2 }, { x: 0.15, y: 1.2 });
    expect(isGreatSave(judgeSave(easy, { x: 0, y: 1.2 }), { x: 0, y: 1.2 }, easy)).toBe(false);
  });

  it('deflects tipped balls over the bar and parries back out', () => {
    const rng = makeRng(1);
    const v = { x: 1, y: 0.5, z: 14 };
    const tip = deflect({ kind: 'tip', hand: 'r', dist: 0.3, n: { x: 0.2, y: 0.9 } }, { x: 2.5, y: 2.2, z: KEEPER_Z }, v, rng);
    expect(tip.y).toBeGreaterThan(3);
    const parry = deflect({ kind: 'parry', hand: 'l', dist: 0.1, n: { x: -0.7, y: 0.3 } }, { x: -2, y: 1, z: KEEPER_Z }, v, rng);
    expect(parry.z).toBeLessThan(0);
    const caught = deflect({ kind: 'catch', hand: 'both', dist: 0.05, n: { x: 0, y: 1 } }, { x: 0, y: 1, z: KEEPER_Z }, v, rng);
    expect(Math.hypot(caught.x, caught.y, caught.z)).toBe(0);
  });
});

describe('shootout and scoring', () => {
  it('ends early when one side cannot catch up', () => {
    expect(shootoutWinner([true, true, true], [false, false, false])).toBe('home');
    expect(shootoutWinner([true, true], [false, false, false])).toBe(null);
    expect(shootoutWinner([false, false, false], [true, true, true, true])).toBe('away');
    expect(shootoutWinner([true, true, true, true, true], [true, true, true, true, true])).toBe(null);
  });

  it('goes to sudden death after five each', () => {
    const five = [true, false, true, true, false];
    expect(shootoutWinner([...five, true], [...five, true])).toBe(null);
    expect(shootoutWinner([...five], [...five, true])).toBe(null);
    expect(shootoutWinner([...five, false], [...five, true])).toBe('away');
    expect(shootoutWinner([...five, true, true], [...five, true, false])).toBe('home');
  });

  it('alternates kickers, away first', () => {
    expect(nextKicker([], [])).toBe('away');
    expect(nextKicker([], [true])).toBe('home');
    expect(nextKicker([true], [true])).toBe('away');
  });

  it('AI keeper saves central shots more than corners', () => {
    const rng = makeRng(9);
    let centre = 0;
    let corner = 0;
    for (let i = 0; i < 2000; i++) {
      if (aiKeeper({ x: 0.3, y: 1.0 }, 'normal', rng).saved) centre++;
      if (aiKeeper({ x: 3.2, y: 2.1 }, 'normal', rng).saved) corner++;
    }
    expect(centre).toBeGreaterThan(corner * 2);
    expect(aiKeeper({ x: 5, y: 1 }, 'hard', rng).saved).toBe(false);
  });

  it('maps a pointing hand to the goal', () => {
    const a = aimFromHand({ x: 1.9, y: 1.8 }, 0);
    expect(a.x).toBeCloseTo(GOAL.halfW, 1);
    expect(a.y).toBeCloseTo(GOAL.h, 1);
    expect(aimFromHand({ x: 0, y: -0.4 }, 0).x).toBe(0);
  });

  it('rewards streaks and great saves, ranks by save percentage', () => {
    expect(savePoints('parry', false, 1)).toBe(100);
    expect(savePoints('parry', false, 5)).toBeGreaterThan(savePoints('parry', false, 1));
    expect(savePoints('tip', true, 1)).toBeGreaterThan(savePoints('tip', false, 1));
    expect(rankFor(0.95, 'rapid').badge).toBe('S');
    expect(rankFor(0.95, 'rapid').stars).toBe(3);
    expect(rankFor(0.2, 'rapid').stars).toBe(0);
    expect(rankFor(0.5, 'shootout', true).stars).toBeGreaterThanOrEqual(1);
    expect(rankFor(0.9, 'shootout', false).stars).toBeLessThanOrEqual(1);
  });
});
