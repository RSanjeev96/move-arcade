/** Bats, balls, stumps with flying bails, bases: small props with their own materials. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ballTexture, willowTexture } from './textures';

/** Bat length from the top of the handle to the toe/end, and where the hands and sweet spot are. */
export const BAT = {
  cricket: { length: 0.86, hands: [0.05, 0.16], sweet: 0.66, handle: 0.3 },
  baseball: { length: 0.84, hands: [0.04, 0.13], sweet: 0.68, handle: 0.4 },
};

/** A bat whose local -y axis runs from the grip (origin) to the toe. */
export function makeCricketBat(): THREE.Group {
  const g = new THREE.Group();
  const B = BAT.cricket;
  const bladeL = B.length - B.handle;
  // Blade cross-section: flat face (+z), ridged back (-z).
  const w = 0.108;
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0.0);
  shape.lineTo(w / 2, 0.0);
  shape.lineTo(w / 2, -0.03);
  shape.quadraticCurveTo(w * 0.32, -0.058, 0, -0.062);
  shape.quadraticCurveTo(-w * 0.32, -0.058, -w / 2, -0.03);
  shape.closePath();
  const blade = new THREE.ExtrudeGeometry(shape, { depth: bladeL, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 2, curveSegments: 6 });
  // Extrude runs along +z: lay it along -y (shoulder at the top).
  blade.rotateX(Math.PI / 2);
  blade.translate(0, -B.handle, 0.03);
  // Planar UVs: u across, v along the blade.
  const pos = blade.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / w + 0.5;
    uv[i * 2 + 1] = 1 - (-pos.getY(i) - B.handle) / bladeL;
  }
  blade.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  blade.computeVertexNormals();
  const wood = new THREE.MeshStandardMaterial({ map: willowTexture(), roughness: 0.55, metalness: 0 });
  const bm = new THREE.Mesh(blade, wood);
  bm.castShadow = true;
  g.add(bm);
  // Handle with a rubber grip.
  const handle = new THREE.CylinderGeometry(0.016, 0.017, B.handle + 0.04, 12);
  handle.translate(0, -B.handle / 2 + 0.01, 0);
  const grip = new THREE.CylinderGeometry(0.0195, 0.0195, B.handle - 0.05, 12);
  grip.translate(0, -B.handle / 2 + 0.015, 0);
  const gm = new THREE.MeshStandardMaterial({ color: 0x1b1f3a, roughness: 0.9 });
  const hm = new THREE.Mesh(handle, new THREE.MeshStandardMaterial({ color: 0xc9a46a, roughness: 0.6 }));
  const grm = new THREE.Mesh(grip, gm);
  hm.castShadow = grm.castShadow = true;
  g.add(hm, grm);
  // Grip bands.
  for (let i = 0; i < 4; i++) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0205, 0.0205, 0.012, 12), new THREE.MeshStandardMaterial({ color: 0xffc93c, roughness: 0.8 }));
    band.position.y = -0.04 - i * 0.065;
    g.add(band);
  }
  return g;
}

export function makeBaseballBat(): THREE.Group {
  const g = new THREE.Group();
  const L = BAT.baseball.length;
  const prof: [number, number][] = [
    [0.0, 0],
    [0.028, 0.0],
    [0.03, 0.012],
    [0.014, 0.03],
    [0.0125, 0.12],
    [0.0135, 0.3],
    [0.02, 0.45],
    [0.03, 0.58],
    [0.0325, 0.7],
    [0.0325, 0.82],
    [0.026, L - 0.004],
    [0.0, L],
  ];
  const pts = prof.map(([r, y]) => new THREE.Vector2(r, -y));
  const geo = new THREE.LatheGeometry(pts, 20);
  const pos = geo.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const wood = new THREE.Color(0xd2a46e);
  const tape = new THREE.Color(0x15171c);
  for (let i = 0; i < pos.count; i++) {
    const y = -pos.getY(i);
    const c = y > 0.035 && y < 0.3 ? tape : wood;
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.05 }));
  m.castShadow = true;
  g.add(m);
  return g;
}

/** Ball mesh, drawn a little larger than life so it reads on a TV from across the room. */
export const BALL_VISUAL_SCALE = 2.1;

export function makeBall(sport: 'cricket' | 'baseball'): THREE.Mesh {
  const r = (sport === 'cricket' ? 0.036 : 0.0366) * BALL_VISUAL_SCALE;
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(r, 20, 14),
    new THREE.MeshStandardMaterial({ map: ballTexture(sport), roughness: 0.45, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0.12 }),
  );
  m.castShadow = true;
  return m;
}

// ---- stumps ---------------------------------------------------------------------------------------

interface Flyer {
  obj: THREE.Object3D;
  v: THREE.Vector3;
  w: THREE.Vector3;
  rest: THREE.Vector3;
  restQ: THREE.Quaternion;
  ground: number;
}

/** Three stumps and two bails; `shatter` sends them flying, `reset` puts them back. */
export class Stumps {
  readonly group = new THREE.Group();
  private parts: Flyer[] = [];
  private bailMat: THREE.MeshStandardMaterial;
  private flash = 0;
  broken = false;

