/** Particle effects: tyre smoke / dust (soft), sparks (additive), skid marks and speed streaks. */
import * as THREE from 'three';
import { puffTexture } from './textures';

let puff: THREE.Texture | null = null;
const puffTex = () => (puff ??= puffTexture());

export class Particles {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private alpha: Float32Array;
  private size: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grow: Float32Array;
  private a0: Float32Array;
  private next = 0;
  private mat: THREE.ShaderMaterial;

  constructor(
    private n: number,
    additive: boolean,
    private gravity = 0,
    private drag = 1.5,
  ) {
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.alpha = new Float32Array(n);
    this.size = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n).fill(1);
    this.grow = new Float32Array(n);
    this.a0 = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uMap: { value: puffTex() }, uScale: { value: 600 }, uBright: { value: additive ? 2.2 : 1 } },
      vertexShader: `
        attribute vec3 color; attribute float alpha; attribute float size;
        varying vec3 vCol; varying float vA; uniform float uScale;
        void main(){ vCol = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = size * uScale / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        uniform sampler2D uMap; uniform float uBright; varying vec3 vCol; varying float vA;
        void main(){ vec4 t = texture2D(uMap, gl_PointCoord); if (vA <= 0.001) discard; gl_FragColor = vec4(vCol * uBright, t.a * vA);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
  }

  setViewportHeight(h: number): void {
    this.mat.uniforms.uScale.value = h * 0.9;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, grow: number, c: THREE.Color, alpha: number): void {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = c.r;
    this.col[i * 3 + 1] = c.g;
    this.col[i * 3 + 2] = c.b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.grow[i] = grow;
    this.a0[i] = alpha;
    this.alpha[i] = alpha;
  }

  update(dt: number): void {
    const k = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const f = Math.max(0, this.life[i] / this.maxLife[i]);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.gravity * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      this.alpha[i] = this.a0[i] * f * Math.min(1, (1 - f) * 8 + 0.3);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}

/** Dark tyre marks laid as a ring buffer of quads. */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private alpha: Float32Array;
  private next = 0;
  private last: (THREE.Vector3 | null)[] = [null, null];

  constructor(private max = 1600) {
    this.pos = new Float32Array(max * 6 * 3);
    this.alpha = new Float32Array(max * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(0.03,0.03,0.03, vA);
        #include <colorspace_fragment>
      }`,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
  }

  /** Add to wheel track `w` at p (with right vector r). strength 0 = lift the "pen". */
  add(w: 0 | 1, p: THREE.Vector3, r: THREE.Vector3, strength: number, width = 0.32): void {
    const prev = this.last[w];
    if (strength <= 0.05) {
      this.last[w] = null;
      return;
    }
    const cur = p.clone();
    cur.y += 0.03;
    if (prev && prev.distanceToSquared(cur) > 0.25 && prev.distanceToSquared(cur) < 25) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const hw = width / 2;
      const a1 = [prev.x - r.x * hw, prev.y, prev.z - r.z * hw];
      const a2 = [prev.x + r.x * hw, prev.y, prev.z + r.z * hw];
      const b1 = [cur.x - r.x * hw, cur.y, cur.z - r.z * hw];
      const b2 = [cur.x + r.x * hw, cur.y, cur.z + r.z * hw];
      const v = [a1, b1, a2, a2, b1, b2];
      for (let k = 0; k < 6; k++) {
        this.pos.set(v[k], (i * 6 + k) * 3);
        this.alpha[i * 6 + k] = Math.min(0.55, strength * 0.6);
      }
      this.mesh.geometry.attributes.position.needsUpdate = true;
      this.mesh.geometry.attributes.alpha.needsUpdate = true;
      this.last[w] = cur;
    } else if (!prev || prev.distanceToSquared(cur) >= 25) this.last[w] = cur;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** Wind streaks around the camera at high speed (child of the camera). */
export class SpeedLines {
  readonly lines: THREE.LineSegments;
  private pos: Float32Array;
  private seeds: Float32Array;
  private mat: THREE.LineBasicMaterial;
  private z: Float32Array;
  private readonly N = 70;

  constructor() {
    this.pos = new Float32Array(this.N * 6);
    this.seeds = new Float32Array(this.N * 2);
    this.z = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 1.4 + Math.random() * 2.6;
      this.seeds[i * 2] = Math.cos(a) * r * 1.6;
      this.seeds[i * 2 + 1] = Math.sin(a) * r;
      this.z[i] = -Math.random() * 40;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    this.lines = new THREE.LineSegments(g, this.mat);
    this.lines.frustumCulled = false;
  }

  update(dt: number, speed: number, intensity: number): void {
    this.mat.opacity = Math.min(0.5, intensity) * 0.6;
    this.lines.visible = intensity > 0.02;
    if (!this.lines.visible) return;
    const len = 0.5 + speed * 0.05;
    for (let i = 0; i < this.N; i++) {
      this.z[i] += speed * dt * 1.4;
      if (this.z[i] > 1) this.z[i] -= 42;
      const x = this.seeds[i * 2];
      const y = this.seeds[i * 2 + 1] * 0.8 + 0.3;
      this.pos.set([x, y, this.z[i], x, y, this.z[i] - len], i * 6);
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.mat.dispose();
  }
}

/** Additive glow sprite used for boost flames and lights. */
export function glowSprite(color: THREE.ColorRepresentation, size: number): THREE.Sprite {
  const m = new THREE.SpriteMaterial({ map: puffTex(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(size);
  return s;
}
