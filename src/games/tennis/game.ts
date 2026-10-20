/**
 * Centre Court: one play session (a match or a rally challenge). Owns the 3D scene, the point state
 * machine, ball flights, the AI, the human's swing input, HUD, sounds, replays and the demo bot.
 */
import * as THREE from 'three';
import { Renderer3D } from '../../core/render';
import { SimPose } from '../../core/pose';
import type { Body } from '../../core/body';
import { CamPreview, HandsUpPause, pauseMenu } from '../../ui/kit';
import type { GameEnv } from '../types';
import { AI, chooseIntercept, decideAiServe, decideAiShot, type Intercept } from './ai';
import { TennisBot, type BotHint } from './bot';
import { Athlete, angleDiff, contactOffset, tossAt, type AthleteSnap, type CharacterKit, type Outfit, type SwingKind, type SwingStyle } from './character';
import { BallView, Puffs, Stadium, Target, VENUES, type VenueId } from './court';
import {
  COURT,
  Flight,
  SURFACES,
  isIn,
  kmh,
  onLine,
  outDistance,
  serviceBox,
  singlesHalf,
  solveShot,
  type BallState,
  type FlightEvent,
  type Region,
  type V3,
} from './physics';
import { FORMATS, MatchScore, type FormatId, type Side } from './rules';
import {
  MIN_SERVE,
  MIN_SWING,
  WINDOWS,
  classifySwing,
  gauss,
  judgeTiming,
  matchStars,
  rallyStars,
  rng,
  serveFromSwing,
  shotFromSwing,
  type Difficulty,
  type Handed,
  type ShotKind,
  type Stroke,
  type SwingFeatures,
  type Timing,
} from './shots';
import { TennisSounds } from './sounds';

export type Mode = 'match' | 'rally';

export interface TennisConfig {
  mode: Mode;
  difficulty: Difficulty;
  hand: Handed;
  venue: VenueId;
  format: FormatId;
  sex: 'm' | 'f';
  voice: boolean;
  /** Show coaching prompts during the first points. */
  tutorial: boolean;
}

export interface TennisAssets {
  kit: CharacterKit;
  skies: Partial<Record<VenueId, THREE.Texture>>;
}

export interface TennisResult {
  mode: Mode;
  difficulty: Difficulty;
  venue: VenueId;
  won: boolean;
  scoreLine: string;
  opponent: string;
  pointsWon: number;
  pointsLost: number;
  aces: number;
  doubleFaults: number;
  winners: number;
  errors: number;
  longestRally: number;
  fastestServe: number;
  firstServePct: number;
  perfects: number;
  score: number;
  targets: number;
  stars: number;
}

export type TennisOutcome = { kind: 'done'; result: TennisResult } | { kind: 'quit' } | { kind: 'restart' };

type Phase = 'intro' | 'between' | 'serve' | 'rally' | 'dead' | 'replay' | 'over';

interface Task {
  t: number;
  fn: () => void;
}

interface RecFrame {
  g: number;
  bx: number;
  by: number;
  bz: number;
  vis: boolean;
  me: AthleteSnap;
  opp: AthleteSnap;
}

const NEAR_Z = COURT.halfLength + 0.45;
const RECEIVE_Z = COURT.halfLength + 0.9;

const OPP_NAMES: Record<'m' | 'f', Record<Difficulty, string>> = {
  m: { easy: 'T. Brooks', normal: 'M. Duarte', hard: 'K. Varga' },
  f: { easy: 'L. Moreau', normal: 'A. Sato', hard: 'E. Novak' },
};

const SHOT_NAMES: Record<ShotKind, string> = { flat: 'Flat', topspin: 'Topspin', slice: 'Slice', lob: 'Lob', drop: 'Drop shot' };

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const other = (s: Side): Side => (s === 0 ? 1 : 0);

export class TennisGame {
  private el!: HTMLElement;
  private r3d!: Renderer3D;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(44, 16 / 9, 0.1, 400);
  private stadium!: Stadium;
  private ball!: BallView;
  private puffs = new Puffs();
  private me!: Athlete;
  private opp!: Athlete;
  private extras: Athlete[] = [];
  private sounds!: TennisSounds;
  private hud: Record<string, HTMLElement> = {};
  private preview!: CamPreview;
  private pauseGesture = new HandsUpPause();
  private bot: TennisBot | null = null;
  private botHint: BotHint = { serveReady: false, serveAt: 0, incoming: null };
  private targets: Target[] = [];
  private resolve!: (o: TennisOutcome) => void;
  private raf = 0;
  private lastFrame = 0;
  private paused = false;
  private ended = false;
  private rand = rng(Date.now() & 0xffff);

  // clocks
  private gt = 0;
  private frameEnd = 0;
  private framePerf = 0;
  private animT = 0;
  private clockHist: { p: number; g: number }[] = [];
  private tasks: Task[] = [];

  // match state
  private score: MatchScore;
  private names: [string, string];
  /** Names as the umpire says them (surname for the opponent). */
  private callNames: [string, string];
  private phase: Phase = 'intro';
  private phaseT = 0;
  private serveNo: 1 | 2 = 1;
  private server: Side = 0;

  // ball state
  private flight: Flight | null = null;
  private flT0 = 0;
  private evIdx = 0;
  private hitter: Side = 0;
  private bounces = 0;
  private region: Region = singlesHalf(true);
  private isServe = false;
  private cord = false;
  private rallyShots = 0;
  private ballHidden = true;
  private ballOffset = new THREE.Vector3();
  private toss: { by: Side; t0: number; struck: boolean } | null = null;
  private lastBall = new THREE.Vector3(0, 1, 0);

  // receivers
  private humanIc: Intercept | null = null;
  private humanIcId = 0;
  private humanSwung = false;
  private aiIc: Intercept | null = null;
  private predIc: { ic: Intercept; t0: number } | null = null;
  private aiShot: { state: BallState; speed: number } | null = null;
  private aiPlan: { target: { x: number; z: number }; speed: number; spin: number; high: boolean; clearance: number; error: 'net' | 'long' | 'wide' | null; kind: ShotKind } | null = null;

  // input
  private lastPoseT = 0;
  private handHist: { t: number; x: number; y: number }[] = [];
  private swingBest: { t: number; vx: number; vy: number; speed: number; x: number; y: number } | null = null;
  private swingCool = 0;
  private tossSince = 0;
  private latestBody: Body | null = null;
  private noBodySince = 0;

  // stats
  private st = { won: 0, lost: 0, aces: 0, df: 0, winners: 0, errors: 0, longest: 0, fastest: 0, firstIn: 0, firstTotal: 0, perfects: 0, shots: 0 };
  private rallyScore = 0;
  private lives = 3;
  private targetHits = 0;
  private lastShot = '';
  private tutorialStep = 0;
  private pointsPlayed = 0;
  private lastReplayPoint = -9;

  // camera / juice
  private shake = 0;
  private camPos = new THREE.Vector3(0, 6, 26);
  private camLook = new THREE.Vector3(0, 0.5, -6);
  private rec: RecFrame[] = [];
  private replay: { frames: RecFrame[]; t: number; t0: number; t1: number; live: [AthleteSnap, AthleteSnap]; after: () => void } | null = null;
  private lastHud: Record<string, string> = {};
  private fpsAvg = 30;
  private evLog: string[] = [];
  private log(msg: string): void {
    this.evLog.push(`${this.gt.toFixed(1)} ${msg}`);
    if (this.evLog.length > 12) this.evLog.shift();
  }

  constructor(
    private env: GameEnv,
    private cfg: TennisConfig,
    private assets: TennisAssets,
  ) {
    this.score = new MatchScore(FORMATS[cfg.format], 0);
    this.names = ['You', OPP_NAMES[cfg.sex][cfg.difficulty]];
    this.callNames = ['you', this.names[1].split(' ').pop()!];
  }

