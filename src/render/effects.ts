import { clamp, TAU } from '@/core/math';
import { Rng } from '@/core/rng';
import type { Camera2D } from './camera2d';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from './renderer';
import { Ease, font, Palette } from './theme';

/**
 * Impact effects: the punctuation of a fight.
 *
 * Particles carry the debris; this file carries the *graphic* language on top
 * of it — shockwave rings, slash arcs, the white flash frame, and the damage
 * numbers that pop off a hit. They are short-lived, screen-space, and drawn
 * last so nothing occludes them.
 *
 * The rule that keeps this from turning into visual noise: **one effect per
 * event, scaled by severity**. A jab gets a small ring and nothing else. A
 * knockout gets everything. There is no case where two rings fire for one hit.
 */

type EffectKind = 'ring' | 'slash' | 'burst' | 'number' | 'text' | 'flash';

interface Effect {
  kind: EffectKind;
  /** World position, or screen position when `screenSpace` is set. */
  x: number;
  y: number;
  screenSpace: boolean;
  age: number;
  life: number;
  size: number;
  angle: number;
  color: string;
  /** Text payload for `number` and `text`. */
  label: string;
  /** Severity, `[0, 1]`. */
  strength: number;
  /** Drift applied over the effect's life, in world units or pixels. */
  driftX: number;
  driftY: number;
}

export class EffectLayer {
  private readonly effects: Effect[] = [];
  private readonly rng = new Rng(0xbeef);

  /** Screen-wide white flash, decayed each frame. */
  private flashAmount = 0;
  private flashColor = Palette.white;

  get count(): number {
    return this.effects.length;
  }

  private push(effect: Effect): void {
    // A hard cap; the oldest effect is the least interesting one on screen.
    if (this.effects.length > 64) this.effects.shift();
    this.effects.push(effect);
  }

  // --- spawners -------------------------------------------------------------

  /** Expanding ring at the point of impact. */
  ring(x: number, y: number, strength: number, color: string): void {
    this.push({
      kind: 'ring',
      x,
      y,
      screenSpace: false,
      age: 0,
      life: 0.24 + strength * 0.18,
      size: 0.18 + strength * 0.55,
      angle: 0,
      color,
      label: '',
      strength,
      driftX: 0,
      driftY: 0,
    });
  }

  /** A crescent slash, oriented along the strike. */
  slash(x: number, y: number, angle: number, strength: number, color: string): void {
    this.push({
      kind: 'slash',
      x,
      y,
      screenSpace: false,
      age: 0,
      life: 0.2 + strength * 0.12,
      size: 0.35 + strength * 0.65,
      angle,
      color,
      label: '',
      strength,
      driftX: 0,
      driftY: 0,
    });
  }

  /** Radiating spokes for a heavy connection. */
  burst(x: number, y: number, strength: number, color: string): void {
    this.push({
      kind: 'burst',
      x,
      y,
      screenSpace: false,
      age: 0,
      life: 0.22,
      size: 0.5 + strength * 0.9,
      angle: this.rng.range(0, TAU),
      color,
      label: '',
      strength,
      driftX: 0,
      driftY: 0,
    });
  }

  /** Floating damage number. */
  damage(x: number, y: number, amount: number, color: string, critical: boolean): void {
    this.push({
      kind: 'number',
      x,
      y,
      screenSpace: false,
      age: 0,
      life: 0.95,
      size: critical ? 58 : 42,
      angle: 0,
      color,
      label: String(Math.round(amount)),
      strength: critical ? 1 : 0.55,
      driftX: this.rng.spread(0.35),
      driftY: 1.1,
    });
  }

  /** A word: COUNTER, PARRY, GUARD BREAK. */
  banner(x: number, y: number, label: string, color: string): void {
    this.push({
      kind: 'text',
      x,
      y,
      screenSpace: false,
      age: 0,
      life: 0.85,
      size: 40,
      angle: 0,
      color,
      label,
      strength: 1,
      driftX: 0,
      driftY: 0.8,
    });
  }

  /** Full-screen flash. `strength` above ~0.6 is reserved for knockouts. */
  flash(strength: number, color = Palette.white): void {
    this.flashAmount = Math.max(this.flashAmount, clamp(strength, 0, 1));
    this.flashColor = color;
  }

  // --- lifecycle ------------------------------------------------------------

