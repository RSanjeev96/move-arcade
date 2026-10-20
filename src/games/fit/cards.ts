/**
 * Move pictograms for the timeline cards and menus, drawn from the move definitions themselves: the key pose as a
 * bold figure, a ghost of the start pose and motion arrows between them.
 */
import { MOVE, NEUTRAL, cardBeat, sampleMove, type MoveDef } from './moves';
import { solve, type Joints } from './rig';
import type { V3 } from './moves';

const cache = new Map<string, string>();

export const KIND_COLORS: Record<string, [string, string]> = {
  warm: ['#ffb36b', '#ff5f8f'],
  cardio: ['#ff2d6a', '#ff8a3d'],
  dance: ['#c04bff', '#ff4bd8'],
  strength: ['#ff8a3d', '#ffd04d'],
  boxing: ['#ff4b4b', '#ff9f1c'],
  stretch: ['#1fb8ff', '#3bffb4'],
  rest: ['#3b5bff', '#1fb8ff'],
};

type Seg = [keyof Joints, keyof Joints];
const LIMBS: Seg[] = [
  ['ls', 'le'],
  ['le', 'lw'],
  ['rs', 're'],
  ['re', 'rw'],
  ['lh', 'lk'],
  ['lk', 'la'],
  ['rh', 'rk'],
  ['rk', 'ra'],
];

function startBeat(m: MoveDef, key: number): number {
  // Where the movement comes from: the first keyframe, or the other side / the half-way pose.
  if (key > 0) return 0;
  return m.alt ? m.beats : m.beats / 2;
}

/** Turn the figure about the vertical axis so depth moves read on a flat card. */
function view(j: Joints, yaw: number): Joints {
  if (!yaw) return j;
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const r = (v: V3): V3 => [v[0] * c + v[2] * sn, v[1], -v[0] * sn + v[2] * c];
  const out = { ...j } as Joints;
  for (const k of ['pelvis', 'S', 'ls', 'rs', 'le', 're', 'lw', 'rw', 'lh', 'rh', 'lk', 'rk', 'la', 'ra', 'nose'] as const) out[k] = r(j[k]);
  return out;
}

