/**
 * The on-screen coach: a CC0 rigged character (Quaternius) posed every frame from the canonical skeleton solve.
 * Each limb bone is rotated so it points along the solved joint direction (with the elbow/knee bend plane kept), the
 * legs are solved with the model's own lengths so the feet stay planted, and the spine shares the torso rotation.
 * The coach mirrors the player: the move's right side (screen right) drives the character's left limbs.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ik2, mul, type Joints } from './rig';
import type { V3 } from './moves';

export type CoachId = 'mia' | 'leo';

export const COACHES: Record<CoachId, { name: string; file: string; style: Record<string, { color: string; rough?: number; sheen?: boolean; stripe?: string }> }> = {
  mia: {
    name: 'Mia',
    file: 'coach-mia.glb',
    style: {
      White: { color: '#ff2f7e', rough: 0.55, sheen: true, stripe: '#ffd1e3' },
      Orange: { color: '#2b1f78', rough: 0.45, sheen: true, stripe: '#ff4f9a' },
      Grey: { color: '#f2f0ff', rough: 0.5, stripe: '#ff2f7e' },
      Hair_Blond: { color: '#4a2418', rough: 0.6 },
    },
  },
  leo: {
    name: 'Leo',
    file: 'coach-leo.glb',
    style: {
      LightBrown: { color: '#16b9ff', rough: 0.55, sheen: true, stripe: '#e9fbff' },
      LightBlue: { color: '#1b1d3d', rough: 0.5, sheen: true, stripe: '#16b9ff' },
      Red_Dark: { color: '#ff3d6e', rough: 0.5 },
      White: { color: '#f4f4ff', rough: 0.5 },
    },
  },
};

const BASE = import.meta.env.BASE_URL;

interface BoneInfo {
  bone: THREE.Bone;
  parent: string | null;
  lp: THREE.Vector3;
  lq: THREE.Quaternion;
  wp: THREE.Vector3;
  wq: THREE.Quaternion;
}

const v = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);
const tmpM = new THREE.Matrix4();

/** Rotation taking frame (dir a0, axis n0) to (dir a1, axis n1). */
function frameRotation(a0: THREE.Vector3, n0: THREE.Vector3, a1: THREE.Vector3, n1: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  const b0 = new THREE.Matrix4().makeBasis(a0, n0, new THREE.Vector3().crossVectors(a0, n0));
  const b1 = new THREE.Matrix4().makeBasis(a1, n1, new THREE.Vector3().crossVectors(a1, n1));
  tmpM.copy(b1).multiply(b0.transpose());
  return out.setFromRotationMatrix(tmpM);
}

const orth = (x: THREE.Vector3, d: THREE.Vector3) => x.clone().addScaledVector(d, -x.dot(d));

export interface CoachUniforms {
  uRim: { value: THREE.Color };
  uRimK: { value: number };
}

export class Coach {
  readonly group = new THREE.Group();
  readonly uniforms: CoachUniforms = { uRim: { value: new THREE.Color('#ff4fd8') }, uRimK: { value: 0.6 } };
  private info = new Map<string, BoneInfo>();
  private order: string[] = [];
  private legU = 0.42;
  private thigh = 0.48;
  private shin = 0.53;
  private fingers: { name: string; axis: THREE.Vector3; k: number }[] = [];
  private meshes: THREE.SkinnedMesh[] = [];
  readonly height: number;