  update(dt: number): void {
    const step = clamp(dt, 0, 0.05);
    this.flashAmount = Math.max(0, this.flashAmount - step * 4.2);

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i];
      effect.age += step;
      if (effect.age >= effect.life) this.effects.splice(i, 1);
    }
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera2D): void {
    const screen = { x: 0, y: 0 };

    ctx.save();
    for (const effect of this.effects) {
      const t = clamp(effect.age / effect.life, 0, 1);

      if (effect.screenSpace) {
        screen.x = effect.x;
        screen.y = effect.y;
      } else {
        camera.worldToScreen(
          effect.x + effect.driftX * t,
          effect.y + effect.driftY * Ease.out(t),
          screen,
        );
      }

      switch (effect.kind) {
        case 'ring':
          this.drawRing(ctx, screen, effect, t, camera);
          break;
        case 'slash':
          this.drawSlash(ctx, screen, effect, t, camera);
          break;
        case 'burst':
          this.drawBurst(ctx, screen, effect, t, camera);
          break;
        case 'number':
          this.drawNumber(ctx, screen, effect, t);
          break;
        case 'text':
          this.drawBanner(ctx, screen, effect, t);
          break;
        default:
          break;
      }
    }
    ctx.restore();

    if (this.flashAmount > 0.01) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = this.flashAmount * 0.75;
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
      ctx.restore();
    }
  }

  private drawRing(
    ctx: CanvasRenderingContext2D,
    screen: { x: number; y: number },
    effect: Effect,
    t: number,
    camera: Camera2D,
  ): void {
    const ppm = camera.pixelsPerMetre;
    // Expand fast, then coast — the shape of a real pressure wave, and it
    // matches the way the hit itself decelerates.
    const radius = effect.size * Ease.out(t) * ppm;
    const opacity = (1 - t) * (1 - t);

    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = opacity * 0.85;
    ctx.strokeStyle = effect.color;
    ctx.lineWidth = Math.max(1, (1 - t) * 7 * effect.strength + 1);
    ctx.beginPath();
    // Flattened vertically: a ring seen at a shallow angle, which keeps it
    // sitting in the world instead of on the glass.
    ctx.ellipse(screen.x, screen.y, radius, radius * 0.72, 0, 0, TAU);
    ctx.stroke();

    if (effect.strength > 0.6) {
      ctx.globalAlpha = opacity * 0.4;
      ctx.lineWidth = Math.max(1, (1 - t) * 3);
      ctx.beginPath();
      ctx.ellipse(screen.x, screen.y, radius * 0.62, radius * 0.45, 0, 0, TAU);
      ctx.stroke();
    }
  }

  private drawSlash(
    ctx: CanvasRenderingContext2D,
    screen: { x: number; y: number },
    effect: Effect,
    t: number,
    camera: Camera2D,
  ): void {
    const ppm = camera.pixelsPerMetre;
    const radius = effect.size * ppm;
    const opacity = 1 - Ease.in(t);
    // The arc sweeps open then closes, which reads as a blade passing through.
    const sweep = 0.5 + Ease.out(t) * 1.5;
    const width = (1 - t) * 14 * effect.strength + 2;

    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = opacity * 0.9;
    ctx.strokeStyle = effect.color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.shadowColor = effect.color;
    ctx.shadowBlur = 20 * opacity;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, effect.angle - sweep / 2, effect.angle + sweep / 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  private drawBurst(
    ctx: CanvasRenderingContext2D,
    screen: { x: number; y: number },
    effect: Effect,
    t: number,
    camera: Camera2D,
  ): void {
    const ppm = camera.pixelsPerMetre;
    const opacity = (1 - t) * (1 - t);
    const spokes = 7;

    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = opacity * 0.8;
    ctx.strokeStyle = effect.color;
    ctx.lineCap = 'round';

    for (let i = 0; i < spokes; i++) {
      const angle = effect.angle + (i / spokes) * TAU;
      // Alternating spoke lengths give the star an irregular, hand-drawn feel.
      const length = effect.size * ppm * Ease.out(t) * (i % 2 === 0 ? 1 : 0.58);
      const inner = length * 0.22;
      ctx.lineWidth = Math.max(1, (1 - t) * 6 * effect.strength);
      ctx.beginPath();
      ctx.moveTo(screen.x + Math.cos(angle) * inner, screen.y + Math.sin(angle) * inner);
      ctx.lineTo(screen.x + Math.cos(angle) * length, screen.y + Math.sin(angle) * length);
      ctx.stroke();
    }
  }

  private drawNumber(
    ctx: CanvasRenderingContext2D,
    screen: { x: number; y: number },
    effect: Effect,
    t: number,
  ): void {
    // Pop in with an overshoot, then drift up and fade.
    const scale = t < 0.18 ? Ease.back(t / 0.18) : 1;
    const opacity = t < 0.65 ? 1 : 1 - (t - 0.65) / 0.35;

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = clamp(opacity, 0, 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, effect.size * scale, 'display');

    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.strokeText(effect.label, screen.x, screen.y);
    ctx.fillStyle = effect.color;
    ctx.fillText(effect.label, screen.x, screen.y);
  }

  private drawBanner(
    ctx: CanvasRenderingContext2D,
    screen: { x: number; y: number },
    effect: Effect,
    t: number,
  ): void {
    const scale = t < 0.14 ? Ease.back(t / 0.14) : 1;
    const opacity = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = clamp(opacity, 0, 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, effect.size * scale, 'display');

    // A slight horizontal stretch on the way in gives the word some impact
    // without needing a separate animation.
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.scale(1 + (1 - Math.min(t / 0.2, 1)) * 0.25, 1);
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.strokeText(effect.label, 0, 0);
    ctx.fillStyle = effect.color;
    ctx.shadowColor = effect.color;
    ctx.shadowBlur = 18 * opacity;
    ctx.fillText(effect.label, 0, 0);
    ctx.restore();
  }

  clear(): void {
    this.effects.length = 0;
    this.flashAmount = 0;
  }
}
