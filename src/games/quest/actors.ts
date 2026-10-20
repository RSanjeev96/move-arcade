/** Enemies (animated Quaternius monsters) and the player's energy bolts. */
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { MonsterName, QuestAssets } from './assets';
import { glowTexture } from './fx';
import { LANE_W, laneX, type EnemyDef, type EnemyKind } from './levels';

const MODEL: Record<EnemyKind, MonsterName> = { blob: 'GreenBlob', pink: 'PinkBlob', spiky: 'GreenSpikyBlob', bee: 'Armabee', glub: 'Glub' };
/** Visual height of each kind (m). */
const HEIGHT: Record<EnemyKind, number> = { blob: 1.0, pink: 0.95, spiky: 1.45, bee: 0.95, glub: 1.0 };

export const flying = (k: EnemyKind) => k === 'bee' || k === 'glub';

export interface Enemy {
  def: EnemyDef;
  root: THREE.Group;
  model: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  x: number;
  y: number;
  z: number;
  alive: boolean;
  dying: number;
  /** Half-height of the hit body and its centre height above `y`. */
  r: number;
  cy: number;
  phase: number;
  wake: boolean;
  hitFlash: number;
}

export function makeEnemies(defs: EnemyDef[], assets: QuestAssets): Enemy[] {
  return defs.map((def, i) => {
    const src = assets.monsters[MODEL[def.kind]];
    const model = SkeletonUtils.clone(src.scene);
    const h = src.box.max.y - src.box.min.y;
    const s = HEIGHT[def.kind] / (def.kind === 'spiky' ? h * 0.75 : h);
    model.scale.setScalar(s);
    model.position.y = -src.box.min.y * s;
    const root = new THREE.Group();
    root.add(model);
    const mixer = new THREE.AnimationMixer(model);
    const actions = new Map<string, THREE.AnimationAction>();
    for (const c of src.clips) actions.set(c.name, mixer.clipAction(c));
    const idle = flying(def.kind) ? 'Flying_Idle' : def.sweep ? 'Walk' : 'Idle';
    const a = actions.get(idle);
    if (a) {
      a.play();
      a.time = (i * 0.37) % a.getClip().duration;
    }
    const fly = flying(def.kind);
    const e: Enemy = {
      def,
      root,
      model,
      mixer,
      actions,
      x: laneX(def.lane),
      y: def.y,
      z: -def.s,
      alive: true,
      dying: 0,
      r: fly ? 0.5 : def.kind === 'spiky' ? 0.6 : 0.5,
      cy: fly ? 0 : 0.5,
      phase: def.phase * Math.PI * 2,
      wake: false,
      hitFlash: 0,
    };
    root.position.set(e.x, e.y, e.z);
    root.visible = false;
    return e;
  });
}

/** Move an enemy along its patrol (pure function of time so respawns are consistent). */
export function enemyPose(e: Enemy, t: number, speed: number): void {
  const d = e.def;
  const w = (Math.PI * 2) / Math.max(0.5, d.period / speed);
  const sweep = d.sweep * LANE_W;
  let x = laneX(d.lane);
  if (d.sweep) x = Math.max(-LANE_W, Math.min(LANE_W, laneX(d.lane) + Math.sin(t * w + e.phase) * sweep));
  e.x = x;
  e.z = -d.s;
  if (flying(d.kind)) e.y = d.y + 0.35 * Math.sin(t * 2.1 + e.phase) + (d.kind === 'glub' ? 0.45 * Math.sin(t * w * 0.5 + e.phase) : 0);
  else e.y = d.y;
}

export function playOnce(e: Enemy, name: string, fade = 0.08): void {
  const a = e.actions.get(name);
  if (!a) return;
  for (const [n, other] of e.actions) if (n !== name) other.fadeOut(fade);
  a.reset();
  a.setLoop(THREE.LoopOnce, 1);
  a.clampWhenFinished = true;
  a.fadeIn(fade).play();
}

// ---- bolts --------------------------------------------------------------------------------------------

export interface Bolt {
  group: THREE.Group;
  core: THREE.Mesh;
  trail: THREE.Mesh;
  halo: THREE.Sprite;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: { pos: () => THREE.Vector3; alive: () => boolean } | null;
  life: number;
  active: boolean;
  color: THREE.Color;
}

export class Bolts {
  readonly group = new THREE.Group();
  readonly list: Bolt[] = [];
  private coreGeo = new THREE.IcosahedronGeometry(0.11, 2);
  private trailGeo: THREE.BufferGeometry;

  constructor() {
    const t = new THREE.CylinderGeometry(0.0, 0.1, 1, 10, 1, true);
    t.translate(0, 0.5, 0);
    t.rotateX(Math.PI / 2);
    this.trailGeo = t;
  }

  fire(from: THREE.Vector3, dir: THREE.Vector3, color: THREE.Color, target: Bolt['target'], speed = 36): Bolt {
    let b = this.list.find((x) => !x.active);
    if (!b) {
      const core = new THREE.Mesh(this.coreGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }));
      const trail = new THREE.Mesh(this.trailGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      halo.scale.setScalar(0.9);
      const group = new THREE.Group();
      group.add(core, trail, halo);
      this.group.add(group);
      b = { group, core, trail, halo, pos: new THREE.Vector3(), vel: new THREE.Vector3(), target: null, life: 0, active: false, color: new THREE.Color() };
      this.list.push(b);
    }
    b.active = true;
    b.life = 1.3;
    b.pos.copy(from);
    b.vel.copy(dir).normalize().multiplyScalar(speed);
    b.target = target;
    b.color.copy(color);
    (b.trail.material as THREE.MeshBasicMaterial).color.copy(color);
    (b.halo.material as THREE.SpriteMaterial).color.copy(color);
    b.group.visible = true;
    b.group.position.copy(from);
    return b;
  }

  /** Steps bolts; `hit` is asked whether a bolt at a position struck something (returns true to consume it). */
  update(dt: number, hit: (b: Bolt) => boolean): void {
    for (const b of this.list) {
      if (!b.active) continue;
      b.life -= dt;
      if (b.target && b.target.alive()) {
        // Homing (aim assist): turn toward the target.
        const want = b.target.pos().clone().sub(b.pos).normalize().multiplyScalar(b.vel.length());
        b.vel.lerp(want, Math.min(1, dt * 14));
      }
      // Small steps so fast bolts never tunnel through a target at low frame rates.
      const steps = Math.max(2, Math.ceil((b.vel.length() * dt) / 0.35));
      for (let i = 0; i < steps && b.active; i++) {
        b.pos.addScaledVector(b.vel, dt / steps);
        if (hit(b)) b.active = false;
      }
      if (b.life <= 0) b.active = false;
      b.group.visible = b.active;
      b.group.position.copy(b.pos);
      const dir = b.vel.clone().normalize();
      b.trail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.negate());
      b.trail.scale.set(1, 1, 1.4);
      b.halo.scale.setScalar(0.8 + Math.sin(b.life * 40) * 0.12);
    }
  }
}
