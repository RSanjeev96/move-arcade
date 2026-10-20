/** One race session: grid, start lights, racing, finish and cool-down. Resolves with the outcome. */
import * as THREE from 'three';
import type { Body } from '../../core/body';
import { SimPose } from '../../core/pose';
import { Renderer3D } from '../../core/render';
import { CamPreview, HandsUpPause, pauseMenu } from '../../ui/kit';
import type { GameEnv } from '../types';
import { LIVERIES, WHEEL_R, makeF1, makeMoto, type Livery, type VehicleView } from './cars';
import { LeanControls, WheelControls, leanPose, wheelPose, type ControlMapper } from './controls';
import { Particles, SkidMarks, SpeedLines, glowSprite } from './fx';
import { Hud, ordinal, type TowerRow } from './hud';
import { AIDriver, Gearbox, SteerFilter, collide, lookahead, newCar, pursuitCurv, stepCar, steerCurv, type CarState, type DriveInput } from './physics';
import { RaceAudio } from './sound';
import { blobTexture } from './textures';
import { LapTimer, SPECS, TRACKS, buildTrack, frameAt, lapOf, rankOrder, sampleAt, speedProfile, worldAt, wrapS, type TrackData, type VehicleSpec } from './track';
import { World, type GridSlot, type Textures } from './world';

export type Difficulty = 'easy' | 'normal' | 'hard';
export type Mode = 'f1' | 'moto';

export interface RaceConfig {
  mode: Mode;
  track: number;
  difficulty: Difficulty;
  laps: number;
  type: 'race' | 'tt';
  view: 'chase' | 'onboard';
}

export interface Standing {
  name: string;
  code: string;
  color: string;
  human: boolean;
  time: number;
  best: number;
  finished: boolean;
}

export interface GhostData {
  time: number;
  /** Samples every 0.1 s: lap distance, lateral offset. */
  dist: number[];
  d: number[];
}

export interface RaceResult {
  cfg: RaceConfig;
  trackName: string;
  position: number;
  total: number;
  best: number;
  laps: number[];
  standings: Standing[];
  ghost: GhostData | null;
}

export type RaceOutcome = { kind: 'done'; result: RaceResult } | { kind: 'quit' } | { kind: 'restart' };

interface Racer {
  car: CarState;
  view: VehicleView;
  livery: Livery;
  ai: AIDriver;
  timer: LapTimer;
  human: boolean;
  finished: boolean;
  finishTime: number;
  gear: Gearbox;
  spin: number;
  steerVis: number;
  leanVis: number;
  pos: THREE.Vector3;
  yaw: number;
  /** Race time at each 20 m of progress. */
  marks: number[];
}

