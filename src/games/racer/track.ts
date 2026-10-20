/**
 * Circuit geometry and race bookkeeping (pure logic, no rendering).
 *
 * World axes follow three.js: x = east, y = up, z = south. Map control points are given as (x east, y north,
 * elevation) and converted with z = -y, so a right turn on the map is a right turn in the world.
 * Positions along the circuit are described by `s` (metres from the start/finish line along the centre line)
 * and `d` (lateral offset in metres, + = right of the direction of travel).
 */
import * as THREE from 'three';

export type Theme = 'coast' | 'city';

export interface TrackDef {
  id: string;
  name: string;
  /** Short description for the menu. */
  place: string;
  theme: Theme;
  /** Map control points [x east, y north, elevation]; the first one is the start/finish line. Clockwise. */
  points: [number, number, number][];
  /** Asphalt width in metres. */
  width: number;
  /** Road edge → barrier distance on straights and inside corners. */
  runoff: number;
  /** Road edge → barrier distance on the outside of corners. */
  runoffCorner: number;
  /** Gravel traps on the outside of slow corners. */
  gravel: boolean;
  /** Pit straight range [from, to] in metres around the start line (from < 0): pit wall on the right. */
  pit: [number, number];
}

/** Layout commands: straight `['S', length, height?]` or arc `['T', degrees (+ = right), radius, height?]`. */
export type Cmd = ['S', number, number?] | ['T', number, number, number?];

/**
 * Turtle layout: walks the commands from (0,0) heading `heading0` (compass degrees, 0 = north, 90 = east)
 * and returns control points every few metres. The lengths of the two straights at indices `free` are solved
 * so that the loop closes exactly (their headings must not be parallel).
 */
export function layout(cmds: Cmd[], heading0: number, free: [number, number]): [number, number, number][] {
  const run = (la: number, lb: number, emit: ((x: number, y: number, h: number) => void) | null) => {
    let x = 0;
    let y = 0;
    let hd = (heading0 * Math.PI) / 180;
    let h = 0;
    const dirs: [number, number][] = [];
    cmds.forEach((c, idx) => {
      const h0 = h;
      const h1 = (c[0] === 'S' ? c[2] : c[3]) ?? h;
      if (c[0] === 'S') {
        const len = idx === free[0] ? c[1] + la : idx === free[1] ? c[1] + lb : c[1];
        dirs[idx] = [Math.sin(hd), Math.cos(hd)];
        const steps = Math.max(1, Math.ceil(len / 40));
        for (let k = 1; k <= steps; k++) {
          const f = k / steps;
          emit?.(x + Math.sin(hd) * len * f, y + Math.cos(hd) * len * f, h0 + (h1 - h0) * f);
        }
        x += Math.sin(hd) * len;
        y += Math.cos(hd) * len;
      } else {
        const ang = (c[1] * Math.PI) / 180;
        const r = c[2];
        const steps = Math.max(2, Math.ceil((Math.abs(ang) * r) / 9));
        // Centre of the arc lies to the right (right turn) or left of the heading.
        const side = Math.sign(ang);
        const cx = x + Math.cos(hd) * r * side;
        const cy = y - Math.sin(hd) * r * side;
        for (let k = 1; k <= steps; k++) {
          const a = hd + (ang * k) / steps;
          const px = cx - Math.cos(a) * r * side;
          const py = cy + Math.sin(a) * r * side;
          emit?.(px, py, h0 + (h1 - h0) * (k / steps));
        }
        hd += ang;
        x = cx - Math.cos(hd) * r * side;
        y = cy + Math.sin(hd) * r * side;
      }
      h = h1;
    });
    return { x, y, dirs };
  };
  const base = run(0, 0, null);
  const [ax, ay] = base.dirs[free[0]];
  const [bx, by] = base.dirs[free[1]];
  // Solve base + la·a + lb·b = 0.
  const det = ax * by - ay * bx;
  const la = (-base.x * by + base.y * bx) / det;
  const lb = (-ax * base.y + ay * base.x) / det;
  const pts: [number, number, number][] = [[0, 0, 0]];
  run(la, lb, (x, y, h) => pts.push([x, y, h]));
  pts.pop(); // last point coincides with the start
  return pts;
}

