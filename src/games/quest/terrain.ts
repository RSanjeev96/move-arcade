/**
 * Static level geometry: Kenney blocks tiled over every platform, rocky floating-island undersides,
 * decorations, distant islands with waterfalls and castles. Everything static is merged into a few meshes
 * per 48 m chunk (one draw call per material per chunk) so the tablet can keep 60 fps.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { QuestAssets } from './assets';
import { LANE_W, laneX, type BoxDef, type LevelData } from './levels';
import type { Theme } from './sky';

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

export interface TerrainMaterials {
  grass: THREE.Material;
  stone: THREE.Material;
  castle: THREE.Material;
  props: THREE.Material;
  rock: THREE.Material;
  water: THREE.ShaderMaterial;
}

type Bucket = 'grass' | 'stone' | 'castle' | 'props' | 'rock' | 'water';

const CHUNK = 48;
const TILE = LANE_W;
/** Kenney "large" blocks are 2.08 wide including the grass lip; scaling to this makes lips meet exactly. */
const KW = 2.08;

class ChunkBuilder {
  private parts = new Map<string, THREE.BufferGeometry[]>();
  add(chunk: number, bucket: Bucket, g: THREE.BufferGeometry): void {
    const k = `${chunk}:${bucket}`;
    let list = this.parts.get(k);
    if (!list) this.parts.set(k, (list = []));
    list.push(g);
  }
  build(mats: TerrainMaterials, group: THREE.Group, shadows: boolean): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const [k, list] of this.parts) {
      const bucket = k.split(':')[1] as Bucket;
      const merged = mergeGeometries(list, false);
      list.forEach((g) => g.dispose());
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mats[bucket]);
      mesh.matrixAutoUpdate = false;
      mesh.receiveShadow = bucket !== 'water';
      // Flat ground does not need to cast: only trees and props do (much cheaper shadow pass).
      mesh.castShadow = shadows && bucket === 'props';
      if (bucket === 'water') mesh.renderOrder = 2;
      group.add(mesh);
      out.push(mesh);
    }
    this.parts.clear();
    return out;
  }
}

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const v = new THREE.Vector3();
const sc = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);

