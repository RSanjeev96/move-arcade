/** Builds the cricket stadium and the ballpark: ground, markings, stands, crowd, lights, screens. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BASEBALL_PARK, CRICKET_FIELD, fenceDistance, ropeRadius } from '../outcome';
import type { Sport } from '../physics';
import { Crowd, buildBowl, floodlights, makeSky, type CrowdSeat } from './stadium';
import { Stumps, makeDiamondMarks } from './props';
import {
  BASEBALL_TEX,
  CRICKET_TEX_SIZE,
  PITCH_TEX,
  Screen,
  baseballGround,
  boardsTexture,
  canvas,
  cricketGround,
  cricketPitch,
  grassDetail,
  tex,
} from './textures';

export interface World {
  sport: Sport;
  night: boolean;
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  crowd: Crowd;
  screen: Screen;
  stumps: { striker: Stumps; bowler: Stumps } | null;
  lampMat: THREE.MeshStandardMaterial;
  /** Points on the stadium rim fireworks launch from. */
  rim: THREE.Vector3[];
  envSource: THREE.Texture;
  update(dt: number, time: number): void;
}

const DEG = Math.PI / 180;

function detailed(mat: THREE.MeshStandardMaterial, detail: THREE.Texture, repeat: number, amount = 0.45): void {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = { value: detail };
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform sampler2D uDetail;\nvoid main() {')
      .replace('#include <map_fragment>', `#include <map_fragment>\n  diffuseColor.rgb *= mix(1.0, texture2D(uDetail, vMapUv * ${repeat.toFixed(1)}).r * 1.22, ${amount.toFixed(2)});`);
  };
}

function lights(scene: THREE.Scene, night: boolean, sunDir: THREE.Vector3, focus: THREE.Vector3, box: number): { sun: THREE.DirectionalLight; hemi: THREE.HemisphereLight } {
  const hemi = new THREE.HemisphereLight(night ? 0x40507a : 0xc6dbff, night ? 0x1d2a14 : 0x51702f, night ? 0.75 : 0.95);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(night ? 0xf2f5ff : 0xfff0d8, night ? 2.5 : 3.0);
  const dir = night ? new THREE.Vector3(0.45, 1, 0.55).normalize() : sunDir;
  sun.position.copy(focus).addScaledVector(dir, 140);
  sun.target.position.copy(focus);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera;
  c.left = -box;
  c.right = box;
  c.top = box;
  c.bottom = -box;
  c.near = 40;
  c.far = 260;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  if (night) {
    // A softer fill from the opposite bank of lights.
    const fill = new THREE.DirectionalLight(0xdfe6ff, 0.9);
    fill.position.set(-60, 90, -80);
    scene.add(fill);
  }
  return { sun, hemi };
}

/** A vertical ribbon along a curve, e.g. boundary boards or the outfield wall. */
function ribbon(pts: { x: number; z: number }[], y0: number, y1: number, mat: THREE.Material, uScale: number): THREE.Mesh {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let u = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) u += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z) / uScale;
    pos.push(pts[i].x, y0, pts[i].z, pts[i].x, y1, pts[i].z);
    uv.push(u, 0, u, 1);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

// ---- cricket ---------------------------------------------------------------------------------------

