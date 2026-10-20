import './style.css';
import * as THREE from 'three';
import { local } from '../../core/storage';
import { bests, bindChoices, choiceRow, html, loading, mount, showResults, topbar, type Best } from '../../ui/kit';
import type { GameEnv } from '../types';
import { CharacterKit } from './character';
import { VENUES, type VenueId } from './court';
import { TennisGame, type Mode, type TennisAssets, type TennisConfig, type TennisResult } from './game';
import { CrowdBank } from './sounds';
import type { FormatId } from './rules';
import type { Difficulty, Handed } from './shots';

const BASE = import.meta.env.BASE_URL + 'assets/tennis/';

interface Prefs extends Record<string, string> {
  mode: Mode;
  difficulty: Difficulty;
  hand: Handed;
  venue: VenueId;
  format: FormatId;
  sex: 'm' | 'f';
  voice: 'on' | 'off';
}

const DEFAULTS: Prefs = { mode: 'match', difficulty: 'normal', hand: 'right', venue: 'hard', format: 'short', sex: 'm', voice: 'on' };

let cached: TennisAssets | null = null;

async function loadAssets(env: GameEnv): Promise<TennisAssets> {
  if (cached) return cached;
  const set = loading(env.root, 'Walking out onto Centre Court…');
  const loader = new THREE.TextureLoader();
  const [kit, dusk, day] = await Promise.all([
    CharacterKit.load(BASE, (f) => set(`Loading players… ${Math.round(f * 100)}%`)),
    loader.loadAsync(BASE + VENUES.hard.sky),
    loader.loadAsync(BASE + VENUES.grass.sky),
  ]);
  set('Filling the stands…');
  await CrowdBank.get(env.audio.ctx).catch(() => null);
  cached = { kit, skies: { hard: dusk, grass: day } };
  return cached;
}

function bestKey(mode: Mode, d: Difficulty): string {
  return `tennis:${mode}:${d}`;
}

