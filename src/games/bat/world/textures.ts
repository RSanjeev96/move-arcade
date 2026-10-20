/** Procedural canvas textures: grounds, pitch, crowd atlas, boards, balls, bats, lamps. */
import * as THREE from 'three';
import { BASEBALL_PARK, CRICKET_FIELD, fenceDistance } from '../outcome';

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

export function tex(c: HTMLCanvasElement, srgb = true, repeat = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}

/** Deterministic pseudo random for texture painting. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speckle(g: CanvasRenderingContext2D, w: number, h: number, n: number, colors: string[], size: [number, number], seed: number): void {
  const r = prng(seed);
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[Math.floor(r() * colors.length)];
    const s = size[0] + r() * (size[1] - size[0]);
    g.fillRect(r() * w, r() * h, s, s * (0.6 + r() * 0.8));
  }
}

/** Soft blotches for large-scale colour variation. */
function blotches(g: CanvasRenderingContext2D, w: number, h: number, n: number, color: string, rad: [number, number], alpha: number, seed: number): void {
  const r = prng(seed);
  for (let i = 0; i < n; i++) {
    const x = r() * w;
    const y = r() * h;
    const rr = rad[0] + r() * (rad[1] - rad[0]);
    const grd = g.createRadialGradient(x, y, 0, x, y, rr);
    grd.addColorStop(0, color);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = alpha * (0.4 + r() * 0.6);
    g.fillStyle = grd;
    g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  g.globalAlpha = 1;
}

/** Tiling grass detail (greyscale around 1.0) multiplied over the ground at close range. */
export function grassDetail(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#d0d0d0';
  g.fillRect(0, 0, 256, 256);
  const r = prng(11);
  for (let i = 0; i < 9000; i++) {
    const v = 150 + Math.floor(r() * 105);
    g.strokeStyle = `rgb(${v},${v},${v})`;
    g.lineWidth = 1;
    const x = r() * 256;
    const y = r() * 256;
    const a = r() * Math.PI;
    const l = 2 + r() * 5;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * l * 0.4, y + Math.sin(a) * l);
    g.stroke();
  }
  const t = tex(c, false, true);
  return t;
}

// ---- cricket -------------------------------------------------------------------------------------

/** World extent covered by the ground texture (square, metres, centred on the ground centre). */
export const CRICKET_TEX_SIZE = 190;

export function cricketGround(): THREE.CanvasTexture {
  const N = 2048;
  const S = CRICKET_TEX_SIZE;
  const F = CRICKET_FIELD;
  const [c, g] = canvas(N, N);
  const px = N / S;
  // Texture u → world x, v → world z (centre at the ground centre).
  const X = (x: number) => (x / S + 0.5) * N;
  const Z = (z: number) => ((z - F.cz) / S + 0.5) * N;
  g.fillStyle = '#4c8a32';
  g.fillRect(0, 0, N, N);
  // Mowing stripes along the pitch, alternate shades.
  const stripe = 5.2 * px;
  for (let i = -30; i < 30; i++) {
    g.fillStyle = i % 2 ? 'rgba(255,255,230,0.1)' : 'rgba(0,30,0,0.09)';
    g.fillRect(X(0) + i * stripe - stripe / 2, 0, stripe, N);
  }
  // Faint cross-cut.
  for (let i = -30; i < 30; i++) {
    g.fillStyle = i % 2 ? 'rgba(255,255,220,0.025)' : 'rgba(0,20,0,0.03)';
    g.fillRect(0, Z(F.cz) + i * stripe - stripe / 2, N, stripe);
  }
  blotches(g, N, N, 140, 'rgba(40,70,10,1)', [30, 140], 0.18, 3);
  blotches(g, N, N, 90, 'rgba(150,170,70,1)', [20, 90], 0.12, 5);
  speckle(g, N, N, 50000, ['rgba(60,115,40,0.5)', 'rgba(85,145,56,0.45)', 'rgba(70,125,44,0.5)', 'rgba(92,150,62,0.35)'], [1, 2], 7);
  // Worn bowlers' run-ups at both ends of the square.
  for (const z of [-30, 13]) {
    const grd = g.createRadialGradient(X(0.6), Z(z), 0, X(0.6), Z(z), 9 * px);
    grd.addColorStop(0, 'rgba(160,150,80,0.45)');
    grd.addColorStop(1, 'rgba(160,150,80,0)');
    g.fillStyle = grd;
    g.fillRect(X(-10), Z(z - 12), 20 * px, 24 * px);
  }
  // The square (lighter, closely mown) around the pitch.
  g.fillStyle = 'rgba(190,200,120,0.16)';
  g.fillRect(X(-9), Z(-24), 18 * px, 30 * px);
  // 30-yard circle: two semicircles joined by straight lines, dashed white discs.
  g.fillStyle = 'rgba(255,255,255,0.85)';
  const R30 = 27.43;
  const dash = (x: number, z: number) => {
    g.beginPath();
    g.arc(X(x), Z(z), 0.17 * px, 0, Math.PI * 2);
    g.fill();
  };
  const ends = [CRICKET_FIELD.cz + 10.06, CRICKET_FIELD.cz - 10.06];
  for (let a = 0; a < 360; a += 3.4) {
    const s = Math.sin((a * Math.PI) / 180);
    const cc = Math.cos((a * Math.PI) / 180);
    dash(s * R30, (cc > 0 ? ends[0] : ends[1]) + cc * R30);
  }
  for (let z = ends[1]; z <= ends[0]; z += 1.6) {
    dash(R30, z);
    dash(-R30, z);
  }
  // Darker band near the rope (where boards shade the grass) and outside the rope.
  const grd = g.createRadialGradient(X(0), Z(F.cz), (F.ax - 2) * px, X(0), Z(F.cz), (F.az + 30) * px);
  grd.addColorStop(0, 'rgba(0,0,0,0)');
  grd.addColorStop(0.25, 'rgba(10,30,0,0.25)');
  grd.addColorStop(1, 'rgba(10,30,0,0.4)');
  g.fillStyle = grd;
  g.fillRect(0, 0, N, N);
  return tex(c);
}

