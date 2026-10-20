import { describe, expect, it } from 'vitest';
import { Rng } from '../src/games/bat/rng';
import { launchVector, azimuthOf } from '../src/games/bat/physics';
import {
  BASEBALL_GEOM,
  CRICKET_GEOM,
  DIFFICULTIES,
  buildCricket,
  buildPitch,
  planCricket,
  planPitch,
  sampleAt,
  type CricketSpec,
  type PitchSpec,
} from '../src/games/bat/delivery';
import { SwingTracker, gripForHeight, judge, shotFrom, swingHeight, cricketShotName, type Swing } from '../src/games/bat/contact';
import { RUN_TIMES, baseballField, cricketField, resolveBaseball, resolveCricket, simulateHit, type Fielder } from '../src/games/bat/outcome';
import { BaseballGame, CricketMatch } from '../src/games/bat/rules';

/** Rng whose rolls always come out the same (to force catches / drops). */
class FixedRng extends Rng {
  constructor(private v: number) {
    super(1);
  }
  next(): number {
    return this.v;
  }
}

const pace = (o: Partial<CricketSpec> = {}): CricketSpec => ({
  kind: 'pace',
  speedKmh: 135,
  bounceX: 0.05,
  bounceZ: -4.5,
  swing: 0,
  kick: 0,
  release: { x: 0.34, y: 2.2, z: CRICKET_GEOM.bowlerCreaseZ + 0.45 },
  e: 0.56,
  keep: 0.93,
  ...o,
});

const pitchSpec = (o: Partial<PitchSpec> = {}): PitchSpec => ({
  kind: 'fastball',
  speedKmh: 148,
  targetX: 0,
  targetY: 0.8,
  breakX: -1.8,
  breakY: 4.6,
  release: { x: -0.52, y: 1.82, z: BASEBALL_GEOM.rubberZ + 1.6 },
  ...o,
});

describe('cricket deliveries', () => {
  it('pitches exactly where the bowler aims', () => {
    for (const bz of [-1.5, -4, -7, -10]) {
      const d = buildCricket(pace({ bounceZ: bz, bounceX: 0.1 }));
      expect(d.bounce).not.toBeNull();
      expect(Math.abs(d.bounce!.p.z - bz)).toBeLessThan(0.03);
      expect(Math.abs(d.bounce!.p.x - 0.1)).toBeLessThan(0.03);
    }
  });
  it('yorkers arrive at the toes, bouncers at the head', () => {
    const y = buildCricket(pace({ kind: 'yorker', bounceZ: 0.0, speedKmh: 140 }));
    expect(y.arrive.p.y).toBeLessThan(0.25);
    const b = buildCricket(pace({ kind: 'bouncer', bounceZ: -10.8, e: 0.62, speedKmh: 140 }));
    expect(b.arrive.p.y).toBeGreaterThan(1.2);
    expect(b.note).toBe('Bouncer');
    expect(y.note).toBe('Yorker');
  });
  it('swing curves in the air, spin turns off the pitch', () => {
    const out = buildCricket(pace({ kind: 'outswing', swing: 3 }));
    expect(out.bounce!.v.x - out.v0.x).toBeGreaterThan(0.6);
    const off = buildCricket(pace({ kind: 'offspin', speedKmh: 85, kick: -2, e: 0.5, keep: 0.86 }));
    const before = off.bounce!.v.x;
    const after = sampleAt(off, off.bounce!.t + 0.02).v.x;
    expect(after - before).toBeLessThan(-1.5);
  });
  it('knows when a left ball would hit the stumps', () => {
    const straight = buildCricket(pace({ bounceX: 0.0, bounceZ: -3.5, release: { x: 0.0, y: 2.2, z: -17.2 } }));
    expect(straight.onTarget).toBe(true);
    const wide = buildCricket(pace({ bounceX: 0.6, bounceZ: -3.5 }));
    expect(wide.onTarget).toBe(false);
    const over = buildCricket(pace({ kind: 'bouncer', bounceZ: -10.8, e: 0.62 }));
    expect(over.onTarget).toBe(false);
  });
  it('mirrors for left-handers', () => {
    const r = buildCricket(pace({ bounceX: 0.2 }), 1);
    const l = buildCricket(pace({ bounceX: 0.2 }), -1);
    expect(l.arrive.p.x).toBeCloseTo(-r.arrive.p.x, 5);
    expect(l.arrive.t).toBeCloseTo(r.arrive.t, 6);
  });
  it('plans sensible deliveries on every difficulty', () => {
    const rng = new Rng(42);
    for (const diff of DIFFICULTIES) {
      for (let i = 0; i < 30; i++) {
        const d = planCricket(rng, diff, 1, i === 0);
        expect(d.arrive.t).toBeGreaterThan(0.35);
        expect(d.arrive.t).toBeLessThan(1.1);
        expect(d.arrive.p.y).toBeGreaterThan(0);
        expect(d.arrive.p.y).toBeLessThan(2.4);
        expect(Math.abs(d.arrive.p.x)).toBeLessThan(1.3);
      }
    }
    const easy = Array.from({ length: 40 }, () => planCricket(rng, 'easy', 1).speedKmh);
    const hard = Array.from({ length: 40 }, () => planCricket(rng, 'hard', 1).speedKmh);
    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    expect(avg(hard)).toBeGreaterThan(avg(easy) + 8);
  });
  it('first ball is a gentle straight one', () => {
    const d = planCricket(new Rng(3), 'normal', 1, true);
    expect(d.kind).toBe('pace');
    expect(d.speedKmh).toBeLessThan(130);
  });
});

