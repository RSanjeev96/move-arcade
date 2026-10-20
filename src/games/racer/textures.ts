/** Canvas-generated textures for the circuits (all original artwork; brand names are fictional). */
import * as THREE from 'three';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, srgb = true, repeat = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** Fictional sponsors for barriers and billboards. */
export const BRANDS: { name: string; tag: string; bg: string; fg: string; accent: string }[] = [
  { name: 'VELOCE', tag: 'TYRES', bg: '#101820', fg: '#f6c90e', accent: '#f6c90e' },
  { name: 'AURORA', tag: 'ENERGY', bg: '#0b3d91', fg: '#ffffff', accent: '#4fd1ff' },
  { name: 'KAPPA', tag: 'LUBRICANTS', bg: '#c8102e', fg: '#ffffff', accent: '#ffd23f' },
  { name: 'ORBIT', tag: 'TIMEPIECES', bg: '#f2f2f2', fg: '#14213d', accent: '#c0a062' },
  { name: 'ZEPHYR', tag: 'AIRWAYS', bg: '#006b3c', fg: '#ffffff', accent: '#9be564' },
  { name: 'NOVA', tag: 'TELECOM', bg: '#6a1b9a', fg: '#ffffff', accent: '#ff4fa3' },
  { name: 'HELIX', tag: 'MOTORS', bg: '#ff7a00', fg: '#14213d', accent: '#ffffff' },
  { name: 'MERIDIAN', tag: 'BANK', bg: '#14213d', fg: '#ffffff', accent: '#e5e5e5' },
];

function drawBrand(g: CanvasRenderingContext2D, b: (typeof BRANDS)[number], x: number, y: number, w: number, h: number): void {
  g.fillStyle = b.bg;
  g.fillRect(x, y, w, h);
  g.fillStyle = b.accent;
  g.fillRect(x, y + h * 0.84, w, h * 0.06);
  // Simple emblem.
  g.save();
  g.translate(x + h * 0.55, y + h * 0.45);
  g.fillStyle = b.accent;
  g.beginPath();
  g.moveTo(-h * 0.28, h * 0.22);
  g.lineTo(0, -h * 0.3);
  g.lineTo(h * 0.28, h * 0.22);
  g.lineTo(0, h * 0.06);
  g.closePath();
  g.fill();
  g.restore();
  g.fillStyle = b.fg;
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.font = `900 ${Math.round(h * 0.46)}px Arial, Helvetica, sans-serif`;
  g.fillText(b.name, x + h * 1.05, y + h * 0.4, w - h * 1.3);
  g.font = `600 ${Math.round(h * 0.16)}px Arial, Helvetica, sans-serif`;
  g.fillText(b.tag, x + h * 1.08, y + h * 0.72, w - h * 1.3);
}

/**
 * Barrier texture: a row of 8 sponsor panels (v 0.22..1) over a concrete/kerb band (v 0..0.22).
 * u = 0..1 covers 8 panels.
 */
export function barrierTexture(night: boolean): THREE.CanvasTexture {
  const W = 2048;
  const H = 256;
  const [c, g] = canvas(W, H);
  const pw = W / 8;
  const top = Math.round(H * 0.2);
  BRANDS.forEach((b, i) => drawBrand(g, b, i * pw + 3, top + 6, pw - 6, H - top - 14));
  // Gaps between panels.
  g.fillStyle = night ? '#3a3d44' : '#8a8d93';
  for (let i = 0; i < 8; i++) g.fillRect(i * pw - 3, top, 6, H - top);
  g.fillRect(0, top, W, 6);
  g.fillRect(0, H - 8, W, 8);
  // Top band (the wall top): painted stripes.
  for (let x = 0; x < W; x += 64) {
    g.fillStyle = (x / 64) % 2 ? '#d71920' : '#f2f2f2';
    g.fillRect(x, 0, 64, top);
  }
  // Grime.
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
    g.fillRect(Math.random() * W, H * 0.6 + Math.random() * H * 0.4, 3 + Math.random() * 10, 2);
  }
  return tex(c);
}

