/** Coins (instanced), gems, hearts, power-up bubbles, mystery blocks and crates. */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { QuestAssets } from './assets';
import { glowTexture } from './fx';
import type { ItemDef, PowerKind } from './levels';

export const COIN_R = 0.62;

interface CoinState {
  position2Eye(eye: THREE.Vector3): number;
  x: number;
  y: number;
  z: number;
  taken: boolean;
  /** Animation after collection (0..1) or popping out of a block. */
  t: number;
  pop: boolean;
  vx: number;
  vy: number;
  vz: number;
}

/** All coins of a level in one instanced mesh, plus coins popped from blocks. */
export class Coins {
  readonly mesh: THREE.InstancedMesh;
  readonly list: CoinState[] = [];
  private dummy = new THREE.Object3D();
  private popStart: number;
  private popNext = 0;
  private static POPS = 40;

  constructor(defs: ItemDef[], assets: QuestAssets, mat: THREE.Material) {
    const coins = defs.filter((d) => d.kind === 'coin');
    const geo = assets.geo.get('coin-gold')!.clone();
    geo.translate(0, -0.2, 0);
    geo.scale(1.45, 1.45, 1.45);
    this.mesh = new THREE.InstancedMesh(geo, mat, coins.length + Coins.POPS);
    this.mesh.frustumCulled = false;
    const mk = (x: number, y: number, z: number, taken: boolean, pop: boolean): CoinState => ({
      x,
      y,
      z,
      taken,
      t: taken ? 1 : 0,
      pop,
      vx: 0,
      vy: 0,
      vz: 0,
      position2Eye(eye: THREE.Vector3) {
        return Math.hypot(this.x - eye.x, this.y - eye.y, this.z - eye.z);
      },
    });
    for (const c of coins) this.list.push(mk(c.x, c.y, -c.s, false, false));
    this.popStart = this.list.length;
    for (let i = 0; i < Coins.POPS; i++) this.list.push(mk(0, -999, 0, true, true));
  }

  /** Coins burst out of a block and fly to the player. */
  pop(at: THREE.Vector3, n: number): void {
    for (let i = 0; i < n; i++) {
      const c = this.list[this.popStart + this.popNext];
      this.popNext = (this.popNext + 1) % Coins.POPS;
      c.x = at.x;
      c.y = at.y;
      c.z = at.z;
      c.taken = false;
      c.t = -0.35 - i * 0.07;
      const a = (i / n) * Math.PI * 2;
      c.vx = Math.cos(a) * 1.5;
      c.vy = 7 + Math.random() * 2;
      c.vz = Math.sin(a) * 1.5;
    }
  }

  /** Collection test (call every physics substep so fast players never skip coins). */
  collect(feet: THREE.Vector3, height: number, magnet: number, dt: number, onCollect: () => void): void {
    for (const c of this.list) {
      if (c.taken || c.pop) continue;
      const dz = c.z - feet.z;
      if (dz > 2.5 || dz < -magnet - 2) continue;
      if (dz < 2 && dz > -1.5) {
        // Within the player's capsule (generous radius).
        const dx = c.x - feet.x;
        const dy = c.y - Math.max(feet.y + 0.3, Math.min(feet.y + height - 0.2, c.y));
        if (Math.hypot(dx, dy, dz) < COIN_R) {
          c.taken = true;
          c.t = 0;
          onCollect();
          continue;
        }
      }
      if (magnet > 0 && Math.abs(dz) < magnet && Math.abs(c.x - feet.x) < magnet) {
        const k = Math.min(1, dt * 7);
        c.x += (feet.x - c.x) * k;
        c.y += (feet.y + 1 - c.y) * k;
        c.z += (feet.z - 0.3 - c.z) * k;
      }
    }
    this.onPopCollect = onCollect;
  }

  private onPopCollect: () => void = () => {};

