/** Particles (dust, sparks, fireworks), the bat swing trail, ball streak and blob shadows. */
import * as THREE from 'three';
import { blobTexture, glowTexture } from './textures';

/** A pool of soft round particles drawn in one call. */
export class Particles {
  readonly points: THREE.Points;
  private n: number;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private max: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private base: Float32Array;
  private next = 0;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;

  constructor(capacity: number, additive: boolean) {
    this.n = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.max = new Float32Array(capacity).fill(1);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.base = new Float32Array(capacity);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: glowTexture() }, uScale: { value: 600 } },
      vertexShader: `
        attribute float aSize; attribute float aAlpha; attribute vec3 color;
        uniform float uScale; varying vec3 vCol; varying float vA;
        void main(){
          vCol = color; vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aAlpha > 0.0 ? aSize * uScale / max(0.5, -mv.z) : 0.0;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap; varying vec3 vCol; varying float vA;
        void main(){
          float a = texture2D(uMap, gl_PointCoord).a * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vCol, a);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: false,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  setViewport(h: number): void {
    this.mat.uniforms.uScale.value = h * 0.9;
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, color: THREE.Color, size: number, life: number, grav = 9.81, drag = 0.5): void {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.size[i] = size;
    this.base[i] = size;
    this.life[i] = life;
    this.max[i] = life;
    this.grav[i] = grav;
    this.drag[i] = drag;
    this.alpha[i] = 1;
  }

  burst(p: THREE.Vector3, count: number, speed: number, color: THREE.Color, size: number, life: number, opts: { up?: number; grav?: number; drag?: number; jitter?: number } = {}): void {
    const v = new THREE.Vector3();
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.35 + 0.65 * Math.random()));
      v.y += opts.up ?? 0;
      const j = opts.jitter ?? 0.1;
      c.copy(color).offsetHSL((Math.random() - 0.5) * j, 0, (Math.random() - 0.5) * j);
      this.emit(p, v, c, size * (0.6 + Math.random() * 0.8), life * (0.6 + Math.random() * 0.6), opts.grav ?? 9.81, opts.drag ?? 0.5);
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.max(0, this.life[i] / this.max[i]);
      const d = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= d;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(0.02, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = Math.min(1, k * 1.6);
      this.size[i] = this.base[i] * (1 + (1 - k) * 0.8);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.alpha.fill(0);
  }
}

/** A fading ribbon behind the bat while it moves fast. */
export class SwingTrail {
  readonly mesh: THREE.Mesh;
  private hist: { a: THREE.Vector3; b: THREE.Vector3; t: number }[] = [];
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private alpha: Float32Array;
  private static N = 18;

  constructor(
    color = 0xfff2c8,
    private life = 0.16,
    gain = 0.55,
  ) {
    const N = SwingTrail.N;
    this.pos = new Float32Array(N * 2 * 3);
    this.alpha = new Float32Array(N * 2);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    this.geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uGain: { value: gain } },
      vertexShader: `attribute float aAlpha; varying float vA; void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uGain; varying float vA; void main(){ gl_FragColor = vec4(uColor, vA * uGain); }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  push(a: THREE.Vector3, b: THREE.Vector3, t: number, speed: number): void {
    // A huge jump (a slow frame, a teleport) would draw a long false streak: start again.
    const last = this.hist[this.hist.length - 1];
    if (last && last.a.distanceTo(a) > 2.5) this.hist = [];
    if (speed < 3.5) {
      if (this.hist.length) this.hist.shift();
    } else this.hist.push({ a: a.clone(), b: b.clone(), t });
    while (this.hist.length > SwingTrail.N) this.hist.shift();
    while (this.hist.length && t - this.hist[0].t > this.life) this.hist.shift();
    const N = SwingTrail.N;
    for (let i = 0; i < N; i++) {
      const h = this.hist[Math.max(0, this.hist.length - N + i)];
      const k = this.hist.length ? 1 - (t - (h?.t ?? t)) / this.life : 0;
      const valid = !!h && i >= N - this.hist.length;
      const p0 = valid ? h.a : new THREE.Vector3();
      const p1 = valid ? h.b : new THREE.Vector3();
      this.pos.set([p0.x, p0.y, p0.z], i * 6);
      this.pos.set([p1.x, p1.y, p1.z], i * 6 + 3);
      const al = valid ? Math.max(0, k) * (i / N) : 0;
      this.alpha[i * 2] = al * 0.3;
      this.alpha[i * 2 + 1] = al;
    }
    this.geo.attributes.position.needsUpdate = true;
    (this.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.hist = [];
    this.alpha.fill(0);
    (this.geo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Blob shadows under players and the ball (one instanced draw). */
export class Blobs {
  readonly mesh: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
  private count = 0;

  constructor(max: number) {
    const mat = new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -4 });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.count = 0;
  }

  begin(): void {
    this.count = 0;
  }

  add(x: number, z: number, size: number, y = 0.015): void {
    if (this.count >= this.mesh.instanceMatrix.count) return;
    this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(size, size, size));
    this.mesh.setMatrixAt(this.count++, this.m);
  }

  end(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Fireworks shells launched from the stadium rim. */
export class Fireworks {
  private shells: { p: THREE.Vector3; v: THREE.Vector3; fuse: number; color: THREE.Color }[] = [];
  constructor(private sparks: Particles) {}

  launch(from: THREE.Vector3, to: THREE.Vector3, delay = 0): void {
    const v = to.clone().sub(from);
    const T = 1.6;
    v.divideScalar(T);
    v.y += 0.5 * 9.81 * T * 0.7;
    const color = new THREE.Color().setHSL(Math.random(), 0.9, 0.62);
    this.shells.push({ p: from.clone(), v, fuse: T + delay, color });
  }

  update(dt: number): void {
    for (const s of this.shells) {
      s.fuse -= dt;
      if (s.fuse > 1.6) continue;
      s.v.y -= 9.81 * 0.7 * dt;
      s.p.addScaledVector(s.v, dt);
      this.sparks.emit(s.p, new THREE.Vector3(0, -1, 0), new THREE.Color(1, 0.8, 0.5), 0.6, 0.35, 0, 1);
      if (s.fuse <= 0) {
        this.sparks.burst(s.p, 70, 16, s.color, 1.5, 1.6, { grav: 3, drag: 1.4, jitter: 0.08 });
        this.sparks.burst(s.p, 20, 8, new THREE.Color(1, 1, 0.9), 1.1, 1.0, { grav: 3, drag: 1.6 });
      }
    }
    this.shells = this.shells.filter((s) => s.fuse > 0);
  }

  get active(): boolean {
    return this.shells.length > 0;
  }

  clear(): void {
    this.shells = [];
  }
}
