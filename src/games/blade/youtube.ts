import { ICONS } from '../../icons';
import { local } from '../../core/storage';
import { esc, html, mount } from '../../ui/kit';
import type { GameEnv } from '../types';
import { YouTubePlayer, parseYouTubeId, tapTempo } from './clock';

export interface YouTubeSong {
  id: string;
  title: string;
  bpm: number;
  firstBeat: number;
}

const KEY = 'ma.blade.yt';

export function recentYouTube(): YouTubeSong[] {
  return local.getRaw<YouTubeSong[]>(KEY, []);
}

function remember(s: YouTubeSong): void {
  const list = recentYouTube().filter((x) => x.id !== s.id);
  list.unshift(s);
  local.set(KEY, list.slice(0, 12));
}

/** Fixed container for the YouTube player, so the iframe never moves in the DOM (moving it reloads the video). */
export function ytDock(): HTMLElement {
  let d = document.querySelector<HTMLElement>('.yt-dock');
  if (!d) {
    d = document.createElement('div');
    d.className = 'yt-dock';
    document.body.appendChild(d);
  }
  return d;
}

export function setDockMode(mode: 'hidden' | 'big' | 'corner'): void {
  ytDock().dataset.mode = mode;
}

/**
 * Pick a YouTube song and its tempo. Resolves with the player (kept alive for the game) and tempo,
 * or null if the player backs out.
 */
