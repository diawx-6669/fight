import { clamp } from '@/core/math';
import { Rng } from '@/core/rng';
import type { Arena, WeatherKind } from '@/game/arenas';
import type { Camera2D } from './camera2d';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from './renderer';
import { alpha } from './theme';

/**
 * Weather.
 *
 * Runs in *screen* space rather than world space, which is the opposite of the
 * particle system and deliberately so. Rain does not belong to the arena, it
 * belongs to the frame: it should fill the screen at any zoom, never thin out
 * when the camera pulls back, and never cost more when the fighters separate.
 *
 * Each drop is a scalar position in a preallocated typed array. There are no
 * objects here at all, because at 160 drops a second for the length of a match
 * even a cheap object allocation adds up to real garbage-collector pauses.
 */

interface WeatherProfile {
  /** Fall speed in screen pixels per second. */
  speed: number;
  speedVariance: number;
  /** Horizontal drift. */
  wind: number;
  windVariance: number;
  size: number;
  sizeVariance: number;
  /** How elongated the mark is along its direction of travel. */
  streak: number;
  opacity: number;
  /** Rotation speed for tumbling flakes and petals. */
  spin: number;
  additive: boolean;
  /** Sway amplitude for things that flutter. */
  sway: number;
}

const PROFILES: Record<WeatherKind, WeatherProfile | null> = {
  none: null,
  rain: {
    speed: 1500,
    speedVariance: 420,
    wind: -160,
    windVariance: 60,
    size: 1.4,
    sizeVariance: 0.8,
    streak: 18,
    opacity: 0.4,
    spin: 0,
    additive: true,
    sway: 0,
  },
  snow: {
    speed: 90,
    speedVariance: 60,
    wind: 34,
    windVariance: 40,
    size: 3,
    sizeVariance: 2,
    streak: 1,
    opacity: 0.75,
    spin: 1.4,
    additive: false,
    sway: 34,
  },
  embers: {
    // Embers rise. The negative speed is the whole trick.
    speed: -120,
    speedVariance: 70,
    wind: 26,
    windVariance: 44,
    size: 2.4,
    sizeVariance: 1.8,
    streak: 2.2,
    opacity: 0.85,
    spin: 3,
    additive: true,
    sway: 22,
  },
  petals: {
    speed: 74,
    speedVariance: 46,
    wind: 62,
    windVariance: 50,
    size: 5,
    sizeVariance: 2.6,
    streak: 1.6,
    opacity: 0.68,
    spin: 3.4,
    additive: false,
    sway: 58,
  },
  dust: {
    speed: 22,
    speedVariance: 40,
    wind: 180,
    windVariance: 120,
    size: 2.6,
    sizeVariance: 2.2,
    streak: 3.4,
    opacity: 0.32,
    spin: 1,
    additive: false,
    sway: 16,
  },
};

const COLORS: Record<WeatherKind, string> = {
  none: '#ffffff',
  rain: '#9fd8ff',
  snow: '#ffffff',
  embers: '#ff9a3d',
  petals: '#ffc2d4',
  dust: '#c9a878',
};

export class WeatherSystem {
  private kind: WeatherKind = 'none';
  private color = '#ffffff';
  private profile: WeatherProfile | null = null;

  private capacity = 0;
  private x = new Float32Array(0);
  private y = new Float32Array(0);
  private vx = new Float32Array(0);
  private vy = new Float32Array(0);
  private size = new Float32Array(0);
  private phase = new Float32Array(0);
  private spin = new Float32Array(0);

  private readonly rng = new Rng(0x5eed);
  private time = 0;

  /** Extra wind pushed by camera movement, so weather reacts to the fight. */
  private gust = 0;

  setArena(arena: Arena, densityScale: number): void {
    const profile = PROFILES[arena.weather];
    this.kind = arena.weather;
    this.profile = profile;
    this.color = COLORS[arena.weather];

    if (!profile) {
      this.resize(0);
      return;
    }

    // Density is expressed per second in the arena data; a full screen holds a
    // few seconds' worth.
    const count = Math.round(arena.weatherDensity * 3.2 * clamp(densityScale, 0.2, 1.5));
    this.resize(count);
    this.seed();
  }

  private resize(capacity: number): void {
    if (capacity === this.capacity) return;
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.phase = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
  }

