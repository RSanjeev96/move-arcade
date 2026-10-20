import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { OneEuro } from './oneEuro';
import { LM, type PoseFrame, type PoseSource, type Pt, type V2 } from './types';

const BASE = import.meta.env.BASE_URL;
const KEEP_MS = 2500;

function pushFrame(buf: PoseFrame[], f: PoseFrame): void {
  buf.push(f);
  const cutoff = f.t - KEEP_MS;
  while (buf.length > 2 && buf[0].t < cutoff) buf.shift();
}

function framesSince(buf: PoseFrame[], t: number): PoseFrame[] {
  let i = buf.length;
  while (i > 0 && buf[i - 1].t > t) i--;
  return buf.slice(i);
}

export interface CameraOptions {
  model: 'lite' | 'full';
  /** Extra camera pipeline delay to assume when the browser gives no capture time (ms). */
  delayMs: number;
  onStatus?: (msg: string) => void;
}

/** Live camera + MediaPipe pose tracking. */
export class CameraPose implements PoseSource {
  readonly kind = 'camera' as const;
  fps = 0;
  detectMs = 0;
  video: HTMLVideoElement;
  private frames: PoseFrame[] = [];
  private fx: OneEuro[] = [];
  private fy: OneEuro[] = [];
  private fz: OneEuro[] = [];
  private running = true;
  private lastSeen = 0;
  private lastTs = 0;
  private stream: MediaStream;

  private constructor(
    video: HTMLVideoElement,
    stream: MediaStream,
    private landmarker: PoseLandmarker,
    private opts: CameraOptions,
  ) {
    this.video = video;
    this.stream = stream;
    for (let i = 0; i < 33; i++) {
      this.fx.push(new OneEuro(1.5, 0.008, 1.0));
      this.fy.push(new OneEuro(1.5, 0.008, 1.0));
      this.fz.push(new OneEuro(1.0, 0.004, 1.0));
    }
    this.frames.push({ t: performance.now(), lm: null, w: video.videoWidth || 1280, h: video.videoHeight || 720 });
    this.loop();
  }

  static async create(opts: CameraOptions): Promise<CameraPose> {
    const status = opts.onStatus ?? (() => {});
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser cannot use the camera. Open the game in Chrome over https.');
    }
    status('Starting camera…');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadeddata', r, { once: true }));

    status('Loading body tracking…');
    const fileset = await FilesetResolver.forVisionTasks(`${BASE}wasm`);
    const make = (delegate: 'GPU' | 'CPU') =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: `${BASE}models/pose_landmarker_${opts.model}.task`, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    let landmarker: PoseLandmarker;
    try {
      landmarker = await make('GPU');
    } catch {
      status('GPU tracking unavailable, using CPU…');
      landmarker = await make('CPU');
    }
    return new CameraPose(video, stream, landmarker, opts);
  }

  private loop(): void {
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: { captureTime?: number; presentationTime?: number }) => void) => number;
    };
    const step = (now: number, meta?: { captureTime?: number; presentationTime?: number }) => {
      if (!this.running) return;
      const captured =
        meta?.captureTime && meta.captureTime > 0
          ? meta.captureTime
          : (meta?.presentationTime ?? now) - this.opts.delayMs;
      this.detect(captured);
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step);
      else requestAnimationFrame((t) => step(t));
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(step);
    else requestAnimationFrame((t) => step(t));
  }

  private detect(captured: number): void {
    const video = this.video;
    if (video.readyState < 2) return;
    const start = performance.now();
    const ts = Math.max(this.lastTs + 1, Math.round(start));
    this.lastTs = ts;
    let raw: { x: number; y: number; z: number; visibility?: number }[] | undefined;
    try {
      raw = this.landmarker.detectForVideo(video, ts).landmarks[0];
    } catch {
      return;
    }
    const end = performance.now();
    this.detectMs += 0.1 * (end - start - this.detectMs);
    const prev = this.frames[this.frames.length - 1];
    if (prev && captured > prev.t) {
      const inst = 1000 / (captured - prev.t);
      this.fps = this.fps ? this.fps + 0.1 * (inst - this.fps) : inst;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!raw) {
      if (captured - this.lastSeen > 500) {
        this.fx.forEach((f) => f.reset());
        this.fy.forEach((f) => f.reset());
        this.fz.forEach((f) => f.reset());
      }
      pushFrame(this.frames, { t: captured, lm: null, w, h });
      return;
    }
    this.lastSeen = captured;
    const lm: Pt[] = raw.map((p, i) => ({
      x: this.fx[i].filter((1 - p.x) * w, captured),
      y: this.fy[i].filter(p.y * h, captured),
      z: this.fz[i].filter(p.z * w, captured),
      v: p.visibility ?? 1,
    }));
    pushFrame(this.frames, { t: captured, lm, w, h });
  }

  latest(): PoseFrame {
    return this.frames[this.frames.length - 1];
  }

  since(t: number): PoseFrame[] {
    return framesSince(this.frames, t);
  }

  stop(): void {
    this.running = false;
    this.stream.getTracks().forEach((t) => t.stop());
    this.landmarker.close();
  }
}

