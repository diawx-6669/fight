import { clamp, TAU } from '@/core/math';
import type { Fighter } from '@/game/fighter';
import type { FighterRig, RigJoint } from '@/game/rig';
import type { Camera2D } from './camera2d';
import { alpha, mix, Palette } from './theme';

/**
 * Drawing a fighter.
 *
 * The art direction is a shadow: a near-black body separated from a near-black
 * world by nothing but a rim of light. That sounds like it should be easy and
 * it is the opposite — with no interior detail to carry the read, every bit of
 * legibility has to come from the outline, which means the outline has to be
 * *right*.
 *
 * The body is built as a single path so it can be filled once with a winding
 * rule. Overlapping tapered segments and joint circles union into one shape
 * with no internal seams, which is what lets a rim stroke run cleanly around
 * the whole figure instead of tracing every limb separately.
 *
 * Then, in order:
 *   1. a soft contact shadow on the floor,
 *   2. an outer glow tinted by the character, for separation from the backdrop,
 *   3. the body, filled with a vertical gradient,
 *   4. a directional rim light, clipped inside the body,
 *   5. a head highlight and the eye glint, which is the only "face" there is.
 */

/** Limb thicknesses in metres, before the character's build multiplier. */
const WIDTHS = {
  hip: 0.165,
  chest: 0.2,
  neck: 0.082,
  shoulder: 0.088,
  elbow: 0.062,
  hand: 0.055,
  thighTop: 0.108,
  knee: 0.082,
  foot: 0.062,
} as const;

const screen = { x: 0, y: 0 };

/** Screen-space cache of the rig, rebuilt each draw. */
type ScreenJoints = Record<RigJoint, { x: number; y: number }>;

function makeScreenJoints(): ScreenJoints {
  return {
    hip: { x: 0, y: 0 },
    chest: { x: 0, y: 0 },
    neck: { x: 0, y: 0 },
    head: { x: 0, y: 0 },
    shoulderL: { x: 0, y: 0 },
    elbowL: { x: 0, y: 0 },
    handL: { x: 0, y: 0 },
    shoulderR: { x: 0, y: 0 },
    elbowR: { x: 0, y: 0 },
    handR: { x: 0, y: 0 },
    hipL: { x: 0, y: 0 },
    kneeL: { x: 0, y: 0 },
    footL: { x: 0, y: 0 },
    hipR: { x: 0, y: 0 },
    kneeR: { x: 0, y: 0 },
    footR: { x: 0, y: 0 },
  };
}

export interface SilhouetteOptions {
  /** Draw the near-side limbs in a lighter tone, for depth. */
  depthShading?: boolean;
  /** Glow intensity multiplier — raised while the super meter is full. */
  glow?: number;
  /** Set true to render the fighter as a flat shadow (used for the intro). */
  flat?: boolean;
  /** Extra outline colour override, for hit flashes. */
  overrideRim?: string;
  /** `0` draws nothing, `1` draws fully. Used for spawn and defeat fades. */
  opacity?: number;
}

export class SilhouetteRenderer {
  private readonly joints = makeScreenJoints();