describe('baseball pitches', () => {
  it('crosses the plate where the pitcher aims', () => {
    for (const [x, y] of [
      [0, 0.8],
      [0.2, 0.5],
      [-0.3, 1.2],
    ]) {
      const d = buildPitch(pitchSpec({ targetX: x, targetY: y }));
      expect(Math.abs(d.cross.p.x - x)).toBeLessThan(0.02);
      expect(Math.abs(d.cross.p.y - y)).toBeLessThan(0.02);
    }
  });
  it('fastballs ride, curveballs drop', () => {
    const fb = buildPitch(pitchSpec());
    const cb = buildPitch(pitchSpec({ kind: 'curveball', speedKmh: 124, breakX: 2.6, breakY: -3.8 }));
    // To reach the same spot the curve must be thrown upward, the fastball on a flatter line.
    expect(cb.v0.y).toBeGreaterThan(fb.v0.y + 1);
    expect(cb.arrive.t).toBeGreaterThan(fb.arrive.t);
  });
  it('calls balls and strikes', () => {
    expect(buildPitch(pitchSpec({ targetX: 0, targetY: 0.75 })).onTarget).toBe(true);
    expect(buildPitch(pitchSpec({ targetX: 0.42, targetY: 0.75 })).onTarget).toBe(false);
    expect(buildPitch(pitchSpec({ targetX: 0, targetY: 1.3 })).onTarget).toBe(false);
  });
  it('plans pitches in the right speed bands', () => {
    const rng = new Rng(9);
    for (const diff of DIFFICULTIES) {
      for (let i = 0; i < 20; i++) {
        const d = planPitch(rng, diff, 1, { balls: 0, strikes: 0 });
        expect(d.arrive.t).toBeGreaterThan(0.33);
        expect(d.arrive.t).toBeLessThan(0.75);
      }
    }
  });
});

