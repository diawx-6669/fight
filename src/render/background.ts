import { clamp, TAU } from '@/core/math';
import { Rng, hashSeed } from '@/core/rng';
import { generateLayerHeights, type Arena, type ArenaLayer } from '@/game/arenas';
import type { Camera2D } from './camera2d';
import { HORIZON_Y } from './camera2d';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from './renderer';
import { alpha, mix } from './theme';

/**
 * The world behind the fight.
 *
 * Every layer is a generated height field painted as a flat silhouette, with
 * atmospheric haze mixed in by distance. The result reads as depth without a
 * single texture, and — more importantly — without ever competing with the
 * fighters for the eye. Anything in this file that started looking interesting
 * got darker until it stopped.
 *
 * Layers are pre-rendered to offscreen canvases once per arena. Regenerating a
 * 2000-point polygon every frame for six layers is the kind of thing that works
 * fine on a development machine and stutters badly on a laptop.
 */

const SAMPLES = 480;

interface BakedLayer {
  readonly layer: ArenaLayer;
  readonly canvas: HTMLCanvasElement;
  /** Width of the baked strip in design pixels; it tiles horizontally. */
  readonly width: number;
}

export class BackgroundRenderer {
  private arena: Arena | null = null;
  private baked: BakedLayer[] = [];
  private maxLayers = 7;

  /** Time, for the slow drift of light and fog. */
  private time = 0;

  setArena(arena: Arena, maxLayers: number): void {
    if (this.arena?.id === arena.id && this.maxLayers === maxLayers) return;
    this.arena = arena;
    this.maxLayers = maxLayers;
    this.bake();
  }

  private bake(): void {
    const arena = this.arena;
    if (!arena) return;

    this.baked = [];
    // Keep the *nearest* layers when the budget is tight: the foreground is
    // what gives parallax its sense of speed, and the distant haze is the part
    // nobody misses.
    const layers = arena.layers.slice(-this.maxLayers);

    for (let index = 0; index < layers.length; index++) {
      const layer = layers[index];
      const heights = generateLayerHeights(arena.id, arena.layers.indexOf(layer), layer, SAMPLES);

      // The strip is drawn twice as wide as the stage so it can scroll and wrap
      // without a visible seam at any parallax factor.
      const width = Math.round(DESIGN_WIDTH * 1.5);
      const height = DESIGN_HEIGHT;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      const color = mix(layer.color, arena.lighting.skyMid, layer.haze * 0.65);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, height);

      for (let i = 0; i <= SAMPLES; i++) {
        const x = (i / SAMPLES) * width;
        const y = height - heights[i] * height;
        if (i === 0) ctx.lineTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();

      // A faint light rim along the top edge of each ridge, catching the sun.
      ctx.globalCompositeOperation = 'source-atop';
      const rim = ctx.createLinearGradient(0, 0, 0, height);
      rim.addColorStop(0, alpha(arena.lighting.sun, 0.16 * (1 - layer.haze)));
      rim.addColorStop(0.35, 'rgba(0,0,0,0)');
      ctx.fillStyle = rim;
      ctx.fillRect(0, 0, width, height);

      this.baked.push({ layer, canvas, width });
    }
  }

  update(dt: number): void {
    this.time += dt;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera2D): void {
    const arena = this.arena;
    if (!arena) return;

    this.drawSky(ctx, arena);
    this.drawSun(ctx, arena);

    for (const baked of this.baked) {
      this.drawLayer(ctx, camera, baked);
    }

    this.drawGround(ctx, camera, arena);
    this.drawFog(ctx, arena);
  }

