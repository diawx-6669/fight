import { clamp } from '@/core/math';
import type { AudioEngine } from '@/audio/engine';
import type { Renderer } from '@/render/renderer';
import type { VisionSystem } from '@/vision';
import type { Progress, Settings } from '@/settings';
import type { Cursor } from './cursor';
import type { WidgetContext } from './widgets';

/**
 * Screens and navigation.
 *
 * A stack rather than a graph: every screen knows how to go *back*, and no
 * screen needs to know what is above it. With hand control this matters more
 * than usual — the open-palm "back" gesture has to do something sensible from
 * anywhere, including from screens the designer never thought about.
 *
 * Transitions are a crossfade with a short hold, run by the router rather than
 * by the screens. A screen that animates its own entrance inevitably ends up
 * fighting the one animating its exit.
 */

export type ScreenId =
  | 'boot'
  | 'menu'
  | 'mode'
  | 'character'
  | 'arena'
  | 'calibrate'
  | 'settings'
  | 'lobby'
  | 'fight'
  | 'pause'
  | 'results'
  | 'error';

/** Everything a screen is allowed to touch. */
export interface ScreenContext {
  readonly renderer: Renderer;
  readonly cursor: Cursor;
  readonly vision: VisionSystem;
  readonly audio: AudioEngine;
  settings: Settings;
  progress: Progress;

  /** Navigation. */
  push(id: ScreenId, params?: ScreenParams): void;
  replace(id: ScreenId, params?: ScreenParams): void;
  pop(): void;
  /** Clears the stack and goes to one screen. */
  reset(id: ScreenId, params?: ScreenParams): void;

  /** Persists settings and applies them across subsystems. */
  applySettings(next: Settings): void;
  saveProgress(next: Progress): void;

  /** Current screen-space widget context, rebuilt each frame by the router. */
  widgets: WidgetContext;

  /** Seconds since the app started. */
  time: number;
}

export type ScreenParams = Record<string, unknown>;

export abstract class Screen {
  abstract readonly id: ScreenId;

  /** Seconds since this screen became active. */
  protected elapsed = 0;

  /** Whether the hardware back gesture should pop this screen. */
  readonly allowBack: boolean = true;

  /** Vision mode this screen needs. The router switches on entry. */
  readonly visionMode: 'off' | 'pose' | 'hands' | 'both' = 'hands';

  constructor(protected readonly context: ScreenContext) {}

  /** Called when the screen becomes active. */
  enter(_params?: ScreenParams): void {
    this.elapsed = 0;
  }

  /** Called when the screen is left. */
  exit(): void {}

  /** Called when a screen is pushed on top of this one. */
  suspend(): void {}

  /** Called when the screen above is popped. */
  resume(): void {}

  update(dt: number): void {
    this.elapsed += dt;
  }

  abstract draw(ctx: CanvasRenderingContext2D): void;

  /** Fade-in factor for this screen's content. */
  protected get appear(): number {
    return clamp(this.elapsed / 0.3, 0, 1);
  }
}

export type ScreenFactory = (context: ScreenContext) => Screen;

interface StackEntry {
  screen: Screen;
  params?: ScreenParams;
}

export class Router {
  private readonly factories = new Map<ScreenId, ScreenFactory>();
  private readonly stack: StackEntry[] = [];

  /** Crossfade progress, `0` = settled, `1` = fully covered. */
  private transition = 0;
  private transitionDirection: 1 | -1 = -1;
  private pendingAction: (() => void) | null = null;

  constructor(private readonly context: ScreenContext) {}

  register(id: ScreenId, factory: ScreenFactory): void {
    this.factories.set(id, factory);
  }

  get current(): Screen | null {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1].screen : null;
  }

  get depth(): number {
    return this.stack.length;
  }

  /** True while a transition is covering the screen; input is ignored then. */
  get isTransitioning(): boolean {
    return this.transition > 0.01 || this.pendingAction !== null;
  }

  private create(id: ScreenId): Screen {
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`No screen registered for "${id}"`);
    return factory(this.context);
  }

  /** Queues a navigation, which runs once the fade covers the screen. */
  private schedule(action: () => void): void {
    if (this.pendingAction) return;
    this.pendingAction = action;
    this.transitionDirection = 1;
  }

  push(id: ScreenId, params?: ScreenParams): void {
    this.schedule(() => {
      this.current?.suspend();
      const screen = this.create(id);
      this.stack.push({ screen, params });
      screen.enter(params);
      this.onScreenChanged(screen);
    });
  }

  replace(id: ScreenId, params?: ScreenParams): void {
    this.schedule(() => {
      const outgoing = this.stack.pop();
      outgoing?.screen.exit();
      const screen = this.create(id);
      this.stack.push({ screen, params });
      screen.enter(params);
      this.onScreenChanged(screen);
    });
  }

  pop(): void {
    if (this.stack.length <= 1) return;
    this.schedule(() => {
      const outgoing = this.stack.pop();
      outgoing?.screen.exit();
      const next = this.current;
      if (next) {
        next.resume();
        this.onScreenChanged(next);
      }
    });
  }

  reset(id: ScreenId, params?: ScreenParams): void {
    this.schedule(() => {
      while (this.stack.length > 0) {
        const entry = this.stack.pop();
        entry?.screen.exit();
      }
      const screen = this.create(id);
      this.stack.push({ screen, params });
      screen.enter(params);
      this.onScreenChanged(screen);
    });
  }

  private onScreenChanged(screen: Screen): void {
    // Each screen declares what it needs from the camera; switching here means
    // no screen has to remember to turn the pose model off on the way out.
    void this.context.vision.setMode(screen.visionMode);
    this.context.vision.gestures.resetDwell();
  }

  update(dt: number): void {
    // Drive the transition first, so a screen never updates while covered.
    const speed = 4.2;
    this.transition = clamp(this.transition + this.transitionDirection * speed * dt, 0, 1);

    if (this.transitionDirection === 1 && this.transition >= 1 && this.pendingAction) {
      const action = this.pendingAction;
      this.pendingAction = null;
      action();
      this.transitionDirection = -1;
    }

    this.current?.update(dt);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    this.current?.draw(ctx);
  }

  /** Draws the transition curtain over everything. */
  drawTransition(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    if (this.transition <= 0.001) return;
    ctx.save();
    ctx.globalAlpha = this.transition;
    ctx.fillStyle = '#04040a';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  /** Handles the universal back action. */
  back(): void {
    const screen = this.current;
    if (!screen || !screen.allowBack) return;
    this.pop();
  }
}
