/** The player in goal: two 3D keeper gloves at the mapped hand positions and a translucent body. */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KEEPER_Z, type KeeperPose } from './logic';
import { glowTexture } from './textures';
import type { V2 } from '../../core/types';

const GLOVE_SCALE = 1.85;

function paint(g: THREE.BufferGeometry, fn: (n: THREE.Vector3, p: THREE.Vector3) => THREE.Color): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  const pos = ng.getAttribute('position');
  const nor = ng.getAttribute('normal');
  const col = new Float32Array(pos.count * 3);
  const n = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    n.fromBufferAttribute(nor, i);
    p.fromBufferAttribute(pos, i);
    const c = fn(n, p);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  for (const k of Object.keys(ng.attributes)) if (!['position', 'normal', 'color'].includes(k)) ng.deleteAttribute(k);
  return ng;
}

/** A right-hand keeper glove: palm faces -z (toward the pitch), fingers along +y, thumb toward -x. */
function gloveGeometry(main: THREE.Color, accent: THREE.Color): THREE.BufferGeometry {
  const latex = new THREE.Color('#e3e6dc');
  const dark = new THREE.Color('#15171c');
  const parts: THREE.BufferGeometry[] = [];
  const skin = (g: THREE.BufferGeometry) =>
    paint(g, (n, p) => {
      if (n.z < -0.35) return latex;
      // A stripe across the back of the hand.
      if (p.y > 0.05 && p.y < 0.075 && n.z > 0.2) return accent;
      return main;
    });
  const palm = new RoundedBoxGeometry(0.105, 0.115, 0.05, 3, 0.02);
  palm.translate(0, 0.055, 0);
  parts.push(skin(palm));
  const fingers = [
    { x: 0.037, len: 0.068, rz: -0.1 },
    { x: 0.0125, len: 0.084, rz: -0.03 },
    { x: -0.0125, len: 0.08, rz: 0.03 },
    { x: -0.037, len: 0.07, rz: 0.1 },
  ];
  for (const f of fingers) {
    const c = new THREE.CapsuleGeometry(0.0135, f.len, 4, 10);
    c.translate(0, f.len / 2 + 0.008, 0);
    c.rotateZ(f.rz);
    c.translate(f.x, 0.108, 0.002);
    parts.push(skin(c));
  }
  const thumb = new THREE.CapsuleGeometry(0.016, 0.058, 4, 10);
  thumb.translate(0, 0.03, 0);
  thumb.rotateZ(0.95);
  thumb.translate(-0.05, 0.035, -0.008);
  parts.push(skin(thumb));
  const cuff = new THREE.CylinderGeometry(0.046, 0.044, 0.075, 18, 1);
  cuff.scale(1, 1, 0.72);
  cuff.translate(0, -0.03, 0);
  parts.push(paint(cuff, (n, p) => (p.y > -0.04 && p.y < -0.012 && n.z > -0.2 ? accent : dark)));
  const g = mergeGeometries(parts);
  g.scale(GLOVE_SCALE, GLOVE_SCALE, GLOVE_SCALE);
  g.computeBoundingSphere();
  return g;
}

/** Translucent, rim-lit material for the keeper's body. */
function ghostMaterial(color: THREE.Color): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.14, roughness: 0.4, metalness: 0, depthWrite: false, emissive: color, emissiveIntensity: 0.18 });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float rim = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 2.2);
       outgoingLight += emissive * rim * 3.0;
       diffuseColor.a = clamp(diffuseColor.a * (1.0 + rim * 3.5), 0.0, 0.8);
       #include <opaque_fragment>`,
    );
  };
  return m;
}

