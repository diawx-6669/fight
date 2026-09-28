import { clamp } from '@/core/math';
import { Rng } from '@/core/rng';
import type { Fighter } from '@/game/fighter';
import type { Camera2D } from './camera2d';
import { alpha, mix } from './theme';

/**
 * Cloth: scarves, sashes and hair.
 *
 * These are the cheapest secondary motion in the game and by far the highest
 * return. A silhouette with nothing trailing off it reads as a puppet; add one
 * strip of cloth that lags behind every movement and the same figure suddenly
 * has weight, momentum and a direction of travel.
 *
 * Simulated with Verlet integration and distance constraints — no forces, no
 * springs, no stiffness tuning. Each point remembers where it was, gravity and
 * wind nudge it, and then the segment lengths are enforced by moving points
 * back into place a few times. It is unconditionally stable at any timestep,
 * which matters because the renderer's `dt` spikes whenever the vision model
 * takes a long frame.
 */

interface ClothPoint {
  x: number;
  y: number;
  previousX: number;
  previousY: number;
  /** `0` means pinned to the rig, `1` means free. */
  freedom: number;
}

export interface RibbonStyle {
  /** Where on the body it attaches. */
  anchor: 'neck' | 'chest' | 'hip' | 'head' | 'handL' | 'handR';
  /** Total length in metres. */
  length: number;
  /** Width at the anchor, in metres. */
  width: number;
  /** Width at the free end, as a fraction of `width`. */
  taper: number;
  color: string;
  /** Number of simulated segments. More is smoother and costs more. */
  segments: number;
  /** How strongly gravity pulls, relative to normal. */
  weight: number;
  /** Sideways offset from the anchor, in metres. */
  offset: number;
  /** Opacity. */
  opacity: number;
}

const GRAVITY = 14;
const CONSTRAINT_ITERATIONS = 3;
/** Nothing in the cloth may move faster than this per step; kills explosions. */
const MAX_STEP = 0.35;

export class Ribbon {
  private readonly points: ClothPoint[] = [];
  private readonly segmentLength: number;

  constructor(
    readonly style: RibbonStyle,
    private readonly rng: Rng,
  ) {
    this.segmentLength = style.length / style.segments;
    for (let i = 0; i <= style.segments; i++) {
      this.points.push({ x: 0, y: 0, previousX: 0, previousY: 0, freedom: i === 0 ? 0 : 1 });
    }
  }

  /** Snaps the whole strip to the anchor — used on spawn and round reset. */
  reset(anchorX: number, anchorY: number): void {
    for (let i = 0; i < this.points.length; i++) {
      const point = this.points[i];
      point.x = anchorX;
      point.y = anchorY - i * this.segmentLength;
      point.previousX = point.x;
      point.previousY = point.y;
    }
  }

  /**
   * Advances the simulation one frame.
   * `windX` carries the fighter's own velocity, which is what makes cloth
   * stream backwards when they dash.
   */
  update(anchorX: number, anchorY: number, windX: number, windY: number, dt: number): void {
    const step = clamp(dt, 0.004, 0.05);
    const gravity = GRAVITY * this.style.weight * step * step;

    for (let i = 0; i < this.points.length; i++) {
      const point = this.points[i];

      if (point.freedom === 0) {
        point.previousX = point.x;
        point.previousY = point.y;
        point.x = anchorX;
        point.y = anchorY;
        continue;
      }

      // Verlet: velocity is implicit in the gap between current and previous.
      let vx = (point.x - point.previousX) * 0.986;
      let vy = (point.y - point.previousY) * 0.986;

      vx = clamp(vx, -MAX_STEP, MAX_STEP);
      vy = clamp(vy, -MAX_STEP, MAX_STEP);

      point.previousX = point.x;
      point.previousY = point.y;

      // Points further out catch more air, so the tip whips.
      const exposure = i / this.points.length;
      point.x += vx + (windX * step * (0.4 + exposure * 0.9));
      point.y += vy - gravity + windY * step * (0.3 + exposure * 0.7);

      // A whisper of noise keeps the cloth alive when the fighter is still.
      point.x += this.rng.spread(0.0006);
      point.y += this.rng.spread(0.0006);
    }

    for (let iteration = 0; iteration < CONSTRAINT_ITERATIONS; iteration++) {
      this.solveConstraints();
    }
  }

