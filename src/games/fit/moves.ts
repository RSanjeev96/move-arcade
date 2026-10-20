/**
 * Move library. Every move is defined once, as keyframed body poses timed in beats; the same definitions drive
 * the 3D coach, the pictogram cards, the scoring targets and the demo bot.
 *
 * Coordinates are in shoulder widths (SW) with x = player's right (= screen right, the coach mirrors the player),
 * y = up, z = toward the camera/viewer.
 */

export type V3 = [number, number, number];

export interface Pose {
  /** Wrist targets in the torso frame, relative to the shoulder centre. */
  lw: V3;
  rw: V3;
  /** Elbow pole hints (torso frame): the side of the shoulder→wrist line the elbow sits on. */
  lp: V3;
  rp: V3;
  /** Pelvis offset from the standing position (world). Squats lower py, jumps raise it. */
  px: number;
  py: number;
  pz: number;
  /** Torso side bend (+ = shoulders toward the right), forward bend and yaw, radians. */
  tilt: number;
  pitch: number;
  twist: number;
  /** Ankle offsets from the standing ankle positions (world). */
  lf: V3;
  rf: V3;
  /** Knee pole hints (world). */
  lkp: V3;
  rkp: V3;
  /** Head nod (rad, + = chin down). */
  head: number;
  /** Hand closure 0 (open) .. 1 (fist). */
  fist: number;
}

export type MoveKind = 'warm' | 'cardio' | 'dance' | 'strength' | 'boxing' | 'stretch' | 'rest';
export type Ease = 'smooth' | 'linear' | 'snap' | 'hold';

/** Features the scorer can weigh. */
export type Feature = 'wrists' | 'elbows' | 'vertical' | 'lean' | 'tilt' | 'knees' | 'feet' | 'jump';

export interface Key {
  /** Beat within the half (alt moves) or cycle. */
  b: number;
  p: Partial<Pose>;
  /** Easing used from this key to the next. */
  e?: Ease;
}

export interface MoveDef {
  id: string;
  name: string;
  /** Short coaching cue. */
  cue: string;
  kind: MoveKind;
  /** Length of the keyed section in move beats. */
  beats: number;
  /** The keyed section is followed by its mirror image (left/right alternation); the cycle is 2 × beats. */
  alt?: boolean;
  keys: Key[];
  base?: Partial<Pose>;
  /** Comfortable tempo for this move, in move beats per minute. Songs are half/double-timed into this range. */
  tempo: [number, number];
  /** Metabolic equivalent at full effort. */
  met: number;
  impact: 'low' | 'high';
  /** Low-impact alternative. */
  low?: string;
  /** Arms go above the head (the hands-up pause needs a longer hold). */
  overhead?: boolean;
  /** Legs carry the move: scored only when the full body is visible. */
  legs?: boolean;
  /** Features that matter most for this move (weighted up, used for rep counting). */
  focus: Feature[];
  /** Rep counting: label and the beats (within the full cycle) where the rep's peak pose is. */
  rep?: { label: string; peaks: number[] };
  /** A held stretch. */
  hold?: boolean;
  /** Beats per rating (default: beats). */
  judge?: number;
  /** View yaw (rad) that shows this move best: pictograms use it, the coach turns part of the way. */
  view?: number;
  /** Beat shown on the move's card (default: the first rep peak or the most distinctive keyframe). */
  card?: number;
}

// ---- pose helpers -------------------------------------------------------------------------

const ARM_DOWN_R: V3 = [0.62, -1.5, 0.15];
const mx = (v: V3): V3 => [-v[0], v[1], v[2]];

export const NEUTRAL: Pose = {
  lw: mx(ARM_DOWN_R),
  rw: ARM_DOWN_R,
  lp: [-0.6, -0.8, -0.5],
  rp: [0.6, -0.8, -0.5],
  px: 0,
  py: 0,
  pz: 0,
  tilt: 0,
  pitch: 0,
  twist: 0,
  lf: [0, 0, 0],
  rf: [0, 0, 0],
  lkp: [-0.25, 0, 1],
  rkp: [0.25, 0, 1],
  head: 0,
  fist: 0,
};

