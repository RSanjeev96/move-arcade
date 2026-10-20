import { ICONS } from '../../icons';
import { local } from '../../core/storage';
import { bests, esc, html, loading, mount, showResults, topbar } from '../../ui/kit';
import type { GameEnv } from '../types';
import { BladeGame, type BladeResult } from './blade';
import { BufferClock, YouTubeClock, gridAnalysis, type SongClock } from './clock';
import { chooseYouTube, setDockMode } from './youtube';
import type { Analysis } from '../../core/beat';
import { DIFFICULTIES, generateMap, type Difficulty } from './mapgen';
import { addDeviceSong, fmtTime, listSongs, loadSong, removeDeviceSong, type LoadedSong, type SongInfo } from './songs';

interface BladePrefs {
  songId: string | null;
  difficulty: Difficulty;
  walls: boolean;
  noFail: boolean;
}

export default async function open(env: GameEnv): Promise<void> {
  const prefs: BladePrefs = local.get('ma.blade', { songId: null, difficulty: 'normal' as Difficulty, walls: true, noFail: true });
  const d = env.params.get('difficulty') as Difficulty | null;
  if (d && DIFFICULTIES.includes(d)) prefs.difficulty = d;
  let autoplay = env.params.get('autoplay') === '1';

  for (;;) {
    let song: SongInfo | 'youtube' | null;
    if (autoplay) {
      const songs = await listSongs();
      song = songs.find((s) => s.source === 'bundled') ?? songs[0] ?? null;
      autoplay = false;
    } else {
      song = await selectSong(env, prefs);
    }
    if (!song) return;
    if (song === 'youtube') {
      if ((await youtubeSession(env, prefs)) === 'home') return;
      continue;
    }
    let loaded: LoadedSong | undefined;
    for (;;) {
      const out = await play(env, prefs, song, loaded);
      if (!out) break;
      loaded = out.song;
      if (out.again) continue;
      const act = await results(env, out.result, song);
      if (act === 'again') continue;
      if (act === 'home') return;
      break;
    }
  }
}

async function selectSong(env: GameEnv, prefs: BladePrefs): Promise<SongInfo | 'youtube' | null> {
  const songs = await listSongs();
  if (!prefs.songId || !songs.some((s) => s.id === prefs.songId)) prefs.songId = songs[0]?.id ?? null;
  const el = html(`
    <div class="screen bsel">
      ${topbar('Blade Beat')}
      <div class="bsel-body">
        <div class="songs">
          ${songs.length ? '' : '<div class="empty">No songs yet. Add one from your tablet →</div>'}
          ${songs
            .map(
              (s) => `
            <button class="song" data-hc data-song="${s.id}" style="--c1:${s.colors[0]};--c2:${s.colors[1]}">
              <div class="song-art">${ICONS.note}</div>
              <div class="song-meta"><b>${esc(s.title)}</b><span>${esc(s.artist)}${s.bpm ? ` · ${Math.round(s.bpm)} BPM` : ''}${s.duration ? ` · ${fmtTime(s.duration)}` : ''}</span></div>
              ${s.source === 'device' ? `<span class="song-del" data-del="${s.id}" title="Remove">✕</span>` : ''}
            </button>`,
            )
            .join('')}
        </div>
        <div class="side glass">
          <div class="diffs">${DIFFICULTIES.map((dd) => `<button class="btn sm" data-hc data-diff="${dd}">${dd}</button>`).join('')}</div>
          <div class="toggles">
            <button class="btn sm toggle" data-hc data-tog="walls">Walls to dodge</button>
            <button class="btn sm toggle" data-hc data-tog="noFail">No-fail mode</button>
          </div>
          <div class="best"></div>
          <button class="btn primary big" data-hc id="play">${ICONS.play} Play</button>
          <div class="add-row">
            <label class="btn ghost add">${ICONS.plus} Song from this tablet<input type="file" accept="audio/*" hidden></label>
            <button class="btn ghost" data-hc id="yt">${ICONS.play} YouTube song</button>
          </div>
          <div class="note">Songs you add stay on this tablet only.</div>
        </div>
      </div>
    </div>`);
  const refresh = () => {
    el.querySelectorAll<HTMLElement>('[data-song]').forEach((b) => b.classList.toggle('on', b.dataset.song === prefs.songId));
    el.querySelectorAll<HTMLElement>('[data-diff]').forEach((b) => b.classList.toggle('on', b.dataset.diff === prefs.difficulty));
    el.querySelectorAll<HTMLElement>('[data-tog]').forEach((b) => b.classList.toggle('on', !!prefs[b.dataset.tog as 'walls' | 'noFail']));
    const bb = bests.get(`${prefs.songId}:${prefs.difficulty}`);
    (el.querySelector('.best') as HTMLElement).innerHTML = bb
      ? `Best: <b>${bb.score.toLocaleString()}</b> · ${bb.rank ?? ''} · ${'★'.repeat(bb.stars ?? 0)}${'☆'.repeat(3 - (bb.stars ?? 0))}`
      : 'No score yet on this level';
    (el.querySelector('#play') as HTMLButtonElement).disabled = !prefs.songId;
    local.set('ma.blade', prefs);
  };
  mount(env.root, el);
  env.cursor(true);
  refresh();
  return new Promise((resolve) => {
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
        resolve(selectSong(env, prefs));
      }),
    );
    const input = el.querySelector('input[type=file]') as HTMLInputElement;
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return;
      const s = await addDeviceSong(f);
      prefs.songId = s.id;
      resolve(selectSong(env, prefs));
    });
    el.querySelector('#play')!.addEventListener('click', () => resolve(songs.find((x) => x.id === prefs.songId) ?? null));
    el.querySelector('#yt')!.addEventListener('click', () => resolve('youtube'));
    el.querySelector('[data-act=back]')!.addEventListener('click', () => resolve(null));
  });
}

