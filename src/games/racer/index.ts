import './style.css';
import { ICONS } from '../../icons';
import { local } from '../../core/storage';
import { bests, bindChoices, choiceRow, esc, html, loading, mount, showResults, topbar } from '../../ui/kit';
import type { GameEnv } from '../types';
import { ordinal } from './hud';
import { Race, fmtLap, type Difficulty, type GhostData, type Mode, type RaceConfig, type RaceResult } from './race';
import { TRACKS, buildTrack } from './track';
import { loadTextures, type Textures } from './world';
import { Showroom } from './showroom';

interface Prefs extends Record<string, string> {
  mode: Mode;
  track: string;
  difficulty: Difficulty;
  laps: string;
  type: 'race' | 'tt';
  view: 'chase' | 'onboard';
}

const DEFAULTS: Prefs = { mode: 'f1', track: '0', difficulty: 'normal', laps: '3', type: 'race', view: 'chase' };

const ghostKey = (cfg: RaceConfig) => `ma.racer.ghost.${TRACKS[cfg.track].id}.${cfg.mode}`;
const lapKey = (cfg: RaceConfig) => `racer:${TRACKS[cfg.track].id}:${cfg.mode}:lap`;
const raceKey = (cfg: RaceConfig) => `racer:${TRACKS[cfg.track].id}:${cfg.mode}:race${cfg.laps}`;

function toConfig(p: Prefs): RaceConfig {
  return {
    mode: p.mode === 'moto' ? 'moto' : 'f1',
    track: Math.max(0, Math.min(TRACKS.length - 1, Number(p.track) || 0)),
    difficulty: (['easy', 'normal', 'hard'] as const).includes(p.difficulty) ? p.difficulty : 'normal',
    laps: Math.max(1, Math.min(10, Number(p.laps) || 3)),
    type: p.type === 'tt' ? 'tt' : 'race',
    view: p.view === 'onboard' ? 'onboard' : 'chase',
  };
}

export default async function open(env: GameEnv): Promise<void> {
  const prefs: Prefs = { ...DEFAULTS, ...local.get<Partial<Prefs>>('ma.racer', {}) } as Prefs;
  const P = env.params;
  if (P.get('mode') === 'f1' || P.get('mode') === 'moto') prefs.mode = P.get('mode') as Mode;
  if (P.get('track') !== null && TRACKS[Number(P.get('track'))]) prefs.track = String(Number(P.get('track')));
  const d = P.get('difficulty');
  if (d === 'easy' || d === 'normal' || d === 'hard') prefs.difficulty = d;
  if (P.get('laps')) prefs.laps = String(Math.max(1, Math.min(10, Number(P.get('laps')) || 3)));
  if (P.get('type') === 'tt' || P.get('type') === 'race') prefs.type = P.get('type') as 'tt' | 'race';
  if (P.get('view') === 'onboard' || P.get('view') === 'chase') prefs.view = P.get('view') as 'chase' | 'onboard';
  let autoplay = P.get('autoplay') === '1';
  let textures: Textures | null = null;

  try {
    for (;;) {
      if (!autoplay) {
        const act = await menu(env, prefs);
        if (act === 'back') return;
      }
      autoplay = false;
      const cfg = toConfig(prefs);
      if (!textures) {
        const set = loading(env.root, 'Loading circuit…');
        try {
          textures = await loadTextures(16, (f) => set(`Loading circuit… ${Math.round(f * 100)}%`));
        } catch (e) {
          set(`Could not load the circuit: ${(e as Error).message}`);
          await new Promise((r) => setTimeout(r, 2500));
          return;
        }
      }
      let leave = false;
      for (;;) {
        env.root.replaceChildren();
        const ghost = cfg.type === 'tt' ? local.getRaw<GhostData | null>(ghostKey(cfg), null) : null;
        await env.audio.unlock().catch(() => {});
        const out = await new Race(env, cfg, textures, ghost).run();
        if (out.kind === 'restart') continue;
        if (out.kind === 'quit') break;
        const act = await results(env, out.result);
        if (act === 'again') continue;
        if (act === 'home') leave = true;
        break;
      }
      if (leave) return;
    }
  } finally {
    if (textures) for (const t of Object.values(textures)) t.dispose();
  }
}

