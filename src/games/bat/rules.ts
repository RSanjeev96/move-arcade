/** Scoring rules for each mode: cricket chase and six-hitting, baseball home run derby and a single inning. */
import type { Difficulty } from './delivery';

export type CricketMode = 'chase' | 'sixes';
export type BaseballMode = 'derby' | 'inning';
export type Mode = CricketMode | BaseballMode;

// ---- cricket ------------------------------------------------------------------------------------------

export type CricketEvent = 'dot' | 'runs' | 'four' | 'six' | 'bowled' | 'caught';

export interface CricketBall {
  event: CricketEvent;
  runs: number;
  /** Carry of the hit (m), 0 if not hit. */
  distance: number;
}

export const CHASE: Record<Difficulty, { target: number; balls: number; wickets: number }> = {
  easy: { target: 16, balls: 12, wickets: 3 },
  normal: { target: 20, balls: 12, wickets: 2 },
  hard: { target: 25, balls: 12, wickets: 2 },
};

export const SIXES_BALLS = 12;

export class CricketMatch {
  runs = 0;
  wickets = 0;
  balls = 0;
  fours = 0;
  sixes = 0;
  dots = 0;
  longest = 0;
  sixDistance = 0;
  /** Ball-by-ball symbols: "•", "1", "4", "6", "W". */
  history: string[] = [];
  readonly target: number;
  readonly maxBalls: number;
  readonly maxWickets: number;

  constructor(
    readonly mode: CricketMode,
    readonly difficulty: Difficulty,
  ) {
    const c = CHASE[difficulty];
    this.target = mode === 'chase' ? c.target : 0;
    this.maxBalls = mode === 'chase' ? c.balls : SIXES_BALLS;
    this.maxWickets = mode === 'chase' ? c.wickets : 99;
  }

  record(b: CricketBall): void {
    if (this.done) return;
    this.balls++;
    const out = b.event === 'bowled' || b.event === 'caught';
    if (out) {
      this.wickets++;
      this.history.push('W');
      return;
    }
    const runs = b.event === 'four' ? 4 : b.event === 'six' ? 6 : b.event === 'dot' ? 0 : b.runs;
    this.runs += runs;
    if (b.event === 'four') this.fours++;
    if (b.event === 'six') {
      this.sixes++;
      this.sixDistance += b.distance;
    }
    if (runs === 0) this.dots++;
    if (b.distance > 0 && (b.event === 'six' || b.event === 'four' || runs > 0)) this.longest = Math.max(this.longest, b.distance);
    this.history.push(runs === 0 ? '•' : String(runs));
  }

  get ballsLeft(): number {
    return this.maxBalls - this.balls;
  }

  /** Runs still needed (chase). */
  get need(): number {
    return Math.max(0, this.target - this.runs);
  }

  get done(): boolean {
    if (this.mode === 'chase') return this.runs >= this.target || this.wickets >= this.maxWickets || this.balls >= this.maxBalls;
    return this.balls >= this.maxBalls;
  }

  get won(): boolean {
    return this.mode === 'chase' ? this.runs >= this.target : this.sixes >= 3;
  }

  /** Overs as cricket writes them: 1.3 = one over and three balls. */
  get overs(): string {
    return `${Math.floor(this.balls / 6)}.${this.balls % 6}`;
  }

  get strikeRate(): number {
    return this.balls ? (this.runs / this.balls) * 100 : 0;
  }

  stars(): number {
    if (this.mode === 'chase') {
      if (!this.won) return 0;
      return 1 + (this.ballsLeft >= 2 ? 1 : 0) + (this.ballsLeft >= 4 && this.wickets === 0 ? 1 : 0);
    }
    return this.sixes >= 9 ? 3 : this.sixes >= 6 ? 2 : this.sixes >= 3 ? 1 : 0;
  }

  /** Headline number for best scores (higher is better). */
  score(): number {
    if (this.mode === 'chase') return this.won ? 1000 + this.ballsLeft * 50 + (this.maxWickets - this.wickets) * 20 : this.runs;
    return Math.round(this.sixDistance);
  }
}

// ---- baseball --------------------------------------------------------------------------------------

export type PitchEvent =
  | { kind: 'take'; strike: boolean }
  | { kind: 'miss' }
  | { kind: 'foul'; caught?: boolean }
  | { kind: 'inplay'; result: 'single' | 'double' | 'triple' | 'hr' | 'out'; distance: number; outKind?: string; deep?: boolean };

export interface PitchCall {
  /** Banner text: "Ball 2", "Strike 3", "Walk", "Home run!". */
  call: string;
  runs: number;
  out: boolean;
  /** The plate appearance ended (new batter / new count). */
  ended: boolean;
}

export const DERBY_OUTS = 10;
export const MERCY_RUNS = 10;

export class BaseballGame {
  balls = 0;
  strikes = 0;
  outs = 0;
  runs = 0;
  hits = 0;
  hrs = 0;
  hrDistance = 0;
  longest = 0;
  pitches = 0;
  swings = 0;
  strikeouts = 0;
  walks = 0;
  bases: [boolean, boolean, boolean] = [false, false, false];
  /** Plate appearance log: "K", "BB", "1B", "2B", "3B", "HR", "F8"… */
  history: string[] = [];
  readonly maxOuts: number;

  constructor(
    readonly mode: BaseballMode,
    readonly difficulty: Difficulty,
  ) {
    this.maxOuts = mode === 'derby' ? DERBY_OUTS : 3;
  }

  get done(): boolean {
    return this.outs >= this.maxOuts || (this.mode === 'inning' && this.runs >= MERCY_RUNS);
  }

