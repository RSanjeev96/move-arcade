import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PALETTE } from './scene';
import { Dir, DIR_VEC } from './mapgen';

const handColor = (hand: 0 | 1) => (hand === 0 ? PALETTE.left : PALETTE.right);

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let sharedGlow: THREE.Texture | null = null;
export function glow(): THREE.Texture {
  return (sharedGlow ??= glowTexture());
}

/** Rotation (about z) that turns the down-pointing arrow model to point along `dir`. */
export function dirAngle(dir: Dir): number {
  if (dir === Dir.Any) return 0;
  const [x, y] = DIR_VEC[dir];
  return Math.atan2(y, x) + Math.PI / 2;
}

// ---- blocks ------------------------------------------------------------------

export interface BlockParts {
  group: THREE.Group;
  body: THREE.Mesh;
  mark: THREE.Mesh;
  edges: THREE.LineSegments;
  halo: THREE.Sprite;
}

export class BlockKit {
  readonly bodyGeo = new RoundedBoxGeometry(0.46, 0.46, 0.46, 4, 0.07);
  readonly arrowGeo: THREE.ShapeGeometry;
  readonly dotGeo = new THREE.CircleGeometry(0.085, 28);
  readonly edgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(0.49, 0.49, 0.49));
  readonly bodyMat: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  readonly edgeMat: [THREE.LineBasicMaterial, THREE.LineBasicMaterial];
  readonly markMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  readonly haloMat: [THREE.SpriteMaterial, THREE.SpriteMaterial];
  private pool: [BlockParts[], BlockParts[]] = [[], []];

  constructor() {
    const s = new THREE.Shape();
    s.moveTo(-0.17, 0.05);
    s.lineTo(0.17, 0.05);
    s.lineTo(0, -0.13);
    s.lineTo(-0.17, 0.05);
    this.arrowGeo = new THREE.ShapeGeometry(s);
    const mk = (hand: 0 | 1) =>
      new THREE.MeshStandardMaterial({
        color: handColor(hand).clone().multiplyScalar(0.85),
        emissive: handColor(hand).clone().multiplyScalar(0.28),
        metalness: 0.35,
        roughness: 0.28,
      });
    this.bodyMat = [mk(0), mk(1)];
    this.edgeMat = [0, 1].map((h) => new THREE.LineBasicMaterial({ color: handColor(h as 0 | 1).clone().multiplyScalar(1.6), toneMapped: false })) as [
      THREE.LineBasicMaterial,
      THREE.LineBasicMaterial,
    ];
    this.haloMat = [0, 1].map(
      (h) =>
        new THREE.SpriteMaterial({
          map: glow(),
          color: handColor(h as 0 | 1),
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
    ) as [THREE.SpriteMaterial, THREE.SpriteMaterial];
  }

  take(hand: 0 | 1, dir: Dir): BlockParts {
    const parts = this.pool[hand].pop() ?? this.build(hand);
    parts.mark.geometry = dir === Dir.Any ? this.dotGeo : this.arrowGeo;
    parts.mark.position.set(0, 0, 0.235);
    parts.group.visible = true;
    parts.group.rotation.set(0, 0, 0);
    parts.group.scale.setScalar(1);
    return parts;
  }

  give(hand: 0 | 1, parts: BlockParts): void {
    parts.group.visible = false;
    parts.group.removeFromParent();
    this.pool[hand].push(parts);
  }

  private build(hand: 0 | 1): BlockParts {
    const group = new THREE.Group();
    const body = new THREE.Mesh(this.bodyGeo, this.bodyMat[hand]);
    const mark = new THREE.Mesh(this.arrowGeo, this.markMat);
    const edges = new THREE.LineSegments(this.edgeGeo, this.edgeMat[hand]);
    const halo = new THREE.Sprite(this.haloMat[hand]);
    halo.scale.setScalar(1.25);
    halo.position.z = -0.25;
    group.add(halo, body, mark, edges);
    return { group, body, mark, edges, halo };
  }
}

// ---- debris (the two halves of a cut block) ---------------------------------------

interface Piece {
  group: THREE.Group;
  mats: THREE.Material[];
  plane: THREE.Plane;
  normal: THREE.Vector3;
  origin: THREE.Vector3;
  vel: THREE.Vector3;
  spin: number;
  angle: number;
  baseQuat: THREE.Quaternion;
  life: number;
  sign: number;
  sep: number;
  mark: THREE.Mesh;
  body: THREE.Mesh;
  edges: THREE.LineSegments;
}

export class Debris {
  readonly group = new THREE.Group();
  private free: Piece[] = [];
  private live: Piece[] = [];

  constructor(private kit: BlockKit) {}

  private make(): Piece {
    const plane = new THREE.Plane();
    const bodyMat = this.kit.bodyMat[0].clone();
    bodyMat.clippingPlanes = [plane];
    bodyMat.clipShadows = false;
    bodyMat.side = THREE.DoubleSide;
    const markMat = this.kit.markMat.clone();
    markMat.clippingPlanes = [plane];
    const edgeMat = this.kit.edgeMat[0].clone();
    edgeMat.clippingPlanes = [plane];
    const group = new THREE.Group();
    const body = new THREE.Mesh(this.kit.bodyGeo, bodyMat);
    const mark = new THREE.Mesh(this.kit.arrowGeo, markMat);
    mark.position.z = 0.235;
    const edges = new THREE.LineSegments(this.kit.edgeGeo, edgeMat);
    group.add(body, mark, edges);
    return {
      group,
      mats: [bodyMat, markMat, edgeMat],
      plane,
      normal: new THREE.Vector3(),
      origin: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      spin: 0,
      angle: 0,
      baseQuat: new THREE.Quaternion(),
      life: 0,
      sign: 1,
      sep: 0,
      mark,
      body,
      edges,
    };
  }

  /** Split a block along the swing direction (sx, sy) at world position `at`. */
  spawn(at: THREE.Vector3, blockQuat: THREE.Quaternion, hand: 0 | 1, dir: Dir, sx: number, sy: number, speed: number): void {
    const len = Math.hypot(sx, sy) || 1;
    const n = new THREE.Vector3(-sy / len, sx / len, 0);
    for (const sign of [1, -1]) {
      const p = this.free.pop() ?? this.make();
      const [bodyMat, , edgeMat] = p.mats as [THREE.MeshStandardMaterial, THREE.MeshBasicMaterial, THREE.LineBasicMaterial];
      bodyMat.color.copy(this.kit.bodyMat[hand].color);
      bodyMat.emissive.copy(this.kit.bodyMat[hand].emissive).multiplyScalar(1.3);
      edgeMat.color.copy(this.kit.edgeMat[hand].color);
      p.mark.geometry = dir === Dir.Any ? this.kit.dotGeo : this.kit.arrowGeo;
      p.normal.copy(n).multiplyScalar(sign);
      p.origin.copy(at);
      p.baseQuat.copy(blockQuat);
      const push = 1.2 + speed * 0.25;
      p.vel.set(n.x * sign * push + (sx / len) * 0.8, n.y * sign * push + (sy / len) * 0.8 + 0.6, -2.5 - Math.random());
      p.spin = (Math.random() * 6 + 4) * sign;
      p.angle = 0;
      p.life = 0;
      p.sign = sign;
      p.sep = 0;
      p.group.visible = true;
      this.group.add(p.group);
      this.live.push(p);
    }
  }

  update(dt: number): void {
    const q = new THREE.Quaternion();
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.life += dt;
      p.vel.y -= 9 * dt;
      p.origin.addScaledVector(p.vel, dt);
      p.angle += p.spin * dt;
      // Spin about the cut normal so the cut face stays flat against its clipping plane.
      q.setFromAxisAngle(p.normal, p.angle);
      p.group.quaternion.copy(q).multiply(p.baseQuat);
      p.group.position.copy(p.origin);
      p.plane.setFromNormalAndCoplanarPoint(p.normal, p.origin);
      const fade = Math.max(0, 1 - p.life / 0.65);
      for (const m of p.mats) {
        m.transparent = fade < 1;
        m.opacity = fade;
      }
      if (p.life > 0.65) {
        p.group.visible = false;
        p.group.removeFromParent();
        this.live.splice(i, 1);
        this.free.push(p);
      }
    }
  }
}

