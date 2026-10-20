/**
 * Demo bot: drives the SimPose racket hand like a player would — prepares, swings forehands/backhands
 * with varied timing and spin, tosses and serves. Reads timing hints the game publishes each frame.
 * Outside a swing the hand moves smoothly with a speed limit, so it never fakes a swing by jumping.
 */
import type { SimParams } from '../../core/pose';
import type { V2 } from '../../core/types';
import type { Handed, Stroke } from './shots';

export interface BotHint {
  /** Human must serve and the game waits for the toss gesture. */
  serveReady: boolean;
  /** The toss is in the air: ideal contact time (perf ms), or 0. */
  serveAt: number;
  /** An incoming ball for the human: ideal contact (perf ms) and stroke side. */
  incoming: { at: number; stroke: Stroke; id: number } | null;
}

interface Swing {
  /** Peak-speed time (perf ms). */
  peak: number;
  dur: number;
  a: V2;
  b: V2;
  from: V2 | null;
}

const ease = (u: number) => {
  const t = Math.max(0, Math.min(1, u));
  return t * t * (3 - 2 * t);
};

/** Free hand movement speed limit (shoulder widths per second): well below the swing threshold. */
const SLOW = 3.4;

export class TennisBot {
  private cur: V2;
  private lastT = 0;
  private swing: Swing | null = null;
  private lastIncoming = -1;
  private lastServe = 0;
  private raiseAt = 0;
  private serveIdx = 0;
  private readonly s: number;
  private readonly rest: V2;
  /** Recent decisions, for the debug overlay. */
  readonly trace: string[] = [];
  private note(m: string): void {
    this.trace.push(m);
    if (this.trace.length > 10) this.trace.shift();
  }

  constructor(
    handed: Handed,
    private skill: number,
  ) {
    this.s = handed === 'right' ? 1 : -1;
    this.rest = { x: 0.35 * this.s, y: -0.75 };
    this.cur = { ...this.rest };
  }

  drive(t: number, h: BotHint): SimParams {
    const s = this.s;
    const dt = this.lastT ? Math.min(0.1, Math.max(0, (t - this.lastT) / 1000)) : 0;
    this.lastT = t;

    // Plan a groundstroke for each new incoming ball.
    const inc = h.incoming;
    if (inc && inc.id !== this.lastIncoming) {
      this.lastIncoming = inc.id;
      const sigma = 0.03 + 0.1 * (1 - this.skill);
      let off = (Math.random() + Math.random() + Math.random() - 1.5) * 2 * sigma;
      const r = Math.random();
      // Now and then a clearly early or late swing (cross-court / down the line).
      if (r < 0.18) off = -0.07 - Math.random() * 0.06;
      else if (r < 0.36) off = 0.07 + Math.random() * 0.06;
      // And occasionally a real mistime, like a person would.
      else if (r < 0.36 + 0.14 * (1.2 - this.skill)) off = (Math.random() < 0.5 ? -1 : 1) * (0.17 + Math.random() * 0.12);
      const style = Math.random();
      const fh = inc.stroke === 'forehand';
      let a: V2;
      let b: V2;
      if (style < 0.55) {
        a = fh ? { x: 1.3, y: -0.55 } : { x: -1.2, y: -0.5 };
        b = fh ? { x: -0.75, y: 0.45 } : { x: 0.95, y: 0.5 };
      } else if (style < 0.82) {
        a = fh ? { x: 1.35, y: -0.2 } : { x: -1.25, y: -0.2 };
        b = fh ? { x: -0.85, y: -0.05 } : { x: 1.0, y: -0.05 };
      } else if (style < 0.95) {
        a = fh ? { x: 1.1, y: 0.45 } : { x: -1.05, y: 0.5 };
        b = fh ? { x: -0.5, y: -0.6 } : { x: 0.6, y: -0.6 };
      } else {
        a = fh ? { x: 0.9, y: -0.9 } : { x: -0.9, y: -0.9 };
        b = fh ? { x: 0.0, y: 1.3 } : { x: 0.1, y: 1.3 };
      }
      this.swing = { peak: inc.at + off * 1000, dur: 170 + Math.random() * 60, a: { x: a.x * s, y: a.y }, b: { x: b.x * s, y: b.y }, from: null };
      this.note(`plan ${inc.id} ${inc.stroke} in ${Math.round(inc.at - t)}ms`);
    }

    // Serve: raise the racket hand once the game is waiting, swing down at the ideal moment.
    if (h.serveReady && !this.raiseAt) this.raiseAt = t + 600 + Math.random() * 600;
    if (!h.serveReady && !h.serveAt) this.raiseAt = 0;
    if (h.serveAt && h.serveAt !== this.lastServe) {
      this.lastServe = h.serveAt;
      const jitter = (Math.random() - 0.5) * 2 * (0.05 + 0.1 * (1 - this.skill));
      const wide = (this.serveIdx++ % 3) - 1;
      this.swing = { peak: h.serveAt + jitter * 1000, dur: 200 + Math.random() * 60, a: { x: 0.45 * s, y: 1.75 }, b: { x: (-0.35 + wide * 0.5) * s, y: -0.7 }, from: null };
    }

    let target: V2 = this.rest;
    if (this.raiseAt && t >= this.raiseAt && (h.serveReady || h.serveAt)) target = { x: 0.45 * s, y: 1.72 };
    const sw = this.swing;
    if (sw) {
      const start = sw.peak - sw.dur / 2;
      const end = start + sw.dur;
      if (t >= start && t <= end) {
        // The swing itself: an eased sweep from where the hand is to the finish.
        if (!sw.from) this.note(`swing from ${this.cur.x.toFixed(2)},${this.cur.y.toFixed(2)} to ${sw.b.x.toFixed(2)},${sw.b.y.toFixed(2)}`);
        sw.from ??= { ...this.cur };
        const k = ease((t - start) / sw.dur);
        this.cur = { x: sw.from.x + (sw.b.x - sw.from.x) * k, y: sw.from.y + (sw.b.y - sw.from.y) * k };
        return this.out();
      }
      if (t < start && t > start - 900) target = sw.a;
      else if (t > end + 350) this.swing = null;
      else if (t > end) target = sw.b;
    }
    // Free movement towards the target, speed-limited.
    const dx = target.x - this.cur.x;
    const dy = target.y - this.cur.y;
    const d = Math.hypot(dx, dy);
    const step = SLOW * dt;
    if (d > 1e-4) {
      const k = Math.min(1, step / d);
      this.cur = { x: this.cur.x + dx * k, y: this.cur.y + dy * k };
    }
    return this.out();
  }

  private out(): SimParams {
    const other: V2 = { x: -0.7 * this.s, y: -1.45 };
    return this.s > 0 ? { lWrist: other, rWrist: this.cur } : { lWrist: this.cur, rWrist: other };
  }
}
