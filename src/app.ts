import { AudioEngine } from './core/audio';
import { BodyTracker, type Body } from './core/body';
import { HandCursor } from './core/cursor';
import { CameraPose, SimPose, SIM_REST } from './core/pose';
import { loadSettings, saveSettings, type Settings } from './core/settings';
import { drawSkeleton } from './core/skeleton';
import type { PoseSource } from './core/types';
import { GAMES, type GameEntry } from './games/registry';
import type { GameEnv } from './games/types';
import { ICONS } from './icons';

type Cleanup = () => void;

const html = (s: string): HTMLElement => {
  const t = document.createElement('template');
  t.innerHTML = s.trim();
  return t.content.firstElementChild as HTMLElement;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class App {
  private settings: Settings = loadSettings();
  private audio = AudioEngine.get();
  private body = new BodyTracker();
  private pose: PoseSource | null = null;
  private cursor: HandCursor;
  private screenCleanup: Cleanup | null = null;
  private demo = false;
  private wakeLock: { release(): Promise<void> } | null = null;

  private params = new URLSearchParams(location.search);

  constructor(private root: HTMLElement) {
    this.cursor = new HandCursor(() => this.latestBody(), this.audio);
    const params = new URLSearchParams(location.search);
    if (params.has('demo')) {
      const mode = params.get('demo');
      void this.startDemo(mode === 'play' || mode === 'menu' ? (params.get('game') ?? 'blade') : null, mode === 'play');
    } else {
      this.showStart();
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.pose) void this.keepAwake();
    });
  }

  private latestBody(): Body | null {
    if (!this.pose) return null;
    return this.body.measure(this.pose.latest());
  }

  private mount(el: HTMLElement, cleanup?: Cleanup): void {
    this.screenCleanup?.();
    this.root.replaceChildren(el);
    this.screenCleanup = cleanup ?? null;
  }

  private async keepAwake(): Promise<void> {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } };
      await this.wakeLock?.release().catch(() => {});
      this.wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
    } catch {
      /* not supported */
    }
  }

  /** Full screen needs a fresh tap; after the camera prompt, go full screen on the next touch anywhere. */
  private fullscreenOnNextTap(): void {
    if (document.fullscreenElement || matchMedia('(display-mode: fullscreen)').matches) return;
    const go = () => void this.goFullscreen();
    document.addEventListener('pointerdown', go, { once: true, capture: true });
    void this.goFullscreen();
  }

  private async goFullscreen(): Promise<void> {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      await o.lock?.('landscape');
    } catch {
      /* optional */
    }
  }

  // ---- start ------------------------------------------------------------------------

  private showStart(error?: string): void {
    const el = html(`
      <div class="screen start">
        <div class="orbs"><i></i><i></i><i></i></div>
        <div class="logo big"><span>MOVE</span><b>ARCADE</b></div>
        <p class="tag">Your body is the controller</p>
        <button class="btn primary big" id="go">Start</button>
        <button class="btn ghost" id="demo">Watch a demo (no camera)</button>
        <div class="status ${error ? 'err' : ''}">${error ? esc(error) : ''}</div>
        <div class="tips">
          <span>${ICONS.tablet} Tablet in landscape, below the TV</span>
          <span>${ICONS.person} Stand 2–3 m back</span>
          <span>${ICONS.sun} Light in front of you, not behind</span>
        </div>
      </div>`);
    const status = el.querySelector('.status') as HTMLElement;
    el.querySelector('#go')!.addEventListener('click', async () => {
      status.classList.remove('err');
      await this.audio.unlock();
      // Ask for the camera BEFORE going full screen: Android blocks permission prompts while Chrome's
      // "to exit full screen…" notice (or any other overlay) is showing.
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      try {
        this.pose?.stop();
        this.pose = await CameraPose.create({
          model: this.settings.model,
          delayMs: this.settings.trackDelay,
          onStatus: (s) => (status.textContent = s),
        });
        this.demo = false;
        void this.keepAwake();
        this.fullscreenOnNextTap();
        this.showCalibrate();
      } catch (e) {
        const name = e instanceof DOMException ? e.name : '';
        const msg =
          name === 'NotAllowedError'
            ? 'The camera was blocked. Close any floating bubbles or screen filters (chat heads, screen recorder, blue-light filter), then tap the icon left of the address bar → Permissions → Camera → Allow, and tap Start again.'
            : name === 'NotReadableError'
              ? 'Another app is using the camera. Close it and tap Start again.'
              : `Could not start: ${(e as Error).message}`;
        status.textContent = msg;
        status.classList.add('err');
      }
    });
    el.querySelector('#demo')!.addEventListener('click', () => void this.startDemo(null));
    this.mount(el);
  }

  private async startDemo(openGame: string | null, autoplay = true): Promise<void> {
    await this.audio.unlock().catch(() => {});
    this.pose?.stop();
    const sim = new SimPose();
    sim.drive = () => SIM_REST;
    this.pose = sim;
    this.demo = true;
    this.body.calibrate(sim.latest());
    const game = openGame ? GAMES.find((g) => g.id === openGame) : undefined;
    if (game) {
      const params = new URLSearchParams(location.search);
      if (autoplay) params.set('autoplay', '1');
      return this.openGame(game, params);
    }
    this.showHome();
  }

  /** Hand the screen to a game module until it says it is done. */
  private async openGame(entry: GameEntry, params = new URLSearchParams(location.search)): Promise<void> {
    if (!this.pose) return this.showStart();
    const host = html('<div class="game-host"></div>');
    this.mount(host);
    const setText = (t: string) => (host.innerHTML = `<div class="screen loading"><div class="spinner"></div><div class="load-text">${esc(t)}</div></div>`);
    setText(`Loading ${entry.name}…`);
    try {
      const mod = await entry.load();
      const env: GameEnv = {
        root: host,
        pose: this.pose,
        body: this.body,
        audio: this.audio,
        settings: this.settings,
        demo: this.demo,
        params,
        cursor: (on) => this.cursor.setEnabled(on),
      };
      await mod.default(env);
    } catch (e) {
      console.error(e);
      setText(`Something went wrong: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 2500));
    }
    this.audio.stopSong();
    this.showHome();
  }

  // ---- calibration -------------------------------------------------------------------

  private showCalibrate(): void {
    const el = html(`
      <div class="screen calib">
        <canvas class="calib-cam"></canvas>
        <div class="calib-panel glass">
          <h2>Let's find you</h2>
          <ul class="checks">
            <li data-k="upper">Upper body and hands in view</li>
            <li data-k="hips">Hips in view</li>
            <li data-k="centre">Standing in the middle</li>
            <li data-k="dist">Good distance</li>
          </ul>
          <div class="calib-cta">When all four are green, <b>raise both hands</b> above your head</div>
          <div class="bar"><i></i></div>
          <div class="calib-row">
            <button class="btn" data-hc id="cont" disabled>Continue</button>
            <button class="btn ghost" id="back">Back</button>
          </div>
        </div>
      </div>`);
    const canvas = el.querySelector('canvas') as HTMLCanvasElement;
    const g = canvas.getContext('2d')!;
    const bar = el.querySelector('.bar i') as HTMLElement;
    const cont = el.querySelector('#cont') as HTMLButtonElement;
    const cta = el.querySelector('.calib-cta') as HTMLElement;
    let raf = 0;
    let upSince = 0;
    let done = false;
    const finish = () => {
      if (done || !this.pose) return;
      if (!this.body.calibrate(this.pose.latest())) return;
      done = true;
      this.audio.select();
      this.showHome();
    };
    cont.addEventListener('click', finish);
    el.querySelector('#back')!.addEventListener('click', () => this.showStart());
    this.cursor.setEnabled(true);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!this.pose) return;
      const w = (canvas.width = canvas.clientWidth * Math.min(devicePixelRatio, 1.5));
      const h = (canvas.height = canvas.clientHeight * Math.min(devicePixelRatio, 1.5));
      const f = this.pose.latest();
      drawSkeleton(g, this.pose.video, f, w, h, { dim: 0.25 });
      const b = this.body.measure(f);
      const upper = b.ok && b.lWristV > 0.5 && b.rWristV > 0.5;
      const hips = b.ok && b.hips;
      const centre = b.ok && Math.abs(b.cx / b.w - 0.5) < 0.16;
      const swFrac = b.ok ? b.scale / b.w : 0;
      const dist = b.ok && swFrac > 0.06 && swFrac < 0.22;
      const set = (k: string, ok: boolean, msg?: string) => {
        const li = el.querySelector(`[data-k="${k}"]`) as HTMLElement;
        li.classList.toggle('ok', ok);
        if (msg !== undefined) li.dataset.msg = msg;
      };
      set('upper', upper);
      set('hips', hips);
      set('centre', centre, centre || !b.ok ? '' : b.cx / b.w < 0.5 ? 'move right' : 'move left');
      set('dist', dist, dist || !b.ok ? '' : swFrac >= 0.22 ? 'step back' : 'come closer');
      const allOk = upper && hips && centre && dist;
      cont.disabled = !hips;
      cta.classList.toggle('ready', allOk);
      const handsUp = b.ok && b.lWrist.y > b.nose.y + 0.2 && b.rWrist.y > b.nose.y + 0.2;
      if (allOk && handsUp) {
        if (!upSince) upSince = performance.now();
        const k = Math.min(1, (performance.now() - upSince) / 1000);
        bar.style.width = `${k * 100}%`;
        if (k >= 1) finish();
      } else {
        upSince = 0;
        bar.style.width = '0%';
      }
    };
    loop();
    this.mount(el, () => cancelAnimationFrame(raf));
  }

  // ---- home ----------------------------------------------------------------------------

  private topbar(back?: string, title?: string): string {
    return `
      <header class="topbar">
        ${back ? `<button class="btn sm" data-hc data-go="${back}">${ICONS.back} Back</button>` : `<div class="logo sm"><span>MOVE</span><b>ARCADE</b></div>`}
        ${title ? `<div class="top-title">${title}</div>` : ''}
        <div class="spacer"></div>
        <div class="track-status"><i></i><span>${this.demo ? 'Demo mode' : 'Tracking'}</span></div>
        ${back ? '' : `<button class="btn sm" data-hc data-go="calibrate">${ICONS.person} Recalibrate</button><button class="btn sm" data-hc data-go="settings">${ICONS.gear} Settings</button>`}
      </header>`;
  }

  private wireNav(el: HTMLElement): void {
    el.querySelectorAll<HTMLElement>('[data-go]').forEach((b) =>
      b.addEventListener('click', () => {
        const go = b.dataset.go!;
        if (go === 'home') this.showHome();
        else if (go === 'calibrate') this.demo ? this.showHome() : this.showCalibrate();
        else if (go === 'settings') this.showSettings();
        else {
          const g = GAMES.find((x) => x.id === go);
          if (g) void this.openGame(g);
        }
      }),
    );
  }

  private trackStatus(el: HTMLElement): Cleanup {
    const span = el.querySelector('.track-status span') as HTMLElement | null;
    const dot = el.querySelector('.track-status i') as HTMLElement | null;
    const t = setInterval(() => {
      if (!this.pose || !span || !dot) return;
      const f = this.pose.latest();
      const seen = !!f.lm && performance.now() - f.t < 600;
      dot.classList.toggle('ok', seen);
      span.textContent = this.demo ? 'Demo mode' : seen ? `Tracking · ${Math.round(this.pose.fps)} fps` : 'Looking for you…';
    }, 500);
    return () => clearInterval(t);
  }

  private showHome(): void {
    const games = GAMES.map((g) => ({ ...g, live: g.ready || this.params.has('all') }));
    const el = html(`
      <div class="screen home">
        ${this.topbar()}
        <h1 class="greet">Pick a game</h1>
        <div class="tiles">
          ${games
            .map(
              (g) => `
            <button class="tile ${g.cls} ${g.live ? '' : 'locked'}" ${g.live ? `data-hc data-go="${g.id}"` : 'disabled'}>
              <div class="tile-art">${g.icon}</div>
              <div class="tile-name">${g.name}</div>
              <div class="tile-desc">${g.desc}</div>
              <span class="tile-tag">${g.live ? g.tag : 'Coming soon'}</span>
            </button>`,
            )
            .join('')}
        </div>
        <div class="hint">${ICONS.hand} Raise a hand to point, then hold still on a button to press it</div>
      </div>`);
    this.wireNav(el);
    this.cursor.setEnabled(true);
    this.mount(el, this.trackStatus(el));
  }

  // ---- settings ----------------------------------------------------------------------------

  private showSettings(): void {
    const s = this.settings;
    const el = html(`
      <div class="screen settings">
        ${this.topbar('home', 'Settings')}
        <div class="set-grid">
          ${this.segRow('quality', 'Graphics', [
            ['auto', 'Auto'],
            ['high', 'High'],
            ['medium', 'Medium'],
            ['low', 'Low'],
          ])}
          ${this.segRow('model', 'Body tracking', [
            ['lite', 'Fast'],
            ['full', 'Accurate'],
          ])}
          ${this.segRow('showCamera', 'Camera preview in game', [
            ['true', 'On'],
            ['false', 'Off'],
          ])}
          ${this.stepRow('audioOffset', 'Audio delay (TV / speakers)', 'ms', 10)}
          ${this.stepRow('trackDelay', 'Camera delay', 'ms', 10)}
          ${this.stepRow('musicVolume', 'Music volume', '%', 0.1)}
          ${this.stepRow('sfxVolume', 'Effects volume', '%', 0.1)}
        </div>
        <p class="set-note">If slices feel late, raise <b>Camera delay</b>. If the music feels behind the blocks, raise <b>Audio delay</b>. Changing body tracking takes effect after you restart the app.</p>
      </div>`);
    const refresh = () => {
      el.querySelectorAll<HTMLElement>('[data-seg]').forEach((b) => {
        const key = b.dataset.seg as keyof Settings;
        b.classList.toggle('on', String(s[key]) === b.dataset.val);
      });
      el.querySelectorAll<HTMLElement>('[data-val-of]').forEach((v) => {
        const key = v.dataset.valOf as keyof Settings;
        const n = s[key] as number;
        v.textContent = v.dataset.unit === '%' ? `${Math.round(n * 100)}%` : `${n} ms`;
      });
    };
    el.querySelectorAll<HTMLElement>('[data-seg]').forEach((b) =>
      b.addEventListener('click', () => {
        const key = b.dataset.seg as keyof Settings;
        const v = b.dataset.val!;
        (s as unknown as Record<string, unknown>)[key] = v === 'true' ? true : v === 'false' ? false : v;
        saveSettings(s);
        refresh();
      }),
    );
    el.querySelectorAll<HTMLElement>('[data-step]').forEach((b) =>
      b.addEventListener('click', () => {
        const key = b.dataset.step as keyof Settings;
        const d = Number(b.dataset.d);
        const cur = s[key] as number;
        let next = Math.round((cur + d) * 100) / 100;
        if (key === 'musicVolume' || key === 'sfxVolume') next = Math.max(0, Math.min(1, next));
        else next = Math.max(key === 'audioOffset' ? -200 : 0, Math.min(400, next));
        (s as unknown as Record<string, number>)[key] = next;
        saveSettings(s);
        refresh();
      }),
    );
    refresh();
    this.wireNav(el);
    this.cursor.setEnabled(true);
    this.mount(el, this.trackStatus(el));
  }

  private segRow(key: string, label: string, opts: [string, string][]): string {
    return `<div class="set-row"><div class="set-label">${label}</div><div class="seg">${opts
      .map(([v, t]) => `<button class="btn sm" data-hc data-seg="${key}" data-val="${v}">${t}</button>`)
      .join('')}</div></div>`;
  }

  private stepRow(key: string, label: string, unit: string, step: number): string {
    return `<div class="set-row"><div class="set-label">${label}</div><div class="stepper">
      <button class="btn sm" data-hc data-step="${key}" data-d="${-step}">−</button>
      <b data-val-of="${key}" data-unit="${unit}"></b>
      <button class="btn sm" data-hc data-step="${key}" data-d="${step}">+</button></div></div>`;
  }
}
