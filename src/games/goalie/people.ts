/**
 * Footballers: a rigged CC0 character (Quaternius) with kit colours painted in the shader from bind-pose
 * regions, mocap clips (run, idle, celebrations) and procedural overlays for the kick and the keeper dive.
 */
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { numberTexture } from './textures';

export interface Kit {
  shirt: string;
  shirt2: string;
  pattern: 'plain' | 'stripes' | 'hoops' | 'halves' | 'sash';
  shorts: string;
  socks: string;
  trim: string;
  boots: string;
  /** Keeper kit: long sleeves and gloves. */
  keeper?: boolean;
  gloves?: string;
}

export interface Look {
  number: number;
  /** 0 light .. 1 dark skin. */
  skin: number;
  hair: string;
}

const PATTERNS = { plain: 0, stripes: 1, hoops: 2, halves: 3, sash: 4 };

let numbersTex: THREE.Texture | null = null;

export class PeopleKit {
  readonly clips = new Map<string, THREE.AnimationClip>();
  /** Source materials (with textures) by name, shared by the full and low-detail models. */
  private mats = new Map<string, THREE.MeshStandardMaterial>();
  constructor(
    private gltf: GLTF,
    private lod: GLTF | null,
  ) {
    for (const c of gltf.animations) this.clips.set(c.name, c);
    numbersTex ??= numberTexture();
    for (const g of [gltf, lod]) {
      g?.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true;
        m.frustumCulled = false;
        if (g === gltf) this.mats.set((m.material as THREE.Material).name, m.material as THREE.MeshStandardMaterial);
      });
    }
  }

  /** `lod` uses the simplified model (for players seen from a distance). */
  make(kit: Kit, look: Look, opts: { face?: boolean; lod?: boolean } = {}): Footballer {
    const src = opts.lod && this.lod ? this.lod : this.gltf;
    const model = SkeletonUtils.clone(src.scene) as THREE.Group;
    return new Footballer(model, this.clips, kit, look, opts.face !== false && !opts.lod, this.mats);
  }

  dispose(): void {
    numbersTex?.dispose();
    numbersTex = null;
  }
}

