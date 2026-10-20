/**
 * Animated tennis players built on Quaternius' CC0 base characters and animation library.
 * Locomotion clips (idle, walk, jog, sprint) drive the body; tennis strokes are procedural: two-bone IK
 * for the arms and legs, torso twist and planted-foot stepping, all evaluated from a small plain state so
 * replays can re-pose a player from a snapshot.
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Handed } from './shots';

// ---- assets -----------------------------------------------------------------------------------------

export class CharacterKit {
  constructor(
    readonly male: GLTF,
    readonly female: GLTF,
    readonly clips: Map<string, THREE.AnimationClip>,
  ) {}

  static async load(base: string, onProgress?: (f: number) => void): Promise<CharacterKit> {
    const loader = new GLTFLoader();
    let a = 0;
    let b = 0;
    const tick = () => onProgress?.((a + b) / 2);
    const [male, female] = await Promise.all([
      loader.loadAsync(base + 'male.glb', (e) => ((a = e.total ? e.loaded / e.total : 0.5), tick())),
      loader.loadAsync(base + 'female.glb', (e) => ((b = e.total ? e.loaded / e.total : 0.5), tick())),
    ]);
    const clips = new Map<string, THREE.AnimationClip>();
    for (const c of male.animations) clips.set(c.name, c);
    return new CharacterKit(male, female, clips);
  }
}

export interface Outfit {
  shirt: string;
  trim: string;
  shorts: string;
  shoes: string;
  socks: string;
  skin: string;
  hair: string;
  hairColor: string;
  /** Female outfit: tank top + skirt. */
  skirt?: boolean;
  sleeveless?: boolean;
  /** Racket frame colour. */
  racket: string;
  wristband?: boolean;
}

// ---- tiny math helpers --------------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Premultiply a world-space rotation onto a bone (keeps its children attached). */
function rotateWorld(bone: THREE.Object3D, q: THREE.Quaternion): void {
  const parent = bone.parent!;
  parent.getWorldQuaternion(_q2);
  // local' = Pw^-1 * q * Pw * local
  _q3.copy(_q2).invert().multiply(q).multiply(_q2);
  bone.quaternion.premultiply(_q3);
  bone.updateMatrixWorld(true);
}

/** Set a bone's world orientation. */
function setWorldQuat(bone: THREE.Object3D, q: THREE.Quaternion): void {
  bone.parent!.getWorldQuaternion(_q2);
  bone.quaternion.copy(_q2.invert().multiply(q));
  bone.updateMatrixWorld(true);
}

const wpos = (o: THREE.Object3D, out: THREE.Vector3) => out.setFromMatrixPosition(o.matrixWorld);

/** Rotate `bone` so the direction to `child` points along `dir` (world). */
function aim(bone: THREE.Object3D, child: THREE.Object3D, dir: THREE.Vector3): void {
  wpos(bone, _v1);
  wpos(child, _v2).sub(_v1).normalize();
  _q1.setFromUnitVectors(_v2, _v3.copy(dir).normalize());
  rotateWorld(bone, _q1);
}

/** Analytic two-bone IK. `pole` is a world direction the middle joint should bend towards. */
function twoBoneIK(a: THREE.Object3D, b: THREE.Object3D, c: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3): void {
  const pa = wpos(a, new THREE.Vector3());
  const pb = wpos(b, new THREE.Vector3());
  const pc = wpos(c, new THREE.Vector3());
  const lab = pa.distanceTo(pb);
  const lbc = pb.distanceTo(pc);
  const toT = new THREE.Vector3().subVectors(target, pa);
  const d = clamp(toT.length(), Math.abs(lab - lbc) + 1e-3, lab + lbc - 1e-3);
  const dir = toT.normalize();
  const cosA = clamp((lab * lab + d * d - lbc * lbc) / (2 * lab * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const pn = _v4.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (pn.lengthSq() < 1e-8) pn.set(0, -1, 0);
  pn.normalize();
  const elbow = new THREE.Vector3().copy(pa).addScaledVector(dir, lab * cosA).addScaledVector(pn, lab * sinA);
  aim(a, b, elbow.sub(pa));
  const nb = wpos(b, new THREE.Vector3());
  const tgt = new THREE.Vector3().copy(pa).addScaledVector(dir, d);
  aim(b, c, tgt.sub(nb));
}

// ---- racket -------------------------------------------------------------------------------------------

/** Distance from the grip centre to the centre of the strings, along the shaft. */
export const HEAD_OFFSET = 0.43;
/** Hand bone origin (wrist) to grip centre. */
const PALM = 0.075;

function stringsTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(240,240,230,0.9)';
  g.lineWidth = 1.6;
  for (let i = 4; i < 128; i += 8) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 128);
    g.stroke();
    g.beginPath();
    g.moveTo(0, i);
    g.lineTo(128, i);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

let stringsTex: THREE.CanvasTexture | null = null;

/** A racket built along +Z (grip centre at the origin), strings facing ±X. */
export function makeRacket(color: string): THREE.Group {
  const g = new THREE.Group();
  const parts: THREE.BufferGeometry[] = [];
  const paint = (geo: THREE.BufferGeometry, col: THREE.Color) => {
    const n = geo.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.toArray(arr, i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    const ng = geo.index ? geo.toNonIndexed() : geo;
    parts.push(ng);
  };
  const frame = new THREE.Color(color);
  const dark = new THREE.Color('#1a1a1f');
  const grip = new THREE.Color('#f2f2ee');
  // Handle (octagonal) and butt cap.
  const handle = new THREE.CylinderGeometry(0.016, 0.017, 0.2, 8);
  handle.rotateX(Math.PI / 2);
  handle.translate(0, 0, 0.005);
  paint(handle, grip);
  const butt = new THREE.CylinderGeometry(0.019, 0.019, 0.012, 8);
  butt.rotateX(Math.PI / 2);
  butt.translate(0, 0, -0.095);
  paint(butt, dark);
  // Throat: two beams spreading into the head.
  for (const s of [-1, 1]) {
    const beam = new THREE.CylinderGeometry(0.008, 0.009, 0.19, 6);
    beam.rotateX(Math.PI / 2);
    beam.rotateX(-s * 0.26);
    beam.translate(0, s * 0.024, 0.19);
    paint(beam, frame);
  }
  // Head: an elliptical tube in the YZ plane (strings face ±X).
  const curve = new THREE.EllipseCurve(0, 0, 0.124, 0.158, 0, Math.PI * 2, false, 0);
  const pts = curve.getPoints(48).map((p) => new THREE.Vector3(0, p.x, p.y + HEAD_OFFSET));
  const path = new THREE.CatmullRomCurve3(pts, true);
  const head = new THREE.TubeGeometry(path, 64, 0.0105, 6, true);
  paint(head, frame);
  const merged = mergeGeometries(parts)!;
  merged.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.25 });
  const body = new THREE.Mesh(merged, mat);
  body.castShadow = true;
  g.add(body);
  stringsTex ??= stringsTexture();
  const sg = new THREE.CircleGeometry(1, 32);
  sg.scale(0.118, 0.152, 1);
  sg.rotateY(Math.PI / 2);
  sg.translate(0, 0, HEAD_OFFSET);
  const strings = new THREE.Mesh(
    sg,
    new THREE.MeshStandardMaterial({ map: stringsTex, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.6 }),
  );
  g.add(strings);
  // A faint sweep trail mesh is managed by the Athlete.
  return g;
}