export const TRACKS: TrackDef[] = [
  {
    id: 'coast',
    name: 'Baia Serena',
    place: 'Seaside circuit · sunny afternoon',
    theme: 'coast',
    width: 14,
    runoff: 11,
    runoffCorner: 22,
    gravel: true,
    pit: [-430, 170],
    points: layout(
      [
        ['S', 540, 0],
        ['T', 90, 28, 0.3],
        ['S', 110, 1.5],
        ['T', -50, 55, 2.5],
        ['T', 100, 95, 4.5],
        ['S', 250, 7],
        ['T', 40, 80, 8],
        ['T', -40, 60, 8.5],
        ['T', 80, 55, 9],
        ['T', -40, 60, 8.5],
        ['S', 600, 6],
        ['T', 150, 21, 5.5],
        ['S', 130, 4.5],
        ['T', -60, 42, 4],
        ['S', 140, 3],
        ['T', -45, 24, 2.6],
        ['T', 45, 24, 2.2],
        ['S', 100, 1.4],
        ['T', 90, 85, 0.4],
        ['S', 200, 0],
      ],
      90,
      [0, 14],
    ),
  },
  {
    id: 'city',
    name: 'Lumen Harbour',
    place: 'Night street circuit · city lights',
    theme: 'city',
    width: 12,
    runoff: 4.5,
    runoffCorner: 9,
    gravel: false,
    pit: [-190, 150],
    points: layout(
      [
        ['S', 400],
        ['T', 90, 26],
        ['S', 200],
        ['T', 90, 24],
        ['S', 110],
        ['T', -90, 22],
        ['S', 150],
        ['T', 180, 20],
        ['S', 150],
        ['T', -45, 20],
        ['T', 45, 20],
        ['S', 120],
        ['T', -90, 24],
        ['S', 120],
        ['T', 24, 110],
        ['T', -24, 110],
        ['S', 120],
        ['T', 90, 28],
        ['S', 70],
        ['T', 90, 28],
        ['S', 210],
      ],
      0,
      [2, 16],
    ),
  },
];

export interface TrackData {
  def: TrackDef;
  n: number;
  /** Distance between samples (m). */
  step: number;
  length: number;
  hw: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Unit tangent in the ground plane. */
  tx: Float32Array;
  tz: Float32Array;
  /** Signed curvature of the centre line, + = left turn (1/m). */
  curv: Float32Array;
  /** Road gradient dy/ds. */
  grade: Float32Array;
  /** Distance from the centre line to the barrier face on each side (m, positive). */
  wallL: Float32Array;
  wallR: Float32Array;
  /** Kerb strength 0..1 on each side (kerb drawn when > 0.5). */
  kerbL: Float32Array;
  kerbR: Float32Array;
  /** Gravel trap outside the kerb on each side. */
  gravelL: Uint8Array;
  gravelR: Uint8Array;
  /** Racing line lateral offset (m, + right) and its curvature (+ left). */
  line: Float32Array;
  lineCurv: Float32Array;
  /** Corner id for each sample (-1 on straights); corners are numbered from the start line. */
  corner: Int16Array;
  corners: { s0: number; s1: number; apex: number; dir: -1 | 1 }[];
}

export const KERB_W = 1.5;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const smooth01 = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Cyclic box blur of radius r samples. */
export function blurCyclic(a: Float32Array, r: number, passes = 1): Float32Array {
  const n = a.length;
  let src = a;
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(n);
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[((k % n) + n) % n];
    for (let i = 0; i < n; i++) {
      out[i] = acc / (2 * r + 1);
      acc += src[(i + r + 1) % n] - src[(((i - r) % n) + n) % n];
    }
    src = out;
  }
  return src;
}

/** Cyclic running maximum over ±r samples. */
function dilateCyclic(a: Float32Array, r: number): Float32Array {
  const n = a.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let k = -r; k <= r; k++) m = Math.max(m, a[(((i + k) % n) + n) % n]);
    out[i] = m;
  }
  return out;
}

