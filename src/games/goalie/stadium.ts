/**
 * The stadium: striped pitch with markings, goals with a reactive net, LED boards, a bowl of stands with an
 * animated instanced crowd, roof floodlights, big screen and sky. Built once per game open.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GOAL } from './logic';
import { ScreenTexture, adsAtlas, crowdAtlas, glareTexture, netTexture, CROWD_CELLS } from './textures';

export const PITCH = { halfW: 34, len: 105 };
/** Inner edge of the stands (rounded rectangle around the pitch). */
const BOWL = { cz: -52.5, hx: 44, hz: 61.5, rc: 12 };

export interface StadiumOptions {
  night: boolean;
  /** 0..1, scales crowd density and geometry detail. */
  detail: number;
  grass: THREE.Texture | null;
}

const NOISE_GLSL = /* glsl */ `
float gHash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float gNoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  float a = gHash(i), b = gHash(i+vec2(1.0,0.0)), c = gHash(i+vec2(0.0,1.0)), d = gHash(i+vec2(1.0,1.0));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
float gFbm(vec2 p){ float v = 0.0; float a = 0.5; for(int i=0;i<4;i++){ v += a*gNoise(p); p *= 2.03; a *= 0.5; } return v; }
`;

// ---- pitch ----------------------------------------------------------------------------------

function pitchMaterial(opts: StadiumOptions, sunDir: THREE.Vector3): THREE.MeshLambertMaterial {
  // Lambert: grass has almost no specular, and it covers half the screen (cheaper on the tablet GPU).
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const uniforms = {
    uGrass: { value: opts.grass },
    uHasGrass: { value: opts.grass ? 1 : 0 },
    uNight: { value: opts.night ? 1 : 0 },
    uSun: { value: sunDir.clone() },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vGPos;
        uniform sampler2D uGrass; uniform float uHasGrass; uniform float uNight; uniform vec3 uSun;
        ${NOISE_GLSL}
        float seg(vec2 p, vec2 a, vec2 b){ vec2 pa = p-a, ba = b-a; float h = clamp(dot(pa,ba)/dot(ba,ba), 0.0, 1.0); return length(pa - ba*h); }
        float ring(vec2 p, vec2 c, float r){ return abs(length(p-c) - r); }
        float marks(vec2 p){
          vec2 q = vec2(abs(p.x), p.y > -52.5 ? p.y : -105.0 - p.y);
          float d = seg(q, vec2(34.0, 0.0), vec2(34.0, -52.5));
          d = min(d, seg(q, vec2(0.0, 0.0), vec2(34.0, 0.0)));
          d = min(d, seg(q, vec2(0.0, -52.5), vec2(34.0, -52.5)));
          d = min(d, ring(q, vec2(0.0, -52.5), 9.15));
          d = min(d, seg(q, vec2(20.16, 0.0), vec2(20.16, -16.5)));
          d = min(d, seg(q, vec2(0.0, -16.5), vec2(20.16, -16.5)));
          d = min(d, seg(q, vec2(9.16, 0.0), vec2(9.16, -5.5)));
          d = min(d, seg(q, vec2(0.0, -5.5), vec2(9.16, -5.5)));
          if (q.y < -16.5) d = min(d, ring(q, vec2(0.0, -11.0), 9.15));
          if (q.x > 32.5 && q.y > -1.5) d = min(d, ring(q, vec2(34.0, 0.0), 1.0));
          float spot = min(length(q - vec2(0.0, -11.0)) - 0.05, length(q - vec2(0.0, -52.5)) - 0.09);
          return min(d, max(spot, 0.0));
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `
        vec2 P = vGPos.xz;
        float inPitch = step(abs(P.x), 34.0) * step(P.y, 0.0) * step(-105.0, P.y);
        vec3 gtex = uHasGrass > 0.5 ? texture2D(uGrass, P * 0.42).rgb : vec3(0.3);
        vec3 gtex2 = uHasGrass > 0.5 ? texture2D(uGrass, P * 0.093 + 0.37).rgb : vec3(0.3);
        float lum = dot(gtex, vec3(0.299, 0.587, 0.114));
        float lum2 = dot(gtex2, vec3(0.299, 0.587, 0.114));
        float detail = 0.62 + 1.25 * (lum * 0.6 + lum2 * 0.4);
        // Mowing stripes across the pitch, with a softer cross-cut.
        float band = step(0.5, fract(P.y / 10.5 + 0.5));
        float cross = step(0.5, fract(P.x / 13.6 + 0.5));
        float stripe = mix(0.0, 1.0, band) * 0.85 + cross * 0.15;
        vec3 dark = vec3(0.075, 0.205, 0.045);
        vec3 light = vec3(0.115, 0.29, 0.07);
        vec3 grass = mix(dark, light, mix(0.45, stripe, inPitch));
        float macro = gFbm(P * 0.045);
        grass *= 0.86 + 0.28 * macro;
        grass *= detail;
        // Worn goalmouths and penalty spots.
        vec2 q = vec2(abs(P.x), P.y > -52.5 ? P.y : -105.0 - P.y);
        float wearN = gFbm(P * 0.9);
        float wear = smoothstep(4.2, 1.0, abs(q.x)) * smoothstep(-7.0, -1.5, q.y) * smoothstep(1.2, -0.2, q.y);
        wear = max(wear, smoothstep(1.6, 0.2, length(q - vec2(0.0, -11.0))) * 0.9);
        wear = max(wear, smoothstep(1.2, 0.0, abs(q.y + 0.4)) * smoothstep(4.5, 3.0, abs(q.x)) * 0.8);
        wear = clamp(wear * (0.55 + wearN * 0.9) - 0.22, 0.0, 1.0);
        vec3 dirt = vec3(0.19, 0.15, 0.09) * (0.8 + 0.4 * lum);
        grass = mix(grass, mix(grass * 0.85, dirt, 0.65), wear);
        // Run-off and track outside the pitch.
        float out1 = max(abs(P.x) - 34.0, max(P.y, -105.0 - P.y));
        grass *= mix(1.0, 0.82, smoothstep(0.0, 1.0, out1));
        float track = smoothstep(3.9, 4.1, max(abs(P.x) - 34.5, max(P.y - 2.5, -107.5 - P.y)));
        grass = mix(grass, vec3(0.05, 0.075, 0.06) * (0.8 + 0.3 * lum), track);
        // Lines.
        float md = marks(P);
        float aa = fwidth(md) * 1.2 + 0.004;
        float lineMask = 1.0 - smoothstep(0.06 - aa, 0.06 + aa, md);
        grass = mix(grass, vec3(0.86, 0.88, 0.86) * (0.9 + 0.12 * lum), lineMask * (1.0 - track));
        // Daytime: the stand shadows the far side of the pitch.
        float standShadow = 0.0;
        if (uNight < 0.5) {
          vec3 s = normalize(uSun);
          float edge = 50.0 + 0.0 * s.x;
          float hReach = 31.0 * length(s.xz) / max(0.15, s.y);
          float dx = s.x > 0.0 ? edge - P.x : P.x + edge;
          float dsx = abs(s.x) / max(0.01, length(s.xz));
          standShadow = smoothstep(0.0, 4.0, hReach * dsx - dx);
        }
        diffuseColor.rgb = grass * (1.0 - 0.45 * standShadow);
        `,
      )
      ;
  };
  return mat;
}