  private solveConstraints(): void {
    for (let i = 0; i < this.points.length - 1; i++) {
      const a = this.points[i];
      const b = this.points[i + 1];

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 1e-6) continue;

      const difference = (distance - this.segmentLength) / distance;
      // Pinned points do not move, so the free neighbour absorbs the whole
      // correction. Splitting it evenly would drag the anchor off the body.
      const aWeight = a.freedom === 0 ? 0 : b.freedom === 0 ? 1 : 0.5;
      const bWeight = b.freedom === 0 ? 0 : a.freedom === 0 ? 1 : 0.5;

      a.x += dx * difference * aWeight;
      a.y += dy * difference * aWeight;
      b.x -= dx * difference * bWeight;
      b.y -= dy * difference * bWeight;
    }
  }

  /** Draws the strip as a tapered ribbon through the simulated points. */
  draw(ctx: CanvasRenderingContext2D, camera: Camera2D, tint: number): void {
    const points = this.points;
    if (points.length < 2) return;

    const ppm = camera.pixelsPerMetre;
    const screenPoints: { x: number; y: number }[] = [];
    const scratch = { x: 0, y: 0 };

    for (const point of points) {
      camera.worldToScreen(point.x, point.y, scratch);
      screenPoints.push({ x: scratch.x, y: scratch.y });
    }

    const baseWidth = this.style.width * ppm;
    const path = new Path2D();

    // Walk out along one side and back along the other, offsetting each point
    // by the segment normal. This gives a continuous ribbon rather than a
    // chain of disconnected quads.
    const offsets: { x: number; y: number }[] = [];
    for (let i = 0; i < screenPoints.length; i++) {
      const previous = screenPoints[Math.max(0, i - 1)];
      const next = screenPoints[Math.min(screenPoints.length - 1, i + 1)];
      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      const length = Math.hypot(dx, dy) || 1;
      const t = i / (screenPoints.length - 1);
      const width = baseWidth * (1 - t * (1 - this.style.taper)) * 0.5;
      offsets.push({ x: (-dy / length) * width, y: (dx / length) * width });
    }

    path.moveTo(screenPoints[0].x + offsets[0].x, screenPoints[0].y + offsets[0].y);
    for (let i = 1; i < screenPoints.length; i++) {
      path.lineTo(screenPoints[i].x + offsets[i].x, screenPoints[i].y + offsets[i].y);
    }
    for (let i = screenPoints.length - 1; i >= 0; i--) {
      path.lineTo(screenPoints[i].x - offsets[i].x, screenPoints[i].y - offsets[i].y);
    }
    path.closePath();

    ctx.save();
    ctx.globalAlpha = this.style.opacity;
    ctx.fillStyle = tint > 0 ? mix(this.style.color, '#ffffff', tint) : this.style.color;
    ctx.fill(path);

    // A thin bright edge along the cloth catches the same light as the rim.
    ctx.globalAlpha = this.style.opacity * 0.35;
    ctx.strokeStyle = alpha('#ffffff', 0.5);
    ctx.lineWidth = 1;
    ctx.stroke(path);
    ctx.restore();
  }
}

/**
 * All the cloth on one fighter, wired to the right anchors on the rig.
 */
export class ClothSystem {
  private readonly ribbons: Ribbon[] = [];
  private readonly rng: Rng;
  private lastX = 0;
  private lastY = 0;
  private initialised = false;