/** Both arms from a right-arm target (the left one mirrored). */
const arms = (r: V3, l: V3 = mx(r)): Partial<Pose> => ({ rw: r, lw: l });
/** Both feet from a right-foot offset (mirrored). */
const feet = (r: V3, l: V3 = mx(r)): Partial<Pose> => ({ rf: r, lf: l });

export function mirrorPose(p: Pose): Pose {
  return {
    lw: mx(p.rw),
    rw: mx(p.lw),
    lp: mx(p.rp),
    rp: mx(p.lp),
    px: -p.px,
    py: p.py,
    pz: p.pz,
    tilt: -p.tilt,
    pitch: p.pitch,
    twist: -p.twist,
    lf: mx(p.rf),
    rf: mx(p.lf),
    lkp: mx(p.rkp),
    rkp: mx(p.lkp),
    head: p.head,
    fist: p.fist,
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return {
    lw: lerp3(a.lw, b.lw, t),
    rw: lerp3(a.rw, b.rw, t),
    lp: lerp3(a.lp, b.lp, t),
    rp: lerp3(a.rp, b.rp, t),
    px: lerp(a.px, b.px, t),
    py: lerp(a.py, b.py, t),
    pz: lerp(a.pz, b.pz, t),
    tilt: lerp(a.tilt, b.tilt, t),
    pitch: lerp(a.pitch, b.pitch, t),
    twist: lerp(a.twist, b.twist, t),
    lf: lerp3(a.lf, b.lf, t),
    rf: lerp3(a.rf, b.rf, t),
    lkp: lerp3(a.lkp, b.lkp, t),
    rkp: lerp3(a.rkp, b.rkp, t),
    head: lerp(a.head, b.head, t),
    fist: lerp(a.fist, b.fist, t),
  };
}

export function ease(e: Ease, t: number): number {
  t = Math.min(1, Math.max(0, t));
  switch (e) {
    case 'linear':
      return t;
    case 'snap':
      // Fast attack, soft landing: punches, kicks.
      return 1 - Math.pow(1 - t, 3);
    case 'hold':
      return t < 0.7 ? 0 : (t - 0.7) / 0.3;
    default:
      return t * t * (3 - 2 * t);
  }
}

// ---- reusable arm/leg targets (right side; mirror for the left) ------------------------------

const OVERHEAD: V3 = [0.42, 1.5, 0.05];
const V_UP: V3 = [1.3, 1.22, 0.05];
const T_OUT: V3 = [2.02, 0.05, 0.05];
const LOW_OUT: V3 = [1.25, -1.15, 0.15];
const HIPS: V3 = [0.48, -1.25, 0.05];
const GUARD: V3 = [0.3, 0.12, 0.72];
const SWING_F: V3 = [0.62, -0.25, 0.75];
const SWING_B: V3 = [0.66, -1.32, -0.4];
const POLE_OUT: V3 = [1, 0.1, -0.35];
const POLE_DOWN: V3 = [0.35, -1, -0.1];
const KNEE_UP: V3 = [0, 0.8, 0.45];
const KNEE_HIGH: V3 = [0, 1.2, 0.65];
const GUARD_BASE: Partial<Pose> = { ...arms(GUARD), rp: POLE_DOWN, lp: mx(POLE_DOWN), fist: 1 };

// ---- the library ----------------------------------------------------------------------------

export const MOVES: MoveDef[] = [
  {
    id: 'march',
    name: 'March',
    cue: 'Lift your knees, swing your arms',
    kind: 'warm',
    beats: 2,
    alt: true,
    tempo: [96, 140],
    met: 3.8,
    impact: 'low',
    legs: true,
    view: 0.25,
    focus: ['knees', 'wrists'],
    keys: [
      { b: 0, p: { rf: [0, 0, 0], lf: [0, 0, 0], py: -0.04 } },
      { b: 1, p: { rf: KNEE_UP, lf: [0, 0, 0], rw: SWING_B, lw: mx(SWING_F), py: 0.02 } },
    ],
  },
  {
    id: 'highknees',
    name: 'High Knees',
    cue: 'Knees up high, pump your arms',
    kind: 'cardio',
    beats: 1,
    alt: true,
    tempo: [110, 170],
    met: 8,
    impact: 'high',
    low: 'march',
    legs: true,
    judge: 2,
    view: 0.35,
    focus: ['knees', 'wrists'],
    rep: { label: 'knee lifts', peaks: [0.5, 1.5] },
    base: { rp: POLE_DOWN, lp: mx(POLE_DOWN), fist: 1 },
    keys: [
      { b: 0, p: { rf: [0, 0, 0], py: 0.05, rw: [0.55, -0.9, 0.7], lw: [-0.55, -0.2, 0.75] } },
      { b: 0.5, p: { rf: KNEE_HIGH, py: 0.12, rw: [0.6, -1.05, -0.2], lw: [-0.5, 0.15, 0.8] }, e: 'snap' },
    ],
  },
  {
    id: 'steptouch',
    name: 'Step Touch',
    cue: 'Step and tap side to side, clap',
    kind: 'dance',
    beats: 2,
    alt: true,
    tempo: [96, 140],
    met: 4,
    impact: 'low',
    card: 1,
    focus: ['lean', 'wrists'],
    keys: [
      { b: 0, p: { px: -0.35, lf: [-0.35, 0, 0], rf: [-0.58, 0.06, 0], ...arms([-0.25, -0.3, 0.8], [-0.4, -0.25, 0.8]), py: -0.02, tilt: -0.05 } },
      { b: 1, p: { px: 0.05, lf: [-0.35, 0, 0], rf: [0.35, 0, 0], ...arms(LOW_OUT), py: -0.12 } },
    ],
  },
  {
    id: 'grapevine',
    name: 'Grapevine',
    cue: 'Step, cross behind, step, tap',
    kind: 'dance',
    beats: 4,
    alt: true,
    tempo: [100, 140],
    met: 4.8,
    impact: 'low',
    legs: true,
    focus: ['lean', 'wrists'],
    keys: [
      { b: 0, p: { px: -0.7, lf: [-0.7, 0, 0], rf: [-0.95, 0.05, 0], ...arms([-0.2, -0.35, 0.8], [-0.35, -0.3, 0.8]) } },
      { b: 1, p: { px: -0.15, lf: [-0.7, 0, 0], rf: [0.0, 0, 0], ...arms(T_OUT), py: -0.08 } },
      { b: 2, p: { px: 0.2, lf: [0.75, 0.03, -0.35], rf: [0.0, 0, 0], ...arms([1.3, -0.6, 0.3]), twist: 0.15 } },
      { b: 3, p: { px: 0.6, lf: [0.75, 0, -0.1], rf: [0.7, 0, 0], ...arms(V_UP), py: -0.08 } },
    ],
    overhead: true,
  },
  {
    id: 'jacks',
    name: 'Jumping Jacks',
    cue: 'Arms up, feet out — and in',
    kind: 'cardio',
    beats: 2,
    tempo: [96, 150],
    met: 8,
    impact: 'high',
    low: 'stepjacks',
    overhead: true,
    focus: ['wrists', 'feet', 'jump'],
    rep: { label: 'jacks', peaks: [1] },
    keys: [
      { b: 0, p: { ...feet([0, 0, 0]), py: -0.04 } },
      { b: 0.5, p: { ...feet([0.25, 0.25, 0]), ...arms(T_OUT), py: 0.22 } },
      { b: 1, p: { ...feet([0.5, 0, 0]), ...arms(OVERHEAD), py: -0.06, rp: POLE_OUT, lp: mx(POLE_OUT) } },
      { b: 1.5, p: { ...feet([0.25, 0.25, 0]), ...arms(T_OUT), py: 0.22 } },
    ],
  },
  {
    id: 'stepjacks',
    name: 'Step Jacks',
    cue: 'Step out, arms up — low impact',
    kind: 'cardio',
    beats: 2,
    alt: true,
    tempo: [96, 140],
    met: 4.5,
    impact: 'low',
    overhead: true,
    focus: ['wrists', 'feet'],
    rep: { label: 'jacks', peaks: [1, 3] },
    keys: [
      { b: 0, p: { ...feet([0, 0, 0]), py: -0.04 } },
      { b: 1, p: { rf: [0.6, 0, 0], lf: [0, 0, 0], px: 0.25, ...arms(OVERHEAD), py: -0.08, rp: POLE_OUT, lp: mx(POLE_OUT) } },
    ],
  },
  {
    id: 'squat',
    name: 'Squats',
    cue: 'Sit back, chest up — and stand',
    kind: 'strength',
    beats: 4,
    tempo: [60, 125],
    met: 5,
    impact: 'low',
    view: 0.75,
    focus: ['vertical', 'knees'],
    rep: { label: 'squats', peaks: [2] },
    base: { ...feet([0.22, 0, 0]) },
    keys: [
      { b: 0, p: { ...arms([0.62, -1.45, 0.2]) } },
      { b: 2, p: { py: -0.72, pz: -0.38, pitch: 0.42, ...arms([0.42, -0.05, 1.45]), head: -0.25 }, e: 'smooth' },
    ],
  },
  {
    id: 'sidelunge',
    name: 'Side Lunges',
    cue: 'Step wide, bend one knee, push back',
    kind: 'strength',
    beats: 4,
    alt: true,
    tempo: [60, 125],
    met: 4.5,
    impact: 'low',
    legs: true,
    focus: ['lean', 'vertical', 'knees'],
    rep: { label: 'lunges', peaks: [2, 6] },
    keys: [
      { b: 0, p: { ...feet([0.15, 0, 0]), ...arms([0.3, -0.5, 0.9], [-0.3, -0.5, 0.9]) } },
      { b: 2, p: { px: 0.62, py: -0.45, pz: -0.15, pitch: 0.3, rf: [0.95, 0, 0.1], lf: [-0.45, 0, 0], ...arms([0.35, -0.55, 1.2], [0.1, -0.55, 1.2]) } },
    ],
  },
  {
    id: 'pumps',
    name: 'Arm Pumps Up',
    cue: 'Push the roof, bounce your knees',
    kind: 'dance',
    beats: 1,
    tempo: [56, 110],
    met: 4.5,
    impact: 'low',
    overhead: true,
    judge: 2,
    focus: ['wrists', 'elbows'],
    rep: { label: 'pumps', peaks: [0.5] },
    base: { ...feet([0.18, 0, 0]), rp: [0.8, -0.8, -0.2], lp: [-0.8, -0.8, -0.2] },
    keys: [
      { b: 0, p: { ...arms([0.85, 0.32, 0.15]), py: -0.12 } },
      { b: 0.5, p: { ...arms([0.62, 1.48, 0.1]), py: 0.02 }, e: 'snap' },
    ],
  },
  {
    id: 'jabcross',
    name: 'Jab + Cross',
    cue: 'Left jab, right cross — guard up',
    kind: 'boxing',
    beats: 2,
    tempo: [96, 140],
    met: 7,
    impact: 'low',
    view: 0.55,
    focus: ['wrists', 'elbows'],
    rep: { label: 'punches', peaks: [0.5, 1.5] },
    base: { ...GUARD_BASE, ...feet([0.18, 0, 0]), py: -0.08 },
    keys: [
      { b: 0, p: { twist: 0 } },
      { b: 0.5, p: { lw: [-0.3, 0.3, 1.42], lp: [-1, -0.25, 0], twist: 0.2 }, e: 'snap' },
      { b: 1, p: { twist: 0 } },
      { b: 1.5, p: { rw: [0.3, 0.3, 1.42], rp: [1, -0.25, 0], twist: -0.22, px: -0.05 }, e: 'snap' },
    ],
  },
  {
    id: 'hooks',
    name: 'Hooks',
    cue: 'Elbow up, swing across',
    kind: 'boxing',
    beats: 2,
    alt: true,
    tempo: [96, 140],
    met: 7,
    impact: 'low',
    view: 0.4,
    focus: ['wrists', 'elbows'],
    rep: { label: 'punches', peaks: [1, 3] },
    base: { ...GUARD_BASE, ...feet([0.18, 0, 0]), py: -0.08 },
    keys: [
      { b: 0, p: {} },
      { b: 1, p: { rw: [0.1, 0.28, 0.85], rp: [1, 0.35, 0], twist: -0.35 }, e: 'snap' },
    ],
  },
  {
    id: 'uppercut',
    name: 'Uppercuts',
    cue: 'Dip, then drive up from the hips',
    kind: 'boxing',
    beats: 2,
    alt: true,
    tempo: [96, 140],
    met: 7,
    impact: 'low',
    view: 0.5,
    focus: ['wrists', 'elbows', 'vertical'],
    rep: { label: 'punches', peaks: [1, 3] },
    base: { ...GUARD_BASE, ...feet([0.2, 0, 0]) },
    keys: [
      { b: 0, p: { rw: [0.35, -0.45, 0.55], py: -0.22, twist: 0.15 } },
      { b: 1, p: { rw: [0.22, 0.6, 0.72], rp: [0.3, -1, -0.4], py: 0.0, twist: -0.3 }, e: 'snap' },
    ],
  },
  {
    id: 'bobweave',
    name: 'Bob & Weave',
    cue: 'Duck under, side to side',
    kind: 'boxing',
    beats: 2,
    alt: true,
    tempo: [90, 140],
    met: 5.5,
    impact: 'low',
    view: 0.45,
    focus: ['vertical', 'lean'],
    base: { ...GUARD_BASE, ...feet([0.3, 0, 0]) },
    keys: [
      { b: 0, p: { px: -0.35, py: -0.08, tilt: -0.1 } },
      { b: 1, p: { px: 0.0, py: -0.6, pz: -0.15, pitch: 0.35 } },
    ],
  },
  {
    id: 'shuffle',
    name: 'Boxer Bounce',
    cue: 'Light on your feet, guard up',
    kind: 'boxing',
    beats: 1,
    alt: true,
    tempo: [96, 150],
    met: 6,
    impact: 'low',
    judge: 2,
    view: 0.4,
    focus: ['wrists', 'vertical'],
    base: { ...GUARD_BASE },
    keys: [
      { b: 0, p: { rf: [0.15, 0, 0.2], lf: [-0.15, 0, -0.2], py: -0.1, px: 0.05 } },
      { b: 0.5, p: { rf: [0.15, 0.06, 0.2], lf: [-0.15, 0.03, -0.2], py: 0.02 } },
    ],
  },
  {
    id: 'armcircles',
    name: 'Arm Circles',
    cue: 'Big circles, nice and smooth',
    kind: 'warm',
    beats: 4,
    tempo: [90, 140],
    met: 3,
    impact: 'low',
    overhead: true,
    focus: ['wrists', 'elbows'],
    base: { ...feet([0.15, 0, 0]) },
    keys: [
      { b: 0, p: { ...arms([0.65, -1.5, 0.3]) } },
      { b: 1, p: { ...arms([2.0, -0.2, 0.15]) } },
      { b: 2, p: { ...arms([0.55, 1.52, 0.1]), rp: POLE_OUT, lp: mx(POLE_OUT) } },
      { b: 3, p: { ...arms([-0.35, 0.2, 1.0], [0.35, 0.2, 1.05]) } },
    ],
  },
  {
    id: 'hipsway',
    name: 'Hip Sway',
    cue: 'Hands on hips, sway with the beat',
    kind: 'dance',
    beats: 1,
    alt: true,
    tempo: [60, 120],
    met: 3.5,
    impact: 'low',
    judge: 2,
    focus: ['tilt', 'wrists'],
    base: { ...arms(HIPS), rp: POLE_OUT, lp: mx(POLE_OUT), ...feet([0.2, 0, 0]) },
    keys: [{ b: 0, p: { px: 0.32, tilt: -0.2, py: -0.06, head: 0.05 } }],
  },
  {
    id: 'kneetwist',
    name: 'Knee Lift Twist',
    cue: 'Knee up, opposite elbow down',
    kind: 'cardio',
    beats: 2,
    alt: true,
    tempo: [96, 140],
    met: 4.5,
    impact: 'low',
    legs: true,
    view: 0.3,
    focus: ['wrists', 'knees', 'elbows'],
    rep: { label: 'knee lifts', peaks: [1, 3] },
    keys: [
      { b: 0, p: { ...arms([0.42, 0.92, -0.15]), rp: POLE_OUT, lp: mx(POLE_OUT) } },
      {
        b: 1,
        p: { rf: [0.05, 1.05, 0.55], lw: [0.3, -0.75, 0.85], rw: [0.45, 0.9, -0.12], rp: POLE_OUT, lp: [-1, -0.2, 0.2], twist: 0.45, pitch: 0.18 },
      },
    ],
  },
  {
    id: 'kick',
    name: 'Front Kicks',
    cue: 'Knee up, snap the kick, guard up',
    kind: 'cardio',
    beats: 2,
    alt: true,
    tempo: [96, 140],
    met: 7,
    impact: 'low',
    legs: true,
    view: 0.8,
    focus: ['knees', 'feet', 'wrists'],
    rep: { label: 'kicks', peaks: [1, 3] },
    base: { ...GUARD_BASE },
    keys: [
      { b: 0, p: { rf: [0, 0, 0] } },
      { b: 0.6, p: { rf: [0, 1.2, 0.5], py: 0.02 } },
      { b: 1, p: { rf: [0.02, 1.1, 1.75], pitch: -0.12, pz: -0.1 }, e: 'smooth' },
      { b: 1.4, p: { rf: [0, 0.9, 0.5] } },
    ],
  },
  {
    id: 'starjump',
    name: 'Star Jumps',
    cue: 'Crouch, then explode into a star',
    kind: 'cardio',
    beats: 4,
    tempo: [90, 140],
    met: 8.5,
    impact: 'high',
    low: 'starreach',
    overhead: true,
    view: 0.25,
    focus: ['wrists', 'jump', 'feet', 'vertical'],
    rep: { label: 'star jumps', peaks: [2] },
    keys: [
      { b: 0, p: { ...feet([0.15, 0, 0]), py: -0.5, pz: -0.25, pitch: 0.38, ...arms([0.35, -1.25, 0.6]) } },
      { b: 1.5, p: { ...feet([0.2, 0.3, 0]), py: 0.1, ...arms([1.2, 0.3, 0.2]) }, e: 'snap' },
      { b: 2, p: { ...feet([0.62, 0.35, 0]), py: 0.55, ...arms([1.45, 1.05, 0.05]), rp: POLE_OUT, lp: mx(POLE_OUT) } },
      { b: 3, p: { ...feet([0.2, 0, 0]), py: -0.15, ...arms(LOW_OUT) } },
    ],
  },
  {
    id: 'starreach',
    name: 'Star Reach',
    cue: 'Step out wide and reach high',
    kind: 'cardio',
    beats: 2,
    alt: true,
    tempo: [90, 140],
    met: 4.5,
    impact: 'low',
    overhead: true,
    focus: ['wrists', 'feet'],
    rep: { label: 'reaches', peaks: [1, 3] },
    keys: [
      { b: 0, p: { ...feet([0.12, 0, 0]), py: -0.3, pitch: 0.25, pz: -0.15, ...arms([0.3, -1.2, 0.6]) } },
      { b: 1, p: { rf: [0.7, 0, 0], lf: [0, 0, 0], px: 0.3, ...arms(V_UP), rp: POLE_OUT, lp: mx(POLE_OUT) } },
    ],
  },
  {
    id: 'sidereach',
    name: 'Side Reach',
    cue: 'Reach up and over, long side',
    kind: 'warm',
    beats: 2,
    alt: true,
    tempo: [90, 136],
    met: 3,
    impact: 'low',
    overhead: true,
    focus: ['wrists', 'tilt'],
    base: { ...feet([0.3, 0, 0]) },
    keys: [
      { b: 0, p: { ...arms([0.6, -1.4, 0.2]), py: -0.08 } },
      { b: 1, p: { lw: [0.55, 1.4, 0.1], lp: [-1, 0, -0.3], rw: [0.6, -1.45, 0.15], tilt: 0.28, px: -0.15 } },
    ],
  },
  {
    id: 'overhead',
    name: 'Overhead Reach',
    cue: 'Reach tall, breathe in… and out',
    kind: 'stretch',
    beats: 8,
    tempo: [50, 70],
    met: 2.3,
    impact: 'low',
    overhead: true,
    hold: true,
    judge: 4,
    focus: ['wrists'],
    keys: [
      { b: 0, p: { ...arms([0.6, -1.4, 0.4]) } },
      { b: 2, p: { ...arms([0.12, 1.55, 0.1]), rp: POLE_OUT, lp: mx(POLE_OUT), py: 0.04 }, e: 'hold' },
      { b: 6, p: { ...arms([0.12, 1.55, 0.1]), rp: POLE_OUT, lp: mx(POLE_OUT), py: 0.04, head: -0.1 } },
    ],
  },
  {
    id: 'sidebend',
    name: 'Side Bend',
    cue: 'Arm over, lean and hold',
    kind: 'stretch',
    beats: 8,
    alt: true,
    tempo: [50, 70],
    met: 2.3,
    impact: 'low',
    overhead: true,
    hold: true,
    judge: 4,
    focus: ['wrists', 'tilt'],
    base: { ...feet([0.25, 0, 0]) },
    keys: [
      { b: 0, p: { ...arms(HIPS), rp: POLE_OUT, lp: mx(POLE_OUT) } },
      { b: 2, p: { lw: [0.45, 1.4, 0.05], lp: [-1, 0.2, -0.3], rw: HIPS, rp: POLE_OUT, tilt: 0.38, px: -0.12 } },
      { b: 7, p: { lw: [0.45, 1.4, 0.05], lp: [-1, 0.2, -0.3], rw: HIPS, rp: POLE_OUT, tilt: 0.4, px: -0.12 } },
    ],
  },
  {
    id: 'shoulder',
    name: 'Shoulder Stretch',
    cue: 'Arm across, gently pull',
    kind: 'stretch',
    beats: 8,
    alt: true,
    tempo: [50, 70],
    met: 2.3,
    impact: 'low',
    hold: true,
    judge: 4,
    focus: ['wrists', 'elbows'],
    base: { ...feet([0.18, 0, 0]) },
    keys: [
      { b: 0, p: {} },
      { b: 2, p: { rw: [-1.1, 0.05, 0.45], rp: [0, -1, 0.3], lw: [-0.2, -0.3, 0.75], lp: [-1, -0.6, 0] } },
      { b: 7, p: { rw: [-1.15, 0.05, 0.45], rp: [0, -1, 0.3], lw: [-0.2, -0.3, 0.75], lp: [-1, -0.6, 0] } },
    ],
  },
  {
    id: 'quad',
    name: 'Quad Stretch',
    cue: 'Heel to glute, stand tall',
    kind: 'stretch',
    beats: 8,
    alt: true,
    tempo: [50, 70],
    met: 2.5,
    impact: 'low',
    legs: true,
    hold: true,
    judge: 4,
    view: 0.65,
    focus: ['wrists', 'knees'],
    keys: [
      { b: 0, p: {} },
      {
        b: 2,
        p: { rf: [0.04, 2.35, -0.62], rkp: [0.05, -1, 0.3], rw: [0.45, -1.42, -0.58], rp: [0.6, 0.2, -1], lw: [-1.85, 0.45, 0.3], tilt: 0.05 },
      },
      {
        b: 7,
        p: { rf: [0.04, 2.35, -0.62], rkp: [0.05, -1, 0.3], rw: [0.45, -1.42, -0.58], rp: [0.6, 0.2, -1], lw: [-1.85, 0.45, 0.3], tilt: 0.05 },
      },
    ],
  },
  {
    id: 'breathe',
    name: 'Breathe',
    cue: 'Breathe in… and out',
    kind: 'rest',
    beats: 8,
    tempo: [40, 70],
    met: 1.6,
    impact: 'low',
    focus: [],
    base: { ...feet([0.12, 0, 0]) },
    keys: [
      { b: 0, p: { ...arms([0.68, -1.45, 0.25]), head: 0.05 } },
      { b: 4, p: { ...arms([1.3, -0.5, 0.45]), py: 0.03, head: -0.1, pitch: -0.04 } },
    ],
  },
];

export const MOVE: Record<string, MoveDef> = Object.fromEntries(MOVES.map((m) => [m.id, m]));

// ---- sampling -------------------------------------------------------------------------------

const resolved = new Map<MoveDef, Pose[]>();

function keyPoses(m: MoveDef): Pose[] {
  let r = resolved.get(m);
  if (!r) {
    const base = { ...NEUTRAL, ...m.base };
    r = m.keys.map((k) => ({ ...base, ...k.p }));
    resolved.set(m, r);
  }
  return r;
}

/** Full cycle length in move beats. */
export function cycleBeats(m: MoveDef): number {
  return m.alt ? m.beats * 2 : m.beats;
}

/** The coach's target pose `beat` move-beats into the move (cyclic). */
export function sampleMove(m: MoveDef, beat: number): Pose {
  const cyc = cycleBeats(m);
  let c = ((beat % cyc) + cyc) % cyc;
  let mirrored = false;
  if (m.alt && c >= m.beats) {
    c -= m.beats;
    mirrored = true;
  }
  const poses = keyPoses(m);
  const keys = m.keys;
  let i = keys.length - 1;
  for (let k = 0; k < keys.length; k++) {
    if (keys[k].b <= c) i = k;
    else break;
  }
  if (c < keys[0].b) i = keys.length - 1;
  const a = poses[i];
  const last = i === keys.length - 1;
  const b = last ? (m.alt ? mirrorPose(poses[0]) : poses[0]) : poses[i + 1];
  const b0 = keys[i].b <= c ? keys[i].b : keys[i].b - m.beats;
  const b1 = last ? keys[0].b + m.beats : keys[i + 1].b;
  const t = ease(keys[i].e ?? 'smooth', (c - b0) / Math.max(1e-6, b1 - b0));
  const p = lerpPose(a, b, t);
  return mirrored ? mirrorPose(p) : p;
}

/** A clean blend from one move into the next over the first beat of a block. */
export function blendPose(a: Pose, b: Pose, t: number): Pose {
  return lerpPose(a, b, ease('smooth', t));
}

/** Pick the multiplier (0.5, 1 or 2 move beats per song beat) that best fits the move's tempo range. */
export function tempoMult(m: MoveDef, songBpm: number): number {
  let best = 1;
  let bestD = Infinity;
  for (const k of [1, 0.5, 2, 0.25]) {
    const bpm = songBpm * k;
    const d = bpm < m.tempo[0] ? m.tempo[0] - bpm : bpm > m.tempo[1] ? bpm - m.tempo[1] : 0;
    if (d < bestD - 1e-9) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

/** The beat (within the cycle) whose pose best represents the move on a card. */
export function cardBeat(m: MoveDef): number {
  if (m.card !== undefined) return m.card;
  if (m.rep) return m.rep.peaks[0];
  if (m.hold) return m.beats / 2;
  // The keyframe furthest from neutral.
  let best = 0;
  let bestD = -1;
  const poses = keyPoses(m);
  poses.forEach((p, i) => {
    const d = Math.hypot(...p.rw.map((v, k) => v - NEUTRAL.rw[k])) + Math.hypot(...p.lw.map((v, k) => v - NEUTRAL.lw[k])) + Math.abs(p.px) + Math.abs(p.py);
    if (d > bestD) {
      bestD = d;
      best = m.keys[i].b;
    }
  });
  return best;
}

/** Number of rep peaks of a move in the move-beat range [a, b) measured from the start of a block. */
export function repsBetween(m: MoveDef, a: number, b: number): number {
  if (!m.rep) return 0;
  const cyc = cycleBeats(m);
  let n = 0;
  for (const p of m.rep.peaks) {
    for (let k = Math.floor((a - p) / cyc) - 1; p + k * cyc < b; k++) {
      const x = p + k * cyc;
      if (x >= a - 1e-9 && x < b - 1e-9) n++;
    }
  }
  return n;
}

/** Swap high-impact moves for their low-impact alternatives. */
export function lowImpact(id: string, on: boolean): string {
  if (!on) return id;
  return MOVE[id]?.low ?? id;
}
