/**
 * Movement assist (shared by the human's auto-moving character and the AI) and the AI's shot choice.
 * Pure logic: no three.js, deterministic given the random generator.
 */
import { COURT, Flight, type V3 } from './physics';
import { gauss, type Difficulty, type Handed, type ShotKind, type Stroke } from './shots';

export interface Intercept {
  /** Flight time of contact. */
  t: number;
  ball: V3;
  /** Where the hitter should stand at contact. */
  stand: { x: number; z: number };
  stroke: Stroke;
  /** +1 when the ball is on the world +x side of the hitter. */
  sideSign: number;
  height: number;
  reachable: boolean;
  /** Metres still missing when not reachable. */
  shortfall: number;
}

/** Lateral distance from the body to the contact point, and how far in front of the body. */
export const REACH_SIDE = 0.74;
export const REACH_FRONT = 0.4;

/**
 * Pick the contact point after the first bounce. `near` = the hitter plays on the near half (faces -z).
 * The right-hander's forehand side is world +x on the near court and world -x on the far court.
 */
export function chooseIntercept(
  f: Flight,
  tNow: number,
  pos: { x: number; z: number },
  near: boolean,
  handed: Handed,
  speed: number,
  reaction: number,
): Intercept | null {
  const b0 = f.bounce(0);
  if (!b0) return null;
  // The ball has to come to this hitter's half.
  if (near ? b0.p.z < 0 : b0.p.z > 0) return null;
  const b1 = f.bounce(1);
  const tEnd = Math.min(b1 ? b1.t - 0.02 : f.duration, f.duration);
  const fwd = near ? -1 : 1;
  // Forehand side in world x.
  const fhSign = (near ? 1 : -1) * (handed === 'right' ? 1 : -1);
  let best: Intercept | null = null;
  let bestCost = Infinity;
  let fallback: Intercept | null = null;
  let fallbackShort = Infinity;
  const p: V3 = { x: 0, y: 0, z: 0 };
  for (let t = b0.t + 0.06; t <= tEnd; t += 1 / 60) {
    f.at(t, p);
    if (p.y < 0.38 || p.y > 1.85) continue;
    const depth = p.z * -fwd; // distance behind the net on the hitter's side
    if (depth < 2.5 || depth > 17.6) continue;
    if (Math.abs(p.x) > COURT.wallX - 0.6) continue;
    for (const stroke of ['forehand', 'backhand'] as const) {
      const sideSign = stroke === 'forehand' ? fhSign : -fhSign;
      const stand = { x: p.x - sideSign * REACH_SIDE, z: p.z - fwd * REACH_FRONT };
      const d = Math.hypot(stand.x - pos.x, stand.z - pos.z);
      const avail = Math.max(0, t - tNow - reaction);
      // Simple acceleration ramp: the first 0.25 s count for half.
      const reach = speed * Math.max(0, avail - 0.12);
      const shortfall = d - reach;
      const baseline = Math.abs(depth - (COURT.halfLength + 0.4));
      const cost =
        Math.abs(p.y - 1.0) * 2.2 +
        d * 0.12 +
        (stroke === 'backhand' ? 0.06 : 0) +
        baseline * 0.16 +
        Math.max(0, p.y - 1.35) * 2 +
        (t - b0.t) * 0.15;
      const ic: Intercept = { t, ball: { ...p }, stand, stroke, sideSign, height: p.y, reachable: shortfall <= 0, shortfall: Math.max(0, shortfall) };
      if (shortfall <= 0 && cost < bestCost) {
        bestCost = cost;
        best = ic;
      }
      if (shortfall < fallbackShort) {
        fallbackShort = shortfall;
        fallback = ic;
      }
    }
  }
  return best ?? fallback;
}

// ---- AI shot choice ---------------------------------------------------------------------------------