export default async function open(env: GameEnv): Promise<void> {
  const prefs: Prefs = { ...DEFAULTS, ...local.get<Partial<Prefs>>('ma.tennis', {}) } as Prefs;
  const p = env.params;
  const pick = <K extends keyof Prefs>(k: K, allowed: string[]) => {
    const v = p.get(k as string);
    if (v && allowed.includes(v)) (prefs as Record<string, string>)[k as string] = v;
  };
  pick('mode', ['match', 'rally']);
  pick('difficulty', ['easy', 'normal', 'hard']);
  pick('hand', ['right', 'left']);
  pick('venue', ['hard', 'grass']);
  pick('format', ['tiebreak', 'short', 'set']);
  pick('sex', ['m', 'f']);
  let autoplay = p.get('autoplay') === '1';

  for (;;) {
    if (!autoplay) {
      const go = await menu(env, prefs);
      if (!go) return;
    }
    autoplay = false;
    let assets: TennisAssets;
    try {
      assets = await loadAssets(env);
    } catch (e) {
      const set = loading(env.root, '');
      set(`Could not load the court: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 2500));
      return;
    }
    for (;;) {
      const cfg: TennisConfig = {
        mode: prefs.mode,
        difficulty: prefs.difficulty,
        hand: prefs.hand,
        venue: prefs.venue,
        format: prefs.format,
        sex: prefs.sex,
        voice: prefs.voice === 'on',
        tutorial: !local.getRaw<boolean>('ma.tennis.tutored', false) || prefs.difficulty === 'easy' || env.demo,
      };
      mount(env.root, html('<div class="screen tennis-host"></div>'));
      const game = new TennisGame(env, cfg, assets);
      const out = await game.run();
      if (out.kind === 'restart') continue;
      if (out.kind === 'quit') break;
      local.set('ma.tennis.tutored', true);
      const act = await results(env, out.result, cfg);
      if (act === 'again') continue;
      if (act === 'home') return;
      break;
    }
  }
}

async function menu(env: GameEnv, prefs: Prefs): Promise<boolean> {
  const el = html(`
    <div class="screen game-menu tennis-menu">
      ${topbar('Centre Court')}
      <div class="menu-body">
        <div class="how glass">
          <div class="tm-hero">
            <svg viewBox="0 0 240 120" class="tm-court" aria-hidden="true">
              <defs><linearGradient id="tmg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#2a5aa6"/><stop offset="1" stop-color="#1c3d75"/></linearGradient></defs>
              <polygon points="70,12 170,12 225,112 15,112" fill="url(#tmg)" stroke="#fff" stroke-width="2"/>
              <line x1="120" y1="12" x2="120" y2="112" stroke="#fff" stroke-width="1.2" opacity=".55"/>
              <line x1="47" y1="54" x2="193" y2="54" stroke="#fff" stroke-width="3"/>
              <circle cx="150" cy="34" r="4" fill="#d4ff3d"/>
              <path d="M150 34 Q 135 70 104 92" stroke="#d4ff3d" stroke-width="1.5" fill="none" stroke-dasharray="3 3"/>
            </svg>
            <div><h3>How to play</h3><p class="tm-sub">Hold an imaginary racket. Your player runs to the ball — you time and shape the shot.</p></div>
          </div>
          <ul class="tm-moves">
            <li><b>Forehand</b><span>Swing your racket hand across your body from the racket side as the ball reaches you.</span></li>
            <li><b>Backhand</b><span>Start on the other side of your body and swing back towards the racket side.</span></li>
            <li><b>Aim & spin</b><span>Early = cross-court, late = down the line. Finish high for topspin or a lob, chop down for slice. Faster swing = more pace.</span></li>
            <li><b>Serve</b><span>Raise your racket hand above your head to toss, then swing down fast.</span></li>
          </ul>
          <div class="tm-tip">Stand 2–3 m back · Raise both hands for 1 s to pause</div>
        </div>
        <div class="side glass">
          ${choiceRow('mode', 'Mode', [
            { value: 'match', label: 'Quick match' },
            { value: 'rally', label: 'Rally challenge' },
          ])}
          <div class="tm-two">
            ${choiceRow('difficulty', 'Opponent', [
              { value: 'easy', label: 'Easy' },
              { value: 'normal', label: 'Normal' },
              { value: 'hard', label: 'Hard' },
            ])}
            <div class="tm-format">${choiceRow('format', 'Match length', [
              { value: 'tiebreak', label: 'Tie-break' },
              { value: 'short', label: 'Short set' },
              { value: 'set', label: 'Full set' },
            ])}</div>
          </div>
          ${choiceRow('venue', 'Venue', [
            { value: 'hard', label: 'Harbour Arena · hard', hint: 'Twilight session under the floodlights' },
            { value: 'grass', label: 'Garden Club · grass', hint: 'Summer afternoon on grass' },
          ])}
          <div class="tm-two">
            ${choiceRow('hand', 'You play', [
              { value: 'right', label: 'Right-handed' },
              { value: 'left', label: 'Left-handed' },
            ])}
            ${choiceRow('sex', 'Players', [
              { value: 'm', label: 'Men' },
              { value: 'f', label: 'Women' },
            ])}
          </div>
          <div class="tm-two">
            ${choiceRow('voice', 'Umpire voice', [
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ])}
            <div class="best"></div>
          </div>
          <button class="btn primary big" data-hc data-act="play">Play</button>
        </div>
      </div>
    </div>`);
  mount(env.root, el);
  env.cursor(true);
  const refresh = () => {
    (el.querySelector('.tm-format') as HTMLElement).style.visibility = prefs.mode === 'match' ? '' : 'hidden';
    const b: Best | undefined = bests.get(bestKey(prefs.mode, prefs.difficulty));
    const best = el.querySelector('.best') as HTMLElement;
    if (!b) best.textContent = 'No result yet at this level';
    else
      best.innerHTML =
        prefs.mode === 'match'
          ? `Best: <b>${b.extra ?? ''}</b> · ${'★'.repeat(b.stars ?? 0)}${'☆'.repeat(3 - (b.stars ?? 0))}`
          : `Best: <b>${b.score.toLocaleString()}</b> pts · ${b.extra ?? ''} · ${'★'.repeat(b.stars ?? 0)}${'☆'.repeat(3 - (b.stars ?? 0))}`;
    local.set('ma.tennis', prefs);
  };
  bindChoices(el, prefs, refresh);
  refresh();
  return new Promise((resolve) => {
    el.querySelector('[data-act=play]')!.addEventListener('click', () => resolve(true));
    el.querySelector('[data-act=back]')!.addEventListener('click', () => resolve(false));
  });
}

async function results(env: GameEnv, r: TennisResult, cfg: TennisConfig): Promise<string> {
  (window as unknown as { __lastResult?: TennisResult }).__lastResult = r;
  const v = VENUES[r.venue];
  const played = r.pointsWon + r.pointsLost;
  const pct = played ? Math.round((r.pointsWon / played) * 100) : 0;
  let isBest = false;
  if (r.mode === 'match') {
    const score = (r.won ? 1000 : 0) + pct;
    isBest = bests.submit(bestKey('match', r.difficulty), {
      score,
      stars: r.stars,
      extra: `${r.won ? 'Won' : 'Lost'} ${r.scoreLine}`,
    });
  } else {
    isBest = bests.submit(bestKey('rally', r.difficulty), { score: r.score, stars: r.stars, extra: `rally ${r.longestRally}` });
  }
  env.cursor(true);
  const fmt = cfg.format === 'tiebreak' ? 'Tie-break' : cfg.format === 'short' ? 'Short set' : 'Full set';
  if (r.mode === 'match') {
    return showResults(env.root, {
      title: r.won ? 'Victory!' : 'Defeat',
      subtitle: `vs ${r.opponent} · ${r.difficulty} · ${fmt} · ${v.name}`,
      badge: r.won ? 'WIN' : 'LOSS',
      badgeTone: r.won ? 'gold' : 'red',
      stars: r.stars,
      score: r.scoreLine,
      newBest: isBest && r.won,
      stats: [
        { label: 'Points won', value: `${r.pointsWon}/${played} (${pct}%)` },
        { label: 'Aces', value: String(r.aces) },
        { label: 'Winners', value: String(r.winners) },
        { label: 'Errors', value: String(r.errors) },
        { label: 'Longest rally', value: `${r.longestRally} shots` },
        { label: 'Fastest serve', value: r.fastestServe ? `${r.fastestServe} km/h` : '—' },
        { label: 'First serves in', value: `${r.firstServePct}%` },
        { label: 'Double faults', value: String(r.doubleFaults) },
        { label: 'Perfect timing', value: String(r.perfects) },
      ],
      actions: [
        { act: 'again', label: 'Rematch', icon: 'replay' },
        { act: 'menu', label: 'Match settings', icon: 'gear' },
        { act: 'home', label: 'Home', icon: 'home' },
      ],
    });
  }
  return showResults(env.root, {
    title: 'Rally challenge',
    subtitle: `${r.difficulty} · ${v.name}`,
    badge: r.stars >= 3 ? 'S' : r.stars === 2 ? 'A' : r.stars === 1 ? 'B' : 'C',
    badgeTone: r.stars >= 3 ? 'blue' : 'gold',
    stars: r.stars,
    score: `${r.score.toLocaleString()} pts`,
    newBest: isBest,
    stats: [
      { label: 'Longest rally', value: `${r.longestRally}` },
      { label: 'Targets hit', value: String(r.targets) },
      { label: 'Perfect timing', value: String(r.perfects) },
    ],
    actions: [
      { act: 'again', label: 'Play again', icon: 'replay' },
      { act: 'menu', label: 'Settings', icon: 'gear' },
      { act: 'home', label: 'Home', icon: 'home' },
    ],
  });
}
