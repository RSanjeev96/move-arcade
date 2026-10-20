import { describe, expect, it } from 'vitest';
import {
  LapTimer,
  SPECS,
  TRACKS,
  TrackGrid,
  buildTrack,
  cornerSpeed,
  lapOf,
  layout,
  project,
  rankOrder,
  sampleAt,
  speedProfile,
  worldAt,
  wrapS,
} from '../src/games/racer/track';
import { AIDriver, Gearbox, SteerFilter, collide, newCar, steerCurv, stepCar, surfaceAt } from '../src/games/racer/physics';
import { WheelControls, LeanControls, wheelPose, leanPose } from '../src/games/racer/controls';
import { wheel } from '../src/core/gestures';
import type { Body } from '../src/core/body';

const tracks = TRACKS.map((d) => buildTrack(d));

/** Minimal Body built from wrist positions (body space). */
function body(l: { x: number; y: number }, r: { x: number; y: number }, extra: Partial<Body> = {}, t = 0): Body {
  return {
    t,
    ok: true,
    full: true,
    hips: true,
    scale: 100,
    cx: 640,
    cy: 250,
    lWrist: l,
    rWrist: r,
    lElbow: { x: -0.6, y: -0.5 },
    rElbow: { x: 0.6, y: -0.5 },
    lShoulder: { x: -0.5, y: 0 },
    rShoulder: { x: 0.5, y: 0 },
    nose: { x: 0, y: 0.78 },
    hip: { x: 0, y: -1.5 },
    lKnee: { x: -0.3, y: -2.7 },
    rKnee: { x: 0.3, y: -2.7 },
    lAnkle: { x: -0.3, y: -3.9 },
    rAnkle: { x: 0.3, y: -3.9 },
    lWristV: 0.95,
    rWristV: 0.95,
    lWristZ: 0,
    rWristZ: 0,
    lean: 0,
    duck: 0,
    rise: 0,
    w: 1280,
    h: 720,
    ...extra,
  };
}

describe('track generation', () => {
  it('layout closes the loop exactly', () => {
    for (const d of TRACKS) {
      const pts = d.points;
      const last = pts[pts.length - 1];
      // The last control point is one step before the start; the gap must be a normal step, not a jump.
      expect(Math.hypot(last[0], last[1])).toBeLessThan(45);
    }
    const sq = layout(
      [
        ['S', 100],
        ['T', 90, 20],
        ['S', 100],
        ['T', 90, 20],
        ['S', 100],
        ['T', 90, 20],
        ['S', 100],
        ['T', 90, 20],
      ],
      0,
      [0, 2],
    );
    const last = sq[sq.length - 1];
    expect(Math.hypot(last[0], last[1])).toBeLessThan(45);
  });

  for (const t of tracks) {
    describe(t.def.name, () => {
      it('is a closed loop with uniform sampling', () => {
        expect(t.length).toBeGreaterThan(1800);
        expect(t.length).toBeLessThan(4500);
        for (let i = 0; i < t.n; i++) {
          const j = (i + 1) % t.n;
          const d = Math.hypot(t.x[j] - t.x[i], t.z[j] - t.z[i]);
          expect(d).toBeGreaterThan(t.step * 0.8);
          expect(d).toBeLessThan(t.step * 1.2);
        }
      });

      it('turns a full clockwise circle and has drivable corner radii', () => {
        let total = 0;
        let minR = Infinity;
        for (let i = 0; i < t.n; i++) {
          total += t.curv[i] * t.step;
          minR = Math.min(minR, 1 / Math.abs(t.curv[i]));
        }
        // Clockwise = net right turn = -2π (curvature is + for left turns).
        expect(total).toBeCloseTo(-2 * Math.PI, 1);
        expect(minR).toBeGreaterThan(15);
        expect(t.corners.length).toBeGreaterThanOrEqual(5);
      });

      it('keeps the racing line and barriers on sensible sides of the road', () => {
        for (let i = 0; i < t.n; i++) {
          expect(Math.abs(t.line[i])).toBeLessThanOrEqual(t.hw);
          expect(t.wallL[i]).toBeGreaterThan(t.hw + 1.5);
          expect(t.wallR[i]).toBeGreaterThan(t.hw + 1.5);
        }
        // The racing line uses the width of the road: apexes reach toward the inside.
        let maxOff = 0;
        for (let i = 0; i < t.n; i++) maxOff = Math.max(maxOff, Math.abs(t.line[i]));
        expect(maxOff).toBeGreaterThan(t.hw * 0.6);
      });

      it('projects world points back to (s, d)', () => {
        const grid = new TrackGrid(t);
        for (const s of [10, t.length * 0.31, t.length * 0.77]) {
          for (const d of [-4, 0, 3]) {
            const p = worldAt(t, s, d);
            const q = project(t, grid, p.x, p.z)!;
            expect(Math.abs(wrapS(t, q.s - s + t.length / 2) - t.length / 2)).toBeLessThan(0.5);
            expect(q.d).toBeCloseTo(d, 0);
          }
        }
      });

      it('has a speed profile that slows for corners', () => {
        const v = speedProfile(t, SPECS.f1);
        let min = Infinity;
        let max = 0;
        for (let i = 0; i < t.n; i++) {
          min = Math.min(min, v[i]);
          max = Math.max(max, v[i]);
        }
        expect(min).toBeGreaterThan(12);
        expect(min).toBeLessThan(30);
        expect(max).toBeGreaterThan(70);
        // Braking: speed never drops faster than the brakes allow.
        for (let i = 0; i < t.n; i++) {
          const a = v[i];
          const b = v[(i + 1) % t.n];
          expect(a * a - b * b).toBeLessThanOrEqual(2 * SPECS.f1.brake * t.step + 1e-3);
        }
      });
    });
  }
});

