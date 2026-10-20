/** Big Hitter HUD: TV-style scorebug, result banner, timing meter, ball info, distance tag, tutorial. */
import { esc } from '../../ui/kit';
import type { BaseballGame, CricketMatch } from './rules';
import { TOLERANCE, WINDOWS, type Timing } from './contact';
import type { Difficulty } from './delivery';

export type Tone = 'six' | 'four' | 'out' | 'runs' | 'dot' | 'call' | 'hr' | 'good';

const MODE_NAME: Record<string, string> = { chase: 'Chase', sixes: 'Six Hitting', derby: 'Home Run Derby', inning: 'Inning' };

export class Hud {
  readonly el: HTMLElement;
  private q: Record<string, HTMLElement> = {};
  private last: Record<string, string> = {};
  private bannerTimer = 0;
  private timingTimer = 0;
  private infoTimer = 0;
  private hintTimer = 0;

  constructor(parent: HTMLElement, mode: string, difficulty: Difficulty, sport: 'cricket' | 'baseball') {
    this.el = document.createElement('div');
    this.el.className = 'ghud bat-hud';
    this.el.innerHTML = `
      <button class="bat-pause" data-hc aria-label="Pause"><i></i><i></i></button>
      <div class="bat-mode tr"><b>${esc(MODE_NAME[mode] ?? mode)}</b><span>${esc(difficulty)}</span><em class="bat-pausehint">Raise both hands to pause</em><i class="bat-pausebar"><s></s></i></div>
      <div class="bat-info tc"></div>
      <div class="bat-banner"><b></b><span></span></div>
      <div class="bat-timing">
        <div class="bat-tlabel"></div>
        <div class="bat-meter"><i class="z e1"></i><i class="z g1"></i><i class="z p"></i><i class="z g2"></i><i class="z e2"></i><s></s></div>
        <div class="bat-tends"><span>Early</span><span>Late</span></div>
      </div>
      <div class="bat-dist"></div>
      <div class="bat-score ${sport}"></div>
      <div class="bat-hint"></div>
      <div class="bat-tut hidden">
        <div class="bat-tut-art">${tutorialArt(sport)}</div>
        <div class="bat-tut-text">
          <h3>${sport === 'cricket' ? 'Face the TV, bat in both hands' : 'Face the TV, bat in both hands'}</h3>
          <p><b>Hold the bat with both hands</b> at your back shoulder, then <b>swing across your body when the ball arrives.</b></p>
          <ul>
            <li>Swing <b>fast</b> for power, <b>on time</b> to hit it straight</li>
            <li>Early pulls it, late slices it the other way</li>
            <li>${sport === 'cricket' ? 'Swing <b>low</b> for full balls, <b>high</b> for bouncers' : 'Swing <b>at the height</b> the ball crosses the plate'}</li>
            <li>${sport === 'cricket' ? "Don't swing to <b>leave</b> it — but guard your stumps" : "Don't swing at pitches outside the zone"}</li>
          </ul>
        </div>
      </div>`;
    parent.appendChild(this.el);
    for (const k of ['pause', 'mode', 'info', 'banner', 'timing', 'tlabel', 'meter', 'dist', 'score', 'hint', 'tut', 'pausebar']) {
      this.q[k] = this.el.querySelector(`.bat-${k}`) as HTMLElement;
    }
    // Scale the timing meter zones to the difficulty windows.
    const k = TOLERANCE[difficulty];
    const span = WINDOWS.edge * k * 2;
    const w = (ms: number) => `${((ms * k) / span) * 100}%`;
    const z = this.q.meter.querySelectorAll<HTMLElement>('.z');
    z[0].style.width = w(WINDOWS.edge - WINDOWS.good);
    z[1].style.width = w(WINDOWS.good - WINDOWS.perfect);
    z[2].style.width = w(WINDOWS.perfect * 2);
    z[3].style.width = w(WINDOWS.good - WINDOWS.perfect);
    z[4].style.width = w(WINDOWS.edge - WINDOWS.good);
    this.meterSpan = span;
  }

  private meterSpan = 440;

  get pauseButton(): HTMLElement {
    return this.q.pause;
  }

  private set(k: string, html: string): void {
    if (this.last[k] === html) return;
    this.last[k] = html;
    this.q[k].innerHTML = html;
  }