describe('swing detection', () => {
  /** Feed a sampled sweep (right to left if dir = 1) peaking at tPeak (ms). */
  function sweep(tr: SwingTracker, tPeak: number, dir: 1 | -1, y: number, hz = 30, tau = 0.03): Swing | null {
    let got: Swing | null = null;
    for (let t = tPeak - 600; t < tPeak + 500; t += 1000 / hz) {
      const s = 1 / (1 + Math.exp(-((t - tPeak) / 1000) / tau));
      const x = dir * (1.0 - 2.1 * s);
      const r = tr.update(t, { x, y: y + 0.6 * (2 * s - 1) ** 2 });
      if (r) got = r;
    }
    return got;
  }
  it('finds a right-to-left sweep at its peak speed', () => {
    const s = sweep(new SwingTracker(), 5000, 1, -1.2);
    expect(s).not.toBeNull();
    expect(s!.dir).toBe(1);
    expect(Math.abs(s!.t - 5000)).toBeLessThan(18);
    expect(Math.abs(s!.gripY + 1.2)).toBeLessThan(0.1);
    expect(s!.speed).toBeGreaterThan(10);
  });
  it('tells a left-handed sweep apart and copes with a low frame rate', () => {
    const s = sweep(new SwingTracker(), 3000, -1, -0.8, 20);
    expect(s!.dir).toBe(-1);
    expect(Math.abs(s!.t - 3000)).toBeLessThan(30);
  });
  it('ignores slow hand movement', () => {
    const tr = new SwingTracker();
    let got: Swing | null = null;
    for (let t = 0; t < 2000; t += 33) got = tr.update(t, { x: Math.sin(t / 400) * 0.6, y: -1 }) ?? got;
    expect(got).toBeNull();
  });
  it('maps grip height to bat height and back', () => {
    for (const h of [0.2, 0.6, 1.1, 1.6]) expect(swingHeight(gripForHeight(h))).toBeCloseTo(h, 5);
  });
});

describe('contact judging', () => {
  const at = (ms: number, h: number, speed = 15, dir: 1 | -1 = 1, up = 0): Swing => ({ t: 1000 + ms, speed, dir, gripY: gripForHeight(h), up, travel: 2 });
  const ball = { p: { x: 0.05, y: 0.6, z: -0.5 }, v: { x: 0, y: -2, z: 33 } };
  it('grades timing windows', () => {
    expect(judge(at(0, 0.6), 1000, 0.6, 'normal').grade).toBe('perfect');
    expect(judge(at(-90, 0.6), 1000, 0.6, 'normal').grade).toBe('good');
    expect(judge(at(-90, 0.6), 1000, 0.6, 'normal').timing).toBe('early');
    expect(judge(at(180, 0.6), 1000, 0.6, 'normal').grade).toBe('edge');
    expect(judge(at(180, 0.6), 1000, 0.6, 'normal').timing).toBe('late');
    expect(judge(at(300, 0.6), 1000, 0.6, 'normal').hit).toBe(false);
    // Easy is more forgiving than hard.
    expect(judge(at(135, 0.6), 1000, 0.6, 'easy').grade).toBe('good');
    expect(judge(at(110, 0.6), 1000, 0.6, 'hard').grade).toBe('edge');
  });
  it('grades swing height against ball height', () => {
    expect(judge(at(0, 0.6), 1000, 0.6, 'normal').vert).toBe('middle');
    expect(judge(at(0, 1.1), 1000, 0.6, 'normal').vert).toBe('over');
    expect(judge(at(0, 0.85), 1000, 0.6, 'normal').vert).toBe('ground');
    expect(judge(at(0, 0.4), 1000, 0.6, 'normal').vert).toBe('lofted');
    expect(judge(at(0, 0.25), 1000, 0.6, 'normal').vert).toBe('topEdge');
    expect(judge(at(0, 0.0), 1000, 0.6, 'normal').hit).toBe(false);
    expect(judge(at(0, 0.6), 1000, 0.6, 'normal').sweet).toBe(true);
    expect(judge(at(0, 0.6, 6), 1000, 0.6, 'normal').sweet).toBe(false);
  });
  it('early pulls to the leg side, late goes to the off side, on time goes straight', () => {
    const rng = new Rng(1);
    const shot = (ms: number, dir: 1 | -1 = 1) => shotFrom(judge(at(ms, 0.6, 15, dir), 1000, 0.6, 'normal'), at(ms, 0.6, 15, dir), { ...ball, p: { ...ball.p, x: 0 } }, 'cricket', 'normal', rng);
    expect(shot(-100).azimuth).toBeLessThan(-25);
    expect(shot(100).azimuth).toBeGreaterThan(25);
    expect(Math.abs(shot(0).azimuth)).toBeLessThan(15);
    expect(shot(-100, -1).azimuth).toBeGreaterThan(25);
    expect(shot(170).azimuth).toBeGreaterThan(64);
    expect(cricketShotName(shot(-100), 1)).toMatch(/mid-wicket|On drive|Pull|Flick/);
  });
  it('height decides along the ground or in the air, speed decides power', () => {
    const rng = new Rng(2);
    const s = (h: number, speed = 15, up = 0) => shotFrom(judge(at(0, h, speed, 1, up), 1000, 0.6, 'normal'), at(0, h, speed, 1, up), ball, 'cricket', 'normal', rng);
    expect(s(0.85).launch).toBeLessThan(10);
    expect(s(0.4).launch).toBeGreaterThan(30);
    expect(s(0.6, 15, 0.6).launch).toBeGreaterThan(s(0.6, 15, -0.4).launch);
    expect(s(0.6, 16).speed).toBeGreaterThan(s(0.6, 6).speed + 8);
  });
});

