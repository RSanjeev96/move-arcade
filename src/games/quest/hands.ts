/**
 * The player's cartoon gloves at the bottom of the view. They bob with each step, fly up on jumps, recoil
 * on landing and thrust out with a muzzle flash when punching (shooting).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { glowTexture } from './fx';

interface Glove {
  root: THREE.Group;
  fist: THREE.Group;
  gem: THREE.MeshStandardMaterial;
  flash: THREE.Sprite;
  punch: number;
  aim: THREE.Vector3;
  rest: THREE.Vector3;
}

function makeGlove(side: -1 | 1, cuffColor: string): Glove {
  const white = new THREE.MeshStandardMaterial({ color: '#fbfbff', roughness: 0.55, metalness: 0 });
  const cuffMat = new THREE.MeshStandardMaterial({ color: cuffColor, roughness: 0.45, metalness: 0.1 });
  const gem = new THREE.MeshStandardMaterial({ color: '#7ff6ff', emissive: '#3fe6ff', emissiveIntensity: 1.2, roughness: 0.2 });
  const fist = new THREE.Group();
  // Palm and back of the hand.
  const palm = new THREE.Mesh(new RoundedBoxGeometry(0.105, 0.09, 0.11, 4, 0.035), white);
  fist.add(palm);
  // Curled fingers: four knuckle bumps across the front.
  for (let i = 0; i < 4; i++) {
    const k = new THREE.Mesh(new THREE.SphereGeometry(0.024, 12, 10), white);
    k.scale.set(1, 1.1, 1.25);
    k.position.set(-0.036 + i * 0.024, 0.012 - Math.abs(i - 1.5) * 0.004, -0.058);
    fist.add(k);
    const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.03, 4, 10), white);
    f.rotation.x = Math.PI / 2;
    f.position.set(-0.036 + i * 0.024, -0.02, -0.045);
    fist.add(f);
  }
  // Thumb wraps the inner side.
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.019, 0.05, 4, 10), white);
  thumb.rotation.set(0.3, 0, Math.PI / 2 - side * 0.5);
  thumb.position.set(-side * 0.045, -0.025, -0.02);
  fist.add(thumb);
  // Seams on the back of the glove.
  const seamMat = new THREE.MeshStandardMaterial({ color: '#d8d8e8', roughness: 0.7 });
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.003, 0.06), seamMat);
    s.position.set(-0.02 + i * 0.02, 0.046, 0.0);
    fist.add(s);
  }
  // Energy gem on the back of the hand: the "blaster".
  const g = new THREE.Mesh(new THREE.OctahedronGeometry(0.022, 0), gem);
  g.position.set(0, 0.05, 0.005);
  g.scale.set(1, 0.6, 1.3);
  fist.add(g);
  // Puffy cuff ring at the wrist.
  const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.047, 0.02, 10, 20), cuffMat);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.z = 0.068;
  fist.add(cuff);
  const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.05, 14), white);
  wrist.rotation.x = Math.PI / 2;
  wrist.position.z = 0.09;
  fist.add(wrist);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: '#8ff8ff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  flash.position.set(0, 0.0, -0.1);
  flash.scale.setScalar(0.22);
  fist.add(flash);
  const root = new THREE.Group();
  fist.scale.setScalar(0.8);
  root.add(fist);
  const rest = new THREE.Vector3(side * 0.2, -0.17, -0.46);
  root.position.copy(rest);
  fist.rotation.set(0.55, -side * 0.3, -side * 0.2);
  return { root, fist, gem, flash, punch: 0, aim: new THREE.Vector3(0, 0, -1), rest };
}

export class Hands {
  readonly scene = new THREE.Scene();
  readonly group = new THREE.Group();
  private gloves: [Glove, Glove];
  private bob = 0;
  private lift = 0;
  private dip = 0;
  private flashTone = new THREE.Color('#8ff8ff');

  constructor(sunDir: THREE.Vector3, hemiSky: string, hemiGround: string) {
    this.gloves = [makeGlove(-1, '#ff7a3d'), makeGlove(1, '#3dc8ff')];
    this.group.add(this.gloves[0].root, this.gloves[1].root);
    this.scene.add(this.group);
    this.scene.add(new THREE.HemisphereLight(hemiSky, hemiGround, 1.6));
    const d = new THREE.DirectionalLight('#ffffff', 2.0);
    d.position.copy(sunDir).multiplyScalar(5);
    this.scene.add(d);
    const fill = new THREE.DirectionalLight('#bcd8ff', 0.6);
    fill.position.set(0, 1, 2);
    this.scene.add(fill);
  }

  /** Punch with a hand toward a camera-space direction. */
  punch(hand: 0 | 1, dirCam: THREE.Vector3, color?: THREE.Color): void {
    const g = this.gloves[hand];
    g.punch = 1;
    g.aim.copy(dirCam).normalize();
    (g.flash.material as THREE.SpriteMaterial).color.copy(color ?? this.flashTone);
  }

  /** Muzzle position of a hand in camera space (where bolts start). */
  muzzle(hand: 0 | 1): THREE.Vector3 {
    const g = this.gloves[hand];
    return g.root.position.clone().add(new THREE.Vector3(0, 0.02, -0.12));
  }

  land(strength: number): void {
    this.dip = Math.min(1, this.dip + strength);
  }

  update(dt: number, o: { stepPhase: number; running: number; vy: number; ducking: boolean; time: number; hurt: boolean; tint: THREE.Color | null }): void {
    this.bob += (o.running - this.bob) * Math.min(1, dt * 6);
    this.lift += ((o.vy > 0.5 ? Math.min(1, o.vy / 8) : o.vy < -2 ? -0.3 : 0) - this.lift) * Math.min(1, dt * 8);
    this.dip = Math.max(0, this.dip - dt * 3.5);
    for (const hand of [0, 1] as const) {
      const g = this.gloves[hand];
      const side = hand === 0 ? -1 : 1;
      const ph = o.stepPhase + (hand === 0 ? 0 : Math.PI);
      const pump = Math.sin(ph) * 0.035 * this.bob;
      const p = g.rest.clone();
      p.y += pump + this.lift * 0.07 - this.dip * 0.05 + Math.sin(o.time * 1.7 + hand) * 0.004 + (o.ducking ? 0.05 : 0);
      p.z += Math.cos(ph) * 0.02 * this.bob;
      p.x += (o.ducking ? -side * 0.02 : 0) + side * this.lift * 0.03;
      // Punch: snap out along the aim, then ease back.
      if (g.punch > 0) {
        const k = g.punch;
        const out = k > 0.75 ? (1 - k) / 0.25 : Math.pow(k / 0.75, 1.6);
        p.addScaledVector(g.aim, 0.22 * out);
        p.x += -side * 0.05 * out;
        g.punch = Math.max(0, g.punch - dt * 3.6);
        (g.flash.material as THREE.SpriteMaterial).opacity = out * 0.95;
        g.flash.scale.setScalar(0.12 + out * 0.22);
      } else (g.flash.material as THREE.SpriteMaterial).opacity = 0;
      g.root.position.copy(p);
      g.fist.rotation.set(0.55 + this.lift * 0.4 - (g.punch > 0 ? 0.35 : 0), -side * 0.3 + (g.punch > 0 ? side * 0.25 : 0), -side * 0.2 + pump * 2);
      g.gem.emissiveIntensity = 1.0 + 0.4 * Math.sin(o.time * 5 + hand) + (g.punch > 0 ? 1.5 : 0);
      if (o.tint) g.gem.emissive.copy(o.tint);
      else g.gem.emissive.set('#3fe6ff');
    }
    this.group.visible = !(o.hurt && Math.floor(o.time * 14) % 2 === 0);
  }

  follow(cam: THREE.Camera): void {
    this.group.position.copy(cam.position);
    this.group.quaternion.copy(cam.quaternion);
  }
}
