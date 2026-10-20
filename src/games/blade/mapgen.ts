import { strengthNear, type Analysis } from '../../core/beat';

export type Difficulty = 'easy' | 'normal' | 'hard' | 'expert';
export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard', 'expert'];

/** Cut directions. Vectors are in world space: +x right, +y up. */
export enum Dir {
  Up = 0,
  Down = 1,
  Left = 2,
  Right = 3,
  UpLeft = 4,
  UpRight = 5,
  DownLeft = 6,
  DownRight = 7,
  Any = 8,
}

const S = Math.SQRT1_2;
export const DIR_VEC: Record<Dir, [number, number]> = {
  [Dir.Up]: [0, 1],
  [Dir.Down]: [0, -1],
  [Dir.Left]: [-1, 0],
  [Dir.Right]: [1, 0],
  [Dir.UpLeft]: [-S, S],
  [Dir.UpRight]: [S, S],
  [Dir.DownLeft]: [-S, -S],
  [Dir.DownRight]: [S, -S],
  [Dir.Any]: [0, 0],
};

export interface Note {
  t: number;
  /** 0 = left hand (red), 1 = right hand (blue). */
  hand: 0 | 1;
  /** 0..3 left to right. */
  col: number;
  /** 0..2 bottom to top. */
  row: number;
  dir: Dir;
}

export interface Bomb {
  t: number;
  col: number;
  row: number;
}

export type WallKind = 'left' | 'right' | 'top';

export interface Wall {
  t: number;
  dur: number;
  kind: WallKind;
}

export interface BeatMap {
  difficulty: Difficulty;
  bpm: number;
  duration: number;
  /** Seconds a block takes to fly from spawn to the player. */
  approach: number;
  notes: Note[];
  bombs: Bomb[];
  walls: Wall[];
}

interface Profile {
  approach: number;
  /** Target notes per second at full energy. */
  density: number;
  /** Minimum time between two notes for the same hand. */
  handGap: number;
  /** Minimum time between any two (non-simultaneous) notes. */
  anyGap: number;
  halfBeats: boolean;
  doubles: number;
  dots: number;
  diagonals: number;
  bombs: number;
  topRow: number;
}

export const PROFILES: Record<Difficulty, Profile> = {
  easy: { approach: 2.0, density: 0.8, handGap: 1.0, anyGap: 0.62, halfBeats: false, doubles: 0, dots: 0.55, diagonals: 0, bombs: 0, topRow: 0 },
  normal: { approach: 1.7, density: 1.35, handGap: 0.58, anyGap: 0.36, halfBeats: false, doubles: 0.07, dots: 0.12, diagonals: 0.2, bombs: 0, topRow: 0.05 },
  hard: { approach: 1.45, density: 2.0, handGap: 0.4, anyGap: 0.23, halfBeats: true, doubles: 0.12, dots: 0.04, diagonals: 0.3, bombs: 0.35, topRow: 0.1 },
  expert: { approach: 1.25, density: 2.7, handGap: 0.3, anyGap: 0.16, halfBeats: true, doubles: 0.2, dots: 0, diagonals: 0.35, bombs: 0.5, topRow: 0.15 },
};