export interface AiProfile {
  speed: number;
  reaction: number;
  /** Base launch speed for rally balls (m/s). */
  pace: number;
  /** Aim scatter (m). */
  scatter: number;
  /** Chance of an outright unforced error per shot. */
  errorRate: number;
  /** How often it goes for an angle or the line. */
  aggression: number;
  /** How often it tries a drop shot when the opponent is deep. */
  dropRate: number;
  serveSpeed: [number, number];
  firstServeIn: number;
  secondServeIn: number;
}

export const AI: Record<Difficulty, AiProfile> = {
  easy: { speed: 4.4, reaction: 0.34, pace: 20, scatter: 1.0, errorRate: 0.13, aggression: 0.12, dropRate: 0.02, serveSpeed: [30, 36], firstServeIn: 0.7, secondServeIn: 0.88 },
  normal: { speed: 5.3, reaction: 0.26, pace: 25, scatter: 0.75, errorRate: 0.075, aggression: 0.3, dropRate: 0.05, serveSpeed: [38, 46], firstServeIn: 0.66, secondServeIn: 0.93 },
  hard: { speed: 6.2, reaction: 0.17, pace: 29, scatter: 0.55, errorRate: 0.05, aggression: 0.5, dropRate: 0.08, serveSpeed: [44, 53], firstServeIn: 0.64, secondServeIn: 0.95 },
};

export interface AiShotInput {
  /** Hitter is on the far half (normal AI) — shots go to the near half. */
  hitter: { x: number; z: number };
  opponent: { x: number; z: number };
  incomingSpeed: number;
  contactHeight: number;
  /** How stretched the hitter was (0 = waiting, 1 = full sprint at the limit). */
  stretch: number;
  rally: number;
  /** Cooperative feeding (rally challenge). */
  feeder: boolean;
}