/** The 22-yard strip with creases (u across 3.6 m, v along 25 m). */
export const PITCH_TEX = { w: 3.6, l: 25.2, z0: 3.3 };

export function cricketPitch(): THREE.CanvasTexture {
  const W = 256;
  const H = 2048;
  const [c, g] = canvas(W, H);
  const P = PITCH_TEX;
  const pu = W / P.w;
  const pv = H / P.l;
  const U = (x: number) => (x / P.w + 0.5) * W;
  const V = (z: number) => (P.z0 - z) * pv; // z0 at the top (behind the striker), increasing v towards the bowler
  const base = g.createLinearGradient(0, 0, W, 0);
  base.addColorStop(0, '#a99c64');
  base.addColorStop(0.15, '#c5b88a');
  base.addColorStop(0.5, '#d2c59a');
  base.addColorStop(0.85, '#c5b88a');
  base.addColorStop(1, '#a99c64');
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);
  // Grass tint at the edges and live grass speckles.
  speckle(g, W, H, 9000, ['rgba(120,140,60,0.35)', 'rgba(150,150,80,0.3)', 'rgba(90,110,40,0.25)'], [1, 2], 21);
  speckle(g, W, H, 14000, ['rgba(255,250,220,0.18)', 'rgba(110,90,50,0.2)', 'rgba(80,70,40,0.18)'], [1, 2], 22);
  blotches(g, W, H, 40, 'rgba(120,100,60,1)', [10, 40], 0.12, 23);
  // Hairline cracks.
  const r = prng(31);
  g.strokeStyle = 'rgba(90,72,40,0.45)';
  g.lineWidth = 1;
  for (let i = 0; i < 70; i++) {
    let x = U((r() - 0.5) * 2.4);
    let y = r() * H;
    g.beginPath();
    g.moveTo(x, y);
    const n = 3 + Math.floor(r() * 6);
    for (let k = 0; k < n; k++) {
      x += (r() - 0.5) * 18;
      y += (r() - 0.5) * 40;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  // Scuffed areas: bowlers' footmarks and the batters' guard marks.
  for (const [zc, sx] of [
    [-16.8, 0.5],
    [-17.3, -0.55],
    [0.1, -0.05],
    [0.6, 0.15],
  ] as const) {
    const grd = g.createRadialGradient(U(sx), V(zc), 0, U(sx), V(zc), 0.55 * pu);
    grd.addColorStop(0, 'rgba(120,95,55,0.55)');
    grd.addColorStop(1, 'rgba(120,95,55,0)');
    g.fillStyle = grd;
    g.fillRect(U(sx) - pu, V(zc) - pu, 2 * pu, 2 * pu);
  }
  // Creases (white paint, 5 cm).
  g.fillStyle = 'rgba(255,255,255,0.95)';
  const line = (x0: number, z0: number, x1: number, z1: number) => {
    const lw = 0.05;
    g.fillRect(Math.min(U(x0), U(x1)) - (x0 === x1 ? (lw * pu) / 2 : 0), Math.min(V(z0), V(z1)) - (z0 === z1 ? (lw * pv) / 2 : 0), Math.max(lw * pu, Math.abs(U(x1) - U(x0))), Math.max(lw * pv, Math.abs(V(z1) - V(z0))));
  };
  for (const [stumps, dir] of [
    [1.22, -1],
    [-18.9, 1],
  ] as const) {
    const pop = stumps + dir * 1.22;
    line(-1.75, pop, 1.75, pop); // popping crease (runs off the strip)
    line(-1.32, stumps, 1.32, stumps); // bowling crease
    for (const sx of [-1.32, 1.32]) line(sx, pop + dir * 0.6, sx, stumps - dir * 2.44); // return creases
    for (const sx of [-0.89, 0.89]) line(sx, pop, sx, pop + dir * 0.45); // wide guidelines
  }
  return tex(c);
}

// ---- baseball -----------------------------------------------------------------------------------

export const BASEBALL_TEX = { size: 150, cx: 0, cz: -62 };

export function baseballGround(): THREE.CanvasTexture {
  const N = 2048;
  const T = BASEBALL_TEX;
  const [c, g] = canvas(N, N);
  const px = N / T.size;
  const X = (x: number) => ((x - T.cx) / T.size + 0.5) * N;
  const Z = (z: number) => ((z - T.cz) / T.size + 0.5) * N;
  g.fillStyle = '#3f8530';
  g.fillRect(0, 0, N, N);
  // Diagonal cross-hatch mowing.
  g.save();
  g.translate(X(0), Z(0));
  g.rotate(Math.PI / 4);
  const w = 4.6 * px;
  for (let i = -40; i < 40; i++) {
    g.fillStyle = i % 2 ? 'rgba(255,255,220,0.07)' : 'rgba(0,30,0,0.07)';
    g.fillRect(i * w, -N * 2, w, N * 4);
    g.fillRect(-N * 2, i * w, N * 4, w);
  }
  g.restore();
  blotches(g, N, N, 110, 'rgba(40,70,10,1)', [30, 140], 0.16, 41);
  speckle(g, N, N, 42000, ['rgba(58,118,40,0.5)', 'rgba(82,146,56,0.45)', 'rgba(66,126,44,0.5)', 'rgba(92,156,66,0.35)'], [1, 2], 42);
  // Dirt grain as a small repeating pattern (fast: no per-speck clipping on the big canvas).
  const [tc, tg] = canvas(256, 256);
  blotches(tg, 256, 256, 14, 'rgba(90,50,25,1)', [8, 30], 0.2, 9);
  speckle(tg, 256, 256, 3200, ['rgba(80,45,25,0.4)', 'rgba(215,165,125,0.35)', 'rgba(120,80,50,0.35)'], [1, 2], 10);
  const grain = g.createPattern(tc, 'repeat')!;
  /** Fill a region with dirt: base colour, then the grain pattern. */
  const dirt = (path: () => void, color: string) => {
    g.beginPath();
    path();
    g.fillStyle = color;
    g.fill();
    g.fillStyle = grain;
    g.fill();
  };
  // Warning track along the fence.
  dirt(() => {
    for (let a = -48; a <= 48; a += 1) {
      const d = fenceDistance(a) + 0.5;
      const s = Math.sin((a * Math.PI) / 180);
      const cc = -Math.cos((a * Math.PI) / 180);
      if (a === -48) g.moveTo(X(s * d), Z(cc * d));
      else g.lineTo(X(s * d), Z(cc * d));
    }
    for (let a = 48; a >= -48; a -= 1) {
      const d = fenceDistance(a) - 4.6;
      g.lineTo(X(Math.sin((a * Math.PI) / 180) * d), Z(-Math.cos((a * Math.PI) / 180) * d));
    }
    g.closePath();
  }, '#8c5f40');
  // Infield dirt: arc of radius 29 m around the mound, closed at home plate.
  const mz = -18.44;
  dirt(() => {
    g.moveTo(X(0), Z(3));
    g.arc(X(0), Z(mz), 29 * px, Math.PI * 0.5 + 0.84, Math.PI * 0.5 - 0.84 + Math.PI * 2, false);
    g.closePath();
  }, '#a8704a');
  // Infield grass square inside the base paths.
  g.save();
  g.translate(X(0), Z(0));
  g.rotate(Math.PI / 4);
  g.fillStyle = '#438a33';
  g.fillRect(-26.4 * px, -26.4 * px, 25.3 * px, 25.3 * px);
  for (let i = -6; i < 6; i++) {
    g.fillStyle = i % 2 ? 'rgba(255,255,220,0.07)' : 'rgba(0,30,0,0.07)';
    g.fillRect(-26.4 * px + (i + 6) * 2.1 * px, -26.4 * px, 2.1 * px, 25.3 * px);
  }
  g.restore();
  // Base paths, home circle, base cutouts, mound.
  const P = BASEBALL_PARK.bases;
  dirt(() => {
    const hw = 0.9;
    const seg = (a: { x: number; z: number }, b: { x: number; z: number }) => {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz);
      const nx = (-dz / l) * hw;
      const nz = (dx / l) * hw;
      g.moveTo(X(a.x + nx), Z(a.z + nz));
      g.lineTo(X(b.x + nx), Z(b.z + nz));
      g.lineTo(X(b.x - nx), Z(b.z - nz));
      g.lineTo(X(a.x - nx), Z(a.z - nz));
      g.closePath();
    };
    seg({ x: 0, z: 0 }, P[0]);
    seg(P[0], P[1]);
    seg(P[1], P[2]);
    seg(P[2], { x: 0, z: 0 });
    for (const b of P.slice(0, 3)) {
      g.moveTo(X(b.x) + 2.9 * px, Z(b.z));
      g.arc(X(b.x), Z(b.z), 2.9 * px, 0, Math.PI * 2);
    }
    g.moveTo(X(0) + 4 * px, Z(-0.4));
    g.arc(X(0), Z(-0.4), 4.0 * px, 0, Math.PI * 2);
  }, '#a8704a');
  dirt(() => g.arc(X(0), Z(mz + 0.4), 2.75 * px, 0, Math.PI * 2), '#b07650');
  return tex(c);
}

