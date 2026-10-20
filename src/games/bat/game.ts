/**
 * One play session of Big Hitter: builds the ground, bowls/pitches ball after ball, reads the swing from both
 * wrists, replays the hit with fielders and cameras, keeps score and resolves with the result.
 */
import * as THREE from 'three';
import type { Body } from '../../core/body';
import { Hold, handsUp } from '../../core/gestures';
import { Renderer3D } from '../../core/render';
import { SimPose } from '../../core/pose';
import type { V2 } from '../../core/types';
import { CamPreview, HandsUpPause, pauseMenu } from '../../ui/kit';
import type { GameEnv } from '../types';
import { Bot } from './bot';
import { batterHome, poseBatter } from './batter';
import { SwingTracker, TOLERANCE, WINDOWS, cricketShotName, judge, shotFrom, swingHeight, type Judgement, type Shot, type Swing } from './contact';
import { BASEBALL_GEOM, CRICKET_GEOM, planCricket, planPitch, sampleAt, type Delivery, type Difficulty } from './delivery';
import { Hud, type Tone } from './hud';
import {
  BASEBALL_PARK,
  RUN_TIMES,
  baseballField,
  cricketField,
  pointAt,
  resolveBaseball,
  resolveCricket,
  simulateHit,
  type BaseballOutcome,
  type CricketOutcome,
  type Fielder,
  type HitTrack,
} from './outcome';
import { flatDist, launchVector, type Sport, type V3 } from './physics';
import { Rng } from './rng';
import { BaseballGame, CricketMatch, type Mode } from './rules';
import type { BatSounds } from './sounds';
import { Figure, SKIN_TONES, figureMaterials, type Kit } from './world/figure';
import { Blobs, Fireworks, Particles, SwingTrail } from './world/fx';
import { glowTexture } from './world/textures';
import { buildBaseballWorld, buildCricketWorld, type World } from './world/grounds';
import { BAT, BALL_VISUAL_SCALE, makeBall, makeBaseballBat, makeCricketBat } from './world/props';

export interface SessionConfig {
  sport: Sport;
  mode: Mode;
  difficulty: Difficulty;
  handed: 1 | -1;
  night: boolean;
  tutorial: boolean;
}

export interface SessionStats {
  sport: Sport;
  mode: Mode;
  difficulty: Difficulty;
  cricket?: CricketMatch;
  baseball?: BaseballGame;
  longest: number;
  swings: number;
  contacts: number;
  perfects: number;
}

export type SessionOutcome = { kind: 'done'; stats: SessionStats } | { kind: 'quit' } | { kind: 'restart' };

export interface Assets {
  sky: HTMLImageElement | null;
  sounds: BatSounds;
}

type Phase = 'intro' | 'ready' | 'runup' | 'flight' | 'hit' | 'dead' | 'done';

interface Actor {
  fig: Figure;
  home: THREE.Vector3;
  pos: THREE.Vector3;
  yaw: number;
  mode: 'ready' | 'idle' | 'run' | 'catch' | 'pickup' | 'throw' | 'celebrate' | 'squat' | 'signal' | 'walk';
  t0: number;
  phase: number;
  speed: number;
  target: THREE.Vector3 | null;
  arriveG: number;
  seed: number;
  info?: Fielder;
  signal?: 'six' | 'four' | 'out' | 'none';
  catchH?: number;
}

const tmpV = new THREE.Vector3();
const v3 = (p: V3) => new THREE.Vector3(p.x, p.y, p.z);
const clamp = THREE.MathUtils.clamp;
const smooth = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/** Extra delay between what the TV shows and when the player's swing is captured (camera mode only). */
const VIDEO_LAG_MS = 50;

