import './style.css';
import { ICONS } from '../../icons';
import { local } from '../../core/storage';
import { bests, bindChoices, choiceRow, esc, html, loading, mount, showResults, topbar } from '../../ui/kit';
import type { GameEnv } from '../types';
import { DIFFICULTIES, type Difficulty } from './delivery';
import { BatSession, type Assets, type SessionStats } from './game';
import type { Sport } from './physics';
import type { Mode } from './rules';
import { BatSounds } from './sounds';

interface Prefs {
  sport: Sport;
  cricketMode: 'chase' | 'sixes';
  baseballMode: 'derby' | 'inning';
  difficulty: Difficulty;
  hand: 'right' | 'left';
  cricketTime: 'day' | 'night';
  baseballTime: 'day' | 'night';
  seen: boolean;
}

const MODES: Record<Sport, { id: Mode; name: string; desc: string }[]> = {
  cricket: [
    { id: 'chase', name: 'Super Over Chase', desc: 'Two overs, a target and only a couple of wickets. Find the gaps, clear the rope.' },
    { id: 'sixes', name: 'Six Hitting', desc: '12 balls. Only sixes count, every metre adds to your score.' },
  ],
  baseball: [
    { id: 'derby', name: 'Home Run Derby', desc: 'Ten outs. Anything that is not a home run is an out. How many can you launch?' },
    { id: 'inning', name: 'One Inning', desc: 'Balls, strikes and base runners. Score as many runs as you can before three outs.' },
  ],
};

const BASE = import.meta.env.BASE_URL;

export default async function open(env: GameEnv): Promise<void> {
  const prefs: Prefs = local.get('ma.bat', {
    sport: 'cricket' as Sport,
    cricketMode: 'chase' as const,
    baseballMode: 'derby' as const,
    difficulty: 'normal' as Difficulty,
    hand: 'right' as const,
    cricketTime: 'day' as const,
    baseballTime: 'night' as const,
    seen: false,
  });
  const p = env.params;
  const sp = p.get('sport');
  if (sp === 'cricket' || sp === 'baseball') prefs.sport = sp;
  const md = p.get('mode');
  if (md === 'chase' || md === 'sixes') {
    prefs.sport = 'cricket';
    prefs.cricketMode = md;
  }
  if (md === 'derby' || md === 'inning') {
    prefs.sport = 'baseball';
    prefs.baseballMode = md;
  }
  const df = p.get('difficulty') as Difficulty | null;
  if (df && DIFFICULTIES.includes(df)) prefs.difficulty = df;
  const hand = p.get('hand');
  if (hand === 'left' || hand === 'right') prefs.hand = hand;
  const tm = p.get('time');
  if (tm === 'day' || tm === 'night') {
    if (prefs.sport === 'cricket') prefs.cricketTime = tm;
    else prefs.baseballTime = tm;
  }
  let autoplay = p.get('autoplay') === '1';
  const pc = p.get('posecheck');
  if (pc) return (await import('./debugview')).poseCheck(env, pc);

  // Shared assets, loaded once when the game opens.
  const sounds = new BatSounds(env.audio);
  let sky: HTMLImageElement | null = null;
  const assetsReady = (async () => {
    const img = new Image();
    img.src = `${BASE}assets/bat/sky_day.jpg`;
    const imgOk = img.decode().then(
      () => (sky = img),
      () => null,
    );
    await Promise.all([imgOk, sounds.load()]);
  })();

  try {
    for (;;) {
      if (!autoplay) {
        const go = await menu(env, prefs);
        if (!go) return;
      }
      autoplay = false;
      for (;;) {
        const set = loading(env.root, 'Walking out to the middle…');
        await assetsReady;
        set('Setting the field…');
        await new Promise((r) => setTimeout(r, 30));
        const assets: Assets = { sky, sounds };
        const sport = prefs.sport;
        const mode = sport === 'cricket' ? prefs.cricketMode : prefs.baseballMode;
        const host = mount(env.root, html('<div class="screen game"></div>'));
        env.cursor(false);
        const session = new BatSession(
          { ...env, root: host },
          {
            sport,
            mode,
            difficulty: prefs.difficulty,
            handed: prefs.hand === 'left' ? -1 : 1,
            night: (sport === 'cricket' ? prefs.cricketTime : prefs.baseballTime) === 'night',
            tutorial: !prefs.seen || env.demo,
          },
          assets,
        );
        const out = await session.run();
        prefs.seen = true;
        local.set('ma.bat', prefs);
        if (out.kind === 'restart') continue;
        if (out.kind === 'quit') break;
        const act = await results(env, out.stats);
        if (act === 'again') continue;
        if (act === 'home') return;
        break;
      }
    }
  } finally {
    sounds.dispose();
  }
}

