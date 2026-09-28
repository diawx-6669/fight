import { clamp } from '@/core/math';
import { RingBuffer } from '@/core/pool';
import { Rng } from '@/core/rng';
import { action, type ActionEvent, type Technique } from '@/vision/motion/types';
import type { Fighter } from '../fighter';
import { MOVES, moveDuration } from '../moves';
import { TICK_RATE } from '../constants';
import type { DifficultySettings } from './difficulty';
import type { Personality } from './personality';

/**
 * The opponent's mind.
 *
 * Built around one rule that is easy to state and easy to violate by accident:
 * **the AI may only act on information a human could have.** It reads the
 * player's fighter through a delay buffer, so it responds to what you were
 * doing `reactionFrames` ago, not what you are doing now. It never inspects
 * the input queue, never knows which move is coming, and never reacts to a
 * strike before its startup frames have visibly begun.
 *
 * Everything else is a small utility system. Each tick every intent scores
 * itself from the current situation, the highest score wins, and the winner is
 * held for a minimum number of frames so the fighter commits to a plan instead
 * of vibrating between two of them.
 */

export type Intent = 'neutral' | 'approach' | 'retreat' | 'attack' | 'defend' | 'punish' | 'reset';

/** What the AI believes about the opponent, as of `reactionFrames` ago. */
interface Perception {
  x: number;
  distance: number;
  attacking: boolean;
  /** Frames into their current move. */
  moveFrame: number;
  /** Frames until their move's hitbox goes live; negative once it has. */
  framesToImpact: number;
  /** Total recovery they will be stuck in if this whiffs. */
  recoveryFrames: number;
  strikeHeight: 'high' | 'mid' | 'low';
  airborne: boolean;
  stunned: boolean;
  healthRatio: number;
}

function emptyPerception(): Perception {
  return {
    x: 0,
    distance: 99,
    attacking: false,
    moveFrame: 0,
    framesToImpact: 99,
    recoveryFrames: 0,
    strikeHeight: 'mid',
    airborne: false,
    stunned: false,
    healthRatio: 1,
  };
}

/** Minimum frames an intent is held before it can be reconsidered. */
const INTENT_COMMITMENT: Record<Intent, number> = {
  neutral: 10,
  approach: 14,
  retreat: 12,
  attack: 4,
  defend: 8,
  punish: 4,
  reset: 20,
};

export interface BrainOptions {
  difficulty: DifficultySettings;
  personality: Personality;
  seed: number;
}

export class AiBrain {
  private readonly rng: Rng;
  private readonly history = new RingBuffer<Perception>(48);

  private intent: Intent = 'neutral';
  private intentFrames = 0;

  /** Frames until the AI is allowed to act again — its "hands are busy" timer. */
  private actionCooldown = 0;

  /** Frames left of a planned combo string. */
  private comboRemaining = 0;

  /** Set while deliberately making a mistake, so the error lasts long enough to matter. */
  private blunderFrames = 0;

  /** Guard height the AI is currently committed to. */
  private guardHeight = 0.6;

  private difficulty: DifficultySettings;
  private readonly personality: Personality;

  /** Exposed for the debug overlay. */
  readonly debug = { intent: 'neutral' as Intent, distance: 0, pressure: 0 };

  constructor(options: BrainOptions) {
    this.difficulty = options.difficulty;
    this.personality = options.personality;
    this.rng = new Rng(options.seed);
  }

  setDifficulty(difficulty: DifficultySettings): void {
    this.difficulty = difficulty;
  }

  /**
   * Produces this tick's input for `self`.
   * Mutates `self.input` in place rather than allocating.
   */
  think(self: Fighter, opponent: Fighter): void {
    const input = self.input;
    input.actions.length = 0;

    this.observe(self, opponent);
    const perception = this.recall();

    this.debug.distance = perception.distance;

    if (this.actionCooldown > 0) this.actionCooldown--;
    if (this.blunderFrames > 0) this.blunderFrames--;
    this.intentFrames++;

    // A stunned fighter has no decisions to make.
    if (self.isStunned) {
      input.motion.guarding = false;
      input.motion.advance = 0;
      this.intent = 'reset';
      this.intentFrames = 0;
      return;
    }

    // Deliberate mistakes: the AI occasionally stands still with its guard
    // down. This is what makes lower tiers feel like an opponent rather than a
    // difficulty setting.
    if (this.blunderFrames === 0 && this.rng.next() < this.difficulty.mistakeRate / TICK_RATE) {
      this.blunderFrames = this.rng.int(14, 34);
    }

    if (this.intentFrames >= INTENT_COMMITMENT[this.intent]) {
      const next = this.chooseIntent(self, perception);
      if (next !== this.intent) {
        this.intent = next;
        this.intentFrames = 0;
      }
    }

    this.debug.intent = this.intent;
    this.act(self, perception, input);
  }

