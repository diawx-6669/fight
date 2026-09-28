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
    this.x = damp(this.x, focusX, 0.1, dt);
    this.y = damp(this.y, focusY, 0.14, dt);
    this.zoom = damp(this.zoom, focusZoom, 0.16, dt);
  }

  setShake(x: number, y: number): void {
    this.shakeX = x;
    this.shakeY = y;
  }

  /** Kicks a short zoom-in. `strength` around 0.04 reads as a solid hit. */
  addPunch(strength: number): void {
    this.punch = Math.max(this.punch, strength);
  }

  update(dt: number): void {
    this.punch = damp(this.punch, 0, 0.09, dt);
    this.drift = damp(this.drift, 0, 0.4, dt);
  }

  addDrift(amount: number): void {
    this.drift += amount;
  }

  /** Effective pixels per metre this frame. */
  get pixelsPerMetre(): number {
    return BASE_PPM * (this.zoom + this.punch);
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
    this.x = x;
    this.y = y;
    this.zoom = zoom;
    this.punch = 0;
    this.drift = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }
}