  banner(big: string, sub = '', tone: Tone = 'runs', ms = 2200): void {
    const b = this.q.banner;
    clearTimeout(this.bannerTimer);
    (b.firstElementChild as HTMLElement).textContent = big;
    (b.lastElementChild as HTMLElement).textContent = sub;
    b.className = `bat-banner tone-${tone}`;
    void b.offsetWidth;
    b.classList.add('show');
    if (ms > 0) this.bannerTimer = window.setTimeout(() => b.classList.remove('show'), ms);
  }

  hideBanner(): void {
    this.q.banner.classList.remove('show');
  }

  /** Timing feedback; ms = swing − arrival (negative early), or null for "no swing". */
  timing(t: Timing | 'miss', ms: number | null, text?: string): void {
    const el = this.q.timing;
    clearTimeout(this.timingTimer);
    const label = text ?? (t === 'perfect' ? 'Perfect timing' : t === 'early' ? 'Early' : t === 'late' ? 'Late' : 'Missed');
    this.q.tlabel.innerHTML = `<b class="t-${t}">${esc(label)}</b>${ms !== null && t !== 'perfect' ? `<span>${Math.abs(Math.round(ms))} ms</span>` : ''}`;
    const s = this.q.meter.querySelector('s') as HTMLElement;
    if (ms === null) s.style.opacity = '0';
    else {
      s.style.opacity = '1';
      const x = Math.max(0, Math.min(1, 0.5 + ms / this.meterSpan));
      s.style.left = `${x * 100}%`;
    }
    el.className = `bat-timing show t-${t}`;
    this.timingTimer = window.setTimeout(() => el.classList.remove('show'), 2400);
  }

  info(html: string, ms = 3200): void {
    clearTimeout(this.infoTimer);
    this.set('info', html);
    this.q.info.classList.add('show');
    if (ms > 0) this.infoTimer = window.setTimeout(() => this.q.info.classList.remove('show'), ms);
  }

  hint(text: string, ms = 0): void {
    clearTimeout(this.hintTimer);
    this.set('hint', text ? `<span>${text}</span>` : '');
    this.q.hint.classList.toggle('show', !!text);
    if (ms > 0 && text) this.hintTimer = window.setTimeout(() => this.q.hint.classList.remove('show'), ms);
  }

  tutorial(on: boolean): void {
    this.q.tut.classList.toggle('hidden', !on);
  }

  /** Floating distance readout at screen position (fractions), or hidden. */
  distance(text: string | null, x = 0.5, y = 0.5): void {
    const d = this.q.dist;
    if (!text) {
      d.classList.remove('show');
      return;
    }
    if (this.last.dist !== text) {
      this.last.dist = text;
      d.textContent = text;
    }
    d.classList.add('show');
    d.style.left = `${Math.max(6, Math.min(94, x * 100))}%`;
    d.style.top = `${Math.max(8, Math.min(80, y * 100))}%`;
  }

  pauseProgress(k: number): void {
    (this.q.pausebar.firstElementChild as HTMLElement).style.width = `${Math.round(k * 100)}%`;
    this.q.pausebar.classList.toggle('on', k > 0);
  }

  cricketScore(m: CricketMatch, overBalls: string[]): void {
    const over = overBalls
      .map((s) => `<i class="${s === 'W' ? 'w' : s === '6' ? 'six' : s === '4' ? 'four' : s === '•' ? 'dot' : 'run'}">${s === '•' ? '' : esc(s)}</i>`)
      .join('');
    const pad = Array.from({ length: Math.max(0, 6 - overBalls.length) }, () => '<i class="empty"></i>').join('');
    if (m.mode === 'chase') {
      const need = m.need;
      const left = m.ballsLeft;
      const status = m.runs >= m.target ? 'Target reached!' : left <= 0 || m.wickets >= m.maxWickets ? 'Innings over' : `Need <b>${need}</b> from <b>${left}</b> ball${left === 1 ? '' : 's'}`;
      this.set(
        'score',
        `<div class="sb-row"><span class="sb-team">BIG HITTERS</span><span class="sb-runs">${m.runs}<small>/${m.wickets}</small></span><span class="sb-ov">${m.overs}<small> ov</small></span></div>
         <div class="sb-row2"><span class="sb-need">${status}</span><span class="sb-tgt">Target ${m.target} · ${m.maxWickets - m.wickets} wkt${m.maxWickets - m.wickets === 1 ? '' : 's'} left</span></div>
         <div class="sb-over">${over}${pad}</div>`,
      );
    } else {
      this.set(
        'score',
        `<div class="sb-row"><span class="sb-team">SIX HITTING</span><span class="sb-runs">${m.sixes}<small> six${m.sixes === 1 ? '' : 'es'}</small></span><span class="sb-ov">${Math.round(m.sixDistance)}<small> m</small></span></div>
         <div class="sb-row2"><span class="sb-need"><b>${m.ballsLeft}</b> ball${m.ballsLeft === 1 ? '' : 's'} left</span><span class="sb-tgt">Longest ${Math.round(m.longest)} m</span></div>
         <div class="sb-over">${over}${pad}</div>`,
      );
    }
  }

