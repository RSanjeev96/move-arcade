/** Sky Quest play session: world, physics, input, enemies, HUD, pause, goal celebration. */
import * as THREE from 'three';
import type { AudioEngine } from '../../core/audio';
import type { Body, BodyTracker } from '../../core/body';
import { SimPose, SIM_REST } from '../../core/pose';
import type { Settings } from '../../core/settings';
import type { PoseSource } from '../../core/types';
import { CamPreview, HandsUpPause, fmtClock, pauseMenu } from '../../ui/kit';
import { Bolts, enemyPose, flying, makeEnemies, playOnce, type Bolt, type Enemy } from './actors';
import { skinTexture, type QuestAssets } from './assets';
import { QuestBot, type BotTarget } from './bot';
import { Confetti, Particles, Rings, glowTexture, puffTexture, sparkleTexture } from './fx';
import { Hands } from './hands';
import { InputMapper, type Intent } from './input';
import { Coins, makePickups, mysteryMaterials, powerColor, type Pickup } from './items';
import { BLOCK_COINS, LANE_W, PROFILES, laneX, starsFor, type BoxDef, type Contents, type DiffProfile, type LevelData, type PowerKind, type PromptIcon } from './levels';
import {
  R,
  SPRING_APEX,
  STOMP_APEX,
  SolidIndex,
  launch,
  newPlayer,
  requestBig,
  requestJump,
  stepPlayer,
  supportAt,
  type PhysCfg,
  type Player,
  type Solid,
  type StepEvents,
} from './physics';
import { Planner } from './plan';
import { LandingMarker, hazardMeshes, makeFlag, makeGate, makeGuides, makeSprings, type FlagVis, type GateVis, type SpringVis } from './props';
import { Sfx } from './sfx';
import { CloudSea, Clouds, Sky, THEMES, sunDirection, type Theme } from './sky';
import { buildTerrain, waterMaterial } from './terrain';

export interface QuestCtx {
  root: HTMLElement;
  pose: PoseSource;
  body: BodyTracker;
  audio: AudioEngine;
  settings: Settings;
  demo: boolean;
  cursor: (on: boolean) => void;
}

export interface QuestResult {
  level: number;
  name: string;
  difficulty: string;
  cleared: boolean;
  time: number;
  par: number;
  coins: number;
  coinTotal: number;
  gems: number;
  gemTotal: number;
  enemies: number;
  hearts: number;
  damaged: boolean;
  falls: number;
  stars: { coins: boolean; time: boolean; clean: boolean; n: number };
  score: number;
}

export type QuestOutcome = { kind: 'done'; result: QuestResult } | { kind: 'quit' } | { kind: 'restart' };

interface BoxRt {
  def: BoxDef;
  solid: Solid;
  mesh: THREE.Object3D | null;
  base: number;
  touched: number;
  fallV: number;
  fall: number;
  used: boolean;
  bounce: number;
}

interface Flyer {
  obj: THREE.Object3D;
  from: THREE.Vector3;
  t: number;
  done: () => void;
}

type State = 'intro' | 'play' | 'falling' | 'respawn' | 'goal' | 'over';

const PROMPT_ICON: Record<PromptIcon, string> = {
  run: '🏃',
  lean: '↔',
  hop: '⤴',
  big: '⇈',
  punch: '👊',
  duck: '⬇',
  block: '✦',
  spring: '⇞',
  stomp: '⬇',
};

const POWER_NAME: Record<PowerKind, string> = { triple: 'Triple shot', shield: 'Shield', magnet: 'Coin magnet' };
const POWER_TIME: Record<PowerKind, number> = { triple: 14, shield: 12, magnet: 14 };
const SUBSTEP = 1 / 120;
/** Debug switches for profiling (e.g. ?qoff=shadow,clouds,sea). */
const OFF = new Set((new URLSearchParams(location.search).get('qoff') ?? '').split(',').filter(Boolean));
/** Test switch: render only every Nth frame (?qskip=6) so logic runs near real time on software WebGL. */
const SKIP = Math.max(1, Number(new URLSearchParams(location.search).get('qskip')) || (OFF.has('render') ? 20 : 1));

