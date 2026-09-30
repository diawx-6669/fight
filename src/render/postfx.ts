import { clamp } from '@/core/math';
import type { QualitySettings } from '@/core/device';
import { OffscreenLayer, type Viewport, DESIGN_HEIGHT, DESIGN_WIDTH } from './renderer';
import { alpha } from './theme';

/**
 * Post-processing.
 *
 * Canvas 2D has no shaders, so every effect here is a trick with compositing
 * modes and scaled blits. That constraint turned out to be a blessing: the
 * cheap versions of these effects are also the tasteful ones, and there was
 * never any temptation to bloom the entire screen into soup.
 *
 * Order matters and is fixed:
 *   bloom → chromatic aberration → vignette → grain → letterbox bars
 *
 * Bloom first because it is a lighting effect and belongs in the scene;
 * everything after it is a property of the *lens*, and lens effects go on last.
 */

export interface PostFxState {
  /** Bloom strength, `[0, 1]`. */
  bloom: number;
  /** Chromatic aberration in design pixels. Above ~6 it becomes a headache. */
  aberration: number;
  /** Vignette darkness, `[0, 1]`. */
  vignette: number;
  /** Film grain opacity, `[0, 1]`. */
  grain: number;
  /** Desaturation, `[0, 1]` — used when a fighter is nearly dead. */
  desaturation: number;
  /** Red wash strength, for critical health. */
  damageWash: number;
  /** Cinematic bars, `0` = none, `1` = full 2.39:1 crop. */
  letterbox: number;
  /**
   * Colour grade, taken from the arena.
   *
   * This is the step that makes two scenes built from the same shapes feel
   * like different places. A grade is not a tint over the whole frame — that
   * just makes everything muddy — it is a *split*: the shadows pulled one way
   * and the highlights the other. `soft-light` with the arena's key colour
   * does exactly that in one fill, because it leaves mid-greys alone and bends
   * the two ends apart.
   */
  gradeColor: string;
  gradeStrength: number;
  /** Arena exposure. Above `1` lifts the whole frame, below it pulls down. */
  exposure: number;
}

export function createPostFxState(): PostFxState {
  return {
    bloom: 0.5,
    aberration: 0,
    vignette: 0.55,
    grain: 0.05,
    desaturation: 0,
    damageWash: 0,
    letterbox: 0,
    gradeColor: '#ffffff',
    gradeStrength: 0,
    exposure: 1,
  };
}

export class PostProcessor {
  /**
   * Bloom is produced by downscaling the frame heavily, then blitting it back
   * additively. A 1/6 scale blit is a very cheap box blur with a nice falloff,
   * and at that resolution the browser's own bilinear filtering does the work
   * a separable Gaussian would otherwise cost.
   */
  private readonly bloomLayer = new OffscreenLayer(1 / 6);
  private readonly bloomLayer2 = new OffscreenLayer(1 / 14);

  private grainCanvas: HTMLCanvasElement | null = null;
  private grainOffset = 0;

