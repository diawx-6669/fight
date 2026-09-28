import { EventBus } from '@/core/events';
import { clamp } from '@/core/math';
import {
  CHIP_DAMAGE_RATIO,
  COUNTER_HIT_MULTIPLIER,
  HITSTOP_SUPER,
  METER_PER_DAMAGE_DEALT,
  RAGE_MULTIPLIER,
  WRONG_GUARD_RATIO,
} from './constants';
import { capsuleContactPoint } from './hitbox';
import { guardCovers, moveDuration } from './moves';
import type { Fighter } from './fighter';

/**
 * Hit resolution.
 *
 * All of the game's "why did that happen?" answers live in one place, in one
 * order, on purpose. Fighting games are read frame by frame by their players,
 * and a resolution order that shifts around — sometimes checking invulnerability
 * first, sometimes checking the guard first — produces outcomes nobody can
 * learn from.
 *
 * The order is: **invulnerable → parried → blocked → hit**, evaluated once per
 * attacker per tick, with trades resolved by move priority.
 */

export type HitResult = 'whiff' | 'invulnerable' | 'parry' | 'block' | 'hit' | 'counter';

export interface HitEvent {
  attacker: Fighter;
  defender: Fighter;
  result: HitResult;
  /** Final damage dealt, after every multiplier. */
  damage: number;
  /** Where the impact happened, in world space. */
  x: number;
  y: number;
  /** Which part of the body was struck. */
  zone: 'head' | 'torso' | 'limb';
  /** Combo count after this hit. */
  comboHits: number;
  /** The move that landed. */
  moveId: string;
  /** Normalised severity, for effects and audio. */
  severity: number;
}

export interface CombatEvents {
  hit: HitEvent;
  block: HitEvent;
  parry: HitEvent;
  whiff: { attacker: Fighter; moveId: string };
  knockdown: { fighter: Fighter };
  guardBreak: { fighter: Fighter };
  comboEnd: { fighter: Fighter; hits: number; damage: number };
}

const contact = { x: 0, y: 0 };

export class CombatResolver {
  readonly events = new EventBus<CombatEvents>();

  /**
   * Runs one tick of combat between two fighters.
   * Both directions are evaluated, so simultaneous attacks can trade.
   */
  resolve(a: Fighter, b: Fighter, tickCount: number): void {
    this.syncBoxes(a);
    this.syncBoxes(b);

    const aHits = this.canConnect(a, b);
    const bHits = this.canConnect(b, a);

    if (aHits && bHits) {
      // A trade. Priority decides, and equal priority means both land — which
      // is rare, dramatic, and exactly what should happen when two people
      // throw the same punch at the same moment.
      const aPriority = a.move?.priority ?? 0;
      const bPriority = b.move?.priority ?? 0;
      if (aPriority > bPriority) {
        this.apply(a, b, tickCount);
      } else if (bPriority > aPriority) {
        this.apply(b, a, tickCount);
      } else {
        this.apply(a, b, tickCount);
        this.apply(b, a, tickCount);
      }
      return;
    }

    if (aHits) this.apply(a, b, tickCount);
    else if (bHits) this.apply(b, a, tickCount);

    this.checkWhiff(a);
    this.checkWhiff(b);
  }

  /**
   * Resolves only `attacker`'s strikes against `defender`.
   *
   * Online matches use this: each client evaluates its own fighter's hits and
   * reports them, while the opponent's hits arrive as messages rather than
   * being recomputed locally. Running the full two-way resolution on both
   * machines would double-count every exchange, because the defender's client
   * would independently decide it had been hit as well.
   */
  resolveOneWay(attacker: Fighter, defender: Fighter, tickCount: number): void {
    this.syncBoxes(attacker);
    this.syncBoxes(defender);
    if (this.canConnect(attacker, defender)) this.apply(attacker, defender, tickCount);
    this.checkWhiff(attacker);
  }

  /** Refreshes hurtboxes, and the strike capsule during active frames. */
  private syncBoxes(fighter: Fighter): void {
    fighter.boxes.syncHurtboxes(fighter.rig);

    const move = fighter.move;
    if (!move || fighter.state !== 'attacking') {
      fighter.boxes.clearStrike();
      return;
    }

    const activeStart = move.startup;
    const activeEnd = move.startup + move.active;
    if (fighter.moveFrame >= activeStart && fighter.moveFrame < activeEnd) {
      fighter.boxes.syncStrike(fighter.rig, move.limb, move.reach, move.hitboxHeight);
    } else {
      fighter.boxes.clearStrike();
    }
  }

  private canConnect(attacker: Fighter, defender: Fighter): boolean {
    if (!attacker.boxes.strikeActive) return false;
    if (attacker.moveHasHit) return false;
    if (attacker.hitstop > 0) return false;
    return defender.boxes.hitBy(attacker.boxes.strike) !== null;
  }

