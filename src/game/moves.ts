import type { StrikeHeight, Technique } from '@/vision/motion/types';
import {
  HITSTOP_HEAVY,
  HITSTOP_LIGHT,
  HITSTOP_MEDIUM,
  SHAKE_HEAVY,
  SHAKE_LIGHT,
  SHAKE_MEDIUM,
} from './constants';

/**
 * Frame data.
 *
 * Every technique the camera can recognise maps to one entry here. This table
 * is the balance surface of the entire game: change a number in this file and
 * the fight feels different; change anything else and it mostly looks
 * different.
 *
 * The design brief for these numbers was unusual. In a normal fighting game
 * the player commits to a move by pressing a button and the game owes them
 * exactly the frames advertised. Here the player commits with their *body*,
 * and the detector has already spent ~40ms deciding what they threw. That
 * latency is unavoidable, so it is paid for by making startup frames shorter
 * than a pad game would use — a jab that says 4 frames of startup really
 * lands about 7 frames after the player's fist started moving.
 *
 * The other consequence: recovery is generous. A player who throws a wild
 * hook cannot "let go of the button", so the punishment for whiffing has to
 * come from the frames afterwards rather than from input lockout.
 */

/** Which limb carries the hitbox — decides where the hitbox is sampled from. */
export type Limb = 'leftHand' | 'rightHand' | 'leftFoot' | 'rightFoot' | 'body';

export interface MoveDef {
  readonly id: Technique;
  /** Name shown in the combo readout. */
  readonly label: string;

  // --- timing (frames at 60 Hz) -------------------------------------------
  /** Frames before the hitbox appears. */
  readonly startup: number;
  /** Frames the hitbox is live. */
  readonly active: number;
  /** Frames of recovery after the hitbox disappears. */
  readonly recovery: number;

  // --- damage --------------------------------------------------------------
  readonly damage: number;
  /** Frames the victim is stunned on hit. */
  readonly hitstun: number;
  /** Frames the victim is stunned when they block it. */
  readonly blockstun: number;

  // --- knockback -----------------------------------------------------------
  /** Horizontal push in metres per second. */
  readonly knockback: number;
  /** Upward launch in metres per second. Non-zero means the victim goes airborne. */
  readonly launch: number;

  // --- properties ----------------------------------------------------------
  readonly height: StrikeHeight;
  readonly limb: Limb;
  /** Reach in metres from the fighter's centre. */
  readonly reach: number;
  /** Vertical half-size of the hitbox in metres. */
  readonly hitboxHeight: number;
  readonly staminaCost: number;
  readonly meterGain: number;
  /** Frames of impact freeze applied to both fighters. */
  readonly hitstop: number;
  /** Camera shake magnitude in metres. */
  readonly shake: number;
  /**
   * Whether this move can be cancelled into another on hit, and from which
   * frame. `-1` means it cannot be cancelled at all.
   */
  readonly cancelFrom: number;
  /** Beats moves of lower priority when two hitboxes overlap on the same frame. */
  readonly priority: number;
  /** A move that cannot be blocked while crouching, etc. */
  readonly overhead: boolean;
  /** Knocks the victim down outright. */
  readonly knockdown: boolean;
}

function move(def: Partial<MoveDef> & Pick<MoveDef, 'id' | 'label'>): MoveDef {
  return {
    startup: 6,
    active: 3,
    recovery: 12,
    damage: 40,
    hitstun: 14,
    blockstun: 9,
    knockback: 2,
    launch: 0,
    height: 'mid',
    limb: 'rightHand',
    reach: 1.15,
    hitboxHeight: 0.28,
    staminaCost: 6,
    meterGain: 3,
    hitstop: HITSTOP_LIGHT,
    shake: SHAKE_LIGHT,
    cancelFrom: -1,
    priority: 1,
    overhead: false,
    knockdown: false,
    ...def,
  };
}

