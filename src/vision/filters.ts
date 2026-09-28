/**
 * Signal filters for landmark streams.
 *
 * Raw MediaPipe output jitters by a few pixels every frame even when the
 * player is standing perfectly still. Naively smoothing that away also smooths
 * away the punch you are trying to detect, so the pipeline uses the One Euro
 * filter: it smooths hard at low speed and gets out of the way at high speed,
 * which is exactly the trade a fighting game wants.
 *
 * Reference: Casiez, Roussel & Vogel, "1€ Filter" (CHI 2012).
 */

/** Simple first-order low pass, used as the building block of One Euro. */
class LowPassFilter {
  private value = 0;
  private initialized = false;

  filter(input: number, alpha: number): number {
    if (!this.initialized) {
      this.value = input;
      this.initialized = true;
      return input;
    }
    this.value = alpha * input + (1 - alpha) * this.value;
    return this.value;
  }

  get last(): number {
    return this.value;
  }

  get hasValue(): boolean {
    return this.initialized;
  }

  reset(): void {
    this.initialized = false;
    this.value = 0;
  }
}

export interface OneEuroOptions {
  /**
   * Minimum cutoff frequency in Hz. Lower = smoother when still, but more lag.
   * 1.0–1.7 suits body landmarks; hands want a touch more responsiveness.
   */
  minCutoff?: number;
  /**
   * Speed coefficient. Higher = the filter opens up sooner as motion speeds up.
   * This is the knob that decides whether a fast jab survives smoothing.
   */
  beta?: number;
  /** Cutoff for the derivative estimate itself. 1.0 is almost always right. */
  derivativeCutoff?: number;
}

export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly derivativeCutoff: number;

  private readonly xFilter = new LowPassFilter();
  private readonly dxFilter = new LowPassFilter();
  private lastValue = 0;
  private hasLast = false;

  constructor(options: OneEuroOptions = {}) {
    this.minCutoff = options.minCutoff ?? 1.3;
    this.beta = options.beta ?? 0.012;
    this.derivativeCutoff = options.derivativeCutoff ?? 1;
  }

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value: number, dt: number): number {
    if (dt <= 0 || !Number.isFinite(dt)) dt = 1 / 30;

    const derivative = this.hasLast ? (value - this.lastValue) / dt : 0;
    this.lastValue = value;
    this.hasLast = true;

    const smoothedDerivative = this.dxFilter.filter(
      derivative,
      OneEuroFilter.alpha(this.derivativeCutoff, dt),
    );

    // The adaptive part: cutoff rises with speed, so fast motion passes through.
    const cutoff = this.minCutoff + this.beta * Math.abs(smoothedDerivative);
    return this.xFilter.filter(value, OneEuroFilter.alpha(cutoff, dt));
  }

  /** Smoothed velocity in units per second — free, since we compute it anyway. */
  get velocity(): number {
    return this.dxFilter.last;
  }

  reset(): void {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.hasLast = false;
    this.lastValue = 0;
  }
}

/** A One Euro filter per axis, for filtering a 3D landmark as a unit. */
export class Vector3Filter {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;
  private readonly fz: OneEuroFilter;

  readonly out = { x: 0, y: 0, z: 0 };

  constructor(options: OneEuroOptions = {}) {
    this.fx = new OneEuroFilter(options);
    this.fy = new OneEuroFilter(options);
    this.fz = new OneEuroFilter(options);
  }

  filter(x: number, y: number, z: number, dt: number): { x: number; y: number; z: number } {
    this.out.x = this.fx.filter(x, dt);
    this.out.y = this.fy.filter(y, dt);
    this.out.z = this.fz.filter(z, dt);
    return this.out;
  }

  /** Magnitude of the smoothed velocity vector. */
  get speed(): number {
    return Math.hypot(this.fx.velocity, this.fy.velocity, this.fz.velocity);
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
  }
}

/**
 * Exponential moving average with a half-life in seconds, so the smoothing
 * feels the same whether the vision loop is running at 20 Hz or 60 Hz.
 */
export class Ema {
  private value = 0;
  private initialized = false;

  constructor(private readonly halfLife: number) {}

  push(input: number, dt: number): number {
    if (!this.initialized) {
      this.value = input;
      this.initialized = true;
      return input;
    }
    const k = this.halfLife <= 0 ? 1 : 1 - Math.pow(2, -dt / this.halfLife);
    this.value += (input - this.value) * k;
    return this.value;
  }

  get current(): number {
    return this.value;
  }

  get ready(): boolean {
    return this.initialized;
  }

  reset(value = 0): void {
    this.value = value;
    this.initialized = false;
  }
}

/**
 * Debounces a boolean signal so a landmark flickering across a threshold does
 * not spam the game with guard-up / guard-down events.
 */
export class Hysteresis {
  private state: boolean;
  private heldFor = 0;

  constructor(
    private readonly onThreshold: number,
    private readonly offThreshold: number,
    /** Seconds the new value must hold before the state actually flips. */
    private readonly dwell = 0.05,
    initial = false,
  ) {
    this.state = initial;
  }

  update(value: number, dt: number): boolean {
    const wants = this.state ? value > this.offThreshold : value > this.onThreshold;
    if (wants === this.state) {
      this.heldFor = 0;
      return this.state;
    }
    this.heldFor += dt;
    if (this.heldFor >= this.dwell) {
      this.state = wants;
      this.heldFor = 0;
    }
    return this.state;
  }

  get value(): boolean {
    return this.state;
  }

  reset(state = false): void {
    this.state = state;
    this.heldFor = 0;
  }
}