  /**
   * Draws one fighter. `ctx` is expected to be in design space with no
   * transform of its own beyond the renderer's stage transform.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    fighter: Fighter,
    camera: Camera2D,
    options: SilhouetteOptions = {},
  ): void {
    const opacity = options.opacity ?? 1;
    if (opacity <= 0.01) return;

    const rig = fighter.rig;
    const visuals = fighter.character.visuals;
    const ppm = camera.pixelsPerMetre;
    const scale = rig.proportions.scale;

    this.projectJoints(rig, camera);
    const width = (metres: number) => metres * scale * ppm;

    // --- floor contact shadow ----------------------------------------------
    this.drawGroundShadow(ctx, fighter, camera, opacity);

    // --- build the silhouette ----------------------------------------------
    // Far-side limbs are a separate path drawn *behind* and darker, which is
    // the entire depth cue in a two-tone image. Without it, arms disappear
    // into the torso whenever they cross it.
    //
    // Path2D is append-only with no reset, so these are built fresh each draw
    // rather than cached — two allocations per fighter per frame, which does
    // not register next to the fill and stroke work that follows.
    const far = new Path2D();
    const body = new Path2D();

    const j = this.joints;
    const nearSide = rig.facing > 0 ? 'R' : 'L';
    const farSide = nearSide === 'R' ? 'L' : 'R';

    // Far arm and leg.
    addLimb(far, j[`shoulder${farSide}`], j[`elbow${farSide}`], width(WIDTHS.shoulder), width(WIDTHS.elbow));
    addLimb(far, j[`elbow${farSide}`], j[`hand${farSide}`], width(WIDTHS.elbow), width(WIDTHS.hand));
    addJoint(far, j[`hand${farSide}`], width(WIDTHS.hand) * 1.15);
    addLimb(far, j[`hip${farSide}`], j[`knee${farSide}`], width(WIDTHS.thighTop), width(WIDTHS.knee));
    addLimb(far, j[`knee${farSide}`], j[`foot${farSide}`], width(WIDTHS.knee), width(WIDTHS.foot));
    addFoot(far, j[`knee${farSide}`], j[`foot${farSide}`], width(WIDTHS.foot), rig.facing);

    // Torso, head and near limbs.
    addLimb(body, j.hip, j.chest, width(WIDTHS.hip), width(WIDTHS.chest));
    addLimb(body, j.chest, j.neck, width(WIDTHS.chest), width(WIDTHS.neck));
    addJoint(body, j.hip, width(WIDTHS.hip));
    addJoint(body, j.chest, width(WIDTHS.chest) * 0.98);

    const headRadius = rig.headRadius * scale * ppm * 0.78;
    addJoint(body, j.head, headRadius);

    addLimb(body, j[`shoulder${nearSide}`], j[`elbow${nearSide}`], width(WIDTHS.shoulder), width(WIDTHS.elbow));
    addLimb(body, j[`elbow${nearSide}`], j[`hand${nearSide}`], width(WIDTHS.elbow), width(WIDTHS.hand));
    addJoint(body, j[`hand${nearSide}`], width(WIDTHS.hand) * 1.2);
    addLimb(body, j[`hip${nearSide}`], j[`knee${nearSide}`], width(WIDTHS.thighTop), width(WIDTHS.knee));
    addLimb(body, j[`knee${nearSide}`], j[`foot${nearSide}`], width(WIDTHS.knee), width(WIDTHS.foot));
    addFoot(body, j[`knee${nearSide}`], j[`foot${nearSide}`], width(WIDTHS.foot), rig.facing);

    ctx.save();
    ctx.globalAlpha = opacity;

    // --- outer glow ---------------------------------------------------------
    // Rage and a full meter both push the aura; a fighter about to die should
    // look like it from across the room.
    const glowStrength =
      (options.glow ?? 1) * (0.55 + fighter.meterRatio * 0.7 + fighter.rage * 0.8);

    if (!options.flat && glowStrength > 0.1) {
      ctx.save();
      ctx.shadowColor = alpha(visuals.aura, clamp(glowStrength * 0.55, 0, 0.9));
      ctx.shadowBlur = 26 + glowStrength * 34;
      ctx.fillStyle = alpha(visuals.bodyOuter, 0.95);
      ctx.fill(far);
      ctx.fill(body);
      ctx.restore();
    }

    // --- far limbs ----------------------------------------------------------
    ctx.fillStyle = options.flat ? '#000000' : mix(visuals.bodyOuter, Palette.ink900, 0.45);
    ctx.fill(far, 'nonzero');

    // --- body ---------------------------------------------------------------
    if (options.flat) {
      ctx.fillStyle = '#000000';
      ctx.fill(body, 'nonzero');
      ctx.restore();
      return;
    }

    const topY = j.head.y - headRadius;
    const bottomY = Math.max(j.footL.y, j.footR.y);
    const gradient = ctx.createLinearGradient(0, topY, 0, bottomY);
    gradient.addColorStop(0, visuals.bodyInner);
    gradient.addColorStop(0.55, mix(visuals.bodyInner, visuals.bodyOuter, 0.6));
    gradient.addColorStop(1, visuals.bodyOuter);
    ctx.fillStyle = gradient;
    ctx.fill(body, 'nonzero');

    // --- rim light ----------------------------------------------------------
    const rimColor = options.overrideRim ?? visuals.rim;
    this.drawRim(ctx, body, far, rimColor, rig.facing, ppm * scale, fighter);

    // --- head detail --------------------------------------------------------
    this.drawHead(ctx, fighter, headRadius, rimColor);

    // --- damage state -------------------------------------------------------
    if (fighter.flashHit > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (fighter.flashHit / 10) * 0.55 * opacity;
      ctx.fillStyle = Palette.white;
      ctx.fill(body, 'nonzero');
      ctx.fill(far, 'nonzero');
      ctx.restore();
    }

    if (fighter.flashBlock > 0) {
      ctx.save();
      ctx.globalAlpha = (fighter.flashBlock / 8) * 0.8 * opacity;
      ctx.strokeStyle = Palette.frostSoft;
      ctx.lineWidth = 3.5;
      ctx.stroke(body);
      ctx.restore();
    }

    if (fighter.flashParry > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (fighter.flashParry / 14) * 0.9 * opacity;
      ctx.shadowColor = Palette.gold;
      ctx.shadowBlur = 24;
      ctx.strokeStyle = Palette.gold;
      ctx.lineWidth = 4;
      ctx.stroke(body);
      ctx.restore();
    }

    ctx.restore();
  }

  /** Projects every rig joint into screen space once per draw. */
  private projectJoints(rig: FighterRig, camera: Camera2D): void {
    for (const name of Object.keys(this.joints) as RigJoint[]) {
      const world = rig.joints[name];
      camera.worldToScreen(world.x, world.y, screen);
      this.joints[name].x = screen.x;
      this.joints[name].y = screen.y;
    }
  }

