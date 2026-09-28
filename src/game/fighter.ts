import { clamp, damp, lerp } from '@/core/math';
import type { ActionEvent, MotionState, Technique } from '@/vision/motion/types';
import { createMotionState } from '@/vision/motion/types';
import type { Character } from './characters';
import { getCharacter } from './characters';
import {
  AIR_DRAG,
  ARENA_HALF_WIDTH,
  BACKPEDAL_SPEED,
  COMBO_SCALING,
  COMBO_TIMEOUT_FRAMES,
  DODGE_IFRAMES,
  GRAVITY,
  GROUND_FRICTION,
  GROUND_Y,
  GUARD_BREAK_STUN_FRAMES,
  HIP_HEIGHT,
  JUMP_VELOCITY,
  MAX_FALL_SPEED,
  MAX_HEALTH,
  MAX_METER,
  MAX_STAMINA,
  METER_PER_DAMAGE_TAKEN,
  MIN_COMBO_SCALE,
  PARRY_COUNTER_WINDOW,
  PARRY_IFRAMES,
  STAMINA_REGEN,
  STAMINA_REGEN_GUARDING,
  TICK_SECONDS,
  WALK_SPEED,
} from './constants';
import { FighterBoxes } from './hitbox';
import { MOVES, moveDuration, type MoveDef } from './moves';
import { applyNeutralStance, FighterRig, scaleProportions } from './rig';

/**
 * A fighter: state machine, physics body and resource pool.
 *
 * The unusual part of this class is how little of the *animation* it owns. A
 * conventional fighting game entity drives both the move and the pose from the
 * same clock. Here the move timeline and the body pose are decoupled: frame
 * data decides when damage happens, the player's body decides what the fighter
 * looks like while it happens. `poseInfluence` is the dial between them —
 * full player control when free, handing over to the simulation during hitstun
 * and knockdowns, where the player's body is no longer a truthful description
 * of what their fighter is doing.
 */

export type FighterState =
  | 'intro'
  | 'idle'
  | 'attacking'
  | 'hitstun'
  | 'blockstun'
  | 'guardBreak'
  | 'knockdown'
  | 'getup'
  | 'victory'
  | 'defeat';

export type ControllerKind = 'local' | 'ai' | 'remote';

/** What a controller produces each tick, whoever it is. */
export interface FighterInput {
  /** Discrete actions committed this tick. */
  actions: ActionEvent[];
  /** Held posture. */
  motion: MotionState;
}

export function createInput(): FighterInput {
  return { actions: [], motion: createMotionState() };
}

export interface FighterOptions {
  characterId: string;
  /** `0` is the left-hand fighter, `1` the right-hand one. */
  slot: 0 | 1;
  controller: ControllerKind;
  startX: number;
}

export class Fighter {
  readonly character: Character;
  readonly slot: 0 | 1;
  readonly controller: ControllerKind;

  // --- transform -----------------------------------------------------------
  x = 0;
  y = GROUND_Y;
  vx = 0;
  vy = 0;
  facing: 1 | -1 = 1;

  // --- resources -----------------------------------------------------------
  health: number;
  readonly maxHealth: number;
  stamina: number;
  readonly maxStamina: number;
  meter = 0;

  // --- state ---------------------------------------------------------------
  state: FighterState = 'intro';
  /** Frames spent in the current state. */
  stateFrame = 0;

  /** Current move, or `null` when free to act. */
  move: MoveDef | null = null;
  moveFrame = 0;
  /** Set once a move has connected, so it cannot hit twice. */
  moveHasHit = false;

  /** Frames of impact freeze remaining. Nothing advances while this is set. */
  hitstop = 0;

  /** Frames of invulnerability remaining. */
  iframes = 0;

  /** Frames left in which a parry counter deals bonus damage. */
  parryWindow = 0;

  /** True while the player is holding a guard and able to use it. */
  guarding = false;
  guardHeight = 0.5;
  crouching = false;