  private apply(attacker: Fighter, defender: Fighter, tickCount: number): void {
    const move = attacker.move;
    if (!move) return;

    const zone = defender.boxes.hitBy(attacker.boxes.strike);
    if (!zone) return;

    capsuleContactPoint(attacker.boxes.strike, defender.boxes.torso, contact);

    // 1. Invulnerability — a committed dodge simply is not there.
    if (defender.iframes > 0) {
      attacker.moveHasHit = true;
      this.events.emit('whiff', { attacker, moveId: move.id });
      return;
    }

    // 2. Parry — beats everything else and hands the defender the initiative.
    if (defender.parryWindow > 0) {
      attacker.moveHasHit = true;
      defender.gainMeter(14);
      // The attacker eats a long recovery: a parried move is a free punish.
      attacker.moveFrame = Math.max(attacker.moveFrame, moveDuration(move) - 6);
      attacker.hitstop = 14;
      defender.hitstop = 8;
      defender.flashParry = 14;
      this.events.emit('parry', {
        attacker,
        defender,
        result: 'parry',
        damage: 0,
        x: contact.x,
        y: contact.y,
        zone,
        comboHits: 0,
        moveId: move.id,
        severity: 0.8,
      });
      return;
    }

    // --- damage calculation -------------------------------------------------

    const stats = attacker.character.stats;
    let damage = move.damage * stats.power;

    // The player's own motion power scales the hit. Throwing a lazy punch and a
    // committed one should not do the same thing — this is the main reason the
    // game rewards actually moving.
    damage *= 0.72 + attacker.lastMovePower * 0.42;

    // Combo scaling, so a long chain does not simply add up to a round.
    damage *= attacker.comboScale;

    // Counter hit: catching someone during their own startup.
    const isCounter =
      defender.state === 'attacking' && defender.move !== null && defender.moveFrame < defender.move.startup;
    if (isCounter) damage *= COUNTER_HIT_MULTIPLIER;

    // Desperation: a fighter on their last legs hits harder.
    damage *= 1 + attacker.rage * (RAGE_MULTIPLIER - 1);

    // Headshots hurt more; clipping a limb hurts less.
    if (zone === 'head') damage *= 1.22;
    else if (zone === 'limb') damage *= 0.78;

    // 3. Block.
    const blocking =
      defender.guarding &&
      !defender.isAirborne &&
      defender.state !== 'guardBreak' &&
      defender.stamina > 0;

    if (blocking) {
      const covered = guardCovers(defender.guardHeight, move.height, defender.crouching);
      // An overhead beats a crouching guard outright — that is its entire job.
      const beaten = move.overhead && defender.crouching;

      if (covered && !beaten) {
        const chip = damage * CHIP_DAMAGE_RATIO;
        attacker.moveHasHit = true;
        attacker.gainMeter(move.meterGain * 0.4);
        attacker.hitstop = Math.max(attacker.hitstop, Math.round(move.hitstop * 0.6));
        defender.hitstop = Math.max(defender.hitstop, Math.round(move.hitstop * 0.6));
        defender.applyBlock(chip, move.blockstun, move.knockback, move.staminaCost * 0.9);

        const event: HitEvent = {
          attacker,
          defender,
          result: 'block',
          damage: chip,
          x: contact.x,
          y: contact.y,
          zone,
          comboHits: 0,
          moveId: move.id,
          severity: clamp(move.damage / 110, 0.2, 1),
        };
        this.events.emit('block', event);
        if (defender.state === 'guardBreak') this.events.emit('guardBreak', { fighter: defender });
        return;
      }

      // Guarding the wrong height still absorbs something — it should feel
      // better than being caught completely flat-footed.
      damage *= WRONG_GUARD_RATIO;
    }

    // 4. Clean hit.
    const finalDamage = Math.round(damage);
    const hitstop = move.knockdown ? HITSTOP_SUPER : move.hitstop;

    attacker.gainMeter(move.meterGain + finalDamage * METER_PER_DAMAGE_DEALT);
    attacker.hitstop = Math.max(attacker.hitstop, hitstop);
    attacker.registerHit(finalDamage, tickCount);

    defender.applyHit(
      finalDamage,
      move.hitstun,
      move.knockback,
      move.launch,
      move.knockdown || (defender.isAirborne && move.launch === 0),
      hitstop,
    );

    const event: HitEvent = {
      attacker,
      defender,
      result: isCounter ? 'counter' : 'hit',
      damage: finalDamage,
      x: contact.x,
      y: contact.y,
      zone,
      comboHits: attacker.comboHits,
      moveId: move.id,
      severity: clamp((finalDamage / 110) * (isCounter ? 1.2 : 1), 0.2, 1),
    };
    this.events.emit('hit', event);

    if (defender.state === 'knockdown') this.events.emit('knockdown', { fighter: defender });
  }

  /** Emits a whiff once a move's active frames pass without connecting. */
  private checkWhiff(fighter: Fighter): void {
    const move = fighter.move;
    if (!move || fighter.state !== 'attacking') return;
    const activeEnd = move.startup + move.active;
    if (fighter.moveFrame !== activeEnd || fighter.moveHasHit) return;

    // Whiffing costs a little extra stamina: wild flailing should tire you out.
    fighter.stamina = Math.max(0, fighter.stamina - move.staminaCost * 0.35);
    this.events.emit('whiff', { attacker: fighter, moveId: move.id });
  }

  /** Pushes overlapping fighters apart so they never occupy the same space. */
  separate(a: Fighter, b: Fighter, minDistance: number): void {
    const delta = b.x - a.x;
    const distance = Math.abs(delta);
    if (distance >= minDistance || distance < 1e-5) return;

    const push = (minDistance - distance) / 2;
    const direction = Math.sign(delta) || 1;
    // A knocked-down or stunned fighter is easier to walk through, which keeps
    // corner pressure from becoming an impassable wall.
    const aWeight = a.isStunned ? 0.7 : 1;
    const bWeight = b.isStunned ? 0.7 : 1;
    const total = aWeight + bWeight;

    a.x -= direction * push * (2 * bWeight) / total;
    b.x += direction * push * (2 * aWeight) / total;
  }
}