// ---- particles ------------------------------------------------------------------

export class Sparks {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private alpha: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private next = 0;

  constructor(private n = 900) {
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.alpha = new Float32Array(n);
    this.size = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n).fill(1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uMap: { value: glow() }, uScale: { value: 600 } },
      vertexShader: `
        attribute vec3 color; attribute float alpha; attribute float size;
        varying vec3 vCol; varying float vA; uniform float uScale;
        void main(){ vCol = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = size * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        uniform sampler2D uMap; varying vec3 vCol; varying float vA;
        void main(){ vec4 t = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(vCol * 1.8, t.a * vA); }`,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
  }

  setViewportHeight(h: number): void {
    (this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = h * 0.9;
  }

  burst(at: THREE.Vector3, color: THREE.Color, count: number, speed: number, dirX = 0, dirY = 0, life = 0.6, size = 0.06): void {
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.n;
      this.pos[i * 3] = at.x;
      this.pos[i * 3 + 1] = at.y;
      this.pos[i * 3 + 2] = at.z;
      const a = Math.random() * Math.PI * 2;
      const b = Math.acos(Math.random() * 2 - 1);
      const s = speed * (0.35 + Math.random() * 0.9);
      this.vel[i * 3] = Math.sin(b) * Math.cos(a) * s + dirX * speed * 0.8;
      this.vel[i * 3 + 1] = Math.sin(b) * Math.sin(a) * s + dirY * speed * 0.8;
      this.vel[i * 3 + 2] = Math.cos(b) * s * 0.6 - 1.5;
      const tint = 0.75 + Math.random() * 0.25;
      this.col[i * 3] = Math.min(1, color.r * tint + 0.15);
      this.col[i * 3 + 1] = Math.min(1, color.g * tint + 0.15);
      this.col[i * 3 + 2] = Math.min(1, color.b * tint + 0.15);
      this.life[i] = 0;
      this.maxLife[i] = life * (0.6 + Math.random() * 0.8);
      this.size[i] = size * (0.6 + Math.random() * 0.9);
      this.alpha[i] = 1;
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      if (this.alpha[i] <= 0) continue;
      this.life[i] += dt;
      const k = this.life[i] / this.maxLife[i];
      if (k >= 1) {
        this.alpha[i] = 0;
        continue;
      }
      this.vel[i * 3 + 1] -= 4 * dt;
      const drag = Math.pow(0.12, dt);
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 1] *= drag;
      this.vel[i * 3 + 2] *= drag;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.alpha[i] = 1 - k * k;
    }
    const g = this.points.geometry;
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.size as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Expanding ring flashes at cut points. */
export class Shockwaves {
  readonly group = new THREE.Group();
  private items: { mesh: THREE.Mesh; life: number }[] = [];
  private geo = new THREE.RingGeometry(0.15, 0.2, 48);