export function buildTrack(def: TrackDef, step = 2): TrackData {
  const pts = def.points.map(([mx, my, h]) => new THREE.Vector3(mx, h, -my));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
  curve.arcLengthDivisions = pts.length * 300;
  const total = curve.getLength();
  const n = Math.max(64, Math.round(total / step));
  const sp = curve.getSpacedPoints(n);
  const ds = total / n;
  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = sp[i].x;
    y[i] = sp[i].y;
    z[i] = sp[i].z;
  }
  const tx = new Float32Array(n);
  const tz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n;
    const b = (i + 1) % n;
    const dx = x[b] - x[a];
    const dz = z[b] - z[a];
    const l = Math.hypot(dx, dz) || 1;
    tx[i] = dx / l;
    tz[i] = dz / l;
  }
  let curv: Float32Array = new Float32Array(n);
  for (let i = 0; i < n; i++) curv[i] = signedTurn(tx, tz, (i - 1 + n) % n, (i + 1) % n) / (2 * ds);
  curv = blurCyclic(curv, 2, 2);
  const grade = new Float32Array(n);
  for (let i = 0; i < n; i++) grade[i] = (y[(i + 1) % n] - y[(i - 1 + n) % n]) / (2 * ds);
  const hw = def.width / 2;

  // Corner zones from the smoothed curvature.
  const absK = new Float32Array(n);
  for (let i = 0; i < n; i++) absK[i] = Math.abs(curv[i]);
  const zoneR = Math.round(28 / ds);
  const kZone = dilateCyclic(blurCyclic(absK, Math.round(6 / ds)), zoneR);
  const kSigned = blurCyclic(curv, Math.round(20 / ds));

  // Barriers: wider on the outside of corners, never past the turning centre on the inside.
  const wallL = new Float32Array(n);
  const wallR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cornerAmt = smooth01(1 / 400, 1 / 90, kZone[i]);
    const outsideIsRight = kSigned[i] > 0; // left turn → outside is right
    const base = hw + def.runoff;
    const outside = hw + def.runoff + (def.runoffCorner - def.runoff) * cornerAmt;
    const inside = hw + def.runoff * (1 - 0.25 * cornerAmt);
    wallR[i] = outsideIsRight ? outside : cornerAmt > 0.05 ? inside : base;
    wallL[i] = outsideIsRight ? (cornerAmt > 0.05 ? inside : base) : outside;
  }
  // Keep inside barriers clear of the turning centre.
  for (let i = 0; i < n; i++) {
    const k = curv[i];
    if (Math.abs(k) < 1e-4) continue;
    const lim = 0.8 / Math.abs(k);
    if (k > 0) wallL[i] = Math.min(wallL[i], Math.max(hw + 2.5, lim));
    else wallR[i] = Math.min(wallR[i], Math.max(hw + 2.5, lim));
  }
  // Pit wall along the main straight (right side).
  for (let i = 0; i < n; i++) {
    const sa = i * ds > total / 2 ? i * ds - total : i * ds;
    if (sa > def.pit[0] - 30 && sa < def.pit[1] + 30) {
      const edge = Math.min(sa - (def.pit[0] - 30), def.pit[1] + 30 - sa) / 30;
      wallR[i] = Math.min(wallR[i], hw + 2.6 + (1 - Math.min(1, edge)) * (wallR[i] - hw - 2.6));
    }
  }
  const smoothWall = (w: Float32Array) => blurCyclic(w, Math.round(10 / ds), 2);
  let wl = smoothWall(wallL);
  let wr = smoothWall(wallR);
  // Keep barriers away from other parts of the circuit that pass nearby.
  const grid = new TrackGrid({ n, x, z, step: ds }, 30);
  for (const [w, sign] of [
    [wl, -1],
    [wr, 1],
  ] as const) {
    for (let i = 0; i < n; i++) {
      const nx = -tz[i] * sign;
      const nz = tx[i] * sign;
      for (let tries = 0; tries < 8; tries++) {
        const px = x[i] + nx * w[i];
        const pz = z[i] + nz * w[i];
        const near = grid.nearest(px, pz, i, Math.round(120 / ds));
        if (!near || near.dist > hw + 4) break;
        w[i] = Math.max(hw + 2, w[i] - 2);
      }
    }
  }
  wl = blurCyclic(wl, 2);
  wr = blurCyclic(wr, 2);
  for (let i = 0; i < n; i++) {
    wl[i] = Math.max(hw + 2, wl[i]);
    wr[i] = Math.max(hw + 2, wr[i]);
  }

  // Kerbs inside and outside every corner; gravel outside slow corners (shifted toward the exit).
  const kerbL = new Float32Array(n);
  const kerbR = new Float32Array(n);
  const gravelL = new Uint8Array(n);
  const gravelR = new Uint8Array(n);
  const kKerb = dilateCyclic(absK, Math.round(14 / ds));
  const shift = Math.round(25 / ds);
  for (let i = 0; i < n; i++) {
    const amt = smooth01(1 / 320, 1 / 160, kKerb[i]);
    kerbL[i] = amt;
    kerbR[i] = amt;
    if (def.gravel) {
      const j = (i - shift + n) % n;
      const slow = kZone[j] > 1 / 110;
      if (slow) {
        if (kSigned[j] > 0) gravelR[i] = 1;
        else gravelL[i] = 1;
      }
    }
  }
  // No kerbs or gravel on the start/finish straight around the grid.
  for (let i = 0; i < n; i++) {
    const sAlong = i * ds;
    if (sAlong < 60 || sAlong > total - 160) {
      gravelL[i] = gravelR[i] = 0;
    }
  }

  // Corners list.
  const corner = new Int16Array(n).fill(-1);
  const corners: TrackData['corners'] = [];
  const inCorner = (i: number) => kZone[i] > 1 / 260;
  let start = 0;
  while (start < n && inCorner(start)) start++;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (inCorner(i) && !inCorner((i - 1 + n) % n)) {
      let j = i;
      let apex = i;
      let best = 0;
      let len = 0;
      while (inCorner(j % n) && len < n) {
        if (absK[j % n] > best) {
          best = absK[j % n];
          apex = j % n;
        }
        j++;
        len++;
      }
      const id = corners.length;
      for (let q = i; q < j; q++) corner[q % n] = id;
      corners.push({ s0: i * ds, s1: (j % n) * ds, apex: apex * ds, dir: curv[apex] > 0 ? -1 : 1 });
    }
  }

  const t: TrackData = {
    def,
    n,
    step: ds,
    length: total,
    hw,
    x,
    y,
    z,
    tx,
    tz,
    curv,
    grade,
    wallL: wl,
    wallR: wr,
    kerbL,
    kerbR,
    gravelL,
    gravelR,
    line: new Float32Array(n),
    lineCurv: new Float32Array(n),
    corner,
    corners,
  };
  computeRacingLine(t);
  return t;
}

