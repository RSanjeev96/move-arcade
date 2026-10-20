import { describe, expect, it } from 'vitest';
import { BodyTracker } from '../src/core/body';
import { SimPose } from '../src/core/pose';
import { MOVE, MOVES, NEUTRAL, cycleBeats, mirrorPose, repsBetween, sampleMove, tempoMult, lowImpact, type Pose } from '../src/games/fit/moves';
import { SK, len, obsFromBody, obsFromJoints, solve, sub, toSim } from '../src/games/fit/rig';
import { ObsBuffer, ScoreKeeper, judgeWindow, rate, similarity } from '../src/games/fit/score';
import { effectiveMet, estHeartRate, intensity, kcal, motionEnergy, zoneFor } from '../src/games/fit/calories';
import { addDays, dateKey, dayDone, defaultPlan, streak, weekStart, weekSummary, type Plan, type SessionRecord } from '../src/games/fit/plan';
import { beatAt, layout, program, timeAtBeat, windows, WORKOUT_ORDER, type Grid } from '../src/games/fit/routine';

const poseDist = (a: Pose, b: Pose) =>
  len(sub(a.lw, b.lw)) + len(sub(a.rw, b.rw)) + len(sub(a.lf, b.lf)) + len(sub(a.rf, b.rf)) + Math.abs(a.px - b.px) + Math.abs(a.py - b.py) + Math.abs(a.tilt - b.tilt);

describe('move library', () => {
  it('has at least 14 exercise moves with low-impact alternatives', () => {
    const real = MOVES.filter((m) => m.kind !== 'rest');
    expect(real.length).toBeGreaterThanOrEqual(14);
    for (const m of MOVES) if (m.low) expect(MOVE[m.low].impact).toBe('low');
    expect(lowImpact('jacks', true)).toBe('stepjacks');
    expect(lowImpact('jacks', false)).toBe('jacks');
  });

  it('samples keyframes exactly and stays continuous through the cycle', () => {
    for (const m of MOVES) {
      const cyc = cycleBeats(m);
      expect(m.keys[0].b).toBe(0);
      // At a key, the sample equals that key's pose.
      const k = m.keys[m.keys.length - 1];
      const at = sampleMove(m, k.b);
      const want = { ...NEUTRAL, ...m.base, ...k.p } as Pose;
      expect(poseDist(at, want)).toBeLessThan(1e-6);
      // No jumps anywhere in the cycle, including the wrap and the mirrored half.
      let prev = sampleMove(m, 0);
      const steps = 4000;
      for (let i = 1; i <= steps; i++) {
        const cur = sampleMove(m, (i / steps) * cyc);
        expect(poseDist(prev, cur), `${m.id} @ ${(i / steps) * cyc}`).toBeLessThan(0.08);
        prev = cur;
      }
      expect(poseDist(sampleMove(m, 0), sampleMove(m, cyc))).toBeLessThan(1e-6);
    }
  });

  it('alternating moves mirror their second half', () => {
    const m = MOVE.sidelunge;
    const a = sampleMove(m, 2);
    const b = sampleMove(m, 6);
    expect(a.px).toBeGreaterThan(0.3);
    expect(b.px).toBeCloseTo(-a.px, 6);
    expect(poseDist(mirrorPose(mirrorPose(a)), a)).toBeLessThan(1e-9);
  });

  it('half- and double-times moves to suit the song', () => {
    expect(tempoMult(MOVE.jacks, 124)).toBe(1);
    expect(tempoMult(MOVE.squat, 138)).toBe(0.5);
    expect(tempoMult(MOVE.overhead, 100)).toBe(0.5);
    expect(tempoMult(MOVE.pumps, 124)).toBe(0.5);
  });
});