  /**
   * The contact shadow.
   *
   * It is not decoration: without it a jumping fighter has no readable height,
   * because a silhouette against a dark background gives the eye nothing else
   * to measure against. The shadow shrinks and fades with altitude, which is
   * the cue that does all the work.
   */
  private drawGroundShadow(
    ctx: CanvasRenderingContext2D,
    fighter: Fighter,
    camera: Camera2D,
    opacity: number,
  ): void {
    camera.worldToScreen(fighter.x, 0, screen);
    const ppm = camera.pixelsPerMetre;
    const height = clamp(fighter.y, 0, 2.4);
    const shrink = 1 - height * 0.28;
    const radiusX = 0.46 * fighter.rig.proportions.scale * ppm * shrink;
    const radiusY = radiusX * 0.24;

    if (radiusX <= 1) return;

    ctx.save();
    ctx.globalAlpha = clamp((0.55 - height * 0.16) * opacity, 0, 0.6);
    const gradient = ctx.createRadialGradient(
      screen.x,
      screen.y,
      0,
      screen.x,
      screen.y,
      Math.max(radiusX, 1),
    );
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0.9)');
    gradient.addColorStop(0.6, 'rgba(0, 0, 0, 0.35)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(screen.x, screen.y, radiusX, radiusY, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Directional rim light.
   *
   * Clipping to the body and stroking an offset copy of the same path leaves
   * light only along the edges facing the offset direction. One stroke, one
   * clip, and the figure reads as lit from a specific place.
   */
  private drawRim(
    ctx: CanvasRenderingContext2D,
    body: Path2D,
    far: Path2D,
    color: string,
    facing: number,
    pixelScale: number,
    fighter: Fighter,
  ): void {
    const lineWidth = clamp(pixelScale * 0.026, 2, 6);
    const offset = lineWidth * 0.75;

    ctx.save();
    ctx.clip(body, 'nonzero');

    // Main rim, from above and behind — the classic backlight.
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth * 2;
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.9;
    ctx.save();
    ctx.translate(-offset * facing, -offset * 0.8);
    ctx.stroke(body);
    ctx.restore();

    // A cooler fill light from the front, much weaker, to keep the front edge
    // from vanishing entirely against a bright sky.
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = mix(color, Palette.frostSoft, 0.55);
    ctx.lineWidth = lineWidth;
    ctx.save();
    ctx.translate(offset * facing * 1.2, offset * 0.4);
    ctx.stroke(body);
    ctx.restore();

    // Bloodied fighters pick up a red wash along the rim.
    if (fighter.rage > 0.2) {
      ctx.globalAlpha = fighter.rage * 0.5;
      ctx.strokeStyle = Palette.blood;
      ctx.lineWidth = lineWidth * 1.4;
      ctx.stroke(body);
    }

    ctx.restore();

    // The far limbs get a much dimmer rim so they stay behind the torso.
    ctx.save();
    ctx.clip(far, 'nonzero');
    ctx.globalAlpha = 0.34;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth * 1.2;
    ctx.translate(-offset * facing, -offset * 0.8);
    ctx.stroke(far);
    ctx.restore();
  }

  /** The head: a highlight arc and a single eye glint. */
  private drawHead(
    ctx: CanvasRenderingContext2D,
    fighter: Fighter,
    radius: number,
    rimColor: string,
  ): void {
    const head = this.joints.head;
    const facing = fighter.rig.facing;

    // One glowing eye is all the face this art style needs, and it does a
    // remarkable amount of work: it tells you where the fighter is looking.
    const eyeX = head.x + facing * radius * 0.42;
    const eyeY = head.y - radius * 0.08;
    const eyeSize = clamp(radius * 0.17, 1.4, 5);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const intensity = 0.55 + fighter.rage * 0.45 + fighter.meterRatio * 0.3;
    ctx.shadowColor = rimColor;
    ctx.shadowBlur = eyeSize * 4;
    ctx.fillStyle = alpha(rimColor, clamp(intensity, 0, 1));
    ctx.beginPath();
    ctx.ellipse(eyeX, eyeY, eyeSize * 1.5, eyeSize, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

// --- path construction ------------------------------------------------------

/**
 * Adds a tapered segment between two joints.
 *
 * Built as a quad rather than a stroke so the limb can narrow along its length;
 * a uniform stroke makes every fighter look like a balloon animal.
 */
function addLimb(
  path: Path2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  radiusA: number,
  radiusB: number,
): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.01) return;

  const nx = -dy / length;
  const ny = dx / length;

  path.moveTo(a.x + nx * radiusA, a.y + ny * radiusA);
  path.lineTo(b.x + nx * radiusB, b.y + ny * radiusB);
  path.lineTo(b.x - nx * radiusB, b.y - ny * radiusB);
  path.lineTo(a.x - nx * radiusA, a.y - ny * radiusA);
  path.closePath();

  // Circles at both ends round the joint off and union away the seam.
  path.moveTo(a.x + radiusA, a.y);
  path.arc(a.x, a.y, radiusA, 0, TAU);
  path.moveTo(b.x + radiusB, b.y);
  path.arc(b.x, b.y, radiusB, 0, TAU);
}

function addJoint(path: Path2D, p: { x: number; y: number }, radius: number): void {
  if (radius <= 0.01) return;
  path.moveTo(p.x + radius, p.y);
  path.arc(p.x, p.y, radius, 0, TAU);
}

/**
 * Adds a foot: a short wedge pointing the way the fighter faces.
 * Feet are tiny and almost always in contact with the floor, which makes them
 * one of the strongest cues that a figure is standing rather than floating.
 */
function addFoot(
  path: Path2D,
  knee: { x: number; y: number },
  foot: { x: number; y: number },
  radius: number,
  facing: number,
): void {
  const dx = foot.x - knee.x;
  const dy = foot.y - knee.y;
  const length = Math.hypot(dx, dy) || 1;

  // The foot points along the facing direction, rolled slightly by the shin's
  // angle so a kicking leg's foot extends with it.
  const toeX = foot.x + facing * radius * 2.1 + (dx / length) * radius * 0.4;
  const toeY = foot.y + (dy / length) * radius * 0.3;
  const heelX = foot.x - facing * radius * 0.9;
  const heelY = foot.y;

  path.moveTo(heelX, heelY - radius * 0.7);
  path.lineTo(toeX, toeY - radius * 0.45);
  path.lineTo(toeX, toeY + radius * 0.5);
  path.lineTo(heelX, heelY + radius * 0.7);
  path.closePath();
  addJoint(path, foot, radius);
}
