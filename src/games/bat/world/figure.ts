/**
 * Procedural player figures: a rigidly skinned humanoid (one draw call per figure, parts merged into a single
 * SkinnedMesh with vertex colours) plus pose functions for running, bowling, pitching, throwing, catching,
 * signalling and an arm IK used to hold the bat.
 *
 * Model space: the figure stands on y = 0 facing +z; its left side is +x.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export type BoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'armL'
  | 'foreL'
  | 'handL'
  | 'armR'
  | 'foreR'
  | 'handR'
  | 'thighL'
  | 'shinL'
  | 'footL'
  | 'thighR'
  | 'shinR'
  | 'footR';

type J = { parent: BoneName | null; pos: [number, number, number] };

const JOINTS: Record<BoneName, J> = {
  hips: { parent: null, pos: [0, 0.98, 0] },
  spine: { parent: 'hips', pos: [0, 1.07, 0] },
  chest: { parent: 'spine', pos: [0, 1.27, 0] },
  neck: { parent: 'chest', pos: [0, 1.5, 0] },
  head: { parent: 'neck', pos: [0, 1.6, 0.0] },
  armL: { parent: 'chest', pos: [0.195, 1.445, 0] },
  foreL: { parent: 'armL', pos: [0.215, 1.155, 0] },
  handL: { parent: 'foreL', pos: [0.225, 0.905, 0.01] },
  armR: { parent: 'chest', pos: [-0.195, 1.445, 0] },
  foreR: { parent: 'armR', pos: [-0.215, 1.155, 0] },
  handR: { parent: 'foreR', pos: [-0.225, 0.905, 0.01] },
  thighL: { parent: 'hips', pos: [0.095, 0.94, 0] },
  shinL: { parent: 'thighL', pos: [0.1, 0.505, 0.0] },
  footL: { parent: 'shinL', pos: [0.1, 0.085, -0.015] },
  thighR: { parent: 'hips', pos: [-0.095, 0.94, 0] },
  shinR: { parent: 'thighR', pos: [-0.1, 0.505, 0.0] },
  footR: { parent: 'shinR', pos: [-0.1, 0.085, -0.015] },
};

const ORDER = Object.keys(JOINTS) as BoneName[];

export interface Kit {
  skin: number;
  shirt: number;
  trim: number;
  pants: number;
  shoes: number;
  head: 'cap' | 'helmet' | 'bbhelmet' | 'umpire' | 'bare' | 'keeperCap' | 'catcher';
  headColor: number;
  hair?: number;
  pads?: number;
  gloves?: number;
  longSleeves?: boolean;
  socks?: number;
  /** Overall scale (height ≈ 1.8 m × build). */
  build?: number;
  belly?: number;
  /** Name and number printed on the back of the shirt (separate decal, one extra draw call). */
  back?: { name: string; number: string };
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const jp = (b: BoneName) => V(...JOINTS[b].pos);

interface Part {
  geo: THREE.BufferGeometry;
  gloss: boolean;
}

/** Colour, bone and gloss for one part; geometry already positioned in model space. */
function prep(geo: THREE.BufferGeometry, color: number, bone: number): THREE.BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  if (g.getAttribute('uv1')) g.deleteAttribute('uv1');
  const n = g.getAttribute('position').count;
  const c = new THREE.Color(color);
  const col = new Float32Array(n * 3);
  const si = new Uint16Array(n * 4);
  const sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
    si[i * 4] = bone;
    sw[i * 4] = 1;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  if (g !== geo) geo.dispose();
  return g;
}

/** Capsule from a to b. */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1 = r0, seg = 10): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const L = d.length();
  // Tapered capsule: a lathe profile with rounded ends.
  const pts: THREE.Vector2[] = [];
  const caps = 4;
  for (let i = 0; i <= caps; i++) {
    const t = (i / caps) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.sin(t) * r0, -Math.cos(t) * r0));
  }
  for (let i = 0; i <= caps; i++) {
    const t = (i / caps) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.cos(t) * r1, L + Math.sin(t) * r1));
  }
  const g = new THREE.LatheGeometry(pts, seg);
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  return g;
}

function ellipsoid(c: THREE.Vector3, rx: number, ry: number, rz: number, ws = 14, hs = 10): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, ws, hs);
  g.scale(rx, ry, rz);
  g.translate(c.x, c.y, c.z);
  return g;
}