describe('progress, laps and ranking', () => {
  it('counts laps from continuous progress', () => {
    const L = 1000;
    expect(lapOf(-30, L)).toBe(1);
    expect(lapOf(0, L)).toBe(1);
    expect(lapOf(999, L)).toBe(1);
    expect(lapOf(1000, L)).toBe(2);
    expect(lapOf(2500, L)).toBe(3);
  });

  it('times laps with sub-frame interpolation from lights out', () => {
    const lt = new LapTimer(1000);
    // Grid start behind the line: crossing it the first time does not complete a lap.
    expect(lt.update(-20, 0, 5, 0.5)).toBeNull();
    expect(lt.update(990, 30, 1010, 31)).toBeCloseTo(30.5, 5);
    expect(lt.laps).toHaveLength(1);
    expect(lt.update(1990, 59, 2010, 59.5)).toBeCloseTo(28.75, 5);
    expect(lt.best).toBeCloseTo(28.75, 5);
    // Going backward over the line and forward again does not double count.
    expect(lt.update(2010, 60, 1995, 60.5)).toBeNull();
    expect(lt.update(1995, 60.5, 2005, 61)).toBeNull();
    expect(lt.current(70)).toBeCloseTo(70 - 59.25, 5);
  });

  it('ranks finished racers by time, then the rest by progress', () => {
    const order = rankOrder([
      { p: 500, finished: false, finishTime: 0 },
      { p: 3100, finished: true, finishTime: 95 },
      { p: 1200, finished: false, finishTime: 0 },
      { p: 3050, finished: true, finishTime: 93 },
    ]);
    expect(order).toEqual([3, 1, 2, 0]);
  });
});

describe('steering smoothing', () => {
  it('has a dead zone and a gentle centre', () => {
    const f = new SteerFilter();
    expect(f.shape(0.03)).toBe(0);
    expect(f.shape(-0.03)).toBe(0);
    expect(f.shape(1)).toBeCloseTo(1, 5);
    expect(Math.abs(f.shape(0.3))).toBeLessThan(0.3);
    expect(f.shape(-0.5)).toBeCloseTo(-f.shape(0.5), 6);
    for (const u of [-0.8, -0.2, 0.1, 0.6]) expect(f.shape(f.unshape(u))).toBeCloseTo(u, 5);
  });

  it('is slower and rate limited at high speed', () => {
    const slow = new SteerFilter();
    const fast = new SteerFilter();
    for (let k = 0; k < 6; k++) {
      slow.update(1, 0.1, 1 / 60);
      fast.update(1, 1, 1 / 60);
    }
    expect(slow.value).toBeGreaterThan(fast.value);
    // Rate limit: never more than (5.5 - 3) units per second at top speed.
    expect(fast.value).toBeLessThanOrEqual((2.5 * 6) / 60 + 1e-6);
    // Converges eventually and filters jitter.
    const j = new SteerFilter();
    let maxDev = 0;
    for (let k = 0; k < 240; k++) {
      j.update(0.5 + (k % 2 ? 0.15 : -0.15), 0.8, 1 / 60);
      if (k > 120) maxDev = Math.max(maxDev, Math.abs(j.value - j.shape(0.5)));
    }
    expect(maxDev).toBeLessThan(0.06);
  });

  it('turns less sharply at full lock when going fast', () => {
    expect(steerCurv(SPECS.f1, 10)).toBeGreaterThan(steerCurv(SPECS.f1, 80) * 5);
  });
});

