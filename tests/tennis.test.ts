import { describe, expect, it } from 'vitest';
import { MatchScore, type Side } from '../src/games/tennis/rules';
import {
  BALL_R,
  COURT,
  Flight,
  SURFACES,
  bounce,
  isIn,
  netHeight,
  onLine,
  serviceBox,
  singlesHalf,
  solveShot,
  spinVector,
  type BallState,
} from '../src/games/tennis/physics';
import { classifySwing, judgeTiming, serveFromSwing, shotFromSwing, WINDOWS, MIN_SWING, type SwingFeatures } from '../src/games/tennis/shots';
import { chooseIntercept } from '../src/games/tennis/ai';

const win = (m: MatchScore, s: Side, n = 1) => {
  let o = m.pointWon(s);
  for (let i = 1; i < n; i++) o = m.pointWon(s);
  return o;
};

describe('scoring', () => {
  it('counts 15/30/40/game', () => {
    const m = new MatchScore('short', 0);
    expect(m.pointLabel(0)).toBe('0');
    win(m, 0);
    expect(m.pointLabel(0)).toBe('15');
    expect(m.call(['You', 'Rival'])).toBe('Fifteen love');
    win(m, 1);
    expect(m.call(['You', 'Rival'])).toBe('Fifteen all');
    win(m, 0, 2);
    expect(m.pointLabel(0)).toBe('40');
    const o = win(m, 0);
    expect(o.gameWon).toBe(0);
    expect(m.games).toEqual([1, 0]);
    expect(m.points).toEqual([0, 0]);
    expect(o.serverChanged).toBe(true);
    expect(m.server).toBe(1);
  });

  it('handles deuce and advantage', () => {
    const m = new MatchScore('short', 0);
    win(m, 0, 3);
    win(m, 1, 3);
    expect(m.isDeuce()).toBe(true);
    expect(m.call(['You', 'Rival'])).toBe('Deuce');
    win(m, 1);
    expect(m.advantage()).toBe(1);
    expect(m.pointLabel(1)).toBe('AD');
    expect(m.pointLabel(0)).toBe('40');
    expect(m.call(['You', 'Rival'])).toBe('Advantage Rival');
    expect(m.isBreakPoint()).toBe(true);
    win(m, 0);
    expect(m.isDeuce()).toBe(true);
    win(m, 0);
    const o = win(m, 0);
    expect(o.gameWon).toBe(0);
    expect(o.breakOfServe).toBe(false);
  });

  it('alternates deuce/ad court within a game', () => {
    const m = new MatchScore('short', 0);
    expect(m.serveSide).toBe('deuce');
    win(m, 0);
    expect(m.serveSide).toBe('ad');
    win(m, 1);
    expect(m.serveSide).toBe('deuce');
  });

  it('wins a short set 3-0 and needs two clear games', () => {
    const m = new MatchScore('short', 0);
    win(m, 0, 4);
    win(m, 0, 4);
    const o = win(m, 0, 4);
    expect(o.matchWon).toBe(0);
    expect(m.finished).toBe(true);
    expect(m.scoreLine(0)).toBe('3–0');

    const n = new MatchScore('short', 0);
    win(n, 0, 4);
    win(n, 1, 4);
    win(n, 0, 4);
    win(n, 1, 4); // 2-2
    const o2 = win(n, 0, 4); // 3-2: not enough
    expect(o2.setWon).toBeUndefined();
    expect(n.finished).toBe(false);
  });

  it('plays a tie-break at 3-3 with the right serve rotation', () => {
    const m = new MatchScore('short', 0);
    for (let g = 0; g < 6; g++) win(m, (g % 2) as Side, 4);
    expect(m.games).toEqual([3, 3]);
    expect(m.tiebreak).toBe(true);
    // Game servers alternated 0,1,0,1,0,1 so player 0 starts the tie-break.
    const servers: Side[] = [];
    for (let i = 0; i < 7; i++) {
      servers.push(m.server);
      win(m, (i % 2) as Side);
    }
    expect(servers).toEqual([0, 1, 1, 0, 0, 1, 1]);
    expect(m.call(['You', 'Rival'])).toBe('Four three, You');
  });

  it('tie-break needs a two point margin', () => {
    const m = new MatchScore('tiebreak', 0);
    expect(m.tiebreak).toBe(true);
    for (let i = 0; i < 6; i++) {
      win(m, 0);
      win(m, 1);
    }
    expect(m.points).toEqual([6, 6]);
    expect(m.matchPointFor(0)).toBe(false);
    win(m, 0);
    expect(m.finished).toBe(false);
    expect(m.matchPointFor(0)).toBe(true);
    const o = win(m, 0);
    expect(o.matchWon).toBe(0);
    expect(m.scoreLine(0)).toBe('8–6');
  });

  it('detects set point and match point', () => {
    const m = new MatchScore('short', 0);
    win(m, 0, 4);
    win(m, 0, 4);
    win(m, 0, 3);
    expect(m.setPointFor(0)).toBe(true);
    expect(m.matchPointFor(1)).toBe(false);
  });
});

