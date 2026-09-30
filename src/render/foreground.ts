import { Rng, hashSeed } from '@/core/rng';
import type { Arena, LayerShape } from '@/game/arenas';
import type { Camera2D } from './camera2d';
import { HORIZON_Y } from './camera2d';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from './renderer';
import { alpha, mix, Palette } from './theme';

/**
 * The world *in front of* the fight.
 *
 * Every other layer in this game sits behind the fighters, and a scene built
 * only that way always looks the same: a diorama viewed head-on from outside
 * it. What films do instead is put something between the lens and the subject
 * — a pillar, a branch, the edge of a doorway — dark, out of focus, and
 * sliding fast across the frame. The eye reads that instantly as *the camera
 * is inside this place*, and it costs two silhouettes and one blit.
 *
 * Three rules keep it from becoming clutter:
 *
 *   1. **Only at the edges.** The middle of the screen is where the fight is,
 *      and nothing is allowed to cross it. Every shape here is built between
 *      an off-frame outer edge and a fixed inner limit, so its footprint is a
 *      decision rather than an accident of whatever the motif happened to draw.
 *   2. **Almost black.** A foreground element with visible detail competes
 *      with the fighters and wins, because it is nearer. Detail is the enemy.
 *   3. **Blurred.** It is outside the focal plane, and a sharp foreground
 *      reads as a mistake rather than as depth.
 *
 * The motif comes from the arena's nearest background layer, so a forest gets
 * trunks and a temple gets columns without the arena having to say so.
 */

/** How far into the frame a foreground element may reach, in design pixels. */
const INNER_LIMIT = 250;

/** How far off frame it starts. Enough that no shape shows its outer edge. */
const OUTER_MARGIN = 120;

/** How much faster than the nearest background layer this slides. */
const PARALLAX = 1.45;

/**
 * Blur is bought by rendering small and scaling up.
 *
 * Scaling a 16%-size image back to full size is a genuine low-pass filter, and
 * a far better defocus than anything Canvas 2D offers directly: `filter` is
 * slow on large fills and was unusable in Safari for years.
 */
const BLUR_SCALE = 0.16;

export class ForegroundRenderer {
  private arena: Arena | null = null;
  private enabled = true;

  /** Baked frame in design space, clear everywhere but the two edges. */
  private canvas: HTMLCanvasElement | null = null;

  setArena(arena: Arena, enabled: boolean): void {
    if (this.arena?.id === arena.id && this.enabled === enabled) return;
    this.arena = arena;
    this.enabled = enabled;
    this.canvas = enabled ? this.bake(arena) : null;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera2D): void {
    const canvas = this.canvas;
    if (!canvas) return;

    // Slides against the camera, faster than anything behind it. The shift is
    // small in absolute terms because these shapes are wide and soft — a large
    // one would swing them across the fight, which rule 1 exists to prevent.
    const offset = -camera.x * PARALLAX * 26;
    const lift = (camera.y - 1.1) * 22;

    // Блитим только края, а не весь кадр.
    //
    // Между двумя элементами лежит пустота: середина экрана по правилу №1
    // всегда свободна, и это три четверти кадра прозрачных пикселей, которые
    // перекладывались каждый кадр впустую. Профилировщик показал `drawImage`
    // как главный расход игры, и это была одна из четырёх полноэкранных
    // операций, ни одной из которых не требовался полный экран.
    const band = INNER_LIMIT + OUTER_MARGIN + Math.abs(offset) + 8;
    const right = DESIGN_WIDTH - band;

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(canvas, 0, 0, band, DESIGN_HEIGHT, offset, lift, band, DESIGN_HEIGHT);
    ctx.drawImage(
      canvas, right, 0, band, DESIGN_HEIGHT,
      right + offset, lift, band, DESIGN_HEIGHT,
    );
    ctx.restore();
  }