  spawn(at: THREE.Vector3, color: THREE.Color): void {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const mesh = new THREE.Mesh(this.geo, m);
    mesh.position.copy(at);
    this.group.add(mesh);
    this.items.push({ mesh, life: 0 });
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life += dt;
      const k = it.life / 0.3;
      it.mesh.scale.setScalar(1 + k * 2.2);
      (it.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.7 * (1 - k));
      if (k >= 1) {
        it.mesh.removeFromParent();
        (it.mesh.material as THREE.Material).dispose();
        this.items.splice(i, 1);
      }
    }
  }
}

// ---- bombs ----------------------------------------------------------------------

function spikyGeometry(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(0.15, 0).toNonIndexed();
  const p = ico.attributes.position;
  const out: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i);
    b.fromBufferAttribute(p, i + 1);
    c.fromBufferAttribute(p, i + 2);
    const apex = a.clone().add(b).add(c).divideScalar(3).multiplyScalar(1.85);
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) out.push(u.x, u.y, u.z, v.x, v.y, v.z, apex.x, apex.y, apex.z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}

export class BombKit {
  readonly geo = spikyGeometry();
  readonly mat = new THREE.MeshStandardMaterial({ color: 0x22202a, emissive: 0x550010, metalness: 0.85, roughness: 0.25, flatShading: true });
  readonly haloMat = new THREE.SpriteMaterial({ map: glow(), color: 0xff1030, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false });
  private pool: THREE.Group[] = [];

  take(): THREE.Group {
    const g = this.pool.pop();
    if (g) {
      g.visible = true;
      return g;
    }
    const group = new THREE.Group();
    const halo = new THREE.Sprite(this.haloMat);
    halo.scale.setScalar(0.9);
    group.add(new THREE.Mesh(this.geo, this.mat), halo);
    return group;
  }

  give(g: THREE.Group): void {
    g.visible = false;
    g.removeFromParent();
    this.pool.push(g);
  }

  pulse(t: number): void {
    this.mat.emissive.setRGB(0.35 + 0.25 * Math.sin(t * 10), 0, 0.05);
  }
}

// ---- walls ----------------------------------------------------------------------