// ---- goals ----------------------------------------------------------------------------------

/** Goal frame (posts + crossbar) and back supports, at z = 0 facing -z (or flipped for the far goal). */
function goalFrame(): { posts: THREE.BufferGeometry; supports: THREE.BufferGeometry } {
  const r = GOAL.postR;
  const W = GOAL.halfW + r;
  const H = GOAL.h + r;
  const parts: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    const post = new THREE.CylinderGeometry(r, r, H + r, 20, 1);
    post.translate(s * W, (H + r) / 2 - 0.0, 0);
    parts.push(post);
    const cap = new THREE.SphereGeometry(r, 20, 10);
    cap.translate(s * W, H, 0);
    parts.push(cap);
  }
  const bar = new THREE.CylinderGeometry(r, r, 2 * W, 20, 1);
  bar.rotateZ(Math.PI / 2);
  bar.translate(0, H, 0);
  parts.push(bar);
  const posts = mergeGeometries(parts.map((g) => g.toNonIndexed()));
  const sr = 0.022;
  const tube = (a: THREE.Vector3, b: THREE.Vector3) => {
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(sr, sr, len, 8, 1);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const dir = b.clone().sub(a).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.applyQuaternion(q);
    g.translate(mid.x, mid.y, mid.z);
    return g.toNonIndexed();
  };
  const D = GOAL.depth;
  const T = GOAL.topDepth;
  const sup: THREE.BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    sup.push(tube(new THREE.Vector3(s * W, H, 0), new THREE.Vector3(s * W, H, T)));
    sup.push(tube(new THREE.Vector3(s * W, H, T), new THREE.Vector3(s * W, 0.02, D)));
    sup.push(tube(new THREE.Vector3(s * W, 0.02, 0.02), new THREE.Vector3(s * W, 0.02, D)));
  }
  sup.push(tube(new THREE.Vector3(-W, H, T), new THREE.Vector3(W, H, T)));
  sup.push(tube(new THREE.Vector3(-W, 0.02, D), new THREE.Vector3(W, 0.02, D)));
  return { posts, supports: mergeGeometries(sup) };
}

