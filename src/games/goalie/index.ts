import '@fontsource/outfit/900.css';
import './style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { local } from '../../core/storage';
import { bests, bindChoices, choiceRow, html, mount, showResults, topbar } from '../../ui/kit';
import type { GameEnv } from '../types';
import { DIFFICULTIES, MODES, rankFor, savePct, type Difficulty, type Mode } from './logic';
import { AWAY, HOME, Match, type MatchResult } from './match';
import { PeopleKit } from './people';
import { Stadium } from './stadium';
import { World } from './world';

const BASE = import.meta.env.BASE_URL + 'assets/goalie/';

interface Prefs extends Record<string, string> {
  mode: Mode;
  difficulty: Difficulty;
  time: 'night' | 'day';
  kicks: 'mine' | 'auto';
}

interface Assets {
  grass: THREE.Texture;
  people: PeopleKit;
}

const ICON = {
  hands: `<svg viewBox="0 0 48 48"><path d="M10 34V20l-3-7a2.5 2.5 0 0 1 4.5-2l3 6V8a2.5 2.5 0 0 1 5 0v9-11a2.5 2.5 0 0 1 5 0v11-8a2.5 2.5 0 0 1 5 0v14c0 8-4 13-11 13h-2c-4 0-6.5-2-6.5-2z"/><circle cx="38" cy="12" r="5" class="ball"/></svg>`,
  lean: `<svg viewBox="0 0 48 48"><circle cx="24" cy="9" r="4"/><path d="M24 14v14M14 20l10-4 10 4M17 42l7-14 7 14"/><path d="M6 30h7M35 30h7M9 27l-3 3 3 3M39 27l3 3-3 3" class="accent"/></svg>`,
  reach: `<svg viewBox="0 0 48 48"><circle cx="24" cy="14" r="4"/><path d="M24 19v12M16 4l8 12 8-12M18 44l6-13 6 13"/><path d="M8 40h32" class="accent"/></svg>`,
  point: `<svg viewBox="0 0 48 48"><rect x="6" y="8" width="36" height="20" rx="1"/><circle cx="35" cy="14" r="3.5" class="accent"/><circle cx="24" cy="40" r="4"/><path d="M27 37l7-20"/></svg>`,
};

export default async function open(env: GameEnv): Promise<void> {
  const prefs: Prefs = local.get('ma.goalie', { mode: 'shootout', difficulty: 'normal', time: 'night', kicks: 'mine' } as Prefs);
  const pm = env.params.get('mode') as Mode | null;
  const pd = env.params.get('difficulty') as Difficulty | null;
  const pt = env.params.get('time');
  if (pm && MODES.includes(pm)) prefs.mode = pm;
  if (pd && DIFFICULTIES.includes(pd)) prefs.difficulty = pd;
  if (pt === 'day' || pt === 'night') prefs.time = pt;
  if (env.params.get('kicks') === 'auto') prefs.kicks = 'auto';
  let autoplay = env.params.get('autoplay') === '1';

  const root = mount(env.root, html(`<div class="goalie game-root"><div class="gk-ui"></div></div>`));
  const ui = root.querySelector('.gk-ui') as HTMLElement;
  let world: World | null = null;
  let worldNight = prefs.time === 'night';
  let menuCam = true;
  const assetsP = loadAssets().catch((e) => {
    console.error(e);
    return null;
  });

  const buildWorld = (assets: Assets, night: boolean) => {
    const t0 = performance.now();
    if (env.params.has('gktrace')) console.log('[goalie] build world');
    world?.dispose();
    const w = new World(root, env.settings.quality, night);
    if (env.demo) w.maxDt = 1;
    w.setStadium(new Stadium({ night, detail: w.detail, grass: assets.grass }, w.msaa));
    w.stadium.screen.draw({ title: 'WELCOME', left: HOME.short, right: '', score: 'GOALKEEPER', sub: 'Move Arcade Stadium', colA: HOME.color, colB: '#ffffff' });
    w.step = (dt, now) => {
      w.stadium.update(dt, now / 1000);
      if (menuCam) orbit(w, now);
    };
    world = w;
    worldNight = night;
    // Compile shaders in the background, then start rendering (keeps the menu responsive).
    if (env.params.has('gktrace')) console.log('[goalie] world built in', Math.round(performance.now() - t0));
    void w.compile().then(() => {
      if (env.params.has('gktrace')) console.log('[goalie] compiled after', Math.round(performance.now() - t0));
      if (world !== w) return;
      w.start();
      root.classList.add('ready');
    });
  };

  const devView = env.params.get('gkview');
  if (devView) {
    const a = await assetsP;
    if (a) {
      buildWorld(a, prefs.time === 'night');
      const { debugView } = await import('./debugview');
      debugView(world!, a.people, devView);
      await new Promise(() => {});
    }
  }
  try {
    for (;;) {
      if (!autoplay) {
        menuCam = true;
        const pick = menu(env, ui, prefs, async () => {
          const a = await assetsP;
          if (a && (!world || worldNight !== (prefs.time === 'night'))) buildWorld(a, prefs.time === 'night');
        });
        const a0 = await Promise.race([assetsP, new Promise((r) => setTimeout(r, 30))]);
        if (a0 && !world) buildWorld(a0 as Assets, prefs.time === 'night');
        else if (!a0) void assetsP.then((a) => a && !world && buildWorld(a, prefs.time === 'night'));
        const act = await pick;
        if (act !== 'play') return;
      }
      autoplay = false;
      const assets = await withLoading(ui, assetsP);
      if (!assets) {
        mount(ui, html(`<div class="screen loading"><div class="load-text">Could not load the stadium. Check your connection and try again.</div></div>`));
        await new Promise((r) => setTimeout(r, 2500));
        return;
      }
      if (!world || worldNight !== (prefs.time === 'night')) buildWorld(assets, prefs.time === 'night');
      local.set('ma.goalie', prefs);
      // Matches until the player goes back to the menu.
      let again = true;
      while (again) {
        menuCam = false;
        ui.replaceChildren();
        env.cursor(false);
        const match = new Match(env, root, world!, assets.people, {
          mode: prefs.mode,
          difficulty: prefs.difficulty,
          ownKicks: prefs.kicks === 'mine',
          seed: Number(env.params.get('seed')) || (Date.now() & 0xffffff),
        });
        const out = await match.run();
        world!.step = (dt, now) => {
          world!.stadium.update(dt, now / 1000);
          if (menuCam) orbit(world!, now);
        };
        menuCam = true;
        if (out.kind === 'restart') continue;
        if (out.kind === 'quit') break;
        const act = await results(env, ui, out.result);
        if (act === 'again') continue;
        if (act === 'home') return;
        again = false;
      }
    }
  } finally {
    (world as World | null)?.dispose();
    const a = await assetsP;
    a?.people.dispose();
    a?.grass.dispose();
    env.cursor(true);
  }
}