export function buildCricketWorld(o: { night: boolean; sky: HTMLImageElement | null }): World {
  const F = CRICKET_FIELD;
  const scene = new THREE.Scene();
  const night = o.night || !o.sky;
  const sky = makeSky({ night, image: o.sky ?? undefined, sunAz: 152 });
  scene.add(sky.mesh);
  scene.fog = new THREE.Fog(night ? 0x0b0f1c : 0xc4d0dc, 160, 950);
  const { sun, hemi } = lights(scene, night, sky.sunDir, new THREE.Vector3(0, 0, -8), 30);

  // Ground.
  const detail = grassDetail();
  const gmat = new THREE.MeshStandardMaterial({ map: cricketGround(), roughness: 0.96, metalness: 0 });
  detailed(gmat, detail, 420, 0.4);
  const ggeo = new THREE.CircleGeometry(175, 120);
  ggeo.rotateX(-Math.PI / 2);
  ggeo.translate(0, 0, F.cz);
  {
    const p = ggeo.getAttribute('position');
    const uv = ggeo.getAttribute('uv');
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / CRICKET_TEX_SIZE + 0.5, 1 - ((p.getZ(i) - F.cz) / CRICKET_TEX_SIZE + 0.5));
  }
  const ground = new THREE.Mesh(ggeo, gmat);
  ground.receiveShadow = true;
  scene.add(ground);

  // Pitch strip.
  const pmat = new THREE.MeshStandardMaterial({ map: cricketPitch(), roughness: 0.9, metalness: 0 });
  detailed(pmat, detail, 40, 0.25);
  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(PITCH_TEX.w, PITCH_TEX.l), pmat);
  pitch.rotation.x = -Math.PI / 2;
  pitch.position.set(0, 0.006, PITCH_TEX.z0 - PITCH_TEX.l / 2);
  pitch.receiveShadow = true;
  scene.add(pitch);

  const striker = new Stumps(1.22);
  const bowler = new Stumps(-18.9);
  scene.add(striker.group, bowler.group);

  // Rope and LED boards.
  const ring = (extra: number, n = 360) => {
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = ropeRadius(Math.sin(a), F.cz + Math.cos(a)) + extra;
      pts.push({ x: Math.sin(a) * r, z: F.cz + Math.cos(a) * r });
    }
    return pts;
  };
  const ropePts = ring(0).map((p) => new THREE.Vector3(p.x, 0.09, p.z));
  const rope = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ropePts, true), 360, 0.1, 6, true), new THREE.MeshStandardMaterial({ color: 0x2f62ff, roughness: 0.6, emissive: 0x0b1d66, emissiveIntensity: 0.3 }));
  scene.add(rope);
  const btex = boardsTexture(3);
  const bmat = new THREE.MeshStandardMaterial({ map: btex, emissive: 0xffffff, emissiveMap: btex, emissiveIntensity: night ? 0.85 : 0.6, roughness: 0.5, side: THREE.DoubleSide });
  // Negative scale on u so the text reads correctly from the field side.
  const boards = ribbon(ring(3.2, 240), 0, 0.95, bmat, -16);
  scene.add(boards);

  // Stands, with a gap at the far end for the sight screen.
  const standEdge = {
    at(a: number) {
      const r = ropeRadius(Math.sin(a), F.cz + Math.cos(a)) + F.standGap;
      return { x: Math.sin(a) * r, z: F.cz + Math.cos(a) * r };
    },
  };
  const gap: [number, number] = [Math.PI - 10.5 * DEG, Math.PI + 10.5 * DEG];
  const bowl = buildBowl({
    edge: standEdge,
    centre: { x: 0, z: F.cz },
    a0: 0,
    a1: Math.PI * 2,
    segments: 220,
    gaps: [gap],
    wallH: 2.2,
    wallColor: 0x1d2b5e,
    seatColors: [0x2a56c9, 0xf2a516, 0x2a56c9, 0xd23b3b, 0x2a56c9, 0x1a9e6a],
    tiers: [
      { o: 1.0, h: 2.2, rows: 16, depth: 0.85, rise: 0.44 },
      { o: 18.5, h: 13.5, rows: 14, depth: 0.9, rise: 0.56 },
    ],
    backH: 3.5,
    roof: { over: 16, up: 4, mask: (a) => Math.cos(a) > -0.35 },
    crowd: (a) => 0.86 - 0.12 * Math.max(0, Math.cos(a * 3 + 1)),
  });
  scene.add(bowl.mesh);
  if (bowl.roof) scene.add(bowl.roof);
  if (night) (bowl.mesh.material as THREE.MeshStandardMaterial).color.setScalar(0.55);

  // Sight screen and the pavilion behind it.
  const far = ropeRadius(0, F.cz - 1) + F.standGap;
  const ss = new THREE.Mesh(new THREE.BoxGeometry(26, 11, 0.6), new THREE.MeshStandardMaterial({ color: 0x08090c, roughness: 0.95 }));
  ss.position.set(0, 5.5, F.cz - far + 2);
  scene.add(ss);
  const pav = pavilion(night);
  pav.position.set(0, 0, F.cz - far - 14);
  scene.add(pav);
  // Members on the pavilion balconies.
  for (let i = 0; i < 3; i++) {
    const y = 3 + i * 6.5 + 0.45;
    const zf = 6 - i * 2.2;
    const half = (50 - i * 3) / 2 - 1;
    for (let row = 0; row < 2; row++) {
      for (let x = -half; x <= half; x += 0.72) {
        if (Math.random() < 0.12) continue;
        bowl.seats.push({ p: new THREE.Vector3(x + (Math.random() - 0.5) * 0.2, y, pav.position.z + zf - 0.55 - row * 0.9), a: Math.PI, shade: 0.8 });
      }
    }
  }

  // Floodlight towers outside the stands.
  const spots = [30, 90, 150, 210, 270, 330].map((d) => {
    const a = d * DEG;
    const r = ropeRadius(Math.sin(a), F.cz + Math.cos(a)) + 50;
    return { x: Math.sin(a) * r, z: F.cz + Math.cos(a) * r, h: 56 };
  });
  const fl = floodlights(spots, new THREE.Vector3(0, 0, F.cz), night);
  scene.add(fl.group);

  // Big screen on the right of the far stand.
  const screen = new Screen();
  {
    const a = Math.PI + 40 * DEG;
    const r = ropeRadius(Math.sin(a), F.cz + Math.cos(a)) + 30;
    const scr = bigScreen(screen);
    scr.position.set(Math.sin(a) * r, 24, F.cz + Math.cos(a) * r);
    scr.lookAt(0, 8, F.cz + 20);
    scene.add(scr);
  }

  const crowd = new Crowd(bowl.seats, 'cricket', night ? 0.62 : 0.95);
  scene.add(crowd.mesh);
  const rim = rimPoints(bowl.seats, 10);
  return {
    sport: 'cricket',
    night,
    scene,
    sun,
    hemi,
    crowd,
    screen,
    stumps: { striker, bowler },
    lampMat: fl.lampMat,
    rim,
    envSource: sky.envSource,
    update(dt, time) {
      crowd.update(dt, time);
      striker.update(dt);
      bowler.update(dt);
    },
  };
}

