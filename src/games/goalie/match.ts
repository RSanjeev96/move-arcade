/**
 * One Goalkeeper session (penalty shootout or rapid fire) running on the shared World: shooters, the ball,
 * the player's gloves, judging saves by capture time, reactions, slow motion, HUD, pause and the demo bot.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SwingDetector } from '../../core/gestures';
import { SimPose, SIM_REST, type SimParams } from '../../core/pose';
import { drawSkeleton } from '../../core/skeleton';
import type { V2 } from '../../core/types';
import { HandsUpPause, pauseMenu } from '../../ui/kit';
import type { GameEnv } from '../types';
import { Ball } from './ball';
import { Particles } from './fx';
import { Hud, type TeamInfo } from './hud';
import { KeeperAvatar } from './keeper';
import {
  BALL_R,
  GOAL,
  KEEPER_Z,
  PENALTY_SPOT,
  PROFILES,
  RAPID_SECONDS,
  RAPID_SPOTS,
  aiKeeper,
  aimError,
  aimFromHand,
  bodyToGoal,
  buildShot,
  deflect,
  goalToBody,
  isGreatSave,
  judgeSave,
  makeRng,
  makeShot,
  nextKicker,
  rapidGap,
  savePoints,
  shootoutWinner,
  shotPos,
  shotVel,
  streakMult,
  timeAtZ,
  woodworkBounce,
  type Contact,
  type Difficulty,
  type KeeperDive,
  type KeeperPose,
  type Mode,
  type Rng,
  type Shot,
  type Tally,
  type Vec3,
} from './logic';
import type { Footballer, Kit, Look, PeopleKit } from './people';
import { GoalieSound } from './sound';
import type { World } from './world';

export interface MatchConfig {
  mode: Mode;
  difficulty: Difficulty;
  ownKicks: boolean;
  seed: number;
}

export interface MatchResult {
  mode: Mode;
  difficulty: Difficulty;
  tally: Tally;
  points: number;
  won: boolean | null;
  home: boolean[];
  away: boolean[];
  homeTeam: TeamInfo;
  awayTeam: TeamInfo;
  snapshot: string;
}

export type MatchOutcome = { kind: 'done'; result: MatchResult } | { kind: 'quit' } | { kind: 'restart' };

// ---- teams ---------------------------------------------------------------------------------

interface Team extends TeamInfo {
  kit: Kit;
  keeper: Kit;
}

export const HOME: Team = {
  name: 'Arcade United',
  short: 'ARC',
  color: '#1f5bd8',
  color2: '#ffffff',
  kit: { shirt: '#1d4fc4', shirt2: '#ffffff', pattern: 'plain', shorts: '#f4f6fa', socks: '#1d4fc4', trim: '#ffffff', boots: '#111111' },
  keeper: { shirt: '#c6ff2e', shirt2: '#111111', pattern: 'plain', shorts: '#111111', socks: '#c6ff2e', trim: '#111111', boots: '#111111', keeper: true, gloves: '#ffffff' },
};

export const AWAY: Record<Difficulty, Team> = {
  easy: {
    name: 'Riverside Rovers',
    short: 'RIV',
    color: '#ff7a1a',
    color2: '#111111',
    kit: { shirt: '#ff7a1a', shirt2: '#111111', pattern: 'sash', shorts: '#111111', socks: '#ff7a1a', trim: '#111111', boots: '#f2f2f2' },
    keeper: { shirt: '#7a2cff', shirt2: '#ffffff', pattern: 'plain', shorts: '#2a1a4a', socks: '#7a2cff', trim: '#ffffff', boots: '#111111', keeper: true, gloves: '#f5f5f5' },
  },
  normal: {
    name: 'Real Valoria',
    short: 'VAL',
    color: '#d81b2c',
    color2: '#ffffff',
    kit: { shirt: '#d81b2c', shirt2: '#f4f4f4', pattern: 'stripes', shorts: '#141414', socks: '#d81b2c', trim: '#ffffff', boots: '#111111' },
    keeper: { shirt: '#1aa3a3', shirt2: '#111111', pattern: 'plain', shorts: '#111111', socks: '#1aa3a3', trim: '#111111', boots: '#111111', keeper: true, gloves: '#ffffff' },
  },
  hard: {
    name: 'Dynamo Kastell',
    short: 'DYN',
    color: '#ffd400',
    color2: '#111111',
    kit: { shirt: '#ffd400', shirt2: '#141414', pattern: 'hoops', shorts: '#141414', socks: '#141414', trim: '#ffd400', boots: '#ffd400' },
    keeper: { shirt: '#ff3d7f', shirt2: '#111111', pattern: 'plain', shorts: '#111111', socks: '#ff3d7f', trim: '#111111', boots: '#111111', keeper: true, gloves: '#ffffff' },
  },
};

const REF_KIT: Kit = { shirt: '#18191c', shirt2: '#18191c', pattern: 'plain', shorts: '#18191c', socks: '#18191c', trim: '#ffe14d', boots: '#111111' };
const HAIRS = ['#14100c', '#2a1c12', '#3b2716', '#5a3a1e', '#0b0b0b', '#7a5a34', '#191919'];
/** Fictional surnames for the lower third. */
const NAMES = ['Varela', 'Okonkwo', 'Lindgren', 'Moreau', 'Kaczmarek', 'Delgado', 'Haddad', 'Brennan', 'Sato', 'Petrov', 'Mendes', 'Ostrander', 'Quiroga', 'Nakamura', 'Duarte', 'Ferro', 'Kovač', 'Adeyemi', 'Rinaldi', 'Castell'];

// ---- tuning --------------------------------------------------------------------------------

/** Pose frames up to this long before/after the ball reaches the keeper still count (capture time). */
const EARLY_MS = 210;
const LATE_MS = 110;
/** Give up waiting for tracking after this long past the crossing. */
const WAIT_MS = 380;

const KEEPER_CAM = { pos: new THREE.Vector3(0, 1.95, 5.6), look: new THREE.Vector3(0, 0.95, -9), hfov: 78 };
// Looking up the pitch toward +z: screen right is -x, so the taker (who runs in from +x) shows on the left.
const SHOOTER_CAM = { pos: new THREE.Vector3(-0.6, 1.95, -19.4), look: new THREE.Vector3(0.15, 1.1, 0), hfov: 45 };

interface HistoryEntry {
  t: number;
  kp: KeeperPose;
}

type IncState = 'wait' | 'run' | 'flight' | 'pending' | 'toLine' | 'after' | 'done';

interface Shooter {
  p: Footballer;
  /** Where the ball sits for this shooter. */
  spot: THREE.Vector3;
  ball: Ball;
  home: THREE.Vector3;
  busy: boolean;
  /** Back-pedal after the shot: from, to, start, duration (sim). */
  walk: { from: THREE.Vector3; to: THREE.Vector3; t0: number; dur: number } | null;
  celebrate: { t0: number; dir: THREE.Vector3; kind: 'sprint' | 'fist' | 'sad' } | null;
}

interface Incoming {
  shot: Shot;
  sh: Shooter;
  runFrom: THREE.Vector3;
  plant: THREE.Vector3;
  runYaw: number;
  kickYaw: number;
  runStart: number;
  runDur: number;
  stutter: boolean;
  kickAt: number;
  /** Shot time when the ball reaches the keeper plane. */
  tc: number;
  state: IncState;
  crossReal: number;
  crossBall: V2;
  resolvedAt: number;
  result: 's' | 'g' | 'm' | null;
  contact: Contact | null;
  great: boolean;
  held: boolean;
  first: boolean;
  whooshed: boolean;
  /** For the player's own penalty: the AI keeper's plan. */
  dive?: KeeperDive;
  mine?: boolean;
}

interface BotPlan {
  inc: Incoming;
  t0: number;
  arrive: number;
  from: [V2, V2];
  to: [V2, V2];
}

const ease = (x: number) => {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
};
const easeOut = (x: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);

export class Match {
  private hud!: Hud;
  private sound: GoalieSound;
  private rng: Rng;
  private keeper: KeeperAvatar;
  private sparks = new Particles(260, true);
  private turf = new Particles(160, false);
  private confetti = new Particles(900, false, true);
  private group = new THREE.Group();
  private shooters: Shooter[] = [];
  private homeShooter: Shooter | null = null;
  private aiKeeper: Footballer | null = null;
  private referee: Footballer | null = null;
  private lineup: { p: Footballer; team: 'home' | 'away'; react: number; kind: string }[] = [];
  private reticle: THREE.Mesh;
  private reticleMat: THREE.MeshBasicMaterial;
  private profile;
  private away: Team;

  // time
  private simT = 0;
  private scale = 1;
  private slowUntil = 0;
  private slowLevel = 1;
  private timers: { at: number; fn: () => void }[] = [];
  private paused = false;
  private finished = false;
  private resolve!: (o: MatchOutcome) => void;

  // input
  private lastPoseT = 0;
  private history: HistoryEntry[] = [];
  private latestKP: KeeperPose | null = null;
  private lastSeen = 0;
  private handsUp = new HandsUpPause();
  private swing = new SwingDetector(5.5, 2.5);
  private swingFired = 0;
  private aimHist: { t: number; x: number; y: number }[] = [];