describe('skeleton', () => {
  it('keeps bone lengths', () => {
    for (const m of MOVES) {
      for (let b = 0; b < cycleBeats(m); b += 0.25) {
        const j = solve(sampleMove(m, b));
        expect(len(sub(j.le, j.ls))).toBeCloseTo(SK.upper, 5);
        expect(len(sub(j.lw, j.le))).toBeCloseTo(SK.fore, 5);
        expect(len(sub(j.rk, j.rh))).toBeCloseTo(SK.thigh, 5);
        expect(len(sub(j.ra, j.rk))).toBeCloseTo(SK.shin, 5);
      }
    }
  });

  it('stands still in body space when neutral', () => {
    const o = obsFromJoints(solve(NEUTRAL));
    expect(o.duck).toBeCloseTo(0, 6);
    expect(o.rise).toBeCloseTo(0, 6);
    expect(o.rw.x).toBeGreaterThan(0.4);
    expect(o.rw.y).toBeLessThan(-1.3);
    expect(o.ls.x).toBeCloseTo(-0.5, 6);
  });

  it('squats lower the shoulders and jacks raise the hands', () => {
    expect(obsFromJoints(solve(sampleMove(MOVE.squat, 2))).duck).toBeGreaterThan(0.4);
    const top = obsFromJoints(solve(sampleMove(MOVE.jacks, 1)));
    expect(top.lw.y).toBeGreaterThan(1.2);
    expect(top.rw.y).toBeGreaterThan(1.2);
  });

  it('drives SimPose so the tracker reports the coach pose (demo bot)', () => {
    const tracker = new BodyTracker();
    tracker.calibrate({ t: 0, lm: SimPose.build({ lWrist: { x: -0.75, y: -1.55 }, rWrist: { x: 0.75, y: -1.55 } }), w: SimPose.W, h: SimPose.H });
    for (const id of ['jacks', 'squat', 'sidereach', 'hipsway', 'jabcross', 'march', 'sidelunge']) {
      const m = MOVE[id];
      for (let b = 0; b < cycleBeats(m); b += 0.5) {
        const j = solve(sampleMove(m, b));
        const want = obsFromJoints(j);
        const body = tracker.measure({ t: 0, lm: SimPose.build(toSim(j)), w: SimPose.W, h: SimPose.H });
        tracker.reset();
        const got = obsFromBody(body, 0);
        const s = similarity(want, got, { legs: false, focus: m.focus }).total;
        expect(s, `${id} @ ${b}`).toBeGreaterThan(0.85);
        expect(Math.abs(got.duck - want.duck), `${id} duck`).toBeLessThan(0.05);
        expect(Math.abs(got.lean - want.lean), `${id} lean`).toBeLessThan(0.05);
      }
    }
  });
});

const target = (id: string, mult = 1, bpm = 120) => (t: number) => obsFromJoints(solve(sampleMove(MOVE[id], (t * bpm * mult) / 60)), t);

