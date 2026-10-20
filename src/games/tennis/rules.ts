/**
 * Tennis scoring as a pure state machine: points (0/15/30/40/deuce/advantage), games, a set with a
 * tie-break, and a stand-alone match tie-break. Side 0 is the human (near court), side 1 the opponent.
 */
export type Side = 0 | 1;

export type FormatId = 'tiebreak' | 'short' | 'set';

export interface MatchFormat {
  id: FormatId;
  /** Games needed to win the set (win by two). 0 = the whole match is one tie-break. */
  games: number;
  /** Tie-break is played when both players reach this many games. */
  tiebreakAt: number;
  /** Points needed to win a tie-break (win by two). */
  tiebreakTo: number;
}

export const FORMATS: Record<FormatId, MatchFormat> = {
  tiebreak: { id: 'tiebreak', games: 0, tiebreakAt: 0, tiebreakTo: 7 },
  short: { id: 'short', games: 3, tiebreakAt: 3, tiebreakTo: 7 },
  set: { id: 'set', games: 6, tiebreakAt: 6, tiebreakTo: 7 },
};

export interface PointOutcome {
  winner: Side;
  /** Set when this point finished a game (or the tie-break). */
  gameWon?: Side;
  /** Set when this point finished the set (and so the match: matches are one set). */
  setWon?: Side;
  matchWon?: Side;
  /** A tie-break starts with the next point. */
  tiebreakStarts?: boolean;
  /** Server changed for the next point. */
  serverChanged: boolean;
  /** Was this a break of serve (receiver won the game). */
  breakOfServe?: boolean;
}

const WORDS = ['love', 'fifteen', 'thirty', 'forty'];
const LABELS = ['0', '15', '30', '40'];
const NUM_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'];

const other = (s: Side): Side => (s === 0 ? 1 : 0);

export class MatchScore {
  points: [number, number] = [0, 0];
  games: [number, number] = [0, 0];
  /** Points played in the current game or tie-break. */
  private played = 0;
  tiebreak: boolean;
  /** Server of the current game (in a tie-break: the player who served its first point). */
  private gameServer: Side;
  finished = false;
  winner: Side | null = null;
  /** Total points won, for stats. */
  totalPoints: [number, number] = [0, 0];
  readonly format: MatchFormat;

  constructor(format: MatchFormat | FormatId, firstServer: Side = 0) {
    this.format = typeof format === 'string' ? FORMATS[format] : format;
    this.gameServer = firstServer;
    this.tiebreak = this.format.games === 0;
  }

  /** Who serves the next point. */
  get server(): Side {
    if (!this.tiebreak) return this.gameServer;
    // Tie-break: first point by A, then two each, alternating.
    const k = this.played;
    return ((k + 1) >> 1) % 2 === 0 ? this.gameServer : other(this.gameServer);
  }

  get receiver(): Side {
    return other(this.server);
  }

  /** Deuce court for an even number of points played in the game, advantage court otherwise. */
  get serveSide(): 'deuce' | 'ad' {
    return this.played % 2 === 0 ? 'deuce' : 'ad';
  }

  pointWon(by: Side): PointOutcome {
    if (this.finished) return { winner: by, serverChanged: false };
    const serverBefore = this.server;
    this.totalPoints[by]++;
    this.points[by]++;
    this.played++;
    const p = this.points[by];
    const q = this.points[other(by)];
    const out: PointOutcome = { winner: by, serverChanged: false };
    if (this.tiebreak) {
      if (p >= this.format.tiebreakTo && p - q >= 2) {
        out.gameWon = by;
        this.games[by]++;
        this.finishSet(by, out);
      }
    } else if (p >= 4 && p - q >= 2) {
      out.gameWon = by;
      out.breakOfServe = by !== this.gameServer;
      this.games[by]++;
      const g = this.games[by];
      const h = this.games[other(by)];
      if (g >= this.format.games && g - h >= 2) this.finishSet(by, out);
      else {
        this.points = [0, 0];
        this.played = 0;
        this.gameServer = other(this.gameServer);
        if (this.games[0] === this.format.tiebreakAt && this.games[1] === this.format.tiebreakAt) {
          this.tiebreak = true;
          out.tiebreakStarts = true;
        }
      }
    }
    out.serverChanged = !this.finished && this.server !== serverBefore;
    return out;
  }

