import { EventBus } from '@/core/events';
import { clamp, damp } from '@/core/math';
import { Rng, hashSeed } from '@/core/rng';
import type { CalibrationProfile } from '@/vision/calibration';
import type { Skeleton } from '@/vision/skeleton';
import type { ActionEvent, MotionState } from '@/vision/motion/types';
import { FighterAnimator } from './animation';
import { AiBrain } from './ai/brain';
import { getDifficulty, DynamicDifficulty, type DifficultyId } from './ai/difficulty';
import { personalityFor } from './ai/personality';
import { getArena, type Arena } from './arenas';
import { CombatResolver, type HitEvent } from './combat';
import { BODY_RADIUS, TICK_SECONDS } from './constants';
import { Fighter, type ControllerKind } from './fighter';
import { Match, type MatchEvents, type RoundOutcome } from './match';
import { retargetToRig, smoothRig } from './poseMapping';
import { FighterRig } from './rig';

/**
 * The simulation container.
 *
 * Owns exactly two fighters, the rules, and the wiring between the camera and
 * the combat system. Everything that draws lives elsewhere and reads this
 * read-only — the world has no idea a screen exists, which is what lets the
 * same world run headless on the server for online matches.
 *
 * The one piece of genuine subtlety is the split between `tick` and
 * `updateVisuals`. The simulation runs at a fixed 60 Hz because frame data
 * demands it. The *pose* runs at whatever the camera and renderer manage,
 * which is neither 60 Hz nor constant. Mixing them would make hitboxes depend
 * on frame rate, which is the one bug a fighting game cannot ship with.
 */

export type GameMode = 'arcade' | 'versus' | 'training' | 'survival' | 'online';

export interface WorldEvents extends MatchEvents {
  hit: HitEvent;
  block: HitEvent;
  parry: HitEvent;
  knockdown: { fighter: Fighter };
  guardBreak: { fighter: Fighter };
  /** A shake request for the camera, in metres. */
  shake: { magnitude: number; duration: number };
  /** Requests a brief slow-motion, `scale` in `(0, 1]`. */
  slowMotion: { scale: number; duration: number };
}

export interface WorldOptions {
  mode: GameMode;
  arenaId: string;
  p1CharacterId: string;
  p2CharacterId: string;
  p1Controller: ControllerKind;
  p2Controller: ControllerKind;
  difficulty?: DifficultyId;
  /** Seed shared by both clients in an online match. */
  seed?: string;
  roundsToWin?: number;
  roundSeconds?: number;
  dynamicDifficulty?: boolean;
  /**
   * `shared` resolves both fighters' hits locally — correct for a single
   * machine. `local` resolves only this client's fighter and expects the
   * opponent's hits to arrive over the network, which is what online play
   * needs so an exchange is not counted twice.
   */
  hitAuthority?: 'shared' | 'local';
}

export class World {
  readonly events = new EventBus<WorldEvents>();
  readonly match: Match;
  readonly combat = new CombatResolver();
  readonly arena: Arena;
  readonly mode: GameMode;

  readonly fighters: [Fighter, Fighter];
  private readonly animators: [FighterAnimator, FighterAnimator];
  private readonly brains: [AiBrain | null, AiBrain | null];

  /** Scratch rig used to build a fresh pose before blending it onto the display rig. */
  private readonly scratchRigs: [FighterRig, FighterRig];

  private readonly dynamicDifficulty: DynamicDifficulty;
  private difficultyId: DifficultyId;

  private readonly rng: Rng;

  /** Simulation ticks elapsed. */
  tickCount = 0;

  /** Frames of global slow motion remaining, and its scale. */
  private slowMotionFrames = 0;
  private slowMotionScale = 1;

  /** Camera focus, in world metres — the renderer follows this. */
  readonly focus = { x: 0, y: 1, zoom: 1 };

  /** Live shake offset, decaying each tick. */
  readonly shake = { x: 0, y: 0, magnitude: 0 };

  /** Set while the match is paused; the simulation is frozen but visuals continue. */
  paused = false;

  /** Who decides whether a hit landed. See `WorldOptions.hitAuthority`. */
  readonly hitAuthority: 'shared' | 'local';