function rbox(c: THREE.Vector3, sx: number, sy: number, sz: number, r = 0.02): THREE.BufferGeometry {
  const g = new RoundedBoxGeometry(sx, sy, sz, 2, Math.min(r, sx / 2.1, sy / 2.1, sz / 2.1));
  g.translate(c.x, c.y, c.z);
  return g;
}

export class Figure {
  readonly root = new THREE.Group();
  readonly bones = {} as Record<BoneName, THREE.Bone>;
  readonly meshes: THREE.SkinnedMesh[] = [];
  readonly kit: Kit;
  private rest = {} as Record<BoneName, THREE.Vector3>;
  readonly scale: number;
  /** Vertical offset of the hips (crouching, jumping), metres. */
  hipY = 0;

  constructor(kit: Kit, mats: { matte: THREE.Material; gloss: THREE.Material }) {
    this.kit = kit;
    this.scale = kit.build ?? 1;
    const idx = (b: BoneName) => ORDER.indexOf(b);
    const parts: Part[] = [];
    const add = (geo: THREE.BufferGeometry, color: number, bone: BoneName, gloss = false) => parts.push({ geo: prep(geo, color, idx(bone)), gloss });

    const k = kit;
    const belly = k.belly ?? 0;
    // Torso.
    add(ellipsoid(V(0, 0.95, 0), 0.165, 0.12, 0.115), k.pants, 'hips');
    add(limb(V(0, 1.0, 0), V(0, 1.19, 0.0), 0.142 + belly * 0.4, 0.15), k.shirt, 'spine');
    add(ellipsoid(V(0, 1.1, 0.02 + belly * 0.5), 0.15 + belly * 0.3, 0.12, 0.12 + belly), k.shirt, 'spine');
    add(ellipsoid(V(0, 1.33, 0.005), 0.195, 0.165, 0.125), k.shirt, 'chest');
    add(ellipsoid(V(0, 1.43, 0.0), 0.215, 0.07, 0.11), k.shirt, 'chest');
    // Collar trim.
    add(new THREE.TorusGeometry(0.06, 0.012, 6, 14).rotateX(Math.PI / 2).translate(0, 1.485, 0.0), k.trim, 'chest');
    // Side stripe trim on the shirt.
    add(rbox(V(0.18, 1.3, 0), 0.02, 0.2, 0.08, 0.008), k.trim, 'chest');
    add(rbox(V(-0.18, 1.3, 0), 0.02, 0.2, 0.08, 0.008), k.trim, 'chest');
    // Neck and head.
    add(limb(V(0, 1.47, 0), V(0, 1.62, 0.01), 0.048, 0.045), k.skin, 'neck');
    const hc = V(0, 1.705, 0.01);
    add(ellipsoid(hc, 0.098, 0.115, 0.108), k.skin, 'head');
    add(ellipsoid(V(0, 1.665, 0.098), 0.018, 0.026, 0.02, 6, 5), k.skin, 'head'); // nose
    add(ellipsoid(V(0.098, 1.7, 0.0), 0.016, 0.03, 0.02, 6, 5), k.skin, 'head'); // ears
    add(ellipsoid(V(-0.098, 1.7, 0.0), 0.016, 0.03, 0.02, 6, 5), k.skin, 'head');
    const hair = k.hair ?? 0x1a1410;
    if (k.head !== 'bare') {
      // Hair under the headwear at the back.
      add(ellipsoid(V(0, 1.68, -0.035), 0.094, 0.085, 0.085), hair, 'head');
    }
    switch (k.head) {
      case 'cap':
      case 'keeperCap': {
        add(new THREE.SphereGeometry(0.106, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.8, 1.05).translate(hc.x, hc.y + 0.02, hc.z), k.headColor, 'head');
        add(rbox(V(0, 1.735, 0.135), 0.17, 0.012, 0.11, 0.005).rotateX(0.0), k.headColor, 'head');
        break;
      }
      case 'helmet': {
        add(new THREE.SphereGeometry(0.128, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.56).scale(1, 0.95, 1.1).translate(hc.x, hc.y + 0.0, hc.z - 0.005), k.headColor, 'head', true);
        add(rbox(V(0, 1.735, 0.135), 0.2, 0.014, 0.08, 0.006), k.headColor, 'head', true); // peak
        // Grille: two horizontal bars and a centre bar.
        for (const y of [1.66, 1.61]) add(new THREE.TorusGeometry(0.115, 0.006, 4, 14, Math.PI).rotateX(Math.PI / 2).rotateY(Math.PI).translate(hc.x, y, hc.z + 0.01), 0x9aa0a8, 'head', true);
        add(limb(V(0, 1.6, 0.13), V(0, 1.72, 0.13), 0.006), 0x9aa0a8, 'head', true);
        add(ellipsoid(V(0, 1.6, -0.09), 0.085, 0.05, 0.03), k.headColor, 'head', true); // neck guard
        break;
      }
      case 'bbhelmet':
      case 'catcher': {
        add(new THREE.SphereGeometry(0.122, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.6).scale(1, 0.92, 1.1).translate(hc.x, hc.y + 0.005, hc.z - 0.01), k.headColor, 'head', true);
        add(rbox(V(0, 1.73, 0.13), 0.17, 0.012, 0.07, 0.005), k.headColor, 'head', true);
        if (k.head === 'bbhelmet') add(ellipsoid(V(0.11, 1.68, 0.0), 0.03, 0.06, 0.06), k.headColor, 'head', true); // ear flap
        else for (const y of [1.66, 1.62, 1.58]) add(new THREE.TorusGeometry(0.11, 0.006, 4, 14, Math.PI).rotateX(Math.PI / 2).rotateY(Math.PI).translate(hc.x, y, hc.z + 0.01), 0x222222, 'head', true);
        break;
      }
      case 'umpire': {
        add(new THREE.SphereGeometry(0.104, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.02).translate(hc.x, hc.y + 0.025, hc.z), k.headColor, 'head');
        add(new THREE.CylinderGeometry(0.19, 0.19, 0.01, 20).translate(hc.x, hc.y + 0.03, hc.z), k.headColor, 'head');
        break;
      }
      default:
        add(ellipsoid(V(0, 1.735, -0.005), 0.1, 0.07, 0.105), hair, 'head');
    }
    // Arms (left = +x).
    for (const s of [1, -1] as const) {
      const side = s > 0 ? 'L' : 'R';
      const sh = jp(`arm${side}` as BoneName);
      const el = jp(`fore${side}` as BoneName);
      const wr = jp(`hand${side}` as BoneName);
      add(ellipsoid(sh.clone().add(V(0, 0.0, 0)), 0.068, 0.072, 0.072), k.shirt, `arm${side}` as BoneName);
      const sleeveEnd = sh.clone().lerp(el, k.longSleeves ? 1.05 : 0.55);
      add(limb(sh, sleeveEnd, 0.062, 0.056), k.shirt, `arm${side}` as BoneName);
      add(limb(sh.clone().lerp(el, 0.4), el, 0.05, 0.044), k.longSleeves ? k.shirt : k.skin, `arm${side}` as BoneName);
      add(limb(el, wr, 0.044, 0.035), k.longSleeves ? k.shirt : k.skin, `fore${side}` as BoneName);
      const handC = wr.clone().add(V(0.005 * s, -0.045, 0.005));
      if (k.gloves !== undefined) add(rbox(handC, 0.075, 0.1, 0.06, 0.025), k.gloves, `hand${side}` as BoneName);
      else add(ellipsoid(handC, 0.032, 0.048, 0.022), k.skin, `hand${side}` as BoneName);
    }
    // Legs.
    for (const s of [1, -1] as const) {
      const side = s > 0 ? 'L' : 'R';
      const hip = jp(`thigh${side}` as BoneName);
      const kn = jp(`shin${side}` as BoneName);
      const an = jp(`foot${side}` as BoneName);
      add(limb(hip, kn, 0.088, 0.064), k.pants, `thigh${side}` as BoneName);
      add(limb(kn, an, 0.06, 0.042), k.socks ?? k.pants, `shin${side}` as BoneName);
      if (k.socks !== undefined) add(limb(kn.clone().lerp(an, 0.0), kn.clone().lerp(an, 0.25), 0.062, 0.058), k.pants, `shin${side}` as BoneName);
      if (k.pads !== undefined) {
        // Batting / keeping pads: a tall rounded block over the shin and knee with ridges.
        const mid = kn.clone().lerp(an, 0.42).add(V(0, 0, 0.045));
        add(rbox(mid, 0.135, 0.5, 0.075, 0.03), k.pads, `shin${side}` as BoneName);
        add(rbox(kn.clone().add(V(0, 0.07, 0.06)), 0.12, 0.16, 0.06, 0.03), k.pads, `shin${side}` as BoneName);
        for (const dx of [-0.035, 0, 0.035]) add(rbox(mid.clone().add(V(dx, 0, 0.04)), 0.014, 0.44, 0.012, 0.005), 0xdedede, `shin${side}` as BoneName);
      }
      add(rbox(an.clone().add(V(0, -0.045, 0.06)), 0.095, 0.075, 0.25, 0.03), k.shoes, `foot${side}` as BoneName);
      add(rbox(an.clone().add(V(0, -0.078, 0.06)), 0.1, 0.014, 0.255, 0.006), 0xf2f2f2, `foot${side}` as BoneName);
    }

    // Skeleton.
    const boneList: THREE.Bone[] = [];
    for (const name of ORDER) {
      const b = new THREE.Bone();
      b.name = name;
      const j = JOINTS[name];
      const p = jp(name);
      this.rest[name] = p.clone();
      if (j.parent) {
        b.position.copy(p.clone().sub(jp(j.parent)));
        this.bones[j.parent].add(b);
      } else b.position.copy(p);
      this.bones[name] = b;
      boneList.push(b);
    }
    // Bind in the rest pose at the origin and unit scale, so bone inverses match the geometry.
    this.bones.hips.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(boneList);
    const groups: [THREE.BufferGeometry[], THREE.Material][] = [
      [parts.filter((p) => !p.gloss).map((p) => p.geo), mats.matte],
      [parts.filter((p) => p.gloss).map((p) => p.geo), mats.gloss],
    ];
    const holder = new THREE.Group();
    holder.add(this.bones.hips);
    this.root.add(holder);
    this.root.updateMatrixWorld(true);
    for (const [geos, mat] of groups) {
      if (!geos.length) continue;
      const geo = mergeGeometries(geos, false)!;
      geos.forEach((g) => g.dispose());
      const m = new THREE.SkinnedMesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = false;
      m.frustumCulled = false;
      m.bind(skeleton);
      holder.add(m);
      this.meshes.push(m);
    }
    holder.scale.setScalar(this.scale);
    if (kit.back) this.bones.chest.add(backDecal(kit, JOINTS.chest.pos[1]));
  }

