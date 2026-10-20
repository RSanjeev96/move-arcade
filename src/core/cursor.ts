import type { AudioEngine } from './audio';
import type { Body } from './body';

const DWELL_MS = 1000;
const COOLDOWN_MS = 900;

/**
 * Point with a raised hand; hover over a button for a second to press it.
 * Any element with a `data-hc` attribute is a target. Touch and mouse keep working as normal.
 */
export class HandCursor {
  readonly el: HTMLElement;
  private ring: SVGCircleElement;
  private enabled = false;
  private x = 0.5;
  private y = 0.5;
  private visible = false;
  private target: HTMLElement | null = null;
  private since = 0;
  private cooldownUntil = 0;
  private raf = 0;
  private clickX = -1;
  private clickY = -1;
  private clickAt = 0;

  constructor(
    private getBody: () => Body | null,
    private audio: AudioEngine,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'hand-cursor';
    this.el.innerHTML = `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" class="hc-bg"/><circle cx="50" cy="50" r="40" class="hc-ring"/><circle cx="50" cy="50" r="12" class="hc-dot"/></svg>`;
    this.ring = this.el.querySelector('.hc-ring')!;
    document.body.appendChild(this.el);
    this.loop();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.hide();
  }

  private hide(): void {
    this.visible = false;
    this.el.classList.remove('show');
    this.setTarget(null);
  }

  private setTarget(t: HTMLElement | null): void {
    if (t === this.target) return;
    this.target?.classList.remove('hc-hover');
    this.target = t;
    this.since = performance.now();
    if (t) {
      t.classList.add('hc-hover');
      this.audio.hover();
    }
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.enabled) return;
    const b = this.getBody();
    if (!b || !b.ok) return this.hide();
    // Use whichever hand is raised higher, as long as it is above the waist.
    const l = b.lWristV > 0.4 ? b.lWrist : null;
    const r = b.rWristV > 0.4 ? b.rWrist : null;
    let hand: 0 | 1 | null = null;
    if (l && r) hand = r.y >= l.y ? 1 : 0;
    else if (r) hand = 1;
    else if (l) hand = 0;
    const w = hand === 0 ? l : hand === 1 ? r : null;
    if (!w || w.y < -1.15) return this.hide();
    const lo = hand === 1 ? -0.6 : -1.8;
    const tx = Math.min(1, Math.max(0, (w.x - lo) / 2.4));
    const ty = Math.min(1, Math.max(0, (1.2 - w.y) / 2.3));
    if (!this.visible) {
      this.x = tx;
      this.y = ty;
    }
    this.x += (tx - this.x) * 0.35;
    this.y += (ty - this.y) * 0.35;
    this.visible = true;
    this.el.classList.add('show');
    const px = this.x * window.innerWidth;
    const py = this.y * window.innerHeight;
    this.el.style.transform = `translate(${px}px, ${py}px)`;

    const now = performance.now();
    const hit = document.elementFromPoint(px, py) as HTMLElement | null;
    const target = hit?.closest<HTMLElement>('[data-hc]:not([disabled])') ?? null;
    this.setTarget(target);
    // After a press, the hand has to move a little (or wait) before the next press, so new screens are not pressed by accident.
    const settled = Math.hypot(this.x - this.clickX, this.y - this.clickY) > 0.06 || now - this.clickAt > 2500;
    if (!settled) this.since = now;
    const k = target && settled && now > this.cooldownUntil ? Math.min(1, (now - this.since) / DWELL_MS) : 0;
    this.ring.style.strokeDashoffset = String(251.3 * (1 - k));
    if (target && k >= 1) {
      this.cooldownUntil = now + COOLDOWN_MS;
      this.clickX = this.x;
      this.clickY = this.y;
      this.clickAt = now;
      this.since = now + COOLDOWN_MS;
      this.audio.select();
      target.classList.add('hc-press');
      setTimeout(() => target.classList.remove('hc-press'), 250);
      target.click();
    }
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.el.remove();
  }
}
