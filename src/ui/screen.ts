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

  /**
   * Called when settings change while this screen is live.
   *
   * Needed because a screen can hold systems that were handed a settings
   * snapshot when they were built. The fight scene is the one that matters:
   * the quality governor would step the tier down mid-round and the scene
   * would carry on at the old tier, since nothing told it. A player watching
   * the frame rate collapse would see the setting change and nothing happen.
   */
  onSettingsChanged(_settings: Settings): void {}

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

  /**
   * Called when a navigation throws. The app uses it to surface the error
   * instead of leaving the player looking at nothing.
   */
  onNavigationError: ((error: unknown, id: ScreenId) => void) | null = null;

  /** The screen a failed navigation was trying to reach. */
  private pendingId: ScreenId | null = null;

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
  private schedule(action: () => void, id: ScreenId | null = null): void {
    if (this.pendingAction) return;
    this.pendingAction = action;
    this.pendingId = id;
    this.transitionDirection = 1;
  }

  push(id: ScreenId, params?: ScreenParams): void {
    this.schedule(() => {
      this.current?.suspend();
      const screen = this.create(id);
      this.stack.push({ screen, params });
      screen.enter(params);
      this.onScreenChanged(screen);
    }, id);
  }

  replace(id: ScreenId, params?: ScreenParams): void {
    this.schedule(() => {
      const outgoing = this.stack.pop();
      outgoing?.screen.exit();
      const screen = this.create(id);
      this.stack.push({ screen, params });
      screen.enter(params);
      this.onScreenChanged(screen);
    }, id);
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
    }, id);
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
      const id = this.pendingId;
      this.pendingAction = null;
      this.pendingId = null;

      // A navigation that throws used to leave the curtain down for good: the
      // line that lifts it came after the call, and the exception skipped it.
      // The result was a black screen with nothing in the console loop to
      // report — it threw once, not every frame. Lifting the curtain in a
      // `finally` means the worst case is a visibly broken screen rather than
      // an invisible one.
      try {
        action();
      } catch (error) {
        this.onNavigationError?.(error, id ?? 'menu');
      } finally {
        this.transitionDirection = -1;
      }
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