  private quality: QualitySettings | null = null;

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
  }

  /**
   * Applies bloom by reading back the already-drawn frame.
   * Must be called while the canvas still holds the scene and before any UI.
   */
  applyBloom(
    ctx: CanvasRenderingContext2D,
    source: HTMLCanvasElement,
    viewport: Viewport,
    strength: number,
  ): void {
    if (!this.quality?.bloom || strength <= 0.02) return;

    this.bloomLayer.sync(viewport);
    this.bloomLayer2.sync(viewport);

    const small = this.bloomLayer;
    const smaller = this.bloomLayer2;

    small.clear();
    small.ctx.drawImage(source, 0, 0, small.size.width, small.size.height);

    // A second, smaller pass widens the halo without widening the cost.
    smaller.clear();
    smaller.ctx.drawImage(small.canvas, 0, 0, smaller.size.width, smaller.size.height);

    // Два ореола складываются в маленьком буфере, а не на экране.
    //
    // Раньше каждый блитился на полный кадр отдельно: два растягивания
    // 1/6 → 1:1 подряд, и это была одна из самых дорогих строк в игре.
    // Сложение в буфере 1/6 стоит примерно в тридцать шесть раз дешевле, а на
    // экран уходит один блит вместо двух. Картинка та же: сумма двух ореолов
    // не зависит от того, где их сложить.
    small.ctx.save();
    small.ctx.globalCompositeOperation = 'lighter';
    small.ctx.globalAlpha = clamp(strength * 0.3, 0, 0.5) / Math.max(clamp(strength * 0.42, 0, 0.6), 0.001);
    small.ctx.imageSmoothingEnabled = true;
    small.ctx.drawImage(smaller.canvas, 0, 0, small.size.width, small.size.height);
    small.ctx.restore();

    ctx.save();
    // Reset to raw device pixels: the blit is a full-frame operation and has
    // nothing to do with the design-space transform.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.globalAlpha = clamp(strength * 0.42, 0, 0.6);
    ctx.drawImage(small.canvas, 0, 0, viewport.pixelWidth, viewport.pixelHeight);
    ctx.restore();
  }

  /**
   * Lens split on impact.
   *
   * True chromatic aberration needs per-channel isolation, which Canvas 2D
   * cannot do without `ctx.filter` — and that is both unsupported in Safari
   * for a long time and ruinously slow on a full-frame blit. So this is the
   * honest approximation: the frame re-composited twice at opposite offsets,
   * tinted warm one way and cool the other. It ghosts rather than splits, but
   * at the two or three frames it actually runs for, the eye reads it the same.
   */
  applyAberration(
    ctx: CanvasRenderingContext2D,
    source: HTMLCanvasElement,
    viewport: Viewport,
    pixels: number,
  ): void {
    if (!this.quality?.chromaticAberration || pixels <= 0.2) return;

    const offset = clamp(pixels, 0, 8) * viewport.dpr;

    ctx.save();
    // Raw device pixels: this is a full-frame operation and has nothing to do
    // with the design-space transform.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(offset / (14 * viewport.dpr), 0, 0.2);

    ctx.drawImage(source, -offset, 0, viewport.pixelWidth, viewport.pixelHeight);
    ctx.drawImage(source, offset, 0, viewport.pixelWidth, viewport.pixelHeight);

    // Equal and opposite tints, so the frame gains fringing without drifting
    // towards either hue overall.
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = clamp(offset / (24 * viewport.dpr), 0, 0.12);
    ctx.fillStyle = '#ff2b3d';
    ctx.fillRect(0, 0, offset * 2, viewport.pixelHeight);
    ctx.fillStyle = '#2bd6ff';
    ctx.fillRect(viewport.pixelWidth - offset * 2, 0, offset * 2, viewport.pixelHeight);

    ctx.restore();
  }

  /** Vignette and colour grade, drawn in design space. */
  applyGrade(ctx: CanvasRenderingContext2D, state: PostFxState): void {
    // Grade before the vignette: the vignette is a property of the lens and
    // goes over a graded image, not under one.
    //
    // Gated on the tier, with the rest of the effects. That is not about cost
    // — one fill is nothing — but about what the low tier is *for*: a path
    // built only from plain source-over fills, with no blend mode a driver
    // could get wrong. When a machine shows a black screen, that path is what
    // it falls back to, and it is only worth anything if it is genuinely
    // plain.
    if (this.quality?.bloom && state.gradeStrength > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = clamp(state.gradeStrength, 0, 1);
      ctx.fillStyle = state.gradeColor;
      ctx.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
      ctx.restore();
    }

    // Exposure. Lifting uses `lighter` on a grey, which adds the same amount
    // everywhere; pulling down uses `multiply`, which takes a proportion. That
    // asymmetry is deliberate — it matches how over- and under-exposure
    // actually behave, and keeps a dark arena from going flat grey.
    const exposure = clamp(state.exposure, 0.5, 1.6);
    if (Math.abs(exposure - 1) > 0.01) {
      ctx.save();
      if (exposure > 1) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = clamp((exposure - 1) * 0.5, 0, 0.3);
        ctx.fillStyle = '#ffffff';
      } else {
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 1;
        const level = Math.round(255 * exposure);
        ctx.fillStyle = `rgb(${level}, ${level}, ${level})`;
      }
      ctx.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
      ctx.restore();
    }

    if (state.vignette > 0.02) {
      const gradient = ctx.createRadialGradient(
        DESIGN_WIDTH / 2,
        DESIGN_HEIGHT * 0.52,
        DESIGN_HEIGHT * 0.22,
        DESIGN_WIDTH / 2,
        DESIGN_HEIGHT * 0.52,
        DESIGN_WIDTH * 0.72,
      );
      gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');
      gradient.addColorStop(0.62, `rgba(0, 0, 0, ${state.vignette * 0.32})`);
      gradient.addColorStop(1, `rgba(0, 0, 0, ${state.vignette * 0.92})`);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
    }

    if (state.damageWash > 0.02) {
      // Red creeps in from the edges as health drops — readable without ever
      // covering the middle of the screen where the fight is.
      const gradient = ctx.createRadialGradient(
        DESIGN_WIDTH / 2,
        DESIGN_HEIGHT / 2,
        DESIGN_HEIGHT * 0.3,
        DESIGN_WIDTH / 2,
        DESIGN_HEIGHT / 2,
        DESIGN_WIDTH * 0.62,
      );
      gradient.addColorStop(0, 'rgba(160, 12, 32, 0)');
      gradient.addColorStop(1, `rgba(160, 12, 32, ${state.damageWash * 0.5})`);
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
      ctx.restore();
    }

    // `saturation` is one of the four non-separable blend modes, the group
    // with the patchiest history across drivers — so it goes with the tier too.
    if (this.quality?.bloom && state.desaturation > 0.02) {
      // Canvas 2D cannot desaturate directly; a grey overlay in `saturation`
      // blend mode gets close enough and costs one rect.
      ctx.save();
      ctx.globalCompositeOperation = 'saturation';
      ctx.globalAlpha = clamp(state.desaturation, 0, 1);
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
      ctx.restore();
    }
  }

  /** Film grain, from a pre-rendered noise tile scrolled each frame. */
  applyGrain(ctx: CanvasRenderingContext2D, amount: number): void {
    if (!this.quality?.grain || amount <= 0.01) return;

    const tile = this.ensureGrainTile();
    this.grainOffset = (this.grainOffset + 37) % 256;

    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = clamp(amount, 0, 0.3);
    const pattern = ctx.createPattern(tile, 'repeat');
    if (pattern) {
      ctx.translate(-this.grainOffset, (this.grainOffset * 0.7) % 256);
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, DESIGN_WIDTH + 256, DESIGN_HEIGHT + 256);
    }
    ctx.restore();
  }

  private ensureGrainTile(): HTMLCanvasElement {
    if (this.grainCanvas) return this.grainCanvas;

    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const image = ctx.createImageData(size, size);
      const data = image.data;
      for (let i = 0; i < data.length; i += 4) {
        // Grey noise: equal channels, so grain adds texture without tinting.
        const value = 110 + Math.random() * 70;
        data[i] = value;
        data[i + 1] = value;
        data[i + 2] = value;
        data[i + 3] = 255;
      }
      ctx.putImageData(image, 0, 0);
    }

    this.grainCanvas = canvas;
    return canvas;
  }

  /** Cinematic bars for intros, knockouts and results. */
  applyLetterbox(ctx: CanvasRenderingContext2D, amount: number): void {
    const clamped = clamp(amount, 0, 1);
    if (clamped <= 0.01) return;

    // 2.39:1 inside a 16:9 frame leaves this much above and below.
    const barHeight = DESIGN_HEIGHT * 0.116 * clamped;
    ctx.save();
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, DESIGN_WIDTH, barHeight);
    ctx.fillRect(0, DESIGN_HEIGHT - barHeight, DESIGN_WIDTH, barHeight);

    // A hairline of light on the inner edge, so the bars read as a frame
    // rather than as the canvas failing to fill.
    ctx.globalAlpha = clamped * 0.14;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, barHeight - 1, DESIGN_WIDTH, 1);
    ctx.fillRect(0, DESIGN_HEIGHT - barHeight, DESIGN_WIDTH, 1);
    ctx.restore();
  }

  /** Scanline overlay used on menus for a subtle CRT feel. */
  applyScanlines(ctx: CanvasRenderingContext2D, amount: number, color: string): void {
    if (amount <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = clamp(amount, 0, 0.2);
    ctx.fillStyle = alpha(color, 0.5);
    for (let y = 0; y < DESIGN_HEIGHT; y += 3) {
      ctx.fillRect(0, y, DESIGN_WIDTH, 1);
    }
    ctx.restore();
  }
}