  // play state
  private inc: Incoming | null = null;
  private cam = 'intro';
  private shake = 0;
  private zoomAt: THREE.Vector3 | null = null;
  private zoom = 0;
  private tally: Tally = { shots: 0, saves: 0, goals: 0, misses: 0, catches: 0, great: 0, bestStreak: 0 };
  private streak = 0;
  private points = 0;
  private homePens: boolean[] = [];
  private awayPens: boolean[] = [];
  private strip: ('s' | 'g' | 'm')[] = [];
  private timeLeft = RAPID_SECONDS;
  private rapidOn = false;
  private nextShotAt = 0;
  private lastShooter = -1;
  private shotId = 0;
  private tutorialDone = false;
  private myKick: { phase: 'aim' | 'run' | 'done'; t0: number; aim: { x: number; y: number }; auto: boolean; botTarget: { x: number; y: number } } | null = null;
  private excHome = 0;
  private excAway = 0;
  private waveT = -1000;
  private botPlan: BotPlan | null = null;
  private lastNow = 0;
  private botAim: { x: number; y: number; swingAt: number } | null = null;
  private previewT = 0;
  private won: boolean | null = null;
  private heldBall: { ball: Ball; until: number } | null = null;

  constructor(
    private env: GameEnv,
    private host: HTMLElement,
    private world: World,
    private people: PeopleKit,
    private cfg: MatchConfig,
  ) {
    this.rng = makeRng(cfg.seed);
    this.profile = PROFILES[cfg.difficulty];
    this.away = AWAY[cfg.difficulty];
    this.sound = new GoalieSound(env.audio);
    this.keeper = new KeeperAvatar({ main: '#ffffff', accent: HOME.keeper.shirt, body: HOME.keeper.shirt });
    this.reticleMat = new THREE.MeshBasicMaterial({ color: 0x3bffb4, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false, side: THREE.DoubleSide });
    // Aim marker: a ring with four ticks.
    const ring = new THREE.RingGeometry(0.3, 0.4, 48).toNonIndexed();
    const ticks = [0, 1, 2, 3].map((i) => {
      const t = new THREE.PlaneGeometry(0.06, 0.2);
      t.translate(0, 0.52, 0);
      t.rotateZ((i * Math.PI) / 2);
      return t.toNonIndexed();
    });
    this.reticle = new THREE.Mesh(mergeGeometries([ring, ...ticks]), this.reticleMat);
    this.reticle.renderOrder = 10;
    this.reticle.visible = false;
  }

