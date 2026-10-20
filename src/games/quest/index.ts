/** Sky Quest: a first-person floating-island platformer. Menu, level select, play sessions and results. */
import './style.css';
import { local } from '../../core/storage';
import { bests, choiceRow, bindChoices, esc, fmtClock, html, loading, mount, showResults, topbar } from '../../ui/kit';
import type { GameEnv } from '../types';
import { loadAssets, type QuestAssets } from './assets';
import { QuestGame, type QuestResult } from './game';
import { DIFFICULTIES, LEVEL_INFO, buildLevel, type Difficulty, type ThemeId } from './levels';

interface Prefs extends Record<string, string> {
  level: string;
  difficulty: Difficulty;
}

interface Progress {
  stars: number;
  time: number;
  coins: number;
  gems: number;
}

const PROGRESS_KEY = 'ma.quest.progress';

function progress(): Record<string, Progress> {
  return local.getRaw<Record<string, Progress>>(PROGRESS_KEY, {});
}

function saveProgress(r: QuestResult): boolean {
  const all = progress();
  const k = `${r.level}:${r.difficulty}`;
  const cur = all[k];
  const better = !cur || r.stars.n > cur.stars || r.time < cur.time;
  all[k] = {
    stars: Math.max(cur?.stars ?? 0, r.stars.n),
    time: Math.min(cur?.time ?? Infinity, r.time),
    coins: Math.max(cur?.coins ?? 0, r.coins),
    gems: Math.max(cur?.gems ?? 0, r.gems),
  };
  local.set(PROGRESS_KEY, all);
  return better;
}

/** Best stars for a level on any difficulty (for unlocking and the level cards). */
function bestFor(level: number, d?: Difficulty): Progress | null {
  const all = progress();
  const list = (d ? [d] : DIFFICULTIES).map((x) => all[`${level}:${x}`]).filter(Boolean) as Progress[];
  if (!list.length) return null;
  return list.reduce((a, b) => (b.stars > a.stars || (b.stars === a.stars && b.time < a.time) ? b : a));
}

const unlocked = (level: number, demo: boolean) => demo || level === 1 || !!bestFor(level - 1);

export default async function open(env: GameEnv): Promise<void> {
  const prefs: Prefs = local.get('ma.quest', { level: '1', difficulty: 'normal' as Difficulty });
  const pd = env.params.get('difficulty') as Difficulty | null;
  if (pd && DIFFICULTIES.includes(pd)) prefs.difficulty = pd;
  const pl = Number(env.params.get('level'));
  if (pl >= 1 && pl <= 3) prefs.level = String(pl);
  let autoplay = env.params.get('autoplay') === '1';
  const startCp = env.params.has('cp') ? Number(env.params.get('cp')) : undefined;

  for (;;) {
    if (!autoplay) {
      const choice = await menu(env, prefs);
      if (!choice) return;
    }
    autoplay = false;
    const assets = await loadWithScreen(env);
    if (!assets) return;
    let level = Number(prefs.level);
    for (;;) {
      const data = buildLevel(level, prefs.difficulty);
      const game = new QuestGame(
        { root: mountHost(env), pose: env.pose, body: env.body, audio: env.audio, settings: env.settings, demo: env.demo, cursor: env.cursor },
        assets,
        data,
        { startCp, musicVolume: env.settings.musicVolume },
      );
      const out = await game.run();
      if (out.kind === 'restart') continue;
      if (out.kind === 'quit') break;
      const act = await results(env, out.result);
      if (act === 'again') continue;
      if (act === 'next' && level < 3) {
        level++;
        prefs.level = String(level);
        local.set('ma.quest', prefs);
        continue;
      }
      if (act === 'home') return;
      break;
    }
  }
}

function mountHost(env: GameEnv): HTMLElement {
  return mount(env.root, html('<div class="screen game quest-host"></div>'));
}