// ---- clothing material ------------------------------------------------------------------------------

function clothMaterial(src: THREE.MeshStandardMaterial, o: Outfit, female: boolean, height: number, handed: Handed): THREE.MeshStandardMaterial {
  const m = src.clone();
  const k = height / 1.81;
  const uniforms = {
    uShirt: { value: new THREE.Color(o.shirt) },
    uTrim: { value: new THREE.Color(o.trim) },
    uShorts: { value: new THREE.Color(o.shorts) },
    uShoes: { value: new THREE.Color(o.shoes) },
    uSocks: { value: new THREE.Color(o.socks) },
    uSkin: { value: new THREE.Color(o.skin) },
    uK: { value: k },
    uFemale: { value: female ? 1 : 0 },
    uSkirt: { value: o.skirt ? 1 : 0 },
    uSleeve: { value: o.sleeveless ? 0.2 : 0.37 },
    // Racket arm is at -x in the bind pose for right-handers.
    uBandX: { value: o.wristband ? (handed === 'right' ? -1 : 1) : 0 },
  };
  const masks = /* glsl */ `
    uniform vec3 uShirt; uniform vec3 uTrim; uniform vec3 uShorts; uniform vec3 uShoes; uniform vec3 uSocks; uniform vec3 uSkin;
    uniform float uK; uniform float uFemale; uniform float uSkirt; uniform float uSleeve; uniform float uBandX;
    // Bind pose (T-pose) masks: 0 skin, else a garment.
    float mShirt(vec3 p) {
      float ax = abs(p.x);
      float neck = (1.43 + 0.07 * smoothstep(0.05, 0.17, ax)) * uK;
      return step(0.935 * uK, p.y) * step(p.y, neck) * step(ax, uSleeve);
    }
    float mShorts(vec3 p) { return step(mix(0.6, 0.66, uSkirt) * uK, p.y) * step(p.y, 1.0 * uK) * step(abs(p.x), 0.3); }
    float mShoes(vec3 p) { return step(p.y, 0.115 * uK) * step(abs(p.x), 0.3); }
    float mSocks(vec3 p) { return step(p.y, 0.2 * uK) * step(abs(p.x), 0.3); }
  `;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vBind;\nvarying vec3 vBindN;\n${masks}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vBind = position; vBindN = normal;
         {
           float sh = mShirt(position);
           float hemT = 1.0 - smoothstep(0.935 * uK, 1.12 * uK, position.y);
           float inflS = sh * (0.006 + 0.012 * hemT) * (1.0 - smoothstep(0.2, 0.37, abs(position.x)) * 0.4);
           float so = mShorts(position) * (1.0 - sh);
           float hemB = 1.0 - smoothstep(0.6 * uK, 0.95 * uK, position.y);
           float inflB = so * (0.012 + mix(0.018, 0.05, uSkirt) * hemB);
           float shoe = mShoes(position) * 0.008;
           transformed += normal * (inflS + inflB + shoe);
           // Skirt flare: push the hem outwards horizontally.
           transformed.xz += normalize(position.xz + vec2(1e-4)) * so * uSkirt * hemB * 0.035;
         }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vBind;\nvarying vec3 vBindN;\n${masks}\nfloat gCloth = 0.0;`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
         {
           vec3 p = vBind;
           float ax = abs(p.x);
           float sh = mShirt(p);
           float so = mShorts(p) * (1.0 - sh);
           float shoe = mShoes(p);
           float sock = mSocks(p) * (1.0 - shoe);
           float lum = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
           vec3 skin = diffuseColor.rgb * uSkin * 1.6;
           // Shirt with trim at the collar, sleeve hems and a shoulder yoke.
           float neck = (1.43 + 0.07 * smoothstep(0.05, 0.17, ax)) * uK;
           float collar = step(neck - 0.025 * uK, p.y) * (1.0 - step(0.19, ax));
           float cuff = step(uSleeve - 0.03, ax) * step(0.22, ax);
           float yoke = step(1.36 * uK, p.y) * step(0.1, ax) * (1.0 - step(0.22, ax)) * 0.0;
           vec3 shirt = mix(uShirt, uTrim, max(max(collar, cuff), yoke));
           // Side stripe on the shorts.
           float stripe = smoothstep(0.9, 0.96, abs(vBindN.x)) * step(0.12, ax);
           vec3 shorts = mix(uShorts, uTrim, stripe);
           // Shoes: sole and a coloured flash.
           float sole = step(p.y, 0.028 * uK);
           float flash = step(0.045 * uK, p.y) * step(p.y, 0.07 * uK) * smoothstep(0.6, 0.9, abs(vBindN.x));
           vec3 shoes = mix(mix(uShoes, uTrim, flash), vec3(0.12), sole);
           float band = step(0.001, abs(uBandX)) * step(0.62, p.x * -sign(uBandX + 1e-4) * -1.0) * step(p.x * -sign(uBandX + 1e-4) * -1.0, 0.69) * step(1.3 * uK, p.y);
           float shade = 0.82 + 0.36 * lum;
           vec3 col = skin;
           col = mix(col, shirt * shade, sh);
           col = mix(col, shorts * shade, so);
           col = mix(col, uSocks * shade, sock);
           col = mix(col, shoes * shade, shoe);
           col = mix(col, uTrim * shade, band);
           gCloth = max(max(sh, so), max(shoe, sock));
           diffuseColor.rgb = col;
         }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.82, gCloth);')
      .replace(
        '#include <normal_fragment_maps>',
        `#ifdef USE_NORMALMAP_TANGENTSPACE
           vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
           mapN.xy *= normalScale * (1.0 - 0.85 * gCloth);
           normal = normalize( tbn * mapN );
         #endif`,
      );
  };
  m.customProgramCacheKey = () => `tennis-cloth-${female}-${o.skirt}-${o.sleeveless}`;
  return m;
}

// ---- swings -------------------------------------------------------------------------------------------