  private seed(): void {
    const profile = this.profile;
    if (!profile) return;
    for (let i = 0; i < this.capacity; i++) {
      this.x[i] = this.rng.range(-100, DESIGN_WIDTH + 100);
      this.y[i] = this.rng.range(-100, DESIGN_HEIGHT + 100);
      this.respawnVelocity(i, profile);
      this.phase[i] = this.rng.range(0, Math.PI * 2);
    }
  }

  private respawnVelocity(index: number, profile: WeatherProfile): void {
    this.vy[index] = profile.speed + this.rng.spread(profile.speedVariance);
    this.vx[index] = profile.wind + this.rng.spread(profile.windVariance);
    this.size[index] = Math.max(0.6, profile.size + this.rng.spread(profile.sizeVariance));
    this.spin[index] = this.rng.spread(profile.spin);
  }

  /** Camera motion becomes a gust, so a hard knockback stirs the air. */
  addGust(amount: number): void {
    this.gust += amount;
  }

  update(dt: number, camera: Camera2D): void {
    const profile = this.profile;
    if (!profile || this.capacity === 0) return;

    const step = clamp(dt, 0, 0.05);
    this.time += step;
    this.gust *= Math.max(0, 1 - step * 3);

    // Parallax against the camera: weather near the viewer slides opposite to
    // the camera's motion, which stops it looking painted onto the screen.
    const cameraDrift = -camera.x * 6;

    for (let i = 0; i < this.capacity; i++) {
      const sway = profile.sway === 0 ? 0 : Math.sin(this.time * 1.4 + this.phase[i]) * profile.sway;

      this.x[i] += (this.vx[i] + sway + this.gust) * step;
      this.y[i] += this.vy[i] * step;
      this.phase[i] += this.spin[i] * step;

      // Wrap rather than respawn: the population stays constant and no
      // allocation ever happens mid-match.
      const margin = 120;
      if (this.y[i] > DESIGN_HEIGHT + margin) {
        this.y[i] = -margin;
        this.x[i] = this.rng.range(-100, DESIGN_WIDTH + 100) + cameraDrift * 0.01;
        this.respawnVelocity(i, profile);
      } else if (this.y[i] < -margin) {
        this.y[i] = DESIGN_HEIGHT + margin;
        this.x[i] = this.rng.range(-100, DESIGN_WIDTH + 100) + cameraDrift * 0.01;
        this.respawnVelocity(i, profile);
      }

      if (this.x[i] > DESIGN_WIDTH + margin) this.x[i] = -margin;
      else if (this.x[i] < -margin) this.x[i] = DESIGN_WIDTH + margin;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const profile = this.profile;
    if (!profile || this.capacity === 0) return;

    ctx.save();
    ctx.globalCompositeOperation = profile.additive ? 'lighter' : 'source-over';
    ctx.globalAlpha = profile.opacity;
    ctx.fillStyle = this.color;

    if (this.kind === 'rain') {
      // Rain is drawn as strokes, which is both cheaper and more convincing
      // than a thousand tiny rectangles.
      ctx.strokeStyle = alpha(this.color, 0.7);
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < this.capacity; i++) {
        const length = profile.streak * this.size[i];
        const dx = (this.vx[i] / Math.abs(this.vy[i] || 1)) * length;
        ctx.moveTo(this.x[i], this.y[i]);
        ctx.lineTo(this.x[i] + dx, this.y[i] + length);
      }
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
      return;
    }

    for (let i = 0; i < this.capacity; i++) {
      const size = this.size[i];

      if (this.kind === 'petals') {
        // A petal is an ellipse that tumbles, so its apparent width breathes.
        const squash = Math.abs(Math.cos(this.phase[i])) * 0.8 + 0.2;
        ctx.save();
        ctx.translate(this.x[i], this.y[i]);
        ctx.rotate(this.phase[i] * 0.4);
        ctx.beginPath();
        ctx.ellipse(0, 0, size, size * squash, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        continue;
      }

      if (this.kind === 'embers') {
        // Embers pulse as they cool.
        const flicker = 0.6 + Math.sin(this.time * 9 + this.phase[i]) * 0.4;
        ctx.globalAlpha = profile.opacity * flicker;
        ctx.beginPath();
        ctx.arc(this.x[i], this.y[i], size * flicker, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      ctx.beginPath();
      ctx.arc(this.x[i], this.y[i], size, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}
