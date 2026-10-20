/** Particles: glove impact sparks, kicked-up turf, confetti. One Points draw call per system. */
import * as THREE from 'three';
import { glowTexture } from './textures';

interface P {
  p: THREE.Vector3;
  v: THREE.Vector3;
  life: number;
  max: number;
  size: number;
  color: THREE.Color;
  grav: number;
  drag: number;
}

export class Particles {
  readonly points: THREE.Points;
  private list: P[] = [];
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Float32Array;
  private siz: Float32Array;
  private tex: THREE.Texture;

  constructor(
    private max: number,
    additive: boolean,
    square = false,
  ) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.siz = new Float32Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.siz, 1));
    this.tex = glowTexture(32);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: this.tex }, uScale: { value: 600 }, uSquare: { value: square ? 1 : 0 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: `attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vC;
        void main(){ vC = aColor; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D uTex; uniform float uSquare; varying vec4 vC;
        void main(){ float a = uSquare > 0.5 ? 1.0 : texture2D(uTex, gl_PointCoord).a; if (a * vC.a < 0.01) discard; gl_FragColor = vec4(vC.rgb, vC.a * a);
        #include <colorspace_fragment>
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }

  setViewportHeight(h: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = h * 0.9;
  }

  burst(at: THREE.Vector3, n: number, opts: { color: THREE.Color | (() => THREE.Color); speed: number; up?: number; dir?: THREE.Vector3; spread?: number; life?: number; size?: number; grav?: number; drag?: number; box?: THREE.Vector3 }): void {
    for (let i = 0; i < n; i++) {
      if (this.list.length >= this.max) this.list.shift();
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      if (opts.dir) d.multiplyScalar(opts.spread ?? 0.6).add(opts.dir).normalize();
      const v = d.multiplyScalar(opts.speed * (0.4 + Math.random() * 0.8));
      v.y += opts.up ?? 0;
      const p = at.clone();
      if (opts.box) p.add(new THREE.Vector3((Math.random() - 0.5) * opts.box.x, (Math.random() - 0.5) * opts.box.y, (Math.random() - 0.5) * opts.box.z));
      const life = (opts.life ?? 0.6) * (0.6 + Math.random() * 0.8);
      const c = typeof opts.color === 'function' ? opts.color() : opts.color;
      this.list.push({ p, v, life, max: life, size: (opts.size ?? 0.05) * (0.6 + Math.random() * 0.8), color: c.clone(), grav: opts.grav ?? 4, drag: opts.drag ?? 1.5 });
    }
  }

  update(dt: number): void {
    let j = 0;
    for (const q of this.list) {
      q.life -= dt;
      if (q.life <= 0) continue;
      q.v.y -= q.grav * dt;
      q.v.multiplyScalar(Math.max(0, 1 - q.drag * dt));
      q.p.addScaledVector(q.v, dt);
      if (q.p.y < 0.01) {
        q.p.y = 0.01;
        q.v.set(0, 0, 0);
      }
      this.list[j++] = q;
    }
    this.list.length = j;
    for (let i = 0; i < this.max; i++) {
      const q = this.list[i];
      if (!q) {
        this.siz[i] = 0;
        this.col[i * 4 + 3] = 0;
        continue;
      }
      this.pos[i * 3] = q.p.x;
      this.pos[i * 3 + 1] = q.p.y;
      this.pos[i * 3 + 2] = q.p.z;
      const k = q.life / q.max;
      this.col[i * 4] = q.color.r;
      this.col[i * 4 + 1] = q.color.g;
      this.col[i * 4 + 2] = q.color.b;
      this.col[i * 4 + 3] = Math.min(1, k * 2);
      this.siz[i] = q.size;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }

  clear(): void {
    this.list.length = 0;
  }

  dispose(): void {
    this.tex.dispose();
  }
}