  private constructor(
    private scene: THREE.Object3D,
    readonly id: CoachId,
  ) {
    this.group.add(scene);
    scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) {
        this.meshes.push(m);
        m.castShadow = true;
        m.frustumCulled = false;
      }
    });
    const skel = this.meshes[0].skeleton;
    skel.pose();
    scene.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(scene.matrixWorld).invert();
    const visit = (o: THREE.Object3D, parent: string | null) => {
      const b = o as THREE.Bone;
      let next = parent;
      if (b.isBone) {
        const wm = new THREE.Matrix4().multiplyMatrices(rootInv, b.matrixWorld);
        const wp = new THREE.Vector3();
        const wq = new THREE.Quaternion();
        wm.decompose(wp, wq, new THREE.Vector3());
        this.info.set(b.name, { bone: b, parent, lp: b.position.clone(), lq: b.quaternion.clone(), wp, wq });
        this.order.push(b.name);
        next = b.name;
      }
      for (const c of o.children) visit(c, next);
    };
    visit(scene, null);
    const P = (n: string) => this.info.get(n)!.wp;
    this.thigh = P('LowerLegL').distanceTo(P('UpperLegL'));
    this.shin = P('FootL').distanceTo(P('LowerLegL'));
    this.legU = (this.thigh + this.shin) / 2.4;
    const box = new THREE.Box3().setFromObject(scene);
    this.height = box.max.y - box.min.y;
    // Finger curl axes: in the bind T-pose, curling turns the fingers about the world z axis.
    for (const side of ['L', 'R']) {
      for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) {
        for (let k = 1; k <= 3; k++) {
          const name = `${f}${k}${side}`;
          const bi = this.info.get(name);
          if (!bi) continue;
          const axis = new THREE.Vector3(0, 0, side === 'L' ? -1 : 1).applyQuaternion(bi.wq.clone().invert());
          this.fingers.push({ name, axis, k: k === 1 ? 1.35 : k === 2 ? 1.7 : 1.3 });
        }
      }
      const th = this.info.get(`Thumb2${side}`);
      if (th) this.fingers.push({ name: `Thumb2${side}`, axis: new THREE.Vector3(0, 1, 0).applyQuaternion(th.wq.clone().invert()), k: 0.6 });
    }
  }

  static async load(id: CoachId): Promise<Coach> {
    const gltf = await new GLTFLoader().loadAsync(`${BASE}assets/fit/${COACHES[id].file}`);
    const c = new Coach(gltf.scene, id);
    c.restyle();
    return c;
  }

  /** Sporty colours, a soft sheen and a beat-reactive rim light. Stripes run down the outside of clothing. */
  private restyle(): void {
    const style = COACHES[this.id].style;
    const cache = new Map<string, THREE.Material>();
    const uni = this.uniforms;
    for (const m of this.meshes) {
      const old = m.material as THREE.MeshStandardMaterial;
      const name = old.name;
      let mat = cache.get(name);
      if (!mat) {
        const st = style[name];
        const color = st ? new THREE.Color(st.color) : old.color.clone();
        const phys = new THREE.MeshStandardMaterial({
          color,
          roughness: st?.rough ?? (name === 'Skin' ? 0.62 : 0.7),
          metalness: st?.sheen ? 0.08 : 0,
        });
        phys.name = name;
        const stripe = st?.stripe ? new THREE.Color(st.stripe) : null;
        phys.onBeforeCompile = (sh) => {
          sh.uniforms.uRim = uni.uRim;
          sh.uniforms.uRimK = uni.uRimK;
          sh.uniforms.uStripe = { value: stripe ?? new THREE.Color(0, 0, 0) };
          sh.uniforms.uStripeK = { value: stripe ? 1 : 0 };
          sh.vertexShader = sh.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vBindPos;\nvarying vec3 vBindN;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBindPos = position;\nvBindN = normal;');
          sh.fragmentShader = sh.fragmentShader
            .replace(
              '#include <common>',
              '#include <common>\nuniform vec3 uRim;\nuniform float uRimK;\nuniform vec3 uStripe;\nuniform float uStripeK;\nvarying vec3 vBindPos;\nvarying vec3 vBindN;',
            )
            .replace(
              '#include <color_fragment>',
              `#include <color_fragment>
              {
                float side = vBindN.x * sign(vBindPos.x);
                float band = smoothstep(0.80, 0.9, side) * (1.0 - smoothstep(0.97, 1.0, side));
                float trim = smoothstep(0.86, 0.95, abs(vBindN.y)) * step(0.5, vBindPos.y);
                diffuseColor.rgb = mix(diffuseColor.rgb, uStripe, uStripeK * max(band, trim * 0.0));
              }`,
            )
            .replace(
              '#include <emissivemap_fragment>',
              `#include <emissivemap_fragment>
              {
                float fres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.6);
                totalEmissiveRadiance += uRim * fres * uRimK;
              }`,
            );
        };
        mat = phys;
        cache.set(name, mat);
      }
      m.material = mat;
    }
  }

  // ---- posing -----------------------------------------------------------------------------------

  private wq = new Map<string, THREE.Quaternion>();
  private wpTarget = new Map<string, THREE.Vector3>();

  /** Pose the character from solved canonical joints. */
  pose(j: Joints): void {
    const I = this.info;
    const wq = this.wq;
    const wpT = this.wpTarget;
    wq.clear();
    wpT.clear();
    const p = j.pose;

    // Torso rotation as a quaternion.
    const R = j.R;
    const rm = new THREE.Matrix4().set(R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1);
    const Rq = new THREE.Quaternion().setFromRotationMatrix(rm);
    const Iq = new THREE.Quaternion();
    const part = (k: number) => Iq.clone().slerp(Rq, k);
    const hipYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -p.twist * 0.25);

    // Pelvis.
    const body = I.get('Body')!;
    wpT.set('Body', body.wp.clone().add(new THREE.Vector3(p.px * this.legU, p.py * this.legU, p.pz * this.legU)));
    wq.set('Body', hipYaw.clone().multiply(body.wq));
    for (const [n, k] of [
      ['Abdomen', 0.35],
      ['Torso', 0.7],
      ['Chest', 1],
      ['Neck', 0.75],
    ] as const) {
      wq.set(n, part(k).multiply(I.get(n)!.wq));
    }
    const nod = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), p.head);
    wq.set('Head', part(0.45).multiply(nod).multiply(I.get('Head')!.wq));

    // Arms: model L ↔ the move's right side (screen right).
    this.aimArm('L', j.rs, j.re, j.rw, mul(R, p.rp));
    this.aimArm('R', j.ls, j.le, j.lw, mul(R, p.lp));

    // Legs: solve with the model's own lengths from the posed hips to the planted ankles.
    const bodyW = { p: wpT.get('Body')!, q: wq.get('Body')! };
    this.solveLeg('L', bodyW, p.rf, p.rkp, p.py, hipYaw);
    this.solveLeg('R', bodyW, p.lf, p.lkp, p.py, hipYaw);

    // Forward kinematics into local transforms.
    const W = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion }>();
    for (const name of this.order) {
      const bi = I.get(name)!;
      const par = bi.parent ? W.get(bi.parent)! : { p: new THREE.Vector3(), q: new THREE.Quaternion() };
      const invQ = par.q.clone().invert();
      const tq = wq.get(name);
      const tp = wpT.get(name);
      if (tq) bi.bone.quaternion.copy(invQ.clone().multiply(tq));
      else bi.bone.quaternion.copy(bi.lq);
      if (tp) bi.bone.position.copy(tp.clone().sub(par.p).applyQuaternion(invQ));
      else bi.bone.position.copy(bi.lp);
      const q = par.q.clone().multiply(bi.bone.quaternion);
      const pp = bi.bone.position.clone().applyQuaternion(par.q).add(par.p);
      W.set(name, { p: pp, q });
    }
    this.curl(p.fist);
  }

  private aimArm(side: 'L' | 'R', s: V3, e: V3, w: V3, pole: V3): void {
    const I = this.info;
    const ua = I.get(`UpperArm${side}`)!;
    const la = I.get(`LowerArm${side}`)!;
    const wr = I.get(`Wrist${side}`)!;
    const d1 = v(e).sub(v(s)).normalize();
    const d2 = v(w).sub(v(e)).normalize();
    let f = orth(v(w).sub(v(e)), d1);
    if (f.length() < 0.05) f = orth(v(pole), d1).negate();
    if (f.length() < 1e-4) f = orth(new THREE.Vector3(0, 0, 1), d1);
    f.normalize();
    const n = new THREE.Vector3().crossVectors(d1, f).normalize();
    const a0 = la.wp.clone().sub(ua.wp).normalize();
    const a2 = wr.wp.clone().sub(la.wp).normalize();
    const f0 = orth(new THREE.Vector3(0, 0, 1), a0).normalize();
    const n0 = new THREE.Vector3().crossVectors(a0, f0).normalize();
    const q1 = frameRotation(a0, n0, d1, n, new THREE.Quaternion());
    const n0f = orth(n0, a2).normalize();
    const nf = orth(n, d2).normalize();
    const q2 = frameRotation(a2, n0f, d2, nf, new THREE.Quaternion());
    this.wq.set(ua.bone.name, q1.multiply(ua.wq));
    this.wq.set(la.bone.name, q2.multiply(la.wq));
  }

  private solveLeg(side: 'L' | 'R', body: { p: THREE.Vector3; q: THREE.Quaternion }, off: V3, kneePole: V3, py: number, yaw: THREE.Quaternion): void {
    const I = this.info;
    const ul = I.get(`UpperLeg${side}`)!;
    const ll = I.get(`LowerLeg${side}`)!;
    const ft = I.get(`Foot${side}`)!;
    const hip = ul.lp.clone().applyQuaternion(body.q).add(body.p);
    const lift = Math.max(0, py);
    const target = ft.wp.clone().add(new THREE.Vector3(off[0] * this.legU, (off[1] + lift) * this.legU, off[2] * this.legU));
    const [kneeA, ankleA] = ik2([hip.x, hip.y, hip.z], [target.x, target.y, target.z], this.thigh, this.shin, kneePole);
    const knee = v(kneeA);
    const ankle = v(ankleA);
    const d1 = knee.clone().sub(hip).normalize();
    const d2 = ankle.clone().sub(knee).normalize();
    let f = orth(ankle.clone().sub(knee), d1);
    if (f.length() < 0.02) f = orth(v(kneePole), d1).negate();
    f.normalize();
    const n = new THREE.Vector3().crossVectors(d1, f).normalize();
    const a0 = ll.wp.clone().sub(ul.wp).normalize();
    const a2 = ft.wp.clone().sub(ll.wp).normalize();
    // Knees flex forward, so the shin swings back (−z) from the thigh line.
    const f0 = orth(new THREE.Vector3(0, 0, -1), a0).normalize();
    const n0 = new THREE.Vector3().crossVectors(a0, f0).normalize();
    const q1 = frameRotation(a0, n0, d1, n, new THREE.Quaternion());
    const q2 = frameRotation(a2, orth(n0, a2).normalize(), d2, orth(n, d2).normalize(), new THREE.Quaternion());
    this.wq.set(ul.bone.name, q1.clone().multiply(ul.wq));
    this.wq.set(ll.bone.name, q2.clone().multiply(ll.wq));
    // The foot sits at the end of the shin; flat on the floor unless it is lifted high.
    const shinVec = ft.wp.clone().sub(ll.wp).applyQuaternion(q2);
    this.wpTarget.set(ft.bone.name, knee.clone().add(shinVec));
    const raised = Math.min(0.65, Math.max(0, (ankle.y - ft.wp.y - lift * this.legU) / 0.35));
    const flat = yaw.clone().multiply(ft.wq);
    const follow = q2.clone().multiply(ft.wq);
    this.wq.set(ft.bone.name, flat.slerp(follow, raised));
  }

  private curl(fist: number): void {
    const q = new THREE.Quaternion();
    for (const f of this.fingers) {
      const bi = this.info.get(f.name)!;
      const amt = (0.18 + 0.82 * fist) * f.k;
      q.setFromAxisAngle(f.axis, amt);
      // Fingers are not posed by the solver, so their local rotation is the bind one plus the curl.
      bi.bone.quaternion.copy(bi.lq).multiply(q);
    }
  }

  /** World-space head position (for effects). */
  headPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.info.get('Head')!.bone.getWorldPosition(out);
  }

  dispose(): void {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
  }
}
