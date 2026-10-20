/**
 * Weekly plan, workout history and streaks (pure logic; persistence lives in store.ts).
 * Weeks start on Monday. Dates are local calendar days ("YYYY-MM-DD").
 */

export type WorkoutType = 'warmup' | 'cardio' | 'hiit' | 'boxing' | 'cooldown';

export interface PlanDay {
  on: boolean;
  type: WorkoutType;
  minutes: number;
}

export interface Plan {
  /** Monday … Sunday. */
  days: PlanDay[];
  goalKind: 'minutes' | 'sessions';
  goal: number;
}

export interface SessionRecord {
  id: string;
  /** Local day key. */
  date: string;
  ts: number;
  type: WorkoutType;
  /** Workout minutes actually done (excludes pauses). */
  minutes: number;
  /** Length the player chose. */
  target: number;
  kcal: number;
  score: number;
  stars: number;
  completed: boolean;
  ratings?: { perfect: number; great: number; ok: number; miss: number };
  reps?: Record<string, number>;
}

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function defaultPlan(): Plan {
  const off = (type: WorkoutType = 'cardio', minutes = 20): PlanDay => ({ on: false, type, minutes });
  return {
    days: [
      { on: true, type: 'cardio', minutes: 20 },
      off('cooldown', 10),
      { on: true, type: 'hiit', minutes: 15 },
      off('cooldown', 10),
      { on: true, type: 'boxing', minutes: 20 },
      { on: true, type: 'cardio', minutes: 20 },
      off('cooldown', 10),
    ],
    goalKind: 'sessions',
    goal: 4,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseKey(k: string): Date {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/** Monday = 0 … Sunday = 6. */
export function dayIndex(d: Date): number {
  return (d.getDay() + 6) % 7;
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);
  return r;
}

export function weekStart(d: Date): Date {
  return addDays(d, -dayIndex(d));
}

export function planFor(plan: Plan, d: Date): PlanDay | null {
  const p = plan.days[dayIndex(d)];
  return p && p.on ? p : null;
}

export function sessionsOn(history: SessionRecord[], key: string): SessionRecord[] {
  return history.filter((s) => s.date === key);
}

export function minutesOn(history: SessionRecord[], key: string): number {
  return sessionsOn(history, key).reduce((a, s) => a + s.minutes, 0);
}

/** A planned day counts as done when the day's workout minutes reach half the planned length. */
export function dayDone(plan: Plan, history: SessionRecord[], d: Date): boolean {
  const p = planFor(plan, d);
  const min = minutesOn(history, dateKey(d));
  if (!p) return min > 0;
  return min >= Math.max(1, p.minutes * 0.5);
}

/**
 * Consecutive planned days completed, counting back from today. Unplanned days are skipped; today only breaks the
 * streak once it is over, so an unfinished planned day today does not reset it.
 */
export function streak(plan: Plan, history: SessionRecord[], today: Date): number {
  if (!plan.days.some((d) => d.on)) return 0;
  let n = 0;
  for (let i = 0; i < 400; i++) {
    const d = addDays(today, -i);
    const p = planFor(plan, d);
    if (!p) continue;
    if (dayDone(plan, history, d)) n++;
    else if (i > 0) break;
  }
  return n;
}

export interface WeekDay {
  key: string;
  label: string;
  date: number;
  planned: PlanDay | null;
  minutes: number;
  kcal: number;
  done: boolean;
  isToday: boolean;
  future: boolean;
  missed: boolean;
}

export interface WeekSummary {
  days: WeekDay[];
  minutes: number;
  kcal: number;
  sessions: number;
  planned: number;
  plannedDone: number;
  /** 0..1 toward the weekly goal. */
  progress: number;
  goalText: string;
  streak: number;
}

export function weekSummary(plan: Plan, history: SessionRecord[], today: Date): WeekSummary {
  const start = weekStart(today);
  const todayKey = dateKey(today);
  const days: WeekDay[] = [];
  let minutes = 0;
  let kcalSum = 0;
  let sessions = 0;
  let planned = 0;
  let plannedDone = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const key = dateKey(d);
    const ss = sessionsOn(history, key);
    const m = ss.reduce((a, s) => a + s.minutes, 0);
    const k = ss.reduce((a, s) => a + s.kcal, 0);
    const p = planFor(plan, d);
    const done = dayDone(plan, history, d);
    const future = key > todayKey;
    minutes += m;
    kcalSum += k;
    sessions += ss.filter((s) => s.completed).length;
    if (p) {
      planned++;
      if (done) plannedDone++;
    }
    days.push({
      key,
      label: DAY_NAMES[i],
      date: d.getDate(),
      planned: p,
      minutes: m,
      kcal: k,
      done,
      isToday: key === todayKey,
      future,
      missed: !!p && !done && key < todayKey,
    });
  }
  const have = plan.goalKind === 'minutes' ? minutes : sessions;
  const progress = plan.goal > 0 ? Math.min(1, have / plan.goal) : 0;
  const goalText =
    plan.goalKind === 'minutes' ? `${Math.round(minutes)}/${plan.goal} min this week` : `${sessions}/${plan.goal} sessions this week`;
  return { days, minutes, kcal: kcalSum, sessions, planned, plannedDone, progress, goalText, streak: streak(plan, history, today) };
}

/** Keep the history bounded. */
export function addRecord(history: SessionRecord[], r: SessionRecord, max = 300): SessionRecord[] {
  return [...history, r].sort((a, b) => a.ts - b.ts).slice(-max);
}