export type SwingKind = 'fh' | 'bh' | 'serve' | 'smash';
export type SwingStyle = -1 | 0 | 1; // slice, flat, topspin

interface Key {
  t: number;
  /** Racket hand (character frame: u = right, y = up, w = forward). */
  h: [number, number, number];
  /** Shaft direction. */
  s: [number, number, number];
  /** Torso yaw (+ = chest turns to the right). */
  yaw: number;
  bend?: number;
  drop?: number;
  /** Off hand target, or null to let it follow the racket throat. */
  o?: [number, number, number] | null;
}

/** Keyframes for a right-hander; `h` contact keys are offset to the actual ball at runtime. */
function strokeKeys(kind: SwingKind, style: SwingStyle, hc: number): Key[] {
  const top = style === 1 ? 1 : 0;
  const sl = style === -1 ? 1 : 0;
  if (kind === 'fh') {
    return [
      { t: -0.75, h: [0.2, 1.0, 0.36], s: [-0.25, 0.45, 0.85], yaw: 0, o: null },
      { t: -0.45, h: [0.4, 1.18, 0.05], s: [0.15, 0.8, 0.55], yaw: 0.85, o: null },
      { t: -0.22, h: [0.55, 1.28 + 0.12 * sl, -0.3], s: [0.4, 0.6, -0.7], yaw: 1.2, o: [0.05, 1.25, 0.45] },
      { t: -0.08, h: [0.6, 0.88 + 0.3 * sl - 0.1 * top, -0.12], s: [0.75, -0.42 * (1 - sl) + 0.3 * sl, -0.5], yaw: 0.75, o: [-0.1, 1.2, 0.4] },
      { t: 0, h: [0.3, hc, 0.33], s: [1, 0.08 - 0.1 * sl, 0.12], yaw: -0.05, o: [-0.3, 1.15, 0.25] },
      { t: 0.1, h: [0.02, hc + 0.25 + 0.15 * top - 0.18 * sl, 0.55], s: [0.25, 0.45 + 0.3 * top - 0.55 * sl, 0.85], yaw: -0.55, o: [-0.4, 1.1, 0.05] },
      { t: 0.27, h: [-0.36, 1.42 + 0.1 * top - 0.4 * sl, 0.12 + 0.3 * sl], s: sl ? [-0.5, 0.15, 0.85] : [0.05, -0.35, -0.95], yaw: -1.0, o: [-0.3, 1.05, -0.05] },
      { t: 0.65, h: [0.2, 1.0, 0.36], s: [-0.25, 0.45, 0.85], yaw: 0, o: null },
    ];
  }
  if (kind === 'bh') {
    const one = sl; // one-handed slice backhand
    return [
      { t: -0.75, h: [0.2, 1.0, 0.36], s: [-0.25, 0.45, 0.85], yaw: 0, o: null },
      { t: -0.45, h: [-0.25, 1.12, 0.05], s: [-0.3, 0.7, 0.6], yaw: -0.95, o: null },
      { t: -0.22, h: [-0.45, 1.2 + 0.22 * sl, -0.25], s: [-0.4, 0.55, -0.7], yaw: -1.35, o: one ? [-0.2, 1.25, -0.1] : null },
      { t: -0.08, h: [-0.5, 0.85 + 0.38 * sl, -0.1], s: [-0.75, -0.38 * (1 - sl) + 0.25 * sl, -0.45], yaw: -0.8, o: one ? [-0.35, 1.15, -0.25] : null },
      { t: 0, h: [-0.27, hc, 0.3], s: [-1, 0.08 - 0.1 * sl, 0.12], yaw: -0.1, o: one ? [-0.5, 1.1, -0.35] : null },
      { t: 0.1, h: [0.05, hc + 0.3 - 0.2 * sl, 0.55], s: [-0.1, 0.55 - 0.6 * sl, 0.85], yaw: 0.45, o: one ? [-0.55, 1.15, -0.4] : null },
      { t: 0.27, h: [0.34, 1.48 - 0.42 * sl, 0.1 + 0.3 * sl], s: sl ? [0.45, 0.15, 0.85] : [-0.1, -0.3, -0.95], yaw: 0.95, o: one ? [-0.45, 1.1, -0.35] : null },
      { t: 0.65, h: [0.2, 1.0, 0.36], s: [-0.25, 0.45, 0.85], yaw: 0, o: null },
    ];
  }
  // Serve / smash.
  const keys: Key[] = [
    { t: -1.25, h: [0.24, 1.0, 0.3], s: [-0.05, 0.3, 1], yaw: 0.85, o: [0.04, 1.03, 0.45], drop: 0 },
    { t: -0.98, h: [0.3, 0.86, 0.12], s: [0.15, -0.45, 0.85], yaw: 0.95, o: [0.05, 0.92, 0.35], drop: -0.03 },
    { t: -0.75, h: [0.5, 1.15, -0.32], s: [0.35, 0.35, -0.85], yaw: 1.05, o: [0.02, 1.95, 0.42], drop: -0.08, bend: -0.1 },
    { t: -0.4, h: [0.42, 1.62, -0.16], s: [0.15, 0.9, -0.4], yaw: 1.05, o: [0.03, 2.02, 0.38], drop: -0.14, bend: -0.3 },
    { t: -0.12, h: [0.32, 1.72, -0.22], s: [0.1, -0.95, -0.25], yaw: 0.6, o: [0.05, 1.45, 0.3], drop: -0.03, bend: -0.2 },
    { t: 0, h: [0.14, 2.16, 0.3], s: [0.12, 0.95, 0.3], yaw: 0.08, o: [-0.1, 1.2, 0.25], drop: 0.08, bend: 0.1 },
    { t: 0.15, h: [-0.05, 1.45, 0.6], s: [-0.25, -0.55, 0.8], yaw: -0.5, o: [-0.25, 1.05, 0.1], drop: 0.02, bend: 0.38 },
    { t: 0.42, h: [-0.38, 0.84, 0.25], s: [-0.45, -0.85, -0.2], yaw: -0.8, o: [-0.3, 1.0, 0.05], drop: -0.04, bend: 0.25 },
    { t: 0.95, h: [0.2, 1.0, 0.36], s: [-0.25, 0.45, 0.85], yaw: 0, o: null, drop: 0, bend: 0 },
  ];
  if (kind === 'smash') return keys.slice(3).map((k, i) => (i === 0 ? { ...k, t: -0.5 } : k));
  return keys;
}

/** Contact point of a stroke in the character frame (racket head centre) for a nominal height. */
export function contactOffset(kind: SwingKind): { u: number; w: number } {
  if (kind === 'fh') return { u: 0.3 + HEAD_OFFSET, w: 0.33 + 0.05 };
  if (kind === 'bh') return { u: -0.27 - HEAD_OFFSET, w: 0.3 + 0.05 };
  return { u: 0.2, w: 0.45 };
}

