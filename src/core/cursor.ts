import type { AudioEngine } from './audio';
import type { Body } from './body';
import { pickTarget, SwipeBack } from './pointer';

const DWELL_MS = 800;
const COOLDOWN_MS = 900;
const SCAN_MS = 150;
/** Buttons a swipe-back presses, most specific first. */
const BACK_SEL = '[data-back], [data-act="back"], [data-go="home"]';

interface Target {
  el: HTMLElement;
  r: DOMRect;
}

/**
 * Point with a raised hand; the nearest button pulls the cursor in, and holding on it for a moment presses it.
 * A quick flick of the hand off the left edge of the screen presses the screen's Back button.
 * Any element with a `data-hc` attribute is a target. Touch and mouse keep working as normal.
 */
export class HandCursor {
  readonly el: HTMLElement;
  private ring: SVGCircleElement;
  private frame: HTMLElement;
  private bar: HTMLElement;
  private toast: HTMLElement;
  private enabled = false;
  private x = 0.5;
  private y = 0.5;
  private visible = false;
  private hand: 0 | 1 | null = null;
  private targets: Target[] = [];
  private scannedAt = 0;
  private target: HTMLElement | null = null;
  private since = 0;
  private cooldownUntil = 0;
  private raf = 0;
  private lastT = 0;
  private clickX = -1;
  private clickY = -1;
  private clickAt = 0;
  private swipe = new SwipeBack();
  /** After a swipe the hand rests at the screen edge; nothing is pressed until it comes back. */
  private swiped = false;
  private toastTimer = 0;

  constructor(
    private getBody: () => Body | null,
    private audio: AudioEngine,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'hand-cursor';
    this.el.innerHTML = `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" class="hc-bg"/><circle cx="50" cy="50" r="40" class="hc-ring"/><circle cx="50" cy="50" r="12" class="hc-dot"/></svg>`;
    this.ring = this.el.querySelector('.hc-ring')!;
    this.frame = document.createElement('div');
    this.frame.className = 'hc-frame';
    this.frame.innerHTML = '<i></i>';
    this.bar = this.frame.firstElementChild as HTMLElement;
    this.toast = document.createElement('div');
    this.toast.className = 'hc-toast';
    document.body.append(this.frame, this.el, this.toast);
    this.loop();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.scannedAt = 0;
    if (!on) this.hide();
  }

  private hide(): void {
    this.visible = false;
    this.hand = null;
    this.swiped = false;
    this.swipe.reset();
    this.el.classList.remove('show');
    this.setTarget(null);
  }

  private setTarget(t: HTMLElement | null): void {
    if (t === this.target) return;
    this.target?.classList.remove('hc-hover');
    this.target = t;
    this.since = performance.now();
    this.frame.classList.toggle('show', !!t);
    if (t) {
      t.classList.add('hc-hover');
      this.frame.style.borderRadius = getComputedStyle(t).borderRadius;
      this.reveal(t);
      this.audio.hover();
    }
  }