  constructor(options: WorldOptions) {
    this.mode = options.mode;
    this.hitAuthority = options.hitAuthority ?? 'shared';
    this.arena = getArena(options.arenaId);
    this.rng = new Rng(hashSeed(options.seed ?? `${Date.now()}`));

    this.match = new Match({
      roundsToWin: options.roundsToWin,
      roundSeconds: options.roundSeconds,
    });

    this.fighters = [
      new Fighter({
        characterId: options.p1CharacterId,
        slot: 0,
        controller: options.p1Controller,
        startX: -2.6,
      }),
      new Fighter({
        characterId: options.p2CharacterId,
        slot: 1,
        controller: options.p2Controller,
        startX: 2.6,
      }),
    ];

    this.animators = [
      new FighterAnimator(this.rng.snapshot() ^ 0x1234),
      new FighterAnimator(this.rng.snapshot() ^ 0x5678),
    ];

    this.scratchRigs = [new FighterRig(), new FighterRig()];
    for (let i = 0; i < 2; i++) {
      this.scratchRigs[i].proportions = this.fighters[i].rig.proportions;
    }

    this.difficultyId = options.difficulty ?? 'fighter';
    this.dynamicDifficulty = new DynamicDifficulty(options.dynamicDifficulty ?? true);

    const difficulty = getDifficulty(this.difficultyId);
    this.brains = [
      options.p1Controller === 'ai'
        ? new AiBrain({
            difficulty,
            personality: personalityFor(options.p1CharacterId),
            seed: this.rng.snapshot() ^ 0xa1,
          })
        : null,
      options.p2Controller === 'ai'
        ? new AiBrain({
            difficulty,
            personality: personalityFor(options.p2CharacterId),
            seed: this.rng.snapshot() ^ 0xb2,
          })
        : null,
    ];

    this.wireEvents();
  }

  get p1(): Fighter {
    return this.fighters[0];
  }

  get p2(): Fighter {
    return this.fighters[1];
  }

  /** The fighter this client controls with their body, or `null` in a spectate. */
  get localFighter(): Fighter | null {
    return this.fighters.find((fighter) => fighter.controller === 'local') ?? null;
  }

  private wireEvents(): void {
    // Re-emit combat and match events on the world bus so the presentation
    // layer has one place to subscribe.
    this.combat.events.on('hit', (event) => {
      this.onHit(event);
      this.events.emit('hit', event);
    });
    this.combat.events.on('block', (event) => {
      this.addShake(event.severity * 0.06, 8);
      this.events.emit('block', event);
    });
    this.combat.events.on('parry', (event) => {
      this.addShake(0.08, 10);
      this.requestSlowMotion(0.35, 12);
      this.events.emit('parry', event);
    });
    this.combat.events.on('knockdown', (event) => {
      this.addShake(0.18, 18);
      this.events.emit('knockdown', event);
    });
    this.combat.events.on('guardBreak', (event) => {
      this.addShake(0.14, 14);
      this.requestSlowMotion(0.4, 16);
      this.events.emit('guardBreak', event);
    });

    this.match.events.on('roundStart', (event) => this.events.emit('roundStart', event));
    this.match.events.on('fightStart', (event) => this.events.emit('fightStart', event));
    this.match.events.on('timeWarning', (event) => this.events.emit('timeWarning', event));
    this.match.events.on('knockout', (event) => {
      // The signature moment of the genre: everything slows to a crawl as the
      // last hit lands. It costs nothing and it is worth more than any effect.
      this.requestSlowMotion(0.18, 70);
      this.addShake(0.26, 30);
      this.events.emit('knockout', event);
    });
    this.match.events.on('roundEnd', (event) => {
      this.dynamicDifficulty.recordRound(event.p1Health, event.p2Health);
      this.applyDifficulty();
      this.events.emit('roundEnd', event);
    });
    this.match.events.on('matchEnd', (event) => this.events.emit('matchEnd', event));
  }