describe('pose similarity and judging', () => {
  it('is 1 for the same pose and low for a different one', () => {
    const a = obsFromJoints(solve(sampleMove(MOVE.jacks, 1)));
    const b = obsFromJoints(solve(sampleMove(MOVE.jacks, 0)));
    expect(similarity(a, a, { legs: true, focus: ['wrists'] }).total).toBeCloseTo(1, 6);
    expect(similarity(a, b, { legs: true, focus: ['wrists'] }).total).toBeLessThan(0.45);
    expect(similarity(a, { ...a, ok: false }, { legs: true, focus: [] }).total).toBe(0);
  });

  it('only scores legs when asked', () => {
    const a = obsFromJoints(solve(sampleMove(MOVE.highknees, 0.5)));
    const flat = obsFromJoints(solve({ ...sampleMove(MOVE.highknees, 0.5), rf: [0, 0, 0] }));
    const withLegs = similarity(a, flat, { legs: true, focus: ['knees'] });
    const noLegs = similarity(a, flat, { legs: false, focus: ['knees'] });
    expect(withLegs.parts.knees!).toBeLessThan(0.75);
    expect(noLegs.parts.knees).toBeUndefined();
    expect(noLegs.total).toBeGreaterThan(withLegs.total + 0.1);
  });

  it('finds the camera/reaction delay within ±200 ms', () => {
    const tg = target('jacks');
    const buf = new ObsBuffer(10);
    for (let t = 0; t < 6; t += 1 / 30) buf.push({ ...tg(t - 0.15), t });
    const j = judgeWindow(tg, (t) => buf.at(t), 2, 3, { legs: true, focus: MOVE.jacks.focus });
    expect(j.offset).toBeCloseTo(0.15, 2);
    expect(j.rating).toBe('perfect');
    const late = new ObsBuffer(10);
    for (let t = 0; t < 6; t += 1 / 30) late.push({ ...tg(t - 0.5), t });
    const j2 = judgeWindow(tg, (t) => late.at(t), 2, 3, { legs: true, focus: MOVE.jacks.focus });
    expect(j2.sim).toBeLessThan(j.sim - 0.2);
  });

  it('misses when nobody is tracked', () => {
    const j = judgeWindow(target('squat'), () => null, 1, 2, { legs: false, focus: [] });
    expect(j.rating).toBe('miss');
    expect(rate(0.9)).toBe('perfect');
    expect(rate(0.5)).toBe('ok');
  });

  it('keeps score, combo and stars', () => {
    const s = new ScoreKeeper();
    for (let i = 0; i < 10; i++) s.add({ sim: 0.9, offset: 0, rating: 'perfect' });
    expect(s.combo).toBe(10);
    expect(s.score).toBeGreaterThan(1000);
    s.add({ sim: 0.1, offset: 0, rating: 'miss' });
    expect(s.combo).toBe(0);
    expect(s.maxCombo).toBe(10);
    expect(s.stars).toBe(3);
  });
});

describe('rep counting', () => {
  it('counts the rep peaks inside a span of move beats', () => {
    expect(repsBetween(MOVE.jacks, 2, 4)).toBe(1);
    expect(repsBetween(MOVE.jacks, 0, 10)).toBe(5);
    expect(repsBetween(MOVE.jabcross, 2, 4)).toBe(2);
    expect(repsBetween(MOVE.sidelunge, 4, 8)).toBe(1);
    expect(repsBetween(MOVE.sidelunge, 0, 16)).toBe(4);
    expect(repsBetween(MOVE.squat, 4, 8)).toBe(1);
    expect(repsBetween(MOVE.steptouch, 0, 8)).toBe(0);
  });

  // The demo bot's path: coach pose → SimPose landmarks → BodyTracker → judged windows → reps.
  const viaTracker = (id: string, cycles: number, follow = true) => {
    const tracker = new BodyTracker();
    tracker.calibrate({ t: 0, lm: SimPose.build({ lWrist: { x: -0.75, y: -1.55 }, rWrist: { x: 0.75, y: -1.55 } }), w: SimPose.W, h: SimPose.H });
    const m = MOVE[id];
    const bpm = 120 * tempoMult(m, 120);
    const beats = cycles * cycleBeats(m);
    const grid = { beats: Array.from({ length: beats * 2 + 8 }, (_, i) => 0.5 + (i * 60) / 120), bpm: 120, duration: 200 };
    const block = { move: id, t0: 0.5, t1: 0.5 + (beats / bpm) * 60, b0: 0, mult: bpm / 120, beats: beats / (bpm / 120), rest: false };
    const buf = new ObsBuffer(1000);
    const still = solve(NEUTRAL);
    for (let t = 0; t < block.t1 + 1; t += 1 / 30) {
      const j = follow ? solve(sampleMove(m, Math.max(0, ((t - 0.5 - 0.1) * bpm) / 60))) : still;
      buf.push(obsFromBody(tracker.measure({ t: t * 1000, lm: SimPose.build(toSim(j)), w: SimPose.W, h: SimPose.H }), t));
    }
    const target = (t: number) => obsFromJoints(solve(sampleMove(m, ((t - 0.5) * bpm) / 60)), t);
    let reps = 0;
    let expected = 0;
    for (const w of windows(grid, block, 0)) {
      const j = judgeWindow(target, (t) => buf.at(t), w.t0, w.t1, { legs: true, focus: m.focus });
      expected += repsBetween(m, w.mb0, w.mb1);
      if (j.rating !== 'miss') reps += repsBetween(m, w.mb0, w.mb1);
    }
    return { reps, expected };
  };

  it('counts squats, jacks, punches and lunges done with the coach', () => {
    for (const [id, cycles] of [['squat', 5], ['jacks', 8], ['jabcross', 6], ['sidelunge', 3], ['highknees', 8], ['kneetwist', 4]] as const) {
      const r = viaTracker(id, cycles);
      expect(r.expected, id).toBeGreaterThan(3);
      expect(r.reps, id).toBe(r.expected);
    }
  });

  it('does not count reps when the player stands still', () => {
    for (const id of ['squat', 'jacks', 'jabcross']) expect(viaTracker(id, 6, false).reps, id).toBe(0);
  });
});