/** Signed turn angle (+ = left) from tangent a to tangent b. */
function signedTurn(tx: Float32Array, tz: Float32Array, a: number, b: number): number {
  const cross = tx[a] * tz[b] - tz[a] * tx[b];
  const dot = tx[a] * tx[b] + tz[a] * tz[b];
  return -Math.atan2(cross, dot);
}

/**
 * Minimum-curvature racing line by elastic-band relaxation: every point moves toward the midpoint of its
 * neighbours (at shrinking scales), constrained to stay on the asphalt.
 */
export function computeRacingLine(t: TrackData, margin = 1.7): void {
  const { n, x, z, tx, tz } = t;
  const lim = t.hw - margin;
  const d = new Float32Array(n);
  const px = new Float32Array(n);
  const pz = new Float32Array(n);
  const upd = (i: number) => {
    px[i] = x[i] - tz[i] * d[i];
    pz[i] = z[i] + tx[i] * d[i];
  };
  for (let i = 0; i < n; i++) upd(i);
  const scales = [Math.round(60 / t.step), Math.round(30 / t.step), Math.round(14 / t.step), Math.round(6 / t.step)];
  for (const k of scales) {
    for (let it = 0; it < 70; it++) {
      for (let i = 0; i < n; i++) {
        const a = (i - k + n) % n;
        const b = (i + k) % n;
        const mx = (px[a] + px[b]) / 2;
        const mz = (pz[a] + pz[b]) / 2;
        // Project the midpoint onto this sample's normal (right normal = (-tz, tx)).
        const off = (mx - x[i]) * -tz[i] + (mz - z[i]) * tx[i];
        d[i] = clamp(d[i] + (off - d[i]) * 0.6, -lim, lim);
        upd(i);
      }
    }
  }
  const sm = blurCyclic(d, 2, 2);
  for (let i = 0; i < n; i++) sm[i] = clamp(sm[i], -lim, lim);
  t.line.set(sm);
  for (let i = 0; i < n; i++) upd(i);
  for (let i = 0; i < n; i++) {
    px[i] = x[i] - tz[i] * sm[i];
    pz[i] = z[i] + tx[i] * sm[i];
  }
  const k = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 2 + n) % n;
    const c = (i + 2) % n;
    const ax = px[i] - px[a];
    const az = pz[i] - pz[a];
    const bx = px[c] - px[i];
    const bz = pz[c] - pz[i];
    const cross = ax * bz - az * bx;
    const dot = ax * bx + az * bz;
    const ang = -Math.atan2(cross, dot);
    const len = (Math.hypot(ax, az) + Math.hypot(bx, bz)) / 2;
    k[i] = ang / Math.max(0.1, len);
  }
  t.lineCurv.set(blurCyclic(k, 2, 2));
}

