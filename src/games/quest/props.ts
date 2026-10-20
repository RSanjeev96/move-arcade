/** Level props with behaviour or animation: spikes, duck logs, springs, movers, crumbling tiles, flags, goal gate, guides. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { QuestAssets } from './assets';
import { glowTexture } from './fx';
import { LANE_W, laneX, type HazardDef, type JumpReq, type LevelData, type SpringDef } from './levels';


function place(src: THREE.BufferGeometry, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(sx, sy, sz));
  return src.clone().applyMatrix4(m);
}

/** Spike strips and duck logs, merged into one mesh each. */
export function hazardMeshes(level: LevelData, assets: QuestAssets, kitMat: THREE.Material): THREE.Object3D[] {
  const spikes: THREE.BufferGeometry[] = [];
  const logs: THREE.Object3D[] = [];
  const spikeGeo = assets.geo.get('trap-spikes-large')!;
  for (const h of level.hazards) {
    if (h.kind === 'spikes') {
      const x0 = laneX(h.l0) - LANE_W / 2;
      const x1 = laneX(h.l1) + LANE_W / 2;
      const nx = Math.round((x1 - x0) / 0.8);
      const ns = Math.max(1, Math.round((h.s1 - h.s0) / 0.8));
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ns; j++) {
          const x = x0 + ((i + 0.5) * (x1 - x0)) / nx;
          const s = h.s0 + ((j + 0.5) * (h.s1 - h.s0)) / ns;
          spikes.push(place(spikeGeo, x, h.y - 0.02, -s, ((x1 - x0) / nx / 0.76) * 1.02, 2.2, ((h.s1 - h.s0) / ns / 0.76) * 1.02));
        }
      }
    } else logs.push(duckLog(h));
  }
  const out: THREE.Object3D[] = [...logs];
  if (spikes.length) {
    const m = new THREE.Mesh(mergeGeometries(spikes)!, kitMat);
    m.castShadow = true;
    m.receiveShadow = true;
    out.push(m);
  }
  return out;
}

/** A striped barrier log at head height between two posts: duck under it. */
function duckLog(h: HazardDef): THREE.Group {
  const g = new THREE.Group();
  const s = (h.s0 + h.s1) / 2;
  g.position.set(0, h.y, -s);
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 32;
  const x = c.getContext('2d')!;
  for (let i = 0; i < 8; i++) {
    x.fillStyle = i % 2 ? '#fff4e0' : '#ff4d4d';
    x.beginPath();
    x.moveTo(i * 32, 0);
    x.lineTo(i * 32 + 32, 0);
    x.lineTo(i * 32 + 16, 32);
    x.lineTo(i * 32 - 16, 32);
    x.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(3, 1);
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 5.6, 16), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5, emissive: '#ff3030', emissiveIntensity: 0.12 }));
  bar.rotation.z = Math.PI / 2;
  bar.position.y = 1.47;
  bar.castShadow = true;
  bar.name = 'bar';
  g.add(bar);
  const postMat = new THREE.MeshStandardMaterial({ color: '#7a4a2a', roughness: 0.8 });
  const capMat = new THREE.MeshStandardMaterial({ color: '#ffcf3a', roughness: 0.4, metalness: 0.3 });
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 2.05, 8), postMat);
    post.position.set(side * 2.75, 1.02, 0);
    post.castShadow = true;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), capMat);
    cap.position.set(side * 2.75, 2.1, 0);
    g.add(post, cap);
  }
  return g;
}

// ---- springs ---------------------------------------------------------------------------------------------

export interface SpringVis {
  def: SpringDef;
  group: THREE.Group;
  top: THREE.Object3D;
  t: number;
}

export function makeSprings(level: LevelData, assets: QuestAssets, kitMat: THREE.Material): SpringVis[] {
  const root = assets.nodes.get('spring')!;
  return level.springs.map((def) => {
    const group = new THREE.Group();
    const model = root.clone(true);
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = kitMat;
        m.castShadow = true;
      }
    });
    model.scale.set(1.9, 1.1, 1.6);
    group.add(model);
    group.position.set(laneX(def.lane), def.y, -def.s);
    const top = model.getObjectByName('spring/platform') ?? model;
    const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#ffe066', transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.scale.set(1.8, 0.6, 1);
    ring.position.y = 0.55;
    group.add(ring);
    return { def, group, top, t: 1 };
  });
}

// ---- checkpoint flags and the goal gate ----------------------------------------------------------------