  /** Animate and draw (once per frame). Only coins near the player are written, packed at the front. */
  draw(dt: number, time: number, eye: THREE.Vector3, feet: THREE.Vector3, camQ: THREE.Quaternion): void {
    const d = this.dummy;
    const spin = time * 3.2;
    let n = 0;
    // Popped coins fly to the coin counter: upper-left of the view, a little way in front of the eye.
    const hudTarget = new THREE.Vector3(-0.9, 0.55, -1.8).applyQuaternion(camQ).add(eye);
    for (const c of this.list) {
      if (c.taken) {
        if (c.t >= 1) continue;
        // Fly up toward the camera and shrink.
        c.t += dt * 3.2;
        const k = Math.min(1, c.t);
        d.position.set(c.x + (eye.x - c.x) * k * 0.6, c.y + k * 1.4, c.z + (eye.z - c.z) * k * 0.6);
        d.rotation.set(0, spin * 3, 0);
        d.scale.setScalar(1.15 * (1 - k * k));
      } else {
        if (c.pop) {
          if (c.t < 0) {
            // Ballistic pop out of the block, then home in on the player.
            c.t += dt;
            c.vy -= 18 * dt;
            c.x += c.vx * dt;
            c.y += c.vy * dt;
            c.z += c.vz * dt;
          } else {
            const k = Math.min(1, dt * 7);
            c.x += (hudTarget.x - c.x) * k;
            c.y += (hudTarget.y - c.y) * k;
            c.z += (hudTarget.z - c.z) * k;
            c.t += dt;
            if (Math.hypot(c.x - hudTarget.x, c.y - hudTarget.y, c.z - hudTarget.z) < 0.35 || c.t > 1.2) {
              c.taken = true;
              c.t = 1;
              this.onPopCollect();
              continue;
            }
          }
        }
        if (c.z < feet.z - 170 || c.z > feet.z + 6) continue;
        d.position.set(c.x, c.y + (c.pop ? 0 : Math.sin(time * 2.4 + c.z * 0.3) * 0.06), c.z);
        d.rotation.set(0, spin + c.z * 0.15, 0);
        // Popped coins shrink as they reach the counter so they never fill the screen.
        d.scale.setScalar(c.pop && c.t > 0 ? Math.max(0.25, Math.min(1, c.position2Eye(eye) / 2.5)) : 1);
      }
      d.updateMatrix();
      this.mesh.setMatrixAt(n++, d.matrix);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get total(): number {
    return this.popStart;
  }
}

// ---- gems, hearts, power-ups --------------------------------------------------------------------------

export interface Pickup {
  def: ItemDef;
  group: THREE.Group;
  taken: boolean;
  t: number;
}

const POWER_COLOR: Record<PowerKind, string> = { triple: '#ffcf3a', shield: '#5fd0ff', magnet: '#ff6b8b' };
export const powerColor = (k: PowerKind) => new THREE.Color(POWER_COLOR[k]);

function powerIcon(kind: PowerKind): THREE.Object3D {
  const g = new THREE.Group();
  const mat = (c: string, e = 0.5) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: e, roughness: 0.35, metalness: 0.2 });
  if (kind === 'triple') {
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 1), mat('#ffd84d', 0.8));
      const a = (i / 3) * Math.PI * 2;
      m.position.set(Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0);
      g.add(m);
    }
  } else if (kind === 'shield') {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.3);
    shape.quadraticCurveTo(0.22, 0.26, 0.26, 0.2);
    shape.quadraticCurveTo(0.26, -0.12, 0, -0.32);
    shape.quadraticCurveTo(-0.26, -0.12, -0.26, 0.2);
    shape.quadraticCurveTo(-0.22, 0.26, 0, 0.3);
    const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 2 }), mat('#4fc3ff', 0.6));
    m.position.z = -0.04;
    g.add(m);
  } else {
    const m = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.07, 10, 24, Math.PI), mat('#ff4f6d', 0.5));
    m.rotation.z = Math.PI;
    g.add(m);
    for (const s of [-1, 1]) {
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.12, 12), mat('#e8eef5', 0.3));
      tip.position.set(s * 0.2, 0.06, 0);
      g.add(tip);
    }
  }
  return g;
}

let bubbleMat: THREE.MeshPhysicalMaterial | null = null;

