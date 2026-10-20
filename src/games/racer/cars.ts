/**
 * Procedural race vehicles: an open-wheel single-seater and a race bike with rider.
 * Each vehicle uses ONE physical material whose texture atlas holds the livery (top half) and solid swatches
 * (bottom half: carbon, rubber, metal, visor…), plus an ORM map (R = clearcoat, G = roughness, B = metalness)
 * and an emissive map for the rain light. Geometry is shared between vehicles of the same type.
 * Models face +z with the ground at y = 0.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface Livery {
  name: string;
  /** Three-letter code for the timing tower. */
  code: string;
  number: number;
  primary: string;
  accent: string;
  accent2: string;
  helmet: string;
}

export const LIVERIES: Livery[] = [
  { name: 'You', code: 'YOU', number: 1, primary: '#f6c90e', accent: '#111111', accent2: '#e8401c', helmet: '#f4f4f4' },
  { name: 'M. Rossetti', code: 'ROS', number: 16, primary: '#c8102e', accent: '#f2f2f2', accent2: '#1a1a1a', helmet: '#ffd23f' },
  { name: 'K. Lindqvist', code: 'LIN', number: 44, primary: '#0aa5a5', accent: '#101820', accent2: '#c0c6cc', helmet: '#7fffd4' },
  { name: 'A. Moreau', code: 'MOR', number: 10, primary: '#1d3ec2', accent: '#ff7a00', accent2: '#ffffff', helmet: '#ffffff' },
  { name: 'T. Okafor', code: 'OKA', number: 4, primary: '#ff7a00', accent: '#14213d', accent2: '#ffffff', helmet: '#00b4d8' },
  { name: 'L. Santos', code: 'SAN', number: 27, primary: '#e9ecef', accent: '#2b2d42', accent2: '#ef233c', helmet: '#ef233c' },
  { name: 'J. Becker', code: 'BEC', number: 55, primary: '#006b3c', accent: '#d4af37', accent2: '#0b0b0b', helmet: '#d4af37' },
  { name: 'R. Tanaka', code: 'TAN', number: 22, primary: '#6a1b9a', accent: '#f8f8f8', accent2: '#ff4fa3', helmet: '#ff4fa3' },
];

// ---- atlas ----------------------------------------------------------------------------------------

const A = 512;
const TILE = 64;
type Swatch =
  | 'paint'
  | 'accent'
  | 'accent2'
  | 'carbon'
  | 'gloss'
  | 'rubber'
  | 'stripe'
  | 'rim'
  | 'chrome'
  | 'helmet'
  | 'visor'
  | 'light'
  | 'white'
  | 'intake'
  | 'suit'
  | 'suit2'
  | 'glove'
  | 'disc'
  | 'engine'
  | 'screen'
  | 'halo'
  | 'tread'
  | 'cover';
const SW: Swatch[] = [
  'paint', 'accent', 'accent2', 'helmet', 'suit', 'suit2', 'halo', 'white',
  'carbon', 'gloss', 'intake', 'engine', 'screen', 'visor', 'glove', 'cover',
  'rubber', 'tread', 'stripe', 'rim', 'chrome', 'disc', 'light',
];
const swIndex = new Map(SW.map((s, i) => [s, i]));
/** UV at the centre of a swatch tile. */
function swUV(s: Swatch): [number, number] {
  const i = swIndex.get(s)!;
  const col = i % 8;
  const row = Math.floor(i / 8);
  return [(col * TILE + TILE / 2) / A, 1 - (A / 2 + row * TILE + TILE / 2) / A];
}
/** Fin decal region: bottom row, last 3 tiles. */
const FIN = { x: 5 * TILE, y: A / 2 + 3 * TILE, w: 3 * TILE, h: TILE };