async function loadAssets(): Promise<Assets> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const [grass, gltf, lod] = await Promise.all([
    new THREE.TextureLoader().loadAsync(BASE + 'grass.jpg'),
    loader.loadAsync(BASE + 'footballer.glb'),
    loader.loadAsync(BASE + 'footballer_lod.glb').catch(() => null),
  ]);
  grass.wrapS = grass.wrapT = THREE.RepeatWrapping;
  grass.colorSpace = THREE.SRGBColorSpace;
  grass.anisotropy = 8;
  return { grass, people: new PeopleKit(gltf, lod) };
}

async function withLoading<T>(ui: HTMLElement, p: Promise<T>): Promise<T> {
  let shown = false;
  const t = setTimeout(() => {
    shown = true;
    mount(ui, html(`<div class="screen loading gk-loading"><div class="spinner"></div><div class="load-text">Loading the stadium…</div></div>`));
  }, 120);
  const v = await p;
  clearTimeout(t);
  if (shown) ui.replaceChildren();
  return v;
}

/** Slow cinematic orbit for menus. */
function orbit(w: World, now: number): void {
  const a = now / 14000;
  w.hfov = 72;
  w.updateFov();
  w.camera.position.set(Math.sin(a) * 16, 6.5 + Math.sin(a * 0.7) * 1.5, -14 + Math.cos(a) * 8);
  w.camera.lookAt(0, 1.3, -1);
}

function bestLine(prefs: Prefs): string {
  const b = bests.get(`goalie:${prefs.mode}:${prefs.difficulty}`);
  if (!b) return 'No record yet on this setting';
  const stars = '★'.repeat(b.stars ?? 0) + '☆'.repeat(3 - (b.stars ?? 0));
  return `Best: <b>${b.score.toLocaleString()}</b> ${prefs.mode === 'rapid' ? 'saves' : 'pts'} · ${b.rank ?? ''} ${stars}${b.extra ? ` · ${b.extra}` : ''}`;
}

