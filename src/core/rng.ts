/**
 * Seeded pseudo-random number generation.
 *
 * Online matches replay the same simulation on both machines, so every random
 * decision — AI feints, particle jitter, crowd chatter — must come from a
 * seeded stream rather than `Math.random()`. Each subsystem takes its own
 * `Rng` so that adding a particle never desyncs the AI.
 */

/** Mulberry32 — 32 bits of state, excellent distribution, very fast. */
export class Rng {
  private state: number;
  readonly seed: number;

  constructor(seed: number = Date.now() >>> 0) {
    this.seed = seed >>> 0;
    this.state = this.seed;
  }

  /** Uniform float in `[0, 1)`. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in `[min, max)`. */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in `[min, max]` inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** `true` with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /** Uniform float in `[-magnitude, magnitude)`. */
  spread(magnitude: number): number {
    return this.range(-magnitude, magnitude);
  }

  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }

  /** Picks an index according to relative weights. */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += Math.max(0, weights[i]);
    if (total <= 0) return 0;
    let roll = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= Math.max(0, weights[i]);
      if (roll <= 0) return i;
    }
    return weights.length - 1;
  }

  /** Fisher–Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
    return items;
  }

  /** Standard normal via Box–Muller (single sample, second one discarded). */
  gaussian(mean = 0, stdDev = 1): number {
    const u = Math.max(this.next(), 1e-9);
    const v = this.next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** A child stream derived from this one — same seed in, same children out. */
  fork(): Rng {
    return new Rng((this.state ^ Math.imul(this.state, 0x9e3779b9)) >>> 0);
  }

  /** Restores a stream to a known point (used when rolling back netplay). */
  restore(state: number): void {
    this.state = state >>> 0;
  }

  snapshot(): number {
    return this.state >>> 0;
  }
}

/** Hashes a string into a 32-bit seed so match IDs can seed a match. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Shared stream for purely cosmetic randomness that never affects the sim. */
export const cosmeticRng = new Rng(0xc0ffee);