/** A transformed copy of a model with a flat vertex tint (per-tile colour variation, white = none). */
function placed(src: THREE.BufferGeometry, x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY = 0, tint = 1, warm = 0): THREE.BufferGeometry {
  q.setFromAxisAngle(up, rotY);
  m4.compose(v.set(x, y, z), q, sc.set(sx, sy, sz));
  const g = src.clone().applyMatrix4(m4);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const r = tint * (1 + warm);
  const gg = tint;
  const b = tint * (1 - warm);
  for (let i = 0; i < n; i++) col.set([r, gg, b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** A faceted rocky cone hanging under an island footprint (vertex coloured, flat shaded). */
export function underside(x0: number, x1: number, z0: number, z1: number, yTop: number, depth: number, r: () => number, theme: Theme): THREE.BufferGeometry {
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const hw = (x1 - x0) / 2;
  const hd = (z1 - z0) / 2;
  // Perimeter of the footprint, a point every ~1.3 m.
  const per: [number, number][] = [];
  const nx = Math.max(2, Math.round((x1 - x0) / 1.3));
  const nz = Math.max(2, Math.round((z1 - z0) / 1.3));
  for (let i = 0; i < nx; i++) per.push([x0 + ((x1 - x0) * i) / nx, z0]);
  for (let i = 0; i < nz; i++) per.push([x1, z0 + ((z1 - z0) * i) / nz]);
  for (let i = 0; i < nx; i++) per.push([x1 - ((x1 - x0) * i) / nx, z1]);
  for (let i = 0; i < nz; i++) per.push([x0, z1 - ((z1 - z0) * i) / nz]);
  const rings = [
    { d: 0, f: 0.0, j: 0.05 },
    { d: 0.3, f: 0.06, j: 0.25 },
    { d: 0.55, f: 0.3, j: 0.35 },
    { d: 0.8, f: 0.62, j: 0.3 },
  ];
  const pts: THREE.Vector3[][] = rings.map((rg) =>
    per.map(([px, pz]) => {
      const k = 1 - rg.f;
      const jx = (r() - 0.5) * 2 * rg.j * Math.min(1.5, hw);
      const jz = (r() - 0.5) * 2 * rg.j * Math.min(1.5, hd);
      return new THREE.Vector3(cx + (px - cx) * k + jx * (rg.d > 0 ? 1 : 0), yTop - rg.d * depth * (0.85 + r() * 0.3), cz + (pz - cz) * k + jz * (rg.d > 0 ? 1 : 0));
    }),
  );
  const tip = new THREE.Vector3(cx + (r() - 0.5) * hw * 0.3, yTop - depth * (1 + r() * 0.15), cz + (r() - 0.5) * hd * 0.3);
  const pos: number[] = [];
  const col: number[] = [];
  const cTop = new THREE.Color(theme.rockTop);
  const cMid = new THREE.Color(theme.rockMid);
  const cLow = new THREE.Color(theme.rockLow);
  const shade = (k: number) => {
    const c = k < 0.5 ? cTop.clone().lerp(cMid, k * 2) : cMid.clone().lerp(cLow, (k - 0.5) * 2);
    const n = 0.88 + r() * 0.2;
    return [c.r * n, c.g * n, c.b * n];
  };
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, k: number) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    const cc = shade(k);
    col.push(...cc, ...cc, ...cc);
  };
  const n = per.length;
  for (let ri = 0; ri < pts.length - 1; ri++) {
    const A = pts[ri];
    const B = pts[ri + 1];
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      tri(A[i], B[i], A[i2], ri / 3);
      tri(A[i2], B[i], B[i2], ri / 3 + 0.12);
    }
  }
  const L = pts[pts.length - 1];
  for (let i = 0; i < n; i++) tri(L[i], tip, L[(i + 1) % n], 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

/** Vertex-coloured, flat-shaded primitive (castle towers, roofs, logs). */
function colored(g: THREE.BufferGeometry, color: string, jitter = 0.08, r?: () => number): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  ng.deleteAttribute('uv');
  const c = new THREE.Color(color);
  const n = ng.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 3) {
    const k = 1 + (r ? r() - 0.5 : 0) * jitter * 2;
    for (let j = 0; j < 3; j++) col.set([c.r * k, c.g * k, c.b * k], (i + j) * 3);
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  ng.computeVertexNormals();
  return ng;
}

function tower(x: number, y: number, z: number, radius: number, height: number, roof: string, stone: string, r: () => number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const body = colored(new THREE.CylinderGeometry(radius, radius * 1.08, height, 12, 3), stone, 0.1, r);
  body.translate(x, y + height / 2, z);
  out.push(body);
  const ring = colored(new THREE.CylinderGeometry(radius * 1.18, radius * 1.18, height * 0.08, 12), stone, 0.06, r);
  ring.translate(x, y + height, z);
  out.push(ring);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const m = colored(new THREE.BoxGeometry(radius * 0.36, radius * 0.4, radius * 0.36), stone, 0.06, r);
    m.translate(x + Math.cos(a) * radius * 1.05, y + height + radius * 0.22, z + Math.sin(a) * radius * 1.05);
    out.push(m);
  }
  const cone = colored(new THREE.ConeGeometry(radius * 1.3, radius * 2.4, 12), roof, 0.1, r);
  cone.translate(x, y + height + radius * 1.35, z);
  out.push(cone);
  // Windows.
  for (let i = 0; i < 3; i++) {
    const a = r() * Math.PI * 2;
    const w = colored(new THREE.BoxGeometry(radius * 0.22, radius * 0.4, 0.05), '#3a2a48');
    w.rotateY(-a + Math.PI / 2);
    w.translate(x + Math.cos(a) * radius * 1.01, y + height * (0.4 + r() * 0.4), z + Math.sin(a) * radius * 1.01);
    out.push(w);
  }
  return out;
}

export interface TerrainOut {
  group: THREE.Group;
  meshes: THREE.Mesh[];
}

