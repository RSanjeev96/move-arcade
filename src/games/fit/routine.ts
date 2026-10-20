/**
 * Workouts: programs of moves (with timings in seconds), laid onto each song's analysed beat grid as blocks of whole
 * move cycles, half- or double-timed to suit each move.
 */
import type { Analysis } from '../../core/beat';
import { MOVE, cycleBeats, lowImpact, tempoMult } from './moves';
import type { WorkoutType } from './plan';

export interface WorkoutDef {
  id: WorkoutType;
  name: string;
  desc: string;
  lengths: number[];
  def: number;
  colors: [string, string];
  /** Prefer slower or faster songs first. */
  pace: 'slow' | 'fast' | 'mixed';
  /** Key moves, shown on the menu. */
  show: string[];
}

export const WORKOUTS: Record<WorkoutType, WorkoutDef> = {
  warmup: {
    id: 'warmup',
    name: 'Warm-up',
    desc: 'Easy rhythm moves to wake up every joint',
    lengths: [5, 10],
    def: 5,
    colors: ['#ffb36b', '#ff5f8f'],
    pace: 'slow',
    show: ['march', 'armcircles', 'hipsway'],
  },
  cardio: {
    id: 'cardio',
    name: 'Cardio Dance',
    desc: 'Dance-party cardio with grapevines, jacks and kicks',
    lengths: [10, 20, 30],
    def: 20,
    colors: ['#ff2d6a', '#8a3bff'],
    pace: 'mixed',
    show: ['grapevine', 'jacks', 'pumps'],
  },
  hiit: {
    id: 'hiit',
    name: 'HIIT Blast',
    desc: 'All-out intervals with breathing breaks',
    lengths: [10, 15, 20],
    def: 15,
    colors: ['#ff8a3d', '#ff2d6a'],
    pace: 'fast',
    show: ['starjump', 'squat', 'highknees'],
  },
  boxing: {
    id: 'boxing',
    name: 'Boxing Cardio',
    desc: 'Jabs, hooks and uppercuts on the beat',
    lengths: [10, 20],
    def: 20,
    colors: ['#ff4b4b', '#ffb000'],
    pace: 'fast',
    show: ['jabcross', 'hooks', 'uppercut'],
  },
  cooldown: {
    id: 'cooldown',
    name: 'Cool-down & Stretch',
    desc: 'Slow down, stretch out and breathe',
    lengths: [5, 10],
    def: 5,
    colors: ['#1fb8ff', '#3bffb4'],
    pace: 'slow',
    show: ['overhead', 'sidebend', 'quad'],
  },
};

export const WORKOUT_ORDER: WorkoutType[] = ['warmup', 'cardio', 'hiit', 'boxing', 'cooldown'];
export const ALL_LENGTHS = [5, 10, 15, 20, 30];

export interface Step {
  move: string;
  sec: number;
  rest?: boolean;
}

