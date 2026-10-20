import { AudioEngine } from './core/audio';
import { BodyTracker, type Body } from './core/body';
import { HandCursor } from './core/cursor';
import { CameraPose, SimPose, SIM_REST } from './core/pose';
import { loadSettings, saveSettings, type Settings } from './core/settings';
import { drawSkeleton } from './core/skeleton';
import { local } from './core/storage';
import type { PoseSource } from './core/types';
import { BladeGame, type BladeResult } from './games/blade/blade';
import { DIFFICULTIES, generateMap, type Difficulty } from './games/blade/mapgen';
import { addDeviceSong, fmtTime, listSongs, loadSong, removeDeviceSong, type LoadedSong, type SongInfo } from './games/blade/songs';
import { ICONS } from './icons';

type Cleanup = () => void;

interface BladePrefs {
  songId: string | null;
  difficulty: Difficulty;
  walls: boolean;
  noFail: boolean;
}

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
  private bladePrefs: BladePrefs = local.get('ma.blade', { songId: null, difficulty: 'normal' as Difficulty, walls: true, noFail: true });

  constructor(private root: HTMLElement) {
    this.cursor = new HandCursor(() => this.latestBody(), this.audio);
    const params = new URLSearchParams(location.search);
    if (params.has('demo')) {
      void this.startDemo(params.get('demo') === 'play');
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
      void this.goFullscreen();
      void this.keepAwake();
      try {
        this.pose?.stop();
        this.pose = await CameraPose.create({
          model: this.settings.model,
          delayMs: this.settings.trackDelay,
          onStatus: (s) => (status.textContent = s),
        });
        this.demo = false;
        this.showCalibrate();
      } catch (e) {
        const msg =
          e instanceof DOMException && e.name === 'NotAllowedError'
            ? 'Camera permission was blocked. Allow the camera for this site in Chrome settings, then tap Start again.'
            : `Could not start: ${(e as Error).message}`;
        status.textContent = msg;
        status.classList.add('err');
      }
    });
    el.querySelector('#demo')!.addEventListener('click', () => void this.startDemo(false));
    this.mount(el);
  }

  private async startDemo(autoplay: boolean): Promise<void> {
    await this.audio.unlock().catch(() => {});
    this.pose?.stop();
    const sim = new SimPose();
    sim.drive = () => SIM_REST;
    this.pose = sim;
    this.demo = true;
    this.body.calibrate(sim.latest());
    if (autoplay) {
      const songs = await listSongs();
      const song = songs.find((s) => s.source === 'bundled');
      if (song) {
        this.bladePrefs.songId = song.id;
        const d = new URLSearchParams(location.search).get('difficulty') as Difficulty | null;
        if (d && DIFFICULTIES.includes(d)) this.bladePrefs.difficulty = d;
        return this.playBlade(song);
      }
    }
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
        else if (go === 'blade') void this.showBladeSelect();
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
    const games = [
      { id: 'blade', name: 'Blade Beat', desc: 'Slice blocks to the music', tag: 'Rhythm', icon: ICONS.blade, live: true, cls: 't-blade' },
      { id: 'racer', name: 'Grand Prix', desc: 'Steer an F1 car with your hands', tag: 'Racing', icon: ICONS.wheel, live: false, cls: 't-racer' },
      { id: 'goalie', name: 'Goalkeeper', desc: 'Dive and save penalties', tag: 'Sports', icon: ICONS.glove, live: false, cls: 't-goalie' },
      { id: 'bat', name: 'Big Hitter', desc: 'Cricket and baseball batting', tag: 'Sports', icon: ICONS.bat, live: false, cls: 't-bat' },
      { id: 'tennis', name: 'Centre Court', desc: 'Swing and rally', tag: 'Sports', icon: ICONS.racket, live: false, cls: 't-tennis' },
      { id: 'fit', name: 'Dance Fit', desc: 'Workouts with a weekly plan', tag: 'Fitness', icon: ICONS.fit, live: false, cls: 't-fit' },
      { id: 'quest', name: 'Sky Quest', desc: 'First-person jump adventure', tag: 'Adventure', icon: ICONS.mountain, live: false, cls: 't-quest' },
    ];
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

  // ---- blade: song select ------------------------------------------------------------------

  private async showBladeSelect(): Promise<void> {
    const prefs = this.bladePrefs;
    const songs = await listSongs();
    if (!prefs.songId || !songs.some((s) => s.id === prefs.songId)) prefs.songId = songs[0]?.id ?? null;
    const best = local.getRaw<Record<string, { score: number; rank: string; stars: number }>>('ma.best', {});
    const el = html(`
      <div class="screen bsel">
        ${this.topbar('home', 'Blade Beat')}
        <div class="bsel-body">
          <div class="songs">
            ${songs.length ? '' : '<div class="empty">No songs yet. Add one from your tablet →</div>'}
            ${songs
              .map(
                (s) => `
              <button class="song ${s.id === prefs.songId ? 'on' : ''}" data-hc data-song="${s.id}" style="--c1:${s.colors[0]};--c2:${s.colors[1]}">
                <div class="song-art">${ICONS.note}</div>
                <div class="song-meta"><b>${esc(s.title)}</b><span>${esc(s.artist)}${s.bpm ? ` · ${Math.round(s.bpm)} BPM` : ''}${s.duration ? ` · ${fmtTime(s.duration)}` : ''}</span></div>
                ${s.source === 'device' ? `<span class="song-del" data-del="${s.id}" title="Remove">✕</span>` : ''}
              </button>`,
              )
              .join('')}
          </div>
          <div class="side glass">
            <div class="diffs">${DIFFICULTIES.map((d) => `<button class="btn sm ${d === prefs.difficulty ? 'on' : ''}" data-hc data-diff="${d}">${d}</button>`).join('')}</div>
            <div class="toggles">
              <button class="btn sm toggle" data-hc data-tog="walls">Walls to dodge</button>
              <button class="btn sm toggle" data-hc data-tog="noFail">No-fail mode</button>
            </div>
            <div class="best"></div>
            <button class="btn primary big" data-hc id="play">${ICONS.play} Play</button>
            <label class="btn ghost add">${ICONS.plus} Add a song from this tablet<input type="file" accept="audio/*" hidden></label>
            <div class="note">Songs you add stay on this tablet only.</div>
          </div>
        </div>
      </div>`);
    const refresh = () => {
      el.querySelectorAll<HTMLElement>('[data-song]').forEach((b) => b.classList.toggle('on', b.dataset.song === prefs.songId));
      el.querySelectorAll<HTMLElement>('[data-diff]').forEach((b) => b.classList.toggle('on', b.dataset.diff === prefs.difficulty));
      el.querySelectorAll<HTMLElement>('[data-tog]').forEach((b) => b.classList.toggle('on', !!prefs[b.dataset.tog as 'walls' | 'noFail']));
      const bb = best[`${prefs.songId}:${prefs.difficulty}`];
      (el.querySelector('.best') as HTMLElement).innerHTML = bb
        ? `Best: <b>${bb.score.toLocaleString()}</b> · ${bb.rank} · ${'★'.repeat(bb.stars)}${'☆'.repeat(3 - bb.stars)}`
        : 'No score yet on this level';
      (el.querySelector('#play') as HTMLButtonElement).disabled = !prefs.songId;
      local.set('ma.blade', prefs);
    };
    el.querySelectorAll<HTMLElement>('[data-song]').forEach((b) => b.addEventListener('click', () => ((prefs.songId = b.dataset.song!), refresh())));
    el.querySelectorAll<HTMLElement>('[data-diff]').forEach((b) =>
      b.addEventListener('click', () => ((prefs.difficulty = b.dataset.diff as Difficulty), refresh())),
    );
    el.querySelectorAll<HTMLElement>('[data-tog]').forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.tog as 'walls' | 'noFail';
        prefs[k] = !prefs[k];
        refresh();
      }),
    );
    el.querySelectorAll<HTMLElement>('[data-del]').forEach((x) =>
      x.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Remove this song from the tablet?')) return;
        await removeDeviceSong(x.dataset.del!);
        void this.showBladeSelect();
      }),
    );
    const input = el.querySelector('input[type=file]') as HTMLInputElement;
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return;
      const s = await addDeviceSong(f);
      prefs.songId = s.id;
      void this.showBladeSelect();
    });
    el.querySelector('#play')!.addEventListener('click', () => {
      const s = songs.find((x) => x.id === prefs.songId);
      if (s) void this.playBlade(s);
    });
    refresh();
    this.wireNav(el);
    this.cursor.setEnabled(true);
    this.mount(el, this.trackStatus(el));
  }

  private loading(text: string): { set(t: string): void; el: HTMLElement } {
    const el = html(`<div class="screen loading"><div class="spinner"></div><div class="load-text">${esc(text)}</div></div>`);
    this.mount(el);
    this.cursor.setEnabled(false);
    return { el, set: (t) => ((el.querySelector('.load-text') as HTMLElement).textContent = t) };
  }

  private async playBlade(info: SongInfo, preloaded?: LoadedSong): Promise<void> {
    const prefs = this.bladePrefs;
    const ld = this.loading('Loading…');
    let song: LoadedSong;
    try {
      song = preloaded ?? (await loadSong(info, (t) => ld.set(t)));
    } catch (e) {
      ld.set(`Could not load this song: ${(e as Error).message}`);
      setTimeout(() => void this.showBladeSelect(), 2500);
      return;
    }
    const map = generateMap(song.analysis, prefs.difficulty, { walls: prefs.walls });
    const host = html('<div class="screen game"></div>');
    this.mount(host);
    const game = new BladeGame(
      {
        root: host,
        pose: this.pose!,
        body: this.body,
        audio: this.audio,
        settings: this.settings,
        demo: this.demo,
        cursor: (on) => this.cursor.setEnabled(on),
      },
      song,
      map,
      { noFail: prefs.noFail, seek: Number(new URLSearchParams(location.search).get('seek')) || 0 },
    );
    const out = await game.run();
    if (out.kind === 'restart') return this.playBlade(info, song);
    if (out.kind === 'quit') return this.showBladeSelect();
    this.showBladeResults(out.result, info, song);
  }

  private showBladeResults(r: BladeResult, info: SongInfo, song: LoadedSong): void {
    const key = `${info.id}:${r.difficulty}`;
    const best = local.getRaw<Record<string, { score: number; rank: string; stars: number }>>('ma.best', {});
    const isBest = r.cleared && (!best[key] || r.score > best[key].score);
    if (isBest) {
      best[key] = { score: r.score, rank: r.rank, stars: r.stars };
      local.set('ma.best', best);
    }
    const el = html(`
      <div class="screen results">
        <div class="orbs"><i></i><i></i><i></i></div>
        <div class="res-card glass ${r.cleared ? '' : 'failed'}">
          <div class="res-head">
            <div class="res-rank r-${r.rank.toLowerCase()}">${r.rank}</div>
            <div>
              <div class="res-title">${esc(r.title)}</div>
              <div class="res-diff">${r.difficulty} · ${r.cleared ? 'Cleared' : 'Failed'}</div>
              <div class="res-stars">${[0, 1, 2].map((i) => `<span class="${i < r.stars ? 'on' : ''}">★</span>`).join('')}</div>
            </div>
          </div>
          <div class="res-score">${r.score.toLocaleString()}${isBest ? '<em>New best!</em>' : ''}</div>
          <div class="res-grid">
            <div><b>${(r.accuracy * 100).toFixed(1)}%</b><span>Accuracy</span></div>
            <div><b>${r.maxCombo}</b><span>Best combo</span></div>
            <div><b>${r.hits}/${r.notes}</b><span>Blocks cut</span></div>
            <div><b>${r.misses}</b><span>Missed</span></div>
            <div><b>${r.bad}</b><span>Wrong cuts</span></div>
            <div><b>${r.bombsHit}</b><span>Bombs hit</span></div>
          </div>
          <div class="actions">
            <button class="btn primary" data-hc data-act="again">${ICONS.replay} Play again</button>
            <button class="btn" data-hc data-act="songs">${ICONS.note} Songs</button>
            <button class="btn ghost" data-hc data-act="home">${ICONS.home} Home</button>
          </div>
        </div>
      </div>`);
    el.querySelector('[data-act=again]')!.addEventListener('click', () => void this.playBlade(info, song));
    el.querySelector('[data-act=songs]')!.addEventListener('click', () => void this.showBladeSelect());
    el.querySelector('[data-act=home]')!.addEventListener('click', () => this.showHome());
    this.cursor.setEnabled(true);
    this.mount(el);
    (window as unknown as { __lastResult?: BladeResult }).__lastResult = r;
  }
}