async function loadWithScreen(env: GameEnv): Promise<QuestAssets | null> {
  const set = loading(env.root, 'Loading Sky Quest…');
  try {
    const base = import.meta.env.BASE_URL + 'assets/quest/music/';
    return await loadAssets(
      (k) => set(`Loading Sky Quest… ${Math.round(k * 100)}%`),
      (name) => env.audio.load(`${base}${name}.mp3`),
    );
  } catch (e) {
    set(`Could not load the game: ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 2500));
    return null;
  }
}

// ---- menu --------------------------------------------------------------------------------------------------

const ART: Record<ThemeId, { sky: [string, string, string]; isle: string; dirt: string; extra: string }> = {
  meadow: {
    sky: ['#3d8cf5', '#7cc4ff', '#d8f2ff'],
    isle: '#5fd36b',
    dirt: '#b8703f',
    extra: `<circle cx="248" cy="38" r="16" fill="#fff6c8" opacity="0.95"/><circle cx="248" cy="38" r="26" fill="#fff6c8" opacity="0.25"/>`,
  },
  falls: {
    sky: ['#2a6fd6', '#5fb8f0', '#d8f6f2'],
    isle: '#3fcf8a',
    dirt: '#9a6c4a',
    extra: `<rect x="196" y="92" width="10" height="70" fill="#dff8ff" opacity="0.85"/><rect x="66" y="112" width="7" height="50" fill="#dff8ff" opacity="0.75"/>`,
  },
  sunset: {
    sky: ['#2c3a8c', '#c46aa8', '#ffb070'],
    isle: '#b9c06a',
    dirt: '#8f5f5a',
    extra: `<circle cx="70" cy="98" r="22" fill="#ffd27a" opacity="0.9"/><g fill="#5a3f6e"><rect x="210" y="40" width="16" height="50"/><polygon points="206,42 218,20 230,42"/><rect x="236" y="56" width="12" height="34"/><polygon points="233,58 242,40 251,58"/></g>`,
  },
};

function levelArt(theme: ThemeId, id: number): string {
  const a = ART[theme];
  const isle = (x: number, y: number, w: number, s = 1) => `
    <g transform="translate(${x} ${y}) scale(${s})">
      <polygon points="${-w / 2},8 ${w / 2},8 ${w / 4},34 0,48 ${-w / 4},30" fill="${a.dirt}" opacity="0.95"/>
      <rect x="${-w / 2}" y="0" width="${w}" height="12" rx="5" fill="${a.isle}"/>
      <rect x="${-w / 2}" y="9" width="${w}" height="4" fill="#000" opacity="0.12"/>
    </g>`;
  return `
    <svg viewBox="0 0 300 160" preserveAspectRatio="xMidYMid slice" class="q-art">
      <defs><linearGradient id="sk${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a.sky[0]}"/><stop offset="0.55" stop-color="${a.sky[1]}"/><stop offset="1" stop-color="${a.sky[2]}"/></linearGradient></defs>
      <rect width="300" height="160" fill="url(#sk${id})"/>
      ${a.extra}
      <g fill="#fff" opacity="0.85"><ellipse cx="60" cy="40" rx="28" ry="9"/><ellipse cx="78" cy="34" rx="18" ry="10"/><ellipse cx="180" cy="60" rx="24" ry="7"/><ellipse cx="196" cy="55" rx="14" ry="8"/></g>
      ${isle(70, 110, 70, 0.9)}${isle(230, 92, 60, 0.8)}${isle(150, 128, 110, 1.1)}
      <g fill="#2f8f4e"><circle cx="128" cy="118" r="9"/><rect x="126" y="120" width="4" height="9" fill="#8a5a36"/><circle cx="238" cy="84" r="7"/></g>
      <g fill="#ffd34d" stroke="#e0a400" stroke-width="1.5"><circle cx="150" cy="96" r="5"/><circle cx="166" cy="90" r="5"/><circle cx="182" cy="96" r="5"/></g>
      <rect x="100" y="70" width="18" height="18" rx="3" fill="#a24dff" stroke="#ffd34d" stroke-width="2.5"/><path d="M109 73 L111 79 L117 79 L111 81 L109 87 L107 81 L101 79 L107 79Z" fill="#fff"/>
    </svg>`;
}

const HOW: [string, string, string][] = [
  ['🏃', 'Run on the spot', 'to move forward (or auto-run on Easy)'],
  ['↔', 'Lean left / right', 'to change lanes'],
  ['⤴', 'Hop', 'for gaps and steps. Jump high, or hop twice, for a big jump'],
  ['👊', 'Punch', 'to shoot at critters, crates and star blocks'],
  ['⬇', 'Duck', 'under logs. Raise both hands to pause'],
];

function menu(env: GameEnv, prefs: Prefs): Promise<boolean> {
  const stars = (n: number) => [0, 1, 2].map((i) => `<i class="${i < n ? 'on' : ''}">★</i>`).join('');
  const el = html(`
    <div class="screen game-menu quest-menu">
      ${topbar('Sky Quest')}
      <div class="menu-body">
        <div class="q-left">
          <div class="q-levels">
            ${LEVEL_INFO.map((l) => {
              const open = unlocked(l.id, env.demo);
              const best = bestFor(l.id);
              return `
              <button class="q-lv ${open ? '' : 'locked'}" data-hc data-level="${l.id}" ${open ? '' : 'disabled'}>
                ${levelArt(l.theme, l.id)}
                <div class="q-lv-info">
                  <small>Level ${l.id}</small>
                  <b>${esc(l.name)}</b>
                  <div class="q-lv-stars">${stars(best?.stars ?? 0)}</div>
                  <em>${open ? (best ? `Best ${fmtClock(best.time).slice(0, -3)}` : esc(l.tagline)) : `Clear level ${l.id - 1} to unlock`}</em>
                </div>
              </button>`;
            }).join('')}
          </div>
          <div class="how glass">
            <h3>How to play</h3>
            <ul class="q-how">${HOW.map(([i, a, b]) => `<li><span>${i}</span><div><b>${a}</b> ${b}</div></li>`).join('')}</ul>
          </div>
        </div>
        <div class="side glass">
          ${choiceRow('difficulty', 'Difficulty', [
            { value: 'easy', label: 'Easy', hint: 'Auto-run, wider paths, slower critters' },
            { value: 'normal', label: 'Normal' },
            { value: 'hard', label: 'Hard' },
          ])}
          <div class="q-diff-note"></div>
          <div class="q-sel"></div>
          <button class="btn primary big" data-hc data-act="play">▶ Play</button>
          <div class="note">Stand 2–3 m back with your whole body in view. Clear space around you before jumping.</div>
        </div>
      </div>
    </div>`);
  const NOTE: Record<Difficulty, string> = {
    easy: 'Auto-run is on, paths are wider and critters slower. You can never run out of hearts.',
    normal: 'Run on the spot to set your speed. Three hearts: falls and hits cost one.',
    hard: 'Faster, more critters, fewer guides and less forgiving jumps.',
  };
  const refresh = () => {
    el.querySelectorAll<HTMLElement>('[data-level]').forEach((b) => b.classList.toggle('on', b.dataset.level === prefs.level));
    (el.querySelector('.q-diff-note') as HTMLElement).textContent = NOTE[prefs.difficulty];
    const lv = Number(prefs.level);
    const info = LEVEL_INFO[lv - 1];
    const b = bestFor(lv, prefs.difficulty);
    const best = bests.get(`quest:${lv}:${prefs.difficulty}`);
    (el.querySelector('.q-sel') as HTMLElement).innerHTML = `
      <div class="q-sel-name">Level ${lv} · ${esc(info.name)}</div>
      <div class="q-sel-stars">${stars(b?.stars ?? 0)}</div>
      <div class="q-sel-best">${b ? `Best time <b>${fmtClock(b.time).slice(0, -3)}</b> · coins <b>${b.coins}</b> · gems <b>${b.gems}/3</b>${best ? ` · score <b>${best.score.toLocaleString()}</b>` : ''}` : 'Not cleared yet on this difficulty'}</div>`;
    local.set('ma.quest', prefs);
  };
  mount(env.root, el);
  env.cursor(true);
  bindChoices(el, prefs, refresh);
  if (!unlocked(Number(prefs.level), env.demo)) prefs.level = '1';
  refresh();
  return new Promise((resolve) => {
    el.querySelectorAll<HTMLElement>('[data-level]').forEach((b) =>
      b.addEventListener('click', () => {
        if (!unlocked(Number(b.dataset.level), env.demo)) return;
        prefs.level = b.dataset.level!;
        refresh();
        env.audio.select();
      }),
    );
    el.querySelector('[data-act=play]')!.addEventListener('click', () => {
      env.audio.select();
      resolve(true);
    });
    el.querySelector('[data-act=back]')!.addEventListener('click', () => resolve(false));
  });
}

// ---- results --------------------------------------------------------------------------------------------------

async function results(env: GameEnv, r: QuestResult): Promise<string> {
  const isBest = r.cleared && bests.submit(`quest:${r.level}:${r.difficulty}`, { score: r.score, stars: r.stars.n, extra: fmtClock(r.time) });
  if (r.cleared) saveProgress(r);
  (window as unknown as { __lastResult?: QuestResult }).__lastResult = r;
  env.cursor(true);
  const rank = !r.cleared ? '—' : r.stars.n === 3 ? 'S' : r.stars.n === 2 ? 'A' : r.stars.n === 1 ? 'B' : 'C';
  const actions: { act: string; label: string; icon?: 'replay' | 'home' | 'play' | 'mountain' }[] = [];
  if (r.cleared && r.level < 3) actions.push({ act: 'next', label: 'Next level', icon: 'play' });
  actions.push({ act: 'again', label: r.cleared ? 'Play again' : 'Try again', icon: 'replay' });
  actions.push({ act: 'levels', label: 'Levels', icon: 'mountain' });
  actions.push({ act: 'home', label: 'Home', icon: 'home' });
  const p = showResults(env.root, {
    title: `Level ${r.level} · ${r.name}`,
    subtitle: `${r.difficulty} · ${r.cleared ? 'Cleared' : 'Out of hearts'}`,
    badge: rank,
    badgeTone: !r.cleared ? 'red' : r.stars.n === 3 ? 'blue' : 'gold',
    stars: r.stars.n,
    score: r.score.toLocaleString(),
    newBest: isBest,
    stats: [
      { label: `Time (par ${fmtClock(r.par).slice(0, -3)})`, value: fmtClock(r.time).slice(0, -3) },
      { label: 'Coins', value: `${r.coins} / ${r.coinTotal}` },
      { label: 'Star gems', value: `${r.gems} / ${r.gemTotal}` },
      { label: 'Critters defeated', value: String(r.enemies) },
      { label: 'Hearts left', value: '♥'.repeat(Math.max(0, r.hearts)) || '0' },
      { label: 'Falls', value: String(r.falls) },
    ],
    actions,
  });
  env.root.querySelector('.results')?.classList.add('quest-results');
  return p;
}
