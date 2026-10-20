import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { AudioEngine } from '../../core/audio';
import type { Body, BodyTracker } from '../../core/body';
import type { Settings } from '../../core/settings';
import { SimPose, type SimParams } from '../../core/pose';
import type { PoseSource, V2 } from '../../core/types';
import { drawSkeleton } from '../../core/skeleton';
import { BombKit, BlockKit, Debris, Saber, Shockwaves, Sparks, dirAngle, makeWall, type BlockParts } from './objects';
import { PALETTE, Stage } from './scene';
import { Dir, DIR_VEC, type BeatMap, type Bomb, type Note, type Wall } from './mapgen';
import { GRID, MIN_SWING_SPEED, Multiplier, bodyToWorld, judgeCut, judgement, notePos, rank, segmentHitsSquare, stars } from './hit';
import type { SongInfo } from './songs';
import type { Analysis } from '../../core/beat';
import type { SongClock } from './clock';

export interface GameContext {
  root: HTMLElement;
  pose: PoseSource;
  body: BodyTracker;
  audio: AudioEngine;
  settings: Settings;
  demo: boolean;
  /** Enable or disable the hand cursor (used by the pause menu). */
  cursor: (on: boolean) => void;
}

export interface BladeResult {
  title: string;
  difficulty: string;
  score: number;
  maxScore: number;
  accuracy: number;
  hits: number;
  misses: number;
  bad: number;
  bombsHit: number;
  wallTime: number;
  maxCombo: number;
  notes: number;
  cleared: boolean;
  rank: string;
  stars: number;
}

export type BladeOutcome = { kind: 'done'; result: BladeResult } | { kind: 'quit' } | { kind: 'restart' };

interface LiveNote {
  n: Note;
  pos: V2;
  parts: BlockParts | null;
  done: boolean;
  spin: number;
  quat: THREE.Quaternion;
}

interface LiveBomb {
  b: Bomb;
  pos: V2;
  obj: THREE.Group | null;
  done: boolean;
}

interface LiveWall {
  w: Wall;
  obj: THREE.Group | null;
  depth: number;
}

const SPAWN_DIST = 36;
const HIT_EARLY = 0.17;
const HIT_LATE = 0.15;
const LEAN_NEEDED = 0.6;
const DUCK_NEEDED = 0.33;

const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