const flat = (p: [number, number, number], v: [number, number, number], w: [number, number, number] = [0, 0, 0]): BallState => ({
  p: { x: p[0], y: p[1], z: p[2] },
  v: { x: v[0], y: v[1], z: v[2] },
  w: { x: w[0], y: w[1], z: w[2] },
});

describe('ball physics', () => {
  it('bounces lower than it falls and keeps moving forward', () => {
    const f = new Flight(flat([0, 1.5, 11], [0, 0, -10]), SURFACES.hard, 3);
    const b = f.bounce(0)!;
    expect(b).toBeTruthy();
    expect(b.p.z).toBeLessThan(11);
    // Second bounce comes after the first and further along.
    const b2 = f.bounce(1)!;
    expect(b2.t).toBeGreaterThan(b.t);
    expect(b2.p.z).toBeLessThan(b.p.z);
  });

  it('topspin kicks forward on the bounce and slice skids slower', () => {
    const mk = (spin: number) => {
      const s = flat([0, 0.5, 0], [0, -6, -18]);
      s.w = spinVector(0, -1, spin);
      s.p.y = BALL_R;
      bounce(s, SURFACES.hard);
      return s;
    };
    const top = mk(300);
    const none = mk(0);
    const slice = mk(-300);
    expect(-top.v.z).toBeGreaterThan(-none.v.z);
    expect(-none.v.z).toBeGreaterThan(-slice.v.z);
    expect(top.v.y).toBeGreaterThan(0);
  });

  it('grips into a roll when friction allows', () => {
    const s = flat([0, BALL_R, 0], [0, -8, -3]);
    bounce(s, SURFACES.hard);
    // Contact point velocity ~0 after the bounce.
    const uz = s.v.z - BALL_R * s.w.x;
    expect(Math.abs(uz)).toBeLessThan(1e-6);
  });

  it('topspin dips the ball compared with flat', () => {
    const base = flat([0, 1, 11], [0, 4, -28]);
    const flatF = new Flight(base, SURFACES.hard, 3);
    const top = flat([0, 1, 11], [0, 4, -28]);
    top.w = spinVector(0, -1, 300);
    const topF = new Flight(top, SURFACES.hard, 3);
    expect(topF.bounce(0)!.p.z).toBeGreaterThan(flatF.bounce(0)!.p.z);
  });

  it('a low ball hits the net and stays on the hitter side', () => {
    const f = new Flight(flat([0, 0.5, 8], [0, 0.5, -25]), SURFACES.hard, 3);
    expect(f.firstOf('net')).toBeTruthy();
    const end = f.at(f.duration);
    expect(end.z).toBeGreaterThan(0);
  });

  it('net is higher at the posts', () => {
    expect(netHeight(0)).toBeCloseTo(COURT.netCentre, 3);
    expect(netHeight(COURT.netHalfWidth)).toBeCloseTo(COURT.netPost, 3);
    expect(netHeight(3)).toBeGreaterThan(netHeight(1));
  });

  it('in/out on the lines', () => {
    const far = singlesHalf(true);
    expect(isIn({ x: 0, z: -11.88 }, far)).toBe(true);
    expect(isIn({ x: 4.12, z: -5 }, far)).toBe(true);
    expect(isIn({ x: 4.2, z: -5 }, far)).toBe(false);
    expect(isIn({ x: 0, z: -12 }, far)).toBe(false);
    expect(isIn({ x: 0, z: 3 }, far)).toBe(false);
    expect(onLine({ x: 4.11, z: -5 })).toBe(true);
    expect(onLine({ x: 2, z: -5 })).toBe(false);
    expect(onLine({ x: 0.5, z: -11.86 })).toBe(true);
  });

  it('service boxes are diagonal', () => {
    // Near server in the deuce court (stands at +x) serves to the far box at -x.
    const b = serviceBox(true, 'deuce');
    expect(b.x1).toBe(0);
    expect(b.z0).toBe(-COURT.service);
    expect(serviceBox(true, 'ad').x0).toBe(0);
    // Far server: deuce box on the near side is at +x.
    expect(serviceBox(false, 'deuce').x0).toBe(0);
    expect(serviceBox(false, 'deuce').z1).toBe(COURT.service);
  });

  it('solver lands rally shots on target and clears the net', () => {
    for (const spin of [0, 250, -150]) {
      const sol = solveShot({ from: { x: 1, y: 0.9, z: 11.5 }, target: { x: -2.5, z: -9 }, speed: 28, spin, clearance: 0.3 }, SURFACES.hard);
      expect(Math.hypot(sol.landing.x + 2.5, sol.landing.z + 9)).toBeLessThan(0.15);
      expect(sol.clearance).toBeGreaterThan(0.2);
      const f = new Flight(sol.state, SURFACES.hard, 4);
      const b = f.bounce(0)!;
      expect(isIn(b.p, singlesHalf(true))).toBe(true);
    }
  });

  it('solver finds lobs and serves', () => {
    const lob = solveShot({ from: { x: 0, y: 1, z: 11 }, target: { x: 0, z: -10 }, speed: 19, spin: 150, high: true }, SURFACES.hard);
    const f = new Flight(lob.state, SURFACES.hard, 6);
    let apex = 0;
    for (let t = 0; t < f.bounce(0)!.t; t += 0.02) apex = Math.max(apex, f.at(t).y);
    expect(apex).toBeGreaterThan(5);
    const box = serviceBox(true, 'deuce');
    const serve = solveShot({ from: { x: 0.8, y: 2.7, z: 12.2 }, target: { x: -2, z: -5.6 }, speed: 48, spin: 50, clearance: 0.1 }, SURFACES.hard);
    const sf = new Flight(serve.state, SURFACES.hard, 4);
    expect(isIn(sf.bounce(0)!.p, box)).toBe(true);
    expect(serve.speed).toBeGreaterThan(40);
  });
});