  run(): Promise<TennisOutcome> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.build();
      this.env.cursor(false);
      const go = () => {
        if (this.ended) return;
        this.ball.visible = false;
        this.el.classList.remove('compiling');
        this.lastFrame = performance.now();
        this.lastPoseT = performance.now();
        this.raf = requestAnimationFrame(this.frame);
        this.startIntro();
      };
      // Compile every shader up front (in parallel where supported) so the intro does not stutter.
      this.el.classList.add('compiling');
      this.ball.visible = true;
      this.updateVisuals(0, performance.now());
      const warm = () => {
        // Draw everything once (no culling) so every shader, shadow and bloom program is built now.
        const culled: THREE.Object3D[] = [];
        this.scene.traverse((o) => {
          if (o.frustumCulled) {
            o.frustumCulled = false;
            culled.push(o);
          }
        });
        this.camera.position.set(0, 9, 30);
        this.camera.lookAt(0, 0, 0);
        this.r3d.render(0);
        for (const o of culled) o.frustumCulled = true;
        requestAnimationFrame(go);
      };
      this.r3d.renderer.compileAsync(this.scene, this.camera).then(warm, warm);
    });
  }

  // ---- setup -----------------------------------------------------------------------------------------

  private build(): void {
    const { cfg, env } = this;

    const venue = VENUES[cfg.venue];
    this.el = document.createElement('div');
    this.el.className = `game-root tennis v-${venue.id}`;
    this.el.innerHTML = `
      <canvas class="gl"></canvas>
      <div class="t-vignette"></div>
      <div class="ghud">
        <div class="t-bug">
          <div class="t-bug-head"><span class="t-venue"></span><span class="t-fmt"></span></div>
          <div class="t-row r0"><i class="srv"></i><b class="nm"></b><span class="sets"></span><span class="pts"></span></div>
          <div class="t-row r1"><i class="srv"></i><b class="nm"></b><span class="sets"></span><span class="pts"></span></div>
          <div class="t-bug-foot"></div>
        </div>
        <div class="t-side tr"></div>
        <button class="t-pause" data-hc aria-label="Pause">❚❚</button>
        <div class="t-call"></div>
        <div class="t-lower"><span></span></div>
        <div class="t-prompt"></div>
        <div class="t-feedback">
          <div class="t-meter"><i class="z-early"></i><i class="z-perfect"></i><i class="z-late"></i><b></b></div>
          <div class="t-fb-text"><em></em><span></span></div>
        </div>
        <div class="t-rally"><span>Rally</span><b>0</b></div>
        <div class="t-replay"><span>REPLAY</span><i></i></div>
        <div class="t-title"><small></small><b></b><span></span></div>
        <div class="t-hint">Raise both hands to pause</div>
        <div class="t-loading"><i></i><span>Preparing the court…</span></div>
      </div>`;
    env.root.appendChild(this.el);
    const q = (s: string) => this.el.querySelector(s) as HTMLElement;
    this.hud = {
      venue: q('.t-venue'),
      fmt: q('.t-fmt'),
      r0: q('.t-row.r0'),
      r1: q('.t-row.r1'),
      foot: q('.t-bug-foot'),
      side: q('.t-side'),
      call: q('.t-call'),
      lower: q('.t-lower'),
      lowerText: q('.t-lower span'),
      prompt: q('.t-prompt'),
      fb: q('.t-feedback'),
      meterMark: q('.t-meter b'),
      fbLabel: q('.t-fb-text em'),
      fbText: q('.t-fb-text span'),
      rally: q('.t-rally'),
      rallyN: q('.t-rally b'),
      replay: q('.t-replay'),
      replayBar: q('.t-replay i'),
      title: q('.t-title'),
      bug: q('.t-bug'),
    };
    this.hud.venue.textContent = venue.name;
    this.hud.fmt.textContent = cfg.mode === 'rally' ? 'Rally challenge' : cfg.format === 'tiebreak' ? 'Tie-break' : cfg.format === 'short' ? 'Short set' : 'Full set';
    (this.hud.r0.querySelector('.nm') as HTMLElement).textContent = this.names[0];
    (this.hud.r1.querySelector('.nm') as HTMLElement).textContent = this.names[1];
    q('.t-pause').addEventListener('click', () => void this.pause());
    this.preview = new CamPreview(env.pose);
    this.preview.canvas.classList.add('t-cam');
    if (!env.settings.showCamera) this.preview.canvas.style.display = 'none';
    q('.ghud').appendChild(this.preview.canvas);
    if (cfg.mode === 'rally') this.hud.bug.classList.add('rally');

    const canvas = q('canvas.gl') as HTMLCanvasElement;
    this.r3d = new Renderer3D(canvas, this.scene, this.camera, env.settings.quality, {
      shadows: true,
      exposure: venue.exposure,
      bloom: venue.night ? { strength: 0.55, radius: 0.5, threshold: 0.92 } : undefined,
    });
    const sky = this.assets.skies[venue.id]!;
    this.stadium = new Stadium(venue, sky, this.scene, this.r3d.renderer);
    this.scene.add(this.stadium.group, this.puffs.points);
    this.ball = new BallView(this.scene);
    this.ball.visible = false;

    // Players.
    const kit = this.assets.kit;
    const female = cfg.sex === 'f';
    const isGrass = venue.id === 'grass';
    const myOutfit: Outfit = {
      shirt: isGrass ? '#f7f7f2' : '#f4f6fa',
      trim: isGrass ? '#1d2f5c' : '#1b4fd1',
      shorts: isGrass ? '#f3f3ee' : '#1a2238',
      shoes: '#f4f4f4',
      socks: '#fafafa',
      skin: female ? '#e0b496' : '#d6a684',
      hair: female ? 'Hair_Buns' : 'Hair_SimpleParted',
      hairColor: female ? '#5a3a22' : '#3b2a1d',
      skirt: female,
      sleeveless: female,
      racket: '#1b4fd1',
      wristband: true,
    };
    const oppOutfit: Outfit = {
      shirt: isGrass ? '#f5f5f0' : '#d7263d',
      trim: isGrass ? '#2f7d4a' : '#1a1a1a',
      shorts: isGrass ? '#f2f2ec' : '#1a1a1a',
      shoes: isGrass ? '#f4f4f4' : '#222222',
      socks: isGrass ? '#fafafa' : '#f0f0f0',
      skin: female ? '#c99577' : '#b9825f',
      hair: female ? 'Hair_Long' : 'Hair_Buzzed+Hair_Beard',
      hairColor: female ? '#2a1d14' : '#1d1612',
      skirt: female,
      sleeveless: female,
      racket: '#d7263d',
      wristband: false,
    };
    this.me = new Athlete(kit, { female, outfit: myOutfit, handed: cfg.hand });
    this.opp = new Athlete(kit, { female, outfit: oppOutfit, handed: this.rand() < 0.8 ? 'right' : 'left' });
    this.scene.add(this.me.group, this.opp.group);
    this.me.maxSpeed = cfg.difficulty === 'easy' ? 8.5 : cfg.difficulty === 'normal' ? 6.8 : 6.3;
    this.me.accel = 22;
    const P = AI[cfg.difficulty];
    this.opp.maxSpeed = cfg.mode === 'rally' ? 8.5 : P.speed;
    this.opp.accel = 16;
    this.me.onStep = (sp) => this.sounds?.step(sp, clamp(this.me.x / 8, -1, 1));
    this.opp.onStep = (sp) => this.sounds?.step(sp * 0.6, clamp(this.opp.x / 8, -1, 1));
    this.me.place(0.8, NEAR_Z, Math.PI);
    this.opp.place(-0.8, -NEAR_Z, 0);

    // Umpire and ball kids.
    const ump = new Athlete(kit, {
      female: false,
      handed: 'right',
      staticClip: 'Sitting_Idle_Loop',
      outfit: { shirt: '#1d2a44', trim: '#e8e8e8', shorts: '#1d2a44', shoes: '#111111', socks: '#1d2a44', skin: '#c8987a', hair: 'Hair_Buzzed', hairColor: '#6b6b6b', racket: '#000', wristband: false },
    });
    const seat = this.stadium.umpireSeat;
    ump.place(seat.x, seat.z, Math.PI / 2);
    ump.group.position.y = seat.y - 0.5;
    ump.look.set(0, 1, 0);
    this.extras.push(ump);
    for (const sx of [-1, 1]) {
      const kid = new Athlete(kit, {
        female: sx > 0,
        handed: 'right',
        scale: 0.72,
        staticClip: 'Crouch_Idle_Loop',
        outfit: {
          shirt: isGrass ? '#5b3a8a' : '#2b9348',
          trim: '#ffffff',
          shorts: isGrass ? '#5b3a8a' : '#1a2238',
          shoes: '#f4f4f4',
          socks: '#ffffff',
          skin: sx > 0 ? '#d9a989' : '#a87656',
          hair: sx > 0 ? 'Hair_Buns' : 'Hair_Buzzed',
          hairColor: '#2a1d14',
          racket: '#000',
          wristband: false,
          skirt: sx > 0,
          sleeveless: sx > 0,
        },
      });
      kid.place(sx * 6.95, 0.55, -sx * Math.PI / 2 + Math.PI);
      this.extras.push(kid);
    }
    for (const a of this.extras) this.scene.add(a.group);

    if (cfg.mode === 'rally') {
      for (const c of [venue.accent, '#ffffff']) {
        const tg = new Target(c);
        this.targets.push(tg);
        this.scene.add(tg.group);
      }
      this.placeTargets();
    }

    this.sounds = new TennisSounds(env.audio, venue.id);
    this.sounds.voiceOn = cfg.voice && !env.demo;
    void this.sounds.prepare().then(() => this.sounds.setCrowdLevel(1));

    if (env.demo && env.pose instanceof SimPose) {
      this.bot = new TennisBot(cfg.hand, cfg.difficulty === 'hard' ? 0.85 : cfg.difficulty === 'normal' ? 0.75 : 0.6);
      const sim = env.pose;
      sim.drive = (t) => this.bot!.drive(t, this.botHint);
    }
    this.updateScoreHud();
  }

  private placeTargets(): void {
    const d = this.cfg.difficulty;
    const r = d === 'easy' ? 1.45 : d === 'normal' ? 1.15 : 0.9;
    const spots = [
      { x: -2.9, z: -9.8 },
      { x: 2.9, z: -9.8 },
      { x: -3.0, z: -4.2 },
      { x: 3.0, z: -4.2 },
      { x: 0, z: -10.2 },
      { x: -1.8, z: -7.5 },
      { x: 1.8, z: -7.5 },
    ];
    const pick = () => spots[Math.floor(this.rand() * spots.length)];
    let a = pick();
    let b = pick();
    while (b === a) b = pick();
    this.targets[0].place(a.x, a.z, r);
    this.targets[1].place(b.x, b.z, r);
  }

  // ---- main loop -------------------------------------------------------------------------------------

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    // Demo/headless runs can be very slow (software WebGL): let game time keep up with real time there.
    const rdt = Math.min(this.env.demo ? 3.0 : 0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    if (rdt > 0) this.fpsAvg += 0.05 * (1 / Math.max(rdt, 1e-3) - this.fpsAvg);
    if (this.paused) {
      this.r3d.render(0);
      return;
    }
    if (this.replay) {
      this.stepReplay(rdt);
    } else {
      const dt = rdt;
      // This frame shows game time `end` at performance time `now`.
      const end = this.gt + dt;
      this.frameEnd = end;
      this.framePerf = now;
      this.clockHist.push({ p: now, g: end });
      while (this.clockHist.length > 240) this.clockHist.shift();
      this.processPose(now);
      this.advance(end);
      this.gt = end;
      this.phaseT += dt;
      this.tickPhase();
      for (let t = 0; t < dt - 1e-6; t += 1 / 60) {
        const h = Math.min(1 / 60, dt - t);
        this.me.update(h);
        this.opp.update(h);
      }
      this.record();
    }
    this.animT += rdt;
    this.updateVisuals(rdt, now);
    this.updateHud();
    this.r3d.render(rdt);
  };

  /** Game time at a performance.now() capture time. */
  private gtAt(p: number): number {
    const h = this.clockHist;
    if (!h.length) return this.gt;
    const last = h[h.length - 1];
    if (p >= last.p) return last.g + (p - last.p) / 1000;
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].p <= p) {
        const a = h[i - 1];
        const b = h[i];
        const k = (p - a.p) / Math.max(1e-6, b.p - a.p);
        return a.g + (b.g - a.g) * k;
      }
    }
    return h[0].g - (h[0].p - p) / 1000;
  }

  private gtToPerf(g: number): number {
    return this.framePerf + (g - this.frameEnd) * 1000;
  }

  private later(dt: number, fn: () => void): void {
    this.at(this.gt + dt, fn);
  }

  private at(t: number, fn: () => void): void {
    this.tasks.push({ t, fn });
    this.tasks.sort((a, b) => a.t - b.t);
  }

  /** Run scheduled tasks and ball events in time order up to game time `to`. */
  private advance(to: number): void {
    for (let guard = 0; guard < 200; guard++) {
      const task = this.tasks[0];
      const ev = this.flight && this.evIdx < this.flight.events.length ? this.flight.events[this.evIdx] : null;
      const tEv = ev ? this.flT0 + ev.t : Infinity;
      const tTask = task ? task.t : Infinity;
      if (Math.min(tEv, tTask) > to) break;
      if (tTask <= tEv) {
        this.tasks.shift();
        const save = this.gt;
        this.gt = Math.max(this.gt, task.t);
        task.fn();
        this.gt = Math.max(save, this.gt);
      } else {
        this.evIdx++;
        this.onEvent(ev!);
      }
    }
  }

  // ---- phases ----------------------------------------------------------------------------------------

  private setPhase(p: Phase): void {
    this.phase = p;
    this.phaseT = 0;
  }

  private startIntro(): void {
    this.setPhase('intro');
    const v = VENUES[this.cfg.venue];
    const title = this.hud.title;
    (title.querySelector('small') as HTMLElement).textContent = v.name;
    (title.querySelector('b') as HTMLElement).textContent = this.cfg.mode === 'rally' ? 'Rally Challenge' : `${this.names[0]} vs ${this.names[1]}`;
    (title.querySelector('span') as HTMLElement).textContent = `${this.cfg.difficulty} · ${this.hud.fmt.textContent}`;
    title.classList.add('show');
    this.me.idle = 1;
    this.opp.idle = 1;
    this.me.place(-2.5, NEAR_Z + 2.5, Math.PI);
    this.opp.place(2.5, -NEAR_Z - 2.5, 0);
    this.stadium.crowd.applaud(0.9);
    this.later(0.3, () => this.sounds.applause(0.8));
    this.later(this.env.demo ? 2.2 : 3.2, () => {
      title.classList.remove('show');
      if (this.cfg.mode === 'rally') this.startRallyFeed(true);
      else this.beginPoint();
    });
  }

  private tickPhase(): void {
    if (this.phase === 'serve' && this.server === 0 && !this.toss) {
      this.botHint.serveReady = true;
    } else this.botHint.serveReady = false;
    // Human serve: the toss drops if they never swing.
    if (this.toss && this.toss.by === 0 && !this.toss.struck && this.gt > this.toss.t0 + 1.35) {
      this.toss = null;
      this.me.swing = null;
      this.ballHidden = false;
      this.hint('Let it drop — toss again');
      this.botHint.serveAt = 0;
    }
    // Human receiver missed completely.
    if (this.phase === 'rally' && this.humanIc && !this.humanSwung && this.flight) {
      const tc = this.flT0 + this.humanIc.t;
      if (this.gt > tc + WINDOWS[this.cfg.difficulty].late + 0.3) {
        this.humanSwung = true;
        this.me.swing = null;
        this.feedback('Missed', '', null);
      }
    }
    if (this.phase === 'serve' && this.server === 0 && !this.toss && this.cfg.tutorial && this.phaseT > 0.5) {
      this.prompt(this.tutorialStep < 2 ? 'Raise your racket hand above your head to toss' : 'Raise your hand to toss · swing down to serve');
    }
  }

  /** Set up the next point: players walk to their positions, then serve. */
  private beginPoint(): void {
    this.setPhase('between');
    const sc = this.score;
    this.server = sc.server;
    this.serveNo = 1;
    this.flight = null;
    this.toss = null;
    this.humanIc = null;
    this.aiIc = null;
    this.rallyShots = 0;
    this.positionForServe(false);
    this.updateScoreHud();
    const call = sc.call(this.callNames);
    const pressure = this.pressureLabel();
    if (pressure) this.later(0.4, () => this.lowerThird(pressure, true));
    else if (call && this.pointsPlayed > 0) this.later(0.3, () => this.lowerThird(call, false));
    this.later(this.pointsPlayed === 0 ? 0.6 : 1.4, () => this.startServe());
  }

  private pressureLabel(): string {
    const sc = this.score;
    if (sc.finished) return '';
    for (const s of [0, 1] as Side[]) if (sc.matchPointFor(s)) return `Match point · ${this.names[s]}`;
    if (sc.isBreakPoint()) return `Break point${sc.server === 0 ? ' against you' : ''}`;
    if (sc.tiebreak && sc.points[0] + sc.points[1] === 0) return 'Tie-break';
    return '';
  }

  private positionForServe(teleport: boolean): void {
    const side = this.score.serveSide;
    const deuce = side === 'deuce';
    // Near player faces -z (right = +x); far player faces +z (right = -x).
    const nearServeX = deuce ? 0.7 : -0.7;
    const farServeX = deuce ? -0.7 : 0.7;
    const nearRecvX = deuce ? 2.3 : -2.3;
    const farRecvX = deuce ? -2.3 : 2.3;
    const meT = this.server === 0 ? { x: nearServeX, z: NEAR_Z - 0.15 } : { x: nearRecvX, z: RECEIVE_Z };
    const oppT = this.server === 1 ? { x: farServeX, z: -NEAR_Z + 0.15 } : { x: farRecvX, z: -RECEIVE_Z };
    this.me.idle = 1;
    this.opp.idle = 1;
    if (teleport) {
      this.me.place(meT.x, meT.z, Math.PI);
      this.opp.place(oppT.x, oppT.z, 0);
    } else {
      this.me.maxSpeed = 2.6;
      this.opp.maxSpeed = 2.6;
      this.me.moveTo(meT.x, meT.z);
      this.opp.moveTo(oppT.x, oppT.z);
    }
    this.me.faceYaw = Math.PI;
    this.opp.faceYaw = 0;
  }

  private assistReaction(): number {
    return this.cfg.difficulty === 'easy' ? 0.04 : this.cfg.difficulty === 'normal' ? 0.1 : 0.14;
  }

  private restoreSpeeds(): void {
    const d = this.cfg.difficulty;
    this.me.maxSpeed = d === 'easy' ? 8.5 : d === 'normal' ? 6.8 : 6.3;
    this.opp.maxSpeed = this.cfg.mode === 'rally' ? 8.5 : AI[d].speed;
  }

  private startServe(): void {
    this.setPhase('serve');
    // Snap anyone who has not arrived yet.
    const meT = this.me.target;
    const oppT = this.opp.target;
    if (Math.hypot(this.me.x - meT.x, this.me.z - meT.z) > 0.4) this.me.place(meT.x, meT.z, Math.PI);
    if (Math.hypot(this.opp.x - oppT.x, this.opp.z - oppT.z) > 0.4) this.opp.place(oppT.x, oppT.z, 0);
    this.restoreSpeeds();
    this.me.idle = 0;
    this.opp.idle = 0;
    this.me.faceYaw = Math.PI;
    this.opp.faceYaw = 0;
    this.flight = null;
    this.cord = false;
    this.ballHidden = false;
    this.toss = null;
    this.updateScoreHud();
    if (this.server === 1) {
      const delay = 0.7 + this.rand() * 0.5;
      this.later(delay, () => this.aiServe());
      if (this.cfg.tutorial && this.tutorialStep < 3) this.prompt('Get ready to return — swing when the ball reaches you');
    }
  }

  // ---- serving ---------------------------------------------------------------------------------------

  private aiServe(): void {
    if (this.phase !== 'serve') return;
    const o = this.opp;
    o.startSwing('serve', 0, -1.25);
    const release = this.gt + 0.5;
    const contactAt = this.gt + 1.25;
    // Decide and solve the serve now (the toss is deterministic), so the return is known early.
    const box = serviceBox(false, this.score.serveSide);
    const dec = decideAiServe(this.rand, this.cfg.difficulty, this.serveNo === 1, box);
    this.toss = { by: 1, t0: release, struck: false };
    const from = this.tossPos(1, contactAt);
    this.toss = null;
    const sol = solveShot({ from, target: dec.target, speed: dec.speed, spin: dec.spin, clearance: 0.07 }, SURFACES[this.cfg.venue]);
    const state = dec.fault === 'net' ? this.intoNet(sol.state) : sol.state;
    this.predictHumanReturn(state, contactAt, true);
    this.later(0.5, () => (this.toss = { by: 1, t0: release, struck: false }));
    this.at(contactAt, () => {
      if (this.phase !== 'serve' || !this.toss) return;
      this.toss.struck = true;
      this.sounds.hit(0.9, clamp(o.x / 8, -1, 1), false);
      this.log(`AI serve ${kmh(sol.speed)} fault=${dec.fault}`);
      this.strike(1, state, true, contactAt);
      if (dec.speed > 45) this.shake = Math.max(this.shake, 0.15);
      this.serveSpeed(kmh(sol.speed), 1);
    });
  }

  /**
   * Work out where the human will meet an AI shot before it is struck (the AI decides early), so the
   * assist can move off quickly and the demo bot gets its timing even at very low frame rates.
   */
  private predictHumanReturn(state: BallState, t0: number, serve: boolean): void {
    const f = new Flight(state, SURFACES[this.cfg.venue], 6);
    const first = f.events.find((e) => e.kind === 'bounce' || e.kind === 'net');
    const region = serve ? serviceBox(false, this.score.serveSide) : singlesHalf(false);
    this.predIc = null;
    if (!first || first.kind !== 'bounce' || !isIn(first.p, region)) return;
    const pos = this.me.target;
    const lead = Math.max(0, t0 - this.gt);
    const ic = chooseIntercept(f, -lead, pos, true, this.me.handed, this.me.maxSpeed, this.assistReaction());
    if (!ic) return;
    this.predIc = { ic, t0 };
    this.humanIcId++;
    this.botHint.incoming = { at: this.gtToPerf(t0 + ic.t), stroke: ic.stroke, id: this.humanIcId };
  }

  /** Ball position during a toss (world). */
  private tossPos(by: Side, g: number): V3 {
    const a = by === 0 ? this.me : this.opp;
    const t0 = this.toss ? this.toss.t0 : g;
    const tau = g - t0 - 0.75;
    const [u, y, w] = tossAt(tau);
    const p = a.toWorld(u, y, w);
    return { x: p.x, y: p.y, z: p.z };
  }

  private humanToss(t: number): void {
    if (this.phase !== 'serve' || this.server !== 0 || this.toss) return;
    this.log('toss');
    const g = Math.max(this.gtAt(t), this.gt - 0.05);
    this.toss = { by: 0, t0: g + 0.03, struck: false };
    this.me.startSwing('serve', 0, -0.78, -0.16);
    this.botHint.serveAt = this.gtToPerf(this.toss.t0 + 0.75);
    if (this.cfg.tutorial) this.prompt('Now swing down fast to serve!');
    this.tutorialStep = Math.max(this.tutorialStep, 1);
  }

  private humanServeSwing(f: SwingFeatures): void {
    const toss = this.toss!;
    const tcap = this.gtAt(f.t);
    const ideal = toss.t0 + 0.75;
    const dtS = tcap - ideal;
    // Generous window: reacting to the toss on screen.
    const w = { early: 0.42, late: 0.36 };
    if (dtS < -w.early) return; // still bringing the arm up
    const timing = judgeTiming(dtS, w) ?? { dt: dtS, e: 1, label: 'Late' as const, quality: 0 };
    this.log(`serve swing dt=${dtS.toFixed(2)} v=${f.speed.toFixed(1)}`);
    toss.struck = true;
    this.botHint.serveAt = 0;
    const tStrike = clamp(Math.max(tcap + 0.06, this.gt - 0.03), toss.t0 + 0.55, toss.t0 + 1.05);
    this.me.release(Math.max(0.02, tStrike - this.gt));
    const from = this.tossPos(0, tStrike);
    this.me.setContact(new THREE.Vector3(from.x, from.y, from.z));
    this.at(tStrike, () => this.humanServeStrike(f, timing, from));
  }

  private humanServeStrike(f: SwingFeatures, timing: Timing, from: V3): void {
    const d = this.cfg.difficulty;
    const s = this.cfg.hand === 'right' ? 1 : -1;
    const sp = serveFromSwing(f.speed, f.vx, timing, this.serveNo === 1, d);
    const box = serviceBox(true, this.score.serveSide);
    const cx = (box.x0 + box.x1) / 2;
    const half = (box.x1 - box.x0) / 2;
    // Swing direction picks the side of the box (natural across-the-body path is neutral).
    const raw = (f.vx * s) / Math.max(1, f.speed);
    const aim = clamp((raw + 0.3) * 1.8, -1, 1) * s;
    let x = cx + aim * half * 0.72;
    let z = -(COURT.service - 0.55 - this.rand() * 0.7);
    x += gauss(this.rand) * sp.error;
    z += gauss(this.rand) * sp.error * 0.8;
    if (d === 'easy') {
      x = clamp(x, box.x0 + 0.35, box.x1 - 0.35);
      z = clamp(z, -COURT.service + 0.35, -1.5);
    }
    const sol = solveShot({ from, target: { x, z }, speed: sp.speed, spin: sp.spin, clearance: d === 'easy' ? 0.3 : 0.08 }, SURFACES[this.cfg.venue]);
    let state = sol.state;
    if (d !== 'easy' && timing.quality < 0.15 && this.rand() < 0.5) state = this.intoNet(state);
    const pace = clamp((sol.speed - 28) / 24, 0, 1);
    this.sounds.hit(pace, clamp(this.me.x / 8, -1, 1), true);
    if (sol.speed > 44) this.shake = Math.max(this.shake, 0.22);
    this.strike(0, state, true, this.gt);
    if (this.serveNo === 1) this.st.firstTotal++;
    this.st.fastest = Math.max(this.st.fastest, kmh(sol.speed));
    this.serveSpeed(kmh(sol.speed), 0);
    this.feedback(timing.label, `${this.serveNo === 1 ? 'First' : 'Second'} serve · ${kmh(sol.speed)} km/h`, timing);
    if (timing.label === 'Perfect') this.st.perfects++;
    this.prompt('');
    this.tutorialStep = Math.max(this.tutorialStep, 2);
  }

  /** Lower a launch until it finds the net. */
  private intoNet(s: BallState): BallState {
    const st = { p: { ...s.p }, v: { ...s.v }, w: { ...s.w } };
    for (let i = 0; i < 30; i++) {
      const f = new Flight(st, SURFACES[this.cfg.venue], 2);
      if (f.firstOf('net')) return st;
      st.v.y -= 0.35;
    }
    return st;
  }

  // ---- strikes and events ------------------------------------------------------------------------------

  /** A player hit the ball at game time `t0`. */
  private strike(by: Side, state: BallState, serve: boolean, t0: number): void {
    this.flight = new Flight(state, SURFACES[this.cfg.venue], 6);
    this.flT0 = t0;
    this.evIdx = 0;
    this.hitter = by;
    this.bounces = 0;
    this.isServe = serve;
    this.cord = false;
    this.toss = null;
    this.ballHidden = false;
    this.rallyShots++;
    this.region = serve ? serviceBox(by === 0, this.score.serveSide) : singlesHalf(by === 0);
    if (this.phase !== 'rally') this.setPhase('rally');
    this.humanIc = null;
    this.aiIc = null;
    this.aiPlan = null;
    if (by === 0) this.aiShot = null;
    const keepHint = by === 1 && this.predIc && Math.abs(this.predIc.t0 - t0) < 1e-6;
    if (!keepHint) this.botHint.incoming = null;
    const f = this.flight;
    const first = f.events.find((e) => e.kind === 'bounce' || e.kind === 'net') ?? null;
    const willBeIn = !!first && first.kind === 'bounce' && isIn(first.p, this.region);
    const ft = this.gt - t0;
    if (by === 0) {
      // Hitter recovers towards the middle of the possible replies.
      const tx = clamp((first?.p.x ?? 0) * 0.22, -1.6, 1.6);
      this.me.moveTo(tx, NEAR_Z + 0.3);
      if (this.me.swing && this.me.swing.holdAt !== null) this.me.swing = null;
      if (willBeIn) this.aiReceive(f, ft);
    } else {
      const tx = clamp((first?.p.x ?? 0) * 0.22, -1.6, 1.6);
      this.opp.moveTo(tx, -NEAR_Z - 0.3);
      if (willBeIn) this.humanReceive(f, ft);
      else if (first && first.kind === 'bounce') {
        // Ball is going out: the assist lets it go.
        this.me.moveTo(clamp(first.p.x * 0.6, -3, 3), RECEIVE_Z);
      }
    }
    if (this.rallyShots > this.st.longest && this.cfg.mode === 'match') this.st.longest = this.rallyShots;
  }

  private aiReceive(f: Flight, ft: number): void {
    const P = AI[this.cfg.difficulty];
    const rally = this.cfg.mode === 'rally';
    const ic = chooseIntercept(f, ft, { x: this.opp.x, z: this.opp.z }, false, this.opp.handed, rally ? 8.5 : P.speed, rally ? 0.1 : P.reaction);
    if (!ic) return;
    this.aiIc = ic;
    const tc = this.flT0 + ic.t;
    this.later(rally ? 0.1 : P.reaction, () => this.opp.moveTo(ic.stand.x, ic.stand.z, Math.max(0.05, tc - this.gt - 0.08)));
    const kind: SwingKind = ic.height > 1.5 ? 'smash' : ic.stroke === 'forehand' ? 'fh' : 'bh';
    const flightRef = f;
    // Decide the reply a little later (spreads the solver cost away from the human's hit).
    this.later(0.22, () => {
      if (this.flight !== flightRef) return;
      const stretch = ic.reachable ? clamp(Math.hypot(ic.stand.x - this.opp.x, ic.stand.z - this.opp.z) / (P.speed * Math.max(0.3, ic.t - ft)), 0, 1) : 1;
      const v = f.velAt(ic.t);
      const plan = decideAiShot(this.rand, this.cfg.difficulty, {
        hitter: { x: ic.stand.x, z: ic.stand.z },
        opponent: { x: this.me.target.x, z: this.me.target.z },
        incomingSpeed: Math.hypot(v.x, v.y, v.z),
        contactHeight: ic.height,
        stretch,
        rally: this.rallyShots,
        feeder: rally,
      });
      this.aiPlan = plan;
      // Solve the reply now and tell the human side where it will go.
      if (ic.reachable || ic.shortfall <= 0.35) {
        const from = f.at(ic.t);
        let speed = plan.speed;
        if (ic.height > 1.5 && plan.kind !== 'lob') speed *= 1.25;
        const sol = solveShot({ from, target: plan.target, speed, spin: plan.spin, high: plan.high, clearance: plan.error === 'net' ? 0 : plan.clearance }, SURFACES[this.cfg.venue]);
        const state = plan.error === 'net' ? this.intoNet(sol.state) : sol.state;
        this.aiShot = { state, speed: sol.speed };
        this.predictHumanReturn(state, tc, false);
      }
    });
    const style: SwingStyle = this.rand() < 0.35 ? 0 : 1;
    const prepAt = tc - (kind === 'smash' ? 0.5 : 0.75);
    this.at(Math.max(this.gt, prepAt), () => {
      if (this.flight !== flightRef) return;
      this.opp.startSwing(kind, (this.aiPlan?.kind === 'slice' || this.aiPlan?.kind === 'drop' ? -1 : style) as SwingStyle, Math.max(-0.75, this.gt - tc));
      this.opp.setContact(this.vec(f.at(ic.t)));
    });
    this.at(tc, () => this.aiStrike(flightRef, ic));
  }

  private aiStrike(f: Flight, ic: Intercept): void {
    if (this.flight !== f || this.phase !== 'rally') return;
    this.log(`AI hit reach=${ic.reachable} short=${ic.shortfall.toFixed(2)} h=${ic.height.toFixed(2)}`);
    if (!ic.reachable && ic.shortfall > 0.35) {
      // Stretched too far: the ball gets past.
      return;
    }
    let shot = this.aiShot;
    if (!shot) {
      const plan = decideAiShot(this.rand, this.cfg.difficulty, {
        hitter: { x: ic.stand.x, z: ic.stand.z },
        opponent: { x: this.me.target.x, z: this.me.target.z },
        incomingSpeed: 20,
        contactHeight: ic.height,
        stretch: 0.5,
        rally: this.rallyShots,
        feeder: this.cfg.mode === 'rally',
      });
      const sol = solveShot({ from: f.at(ic.t), target: plan.target, speed: plan.speed, spin: plan.spin, high: plan.high, clearance: plan.clearance }, SURFACES[this.cfg.venue]);
      shot = { state: sol.state, speed: sol.speed };
    }
    this.aiShot = null;
    const pace = clamp((shot.speed - 15) / 22, 0, 1);
    this.sounds.hit(pace, clamp(this.opp.x / 8, -1, 1), false);
    if (ic.height > 1.5) this.shake = Math.max(this.shake, 0.12);
    this.strike(1, shot.state, false, this.flT0 + ic.t);
  }

  private humanReceive(f: Flight, ft: number): void {
    const pred = this.predIc && Math.abs(this.predIc.t0 - this.flT0) < 1e-6 ? this.predIc.ic : null;
    this.predIc = null;
    const fresh = pred ? null : chooseIntercept(f, ft, { x: this.me.x, z: this.me.z }, true, this.me.handed, this.me.maxSpeed, this.assistReaction());
    const ic = pred ?? fresh;
    if (fresh) this.humanIcId++;
    this.log(ic ? `incoming t=${(this.flT0 + ic.t).toFixed(2)} ${ic.stroke} h=${ic.height.toFixed(2)} reach=${ic.reachable}` : 'incoming: no intercept');
    if (!ic) return;
    this.humanIc = ic;
    this.humanSwung = false;
    const tc = this.flT0 + ic.t;
    this.me.moveTo(ic.stand.x, ic.stand.z, Math.max(0.05, tc - this.gt - 0.12));
    const kind: SwingKind = ic.stroke === 'forehand' ? 'fh' : 'bh';
    const flightRef = f;
    const id = this.humanIcId;
    this.at(Math.max(this.gt, tc - 0.62), () => {
      if (this.flight !== flightRef || this.humanSwung || id !== this.humanIcId) return;
      this.me.startSwing(kind, 0, Math.max(-0.62, this.gt - tc), -0.12);
      this.me.setContact(this.vec(f.at(ic.t)));
    });
    this.botHint.incoming = { at: this.gtToPerf(tc), stroke: ic.stroke, id: this.humanIcId };
    if (this.cfg.tutorial && this.tutorialStep < 4) {
      this.prompt(ic.stroke === 'forehand' ? 'Forehand — swing across your body when the ball reaches you' : 'Backhand — swing from your other side when the ball arrives');
    }
  }

  private onHumanSwing(f: SwingFeatures): void {
    if (this.phase === 'serve' && this.toss && this.toss.by === 0 && !this.toss.struck) {
      if (f.vy < -MIN_SERVE * 0.6 || f.speed > MIN_SERVE * 1.3) this.humanServeSwing(f);
      return;
    }
    const ic = this.humanIc;
    if (this.phase !== 'rally' || !ic || this.humanSwung || !this.flight || this.hitter !== 1) {
      this.log(`swing ignored ph=${this.phase} ic=${!!ic} swung=${this.humanSwung} hitter=${this.hitter} v=${f.speed.toFixed(1)}`);
      return;
    }
    const d = this.cfg.difficulty;
    const w = WINDOWS[d];
    const tc = this.flT0 + ic.t;
    const tcap = this.gtAt(f.t);
    const dtS = tcap - tc;
    const cls = classifySwing(f, this.cfg.hand);
    let timing = judgeTiming(dtS, w);
    this.log(`swing dt=${dtS.toFixed(2)} vsHint=${this.botHint.incoming ? Math.round(f.t - this.botHint.incoming.at) : 'na'}ms v=${f.speed.toFixed(1)} ${cls.stroke}/${cls.kind} ic=${ic.stroke}`);
    if (!timing) {
      if (dtS < -(w.early + 0.28)) return; // a practice swing or the backswing
      if (dtS > w.late + 0.45) return;
      this.humanSwung = true;
      this.me.release(0.05);
      this.feedback(dtS < 0 ? 'Too early' : 'Too late', 'Watch the ball onto the strings', null, dtS / (dtS < 0 ? w.early : w.late));
      return;
    }
    if (!ic.reachable && ic.shortfall > (d === 'easy' ? 1.2 : 0.45)) {
      this.humanSwung = true;
      this.me.release(0.05);
      this.feedback('Out of reach', '', timing);
      return;
    }
    this.humanSwung = true;
    // When the contact happens: soon after the swing, within the racket's reach of the ball's path.
    const f0 = this.flight;
    const vel = f0.velAt(ic.t);
    const hs = Math.max(4, Math.hypot(vel.x, vel.z));
    const tEarly = tc - 0.7 / hs;
    const tLate = tc + 0.55 / hs;
    const tStrike = clamp(Math.max(tcap + 0.06, this.gt - 0.03), tEarly, tLate);
    const wrongSide = cls.stroke !== ic.stroke;
    if (d === 'easy' && timing.quality < 0.4) timing = { ...timing, quality: Math.min(1, timing.quality + 0.3) };
    this.me.release(Math.max(0.02, tStrike - this.gt));
    const style: SwingStyle = cls.kind === 'topspin' || cls.kind === 'lob' ? 1 : cls.kind === 'slice' || cls.kind === 'drop' ? -1 : 0;
    if (this.me.swing) this.me.swing.style = style;
    const contact = f0.at(tStrike - this.flT0);
    this.me.setContact(this.vec(contact));
    const tm = timing;
    this.at(tStrike, () => this.humanStrike(f0, tStrike, cls.kind, cls.stroke, f.speed, tm, wrongSide, ic));
  }

  private humanStrike(f: Flight, t: number, kind: ShotKind, stroke: Stroke, swingSpeed: number, timing: Timing, wrongSide: boolean, ic: Intercept): void {
    if (this.flight !== f) return;
    const d = this.cfg.difficulty;
    const from = f.at(t - this.flT0);
    const vin = f.velAt(t - this.flT0);
    const k = kind;
    // Overheads on high balls.
    const smash = from.y > 1.45 && k !== 'lob' && k !== 'drop';
    const p = shotFromSwing({ stroke, kind: k }, swingSpeed, timing, {
      sideSign: ic.sideSign,
      difficulty: d,
      hitterX: from.x,
      wrongSide,
      incoming: Math.hypot(vin.x, vin.y, vin.z),
    });
    let x = p.x + gauss(this.rand) * p.error;
    let depth = p.depth + gauss(this.rand) * p.error * 0.8;
    if (d === 'easy') {
      x = clamp(x, -COURT.halfSingles + 0.4, COURT.halfSingles - 0.4);
      depth = clamp(depth, 2.2, COURT.halfLength - 0.6);
    }
    let speed = p.speed;
    if (smash) speed *= 1.25;
    const sol = solveShot({ from, target: { x, z: -depth }, speed, spin: p.spin, high: p.high, clearance: p.clearance }, SURFACES[this.cfg.venue]);
    let state = sol.state;
    if (p.mishit && this.rand() < 0.4) state = this.intoNet(state);
    else if (d !== 'easy') {
      // A touch of launch noise: flat, low shots sometimes clip the tape.
      state.v.y += gauss(this.rand) * 0.12 * (1 - timing.quality);
    }
    const pace = clamp((sol.speed - 15) / 22, 0, 1);
    this.sounds.hit(pace, clamp(this.me.x / 8, -1, 1), true, p.mishit);
    if (smash || sol.speed > 33) this.shake = Math.max(this.shake, smash ? 0.35 : 0.12);
    this.strike(0, state, false, t);
    this.st.shots++;
    if (timing.label === 'Perfect') this.st.perfects++;
    const strokeName = smash ? 'Smash' : `${SHOT_NAMES[k]} ${p.stroke}`;
    const dir = timing.e < -0.45 ? ' · cross-court' : timing.e > 0.45 ? ' · down the line' : '';
    const extra = p.mishit ? 'Framed it!' : wrongSide && d !== 'easy' ? `Wrong side — that was a ${ic.stroke}` : `${strokeName}${dir} · ${kmh(sol.speed)} km/h`;
    this.feedback(timing.label, extra, timing);
    this.lastShot = `${timing.label} ${strokeName} ${kmh(sol.speed)} km/h`;
    if (this.cfg.tutorial) {
      this.tutorialStep++;
      if (this.tutorialStep === 4) this.prompt('Early swing = cross-court · late swing = down the line', 3200);
      else if (this.tutorialStep === 6) this.prompt('Swing upward for topspin · chop down for slice', 3200);
      else if (this.tutorialStep === 8) this.prompt('Swing faster for more pace', 2600);
      else if (this.tutorialStep > 4) this.prompt('');
    }
    this.botHint.incoming = null;
  }

  private onEvent(e: FlightEvent): void {
    const near = e.p.z > 0;
    const pan = clamp(e.p.x / 8, -1, 1);
    if (e.kind === 'bounce') this.sounds.bounce(e.speed, pan, near);
    else if (e.kind === 'net') this.sounds.net();
    else if (e.kind === 'wall') this.sounds.wall();
    else if (e.kind === 'cord') {
      this.sounds.net();
      if (this.phase === 'rally') {
        this.sounds.oohs(0.8);
        this.stadium.crowd.applaud(0.25);
      }
    }
    if (this.phase === 'rally') this.log(`ev ${e.kind} t=${(this.flT0 + e.t).toFixed(2)} p=${e.p.x.toFixed(1)},${e.p.z.toFixed(1)} n=${this.bounces + (e.kind === 'bounce' ? 1 : 0)}`);
    if (this.phase !== 'rally') return;
    if (e.kind === 'cord') {
      this.cord = true;
      return;
    }
    if (e.kind === 'net') {
      if (this.isServe) this.fault('net');
      else this.endPoint(other(this.hitter), 'net');
      return;
    }
    if (e.kind !== 'bounce') return;
    this.bounces++;
    if (this.bounces === 1) {
      const inside = isIn(e.p, this.region);
      if (onLine(e.p) && inside) this.puffs.burst({ x: e.p.x, y: 0.02, z: e.p.z }, new THREE.Color(0.95, 0.95, 0.92), 14, 0.9, 0.5);
      else this.puffs.burst({ x: e.p.x, y: 0.02, z: e.p.z }, this.cfg.venue === 'grass' ? new THREE.Color(0.45, 0.55, 0.3) : new THREE.Color(0.6, 0.65, 0.75), 5, 0.4, 0.3);
      if (this.isServe) {
        if (!inside) this.fault(outDistance(e.p, this.region) < 0.25 ? 'close' : 'out');
        else if (this.cord) this.let();
        return;
      }
      if (!inside) {
        const close = outDistance(e.p, this.region) < 0.2;
        this.endPoint(other(this.hitter), close ? 'close-out' : 'out');
        return;
      }
      if (this.cfg.mode === 'rally' && this.hitter === 0) this.rallyLanded(e.p);
      return;
    }
    if (this.bounces >= 2) {
      // Second bounce: the receiver did not get it back.
      if ((e.p.z > 0) === (this.hitter === 1) || this.bounces >= 2) this.endPoint(this.hitter, this.isServe ? 'ace' : 'winner');
    }
  }

  private fault(kind: 'net' | 'out' | 'close'): void {
    this.log(`fault ${kind} by ${this.hitter}`);
    const byHuman = this.hitter === 0;
    this.setPhase('dead');
    this.humanIc = null;
    this.aiIc = null;
    this.botHint.incoming = null;
    if (this.cfg.mode === 'rally') return;
    if (this.serveNo === 1) {
      this.call('Fault', 'bad');
      this.sounds.callTone('fault');
      this.sounds.say('Fault', { rate: 1.1, pitch: 1.0 });
      if (kind === 'close') this.sounds.oohs(0.6);
      this.serveNo = 2;
      this.later(1.6, () => this.secondServe());
    } else {
      this.call('Double fault', 'bad');
      this.sounds.callTone('fault');
      this.sounds.say('Double fault', { rate: 1.0 });
      if (byHuman) this.st.df++;
      this.later(0.3, () => this.endPoint(other(this.hitter), 'double', true));
    }
  }

  private let(): void {
    this.setPhase('dead');
    this.humanIc = null;
    this.botHint.incoming = null;
    this.call('Let', '');
    this.sounds.callTone('let');
    this.sounds.say('Let', { rate: 1.0 });
    this.later(1.6, () => this.secondServe());
  }

  /** Serve again from the same side (after a fault or a let). */
  private secondServe(): void {
    this.rallyShots = 0;
    this.positionForServe(true);
    this.later(0.3, () => this.startServe());
  }

  // ---- points ------------------------------------------------------------------------------------------

  private endPoint(winner: Side, reason: 'net' | 'out' | 'close-out' | 'winner' | 'ace' | 'double', fromFault = false): void {
    this.log(`point ${winner} ${reason} hitter=${this.hitter} shots=${this.rallyShots}`);
    if (this.cfg.mode === 'rally') {
      this.rallyMiss(winner, reason);
      return;
    }
    if (this.phase === 'over' || (this.phase === 'dead' && !fromFault)) return;
    this.setPhase('dead');
    this.humanIc = null;
    this.aiIc = null;
    this.botHint.incoming = null;
    this.prompt('');
    this.pointsPlayed++;
    const sc = this.score;
    const serverWas = sc.server;
    const firstServeIn = this.serveNo === 1 && reason !== 'double';
    if (serverWas === 0 && firstServeIn) this.st.firstIn++;
    // Stats from the human's point of view.
    if (winner === 0) {
      this.st.won++;
      if (reason === 'ace' && this.hitter === 0) this.st.aces++;
      else if (reason === 'winner' && this.hitter === 0) this.st.winners++;
    } else {
      this.st.lost++;
      if ((reason === 'net' || reason === 'out' || reason === 'close-out') && this.hitter === 0) this.st.errors++;
    }
    const out = sc.pointWon(winner);
    // Calls and reactions.
    const rally = this.rallyShots;
    if (reason === 'out' || reason === 'close-out') {
      this.call('Out!', 'bad');
      this.sounds.callTone('out');
      this.sounds.say('Out!', { rate: 1.25, pitch: 1.15 });
      if (reason === 'close-out') this.sounds.oohs(0.9);
    } else if (reason === 'ace') {
      this.call(this.hitter === 0 ? 'Ace!' : 'Ace', this.hitter === 0 ? 'good' : '');
    } else if (reason === 'winner') {
      this.call(winner === 0 ? 'Winner!' : this.names[1] + ' wins the point', winner === 0 ? 'good' : '');
    } else if (reason === 'net') {
      this.call('Net', 'bad');
    }
    const big = rally >= 6 || reason === 'ace' || out.gameWon !== undefined;
    const level = clamp(0.35 + rally * 0.06 + (winner === 0 ? 0.2 : 0) + (out.gameWon !== undefined ? 0.3 : 0), 0.3, 1);
    this.later(0.35, () => {
      this.sounds.applause(level);
      this.stadium.crowd.applaud(level);
    });
    if (winner === 0 && (big || reason === 'winner')) this.later(0.4, () => (this.me.celebrate = 1));
    else if (winner === 1 && big) this.later(0.4, () => (this.opp.celebrate = 1));
    // Umpire call for the new score.
    const ocall = MatchScore.outcomeCall(out, this.callNames);
    const scall = sc.finished ? '' : sc.call(this.callNames);
    const callText = ocall || scall;
    this.later(1.0, () => {
      if (callText) this.sounds.say(callText, { rate: 0.95, pitch: 0.85 });
      this.updateScoreHud();
      if (out.gameWon !== undefined && !out.matchWon) this.lowerThird(out.breakOfServe ? `Break · ${ocall}` : ocall, true);
      else if (out.tiebreakStarts) this.lowerThird('Tie-break', true);
    });
    this.me.idle = 1;
    this.opp.idle = 1;
    this.me.maxSpeed = 2.4;
    this.opp.maxSpeed = 2.4;
    this.me.moveTo(this.me.x * 0.7, Math.max(this.me.z, NEAR_Z - 1));
    this.opp.moveTo(this.opp.x * 0.7, Math.min(this.opp.z, -NEAR_Z + 1));
    const next = () => {
      if (sc.finished) this.finishMatch();
      else this.beginPoint();
    };
    // Slow-motion replay for aces, long-rally winners and match point.
    const replayWorthy =
      (reason === 'ace' || (reason === 'winner' && rally >= 4) || out.matchWon !== undefined) && this.pointsPlayed - this.lastReplayPoint >= 3 && !this.env.demo;
    if (replayWorthy || (this.env.demo && (reason === 'winner' || reason === 'ace') && this.pointsPlayed - this.lastReplayPoint >= 4)) {
      this.lastReplayPoint = this.pointsPlayed;
      this.later(1.7, () => this.startReplay(next));
    } else this.later(out.gameWon !== undefined ? 2.6 : 2.0, next);
  }

  private finishMatch(): void {
    this.setPhase('over');
    const won = this.score.winner === 0;
    this.call(won ? 'Match won!' : 'Match lost', won ? 'good' : 'bad');
    this.stadium.crowd.standUp(true);
    this.stadium.crowd.applaud(1);
    this.sounds.applause(1);
    this.later(0.8, () => this.sounds.applause(1));
    if (won) this.me.celebrate = 1.6;
    else this.opp.celebrate = 1.6;
    this.later(3.6, () => this.done());
  }

  private done(): void {
    if (this.ended) return;
    const st = this.st;
    const sc = this.score;
    const won = this.cfg.mode === 'match' ? sc.winner === 0 : false;
    const result: TennisResult = {
      mode: this.cfg.mode,
      difficulty: this.cfg.difficulty,
      venue: this.cfg.venue,
      won,
      scoreLine: this.cfg.mode === 'match' ? sc.scoreLine(0) : String(this.rallyScore),
      opponent: this.names[1],
      pointsWon: st.won,
      pointsLost: st.lost,
      aces: st.aces,
      doubleFaults: st.df,
      winners: st.winners,
      errors: st.errors,
      longestRally: st.longest,
      fastestServe: st.fastest,
      firstServePct: st.firstTotal ? Math.round((st.firstIn / st.firstTotal) * 100) : 0,
      perfects: st.perfects,
      score: this.rallyScore,
      targets: this.targetHits,
      stars: 0,
    };
    result.stars = this.cfg.mode === 'match' ? matchStars(won, st.won, st.won + st.lost, sc.games[1]) : rallyStars(this.rallyScore, this.cfg.difficulty);
    this.publishDebug(true);
    this.cleanup();
    this.resolve({ kind: 'done', result });
  }

  // ---- rally challenge -------------------------------------------------------------------------------------

  private startRallyFeed(first = false): void {
    this.setPhase('between');
    this.rallyShots = 0;
    this.flight = null;
    this.ballHidden = true;
    this.restoreSpeeds();
    this.me.idle = 0;
    this.opp.idle = 0;
    if (first) {
      this.me.place(0.3, NEAR_Z, Math.PI);
      this.opp.place(0, -NEAR_Z, 0);
    }
    this.me.moveTo(0.3, NEAR_Z);
    this.opp.moveTo(0, -NEAR_Z);
    this.updateScoreHud();
    if (this.cfg.tutorial && this.tutorialStep < 2) this.prompt('Return every ball · land it in the rings for bonus points');
    this.later(first ? 0.8 : 1.2, () => {
      // Coach feed: a friendly ball from the far baseline.
      const from = { x: this.opp.x + 0.6, y: 1.0, z: this.opp.z + 0.3 };
      this.opp.startSwing('fh', 1, -0.3);
      this.later(0.3, () => {
        const sol = solveShot({ from, target: { x: (this.rand() - 0.5) * 3.5, z: 9.0 + this.rand() * 1.5 }, speed: 19 + this.rand() * 3, spin: 220, clearance: 0.8 }, SURFACES[this.cfg.venue]);
        this.sounds.hit(0.4, 0, false);
        this.strike(1, sol.state, false, this.gt);
      });
    });
  }

  private rallyLanded(p: V3): void {
    const d = this.cfg.difficulty;
    const mult = d === 'easy' ? 1 : d === 'normal' ? 1.5 : 2;
    const chain = 1 + Math.floor(this.rallyShots / 6);
    let pts = Math.round(10 * mult * chain);
    let label = '';
    for (const t of this.targets) {
      const dist = Math.hypot(p.x - t.x, p.z - t.z);
      if (dist <= t.radius) {
        const bull = dist < t.radius * 0.38;
        pts += Math.round((bull ? 100 : 50) * mult);
        label = bull ? 'Bullseye!' : 'Target!';
        t.hit();
        this.targetHits++;
        this.sounds.callTone('good');
        this.stadium.crowd.applaud(0.6);
        this.later(0.2, () => this.sounds.applause(0.5));
        this.later(0.8, () => this.placeTargets());
        break;
      }
    }
    this.rallyScore += pts;
    const shots = Math.ceil(this.rallyShots / 2);
    this.st.longest = Math.max(this.st.longest, shots);
    this.popScore(`+${pts}`, label);
  }

  private rallyMiss(winner: Side, reason: string): void {
    if (this.phase === 'dead' || this.phase === 'over') return;
    this.setPhase('dead');
    this.humanIc = null;
    this.botHint.incoming = null;
    if (winner === 0) {
      // The coach could not reach it: a clean winner.
      this.rallyScore += 30;
      this.popScore('+30', 'Winner!');
      this.sounds.applause(0.6);
      this.later(1.4, () => this.startRallyFeed());
      return;
    }
    this.lives--;
    this.call(reason === 'out' || reason === 'close-out' ? 'Out!' : reason === 'net' ? 'Net' : 'Missed', 'bad');
    if (reason === 'out' || reason === 'close-out') this.sounds.callTone('out');
    this.updateScoreHud();
    if (this.lives <= 0) {
      this.later(1.4, () => {
        this.setPhase('over');
        this.call('Challenge over', '');
        this.stadium.crowd.applaud(0.8);
        this.sounds.applause(0.7);
        this.later(2.0, () => this.done());
      });
    } else this.later(1.6, () => this.startRallyFeed());
  }

  // ---- input -----------------------------------------------------------------------------------------

  private processPose(now: number): void {
    const frames = this.env.pose.since(this.lastPoseT);
    const hand = this.cfg.hand;
    for (const fr of frames) {
      this.lastPoseT = fr.t;
      const b = this.env.body.measure(fr);
      if (!b.ok) {
        this.handHist = [];
        this.swingBest = null;
        continue;
      }
      this.latestBody = b;
      const w = hand === 'right' ? b.rWrist : b.lWrist;
      const vis = hand === 'right' ? b.rWristV : b.lWristV;
      if (vis < 0.35) continue;
      const hist = this.handHist;
      const prev = hist[hist.length - 1];
      hist.push({ t: fr.t, x: w.x, y: w.y });
      while (hist.length > 2 && fr.t - hist[0].t > 600) hist.shift();
      // Toss gesture: racket hand held above the head.
      if (w.y > b.nose.y + 0.2) {
        if (!this.tossSince) this.tossSince = fr.t;
        if (fr.t - this.tossSince > 110) {
          const tt = fr.t;
          // Input becomes a timed task so it is ordered correctly against ball events and AI strikes.
          this.at(Math.max(this.gt, this.gtAt(tt)), () => this.humanToss(tt));
        }
      } else this.tossSince = 0;
      if (!prev) continue;
      const dt = (fr.t - prev.t) / 1000;
      if (dt <= 0 || dt > 0.4) continue;
      const vx = (w.x - prev.x) / dt;
      const vy = (w.y - prev.y) / dt;
      const speed = Math.hypot(vx, vy);
      if (fr.t < this.swingCool) continue;
      const minS = this.phase === 'serve' ? MIN_SERVE : MIN_SWING;
      if (speed >= minS) {
        if (!this.swingBest || speed > this.swingBest.speed) this.swingBest = { t: fr.t, vx, vy, speed, x: w.x, y: w.y };
      } else if (this.swingBest && (speed < this.swingBest.speed * 0.8 || speed < minS * 0.7)) {
        const best = this.swingBest;
        this.swingBest = null;
        this.swingCool = fr.t + 280;
        // Where the hand was ~180 ms before the peak.
        let start = hist[0];
        for (const h of hist) if (h.t <= best.t - 180) start = h;
        const feat: SwingFeatures = { t: best.t, vx: best.vx, vy: best.vy, speed: best.speed, startX: start.x, startY: start.y, endX: w.x, endY: w.y };
        this.at(Math.max(this.gt, this.gtAt(fr.t)), () => this.onHumanSwing(feat));
      }
    }
    // Pause gesture (not for the bot).
    if (!this.env.demo && this.latestBody && this.pauseGesture.update(this.latestBody, now)) void this.pause();
    if (!this.latestBody?.ok) {
      if (!this.noBodySince) this.noBodySince = now;
    } else this.noBodySince = 0;
  }

  // ---- replay ------------------------------------------------------------------------------------------

  private record(): void {
    const last = this.rec[this.rec.length - 1];
    if (last && this.gt - last.g < 1 / 60) return;
    const p = this.ball.mesh.position;
    this.rec.push({ g: this.gt, bx: p.x, by: p.y, bz: p.z, vis: this.ball.mesh.visible, me: this.me.snapshot(), opp: this.opp.snapshot() });
    while (this.rec.length && this.gt - this.rec[0].g > 5) this.rec.shift();
  }

  private startReplay(after: () => void): void {
    // Window: from just before the decisive shot to the end of the point.
    const end = this.gt - 0.9;
    const t0 = Math.max(this.rec[0]?.g ?? end, Math.min(this.flT0 - 0.45, end - 0.5));
    const t1 = Math.min(end, t0 + 2.2);
    const frames = this.rec.filter((f) => f.g >= t0 - 0.05 && f.g <= t1 + 0.05);
    if (frames.length < 4) {
      after();
      return;
    }
    this.setPhase('replay');
    this.replay = { frames, t: t0, t0, t1, live: [this.me.snapshot(), this.opp.snapshot()], after };
    this.hud.replay.classList.add('show');
    this.sounds.setCrowdLevel(0.6);
  }

  private stepReplay(rdt: number): void {
    const r = this.replay!;
    r.t += rdt * 0.38;
    const fr = r.frames;
    let i = 0;
    while (i < fr.length - 2 && fr[i + 1].g < r.t) i++;
    const a = fr[i];
    const b = fr[i + 1];
    const k = clamp((r.t - a.g) / Math.max(1e-4, b.g - a.g), 0, 1);
    this.me.applySnapshot(lerpSnap(a.me, b.me, k));
    this.opp.applySnapshot(lerpSnap(a.opp, b.opp, k));
    const bp = new THREE.Vector3(a.bx + (b.bx - a.bx) * k, a.by + (b.by - a.by) * k, a.bz + (b.bz - a.bz) * k);
    this.ball.visible = a.vis;
    this.ball.update(bp, new THREE.Vector3(b.bx - a.bx, b.by - a.by, b.bz - a.bz).multiplyScalar(60), rdt * 0.38, this.camera, 0);
    this.lastBall.copy(bp);
    this.hud.replayBar.style.width = `${clamp((r.t - r.t0) / (r.t1 - r.t0), 0, 1) * 100}%`;
    if (r.t >= r.t1) {
      this.me.applySnapshot(r.live[0]);
      this.opp.applySnapshot(r.live[1]);
      this.replay = null;
      this.hud.replay.classList.remove('show');
      this.sounds.setCrowdLevel(1);
      this.ball.visible = false;
      this.setPhase('dead');
      r.after();
    }
  }

  // ---- visuals -----------------------------------------------------------------------------------------

  private vec(p: V3): THREE.Vector3 {
    return new THREE.Vector3(p.x, p.y, p.z);
  }

  private ballWorld(): { p: THREE.Vector3; v: THREE.Vector3; vis: boolean } {
    if (this.toss && !this.toss.struck) {
      const g = Math.max(this.gt, this.toss.t0);
      const p = this.vec(this.tossPos(this.toss.by, g));
      return { p, v: new THREE.Vector3(0, 1, 0), vis: true };
    }
    if (this.phase === 'serve' && !this.flight) {
      // Held in the server's off hand.
      const a = this.server === 0 ? this.me : this.opp;
      const p = a.toWorld(0.05, 1.02, 0.42);
      return { p, v: new THREE.Vector3(), vis: true };
    }
    if (this.flight) {
      const t = this.gt - this.flT0;
      const p = this.vec(this.flight.at(t));
      const v = this.vec(this.flight.velAt(t));
      return { p, v, vis: !this.ballHidden };
    }
    return { p: this.lastBall.clone(), v: new THREE.Vector3(), vis: false };
  }

  private updateVisuals(rdt: number, now: number): void {
    const t = this.animT;
    if (!this.replay) {
      const bw = this.ballWorld();
      // Hide small rewinds with a decaying offset.
      const jump = bw.p.distanceTo(this.lastBall);
      if (jump > 0.4 && jump < 3 && bw.vis && this.ball.mesh.visible) this.ballOffset.copy(this.lastBall).sub(bw.p);
      this.ballOffset.multiplyScalar(Math.exp(-rdt * 30));
      const shown = bw.p.clone().add(this.ballOffset);
      shown.y = Math.max(0.061, shown.y);
      this.ball.visible = bw.vis;
      this.ball.update(shown, bw.v, rdt, this.camera, bw.v.length());
      this.lastBall.copy(bw.p);
      this.me.look.copy(bw.vis ? shown : new THREE.Vector3(0, 1, -10));
      this.opp.look.copy(bw.vis ? shown : new THREE.Vector3(0, 1, 10));
      for (const x of this.extras) x.look.copy(shown);
    }
    this.me.pose(t);
    this.opp.pose(t);
    for (const x of this.extras) x.pose(t + x.x);
    this.puffs.update(rdt);
    this.stadium.update(rdt, t, this.lastBall.x);
    for (const tg of this.targets) tg.update(rdt, t);
    this.updateCamera(rdt);
    if (this.env.settings.showCamera) this.preview.draw(now);
  }

  private updateCamera(dt: number): void {
    const cam = this.camera;
    let pos: THREE.Vector3;
    let look: THREE.Vector3;
    const k = 1 - Math.exp(-dt * 3.2);
    if (this.phase === 'intro') {
      const u = clamp(this.phaseT / (this.env.demo ? 2.2 : 3.2), 0, 1);
      const e = u * u * (3 - 2 * u);
      const a = -2.4 + e * 2.4;
      const r = 30 - e * 10;
      pos = new THREE.Vector3(Math.sin(a) * r, 15 - e * 9, Math.cos(a) * r);
      look = new THREE.Vector3(0, 0.5, -2 * e);
      this.camPos.copy(pos);
      this.camLook.copy(look);
    } else if (this.replay) {
      // Low, side-on broadcast replay camera following the ball.
      const b = this.lastBall;
      pos = new THREE.Vector3(-10.5, 1.9, clamp(b.z * 0.65, -9, 9));
      look = new THREE.Vector3(b.x * 0.4, Math.max(0.6, b.y * 0.6), b.z);
      this.camPos.lerp(pos, 1 - Math.exp(-dt * 4));
      this.camLook.lerp(look, 1 - Math.exp(-dt * 6));
    } else {
      const m = this.me;
      const mz = clamp(m.z, 6, 16);
      pos = new THREE.Vector3(m.x * 0.6, 3.15, mz + 5.6);
      look = new THREE.Vector3(m.x * 0.28, 0.9, mz - 13);
      this.camPos.lerp(pos, k);
      this.camLook.lerp(look, k);
    }
    this.shake = Math.max(0, this.shake - dt * 1.4);
    const s = this.shake * this.shake * 0.5;
    cam.position.copy(this.camPos).add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, 0));
    cam.lookAt(this.camLook);
    const aspect = cam.aspect;
    const fov = aspect < 1.5 ? 52 : this.replay ? 34 : 44;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  // ---- HUD ---------------------------------------------------------------------------------------------

  private setText(key: string, el: HTMLElement, v: string): void {
    if (this.lastHud[key] === v) return;
    this.lastHud[key] = v;
    el.textContent = v;
  }

  private updateScoreHud(): void {
    const sc = this.score;
    const rally = this.cfg.mode === 'rally';
    for (const s of [0, 1] as Side[]) {
      const row = s === 0 ? this.hud.r0 : this.hud.r1;
      row.classList.toggle('serving', !rally && sc.server === s && !sc.finished);
      const sets = row.querySelector('.sets') as HTMLElement;
      const pts = row.querySelector('.pts') as HTMLElement;
      if (rally) {
        sets.textContent = '';
        pts.textContent = '';
      } else {
        sets.textContent = this.cfg.format === 'tiebreak' ? '' : String(sc.games[s]);
        pts.textContent = sc.finished ? '' : sc.pointLabel(s);
      }
    }
    const foot = rally ? '' : sc.tiebreak ? 'Tie-break' : this.serveNo === 2 ? '2nd serve' : '';
    this.hud.foot.textContent = foot;
    this.hud.foot.classList.toggle('show', !!foot);
    this.stadium.setScoreboard(
      rally
        ? [
            { name: 'Score', games: '', points: String(this.rallyScore), serving: false },
            { name: 'Balls left', games: '', points: String(Math.max(0, this.lives)), serving: false },
          ]
        : [
            { name: this.names[0], games: this.cfg.format === 'tiebreak' ? '' : String(sc.games[0]), points: sc.finished ? '' : sc.pointLabel(0), serving: sc.server === 0 },
            { name: this.names[1], games: this.cfg.format === 'tiebreak' ? '' : String(sc.games[1]), points: sc.finished ? '' : sc.pointLabel(1), serving: sc.server === 1 },
          ],
      rally ? 'RALLY CHALLENGE' : sc.tiebreak ? 'TIE-BREAK' : 'SET 1',
    );
    if (rally) {
      this.hud.side.innerHTML = `<div class="t-stat"><b>${this.rallyScore}</b><span>score</span></div><div class="t-lives">${[0, 1, 2]
        .map((i) => `<i class="${i < this.lives ? 'on' : ''}"></i>`)
        .join('')}</div>`;
    }
  }

  private updateHud(): void {
    const rallyN = this.cfg.mode === 'rally' ? Math.ceil(this.rallyShots / 2) : this.rallyShots;
    const showRally = (this.phase === 'rally' || this.phase === 'dead') && rallyN >= 2;
    this.hud.rally.classList.toggle('show', showRally);
    if (showRally) this.setText('rally', this.hud.rallyN, String(rallyN));
    if (this.cfg.mode === 'match' && this.phase === 'serve' && this.server === 0 && !this.toss && this.noBodySince && performance.now() - this.noBodySince > 1500) {
      this.prompt('Step into view of the camera');
    }
    this.publishDebug(false);
  }

  private publishDebug(finished: boolean): void {
    const sc = this.score;
    (window as unknown as { __gameDebug?: unknown }).__gameDebug = {
      mode: this.cfg.mode,
      difficulty: this.cfg.difficulty,
      hand: this.cfg.hand,
      venue: this.cfg.venue,
      phase: this.phase,
      score:
        this.cfg.mode === 'match'
          ? `${sc.games[0]}-${sc.games[1]} ${sc.pointLabel(0)}-${sc.pointLabel(1)}${sc.tiebreak ? ' TB' : ''}`
          : `${this.rallyScore} (${this.lives} balls)`,
      rally: this.rallyShots,
      pointsWon: this.st.won,
      pointsLost: this.st.lost,
      aces: this.st.aces,
      winners: this.st.winners,
      errors: this.st.errors,
      longestRally: this.st.longest,
      perfects: this.st.perfects,
      shots: this.st.shots,
      lastShot: this.lastShot,
      rallyScore: this.rallyScore,
      targets: this.targetHits,
      finished: finished || this.ended,
      fps: Math.round(this.fpsAvg),
      gt: Math.round(this.gt * 10) / 10,
      quality: this.r3d?.currentLevel,
      programs: this.r3d?.renderer.info.programs?.length ?? 0,
      aiReach: this.aiIc ? this.aiIc.reachable : null,
      log: this.evLog,
    };
  }

  private callTimer = 0;
  private call(text: string, tone: string): void {
    const el = this.hud.call;
    el.textContent = text;
    el.className = `t-call show ${tone}`;
    clearTimeout(this.callTimer);
    this.callTimer = window.setTimeout(() => el.classList.remove('show'), 1500);
  }

  private lowerTimer = 0;
  private lowerThird(text: string, accent: boolean): void {
    const el = this.hud.lower;
    this.hud.lowerText.textContent = text;
    el.classList.toggle('accent', accent);
    el.classList.add('show');
    clearTimeout(this.lowerTimer);
    this.lowerTimer = window.setTimeout(() => el.classList.remove('show'), 2200);
  }

  private promptTimer = 0;
  private prompt(text: string, ms = 0): void {
    const el = this.hud.prompt;
    if (this.lastHud.prompt === text) return;
    this.lastHud.prompt = text;
    el.textContent = text;
    el.classList.toggle('show', !!text);
    clearTimeout(this.promptTimer);
    if (ms && text) this.promptTimer = window.setTimeout(() => this.prompt(''), ms);
  }

  /** A short-lived coaching line. */
  private hint(text: string): void {
    this.prompt(text, 1800);
  }

  private fbTimer = 0;
  private feedback(label: string, text: string, timing: Timing | null, rawE?: number): void {
    const el = this.hud.fb;
    this.hud.fbLabel.textContent = label;
    this.hud.fbText.textContent = text;
    el.className = `t-feedback show l-${label.toLowerCase().replace(/\s+/g, '-')}`;
    const e = timing ? timing.e : rawE ?? 0;
    this.hud.meterMark.style.left = `${50 + clamp(e, -1.3, 1.3) * 38}%`;
    this.hud.fb.querySelector('.t-meter')!.classList.toggle('hidden', !timing && rawE === undefined);
    clearTimeout(this.fbTimer);
    this.fbTimer = window.setTimeout(() => el.classList.remove('show'), 1700);
  }

  private popScore(text: string, label: string): void {
    const el = document.createElement('div');
    el.className = 't-pop';
    el.innerHTML = `<b>${text}</b>${label ? `<span>${label}</span>` : ''}`;
    this.el.querySelector('.ghud')!.appendChild(el);
    setTimeout(() => el.remove(), 1200);
    this.updateScoreHud();
  }

  private serveSpeed(v: number, by: Side): void {
    if (this.cfg.mode !== 'match') return;
    const el = this.hud.side;
    el.innerHTML = `<div class="t-speed ${by === 0 ? 'me' : ''}"><span>Serve speed</span><b>${v}<small> km/h</small></b></div>`;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ---- pause / cleanup -------------------------------------------------------------------------------

  private async pause(): Promise<void> {
    if (this.paused || this.ended) return;
    this.paused = true;
    this.sounds.stopVoice();
    await this.env.audio.pause();
    const act = await pauseMenu(this.el, this.env.cursor);
    await this.env.audio.resume();
    if (act === 'resume') {
      this.paused = false;
      this.lastFrame = performance.now();
      this.lastPoseT = performance.now();
      this.handHist = [];
      this.swingBest = null;
      // Keep the clock mapping continuous across the pause.
      this.clockHist = [];
      return;
    }
    this.cleanup();
    this.resolve(act === 'restart' ? { kind: 'restart' } : { kind: 'quit' });
  }

  private cleanup(): void {
    if (this.ended) return;
    this.ended = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.callTimer);
    clearTimeout(this.lowerTimer);
    clearTimeout(this.promptTimer);
    clearTimeout(this.fbTimer);
    this.sounds.dispose();
    if (this.env.pose instanceof SimPose) this.env.pose.drive = () => ({ lWrist: { x: -0.75, y: -1.55 }, rWrist: { x: 0.75, y: -1.55 } });
    this.me.dispose();
    this.opp.dispose();
    for (const x of this.extras) x.dispose();
    this.r3d.dispose();
    this.el.remove();
  }
}

