import { clamp, damp, TAU } from '@/core/math';
import type { GestureState } from '@/vision/gestures';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '@/render/renderer';
import { alpha, Ease, Palette } from '@/render/theme';

/**
 * The pointer.
 *
 * One cursor, two sources: a hand in front of the camera, or a mouse. They
 * feed the same state, so no widget ever has to care which is in use — and the
 * player can switch between them mid-menu, which matters more than it sounds.
 * Hand tracking fails in bad light, and when it does, a player who cannot fall
 * back to a mouse is stuck on the title screen forever.
 *
 * Drawing the cursor is not decoration either. A hand-driven pointer has no
 * physical referent — the player cannot feel where it is — so it has to carry
 * its own state visibly: where it is, whether it is being tracked, whether a
 * pinch has registered, and how far a dwell has progressed.
 */

export type PointerSource = 'none' | 'hand' | 'mouse';

export interface PointerState {
  source: PointerSource;
  /** Position in design space. */
  x: number;
  y: number;
  /** True on the frame a click began. */
  pressed: boolean;
  /** True on the frame a click was released. */
  released: boolean;
  /** True while held. */
  down: boolean;
  /** `[0, 1]`, for the pinch ring. */
  pressure: number;
  /** Dwell progress on the current target. */
  dwell: number;
  /** Tracking confidence; fades the cursor when low. */
  confidence: number;
  /** Whether anything is currently pointing at all. */
  active: boolean;
}

export class Cursor {
  readonly state: PointerState = {
    source: 'none',
    x: DESIGN_WIDTH / 2,
    y: DESIGN_HEIGHT / 2,
    pressed: false,
    released: false,
    down: false,
    pressure: 0,
    dwell: 0,
    confidence: 0,
    active: false,
  };

  /** Smoothed visual position, which trails the logical one slightly. */
  private visualX = DESIGN_WIDTH / 2;
  private visualY = DESIGN_HEIGHT / 2;

  private time = 0;
  /** Frames since the mouse last moved, used to decide which source wins. */
  private mouseIdle = 999;
  private handIdle = 999;

  private pendingMouseDown = false;
  private pendingMouseUp = false;
  private mouseDown = false;
  private mouseX = DESIGN_WIDTH / 2;
  private mouseY = DESIGN_HEIGHT / 2;

  /** Ripple animations left by recent clicks. */
  private readonly ripples: { x: number; y: number; age: number }[] = [];

  // --- input sources --------------------------------------------------------

  /** Feeds a mouse or touch position, already converted to design space. */
  onPointerMove(x: number, y: number): void {
    this.mouseX = x;
    this.mouseY = y;
    this.mouseIdle = 0;
  }

  onPointerDown(x: number, y: number): void {
    this.mouseX = x;
    this.mouseY = y;
    this.mouseIdle = 0;
    this.mouseDown = true;
    this.pendingMouseDown = true;
  }

  onPointerUp(): void {
    this.mouseDown = false;
    this.pendingMouseUp = true;
  }

  /**
   * Advances one frame. `gesture` may be null when hand tracking is off.
   *
   * Source arbitration is "whoever moved most recently wins", with a short
   * grace period. Anything cleverer produced a cursor that fought the player.
   */
  update(gesture: GestureState | null, dt: number, handControlEnabled: boolean): void {
    this.time += dt;
    this.mouseIdle += dt;
    this.handIdle += dt;

    const state = this.state;
    state.pressed = false;
    state.released = false;

    const handAvailable = handControlEnabled && gesture !== null && gesture.present;
    if (handAvailable && gesture) {
      // Only count the hand as "moving" when it is actually doing something,
      // otherwise a hand resting in frame permanently steals the cursor.
      const moved =
        Math.abs(gesture.cursorX * DESIGN_WIDTH - this.visualX) > 4 ||
        Math.abs(gesture.cursorY * DESIGN_HEIGHT - this.visualY) > 4 ||
        gesture.pinchStarted;
      if (moved) this.handIdle = 0;
    }

    const useHand = handAvailable && this.handIdle < this.mouseIdle;

    if (useHand && gesture) {
      state.source = 'hand';
      state.x = gesture.cursorX * DESIGN_WIDTH;
      state.y = gesture.cursorY * DESIGN_HEIGHT;
      state.pressure = gesture.pinchStrength;
      state.dwell = gesture.dwellProgress;
      state.confidence = gesture.confidence;
      state.down = gesture.pinchHeld > 0 && gesture.pinchStrength > 0.5;
      state.pressed = gesture.pinchStarted || gesture.dwellFired;
      state.released = gesture.pinchReleased;
      state.active = true;
    } else if (this.mouseIdle < 6) {
      state.source = 'mouse';
      state.x = this.mouseX;
      state.y = this.mouseY;
      state.pressure = this.mouseDown ? 1 : 0;
      state.dwell = 0;
      state.confidence = 1;
      state.down = this.mouseDown;
      state.pressed = this.pendingMouseDown;
      state.released = this.pendingMouseUp;
      state.active = true;
    } else {
      state.source = 'none';
      state.active = false;
      state.pressure = 0;
      state.dwell = 0;
      state.confidence = 0;
      state.down = false;
    }

    this.pendingMouseDown = false;
    this.pendingMouseUp = false;

    if (state.pressed) this.ripples.push({ x: state.x, y: state.y, age: 0 });

    for (let i = this.ripples.length - 1; i >= 0; i--) {
      this.ripples[i].age += dt;
      if (this.ripples[i].age > 0.55) this.ripples.splice(i, 1);
    }

    // The hand cursor gets a touch of smoothing; the mouse gets none, because
    // any lag on a mouse feels broken.
    const halfLife = state.source === 'hand' ? 0.03 : 0;
    this.visualX = halfLife > 0 ? damp(this.visualX, state.x, halfLife, dt) : state.x;
    this.visualY = halfLife > 0 ? damp(this.visualY, state.y, halfLife, dt) : state.y;
  }