// ---- menu -------------------------------------------------------------------------------------------

function trackSvg(i: number): string {
  const t = buildTrack(TRACKS[i], 6);
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let k = 0; k < t.n; k++) {
    x0 = Math.min(x0, t.x[k]);
    x1 = Math.max(x1, t.x[k]);
    z0 = Math.min(z0, t.z[k]);
    z1 = Math.max(z1, t.z[k]);
  }
  const s = 100 / Math.max(x1 - x0, z1 - z0);
  const w = (x1 - x0) * s;
  const h = (z1 - z0) * s;
  const pts = Array.from({ length: t.n + 1 }, (_, k) => `${((t.x[k % t.n] - x0) * s).toFixed(1)},${((t.z[k % t.n] - z0) * s).toFixed(1)}`).join(' ');
  const sx = ((t.x[0] - x0) * s).toFixed(1);
  const sy = ((t.z[0] - z0) * s).toFixed(1);
  return `<svg viewBox="-8 -8 ${w + 16} ${h + 16}" preserveAspectRatio="xMidYMid meet"><polyline points="${pts}" class="tk-o"/><polyline points="${pts}" class="tk-i"/><circle cx="${sx}" cy="${sy}" r="4.5" class="tk-s"/></svg>`;
}

const F1_ICON = `<svg viewBox="0 0 120 60" class="rm-veh"><path d="M6 38 h18 l6-8 h22 l8-10 h12 l6 10 h22 l6 8 h8 v6 H6z" fill="currentColor" opacity=".9"/><circle cx="28" cy="44" r="9" fill="#111" stroke="currentColor" stroke-width="3"/><circle cx="92" cy="44" r="10" fill="#111" stroke="currentColor" stroke-width="3"/><rect x="100" y="20" width="14" height="4" fill="currentColor"/><rect x="108" y="20" width="3" height="18" fill="currentColor"/></svg>`;
const MOTO_ICON = `<svg viewBox="0 0 120 60" class="rm-veh"><circle cx="26" cy="42" r="12" fill="#111" stroke="currentColor" stroke-width="3"/><circle cx="94" cy="42" r="12" fill="#111" stroke="currentColor" stroke-width="3"/><path d="M26 42 L48 26 h26 l20 16 M58 26 l-8-10 h-10" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M44 28 q14 -16 34 -6 l6 10 h-30z" fill="currentColor"/><circle cx="66" cy="10" r="6" fill="currentColor"/></svg>`;

function howTo(mode: Mode): string {
  return mode === 'f1'
    ? `<li><b>Steer</b> — hold both hands up in front of you and turn them like a steering wheel. You can sit down.</li>
       <li><b>Brake</b> — lower both hands toward your chest or waist. Lower = harder braking.</li>
       <li><b>Boost / DRS</b> — when the boost bar is full, push both hands up above your shoulders.</li>
       <li>The throttle is automatic. Let go of the wheel and the car coasts.</li>`
    : `<li><b>Steer</b> — stand up and lean your body left or right. The bike leans into the corner.</li>
       <li><b>Tuck</b> — crouch down on the straights for extra top speed.</li>
       <li><b>Brake</b> — stand tall and drop both hands to your hips.</li>
       <li>The throttle is automatic. Raise both hands above your head to pause.</li>`;
}

function bestLine(prefs: Prefs): string {
  const cfg = toConfig(prefs);
  const lap = bests.get(lapKey(cfg));
  const race = bests.get(raceKey(cfg));
  const parts: string[] = [];
  if (race && cfg.type === 'race') parts.push(`Best ${cfg.laps}-lap race <b>${fmtLap(race.score)}</b>${race.rank ? ` · ${race.rank}` : ''}`);
  if (lap) parts.push(`Best lap <b>${fmtLap(lap.score)}</b>`);
  return parts.length ? parts.join('<br>') : 'No times set here yet';
}