describe('hits, fielding and boundaries', () => {
  const from = { x: 0, y: 0.6, z: -0.5 };
  it('a well struck lofted drive clears the rope', () => {
    const tr = simulateHit('cricket', from, launchVector(42, 30, 5));
    expect(tr.overAir).toBe(true);
    expect(tr.carry).toBeGreaterThan(80);
    const o = resolveCricket(tr, cricketField('death', 1), new Rng(5), false);
    expect(o.result).toBe('six');
    expect(o.runs).toBe(6);
  });
  it('a firm drive into an empty field runs away for four', () => {
    const tr = simulateHit('cricket', from, launchVector(28, 2, 40));
    expect(tr.overGround).toBe(true);
    const lonely: Fielder[] = [{ name: 'keeper', x: 0, z: 13, speed: 5, react: 0.3, reach: 1.5, hands: 0.9, deep: false, role: 'keeper' }];
    expect(resolveCricket(tr, lonely, new Rng(1), false).result).toBe('four');
  });
  it('a soft push dies in the infield', () => {
    const tr = simulateHit('cricket', from, launchVector(9, 0, 20));
    expect(tr.overGround).toBe(false);
    expect(tr.overAir).toBe(false);
  });
  it('a skier to a fielder is caught (or dropped on a bad day)', () => {
    const f: Fielder[] = [{ name: 'long-on', x: -12, z: -45, speed: 7, react: 0.4, reach: 1.5, hands: 0.9, deep: true, role: 'fielder' }];
    // Aim the skier at the fielder.
    const az = azimuthOf(-12, -45);
    const tr = simulateHit('cricket', from, launchVector(25, 55, az));
    const caught = resolveCricket(tr, f, new FixedRng(0.01), false);
    expect(caught.result).toBe('caught');
    expect(caught.label).toContain('long-on');
    const dropped = resolveCricket(tr, f, new FixedRng(0.999), false);
    expect(dropped.result).toBe('runs');
  });
  it('runs come from how long the ball takes to get back', () => {
    const f: Fielder[] = [{ name: 'deep cover', x: 40, z: -50, speed: 7, react: 0.4, reach: 1.5, hands: 0.9, deep: true, role: 'fielder' }];
    const tr = simulateHit('cricket', from, launchVector(24, 8, 40));
    const o = resolveCricket(tr, f, new FixedRng(0.5), false);
    if (o.result === 'runs') {
      expect(o.runs).toBeGreaterThanOrEqual(1);
      expect(RUN_TIMES[o.runs - 1]).toBeLessThan(o.returnT);
    } else expect(o.result).toBe('four');
  });
  it('baseball: home runs, fouls and ground outs', () => {
    const f = baseballField();
    const hr = simulateHit('baseball', from, launchVector(48, 28, 5));
    expect(resolveBaseball(hr, f, new Rng(1), 28).result).toBe('hr');
    const foul = simulateHit('baseball', from, launchVector(35, 20, 70));
    expect(resolveBaseball(foul, f, new FixedRng(0.99), 20).result).toBe('foul');
    const grounder = simulateHit('baseball', from, launchVector(24, -4, azimuthOf(-10, -33.5)));
    const g = resolveBaseball(grounder, f, new FixedRng(0.5), -4);
    expect(g.result).toBe('out');
    expect(g.outKind).toBe('ground');
  });
});