  /** Combo tracking for the attacker. */
  comboHits = 0;
  comboDamage = 0;
  framesSinceHit = 999;

  /** Ticks since the fighter last connected, used by the AI to read pressure. */
  lastHitTick = -999;
  lastHurtTick = -999;

  // --- presentation --------------------------------------------------------
  readonly rig = new FighterRig();
  readonly boxes = new FighterBoxes();

  /**
   * How much the live pose drives the rig, `[0, 1]`.
   * Falls to near zero during hitstun so the fighter visibly reacts.
   */
  poseInfluence = 1;

  /** Set for one frame when something notable happens, for the renderer. */
  flashHit = 0;
  flashBlock = 0;
  flashParry = 0;

  /** Grows while the fighter is losing, used for the desperation aura. */
  rage = 0;

  readonly input: FighterInput = createInput();

  constructor(options: FighterOptions) {
    this.character = getCharacter(options.characterId);
    this.slot = options.slot;
    this.controller = options.controller;

    const stats = this.character.stats;
    this.maxHealth = Math.round(MAX_HEALTH * stats.toughness);
    this.health = this.maxHealth;
    this.maxStamina = MAX_STAMINA * stats.endurance;
    this.stamina = this.maxStamina;

    this.x = options.startX;
    this.facing = options.slot === 0 ? 1 : -1;

    this.rig.proportions = scaleProportions(this.character.proportions, stats.build);
    this.rig.facing = this.facing;
    this.rig.hipHeight = HIP_HEIGHT;
    applyNeutralStance(this.rig, this.x, this.y);
    this.boxes.syncHurtboxes(this.rig);
  }

  // --- queries -------------------------------------------------------------

  get isAlive(): boolean {
    return this.health > 0;
  }

  get healthRatio(): number {
    return clamp(this.health / this.maxHealth, 0, 1);
  }

  get staminaRatio(): number {
    return clamp(this.stamina / this.maxStamina, 0, 1);
  }

  get meterRatio(): number {
    return clamp(this.meter / MAX_METER, 0, 1);
  }

  get isAirborne(): boolean {
    return this.y > GROUND_Y + 0.02;
  }

  /** Free to start a new move. */
  get canAct(): boolean {
    if (this.hitstop > 0) return false;
    switch (this.state) {
      case 'idle':
        return true;
      case 'attacking':
        // Cancel windows let a jab flow into a cross without waiting out recovery.
        return (
          this.move !== null &&
          this.move.cancelFrom >= 0 &&
          this.moveHasHit &&
          this.moveFrame >= this.move.cancelFrom
        );
      default:
        return false;
    }
  }

  get isStunned(): boolean {
    return (
      this.state === 'hitstun' ||
      this.state === 'blockstun' ||
      this.state === 'guardBreak' ||
      this.state === 'knockdown' ||
      this.state === 'getup'
    );
  }

  /** Distance from this fighter to a world x. */
  distanceTo(otherX: number): number {
    return Math.abs(otherX - this.x);
  }

  // --- simulation ----------------------------------------------------------

  /**
   * Advances one simulation tick.
   *
   * `opponentX` is passed in rather than the whole opponent because a fighter
   * only needs to know which way to face; keeping the coupling that narrow is
   * what lets the AI and the network layer reuse this untouched.
   */
  tick(opponentX: number, tickCount: number): void {
    // Hit-stop freezes everything except the flash timers, which is exactly the
    // point: the image holds still for a beat while the effect plays.
    if (this.hitstop > 0) {
      this.hitstop--;
      this.decayFlashes();
      return;
    }

    this.stateFrame++;
    this.framesSinceHit++;
    if (this.iframes > 0) this.iframes--;
    if (this.parryWindow > 0) this.parryWindow--;

    if (this.framesSinceHit > COMBO_TIMEOUT_FRAMES && this.comboHits > 0) {
      this.comboHits = 0;
      this.comboDamage = 0;
    }

    this.updateFacing(opponentX);
    this.updateState(tickCount);
    this.updatePhysics();
    this.updateResources();
    this.decayFlashes();
  }

