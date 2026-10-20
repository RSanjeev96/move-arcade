/** Procedural canvas textures: ball, net, crowd atlas, LED advertising, glare sprites, kit numbers. */
import * as THREE from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

// ---- ball --------------------------------------------------------------------------------

/** Classic 32-panel ball: equirectangular colour and bump maps computed from a truncated icosahedron. */
export function ballTextures(): { map: THREE.Texture; bump: THREE.Texture } {
  const W = 512;
  const H = 256;
  const phi = (1 + Math.sqrt(5)) / 2;
  // Icosahedron vertices → pentagon centres; face centres → hexagon centres.
  const ico: [number, number, number][] = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) ico.push([0, a, b * phi], [a, b * phi, 0], [b * phi, 0, a]);
  const norm = (v: number[]) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const pent = ico.map(norm);
  const hex: number[][] = [];
  for (let i = 0; i < 12; i++)
    for (let j = i + 1; j < 12; j++)
      for (let k = j + 1; k < 12; k++) {
        const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        const e = d(pent[0], pent.find((p, n) => n > 0 && d(pent[0], p) < 1.2)!);
        if (Math.abs(d(pent[i], pent[j]) - e) < 1e-3 && Math.abs(d(pent[j], pent[k]) - e) < 1e-3 && Math.abs(d(pent[i], pent[k]) - e) < 1e-3)
          hex.push(norm([pent[i][0] + pent[j][0] + pent[k][0], pent[i][1] + pent[j][1] + pent[k][1], pent[i][2] + pent[j][2] + pent[k][2]]));
      }
  const centres = [...pent.map((p) => ({ p, pent: true })), ...hex.map((p) => ({ p, pent: false }))];
  const [cc, g] = canvas(W, H);
  const [bc, bg] = canvas(W, H);
  const img = g.createImageData(W, H);
  const bimg = bg.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const lat = (0.5 - (y + 0.5) / H) * Math.PI;
    for (let x = 0; x < W; x++) {
      const lon = ((x + 0.5) / W) * Math.PI * 2;
      const v = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
      let best = -2;
      let second = -2;
      let isPent = false;
      for (const c of centres) {
        const dot = v[0] * c.p[0] + v[1] * c.p[1] + v[2] * c.p[2];
        if (dot > best) {
          second = best;
          best = dot;
          isPent = c.pent;
        } else if (dot > second) second = dot;
      }
      // Distance to the seam between the two nearest panels.
      const seam = Math.acos(Math.min(1, second)) - Math.acos(Math.min(1, best));
      const s = Math.min(1, seam / 0.06);
      const i = (y * W + x) * 4;
      const base = isPent ? 22 : 246;
      const tint = isPent ? [22, 26, 36] : [246, 246, 242];
      const shade = 0.7 + 0.3 * s;
      img.data[i] = tint[0] * shade;
      img.data[i + 1] = tint[1] * shade;
      img.data[i + 2] = tint[2] * shade;
      img.data[i + 3] = 255;
      const h = Math.round(255 * Math.sqrt(s));
      bimg.data[i] = bimg.data[i + 1] = bimg.data[i + 2] = h;
      bimg.data[i + 3] = 255;
      void base;
    }
  }
  g.putImageData(img, 0, 0);
  bg.putImageData(bimg, 0, 0);
  const map = new THREE.CanvasTexture(cc);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const bump = new THREE.CanvasTexture(bc);
  return { map, bump };
}

// ---- net -----------------------------------------------------------------------------------