  private bake(arena: Arena): HTMLCanvasElement | null {
    const small = document.createElement('canvas');
    small.width = Math.round(DESIGN_WIDTH * BLUR_SCALE);
    small.height = Math.round(DESIGN_HEIGHT * BLUR_SCALE);
    const smallCtx = small.getContext('2d');
    if (!smallCtx) return null;

    // Everything below is written in design pixels; the transform does the
    // shrinking, so the geometry never has to know about the blur.
    smallCtx.setTransform(BLUR_SCALE, 0, 0, BLUR_SCALE, 0, 0);

    // Near-black, but carrying a trace of the arena's own ground colour so the
    // shape belongs to the place rather than looking like a hole in the frame.
    smallCtx.fillStyle = mix(arena.lighting.ground, Palette.ink900, 0.88);

    const shape = arena.layers[arena.layers.length - 1]?.shape ?? 'mountains';
    const rng = new Rng(hashSeed(`${arena.id}:foreground`));

    this.drawSide(smallCtx, shape, 'left', rng, arena);
    this.drawSide(smallCtx, shape, 'right', rng, arena);

    const full = document.createElement('canvas');
    full.width = DESIGN_WIDTH;
    full.height = DESIGN_HEIGHT;
    const fullCtx = full.getContext('2d');
    if (!fullCtx) return null;

    fullCtx.imageSmoothingEnabled = true;
    fullCtx.imageSmoothingQuality = 'low';
    fullCtx.drawImage(small, 0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
    return full;
  }

  /**
   * Draws one edge.
   *
   * Everything is expressed as `outer` (off frame) and `inner` (the limit),
   * with `sign` pointing from outer towards the middle. A motif written that
   * way is automatically correct on both sides and cannot creep into the
   * fight, whatever it draws.
   */
  private drawSide(
    ctx: CanvasRenderingContext2D,
    shape: LayerShape,
    side: 'left' | 'right',
    rng: Rng,
    arena: Arena,
  ): void {
    const sign = side === 'left' ? 1 : -1;
    const outer = side === 'left' ? -OUTER_MARGIN : DESIGN_WIDTH + OUTER_MARGIN;
    // Each side gets its own reach, so the frame is never symmetrical — which
    // is the difference between a composition and a border.
    const reach = (INNER_LIMIT + OUTER_MARGIN) * rng.range(0.82, 1.12);
    const inner = outer + sign * reach;

    switch (shape) {
      case 'forest':
        this.trunk(ctx, outer, inner, sign, rng);
        break;
      case 'temple':
        this.pillar(ctx, outer, inner, sign, rng, false);
        break;
      case 'ruins':
        this.pillar(ctx, outer, inner, sign, rng, true);
        break;
      case 'skyline':
        this.corner(ctx, outer, inner, sign, rng);
        break;
      default:
        this.crest(ctx, outer, inner, sign, rng);
        break;
    }

    this.rim(ctx, inner, sign, arena);
  }

  /** A tree: a leaning trunk, plus branches across the top corner. */
  private trunk(
    ctx: CanvasRenderingContext2D,
    outer: number,
    inner: number,
    sign: number,
    rng: Rng,
  ): void {
    const lean = rng.range(-40, 40);
    // The trunk keeps clear of the limit so the branches have room inside it.
    const edge = inner - sign * 70;

    ctx.beginPath();
    ctx.moveTo(outer, DESIGN_HEIGHT + 20);
    ctx.lineTo(outer, -20);
    ctx.lineTo(edge + lean, -20);
    ctx.bezierCurveTo(
      edge + lean * 0.4, DESIGN_HEIGHT * 0.3,
      edge - sign * 30, DESIGN_HEIGHT * 0.65,
      edge + sign * 20, DESIGN_HEIGHT + 20,
    );
    ctx.closePath();
    ctx.fill();

    // Branches leave the trunk high and reach along the top of the frame. They
    // are allowed past the inner limit because they sit in the top corner,
    // where the fight never is.
    const branches = 2 + rng.int(0, 1);
    for (let i = 0; i < branches; i++) {
      const from = DESIGN_HEIGHT * rng.range(0.02, 0.26);
      const span = rng.range(240, 520);
      const drop = rng.range(-40, 90);
      const thickness = rng.range(16, 34);

      ctx.beginPath();
      ctx.moveTo(edge, from);
      ctx.quadraticCurveTo(
        edge + sign * span * 0.55, from + drop * 0.35,
        edge + sign * span, from + drop,
      );
      ctx.lineTo(edge + sign * span, from + drop + thickness * 0.6);
      ctx.quadraticCurveTo(
        edge + sign * span * 0.55, from + drop * 0.35 + thickness,
        edge, from + thickness * 2.2,
      );
      ctx.closePath();
      ctx.fill();
    }
  }

  /** A column: base, shaft, capital. Snapped off partway if this is a ruin. */
  private pillar(
    ctx: CanvasRenderingContext2D,
    outer: number,
    inner: number,
    sign: number,
    rng: Rng,
    broken: boolean,
  ): void {
    const top = broken ? DESIGN_HEIGHT * rng.range(0.16, 0.38) : -20;
    const shaftEdge = inner - sign * 46;

    // A very slight taper — entasis, the reason a real column does not read as
    // a length of pipe.
    ctx.beginPath();
    ctx.moveTo(outer, DESIGN_HEIGHT + 20);
    ctx.lineTo(outer, top);
    ctx.lineTo(shaftEdge - sign * 14, top);
    ctx.lineTo(shaftEdge, DESIGN_HEIGHT + 20);
    ctx.closePath();
    ctx.fill();

    if (broken) {
      // A jagged crown, so the break does not read as a clean cut.
      ctx.beginPath();
      ctx.moveTo(outer, top + 40);
      const steps = 6;
      for (let i = 0; i <= steps; i++) {
        const x = outer + ((shaftEdge - outer) * i) / steps;
        ctx.lineTo(x, top + rng.range(-34, 22));
      }
      ctx.lineTo(shaftEdge, top + 40);
      ctx.closePath();
      ctx.fill();

      // Rubble at the foot of it.
      const baseY = DESIGN_HEIGHT * 0.88;
      ctx.beginPath();
      ctx.moveTo(outer, DESIGN_HEIGHT + 20);
      ctx.lineTo(outer, baseY);
      for (let i = 1; i <= 4; i++) {
        ctx.lineTo(
          outer + sign * (rng.range(40, 130) * i),
          baseY + rng.range(10, 70),
        );
      }
      ctx.lineTo(inner + sign * 40, DESIGN_HEIGHT + 20);
      ctx.closePath();
      ctx.fill();
      return;
    }

    // Base, and the capital with the eave it carries off the top of frame.
    const baseY = DESIGN_HEIGHT * 0.84;
    this.span(ctx, outer, inner + sign * 26, baseY, DESIGN_HEIGHT - baseY + 20);
    this.span(ctx, outer, inner + sign * 34, 62, 48);
    this.span(ctx, outer, inner + sign * 90, -20, 78);
  }

  /** The corner of a building, with a few unlit windows cut out of it. */
  private corner(
    ctx: CanvasRenderingContext2D,
    outer: number,
    inner: number,
    sign: number,
    rng: Rng,
  ): void {
    const top = DESIGN_HEIGHT * rng.range(-0.04, 0.1);
    this.span(ctx, outer, inner, top, DESIGN_HEIGHT - top + 20);

    // Cut out rather than painted on: a hole shows the sky, which is what an
    // unlit window against a bright sky actually looks like.
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    const width = 52;
    const height = 74;
    for (let column = 0; column < 2; column++) {
      for (let row = 0; row < 9; row++) {
        if (rng.range(0, 1) < 0.34) continue;
        const x = inner - sign * (90 + column * 110) - (sign > 0 ? width : 0);
        const y = top + 110 + row * height * 1.9;
        if (y + height > DESIGN_HEIGHT) break;
        ctx.fillRect(x, y, width, height);
      }
    }
    ctx.restore();
  }

  /** A rock or dune shoulder rising out of the bottom corner. */
  private crest(
    ctx: CanvasRenderingContext2D,
    outer: number,
    inner: number,
    sign: number,
    rng: Rng,
  ): void {
    const peak = HORIZON_Y - rng.range(90, 230);

    ctx.beginPath();
    ctx.moveTo(outer, DESIGN_HEIGHT + 20);
    ctx.lineTo(outer, peak);
    ctx.bezierCurveTo(
      outer + sign * 60, peak - rng.range(0, 40),
      inner - sign * 90, peak + 40,
      inner, DESIGN_HEIGHT * 0.74,
    );
    ctx.lineTo(inner, DESIGN_HEIGHT + 20);
    ctx.closePath();
    ctx.fill();
  }

  /** A horizontal slab from the outer edge to `to`. */
  private span(
    ctx: CanvasRenderingContext2D,
    outer: number,
    to: number,
    y: number,
    height: number,
  ): void {
    const left = Math.min(outer, to);
    ctx.fillRect(left, y, Math.abs(to - outer), height);
  }

  /** A thin lit edge facing the middle of the frame. */
  private rim(
    ctx: CanvasRenderingContext2D,
    inner: number,
    sign: number,
    arena: Arena,
  ): void {
    ctx.save();
    // `source-atop` keeps the light on the shape and off the empty frame.
    ctx.globalCompositeOperation = 'source-atop';
    const gradient = ctx.createLinearGradient(inner, 0, inner - sign * 150, 0);
    gradient.addColorStop(0, alpha(arena.lighting.rim, 0.26));
    gradient.addColorStop(1, alpha(arena.lighting.rim, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(
      sign > 0 ? -OUTER_MARGIN - 20 : inner - 200,
      0,
      sign > 0 ? inner + OUTER_MARGIN + 220 : DESIGN_WIDTH + OUTER_MARGIN * 2,
      DESIGN_HEIGHT,
    );
    ctx.restore();
  }
}