  /** All bones back to the rest pose. */
  reset(): void {
    for (const n of ORDER) this.bones[n].quaternion.identity();
    this.hipY = 0;
    this.bones.hips.position.y = JOINTS.hips.pos[1];
  }

  r(name: BoneName, x: number, y = 0, z = 0, order: THREE.EulerOrder = 'XYZ'): void {
    this.bones[name].rotation.set(x, y, z, order);
  }

  /**
   * Orient an arm relative to the pelvis instead of the chest (x = swing forward(-)/back(+), z = out to the side),
   * so a windmill stays in the vertical plane towards the target however much the torso twists.
   */
  armHips(side: 'L' | 'R', x: number, z = 0): void {
    const qt = this.bones.spine.quaternion.clone().multiply(this.bones.chest.quaternion);
    const want = new THREE.Quaternion().setFromEuler(new THREE.Euler(x, 0, z, 'XYZ'));
    this.bones[`arm${side}`].quaternion.copy(qt.invert().multiply(want));
  }

  setHips(dy: number): void {
    this.hipY = dy;
    this.bones.hips.position.y = JOINTS.hips.pos[1] + dy;
  }

  set castShadow(on: boolean) {
    for (const m of this.meshes) m.castShadow = on;
  }

  /** World position of a bone (after updateMatrixWorld). */
  world(name: BoneName, out = new THREE.Vector3()): THREE.Vector3 {
    return this.bones[name].getWorldPosition(out);
  }

