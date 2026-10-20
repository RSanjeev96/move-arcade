/** Race HUD: DOM overlay with change-detected updates (readable from 3 m on a TV). */
import { fmtClock } from '../../ui/kit';
import type { TrackData } from './track';

export interface TowerRow {
  pos: number;
  code: string;
  color: string;
  gap: string;
  human: boolean;
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
export { ordinal };

export class Hud {
  readonly el: HTMLElement;
  private q: Record<string, HTMLElement> = {};
  private last: Record<string, string> = {};
  private map: HTMLCanvasElement;
  private mapBg: HTMLCanvasElement;
  private mapXf: { s: number; ox: number; oz: number } = { s: 1, ox: 0, oz: 0 };
  private leds: HTMLElement[] = [];
  private bannerTimer = 0;
  private tipTimer = 0;

  constructor(
    parent: HTMLElement,
    private t: TrackData,
    kind: 'f1' | 'moto',
    tt: boolean,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'ghud rhud';
    this.el.innerHTML = `
      <div class="tl rh-left">
        <div class="rh-pos panel ${tt ? 'hidden' : ''}"><b>–</b><span>/8</span><em>POS</em></div>
        <div class="rh-lap panel"><em>LAP</em><b>1/3</b></div>
        <div class="rh-tower ${tt ? 'hidden' : ''}"></div>
      </div>
      <div class="tc rh-time panel">
        <div class="rh-cur">0:00.00</div>
        <div class="rh-sub"><span class="rh-best"><em>BEST</em> <b>–</b></span><span class="rh-delta"></span></div>
      </div>
      <div class="tr rh-right">
        <button class="rh-btn rh-pausebtn" data-hc aria-label="Pause">❚❚</button>
        <button class="rh-btn rh-cambtn" data-hc aria-label="Camera"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 7h11a2 2 0 0 1 2 2v1.5l4-2.5v8l-4-2.5V15a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" fill="currentColor"/></svg></button>
        <canvas class="rh-map" width="300" height="300"></canvas>
      </div>
      <div class="bc rh-cluster">
        <div class="rh-leds">${Array.from({ length: 15 }, () => '<i></i>').join('')}</div>
        <div class="rh-main">
          <div class="rh-gear"><b>N</b></div>
          <div class="rh-speed"><b>0</b><span>KM/H</span></div>
          <div class="rh-aux">
            ${
              kind === 'f1'
                ? '<div class="rh-boost"><div class="rh-bar"><i></i></div><span>BOOST</span></div>'
                : '<div class="rh-leanw"><svg viewBox="-60 -10 120 64"><path class="arc" d="M-50 50 A50 50 0 0 1 50 50"/><line class="needle" x1="0" y1="50" x2="0" y2="4"/><circle cx="0" cy="50" r="6" fill="#ffd166"/></svg><div class="rh-leanrow"><span class="rh-leanv">0°</span><span class="rh-tuck">TUCK</span></div></div>'
            }
          </div>
        </div>
      </div>
      <div class="rh-lights hidden">${Array.from({ length: 5 }, () => '<div class="pod"><i></i><i></i></div>').join('')}</div>
      <div class="rh-prompt hidden"><div class="rh-pi"></div><div class="rh-pt"></div></div>
      <div class="rh-banner hidden"><b></b><span></span></div>
      <div class="rh-tip hidden"></div>
      <div class="rh-flash"></div>
      <div class="rh-hint">Raise both hands above your head to pause</div>`;
    parent.appendChild(this.el);
    const q = (s: string) => this.el.querySelector(s) as HTMLElement;
    this.q = {
      pos: q('.rh-pos b'),
      posN: q('.rh-pos span'),
      lap: q('.rh-lap b'),
      tower: q('.rh-tower'),
      cur: q('.rh-cur'),
      best: q('.rh-best b'),
      delta: q('.rh-delta'),
      gear: q('.rh-gear b'),
      speed: q('.rh-speed b'),
      lights: q('.rh-lights'),
      prompt: q('.rh-prompt'),
      pi: q('.rh-pi'),
      pt: q('.rh-pt'),
      banner: q('.rh-banner'),
      bannerB: q('.rh-banner b'),
      bannerS: q('.rh-banner span'),
      tip: q('.rh-tip'),
      flash: q('.rh-flash'),
      cluster: q('.rh-cluster'),
    };
    if (kind === 'f1') {
      this.q.boostBar = q('.rh-boost i');
      this.q.boost = q('.rh-boost');
    } else {
      this.q.needle = q('.needle');
      this.q.leanV = q('.rh-leanv');
      this.q.tuck = q('.rh-tuck');
    }
    this.leds = Array.from(this.el.querySelectorAll('.rh-leds i')) as HTMLElement[];
    this.map = q('.rh-map') as HTMLCanvasElement;
    this.mapBg = document.createElement('canvas');
    this.mapBg.width = this.mapBg.height = 300;
    this.drawMapBg();
  }