export interface FlagVis {
  group: THREE.Group;
  cloth: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  on: boolean;
}

export function makeFlag(s: number, y: number): FlagVis {
  const group = new THREE.Group();
  group.position.set(2.15, y, -s);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 3.2, 8), new THREE.MeshStandardMaterial({ color: '#e9eef5', metalness: 0.5, roughness: 0.3 }));
  pole.position.y = 1.6;
  pole.castShadow = true;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshStandardMaterial({ color: '#ffd34d', metalness: 0.6, roughness: 0.3, emissive: '#ffb000', emissiveIntensity: 0.3 }));
  knob.position.y = 3.25;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 0.25, 12), new THREE.MeshStandardMaterial({ color: '#8d8aa0', roughness: 0.8 }));
  base.position.y = 0.12;
  const geo = new THREE.PlaneGeometry(1.3, 0.85, 12, 4);
  geo.translate(-0.65, 0, 0);
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uOn: { value: 0 }, uA: { value: new THREE.Color('#7f8aa8') }, uB: { value: new THREE.Color('#ffcf3a') } },
    vertexShader: /* glsl */ `
      uniform float uTime; varying vec2 vUv; varying float vShade;
      void main() {
        vUv = uv;
        float k = -position.x / 1.3;
        vec3 p = position;
        float w = sin(uTime * 6.0 + k * 6.0) * 0.12 * k;
        p.z += w;
        p.y += sin(uTime * 4.0 + k * 4.0) * 0.03 * k;
        vShade = 0.85 + w * 1.5;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOn; uniform vec3 uA, uB; varying vec2 vUv; varying float vShade;
      void main() {
        vec3 c = mix(uA, uB, uOn);
        // A white star emblem in the middle of the cloth.
        vec2 p = (vUv - vec2(0.45, 0.5)) * vec2(1.6, 1.0);
        float a = atan(p.y, p.x);
        float r = length(p);
        float star = step(r, 0.075 + 0.13 * pow(abs(cos(a * 2.5 + 0.785)), 5.0));
        c = mix(c, vec3(1.0), star * 0.9);
        gl_FragColor = vec4(c * vShade, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const cloth = new THREE.Mesh(geo, mat);
  cloth.position.set(0, 2.75, 0);
  group.add(pole, knob, base, cloth);
  return { group, cloth, mat, on: false };
}

export interface GateVis {
  group: THREE.Group;
  star: THREE.Object3D;
  curtain: THREE.ShaderMaterial;
}

export function makeGate(level: LevelData, assets: QuestAssets, kitMat: THREE.Material): GateVis {
  const group = new THREE.Group();
  group.position.set(0, level.goal.y, -level.goal.s);
  const stone = new THREE.MeshStandardMaterial({ color: '#f1e6d6', roughness: 0.7 });
  const gold = new THREE.MeshStandardMaterial({ color: '#ffcf3a', roughness: 0.3, metalness: 0.6, emissive: '#ff9d00', emissiveIntensity: 0.25 });
  for (const side of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 4.4, 12), stone);
    p.position.set(side * 3.0, 2.2, 0);
    p.castShadow = true;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.3, 12), gold);
    cap.position.set(side * 3.0, 4.5, 0);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), gold);
    ball.position.set(side * 3.0, 4.95, 0);
    group.add(p, cap, ball);
  }
  const arch = new THREE.Mesh(new THREE.TorusGeometry(3.0, 0.32, 12, 40, Math.PI), gold);
  arch.position.y = 4.4;
  arch.castShadow = true;
  group.add(arch);
  // A shimmering rainbow curtain to run through.
  const curtain = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; varying vec2 vUv;
      vec3 hue(float h){ return clamp(abs(mod(h*6.0+vec3(0,4,2),6.0)-3.0)-1.0, 0.0, 1.0); }
      void main(){
        float wave = sin(vUv.x * 18.0 + uTime * 3.0) * 0.5 + 0.5;
        vec3 c = hue(fract(vUv.y * 0.8 + uTime * 0.15));
        float a = 0.18 + 0.2 * wave;
        a *= smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
        gl_FragColor = vec4(c, a);
      }`,
  });
  const shape = new THREE.Shape();
  shape.moveTo(-2.8, 0);
  shape.lineTo(2.8, 0);
  shape.lineTo(2.8, 4.4);
  shape.absarc(0, 4.4, 2.8, 0, Math.PI, false);
  shape.lineTo(-2.8, 0);
  const cg = new THREE.ShapeGeometry(shape, 24);
  // ShapeGeometry UVs are in shape units; normalise to 0..1.
  const uv = cg.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) + 2.8) / 5.6, uv.getY(i) / 7.2);
  const cm = new THREE.Mesh(cg, curtain);
  group.add(cm);
  const star = new THREE.Mesh(assets.geo.get('star')!, kitMat);
  star.scale.setScalar(4.5);
  star.position.y = 7.6;
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#ffd84d', transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
  halo.scale.setScalar(4);
  halo.position.y = 8.4;
  group.add(star, halo);
  // Bunting flags along the arch.
  const colors = ['#ff4f7b', '#ffd84d', '#4fd8ff', '#7cff6b', '#b46bff'];
  for (let i = 0; i < 11; i++) {
    const a = Math.PI * (0.08 + (0.84 * i) / 10);
    const m = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 3), new THREE.MeshStandardMaterial({ color: colors[i % colors.length], roughness: 0.6 }));
    m.position.set(Math.cos(a) * 2.75, 4.4 + Math.sin(a) * 2.75 - 0.3, 0.05);
    m.rotation.z = Math.PI;
    group.add(m);
  }
  return { group, star, curtain };
}