  // --- perception ----------------------------------------------------------

  private observe(self: Fighter, opponent: Fighter): void {
    const move = opponent.move;
    const attacking = opponent.state === 'attacking' && move !== null;

    this.history.push({
      x: opponent.x,
      distance: Math.abs(opponent.x - self.x),
      attacking,
      moveFrame: opponent.moveFrame,
      framesToImpact: attacking && move ? move.startup - opponent.moveFrame : 99,
      recoveryFrames: attacking && move ? move.recovery : 0,
      strikeHeight: attacking && move ? move.height : 'mid',
      airborne: opponent.isAirborne,
      stunned: opponent.isStunned,
      healthRatio: opponent.healthRatio,
    });
  }

  /** Reads the world as it was `reactionFrames` ago, with per-read jitter. */
  private recall(): Perception {
    const jitter = this.rng.int(0, this.difficulty.reactionJitter);
    const delay = this.difficulty.reactionFrames + jitter;
    return this.history.at(delay) ?? this.history.oldest ?? emptyPerception();
  }

  // --- decision ------------------------------------------------------------

  private chooseIntent(self: Fighter, perception: Perception): Intent {
    if (this.blunderFrames > 0) return 'neutral';

    const difficulty = this.difficulty;
    const personality = this.personality;
    const range = personality.preferredRange;
    const distance = perception.distance;

    const scores: Record<Intent, number> = {
      neutral: 0.2,
      approach: 0,
      retreat: 0,
      attack: 0,
      defend: 0,
      punish: 0,
      reset: 0,
    };

    // --- defend: a strike is visibly on its way ----------------------------
    if (perception.attacking && perception.framesToImpact > 0 && perception.framesToImpact < 16) {
      const inDanger = distance < range * 1.5;
      if (inDanger) {
        scores.defend = difficulty.blockChance * personality.defenseBias * 2.2;
        // Dodging is riskier but leaves the AI in position to punish.
        if (this.rng.chance(difficulty.dodgeChance)) scores.retreat = scores.defend * 0.9;
      }
    }

    // --- punish: they whiffed and are stuck in recovery --------------------
    const theyAreRecovering =
      perception.attacking && perception.framesToImpact < -2 && perception.recoveryFrames > 8;
    if ((theyAreRecovering || perception.stunned) && distance < range * 1.6) {
      scores.punish = difficulty.punishRate * 2.6;
    }

    // --- attack: an ordinary opening ---------------------------------------
    if (distance < range * 1.25 && self.stamina > 18) {
      const opening = perception.stunned ? 1.6 : 1;
      scores.attack = difficulty.aggression * personality.aggressionBias * opening * 1.4;
      // Being low on health makes the AI hungrier, not more careful — a cornered
      // opponent that turtles is a boring one.
      scores.attack *= 1 + (1 - self.healthRatio) * 0.4;
    }

    // --- spacing ------------------------------------------------------------
    const rangeError = distance - range;
    if (rangeError > 0.25) {
      scores.approach = clamp(rangeError * 0.8, 0, 2) * personality.spacingDiscipline + 0.3;
    } else if (rangeError < -0.35) {
      scores.retreat += clamp(-rangeError * 0.9, 0, 2) * personality.spacingDiscipline;
    }

    // Low stamina: back off and breathe.
    if (self.staminaRatio < 0.25) {
      scores.retreat += 1.2;
      scores.attack *= 0.4;
    }

    // Winning on health with time running out? Stop taking risks.
    if (self.healthRatio > perception.healthRatio + 0.25) {
      scores.retreat += 0.3;
      scores.attack *= 0.85;
    }

    let best: Intent = 'neutral';
    let bestScore = -Infinity;
    for (const key of Object.keys(scores) as Intent[]) {
      // A little noise stops the AI from being perfectly predictable when two
      // options are close.
      const score = scores[key] + this.rng.range(-0.12, 0.12);
      if (score > bestScore) {
        bestScore = score;
        best = key;
      }
    }

    this.debug.pressure = scores.attack;
    return best;
  }

  // --- execution -----------------------------------------------------------