  /** Point the arm so the hand reaches `target` (world), elbow bending towards `pole` (world). */
  reachArm(side: 'L' | 'R', target: THREE.Vector3, pole: THREE.Vector3): void {
    const arm = this.bones[`arm${side}`];
    const fore = this.bones[`fore${side}`];
    arm.quaternion.identity();
    fore.quaternion.identity();
    arm.parent!.updateWorldMatrix(true, false);
    arm.updateMatrixWorld(true);
    const S = arm.getWorldPosition(new THREE.Vector3());
    const s = this.scale;
    const l1 = this.rest[`fore${side}`].distanceTo(this.rest[`arm${side}`]) * s;
    const l2 = (this.rest[`hand${side}`].distanceTo(this.rest[`fore${side}`]) + 0.05) * s;
    const toT = target.clone().sub(S);
    const d = THREE.MathUtils.clamp(toT.length(), 0.05, (l1 + l2) * 0.999);
    const dir = toT.normalize();
    const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const a = Math.acos(cosA);
    const bend = pole.clone().sub(S);
    bend.sub(dir.clone().multiplyScalar(bend.dot(dir)));
    if (bend.lengthSq() < 1e-8) bend.set(0, -1, 0);
    bend.normalize();
    const E = S.clone().add(dir.clone().multiplyScalar(Math.cos(a) * l1)).add(bend.multiplyScalar(Math.sin(a) * l1));
    const T = S.clone().add(dir.clone().multiplyScalar(d));
    const restA = this.rest[`fore${side}`].clone().sub(this.rest[`arm${side}`]).normalize();
    const pq = arm.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
    arm.quaternion.setFromUnitVectors(restA, E.clone().sub(S).normalize().applyQuaternion(pq));
    arm.updateMatrixWorld(true);
    const restB = this.rest[`hand${side}`].clone().sub(this.rest[`fore${side}`]).normalize();
    const aq = arm.getWorldQuaternion(new THREE.Quaternion()).invert();
    fore.quaternion.setFromUnitVectors(restB, T.clone().sub(E).normalize().applyQuaternion(aq));
    fore.updateMatrixWorld(true);
  }