export class QuestGame {
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(64, 16 / 9, 0.05, 900);
  private theme: Theme;
  private prof: DiffProfile;
  private cfg: PhysCfg;
  private sky!: Sky;
  private clouds!: Clouds;
  private sea!: CloudSea;
  private sun!: THREE.DirectionalLight;
  private hands!: Hands;
  private chunks: { mesh: THREE.Mesh; z: number }[] = [];
  private water!: THREE.ShaderMaterial;
  private guides: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } | null = null;
  private marker = new LandingMarker();
  private caster!: THREE.Mesh;

  private idx = new SolidIndex();
  private boxes: BoxRt[] = [];
  private byId = new Map<number, BoxRt>();
  readonly player: Player;
  readonly planner: Planner;
  private input = new InputMapper();
  private coins!: Coins;
  private pickups: Pickup[] = [];
  private enemies: Enemy[] = [];
  private bolts = new Bolts();
  private springs: SpringVis[] = [];
  private flags: FlagVis[] = [];
  private gate!: GateVis;
  private sparks: Particles;
  private puffs: Particles;
  private confetti = new Confetti();
  private rings = new Rings();
  private flyers: Flyer[] = [];
  private kitMat!: THREE.MeshStandardMaterial;
  private coinMat!: THREE.MeshStandardMaterial;
  private mats: THREE.Material[] = [];
  private sfx: Sfx;
  private bot: QuestBot | null = null;

  // HUD
  private el!: HTMLElement;
  private hud: Record<string, HTMLElement> = {};
  private lastHud: Record<string, string> = {};
  private preview: CamPreview;
  private pauseGesture = new HandsUpPause();

  // state
  private state: State = 'intro';
  private gt = 0;
  private stateT = 0;
  private playTime = 0;
  private lastFrame = 0;
  private lastPoseT = 0;
  private raf = 0;
  private paused = false;
  private done = false;
  private resolve!: (o: QuestOutcome) => void;
  private latestBody: Body | null = null;
  private fpsAvg = 60;
  private quality: 'high' | 'medium' | 'low' = 'high';
  private perfChecked = false;
  private startedAt = performance.now();

  private hearts = 3;
  private coinCount = 0;
  private gems = 0;
  private enemiesDown = 0;
  private damaged = false;
  private falls = 0;
  private jumps = 0;
  private doubles = 0;
  private shots = 0;
  private stomps = 0;
  private invulnUntil = 0;
  private power: { kind: PowerKind; until: number } | null = null;
  private cp = -1;
  private timeScale = 1;
  private shake = 0;
  private hurtFlash = 0;
  private dip = 0;
  private dipV = 0;
  private stepPhase = 0;
  private stepsSeen = 0;
  private runK = 0;
  private camPitch = -0.1;
  private lastLandT = -10;
  private promptShown = '';
  private hintText = '';
  private tally: Promise<void> | null = null;
  private crateBlockT = -10;
  private slideT = -1;
  private slideV = 0;
  private wallBlockT = -10;
  /** Recent notable events (for tests and debugging). */
  private log: string[] = [];

  private note(msg: string): void {
    this.log.push(`${this.player.s.toFixed(1)}: ${msg}`);
    if (this.log.length > 40) this.log.shift();
  }

  constructor(
    private ctx: QuestCtx,
    private assets: QuestAssets,
    readonly level: LevelData,
    private opts: { startCp?: number; musicVolume: number },
  ) {
    this.theme = THEMES[level.theme];
    this.prof = PROFILES[level.difficulty];
    this.cfg = { coyote: this.prof.coyote, airMin: this.prof.airMin, buffer: this.prof.buffer };
    this.player = newPlayer(0.5, 0);
    this.planner = new Planner(level);
    this.sfx = new Sfx(ctx.audio);
    this.sparks = new Particles(900, sparkleTexture(), true);
    this.puffs = new Particles(400, puffTexture(), false);
    this.preview = new CamPreview(ctx.pose, 'hud-cam');
  }

  run(): Promise<QuestOutcome> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.build();
      this.begin();
    });
  }

  // ---- setup -------------------------------------------------------------------------------------------

  private build(): void {
    const { root, settings } = this.ctx;
    this.el = document.createElement('div');
    this.el.className = 'game-root quest-game';
    this.el.innerHTML = `
      <canvas class="gl"></canvas>
      <div class="q-vig q-hurt"></div>
      <div class="q-vig q-shield"></div>
      <div class="q-fade"></div>
      <div class="ghud q-hud">
        <div class="tl q-tl">
          <div class="q-hearts"><i></i><i></i><i></i></div>
          <div class="q-counters">
            <div class="q-coins"><span class="q-coin-ic"></span><b>0</b></div>
            <div class="q-gems"><i></i><i></i><i></i></div>
          </div>
          <div class="q-power hidden"><span class="q-power-ic"></span><div><b></b><i><u></u></i></div></div>
        </div>
        <div class="tc q-tc">
          <div class="q-lname"></div>
          <div class="q-track"><i class="q-fill"></i><em class="q-me"></em><span class="q-goal">★</span></div>
        </div>
        <div class="tr q-tr"><div class="q-time">0:00</div><button class="q-pause" data-hc aria-label="Pause">❚❚</button></div>
        <div class="q-prompt"><span class="q-pi"></span><b></b></div>
        <div class="q-banner"></div>
        <div class="q-hint"></div>
        <div class="q-popups"></div>
        <div class="q-count"></div>
        <div class="q-titlecard"><small></small><b></b><span></span></div>
      </div>`;
    root.appendChild(this.el);
    const q = (s: string) => this.el.querySelector(s) as HTMLElement;
    for (const [k, s] of Object.entries({
      hearts: '.q-hearts',
      coins: '.q-coins b',
      coinBox: '.q-coins',
      gems: '.q-gems',
      power: '.q-power',
      powerName: '.q-power b',
      powerBar: '.q-power u',
      powerIc: '.q-power-ic',
      lname: '.q-lname',
      track: '.q-track',
      fill: '.q-fill',
      me: '.q-me',
      time: '.q-time',
      prompt: '.q-prompt',
      promptText: '.q-prompt b',
      promptIc: '.q-pi',
      banner: '.q-banner',
      hint: '.q-hint',
      popups: '.q-popups',
      count: '.q-count',
      title: '.q-titlecard',
      hurt: '.q-hurt',
      shield: '.q-shield',
      fade: '.q-fade',
    })) this.hud[k] = q(s);
    this.hud.lname.textContent = `Level ${this.level.id} · ${this.level.name}`;
    for (const c of this.level.checkpoints) {
      const b = document.createElement('b');
      b.className = 'q-cp';
      b.style.left = `${(c.s / this.level.goal.s) * 100}%`;
      this.hud.track.appendChild(b);
    }
    const tc = this.hud.title;
    (tc.querySelector('small') as HTMLElement).textContent = `Level ${this.level.id}`;
    (tc.querySelector('b') as HTMLElement).textContent = this.level.name;
    (tc.querySelector('span') as HTMLElement).textContent = this.level.tagline;
    this.preview.canvas.style.display = settings.showCamera ? '' : 'none';
    this.el.querySelector('.ghud')!.appendChild(this.preview.canvas);
    q('.q-pause').addEventListener('click', () => void this.pause());

    // Renderer.
    const canvas = q('canvas.gl') as HTMLCanvasElement;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = this.theme.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = true;
    // Software WebGL (headless tests) is far slower than any real GPU: start low there unless asked otherwise.
    const gl = this.renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    this.software = /swiftshader|llvmpipe|software/i.test(name);
    this.quality = settings.quality === 'auto' ? (this.software ? 'low' : 'high') : settings.quality;

    const b0 = performance.now();
    this.buildWorld();
    this.prof2.build = performance.now() - b0;
    this.applyQuality(this.quality);
    window.addEventListener('resize', this.resize);
    this.resize();

    if (this.ctx.demo) (window as unknown as { __questGame?: unknown }).__questGame = this;
    if (this.ctx.demo && this.ctx.pose instanceof SimPose) {
      const sim = this.ctx.pose;
      this.bot = new QuestBot(
        {
          player: this.player,
          level: this.level,
          planner: this.planner,
          active: () => this.state === 'play' && !this.paused,
          finished: () => this.state === 'goal',
          targets: () => this.botTargets(),
        },
        this.level.id * 31 + 7,
      );
      sim.drive = (t) => this.bot!.drive(t);
    }
  }

  private buildWorld(): void {
    const th = this.theme;
    const scene = this.scene;
    scene.fog = new THREE.Fog(th.fog, th.fogNear, th.fogFar);
    scene.background = new THREE.Color(th.horizon);

    this.sky = new Sky(th);
    if (!OFF.has('sky')) scene.add(this.sky.mesh);
    // Environment lighting from the sky for the shiny bits (coins, blocks, gloves).
    const pm = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(new Sky(th).mesh);
    const env = pm.fromScene(envScene, 0.02).texture;
    scene.environment = env;
    pm.dispose();

    const sunDir = sunDirection(th);
    scene.add(new THREE.HemisphereLight(th.hemiSky, th.hemiGround, th.hemiI));
    this.sun = new THREE.DirectionalLight(th.sun, th.sunI);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -18;
    sc.right = 18;
    sc.top = 18;
    sc.bottom = -18;
    sc.near = 1;
    sc.far = 120;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;
    this.sun.userData.dir = sunDir;
    scene.add(this.sun, this.sun.target);

    // Clouds around and below the islands.
    const r = (() => {
      let a = this.level.id * 1013;
      return () => ((a = (a * 16807) % 2147483647) / 2147483647);
    })();
    this.clouds = new Clouds(th, 44, (i) => {
      const side = i % 2 ? 1 : -1;
      const far = r();
      return { x: side * (34 + far * 220), y: -34 + r() * 74 + (far > 0.6 ? 20 : 0), z: 60 - r() * 760, w: 16 + r() * 26 + far * 30 };
    });
    if (!OFF.has('clouds')) scene.add(this.clouds.mesh);
    this.sea = new CloudSea(th, -42);
    if (!OFF.has('sea')) scene.add(this.sea.mesh);

    // Materials.
    const img = this.assets.colormap;
    const lam = (map: THREE.Texture) => {
      const m = new THREE.MeshLambertMaterial({ map, vertexColors: true });
      this.mats.push(m);
      return m;
    };
    const grassTex = skinTexture(img, 'grass', th.id);
    const grass = lam(grassTex);
    const stone = lam(skinTexture(img, 'stone', th.id));
    const castle = lam(skinTexture(img, 'castle', th.id));
    const props = lam(grassTex);
    const rock = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.water = waterMaterial(th);
    this.mats.push(rock, this.water);
    const plain = skinTexture(img, 'plain', th.id);
    this.kitMat = new THREE.MeshStandardMaterial({ map: plain, roughness: 0.5, metalness: 0.15, envMapIntensity: 0.8 });
    this.coinMat = new THREE.MeshStandardMaterial({ map: plain, roughness: 0.25, metalness: 0.65, emissive: '#ffb000', emissiveIntensity: 0.28, envMapIntensity: 1.4 });
    const crumble = new THREE.MeshLambertMaterial({ map: skinTexture(img, 'stone', th.id), color: new THREE.Color(1.05, 0.82, 0.6) });
    this.mats.push(this.kitMat, this.coinMat, crumble);

    const terrain = buildTerrain(this.level, this.assets, th, { grass, stone, castle, props, rock, water: this.water }, true);
    if (!OFF.has('terrain')) scene.add(terrain.group);
    for (const m of terrain.meshes) this.chunks.push({ mesh: m, z: m.geometry.boundingSphere?.center.z ?? 0 });

    // Physics boxes and the dynamic ones' visuals.
    const blocks = mysteryMaterials();
    this.level.boxes.forEach((def, id) => {
      const x0 = laneX(def.l0) - LANE_W / 2;
      const x1 = laneX(def.l1) + LANE_W / 2;
      const solid: Solid = { id, s0: def.s0, s1: def.s1, x0, x1, top: def.top, bottom: def.top - def.depth, kind: def.kind, solid: true, dTop: 0 };
      if (def.kind === 'mystery' || def.kind === 'crate') {
        solid.x0 = laneX(def.l0) - (def.kind === 'mystery' ? 0.5 : 0.4);
        solid.x1 = laneX(def.l1) + (def.kind === 'mystery' ? 0.5 : 0.4);
      }
      this.idx.add(solid);
      let mesh: THREE.Object3D | null = null;
      const w = x1 - x0;
      const l = def.s1 - def.s0;
      const cx = (x0 + x1) / 2;
      const cs = (def.s0 + def.s1) / 2;
      if (def.kind === 'mystery') {
        const m = new THREE.Mesh(blocks.geo, blocks.live);
        m.position.set(laneX(def.l0), def.top - 0.5, -cs);
        m.castShadow = true;
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#ff9cf0', transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
        halo.scale.setScalar(2.2);
        halo.name = 'halo';
        m.add(halo);
        mesh = m;
      } else if (def.kind === 'crate') {
        const m = new THREE.Mesh(this.assets.geo.get(def.contents === 'coins' ? 'crate-item' : 'crate-strong')!, this.kitMat);
        m.scale.setScalar(1.6);
        m.position.set(laneX(def.l0), def.top - 0.8, -cs);
        m.castShadow = true;
        m.receiveShadow = true;
        mesh = m;
      } else if (def.kind === 'mover') {
        const g = new THREE.Group();
        const top = new THREE.Mesh(this.assets.geo.get('block-moving-large')!, this.kitMat);
        top.scale.set(w, 0.6 / 0.5, l);
        top.position.y = -0.6;
        top.castShadow = true;
        top.receiveShadow = true;
        g.add(top);
        // Glowing jets underneath sell that it floats.
        for (const dx of [-w / 3, w / 3]) {
          const jet = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#7fe6ff', transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
          jet.position.set(dx, -0.75, 0);
          jet.scale.set(0.9, 0.5, 1);
          g.add(jet);
        }
        g.position.set(cx, def.top, -cs);
        mesh = g;
      } else if (def.kind === 'crumble') {
        const m = new THREE.Mesh(this.assets.geo.get('block-grass-low-large')!, crumble);
        m.scale.set(w / 2.08, 0.6 / 0.5, l / 2.08);
        m.position.set(cx, def.top - 0.6, -cs);
        m.castShadow = true;
        m.receiveShadow = true;
        mesh = m;
      }
      if (mesh) scene.add(mesh);
      const rt: BoxRt = { def, solid, mesh, base: def.top, touched: -1, fallV: 0, fall: 0, used: false, bounce: 0 };
      this.boxes.push(rt);
      this.byId.set(id, rt);
    });

    // Items and creatures.
    this.coins = new Coins(this.level.items, this.assets, this.coinMat);
    scene.add(this.coins.mesh);
    this.pickups = makePickups(this.level.items, this.assets, this.kitMat);
    for (const p of this.pickups) scene.add(p.group);
    this.enemies = makeEnemies(this.level.enemies, this.assets);
    for (const e of this.enemies) scene.add(e.root);
    scene.add(this.bolts.group);
    for (const h of hazardMeshes(this.level, this.assets, this.kitMat)) scene.add(h);
    this.springs = makeSprings(this.level, this.assets, this.kitMat);
    for (const s of this.springs) scene.add(s.group);
    this.flags = this.level.checkpoints.map((c) => makeFlag(c.s, c.y));
    for (const f of this.flags) scene.add(f.group);
    this.gate = makeGate(this.level, this.assets, this.kitMat);
    scene.add(this.gate.group);
    if (this.level.id === 1 || this.level.difficulty !== 'hard') {
      this.guides = makeGuides(this.level);
      if (this.guides) scene.add(this.guides.mesh);
    }
    scene.add(this.marker.ring, this.marker.blob, this.sparks.points, this.puffs.points, this.confetti.mesh, this.rings.group);

    // Invisible capsule so the player casts a sun shadow on the ground ahead (a strong depth cue).
    this.caster = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.15, 4, 8), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    this.caster.castShadow = true;
    scene.add(this.caster);

    this.hands = new Hands(sunDir, th.hemiSky, th.hemiGround);
  }

  private applyQuality(q: 'high' | 'medium' | 'low'): void {
    this.quality = q;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(q === 'high' ? Math.min(dpr, 1.5) : q === 'medium' ? Math.min(dpr, 1) : this.software ? 0.6 : 0.75);
    this.renderer.shadowMap.enabled = q !== 'low' && !OFF.has('shadow');
    const size = q === 'high' ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.resize();
  }

  private resize = (): void => {
    const w = this.el.clientWidth || window.innerWidth;
    const h = this.el.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w / h < 1.4 ? 72 : 64;
    this.camera.updateProjectionMatrix();
    const px = h * this.renderer.getPixelRatio();
    this.sparks.setViewportHeight(px, this.camera.fov);
    this.puffs.setViewportHeight(px, this.camera.fov);
  };

  private begin(): void {
    const a = this.ctx.audio;
    a.music.gain.value = this.ctx.settings.musicVolume;
    a.sfx.gain.value = this.ctx.settings.sfxVolume;
    this.sfx.playMusic(this.assets.music.get(this.level.theme), 1);
    this.ctx.cursor(false);
    const start = this.opts.startCp ?? -1;
    if (start >= 0 && start < this.level.checkpoints.length) {
      this.cp = start;
      for (let i = 0; i <= start; i++) this.activateFlag(i, true);
    }
    this.placeAtCheckpoint();
    this.state = 'intro';
    this.stateT = 0;
    this.hud.title.classList.add('show');
    this.lastFrame = performance.now();
    this.lastPoseT = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private placeAtCheckpoint(): void {
    const p = this.player;
    const c = this.cp >= 0 ? this.level.checkpoints[this.cp] : { s: 0.5, y: 0 };
    p.s = c.s;
    p.y = c.y;
    p.x = 0;
    p.vy = 0;
    p.vs = 0;
    p.grounded = true;
    p.jumping = false;
    p.boosted = false;
    p.ground = supportAt(this.idx, p.s, 0, p.y + 0.05);
    p.lastGroundT = this.gt;
    p.lastGroundY = p.y;
    this.planner.reset(p.s);
    // Crumbled tiles come back.
    for (const b of this.boxes) {
      if (b.def.kind !== 'crumble') continue;
      b.touched = -1;
      b.fall = 0;
      b.fallV = 0;
      b.solid.solid = true;
      b.solid.top = b.base;
      b.solid.bottom = b.base - b.def.depth;
      if (b.mesh) {
        b.mesh.visible = true;
        b.mesh.rotation.set(0, 0, 0);
      }
    }
  }

  // ---- main loop -------------------------------------------------------------------------------------------

  private frames = 0;
  private prof2 = { tick: 0, vis: 0, build: 0 };
  private renderMs = 0;
  private mainCalls = 0;
  private mainTris = 0;
  private software = false;

  private frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    this.frames++;
    const real = Math.min(0.25, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    if (real > 0) this.fpsAvg += 0.05 * (1 / Math.max(real, 1e-3) - this.fpsAvg);
    this.autoQuality(now);
    const a0 = performance.now();
    if (!this.paused) {
      const dt = real * this.timeScale;
      this.gt += dt;
      this.stateT += real;
      this.processPose(now);
      this.tick(dt, real, now);
    }
    const a1 = performance.now();
    this.visuals(this.paused ? 0 : real * this.timeScale, now);
    const a2 = performance.now();
    this.updateHud(now);
    this.prof2.tick += 0.2 * (a1 - a0 - this.prof2.tick);
    this.prof2.vis += 0.2 * (a2 - a1 - this.prof2.vis);
    // Test switch: skip most renders so logic and the bot run in real time on software WebGL.
    if (SKIP > 1 && this.frames % SKIP !== 0) return;
    const t0 = performance.now();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.mainCalls = this.renderer.info.render.calls;
    this.mainTris = this.renderer.info.render.triangles;
    this.renderer.clearDepth();
    this.hands.follow(this.camera);
    if (!OFF.has('hands')) this.renderer.render(this.hands.scene, this.camera);
    this.renderMs += 0.2 * (performance.now() - t0 - this.renderMs);
  };

  private autoQuality(now: number): void {
    if (this.ctx.settings.quality !== 'auto' || this.software || this.perfChecked || now - this.startedAt < 6000) return;
    this.perfChecked = true;
    if (this.fpsAvg < 38) this.applyQuality('low');
    else if (this.fpsAvg < 50) this.applyQuality('medium');
  }

  private processPose(now: number): void {
    const frames = this.ctx.pose.since(this.lastPoseT);
    for (const f of frames) {
      this.lastPoseT = f.t;
      const b = this.ctx.body.measure(f);
      if (b.ok) this.latestBody = b;
      this.input.feed(b);
    }
    const intents = this.input.drain();
    if (this.state === 'play') for (const it of intents) this.onIntent(it, now);
    if (!this.ctx.demo && this.state === 'play' && this.pauseGesture.update(this.latestBody, now)) void this.pause();
  }

  /** Game clock time at a performance.now() capture time. */
  private gtAt(tMs: number, now: number): number {
    return this.gt - Math.max(0, Math.min(0.5, (now - tMs) / 1000));
  }

  private onIntent(it: Intent, now: number): void {
    const p = this.player;
    if (it.type === 'step') {
      this.stepsSeen++;
      return;
    }
    if (it.type === 'takeoff') {
      const r = requestJump(p, this.gtAt(it.t, now), this.gt, this.cfg, this.idx);
      this.note(`takeoff -> ${r}`);
      if (r === 'jump') this.onJump(false);
      else if (r === 'double') this.onDouble();
    } else if (it.type === 'big') {
      const r = requestBig(p, this.gtAt(it.t, now), this.gt, this.cfg);
      this.note(`big -> ${r}`);
      if (r === 'double') this.onDouble(true);
      else if (r === 'jump') this.onJump(true);
    } else if (it.type === 'punch') this.shoot(it.hand, it.aim.x);
  }

  private onJump(big: boolean): void {
    this.jumps++;
    this.sfx.jump(big);
    const at = this.feet();
    this.puffs.emit(at, 8, new THREE.Color('#ffffff'), { speed: 1.6, life: 0.5, size: 0.35, gravity: -0.5, spread: 0.6 });
  }

  private onDouble(big = false): void {
    this.doubles++;
    this.sfx.double();
    const at = this.feet();
    this.rings.spawn(at, new THREE.Color(big ? '#ffd84d' : '#9ff3ff'), 2.2, 0.45, true, 0.9);
    this.sparks.emit(at, 18, new THREE.Color(big ? '#ffd84d' : '#9ff3ff'), { speed: 4, life: 0.5, size: 0.16, gravity: 2 });
    this.banner(big ? 'Big jump!' : 'Double jump!', 'jump');
  }

  private feet(): THREE.Vector3 {
    return new THREE.Vector3(this.player.x, this.player.y, -this.player.s);
  }

  private tick(dt: number, real: number, now: number): void {
    const p = this.player;
    if (this.state === 'intro') {
      const t = this.stateT;
      const n = t < 1.6 ? '' : t < 2.2 ? '3' : t < 2.8 ? '2' : t < 3.4 ? '1' : 'GO!';
      if (n !== this.hud.count.textContent) {
        this.hud.count.textContent = n;
        this.hud.count.classList.remove('pop');
        void this.hud.count.offsetWidth;
        if (n) this.hud.count.classList.add('pop');
        if (n) this.sfx.beep(n === 'GO!');
      }
      if (t > 1.5) this.hud.title.classList.remove('show');
      if (t >= 3.4) {
        this.state = 'play';
        this.stateT = 0;
        setTimeout(() => (this.hud.count.textContent = ''), 600);
      }
      this.updateSolids(this.gt, dt);
      return;
    }
    if (this.state === 'play' || this.state === 'goal' || this.state === 'falling') {
      if (this.state === 'play') this.playTime += dt;
      const speed =
        this.state === 'goal'
          ? Math.max(0, 2.4 - (p.s - this.level.goal.s) * 0.45)
          : this.state === 'falling'
            ? p.vs
            : this.input.speed(now, this.prof.maxSpeed, this.prof.autoSpeed, this.prof.autoRun);
      const lane = this.state === 'goal' ? 0 : this.input.lane;
      const duck = this.state === 'play' && this.input.duck;
      // Ducking is a slide: keep momentum (at least a jog) for a moment, so you glide under logs.
      let runSpeed = speed;
      if (duck) {
        if (this.slideT < 0) {
          this.slideT = this.gt;
          this.slideV = Math.max(p.vs, this.prof.autoSpeed * 0.9);
          this.sfx.jump(false);
        }
        const k = Math.max(0, 1 - (this.gt - this.slideT) / 1.6);
        runSpeed = Math.max(speed, this.slideV * (0.45 + 0.55 * k));
      } else this.slideT = -1;
      let left = dt;
      let t = this.gt - dt;
      while (left > 1e-6) {
        const h = Math.min(SUBSTEP, left);
        left -= h;
        t += h;
        this.updateSolids(t, h);
        const ev = stepPlayer(p, { speed: runSpeed, x: laneX(lane), duck }, this.idx, h, t, this.cfg);
        this.onStep(ev, t);
        if (this.state === 'play') this.interact(t, h);
      }
      if (this.state === 'play') {
        if (!p.grounded && p.y < p.lastGroundY - 7) this.startFall();
        if (p.s >= this.level.goal.s) this.finish();
      }
      if (this.state === 'falling' && this.stateT > 0.9) this.respawn();
      if (this.state === 'goal' && this.stateT > 1.1) this.timeScale = Math.min(1, this.timeScale + real * 1.5);
    } else if (this.state === 'respawn') {
      this.updateSolids(this.gt, dt);
      if (this.stateT > 0.45) {
        this.hud.fade.classList.remove('on');
        this.state = 'play';
        this.stateT = 0;
      }
    } else this.updateSolids(this.gt, dt);
  }

  private updateSolids(t: number, h: number): void {
    const p = this.player;
    for (const b of this.boxes) {
      const d = b.def;
      if (d.mover) {
        const top = b.base + d.mover.amp * (0.5 - 0.5 * Math.cos(2 * Math.PI * (t / d.mover.period + d.mover.phase)));
        b.solid.dTop = top - b.solid.top;
        b.solid.top = top;
        b.solid.bottom = top - d.depth;
      } else if (d.kind === 'crumble') {
        if (b.touched < 0 && p.grounded && p.ground === b.solid) {
          b.touched = t;
          this.sfx.step();
        }
        if (b.touched >= 0 && t - b.touched > 0.5) {
          b.fallV += 16 * h;
          const dy = b.fallV * h;
          b.fall += dy;
          b.solid.dTop = -dy;
          b.solid.top = b.base - b.fall;
          b.solid.bottom = b.solid.top - d.depth;
          if (b.fall > 2.5) b.solid.solid = false;
        } else b.solid.dTop = 0;
      }
    }
  }

  private onStep(ev: StepEvents, t: number): void {
    const p = this.player;
    if (ev.landed || ev.mantle) {
      const vy = ev.landed ? -ev.landed.vy : 3;
      if (t - this.lastLandT > 0.15) {
        const k = Math.min(1, vy / 14);
        this.dipV -= 0.6 + k * 2.4;
        this.hands.land(0.3 + k);
        this.sfx.land(k + 0.2);
        if (vy > 6) this.puffs.emit(this.feet().add(new THREE.Vector3(0, 0.05, -0.6)), Math.round(4 + k * 10), new THREE.Color('#fffaf0'), { speed: 2.2, life: 0.55, size: 0.45, gravity: -0.3, spread: 0.8 });
        if (vy > 10) this.shake = Math.max(this.shake, 0.15);
      }
      this.lastLandT = t;
      const box = ev.landed?.box;
      if (box && box.kind === 'crate' && this.state === 'play') {
        const rt = this.byId.get(box.id);
        if (rt && !rt.used) {
          this.breakCrate(rt);
          launch(p, STOMP_APEX, this.cfg);
          this.stomps++;
        }
      }
    }
    if (ev.bufferedJump) this.onJump(false);
    if (ev.ceiling) {
      const rt = this.byId.get(ev.ceiling.id);
      this.sfx.bump();
      this.dipV -= 1.2;
      if (rt && rt.def.kind === 'mystery') this.hitBlock(rt);
    }
    if (ev.bonk && this.state === 'play') {
      if (ev.bonk.kind === 'crate') this.crateBlockT = t;
      else this.wallBlockT = t;
    }
  }

  // ---- interactions ---------------------------------------------------------------------------------------

  private interact(t: number, h: number): void {
    const p = this.player;
    const feet = this.feet();
    // Coins.
    const magnet = this.power?.kind === 'magnet' ? 4.5 : 0;
    this.coins.collect(feet, p.height, magnet, h, () => this.gotCoin());
    // Pickups.
    for (const pk of this.pickups) {
      if (pk.taken) continue;
      const g = pk.group.position;
      if (Math.abs(g.z - feet.z) > 0.9 || Math.abs(g.x - p.x) > 0.85) continue;
      if (g.y < p.y - 0.3 || g.y > p.y + p.height + 0.5) continue;
      pk.taken = true;
      this.collectPickup(pk.def.kind, pk.def.power, pk.group);
    }
    // Enemies.
    for (const e of this.enemies) {
      if (!e.alive || Math.abs(e.z - feet.z) > 6) continue;
      enemyPose(e, t, this.prof.enemySpeed);
      if (Math.abs(e.z - feet.z) > 0.75 || Math.abs(e.x - p.x) > 0.8) continue;
      const fly = flying(e.def.kind);
      const bottom = fly ? e.y - 0.45 : e.y;
      const top = fly ? e.y + 0.45 : e.y + (e.def.kind === 'spiky' ? 1.25 : 0.95);
      if (p.y > top || p.y + p.height < bottom) continue;
      if (p.vy < -1 && p.y > top - 0.5 && e.def.kind !== 'spiky') {
        this.note(`stomp ${e.def.kind}`);
        this.defeat(e, true);
        launch(p, STOMP_APEX, this.cfg);
        this.stomps++;
        this.sfx.stomp();
        this.banner('Stomp!', 'good');
      } else if (this.hurt()) this.note(`hit by ${e.def.kind} at x=${e.x.toFixed(1)} (me ${p.x.toFixed(1)}, y ${p.y.toFixed(1)})`);
    }
    // Hazards.
    for (const hz of this.level.hazards) {
      if (hz.s1 < p.s - 1 || hz.s0 > p.s + 1) continue;
      const x0 = laneX(hz.l0) - LANE_W / 2;
      const x1 = laneX(hz.l1) + LANE_W / 2;
      if (p.x < x0 - 0.05 || p.x > x1 + 0.05) continue;
      if (hz.kind === 'spikes') {
        if (p.s > hz.s0 + 0.12 && p.s < hz.s1 - 0.12 && p.y - hz.y < 0.25 && p.y >= hz.y - 0.3) {
          if (this.hurt()) {
            this.note('spikes');
            launch(p, 1.4, this.cfg);
          }
        }
      } else if (p.s + R > hz.s0 && p.s - R < hz.s1 && p.y + p.height > hz.y + 1.27 && p.y < hz.y + 1.67 && this.hurt()) this.note(`log (height ${p.height.toFixed(2)})`);
    }
    // Springs.
    for (const sp of this.springs) {
      const d = sp.def;
      if (p.grounded && Math.abs(p.s - d.s) < 0.65 && Math.abs(p.x - laneX(d.lane)) < 0.8 && Math.abs(p.y - d.y) < 0.2) {
        launch(p, SPRING_APEX, this.cfg);
        sp.t = 0;
        this.sfx.spring();
        this.rings.spawn(this.feet().add(new THREE.Vector3(0, 0.3, 0)), new THREE.Color('#ffe066'), 2.6, 0.5);
        this.sparks.emit(this.feet(), 24, new THREE.Color('#ffe066'), { speed: 5, life: 0.6, up: 4, size: 0.16 });
        this.banner('Boing!', 'jump');
        this.jumps++;
      }
    }
    // Checkpoints.
    for (let i = this.cp + 1; i < this.level.checkpoints.length; i++) {
      if (p.s >= this.level.checkpoints[i].s) {
        this.cp = i;
        this.activateFlag(i, false);
      }
    }
    // Power-up timer.
    if (this.power && this.playTime > this.power.until) this.power = null;
  }

  private gotCoin(): void {
    this.coinCount++;
    this.sfx.coin((Math.random() - 0.5) * 0.3);
    this.hud.coinBox.classList.remove('bump');
    void this.hud.coinBox.offsetWidth;
    this.hud.coinBox.classList.add('bump');
  }

  private collectPickup(kind: 'gem' | 'heart' | 'power' | 'coin', power: PowerKind | undefined, obj: THREE.Object3D): void {
    const at = obj.getWorldPosition(new THREE.Vector3());
    obj.visible = false;
    if (kind === 'gem') {
      this.gems++;
      this.sfx.gem();
      this.sparks.emit(at, 40, new THREE.Color('#8fc8ff'), { speed: 5, life: 0.8, size: 0.2, gravity: 1 });
      this.banner('Star gem!', 'gem');
    } else if (kind === 'heart') {
      if (this.hearts < 3) this.hearts++;
      else this.coinCount += 5;
      this.sfx.heart();
      this.sparks.emit(at, 24, new THREE.Color('#ff8fa8'), { speed: 3, life: 0.7, size: 0.2, gravity: 0 });
      this.banner('+1 heart', 'good');
    } else if (kind === 'power' && power) {
      this.power = { kind: power, until: this.playTime + POWER_TIME[power] };
      this.sfx.power();
      this.sparks.emit(at, 36, powerColor(power), { speed: 5, life: 0.8, size: 0.2, gravity: 0 });
      this.banner(POWER_NAME[power] + '!', 'power');
    }
  }

  private activateFlag(i: number, silent: boolean): void {
    const f = this.flags[i];
    if (!f || f.on) return;
    f.on = true;
    if (silent) {
      f.mat.uniforms.uOn.value = 1;
      return;
    }
    this.sfx.checkpoint();
    const at = f.group.position.clone().add(new THREE.Vector3(0, 2.6, 0));
    this.sparks.emit(at, 40, new THREE.Color('#ffd84d'), { speed: 5, life: 0.9, size: 0.2, gravity: 2 });
    this.rings.spawn(f.group.position.clone().add(new THREE.Vector3(-2.1, 0.1, 0)), new THREE.Color('#ffd84d'), 4, 0.8);
    this.banner('Checkpoint!', 'cp');
  }

  /** Returns true if the hit counted. */
  private hurt(): boolean {
    if (this.playTime < this.invulnUntil) return false;
    if (this.power?.kind === 'shield') {
      this.invulnUntil = this.playTime + 0.8;
      this.sfx.shieldPop();
      this.sparks.emit(this.feet().add(new THREE.Vector3(0, 1.2, -0.5)), 30, new THREE.Color('#7fd8ff'), { speed: 4, life: 0.5, size: 0.18 });
      return false;
    }
    this.hearts--;
    this.damaged = true;
    this.invulnUntil = this.playTime + this.prof.invuln;
    this.shake = 0.35;
    this.hurtFlash = 1;
    this.sfx.hurt();
    this.player.vs = Math.min(this.player.vs, 1.5);
    if (this.hearts <= 0) {
      if (this.prof.noGameOver) this.hearts = 1;
      else this.gameOver();
    }
    return true;
  }

  private startFall(): void {
    this.note(`fell (x ${this.player.x.toFixed(1)}, last ground ${this.player.lastGroundY.toFixed(1)})`);
    this.state = 'falling';
    this.stateT = 0;
    this.sfx.fall();
    this.falls++;
    this.bot?.respawned();
  }

  private respawn(): void {
    this.hud.fade.classList.add('on');
    this.hearts--;
    this.damaged = true;
    if (this.hearts <= 0) {
      if (this.prof.noGameOver) this.hearts = 1;
      else {
        this.gameOver();
        return;
      }
    }
    this.state = 'respawn';
    this.stateT = 0;
    this.placeAtCheckpoint();
    this.invulnUntil = this.playTime + 1.5;
  }

  private gameOver(): void {
    if (this.state === 'over') return;
    this.state = 'over';
    this.stateT = 0;
    this.hud.count.textContent = 'Out of hearts';
    this.hud.count.className = 'q-count pop over';
    this.sfx.duckMusic(0.0001, 1.5);
    setTimeout(() => this.end(false), 2600);
  }

  private defeat(e: Enemy, stomped: boolean): void {
    if (!e.alive) return;
    e.alive = false;
    e.dying = 0.55;
    this.enemiesDown++;
    playOnce(e, 'Death');
    const at = new THREE.Vector3(e.x, e.y + e.cy, e.z);
    const color = e.def.kind === 'pink' ? '#ff7ac8' : e.def.kind === 'bee' ? '#ffd84d' : e.def.kind === 'glub' ? '#b07cff' : '#7cff6b';
    this.sparks.emit(at, 34, new THREE.Color(color), { speed: 6, life: 0.7, size: 0.22, gravity: 4 });
    this.sparks.emit(at, 12, new THREE.Color('#ffffff'), { speed: 3, life: 0.4, size: 0.3, gravity: 0 });
    this.puffs.emit(at, 8, new THREE.Color('#ffffff'), { speed: 2, life: 0.6, size: 0.6, gravity: -0.5 });
    this.rings.spawn(at, new THREE.Color(color), 1.6, 0.35, false, 0.8);
    if (!stomped) this.sfx.pop((e.x - this.player.x) / 3);
    this.popup(at, '+100');
  }

  private hitBlock(rt: BoxRt): void {
    if (rt.used || !rt.mesh) return;
    rt.used = true;
    rt.bounce = 1;
    const m = rt.mesh as THREE.Mesh;
    m.material = mysteryMaterials().used;
    const halo = m.getObjectByName('halo');
    if (halo) halo.visible = false;
    const at = m.position.clone().add(new THREE.Vector3(0, 0.6, 0.3));
    this.sparks.emit(at, 30, new THREE.Color('#ffe6ff'), { speed: 5, life: 0.6, size: 0.2, gravity: 3 });
    this.sfx.pop();
    this.release(rt.def.contents ?? 'coins', at);
  }

  private breakCrate(rt: BoxRt): void {
    if (rt.used) return;
    rt.used = true;
    rt.solid.solid = false;
    if (rt.mesh) rt.mesh.visible = false;
    const at = new THREE.Vector3(laneX(rt.def.l0), rt.def.top - 0.4, -(rt.def.s0 + rt.def.s1) / 2);
    this.sparks.emit(at, 26, new THREE.Color('#c98a4a'), { speed: 6, life: 0.7, size: 0.22, gravity: 9 });
    this.puffs.emit(at, 10, new THREE.Color('#e8d2b0'), { speed: 2.5, life: 0.6, size: 0.6, gravity: -0.4 });
    this.sfx.crate();
    this.release(rt.def.contents ?? 'coins', at);
  }

  private release(c: Contents, at: THREE.Vector3): void {
    if (c === 'coins') {
      this.coins.pop(at, BLOCK_COINS);
      return;
    }
    // Other contents float out and fly to the player.
    const kind = c === 'heart' ? 'heart' : c === 'gem' ? 'gem' : 'power';
    const def = { kind, s: -at.z, x: at.x, y: at.y, power: kind === 'power' ? (c as PowerKind) : undefined } as const;
    const [pk] = makePickups([def], this.assets, this.kitMat);
    this.scene.add(pk.group);
    this.flyers.push({ obj: pk.group, from: at.clone(), t: 0, done: () => this.collectPickup(kind, def.power, pk.group) });
  }

  // ---- shooting -----------------------------------------------------------------------------------------------

  private targetsAhead(): { pos: THREE.Vector3; kind: 'enemy' | 'block' | 'crate'; ref: Enemy | BoxRt }[] {
    const p = this.player;
    const out: { pos: THREE.Vector3; kind: 'enemy' | 'block' | 'crate'; ref: Enemy | BoxRt }[] = [];
    for (const e of this.enemies) {
      if (!e.alive || -e.z < p.s + 0.3 || -e.z > p.s + 34) continue;
      out.push({ pos: new THREE.Vector3(e.x, e.y + e.cy, e.z), kind: 'enemy', ref: e });
    }
    for (const b of this.boxes) {
      if (b.used || (b.def.kind !== 'mystery' && b.def.kind !== 'crate')) continue;
      const s = (b.def.s0 + b.def.s1) / 2;
      if (s < p.s + 0.3 || s > p.s + 30) continue;
      out.push({ pos: new THREE.Vector3(laneX(b.def.l0), b.def.top - (b.def.kind === 'crate' ? 0.4 : 0.5), -s), kind: b.def.kind === 'crate' ? 'crate' : 'block', ref: b });
    }
    return out;
  }

  private botTargets(): BotTarget[] {
    return this.targetsAhead().map((t, i) => ({
      id: t.kind === 'enemy' ? this.enemies.indexOf(t.ref as Enemy) : 1000 + this.boxes.indexOf(t.ref as BoxRt) + i * 0,
      x: t.pos.x,
      y: t.pos.y,
      s: -t.pos.z,
      kind: t.kind,
    }));
  }

  private shoot(hand: 0 | 1, aimX: number): void {
    this.shots++;
    const triple = this.power?.kind === 'triple';
    const cam = this.camera;
    cam.updateMatrixWorld();
    const muzzle = this.hands.muzzle(hand).applyMatrix4(cam.matrixWorld);
    // Aim assist: the nearest target on that hand's half of the screen.
    const cands = this.targetsAhead()
      .map((t) => {
        const ndc = t.pos.clone().project(cam);
        return { t, ndc, d: t.pos.distanceTo(cam.position) };
      })
      .filter((c) => c.ndc.z < 1 && Math.abs(c.ndc.y) < 1.2 && (hand === 0 ? c.ndc.x < 0.35 : c.ndc.x > -0.35) && Math.abs(c.ndc.x) < 1.3)
      .sort((a, b) => a.d + Math.abs(a.ndc.x - (hand ? 0.2 : -0.2)) * 6 - (b.d + Math.abs(b.ndc.x - (hand ? 0.2 : -0.2)) * 6));
    const color = triple ? new THREE.Color('#ffd84d') : new THREE.Color(hand === 0 ? '#ffb27a' : '#8ff8ff');
    const n = triple ? 3 : 1;
    for (let k = 0; k < n; k++) {
      const c = cands[k] ?? cands[0];
      let dir: THREE.Vector3;
      let target: Bolt['target'] = null;
      if (c) {
        const ref = c.t.ref;
        const kind = c.t.kind;
        const pos = () =>
          kind === 'enemy' ? new THREE.Vector3((ref as Enemy).x, (ref as Enemy).y + (ref as Enemy).cy, (ref as Enemy).z) : c.t.pos.clone();
        const alive = () => (kind === 'enemy' ? (ref as Enemy).alive : !(ref as BoxRt).used);
        target = { pos, alive };
        dir = pos().sub(muzzle);
      } else {
        dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), -(hand ? 0.05 : -0.05) - aimX * 0.05);
        dir.y += 0.03;
      }
      if (n > 1 && !cands[k]) dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), (k - 1) * 0.12);
      this.bolts.fire(muzzle, dir, color, target);
    }
    const local = new THREE.Vector3(0, 0, -1);
    if (cands[0]) local.copy(cands[0].t.pos).applyMatrix4(cam.matrixWorldInverse).normalize();
    this.hands.punch(hand, local, color);
    this.sfx.shoot(hand ? 0.4 : -0.4, triple);
  }

  private boltHit(b: Bolt): boolean {
    for (const e of this.enemies) {
      if (!e.alive || Math.abs(e.z - b.pos.z) > 1.2) continue;
      const d = Math.hypot(e.x - b.pos.x, e.y + e.cy - b.pos.y, e.z - b.pos.z);
      if (d < e.r + 0.25) {
        this.defeat(e, false);
        return true;
      }
    }
    for (const rt of this.boxes) {
      if (rt.used || (rt.def.kind !== 'mystery' && rt.def.kind !== 'crate')) continue;
      const s = rt.solid;
      if (b.pos.z < -s.s1 - 0.2 || b.pos.z > -s.s0 + 0.2 || b.pos.x < s.x0 - 0.2 || b.pos.x > s.x1 + 0.2 || b.pos.y < s.bottom - 0.2 || b.pos.y > s.top + 0.2) continue;
      if (rt.def.kind === 'mystery') this.hitBlock(rt);
      else this.breakCrate(rt);
      return true;
    }
    // Solid ground stops bolts.
    const sup = supportAt(this.idx, -b.pos.z, b.pos.x, b.pos.y, 0);
    if (sup && b.pos.y < sup.top - 0.05 && b.pos.y > sup.bottom) {
      this.sparks.emit(b.pos, 6, b.color, { speed: 2, life: 0.3, size: 0.12 });
      return true;
    }
    return false;
  }

  // ---- visuals ---------------------------------------------------------------------------------------------------

  private visuals(dt: number, now: number): void {
    const time = now / 1000;
    const p = this.player;
    const th = this.theme;
    // Camera.
    const running = this.state === 'play' && p.grounded && p.vs > 0.5;
    this.runK += ((running ? Math.min(1, p.vs / 6) : 0) - this.runK) * Math.min(1, dt * 6);
    this.stepPhase += dt * (5 + p.vs * 1.4) * (running ? 1 : 0.2);
    // Landing dip: a damped spring, integrated in small steps so it stays stable at any frame rate.
    for (let left = dt; left > 1e-6; left -= 1 / 120) {
      const h = Math.min(1 / 120, left);
      this.dipV += (-this.dip * 90 - this.dipV * 12) * h;
      this.dip = Math.max(-0.7, Math.min(0.3, this.dip + this.dipV * h));
    }
    this.shake = Math.max(0, this.shake - dt * 1.4);
    const sh = this.shake * this.shake * 0.6;
    const eye = 1.62 - (1.75 - p.height) * 0.9;
    const bob = Math.abs(Math.sin(this.stepPhase)) * 0.05 * this.runK;
    let cy = p.y + eye + bob + this.dip * 0.6;
    let cz = -p.s + 0.05;
    let cx = p.x;
    let pitchTarget = -0.1;
    if (!p.grounded && p.vy < 0) pitchTarget = -0.1 - Math.min(0.2, -p.vy * 0.018);
    if (this.state === 'falling') pitchTarget = -0.6;
    if (this.state === 'goal') pitchTarget = 0.08;
    this.camPitch += (pitchTarget - this.camPitch) * Math.min(1, dt * 4);
    if (this.state === 'intro') {
      const k = Math.min(1, this.stateT / 3.2);
      const e = 1 - Math.pow(1 - k, 3);
      cy += (1 - e) * 3.5;
      cz += (1 - e) * 7;
      this.camPitch = -0.1 - (1 - e) * 0.25;
    }
    this.camera.position.set(cx + (Math.random() - 0.5) * sh, cy + (Math.random() - 0.5) * sh, cz);
    const roll = -(this.input.lane * LANE_W - p.x) * 0.02 + Math.sin(this.stepPhase) * 0.006 * this.runK;
    this.camera.rotation.set(this.camPitch, -(this.input.lane * LANE_W - p.x) * 0.012, roll, 'YXZ');
    const fov = (this.camera.aspect < 1.4 ? 72 : 64) + Math.min(6, p.vs * 0.5) + (!p.grounded && p.vy > 6 ? 3 : 0);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 3);
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
    this.sky.follow(this.camera);
    this.clouds.update(dt, this.camera.position.z);
    this.sea.update(time, this.camera);
    this.water.uniforms.uTime.value = time;
    if (this.guides) this.guides.mat.uniforms.uTime.value = time;
    // Shadows follow the player.
    const dir = this.sun.userData.dir as THREE.Vector3;
    const focus = new THREE.Vector3(p.x, p.y, -p.s - 10);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(dir, 60);
    this.caster.position.set(p.x, p.y + p.height / 2, -p.s);
    this.caster.scale.y = p.height / 1.75;
    // Chunks far behind or beyond the fog are skipped.
    const camZ = this.camera.position.z;
    for (const c of this.chunks) c.mesh.visible = c.z < camZ + 50 && c.z > camZ - th.fogFar + 10;

    // Coins, pickups, flyers.
    this.coins.draw(dt, time, this.camera.position, this.feet(), this.camera.quaternion);
    for (const pk of this.pickups) {
      if (pk.taken) continue;
      const g = pk.group;
      const near = g.position.z > camZ - 160 && g.position.z < camZ + 5;
      g.visible = near;
      if (!near) continue;
      g.rotation.y = time * 2;
      g.children[0].position.y = (pk.def.kind === 'power' ? 0 : g.children[0].position.y) + 0;
      g.position.y = pk.def.y + Math.sin(time * 2.2 + pk.def.s) * 0.12;
    }
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i];
      f.t += dt;
      const k = Math.min(1, f.t / 0.9);
      const target = this.camera.position.clone().add(new THREE.Vector3(0, -0.4, -0.8).applyQuaternion(this.camera.quaternion));
      const up = f.from.clone().add(new THREE.Vector3(0, 1.2, 0));
      const pos = k < 0.45 ? f.from.clone().lerp(up, k / 0.45) : up.lerp(target, (k - 0.45) / 0.55);
      f.obj.position.copy(pos);
      f.obj.rotation.y = time * 4;
      if (k >= 1) {
        f.done();
        this.scene.remove(f.obj);
        this.flyers.splice(i, 1);
      }
    }

    // Blocks, movers, crumbles.
    for (const b of this.boxes) {
      if (!b.mesh) continue;
      const d = b.def;
      if (d.kind === 'mystery') {
        b.bounce = Math.max(0, b.bounce - dt * 4);
        const m = b.mesh;
        m.position.y = d.top - 0.5 + Math.sin(b.bounce * Math.PI) * 0.35;
        if (!b.used) m.rotation.y = Math.sin(time * 1.5 + d.s0) * 0.08;
        const mat = (m as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (!b.used) mat.emissiveIntensity = 0.38 + 0.18 * Math.sin(time * 4);
      } else if (d.kind === 'mover') {
        b.mesh.position.y = b.solid.top;
      } else if (d.kind === 'crumble') {
        const shaking = b.touched >= 0 && this.gt - b.touched < 0.5;
        b.mesh.position.set(
          (laneX(d.l0) + laneX(d.l1)) / 2 + (shaking ? (Math.random() - 0.5) * 0.08 : 0),
          b.solid.top - 0.6,
          -(d.s0 + d.s1) / 2 + (shaking ? (Math.random() - 0.5) * 0.05 : 0),
        );
        if (b.fall > 0) b.mesh.rotation.set(b.fall * 0.08, 0, b.fall * 0.05);
        if (b.fall > 30) b.mesh.visible = false;
        if (shaking && Math.random() < dt * 20) this.puffs.emit(new THREE.Vector3(b.mesh.position.x, d.top - 0.7, b.mesh.position.z), 1, new THREE.Color('#e8cfa8'), { speed: 1, life: 0.6, size: 0.4, gravity: 1 });
      }
    }

    // Enemies: animation and visibility.
    for (const e of this.enemies) {
      const near = e.z > camZ - 70 && e.z < camZ + 6;
      if (!near && !e.root.visible) continue;
      e.root.visible = near && (e.alive || e.dying > 0);
      if (!e.root.visible) continue;
      if (e.alive) enemyPose(e, this.gt, this.prof.enemySpeed);
      else e.dying -= dt;
      e.mixer.update(dt);
      e.root.position.set(e.x, e.y + (flying(e.def.kind) ? -0.45 : 0), e.z);
      // Face the player; walkers turn a little toward where they are heading.
      const vx = e.def.sweep ? Math.cos(this.gt * 1.3 + e.phase) : 0;
      e.root.rotation.y = Math.atan2(p.x - e.x, -p.s - e.z) * 0.6 + vx * 0.5;
      if (!e.alive) e.root.scale.setScalar(Math.max(0.01, e.dying / 0.55));
    }

    // Springs, flags, gate.
    for (const s of this.springs) {
      s.t = Math.min(1, s.t + dt * 3);
      const k = s.t < 1 ? Math.sin(s.t * Math.PI * 3) * (1 - s.t) : 0;
      s.group.scale.set(1 - k * 0.15, 1 + k * 0.6, 1 - k * 0.15);
    }
    for (const f of this.flags) {
      f.mat.uniforms.uTime.value = time;
      const target = f.on ? 1 : 0;
      f.mat.uniforms.uOn.value += (target - f.mat.uniforms.uOn.value) * Math.min(1, dt * 4);
    }
    this.gate.star.rotation.y = time * 1.5;
    this.gate.curtain.uniforms.uTime.value = time;

    // Landing marker and shadow blob.
    this.updateMarker();

    this.bolts.update(dt, (b) => this.boltHit(b));
    this.sparks.update(dt);
    this.puffs.update(dt);
    this.confetti.update(dt);
    this.rings.update(dt);

    const hurt = this.playTime < this.invulnUntil && this.damaged && this.state === 'play';
    this.hands.update(dt, {
      stepPhase: this.stepPhase,
      running: this.runK,
      vy: p.grounded ? 0 : p.vy,
      ducking: p.ducking,
      time,
      hurt,
      tint: this.power ? powerColor(this.power.kind) : null,
    });
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.2);
    this.hud.hurt.style.opacity = String(this.hurtFlash * 0.8);
    this.hud.shield.style.opacity = this.power?.kind === 'shield' ? String(0.55 + 0.15 * Math.sin(time * 5)) : '0';
    if (this.ctx.settings.showCamera) this.preview.draw(now);
  }

  private updateMarker(): void {
    const p = this.player;
    const m = this.marker;
    // Shadow blob on the ground below.
    const below = supportAt(this.idx, p.s, p.x, p.y + 0.02, 0.02);
    if (below && p.y - below.top < 8) {
      const h = p.y - below.top;
      m.blob.visible = true;
      m.blob.position.set(p.x, below.top + 0.02, -p.s);
      m.blob.scale.setScalar(Math.max(0.4, 1.1 - h * 0.1));
      (m.blob.material as THREE.MeshBasicMaterial).opacity = Math.max(0.25, 1 - h * 0.12);
    } else m.blob.visible = false;
    // Predicted landing point while airborne.
    m.ring.visible = false;
    if (!p.grounded && this.state === 'play') {
      let s = p.s;
      let y = p.y;
      let vy = p.vy;
      const vs = Math.max(0, p.airSpeed);
      for (let i = 0; i < 160; i++) {
        const h = 1 / 60;
        vy -= 24 * h;
        const ny = y + vy * h;
        s += vs * h;
        if (vy < 0) {
          const sup = supportAt(this.idx, s, p.x, y + 0.02, 0.02);
          if (sup && sup.top >= ny) {
            m.ring.visible = true;
            m.ring.position.set(p.x, sup.top + 0.03, -s);
            const k = Math.min(1, Math.max(0.5, (s - p.s) / 3));
            m.ring.scale.setScalar(k);
            break;
          }
        }
        y = ny;
        if (y < p.y - 12) break;
      }
    }
  }

  private banner(text: string, tone: string): void {
    const b = this.hud.banner;
    b.textContent = text;
    b.className = `q-banner show ${tone}`;
    clearTimeout((b as unknown as { _t?: number })._t);
    (b as unknown as { _t?: number })._t = window.setTimeout(() => b.classList.remove('show'), 1100);
  }

  private popup(at: THREE.Vector3, text: string): void {
    const v = at.clone().project(this.camera);
    if (v.z > 1) return;
    const el = document.createElement('div');
    el.className = 'q-pop';
    el.textContent = text;
    el.style.left = `${(v.x * 0.5 + 0.5) * 100}%`;
    el.style.top = `${(-v.y * 0.5 + 0.5) * 100}%`;
    this.hud.popups.appendChild(el);
    setTimeout(() => el.remove(), 800);
  }

  // ---- HUD -----------------------------------------------------------------------------------------------------

  private updateHud(now: number): void {
    const p = this.player;
    const set = (k: string, v: string, apply: (v: string) => void) => {
      if (this.lastHud[k] === v) return;
      this.lastHud[k] = v;
      apply(v);
    };
    set('hearts', String(this.hearts), (v) => this.hud.hearts.querySelectorAll('i').forEach((h, i) => h.classList.toggle('off', i >= Number(v))));
    set('coins', String(this.coinCount), (v) => (this.hud.coins.textContent = v));
    set('gems', String(this.gems), (v) => this.hud.gems.querySelectorAll('i').forEach((g, i) => g.classList.toggle('on', i < Number(v))));
    const prog = Math.max(0, Math.min(1, p.s / this.level.goal.s));
    set('prog', (prog * 100).toFixed(1), (v) => {
      this.hud.fill.style.width = `${v}%`;
      this.hud.me.style.left = `${v}%`;
    });
    set('time', fmtClock(this.playTime).slice(0, -3), (v) => (this.hud.time.textContent = v));
    const pw = this.power;
    set('power', pw ? pw.kind : '', (v) => {
      this.hud.power.classList.toggle('hidden', !v);
      if (v) {
        this.hud.powerName.textContent = POWER_NAME[v as PowerKind];
        this.hud.power.dataset.kind = v;
      }
    });
    if (pw) set('pbar', (((pw.until - this.playTime) / POWER_TIME[pw.kind]) * 100).toFixed(0), (v) => (this.hud.powerBar.style.width = `${v}%`));

    // Action prompts right before the obstacle that needs them.
    let prompt = '';
    let icon: PromptIcon = 'run';
    if (this.state === 'play' && this.gt - this.crateBlockT < 0.3) {
      prompt = 'Punch the crate!';
      icon = 'punch';
    } else if (this.state === 'play' && this.gt - this.wallBlockT < 0.3 && p.grounded) {
      prompt = 'Jump up!';
      icon = 'big';
    } else if (this.state === 'play') {
      for (const pr of this.level.prompts) {
        if (p.s >= pr.s0 && p.s <= pr.s1) {
          prompt = pr.text;
          icon = pr.icon;
          if (pr.icon === 'run' && (this.prof.autoRun || !this.input.legs)) prompt = 'Auto-run is on: just jump, lean and punch!';
          break;
        }
      }
    }
    set('prompt', prompt, (v) => {
      this.hud.prompt.classList.toggle('show', !!v);
      if (v) {
        this.hud.promptText.textContent = v;
        this.hud.promptIc.textContent = PROMPT_ICON[icon];
        this.hud.prompt.dataset.icon = icon;
      }
    });
    this.promptShown = prompt;

    let hint = '';
    if (!this.input.seen && now - this.input.lastSeenT > 1200 && !this.ctx.demo) hint = "Can't see you: step into view";
    else if (this.state === 'play' && !this.prof.autoRun && !this.input.legs) hint = 'Legs out of view: auto-run is on';
    else if (this.state === 'play' && !this.prof.autoRun && this.input.legs && p.vs < 0.3 && this.playTime > 2 && this.stepsSeen < 4) hint = 'Run on the spot to move';
    set('hint', hint, (v) => {
      this.hud.hint.textContent = v;
      this.hud.hint.classList.toggle('show', !!v);
    });
    this.hintText = hint;

    (window as unknown as { __gameDebug?: unknown }).__gameDebug = {
      level: this.level.id,
      difficulty: this.level.difficulty,
      state: this.state,
      progress: Number(prog.toFixed(3)),
      s: Number(p.s.toFixed(2)),
      y: Number(p.y.toFixed(2)),
      lane: this.input.lane,
      coins: this.coinCount,
      coinTotal: this.level.coinTotal,
      gems: this.gems,
      hearts: this.hearts,
      speed: Number(p.vs.toFixed(2)),
      jumps: this.jumps,
      doubles: this.doubles,
      shots: this.shots,
      enemies: this.enemiesDown,
      stomps: this.stomps,
      falls: this.falls,
      damaged: this.damaged,
      checkpoint: this.cp,
      time: Number(this.playTime.toFixed(1)),
      finished: this.done || this.state === 'goal',
      fps: Math.round(this.fpsAvg),
      frames: this.frames,
      renderMs: Math.round(this.renderMs),
      tickMs: Math.round(this.prof2.tick),
      visMs: Math.round(this.prof2.vis),
      buildMs: Math.round(this.prof2.build),
      calls: this.mainCalls,
      tris: this.mainTris,
      software: this.software,
      quality: this.quality,
      prompt: this.promptShown,
      hint: this.hintText,
      log: this.log,
    };
  }

  // ---- pause / finish ---------------------------------------------------------------------------------------------

  private async pause(): Promise<void> {
    if (this.paused || this.done || this.state === 'goal' || this.state === 'over') return;
    this.paused = true;
    await this.ctx.audio.pause();
    const act = await pauseMenu(this.el, this.ctx.cursor);
    if (act === 'resume') {
      await this.ctx.audio.resume();
      this.paused = false;
      this.lastPoseT = performance.now();
      this.lastFrame = performance.now();
      return;
    }
    await this.ctx.audio.resume();
    this.cleanup();
    this.resolve(act === 'restart' ? { kind: 'restart' } : { kind: 'quit' });
  }

  private finish(): void {
    if (this.state === 'goal') return;
    this.state = 'goal';
    this.stateT = 0;
    this.timeScale = 0.35;
    this.sfx.duckMusic(0.08, 0.6);
    if (!this.sfx.playOnce(this.assets.music.get('fanfare'), this.ctx.settings.musicVolume)) this.sfx.fanfare();
    const g = this.gate.group.position;
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        if (this.done) return;
        const at = new THREE.Vector3(g.x + (Math.random() - 0.5) * 8, g.y + 6 + Math.random() * 5, g.z - 4 - Math.random() * 6);
        const c = new THREE.Color().setHSL(Math.random(), 0.9, 0.6);
        this.sparks.emit(at, 70, c, { speed: 9, life: 1.2, size: 0.28, gravity: 3, drag: 1.2 });
        this.sparks.emit(at, 20, new THREE.Color('#ffffff'), { speed: 4, life: 0.8, size: 0.2, gravity: 2 });
        this.confetti.burst(at, 40, 6, 3);
        this.sfx.pop((Math.random() - 0.5) * 1.2);
      }, 250 + i * 380);
    }
    this.confetti.burst(new THREE.Vector3(g.x, g.y + 4.5, g.z), 120, 8, 7);
    this.banner('Level clear!', 'clear');
    setTimeout(() => void this.showTally(), 2600);
  }

  private result(cleared: boolean): QuestResult {
    const stars = starsFor(this.coinCount, this.level.coinTotal, this.playTime, this.level.par, this.damaged);
    if (!cleared) stars.n = 0;
    const score = cleared ? this.coinCount * 10 + this.gems * 250 + this.enemiesDown * 100 + this.hearts * 300 + Math.max(0, Math.round((this.level.par - this.playTime) * 20)) + stars.n * 500 : this.coinCount * 10;
    return {
      level: this.level.id,
      name: this.level.name,
      difficulty: this.level.difficulty,
      cleared,
      time: this.playTime,
      par: this.level.par,
      coins: this.coinCount,
      coinTotal: this.level.coinTotal,
      gems: this.gems,
      gemTotal: this.level.gemTotal,
      enemies: this.enemiesDown,
      hearts: this.hearts,
      damaged: this.damaged,
      falls: this.falls,
      stars,
      score,
    };
  }

  /** Star tally overlay: each star pops in with a chime. */
  private async showTally(): Promise<void> {
    if (this.tally || this.done) return;
    const r = this.result(true);
    const pct = Math.round((r.coins / Math.max(1, r.coinTotal)) * 100);
    const el = document.createElement('div');
    el.className = 'q-tally';
    el.innerHTML = `
      <div class="q-tally-card">
        <div class="q-tally-head">Level clear!</div>
        <div class="q-tally-stars">
          <div class="q-star" data-on="${r.stars.coins}"><i>★</i><b>Coins</b><span>${pct}% (75% needed)</span></div>
          <div class="q-star" data-on="${r.stars.time}"><i>★</i><b>Time</b><span>${fmtClock(r.time).slice(0, -3)} / par ${fmtClock(r.par).slice(0, -3)}</span></div>
          <div class="q-star" data-on="${r.stars.clean}"><i>★</i><b>No damage</b><span>${r.damaged ? 'Took a hit' : 'Flawless!'}</span></div>
        </div>
        <button class="btn primary big" data-hc>Continue</button>
      </div>`;
    this.el.appendChild(el);
    this.ctx.cursor(true);
    requestAnimationFrame(() => el.classList.add('show'));
    const stars = [...el.querySelectorAll<HTMLElement>('.q-star')];
    let earned = 0;
    stars.forEach((s, i) => {
      setTimeout(() => {
        s.classList.add('shown');
        if (s.dataset.on === 'true') {
          s.classList.add('lit');
          this.sfx.starTick(earned++);
        }
      }, 500 + i * 650);
    });
    this.tally = new Promise<void>((res) => {
      const go = () => res();
      el.querySelector('button')!.addEventListener('click', go, { once: true });
      setTimeout(go, this.ctx.demo ? 5200 : 9000);
    });
    await this.tally;
    this.end(true);
  }

  private end(cleared: boolean): void {
    if (this.done) return;
    this.done = true;
    const result = this.result(cleared);
    (window as unknown as { __gameDebug?: Record<string, unknown> }).__gameDebug = {
      ...((window as unknown as { __gameDebug?: Record<string, unknown> }).__gameDebug ?? {}),
      finished: true,
      cleared,
      stars: result.stars.n,
      time: Number(result.time.toFixed(1)),
      coins: result.coins,
      hearts: result.hearts,
    };
    this.cleanup();
    this.resolve({ kind: 'done', result });
  }

  private cleanup(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    this.sfx.dispose();
    if (this.ctx.pose instanceof SimPose) this.ctx.pose.drive = () => SIM_REST;
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !(m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) m.geometry.dispose();
    });
    this.coins.mesh.dispose();
    for (const m of this.mats) m.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.el.remove();
  }
}