  constructor(z: number) {
    this.group.position.set(0, 0, z);
    const stumpMat = new THREE.MeshStandardMaterial({ color: 0xf1ead8, roughness: 0.45 });
    const tipMat = new THREE.MeshStandardMaterial({ color: 0x1d2a6b, roughness: 0.5 });
    this.bailMat = new THREE.MeshStandardMaterial({ color: 0xf1ead8, roughness: 0.4, emissive: 0xff2a2a, emissiveIntensity: 0 });
    const stumpGeo = mergeGeometries([new THREE.CylinderGeometry(0.0175, 0.0175, 0.66, 10).translate(0, 0.33, 0), new THREE.ConeGeometry(0.0175, 0.05, 10).rotateX(Math.PI).translate(0, -0.025, 0)])!;
    for (const x of [-0.0855, 0, 0.0855]) {
      const s = new THREE.Group();
      const m = new THREE.Mesh(stumpGeo, stumpMat);
      m.castShadow = true;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0182, 0.0182, 0.12, 10), tipMat);
      band.position.y = 0.42;
      s.add(m, band);
      s.position.set(x, 0, 0);
      this.group.add(s);
      this.parts.push({ obj: s, v: new THREE.Vector3(), w: new THREE.Vector3(), rest: s.position.clone(), restQ: new THREE.Quaternion(), ground: 0 });
    }
    const bailGeo = new THREE.CapsuleGeometry(0.008, 0.09, 3, 8).rotateZ(Math.PI / 2);
    for (const x of [-0.043, 0.043]) {
      const b = new THREE.Mesh(bailGeo, this.bailMat);
      b.castShadow = true;
      b.position.set(x, 0.715, 0);
      this.group.add(b);
      this.parts.push({ obj: b, v: new THREE.Vector3(), w: new THREE.Vector3(), rest: b.position.clone(), restQ: new THREE.Quaternion(), ground: 0.01 });
    }
  }

  /** Ball struck the stumps at local x moving with velocity v (world). */
  shatter(hitX: number, v: THREE.Vector3): void {
    if (this.broken) return;
    this.broken = true;
    this.flash = 1;
    const push = Math.min(1, v.length() / 30);
    this.parts.forEach((p, i) => {
      const stump = i < 3;
      const near = stump ? Math.max(0, 1 - Math.abs(p.rest.x - hitX) / 0.12) : 1;
      p.v.set((p.rest.x - hitX) * 6 + (Math.random() - 0.5) * 1.5, stump ? 0.5 + near * 2 : 3.5 + Math.random() * 3.5, v.z * 0.12 * (0.3 + near) * push + (stump ? 1.5 * near : 2));
      p.w.set((Math.random() - 0.5) * (stump ? 4 : 30), (Math.random() - 0.5) * 6, (Math.random() - 0.5) * (stump ? 4 : 30));
      if (stump) p.w.x = 6 * near + 1;
    });
  }

  update(dt: number): void {
    this.flash = Math.max(0, this.flash - dt * 0.8);
    this.bailMat.emissiveIntensity = this.broken ? 2.5 * (0.5 + 0.5 * Math.sin(performance.now() / 60)) * this.flash + 0.6 * this.flash : 0;
    if (!this.broken) return;
    this.parts.forEach((p, i) => {
      const stump = i < 3;
      const o = p.obj;
      if (stump) {
        // Stumps pivot back about their base and come to rest on the ground.
        o.rotation.x = Math.min(1.45, o.rotation.x + p.w.x * dt * 0.6);
        o.position.z += p.v.z * dt * 0.25;
        p.v.z *= 0.9;
        return;
      }
      p.v.y -= 9.81 * dt;
      o.position.addScaledVector(p.v, dt);
      o.rotation.x += p.w.x * dt;
      o.rotation.z += p.w.z * dt;
      if (o.position.y < 0.01) {
        o.position.y = 0.01;
        p.v.y = Math.abs(p.v.y) * 0.3;
        p.v.x *= 0.6;
        p.v.z *= 0.6;
        p.w.multiplyScalar(0.6);
      }
    });
  }

  reset(): void {
    this.broken = false;
    this.flash = 0;
    for (const p of this.parts) {
      p.obj.position.copy(p.rest);
      p.obj.rotation.set(0, 0, 0);
      p.v.set(0, 0, 0);
    }
  }
}

/** Baseball bases, plate, rubber and chalk lines as flat meshes. */
export function makeDiamondMarks(): THREE.Group {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf6f6f2, roughness: 0.7 });
  const chalk = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.88, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const bases = [
    [19.4, -19.4],
    [0, -38.8],
    [-19.4, -19.4],
  ];
  for (const [x, z] of bases) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.08, 0.38), white);
    b.position.set(x, 0.04, z);
    b.rotation.y = Math.PI / 4;
    b.castShadow = true;
    g.add(b);
  }
  // Home plate: pentagon with the point at the back (z = 0).
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(0.216, -0.216);
  s.lineTo(0.216, -0.432);
  s.lineTo(-0.216, -0.432);
  s.lineTo(-0.216, -0.216);
  s.closePath();
  const plate = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, 0.02, 0), white);
  plate.receiveShadow = true;
  g.add(plate);
  const rubber = new THREE.Mesh(new THREE.BoxGeometry(0.61, 0.03, 0.15), white);
  rubber.position.set(0, 0.26, -18.44);
  g.add(rubber);
  const strip = (x0: number, z0: number, x1: number, z1: number, w = 0.075) => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const L = Math.hypot(dx, dz);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, L), chalk);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = -Math.atan2(dx, -dz);
    m.position.set((x0 + x1) / 2, 0.012, (z0 + z1) / 2);
    m.renderOrder = 1;
    g.add(m);
  };
  // Foul lines to the poles.
  const pole = 99;
  const d = pole / Math.SQRT2;
  strip(0.3, -0.3, d, -d, 0.1);
  strip(-0.3, -0.3, -d, -d, 0.1);
  // Batter's boxes (1.22 × 1.83 m), 15 cm from the plate.
  for (const sx of [-1, 1]) {
    const x0 = sx * 0.366;
    const x1 = sx * 1.586;
    const z0 = 0.7;
    const z1 = -1.13;
    strip(x0, z0, x1, z0);
    strip(x0, z1, x1, z1);
    strip(x0, z0, x0, z1);
    strip(x1, z0, x1, z1);
  }
  return g;
}