describe('calories', () => {
  it('uses MET × weight × time', () => {
    expect(kcal(8, 70, 3600)).toBeCloseTo(560, 6);
    expect(kcal(4, 80, 900)).toBeCloseTo(80, 6);
  });
  it('scales with measured intensity', () => {
    expect(effectiveMet(8, 1)).toBeCloseTo(8, 6);
    expect(effectiveMet(8, 0)).toBeCloseTo(1.3, 6);
    expect(effectiveMet(8, 0.5)).toBeLessThan(effectiveMet(8, 1));
    expect(effectiveMet(8, 5)).toBeLessThanOrEqual(effectiveMet(8, 1.2));
    expect(intensity(1, 2)).toBeCloseTo(0.5, 6);
  });
  it('measures motion energy', () => {
    const still = obsFromJoints(solve(NEUTRAL));
    const stillList = Array.from({ length: 30 }, (_, i) => ({ ...still, t: i / 30 }));
    expect(motionEnergy(stillList)).toBe(0);
    const tg = target('jacks');
    const moving = Array.from({ length: 60 }, (_, i) => tg(i / 30));
    expect(motionEnergy(moving)).toBeGreaterThan(1);
  });
  it('maps effort to zones and an estimated heart rate', () => {
    expect(zoneFor(0).zone).toBe(1);
    expect(zoneFor(0.99).zone).toBe(5);
    expect(estHeartRate(40, 1)).toBeGreaterThan(estHeartRate(40, 0));
  });
});

describe('weekly plan', () => {
  const plan: Plan = defaultPlan(); // Mon cardio 20, Wed hiit 15, Fri boxing 20, Sat cardio 20
  const rec = (d: Date, minutes: number, completed = true): SessionRecord => ({
    id: dateKey(d) + minutes,
    date: dateKey(d),
    ts: d.getTime(),
    type: 'cardio',
    minutes,
    target: 20,
    kcal: minutes * 7,
    score: 1000,
    stars: 2,
    completed,
  });
  // Wednesday 2026-10-21.
  const wed = new Date(2026, 9, 21, 12);
  const mon = addDays(wed, -2);
  const prevSat = addDays(wed, -4);
  const prevFri = addDays(wed, -5);

  it('weeks start on Monday', () => {
    expect(dateKey(weekStart(wed))).toBe('2026-10-19');
    expect(dateKey(weekStart(new Date(2026, 9, 25, 12)))).toBe('2026-10-19');
  });

  it('marks planned days done at half the planned minutes', () => {
    expect(dayDone(plan, [rec(mon, 9)], mon)).toBe(false);
    expect(dayDone(plan, [rec(mon, 10)], mon)).toBe(true);
  });

  it('counts the streak over planned days only', () => {
    const h = [rec(prevFri, 20), rec(prevSat, 20), rec(mon, 20)];
    // Today (Wed) is planned but not done yet: the streak is still alive.
    expect(streak(plan, h, wed)).toBe(3);
    expect(streak(plan, [...h, rec(wed, 15)], wed)).toBe(4);
    // Thursday: Wednesday was missed, so the streak is broken.
    expect(streak(plan, h, addDays(wed, 1))).toBe(0);
    // A missing Saturday breaks it before Monday.
    expect(streak(plan, [rec(prevFri, 20), rec(mon, 20)], wed)).toBe(1);
  });

  it('summarises the week', () => {
    const h = [rec(prevSat, 20), rec(mon, 22), rec(mon, 5, false)];
    const w = weekSummary(plan, h, wed);
    expect(w.days).toHaveLength(7);
    expect(w.days[0].done).toBe(true);
    expect(w.days[2].isToday).toBe(true);
    expect(w.minutes).toBe(27);
    expect(w.sessions).toBe(1);
    expect(w.planned).toBe(4);
    expect(w.plannedDone).toBe(1);
    expect(w.goalText).toBe('1/4 sessions this week');
    expect(w.progress).toBeCloseTo(0.25, 6);
    const wm = weekSummary({ ...plan, goalKind: 'minutes', goal: 90 }, h, wed);
    expect(wm.goalText).toBe('27/90 min this week');
  });
});

