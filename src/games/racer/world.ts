/**
 * Builds the circuit scene from TrackData: road, kerbs, verges, barriers, grandstands with crowds, start
 * gantry, pit building, scenery, sky, water and lighting. Static geometry is merged or instanced to keep
 * draw calls low.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KERB_W, TrackGrid, sampleAt, worldAt, type TrackData } from './track';
import * as TX from './textures';

const BASE = import.meta.env.BASE_URL + 'assets/racer/';

export interface Textures {
  asphalt: THREE.Texture;
  asphaltN: THREE.Texture;
  asphaltR: THREE.Texture;
  grass: THREE.Texture;
  grassN: THREE.Texture;
  gravel: THREE.Texture;
  gravelN: THREE.Texture;
}

export async function loadTextures(maxAniso: number, onProgress?: (f: number) => void): Promise<Textures> {
  const loader = new THREE.TextureLoader();
  const files: [keyof Textures, string, boolean][] = [
    ['asphalt', 'asphalt_col.jpg', true],
    ['asphaltN', 'asphalt_nrm.jpg', false],
    ['asphaltR', 'asphalt_rgh.jpg', false],
    ['grass', 'grass_col.jpg', true],
    ['grassN', 'grass_nrm.jpg', false],
    ['gravel', 'gravel_col.jpg', true],
    ['gravelN', 'gravel_nrm.jpg', false],
  ];
  let done = 0;
  const out = {} as Textures;
  await Promise.all(
    files.map(async ([k, f, srgb]) => {
      const t = await loader.loadAsync(BASE + f);
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = Math.min(8, maxAniso);
      out[k] = t;
      onProgress?.(++done / files.length);
    }),
  );
  return out;
}

/** Small seeded RNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- ribbons along the track ---------------------------------------------------------------------------

interface RibbonOpts {
  /** Sample indices in order (wraps allowed). */
  idx: number[];
  /** Profile point k at sample i → [lateral offset d, height above the centre line]. */
  point(i: number, k: number): [number, number];
  across: number;
  uv(s: number, d: number, k: number, h: number): [number, number];
  color?(i: number, k: number, d: number): [number, number, number];
  bake?(x: number, y: number, z: number): number;
}

function ribbon(t: TrackData, o: RibbonOpts): THREE.BufferGeometry {
  const rows = o.idx.length;
  const cols = o.across;
  const pos = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  const col = o.color ? new Float32Array(rows * cols * 3) : null;
  const bake = o.bake ? new Float32Array(rows * cols) : null;
  let sAcc = 0;
  for (let r = 0; r < rows; r++) {
    const i = o.idx[r];
    if (r > 0) sAcc += t.step;
    for (let k = 0; k < cols; k++) {
      const [d, h] = o.point(i, k);
      const x = t.x[i] - t.tz[i] * d;
      const z = t.z[i] + t.tx[i] * d;
      const y = t.y[i] + h;
      const q = (r * cols + k) * 3;
      pos[q] = x;
      pos[q + 1] = y;
      pos[q + 2] = z;
      const [u, v] = o.uv(sAcc, d, k, h);
      uv[(r * cols + k) * 2] = u;
      uv[(r * cols + k) * 2 + 1] = v;
      if (col) {
        const c = o.color!(i, k, d);
        col[q] = c[0];
        col[q + 1] = c[1];
        col[q + 2] = c[2];
      }
      if (bake) bake[r * cols + k] = o.bake!(x, y, z);
    }
  }
  const index: number[] = [];
  for (let r = 0; r < rows - 1; r++)
    for (let k = 0; k < cols - 1; k++) {
      const a = r * cols + k;
      const b = (r + 1) * cols + k;
      const c = r * cols + k + 1;
      const d = (r + 1) * cols + k + 1;
      index.push(a, c, b, c, d, b);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (bake) g.setAttribute('bake', new THREE.BufferAttribute(bake, 1));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Contiguous runs of samples where pred is true (cyclic). */
function runs(n: number, pred: (i: number) => boolean, minLen = 3): number[][] {
  const out: number[][] = [];
  let start = 0;
  while (start < n && pred(start)) start++;
  if (start === n) return [Array.from({ length: n + 1 }, (_, k) => k % n)];
  let cur: number[] | null = null;
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (pred(i)) {
      cur ??= [(i - 1 + n) % n];
      cur.push(i);
    } else if (cur) {
      cur.push(i);
      if (cur.length >= minLen) out.push(cur);
      cur = null;
    }
  }
  return out;
}

const allIdx = (n: number) => Array.from({ length: n + 1 }, (_, k) => k % n);

/** Indices covering s ∈ [s0, s1] (s0 may be negative = before the line). */
function rangeIdx(t: TrackData, s0: number, s1: number): number[] {
  const out: number[] = [];
  const a = Math.round(s0 / t.step);
  const b = Math.round(s1 / t.step);
  for (let k = a; k <= b; k++) out.push(((k % t.n) + t.n) % t.n);
  return out;
}

/** Adds baked lamp light to a standard material (night circuits). */
function withBake<T extends THREE.MeshStandardMaterial>(m: T, color: THREE.Color): T {
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLamp = { value: color };
    sh.vertexShader = 'attribute float bake;\nvarying float vBake;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvBake = bake;');
    sh.fragmentShader =
      'uniform vec3 uLamp;\nvarying float vBake;\n' +
      sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uLamp * vBake;');
  };
  m.customProgramCacheKey = () => 'bake';
  return m;
}

// ---- sky -------------------------------------------------------------------------------------------------

const SKY_VERT = `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`;

function daySky(sunDir: THREE.Vector3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uSun: { value: sunDir.clone() }, uTime: { value: 0 } },
    vertexShader: SKY_VERT,
    fragmentShader: `
      varying vec3 vDir; uniform vec3 uSun; uniform float uTime;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
        return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y); }
      float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
      void main(){
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 zen = vec3(0.16, 0.36, 0.78);
        vec3 hor = vec3(0.70, 0.83, 0.95);
        vec3 col = mix(hor, zen, pow(h, 0.45));
        float sd = max(dot(d, normalize(uSun)), 0.0);
        col += vec3(1.0, 0.85, 0.6) * (pow(sd, 6.0) * 0.25 + pow(sd, 64.0) * 0.5);
        col += vec3(1.0, 0.95, 0.85) * smoothstep(0.9993, 0.9997, sd) * 8.0;
        // Clouds on a virtual plane.
        if (d.y > 0.0) {
          vec2 uv = d.xz / (d.y + 0.08) * 1.6 + vec2(uTime * 0.004, uTime * 0.002);
          float c = fbm(uv);
          c = smoothstep(0.52, 0.8, c) * smoothstep(0.0, 0.25, d.y);
          vec3 cc = mix(vec3(0.78, 0.82, 0.88), vec3(1.0, 0.98, 0.95), pow(sd, 3.0) + 0.4);
          col = mix(col, cc, c * 0.85);
        }
        // Haze toward the horizon and below.
        col = mix(col, vec3(0.74, 0.84, 0.93), smoothstep(0.08, -0.02, d.y));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

function nightSky(moonDir: THREE.Vector3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uMoon: { value: moonDir.clone() }, uTime: { value: 0 } },
    vertexShader: SKY_VERT,
    fragmentShader: `
      varying vec3 vDir; uniform vec3 uMoon; uniform float uTime;
      float hash(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      void main(){
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 zen = vec3(0.012, 0.018, 0.06);
        vec3 mid = vec3(0.05, 0.05, 0.16);
        vec3 hor = vec3(0.42, 0.20, 0.30);
        vec3 col = mix(mid, zen, smoothstep(0.0, 0.6, h));
        col = mix(hor, col, smoothstep(0.0, 0.22, h));
        // Warm city glow near the horizon.
        col += vec3(0.35, 0.16, 0.05) * exp(-h * 18.0) * 0.6;
        vec3 g = floor(d * 260.0);
        float s = step(0.9975, hash(g)) * smoothstep(0.05, 0.3, h);
        col += vec3(s) * (0.5 + 0.5 * sin(uTime * 2.0 + hash(g + 3.0) * 40.0)) * 0.8;
        float md = max(dot(d, normalize(uMoon)), 0.0);
        col += vec3(0.85, 0.9, 1.0) * smoothstep(0.99955, 0.9997, md) * 3.0;
        col += vec3(0.25, 0.3, 0.45) * pow(md, 40.0) * 0.4;
        col = mix(col, vec3(0.08, 0.07, 0.14), smoothstep(0.03, -0.05, d.y));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// ---- small geometry helpers ---------------------------------------------------------------------------------

function boxAt(w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

function nonIndexed(gs: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(
    gs.map((g) => {
      const n = g.index ? g.toNonIndexed() : g;
      for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) n.deleteAttribute(k);
      if (!n.attributes.normal) n.computeVertexNormals();
      if (!n.attributes.uv) n.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2));
      if (!n.attributes.color) {
        const c = new Float32Array(n.attributes.position.count * 3).fill(1);
        n.setAttribute('color', new THREE.BufferAttribute(c, 3));
      }
      return n;
    }),
  )!;
}

