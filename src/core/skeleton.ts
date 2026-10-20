import { LM, type PoseFrame } from './types';

const BONES: [number, number][] = [
  [LM.lShoulder, LM.rShoulder],
  [LM.lShoulder, LM.lElbow],
  [LM.lElbow, LM.lWrist],
  [LM.rShoulder, LM.rElbow],
  [LM.rElbow, LM.rWrist],
  [LM.lShoulder, LM.lHip],
  [LM.rShoulder, LM.rHip],
  [LM.lHip, LM.rHip],
  [LM.lHip, LM.lKnee],
  [LM.lKnee, LM.lAnkle],
  [LM.rHip, LM.rKnee],
  [LM.rKnee, LM.rAnkle],
];

/** Draw the mirrored camera image (if any) with the tracked skeleton on top, scaled to cover the canvas. */
export function drawSkeleton(
  g: CanvasRenderingContext2D,
  video: HTMLVideoElement | null,
  f: PoseFrame,
  w: number,
  h: number,
  opts: { dim?: number; lineWidth?: number } = {},
): void {
  const scale = Math.max(w / f.w, h / f.h);
  const ox = (w - f.w * scale) / 2;
  const oy = (h - f.h * scale) / 2;
  g.save();
  g.fillStyle = '#0b0820';
  g.fillRect(0, 0, w, h);
  if (video && video.readyState >= 2) {
    g.translate(w, 0);
    g.scale(-1, 1);
    g.drawImage(video, w - ox - f.w * scale, oy, f.w * scale, f.h * scale);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = `rgba(8,4,24,${opts.dim ?? 0.35})`;
    g.fillRect(0, 0, w, h);
  }
  const lm = f.lm;
  if (lm) {
    const P = (i: number) => [ox + lm[i].x * scale, oy + lm[i].y * scale] as const;
    g.lineCap = 'round';
    g.lineWidth = opts.lineWidth ?? Math.max(2, w / 110);
    for (const [a, b] of BONES) {
      if (lm[a].v < 0.4 || lm[b].v < 0.4) continue;
      const [x1, y1] = P(a);
      const [x2, y2] = P(b);
      const grad = g.createLinearGradient(x1, y1, x2, y2);
      grad.addColorStop(0, '#7df9ff');
      grad.addColorStop(1, '#b06bff');
      g.strokeStyle = grad;
      g.shadowColor = '#5ee7ff';
      g.shadowBlur = 8;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }
    g.shadowBlur = 0;
    for (const [i, c] of [
      [LM.lWrist, '#ff2d6a'],
      [LM.rWrist, '#1fb8ff'],
    ] as const) {
      if (lm[i].v < 0.3) continue;
      const [x, y] = P(i);
      g.fillStyle = c;
      g.beginPath();
      g.arc(x, y, Math.max(4, w / 60), 0, Math.PI * 2);
      g.fill();
    }
    if (lm[LM.nose].v > 0.4) {
      const [x, y] = P(LM.nose);
      g.strokeStyle = 'rgba(125,249,255,0.8)';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, Math.max(8, w / 30), 0, Math.PI * 2);
      g.stroke();
    }
  }
  g.restore();
}
