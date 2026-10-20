/**
 * Test aid (?posecheck=1): a contact sheet of the procedural animations, so poses can be checked in one
 * screenshot without playing a whole session. Not reachable from the menus.
 */
import * as THREE from 'three';
import { Renderer3D } from '../../core/render';
import type { GameEnv } from '../types';
import { Figure, figureMaterials, type Kit } from './world/figure';
import { makeBaseballBat, makeCricketBat } from './world/props';
import { poseBatter } from './batter';
import { buildBaseballWorld, buildCricketWorld } from './world/grounds';
import type { Sport } from './physics';
import { Hud } from './hud';
import { BaseballGame, CricketMatch } from './rules';

export async function poseCheck(env: GameEnv, which: string): Promise<void> {
  if (which === 'swing' || which === 'bbswing') return swingSheet(env, which === 'swing' ? 'cricket' : 'baseball');
  if (which.startsWith('hud')) return hudSheet(env, which);
  const el = document.createElement('div');
  el.className = 'bat game-root';
  el.innerHTML = '<canvas class="gl"></canvas>';
  env.root.replaceChildren(el);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fb6d8);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x446622, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 6, 8);
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 30), new THREE.MeshStandardMaterial({ color: 0x4c8a32 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.1, 100);
  const mats = figureMaterials();
  const kit: Kit = { skin: 0x8d5a3b, shirt: 0x0f7f73, trim: 0xffc93c, pants: 0x0b4f4a, shoes: 0xf4f4f4, head: 'cap', headColor: 0x0b4f4a };
  const n = 8;
  const figs: Figure[] = [];
  for (let i = 0; i < n; i++) {
    const f = new Figure(which === 'bat' ? { ...kit, shirt: 0x1d3a8a, pants: 0x162a66, head: 'helmet', headColor: 0x14204a, pads: 0xf4f4ef, gloves: 0xf0f0f0, longSleeves: true } : kit, mats);
    f.root.position.set((i - (n - 1) / 2) * 1.6, 0, 0);
    f.root.rotation.y = which === 'bowl' || which === 'pitch' || which === 'throw' ? Math.PI / 2 : 0;
    scene.add(f.root);
    figs.push(f);
    const u = i / (n - 1);
    if (which === 'bowl') f.bowl(u * 0.95);
    else if (which === 'pitch') f.pitch(u);
    else if (which === 'throw') f.throwBall(u);
    else if (which === 'run') f.run(u * Math.PI * 2, 1);
    else if (which === 'misc') {
      [() => f.idle(0), () => f.ready(0, 1), () => f.squat(0), () => f.catchAt(2.0, 0), () => f.catchAt(0.6, 0), () => f.pickup(0.5), () => f.signal('six', 0), () => f.celebrate(0.3)][i]();
    }
  }
  if (which === 'bats') {
    for (const f of figs) f.root.visible = false;
    const dirs = [
      [0, -1, 0],
      [0, 1, 0],
      [0.4, 0.9, 0.3],
      [1, 0, 0],
      [0, 0, 1],
      [-0.5, 0.5, -0.5],
      [0, -1, 0.4],
      [0.6, -0.6, 0.5],
    ];
    dirs.forEach((d, i) => {
      const bat = makeCricketBat();
      bat.position.set((i - 3.5) * 1.6, 1.4, 0);
      const dir = new THREE.Vector3(d[0], d[1], d[2]).normalize();
      bat.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
      scene.add(bat);
    });
  }
  if (which === 'bat') {
    // Batter stance from behind with a bat in the hands.
    for (const f of figs) {
      f.root.rotation.y = Math.PI / 2;
      f.root.updateMatrixWorld(true);
      const bat = makeCricketBat();
      const g = f.root.position.clone().add(new THREE.Vector3(0.35, 1.0, 0));
      bat.position.copy(g);
      scene.add(bat);
      f.reachArm('L', g.clone(), f.root.position.clone().add(new THREE.Vector3(0, 0.6, -0.6)));
      f.reachArm('R', g.clone().add(new THREE.Vector3(0, -0.11, 0)), f.root.position.clone().add(new THREE.Vector3(0, 0.5, 0.8)));
    }
  }
  camera.position.set(0, 1.4, which === 'bat' ? -9 : 14);
  camera.lookAt(0, 1.0, 0);
  const canvas = el.querySelector('canvas') as HTMLCanvasElement;
  const r3 = new Renderer3D(canvas, scene, camera, 'medium', { shadows: false });
  r3.resize();
  r3.render(0.016);
  (window as unknown as { __gameDebug: unknown }).__gameDebug = { posecheck: which, phase: 'posecheck' };
  await new Promise(() => {});
}