/** Large billboard (one brand per row of a 4-row atlas). */
export function billboardTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(1024, 1024);
  for (let i = 0; i < 4; i++) {
    const b = BRANDS[(i * 2 + 1) % BRANDS.length];
    drawBrand(g, b, 0, i * 256 + 8, 1024, 240);
  }
  return tex(c, true, false);
}

/** Kerb: red/white bands along v, with a darker outer edge. u = across (0 road side → 1 outside). */
export function kerbTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 128);
  g.fillStyle = '#d0141e';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#e2e2e2';
  g.fillRect(0, 64, 64, 64);
  const grd = g.createLinearGradient(0, 0, 64, 0);
  grd.addColorStop(0, 'rgba(0,0,0,0.25)');
  grd.addColorStop(0.15, 'rgba(0,0,0,0)');
  grd.addColorStop(0.8, 'rgba(0,0,0,0)');
  grd.addColorStop(1, 'rgba(0,0,0,0.3)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 128);
  // Ridges.
  for (let y = 0; y < 128; y += 8) {
    g.fillStyle = 'rgba(0,0,0,0.08)';
    g.fillRect(0, y, 64, 2);
  }
  return tex(c);
}

/** Catch fence: diamond wire mesh with alpha. */
export function fenceTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(200,205,210,1)';
  g.lineWidth = 3;
  for (let k = -128; k <= 256; k += 32) {
    g.beginPath();
    g.moveTo(k, 0);
    g.lineTo(k + 128, 128);
    g.stroke();
    g.beginPath();
    g.moveTo(k, 128);
    g.lineTo(k + 128, 0);
    g.stroke();
  }
  g.fillStyle = 'rgba(160,165,170,1)';
  g.fillRect(0, 0, 128, 5);
  return tex(c, true);
}

/** Chequered start/finish band. */
export function chequerTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(256, 32);
  for (let x = 0; x < 16; x++)
    for (let y = 0; y < 2; y++) {
      g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
      g.fillRect(x * 16, y * 16, 16, 16);
    }
  const t = tex(c);
  t.magFilter = THREE.NearestFilter;
  return t;
}

/** Pit building facade with garage openings (lit interiors in team colours). */
export function garageTexture(colors: string[], night: boolean): THREE.CanvasTexture {
  const [c, g] = canvas(2048, 256);
  g.fillStyle = night ? '#2a2e36' : '#d9dde2';
  g.fillRect(0, 0, 2048, 256);
  // Upper glazing band.
  const glass = g.createLinearGradient(0, 0, 0, 90);
  glass.addColorStop(0, night ? '#334a6a' : '#5f86a8');
  glass.addColorStop(1, night ? '#1a2a40' : '#9cc3dd');
  g.fillStyle = glass;
  g.fillRect(0, 12, 2048, 76);
  g.fillStyle = night ? '#555c66' : '#aab0b8';
  for (let x = 0; x < 2048; x += 64) g.fillRect(x, 12, 4, 76);
  // Garages.
  const n = 12;
  const gw = 2048 / n;
  for (let i = 0; i < n; i++) {
    const col = colors[i % colors.length];
    const x = i * gw + 14;
    const w = gw - 28;
    g.fillStyle = '#0d0f12';
    g.fillRect(x, 112, w, 140);
    const grd = g.createLinearGradient(0, 112, 0, 252);
    grd.addColorStop(0, col);
    grd.addColorStop(1, '#101014');
    g.globalAlpha = 0.85;
    g.fillStyle = grd;
    g.fillRect(x + 6, 118, w - 12, 134);
    g.globalAlpha = 1;
    // Light strip.
    g.fillStyle = '#fff7e0';
    g.fillRect(x + 10, 116, w - 20, 5);
    g.fillStyle = col;
    g.fillRect(x, 96, w, 12);
  }
  return tex(c, true);
}

/** Tyre-wall stack: horizontal rubber bands. */
export function tyreStackTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(32, 128);
  for (let i = 0; i < 4; i++) {
    const y = i * 32;
    const grd = g.createLinearGradient(0, y, 0, y + 32);
    grd.addColorStop(0, '#060606');
    grd.addColorStop(0.5, '#2a2a2a');
    grd.addColorStop(1, '#060606');
    g.fillStyle = grd;
    g.fillRect(0, y, 32, 32);
  }
  return tex(c);
}

