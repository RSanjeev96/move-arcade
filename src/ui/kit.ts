/** Shared UI building blocks for game menus, HUDs, pause and results. Styles live in src/styles.css. */
import { ICONS } from '../icons';
import { drawSkeleton } from '../core/skeleton';
import { handsUp, Hold } from '../core/gestures';
import { local } from '../core/storage';
import type { Body } from '../core/body';
import type { PoseSource } from '../core/types';

export const html = (s: string): HTMLElement => {
  const t = document.createElement('template');
  t.innerHTML = s.trim();
  return t.content.firstElementChild as HTMLElement;
};

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function mount(root: HTMLElement, el: HTMLElement): HTMLElement {
  root.replaceChildren(el);
  return el;
}

/** Top bar with a Back button (data-act="back") and a title. */
export function topbar(title: string): string {
  return `
    <header class="topbar">
      <button class="btn sm" data-hc data-act="back">${ICONS.back} Back</button>
      <div class="top-title">${esc(title)}</div>
      <div class="spacer"></div>
    </header>`;
}

export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

/** A labelled row of choice buttons. Buttons carry data-choice="<key>" and data-val. */
export function choiceRow(key: string, label: string, choices: Choice[]): string {
  return `
    <div class="choice-row">
      <div class="set-label">${esc(label)}</div>
      <div class="seg">${choices
        .map((c) => `<button class="btn sm" data-hc data-choice="${key}" data-val="${c.value}" ${c.hint ? `title="${esc(c.hint)}"` : ''}>${esc(c.label)}</button>`)
        .join('')}</div>
    </div>`;
}

/** Wire choice rows to a state object; highlights the current value and saves on change. */
export function bindChoices<T extends Record<string, string>>(el: HTMLElement, state: T, onChange?: () => void): void {
  const refresh = () =>
    el.querySelectorAll<HTMLElement>('[data-choice]').forEach((b) => b.classList.toggle('on', state[b.dataset.choice!] === b.dataset.val));
  el.querySelectorAll<HTMLElement>('[data-choice]').forEach((b) =>
    b.addEventListener('click', () => {
      (state as Record<string, string>)[b.dataset.choice!] = b.dataset.val!;
      refresh();
      onChange?.();
    }),
  );
  refresh();
}

/** Resolves with the data-act value of the first [data-act] button clicked inside el. */
export function nextAction(el: HTMLElement): Promise<string> {
  return new Promise((resolve) => {
    el.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => b.addEventListener('click', () => resolve(b.dataset.act!), { once: true }));
  });
}

export function loading(root: HTMLElement, text: string): (t: string) => void {
  const el = mount(root, html(`<div class="screen loading"><div class="spinner"></div><div class="load-text">${esc(text)}</div></div>`));
  return (t) => ((el.querySelector('.load-text') as HTMLElement).textContent = t);
}

// ---- best scores --------------------------------------------------------------------

export interface Best {
  score: number;
  rank?: string;
  stars?: number;
  extra?: string;
}

/** Best scores per key (e.g. "racer:monza:f1"). For lower-is-better (lap times) pass lowerIsBetter. */
export const bests = {
  get(key: string): Best | undefined {
    return local.getRaw<Record<string, Best>>('ma.best', {})[key];
  },
  /** Saves if better; returns true when it is a new best. */
  submit(key: string, b: Best, lowerIsBetter = false): boolean {
    const all = local.getRaw<Record<string, Best>>('ma.best', {});
    const cur = all[key];
    const better = !cur || (lowerIsBetter ? b.score < cur.score : b.score > cur.score);
    if (better) {
      all[key] = b;
      local.set('ma.best', all);
    }
    return better;
  },
};

// ---- results ----------------------------------------------------------------------------

export interface ResultsView {
  title: string;
  subtitle: string;
  /** Big letter or short text (e.g. "S", "1st", "WIN"). */
  badge: string;
  /** CSS modifier for the badge colour: gold | blue | red. */
  badgeTone?: 'gold' | 'blue' | 'red';
  stars?: number;
  /** Headline number or text. */
  score: string;
  newBest?: boolean;
  stats: { label: string; value: string }[];
  /** Buttons; the first is the primary one. */
  actions: { act: string; label: string; icon?: keyof typeof ICONS }[];
}

