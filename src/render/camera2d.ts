import { clamp, damp } from '@/core/math';
import { ARENA_HALF_WIDTH } from '@/game/constants';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from './renderer';

/**
 * The fight camera.
 *
 * Converts world metres into design-space pixels, and decides where to look.
 * Framing a fighting game is a narrow problem with strict rules: **both
 * fighters must always be visible, and the horizon must not move unless
 * something dramatic happened**. Everything here serves those two sentences.
 *
 * The camera never rotates. Tilting during impacts looks exciting in a trailer
 * and makes the game unreadable in a real exchange.
 */

/**
 * A number that cannot poison the transform.
 *
 * Canvas 2D does not complain about `NaN`: a transform built from one is
 * silently ignored, and every draw call that depends on it does nothing at
 * all. The result is a completely black scene with a perfectly good HUD on
 * top of it — the HUD is drawn in design space and never touches the camera —
 * and not one line in the console to say why.
 *
 * That failure mode is worth an `isFinite` check at every point where a number
 * enters the camera. One bad frame from the simulation then costs one bad
 * frame, instead of every frame until the player reloads.
 */
function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Zoom bounds. Outside these the fight is either a dot or a wall of leg. */
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.5;

/** Screen pixels per world metre at zoom 1. */
export const BASE_PPM = 182;

/** Where the ground plane sits in design space. */
export const HORIZON_Y = 872;

export class Camera2D {
  /** Camera centre in world metres. */
  x = 0;
  y = 1.1;

  /** Zoom multiplier; below 1 pulls back. */
  zoom = 1;

  /** Additive shake offset in world metres. */
  shakeX = 0;
  shakeY = 0;

  /**
   * Dutch-free impact punch: a brief zoom-in on a big hit. Distinct from
   * `zoom`, which tracks the fighters, so the two never fight each other.
   */
  private punch = 0;

  /** Slight horizontal drift added during slow motion, for a cinematic push. */
  private drift = 0;

  /** Follows the simulation's focus, smoothed for display rather than logic. */
  follow(focusX: number, focusY: number, focusZoom: number, dt: number): void {
    // A focus point that has gone non-finite means the simulation is in
    // trouble. Holding the last good framing is the right answer either way:
    // the fight stays visible while whatever broke upstream recovers.
    this.x = damp(this.x, finite(focusX, this.x), 0.1, dt);
    this.y = damp(this.y, finite(focusY, this.y), 0.14, dt);
    this.zoom = damp(this.zoom, finite(focusZoom, this.zoom), 0.16, dt);
  }

  setShake(x: number, y: number): void {
    this.shakeX = finite(x, 0);
    this.shakeY = finite(y, 0);
  }

  /** Kicks a short zoom-in. `strength` around 0.04 reads as a solid hit. */
  addPunch(strength: number): void {
    this.punch = Math.max(this.punch, finite(strength, 0));
  }

  update(dt: number): void {
    this.punch = damp(this.punch, 0, 0.09, dt);
    this.drift = damp(this.drift, 0, 0.4, dt);
    this.sanitize();
  }

  addDrift(amount: number): void {
    this.drift += finite(amount, 0);
  }

  /**
   * Last line of defence: forces every field back into a drawable range.
   *
   * Returns whether anything had to be repaired, so the scene can report a
   * broken frame instead of just showing black. Called once per frame, which
   * costs six comparisons and buys the guarantee that the transform this
   * camera produces is always usable.
   */
  sanitize(): boolean {
    const before = this.x + this.y + this.zoom + this.shakeX + this.shakeY + this.punch + this.drift;

    this.x = clamp(finite(this.x, 0), -ARENA_HALF_WIDTH * 2, ARENA_HALF_WIDTH * 2);
    this.y = clamp(finite(this.y, 1.1), 0.5, 6);
    this.zoom = clamp(finite(this.zoom, 1), MIN_ZOOM, MAX_ZOOM);
    this.shakeX = clamp(finite(this.shakeX, 0), -3, 3);
    this.shakeY = clamp(finite(this.shakeY, 0), -3, 3);
    this.punch = clamp(finite(this.punch, 0), 0, 0.6);
    this.drift = clamp(finite(this.drift, 0), -4, 4);

    return !Number.isFinite(before);
  }

  /**
   * Effective pixels per metre this frame.
   *
   * Clamped rather than merely computed: this number divides in
   * `screenToWorld` and multiplies in `worldToScreen`, so a zero here would
   * take the whole scene with it.
   */
  get pixelsPerMetre(): number {
    const scale = clamp(finite(this.zoom + this.punch, 1), MIN_ZOOM, MAX_ZOOM + 0.6);
    return BASE_PPM * scale;
  }

  /** Converts world metres to design-space pixels. */
  worldToScreen(worldX: number, worldY: number, out: { x: number; y: number }): void {
    const ppm = this.pixelsPerMetre;
    out.x = DESIGN_WIDTH / 2 + (worldX - this.x - this.shakeX + this.drift) * ppm;
    // Screen y grows downward; world y grows upward.
    out.y = HORIZON_Y - (worldY - (this.y - 1.1) - this.shakeY) * ppm;
  }

  /** Converts design-space pixels back to world metres. */
  screenToWorld(screenX: number, screenY: number, out: { x: number; y: number }): void {
    const ppm = this.pixelsPerMetre;
    out.x = (screenX - DESIGN_WIDTH / 2) / ppm + this.x + this.shakeX - this.drift;
    out.y = (HORIZON_Y - screenY) / ppm + (this.y - 1.1) + this.shakeY;
  }

  /** Metres visible across the full stage width — used to size the background. */
  get visibleWidth(): number {
    return DESIGN_WIDTH / this.pixelsPerMetre;
  }

  get visibleHeight(): number {
    return DESIGN_HEIGHT / this.pixelsPerMetre;
  }

  /**
   * Clamps the camera so the arena's edges never leave a void on screen.
   * Called after `follow`, because clamping the target instead produces a
   * camera that fights the player at the corners.
   */
  clampToArena(): void {
    const halfVisible = this.visibleWidth / 2;
    const limit = Math.max(0, ARENA_HALF_WIDTH + 1.5 - halfVisible);
    this.x = clamp(this.x, -limit, limit);
    this.y = clamp(this.y, 0.9, 3.4);
  }

  /** Snaps to a position without smoothing — for round transitions. */
  snapTo(x: number, y: number, zoom: number): void {
    this.x = finite(x, 0);
    this.y = finite(y, 1.1);
    this.zoom = clamp(finite(zoom, 1), MIN_ZOOM, MAX_ZOOM);
    this.punch = 0;
    this.drift = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }
}
