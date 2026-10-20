/** Broadcast-style HUD: scorebug, kick dots, rapid-fire counters, banners, prompts, stinger transitions. */
import { esc } from '../../ui/kit';

export interface TeamInfo {
  name: string;
  short: string;
  color: string;
  color2: string;
}

export type BannerTone = 'save' | 'great' | 'goal' | 'miss' | 'info' | 'win' | 'lose';

export class Hud {
  readonly el: HTMLElement;
  private q: Record<string, HTMLElement> = {};
  private bannerTimer = 0;
  private promptTimer = 0;
  private last: Record<string, string> = {};
  private lastDots = '';
  private lastStrip = '';

  constructor(
    parent: HTMLElement,
    private mode: 'shootout' | 'rapid',
    home: TeamInfo,
    away: TeamInfo,
    difficulty: string,
  ) {
    this.el = document.createElement('div');
    this.el.className = `gk-hud mode-${mode}`;
    this.el.innerHTML = `
      <div class="gk-bug">
        <div class="gk-bug-top">
          <div class="gk-team home" style="--tc:${home.color};--tc2:${home.color2}"><i></i><b>${esc(home.short)}</b></div>
          <div class="gk-scores"><span class="gk-h">0</span><em>–</em><span class="gk-a">0</span></div>
          <div class="gk-team away" style="--tc:${away.color};--tc2:${away.color2}"><b>${esc(away.short)}</b><i></i></div>
        </div>
        <div class="gk-bug-sub"><span class="gk-sub">PENALTIES</span><span class="gk-diff">${esc(difficulty)}</span></div>
        <div class="gk-pens">
          <div class="gk-row home"></div>
          <div class="gk-row away"></div>
        </div>
      </div>
      <div class="gk-rapid">
        <div class="gk-timer"><b>1:00</b><span>Time</span></div>
        <div class="gk-saves"><b>0</b><span>Saves</span></div>
        <div class="gk-points"><b>0</b><span>Points</span></div>
        <div class="gk-combo"><b>×1</b><span>Streak 0</span></div>
      </div>
      <div class="gk-strip"></div>
      <div class="gk-keeper-stat"><b>0</b><span>saves</span><em>0 goals</em></div>
      <div class="gk-banner"><div class="gk-banner-in"><b></b><span></span></div></div>
      <div class="gk-prompt"></div>
      <div class="gk-aim"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" class="bg"/><circle cx="50" cy="50" r="44" class="fg"/></svg><span></span></div>
      <div class="gk-warn">Step into view of the camera</div>
      <canvas class="hud-cam gk-cam" width="320" height="180"></canvas>
      <button class="gk-pause" data-hc aria-label="Pause"><i></i><i></i></button>
      <div class="gk-hint">Raise both hands for 1 second to pause</div>
      <div class="gk-stinger"><i></i><i></i><b></b></div>
      <div class="gk-title"><div class="gk-title-in"><small></small><b></b><span></span></div></div>
      <div class="gk-third"><i></i><b></b><span></span></div>
      <div class="gk-vignette"></div>`;
    parent.appendChild(this.el);
    const sel = (s: string) => this.el.querySelector(s) as HTMLElement;
    this.q = {
      h: sel('.gk-h'),
      a: sel('.gk-a'),
      sub: sel('.gk-sub'),
      rowH: sel('.gk-row.home'),
      rowA: sel('.gk-row.away'),
      timer: sel('.gk-timer b'),
      saves: sel('.gk-saves b'),
      points: sel('.gk-points b'),
      combo: sel('.gk-combo b'),
      comboL: sel('.gk-combo span'),
      comboBox: sel('.gk-combo'),
      strip: sel('.gk-strip'),
      kStat: sel('.gk-keeper-stat b'),
      kGoals: sel('.gk-keeper-stat em'),
      banner: sel('.gk-banner'),
      bannerB: sel('.gk-banner b'),
      bannerS: sel('.gk-banner span'),
      prompt: sel('.gk-prompt'),
      aim: sel('.gk-aim'),
      aimFg: sel('.gk-aim .fg'),
      aimTxt: sel('.gk-aim span'),
      warn: sel('.gk-warn'),
      stinger: sel('.gk-stinger'),
      title: sel('.gk-title'),
      titleS: sel('.gk-title small'),
      titleB: sel('.gk-title b'),
      titleT: sel('.gk-title span'),
      vignette: sel('.gk-vignette'),
    };
    void this.mode;
  }

  get cam(): HTMLCanvasElement {
    return this.el.querySelector('.gk-cam') as HTMLCanvasElement;
  }

  get pauseBtn(): HTMLElement {
    return this.el.querySelector('.gk-pause') as HTMLElement;
  }

  private set(k: string, v: string, apply: () => void): void {
    if (this.last[k] === v) return;
    this.last[k] = v;
    apply();
  }

  score(home: number, away: number, sub: string): void {
    this.set('h', String(home), () => {
      this.q.h.textContent = String(home);
      this.pop(this.q.h);
    });
    this.set('a', String(away), () => {
      this.q.a.textContent = String(away);
      this.pop(this.q.a);
    });
    this.set('sub', sub, () => (this.q.sub.textContent = sub));
  }

