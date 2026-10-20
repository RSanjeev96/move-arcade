/** Dance Fit screens: home menu with today's workout and the week, workout setup, weekly plan, profile, results. */
import { ICONS } from '../../icons';
import { bests, esc, html, mount, topbar } from '../../ui/kit';
import { addDeviceSong, fmtTime, listSongs, type SongInfo } from '../blade/songs';
import { kindColors, pictogram } from './cards';
import { COACHES, type CoachId } from './coach';
import { effectiveMet, kcal } from './calories';
import { MOVE } from './moves';
import { DAY_LONG, DAY_NAMES, dayIndex, planFor, weekSummary, type Plan, type SessionRecord, type WeekSummary, type WorkoutType } from './plan';
import { ALL_LENGTHS, WORKOUTS, WORKOUT_ORDER, program } from './routine';
import type { SessionResult } from './session';
import { store, type Profile } from './store';
import type { GameEnv } from '../types';

export type MenuAction =
  | { kind: 'back' }
  | { kind: 'plan' }
  | { kind: 'profile' }
  | { kind: 'setup'; type: WorkoutType }
  | { kind: 'start'; type: WorkoutType; minutes: number; planned: boolean };

const STAR = (n: number, of = 3) => `<span class="fit-stars">${Array.from({ length: of }, (_, i) => `<i class="${i < n ? 'on' : ''}">★</i>`).join('')}</span>`;

const typeIcon = (t: WorkoutType) => `<img class="fit-ti" src="${pictogram(WORKOUTS[t].show[0], 120, 140)}" alt="">`;

function weekStrip(w: WeekSummary, compact = false): string {
  return `<div class="fit-week ${compact ? 'compact' : ''}">${w.days
    .map((d) => {
      const cls = [d.done ? 'done' : '', d.planned ? 'planned' : 'rest', d.isToday ? 'today' : '', d.missed ? 'missed' : ''].join(' ');
      const c = d.planned ? WORKOUTS[d.planned.type].colors : ['#3a2c66', '#3a2c66'];
      const part = d.planned && !d.done && d.minutes > 0 ? Math.min(0.95, d.minutes / Math.max(1, d.planned.minutes * 0.5)) : 0;
      return `<div class="fw-day ${cls} ${part ? 'partial' : ''}" style="--c1:${c[0]};--c2:${c[1]};--p:${part.toFixed(2)}">
        <span class="fw-l">${d.label}</span>
        <div class="fw-dot">${d.done ? '✓' : d.planned ? (compact ? '' : `<small>${d.planned.minutes}</small>`) : '·'}</div>
        ${compact ? '' : `<span class="fw-t">${d.planned ? esc(WORKOUTS[d.planned.type].name.split(' ')[0]) : 'Rest'}</span>`}
      </div>`;
    })
    .join('')}</div>`;
}