function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The ordered list of moves and rests for a workout of `minutes`. Deterministic for a seed. */
export function program(type: WorkoutType, minutes: number, opts: { lowImpact?: boolean; seed?: number } = {}): Step[] {
  const total = Math.max(30, minutes * 60);
  const r = rng(opts.seed ?? 7);
  const out: Step[] = [];
  let used = 0;
  const push = (move: string, sec: number, rest = false) => {
    const left = total - used;
    if (left < 6) return false;
    const s = Math.min(sec, left);
    out.push({ move: lowImpact(move, !!opts.lowImpact), sec: s, rest });
    used += s;
    return true;
  };
  const fill = (seq: [string, number][], until: number) => {
    let i = 0;
    while (used < until - 6 && i < 999) {
      const [m, s] = seq[i % seq.length];
      if (!push(m, Math.min(s, until - used))) break;
      i++;
    }
  };
  const short = minutes <= 6;

  switch (type) {
    case 'warmup': {
      fill(
        [
          ['march', 28],
          ['steptouch', 28],
          ['armcircles', 26],
          ['hipsway', 26],
          ['sidereach', 26],
          ['kneetwist', 28],
          ['pumps', 26],
          ['grapevine', 28],
        ],
        total,
      );
      break;
    }
    case 'cardio': {
      const warm = short ? 20 : 45;
      const cool = short ? 0 : 35;
      fill(
        [
          ['march', 22],
          ['steptouch', 23],
        ],
        warm,
      );
      const pairs: [string, string][] = [
        ['grapevine', 'jacks'],
        ['hipsway', 'highknees'],
        ['pumps', 'starjump'],
        ['kneetwist', 'kick'],
        ['steptouch', 'sidelunge'],
        ['grapevine', 'squat'],
      ];
      const start = Math.floor(r() * pairs.length);
      const seq: [string, number][] = [];
      for (let k = 0; k < pairs.length; k++) {
        const [a, b] = pairs[(start + k) % pairs.length];
        seq.push([a, 24], [b, 24]);
      }
      fill(seq, total - cool);
      if (cool)
        fill(
          [
            ['steptouch', 20],
            ['breathe', 15],
          ],
          total,
        );
      break;
    }
    case 'hiit': {
      const work = short ? 30 : 40;
      const rest = short ? 15 : 20;
      const warm = short ? 0 : 50;
      if (warm)
        fill(
          [
            ['march', 25],
            ['stepjacks', 25],
          ],
          warm,
        );
      const pool = ['jacks', 'squat', 'highknees', 'starjump', 'sidelunge', 'jabcross', 'kick', 'pumps'];
      const off = Math.floor(r() * pool.length);
      let k = 0;
      while (total - used >= work + 6 && k < 99) {
        push(pool[(off + k) % pool.length], work);
        if (total - used >= rest + 20) push('breathe', rest, true);
        k++;
      }
      fill([['breathe', 20]], total);
      break;
    }
    case 'boxing': {
      const warm = short ? 20 : 45;
      fill(
        [
          ['shuffle', 22],
          ['armcircles', 23],
        ],
        warm,
      );
      fill(
        [
          ['jabcross', 30],
          ['hooks', 28],
          ['shuffle', 16],
          ['uppercut', 28],
          ['bobweave', 22],
          ['jabcross', 28],
          ['kick', 28],
          ['hooks', 26],
          ['shuffle', 16],
          ['uppercut', 26],
        ],
        total - (short ? 0 : 30),
      );
      fill(
        [
          ['shoulder', 20],
          ['breathe', 12],
        ],
        total,
      );
      break;
    }
    case 'cooldown': {
      fill(
        [
          ['march', 25],
          ['breathe', 18],
          ['overhead', 25],
          ['sidebend', 38],
          ['shoulder', 38],
          ['quad', 38],
          ['sidereach', 26],
          ['armcircles', 22],
          ['overhead', 22],
          ['breathe', 18],
        ],
        total,
      );
      break;
    }
  }
  return out;
}

// ---- beat grid -----------------------------------------------------------------------------------

export type Grid = Pick<Analysis, 'beats' | 'bpm' | 'duration'>;

/** Fractional beat index at song time t (extrapolated outside the tracked beats). */
export function beatAt(a: Grid, t: number): number {
  const b = a.beats;
  const period = 60 / (a.bpm || 120);
  if (!b.length) return t / period;
  if (t <= b[0]) return (t - b[0]) / period;
  const n = b.length;
  if (t >= b[n - 1]) return n - 1 + (t - b[n - 1]) / period;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (b[m] <= t) lo = m;
    else hi = m;
  }
  return lo + (t - b[lo]) / (b[hi] - b[lo]);
}