const swing = (o: Partial<SwingFeatures>): SwingFeatures => ({ t: 0, vx: 0, vy: 0, startX: 0, startY: -0.5, endX: 0, endY: -0.5, ...o, speed: o.speed ?? Math.hypot(o.vx ?? 0, o.vy ?? 0) });

describe('swing classification', () => {
  it('forehand vs backhand for right and left handers', () => {
    expect(classifySwing(swing({ vx: -12, vy: 1, startX: 1 }), 'right').stroke).toBe('forehand');
    expect(classifySwing(swing({ vx: 12, vy: 1, startX: -0.8 }), 'right').stroke).toBe('backhand');
    expect(classifySwing(swing({ vx: 12, vy: 1, startX: -1 }), 'left').stroke).toBe('forehand');
    expect(classifySwing(swing({ vx: -12, vy: 1, startX: 0.8 }), 'left').stroke).toBe('backhand');
  });

  it('vertical direction picks the spin', () => {
    expect(classifySwing(swing({ vx: -12, vy: 0 }), 'right').kind).toBe('flat');
    expect(classifySwing(swing({ vx: -10, vy: 5 }), 'right').kind).toBe('topspin');
    expect(classifySwing(swing({ vx: -5, vy: 9, endY: 1.2 }), 'right').kind).toBe('lob');
    expect(classifySwing(swing({ vx: -8, vy: -8 }), 'right').kind).toBe('slice');
    expect(classifySwing(swing({ vx: -3, vy: -4.5 }), 'right').kind).toBe('drop');
  });

  it('timing window and labels', () => {
    const w = WINDOWS.normal;
    expect(judgeTiming(0.25, w)).toBeNull();
    expect(judgeTiming(-0.25, w)).toBeNull();
    expect(judgeTiming(0.01, w)!.label).toBe('Perfect');
    expect(judgeTiming(-0.15, w)!.label).toBe('Early');
    expect(judgeTiming(0.15, w)!.label).toBe('Late');
    expect(judgeTiming(0.18, WINDOWS.easy)).not.toBeNull();
  });

  it('early goes cross-court, late goes down the line', () => {
    const ctx = { sideSign: 1, difficulty: 'normal' as const, hitterX: 0, wrongSide: false, incoming: 18 };
    const fh = { stroke: 'forehand' as const, kind: 'topspin' as const };
    const early = shotFromSwing(fh, 12, judgeTiming(-0.14, WINDOWS.normal)!, ctx);
    const late = shotFromSwing(fh, 12, judgeTiming(0.14, WINDOWS.normal)!, ctx);
    expect(early.x).toBeLessThan(-1.5);
    expect(late.x).toBeGreaterThan(1.5);
    // Backhand on the -x side mirrors it.
    const bh = shotFromSwing({ stroke: 'backhand', kind: 'flat' }, 12, judgeTiming(-0.14, WINDOWS.normal)!, { ...ctx, sideSign: -1 });
    expect(bh.x).toBeGreaterThan(1.5);
  });

  it('faster swings hit harder; perfect timing is cleaner', () => {
    const ctx = { sideSign: 1, difficulty: 'normal' as const, hitterX: 0, wrongSide: false, incoming: 18 };
    const c = { stroke: 'forehand' as const, kind: 'flat' as const };
    const slow = shotFromSwing(c, MIN_SWING + 1, judgeTiming(0, WINDOWS.normal)!, ctx);
    const fast = shotFromSwing(c, MIN_SWING + 14, judgeTiming(0, WINDOWS.normal)!, ctx);
    expect(fast.speed).toBeGreaterThan(slow.speed + 8);
    const edge = shotFromSwing(c, MIN_SWING + 8, judgeTiming(0.19, WINDOWS.normal)!, ctx);
    const perfect = shotFromSwing(c, MIN_SWING + 8, judgeTiming(0, WINDOWS.normal)!, ctx);
    expect(edge.error).toBeGreaterThan(perfect.error);
    expect(edge.mishit).toBe(true);
    // Easy never mishits.
    expect(shotFromSwing(c, MIN_SWING + 8, judgeTiming(0.23, WINDOWS.easy)!, { ...ctx, difficulty: 'easy' }).mishit).toBe(false);
  });

  it('slice and drop shots are softer with backspin; lobs go high', () => {
    const ctx = { sideSign: 1, difficulty: 'normal' as const, hitterX: 0, wrongSide: false, incoming: 18 };
    const t = judgeTiming(0, WINDOWS.normal)!;
    const slice = shotFromSwing({ stroke: 'backhand', kind: 'slice' }, 12, t, ctx);
    const drop = shotFromSwing({ stroke: 'backhand', kind: 'drop' }, 6, t, ctx);
    const lob = shotFromSwing({ stroke: 'forehand', kind: 'lob' }, 10, t, ctx);
    expect(slice.spin).toBeLessThan(0);
    expect(drop.depth).toBeLessThan(4);
    expect(lob.high).toBe(true);
  });

  it('serve pace follows swing speed', () => {
    const t = judgeTiming(0, WINDOWS.normal)!;
    expect(serveFromSwing(16, 0, t, true, 'normal').speed).toBeGreaterThan(serveFromSwing(6, 0, t, true, 'normal').speed);
    expect(serveFromSwing(10, 0, t, false, 'normal').spin).toBeGreaterThan(serveFromSwing(10, 0, t, true, 'normal').spin);
  });
});

describe('movement assist', () => {
  it('finds a reachable contact point after the bounce', () => {
    const sol = solveShot({ from: { x: 0, y: 1, z: -11 }, target: { x: 2, z: 9 }, speed: 26, spin: 200, clearance: 0.4 }, SURFACES.hard);
    const f = new Flight(sol.state, SURFACES.hard, 5);
    const ic = chooseIntercept(f, 0, { x: 0, z: 12 }, true, 'right', 6.5, 0.1)!;
    expect(ic).toBeTruthy();
    expect(ic.t).toBeGreaterThan(f.bounce(0)!.t);
    expect(ic.height).toBeGreaterThan(0.45);
    expect(ic.height).toBeLessThan(1.7);
    expect(ic.reachable).toBe(true);
    expect(ic.stroke).toBe('forehand');
  });
});
