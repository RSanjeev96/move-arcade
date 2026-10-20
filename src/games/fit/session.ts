/**
 * One workout: songs played back to back, each laid out with move blocks on its beat grid. The coach performs every
 * move in sync, the player is judged per rating window with a ±200 ms offset search, reps and calories are counted,
 * and the HUD shows the timeline of upcoming moves.
 */
import * as THREE from 'three';
import type { AudioEngine } from '../../core/audio';
import type { Body, BodyTracker } from '../../core/body';
import { handsUp, Hold } from '../../core/gestures';
import { SimPose, type SimParams } from '../../core/pose';
import { Renderer3D } from '../../core/render';
import type { Settings } from '../../core/settings';
import type { PoseSource } from '../../core/types';
import { CamPreview, HandsUpPause, esc, pauseMenu } from '../../ui/kit';
import { effectiveMet, effortFromMet, estHeartRate, intensity, kcal, motionEnergy, REST_MET, zoneFor, ZONES } from './calories';
import { kindColors, pictogram } from './cards';
import { Coach, type CoachId } from './coach';
import { MOVE, NEUTRAL, blendPose, cycleBeats, repsBetween, sampleMove, type MoveDef, type Pose } from './moves';
import type { WorkoutType } from './plan';
import { obsFromBody, obsFromJoints, solve, toSim, type Obs } from './rig';
import type { Track } from './music';
import { WORKOUTS, beatAt, ensureGrid, layout, program, windows, type Block, type Cursor, type Grid, type JudgeWindow, type Step } from './routine';
import { ObsBuffer, ScoreKeeper, judgeWindow, type Rating } from './score';
import { FitSfx, Voice } from './sfx';
import { Stage } from './stage';

export interface SessionContext {
  root: HTMLElement;
  pose: PoseSource;
  body: BodyTracker;
  audio: AudioEngine;
  settings: Settings;
  demo: boolean;
  cursor: (on: boolean) => void;
}

export interface SessionConfig {
  type: WorkoutType;
  minutes: number;
  lowImpact: boolean;
  /** Playlist: the first track is loaded, the others may still be loading. */
  tracks: Track[];
  coach: Coach;
  coachId: CoachId;
  weightKg: number;
  age: number | null;
  voice: boolean;
  seed: number;
}

export interface SessionResult {
  type: WorkoutType;
  minutes: number;
  target: number;
  kcal: number;
  score: number;
  stars: number;
  grade: string;
  accuracy: number;
  maxCombo: number;
  ratings: Record<Rating, number>;
  reps: Record<string, number>;
  completed: boolean;
  moves: number;
}

export type SessionOutcome = { kind: 'done'; result: SessionResult } | { kind: 'quit'; result: SessionResult | null } | { kind: 'restart' };

interface PlanState {
  cur: Cursor;
  used: number;
  sessionT: number;
}

interface Part {
  track: Track;
  /** Index into the playlist. */
  k: number;
  /** Laid out on a tempo-only grid because the song is still loading. */
  provisional: boolean;
  before: PlanState;
  grid: Grid;
  blocks: Block[];
  wins: JudgeWindow[];
  start: number;
  end: number;
  playFrom: number;
  leadIn: number;
  /** Session time = offset + song time. */
  offset: number;
}

interface Card {
  part: number;
  block: number;
  move: string;
  rest: boolean;
  s0: number;
  s1: number;
}

const RATING_TEXT: Record<Rating, string> = { perfect: 'Perfect!', great: 'Great', ok: 'OK', miss: 'Miss' };
const TIPS = ['Mirror the coach — move like a reflection', 'Stand back so your whole body is in view', 'Raise both hands and hold to pause'];

