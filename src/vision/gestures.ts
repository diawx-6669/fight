import { clamp, damp, distance } from '@/core/math';
import { Ema, Hysteresis } from './filters';
import { HAND_JOINT_COUNT, HandJoint, type HandFrame } from './handTracker';

/**
 * Hand gestures for controlling menus.
 *
 * The design rule here is that every gesture must be *comfortable to hold* and
 * *impossible to trigger by accident*. Anything requiring a precise shape held
 * for a second is exhausting after three menus, and anything triggered by a
 * relaxed hand makes the menu feel haunted.
 *
 * What survived playtesting:
 *   - **Point** with the index finger to move the cursor.
 *   - **Pinch** (thumb to index) to click. It is unambiguous and it maps onto
 *     an intuition everyone already has.
 *   - **Dwell** on a target for 1.1s as a fallback, because pinch detection
 *     degrades badly in poor light and the player must never be stuck.
 *   - **Open palm** held still to go back.
 *   - **Swipe** with an open hand to flip through the character carousel.
 */

export type GestureKind = 'none' | 'point' | 'pinch' | 'open' | 'fist' | 'peace';

export interface GestureState {
  kind: GestureKind;
  /** Cursor position in normalised screen space, `[0, 1]`. */
  cursorX: number;
  cursorY: number;
  /** `0` = fingers apart, `1` = fully pinched. */
  pinchStrength: number;
  /** True on the frame the pinch closed. */
  pinchStarted: boolean;
  /** True on the frame the pinch opened again. */
  pinchReleased: boolean;
  /** How long the current pinch has been held, in seconds. */
  pinchHeld: number;
  /** Dwell-to-click progress on the current hover target, `[0, 1]`. */
  dwellProgress: number;
  /** Set for one frame when a dwell completes. */
  dwellFired: boolean;
  /** Set for one frame when a swipe is recognised. */
  swipe: 'none' | 'left' | 'right' | 'up' | 'down';
  /** Open palm held long enough to mean "back". */
  backHeld: number;
  backFired: boolean;
  /** Whether a hand is currently usable at all. */
  present: boolean;
  /** Tracking confidence, for fading the cursor out gracefully. */
  confidence: number;
}

export interface GestureOptions {
  /** Seconds of hover needed for a dwell click. */
  dwellTime?: number;
  /** Seconds of open palm needed to go back. */
  backTime?: number;
  /**
   * The cursor is driven from a sub-rectangle of the camera frame so that the
   * player can reach the screen corners without stretching off-camera.
   */
  activeMargin?: number;
}

const DEFAULTS: Required<GestureOptions> = {
  dwellTime: 1.1,
  backTime: 0.9,
  activeMargin: 0.16,
};

/** Distance between two hand landmarks, normalised by hand size. */
function fingerDistance(hand: HandFrame, a: number, b: number, handSize: number): number {
  const pa = hand.points[a];
  const pb = hand.points[b];
  return distance(pa.x, pa.y, pb.x, pb.y) / Math.max(handSize, 1e-4);
}

/**
 * Hand scale: wrist to middle-finger knuckle. It is the one span that barely
 * changes as the hand opens and closes, which makes it the right denominator
 * for every other measurement.
 */
function handScale(hand: HandFrame): number {
  const wrist = hand.points[HandJoint.Wrist];
  const middle = hand.points[HandJoint.MiddleMcp];
  return Math.max(distance(wrist.x, wrist.y, middle.x, middle.y), 1e-4);
}

/** Whether a finger is extended, by comparing tip and knuckle distance from the wrist. */
function isFingerExtended(hand: HandFrame, tip: number, pip: number): boolean {
  const wrist = hand.points[HandJoint.Wrist];
  const tipPoint = hand.points[tip];
  const pipPoint = hand.points[pip];
  const tipDistance = distance(wrist.x, wrist.y, tipPoint.x, tipPoint.y);
  const pipDistance = distance(wrist.x, wrist.y, pipPoint.x, pipPoint.y);
  // 8% margin keeps a slightly curled finger from flickering between states.
  return tipDistance > pipDistance * 1.08;
}

export interface FingerState {
  thumb: boolean;
  index: boolean;
  middle: boolean;
  ring: boolean;
  pinky: boolean;
  /** Count of extended fingers, thumb included. */
  count: number;
}