export function makePickups(defs: ItemDef[], assets: QuestAssets, kitMat: THREE.Material): Pickup[] {
  const out: Pickup[] = [];
  const glow = glowTexture();
  for (const d of defs) {
    if (d.kind === 'coin') continue;
    const g = new THREE.Group();
    g.position.set(d.x, d.y, -d.s);
    let color = '#ffffff';
    if (d.kind === 'gem') {
      const m = new THREE.Mesh(assets.geo.get('jewel')!, kitMat);
      m.geometry.computeBoundingBox();
      m.scale.setScalar(2.6);
      m.position.y = -0.45;
      g.add(m);
      color = '#6fb4ff';
    } else if (d.kind === 'heart') {
      const m = new THREE.Mesh(assets.geo.get('heart')!, kitMat);
      m.scale.setScalar(2.2);
      m.position.y = -0.42;
      g.add(m);
      color = '#ff6b8b';
    } else {
      bubbleMat ??= new THREE.MeshPhysicalMaterial({ color: '#ffffff', transparent: true, opacity: 0.32, roughness: 0.05, metalness: 0, clearcoat: 1, emissive: '#bfe9ff', emissiveIntensity: 0.15, depthWrite: false });
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.48, 24, 16), bubbleMat);
      g.add(powerIcon(d.power!), b);
      color = POWER_COLOR[d.power!];
    }
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.setScalar(d.kind === 'power' ? 2.0 : 1.7);
    g.add(halo);
    out.push({ def: d, group: g, taken: false, t: 0 });
  }
  return out;
}

// ---- mystery blocks and crates ---------------------------------------------------------------------------

function blockTexture(used: boolean): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  if (used) {
    g.fillStyle = '#8f8278';
    g.fillRect(0, 0, S, S);
    g.fillStyle = '#7a6e66';
    for (let i = 0; i < 40; i++) g.fillRect(Math.random() * S, Math.random() * S, 10 + Math.random() * 20, 6 + Math.random() * 10);
    g.strokeStyle = '#5e544e';
    g.lineWidth = 14;
    g.strokeRect(10, 10, S - 20, S - 20);
  } else {
    const gr = g.createLinearGradient(0, 0, S, S);
    gr.addColorStop(0, '#ff5fb8');
    gr.addColorStop(0.5, '#a24dff');
    gr.addColorStop(1, '#3f6bff');
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
    // Gold frame with rivets.
    g.strokeStyle = '#ffd34d';
    g.lineWidth = 18;
    g.strokeRect(12, 12, S - 24, S - 24);
    g.strokeStyle = '#fff2a8';
    g.lineWidth = 4;
    g.strokeRect(24, 24, S - 48, S - 48);
    g.fillStyle = '#fff6c8';
    for (const [x, y] of [
      [26, 26],
      [S - 26, 26],
      [26, S - 26],
      [S - 26, S - 26],
    ]) {
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.fill();
    }
    // Big four-point sparkle star.
    const cx = S / 2;
    const cy = S / 2;
    g.shadowColor = 'rgba(255,255,255,0.9)';
    g.shadowBlur = 18;
    g.fillStyle = '#ffffff';
    g.beginPath();
    const R = 74;
    const r = 18;
    g.moveTo(cx, cy - R);
    g.quadraticCurveTo(cx + r, cy - r, cx + R, cy);
    g.quadraticCurveTo(cx + r, cy + r, cx, cy + R);
    g.quadraticCurveTo(cx - r, cy + r, cx - R, cy);
    g.quadraticCurveTo(cx - r, cy - r, cx, cy - R);
    g.fill();
    g.shadowBlur = 0;
    g.fillStyle = '#fff6b0';
    for (const [x, y, rr] of [
      [cx + 52, cy - 50, 9],
      [cx - 54, cy + 48, 7],
      [cx + 46, cy + 52, 5],
    ]) {
      g.beginPath();
      g.arc(x, y, rr, 0, Math.PI * 2);
      g.fill();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

let blockGeo: THREE.BufferGeometry | null = null;
let liveMat: THREE.MeshStandardMaterial | null = null;
let usedMat: THREE.MeshStandardMaterial | null = null;

export function mysteryMaterials(): { live: THREE.MeshStandardMaterial; used: THREE.MeshStandardMaterial; geo: THREE.BufferGeometry } {
  blockGeo ??= new RoundedBoxGeometry(1, 1, 1, 3, 0.09);
  if (!liveMat) {
    const t = blockTexture(false);
    liveMat = new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: '#ffffff', emissiveIntensity: 0.45, roughness: 0.35, metalness: 0.1 });
  }
  if (!usedMat) usedMat = new THREE.MeshStandardMaterial({ map: blockTexture(true), roughness: 0.9 });
  return { live: liveMat, used: usedMat, geo: blockGeo };
}