export async function chooseYouTube(env: GameEnv): Promise<{ yt: YouTubePlayer; song: YouTubeSong } | null> {
  for (;;) {
    const id = await pickVideo(env);
    if (!id) return null;
    setDockMode('big');
    let yt: YouTubePlayer;
    const status = mount(env.root, html(`<div class="screen loading"><div class="spinner"></div><div class="load-text">Opening YouTube…</div></div>`));
    try {
      ytDock().replaceChildren();
      yt = await YouTubePlayer.create(ytDock(), id);
    } catch (e) {
      (status.querySelector('.load-text') as HTMLElement).textContent = (e as Error).message;
      setDockMode('hidden');
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const saved = recentYouTube().find((s) => s.id === id);
    const tempo = await tapScreen(env, yt, saved);
    if (!tempo) {
      yt.destroy();
      setDockMode('hidden');
      continue;
    }
    const song: YouTubeSong = { id, title: yt.title || saved?.title || 'YouTube song', ...tempo };
    remember(song);
    return { yt, song };
  }
}

function pickVideo(env: GameEnv): Promise<string | null> {
  const recent = recentYouTube();
  const el = html(`
    <div class="screen yt-pick">
      <header class="topbar">
        <button class="btn sm" data-hc data-act="back">${ICONS.back} Back</button>
        <div class="top-title">Play a YouTube song</div>
      </header>
      <div class="yt-body">
        <div class="glass yt-form">
          <label class="set-label" for="yt-url">Paste a YouTube link</label>
          <div class="yt-row">
            <input id="yt-url" type="url" inputmode="url" placeholder="https://youtu.be/…" autocomplete="off" />
            <button class="btn sm" id="paste">Paste</button>
          </div>
          <div class="yt-msg"></div>
          <button class="btn primary big" id="go">${ICONS.play} Continue</button>
          <p class="note">The song plays in YouTube's own player in a corner of the screen, with your YouTube account's benefits (Premium means no ads). Nothing is downloaded. Some videos block playing inside other apps — if so, try another upload of the song.</p>
        </div>
        <div class="glass yt-recent">
          <div class="set-label">Recent</div>
          ${recent.length ? '' : '<div class="note">Songs you play will appear here.</div>'}
          ${recent
            .map((r) => `<button class="song" data-hc data-id="${r.id}" style="--c1:#ff2d2d;--c2:#8a3bff"><div class="song-art">${ICONS.play}</div><div class="song-meta"><b>${esc(r.title)}</b><span>${Math.round(r.bpm)} BPM</span></div></button>`)
            .join('')}
        </div>
      </div>
    </div>`);
  mount(env.root, el);
  env.cursor(true);
  const input = el.querySelector('#yt-url') as HTMLInputElement;
  const msg = el.querySelector('.yt-msg') as HTMLElement;
  return new Promise((resolve) => {
    el.querySelector('[data-act=back]')!.addEventListener('click', () => resolve(null));
    el.querySelectorAll<HTMLElement>('[data-id]').forEach((b) => b.addEventListener('click', () => resolve(b.dataset.id!)));
    el.querySelector('#paste')!.addEventListener('click', async () => {
      try {
        input.value = await navigator.clipboard.readText();
      } catch {
        msg.textContent = 'Could not read the clipboard — long-press the box and choose Paste.';
      }
    });
    el.querySelector('#go')!.addEventListener('click', () => {
      const id = parseYouTubeId(input.value);
      if (!id) {
        msg.textContent = 'That does not look like a YouTube link.';
        return;
      }
      resolve(id);
    });
  });
}

/** Tap along to the beat while the song plays; returns the tempo grid. */
function tapScreen(env: GameEnv, yt: YouTubePlayer, saved?: YouTubeSong): Promise<{ bpm: number; firstBeat: number } | null> {
  const el = html(`
    <div class="screen yt-tap">
      <header class="topbar">
        <button class="btn sm" data-hc data-act="back">${ICONS.back} Back</button>
        <div class="top-title">Find the beat</div>
      </header>
      <div class="yt-tap-body">
        <div class="yt-tap-side glass">
          <p>Tap the big button <b>on every beat</b> of the song, at least 8 times. Keep going for a steadier result.</p>
          <button class="tap-pad" id="tap"><b>TAP</b><span>0 taps</span></button>
          <div class="tap-bpm"><button class="btn sm" data-d="-1">−</button><b>– BPM</b><button class="btn sm" data-d="1">+</button></div>
          <div class="calib-row">
            <button class="btn sm" id="reset">Start over</button>
            ${saved ? `<button class="btn sm" data-hc id="saved">Use saved (${Math.round(saved.bpm)} BPM)</button>` : ''}
          </div>
          <button class="btn primary big" data-hc id="start" disabled>${ICONS.play} Start game</button>
        </div>
      </div>
    </div>`);
  mount(env.root, el);
  env.cursor(true);
  yt.seek(0);
  yt.play();
  const taps: number[] = [];
  let tempo: { bpm: number; firstBeat: number } | null = null;
  const pad = el.querySelector('#tap') as HTMLButtonElement;
  const count = pad.querySelector('span') as HTMLElement;
  const bpmEl = el.querySelector('.tap-bpm b') as HTMLElement;
  const start = el.querySelector('#start') as HTMLButtonElement;
  const show = () => {
    count.textContent = `${taps.length} taps`;
    bpmEl.textContent = tempo ? `${tempo.bpm.toFixed(1)} BPM` : '– BPM';
    start.disabled = !tempo;
  };
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    taps.push(yt.mediaTimeAt(performance.now()));
    if (taps.length > 32) taps.shift();
    tempo = tapTempo(taps);
    env.audio.hover();
    pad.classList.remove('hit');
    void pad.offsetWidth;
    pad.classList.add('hit');
    show();
  });
  el.querySelectorAll<HTMLElement>('[data-d]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!tempo) return;
      tempo = { ...tempo, bpm: Math.max(60, Math.min(200, Math.round(tempo.bpm + Number(b.dataset.d)))) };
      show();
    }),
  );
  el.querySelector('#reset')!.addEventListener('click', () => {
    taps.length = 0;
    tempo = null;
    show();
  });
  return new Promise((resolve) => {
    el.querySelector('[data-act=back]')!.addEventListener('click', () => {
      yt.pause();
      resolve(null);
    });
    el.querySelector('#saved')?.addEventListener('click', () => {
      yt.pause();
      resolve({ bpm: saved!.bpm, firstBeat: saved!.firstBeat });
    });
    start.addEventListener('click', () => {
      yt.pause();
      resolve(tempo);
    });
  });
}