function setUV(g: THREE.BufferGeometry, s: Swatch): THREE.BufferGeometry {
  const [u, v] = swUV(s);
  const n = g.attributes.position.count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

function prep(g: THREE.BufferGeometry, s?: Swatch): THREE.BufferGeometry {
  let out = g.index ? g.toNonIndexed() : g;
  if (s) out = setUV(out, s);
  for (const k of Object.keys(out.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') out.deleteAttribute(k);
  if (!out.attributes.normal) out.computeVertexNormals();
  return out;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts.map((p) => prep(p)), false)!;
  g.computeBoundingSphere();
  return g;
}

interface Paint {
  map: THREE.CanvasTexture;
  orm: THREE.CanvasTexture;
  em: THREE.CanvasTexture;
}

function paintAtlas(l: Livery, kind: 'f1' | 'moto'): Paint {
  const c = document.createElement('canvas');
  c.width = c.height = A;
  const g = c.getContext('2d')!;
  const o = document.createElement('canvas');
  o.width = o.height = A;
  const og = o.getContext('2d')!;
  const e = document.createElement('canvas');
  e.width = e.height = A;
  const eg = e.getContext('2d')!;
  eg.fillStyle = '#000';
  eg.fillRect(0, 0, A, A);

  // Livery (top half): u = around the body (0 bottom, .25 right, .5 top, .75 left), v = along (top = nose).
  const H = A / 2;
  g.fillStyle = l.primary;
  g.fillRect(0, 0, A, H);
  // Dark underside.
  g.fillStyle = '#121214';
  g.fillRect(0, 0, A * 0.1, H);
  g.fillRect(A * 0.9, 0, A * 0.1, H);
  // Side swoosh on both sides: grows toward the back.
  g.fillStyle = l.accent;
  for (const base of [0.25, 0.75]) {
    g.beginPath();
    for (let y = 0; y <= H; y += 4) {
      const f = y / H; // 0 nose → 1 tail
      const w = 0.02 + 0.09 * Math.sin(Math.min(1, f * 1.3) * Math.PI * 0.9);
      const x = (base - w + (base < 0.5 ? -0.02 : 0.02) * f) * A;
      if (y === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    for (let y = H; y >= 0; y -= 4) {
      const f = y / H;
      const w = 0.02 + 0.06 * Math.sin(Math.min(1, f * 1.3) * Math.PI * 0.9);
      g.lineTo((base + w * 0.6) * A, y);
    }
    g.closePath();
    g.fill();
  }
  // Pinstripes and a top centre stripe.
  g.fillStyle = l.accent2;
  g.fillRect(A * 0.485, 0, A * 0.03, H);
  for (const base of [0.33, 0.67]) g.fillRect(A * base - 2, H * 0.15, 4, H * 0.8);
  // Small panel blocks (generic sponsor shapes, no text).
  g.fillStyle = l.accent2;
  for (const [u, v, w, h] of [
    [0.2, 0.55, 0.1, 0.05],
    [0.7, 0.55, 0.1, 0.05],
    [0.45, 0.35, 0.1, 0.06],
  ] as const)
    g.fillRect(u * A, v * H, w * A, h * H);
  // Subtle sheen gradient.
  const grad = g.createLinearGradient(0, 0, A, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0.25)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.08)');
  grad.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = grad;
  g.fillRect(0, 0, A, H);

  // ORM for the livery: clearcoat .8, roughness .38, metalness .05 (keeps colours saturated under a bright sky).
  og.fillStyle = 'rgb(205, 96, 12)';
  og.fillRect(0, 0, A, H);
  // Dark underside is satin.
  og.fillStyle = 'rgb(60, 150, 30)';
  og.fillRect(0, 0, A * 0.1, H);
  og.fillRect(A * 0.9, 0, A * 0.1, H);

  const sw = (s: Swatch, color: string, clear: number, rough: number, metal: number, emissive?: string) => {
    const i = swIndex.get(s)!;
    const x = (i % 8) * TILE;
    const y = H + Math.floor(i / 8) * TILE;
    g.fillStyle = color;
    g.fillRect(x, y, TILE, TILE);
    og.fillStyle = `rgb(${Math.round(clear * 255)},${Math.round(rough * 255)},${Math.round(metal * 255)})`;
    og.fillRect(x, y, TILE, TILE);
    if (emissive) {
      eg.fillStyle = emissive;
      eg.fillRect(x, y, TILE, TILE);
    }
  };
  sw('paint', l.primary, 0.8, 0.38, 0.05);
  sw('accent', l.accent, 0.8, 0.38, 0.05);
  sw('accent2', l.accent2, 0.8, 0.38, 0.05);
  sw('helmet', l.helmet, 1, 0.2, 0.15);
  // Leathers: livery colour, slightly darker so the rider separates from the bike.
  const suit = new THREE.Color(l.primary).multiplyScalar(0.78).getStyle();
  sw('suit', suit, 0.1, 0.55, 0.05);
  sw('suit2', l.accent, 0.1, 0.55, 0.05);
  sw('halo', kind === 'f1' ? '#1b1b1d' : l.accent, 1, 0.35, 0.4);
  sw('white', '#f4f4f4', 1, 0.35, 0.05);
  sw('carbon', '#18191b', 0.9, 0.38, 0.35);
  sw('gloss', '#0c0c0d', 1, 0.15, 0.1);
  sw('intake', '#050506', 0, 0.9, 0);
  sw('engine', '#2c2d30', 0.2, 0.5, 0.7);
  sw('screen', '#1a2128', 1, 0.05, 0.3);
  sw('visor', '#0d1016', 1, 0.05, 0.8);
  sw('glove', '#1c1c1c', 0, 0.75, 0);
  sw('cover', '#222428', 0.8, 0.3, 0.6);
  sw('rubber', '#141414', 0, 0.82, 0);
  sw('tread', '#1b1b1b', 0, 0.62, 0);
  sw('stripe', kind === 'f1' ? '#e3262f' : '#f2f2f2', 0, 0.6, 0);
  sw('rim', '#3a3c40', 0.5, 0.28, 0.9);
  sw('chrome', '#cfd3d8', 1, 0.12, 1);
  sw('disc', '#6d6e70', 0, 0.45, 0.95);
  sw('light', '#3a0000', 0.5, 0.3, 0, '#ff2020');

  // Fin / tail decal with the car number.
  g.fillStyle = l.primary;
  g.fillRect(FIN.x, FIN.y, FIN.w, FIN.h);
  g.fillStyle = l.accent;
  g.fillRect(FIN.x, FIN.y + FIN.h * 0.7, FIN.w, FIN.h * 0.3);
  g.fillStyle = '#ffffff';
  g.font = `900 ${Math.round(FIN.h * 0.62)}px Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(l.number), FIN.x + FIN.w / 2, FIN.y + FIN.h * 0.38);
  og.fillStyle = 'rgb(205, 96, 12)';
  og.fillRect(FIN.x, FIN.y, FIN.w, FIN.h);

  const mk = (cv: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(cv);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  return { map: mk(c, true), orm: mk(o, false), em: mk(e, true) };
}

export function vehicleMaterial(l: Livery, kind: 'f1' | 'moto'): THREE.MeshPhysicalMaterial {
  const p = paintAtlas(l, kind);
  return new THREE.MeshPhysicalMaterial({
    map: p.map,
    roughness: 1,
    metalness: 1,
    roughnessMap: p.orm,
    metalnessMap: p.orm,
    clearcoat: 1,
    clearcoatMap: p.orm,
    clearcoatRoughness: 0.1,
    emissive: new THREE.Color(1, 1, 1),
    emissiveMap: p.em,
    emissiveIntensity: 0.6,
    envMapIntensity: 0.85,
  });
}

// ---- geometry helpers ----------------------------------------------------------------------------------

interface Sec {
  z: number;
  /** Half width / half height. */
  w: number;
  h: number;
  /** Centre height and sideways position. */
  y: number;
  x?: number;
  /** Superellipse exponent: 2 = ellipse, larger = boxier. */
  p?: number;
  /** Scale of the lower half (flat bottoms). */
  bot?: number;
}

const spow = (v: number, e: number) => Math.sign(v) * Math.pow(Math.abs(v), e);

/**
 * Loft a closed tube through cross-sections. UVs map to the livery region: u around (0 bottom, .25 right,
 * .5 top), v along the vehicle between zMin (tail) and zMax (nose). Ends are capped with `cap`.
 */
function loft(secs: Sec[], seg: number, zMin: number, zMax: number, cap: Swatch | null = 'paint', mirrorU = false): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const ring = (s: Sec) => {
    const pts: [number, number, number, number][] = [];
    const e = 2 / (s.p ?? 2.4);
    for (let k = 0; k <= seg; k++) {
      const th = (k / seg) * Math.PI * 2;
      const sx = Math.sin(th);
      const cy = -Math.cos(th);
      let yy = spow(cy, e) * s.h;
      if (yy < 0) yy *= s.bot ?? 1;
      const xx = spow(sx, e) * s.w + (s.x ?? 0);
      let u = k / seg;
      if (mirrorU) u = 1 - u;
      pts.push([xx, s.y + yy, s.z, u]);
    }
    return pts;
  };
  const rings = secs.map(ring);
  const vOf = (z: number) => 0.5 + 0.5 * Math.min(1, Math.max(0, (z - zMin) / (zMax - zMin)));
  for (let r = 0; r < rings.length - 1; r++) {
    const a = rings[r];
    const b = rings[r + 1];
    for (let k = 0; k < seg; k++) {
      const p00 = a[k];
      const p01 = a[k + 1];
      const p10 = b[k];
      const p11 = b[k + 1];
      // Sections run nose → tail or tail → nose; keep faces outward by checking order.
      const quad = secs[r + 1].z < secs[r].z ? [p00, p11, p01, p00, p10, p11] : [p00, p01, p11, p00, p11, p10];
      for (const q of quad) {
        pos.push(q[0], q[1], q[2]);
        uv.push(q[3], vOf(q[2]));
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  const parts = [g];
  if (cap) {
    for (const end of [0, rings.length - 1]) {
      const rr = rings[end];
      const s = secs[end];
      const cp: number[] = [];
      const front = end === 0 ? secs[0].z > secs[1].z : secs[end].z > secs[end - 1].z;
      for (let k = 0; k < seg; k++) {
        const a = rr[k];
        const b = rr[k + 1];
        const c = [s.x ?? 0, s.y, s.z];
        if (front) cp.push(c[0], c[1], c[2], a[0], a[1], a[2], b[0], b[1], b[2]);
        else cp.push(c[0], c[1], c[2], b[0], b[1], b[2], a[0], a[1], a[2]);
      }
      const cg = new THREE.BufferGeometry();
      cg.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
      cg.computeVertexNormals();
      parts.push(setUV(cg, cap));
    }
  }
  return merge(parts);
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, s: Swatch, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateX(rx);
  g.rotateY(ry);
  g.rotateZ(rz);
  g.translate(x, y, z);
  return setUV(prep(g), s);
}

/** Thin cylinder between two points. */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, s: Swatch, seg = 6): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  const m = a.clone().add(b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  return setUV(prep(g), s);
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Airfoil-ish wing element spanning x ∈ [x0, x1] (extruded profile in the z–y plane). */
function wing(chord: number, thick: number, x0: number, x1: number, y: number, z: number, angle: number, s: Swatch): THREE.BufferGeometry {
  // Inverted cambered airfoil (NACA-style thickness), thickness `thick` as a fraction of the chord ≈ thick/chord.
  const sh = new THREE.Shape();
  const n = 12;
  const tr = Math.min(0.12, thick / chord);
  const yt = (t: number) => 5 * tr * chord * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1015 * t ** 4);
  const yc = (t: number) => -0.07 * chord * (t < 0.4 ? (2 * 0.4 * t - t * t) / 0.16 : (1 - 0.8 + 0.8 * t - t * t) / 0.36);
  const xs = (i: number) => (1 - Math.cos((i / n) * Math.PI)) / 2;
  for (let i = 0; i <= n; i++) {
    const t = xs(i);
    if (i === 0) sh.moveTo(-t * chord, yc(t) + yt(t));
    else sh.lineTo(-t * chord, yc(t) + yt(t));
  }
  for (let i = n - 1; i >= 1; i--) {
    const t = xs(i);
    sh.lineTo(-t * chord, yc(t) - yt(t));
  }
  const g = new THREE.ExtrudeGeometry(sh, { depth: x1 - x0, bevelEnabled: false, curveSegments: 1 });
  // Shape is in (x = along the chord, y); extruded along +z. Rotate so the extrusion runs along -x and the
  // chord along -z (leading edge forward), then angle the trailing edge up.
  g.rotateY(-Math.PI / 2);
  g.rotateX(angle);
  g.translate(x1, y, z + chord / 2);
  return setUV(prep(g), s);
}

/** Flat plate from a 2D outline in the z–y plane, thickness along x. */
function plate(outline: [number, number][], x: number, thick: number, s: Swatch): THREE.BufferGeometry {
  const sh = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false, curveSegments: 2 });
  g.rotateY(-Math.PI / 2);
  g.translate(x + thick / 2, 0, 0);
  return setUV(prep(g), s);
}

/** Wheel: lathe tyre with sidewall lettering dashes + cover disc. Axis along x, centred at the origin. */
function wheelGeo(radius: number, width: number, kind: 'f1' | 'moto'): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const hw = width / 2;
  const side = kind === 'f1' ? 0.1 : 0.07; // sidewall height
  const prof: THREE.Vector2[] = [];
  const rr = kind === 'moto' ? hw * 0.95 : 0.035;
  // Profile (r, y) from inner rim on one side, around the tread, to the other side.
  prof.push(new THREE.Vector2(radius - side, -hw * 0.92));
  if (kind === 'moto') {
    for (let i = 0; i <= 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * Math.PI;
      prof.push(new THREE.Vector2(radius - rr + Math.cos(a) * rr, Math.sin(a) * hw));
    }
  } else {
    for (let i = 0; i <= 4; i++) {
      const a = -Math.PI / 2 + (i / 4) * (Math.PI / 2);
      prof.push(new THREE.Vector2(radius - rr + Math.cos(a) * rr, -hw + rr + Math.sin(a) * rr));
    }
    for (let i = 0; i <= 4; i++) {
      const a = (i / 4) * (Math.PI / 2);
      prof.push(new THREE.Vector2(radius - rr + Math.cos(a) * rr, hw - rr + Math.sin(a) * rr));
    }
  }
  prof.push(new THREE.Vector2(radius - side, hw * 0.92));
  const tyre = new THREE.LatheGeometry(prof, 28);
  tyre.rotateZ(Math.PI / 2);
  parts.push(setUV(prep(tyre), 'rubber'));
  // Sidewall dashes (make the spin visible).
  for (const sgn of [-1, 1]) {
    const n = 8;
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2;
      const ring = new THREE.RingGeometry(radius - side * 0.75, radius - side * 0.35, 4, 1, a0, (Math.PI * 2) / n * 0.55);
      ring.rotateY((sgn * Math.PI) / 2);
      ring.translate(sgn * (hw * 0.93 + 0.002), 0, 0);
      parts.push(setUV(prep(ring), 'stripe'));
    }
    // Wheel cover / rim face.
    const disc = new THREE.CircleGeometry(radius - side + 0.005, 20);
    disc.rotateY((sgn * Math.PI) / 2);
    disc.translate(sgn * hw * 0.88, 0, 0);
    parts.push(setUV(prep(disc), kind === 'f1' ? 'cover' : 'rim'));
    // Cover pattern: two contrasting segments.
    if (kind === 'f1') {
      for (let k = 0; k < 2; k++) {
        const seg = new THREE.RingGeometry(0.06, radius - side - 0.02, 6, 1, k * Math.PI + 0.3, 0.9);
        seg.rotateY((sgn * Math.PI) / 2);
        seg.translate(sgn * (hw * 0.88 + 0.003), 0, 0);
        parts.push(setUV(prep(seg), 'accent'));
      }
    }
    const nut = new THREE.CircleGeometry(0.045, 10);
    nut.rotateY((sgn * Math.PI) / 2);
    nut.translate(sgn * (hw * 0.88 + 0.006), 0, 0);
    parts.push(setUV(prep(nut), 'chrome'));
  }
  if (kind === 'moto') {
    const disc = new THREE.CylinderGeometry(0.16, 0.16, 0.012, 24, 1, true);
    disc.rotateZ(Math.PI / 2);
    disc.translate(hw * 0.6, 0, 0);
    parts.push(setUV(prep(disc), 'disc'));
  }
  return merge(parts);
}

// ---- F1 car -------------------------------------------------------------------------------------------

const F1 = { wheelR: 0.36, frontZ: 1.8, rearZ: -1.75, frontX: 0.8, rearX: 0.78, frontW: 0.3, rearW: 0.4 };

interface F1Geo {
  body: THREE.BufferGeometry;
  flap: THREE.BufferGeometry;
  wheelF: THREE.BufferGeometry;
  wheelR: THREE.BufferGeometry;
  lod: THREE.BufferGeometry;
}

/** Merge parts placed by matrices into one geometry (for distant LODs). */
function bake(parts: [THREE.BufferGeometry, THREE.Matrix4][]): THREE.BufferGeometry {
  return merge(parts.map(([g, m]) => g.clone().applyMatrix4(m)));
}
let f1Geo: F1Geo | null = null;

export function buildF1(): F1Geo {
  const zMin = -2.75;
  const zMax = 2.85;
  const parts: THREE.BufferGeometry[] = [];
  // Nose + monocoque + gearbox.
  parts.push(
    loft(
      [
        { z: 2.68, w: 0.05, h: 0.045, y: 0.2, p: 2.2 },
        { z: 2.4, w: 0.1, h: 0.07, y: 0.235, p: 2.4 },
        { z: 1.95, w: 0.15, h: 0.11, y: 0.3, p: 2.6, bot: 0.8 },
        { z: 1.5, w: 0.2, h: 0.15, y: 0.37, p: 2.8, bot: 0.8 },
        { z: 1.05, w: 0.25, h: 0.19, y: 0.41, p: 3, bot: 0.8 },
        { z: 0.6, w: 0.3, h: 0.21, y: 0.43, p: 3, bot: 0.8 },
        { z: 0.25, w: 0.33, h: 0.2, y: 0.43, p: 3, bot: 0.8 },
        { z: -0.15, w: 0.35, h: 0.23, y: 0.44, p: 3, bot: 0.8 },
        { z: -0.5, w: 0.32, h: 0.25, y: 0.45, p: 3, bot: 0.8 },
        { z: -0.95, w: 0.25, h: 0.21, y: 0.43, p: 2.8 },
        { z: -1.45, w: 0.17, h: 0.15, y: 0.4, p: 2.6 },
        { z: -1.95, w: 0.1, h: 0.1, y: 0.38, p: 2.4 },
        { z: -2.22, w: 0.06, h: 0.07, y: 0.37, p: 2.2 },
      ],
      24,
      zMin,
      zMax,
      'carbon',
    ),
  );
  // Engine cover with the airbox above the driver's head.
  parts.push(
    loft(
      [
        { z: 0.08, w: 0.11, h: 0.1, y: 0.72, p: 2.4 },
        { z: -0.2, w: 0.15, h: 0.15, y: 0.71, p: 2.6 },
        { z: -0.65, w: 0.17, h: 0.17, y: 0.63, p: 2.6 },
        { z: -1.15, w: 0.14, h: 0.13, y: 0.56, p: 2.4 },
        { z: -1.75, w: 0.08, h: 0.09, y: 0.48, p: 2.2 },
        { z: -2.12, w: 0.04, h: 0.05, y: 0.43, p: 2 },
      ],
      18,
      zMin,
      zMax,
      'intake',
    ),
  );
  // Sidepods with intakes (coke-bottle shape).
  for (const sgn of [-1, 1]) {
    parts.push(
      loft(
        [
          { z: 0.62, w: 0.15, h: 0.13, y: 0.42, x: sgn * 0.52, p: 3.2 },
          { z: 0.45, w: 0.21, h: 0.17, y: 0.4, x: sgn * 0.53, p: 3.2, bot: 0.7 },
          { z: 0.0, w: 0.22, h: 0.18, y: 0.37, x: sgn * 0.5, p: 3, bot: 0.6 },
          { z: -0.55, w: 0.18, h: 0.15, y: 0.33, x: sgn * 0.44, p: 2.8, bot: 0.6 },
          { z: -1.1, w: 0.12, h: 0.1, y: 0.29, x: sgn * 0.36, p: 2.6 },
          { z: -1.55, w: 0.05, h: 0.05, y: 0.26, x: sgn * 0.27, p: 2.2 },
        ],
        16,
        zMin,
        zMax,
        'intake',
        sgn < 0,
      ),
    );
    // Mirror on a stalk.
    parts.push(rod(V(sgn * 0.3, 0.58, 0.55), V(sgn * 0.44, 0.66, 0.52), 0.012, 'carbon'));
    parts.push(box(0.1, 0.05, 0.03, sgn * 0.47, 0.67, 0.52, 'paint'));
    // Floor edge fence / bargeboard.
    parts.push(plate([[1.0, 0.07], [0.62, 0.07], [0.62, 0.3], [0.8, 0.25]], sgn * 0.74, 0.012, 'carbon'));
  }
  // Floor.
  const fl = new THREE.Shape();
  fl.moveTo(-0.35, 1.05);
  fl.lineTo(0.35, 1.05);
  fl.lineTo(0.72, 0.65);
  fl.lineTo(0.76, -1.25);
  fl.lineTo(0.5, -1.6);
  fl.lineTo(-0.5, -1.6);
  fl.lineTo(-0.76, -1.25);
  fl.lineTo(-0.72, 0.65);
  fl.closePath();
  const floor = new THREE.ExtrudeGeometry(fl, { depth: 0.03, bevelEnabled: false });
  floor.rotateX(Math.PI / 2);
  floor.translate(0, 0.095, 0);
  parts.push(setUV(prep(floor), 'carbon'));
  // Front wing: main plane + two flaps + endplates.
  parts.push(wing(0.32, 0.03, -0.98, 0.98, 0.075, 2.62, 0.05, 'carbon'));
  for (const sgn of [-1, 1]) {
    const x0 = sgn < 0 ? -0.96 : 0.16;
    const x1 = sgn < 0 ? -0.16 : 0.96;
    parts.push(wing(0.2, 0.022, x0, x1, 0.125, 2.47, 0.38, 'paint'));
    parts.push(wing(0.16, 0.018, x0, x1, 0.19, 2.35, 0.62, 'accent2'));
    parts.push(plate([[2.84, 0.04], [2.3, 0.04], [2.26, 0.2], [2.4, 0.26], [2.62, 0.2], [2.84, 0.12]], sgn * 0.975, 0.012, 'carbon'));
  }
  // Nose pillars to the wing.
  for (const sgn of [-1, 1]) parts.push(rod(V(sgn * 0.06, 0.2, 2.55), V(sgn * 0.08, 0.1, 2.58), 0.015, 'carbon'));
  // Rear wing: endplates, main plane, beam wing, pylon.
  for (const sgn of [-1, 1]) {
    parts.push(plate([[-2.16, 0.62], [-2.4, 0.46], [-2.72, 0.46], [-2.76, 0.97], [-2.5, 1.0], [-2.22, 0.95]], sgn * 0.53, 0.016, 'carbon'));
    parts.push(plate([[-2.24, 0.88], [-2.75, 0.88], [-2.76, 0.97], [-2.5, 1.0], [-2.22, 0.95]], sgn * 0.54, 0.005, 'paint'));
    // Diffuser strakes.
    parts.push(plate([[-1.6, 0.07], [-2.3, 0.07], [-2.3, 0.3], [-1.9, 0.16]], sgn * 0.25, 0.012, 'carbon'));
    parts.push(plate([[-1.6, 0.07], [-2.3, 0.07], [-2.3, 0.3], [-1.9, 0.16]], sgn * 0.45, 0.012, 'carbon'));
  }
  // Diffuser roof.
  {
    const dr = new THREE.PlaneGeometry(0.95, 0.75);
    dr.rotateX(-Math.PI / 2 - 0.3);
    dr.translate(0, 0.19, -1.95);
    parts.push(setUV(prep(dr), 'carbon'));
  }
  parts.push(wing(0.34, 0.03, -0.52, 0.52, 0.82, -2.32, 0.14, 'carbon'));
  parts.push(wing(0.2, 0.022, -0.45, 0.45, 0.47, -2.32, 0.2, 'carbon'));
  parts.push(box(0.03, 0.42, 0.18, 0, 0.62, -2.28, 'carbon'));
  // Rain light.
  parts.push(box(0.12, 0.05, 0.03, 0, 0.42, -2.36, 'light'));
  // Shark fin with the number decal.
  {
    const sh = new THREE.Shape([new THREE.Vector2(-0.35, 0), new THREE.Vector2(-1.95, 0), new THREE.Vector2(-1.6, 0.22), new THREE.Vector2(-0.55, 0.12)]);
    const fin = new THREE.ExtrudeGeometry(sh, { depth: 0.012, bevelEnabled: false });
    fin.rotateY(-Math.PI / 2);
    fin.translate(0.006, 0.0, 0);
    const pf = prep(fin);
    // Fin UVs map into the number decal region.
    const p = pf.attributes.position;
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      const z = p.getZ(i);
      const yy = p.getY(i);
      const fu = (-z - 0.35) / 1.6;
      const fv = yy / 0.22;
      uv[i * 2] = (FIN.x + (1 - fu) * FIN.w) / A;
      uv[i * 2 + 1] = 1 - (FIN.y + (1 - fv) * FIN.h) / A;
    }
    pf.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    // Lift onto the engine cover line (cover top ≈ 0.8 at z=-0.4 falling to 0.53 at z=-1.9).
    const pp = pf.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      const z = pp.getZ(i);
      const base = 0.8 - ((-z - 0.35) / 1.6) * 0.27;
      pp.setY(i, pp.getY(i) + base);
    }
    pf.computeVertexNormals();
    parts.push(pf);
  }
  // Halo.
  {
    const c = new THREE.CatmullRomCurve3([V(-0.3, 0.55, -0.1), V(-0.31, 0.71, 0.1), V(-0.2, 0.77, 0.38), V(0, 0.78, 0.5), V(0.2, 0.77, 0.38), V(0.31, 0.71, 0.1), V(0.3, 0.55, -0.1)]);
    parts.push(setUV(prep(new THREE.TubeGeometry(c, 24, 0.026, 6, false)), 'halo'));
    parts.push(rod(V(0, 0.78, 0.5), V(0, 0.6, 0.72), 0.03, 'halo'));
  }
  // Driver helmet + visor + headrest.
  {
    const h = new THREE.SphereGeometry(0.125, 16, 12);
    h.scale(1, 1, 1.12);
    h.translate(0, 0.66, 0.06);
    parts.push(setUV(prep(h), 'helmet'));
    const vz = new THREE.SphereGeometry(0.128, 14, 6, -Math.PI * 0.32, Math.PI * 0.64, Math.PI * 0.36, Math.PI * 0.16);
    vz.scale(1, 1, 1.12);
    vz.translate(0, 0.66, 0.06);
    parts.push(setUV(prep(vz), 'visor'));
    parts.push(box(0.5, 0.06, 0.2, 0, 0.64, -0.12, 'paint'));
    // Cockpit opening rim.
    const rim = new THREE.TorusGeometry(0.24, 0.025, 6, 20);
    rim.scale(1, 1.45, 1);
    rim.rotateX(Math.PI / 2);
    rim.translate(0, 0.635, 0.22);
    parts.push(setUV(prep(rim), 'gloss'));
    const hole = new THREE.CircleGeometry(0.24, 20);
    hole.scale(1, 1.45, 1);
    hole.rotateX(-Math.PI / 2);
    hole.translate(0, 0.632, 0.22);
    parts.push(setUV(prep(hole), 'intake'));
  }
  // Suspension wishbones and push rods.
  for (const sgn of [-1, 1]) {
    const fx = sgn * (F1.frontX - 0.12);
    parts.push(rod(V(sgn * 0.17, 0.42, 1.95), V(fx, 0.46, F1.frontZ), 0.016, 'carbon'));
    parts.push(rod(V(sgn * 0.17, 0.42, 1.55), V(fx, 0.46, F1.frontZ), 0.016, 'carbon'));
    parts.push(rod(V(sgn * 0.15, 0.27, 2.0), V(fx, 0.28, F1.frontZ), 0.016, 'carbon'));
    parts.push(rod(V(sgn * 0.15, 0.27, 1.5), V(fx, 0.28, F1.frontZ), 0.016, 'carbon'));
    parts.push(rod(V(sgn * 0.12, 0.5, 1.7), V(fx * 0.95, 0.3, F1.frontZ), 0.013, 'carbon'));
    const rx = sgn * (F1.rearX - 0.15);
    parts.push(rod(V(sgn * 0.12, 0.44, -1.55), V(rx, 0.48, F1.rearZ), 0.017, 'carbon'));
    parts.push(rod(V(sgn * 0.12, 0.44, -2.0), V(rx, 0.48, F1.rearZ), 0.017, 'carbon'));
    parts.push(rod(V(sgn * 0.1, 0.27, -1.55), V(rx, 0.26, F1.rearZ), 0.017, 'carbon'));
    parts.push(rod(V(sgn * 0.1, 0.27, -2.0), V(rx, 0.26, F1.rearZ), 0.017, 'carbon'));
    // Brake ducts / uprights.
    parts.push(box(0.08, 0.26, 0.2, sgn * (F1.frontX - 0.2), 0.36, F1.frontZ, 'carbon'));
    parts.push(box(0.08, 0.26, 0.22, sgn * (F1.rearX - 0.24), 0.36, F1.rearZ, 'carbon'));
  }
  const body = merge(parts);
  // DRS flap (separate so it can open).
  const flap = wing(0.2, 0.02, -0.51, 0.51, 0, 0, 0, 'paint');
  const wheelF = wheelGeo(F1.wheelR, F1.frontW, 'f1');
  const wheelR = wheelGeo(F1.wheelR, F1.rearW, 'f1');
  const I = new THREE.Matrix4();
  const lod = bake([
    [body, I],
    [flap, new THREE.Matrix4().makeTranslation(0, 0.93, -2.47).multiply(new THREE.Matrix4().makeRotationX(-0.55))],
    [wheelF, new THREE.Matrix4().makeTranslation(-F1.frontX, F1.wheelR, F1.frontZ)],
    [wheelF, new THREE.Matrix4().makeTranslation(F1.frontX, F1.wheelR, F1.frontZ)],
    [wheelR, new THREE.Matrix4().makeTranslation(-F1.rearX, F1.wheelR, F1.rearZ)],
    [wheelR, new THREE.Matrix4().makeTranslation(F1.rearX, F1.wheelR, F1.rearZ)],
  ]);
  return { body, flap, wheelF, wheelR, lod };
}

// ---- bike + rider -----------------------------------------------------------------------------------------

const MOTO = { wheelR: 0.315, frontZ: 0.72, rearZ: -0.7, frontW: 0.125, rearW: 0.19 };

interface MotoGeo {
  bike: THREE.BufferGeometry;
  fork: THREE.BufferGeometry;
  rider: THREE.BufferGeometry;
  wheelF: THREE.BufferGeometry;
  wheelR: THREE.BufferGeometry;
  lod: THREE.BufferGeometry;
}
let motoGeo: MotoGeo | null = null;

function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, s: Swatch): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, 10, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  const m = a.clone().add(b).multiplyScalar(0.5);
  g.translate(m.x, m.y, m.z);
  const ja = new THREE.SphereGeometry(r0, 10, 8);
  ja.translate(a.x, a.y, a.z);
  return merge([setUV(prep(g), s), setUV(prep(ja), s)]);
}

function buildMoto(): MotoGeo {
  const zMin = -1.05;
  const zMax = 1.05;
  const parts: THREE.BufferGeometry[] = [];
  // Front fairing + belly pan.
  parts.push(
    loft(
      [
        { z: 1.0, w: 0.05, h: 0.06, y: 0.8, p: 2.2 },
        { z: 0.88, w: 0.14, h: 0.16, y: 0.78, p: 2.6 },
        { z: 0.66, w: 0.2, h: 0.27, y: 0.75, p: 3, bot: 1.15 },
        { z: 0.36, w: 0.22, h: 0.27, y: 0.62, p: 3, bot: 1.2 },
        { z: 0.05, w: 0.19, h: 0.22, y: 0.5, p: 2.8, bot: 1.1 },
        { z: -0.22, w: 0.1, h: 0.12, y: 0.4, p: 2.4 },
      ],
      20,
      zMin,
      zMax,
      'intake',
    ),
  );
  // Screen.
  {
    const s = new THREE.SphereGeometry(0.2, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    s.scale(0.85, 0.62, 1.6);
    s.translate(0, 0.98, 0.6);
    parts.push(setUV(prep(s), 'screen'));
  }
  // Tank.
  parts.push(
    loft(
      [
        { z: 0.42, w: 0.12, h: 0.08, y: 0.9, p: 2.4 },
        { z: 0.25, w: 0.19, h: 0.12, y: 0.9, p: 2.6 },
        { z: -0.05, w: 0.19, h: 0.12, y: 0.87, p: 2.6 },
        { z: -0.25, w: 0.12, h: 0.08, y: 0.84, p: 2.4 },
      ],
      16,
      zMin,
      zMax,
    ),
  );
  // Seat unit / tail.
  parts.push(
    loft(
      [
        { z: -0.2, w: 0.14, h: 0.08, y: 0.84, p: 2.6 },
        { z: -0.5, w: 0.12, h: 0.09, y: 0.9, p: 2.8 },
        { z: -0.85, w: 0.08, h: 0.08, y: 0.98, p: 2.6 },
        { z: -1.02, w: 0.03, h: 0.04, y: 1.0, p: 2.2 },
      ],
      14,
      zMin,
      zMax,
    ),
  );
  parts.push(box(0.2, 0.03, 0.28, 0, 0.93, -0.42, 'gloss'));
  // Engine, frame, swingarm, exhaust.
  parts.push(box(0.26, 0.32, 0.45, 0, 0.42, 0.05, 'engine'));
  for (const sgn of [-1, 1]) {
    parts.push(rod(V(sgn * 0.13, 0.8, 0.5), V(sgn * 0.14, 0.55, -0.15), 0.035, 'rim'));
    parts.push(rod(V(sgn * 0.11, 0.42, -0.12), V(sgn * 0.11, 0.3, MOTO.rearZ), 0.03, 'rim'));
  }
  parts.push(rod(V(0.1, 0.32, -0.1), V(0.14, 0.55, -0.75), 0.045, 'chrome', 10));
  parts.push(box(0.12, 0.06, 0.04, 0, 0.92, -0.98, 'light'));
  // Clip-on bars.
  for (const sgn of [-1, 1]) parts.push(rod(V(sgn * 0.08, 0.9, 0.5), V(sgn * 0.26, 0.86, 0.46), 0.014, 'gloss'));
  // Tail number decal plate.
  {
    const pl = new THREE.PlaneGeometry(0.22, 0.11);
    const p0 = prep(pl);
    const uv = new Float32Array(p0.attributes.position.count * 2);
    const pa = p0.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const fu = pa.getX(i) / 0.22 + 0.5;
      const fv = pa.getY(i) / 0.11 + 0.5;
      uv[i * 2] = (FIN.x + fu * FIN.w) / A;
      uv[i * 2 + 1] = 1 - (FIN.y + (1 - fv) * FIN.h) / A;
    }
    p0.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    for (const sgn of [-1, 1]) {
      const g = p0.clone();
      g.rotateY((sgn * Math.PI) / 2);
      if (sgn < 0) g.scale(1, 1, 1);
      g.translate(sgn * 0.105, 0.93, -0.68);
      parts.push(g);
    }
  }
  const bike = merge(parts);

  // Fork (steers): tubes + mudguard, pivot at the steering head.
  const fp: THREE.BufferGeometry[] = [];
  for (const sgn of [-1, 1]) fp.push(rod(V(sgn * 0.075, 0.86, 0.5), V(sgn * 0.075, 0.3, MOTO.frontZ), 0.026, 'chrome', 10));
  fp.push(box(0.1, 0.04, 0.34, 0, 0.62, 0.66, 'paint', -0.4));
  const fork = merge(fp);

  // Rider in a racing crouch.
  const rp: THREE.BufferGeometry[] = [];
  rp.push(
    loft(
      [
        { z: -0.42, w: 0.15, h: 0.12, y: 0.97, p: 2.2 },
        { z: -0.27, w: 0.18, h: 0.13, y: 1.0, p: 2.4 },
        { z: -0.05, w: 0.2, h: 0.13, y: 1.02, p: 2.4 },
        { z: 0.1, w: 0.19, h: 0.11, y: 1.02, p: 2.4 },
        { z: 0.19, w: 0.09, h: 0.07, y: 1.02, p: 2 },
      ],
      16,
      zMin,
      zMax,
      'suit',
    ),
  );
  // Remap torso UVs to suit colours (livery region would paint it like the bike).
  {
    const t = rp[0];
    const [u, v] = swUV('suit');
    const uv = t.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u, v);
  }
  // Aero hump.
  {
    const hmp = new THREE.SphereGeometry(0.11, 10, 8);
    hmp.scale(0.9, 0.7, 1.4);
    hmp.translate(0, 1.11, -0.12);
    rp.push(setUV(prep(hmp), 'suit2'));
  }
  // Helmet + visor.
  {
    const h = new THREE.SphereGeometry(0.14, 16, 12);
    h.scale(0.95, 0.95, 1.12);
    h.translate(0, 1.08, 0.3);
    rp.push(setUV(prep(h), 'helmet'));
    const vz = new THREE.SphereGeometry(0.143, 14, 6, -Math.PI * 0.3, Math.PI * 0.6, Math.PI * 0.42, Math.PI * 0.16);
    vz.scale(0.95, 0.95, 1.12);
    vz.translate(0, 1.08, 0.3);
    rp.push(setUV(prep(vz), 'visor'));
  }
  for (const sgn of [-1, 1]) {
    const sh = V(sgn * 0.19, 1.0, 0.08);
    const el = V(sgn * 0.27, 0.9, 0.24);
    const ha = V(sgn * 0.25, 0.88, 0.45);
    rp.push(limb(sh, el, 0.058, 0.05, 'suit'));
    rp.push(limb(el, ha, 0.05, 0.042, 'suit2'));
    const gl = new THREE.SphereGeometry(0.045, 8, 6);
    gl.translate(ha.x, ha.y, ha.z);
    rp.push(setUV(prep(gl), 'glove'));
    const hip = V(sgn * 0.14, 0.95, -0.33);
    const knee = V(sgn * 0.27, 0.74, 0.02);
    const ank = V(sgn * 0.17, 0.43, -0.3);
    rp.push(limb(hip, knee, 0.085, 0.07, 'suit'));
    rp.push(limb(knee, ank, 0.068, 0.05, 'suit2'));
    rp.push(box(0.08, 0.1, 0.22, ank.x, ank.y - 0.02, ank.z + 0.04, 'gloss'));
    // Knee slider.
    rp.push(box(0.04, 0.1, 0.1, sgn * 0.33, 0.73, 0.03, 'white'));
  }
  const rider = merge(rp);
  const wheelF = wheelGeo(MOTO.wheelR, MOTO.frontW, 'moto');
  const wheelR = wheelGeo(MOTO.wheelR, MOTO.rearW, 'moto');
  const I = new THREE.Matrix4();
  const lod = bake([
    [bike, I],
    [fork, I],
    [rider, I],
    [wheelF, new THREE.Matrix4().makeTranslation(0, MOTO.wheelR, MOTO.frontZ)],
    [wheelR, new THREE.Matrix4().makeTranslation(0, MOTO.wheelR, MOTO.rearZ)],
  ]);
  return { bike, fork, rider, wheelF, wheelR, lod };
}

// ---- vehicle instances ----------------------------------------------------------------------------------

export interface VehicleView {
  root: THREE.Group;
  /** Rolls with the bike / pitches with the car. */
  body: THREE.Group;
  material: THREE.MeshPhysicalMaterial;
  /** Update visuals. steer = front wheel angle (rad, + right); lean (rad, + right); spin (wheel angle). */
  pose(steer: number, lean: number, spin: number, opts: { brake: number; drs: boolean; tuck: number; hang: number }): void;
  /** Exhaust position in body space (for boost flames). */
  exhaust: THREE.Vector3;
  /** Switch to a single merged mesh far from the camera (one draw call). */
  setLod(far: boolean): void;
  kind: 'f1' | 'moto';
  dispose(): void;
}

export function makeF1(l: Livery): VehicleView {
  f1Geo ??= buildF1();
  const g = f1Geo;
  const mat = vehicleMaterial(l, 'f1');
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const bm = new THREE.Mesh(g.body, mat);
  bm.castShadow = true;
  body.add(bm);
  const flapPivot = new THREE.Group();
  flapPivot.position.set(0, 0.93, -2.47);
  const flap = new THREE.Mesh(g.flap, mat);
  flap.castShadow = true;
  flapPivot.add(flap);
  body.add(flapPivot);
  const wheels: THREE.Mesh[] = [];
  const pivots: THREE.Group[] = [];
  for (const [x, z, front] of [
    [-F1.frontX, F1.frontZ, true],
    [F1.frontX, F1.frontZ, true],
    [-F1.rearX, F1.rearZ, false],
    [F1.rearX, F1.rearZ, false],
  ] as const) {
    const pv = new THREE.Group();
    pv.position.set(x, F1.wheelR, z);
    const w = new THREE.Mesh(front ? g.wheelF : g.wheelR, mat);
    w.castShadow = true;
    pv.add(w);
    body.add(pv);
    wheels.push(w);
    pivots.push(pv);
  }
  let drsOpen = 0;
  const lod = new THREE.Mesh(g.lod, mat);
  lod.castShadow = true;
  lod.visible = false;
  body.add(lod);
  const detail = [bm, flapPivot, ...pivots];
  let far = false;
  return {
    root,
    body,
    material: mat,
    kind: 'f1',
    exhaust: new THREE.Vector3(0, 0.42, -2.3),
    setLod(f) {
      if (f === far) return;
      far = f;
      lod.visible = f;
      for (const d of detail) d.visible = !f;
    },
    pose(steer, lean, spin, o) {
      pivots[0].rotation.y = -steer;
      pivots[1].rotation.y = -steer;
      for (const w of wheels) w.rotation.x = spin;
      drsOpen += ((o.drs ? 1 : 0) - drsOpen) * 0.2;
      flapPivot.rotation.x = -(0.55 - drsOpen * 0.45);
      body.rotation.z = lean;
      mat.emissiveIntensity = 0.5 + o.brake * 2.5;
    },
    dispose() {
      mat.map?.dispose();
      mat.roughnessMap?.dispose();
      mat.emissiveMap?.dispose();
      mat.dispose();
    },
  };
}

export function makeMoto(l: Livery): VehicleView {
  motoGeo ??= buildMoto();
  const g = motoGeo;
  const mat = vehicleMaterial(l, 'moto');
  const root = new THREE.Group();
  const body = new THREE.Group(); // leans about the contact line
  root.add(body);
  const bm = new THREE.Mesh(g.bike, mat);
  bm.castShadow = true;
  body.add(bm);
  // Steering turns the fork about the raked steering axis through the head stock.
  const head = new THREE.Vector3(0, 0.86, 0.5);
  const rake = -0.37;
  const forkPivot = new THREE.Group();
  forkPivot.position.copy(head);
  const forkTilt = new THREE.Group();
  forkTilt.rotation.x = rake;
  forkPivot.add(forkTilt);
  const steerG = new THREE.Group();
  forkTilt.add(steerG);
  const inner = new THREE.Group();
  inner.rotation.x = -rake;
  inner.position.copy(head).applyAxisAngle(new THREE.Vector3(1, 0, 0), -rake).negate();
  steerG.add(inner);
  const fork = new THREE.Mesh(g.fork, mat);
  fork.castShadow = true;
  inner.add(fork);
  const wf = new THREE.Mesh(g.wheelF, mat);
  wf.position.set(0, MOTO.wheelR, MOTO.frontZ);
  wf.castShadow = true;
  inner.add(wf);
  body.add(forkPivot);
  const wr = new THREE.Mesh(g.wheelR, mat);
  wr.position.set(0, MOTO.wheelR, MOTO.rearZ);
  wr.castShadow = true;
  body.add(wr);
  const riderG = new THREE.Group();
  const rider = new THREE.Mesh(g.rider, mat);
  rider.castShadow = true;
  riderG.add(rider);
  body.add(riderG);
  const lod = new THREE.Mesh(g.lod, mat);
  lod.castShadow = true;
  lod.visible = false;
  body.add(lod);
  const detail = [bm, forkPivot, wr, riderG];
  let far = false;
  return {
    root,
    body,
    material: mat,
    kind: 'moto',
    exhaust: new THREE.Vector3(0.14, 0.55, -0.78),
    setLod(f) {
      if (f === far) return;
      far = f;
      lod.visible = f;
      for (const d of detail) d.visible = !f;
    },
    pose(steer, lean, spin, o) {
      steerG.rotation.y = -steer * 0.5;
      wf.rotation.x = spin;
      wr.rotation.x = spin;
      body.rotation.z = -lean;
      // Hang off toward the inside of the corner and tuck in on straights.
      const hang = o.hang;
      riderG.position.set(hang * 0.16, -o.tuck * 0.07, o.tuck * 0.04);
      riderG.rotation.z = -hang * 0.22;
      riderG.rotation.x = o.tuck * 0.08;
      mat.emissiveIntensity = 0.5 + o.brake * 2.5;
    },
    dispose() {
      mat.map?.dispose();
      mat.roughnessMap?.dispose();
      mat.emissiveMap?.dispose();
      mat.dispose();
    },
  };
}

export const WHEEL_R = { f1: F1.wheelR, moto: MOTO.wheelR };
