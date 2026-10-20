/** A tracked landmark in image pixels (already mirrored so the player's right is screen right). */
export interface Pt {
  x: number;
  y: number;
  v: number;
}

/** One processed camera frame. */
export interface PoseFrame {
  /** performance.now() time (ms) when the camera captured the frame (estimated). */
  t: number;
  /** 33 MediaPipe landmarks in pixels, or null when nobody is visible. */
  lm: Pt[] | null;
  /** Source image size in pixels. */
  w: number;
  h: number;
}

/** A 2D point in body space: origin at shoulder centre, 1 unit = shoulder width, +x right, +y up. */
export interface V2 {
  x: number;
  y: number;
}

export const LM = {
  nose: 0,
  lShoulder: 11,
  rShoulder: 12,
  lElbow: 13,
  rElbow: 14,
  lWrist: 15,
  rWrist: 16,
  lIndex: 19,
  rIndex: 20,
  lHip: 23,
  rHip: 24,
  lKnee: 25,
  rKnee: 26,
  lAnkle: 27,
  rAnkle: 28,
} as const;

export interface PoseSource {
  readonly kind: 'camera' | 'sim';
  /** Detection rate (frames per second). */
  fps: number;
  /** Time spent detecting one frame (ms). */
  detectMs: number;
  /** Most recent frame. */
  latest(): PoseFrame;
  /** Frames captured after time t (ms), oldest first. */
  since(t: number): PoseFrame[];
  /** Live camera element, for previews. */
  video: HTMLVideoElement | null;
  stop(): void;
}