  private onHit(event: HitEvent): void {
    const move = event.attacker.move;
    this.addShake(move ? move.shake : 0.08, 10 + event.severity * 8);
    this.animators[event.defender.slot].onHit(
      event.severity,
      event.attacker.x < event.defender.x,
    );
    // A big hit gets a beat of slow motion; a jab does not, or the whole fight
    // turns into treacle.
    if (event.severity > 0.72) this.requestSlowMotion(0.45, 8);
  }

  private applyDifficulty(): void {
    const base = getDifficulty(this.difficultyId);
    const adjusted = this.dynamicDifficulty.apply(base);
    for (const brain of this.brains) brain?.setDifficulty(adjusted);
  }

  setDifficulty(id: DifficultyId): void {
    this.difficultyId = id;
    this.dynamicDifficulty.reset();
    this.applyDifficulty();
  }

  start(): void {
    this.match.start(this.p1, this.p2);
    this.tickCount = 0;
  }

  // --- input ---------------------------------------------------------------

  /** Queues a discrete action for a fighter. */
  pushAction(slot: 0 | 1, event: ActionEvent): void {
    this.fighters[slot].input.actions.push(event);
  }

  /** Copies held posture onto a fighter's input. */
  setMotion(slot: 0 | 1, motion: MotionState): void {
    const target = this.fighters[slot].input.motion;
    target.guarding = motion.guarding;
    target.guardHeight = motion.guardHeight;
    target.crouch = motion.crouch;
    target.lean = motion.lean;
    target.airborne = motion.airborne;
    target.airHeight = motion.airHeight;
    target.advance = motion.advance;
    target.stance = motion.stance;
    target.quality = motion.quality;
  }

  // --- simulation ----------------------------------------------------------

  /** One fixed simulation step. */
  tick(): void {
    if (this.paused) return;

    if (this.slowMotionFrames > 0) {
      this.slowMotionFrames--;
      if (this.slowMotionFrames === 0) this.slowMotionScale = 1;
    }

    this.tickCount++;

    const live = this.match.tick(this.p1, this.p2);

    // AI thinks before inputs are consumed so its actions land this same tick.
    for (let i = 0; i < 2; i++) {
      const brain = this.brains[i];
      if (brain && live) brain.think(this.fighters[i], this.fighters[1 - i]);
    }

    for (let i = 0; i < 2; i++) {
      const fighter = this.fighters[i];
      this.consumeInput(fighter, live);
      fighter.tick(this.fighters[1 - i].x, this.tickCount);
    }

    if (live) {
      if (this.hitAuthority === 'shared') {
        this.combat.resolve(this.p1, this.p2, this.tickCount);
      } else {
        // Only our own fighter's strikes are evaluated here; theirs arrive as
        // messages the network layer applies directly.
        const local = this.localFighter;
        if (local) this.combat.resolveOneWay(local, this.fighters[1 - local.slot], this.tickCount);
      }
    }
    this.combat.separate(this.p1, this.p2, BODY_RADIUS * 2);

    this.updateCamera();
    this.updateShake();
  }

  private consumeInput(fighter: Fighter, live: boolean): void {
    const input = fighter.input;

    // Held posture applies even before the bell, so a player can set their
    // stance during the intro.
    fighter.guarding = input.motion.guarding && !fighter.isStunned;
    fighter.guardHeight = input.motion.guardHeight;
    fighter.crouching = input.motion.crouch > 0.45;

    if (!live) {
      input.actions.length = 0;
      return;
    }

    for (const event of input.actions) {
      switch (event.kind) {
        case 'punch':
        case 'kick':
          fighter.startMove(event.technique, event.power * event.confidence);
          break;
        case 'jump':
          fighter.jump(event.power);
          break;
        case 'dodge':
          if (event.side !== 'none') fighter.dodge(event.side, event.power);
          break;
        case 'parry':
          fighter.parry();
          break;
        case 'crouch':
        case 'block':
          // Held states, already applied above.
          break;
      }
    }
    input.actions.length = 0;
  }

