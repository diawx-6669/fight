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
   * A vast, soft silhouette behind everything.
   *
   * Drawn from an actual fighting stance rather than from abstract shapes: a
   * head, a tapered torso, two arms held in a guard and a bladed leg stance.
   * An earlier version used a rounded trapezoid for the body and, at this
   * scale and contrast, read unmistakably as a drinking cup — the lesson being
   * that a silhouette has to be built from a pose, not from geometry that
   * happens to be person-shaped in the abstract.
   */
  private drawFigure(ctx: CanvasRenderingContext2D): void {
    const breathe = Math.sin(this.time * 0.5) * 7;
    // The hip, which everything else is measured from.
    const hx = DESIGN_WIDTH * 0.76;
    const hy = DESIGN_HEIGHT * 0.72 + breathe;
    const s = 430;

    // Pose, in hip-relative units. Negative y is up.
    const chest: [number, number] = [hx + s * 0.02, hy - s * 0.5];
    const neck: [number, number] = [hx + s * 0.03, hy - s * 0.63];
    const head: [number, number] = [hx + s * 0.04, hy - s * 0.79];
    const headR = s * 0.125;

    const shoulderL: [number, number] = [hx - s * 0.15, hy - s * 0.49];
    const shoulderR: [number, number] = [hx + s * 0.18, hy - s * 0.5];
    const elbowL: [number, number] = [hx - s * 0.27, hy - s * 0.3];
    const elbowR: [number, number] = [hx + s * 0.3, hy - s * 0.31];
    // Fists up by the jaw: the read that says "fighter" rather than "statue".
    const handL: [number, number] = [hx - s * 0.1, hy - s * 0.64];
    const handR: [number, number] = [hx + s * 0.16, hy - s * 0.69];

    const hipL: [number, number] = [hx - s * 0.1, hy];
    const hipR: [number, number] = [hx + s * 0.1, hy];
    const kneeL: [number, number] = [hx - s * 0.2, hy + s * 0.27];
    const kneeR: [number, number] = [hx + s * 0.16, hy + s * 0.28];
    const footL: [number, number] = [hx - s * 0.3, hy + s * 0.54];
    const footR: [number, number] = [hx + s * 0.24, hy + s * 0.55];

    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = alpha(Palette.ink900, 0.94);
    ctx.strokeStyle = alpha(Palette.ink900, 0.94);
    ctx.shadowColor = alpha(this.accent, 0.26);
    ctx.shadowBlur = 80;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Legs first, so the torso overlaps them at the hip.
    ctx.lineWidth = s * 0.115;
    strokeChain(ctx, [hipL, kneeL, footL]);
    strokeChain(ctx, [hipR, kneeR, footR]);

    // Torso: wide at the shoulders, drawn in at the waist.
    ctx.beginPath();
    ctx.moveTo(shoulderL[0], shoulderL[1]);
    ctx.quadraticCurveTo(chest[0], chest[1] - s * 0.06, shoulderR[0], shoulderR[1]);
    ctx.quadraticCurveTo(hx + s * 0.16, hy - s * 0.22, hipR[0], hipR[1] + s * 0.04);
    ctx.quadraticCurveTo(hx, hy + s * 0.08, hipL[0], hipL[1] + s * 0.04);
    ctx.quadraticCurveTo(hx - s * 0.16, hy - s * 0.22, shoulderL[0], shoulderL[1]);
    ctx.closePath();
    ctx.fill();

    // Neck and head.
    ctx.lineWidth = s * 0.075;
    strokeChain(ctx, [chest, neck]);
    ctx.beginPath();
    ctx.arc(head[0], head[1], headR, 0, TAU);
    ctx.fill();

    // Arms, folded into a guard.
    ctx.lineWidth = s * 0.082;
    strokeChain(ctx, [shoulderL, elbowL, handL]);
    strokeChain(ctx, [shoulderR, elbowR, handR]);

    // Fists.
    ctx.beginPath();
    ctx.arc(handL[0], handL[1], s * 0.052, 0, TAU);
    ctx.arc(handR[0], handR[1], s * 0.055, 0, TAU);
    ctx.fill();

    ctx.restore();

    // Rim light down the leading edge, matching the fight scene's lighting.
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.arc(head[0], head[1], headR, Math.PI * 0.72, Math.PI * 1.62);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(shoulderL[0], shoulderL[1]);
    ctx.quadraticCurveTo(hx - s * 0.16, hy - s * 0.22, hipL[0], hipL[1]);
    ctx.stroke();

    strokeChain(ctx, [shoulderL, elbowL, handL]);
    strokeChain(ctx, [hipL, kneeL, footL]);
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

/** Strokes a polyline through a chain of joints. */
function strokeChain(ctx: CanvasRenderingContext2D, points: [number, number][]): void {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.stroke();
}