export interface AiShot {
  kind: ShotKind;
  target: { x: number; z: number };
  speed: number;
  spin: number;
  high: boolean;
  clearance: number;
  /** The AI decided to miss this one (net or long/wide). */
  error: 'net' | 'long' | 'wide' | null;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Decide the AI's reply. Targets are on the near half (z > 0). */
export function decideAiShot(r: () => number, d: Difficulty, inp: AiShotInput): AiShot {
  const P = AI[d];
  const opp = inp.opponent;
  const sign = (v: number) => (v < 0 ? -1 : 1);
  let kind: ShotKind = r() < 0.75 ? 'topspin' : 'flat';
  let depth = 9.4 + r() * 1.6; // metres beyond the net
  // Default: deep cross-court-ish, away from the opponent.
  let x = -sign(opp.x || (r() - 0.5)) * (1.2 + r() * 1.6);
  let speed = P.pace * (0.92 + r() * 0.16);
  let spin = kind === 'topspin' ? 220 + r() * 120 : 70;
  let high = false;
  let clearance = kind === 'topspin' ? 0.6 : 0.35;
  // Incoming speed is measured at contact (after the bounce): ~11 m/s is a gentle ball, 20+ is heavy.
  const pressure = clamp(inp.stretch * 0.9 + (inp.incomingSpeed - 12) / 12 + (inp.contactHeight < 0.55 ? 0.25 : 0), 0, 1.3);

  if (inp.feeder) {
    // Rally challenge: keep it in play, gradually faster and wider.
    x = (r() - 0.5) * 2 * clamp(1.2 + inp.rally * 0.12, 1.2, 3.0);
    depth = 8.5 + r() * 2.2;
    speed = clamp(P.pace * 0.8 + inp.rally * 0.45, 16, P.pace * 1.15);
    kind = 'topspin';
    spin = 220;
    clearance = 0.7;
    return { kind, target: { x, z: depth }, speed, spin, high, clearance, error: null };
  }

  const oppDeep = opp.z > COURT.halfLength + 0.8;
  const oppNet = opp.z < COURT.service + 1;
  const attack = r() < P.aggression * (1 - pressure * 0.7);
  if (pressure > 0.75 && r() < 0.45) {
    // Defensive: high and deep, or a slice to buy time.
    if (r() < 0.5) {
      kind = 'lob';
      high = true;
      speed = 17 + r() * 3;
      depth = 9.5 + r();
      x *= 0.5;
      spin = 140;
      clearance = 2;
    } else {
      kind = 'slice';
      speed *= 0.78;
      spin = -150;
      depth = 8.5 + r() * 1.5;
      clearance = 0.35;
    }
  } else if (oppNet && r() < 0.6) {
    kind = 'lob';
    high = true;
    speed = 18 + r() * 2;
    depth = 10;
    spin = 160;
    clearance = 2.2;
  } else if (oppDeep && inp.hitter.z > -COURT.halfLength + 2 && r() < P.dropRate * 3) {
    kind = 'drop';
    speed = 9.5 + r() * 2;
    spin = -190;
    depth = 2.3 + r() * 1.2;
    x = (r() - 0.5) * 4;
    clearance = 0.25;
  } else if (attack) {
    // Go for the open court: a sharp angle or the line.
    x = -sign(opp.x || (r() - 0.5)) * (2.6 + r() * 1.1);
    speed *= 1.1 + r() * 0.08;
    depth = r() < 0.4 ? 6.5 + r() * 1.5 : 9.6 + r() * 1.4;
    clearance = 0.35;
  }

  // Aim scatter: worse under pressure.
  const sc = P.scatter * (0.6 + pressure * 0.8);
  x += gauss(r) * sc * 0.7;
  depth += gauss(r) * sc * 0.6;

  let error: AiShot['error'] = null;
  const errChance = P.errorRate * (0.6 + pressure * 1.4) * (attack ? 1.5 : 1) * (kind === 'drop' ? 1.6 : 1);
  if (r() < errChance) {
    const k = r();
    error = k < 0.4 ? 'net' : k < 0.75 ? 'long' : 'wide';
  }
  if (error === 'long') depth = COURT.halfLength + 0.25 + r() * 1.4;
  else if (error === 'wide') x = sign(x || 1) * (COURT.halfSingles + 0.2 + r() * 0.9);
  else if (error === 'net') clearance = -0.25;
  else {
    // Keep honest shots inside the lines.
    x = clamp(x, -COURT.halfSingles + 0.25, COURT.halfSingles - 0.25);
    depth = clamp(depth, kind === 'drop' ? 1.6 : 4.5, COURT.halfLength - 0.35);
  }
  return { kind, target: { x, z: depth }, speed, spin, high, clearance, error };
}

/** AI serve target and pace. `box` is the target service box on the near half. */
export function decideAiServe(
  r: () => number,
  d: Difficulty,
  first: boolean,
  box: { x0: number; x1: number; z0: number; z1: number },
): { target: { x: number; z: number }; speed: number; spin: number; fault: 'net' | 'long' | 'wide' | null } {
  const P = AI[d];
  const inChance = first ? P.firstServeIn : P.secondServeIn;
  const [s0, s1] = P.serveSpeed;
  const speed = first ? s0 + r() * (s1 - s0) : s0 * 0.78 + r() * 4;
  const spin = first ? 50 : 230;
  const cx = (box.x0 + box.x1) / 2;
  const half = (box.x1 - box.x0) / 2;
  // T, body or wide.
  const pick = r();
  const off = pick < 0.4 ? -0.75 : pick < 0.65 ? 0 : 0.75;
  const wideDir = Math.sign(cx) || 1;
  let x = cx + wideDir * off * half;
  let z = box.z1 - 0.6 - r() * 1.2;
  let fault: 'net' | 'long' | 'wide' | null = null;
  if (r() > inChance) {
    const k = r();
    fault = k < 0.45 ? 'net' : k < 0.8 ? 'long' : 'wide';
    if (fault === 'long') z = box.z1 + 0.15 + r() * 0.8;
    if (fault === 'wide') x = cx + wideDir * (half + 0.15 + r() * 0.6);
  }
  return { target: { x, z }, speed, spin, fault };
}