describe('vehicle model', () => {
  const t = tracks[0];

  it('accelerates toward top speed on a straight', () => {
    const c = newCar(0, 0);
    for (let k = 0; k < 120 * 8; k++) stepCar(t, SPECS.f1, c, { curv: 0, throttle: 1, brake: 0 }, 1 / 120);
    expect(c.v).toBeGreaterThan(55);
    expect(c.p).toBeGreaterThan(250);
  });

  it('scrubs speed at a barrier but never stops dead', () => {
    const c = newCar(60, 0);
    c.v = 60;
    c.psi = 0.5; // pointing at the right-hand barrier
    let hit = 0;
    for (let k = 0; k < 120; k++) {
      stepCar(t, SPECS.f1, c, { curv: 0, throttle: 1, brake: 0 }, 1 / 120);
      hit = Math.max(hit, c.wallHit);
    }
    expect(hit).toBeGreaterThan(0);
    expect(c.v).toBeGreaterThan(15);
    expect(c.d).toBeLessThanOrEqual(sampleAt(t, t.wallR, wrapS(t, c.p)));
  });

  it('is slowed by grass', () => {
    const s = 80;
    const d = t.hw + 4;
    expect(surfaceAt(t, s, d)).not.toBe('road');
    const a = newCar(s, 0);
    const b = newCar(s, d);
    a.v = b.v = 50;
    for (let k = 0; k < 120; k++) {
      stepCar(t, SPECS.f1, a, { curv: 0, throttle: 1, brake: 0 }, 1 / 120);
      stepCar(t, SPECS.f1, b, { curv: 0, throttle: 1, brake: 0 }, 1 / 120);
    }
    expect(b.v).toBeLessThan(a.v - 5);
  });

  it('AI cars complete laps without leaving the circuit', () => {
    for (const tr of tracks)
      for (const kind of ['f1', 'moto'] as const) {
        const spec = SPECS[kind];
        const prof = speedProfile(tr, spec);
        const cars = [newCar(-10, -2.5), newCar(-18, 2.5), newCar(-26, -2.5)];
        const ai = cars.map((_, i) => new AIDriver(0.92 + i * 0.03, i + 1));
        const timers = cars.map(() => new LapTimer(tr.length));
        let walls = 0;
        let time = 0;
        for (let k = 0; k < 120 * 200 && timers.some((x) => x.laps.length < 1); k++) {
          cars.forEach((c, i) => {
            const p0 = c.p;
            stepCar(tr, spec, c, ai[i].drive(tr, prof, c, cars, 1 / 120, time), 1 / 120);
            timers[i].update(p0, time, c.p, time + 1 / 120);
            if (c.wallHit > 0) walls++;
          });
          collide(tr, cars, spec.length, spec.width + 0.1);
          time += 1 / 120;
        }
        for (const tm of timers) {
          expect(tm.laps.length).toBeGreaterThanOrEqual(1);
          expect(tm.laps[0]).toBeLessThan(110);
        }
        expect(walls).toBeLessThan(5);
      }
  });

  it('corner speed matches the grip model', () => {
    const v = cornerSpeed(SPECS.f1, 1 / 50);
    const a = (v * v) / 50;
    expect(a).toBeCloseTo(SPECS.f1.grip0 + SPECS.f1.gripAero * v * v, 3);
  });

  it('separates overlapping cars', () => {
    const a = newCar(100, 0);
    const b = newCar(101, 0.8);
    a.v = 40;
    b.v = 30;
    const c = collide(t, [a, b], 5.4, 2);
    expect(c.length).toBe(1);
    expect(Math.abs(b.d - a.d) >= 2 || Math.abs(b.p - a.p) >= 5.4 - 1e-6).toBe(true);
  });

  it('gearbox shifts up with speed', () => {
    const g = new Gearbox(8, 96, 4200, 12500);
    let ups = 0;
    for (let v = 0; v < 95; v += 0.2) if (g.update(v, 1, 1 / 60) > 0) ups++;
    expect(g.gear).toBe(8);
    expect(ups).toBe(7);
    expect(g.rpm).toBeGreaterThan(9000);
  });
});