export class BatSession {
  private el!: HTMLElement;
  private r3!: Renderer3D;
  private camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 2500);
  private world!: World;
  private hud!: Hud;
  private preview: CamPreview;
  private handsUp = new HandsUpPause();
  private upHold = new Hold(1300);
  private rng: Rng;
  private tracker = new SwingTracker();
  private bot: Bot | null = null;
  private sounds: BatSounds;
  private resolveRun!: (o: SessionOutcome) => void;
  private raf = 0;
  private lastFrame = 0;
  private paused = false;
  private finished = false;
  private disposed = false;

  // sport objects
  private cricket: CricketMatch | null = null;
  private baseball: BaseballGame | null = null;
  private mats = figureMaterials();
  private batter!: Figure;
  private bat!: THREE.Group;
  private partnerBat: THREE.Group | null = null;
  private ball!: THREE.Mesh;
  private actors: Actor[] = [];
  private fielders: Actor[] = [];
  private fieldInfo: Fielder[] = [];
  private bowler!: Actor;
  private keeper: Actor | null = null;
  private umpire: Actor | null = null;
  private legUmpire: Actor | null = null;
  private partner: Actor | null = null;
  private runners: Actor[] = [];
  private dust = new Particles(260, false);
  private sparks = new Particles(1400, true);
  private fireworks = new Fireworks(this.sparks);
  private trail = new SwingTrail();
  private ballTrail = new SwingTrail(0xffffff, 0.11, 0.9);
  private halo!: THREE.Sprite;
  private blobs = new Blobs(40);
  private flashEl!: HTMLElement;
  private zone: THREE.Group | null = null;
  private zoneMarker: THREE.Mesh | null = null;

  // clocks
  private gt = 0;
  private timeScale = 1;
  private slowUntil = 0;
  private slowK = 1;
  private hitStopUntil = 0;
  private phase: Phase = 'intro';
  private phaseG = 0;

  // current ball
  private ballNo = 0;
  private delivery: Delivery | null = null;
  private runupLen = 2.4;
  private relG = 0;
  private relR = 0;
  private arrR = 0;
  private swing: Swing | null = null;
  private resolved = false;
  private pendingSince = 0;
  private judgement: Judgement | null = null;
  private shot: Shot | null = null;
  private hitG = 0;
  private track: HitTrack | null = null;
  private cOut: CricketOutcome | null = null;
  private bOut: BaseballOutcome | null = null;
  private events: { at: number; fn: () => void; done?: boolean }[] = [];
  private endG = 0;
  private bounced = false;
  private passedBat = false;
  private crossedPlate = false;
  private ballHeld: Actor | null = null;
  private throwFrom: THREE.Vector3 | null = null;
  private throwG = 0;
  private throwDur = 0;
  private throwTo: THREE.Vector3 | null = null;
  private recorded = false;
  private lastText = '';
  private overBalls: string[] = [];
  private batterRun: { from: THREE.Vector3; to: THREE.Vector3; t0: number; t1: number }[] = [];
  private batterRunning = false;

  // input state
  private grip: V2 = { x: 0.4, y: -1 };
  private gripSmooth: V2 = { x: 0.4, y: -1 };
  private lastPoseT = 0;
  private latestBody: Body | null = null;
  private swings = 0;
  private contacts = 0;
  private perfects = 0;
  private longest = 0;
  private fpsAvg = 30;
  private lastLevel = '';
  private camShake = 0;

  // camera
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camFov = 40;
  private followLook = new THREE.Vector3();
  /** A hard cut to a fixed shot (crowd celebrating a six). */
  private cut: { pos: THREE.Vector3; look: THREE.Vector3; fov: number; fresh: boolean } | null = null;

  constructor(
    private env: GameEnv,
    private cfg: SessionConfig,
    private assets: Assets,
  ) {
    this.sounds = assets.sounds;
    const seed = Number(env.params.get('seed')) || Math.floor(Math.random() * 1e9);
    this.rng = new Rng(seed);
    this.preview = new CamPreview(env.pose);
  }

  run(): Promise<SessionOutcome> {
    return new Promise((resolve) => {
      this.resolveRun = resolve;
      this.build();
      this.lastFrame = performance.now();
      this.lastPoseT = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    });
  }

  // ---- setup ---------------------------------------------------------------------------------------------

  private build(): void {
    const { env, cfg } = this;
    this.el = document.createElement('div');
    this.el.className = `bat game-root bat-${cfg.sport}`;
    this.el.innerHTML = `<canvas class="gl"></canvas><div class="bat-vig"></div><div class="bat-flash"></div>`;
    env.root.appendChild(this.el);
    this.flashEl = this.el.querySelector('.bat-flash') as HTMLElement;
    const canvas = this.el.querySelector('canvas') as HTMLCanvasElement;

    this.world = cfg.sport === 'cricket' ? buildCricketWorld({ night: cfg.night, sky: this.assets.sky }) : buildBaseballWorld({ night: cfg.night, sky: this.assets.sky });
    const scene = this.world.scene;
    this.r3 = new Renderer3D(canvas, scene, this.camera, env.settings.quality, {
      bloom: { strength: this.world.night ? 0.75 : 0.35, radius: 0.5, threshold: this.world.night ? 0.82 : 0.92 },
      exposure: this.world.night ? 1.05 : 0.95,
      shadows: true,
    });
    const pm = new THREE.PMREMGenerator(this.r3.renderer);
    scene.environment = pm.fromEquirectangular(this.world.envSource).texture;
    scene.environmentIntensity = this.world.night ? 0.45 : 0.7;
    pm.dispose();

    scene.add(this.dust.points, this.sparks.points, this.trail.mesh, this.ballTrail.mesh, this.blobs.mesh);
    this.ball = makeBall(cfg.sport);
    scene.add(this.ball);
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xfff6e0, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.halo.scale.setScalar(0.55);
    this.ball.add(this.halo);

    if (cfg.sport === 'cricket') {
      this.cricket = new CricketMatch(cfg.mode as 'chase' | 'sixes', cfg.difficulty);
      this.buildCricketCast();
    } else {
      this.baseball = new BaseballGame(cfg.mode as 'derby' | 'inning', cfg.difficulty);
      this.buildBaseballCast();
    }

    this.hud = new Hud(this.el, cfg.mode, cfg.difficulty, cfg.sport);
    if (env.params.get('hero')) this.hud.el.style.display = 'none';
    this.hud.pauseButton.addEventListener('click', () => void this.pause());
    if (env.settings.showCamera) this.hud.el.appendChild(this.preview.canvas);
    this.updateScore();
    this.updateScreen();

    if (env.demo && env.pose instanceof SimPose) {
      this.bot = new Bot(cfg.handed, cfg.sport);
      const bot = this.bot;
      env.pose.drive = (t) => bot.drive(t);
    }
    // Testing aid: ?perf=nocrowd,noshadow to find what is expensive on a given device.
    const perf = (env.params.get('perf') ?? '').split(',');
    if (perf.includes('nocrowd')) this.world.crowd.mesh.visible = false;
    if (perf.includes('noshadow')) this.r3.renderer.shadowMap.enabled = false;
    if (perf.includes('nostands')) this.world.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry?.getAttribute('color') && !(o as THREE.SkinnedMesh).isSkinnedMesh) o.visible = false; });
    this.r3.resize();
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.onResize();
    this.sounds.startCrowd(0.32);
    this.setPhase('intro');
    this.camPos.set(0, 30, 60);
    this.camLook.set(0, 0, -10);
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden' && !this.env.demo) void this.pause();
  };

  private onResize = (): void => {
    this.r3.resize();
    const h = this.r3.renderer.domElement.height;
    this.dust.setViewport(h);
    this.sparks.setViewport(h);
  };

  private kit(base: Partial<Kit>, skin?: number): Kit {
    return {
      skin: skin ?? SKIN_TONES[Math.floor(this.rng.next() * SKIN_TONES.length)],
      shirt: 0xffffff,
      trim: 0x222222,
      pants: 0xffffff,
      shoes: 0xf2f2f2,
      head: 'cap',
      headColor: 0x222222,
      build: 0.96 + this.rng.next() * 0.08,
      ...base,
    };
  }

  private addActor(fig: Figure, x: number, z: number, yaw: number, mode: Actor['mode'], info?: Fielder): Actor {
    this.world.scene.add(fig.root);
    const a: Actor = { fig, home: new THREE.Vector3(x, 0, z), pos: new THREE.Vector3(x, 0, z), yaw, mode, t0: 0, phase: 0, speed: 0, target: null, arriveG: 0, seed: this.rng.next() * 10, info };
    fig.root.position.copy(a.pos);
    fig.root.rotation.y = yaw;
    this.actors.push(a);
    return a;
  }

  private faceYaw(from: THREE.Vector3, to: { x: number; z: number }): number {
    return Math.atan2(to.x - from.x, to.z - from.z);
  }

  private buildCricketCast(): void {
    const h = this.cfg.handed;
    const fieldKit = { shirt: 0x0f7f73, trim: 0xffc93c, pants: 0x0b4f4a, shoes: 0xf4f4f4, head: 'cap' as const, headColor: 0x0b4f4a, longSleeves: false };
    const batKit = { shirt: 0x1d3a8a, trim: 0xff8a1f, pants: 0x162a66, shoes: 0xf4f4f4, head: 'helmet' as const, headColor: 0x14204a, pads: 0xf4f4ef, gloves: 0xf0f0f0, longSleeves: true };
    // Striker (the player).
    this.batter = new Figure(this.kit({ ...batKit, build: 1, back: { name: 'Big Hitter', number: '18' } }, 0x8d5a3b), this.mats);
    this.world.scene.add(this.batter.root);
    this.bat = makeCricketBat();
    this.world.scene.add(this.bat);
    // Fielding side.
    const set = this.cfg.mode === 'chase' && this.cfg.difficulty !== 'easy' ? 'death' : 'standard';
    this.fieldInfo = cricketField(set, h);
    for (const f of this.fieldInfo) {
      const fig = new Figure(this.kit(f.role === 'keeper' ? { ...fieldKit, pads: 0xf2f2f2, gloves: 0xf6f6f6, head: 'keeperCap' } : fieldKit), this.mats);
      const a = this.addActor(fig, f.x, f.z, this.faceYaw(new THREE.Vector3(f.x, 0, f.z), { x: 0, z: 0 }), f.role === 'keeper' ? 'squat' : 'ready', f);
      if (f.role === 'keeper') this.keeper = a;
      if (f.role === 'bowler') this.bowler = a;
      else this.fielders.push(a);
    }
    // Umpires and the non-striker.
    const umpKit = { shirt: 0x2b3142, trim: 0xd9d9d9, pants: 0x15171d, shoes: 0x111111, head: 'umpire' as const, headColor: 0xf3f3f0, belly: 0.03, longSleeves: true };
    this.umpire = this.addActor(new Figure(this.kit(umpKit), this.mats), -0.55 * h, -20.9, 0, 'signal');
    this.umpire.signal = 'none';
    this.legUmpire = this.addActor(new Figure(this.kit(umpKit), this.mats), -23 * h, -0.6, h > 0 ? Math.PI / 2 : -Math.PI / 2, 'signal');
    this.legUmpire.signal = 'none';
    this.partner = this.addActor(new Figure(this.kit(batKit), this.mats), -1.05 * h, -17.3, 0, 'idle');
    this.partnerBat = makeCricketBat();
    this.world.scene.add(this.partnerBat);
  }

  private buildBaseballCast(): void {
    const awayKit = { shirt: 0x9aa3ad, trim: 0xc8102e, pants: 0x9aa3ad, shoes: 0x1a1a1a, head: 'cap' as const, headColor: 0xc8102e, socks: 0xc8102e, longSleeves: true };
    const homeKit = { shirt: 0xf3f3f3, trim: 0x0f2a5c, pants: 0xf3f3f3, shoes: 0x111111, head: 'bbhelmet' as const, headColor: 0x0f2a5c, socks: 0x0f2a5c, gloves: 0xc8102e };
    this.batter = new Figure(this.kit({ ...homeKit, build: 1, back: { name: 'Big Hitter', number: '27' } }, 0x9a6444), this.mats);
    this.world.scene.add(this.batter.root);
    this.bat = makeBaseballBat();
    this.world.scene.add(this.bat);
    this.fieldInfo = baseballField();
    for (const f of this.fieldInfo) {
      const kit = f.role === 'catcher' ? { ...awayKit, head: 'catcher' as const, headColor: 0x1b1b1b, pads: 0x1b1b1b, gloves: 0x6b3a1e } : { ...awayKit, gloves: 0x6b3a1e };
      const fig = new Figure(this.kit(kit), this.mats);
      const isC = f.role === 'catcher';
      const pos = isC ? new THREE.Vector3(0.1, 0, 1.55) : new THREE.Vector3(f.x, 0, f.z);
      const a = this.addActor(fig, pos.x, pos.z, isC ? Math.PI : this.faceYaw(pos, { x: 0, z: 0 }), isC ? 'squat' : 'ready', f);
      if (f.role === 'pitcher') this.bowler = a;
      else if (isC) this.keeper = a;
      else this.fielders.push(a);
    }
    // Strike zone frame (Easy and Normal) and a marker where each pitch crossed.
    if (this.cfg.difficulty !== 'hard') {
      const g = new THREE.Group();
      const Z = BASEBALL_GEOM;
      const mat = new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.7, depthWrite: false, toneMapped: false });
      const w = Z.zoneHalfW * 2;
      const h = Z.zoneHigh - Z.zoneLow;
      const t = 0.018;
      for (const [x, y, sx, sy] of [
        [0, Z.zoneHigh, w + t, t],
        [0, Z.zoneLow, w + t, t],
        [-Z.zoneHalfW, (Z.zoneHigh + Z.zoneLow) / 2, t, h],
        [Z.zoneHalfW, (Z.zoneHigh + Z.zoneLow) / 2, t, h],
      ] as const) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(sx, sy), mat);
        m.position.set(x, y, 0);
        g.add(m);
      }
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.07, depthWrite: false }));
      fill.position.set(0, (Z.zoneHigh + Z.zoneLow) / 2, -0.001);
      g.add(fill);
      g.position.z = Z.plateZ;
      g.renderOrder = 6;
      this.world.scene.add(g);
      this.zone = g;
    }
    this.zoneMarker = new THREE.Mesh(new THREE.CircleGeometry(0.045, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }));
    this.zoneMarker.visible = false;
    this.world.scene.add(this.zoneMarker);
    // Runners (shown on occupied bases in an inning).
    for (let i = 0; i < 3; i++) {
      const fig = new Figure(this.kit(homeKit), this.mats);
      const b = BASEBALL_PARK.bases[i];
      const a = this.addActor(fig, b.x, b.z, 0, 'idle');
      fig.root.visible = false;
      this.runners.push(a);
    }
  }

  // ---- main loop -------------------------------------------------------------------------------------

  private frame = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    // performance.now() rather than the rAF timestamp: pose capture times and delivery anchors use the same clock.
    const now = performance.now();
    // Large cap so slow devices (and headless tests) keep real-time pace; the logic is all time-based.
    const dtR = Math.min(1.5, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    if (dtR > 0) this.fpsAvg += 0.08 * (1 / Math.max(dtR, 1e-3) - this.fpsAvg);
    if (!this.paused) {
      this.updateTimeScale(now);
      const dt = dtR * this.timeScale;
      this.gt += dt;
      // While the ball is on its way, game time is locked to real time so what the player sees matches the
      // timing judgement even when frames drop.
      if (this.phase === 'flight' && !this.resolved && this.pendingSince === 0 && this.delivery) {
        this.gt = Math.max(this.gt - dt, Math.min(this.relG + (now - this.relR) / 1000, this.relG + this.delivery.arrive.t + 0.001));
      }
      this.processPose(now);
      this.step(dt, now);
      this.animate(dt, now);
    }
    this.updateCamera(this.paused ? 0 : dtR, now);
    this.preview.draw(now);
    this.debug();
    const lvl = this.r3.currentLevel;
    if (lvl !== this.lastLevel) {
      this.lastLevel = lvl;
      this.world.crowd.setDensity(lvl === 'high' ? 1 : lvl === 'medium' ? 0.75 : 0.45);
    }
    this.r3.render(dtR);
  };

  private updateTimeScale(now: number): void {
    if (now < this.hitStopUntil) {
      this.timeScale = 0.02;
      return;
    }
    if (this.phase === 'flight' && this.pendingSince > 0 && !this.resolved) {
      this.timeScale = 0.06;
      return;
    }
    if (now < this.slowUntil) this.timeScale = this.slowK;
    else this.timeScale = Math.min(1, this.timeScale + 0.03 + (1 - this.timeScale) * 0.06);
  }

  private slowmo(k: number, ms: number): void {
    this.slowK = k;
    this.slowUntil = performance.now() + ms;
  }

  private setPhase(p: Phase): void {
    this.phase = p;
    this.phaseG = this.gt;
  }

  private at(dtG: number, fn: () => void): void {
    this.events.push({ at: this.gt + dtG, fn });
  }

  private step(_dt: number, now: number): void {
    const since = this.gt - this.phaseG;
    for (const e of this.events) {
      if (!e.done && this.gt >= e.at) {
        e.done = true;
        e.fn();
      }
    }
    this.events = this.events.filter((e) => !e.done);
    switch (this.phase) {
      case 'intro': {
        const intro = this.env.params.get('autoplay') === '1' ? 2.2 : 3.2;
        if (since < 0.05 && !this.lastText) {
          this.lastText = 'intro';
          const big = this.cfg.sport === 'cricket' ? (this.cfg.mode === 'chase' ? `${this.cricket!.target} TO WIN` : 'SIX HITTING') : this.cfg.mode === 'derby' ? 'HOME RUN DERBY' : 'BATTER UP';
          const sub =
            this.cfg.sport === 'cricket'
              ? this.cfg.mode === 'chase'
                ? `${this.cricket!.maxBalls} balls · ${this.cricket!.maxWickets} wickets in hand`
                : `${this.cricket!.maxBalls} balls · clear the rope`
              : this.cfg.mode === 'derby'
                ? `${this.baseball!.maxOuts} outs · every non-homer swing is an out`
                : '3 outs · score as many runs as you can';
          this.hud.banner(big, sub, 'call', intro * 1000 - 300);
          this.sounds.roar(0.4);
        }
        if (since > intro) this.newBall();
        break;
      }
      case 'ready': {
        if (since > (this.ballNo === 1 && this.cfg.tutorial ? 3.4 : 1.1)) this.startRunup();
        break;
      }
      case 'runup': {
        if (since >= this.runupLen) this.release(now);
        break;
      }
      case 'flight':
        this.stepFlight(now);
        break;
      case 'hit':
        if (this.gt >= this.endG) this.finishBall();
        break;
      case 'dead':
        if (since > 1.6) {
          if (this.matchOver()) this.finish();
          else this.newBall();
        }
        break;
      default:
        break;
    }
  }

  // ---- ball lifecycle ---------------------------------------------------------------------------------

  private matchOver(): boolean {
    return this.cricket ? this.cricket.done : this.baseball!.done;
  }

  private newBall(): void {
    this.cut = null;
    if (this.track || this.ballNo === 0) this.cutToBatting();
    this.ballNo++;
    this.lastText = '';
    this.resetBallState();
    const first = this.ballNo === 1;
    if (this.cfg.sport === 'cricket') {
      this.delivery = planCricket(this.rng, this.cfg.difficulty, this.cfg.handed, first);
      const spin = this.delivery.kind === 'offspin' || this.delivery.kind === 'legspin';
      this.runupLen = spin ? 1.7 : 2.5;
      if (this.keeper) {
        this.keeper.home.set((spin ? 0.9 : 0.4) * this.cfg.handed, 0, spin ? 2.1 : 13);
        this.keeper.pos.copy(this.keeper.home);
        if (this.keeper.info) {
          this.keeper.info.x = this.keeper.home.x;
          this.keeper.info.z = this.keeper.home.z;
        }
      }
    } else {
      const g = this.baseball!;
      this.delivery = planPitch(this.rng, this.cfg.difficulty, this.cfg.handed, { balls: g.balls, strikes: g.strikes }, first);
      this.runupLen = 1.15;
    }
    this.placeCast();
    if (this.zoneMarker) this.zoneMarker.visible = false;
    this.world.stumps?.striker.reset();
    this.world.stumps?.bowler.reset();
    this.hud.hideBanner();
    if (first && this.cfg.tutorial) this.hud.tutorial(true);
    if (this.ballNo <= 2 && !(first && this.cfg.tutorial)) this.hud.hint('Hold the bat with both hands · swing across your body when the ball arrives', 0);
    this.updateScore();
    this.setPhase('ready');
  }

  private resetBallState(): void {
    this.swing = null;
    this.resolved = false;
    this.pendingSince = 0;
    this.judgement = null;
    this.shot = null;
    this.track = null;
    this.cOut = null;
    this.bOut = null;
    this.events = [];
    this.bounced = false;
    this.passedBat = false;
    this.crossedPlate = false;
    this.ballHeld = null;
    this.throwFrom = null;
    this.throwTo = null;
    this.recorded = false;
    this.batterRun = [];
    this.batterRunning = false;
    this.trail.clear();
    this.ballTrail.clear();
    this.hud.distance(null);
    this.bot?.clear();
  }

  private placeCast(): void {
    const h = this.cfg.handed;
    for (const a of this.actors) {
      a.pos.copy(a.home);
      a.target = null;
      a.mode = a === this.keeper ? 'squat' : a === this.umpire || a === this.legUmpire ? 'signal' : a === this.partner ? 'idle' : 'ready';
      if (a.info && a !== this.bowler && a !== this.keeper) a.yaw = this.faceYaw(a.pos, { x: 0, z: 0 });
      if (a === this.umpire || a === this.legUmpire) a.signal = 'none';
    }
    if (this.cfg.sport === 'cricket') {
      const spin = this.runupLen < 2;
      const runZ = spin ? -26 : -35;
      this.bowler.pos.set(0.75, 0, runZ);
      this.bowler.yaw = 0;
      this.bowler.mode = 'idle';
      if (this.partner) {
        this.partner.pos.set(-1.05 * h, 0, -17.6);
        this.partner.yaw = 0;
      }
    } else {
      this.bowler.pos.set(0.15, BASEBALL_GEOM.moundH, BASEBALL_GEOM.rubberZ - 0.3);
      this.bowler.yaw = 0;
      this.bowler.mode = 'idle';
      const g = this.baseball!;
      this.runners.forEach((r, i) => {
        const b = BASEBALL_PARK.bases[i];
        r.fig.root.visible = g.mode === 'inning' && g.bases[i];
        r.pos.set(b.x + (i === 1 ? -1.2 : -1.6 * Math.sign(b.x || 1)), 0, b.z + 1.2);
        r.mode = 'ready';
        r.yaw = this.faceYaw(r.pos, { x: 0, z: 0 });
      });
    }
    this.placeBatter();
  }

  private batterHome(): THREE.Vector3 {
    return batterHome(this.cfg.sport, this.cfg.handed);
  }

  private placeBatter(): void {
    this.batter.root.position.copy(this.batterHome());
    this.batter.root.rotation.y = (Math.PI / 2) * this.cfg.handed;
    this.batter.root.visible = true;
    this.bat.visible = true;
  }

  private startRunup(): void {
    this.setPhase('runup');
    this.hud.tutorial(false);
    if (this.ballNo === 1 && this.cfg.tutorial) this.hud.hint('Get ready… swing when the ball reaches you', 0);
    for (const f of this.fielders) {
      if (f === this.keeper) continue;
      f.mode = 'walk';
      f.t0 = this.gt;
    }
  }

  private release(now: number): void {
    const d = this.delivery!;
    this.relG = this.gt;
    this.relR = now;
    this.arrR = now + d.arrive.t * 1000;
    this.setPhase('flight');
    this.swing = null;
    if (this.bot) this.bot.decide(d, this.arrR, this.rng, this.cfg.mode, this.baseball?.outs ?? 0);
    const label = this.cfg.sport === 'cricket' ? `${d.label} · ${d.note}` : `${d.label} · ${d.note}`;
    this.hud.info(`<b>${d.speedKmh}</b> km/h <span>${label}</span>`, 3600);
    if (this.ballNo <= 2) this.hud.hint('', 0);
  }

  private lagMs(): number {
    return this.env.demo ? 0 : VIDEO_LAG_MS;
  }

  private stepFlight(now: number): void {
    const d = this.delivery!;
    const tau = this.gt - this.relG;
    // Bounce effects.
    if (d.bounce && !this.bounced && tau >= d.bounce.t) {
      this.bounced = true;
      this.dust.burst(v3(d.bounce.p), 10, 1.2, new THREE.Color(0.75, 0.66, 0.48), 0.25, 0.9, { up: 0.6, grav: 0.4, drag: 2 });
      this.sounds.bounce(this.cfg.sport === 'cricket' ? 'pitch' : 'dirt', 0.8);
    }
    if (!this.resolved && tau >= d.arrive.t) {
      if (this.swing) this.resolveSwing(this.swing);
      else if (this.pendingSince === 0 && this.tracker.intent(now)) this.pendingSince = now;
      else if (this.pendingSince > 0 && now - this.pendingSince > 380) this.noSwing();
      else if (this.pendingSince === 0) this.noSwing();
    }
    if (this.resolved && !this.track) this.stepPastBat(tau);
  }

  /** Hold the ball at the bat while we wait for the swing data (camera latency). */
  private ballTau(): number {
    const d = this.delivery!;
    const tau = this.gt - this.relG;
    if (!this.resolved && tau > d.arrive.t) return d.arrive.t + Math.min(0.008, tau - d.arrive.t);
    return tau;
  }

  private onSwing(s: Swing): void {
    this.swings++;
    this.sounds.whoosh(s.speed, s.dir * -0.3);
    if (this.phase !== 'flight' || this.resolved) {
      // Too late: the ball is past the bat.
      if (this.phase === 'flight' && this.resolved && !this.judgement && this.passedBat && performance.now() - this.arrR < 600 && !this.swing) {
        this.swing = s;
        this.hud.timing('late', s.t - this.arrR - this.lagMs(), 'Too late');
      }
      return;
    }
    if (this.swing) return;
    const k = TOLERANCE[this.cfg.difficulty];
    const dt = s.t - (this.arrR + this.lagMs());
    if (dt < -WINDOWS.edge * k - 40) {
      // Swung far too early: that's the shot gone.
      this.swing = s;
      this.resolved = true;
      this.judgement = null;
      this.hud.timing('early', dt, 'Way too early');
      return;
    }
    this.swing = s;
    if (this.gt - this.relG >= this.delivery!.arrive.t) this.resolveSwing(s);
  }

  private noSwing(): void {
    if (this.env.demo) console.log(`[bat] ball ${this.ballNo} no swing (pending ${this.pendingSince > 0}) swings=${this.swings}`);
    this.resolved = true;
    this.pendingSince = 0;
    this.judgement = null;
  }

  private resolveSwing(s: Swing): void {
    const d = this.delivery!;
    const contactTau = this.ballTau();
    this.resolved = true;
    this.pendingSince = 0;
    const j = judge(s, this.arrR + this.lagMs(), d.arrive.p.y, this.cfg.difficulty);
    this.judgement = j;
    if (this.env.demo)
      console.log(
        `[bat] ball ${this.ballNo} ${d.kind} ${d.speedKmh}kmh h=${d.arrive.p.y.toFixed(2)} swing dt=${j.timingMs.toFixed(0)} spd=${s.speed.toFixed(1)} grip=${s.gripY.toFixed(2)} sh=${swingHeight(s.gripY).toFixed(2)} -> ${j.grade}/${j.vert} hit=${j.hit}`,
      );
    if (j.grade === 'perfect') this.perfects++;
    if (!j.hit) {
      const why = j.grade === 'miss' ? (j.timingMs < 0 ? 'Too early' : 'Too late') : j.vert === 'over' ? 'Swung over it' : 'Swung under it';
      this.hud.timing(j.grade === 'miss' ? (j.timingMs < 0 ? 'early' : 'late') : j.timing, j.timingMs, why);
      if (j.grade !== 'miss') this.sounds.ooh(0.6);
      return;
    }
    this.contacts++;
    const shot = shotFrom(j, s, d.arrive, this.cfg.sport, this.cfg.difficulty, this.rng);
    this.shot = shot;
    const from = sampleAt(d, contactTau).p;
    const v0 = launchVector(shot.speed, shot.launch, shot.azimuth);
    this.track = simulateHit(this.cfg.sport, from, v0, shot.lift);
    this.hitG = this.gt;
    this.hitStopUntil = performance.now() + (j.sweet ? 110 : 60);
    if (j.sweet) this.slowmo(0.28, 900);
    this.flash(j.sweet ? 0.8 : 0.45);
    this.camShake = j.sweet ? 0.5 : 0.25;
    this.sounds.hit(this.cfg.sport, j.power, shot.edge, j.sweet);
    const at = v3(from);
    this.sparks.burst(at, j.sweet ? 26 : 12, j.sweet ? 6 : 3.5, new THREE.Color(1, 0.92, 0.7), 0.16, 0.35, { grav: 2, drag: 3 });
    if (this.cfg.sport === 'cricket') this.dust.burst(at, 6, 1.5, new THREE.Color(0.85, 0.8, 0.7), 0.1, 0.5, { grav: 1, drag: 3 });
    const label = j.timing === 'perfect' ? (j.sweet ? 'Sweet spot!' : 'Perfect timing') : j.grade === 'edge' ? (j.timing === 'early' ? 'Early · inside edge' : 'Late · edged') : j.timing === 'early' ? 'Early' : 'Late';
    this.hud.timing(j.timing, j.timingMs, label);
    this.setPhase('hit');
    if (this.cfg.sport === 'cricket') this.planCricketHit();
    else this.planBaseballHit();
  }

  /** The ball went past the bat: stumps, keeper, catcher, called pitches. */
  private stepPastBat(tau: number): void {
    const d = this.delivery!;
    if (!this.passedBat && tau > d.arrive.t + 0.01) this.passedBat = true;
    if (this.cfg.sport === 'cricket') {
      if (!this.crossedPlate && tau >= d.cross.t) {
        this.crossedPlate = true;
        if (d.onTarget) {
          this.world.stumps!.striker.shatter(d.cross.p.x, v3(d.cross.v));
          this.sounds.stumps();
          this.slowmo(0.35, 900);
          this.camShake = 0.3;
          this.sparks.burst(v3(d.cross.p), 18, 3, new THREE.Color(1, 0.3, 0.25), 0.18, 0.5, { grav: 2, drag: 2 });
          this.recordCricket('bowled', 0, 0);
          this.hud.banner('BOWLED!', this.judgement ? 'Beaten all ends up' : 'Left it… and lost the stumps', 'out', 2600);
          this.sounds.roar(0.55);
          this.signal('out');
          this.fieldersCelebrate();
          this.setPhase('dead');
          return;
        }
      }
      if (tau >= d.path[d.path.length - 1].t) {
        this.sounds.glove(0.6);
        if (!this.judgement && !this.swing) this.hud.banner('Dot ball', Math.abs(d.cross.p.x) > 0.25 ? 'Left alone outside off' : 'No shot offered', 'dot', 1500);
        else this.hud.banner('Dot ball', 'Beaten!', 'dot', 1500);
        this.recordCricket('dot', 0, 0);
        this.setPhase('dead');
      }
    } else {
      if (!this.crossedPlate && tau >= d.cross.t) {
        this.crossedPlate = true;
        if (this.zoneMarker) {
          this.zoneMarker.position.set(d.cross.p.x, d.cross.p.y, BASEBALL_GEOM.plateZ + 0.01);
          (this.zoneMarker.material as THREE.MeshBasicMaterial).color.set(d.onTarget ? 0xff4d5e : 0x7dff9a);
          this.zoneMarker.visible = true;
        }
      }
      if (tau >= d.path[d.path.length - 1].t) {
        this.sounds.glove(1);
        const swung = !!this.swing && (!!this.judgement || this.swing.t > this.relR);
        const g = this.baseball!;
        const call = swung ? g.record({ kind: 'miss' }) : g.record({ kind: 'take', strike: d.onTarget });
        const tone: Tone = call.out ? 'out' : 'call';
        const big = swung ? (call.out && g.mode === 'inning' ? 'STRIKE THREE!' : call.out ? 'OUT' : 'STRIKE!') : d.onTarget ? (call.out && g.mode === 'inning' ? 'STRIKE THREE!' : 'STRIKE') : 'BALL';
        this.hud.banner(big, swung ? 'Swing and a miss' : call.call, tone, 1600);
        if (!swung && !d.onTarget && g.mode === 'inning' && call.ended) this.hud.banner('WALK', call.call, 'good', 1800);
        this.lastResult = big;
        this.recorded = true;
        this.updateScore();
        this.updateScreen();
        this.setPhase('dead');
      }
    }
  }

  private lastResult = '';

  private recordCricket(event: 'dot' | 'runs' | 'four' | 'six' | 'bowled' | 'caught', runs: number, distance: number): void {
    if (this.recorded) return;
    this.recorded = true;
    const m = this.cricket!;
    m.record({ event, runs, distance });
    const sym = m.history[m.history.length - 1];
    if (this.overBalls.length >= 6) this.overBalls = [];
    this.overBalls.push(sym);
    this.longest = Math.max(this.longest, distance);
    this.lastResult = event === 'runs' ? `${runs}` : event;
    this.updateScore();
    this.updateScreen();
  }

  private finishBall(): void {
    if (!this.recorded) {
      // Safety net: should not normally happen.
      if (this.cricket) this.recordCricket('dot', 0, 0);
    }
    this.setPhase('dead');
  }

  // ---- hit replays ------------------------------------------------------------------------------------

  private planCricketHit(): void {
    const tr = this.track!;
    const shot = this.shot!;
    const o = resolveCricket(tr, this.fieldInfo, this.rng, shot.edge);
    this.cOut = o;
    const name = cricketShotName(shot, this.cfg.handed);
    const T = (t: number) => t; // track time == game time since contact
    if (o.result === 'six') {
      const t = tr.crossT > 0 ? tr.crossT : tr.landT;
      this.at(T(t), () => {
        this.recordCricket('six', 6, o.distance);
        this.hud.banner('SIX!', `${o.distance} m · ${name}`, 'six', 3000);
        this.sounds.roar(1);
        this.world.crowd.excite = 0.7;
        this.signal('six');
        if (this.world.night) this.launchFireworks(4);
      });
      this.at(T(tr.landT), () => this.world.crowd.hotspot(v3(tr.landP), 1));
      if (tr.inStands) this.at(T(tr.landT + 0.35), () => this.crowdCam(tr.landP));
      this.endG = this.gt + Math.max(tr.landT + 2.4, t + 2.8);
      this.chase(o.play.fielder, tr.landP, 0.75);
    } else if (o.result === 'four') {
      const t = tr.crossT > 0 ? tr.crossT : tr.endT;
      this.at(T(t), () => {
        this.recordCricket('four', 4, o.distance);
        this.hud.banner('FOUR!', name, 'four', 2600);
        this.sounds.roar(0.75);
        this.world.crowd.excite = 0.45;
        this.signal('four');
      });
      this.endG = this.gt + t + 2.2;
      this.chaseNearest(tr, t);
    } else if (o.result === 'caught') {
      this.sendFielder(o.play.fielder, v3(o.play.at), o.play.t, 'catch');
      this.at(T(o.play.t), () => {
        this.ballHeld = this.actorFor(o.play.fielder);
        this.sounds.glove(0.9);
        this.recordCricket('caught', 0, o.distance);
        this.hud.banner('OUT!', o.label, 'out', 2800);
        this.sounds.roar(0.6);
        this.signal('out');
        this.fieldersCelebrate();
      });
      this.endG = this.gt + o.play.t + 2.4;
    } else {
      // Fielded: maybe after a drop. Batters run.
      const runs = o.runs;
      this.sendFielder(o.play.fielder, v3(o.play.at), o.play.t, 'pickup');
      if (o.play.kind === 'drop') {
        this.at(T(o.play.t - 0.85), () => {
          this.hud.banner('DROPPED!', 'Put down in the field', 'dot', 1400);
          this.sounds.ooh(1);
          this.sounds.glove(0.5);
        });
      }
      this.at(T(o.play.t), () => {
        this.ballHeld = this.actorFor(o.play.fielder);
      });
      const throwStart = o.play.t + 0.25;
      const dur = Math.max(0.35, o.returnT - throwStart - 0.25);
      this.at(T(throwStart), () => this.startThrow(o.play.fielder, v3(o.throwTo), dur));
      if (runs > 0) this.runBatters(runs);
      const doneT = Math.max(o.returnT, runs > 0 ? RUN_TIMES[runs - 1] : 0);
      this.at(T(doneT), () => {
        this.recordCricket(runs > 0 ? 'runs' : 'dot', runs, o.distance);
        if (runs > 0) this.hud.banner(runs === 1 ? '1 RUN' : `${runs} RUNS`, o.label.startsWith('Dropped') || o.label === 'Misfield!' ? o.label : name, 'runs', 1800);
        else this.hud.banner('Dot ball', `${name} · ${o.label}`, 'dot', 1600);
        if (runs >= 2) this.sounds.roar(0.3);
      });
      this.endG = this.gt + doneT + 1.0;
      this.chaseNearest(tr, o.play.t, o.play.fielder);
    }
  }

  private planBaseballHit(): void {
    const tr = this.track!;
    const shot = this.shot!;
    const o = resolveBaseball(tr, this.fieldInfo, this.rng, shot.launch);
    this.bOut = o;
    const g = this.baseball!;
    const T = (t: number) => t;
    const fair = o.result !== 'foul';
    if (fair && o.result !== 'out') this.runBatterBaseball(o.bases);
    else if (o.outKind === 'ground') this.runBatterBaseball(1);
    if (o.result === 'hr') {
      const t = tr.crossT > 0 ? tr.crossT : tr.landT;
      this.at(T(t), () => {
        const call = g.record({ kind: 'inplay', result: 'hr', distance: o.distance });
        this.finishPitch(call.call === 'Grand slam!' ? 'GRAND SLAM!' : 'HOME RUN!', o.label, 'hr');
        this.sounds.roar(1);
        this.world.crowd.excite = 0.8;
        this.launchFireworks(6);
      });
      this.at(T(tr.landT), () => this.world.crowd.hotspot(v3(tr.landP), 1));
      if (tr.inStands) this.at(T(tr.landT + 0.35), () => this.crowdCam(tr.landP));
      this.endG = this.gt + Math.max(tr.landT + 2.8, t + 3.4);
      this.chase(o.play.fielder >= 0 ? o.play.fielder : this.nearestFielder(tr.landP), tr.landP, 0.8);
    } else if (o.result === 'foul') {
      const t = Math.min(tr.landT, 2.5);
      this.at(T(t), () => {
        const call = g.record({ kind: 'foul' });
        this.finishPitch(g.mode === 'derby' ? 'FOUL · OUT' : 'FOUL BALL', g.mode === 'derby' ? 'Every non-homer swing is an out' : call.call, g.mode === 'derby' ? 'out' : 'call');
      });
      this.endG = this.gt + t + 1.4;
    } else if (o.result === 'out') {
      const action = o.play.kind === 'catch' ? 'catch' : 'pickup';
      this.sendFielder(o.play.fielder, v3(o.play.at), o.play.t, action);
      let t = o.play.t;
      if (o.outKind === 'ground') {
        const from = v3(o.play.at);
        const to = v3(o.throwTo);
        const dur = Math.max(0.4, from.distanceTo(to) / 34);
        this.at(T(o.play.t), () => (this.ballHeld = this.actorFor(o.play.fielder)));
        this.at(T(o.play.t + 0.3), () => this.startThrow(o.play.fielder, to, dur));
        t = o.play.t + 0.3 + dur;
      } else this.at(T(o.play.t), () => (this.ballHeld = this.actorFor(o.play.fielder)));
      this.at(T(t), () => {
        this.sounds.glove(1);
        const call = g.record({ kind: 'inplay', result: 'out', distance: o.distance, outKind: o.outKind, deep: o.deep });
        this.finishPitch('OUT', o.label + (call.runs ? ' · run scores' : ''), 'out');
        this.sounds.roar(0.25);
      });
      this.endG = this.gt + t + 1.8;
    } else {
      this.sendFielder(o.play.fielder, v3(o.play.at), o.play.t, 'pickup');
      this.at(T(o.play.t), () => (this.ballHeld = this.actorFor(o.play.fielder)));
      const to = v3(o.throwTo);
      const dur = Math.max(0.5, v3(o.play.at).distanceTo(to) / 30);
      this.at(T(o.play.t + 0.35), () => this.startThrow(o.play.fielder, to, dur));
      this.at(T(o.play.t + 0.2), () => {
        const call = g.record({ kind: 'inplay', result: o.result as 'single' | 'double' | 'triple', distance: o.distance });
        const big = o.result === 'single' ? 'SINGLE!' : o.result === 'double' ? 'DOUBLE!' : 'TRIPLE!';
        if (g.mode === 'derby') this.finishPitch('OUT', `${o.label} · only homers count`, 'out');
        else this.finishPitch(big, call.runs ? `${o.label} · ${call.runs} run${call.runs > 1 ? 's' : ''} in` : o.label, 'four');
        this.sounds.roar(o.result === 'single' ? 0.4 : 0.65);
      });
      this.endG = this.gt + o.play.t + dur + 1.6;
      this.chaseNearest(tr, o.play.t, o.play.fielder);
    }
  }

  private finishPitch(big: string, sub: string, tone: Tone): void {
    this.recorded = true;
    this.lastResult = big;
    this.longest = Math.max(this.longest, this.baseball!.longest);
    this.hud.banner(big, sub, tone, 2600);
    this.updateScore();
    this.updateScreen();
  }

  private actorFor(fieldIndex: number): Actor | null {
    const info = this.fieldInfo[fieldIndex];
    return this.actors.find((a) => a.info === info) ?? null;
  }

  private nearestFielder(p: V3): number {
    let best = 0;
    let bd = 1e9;
    this.fieldInfo.forEach((f, i) => {
      if (f.role === 'keeper' || f.role === 'catcher' || f.role === 'pitcher' || f.role === 'bowler') return;
      const d = Math.hypot(f.x - p.x, f.z - p.z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  /** Fielder runs to a point arriving at track time t, then catches or picks up. */
  private sendFielder(fieldIndex: number, at: THREE.Vector3, t: number, action: 'catch' | 'pickup'): void {
    const a = this.actorFor(fieldIndex);
    if (!a) return;
    a.target = new THREE.Vector3(at.x, 0, at.z);
    a.arriveG = this.gt + t - 0.05;
    a.mode = 'run';
    a.t0 = this.gt + (a.info?.react ?? 0.3) * 0.7;
    a.catchH = at.y;
    this.at(Math.max(0, t - 0.3), () => {
      a.mode = action;
      a.t0 = this.gt;
    });
  }

  /** Someone gives chase towards where the ball is going, without catching it. */
  private chase(fieldIndex: number, to: V3, k: number): void {
    const idx = fieldIndex >= 0 ? fieldIndex : this.nearestFielder(to);
    const a = this.actorFor(idx);
    if (!a) return;
    const dir = new THREE.Vector3(to.x - a.pos.x, 0, to.z - a.pos.z);
    const d = Math.min(dir.length(), 18);
    dir.setLength(d);
    a.target = a.pos.clone().add(dir);
    a.arriveG = this.gt + d / ((a.info?.speed ?? 7) * k) + 0.4;
    a.mode = 'run';
    a.t0 = this.gt + 0.35;
  }

  private chaseNearest(tr: HitTrack, until: number, except = -1): void {
    const p = pointAt(tr, Math.min(until, tr.endT));
    const order = this.fieldInfo
      .map((f, i) => ({ i, d: Math.hypot(f.x - p.x, f.z - p.z), f }))
      .filter((x) => x.i !== except && x.f.role !== 'keeper' && x.f.role !== 'catcher' && x.f.role !== 'bowler' && x.f.role !== 'pitcher')
      .sort((a, b) => a.d - b.d);
    for (const o of order.slice(0, except >= 0 ? 1 : 2)) this.chase(o.i, p, 0.8);
  }

  private startThrow(fieldIndex: number, to: THREE.Vector3, dur: number): void {
    const a = this.actorFor(fieldIndex);
    if (!a) return;
    a.mode = 'throw';
    a.t0 = this.gt;
    a.target = null;
    a.yaw = this.faceYaw(a.pos, to);
    this.at(0.22, () => {
      this.ballHeld = null;
      this.throwFrom = a.fig.world('handR', new THREE.Vector3());
      this.throwG = this.gt;
      this.throwDur = dur;
      this.throwTo = to.clone();
    });
    this.at(0.22 + dur, () => {
      this.sounds.glove(0.5);
      this.throwFrom = null;
      this.ballHeld = this.receiverFor(to);
    });
  }

  private receiverFor(to: THREE.Vector3): Actor | null {
    if (this.cfg.sport === 'cricket') return to.z > -9 ? this.keeper : this.bowler;
    let best: Actor | null = null;
    let bd = 1e9;
    for (const a of this.actors) {
      if (!a.info) continue;
      const d = a.pos.distanceTo(to);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best;
  }

  private runBatters(runs: number): void {
    const h = this.cfg.handed;
    const ends = [new THREE.Vector3(-0.6 * h, 0, 0.6), new THREE.Vector3(-0.6 * h, 0, -17.9)];
    let from = this.batterHome();
    this.batterRunning = true;
    this.batterRun = [];
    for (let k = 0; k < runs; k++) {
      const to = k % 2 === 0 ? ends[1] : ends[0];
      const t0 = k === 0 ? 0.35 : RUN_TIMES[k - 1];
      this.batterRun.push({ from: from.clone(), to: to.clone(), t0, t1: RUN_TIMES[k] - 0.1 });
      from = to;
    }
  }

  private runBatterBaseball(bases: number): void {
    const P = BASEBALL_PARK.bases;
    this.batterRunning = true;
    this.batterRun = [];
    let from = this.batterHome();
    const times = [0.3, 4.25, 8.3, 12.4, 16.5];
    for (let k = 0; k < Math.min(4, Math.max(1, bases)); k++) {
      const b = P[k];
      const to = new THREE.Vector3(b.x, 0, b.z);
      this.batterRun.push({ from: from.clone(), to, t0: times[k], t1: times[k + 1] - 0.05 });
      from = to;
    }
    // Runners on base advance too.
    const g = this.baseball!;
    this.runners.forEach((r, i) => {
      if (!(g.mode === 'inning' && g.bases[i])) return;
      const n = Math.min(3 - i, Math.max(1, bases));
      const path = [];
      for (let k = 1; k <= n; k++) path.push(P[(i + k) % 4]);
      const last = path[path.length - 1];
      r.target = new THREE.Vector3(last.x, 0, last.z);
      r.arriveG = this.gt + 4 * n;
      r.mode = 'run';
      r.t0 = this.gt + 0.3;
    });
  }

  private signal(kind: 'six' | 'four' | 'out'): void {
    for (const u of [this.umpire, this.legUmpire]) {
      if (!u) continue;
      u.signal = kind;
      u.t0 = this.gt;
    }
  }

  private fieldersCelebrate(): void {
    for (const f of this.fielders) {
      if (f.mode === 'run' && f.target) continue;
      f.mode = 'celebrate';
      f.t0 = this.gt;
    }
    if (this.bowler) {
      this.bowler.mode = 'celebrate';
      this.bowler.t0 = this.gt;
    }
  }

  /** Broadcast-style cut to the stand where a big hit landed. */
  private crowdCam(land: V3): void {
    const L = v3(land);
    const centre = this.cfg.sport === 'cricket' ? new THREE.Vector3(0, 0, -8.8) : new THREE.Vector3(0, 0, -45);
    const dir = centre.clone().sub(L).setY(0).normalize();
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const pos = L.clone().addScaledVector(dir, 26).addScaledVector(side, 6).setY(Math.max(4, L.y * 0.6 + 3));
    this.cut = { pos, look: L.clone().add(new THREE.Vector3(0, 1.5, 0)), fov: 34, fresh: true };
  }

  private launchFireworks(n: number): void {
    const rim = this.world.rim;
    if (!rim.length) return;
    for (let i = 0; i < n; i++) {
      const from = rim[Math.floor(this.rng.next() * rim.length)];
      const to = from.clone().multiplyScalar(0.75);
      to.y = 45 + this.rng.next() * 25;
      this.fireworks.launch(from, to, i * 0.35);
      this.sounds.firework(1.6 + i * 0.35);
    }
  }

  private flash(k: number): void {
    const f = this.flashEl;
    f.style.transition = 'none';
    f.style.opacity = String(k);
    void f.offsetWidth;
    f.style.transition = 'opacity 0.35s ease-out';
    f.style.opacity = '0';
  }

  // ---- input -----------------------------------------------------------------------------------------

  private processPose(now: number): void {
    let frames = this.env.pose.since(this.lastPoseT);
    if (this.bot) {
      // Demo: sample the bot directly at 30 Hz so swings are never lost to a slow frame (headless tests).
      frames = [];
      const bot = this.bot;
      for (let t = this.lastPoseT + 33.3; t <= now; t += 33.3) frames.push({ t, lm: SimPose.build(bot.drive(t)), w: SimPose.W, h: SimPose.H });
      if (frames.length > 400) frames = frames.slice(-400);
    }
    for (const f of frames) {
      this.lastPoseT = f.t;
      const b = this.env.body.measure(f);
      if (!b.ok) {
        const s = this.tracker.update(f.t, null);
        if (s) this.onSwing(s);
        continue;
      }
      this.latestBody = b;
      const lv = b.lWristV > 0.35;
      const rv = b.rWristV > 0.35;
      let g: V2 | null = null;
      if (lv && rv) g = { x: (b.lWrist.x + b.rWrist.x) / 2, y: (b.lWrist.y + b.rWrist.y) / 2 };
      else if (lv) g = { ...b.lWrist };
      else if (rv) g = { ...b.rWrist };
      if (g) this.grip = g;
      const s = this.tracker.update(f.t, g);
      if (s) this.onSwing(s);
      if (!this.env.demo && this.phase !== 'flight' && this.phase !== 'hit') {
        if (this.handsUp.update(b, now)) void this.pause();
      }
    }
    if (!this.env.demo) {
      const b = this.latestBody;
      const up = !!b && handsUp(b) && this.phase !== 'flight' && this.phase !== 'hit';
      this.hud.pauseProgress(this.upHold.update(up, now));
    }
  }

  // ---- animation ---------------------------------------------------------------------------------------

  private animate(dt: number, now: number): void {
    const time = now / 1000;
    const dtR = Math.min(0.1, dt / Math.max(0.02, this.timeScale));
    this.world.update(dt, time);
    this.dust.update(dt);
    this.sparks.update(dt);
    this.fireworks.update(dt);
    // Grip smoothing for the on-screen bat (frame-rate independent).
    const k = 1 - Math.exp(-dtR * 28);
    this.gripSmooth.x += (this.grip.x - this.gripSmooth.x) * k;
    this.gripSmooth.y += (this.grip.y - this.gripSmooth.y) * k;
    this.updateBowler(dt);
    this.updateBatter(now);
    for (const a of this.actors) if (a !== this.bowler) this.updateActor(a, dt);
    this.updateBall();
    {
      // Streak behind the ball while it travels fast.
      const p = this.ball.position;
      const fast = this.ball.visible && (this.phase === 'flight' || (this.phase === 'hit' && !this.ballHeld));
      const up = new THREE.Vector3(0, 0.035, 0);
      this.ballTrail.push(p.clone().sub(up), p.clone().add(up), now / 1000, fast ? 20 : 0);
      this.halo.visible = this.ball.visible && this.phase !== 'ready' && this.phase !== 'runup';
    }
    this.updateZone();
    this.updateBlobs();
  }

  private updateBowler(dt: number): void {
    const b = this.bowler;
    const fig = b.fig;
    const since = this.gt - this.phaseG;
    if (this.cfg.sport === 'cricket') {
      const spin = this.runupLen < 2;
      const stride = 0.92;
      const relU = 0.62;
      const zBound = CRICKET_GEOM.bowlerCreaseZ - 2.3;
      const zRel = CRICKET_GEOM.bowlerCreaseZ - 0.15;
      if (this.phase === 'ready' || this.phase === 'intro') {
        fig.idle(this.gt, 1);
        b.pos.set(0.75, 0, spin ? -26 : -35);
        b.yaw = 0;
      } else if (this.phase === 'runup' || (this.phase === 'flight' && this.gt - this.relG < (1 - relU) * stride + 0.6)) {
        // Time relative to release.
        const tr = this.phase === 'runup' ? since - this.runupLen : this.gt - this.relG;
        const strideStart = -relU * stride;
        if (tr < strideStart) {
          const runT = this.runupLen + strideStart;
          const k = clamp((tr - (-this.runupLen)) / runT, 0, 1);
          const z0 = spin ? -26 : -35;
          // Accelerate through the run-up.
          const z = z0 + (zBound - z0) * (k * k * 0.35 + k * 0.65);
          const speed = (zBound - z0) / runT;
          b.phase += (speed * 0.016 + 0.0) * 2.4;
          b.phase = (z - z0) * 1.15;
          fig.run(b.phase, spin ? 0.45 : 0.85);
          b.pos.set(0.75, 0, z);
        } else {
          const u = (tr - strideStart) / stride;
          fig.bowl(u, spin);
          const z = u < relU ? zBound + (zRel - zBound) * smooth(u / relU) : zRel + 2.6 * (1 - Math.pow(1 - clamp((u - relU) / (1 - relU), 0, 1), 2));
          b.pos.set(0.75 + Math.max(0, u - relU) * 1.6, 0, z);
        }
        b.yaw = 0;
      } else if (b.mode === 'celebrate') {
        fig.celebrate(this.gt - b.t0);
      } else if (b.mode === 'run' || b.mode === 'catch' || b.mode === 'pickup' || b.mode === 'throw') {
        this.updateActor(b, dt);
        return;
      } else {
        fig.idle(this.gt, 1);
        b.pos.lerp(new THREE.Vector3(2.2, 0, -14), 0.02);
        b.yaw = this.faceYaw(b.pos, { x: 0, z: 0 });
      }
    } else {
      const wind = 1.5;
      const relU = 0.66;
      if (this.phase === 'ready' || this.phase === 'intro') {
        fig.pitch(0);
        b.pos.set(0.15, BASEBALL_GEOM.moundH, BASEBALL_GEOM.rubberZ - 0.3);
      } else if (this.phase === 'runup' || (this.phase === 'flight' && this.gt - this.relG < wind * (1 - relU))) {
        const tr = this.phase === 'runup' ? since - this.runupLen : this.gt - this.relG;
        const u = clamp((tr + relU * wind) / wind, 0, 1);
        fig.pitch(u);
        b.pos.set(0.15, BASEBALL_GEOM.moundH - 0.08 * smooth((u - 0.3) / 0.4), BASEBALL_GEOM.rubberZ - 0.3 + 1.1 * smooth((u - 0.3) / 0.45));
      } else if (b.mode === 'celebrate') fig.celebrate(this.gt - b.t0);
      else if (b.mode === 'run' || b.mode === 'catch' || b.mode === 'pickup' || b.mode === 'throw') {
        this.updateActor(b, dt);
        return;
      }
      else fig.ready(this.gt, 0.4, 2);
      b.yaw = b.mode === 'run' && b.target ? b.yaw : 0;
    }
    fig.root.position.copy(b.pos);
    fig.root.rotation.y = b.yaw;
  }

  private updateActor(a: Actor, dt: number): void {
    const fig = a.fig;
    const t = this.gt - a.t0;
    switch (a.mode) {
      case 'run': {
        if (!a.target) {
          fig.ready(this.gt, 1, a.seed);
          break;
        }
        if (this.gt < a.t0) {
          fig.ready(this.gt, 1, a.seed);
          break;
        }
        const left = a.target.clone().sub(a.pos);
        left.y = 0;
        const d = left.length();
        const tl = Math.max(0.05, a.arriveG - this.gt);
        const sp = Math.min((a.info?.speed ?? 7) * 1.25, d / tl);
        if (d > 0.05) {
          a.yaw = Math.atan2(left.x, left.z);
          a.pos.addScaledVector(left.normalize(), Math.min(d, sp * dt));
        }
        a.speed = sp;
        a.phase += sp * dt * 1.55;
        if (d < 0.1) fig.ready(this.gt, 1, a.seed);
        else fig.run(a.phase, clamp(sp / 7, 0.2, 1));
        break;
      }
      case 'walk': {
        // Fielders walking in as the bowler runs up.
        const k = clamp(t / 2.2, 0, 1);
        const toward = new THREE.Vector3(-a.home.x, 0, -a.home.z).normalize();
        a.pos.copy(a.home).addScaledVector(toward, 2.2 * smooth(k));
        a.phase += dt * 5.5 * (1 - k);
        if (k < 1) fig.run(a.phase, 0.05);
        else fig.ready(this.gt, 1, a.seed);
        break;
      }
      case 'catch':
        fig.catchAt(a.catchH ?? 1.2, t);
        break;
      case 'pickup':
        fig.pickup(clamp(t / 0.6, 0, 1));
        break;
      case 'throw':
        fig.throwBall(clamp(t / 0.5, 0, 1));
        break;
      case 'celebrate':
        fig.celebrate(t + a.seed);
        break;
      case 'squat':
        fig.squat(this.gt + a.seed, this.phase === 'hit' ? clamp(t, 0, 1) * 0 : 0);
        break;
      case 'signal':
        fig.signal(a.signal ?? 'none', this.gt);
        break;
      case 'idle':
        if (a === this.partner) this.updatePartner(a);
        else fig.idle(this.gt, a.seed);
        break;
      default:
        fig.ready(this.gt, this.phase === 'runup' || this.phase === 'flight' ? 1 : 0.6, a.seed);
    }
    if (a.mode === 'run' && a.info?.role === 'keeper' && this.cfg.sport === 'cricket') a.pos.y = 0;
    // Runners stay hidden unless on base.
    fig.root.position.copy(a.pos);
    fig.root.rotation.y = a.yaw;
  }

  private updatePartner(a: Actor): void {
    const fig = a.fig;
    const h = this.cfg.handed;
    if (this.batterRunning && this.cOut && this.cOut.runs > 0 && this.phase === 'hit') {
      const tH = this.gt - this.hitG;
      // The partner runs the opposite way along the other side of the pitch.
      let z = -17.6;
      for (const seg of this.batterRun) {
        if (tH >= seg.t0) {
          const k = smooth((tH - seg.t0) / (seg.t1 - seg.t0));
          const fromZ = seg.to.z > -9 ? -17.6 : 0.6;
          const toZ = seg.to.z > -9 ? 0.6 : -17.6;
          z = fromZ + (toZ - fromZ) * k;
        }
      }
      const moving = this.batterRun.some((s) => tH >= s.t0 && tH < s.t1);
      a.phase += 0.25;
      if (moving) fig.run(a.phase, 0.9);
      else fig.ready(this.gt, 0.5);
      a.pos.set(-1.05 * h + 2.1 * h, 0, z);
      a.yaw = this.batterRun.length && z < a.pos.z ? Math.PI : 0;
    } else {
      // Backing up as the ball is bowled.
      const since = this.gt - this.relG;
      const back = this.phase === 'flight' || this.phase === 'hit' ? smooth(since / 0.8) * 1.4 : 0;
      a.pos.set(-1.05 * h, 0, -17.6 + back);
      a.yaw = 0;
      fig.idle(this.gt, a.seed);
      fig.r('armR', -0.25, 0, -0.15);
      fig.r('foreR', -0.4);
    }
    fig.root.updateMatrixWorld(true);
    if (this.partnerBat) {
      const hand = fig.world('handR', tmpV);
      this.partnerBat.position.copy(hand);
      const down = new THREE.Vector3(0.15, -1, 0.35).normalize();
      this.partnerBat.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), down);
    }
  }

  private updateBatter(now: number): void {
    const fig = this.batter;
    const h = this.cfg.handed;
    const cricket = this.cfg.sport === 'cricket';
    const tH = this.gt - this.hitG;
    if (this.batterRunning && this.phase === 'hit' && this.batterRun.length) {
      // Running between the wickets / around the bases, bat in hand (dropped in baseball).
      let pos = this.batterRun[0].from.clone();
      let moving = false;
      let yaw = fig.root.rotation.y;
      for (const seg of this.batterRun) {
        if (tH >= seg.t0) {
          const k = clamp((tH - seg.t0) / (seg.t1 - seg.t0), 0, 1);
          pos = seg.from.clone().lerp(seg.to, smooth(k));
          if (k < 1) {
            moving = true;
            yaw = Math.atan2(seg.to.x - seg.from.x, seg.to.z - seg.from.z);
          }
        }
      }
      fig.root.position.copy(pos);
      fig.root.rotation.y = yaw;
      if (moving) fig.run(tH * 9, 1);
      else fig.ready(this.gt, 0.4);
      fig.root.updateMatrixWorld(true);
      if (cricket) {
        const hand = fig.world('handR', tmpV);
        this.bat.position.copy(hand);
        this.bat.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0.2, -0.6, 0.6).normalize());
      } else if (this.bat.visible && tH > 0.3) {
        // Bat dropped near the plate.
        this.bat.position.set(-0.4 * h, 0.04, 0.4);
        this.bat.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(0.9 * h, 0, 0.4).normalize());
      }
      this.trail.push(this.bat.position, this.bat.position, now / 1000, 0);
      return;
    }
    const { grip, dir } = poseBatter(fig, this.bat, this.gripSmooth, this.cfg.sport, h);
    const tip = grip.clone().addScaledVector(dir, BAT[this.cfg.sport].length * 0.95);
    const mid = grip.clone().addScaledVector(dir, BAT[this.cfg.sport].length * 0.45);
    this.trail.push(mid, tip, now / 1000, this.tracker.speed);
  }

  private updateBall(): void {
    const ball = this.ball;
    const d = this.delivery;
    ball.visible = true;
    if (!d || this.phase === 'intro') {
      ball.visible = false;
      return;
    }
    if (this.phase === 'ready' || this.phase === 'runup') {
      // In the bowler's / pitcher's hand.
      this.bowler.fig.root.updateMatrixWorld(true);
      const hand = this.bowler.fig.world('handR', tmpV);
      const tr = this.phase === 'runup' ? this.gt - this.phaseG - this.runupLen : -9;
      if (tr > -0.08) hand.lerp(v3(d.release), clamp((tr + 0.08) / 0.08, 0, 1));
      ball.position.copy(hand);
      return;
    }
    if (this.phase === 'flight' || (this.phase === 'dead' && !this.track)) {
      const s = sampleAt(d, this.ballTau());
      ball.position.set(s.p.x, s.p.y, s.p.z);
      ball.rotation.x -= 0.4;
      if (this.phase === 'dead' && this.cfg.sport === 'cricket' && this.world.stumps?.striker.broken) {
        // Ball dies after hitting the stumps.
        const c = d.cross.p;
        ball.position.set(c.x, Math.max(0.05, c.y * 0.6), d.cross.p.z + 0.4);
      }
      if (this.phase === 'dead' && this.passedBat && !this.world.stumps?.striker.broken) ball.visible = this.cfg.sport === 'baseball';
      return;
    }
    if (this.track) {
      const tH = this.gt - this.hitG;
      if (this.ballHeld) {
        this.ballHeld.fig.root.updateMatrixWorld(true);
        ball.position.copy(this.ballHeld.fig.world('handR', tmpV));
      } else if (this.throwFrom && this.throwTo) {
        const k = clamp((this.gt - this.throwG) / this.throwDur, 0, 1);
        const p = this.throwFrom.clone().lerp(this.throwTo, k);
        p.y += Math.sin(k * Math.PI) * Math.min(6, this.throwFrom.distanceTo(this.throwTo) * 0.08);
        ball.position.copy(p);
      } else {
        const p = pointAt(this.track, tH);
        ball.position.set(p.x, p.y, p.z);
        ball.rotation.x -= 0.6;
        // Dust where it lands.
        if (!this.bounced && tH >= this.track.landT && !this.track.inStands) {
          this.bounced = true;
          this.dust.burst(v3(this.track.landP), 8, 1.4, new THREE.Color(0.55, 0.62, 0.38), 0.3, 0.8, { up: 0.5, grav: 0.5, drag: 2 });
          this.sounds.bounce('grass', 0.6);
        }
      }
    }
  }

  private updateZone(): void {
    if (!this.zone) return;
    const show = this.phase === 'ready' || this.phase === 'runup' || this.phase === 'flight' || (this.phase === 'dead' && !this.track);
    this.zone.visible = show;
  }

  private updateBlobs(): void {
    const bl = this.blobs;
    bl.begin();
    for (const a of this.actors) if (a.fig.root.visible) bl.add(a.fig.root.position.x, a.fig.root.position.z, 0.85);
    bl.add(this.batter.root.position.x, this.batter.root.position.z, 0.9);
    if (this.ball.visible) {
      const y = this.ball.position.y;
      const s = clamp(0.14 + y * 0.03, 0.14, 0.5);
      if (y < 30) bl.add(this.ball.position.x, this.ball.position.z, s * BALL_VISUAL_SCALE * 0.6, 0.02);
    }
    bl.end();
  }

  // ---- camera -------------------------------------------------------------------------------------------

  private battingCam(): { pos: THREE.Vector3; look: THREE.Vector3; fov: number } {
    const h = this.cfg.handed;
    if (this.cfg.sport === 'cricket') return { pos: new THREE.Vector3(0.35 * h, 2.5, 6.1), look: new THREE.Vector3(0.0, 0.95, -17), fov: 37 };
    return { pos: new THREE.Vector3(0.5 * h, 2.85, 6.2), look: new THREE.Vector3(-0.05 * h, 1.0, -18), fov: 36 };
  }

  private updateCamera(dt: number, now: number): void {
    const cam = this.camera;
    const hero = this.env.params.get('hero');
    if (hero) {
      // Test aid for menu art: a fixed wide shot.
      const v = hero.split(',').map(Number);
      cam.position.set(v[0], v[1], v[2]);
      cam.lookAt(v[3], v[4], v[5]);
      cam.fov = v[6] || 40;
      cam.updateProjectionMatrix();
      return;
    }
    const bc = this.battingCam();
    let pos = bc.pos.clone();
    let look = bc.look.clone();
    let fov = bc.fov;
    let rate = 6;
    if (this.cut) {
      pos = this.cut.pos.clone();
      look = this.cut.look.clone();
      fov = this.cut.fov;
      rate = 2;
      if (this.cut.fresh) {
        this.cut.fresh = false;
        this.camPos.copy(pos);
        this.camLook.copy(look);
        this.camFov = fov;
        this.hud.distance(null);
      }
      // Slow push-in on the celebrating crowd.
      pos.lerp(look, 0.12);
    } else if (this.phase === 'intro') {
      const t = (this.gt - this.phaseG) / 3.2;
      const a = -0.9 + t * 1.3;
      const r = 70 - t * 30;
      pos.set(Math.sin(a) * r, 28 - t * 14, (this.cfg.sport === 'cricket' ? -8 : -30) + Math.cos(a) * r);
      look.set(0, 2, this.cfg.sport === 'cricket' ? -9 : -25);
      fov = 45;
      rate = 30;
      if (t > 0.85) {
        const k = smooth((t - 0.85) / 0.15);
        pos.lerp(bc.pos, k);
        look.lerp(bc.look, k);
      }
    } else if ((this.phase === 'hit' || (this.phase === 'dead' && this.track)) && this.track) {
      const tH = this.gt - this.hitG;
      const tr = this.track;
      const ballP = this.ball.position.clone();
      const big = tr.carry > 38 || tr.apex > 8;
      const hd = new THREE.Vector3(tr.landP.x, 0, tr.landP.z);
      if (hd.lengthSq() < 1) hd.set(0, 0, -1);
      hd.normalize();
      // Rise above and behind the batter, look along the shot, zoom as the ball gets far.
      const k = smooth(tH / (big ? 0.9 : 0.6));
      const behind = new THREE.Vector3(0, 0, 0).addScaledVector(hd, big ? -16 : -10);
      const follow = behind.add(new THREE.Vector3(0, big ? 11 : 6.5, 0));
      if (Math.abs(hd.z) < 0.5) follow.add(new THREE.Vector3(0, 0, 6));
      pos = bc.pos.clone().lerp(follow, k);
      if (this.cfg.sport === 'baseball') pos.z = Math.max(pos.z, -2);
      const target = this.ballHeld ? this.ballHeld.pos.clone().add(new THREE.Vector3(0, 1.2, 0)) : ballP;
      this.followLook.lerp(target, tH < 0.05 ? 1 : clamp(dt * 7, 0, 1));
      look = bc.look.clone().lerp(this.followLook, smooth(tH / 0.35));
      const dist = pos.distanceTo(this.followLook);
      fov = clamp((2 * Math.atan(16 / Math.max(1, dist)) * 180) / Math.PI, 14, 52);
      fov = THREE.MathUtils.lerp(bc.fov, fov, smooth(tH / 0.6));
      rate = 12;
      // Distance readout next to the ball for big hits.
      if (big && !this.ballHeld && !this.throwFrom && tH < tr.landT + 0.2) {
        const d = Math.round(flatDist({ x: ballP.x, y: 0, z: ballP.z }, { x: 0, y: 0, z: this.cfg.sport === 'cricket' ? 0.3 : 0 }));
        const sp = ballP.clone().project(cam);
        if (sp.z < 1) this.hud.distance(`${d} m`, sp.x * 0.5 + 0.5 + 0.04, -sp.y * 0.5 + 0.5 - 0.06);
      } else this.hud.distance(null);
    } else {
      // Batting view: tiny breathing sway; nudge towards the ball late in its flight.
      const t = now / 1000;
      pos.x += Math.sin(t * 0.7) * 0.02;
      pos.y += Math.sin(t * 0.9) * 0.015;
      this.followLook.copy(look);
      if (this.phase === 'dead' && this.world.stumps?.striker.broken) {
        look.lerp(new THREE.Vector3(0, 0.4, 1.2), 0.35);
        fov -= 6;
      }
    }
    this.camShake = Math.max(0, this.camShake - dt * 1.5);
    const sh = this.camShake * 0.06;
    const kk = 1 - Math.exp(-dt * rate);
    if (this.phase === 'intro' || this.camPos.lengthSq() === 0) {
      this.camPos.copy(pos);
      this.camLook.copy(look);
      this.camFov = fov;
    } else {
      this.camPos.lerp(pos, kk);
      this.camLook.lerp(look, Math.min(1, kk * 1.5));
      this.camFov += (fov - this.camFov) * kk;
    }
    cam.position.copy(this.camPos).add(new THREE.Vector3((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, 0));
    cam.lookAt(this.camLook);
    if (Math.abs(cam.fov - this.camFov) > 0.01) {
      cam.fov = this.camFov;
      cam.updateProjectionMatrix();
    }
  }

  /** Snap the camera back to the batting view (between balls). */
  private cutToBatting(): void {
    const bc = this.battingCam();
    this.camPos.copy(bc.pos);
    this.camLook.copy(bc.look);
    this.camFov = bc.fov;
  }

  // ---- HUD ---------------------------------------------------------------------------------------------

  private updateScore(): void {
    if (this.cricket) this.hud.cricketScore(this.cricket, this.overBalls);
    else this.hud.baseballScore(this.baseball!);
  }

  private updateScreen(): void {
    const s = this.world.screen;
    if (this.cricket) {
      const m = this.cricket;
      if (m.mode === 'chase') s.draw(`BIG HITTERS · ${m.overs} OV`, `${m.runs}/${m.wickets}`, m.runs >= m.target ? 'WON!' : `NEED ${m.need} OFF ${m.ballsLeft}`);
      else s.draw('SIX HITTING', `${m.sixes} × 6`, `${Math.round(m.sixDistance)} M TOTAL`);
    } else {
      const g = this.baseball!;
      if (g.mode === 'derby') s.draw('HOME RUN DERBY', `${g.hrs} HR`, `${g.maxOuts - g.outs} OUTS LEFT`);
      else s.draw(`B ${g.balls}  S ${g.strikes}  OUT ${g.outs}`, `${g.runs} RUNS`, `${g.hits} HITS`);
    }
  }

  private debug(): void {
    const c = this.cricket;
    const b = this.baseball;
    (window as unknown as { __gameDebug: unknown }).__gameDebug = {
      sport: this.cfg.sport,
      mode: this.cfg.mode,
      difficulty: this.cfg.difficulty,
      phase: this.phase,
      gt: Math.round(this.gt * 100) / 100,
      ts: Math.round(this.timeScale * 100) / 100,
      balls: c ? c.balls : b!.pitches,
      runs: c ? c.runs : b!.runs,
      wickets: c?.wickets,
      outs: b?.outs,
      hrs: b?.hrs,
      fours: c?.fours,
      sixes: c?.sixes,
      history: c ? c.history.join(' ') : b!.history.join(' '),
      lastResult: this.lastResult,
      lastPlay: this.cOut?.label ?? this.bOut?.label ?? '',
      swings: this.swings,
      contacts: this.contacts,
      longest: Math.round(this.longest),
      finished: this.finished,
      fps: Math.round(this.fpsAvg),
      quality: this.r3.currentLevel,
    };
  }

  // ---- pause / finish ---------------------------------------------------------------------------------------

  private async pause(): Promise<void> {
    if (this.paused || this.finished) return;
    this.paused = true;
    const pausedAt = performance.now();
    await this.env.audio.pause();
    const act = await pauseMenu(this.el, this.env.cursor);
    if (act === 'resume') {
      await this.env.audio.resume();
      const gap = performance.now() - pausedAt;
      // Shift real-time anchors so the delivery timing is unaffected.
      this.relR += gap;
      this.arrR += gap;
      if (this.pendingSince) this.pendingSince += gap;
      this.lastPoseT = performance.now();
      this.tracker.reset();
      this.lastFrame = performance.now();
      this.paused = false;
      if (this.bot && this.phase === 'flight') this.bot.decide(this.delivery!, this.arrR, this.rng, this.cfg.mode);
      return;
    }
    await this.env.audio.resume();
    this.cleanup();
    this.resolveRun(act === 'restart' ? { kind: 'restart' } : { kind: 'quit' });
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.setPhase('done');
    const c = this.cricket;
    const won = c ? c.won : this.baseball!.stars() > 0;
    if (c && c.mode === 'chase') {
      const by = c.target - 1 - c.runs;
      const sub = c.won ? `Won with ${c.ballsLeft} ball${c.ballsLeft === 1 ? '' : 's'} to spare` : by === 0 ? 'Scores level — a tie!' : `Lost by ${by} run${by === 1 ? '' : 's'}`;
      this.hud.banner(c.won ? 'YOU WIN!' : by === 0 ? 'TIED!' : 'INNINGS OVER', sub, c.won ? 'six' : 'out', 0);
    }
    else if (c) this.hud.banner(`${c.sixes} SIXES`, `${Math.round(c.sixDistance)} m of sixes`, 'six', 0);
    else this.hud.banner(this.baseball!.mode === 'derby' ? `${this.baseball!.hrs} HOME RUNS` : `${this.baseball!.runs} RUNS`, 'Final', 'hr', 0);
    if (won) {
      this.sounds.roar(0.9);
      this.world.crowd.excite = 1;
      this.launchFireworks(this.world.night ? 8 : 3);
    }
    const stats: SessionStats = {
      sport: this.cfg.sport,
      mode: this.cfg.mode,
      difficulty: this.cfg.difficulty,
      cricket: this.cricket ?? undefined,
      baseball: this.baseball ?? undefined,
      longest: Math.max(this.longest, this.baseball?.longest ?? 0),
      swings: this.swings,
      contacts: this.contacts,
      perfects: this.perfects,
    };
    this.debug();
    window.setTimeout(() => {
      this.cleanup();
      this.resolveRun({ kind: 'done', stats });
    }, 3200);
  }

  private cleanup(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.sounds.stopAll();
    if (this.env.pose instanceof SimPose) this.env.pose.drive = () => ({ lWrist: { x: -0.75, y: -1.55 }, rWrist: { x: 0.75, y: -1.55 } });
    for (const a of this.actors) a.fig.dispose();
    this.batter.dispose();
    this.world.scene.environment?.dispose();
    const textures = new Set<THREE.Texture>();
    this.world.scene.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
        for (const v of Object.values(m)) if (v instanceof THREE.Texture) textures.add(v);
        const u = (m as THREE.ShaderMaterial).uniforms;
        if (u) for (const x of Object.values(u)) if (x && x.value instanceof THREE.Texture) textures.add(x.value);
      }
    });
    textures.forEach((t) => t.dispose());
    this.r3.dispose();
    this.hud.destroy();
    this.el.remove();
  }
}

