import { clamp, TAU } from '@/core/math';
import { RingBuffer } from '@/core/pool';
import type { Fighter } from '@/game/fighter';
import type { Camera2D } from './camera2d';
import { alpha } from './theme';

/**
 * Limb trails.
 *
 * A punch that lands in four frames is on screen for 66 milliseconds. Without a
 * trail the eye genuinely cannot tell what happened — the fist is in the guard,
 * then it is extended, and nothing connects the two. The trail *is* the punch,
 * as far as the viewer is concerned.
 *
 * Each tracked limb keeps a short history of world positions. When the limb is
 * moving fast the history is drawn as a tapering, fading ribbon; when it is
 * slow the trail fades out entirely rather than following the hand around like
 * a bad screensaver.
 */

interface TrailSample {
  x: number;
  y: number;
  /** Speed in metres per second when this sample was taken. */
  speed: number;
  /** Timestamp in seconds. */
  time: number;
}

/** Speed below which nothing is drawn at all. */
const MIN_SPEED = 3.2;

/** Speed at which the trail reaches full opacity. */
const FULL_SPEED = 11;

/** How long a sample stays in the trail, in seconds. */
const TRAIL_LIFE = 0.16;

class LimbTrail {
  private readonly samples: RingBuffer<TrailSample>;
  private lastX = 0;
  private lastY = 0;
  private hasLast = false;

  constructor(capacity: number) {
    this.samples = new RingBuffer<TrailSample>(capacity);
  }

  push(x: number, y: number, dt: number, time: number): void {
    if (!this.hasLast) {
      this.lastX = x;
      this.lastY = y;
      this.hasLast = true;
      return;
    }

    const speed = dt > 0 ? Math.hypot(x - this.lastX, y - this.lastY) / dt : 0;
    this.lastX = x;
    this.lastY = y;
    this.samples.push({ x, y, speed, time });
  }

  /** Peak speed in the retained window — drives opacity and width. */
  peakSpeed(now: number): number {
    let peak = 0;
    this.samples.forEach((sample) => {
      if (now - sample.time > TRAIL_LIFE) return false;
      peak = Math.max(peak, sample.speed);
      return true;
    });
    return peak;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    camera: Camera2D,
    color: string,
    now: number,
    widthScale: number,
  ): void {
    const peak = this.peakSpeed(now);
    if (peak < MIN_SPEED) return;

    const intensity = clamp((peak - MIN_SPEED) / (FULL_SPEED - MIN_SPEED), 0, 1);
    const ppm = camera.pixelsPerMetre;
    const screen = { x: 0, y: 0 };

    const points: { x: number; y: number; weight: number }[] = [];
    this.samples.forEach((sample, offset) => {
      const age = now - sample.time;
      if (age > TRAIL_LIFE) return false;
      camera.worldToScreen(sample.x, sample.y, screen);
      points.push({
        x: screen.x,
        y: screen.y,
        // Weight tapers with age, so the trail narrows behind the limb.
        weight: (1 - age / TRAIL_LIFE) * clamp(sample.speed / FULL_SPEED, 0.2, 1),
      });
      void offset;
      return true;
    });

    if (points.length < 3) return;

    // Build the ribbon: offset each point along its own normal.
    const path = new Path2D();
    const baseWidth = 0.085 * ppm * widthScale;
    const left: { x: number; y: number }[] = [];
    const right: { x: number; y: number }[] = [];

    for (let i = 0; i < points.length; i++) {
      const previous = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      const dx = next.x - previous.x;
      const dy = next.y - previous.y;
      const length = Math.hypot(dx, dy) || 1;
      const width = baseWidth * points[i].weight * 0.5;
      const nx = (-dy / length) * width;
      const ny = (dx / length) * width;
      left.push({ x: points[i].x + nx, y: points[i].y + ny });
      right.push({ x: points[i].x - nx, y: points[i].y - ny });
    }

    path.moveTo(left[0].x, left[0].y);
    for (let i = 1; i < left.length; i++) path.lineTo(left[i].x, left[i].y);
    for (let i = right.length - 1; i >= 0; i--) path.lineTo(right[i].x, right[i].y);
    path.closePath();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // A soft outer bloom plus a tight bright core. Two passes, and the core is
    // what actually reads as the edge of the strike.
    ctx.globalAlpha = intensity * 0.35;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18 * intensity;
    ctx.fillStyle = alpha(color, 0.5);
    ctx.fill(path);

    ctx.shadowBlur = 0;
    ctx.globalAlpha = intensity * 0.8;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.lineWidth = Math.max(1, baseWidth * 0.22);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.stroke();

    // A bright cap on the leading end: the fist itself.
    const head = points[0];
    ctx.globalAlpha = intensity;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(head.x, head.y, Math.max(1.5, baseWidth * 0.2 * intensity), 0, TAU);
    ctx.fill();

    ctx.restore();
  }

  clear(): void {
    this.samples.clear();
    this.hasLast = false;
  }
}

/** Trails for every limb on one fighter. */
export class TrailSystem {
  private readonly handL: LimbTrail;
  private readonly handR: LimbTrail;
  private readonly footL: LimbTrail;
  private readonly footR: LimbTrail;

  private time = 0;

  constructor(segments: number) {
    const capacity = clamp(Math.round(segments), 5, 30);
    this.handL = new LimbTrail(capacity);
    this.handR = new LimbTrail(capacity);
    this.footL = new LimbTrail(capacity);
    this.footR = new LimbTrail(capacity);
  }

  update(fighter: Fighter, dt: number): void {
    this.time += dt;
    const j = fighter.rig.joints;
    this.handL.push(j.handL.x, j.handL.y, dt, this.time);
    this.handR.push(j.handR.x, j.handR.y, dt, this.time);
    this.footL.push(j.footL.x, j.footL.y, dt, this.time);
    this.footR.push(j.footR.x, j.footR.y, dt, this.time);
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera2D, fighter: Fighter): void {
    const color = fighter.character.visuals.trail;
    const scale = fighter.rig.proportions.scale;
    this.handL.draw(ctx, camera, color, this.time, scale);
    this.handR.draw(ctx, camera, color, this.time, scale);
    // Feet are heavier, so their trails are wider.
    this.footL.draw(ctx, camera, color, this.time, scale * 1.25);
    this.footR.draw(ctx, camera, color, this.time, scale * 1.25);
  }

  clear(): void {
    this.handL.clear();
    this.handR.clear();
    this.footL.clear();
    this.footR.clear();
  }
}