  // ---- poses (all angles in radians, applied on top of the rest pose) ---------------------------------

  idle(t: number, seed = 0): void {
    this.reset();
    const b = Math.sin(t * 1.6 + seed) * 0.02;
    this.r('spine', 0.04 + b, 0, Math.sin(t * 0.5 + seed) * 0.02);
    this.r('chest', 0.02 - b * 0.5);
    this.r('armL', 0.05, 0, 0.1 + b);
    this.r('armR', 0.05, 0, -0.1 - b);
    this.r('foreL', -0.25);
    this.r('foreR', -0.25);
    this.r('thighL', 0, 0, 0.04);
    this.r('thighR', 0, 0, -0.04);
    this.r('head', -0.05, Math.sin(t * 0.4 + seed * 3) * 0.25);
  }

  /** Fielder walking in / ready crouch. k = 0 standing … 1 full ready crouch. */
  ready(t: number, k = 1, seed = 0): void {
    this.reset();
    const sway = Math.sin(t * 2 + seed) * 0.02;
    this.setHips(-0.1 * k);
    this.r('spine', 0.45 * k + sway);
    this.r('chest', 0.1 * k);
    this.r('head', -0.45 * k);
    for (const s of ['L', 'R'] as const) {
      const m = s === 'L' ? 1 : -1;
      this.r(`thigh${s}`, -0.55 * k, 0, 0.12 * m);
      this.r(`shin${s}`, 0.85 * k);
      this.r(`foot${s}`, -0.3 * k);
      this.r(`arm${s}`, -0.55 * k, 0, 0.12 * m);
      this.r(`fore${s}`, -0.7 * k);
    }
  }

  /** Running cycle; phase advances 2π per stride pair, k = 0 walk … 1 sprint. */
  run(phase: number, k = 1): void {
    this.reset();
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const amp = 0.35 + 0.45 * k;
    this.setHips(-0.02 - 0.03 * k + Math.abs(c) * 0.04 * k);
    this.r('spine', 0.12 + 0.18 * k, s * 0.1);
    this.r('chest', 0.02, -s * 0.15);
    this.r('head', -0.15 - 0.15 * k, s * 0.08);
    this.r('thighL', -s * amp - 0.1 * k);
    this.r('thighR', s * amp - 0.1 * k);
    const kneeL = 0.25 + (0.5 + 0.5 * Math.sin(phase + 1.6)) * (0.6 + 0.9 * k);
    const kneeR = 0.25 + (0.5 + 0.5 * Math.sin(phase + Math.PI + 1.6)) * (0.6 + 0.9 * k);
    this.r('shinL', kneeL);
    this.r('shinR', kneeR);
    this.r('footL', -0.2 + Math.max(0, -s) * 0.3);
    this.r('footR', -0.2 + Math.max(0, s) * 0.3);
    this.r('armL', s * amp * 0.9, 0, 0.12);
    this.r('armR', -s * amp * 0.9, 0, -0.12);
    this.r('foreL', -0.9 - 0.5 * k);
    this.r('foreR', -0.9 - 0.5 * k);
  }