function lastHtml(history: SessionRecord[]): string {
  const r = [...history].sort((a, b) => b.ts - a.ts)[0];
  if (!r) return '';
  const d = WORKOUTS[r.type];
  const days = Math.round((new Date().setHours(12, 0, 0, 0) - new Date(r.ts).setHours(12, 0, 0, 0)) / 86400000);
  const when = days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`;
  return `<div class="fm-last" style="--c1:${d.colors[0]};--c2:${d.colors[1]}"><img src="${pictogram(d.show[0], 120, 140)}" alt="">
    <div class="fm-last-t"><small>Last workout · ${when}</small><b>${esc(d.name)}</b><span>${Math.round(r.minutes)} min · ${r.kcal} kcal est. · ${r.score.toLocaleString('en-US')} pts</span></div>${STAR(r.stars)}</div>`;
}

// ---- home menu ------------------------------------------------------------------------------------

export function menu(env: GameEnv): Promise<MenuAction> {
  const plan = store.plan();
  const history = store.history();
  const profile = store.profile();
  const today = new Date();
  const w = weekSummary(plan, history, today);
  const todays = planFor(plan, today);
  const doneToday = w.days[dayIndex(today)].done;
  let nextPlanned = '';
  for (let i = 1; i <= 7 && !todays; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i, 12);
    const p = planFor(plan, d);
    if (p) {
      nextPlanned = `${i === 1 ? 'Tomorrow' : DAY_LONG[dayIndex(d)]}: ${WORKOUTS[p.type].name} · ${p.minutes} min`;
      break;
    }
  }
  const hero = todays
    ? `<div class="fm-hero glass" style="--c1:${WORKOUTS[todays.type].colors[0]};--c2:${WORKOUTS[todays.type].colors[1]}">
        <div class="fm-hero-txt">
          <div class="fm-eyebrow">Today · ${DAY_LONG[dayIndex(today)]}${doneToday ? ' · <b>done ✓</b>' : ''}</div>
          <div class="fm-hero-title">${esc(WORKOUTS[todays.type].name)}</div>
          <div class="fm-hero-sub">${todays.minutes} min · ${esc(WORKOUTS[todays.type].desc)}</div>
          <button class="btn primary big fm-go" data-hc data-act="today">${ICONS.play} ${doneToday ? 'Go again' : "Start today's workout"}</button>
        </div>
        <div class="fm-hero-art">${WORKOUTS[todays.type].show.map((m) => `<img src="${pictogram(m)}" alt="">`).join('')}</div>
      </div>`
    : `<div class="fm-hero glass rest" style="--c1:#1fb8ff;--c2:#3bffb4">
        <div class="fm-hero-txt">
          <div class="fm-eyebrow">Today · ${DAY_LONG[dayIndex(today)]}</div>
          <div class="fm-hero-title">Rest day</div>
          <div class="fm-hero-sub">${nextPlanned ? esc(nextPlanned) : 'No training days planned yet — set up your week.'}</div>
          <button class="btn primary big fm-go" data-hc data-act="stretch">${ICONS.play} Light stretch · 5 min</button>
        </div>
        <div class="fm-hero-art">${['breathe', 'overhead', 'sidebend'].map((m) => `<img src="${pictogram(m)}" alt="">`).join('')}</div>
      </div>`;
  const el = html(`
    <div class="screen fit fit-menu">
      <div class="fit-bg"><i></i><i></i></div>
      ${topbar('Dance Fit')}
      <div class="fm-top-right">
        <button class="btn sm" data-hc data-act="profile">${ICONS.person} ${profile.unit === 'lb' ? Math.round(profile.weightKg * 2.2046) + ' lb' : profile.weightKg + ' kg'}</button>
        <button class="btn sm" data-hc data-act="plan">📅 Weekly plan</button>
      </div>
      <div class="fm-body">
        <div class="fm-main">
          ${hero}
          <div class="fm-tiles">
            ${WORKOUT_ORDER.map((t) => {
              const d = WORKOUTS[t];
              return `<button class="fm-tile" data-hc data-type="${t}" style="--c1:${d.colors[0]};--c2:${d.colors[1]}">
                <img src="${pictogram(d.show[0])}" alt="">
                <b>${esc(d.name)}</b>
                <span>${d.lengths.join(' / ')} min</span>
              </button>`;
            }).join('')}
          </div>
        </div>
        <div class="fm-side glass">
          <div class="fm-side-h"><b>This week</b><span>${esc(w.goalText)}</span></div>
          ${weekStrip(w)}
          <div class="fm-goal"><i style="width:${(w.progress * 100).toFixed(0)}%"></i></div>
          <div class="fm-stats">
            <div><b>🔥 ${w.streak}</b><span>day streak</span></div>
            <div><b>${Math.round(w.minutes)}</b><span>minutes</span></div>
            <div><b>${Math.round(w.kcal)}</b><span>kcal · est.</span></div>
          </div>
          ${lastHtml(history)}
          <div class="fm-how">
            <div class="fm-how-h">How to play</div>
            <div class="fm-how-row"><span class="fm-k">🪞</span><span><b>Mirror the coach</b> — move like a reflection, on the beat</span></div>
            <div class="fm-how-row"><span class="fm-k">↔</span><span><b>Stand 2–3 m back</b> so your whole body is in view</span></div>
            <div class="fm-how-row"><span class="fm-k">✋</span><span><b>Raise both hands</b> and hold to pause</span></div>
          </div>
        </div>
      </div>
    </div>`);
  mount(env.root, el);
  env.cursor(true);
  return new Promise((resolve) => {
    el.querySelector('[data-act=back]')!.addEventListener('click', () => resolve({ kind: 'back' }));
    el.querySelector('[data-act=plan]')!.addEventListener('click', () => resolve({ kind: 'plan' }));
    el.querySelector('[data-act=profile]')!.addEventListener('click', () => resolve({ kind: 'profile' }));
    el.querySelector('[data-act=today]')?.addEventListener('click', () => resolve({ kind: 'start', type: todays!.type, minutes: todays!.minutes, planned: true }));
    el.querySelector('[data-act=stretch]')?.addEventListener('click', () => resolve({ kind: 'start', type: 'cooldown', minutes: 5, planned: false }));
    el.querySelectorAll<HTMLElement>('[data-type]').forEach((b) => b.addEventListener('click', () => resolve({ kind: 'setup', type: b.dataset.type as WorkoutType })));
  });
}

// ---- workout setup -----------------------------------------------------------------------------------

export async function setup(env: GameEnv, type: WorkoutType): Promise<MenuAction | null> {
  const prefs = store.prefs();
  const d = WORKOUTS[type];
  let songs = await listSongs();
  if (!d.lengths.includes(prefs.minutes[type]) && !ALL_LENGTHS.includes(prefs.minutes[type])) prefs.minutes[type] = d.def;
  const render = () => {
    const minutes = prefs.minutes[type];
    const steps = program(type, minutes, { lowImpact: prefs.lowImpact });
    const moves = [...new Set(steps.map((s) => s.move))].filter((m) => MOVE[m].kind !== 'rest');
    const weight = store.profile().weightKg;
    const estKcal = Math.round(steps.reduce((a, st) => a + kcal(effectiveMet(MOVE[st.move].met, 0.85), weight, st.sec), 0));
    const avgMet = steps.reduce((a, st) => a + MOVE[st.move].met * st.sec, 0) / Math.max(1, steps.reduce((a, st) => a + st.sec, 0));
    const level = avgMet < 3.2 ? 1 : avgMet < 4.3 ? 2 : avgMet < 5.4 ? 3 : avgMet < 6.5 ? 4 : 5;
    const best = bests.get(`fit:${type}:${minutes}`);
    const el = html(`
      <div class="screen fit fit-setup" style="--c1:${d.colors[0]};--c2:${d.colors[1]}">
        <div class="fit-bg"><i></i><i></i></div>
        ${topbar(d.name)}
        <div class="fs-body">
          <div class="fs-hero glass">
            <div class="fs-art">${d.show.map((m) => `<img src="${pictogram(m)}" alt="">`).join('')}</div>
            <div class="fs-desc">${esc(d.desc)}</div>
            <div class="fs-facts">
              <div><b>${minutes}</b><span>minutes</span></div>
              <div><b>≈ ${estKcal}</b><span>kcal · estimate</span></div>
              <div><b class="fs-level">${'<i class="on"></i>'.repeat(level)}${'<i></i>'.repeat(5 - level)}</b><span>intensity</span></div>
              <div><b>${moves.length}</b><span>moves</span></div>
            </div>
            <div class="fs-moves-h">Moves in this workout</div>
            <div class="fs-moves">${moves
              .map((m) => {
                const [c1, c2] = kindColors(m);
                return `<span class="fs-chip" style="--c1:${c1};--c2:${c2}"><img src="${pictogram(m, 72, 84)}" alt="">${esc(MOVE[m].name)}</span>`;
              })
              .join('')}</div>
          </div>
          <div class="fs-side glass">
            <div class="fs-row"><div class="set-label">Length</div><div class="seg">${(d.lengths.includes(minutes) ? d.lengths : [...d.lengths, minutes].sort((a, b) => a - b))
              .map((m) => `<button class="btn sm ${m === minutes ? 'on' : ''}" data-hc data-min="${m}">${m} min</button>`)
              .join('')}</div></div>
            <div class="fs-row"><div class="set-label">Impact</div><div class="seg">
              <button class="btn sm ${!prefs.lowImpact ? 'on' : ''}" data-hc data-low="0">Standard</button>
              <button class="btn sm ${prefs.lowImpact ? 'on' : ''}" data-hc data-low="1">Low impact · no jumps</button></div></div>
            <div class="fs-row"><div class="set-label">Coach</div><div class="seg">${(Object.keys(COACHES) as CoachId[])
              .map((c) => `<button class="btn sm ${prefs.coach === c ? 'on' : ''}" data-hc data-coach="${c}">${COACHES[c].name}</button>`)
              .join('')}</div></div>
            <div class="fs-row"><div class="set-label">Music</div><div class="fs-music">
              <button class="btn sm ${prefs.music === 'auto' ? 'on' : ''}" data-hc data-song="auto">♫ Auto mix</button>
              ${songs.map((s) => `<button class="btn sm ${prefs.music === s.id ? 'on' : ''}" data-hc data-song="${s.id}">${esc(s.title)}${s.bpm ? ` · ${Math.round(s.bpm)}` : ''}${s.duration ? ` · ${fmtTime(s.duration)}` : ''}</button>`).join('')}
              <label class="btn sm ghost">${ICONS.plus} Add a song<input type="file" accept="audio/*" hidden></label>
            </div></div>
            <div class="fs-best">${best ? `Best: <b>${best.score.toLocaleString('en-US')}</b> ${STAR(best.stars ?? 0)}` : 'No score yet at this length'}</div>
            <button class="btn primary big" data-hc data-act="start">${ICONS.play} Start · ${minutes} min</button>
          </div>
        </div>
      </div>`);
    return el;
  };
  return new Promise((resolve) => {
    let shown = false;
    const show = () => {
      const el = render();
      mount(env.root, el);
      // Only the first render fades in; re-renders after a tap must not flash.
      if (shown) el.style.animation = 'none';
      shown = true;
      env.cursor(true);
      const save = () => (store.savePrefs(prefs), show());
      el.querySelector('[data-act=back]')!.addEventListener('click', () => resolve(null));
      el.querySelector('[data-act=start]')!.addEventListener('click', () => {
        prefs.type = type;
        store.savePrefs(prefs);
        resolve({ kind: 'start', type, minutes: prefs.minutes[type], planned: false });
      });
      el.querySelectorAll<HTMLElement>('[data-min]').forEach((b) => b.addEventListener('click', () => ((prefs.minutes[type] = Number(b.dataset.min)), save())));
      el.querySelectorAll<HTMLElement>('[data-low]').forEach((b) => b.addEventListener('click', () => ((prefs.lowImpact = b.dataset.low === '1'), save())));
      el.querySelectorAll<HTMLElement>('[data-coach]').forEach((b) => b.addEventListener('click', () => ((prefs.coach = b.dataset.coach as CoachId), save())));
      el.querySelectorAll<HTMLElement>('[data-song]').forEach((b) => b.addEventListener('click', () => ((prefs.music = b.dataset.song!), save())));
      const input = el.querySelector('input[type=file]') as HTMLInputElement;
      input.addEventListener('change', async () => {
        const f = input.files?.[0];
        if (!f) return;
        const s = await addDeviceSong(f);
        prefs.music = s.id;
        songs = await listSongs();
        save();
      });
    };
    show();
  });
}

/** Songs for a workout: the chosen one, or an auto mix ordered by the workout's pace. */
export async function chooseSongs(type: WorkoutType, music: string): Promise<SongInfo[]> {
  const all = await listSongs();
  if (music !== 'auto') {
    const s = all.find((x) => x.id === music);
    if (s) return [s];
  }
  const pace = WORKOUTS[type].pace;
  const bpm = (s: SongInfo) => s.bpm ?? 120;
  const sorted = [...all].sort((a, b) => bpm(a) - bpm(b));
  if (pace === 'fast') sorted.reverse();
  if (pace === 'mixed' && sorted.length >= 3) {
    const mid = sorted.splice(Math.floor(sorted.length / 2), 1)[0];
    sorted.unshift(mid);
  }
  return sorted;
}

// ---- profile -----------------------------------------------------------------------------------------

export function profileDialog(env: GameEnv, first: boolean): Promise<Profile> {
  const p = store.profile();
  return new Promise((resolve) => {
    let shown = false;
    const show = () => {
      const lb = p.unit === 'lb';
      const wv = lb ? Math.round(p.weightKg * 2.2046) : p.weightKg;
      const el = html(`
        <div class="screen fit fit-profile">
          <div class="fit-bg"><i></i><i></i></div>
          <div class="fp-card glass">
            <div class="fp-art"><img src="${pictogram('pumps')}" alt=""><img src="${pictogram('starjump')}" alt=""></div>
            <div class="fp-form">
            <div class="fp-h">${first ? 'Welcome to Dance Fit!' : 'Your profile'}</div>
            <div class="fp-sub">Your weight is used to estimate calories. It stays on this tablet.</div>
            <div class="fp-row"><div class="set-label">Weight</div>
              <div class="stepper">
                <button class="btn sm" data-hc data-w="-5">−5</button><button class="btn sm" data-hc data-w="-1">−1</button>
                <b class="fp-big">${wv} ${lb ? 'lb' : 'kg'}</b>
                <button class="btn sm" data-hc data-w="1">+1</button><button class="btn sm" data-hc data-w="5">+5</button>
                <span class="fp-gap"></span>
                <button class="btn sm ${!lb ? 'on' : ''}" data-hc data-unit="kg">kg</button><button class="btn sm ${lb ? 'on' : ''}" data-hc data-unit="lb">lb</button>
              </div>
            </div>
            <div class="fp-row"><div class="set-label">Age <small>(optional, for heart-rate zone estimates)</small></div>
              <div class="stepper">
                <button class="btn sm" data-hc data-a="-5">−5</button><button class="btn sm" data-hc data-a="-1">−1</button>
                <b class="fp-big">${p.age ?? 'Not set'}</b>
                <button class="btn sm" data-hc data-a="1">+1</button><button class="btn sm" data-hc data-a="5">+5</button>
                <button class="btn sm ghost" data-hc data-a="clear">Skip</button>
              </div>
            </div>
            <div class="fp-row"><div class="set-label">Coach voice</div><div class="seg">
              <button class="btn sm ${p.voice ? 'on' : ''}" data-hc data-v="1">On</button><button class="btn sm ${!p.voice ? 'on' : ''}" data-hc data-v="0">Off</button></div></div>
            <button class="btn primary big" data-hc data-act="save">${first ? "Let's go" : 'Save'}</button>
            </div>
          </div>
        </div>`);
      mount(env.root, el);
      // Only the first render fades in; re-renders after a tap must not flash.
      if (shown) el.style.animation = 'none';
      shown = true;
      env.cursor(true);
      el.querySelectorAll<HTMLElement>('[data-w]').forEach((b) =>
        b.addEventListener('click', () => {
          const d = Number(b.dataset.w);
          p.weightKg = Math.max(30, Math.min(250, Math.round((p.weightKg + (p.unit === 'lb' ? d / 2.2046 : d)) * 10) / 10));
          if (p.unit === 'kg') p.weightKg = Math.round(p.weightKg);
          show();
        }),
      );
      el.querySelectorAll<HTMLElement>('[data-unit]').forEach((b) => b.addEventListener('click', () => ((p.unit = b.dataset.unit as 'kg' | 'lb'), show())));
      el.querySelectorAll<HTMLElement>('[data-a]').forEach((b) =>
        b.addEventListener('click', () => {
          const a = b.dataset.a!;
          if (a === 'clear') p.age = null;
          else p.age = Math.max(14, Math.min(95, (p.age ?? 35) + Number(a)));
          show();
        }),
      );
      el.querySelectorAll<HTMLElement>('[data-v]').forEach((b) => b.addEventListener('click', () => ((p.voice = b.dataset.v === '1'), show())));
      el.querySelector('[data-act=save]')!.addEventListener('click', () => {
        p.set = true;
        store.saveProfile(p);
        resolve(p);
      });
    };
    show();
  });
}

// ---- weekly plan -------------------------------------------------------------------------------------

const LENGTH_CYCLE = [5, 10, 15, 20, 30];

export function planScreen(env: GameEnv): Promise<void> {
  const plan: Plan = store.plan();
  const history = store.history();
  return new Promise((resolve) => {
    let shown = false;
    const show = () => {
      const today = new Date();
      const w = weekSummary(plan, history, today);
      const recent = [...history].sort((a, b) => b.ts - a.ts).slice(0, 7);
      const el = html(`
        <div class="screen fit fit-plan">
          <div class="fit-bg"><i></i><i></i></div>
          ${topbar('Weekly plan')}
          <div class="fpl-goal glass">
            <span class="set-label">Weekly goal</span>
            <div class="seg"><button class="btn sm ${plan.goalKind === 'sessions' ? 'on' : ''}" data-hc data-gk="sessions">Sessions</button><button class="btn sm ${plan.goalKind === 'minutes' ? 'on' : ''}" data-hc data-gk="minutes">Minutes</button></div>
            <div class="stepper"><button class="btn sm" data-hc data-g="-1">−</button><b>${plan.goal}${plan.goalKind === 'minutes' ? ' min' : ''}</b><button class="btn sm" data-hc data-g="1">+</button></div>
          </div>
          <div class="fpl-days">${plan.days
            .map((d, i) => {
              const wd = w.days[i];
              const c = WORKOUTS[d.type].colors;
              return `<div class="fpl-day glass ${d.on ? 'on' : 'off'} ${wd.isToday ? 'today' : ''} ${wd.done ? 'done' : ''}" style="--c1:${c[0]};--c2:${c[1]}">
                <div class="fpl-dh"><b>${DAY_NAMES[i]}</b><span>${wd.date}</span>${wd.isToday ? '<em>Today</em>' : ''}</div>
                <button class="btn sm fpl-toggle ${d.on ? 'on' : ''}" data-hc data-on="${i}">${d.on ? 'Training' : 'Rest day'}</button>
                <button class="fpl-type" data-hc data-type="${i}" ${d.on ? '' : 'disabled'}>${typeIcon(d.type)}<b>${esc(WORKOUTS[d.type].name)}</b><span>tap to change</span></button>
                <button class="btn sm fpl-min" data-hc data-min="${i}" ${d.on ? '' : 'disabled'}>⏱ ${d.minutes} min</button>
                <div class="fpl-status">${wd.done ? '✓ Done' : wd.missed ? 'Missed' : wd.future || wd.isToday ? (d.on ? 'Planned' : '') : ''}</div>
              </div>`;
            })
            .join('')}</div>
          <div class="fpl-bottom">
            <div class="fpl-stats glass">
              <div class="fpl-sh">This week</div>
              <div class="fpl-ring" style="--p:${w.progress.toFixed(3)}"><b>${Math.round(w.progress * 100)}%</b><span>${esc(w.goalText)}</span></div>
              <div class="fm-stats">
                <div><b>🔥 ${w.streak}</b><span>day streak</span></div>
                <div><b>${Math.round(w.minutes)}</b><span>minutes</span></div>
                <div><b>${Math.round(w.kcal)}</b><span>kcal · est.</span></div>
                <div><b>${w.plannedDone}/${w.planned}</b><span>planned days</span></div>
              </div>
            </div>
            <div class="fpl-hist glass">
              <div class="fpl-sh">History</div>
              ${
                recent.length
                  ? recent
                      .map((r) => {
                        const d = new Date(r.ts);
                        const c = WORKOUTS[r.type].colors;
                        return `<div class="fpl-h" style="--c1:${c[0]};--c2:${c[1]}"><i></i><b>${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</b><span>${esc(WORKOUTS[r.type].name)}</span><span>${Math.round(r.minutes)} min</span><span>${r.kcal} kcal</span>${STAR(r.stars)}</div>`;
                      })
                      .join('')
                  : '<div class="fpl-empty">Your finished workouts will show up here.</div>'
              }
            </div>
          </div>
        </div>`);
      mount(env.root, el);
      // Only the first render fades in; re-renders after a tap must not flash.
      if (shown) el.style.animation = 'none';
      shown = true;
      env.cursor(true);
      const save = () => (store.savePlan(plan), show());
      el.querySelector('[data-act=back]')!.addEventListener('click', () => resolve());
      el.querySelectorAll<HTMLElement>('[data-gk]').forEach((b) =>
        b.addEventListener('click', () => {
          const k = b.dataset.gk as Plan['goalKind'];
          if (k !== plan.goalKind) plan.goal = k === 'minutes' ? 90 : 4;
          plan.goalKind = k;
          save();
        }),
      );
      el.querySelectorAll<HTMLElement>('[data-g]').forEach((b) =>
        b.addEventListener('click', () => {
          const step = plan.goalKind === 'minutes' ? 15 : 1;
          plan.goal = Math.max(step, Math.min(plan.goalKind === 'minutes' ? 600 : 14, plan.goal + Number(b.dataset.g) * step));
          save();
        }),
      );
      el.querySelectorAll<HTMLElement>('[data-on]').forEach((b) =>
        b.addEventListener('click', () => {
          const d = plan.days[Number(b.dataset.on)];
          d.on = !d.on;
          save();
        }),
      );
      el.querySelectorAll<HTMLElement>('[data-type]').forEach((b) =>
        b.addEventListener('click', () => {
          const d = plan.days[Number(b.dataset.type)];
          d.type = WORKOUT_ORDER[(WORKOUT_ORDER.indexOf(d.type) + 1) % WORKOUT_ORDER.length];
          save();
        }),
      );
      el.querySelectorAll<HTMLElement>('[data-min]').forEach((b) =>
        b.addEventListener('click', () => {
          const d = plan.days[Number(b.dataset.min)];
          const i = LENGTH_CYCLE.indexOf(d.minutes);
          d.minutes = LENGTH_CYCLE[(i + 1) % LENGTH_CYCLE.length];
          save();
        }),
      );
    };
    show();
  });
}

// ---- results -----------------------------------------------------------------------------------------

export function results(env: GameEnv, r: SessionResult, newBest: boolean, before: WeekSummary, after: WeekSummary): Promise<string> {
  const d = WORKOUTS[r.type];
  const total = r.ratings.perfect + r.ratings.great + r.ratings.ok + r.ratings.miss || 1;
  const bar = (k: keyof SessionResult['ratings'], label: string) =>
    `<div class="fr-rb r-${k}" style="flex:${Math.max(0.001, r.ratings[k] / total)}"><span>${label}</span><b>${r.ratings[k]}</b></div>`;
  const repList = Object.entries(r.reps)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const streakUp = after.streak > before.streak;
  const title = r.completed ? (r.stars >= 3 ? 'Outstanding!' : r.stars >= 2 ? 'Great workout!' : 'Workout complete!') : 'Workout saved';
  const el = html(`
    <div class="screen fit fit-results" style="--c1:${d.colors[0]};--c2:${d.colors[1]}">
      <div class="fit-bg"><i></i><i></i></div>
      <div class="fr-card glass">
        <div class="fr-head">
          <div class="fr-grade">${esc(r.grade)}</div>
          <div class="fr-ht">
            <div class="fr-title">${title}</div>
            <div class="fr-sub">${esc(d.name)} · ${r.target} min${r.completed ? '' : ' · stopped early'}</div>
            ${STAR(r.stars)}
          </div>
          <div class="fr-score"><b>${r.score.toLocaleString('en-US')}</b><span>points${newBest ? ' · <em>New best!</em>' : ''}</span></div>
        </div>
        <div class="fr-grid">
          <div><b>${r.minutes.toFixed(1)}</b><span>minutes</span></div>
          <div><b>${r.kcal}</b><span>kcal · estimate</span></div>
          <div><b>${r.maxCombo}</b><span>best combo</span></div>
          <div><b>${Math.round(r.accuracy * 100)}%</b><span>accuracy</span></div>
        </div>
        <div class="fr-ratings">${bar('perfect', 'Perfect')}${bar('great', 'Great')}${bar('ok', 'OK')}${bar('miss', 'Miss')}</div>
        <div class="fr-reps">${repList.length ? repList.map(([k, n]) => `<span><b>${n}</b> ${esc(k)}</span>`).join('') : '<span class="muted">No rep exercises in this workout</span>'}</div>
        <div class="fr-week">
          ${weekStrip(after, true)}
          <div class="fr-wk-txt">
            <div class="${streakUp ? 'up' : ''}">🔥 <b>${after.streak}</b>-day streak${streakUp ? ' <em>+1</em>' : ''}</div>
            <div>Plan: <b>${esc(after.goalText.replace(' this week', ''))}</b> this week</div>
          </div>
        </div>
        <div class="actions">
          <button class="btn primary" data-hc data-act="again">${ICONS.replay} Do it again</button>
          <button class="btn" data-hc data-act="menu">Dance Fit menu</button>
          <button class="btn ghost" data-hc data-act="home">${ICONS.home} Home</button>
        </div>
      </div>
    </div>`);
  mount(env.root, el);
  env.cursor(true);
  return new Promise((resolve) => el.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => b.addEventListener('click', () => resolve(b.dataset.act!), { once: true })));
}