  private updateFacing(opponentX: number): void {
    // Turning mid-move would teleport the hitbox across the opponent, so it is
    // only allowed while free.
    if (this.state !== 'idle' && this.state !== 'intro') return;
    const wanted: 1 | -1 = opponentX >= this.x ? 1 : -1;
    if (wanted !== this.facing) {
      this.facing = wanted;
      this.rig.facing = wanted;
    }
  }

  private updateState(tickCount: number): void {
    switch (this.state) {
      case 'intro':
        this.poseInfluence = damp(this.poseInfluence, 1, 0.2, TICK_SECONDS);
        break;

      case 'idle':
        this.poseInfluence = damp(this.poseInfluence, 1, 0.08, TICK_SECONDS);
        break;

      case 'attacking': {
        const move = this.move;
        if (!move) {
          this.enter('idle');
          break;
        }
        this.moveFrame++;
        // Attacking keeps the player in charge of the pose — the whole appeal
        // is that the fighter's punch is *your* punch.
        this.poseInfluence = damp(this.poseInfluence, 1, 0.05, TICK_SECONDS);
        if (this.moveFrame >= moveDuration(move)) {
          this.move = null;
          this.moveFrame = 0;
          this.enter('idle');
        }
        break;
      }

      case 'hitstun':
        // Hand the body over to the simulation: a struck fighter should recoil,
        // not keep mirroring a player who is standing perfectly still.
        this.poseInfluence = damp(this.poseInfluence, 0.25, 0.05, TICK_SECONDS);
        if (this.stateFrame >= this.stunFrames) this.enter('idle');
        break;

      case 'blockstun':
        this.poseInfluence = damp(this.poseInfluence, 0.6, 0.06, TICK_SECONDS);
        if (this.stateFrame >= this.stunFrames) this.enter('idle');
        break;

      case 'guardBreak':
        this.poseInfluence = damp(this.poseInfluence, 0.15, 0.06, TICK_SECONDS);
        if (this.stateFrame >= GUARD_BREAK_STUN_FRAMES) this.enter('idle');
        break;

      case 'knockdown':
        this.poseInfluence = damp(this.poseInfluence, 0, 0.08, TICK_SECONDS);
        if (this.stateFrame >= this.stunFrames && !this.isAirborne) this.enter('getup');
        break;

      case 'getup':
        this.poseInfluence = damp(this.poseInfluence, 0.8, 0.12, TICK_SECONDS);
        // Brief invulnerability on wake-up, or being knocked down once would
        // mean being knocked down forever.
        this.iframes = Math.max(this.iframes, 6);
        if (this.stateFrame >= 26) this.enter('idle');
        break;

      case 'victory':
      case 'defeat':
        this.poseInfluence = damp(this.poseInfluence, this.state === 'victory' ? 1 : 0, 0.2, TICK_SECONDS);
        break;
    }

    void tickCount;
  }

  /** Frames the current stun lasts; set when the stun is applied. */
  private stunFrames = 0;