// ---- sampling --------------------------------------------------------------------------------

export function wrapS(t: TrackData, s: number): number {
  const L = t.length;
  return ((s % L) + L) % L;
}

/** Linear interpolation of a per-sample array at distance s (cyclic). */
export function sampleAt(t: TrackData, arr: ArrayLike<number>, s: number): number {
  const f = wrapS(t, s) / t.step;
  const i = Math.floor(f) % t.n;
  const j = (i + 1) % t.n;
  const k = f - Math.floor(f);
  return arr[i] + (arr[j] - arr[i]) * k;
}

export interface Frame {
  x: number;
  y: number;
  z: number;
  /** Unit tangent (ground plane). */
  tx: number;
  tz: number;
  /** World yaw so that a model facing +z points along the tangent. */
  yaw: number;
}

/** Centre-line frame at distance s. */
export function frameAt(t: TrackData, s: number, out: Frame = { x: 0, y: 0, z: 0, tx: 0, tz: 1, yaw: 0 }): Frame {
  const f = wrapS(t, s) / t.step;
  const i = Math.floor(f) % t.n;
  const j = (i + 1) % t.n;
  const k = f - Math.floor(f);
  out.x = t.x[i] + (t.x[j] - t.x[i]) * k;
  out.y = t.y[i] + (t.y[j] - t.y[i]) * k;
  out.z = t.z[i] + (t.z[j] - t.z[i]) * k;
  let ax = t.tx[i] + (t.tx[j] - t.tx[i]) * k;
  let az = t.tz[i] + (t.tz[j] - t.tz[i]) * k;
  const l = Math.hypot(ax, az) || 1;
  ax /= l;
  az /= l;
  out.tx = ax;
  out.tz = az;
  out.yaw = Math.atan2(ax, az);
  return out;
}

/** World position of (s, d). */
export function worldAt(t: TrackData, s: number, d: number, out = new THREE.Vector3()): THREE.Vector3 {
  const f = frameAt(t, s, TMP_FRAME);
  return out.set(f.x - f.tz * d, f.y, f.z + f.tx * d);
}
const TMP_FRAME: Frame = { x: 0, y: 0, z: 0, tx: 0, tz: 1, yaw: 0 };

/** Average curvature over [s, s + len]. */
export function curvAhead(t: TrackData, s: number, len: number, arr: Float32Array = t.curv): number {
  const steps = Math.max(1, Math.round(len / t.step));
  let acc = 0;
  for (let k = 0; k <= steps; k++) acc += sampleAt(t, arr, s + (len * k) / steps);
  return acc / (steps + 1);
}