function bestKey(sport: Sport, mode: Mode, diff: Difficulty): string {
  return `bat:${sport}:${mode}:${diff}`;
}

function bestText(sport: Sport, mode: Mode, diff: Difficulty): string {
  const b = bests.get(bestKey(sport, mode, diff));
  if (!b) return 'No score yet on this level';
  const stars = `${'★'.repeat(b.stars ?? 0)}${'☆'.repeat(3 - (b.stars ?? 0))}`;
  return `Best: <b>${esc(b.extra ?? String(b.score))}</b> · ${stars}`;
}

async function menu(env: GameEnv, prefs: Prefs): Promise<boolean> {
  const el = html(`
    <div class="screen game-menu bat-menu">
      ${topbar('Big Hitter')}
      <div class="menu-body">
        <div class="bat-left">
          <div class="bat-sports">
            <button class="bat-sport cricket" data-hc data-sport="cricket">
              <span class="bat-sport-art">${cricketArt()}</span>
              <b>Cricket</b><span>T20 stadium · pace, swing and spin</span>
            </button>
            <button class="bat-sport baseball" data-hc data-sport="baseball">
              <span class="bat-sport-art">${baseballArt()}</span>
              <b>Baseball</b><span>Ballpark under the lights</span>
            </button>
          </div>
          <div class="bat-modes"></div>
          <div class="how glass">
            <h3>How to play</h3>
            <ul>
              <li><b>Stand facing the TV</b>, 2–3 m back, hands together as if holding a bat at your back shoulder.</li>
              <li><b>Swing across your body</b> when the ball arrives — the on-screen bat follows your hands.</li>
              <li><b>Timing</b> aims the shot: early pulls it, late slices it, on time goes straight and far. <b>Speed</b> is power.</li>
              <li><b>Height</b> matters: swing under the ball to loft it, over it to keep it down. Don't swing to leave it.</li>
              <li>Raise <b>both hands</b> above your head to pause.</li>
            </ul>
          </div>
        </div>
        <div class="side glass">
          ${choiceRow('difficulty', 'Difficulty', [
            { value: 'easy', label: 'Easy' },
            { value: 'normal', label: 'Normal' },
            { value: 'hard', label: 'Hard' },
          ])}
          ${choiceRow('time', 'Match time', [
            { value: 'day', label: 'Day' },
            { value: 'night', label: 'Floodlights' },
          ])}
          ${choiceRow('hand', 'You bat', [
            { value: 'right', label: 'Right-handed' },
            { value: 'left', label: 'Left-handed' },
          ])}
          <div class="best"></div>
          <button class="btn primary big" data-hc id="bat-play">${ICONS.play} Play</button>
          <div class="note">Tip: a big, fast sweep through the ball is a big hit. Watch the bowler's arm.</div>
        </div>
      </div>
    </div>`);
  el.style.setProperty('--hero-c', `url(${BASE}assets/bat/menu_cricket.jpg)`);
  el.style.setProperty('--hero-b', `url(${BASE}assets/bat/menu_baseball.jpg)`);
  mount(env.root, el);
  env.cursor(true);
  const state = {
    difficulty: prefs.difficulty as string,
    hand: prefs.hand as string,
    time: (prefs.sport === 'cricket' ? prefs.cricketTime : prefs.baseballTime) as string,
  };
  const modesEl = el.querySelector('.bat-modes') as HTMLElement;
  const bestEl = el.querySelector('.best') as HTMLElement;
  const refresh = () => {
    prefs.difficulty = state.difficulty as Difficulty;
    prefs.hand = state.hand as 'right' | 'left';
    if (prefs.sport === 'cricket') prefs.cricketTime = state.time as 'day' | 'night';
    else prefs.baseballTime = state.time as 'day' | 'night';
    el.querySelectorAll<HTMLElement>('[data-sport]').forEach((b) => b.classList.toggle('on', b.dataset.sport === prefs.sport));
    el.dataset.sport = prefs.sport;
    const cur = prefs.sport === 'cricket' ? prefs.cricketMode : prefs.baseballMode;
    modesEl.innerHTML = MODES[prefs.sport]
      .map((m) => `<button class="bat-modecard ${m.id === cur ? 'on' : ''}" data-hc data-mode="${m.id}"><b>${esc(m.name)}</b><span>${esc(m.desc)}</span></button>`)
      .join('');
    modesEl.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) =>
      b.addEventListener('click', () => {
        if (prefs.sport === 'cricket') prefs.cricketMode = b.dataset.mode as 'chase' | 'sixes';
        else prefs.baseballMode = b.dataset.mode as 'derby' | 'inning';
        env.audio.select();
        refresh();
      }),
    );
    bestEl.innerHTML = bestText(prefs.sport, cur, prefs.difficulty);
    local.set('ma.bat', prefs);
  };
  bindChoices(el, state, refresh);
  refresh();
  return new Promise((resolve) => {
    el.querySelectorAll<HTMLElement>('[data-sport]').forEach((b) =>
      b.addEventListener('click', () => {
        prefs.sport = b.dataset.sport as Sport;
        state.time = prefs.sport === 'cricket' ? prefs.cricketTime : prefs.baseballTime;
        bindChoicesRefresh(el, state);
        env.audio.select();
        refresh();
      }),
    );
    el.querySelector('#bat-play')!.addEventListener('click', () => {
      env.audio.select();
      resolve(true);
    });
    el.querySelector('[data-act=back]')!.addEventListener('click', () => resolve(false));
  });
}

