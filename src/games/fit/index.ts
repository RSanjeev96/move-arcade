/**
 * Dance Fit: coach-led dance and fitness workouts to music, with a weekly training plan.
 * Flow: menu (today's workout, week, workout tiles) → setup → session → results; plus the plan and profile screens.
 */
import './style.css';
import { bests, loading } from '../../ui/kit';
import type { LoadedSong } from '../blade/songs';
import { loadTrack, type Track } from './music';
import type { GameEnv } from '../types';
import { Coach, type CoachId } from './coach';
import { dateKey, weekSummary, type SessionRecord, type WorkoutType } from './plan';
import { WORKOUTS, WORKOUT_ORDER } from './routine';
import { chooseSongs, menu, planScreen, profileDialog, results, setup, type MenuAction } from './screens';
import { FitSession, type SessionResult } from './session';
import { seedDemo, store } from './store';

const coaches = new Map<CoachId, Coach>();
const songCache = new Map<string, LoadedSong>();

async function getCoach(id: CoachId): Promise<Coach> {
  let c = coaches.get(id);
  if (!c) {
    c = await Coach.load(id);
    coaches.set(id, c);
  }
  return c;
}

export default async function open(env: GameEnv): Promise<void> {
  const params = env.params;
  if (params.get('seed') === '1') seedDemo(new Date());
  let autoplay = params.get('autoplay') === '1';
  let screen = params.get('screen');
  try {
    for (;;) {
      let act: MenuAction;
      if (autoplay) {
        autoplay = false;
        const wt = params.get('workout') as WorkoutType | null;
        const type = wt && WORKOUT_ORDER.includes(wt) ? wt : 'cardio';
        const minutes = Math.max(1, Math.min(60, Number(params.get('minutes')) || WORKOUTS[type].def));
        act = { kind: 'start', type, minutes, planned: false };
      } else if (screen) {
        const s = screen;
        screen = null;
        if (s === 'plan') act = { kind: 'plan' };
        else if (s === 'profile') act = { kind: 'profile' };
        else if (s === 'setup') act = { kind: 'setup', type: (params.get('workout') as WorkoutType) || 'cardio' };
        else act = await menu(env);
      } else {
        if (!store.profile().set) await profileDialog(env, true);
        act = await menu(env);
      }
      if (act.kind === 'back') return;
      if (act.kind === 'plan') {
        await planScreen(env);
        continue;
      }
      if (act.kind === 'profile') {
        await profileDialog(env, false);
        continue;
      }
      if (act.kind === 'setup') {
        const s = await setup(env, act.type);
        if (!s) continue;
        act = s;
      }
      if (act.kind === 'start') {
        const out = await workout(env, act.type, act.minutes);
        if (out === 'home') return;
      }
    }
  } finally {
    for (const c of coaches.values()) c.dispose();
    coaches.clear();
    songCache.clear();
  }
}

/** Runs a workout (with restarts and "do it again") and its results. Returns 'home' to leave the game. */
async function workout(env: GameEnv, type: WorkoutType, minutes: number): Promise<string> {
  const prefs = store.prefs();
  const lowImpact = env.params.get('lowimpact') === '1' || prefs.lowImpact;
  env.cursor(false);
  const set = loading(env.root, `Preparing ${WORKOUTS[type].name}…`);
  let tracks: Track[];
  let coach: Coach;
  try {
    const infos = await chooseSongs(type, prefs.music);
    const need = Math.max(1, Math.min(infos.length, Math.ceil(minutes / 2.1)));
    // The first song is needed to start; the others load (and are beat-analysed off-thread) during the workout.
    let first: LoadedSong | null = null;
    let firstIdx = 0;
    for (; firstIdx < infos.length && !first; firstIdx++) {
      const info = infos[firstIdx];
      try {
        set('Loading music…');
        first = songCache.get(info.id) ?? (await loadTrack(info));
        songCache.set(info.id, first);
      } catch (e) {
        console.warn('Dance Fit: skipping song', info.id, e);
      }
    }
    if (!first) throw new Error('No music could be loaded.');
    tracks = [{ info: first.info, song: first, ready: Promise.resolve(first) }];
    let chain: Promise<unknown> = Promise.resolve();
    for (const info of infos.slice(firstIdx).slice(0, need - 1)) {
      const t: Track = { info, song: songCache.get(info.id) ?? null, ready: Promise.resolve(null) };
      if (!t.song) {
        t.ready = (chain = chain.then(async () => {
          try {
            const s = await loadTrack(info);
            songCache.set(info.id, s);
            t.song = s;
            return s;
          } catch (e) {
            console.warn('Dance Fit: skipping song', info.id, e);
            t.failed = true;
            return null;
          }
        })) as Promise<LoadedSong | null>;
      } else t.ready = Promise.resolve(t.song);
      tracks.push(t);
    }
    set('Warming up the coach…');
    coach = await getCoach(env.params.get('coach') === 'leo' ? 'leo' : env.params.get('coach') === 'mia' ? 'mia' : prefs.coach);
  } catch (e) {
    set(`Could not start the workout: ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 2600));
    return 'menu';
  }
  let seed = Math.floor(Math.random() * 1e6);
  if (env.demo) seed = 11;
  for (;;) {
    const profile = store.profile();
    const host = document.createElement('div');
    host.className = 'screen game';
    env.root.replaceChildren(host);
    const session = new FitSession(
      { root: host, pose: env.pose, body: env.body, audio: env.audio, settings: env.settings, demo: env.demo, cursor: env.cursor },
      { type, minutes, lowImpact, tracks, coach, coachId: coach.id, weightKg: profile.weightKg, age: profile.age, voice: profile.voice, seed },
    );
    const out = await session.run();
    if (out.kind === 'restart') continue;
    if (out.kind === 'quit') {
      if (out.result) record(out.result);
      return 'menu';
    }
    const before = weekSummary(store.plan(), store.history(), new Date());
    const rec = record(out.result);
    const after = weekSummary(store.plan(), store.history(), new Date());
    const newBest = bests.submit(`fit:${type}:${minutes}`, { score: out.result.score, rank: out.result.grade, stars: out.result.stars });
    (window as unknown as { __lastResult?: SessionResult; __lastRecord?: SessionRecord }).__lastResult = out.result;
    (window as unknown as { __lastRecord?: SessionRecord }).__lastRecord = rec;
    const act = await results(env, out.result, newBest, before, after);
    if (act === 'again') {
      seed++;
      continue;
    }
    return act;
  }
}

function record(r: SessionResult): SessionRecord {
  const now = new Date();
  const rec: SessionRecord = {
    id: `${now.getTime().toString(36)}`,
    date: dateKey(now),
    ts: now.getTime(),
    type: r.type,
    minutes: r.minutes,
    target: r.target,
    kcal: r.kcal,
    score: r.score,
    stars: r.stars,
    completed: r.completed || r.minutes >= r.target * 0.9,
    ratings: r.ratings,
    reps: r.reps,
  };
  store.addSession(rec);
  return rec;
}