/** Pose parameters in body space that drive the simulated player. */
export interface SimParams {
  lWrist: V2;
  rWrist: V2;
  lElbow?: V2;
  rElbow?: V2;
  /** Sideways shift in shoulder widths. */
  lean?: number;
  /** Shoulder drop as a fraction of torso length. */
  duck?: number;
  /** Hip rise as a fraction of torso length. */
  rise?: number;
  /** Wrist depth relative to the shoulders in shoulder widths (negative = toward the camera). */
  lWristZ?: number;
  rWristZ?: number;
  /** Knee lift for running in place, in shoulder widths. */
  lKneeUp?: number;
  rKneeUp?: number;
  /** Torso tilt in radians (+ = leaning right). */
  tilt?: number;
}

export const SIM_REST: SimParams = {
  lWrist: { x: -0.75, y: -1.55 },
  rWrist: { x: 0.75, y: -1.55 },
};

/** A scripted stand-in for the camera: used for demo mode and automated tests. */
export class SimPose implements PoseSource {
  readonly kind = 'sim' as const;
  fps = 30;
  detectMs = 0;
  video: HTMLVideoElement | null = null;
  private frames: PoseFrame[] = [];
  private timer: number;
  drive: (tMs: number) => SimParams = () => SIM_REST;

  static readonly W = 1280;
  static readonly H = 720;
  static readonly SCALE = 105;
  static readonly TORSO = 1.5;

  constructor(hz = 30) {
    this.fps = hz;
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 1000 / hz);
  }

  private tick(): void {
    const t = performance.now();
    pushFrame(this.frames, { t, lm: SimPose.build(this.drive(t)), w: SimPose.W, h: SimPose.H });
  }

  /** Build a full 33-point skeleton from body-space parameters. */
  static build(p: SimParams): Pt[] {
    const s = SimPose.SCALE;
    const torsoPx = SimPose.TORSO * s;
    const cx = SimPose.W / 2 + (p.lean ?? 0) * s;
    const cy = 250 + (p.duck ?? 0) * torsoPx - (p.rise ?? 0) * torsoPx;
    const tilt = p.tilt ?? 0;
    // Tilt rotates the upper body about the hips.
    const hipC = { x: 0, y: -SimPose.TORSO };
    const rot = (v: V2): V2 => {
      if (!tilt || v.y < hipC.y) return v;
      const dx = v.x - hipC.x;
      const dy = v.y - hipC.y;
      const c = Math.cos(-tilt);
      const sn = Math.sin(-tilt);
      return { x: hipC.x + dx * c - dy * sn, y: hipC.y + dx * sn + dy * c };
    };
    const px = (v: V2, z = 0): Pt => {
      const r = rot(v);
      return { x: cx + r.x * s, y: cy - r.y * s, z: z * s, v: 0.98 };
    };
    const elbow = (w: V2, side: number): V2 => ({ x: side * 0.5 + (w.x - side * 0.5) * 0.5, y: w.y * 0.5 - 0.05 });
    const lm: Pt[] = new Array(33).fill(null).map(() => px({ x: 0, y: 0.8 }));
    const duckBend = Math.max(0, p.duck ?? 0);
    const lk = p.lKneeUp ?? 0;
    const rk = p.rKneeUp ?? 0;
    lm[LM.nose] = px({ x: 0, y: 0.78 });
    lm[LM.lShoulder] = px({ x: -0.5, y: 0 });
    lm[LM.rShoulder] = px({ x: 0.5, y: 0 });
    lm[LM.lElbow] = px(p.lElbow ?? elbow(p.lWrist, -1), (p.lWristZ ?? 0) * 0.5);
    lm[LM.rElbow] = px(p.rElbow ?? elbow(p.rWrist, 1), (p.rWristZ ?? 0) * 0.5);
    lm[LM.lWrist] = px(p.lWrist, p.lWristZ ?? 0);
    lm[LM.rWrist] = px(p.rWrist, p.rWristZ ?? 0);
    lm[LM.lIndex] = px({ x: p.lWrist.x, y: p.lWrist.y - 0.15 }, p.lWristZ ?? 0);
    lm[LM.rIndex] = px({ x: p.rWrist.x, y: p.rWrist.y - 0.15 }, p.rWristZ ?? 0);
    lm[LM.lHip] = { ...px({ x: -0.32, y: -SimPose.TORSO }) };
    lm[LM.rHip] = { ...px({ x: 0.32, y: -SimPose.TORSO }) };
    lm[LM.lKnee] = px({ x: -0.34, y: -SimPose.TORSO - 1.2 + duckBend * 1.5 + lk });
    lm[LM.rKnee] = px({ x: 0.34, y: -SimPose.TORSO - 1.2 + duckBend * 1.5 + rk });
    lm[LM.lAnkle] = px({ x: -0.34, y: -SimPose.TORSO - 2.4 + duckBend * 1.7 + lk * 1.4 });
    lm[LM.rAnkle] = px({ x: 0.34, y: -SimPose.TORSO - 2.4 + duckBend * 1.7 + rk * 1.4 });
    return lm;
  }

  latest(): PoseFrame {
    return this.frames[this.frames.length - 1];
  }

  since(t: number): PoseFrame[] {
    return framesSince(this.frames, t);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