  /** Right-arm fast bowler's delivery stride, u = 0 (bound) … 1 (end of follow-through). Release ≈ 0.62. */
  bowl(u: number, spin = false): void {
    this.reset();
    const ph = (a: number, b: number) => THREE.MathUtils.clamp((u - a) / (b - a), 0, 1);
    const sm = (x: number) => x * x * (3 - 2 * x);
    const jump = ph(0, 0.32);
    const land = ph(0.32, 0.5);
    const whip = ph(0.5, 0.68);
    const fol = ph(0.68, 1);
    const air = Math.sin(jump * Math.PI) * (spin ? 0.08 : 0.22);
    this.setHips(air - 0.06 * sm(whip) - 0.1 * Math.sin(fol * Math.PI) * (1 - fol * 0.5));
    // Torso: coil side-on in the bound, unwind through the release, bend into the follow-through.
    const yaw = -1.1 * sm(Math.min(1, jump * 1.5)) * (1 - sm(whip)) + 0.55 * sm(whip) * (1 - 0.4 * fol);
    const bend = 0.12 + 0.55 * sm(whip) + 0.25 * Math.sin(fol * Math.PI);
    this.r('spine', bend * 0.6, yaw * 0.4, -0.15 * (1 - sm(whip)) * sm(jump), 'YXZ');
    this.r('chest', bend * 0.5, yaw * 0.6, 0, 'YXZ');
    this.r('head', -bend * 0.8, -yaw * 0.8, 0, 'YXZ');
    // Front (left) arm: up and pointing at the batter, then pulled down hard.
    const frontUp = sm(Math.min(1, jump * 1.3)) * (1 - sm(whip));
    this.armHips('L', -2.7 * frontUp - 0.6 * sm(whip), 0.25 * frontUp + 0.3 * sm(whip));
    this.r('foreL', -0.3 - 0.9 * sm(whip));
    // Bowling (right) arm: from low behind the body, over the top (release just past vertical), across the body.
    const armA = 0.25 + 1.1 * sm(land) + 2.1 * sm(whip) + 1.9 * sm(fol);
    this.armHips('R', armA, -0.12 - 0.45 * sm(fol));
    this.r('foreR', -0.15 * (1 - sm(whip)) - 0.4 * sm(fol));
    // Legs: knee drive in the bound, braced front leg at release, back leg swings through.
    this.r('thighL', -1.1 * Math.sin(jump * Math.PI) - 0.75 * sm(land) * (1 - 0.6 * fol));
    this.r('shinL', 1.3 * Math.sin(jump * Math.PI) + 0.1);
    this.r('thighR', 0.35 * sm(jump) * (1 - sm(land)) + 0.45 * sm(whip) - 1.3 * sm(fol));
    this.r('shinR', 0.6 * sm(jump) + 0.9 * sm(whip) * (1 - fol) + 0.6 * Math.sin(fol * Math.PI));
    this.r('footL', -0.2);
  }

  /** Baseball pitcher (right-handed), u = 0 set … 1 follow-through; release ≈ 0.66. */
  pitch(u: number): void {
    this.reset();
    const ph = (a: number, b: number) => THREE.MathUtils.clamp((u - a) / (b - a), 0, 1);
    const sm = (x: number) => x * x * (3 - 2 * x);
    const lift = ph(0, 0.32);
    const stride = ph(0.32, 0.55);
    const whip = ph(0.55, 0.68);
    const fol = ph(0.68, 1);
    const kneeUp = Math.sin(Math.min(1, lift * 1.1) * Math.PI * 0.5) * (1 - sm(stride));
    this.setHips(-0.05 * sm(stride) - 0.1 * sm(whip) - 0.04 * fol);
    const yaw = -1.25 * sm(lift) * (1 - sm(whip)) + 0.6 * sm(whip);
    const bend = 0.05 + 0.15 * sm(stride) + 0.55 * sm(whip) + 0.2 * sm(fol);
    this.r('spine', bend * 0.6, yaw * 0.45, 0, 'YXZ');
    this.r('chest', bend * 0.5, yaw * 0.55, 0, 'YXZ');
    this.r('head', -bend * 0.8, -yaw * 0.85, 0, 'YXZ');
    this.r('thighL', -1.5 * kneeUp - 0.8 * sm(stride) * (1 - 0.3 * fol));
    this.r('shinL', 1.6 * kneeUp + 0.25 * sm(stride));
    this.r('thighR', 0.1 + 0.4 * sm(stride) - 1.1 * sm(fol));
    this.r('shinR', 0.15 + 0.7 * sm(whip) * (1 - fol) + 0.7 * Math.sin(fol * Math.PI));
    // Hands together at the chest, then break: glove arm forward, ball arm back and up, whip through.
    const together = 1 - sm(stride);
    this.armHips('L', -1.0 * together - 1.4 * sm(stride) * (1 - sm(whip)) - 0.5 * sm(whip), -0.4 * together + 0.3 * sm(stride));
    this.r('foreL', -1.6 * together - 0.6 * sm(stride));
    const armA = -0.9 * together + (1.9 * sm(stride) + 1.6 * sm(whip) + 1.6 * sm(fol)) * (1 - together * 0.3);
    this.armHips('R', armA, 0.35 * together - 0.4 * sm(stride) * (1 - sm(whip)) - 0.3 * sm(fol));
    this.r('foreR', -1.5 * together - 1.2 * sm(stride) * (1 - sm(whip)) - 0.3 * sm(fol));
  }

