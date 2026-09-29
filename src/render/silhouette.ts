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
  /** Colour of the flat fill. Defaults to black. */
  flatColor?: string;
  /** Extra outline colour override, for hit flashes. */
  overrideRim?: string;
  /** `0` draws nothing, `1` draws fully. Used for spawn and defeat fades. */
  opacity?: number;
  /**
   * Whether to draw the contact shadow. Off for the copies that make up a
   * motion smear: one body casts one shadow, however many times it is drawn.
   */
  shadow?: boolean;
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

    // A rig with a non-finite joint is not merely ugly, it is fatal: the very
    // next `createRadialGradient` throws `The provided double value is
    // non-finite`, and the exception unwinds out of the frame before the HUD
    // is drawn. One bad number in one limb takes down the whole render.
    //
    // Skipping the fighter costs a frame of them. Throwing costs the game.
    if (!this.projectJoints(rig, camera)) return;

    const width = (metres: number) => metres * scale * ppm;

    // --- floor contact shadow ----------------------------------------------
    if (options.shadow !== false) this.drawGroundShadow(ctx, fighter, camera, opacity);

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
    const flatColor = options.flatColor ?? '#000000';
    const farColor = options.flat ? flatColor : mix(visuals.bodyOuter, Palette.ink900, 0.45);
    const rimColor = options.overrideRim ?? visuals.rim;
    const rimWidth = clamp(ppm * scale * 0.03, 2, 7);

    if (!options.flat) {
      // Far limbs get a dim rim of their own so they separate from the torso.
      dilate(ctx, far, mix(farColor, rimColor, 0.35), rimWidth * 0.55, -rimWidth * 0.5 * rig.facing, -rimWidth * 0.4);
    }
    ctx.fillStyle = farColor;
    ctx.fill(far, 'nonzero');

    // --- body ---------------------------------------------------------------
    if (options.flat) {
      ctx.fillStyle = flatColor;
      ctx.fill(body, 'nonzero');
      ctx.restore();
      return;
    }

    // Rim light, drawn *underneath* the body rather than on top of it.
    //
    // The obvious approach — clip to the body and stroke it — does not work
    // here, because the silhouette is a union of overlapping subpaths and
    // `stroke` traces every one of them, including the internal seams between
    // limbs. That renders the fighter as a wireframe.
    //
    // Instead the whole shape is dilated (stroke + fill in the same colour,
    // which grows it by half the line width) and drawn offset behind the body.
    // The body fill then covers everything except the offset edge, leaving a
    // clean directional rim with no internal lines at all.
    dilate(ctx, body, rimColor, rimWidth, -rimWidth * 0.62 * rig.facing, -rimWidth * 0.55);

    // A much weaker cool fill light from the front, so the leading edge does
    // not vanish against a bright sky.
    ctx.save();
    ctx.globalAlpha *= 0.4;
    dilate(
      ctx,
      body,
      mix(rimColor, Palette.frostSoft, 0.6),
      rimWidth * 0.5,
      rimWidth * 0.5 * rig.facing,
      rimWidth * 0.3,
    );
    ctx.restore();

    if (fighter.rage > 0.25) {
      ctx.save();
      ctx.globalAlpha *= fighter.rage * 0.6;
      dilate(ctx, body, Palette.blood, rimWidth * 1.2, 0, 0);
      ctx.restore();
    }

    const topY = j.head.y - headRadius;
    const bottomY = Math.max(j.footL.y, j.footR.y);
    const gradient = ctx.createLinearGradient(0, topY, 0, bottomY);
    gradient.addColorStop(0, visuals.bodyInner);
    gradient.addColorStop(0.55, mix(visuals.bodyInner, visuals.bodyOuter, 0.6));
    gradient.addColorStop(1, visuals.bodyOuter);
    ctx.fillStyle = gradient;
    ctx.fill(body, 'nonzero');

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

    // Block and parry flashes use the same dilation trick, for the same reason:
    // a plain stroke would light up every internal seam.
    if (fighter.flashBlock > 0) {
      ctx.save();
      ctx.globalAlpha = (fighter.flashBlock / 8) * 0.9 * opacity;
      dilate(ctx, body, Palette.frostSoft, 4, 0, 0);
      ctx.fillStyle = gradient;
      ctx.fill(body, 'nonzero');
      ctx.restore();
    }

    if (fighter.flashParry > 0) {
      ctx.save();
      ctx.globalAlpha = (fighter.flashParry / 14) * 1 * opacity;
      ctx.shadowColor = Palette.gold;
      ctx.shadowBlur = 24;
      dilate(ctx, body, Palette.gold, 6, 0, 0);
      ctx.shadowBlur = 0;
      ctx.fillStyle = gradient;
      ctx.fill(body, 'nonzero');
      ctx.restore();
    }

    ctx.restore();
  }

  /** Projects the rig into screen space; `false` means it was not drawable. */
  private projectJoints(rig: FighterRig, camera: Camera2D): boolean {
    let ok = true;
    for (const name of Object.keys(this.joints) as RigJoint[]) {
      const world = rig.joints[name];
      camera.worldToScreen(world.x, world.y, screen);
      if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y)) ok = false;
      this.joints[name].x = screen.x;
      this.joints[name].y = screen.y;
    }
    return ok;
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

/**
 * Draws `path` grown outward by `width`, in one flat colour, at an offset.
 *
 * Stroking a path with line width `2w` paints `w` on each side of every edge;
 * filling it as well covers the interior. Together they produce the original
 * shape dilated by `w` — the cheapest available substitute for a real path
 * union, and the only one that does not leave internal seams behind.
 */
function dilate(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  color: string,
  width: number,
  offsetX: number,
  offsetY: number,
): void {
  if (width <= 0.1) return;
  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.lineWidth = width * 2;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.stroke(path);
  ctx.fill(path, 'nonzero');
  ctx.restore();
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
  //
  // `anticlockwise: true` is load-bearing. The quad above is wound
  // counter-clockwise on screen, and a default `arc` winds the other way —
  // under the non-zero fill rule two opposing windings cancel, which punched a
  // visible hole through every knee and ankle.
  path.moveTo(a.x + radiusA, a.y);
  path.arc(a.x, a.y, radiusA, 0, TAU, true);
  path.moveTo(b.x + radiusB, b.y);
  path.arc(b.x, b.y, radiusB, 0, TAU, true);
}

function addJoint(path: Path2D, p: { x: number; y: number }, radius: number): void {
  if (radius <= 0.01) return;
  // Same winding as every other subpath — see `addLimb`.
  path.moveTo(p.x + radius, p.y);
  path.arc(p.x, p.y, radius, 0, TAU, true);
}

/**
 * Adds a foot.
 *
 * Built from the same tapered-capsule primitive as every other limb rather
 * than as its own polygon. An earlier version used a four-point wedge, which
 * wound the opposite way to the capsules around it — and under the non-zero
 * fill rule two opposing windings cancel, punching a visible hole through the
 * ankle of every fighter.
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

  // The toe leads in the facing direction, carried a little by the shin's
  // angle so a kicking leg's foot extends along with it.
  const heelX = foot.x - facing * radius * 0.7;
  const heelY = foot.y;
  const toeX = foot.x + facing * radius * 1.9 + (dx / length) * radius * 0.3;
  const toeY = foot.y + (dy / length) * radius * 0.25;

  addLimb(
    path,
    { x: heelX, y: heelY },
    { x: toeX, y: toeY },
    radius * 0.82,
    radius * 0.58,
  );
}