// ---- crowd ---------------------------------------------------------------------------------------

/**
 * Atlas of 8 spectator silhouettes (4 seated, 4 standing with arms up), 128×256 cells.
 * Channels: R = shirt mask, G = skin mask, B = hair/trousers mask, A = coverage.
 */
export function crowdAtlas(): THREE.CanvasTexture {
  const CW = 128;
  const CH = 256;
  const [c, g] = canvas(CW * 8, CH);
  g.clearRect(0, 0, c.width, c.height);
  g.scale(1, 1);
  const r = prng(5);
  for (let i = 0; i < 8; i++) {
    g.save();
    g.translate(i * CW, 0);
    g.scale(2, 2);
    const ox = 0;
    const up = i >= 4;
    const v = i % 4;
    const shirt = 'rgb(255,0,0)';
    const skin = 'rgb(0,255,0)';
    const dark = 'rgb(0,0,255)';
    const cx = ox + 32;
    const headY = 34 + (v === 2 ? 4 : 0);
    // torso
    g.fillStyle = shirt;
    g.beginPath();
    g.moveTo(cx - 16 - (v === 1 ? 3 : 0), 128);
    g.lineTo(cx - 15, headY + 22);
    g.quadraticCurveTo(cx, headY + 14, cx + 15, headY + 22);
    g.lineTo(cx + 16 + (v === 1 ? 3 : 0), 128);
    g.closePath();
    g.fill();
    // arms
    g.lineCap = 'round';
    g.lineWidth = 7;
    if (up) {
      g.strokeStyle = shirt;
      const spread = 6 + r() * 6;
      g.beginPath();
      g.moveTo(cx - 12, headY + 26);
      g.lineTo(cx - 16 - spread, headY - 6);
      g.moveTo(cx + 12, headY + 26);
      g.lineTo(cx + 16 + spread, headY - 6);
      g.stroke();
      g.strokeStyle = skin;
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(cx - 16 - spread, headY - 4);
      g.lineTo(cx - 18 - spread, headY - 18);
      g.moveTo(cx + 16 + spread, headY - 4);
      g.lineTo(cx + 18 + spread, headY - 18);
      g.stroke();
    } else {
      g.strokeStyle = shirt;
      g.beginPath();
      g.moveTo(cx - 14, headY + 26);
      g.lineTo(cx - 17, headY + 60);
      g.moveTo(cx + 14, headY + 26);
      g.lineTo(cx + 17, headY + 60);
      g.stroke();
    }
    // neck + head
    g.fillStyle = skin;
    g.fillRect(cx - 4, headY + 8, 8, 12);
    g.beginPath();
    g.ellipse(cx, headY, 10, 12, 0, 0, Math.PI * 2);
    g.fill();
    // hair / cap
    g.fillStyle = dark;
    g.beginPath();
    if (v === 3) {
      g.ellipse(cx, headY - 6, 11, 7, 0, Math.PI, Math.PI * 2);
      g.fillRect(cx - 2, headY - 7, 15, 4);
    } else g.ellipse(cx, headY - 5, 10.5, 8, 0, Math.PI * 1.05, Math.PI * 1.95);
    g.fill();
    // lower body (dark trousers) peeking at the bottom
    g.fillStyle = dark;
    g.fillRect(cx - 15, 118, 30, 10);
    g.restore();
  }
  const t = tex(c, false);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// ---- boards, screens, lamps --------------------------------------------------------------------------

const AD_TEXT = ['BIG HITTER', 'MOVE ARCADE', 'SIX!', 'STRIKE ZONE', 'POWERPLAY', 'MAXIMUM', 'BOUNDARY', 'GAME ON'];
const AD_COLORS: [string, string][] = [
  ['#0b2a6b', '#ffd23f'],
  ['#d7192d', '#ffffff'],
  ['#0f7d4a', '#e8ff5a'],
  ['#ff7a00', '#14193a'],
  ['#5a1ea8', '#5ff2ff'],
  ['#101010', '#ff3f8a'],
];

/** LED advertising strip (repeats around the ground). */
export function boardsTexture(seed = 1): THREE.CanvasTexture {
  const W = 2048;
  const H = 96;
  const [c, g] = canvas(W, H);
  const r = prng(seed);
  const n = 8;
  const seg = W / n;
  for (let i = 0; i < n; i++) {
    const [bg, fg] = AD_COLORS[Math.floor(r() * AD_COLORS.length)];
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, bg);
    grd.addColorStop(1, shade(bg, -0.35));
    g.fillStyle = grd;
    g.fillRect(i * seg, 0, seg, H);
    g.fillStyle = fg;
    g.font = `900 ${Math.round(H * 0.58)}px Outfit, Arial Black, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(AD_TEXT[Math.floor(r() * AD_TEXT.length)], i * seg + seg / 2, H / 2 + 3);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(i * seg, 0, seg, H * 0.18);
  }
  // LED pixel grid.
  g.fillStyle = 'rgba(0,0,0,0.22)';
  for (let x = 0; x < W; x += 4) g.fillRect(x, 0, 1, H);
  for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
  const t = tex(c, true, true);
  return t;
}

function shade(hex: string, k: number): string {
  const c = new THREE.Color(hex);
  if (k < 0) c.multiplyScalar(1 + k);
  else c.lerp(new THREE.Color(1, 1, 1), k);
  return `#${c.getHexString()}`;
}

/** Floodlight head: rows of lamps. */
export function lampTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 128);
  g.fillStyle = '#1b1d22';
  g.fillRect(0, 0, 256, 128);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 8; x++) {
      const cx = 16 + x * 32;
      const cy = 16 + y * 32;
      const grd = g.createRadialGradient(cx, cy, 0, cx, cy, 14);
      grd.addColorStop(0, '#ffffff');
      grd.addColorStop(0.5, '#fff6dc');
      grd.addColorStop(1, '#6a6656');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(cx, cy, 13, 0, Math.PI * 2);
      g.fill();
    }
  }
  return tex(c);
}