function menu(env: GameEnv, ui: HTMLElement, prefs: Prefs, onTime: () => void): Promise<string> {
  const away = AWAY[prefs.difficulty];
  const el = html(`
    <div class="screen game-menu gk-menu">
      ${topbar('Goalkeeper')}
      <div class="menu-body">
        <div class="how glass">
          <div class="gk-menu-title"><small>Move Arcade Stadium</small><b>Goalkeeper</b><span class="gk-vs"><i style="--c:${HOME.color}"></i>${HOME.name} <em>vs</em> <i class="away-dot" style="--c:${away.color}"></i><span class="away-name">${away.name}</span></span></div>
          <h3>How to play</h3>
          <div class="gk-howgrid">
            <div class="gk-how">${ICON.hands}<b>Hands to the ball</b><span>Your gloves follow your hands — put them in the ball's path.</span></div>
            <div class="gk-how">${ICON.lean}<b>Step or lean to dive</b><span>A one-metre step takes you all the way to the post.</span></div>
            <div class="gk-how">${ICON.reach}<b>Reach up, get down</b><span>Arms up (or jump) for the top corners, squat for low shots.</span></div>
            <div class="gk-how">${ICON.point}<b>Take your penalties</b><span>Point at a corner, then kick or swing your arm down.</span></div>
          </div>
          <p class="gk-tip">Read the shooter: on Easy his body angle gives the side away. On Hard he disguises it.</p>
        </div>
        <div class="side glass">
          ${choiceRow('mode', 'Mode', [
            { value: 'shootout', label: 'Penalty shootout' },
            { value: 'rapid', label: 'Rapid fire · 60 s' },
          ])}
          ${choiceRow('difficulty', 'Difficulty', [
            { value: 'easy', label: 'Easy' },
            { value: 'normal', label: 'Normal' },
            { value: 'hard', label: 'Hard' },
          ])}
          ${choiceRow('time', 'Kick-off', [
            { value: 'night', label: 'Floodlights' },
            { value: 'day', label: 'Sunny day' },
          ])}
          <div class="gk-kicks">${choiceRow('kicks', 'Your penalties', [
            { value: 'mine', label: 'Take them' },
            { value: 'auto', label: 'Team mates' },
          ])}</div>
          <div class="best"></div>
          <button class="btn primary big gk-play" data-hc data-act="play">Play</button>
        </div>
      </div>
    </div>`);
  mount(ui, el);
  env.cursor(true);
  const refresh = () => {
    (el.querySelector('.best') as HTMLElement).innerHTML = bestLine(prefs);
    (el.querySelector('.gk-kicks') as HTMLElement).style.display = prefs.mode === 'shootout' ? '' : 'none';
    const a = AWAY[prefs.difficulty];
    (el.querySelector('.away-name') as HTMLElement).textContent = prefs.mode === 'shootout' ? a.name : `${a.name} strikers`;
    (el.querySelector('.away-dot') as HTMLElement).style.setProperty('--c', a.color);
    local.set('ma.goalie', prefs);
  };
  let lastTime = prefs.time;
  bindChoices(el, prefs, () => {
    refresh();
    if (prefs.time !== lastTime) {
      lastTime = prefs.time;
      onTime();
    }
  });
  refresh();
  return new Promise((resolve) => {
    el.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => b.addEventListener('click', () => resolve(b.dataset.act!), { once: true }));
  });
}

async function results(env: GameEnv, ui: HTMLElement, r: MatchResult): Promise<string> {
  const pct = savePct(r.tally);
  const rank = rankFor(pct, r.mode, r.won ?? undefined);
  const faced = r.tally.saves + r.tally.goals;
  const key = `goalie:${r.mode}:${r.difficulty}`;
  const score = r.mode === 'rapid' ? r.tally.saves : r.points;
  const isBest = bests.submit(key, { score, rank: rank.badge, stars: rank.stars, extra: r.mode === 'rapid' ? `${r.points.toLocaleString()} pts` : `${r.tally.saves} saves` });
  (window as unknown as { __lastResult?: unknown }).__lastResult = { ...r, snapshot: r.snapshot ? 'jpeg' : '', pct, rank };
  env.cursor(true);
  const hg = r.home.filter(Boolean).length;
  const ag = r.away.filter(Boolean).length;
  const p = showResults(ui, {
    title: r.mode === 'shootout' ? (r.won ? 'Shootout won!' : 'Shootout lost') : 'Rapid fire',
    subtitle: r.mode === 'shootout' ? `${r.difficulty} · ${r.homeTeam.short} ${hg} – ${ag} ${r.awayTeam.short}` : `${r.difficulty} · ${faced} shots on target`,
    badge: rank.badge,
    badgeTone: rank.tone,
    stars: rank.stars,
    score: r.mode === 'rapid' ? `${r.tally.saves} saves` : `${hg} – ${ag}`,
    newBest: isBest,
    stats: [
      { label: 'Save rate', value: `${Math.round(pct * 100)}%` },
      { label: 'Saves', value: `${r.tally.saves}/${faced}` },
      { label: 'Best streak', value: String(r.tally.bestStreak) },
      { label: 'Great saves', value: String(r.tally.great) },
      { label: 'Catches', value: String(r.tally.catches) },
      { label: 'Points', value: r.points.toLocaleString() },
    ],
    actions: [
      { act: 'again', label: 'Play again', icon: 'replay' },
      { act: 'menu', label: 'Change mode', icon: 'play' },
      { act: 'home', label: 'Home', icon: 'home' },
    ],
  });
  const el = ui.querySelector('.results') as HTMLElement | null;
  if (el) {
    el.classList.add('gk-results');
    if (r.snapshot) el.style.setProperty('--shot', `url(${r.snapshot})`);
    const card = el.querySelector('.res-card') as HTMLElement | null;
    if (card && r.mode === 'shootout') {
      const dots = (a: boolean[]) => a.map((x) => `<i class="${x ? 'in' : 'out'}"></i>`).join('');
      card.insertAdjacentHTML(
        'afterbegin',
        `<div class="gk-res-pens"><div><b style="--c:${r.homeTeam.color}">${r.homeTeam.short}</b>${dots(r.home)}</div><div><b style="--c:${r.awayTeam.color}">${r.awayTeam.short}</b>${dots(r.away)}</div></div>`,
      );
    }
  }
  return p;
}