function rimPoints(seats: CrowdSeat[], n: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  if (!seats.length) return out;
  const top = seats.filter((s) => s.p.y > 15);
  const src = top.length ? top : seats;
  for (let i = 0; i < n; i++) out.push(src[Math.floor((i / n) * src.length)].p.clone().add(new THREE.Vector3(0, 6, 0)));
  return out;
}

function bigScreen(screen: Screen): THREE.Group {
  const g = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(23, 13.4, 1.2), new THREE.MeshStandardMaterial({ color: 0x15171d, roughness: 0.6, metalness: 0.4 }));
  const face = new THREE.Mesh(new THREE.PlaneGeometry(21.6, 12.15), new THREE.MeshBasicMaterial({ map: screen.texture, toneMapped: false }));
  face.position.z = 0.61;
  const leg = new THREE.Mesh(new THREE.BoxGeometry(1.2, 26, 1.2), frame.material);
  leg.position.set(0, -19, -0.5);
  g.add(frame, face, leg);
  return g;
}

/** A modern pavilion: stacked white slabs, glass bands, fins and a cantilevered canopy (two draw calls). */
function pavilion(night: boolean): THREE.Group {
  const g = new THREE.Group();
  const white: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const box = (arr: THREE.BufferGeometry[], w: number, h: number, d: number, x: number, y: number, z: number, rx = 0) => {
    const b = new THREE.BoxGeometry(w, h, d);
    if (rx) b.rotateX(rx);
    b.translate(x, y, z);
    arr.push(b);
  };
  const W = 50;
  // Three floors stepping back as they rise.
  for (let i = 0; i < 3; i++) {
    const y = 3 + i * 6.5;
    const zf = 6 - i * 2.2;
    box(white, W - i * 3, 0.9, 14, 0, y, zf - 7);
    box(glass, W - i * 3 - 1.5, 5.4, 0.3, 0, y + 3.2, zf - 1.2);
    for (let k = -4; k <= 4; k++) box(white, 0.5, 5.6, 0.8, k * ((W - i * 3) / 9), y + 3.2, zf - 0.9);
    // Balcony rail.
    box(white, W - i * 3, 0.9, 0.25, 0, y + 0.9, zf + 0.1);
  }
  box(white, W, 3, 12, 0, 1.5, -1);
  // Canopy roof.
  box(white, W + 6, 0.6, 18, 0, 23.5, -2, -0.12);
  box(white, 1.2, 6, 1.2, -W / 2 + 2, 20.5, -8);
  box(white, 1.2, 6, 1.2, W / 2 - 2, 20.5, -8);
  const wm = new THREE.Mesh(mergeGeometries(white)!, new THREE.MeshStandardMaterial({ color: 0xeeeae2, roughness: 0.7 }));
  const gm = new THREE.Mesh(
    mergeGeometries(glass)!,
    new THREE.MeshStandardMaterial({ color: 0x1d3550, roughness: 0.08, metalness: 0.85, emissive: night ? 0xffd9a0 : 0x000000, emissiveIntensity: night ? 0.35 : 0, envMapIntensity: 1.4 }),
  );
  white.concat(glass).forEach((b) => b.dispose());
  g.add(wm, gm);
  return g;
}

