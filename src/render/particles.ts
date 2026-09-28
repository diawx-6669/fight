import { clamp, TAU } from '@/core/math';
import { Pool } from '@/core/pool';
import { Rng } from '@/core/rng';
import type { Camera2D } from './camera2d';
import { alpha } from './theme';

/**
 * The particle system.
 *
 * One flat array, one pool, one draw loop. Particles are the effect that most
 * often quietly destroys a browser game's frame rate, so this is deliberately
 * boring: no per-particle objects allocated during a match, no sorting, no
 * per-particle canvas state changes, and a hard cap that drops the *oldest*
 * particles rather than refusing new ones — a burst you asked for should always
 * be visible, even if it costs some drifting dust.
 */

export type ParticleShape = 'spark' | 'dust' | 'shard' | 'ring' | 'streak' | 'flake';

export interface Particle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds lived and total lifetime. */
  age: number;
  life: number;
  size: number;
  /** Size at the end of life, as a fraction of `size`. */
  endScale: number;
  rotation: number;
  spin: number;
  color: string;
  shape: ParticleShape;
  /** Gravity multiplier. */
  weight: number;
  /** Air resistance per second. */
  drag: number;
  /** Peak opacity. */
  opacity: number;
  /** Additive blending for anything that should read as light. */
  additive: boolean;
}

function createParticle(): Particle {
  return {
    active: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    age: 0,
    life: 1,
    size: 0.05,
    endScale: 0,
    rotation: 0,
    spin: 0,
    color: '#ffffff',
    shape: 'spark',
    weight: 1,
    drag: 1.2,
    opacity: 1,
    additive: true,
  };
}

function resetParticle(particle: Particle): void {
  particle.active = false;
  particle.age = 0;
}

export interface EmitOptions {
  x: number;
  y: number;
  count: number;
  /** Base speed in metres per second. */
  speed: number;
  speedVariance?: number;
  /** Direction in radians; omit for a full circle. */
  angle?: number;
  /** Half-width of the emission cone in radians. */
  spread?: number;
  life: number;
  lifeVariance?: number;
  size: number;
  sizeVariance?: number;
  endScale?: number;
  color: string;
  shape?: ParticleShape;
  weight?: number;
  drag?: number;
  opacity?: number;
  additive?: boolean;
  spin?: number;
}

const GRAVITY = 9.8;

export class ParticleSystem {
  private readonly particles: Particle[] = [];
  private readonly pool: Pool<Particle>;
  private readonly rng: Rng;

  /** Hard cap; raised and lowered with the quality tier. */
  maxParticles: number;

  constructor(maxParticles = 700, seed = 0xfeed) {
    this.maxParticles = maxParticles;
    this.rng = new Rng(seed);
    this.pool = new Pool(createParticle, resetParticle, 128, 2048);
  }

  get count(): number {
    return this.particles.length;
  }

  emit(options: EmitOptions): void {
    const count = Math.round(options.count);
    for (let i = 0; i < count; i++) {
      // Over budget: recycle the oldest rather than dropping the new burst,
      // because the new burst is the one the player is looking at.
      if (this.particles.length >= this.maxParticles) {
        const oldest = this.particles.shift();
        if (oldest) this.pool.release(oldest);
      }

      const particle = this.pool.acquire();
      const angle =
        options.angle === undefined
          ? this.rng.range(0, TAU)
          : options.angle + this.rng.spread(options.spread ?? 0.4);
      const speed = options.speed + this.rng.spread(options.speedVariance ?? options.speed * 0.4);

      particle.active = true;
      particle.x = options.x;
      particle.y = options.y;
      particle.vx = Math.cos(angle) * speed;
      particle.vy = Math.sin(angle) * speed;
      particle.age = 0;
      particle.life = Math.max(0.05, options.life + this.rng.spread(options.lifeVariance ?? options.life * 0.3));
      particle.size = Math.max(
        0.004,
        options.size + this.rng.spread(options.sizeVariance ?? options.size * 0.4),
      );
      particle.endScale = options.endScale ?? 0;
      particle.rotation = this.rng.range(0, TAU);
      particle.spin = options.spin ?? this.rng.spread(6);
      particle.color = options.color;
      particle.shape = options.shape ?? 'spark';
      particle.weight = options.weight ?? 1;
      particle.drag = options.drag ?? 1.2;
      particle.opacity = options.opacity ?? 1;
      particle.additive = options.additive ?? true;

      this.particles.push(particle);
    }
  }

  update(dt: number): void {
    const step = clamp(dt, 0, 0.05);

    // Iterate backwards so removals do not shuffle unvisited entries.
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i];
      particle.age += step;

      if (particle.age >= particle.life) {
        this.particles.splice(i, 1);
        this.pool.release(particle);
        continue;
      }

      const drag = Math.max(0, 1 - particle.drag * step);
      particle.vx *= drag;
      particle.vy *= drag;
      particle.vy -= GRAVITY * particle.weight * step;

      particle.x += particle.vx * step;
      particle.y += particle.vy * step;
      particle.rotation += particle.spin * step;