  /** Overarm throw with the right arm, u = 0 … 1, release ≈ 0.55. */
  throwBall(u: number): void {
    this.reset();
    const ph = (a: number, b: number) => THREE.MathUtils.clamp((u - a) / (b - a), 0, 1);
    const sm = (x: number) => x * x * (3 - 2 * x);
    const cock = ph(0, 0.4);
    const rel = ph(0.4, 0.58);
    const fol = ph(0.58, 1);
    const yaw = -0.9 * sm(cock) * (1 - sm(rel)) + 0.5 * sm(rel);
    this.r('spine', 0.1 + 0.35 * sm(rel), yaw * 0.5, 0, 'YXZ');
    this.r('chest', 0.05 + 0.2 * sm(rel), yaw * 0.6, 0, 'YXZ');
    this.r('head', -0.2, -yaw * 0.8, 0, 'YXZ');
    this.armHips('L', -1.5 * sm(cock) * (1 - sm(rel)) - 0.4, 0.3);
    this.r('foreL', -0.6);
    this.armHips('R', 2.4 * sm(cock) + 1.6 * sm(rel) + 1.0 * sm(fol), -0.25);
    this.r('foreR', -1.3 * sm(cock) * (1 - sm(rel)) - 0.2);
    this.r('thighL', -0.5 * sm(cock) - 0.2 * sm(rel));
    this.r('shinL', 0.3);
    this.r('thighR', 0.2 + 0.3 * sm(rel) - 0.6 * sm(fol));
    this.r('shinR', 0.3 + 0.4 * sm(rel));
  }

  /** Taking a catch: hands at height h (m) in front, crouched for low balls. */
  catchAt(h: number, t: number): void {
    this.reset();
    const high = THREE.MathUtils.clamp((h - 1.0) / 1.2, 0, 1);
    const low = THREE.MathUtils.clamp((0.9 - h) / 0.8, 0, 1);
    this.setHips(-0.25 * low);
    this.r('spine', 0.35 * low - 0.1 * high);
    this.r('head', -0.3 * low + 0.35 * high);
    for (const s of ['L', 'R'] as const) {
      const m = s === 'L' ? 1 : -1;
      this.r(`arm${s}`, -1.2 - 1.6 * high + 0.4 * low, 0, -0.18 * m);
      this.r(`fore${s}`, -0.5 + 0.2 * high);
      this.r(`thigh${s}`, -0.6 * low, 0, 0.1 * m);
      this.r(`shin${s}`, 1.1 * low);
    }
    void t;
  }

  /** Bending to field a ground ball, u = 0 … 1 (deepest at 0.5). */
  pickup(u: number): void {
    this.reset();
    const k = Math.sin(THREE.MathUtils.clamp(u, 0, 1) * Math.PI);
    this.setHips(-0.25 * k);
    this.r('spine', 1.0 * k);
    this.r('chest', 0.25 * k);
    this.r('head', -0.6 * k);
    this.r('armR', -1.0 * k, 0, -0.1);
    this.r('armL', -0.9 * k, 0, 0.1);
    this.r('thighL', -0.9 * k, 0, 0.15);
    this.r('thighR', -0.3 * k, 0, -0.15);
    this.r('shinL', 1.2 * k);
    this.r('shinR', 0.9 * k);
  }