function tint(g: THREE.BufferGeometry, c: THREE.Color | string): THREE.BufferGeometry {
  const col = new THREE.Color(c);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = col.r;
    a[i * 3 + 1] = col.g;
    a[i * 3 + 2] = col.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** Low-poly tree crown: jittered icosphere with vertex colour variation. */
function crown(radius: number, color: THREE.Color, seed: number, squash = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(radius, 1).toNonIndexed();
  const r = rng(seed);
  const p = g.attributes.position;
  const map = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let j = map.get(key);
    if (j === undefined) map.set(key, (j = 0.82 + r() * 0.3));
    p.setXYZ(i, p.getX(i) * j, p.getY(i) * j * squash, p.getZ(i) * j);
  }
  g.computeVertexNormals();
  const c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const k = 0.75 + (p.getY(i) / radius) * 0.18 + r() * 0.08;
    c[i * 3] = color.r * k;
    c[i * 3 + 1] = color.g * k;
    c[i * 3 + 2] = color.b * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

// ---- the world -----------------------------------------------------------------------------------------------

export interface GridSlot {
  s: number;
  d: number;
}

export class World {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly sunDir: THREE.Vector3;
  readonly night: boolean;
  env: THREE.Texture | null = null;
  /** Points near the grandstands (for crowd sound). */
  readonly stands: THREE.Vector3[] = [];
  private grid: TrackGrid;
  private lampMat: THREE.ShaderMaterial | null = null;
  private crowdU = { uTime: { value: 0 }, uExcite: { value: 0.2 } };
  private skyMat: THREE.ShaderMaterial;
  private waterTex: THREE.Texture | null = null;
  private disposables: { dispose(): void }[] = [];
  private lamps: THREE.Vector3[] = [];
  private lampColor = new THREE.Color(1.0, 0.78, 0.5);
  private r = rng(7);

  constructor(
    private t: TrackData,
    private tx: Textures,
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private slots: GridSlot[],
  ) {
    this.night = t.def.theme === 'city';
    this.grid = new TrackGrid(t, 30);
    this.sunDir = this.night ? new THREE.Vector3(0.55, 0.42, -0.72).normalize() : new THREE.Vector3(-0.5, 0.62, 0.6).normalize();
    this.sun = new THREE.DirectionalLight(this.night ? 0xa8b8ff : 0xfff0d8, this.night ? 0.55 : 2.8);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -42;
    sc.right = 42;
    sc.top = 42;
    sc.bottom = -42;
    sc.near = 1;
    sc.far = 420;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.group.add(this.sun, this.sun.target);
    const hemi = this.night ? new THREE.HemisphereLight(0x3a4a8a, 0x15121a, 0.85) : new THREE.HemisphereLight(0xbfd9ff, 0x5a6448, 1.0);
    this.group.add(hemi);

    this.skyMat = this.night ? nightSky(this.sunDir) : daySky(this.sunDir);
    const sky = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), this.skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = -10;
    this.group.add(sky);
    scene.fog = this.night ? new THREE.FogExp2(0x161a33, 0.00085) : new THREE.FogExp2(0xb4c8dc, 0.00042);

    if (this.night) this.placeLamps();
    this.buildRoad();
    this.buildKerbs();
    this.buildVerge();
    this.buildWalls();
    this.buildTyreWalls();
    this.buildLines();
    this.buildGantry();
    this.buildPits();
    this.buildGrandstands();
    this.buildBillboards();
    if (this.night) this.buildCity();
    else this.buildCoast();
    this.buildEnv();
  }

  // ---- materials -----------------------------------------------------------------------------------

  private std(p: THREE.MeshStandardMaterialParameters, bake = false): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial(p);
    if (bake && this.night) withBake(m, this.lampColor);
    this.disposables.push(m);
    return m;
  }

  private mesh(g: THREE.BufferGeometry, m: THREE.Material, shadows: 'none' | 'receive' | 'both' = 'receive'): THREE.Mesh {
    const me = new THREE.Mesh(g, m);
    me.receiveShadow = shadows !== 'none';
    me.castShadow = shadows === 'both';
    me.matrixAutoUpdate = false;
    me.updateMatrix();
    this.group.add(me);
    return me;
  }

  // ---- lamps & baked light (night) -------------------------------------------------------------------

  private placeLamps(): void {
    const t = this.t;
    const every = Math.round(30 / t.step);
    for (let i = 0; i < t.n; i += every) {
      for (const side of [-1, 1]) {
        const w = (side > 0 ? t.wallR[i] : t.wallL[i]) - 1.4;
        const d = side * Math.max(t.hw + 0.5, w);
        this.lamps.push(new THREE.Vector3(t.x[i] - t.tz[i] * d, t.y[i] + 9.5, t.z[i] + t.tx[i] * d));
      }
    }
  }

  private bakeAt = (x: number, y: number, z: number): number => {
    let acc = 0;
    for (const l of this.lamps) {
      const dx = l.x - x;
      const dz = l.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 2500) continue;
      const dy = l.y - y;
      acc += Math.exp(-d2 / 150) * 0.75 + Math.exp(-d2 / 30) * 0.45 * (dy > 2 ? 1 : 0.5);
    }
    return Math.min(1.1, acc) * 0.62 + 0.04;
  };

  // ---- road --------------------------------------------------------------------------------------------

  private buildRoad(): void {
    const t = this.t;
    const hw = t.hw;
    const N = 12;
    const g = ribbon(t, {
      idx: allIdx(t.n),
      across: N + 1,
      point: (_i, k) => [-hw - 0.6 + ((2 * hw + 1.2) * k) / N, 0],
      uv: (s, d) => [(d + hw) / 7, s / 7],
      color: (i, _k, d) => {
        const line = t.line[i];
        const rub = Math.exp(-((d - line) ** 2) / 2.2);
        const edge = Math.abs(d) > hw ? 0.82 : 1;
        const sAlong = i * t.step;
        const grid = sAlong > t.length - 120 || sAlong < 15 ? 0.1 : 0;
        const k = (1 - rub * 0.3 - grid) * edge;
        return [k, k, k * 1.01];
      },
      bake: this.night ? this.bakeAt : undefined,
    });
    const m = this.std(
      {
        map: this.tx.asphalt,
        normalMap: this.tx.asphaltN,
        normalScale: new THREE.Vector2(0.7, 0.7),
        roughnessMap: this.tx.asphaltR,
        roughness: this.night ? 0.8 : 0.95,
        color: this.night ? 0x5c5c62 : 0x6e6e72,
        vertexColors: true,
        envMapIntensity: this.night ? 0.8 : 0.5,
      },
      true,
    );
    this.mesh(g, m);
  }

  private buildKerbs(): void {
    const t = this.t;
    const hw = t.hw;
    const prof: [number, number][] = [
      [hw - 0.15, 0.0],
      [hw + 0.25, 0.045],
      [hw + KERB_W - 0.35, 0.06],
      [hw + KERB_W, 0.015],
    ];
    const parts: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1] as const) {
      const arr = side > 0 ? t.kerbR : t.kerbL;
      for (const run of runs(t.n, (i) => arr[i] > 0.5, 4)) {
        parts.push(
          ribbon(t, {
            idx: run,
            across: prof.length,
            point: (_i, k) => {
              const p = side > 0 ? prof[k] : prof[prof.length - 1 - k];
              return [p[0] * side, p[1] + 0.012];
            },
            uv: (s, d) => [(Math.abs(d) - hw + 0.15) / (KERB_W + 0.15), s / 3.2],
            bake: this.night ? this.bakeAt : undefined,
          }),
        );
      }
    }
    if (!parts.length) return;
    const g = mergeGeometries(parts)!;
    const tex = TX.kerbTexture();
    this.disposables.push(tex);
    this.mesh(g, this.std({ map: tex, roughness: 0.55, envMapIntensity: 0.6 }, true));
  }

  private buildVerge(): void {
    const t = this.t;
    const hw = t.hw;
    const night = this.night;
    const parts: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1] as const) {
      const prof = (i: number): [number, number][] => {
        const w = side > 0 ? t.wallR[i] : t.wallL[i];
        return [
          [hw + 0.4, -0.03],
          [hw + 2.5, -0.05],
          [w - 0.5, -0.07],
          [w + 4, -0.12],
          [w + 9, night ? -0.15 : -0.5],
        ];
      };
      parts.push(
        ribbon(t, {
          idx: allIdx(t.n),
          across: 5,
          point: (i, k) => {
            const p = prof(i)[side > 0 ? k : 4 - k];
            return [p[0] * side, p[1]];
          },
          uv: (s, d) => [d / 6, s / 6],
          bake: night ? this.bakeAt : undefined,
        }),
      );
    }
    const g = mergeGeometries(parts)!;
    const m = night
      ? this.std({ map: this.tx.asphalt, normalMap: this.tx.asphaltN, color: 0x6a6c72, roughness: 0.9 }, true)
      : this.std({ map: this.tx.grass, normalMap: this.tx.grassN, color: 0xc6d8a8, roughness: 1 });
    this.mesh(g, m);

    // Gravel traps.
    if (t.def.gravel) {
      const gp: THREE.BufferGeometry[] = [];
      for (const side of [-1, 1] as const) {
        const arr = side > 0 ? t.gravelR : t.gravelL;
        for (const run of runs(t.n, (i) => arr[i] > 0, 6)) {
          gp.push(
            ribbon(t, {
              idx: run,
              across: 4,
              point: (i, k) => {
                const w = side > 0 ? t.wallR[i] : t.wallL[i];
                const a = hw + KERB_W + 0.8;
                const ds = [a, a + 1.2, w - 2.6, w - 1.2][side > 0 ? k : 3 - k];
                const hh = [0.0, 0.01, 0.01, 0.0][side > 0 ? k : 3 - k];
                return [ds * side, hh - 0.025];
              },
              uv: (s, d) => [d / 4, s / 4],
            }),
          );
        }
      }
      if (gp.length) this.mesh(mergeGeometries(gp)!, this.std({ map: this.tx.gravel, normalMap: this.tx.gravelN, color: 0xd8c4a0, roughness: 1 }));
    }
    // Painted asphalt run-off strip just outside the white line on corners (coast) for a modern look.
    if (!night) {
      const ap: THREE.BufferGeometry[] = [];
      for (const side of [-1, 1] as const) {
        const arr = side > 0 ? t.kerbR : t.kerbL;
        for (const run of runs(t.n, (i) => arr[i] > 0.5, 4)) {
          ap.push(
            ribbon(t, {
              idx: run,
              across: 2,
              point: (_i, k) => {
                const ds = [hw + KERB_W - 0.05, hw + KERB_W + 2.2][side > 0 ? k : 1 - k];
                return [ds * side, -0.012];
              },
              uv: (s, d) => [d / 7, s / 7],
            }),
          );
        }
      }
      if (ap.length)
        this.mesh(
          mergeGeometries(ap)!,
          this.std({ map: this.tx.asphalt, normalMap: this.tx.asphaltN, color: 0x6f8a78, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1 }),
        );
    }
  }

  private buildWalls(): void {
    const t = this.t;
    const night = this.night;
    const H = night ? 1.25 : 1.05;
    const T = 0.45;
    const parts: THREE.BufferGeometry[] = [];
    // Profile: track face (v 0.22..1 = ads, bottom to top), then top (v 0..0.22), then back.
    for (const side of [-1, 1] as const) {
      const pr = (i: number): [number, number, number][] => {
        const w = side > 0 ? t.wallR[i] : t.wallL[i];
        return [
          [w, -0.2, 1],
          [w, H, 0.22],
          [w + T, H, 0],
          [w + T, -0.2, 0],
        ];
      };
      parts.push(
        ribbon(t, {
          idx: allIdx(t.n),
          across: 4,
          point: (i, k) => {
            const p = pr(i)[side > 0 ? k : 3 - k];
            return [p[0] * side, p[1]];
          },
          uv: (s, _d, k) => [s / 96, [1, 0.22, 0.02, 0][side > 0 ? k : 3 - k]],
          bake: night ? this.bakeAt : undefined,
        }),
      );
    }
    const tex = TX.barrierTexture(night);
    this.disposables.push(tex);
    this.mesh(mergeGeometries(parts)!, this.std({ map: tex, roughness: 0.7, envMapIntensity: 0.5 }, true), 'receive');

    // Catch fences: everywhere at night (street circuit), near grandstands and the main straight on the coast.
    const fence: THREE.BufferGeometry[] = [];
    const FH = night ? 3.6 : 3.2;
    for (const side of [-1, 1] as const) {
      const pred = (i: number) => {
        if (night) return true;
        const sa = i * t.step > t.length / 2 ? i * t.step - t.length : i * t.step;
        return sa > t.def.pit[0] - 20 && sa < t.def.pit[1] + 40;
      };
      for (const run of runs(t.n, pred, 4)) {
        fence.push(
          ribbon(t, {
            idx: run,
            across: 2,
            point: (i, k) => {
              const w = (side > 0 ? t.wallR[i] : t.wallL[i]) + 0.2;
              const hh = [H, H + FH][side > 0 ? k : 1 - k];
              return [w * side, hh];
            },
            uv: (s, _d, _k, h) => [s / 1.6, (h - H) / 1.6],
          }),
        );
      }
    }
    if (fence.length) {
      const ft = TX.fenceTexture();
      this.disposables.push(ft);
      const fm = new THREE.MeshStandardMaterial({ map: ft, alphaTest: 0.45, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5, color: 0xc8ccd2 });
      fm.alphaToCoverage = true;
      this.disposables.push(fm);
      this.mesh(mergeGeometries(fence)!, fm, 'none');
      // Posts.
      const postGeo = new THREE.BoxGeometry(0.1, FH, 0.1);
      postGeo.translate(0, FH / 2, 0);
      const pts: THREE.Matrix4[] = [];
      const every = Math.max(1, Math.round(5 / t.step));
      for (const side of [-1, 1] as const)
        for (let i = 0; i < t.n; i += every) {
          const sa = i * t.step > t.length / 2 ? i * t.step - t.length : i * t.step;
          if (!night && !(sa > t.def.pit[0] - 20 && sa < t.def.pit[1] + 40)) continue;
          const w = ((side > 0 ? t.wallR[i] : t.wallL[i]) + 0.25) * side;
          pts.push(new THREE.Matrix4().makeTranslation(t.x[i] - t.tz[i] * w, t.y[i] + H, t.z[i] + t.tx[i] * w));
        }
      const posts = new THREE.InstancedMesh(postGeo, this.std({ color: 0x8c9096, metalness: 0.7, roughness: 0.4 }), pts.length);
      pts.forEach((m, i) => posts.setMatrixAt(i, m));
      this.group.add(posts);
    }
  }

  private buildTyreWalls(): void {
    const t = this.t;
    if (this.night) return;
    const mats: THREE.Matrix4[] = [];
    const cols: THREE.Color[] = [];
    const every = Math.max(1, Math.round(0.75 / t.step));
    const kS = new Float32Array(t.n);
    for (let i = 0; i < t.n; i++) kS[i] = t.curv[i];
    for (let i = 0; i < t.n; i += 1) {
      if (i % every) continue;
      const kk = sampleAt(t, kS, i * t.step);
      if (Math.abs(kk) < 1 / 160) continue;
      const side = kk > 0 ? 1 : -1; // outside
      const w = (side > 0 ? t.wallR[i] : t.wallL[i]) - 0.42;
      if (w < t.hw + 6) continue;
      const d = w * side;
      const m = new THREE.Matrix4().makeTranslation(t.x[i] - t.tz[i] * d, t.y[i] - 0.05, t.z[i] + t.tx[i] * d);
      mats.push(m);
      cols.push(new THREE.Color(Math.floor(i / every) % 2 ? 0xffffff : 0xd8192a));
    }
    if (!mats.length) return;
    // Stack of tyres (dark bands) with a painted top tyre (instance colour only affects the white band).
    const tiers: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 3; k++) {
      const c = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 10, 1, k === 2);
      c.translate(0, 0.14 + k * 0.27, 0);
      tiers.push(tint(c, k % 2 ? '#1a1a1a' : '#0c0c0c'));
    }
    const band = new THREE.CylinderGeometry(0.372, 0.372, 0.22, 10, 1, false);
    band.translate(0, 0.84, 0);
    tiers.push(tint(band, '#ffffff'));
    const stack = new THREE.InstancedMesh(nonIndexed(tiers), this.std({ vertexColors: true, roughness: 0.75 }), mats.length);
    mats.forEach((m, i) => {
      stack.setMatrixAt(i, m);
      stack.setColorAt(i, cols[i]);
    });
    stack.receiveShadow = true;
    this.group.add(stack);
  }

  private buildLines(): void {
    const t = this.t;
    const hw = t.hw;
    const parts: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      const c = side * (hw - 0.3);
      parts.push(
        ribbon(t, {
          idx: allIdx(t.n),
          across: 2,
          point: (_i, k) => [c + (k ? 0.11 : -0.11), 0.006],
          uv: () => [0, 0],
          bake: this.night ? this.bakeAt : undefined,
        }),
      );
    }
    // Grid boxes: a thin line across in front of each slot and a short line along its outer side.
    const quad = (s0: number, s1: number, d0: number, d1: number) => {
      const a = worldAt(t, s0, d0);
      const b = worldAt(t, s0, d1);
      const c = worldAt(t, s1, d0);
      const d = worldAt(t, s1, d1);
      const y = 0.007;
      const g = new THREE.BufferGeometry();
      // Two triangles facing up.
      g.setAttribute('position', new THREE.Float32BufferAttribute([a.x, a.y + y, a.z, b.x, b.y + y, b.z, c.x, c.y + y, c.z, b.x, b.y + y, b.z, d.x, d.y + y, d.z, c.x, c.y + y, c.z], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
      if (this.night) g.setAttribute('bake', new THREE.Float32BufferAttribute([a, b, c, b, d, c].map((p) => this.bakeAt(p.x, p.y, p.z)), 1));
      g.computeVertexNormals();
      if (g.attributes.normal.getY(0) < 0) {
        const pos = g.attributes.position.array as Float32Array;
        for (const k of [0, 3]) for (let q = 0; q < 3; q++) [pos[(k + 1) * 3 + q], pos[(k + 2) * 3 + q]] = [pos[(k + 2) * 3 + q], pos[(k + 1) * 3 + q]];
        g.computeVertexNormals();
      }
      return g;
    };
    for (const sl of this.slots) {
      const s = ((sl.s % t.length) + t.length) % t.length;
      parts.push(quad(s, s + 0.22, sl.d - 1.4, sl.d + 1.4));
      const out = sl.d + (sl.d > 0 ? 1.3 : -1.3);
      parts.push(quad(s - 4.5, s + 0.22, out - 0.09, out + 0.09));
    }
    const g = mergeGeometries(parts.map((q) => (q.index ? q.toNonIndexed() : q)))!;
    this.mesh(g, this.std({ color: this.night ? 0xb8b8b8 : 0xe6e6e6, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2 }, true));
    // Chequered start/finish line.
    const ch = TX.chequerTexture();
    this.disposables.push(ch);
    const sl = ribbon(t, { idx: [0, 1], across: 2, point: (_i, k) => [-hw + k * 2 * hw, 0.008], uv: (s, d) => [(d + hw) / (2 * hw), s / t.step], bake: this.night ? this.bakeAt : undefined });
    this.mesh(sl, this.std({ map: ch, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -3 }, true));
  }

  // ---- start gantry --------------------------------------------------------------------------------------

  private buildGantry(): void {
    const t = this.t;
    const i = Math.round(5 / t.step);
    const hw = t.hw;
    const g = new THREE.Group();
    g.position.set(t.x[i], t.y[i], t.z[i]);
    g.rotation.y = Math.atan2(t.tx[i], t.tz[i]);
    const span = hw + 1.6;
    const steel = '#2b2f36';
    const parts: THREE.BufferGeometry[] = [];
    for (const sx of [-1, 1]) parts.push(tint(boxAt(0.6, 7.6, 0.6, sx * span, 3.8, 0), steel));
    parts.push(tint(boxAt(span * 2 + 0.6, 0.8, 0.8, 0, 7.2, 0), steel));
    parts.push(tint(boxAt(span * 2 + 0.6, 0.25, 0.5, 0, 6.5, 0), steel));
    parts.push(tint(boxAt(5.6, 1.5, 0.35, 0, 5.55, -0.2), '#0b0b0d'));
    const frame = new THREE.Mesh(nonIndexed(parts), this.std({ vertexColors: true, metalness: 0.7, roughness: 0.4 }));
    frame.castShadow = true;
    g.add(frame);
    // All start lights in one mesh; a per-vertex lamp id is compared with the lit count in the shader.
    const lamps: THREE.BufferGeometry[] = [];
    const addLamp = (x: number, y: number, id: number) => {
      const c = new THREE.CircleGeometry(0.2, 16);
      c.rotateY(Math.PI);
      c.translate(x, y, -0.39);
      const n = c.attributes.position.count;
      c.setAttribute('lamp', new THREE.BufferAttribute(new Float32Array(n).fill(id), 1));
      lamps.push(c);
    };
    for (let col = 0; col < 5; col++) for (const row of [0, 1]) addLamp(-1.9 + col * 0.95, 5.25 + row * 0.55, col);
    for (const sx of [-1, 1]) addLamp(sx * 2.45, 5.55, 5);
    this.lampMat = new THREE.ShaderMaterial({
      uniforms: { uLit: { value: 0 }, uGo: { value: 0 } },
      vertexShader: 'attribute float lamp; varying float vL; void main(){ vL = lamp; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float uLit; uniform float uGo; varying float vL;
        void main(){
          vec3 c;
          if (vL < 4.5) c = mix(vec3(0.1, 0.01, 0.01), vec3(5.0, 0.3, 0.15), step(vL + 0.5, uLit));
          else c = mix(vec3(0.01, 0.07, 0.02), vec3(0.4, 4.0, 0.7), uGo);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
        #include <colorspace_fragment>
        }`,
    });
    this.disposables.push(this.lampMat);
    g.add(new THREE.Mesh(mergeGeometries(lamps)!, this.lampMat));
    // Banner with the circuit name on both faces.
    const bt = TX.bannerTexture(t.def.name, this.night ? '#14112e' : '#0d2a4f', '#ffffff');
    this.disposables.push(bt);
    const bm = this.std({ map: bt, roughness: 0.5, emissive: 0xffffff, emissiveMap: bt, emissiveIntensity: this.night ? 0.6 : 0.05 });
    const faces: THREE.BufferGeometry[] = [];
    for (const face of [-1, 1]) {
      const b = new THREE.PlaneGeometry(span * 2 - 1, (span * 2 - 1) / 8);
      if (face < 0) b.rotateY(Math.PI);
      b.translate(0, 7.2, face * 0.42);
      faces.push(b);
    }
    g.add(new THREE.Mesh(mergeGeometries(faces)!, bm));
    g.updateMatrixWorld(true);
    this.group.add(g);
  }

  /** Start lights: `lit` columns on (0..5); `go` turns them off and flashes green briefly. */
  setStartLights(lit: number, go: boolean): void {
    if (!this.lampMat) return;
    this.lampMat.uniforms.uLit.value = go ? 0 : lit;
    this.lampMat.uniforms.uGo.value = go ? 1 : 0;
  }

  // ---- pits ------------------------------------------------------------------------------------------------

  private buildPits(): void {
    const t = this.t;
    const hw = t.hw;
    const [p0, p1] = t.def.pit;
    // Pit lane asphalt.
    const lane = ribbon(t, {
      idx: rangeIdx(t, p0 + 10, p1 - 10),
      across: 2,
      point: (_i, k) => [hw + 3.1 + k * 12, -0.02],
      uv: (s, d) => [d / 7, s / 7],
      bake: this.night ? this.bakeAt : undefined,
    });
    this.mesh(lane, this.std({ map: this.tx.asphalt, normalMap: this.tx.asphaltN, color: 0x77777c, roughness: 0.9 }, true));
    // Pit building with garages.
    const colors = ['#c8102e', '#0aa5a5', '#1d3ec2', '#ff7a00', '#e9ecef', '#006b3c', '#6a1b9a', '#f6c90e'];
    const gt = TX.garageTexture(colors, this.night);
    this.disposables.push(gt);
    const B0 = hw + 15.5;
    const B1 = hw + 30;
    const HB = 9;
    const idx = rangeIdx(t, p0 + 30, p1 - 25);
    const facade = ribbon(t, {
      idx,
      across: 2,
      point: (_i, k) => [B0, k ? 0 : HB],
      uv: (s, _d, k) => [s / 170, k ? 0 : 1],
    });
    const fm = this.std({ map: gt, roughness: 0.5, metalness: 0.2, emissive: 0xffffff, emissiveMap: gt, emissiveIntensity: this.night ? 0.55 : 0.12 });
    this.mesh(facade, fm, 'receive');
    const shell = ribbon(t, {
      idx,
      across: 4,
      point: (_i, k) => [[B0 - 2.5, B0 - 2.5, B1, B1][k], [HB + 0.6, HB + 0.9, HB + 0.9, 0][k]],
      uv: () => [0, 0],
    });
    this.mesh(shell, this.std({ color: this.night ? 0x3a3f4a : 0xe6e9ee, roughness: 0.6, metalness: 0.2 }), 'both');
    // Control tower near the line.
    const i = Math.round(((t.length - 45) % t.length) / t.step);
    const d = hw + 24;
    const tower = new THREE.Group();
    tower.position.set(t.x[i] - t.tz[i] * d, t.y[i], t.z[i] + t.tx[i] * d);
    tower.rotation.y = Math.atan2(t.tx[i], t.tz[i]);
    const wallC = this.night ? '#3a3f4a' : '#eef0f2';
    const glassC = this.night ? '#4a6aa8' : '#1c2c3c';
    const tb = new THREE.Mesh(
      nonIndexed([tint(boxAt(7, 22, 7, 0, 11, 0), wallC), tint(boxAt(9.5, 4, 9.5, 0, 24, 0), glassC), tint(boxAt(10.5, 0.6, 10.5, 0, 26.3, 0), wallC)]),
      this.std({ vertexColors: true, roughness: 0.35, metalness: 0.3, emissive: this.night ? 0x223355 : 0x000000 }),
    );
    tb.castShadow = true;
    tower.add(tb);
    this.group.add(tower);
  }

  // ---- grandstands with crowd -------------------------------------------------------------------------

  private buildGrandstands(): void {
    const t = this.t;
    const specs: { s0: number; s1: number; side: 1 | -1 }[] = [];
    // Main straight (left side: sea / harbour side).
    specs.push({ s0: -320, s1: -40, side: -1 });
    specs.push({ s0: 30, s1: 190, side: -1 });
    // Outside of the slowest corners.
    const cs = [...t.corners].sort((a, b) => Math.abs(t.curv[Math.round(b.apex / t.step) % t.n]) - Math.abs(t.curv[Math.round(a.apex / t.step) % t.n]));
    for (const c of cs.slice(0, this.night ? 3 : 2)) {
      const side = (c.dir > 0 ? -1 : 1) as 1 | -1; // outside of a right turn is the left
      specs.push({ s0: c.apex - 70, s1: c.apex + 50, side });
    }
    const rows = 14;
    const seatParts: THREE.BufferGeometry[] = [];
    const roofParts: THREE.BufferGeometry[] = [];
    const people: THREE.Matrix4[] = [];
    const pcol: THREE.Color[] = [];
    const r = this.r;
    const shirt = ['#e63946', '#f1faee', '#457b9d', '#1d3557', '#ffb703', '#fb8500', '#2a9d8f', '#e9c46a', '#ffffff', '#c8102e', '#8338ec', '#06d6a0'];
    for (const sp of specs) {
      const idx = rangeIdx(t, sp.s0, sp.s1);
      // Base distance: clear of the barrier along the whole stand.
      let base = 0;
      for (const i of idx) base = Math.max(base, (sp.side > 0 ? t.wallR[i] : t.wallL[i]) + 3);
      // Skip stands that would collide with other parts of the circuit.
      let blocked = false;
      for (const i of idx) {
        const d = (base + rows * 0.9 + 4) * sp.side;
        const near = this.grid.nearest(t.x[i] - t.tz[i] * d, t.z[i] + t.tx[i] * d, i, Math.round(150 / t.step));
        if (near && near.dist < t.hw + 14) blocked = true;
      }
      if (blocked) continue;
      const prof: [number, number][] = [[base, -0.3], [base, 1.2]];
      for (let k = 0; k < rows; k++) {
        const d0 = base + k * 0.9;
        const h0 = 1.2 + k * 0.48;
        prof.push([d0 + 0.9, h0], [d0 + 0.9, h0 + 0.48]);
      }
      const back = base + rows * 0.9;
      prof.push([back + 0.3, 1.2 + rows * 0.48 + 1.2], [back + 0.3, -0.3]);
      const pts = sp.side > 0 ? prof : prof.slice().reverse();
      seatParts.push(
        ribbon(t, {
          idx,
          across: pts.length,
          point: (_i, k) => [pts[k][0] * sp.side, pts[k][1]],
          uv: () => [0, 0],
          color: (_i, k) => {
            const kk = sp.side > 0 ? k : pts.length - 1 - k;
            const row = Math.floor((kk - 2) / 2);
            if (kk < 2 || row >= rows) return [0.55, 0.57, 0.6];
            return row % 2 ? [0.12, 0.3, 0.62] : [0.85, 0.86, 0.88];
          },
        }),
      );
      const roofH = 1.2 + rows * 0.48 + 3.4;
      const rp: [number, number][] = [
        [base - 1.5, roofH - 0.6],
        [back + 1, roofH + 0.4],
        [back + 1, roofH + 0.1],
        [base - 1.5, roofH - 0.9],
      ];
      const rpp = sp.side > 0 ? rp : rp.slice().reverse();
      roofParts.push(ribbon(t, { idx, across: 4, point: (_i, k) => [rpp[k][0] * sp.side, rpp[k][1]], uv: () => [0, 0] }));
      // Pillars at the back.
      for (let q = 0; q < idx.length; q += Math.round(14 / t.step)) {
        const i = idx[q];
        const d = (back + 0.6) * sp.side;
        roofParts.push(boxAt(0.4, roofH, 0.4, t.x[i] - t.tz[i] * d, t.y[i] + roofH / 2, t.z[i] + t.tx[i] * d));
      }
      // Crowd.
      const step = Math.max(1, Math.round(0.62 / t.step));
      for (let q = 0; q < idx.length; q++) {
        const i = idx[q];
        for (let k = 0; k < rows; k++) {
          for (let sub = 0; sub < Math.ceil(t.step / 0.62); sub++) {
            if (r() < 0.18) continue;
            const f = sub / Math.ceil(t.step / 0.62);
            const j = idx[Math.min(idx.length - 1, q + 1)];
            const d = (base + k * 0.9 + 0.55 + (r() - 0.5) * 0.15) * sp.side;
            const x0 = t.x[i] + (t.x[j] - t.x[i]) * f;
            const z0 = t.z[i] + (t.z[j] - t.z[i]) * f;
            const x = x0 - t.tz[i] * d;
            const z = z0 + t.tx[i] * d;
            const y = t.y[i] + 1.2 + k * 0.48 + 0.48;
            const yaw = Math.atan2(t.tx[i], t.tz[i]) + (sp.side > 0 ? -Math.PI / 2 : Math.PI / 2);
            const sc = 0.9 + r() * 0.2;
            people.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(sc, sc, sc)));
            pcol.push(new THREE.Color(shirt[Math.floor(r() * shirt.length)]));
          }
        }
        void step;
      }
      const mid = idx[Math.floor(idx.length / 2)];
      const dm = (base + 6) * sp.side;
      this.stands.push(new THREE.Vector3(t.x[mid] - t.tz[mid] * dm, t.y[mid], t.z[mid] + t.tx[mid] * dm));
    }
    if (seatParts.length) {
      this.mesh(mergeGeometries(seatParts)!, this.std({ vertexColors: true, roughness: 0.8 }), 'receive');
      this.mesh(nonIndexed(roofParts), this.std({ color: this.night ? 0x4a505a : 0xdfe3e8, roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide }), 'both');
    }
    if (people.length) {
      // Spectators are camera-facing-ish sprites (2 triangles each) with 4 poses, tinted per person.
      const quad = new THREE.PlaneGeometry(0.62, 1.24);
      quad.translate(0, 0.5, 0);
      const ct = TX.crowdTexture();
      this.disposables.push(ct);
      const pm = new THREE.ShaderMaterial({
        fog: true,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          { uMap: { value: null }, uTime: { value: 0 }, uExcite: { value: 0.2 }, uLight: { value: this.night ? 0.62 : 1.0 } },
        ]),
        vertexShader: `
          uniform float uTime; uniform float uExcite;
          varying vec2 vUv; varying vec3 vCol; varying float vShade;
          #include <fog_pars_vertex>
          void main(){
            float id = float(gl_InstanceID);
            float variant = mod(floor(id * 7.31), 4.0);
            vUv = vec2((uv.x + variant) * 0.25, uv.y);
            #ifdef USE_INSTANCING_COLOR
              vCol = instanceColor;
            #else
              vCol = vec3(1.0);
            #endif
            vShade = 0.82 + 0.18 * fract(id * 0.618);
            vec3 p = position;
            float ph = id * 1.731;
            float jump = max(0.0, sin(uTime * (5.0 + mod(id, 4.0)) + ph));
            p.y += jump * jump * 0.25 * uExcite;
            p.x += sin(uTime * 1.7 + ph) * 0.03;
            vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mvPosition;
            #include <fog_vertex>
          }`,
        fragmentShader: `
          uniform sampler2D uMap; uniform float uLight;
          varying vec2 vUv; varying vec3 vCol; varying float vShade;
          #include <fog_pars_fragment>
          void main(){
            vec4 t = texture2D(uMap, vUv);
            if (t.a < 0.5) discard;
            vec3 skin = vec3(0.86, 0.64, 0.5) * vShade;
            vec3 c = vCol * t.r + skin * t.g + vec3(0.08, 0.07, 0.09) * t.b;
            c /= max(0.001, t.r + t.g + t.b);
            gl_FragColor = vec4(c * uLight * vShade, 1.0);
            #include <tonemapping_fragment>
        #include <colorspace_fragment>
            #include <fog_fragment>
          }`,
      });
      pm.uniforms.uMap.value = ct;
      pm.uniforms.uTime = this.crowdU.uTime;
      pm.uniforms.uExcite = this.crowdU.uExcite;
      this.disposables.push(pm);
      const crowd = new THREE.InstancedMesh(quad, pm, people.length);
      people.forEach((m, i) => {
        crowd.setMatrixAt(i, m);
        crowd.setColorAt(i, pcol[i]);
      });
      this.group.add(crowd);
    }
  }

  // ---- billboards & bridge ------------------------------------------------------------------------------

  private buildBillboards(): void {
    const t = this.t;
    const tex = TX.billboardTexture();
    this.disposables.push(tex);
    const boards: THREE.BufferGeometry[] = [];
    const frames: THREE.BufferGeometry[] = [];
    const r = this.r;
    const place = (g: THREE.BufferGeometry, x: number, y: number, z: number, yaw: number) => {
      g.rotateY(yaw);
      g.translate(x, y, z);
      return g;
    };
    const boardGeo = (w: number, h: number, row: number, v0 = 0, v1 = 1) => {
      const pg = new THREE.PlaneGeometry(w, h);
      const uv = pg.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setY(k, (3 - row) / 4 + (v0 + uv.getY(k) * (v1 - v0)) / 4);
      return pg;
    };
    let placed = 0;
    for (let i = 0; i < t.n && placed < 14; i += Math.round(170 / t.step)) {
      if (Math.abs(t.curv[i]) > 1 / 500) continue;
      const side = r() < 0.5 ? -1 : 1;
      const sa = i * t.step;
      if (side > 0 && (sa > t.length + t.def.pit[0] - 40 || sa < t.def.pit[1] + 40)) continue;
      const w = (side > 0 ? t.wallR[i] : t.wallL[i]) + 3.5;
      const near = this.grid.nearest(t.x[i] - t.tz[i] * (w + 6) * side, t.z[i] + t.tx[i] * (w + 6) * side, i, Math.round(120 / t.step));
      if (near && near.dist < t.hw + 10) continue;
      const d = w * side;
      const x = t.x[i] - t.tz[i] * d;
      const z = t.z[i] + t.tx[i] * d;
      const y = t.y[i];
      const yaw = Math.atan2(t.tx[i], t.tz[i]) + (side > 0 ? -Math.PI / 2 : Math.PI / 2);
      const b = boardGeo(16, 3.8, Math.floor(r() * 4));
      b.translate(0, 5.4, 0.12);
      boards.push(place(b, x, y, z, yaw));
      frames.push(place(boxAt(16.4, 4.2, 0.2, 0, 5.4, 0), x, y, z, yaw));
      for (const lx of [-6, 6]) frames.push(place(boxAt(0.3, 3.4, 0.3, lx, 1.7, 0), x, y, z, yaw));
      placed++;
    }
    // Sponsor bridge over the longest straight that is not the main one.
    let bestI = -1;
    let bestLen = 0;
    let cur = 0;
    for (let k = 0; k < t.n; k++) {
      const sa = k * t.step;
      const isMain = sa < 260 || sa > t.length - 450;
      if (Math.abs(t.curv[k]) < 1 / 900 && !isMain) {
        cur++;
        if (cur > bestLen) {
          bestLen = cur;
          bestI = k - Math.floor(cur / 2);
        }
      } else cur = 0;
    }
    if (bestI >= 0) {
      const i = bestI;
      const yaw = Math.atan2(t.tx[i], t.tz[i]);
      const span = Math.max(t.wallL[i], t.wallR[i]) + 2;
      const x = t.x[i];
      const y = t.y[i];
      const z = t.z[i];
      frames.push(place(boxAt(span * 2, 1.6, 3, 0, 7.8, 0), x, y, z, yaw), place(boxAt(1.2, 7.8, 3, -span, 3.9, 0), x, y, z, yaw), place(boxAt(1.2, 7.8, 3, span, 3.9, 0), x, y, z, yaw));
      for (const face of [-1, 1]) {
        const b = boardGeo(t.hw * 2 + 4, 1.4, face > 0 ? 0 : 2, 0.08, 0.92);
        if (face < 0) b.rotateY(Math.PI);
        b.translate(0, 7.8, face * 1.52);
        boards.push(place(b, x, y, z, yaw));
      }
    }
    if (boards.length) {
      const mat = this.std({ map: tex, roughness: 0.6, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: this.night ? 0.9 : 0.04 });
      this.mesh(mergeGeometries(boards)!, mat, 'none');
      const fm = this.mesh(nonIndexed(frames.map((f) => tint(f, this.night ? '#2e323a' : '#3a3f46'))), this.std({ vertexColors: true, metalness: 0.6, roughness: 0.45 }), 'both');
      void fm;
    }
  }

  // ---- terrain, water ------------------------------------------------------------------------------

  private bounds(): { cx: number; cz: number; size: number } {
    const t = this.t;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < t.n; i++) {
      x0 = Math.min(x0, t.x[i]);
      x1 = Math.max(x1, t.x[i]);
      z0 = Math.min(z0, t.z[i]);
      z1 = Math.max(z1, t.z[i]);
    }
    return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, size: Math.max(x1 - x0, z1 - z0) };
  }

  /** Distance to the circuit and its height there. */
  private near(x: number, z: number): { dist: number; y: number; i: number } {
    const n = this.grid.nearest(x, z);
    if (!n) return { dist: 1e9, y: 0, i: 0 };
    return { dist: n.dist, y: this.t.y[n.i], i: n.i };
  }

  private terrain(height: (x: number, z: number) => number, color: (x: number, z: number, h: number) => THREE.Color, size: number, seg: number, cx: number, cz: number, mat: THREE.Material): void {
    const g = new THREE.PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    const uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + cx;
      const z = p.getZ(i) + cz;
      const h = height(x, z);
      p.setXYZ(i, x, h, z);
      const c = color(x, z, h);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      uv.setXY(i, x / 9, z / 9);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    this.mesh(g, mat);
  }

  private water(y: number, cx: number, cz: number, size: number, color: number): void {
    const nt = TX.waterNormalTexture();
    nt.repeat.set(size / 60, size / 60);
    this.waterTex = nt;
    this.disposables.push(nt);
    const m = new THREE.MeshStandardMaterial({
      color,
      roughness: this.night ? 0.12 : 0.18,
      metalness: 0.1,
      normalMap: nt,
      normalScale: new THREE.Vector2(0.35, 0.35),
      envMapIntensity: this.night ? 1.4 : 1.1,
    });
    this.disposables.push(m);
    const w = new THREE.Mesh(new THREE.PlaneGeometry(size, size), m);
    w.rotation.x = -Math.PI / 2;
    w.position.set(cx, y, cz);
    w.receiveShadow = false;
    this.group.add(w);
  }

  // ---- coast scenery ------------------------------------------------------------------------------

  private buildCoast(): void {
    const t = this.t;
    const b = this.bounds();
    const seaZ = -75; // the sea lies north of the main straight (z < seaZ)
    const r = rng(11);
    const hill = (x: number, z: number) => {
      const n = Math.sin(x * 0.004 + 1.3) * Math.cos(z * 0.005 - 0.4) * 0.5 + Math.sin(x * 0.011 + z * 0.007) * 0.25;
      const inland = Math.max(0, (z - 200) / 600);
      return n * 14 + inland * inland * 60 + 4;
    };
    const height = (x: number, z: number) => {
      const nr = this.near(x, z);
      const far = hill(x, z);
      const k = Math.min(1, Math.max(0, (nr.dist - 40) / 160));
      let h = nr.y - 0.6 + (far - nr.y) * k * k * (3 - 2 * k);
      if (nr.dist < 34) h = nr.y - 0.9;
      // Beach and sea floor.
      if (z < seaZ + 30) {
        const s = Math.min(1, (seaZ + 30 - z) / 60);
        h = h * (1 - s) + (-3.5) * s;
      }
      return h;
    };
    const sand = new THREE.Color(1.55, 1.38, 1.0);
    const grassC = new THREE.Color(1, 1, 1);
    const dry = new THREE.Color(1.25, 1.12, 0.78);
    const color = (x: number, z: number, h: number) => {
      if (z < seaZ + 25 && h < 1.5) return sand;
      const k = Math.min(1, Math.max(0, (h - 12) / 30));
      return grassC.clone().lerp(dry, k * 0.8 + (Math.sin(x * 0.02) * Math.cos(z * 0.017) * 0.5 + 0.5) * 0.15);
    };
    const size = b.size + 2600;
    const tm = new THREE.MeshLambertMaterial({ map: this.tx.grass, vertexColors: true, color: 0xb9cc96 });
    this.disposables.push(tm);
    this.terrain(height, color, size, 150, b.cx, b.cz + 300, tm);
    this.water(-0.9, b.cx, seaZ - 2400, 5600, 0x0e5878);

    // Distant mountains to the south.
    {
      const ring: THREE.BufferGeometry[] = [];
      const N = 90;
      const pos: number[] = [];
      for (let k = 0; k <= N; k++) {
        const a = Math.PI * 0.05 + (k / N) * Math.PI * 0.9;
        const R = 3200;
        const x = b.cx + Math.cos(a) * R * 1.3;
        const z = b.cz + Math.sin(a) * R;
        const hgt = 260 + Math.sin(k * 0.7) * 120 + Math.sin(k * 2.3 + 1) * 60 + r() * 40;
        pos.push(x, -20, z, x, hgt, z);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const idx: number[] = [];
      for (let k = 0; k < N; k++) idx.push(k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 1, k * 2 + 3, k * 2 + 2);
      g.setIndex(idx);
      g.computeVertexNormals();
      ring.push(g);
      const m = new THREE.MeshBasicMaterial({ color: 0x7f97ad, side: THREE.DoubleSide, fog: true });
      this.disposables.push(m);
      const mm = new THREE.Mesh(g, m);
      this.group.add(mm);
    }

    // Trees: umbrella pines, cypresses and palms.
    const pineCrown = crown(4.2, new THREE.Color(0.2, 0.36, 0.16), 3, 0.42);
    pineCrown.translate(0, 9, 0);
    const pineTrunk = new THREE.CylinderGeometry(0.25, 0.4, 9, 6);
    pineTrunk.translate(0, 4.5, 0);
    const cypCrown = crown(1.6, new THREE.Color(0.14, 0.27, 0.13), 5, 3.4);
    cypCrown.translate(0, 6.5, 0);
    const cypTrunk = new THREE.CylinderGeometry(0.15, 0.22, 2, 5);
    cypTrunk.translate(0, 1, 0);
    const palmTrunk = this.palmTrunk();
    const palmLeaves = this.palmLeaves();
    const sets: { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry; n: number; area: (x: number, z: number) => boolean }[] = [
      { trunk: pineTrunk, crown: pineCrown, n: 380, area: (_x, z) => z > seaZ + 40 },
      { trunk: cypTrunk, crown: cypCrown, n: 260, area: (_x, z) => z > seaZ + 60 },
      { trunk: palmTrunk, crown: palmLeaves, n: 120, area: (_x, z) => z < 10 && z > seaZ - 5 },
    ];
    const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.disposables.push(treeMat);
    for (const st of sets) {
      const mats: THREE.Matrix4[] = [];
      let tries = 0;
      while (mats.length < st.n && tries++ < st.n * 40) {
        const x = b.cx + (r() - 0.5) * (b.size + 700);
        const z = b.cz + (r() - 0.5) * (b.size + 700) + 100;
        if (!st.area(x, z)) continue;
        const nr = this.near(x, z);
        const wall = Math.max(sampleAt(t, t.wallL, nr.i * t.step), sampleAt(t, t.wallR, nr.i * t.step));
        if (nr.dist < wall + 12) continue;
        if (this.stands.some((s) => Math.hypot(s.x - x, s.z - z) < 45)) continue;
        const h = height(x, z);
        if (h < -0.3) continue;
        const sc = 0.75 + r() * 0.5;
        mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, h - 0.2, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28), new THREE.Vector3(sc, sc, sc)));
      }
      const tree = new THREE.InstancedMesh(nonIndexed([tint(st.trunk, '#6b5440'), st.crown]), treeMat, mats.length);
      mats.forEach((m, i) => tree.setMatrixAt(i, m));
      this.group.add(tree);
    }

    // Hillside villas.
    {
      const mats: THREE.Matrix4[] = [];
      const cols: THREE.Color[] = [];
      const palette = ['#f3eee4', '#efe2cc', '#f6d9b5', '#e9e4dc', '#f2c9a0'];
      let tries = 0;
      while (mats.length < 140 && tries++ < 6000) {
        const x = b.cx + (r() - 0.5) * (b.size + 1600);
        const z = b.cz + 200 + r() * 900;
        const nr = this.near(x, z);
        if (nr.dist < 110) continue;
        const h = height(x, z);
        const w = 8 + r() * 10;
        const d = 8 + r() * 8;
        const hh = 5 + r() * 5;
        mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, h + hh / 2 - 0.5, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 3), new THREE.Vector3(w, hh, d)));
        cols.push(new THREE.Color(palette[Math.floor(r() * palette.length)]));
      }
      const house = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.buildingMaterial(false), mats.length);
      const roofGeo = new THREE.CylinderGeometry(0.0, 0.75, 0.45, 4, 1);
      roofGeo.rotateY(Math.PI / 4);
      roofGeo.translate(0, 0.72, 0);
      const roofs = new THREE.InstancedMesh(roofGeo, this.std({ color: 0xb4532a, roughness: 0.8 }), mats.length);
      mats.forEach((m, i) => {
        house.setMatrixAt(i, m);
        house.setColorAt(i, cols[i]);
        roofs.setMatrixAt(i, m);
      });
      this.group.add(house, roofs);
    }

    // Yachts on the bay.
    {
      const hull = new THREE.CylinderGeometry(0.0, 1.4, 9, 6, 1);
      hull.rotateX(Math.PI / 2);
      hull.scale(1, 0.45, 1);
      hull.translate(0, 0.3, 0);
      const sail = new THREE.BufferGeometry();
      sail.setAttribute('position', new THREE.Float32BufferAttribute([0, 1, 2.5, 0, 12, 0.5, 0, 1, -3, 0, 1, 2.5, 0, 1, -3, 0, 12, 0.5], 3));
      sail.computeVertexNormals();
      const hullMesh: THREE.Matrix4[] = [];
      for (let k = 0; k < 26; k++) {
        const x = b.cx + (r() - 0.5) * 2400;
        const z = seaZ - 120 - r() * 900;
        hullMesh.push(new THREE.Matrix4().compose(new THREE.Vector3(x, -0.9, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28), new THREE.Vector3(1, 1, 1)));
      }
      const ym = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
      this.disposables.push(ym);
      const hm = new THREE.InstancedMesh(nonIndexed([tint(hull, '#f8f8f8'), tint(sail, '#f1ede4')]), ym, hullMesh.length);
      hullMesh.forEach((m, i) => hm.setMatrixAt(i, m));
      this.group.add(hm);
    }
    // Lighthouse on the east point.
    {
      const lx = b.cx + b.size * 0.55;
      const lz = seaZ - 20;
      const tower = new THREE.CylinderGeometry(2.2, 3.4, 26, 14);
      tower.translate(0, 13, 0);
      const band = new THREE.CylinderGeometry(2.62, 2.92, 4, 14);
      band.translate(0, 15, 0);
      const top = new THREE.CylinderGeometry(2.6, 2.6, 3, 10);
      top.translate(0, 27.5, 0);
      const rock = new THREE.IcosahedronGeometry(9, 0);
      rock.scale(1.6, 0.5, 1.3);
      const g = nonIndexed([tint(rock, '#8a8070'), tint(tower, '#f4f4f4'), tint(band, '#c8102e'), tint(top, '#2a3038')]);
      g.translate(lx, -0.5, lz);
      this.mesh(g, this.std({ vertexColors: true, roughness: 0.7 }), 'none');
    }
  }

  private palmTrunk(): THREE.BufferGeometry {
    const c = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.4, 4, 0), new THREE.Vector3(1.4, 8, 0), new THREE.Vector3(2.4, 10.5, 0)]);
    return new THREE.TubeGeometry(c, 8, 0.24, 5, false);
  }

  private palmLeaves(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      const pos: number[] = [];
      const L = 4.2;
      const seg = 6;
      for (let s = 0; s < seg; s++) {
        const f0 = s / seg;
        const f1 = (s + 1) / seg;
        const p = (f: number, side: number) => {
          const r = f * L;
          const w = Math.sin(f * Math.PI) * 0.7 * side;
          const droop = -f * f * 2.2;
          const x = Math.cos(a) * r - Math.sin(a) * w;
          const z = Math.sin(a) * r + Math.cos(a) * w;
          return [x + 2.4, 10.5 + droop + f * 0.6, z];
        };
        pos.push(...p(f0, -1), ...p(f1, -1), ...p(f0, 1), ...p(f0, 1), ...p(f1, -1), ...p(f1, 1));
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      parts.push(tint(g, new THREE.Color(0.22, 0.42, 0.15)));
    }
    return mergeGeometries(parts)!;
  }

  /** Buildings: windows drawn procedurally in world space (lit at night). */
  private buildingMaterial(night: boolean): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0.1 });
    const lit = night ? 1 : 0;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uLit = { value: lit };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP; varying vec3 vWN; varying float vSeed;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          vec4 rwp = vec4(transformed, 1.0);
          vec3 rwn = objectNormal;
          #ifdef USE_INSTANCING
            rwp = instanceMatrix * rwp;
            rwn = mat3(instanceMatrix) * rwn;
            vSeed = float(gl_InstanceID);
          #else
            vSeed = 0.0;
          #endif
          vWP = (modelMatrix * rwp).xyz;
          vWN = normalize(mat3(modelMatrix) * rwn);`,
        );
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP; varying vec3 vWN; varying float vSeed; uniform float uLit;')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
          vec3 an = abs(vWN);
          if (an.y < 0.5) {
            float along = an.x > an.z ? vWP.z : vWP.x;
            vec2 cell = vec2(along / 3.1, (vWP.y - 0.6) / 3.5);
            vec2 f = fract(cell);
            vec2 id = floor(cell);
            float win = step(0.16, f.x) * step(f.x, 0.84) * step(0.22, f.y) * step(f.y, 0.82) * step(0.0, id.y);
            float h = fract(sin(dot(id + vec2(vSeed * 7.13, vSeed * 3.7), vec2(12.9898, 78.233))) * 43758.5453);
            vec3 wc = mix(vec3(1.0, 0.72, 0.42), vec3(0.62, 0.8, 1.0), step(0.78, fract(h * 13.7)));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.08, 0.1), win * 0.8);
            totalEmissiveRadiance += win * step(0.42, h) * wc * uLit * (0.5 + 0.9 * fract(h * 91.3));
          }`,
        );
    };
    m.customProgramCacheKey = () => `bld${lit}`;
    this.disposables.push(m);
    return m;
  }

  // ---- city scenery -------------------------------------------------------------------------------------

  private buildCity(): void {
    const t = this.t;
    const b = this.bounds();
    const r = rng(23);
    const quayX = -32; // harbour water west of the main straight
    // Ground: pavement plane with baked lamp light... use a big plane slightly below the verge.
    const size = b.size + 3000;
    const gm = new THREE.MeshLambertMaterial({ map: this.tx.asphalt, color: 0x4a4c52 });
    this.disposables.push(gm);
    this.terrain(
      (x, z) => {
        const nr = this.near(x, z);
        return x < quayX - 4 && nr.dist > 25 ? -3 : nr.dist < 30 ? nr.y - 0.25 : -0.2;
      },
      () => new THREE.Color(1, 1, 1),
      size,
      90,
      b.cx,
      b.cz,
      gm,
    );
    this.water(-1.2, quayX - 2800, b.cz, 5600, 0x0a1a2a);
    // Quay edge wall.
    {
      const qm = this.std({ color: 0x55585e, roughness: 0.9 });
      const q = new THREE.Mesh(boxAt(2, 4, size, quayX - 3, -1.5, b.cz), qm);
      this.group.add(q);
    }

    // City blocks.
    const mats: THREE.Matrix4[] = [];
    const cols: THREE.Color[] = [];
    const facade = ['#3a3f4a', '#4a4f5c', '#2e3440', '#5b5f6a', '#40465a', '#353a48', '#6a6058'];
    const span = b.size + 1500;
    const cell = 46;
    for (let gx = -span / 2; gx < span / 2; gx += cell)
      for (let gz = -span / 2; gz < span / 2; gz += cell) {
        const x = b.cx + gx + (r() - 0.5) * 8;
        const z = b.cz + gz + (r() - 0.5) * 8;
        if (x < quayX + 30) continue;
        const nr = this.near(x, z);
        const wall = Math.max(sampleAt(t, t.wallL, nr.i * t.step), sampleAt(t, t.wallR, nr.i * t.step));
        const w = 18 + r() * 18;
        const d = 18 + r() * 18;
        if (nr.dist < wall + Math.max(w, d) * 0.72 + 7) continue;
        if (this.stands.some((s) => Math.hypot(s.x - x, s.z - z) < 50)) continue;
        if (r() < 0.12) continue;
        const distC = Math.hypot(x - b.cx, z - b.cz);
        const hh = 14 + r() * 30 + (distC > b.size * 0.5 ? r() * 90 : 0) + (r() < 0.08 ? 60 : 0);
        mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, hh / 2 - 0.3, z), new THREE.Quaternion(), new THREE.Vector3(w, hh, d)));
        cols.push(new THREE.Color(facade[Math.floor(r() * facade.length)]));
      }
    // Far skyline across the harbour.
    for (let k = 0; k < 110; k++) {
      const x = quayX - 700 - r() * 900;
      const z = b.cz + (r() - 0.5) * 2600;
      const w = 25 + r() * 40;
      const hh = 30 + r() * 160;
      mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, hh / 2 - 2, z), new THREE.Quaternion(), new THREE.Vector3(w, hh, w)));
      cols.push(new THREE.Color(facade[Math.floor(r() * facade.length)]));
    }
    const bm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.buildingMaterial(true), mats.length);
    mats.forEach((m, i) => {
      bm.setMatrixAt(i, m);
      bm.setColorAt(i, cols[i]);
    });
    bm.receiveShadow = true;
    this.group.add(bm);
    // Rooftop warning lights on tall buildings.
    {
      const tops: THREE.Matrix4[] = [];
      mats.forEach((m) => {
        const p = new THREE.Vector3();
        const s = new THREE.Vector3();
        m.decompose(p, new THREE.Quaternion(), s);
        if (s.y > 70) tops.push(new THREE.Matrix4().makeTranslation(p.x, p.y + s.y / 2 + 1, p.z));
      });
      const lm = new THREE.MeshBasicMaterial({ color: 0xff2020 });
      lm.color.multiplyScalar(3);
      this.disposables.push(lm);
      const tl = new THREE.InstancedMesh(new THREE.SphereGeometry(0.8, 6, 4), lm, tops.length);
      tops.forEach((m, i) => tl.setMatrixAt(i, m));
      this.group.add(tl);
    }

    // Street lamps (poles + glowing heads).
    {
      const pole = new THREE.CylinderGeometry(0.12, 0.18, 9.8, 6);
      pole.translate(0, 4.9, 0);
      const arm = new THREE.BoxGeometry(0.12, 0.12, 2.0);
      arm.translate(0, 9.7, 1.0);
      const pg = mergeGeometries([pole.toNonIndexed(), arm.toNonIndexed()])!;
      const head = new THREE.BoxGeometry(0.5, 0.18, 0.9);
      head.translate(0, 9.55, 1.9);
      const pm: THREE.Matrix4[] = [];
      for (const l of this.lamps) {
        // Lamp head sits over the track: find the direction to the track centre line.
        const nr = this.grid.nearest(l.x, l.z)!;
        const cx = t.x[nr.i];
        const cz = t.z[nr.i];
        const yaw = Math.atan2(cx - l.x, cz - l.z);
        const base = new THREE.Vector3(l.x - Math.sin(yaw) * 1.9, t.y[nr.i], l.z - Math.cos(yaw) * 1.9);
        pm.push(new THREE.Matrix4().compose(base, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1)));
      }
      const poles = new THREE.InstancedMesh(pg, this.std({ color: 0x23262c, metalness: 0.6, roughness: 0.5 }), pm.length);
      const hm = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.85, 0.6).multiplyScalar(4) });
      this.disposables.push(hm);
      const heads = new THREE.InstancedMesh(head, hm, pm.length);
      pm.forEach((m, i) => {
        poles.setMatrixAt(i, m);
        heads.setMatrixAt(i, m);
      });
      this.group.add(poles, heads);
    }

    // Palms along the quay.
    {
      const trunk = this.palmTrunk();
      const leaves = this.palmLeaves();
      const ms: THREE.Matrix4[] = [];
      for (let z = b.cz - 900; z < b.cz + 900; z += 26) {
        const x = quayX + 8 + (r() - 0.5) * 3;
        const nr = this.near(x, z);
        if (nr.dist < 14) continue;
        if (this.stands.some((s) => Math.hypot(s.x - x, s.z - z) < 30)) continue;
        ms.push(new THREE.Matrix4().compose(new THREE.Vector3(x, -0.2, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28), new THREE.Vector3(1, 1, 1)));
      }
      const pmat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, color: 0x9ab09a });
      this.disposables.push(pmat);
      const palms = new THREE.InstancedMesh(nonIndexed([tint(trunk, '#4a3c30'), leaves]), pmat, ms.length);
      ms.forEach((m, i) => palms.setMatrixAt(i, m));
      this.group.add(palms);
    }

    // Moored boats with lights.
    {
      const hull = new THREE.CylinderGeometry(0.0, 2.2, 14, 6, 1);
      hull.rotateX(Math.PI / 2);
      hull.scale(1, 0.5, 1);
      const cabin = new THREE.BoxGeometry(2.6, 1.6, 5);
      cabin.translate(0, 1.2, -1.5);
      const bg = mergeGeometries([hull.toNonIndexed(), cabin.toNonIndexed()])!;
      const ms: THREE.Matrix4[] = [];
      for (let k = 0; k < 40; k++) {
        const x = quayX - 20 - r() * 260;
        const z = b.cz + (r() - 0.5) * 1600;
        ms.push(new THREE.Matrix4().compose(new THREE.Vector3(x, -1.0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28), new THREE.Vector3(1, 1, 1)));
      }
      const boats = new THREE.InstancedMesh(bg, this.std({ color: 0xe8e8ec, roughness: 0.4, emissive: 0x332a18, emissiveIntensity: 0.6 }), ms.length);
      const lm = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.9, 0.6).multiplyScalar(3) });
      this.disposables.push(lm);
      const lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 6, 4), lm, ms.length);
      ms.forEach((m, i) => {
        boats.setMatrixAt(i, m);
        lights.setMatrixAt(i, m.clone().multiply(new THREE.Matrix4().makeTranslation(0, 4.5, -1)));
      });
      this.group.add(boats, lights);
    }
  }

  // ---- environment map ---------------------------------------------------------------------------------------

  private buildEnv(): void {
    const envScene = new THREE.Scene();
    const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), this.skyMat);
    envScene.add(sky);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(400, 32), new THREE.MeshBasicMaterial({ color: this.night ? 0x0c0d12 : 0x5d6a4a }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -2;
    envScene.add(ground);
    const r = rng(5);
    // Bright blocks (grandstands / buildings / lights) for interesting reflections.
    for (let k = 0; k < (this.night ? 70 : 14); k++) {
      const a = r() * Math.PI * 2;
      const d = 60 + r() * 120;
      const h = this.night ? 3 + r() * 40 : 8 + r() * 10;
      const col = this.night ? new THREE.Color(1, 0.75 + r() * 0.2, 0.5).multiplyScalar(0.6 + r() * 2.2) : new THREE.Color(0.95, 0.95, 0.95);
      const m = new THREE.Mesh(new THREE.BoxGeometry(this.night ? 4 : 40, this.night ? 2 + r() * 3 : h, this.night ? 4 : 10), new THREE.MeshBasicMaterial({ color: col }));
      m.position.set(Math.cos(a) * d, h, Math.sin(a) * d);
      m.lookAt(0, h, 0);
      envScene.add(m);
    }
    const pm = new THREE.PMREMGenerator(this.renderer);
    const rt = pm.fromScene(envScene, 0.02, 0.1, 1000);
    this.env = rt.texture;
    this.scene.environment = rt.texture;
    this.disposables.push(rt, pm);
    envScene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material && m.material !== this.skyMat) (m.material as THREE.Material).dispose();
    });
  }

  // ---- per frame --------------------------------------------------------------------------------------------

  /** Follow the focus point with the sun's shadow camera; animate crowd and water. */
  update(dt: number, time: number, focus: THREE.Vector3, excite: number): void {
    const snap = 0.5;
    const fx = Math.round(focus.x / snap) * snap;
    const fz = Math.round(focus.z / snap) * snap;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + this.sunDir.x * 200, focus.y + this.sunDir.y * 200, fz + this.sunDir.z * 200);
    this.sun.target.updateMatrixWorld();
    this.crowdU.uTime.value = time;
    this.crowdU.uExcite.value += (excite - this.crowdU.uExcite.value) * Math.min(1, dt * 2);
    this.skyMat.uniforms.uTime.value = time;
    if (this.waterTex) {
      this.waterTex.offset.x = (time * 0.004) % 1;
      this.waterTex.offset.y = (time * 0.003) % 1;
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.scene.environment = null;
  }
}
