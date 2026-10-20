/** Loads and prepares Sky Quest's models (Kenney Platformer Kit + Quaternius monsters) and textures. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ThemeId } from './levels';

const BASE = import.meta.env.BASE_URL + 'assets/quest/';

export type MonsterName = 'PinkBlob' | 'GreenBlob' | 'GreenSpikyBlob' | 'Armabee' | 'Glub';
export const MONSTERS: MonsterName[] = ['PinkBlob', 'GreenBlob', 'GreenSpikyBlob', 'Armabee', 'Glub'];

export interface Monster {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
  /** Bounding box of the bind pose (model units). */
  box: THREE.Box3;
}

export interface QuestAssets {
  /** Flattened geometry of each Kenney model in its own space (all share the colormap UVs). */
  geo: Map<string, THREE.BufferGeometry>;
  /** Model roots (for models with moving parts). */
  nodes: Map<string, THREE.Object3D>;
  colormap: HTMLImageElement;
  monsters: Record<MonsterName, Monster>;
  music: Map<string, AudioBuffer>;
}

let cache: Promise<QuestAssets> | null = null;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error(`Could not load ${url}`));
    im.src = url;
  });
}

/** Bake a model (root + children) into one geometry with position/normal/uv. */
function flatten(root: THREE.Object3D): THREE.BufferGeometry {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const parts: THREE.BufferGeometry[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    parts.push(g.index ? g.toNonIndexed() : g);
  });
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((p) => p.dispose());
  return merged;
}

export function loadAssets(onProgress: (k: number) => void, music: (name: string) => Promise<AudioBuffer | null>): Promise<QuestAssets> {
  if (cache) return cache;
  cache = (async () => {
    const loader = new GLTFLoader();
    let done = 0;
    const total = 2 + MONSTERS.length;
    const tick = () => onProgress(++done / total);
    const [kit, colormap] = await Promise.all([
      loader.loadAsync(BASE + 'models/kit.glb').then((g) => (tick(), g)),
      loadImage(BASE + 'models/colormap.png').then((i) => (tick(), i)),
    ]);
    const geo = new Map<string, THREE.BufferGeometry>();
    const nodes = new Map<string, THREE.Object3D>();
    for (const root of kit.scene.children) {
      nodes.set(root.name, root);
      geo.set(root.name, flatten(root));
    }
    const monsters = {} as Record<MonsterName, Monster>;
    await Promise.all(
      MONSTERS.map(async (name) => {
        const g = await loader.loadAsync(`${BASE}models/${name}.glb`);
        g.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            const mat = m.material as THREE.MeshStandardMaterial;
            // The atlas reads dark under game lighting: brighten and add a little self-light so they pop.
            mat.color.setScalar(1.5);
            mat.roughness = 0.55;
            mat.emissive = new THREE.Color(0xffffff);
            mat.emissiveMap = mat.map;
            mat.emissiveIntensity = 0.18;
            m.castShadow = true;
            m.frustumCulled = false;
          }
        });
        monsters[name] = { scene: g.scene, clips: g.animations, box: new THREE.Box3().setFromObject(g.scene) };
        tick();
      }),
    );
    const tracks = new Map<string, AudioBuffer>();
    await Promise.all(
      ['meadow', 'falls', 'sunset', 'fanfare'].map(async (n) => {
        const b = await music(n).catch(() => null);
        if (b) tracks.set(n, b);
      }),
    );
    return { geo, nodes, colormap, monsters, music: tracks };
  })();
  cache.catch(() => (cache = null));
  return cache;
}

// ---- colormap variants -----------------------------------------------------------------------------

/** Kenney colormap columns: grass/leaves (x 480-512) and dirt (x 224-256), rows 256-384. */
const GRASS = { x: 480, w: 32 };
const DIRT = { x: 224, w: 32 };

function recolor(g: CanvasRenderingContext2D, col: { x: number; w: number }, light: string, dark: string): void {
  const img = g.getImageData(col.x, 256, col.w, 128);
  const a = new THREE.Color(light);
  const b = new THREE.Color(dark);
  for (let y = 0; y < 128; y++) {
    const k = y / 127;
    const c = a.clone().lerp(b, k);
    for (let x = 0; x < col.w; x++) {
      const i = (y * col.w + x) * 4;
      img.data[i] = c.r * 255;
      img.data[i + 1] = c.g * 255;
      img.data[i + 2] = c.b * 255;
    }
  }
  g.putImageData(img, col.x, 256);
}

export type Skin = 'grass' | 'stone' | 'castle' | 'plain';

const THEME_GRASS: Record<ThemeId, [string, string]> = {
  meadow: ['#8dcc5c', '#357f40'],
  falls: ['#72c98c', '#22755c'],
  sunset: ['#b2c661', '#56763a'],
};

/** A colormap texture recoloured for a block skin and level theme. */
export function skinTexture(img: HTMLImageElement, skin: Skin, theme: ThemeId): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  if (skin === 'grass') {
    const [l, d] = THEME_GRASS[theme];
    recolor(g, GRASS, l, d);
    recolor(g, DIRT, '#c9824e', '#8a4a2c');
  } else if (skin === 'stone') {
    recolor(g, GRASS, '#efe0bf', '#b9a27c');
    recolor(g, DIRT, '#b3a49a', '#7c6e68');
  } else if (skin === 'castle') {
    recolor(g, GRASS, '#e6dcef', '#a99bc0');
    recolor(g, DIRT, '#c7b3a4', '#8c7466');
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}
