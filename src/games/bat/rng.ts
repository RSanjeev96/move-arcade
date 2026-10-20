/** Small seeded random number generator (mulberry32) so deliveries and outcomes can be reproduced in tests. */
export class Rng {
  private s: number;
  constructor(seed = Date.now()) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number): number {
    return Math.floor(this.range(a, b + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Standard normal sample (Box–Muller). */
  gauss(mean = 0, sd = 1): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Pick a key from a weight table. */
  pick<K extends string>(weights: Partial<Record<K, number>>): K {
    const entries = Object.entries(weights) as [K, number][];
    const total = entries.reduce((s, [, w]) => s + Math.max(0, w), 0);
    let r = this.next() * total;
    for (const [k, w] of entries) {
      r -= Math.max(0, w);
      if (r <= 0) return k;
    }
    return entries[entries.length - 1][0];
  }
}