  private finishSet(by: Side, out: PointOutcome): void {
    out.setWon = by;
    out.matchWon = by;
    this.finished = true;
    this.winner = by;
  }

  /** Score-bug label for one side's points: 0/15/30/40/AD, or the tie-break count. */
  pointLabel(side: Side): string {
    const p = this.points[side];
    const q = this.points[other(side)];
    if (this.tiebreak) return String(p);
    if (p >= 3 && q >= 3) {
      if (p > q) return 'AD';
      return '40';
    }
    return LABELS[Math.min(p, 3)];
  }

  isDeuce(): boolean {
    return !this.tiebreak && this.points[0] >= 3 && this.points[0] === this.points[1];
  }

  advantage(): Side | null {
    if (this.tiebreak) return null;
    const [a, b] = this.points;
    if (a >= 3 && b >= 3 && Math.abs(a - b) === 1) return a > b ? 0 : 1;
    return null;
  }

  /** True when `side` wins the current game (or tie-break) by winning the next point. */
  gamePointFor(side: Side): boolean {
    const p = this.points[side] + 1;
    const q = this.points[other(side)];
    if (this.tiebreak) return p >= this.format.tiebreakTo && p - q >= 2;
    return p >= 4 && p - q >= 2;
  }

  /** True when `side` wins the set (= match) by winning the next point. */
  setPointFor(side: Side): boolean {
    if (this.finished || !this.gamePointFor(side)) return false;
    if (this.tiebreak) return true;
    const g = this.games[side] + 1;
    const h = this.games[other(side)];
    return g >= this.format.games && g - h >= 2;
  }

  matchPointFor(side: Side): boolean {
    return this.setPointFor(side);
  }

  /** Break point: the receiver wins the server's game with the next point. */
  isBreakPoint(): boolean {
    return !this.tiebreak && this.gamePointFor(this.receiver);
  }

  /** The umpire's call for the current score, server's score first (e.g. "Thirty fifteen", "Deuce"). */
  call(names: [string, string]): string {
    const s = this.server;
    const r = other(s);
    if (this.tiebreak) {
      const [a, b] = this.points;
      if (a === 0 && b === 0) return 'Tie-break';
      const hi = Math.max(a, b);
      const lo = Math.min(a, b);
      const w = (n: number) => NUM_WORDS[n] ?? String(n);
      if (a === b) return `${cap(w(a))} all`;
      return `${cap(w(hi))} ${w(lo)}, ${a > b ? names[0] : names[1]}`;
    }
    const ps = this.points[s];
    const pr = this.points[r];
    if (ps === 0 && pr === 0) return '';
    if (ps >= 3 && pr >= 3) {
      if (ps === pr) return 'Deuce';
      return `Advantage ${ps > pr ? names[s] : names[r]}`;
    }
    if (ps === pr) return `${cap(WORDS[ps])} all`;
    return `${cap(WORDS[ps])} ${WORDS[pr]}`;
  }

  /** "Game Duarte", "Game and set Duarte" etc. for an outcome. */
  static outcomeCall(o: PointOutcome, names: [string, string]): string {
    if (o.matchWon !== undefined) return `Game, set and match, ${names[o.matchWon]}`;
    if (o.gameWon !== undefined) return `Game, ${names[o.gameWon]}`;
    return '';
  }

  /** Final score line from the winner's point of view, e.g. "4–2" or "7–5" for a tie-break match. */
  scoreLine(from: Side = 0): string {
    const o = other(from);
    if (this.format.games === 0) return `${this.points[from]}–${this.points[o]}`;
    const tb = this.tiebreak && this.finished ? ` (${Math.min(this.points[0], this.points[1])})` : '';
    return `${this.games[from]}–${this.games[o]}${tb}`;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