describe('scoring rules', () => {
  it('chase: win, lose on wickets, lose on balls', () => {
    const win = new CricketMatch('chase', 'normal');
    expect(win.target).toBe(20);
    for (let i = 0; i < 3; i++) win.record({ event: 'six', runs: 6, distance: 80 });
    expect(win.done).toBe(false);
    win.record({ event: 'runs', runs: 2, distance: 30 });
    expect(win.done && win.won).toBe(true);
    expect(win.stars()).toBe(3);
    expect(win.history.join('')).toBe('6662');
    const out = new CricketMatch('chase', 'normal');
    out.record({ event: 'bowled', runs: 0, distance: 0 });
    out.record({ event: 'caught', runs: 0, distance: 50 });
    expect(out.done && !out.won).toBe(true);
    const slow = new CricketMatch('chase', 'normal');
    for (let i = 0; i < 12; i++) slow.record({ event: 'runs', runs: 1, distance: 20 });
    expect(slow.done && !slow.won).toBe(true);
    expect(slow.overs).toBe('2.0');
    expect(slow.strikeRate).toBe(100);
  });
  it('six hitting adds up the distance of the sixes', () => {
    const m = new CricketMatch('sixes', 'normal');
    m.record({ event: 'six', runs: 6, distance: 82 });
    m.record({ event: 'four', runs: 4, distance: 60 });
    m.record({ event: 'six', runs: 6, distance: 95 });
    m.record({ event: 'caught', runs: 0, distance: 70 });
    expect(m.sixes).toBe(2);
    expect(m.score()).toBe(177);
    expect(m.longest).toBe(95);
    for (let i = 0; i < 8; i++) m.record({ event: 'dot', runs: 0, distance: 0 });
    expect(m.done).toBe(true);
  });
  it('inning: count, walks, strikeouts, fouls, grand slam, sac fly', () => {
    const g = new BaseballGame('inning', 'normal');
    for (let i = 0; i < 4; i++) g.record({ kind: 'take', strike: false });
    expect(g.bases).toEqual([true, false, false]);
    expect(g.walks).toBe(1);
    g.record({ kind: 'take', strike: true });
    g.record({ kind: 'miss' });
    g.record({ kind: 'foul' });
    expect(g.strikes).toBe(2);
    const k = g.record({ kind: 'miss' });
    expect(k.out && g.outs === 1).toBe(true);
    g.record({ kind: 'inplay', result: 'single', distance: 40 });
    expect(g.bases).toEqual([true, true, false]);
    const single = g.record({ kind: 'inplay', result: 'single', distance: 40 });
    expect(single.runs).toBe(1); // runner from second scores
    g.record({ kind: 'inplay', result: 'double', distance: 80 });
    expect(g.runs).toBe(2);
    expect(g.bases).toEqual([false, true, true]);
    const sac = g.record({ kind: 'inplay', result: 'out', distance: 85, outKind: 'fly', deep: true });
    expect(sac.runs).toBe(1);
    expect(g.outs).toBe(2);
    g.bases = [true, true, true];
    const slam = g.record({ kind: 'inplay', result: 'hr', distance: 120 });
    expect(slam.runs).toBe(4);
    expect(slam.call).toBe('Grand slam!');
    expect(g.runs).toBe(7);
    g.record({ kind: 'inplay', result: 'out', distance: 30, outKind: 'ground' });
    expect(g.done).toBe(true);
  });
  it('derby: only home runs survive', () => {
    const g = new BaseballGame('derby', 'normal');
    g.record({ kind: 'inplay', result: 'hr', distance: 121 });
    g.record({ kind: 'take', strike: false });
    expect(g.outs).toBe(0);
    g.record({ kind: 'foul' });
    g.record({ kind: 'miss' });
    g.record({ kind: 'take', strike: true });
    g.record({ kind: 'inplay', result: 'double', distance: 100 });
    expect(g.outs).toBe(4);
    expect(g.hrs).toBe(1);
    for (let i = 0; i < 6; i++) g.record({ kind: 'miss' });
    expect(g.done).toBe(true);
    expect(g.longest).toBe(121);
  });
});

