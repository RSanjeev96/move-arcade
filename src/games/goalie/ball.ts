/** The match ball: textured sphere with spin, a speed trail and a contact shadow, plus simple free physics. */
import * as THREE from 'three';
import { BALL_R, GOAL } from './logic';
import { ballTextures, glowTexture } from './textures';

const TRAIL = 22;

export class Ball {
  readonly group = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly pos = new THREE.Vector3(0, BALL_R, -11);
  readonly vel = new THREE.Vector3();
  /** Angular velocity (rad/s). */
  readonly spin = new THREE.Vector3();
  private trail: THREE.Mesh;
  private trailPts: THREE.Vector3[] = [];
  private trailGeo: THREE.BufferGeometry;
  private trailMat: THREE.ShaderMaterial;
  private blob: THREE.Mesh;
  private textures: THREE.Texture[] = [];
  /** Free physics (after saves, posts and goals). */
  free = false;
  /** Inside the goal: collide with the net. */
  inGoal = false;
  /** Net contact this frame, for the bulge: local point and depth. */
  netPress: { p: THREE.Vector3; depth: number } | null = null;
  onBounce: (speed: number) => void = () => {};
  onNet: (p: THREE.Vector3, speed: number) => void = () => {};
  trailStrength = 0;
  /** 0..1 grow-in after the ball is placed. */
  private appear = 1;