export const MOVES: Record<Technique, MoveDef> = {
  none: move({
    id: 'none',
    label: '—',
    damage: 0,
    startup: 0,
    active: 0,
    recovery: 0,
  }),

  // --- hands ---------------------------------------------------------------

  jab: move({
    id: 'jab',
    label: 'Джеб',
    // The fastest thing in the game. Its job is to interrupt, not to hurt.
    startup: 4,
    active: 3,
    recovery: 9,
    damage: 32,
    hitstun: 13,
    blockstun: 8,
    knockback: 1.4,
    limb: 'leftHand',
    reach: 1.2,
    staminaCost: 4,
    meterGain: 3,
    hitstop: HITSTOP_LIGHT,
    shake: SHAKE_LIGHT,
    cancelFrom: 7,
    priority: 2,
  }),

  cross: move({
    id: 'cross',
    label: 'Кросс',
    // Rear hand: more startup, considerably more payoff.
    startup: 7,
    active: 4,
    recovery: 15,
    damage: 62,
    hitstun: 18,
    blockstun: 11,
    knockback: 3.1,
    limb: 'rightHand',
    reach: 1.35,
    staminaCost: 8,
    meterGain: 5,
    hitstop: HITSTOP_MEDIUM,
    shake: SHAKE_MEDIUM,
    cancelFrom: 11,
    priority: 3,
  }),

  hook: move({
    id: 'hook',
    label: 'Хук',
    // Wide arc: slower and shorter, but it curves around a high guard.
    startup: 9,
    active: 4,
    recovery: 18,
    damage: 74,
    hitstun: 21,
    blockstun: 12,
    knockback: 3.6,
    height: 'high',
    limb: 'leftHand',
    reach: 1.05,
    hitboxHeight: 0.34,
    staminaCost: 11,
    meterGain: 6,
    hitstop: HITSTOP_MEDIUM,
    shake: SHAKE_MEDIUM,
    priority: 3,
  }),

  uppercut: move({
    id: 'uppercut',
    label: 'Апперкот',
    // The launcher. Short reach, big commitment, opens up air combos.
    startup: 10,
    active: 5,
    recovery: 24,
    damage: 88,
    hitstun: 26,
    blockstun: 14,
    knockback: 1.6,
    launch: 6.4,
    height: 'mid',
    limb: 'rightHand',
    reach: 0.95,
    hitboxHeight: 0.52,
    staminaCost: 15,
    meterGain: 9,
    hitstop: HITSTOP_HEAVY,
    shake: SHAKE_HEAVY,
    priority: 4,
  }),

  overhead: move({
    id: 'overhead',
    label: 'Оверхед',
    // Beats a crouching opponent outright. Slow enough to be reactable.
    startup: 14,
    active: 4,
    recovery: 22,
    damage: 82,
    hitstun: 24,
    blockstun: 13,
    knockback: 2.8,
    height: 'high',
    limb: 'rightHand',
    reach: 1.15,
    hitboxHeight: 0.4,
    staminaCost: 13,
    meterGain: 8,
    hitstop: HITSTOP_HEAVY,
    shake: SHAKE_MEDIUM,
    overhead: true,
    priority: 4,
  }),

  // --- legs ----------------------------------------------------------------

  lowKick: move({
    id: 'lowKick',
    label: 'Лоу-кик',
    // Must be blocked low. Chips away at stance and stamina.
    startup: 8,
    active: 4,
    recovery: 17,
    damage: 54,
    hitstun: 17,
    blockstun: 11,
    knockback: 1.9,
    height: 'low',
    limb: 'rightFoot',
    reach: 1.4,
    hitboxHeight: 0.26,
    staminaCost: 9,
    meterGain: 5,
    hitstop: HITSTOP_MEDIUM,
    shake: SHAKE_LIGHT,
    priority: 2,
  }),

  midKick: move({
    id: 'midKick',
    label: 'Мид-кик',
    startup: 10,
    active: 4,
    recovery: 20,
    damage: 78,
    hitstun: 22,
    blockstun: 13,
    knockback: 3.8,
    limb: 'rightFoot',
    reach: 1.65,
    hitboxHeight: 0.32,
    staminaCost: 12,
    meterGain: 7,
    hitstop: HITSTOP_MEDIUM,
    shake: SHAKE_MEDIUM,
    priority: 3,
  }),

  highKick: move({
    id: 'highKick',
    label: 'Хай-кик',
    // The round-ender. Huge damage, huge recovery, guaranteed knockdown.
    startup: 14,
    active: 5,
    recovery: 28,
    damage: 105,
    hitstun: 30,
    blockstun: 16,
    knockback: 5.2,
    height: 'high',
    limb: 'leftFoot',
    reach: 1.7,
    hitboxHeight: 0.38,
    staminaCost: 18,
    meterGain: 11,
    hitstop: HITSTOP_HEAVY,
    shake: SHAKE_HEAVY,
    knockdown: true,
    priority: 5,
  }),

  pushKick: move({
    id: 'pushKick',
    label: 'Тип',
    // Low damage, enormous knockback: the tool for making space.
    startup: 9,
    active: 4,
    recovery: 16,
    damage: 38,
    hitstun: 14,
    blockstun: 14,
    knockback: 6.5,
    limb: 'rightFoot',
    reach: 1.75,
    hitboxHeight: 0.3,
    staminaCost: 8,
    meterGain: 4,
    hitstop: HITSTOP_MEDIUM,
    shake: SHAKE_MEDIUM,
    priority: 3,
  }),

  kneeStrike: move({
    id: 'kneeStrike',
    label: 'Колено',
    // Close range only, but fast and it hurts.
    startup: 7,
    active: 4,
    recovery: 15,
    damage: 68,
    hitstun: 20,
    blockstun: 12,
    knockback: 2.2,
    limb: 'rightFoot',
    reach: 0.85,
    hitboxHeight: 0.3,
    staminaCost: 10,
    meterGain: 6,
    hitstop: HITSTOP_MEDIUM,
    shake: SHAKE_MEDIUM,
    priority: 3,
  }),
};

/** Total frames a move occupies. */
export function moveDuration(def: MoveDef): number {
  return def.startup + def.active + def.recovery;
}

/**
 * Frame advantage on block: positive means the attacker recovers first and
 * may press again, negative means they are open to a punish. Shown in the
 * training-room overlay.
 */
export function frameAdvantageOnBlock(def: MoveDef): number {
  return def.blockstun - def.recovery;
}

export function frameAdvantageOnHit(def: MoveDef): number {
  return def.hitstun - def.recovery;
}

/** Whether a block at `guardHeight` stops a strike aimed at `height`. */
export function guardCovers(guardHeight: number, height: StrikeHeight, crouching: boolean): boolean {
  if (height === 'low') return crouching || guardHeight < 0.45;
  if (height === 'high') return !crouching && guardHeight > 0.35;
  // Mid strikes are stopped by any competent guard.
  return true;
}

/** All techniques that actually have a hitbox, for the move-list screen. */
export const STRIKE_TECHNIQUES: readonly Technique[] = (
  Object.keys(MOVES) as Technique[]
).filter((id) => MOVES[id].damage > 0);