      // Bounce off the floor, losing most of the energy. Sparks skittering
      // along the ground is a tiny detail that makes impacts feel physical.
      if (particle.y < 0 && particle.vy < 0) {
        particle.y = 0;
        particle.vy *= -0.32;
        particle.vx *= 0.7;
        if (Math.abs(particle.vy) < 0.4) particle.vy = 0;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera2D): void {
    if (this.particles.length === 0) return;

    const ppm = camera.pixelsPerMetre;
    const screen = { x: 0, y: 0 };

    // Two passes so the composite mode is set twice per frame rather than
    // twice per particle. On a busy frame this is the difference between 60
    // and 40 fps.
    for (let pass = 0; pass < 2; pass++) {
      const additive = pass === 0;
      let opened = false;

      for (let i = 0; i < this.particles.length; i++) {
        const particle = this.particles[i];
        if (particle.additive !== additive) continue;

        if (!opened) {
          ctx.save();
          ctx.globalCompositeOperation = additive ? 'lighter' : 'source-over';
          opened = true;
        }

        const t = particle.age / particle.life;
        // Fade in fast, fade out slow — sparks should appear instantly.
        const fade = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88;
        const opacity = clamp(fade, 0, 1) * particle.opacity;
        if (opacity <= 0.01) continue;

        camera.worldToScreen(particle.x, particle.y, screen);
        const size = particle.size * (1 - t * (1 - particle.endScale)) * ppm;
        if (size < 0.3) continue;

        ctx.globalAlpha = opacity;
        ctx.fillStyle = particle.color;

        switch (particle.shape) {
          case 'streak': {
            // Oriented along the direction of travel, length scaled by speed.
            const speed = Math.hypot(particle.vx, particle.vy);
            const length = clamp(speed * 0.02, 0.4, 3) * size;
            const angle = Math.atan2(-particle.vy, particle.vx);
            ctx.save();
            ctx.translate(screen.x, screen.y);
            ctx.rotate(angle);
            ctx.fillRect(-length, -size * 0.18, length * 2, size * 0.36);
            ctx.restore();
            break;
          }

          case 'ring': {
            ctx.strokeStyle = particle.color;
            ctx.lineWidth = Math.max(1, size * 0.12);
            ctx.beginPath();
            ctx.arc(screen.x, screen.y, size, 0, TAU);
            ctx.stroke();
            break;
          }

          case 'shard': {
            ctx.save();
            ctx.translate(screen.x, screen.y);
            ctx.rotate(particle.rotation);
            ctx.beginPath();
            ctx.moveTo(0, -size);
            ctx.lineTo(size * 0.45, 0);
            ctx.lineTo(0, size);
            ctx.lineTo(-size * 0.45, 0);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
            break;
          }

          case 'flake': {
            ctx.save();
            ctx.translate(screen.x, screen.y);
            ctx.rotate(particle.rotation);
            ctx.fillRect(-size * 0.5, -size * 0.5, size, size);
            ctx.restore();
            break;
          }

          case 'dust':
          case 'spark':
          default: {
            ctx.beginPath();
            ctx.arc(screen.x, screen.y, size, 0, TAU);
            ctx.fill();
            break;
          }
        }
      }

      if (opened) ctx.restore();
    }
  }

  /** Releases everything — call between rounds. */
  clear(): void {
    for (const particle of this.particles) this.pool.release(particle);
    this.particles.length = 0;
  }

  // --- presets --------------------------------------------------------------

  /** Sparks and a shockwave at the point of a clean hit. */
  impact(x: number, y: number, severity: number, color: string, direction: number): void {
    const count = Math.round(8 + severity * 22);

    this.emit({
      x,
      y,
      count,
      speed: 3 + severity * 7,
      angle: direction,
      spread: 1.1,
      life: 0.24 + severity * 0.2,
      size: 0.022 + severity * 0.018,
      color,
      shape: 'streak',
      weight: 0.5,
      drag: 3.4,
      opacity: 1,
    });

    this.emit({
      x,
      y,
      count: Math.round(4 + severity * 8),
      speed: 1.6 + severity * 3,
      life: 0.5 + severity * 0.3,
      size: 0.05 + severity * 0.05,
      endScale: 2.6,
      color: alpha(color, 0.35),
      shape: 'dust',
      weight: -0.12,
      drag: 2.4,
      opacity: 0.5,
      additive: false,
    });
  }

  /** A soft puff where a blocked strike lands. */
  block(x: number, y: number, color: string): void {
    this.emit({
      x,
      y,
      count: 10,
      speed: 2.4,
      life: 0.3,
      size: 0.02,
      color,
      shape: 'spark',
      weight: 0.3,
      drag: 4,
      opacity: 0.85,
    });
  }

  /** Dust kicked up by a footfall or a landing. */
  dust(x: number, y: number, strength: number, color: string): void {
    this.emit({
      x,
      y: y + 0.02,
      count: Math.round(5 + strength * 12),
      speed: 1 + strength * 2.6,
      angle: 0,
      spread: Math.PI,
      life: 0.7 + strength * 0.4,
      size: 0.06 + strength * 0.05,
      endScale: 2.2,
      color,
      shape: 'dust',
      weight: -0.05,
      drag: 2.8,
      opacity: 0.32,
      additive: false,
    });
  }
}
