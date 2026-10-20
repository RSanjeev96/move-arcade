/** Particles, confetti and shockwave rings. */
import * as THREE from 'three';

function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let sparkTex: THREE.Texture | null = null;
let puffTex: THREE.Texture | null = null;
let glowTex: THREE.Texture | null = null;

/** Four-point twinkle star with a soft core. */
export function sparkleTexture(): THREE.Texture {
  return (sparkTex ??= canvasTex(64, (g, s) => {
    const c = s / 2;
    const gr = g.createRadialGradient(c, c, 0, c, c, c);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.2, 'rgba(255,255,255,0.8)');
    gr.addColorStop(0.5, 'rgba(255,255,255,0.15)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.beginPath();
    g.moveTo(c, 2);
    g.quadraticCurveTo(c + 3, c - 3, s - 2, c);
    g.quadraticCurveTo(c + 3, c + 3, c, s - 2);
    g.quadraticCurveTo(c - 3, c + 3, 2, c);
    g.quadraticCurveTo(c - 3, c - 3, c, 2);
    g.fill();
  }));
}

export function puffTexture(): THREE.Texture {
  return (puffTex ??= canvasTex(64, (g, s) => {
    const c = s / 2;
    const gr = g.createRadialGradient(c, c * 0.9, 0, c, c, c);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.6, 'rgba(255,255,255,0.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  }));
}

export function glowTexture(): THREE.Texture {
  return (glowTex ??= canvasTex(128, (g, s) => {
    const c = s / 2;
    const gr = g.createRadialGradient(c, c, 0, c, c, c);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.25, 'rgba(255,255,255,0.5)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  }));
}

export interface EmitOpts {
  speed?: number;
  life?: number;
  size?: number;
  gravity?: number;
  /** Extra upward velocity. */
  up?: number;
  /** Spread of the start position (m). */
  spread?: number;
  drag?: number;
  dir?: THREE.Vector3;
}

/** A pool of point sprites (one draw call). */
export class Particles {
  readonly points: THREE.Points;
  private cap: number;
  private pos: Float32Array;
  private col: Float32Array;
  private alpha: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private max: Float32Array;
  private base: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private next = 0;
  private live = 0;
  private mat: THREE.ShaderMaterial;

  constructor(cap: number, tex: THREE.Texture, additive: boolean) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.alpha = new Float32Array(cap);
    this.size = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap);
    this.base = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { map: { value: tex }, uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor; attribute float aAlpha; attribute float aSize;
        uniform float uScale;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vColor = aColor; vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
          if (gl_FragColor.a < 0.01) discard;
          #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  setViewportHeight(px: number, fovDeg: number): void {
    this.mat.uniforms.uScale.value = px / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  emit(at: THREE.Vector3, count: number, color: THREE.Color, o: EmitOpts = {}): void {
    const speed = o.speed ?? 3;
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.cap;
      const sp = o.spread ?? 0;
      this.pos[i * 3] = at.x + (Math.random() - 0.5) * sp;
      this.pos[i * 3 + 1] = at.y + (Math.random() - 0.5) * sp;
      this.pos[i * 3 + 2] = at.z + (Math.random() - 0.5) * sp;
      // Random direction on a sphere, biased by `dir`.
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      let vx = r * Math.cos(a);
      let vy = u;
      let vz = r * Math.sin(a);
      if (o.dir) {
        vx = vx * 0.5 + o.dir.x;
        vy = vy * 0.5 + o.dir.y;
        vz = vz * 0.5 + o.dir.z;
      }
      const k = speed * (0.4 + Math.random() * 0.6);
      this.vel[i * 3] = vx * k;
      this.vel[i * 3 + 1] = vy * k + (o.up ?? 0);
      this.vel[i * 3 + 2] = vz * k;
      const c = color;
      const tint = 0.85 + Math.random() * 0.3;
      this.col[i * 3] = c.r * tint;
      this.col[i * 3 + 1] = c.g * tint;
      this.col[i * 3 + 2] = c.b * tint;
      const life = (o.life ?? 0.7) * (0.6 + Math.random() * 0.6);
      this.life[i] = life;
      this.max[i] = life;
      this.base[i] = (o.size ?? 0.18) * (0.6 + Math.random() * 0.8);
      this.grav[i] = o.gravity ?? 6;
      this.drag[i] = o.drag ?? 1.5;
      this.live = Math.max(this.live, 1);
    }
  }

  update(dt: number): void {
    if (!this.live) return;
    let any = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) {
          this.alpha[i] = 0;
          this.size[i] = 0;
        }
        continue;
      }
      any++;
      this.life[i] -= dt;
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const k = Math.max(0, this.life[i] / this.max[i]);
      this.alpha[i] = Math.min(1, k * 2.2);
      this.size[i] = this.base[i] * (0.4 + 0.6 * Math.sqrt(k));
    }
    this.live = any;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }
}

/** Fluttering paper confetti for celebrations. */
export class Confetti {
  readonly mesh: THREE.InstancedMesh;
  private p: { pos: THREE.Vector3; vel: THREE.Vector3; rot: THREE.Euler; spin: THREE.Vector3; life: number }[] = [];
  private next = 0;
  private dummy = new THREE.Object3D();
  private static COLORS = ['#ff4f7b', '#ffd84d', '#4fd8ff', '#7cff6b', '#b46bff', '#ff9f43', '#ffffff'];

  constructor(private cap = 260) {
    const geo = new THREE.PlaneGeometry(0.14, 0.08);
    const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.frustumCulled = false;
    const c = new THREE.Color();
    for (let i = 0; i < cap; i++) {
      this.mesh.setColorAt(i, c.set(Confetti.COLORS[i % Confetti.COLORS.length]));
      this.p.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Euler(), spin: new THREE.Vector3(), life: 0 });
      this.dummy.scale.setScalar(0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
  }

  burst(at: THREE.Vector3, count: number, speed = 7, up = 6): void {
    for (let n = 0; n < count; n++) {
      const q = this.p[this.next];
      this.next = (this.next + 1) % this.cap;
      q.pos.copy(at);
      const a = Math.random() * Math.PI * 2;
      const k = speed * (0.3 + Math.random() * 0.7);
      q.vel.set(Math.cos(a) * k, up * (0.5 + Math.random() * 0.8), Math.sin(a) * k);
      q.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      q.spin.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14);
      q.life = 3 + Math.random() * 2;
    }
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < this.cap; i++) {
      const q = this.p[i];
      if (q.life <= 0) continue;
      any = true;
      q.life -= dt;
      q.vel.multiplyScalar(Math.exp(-1.8 * dt));
      q.vel.y -= 4 * dt;
      q.vel.x += Math.sin(q.life * 5 + i) * dt * 2;
      q.pos.addScaledVector(q.vel, dt);
      q.rot.x += q.spin.x * dt;
      q.rot.y += q.spin.y * dt;
      q.rot.z += q.spin.z * dt;
      this.dummy.position.copy(q.pos);
      this.dummy.rotation.copy(q.rot);
      this.dummy.scale.setScalar(q.life > 0 ? Math.min(1, q.life) : 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Expanding rings: landing dust, checkpoint waves, double-jump bursts. */
export class Rings {
  readonly group = new THREE.Group();
  private pool: { m: THREE.Mesh; t: number; life: number; scale: number; mat: THREE.MeshBasicMaterial }[] = [];
  private geo = new THREE.RingGeometry(0.82, 1, 40);

  spawn(at: THREE.Vector3, color: THREE.Color, scale: number, life: number, flat = true, opacity = 0.8): void {
    let r = this.pool.find((p) => p.t >= p.life);
    if (!r) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, blending: THREE.AdditiveBlending });
      const m = new THREE.Mesh(this.geo, mat);
      this.group.add(m);
      r = { m, t: 0, life: 1, scale: 1, mat };
      this.pool.push(r);
    }
    r.t = 0;
    r.life = life;
    r.scale = scale;
    r.mat.color.copy(color);
    r.mat.opacity = opacity;
    r.m.userData.op = opacity;
    r.m.position.copy(at);
    r.m.rotation.set(flat ? -Math.PI / 2 : 0, 0, 0);
    r.m.visible = true;
  }

  update(dt: number): void {
    for (const r of this.pool) {
      if (r.t >= r.life) {
        r.m.visible = false;
        continue;
      }
      r.t += dt;
      const k = Math.min(1, r.t / r.life);
      const e = 1 - Math.pow(1 - k, 3);
      r.m.scale.setScalar(0.2 + r.scale * e);
      r.mat.opacity = (r.m.userData.op as number) * (1 - k);
    }
  }
}