  /** Scroll a target that is partly hidden inside a scrolling list fully into view. */
  private reveal(t: HTMLElement): void {
    const r = t.getBoundingClientRect();
    let clipped = r.top < 0 || r.bottom > window.innerHeight;
    for (let p = t.parentElement; p && !clipped; p = p.parentElement) {
      if (p.scrollHeight <= p.clientHeight + 2 && p.scrollWidth <= p.clientWidth + 2) continue;
      const pr = p.getBoundingClientRect();
      clipped = r.top < pr.top - 1 || r.bottom > pr.bottom + 1 || r.left < pr.left - 1 || r.right > pr.right + 1;
    }
    if (clipped) t.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  /** Visible, uncovered targets on screen. */
  private scan(): Target[] {
    const out: Target[] = [];
    const W = window.innerWidth;
    const H = window.innerHeight;
    document.querySelectorAll<HTMLElement>('[data-hc]:not([disabled])').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.right < 0 || r.bottom < 0 || r.left > W || r.top > H) return;
      const cx = Math.min(W - 1, Math.max(0, (r.left + r.right) / 2));
      const cy = Math.min(H - 1, Math.max(0, (r.top + r.bottom) / 2));
      const top = document.elementFromPoint(cx, cy);
      if (top && (el === top || el.contains(top))) out.push({ el, r });
    });
    return out;
  }

  private showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('show'), 900);
  }

  private press(t: HTMLElement, now: number): void {
    this.cooldownUntil = now + COOLDOWN_MS;
    this.clickX = this.x;
    this.clickY = this.y;
    this.clickAt = now;
    this.since = now + COOLDOWN_MS;
    this.audio.select();
    t.classList.add('hc-press');
    setTimeout(() => t.classList.remove('hc-press'), 250);
    t.click();
    this.scannedAt = 0;
  }

  /** Pick the pointing hand: keep the current one while it stays raised; switch only if the other is clearly higher. */
  private pickHand(b: Body): 0 | 1 | null {
    const lUp = b.lWristV > 0.4 && b.lWrist.y >= -1.15;
    const rUp = b.rWristV > 0.4 && b.rWrist.y >= -1.15;
    let h = this.hand;
    if ((h === 0 && !lUp) || (h === 1 && !rUp)) h = null;
    if (h === null) return lUp && rUp ? (b.rWrist.y >= b.lWrist.y ? 1 : 0) : rUp ? 1 : lUp ? 0 : null;
    if (h === 0 && rUp && b.rWrist.y > b.lWrist.y + 0.5) return 1;
    if (h === 1 && lUp && b.lWrist.y > b.rWrist.y + 0.5) return 0;
    return h;
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.enabled) return;
    const b = this.getBody();
    if (!b || !b.ok) return this.hide();
    const hand = this.pickHand(b);
    if (hand === null) return this.hide();
    if (hand !== this.hand) this.swipe.reset();
    this.hand = hand;
    const w = hand === 0 ? b.lWrist : b.rWrist;
    const lo = hand === 1 ? -0.6 : -1.8;
    const rx = (w.x - lo) / 2.4;
    const ry = (1.2 - w.y) / 2.3;
    const tx = Math.min(1, Math.max(0, rx));
    const ty = Math.min(1, Math.max(0, ry));
    const now = performance.now();
    const dt = Math.min(0.1, (now - (this.lastT || now)) / 1000);
    this.lastT = now;
    if (!this.visible) {
      this.x = tx;
      this.y = ty;
    }
    // Steady when the hand is still, quick when it moves.
    const a = Math.min(0.7, 0.18 + (Math.hypot(tx - this.x, ty - this.y) / Math.max(dt, 1 / 120)) * 0.12);
    this.x += (tx - this.x) * a;
    this.y += (ty - this.y) * a;
    this.visible = true;
    this.el.classList.add('show');

    if (now - this.scannedAt > SCAN_MS) {
      this.targets = this.scan();
      this.scannedAt = now;
    }

    if (this.swipe.update(rx, ry, now)) {
      const back = this.targets.map((t) => t.el).find((el) => el.matches(BACK_SEL));
      if (back) {
        this.setTarget(null);
        this.showToast('Back');
        this.press(back, now);
        this.swiped = true;
        return;
      }
    }

    const W = window.innerWidth;
    const H = window.innerHeight;
    const px = this.x * W;
    const py = this.y * H;
    const live = this.targets.filter((t) => t.el.isConnected && !(t.el as HTMLButtonElement).disabled);
    const rects = live.map((t) => (t.el === this.target ? t.el.getBoundingClientRect() : t.r));
    const cur = live.findIndex((t) => t.el === this.target);
    const i = pickTarget(px, py, rects, cur, Math.max(48, Math.min(W, H) * 0.09));
    const target = i >= 0 ? live[i].el : null;
    this.setTarget(target);

    // Draw the cursor pulled part of the way toward the button it is locked on.
    let dx = px;
    let dy = py;
    if (target) {
      const r = rects[i];
      this.frame.style.transform = `translate(${r.left}px, ${r.top}px)`;
      this.frame.style.width = `${r.width}px`;
      this.frame.style.height = `${r.height}px`;
      const cx = (r.left + r.right) / 2 - px;
      const cy = (r.top + r.bottom) / 2 - py;
      const d = Math.hypot(cx, cy);
      const pull = Math.min(d * 0.3, 40) / (d || 1);
      dx += cx * pull;
      dy += cy * pull;
    }
    this.el.style.transform = `translate(${dx}px, ${dy}px)`;

    // After a press, the hand has to move a little (or wait) before the next press, so new screens are not pressed by accident.
    if (this.swiped && rx > 0.12) this.swiped = false;
    const settled = !this.swiped && (Math.hypot(this.x - this.clickX, this.y - this.clickY) > 0.06 || now - this.clickAt > 2500);
    if (!settled) this.since = now;
    const k = target && settled && now > this.cooldownUntil ? Math.min(1, Math.max(0, (now - this.since) / DWELL_MS)) : 0;
    this.ring.style.strokeDashoffset = String(251.3 * (1 - k));
    this.bar.style.width = `${k * 100}%`;
    if (target && k >= 1) this.press(target, now);
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.el.remove();
    this.frame.remove();
    this.toast.remove();
  }
}