/** Net surface: top, back slope and two sides, finely subdivided so it can bulge. */
function netGeometry(): THREE.BufferGeometry {
  const W = GOAL.halfW + GOAL.postR;
  const H = GOAL.h + GOAL.postR;
  const D = GOAL.depth;
  const T = GOAL.topDepth;
  const cell = 0.16;
  const pos: number[] = [];
  const uv: number[] = [];
  const out: number[] = [];
  const idx: number[] = [];
  const grid = (nu: number, nv: number, f: (u: number, v: number) => [number, number, number], n: [number, number, number], uvf: (u: number, v: number) => [number, number]) => {
    const base = pos.length / 3;
    for (let j = 0; j <= nv; j++)
      for (let i = 0; i <= nu; i++) {
        const u = i / nu;
        const v = j / nv;
        const p = f(u, v);
        pos.push(...p);
        const t = uvf(u, v);
        uv.push(t[0] / cell, t[1] / cell);
        out.push(...n);
      }
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        idx.push(a, a + 1, a + nu + 1, a + 1, a + nu + 2, a + nu + 1);
      }
  };
  // Top: from the crossbar back to the top support.
  grid(56, 7, (u, v) => [-W + 2 * W * u, H, T * v], [0, 1, 0], (u, v) => [2 * W * u, T * v]);
  // Back: slopes from the top support down to the ground bar.
  const backLen = Math.hypot(D - T, H);
  const bn = new THREE.Vector3(0, (D - T) / backLen, H / backLen);
  grid(56, 18, (u, v) => [-W + 2 * W * u, H * (1 - v), T + (D - T) * v], [bn.x, bn.y, bn.z], (u, v) => [2 * W * u, T + backLen * v]);
  // Sides: trapezoids in the planes x = ±W.
  for (const s of [-1, 1]) {
    grid(14, 18, (u, v) => {
      const y = H * (1 - v);
      const zMax = T + (D - T) * v;
      return [s * W, y, zMax * u];
    }, [s, 0, 0], (u, v) => [(T + (D - T) * v) * u, H * (1 - v)]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aOut', new THREE.Float32BufferAttribute(out, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A goal with a net that bulges where the ball hits and ripples. */
export class Goal {
  readonly group = new THREE.Group();
  private uniforms = {
    uHit: { value: new THREE.Vector4(0, 1, 2, -100) },
    uHitStr: { value: 0 },
    uPush: { value: new THREE.Vector4(0, 0, 0, 0) },
    uTime: { value: 0 },
  };

  constructor(postGeo: THREE.BufferGeometry, supGeo: THREE.BufferGeometry, netGeo: THREE.BufferGeometry, netTex: THREE.Texture, msaa: boolean, night: boolean) {
    const postMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.28, metalness: 0.05, emissive: 0xffffff, emissiveIntensity: night ? 0.06 : 0.0 });
    const posts = new THREE.Mesh(postGeo, postMat);
    posts.castShadow = true;
    posts.receiveShadow = true;
    const sups = new THREE.Mesh(supGeo, new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.5, metalness: 0.4 }));
    sups.castShadow = true;
    const netMat = new THREE.MeshLambertMaterial({
      color: 0xf2f4f7,
      alphaMap: netTex,
      transparent: !msaa,
      alphaTest: msaa ? 0.35 : 0.0,
      alphaToCoverage: msaa,
      side: THREE.DoubleSide,
      depthWrite: msaa,
      emissive: 0xffffff,
      emissiveIntensity: night ? 0.05 : 0.02,
    });
    const u = this.uniforms;
    netMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute vec3 aOut; uniform vec4 uHit; uniform float uHitStr; uniform vec4 uPush; uniform float uTime;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          float tau = uTime - uHit.w;
          float dh = distance(position, uHit.xyz);
          float bulge = uHitStr * exp(-dh*dh/0.55) * exp(-tau*2.6) * cos(tau*11.0);
          float wave = uHitStr * 0.35 * sin(dh*7.0 - tau*16.0) * exp(-tau*3.5) * exp(-dh*0.6) * step(0.0, tau*16.0 - dh*7.0);
          float dp = distance(position, uPush.xyz);
          float push = uPush.w * exp(-dp*dp/0.35);
          float sway = 0.012 * sin(uTime*1.3 + position.x*1.7 + position.y*0.9);
          transformed += aOut * (max(0.0, bulge + push) + wave * 0.5 + sway * (1.0 - step(2.4, position.y)));`,
        )
        .replace('#include <alphamap_fragment>', 'diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).r;');
    };
    const net = new THREE.Mesh(netGeo, netMat);
    net.renderOrder = 2;
    this.group.add(posts, sups, net);
  }

  /** The ball hit the net at local point p (m), with strength (m of bulge). */
  hit(p: THREE.Vector3, strength: number, time: number): void {
    this.uniforms.uHit.value.set(p.x, p.y, p.z, time);
    this.uniforms.uHitStr.value = strength;
  }

  /** Ball currently pressing into the net (local point, depth in m). */
  push(p: THREE.Vector3 | null, depth: number): void {
    if (p) this.uniforms.uPush.value.set(p.x, p.y, p.z, depth);
    else this.uniforms.uPush.value.w = 0;
  }

  update(time: number): void {
    this.uniforms.uTime.value = time;
  }
}

// ---- bowl geometry ----------------------------------------------------------------------------

/** Points around a rounded rectangle offset by `o`, sampled with a fixed count per section. */
function loop(o: number, counts = { sx: 34, sz: 52, arc: 10 }): THREE.Vector2[] {
  const hx = BOWL.hx + o;
  const hz = BOWL.hz + o;
  const rc = BOWL.rc + o;
  const cz = BOWL.cz;
  const pts: THREE.Vector2[] = [];
  const corners = [
    { cx: hx - rc, cz: cz + hz - rc, a0: 0 },
    { cx: -(hx - rc), cz: cz + hz - rc, a0: Math.PI / 2 },
    { cx: -(hx - rc), cz: cz - (hz - rc), a0: Math.PI },
    { cx: hx - rc, cz: cz - (hz - rc), a0: (3 * Math.PI) / 2 },
  ];
  // Walk: corner arcs joined by straight edges (counter-clockwise seen from above: +x,+z first).
  for (let c = 0; c < 4; c++) {
    const k = corners[c];
    for (let i = 0; i < counts.arc; i++) {
      const a = k.a0 + (i / counts.arc) * (Math.PI / 2);
      pts.push(new THREE.Vector2(k.cx + Math.cos(a) * rc, k.cz + Math.sin(a) * rc));
    }
    const n = c % 2 === 0 ? counts.sx : counts.sz;
    const next = corners[(c + 1) % 4];
    const a1 = k.a0 + Math.PI / 2;
    const from = new THREE.Vector2(k.cx + Math.cos(a1) * rc, k.cz + Math.sin(a1) * rc);
    const to = new THREE.Vector2(next.cx + Math.cos(next.a0) * rc, next.cz + Math.sin(next.a0) * rc);
    for (let i = 0; i < n; i++) pts.push(from.clone().lerp(to, i / n));
  }
  return pts;
}

/** Coarse sampling for the stand geometry (straight edges need few segments). */
const TIER_LOOP = { sx: 8, sz: 12, arc: 8 };

interface Tier {
  o0: number;
  rows: number;
  tread: number;
  riser: number;
  h0: number;
}

const LOWER: Tier = { o0: 1.2, rows: 24, tread: 0.82, riser: 0.4, h0: 1.4 };
const UPPER: Tier = { o0: 24.6, rows: 19, tread: 0.84, riser: 0.58, h0: 15.2 };

function rowO(t: Tier, r: number): number {
  return t.o0 + r * t.tread;
}
function rowH(t: Tier, r: number): number {
  return t.h0 + r * t.riser;
}

/** Stepped concrete + seats geometry for a tier, with vertex colours. */
function tierGeometry(t: Tier, seat: THREE.Color, seatAlt: THREE.Color, concrete: THREE.Color): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const push = (a: THREE.Vector2, y: number, c: THREE.Color) => {
    pos.push(a.x, y, a.y);
    col.push(c.r, c.g, c.b);
    return pos.length / 3 - 1;
  };
  const strip = (A: THREE.Vector2[], ya: number, B: THREE.Vector2[], yb: number, colour: (i: number) => THREE.Color) => {
    const n = A.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const c = colour(i);
      const a0 = push(A[i], ya, c);
      const a1 = push(A[j], ya, c);
      const b0 = push(B[i], yb, c);
      const b1 = push(B[j], yb, c);
      // Winding so treads face up and risers face the pitch.
      idx.push(a0, a1, b0, a1, b1, b0);
    }
  };
  const tmp = new THREE.Color();
  for (let r = 0; r < t.rows; r++) {
    const o = rowO(t, r);
    const h = rowH(t, r);
    const front = loop(o, TIER_LOOP);
    const back = loop(o + t.tread, TIER_LOOP);
    // Tread (seats) then riser up to the next row.
    strip(front, h, back, h, (i) => tmp.copy((i + r * 2) % 9 === 0 ? seatAlt : seat).multiplyScalar(0.82 + ((i * 7 + r * 3) % 5) * 0.045).clone());
    strip(back, h, back, h + t.riser, () => concrete);
  }
  // Front wall below the first row.
  const f0 = loop(t.o0, TIER_LOOP);
  strip(f0, t.h0 - (t === LOWER ? t.h0 : 2.6), f0, t.h0, () => concrete.clone().multiplyScalar(0.7));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A vertical band around the bowl (facades, roof fascia). */
function band(o: number, y0: number, y1: number, inwardTilt = 0): THREE.BufferGeometry {
  const L = loop(o, TIER_LOOP);
  const L2 = loop(o - inwardTilt, TIER_LOOP);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let acc = 0;
  for (let i = 0; i <= L.length; i++) {
    const a = L[i % L.length];
    const b = L2[i % L2.length];
    if (i > 0) acc += a.distanceTo(L[(i - 1) % L.length]);
    pos.push(a.x, y0, a.y, b.x, y1, b.y);
    uv.push(acc, 0, acc, 1);
  }
  for (let i = 0; i < L.length; i++) {
    const a = i * 2;
    // Faces the pitch.
    idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Horizontal ring between two offsets (roof). */
function ring(o0: number, y0: number, o1: number, y1: number): THREE.BufferGeometry {
  const A = loop(o0, TIER_LOOP);
  const B = loop(o1, TIER_LOOP);
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < A.length; i++) pos.push(A[i].x, y0, A[i].y, B[i].x, y1, B[i].y);
  const n = A.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    idx.push(i * 2, i * 2 + 1, j * 2, j * 2, i * 2 + 1, j * 2 + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---- crowd ---------------------------------------------------------------------------------------

export class Crowd {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uTime: { value: 0 },
    uAtlas: { value: null as THREE.Texture | null },
    uExcHome: { value: 0 },
    uExcAway: { value: 0 },
    uWave: { value: -1000 },
    uFlash: { value: 0 },
    uLight: { value: 1 },
    uNight: { value: 1 },
    uSun: { value: new THREE.Vector3(0.5, 0.7, 0.4) },
    uHomeA: { value: new THREE.Color('#1f6bff') },
    uHomeB: { value: new THREE.Color('#ffffff') },
    uAwayA: { value: new THREE.Color('#d81b2c') },
    uAwayB: { value: new THREE.Color('#ffffff') },
  };
  count = 0;

  constructor(density: number, night: boolean) {
    this.uniforms.uAtlas.value = crowdAtlas();
    this.uniforms.uNight.value = night ? 1 : 0;
    const seats: number[] = [];
    const data: number[] = [];
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const place = (t: Tier, upper: boolean) => {
      for (let r = 0; r < t.rows; r++) {
        const o = rowO(t, r) + t.tread * 0.55;
        const h = rowH(t, r);
        const L = loop(o, { sx: 136, sz: 210, arc: 40 });
        // Walk the loop at seat spacing.
        let carry = 0;
        for (let i = 0; i < L.length; i++) {
          const a = L[i];
          const b = L[(i + 1) % L.length];
          const len = a.distanceTo(b);
          let s = carry;
          while (s < len) {
            const p = a.clone().lerp(b, s / len);
            s += 0.62;
            // Aisles every ~14 m, empty seats.
            const along = (i * 1000 + s) * 0.0;
            void along;
            const ang = Math.atan2(p.y - BOWL.cz, p.x);
            const aisle = Math.abs(Math.sin(ang * 26)) < 0.22;
            if (aisle || rnd() > density) continue;
            // Away fans: a block in one corner of the far end.
            const away = p.y < BOWL.cz - BOWL.hz - 2 && p.x > 8 && p.x < 40 ? 1 : 0;
            seats.push(p.x + (rnd() - 0.5) * 0.24, h + 0.02 + (rnd() - 0.5) * 0.06, p.y + (rnd() - 0.5) * 0.24);
            data.push(rnd(), Math.floor(rnd() * 8), away + (upper ? 2 : 0), rnd());
          }
          carry = s - len;
        }
      }
    };
    place(LOWER, false);
    place(UPPER, true);
    this.count = seats.length / 3;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aSeat', new THREE.InstancedBufferAttribute(new Float32Array(seats), 3));
    g.setAttribute('aData', new THREE.InstancedBufferAttribute(new Float32Array(data), 4));
    g.instanceCount = this.count;
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...this.uniforms },
      transparent: false,
      alphaTest: 0.5,
      fog: true,
      vertexShader: /* glsl */ `
        attribute vec3 aSeat; attribute vec4 aData;
        uniform float uTime, uExcHome, uExcAway, uWave, uFlash, uNight; uniform vec3 uSun;
        varying vec2 vUv; varying vec3 vShirt; varying vec3 vSkin; varying vec3 vHair; varying float vShade; varying float vFlash;
        uniform vec3 uHomeA, uHomeB, uAwayA, uAwayB;
        #include <fog_pars_vertex>
        float h1(float n){ return fract(sin(n)*43758.5453); }
        void main(){
          float ph = aData.x; float variant = aData.y; float team = mod(aData.z, 2.0); float upper = step(1.5, aData.z);
          float exc = mix(uExcHome, uExcAway, team);
          // Mexican wave around the bowl.
          float ang = atan(aSeat.z + 52.5, aSeat.x);
          float wv = exp(-pow(mod(ang - uWave + 3.14159, 6.28318) - 3.14159, 2.0) * 22.0);
          float jump = max(0.0, sin(uTime * (7.0 + ph * 3.0) + ph * 40.0)) * 0.22 * exc;
          float stand = max(wv, smoothstep(0.25, 0.6, exc * (0.6 + ph * 0.8)));
          float cheer = step(0.5, stand + step(0.93, ph) * step(0.2, exc));
          float bob = sin(uTime * 1.6 + ph * 30.0) * 0.015;
          float hgt = mix(0.92, 1.18, stand) * (0.86 + 0.28 * aData.w);
          vec3 toCam = cameraPosition - aSeat;
          vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
          float w = 0.72 * hgt;
          vec3 p = aSeat + right * position.x * w + vec3(0.0, position.y * hgt * 1.15 + jump + bob + wv * 0.25, 0.0);
          vUv = vec2((position.x + 0.5 + variant + cheer * 8.0) / ${CROWD_CELLS.toFixed(1)}, position.y);
          float r = h1(ph * 91.0);
          vec3 a = mix(uHomeA, uAwayA, team) * (0.7 + 0.45 * h1(ph * 23.0)); vec3 b = mix(uHomeB, uAwayB, team) * 0.85;
          float hn = h1(ph*13.0);
          vec3 neutral = mix(vec3(0.03, 0.035, 0.05), vec3(0.32, 0.32, 0.34), hn * hn);
          if (h1(ph * 31.0) < 0.2) neutral = vec3(0.05, 0.09, 0.2) * (0.6 + hn);
          vShirt = r < 0.62 ? a : r < 0.68 ? b : neutral;
          float sk = h1(ph * 57.0);
          vSkin = mix(vec3(0.95, 0.72, 0.58), vec3(0.36, 0.22, 0.14), sk * sk);
          vHair = mix(vec3(0.05, 0.035, 0.03), vec3(0.45, 0.3, 0.15), h1(ph * 77.0) * 0.7);
          if (variant == 2.0 || variant == 6.0) vHair = a;
          float front = 1.0 - clamp((length(vec2(aSeat.x / 50.0, (aSeat.z + 52.5) / 68.0)) - 0.9) * 1.6, 0.0, 1.0);
          vShade = uNight > 0.5 ? mix(0.3, 0.85, front) * mix(1.0, 0.62, upper) : mix(0.5, 0.95, front) * mix(1.0, 0.8, upper);
          if (uNight < 0.5) { float sunSide = step(0.0, -aSeat.x * sign(uSun.x)); vShade *= mix(0.62, 1.15, sunSide); }
          vShade *= 0.7 + 0.45 * h1(ph * 3.0);
          // Back rows sit under the roof.
          vShade *= mix(1.0, 0.55, smoothstep(14.0, 26.0, aSeat.y));
          float fl = step(0.9985 - uFlash * 0.004, h1(floor(uTime * 9.0) + ph * 1000.0));
          vFlash = fl * uFlash;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas; uniform float uLight;
        varying vec2 vUv; varying vec3 vShirt; varying vec3 vSkin; varying vec3 vHair; varying float vShade; varying float vFlash;
        #include <fog_pars_fragment>
        void main(){
          vec4 t = texture2D(uAtlas, vUv);
          if (t.a < 0.5) discard;
          float reg = t.g;
          vec3 c = reg < 0.18 ? vShirt : reg < 0.38 ? vec3(0.9) : reg < 0.75 ? vSkin : vHair;
          vec3 col = c * t.r * vShade * uLight;
          col += vec3(3.0) * vFlash;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
  }

  dispose(): void {
    this.uniforms.uAtlas.value?.dispose();
  }
}

