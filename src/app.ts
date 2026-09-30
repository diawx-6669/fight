import { AdaptiveQuality, getDeviceProfile, QUALITY_PRESETS } from '@/core/device';
import { GameLoop } from '@/core/loop';
import { createLogger } from '@/core/logger';
import { AudioEngine } from '@/audio/engine';
import { DESIGN_HEIGHT, DESIGN_WIDTH, Renderer } from '@/render/renderer';
import { VisionSystem } from '@/vision';
import { loadProgress, loadSettings, saveProgress, saveSettings, type Progress, type Settings } from '@/settings';
import { Cursor } from '@/ui/cursor';
import { CameraMirror } from '@/ui/mirror';
import { Router, type ScreenContext, type ScreenId, type ScreenParams } from '@/ui/screen';
import {
  beginWidgetFrame,
  endWidgetFrame,
  type WidgetContext,
} from '@/ui/widgets';
import { CalibrateScreen } from '@/ui/screens/calibrate';
import { CharacterScreen } from '@/ui/screens/character';
import { ErrorScreen } from '@/ui/screens/error';
import { FightScreen } from '@/ui/screens/fight';
import { LobbyScreen } from '@/ui/screens/lobby';
import { MenuScreen } from '@/ui/screens/menu';
import { ModeScreen } from '@/ui/screens/mode';
import { PauseScreen } from '@/ui/screens/pause';
import { ResultsScreen } from '@/ui/screens/results';
import { CasesScreen } from '@/ui/screens/cases';
import { RecordsScreen } from '@/ui/screens/records';
import { SettingsScreen } from '@/ui/screens/settings';
import { BlankFrameWatch } from '@/core/blankwatch';

const log = createLogger('app');

/**
 * The application.
 *
 * Owns the long-lived systems — renderer, camera, audio, settings — and the
 * single loop that drives them. Screens come and go; these do not.
 *
 * The loop deliberately does *not* use a fixed timestep at this level. The
 * only thing in the game that needs one is the fight simulation, and that runs
 * its own accumulator inside `FightScreen`. Menus, cursors and animations are
 * all better served by real frame time, and forcing them through a 60 Hz
 * quantiser on a 120 Hz display just makes them judder.
 */

export interface AppOptions {
  canvas: HTMLCanvasElement;
  video: HTMLVideoElement;
  mirror: HTMLCanvasElement;
  onProgress?: (stage: string, ratio: number) => void;
}

export class App {
  private readonly renderer: Renderer;
  private readonly cursor = new Cursor();
  private readonly vision: VisionSystem;
  private readonly audio = new AudioEngine();
  private readonly mirror: CameraMirror;
  private readonly router: Router;
  private readonly loop: GameLoop;
  private readonly adaptiveQuality: AdaptiveQuality;

  private settings: Settings;
  private progress: Progress;

  private time = 0;
  private hoverTarget: string | null = null;

  /** Set once the player has interacted, which is when audio may start. */
  private unlocked = false;

  private readonly context: ScreenContext;
  private readonly widgetContext: WidgetContext;
  private readonly pointerScratch = { x: 0, y: 0 };

  constructor(private readonly options: AppOptions) {
    this.settings = loadSettings();
    this.progress = loadProgress();

    this.renderer = new Renderer(options.canvas);
    this.vision = new VisionSystem({ video: options.video, onProgress: options.onProgress });
    this.mirror = new CameraMirror({ canvas: options.mirror, video: options.video });

    this.widgetContext = {
      ctx: this.renderer.ctx,
      pointer: this.cursor.state,
      dt: 1 / 60,
      setHover: (id) => {
        this.hoverTarget = id;
      },
      sound: (name) => this.audio.play(name),
    };

    this.context = {
      renderer: this.renderer,
      cursor: this.cursor,
      vision: this.vision,
      audio: this.audio,
      settings: this.settings,
      progress: this.progress,
      widgets: this.widgetContext,
      time: 0,
      push: (id, params) => this.router.push(id, params),
      replace: (id, params) => this.router.replace(id, params),
      pop: () => this.router.pop(),
      reset: (id, params) => this.router.reset(id, params),
      applySettings: (next) => this.applySettings(next),
      saveProgress: (next) => this.applyProgress(next),
    };

    this.router = new Router(this.context);
    this.router.onNavigationError = (error, id) => {
      log.error(`failed to open screen "${id}"`, error);
      this.showRuntimeError(error);
    };
    this.registerScreens();

    this.adaptiveQuality = new AdaptiveQuality(
      this.settings.quality,
      (tier) => {
        log.info(`adaptive quality → ${tier}`);
        this.applySettings({ ...this.settings, quality: tier });
      },
      this.settings.autoQuality,
    );

    this.loop = new GameLoop({
      hz: 60,
      update: () => {
        // The app's own update runs in `render` against real frame time; this
        // fixed step exists only so the loop has one, and stays empty.
      },
      render: (_alpha, dt) => this.frame(dt),
    });

    this.bindInput();

    // A restored context comes back with every cached layer invalid, so the
    // current screen is rebuilt from scratch rather than drawn into buffers
    // that no longer exist.
    this.renderer.onContextRestored = () => {
      this.router.current?.resume();
      this.blankWatch.reset();
      this.blankReported = false;
    };

    // `?safe=1` is the thing to type when the game is a black rectangle: it
    // forces the plain renderer before the first frame is ever drawn, which is
    // both an immediate workaround and a diagnosis — if it works, the fault is
    // somewhere in the effects path.
    if (this.safeMode) {
      log.warn('safe mode requested by url');
      this.adaptiveQuality.enabled = false;
      this.settings = { ...this.settings, quality: 'low', autoQuality: false };
    }

    this.applySettings(this.settings);
  }