/** Re-highlight choice buttons after state changed in code. */
function bindChoicesRefresh(el: HTMLElement, state: Record<string, string>): void {
  el.querySelectorAll<HTMLElement>('[data-choice]').forEach((b) => b.classList.toggle('on', state[b.dataset.choice!] === b.dataset.val));
}

async function results(env: GameEnv, s: SessionStats): Promise<string> {
  env.cursor(true);
  const diff = s.difficulty;
  const key = bestKey(s.sport, s.mode, diff);
  (window as unknown as { __lastResult?: unknown }).__lastResult = { sport: s.sport, mode: s.mode, longest: s.longest };
  if (s.cricket) {
    const m = s.cricket;
    const stars = m.stars();
    if (m.mode === 'chase') {
      const won = m.won;
      const lostBy = m.target - 1 - m.runs;
      const isBest = bests.submit(key, { score: m.score(), stars, extra: `${m.runs}/${m.wickets}${won ? ' · won' : ''}` });
      return showResults(env.root, {
        title: won ? 'Chase won!' : lostBy === 0 ? 'Match tied' : 'So close',
        subtitle: `${diff} · Super Over Chase · target ${m.target}`,
        badge: won ? 'WON' : lostBy === 0 ? 'TIE' : 'LOST',
        badgeTone: won ? 'gold' : 'red',
        stars,
        score: `${m.runs}/${m.wickets}`,
        newBest: isBest,
        stats: [
          { label: won ? 'Balls to spare' : 'Short by', value: won ? String(m.ballsLeft) : `${Math.max(0, lostBy)} run${lostBy === 1 ? '' : 's'}` },
          { label: 'Balls faced', value: String(m.balls) },
          { label: 'Strike rate', value: m.strikeRate.toFixed(0) },
          { label: 'Fours / Sixes', value: `${m.fours} / ${m.sixes}` },
          { label: 'Longest hit', value: m.longest ? `${Math.round(m.longest)} m` : '—' },
          { label: 'Contact', value: s.swings ? `${Math.round((s.contacts / s.swings) * 100)}%` : '—' },
        ],
        actions: [
          { act: 'again', label: 'Bat again', icon: 'replay' },
          { act: 'menu', label: 'Modes', icon: 'gear' },
          { act: 'home', label: 'Home', icon: 'home' },
        ],
      });
    }
    const isBest = bests.submit(key, { score: m.score(), stars, extra: `${m.sixes} sixes · ${Math.round(m.sixDistance)} m` });
    return showResults(env.root, {
      title: m.sixes >= 6 ? 'Maximum entertainment!' : m.sixes >= 3 ? 'Big hitting!' : 'Keep swinging',
      subtitle: `${diff} · Six Hitting · ${m.maxBalls} balls`,
      badge: `${m.sixes}×6`,
      badgeTone: m.sixes >= 6 ? 'gold' : m.sixes >= 3 ? 'blue' : 'red',
      stars,
      score: `${Math.round(m.sixDistance)} m`,
      newBest: isBest,
      stats: [
        { label: 'Sixes', value: String(m.sixes) },
        { label: 'Longest six', value: m.longest ? `${Math.round(m.longest)} m` : '—' },
        { label: 'Fours', value: String(m.fours) },
        { label: 'Runs', value: String(m.runs) },
        { label: 'Out', value: String(m.wickets) },
        { label: 'Perfect swings', value: String(s.perfects) },
      ],
      actions: [
        { act: 'again', label: 'Go again', icon: 'replay' },
        { act: 'menu', label: 'Modes', icon: 'gear' },
        { act: 'home', label: 'Home', icon: 'home' },
      ],
    });
  }
  const g = s.baseball!;
  const stars = g.stars();
  if (g.mode === 'derby') {
    const isBest = bests.submit(key, { score: g.score(), stars, extra: `${g.hrs} HR · ${Math.round(g.longest)} m` });
    return showResults(env.root, {
      title: g.hrs >= 6 ? 'Derby champion!' : g.hrs >= 3 ? 'Power show' : 'Swing harder',
      subtitle: `${diff} · Home Run Derby · ${g.maxOuts} outs`,
      badge: `${g.hrs}`,
      badgeTone: g.hrs >= 6 ? 'gold' : g.hrs >= 3 ? 'blue' : 'red',
      stars,
      score: `${g.hrs} HR`,
      newBest: isBest,
      stats: [
        { label: 'Longest', value: g.longest ? `${Math.round(g.longest)} m · ${Math.round(g.longest * 3.281)} ft` : '—' },
        { label: 'Total HR distance', value: `${Math.round(g.hrDistance)} m` },
        { label: 'Swings', value: String(g.swings) },
        { label: 'Contact', value: s.swings ? `${Math.round((s.contacts / s.swings) * 100)}%` : '—' },
        { label: 'Perfect swings', value: String(s.perfects) },
        { label: 'Pitches seen', value: String(g.pitches) },
      ],
      actions: [
        { act: 'again', label: 'Another round', icon: 'replay' },
        { act: 'menu', label: 'Modes', icon: 'gear' },
        { act: 'home', label: 'Home', icon: 'home' },
      ],
    });
  }
  const isBest = bests.submit(key, { score: g.score(), stars, extra: `${g.runs} R · ${g.hits} H` });
  return showResults(env.root, {
    title: g.runs >= 5 ? 'Big inning!' : g.runs >= 1 ? 'On the board' : 'Three up, three down',
    subtitle: `${diff} · One Inning${g.runs >= 10 ? ' · mercy rule' : ''}`,
    badge: `${g.runs}R`,
    badgeTone: g.runs >= 3 ? 'gold' : g.runs >= 1 ? 'blue' : 'red',
    stars,
    score: `${g.runs} run${g.runs === 1 ? '' : 's'}`,
    newBest: isBest,
    stats: [
      { label: 'Hits', value: String(g.hits) },
      { label: 'Home runs', value: String(g.hrs) },
      { label: 'Walks', value: String(g.walks) },
      { label: 'Strikeouts', value: String(g.strikeouts) },
      { label: 'Longest', value: g.longest ? `${Math.round(g.longest)} m` : '—' },
      { label: 'Pitches seen', value: String(g.pitches) },
    ],
    actions: [
      { act: 'again', label: 'Play again', icon: 'replay' },
      { act: 'menu', label: 'Modes', icon: 'gear' },
      { act: 'home', label: 'Home', icon: 'home' },
    ],
  });
}

