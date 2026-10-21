/** Pure helpers for the hand cursor: magnetic target choice and the swipe-back gesture. */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Distance from a point to a rectangle (0 inside). */
export function rectDist(x: number, y: number, r: Rect): number {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

/**
 * Magnetic target choice: the nearest target within `snap` px is captured, and the current one is kept until the
 * hand clearly moves onto another target or away, so shaky hands do not flicker between neighbours.
 * Returns the index of the target to hover, or -1.
 */
export function pickTarget(x: number, y: number, rects: Rect[], cur: number, snap: number): number {
  let best = -1;
  let bestD = Infinity;
  rects.forEach((r, i) => {
    const d = rectDist(x, y, r);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  const hyst = snap * 0.35;
  if (cur >= 0 && cur < rects.length) {
    const dCur = rectDist(x, y, rects[cur]);
    if (dCur <= hyst || (dCur < snap * 1.5 && dCur - bestD < hyst)) return cur;
  }
  return bestD <= snap ? best : -1;
}

/**
 * Back gesture: a quick flick of the pointing hand from the right half of the screen off its left edge.
 * Feed unclamped screen fractions (0..1 is on screen). A slow move onto a left-side button does not count.
 */
export class SwipeBack {
  private hist: { t: number; x: number; y: number }[] = [];
  private last = -Infinity;

  reset(): void {
    this.hist.length = 0;
  }

  update(x: number, y: number, t: number): boolean {
    const h = this.hist;
    h.push({ t, x, y });
    while (h.length && t - h[0].t > 600) h.shift();
    if (x > -0.02 || t - this.last < 1200) return false;
    // Still moving fast at the end, so it is not a reach that is slowing down onto a button.
    let prev: { t: number; x: number; y: number } | null = null;
    for (let i = h.length - 1; i >= 0 && !prev; i--) if (t - h[i].t >= 50) prev = h[i];
    if (!prev || t - prev.t > 400 || (prev.x - x) / ((t - prev.t) / 1000) < 1) return false;
    const start = h.find((s) => s.x > 0.5);
    if (!start || Math.abs(start.y - y) > 0.6 * (start.x - x)) return false;
    this.last = t;
    h.length = 0;
    return true;
  }
}