  get pauseButton(): HTMLElement {
    return this.el.querySelector('.rh-pausebtn') as HTMLElement;
  }

  get cameraButton(): HTMLElement {
    return this.el.querySelector('.rh-cambtn') as HTMLElement;
  }

  private set(k: string, v: string, apply: (v: string) => void): void {
    if (this.last[k] === v) return;
    this.last[k] = v;
    apply(v);
  }

  private text(k: string, v: string): void {
    this.set(k, v, (x) => (this.q[k].textContent = x));
  }

  private drawMapBg(): void {
    const t = this.t;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < t.n; i++) {
      x0 = Math.min(x0, t.x[i]);
      x1 = Math.max(x1, t.x[i]);
      z0 = Math.min(z0, t.z[i]);
      z1 = Math.max(z1, t.z[i]);
    }
    const W = 300;
    const pad = 22;
    const s = (W - pad * 2) / Math.max(x1 - x0, z1 - z0);
    this.mapXf = { s, ox: pad + (W - pad * 2 - (x1 - x0) * s) / 2 - x0 * s, oz: pad + (W - pad * 2 - (z1 - z0) * s) / 2 - z0 * s };
    const g = this.mapBg.getContext('2d')!;
    g.clearRect(0, 0, W, W);
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const path = () => {
      g.beginPath();
      for (let i = 0; i <= t.n; i += 2) {
        const k = i % t.n;
        const x = t.x[k] * s + this.mapXf.ox;
        const y = t.z[k] * s + this.mapXf.oz;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
    };
    path();
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 16;
    g.stroke();
    path();
    g.strokeStyle = 'rgba(255,255,255,0.92)';
    g.lineWidth = 7;
    g.stroke();
    // Start line.
    const sx = t.x[0] * s + this.mapXf.ox;
    const sy = t.z[0] * s + this.mapXf.oz;
    g.save();
    g.translate(sx, sy);
    g.rotate(Math.atan2(t.tz[0], t.tx[0]));
    g.fillStyle = '#ff2d55';
    g.fillRect(-3, -9, 6, 18);
    g.restore();
  }

  drawMap(cars: { x: number; z: number; color: string; human: boolean; ghost?: boolean }[]): void {
    const g = this.map.getContext('2d')!;
    g.clearRect(0, 0, 300, 300);
    g.drawImage(this.mapBg, 0, 0);
    const { s, ox, oz } = this.mapXf;
    for (const c of [...cars].sort((a, b) => Number(a.human) - Number(b.human))) {
      const x = c.x * s + ox;
      const y = c.z * s + oz;
      g.beginPath();
      g.arc(x, y, c.human ? 11 : 8, 0, Math.PI * 2);
      g.fillStyle = c.ghost ? 'rgba(160,220,255,0.55)' : c.color;
      g.fill();
      g.lineWidth = c.human ? 4 : 2.5;
      g.strokeStyle = c.human ? '#ffffff' : 'rgba(0,0,0,0.75)';
      g.stroke();
    }
  }

  position(p: number, n: number): void {
    this.text('pos', `P${p}`);
    this.text('posN', `/${n}`);
  }

  lap(l: number, n: number): void {
    this.text('lap', `${Math.min(l, n)}/${n}`);
  }

  time(cur: number, best: number, delta: number | null): void {
    this.text('cur', fmtClock(Math.max(0, cur)));
    this.text('best', isFinite(best) ? fmtClock(best) : '–');
    const d = delta === null || !isFinite(delta) ? '' : `${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}`;
    this.set('delta', d, (v) => {
      this.q.delta.textContent = v;
      this.q.delta.className = `rh-delta ${delta !== null && delta < 0 ? 'good' : 'bad'}`;
    });
  }

  speed(kmh: number, gear: number, rpmFrac: number): void {
    this.text('speed', String(Math.round(kmh)));
    this.text('gear', gear <= 0 ? 'N' : String(gear));
    const lit = Math.round(Math.max(0, (rpmFrac - 0.55) / 0.43) * 15);
    this.set('leds', String(lit), () => {
      this.leds.forEach((l, i) => {
        const on = i < lit;
        l.className = on ? (lit >= 15 ? 'blue' : i < 5 ? 'g' : i < 10 ? 'r' : 'b') : '';
      });
    });
  }

