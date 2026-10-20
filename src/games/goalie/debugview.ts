/**
 * Developer views for tuning art (only reachable with ?gkview=...): kit lineup, kick from the side.
 */
import * as THREE from 'three';
import { AWAY, HOME } from './match';
import type { Footballer, PeopleKit } from './people';
import type { World } from './world';

export function debugView(world: World, people: PeopleKit, view: string): void {
  const g = new THREE.Group();
  world.scene.add(g);
  const players: Footballer[] = [];
  const cam = world.camera;
  if (view === 'kit') {
    const kits = [HOME.kit, AWAY.normal.kit, AWAY.easy.kit, AWAY.hard.kit, HOME.keeper, AWAY.normal.keeper];
    kits.forEach((k, i) => {
      const p = people.make(k, { number: 7 + i * 3, skin: i / 6, hair: '#2a1c12' }, { lod: i % 2 === 1 });
      p.root.position.set((i - 2.5) * 1.1, 0, -8);
      p.root.rotation.y = i % 2 ? Math.PI : 0.3;
      p.play(i === 2 ? 'Jog_Fwd_Loop' : 'Idle_Loop', 0);
      g.add(p.root);
      players.push(p);
    });
    world.step = (dt) => {
      world.hfov = 50;
      world.updateFov();
      cam.position.set(0, 1.3, -2.2);
      cam.lookAt(0, 1.0, -8);
      for (const p of players) p.update(dt);
    };
  } else if (view === 'dive') {
    // The AI keeper at four moments of a dive, seen from the penalty taker's camera.
    const ts = [0.08, 0.2, 0.35, 0.6];
    ts.forEach((t, i) => {
      const k = people.make(AWAY.normal.keeper, { number: 1, skin: 0.4, hair: '#14100c' });
      k.root.position.set(0, 0, -0.15 - i * 3.2);
      k.root.rotation.y = Math.PI;
      k.play('Idle_Loop', 0);
      const side = i % 2 ? -1 : 1;
      k.startDive(side, new THREE.Vector3(side * 2.8, i === 3 ? 0.4 : 1.6, -0.25 - i * 3.2));
      k.update(t);
      g.add(k.root);
      players.push(k);
    });
    world.step = () => {
      world.hfov = 60;
      world.updateFov();
      cam.position.set(0, 2.2, -16);
      cam.lookAt(0, 0.8, -4);
      for (const p of players) p.update(0.00001);
    };
  } else if (view === 'bench') {
    // Frame-time benchmark: hide one part of the stadium at a time.
    const st = world.stadium;
    const parts: Record<string, THREE.Object3D[]> = {};
    st.group.children.forEach((c, i) => {
      const m = c as THREE.Mesh;
      const key = m === st.crowd.mesh ? 'crowd' : m === st.boards.mesh ? 'boards' : c === st.near.group || c === st.far.group ? 'goals' : (m.material as THREE.Material | undefined)?.type ?? c.type;
      (parts[key] ??= []).push(c);
      void i;
    });
    const keys = ['none', ...Object.keys(parts), 'all'];
    let ki = 0;
    let n = 0;
    let t0 = 0;
    world.step = (_dt, now) => {
      world.hfov = 78;
      world.updateFov();
      cam.position.set(0, 1.95, 5.6);
      cam.lookAt(0, 0.95, -9);
      if (n === 0) {
        for (const k of Object.keys(parts)) for (const o of parts[k]) o.visible = keys[ki] === 'all' ? false : keys[ki] !== k;
        t0 = now;
      }
      n++;
      if (n === 4) {
        console.log(`[bench] without ${keys[ki]}: ${((now - t0) / 3).toFixed(0)} ms/frame`);
        n = 0;
        ki = (ki + 1) % keys.length;
      }
    };
  } else if (view === 'kick' || view === 'kickf') {
    // Five takers frozen at different moments of the strike, seen from the side (or the front).
    const ts = [-0.32, -0.13, 0, 0.17, 0.45];
    ts.forEach((kt, i) => {
      const p = people.make(AWAY.normal.kit, { number: 9, skin: 0.3, hair: '#14100c' });
      p.root.position.set(0, 0, -11 + (i - 2) * 1.6);
      if (view === 'kickf') p.root.position.set((i - 2) * 1.4, 0, -11);
      p.play('Idle_Loop', 0);
      p.kickT = kt;
      g.add(p.root);
      players.push(p);
    });
    world.step = () => {
      world.hfov = 46;
      world.updateFov();
      if (view === 'kick') {
        cam.position.set(-8.5, 1.0, -11);
        cam.lookAt(0, 0.8, -11);
      } else {
        cam.position.set(0, 1.2, -4);
        cam.lookAt(0, 0.8, -11);
      }
      for (const p of players) p.update(0.0001);
    };
  }
}