/** Shows a results card and resolves with the chosen action. */
export function showResults(root: HTMLElement, r: ResultsView): Promise<string> {
  const tone = r.badgeTone ?? 'gold';
  const el = html(`
    <div class="screen results">
      <div class="orbs"><i></i><i></i><i></i></div>
      <div class="res-card glass">
        <div class="res-head">
          <div class="res-rank tone-${tone}">${esc(r.badge)}</div>
          <div>
            <div class="res-title">${esc(r.title)}</div>
            <div class="res-diff">${esc(r.subtitle)}</div>
            ${r.stars !== undefined ? `<div class="res-stars">${[0, 1, 2].map((i) => `<span class="${i < r.stars! ? 'on' : ''}">★</span>`).join('')}</div>` : ''}
          </div>
        </div>
        <div class="res-score">${esc(r.score)}${r.newBest ? '<em>New best!</em>' : ''}</div>
        <div class="res-grid">${r.stats.map((s) => `<div><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join('')}</div>
        <div class="actions">${r.actions
          .map((a, i) => `<button class="btn ${i === 0 ? 'primary' : i === r.actions.length - 1 ? 'ghost' : ''}" data-hc data-act="${a.act}">${a.icon ? ICONS[a.icon] : ''} ${esc(a.label)}</button>`)
          .join('')}</div>
      </div>
    </div>`);
  mount(root, el);
  return nextAction(el);
}

// ---- in-game helpers ------------------------------------------------------------------------

/** Pause trigger: both hands held above the head for 1.3 s. */
export class HandsUpPause {
  private hold = new Hold(1300);
  /** Returns true once when the gesture completes. */
  update(b: Body | null, now: number): boolean {
    const p = this.hold.update(!!b && handsUp(b), now);
    if (p >= 1) {
      this.hold.reset();
      return true;
    }
    return false;
  }
}

/** Overlay pause menu. Resolves with resume | restart | quit. */
export function pauseMenu(root: HTMLElement, cursor: (on: boolean) => void, extra: { act: string; label: string }[] = []): Promise<string> {
  const el = html(`
    <div class="pause-menu">
      <h2>Paused</h2>
      <button class="btn primary" data-hc data-back data-act="resume">Resume</button>
      ${extra.map((x) => `<button class="btn" data-hc data-act="${x.act}">${esc(x.label)}</button>`).join('')}
      <button class="btn" data-hc data-act="restart">Restart</button>
      <button class="btn ghost" data-hc data-act="quit">Quit to menu</button>
    </div>`);
  root.appendChild(el);
  cursor(true);
  return nextAction(el).then((a) => {
    el.remove();
    cursor(false);
    return a;
  });
}

/** Small camera + skeleton preview for a HUD corner. */
export class CamPreview {
  readonly canvas: HTMLCanvasElement;
  private last = 0;
  constructor(
    private pose: PoseSource,
    className = 'hud-cam',
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 320;
    this.canvas.height = 180;
    this.canvas.className = className;
  }
  draw(now: number): void {
    if (now - this.last < 66) return;
    this.last = now;
    drawSkeleton(this.canvas.getContext('2d')!, this.pose.video, this.pose.latest(), this.canvas.width, this.canvas.height);
  }
}

/** Big centred message (countdowns, "Goal!", "Lap 2"). */
export class CenterText {
  readonly el: HTMLElement;
  private timer = 0;
  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'center-msg';
    parent.appendChild(this.el);
  }
  show(text: string, ms = 1200, tone = ''): void {
    clearTimeout(this.timer);
    this.el.textContent = text;
    this.el.className = `center-msg show ${tone}`;
    if (ms > 0) this.timer = window.setTimeout(() => this.el.classList.remove('show'), ms);
  }
  hide(): void {
    this.el.classList.remove('show');
  }
}

export function fmtClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