/** Hexagonal knotted net mesh (alpha in the red channel; white ropes). */
export function netTexture(): THREE.Texture {
  const S = 256;
  const [c, g] = canvas(S, S);
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.strokeStyle = '#fff';
  g.lineWidth = 9;
  g.lineCap = 'round';
  // One diamond cell per tile: two diagonals that tile seamlessly.
  for (const o of [-S, 0, S]) {
    g.beginPath();
    g.moveTo(o, 0);
    g.lineTo(o + S, S);
    g.stroke();
    g.beginPath();
    g.moveTo(o + S, 0);
    g.lineTo(o, S);
    g.stroke();
  }
  g.fillStyle = '#fff';
  for (const [x, y] of [
    [0, 0],
    [S, 0],
    [0, S],
    [S, S],
    [S / 2, S / 2],
  ]) {
    g.beginPath();
    g.arc(x, y, 9, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// ---- crowd -----------------------------------------------------------------------------------

export const CROWD_CELLS = 16;

/**
 * Crowd atlas: 8 body variants × 2 poses (calm, cheering) in 64×128 cells. Channels: R = shading,
 * G = region (0 shirt, 0.5 skin, 1 hair/hat), A = coverage.
 */
export function crowdAtlas(): THREE.Texture {
  const CW = 64;
  const CH = 128;
  const [c, g] = canvas(CW * CROWD_CELLS, CH);
  g.clearRect(0, 0, c.width, c.height);
  const col = (shade: number, region: number) => `rgb(${Math.round(shade * 255)},${Math.round(region * 255)},0)`;
  const SHIRT = 0;
  const SKIN = 0.5;
  const HAIR = 1;
  for (let cell = 0; cell < CROWD_CELLS; cell++) {
    const v = cell % 8;
    const cheer = cell >= 8;
    const ox = cell * CW;
    g.save();
    g.translate(ox + CW / 2, 0);
    const w = 0.78 + (v % 3) * 0.11; // body width factor
    const headY = 30 + (v % 2) * 3;
    // Torso (shirt) with shading from the top.
    const tw = 44 * w;
    const grad = g.createLinearGradient(0, headY + 10, 0, CH);
    grad.addColorStop(0, col(0.95, SHIRT));
    grad.addColorStop(1, col(0.45, SHIRT));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(-tw / 2, CH);
    g.lineTo(-tw / 2 + 2, headY + 20);
    g.quadraticCurveTo(0, headY + 10, tw / 2 - 2, headY + 20);
    g.lineTo(tw / 2, CH);
    g.closePath();
    g.fill();
    // Arms.
    g.lineCap = 'round';
    g.lineWidth = 10 * w;
    const arm = (side: number) => {
      g.strokeStyle = col(0.75, SHIRT);
      g.beginPath();
      const sx = side * (tw / 2 - 3);
      const sy = headY + 24;
      if (cheer) {
        const ex = sx + side * (6 + (v % 4) * 2);
        const ey = sy - 22;
        const hx = ex + side * ((v % 3) - 1) * 4;
        const hy = ey - 20;
        g.moveTo(sx, sy);
        g.lineTo(ex, ey);
        g.stroke();
        g.strokeStyle = col(0.85, SKIN);
        g.beginPath();
        g.moveTo(ex, ey);
        g.lineTo(hx, hy);
        g.stroke();
        g.fillStyle = col(0.9, SKIN);
        g.beginPath();
        g.arc(hx, hy - 2, 5, 0, Math.PI * 2);
        g.fill();
      } else {
        const crossed = v % 4 === 1;
        g.moveTo(sx, sy);
        g.lineTo(sx + side * 3, sy + 26);
        g.stroke();
        g.strokeStyle = col(0.8, SKIN);
        g.beginPath();
        g.moveTo(sx + side * 3, sy + 26);
        g.lineTo(crossed ? -side * 6 : sx + side * 1, crossed ? sy + 22 : sy + 44);
        g.stroke();
      }
    };
    arm(-1);
    arm(1);
    // Scarf on some.
    if (v % 3 === 0) {
      g.fillStyle = col(0.9, HAIR * 0 + 0.25);
      g.fillRect(-11, headY + 13, 22, 7);
    }
    // Neck + head.
    g.fillStyle = col(0.75, SKIN);
    g.fillRect(-4, headY + 6, 8, 10);
    const hg = g.createRadialGradient(-3, headY - 4, 2, 0, headY, 13);
    hg.addColorStop(0, col(1, SKIN));
    hg.addColorStop(1, col(0.6, SKIN));
    g.fillStyle = hg;
    g.beginPath();
    g.ellipse(0, headY, 11, 13, 0, 0, Math.PI * 2);
    g.fill();
    // Hair / hats.
    g.fillStyle = col(0.7, HAIR);
    g.beginPath();
    if (v === 2 || v === 6) {
      // beanie
      g.ellipse(0, headY - 6, 11, 9, 0, Math.PI, 0);
      g.fill();
      g.fillRect(-11, headY - 7, 22, 4);
    } else if (v === 5) {
      g.ellipse(0, headY - 4, 11, 13, 0, Math.PI * 1.05, Math.PI * 1.95);
      g.lineTo(11, headY + 12);
      g.lineTo(-11, headY + 12);
      g.fill();
    } else if (v !== 3) {
      g.ellipse(0, headY - 5, 10.5, 9, 0, Math.PI, 0);
      g.fill();
    }
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// ---- LED advertising --------------------------------------------------------------------------

export const AD_NAMES: { text: string; bg: string; fg: string; accent?: string; style?: 'bold' | 'italic' | 'wide' }[] = [
  { text: 'VOLTARA', bg: '#0b1d4f', fg: '#ffffff', accent: '#3fd0ff', style: 'wide' },
  { text: 'NORDWIND AIR', bg: '#f4f6fa', fg: '#0d2a6b', accent: '#e8202a', style: 'italic' },
  { text: 'KAIRO BANK', bg: '#0d6b3a', fg: '#ffffff', accent: '#ffd23f', style: 'bold' },
  { text: 'PIXELFORGE', bg: '#1b0b3a', fg: '#ff4fd8', accent: '#5ef0ff', style: 'wide' },
  { text: 'AURELIA', bg: '#c8102e', fg: '#ffffff', accent: '#ffe08a', style: 'italic' },
  { text: 'ZEPHYR SPORT', bg: '#101010', fg: '#c9ff2e', accent: '#ffffff', style: 'bold' },
  { text: 'MOVE ARCADE', bg: '#2a0a5e', fg: '#ffffff', accent: '#ff2d6a', style: 'wide' },
  { text: 'OCTANE COLA', bg: '#e31b23', fg: '#fff4d6', accent: '#1a1a1a', style: 'italic' },
];

/** One 512×64 panel per advert plus two event panels (SAVE / GOAL), stacked vertically. */
export function adsAtlas(): { tex: THREE.Texture; count: number } {
  const W = 512;
  const H = 64;
  const panels = [...AD_NAMES, { text: 'GREAT SAVE', bg: '#00b85c', fg: '#ffffff', accent: '#eaff00', style: 'bold' as const }, { text: 'GOAL', bg: '#ff2a2a', fg: '#ffffff', accent: '#ffe600', style: 'bold' as const }];
  const [c, g] = canvas(W, H * panels.length);
  panels.forEach((p, i) => {
    const y = i * H;
    const grad = g.createLinearGradient(0, y, 0, y + H);
    grad.addColorStop(0, p.bg);
    grad.addColorStop(1, shadeHex(p.bg, -0.25));
    g.fillStyle = grad;
    g.fillRect(0, y, W, H);
    if (p.accent) {
      g.fillStyle = p.accent;
      g.beginPath();
      g.moveTo(0, y + H);
      g.lineTo(60, y);
      g.lineTo(84, y);
      g.lineTo(24, y + H);
      g.fill();
      g.fillRect(W - 40, y + 8, 28, H - 16);
    }
    g.fillStyle = p.fg;
    const font = p.style === 'italic' ? 'italic 900' : p.style === 'wide' ? '800' : '900';
    g.font = `${font} 40px 'Outfit', 'Arial Black', Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const text = p.style === 'wide' ? p.text.split('').join(' ') : p.text;
    g.fillText(text, W / 2 + 10, y + H / 2 + 2, W - 150);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.wrapS = THREE.RepeatWrapping;
  return { tex: t, count: panels.length };
}

function shadeHex(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * (1 + k))));
  return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

// ---- sprites ------------------------------------------------------------------------------------

/** Soft round glow. */
export function glowTexture(size = 64): THREE.Texture {
  const [c, g] = canvas(size, size);
  const r = size / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

/** Floodlight glare: bright core with a horizontal streak and soft star rays. */
export function glareTexture(): THREE.Texture {
  const S = 128;
  const [c, g] = canvas(S, S);
  const r = S / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.08, 'rgba(255,250,235,0.9)');
  grad.addColorStop(0.3, 'rgba(255,240,210,0.22)');
  grad.addColorStop(1, 'rgba(255,240,210,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'lighter';
  for (const [w, h, a] of [
    [S, 3, 0.55],
    [3, S * 0.6, 0.3],
  ] as const) {
    const lg = g.createRadialGradient(r, r, 0, r, r, Math.max(w, h) / 2);
    lg.addColorStop(0, `rgba(255,255,255,${a})`);
    lg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lg;
    g.fillRect(r - w / 2, r - h / 2, w, h);
  }
  return new THREE.CanvasTexture(c);
}

/** Shirt numbers 0-9 in a 10×1 strip (white digits with a dark outline). */
export function numberTexture(): THREE.Texture {
  const [c, g] = canvas(640, 96);
  g.font = "900 84px 'Outfit', 'Arial Black', Arial, sans-serif";
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < 10; i++) {
    g.lineWidth = 8;
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.strokeText(String(i), i * 64 + 32, 52);
    g.fillStyle = '#fff';
    g.fillText(String(i), i * 64 + 32, 52);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Big screen showing the score. Redraw with `draw` and set needsUpdate. */
export class ScreenTexture {
  readonly tex: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;
  constructor() {
    const [c, g] = canvas(512, 224);
    this.g = g;
    this.tex = new THREE.CanvasTexture(c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
  }
  draw(lines: { title: string; left: string; right: string; score: string; sub: string; flash?: string; colA: string; colB: string }): void {
    const g = this.g;
    const W = 512;
    const H = 224;
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#0a1430');
    grad.addColorStop(1, '#040814');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (lines.flash) {
      g.fillStyle = lines.flash === 'GOAL!' ? '#ff2a3a' : '#00c46a';
      g.fillRect(0, 0, W, H);
      g.fillStyle = '#fff';
      g.font = "italic 900 120px 'Outfit', 'Arial Black', sans-serif";
      g.fillText(lines.flash, W / 2, H / 2 + 6, W - 30);
    } else {
      g.fillStyle = '#7fb4ff';
      g.font = "700 26px 'Outfit', Arial, sans-serif";
      g.fillText(lines.title, W / 2, 30);
      g.fillStyle = lines.colA;
      g.fillRect(20, 70, 12, 70);
      g.fillStyle = lines.colB;
      g.fillRect(W - 32, 70, 12, 70);
      g.fillStyle = '#fff';
      g.font = "800 34px 'Outfit', Arial, sans-serif";
      g.fillText(lines.left, 130, 106, 180);
      g.fillText(lines.right, W - 130, 106, 180);
      g.font = "900 64px 'Outfit', Arial, sans-serif";
      g.fillText(lines.score, W / 2, 108);
      g.fillStyle = '#9fb0d8';
      g.font = "600 24px 'Outfit', Arial, sans-serif";
      g.fillText(lines.sub, W / 2, 180);
    }
    // LED pixel grid.
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let x = 0; x < W; x += 4) g.fillRect(x, 0, 1, H);
    for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
    this.tex.needsUpdate = true;
  }
}

/**
 * A small equirectangular stand-in for the stadium used as the environment map: pitch below, stands and the
 * bright floodlight ring around the horizon, sky above. Cheap to prefilter (no scene render).
 */
export function stadiumEnvTexture(night: boolean): THREE.Texture {
  const W = 512;
  const H = 256;
  const [c, g] = canvas(W, H);
  // Rows: y = 0 is straight up, H is straight down; the horizon is at H/2.
  const sky = g.createLinearGradient(0, 0, 0, H * 0.32);
  sky.addColorStop(0, night ? '#05070d' : '#5d8fd6');
  sky.addColorStop(1, night ? '#141b2b' : '#a9c6ea');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H * 0.32);
  // Roof and floodlight ring.
  g.fillStyle = night ? '#0b0d12' : '#5a6068';
  g.fillRect(0, H * 0.3, W, H * 0.06);
  g.fillStyle = night ? '#fff6e6' : '#e8e8e2';
  g.fillRect(0, H * 0.335, W, H * 0.018);
  if (night) {
    for (let x = 0; x < W; x += 16) {
      const r = g.createRadialGradient(x + 8, H * 0.344, 0, x + 8, H * 0.344, 14);
      r.addColorStop(0, 'rgba(255,250,235,1)');
      r.addColorStop(1, 'rgba(255,250,235,0)');
      g.fillStyle = r;
      g.fillRect(x - 6, H * 0.344 - 14, 28, 28);
    }
  }
  // Stands with a speckled crowd.
  const st = g.createLinearGradient(0, H * 0.36, 0, H * 0.5);
  st.addColorStop(0, night ? '#1a2238' : '#4a5670');
  st.addColorStop(1, night ? '#28324c' : '#6b7896');
  g.fillStyle = st;
  g.fillRect(0, H * 0.36, W, H * 0.14);
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * W;
    const y = H * (0.37 + Math.random() * 0.13);
    g.fillStyle = Math.random() < 0.6 ? (night ? '#2c5bd6' : '#3b6fe0') : Math.random() < 0.5 ? '#d8dbe2' : '#1a1a1e';
    g.fillRect(x, y, 2, 2);
  }
  // Boards.
  g.fillStyle = night ? '#6f7bd0' : '#9aa6e8';
  g.fillRect(0, H * 0.497, W, H * 0.008);
  // Pitch.
  const p = g.createLinearGradient(0, H * 0.505, 0, H);
  p.addColorStop(0, night ? '#2f6a28' : '#4f9a3a');
  p.addColorStop(1, night ? '#173f14' : '#2c6a22');
  g.fillStyle = p;
  g.fillRect(0, H * 0.505, W, H * 0.495);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