describe('controls', () => {
  it('wheel pose round-trips through the wheel gesture', () => {
    for (const u of [-0.8, -0.3, 0, 0.4, 1]) {
      const p = wheelPose(u, -0.3);
      const w = wheel(body(p.lWrist, p.rWrist));
      expect(w.holding).toBe(true);
      expect(w.steer).toBeCloseTo(u, 2);
    }
  });

  it('F1: lowering the hands brakes, raising them boosts once', () => {
    const c = new WheelControls();
    let t = 0;
    const feed = (y: number, n = 10) => {
      for (let k = 0; k < n; k++) {
        const p = wheelPose(0, y);
        c.update(body(p.lWrist, p.rWrist, {}, (t += 33)));
      }
    };
    feed(-0.3, 30);
    expect(c.c.holding).toBe(true);
    expect(c.c.brake).toBe(0);
    feed(-1.3);
    expect(c.c.brake).toBeGreaterThan(0.8);
    feed(-0.3);
    expect(c.c.brake).toBe(0);
    let boosts = 0;
    for (let k = 0; k < 20; k++) {
      const p = wheelPose(0, 0.8);
      c.update(body(p.lWrist, p.rWrist, {}, (t += 33)));
      if (c.c.boost) boosts++;
    }
    expect(boosts).toBe(1);
    // Hands out of view: let go of the wheel after a moment.
    for (let k = 0; k < 20; k++) c.update(body({ x: -0.8, y: -0.3 }, { x: 0.8, y: -0.3 }, { lWristV: 0.1, rWristV: 0.1 }, (t += 33)));
    expect(c.c.holding).toBe(false);
  });

  it('F1: learns a low comfortable hand height on the grid so it does not brake', () => {
    const c = new WheelControls();
    let t = 0;
    c.calibrating = true;
    for (let k = 0; k < 90; k++) {
      const p = wheelPose(0, -0.95);
      c.update(body(p.lWrist, p.rWrist, {}, (t += 33)));
      expect(c.c.brake).toBe(0);
      expect(c.c.boost).toBe(false);
    }
    c.calibrating = false;
    for (let k = 0; k < 10; k++) {
      const p = wheelPose(0.3, -0.95);
      c.update(body(p.lWrist, p.rWrist, {}, (t += 33)));
    }
    expect(c.c.brake).toBe(0);
    expect(c.c.steer).toBeCloseTo(0.3, 1);
    for (let k = 0; k < 10; k++) {
      const p = wheelPose(0, -1.9);
      c.update(body(p.lWrist, p.rWrist, {}, (t += 33)));
    }
    expect(c.c.brake).toBeGreaterThan(0.5);
  });

  it('Moto: subtracts the standing lean measured on the grid', () => {
    const c = new LeanControls();
    const p = leanPose(0, false, false);
    c.calibrating = true;
    for (let k = 0; k < 120; k++) c.update(body(p.lWrist, p.rWrist, { lean: 0.2 }, k * 33));
    c.calibrating = false;
    c.update(body(p.lWrist, p.rWrist, { lean: 0.2 }, 5000));
    expect(Math.abs(c.c.steer)).toBeLessThan(0.08);
  });

  it('Moto: lean steers, crouch tucks, hands at the hips brake', () => {
    const c = new LeanControls();
    const p = leanPose(0, false, false);
    c.update(body(p.lWrist, p.rWrist, { lean: 0.5, hip: { x: -0.3, y: -1.47 } }, 0));
    expect(c.c.steer).toBeGreaterThan(0.5);
    c.update(body(p.lWrist, p.rWrist, { duck: 0.35 }, 33));
    expect(c.c.tuck).toBe(true);
    expect(c.c.brake).toBe(0);
    const b = leanPose(0, false, true);
    c.update(body(b.lWrist, b.rWrist, { duck: 0 }, 66));
    expect(c.c.brake).toBeGreaterThan(0.9);
    expect(c.c.tuck).toBe(false);
  });
});