  private updatePhysics(): void {
    const stats = this.character.stats;

    if (this.isAirborne || this.vy > 0) {
      this.vy -= GRAVITY * TICK_SECONDS;
      this.vy = Math.max(this.vy, -MAX_FALL_SPEED);
      this.vx = damp(this.vx, 0, 1 / Math.max(AIR_DRAG, 0.01), TICK_SECONDS);
    } else {
      this.y = GROUND_Y;
      this.vy = 0;

      // Walking is only possible when free; being pushed is not.
      if (this.state === 'idle' && !this.guarding) {
        const advance = clamp(this.input.motion.advance, -1, 1);
        const speed = advance >= 0 ? WALK_SPEED : BACKPEDAL_SPEED;
        const wanted = advance * speed * stats.speed * this.facing;
        this.vx = damp(this.vx, wanted, 0.08, TICK_SECONDS);
      } else {
        this.vx = damp(this.vx, 0, 1 / GROUND_FRICTION, TICK_SECONDS);
      }
    }

    this.x += this.vx * TICK_SECONDS;
    this.y += this.vy * TICK_SECONDS;

    if (this.y < GROUND_Y) {
      this.y = GROUND_Y;
      this.vy = 0;
      // Landing from a knockdown is what starts the get-up timer.
      if (this.state === 'knockdown') this.stateFrame = Math.max(this.stateFrame, this.stunFrames - 20);
    }

    const limit = ARENA_HALF_WIDTH - 0.5;
    if (this.x < -limit) {
      this.x = -limit;
      this.vx = Math.max(this.vx, 0);
    } else if (this.x > limit) {
      this.x = limit;
      this.vx = Math.min(this.vx, 0);
    }
  }

  private updateResources(): void {
    const stats = this.character.stats;
    const regen = this.guarding ? STAMINA_REGEN_GUARDING : STAMINA_REGEN;
    // No stamina recovery mid-move: pressure has to cost something.
    if (this.state !== 'attacking') {
      this.stamina = Math.min(this.maxStamina, this.stamina + regen * stats.endurance * TICK_SECONDS);
    }

    // Rage builds as health falls; the renderer turns it into an aura and the
    // combat layer into a small damage bonus.
    const target = 1 - this.healthRatio;
    this.rage = damp(this.rage, target * target, 0.4, TICK_SECONDS);
  }

  private decayFlashes(): void {
    this.flashHit = Math.max(0, this.flashHit - 1);
    this.flashBlock = Math.max(0, this.flashBlock - 1);
    this.flashParry = Math.max(0, this.flashParry - 1);
  }

  enter(state: FighterState): void {
    if (this.state === state) return;
    this.state = state;
    this.stateFrame = 0;
    if (state === 'idle') {
      this.move = null;
      this.moveFrame = 0;
      this.moveHasHit = false;
      this.boxes.clearStrike();
    }
  }

  // --- actions -------------------------------------------------------------

  /** Attempts to start a technique. Returns `false` when it was not allowed. */
  startMove(technique: Technique, power: number): boolean {
    const def = MOVES[technique];
    if (!def || def.damage <= 0) return false;
    if (!this.canAct) return false;

    const cost = def.staminaCost;
    // Out of stamina, the move still comes out but hits like wet paper — better
    // than swallowing the input, which would feel like the camera missed it.
    if (this.stamina < cost * 0.5) return false;

    this.stamina = Math.max(0, this.stamina - cost);
    this.move = def;
    this.moveFrame = 0;
    this.moveHasHit = false;
    this.lastMovePower = clamp(power, 0.2, 1);
    this.enter('attacking');
    this.state = 'attacking';
    this.stateFrame = 0;
    return true;
  }

  /** Power of the motion that launched the current move, scaling its damage. */
  lastMovePower = 1;

  jump(power: number): void {
    if (this.isAirborne || !this.canAct) return;
    this.vy = JUMP_VELOCITY * lerp(0.82, 1.1, clamp(power, 0, 1));
    // Carry the current walking momentum into the jump so a running leap goes
    // somewhere rather than straight up.
    this.vx += this.facing * this.input.motion.advance * 1.4;
  }

  dodge(side: 'left' | 'right', power: number): void {
    if (this.isStunned || this.isAirborne) return;
    this.iframes = Math.max(this.iframes, Math.round(DODGE_IFRAMES * lerp(0.7, 1.2, power)));
    // A slip carries the fighter a short way, which is what makes spacing
    // around it interesting.
    const direction = side === 'right' ? 1 : -1;
    this.vx += direction * 2.6 * power;
  }

  parry(): void {
    if (this.isStunned) return;
    this.iframes = Math.max(this.iframes, PARRY_IFRAMES);
    this.parryWindow = PARRY_COUNTER_WINDOW;
    this.flashParry = 12;
  }