// ---- LED boards -------------------------------------------------------------------------------------

export class AdBoards {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uTime: { value: 0 },
    uAtlas: { value: null as THREE.Texture | null },
    uCount: { value: 10 },
    uFlash: { value: 0 },
    uFlashPanel: { value: 8 },
    uBright: { value: 1.6 },
  };

  constructor(night: boolean) {
    const { tex, count } = adsAtlas();
    this.uniforms.uAtlas.value = tex;
    this.uniforms.uCount.value = count;
    this.uniforms.uBright.value = night ? 2.2 : 1.35;
    const H = 0.9;
    const modules: THREE.BufferGeometry[] = [];
    const addRun = (ax: number, az: number, bx: number, bz: number, faceSign: number) => {
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(len / 6));
      for (let i = 0; i < n; i++) {
        const t0 = i / n;
        const t1 = (i + 1) / n;
        const x0 = ax + (bx - ax) * t0;
        const z0 = az + (bz - az) * t0;
        const x1 = ax + (bx - ax) * t1;
        const z1 = az + (bz - az) * t1;
        const g = new THREE.BufferGeometry();
        const p = [x0, 0.05, z0, x1, 0.05, z1, x1, 0.05 + H, z1, x0, 0.05 + H, z0];
        g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
        const flip = faceSign < 0;
        g.setAttribute('uv', new THREE.Float32BufferAttribute(flip ? [1, 0, 0, 0, 0, 1, 1, 1] : [0, 0, 1, 0, 1, 1, 0, 1], 2));
        const id = modules.length;
        g.setAttribute('aModule', new THREE.Float32BufferAttribute([id, id, id, id], 1));
        g.setIndex(flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]);
        modules.push(g);
      }
    };
    // Sides (face the pitch), ends behind each goal.
    addRun(-38.5, 3, -38.5, -108, -1);
    addRun(38.5, -108, 38.5, 3, -1);
    addRun(-30, 6.8, 30, 6.8, -1);
    addRun(30, -111.8, -30, -111.8, -1);
    // Corners.
    addRun(-38.5, 3, -30, 6.8, -1);
    addRun(30, 6.8, 38.5, 3, -1);
    addRun(38.5, -108, 30, -111.8, -1);
    addRun(-30, -111.8, -38.5, -108, -1);
    const geo = mergeGeometries(modules);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...this.uniforms },
      side: THREE.DoubleSide,
      fog: true,
      vertexShader: /* glsl */ `
        attribute float aModule; varying vec2 vUv; varying float vMod;
        #include <fog_pars_vertex>
        void main(){ vUv = uv; vMod = aModule; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas; uniform float uTime, uCount, uFlash, uFlashPanel, uBright;
        varying vec2 vUv; varying float vMod;
        #include <fog_pars_fragment>
        void main(){
          float ads = uCount - 2.0;
          float slot = floor(uTime / 7.0);
          float k = fract(uTime / 7.0);
          float slide = smoothstep(0.92, 1.0, k);
          float a = mod(vMod + slot, ads);
          float b = mod(vMod + slot + 1.0, ads);
          float panel = vUv.y < slide ? b : a;
          float vy = fract(vUv.y - slide);
          if (uFlash > 0.5) panel = uFlashPanel;
          vec2 uv = vec2(vUv.x, (uCount - 1.0 - panel + vy) / uCount);
          vec3 c = texture2D(uAtlas, uv).rgb;
          if (uFlash > 0.5) c *= 0.75 + 0.5 * step(0.5, fract(uTime * 3.0));
          // LED pixel structure.
          vec2 px = fract(vec2(vUv.x * 180.0, vUv.y * 22.0));
          float dots = smoothstep(0.0, 0.25, px.x) * smoothstep(1.0, 0.75, px.x) * smoothstep(0.0, 0.25, px.y) * smoothstep(1.0, 0.75, px.y);
          c *= 0.7 + 0.3 * dots;
          gl_FragColor = vec4(c * uBright, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);

  }

  flash(kind: 'save' | 'goal' | null): void {
    this.uniforms.uFlash.value = kind ? 1 : 0;
    this.uniforms.uFlashPanel.value = kind === 'goal' ? this.uniforms.uCount.value - 1 : this.uniforms.uCount.value - 2;
  }
}

// ---- sky ------------------------------------------------------------------------------------------

function sky(night: boolean, sunDir: THREE.Vector3): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uNight: { value: night ? 1 : 0 }, uSun: { value: sunDir.clone().normalize() }, uTime: { value: 0 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir; uniform float uNight; uniform vec3 uSun; uniform float uTime;
      ${NOISE_GLSL}
      void main(){
        vec3 d = normalize(vDir);
        float h = clamp(d.y, -0.2, 1.0);
        vec3 col;
        if (uNight > 0.5) {
          col = mix(vec3(0.06, 0.075, 0.12), vec3(0.008, 0.012, 0.03), pow(max(h, 0.0), 0.45));
          col += vec3(0.12, 0.08, 0.05) * exp(-max(h, 0.0) * 9.0) * 0.6;
          vec2 sp = d.xz / max(0.15, d.y) * 60.0;
          float st = step(0.996, gHash(floor(sp))) * smoothstep(0.1, 0.4, h);
          col += vec3(0.8) * st * (0.6 + 0.4 * sin(uTime * 2.0 + gHash(floor(sp) + 3.0) * 30.0));
          // Floodlight haze above the roof.
          col += vec3(0.1, 0.11, 0.13) * exp(-max(h - 0.05, 0.0) * 5.0) * 0.5;
        } else {
          col = mix(vec3(0.62, 0.74, 0.88), vec3(0.16, 0.36, 0.72), pow(max(h, 0.0), 0.55));
          float sd = max(dot(d, normalize(uSun)), 0.0);
          col += vec3(1.0, 0.85, 0.6) * pow(sd, 6.0) * 0.35 + vec3(1.0, 0.95, 0.85) * pow(sd, 900.0) * 30.0;
          vec2 cp = d.xz / max(0.08, d.y) * 0.9 + vec2(uTime * 0.004, 0.0);
          float cl = smoothstep(0.52, 0.85, gFbm(cp) * 0.9 + gFbm(cp * 3.1) * 0.25);
          col = mix(col, vec3(0.97, 0.97, 1.0) * (0.85 + 0.15 * sd), cl * smoothstep(0.02, 0.2, h) * 0.85);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), mat);
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}

// ---- stadium ---------------------------------------------------------------------------------------

export class Stadium {
  readonly group = new THREE.Group();
  readonly crowd: Crowd;
  readonly boards: AdBoards;
  readonly near: Goal;
  readonly far: Goal;
  readonly screen = new ScreenTexture();
  readonly sunDir: THREE.Vector3;
  readonly lights: THREE.Light[] = [];
  readonly keyLight: THREE.DirectionalLight;
  private skyMesh: THREE.Mesh;
  private flags: THREE.Mesh[] = [];
  private flagMat: THREE.ShaderMaterial;
  private glare: THREE.Points;
  private textures: THREE.Texture[] = [];

  constructor(readonly opts: StadiumOptions, msaa: boolean) {
    const night = opts.night;
    this.sunDir = night ? new THREE.Vector3(0.35, 0.85, 0.4).normalize() : new THREE.Vector3(0.62, 0.72, 0.3).normalize();
    // Pitch and surrounds.
    const pitch = new THREE.Mesh(new THREE.PlaneGeometry(150, 220), pitchMaterial(opts, this.sunDir));
    pitch.rotation.x = -Math.PI / 2;
    pitch.position.set(0, 0, -52.5);
    pitch.receiveShadow = true;
    this.group.add(pitch);

    // Goals.
    const { posts, supports } = goalFrame();
    const net = netGeometry();
    const netTex = netTexture();
    this.textures.push(netTex);
    this.near = new Goal(posts, supports, net, netTex, msaa, night);
    this.far = new Goal(posts, supports, net, netTex, msaa, night);
    this.far.group.position.z = -PITCH.len;
    this.far.group.rotation.y = Math.PI;
    this.group.add(this.near.group, this.far.group);

    // Boards.
    this.boards = new AdBoards(night);
    this.group.add(this.boards.mesh);

    // Stands.
    const seat = new THREE.Color(night ? '#122a66' : '#1b3d8c');
    const seatAlt = new THREE.Color(night ? '#8a93a6' : '#c9d0dc');
    const concrete = new THREE.Color(night ? '#2c3139' : '#6b7079');
    const standMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const lower = new THREE.Mesh(tierGeometry(LOWER, seat, seatAlt, concrete), standMat);
    const upper = new THREE.Mesh(tierGeometry(UPPER, seat, seatAlt, concrete), standMat);
    lower.receiveShadow = true;
    this.group.add(lower, upper);
    // VIP band with glazing between the tiers, back walls, roof.
    const vip = new THREE.Mesh(band(rowO(LOWER, LOWER.rows), rowH(LOWER, LOWER.rows), UPPER.h0 - 0.2), this.windowMaterial(night));
    const backWall = new THREE.Mesh(band(rowO(UPPER, UPPER.rows), rowH(UPPER, UPPER.rows), 33), new THREE.MeshLambertMaterial({ color: 0x2b3038, side: THREE.DoubleSide }));
    const roofTop = 34.5;
    const roof = new THREE.Mesh(ring(9, 32.2, rowO(UPPER, UPPER.rows) + 2, roofTop), new THREE.MeshLambertMaterial({ color: night ? 0x1b1f27 : 0x6f7782, side: THREE.DoubleSide }));
    const fascia = new THREE.Mesh(band(9, 31.2, 32.4), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4e0, emissiveIntensity: night ? 3.2 : 0.5, roughness: 0.4 }));
    const fasciaDark = new THREE.Mesh(band(9.05, 30.2, 31.2), new THREE.MeshLambertMaterial({ color: 0x2a2f38, side: THREE.DoubleSide }));
    this.group.add(vip, backWall, roof, fascia, fasciaDark);
    // Roof trusses (columns at the back).
    const cols: THREE.BufferGeometry[] = [];
    const back = loop(rowO(UPPER, UPPER.rows) + 1, { sx: 6, sz: 9, arc: 2 });
    for (const p of back) {
      const c = new THREE.BoxGeometry(0.8, roofTop, 0.8);
      c.translate(p.x, roofTop / 2, p.y);
      cols.push(c);
    }
    this.group.add(new THREE.Mesh(mergeGeometries(cols), new THREE.MeshLambertMaterial({ color: 0x3a3f48 })));

    // Floodlight glare along the fascia.
    const glareTex = glareTexture();
    this.textures.push(glareTex);
    const gp: number[] = [];
    const gl = loop(8.7, { sx: 9, sz: 14, arc: 3 });
    for (const p of gl) gp.push(p.x, 31.4, p.y);
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    this.glare = new THREE.Points(
      gg,
      new THREE.PointsMaterial({ map: glareTex, size: night ? 11 : 5, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: night ? 0xb8b4aa : 0x555555, fog: false }),
    );
    this.glare.renderOrder = 5;
    this.group.add(this.glare);

    // Crowd.
    this.crowd = new Crowd(0.3 + 0.62 * opts.detail, night);
    this.crowd.uniforms.uSun.value.copy(this.sunDir);
    this.group.add(this.crowd.mesh);

    // Big screen above the far end.
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(17, 7.4), new THREE.MeshBasicMaterial({ map: this.screen.tex, toneMapped: false, fog: false }));
    scr.position.set(0, 25.2, BOWL.cz - BOWL.hz - 8.4);
    const scrFrame = new THREE.Mesh(new THREE.BoxGeometry(17.8, 8.2, 0.6), new THREE.MeshStandardMaterial({ color: 0x111317, roughness: 0.6, metalness: 0.5 }));
    scrFrame.position.copy(scr.position).add(new THREE.Vector3(0, 0, -0.35));
    this.group.add(scr, scrFrame);
    this.screen.tex.colorSpace = THREE.SRGBColorSpace;

    // Corner flags.
    this.flagMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      side: THREE.DoubleSide,
      vertexShader: `uniform float uTime; varying float vU; void main(){ vec3 p = position; float u = uv.x; vU = u; p.z += sin(uTime*6.0 + u*5.0) * 0.08 * u; p.y -= u*u*0.04; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
      fragmentShader: `varying float vU; void main(){ vec3 c = mix(vec3(1.0,0.85,0.05), vec3(0.95,0.25,0.1), step(0.5, fract(vU*2.0))); gl_FragColor = vec4(c*0.9, 1.0);
      #include <colorspace_fragment>
      }`,
    });
    const poleGeo = new THREE.CylinderGeometry(0.02, 0.02, 1.6, 6);
    poleGeo.translate(0, 0.8, 0);
    const flagGeo = new THREE.PlaneGeometry(0.45, 0.32, 6, 1);
    flagGeo.translate(0.225, 1.42, 0);
    for (const [x, z] of [
      [-34, 0],
      [34, 0],
      [-34, -105],
      [34, -105],
    ]) {
      const pole = new THREE.Mesh(poleGeo, new THREE.MeshStandardMaterial({ color: 0xffd400, roughness: 0.5 }));
      pole.position.set(x, 0, z);
      pole.castShadow = true;
      const flag = new THREE.Mesh(flagGeo, this.flagMat);
      flag.position.set(x, 0, z);
      flag.rotation.y = x < 0 ? 0 : Math.PI;
      this.flags.push(flag);
      this.group.add(pole, flag);
    }

    // Dugouts by the halfway line.
    for (const s of [-1, 1]) {
      const d = new THREE.Group();
      const shell = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.1, 9), new THREE.MeshStandardMaterial({ color: 0x1a2030, roughness: 0.6, metalness: 0.2 }));
      shell.position.set(0.9, 1.05, 0);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(1.9, 2.2, 9.2), new THREE.MeshStandardMaterial({ color: 0x9ec8ff, transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0.2, depthWrite: false }));
      glass.position.set(0.85, 1.1, 0);
      d.add(shell, glass);
      d.position.set(s * 39.8, 0, -45 + s * 6);
      d.rotation.y = s < 0 ? 0 : Math.PI;
      this.group.add(d);
    }

    this.skyMesh = sky(night, this.sunDir);
    this.group.add(this.skyMesh);

    // Lights.
    const hemi = new THREE.HemisphereLight(night ? 0x8fa6d8 : 0xcfe2ff, night ? 0x1d3315 : 0x3e5a2a, night ? 0.55 : 0.9);
    const key = new THREE.DirectionalLight(night ? 0xfff3e2 : 0xfff0d8, night ? 2.4 : 3.3);
    key.position.copy(this.sunDir).multiplyScalar(60).add(new THREE.Vector3(0, 0, -12));
    key.target.position.set(0, 0, -12);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -24;
    sc.right = 24;
    sc.top = 22;
    sc.bottom = -22;
    sc.near = 10;
    sc.far = 140;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    key.shadow.radius = night ? 4 : 2;
    this.keyLight = key;
    this.lights.push(hemi, key);
    this.group.add(hemi, key, key.target);
    // One fill light from the far end (floodlights on the other side / sky bounce); the environment map does the rest.
    const fill = new THREE.DirectionalLight(night ? 0xe8eeff : 0xcfe0ff, night ? 1.5 : 0.55);
    fill.position.set(-40, 50, night ? -90 : -40);
    this.lights.push(fill);
    this.group.add(fill);
  }

  private windowMaterial(night: boolean): THREE.MeshStandardMaterial {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 32;
    const g = c.getContext('2d')!;
    g.fillStyle = '#15191f';
    g.fillRect(0, 0, 256, 32);
    for (let i = 0; i < 16; i++) {
      const lit = (i * 7) % 5 !== 0;
      const grad = g.createLinearGradient(0, 6, 0, 26);
      grad.addColorStop(0, lit ? (night ? '#8a6a44' : '#5d7088') : '#222b38');
      grad.addColorStop(1, lit ? (night ? '#4a3a28' : '#3a4656') : '#161c26');
      g.fillStyle = grad;
      g.fillRect(i * 16 + 1, 6, 14, 20);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.set(1 / 16, 1);
    this.textures.push(t);
    return new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: night ? 1.2 : 0.15, roughness: 0.3, metalness: 0.4 });
  }

  update(dt: number, time: number): void {
    void dt;
    this.crowd.uniforms.uTime.value = time;
    this.boards.uniforms.uTime.value = time;
    this.near.update(time);
    this.far.update(time);
    this.flagMat.uniforms.uTime.value = time;
    (this.skyMesh.material as THREE.ShaderMaterial).uniforms.uTime.value = time;
  }

  dispose(): void {
    this.crowd.dispose();
    this.textures.forEach((t) => t.dispose());
    this.boards.uniforms.uAtlas.value?.dispose();
    this.screen.tex.dispose();
  }
}
