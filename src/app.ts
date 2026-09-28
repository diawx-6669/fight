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
import { SettingsScreen } from '@/ui/screens/settings';

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

    this.audio.setSettings({
      master: next.masterVolume,
      music: next.musicVolume,
      sfx: next.sfxVolume,
    });
  }

  private applyProgress(next: Progress): void {
    this.progress = next;
    this.context.progress = next;
    saveProgress(next);
  }

  // --- frame ----------------------------------------------------------------

  private frame(dt: number): void {
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
    this.renderer.begin();
    beginWidgetFrame();
    this.router.draw(this.renderer.ctx);
    endWidgetFrame();

    this.cursor.draw(this.renderer.ctx);
    this.router.drawTransition(this.renderer.ctx, DESIGN_WIDTH, DESIGN_HEIGHT);
    this.renderer.end();

    // 6. The camera preview lives on its own canvas outside the design space.
    this.mirror.draw(
      this.vision.skeleton,
      this.settings.showSkeleton ? this.vision.hands.hands : null,
      this.vision.status.quality,
    );

    // 7. Performance governor.
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