function cricketArt(): string {
  return `<svg viewBox="0 0 120 120" fill="none">
    <rect x="52" y="10" width="12" height="34" rx="4" fill="#232a55"/>
    <path d="M46 42 h24 v58 q-12 12 -24 0 z" fill="#ead6a6" stroke="#b89a5e" stroke-width="2"/>
    <path d="M58 46 v54" stroke="#c9ae74" stroke-width="2"/>
    <circle cx="92" cy="78" r="12" fill="#f4f2ea"/><path d="M82 72 q10 6 20 0" stroke="#c9c4b4" stroke-width="2.4"/>
    <g stroke="#f1ead8" stroke-width="4"><path d="M18 104 V64"/><path d="M26 104 V64"/><path d="M34 104 V64"/></g>
    <path d="M16 62 h20" stroke="#f1ead8" stroke-width="3"/>
  </svg>`;
}

function baseballArt(): string {
  return `<svg viewBox="0 0 120 120" fill="none">
    <path d="M30 96 L84 24 q6 -6 10 -2 q4 4 -2 10 L38 104 z" fill="#d2a46e" stroke="#9a7340" stroke-width="2"/>
    <rect x="24" y="92" width="16" height="10" rx="3" transform="rotate(-53 32 97)" fill="#15171c"/>
    <circle cx="82" cy="84" r="16" fill="#f6f3ea"/>
    <path d="M70 74 q8 10 0 22 M94 74 q-8 10 0 22" stroke="#c4202a" stroke-width="2.2"/>
  </svg>`;
}