// ---- baseball -----------------------------------------------------------------------------------

export function buildBaseballWorld(o: { night: boolean; sky: HTMLImageElement | null }): World {
  const P = BASEBALL_PARK;
  const scene = new THREE.Scene();
  const night = o.night || !o.sky;
  const sky = makeSky({ night, image: o.sky ?? undefined, sunAz: 150 });
  scene.add(sky.mesh);
  scene.fog = new THREE.Fog(night ? 0x0b0f1c : 0xc4d0dc, 170, 950);
  const { sun, hemi } = lights(scene, night, sky.sunDir, new THREE.Vector3(0, 0, -22), 36);

  const detail = grassDetail();
  const T = BASEBALL_TEX;
  const gmat = new THREE.MeshStandardMaterial({ map: baseballGround(), roughness: 0.95 });
  detailed(gmat, detail, 380, 0.4);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(T.size, T.size), gmat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(T.cx, 0, T.cz);
  ground.receiveShadow = true;
  scene.add(ground);
  const outer = new THREE.Mesh(new THREE.CircleGeometry(400, 64), new THREE.MeshStandardMaterial({ color: 0x2f5a25, roughness: 1 }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.set(0, -0.02, -40);
  scene.add(outer);
  // Warning track/backstop area behind home is dirt.
  const back = new THREE.Mesh(new THREE.CircleGeometry(24, 40, 0, Math.PI), new THREE.MeshStandardMaterial({ color: 0x8c5f40, roughness: 1 }));
  back.rotation.x = -Math.PI / 2;
  back.position.set(0, -0.01, 2);
  scene.add(back);

  // Mound.
  const mound = new THREE.Mesh(
    new THREE.LatheGeometry([new THREE.Vector2(0, 0.25), new THREE.Vector2(0.9, 0.245), new THREE.Vector2(2.2, 0.12), new THREE.Vector2(2.9, 0)], 40),
    new THREE.MeshStandardMaterial({ color: 0xa5704b, roughness: 1 }),
  );
  mound.position.set(0, 0, -18.04);
  mound.receiveShadow = true;
  scene.add(mound);
  scene.add(makeDiamondMarks());

  // Outfield wall with distance markers, foul poles, batter's eye.
  const wallPts: { x: number; z: number }[] = [];
  for (let a = -46; a <= 46; a += 1) {
    const d = fenceDistance(a);
    wallPts.push({ x: Math.sin(a * DEG) * d, z: -Math.cos(a * DEG) * d });
  }
  const wallTex = wallTexture();
  const wall = ribbon(wallPts, 0, P.wallH, new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.85, side: THREE.DoubleSide }), 6);
  wall.receiveShadow = true;
  scene.add(wall);
  const cap = ribbon(wallPts, P.wallH, P.wallH + 0.12, new THREE.MeshStandardMaterial({ color: 0xffc72c, roughness: 0.6, side: THREE.DoubleSide }), 6);
  scene.add(cap);
  for (const [a, label] of [
    [-45, '325'],
    [-22, '375'],
    [0, '400'],
    [22, '375'],
    [45, '325'],
  ] as const) {
    const d = fenceDistance(a) - 0.06;
    const m = numberDecal(label);
    m.position.set(Math.sin(a * DEG) * d, 1.7, -Math.cos(a * DEG) * d);
    m.lookAt(0, 1.7, 0);
    scene.add(m);
  }
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xffd23a, roughness: 0.5, emissive: 0x332800 });
  for (const s of [-1, 1]) {
    const d = P.lines + 0.4;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 26, 10), poleMat);
    pole.position.set(s * Math.SQRT1_2 * d, 13, -Math.SQRT1_2 * d);
    scene.add(pole);
  }
  const eye = new THREE.Mesh(new THREE.BoxGeometry(30, 12, 1), new THREE.MeshStandardMaterial({ color: 0x0b0c0f, roughness: 1 }));
  eye.position.set(0, 6, -(P.centre + 5));
  scene.add(eye);

  // Infield stands (home plate around to the corners) and outfield bleachers.
  const seats: CrowdSeat[] = [];
  const infield = buildBowl({
    edge: { at: (a) => ({ x: 64 * Math.sin(a), z: -28 + 48 * Math.cos(a) }) },
    centre: { x: 0, z: -28 },
    a0: -1.98,
    a1: 1.98,
    segments: 150,
    wallH: 2.4,
    wallColor: 0x163a6b,
    seatColors: [0x1b4f9c, 0x1b4f9c, 0x8c1d2c, 0x1b4f9c],
    tiers: [
      { o: 1.0, h: 2.4, rows: 16, depth: 0.85, rise: 0.42 },
      { o: 18.6, h: 13.6, rows: 13, depth: 0.9, rise: 0.6 },
    ],
    backH: 3.5,
    roof: { over: 14, up: 4, mask: (a) => Math.abs(a) < 1.2 },
    crowd: () => 0.88,
  });
  seats.push(...infield.seats);
  scene.add(infield.mesh);
  if (night) (infield.mesh.material as THREE.MeshStandardMaterial).color.setScalar(0.55);
  if (infield.roof) scene.add(infield.roof);
  const bleach = buildBowl({
    edge: {
      at: (a) => {
        const d = fenceDistance(a / DEG) + 4;
        return { x: Math.sin(a) * d, z: -Math.cos(a) * d };
      },
    },
    centre: { x: 0, z: 0 },
    a0: -52 * DEG,
    a1: 52 * DEG,
    segments: 110,
    gaps: [[-8 * DEG, 8 * DEG]],
    wallH: 3.4,
    wallColor: 0x163a6b,
    seatColors: [0x1b4f9c, 0x2f6fd0],
    tiers: [{ o: 0.6, h: 3.6, rows: 18, depth: 0.85, rise: 0.48 }],
    backH: 2.5,
    crowd: () => 0.8,
  });
  seats.push(...bleach.seats);
  scene.add(bleach.mesh);
  if (night) (bleach.mesh.material as THREE.MeshStandardMaterial).color.setScalar(0.55);

  // Dugouts.
  const dug = new THREE.MeshStandardMaterial({ color: 0x1c2333, roughness: 0.8 });
  for (const s of [-1, 1]) {
    const d = new THREE.Mesh(new THREE.BoxGeometry(14, 2.6, 3), dug);
    d.position.set(s * 33, 1.3, -14);
    d.rotation.y = s * 0.62;
    scene.add(d);
  }

  const spots = [
    { x: -62, z: 8, h: 50 },
    { x: 62, z: 8, h: 50 },
    { x: -92, z: -52, h: 46 },
    { x: 92, z: -52, h: 46 },
    { x: -60, z: -128, h: 44 },
    { x: 60, z: -128, h: 44 },
  ];
  const fl = floodlights(spots, new THREE.Vector3(0, 0, -45), night);
  scene.add(fl.group);

  const screen = new Screen();
  {
    const scr = bigScreen(screen);
    const a = 30 * DEG;
    const d = fenceDistance(30) + 26;
    scr.position.set(Math.sin(a) * d, 30, -Math.cos(a) * d);
    scr.lookAt(0, 10, 0);
    scene.add(scr);
  }

  const crowd = new Crowd(seats, 'baseball', night ? 0.6 : 0.95);
  scene.add(crowd.mesh);
  return {
    sport: 'baseball',
    night,
    scene,
    sun,
    hemi,
    crowd,
    screen,
    stumps: null,
    lampMat: fl.lampMat,
    rim: rimPoints(seats, 10),
    envSource: sky.envSource,
    update(dt, time) {
      crowd.update(dt, time);
    },
  };
}

function wallTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 128);
  const grd = g.createLinearGradient(0, 0, 0, 128);
  grd.addColorStop(0, '#24543f');
  grd.addColorStop(1, '#1a3d2e');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = 'rgba(0,0,0,0.25)';
  for (let x = 0; x < 256; x += 64) g.fillRect(x, 0, 2, 128);
  g.fillStyle = 'rgba(255,255,255,0.05)';
  g.fillRect(0, 6, 256, 6);
  const t = tex(c, true, true);
  return t;
}

function numberDecal(text: string): THREE.Mesh {
  const [c, g] = canvas(256, 128);
  g.clearRect(0, 0, 256, 128);
  g.fillStyle = '#ffffff';
  g.font = '900 96px Outfit, Arial Black, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 70);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.6), new THREE.MeshStandardMaterial({ map: tex(c), transparent: true, roughness: 0.8 }));
  return m;
}
