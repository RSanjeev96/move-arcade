/** Stadium pieces shared by both grounds: sky, stepped stands, an instanced animated crowd, floodlights. */
import * as THREE from 'three';
import { canvas, crowdAtlas, glowTexture, lampTexture, tex } from './textures';

// ---- sky ---------------------------------------------------------------------------------------------

export interface SkyOpts {
  night: boolean;
  /** Day: the panorama image (top half of an equirect, zenith at the top). */
  image?: HTMLImageElement;
  /** Azimuth (deg, 0 = down the ground towards -z, + towards +x) where the sun should sit. */
  sunAz: number;
}

/** Where the sun is in the bundled panorama (u across, elevation degrees). */
const PANO_SUN = { u: 0.592, el: 46 };

export function makeSky(o: SkyOpts): { mesh: THREE.Mesh; sunDir: THREE.Vector3; envSource: THREE.Texture } {
  const rot = PANO_SUN.u - (o.sunAz / 360);
  const geo = new THREE.SphereGeometry(1200, 48, 24);
  let mat: THREE.ShaderMaterial;
  let env: THREE.Texture;
  if (!o.night && o.image) {
    const t = new THREE.Texture(o.image);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.needsUpdate = true;
    mat = new THREE.ShaderMaterial({
      uniforms: { uSky: { value: t }, uRot: { value: rot }, uHaze: { value: new THREE.Color(0xc9d6e6) } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform sampler2D uSky; uniform float uRot; uniform vec3 uHaze; varying vec3 vDir;
        void main(){
          vec3 d = normalize(vDir);
          float az = atan(d.x, -d.z);
          float u = fract(az / 6.2831853 + uRot);
          float el = asin(clamp(d.y, -1.0, 1.0));
          float v = clamp(el / 1.5707963, 0.003, 0.997);
          vec3 c = texture2D(uSky, vec2(u, v)).rgb;
          c = mix(c, uHaze, smoothstep(0.16, -0.02, el) * 0.55);
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    // Environment source: the panorama over a ground-coloured lower half.
    const [c, g] = canvas(1024, 512);
    const off = Math.round(((1 - rot) % 1) * 1024);
    g.drawImage(o.image, -off, 0, 1024, 256);
    g.drawImage(o.image, 1024 - off, 0, 1024, 256);
    const grd = g.createLinearGradient(0, 256, 0, 512);
    grd.addColorStop(0, '#8f9a86');
    grd.addColorStop(0.15, '#4d6b38');
    grd.addColorStop(1, '#2f4a24');
    g.fillStyle = grd;
    g.fillRect(0, 256, 1024, 256);
    env = tex(c);
    env.mapping = THREE.EquirectangularReflectionMapping;
  } else {
    mat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying vec3 vDir;
        float hash(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
        void main(){
          vec3 d = normalize(vDir);
          float el = d.y;
          vec3 zen = vec3(0.004, 0.006, 0.02);
          vec3 hor = vec3(0.05, 0.06, 0.11);
          vec3 c = mix(hor, zen, smoothstep(0.0, 0.55, el));
          c += vec3(0.16, 0.1, 0.06) * exp(-max(el, 0.0) * 9.0) * 0.6;
          vec3 q = d * 700.0;
          vec3 g = floor(q);
          float r = length(fract(q) - 0.5);
          float s = step(0.996, hash(g)) * smoothstep(0.42, 0.05, r) * smoothstep(0.08, 0.4, el);
          c += vec3(s * (0.45 + 0.55 * hash(g + 3.0)));
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    const [c, g] = canvas(512, 256);
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#02030a');
    grd.addColorStop(0.42, '#141a33');
    grd.addColorStop(0.5, '#2a2a30');
    grd.addColorStop(1, '#1b2a17');
    g.fillStyle = grd;
    g.fillRect(0, 0, 512, 256);
    // Floodlight banks as bright spots for reflections.
    for (let i = 0; i < 6; i++) {
      const x = (i / 6) * 512 + 40;
      const glow = g.createRadialGradient(x, 70, 0, x, 70, 26);
      glow.addColorStop(0, 'rgba(255,255,240,1)');
      glow.addColorStop(1, 'rgba(255,255,240,0)');
      g.fillStyle = glow;
      g.fillRect(x - 30, 40, 60, 60);
    }
    env = tex(c);
    env.mapping = THREE.EquirectangularReflectionMapping;
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  const az = (o.sunAz * Math.PI) / 180;
  const el = (PANO_SUN.el * Math.PI) / 180;
  const sunDir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  return { mesh, sunDir, envSource: env };
}

// ---- stands --------------------------------------------------------------------------------------

export interface Edge {
  /** Point on the ground at parameter a (any monotonic parameter, e.g. angle). */
  at(a: number): { x: number; z: number };
}

export interface Tier {
  /** Outward offset where the tier starts (from the edge) and its starting height. */
  o: number;
  h: number;
  rows: number;
  /** Row depth (outward) and rise per row (m). */
  depth: number;
  rise: number;
}

export interface BowlOpts {
  edge: Edge;
  /** A point on the field side of the stands (normals point away from it). */
  centre: { x: number; z: number };
  /** Parameter range and number of segments. */
  a0: number;
  a1: number;
  segments: number;
  /** Skip ranges of the parameter (gaps for sight screens, batter's eye…). */
  gaps?: [number, number][];
  tiers: Tier[];
  /** Front wall height and colour. */
  wallH: number;
  wallColor: number;
  seatColors: number[];
  /** Back wall height above the last row. */
  backH: number;
  /** Roof over the top tier: inward overhang (m), height above the last row; only where roofMask(a) is true. */
  roof?: { over: number; up: number; mask: (a: number) => boolean };
  /** Crowd density 0..1 per parameter value. */
  crowd: (a: number) => number;
}

export interface CrowdSeat {
  p: THREE.Vector3;
  a: number;
  shade: number;
}

/** Build stepped stands along an edge; returns the mesh and the list of seats for the crowd. */
export function buildBowl(o: BowlOpts): { mesh: THREE.Mesh; roof: THREE.Mesh | null; seats: CrowdSeat[] } {
  const pos: number[] = [];
  const col: number[] = [];
  const roofPos: number[] = [];
  const seats: CrowdSeat[] = [];
  const conc = new THREE.Color(0x8d8c88);
  const dark = new THREE.Color(0x4a4a4e);
  const wallC = new THREE.Color(o.wallColor);
  const inGap = (a: number) => (o.gaps ?? []).some(([g0, g1]) => a > g0 && a < g1);
  const N = o.segments;
  const frame = (a: number) => {
    const p = o.edge.at(a);
    const e = 1e-3 * (o.a1 - o.a0);
    const q = o.edge.at(a + e);
    const r = o.edge.at(a - e);
    const tx = q.x - r.x;
    const tz = q.z - r.z;
    const l = Math.hypot(tx, tz) || 1;
    // Outward normal: rotate the tangent; orientation chosen so it points away from the field centre side.
    let nx = tz / l;
    let nz = -tx / l;
    if (nx * (p.x - o.centre.x) + nz * (p.z - o.centre.z) < 0) {
      nx = -nx;
      nz = -nz;
    }
    return { x: p.x, z: p.z, nx, nz };
  };
  const quad = (arr: number[], c: THREE.Color | null, a: number[], b: number[], cc: number[], d: number[]) => {
    arr.push(...a, ...b, ...cc, ...a, ...cc, ...d);
    if (c) for (let i = 0; i < 6; i++) col.push(c.r, c.g, c.b);
  };
  const P = (f: { x: number; z: number; nx: number; nz: number }, off: number, h: number) => [f.x + f.nx * off, h, f.z + f.nz * off];
  const rnd = (() => {
    let s = 12345;
    return () => ((s = (s * 16807) % 2147483647) / 2147483647);
  })();
  for (let i = 0; i < N; i++) {
    const a = o.a0 + ((o.a1 - o.a0) * i) / N;
    const b = o.a0 + ((o.a1 - o.a0) * (i + 1)) / N;
    const mid = (a + b) / 2;
    if (inGap(mid)) continue;
    const fa = frame(a);
    const fb = frame(b);
    const sector = Math.floor((i / N) * o.seatColors.length * 3) % o.seatColors.length;
    const seatC = new THREE.Color(o.seatColors[sector]);
    const aisle = i % 9 === 0;
    // Front wall (facing the field).
    quad(pos, wallC, P(fa, 0, 0), P(fb, 0, 0), P(fb, 0, o.wallH), P(fa, 0, o.wallH));
    let lastO = 0;
    let lastH = o.wallH;
    for (const t of o.tiers) {
      // Flat landing from the previous tier to this one.
      quad(pos, conc, P(fa, lastO, lastH), P(fb, lastO, lastH), P(fb, t.o, lastH), P(fa, t.o, lastH));
      if (t.h > lastH) quad(pos, dark, P(fa, t.o, lastH), P(fb, t.o, lastH), P(fb, t.o, t.h), P(fa, t.o, t.h));
      for (let r = 0; r < t.rows; r++) {
        const o0 = t.o + r * t.depth;
        const h0 = t.h + r * t.rise;
        const tread = aisle ? conc : r % 2 ? seatC : seatC.clone().multiplyScalar(0.86);
        quad(pos, tread, P(fa, o0, h0), P(fb, o0, h0), P(fb, o0 + t.depth, h0), P(fa, o0 + t.depth, h0));
        quad(pos, dark, P(fa, o0 + t.depth, h0), P(fb, o0 + t.depth, h0), P(fb, o0 + t.depth, h0 + t.rise), P(fa, o0 + t.depth, h0 + t.rise));
        // Seats for the crowd along this segment.
        const segLen = Math.hypot(fb.x - fa.x, fb.z - fa.z);
        const n = Math.max(1, Math.round(segLen / 0.68));
        if (aisle) continue;
        for (let s = 0; s < n; s++) {
          const k = (s + 0.5) / n;
          const pa = o.a0 + (o.a1 - o.a0) * ((i + k) / N);
          if (rnd() > o.crowd(pa)) continue;
          const f = { x: fa.x + (fb.x - fa.x) * k, z: fa.z + (fb.z - fa.z) * k, nx: fa.nx + (fb.nx - fa.nx) * k, nz: fa.nz + (fb.nz - fa.nz) * k };
          const pp = P(f, o0 + t.depth * 0.45, h0);
          const covered = !!o.roof && o.roof.mask(pa) && t === o.tiers[o.tiers.length - 1] && r > t.rows * 0.35;
          seats.push({ p: new THREE.Vector3(pp[0], pp[1], pp[2]), a: pa, shade: covered ? 0.62 : 1 });
        }
      }
      lastO = t.o + t.rows * t.depth;
      lastH = t.h + t.rows * t.rise;
    }
    // Back wall.
    quad(pos, conc, P(fa, lastO, lastH), P(fb, lastO, lastH), P(fb, lastO, lastH + o.backH), P(fa, lastO, lastH + o.backH));
    quad(pos, dark, P(fa, lastO + 0.4, 0), P(fb, lastO + 0.4, 0), P(fb, lastO + 0.4, lastH + o.backH), P(fa, lastO + 0.4, lastH + o.backH));
    if (o.roof && o.roof.mask(mid)) {
      const top = lastH + o.backH + o.roof.up;
      const inner = lastO - o.roof.over;
      quad(roofPos, null, P(fa, lastO + 0.5, top), P(fb, lastO + 0.5, top), P(fb, inner, top - 2.5), P(fa, inner, top - 2.5));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }));
  mesh.receiveShadow = false;
  let roof: THREE.Mesh | null = null;
  if (roofPos.length) {
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(roofPos, 3));
    rg.computeVertexNormals();
    roof = new THREE.Mesh(rg, new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.55, metalness: 0.2, side: THREE.DoubleSide }));
  }
  return { mesh, roof, seats };
}

// ---- crowd ---------------------------------------------------------------------------------------

const SHIRTS_CRICKET = [0x1f4fd8, 0x1f4fd8, 0x2b6cff, 0xffc21a, 0xff8a1f, 0xffffff, 0x1f4fd8, 0x17318f, 0xe8e8e8, 0xd7263d, 0x13a36a];
const SHIRTS_BASEBALL = [0x0f2a5c, 0xc8102e, 0xffffff, 0x0f2a5c, 0x9aa3ad, 0x1d1d1d, 0xc8102e, 0xf2f2f2, 0x2e5bb8];
const SKINS = [0x8d5a3b, 0x6e4329, 0xa8714d, 0xc08a63, 0x5a3622, 0xd2a07a, 0xe0b48f];

/** Thousands of spectators as camera-facing sprites in one draw call. They cheer when excited. */
export class Crowd {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  excite = 0;
  private hot = new THREE.Vector3();
  private hotK = 0;

  private total: number;

  constructor(seats: CrowdSeat[], sport: 'cricket' | 'baseball', light: number) {
    // Shuffle so lowering the density (slow devices) thins the crowd evenly instead of dropping whole rows.
    seats = seats.slice();
    let sh = 7;
    for (let i = seats.length - 1; i > 0; i--) {
      sh = (sh * 16807) % 2147483647;
      const j = sh % (i + 1);
      [seats[i], seats[j]] = [seats[j], seats[i]];
    }
    const n = seats.length;
    this.total = n;
    const base = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    const iPos = new Float32Array(n * 3);
    const iCol = new Float32Array(n * 4);
    const iSkin = new Float32Array(n * 3);
    const iRand = new Float32Array(n * 4);
    const shirts = sport === 'cricket' ? SHIRTS_CRICKET : SHIRTS_BASEBALL;
    const c = new THREE.Color();
    let s = 99;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const st = seats[i];
      iPos.set([st.p.x, st.p.y, st.p.z], i * 3);
      c.setHex(shirts[Math.floor(r() * shirts.length)]).multiplyScalar(0.75 + r() * 0.35);
      iCol.set([c.r, c.g, c.b, st.shade], i * 4);
      c.setHex(SKINS[Math.floor(r() * SKINS.length)]);
      iSkin.set([c.r, c.g, c.b], i * 3);
      iRand.set([r(), r(), 0.92 + r() * 0.2, r()], i * 4);
    }
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
    geo.setAttribute('iCol', new THREE.InstancedBufferAttribute(iCol, 4));
    geo.setAttribute('iSkin', new THREE.InstancedBufferAttribute(iSkin, 3));
    geo.setAttribute('iRand', new THREE.InstancedBufferAttribute(iRand, 4));
    geo.instanceCount = n;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsLib.fog,
        uAtlas: { value: crowdAtlas() },
        uTime: { value: 0 },
        uExcite: { value: 0 },
        uHot: { value: new THREE.Vector3() },
        uHotK: { value: 0 },
        uLight: { value: light },
      },
      vertexShader: `
        attribute vec3 iPos; attribute vec4 iCol; attribute vec3 iSkin; attribute vec4 iRand;
        uniform float uTime; uniform float uExcite; uniform vec3 uHot; uniform float uHotK;
        varying vec2 vUv; varying vec3 vCol; varying vec3 vSkin; varying float vShade;
        #include <fog_pars_vertex>
        void main(){
          vec3 base = iPos;
          float hot = uHotK * smoothstep(38.0, 0.0, distance(base.xz, uHot.xz));
          float ex = clamp(uExcite * (0.55 + 0.45 * iRand.w) + hot, 0.0, 1.0);
          float isOn = step(0.3, iRand.w + ex * 0.5);
          float jump = max(0.0, sin(uTime * (6.0 + iRand.x * 5.0) + iRand.x * 50.0)) * 0.32 * ex * isOn;
          base.y += jump + sin(uTime * 1.1 + iRand.x * 30.0) * 0.015;
          float up = step(0.75 - ex * 0.7, fract(iRand.x * 7.31)) * step(0.12, ex);
          float idx = floor(iRand.y * 3.999) + up * 4.0;
          vUv = vec2((uv.x + idx) / 8.0, uv.y);
          vec3 right = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
          float sz = iRand.z * (1.0 + up * 0.15);
          vec3 p = base + right * (position.x * 0.62 * sz) + vec3(0.0, position.y * 1.24 * sz, 0.0);
          vec4 mvPosition = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          vCol = iCol.rgb; vSkin = iSkin; vShade = iCol.a;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform sampler2D uAtlas; uniform float uLight;
        varying vec2 vUv; varying vec3 vCol; varying vec3 vSkin; varying float vShade;
        #include <fog_pars_fragment>
        void main(){
          vec4 m = texture2D(uAtlas, vUv);
          if (m.a < 0.45) discard;
          float sum = max(0.001, m.r + m.g + m.b);
          vec3 c = (vCol * m.r + vSkin * m.g + vec3(0.04, 0.035, 0.05) * m.b) / sum;
          c *= uLight * vShade * (0.82 + 0.18 * vUv.y);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      fog: true,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
  }

  /** Fraction of spectators drawn (performance scaling). */
  setDensity(k: number): void {
    (this.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = Math.round(this.total * THREE.MathUtils.clamp(k, 0.1, 1));
  }

  /** Make the crowd near a point (a six landing) go wild. */
  hotspot(p: THREE.Vector3, k: number): void {
    this.hot.copy(p);
    this.hotK = Math.max(this.hotK, k);
  }

  update(dt: number, time: number): void {
    this.excite = Math.max(0, this.excite - dt * 0.18);
    this.hotK = Math.max(0, this.hotK - dt * 0.2);
    const u = this.mat.uniforms;
    u.uTime.value = time;
    u.uExcite.value = this.excite;
    u.uHot.value.copy(this.hot);
    u.uHotK.value = this.hotK;
  }
}

// ---- floodlights -----------------------------------------------------------------------------------

/** Tall light towers aimed at a point; lamps glow (bloom) at night. */
export function floodlights(spots: { x: number; z: number; h: number }[], aim: THREE.Vector3, night: boolean): { group: THREE.Group; lampMat: THREE.MeshStandardMaterial } {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.5, metalness: 0.6 });
  const lampMat = new THREE.MeshStandardMaterial({ map: lampTexture(), emissive: 0xffffff, emissiveMap: lampTexture(), emissiveIntensity: night ? 2.6 : 0.25, roughness: 0.4 });
  const glowMat = new THREE.SpriteMaterial({ map: glowTexture(), color: 0xfff4dc, transparent: true, opacity: night ? 0.85 : 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  for (const s of spots) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 1.6, s.h, 8), steel);
    pole.position.set(s.x, s.h / 2, s.z);
    g.add(pole);
    const head = new THREE.Group();
    head.position.set(s.x, s.h + 3, s.z);
    head.lookAt(aim.x, 0, aim.z);
    head.rotateX(0.35);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(11, 6.5, 0.8), steel);
    const lamps = new THREE.Mesh(new THREE.PlaneGeometry(10.4, 6), lampMat);
    lamps.position.z = 0.41;
    head.add(frame, lamps);
    g.add(head);
    if (night) {
      head.updateMatrix();
      const glow = new THREE.Sprite(glowMat);
      glow.scale.set(34, 26, 1);
      glow.position.copy(new THREE.Vector3(0, 0, 2).applyMatrix4(head.matrix));
      g.add(glow);
    }
  }
  return { group: g, lampMat };
}