  private registerScreens(): void {
    this.router.register('menu', (context) => new MenuScreen(context));
    this.router.register('mode', (context) => new ModeScreen(context));
    this.router.register('character', (context) => new CharacterScreen(context));
    this.router.register('calibrate', (context) => new CalibrateScreen(context));
    this.router.register('settings', (context) => new SettingsScreen(context));
    this.router.register('lobby', (context) => new LobbyScreen(context));
    this.router.register('fight', (context) => new FightScreen(context));
    this.router.register('pause', (context) => new PauseScreen(context));
    this.router.register('results', (context) => new ResultsScreen(context));
    this.router.register('cases', (context) => new CasesScreen(context));
    this.router.register('records', (context) => new RecordsScreen(context));
    this.router.register('error', (context) => new ErrorScreen(context));
  }

  // --- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    log.info('starting', getDeviceProfile().suggestedTier);

    this.wireVisionEvents();
    this.router.reset('menu');

    // The camera is requested up front so the permission prompt happens once,
    // on the title screen, rather than ambushing the player as a fight starts.
    const started = await this.vision.startCamera(this.settings.cameraDeviceId || undefined);
    if (started) await this.vision.setMode('hands');

    this.loop.start();
  }

  private wireVisionEvents(): void {
    this.vision.events.on('error', ({ title, hint }) => {
      // Never navigate on a vision problem. The game stays fully playable with
      // a mouse and keyboard, so replacing whatever the player was doing with
      // an error screen would take away more than the failure did. The message
      // is kept on `vision.status.lastError` and surfaced in place instead.
      log.warn(`vision problem: ${title} — ${hint}`);
    });
  }

  private bindInput(): void {
    const canvas = this.options.canvas;

    const toDesign = (event: PointerEvent) => {
      this.renderer.toDesignSpace(event.clientX, event.clientY, this.pointerScratch);
      return this.pointerScratch;
    };

    canvas.addEventListener('pointermove', (event) => {
      const point = toDesign(event);
      this.cursor.onPointerMove(point.x, point.y);
    });

    canvas.addEventListener('pointerdown', (event) => {
      const point = toDesign(event);
      this.cursor.onPointerDown(point.x, point.y);
      this.ensureUnlocked();
    });

    window.addEventListener('pointerup', () => this.cursor.onPointerUp());

    // Any keypress also counts as the gesture that unlocks audio.
    window.addEventListener('keydown', () => this.ensureUnlocked(), { once: false });

    // A hidden tab must not keep the camera light on or burn a phone's battery.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.vision.suspend();
        this.audio.suspend();
        this.loop.stop();
      } else {
        this.vision.resume();
        this.audio.resume();
        this.loop.resync();
        this.loop.start();
      }
    });
  }

  private ensureUnlocked(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    void this.audio.unlock().then(() => {
      this.audio.setSettings({
        master: this.settings.masterVolume,
        music: this.settings.musicVolume,
        sfx: this.settings.sfxVolume,
      });
    });
  }

  // --- settings -------------------------------------------------------------

  private applySettings(next: Settings): void {
    this.settings = next;
    this.context.settings = next;
    saveSettings(next);

    this.vision.setSensitivity(next.sensitivity);
    this.vision.setMirrored(next.mirrored);
    this.vision.setPoseRate(QUALITY_PRESETS[next.quality].visionHz);

    this.mirror.visible = next.showCamera;
    this.mirror.showSkeleton = next.showSkeleton;
    this.mirror.mirrored = next.mirrored;

    this.renderer.setRenderScale(QUALITY_PRESETS[next.quality].renderScale);
    this.adaptiveQuality.enabled = next.autoQuality;
    this.adaptiveQuality.syncTier(next.quality);

    this.audio.setSettings({
      master: next.masterVolume,
      music: next.musicVolume,
      sfx: next.sfxVolume,
    });

    // The live screen last, so anything holding a settings snapshot from when
    // it was built gets the new one. Without this the quality governor could
    // step the tier down and the fight scene would never hear about it.
    this.router.current?.onSettingsChanged(next);
  }

  private applyProgress(next: Progress): void {
    this.progress = next;
    this.context.progress = next;
    saveProgress(next);
  }

  // --- frame ----------------------------------------------------------------

  /** Consecutive frames that threw. Reset by any frame that completes. */
  private frameErrors = 0;

  /**
   * Catches a screen that is born black. See `core/blankwatch` — the short
   * version is that Canvas 2D fails silently, so the game checks its own
   * output rather than waiting for someone to report a black rectangle.
   */
  private readonly blankWatch = new BlankFrameWatch();
  private watchedScreen: unknown = null;
  private blankReported = false;

  /**
   * Whether the game has fallen back to the plain renderer.
   *
   * Set either by `?safe=1` — so a player with a black screen has something to
   * type that works immediately — or automatically the first time a screen
   * comes up black.
   */
  private safeMode = new URLSearchParams(location.search).get('safe') === '1';

  /**
   * Runs a frame, and refuses to fail silently.
   *
   * The loop re-arms its animation frame before calling this, so an exception
   * here does not stop the game — it just throws again next frame, forever,
   * leaving a black canvas and no explanation. That is the single worst
   * failure mode this app has: the player sees nothing and can report nothing.
   *
   * So a throw is caught, the canvas transform is repaired (the exception may
   * have landed between `begin` and `end`), and after a few consecutive
   * failures the game stops and says what broke.
   */
  private frame(dt: number): void {
    try {
      this.frameInner(dt);
      this.frameErrors = 0;
    } catch (error) {
      this.frameErrors++;
      log.error(`frame failed (${this.frameErrors})`, error);

      // Whatever the exception did to the save stack, put the context back
      // into a known state so the error panel is not drawn into a broken one.
      try {
        this.renderer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      } catch {
        /* nothing more to do */
      }

      if (this.frameErrors >= 5) {
        this.loop.stop();
        this.showRuntimeError(error);
      }
    }
  }

  /** Replaces the black screen with something a person can act on. */
  private showRuntimeError(error: unknown): void {
    if (document.getElementById('runtime-error')) return;

    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? '') : '';

    const container = document.createElement('div');
    container.id = 'runtime-error';
    container.className = 'fatal';

    const heading = document.createElement('h1');
    heading.textContent = 'Игра остановилась';

    const paragraph = document.createElement('p');
    paragraph.textContent =
      'Что-то сломалось внутри игры. Обнови страницу — а текст ниже покажи ' +
      'разработчику, по нему видно точное место.';

    const detail = document.createElement('code');
    // textContent, never innerHTML: this string comes from an exception and is
    // not something to hand to the HTML parser.
    detail.textContent = `${message}\n\n${stack}`.slice(0, 1200);

    container.append(heading, paragraph, detail);
    document.body.append(container);
  }

  /**
   * Tells the player their screen is black, and why it might be.
   *
   * Deliberately not fatal: the game keeps running underneath, because most
   * of the causes repair themselves within a frame or two now, and a panel
   * that can be dismissed is better than a loop that has been stopped. What
   * matters is that "the game doesn't work" becomes a sentence someone can
   * act on.
   */
  private reportBlankScreen(): void {
    // First a black screen gets one chance to fix itself.
    //
    // Nearly everything that can silently paint nothing lives in the effects
    // path — an offscreen layer that failed to allocate, a blend mode a driver
    // renders as black, a blit of the canvas onto itself. The low tier uses
    // none of it. So rather than tell the player their game is broken, the
    // game drops to the plain renderer and looks again; on the machines where
    // this happens, the plain renderer works, and the player gets a game
    // instead of an apology.
    if (!this.safeMode) {
      this.enterSafeMode('чёрный кадр');
      return;
    }

    const quality = this.settings.quality;
    const camera = this.vision.status.cameraActive ? 'камера включена' : 'камера выключена';
    const brightness = this.blankWatch.lastBrightness;
    log.error(`blank screen persists in safe mode (quality=${quality}, ${camera})`);

    if (document.getElementById('blank-screen')) return;

    const container = document.createElement('div');
    container.id = 'blank-screen';
    container.className = 'fatal';

    const heading = document.createElement('h1');
    heading.textContent = 'Экран пустой';

    const paragraph = document.createElement('p');
    paragraph.textContent =
      'Игра работает и считает кадры, но ничего не появляется — даже на самой ' +
      'простой графике. Обнови страницу. Если повторится, покажи эту табличку: ' +
      'по ней видно, на чём именно всё встало.';

    const detail = document.createElement('code');
    detail.textContent = [
      `качество: ${quality} (простая графика)`,
      camera,
      `экран: ${this.router.current?.constructor.name ?? 'нет'}`,
      `яркость кадра: ${brightness < 0 ? 'не прочиталась' : brightness.toFixed(2)}`,
      `холст: ${this.renderer.canvas.width}×${this.renderer.canvas.height} @${this.renderer.viewport.dpr.toFixed(2)}`,
      `сбоев кадра: ${this.frameErrors}`,
      this.renderer.contextLost ? 'холст потерял контекст' : 'контекст холста жив',
    ].join('\n');

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Понятно';
    dismiss.addEventListener('click', () => container.remove());

    container.append(heading, paragraph, detail, dismiss);
    document.body.append(container);
  }

  /**
   * Switches to the plain renderer and stops anything switching back.
   *
   * Automatic quality has to be turned off along with it: it samples frame
   * rate, the plain renderer is fast, and it would cheerfully climb straight
   * back into whatever was painting nothing.
   */
  private enterSafeMode(reason: string): void {
    if (this.safeMode) return;
    this.safeMode = true;
    log.warn(`safe mode: ${reason}`);

    this.adaptiveQuality.enabled = false;
    this.applySettings({ ...this.settings, quality: 'low', autoQuality: false });

    // Re-arm the watch. If the plain renderer paints, nothing more happens and
    // the player never learns any of this took place.
    this.blankWatch.reset();
    this.blankReported = false;

    // Rebuild whatever the current screen is holding, so the new tier reaches
    // the systems that only read it when they are created.
    const current = this.router.current;
    if (current) current.resume();
  }

  private frameInner(dt: number): void {
    const clamped = Math.min(dt, 0.1);
    this.time += clamped;
    this.context.time = this.time;

    // 1. Vision. Runs at its own rate internally; this is just the heartbeat.
    this.vision.update(performance.now());

    // 2. Pointer, from whichever source the player is using.
    this.cursor.update(
      this.settings.handControl ? this.vision.gesture : null,
      clamped,
      this.settings.handControl,
    );

    // 3. Dwell is resolved against whatever the *previous* frame said was under
    //    the cursor: the screen has not drawn yet, so this frame's hover target
    //    is not known. One frame of lag on a 1.1s dwell is not perceptible.
    this.vision.gestures.hover(this.hoverTarget, clamped);
    this.hoverTarget = null;

    this.widgetContext.dt = clamped;
    this.audio.update(clamped);

    // 4. Screens.
    this.router.update(clamped);

    // 5. Draw.
    this.renderer.clear();
    this.renderer.begin();
    beginWidgetFrame();
    this.router.draw(this.renderer.ctx);
    endWidgetFrame();

    this.cursor.draw(this.renderer.ctx);
    this.router.drawTransition(this.renderer.ctx, DESIGN_WIDTH, DESIGN_HEIGHT);
    this.renderer.end();

    // 6. The camera preview lives on its own canvas outside the design space.
    //    An empty black rectangle where a camera feed should be looks like a
    //    bug, so it hides itself whenever there is nothing to show.
    this.mirror.visible = this.settings.showCamera && this.vision.status.cameraActive;
    this.mirror.draw(
      this.vision.skeleton,
      this.settings.showSkeleton ? this.vision.hands.hands : null,
      this.vision.status.quality,
    );

    // 7. Did any of that actually reach the screen?
    if (this.router.current !== this.watchedScreen) {
      this.watchedScreen = this.router.current;
      this.blankWatch.reset();
      this.blankReported = false;
    }
    // A lost context is a different failure with a different fix, and the
    // browser may hand it back on its own. Watching for black through one
    // would only ever produce a wrong answer.
    if (!this.renderer.contextLost) this.blankWatch.update(this.renderer.canvas);
    if (this.blankWatch.blank && !this.blankReported) {
      this.blankReported = true;
      this.reportBlankScreen();
    }

    // 8. Performance governor.
    this.adaptiveQuality.sample(this.loop.stats.fps, performance.now());
  }

  dispose(): void {
    this.loop.stop();
    this.vision.dispose();
    this.audio.dispose();
    this.renderer.dispose();
  }

  /** Exposed for the boot sequence and for debugging from the console. */
  navigate(id: ScreenId, params?: ScreenParams): void {
    this.router.reset(id, params);
  }
}