/** Circuit name banner for the start gantry. */
export function bannerTexture(text: string, bg: string, fg: string): THREE.CanvasTexture {
  const [c, g] = canvas(1024, 128);
  g.fillStyle = bg;
  g.fillRect(0, 0, 1024, 128);
  g.fillStyle = fg;
  g.font = '900 78px Arial, Helvetica, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text.toUpperCase(), 512, 66, 980);
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.fillRect(0, 0, 1024, 6);
  g.fillRect(0, 122, 1024, 6);
  return tex(c, true, false);
}

/** Soft round particle. */
export function puffTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return tex(c, true, false);
}

/** Blob shadow under cars far from the shadow camera. */
export function blobTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 128);
  const grad = g.createRadialGradient(32, 64, 4, 32, 64, 60);
  grad.addColorStop(0, 'rgba(0,0,0,0.75)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.save();
  g.scale(1, 1);
  g.fillRect(0, 0, 64, 128);
  g.restore();
  return tex(c, true, false);
}

/** Procedural water normal map (tileable sum of sines). */
export function waterNormalTexture(): THREE.DataTexture {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const h = (x: number, y: number) => {
    const a = (x / N) * Math.PI * 2;
    const b = (y / N) * Math.PI * 2;
    return (
      Math.sin(a * 3 + b * 2) * 0.5 +
      Math.sin(a * 7 - b * 5 + 1.3) * 0.25 +
      Math.sin(a * 13 + b * 11 + 0.7) * 0.12 +
      Math.sin(-a * 19 + b * 23 + 2.1) * 0.06
    );
  };
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const dx = h(x + 1, y) - h(x - 1, y);
      const dy = h(x, y + 1) - h(x, y - 1);
      const nx = -dx * 2.5;
      const ny = -dy * 2.5;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * N + x) * 4;
      data[i] = ((nx / l) * 0.5 + 0.5) * 255;
      data[i + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Spectator sprites: 4 poses side by side (arms down, one arm up, both arms up, holding a flag).
 * Red channel = shirt mask (tinted per spectator), green = skin, blue = dark (hair/trousers); alpha = silhouette.
 */
export function crowdTexture(): THREE.CanvasTexture {
  const W = 64;
  const [c, g] = canvas(W * 4, 128);
  g.clearRect(0, 0, W * 4, 128);
  const shirt = '#ff0000';
  const skin = '#00ff00';
  const dark = '#0000ff';
  for (let v = 0; v < 4; v++) {
    const x = v * W + W / 2;
    // Legs / trousers (mostly hidden behind the row in front).
    g.fillStyle = dark;
    g.fillRect(x - 11, 88, 22, 40);
    // Torso.
    g.fillStyle = shirt;
    g.beginPath();
    g.moveTo(x - 15, 92);
    g.lineTo(x - 13, 52);
    g.quadraticCurveTo(x, 44, x + 13, 52);
    g.lineTo(x + 15, 92);
    g.closePath();
    g.fill();
    // Arms.
    const arm = (side: number, up: boolean) => {
      g.strokeStyle = shirt;
      g.lineCap = 'round';
      g.lineWidth = 8;
      g.beginPath();
      g.moveTo(x + side * 12, 56);
      if (up) {
        g.lineTo(x + side * 18, 36);
        g.lineTo(x + side * 16, 16);
      } else {
        g.lineTo(x + side * 17, 74);
        g.lineTo(x + side * 16, 88);
      }
      g.stroke();
      g.fillStyle = skin;
      g.beginPath();
      g.arc(x + side * 16, up ? 13 : 90, 4.5, 0, Math.PI * 2);
      g.fill();
    };
    arm(-1, v === 2);
    arm(1, v === 1 || v === 2 || v === 3);
    if (v === 3) {
      // Flag.
      g.fillStyle = shirt;
      g.fillRect(x + 16, 2, 22, 14);
    }
    // Head + hair.
    g.fillStyle = skin;
    g.beginPath();
    g.arc(x, 36, 9.5, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = dark;
    g.beginPath();
    g.arc(x, 32, 9.5, Math.PI, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}