  record(e: PitchEvent): PitchCall {
    this.pitches++;
    if (e.kind !== 'take') this.swings++;
    return this.mode === 'derby' ? this.derby(e) : this.inning(e);
  }

  private derby(e: PitchEvent): PitchCall {
    if (e.kind === 'inplay' && e.result === 'hr') {
      this.hrs++;
      this.hits++;
      this.hrDistance += e.distance;
      this.longest = Math.max(this.longest, e.distance);
      this.history.push('HR');
      return { call: 'Home run!', runs: 1, out: false, ended: true };
    }
    // Every swing that is not a home run is an out; taking a strike is too. Taking a ball is free.
    if (e.kind === 'take' && !e.strike) return { call: 'Ball', runs: 0, out: false, ended: false };
    this.outs++;
    if (e.kind === 'inplay' && e.distance > 0) this.longest = Math.max(this.longest, e.distance);
    this.history.push('O');
    const call = e.kind === 'take' ? 'Called strike · Out' : e.kind === 'miss' ? 'Swing and a miss · Out' : e.kind === 'foul' ? 'Foul · Out' : 'Out';
    return { call, runs: 0, out: true, ended: true };
  }

  private newBatter(): void {
    this.balls = 0;
    this.strikes = 0;
  }

  private advance(n: number, batter: boolean): number {
    // Move every runner (and optionally the batter) n bases; returns runs scored.
    let runs = 0;
    const b = this.bases;
    const next: [boolean, boolean, boolean] = [false, false, false];
    for (let i = 2; i >= 0; i--) {
      if (!b[i]) continue;
      const to = i + n;
      if (to >= 3) runs++;
      else next[to] = true;
    }
    if (batter) {
      if (n >= 4) runs++;
      else next[n - 1] = true;
    }
    this.bases = next;
    return runs;
  }

  private walk(): number {
    const b = this.bases;
    let runs = 0;
    if (b[0]) {
      if (b[1]) {
        if (b[2]) runs = 1;
        b[2] = true;
      }
      b[1] = true;
    }
    b[0] = true;
    return runs;
  }

  private inning(e: PitchEvent): PitchCall {
    const strikeOut = (): PitchCall => {
      this.outs++;
      this.strikeouts++;
      this.history.push('K');
      this.newBatter();
      return { call: 'Strike three!', runs: 0, out: true, ended: true };
    };
    if (e.kind === 'take') {
      if (e.strike) {
        this.strikes++;
        if (this.strikes >= 3) return strikeOut();
        return { call: `Strike ${this.strikes}`, runs: 0, out: false, ended: false };
      }
      this.balls++;
      if (this.balls >= 4) {
        const runs = this.walk();
        this.runs += runs;
        this.walks++;
        this.history.push('BB');
        this.newBatter();
        return { call: runs ? 'Walk · run scores' : 'Walk', runs, out: false, ended: true };
      }
      return { call: `Ball ${this.balls}`, runs: 0, out: false, ended: false };
    }
    if (e.kind === 'miss') {
      this.strikes++;
      if (this.strikes >= 3) return strikeOut();
      return { call: `Strike ${this.strikes}`, runs: 0, out: false, ended: false };
    }
    if (e.kind === 'foul') {
      if (e.caught) {
        this.outs++;
        this.history.push('FO');
        this.newBatter();
        return { call: 'Foul out', runs: 0, out: true, ended: true };
      }
      if (this.strikes < 2) this.strikes++;
      return { call: 'Foul ball', runs: 0, out: false, ended: false };
    }
    // Ball in play.
    this.newBatter();
    if (e.result === 'out') {
      const before = this.outs;
      this.outs++;
      let runs = 0;
      if (before < 2 && this.outs < 3) {
        if (e.outKind === 'ground') runs = this.advance(1, false);
        else if (e.deep && this.bases[2]) {
          this.bases[2] = false;
          runs = 1;
        }
      }
      this.runs += runs;
      this.history.push(e.outKind === 'ground' ? 'GO' : 'FO');
      return { call: runs ? 'Out · run scores' : 'Out', runs, out: true, ended: true };
    }
    this.hits++;
    if (e.distance > 0) this.longest = Math.max(this.longest, e.distance);
    let runs: number;
    if (e.result === 'hr') {
      runs = this.advance(4, true);
      this.hrs++;
      this.hrDistance += e.distance;
      this.history.push('HR');
    } else if (e.result === 'triple') {
      runs = this.advance(3, true);
      this.history.push('3B');
    } else if (e.result === 'double') {
      runs = this.advance(2, true);
      this.history.push('2B');
    } else {
      // Single: runners on second and third score, a runner on first goes to second.
      const b = this.bases;
      runs = (b[2] ? 1 : 0) + (b[1] ? 1 : 0);
      this.bases = [true, b[0], false];
      this.history.push('1B');
    }
    this.runs += runs;
    const name = e.result === 'hr' ? (runs === 4 ? 'Grand slam!' : 'Home run!') : e.result === 'single' ? 'Single' : e.result === 'double' ? 'Double' : 'Triple';
    return { call: runs && e.result !== 'hr' ? `${name} · ${runs} run${runs > 1 ? 's' : ''}` : name, runs, out: false, ended: true };
  }

  stars(): number {
    if (this.mode === 'derby') return this.hrs >= 10 ? 3 : this.hrs >= 6 ? 2 : this.hrs >= 3 ? 1 : 0;
    return this.runs >= 5 ? 3 : this.runs >= 3 ? 2 : this.runs >= 1 ? 1 : 0;
  }

  score(): number {
    return this.mode === 'derby' ? this.hrs * 1000 + Math.round(this.longest) : this.runs * 100 + this.hits;
  }
}
