import { TAU } from '@/core/math';
import { Rng } from '@/core/rng';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '@/render/renderer';
import { alpha, mix, Palette } from '@/render/theme';

/**
 * The menu backdrop.
 *
 * Menus in this game sit in the same world the fight does, so they get the
 * same treatment: a dark gradient, a slow drift of embers, and a huge blurred
 * silhouette in the background that reads as a figure without ever resolving
 * into one. It costs almost nothing and it stops the menus from feeling like a
 * settings dialog bolted onto a game.
 */

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  phase: number;
}

export class MenuBackdrop {
  private readonly motes: Mote[] = [];
  private readonly rng = new Rng(0x7a17);
  private time = 0;

  /** Accent colour, changed per screen so menus feel connected to their content. */
  accent: string = Palette.ember;

  constructor(count = 46) {
    for (let i = 0; i < count; i++) {
      this.motes.push({
        x: this.rng.range(0, DESIGN_WIDTH),
        y: this.rng.range(0, DESIGN_HEIGHT),
        vx: this.rng.spread(14),
        vy: -this.rng.range(6, 26),
        size: this.rng.range(1.2, 3.6),
        phase: this.rng.range(0, TAU),
      });
    }
  }

  update(dt: number): void {
    this.time += dt;
    for (const mote of this.motes) {
      mote.x += (mote.vx + Math.sin(this.time * 0.6 + mote.phase) * 8) * dt;
      mote.y += mote.vy * dt;
      if (mote.y < -20) {
        mote.y = DESIGN_HEIGHT + 20;
        mote.x = this.rng.range(0, DESIGN_WIDTH);
      }
      if (mote.x < -20) mote.x = DESIGN_WIDTH + 20;
      else if (mote.x > DESIGN_WIDTH + 20) mote.x = -20;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    // Base gradient.
    const gradient = ctx.createRadialGradient(
      DESIGN_WIDTH * 0.5,
      DESIGN_HEIGHT * 0.34,
      0,
      DESIGN_WIDTH * 0.5,
      DESIGN_HEIGHT * 0.34,
      DESIGN_WIDTH * 0.82,
    );
    gradient.addColorStop(0, mix(Palette.ink700, this.accent, 0.06));
    gradient.addColorStop(0.55, Palette.ink800);
    gradient.addColorStop(1, Palette.ink900);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);

    this.drawFigure(ctx);
    this.drawMotes(ctx);
    this.drawGrid(ctx);
  }

  /**
   * A vast, soft silhouette behind everything. Drawn with very low contrast so
   * the eye registers "there is something there" and then moves on.
   */
  private drawFigure(ctx: CanvasRenderingContext2D): void {
    const breathe = Math.sin(this.time * 0.5) * 8;
    const cx = DESIGN_WIDTH * 0.74;
    const cy = DESIGN_HEIGHT * 0.62 + breathe;
    const scale = 520;

    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = alpha(Palette.ink900, 0.9);
    ctx.shadowColor = alpha(this.accent, 0.3);
    ctx.shadowBlur = 90;

    ctx.beginPath();
    // Head.
    ctx.arc(cx, cy - scale * 0.78, scale * 0.15, 0, TAU);
    ctx.fill();

    // Torso, tapering to the hips.
    ctx.beginPath();
    ctx.moveTo(cx - scale * 0.3, cy - scale * 0.58);
    ctx.quadraticCurveTo(cx, cy - scale * 0.66, cx + scale * 0.3, cy - scale * 0.58);
    ctx.lineTo(cx + scale * 0.2, cy + scale * 0.2);
    ctx.quadraticCurveTo(cx, cy + scale * 0.3, cx - scale * 0.2, cy + scale * 0.2);
    ctx.closePath();
    ctx.fill();

    // A guard: one arm up across the body.
    ctx.lineWidth = scale * 0.14;
    ctx.lineCap = 'round';
    ctx.strokeStyle = alpha(Palette.ink900, 0.9);
    ctx.beginPath();
    ctx.moveTo(cx - scale * 0.28, cy - scale * 0.52);
    ctx.lineTo(cx - scale * 0.46, cy - scale * 0.2);
    ctx.lineTo(cx - scale * 0.16, cy - scale * 0.34);
    ctx.stroke();

    ctx.restore();

    // A rim of light down the figure's leading edge, matching the fight scene.
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy - scale * 0.78, scale * 0.15, Math.PI * 0.75, Math.PI * 1.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - scale * 0.3, cy - scale * 0.58);
    ctx.lineTo(cx - scale * 0.2, cy + scale * 0.2);
    ctx.stroke();
    ctx.restore();
  }

  private drawMotes(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const mote of this.motes) {
      const flicker = 0.4 + Math.sin(this.time * 2.4 + mote.phase) * 0.35;
      ctx.globalAlpha = 0.28 * flicker;
      ctx.fillStyle = this.accent;
      ctx.beginPath();
      ctx.arc(mote.x, mote.y, mote.size, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /** A faint perspective grid on the floor, anchoring the menu in space. */
  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const horizon = DESIGN_HEIGHT * 0.78;
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 1;

    const scroll = (this.time * 26) % 90;
    for (let i = 0; i < 9; i++) {
      // Lines bunch towards the horizon, which is what makes it read as depth.
      const t = (i * 90 + scroll) / 810;
      const y = horizon + Math.pow(t, 2.1) * (DESIGN_HEIGHT - horizon) * 3.2;
      if (y > DESIGN_HEIGHT) continue;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(DESIGN_WIDTH, y);
      ctx.stroke();
    }

    for (let i = -8; i <= 8; i++) {
      ctx.beginPath();
      ctx.moveTo(DESIGN_WIDTH / 2 + i * 34, horizon);
      ctx.lineTo(DESIGN_WIDTH / 2 + i * 340, DESIGN_HEIGHT);
      ctx.stroke();
    }

    ctx.restore();
  }
}
