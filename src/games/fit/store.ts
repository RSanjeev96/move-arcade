/** Dance Fit persistence: profile, weekly plan, workout history and menu preferences (localStorage, `ma.fit.*`). */
import { local } from '../../core/storage';
import type { CoachId } from './coach';
import { addRecord, defaultPlan, type Plan, type SessionRecord, type WorkoutType } from './plan';
import { WORKOUTS } from './routine';

export interface Profile {
  weightKg: number;
  age: number | null;
  unit: 'kg' | 'lb';
  voice: boolean;
  /** The player has seen and confirmed the profile. */
  set: boolean;
}

export interface Prefs {
  type: WorkoutType;
  minutes: Record<WorkoutType, number>;
  lowImpact: boolean;
  /** 'auto' or a song id. */
  music: string;
  coach: CoachId;
}

const K = {
  profile: 'ma.fit.profile',
  plan: 'ma.fit.plan',
  history: 'ma.fit.history',
  prefs: 'ma.fit.prefs',
};

const TYPES = Object.keys(WORKOUTS) as WorkoutType[];

export const store = {
  profile(): Profile {
    const p = local.get<Profile>(K.profile, { weightKg: 70, age: null, unit: 'kg', voice: true, set: false });
    p.weightKg = Math.max(30, Math.min(250, Number(p.weightKg) || 70));
    return p;
  },
  saveProfile(p: Profile): void {
    local.set(K.profile, p);
  },
  plan(): Plan {
    const def = defaultPlan();
    const p = local.get<Plan>(K.plan, def);
    if (!Array.isArray(p.days) || p.days.length !== 7) p.days = def.days;
    p.days = p.days.map((d, i) => ({
      on: !!d.on,
      type: TYPES.includes(d.type) ? d.type : def.days[i].type,
      minutes: Math.max(5, Math.min(60, Number(d.minutes) || 20)),
    }));
    if (p.goalKind !== 'minutes' && p.goalKind !== 'sessions') p.goalKind = 'sessions';
    p.goal = Math.max(1, Number(p.goal) || 4);
    return p;
  },
  savePlan(p: Plan): void {
    local.set(K.plan, p);
  },
  history(): SessionRecord[] {
    const h = local.getRaw<SessionRecord[]>(K.history, []);
    return Array.isArray(h) ? h.filter((r) => r && typeof r.date === 'string') : [];
  },
  addSession(r: SessionRecord): SessionRecord[] {
    const h = addRecord(store.history(), r);
    local.set(K.history, h);
    return h;
  },
  prefs(): Prefs {
    const minutes = Object.fromEntries(TYPES.map((t) => [t, WORKOUTS[t].def])) as Record<WorkoutType, number>;
    const p = local.get<Prefs>(K.prefs, { type: 'cardio', minutes, lowImpact: false, music: 'auto', coach: 'mia' });
    p.minutes = { ...minutes, ...p.minutes };
    if (!TYPES.includes(p.type)) p.type = 'cardio';
    if (p.coach !== 'mia' && p.coach !== 'leo') p.coach = 'mia';
    return p;
  },
  savePrefs(p: Prefs): void {
    local.set(K.prefs, p);
  },
};

/** Sample data for screenshots and tests (`seed=1`): a few past sessions this week and last. */
export function seedDemo(today: Date): void {
  const h: SessionRecord[] = [];
  const mk = (daysAgo: number, type: WorkoutType, minutes: number, kcalv: number, score: number, stars: number) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, 18, 30);
    const pad = (n: number) => String(n).padStart(2, '0');
    h.push({
      id: `seed${daysAgo}${type}`,
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      ts: d.getTime(),
      type,
      minutes,
      target: minutes,
      kcal: kcalv,
      score,
      stars,
      completed: true,
    });
  };
  // Make today a training day so the menu shows "Today's workout".
  const planD = defaultPlan();
  const todayIdx = (today.getDay() + 6) % 7;
  planD.days[todayIdx] = { on: true, type: 'cardio', minutes: 20 };
  local.set(K.plan, planD);
  for (let i = 1; i <= 16; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i, 12);
    const dow = (d.getDay() + 6) % 7;
    const plan = planD.days[dow];
    if (plan.on) mk(i, plan.type, plan.minutes, Math.round(plan.minutes * 7.4), 9000 + i * 310, i % 3 ? 3 : 2);
  }
  local.set(K.history, h);
  local.set(K.profile, { weightKg: 72, age: 38, unit: 'kg', voice: true, set: true } satisfies Profile);
}