const SKILL: Record<Difficulty, [number, number]> = { easy: [0.83, 0.9], normal: [0.9, 0.965], hard: [0.95, 1.0] };
const BAND: Record<Difficulty, number> = { easy: 1.4, normal: 1, hard: 0.5 };
const H = 1 / 120;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const angDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export class Race {
  private t: TrackData;
  private spec: VehicleSpec;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 9000);
  private r3d!: Renderer3D;
  private world!: World;
  private hud!: Hud;
  private el!: HTMLElement;
  private preview: CamPreview | null = null;
  private racers: Racer[] = [];
  private player!: Racer;
  private profile!: Float32Array;
  private safeProfile!: Float32Array;
  private ctl: ControlMapper;
  private steer = new SteerFilter();
  private audio!: RaceAudio;
  private smoke = new Particles(700, false, -0.6, 1.2);
  private sparks = new Particles(400, true, 9.8, 0.6);
  private skids = new SkidMarks();
  private lines = new SpeedLines();
  private flame!: THREE.Sprite;
  private ghostView: VehicleView | null = null;
  private pauseGesture = new HandsUpPause();
  private resolve!: (o: RaceOutcome) => void;
  private raf = 0;
  private lastNow = 0;
  private acc = 0;
  private phase: 'intro' | 'lights' | 'race' | 'finish' = 'intro';
  private phaseT = 0;
  private lightsHold = 0.8;
  private raceTime = 0;
  private paused = false;
  private ended = false;
  private lastPoseT = 0;
  private body: Body | null = null;
  private boostMeter = 0.35;
  private shake = 0;
  private camYaw = 0;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camInit = false;
  private fovKick = 0;
  private view: 'chase' | 'onboard';
  private wrongFor = 0;
  private offFor = 0;
  private lastPos = 8;
  private lastContact = -10;
  private lapShown = 1;
  private hudT = 0;
  private towerT = 0;
  private tipsShown = new Set<string>();
  private ghostRec: { dist: number[]; d: number[]; lapStartP: number; t: number } = { dist: [], d: [], lapStartP: 0, t: 0 };
  private bestGhost: GhostData | null;
  private finishedAt = 0;
  private fps = 60;
  private excite = 0.2;
  private gridSlots: GridSlot[] = [];
  private tmpV = new THREE.Vector3();
  private shiftCut = 0;
  private blobs!: THREE.InstancedMesh;
  private blobM = new THREE.Matrix4();
  private blobQ = new THREE.Quaternion();
  private blobS = new THREE.Vector3(1, 1, 1);

  constructor(
    private env: GameEnv,
    private cfg: RaceConfig,
    private tex: Textures,
    ghost: GhostData | null,
  ) {
    this.t = buildTrack(TRACKS[cfg.track]);
    this.spec = SPECS[cfg.mode];
    this.ctl = cfg.mode === 'f1' ? new WheelControls() : new LeanControls();
    this.view = cfg.view;
    this.bestGhost = cfg.type === 'tt' ? ghost : null;
  }

  run(): Promise<RaceOutcome> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.build();
      this.lastNow = performance.now();
      this.lastPoseT = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    });
  }

  // ---- setup -------------------------------------------------------------------------------------

  private build(): void {
    const env = this.env;
    const cfg = this.cfg;
    this.el = document.createElement('div');
    this.el.className = 'game-root racer-game';
    this.el.innerHTML = '<canvas class="gl"></canvas><div class="rg-vignette"></div>';
    env.root.appendChild(this.el);
    const canvas = this.el.querySelector('canvas') as HTMLCanvasElement;
    const night = TRACKS[cfg.track].theme === 'city';
    this.r3d = new Renderer3D(canvas, this.scene, this.camera, env.settings.quality, {
      bloom: night ? { strength: 0.85, radius: 0.55, threshold: 0.78 } : { strength: 0.28, radius: 0.4, threshold: 0.95 },
      exposure: night ? 1.0 : 0.86,
      shadows: true,
    });
    if (this.r3d.currentLevel !== 'high') this.scene.userData.lowShadow = true;
    const n = cfg.type === 'tt' ? 1 : 8;
    for (let k = 0; k < n; k++) this.gridSlots.push({ s: -9 - k * 8.5, d: (k % 2 ? 1 : -1) * 2.6 });
    this.world = new World(this.t, this.tex, this.r3d.renderer, this.scene, this.gridSlots);
    this.scene.add(this.world.group);
    if (this.world.sun.shadow.mapSize.x > 1024 && this.r3d.currentLevel !== 'high') this.world.sun.shadow.mapSize.set(1024, 1024);

    this.profile = speedProfile(this.t, this.spec);
    this.safeProfile = speedProfile(this.t, this.spec, cfg.difficulty === 'easy' ? 0.86 : 0.97, 0.8);

    // Racers: the player starts 6th of 8 in a race (pole in time trial).
    const playerSlot = cfg.type === 'tt' ? 0 : 5;
    const [sk0, sk1] = SKILL[cfg.difficulty];
    const ais = LIVERIES.slice(1);
    const order: { livery: Livery; human: boolean; skill: number }[] = [];
    let ai = 0;
    for (let k = 0; k < n; k++) {
      if (k === playerSlot) order.push({ livery: LIVERIES[0], human: true, skill: 1 });
      else {
        // Faster cars start further up the grid, with a little shuffle.
        const f = 1 - ai / Math.max(1, n - 2);
        order.push({ livery: ais[ai % ais.length], human: false, skill: sk0 + (sk1 - sk0) * clamp(f + Math.sin(ai * 2.7) * 0.15, 0, 1) });
        ai++;
      }
    }
    // Soft contact shadows under every vehicle (one instanced draw).
    const blobTex = blobTexture();
    const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6 });
    const bg = new THREE.PlaneGeometry(cfg.mode === 'f1' ? 2.4 : 1.1, cfg.mode === 'f1' ? 6.2 : 2.6);
    bg.rotateX(-Math.PI / 2);
    this.blobs = new THREE.InstancedMesh(bg, blobMat, n);
    this.blobs.frustumCulled = false;
    this.scene.add(this.blobs);
    order.forEach((o, k) => {
      const sl = this.gridSlots[k];
      const car = newCar(sl.s, sl.d);
      const view = cfg.mode === 'f1' ? makeF1(o.livery) : makeMoto(o.livery);
      if (night) view.material.envMapIntensity = 1.7;
      this.scene.add(view.root);
      const r: Racer = {
        car,
        view,
        livery: o.livery,
        ai: new AIDriver(o.skill, k + 1),
        timer: new LapTimer(this.t.length),
        human: o.human,
        finished: false,
        finishTime: 0,
        gear: cfg.mode === 'f1' ? new Gearbox(8, this.spec.vTop + this.spec.vBonus, 4200, 12500) : new Gearbox(6, this.spec.vTop + this.spec.vBonus, 5000, 17000),
        spin: 0,
        steerVis: 0,
        leanVis: 0,
        pos: new THREE.Vector3(),
        yaw: 0,
        marks: [],
      };
      this.racers.push(r);
      if (o.human) this.player = r;
    });
    if (this.bestGhost) {
      this.ghostView = cfg.mode === 'f1' ? makeF1(LIVERIES[0]) : makeMoto(LIVERIES[0]);
      const gm = new THREE.MeshBasicMaterial({ color: 0x7fd8ff, transparent: true, opacity: 0.28, depthWrite: false });
      this.ghostView.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.material = gm;
          m.castShadow = false;
        }
      });
      this.ghostView.root.visible = false;
      this.scene.add(this.ghostView.root);
    }

    this.scene.add(this.smoke.points, this.sparks.points, this.skids.mesh);
    this.camera.add(this.lines.lines);
    this.scene.add(this.camera);
    this.flame = glowSprite(0x7fc8ff, 0.9);
    this.flame.visible = false;
    this.player.view.body.add(this.flame);
    this.flame.position.copy(this.player.view.exhaust).add(new THREE.Vector3(0, 0, -0.2));

    // HUD.
    this.hud = new Hud(this.el, this.t, cfg.mode, cfg.type === 'tt');
    this.hud.pauseButton.addEventListener('click', () => void this.pause());
    this.hud.cameraButton.addEventListener('click', () => this.toggleView());
    if (env.settings.showCamera) {
      this.preview = new CamPreview(env.pose);
      this.hud.el.appendChild(this.preview.canvas);
    }
    this.hud.lap(1, cfg.laps);
    this.hud.position(playerSlot + 1, n);
    this.hud.banner(this.t.def.name, cfg.type === 'tt' ? 'Time trial' : `${cfg.laps} lap${cfg.laps > 1 ? 's' : ''} · ${cfg.difficulty}`, 3000, 'intro');
    this.hud.tip(cfg.mode === 'f1' ? 'Hold your hands up in front of you, like gripping a steering wheel' : 'Stand tall, hands in front like holding handlebars', 5200);

    this.audio = new RaceAudio(env.audio.ctx, env.audio.sfx, cfg.mode === 'moto');
    env.audio.sfx.gain.value = env.settings.sfxVolume;
    env.cursor(false);
    this.onResize();
    window.addEventListener('resize', this.onResize);

    if (env.demo && env.pose instanceof SimPose) {
      env.pose.drive = (tm) => this.bot(tm);
      this.demoBot = true;
      this.lastSim = performance.now();
      this.simTimer = window.setInterval(this.simTick, 33);
    }
    if (env.demo) (window as unknown as { __racer: unknown }).__racer = { scene: this.scene, world: this.world, r3d: this.r3d, race: this };
    // Compile every shader program now so the race never hitches when new objects come into view.
    this.placeAll();
    this.r3d.renderer.compile(this.scene, this.camera);
  }

  private placeAll(): void {
    for (const r of this.racers) this.placeRacer(r, 0);
    this.updateCamera(0, performance.now());
  }

  private onResize = (): void => {
    const h = this.el.clientHeight || window.innerHeight;
    const pr = this.r3d.renderer.getPixelRatio();
    this.smoke.setViewportHeight(h * pr);
    this.sparks.setViewportHeight(h * pr);
  };

  private toggleView(): void {
    this.view = this.view === 'chase' ? 'onboard' : 'chase';
    this.camInit = false;
  }

  // ---- main loop ------------------------------------------------------------------------------------

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    // Demo/test runs on slow software GL may take a second per frame: let the simulation catch up.
    const maxDt = this.env.demo ? 1 : 0.25;
    const dt = Math.min(maxDt, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    this.frames++;
    if (dt > 0) this.fps += 0.05 * (1 / Math.max(dt, 1e-3) - this.fps);
    if (!this.demoBot) this.simulate(dt, now);
    if (this.ended) return;
    const vdt = this.paused ? 0 : dt;
    this.updateVisuals(vdt, now);
    this.updateHud(now);
    this.r3d.render(Math.min(dt, 0.25));
    this.frameMs += 0.1 * (performance.now() - now - this.frameMs);
  };
  private frames = 0;
  private frameMs = 0;

  private simulate(dt: number, now: number): void {
    if (this.paused || this.ended) return;
    this.readPose(now);
    this.acc += dt;
    let steps = 0;
    while (this.acc >= H && steps < 125) {
      this.step(H);
      this.acc -= H;
      steps++;
      if (this.ended) return;
    }
    if (steps >= 125) this.acc = 0;
  }

  /** Demo mode: the simulation runs on a timer so it keeps real time even when rendering is very slow. */
  private simTick = (): void => {
    const now = performance.now();
    const dt = Math.min(1, Math.max(0, (now - this.lastSim) / 1000));
    this.lastSim = now;
    this.simulate(dt, now);
  };
  private lastSim = 0;
  private simTimer = 0;

  private readPose(now: number): void {
    if (!this.demoBot) {
      const frames = this.env.pose.since(this.lastPoseT);
      for (const f of frames) {
        this.lastPoseT = f.t;
        const b = this.env.body.measure(f);
        this.body = b;
        this.ctl.update(b);
      }
    }
    if (this.pauseGesture.update(this.body, now) && this.phase !== 'finish') void this.pause();
  }

  /**
   * Demo mode: the bot poses the simulated player 30 times per second of *simulation* time and the frames go
   * through the same body measurement and gesture code as the camera, so tests behave the same at any frame rate.
   */
  private botTick(h: number): void {
    this.simMs += h * 1000;
    this.botAcc += h;
    if (this.botAcc < 1 / 30) return;
    this.botAcc -= 1 / 30;
    const lm = SimPose.build(this.bot(this.simMs));
    const b = this.env.body.measure({ t: this.simMs, lm, w: SimPose.W, h: SimPose.H });
    this.body = b;
    this.ctl.update(b);
  }
  private simMs = 0;
  private botAcc = 0;
  private demoBot = false;

  // ---- simulation ------------------------------------------------------------------------------------

  private step(h: number): void {
    this.ctl.calibrating = this.phase === 'intro' || this.phase === 'lights';
    if (this.demoBot) this.botTick(h);
    this.phaseT += h;
    const cfg = this.cfg;
    if (this.phase === 'intro') {
      if (this.phaseT > 3.4) {
        this.phase = 'lights';
        this.phaseT = 0;
        this.lightsHold = 0.6 + Math.random() * 0.9;
      }
      this.idleRevs(h);
      return;
    }
    if (this.phase === 'lights') {
      const lit = Math.min(5, Math.floor(this.phaseT / 0.85) + 1);
      if (lit !== this.litShown) {
        this.litShown = lit;
        this.world.setStartLights(lit, false);
        this.audio.light(false);
      }
      if (this.phaseT > 5 * 0.85 + this.lightsHold) {
        this.phase = 'race';
        this.phaseT = 0;
        this.world.setStartLights(0, true);
        this.audio.light(true);
        this.hud.banner('GO!', '', 900, 'go');
        this.hud.flash('rgba(80,255,120,0.25)');
        this.audio.roar(0.6);
        setTimeout(() => !this.ended && this.world.setStartLights(0, false), 1500);
        if (cfg.mode === 'f1') this.hud.tip('<b>Steer</b> by turning your hands like a wheel', 4500);
        else this.hud.tip('<b>Lean</b> your body left and right to steer', 4500);
      }
      this.idleRevs(h);
      return;
    }
    this.raceTime += h;
    const cars = this.racers.map((r) => r.car);
    for (const r of this.racers) {
      const c = r.car;
      const p0 = c.p;
      const inp = r.human && this.phase === 'race' ? this.playerInput(h) : r.ai.drive(this.t, this.profile, c, cars, h, this.raceTime);
      if (!r.human) r.ai.band = this.rubberBand(r);
      stepCar(this.t, this.spec, c, inp, h);
      const lap = r.timer.update(p0, this.raceTime - h, c.p, this.raceTime);
      if (lap !== null) this.onLap(r, lap);
      if (!r.finished && c.p >= cfg.laps * this.t.length) this.onFinish(r);
      const shifted = r.gear.update(c.v, c.throttle, h);
      if (r.human && shifted) {
        this.audio.shift(shifted > 0);
        if (shifted > 0) this.shiftCut = 0.06;
      }
      if (r.human && c.wallHit > 0) this.onWall(c);
    }
    this.recordMarks();
    for (const ct of collide(this.t, cars, this.spec.length, this.spec.width + 0.1)) {
      const A = this.racers[ct.a];
      const B = this.racers[ct.b];
      if (A.human || B.human) {
        if (this.raceTime - this.lastContact > 0.35) {
          this.audio.bump(ct.strength);
          this.shake = Math.max(this.shake, Math.min(0.6, 0.15 + ct.strength * 0.05));
          const p = A.human ? B.pos : A.pos;
          this.burstSparks(p.clone().lerp(this.player.pos, 0.5), 10, 0.6);
        }
        this.lastContact = this.raceTime;
      }
    }
    // Boost.
    const pc = this.player.car;
    if (cfg.mode === 'f1' && this.phase === 'race') {
      const s = wrapS(this.t, pc.p);
      const straight = Math.abs(sampleAt(this.t, this.t.curv, s)) < 1 / 700;
      if (pc.boost <= 0 && straight && pc.v > 40) this.boostMeter = Math.min(1, this.boostMeter + h / 13);
      if (this.ctl.c.boost) {
        this.ctl.c.boost = false;
        if (this.boostMeter >= 1 && pc.boost <= 0) {
          pc.boost = 4;
          this.boostMeter = 0;
          this.audio.boost();
          this.fovKick = 1;
          this.hud.flash('rgba(90,190,255,0.28)');
          this.hud.banner('BOOST', 'DRS open', 1100, 'boost');
        }
      }
    }
    // Wrong way / recovery.
    if (this.phase === 'race') {
      const back = Math.abs(pc.psi) > 1.9;
      this.wrongFor = back ? this.wrongFor + h : 0;
      if (this.wrongFor > 2.5 && pc.v < 12) pc.psi -= Math.sign(pc.psi) * h * 1.2; // gentle auto-turn
      this.offFor = pc.surface === 'grass' || pc.surface === 'gravel' ? this.offFor + h : 0;
    }
    if (this.phase === 'finish') {
      this.finishedAt += h;
      const allDone = this.racers.every((r) => r.finished);
      if ((allDone && this.finishedAt > 3) || this.finishedAt > 7) this.end();
    }
  }

  private litShown = 0;

  private idleRevs(h: number): void {
    for (const r of this.racers) {
      r.gear.update(0, this.phase === 'lights' ? 0.5 + 0.5 * Math.sin(this.phaseT * 9 + r.ai.reaction * 10) : 0.15, h);
    }
  }

  private rubberBand(r: Racer): number {
    if (this.cfg.type === 'tt') return 1;
    let gap = r.car.p - this.player.car.p;
    const k = BAND[this.cfg.difficulty];
    // Ahead of the player: ease off slightly; far behind: push a little.
    if (gap > 0) gap = Math.max(0, gap - 60);
    else gap = Math.min(0, gap + 60);
    return 1 + clamp(-gap / 500, -0.045, 0.03) * k;
  }

  /** Player controls → drive input (with difficulty assists). */
  private playerInput(h: number): DriveInput {
    const c = this.player.car;
    const cfg = this.cfg;
    const t = this.t;
    const ctl = this.ctl.c;
    const holding = ctl.holding;
    const u = this.steer.update(holding ? ctl.steer : 0, c.v / this.spec.vTop, h);
    const ks = steerCurv(this.spec, c.v) * (c.tuck ? 0.8 : 1);
    const look = lookahead(c.v);
    const follow = pursuitCurv(t, c, clamp(c.d, -t.hw + 1.4, t.hw - 1.4), look);
    let curv: number;
    if (cfg.difficulty === 'easy') curv = follow + u * ks * 0.55;
    else if (cfg.difficulty === 'normal') curv = u * ks + follow * 0.35;
    else curv = u * ks;
    let throttle = holding ? 1 : 0;
    let brake = ctl.brake;
    if (brake > 0.05) throttle = 0;
    if (!holding) brake = Math.max(brake, c.v > 30 ? 0.08 : 0);
    const s = wrapS(t, c.p);
    const vSafe = Math.min(sampleAt(t, this.safeProfile, s + c.v * 0.25), sampleAt(t, this.safeProfile, s + c.v * 0.6 + 6));
    if (cfg.difficulty === 'easy' && c.v > vSafe + 0.5) {
      throttle = 0;
      brake = Math.max(brake, clamp((c.v - vSafe) / 4, 0.25, 1));
    } else if (cfg.difficulty === 'normal' && c.v > vSafe + 3) throttle = Math.min(throttle, 0.2);
    if (cfg.mode === 'moto' && cfg.difficulty !== 'hard' && c.v > vSafe + 6) brake = Math.max(brake, 0.3);
    return { curv, throttle, brake, tuck: cfg.mode === 'moto' && ctl.tuck && c.v > 15 };
  }

  private onLap(r: Racer, lap: number): void {
    if (!r.human) return;
    const done = r.timer.laps.length;
    const best = r.timer.best === lap;
    // Ghost recording (time trial).
    if (this.cfg.type === 'tt') {
      const rec = this.ghostRec;
      if (!this.bestGhost || lap < this.bestGhost.time) this.bestGhost = { time: lap, dist: rec.dist.slice(), d: rec.d.slice() };
      rec.dist = [];
      rec.d = [];
      rec.lapStartP = done * this.t.length;
      rec.t = 0;
    }
    if (done < this.cfg.laps) {
      const lapNo = done + 1;
      if (lapNo === this.cfg.laps && this.cfg.laps > 1) {
        this.hud.banner('FINAL LAP', `${ordinal(this.lastPos)} place · last lap ${fmt(lap)}`, 2600, 'final');
        this.audio.roar(0.5);
      } else this.hud.banner(`LAP ${lapNo}`, `${best ? 'Best lap! ' : ''}${fmt(lap)}`, 2000, best ? 'best' : '');
    }
  }

  private onFinish(r: Racer): void {
    r.finished = true;
    // The lap timer interpolated the exact moment the line was crossed.
    r.finishTime = r.timer.laps.length >= this.cfg.laps ? r.timer.lapStart : this.raceTime;
    if (!r.human) return;
    this.phase = 'finish';
    this.finishedAt = 0;
    const pos = this.positionOf(this.player);
    if (this.cfg.type === 'tt') this.hud.banner('FINISH', `Best lap ${fmt(r.timer.best)}`, 0, 'win');
    else this.hud.banner(pos === 1 ? 'WINNER!' : `${ordinal(pos)} PLACE`, fmt(r.finishTime), 0, pos <= 3 ? 'win' : '');
    this.audio.fanfare(pos === 1 || this.cfg.type === 'tt');
    this.hud.flash('rgba(255,255,255,0.35)');
    this.excite = 1;
  }

  private onWall(c: CarState): void {
    const k = c.wallHit;
    this.audio.impact(k);
    this.shake = Math.max(this.shake, Math.min(0.9, 0.2 + k * 0.06));
    const f = frameAt(this.t, c.p);
    const side = c.wallSide;
    const p = worldAt(this.t, c.p, c.d + side * (this.spec.width / 2), this.tmpV).clone();
    p.y += 0.3;
    this.burstSparks(p, 18 + Math.round(k * 3), 1, f.tx, f.tz);
    this.hud.flash('rgba(255,80,40,0.22)');
  }

  private burstSparks(p: THREE.Vector3, count: number, power: number, tx = 0, tz = 0): void {
    const col = new THREE.Color(1, 0.65, 0.25);
    const v = this.player.car.v * 0.6;
    for (let k = 0; k < count; k++) {
      this.sparks.spawn(
        p.x,
        p.y,
        p.z,
        tx * v + (Math.random() - 0.5) * 9 * power,
        Math.random() * 6 * power + 1,
        tz * v + (Math.random() - 0.5) * 9 * power,
        0.3 + Math.random() * 0.5,
        0.09 + Math.random() * 0.06,
        -0.05,
        col,
        1,
      );
    }
  }

  /** Record when each racer passes every 20 m mark (for real time gaps on the timing tower). */
  private recordMarks(): void {
    for (const r of this.racers) {
      const m = Math.floor((r.car.p + 200) / 20);
      while (r.marks.length <= m) r.marks.push(this.raceTime);
    }
  }

  /** Seconds that `b` is behind `a` at b's current position. */
  private gapTo(a: Racer, b: Racer): number {
    const m = b.marks.length - 1;
    if (m < 0 || m >= a.marks.length) return 0;
    return b.marks[m] - a.marks[m];
  }

  private positionOf(r: Racer): number {
    const order = rankOrder(this.racers.map((x) => ({ p: x.car.p, finished: x.finished, finishTime: x.finishTime })));
    return order.indexOf(this.racers.indexOf(r)) + 1;
  }

  // ---- demo bot -------------------------------------------------------------------------------------

  private bot(tm: number): ReturnType<SimPose['drive']> {
    const c = this.player.car;
    const t = this.t;
    if (this.phase !== 'race') return this.cfg.mode === 'f1' ? wheelPose(0, -0.3) : leanPose(0, false, false);
    const look = lookahead(c.v);
    const s = wrapS(t, c.p);
    const target = sampleAt(t, t.line, s + look);
    const want = pursuitCurv(t, c, target, look);
    const ks = steerCurv(this.spec, c.v) * (c.tuck ? 0.8 : 1);
    const follow = pursuitCurv(t, c, clamp(c.d, -t.hw + 1.4, t.hw - 1.4), look);
    let u: number;
    if (this.cfg.difficulty === 'easy') u = (want - follow) / (0.55 * ks);
    else if (this.cfg.difficulty === 'normal') u = (want - follow * 0.35) / ks;
    else u = want / ks;
    u = this.steer.unshape(clamp(u, -1, 1));
    const vT = Math.min(sampleAt(t, this.profile, s + c.v * 0.3), sampleAt(t, this.profile, s + c.v * 0.7 + 8)) * 0.96;
    const brake = c.v > vT + 1.5;
    if (this.cfg.mode === 'f1') {
      const straight = Math.abs(sampleAt(t, t.curv, s + 40)) < 1 / 700 && Math.abs(sampleAt(t, t.curv, s + 120)) < 1 / 500;
      const boost = this.boostMeter >= 1 && straight && c.boost <= 0 && Math.floor(tm / 400) % 2 === 0;
      return wheelPose(u, brake ? -1.25 : boost ? 0.75 : -0.3);
    }
    const tuck = !brake && Math.abs(sampleAt(t, t.curv, s + 20)) < 1 / 400 && c.v > 30;
    return leanPose(u, tuck, brake);
  }

  // ---- visuals ----------------------------------------------------------------------------------------

  private placeRacer(r: Racer, dt: number): void {
    const c = r.car;
    const f = frameAt(this.t, c.p);
    worldAt(this.t, c.p, c.d, r.pos);
    r.yaw = f.yaw + c.psi;
    const root = r.view.root;
    root.position.copy(r.pos);
    const grade = sampleAt(this.t, this.t.grade, wrapS(this.t, c.p));
    root.rotation.set(0, 0, 0);
    root.rotation.order = 'YXZ';
    root.rotation.y = r.yaw;
    root.rotation.x = -Math.atan(grade);
    const isMoto = this.cfg.mode === 'moto';
    r.spin -= (c.v / WHEEL_R[this.cfg.mode]) * dt;
    const steerTarget = clamp(c.kAct * (isMoto ? 1.4 : 3.6), -0.45, 0.45) + c.slip * Math.sign(c.kAct) * 0.1;
    r.steerVis += (steerTarget - r.steerVis) * Math.min(1, dt * 10);
    let lean: number;
    if (isMoto) {
      const target = clamp(Math.atan2(c.lat, 9.81), -0.98, 0.98);
      r.leanVis += (target - r.leanVis) * Math.min(1, dt * 6);
      lean = r.leanVis;
    } else {
      const target = clamp(c.lat * 0.0024, -0.05, 0.05);
      r.leanVis += (target - r.leanVis) * Math.min(1, dt * 6);
      lean = r.leanVis;
    }
    // Slight squat under braking / acceleration.
    r.view.body.rotation.x = clamp(-c.lon * (isMoto ? 0.002 : 0.0009), -0.03, 0.03);
    r.view.pose(r.steerVis, lean, r.spin, {
      brake: c.braking,
      drs: c.boost > 0,
      tuck: c.tuck ? 1 : 0,
      hang: isMoto ? clamp(lean / 0.9, -1, 1) : 0,
    });
    const k = this.racers.indexOf(r);
    this.blobQ.setFromAxisAngle(Y_AXIS, r.yaw);
    this.blobM.compose(this.tmpV.set(r.pos.x, r.pos.y + 0.03, r.pos.z), this.blobQ, this.blobS);
    this.blobs.setMatrixAt(k, this.blobM);
    this.blobs.instanceMatrix.needsUpdate = true;
    r.view.setLod(!r.human && r.pos.distanceToSquared(this.camera.position) > 75 * 75);
  }

  private updateVisuals(dt: number, now: number): void {
    for (const r of this.racers) this.placeRacer(r, dt);
    const pc = this.player.car;
    const p = this.player;
    // Effects: smoke from sliding / lock-ups, dust off track.
    const fwd = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    const right = new THREE.Vector3(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
    const isMoto = this.cfg.mode === 'moto';
    const rearBack = isMoto ? 0.7 : 1.75;
    const rearX = isMoto ? 0 : 0.78;
    for (const r of this.racers) {
      const c = r.car;
      if (dt <= 0) break;
      const near = r.pos.distanceToSquared(this.camera.position) < 120 * 120;
      if (!near) continue;
      const rf = new THREE.Vector3(Math.sin(r.yaw), 0, Math.cos(r.yaw));
      const rr = new THREE.Vector3(Math.cos(r.yaw), 0, -Math.sin(r.yaw));
      const off = c.surface === 'grass' || c.surface === 'gravel';
      const smokeAmt = c.slip > 0.38 ? c.slip - 0.3 : 0;
      const rate = off ? Math.min(30, c.v * 0.45) : smokeAmt * 30;
      const nEmit = Math.min(6, Math.floor(rate * dt + Math.random()));
      for (let k = 0; k < nEmit; k++) {
        const side = isMoto ? 0 : Math.random() < 0.5 ? -1 : 1;
        const x = r.pos.x - rf.x * rearBack + rr.x * rearX * side;
        const z = r.pos.z - rf.z * rearBack + rr.z * rearX * side;
        const col = (off ? (c.surface === 'gravel' ? new THREE.Color(0.75, 0.66, 0.5) : new THREE.Color(0.45, 0.4, 0.3)) : new THREE.Color(0.85, 0.85, 0.86)).multiplyScalar(this.world.night ? 0.32 : 0.9);
        this.smoke.spawn(x, r.pos.y + 0.25, z, rf.x * c.v * 0.35 + (Math.random() - 0.5) * 2, 0.6 + Math.random() * 0.8, rf.z * c.v * 0.35 + (Math.random() - 0.5) * 2, 0.9 + Math.random() * 0.6, off ? 0.8 : 0.6, off ? 1.4 : 1.5, col, off ? 0.4 : 0.26);
      }
    }
    // Skid marks (player).
    if (dt > 0) {
      const sk = pc.slip > 0.35 || (pc.braking > 0.85 && pc.v > 30) ? Math.max(pc.slip, 0.5) : 0;
      for (const w of [0, 1] as const) {
        const side = isMoto ? 0 : w ? 1 : -1;
        const pos = p.pos.clone().addScaledVector(fwd, -rearBack).addScaledVector(right, rearX * side);
        this.skids.add(w, pos, right, pc.surface === 'road' || pc.surface === 'kerb' ? sk : 0, isMoto ? 0.18 : 0.38);
      }
    }
    this.smoke.update(dt);
    this.sparks.update(dt);

    // Boost flame.
    this.flame.visible = pc.boost > 0;
    if (this.flame.visible) this.flame.scale.setScalar(0.6 + Math.random() * 0.5);

    // Ghost car (time trial).
    if (this.ghostView && this.bestGhost && this.phase === 'race') {
      const g = this.bestGhost;
      const lapT = this.player.timer.current(this.raceTime);
      const k = lapT / 0.1;
      const i = Math.floor(k);
      if (i + 1 < g.dist.length && this.player.timer.laps.length >= 0) {
        const f = k - i;
        const base = this.player.timer.laps.length * this.t.length;
        const dist = g.dist[i] + (g.dist[i + 1] - g.dist[i]) * f;
        const d = g.d[i] + (g.d[i + 1] - g.d[i]) * f;
        const gp = base + dist;
        const fr = frameAt(this.t, gp);
        this.ghostView.root.visible = true;
        worldAt(this.t, gp, d, this.ghostView.root.position);
        this.ghostView.root.rotation.set(0, fr.yaw, 0);
      } else this.ghostView.root.visible = false;
    }
    // Ghost recording.
    if (this.cfg.type === 'tt' && this.phase === 'race' && dt > 0) {
      const rec = this.ghostRec;
      rec.t += dt;
      const lapT = this.player.timer.current(this.raceTime);
      while (rec.dist.length * 0.1 <= lapT) {
        rec.dist.push(pc.p - this.player.timer.laps.length * this.t.length);
        rec.d.push(pc.d);
      }
    }

    this.updateCamera(dt, now);
    const nearStand = this.world.stands.reduce((m, s) => Math.min(m, s.distanceTo(p.pos)), Infinity);
    const crowd = clamp(1 - (nearStand - 30) / 170, 0, 1);
    this.excite = Math.max(0.15, this.excite - dt * 0.15);
    this.world.update(dt, now / 1000, p.pos, Math.max(crowd * 0.6, this.excite));
    this.lines.update(dt, pc.v, clamp((pc.v - 48) / 30, 0, 1) * 0.7 + (pc.boost > 0 ? 0.5 : 0));

    // Audio.
    let pack = { rpm: 6000, gain: 0, pan: 0 };
    let best = Infinity;
    for (const r of this.racers) {
      if (r === p) continue;
      const d = r.pos.distanceTo(p.pos);
      if (d < best) {
        best = d;
        const rel = r.pos.clone().sub(this.camera.position);
        const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
        pack = { rpm: r.gear.rpm, gain: clamp(1 - d / 70, 0, 1), pan: rel.normalize().dot(camRight) };
      }
    }
    this.shiftCut = Math.max(0, this.shiftCut - dt);
    if (!this.paused) {
      this.audio.update({
        rpm: p.gear.rpm,
        throttle: this.phase === 'race' || this.phase === 'finish' ? pc.throttle : this.phase === 'lights' ? 0.6 : 0.1,
        speed: pc.v / this.spec.vTop,
        slip: pc.surface === 'road' || pc.surface === 'kerb' ? pc.slip : 0,
        kerb: pc.surface === 'kerb',
        offroad: pc.surface === 'grass' || pc.surface === 'gravel',
        crowd: Math.max(crowd, this.excite > 0.5 ? this.excite : 0),
        pack,
        cut: this.shiftCut > 0 ? 1 : 0,
        boost: pc.boost > 0,
      });
    }
    this.preview?.draw(now);
  }

  private updateCamera(dt: number, now: number): void {
    const p = this.player;
    const c = p.car;
    const isMoto = this.cfg.mode === 'moto';
    const cam = this.camera;
    const speedF = clamp(c.v / (this.spec.vTop + this.spec.vBonus), 0, 1);
    this.fovKick = Math.max(0, this.fovKick - dt * 0.8);
    this.shake = Math.max(0, this.shake - dt * 1.8);
    // Kerb and off-track rumble.
    if (c.surface === 'kerb') this.shake = Math.max(this.shake, 0.08 * speedF + 0.03);
    if (c.surface === 'grass' || c.surface === 'gravel') this.shake = Math.max(this.shake, 0.12 * speedF + 0.05);
    const sh = this.shake * this.shake;
    const jitter = new THREE.Vector3((Math.random() - 0.5) * sh * 0.5, (Math.random() - 0.5) * sh * 0.4, (Math.random() - 0.5) * sh * 0.3);
    let fov: number;
    if (this.phase === 'intro' && this.cfg.view !== 'onboard') {
      // Sweep from a front three-quarter view down behind the car.
      const k = clamp(this.phaseT / 3.4, 0, 1);
      const e = k * k * (3 - 2 * k);
      const ang = p.yaw + Math.PI * (0.85 - 0.85 * e) + 0.0001;
      const dist = isMoto ? 4.2 + (1 - e) * 4 : 6.4 + (1 - e) * 5;
      const hgt = (isMoto ? 1.6 : 2.0) + (1 - e) * 2.5;
      cam.position.set(p.pos.x - Math.sin(ang) * dist, p.pos.y + hgt, p.pos.z - Math.cos(ang) * dist);
      cam.up.set(0, 1, 0);
      cam.lookAt(p.pos.x, p.pos.y + 0.8, p.pos.z);
      fov = 55;
      this.camYaw = p.yaw;
      this.camInit = false;
    } else if (this.phase === 'finish' && this.finishedAt > 1.2) {
      const ang = p.yaw + now / 1000 * 0.35;
      const dist = isMoto ? 6 : 9;
      cam.position.set(p.pos.x - Math.sin(ang) * dist, p.pos.y + 2.6, p.pos.z - Math.cos(ang) * dist);
      cam.up.set(0, 1, 0);
      cam.lookAt(p.pos.x, p.pos.y + 0.7, p.pos.z);
      fov = 50;
    } else if (this.view === 'onboard') {
      const local = isMoto ? new THREE.Vector3(0, 1.24, 0.22) : new THREE.Vector3(0, 1.08, -0.3);
      const target = isMoto ? new THREE.Vector3(0, 1.05, 12) : new THREE.Vector3(0, 0.75, 12);
      const holder = isMoto ? p.view.body : p.view.root;
      holder.updateMatrixWorld(true);
      cam.position.copy(local.applyMatrix4(holder.matrixWorld)).add(jitter);
      const up = isMoto ? new THREE.Vector3(0, 1, 0).applyQuaternion(holder.getWorldQuaternion(new THREE.Quaternion())).lerp(new THREE.Vector3(0, 1, 0), 0.45).normalize() : new THREE.Vector3(0, 1, 0);
      cam.up.copy(up);
      cam.lookAt(target.applyMatrix4(holder.matrixWorld));
      fov = 66 + speedF * speedF * 14 + this.fovKick * 6;
    } else {
      if (!this.camInit) {
        this.camYaw = p.yaw;
        this.camInit = true;
      }
      // Yaw lags the car slightly so the car swings in the frame through corners.
      const yawRate = 3.2 + speedF * 2;
      this.camYaw += angDiff(p.yaw, this.camYaw) * Math.min(1, dt * yawRate);
      const fwd = new THREE.Vector3(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
      const dist = (isMoto ? 4.4 : 6.6) + speedF * (isMoto ? 0.6 : 0.9) - clamp(c.lon, -30, 15) * 0.012;
      const hgt = isMoto ? 1.75 : 2.15;
      const desired = new THREE.Vector3(p.pos.x - fwd.x * dist, p.pos.y + hgt, p.pos.z - fwd.z * dist);
      // Keep the camera above the road surface behind the car.
      const behindY = worldAt(this.t, c.p - dist, c.d, this.tmpV).y + hgt * 0.75;
      desired.y = Math.max(desired.y, behindY);
      this.camPos.lerp(desired, Math.min(1, dt * 12));
      if (this.camPos.distanceToSquared(desired) > 400) this.camPos.copy(desired);
      const look = new THREE.Vector3(p.pos.x + fwd.x * (isMoto ? 3.2 : 4), p.pos.y + (isMoto ? 0.85 : 0.6), p.pos.z + fwd.z * (isMoto ? 3.2 : 4));
      this.camLook.lerp(look, Math.min(1, dt * 14));
      if (this.camLook.distanceToSquared(look) > 400) this.camLook.copy(look);
      cam.position.copy(this.camPos).add(jitter);
      if (isMoto) {
        const roll = -p.leanVis * 0.32;
        cam.up.set(Math.sin(roll) * Math.cos(this.camYaw), Math.cos(roll), -Math.sin(roll) * Math.sin(this.camYaw));
      } else cam.up.set(0, 1, 0);
      cam.lookAt(this.camLook);
      fov = 58 + speedF * speedF * 17 + this.fovKick * 7;
    }
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov += (fov - cam.fov) * Math.min(1, dt * 4 + (this.phase === 'intro' ? 1 : 0));
      cam.updateProjectionMatrix();
    }
  }

  // ---- HUD & debug ------------------------------------------------------------------------------------

  private updateHud(now: number): void {
    const p = this.player;
    const c = p.car;
    const cfg = this.cfg;
    const L = this.t.length;
    const n = this.racers.length;
    const pos = this.positionOf(p);
    if (this.phase === 'race' && pos < this.lastPos && this.raceTime > 3) {
      // Overtake: reward clean passes with boost.
      if (this.raceTime - this.lastContact > 2) {
        this.boostMeter = Math.min(1, this.boostMeter + 0.22);
        this.audio.roar(0.25);
      }
      if (pos <= 3) this.hud.tip(`Up to <b>${ordinal(pos)}</b>!`, 1500);
    }
    if (this.phase === 'race') this.lastPos = pos;
    this.hud.position(pos, n);
    const lapNo = p.finished ? cfg.laps : lapOf(c.p, L);
    this.hud.lap(lapNo, cfg.laps);
    if (lapNo !== this.lapShown) this.lapShown = lapNo;
    const cur = this.phase === 'race' ? p.timer.current(this.raceTime) : p.finished ? p.timer.laps[p.timer.laps.length - 1] ?? 0 : 0;
    let delta: number | null = null;
    if (cfg.type === 'tt' && this.bestGhost && this.phase === 'race') {
      const g = this.bestGhost;
      const lapDist = c.p - p.timer.laps.length * L;
      let i = 0;
      while (i + 1 < g.dist.length && g.dist[i + 1] < lapDist) i++;
      if (i + 1 < g.dist.length && lapDist > 20) {
        const f = (lapDist - g.dist[i]) / Math.max(1e-3, g.dist[i + 1] - g.dist[i]);
        delta = cur - (i + clamp(f, 0, 1)) * 0.1;
      }
    }
    const best = Math.min(p.timer.best, cfg.type === 'tt' && this.bestGhost ? this.bestGhost.time : Infinity);
    this.hud.time(cur, best, delta);
    const rpmFrac = (p.gear.rpm - p.gear.idle) / (p.gear.redline - p.gear.idle);
    this.hud.speed(c.v * 3.6, this.phase === 'race' || this.phase === 'finish' ? p.gear.gear : 0, rpmFrac);
    if (cfg.mode === 'f1') this.hud.boost(c.boost > 0 ? c.boost / 4 : this.boostMeter, c.boost > 0);
    else this.hud.lean((p.leanVis * 180) / Math.PI, c.tuck);
    // Start lights in the HUD.
    if (this.phase === 'lights') this.hud.lights(this.litShown, true);
    else this.hud.lights(0, false);
    // Prompts.
    const ctl = this.ctl.c;
    if (this.phase === 'race' && !ctl.holding && ctl.lostFor > 0.5) this.hud.prompt(cfg.mode === 'f1' ? 'wheel' : 'rider', cfg.mode === 'f1' ? 'Grab the wheel!' : 'Step back into view');
    else if (this.phase === 'race' && this.wrongFor > 1.2) this.hud.prompt('wrong', 'Wrong way');
    else this.hud.prompt('');
    // Teaching tips in the first laps.
    if (this.phase === 'race') {
      const tt = this.raceTime;
      const tip = (id: string, text: string, ms = 4500) => {
        if (this.tipsShown.has(id)) return;
        this.tipsShown.add(id);
        this.hud.tip(text, ms);
      };
      if (cfg.mode === 'f1') {
        if (tt > 6) tip('brake', '<b>Brake</b>: lower both hands to your chest', 5000);
        if (this.boostMeter >= 1 && tt > 12) tip('boost', '<b>Boost ready</b>: push both hands up above your shoulders', 5000);
      } else {
        if (tt > 6) tip('tuck', '<b>Crouch</b> on the straights to tuck in for top speed', 5000);
        if (tt > 13) tip('brake', '<b>Brake</b>: stand tall and drop both hands to your hips', 5000);
      }
      if (this.offFor > 1.2) tip('grass', 'Stay on the asphalt: grass and gravel slow you down', 3500);
    }
    // Timing tower (4 Hz) and map (20 Hz).
    if (now - this.towerT > 250 && cfg.type === 'race') {
      this.towerT = now;
      const order = rankOrder(this.racers.map((x) => ({ p: x.car.p, finished: x.finished, finishTime: x.finishTime })));
      const leader = this.racers[order[0]];
      const rows: TowerRow[] = order.map((idx, k) => {
        const r = this.racers[idx];
        let gap = 'Leader';
        if (k > 0) {
          if (r.finished && leader.finished) gap = `+${(r.finishTime - leader.finishTime).toFixed(1)}`;
          else {
            const laps = Math.floor((leader.car.p - r.car.p) / L);
            gap = laps >= 1 ? `+${laps} lap` : `+${Math.max(0, this.gapTo(leader, r)).toFixed(1)}`;
          }
        }
        return { pos: k + 1, code: r.livery.code, color: r.livery.primary, gap, human: r.human };
      });
      this.hud.tower(rows);
    }
    if (now - this.hudT > 50) {
      this.hudT = now;
      const dots = this.racers.map((r) => ({ x: r.pos.x, z: r.pos.z, color: r.livery.primary, human: r.human }));
      if (this.ghostView?.root.visible) dots.push({ x: this.ghostView.root.position.x, z: this.ghostView.root.position.z, color: '#7fd8ff', human: false, ghost: true } as never);
      this.hud.drawMap(dots);
    }
    (window as unknown as { __gameDebug: unknown }).__gameDebug = {
      mode: cfg.mode,
      track: cfg.track,
      trackName: this.t.def.name,
      type: cfg.type,
      phase: this.phase,
      lap: lapNo,
      laps: cfg.laps,
      position: pos,
      speed: Math.round(c.v * 3.6),
      raceTime: Number(this.raceTime.toFixed(2)),
      offTrack: c.surface === 'grass' || c.surface === 'gravel',
      surface: c.surface,
      finished: p.finished,
      lapTimes: p.timer.laps.map((x) => Number(x.toFixed(2))),
      boost: Number(this.boostMeter.toFixed(2)),
      holding: this.ctl.c.holding,
      steer: Number(this.steer.value.toFixed(2)),
      fps: Math.round(this.fps),
      frames: this.frames,
      frameMs: Math.round(this.frameMs),
      calls: this.r3d.renderer.info.render.calls,
      tris: this.r3d.renderer.info.render.triangles,
      quality: this.r3d.currentLevel,
    };
  }

  // ---- pause / end ----------------------------------------------------------------------------------------

  private async pause(): Promise<void> {
    if (this.paused || this.ended) return;
    this.paused = true;
    await this.env.audio.pause();
    const act = await pauseMenu(this.el, this.env.cursor, [{ act: 'view', label: this.view === 'chase' ? 'Onboard camera' : 'Chase camera' }]);
    if (act === 'view') this.toggleView();
    if (act === 'resume' || act === 'view') {
      await this.env.audio.resume();
      this.paused = false;
      this.lastNow = performance.now();
      this.lastSim = performance.now();
      this.lastPoseT = performance.now();
      return;
    }
    await this.env.audio.resume();
    this.cleanup();
    this.resolve(act === 'restart' ? { kind: 'restart' } : { kind: 'quit' });
  }

  private end(): void {
    if (this.ended) return;
    const L = this.t.length;
    const cfg = this.cfg;
    // Estimate finishing times for cars still running.
    const standings: Standing[] = this.racers.map((r) => {
      let time = r.finishTime;
      if (!r.finished) {
        const remaining = cfg.laps * L - r.car.p;
        time = this.raceTime + remaining / Math.max(25, r.car.v * 0.9);
      }
      return { name: r.livery.name, code: r.livery.code, color: r.livery.primary, human: r.human, time, best: r.timer.best, finished: r.finished };
    });
    standings.sort((a, b) => a.time - b.time);
    const p = this.player;
    const position = cfg.type === 'tt' ? 1 : standings.findIndex((s) => s.human) + 1;
    const result: RaceResult = {
      cfg,
      trackName: this.t.def.name,
      position,
      total: p.finishTime,
      best: p.timer.best,
      laps: p.timer.laps.slice(),
      standings,
      ghost: cfg.type === 'tt' ? this.bestGhost : null,
    };
    this.cleanup();
    this.resolve({ kind: 'done', result });
  }

  private cleanup(): void {
    if (this.ended) return;
    this.ended = true;
    cancelAnimationFrame(this.raf);
    clearInterval(this.simTimer);
    window.removeEventListener('resize', this.onResize);
    this.audio.fade(0.3);
    const audio = this.audio;
    setTimeout(() => audio.stop(), 400);
    if (this.env.pose instanceof SimPose) this.env.pose.drive = () => ({ lWrist: { x: -0.75, y: -1.55 }, rWrist: { x: 0.75, y: -1.55 } });
    this.hud.dispose();
    for (const r of this.racers) r.view.dispose();
    this.ghostView?.dispose();
    this.smoke.dispose();
    this.sparks.dispose();
    this.skids.dispose();
    this.lines.dispose();
    this.world.dispose();
    this.r3d.dispose();
    this.el.remove();
  }
}

function fmt(s: number): string {
  if (!isFinite(s)) return '–';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(3).padStart(6, '0')}`;
}
export { fmt as fmtLap };