export function buildTerrain(level: LevelData, assets: QuestAssets, theme: Theme, mats: TerrainMaterials, shadows: boolean): TerrainOut {
  const group = new THREE.Group();
  const cb = new ChunkBuilder();
  const G = (n: string) => {
    const g = assets.geo.get(n);
    if (!g) throw new Error(`missing model ${n}`);
    return g;
  };
  const r = rng(level.id * 7919 + 17);
  const chunkOf = (s: number) => Math.floor(s / CHUNK);
  const blockTall = G('block-grass-large-tall');

  const skinOf = (b: BoxDef): Bucket => (b.kind === 'stone' ? 'stone' : b.kind === 'castle' ? 'castle' : 'grass');

  /** Tile a rectangle (path space) with tall blocks whose tops are at `top`. */
  const tiles = (bucket: Bucket, s0: number, s1: number, x0: number, x1: number, top: number, h = 1.6, tile = TILE, along = tile) => {
    const nx = Math.max(1, Math.round((x1 - x0) / tile));
    const ns = Math.max(1, Math.round((s1 - s0) / along));
    const w = (x1 - x0) / nx;
    const l = (s1 - s0) / ns;
    for (let j = 0; j < ns; j++) {
      const s = s0 + (j + 0.5) * l;
      for (let i = 0; i < nx; i++) {
        const x = x0 + (i + 0.5) * w;
        // A mowed-lawn checker plus a gentle patchwork (also a strong depth cue in first person).
        const checker = (i + j + Math.round(s0 / along)) % 2 === 0 ? 1 : 0.9;
        cb.add(chunkOf(s), bucket, placed(blockTall, x, top - h, -s, w / KW, h / 2, l / KW, 0, checker * (0.94 + r() * 0.09), (r() - 0.5) * 0.06));
      }
    }
  };

  const prop = (name: string, s: number, x: number, y: number, scale: number, rot = r() * Math.PI * 2) => {
    cb.add(chunkOf(s), 'props', placed(G(name), x, y, -s, scale, scale, scale, rot));
  };

  const rockUnder = (s0: number, s1: number, x0: number, x1: number, yTop: number) => {
    // Long platforms get several hanging lumps instead of one long wedge.
    const len = s1 - s0;
    const n = Math.max(1, Math.round(len / 9));
    for (let i = 0; i < n; i++) {
      const a = s0 + (len * i) / n;
      const z = s0 + (len * (i + 1)) / n;
      const w = x1 - x0;
      const depth = Math.min(9, Math.max(2.4, 1.4 + 0.45 * Math.sqrt(w * (z - a))));
      cb.add(chunkOf((a + z) / 2), 'rock', underside(x0 + 0.06, x1 - 0.06, -z + 0.06, -a - 0.06, yTop + 0.02, depth, r, theme));
    }
  };

  const decorate = (s0: number, s1: number, x0: number, x1: number, top: number, density: number, sunset: boolean) => {
    // Trees keep clear of the path so the view ahead stays open.
    const clear = (x: number) => Math.abs(x) > 3.7;
    const ns = Math.max(1, Math.floor((s1 - s0) / 1.6));
    const nx = Math.max(1, Math.floor((x1 - x0) / 1.6));
    for (let j = 0; j < ns; j++) {
      for (let i = 0; i < nx; i++) {
        if (r() > density) continue;
        const s = s0 + (j + 0.2 + r() * 0.6) * 1.6;
        const x = x0 + (i + 0.2 + r() * 0.6) * 1.6;
        const k = r();
        if (k < 0.3 && clear(x)) prop(sunset || r() < 0.55 ? 'tree-pine' : 'tree', s, x, top, 1.25 + r() * 0.75);
        else if (k < 0.38 && clear(x)) prop('tree-pine-small', s, x, top, 1.4 + r() * 0.6);
        else if (k < 0.38) prop('flowers', s, x, top, 1.4 + r() * 0.5);
        else if (k < 0.58) prop('flowers', s, x, top, 1.6 + r() * 0.6);
        else if (k < 0.72) prop('grass', s, x, top, 1.8 + r() * 0.8);
        else if (k < 0.8) prop('rocks', s, x, top, 1.4 + r() * 1.2);
        else if (k < 0.86) prop('flowers-tall', s, x, top, 1.6 + r() * 0.6);
        else if (k < 0.91) prop(sunset ? 'stones' : 'mushrooms', s, x, top, 1.6 + r() * 0.6);
        else if (k < 0.96) prop('plant', s, x, top, 1.8 + r() * 0.6);
        else prop(sunset ? 'barrel' : 'hedge', s, x, top, 1.5);
      }
    }
  };

  const sunset = theme.id === 'sunset';
  const waterfalls: { x: number; y: number; z: number; w: number; h: number; side: number }[] = [];

  for (const b of level.boxes) {
    if (b.kind === 'mystery' || b.kind === 'crate' || b.kind === 'mover' || b.kind === 'crumble') continue;
    const x0 = laneX(b.l0) - LANE_W / 2;
    const x1 = laneX(b.l1) + LANE_W / 2;
    if (b.kind === 'wood') {
      // Rope bridge: planks across the lane, posts and ropes either side.
      const n = Math.max(1, Math.round((b.s1 - b.s0) / 0.8));
      const l = (b.s1 - b.s0) / n;
      for (let j = 0; j < n; j++) {
        const s = b.s0 + (j + 0.5) * l;
        cb.add(chunkOf(s), 'props', placed(G('platform'), (x0 + x1) / 2 + (r() - 0.5) * 0.04, b.top - 0.2, -s, (x1 - x0) * 1.04, 1, l * 0.94, (r() - 0.5) * 0.04));
      }
      for (const x of [x0 - 0.06, x1 + 0.06]) {
        const posts = Math.max(1, Math.round((b.s1 - b.s0) / 2.4));
        for (let k = 0; k <= posts; k++) {
          const s = b.s0 + ((b.s1 - b.s0) * k) / posts;
          const post = colored(new THREE.CylinderGeometry(0.07, 0.09, 1.3, 6), '#8a5a36', 0.1, r);
          post.translate(x, b.top + 0.25, -s);
          cb.add(chunkOf(s), 'rock', post);
        }
        const segs = Math.max(1, Math.round(b.s1 - b.s0));
        for (let k = 0; k < segs; k++) {
          const s = b.s0 + ((k + 0.5) * (b.s1 - b.s0)) / segs;
          cb.add(chunkOf(s), 'props', placed(G('fence-rope'), x, b.top + 0.3, -s, (b.s1 - b.s0) / segs / 0.94, 1.6, 1.0, Math.PI / 2));
        }
      }
      continue;
    }
    const skin = skinOf(b);
    // One tile per lane across; ~3.2 m along the path (half the triangles, still a clear grid for depth).
    tiles(skin, b.s0, b.s1, x0, x1, b.top, 1.6, TILE, 3.2);
    const deep = Math.max(1.6, b.depth);
    if (deep > 1.6) tiles(skin, b.s0, b.s1, x0, x1, b.top - 1.6, deep - 1.6, TILE * 2, 6.4);
    rockUnder(b.s0, b.s1, x0, x1, b.top - deep);
    // Grass tufts and flowers along the outer edges of the path (never in the middle of a lane).
    for (let s = b.s0 + 1 + r() * 2; s < b.s1 - 0.8; s += 2.2 + r() * 3) {
      const side = r() < 0.5 ? -1 : 1;
      const x = side < 0 ? x0 + 0.18 : x1 - 0.18;
      if (skin === 'grass') prop(r() < 0.6 ? 'grass' : 'flowers', s, x, b.top, 0.9 + r() * 0.4);
      else if (r() < 0.3) prop('stones', s, x, b.top, 0.9);
    }
    if (b.shoulder) {
      const len = b.s1 - b.s0;
      const inset = Math.min(3.2, len * 0.15);
      for (const side of [-1, 1]) {
        const width = r() < 0.4 ? 3 * TILE : 2 * TILE;
        const sx0 = side < 0 ? x0 - width : x1;
        const sx1 = side < 0 ? x0 : x1 + width;
        const s0 = b.s0 + inset * (0.5 + r());
        const s1 = b.s1 - inset * (0.5 + r());
        if (s1 - s0 < 3) continue;
        const top = b.top - (r() < 0.25 ? 1.6 : 0.8);
        tiles(skin === 'castle' ? 'castle' : skin, s0, s1, sx0, sx1, top, 1.6, width / Math.round(width / 3.2), 3.2);
        rockUnder(s0, s1, sx0, sx1, top - 1.6);
        decorate(s0, s1, side < 0 ? sx0 : sx0 + 0.6, side < 0 ? sx1 - 0.6 : sx1, top, skin === 'castle' ? 0.18 : 0.32, sunset);
        if (theme.water && r() < 0.5) waterfalls.push({ x: side < 0 ? sx0 : sx1, y: top - 0.05, z: -(s0 + s1) / 2, w: Math.min(4, (s1 - s0) * 0.4), h: 26, side });
      }
    }
  }

  // Distant islands either side of the path, some with waterfalls or towers.
  const heightAt = (s: number) => {
    let y = 0;
    for (const b of level.boxes) if (b.s0 <= s && !b.shoulder && b.kind !== 'mystery') y = b.top;
    return y;
  };
  let side = 1;
  for (let s = -60; s < level.length + 260; s += 22 + r() * 22) {
    side = r() < 0.7 ? -side : side;
    const dist = 26 + r() * 110;
    const x = side * dist;
    const y = heightAt(Math.max(0, Math.min(level.length, s))) - 14 + r() * 30;
    const size = 5 + r() * 12;
    const bucket: Bucket = sunset && r() < 0.5 ? 'stone' : 'grass';
    const t = Math.max(3, size / 3);
    // Distant islands use big tiles: far fewer triangles and they read the same from afar.
    const big = Math.max(3.2, size / 3);
    tiles(bucket, s - size / 2, s + size / 2, x - size / 2, x + size / 2, y, t, big);
    rockUnder(s - size / 2, s + size / 2, x - size / 2, x + size / 2, y - t);
    // A raised chunk for an irregular silhouette.
    if (r() < 0.6) {
      const w = size * (0.35 + r() * 0.3);
      const ox = (r() - 0.5) * (size - w);
      const oz = (r() - 0.5) * (size - w);
      tiles(bucket, s + oz - w / 2, s + oz + w / 2, x + ox - w / 2, x + ox + w / 2, y + t * 0.6, t * 0.6, big);
    }
    const trees = Math.round(size / 5 + r() * 2);
    for (let i = 0; i < trees; i++) {
      prop(sunset || r() < 0.45 ? 'tree-pine' : 'tree', s + (r() - 0.5) * size * 0.8, x + (r() - 0.5) * size * 0.8, y, 3 + r() * 3.5);
    }
    if ((sunset && r() < 0.45) || r() < 0.08) {
      for (const g of tower(x + (r() - 0.5) * size * 0.4, y, -(s + (r() - 0.5) * size * 0.4), 1.2 + size * 0.12, 6 + size * 0.7, r() < 0.5 ? '#c84a5a' : '#4a6ad0', '#d8cfc4', r)) cb.add(chunkOf(s), 'rock', g);
    }
    if ((theme.water || r() < 0.3) && dist < 100) waterfalls.push({ x: x - side * size * 0.5, y: y - 0.1, z: -s, w: size * 0.35, h: 40 + r() * 30, side: -side });
  }

  // The goal: a castle for the citadel, a big island beyond the gate otherwise.
  const g = level.goal;
  if (sunset) {
    const cs = g.s + 60;
    tiles('castle', cs - 22, cs + 22, -26, 26, g.y + 6, 6, 6);
    rockUnder(cs - 22, cs + 22, -26, 26, g.y);
    for (const [tx, tz, rr, hh] of [
      [-18, -16, 3.2, 20],
      [18, -16, 3.2, 20],
      [-12, 14, 2.6, 16],
      [12, 14, 2.6, 16],
      [0, 0, 5, 34],
    ]) {
      for (const geo of tower(tx, g.y + 6, -(cs + tz), rr, hh, '#c84a5a', '#e2d6c8', r)) cb.add(chunkOf(cs), 'rock', geo);
    }
  }

  // Waterfalls: vertical ribbons pouring off island sides into the clouds.
  for (const w of waterfalls) {
    const geo = new THREE.PlaneGeometry(w.w, w.h, 1, 8);
    geo.translate(0, -w.h / 2, 0);
    geo.rotateY(w.side > 0 ? Math.PI / 2 : -Math.PI / 2);
    geo.translate(w.x + w.side * 0.08, w.y, w.z);
    const s = -w.z;
    cb.add(chunkOf(s), 'water', geo);
  }

  const meshes = cb.build(mats, group, shadows);
  return { group, meshes };
}

/** Animated waterfall material (scrolling foam streaks, fading into mist). */
export function waterMaterial(theme: Theme): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    uniforms: { uTime: { value: 0 }, uTint: { value: new THREE.Color(theme.id === 'sunset' ? '#ffd2c4' : '#bff4ff') }, ...THREE.UniformsLib.fog },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uTint;
      varying vec2 vUv;
      #include <fog_pars_fragment>
      float hash(float n) { return fract(sin(n) * 43758.5453); }
      void main() {
        float x = vUv.x * 9.0;
        float col = floor(x);
        float speed = 0.6 + hash(col) * 0.5;
        float streak = fract(vUv.y * 3.0 + uTime * speed + hash(col + 3.0));
        float s = smoothstep(0.0, 0.3, streak) * smoothstep(1.0, 0.6, streak);
        float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
        float fade = smoothstep(0.0, 0.55, vUv.y);
        vec3 c = mix(vec3(0.55, 0.82, 0.95) * uTint, vec3(1.0), s * 0.7 + (1.0 - vUv.y) * 0.0);
        float top = smoothstep(0.93, 1.0, vUv.y);
        c = mix(c, vec3(1.0), top);
        gl_FragColor = vec4(c, (0.55 + 0.35 * s) * edge * fade);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}