  private act(self: Fighter, perception: Perception, input: Fighter['input']): void {
    const motion = input.motion;
    const personality = this.personality;

    // Reset everything the simulation reads, then set what this intent wants.
    motion.guarding = false;
    motion.advance = 0;
    motion.crouch = 0;
    motion.lean = 0;
    motion.quality = 1;

    switch (this.intent) {
      case 'approach': {
        motion.advance = 0.85;
        // Occasionally jump in, which is how a mobile personality closes space.
        if (
          perception.distance > 3 &&
          this.rng.chance((personality.mobility * 0.5) / TICK_RATE) &&
          !self.isAirborne
        ) {
          input.actions.push(action({ kind: 'jump', power: 0.9, timestamp: 0 }));
        }
        break;
      }

      case 'retreat':
        motion.advance = -0.8;
        motion.guarding = this.rng.chance(0.5);
        break;

      case 'defend': {
        motion.guarding = true;
        motion.advance = -0.15;
        // Guard at the height it read — correctly, most of the time.
        const correct = this.rng.chance(this.difficulty.guardAccuracy);
        const wanted = perception.strikeHeight;
        const height = correct ? wanted : wanted === 'low' ? 'high' : 'low';
        this.guardHeight = height === 'high' ? 0.85 : height === 'low' ? 0.2 : 0.55;
        motion.guardHeight = this.guardHeight;
        motion.crouch = height === 'low' ? 0.8 : 0;

        // A parry attempt, for the tiers that have earned one.
        if (
          perception.framesToImpact > 0 &&
          perception.framesToImpact < 6 &&
          this.rng.chance(this.difficulty.parryChance)
        ) {
          input.actions.push(
            action({ kind: 'parry', side: 'right', power: 1, timestamp: 0 }),
          );
        }
        break;
      }

      case 'punish':
      case 'attack': {
        motion.advance = perception.distance > personality.preferredRange ? 0.6 : 0.1;
        if (this.actionCooldown === 0) this.throwStrike(self, perception, input);
        break;
      }

      case 'reset':
        motion.guarding = true;
        motion.guardHeight = 0.6;
        break;

      case 'neutral':
      default: {
        // Idle bob: drift around the preferred range rather than standing still,
        // which makes the opponent read as alive even when it is doing nothing.
        const drift = Math.sin(self.stateFrame * 0.06) * 0.25;
        motion.advance = drift;
        motion.guarding = this.blunderFrames === 0 && this.rng.chance(0.35);
        motion.guardHeight = this.guardHeight;
        break;
      }
    }

    motion.advance = clamp(motion.advance, -1, 1);
  }

  private throwStrike(self: Fighter, perception: Perception, input: Fighter['input']): void {
    const technique = this.pickTechnique(perception.distance);
    if (technique === 'none') return;

    const def = MOVES[technique];
    if (!def || self.stamina < def.staminaCost * 0.6) return;

    // Occasionally throw at the very edge of range on purpose — a feint that
    // baits a panic block or a whiff punish attempt.
    const feint = this.rng.chance(this.personality.feintRate);
    const power = feint ? this.rng.range(0.35, 0.55) : this.rng.range(0.7, 1);

    input.actions.push(
      action({
        kind: def.limb.endsWith('Foot') ? 'kick' : 'punch',
        technique,
        side: def.limb.startsWith('left') ? 'left' : 'right',
        height: def.height,
        power,
        confidence: 1,
        timestamp: 0,
      }),
    );

    // Plan a follow-up if this is meant to be a string.
    if (this.comboRemaining > 0) {
      this.comboRemaining--;
      this.actionCooldown = def.startup + def.active + 2;
    } else {
      this.comboRemaining = this.rng.chance(this.difficulty.comboRate) ? this.rng.int(1, 3) : 0;
      this.actionCooldown = moveDuration(def) + this.rng.int(2, this.personality.patience);
    }
  }

  /** Weighted pick among techniques whose reach matches the current distance. */
  private pickTechnique(distance: number): Technique {
    const weights = this.personality.moveWeights;
    const candidates: Technique[] = [];
    const scores: number[] = [];

    for (const [id, weight] of Object.entries(weights) as [Technique, number][]) {
      const def = MOVES[id];
      if (!def || def.damage <= 0) continue;

      // Score by how well the move's reach matches the gap. A move that cannot
      // reach is useless; one thrown from far inside its range is wasteful.
      const error = Math.abs(def.reach - distance);
      if (distance > def.reach + 0.45) continue;
      const fit = 1 / (1 + error * 2.2);
      candidates.push(id);
      scores.push(weight * fit);
    }

    if (candidates.length === 0) return 'none';
    return candidates[this.rng.weighted(scores)];
  }

  reset(): void {
    this.history.clear();
    this.intent = 'neutral';
    this.intentFrames = 0;
    this.actionCooldown = 0;
    this.comboRemaining = 0;
    this.blunderFrames = 0;
    this.guardHeight = 0.6;
  }
}

export type { ActionEvent };