// ---- spatial lookup -------------------------------------------------------------------------------

/** Uniform grid over the centre-line samples for "nearest point of the circuit" queries. */
export class TrackGrid {
  private cells = new Map<number, number[]>();
  constructor(
    private t: Pick<TrackData, 'n' | 'x' | 'z' | 'step'>,
    private cell = 30,
  ) {
    for (let i = 0; i < t.n; i++) {
      const key = this.key(Math.floor(t.x[i] / cell), Math.floor(t.z[i] / cell));
      let c = this.cells.get(key);
      if (!c) this.cells.set(key, (c = []));
      c.push(i);
    }
  }
  private key(cx: number, cz: number): number {
    return (cx + 5000) * 10007 + (cz + 5000);
  }
  /**
   * Nearest sample to (x, z) within ~2 cells. If `exclude` is given, samples within `excludeRange`
   * indices of it (cyclic) are ignored.
   */
  nearest(x: number, z: number, exclude = -1, excludeRange = 0): { i: number; dist: number } | null {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    let best = -1;
    let bd = Infinity;
    const n = this.t.n;
    for (let ox = -2; ox <= 2; ox++)
      for (let oz = -2; oz <= 2; oz++) {
        const c = this.cells.get(this.key(cx + ox, cz + oz));
        if (!c) continue;
        for (const i of c) {
          if (exclude >= 0) {
            const di = Math.abs(i - exclude);
            if (Math.min(di, n - di) <= excludeRange) continue;
          }
          const dd = (this.t.x[i] - x) ** 2 + (this.t.z[i] - z) ** 2;
          if (dd < bd) {
            bd = dd;
            best = i;
          }
        }
      }
    return best < 0 ? null : { i: best, dist: Math.sqrt(bd) };
  }
}

/** Project a world point onto the circuit: distance along (s) and signed lateral offset (d, + right). */
export function project(t: TrackData, grid: TrackGrid, x: number, z: number): { s: number; d: number; dist: number } | null {
  const near = grid.nearest(x, z);
  if (!near) return null;
  let bestS = near.i * t.step;
  let bestD = 0;
  let bestDist = Infinity;
  for (const i of [(near.i - 1 + t.n) % t.n, near.i]) {
    const j = (i + 1) % t.n;
    const ax = t.x[i];
    const az = t.z[i];
    const bx = t.x[j] - ax;
    const bz = t.z[j] - az;
    const l2 = bx * bx + bz * bz || 1;
    const u = clamp(((x - ax) * bx + (z - az) * bz) / l2, 0, 1);
    const qx = ax + bx * u;
    const qz = az + bz * u;
    const dist = Math.hypot(x - qx, z - qz);
    if (dist < bestDist) {
      bestDist = dist;
      bestS = (i + u) * t.step;
      const nx = -sampleAt(t, t.tz, bestS);
      const nz = sampleAt(t, t.tx, bestS);
      bestD = (x - qx) * nx + (z - qz) * nz;
    }
  }
  return { s: wrapS(t, bestS), d: bestD, dist: bestDist };
}

// ---- vehicles & speed profile ------------------------------------------------------------------------

export interface VehicleSpec {
  kind: 'f1' | 'moto';
  /** Top speed (m/s) without boost / tuck bonus. */
  vTop: number;
  /** Extra top speed while boosting (F1) or tucked in (bike). */
  vBonus: number;
  /** Full-throttle acceleration at standstill (m/s²). */
  accel: number;
  brake: number;
  /** Lateral grip a = grip0 + gripAero·v² (m/s²). */
  grip0: number;
  gripAero: number;
  length: number;
  width: number;
  /** Steering: full lock turning radius = steerR0 + steerK·v². */
  steerR0: number;
  steerK: number;
}

export const SPECS: Record<'f1' | 'moto', VehicleSpec> = {
  f1: { kind: 'f1', vTop: 89, vBonus: 7, accel: 12, brake: 30, grip0: 15.5, gripAero: 0.0033, length: 5.4, width: 1.95, steerR0: 7.5, steerK: 0.021 },
  moto: { kind: 'moto', vTop: 80, vBonus: 7, accel: 10.5, brake: 15, grip0: 12.6, gripAero: 0.0006, length: 2.1, width: 0.85, steerR0: 6, steerK: 0.026 },
};