export function glowTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.2, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return tex(c);
}

/** Soft round blob used for contact shadows under players and the ball. */
export function blobTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(0,0,0,0.75)');
  grd.addColorStop(0.55, 'rgba(0,0,0,0.35)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return tex(c, false);
}

/** Ball surface: equirect map with seam (cricket white ball) or red stitches (baseball). */
export function ballTexture(sport: 'cricket' | 'baseball'): THREE.CanvasTexture {
  const [c, g] = canvas(256, 128);
  g.fillStyle = sport === 'cricket' ? '#f4f2ea' : '#f6f3ea';
  g.fillRect(0, 0, 256, 128);
  speckle(g, 256, 128, 600, ['rgba(0,0,0,0.04)', 'rgba(120,100,60,0.05)'], [1, 2], 3);
  if (sport === 'cricket') {
    g.fillStyle = '#c9c4b4';
    g.fillRect(0, 58, 256, 12);
    g.strokeStyle = '#8f8a7c';
    g.lineWidth = 1.2;
    for (let x = 0; x < 256; x += 3) {
      g.beginPath();
      g.moveTo(x, 59);
      g.lineTo(x + 1.5, 62);
      g.moveTo(x, 69);
      g.lineTo(x + 1.5, 66);
      g.stroke();
    }
  } else {
    g.strokeStyle = '#c4202a';
    g.lineWidth = 2.2;
    for (const off of [0, 128]) {
      g.beginPath();
      for (let x = 0; x <= 128; x += 2) {
        const y = 64 + Math.sin(((x + off) / 128) * Math.PI * 2) * 34;
        if (x === 0) g.moveTo(x + off, y);
        else g.lineTo(x + off, y);
      }
      g.stroke();
    }
    g.lineWidth = 1.4;
    for (let x = 0; x < 256; x += 5) {
      const y = 64 + Math.sin((x / 128) * Math.PI * 2) * 34;
      g.beginPath();
      g.moveTo(x - 2, y - 3);
      g.lineTo(x + 2, y + 3);
      g.stroke();
    }
  }
  return tex(c);
}