/** Song time of a fractional beat index. */
export function timeAtBeat(a: Grid, x: number): number {
  const b = a.beats;
  const period = 60 / (a.bpm || 120);
  if (!b.length) return x * period;
  const n = b.length;
  if (x <= 0) return b[0] + x * period;
  if (x >= n - 1) return b[n - 1] + (x - (n - 1)) * period;
  const i = Math.floor(x);
  return b[i] + (b[i + 1] - b[i]) * (x - i);
}

/** Beats synthesised from the tempo when the analysis found none. */
export function ensureGrid(a: Grid): Grid {
  if (a.beats.length >= 16) return a;
  const period = 60 / (a.bpm || 120);
  const beats: number[] = [];
  for (let t = 0.5; t < a.duration - 0.2; t += period) beats.push(t);
  return { ...a, beats };
}

// ---- laying out blocks -------------------------------------------------------------------------

export interface Block {
  move: string;
  /** Song times. */
  t0: number;
  t1: number;
  /** Song beat index where the block starts. */
  b0: number;
  /** Move beats per song beat. */
  mult: number;
  /** Number of song beats. */
  beats: number;
  rest: boolean;
}

export interface Cursor {
  /** Index of the current program step. */
  i: number;
  /** Seconds of that step already used. */
  used: number;
}

/**
 * Lays program steps onto a song's beat grid from song time `from` up to `to`, stopping early when the session
 * budget (seconds of song time available) runs out. Advances the cursor.
 */
export function layout(a: Grid, steps: Step[], cur: Cursor, from: number, to: number, budget = Infinity): Block[] {
  const blocks: Block[] = [];
  let b = Math.ceil(beatAt(a, from) - 1e-6);
  const endT = Math.min(to, from + budget);
  while (cur.i < steps.length) {
    const st = steps[cur.i];
    const m = MOVE[st.move];
    if (!m) {
      cur.i++;
      cur.used = 0;
      continue;
    }
    const mult = tempoMult(m, a.bpm);
    const cyc = cycleBeats(m);
    const remaining = st.sec - cur.used;
    const t0 = timeAtBeat(a, b);
    const secPerCycle = (cyc / mult) * (60 / a.bpm);
    let cycles = Math.max(1, Math.round(remaining / secPerCycle));
    const room = endT - t0;
    const fit = Math.floor((room + 0.05) / secPerCycle);
    let last = false;
    if (cycles > fit) {
      cycles = fit;
      last = true;
    }
    // Song beats per block must be whole.
    while (cycles > 0 && Math.abs((cycles * cyc) / mult - Math.round((cycles * cyc) / mult)) > 1e-6) cycles--;
    if (cycles < 1 || cycles * secPerCycle < Math.min(6, remaining)) break;
    const beats = Math.round((cycles * cyc) / mult);
    const t1 = timeAtBeat(a, b + beats);
    blocks.push({ move: m.id, t0, t1, b0: b, mult, beats, rest: !!st.rest });
    b += beats;
    cur.used += t1 - t0;
    if (cur.used >= st.sec - Math.min(6, secPerCycle * 0.6)) {
      cur.i++;
      cur.used = 0;
    }
    if (last) break;
  }
  return blocks;
}

export interface JudgeWindow {
  t0: number;
  t1: number;
  block: number;
  /** Move beats from the block start covered by this window. */
  mb0: number;
  mb1: number;
}

/** Rating windows for a block: every `judge` move beats, skipping the first (the switch into the move). */
export function windows(a: Grid, bl: Block, index: number): JudgeWindow[] {
  if (bl.rest) return [];
  const m = MOVE[bl.move];
  const jb = m.judge ?? m.beats;
  const out: JudgeWindow[] = [];
  const moveBeats = bl.beats * bl.mult;
  for (let k = 1; (k + 1) * jb <= moveBeats + 1e-6; k++) {
    out.push({ t0: timeAtBeat(a, bl.b0 + (k * jb) / bl.mult), t1: timeAtBeat(a, bl.b0 + ((k + 1) * jb) / bl.mult), block: index, mb0: k * jb, mb1: (k + 1) * jb });
  }
  return out;
}