// ---- jump guides ------------------------------------------------------------------------------------------

function chevronTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.lineWidth = 14;
  g.beginPath();
  g.moveTo(16, 52);
  g.lineTo(64, 14);
  g.lineTo(112, 52);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Glowing chevrons painted on the ground before each jump: green = hop, orange = big jump. */
export function makeGuides(level: LevelData): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } | null {
  const reqs = level.jumps.filter((j) => j.kind !== 'spring');
  if (!reqs.length) return null;
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const phase: number[] = [];
  const idx: number[] = [];
  const hop = new THREE.Color('#5dffb0');
  const big = new THREE.Color('#ffa63d');
  let n = 0;
  const quad = (x: number, y: number, s: number, w: number, l: number, c: THREE.Color, ph: number) => {
    const z = -s;
    pos.push(x - w / 2, y, z + l / 2, x + w / 2, y, z + l / 2, x + w / 2, y, z - l / 2, x - w / 2, y, z - l / 2);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let i = 0; i < 4; i++) {
      col.push(c.r, c.g, c.b);
      phase.push(ph);
    }
    idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
    n += 4;
  };
  const lanesAt = (r: JumpReq): [number, number] => {
    const src = level.boxes.find((b) => b.kind !== 'mystery' && b.kind !== 'crate' && b.s0 <= r.s - 1 && b.s1 >= r.s - 1 && Math.abs(b.top - r.fromTop) < 0.01);
    return src ? [src.l0, src.l1] : [-1, 1];
  };
  for (const r of reqs) {
    const [l0, l1] = lanesAt(r);
    const end = r.why === 'step' ? r.s - 0.9 : r.why === 'spikes' ? r.s - 0.4 : r.s - 0.3;
    for (let l = l0; l <= l1; l++) {
      for (let k = 0; k < 3; k++) quad(laneX(l), r.fromTop + 0.03, end - k * 0.9 - 0.35, 0.9, 0.45, r.kind === 'big' ? big : hop, k * 0.33);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  g.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    uniforms: { map: { value: chevronTexture() }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute vec3 aColor; attribute float aPhase;
      varying vec2 vUv; varying vec3 vColor; varying float vPhase;
      void main(){ vUv = uv; vColor = aColor; vPhase = aPhase; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map; uniform float uTime;
      varying vec2 vUv; varying vec3 vColor; varying float vPhase;
      void main(){
        float t = texture2D(map, vec2(vUv.x, 1.0 - vUv.y)).a;
        float pulse = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(uTime * 6.0 - vPhase * 6.28), 2.0);
        gl_FragColor = vec4(vColor * 1.4, t * pulse * 0.9);
      }`,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.renderOrder = 3;
  return { mesh, mat };
}

/** Ring showing where the current jump will land, and a soft shadow under the player. */
export class LandingMarker {
  readonly ring: THREE.Mesh;
  readonly blob: THREE.Mesh;
  constructor() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,0,0,0.55)');
    gr.addColorStop(0.6, 'rgba(0,0,0,0.35)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
    const blobTex = new THREE.CanvasTexture(c);
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = 4;
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.46, 40),
      new THREE.MeshBasicMaterial({ color: '#fff7c2', transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4 }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 4;
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.12, 24), this.ring.material);
    this.ring.add(dot);
    this.ring.visible = false;
  }
}
