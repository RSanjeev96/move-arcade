/**
 * The venue: court surface and markings, net, stadium bowl with an instanced animated crowd, umpire
 * chair, scoreboard, sky/environment and lights. Two venues: a twilight hard-court arena under
 * floodlights and a sunny grass court.
 */
import * as THREE from 'three';
import { COURT, netHeight } from './physics';

export type VenueId = 'hard' | 'grass';

export interface Venue {
  id: VenueId;
  name: string;
  sky: string;
  night: boolean;
  exposure: number;
  inner: string;
  outer: string;
  seat: string;
  wall: string;
  accent: string;
}

export const VENUES: Record<VenueId, Venue> = {
  hard: {
    id: 'hard',
    name: 'Harbour Arena',
    sky: 'sky-dusk.jpg',
    night: true,
    exposure: 1.0,
    inner: '#2d63b3',
    outer: '#1e5550',
    seat: '#2b3f66',
    wall: '#152744',
    accent: '#d4ff3d',
  },
  grass: {
    id: 'grass',
    name: 'Garden Club',
    sky: 'sky-day.jpg',
    night: false,
    exposure: 0.95,
    inner: '#4f8a3a',
    outer: '#3f7a30',
    seat: '#1f5a3a',
    wall: '#1d4a2c',
    accent: '#c9a6ff',
  },
};

const rand = (() => {
  let s = 1234567;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
})();

// ---- textures -----------------------------------------------------------------------------------------

const AREA = { x: COURT.wallX, z: COURT.wallZ };
/** Rows of seats in each stand. */
const ROWS_ARENA = 16;
const ROWS_GARDEN = 12;