function drawFigure(g: CanvasRenderingContext2D, j: Joints, P: (v: V3) => [number, number], u: number, color: string, alpha: number, glow: boolean, headU = u): void {
  g.save();
  g.globalAlpha = alpha;
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  void glow;
  // Torso as a tapered shape.
  const [lsx, lsy] = P(j.ls);
  const [rsx, rsy] = P(j.rs);
  const [lhx, lhy] = P(j.lh);
  const [rhx, rhy] = P(j.rh);
  g.lineWidth = u * 0.3;
  g.beginPath();
  g.moveTo(lsx, lsy);
  g.lineTo(rsx, rsy);
  g.lineTo(rhx, rhy);
  g.lineTo(lhx, lhy);
  g.closePath();
  g.fill();
  g.stroke();
  g.lineWidth = u * 0.32;
  for (const [a, b] of LIMBS) {
    const [x1, y1] = P(j[a] as V3);
    const [x2, y2] = P(j[b] as V3);
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
  }
  // Hands and feet.
  for (const k of ['lw', 'rw'] as const) {
    const [x, y] = P(j[k]);
    g.beginPath();
    g.arc(x, y, u * (0.13 + 0.06 * j.pose.fist), 0, Math.PI * 2);
    g.fill();
  }
  // Neck and head.
  const S = P(j.S);
  const top: V3 = [j.nose[0], j.nose[1] + 0.12, j.nose[2]];
  const [hx, hy] = P(top);
  g.lineWidth = u * 0.22;
  g.beginPath();
  g.moveTo(S[0], S[1]);
  g.lineTo(S[0] + (hx - S[0]) * 0.45, S[1] + (hy - S[1]) * 0.45);
  g.stroke();
  g.beginPath();
  g.arc(hx, hy, headU * 0.33 + (u - headU) * 0.25, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function arrow(g: CanvasRenderingContext2D, a: [number, number], b: [number, number], u: number, color: string): void {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy);
  if (l < u * 0.6) return;
  // Curve slightly away from the body.
  const nx = -dy / l;
  const ny = dx / l;
  const bend = l * 0.25;
  const c: [number, number] = [(a[0] + b[0]) / 2 + nx * bend, (a[1] + b[1]) / 2 + ny * bend];
  // Shorten the ends.
  const s = 0.18;
  const p0: [number, number] = [a[0] + (c[0] - a[0]) * s, a[1] + (c[1] - a[1]) * s];
  const p1: [number, number] = [b[0] + (c[0] - b[0]) * s, b[1] + (c[1] - b[1]) * s];
  g.save();
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = u * 0.11;
  g.lineCap = 'round';
  g.setLineDash([u * 0.22, u * 0.18]);
  g.beginPath();
  g.moveTo(p0[0], p0[1]);
  g.quadraticCurveTo(c[0], c[1], p1[0], p1[1]);
  g.stroke();
  g.setLineDash([]);
  const ang = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
  const h = u * 0.36;
  g.beginPath();
  g.moveTo(p1[0] + Math.cos(ang) * h * 0.4, p1[1] + Math.sin(ang) * h * 0.4);
  g.lineTo(p1[0] + Math.cos(ang + 2.5) * h, p1[1] + Math.sin(ang + 2.5) * h);
  g.lineTo(p1[0] + Math.cos(ang - 2.5) * h, p1[1] + Math.sin(ang - 2.5) * h);
  g.closePath();
  g.fill();
  g.restore();
}

/** A pictogram of the move as a data URL (transparent background), cached. */
export function pictogram(id: string, w = 240, h = 280): string {
  const key = `${id}:${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const m = MOVE[id] ?? MOVE.breathe;
  const kb = cardBeat(m);
  const main = view(solve(sampleMove(m, kb)), m.view ?? 0);
  const ghost = view(solve(m.kind === 'rest' ? NEUTRAL : sampleMove(m, startBeat(m, kb))), m.view ?? 0);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  // Fit both poses.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const j of [main, ghost]) {
    for (const k of ['ls', 'rs', 'le', 're', 'lw', 'rw', 'lh', 'rh', 'lk', 'rk', 'la', 'ra', 'nose'] as const) {
      const p = j[k];
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1] + (k === 'nose' ? 0.5 : 0));
    }
  }
  minX -= 0.4;
  maxX += 0.4;
  minY -= 0.25;
  maxY += 0.2;
  const sc = Math.min((w * 0.9) / (maxX - minX), (h * 0.92) / (maxY - minY));
  const ox = w / 2 - ((minX + maxX) / 2) * sc;
  const oy = h * 0.96 + minY * sc;
  const P = (v: V3): [number, number] => [ox + v[0] * sc, oy - v[1] * sc];
  // Floor shadow.
  const floorY = P([0, Math.min(main.la[1], main.ra[1], ghost.la[1], ghost.ra[1]) - 0.1, 0])[1];
  g.fillStyle = 'rgba(0,0,0,0.2)';
  g.beginPath();
  g.ellipse(w / 2, floorY, w * 0.3, sc * 0.2, 0, 0, Math.PI * 2);
  g.fill();
  const moved = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.55;
  const showGhost = ['lw', 'rw', 'la', 'ra'].some((k) => moved(main[k as 'lw'], ghost[k as 'lw'])) || Math.abs(main.S[1] - ghost.S[1]) > 0.3;
  if (showGhost) drawFigure(g, ghost, P, sc, 'rgba(255,255,255,1)', 0.22, false);
  // A cheap glow: the figure drawn fatter and translucent underneath (no canvas blur, which is slow on tablets).
  drawFigure(g, main, P, sc * 1.55, 'rgba(255,255,255,1)', 0.12, false, sc);
  drawFigure(g, main, P, sc * 1.22, 'rgba(255,255,255,1)', 0.18, false, sc);
  drawFigure(g, main, P, sc, '#ffffff', 1, true);
  if (showGhost) {
    for (const k of ['lw', 'rw', 'la', 'ra'] as const) {
      if (moved(main[k], ghost[k])) arrow(g, P(ghost[k]), P(main[k]), sc, '#fff35c');
    }
    if (Math.abs(main.S[1] - ghost.S[1]) > 0.3 && !moved(main.lw, ghost.lw)) {
      const x = P(main.S)[0] + sc * 1.4;
      arrow(g, [x, P(ghost.S)[1]], [x, P(main.S)[1]], sc, '#fff35c');
    }
  }
  if (m.kind === 'boxing' && m.rep) {
    // Impact star at the punching hand.
    const hand = main.lw[2] > main.rw[2] ? main.lw : main.rw;
    const [x, y] = P(hand);
    g.save();
    g.strokeStyle = '#fff35c';
    g.lineWidth = sc * 0.09;
    g.lineCap = 'round';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      g.beginPath();
      g.moveTo(x + Math.cos(a) * sc * 0.3, y + Math.sin(a) * sc * 0.3);
      g.lineTo(x + Math.cos(a) * sc * 0.48, y + Math.sin(a) * sc * 0.48);
      g.stroke();
    }
    g.restore();
  }
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

export function kindColors(id: string): [string, string] {
  return KIND_COLORS[(MOVE[id] ?? MOVE.breathe).kind];
}