/** The serve toss: ball position (character frame) at time τ after release at τ = -0.75. */
export const TOSS = { release: -0.75, from: [0.02, 2.0, 0.44] as const, vu: 0.24, vy: 4.5 };
export function tossAt(tau: number): [number, number, number] {
  const t = tau - TOSS.release;
  return [TOSS.from[0] + TOSS.vu * t, TOSS.from[1] + TOSS.vy * t - 4.905 * t * t, TOSS.from[2]];
}

function sampleKeys(keys: Key[], t: number): { h: THREE.Vector3; s: THREE.Vector3; yaw: number; bend: number; drop: number; o: THREE.Vector3 | null; ow: number } {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const k = clamp((t - a.t) / (b.t - a.t), 0, 1);
  // Smooth in/out between keys; Catmull-Rom for the hand path.
  const p0 = keys[Math.max(0, i - 1)].h;
  const p3 = keys[Math.min(keys.length - 1, i + 2)].h;
  const cr = (x0: number, x1: number, x2: number, x3: number, u: number) =>
    0.5 * (2 * x1 + (-x0 + x2) * u + (2 * x0 - 5 * x1 + 4 * x2 - x3) * u * u + (-x0 + 3 * x1 - 3 * x2 + x3) * u * u * u);
  const h = new THREE.Vector3(cr(p0[0], a.h[0], b.h[0], p3[0], k), cr(p0[1], a.h[1], b.h[1], p3[1], k), cr(p0[2], a.h[2], b.h[2], p3[2], k));
  const s = new THREE.Vector3(...a.s).normalize().lerp(new THREE.Vector3(...b.s).normalize(), k).normalize();
  const ke = k * k * (3 - 2 * k);
  const yaw = lerp(a.yaw, b.yaw, ke);
  const bend = lerp(a.bend ?? 0, b.bend ?? 0, ke);
  const drop = lerp(a.drop ?? 0, b.drop ?? 0, ke);
  let o: THREE.Vector3 | null = null;
  let ow = 0;
  if (a.o || b.o) {
    const ao = a.o ?? b.o!;
    const bo = b.o ?? a.o!;
    o = new THREE.Vector3(lerp(ao[0], bo[0], ke), lerp(ao[1], bo[1], ke), lerp(ao[2], bo[2], ke));
    ow = a.o && b.o ? 1 : a.o ? 1 - ke : ke;
  }
  return { h, s, yaw, bend, drop, o, ow };
}

// ---- athlete ------------------------------------------------------------------------------------------

export interface SwingState {
  kind: SwingKind;
  style: SwingStyle;
  /** Time relative to contact (s). */
  tau: number;
  /** Hold at this τ until released (human strokes wait for the swing). */
  holdAt: number | null;
  /** Ball contact point (world) and the height the keys are built for. */
  contact: THREE.Vector3 | null;
  rate: number;
}

export interface FootState {
  /** Planted world position (x, z). */
  x: number;
  z: number;
  /** Step in progress: from, to, progress 0..1. */
  fx: number;
  fz: number;
  tx: number;
  tz: number;
  p: number;
  dur: number;
}

/** Everything needed to re-pose an athlete (used for replays). */
export interface AthleteSnap {
  x: number;
  z: number;
  yaw: number;
  speed: number;
  dirYaw: number;
  phase: number;
  crouch: number;
  swing: { kind: SwingKind; style: SwingStyle; tau: number; cx: number; cy: number; cz: number } | null;
  feet: [number, number, number, number, number, number, number, number];
  lookX: number;
  lookY: number;
  lookZ: number;
  celebrate: number;
  idle: number;
}

export interface AthleteOptions {
  female: boolean;
  outfit: Outfit;
  handed: Handed;
  /** Overall scale (ball kids are smaller). */
  scale?: number;
  racket?: boolean;
  /** Static pose clip for non-players (umpire, ball kids). */
  staticClip?: string;
}

const HEIGHT_M = 1.81;
const HEIGHT_F = 1.77;

export class Athlete {
  readonly group = new THREE.Group();
  readonly model: THREE.Object3D;
  readonly racket: THREE.Group | null;
  readonly handed: Handed;
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private bones: Record<string, THREE.Bone> = {};
  private footRel: [THREE.Quaternion, THREE.Quaternion] = [new THREE.Quaternion(), new THREE.Quaternion()];
  private pelvisBind = new THREE.Quaternion();
  private pelvisBindPos = new THREE.Vector3();
  private staticClip: string | null;
  readonly height: number;

  // ---- state (plain values so snapshots can restore it) ----
  x = 0;
  z = 0;
  /** Facing (0 = +z). */
  yaw = 0;
  private vx = 0;
  private vz = 0;
  speed = 0;
  private dirYaw = 0;
  private phase = 0;
  crouch = 0;
  swing: SwingState | null = null;
  feet: [FootState, FootState];
  look = new THREE.Vector3(0, 1, 0);
  celebrate = 0;
  /** 1 = relaxed between points (standing idle), 0 = ready stance. */
  idle = 0;
  /** Facing target for the ready stance. */
  faceYaw = 0;

  // movement control
  private tx = 0;
  private tz = 0;
  private arriveBy = 0;
  maxSpeed = 6;
  accel = 16;
  private lastSteps = 0;
  private clock = 0;
  /** Called when a foot lands (for squeaks/footsteps): speed of the step. */
  onStep: (speed: number) => void = () => {};