const fmt = (s: number) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export class FitSession {
  private r3!: Renderer3D;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 16 / 9, 0.1, 90);
  private stage!: Stage;
  private coach: Coach;
  private el!: HTMLElement;
  private hud: Record<string, HTMLElement> = {};
  private cam!: CamPreview;
  private parts: Part[] = [];
  private cards: Card[] = [];
  private total = 0;
  private pi = 0;
  private wi = 0;
  private raf = 0;
  private last = 0;
  private lastPoseT = 0;
  private latestBody: Body | null = null;
  private buffer = new ObsBuffer(6);
  private leanRef = 0;
  private scorer = new ScoreKeeper();
  private reps: Record<string, number> = {};
  private blockReps = 0;
  private repBlock = '';
  private moveLean = new Map<string, number>();
  private kcalTotal = 0;
  private effort = 0;
  private inten = 0.8;
  private energyAt = 0;
  private paused = false;
  private finished = false;
  private resolve!: (o: SessionOutcome) => void;
  private handsPause = new HandsUpPause();
  private longHold = new Hold(3000);
  private sfx: FitSfx;
  private voice: Voice;
  private lastHud: Record<string, string> = {};
  private cardEls = new Map<number, HTMLElement>();
  private curCard = -1;
  private noLegsSince = 0;
  private lostSince = 0;
  private lastCount = '';
  private shownScore = 0;
  private fpsAvg = 60;
  private judgedMoves = new Set<string>();
  private musicTarget = -1;
  private flags = new Set<string>();
  private botSloppy = 0;
  private lastT = -1e9;
  private coachYaw = 0;
  private frames = 0;

  constructor(
    private ctx: SessionContext,
    private cfg: SessionConfig,
  ) {
    this.coach = cfg.coach;
    this.sfx = new FitSfx(ctx.audio);
    this.voice = new Voice(cfg.voice && !ctx.demo);
  }

  run(): Promise<SessionOutcome> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.plan();
      this.build();
      void this.warmUp().then(() => this.begin());
    });
  }

  /** Compile shaders (in parallel where supported) and draw a first frame before the music starts. */
  private async warmUp(): Promise<void> {
    this.hud.center.textContent = 'Get ready';
    this.hud.center.className = 'fh-center show';
    try {
      this.coach.pose(solve(this.poseAt(this.parts[0] ?? this.part, -5)));
      this.stage.update(0.016, 0, 0, 0.3, 0);
      await this.r3.renderer.compileAsync(this.scene, this.camera);
      this.r3.render(0);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    } catch {
      /* not fatal: shaders compile on first use instead */
    }
  }

  // ---- planning ---------------------------------------------------------------------------------

  private steps: Step[] = [];
  private budget = 0;
  private replanSoon = false;
  private waitingTrack = false;

  private plan(): void {
    this.steps = program(this.cfg.type, this.cfg.minutes, { lowImpact: this.cfg.lowImpact, seed: this.cfg.seed });
    this.budget = this.steps.reduce((a, s) => a + s.sec, 0);
    this.layoutFrom(0, { cur: { i: 0, used: 0 }, used: 0, sessionT: 0 }, 0);
    for (const t of this.cfg.tracks) {
      if (!t.song)
        void t.ready.then(() => {
          if (!this.finished) this.replanSoon = true;
        });
    }
  }

  /** Lay the remaining program onto the playlist, starting with part `from` and playlist index `k`. */
  private layoutFrom(from: number, st: PlanState, k: number): void {
    const tracks = this.cfg.tracks;
    const cur: Cursor = { ...st.cur };
    let used = st.used;
    let sessionT = st.sessionT;
    let empty = 0;
    this.parts.length = from;
    this.cards = this.cards.filter((c) => c.part < from);
    while (cur.i < this.steps.length && this.parts.length < 60 && empty < tracks.length + 2) {
      const track = tracks[k % tracks.length];
      const ki = k % tracks.length;
      k++;
      if (track.failed) {
        empty++;
        continue;
      }
      const provisional = !track.song;
      const duration = track.song ? track.song.buffer.duration : (track.info.duration ?? 140);
      const grid = track.song ? ensureGrid(track.song.analysis) : ensureGrid({ beats: [], bpm: track.info.bpm ?? 120, duration });
      const fromT = Math.max(0.8, grid.beats[0] ?? 0.8);
      const toT = Math.min(duration - 1.2, grid.beats[grid.beats.length - 1] ?? duration);
      const before: PlanState = { cur: { ...cur }, used, sessionT };
      const blocks = layout(grid, this.steps, cur, fromT, toT, this.budget - used + 0.5);
      if (!blocks.length) {
        empty++;
        continue;
      }
      empty = 0;
      const start = blocks[0].t0;
      const end = blocks[blocks.length - 1].t1;
      used += end - start;
      const first = this.parts.length === 0;
      const leadIn = first ? 4 : 1.6;
      const playFrom = Math.max(0, start - (first ? 1.2 : 1.0));
      const gap = first ? 0 : leadIn + (start - playFrom);
      const offset = sessionT + gap - start;
      const wins: JudgeWindow[] = [];
      blocks.forEach((b, i) => wins.push(...windows(grid, b, i)));
      const pIdx = this.parts.length;
      this.parts.push({ track, k: ki, provisional, before, grid, blocks, wins, start, end, playFrom, leadIn, offset });
      blocks.forEach((b, i) => this.cards.push({ part: pIdx, block: i, move: b.move, rest: b.rest, s0: offset + b.t0, s1: offset + b.t1 }));
      sessionT = offset + end;
    }
    this.total = sessionT;
    for (const m of new Set(this.cards.map((c) => c.move))) {
      if (this.moveLean.has(m)) continue;
      const def = MOVE[m];
      let acc = 0;
      const n = 16;
      for (let i = 0; i < n; i++) acc += obsFromJoints(solve(sampleMove(def, (i / n) * cycleBeats(def)))).lean;
      this.moveLean.set(m, acc / n);
    }
  }

  /** A song finished loading: lay out the parts after the current one on real beat grids. */
  private replan(): void {
    this.replanSoon = false;
    const from = this.pi + 1;
    if (from >= this.parts.length && !this.waitingTrack) return;
    if (!this.parts.slice(from).some((p) => p.provisional) && !this.waitingTrack) return;
    const cur = this.parts[this.pi];
    const next = this.parts[from];
    const st: PlanState = next ? { ...next.before, sessionT: cur.offset + cur.end } : { cur: { i: this.steps.length, used: 0 }, used: this.budget, sessionT: cur.offset + cur.end };
    this.layoutFrom(from, st, next ? next.k : cur.k + 1);
    for (const m of new Set(this.cards.map((c) => c.move))) pictogram(m);
    this.curCard = -1;
  }

  // ---- setup ------------------------------------------------------------------------------------

  private build(): void {
    const w = WORKOUTS[this.cfg.type];
    for (const m of new Set(this.cards.map((c) => c.move))) pictogram(m);
    this.el = document.createElement('div');
    this.el.className = 'fit fit-play';
    this.el.innerHTML = `
      <canvas class="fit-gl"></canvas>
      <div class="fit-vignette"></div>
      <div class="ghud fit-hud">
        <div class="fh-rest"><div class="fh-breath"><i></i><b>Breathe in</b></div><div class="fh-rest-r"><div class="fh-rest-t"><span>Rest</span><b>0:20</b></div><div class="fh-rest-next"></div></div></div>
        <div class="fh-move">
          <div class="fh-kind">${esc(w.name)}</div>
          <div class="fh-name"></div>
          <div class="fh-cue"></div>
          <div class="fh-beats">${'<i></i>'.repeat(8)}</div>
          <div class="fh-next"></div>
        </div>
        <div class="fh-time">
          <div class="fh-clock"><b>0:00</b><span>left</span></div>
          <div class="fh-prog"><i></i></div>
          <div class="fh-elapsed"></div>
        </div>
        <div class="fh-score">
          <b>0</b>
          <div class="fh-combo"><span class="fh-mult">×1.0</span><span class="fh-cn">0 combo</span></div>
        </div>
        <div class="fh-side">
          <div class="fh-card fh-reps"><div class="fh-ico">↻</div><div><b>0</b><span>reps</span></div><em></em></div>
          <div class="fh-card fh-kcal"><div class="fh-ico">🔥</div><div><b>0</b><span>kcal · est.</span></div></div>
          <div class="fh-card fh-zone"><div class="fh-zbar">${ZONES.map((z) => `<i style="--zc:${z.color}"></i>`).join('')}</div><div><b>Zone 1</b><span>Warm-up</span><small></small></div></div>
        </div>
        <div class="fh-rating"></div>
        <div class="fh-tip"></div>
        <div class="fh-hint"></div>
        <div class="fh-lane"><div class="fh-now"></div></div>
        <button class="fh-pause" data-hc aria-label="Pause">❚❚</button>
        <div class="fh-gap"><span>Next track</span><b></b></div>
        <div class="fh-center"></div>
      </div>`;
    this.ctx.root.appendChild(this.el);
    const q = (s: string) => this.el.querySelector(s) as HTMLElement;
    for (const [k, s] of Object.entries({
      name: '.fh-name',
      cue: '.fh-cue',
      beats: '.fh-beats',
      next: '.fh-next',
      clock: '.fh-clock b',
      prog: '.fh-prog i',
      elapsed: '.fh-elapsed',
      score: '.fh-score > b',
      mult: '.fh-mult',
      combo: '.fh-cn',
      reps: '.fh-reps b',
      repsL: '.fh-reps span',
      repsOf: '.fh-reps em',
      repsBox: '.fh-reps',
      kcal: '.fh-kcal b',
      zoneBar: '.fh-zbar',
      zone: '.fh-zone b',
      zoneL: '.fh-zone span',
      zoneHr: '.fh-zone small',
      rating: '.fh-rating',
      tip: '.fh-tip',
      hint: '.fh-hint',
      lane: '.fh-lane',
      rest: '.fh-rest',
      breath: '.fh-breath',
      breathT: '.fh-breath b',
      restT: '.fh-rest-t b',
      restNext: '.fh-rest-next',
      gap: '.fh-gap',
      gapT: '.fh-gap b',
      center: '.fh-center',
      move: '.fh-move',
    }))
      this.hud[k] = q(s);
    q('.fh-pause').addEventListener('click', () => void this.pause());
    this.cam = new CamPreview(this.ctx.pose);
    if (this.ctx.settings.showCamera) q('.fit-hud').appendChild(this.cam.canvas);

    const canvas = q('.fit-gl') as HTMLCanvasElement;
    this.r3 = new Renderer3D(canvas, this.scene, this.camera, this.ctx.settings.quality, {
      bloom: { strength: 0.5, radius: 0.55, threshold: 0.86 },
      exposure: 0.95,
      shadows: true,
    });
    this.stage = new Stage(this.scene, this.r3.currentLevel);
    this.stage.setPalette(w.colors[0], w.colors[1]);
    this.scene.add(this.coach.group);
    this.coach.group.traverse((o) => o.layers.enable(1));
    this.stage.setCamera(this.camera);
    this.coach.group.position.set(0, 0, 0);
    this.stage.key.target = this.coach.group;
    this.camera.position.set(0, 1.15, 5.9);
    this.camera.lookAt(0, 0.88, 0);
    this.r3.resize();

    if (this.ctx.demo && this.ctx.pose instanceof SimPose) {
      const sim = this.ctx.pose;
      sim.drive = (t) => this.botDrive(t);
    }
  }

  private begin(): void {
    const a = this.ctx.audio;
    a.offsetMs = this.ctx.settings.audioOffset;
    a.sfx.gain.value = this.ctx.settings.sfxVolume;
    a.music.gain.cancelScheduledValues(a.ctx.currentTime);
    a.music.gain.value = this.ctx.settings.musicVolume;
    const p = this.parts[0];
    if (!p || !p.track.song) {
      this.finish();
      return;
    }
    a.playSong(p.track.song.buffer, p.leadIn, p.playFrom);
    p.offset = this.sessionAtStart(p);
    this.ctx.cursor(false);
    this.last = performance.now();
    this.lastPoseT = performance.now();
    this.voice.say(`${WORKOUTS[this.cfg.type].name}. Get ready!`, true);
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Offset that makes session time 0 the first block of the first part. */
  private sessionAtStart(p: Part): number {
    return -p.start;
  }

  // ---- timeline -----------------------------------------------------------------------------------

  private get part(): Part {
    return this.parts[this.pi];
  }

  private blockAt(p: Part, st: number): number {
    const bl = p.blocks;
    if (!bl.length || st < bl[0].t0 || st >= bl[bl.length - 1].t1) return -1;
    let lo = 0;
    let hi = bl.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (bl[m].t0 <= st) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  private idlePose(beat: number): Pose {
    const b = beat - Math.floor(beat);
    const bounce = 0.5 - 0.5 * Math.cos(b * Math.PI * 2);
    const sway = Math.sin(beat * Math.PI) * 0.05;
    return {
      ...NEUTRAL,
      py: -0.07 * bounce,
      px: sway,
      lw: [-0.66 - sway, -1.45, 0.25],
      rw: [0.66 - sway, -1.45, 0.25],
      rf: [0.1, 0, 0],
      lf: [-0.1, 0, 0],
      head: 0.04 * bounce,
    };
  }

  /** The coach's pose at song time st of part p (blending into each new move over its first beat). */
  poseAt(p: Part, st: number): Pose {
    const beat = beatAt(p.grid, st);
    const i = this.blockAt(p, st);
    if (i < 0) {
      // Before the first block: idle, easing into the first move over the last beat.
      const idle = this.idlePose(beat);
      const first = p.blocks[0];
      if (first && st < first.t0) {
        const k = beat - (first.b0 - 1);
        if (k > 0) return blendPose(idle, sampleMove(MOVE[first.move], 0), k);
      }
      return idle;
    }
    const b = p.blocks[i];
    const phase = (beat - b.b0) * b.mult;
    const pose = sampleMove(MOVE[b.move], phase);
    if (phase < 1) {
      const prev = i > 0 ? p.blocks[i - 1] : null;
      const from = prev ? sampleMove(MOVE[prev.move], (beat - prev.b0) * prev.mult) : this.idlePose(beat);
      return blendPose(from, pose, Math.max(0, phase));
    }
    if (i === p.blocks.length - 1) {
      const toEnd = (b.b0 + b.beats - beat) * b.mult;
      if (toEnd < 1) return blendPose(this.idlePose(beat), pose, toEnd);
    }
    return pose;
  }

  private targetObs(p: Part, t: number): Obs {
    return obsFromJoints(solve(this.poseAt(p, t)), t);
  }

  // ---- main loop ------------------------------------------------------------------------------------

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    this.frames++;
    const dtRaw = Math.min(0.5, Math.max(0, (now - this.last) / 1000));
    const dt = Math.min(0.05, dtRaw);
    this.last = now;
    if (dt > 0) this.fpsAvg += 0.05 * (1 / Math.max(dt, 1e-3) - this.fpsAvg);
    const a = this.ctx.audio;
    const p = this.part;
    const st = a.songTime();
    const T = p.offset + st;

    if (this.replanSoon) this.replan();
    this.processPose(st);
    if (!this.paused && !this.finished) {
      this.judge(st);
      this.track(st, T);
      this.checkPause(now);
      if (st >= p.end) {
        if (this.pi < this.parts.length - 1) this.nextPart(T);
        else this.finish();
      }
    }
    this.updateMusic(st, T);
    this.updateVisuals(dt, dtRaw, st, now);
    this.updateHud(st, T, now);
    this.r3.render(dt);
  };

  private nextPart(T: number): void {
    const a = this.ctx.audio;
    const next = this.parts[this.pi + 1];
    if (!next.track.song) {
      // Still loading (slow device): hold in the gap until it is ready.
      this.waitingTrack = true;
      return;
    }
    this.waitingTrack = false;
    this.pi++;
    this.wi = 0;
    this.buffer.clear();
    const p = this.part;
    a.music.gain.cancelScheduledValues(a.ctx.currentTime);
    a.music.gain.value = this.ctx.settings.musicVolume;
    this.musicTarget = -1;
    a.playSong(p.track.song!.buffer, p.leadIn, p.playFrom);
    const planned = p.offset;
    p.offset = T + (p.start - p.playFrom) + p.leadIn - p.start;
    const shift = p.offset - planned;
    for (let k = this.pi + 1; k < this.parts.length; k++) this.parts[k].offset += shift;
    for (const c of this.cards) if (c.part >= this.pi) {
      c.s0 += shift;
      c.s1 += shift;
    }
    this.total += shift;
    this.lastPoseT = performance.now();
  }

  private processPose(st: number): void {
    const frames = this.ctx.pose.since(this.lastPoseT);
    for (const f of frames) {
      this.lastPoseT = f.t;
      const b = this.ctx.body.measure(f);
      this.latestBody = b;
      if (this.paused || this.finished) continue;
      const s = this.ctx.audio.songTimeAt(f.t);
      const o = obsFromBody(b, s);
      this.buffer.push(o);
      if (b.ok) this.leanRef += (b.lean - this.leanRef) * 0.012;
    }
    void st;
  }

  private judgeOpts(m: MoveDef) {
    return {
      legs: !!m.legs || m.focus.includes('knees') || m.focus.includes('feet'),
      focus: m.focus,
      playerLeanRef: this.leanRef,
      targetLeanRef: this.moveLean.get(m.id) ?? 0,
    };
  }

  private judge(st: number): void {
    const p = this.part;
    while (this.wi < p.wins.length) {
      const w = p.wins[this.wi];
      if (!(this.buffer.latestT >= w.t1 + 0.22 || st >= w.t1 + 0.6)) break;
      this.wi++;
      const m = MOVE[p.blocks[w.block].move];
      // No camera frames at all for this window (the app stalled): do not count it either way.
      if (!this.buffer.list.some((o) => o.t >= w.t0 - 0.25 && o.t <= w.t1 + 0.25)) continue;
      const j = judgeWindow((t) => this.targetObs(p, t), (t) => this.buffer.at(t), w.t0, w.t1, this.judgeOpts(m));
      this.scorer.add(j);
      this.judgedMoves.add(`${this.pi}:${w.block}`);
      this.feedback(j.rating);
      // Reps count when the window holding them was done well enough (OK or better).
      if (m.rep) {
        const key = `${this.pi}:${w.block}`;
        if (key !== this.repBlock) {
          this.repBlock = key;
          this.blockReps = 0;
        }
        const n = j.rating === 'miss' ? 0 : repsBetween(m, w.mb0, w.mb1);
        if (n > 0) {
          this.blockReps += n;
          this.reps[m.rep.label] = (this.reps[m.rep.label] ?? 0) + n;
          this.sfx.rep();
          this.hud.repsBox.classList.remove('bump');
          void this.hud.repsBox.offsetWidth;
          this.hud.repsBox.classList.add('bump');
        }
      }
    }
  }

  private feedback(r: Rating): void {
    const el = document.createElement('div');
    el.className = `fh-pop r-${r}`;
    el.textContent = RATING_TEXT[r];
    this.hud.rating.replaceChildren(el);
    this.sfx.rating(r, this.scorer.combo);
    const [ca, cb] = this.stage.palette;
    if (r === 'perfect') {
      const head = this.coach.headPosition(new THREE.Vector3());
      this.stage.burst(head.clone().add(new THREE.Vector3(-0.75, -0.3, 0.2)), ca, 8, 1.8, 0.8);
      this.stage.burst(head.clone().add(new THREE.Vector3(0.75, -0.3, 0.2)), cb, 8, 1.8, 0.8);
      this.stage.flash(0.35);
    }
    const c = this.scorer.combo;
    if (c > 0 && c % 10 === 0) {
      this.stage.flash(1);
      this.stage.burst(new THREE.Vector3(0, 0.15, 0.4), new THREE.Color('#ffd04d'), 46, 3.0, 2.0);
      const b = document.createElement('div');
      b.className = 'fh-pop r-combo';
      b.textContent = `${c} combo!`;
      this.hud.rating.appendChild(b);
      if (c % 20 === 0) this.voice.say(['Amazing!', 'You are on fire!', 'Keep it up!'][(c / 20) % 3]);
    }
  }

  /** Effort, intensity and calories. */
  private track(st: number, T: number): void {
    // Session-time step: frame-rate independent and frozen while paused.
    const dt = Math.max(0, Math.min(1.5, T - this.lastT));
    this.lastT = T;
    const p = this.part;
    const i = this.blockAt(p, st);
    const block = i >= 0 ? p.blocks[i] : null;
    const m = block ? MOVE[block.move] : null;
    const now = performance.now();
    if (now - this.energyAt > 250 && T > 0) {
      this.energyAt = now;
      const recent = this.buffer.list.filter((o) => o.t > st - 1.5);
      const pe = motionEnergy(recent);
      const coach: Obs[] = [];
      for (let k = 0; k <= 15; k++) coach.push(this.targetObs(p, st - 1.5 + k * 0.1));
      const ce = motionEnergy(coach);
      const target = intensity(pe, ce);
      this.inten += (target - this.inten) * 0.25;
    }
    if (T < 0 || T > this.total) return;
    const met = m ? (block!.rest ? MOVE.breathe.met : m.met) : REST_MET + 0.6;
    const eff = effectiveMet(met, this.inten);
    this.kcalTotal += kcal(eff, this.cfg.weightKg, dt);
    const e = effortFromMet(eff);
    const k = 1 - Math.exp(-dt / (e > this.effort ? 12 : 18));
    this.effort += (e - this.effort) * k;
  }

  private checkPause(now: number): void {
    if (this.ctx.demo) return;
    const b = this.latestBody;
    const p = this.part;
    const st = this.ctx.audio.songTime();
    const i = this.blockAt(p, st);
    const j = this.blockAt(p, st + 1.5);
    const overhead = (i >= 0 && MOVE[p.blocks[i].move].overhead) || (j >= 0 && MOVE[p.blocks[j].move].overhead);
    if (overhead) {
      if (this.longHold.update(!!b && handsUp(b), now) >= 1) {
        this.longHold.reset();
        void this.pause();
      }
    } else {
      this.longHold.reset();
      if (this.handsPause.update(b, now)) void this.pause();
    }
  }

  private updateMusic(st: number, T: number): void {
    const a = this.ctx.audio;
    const vol = this.ctx.settings.musicVolume;
    const p = this.part;
    const i = this.blockAt(p, st);
    let want = vol;
    if (i >= 0 && p.blocks[i].rest) want = vol * 0.4;
    if (this.finished) want = 0;
    else if (this.pi < this.parts.length - 1 && st > p.end - 1.2) want = 0;
    else if (this.pi === this.parts.length - 1 && st > p.end - 0.3) want = vol * 0.6;
    void T;
    if (Math.abs(want - this.musicTarget) > 0.005 && !this.paused) {
      this.musicTarget = want;
      a.music.gain.cancelScheduledValues(a.ctx.currentTime);
      a.music.gain.setTargetAtTime(want, a.ctx.currentTime, want < vol * 0.5 ? 0.35 : 0.2);
    }
  }

  // ---- visuals --------------------------------------------------------------------------------------

  private updateVisuals(dt: number, dtRaw: number, st: number, now: number): void {
    const p = this.part;
    const pose = this.poseAt(p, st);
    this.coach.pose(solve(pose));
    // Turn the coach a little for moves that happen in depth (punches, kicks, squats).
    const bi = this.blockAt(p, st + 0.3);
    const yawT = bi >= 0 ? (MOVE[p.blocks[bi].move].view ?? 0) * 0.6 : 0;
    this.coachYaw += (yawT - this.coachYaw) * (1 - Math.exp(-dt * 3));
    this.coach.group.rotation.y = this.coachYaw;
    const beat = beatAt(p.grid, st);
    const playing = st > 0 && st < p.track.song!.buffer.duration;
    const frac = beat - Math.floor(beat);
    const pulse = playing ? Math.exp(-frac * 5) : 0;
    const a = p.track.song!.analysis;
    const energy = playing ? (a.energy[Math.max(0, Math.min(a.energy.length - 1, Math.floor(beat)))] ?? 0.5) : 0.2;
    const hype = Math.min(1, this.scorer.combo / 25 + this.effort * 0.5);
    this.stage.update(this.paused ? 0 : dtRaw, beat, pulse, energy, hype);
    const [ca] = this.stage.palette;
    this.coach.uniforms.uRim.value.copy(ca).lerp(new THREE.Color(1, 1, 1), 0.25);
    this.coach.uniforms.uRimK.value = 0.55 + 0.6 * pulse + 0.25 * hype;
    // Gentle camera drift with a small bob on the beat.
    const t = now / 1000;
    this.camera.position.set(Math.sin(t * 0.21) * 0.28, 1.15 + Math.sin(t * 0.17) * 0.04 - pulse * 0.008, 5.9 + Math.sin(t * 0.13) * 0.12);
    this.camera.lookAt(0, 0.88, 0);
    if (this.r3.currentLevel === 'low' && !this.flags.has('low')) {
      this.flags.add('low');
      this.stage.lowQuality();
    }
    this.cam.draw(now);
  }

  private set(k: string, v: string, apply: (v: string) => void): void {
    if (this.lastHud[k] === v) return;
    this.lastHud[k] = v;
    apply(v);
  }

  private updateHud(st: number, T: number, now: number): void {
    const p = this.part;
    const h = this.hud;
    const i = this.blockAt(p, st);
    const block = i >= 0 ? p.blocks[i] : null;
    const m = block ? MOVE[block.move] : null;
    const beat = beatAt(p.grid, st);
    const ci = block ? this.cards.findIndex((c) => c.part === this.pi && c.block === i) : this.cards.findIndex((c) => c.s0 > T);
    const nextCard = block ? this.cards[ci + 1] : this.cards[ci];

    // Move panel.
    const shown = m ?? (nextCard ? MOVE[nextCard.move] : null);
    this.set('name', shown ? (block ? shown.name : `Next: ${shown.name}`) : '', (v) => {
      h.name.textContent = v;
      h.move.classList.remove('swap');
      void h.move.offsetWidth;
      h.move.classList.add('swap');
      if (block && m) {
        this.sfx.swoosh();
        if (!block.rest) this.voice.say(m.name);
      }
    });
    this.set('cue', shown ? shown.cue : '', (v) => (h.cue.textContent = v));
    const phase = block ? (beat - block.b0) * block.mult : -1;
    const dot = block ? Math.floor(phase) % 8 : -1;
    this.set('dot', String(dot), (v) => h.beats.querySelectorAll('i').forEach((el, k) => el.classList.toggle('on', k === Number(v))));
    let nextTxt = '';
    if (nextCard) {
      const inS = nextCard.s0 - T;
      nextTxt = inS < 60 ? `Next <b>${esc(MOVE[nextCard.move].name)}</b> in <b>${Math.max(0, Math.ceil(inS))}</b>` : '';
      const n = Math.ceil(inS);
      if (block && !block.rest && n <= 3 && n >= 1 && this.lastCount !== `${ci}:${n}`) {
        this.lastCount = `${ci}:${n}`;
        this.sfx.tick(false);
      }
    }
    this.set('next', nextTxt, (v) => (h.next.innerHTML = v));

    // Clock and progress.
    const left = this.total - Math.max(0, T);
    this.set('clock', fmt(T < 0 ? this.total : left), (v) => (h.clock.textContent = v));
    this.set('prog', (Math.max(0, Math.min(1, T / this.total)) * 100).toFixed(1), (v) => (h.prog.style.width = `${v}%`));
    this.set('elapsed', `${fmt(Math.max(0, T))} done · ${fmt(this.total)} total`, (v) => (h.elapsed.textContent = v));
    if (T > this.total / 2 && !this.flags.has('half') && this.total > 240) {
      this.flags.add('half');
      this.voice.say('Halfway there!');
    }
    if (left < 60 && left > 55 && !this.flags.has('minute') && this.total > 150) {
      this.flags.add('minute');
      this.voice.say('One minute left. Give it everything!');
    }

    // Score (counts up smoothly).
    this.shownScore += (this.scorer.score - this.shownScore) * 0.15;
    if (Math.abs(this.scorer.score - this.shownScore) < 1) this.shownScore = this.scorer.score;
    this.set('score', Math.round(this.shownScore).toLocaleString('en-US'), (v) => (h.score.textContent = v));
    this.set('mult', `×${this.scorer.mult.toFixed(1)}`, (v) => (h.mult.textContent = v));
    this.set('combo', `${this.scorer.combo} combo`, (v) => (h.combo.textContent = v));

    // Reps.
    const repM = m && m.rep && !block!.rest ? m : null;
    if (repM) {
      const expected = p.wins.filter((w) => w.block === i).reduce((a, w) => a + repsBetween(repM, w.mb0, w.mb1), 0);
      const mine = this.repBlock === `${this.pi}:${i}` ? this.blockReps : 0;
      this.set('reps', String(mine), (v) => (h.reps.textContent = v));
      this.set('repsL', repM.rep!.label, (v) => (h.repsL.textContent = v));
      this.set('repsOf', `/ ${expected}`, (v) => (h.repsOf.textContent = v));
    } else if (m && m.hold && block && !block.rest) {
      // Stretch: time left in this side's hold.
      const half = m.beats;
      const left = ((half - (phase % half)) / (block.mult * p.grid.bpm)) * 60;
      this.set('reps', `${Math.ceil(left)}s`, (v) => (h.reps.textContent = v));
      this.set('repsL', 'hold', (v) => (h.repsL.textContent = v));
      this.set('repsOf', '', (v) => (h.repsOf.textContent = v));
    } else {
      const moves = this.cards.filter((c) => !c.rest);
      const done = Math.max(0, moves.findIndex((c) => c.s1 > T));
      this.set('reps', String(Math.min(moves.length, done + (block ? 1 : 0))), (v) => (h.reps.textContent = v));
      this.set('repsL', 'move', (v) => (h.repsL.textContent = v));
      this.set('repsOf', `/ ${moves.length}`, (v) => (h.repsOf.textContent = v));
    }
    this.set('kcal', this.kcalTotal < 10 ? this.kcalTotal.toFixed(1) : String(Math.round(this.kcalTotal)), (v) => (h.kcal.textContent = v));
    const z = zoneFor(this.effort);
    this.set('zone', `Zone ${z.zone}`, (v) => (h.zone.textContent = v));
    this.set('zoneL', z.name, (v) => (h.zoneL.textContent = v));
    this.set('zoneHr', this.cfg.age ? `~${estHeartRate(this.cfg.age, this.effort)} bpm · est.` : 'effort · est.', (v) => (h.zoneHr.textContent = v));
    this.set('zoneFill', `${z.zone}:${Math.round(this.effort * 50)}`, () => {
      const segs = h.zoneBar.querySelectorAll<HTMLElement>('i');
      segs.forEach((s, k) => {
        const fill = Math.max(0, Math.min(1, this.effort * 5 - k));
        s.style.setProperty('--f', fill.toFixed(2));
      });
    });

    // Rest overlay.
    const resting = !!block && block.rest;
    this.set('rest', String(resting), (v) => {
      h.rest.classList.toggle('show', v === 'true');
      if (v === 'true') {
        this.sfx.whistle(true);
        this.voice.say('Rest. Breathe.', true);
      } else if (block && this.flags.has('rested')) {
        this.sfx.whistle(false);
        this.voice.say('Go!', true);
      }
      if (v === 'true') this.flags.add('rested');
    });
    if (resting) {
      const inhale = Math.floor(phase) % 8 < 4;
      const k = (phase % 8) / 4;
      const sc = inhale ? 0.6 + 0.4 * Math.sin((Math.min(1, k) * Math.PI) / 2) : 1 - 0.4 * Math.sin((Math.min(1, k - 1) * Math.PI) / 2);
      h.breath.style.setProperty('--s', sc.toFixed(3));
      this.set('breathT', inhale ? 'Breathe in' : 'Breathe out', (v) => (h.breathT.textContent = v));
      this.set('restT', fmt(block!.t1 - st), (v) => (h.restT.textContent = v));
      const nm = nextCard ? MOVE[nextCard.move] : null;
      this.set('restNext', nm ? nm.id : '', () => {
        h.restNext.innerHTML = nm ? `<span>Next up</span><img src="${pictogram(nm.id)}" alt=""><b>${esc(nm.name)}</b>` : '';
      });
    }

    // Between songs.
    const waitNext = this.waitingTrack ? this.parts[this.pi + 1] : null;
    const gap = (!block && T > 0 && T < this.total && st < p.start) || !!waitNext;
    this.set('gap', waitNext ? `Loading ${waitNext.track.info.title}…` : gap ? p.track.info.title : '', (v) => {
      h.gap.classList.toggle('show', !!v);
      h.gapT.textContent = v;
    });

    // Centre: countdown and finale.
    let center = '';
    if (this.finished) center = 'Workout complete!';
    else if (T < 0 && this.pi === 0) {
      const n = Math.ceil(-T);
      center = n <= 3 ? String(n) : 'Get ready';
    } else if (T >= 0 && T < 0.8 && this.pi === 0) center = "Let's go!";
    this.set('center', center, (v) => {
      h.center.textContent = v;
      h.center.className = `fh-center ${v ? 'show' : ''} ${/^\d$/.test(v) ? 'num' : ''}`;
      if (/^[123]$/.test(v)) this.sfx.tick(false);
      if (v === "Let's go!") {
        this.sfx.tick(true);
        this.sfx.whistle(false);
      }
    });

    // Teaching tips in the first seconds, then hints when tracking is poor.
    let tip = '';
    if (T > -6 && T < 18 && this.pi === 0) tip = TIPS[Math.max(0, Math.min(TIPS.length - 1, Math.floor((T + 6) / 8)))];
    this.set('tip', tip, (v) => {
      h.tip.textContent = v;
      h.tip.classList.toggle('show', !!v);
    });
    const b = this.latestBody;
    if (b && b.ok) this.lostSince = 0;
    else if (!this.lostSince) this.lostSince = now;
    if (b && b.ok && !b.full && m && (m.legs || m.focus.includes('knees'))) {
      if (!this.noLegsSince) this.noLegsSince = now;
    } else this.noLegsSince = 0;
    let hint = '';
    if (this.lostSince && now - this.lostSince > 2000) hint = "We can't see you — step into the camera view";
    else if (this.noLegsSince && now - this.noLegsSince > 1500) hint = 'Step back so your legs are visible';
    this.set('hint', hint, (v) => {
      h.hint.textContent = v;
      h.hint.classList.toggle('show', !!v);
    });

    this.updateLane(ci, block, T);

    if (this.ctx.demo || (window as unknown as { __fitDebug?: boolean }).__fitDebug !== undefined) this.debug(m, T);
  }

  private updateLane(ci: number, block: Block | null, T: number): void {
    const lane = this.hud.lane;
    const cur = Math.max(0, ci);
    if (cur !== this.curCard) {
      this.curCard = cur;
      const keep = new Set<number>();
      for (let k = cur; k < Math.min(this.cards.length, cur + 5); k++) keep.add(k);
      for (const [k, el] of this.cardEls) {
        if (!keep.has(k)) {
          el.classList.add('gone');
          setTimeout(() => el.remove(), 450);
          this.cardEls.delete(k);
        }
      }
      for (const k of keep) {
        let el = this.cardEls.get(k);
        const c = this.cards[k];
        if (!el) {
          const [c1, c2] = c.rest ? kindColors('breathe') : kindColors(c.move);
          el = document.createElement('div');
          el.className = 'fh-mc';
          el.style.setProperty('--c1', c1);
          el.style.setProperty('--c2', c2);
          el.innerHTML = `<img src="${pictogram(c.move)}" alt=""><div class="fh-mc-t"><b>${esc(c.rest ? 'Rest' : MOVE[c.move].name)}</b><span>${fmt(c.s1 - c.s0)}</span></div><i class="fh-mc-p"></i><em></em>`;
          el.style.setProperty('--slot', '5');
          lane.appendChild(el);
          void el.offsetWidth;
          this.cardEls.set(k, el);
        }
        const slot = k - cur;
        el.style.setProperty('--slot', String(slot));
        el.classList.toggle('now', slot === 0 && !!block);
      }
    }
    const curEl = this.cardEls.get(cur);
    if (curEl && block) {
      const c = this.cards[cur];
      const prog = Math.max(0, Math.min(1, (T - c.s0) / (c.s1 - c.s0)));
      this.set('cardProg', `${cur}:${(prog * 100).toFixed(0)}`, () => (curEl.querySelector('.fh-mc-p') as HTMLElement).style.setProperty('--p', prog.toFixed(3)));
    }
    const ni = block ? cur + 1 : cur;
    const nextEl = this.cardEls.get(ni);
    const s = nextEl ? Math.max(0, Math.ceil(this.cards[ni].s0 - T)) : -1;
    this.set('cardIn', `${cur}:${ni}:${s}`, () => {
      this.cardEls.forEach((el) => ((el.querySelector('em') as HTMLElement).textContent = ''));
      if (nextEl && s <= 30) (nextEl.querySelector('em') as HTMLElement).textContent = `in ${s}`;
    });
  }

  private debug(m: MoveDef | null, T: number): void {
    (window as unknown as { __gameDebug?: unknown }).__gameDebug = {
      workout: this.cfg.type,
      move: m ? m.id : null,
      score: this.scorer.score,
      combo: this.scorer.combo,
      maxCombo: this.scorer.maxCombo,
      ratings: { ...this.scorer.ratings },
      reps: { ...this.reps },
      repsTotal: Object.values(this.reps).reduce((a, b) => a + b, 0),
      calories: Math.round(this.kcalTotal * 10) / 10,
      elapsed: Math.round(Math.max(0, T) * 10) / 10,
      total: Math.round(this.total),
      part: this.pi,
      parts: this.parts.length,
      finished: this.finished,
      paused: this.paused,
      zone: zoneFor(this.effort).zone,
      fps: Math.round(this.fpsAvg),
      frames: this.frames,
      obsHz: (() => {
        const l = this.buffer.list;
        return l.length > 2 ? Math.round(((l.length - 1) / Math.max(0.1, l[l.length - 1].t - l[0].t)) * 10) / 10 : 0;
      })(),
      quality: this.r3.currentLevel,
      inten: Math.round(this.inten * 100) / 100,
      effort: Math.round(this.effort * 100) / 100,
    };
  }

  // ---- pause / finish -------------------------------------------------------------------------------

  private async pause(): Promise<void> {
    if (this.paused || this.finished) return;
    this.paused = true;
    this.voice.pause();
    await this.ctx.audio.pause();
    const act = await pauseMenu(this.el, this.ctx.cursor);
    if (act === 'resume') {
      await this.ctx.audio.resume();
      this.paused = false;
      this.lastT = this.part.offset + this.ctx.audio.songTime();
      this.musicTarget = -1;
      this.lastPoseT = performance.now();
      this.handsPause = new HandsUpPause();
      this.longHold.reset();
      return;
    }
    const partial = act === 'quit' ? this.result(false) : null;
    this.cleanup();
    this.resolve(act === 'restart' ? { kind: 'restart' } : { kind: 'quit', result: partial && partial.minutes >= 1 ? partial : null });
  }

  private result(completed: boolean): SessionResult {
    const T = Math.max(0, Math.min(this.total, this.part.offset + this.ctx.audio.songTime()));
    return {
      type: this.cfg.type,
      minutes: Math.round((completed ? this.total : T) / 6) / 10,
      target: this.cfg.minutes,
      kcal: Math.round(this.kcalTotal),
      score: this.scorer.score,
      stars: this.scorer.stars,
      grade: this.scorer.grade,
      accuracy: this.scorer.accuracy,
      maxCombo: this.scorer.maxCombo,
      ratings: { ...this.scorer.ratings },
      reps: { ...this.reps },
      completed,
      moves: this.judgedMoves.size,
    };
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    const result = this.result(true);
    this.stage.confetti();
    this.stage.flash(1);
    this.sfx.cheer();
    this.voice.say('Workout complete. Great job!', true);
    this.debug(null, this.total);
    setTimeout(() => {
      this.cleanup();
      this.ctx.audio.music.gain.cancelScheduledValues(this.ctx.audio.ctx.currentTime);
      this.ctx.audio.music.gain.value = this.ctx.settings.musicVolume;
      this.resolve({ kind: 'done', result });
    }, 3600);
  }

  private cleanup(): void {
    cancelAnimationFrame(this.raf);
    this.ctx.audio.stopSong();
    const g = this.ctx.audio.music.gain;
    g.cancelScheduledValues(this.ctx.audio.ctx.currentTime);
    g.value = this.ctx.settings.musicVolume;
    this.voice.pause();
    if (this.ctx.pose instanceof SimPose) this.ctx.pose.drive = () => ({ lWrist: { x: -0.75, y: -1.55 }, rWrist: { x: 0.75, y: -1.55 } });
    this.scene.remove(this.coach.group);
    this.stage.dispose();
    this.r3.dispose();
    this.el.remove();
  }

  // ---- demo bot ------------------------------------------------------------------------------------

  /** Follows the coach with a human-ish lag and a little sloppiness now and then. */
  private botDrive(tMs: number): SimParams {
    const p = this.part;
    if (!p) return { lWrist: { x: -0.75, y: -1.55 }, rWrist: { x: 0.75, y: -1.55 } };
    const lag = 0.09 + 0.06 * Math.sin(tMs / 2300) + (Math.random() - 0.5) * 0.03;
    const s = this.ctx.audio.songTimeAt(tMs) - lag;
    const pose = this.poseAt(p, s);
    // Every ~25 s, a few seconds of half-hearted arms.
    const cyc = (tMs / 1000) % 25;
    this.botSloppy = cyc > 19 && cyc < 23 ? 1 : 0;
    if (this.botSloppy) {
      const shrink = (w: [number, number, number], side: number): [number, number, number] => [side * 0.55 + (w[0] - side * 0.55) * 0.55, -0.9 + (w[1] + 0.9) * 0.55, w[2]];
      pose.lw = shrink(pose.lw, -1);
      pose.rw = shrink(pose.rw, 1);
      pose.py *= 0.5;
    }
    const sim = toSim(solve(pose));
    const n = () => (Math.random() - 0.5) * 0.05;
    sim.lWrist = { x: sim.lWrist.x + n(), y: sim.lWrist.y + n() };
    sim.rWrist = { x: sim.rWrist.x + n(), y: sim.rWrist.y + n() };
    return sim;
  }
}