export function gripAt(spec: VehicleSpec, v: number): number {
  return spec.grip0 + spec.gripAero * v * v;
}

/** Highest steady speed on a curve of curvature k. */
export function cornerSpeed(spec: VehicleSpec, k: number, vMax = spec.vTop): number {
  const a = Math.abs(k);
  if (a <= spec.gripAero) return vMax;
  return Math.min(vMax, Math.sqrt(spec.grip0 / (a - spec.gripAero)));
}

export function accelAt(spec: VehicleSpec, v: number, top = spec.vTop): number {
  const r = v / top;
  return spec.accel * Math.max(0, 1 - r * r);
}

/**
 * Target speed along the racing line: corner speed limits, then braking (backward pass) and acceleration
 * (forward pass) so the profile is drivable.
 */
export function speedProfile(t: TrackData, spec: VehicleSpec, gripScale = 1, brakeScale = 0.85, top = spec.vTop): Float32Array {
  const n = t.n;
  const v = new Float32Array(n);
  const sc: VehicleSpec = { ...spec, grip0: spec.grip0 * gripScale, gripAero: spec.gripAero * gripScale };
  for (let i = 0; i < n; i++) v[i] = cornerSpeed(sc, t.lineCurv[i], top);
  const br = spec.brake * brakeScale;
  for (let rep = 0; rep < 2; rep++) {
    for (let k = n - 1; k >= 0; k--) {
      const nx = v[(k + 1) % n];
      v[k] = Math.min(v[k], Math.sqrt(nx * nx + 2 * br * t.step));
    }
  }
  for (let rep = 0; rep < 2; rep++) {
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      v[j] = Math.min(v[j], Math.sqrt(v[k] * v[k] + 2 * accelAt(spec, v[k], top) * t.step));
    }
  }
  return v;
}

// ---- race bookkeeping ------------------------------------------------------------------------------

/** Lap number (1-based) for a continuous progress value; progress < 0 means still behind the line on lap 1. */
export function lapOf(p: number, length: number): number {
  return p < 0 ? 1 : Math.floor(p / length) + 1;
}

export interface RankEntry {
  p: number;
  finished: boolean;
  finishTime: number;
}

/** Indices of racers in race order: finished racers by finish time, then everyone else by progress. */
export function rankOrder(r: RankEntry[]): number[] {
  return r
    .map((_, i) => i)
    .sort((a, b) => {
      const A = r[a];
      const B = r[b];
      if (A.finished && B.finished) return A.finishTime - B.finishTime;
      if (A.finished) return -1;
      if (B.finished) return 1;
      return B.p - A.p;
    });
}

/**
 * Lap timing from continuous progress. The clock starts at lights out (lap 1 includes the run from the grid,
 * as in real racing); every later crossing of the line completes a lap, timed with sub-frame interpolation.
 */
export class LapTimer {
  laps: number[] = [];
  best = Infinity;
  lapStart = 0;
  constructor(readonly length: number) {}

  /** Advance from progress p0 at time t0 to p1 at t1. Returns the lap time if a lap was completed. */
  update(p0: number, t0: number, p1: number, t1: number): number | null {
    const k0 = Math.floor(p0 / this.length);
    const k1 = Math.floor(p1 / this.length);
    if (k1 <= k0 || k1 < 1) return null;
    // Crossed the line at progress k1·L (only count laps not yet recorded).
    if (k1 <= this.laps.length) return null;
    const crossP = k1 * this.length;
    const f = p1 === p0 ? 1 : (crossP - p0) / (p1 - p0);
    const tc = t0 + (t1 - t0) * clamp(f, 0, 1);
    const lap = tc - this.lapStart;
    this.laps.push(lap);
    this.lapStart = tc;
    if (lap < this.best) this.best = lap;
    return lap;
  }

  current(t: number): number {
    return t - this.lapStart;
  }
}