export class KeeperAvatar {
  readonly group = new THREE.Group();
  readonly gloves: [THREE.Mesh, THREE.Mesh];
  private parts: Record<string, THREE.Mesh> = {};
  private cyl = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true);
  private sph = new THREE.SphereGeometry(1, 16, 12);
  private ghost: THREE.MeshStandardMaterial;
  private bump: [number, number] = [0, 0];
  private shadow: THREE.Mesh;
  private glowTex: THREE.Texture;
  /** Smoothed pose for display. */
  private shown: KeeperPose | null = null;
  private visibleAmt = 1;

  constructor(kit: { main: string; accent: string; body: string }) {
    const gg = gloveGeometry(new THREE.Color(kit.main), new THREE.Color(kit.accent));
    const gm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, envMapIntensity: 0.8 });
    const r = new THREE.Mesh(gg, gm);
    const l = new THREE.Mesh(gg, gm);
    l.scale.x = -1;
    for (const g of [l, r]) {
      g.castShadow = true;
      g.renderOrder = 4;
    }
    this.gloves = [l, r];
    this.ghost = ghostMaterial(new THREE.Color(kit.body).lerp(new THREE.Color(0xffffff), 0.35));
    const add = (name: string, geo: THREE.BufferGeometry) => {
      const m = new THREE.Mesh(geo, this.ghost);
      m.renderOrder = 3;
      this.parts[name] = m;
      this.group.add(m);
    };
    add('torso', new THREE.CapsuleGeometry(1, 1, 6, 16));
    add('head', this.sph);
    for (const n of ['uaL', 'uaR', 'faL', 'faR', 'thL', 'thR', 'shL', 'shR']) add(n, this.cyl);
    for (const n of ['jsL', 'jsR', 'jeL', 'jeR', 'jkL', 'jkR']) add(n, this.sph);
    this.group.add(l, r);
    this.glowTex = glowTexture(64);
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.7), new THREE.MeshBasicMaterial({ map: this.glowTex, color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.group.add(this.shadow);
  }

  /** A glove touched the ball: squash it. */
  punch(hand: 'l' | 'r' | 'both' | 'body' | null): void {
    if (hand === 'l' || hand === 'both') this.bump[0] = 1;
    if (hand === 'r' || hand === 'both') this.bump[1] = 1;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  update(k: KeeperPose | null, dt: number, fade = 1): void {
    this.visibleAmt += (fade - this.visibleAmt) * Math.min(1, dt * 6);
    this.ghost.opacity = 0.17 * this.visibleAmt;
    if (!k || !k.ok) {
      this.group.visible = false;
      return;
    }
    this.group.visible = this.visibleAmt > 0.02;
    // Light smoothing for display only (judging uses the raw pose).
    const s = this.shown;
    const a = Math.min(1, dt * 22);
    const mix = (p: V2, q: V2): V2 => ({ x: p.x + (q.x - p.x) * a, y: p.y + (q.y - p.y) * a });
    this.shown = s
      ? { ok: true, l: mix(s.l, k.l), r: mix(s.r, k.r), lElbow: mix(s.lElbow, k.lElbow), rElbow: mix(s.rElbow, k.rElbow), sh: mix(s.sh, k.sh), hip: mix(s.hip, k.hip), head: mix(s.head, k.head), lFoot: mix(s.lFoot, k.lFoot), rFoot: mix(s.rFoot, k.rFoot) }
      : k;
    const p = this.shown;
    const z = KEEPER_Z;
    const V = (q: V2, dz = 0) => new THREE.Vector3(q.x, q.y, z + dz);
    // Torso tilts toward a far-reaching hand (dive).
    const reachL = p.sh.x - p.l.x;
    const reachR = p.r.x - p.sh.x;
    const dive = Math.max(0, Math.max(reachL, reachR) - 0.75);
    const side = reachR > reachL ? 1 : -1;
    const tilt = Math.min(0.85, dive * 0.65) * side;
    const hip = V(p.hip);
    const up = new THREE.Vector3(p.sh.x - p.hip.x, p.sh.y - p.hip.y, 0);
    const torsoLen = Math.max(0.35, up.length());
    up.normalize().applyAxisAngle(new THREE.Vector3(0, 0, -1), tilt);
    const shoulder = hip.clone().addScaledVector(up, torsoLen);
    const across = new THREE.Vector3(up.y, -up.x, 0);
    const shL = shoulder.clone().addScaledVector(across, -0.24);
    const shR = shoulder.clone().addScaledVector(across, 0.24);
    const torso = this.parts.torso;
    torso.position.copy(hip).addScaledVector(up, torsoLen * 0.5);
    torso.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    torso.scale.set(0.21, Math.max(0.1, (torsoLen - 0.3) / 1), 0.15);
    const head = this.parts.head;
    head.position.copy(shoulder).addScaledVector(up, 0.3);
    head.scale.setScalar(0.135);
    const gl = V(p.l, -0.06);
    const gr = V(p.r, -0.06);
    const limb = (name: string, a: THREE.Vector3, b: THREE.Vector3, r: number) => {
      const m = this.parts[name];
      const d = b.clone().sub(a);
      const len = d.length();
      m.position.copy(a).addScaledVector(d, 0.5);
      if (len > 1e-4) m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.divideScalar(len));
      m.scale.set(r, len, r);
    };
    const joint = (name: string, at: THREE.Vector3, r: number) => {
      const m = this.parts[name];
      m.position.copy(at);
      m.scale.setScalar(r);
    };
    // Elbows: keep the mapped bend but pull them toward the straight line if the arm over-stretches.
    const elbow = (sh: THREE.Vector3, e: V2, g: THREE.Vector3) => {
      const ev = V(e);
      return sh.clone().lerp(g, 0.5).lerp(ev, 0.6);
    };
    const eL = elbow(shL, p.lElbow, gl);
    const eR = elbow(shR, p.rElbow, gr);
    limb('uaL', shL, eL, 0.07);
    limb('uaR', shR, eR, 0.07);
    limb('faL', eL, gl, 0.06);
    limb('faR', eR, gr, 0.06);
    joint('jsL', shL, 0.08);
    joint('jsR', shR, 0.08);
    joint('jeL', eL, 0.065);
    joint('jeR', eR, 0.065);
    // Legs: when diving the trailing leg lifts.
    const fl = V(p.lFoot);
    const fr = V(p.rFoot);
    if (tilt > 0) fl.y += tilt * 0.6;
    if (tilt < 0) fr.y += -tilt * 0.6;
    const hipL = hip.clone().addScaledVector(across, -0.12);
    const hipR = hip.clone().addScaledVector(across, 0.12);
    const kneeL = hipL.clone().lerp(fl, 0.5).add(new THREE.Vector3(-0.06, 0, -0.08));
    const kneeR = hipR.clone().lerp(fr, 0.5).add(new THREE.Vector3(0.06, 0, -0.08));
    limb('thL', hipL, kneeL, 0.1);
    limb('thR', hipR, kneeR, 0.1);
    limb('shL', kneeL, fl, 0.075);
    limb('shR', kneeR, fr, 0.075);
    joint('jkL', kneeL, 0.085);
    joint('jkR', kneeR, 0.085);
    // Gloves follow the forearm direction; palms to the pitch.
    for (const [i, g, e] of [
      [0, gl, eL],
      [1, gr, eR],
    ] as const) {
      const m = this.gloves[i];
      const dir = g.clone().sub(e);
      dir.z = 0;
      const ang = Math.atan2(-dir.x, dir.y);
      this.bump[i] = Math.max(0, this.bump[i] - dt * 4);
      const b = this.bump[i];
      m.position.copy(g).add(new THREE.Vector3(0, 0, -0.05 * b));
      m.rotation.set(-0.12 - 0.5 * b, 0, ang);
      const sq = 1 + 0.25 * Math.sin(b * Math.PI);
      m.scale.set(i === 0 ? -sq : sq, sq, sq);
    }
    const mid = (p.lFoot.x + p.rFoot.x) / 2;
    this.shadow.position.set(mid, 0.015, z);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.4 * this.visibleAmt;
  }

  /** Current display positions of the gloves (world). */
  glovePos(i: 0 | 1): THREE.Vector3 {
    return this.gloves[i].position;
  }

  dispose(): void {
    this.gloves[0].geometry.dispose();
    (this.gloves[0].material as THREE.Material).dispose();
    this.cyl.dispose();
    this.sph.dispose();
    this.parts.torso.geometry.dispose();
    this.ghost.dispose();
    this.glowTex.dispose();
  }
}
