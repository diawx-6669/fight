import { createLogger } from '@/core/logger';
import { getDeviceProfile } from '@/core/device';

const log = createLogger('render');

/**
 * Canvas lifecycle.
 *
 * Handles the three things every canvas game gets wrong at least once:
 *
 * 1. **Device pixel ratio.** Drawing at CSS pixels on a 2x display gives a
 *    blurry game; drawing at 3x on a phone gives a 12 fps game. The backing
 *    store is sized from the ratio *and* the quality tier's render scale.
 *
 * 2. **Aspect ratio.** The game is composed for 16:9. On other shapes it is
 *    letterboxed rather than stretched, because a fighting game where reach
 *    depends on the window shape is not a fighting game.
 *
 * 3. **Resize storms.** Dragging a window edge fires hundreds of resize
 *    events; each one reallocating a 4K backing store drops the frame rate to
 *    nothing. Resizes are coalesced into the next animation frame.
 */

/** The reference resolution everything is authored against. */
export const DESIGN_WIDTH = 1920;
export const DESIGN_HEIGHT = 1080;
export const DESIGN_ASPECT = DESIGN_WIDTH / DESIGN_HEIGHT;

export interface Viewport {
  /** Backing store size in device pixels. */
  pixelWidth: number;
  pixelHeight: number;
  /** CSS size of the canvas element. */
  cssWidth: number;
  cssHeight: number;
  /** The letterboxed play area, in CSS pixels. */
  stageX: number;
  stageY: number;
  stageWidth: number;
  stageHeight: number;
  /** Multiply design-space coordinates by this to get CSS pixels. */
  scale: number;
  dpr: number;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;

  readonly viewport: Viewport = {
    pixelWidth: 0,
    pixelHeight: 0,
    cssWidth: 0,
    cssHeight: 0,
    stageX: 0,
    stageY: 0,
    stageWidth: 0,
    stageHeight: 0,
    scale: 1,
    dpr: 1,
  };

  /** Extra downscale from the quality tier, `(0, 1]`. */
  private renderScale = 1;

  private resizePending = false;
  private observer: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
      // The game repaints every pixel every frame, so preserving the previous
      // buffer is pure cost.
      willReadFrequently: false,
    });
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;

    this.observe();
    this.resize();
  }

  private observe(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.requestResize());
      this.observer.observe(this.canvas);
    }
    window.addEventListener('resize', this.requestResize, { passive: true });
    window.addEventListener('orientationchange', this.requestResize, { passive: true });
  }

  private readonly requestResize = (): void => {
    if (this.resizePending) return;
    this.resizePending = true;
    requestAnimationFrame(() => {
      this.resizePending = false;
      this.resize();
    });
  };

  setRenderScale(scale: number): void {
    const clamped = Math.max(0.5, Math.min(1, scale));
    if (Math.abs(clamped - this.renderScale) < 0.01) return;
    this.renderScale = clamped;
    this.resize();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.round(rect.width || window.innerWidth));
    const cssHeight = Math.max(1, Math.round(rect.height || window.innerHeight));

    const dpr = getDeviceProfile().pixelRatio * this.renderScale;
    const pixelWidth = Math.round(cssWidth * dpr);
    const pixelHeight = Math.round(cssHeight * dpr);

    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      log.debug(`resize ${cssWidth}x${cssHeight} @${dpr.toFixed(2)} → ${pixelWidth}x${pixelHeight}`);
    }

    // Letterbox: fit the 16:9 stage inside whatever shape the window is.
    const windowAspect = cssWidth / cssHeight;
    let stageWidth: number;
    let stageHeight: number;
    if (windowAspect > DESIGN_ASPECT) {
      stageHeight = cssHeight;
      stageWidth = stageHeight * DESIGN_ASPECT;
    } else {
      stageWidth = cssWidth;
      stageHeight = stageWidth / DESIGN_ASPECT;
    }

    const viewport = this.viewport;
    viewport.pixelWidth = pixelWidth;
    viewport.pixelHeight = pixelHeight;
    viewport.cssWidth = cssWidth;
    viewport.cssHeight = cssHeight;
    viewport.stageWidth = stageWidth;
    viewport.stageHeight = stageHeight;
    viewport.stageX = (cssWidth - stageWidth) / 2;
    viewport.stageY = (cssHeight - stageHeight) / 2;
    viewport.scale = stageWidth / DESIGN_WIDTH;
    viewport.dpr = dpr;
  }

  /**
   * Begins a frame: resets the transform to design space, so every draw call
   * downstream can work in a fixed 1920x1080 coordinate system.
   */
  begin(): void {
    const { ctx, viewport } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(viewport.dpr, viewport.dpr);

    // Letterbox bars.
    if (viewport.stageX > 0.5 || viewport.stageY > 0.5) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, viewport.cssWidth, viewport.cssHeight);
    }

    ctx.save();
    ctx.translate(viewport.stageX, viewport.stageY);
    ctx.scale(viewport.scale, viewport.scale);
    ctx.beginPath();
    ctx.rect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
    ctx.clip();
  }

  end(): void {
    this.ctx.restore();
  }

  /** Converts a CSS-pixel pointer position into design space. */
  toDesignSpace(clientX: number, clientY: number, out: { x: number; y: number }): void {
    const rect = this.canvas.getBoundingClientRect();
    const { viewport } = this;
    out.x = (clientX - rect.left - viewport.stageX) / viewport.scale;
    out.y = (clientY - rect.top - viewport.stageY) / viewport.scale;
  }

  /** Converts a normalised `[0, 1]` position into design space. */
  fromNormalized(nx: number, ny: number, out: { x: number; y: number }): void {
    out.x = nx * DESIGN_WIDTH;
    out.y = ny * DESIGN_HEIGHT;
  }

  dispose(): void {
    this.observer?.disconnect();
    window.removeEventListener('resize', this.requestResize);
    window.removeEventListener('orientationchange', this.requestResize);
  }
}

/**
 * An offscreen canvas for effects that need their own compositing pass,
 * kept in sync with the main renderer's size.
 */
export class OffscreenLayer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;

  private width = 0;
  private height = 0;

  constructor(private readonly scale = 1) {
    this.canvas = document.createElement('canvas');
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Offscreen 2D context unavailable');
    this.ctx = ctx;
  }

  /** Resizes to match a viewport, if needed. Returns `true` when it changed. */
  sync(viewport: Viewport): boolean {
    const width = Math.max(1, Math.round(viewport.pixelWidth * this.scale));
    const height = Math.max(1, Math.round(viewport.pixelHeight * this.scale));
    if (width === this.width && height === this.height) return false;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    return true;
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }
}