describe('demo bot', () => {
  it('swings so the tracker sees the planned timing and height', async () => {
    const { SimPose } = await import('../src/core/pose');
    const { BodyTracker } = await import('../src/core/body');
    const { Bot } = await import('../src/games/bat/bot');
    const rng = new Rng(11);
    let good = 0;
    for (let i = 0; i < 12; i++) {
      const d = planCricket(rng, 'normal', 1);
      const bot = new Bot(1, 'cricket');
      const arr = 10000;
      const plan = bot.decide(d, arr, new FixedRng(0.5), 'chase');
      const body = new BodyTracker();
      body.calibrate({ t: 0, lm: SimPose.build(bot.drive(0)), w: SimPose.W, h: SimPose.H });
      const tr = new SwingTracker();
      let sw: Swing | null = null;
      for (let t = 8000; t < 11500; t += 33.3) {
        const b = body.measure({ t, lm: SimPose.build(bot.drive(t)), w: SimPose.W, h: SimPose.H });
        const g = { x: (b.lWrist.x + b.rWrist.x) / 2, y: (b.lWrist.y + b.rWrist.y) / 2 };
        sw = tr.update(t, g) ?? sw;
      }
      if (!plan.swing) continue;
      expect(sw).not.toBeNull();
      const j = judge(sw!, arr, d.arrive.p.y, 'normal');
      if (j.hit) good++;
      expect(Math.abs(sw!.t - (arr + plan.errMs))).toBeLessThan(45);
      expect(Math.abs(swingHeight(sw!.gripY) - d.arrive.p.y)).toBeLessThan(0.2);
    }
    expect(good).toBeGreaterThan(5);
  });
});

describe('swing detection edge cases', () => {
  it('a quick wind-up does not hide the real swing that follows', () => {
    const tr = new SwingTracker();
    let got: Swing | null = null;
    // Hands flick right (wind-up, short), then sweep hard right-to-left.
    const path = (t: number) => {
      if (t < 1000) return { x: 0.3, y: -1.2 };
      if (t < 1150) return { x: 0.3 + ((t - 1000) / 150) * 0.6, y: -1.2 + ((t - 1000) / 150) * 1.0 };
      const s = 1 / (1 + Math.exp(-((t - 1350) / 1000) / 0.03));
      return { x: 0.9 - 2.0 * s, y: -0.2 - 1.0 * Math.sin(Math.PI * s) };
    };
    for (let t = 0; t < 2000; t += 33.3) got = tr.update(t, path(t)) ?? got;
    expect(got).not.toBeNull();
    expect(got!.dir).toBe(1);
    expect(Math.abs(got!.t - 1350)).toBeLessThan(40);
    expect(got!.speed).toBeGreaterThan(9);
  });
});