  boost(frac: number, active: boolean): void {
    if (!this.q.boostBar) return;
    this.set('boostW', (frac * 100).toFixed(0), (v) => (this.q.boostBar.style.width = `${v}%`));
    const st = active ? 'active' : frac >= 1 ? 'ready' : '';
    this.set('boostS', st, (v) => (this.q.boost.className = `rh-boost ${v}`));
  }

  lean(deg: number, tuck: boolean): void {
    if (!this.q.needle) return;
    this.set('lean', deg.toFixed(0), (v) => {
      this.q.needle.setAttribute('transform', `rotate(${Number(v) * 1.5} 0 50)`);
      this.q.leanV.textContent = `${Math.abs(Number(v))}°`;
    });
    this.set('tuck', tuck ? '1' : '0', (v) => this.q.tuck.classList.toggle('on', v === '1'));
  }

  tower(rows: TowerRow[]): void {
    const key = rows.map((r) => `${r.code}${r.gap}`).join('|');
    this.set('tower', key, () => {
      this.q.tower.innerHTML = rows
        .map((r) => `<div class="row ${r.human ? 'me' : ''}"><b>${r.pos}</b><i style="background:${r.color}"></i><span>${r.code}</span><em>${r.gap}</em></div>`)
        .join('');
    });
  }

  /** Start lights: lit = 0..5, out = all off (go). */
  lights(lit: number, visible: boolean): void {
    this.set('lights', `${visible}${lit}`, () => {
      this.q.lights.classList.toggle('hidden', !visible);
      this.q.lights.querySelectorAll('.pod').forEach((p, i) => p.classList.toggle('on', i < lit));
    });
  }

  prompt(kind: '' | 'wheel' | 'wrong' | 'rider', text = ''): void {
    this.set('prompt', kind + text, () => {
      this.q.prompt.classList.toggle('hidden', !kind);
      this.q.prompt.className = `rh-prompt ${kind ? '' : 'hidden'} ${kind}`;
      this.q.pt.textContent = text;
      this.q.pi.innerHTML =
        kind === 'wheel'
          ? '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="38" fill="none" stroke="currentColor" stroke-width="9"/><path d="M14 52 h72 M50 52 v34" stroke="currentColor" stroke-width="9" fill="none"/><circle cx="50" cy="52" r="9" fill="currentColor"/></svg>'
          : kind === 'wrong'
            ? '<svg viewBox="0 0 100 100"><path d="M50 8 L94 88 H6 Z" fill="currentColor"/><path d="M50 36 v26 M50 72 v6" stroke="#000" stroke-width="9" stroke-linecap="round"/></svg>'
            : kind === 'rider'
              ? '<svg viewBox="0 0 100 100"><circle cx="50" cy="20" r="12" fill="currentColor"/><path d="M50 34 L50 66 M30 46 L70 46 M50 66 L36 92 M50 66 L64 92" stroke="currentColor" stroke-width="9" stroke-linecap="round"/></svg>'
              : '';
    });
  }

  banner(title: string, sub = '', ms = 2500, tone = ''): void {
    clearTimeout(this.bannerTimer);
    this.q.bannerB.textContent = title;
    this.q.bannerS.textContent = sub;
    this.q.banner.className = `rh-banner show ${tone}`;
    if (ms > 0) this.bannerTimer = window.setTimeout(() => this.q.banner.classList.remove('show'), ms);
  }

  hideBanner(): void {
    this.q.banner.classList.remove('show');
  }

  tip(text: string, ms = 4000): void {
    clearTimeout(this.tipTimer);
    this.q.tip.innerHTML = text;
    this.q.tip.className = 'rh-tip show';
    if (ms > 0) this.tipTimer = window.setTimeout(() => this.q.tip.classList.remove('show'), ms);
  }

  flash(color: string): void {
    const f = this.q.flash;
    f.style.background = color;
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
    window.setTimeout(() => {
      f.classList.remove('go');
      f.style.background = 'transparent';
    }, 600);
  }

  setVisible(v: boolean): void {
    this.el.classList.toggle('faded', !v);
  }

  dispose(): void {
    clearTimeout(this.bannerTimer);
    clearTimeout(this.tipTimer);
    this.el.remove();
  }
}