  constructor(kit: CharacterKit, readonly opts: AthleteOptions) {
    this.handed = opts.handed;
    const src = opts.female ? kit.female : kit.male;
    this.height = (opts.female ? HEIGHT_F : HEIGHT_M) * (opts.scale ?? 1);
    this.model = SkeletonUtils.clone(src.scene);
    this.model.scale.setScalar(opts.scale ?? 1);
    this.group.add(this.model);
    this.staticClip = opts.staticClip ?? null;
    const o = opts.outfit;
    const hairNames = ['Hair_SimpleParted', 'Hair_Buzzed', 'Hair_Beard', 'Hair_Buns', 'Hair_Long'];
    this.model.traverse((n) => {
      const b = n as THREE.Bone;
      if (b.isBone) this.bones[b.name] = b;
      const m = n as THREE.SkinnedMesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = false;
      m.frustumCulled = false;
      if (hairNames.includes(m.name)) {
        const wanted = o.hair.split('+');
        m.visible = wanted.includes(m.name);
        const hm = (m.material as THREE.MeshStandardMaterial).clone();
        hm.color = new THREE.Color(o.hairColor);
        m.material = hm;
      } else if (m.name === 'Eyebrows') {
        const hm = (m.material as THREE.MeshStandardMaterial).clone();
        hm.color = new THREE.Color(o.hairColor);
        m.material = hm;
      } else if (/^Super/i.test(m.name)) {
        m.material = clothMaterial(m.material as THREE.MeshStandardMaterial, o, opts.female, opts.female ? HEIGHT_F : HEIGHT_M, opts.handed);
      }
    });
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const name of ['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Sitting_Idle_Loop', 'Crouch_Idle_Loop']) {
      const c = kit.clips.get(name);
      if (!c) continue;
      const a = this.mixer.clipAction(c);
      a.play();
      a.setEffectiveWeight(0);
      this.actions.set(name, a);
    }
    this.pelvisBind.copy(this.bones.pelvis.quaternion);
    this.pelvisBindPos.copy(this.bones.pelvis.position);
    // Foot orientation relative to the character when standing (from the idle clip).
    this.setWeights({ Idle_Loop: 1 });
    this.mixer.update(0);
    this.group.updateMatrixWorld(true);
    this.group.getWorldQuaternion(_q1).invert();
    for (const [i, n] of (['foot_l', 'foot_r'] as const).entries()) {
      this.bones[n].getWorldQuaternion(this.footRel[i]);
      this.footRel[i].premultiply(_q1);
      // Level the foot: remove pitch/roll from the idle pose by aligning to a flat reference.
    }
    this.feet = [this.newFoot(), this.newFoot()];
    if (opts.racket !== false && !this.staticClip) {
      this.racket = makeRacket(o.racket);
      this.group.add(this.racket);
    } else this.racket = null;
  }

  private newFoot(): FootState {
    return { x: 0, z: 0, fx: 0, fz: 0, tx: 0, tz: 0, p: 1, dur: 0.15 };
  }

  private setWeights(w: Record<string, number>): void {
    for (const [n, a] of this.actions) a.setEffectiveWeight(w[n] ?? 0);
  }

  /** Character frame basis for the current facing. */
  private basis(yaw = this.yaw): { f: THREE.Vector3; r: THREE.Vector3 } {
    const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const r = new THREE.Vector3().crossVectors(f, UP);
    return { f, r };
  }

  /** Character frame → world. Left-handers mirror u. */
  toWorld(u: number, y: number, w: number, out = new THREE.Vector3(), yaw = this.yaw): THREE.Vector3 {
    const s = this.handed === 'right' ? 1 : -1;
    const { f, r } = this.basis(yaw);
    return out.set(this.x, 0, this.z).addScaledVector(r, u * s).addScaledVector(f, w).setY(y * (this.height / HEIGHT_M));
  }

  /** World → character frame (u, y, w); u mirrored for left-handers. */
  toLocal(p: THREE.Vector3): THREE.Vector3 {
    const s = this.handed === 'right' ? 1 : -1;
    const { f, r } = this.basis();
    const dx = p.x - this.x;
    const dz = p.z - this.z;
    return new THREE.Vector3((dx * r.x + dz * r.z) * s, p.y, dx * f.x + dz * f.z);
  }

  /** Teleport (and plant the feet). */
  place(x: number, z: number, yaw: number): void {
    this.x = this.tx = x;
    this.z = this.tz = z;
    this.vx = this.vz = 0;
    this.speed = 0;
    this.yaw = this.faceYaw = this.dirYaw = yaw;
    const { r } = this.basis(yaw);
    for (const [i, side] of [-1, 1].entries()) {
      const ft = this.feet[i];
      ft.x = ft.tx = x + r.x * side * 0.26;
      ft.z = ft.tz = z + r.z * side * 0.26;
      ft.p = 1;
    }
  }

  /** Run to (x, z), arriving by `inSeconds` (or as fast as allowed). */
  moveTo(x: number, z: number, inSeconds = 0): void {
    this.tx = x;
    this.tz = z;
    this.arriveBy = inSeconds;
  }

  get target(): { x: number; z: number } {
    return { x: this.tx, z: this.tz };
  }

  /** Start a stroke. τ starts at `tau0` (e.g. -0.6 for preparation) and runs at `rate`. */
  startSwing(kind: SwingKind, style: SwingStyle, tau0: number, holdAt: number | null = null, rate = 1): void {
    this.swing = { kind, style, tau: tau0, holdAt, contact: null, rate };
  }

  /** Release a held stroke so that contact happens in `toContact` seconds. */
  release(toContact: number): void {
    const s = this.swing;
    if (!s) return;
    s.holdAt = null;
    s.rate = clamp(-s.tau / Math.max(0.03, toContact), 0.6, 4);
  }

  setContact(p: THREE.Vector3 | null): void {
    if (this.swing) this.swing.contact = p ? p.clone() : null;
  }

  /** Racket head centre in world space (after the last pose). */
  racketHead(out = new THREE.Vector3()): THREE.Vector3 {
    if (!this.racket) return out.set(this.x, 1, this.z);
    return out.set(0, 0, HEAD_OFFSET).applyMatrix4(this.racket.matrixWorld);
  }

  // ---- simulation -------------------------------------------------------------------------------------

  update(dt: number): void {
    if (this.staticClip) return;
    // Movement with acceleration limits.
    const dx = this.tx - this.x;
    const dz = this.tz - this.z;
    const dist = Math.hypot(dx, dz);
    let want = 0;
    if (dist > 0.02) {
      const needed = this.arriveBy > 0.05 ? dist / this.arriveBy : this.maxSpeed;
      // Slow down on arrival.
      want = Math.min(this.maxSpeed, Math.max(needed, Math.min(this.maxSpeed, dist * 2.5)), Math.sqrt(2 * this.accel * 0.9 * dist));
    }
    const wvx = dist > 1e-4 ? (dx / dist) * want : 0;
    const wvz = dist > 1e-4 ? (dz / dist) * want : 0;
    const ax = wvx - this.vx;
    const az = wvz - this.vz;
    const al = Math.hypot(ax, az);
    const maxDv = this.accel * dt;
    const k = al > maxDv ? maxDv / al : 1;
    this.vx += ax * k;
    this.vz += az * k;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.arriveBy = Math.max(0, this.arriveBy - dt);
    this.speed = Math.hypot(this.vx, this.vz);
    if (this.speed > 0.3) this.dirYaw = Math.atan2(this.vx, this.vz);

    // Facing: square to the net when slow, towards the run when fast (crossover).
    const run = smooth(2.4, 4.2, this.speed) * (this.swing ? 0.2 : 1) * (1 - this.idle * 0.0);
    let face = this.faceYaw;
    if (this.idle > 0.5 && this.speed > 0.4) face = this.dirYaw;
    const target = angleLerp(face, this.dirYaw, run);
    this.yaw = angleLerp(this.yaw, target, 1 - Math.exp(-dt * 10));

    // Stride phase for clips.
    const stride = this.speed > 3.6 ? 0.67 / (this.speed / 6.5) : 0.93 / Math.max(0.6, this.speed / 3.8);
    this.phase = (this.phase + dt / Math.max(0.25, stride)) % 1;

    // Swing timeline.
    const s = this.swing;
    if (s) {
      if (s.holdAt === null || s.tau < s.holdAt) {
        s.tau += dt * s.rate;
        if (s.holdAt !== null && s.tau > s.holdAt) s.tau = s.holdAt;
      }
      if (s.tau > 0.04 && s.rate !== 1) s.rate = 1;
      const end = s.kind === 'serve' || s.kind === 'smash' ? 0.95 : 0.65;
      if (s.tau >= end) this.swing = null;
    }
    this.celebrate = Math.max(0, this.celebrate - dt * 0.6);
    this.clock += dt;
    this.stepFeet(dt);
  }

  /** Planted-foot stepping for the ready stance and shuffles. */
  private stepFeet(dt: number): void {
    const s = this.handed === 'right' ? 1 : -1;
    const { f, r } = this.basis();
    const running = smooth(2.4, 3.4, this.speed) * (this.swing ? 0 : 1);
    // Home positions in the character frame.
    let home: [[number, number], [number, number]] = [
      [-0.27, 0.02],
      [0.27, 0.0],
    ];
    const sw = this.swing;
    if (sw) {
      const t = sw.tau;
      if (sw.kind === 'serve') {
        const land = t > 0.02;
        home = land
          ? [
              [-0.08, 0.62],
              [0.3, 0.05],
            ]
          : [
              [-0.12, 0.14],
              [0.3, -0.24],
            ];
      } else if (sw.kind === 'fh' && t > -0.55) {
        home = t < 0.15
          ? [
              [-0.2, 0.2],
              [0.42, -0.12],
            ]
          : [
              [-0.24, 0.12],
              [0.3, 0.15],
            ];
      } else if (sw.kind === 'bh' && t > -0.55) {
        home = t < 0.15
          ? [
              [-0.42, -0.1],
              [0.18, 0.28],
            ]
          : [
              [-0.3, 0.1],
              [0.25, 0.25],
            ];
      }
    }
    const lead = 0.12;
    for (let i = 0; i < 2; i++) {
      const ft = this.feet[i];
      const hu = home[i][0] * s;
      const hw = home[i][1];
      const dx = this.x + r.x * hu + f.x * hw + this.vx * lead;
      const dz = this.z + r.z * hu + f.z * hw + this.vz * lead;
      if (ft.p < 1) {
        ft.p = Math.min(1, ft.p + dt / ft.dur);
        if (ft.p >= 1) {
          ft.x = ft.tx;
          ft.z = ft.tz;
          this.onStep(this.speed);
        }
        continue;
      }
      if (running > 0.5) {
        // Clip drives the legs; keep the plant points near the body.
        ft.x = dx;
        ft.z = dz;
        continue;
      }
      const other = this.feet[1 - i];
      const err = Math.hypot(dx - ft.x, dz - ft.z);
      const thresh = sw ? 0.08 : 0.16;
      if (err > thresh && other.p >= 1 && this.clock - this.lastSteps > 0.04) {
        ft.fx = ft.x;
        ft.fz = ft.z;
        ft.tx = dx + this.vx * 0.06;
        ft.tz = dz + this.vz * 0.06;
        ft.p = 0;
        ft.dur = clamp(0.2 - this.speed * 0.025, 0.11, 0.2);
        this.lastSteps = this.clock;
      }
    }
  }

  // ---- pose evaluation ----------------------------------------------------------------------------------

  /** Evaluate the skeleton for the current state. `t` = animation clock (s) for idle clips. */
  pose(t: number): void {
    const B = this.bones;
    this.group.position.set(this.x, 0, this.z);
    this.group.rotation.set(0, this.yaw, 0);
    if (this.staticClip) {
      this.setWeights({ [this.staticClip]: 1 });
      const a = this.actions.get(this.staticClip)!;
      a.time = t % a.getClip().duration;
      this.mixer.update(0);
      this.group.updateMatrixWorld(true);
      this.lookAtTarget(0.8);
      return;
    }
    // Clip weights.
    const sp = this.speed;
    const runW = smooth(2.3, 3.6, sp) * (this.swing ? 0.15 : 1);
    const sprint = smooth(4.6, 6.2, sp) * runW;
    const jog = runW - sprint;
    const walkW = this.idle * smooth(0.25, 0.8, sp) * (1 - runW);
    const idleW = Math.max(0, 1 - runW - walkW);
    this.setWeights({ Idle_Loop: idleW, Walk_Loop: walkW, Jog_Fwd_Loop: jog, Sprint_Loop: sprint });
    for (const [n, a] of this.actions) {
      const d = a.getClip().duration;
      a.time = n === 'Idle_Loop' ? t % d : this.phase * d;
    }
    this.mixer.update(0);

    // Pelvis: square, at the stance height.
    const legsW = 1 - smooth(2.4, 3.4, sp) * (this.swing ? 0 : 1);
    const sw = this.swing;
    const keys = sw ? strokeKeys(sw.kind, sw.style, this.contactHeight()) : null;
    const k = keys && sw ? sampleKeys(keys, sw.tau) : null;
    const readyCrouch = (1 - this.idle) * 0.07 + this.crouch;
    const bob = legsW * (this.feet[0].p < 1 || this.feet[1].p < 1 ? 0.012 : 0) + 0.006 * Math.sin(t * 2.2) * (1 - runW);
    const drop = readyCrouch - (k ? k.drop : 0) + bob + (sw && sw.kind !== 'serve' && sw.kind !== 'smash' ? 0.04 * (1 - Math.abs(clamp(sw.tau, -0.5, 0.5)) * 2) : 0);
    const P = B.pelvis;
    P.quaternion.slerp(this.pelvisBind, legsW);
    const baseZ = P.position.z;
    P.position.z = lerp(baseZ, this.pelvisBindPos.z - drop, legsW);
    P.position.x *= 1 - legsW;
    P.position.y = lerp(P.position.y, this.pelvisBindPos.y, legsW);
    this.group.updateMatrixWorld(true);

    // Torso twist and bend.
    const s = this.handed === 'right' ? 1 : -1;
    const { f, r } = this.basis();
    // Key yaw is "chest turns to the racket side"; a positive rotation about +Y turns the chest left.
    let yaw = k ? -k.yaw * s : 0;
    let bend = (1 - this.idle) * 0.16 + (k ? k.bend : 0);
    // When running sideways, keep the chest turned towards the net.
    const off = angleDiff(this.faceYaw, this.yaw) * runW * 0.5;
    yaw += off;
    if (this.celebrate > 0) bend -= 0.15 * this.celebrate;
    const twist = [
      [B.pelvis, 0.3],
      [B.spine_01, 0.22],
      [B.spine_02, 0.22],
      [B.spine_03, 0.26],
    ] as const;
    for (const [bone, w] of twist) {
      _q1.setFromAxisAngle(UP, yaw * w);
      if (bone !== B.pelvis) _q1.multiply(_q3.setFromAxisAngle(r, bend * w * 1.2));
      rotateWorld(bone, _q1);
    }
    this.lookAtTarget(1);

    // Arms.
    const racketArm = s > 0 ? 'r' : 'l';
    const offArm = s > 0 ? 'l' : 'r';
    const ready = sampleKeys(strokeKeys('fh', 0, 1), -0.75);
    let hand = ready.h.clone();
    let shaft = ready.s.clone();
    if (k) {
      hand = k.h;
      shaft = k.s;
    } else if (runW > 0) {
      // Racket carried at the side while running.
      hand.lerp(new THREE.Vector3(0.3, 0.95 + 0.06 * Math.sin(this.phase * Math.PI * 2), 0.15), runW);
      shaft.lerp(new THREE.Vector3(0.1, 0.7, 0.7), runW).normalize();
    }
    if (this.idle > 0) {
      hand.lerp(new THREE.Vector3(0.28, 0.85, 0.1), this.idle);
      shaft.lerp(new THREE.Vector3(0.2, -0.75, 0.55), this.idle).normalize();
    }
    if (this.celebrate > 0) {
      const c = smooth(0, 0.3, this.celebrate);
      hand.lerp(new THREE.Vector3(0.25, 1.95 + 0.05 * Math.sin(t * 14), 0.2), c);
      shaft.lerp(new THREE.Vector3(0.1, 0.95, 0.2), c).normalize();
    }
    // Contact correction: shift the path so the strings meet the ball.
    if (sw && sw.contact && k) {
      const cl = this.toLocal(sw.contact);
      const keysAtC = sampleKeys(keys!, 0);
      const headAtC = keysAtC.h.clone().addScaledVector(keysAtC.s, HEAD_OFFSET);
      const corr = cl.sub(headAtC);
      const wgt = Math.max(0, 1 - Math.abs(sw.tau) / 0.3);
      hand.addScaledVector(corr, wgt * wgt * (3 - 2 * wgt));
    }
    const handW = this.toWorld(hand.x, hand.y, hand.z);
    const shaftW = this.dirToWorld(shaft);
    const pole = this.dirToWorld(new THREE.Vector3(0.6, -0.8, -0.35));
    twoBoneIK(B[`upperarm_${racketArm}`], B[`lowerarm_${racketArm}`], B[`hand_${racketArm}`], handW, pole);
    // Strings face the way the stroke is going (forward at contact), never edge-on.
    const faceW = f.clone();
    if (sw && (sw.kind === 'serve' || sw.kind === 'smash')) faceW.addScaledVector(UP, 0.2);
    this.orientHand(B[`hand_${racketArm}`], shaftW, faceW, s > 0);

    // Off hand: on the throat in the ready stance and two-handed backhands; free during forehands/serves.
    let ow = (1 - runW) * (1 - this.idle) * (1 - smooth(0, 0.4, this.celebrate));
    let offT: THREE.Vector3 | null = null;
    this.placeRacket(B[`hand_${racketArm}`], s > 0);
    if (k && k.o && k.ow > 0) {
      const throat = this.racketPoint(0.16);
      offT = this.toWorld(k.o.x, k.o.y, k.o.z).lerp(throat, 1 - k.ow);
    } else if (this.racket) {
      offT = this.racketPoint(sw && sw.kind === 'bh' ? 0.1 : 0.17);
    }
    if (sw && sw.kind === 'serve') ow = 1;
    if (offT && ow > 0.01) {
      const save = this.saveArm(offArm);
      const opole = this.dirToWorld(new THREE.Vector3(-0.6, -0.8, -0.3));
      twoBoneIK(B[`upperarm_${offArm}`], B[`lowerarm_${offArm}`], B[`hand_${offArm}`], offT, opole);
      if (ow < 0.999) this.blendArm(offArm, save, ow);
    }

    // Legs (planted feet).
    if (legsW > 0.01) {
      for (const [i, side] of (['l', 'r'] as const).entries()) {
        const ft = this.feet[i];
        let fx = ft.x;
        let fz = ft.z;
        let lift = 0;
        if (ft.p < 1) {
          const e = ft.p * ft.p * (3 - 2 * ft.p);
          fx = lerp(ft.fx, ft.tx, e);
          fz = lerp(ft.fz, ft.tz, e);
          lift = Math.sin(ft.p * Math.PI) * 0.085;
        }
        const save = this.saveLeg(side);
        const target = new THREE.Vector3(fx, 0.082 * this.scaleY() + lift, fz);
        const kneeDir = new THREE.Vector3().copy(f).multiplyScalar(1).addScaledVector(r, (side === 'l' ? -1 : 1) * 0.25);
        twoBoneIK(B[`thigh_${side}`], B[`calf_${side}`], B[`foot_${side}`], target, kneeDir);
        // Flat foot facing the body direction.
        this.group.getWorldQuaternion(_q1);
        setWorldQuat(B[`foot_${side}`], _q1.multiply(this.footRel[i]));
        if (legsW < 0.999) this.blendLeg(side, save, legsW);
      }
    }
    if (this.racket && !this.racket.parent) this.group.add(this.racket);
  }

  private scaleY(): number {
    return this.height / HEIGHT_M;
  }

  private dirToWorld(d: THREE.Vector3): THREE.Vector3 {
    const s = this.handed === 'right' ? 1 : -1;
    const { f, r } = this.basis();
    return new THREE.Vector3().addScaledVector(r, d.x * s).addScaledVector(UP, d.y).addScaledVector(f, d.z).normalize();
  }

  private contactHeight(): number {
    const sw = this.swing;
    if (!sw || !sw.contact) return 1.0;
    return clamp(sw.contact.y - 0.04, 0.35, 1.9);
  }

  /**
   * Orient the racket hand: thumb side (+Z) along the shaft, palm facing the strings' normal.
   * Right hands have the palm on -X, left hands on +X (mirrored rig).
   */
  private orientHand(hand: THREE.Bone, shaft: THREE.Vector3, face: THREE.Vector3, right: boolean): void {
    const z = shaft.clone().normalize();
    const n = face.clone().addScaledVector(z, -face.dot(z));
    if (n.lengthSq() < 1e-6) n.copy(UP).addScaledVector(z, -z.y);
    n.normalize();
    const x = right ? n.clone().negate() : n.clone();
    const y = new THREE.Vector3().crossVectors(z, x).normalize();
    _m1.makeBasis(x, y, z);
    _q1.setFromRotationMatrix(_m1);
    setWorldQuat(hand, _q1);
  }

  /** The racket sits in the palm, rigidly attached to the hand bone's frame. */
  private placeRacket(hand: THREE.Bone, right: boolean): void {
    if (!this.racket) return;
    hand.updateMatrixWorld(true);
    // Grip: centre of the palm, shaft along the thumb axis, strings facing the palm.
    const grip = new THREE.Matrix4().makeRotationZ(right ? Math.PI : 0).setPosition(0, PALM / (this.opts.scale ?? 1), 0);
    _m1.multiplyMatrices(hand.matrixWorld, grip);
    const inv = new THREE.Matrix4().copy(this.group.matrixWorld).invert();
    _m1.premultiply(inv);
    _m1.decompose(this.racket.position, this.racket.quaternion, this.racket.scale);
    this.racket.scale.setScalar(1);
    this.racket.updateMatrixWorld(true);
  }

  /** Point along the racket shaft (world), metres from the grip centre. */
  private racketPoint(d: number): THREE.Vector3 {
    return new THREE.Vector3(0, 0, d).applyMatrix4(this.racket!.matrixWorld);
  }

  private lookAtTarget(w: number): void {
    const B = this.bones;
    const head = B.Head;
    if (!head) return;
    const hp = wpos(head, new THREE.Vector3());
    const to = this.look.clone().sub(hp);
    if (to.lengthSq() < 1e-4) return;
    to.normalize();
    // Current face direction: the character's forward rotated by the chest.
    head.getWorldQuaternion(_q1);
    const { f } = this.basis();
    const chestF = f.clone();
    B.spine_03.getWorldQuaternion(_q2);
    // Limit the turn relative to the body forward.
    const yawTo = Math.atan2(to.x, to.z);
    const yawF = Math.atan2(chestF.x, chestF.z);
    const dy = clamp(angleDiff(yawTo, yawF), -1.1, 1.1) * w;
    const pitch = clamp(Math.asin(clamp(to.y, -1, 1)), -0.5, 0.4) * w * 0.6;
    _q1.setFromAxisAngle(UP, dy * 0.45);
    rotateWorld(B.neck_01, _q1);
    const right = new THREE.Vector3().crossVectors(to, UP).normalize();
    _q1.setFromAxisAngle(UP, dy * 0.4).multiply(_q3.setFromAxisAngle(right, -pitch));
    rotateWorld(head, _q1);
  }

  private saveArm(side: string): THREE.Quaternion[] {
    const B = this.bones;
    return [B[`upperarm_${side}`].quaternion.clone(), B[`lowerarm_${side}`].quaternion.clone(), B[`hand_${side}`].quaternion.clone()];
  }

  private blendArm(side: string, save: THREE.Quaternion[], w: number): void {
    const B = this.bones;
    const bones = [B[`upperarm_${side}`], B[`lowerarm_${side}`], B[`hand_${side}`]];
    bones.forEach((b, i) => b.quaternion.copy(save[i]).slerp(b.quaternion.clone(), w));
    bones[0].updateMatrixWorld(true);
  }

  private saveLeg(side: string): THREE.Quaternion[] {
    const B = this.bones;
    return [B[`thigh_${side}`].quaternion.clone(), B[`calf_${side}`].quaternion.clone(), B[`foot_${side}`].quaternion.clone()];
  }

  private blendLeg(side: string, save: THREE.Quaternion[], w: number): void {
    const B = this.bones;
    const bones = [B[`thigh_${side}`], B[`calf_${side}`], B[`foot_${side}`]];
    bones.forEach((b, i) => b.quaternion.copy(save[i]).slerp(b.quaternion.clone(), w));
    bones[0].updateMatrixWorld(true);
  }

  // ---- snapshots -----------------------------------------------------------------------------------------

  snapshot(): AthleteSnap {
    const sw = this.swing;
    const [a, b] = this.feet;
    const fa = a.p < 1 ? [lerp(a.fx, a.tx, a.p), lerp(a.fz, a.tz, a.p)] : [a.x, a.z];
    const fb = b.p < 1 ? [lerp(b.fx, b.tx, b.p), lerp(b.fz, b.tz, b.p)] : [b.x, b.z];
    return {
      x: this.x,
      z: this.z,
      yaw: this.yaw,
      speed: this.speed,
      dirYaw: this.dirYaw,
      phase: this.phase,
      crouch: this.crouch,
      swing: sw ? { kind: sw.kind, style: sw.style, tau: sw.tau, cx: sw.contact?.x ?? NaN, cy: sw.contact?.y ?? NaN, cz: sw.contact?.z ?? NaN } : null,
      feet: [fa[0], fa[1], a.p < 1 ? Math.sin(a.p * Math.PI) : 0, 0, fb[0], fb[1], b.p < 1 ? Math.sin(b.p * Math.PI) : 0, 0],
      lookX: this.look.x,
      lookY: this.look.y,
      lookZ: this.look.z,
      celebrate: this.celebrate,
      idle: this.idle,
    };
  }

  /** Re-pose from a snapshot (replays). The live state is saved and restored by the caller. */
  applySnapshot(s: AthleteSnap): void {
    this.x = s.x;
    this.z = s.z;
    this.yaw = s.yaw;
    this.speed = s.speed;
    this.dirYaw = s.dirYaw;
    this.phase = s.phase;
    this.crouch = s.crouch;
    this.swing = s.swing
      ? { kind: s.swing.kind, style: s.swing.style, tau: s.swing.tau, holdAt: null, rate: 1, contact: Number.isNaN(s.swing.cx) ? null : new THREE.Vector3(s.swing.cx, s.swing.cy, s.swing.cz) }
      : null;
    const set = (ft: FootState, x: number, z: number) => {
      ft.x = ft.tx = ft.fx = x;
      ft.z = ft.tz = ft.fz = z;
      ft.p = 1;
    };
    set(this.feet[0], s.feet[0], s.feet[1]);
    set(this.feet[1], s.feet[4], s.feet[5]);
    this.look.set(s.lookX, s.lookY, s.lookZ);
    this.celebrate = s.celebrate;
    this.idle = s.idle;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        const mat = m.material as THREE.Material | THREE.Material[];
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat.dispose();
      }
    });
  }
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function angleLerp(a: number, b: number, t: number): number {
  return a + angleDiff(b, a) * t;
}

export { angleDiff, angleLerp };