  constructor() {
    const { map, bump } = ballTextures();
    this.textures.push(map, bump);
    const mat = new THREE.MeshPhysicalMaterial({ map, bumpMap: bump, bumpScale: 1.2, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.25 });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 40, 28), mat);
    this.mesh.castShadow = true;
    this.group.add(this.mesh);

    // Contact shadow: a soft dark disc that fades with height.
    const glow = glowTexture(64);
    this.textures.push(glow);
    this.blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: glow, color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = 1;
    this.group.add(this.blob);

    // Trail ribbon (camera facing), additive.
    this.trailGeo = new THREE.BufferGeometry();
    const n = TRAIL * 2;
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.trailGeo.setAttribute('aK', new THREE.BufferAttribute(new Float32Array(n), 1));
    const idx: number[] = [];
    for (let i = 0; i < TRAIL - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    this.trailGeo.setIndex(idx);
    const k = this.trailGeo.getAttribute('aK') as THREE.BufferAttribute;
    for (let i = 0; i < TRAIL; i++) {
      k.setX(i * 2, i / (TRAIL - 1));
      k.setX(i * 2 + 1, i / (TRAIL - 1));
    }
    this.trailMat = new THREE.ShaderMaterial({
      uniforms: { uStrength: { value: 0 }, uColor: { value: new THREE.Color(0.85, 0.92, 1) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: `attribute float aK; varying float vK; void main(){ vK = aK; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uStrength; uniform vec3 uColor; varying float vK; void main(){ float a = pow(vK, 1.6) * uStrength; gl_FragColor = vec4(uColor * a, a); }`,
    });
    this.trail = new THREE.Mesh(this.trailGeo, this.trailMat);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 3;
    this.group.add(this.trail);
    this.resetTrail();
  }

  resetTrail(): void {
    this.trailPts = [];
    for (let i = 0; i < TRAIL; i++) this.trailPts.push(this.pos.clone());
  }

  place(p: THREE.Vector3 | { x: number; y: number; z: number }): void {
    this.pos.set(p.x, p.y, p.z);
    this.vel.set(0, 0, 0);
    this.spin.set(0, 0, 0);
    this.free = false;
    this.inGoal = false;
    this.appear = 0;
    this.resetTrail();
  }

  /** Integrate free flight (gravity, drag, ground bounces, goal net) for dt seconds. */
  physics(dt: number): void {
    if (!this.free) return;
    const steps = Math.max(1, Math.ceil(dt / 0.008));
    const h = dt / steps;
    this.netPress = null;
    for (let s = 0; s < steps; s++) {
      this.vel.y -= 9.81 * h;
      this.vel.multiplyScalar(1 - 0.08 * h);
      this.pos.addScaledVector(this.vel, h);
      if (this.pos.y < BALL_R) {
        this.pos.y = BALL_R;
        if (this.vel.y < -0.6) this.onBounce(-this.vel.y);
        this.vel.y = -this.vel.y * 0.52;
        this.vel.x *= 0.85;
        this.vel.z *= 0.85;
        if (Math.abs(this.vel.y) < 0.4) this.vel.y = 0;
        // Rolling friction.
        this.vel.x *= 1 - 1.2 * h;
        this.vel.z *= 1 - 1.2 * h;
      }
      if (this.inGoal) this.collideNet();
    }
  }

  /** Keep the ball inside the goal: soft net planes that slow it hard. */
  private collideNet(): void {
    const W = GOAL.halfW;
    const H = GOAL.h;
    const D = GOAL.depth;
    const T = GOAL.topDepth;
    const p = this.pos;
    const v = this.vel;
    // Back net: the plane through (z=T,y=H) and (z=D,y=0).
    const backZ = T + (D - T) * (1 - Math.min(1, Math.max(0, p.y / H)));
    const pen = p.z + BALL_R - backZ;
    if (pen > 0) {
      const depth = Math.min(0.45, pen);
      this.netPress = { p: new THREE.Vector3(p.x, p.y, backZ), depth };
      if (v.z > 0) {
        if (v.z > 2) this.onNet(this.netPress.p, v.z);
        // The net gives: absorb most of the speed, push back gently.
        v.z = -v.z * 0.12;
        v.x *= 0.5;
        v.y *= 0.5;
      }
      if (pen > 0.45) p.z = backZ - BALL_R + 0.45;
      v.z -= pen * 6 * 0.008 * 30;
    }
    if (p.y + BALL_R > H && p.z < T + 0.05 && p.z > 0) {
      p.y = H - BALL_R;
      if (v.y > 0) v.y = -v.y * 0.2;
    }
    for (const s of [-1, 1]) {
      if (s * p.x + BALL_R > W && p.z > 0) {
        p.x = s * (W - BALL_R);
        if (s * v.x > 0) {
          if (Math.abs(v.x) > 2) this.onNet(new THREE.Vector3(p.x, p.y, p.z), Math.abs(v.x));
          v.x = -v.x * 0.15;
        }
      }
    }
    if (p.z < 0.05 && v.z < 0) {
      // Rolling back out over the line: stop it in the mouth of the goal.
      v.z *= -0.2;
    }
  }

  /** Update visuals: spin, trail, shadow. `camPos` for the camera-facing trail. */
  visuals(dt: number, camPos: THREE.Vector3): void {
    this.mesh.position.copy(this.pos);
    if (this.appear < 1) {
      this.appear = Math.min(1, this.appear + dt * 4);
      const k = this.appear;
      this.mesh.scale.setScalar(Math.max(0.001, 1 - Math.pow(1 - k, 3)));
    }
    const w = this.spin.length();
    if (w > 1e-3) {
      const q = new THREE.Quaternion().setFromAxisAngle(this.spin.clone().divideScalar(w), w * dt);
      this.mesh.quaternion.premultiply(q);
    }
    const h = Math.max(0, this.pos.y - BALL_R);
    const s = 0.34 + h * 0.25;
    this.blob.position.set(this.pos.x, 0.012, this.pos.z);
    this.blob.scale.set(s, s, s);
    (this.blob.material as THREE.MeshBasicMaterial).opacity = 0.5 / (1 + h * 1.4);

    // Trail.
    this.trailPts.pop();
    this.trailPts.unshift(this.pos.clone());
    const speed = this.vel.length();
    this.trailMat.uniforms.uStrength.value += (Math.min(0.55, Math.max(0, (speed - 8) / 30)) * this.trailStrength - this.trailMat.uniforms.uStrength.value) * Math.min(1, dt * 12);
    const attr = this.trailGeo.getAttribute('position') as THREE.BufferAttribute;
    const pts = this.trailPts;
    const side = new THREE.Vector3();
    const toCam = new THREE.Vector3();
    for (let i = 0; i < TRAIL; i++) {
      const p = pts[i];
      const next = pts[Math.min(TRAIL - 1, i + 1)];
      const prev = pts[Math.max(0, i - 1)];
      const dir = prev.clone().sub(next);
      toCam.copy(camPos).sub(p);
      side.crossVectors(dir, toCam).normalize();
      const width = BALL_R * 0.9 * (1 - i / TRAIL);
      // Oldest points first in the strip so aK (0 tail → 1 head) matches.
      const j = TRAIL - 1 - i;
      attr.setXYZ(j * 2, p.x + side.x * width, p.y + side.y * width, p.z + side.z * width);
      attr.setXYZ(j * 2 + 1, p.x - side.x * width, p.y - side.y * width, p.z - side.z * width);
    }
    attr.needsUpdate = true;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  dispose(): void {
    this.textures.forEach((t) => t.dispose());
  }
}