export function readFingers(hand: HandFrame): FingerState {
  const index = isFingerExtended(hand, HandJoint.IndexTip, HandJoint.IndexPip);
  const middle = isFingerExtended(hand, HandJoint.MiddleTip, HandJoint.MiddlePip);
  const ring = isFingerExtended(hand, HandJoint.RingTip, HandJoint.RingPip);
  const pinky = isFingerExtended(hand, HandJoint.PinkyTip, HandJoint.PinkyPip);

  // The thumb folds sideways, not inward, so the wrist-distance test does not
  // work for it; compare it against the index knuckle instead.
  const scale = handScale(hand);
  const thumb = fingerDistance(hand, HandJoint.ThumbTip, HandJoint.IndexMcp, scale) > 0.62;

  return {
    thumb,
    index,
    middle,
    ring,
    pinky,
    count: Number(thumb) + Number(index) + Number(middle) + Number(ring) + Number(pinky),
  };
}

export function classifyGesture(hand: HandFrame): GestureKind {
  if (!hand.present || hand.points.length < HAND_JOINT_COUNT) return 'none';
  const fingers = readFingers(hand);

  if (fingers.index && fingers.middle && !fingers.ring && !fingers.pinky) return 'peace';
  if (fingers.index && !fingers.middle && !fingers.ring && !fingers.pinky) return 'point';
  if (fingers.count >= 4) return 'open';
  if (fingers.count <= 1) return 'fist';
  return 'none';
}

export class GestureRecognizer {
  private readonly options: Required<GestureOptions>;

  readonly state: GestureState = {
    kind: 'none',
    cursorX: 0.5,
    cursorY: 0.5,
    pinchStrength: 0,
    pinchStarted: false,
    pinchReleased: false,
    pinchHeld: 0,
    dwellProgress: 0,
    dwellFired: false,
    swipe: 'none',
    backHeld: 0,
    backFired: false,
    present: false,
    confidence: 0,
  };

  // A pinch is a hysteresis band so a trembling hand does not machine-gun clicks.
  private readonly pinchGate = new Hysteresis(0.62, 0.42, 0.04);
  private readonly pinchSignal = new Ema(0.05);
  private readonly confidenceSignal = new Ema(0.12);

  private wasPinched = false;
  private dwellTarget: string | null = null;
  private dwellElapsed = 0;
  private dwellLockedUntilRelease = false;

  private swipeStartX = 0;
  private swipeStartY = 0;
  private swipeElapsed = 0;
  private swipeArmed = false;
  private swipeCooldown = 0;

  private absentFor = 0;