/** The batter at six points of a right-handed swing, seen from the real batting camera. */
async function swingSheet(env: GameEnv, sport: Sport): Promise<void> {
  const el = document.createElement('div');
  el.className = 'bat game-root';
  el.innerHTML = '<canvas class="gl" style="visibility:hidden"></canvas><canvas class="sheet" style="position:absolute;inset:0;width:100%;height:100%"></canvas>';
  env.root.replaceChildren(el);
  const world = sport === 'cricket' ? buildCricketWorld({ night: false, sky: null }) : buildBaseballWorld({ night: true, sky: null });
  const camera = new THREE.PerspectiveCamera(sport === 'cricket' ? 37 : 36, 16 / 9, 0.05, 2500);
  if (sport === 'cricket') {
    camera.position.set(0.35, 2.5, 6.1);
    camera.lookAt(0, 0.95, -17);
  } else {
    camera.position.set(0.5, 2.85, 6.2);
    camera.lookAt(-0.05, 1.0, -18);
  }
  const canvas = el.querySelector('canvas.gl') as HTMLCanvasElement;
  const sheet = el.querySelector('canvas.sheet') as HTMLCanvasElement;
  const r3 = new Renderer3D(canvas, world.scene, camera, 'medium', { shadows: true });
  const fig = new Figure(
    sport === 'cricket'
      ? { skin: 0x8d5a3b, shirt: 0x1d3a8a, trim: 0xff8a1f, pants: 0x162a66, shoes: 0xf4f4f4, head: 'helmet', headColor: 0x14204a, pads: 0xf4f4ef, gloves: 0xf0f0f0, longSleeves: true, back: { name: 'Big Hitter', number: '18' } }
      : { skin: 0x9a6444, shirt: 0xf3f3f3, trim: 0x0f2a5c, pants: 0xf3f3f3, shoes: 0x111111, head: 'bbhelmet', headColor: 0x0f2a5c, socks: 0x0f2a5c, gloves: 0xc8102e },
    figureMaterials(),
  );
  world.scene.add(fig.root);
  const bat = sport === 'cricket' ? makeCricketBat() : makeBaseballBat();
  world.scene.add(bat);
  // Stance, load, downswing, contact, follow-through, finish (body space grip, right-hander).
  const grips = [
    { x: 0.38, y: -1.25 },
    { x: 1.0, y: 0.05 },
    { x: 0.6, y: -0.8 },
    { x: 0.0, y: sport === 'cricket' ? -1.3 : -0.9 },
    { x: -0.6, y: -0.6 },
    { x: -1.05, y: 0.1 },
  ];
  r3.resize();
  const W = canvas.width;
  const H = canvas.height;
  sheet.width = W;
  sheet.height = H;
  const g = sheet.getContext('2d')!;
  grips.forEach((gp, i) => {
    poseBatter(fig, bat, gp, sport, 1);
    r3.render(0.016);
    const cx = (i % 3) * (W / 3);
    const cy = Math.floor(i / 3) * (H / 2);
    // Crop the lower middle of the frame where the batter is.
    g.drawImage(canvas, W * 0.2, H * 0.35, W * 0.5, H * 0.65, cx, cy, W / 3, H / 2);
    g.fillStyle = '#fff';
    g.font = '20px sans-serif';
    g.fillText(`grip ${gp.x}, ${gp.y}`, cx + 10, cy + 26);
  });
  (window as unknown as { __gameDebug: unknown }).__gameDebug = { posecheck: sport, phase: 'posecheck' };
  await new Promise(() => {});
}

/** HUD states over a still of the ground, to check layout and readability. */
async function hudSheet(env: GameEnv, which: string): Promise<void> {
  const base = import.meta.env.BASE_URL;
  const el = document.createElement('div');
  el.className = 'bat game-root';
  el.style.background = `url(${base}assets/bat/${which === 'hud-b' ? 'menu_baseball' : 'menu_cricket'}.jpg) center/cover`;
  env.root.replaceChildren(el);
  if (which === 'hud-b') {
    const hud = new Hud(el, 'inning', 'normal', 'baseball');
    const g = new BaseballGame('inning', 'normal');
    g.record({ kind: 'take', strike: false });
    g.record({ kind: 'miss' });
    g.record({ kind: 'inplay', result: 'single', distance: 40 });
    g.record({ kind: 'take', strike: false });
    g.record({ kind: 'take', strike: true });
    hud.baseballScore(g);
    hud.banner('HOME RUN!', '128 m · 420 ft', 'hr', 0);
    hud.info('<b>152</b> km/h <span>Fastball · Up and in</span>', 0);
    hud.timing('late', 70, 'Late');
    hud.distance('118 m', 0.62, 0.42);
  } else {
    const hud = new Hud(el, 'chase', 'normal', 'cricket');
    const m = new CricketMatch('chase', 'normal');
    for (const e of [
      { event: 'runs', runs: 1, distance: 20 },
      { event: 'four', runs: 4, distance: 62 },
      { event: 'dot', runs: 0, distance: 0 },
      { event: 'six', runs: 6, distance: 94 },
    ] as const)
      m.record(e);
    hud.cricketScore(m, ['1', '4', '•', '6']);
    hud.banner('SIX!', '94 m · Lofted cover drive', 'six', 0);
    hud.info('<b>142</b> km/h <span>Outswinger · Good length</span>', 0);
    hud.timing('perfect', 0, 'Sweet spot!');
    hud.distance('94 m', 0.6, 0.4);
    if (which === 'hud-t') hud.tutorial(true);
  }
  (window as unknown as { __gameDebug: unknown }).__gameDebug = { posecheck: which, phase: 'posecheck' };
  await new Promise(() => {});
}