  // --- drawing --------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D): void {
    const state = this.state;
    if (!state.active) return;

    const x = this.visualX;
    const y = this.visualY;
    const hand = state.source === 'hand';
    const fade = hand ? clamp(state.confidence * 1.4, 0.25, 1) : 1;

    ctx.save();
    ctx.globalAlpha = fade;

    for (const ripple of this.ripples) {
      const t = ripple.age / 0.55;
      ctx.globalAlpha = fade * (1 - t) * 0.6;
      ctx.strokeStyle = Palette.ember;
      ctx.lineWidth = 2 * (1 - t) + 0.5;
      ctx.beginPath();
      ctx.arc(ripple.x, ripple.y, 12 + Ease.out(t) * 46, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = fade;

    if (hand) {
      this.drawHandCursor(ctx, x, y, state);
    } else {
      this.drawMouseCursor(ctx, x, y, state);
    }

    ctx.restore();
  }

  private drawHandCursor(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    state: PointerState,
  ): void {
    // A ring that closes as the pinch closes. The gap is the affordance: the
    // player can see exactly how much further their fingers need to travel.
    const baseRadius = 22;
    const squeeze = state.pressure;
    const radius = baseRadius - squeeze * 8;

    ctx.save();
    ctx.shadowColor = Palette.ember;
    ctx.shadowBlur = 14 + squeeze * 18;

    ctx.strokeStyle = squeeze > 0.6 ? Palette.gold : Palette.ember;
    ctx.lineWidth = 2.5 + squeeze * 1.5;

    // Two arcs with gaps at the sides, which read as thumb and finger.
    const gap = (1 - squeeze) * 0.5 + 0.12;
    ctx.beginPath();
    ctx.arc(x, y, radius, -Math.PI / 2 + gap, Math.PI / 2 - gap);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, radius, Math.PI / 2 + gap, (Math.PI * 3) / 2 - gap);
    ctx.stroke();
    ctx.restore();

    // Dwell ring: a clockwise fill that completes into a click.
    if (state.dwell > 0.01) {
      ctx.save();
      ctx.strokeStyle = Palette.gold;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.shadowColor = Palette.gold;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(x, y, baseRadius + 9, -Math.PI / 2, -Math.PI / 2 + TAU * state.dwell);
      ctx.stroke();
      ctx.restore();
    }

    // Centre dot: the actual hit point, which the ring only surrounds.
    ctx.fillStyle = Palette.white;
    ctx.beginPath();
    ctx.arc(x, y, 3 + squeeze * 2, 0, TAU);
    ctx.fill();

    // A soft trailing glow gives the cursor some presence against a busy menu.
    const pulse = 0.5 + Math.sin(this.time * 3) * 0.12;
    ctx.globalAlpha *= 0.28 * pulse;
    ctx.fillStyle = alpha(Palette.ember, 0.6);
    ctx.beginPath();
    ctx.arc(x, y, baseRadius + 14, 0, TAU);
    ctx.fill();
  }

  private drawMouseCursor(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    state: PointerState,
  ): void {
    const size = state.down ? 9 : 13;
    ctx.strokeStyle = Palette.ember;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';

    // A crosshair with a hole in the middle, so the thing being pointed at is
    // never hidden by the pointer.
    ctx.beginPath();
    ctx.moveTo(x - size, y);
    ctx.lineTo(x - 4, y);
    ctx.moveTo(x + 4, y);
    ctx.lineTo(x + size, y);
    ctx.moveTo(x, y - size);
    ctx.lineTo(x, y - 4);
    ctx.moveTo(x, y + 4);
    ctx.lineTo(x, y + size);
    ctx.stroke();

    ctx.fillStyle = Palette.white;
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, TAU);
    ctx.fill();
  }

  /** Nudges the cursor somewhere — used when a screen opens under it. */
  warpTo(x: number, y: number): void {
    this.state.x = x;
    this.state.y = y;
    this.visualX = x;
    this.visualY = y;
  }
}