  run(): Promise<MatchOutcome> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.build();
      this.hud.el.style.visibility = 'hidden';
      // Precompile everything this match can show (hidden players included) before play starts.
      const hidden: THREE.Object3D[] = [];
      this.group.traverse((o) => {
        if (!o.visible) {
          hidden.push(o);
          o.visible = true;
        }
      });
      void this.world.compile().then(() => {
        for (const o of hidden) o.visible = false;
        this.hud.el.style.visibility = '';
        this.world.start();
        this.begin();
      });
    });
  }

  // ---- setup --------------------------------------------------------------------------------

  private look(): Look {
    return { number: 2 + Math.floor(this.rng() * 22), skin: this.rng() * this.rng(), hair: HAIRS[Math.floor(this.rng() * HAIRS.length)] };
  }

  private build(): void {
    const w = this.world;
    const st = w.stadium;
    this.hud = new Hud(this.host, this.cfg.mode, HOME, this.away, this.cfg.difficulty);
    this.hud.cam.style.display = this.env.settings.showCamera ? '' : 'none';
    this.hud.pauseBtn.addEventListener('click', () => void this.pause());
    w.scene.add(this.group);
    this.group.add(this.keeper.group, this.sparks.points, this.turf.points, this.confetti.points, this.reticle);
    const vh = w.renderer.getDrawingBufferSize(new THREE.Vector2()).y;
    for (const p of [this.sparks, this.turf, this.confetti]) p.setViewportHeight(vh);
    st.crowd.uniforms.uHomeA.value.set(HOME.color);
    st.crowd.uniforms.uHomeB.value.set(HOME.color2);
    st.crowd.uniforms.uAwayA.value.set(this.away.color);
    st.crowd.uniforms.uAwayB.value.set(this.away.color2);

    const mkShooter = (spot: THREE.Vector3, kit: Kit, lod = true): Shooter => {
      const p = this.people.make(kit, this.look(), { lod });
      const ball = new Ball();
      ball.place(spot);
      this.wireBall(ball);
      this.group.add(p.root, ball.group);
      p.play('Idle_Loop', 0, { at: this.rng() });
      return { p, spot: spot.clone(), ball, home: spot.clone(), busy: false, walk: null, celebrate: null };
    };
    if (this.cfg.mode === 'shootout') {
      const spot = new THREE.Vector3(PENALTY_SPOT.x, PENALTY_SPOT.y, PENALTY_SPOT.z);
      this.shooters.push(mkShooter(spot, this.away.kit));
      this.homeShooter = mkShooter(spot, HOME.kit, false);
      this.homeShooter.ball.setVisible(false);
      this.homeShooter.p.setVisible(false);
      this.aiKeeper = this.people.make(this.away.keeper, this.look(), { lod: true });
      this.aiKeeper.root.position.set(0, 0, -0.15);
      this.aiKeeper.root.rotation.y = Math.PI;
      this.aiKeeper.play('Idle_Loop', 0);
      this.aiKeeper.setVisible(false);
      this.group.add(this.aiKeeper.root);
      // Team mates watch from the centre circle.
      const perTeam = this.world.light ? 2 : 5;
      for (const [team, z, kit] of [
        ['home', -48.6, HOME.kit],
        ['away', -50.2, this.away.kit],
      ] as const) {
        for (let i = 0; i < perTeam; i++) {
          const p = this.people.make(kit, this.look(), { lod: true });
          p.root.position.set(-3.2 + i * 1.6 + (team === 'away' ? 0.8 : 0), 0, z);
          p.root.rotation.y = (this.rng() - 0.5) * 0.3;
          p.root.traverse((o) => ((o as THREE.Mesh).castShadow = false));
          p.play(i % 2 ? 'Idle_FoldArms_Loop' : 'Idle_Loop', 0, { at: this.rng() });
          this.group.add(p.root);
          this.lineup.push({ p, team, react: 0, kind: '' });
        }
      }
    } else {
      for (const s of RAPID_SPOTS) this.shooters.push(mkShooter(new THREE.Vector3(s.x, s.y, s.z), this.away.kit));
    }
    for (const s of this.shooters) this.placeAtRunStart(s, this.runPath(s.spot, this.cfg.mode === 'rapid' ? 1.9 : 4.2).from, s.spot);
    this.referee = this.people.make(REF_KIT, { number: 0, skin: 0.4, hair: '#111' }, { lod: true });
    this.referee.root.position.set(-7.5, 0, -13.5);
    this.referee.root.rotation.y = 0.9;
    this.referee.play('Idle_Loop', 0);
    this.group.add(this.referee.root);
    this.keeper.setVisible(true);

    if (this.env.demo && this.env.pose instanceof SimPose) {
      // The bot is evaluated at each simulated camera frame (real time), so it stays smooth even when
      // rendering is slow (headless tests).
      this.env.pose.drive = (tMs) => this.botPoseAt(this.simAt(tMs));
    }
    // Profiling aid: ?gkoff=crowd,people,stands,pitch,net
    const off = (this.env.params.get('gkoff') ?? '').split(',');
    if (off.includes('people')) for (const l of this.lineup) l.p.setVisible(false);
    if (off.includes('crowd')) st.crowd.mesh.visible = false;
    if (off.includes('net')) st.near.group.visible = false;
    if (off.includes('pitch')) st.group.children.forEach((c) => { if ((c as THREE.Mesh).geometry?.type === 'PlaneGeometry' && ((c as THREE.Mesh).geometry as THREE.PlaneGeometry).parameters?.width === 150) c.visible = false; });
    if (off.includes('env')) w.scene.environment = null;
    if (off.includes('keeper')) this.keeper.group.visible = false;
    if (off.includes('boards')) st.boards.mesh.visible = false;
    if (off.includes('stands')) st.group.children.forEach((c) => { if ((c as THREE.Mesh).geometry?.getAttribute?.('color')) c.visible = false; });
    window.addEventListener('keydown', this.onKey);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' || e.key === 'p') void this.pause();
  };

  private wireBall(ball: Ball): void {
    ball.onBounce = (s) => this.sound.bounce(s, ball.pos.x / 6);
    ball.onNet = (p, s) => {
      this.world.stadium.near.hit(p, Math.min(0.55, 0.15 + s * 0.025), this.simT);
      this.sound.net(Math.min(1.2, 0.4 + s / 18), p.x / 4);
      this.shake = Math.max(this.shake, 0.12);
    };
  }

  /** Run-up path for a right-footed taker: from behind and to his left, toward the plant spot. */
  private runPath(spot: THREE.Vector3, len: number): { from: THREE.Vector3; plant: THREE.Vector3; yaw: number; shotYaw: number } {
    const toGoal = new THREE.Vector3(-spot.x, 0, -spot.z).normalize();
    const shotYaw = Math.atan2(toGoal.x, toGoal.z);
    const runYaw = shotYaw - 0.5;
    const dir = new THREE.Vector3(Math.sin(runYaw), 0, Math.cos(runYaw));
    // Plant foot beside the ball (his left, +x when facing +z) and slightly behind.
    const left = new THREE.Vector3(Math.cos(shotYaw), 0, -Math.sin(shotYaw));
    const plant = spot.clone().addScaledVector(left, 0.16).addScaledVector(toGoal, -0.32);
    plant.y = 0;
    const from = plant.clone().addScaledVector(dir, -len);
    return { from, plant, yaw: runYaw, shotYaw };
  }

  private placeAtRunStart(s: Shooter, from: THREE.Vector3, spot: THREE.Vector3): void {
    s.p.root.position.copy(from);
    s.p.root.rotation.y = Math.atan2(spot.x - from.x, spot.z - from.z);
    s.home = from.clone();
  }

  private begin(): void {
    const a = this.env.audio;
    a.music.gain.value = this.env.settings.musicVolume;
    a.sfx.gain.value = this.env.settings.sfxVolume;
    this.sound.startCrowd();
    this.sound.setExcitement(0.35);
    this.env.cursor(false);
    this.lastPoseT = performance.now();
    this.world.step = (dt, now) => this.frame(dt, now);
    this.cam = 'intro';
    this.waveT = 0;
    if (this.cfg.mode === 'shootout') {
      this.hud.title('Penalty shootout', `${HOME.short}  vs  ${this.away.short}`, `${HOME.name} · ${this.away.name}`, 3000);
      this.at(3.4, () => this.nextKick());
    } else {
      this.hud.title('Rapid fire', '60 seconds', 'Save as many as you can', 2600);
      this.at(3.2, () => {
        this.cam = 'keeper';
        this.promptNow(this.tutorialHtml());
      });
      for (const [t, n] of [
        [3.0, '3'],
        [3.8, '2'],
        [4.6, '1'],
      ] as const)
        this.at(t, () => {
          this.banner(n, '', 'info', 650);
          this.sound.tick(false);
        });
      this.at(5.4, () => {
        this.banner('GO!', '', 'save', 700);
        this.sound.whistle('long');
        this.rapidOn = true;
        this.nextShotAt = this.simT + 0.4;
      });
    }
  }

  private tutorialHtml(): string {
    return `<div class="gk-tut"><i class="ic-hands"></i><b>Move your hands where the ball goes</b></div><div class="gk-tut"><i class="ic-lean"></i><b>Lean or step to dive</b></div>`;
  }

  private bannerId = 0;
  /** Banners and timed prompts live in simulation time (they stay up through slow motion). */
  private banner(text: string, sub: string, tone: Parameters<Hud['banner']>[2], ms: number): void {
    const id = ++this.bannerId;
    this.hud.banner(text, sub, tone, 0);
    this.at(ms / 1000, () => id === this.bannerId && this.hud.hideBanner());
  }

  private promptId = 0;
  private promptNow(html: string): void {
    ++this.promptId;
    this.hud.prompt(html);
  }

  private prompt(html: string, ms: number): void {
    const id = ++this.promptId;
    this.hud.prompt(html, 0);
    this.at(ms / 1000, () => id === this.promptId && this.hud.prompt(''));
  }

  private at(delay: number, fn: () => void): void {
    this.timers.push({ at: this.simT + delay, fn });
  }

  // ---- main loop ---------------------------------------------------------------------------

  private frames = 0;
  private begunAt = 0;

  private frame(dt: number, now: number): void {
    const realDt = dt;
    this.frames++;
    if (!this.begunAt) this.begunAt = now;
    if (!this.paused) {
      this.updateScale(realDt, now);
      const sdt = realDt * this.scale;
      this.simT += sdt;
      this.lastNow = now;
      this.processPose(now);
      this.runTimers();
      this.updatePlay(sdt, now);
      this.updateActors(sdt);
      this.sparks.update(sdt);
      this.turf.update(sdt);
      this.confetti.update(sdt);
      this.updateCrowd(realDt);
      this.sound.update(realDt, !this.inc || this.inc.state === 'done' || this.inc.state === 'wait');
    }
    this.updateKeeperView(realDt);
    this.updateCamera(realDt, now);
    this.world.stadium.update(realDt, now / 1000);
    for (const b of this.balls()) b.visuals(this.paused ? 0 : realDt * this.scale, this.world.camera.position);
    this.updateHud(now);
    this.drawPreview(now);
    this.publishDebug();
  }

  private balls(): Ball[] {
    const out = this.shooters.map((s) => s.ball);
    if (this.homeShooter) out.push(this.homeShooter.ball);
    return out;
  }

  private runTimers(): void {
    if (!this.timers.length) return;
    const due = this.timers.filter((t) => t.at <= this.simT);
    if (!due.length) return;
    this.timers = this.timers.filter((t) => t.at > this.simT);
    for (const t of due) t.fn();
  }

  /** Slow motion: near the keeper (bullet time + room for tracking latency) and on great saves. */
  private updateScale(dt: number, now: number): void {
    let target = 1;
    const inc = this.inc;
    if (inc && !inc.mine) {
      if (inc.state === 'flight') {
        const p = shotPos(inc.shot, this.simT - inc.kickAt);
        const dist = KEEPER_Z - p.z;
        // Rapid fire keeps the pace up with a lighter slow-down.
        const ls = this.cfg.mode === 'rapid' ? Math.max(0.6, this.profile.lineSlow) : this.profile.lineSlow;
        if (dist < 2.2) target = ls + (1 - ls) * Math.max(0, dist / 2.2);
      } else if (inc.state === 'pending') target = Math.min(this.profile.lineSlow, 0.22);
    }
    if (now < this.slowUntil) target = Math.min(target, this.slowLevel);
    const k = target < this.scale ? 1 : Math.min(1, dt * 3.5);
    this.scale += (target - this.scale) * k;
    this.world.slow += ((now < this.slowUntil ? 1 : 0) - this.world.slow) * Math.min(1, dt * 5);
  }

  // ---- input -------------------------------------------------------------------------------

  private processPose(now: number): void {
    const frames = this.env.pose.since(this.lastPoseT);
    const calib = this.env.body.calib;
    const torsoRatio = calib ? calib.torso / calib.sw : 1.5;
    for (const f of frames) {
      this.lastPoseT = f.t;
      const b = this.env.body.measure(f);
      if (!b.ok) continue;
      this.lastSeen = now;
      const kp = bodyToGoal(b, torsoRatio);
      this.latestKP = kp;
      this.history.push({ t: f.t, kp });
      this.swing.update(b);
      if (this.myKick?.phase === 'aim') {
        const hand = b.rWrist.y >= b.lWrist.y ? b.rWrist : b.lWrist;
        const a = aimFromHand(hand, b.lean);
        this.aimHist.push({ t: f.t, x: a.x, y: a.y });
        if (this.aimHist.length > 40) this.aimHist.shift();
        // Kick: a knee lifted toward the hips.
        if (b.full && (b.lKnee.y > b.hip.y - 0.75 || b.rKnee.y > b.hip.y - 0.75)) this.triggerMyKick(f.t);
      }
      // Hands up to pause only between shots (raising both hands is also how you reach the crossbar).
      if (!this.env.demo) {
        if (!this.canPause()) this.handsUp = new HandsUpPause();
        else if (this.handsUp.update(b, f.t)) void this.pause();
      }
    }
    while (this.history.length && this.history[0].t < now - 2500) this.history.shift();
  }

  private canPause(): boolean {
    if (this.finished || this.paused) return false;
    if (this.myKick && this.myKick.phase === 'aim') return false;
    return !this.inc || this.inc.state === 'wait' || this.inc.state === 'done';
  }

  // ---- play ----------------------------------------------------------------------------------

  private updatePlay(dt: number, now: number): void {
    const hb = this.heldBall;
    if (hb) {
      const kp = this.latestKP;
      if (kp && this.simT < hb.until) {
        hb.ball.pos.set((kp.l.x + kp.r.x) / 2, (kp.l.y + kp.r.y) / 2 + 0.02, KEEPER_Z - 0.12);
        hb.ball.vel.set(0, 0, 0);
        hb.ball.spin.multiplyScalar(0.9);
      } else {
        // Throw it away to the side.
        hb.ball.free = true;
        hb.ball.vel.set(this.rng() < 0.5 ? -3.5 : 3.5, 2.5, -5);
        this.heldBall = null;
      }
    }
    if (this.cfg.mode === 'rapid') this.updateRapid(dt);
    if (this.myKick) this.updateMyKick(now);
    if (this.inc) this.updateIncoming(this.inc, dt, now);
    for (const b of this.balls()) {
      b.physics(dt);
      if (b.inGoal) this.world.stadium.near.push(b.netPress ? b.netPress.p : null, b.netPress ? b.netPress.depth : 0);
    }
  }

  private updateRapid(dt: number): void {
    if (!this.rapidOn) return;
    this.timeLeft = Math.max(0, this.timeLeft - dt);
    if (this.timeLeft <= 0 && !this.finished && (!this.inc || this.inc.state === 'done' || this.inc.state === 'after' || this.inc.state === 'wait')) {
      if (this.inc && this.inc.state === 'wait') {
        this.inc.sh.busy = false;
        this.inc = null;
      }
      this.rapidOn = false;
      this.endRapid();
      return;
    }
    if (this.timeLeft <= 0) return;
    if (!this.inc && this.simT >= this.nextShotAt) {
      const ready = this.shooters.map((s, i) => ({ s, i })).filter((x) => !x.s.busy && !x.s.walk && x.i !== this.lastShooter);
      if (!ready.length) return;
      const pick = ready[Math.floor(this.rng() * ready.length)];
      this.lastShooter = pick.i;
      this.launch(pick.s, (RAPID_SECONDS - this.timeLeft) / RAPID_SECONDS, 0.1, 1.9);
    }
  }

  /** A shooter starts his run-up toward his ball; the shot is decided now. */
  private launch(sh: Shooter, progress: number, delay: number, runLen: number): Incoming {
    const first = !this.tutorialDone;
    const from = { x: sh.spot.x, y: BALL_R, z: sh.spot.z };
    let shot = makeShot(this.rng, this.cfg.difficulty, progress, from, ++this.shotId);
    if (first) {
      // A friendly first shot: mid height, not in the corner, a bit slower.
      const side = this.rng() < 0.5 ? -1 : 1;
      shot = buildShot(shot.id, from, { x: side * 1.4, y: 1.15 }, shot.T * 1.25, { kind: 'placed', tellYaw: side * this.profile.tell });
    }
    const path = this.runPath(sh.spot, runLen);
    const runDur = runLen / 3.6 + (shot.stutter ? 0.45 : 0);
    const runStart = this.simT + delay;
    const tc = timeAtZ(shot, KEEPER_Z);
    const inc: Incoming = {
      shot,
      sh,
      runFrom: path.from,
      plant: path.plant,
      runYaw: path.yaw,
      kickYaw: path.shotYaw + shot.tellYaw,
      runStart,
      runDur,
      stutter: shot.stutter,
      kickAt: runStart + runDur,
      tc,
      state: 'wait',
      crossReal: 0,
      crossBall: { x: 0, y: 0 },
      resolvedAt: 0,
      result: null,
      contact: null,
      great: false,
      held: false,
      first,
      whooshed: false,
    };
    sh.busy = true;
    sh.walk = null;
    sh.celebrate = null;
    sh.ball.place(sh.spot);
    sh.ball.setVisible(true);
    sh.p.root.position.copy(path.from);
    sh.p.root.rotation.y = path.yaw;
    this.inc = inc;
    this.botPlan = this.env.demo ? this.planBot(inc) : null;
    return inc;
  }

  private updateIncoming(inc: Incoming, dt: number, now: number): void {
    const t = this.simT;
    const sh = inc.sh;
    const p = sh.p;
    const ball = sh.ball;
    if (inc.state === 'wait' && t >= inc.runStart) {
      inc.state = 'run';
      p.play('Jog_Fwd_Loop', 0.2, { speed: 1.1 });
      if (!inc.mine) this.sound.swell(inc.runDur + 0.2);
    }
    if (inc.state === 'run' || (inc.state !== 'wait' && t < inc.kickAt + 0.9)) {
      // Run-up: along the path, optional stutter, turn into the strike.
      const k = (t - inc.runStart) / inc.runDur;
      let s = Math.min(1, Math.max(0, k));
      if (inc.stutter) {
        // Slow almost to a stop around 60% of the way, then go.
        const a = 0.45;
        const b = 0.75;
        s = s < a ? (s / a) * 0.62 : s < b ? 0.62 + ((s - a) / (b - a)) * 0.06 : 0.68 + ((s - b) / (1 - b)) * 0.32;
        if (k > a && k < b) p.speed(0.25);
        else if (inc.state === 'run') p.speed(1.1);
      }
      if (t <= inc.kickAt) {
        p.root.position.lerpVectors(inc.runFrom, inc.plant, s);
        const turn = ease((t - (inc.kickAt - 0.32)) / 0.3);
        p.root.rotation.y = inc.runYaw + (inc.kickYaw - inc.runYaw) * turn;
      } else {
        // Follow through: a step forward.
        const f = easeOut((t - inc.kickAt) / 0.6);
        const fwd = new THREE.Vector3(Math.sin(inc.kickYaw), 0, Math.cos(inc.kickYaw));
        p.root.position.copy(inc.plant).addScaledVector(fwd, f * 0.45);
      }
      if (t >= inc.kickAt - 0.42 && t <= inc.kickAt + 1.0) {
        p.kickT = t - inc.kickAt;
        if (p.currentName === 'Jog_Fwd_Loop' && t >= inc.kickAt - 0.3) p.play('Idle_Loop', 0.25);
      } else if (t > inc.kickAt + 1.0) p.kickT = null;
    }
    if (inc.state === 'run' && t >= inc.kickAt) {
      inc.state = 'flight';
      if (!inc.mine) this.tally.shots++;
      const v = shotVel(inc.shot, 0);
      ball.vel.set(v.x, v.y, v.z);
      ball.spin.set(inc.shot.spin.x, inc.shot.spin.y, inc.shot.spin.z);
      ball.trailStrength = 1;
      this.sound.kick(1, inc.shot.from.x / 10);
      this.turf.burst(new THREE.Vector3(inc.shot.from.x, 0.05, inc.shot.from.z), 14, { color: () => new THREE.Color().setHSL(0.27 + this.rng() * 0.05, 0.6, 0.18 + this.rng() * 0.12), speed: 2.2, up: 1.5, dir: new THREE.Vector3(0, 0.5, 1), grav: 9, life: 0.8, size: 0.035 });
      p.lookAt = ball.pos;
      p.lookWeight = 0.8;
      if (inc.mine && inc.dive && this.aiKeeper) {
        this.aiKeeper.root.position.x = 0;
        this.aiKeeper.startDive(inc.dive.side, new THREE.Vector3(inc.dive.reach.x, inc.dive.reach.y, -0.25));
      }
    }
    if (inc.state === 'flight' || inc.state === 'pending' || inc.state === 'toLine') {
      const tau = t - inc.kickAt;
      const pos = shotPos(inc.shot, tau);
      ball.pos.set(pos.x, pos.y, pos.z);
      const v = shotVel(inc.shot, tau);
      ball.vel.set(v.x, v.y, v.z);
      const remaining = (inc.tc - tau) / Math.max(0.05, this.scale);
      if (!inc.whooshed && remaining < 0.45 && !inc.mine) {
        inc.whooshed = true;
        this.sound.whoosh(Math.max(0.15, remaining), pos.x / 4, 1);
      }
      if (inc.state === 'flight' && tau >= inc.tc) {
        const c = shotPos(inc.shot, inc.tc);
        inc.crossBall = { x: c.x, y: c.y };
        // Real time of the crossing: back off the part of this frame after it.
        inc.crossReal = now - ((tau - inc.tc) / Math.max(0.05, this.scale)) * 1000;
        if (inc.mine) this.resolveMine(inc);
        else inc.state = 'pending';
      }
      if (inc.state === 'pending') {
        const contact = this.judge(inc);
        const latest = this.history.length ? this.history[this.history.length - 1].t : 0;
        if (contact) this.resolveSave(inc, contact, now);
        else if (latest >= inc.crossReal + LATE_MS || now > inc.crossReal + LATE_MS + WAIT_MS) {
          inc.state = 'toLine';
          inc.resolvedAt = t;
        }
      }
      if (inc.state === 'toLine' && pos.z >= -BALL_R * 0.2) this.atGoalLine(inc);
    }
    if (t > inc.kickAt + 1.0 && inc.state !== 'wait' && inc.state !== 'run') p.kickT = null;
    if (inc.state === 'after' && t - inc.resolvedAt > (this.cfg.mode === 'rapid' ? 0.35 : 2.6)) this.finishIncoming(inc);
  }

  /** Best glove/body contact among pose frames captured around the crossing. */
  private judge(inc: Incoming): Contact | null {
    let best: Contact | null = null;
    const rankOf = (c: Contact) => (c.kind === 'catch' ? 3 : c.kind === 'parry' || c.kind === 'tip' ? 2 : 1);
    for (const h of this.history) {
      if (h.t < inc.crossReal - EARLY_MS || h.t > inc.crossReal + LATE_MS) continue;
      const c = judgeSave(h.kp, inc.crossBall);
      if (c.kind === 'none') continue;
      if (!best || rankOf(c) > rankOf(best) || (rankOf(c) === rankOf(best) && c.dist < best.dist)) best = c;
    }
    return best;
  }

  private resolveSave(inc: Incoming, c: Contact, now: number): void {
    const ball = inc.sh.ball;
    const kp = this.latestKP ?? this.history[this.history.length - 1]?.kp;
    inc.state = 'after';
    inc.resolvedAt = this.simT;
    inc.result = 's';
    inc.contact = c;
    inc.great = !!kp && isGreatSave(c, inc.crossBall, kp);
    this.tutorialDone = true;
    this.tally.saves++;
    if (c.kind === 'catch') this.tally.catches++;
    if (inc.great) this.tally.great++;
    this.streak++;
    this.tally.bestStreak = Math.max(this.tally.bestStreak, this.streak);
    this.points += savePoints(c.kind, inc.great, this.streak);
    this.strip.push('s');
    const at = new THREE.Vector3(inc.crossBall.x, inc.crossBall.y, KEEPER_Z);
    const v = shotVel(inc.shot, this.simT - inc.kickAt);
    if (c.kind === 'catch') {
      inc.held = true;
      this.heldBall = { ball, until: this.simT + 1.2 };
      ball.free = false;
      ball.trailStrength = 0;
      this.sound.catchBall(at.x / 4);
    } else {
      const nv = deflect(c, { x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, v, this.rng);
      ball.free = true;
      ball.inGoal = false;
      ball.vel.set(nv.x, nv.y, nv.z);
      ball.spin.set((this.rng() - 0.5) * 30, (this.rng() - 0.5) * 30, (this.rng() - 0.5) * 30);
      this.sound.glove(c.kind === 'block' ? 0.7 : 1, at.x / 4);
    }
    this.keeper.punch(c.hand);
    this.sparks.burst(at, inc.great ? 46 : 26, { color: () => new THREE.Color().setHSL(0.12 + this.rng() * 0.05, 1, 0.75 + this.rng() * 0.25), speed: 4.5, dir: new THREE.Vector3(c.n.x, c.n.y, -0.6), spread: 1.2, life: 0.45, size: 0.05, grav: 2 });
    this.shake = Math.max(this.shake, inc.great ? 0.35 : 0.2);
    this.world.flash = inc.great ? 0.55 : 0.3;
    this.world.flashColor.set(inc.great ? 0xfff2c0 : 0xffffff);
    const label = inc.great ? 'WHAT A SAVE!' : c.kind === 'catch' ? 'CAUGHT!' : c.kind === 'tip' ? 'FINGERTIPS!' : c.kind === 'parry' ? 'PARRIED!' : 'BLOCKED!';
    const sub = inc.great ? `+${savePoints(c.kind, true, this.streak)}` : this.streak >= 3 ? `${this.streak} in a row` : 'SAVE!';
    this.banner(label, sub, inc.great ? 'great' : 'save', inc.great ? 2200 : 1400);
    if (inc.great) {
      this.slowUntil = now + 1100;
      this.slowLevel = 0.18;
      this.zoomAt = at.clone();
    }
    this.sound.roar(inc.great ? 1.25 : 0.9);
    this.excHome = 1;
    this.world.stadium.boards.flash('save');
    this.at(1.8, () => this.world.stadium.boards.flash(null));
    this.flashScreen('SAVE!');
    if (inc.first) this.prompt('<div class="gk-tut good"><b>Great save!</b><span>Keep your hands where the ball is heading</span></div>', 2200);
    else this.promptNow('');
    this.react(inc, 'save');
  }

  /** No save: the ball reaches the goal line. */
  private atGoalLine(inc: Incoming): void {
    if (inc.mine) {
      this.atGoalLineMine(inc);
      return;
    }
    const ball = inc.sh.ball;
    const s = inc.shot;
    const v = shotVel(s, this.simT - inc.kickAt);
    inc.state = 'after';
    inc.resolvedAt = this.simT;
    ball.free = true;
    let goal = false;
    if (s.wood) {
      const wb = woodworkBounce(s, v, this.rng);
      ball.vel.set(wb.v.x, wb.v.y, wb.v.z);
      ball.pos.z = -BALL_R;
      this.sound.post(s.target.x / 4);
      this.shake = Math.max(this.shake, 0.18);
      goal = wb.inGoal;
      if (goal) ball.inGoal = true;
      if (!goal) {
        this.banner(s.wood === 'bar' ? 'OFF THE BAR!' : 'OFF THE POST!', 'Lucky escape', 'miss', 1600);
        this.sound.ooh();
      }
    } else if (s.onTarget) {
      goal = true;
      ball.vel.set(v.x, v.y, v.z);
      ball.inGoal = true;
    } else {
      ball.vel.set(v.x, v.y, v.z);
      this.banner(s.target.y > GOAL.h ? 'OVER THE BAR!' : 'WIDE!', 'Missed the target', 'miss', 1500);
      this.sound.ooh();
    }
    this.tutorialDone = true;
    if (goal) {
      inc.result = 'g';
      this.tally.goals++;
      this.streak = 0;
      this.strip.push('g');
      this.banner('GOAL', s.wood ? 'In off the post' : this.goalSub(s), 'goal', 1600);
      this.sound.roar(0.75);
      this.sound.groan();
      this.excAway = 1;
      this.world.stadium.boards.flash('goal');
      this.at(1.8, () => this.world.stadium.boards.flash(null));
      this.flashScreen('GOAL!');
      this.react(inc, 'goal');
      if (inc.first) this.prompt('<div class="gk-tut"><b>Move your hands to the ball</b><span>Step or lean to cover the corners</span></div>', 2600);
      else this.promptNow('');
    } else {
      inc.result = 'm';
      this.tally.misses++;
      this.strip.push('m');
      this.react(inc, 'miss');
      this.promptNow('');
    }
  }

  private goalSub(s: Shot): string {
    const hi = s.target.y > 1.7 ? 'Top' : s.target.y < 0.5 ? 'Bottom' : '';
    const side = Math.abs(s.target.x) < 0.9 ? 'Down the middle' : s.target.x > 0 ? 'right corner' : 'left corner';
    if (side === 'Down the middle') return s.kind === 'chip' ? 'Chipped down the middle' : side;
    return hi ? `${hi} ${side}` : side.charAt(0).toUpperCase() + side.slice(1);
  }

  private react(inc: Incoming, what: 'save' | 'goal' | 'miss'): void {
    const sh = inc.sh;
    const p = sh.p;
    const mine = !!inc.mine;
    this.at(0.35, () => {
      p.kickT = null;
      if (what === 'goal') {
        if (this.cfg.mode === 'shootout') {
          // Off toward the fans.
          const dir = mine ? new THREE.Vector3(-0.8, 0, -0.6).normalize() : new THREE.Vector3(0.75, 0, -0.66).normalize();
          sh.celebrate = { t0: this.simT, dir, kind: 'sprint' };
          p.play('Sprint_Loop', 0.2);
          p.root.rotation.y = Math.atan2(dir.x, dir.z);
          this.at(1.5, () => p.play(this.rng() < 0.5 ? 'Slide_Loop' : 'Jump_Start', 0.2, { once: true }));
        } else p.play('Yes', 0.25, { once: true });
      } else {
        p.play(this.rng() < 0.5 ? 'Idle_No_Loop' : 'Hit_Chest', 0.25, { once: true });
        sh.celebrate = { t0: this.simT, dir: new THREE.Vector3(), kind: 'sad' };
      }
    });
    for (const l of this.lineup) {
      const happy = (what === 'goal') === ((l.team === 'home') === mine);
      l.react = this.simT + 0.3 + this.rng() * 0.5;
      l.kind = happy ? 'Jump_Start' : 'Idle_No_Loop';
    }
  }

  private finishIncoming(inc: Incoming): void {
    inc.state = 'done';
    const sh = inc.sh;
    if (this.cfg.mode === 'rapid') {
      // Walk back to the run-up spot; a fresh ball appears.
      sh.walk = { from: sh.p.root.position.clone(), to: inc.runFrom.clone(), t0: this.simT, dur: 1.1 };
      sh.p.play('Walk_Loop', 0.25, { speed: -1.1 });
      sh.p.kickT = null;
      this.at(1.1, () => {
        sh.busy = false;
        sh.walk = null;
        sh.celebrate = null;
        sh.p.play('Idle_Loop', 0.3);
        sh.ball.place(sh.spot);
        sh.p.root.rotation.y = Math.atan2(sh.spot.x - sh.p.root.position.x, sh.spot.z - sh.p.root.position.z);
      });
      this.nextShotAt = this.simT + rapidGap(this.cfg.difficulty, (RAPID_SECONDS - this.timeLeft) / RAPID_SECONDS) + (inc.held ? 0.6 : 0);
      this.inc = null;
      return;
    }
    // Shootout.
    if (inc.mine) this.homePens.push(inc.result === 'g');
    else this.awayPens.push(inc.result === 'g');
    this.inc = null;
    this.at(0.3, () => this.nextKick());
  }

  // ---- shootout flow -----------------------------------------------------------------------------

  private nextKick(): void {
    if (this.finished) return;
    const w = shootoutWinner(this.homePens, this.awayPens);
    if (w) {
      this.endShootout(w === 'home');
      return;
    }
    let kicker = nextKicker(this.homePens, this.awayPens);
    // Testing aid: ?gkfirst=home starts with your own penalty.
    if (this.env.params.get('gkfirst') === 'home' && !this.homePens.length && !this.awayPens.length && !this.myKick) kicker = 'home';
    this.hud.stinger();
    this.sound.boom();
    this.at(0.32, () => {
      if (kicker === 'away') this.setupAwayKick();
      else this.setupHomeKick();
    });
  }

  private resetBalls(): void {
    for (const b of this.balls()) {
      b.place(PENALTY_SPOT);
      b.setVisible(false);
      b.trailStrength = 0;
    }
    this.world.stadium.near.push(null, 0);
  }

  private setupAwayKick(): void {
    this.cam = 'keeper';
    this.resetBalls();
    const sh = this.shooters[0];
    sh.p.setVisible(true);
    const lk = this.look();
    sh.p.setLook(lk);
    sh.p.kickT = null;
    sh.p.lookAt = null;
    sh.celebrate = null;
    sh.p.play('Idle_Loop', 0);
    this.hud.lowerThird(this.away.color, `${lk.number}  ${NAMES[Math.floor(this.rng() * NAMES.length)]}`, `${this.away.name} · Penalty ${this.awayPens.length + 1}`);
    this.homeShooter?.p.setVisible(false);
    if (this.aiKeeper) this.aiKeeper.setVisible(false);
    this.keeper.setVisible(true);
    const kicks = this.homePens.length + this.awayPens.length;
    const inc = this.launch(sh, Math.min(1, kicks / 10), 1.7, 4.2);
    this.hud.score(this.homePens.filter(Boolean).length, this.awayPens.filter(Boolean).length, this.awayPens.length >= 5 ? 'SUDDEN DEATH' : `${this.away.short} TO SHOOT`);
    this.at(1.15, () => this.sound.whistle('short'));
    if (inc.first) this.promptNow(this.tutorialHtml());
    else this.prompt(`<div class="gk-tut small"><b>Kick ${this.awayPens.length + 1}</b><span>${this.awayPens.length >= 5 ? 'Save it to win' : 'Watch his body angle'}</span></div>`, 1600);
    this.sound.setExcitement(0.45);
  }

  private setupHomeKick(): void {
    this.cam = 'shooter';
    this.resetBalls();
    const sh = this.homeShooter!;
    sh.p.setVisible(true);
    const lk = this.look();
    sh.p.setLook(lk);
    sh.p.kickT = null;
    sh.p.lookAt = null;
    sh.celebrate = null;
    sh.p.play('Idle_Loop', 0);
    this.hud.lowerThird(HOME.color, `${lk.number}  ${NAMES[Math.floor(this.rng() * NAMES.length)]}`, `${HOME.name} · Penalty ${this.homePens.length + 1}`);
    sh.ball.place(sh.spot);
    sh.ball.setVisible(true);
    const path = this.runPath(sh.spot, 2.8);
    this.placeAtRunStart(sh, path.from, sh.spot);
    this.shooters[0].p.setVisible(false);
    this.keeper.setVisible(false);
    const k = this.aiKeeper!;
    k.setVisible(true);
    k.dive = null;
    k.root.position.set(0, 0, -0.15);
    k.root.rotation.set(0, Math.PI, 0);
    k.keeperReady = 1;
    k.play('Idle_Loop', 0);
    const auto = !this.cfg.ownKicks;
    const side = this.rng() < 0.5 ? -1 : 1;
    this.myKick = { phase: 'aim', t0: this.simT, aim: { x: 0, y: 1.0 }, auto, botTarget: { x: side * (2.2 + this.rng() * 0.9), y: 0.4 + this.rng() * 1.5 } };
    this.aimHist = [];
    this.botAim = this.env.demo || auto ? { x: this.myKick.botTarget.x, y: this.myKick.botTarget.y, swingAt: this.simT + 1.9 + this.rng() * 0.6 } : null;
    this.hud.score(this.homePens.filter(Boolean).length, this.awayPens.filter(Boolean).length, `${HOME.short} TO SHOOT`);
    if (!auto) this.promptNow('<div class="gk-tut"><i class="ic-point"></i><b>Point where you want to shoot</b></div><div class="gk-tut"><i class="ic-kick"></i><b>Kick or swing your arm down</b></div>');
    else this.prompt(`<div class="gk-tut small"><b>${HOME.name}</b><span>Your team mate steps up</span></div>`, 1800);
    this.reticle.visible = !auto;
    this.sound.setExcitement(0.45);
  }

  private updateMyKick(now: number): void {
    const mk = this.myKick!;
    if (mk.phase !== 'aim') return;
    const elapsed = this.simT - mk.t0;
    const limit = 4.2;
    if (mk.auto) {
      if (elapsed > 1.2) this.shootMine(mk.botTarget);
      return;
    }
    const last = this.aimHist[this.aimHist.length - 1];
    if (last) {
      mk.aim.x += (last.x - mk.aim.x) * 0.35;
      mk.aim.y += (last.y - mk.aim.y) * 0.35;
    }
    const inFrame = Math.abs(mk.aim.x) < GOAL.halfW - 0.1 && mk.aim.y < GOAL.h - 0.1;
    this.reticleMat.color.set(inFrame ? 0x3bffb4 : 0xff4d6a);
    this.reticle.position.set(mk.aim.x, Math.max(0.15, mk.aim.y), -0.05);
    this.reticle.scale.setScalar(1 + 0.08 * Math.sin(now / 120));
    this.hud.aim(true, Math.min(1, elapsed / limit), inFrame ? 'Kick to shoot' : 'Off target!');
    // A fast downward arm swing also shoots.
    const sw = this.swing.velocity(0);
    const sw2 = this.swing.velocity(1);
    if (elapsed > 0.6 && (sw.y < -6 || sw2.y < -6) && now - this.swingFired > 500) {
      this.swingFired = now;
      this.triggerMyKick(now);
      return;
    }
    if (elapsed >= limit) this.triggerMyKick(now);
  }

  private triggerMyKick(t: number): void {
    const mk = this.myKick;
    if (!mk || mk.phase !== 'aim' || this.simT - mk.t0 < 0.6) return;
    // Use where the hand was pointing a moment before the trigger movement.
    const before = this.aimHist.filter((a) => a.t < t - 220);
    const a = before.length ? before[before.length - 1] : mk.aim;
    this.shootMine({ x: a.x, y: a.y });
  }

  private shootMine(aim: { x: number; y: number }): void {
    const mk = this.myKick!;
    mk.phase = 'run';
    this.hud.aim(false);
    this.promptNow('');
    this.reticle.visible = false;
    const target = aimError(aim, this.rng, this.cfg.difficulty);
    const sh = this.homeShooter!;
    const from = { x: sh.spot.x, y: BALL_R, z: sh.spot.z };
    const ax = Math.abs(target.x);
    const wood = ax > GOAL.halfW - BALL_R && ax < GOAL.halfW + BALL_R + GOAL.postR * 2 && target.y < GOAL.h ? 'post' : target.y > GOAL.h - BALL_R && target.y < GOAL.h + BALL_R + GOAL.postR * 2 && ax < GOAL.halfW ? 'bar' : null;
    const shot = buildShot(++this.shotId, from, target, 0.62 + this.rng() * 0.08, { bend: (this.rng() - 0.5) * 0.4, kind: 'driven', wood });
    const dive = aiKeeper(target, this.cfg.difficulty, this.rng);
    const path = this.runPath(sh.spot, 2.8);
    const inc: Incoming = {
      shot,
      sh,
      runFrom: path.from,
      plant: path.plant,
      runYaw: path.yaw,
      kickYaw: path.shotYaw + (target.x > 0 ? 0.1 : -0.1),
      runStart: this.simT + 0.15,
      runDur: 2.8 / 3.6,
      stutter: false,
      kickAt: this.simT + 0.15 + 2.8 / 3.6,
      tc: timeAtZ(shot, -0.35),
      state: 'wait',
      crossReal: 0,
      crossBall: { x: 0, y: 0 },
      resolvedAt: 0,
      result: null,
      contact: null,
      great: false,
      held: false,
      first: false,
      whooshed: true,
      dive,
      mine: true,
    };
    sh.busy = true;
    this.inc = inc;
    this.myKick = { ...mk, phase: 'done' };
  }

  /** Your penalty reaches the AI keeper. */
  private resolveMine(inc: Incoming): void {
    const ball = inc.sh.ball;
    const d = inc.dive!;
    if (d.saved) {
      inc.state = 'after';
      inc.resolvedAt = this.simT;
      inc.result = 's';
      const v = shotVel(inc.shot, this.simT - inc.kickAt);
      ball.free = true;
      ball.vel.set(d.side * 3 + v.x * 0.2, 2.5 + this.rng() * 2, -Math.abs(v.z) * 0.3);
      ball.spin.set(10, 20, 5);
      this.sound.glove(1, ball.pos.x / 4);
      this.sparks.burst(ball.pos.clone(), 20, { color: new THREE.Color(1, 1, 1), speed: 3.5, life: 0.4, size: 0.04, grav: 2 });
      this.banner('SAVED', `The ${this.away.short} keeper guessed right`, 'lose', 1700);
      this.sound.groan();
      this.excAway = 1;
      this.react(inc, 'save');
      return;
    }
    inc.state = 'toLine';
    inc.resolvedAt = this.simT;
  }

  /** Your penalty at the goal line: in, off the woodwork or wide. */
  private atGoalLineMine(inc: Incoming): void {
    const ball = inc.sh.ball;
    const s = inc.shot;
    const v = shotVel(s, this.simT - inc.kickAt);
    inc.state = 'after';
    inc.resolvedAt = this.simT;
    ball.free = true;
    let goal = false;
    if (s.wood) {
      const wb = woodworkBounce(s, v, this.rng);
      ball.vel.set(wb.v.x, wb.v.y, wb.v.z);
      ball.pos.z = -BALL_R;
      this.sound.post(s.target.x / 4);
      goal = wb.inGoal;
      if (goal) ball.inGoal = true;
    } else {
      ball.vel.set(v.x, v.y, v.z);
      goal = s.onTarget;
      ball.inGoal = goal;
    }
    inc.result = goal ? 'g' : 'm';
    if (goal) {
      this.banner('GOAL!', s.wood ? 'In off the post!' : `${HOME.short} score`, 'win', 1700);
      this.sound.roar(1.1);
      this.excHome = 1;
      this.world.stadium.boards.flash('goal');
      this.at(1.8, () => this.world.stadium.boards.flash(null));
      this.flashScreen('GOAL!');
      this.react(inc, 'goal');
    } else {
      this.banner('MISSED', s.wood ? (s.wood === 'bar' ? 'Off the bar' : 'Off the post') : s.target.y > GOAL.h ? 'Over the bar' : 'Wide of the post', 'lose', 1700);
      this.sound.ooh();
      this.react(inc, 'miss');
    }
  }

  private endShootout(homeWon: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.won = homeWon;
    this.cam = 'end';
    this.promptNow('');
    this.hud.score(this.homePens.filter(Boolean).length, this.awayPens.filter(Boolean).length, homeWon ? 'FULL TIME · WIN' : 'FULL TIME');
    if (homeWon) {
      this.banner('YOU WIN!', `${HOME.name} win the shootout`, 'win', 3200);
      this.sound.roar(1.4);
      this.excHome = 1.4;
      for (let i = 0; i < 4; i++) this.at(i * 0.35, () => this.confettiBurst());
    } else {
      this.banner('DEFEAT', `${this.away.name} win the shootout`, 'lose', 3200);
      this.sound.groan();
      this.excAway = 1.4;
    }
    this.sound.whistle('final');
    this.at(3.8, () => this.done());
  }

  private endRapid(): void {
    if (this.finished) return;
    this.finished = true;
    this.cam = 'end';
    this.sound.whistle('final');
    this.promptNow('');
    this.banner("TIME'S UP", `${this.tally.saves} saves · ${this.points.toLocaleString()} pts`, 'info', 2600);
    this.sound.roar(1);
    if (this.tally.saves >= 10) for (let i = 0; i < 3; i++) this.at(i * 0.4, () => this.confettiBurst());
    this.at(3.0, () => this.done());
  }

  private confettiBurst(): void {
    const cols = [HOME.color, '#ffffff', '#ffd23f', '#3bffb4'];
    this.confetti.burst(new THREE.Vector3(0, 9, -6), 220, { color: () => new THREE.Color(cols[Math.floor(this.rng() * cols.length)]), speed: 6, up: 4, life: 3.5, size: 0.06, grav: 1.6, drag: 1.2, box: new THREE.Vector3(14, 2, 8) });
  }

  private flashScreen(text: string): void {
    const s = this.world.stadium.screen;
    s.draw({ title: '', left: '', right: '', score: '', sub: '', flash: text, colA: HOME.color, colB: this.away.color });
    this.at(2.0, () => this.drawScreen());
  }

  private drawScreen(): void {
    const s = this.world.stadium.screen;
    if (this.cfg.mode === 'shootout')
      s.draw({ title: 'PENALTY SHOOTOUT', left: HOME.short, right: this.away.short, score: `${this.homePens.filter(Boolean).length} - ${this.awayPens.filter(Boolean).length}`, sub: `${HOME.name} v ${this.away.name}`, colA: HOME.color, colB: this.away.color });
    else s.draw({ title: 'RAPID FIRE', left: 'SAVES', right: 'GOALS', score: `${this.tally.saves} - ${this.tally.goals}`, sub: `${Math.ceil(this.timeLeft)}s left`, colA: HOME.color, colB: this.away.color });
  }

  private done(): void {
    const snapshot = this.world.snapshot();
    const result: MatchResult = {
      mode: this.cfg.mode,
      difficulty: this.cfg.difficulty,
      tally: { ...this.tally },
      points: this.points,
      won: this.won,
      home: [...this.homePens],
      away: [...this.awayPens],
      homeTeam: HOME,
      awayTeam: this.away,
      snapshot,
    };
    this.publishDebug(true);
    this.cleanup();
    this.resolve({ kind: 'done', result });
  }

  // ---- actors ------------------------------------------------------------------------------------

  private updateActors(dt: number): void {
    const t = this.simT;
    for (const s of [...this.shooters, ...(this.homeShooter ? [this.homeShooter] : [])]) {
      if (!s.p.root.visible) continue;
      if (s.walk) {
        const k = Math.min(1, (t - s.walk.t0) / s.walk.dur);
        s.p.root.position.lerpVectors(s.walk.from, s.walk.to, ease(k));
      }
      if (s.celebrate?.kind === 'sprint' && t - s.celebrate.t0 < 1.5) {
        s.p.root.position.addScaledVector(s.celebrate.dir, dt * 5.5 * Math.min(1, (t - s.celebrate.t0) * 3));
      }
      if (s.p.lookAt && this.inc?.sh === s) s.p.lookWeight = 0.8;
      s.p.update(dt);
    }
    const k = this.aiKeeper;
    if (k && k.root.visible) {
      if (!k.dive) {
        // Bounce on the line while waiting.
        k.root.position.x = Math.sin(t * 2.2) * 0.15;
      }
      k.lookAt = this.homeShooter?.ball.pos ?? null;
      k.lookWeight = 0.7;
      k.update(dt);
    }
    if (this.referee) this.referee.update(dt);
    for (const l of this.lineup) {
      if (l.react && t >= l.react) {
        l.p.play(l.kind, 0.2, { once: true });
        l.react = 0;
        this.at(2.2 + this.rng(), () => l.p.play('Idle_Loop', 0.4));
      }
      l.p.update(dt);
    }
  }

  private updateCrowd(dt: number): void {
    const c = this.world.stadium.crowd.uniforms;
    this.excHome = Math.max(0, this.excHome - dt * 0.35);
    this.excAway = Math.max(0, this.excAway - dt * 0.35);
    const tension = this.inc && (this.inc.state === 'run' || this.inc.state === 'flight') ? 0.25 : 0;
    c.uExcHome.value = Math.min(1, this.excHome + tension);
    c.uExcAway.value = Math.min(1, this.excAway + tension);
    c.uFlash.value = Math.min(1, Math.max(this.excHome, this.excAway) * 1.2);
    // An occasional Mexican wave while nothing happens.
    if (this.waveT > -100) {
      this.waveT += dt * 1.1;
      c.uWave.value = this.waveT - Math.PI;
      if (this.waveT > Math.PI * 4) this.waveT = -1000;
    } else if ((!this.inc || this.inc.state === 'wait') && this.rng() < dt * 0.01) this.waveT = 0;
    else c.uWave.value = -1000;
    const ex = Math.max(this.excHome, this.excAway);
    this.sound.setExcitement(0.3 + ex * 0.6 + tension);
  }

  // ---- the player's keeper -------------------------------------------------------------------------

  private updateKeeperView(dt: number): void {
    const show = this.cam !== 'shooter';
    const seen = performance.now() - this.lastSeen < 700;
    this.keeper.update(show && seen ? this.latestKP : null, dt, this.inc?.result === 'g' ? 0.45 : 1);
    if (!show) this.keeper.setVisible(false);
    this.hud.warn(!seen && !this.env.demo && this.cam === 'keeper');
  }

  // ---- camera -------------------------------------------------------------------------------------

  private updateCamera(dt: number, now: number): void {
    const cam = this.world.camera;
    this.shake = Math.max(0, this.shake - dt * 1.4);
    const sh = this.shake * this.shake * 0.25;
    const jitter = new THREE.Vector3((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, 0);
    const sway = new THREE.Vector3(Math.sin(now / 1900) * 0.03, Math.sin(now / 2300) * 0.02, 0);
    let pos: THREE.Vector3;
    let look: THREE.Vector3;
    let hfov: number;
    if (this.cam === 'shooter') {
      const b = this.homeShooter?.ball.pos ?? new THREE.Vector3(0, 0, -11);
      const push = this.inc?.mine && this.inc.state !== 'wait' ? ease((this.simT - this.inc.runStart) / 1.2) : 0;
      pos = SHOOTER_CAM.pos.clone().lerp(new THREE.Vector3(-0.4, 1.85, -17.5), push * 0.6);
      look = SHOOTER_CAM.look.clone().lerp(new THREE.Vector3(b.x * 0.5, 1.1, 0), push * 0.4);
      hfov = SHOOTER_CAM.hfov;
    } else {
      const kx = this.latestKP ? Math.max(-3, Math.min(3, this.latestKP.sh.x)) : 0;
      pos = KEEPER_CAM.pos.clone().add(new THREE.Vector3(kx * 0.12, 0, 0));
      look = KEEPER_CAM.look.clone().add(new THREE.Vector3(kx * 0.08, 0, 0));
      hfov = KEEPER_CAM.hfov;
      // Great save: zoom in on the moment.
      const slowOn = now < this.slowUntil && this.zoomAt;
      this.zoom += ((slowOn ? 1 : 0) - this.zoom) * Math.min(1, dt * (slowOn ? 5 : 2));
      if (this.zoom > 0.001 && this.zoomAt) {
        look.lerp(this.zoomAt, this.zoom * 0.6);
        pos.lerp(new THREE.Vector3(this.zoomAt.x * 0.4, this.zoomAt.y * 0.5 + 1.2, 4.3), this.zoom * 0.5);
        hfov -= this.zoom * 18;
      }
      if (this.cam === 'intro' || this.cam === 'end') {
        const k = this.cam === 'intro' ? ease(this.simT / 3.2) : 1 - ease((this.simT - this.endT()) / 3);
        const a = this.simT * 0.08;
        const high = new THREE.Vector3(Math.sin(a) * 22, 16, -24 + Math.cos(a) * 6);
        pos = high.lerp(pos, k);
        look = new THREE.Vector3(0, 1, -6).lerp(look, k);
        hfov = 70 + (hfov - 70) * k;
      }
    }
    cam.position.copy(pos).add(jitter).add(sway);
    cam.lookAt(look.add(jitter.multiplyScalar(0.5)));
    if (Math.abs(this.world.hfov - hfov) > 0.01) {
      this.world.hfov = hfov;
      this.world.updateFov();
    }
    this.world.flash = Math.max(0, this.world.flash - dt * 2.2);
  }

  private endStart = 0;
  private endT(): number {
    if (!this.endStart) this.endStart = this.simT;
    return this.endStart;
  }

  // ---- HUD & debug -------------------------------------------------------------------------------

  private updateHud(now: number): void {
    if (this.cfg.mode === 'shootout') {
      const next = this.finished ? null : nextKicker(this.homePens, this.awayPens);
      this.hud.pens(this.homePens, this.awayPens, next);
      const sd = this.awayPens.length >= 5 && this.homePens.length >= 5;
      const who = this.inc ? (this.inc.mine ? HOME.short : this.away.short) : this.myKick && this.myKick.phase === 'aim' ? HOME.short : '';
      const sub = this.finished ? (this.won ? 'FULL TIME · WIN' : 'FULL TIME') : sd ? 'SUDDEN DEATH' : who ? `${who} TO SHOOT` : 'PENALTIES';
      this.hud.score(this.homePens.filter(Boolean).length, this.awayPens.filter(Boolean).length, sub);
      this.hud.keeperStat(this.tally.saves, this.tally.goals);
    } else {
      this.hud.rapid(this.timeLeft, this.tally.saves, this.points, streakMult(this.streak), this.streak);
      this.hud.strip(this.strip);
    }
    if (!this.myKick || this.myKick.phase !== 'aim') this.hud.aim(false);
    if (now - this.previewT > 1000) {
      this.previewT = now;
      this.drawScreen();
    }
  }

  private drawPreview(now: number): void {
    if (!this.env.settings.showCamera) return;
    const c = this.hud.cam as HTMLCanvasElement & { _t?: number };
    if (c._t && now - c._t < 66) return;
    c._t = now;
    drawSkeleton(c.getContext('2d')!, this.env.pose.video, this.env.pose.latest(), c.width, c.height);
  }

  private publishDebug(final = false): void {
    (window as unknown as { __gameDebug?: unknown }).__gameDebug = {
      mode: this.cfg.mode,
      difficulty: this.cfg.difficulty,
      phase: this.finished ? 'finished' : this.inc ? this.inc.state : this.myKick?.phase ?? this.cam,
      shots: this.tally.shots,
      saves: this.tally.saves,
      goals: this.tally.goals,
      misses: this.tally.misses,
      catches: this.tally.catches,
      great: this.tally.great,
      streak: this.streak,
      bestStreak: this.tally.bestStreak,
      points: this.points,
      timeLeft: this.cfg.mode === 'rapid' ? Math.round(this.timeLeft * 10) / 10 : null,
      home: this.homePens.map((x) => (x ? 1 : 0)).join(''),
      away: this.awayPens.map((x) => (x ? 1 : 0)).join(''),
      finished: final || this.finished,
      scale: Math.round(this.scale * 100) / 100,
      simT: Math.round(this.simT * 100) / 100,
      frames: this.frames,
      begunAt: Math.round(this.begunAt),
      now: Math.round(performance.now()),
      kickAt: this.inc ? Math.round(this.inc.kickAt * 100) / 100 : null,
      runStart: this.inc ? Math.round(this.inc.runStart * 100) / 100 : null,
      fps: Math.round(this.world.fps),
      quality: this.world.currentLevel,
      calls: this.world.renderer.info.render.calls,
      tris: this.world.renderer.info.render.triangles,
      programs: this.world.renderer.info.programs?.length ?? 0,
    };
  }

  // ---- demo bot -------------------------------------------------------------------------------------

  /** Simulation time at a performance.now() moment (extrapolated from the last frame). */
  private simAt(tMs: number): number {
    if (this.paused || !this.lastNow) return this.simT;
    return this.simT + (Math.min(1000, Math.max(0, tMs - this.lastNow)) / 1000) * this.scale;
  }

  private idleHands(t: number): [V2, V2] {
    return [
      { x: -0.42 + Math.sin(t * 1.3) * 0.05, y: 1.05 + Math.sin(t * 2.1) * 0.04 },
      { x: 0.42 + Math.sin(t * 1.3) * 0.05, y: 1.05 + Math.sin(t * 2.1 + 1) * 0.04 },
    ];
  }

  /** Decide how the bot will play this shot: usually right, sometimes wrong-footed, late or short. */
  private planBot(inc: Incoming): BotPlan {
    const tgt = shotPos(inc.shot, inc.tc);
    const roll = this.rng();
    const skill = this.cfg.difficulty === 'easy' ? 0.8 : this.cfg.difficulty === 'normal' ? 0.72 : 0.62;
    let to: V2 = { x: tgt.x, y: tgt.y };
    const t0 = inc.kickAt + 0.16;
    let arrive = inc.kickAt + inc.tc - 0.05;
    if (roll > skill) {
      const fail = this.rng();
      if (fail < 0.45) to = { x: -tgt.x * 0.8 + (Math.abs(tgt.x) < 0.8 ? 1.8 : 0), y: tgt.y };
      else if (fail < 0.75) arrive += 0.6;
      else to = { x: tgt.x - Math.sign(tgt.x || 1) * 1.1, y: tgt.y + 0.55 };
    }
    const both = Math.abs(to.x) < 1.6 && to.y > 0.5 && to.y < 1.9;
    const side = Math.sign(to.x || 1);
    const toL: V2 = both ? { x: to.x - 0.16, y: to.y } : side < 0 ? to : { x: to.x - 0.75, y: to.y - 0.25 };
    const toR: V2 = both ? { x: to.x + 0.16, y: to.y } : side > 0 ? to : { x: to.x + 0.75, y: to.y - 0.25 };
    return { inc, t0, arrive, from: this.idleHands(t0), to: [toL, toR] };
  }

  /** The demo player's pose at simulation time t. */
  private botPoseAt(t: number): SimParams {
    let [l, r] = this.idleHands(t);
    const plan = this.botPlan;
    if (plan && t >= plan.t0) {
      const k = ease((t - plan.t0) / Math.max(0.08, plan.arrive - plan.t0));
      const done = plan.inc.state === 'after' || plan.inc.state === 'done';
      const back = done ? ease((t - plan.inc.resolvedAt - 0.6) / 0.8) : 0;
      const lerp = (a: V2, b: V2, kk: number): V2 => ({ x: a.x + (b.x - a.x) * kk, y: a.y + (b.y - a.y) * kk });
      l = lerp(lerp(plan.from[0], plan.to[0], k), l, back);
      r = lerp(lerp(plan.from[1], plan.to[1], k), r, back);
    }
    const p = goalToBody(l, r);
    let sim: SimParams = { lWrist: p.lWrist, rWrist: p.rWrist, lean: p.lean, duck: p.duck, rise: p.rise };
    // Aiming your own penalty: point at the corner, then swing the arm down.
    const mk = this.myKick;
    if (mk && mk.phase === 'aim' && this.botAim && !mk.auto) {
      const ba = this.botAim;
      const k = ease((t - mk.t0) / 1.0);
      const wx = (ba.x / GOAL.halfW) * 1.9;
      const wy = (ba.y / GOAL.h) * 3.0 - 1.2;
      let rw: V2 = { x: 0.6 + (wx - 0.6) * k, y: -1.4 + (wy + 1.4) * k };
      if (t > ba.swingAt) {
        const s = ease((t - ba.swingAt) / 0.12);
        rw = { x: rw.x, y: rw.y + (-1.8 - rw.y) * s };
      }
      sim = { lWrist: { x: -0.75, y: -1.5 }, rWrist: rw, lean: 0, duck: 0, rise: 0 };
    }
    return sim;
  }

  // ---- pause / end --------------------------------------------------------------------------------

  private async pause(): Promise<void> {
    if (this.paused || this.finished) return;
    this.paused = true;
    await this.env.audio.pause();
    const act = await pauseMenu(this.host, this.env.cursor);
    if (act === 'resume') {
      await this.env.audio.resume();
      this.paused = false;
      this.lastPoseT = performance.now();
      return;
    }
    await this.env.audio.resume();
    this.finished = true;
    this.cleanup();
    this.resolve(act === 'restart' ? { kind: 'restart' } : { kind: 'quit' });
  }

  private cleanup(): void {
    window.removeEventListener('keydown', this.onKey);
    this.world.step = () => {};
    this.sound.stop();
    this.hud.remove();
    this.world.scene.remove(this.group);
    this.world.stadium.boards.flash(null);
    this.world.stadium.near.push(null, 0);
    this.world.slow = 0;
    this.world.flash = 0;
    if (this.env.pose instanceof SimPose) this.env.pose.drive = () => SIM_REST;
    const people = [...this.shooters.map((s) => s.p), ...(this.homeShooter ? [this.homeShooter.p] : []), ...this.lineup.map((l) => l.p)];
    if (this.aiKeeper) people.push(this.aiKeeper);
    if (this.referee) people.push(this.referee);
    for (const p of people) p.dispose();
    for (const b of this.balls()) b.dispose();
    this.keeper.dispose();
    this.sparks.dispose();
    this.turf.dispose();
    this.confetti.dispose();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !(m as THREE.SkinnedMesh).isSkinnedMesh) m.geometry.dispose();
    });
    this.reticleMat.dispose();
  }
}

export type { Vec3 };