  baseballScore(g: BaseballGame): void {
    const dots = (n: number, of: number, cls: string) => Array.from({ length: of }, (_, i) => `<i class="${i < n ? cls : ''}"></i>`).join('');
    const bases = `<div class="sb-diamond">${[1, 2, 0].map((b) => `<i class="b${b} ${g.bases[b] ? 'on' : ''}"></i>`).join('')}</div>`;
    if (g.mode === 'derby') {
      this.set(
        'score',
        `<div class="sb-row"><span class="sb-team">HR DERBY</span><span class="sb-runs">${g.hrs}<small> HR</small></span><span class="sb-ov">${g.maxOuts - g.outs}<small> outs left</small></span></div>
         <div class="sb-row2"><span class="sb-need">Longest <b>${Math.round(g.longest)} m</b></span><span class="sb-tgt">Swing and miss, or any non-homer, is an out</span></div>
         <div class="sb-count"><span>OUTS</span><span class="sb-dots out">${dots(g.outs, g.maxOuts, 'on')}</span></div>`,
      );
    } else {
      this.set(
        'score',
        `<div class="sb-row"><span class="sb-team">HOME</span><span class="sb-runs">${g.runs}<small> R</small></span><span class="sb-ov">${g.hits}<small> H</small></span>${bases}</div>
         <div class="sb-count"><span>B</span><span class="sb-dots ball">${dots(g.balls, 4, 'on')}</span><span>S</span><span class="sb-dots strike">${dots(g.strikes, 3, 'on')}</span><span>OUT</span><span class="sb-dots out">${dots(g.outs, 3, 'on')}</span></div>`,
      );
    }
  }

  destroy(): void {
    clearTimeout(this.bannerTimer);
    clearTimeout(this.timingTimer);
    clearTimeout(this.infoTimer);
    clearTimeout(this.hintTimer);
    this.el.remove();
  }
}

/** Animated SVG: a figure facing the viewer sweeping both hands across the body. */
export function tutorialArt(sport: 'cricket' | 'baseball'): string {
  const bat =
    sport === 'cricket'
      ? '<rect x="-5" y="0" width="10" height="16" rx="3" fill="#2a2f55"/><rect x="-9" y="15" width="18" height="44" rx="5" fill="#e8d3a2"/>'
      : '<path d="M-3 0 L3 0 L6 58 Q0 64 -6 58 Z" fill="#d2a46e"/><rect x="-3.5" y="2" width="7" height="14" fill="#222"/>';
  return `<svg viewBox="0 0 200 200" class="bat-tut-svg">
    <defs><linearGradient id="bt-g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#7df9ff"/><stop offset="1" stop-color="#b06bff"/></linearGradient></defs>
    <circle cx="100" cy="40" r="15" fill="none" stroke="url(#bt-g)" stroke-width="6"/>
    <path d="M100 56 L100 120 M100 120 L82 172 M100 120 L118 172 M78 70 L122 70" stroke="url(#bt-g)" stroke-width="7" stroke-linecap="round" fill="none"/>
    <g class="bt-arms">
      <path d="M78 70 L120 96 M122 70 L120 96" stroke="url(#bt-g)" stroke-width="7" stroke-linecap="round" fill="none"/>
      <g transform="translate(120 96)"><g class="bt-bat">${bat}</g></g>
      <circle cx="120" cy="96" r="7" fill="#ff2d6a"/>
    </g>
    <path class="bt-arrow" d="M150 150 Q100 175 50 150" stroke="#ffd23f" stroke-width="5" fill="none" stroke-linecap="round" marker-end="url(#bt-m)"/>
    <defs><marker id="bt-m" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="#ffd23f"/></marker></defs>
  </svg>`;
}