  // --- damage --------------------------------------------------------------

  /** Applies damage and the stun that goes with it. */
  applyHit(damage: number, hitstun: number, knockback: number, launch: number, knockdown: boolean, hitstop: number): void {
    this.health = Math.max(0, this.health - damage);
    this.meter = Math.min(MAX_METER, this.meter + damage * METER_PER_DAMAGE_TAKEN * this.character.stats.focus);
    this.hitstop = Math.max(this.hitstop, hitstop);
    this.flashHit = 10;
    this.lastHurtTick = 0;

    this.vx += -this.facing * knockback;
    if (launch > 0) {
      this.vy = Math.max(this.vy, launch);
      this.y = Math.max(this.y, GROUND_Y + 0.01);
    }

    // A knocked-down fighter is out of the exchange for a while; that is the
    // reward for landing a heavy move and the reason to respect one.
    if (knockdown || this.health <= 0) {
      this.stunFrames = 52;
      this.enter('knockdown');
      this.state = 'knockdown';
      this.stateFrame = 0;
    } else {
      this.stunFrames = hitstun;
      this.enter('hitstun');
      this.state = 'hitstun';
      this.stateFrame = 0;
    }

    this.comboHits = 0;
    this.comboDamage = 0;
  }

  applyBlock(chipDamage: number, blockstun: number, knockback: number, staminaCost: number): void {
    this.health = Math.max(0, this.health - chipDamage);
    this.stamina -= staminaCost;
    this.flashBlock = 8;
    this.vx += -this.facing * knockback * 0.45;

    if (this.stamina <= 0) {
      // Guard break: the defensive option has a limit, so turtling forever is
      // not a strategy.
      this.stamina = this.maxStamina * 0.3;
      this.stunFrames = GUARD_BREAK_STUN_FRAMES;
      this.enter('guardBreak');
      this.state = 'guardBreak';
      this.stateFrame = 0;
    } else {
      this.stunFrames = blockstun;
      this.enter('blockstun');
      this.state = 'blockstun';
      this.stateFrame = 0;
    }
  }

  /** Records a landed hit on the attacker's side, advancing the combo. */
  registerHit(damage: number, tickCount: number): void {
    this.comboHits++;
    this.comboDamage += damage;
    this.framesSinceHit = 0;
    this.lastHitTick = tickCount;
    this.moveHasHit = true;
  }

  /** Damage multiplier for the current combo length. */
  get comboScale(): number {
    return Math.max(MIN_COMBO_SCALE, Math.pow(COMBO_SCALING, this.comboHits));
  }

  spendMeter(amount: number): boolean {
    if (this.meter < amount) return false;
    this.meter -= amount;
    return true;
  }

  gainMeter(amount: number): void {
    this.meter = Math.min(MAX_METER, this.meter + amount * this.character.stats.focus);
  }

  /** Resets everything for a fresh round, keeping the character. */
  resetForRound(startX: number): void {
    this.health = this.maxHealth;
    this.stamina = this.maxStamina;
    // Meter carries between rounds — it is the comeback mechanic, and wiping it
    // punishes the player who just lost a close round twice over.
    this.meter = Math.min(this.meter, MAX_METER * 0.5);

    this.x = startX;
    this.y = GROUND_Y;
    this.vx = 0;
    this.vy = 0;
    this.facing = this.slot === 0 ? 1 : -1;
    this.rig.facing = this.facing;

    this.move = null;
    this.moveFrame = 0;
    this.moveHasHit = false;
    this.hitstop = 0;
    this.iframes = 0;
    this.parryWindow = 0;
    this.comboHits = 0;
    this.comboDamage = 0;
    this.framesSinceHit = 999;
    this.rage = 0;
    this.poseInfluence = 1;

    this.state = 'intro';
    this.stateFrame = 0;
    applyNeutralStance(this.rig, this.x, this.y);
    this.boxes.syncHurtboxes(this.rig);
  }
}