describe('routines', () => {
  const grid = (bpm: number, dur = 140): Grid => {
    const beats: number[] = [];
    for (let t = 0.4; t < dur; t += 60 / bpm) beats.push(t);
    return { beats, bpm, duration: dur };
  };
  it('fills each workout to its length', () => {
    for (const type of WORKOUT_ORDER) {
      for (const min of [1, 5, 10, 20]) {
        const steps = program(type, min, { seed: 3 });
        const total = steps.reduce((a, s) => a + s.sec, 0);
        expect(total, `${type} ${min}`).toBeGreaterThan(min * 60 - 7);
        expect(total).toBeLessThanOrEqual(min * 60 + 1e-6);
        for (const s of steps) expect(MOVE[s.move], s.move).toBeDefined();
      }
    }
    expect(program('hiit', 10).some((s) => s.rest)).toBe(true);
    expect(program('cardio', 10, { lowImpact: true }).some((s) => MOVE[s.move].impact === 'high')).toBe(false);
  });

  it('maps beats and times both ways', () => {
    const g = grid(124);
    expect(timeAtBeat(g, beatAt(g, 33.3))).toBeCloseTo(33.3, 6);
    expect(beatAt(g, timeAtBeat(g, 12.25))).toBeCloseTo(12.25, 6);
  });

  it('lays whole move cycles onto the beat grid', () => {
    const g = grid(124);
    const steps = program('cardio', 10, { seed: 1 });
    const cur = { i: 0, used: 0 };
    const blocks = layout(g, steps, cur, 1, 138);
    expect(blocks.length).toBeGreaterThan(3);
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const m = MOVE[b.move];
      const moveBeats = b.beats * b.mult;
      expect(moveBeats % cycleBeats(m)).toBeCloseTo(0, 6);
      expect(Number.isInteger(b.beats)).toBe(true);
      if (i) expect(b.t0).toBeCloseTo(blocks[i - 1].t1, 6);
      expect(b.t1).toBeLessThanOrEqual(138 + 1e-6);
    }
    // The cursor continues where this song stopped.
    expect(cur.i).toBeGreaterThan(0);
    const more = layout(grid(100), steps, cur, 1, 138);
    expect(more.length).toBeGreaterThan(0);
    // Rating windows, skipping the first span of each block; none in rests.
    const w = windows(g, blocks[1], 1);
    expect(w.length).toBeGreaterThan(2);
    const restBlocks = layout(g, program('hiit', 10), { i: 0, used: 0 }, 1, 138).filter((b) => b.rest);
    for (const rb of restBlocks) expect(windows(g, rb, 0)).toHaveLength(0);
  });

  it('stops at the session budget', () => {
    const g = grid(124);
    const blocks = layout(g, program('cardio', 1), { i: 0, used: 0 }, 1, 138, 60);
    const end = blocks[blocks.length - 1].t1;
    expect(end).toBeLessThanOrEqual(61 + 1e-6);
    expect(end).toBeGreaterThan(45);
  });
});