describe('whole-innings simulation (bot through the real pipeline)', () => {
  async function playBall(sport: 'cricket' | 'baseball', mode: string, rng: Rng, count = { balls: 0, strikes: 0 }) {
    const { SimPose } = await import('../src/core/pose');
    const { BodyTracker } = await import('../src/core/body');
    const { Bot } = await import('../src/games/bat/bot');
    const d = sport === 'cricket' ? planCricket(rng, 'normal', 1) : planPitch(rng, 'normal', 1, count);
    const bot = new Bot(1, sport);
    const arr = 10000;
    const plan = bot.decide(d, arr, rng, mode);
    const body = new BodyTracker();
    body.calibrate({ t: 0, lm: SimPose.build(bot.drive(0)), w: SimPose.W, h: SimPose.H });
    const tr = new SwingTracker();
    let sw: Swing | null = null;
    for (let t = 8500; t < 11000; t += 33.3) {
      const b = body.measure({ t, lm: SimPose.build(bot.drive(t)), w: SimPose.W, h: SimPose.H });
      sw = sw ?? tr.update(t, { x: (b.lWrist.x + b.rWrist.x) / 2, y: (b.lWrist.y + b.rWrist.y) / 2 });
    }
    return { d, plan, sw };
  }

  it('cricket: a chase produces the whole range of results', async () => {
    const rng = new Rng(2024);
    const seen = new Set<string>();
    const f = cricketField('death', 1);
    for (let i = 0; i < 160; i++) {
      const { d, sw } = await playBall('cricket', 'chase', rng);
      if (!sw) {
        seen.add(d.onTarget ? 'bowled' : 'leave');
        continue;
      }
      const j = judge(sw, 10000, d.arrive.p.y, 'normal');
      if (!j.hit) {
        seen.add(d.onTarget ? 'bowled' : 'beaten');
        continue;
      }
      const shot = shotFrom(j, sw, d.arrive, 'cricket', 'normal', rng);
      const track = simulateHit('cricket', d.arrive.p, launchVector(shot.speed, shot.launch, shot.azimuth), shot.lift);
      const o = resolveCricket(track, f, rng, shot.edge);
      seen.add(o.result === 'runs' ? (o.runs === 0 ? 'dot' : `${o.runs}`) : o.result);
    }
    for (const k of ['six', 'four', 'caught', 'dot', '1', 'bowled']) expect(seen.has(k), `missing ${k} in ${[...seen].join(',')}`).toBe(true);
  });

  it('baseball: an inning has hits, outs, fouls and called pitches', async () => {
    const rng = new Rng(77);
    const f = baseballField();
    const calls = new Set<string>();
    let guard = 0;
    let g = new BaseballGame('inning', 'normal');
    // Three innings so the mix does not depend on one short inning.
    for (let inn = 0; inn < 3; inn++) {
      g = new BaseballGame('inning', 'normal');
      while (!g.done && guard++ < 900) {
        const { d, sw } = await playBall('baseball', 'inning', rng, { balls: g.balls, strikes: g.strikes });
        if (!sw) {
          const c = g.record({ kind: 'take', strike: d.onTarget });
          calls.add(c.call.split(' ')[0]);
          continue;
        }
        const j = judge(sw, 10000, d.arrive.p.y, 'normal');
        if (!j.hit) {
          calls.add(g.record({ kind: 'miss' }).call.split(' ')[0]);
          continue;
        }
        const shot = shotFrom(j, sw, d.arrive, 'baseball', 'normal', rng);
        const track = simulateHit('baseball', d.arrive.p, launchVector(shot.speed, shot.launch, shot.azimuth), shot.lift);
        const o = resolveBaseball(track, f, rng, shot.launch);
        const ev =
          o.result === 'foul' ? g.record({ kind: 'foul' }) : g.record({ kind: 'inplay', result: o.result, distance: o.distance, outKind: o.outKind, deep: o.deep });
        calls.add(o.result);
        void ev;
      }
    }
    expect(g.done).toBe(true);
    expect(calls.has('out')).toBe(true);
    expect(calls.has('Ball') || calls.has('Walk')).toBe(true);
    expect(calls.has('foul') || calls.has('Strike')).toBe(true);
    expect([...calls].some((c) => ['single', 'double', 'triple', 'hr'].includes(c))).toBe(true);
  });
});