  constructor(options: GestureOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Feed the primary hand every vision frame. Pass `null` when none is visible. */
  update(hand: HandFrame | null, dt: number): GestureState {
    const state = this.state;
    state.pinchStarted = false;
    state.pinchReleased = false;
    state.dwellFired = false;
    state.backFired = false;
    state.swipe = 'none';
    this.swipeCooldown = Math.max(0, this.swipeCooldown - dt);

    if (!hand || !hand.present) {
      this.absentFor += dt;
      // Short dropouts are common; keep the cursor alive briefly so a flicker
      // does not cancel a dwell the player is halfway through.
      if (this.absentFor > 0.25) {
        state.present = false;
        state.kind = 'none';
        state.pinchStrength = 0;
        state.dwellProgress = 0;
        state.backHeld = 0;
        this.dwellTarget = null;
        this.dwellElapsed = 0;
        this.swipeArmed = false;
      }
      state.confidence = this.confidenceSignal.push(0, dt);
      if (this.wasPinched) {
        this.wasPinched = false;
        state.pinchReleased = true;
        this.dwellLockedUntilRelease = false;
      }
      return state;
    }

    this.absentFor = 0;
    state.present = true;
    state.confidence = this.confidenceSignal.push(clamp(hand.score, 0, 1), dt);
    state.kind = classifyGesture(hand);

    this.updateCursor(hand, dt);
    this.updatePinch(hand, dt);
    this.updateBack(state, dt);
    this.updateSwipe(hand, dt);

    return state;
  }

  private updateCursor(hand: HandFrame, dt: number): void {
    const tip = hand.points[HandJoint.IndexTip];
    const knuckle = hand.points[HandJoint.IndexMcp];

    // Blend the fingertip with the knuckle: the tip alone is precise but shaky,
    // the knuckle alone is steady but lags behind intent.
    const targetX = tip.x * 0.72 + knuckle.x * 0.28;
    const targetY = tip.y * 0.72 + knuckle.y * 0.28;

    // Expand the usable rectangle so the screen corners are reachable.
    const margin = this.options.activeMargin;
    const mapped = (value: number) => clamp((value - margin) / (1 - margin * 2), 0, 1);

    const nextX = mapped(targetX);
    const nextY = mapped(targetY);

    // Light temporal smoothing on top of the tracker's own filter — the cursor
    // is the one thing the player stares at, so residual jitter is very visible.
    this.state.cursorX = damp(this.state.cursorX, nextX, 0.045, dt);
    this.state.cursorY = damp(this.state.cursorY, nextY, 0.045, dt);
  }

  private updatePinch(hand: HandFrame, dt: number): void {
    const scale = handScale(hand);
    const gap = fingerDistance(hand, HandJoint.ThumbTip, HandJoint.IndexTip, scale);

    // Map the gap onto `[0, 1]`: touching reads ~0.25 hand-units, a relaxed
    // open hand reads ~0.95.
    const raw = clamp(1 - (gap - 0.25) / (0.85 - 0.25), 0, 1);
    const strength = this.pinchSignal.push(raw, dt);
    this.state.pinchStrength = strength;

    const pinched = this.pinchGate.update(strength, dt);
    if (pinched && !this.wasPinched) {
      this.state.pinchStarted = true;
      this.state.pinchHeld = 0;
      // A deliberate pinch should not also fire the dwell that was building.
      this.dwellElapsed = 0;
      this.dwellLockedUntilRelease = true;
    } else if (!pinched && this.wasPinched) {
      this.state.pinchReleased = true;
      this.dwellLockedUntilRelease = false;
    } else if (pinched) {
      this.state.pinchHeld += dt;
    }
    this.wasPinched = pinched;
  }

  private updateBack(state: GestureState, dt: number): void {
    if (state.kind === 'open' && !this.wasPinched) {
      state.backHeld += dt;
      if (state.backHeld >= this.options.backTime) {
        state.backFired = true;
        state.backHeld = -0.8; // negative acts as a cooldown before it can re-fire
      }
    } else if (state.backHeld > 0) {
      state.backHeld = 0;
    } else {
      state.backHeld = Math.min(0, state.backHeld + dt);
    }
  }

  private updateSwipe(hand: HandFrame, dt: number): void {
    // Only an open hand swipes; otherwise moving the cursor quickly would
    // constantly flip the character carousel.
    if (this.state.kind !== 'open' || this.swipeCooldown > 0) {
      this.swipeArmed = false;
      return;
    }

    const palm = hand.points[HandJoint.MiddleMcp];
    if (!this.swipeArmed) {
      this.swipeArmed = true;
      this.swipeStartX = palm.x;
      this.swipeStartY = palm.y;
      this.swipeElapsed = 0;
      return;
    }

    this.swipeElapsed += dt;
    const dx = palm.x - this.swipeStartX;
    const dy = palm.y - this.swipeStartY;

    // A swipe is a fast, committed move — slow drift over a long window is just
    // the player repositioning their arm.
    if (this.swipeElapsed > 0.45) {
      this.swipeArmed = false;
      return;
    }

    const threshold = 0.16;
    if (Math.abs(dx) > threshold && Math.abs(dx) > Math.abs(dy) * 1.6) {
      this.state.swipe = dx > 0 ? 'right' : 'left';
      this.swipeArmed = false;
      this.swipeCooldown = 0.5;
    } else if (Math.abs(dy) > threshold && Math.abs(dy) > Math.abs(dx) * 1.6) {
      this.state.swipe = dy > 0 ? 'down' : 'up';
      this.swipeArmed = false;
      this.swipeCooldown = 0.5;
    }
  }

  /**
   * Called by the UI each frame with whatever the cursor is over.
   * Returns dwell progress so the widget can draw its fill ring.
   */
  hover(targetId: string | null, dt: number): number {
    if (targetId === null || this.dwellLockedUntilRelease) {
      this.dwellTarget = targetId;
      this.dwellElapsed = 0;
      this.state.dwellProgress = 0;
      return 0;
    }

    if (targetId !== this.dwellTarget) {
      this.dwellTarget = targetId;
      this.dwellElapsed = 0;
    }

    this.dwellElapsed += dt;
    const progress = clamp(this.dwellElapsed / this.options.dwellTime, 0, 1);
    this.state.dwellProgress = progress;

    if (progress >= 1) {
      this.state.dwellFired = true;
      this.dwellElapsed = 0;
      this.state.dwellProgress = 0;
      // Require leaving and re-entering before the same target can dwell again.
      this.dwellLockedUntilRelease = true;
      this.dwellTarget = null;
    }

    return progress;
  }

  /** Clears dwell state — call when a screen changes under the cursor. */
  resetDwell(): void {
    this.dwellTarget = null;
    this.dwellElapsed = 0;
    this.state.dwellProgress = 0;
    this.dwellLockedUntilRelease = false;
  }
}