/** Interpolate the numeric parts of two snapshots (replays are slowed down, so this matters). */
function lerpSnap(a: AthleteSnap, b: AthleteSnap, k: number): AthleteSnap {
  const l = (x: number, y: number) => x + (y - x) * k;
  const swing =
    a.swing && b.swing && a.swing.kind === b.swing.kind
      ? { ...a.swing, tau: l(a.swing.tau, b.swing.tau) }
      : k < 0.5
        ? a.swing
        : b.swing;
  return {
    x: l(a.x, b.x),
    z: l(a.z, b.z),
    yaw: a.yaw + angleDiff(b.yaw, a.yaw) * k,
    speed: l(a.speed, b.speed),
    dirYaw: a.dirYaw + angleDiff(b.dirYaw, a.dirYaw) * k,
    phase: Math.abs(b.phase - a.phase) < 0.5 ? l(a.phase, b.phase) : b.phase,
    crouch: l(a.crouch, b.crouch),
    swing,
    feet: a.feet.map((v, i) => l(v, b.feet[i])) as AthleteSnap['feet'],
    lookX: l(a.lookX, b.lookX),
    lookY: l(a.lookY, b.lookY),
    lookZ: l(a.lookZ, b.lookZ),
    celebrate: l(a.celebrate, b.celebrate),
    idle: l(a.idle, b.idle),
  };
}

export { contactOffset };