  private drawSky(ctx: CanvasRenderingContext2D, arena: Arena): void {
    const gradient = ctx.createLinearGradient(0, 0, 0, DESIGN_HEIGHT);
    gradient.addColorStop(0, arena.lighting.skyTop);
    gradient.addColorStop(0.52, arena.lighting.skyMid);
    gradient.addColorStop(1, arena.lighting.skyBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
  }

  private drawSun(ctx: CanvasRenderingContext2D, arena: Arena): void {
    const { sunX, sunY, sunRadius, sun } = arena.lighting;
    const x = sunX * DESIGN_WIDTH;
    const y = sunY * DESIGN_HEIGHT;
    // A slow breath on the glow keeps a static sky from looking like a still.
    const pulse = 1 + Math.sin(this.time * 0.35) * 0.04;
    const radius = sunRadius * DESIGN_HEIGHT * pulse;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const halo = ctx.createRadialGradient(x, y, 0, x, y, radius * 4.5);
    halo.addColorStop(0, alpha(sun, 0.42));
    halo.addColorStop(0.28, alpha(sun, 0.12));
    halo.addColorStop(1, alpha(sun, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);

    const disc = ctx.createRadialGradient(x, y, 0, x, y, radius);
    disc.addColorStop(0, alpha('#ffffff', 0.9));
    disc.addColorStop(0.45, alpha(sun, 0.8));
    disc.addColorStop(1, alpha(sun, 0));
    ctx.fillStyle = disc;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  private drawLayer(ctx: CanvasRenderingContext2D, camera: Camera2D, baked: BakedLayer): void {
    const { layer, canvas, width } = baked;

    // Parallax: distant layers barely move, near layers race past.
    const offset = -camera.x * layer.parallax * camera.pixelsPerMetre * 0.25;
    // Wrap into `[-width, 0)` so exactly two blits always cover the stage.
    let start = offset % width;
    if (start > 0) start -= width;

    // Near layers also rise and fall slightly with the camera, which sells the
    // vertical parallax when a fighter jumps.
    const verticalShift = (camera.y - 1.1) * layer.parallax * 40;

    ctx.save();
    ctx.globalAlpha = 1;
    for (let x = start; x < DESIGN_WIDTH; x += width) {
      ctx.drawImage(canvas, x, verticalShift, width, DESIGN_HEIGHT);
    }
    ctx.restore();
  }

  private drawGround(ctx: CanvasRenderingContext2D, camera: Camera2D, arena: Arena): void {
    const horizon = HORIZON_Y + (camera.y - 1.1) * 0;
    const gradient = ctx.createLinearGradient(0, horizon - 30, 0, DESIGN_HEIGHT);
    gradient.addColorStop(0, mix(arena.lighting.ground, arena.lighting.fog, 0.35));
    gradient.addColorStop(0.2, arena.lighting.ground);
    gradient.addColorStop(1, '#000000');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, horizon, DESIGN_WIDTH, DESIGN_HEIGHT - horizon);

    // A bright line along the floor plane: the single strongest cue that the
    // fighters are standing on something rather than floating in front of a
    // painting.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const line = ctx.createLinearGradient(0, horizon - 3, 0, horizon + 10);
    line.addColorStop(0, alpha(arena.lighting.rim, 0));
    line.addColorStop(0.35, alpha(arena.lighting.rim, 0.3));
    line.addColorStop(1, alpha(arena.lighting.rim, 0));
    ctx.fillStyle = line;
    ctx.fillRect(0, horizon - 3, DESIGN_WIDTH, 13);
    ctx.restore();

    this.drawGroundReflection(ctx, camera, arena, horizon);
  }

  /** A wet-looking sheen that scrolls with the camera, for the rainy arenas. */
  private drawGroundReflection(
    ctx: CanvasRenderingContext2D,
    camera: Camera2D,
    arena: Arena,
    horizon: number,
  ): void {
    if (arena.weather !== 'rain') return;

    const rng = new Rng(hashSeed(arena.id + ':sheen'));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.12;

    for (let i = 0; i < 18; i++) {
      const baseX = rng.range(-200, DESIGN_WIDTH + 200);
      const x = baseX - ((camera.x * camera.pixelsPerMetre * 0.6) % (DESIGN_WIDTH + 400));
      const y = horizon + rng.range(12, 190);
      const width = rng.range(40, 220);
      const height = rng.range(2, 6);
      const gradient = ctx.createLinearGradient(x, y, x + width, y);
      gradient.addColorStop(0, alpha(arena.lighting.rim, 0));
      gradient.addColorStop(0.5, alpha(arena.lighting.rim, 0.6));
      gradient.addColorStop(1, alpha(arena.lighting.rim, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, width, height);
    }

    ctx.restore();
  }

  /** Low-lying fog drifting across the floor, behind the fighters. */
  private drawFog(ctx: CanvasRenderingContext2D, arena: Arena): void {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';

    for (let band = 0; band < 3; band++) {
      const phase = this.time * (0.04 + band * 0.02) + band * 2.1;
      const y = HORIZON_Y - 120 + band * 54;
      const height = 150 + band * 40;
      const drift = Math.sin(phase) * 120;

      const gradient = ctx.createLinearGradient(0, y, 0, y + height);
      gradient.addColorStop(0, alpha(arena.lighting.fog, 0));
      gradient.addColorStop(0.5, alpha(arena.lighting.fog, 0.1 - band * 0.022));
      gradient.addColorStop(1, alpha(arena.lighting.fog, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(drift - 200, y, DESIGN_WIDTH + 400, height);
    }

    ctx.restore();
  }

  /** Brightens the whole backdrop for a moment — used on a knockout. */
  flash(ctx: CanvasRenderingContext2D, strength: number, color: string): void {
    const clamped = clamp(strength, 0, 1);
    if (clamped <= 0.01) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamped * 0.4;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
    ctx.restore();
  }
}