function courtTexture(v: Venue): THREE.CanvasTexture {
  const W = 1024;
  const H = 2048;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const sx = W / (AREA.x * 2);
  const sz = H / (AREA.z * 2);
  const X = (x: number) => (x + AREA.x) * sx;
  const Z = (z: number) => (z + AREA.z) * sz;
  const hw = COURT.halfDoubles + 0.0;
  const hl = COURT.halfLength;
  if (v.id === 'hard') {
    g.fillStyle = v.outer;
    g.fillRect(0, 0, W, H);
    g.fillStyle = v.inner;
    g.fillRect(X(-hw), Z(-hl), (hw * 2) * sx, hl * 2 * sz);
    // Worn, lighter patches behind the baselines where players stand.
    for (const s of [-1, 1]) {
      const grd = g.createRadialGradient(X(0), Z(s * (hl + 1)), 0, X(0), Z(s * (hl + 1)), 3.2 * sx);
      grd.addColorStop(0, 'rgba(255,255,255,0.07)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
    }
    // Acrylic grain.
    grain(g, W, H, 0.09, false);
  } else {
    // Mowing stripes across the court.
    const band = 1.55;
    for (let z = -AREA.z, i = 0; z < AREA.z; z += band, i++) {
      g.fillStyle = i % 2 ? '#4c8a37' : '#5a9b42';
      g.fillRect(0, Z(z), W, band * sz + 1);
    }
    // Darker surround near the walls.
    const edge = g.createLinearGradient(0, 0, W, 0);
    edge.addColorStop(0, 'rgba(20,50,20,0.35)');
    edge.addColorStop(0.12, 'rgba(20,50,20,0)');
    edge.addColorStop(0.88, 'rgba(20,50,20,0)');
    edge.addColorStop(1, 'rgba(20,50,20,0.35)');
    g.fillStyle = edge;
    g.fillRect(0, 0, W, H);
    // Worn baselines and service T.
    const wear = (x: number, z: number, rx: number, rz: number, a: number) => {
      g.save();
      g.translate(X(x), Z(z));
      g.scale(rx * sx, rz * sz);
      const grd = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      grd.addColorStop(0, `rgba(160,140,85,${a})`);
      grd.addColorStop(0.6, `rgba(150,140,80,${a * 0.5})`);
      grd.addColorStop(1, 'rgba(150,140,80,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(0, 0, 1, 0, Math.PI * 2);
      g.fill();
      g.restore();
    };
    for (const s of [-1, 1]) {
      wear(0, s * (hl + 0.5), 2.6, 1.3, 0.55);
      wear(0.6, s * (hl + 0.2), 1.2, 0.7, 0.35);
      wear(0, s * COURT.service, 0.9, 0.7, 0.22);
    }
    grain(g, W, H, 0.16, true);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Overlay a tiled noise pattern (cheap: one small ImageData, then a pattern fill). */
function grain(g: CanvasRenderingContext2D, W: number, H: number, alpha: number, green: boolean): void {
  const n = document.createElement('canvas');
  n.width = n.height = 128;
  const ng = n.getContext('2d')!;
  const img = ng.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 128 + (rand() - 0.5) * 255;
    img.data[i] = green ? v * 0.8 : v;
    img.data[i + 1] = v;
    img.data[i + 2] = green ? v * 0.6 : v;
    img.data[i + 3] = 255;
  }
  ng.putImageData(img, 0, 0);
  g.save();
  g.globalAlpha = alpha;
  g.globalCompositeOperation = 'overlay';
  g.fillStyle = g.createPattern(n, 'repeat')!;
  g.fillRect(0, 0, W, H);
  g.restore();
}

function netTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(15,15,18,1)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 61, 61);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

function textTexture(text: string, bg: string, fg: string, w = 2048, h = 128, font = 'bold 72px Outfit, sans-serif'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.font = font;
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  const parts = text.split('|');
  parts.forEach((p, i) => g.fillText(p, ((i + 0.5) / parts.length) * w, h / 2 + 4));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ---- crowd ---------------------------------------------------------------------------------------------

/** Sprite atlas of spectators: 8 looks x 3 poses (sit, clap, cheer). R = shirt, G = skin, B = hair/trousers. */
function crowdAtlas(): THREE.CanvasTexture {
  const CW = 64;
  const CH = 96;
  const c = document.createElement('canvas');
  c.width = CW * 8;
  c.height = CH * 3;
  const g = c.getContext('2d')!;
  const R = (v: number) => `rgb(${Math.round(v * 255)},0,0)`;
  const Gc = (v: number) => `rgb(0,${Math.round(v * 255)},0)`;
  const B = (v: number) => `rgb(0,0,${Math.round(v * 255)})`;
  const rr = (x: number, y: number, w: number, h: number, r: number) => {
    g.beginPath();
    g.roundRect(x, y, w, h, r);
    g.fill();
  };
  const limb = (x0: number, y0: number, x1: number, y1: number, w: number, style: string) => {
    g.strokeStyle = style;
    g.lineWidth = w;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  };
  for (let v = 0; v < 8; v++) {
    for (let pose = 0; pose < 3; pose++) {
      g.save();
      g.translate(v * CW, pose * CH);
      const cx = 32 + (v % 3) - 1;
      const wide = v % 2 ? 2 : 0;
      // Lap and trousers.
      g.fillStyle = B(0.55);
      rr(cx - 15 - wide, 74, 30 + wide * 2, 20, 6);
      // Torso with soft top light.
      const tg = g.createLinearGradient(0, 40, 0, 80);
      tg.addColorStop(0, R(1));
      tg.addColorStop(1, R(0.62));
      g.fillStyle = tg;
      g.beginPath();
      g.moveTo(cx - 14 - wide, 44);
      g.quadraticCurveTo(cx, 38, cx + 14 + wide, 44);
      g.lineTo(cx + 12 + wide, 80);
      g.lineTo(cx - 12 - wide, 80);
      g.closePath();
      g.fill();
      // Neck and head.
      g.fillStyle = Gc(0.8);
      g.fillRect(cx - 3, 32, 6, 9);
      const hg = g.createRadialGradient(cx - 3, 22, 2, cx, 26, 12);
      hg.addColorStop(0, Gc(1));
      hg.addColorStop(1, Gc(0.7));
      g.fillStyle = hg;
      g.beginPath();
      g.ellipse(cx, 25, 8.5, 10, 0, 0, Math.PI * 2);
      g.fill();
      // Hair styles.
      const hv = v % 4;
      g.fillStyle = B(0.22 + (v % 3) * 0.12);
      if (hv === 0) {
        g.beginPath();
        g.ellipse(cx, 19, 9, 6, 0, Math.PI, 0);
        g.fill();
      } else if (hv === 1) {
        g.beginPath();
        g.ellipse(cx, 21, 10, 9, 0, Math.PI * 0.95, Math.PI * 0.05);
        g.fill();
        rr(cx - 10, 20, 5, 22, 3);
        rr(cx + 5, 20, 5, 22, 3);
      } else if (hv === 2) {
        // Cap in the shirt colour.
        g.fillStyle = R(0.85);
        g.beginPath();
        g.ellipse(cx, 18, 9.5, 6.5, 0, Math.PI, 0);
        g.fill();
        rr(cx - 2, 16, 14, 4, 2);
      }
      // Arms per pose.
      const sh = 0.82;
      const skin = Gc(0.85);
      if (pose === 0) {
        limb(cx - 14 - wide, 47, cx - 12, 70, 7, R(sh));
        limb(cx + 14 + wide, 47, cx + 12, 70, 7, R(sh));
        g.fillStyle = skin;
        rr(cx - 15, 70, 9, 7, 3);
        rr(cx + 6, 70, 9, 7, 3);
      } else if (pose === 1) {
        limb(cx - 14 - wide, 47, cx - 6, 56, 7, R(sh));
        limb(cx + 14 + wide, 47, cx + 6, 56, 7, R(sh));
        limb(cx - 6, 56, cx - 1, 46, 5.5, skin);
        limb(cx + 6, 56, cx + 1, 46, 5.5, skin);
      } else {
        limb(cx - 13 - wide, 46, cx - 20, 24, 7, R(sh));
        limb(cx + 13 + wide, 46, cx + 20, 24, 7, R(sh));
        limb(cx - 20, 24, cx - 18, 8, 5.5, skin);
        limb(cx + 20, 24, cx + 18, 8, 5.5, skin);
      }
      g.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = 2;
  return t;
}

/** Spectators as camera-facing sprites on one instanced mesh: they sway, clap, cheer and stand up. */
export class Crowd {
  readonly mesh: THREE.InstancedMesh;
  private mat: THREE.MeshBasicMaterial;
  private uniforms = { uTime: { value: 0 }, uClap: { value: 0 }, uStand: { value: 0 }, uLight: { value: 1 } };
  private stand = 0;
  private clapTarget = 0;
  private clap = 0;

  constructor(seats: { p: THREE.Vector3; yaw: number }[], light: number) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    this.uniforms.uLight.value = light;
    this.mat = new THREE.MeshBasicMaterial({ map: crowdAtlas(), alphaTest: 0.5 });
    const u = this.uniforms;
    this.mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uTime; uniform float uClap; uniform float uStand;
           attribute float seed;
           varying vec3 vShirt; varying vec3 vSkin; varying vec3 vHair; varying float vShade;`,
        )
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
           float variant = floor(fract(seed * 7.13) * 8.0);
           float ph = seed * 6.2831;
           float ex = clamp(uClap, 0.0, 1.0);
           // Clapping flickers between the sit and clap frames; the keenest cheer with arms up.
           float clapOn = step(0.5, fract(uTime * (3.2 + seed * 2.0) + seed)) * step(seed * 0.6, ex);
           float cheer = step(0.75, ex) * step(seed, 0.35);
           float pose = cheer > 0.5 ? 2.0 : clapOn;
           vMapUv = vec2((variant + uv.x) / 8.0, (pose + 1.0 - uv.y) / 3.0);
           vMapUv.y = 1.0 - vMapUv.y;`,
        )
        .replace(
          '#include <project_vertex>',
          `vec3 ipos = vec3(instanceMatrix[3]);
           float isc = length(instanceMatrix[0].xyz);
           float st = smoothstep(seed * 0.6, seed * 0.6 + 0.4, uStand);
           float bob = ex * abs(sin(uTime * 7.0 + ph)) * 0.03 + sin(uTime * 0.8 + ph) * 0.006;
           vec4 cview = modelViewMatrix * vec4(ipos, 1.0);
           vec3 upV = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
           vec4 mvPosition = cview + vec4(position.x * 0.64 * isc + sin(uTime * 0.6 + ph) * 0.01, 0.0, 0.0, 0.0)
             + vec4(upV * (position.y * 0.96 * isc + st * 0.34 + bob), 0.0);
           gl_Position = projectionMatrix * mvPosition;
           vShirt = instanceColor;
           float sk = fract(seed * 13.7);
           vSkin = mix(vec3(0.85, 0.6, 0.45), vec3(0.32, 0.19, 0.12), sk * sk);
           float hc = fract(seed * 5.3);
           vHair = mix(vec3(0.05, 0.04, 0.035), vec3(0.42, 0.3, 0.18), hc * hc);
           vShade = 0.82 + 0.18 * position.y;`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           uniform float uLight;
           varying vec3 vShirt; varying vec3 vSkin; varying vec3 vHair; varying float vShade;`,
        )
        .replace(
          '#include <map_fragment>',
          `vec4 texel = texture2D(map, vMapUv);
           diffuseColor = vec4((vShirt * texel.r + vSkin * texel.g + vHair * texel.b) * vShade * uLight, texel.a);`,
        )
        .replace('#include <color_fragment>', '');
    };
    this.mat.customProgramCacheKey = () => 'tennis-crowd';
    this.mesh = new THREE.InstancedMesh(geo, this.mat, seats.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const shirts = ['#f2f2f2', '#e8e4da', '#1f2a44', '#c8102e', '#2d6cdf', '#f5c518', '#3a7d44', '#7a3b8f', '#ff7a1a', '#202020', '#9fb8d8', '#d94f70', '#e0e0e0', '#5b8c5a', '#87ceeb', '#ffffff'];
    const col = new THREE.Color();
    seats.forEach((s, i) => {
      const sc = 0.92 + rand() * 0.16;
      m.compose(s.p, q, new THREE.Vector3(sc, sc, sc));
      this.mesh.setMatrixAt(i, m);
      col.set(shirts[Math.floor(rand() * shirts.length)]).multiplyScalar(0.7 + rand() * 0.4);
      this.mesh.setColorAt(i, col);
    });
    const seedAttr = new Float32Array(seats.length);
    for (let i = 0; i < seats.length; i++) seedAttr[i] = rand();
    geo.setAttribute('seed', new THREE.InstancedBufferAttribute(seedAttr, 1));
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.frustumCulled = false;
  }

  /** 0..1 applause intensity for a while. */
  applaud(level: number): void {
    this.clapTarget = Math.max(this.clapTarget, level);
  }

  standUp(on: boolean): void {
    this.stand = on ? 1 : 0;
  }

  update(dt: number, t: number, ballX: number): void {
    void ballX;
    this.clap += (this.clapTarget - this.clap) * Math.min(1, dt * 6);
    this.clapTarget = Math.max(0, this.clapTarget - dt * 0.45);
    this.uniforms.uTime.value = t;
    this.uniforms.uClap.value = this.clap;
    this.uniforms.uStand.value += (this.stand - this.uniforms.uStand.value) * Math.min(1, dt * 2);
  }
}

// ---- stadium -------------------------------------------------------------------------------------------

export class Stadium {
  readonly group = new THREE.Group();
  readonly crowd: Crowd;
  readonly sun: THREE.DirectionalLight;
  private scoreCanvas: HTMLCanvasElement;
  private scoreTex: THREE.CanvasTexture;
  readonly umpireSeat = new THREE.Vector3(-7.35, 2.05, 0);
  private lampMats: THREE.MeshBasicMaterial[] = [];
  private readonly rows: number;

  constructor(
    readonly venue: Venue,
    sky: THREE.Texture,
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
  ) {
    const v = venue;
    this.rows = v.night ? ROWS_ARENA : ROWS_GARDEN;
    // Sky + image-based lighting.
    sky.mapping = THREE.EquirectangularReflectionMapping;
    sky.colorSpace = THREE.SRGBColorSpace;
    scene.background = sky;
    scene.backgroundIntensity = v.night ? 0.85 : 1.0;
    // Image-based lighting from a small copy of the sky (cheap to prefilter).
    const small = document.createElement('canvas');
    small.width = 512;
    small.height = 256;
    small.getContext('2d')!.drawImage(sky.image as CanvasImageSource, 0, 0, 512, 256);
    const smallTex = new THREE.CanvasTexture(small);
    smallTex.mapping = THREE.EquirectangularReflectionMapping;
    smallTex.colorSpace = THREE.SRGBColorSpace;
    const pm = new THREE.PMREMGenerator(renderer);
    const env = pm.fromEquirectangular(smallTex).texture;
    smallTex.dispose();
    pm.dispose();
    // Software WebGL (headless tests, GPU-less devices) is extremely slow with prefiltered environment
    // maps; fall back to a stronger hemisphere light there.
    const software = isSoftwareGL(renderer);
    scene.environment = software ? null : env;
    scene.environmentIntensity = v.night ? 0.35 : 0.55;
    scene.fog = new THREE.Fog(v.night ? 0x2a2440 : 0xb8cde0, 60, 190);

    // Lights.
    const hemi = new THREE.HemisphereLight(v.night ? 0x8fa0ff : 0xcfe4ff, v.night ? 0x223018 : 0x4a6a35, (v.night ? 0.55 : 0.75) + (software ? 0.6 : 0));
    this.group.add(hemi);
    this.sun = new THREE.DirectionalLight(v.night ? 0xf2f4ff : 0xfff1dc, v.night ? 2.4 : 3.1);
    if (v.night) this.sun.position.set(6, 38, 16);
    else this.sun.position.set(-26, 34, 14);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -16;
    sc.right = 16;
    sc.top = 22;
    sc.bottom = -22;
    sc.near = 5;
    sc.far = 90;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 3;
    this.sun.target.position.set(0, 0, 0);
    this.group.add(this.sun, this.sun.target);
    if (v.night) {
      const fill = new THREE.DirectionalLight(0xc8d0ff, 0.8);
      fill.position.set(-10, 30, -20);
      this.group.add(fill);
    }

    this.buildGround();
    this.buildLines();
    this.buildNet();
    this.buildWalls();
    const seats = this.buildStands();
    this.crowd = new Crowd(seats, v.night ? 0.8 : 1.0);
    this.group.add(this.crowd.mesh);
    this.buildUmpireChair();
    this.buildCourtside();
    const sb = this.buildScoreboard();
    this.scoreCanvas = sb.canvas;
    this.scoreTex = sb.tex;
    if (v.night) this.buildFloodlights();
  }

  private buildGround(): void {
    const tex = courtTexture(this.venue);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: this.venue.id === 'hard' ? 0.72 : 0.95, metalness: 0 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(AREA.x * 2, AREA.z * 2), mat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.group.add(ground);
    // Apron outside the walls (under the stands).
    const ring = new THREE.Shape();
    ring.moveTo(-70, -70);
    ring.lineTo(70, -70);
    ring.lineTo(70, 70);
    ring.lineTo(-70, 70);
    ring.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-AREA.x, -AREA.z);
    hole.lineTo(-AREA.x, AREA.z);
    hole.lineTo(AREA.x, AREA.z);
    hole.lineTo(AREA.x, -AREA.z);
    hole.closePath();
    ring.holes.push(hole);
    const apronGeo = new THREE.ShapeGeometry(ring);
    apronGeo.rotateX(-Math.PI / 2);
    const apron = new THREE.Mesh(apronGeo, new THREE.MeshStandardMaterial({ color: this.venue.night ? 0x1a1d26 : 0x55604a, roughness: 1 }));
    apron.position.y = -0.01;
    this.group.add(apron);
  }

  private buildLines(): void {
    const boxes: THREE.BufferGeometry[] = [];
    const y = 0.003;
    const line = (x0: number, z0: number, x1: number, z1: number, w: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const g = new THREE.PlaneGeometry(x1 === x0 ? w : len, x1 === x0 ? len : w);
      g.rotateX(-Math.PI / 2);
      g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
      boxes.push(g);
    };
    const L = COURT.halfLength;
    const D = COURT.halfDoubles;
    const S = COURT.halfSingles;
    const w = COURT.lineWidth;
    // Lines lie inside the court: outer edges on the boundary.
    for (const s of [-1, 1]) {
      line(-D, s * (L - w), D, s * (L - w), w * 2); // baselines (10 cm)
      line(s * (D - w / 2), -L, s * (D - w / 2), L, w); // doubles sidelines
      line(s * (S - w / 2), -L, s * (S - w / 2), L, w); // singles sidelines
      line(-S, s * (COURT.service - w / 2), S, s * (COURT.service - w / 2), w); // service lines
      line(0, s * (L - 0.2 - w), 0, s * (L - w * 2), w); // centre marks
    }
    line(0, -COURT.service, 0, COURT.service, w);
    const geo = mergeAll(boxes);
    const mat = new THREE.MeshStandardMaterial({ color: 0xf6f6f0, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private buildNet(): void {
    const W = COURT.netHalfWidth;
    const segs = 32;
    // Net mesh: a strip whose top follows the cord sag.
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const x = -W + (2 * W * i) / segs;
      const h = netHeight(x) - 0.03;
      pos.push(x, 0.02, 0, x, h, 0);
      uv.push(x / 0.045, 0.02 / 0.045, x / 0.045, h / 0.045);
      if (i < segs) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const ng = new THREE.BufferGeometry();
    ng.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    ng.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    ng.setIndex(idx);
    ng.computeVertexNormals();
    const tex = netTexture();
    const net = new THREE.Mesh(
      ng,
      new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.35, transparent: false, side: THREE.DoubleSide, color: 0x111114, roughness: 0.9 }),
    );
    net.castShadow = true;
    this.group.add(net);
    // Tape along the top and the centre strap.
    const tape: THREE.BufferGeometry[] = [];
    for (let i = 0; i < segs; i++) {
      const x0 = -W + (2 * W * i) / segs;
      const x1 = -W + (2 * W * (i + 1)) / segs;
      const h0 = netHeight(x0);
      const h1 = netHeight(x1);
      const len = Math.hypot(x1 - x0, h1 - h0);
      const b = new THREE.BoxGeometry(len + 0.01, 0.055, 0.018);
      b.rotateZ(Math.atan2(h1 - h0, x1 - x0));
      b.translate((x0 + x1) / 2, (h0 + h1) / 2 - 0.027, 0);
      tape.push(b);
    }
    const strap = new THREE.BoxGeometry(0.05, COURT.netCentre - 0.02, 0.02);
    strap.translate(0, (COURT.netCentre - 0.02) / 2, 0);
    tape.push(strap);
    const tm = new THREE.Mesh(mergeAll(tape), new THREE.MeshStandardMaterial({ color: 0xf8f8f4, roughness: 0.6 }));
    tm.castShadow = true;
    this.group.add(tm);
    // Posts.
    const postMat = new THREE.MeshStandardMaterial({ color: this.venue.id === 'grass' ? 0x1f4a2c : 0x1a2440, roughness: 0.4, metalness: 0.4 });
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, COURT.netPost + 0.03, 12), postMat);
      p.position.set(s * W, (COURT.netPost + 0.03) / 2, 0);
      p.castShadow = true;
      this.group.add(p);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 6), postMat);
      cap.position.set(s * W, COURT.netPost + 0.03, 0);
      this.group.add(cap);
    }
  }

  private buildWalls(): void {
    const v = this.venue;
    const label = v.id === 'hard' ? 'HARBOUR ARENA|CENTRE COURT' : 'GARDEN CLUB|CENTRE COURT';
    const fg = v.id === 'hard' ? '#d9e4ff' : '#e8f2df';
    const h = 1.15;
    const mk = (w: number, x: number, z: number, ry: number) => {
      const tex = textTexture(label, v.wall, fg, 1024, 64, '800 34px Outfit, sans-serif');
      tex.wrapS = THREE.RepeatWrapping;
      // Keep the lettering's aspect: one tile is 16 wall-heights long.
      tex.repeat.set(Math.max(1, Math.round(w / (h * 16))), 1);
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 });
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.12), mat);
      m.position.set(x, h / 2, z);
      m.rotation.y = ry;
      m.receiveShadow = true;
      this.group.add(m);
    };
    mk(AREA.x * 2 + 0.2, 0, -AREA.z - 0.06, 0);
    mk(AREA.x * 2 + 0.2, 0, AREA.z + 0.06, Math.PI);
    mk(AREA.z * 2 + 0.2, -AREA.x - 0.06, 0, Math.PI / 2);
    mk(AREA.z * 2 + 0.2, AREA.x + 0.06, 0, -Math.PI / 2);
    // Grass venue: flower boxes on top of the side walls.
    if (v.id === 'grass') {
      const hedge = new THREE.MeshStandardMaterial({ color: 0x2e5a26, roughness: 1 });
      for (const s of [-1, 1]) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, AREA.z * 2 - 6), hedge);
        b.position.set(s * (AREA.x + 0.4), 1.3, 0);
        this.group.add(b);
      }
    }
  }

  /** Stepped seating on all four sides; returns crowd seat positions. */
  private buildStands(): { p: THREE.Vector3; yaw: number }[] {
    const v = this.venue;
    const seats: { p: THREE.Vector3; yaw: number }[] = [];
    const geos: THREE.BufferGeometry[] = [];
    const concrete = new THREE.Color(v.night ? '#3a3f4c' : '#a7a49a');
    const seat = new THREE.Color(v.seat);
    const rows = this.rows;
    const depth = 0.9;
    const rise = 0.5;
    const addBox = (w: number, h: number, d: number, x: number, y: number, z: number, ry: number, col: THREE.Color) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.rotateY(ry);
      g.translate(x, y, z);
      colorize(g, col);
      geos.push(g);
    };
    // Four sides: [distance from centre to first row, half length, facing yaw, axis]
    const sides = [
      { d: AREA.z + 0.9, half: 30, yaw: 0, axis: 'z', sign: -1, skipNear: 0 },
      { d: AREA.z + 3.4, half: 30, yaw: Math.PI, axis: 'z', sign: 1, skipNear: 0 },
      { d: AREA.x + 1.2, half: AREA.z + 0.6, yaw: Math.PI / 2, axis: 'x', sign: -1, skipNear: 0 },
      { d: AREA.x + 1.2, half: AREA.z + 0.6, yaw: -Math.PI / 2, axis: 'x', sign: 1, skipNear: 0 },
    ];
    for (const s of sides) {
      for (let r = 0; r < rows; r++) {
        const dist = s.d + r * depth;
        const y = 1.25 + r * rise;
        const len = s.half * 2 + (s.axis === 'x' ? r * depth * 2 : 0);
        const cx = s.axis === 'x' ? s.sign * (dist + depth / 2) : 0;
        const cz = s.axis === 'z' ? s.sign * (dist + depth / 2) : 0;
        const ry = s.axis === 'x' ? Math.PI / 2 : 0;
        addBox(len, y, depth, cx, y / 2, cz, ry, concrete);
        // Seat strip on the front of each step.
        const sx = s.axis === 'x' ? s.sign * (dist + 0.32) : 0;
        const sz = s.axis === 'z' ? s.sign * (dist + 0.32) : 0;
        addBox(len, 0.42, 0.32, sx, y + 0.21, sz, ry, seat);
        // Spectators.
        const spacing = 0.64;
        const n = Math.floor(len / spacing);
        for (let i = 0; i < n; i++) {
          if (rand() > (r < 3 ? 0.93 : 0.86)) continue;
          const along = -len / 2 + (i + 0.5) * spacing + (rand() - 0.5) * 0.08;
          const px = s.axis === 'x' ? s.sign * (dist + 0.42) : along;
          const pz = s.axis === 'z' ? s.sign * (dist + 0.42) : along;
          // Skip seats right behind the near-end camera.
          if (s.axis === 'z' && s.sign > 0 && Math.abs(px) < 7 && r < 4) continue;
          seats.push({ p: new THREE.Vector3(px, y + 0.02, pz), yaw: s.yaw });
        }
      }
      // Fascia / roof edge at the back of the stand.
      const top = 1.25 + rows * rise;
      const dist = s.d + rows * depth;
      const len = s.half * 2 + (s.axis === 'x' ? rows * depth * 2 : 0);
      const ry = s.axis === 'x' ? Math.PI / 2 : 0;
      const bx = s.axis === 'x' ? s.sign * (dist + 0.4) : 0;
      const bz = s.axis === 'z' ? s.sign * (dist + 0.4) : 0;
      const fh = v.night ? 4.5 : 1.6;
      addBox(len, fh, 0.8, bx, top + fh / 2, bz, ry, new THREE.Color(v.night ? '#1d2230' : '#2f5a3a'));
      // Arena: a roof canopy reaching over the upper rows. Garden club: open air, with a white rail.
      if (v.night) {
        const cx = s.axis === 'x' ? s.sign * (dist - 4) : 0;
        const cz = s.axis === 'z' ? s.sign * (dist - 4) : 0;
        addBox(len, 0.35, 9, cx, top + 4.4, cz, ry, new THREE.Color('#151925'));
      } else {
        const rx = s.axis === 'x' ? s.sign * (dist - 0.1) : 0;
        const rz = s.axis === 'z' ? s.sign * (dist - 0.1) : 0;
        addBox(len, 0.08, 0.08, rx, top + 1.0, rz, ry, new THREE.Color('#f4f4ee'));
      }
    }
    const mesh = new THREE.Mesh(mergeAll(geos), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
    mesh.receiveShadow = false;
    this.group.add(mesh);
    return seats;
  }

  private buildUmpireChair(): void {
    const mat = new THREE.MeshStandardMaterial({ color: this.venue.id === 'grass' ? 0x26502f : 0x1b2a4a, roughness: 0.5, metalness: 0.2 });
    const g: THREE.BufferGeometry[] = [];
    const p = this.umpireSeat;
    for (const dx of [-0.35, 0.35])
      for (const dz of [-0.45, 0.45]) {
        const leg = new THREE.BoxGeometry(0.06, 1.95, 0.06);
        leg.translate(p.x + dx, 0.975, p.z + dz);
        g.push(leg);
      }
    const plat = new THREE.BoxGeometry(0.9, 0.08, 1.1);
    plat.translate(p.x, 1.55, p.z);
    g.push(plat);
    const seatB = new THREE.BoxGeometry(0.6, 0.08, 0.6);
    seatB.translate(p.x - 0.1, 1.98, p.z);
    g.push(seatB);
    const back = new THREE.BoxGeometry(0.06, 0.7, 0.6);
    back.translate(p.x - 0.4, 2.33, p.z);
    g.push(back);
    const desk = new THREE.BoxGeometry(0.1, 0.55, 0.9);
    desk.translate(p.x + 0.45, 1.85, p.z);
    g.push(desk);
    for (let i = 0; i < 5; i++) {
      const rung = new THREE.BoxGeometry(0.05, 0.04, 0.9);
      rung.translate(p.x - 0.35, 0.3 + i * 0.3, p.z);
      g.push(rung);
    }
    const mesh = new THREE.Mesh(mergeAll(g), mat);
    mesh.castShadow = true;
    this.group.add(mesh);
  }

  private buildCourtside(): void {
    // Player chairs with towels and kit bags, a drinks table and a cooler by the umpire chair.
    const v = this.venue;
    const geos: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, col: string | THREE.Color) => {
      g.translate(x, y, z);
      colorize(g, col instanceof THREE.Color ? col : new THREE.Color(col));
      geos.push(g);
    };
    const chair = v.id === 'grass' ? '#2f6b3a' : '#24366a';
    const frame = '#2a2a30';
    for (const z of [-1.9, 1.9]) {
      const x = -9.35;
      add(new THREE.BoxGeometry(0.5, 0.07, 0.48), x, 0.47, z, chair);
      const back = new THREE.BoxGeometry(0.06, 0.55, 0.48);
      back.rotateZ(-0.12);
      add(back, x - 0.27, 0.77, z, chair);
      for (const dx of [-0.2, 0.2]) for (const dz of [-0.2, 0.2]) add(new THREE.CylinderGeometry(0.015, 0.015, 0.46, 6), x + dx, 0.23, z + dz, frame);
      // Towel over the back, kit bag at the feet.
      const towel = new THREE.BoxGeometry(0.1, 0.42, 0.3);
      towel.rotateZ(-0.12);
      add(towel, x - 0.3, 0.8, z + 0.03, '#f4f4f0');
      add(new THREE.BoxGeometry(0.9, 0.32, 0.34), x + 0.05, 0.16, z + (z > 0 ? 0.55 : -0.55), z > 0 ? '#1a1a1f' : '#7a1c26');
    }
    // Drinks table with bottles.
    add(new THREE.BoxGeometry(0.5, 0.04, 0.5), -9.35, 0.62, 0, '#e9e6dd');
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 6), -9.35, 0.31, 0, frame);
    const bottles = ['#e8f4ff', '#d4ff3d', '#ff7a1a', '#e8f4ff'];
    bottles.forEach((c, i) => add(new THREE.CylinderGeometry(0.035, 0.035, 0.24, 8), -9.5 + (i % 2) * 0.22, 0.76, -0.12 + Math.floor(i / 2) * 0.24, c));
    // Cooler.
    add(new THREE.BoxGeometry(0.55, 0.42, 0.75), -9.9, 0.21, 0.9, v.accent);
    add(new THREE.BoxGeometry(0.58, 0.06, 0.78), -9.9, 0.45, 0.9, '#f4f4f0');
    const m = new THREE.Mesh(mergeAll(geos), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
  }

  private buildScoreboard(): { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture } {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 384;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(11.6, 4.6, 0.5), new THREE.MeshStandardMaterial({ color: 0x0c0f16, roughness: 0.5 }));
    const top = 1.25 + this.rows * 0.5;
    const z = -(AREA.z + 0.9 + this.rows * 0.9) + 0.2;
    frame.position.set(0, top + 3.1, z);
    this.group.add(frame);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(11, 4.1), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    screen.position.set(0, top + 3.1, z + 0.26);
    this.group.add(screen);
    return { canvas, tex };
  }

  /** Redraw the big screen. */
  setScoreboard(rows: { name: string; games: string; points: string; serving: boolean }[], note: string): void {
    const g = this.scoreCanvas.getContext('2d')!;
    const W = this.scoreCanvas.width;
    const H = this.scoreCanvas.height;
    g.fillStyle = '#05070c';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#0e1a2e';
    g.fillRect(14, 14, W - 28, H - 28);
    g.font = 'bold 40px Outfit, sans-serif';
    g.fillStyle = this.venue.accent;
    g.textBaseline = 'middle';
    g.fillText(this.venue.name.toUpperCase(), 40, 52);
    g.textAlign = 'right';
    g.fillStyle = '#9fb3d9';
    g.fillText(note, W - 40, 52);
    g.textAlign = 'left';
    rows.forEach((r, i) => {
      const y = 150 + i * 110;
      g.fillStyle = r.serving ? this.venue.accent : 'rgba(255,255,255,0.15)';
      g.beginPath();
      g.arc(52, y, 12, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = 'bold 72px Outfit, sans-serif';
      g.fillText(r.name.toUpperCase(), 84, y + 4);
      g.textAlign = 'right';
      g.fillStyle = '#ffffff';
      g.fillText(r.games, W - 220, y + 4);
      g.fillStyle = this.venue.accent;
      g.fillText(r.points, W - 50, y + 4);
      g.textAlign = 'left';
    });
    this.scoreTex.needsUpdate = true;
  }

  private buildFloodlights(): void {
    // Lamp banks along the front edge of the roof canopies (bloom makes them glow).
    const geo: THREE.BufferGeometry[] = [];
    const top = 1.25 + this.rows * 0.5 + 4.05;
    const edgeX = AREA.x + 1.2 + this.rows * 0.9 - 8.4;
    const edgeZ = AREA.z + 0.9 + this.rows * 0.9 - 8.4;
    const lamp = (x: number, z: number, ry: number) => {
      const b = new THREE.BoxGeometry(2.4, 0.55, 0.12);
      b.rotateX(-0.5);
      b.rotateY(ry);
      b.translate(x, top, z);
      geo.push(b);
    };
    for (let i = 0; i < 7; i++) {
      const z = -16 + i * 5.3;
      lamp(-edgeX, z, Math.PI / 2);
      lamp(edgeX, z, -Math.PI / 2);
    }
    for (let i = 0; i < 6; i++) {
      const x = -14 + i * 5.6;
      lamp(x, -edgeZ, 0);
      lamp(x, edgeZ, Math.PI);
    }
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.2, 2.4), toneMapped: false });
    this.lampMats.push(mat);
    this.group.add(new THREE.Mesh(mergeAll(geo), mat));
  }

  update(dt: number, t: number, ballX: number): void {
    this.crowd.update(dt, t, ballX);
  }
}

/** True for software renderers (SwiftShader, llvmpipe). */
export function isSoftwareGL(r: THREE.WebGLRenderer): boolean {
  try {
    const gl = r.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|software/i.test(name);
  } catch {
    return false;
  }
}

function colorize(g: THREE.BufferGeometry, c: THREE.Color): void {
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.toArray(a, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
}

/** Merge geometries that share the same attributes (non-indexed). */
export function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const list = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const names = Object.keys(list[0].attributes).filter((n) => list.every((g) => g.attributes[n]));
  const out = new THREE.BufferGeometry();
  for (const name of names) {
    const size = list[0].attributes[name].itemSize;
    let total = 0;
    for (const g of list) total += g.attributes[name].count;
    const arr = new Float32Array(total * size);
    let o = 0;
    for (const g of list) {
      const a = g.attributes[name] as THREE.BufferAttribute;
      arr.set(a.array as Float32Array, o);
      o += a.count * size;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  if (!out.attributes.normal) out.computeVertexNormals();
  return out;
}

// ---- ball and effects ----------------------------------------------------------------------------------

/** Ball geometry with the seam painted in vertex colours (shares the vertex-colour shader). */
function ballGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.036, 20, 14);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const seam: THREE.Vector3[] = [];
  for (let i = 0; i < 160; i++) {
    const t = (i / 160) * Math.PI * 2;
    seam.push(new THREE.Vector3(0.75 * Math.cos(t) + 0.25 * Math.cos(3 * t), 0.75 * Math.sin(t) - 0.25 * Math.sin(3 * t), 0.866 * Math.sin(2 * t)).normalize());
  }
  const felt = new THREE.Color('#d6ee3a');
  const line = new THREE.Color('#f4f8e6');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let d = 9;
    for (const q of seam) d = Math.min(d, v.distanceTo(q));
    (d < 0.11 ? line : felt).toArray(col, i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export class BallView {
  readonly mesh: THREE.Mesh;
  readonly shadow: THREE.Mesh;
  private trail: THREE.Mesh;
  private trailPts: THREE.Vector3[] = [];
  private trailGeo: THREE.BufferGeometry;
  private trailMat: THREE.MeshBasicMaterial;
  private spin = new THREE.Quaternion();

  constructor(scene: THREE.Scene) {
    // Drawn ~1.7x real size (with a little self-glow) so it reads on a TV from across the room.
    this.mesh = new THREE.Mesh(ballGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, emissive: new THREE.Color(0x56661a), emissiveIntensity: 0.9 }));
    this.mesh.scale.setScalar(1.7);
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    // Soft contact shadow (always visible: crucial depth cue).
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(0,0,0,0.75)');
    grd.addColorStop(0.5, 'rgba(0,0,0,0.35)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const st = new THREE.CanvasTexture(c);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: st, transparent: true, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 2;
    scene.add(this.shadow);
    // Trail ribbon (camera-facing strip, rebuilt each frame).
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 2 * 3), 3));
    this.trailGeo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(24 * 2), 1));
    const idx: number[] = [];
    for (let i = 0; i < 23; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    this.trailGeo.setIndex(idx);
    this.trailMat = new THREE.MeshBasicMaterial({ color: 0xeaff9a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.trailMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float alpha; varying float vA;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvA = alpha;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vA;')
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.a *= vA;');
    };
    this.trail = new THREE.Mesh(this.trailGeo, this.trailMat);
    this.trail.frustumCulled = false;
    scene.add(this.trail);
  }

  set visible(v: boolean) {
    this.mesh.visible = this.shadow.visible = v;
    if (!v) this.trailPts = [];
    this.trail.visible = v;
  }

  update(p: THREE.Vector3, vel: THREE.Vector3, dt: number, camera: THREE.Camera, speedForTrail: number): void {
    this.mesh.position.copy(p);
    const sp = vel.length();
    if (sp > 0.1 && dt > 0) {
      const axis = new THREE.Vector3(vel.z, 0, -vel.x).normalize();
      this.spin.setFromAxisAngle(axis, (sp * dt) / 0.036);
      this.mesh.quaternion.premultiply(this.spin);
    }
    const h = Math.max(0, p.y);
    const s = 0.1 + h * 0.025;
    this.shadow.scale.set(s, s, s);
    this.shadow.position.set(p.x, 0.006, p.z);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.62 * (1 - Math.min(1, h / 6) * 0.55);
    // Trail.
    // Trail: only recent, continuous positions (a strike or a slow frame restarts it).
    const prev = this.trailPts[0];
    if (prev && (prev.distanceTo(p) > 2.5 || dt > 0.08)) this.trailPts = [];
    this.trailPts.unshift(p.clone());
    if (this.trailPts.length > 10) this.trailPts.pop();
    const fade = THREE.MathUtils.clamp((speedForTrail - 16) / 14, 0, 1);
    this.trailMat.opacity = fade * 0.75;
    const pos = this.trailGeo.attributes.position as THREE.BufferAttribute;
    const al = this.trailGeo.attributes.alpha as THREE.BufferAttribute;
    const camPos = (camera as THREE.PerspectiveCamera).position;
    for (let i = 0; i < 24; i++) {
      const a = this.trailPts[Math.min(i, this.trailPts.length - 1)] ?? p;
      const b = this.trailPts[Math.min(i + 1, this.trailPts.length - 1)] ?? a;
      const dir = new THREE.Vector3().subVectors(a, b);
      const view = new THREE.Vector3().subVectors(camPos, a);
      const side = new THREE.Vector3().crossVectors(dir, view).normalize().multiplyScalar(0.03 * (1 - i / 24));
      if (!Number.isFinite(side.x)) side.set(0, 0, 0);
      pos.setXYZ(i * 2, a.x + side.x, a.y + side.y, a.z + side.z);
      pos.setXYZ(i * 2 + 1, a.x - side.x, a.y - side.y, a.z - side.z);
      const k = (1 - i / 23) ** 1.5;
      al.setX(i * 2, k);
      al.setX(i * 2 + 1, k);
    }
    pos.needsUpdate = true;
    al.needsUpdate = true;
  }
}

/** Short-lived particles: chalk puffs, dust, impact sparks. */
export class Puffs {
  readonly points: THREE.Points;
  private n = 220;
  private pos: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private col: Float32Array;
  private next = 0;

  constructor() {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(this.n * 3);
    this.vel = new Float32Array(this.n * 3);
    this.life = new Float32Array(this.n);
    this.col = new Float32Array(this.n * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d')!;
    const grd = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = grd;
    x.fillRect(0, 0, 32, 32);
    this.points = new THREE.Points(
      g,
      new THREE.PointsMaterial({ size: 0.16, map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, vertexColors: true, sizeAttenuation: true }),
    );
    this.points.frustumCulled = false;
    for (let i = 0; i < this.n; i++) this.pos[i * 3 + 1] = -10;
  }

  burst(p: { x: number; y: number; z: number }, color: THREE.Color, count: number, speed: number, up = 0.6): void {
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.n;
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y + 0.02;
      this.pos[i * 3 + 2] = p.z;
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.vel[i * 3] = Math.cos(a) * s;
      this.vel[i * 3 + 1] = up * (0.4 + Math.random()) * speed;
      this.vel[i * 3 + 2] = Math.sin(a) * s;
      this.life[i] = 0.6 + Math.random() * 0.5;
      color.toArray(this.col, i * 3);
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 1.2 * dt;
      const drag = 1 - 2.5 * dt;
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(0.02, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const f = Math.max(0, Math.min(1, this.life[i] / 0.5));
      this.col[i * 3] *= 0.985 + f * 0.015;
      this.col[i * 3 + 1] *= 0.985 + f * 0.015;
      this.col[i * 3 + 2] *= 0.985 + f * 0.015;
      if (this.life[i] <= 0) this.pos[i * 3 + 1] = -10;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

/** Glowing target rings for the rally challenge. */
export class Target {
  readonly group = new THREE.Group();
  private ring: THREE.Mesh;
  private disc: THREE.Mesh;
  private beam: THREE.Mesh;
  radius = 1.3;
  x = 0;
  z = 0;
  private pulse = 0;

  constructor(color: string) {
    const col = new THREE.Color(color);
    const mat = new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(1.6), transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.84, 1, 56), mat);
    this.ring.rotation.x = -Math.PI / 2;
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(0.84, 48), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false }));
    this.disc.rotation.x = -Math.PI / 2;
    const bull = new THREE.Mesh(new THREE.RingGeometry(0.0, 0.36, 40), mat.clone());
    (bull.material as THREE.MeshBasicMaterial).opacity = 0.75;
    bull.rotation.x = -Math.PI / 2;
    bull.position.y = 0.002;
    // A soft light column so the target reads from the far baseline.
    const bg = new THREE.CylinderGeometry(1, 1, 1.6, 40, 1, true);
    bg.translate(0, 0.8, 0);
    const beamMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false });
    this.beam = new THREE.Mesh(bg, beamMat);
    this.group.add(this.disc, this.ring, bull, this.beam);
    this.group.position.y = 0.012;
    this.group.renderOrder = 3;
  }

  place(x: number, z: number, r: number): void {
    this.x = x;
    this.z = z;
    this.radius = r;
    this.group.position.set(x, 0.012, z);
    this.group.scale.setScalar(r);
    this.pulse = 1;
  }

  hit(): void {
    this.pulse = 2;
  }

  update(dt: number, t: number): void {
    this.pulse = Math.max(0, this.pulse - dt * 2);
    const s = 1 + 0.04 * Math.sin(t * 4) + this.pulse * 0.15;
    this.ring.scale.setScalar(s);
    this.beam.scale.set(1, 0.6 + 0.4 * Math.sin(t * 2.2) ** 2 + this.pulse * 0.6, 1);
  }
}