export interface MapOptions {
  walls: boolean;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Candidate {
  t: number;
  score: number;
  energy: number;
}

/** Normalise the beat grid into a comfortable 70–158 BPM range. */
function playableBeats(a: Analysis): { beats: number[]; energy: number[] } {
  let beats = a.beats.slice();
  let energy = a.energy.slice();
  if (beats.length < 4) {
    const period = 60 / (a.bpm || 120);
    beats = [];
    for (let t = 1; t < a.duration - 1; t += period) beats.push(t);
    energy = beats.map(() => 0.7);
  }
  const period = (beats[beats.length - 1] - beats[0]) / Math.max(1, beats.length - 1);
  if (period < 0.38) {
    beats = beats.filter((_, i) => i % 2 === 0);
    energy = energy.filter((_, i) => i % 2 === 0);
  } else if (period > 0.86) {
    const nb: number[] = [];
    const ne: number[] = [];
    beats.forEach((b, i) => {
      nb.push(b);
      ne.push(energy[i]);
      if (i + 1 < beats.length) {
        nb.push((b + beats[i + 1]) / 2);
        ne.push(energy[i]);
      }
    });
    beats = nb;
    energy = ne;
  }
  return { beats, energy };
}

export function generateMap(a: Analysis, difficulty: Difficulty, opts: MapOptions): BeatMap {
  const p = PROFILES[difficulty];
  const rand = rng(Math.floor(a.duration * 1000) + DIFFICULTIES.indexOf(difficulty) * 7919);
  const { beats, energy } = playableBeats(a);
  const start = 1.2;
  const end = a.duration - 0.6;

  // 1. Candidate times on beats (and half-beats for harder levels).
  const cands: Candidate[] = [];
  beats.forEach((b, i) => {
    const e = energy[i] ?? 0.5;
    if (b >= start && b <= end) {
      cands.push({ t: b, score: strengthNear(a, b) + 0.15 + (i % 4 === 0 ? 0.1 : 0), energy: e });
    }
    if (p.halfBeats && i + 1 < beats.length) {
      const h = (b + beats[i + 1]) / 2;
      if (h >= start && h <= end) cands.push({ t: h, score: strengthNear(a, h) * 0.85, energy: e });
    }
  });

  // 2. Pick the strongest candidates per 4-second window, scaled by how loud that part of the song is.
  const chosen: Candidate[] = [];
  const windowLen = 4;
  for (let w0 = start; w0 < end; w0 += windowLen) {
    const inWin = cands.filter((c) => c.t >= w0 && c.t < w0 + windowLen && c.score > 0.18);
    if (!inWin.length) continue;
    const meanE = inWin.reduce((s, c) => s + c.energy, 0) / inWin.length;
    const quota = Math.round(p.density * windowLen * (0.45 + 0.8 * meanE));
    inWin.sort((x, y) => y.score * (0.6 + 0.4 * y.energy) - x.score * (0.6 + 0.4 * x.energy));
    let taken = 0;
    for (const c of inWin) {
      if (taken >= quota) break;
      if (chosen.some((o) => Math.abs(o.t - c.t) < p.anyGap)) continue;
      chosen.push(c);
      taken++;
    }
  }
  chosen.sort((x, y) => x.t - y.t);

  // 3. Assign hands, positions and directions with natural down/up swing flow per hand.
  const notes: Note[] = [];
  const lastT: [number, number] = [-Infinity, -Infinity];
  const nextDown: [boolean, boolean] = [true, true];
  const diagonal = (down: boolean, hand: 0 | 1): Dir => {
    const outward = rand() < 0.5;
    const left = hand === 0 ? outward : !outward;
    if (down) return left ? Dir.DownLeft : Dir.DownRight;
    return left ? Dir.UpLeft : Dir.UpRight;
  };
  const place = (t: number, hand: 0 | 1, forceDown?: boolean) => {
    if (t - lastT[hand] > 1.4) nextDown[hand] = true;
    const down = forceDown ?? nextDown[hand];
    let dir: Dir;
    if (rand() < p.dots) dir = Dir.Any;
    else if (rand() < p.diagonals) dir = diagonal(down, hand);
    else dir = down ? Dir.Down : Dir.Up;
    let row: number;
    const r = rand();
    if (down) row = r < 0.6 ? 1 : 0;
    else row = r < p.topRow ? 2 : r < 0.55 ? 0 : 1;
    const inner = rand() < 0.62;
    const col = hand === 0 ? (inner ? 1 : 0) : inner ? 2 : 3;
    notes.push({ t, hand, col, row, dir });
    lastT[hand] = t;
    nextDown[hand] = !down;
  };

  for (const c of chosen) {
    const free0 = c.t - lastT[0] >= p.handGap;
    const free1 = c.t - lastT[1] >= p.handGap;
    if (!free0 && !free1) continue;
    if (free0 && free1 && c.energy > 0.55 && rand() < p.doubles) {
      const down = nextDown[0] === nextDown[1] ? nextDown[0] : true;
      place(c.t, 0, down);
      place(c.t, 1, down);
      continue;
    }
    let hand: 0 | 1;
    if (free0 && free1) {
      const older: 0 | 1 = lastT[0] <= lastT[1] ? 0 : 1;
      hand = rand() < 0.82 ? older : older === 0 ? 1 : 0;
    } else hand = free0 ? 0 : 1;
    place(c.t, hand);
  }

  // 4. Walls to dodge, placed in calm stretches.
  const walls: Wall[] = [];
  if (opts.walls && difficulty !== 'easy') {
    const beat = 60 / (a.bpm || 120);
    const minSpacing = difficulty === 'normal' ? 18 : 12;
    const kinds: WallKind[] = ['left', 'right', 'top'];
    let lastWall = 6;
    for (let t = 8; t < end - 4; t += 0.5) {
      if (t - lastWall < minSpacing) continue;
      const dur = Math.max(0.9, Math.min(2.2, beat * (rand() < 0.5 ? 2 : 3)));
      const clearFrom = t - 0.7;
      const clearTo = t + dur + 0.6;
      const blocking = notes.filter((n) => n.t > clearFrom && n.t < clearTo).length;
      // Prefer quiet gaps; after a long stretch without one, make room by removing a few notes.
      if (blocking === 0 || t - lastWall > minSpacing * 1.6) {
        for (let i = notes.length - 1; i >= 0; i--) if (notes[i].t > clearFrom && notes[i].t < clearTo) notes.splice(i, 1);
        walls.push({ t, dur, kind: kinds[Math.floor(rand() * kinds.length)] });
        lastWall = t + dur;
      }
    }
  }

  // 5. Bombs in the gaps, kept away from where the next swings go.
  const bombs: Bomb[] = [];
  if (p.bombs > 0) {
    for (let i = 0; i + 1 < notes.length; i++) {
      const a0 = notes[i];
      const a1 = notes[i + 1];
      if (a1.t - a0.t < 0.5 || rand() > p.bombs) continue;
      const t = (a0.t + a1.t) / 2;
      const near = notes.filter((n) => Math.abs(n.t - t) < 0.8);
      const usedCols = new Set(near.map((n) => n.col));
      const options = [0, 3, 1, 2].filter((c) => !usedCols.has(c));
      if (!options.length) continue;
      const col = options[Math.floor(rand() * options.length)];
      if (walls.some((w) => t > w.t - 0.6 && t < w.t + w.dur + 0.6)) continue;
      bombs.push({ t, col, row: rand() < 0.5 ? 2 : 0 });
    }
  }

  return { difficulty, bpm: a.bpm, duration: a.duration, approach: p.approach, notes, bombs, walls };
}