function kitMaterial(src: THREE.MeshStandardMaterial, kit: Kit, look: Look, dequant: THREE.Matrix4): THREE.MeshStandardMaterial {
  const mat = src.clone();
  mat.roughness = 0.75;
  mat.metalness = 0;
  const u = {
    uShirt: { value: new THREE.Color(kit.shirt) },
    uShirt2: { value: new THREE.Color(kit.shirt2) },
    uShorts: { value: new THREE.Color(kit.shorts) },
    uSocks: { value: new THREE.Color(kit.socks) },
    uTrim: { value: new THREE.Color(kit.trim) },
    uBoots: { value: new THREE.Color(kit.boots) },
    uGloves: { value: new THREE.Color(kit.gloves ?? '#ffffff') },
    uPattern: { value: PATTERNS[kit.pattern] },
    uKeeper: { value: kit.keeper ? 1 : 0 },
    uSkin: { value: look.skin },
    uNum: { value: look.number },
    uNumbers: { value: numbersTex },
    uDequant: { value: dequant },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;\nuniform mat4 uDequant;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = (uDequant * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vBind;
        uniform vec3 uShirt, uShirt2, uShorts, uSocks, uTrim, uBoots, uGloves;
        uniform float uPattern, uKeeper, uSkin, uNum; uniform sampler2D uNumbers;
        float kitW = 0.0;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec3 bp = vBind; float ax = abs(bp.x);
          float boot = 1.0 - smoothstep(0.088, 0.1, bp.y);
          float sock = (1.0 - boot) * (1.0 - smoothstep(0.445, 0.46, bp.y));
          float shorts = smoothstep(0.545, 0.56, bp.y) * (1.0 - smoothstep(0.975, 0.99, bp.y)) * (1.0 - step(0.3, ax));
          float torso = smoothstep(0.955, 0.975, bp.y) * (1.0 - smoothstep(1.5, 1.515, bp.y + 0.03 * step(0.02, bp.z) * (1.0 - smoothstep(0.0, 0.05, ax)))) * (1.0 - step(0.22, ax));
          float sleeveEnd = uKeeper > 0.5 ? 0.645 : 0.37;
          float arm = step(1.32, bp.y) * step(0.165, ax);
          float sleeve = arm * (1.0 - smoothstep(sleeveEnd - 0.008, sleeveEnd, ax));
          float glove = uKeeper * arm * smoothstep(sleeveEnd + 0.01, sleeveEnd + 0.02, ax);
          float shirt = max(torso, sleeve);
          vec3 sc = uShirt;
          float pat = 0.0;
          if (uPattern == 1.0) pat = step(0.5, fract(bp.x * 8.0 + 0.25));
          else if (uPattern == 2.0) pat = step(0.5, fract(bp.y * 7.0));
          else if (uPattern == 3.0) pat = step(0.0, bp.x);
          else if (uPattern == 4.0) pat = step(abs(bp.y - 1.25 + bp.x * 1.2), 0.07);
          sc = mix(sc, uShirt2, pat * torso);
          sc = mix(sc, uShirt2, sleeve * (1.0 - torso) * step(uPattern, 0.5) * 0.0);
          // Collar and cuffs.
          float collar = torso * smoothstep(1.47, 1.485, bp.y + 0.03 * step(0.02, bp.z));
          float cuff = sleeve * smoothstep(sleeveEnd - 0.03, sleeveEnd - 0.02, ax);
          sc = mix(sc, uTrim, max(collar, cuff));
          // Shirt number on the back.
          if (bp.z < -0.03 && torso > 0.5) {
            float tens = floor(uNum / 10.0); float ones = mod(uNum, 10.0);
            vec2 q = vec2(-bp.x / 0.2 + 0.5, (bp.y - 1.1) / 0.22);
            if (q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0) {
              float two = step(0.5, tens);
              float dx = mix(q.x, fract(q.x * 2.0), two);
              float digit = two > 0.5 ? (q.x < 0.5 ? tens : ones) : ones;
              vec4 nt = texture2D(uNumbers, vec2((digit + mix(0.15, 0.0, two) + dx * mix(0.7, 1.0, two)) / 10.0, q.y));
              sc = mix(sc, mix(uTrim, vec3(1.0), 0.5) * nt.rgb, nt.a * step(0.3, nt.a));
            }
          }
          float trimSock = sock * smoothstep(0.39, 0.4, bp.y) * (1.0 - smoothstep(0.425, 0.435, bp.y));
          vec3 sockC = mix(uSocks, uTrim, trimSock);
          vec3 bootC = mix(uBoots, uBoots * 0.25 + 0.6, step(bp.y, 0.018));
          float cloth = max(max(shirt, shorts), max(sock, boot));
          vec3 clothC = shirt * sc + shorts * uShorts + sock * sockC + boot * bootC;
          clothC /= max(1e-3, shirt + shorts + sock + boot);
          float tex = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          // Fabric: keep a little of the texture shading for folds.
          vec3 fabric = clothC * (0.82 + 0.35 * smoothstep(0.1, 0.6, tex));
          vec3 skin = diffuseColor.rgb * mix(vec3(1.05, 1.0, 0.97), vec3(0.42, 0.3, 0.24), uSkin);
          diffuseColor.rgb = mix(skin, fabric, cloth);
          diffuseColor.rgb = mix(diffuseColor.rgb, uGloves * (0.85 + 0.3 * tex), glove);
          kitW = max(cloth, glove);
        }`,
      )
      .replace('#include <normal_fragment_maps>', 'vec3 geoN = normal;\n#include <normal_fragment_maps>\nnormal = normalize(mix(normal, geoN, kitW * 0.65));')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.62, 0.82, kitW);');
  };
  mat.customProgramCacheKey = () => 'goalie-kit';
  mat.userData.uniforms = u;
  return mat;
}

type Vec = [number, number, number];
interface Key {
  t: number;
  d: Vec;
}

/** Piecewise smooth interpolation through keyed directions. */
function keyed(keys: Key[], t: number, out: THREE.Vector3): THREE.Vector3 {
  if (t <= keys[0].t) return out.set(...keys[0].d).normalize();
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      let k = (t - a.t) / (b.t - a.t);
      k = k * k * (3 - 2 * k);
      return out.set(a.d[0] + (b.d[0] - a.d[0]) * k, a.d[1] + (b.d[1] - a.d[1]) * k, a.d[2] + (b.d[2] - a.d[2]) * k).normalize();
    }
  }
  return out.set(...keys[keys.length - 1].d).normalize();
}

// Character space: +z forward, +y up, +x = the character's LEFT. The kicking foot is the right (-x).
const KICK: Record<string, Key[]> = {
  thigh_r: [
    { t: -0.32, d: [0, -0.95, -0.25] },
    { t: -0.13, d: [0.02, -0.72, -0.68] },
    { t: 0.0, d: [0.06, -0.96, 0.28] },
    { t: 0.17, d: [0.12, -0.3, 0.95] },
    { t: 0.45, d: [0.05, -0.88, 0.45] },
  ],
  calf_r: [
    { t: -0.32, d: [0, -0.88, -0.45] },
    { t: -0.13, d: [0, 0.12, -1.0] },
    { t: 0.0, d: [0.02, -0.75, 0.66] },
    { t: 0.17, d: [0.1, -0.15, 0.99] },
    { t: 0.45, d: [0, -0.95, 0.15] },
  ],
  foot_r: [
    { t: -0.13, d: [0, -0.3, -0.95] },
    { t: 0.0, d: [0, -0.62, 0.78] },
    { t: 0.2, d: [0.1, -0.3, 0.95] },
    { t: 0.45, d: [0, -0.3, 1] },
  ],
  thigh_l: [
    { t: -0.32, d: [0.04, -0.85, 0.5] },
    { t: -0.1, d: [0.06, -0.97, 0.2] },
    { t: 0.15, d: [0.05, -0.98, -0.12] },
    { t: 0.45, d: [0.03, -0.97, 0.05] },
  ],
  calf_l: [
    { t: -0.32, d: [0, -0.95, 0.2] },
    { t: -0.1, d: [0, -0.97, -0.22] },
    { t: 0.15, d: [0, -0.95, -0.3] },
    { t: 0.45, d: [0, -1, -0.05] },
  ],
  spine_01: [
    { t: -0.3, d: [0, 0.97, 0.18] },
    { t: -0.08, d: [-0.05, 0.96, -0.22] },
    { t: 0.12, d: [-0.08, 0.95, 0.12] },
    { t: 0.45, d: [0, 0.98, 0.15] },
  ],
  upperarm_l: [
    { t: -0.3, d: [0.55, -0.75, 0.3] },
    { t: -0.08, d: [0.92, -0.25, 0.25] },
    { t: 0.2, d: [0.85, -0.35, -0.2] },
    { t: 0.45, d: [0.5, -0.85, 0.05] },
  ],
  lowerarm_l: [
    { t: -0.3, d: [0.3, -0.7, 0.6] },
    { t: -0.08, d: [0.75, 0.05, 0.65] },
    { t: 0.45, d: [0.3, -0.8, 0.4] },
  ],
  upperarm_r: [
    { t: -0.3, d: [-0.4, -0.85, -0.2] },
    { t: -0.08, d: [-0.45, -0.55, -0.7] },
    { t: 0.17, d: [-0.3, -0.6, 0.72] },
    { t: 0.45, d: [-0.35, -0.9, 0.1] },
  ],
  lowerarm_r: [
    { t: -0.3, d: [-0.2, -0.6, 0.75] },
    { t: -0.08, d: [-0.2, -0.85, -0.3] },
    { t: 0.17, d: [-0.1, -0.2, 0.95] },
    { t: 0.45, d: [-0.1, -0.7, 0.7] },
  ],
};

const CHILD: Record<string, string> = {
  thigh_r: 'calf_r',
  calf_r: 'foot_r',
  foot_r: 'ball_r',
  thigh_l: 'calf_l',
  calf_l: 'foot_l',
  foot_l: 'ball_l',
  spine_01: 'spine_03',
  upperarm_l: 'lowerarm_l',
  lowerarm_l: 'hand_l',
  upperarm_r: 'lowerarm_r',
  lowerarm_r: 'hand_r',
  neck_01: 'Head',
  pelvis: 'spine_01',
};
const KICK_ORDER = ['spine_01', 'thigh_l', 'calf_l', 'thigh_r', 'calf_r', 'foot_r', 'upperarm_l', 'lowerarm_l', 'upperarm_r', 'lowerarm_r'];

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();

export class Footballer {
  /** Place and turn this group; the model faces +z inside it. */
  readonly root = new THREE.Group();
  readonly mixer: THREE.AnimationMixer;
  readonly bones = new Map<string, THREE.Bone>();
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  currentName = '';
  /** Seconds relative to the strike while kicking (null = not kicking). */
  kickT: number | null = null;
  /** Keeper overlays. */
  keeperReady = 0;
  dive: { t: number; side: number; reach: THREE.Vector3; dur: number; base: THREE.Vector3; yaw: number } | null = null;
  /** World point the head turns toward. */
  lookAt: THREE.Vector3 | null = null;
  lookWeight = 0;
  private materials: THREE.Material[] = [];
  private kitUniforms: Record<string, { value: unknown }> | null = null;
  private hairMat: THREE.MeshStandardMaterial | null = null;
  /** The face's forward axis in the head bone's local frame (from the bind pose). */
  private headFwd = new THREE.Vector3(0, 0, 1);

  constructor(
    readonly model: THREE.Group,
    clips: Map<string, THREE.AnimationClip>,
    kit: Kit,
    look: Look,
    face: boolean,
    mats: Map<string, THREE.MeshStandardMaterial>,
  ) {
    this.root.add(model);
    model.traverse((o) => {
      const b = o as THREE.Bone;
      if (b.isBone) this.bones.set(b.name, b);
      const m = o as THREE.SkinnedMesh;
      if (!m.isMesh) return;
      const own = m.material as THREE.MeshStandardMaterial;
      const src = mats.get(own.name) ?? own;
      if (src.name === 'MI_Superhero_Male') {
        // Positions are quantized: recover bind-pose metres from the rest skeleton (bone world × inverse bind).
        model.updateMatrixWorld(true);
        const sk = m.skeleton;
        const dequant = sk ? new THREE.Matrix4().multiplyMatrices(sk.bones[0].matrixWorld, sk.boneInverses[0]) : new THREE.Matrix4();
        const km = kitMaterial(src, kit, look, dequant);
        this.kitUniforms = km.userData.uniforms;
        m.material = km;
      } else if (m.name === 'Hair') {
        const h = src.clone();
        h.color = new THREE.Color(look.hair);
        h.roughness = 0.7;
        this.hairMat = h;
        m.material = h;
      } else {
        const fm = src.clone() as THREE.MeshStandardMaterial;
        if (fm.name === 'MI_Eyes') fm.color = new THREE.Color(0.45, 0.42, 0.4);
        m.material = fm;
        if (!face) m.visible = false;
        m.castShadow = false;
      }
      this.materials.push(m.material as THREE.Material);
    });
    this.mixer = new THREE.AnimationMixer(model);
    for (const [name, clip] of clips) this.actions.set(name, this.mixer.clipAction(clip));
    const head = this.bones.get('Head');
    if (head) {
      model.updateMatrixWorld(true);
      this.headFwd.set(0, 0, 1).applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()).invert());
    }
  }

  has(name: string): boolean {
    return this.actions.has(name);
  }

  /** Cross-fade to a clip. */
  play(name: string, fade = 0.25, opts: { once?: boolean; speed?: number; at?: number } = {}): void {
    const a = this.actions.get(name);
    if (!a) return;
    a.timeScale = opts.speed ?? 1;
    if (this.current === a && !opts.once) return;
    a.reset();
    a.setLoop(opts.once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = !!opts.once;
    if (opts.at !== undefined) a.time = opts.at * a.getClip().duration;
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.play();
    if (this.current && this.current !== a) this.current.crossFadeTo(a, fade, false);
    this.current = a;
    this.currentName = name;
  }

  speed(s: number): void {
    if (this.current) this.current.timeScale = s;
  }

  /** Dive toward a world point (side: -1/1 along world x, 0 = stay and smother). */
  startDive(side: number, reach: THREE.Vector3, dur = 0.55): void {
    this.dive = { t: 0, side, reach: reach.clone(), dur, base: this.root.position.clone(), yaw: this.root.rotation.y };
    this.keeperReady = 0;
    this.play('Jump_Loop', 0.12);
  }

  private diveRoot(dt: number): void {
    const d = this.dive!;
    d.t += dt;
    const k = Math.min(1, d.t / d.dur);
    const e = 1 - Math.pow(1 - k, 3);
    const reachX = d.side === 0 ? 0 : (d.reach.x - d.base.x) * 0.62;
    const lift = Math.sin(k * Math.PI) * (d.side === 0 ? 0.12 : 0.45) + (d.reach.y - 1) * 0.25 * e;
    this.root.position.set(d.base.x + reachX * e, Math.max(0, lift), d.base.z - 0.2 * e);
    // Roll about the facing axis so the body falls toward the dive side.
    const rollSign = -d.side * Math.sign(Math.cos(d.yaw) || 1);
    this.root.rotation.set(0, d.yaw, rollSign * 1.25 * e);
  }

  update(dt: number): void {
    if (this.dive) this.diveRoot(dt);
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);
    if (this.kickT !== null) this.applyKick(this.kickT);
    if (this.keeperReady > 0 && !this.dive) this.applyReady(this.keeperReady);
    if (this.dive) this.applyDive();
    if (this.lookAt && this.lookWeight > 0) this.applyLook();
  }

  /** Rotate `name` so that the direction to its child bone moves toward `dirWorld` by weight w. */
  private aim(name: string, dirWorld: THREE.Vector3, w: number): void {
    const bone = this.bones.get(name);
    const child = this.bones.get(CHILD[name]);
    if (!bone || !child || !bone.parent || w <= 0) return;
    const a = bone.getWorldPosition(_v1);
    const b = child.getWorldPosition(_v2);
    const cur = b.sub(a).normalize();
    const target = _v3.copy(cur).lerp(dirWorld, Math.min(1, w)).normalize();
    const rot = _q1.setFromUnitVectors(cur, target);
    const parentQ = bone.parent.getWorldQuaternion(_q2);
    const boneQ = bone.getWorldQuaternion(_q3);
    // local' = parent^-1 * rot * boneWorld
    boneQ.premultiply(rot);
    bone.quaternion.copy(parentQ.invert().multiply(boneQ));
    bone.updateMatrixWorld(true);
  }

  private toWorldDir(v: THREE.Vector3): THREE.Vector3 {
    return v.applyQuaternion(this.root.getWorldQuaternion(_q2.identity())).normalize();
  }

  private applyKick(t: number): void {
    const w = Math.min(smooth((t + 0.5) / 0.22), 1 - smooth((t - 0.42) / 0.38));
    if (w <= 0) return;
    const d = new THREE.Vector3();
    for (const name of KICK_ORDER) {
      keyed(KICK[name], t, d);
      this.aim(name, this.toWorldDir(d), w);
    }
  }

  /** Goalkeeper set position: knees bent, arms out. */
  private applyReady(w: number): void {
    const set: [string, Vec][] = [
      ['spine_01', [0, 0.93, 0.36]],
      ['thigh_l', [0.25, -0.85, 0.45]],
      ['calf_l', [0.08, -0.95, -0.3]],
      ['thigh_r', [-0.25, -0.85, 0.45]],
      ['calf_r', [-0.08, -0.95, -0.3]],
      ['upperarm_l', [0.7, -0.6, 0.4]],
      ['lowerarm_l', [0.35, -0.2, 0.9]],
      ['upperarm_r', [-0.7, -0.6, 0.4]],
      ['lowerarm_r', [-0.35, -0.2, 0.9]],
    ];
    const d = new THREE.Vector3();
    for (const [n, v] of set) this.aim(n, this.toWorldDir(d.set(...v).normalize()), w);
  }

  /** Full-stretch dive toward a world point. */
  private applyDive(): void {
    const dv = this.dive!;
    const k = Math.min(1, dv.t / dv.dur);
    const w = smooth(k / 0.35);
    // Arms reach toward the target, legs trail.
    const d = new THREE.Vector3();
    const s = dv.side;
    const reachDir = (bone: string) => {
      const p = this.bones.get(bone)!.getWorldPosition(new THREE.Vector3());
      return dv.reach.clone().sub(p).normalize();
    };
    if (s === 0) {
      this.aim('upperarm_l', this.toWorldDir(d.set(0.35, -0.3, 0.9).normalize()), w);
      this.aim('upperarm_r', this.toWorldDir(d.set(-0.35, -0.3, 0.9).normalize()), w);
      this.aim('thigh_l', this.toWorldDir(d.set(0.2, -0.9, 0.35).normalize()), w);
      this.aim('thigh_r', this.toWorldDir(d.set(-0.2, -0.9, 0.35).normalize()), w);
      return;
    }
    this.aim('spine_01', reachDir('spine_01').lerp(this.toWorldDir(d.set(0, 1, 0)), 0.5).normalize(), w * 0.7);
    for (const arm of ['upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r']) this.aim(arm, reachDir(arm), w);
    const legOut = this.toWorldDir(d.set(-s * 0.35, -0.9, -0.2).normalize());
    this.aim('thigh_l', legOut, w * 0.8);
    this.aim('thigh_r', legOut.clone().add(this.toWorldDir(new THREE.Vector3(0, 0, 0.3))).normalize(), w * 0.8);
    this.aim('calf_l', this.toWorldDir(d.set(-s * 0.3, -0.85, -0.45).normalize()), w * 0.7);
    this.aim('calf_r', this.toWorldDir(d.set(-s * 0.3, -0.9, -0.2).normalize()), w * 0.7);
  }

  private applyLook(): void {
    const head = this.bones.get('Head');
    if (!head || !head.parent) return;
    const hp = head.getWorldPosition(_v1);
    const to = _v2.copy(this.lookAt!).sub(hp).normalize();
    const headQ = head.getWorldQuaternion(_q3);
    const cur = _v3.copy(this.headFwd).applyQuaternion(headQ).normalize();
    // Only turn within a comfortable cone around where the face points now.
    if (to.dot(cur) < 0.1) return;
    const target = cur.clone().lerp(to, Math.min(1, this.lookWeight * 0.85)).normalize();
    headQ.premultiply(_q1.setFromUnitVectors(cur, target));
    head.quaternion.copy(head.parent.getWorldQuaternion(_q2).invert().multiply(headQ));
    head.updateMatrixWorld(true);
  }

  /** Swap the player's look (another team mate stepping up). */
  setLook(look: Look): void {
    if (this.kitUniforms) {
      this.kitUniforms.uNum.value = look.number;
      this.kitUniforms.uSkin.value = look.skin;
    }
    this.hairMat?.color.set(look.hair);
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  /** World position of a bone. */
  bonePos(name: string, out = new THREE.Vector3()): THREE.Vector3 {
    const b = this.bones.get(name);
    return b ? b.getWorldPosition(out) : out.copy(this.root.position);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.materials.forEach((m) => m.dispose());
  }
}

function smooth(x: number): number {
  const k = Math.max(0, Math.min(1, x));
  return k * k * (3 - 2 * k);
}