/** Play YouTube songs until the player goes back. Returns 'home' to leave the game entirely. */
async function youtubeSession(env: GameEnv, prefs: BladePrefs): Promise<'songs' | 'home'> {
  const picked = await chooseYouTube(env);
  if (!picked) return 'songs';
  const { yt, song } = picked;
  const info: SongInfo = { id: `yt-${song.id}`, title: song.title, artist: 'YouTube', source: 'youtube', colors: ['#ff2d2d', '#8a3bff'], bpm: song.bpm };
  const analysis = gridAnalysis(song.bpm, song.firstBeat, yt.duration || 240);
  try {
    for (;;) {
      yt.setVolume(env.settings.musicVolume);
      setDockMode('corner');
      const out = await runGame(env, prefs, info, analysis, new YouTubeClock(yt, env.settings.audioOffset));
      setDockMode('hidden');
      if (out.kind === 'restart') continue;
      if (out.kind === 'quit') return 'songs';
      const act = await results(env, out.result, info);
      if (act === 'again') continue;
      return act === 'home' ? 'home' : 'songs';
    }
  } finally {
    yt.destroy();
    setDockMode('hidden');
  }
}

async function runGame(env: GameEnv, prefs: BladePrefs, info: SongInfo, analysis: Analysis, clock: SongClock) {
  env.cursor(false);
  const map = generateMap(analysis, prefs.difficulty, { walls: prefs.walls });
  const host = mount(env.root, html('<div class="screen game"></div>'));
  const game = new BladeGame(
    { root: host, pose: env.pose, body: env.body, audio: env.audio, settings: env.settings, demo: env.demo, cursor: env.cursor },
    { info, analysis },
    clock,
    map,
    { noFail: prefs.noFail, seek: Number(env.params.get('seek')) || 0 },
  );
  return game.run();
}

async function play(
  env: GameEnv,
  prefs: BladePrefs,
  info: SongInfo,
  preloaded?: LoadedSong,
): Promise<{ song: LoadedSong; result: BladeResult; again: boolean } | null> {
  env.cursor(false);
  const set = loading(env.root, 'Loading…');
  let song: LoadedSong;
  try {
    song = preloaded ?? (await loadSong(info, set));
  } catch (e) {
    set(`Could not load this song: ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 2500));
    return null;
  }
  const out = await runGame(env, prefs, info, song.analysis, new BufferClock(env.audio, song.buffer));
  if (out.kind === 'restart') return play(env, prefs, info, song);
  if (out.kind === 'quit') return null;
  return { song, result: out.result, again: false };
}

async function results(env: GameEnv, r: BladeResult, info: SongInfo): Promise<string> {
  const isBest = r.cleared && bests.submit(`${info.id}:${r.difficulty}`, { score: r.score, rank: r.rank, stars: r.stars });
  (window as unknown as { __lastResult?: BladeResult }).__lastResult = r;
  env.cursor(true);
  return showResults(env.root, {
    title: r.title,
    subtitle: `${r.difficulty} · ${r.cleared ? 'Cleared' : 'Failed'}`,
    badge: r.rank,
    badgeTone: r.rank === 'SS' || r.rank === 'S' ? 'blue' : r.rank === 'F' ? 'red' : 'gold',
    stars: r.stars,
    score: r.score.toLocaleString(),
    newBest: isBest,
    stats: [
      { label: 'Accuracy', value: `${(r.accuracy * 100).toFixed(1)}%` },
      { label: 'Best combo', value: String(r.maxCombo) },
      { label: 'Blocks cut', value: `${r.hits}/${r.notes}` },
      { label: 'Missed', value: String(r.misses) },
      { label: 'Wrong cuts', value: String(r.bad) },
      { label: 'Bombs hit', value: String(r.bombsHit) },
    ],
    actions: [
      { act: 'again', label: 'Play again', icon: 'replay' },
      { act: 'songs', label: 'Songs', icon: 'note' },
      { act: 'home', label: 'Home', icon: 'home' },
    ],
  });
}