  /** Penalty dots: true scored, false missed, null to come. */
  pens(home: boolean[], away: boolean[], next: 'home' | 'away' | null): void {
    const key = JSON.stringify([home, away, next]);
    if (key === this.lastDots) return;
    this.lastDots = key;
    const row = (r: boolean[], side: 'home' | 'away') => {
      const n = Math.max(5, Math.max(home.length, away.length) + (next ? 1 : 0));
      let s = '';
      for (let i = 0; i < n; i++) {
        const v = r[i];
        const cls = v === true ? 'in' : v === false ? 'out' : next === side && i === r.length ? 'now' : '';
        s += `<i class="${cls}"></i>`;
      }
      return s;
    };
    this.q.rowH.innerHTML = row(home, 'home');
    this.q.rowA.innerHTML = row(away, 'away');
  }

  keeperStat(saves: number, goals: number): void {
    this.set('ks', `${saves}/${goals}`, () => {
      this.q.kStat.textContent = String(saves);
      this.q.kGoals.textContent = `${goals} conceded`;
      this.pop(this.q.kStat);
    });
  }

  rapid(timeLeft: number, saves: number, points: number, mult: number, streak: number): void {
    const t = Math.max(0, timeLeft);
    const txt = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    this.set('timer', txt, () => {
      this.q.timer.textContent = txt;
      this.q.timer.parentElement!.classList.toggle('low', t <= 10);
    });
    this.set('saves', String(saves), () => {
      this.q.saves.textContent = String(saves);
      this.pop(this.q.saves);
    });
    this.set('points', String(points), () => (this.q.points.textContent = points.toLocaleString()));
    const m = `×${mult % 1 ? mult.toFixed(1) : mult}`;
    this.set('combo', `${m}|${streak}`, () => {
      this.q.combo.textContent = m;
      this.q.comboL.textContent = `Streak ${streak}`;
      this.q.comboBox.classList.toggle('hot', streak >= 3);
      if (streak > 0) this.pop(this.q.comboBox);
    });
  }

  /** Recent shots: g = goal, s = save, m = miss. */
  strip(results: ('s' | 'g' | 'm')[]): void {
    const key = results.join('');
    if (key === this.lastStrip) return;
    this.lastStrip = key;
    this.q.strip.innerHTML = results
      .slice(-12)
      .map((r) => `<i class="${r}"></i>`)
      .join('');
  }

  banner(text: string, sub = '', tone: BannerTone = 'info', ms = 1600): void {
    clearTimeout(this.bannerTimer);
    const b = this.q.banner;
    b.className = `gk-banner tone-${tone}`;
    this.q.bannerB.textContent = text;
    this.q.bannerS.textContent = sub;
    void b.offsetWidth;
    b.classList.add('show');
    if (ms > 0) this.bannerTimer = window.setTimeout(() => b.classList.remove('show'), ms);
  }

  hideBanner(): void {
    this.q.banner.classList.remove('show');
  }

  prompt(html: string, ms = 0): void {
    clearTimeout(this.promptTimer);
    const p = this.q.prompt;
    if (!html) {
      p.classList.remove('show');
      return;
    }
    if (p.innerHTML !== html) p.innerHTML = html;
    p.classList.add('show');
    if (ms > 0) this.promptTimer = window.setTimeout(() => p.classList.remove('show'), ms);
  }

  aim(show: boolean, progress = 0, text = ''): void {
    this.q.aim.classList.toggle('show', show);
    if (!show) return;
    this.q.aimFg.style.strokeDashoffset = String(276.5 * (1 - progress));
    if (this.q.aimTxt.textContent !== text) this.q.aimTxt.textContent = text;
  }

  warn(show: boolean): void {
    this.q.warn.classList.toggle('show', show);
  }

  stinger(): void {
    const s = this.q.stinger;
    s.classList.remove('go');
    void s.offsetWidth;
    s.classList.add('go');
  }

  title(small: string, big: string, sub: string, ms = 2600): void {
    const t = this.q.title;
    this.q.titleS.textContent = small;
    this.q.titleB.textContent = big;
    this.q.titleT.textContent = sub;
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
    if (ms > 0) setTimeout(() => t.classList.remove('show'), ms);
  }

  /** Broadcast lower third (the player stepping up). */
  lowerThird(color: string, big: string, small: string, ms = 2600): void {
    const t = this.el.querySelector('.gk-third') as HTMLElement;
    t.style.setProperty('--tc', color);
    (t.querySelector('b') as HTMLElement).textContent = big;
    (t.querySelector('span') as HTMLElement).textContent = small;
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
    clearTimeout(this.thirdTimer);
    this.thirdTimer = window.setTimeout(() => t.classList.remove('show'), ms);
  }

  private thirdTimer = 0;

  vignette(color: string, amount: number): void {
    const v = this.q.vignette;
    v.style.setProperty('--vc', color);
    v.style.opacity = String(amount);
  }

  private pop(el: HTMLElement): void {
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
  }

  remove(): void {
    clearTimeout(this.bannerTimer);
    clearTimeout(this.promptTimer);
    this.el.remove();
  }
}