export function makeWall(kind: 'left' | 'right' | 'top', depth: number): THREE.Group {
  const g = new THREE.Group();
  let w: number;
  let h: number;
  let x: number;
  let y: number;
  if (kind === 'top') {
    w = 3.6;
    h = 1.6;
    x = 0;
    y = 1.25 + h / 2;
  } else {
    w = 1.55;
    h = 3.0;
    x = kind === 'left' ? -0.12 - w / 2 : 0.12 + w / 2;
    y = h / 2;
  }
  const geo = new THREE.BoxGeometry(w, h, depth);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying vec3 vP; uniform float uTime;
      void main(){
        float stripe = 0.5 + 0.5*sin((vP.y*10.0 + vP.z*3.0) - uTime*6.0);
        vec3 c = mix(vec3(1.0,0.12,0.4), vec3(1.0,0.4,0.8), stripe);
        gl_FragColor = vec4(c, 0.16 + 0.1*stripe);
      }`,
  });
  const box = new THREE.Mesh(geo, mat);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: new THREE.Color('#ff3d8b').multiplyScalar(2), toneMapped: false }),
  );
  g.add(box, edges);
  g.position.set(x, y, 0);
  g.userData.mat = mat;
  return g;
}

// ---- sabers -----------------------------------------------------------------------

export class Saber {
  readonly group = new THREE.Group();
  private blade = new THREE.Group();
  private hilt: THREE.Mesh;
  private trail: THREE.Mesh;
  private trailPos: Float32Array;
  private trailAlpha: Float32Array;
  private history: THREE.Vector3[] = [];
  private readonly segs = 14;
  readonly light: THREE.PointLight;
  readonly base = new THREE.Vector3();
  readonly tip = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(readonly hand: 0 | 1, readonly length = 1.05) {
    const color = handColor(hand);
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.011, 0.011, length, 10, 1, false),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    );
    const glowMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.03, length, 14, 1, true),
      new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(1.4), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    const outer = new THREE.Mesh(
      new THREE.CylinderGeometry(0.085, 0.06, length * 1.02, 14, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.blade.add(core, glowMesh, outer);
    this.hilt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.034, 0.24, 16),
      new THREE.MeshStandardMaterial({ color: 0x2a2c35, metalness: 0.9, roughness: 0.3, emissive: color.clone().multiplyScalar(0.15) }),
    );
    this.light = new THREE.PointLight(color, 2.2, 3.5, 2);
    this.group.add(this.blade, this.hilt, this.light);

    this.trailPos = new Float32Array(this.segs * 2 * 3);
    this.trailAlpha = new Float32Array(this.segs * 2);
    const idx: number[] = [];
    for (let i = 0; i < this.segs - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    tg.setAttribute('alpha', new THREE.BufferAttribute(this.trailAlpha, 1));
    tg.setIndex(idx);
    const tm = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: color.clone() } },
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor*1.5, vA*0.5); }`,
    });
    this.trail = new THREE.Mesh(tg, tm);
    this.trail.frustumCulled = false;
  }

  get trailMesh(): THREE.Mesh {
    return this.trail;
  }

  /** Place the saber with its hilt at `base`, pointing toward `toward`. */
  update(base: THREE.Vector3, toward: THREE.Vector3, visible: boolean): void {
    this.group.visible = visible;
    this.base.copy(base);
    const dir = toward.clone().sub(base).normalize();
    this.tip.copy(base).addScaledVector(dir, this.length);
    const q = new THREE.Quaternion().setFromUnitVectors(this.up, dir);
    this.blade.quaternion.copy(q);
    this.blade.position.copy(dir).multiplyScalar(this.length / 2 + 0.1);
    this.hilt.quaternion.copy(q);
    this.hilt.position.copy(dir).multiplyScalar(-0.02);
    this.light.position.copy(dir).multiplyScalar(0.5);
    this.group.position.copy(base);

    const mid = base.clone().addScaledVector(dir, 0.25);
    this.history.unshift(mid, this.tip.clone());
    if (this.history.length > this.segs * 2) this.history.length = this.segs * 2;
    for (let i = 0; i < this.segs; i++) {
      const a = this.history[Math.min(i * 2, this.history.length - 2)];
      const b = this.history[Math.min(i * 2 + 1, this.history.length - 1)];
      this.trailPos.set([a.x, a.y, a.z], i * 6);
      this.trailPos.set([b.x, b.y, b.z], i * 6 + 3);
      const k = visible ? 1 - i / (this.segs - 1) : 0;
      this.trailAlpha[i * 2] = 0;
      this.trailAlpha[i * 2 + 1] = k * k;
    }
    (this.trail.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.trail.geometry.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
  }
}