function menu(env: GameEnv, prefs: Prefs): Promise<string> {
  const el = html(`
    <div class="screen game-menu racer-menu">
      ${topbar('Grand Prix')}
      <div class="menu-body">
        <div class="rm-main">
          <div class="rm-sec">Discipline</div>
          <div class="rm-modes">
            <button class="rm-card" data-hc data-mode="f1">${F1_ICON}<b>Formula</b><span>F1-style single-seater · hold the wheel · seated OK</span></button>
            <button class="rm-card" data-hc data-mode="moto">${MOTO_ICON}<b>Moto GP</b><span>MotoGP-style race bike · lean to steer · standing</span></button>
          </div>
          <div class="rm-sec">Circuit</div>
          <div class="rm-tracks">
            ${TRACKS.map(
              (t, i) => `<button class="rm-track t-${t.theme}" data-hc data-track="${i}">
                <div class="rm-map">${trackSvg(i)}</div>
                <div class="rm-tinfo"><b>${esc(t.name)}</b><span>${esc(t.place)}</span><em>${(buildTrack(t, 6).length / 1000).toFixed(2)} km</em></div>
              </button>`,
            ).join('')}
          </div>
          <div class="how glass"><h3>How to play</h3><ul class="rm-how"></ul></div>
        </div>
        <div class="side glass">
          <div class="rm-show"><canvas></canvas><div class="rm-spec"></div></div>
          ${choiceRow('type', 'Event', [
            { value: 'race', label: 'Quick race' },
            { value: 'tt', label: 'Time trial' },
          ])}
          ${choiceRow('difficulty', 'Difficulty', [
            { value: 'easy', label: 'Easy', hint: 'Strong steering assist and automatic braking' },
            { value: 'normal', label: 'Normal' },
            { value: 'hard', label: 'Hard', hint: 'No assists, fast rivals' },
          ])}
          ${choiceRow('laps', 'Laps', [
            { value: '1', label: '1' },
            { value: '3', label: '3' },
            { value: '5', label: '5' },
          ])}
          ${choiceRow('view', 'Camera', [
            { value: 'chase', label: 'Chase' },
            { value: 'onboard', label: 'Onboard' },
          ])}
          <div class="best rm-best"></div>
          <button class="btn primary big" data-hc data-act="start">${ICONS.play} Start</button>
        </div>
      </div>
    </div>`);
  let show: Showroom | null = null;
  try {
    show = new Showroom(el.querySelector('.rm-show canvas') as HTMLCanvasElement);
  } catch {
    (el.querySelector('.rm-show') as HTMLElement).classList.add('hidden');
  }
  const refresh = () => {
    show?.set(prefs.mode);
    (el.querySelector('.rm-spec') as HTMLElement).innerHTML =
      prefs.mode === 'f1'
        ? '<span>1.6 V6 hybrid</span><span>330 km/h</span><span>8 gears</span><span>DRS boost</span>'
        : '<span>1000 cc inline-4</span><span>320 km/h</span><span>6 gears</span><span>58° lean</span>';
    el.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === prefs.mode));
    el.querySelectorAll<HTMLElement>('[data-track]').forEach((b) => b.classList.toggle('on', b.dataset.track === prefs.track));
    (el.querySelector('.rm-how') as HTMLElement).innerHTML = howTo(prefs.mode);
    (el.querySelector('.rm-best') as HTMLElement).innerHTML = bestLine(prefs);
    (el.querySelector('[data-act=start]') as HTMLElement).innerHTML = `${ICONS.play} ${prefs.type === 'tt' ? 'Start time trial' : 'Start race'}`;
    local.set('ma.racer', prefs);
  };
  mount(env.root, el);
  env.cursor(true);
  bindChoices(el, prefs, refresh);
  el.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => ((prefs.mode = b.dataset.mode as Mode), refresh())));
  el.querySelectorAll<HTMLElement>('[data-track]').forEach((b) => b.addEventListener('click', () => ((prefs.track = b.dataset.track!), refresh())));
  refresh();
  return new Promise<string>((resolve) => {
    el.querySelector('[data-act=back]')!.addEventListener('click', () => resolve('back'));
    el.querySelector('[data-act=start]')!.addEventListener('click', () => {
      env.audio.select();
      resolve('start');
    });
  }).then((act) => {
    show?.dispose();
    return act;
  });
}