  constructor(fighter: Fighter, quality: number, seed: number) {
    this.rng = new Rng(seed);
    const visuals = fighter.character.visuals;
    const scale = fighter.rig.proportions.scale;
    const segments = clamp(Math.round(quality), 4, 18);

    // The sash at the waist: the main piece, and the one that reads at distance.
    this.ribbons.push(
      new Ribbon(
        {
          anchor: 'hip',
          length: 0.62 * scale,
          width: 0.14 * scale,
          taper: 0.25,
          color: visuals.cloth,
          segments,
          weight: 1,
          offset: -0.04 * scale,
          opacity: 0.92,
        },
        this.rng,
      ),
    );

    // Hair, if the character has any worth simulating.
    if (visuals.hairLength > 0.15) {
      this.ribbons.push(
        new Ribbon(
          {
            anchor: 'head',
            length: visuals.hairLength * scale,
            width: 0.1 * scale,
            taper: 0.15,
            color: mix(visuals.bodyInner, visuals.rim, 0.18),
            segments: Math.max(4, Math.round(segments * 0.7)),
            weight: 0.7,
            offset: 0,
            opacity: 1,
          },
          this.rng,
        ),
      );
    }

    // Extra streamers from the shoulders, per character.
    const extras = clamp(visuals.ribbons - 1, 0, 4);
    for (let i = 0; i < extras; i++) {
      this.ribbons.push(
        new Ribbon(
          {
            anchor: i % 2 === 0 ? 'chest' : 'neck',
            length: (0.34 + i * 0.1) * scale,
            width: (0.055 + i * 0.012) * scale,
            taper: 0.2,
            color: mix(visuals.cloth, visuals.rim, 0.25 + i * 0.12),
            segments: Math.max(3, Math.round(segments * 0.55)),
            weight: 0.55 + i * 0.12,
            offset: (i % 2 === 0 ? 0.06 : -0.06) * scale,
            opacity: 0.6 - i * 0.08,
          },
          this.rng,
        ),
      );
    }
  }

  update(fighter: Fighter, dt: number): void {
    const rig = fighter.rig;

    // Wind is the fighter's own motion, inverted: cloth trails behind you.
    const velocityX = -fighter.vx * 0.5;
    const velocityY = -fighter.vy * 0.35;

    // Sudden pose changes (a spin, a hit) should whip the cloth too, so the
    // chest's frame-to-frame displacement is folded into the wind.
    const chest = rig.joints.chest;
    const poseWindX = this.initialised ? (chest.x - this.lastX) * 24 : 0;
    const poseWindY = this.initialised ? (chest.y - this.lastY) * 18 : 0;
    this.lastX = chest.x;
    this.lastY = chest.y;
    this.initialised = true;

    const windX = velocityX + poseWindX;
    const windY = velocityY + poseWindY;

    for (const ribbon of this.ribbons) {
      const anchor = this.anchorPosition(fighter, ribbon.style);
      ribbon.update(anchor.x, anchor.y, windX, windY, dt);
    }
  }

  private readonly anchorScratch = { x: 0, y: 0 };

  private anchorPosition(fighter: Fighter, style: RibbonStyle): { x: number; y: number } {
    const rig = fighter.rig;
    const joint =
      style.anchor === 'head'
        ? rig.joints.head
        : style.anchor === 'neck'
          ? rig.joints.neck
          : style.anchor === 'chest'
            ? rig.joints.chest
            : style.anchor === 'handL'
              ? rig.joints.handL
              : style.anchor === 'handR'
                ? rig.joints.handR
                : rig.joints.hip;

    this.anchorScratch.x = joint.x + style.offset * rig.facing;
    this.anchorScratch.y = joint.y;
    return this.anchorScratch;
  }

  /** Places every strip at its anchor — call on round start to avoid a snap. */
  resetTo(fighter: Fighter): void {
    for (const ribbon of this.ribbons) {
      const anchor = this.anchorPosition(fighter, ribbon.style);
      ribbon.reset(anchor.x, anchor.y);
    }
    this.initialised = false;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera2D, fighter: Fighter): void {
    // Cloth brightens on impact along with the body, so it does not look like a
    // separate object stuck to the fighter.
    const tint = clamp(fighter.flashHit / 10, 0, 1) * 0.6;
    for (const ribbon of this.ribbons) ribbon.draw(ctx, camera, tint);
  }
}
