import { clamp } from './math';

/**
 * Fixed-timestep game loop.
 *
 * The simulation must advance in identical discrete steps on every machine for
 * netplay and replays to line up, so `update` is called at a constant rate
 * while `render` is called once per animation frame with an interpolation
 * factor for smooth motion between steps.
 */

export interface LoopStats {
  /** Smoothed frames per second of the render callback. */
  fps: number;
  /** Simulation steps executed in the last frame. */
  steps: number;
  /** Milliseconds spent inside `update` last frame. */
  updateMs: number;
  /** Milliseconds spent inside `render` last frame. */
  renderMs: number;
  /** Total simulation steps since the loop started. */
  frame: number;
}

export interface LoopOptions {
  /** Simulation steps per second. 60 is the canonical fighting-game tick. */
  hz?: number;
  /**
   * Upper bound on catch-up steps in one frame. Without it a backgrounded tab
   * returns and tries to simulate thousands of steps at once.
   */
  maxStepsPerFrame?: number;
  update: (dt: number, frame: number) => void;
  render: (alpha: number, dt: number) => void;
}

export class GameLoop {
  private readonly hz: number;
  private readonly stepMs: number;
  private readonly stepSeconds: number;
  private readonly maxStepsPerFrame: number;
  private readonly updateFn: (dt: number, frame: number) => void;
  private readonly renderFn: (alpha: number, dt: number) => void;

  private rafId = 0;
  private running = false;
  private lastTime = 0;
  private accumulator = 0;
  private frame = 0;
  private fpsAccumulator = 0;

  readonly stats: LoopStats = {
    fps: 0,
    steps: 0,
    updateMs: 0,
    renderMs: 0,
    frame: 0,
  };

  /** Global slow-motion multiplier. 1 = realtime, 0.25 = dramatic knockout. */
  timeScale = 1;

  constructor(options: LoopOptions) {
    this.hz = options.hz ?? 60;
    this.stepMs = 1000 / this.hz;
    this.stepSeconds = 1 / this.hz;
    this.maxStepsPerFrame = options.maxStepsPerFrame ?? 5;
    this.updateFn = options.update;
    this.renderFn = options.render;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Drops accumulated time — call after a long pause so the sim doesn't sprint. */
  resync(): void {
    this.lastTime = performance.now();
    this.accumulator = 0;
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    // A frame longer than 250ms means the tab was hidden or the machine stalled;
    // clamping keeps the catch-up loop bounded.
    const elapsed = clamp(now - this.lastTime, 0, 250);
    this.lastTime = now;

    // Smoothed FPS — raw per-frame deltas are far too jittery to display.
    const instantFps = elapsed > 0 ? 1000 / elapsed : 0;
    this.fpsAccumulator += (instantFps - this.fpsAccumulator) * 0.08;
    this.stats.fps = this.fpsAccumulator;

    this.accumulator += elapsed * this.timeScale;

    let steps = 0;
    const updateStart = performance.now();
    while (this.accumulator >= this.stepMs && steps < this.maxStepsPerFrame) {
      this.accumulator -= this.stepMs;
      this.updateFn(this.stepSeconds, this.frame);
      this.frame++;
      steps++;
    }
    // If we hit the cap we are hopelessly behind; discard the rest.
    if (steps >= this.maxStepsPerFrame) this.accumulator = 0;

    this.stats.updateMs = performance.now() - updateStart;
    this.stats.steps = steps;
    this.stats.frame = this.frame;

    const alpha = this.accumulator / this.stepMs;
    const renderStart = performance.now();
    this.renderFn(alpha, elapsed / 1000);
    this.stats.renderMs = performance.now() - renderStart;
  };
}