// ---- results ------------------------------------------------------------------------------------------

async function results(env: GameEnv, r: RaceResult): Promise<string> {
  const cfg = r.cfg;
  const modeName = cfg.mode === 'f1' ? 'Formula' : 'Moto GP';
  const lapBest = isFinite(r.best) && bests.submit(lapKey(cfg), { score: r.best, extra: modeName }, true);
  let raceBest = false;
  if (cfg.type === 'race' && r.total > 0) raceBest = bests.submit(raceKey(cfg), { score: r.total, rank: ordinal(r.position) }, true);
  if (cfg.type === 'tt' && r.ghost && isFinite(r.ghost.time)) {
    const prev = local.getRaw<GhostData | null>(ghostKey(cfg), null);
    if (!prev || r.ghost.time < prev.time) {
      const round = (a: number[]) => a.map((v) => Math.round(v * 10) / 10);
      local.set(ghostKey(cfg), { time: r.ghost.time, dist: round(r.ghost.dist), d: round(r.ghost.d) });
    }
  }
  (window as unknown as { __lastResult?: unknown }).__lastResult = { position: r.position, total: r.total, best: r.best, laps: r.laps };
  env.cursor(true);
  const tt = cfg.type === 'tt';
  const winner = r.standings[0];
  const p = showResults(env.root, {
    title: tt ? `${r.trackName} · Time trial` : r.position === 1 ? `Victory at ${r.trackName}!` : `${r.trackName} Grand Prix`,
    subtitle: `${modeName} · ${cfg.difficulty} · ${cfg.laps} lap${cfg.laps > 1 ? 's' : ''}`,
    badge: tt ? 'TT' : ordinal(r.position),
    badgeTone: tt ? 'blue' : r.position === 1 ? 'gold' : r.position <= 3 ? 'blue' : 'red',
    score: tt ? fmtLap(r.best) : fmtLap(r.total),
    newBest: tt ? lapBest : raceBest,
    stats: tt
      ? r.laps.map((l, i) => ({ label: `Lap ${i + 1}${l === r.best ? ' ★' : ''}`, value: fmtLap(l) })).slice(0, 6)
      : [
          { label: 'Position', value: `${ordinal(r.position)} of ${r.standings.length}` },
          { label: 'Best lap', value: fmtLap(r.best) + (lapBest ? ' ★' : '') },
          { label: 'Gap to winner', value: r.position === 1 ? '—' : `+${(r.total - winner.time).toFixed(2)}s` },
        ],
    actions: [
      { act: 'again', label: tt ? 'Go again' : 'Race again', icon: 'replay' },
      { act: 'menu', label: 'Change race', icon: 'gear' },
      { act: 'home', label: 'Home', icon: 'home' },
    ],
  });
  // Standings table (all racers).
  const card = env.root.querySelector('.res-card');
  if (card && !tt) {
    const table = html(`
      <div class="rr-table">
        ${r.standings
          .map(
            (s, i) => `<div class="rr-row ${s.human ? 'me' : ''}">
              <b>${i + 1}</b><i style="background:${s.color}"></i><span>${esc(s.human ? 'You' : s.name)}</span>
              <em>${i === 0 ? fmtLap(s.time) : `+${(s.time - r.standings[0].time).toFixed(2)}s`}${s.finished ? '' : '*'}</em>
              <u>${isFinite(s.best) ? fmtLap(s.best) : '–'}</u>
            </div>`,
          )
          .join('')}
      </div>`);
    card.classList.add('rr-card');
    card.insertBefore(table, card.querySelector('.actions'));
  }
  return p;
}