  /** Wicket-keeper / catcher squat. */
  squat(t: number, up = 0): void {
    this.reset();
    const k = 1 - up;
    const b = Math.sin(t * 3) * 0.01;
    this.setHips(-0.42 * k + b);
    this.r('spine', 0.45 * k + 0.1);
    this.r('head', -0.45 * k);
    for (const s of ['L', 'R'] as const) {
      const m = s === 'L' ? 1 : -1;
      this.r(`thigh${s}`, -1.45 * k, 0, 0.32 * m * k);
      this.r(`shin${s}`, 2.1 * k);
      this.r(`foot${s}`, -0.65 * k);
      this.r(`arm${s}`, -1.0 - 0.2 * k, 0, -0.08 * m);
      this.r(`fore${s}`, -0.4);
    }
  }

  /** Umpire signals: six (both arms up), four (waving across the chest), out (finger raised). */
  signal(kind: 'six' | 'four' | 'out' | 'none', t: number): void {
    this.idle(t, 2);
    if (kind === 'none') {
      this.r('armL', -0.45, 0, -0.25);
      this.r('armR', -0.45, 0, 0.25);
      this.r('foreL', -1.3, 0, 0);
      this.r('foreR', -1.3, 0, 0);
      return;
    }
    if (kind === 'six') {
      this.r('armL', -3.05, 0, 0.12);
      this.r('armR', -3.05, 0, -0.12);
      this.r('foreL', 0);
      this.r('foreR', 0);
    } else if (kind === 'four') {
      const w = Math.sin(t * 7);
      this.r('armR', -1.55, 0, -0.2 + w * 0.65);
      this.r('foreR', 0);
    } else {
      this.r('armR', -2.75, 0, -0.1);
      this.r('foreR', -0.15);
    }
  }

  /** Arms-up celebration with a little bounce. */
  celebrate(t: number): void {
    this.reset();
    const b = Math.abs(Math.sin(t * 6));
    this.setHips(b * 0.06);
    this.r('spine', -0.1);
    this.r('head', 0.25);
    this.r('armL', -2.8 + b * 0.2, 0, 0.3);
    this.r('armR', -2.8 + b * 0.2, 0, -0.3);
    this.r('foreL', -0.3);
    this.r('foreR', -0.3);
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      m.skeleton.dispose();
    }
  }
}

/** Curved patch hugging the back of the chest with the player's name and number. */
function backDecal(kit: Kit, boneY: number): THREE.Mesh {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 256, 256);
  const trim = `#${new THREE.Color(kit.trim).getHexString()}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '800 34px Outfit, Arial Black, sans-serif';
  g.fillStyle = '#ffffff';
  g.fillText(kit.back!.name.toUpperCase(), 128, 34);
  g.font = '900 150px Outfit, Arial Black, sans-serif';
  g.lineWidth = 10;
  g.strokeStyle = '#ffffff';
  g.strokeText(kit.back!.number, 128, 150);
  g.fillStyle = trim;
  g.fillText(kit.back!.number, 128, 150);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const nx = 10;
  const ny = 8;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const [cy, cz] = [1.33, 0.005];
  const [rx, ry, rz] = [0.195, 0.165, 0.125];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const u = i / nx;
      const v = j / ny;
      const x = (u - 0.5) * 0.24;
      const y = 1.24 + v * 0.22;
      const q = 1 - (x / rx) ** 2 - ((y - cy) / ry) ** 2;
      const z = cz - rz * Math.sqrt(Math.max(0.02, q)) - 0.004;
      // Viewed from behind: mirror u so the text reads correctly.
      pos.push(x, y - boneY, z);
      uv.push(1 - u, v);
    }
  }
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: t, transparent: true, roughness: 0.8, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
  m.frustumCulled = false;
  return m;
}

/** Shared materials for every figure. */
export function figureMaterials(): { matte: THREE.MeshStandardMaterial; gloss: THREE.MeshStandardMaterial } {
  return {
    matte: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 }),
    gloss: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.15, envMapIntensity: 1.2 }),
  };
}

export const SKIN_TONES = [0x8d5a3b, 0x6e4329, 0xa8714d, 0x7b4b30, 0xc08a63, 0x5a3622, 0x9a6444, 0xd2a07a];