  private updateCamera(): void {
    const midX = (this.p1.x + this.p2.x) / 2;
    const gap = Math.abs(this.p1.x - this.p2.x);
    const highest = Math.max(this.p1.y, this.p2.y);

    // Frame both fighters: pull back as they separate, rise as they jump.
    const wantedZoom = clamp(1.25 - gap * 0.055, 0.72, 1.18);
    const wantedY = 1 + highest * 0.35;

    this.focus.x = damp(this.focus.x, midX, 0.16, TICK_SECONDS);
    this.focus.y = damp(this.focus.y, wantedY, 0.2, TICK_SECONDS);
    this.focus.zoom = damp(this.focus.zoom, wantedZoom, 0.3, TICK_SECONDS);
  }

  private shakeFrames = 0;

  private updateShake(): void {
    if (this.shakeFrames > 0) {
      this.shakeFrames--;
      const decay = this.shakeFrames / 30;
      const magnitude = this.shake.magnitude * decay * decay;
      // Alternating sign each frame gives a sharp rattle rather than a wobble.
      const sign = this.tickCount % 2 === 0 ? 1 : -1;
      this.shake.x = this.rng.spread(magnitude) * sign;
      this.shake.y = this.rng.spread(magnitude * 0.6) * sign;
    } else {
      this.shake.x = 0;
      this.shake.y = 0;
      this.shake.magnitude = 0;
    }
  }

  addShake(magnitude: number, frames: number): void {
    // Take the stronger of the two rather than summing, so a flurry of small
    // hits cannot shake the camera into unreadability.
    this.shake.magnitude = Math.max(this.shake.magnitude, magnitude);
    this.shakeFrames = Math.max(this.shakeFrames, Math.round(frames));
    this.events.emit('shake', { magnitude, duration: frames });
  }

  requestSlowMotion(scale: number, frames: number): void {
    this.slowMotionScale = Math.min(this.slowMotionScale, scale);
    this.slowMotionFrames = Math.max(this.slowMotionFrames, frames);
    this.events.emit('slowMotion', { scale, duration: frames });
  }

  /** The time scale the loop should run at, accounting for dramatic slow-down. */
  get timeScale(): number {
    return this.slowMotionFrames > 0 ? this.slowMotionScale : 1;
  }

  // --- presentation --------------------------------------------------------

  /**
   * Updates the fighters' rigs for rendering.
   *
   * Called once per rendered frame, not per simulation tick — the pose is
   * purely visual and should be as smooth as the display allows.
   */
  updateVisuals(
    dt: number,
    skeleton: Skeleton | null,
    motion: MotionState | null,
    calibration: CalibrationProfile | null,
  ): void {
    for (let i = 0; i < 2; i++) {
      const fighter = this.fighters[i];
      const rig = fighter.rig;

      // A remote fighter's rig is written by the network layer from received
      // snapshots before this runs; animating it here would fight that.
      if (fighter.controller === 'remote') {
        fighter.boxes.syncHurtboxes(rig);
        continue;
      }

      const driveFromCamera =
        fighter.controller === 'local' &&
        skeleton !== null &&
        motion !== null &&
        calibration !== null &&
        skeleton.present &&
        fighter.poseInfluence > 0.05;

      if (driveFromCamera) {
        const scratch = this.scratchRigs[i];
        scratch.proportions = rig.proportions;
        scratch.facing = fighter.facing;
        scratch.hipHeight = rig.hipHeight;

        retargetToRig(scratch, skeleton, motion, calibration, fighter.x, fighter.y, {
          influence: fighter.poseInfluence,
        });

        // The scratch rig is a fresh pose every frame; blending it onto the
        // displayed rig is what turns 30 Hz tracking into 60 Hz motion.
        smoothRig(rig, scratch, dt, fighter.state === 'attacking' ? 0.018 : 0.04);
      } else {
        // No camera behind this fighter: the animator poses it instead. Local
        // fighters fall through to here while stunned, which is exactly right —
        // a player being knocked down should not be driving their own body.
        this.animators[i].update(fighter, rig, dt);
      }

      fighter.boxes.syncHurtboxes(rig);
    }
  }

  /** Winner of the match, once it has one. */
  get winner(): RoundOutcome | null {
    return this.match.matchWinner;
  }

  dispose(): void {
    this.events.clear();
    this.combat.events.clear();
    this.match.events.clear();
  }
}