/** Cricket bat face/back: willow grain with a sticker. u across, v along the blade (v=0 toe). */
export function willowTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 512);
  const grd = g.createLinearGradient(0, 0, 128, 0);
  grd.addColorStop(0, '#d9c08c');
  grd.addColorStop(0.5, '#ead6a6');
  grd.addColorStop(1, '#d4b984');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 512);
  const r = prng(9);
  for (let i = 0; i < 9; i++) {
    const x = 12 + i * 13 + r() * 4;
    g.strokeStyle = `rgba(150,110,60,${0.12 + r() * 0.12})`;
    g.lineWidth = 1 + r() * 1.5;
    g.beginPath();
    g.moveTo(x, 0);
    for (let y = 0; y <= 512; y += 32) g.lineTo(x + Math.sin(y * 0.02 + i) * 2, y);
    g.stroke();
  }
  // Sticker band near the shoulder and toe guard.
  g.fillStyle = '#121a3a';
  g.fillRect(0, 330, 128, 110);
  g.fillStyle = '#ffc93c';
  g.fillRect(0, 336, 128, 10);
  g.fillRect(0, 424, 128, 10);
  g.save();
  g.translate(64, 385);
  g.rotate(-Math.PI / 2);
  g.fillStyle = '#ffffff';
  g.font = '900 34px Outfit, Arial Black, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('BIG HIT', 0, 2);
  g.restore();
  g.fillStyle = '#111';
  g.fillRect(0, 0, 128, 14);
  return tex(c);
}

/** A dynamic canvas for the big screen in the stadium. */
export class Screen {
  readonly canvas: HTMLCanvasElement;
  readonly g: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  constructor(w = 512, h = 288) {
    [this.canvas, this.g] = canvas(w, h);
    this.texture = tex(this.canvas);
  }
  draw(title: string, big: string, sub: string, accent = '#ffd23f'): void {
    const g = this.g;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#0c1236');
    grd.addColorStop(1, '#05071a');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    g.fillStyle = accent;
    g.fillRect(0, 0, W, 8);
    g.fillRect(0, H - 8, W, 8);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#9fb3ff';
    g.font = '700 30px Outfit, Arial, sans-serif';
    g.fillText(title, W / 2, 44);
    g.fillStyle = '#ffffff';
    g.font = `900 ${big.length > 7 ? 92 : 120}px Outfit, Arial Black, sans-serif`;
    g.fillText(big, W / 2, H / 2 + 8);
    g.fillStyle = accent;
    g.font = '800 34px Outfit, Arial, sans-serif';
    g.fillText(sub, W / 2, H - 44);
    g.fillStyle = 'rgba(0,0,0,0.25)';
    for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
    this.texture.needsUpdate = true;
  }
}
