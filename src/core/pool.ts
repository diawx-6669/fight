/**
 * Object pooling.
 *
 * Particles and hit sparks are created by the hundred every second; letting the
 * garbage collector deal with that shows up as a stutter exactly when the
 * screen is busiest. Pools trade a little memory for a flat frame time.
 */
export class Pool<T> {
  private readonly items: T[] = [];
  private readonly factory: () => T;
  private readonly reset: (item: T) => void;
  private readonly maxRetained: number;

  /** Total objects handed out — a leak shows up as this climbing forever. */
  private liveCount = 0;

  constructor(factory: () => T, reset: (item: T) => void, prewarm = 0, maxRetained = 4096) {
    this.factory = factory;
    this.reset = reset;
    this.maxRetained = maxRetained;
    for (let i = 0; i < prewarm; i++) this.items.push(factory());
  }

  acquire(): T {
    this.liveCount++;
    const item = this.items.pop();
    return item !== undefined ? item : this.factory();
  }

  release(item: T): void {
    this.liveCount = Math.max(0, this.liveCount - 1);
    if (this.items.length >= this.maxRetained) return;
    this.reset(item);
    this.items.push(item);
  }

  releaseAll(items: T[]): void {
    for (let i = 0; i < items.length; i++) this.release(items[i]);
    items.length = 0;
  }

  get pooled(): number {
    return this.items.length;
  }

  get live(): number {
    return this.liveCount;
  }

  drain(): void {
    this.items.length = 0;
  }
}

/**
 * A fixed-capacity ring buffer.
 *
 * The motion analysers need "the last N frames of this joint" constantly;
 * a ring avoids the array churn of shift/push windows.
 */
export class RingBuffer<T> {
  private readonly buffer: (T | undefined)[];
  private writeIndex = 0;
  private filled = 0;

  constructor(readonly capacity: number) {
    this.buffer = new Array<T | undefined>(capacity);
  }

  push(value: T): void {
    this.buffer[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  /** `at(0)` is the most recent entry, `at(1)` the one before it. */
  at(offset: number): T | undefined {
    if (offset < 0 || offset >= this.filled) return undefined;
    const index = (this.writeIndex - 1 - offset + this.capacity * 2) % this.capacity;
    return this.buffer[index];
  }

  get newest(): T | undefined {
    return this.at(0);
  }

  get oldest(): T | undefined {
    return this.at(this.filled - 1);
  }

  get size(): number {
    return this.filled;
  }

  get isFull(): boolean {
    return this.filled === this.capacity;
  }

  /** Iterates newest → oldest, stopping early if the callback returns `false`. */
  forEach(callback: (value: T, offset: number) => boolean | void): void {
    for (let i = 0; i < this.filled; i++) {
      const value = this.at(i);
      if (value === undefined) continue;
      if (callback(value, i) === false) return;
    }
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.filled; i++) {
      const value = this.at(i);
      if (value !== undefined) out.push(value);
    }
    return out;
  }

  clear(): void {
    this.buffer.fill(undefined);
    this.writeIndex = 0;
    this.filled = 0;
  }
}

/** Ring buffer specialised for numbers — no boxing, with running statistics. */
export class NumericRing {
  private readonly buffer: Float64Array;
  private writeIndex = 0;
  private filled = 0;

  constructor(readonly capacity: number) {
    this.buffer = new Float64Array(capacity);
  }

  push(value: number): void {
    this.buffer[this.writeIndex] = value;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  at(offset: number): number {
    if (offset < 0 || offset >= this.filled) return 0;
    const index = (this.writeIndex - 1 - offset + this.capacity * 2) % this.capacity;
    return this.buffer[index];
  }

  get size(): number {
    return this.filled;
  }

  get isFull(): boolean {
    return this.filled === this.capacity;
  }

  mean(): number {
    if (this.filled === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.filled; i++) sum += this.at(i);
    return sum / this.filled;
  }

  max(): number {
    let best = -Infinity;
    for (let i = 0; i < this.filled; i++) best = Math.max(best, this.at(i));
    return this.filled === 0 ? 0 : best;
  }

  min(): number {
    let best = Infinity;
    for (let i = 0; i < this.filled; i++) best = Math.min(best, this.at(i));
    return this.filled === 0 ? 0 : best;
  }

  clear(): void {
    this.buffer.fill(0);
    this.writeIndex = 0;
    this.filled = 0;
  }
}