export class BladeGame {
  private renderer!: THREE.WebGLRenderer;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.05, 300);
  private stage!: Stage;
  private kit = new BlockKit();
  private bombKit = new BombKit();
  private debris = new Debris(this.kit);
  private sparks = new Sparks();
  private waves = new Shockwaves();
  private sabers: [Saber, Saber] = [new Saber(0), new Saber(1)];
  private notes: LiveNote[] = [];
  private bombs: LiveBomb[] = [];
  private walls: LiveWall[] = [];
  private speed: number;
  private el!: HTMLElement;
  private hud!: Record<string, HTMLElement>;
  private preview!: HTMLCanvasElement;
  private raf = 0;
  private lastFrame = 0;
  private lastPoseT = 0;
  private lastPoseSong = -99;
  private prevHand: [{ p: V2; t: number; s: number } | null, { p: V2; t: number; s: number } | null] = [null, null];
  private latestBody: Body | null = null;
  private handVel: [V2, V2] = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  private shake = 0;
  private inWall = false;
  private wallFlash = 0;
  private hurtFlash = 0;
  private resolve!: (o: BladeOutcome) => void;
  private finished = false;
  private paused = false;
  private handsUpSince = 0;
  private accentIdx = 0;
  private beatIdx = 0;
  private fpsAvg = 60;
  private perfChecked = false;
  private startedAt = 0;
  private lastHud: Record<string, string> = {};

  // scoring
  private score = 0;
  private maxSoFar = 0;
  private combo = 0;
  private maxCombo = 0;
  private hits = 0;
  private misses = 0;
  private bad = 0;
  private bombsHit = 0;
  private wallTime = 0;
  private health = 0.5;
  private mult = new Multiplier();
  private perfectMult = new Multiplier();
  private resolvedNotes = 0;

  constructor(
    private ctx: GameContext,
    private song: { info: SongInfo; analysis: Analysis },
    private clock: SongClock,
    private map: BeatMap,
    private opts: { noFail: boolean; seek?: number },
  ) {
    this.speed = SPAWN_DIST / map.approach;
  }

  run(): Promise<BladeOutcome> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.build();
      this.begin();
    });
  }

  // ---- setup -----------------------------------------------------------------------

  private build(): void {
    const { root, settings } = this.ctx;
    this.el = document.createElement('div');
    this.el.className = 'blade';
    this.el.innerHTML = `
      <canvas class="blade-gl"></canvas>
      <div class="vignette"></div>
      <div class="hurt"></div>
      <div class="hud">
        <div class="hud-top">
          <div class="hud-song"><b></b><span></span></div>
          <div class="hud-progress"><i></i></div>
          <div class="hud-score"><b>0</b><span>100%</span></div>
        </div>
        <div class="hud-combo">
          <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" class="ring-bg"/><circle cx="50" cy="50" r="44" class="ring"/></svg>
          <div class="mult">×1</div>
          <div class="combo-n">0</div><div class="combo-l">combo</div>
        </div>
        <div class="hud-rank"></div>
        <div class="hud-health"><i></i></div>
        <canvas class="hud-cam" width="320" height="180"></canvas>
        <button class="hud-pause" data-hc>❚❚</button>
        <div class="popups"></div>
        <div class="center-msg"></div>
        <div class="pause-hint">Raise both hands to pause</div>
      </div>
      <div class="pause-menu hidden">
        <h2>Paused</h2>
        <button class="btn primary" data-hc data-act="resume">Resume</button>
        <button class="btn" data-hc data-act="restart">Restart</button>
        <button class="btn ghost" data-hc data-act="quit">Quit to menu</button>
      </div>`;
    root.appendChild(this.el);
    const q = (s: string) => this.el.querySelector(s) as HTMLElement;
    this.hud = {
      title: q('.hud-song b'),
      diff: q('.hud-song span'),
      progress: q('.hud-progress i'),
      score: q('.hud-score b'),
      acc: q('.hud-score span'),
      ring: q('.hud-combo .ring'),
      mult: q('.mult'),
      combo: q('.combo-n'),
      comboBox: q('.hud-combo'),
      rank: q('.hud-rank'),
      health: q('.hud-health i'),
      popups: q('.popups'),
      center: q('.center-msg'),
      vignette: q('.vignette'),
      hurt: q('.hurt'),
      pauseMenu: q('.pause-menu'),
    };
    this.hud.title.textContent = this.song.info.title;
    this.hud.diff.textContent = this.map.difficulty;
    this.preview = q('.hud-cam') as HTMLCanvasElement;
    this.preview.style.display = settings.showCamera ? '' : 'none';
    q('.hud-pause').addEventListener('click', () => this.pause());
    this.el.querySelectorAll<HTMLElement>('.pause-menu [data-act]').forEach((b) =>
      b.addEventListener('click', () => this.onPauseAction(b.dataset.act!)),
    );

    const canvas = q('.blade-gl') as HTMLCanvasElement;
    const quality = settings.quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'low', powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.localClippingEnabled = true;
    this.scene.background = PALETTE.bg;
    this.scene.fog = new THREE.FogExp2(0x07031a, 0.03);

    this.scene.add(new THREE.AmbientLight(0x7d6bff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(2, 5, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6a3bff, 0.8);
    rim.position.set(-3, 2, -6);
    this.scene.add(rim);

    this.stage = new Stage(this.speed);
    this.scene.add(this.stage.group, this.debris.group, this.waves.group, this.sparks.points);
    for (const s of this.sabers) this.scene.add(s.group, s.trailMesh);

    for (const n of this.map.notes) {
      const pos = notePos(n.col, n.row);
      const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), dirAngle(n.dir));
      this.notes.push({ n, pos, parts: null, done: false, spin: (Math.random() - 0.5) * 6, quat });
    }
    for (const b of this.map.bombs) this.bombs.push({ b, pos: notePos(b.col, b.row), obj: null, done: false });
    for (const w of this.map.walls) this.walls.push({ w, obj: null, depth: w.dur * this.speed });

    this.applyQuality(quality === 'auto' ? 'high' : quality);
    this.resize();
    window.addEventListener('resize', this.resize);

    if (this.ctx.demo && this.ctx.pose instanceof SimPose) {
      const sim = this.ctx.pose;
      sim.drive = (t) => this.botDrive(t);
    }
  }

  private applyQuality(q: 'high' | 'medium' | 'low'): void {
    const dpr = window.devicePixelRatio || 1;
    const pr = q === 'high' ? Math.min(dpr, 1.5) : q === 'medium' ? Math.min(dpr, 1) : 0.75;
    this.renderer.setPixelRatio(pr);
    if (q === 'low') {
      this.composer = null;
      this.bloom = null;
      return;
    }
    if (!this.composer) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 288), q === 'high' ? 0.8 : 0.6, 0.4, 0.32);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }
    this.composer.setPixelRatio(pr);
    this.resize();
  }

  private resize = (): void => {
    const w = this.el.clientWidth || window.innerWidth;
    const h = this.el.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.bloom?.setSize(Math.round(w / 2), Math.round(h / 2));
    this.camera.aspect = w / h;
    // Keep the play area in view on narrower screens.
    this.camera.fov = w / h < 1.5 ? 70 : 62;
    this.camera.updateProjectionMatrix();
    this.sparks.setViewportHeight(h * this.renderer.getPixelRatio());
  };

  private begin(): void {
    const audio = this.ctx.audio;
    audio.offsetMs = this.ctx.settings.audioOffset;
    audio.music.gain.value = this.ctx.settings.musicVolume;
    audio.sfx.gain.value = this.ctx.settings.sfxVolume;
    const leadIn = Math.max(3.2, this.map.approach + 1.2);
    const seek = this.opts.seek ?? 0;
    if (seek > 0) {
      // Testing aid: skip ahead without counting the skipped blocks.
      for (const ln of this.notes) if (ln.n.t < seek + 0.5) ln.done = true;
      for (const lb of this.bombs) if (lb.b.t < seek + 0.5) lb.done = true;
    }
    this.clock.start(leadIn, seek);
    this.ctx.cursor(false);
    this.startedAt = performance.now();
    this.lastFrame = performance.now();
    this.lastPoseT = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---- main loop ------------------------------------------------------------------------

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (dt > 0) this.fpsAvg += 0.05 * (1 / Math.max(dt, 1e-3) - this.fpsAvg);
    this.autoQuality(now);

    const st = this.clock.time();

    if (!this.paused) {
      this.processPose(st);
      this.checkMisses(st);
      this.checkHandsUp(now);
      if (this.inWall && st > 0) {
        this.health -= 0.3 * dt;
        this.wallTime += dt;
      }
      if (this.health <= 0 && !this.opts.noFail && !this.finished) this.finish(false);
      if (!this.finished && st > this.clock.duration + 0.4) this.finish(true);
    }

    this.updateVisuals(dt, now, st);
    this.updateHud(st);
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  };

  private autoQuality(now: number): void {
    if (this.ctx.settings.quality !== 'auto' || this.perfChecked) return;
    if (now - this.startedAt < 5000) return;
    this.perfChecked = true;
    if (this.fpsAvg < 40) this.applyQuality('low');
    else if (this.fpsAvg < 52) this.applyQuality('medium');
  }

  // ---- input --------------------------------------------------------------------------

  /** Treat a point a little beyond the wrist (toward the fingers) as the cutting point. */
  private handPoint(b: Body, h: 0 | 1): V2 {
    const w = h === 0 ? b.lWrist : b.rWrist;
    const e = h === 0 ? b.lElbow : b.rElbow;
    // Hands move with the body: add the sideways lean and the drop from ducking (both in shoulder widths).
    const c = this.ctx.body.calib;
    const torsoRatio = c ? c.torso / c.sw : 1.5;
    return bodyToWorld({
      x: w.x + (w.x - e.x) * 0.25 + b.lean,
      y: w.y + (w.y - e.y) * 0.25 - b.duck * torsoRatio,
    });
  }

  private processPose(st: number): void {
    const frames = this.ctx.pose.since(this.lastPoseT);
    for (const f of frames) {
      this.lastPoseT = f.t;
      const b = this.ctx.body.measure(f);
      if (!b.ok) {
        this.prevHand = [null, null];
        continue;
      }
      this.latestBody = b;
      const s = this.clock.timeAt(f.t);
      this.lastPoseSong = s;
      for (const h of [0, 1] as const) {
        const p = this.handPoint(b, h);
        const prev = this.prevHand[h];
        const vis = h === 0 ? b.lWristV : b.rWristV;
        if (prev && vis > 0.3) {
          const dt = (f.t - prev.t) / 1000;
          if (dt > 0 && dt < 0.25) {
            this.handVel[h] = { x: (p.x - prev.p.x) / dt, y: (p.y - prev.p.y) / dt };
            if (s > -0.5) this.checkCuts(h, prev.p, p, dt, prev.s, s);
          }
        }
        this.prevHand[h] = vis > 0.3 ? { p, t: f.t, s } : null;
      }
      this.checkWalls(b, s);
    }
    if (!frames.length && performance.now() - this.lastPoseT > 400) this.prevHand = [null, null];
    void st;
  }

  /** Judge the hand movement a→b, which happened between song times s0 and s1. */
  private checkCuts(h: 0 | 1, a: V2, b: V2, dt: number, s0: number, s1: number): void {
    // A block is cuttable if its hit window overlaps the time span of this movement (robust to low tracking rates).
    for (const ln of this.notes) {
      if (ln.done) continue;
      if (ln.n.t - HIT_EARLY > s1) break;
      if (ln.n.t + HIT_LATE < s0) continue;
      const r = judgeCut(a, b, dt, ln.pos, ln.n.dir);
      if (!r.touched) continue;
      if (ln.n.hand === h) {
        if (r.good) this.onCut(ln, r.points, b.x - a.x, b.y - a.y, r.speed);
        // Moving into position for the swing often passes through the block (there is no depth on a TV),
        // so a wrong-direction touch only counts once the block has actually arrived.
        else if (s1 >= ln.n.t - 0.06) this.onBad(ln, b.x - a.x, b.y - a.y);
      } else if (r.speed > MIN_SWING_SPEED * 1.3 && segmentHitsSquare(a, b, ln.pos, GRID.size / 2 - 0.03)) {
        // The wrong saber only counts when it goes right through the block, not when it grazes the forgiving edge.
        this.onBad(ln, b.x - a.x, b.y - a.y);
      }
    }
    const speed = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(dt, 1e-3);
    if (speed < 0.6) return;
    for (const lb of this.bombs) {
      if (lb.done) continue;
      if (lb.b.t - HIT_EARLY > s1) break;
      if (lb.b.t + HIT_LATE < s0) continue;
      if (segmentHitsSquare(a, b, lb.pos, 0.2)) this.onBomb(lb);
    }
  }

  private checkWalls(b: Body, s: number): void {
    let hit = false;
    for (const lw of this.walls) {
      if (s < lw.w.t || s > lw.w.t + lw.w.dur) continue;
      if (lw.w.kind === 'left' && b.lean < LEAN_NEEDED) hit = true;
      if (lw.w.kind === 'right' && b.lean > -LEAN_NEEDED) hit = true;
      if (lw.w.kind === 'top' && b.duck < DUCK_NEEDED) hit = true;
    }
    if (hit && !this.inWall) {
      this.combo = 0;
      this.mult.miss();
      this.ctx.audio.wallHit();
    }
    this.inWall = hit;
  }

  private checkMisses(st: number): void {
    // Wait for tracking to cover the hit window before calling a miss, unless tracking stalls.
    const deadline = Math.max(this.lastPoseSong, st - 0.45) - HIT_LATE;
    for (const ln of this.notes) {
      if (ln.n.t > deadline) break;
      if (!ln.done) this.onMiss(ln);
    }
    for (const lb of this.bombs) {
      if (lb.b.t > deadline) break;
      lb.done = true;
    }
  }

  private checkHandsUp(now: number): void {
    const b = this.latestBody;
    if (!b || this.ctx.demo) return;
    const up = b.lWrist.y > b.nose.y + 0.35 && b.rWrist.y > b.nose.y + 0.35 && Math.abs(b.lWrist.x - b.rWrist.x) < 1.6;
    if (!up) {
      this.handsUpSince = 0;
      return;
    }
    if (!this.handsUpSince) this.handsUpSince = now;
    if (now - this.handsUpSince > 1300) {
      this.handsUpSince = 0;
      void this.pause();
    }
  }

  // ---- scoring events -------------------------------------------------------------------

  private resolveNote(ln: LiveNote): void {
    ln.done = true;
    this.resolvedNotes++;
    this.perfectMult.hit();
    this.maxSoFar += 100 * this.perfectMult.value;
  }

  private worldPos(ln: { pos: V2 }, z = GRID.hitZ): THREE.Vector3 {
    return new THREE.Vector3(ln.pos.x, ln.pos.y, z);
  }

  private onCut(ln: LiveNote, points: number, sx: number, sy: number, speed: number): void {
    this.resolveNote(ln);
    this.hits++;
    this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    const leveled = this.mult.hit();
    this.score += points * this.mult.value;
    this.health = Math.min(1, this.health + 0.02);
    const at = ln.parts ? ln.parts.group.position.clone() : this.worldPos(ln);
    const color = ln.n.hand === 0 ? PALETTE.left : PALETTE.right;
    this.debris.spawn(at, ln.quat, ln.n.hand, ln.n.dir, sx, sy, speed);
    const len = Math.hypot(sx, sy) || 1;
    this.sparks.burst(at, color, 26, 3.2, sx / len, sy / len, 0.55, 0.07);
    this.sparks.burst(at, new THREE.Color(1, 1, 1), 8, 2, sx / len, sy / len, 0.3, 0.05);
    this.waves.spawn(at, color);
    this.releaseNote(ln);
    this.ctx.audio.slice(ln.pos.x / 1.2, Math.min(1, speed / 4));
    if (leveled) {
      this.ctx.audio.combo(this.mult.level);
      this.hud.comboBox.classList.remove('pop');
      void this.hud.comboBox.offsetWidth;
      this.hud.comboBox.classList.add('pop');
    }
    this.popup(at, judgement(points), ln.n.hand === 0 ? 'l' : 'r');
    this.stage.accent(0.35);
  }

  private onBad(ln: LiveNote, sx: number, sy: number): void {
    if (this.ctx.demo && this.missLog.length < 20) this.missLog.push(`BAD ${ln.n.t.toFixed(2)} h${ln.n.hand} d${ln.n.dir} swing ${sx.toFixed(2)},${sy.toFixed(2)}`);
    this.resolveNote(ln);
    this.bad++;
    this.combo = 0;
    this.mult.miss();
    this.health -= 0.1;
    const at = ln.parts ? ln.parts.group.position.clone() : this.worldPos(ln);
    this.debris.spawn(at, ln.quat, ln.n.hand, ln.n.dir, sx || 0.01, sy, 1);
    this.sparks.burst(at, new THREE.Color(0.6, 0.6, 0.6), 12, 1.5, 0, 0, 0.4, 0.05);
    this.releaseNote(ln);
    this.ctx.audio.badCut(ln.pos.x / 1.2);
    this.popup(at, '✕', 'bad');
    this.hurtFlash = 0.6;
  }

  private missLog: string[] = [];

  private onMiss(ln: LiveNote): void {
    if (this.ctx.demo && this.missLog.length < 20) this.missLog.push(`${ln.n.t.toFixed(2)} h${ln.n.hand} c${ln.n.col}r${ln.n.row} d${ln.n.dir} lastPose=${this.lastPoseSong.toFixed(2)}`);
    this.resolveNote(ln);
    this.misses++;
    this.combo = 0;
    this.mult.miss();
    this.health -= 0.12;
    this.ctx.audio.miss(ln.pos.x / 1.2);
    this.popup(this.worldPos(ln), 'Miss', 'miss');
    this.hurtFlash = 0.8;
  }

  private onBomb(lb: LiveBomb): void {
    lb.done = true;
    this.bombsHit++;
    this.combo = 0;
    this.mult.miss();
    this.health -= 0.15;
    const at = lb.obj ? lb.obj.position.clone() : new THREE.Vector3(lb.pos.x, lb.pos.y, GRID.hitZ);
    this.sparks.burst(at, new THREE.Color(1, 0.35, 0.1), 60, 4.5, 0, 0, 0.8, 0.09);
    this.sparks.burst(at, new THREE.Color(1, 0.9, 0.5), 20, 2.5, 0, 0, 0.5, 0.07);
    if (lb.obj) {
      this.bombKit.give(lb.obj);
      lb.obj = null;
    }
    this.ctx.audio.bomb();
    this.shake = 0.35;
    this.hurtFlash = 1;
  }

  private releaseNote(ln: LiveNote): void {
    if (ln.parts) {
      this.kit.give(ln.n.hand, ln.parts);
      ln.parts = null;
    }
  }

  private popup(at: THREE.Vector3, text: string, kind: string): void {
    const v = at.clone().project(this.camera);
    const el = document.createElement('div');
    el.className = `popup ${kind} ${text.toLowerCase()}`;
    el.textContent = text;
    el.style.left = `${(v.x * 0.5 + 0.5) * 100}%`;
    el.style.top = `${(-v.y * 0.5 + 0.5) * 100}%`;
    this.hud.popups.appendChild(el);
    setTimeout(() => el.remove(), 700);
  }

  // ---- visuals -----------------------------------------------------------------------------

  private updateVisuals(dt: number, now: number, st: number): void {
    const time = now / 1000;
    const a = this.song.analysis;

    // Beat pulse and accent flashes from the analysis.
    while (this.beatIdx < a.beats.length && a.beats[this.beatIdx] <= st) this.beatIdx++;
    const lastBeat = this.beatIdx > 0 ? a.beats[this.beatIdx - 1] : -10;
    const beatPulse = Math.exp(-(st - lastBeat) * 7);
    const energy = a.energy[Math.max(0, this.beatIdx - 1)] ?? 0.5;
    while (this.accentIdx < a.onsets.length && a.onsets[this.accentIdx].t <= st) {
      const o = a.onsets[this.accentIdx++];
      if (o.s > 0.75) this.stage.accent(o.s);
    }
    this.stage.update(this.paused ? 0 : dt, time, st, beatPulse, energy);
    this.bombKit.pulse(time);

    // Camera follows the player's head: lean and duck move the view, which sells the walls.
    const b = this.latestBody;
    const lean = b ? Math.max(-1.6, Math.min(1.6, b.lean)) : 0;
    const duck = b ? Math.max(0, Math.min(0.8, b.duck)) : 0;
    this.shake = Math.max(0, this.shake - dt);
    const sh = this.shake * 0.15;
    const cx = lean * 0.45 + (Math.random() - 0.5) * sh;
    const cy = 1.55 - duck * 1.2 + (Math.random() - 0.5) * sh;
    this.camera.position.lerp(new THREE.Vector3(cx, cy, 1.75), 0.35);
    this.camera.lookAt(cx * 0.4, 1.28 - duck * 0.4, -10);

    this.updateNotes(st, dt);
    this.updateBombs(st, time);
    this.updateWalls(st, time);
    this.updateSabers();
    this.debris.update(this.paused ? 0 : dt);
    this.sparks.update(this.paused ? 0 : dt);
    this.waves.update(this.paused ? 0 : dt);

    this.wallFlash += ((this.inWall ? 1 : 0) - this.wallFlash) * Math.min(1, dt * 10);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.5);
    this.hud.vignette.style.opacity = String(this.wallFlash * 0.9);
    this.hud.hurt.style.opacity = String(this.hurtFlash * 0.55);
    this.drawPreview(now);
  }

  private zAt(t: number, st: number): number {
    return GRID.hitZ - (t - st) * this.speed;
  }

  private updateNotes(st: number, dt: number): void {
    const approach = this.map.approach;
    for (const ln of this.notes) {
      const until = ln.n.t - st;
      if (until > approach) break;
      if (ln.done) continue;
      if (!ln.parts) {
        ln.parts = this.kit.take(ln.n.hand, ln.n.dir);
        this.scene.add(ln.parts.group);
      }
      const g = ln.parts.group;
      const z = this.zAt(ln.n.t, st);
      const prog = 1 - until / approach;
      const rise = ease(prog / 0.35);
      g.position.set(ln.pos.x * (0.6 + 0.4 * rise), ln.pos.y - (1 - rise) * 1.4, z);
      const settle = ease(prog / 0.5);
      const spinQ = new THREE.Quaternion().setFromEuler(new THREE.Euler((1 - settle) * ln.spin, (1 - settle) * ln.spin * 0.6, 0));
      g.quaternion.copy(ln.quat).multiply(spinQ);
      const s = 0.5 + 0.5 * rise;
      g.scale.setScalar(s);
      if (z > 3) this.releaseNote(ln);
      void dt;
    }
  }

  private updateBombs(st: number, time: number): void {
    for (const lb of this.bombs) {
      const until = lb.b.t - st;
      if (until > this.map.approach) break;
      if (lb.done && !lb.obj) continue;
      if (!lb.obj) {
        lb.obj = this.bombKit.take();
        this.scene.add(lb.obj);
      }
      const z = this.zAt(lb.b.t, st);
      lb.obj.position.set(lb.pos.x, lb.pos.y, z);
      lb.obj.rotation.set(time * 1.3, time * 0.9, 0);
      if (z > 3) {
        this.bombKit.give(lb.obj);
        lb.obj = null;
        lb.done = true;
      }
    }
  }

  private updateWalls(st: number, time: number): void {
    for (const lw of this.walls) {
      const until = lw.w.t - st;
      if (until > this.map.approach + 0.5) break;
      const front = -(lw.w.t - st) * this.speed;
      if (front - lw.depth > 4) {
        if (lw.obj) {
          lw.obj.removeFromParent();
          lw.obj = null;
        }
        continue;
      }
      if (!lw.obj) {
        lw.obj = makeWall(lw.w.kind, lw.depth);
        this.scene.add(lw.obj);
      }
      lw.obj.position.z = front - lw.depth / 2;
      (lw.obj.userData.mat as THREE.ShaderMaterial).uniforms.uTime.value = time;
    }
  }

  private updateSabers(): void {
    const b = this.latestBody;
    for (const h of [0, 1] as const) {
      const s = this.sabers[h];
      if (!b) {
        s.update(new THREE.Vector3(h ? 0.4 : -0.4, 0.9, 0), new THREE.Vector3(h ? 0.3 : -0.3, 1.3, -1), false);
        continue;
      }
      const p = this.handPoint(b, h);
      const v = this.handVel[h];
      const base = new THREE.Vector3(p.x, p.y, 0.1);
      const toward = new THREE.Vector3(p.x * 0.55 + v.x * 0.05, p.y + 0.4 + v.y * 0.05, -1.1);
      const vis = h === 0 ? b.lWristV : b.rWristV;
      s.update(base, toward, vis > 0.3);
    }
  }

  private drawPreview(now: number): void {
    if (!this.ctx.settings.showCamera || now - (this.preview as unknown as { _t?: number })._t! < 60) return;
    (this.preview as unknown as { _t?: number })._t = now;
    const g = this.preview.getContext('2d')!;
    const f = this.ctx.pose.latest();
    drawSkeleton(g, this.ctx.pose.video, f, this.preview.width, this.preview.height);
  }

  private updateHud(st: number): void {
    if (this.ctx.demo) {
      (window as unknown as { __blade?: unknown }).__blade = {
        st, hits: this.hits, misses: this.misses, bad: this.bad, bombs: this.bombsHit, wall: this.wallTime, fps: this.fpsAvg,
        missLog: this.missLog,
      };
    }
    const set = (k: string, v: string, apply: (v: string) => void) => {
      if (this.lastHud[k] === v) return;
      this.lastHud[k] = v;
      apply(v);
    };
    const acc = this.maxSoFar > 0 ? this.score / this.maxSoFar : 1;
    set('score', this.score.toLocaleString(), (v) => (this.hud.score.textContent = v));
    set('acc', `${(acc * 100).toFixed(1)}%`, (v) => (this.hud.acc.textContent = v));
    set('rank', rank(acc), (v) => (this.hud.rank.textContent = v));
    set('combo', String(this.combo), (v) => (this.hud.combo.textContent = v));
    set('mult', `×${this.mult.value}`, (v) => (this.hud.mult.textContent = v));
    set('ring', (276.5 * (1 - this.mult.fill)).toFixed(1), (v) => (this.hud.ring.style.strokeDashoffset = v));
    const prog = Math.max(0, Math.min(1, st / Math.max(1, this.clock.duration)));
    set('prog', (prog * 100).toFixed(1), (v) => (this.hud.progress.style.width = `${v}%`));
    const hp = Math.max(0, Math.min(1, this.health));
    set('hp', (hp * 100).toFixed(0), (v) => {
      this.hud.health.style.width = `${v}%`;
      this.hud.health.classList.toggle('low', hp < 0.25);
    });
    let msg = '';
    if (st < 0 && !this.paused) {
      const n = Math.ceil(-st);
      msg = n <= 3 ? String(n) : 'Get ready';
    } else if (st >= 0 && st < 0.6) msg = 'Go!';
    set('center', msg, (v) => {
      this.hud.center.textContent = v;
      this.hud.center.classList.toggle('show', !!v);
      if (v && /^[123]$/.test(v)) this.ctx.audio.beep(false);
      if (v === 'Go!') this.ctx.audio.beep(true);
    });
  }

  // ---- pause / finish ------------------------------------------------------------------

  private async pause(): Promise<void> {
    if (this.paused || this.finished) return;
    this.paused = true;
    await this.clock.pause();
    this.hud.pauseMenu.classList.remove('hidden');
    this.ctx.cursor(true);
  }

  private async onPauseAction(act: string): Promise<void> {
    if (act === 'resume') {
      this.hud.pauseMenu.classList.add('hidden');
      this.ctx.cursor(false);
      await this.clock.resume();
      this.paused = false;
      this.lastPoseT = performance.now();
      this.prevHand = [null, null];
      return;
    }
    this.cleanup();
    this.resolve(act === 'restart' ? { kind: 'restart' } : { kind: 'quit' });
  }

  private finish(cleared: boolean): void {
    if (this.finished) return;
    this.finished = true;
    for (const ln of this.notes) if (!ln.done) this.resolveNote(ln);
    const accuracy = this.maxSoFar > 0 ? this.score / this.maxSoFar : 0;
    const result: BladeResult = {
      title: this.song.info.title,
      difficulty: this.map.difficulty,
      score: this.score,
      maxScore: this.maxSoFar,
      accuracy,
      hits: this.hits,
      misses: this.misses,
      bad: this.bad,
      bombsHit: this.bombsHit,
      wallTime: this.wallTime,
      maxCombo: this.maxCombo,
      notes: this.map.notes.length,
      cleared,
      rank: cleared ? rank(accuracy) : 'F',
      stars: stars(accuracy, cleared),
    };
    if (!cleared) {
      this.hud.center.textContent = 'Failed';
      this.hud.center.classList.add('show', 'fail');
      this.clock.fadeOut(1.2);
    }
    setTimeout(
      () => {
        this.cleanup();
        this.ctx.audio.music.gain.value = this.ctx.settings.musicVolume;
        this.resolve({ kind: 'done', result });
      },
      cleared ? 600 : 1800,
    );
  }

  private cleanup(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.clock.stop();
    if (this.ctx.pose instanceof SimPose) this.ctx.pose.drive = () => ({ lWrist: { x: -0.75, y: -1.55 }, rWrist: { x: 0.75, y: -1.55 } });
    this.renderer.dispose();
    this.composer?.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
    });
    this.el.remove();
  }

  // ---- demo bot -----------------------------------------------------------------------------

  /** Plays the map perfectly-ish: used for demo mode and automated tests. */
  private botDrive(tMs: number): SimParams {
    const s = this.clock.timeAt(tMs);
    const rest: [V2, V2] = [
      { x: -0.34, y: 0.95 },
      { x: 0.34, y: 0.95 },
    ];
    const swing = 0.16;
    const L = 0.62;
    const hands: V2[] = [];
    for (const h of [0, 1] as const) {
      const mine = this.map.notes.filter((n) => n.hand === h);
      let i = mine.findIndex((n) => n.t + swing / 2 >= s);
      if (i < 0) i = mine.length;
      const n = mine[i];
      const prev = i > 0 ? mine[i - 1] : null;
      const seg = (note: Note) => {
        const [ux, uy] = note.dir === Dir.Any ? [0, -1] : DIR_VEC[note.dir];
        const c = notePos(note.col, note.row);
        return { a: { x: c.x - (ux * L) / 2, y: c.y - (uy * L) / 2 }, b: { x: c.x + (ux * L) / 2, y: c.y + (uy * L) / 2 } };
      };
      let p: V2 = rest[h];
      if (n) {
        const sg = seg(n);
        const t0 = n.t - swing / 2;
        if (s >= t0) {
          const k = (s - t0) / swing;
          p = { x: sg.a.x + (sg.b.x - sg.a.x) * k, y: sg.a.y + (sg.b.y - sg.a.y) * k };
        } else {
          const from = prev ? seg(prev).b : rest[h];
          const fromT = prev ? prev.t + swing / 2 : t0 - 1;
          const k = ease((s - fromT) / Math.max(0.05, t0 - fromT));
          p = { x: from.x + (sg.a.x - from.x) * k, y: from.y + (sg.a.y - from.y) * k };
        }
      }
      hands.push(p);
    }
    let lean = 0;
    let duck = 0;
    for (const w of this.map.walls) {
      const k = Math.min(1, Math.max(0, Math.min(s - (w.t - 0.45), w.t + w.dur + 0.2 - s) / 0.25));
      if (k <= 0) continue;
      if (w.kind === 'left') lean = 1.0 * k;
      if (w.kind === 'right') lean = -1.0 * k;
      if (w.kind === 'top') duck = 0.55 * k;
    }
    // Convert world hand positions back to body space (relative to the leaning/ducking shoulders).
    const toBody = (p: V2): V2 => ({ x: p.x / 0.45 - lean, y: (p.y - 1.45) / 0.45 + duck * SimPose.TORSO });
    return { lWrist: toBody(hands[0]), rWrist: toBody(hands[1]), lean, duck };
  }
}
