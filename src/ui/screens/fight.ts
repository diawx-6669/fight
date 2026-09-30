import { clamp } from '@/core/math';
import { QUALITY_PRESETS } from '@/core/device';
import type { Settings } from '@/settings';
import { ARENAS } from '@/game/arenas';
import { CHARACTERS } from '@/game/characters';
import { MOVES } from '@/game/moves';
import { DIFFICULTIES } from '@/game/ai/difficulty';
import { levelFromXp, levelUpBonus, rewardFor, type Reward } from '@/game/economy';
import { withRecord } from '@/game/records';
import { World, type GameMode } from '@/game/world';
import type { NetClient } from '@/net/client';
import { buildSnapshot, RemoteFighterSync } from '@/net/sync';
import type { ActionEvent, Technique } from '@/vision/motion/types';
import type { MistakeCode } from '@/vision/motion/coach';
import { FORGIVE_AFTER } from '@/vision/motion/forgive';
import { FightScene } from '@/render/scene';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '@/render/renderer';
import { alpha, font, mix, Palette, Semantic, TypeScale } from '@/render/theme';
import { Screen, type ScreenContext, type ScreenParams } from '../screen';
import { chamferedRect } from '../widgets';

/**
 * The fight.
 *
 * This screen owns the loop that makes the whole idea work:
 *
 *   camera frame → pose → detectors → actions → simulation → rig → pixels
 *
 * with two clocks running through it. The simulation advances in fixed 60 Hz
 * ticks because frame data demands determinism; the pose and the renderer run
 * as fast as the machine allows. `accumulator` below is the join between them,
 * and it is the single most important twelve lines in the project — get it
 * wrong and hitboxes start depending on frame rate.
 *
 * Camera input arrives asynchronously, from an event. Actions are queued and
 * consumed by the next tick rather than applied immediately, so a punch
 * detected between two ticks lands on a tick boundary like every other input.
 */

/** Короткие имена ошибок для панели тренировки — полные подсказки длиннее. */
const MISTAKE_SHORT: Partial<Record<MistakeCode, string>> = {
  outOfFrame: 'не видно тебя',
  lowLight: 'мало света',
  armHidden: 'не видно руку',
  legsHidden: 'не видно ног',
  punchTooSlow: 'удар плавный',
  punchTooShort: 'не дотянулся',
  punchNotExtended: 'рука согнута',
  punchTooSoon: 'слишком часто',
  kickTooLow: 'нога низко',
  kickTooSlow: 'кик медленный',
  jumpTooLow: 'прыжок низкий',
  crouchTooShallow: 'присед мелкий',
  dodgeTooSmall: 'уклон слабый',
};

export class FightScreen extends Screen {
  readonly id = 'fight' as const;
  readonly visionMode = 'pose' as const;
  readonly allowBack = false;

  private world: World | null = null;
  private scene: FightScene | null = null;
  private unsubscribe: (() => void)[] = [];

  /** Leftover simulation time, in seconds. */
  private accumulator = 0;
  private readonly stepSeconds = 1 / 60;

  /** Actions detected since the last tick. */
  private readonly queued: ActionEvent[] = [];

  private mode: GameMode = 'versus';
  private stage = 0;
  private finished = false;

  /** Урон и лучшее комбо за этот бой — из них считается награда. */
  private damageDealt = 0;
  private bestCombo = 0;
  /** Сколько уровней взято этим боем и сколько монет это принесло. */
  private levelsGained = 0;
  private levelBonus = 0;

  /** Когда показали сообщение о подстройке и на сколько она подняла шансы. */
  private assistShownAt = 0;
  private assistPercent = 0;
  private forgiveShownAt = 0;
  private forgiveLabel = '';

  /** Survival only: how many opponents have already been beaten. */
  private streak = 0;

  /** Online only. `null` for every local mode. */
  private net: NetClient | null = null;
  private readonly remoteSync = new RemoteFighterSync();
  /** Which fighter slot this client drives. Always 0 offline. */
  private localSlot: 0 | 1 = 0;
  private get remoteSlot(): 0 | 1 {
    return this.localSlot === 0 ? 1 : 0;
  }

  /** Keyboard fallback, for testing and for players who cannot use the camera. */
  private readonly keys = new Set<string>();
  private keyHandlersBound = false;

  /** Countdown ticks already played, so each number sounds once. */
  private lastCountdown = -1;

  constructor(context: ScreenContext) {
    super(context);
  }

  enter(params?: ScreenParams): void {
    super.enter();
    this.finished = false;
    this.accumulator = 0;
    this.queued.length = 0;
    this.lastCountdown = -1;

    const { context } = this;
    this.mode = (params?.mode as GameMode) ?? 'versus';
    this.stage = (params?.stage as number) ?? 0;
    this.streak = (params?.streak as number) ?? 0;

    const settings = context.settings;

    this.net = (params?.net as NetClient) ?? null;
    this.localSlot = this.net ? ((params?.slot as 0 | 1) ?? 0) : 0;
    this.remoteSync.reset();

    const playerCharacter = (params?.playerCharacter as string) ?? 'kai';
    const opponentCharacter = (params?.opponentCharacter as string) ?? 'rei';
    // In an online match the server decides who is on the left, so the
    // character in slot 0 is not necessarily this player's.
    const slot0Character = this.localSlot === 0 ? playerCharacter : opponentCharacter;
    const slot1Character = this.localSlot === 0 ? opponentCharacter : playerCharacter;
    const remoteController = this.net ? 'remote' : 'ai';

    this.world = new World({
      mode: this.mode,
      arenaId: (params?.arenaId as string) ?? 'dusk-temple',
      p1CharacterId: slot0Character,
      p2CharacterId: slot1Character,
      p1Controller: this.localSlot === 0 ? 'local' : remoteController,
      p2Controller: this.localSlot === 0 ? remoteController : 'local',
      hitAuthority: this.net ? 'local' : 'shared',
      shakeScale: settings.screenShake,
      slowMotion: settings.slowMotion,
      // The training dummy defends but never throws anything back.
      opponentPassive: this.mode === 'training',
      difficulty: settings.difficulty,
      // Training has no clock and no rounds to lose.
      roundsToWin: this.mode === 'training' ? 99 : settings.roundsToWin,
      roundSeconds: this.mode === 'training' ? 0 : settings.roundSeconds,
      dynamicDifficulty: settings.dynamicDifficulty,
    });

    this.scene = new FightScene({
      renderer: context.renderer,
      quality: QUALITY_PRESETS[settings.quality],
    });
    this.scene.allowFlashes = settings.flashes;
    this.scene.allowDamageNumbers = settings.damageNumbers;
    this.scene.attach(this.world);

    this.wireWorldEvents();
    this.wireNetEvents();
    this.bindKeys();

    void context.vision.startCamera(settings.cameraDeviceId || undefined);
    context.vision.setSensitivity(settings.sensitivity);
    context.vision.setPoseRate(QUALITY_PRESETS[settings.quality].visionHz);

    this.unsubscribe.push(
      context.vision.events.on('action', (event) => this.queued.push(event)),
    );

    const arena = this.world.arena;
    context.audio.startMusic(arena.musicalRoot, arena.musicalMode);
    this.world.start();

    // Survival carries damage between fights — that is the whole mode. Health
    // is restored partially rather than fully, so a long streak gets genuinely
    // dangerous instead of just long.
    const carried = params?.carryHealth as number | undefined;
    if (this.mode === 'survival' && typeof carried === 'number') {
      const local = this.world.fighters[this.localSlot];
      local.health = Math.round(local.maxHealth * clamp(carried + 0.3, 0.2, 1));
    }
  }

  private wireWorldEvents(): void {
    const world = this.world;
    const { audio, context } = { audio: this.context.audio, context: this.context };
    if (!world) return;

    this.unsubscribe.push(
      world.events.on('hit', (event) => {
        const move = MOVES[event.moveId as Technique];
        const limb = move && move.limb.endsWith('Foot') ? 'foot' : 'hand';
        audio.playImpact(limb, event.severity, false);

        // Progression is recorded as it happens, so a player who closes the
        // tab mid-match still keeps what they earned.
        if (event.attacker.controller === 'local') {
          // Счётчики этого боя — из них считается награда в конце. Держим
          // отдельно от общей статистики: та копится за всё время, эта
          // обнуляется каждым боем.
          this.damageDealt += event.damage;
          this.bestCombo = Math.max(this.bestCombo, event.comboHits);

          const progress = context.progress;
          context.saveProgress({
            ...progress,
            totalHits: progress.totalHits + 1,
            totalDamage: progress.totalDamage + event.damage,
            bestCombo: Math.max(progress.bestCombo, event.comboHits),
          });
        }
      }),
      world.events.on('hit', (event) => {
        if (this.net && event.attacker.slot === this.localSlot) {
          this.net.sendHit({
            mv: event.moveId,
            dmg: event.damage,
            x: event.x,
            y: event.y,
            zn: event.zone,
            sv: event.severity,
            blk: false,
            cmb: event.comboHits,
          });
        }
      }),
      world.events.on('block', (event) => {
        audio.playImpact('hand', event.severity, true);
        if (this.net && event.attacker.slot === this.localSlot) {
          this.net.sendHit({
            mv: event.moveId,
            dmg: event.damage,
            x: event.x,
            y: event.y,
            zn: event.zone,
            sv: event.severity,
            blk: true,
            cmb: 0,
          });
        }
      }),
      world.events.on('parry', () => audio.play('parry', 1)),
      world.events.on('knockdown', () => audio.play('knockdown', 1)),
      world.events.on('guardBreak', () => audio.play('guardBreak', 1)),
      world.events.on('roundStart', () => audio.play('roundStart')),
      world.events.on('knockout', () => audio.play('ko', 1)),
      world.events.on('matchEnd', ({ winner }) => this.onMatchEnd(winner)),
    );
  }

  /**
   * Hooks the socket up to the simulation.
   *
   * Incoming hits are applied straight to the local fighter rather than being
   * re-derived from the opponent's pose. The opponent's client already decided
   * the hit landed; second-guessing it here is how two machines end up
   * disagreeing about who won.
   */
  private wireNetEvents(): void {
    const net = this.net;
    const world = this.world;
    if (!net || !world) return;

    const local = world.fighters[this.localSlot];

    this.unsubscribe.push(
      net.events.on('snapshot', (snapshot) => this.remoteSync.push(snapshot)),

      net.events.on('hit', (hit) => {
        const move = MOVES[hit.mv as Technique];
        if (!move) return;

        if (hit.blk) {
          local.applyBlock(hit.dmg, move.blockstun, move.knockback, move.staminaCost * 0.9);
          this.context.audio.playImpact('hand', hit.sv, true);
        } else {
          local.applyHit(
            hit.dmg,
            move.hitstun,
            move.knockback,
            move.launch,
            move.knockdown,
            move.hitstop,
          );
          const limb = move.limb.endsWith('Foot') ? 'foot' : 'hand';
          this.context.audio.playImpact(limb, hit.sv, false);
        }

        // Effects are driven from the message so the receiving player sees the
        // same impact their opponent did, in the same place.
        this.scene?.effects.ring(hit.x, hit.y, hit.sv, Palette.ember);
        this.scene?.particles.impact(hit.x, hit.y, hit.sv, Palette.gold, 0);
        world.addShake(hit.sv * 0.14, 10);
      }),

      net.events.on('opponentLeft', () => {
        // A disconnect is a forfeit rather than a hang: the player gets a
        // result screen instead of waiting for an opponent who is gone.
        world.match.forfeit(this.remoteSlot as 0 | 1);
      }),

      net.events.on('error', ({ message }) => {
        this.context.push('error', {
          title: 'Соединение потеряно',
          hint: message,
        });
      }),
    );
  }

  exit(): void {
    this.net?.disconnect();
    this.net?.dispose();
    this.net = null;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.scene?.detach();
    this.world?.dispose();
    this.world = null;
    this.scene = null;
    this.unbindKeys();
    this.context.audio.stopMusic();
  }

  suspend(): void {
    if (this.world) this.world.paused = true;
  }

  resume(): void {
    if (this.world) this.world.paused = false;
    this.accumulator = 0;
  }

  // --- loop -----------------------------------------------------------------

  update(dt: number): void {
    super.update(dt);

    const world = this.world;
    const scene = this.scene;
    if (!world || !scene) return;

    const { vision, settings } = this.context;

    // 1. Feed the simulation the player's held posture every frame. It is a
    //    continuous signal, so there is nothing to queue.
    world.setMotion(this.localSlot, vision.motion);
    if (settings.keyboardFallback) this.applyKeyboard(world);

    // 2. Hand over any actions detected since the last tick.
    for (const action of this.queued) world.pushAction(this.localSlot, action);
    this.queued.length = 0;

    // 3. Advance the simulation in fixed steps. `timeScale` carries the
    //    dramatic slow-motion, so hit-stop slows the *simulation*, not the
    //    frame rate — the difference between cinematic and broken.
    this.accumulator += clamp(dt, 0, 0.25) * world.timeScale;
    let steps = 0;
    while (this.accumulator >= this.stepSeconds && steps < 5) {
      this.accumulator -= this.stepSeconds;
      world.tick();
      steps++;
    }
    // Hopelessly behind: drop the backlog rather than spiral.
    if (steps >= 5) this.accumulator = 0;

    // 4. Online: interpolate the opponent from received snapshots, and send
    //    our own. Both happen before the visual update so the remote rig is
    //    already in place when hurtboxes are rebuilt.
    if (this.net) {
      this.remoteSync.update(world.fighters[this.remoteSlot], dt);
      if (this.net.update(dt)) {
        this.net.sendSnapshot(buildSnapshot(world.fighters[this.localSlot], world.tickCount));
      }
    }

    // 5. Pose the fighters for display at the real frame rate.
    world.updateVisuals(dt, vision.skeleton, vision.motion, vision.calibration);

    scene.update(dt);
    this.updateMusicIntensity(world);
    this.updateCountdownAudio(world);

    if (this.context.vision.gesture.backFired && !this.finished) this.openPause();
  }

  private updateMusicIntensity(world: World): void {
    const lowest = Math.min(world.p1.healthRatio, world.p2.healthRatio);
    const urgency = world.match.rules.roundSeconds > 0
      ? clamp(1 - world.match.timeRemaining / 20, 0, 1)
      : 0;
    this.context.audio.setMusicIntensity(Math.max(1 - lowest, urgency));
  }

  private updateCountdownAudio(world: World): void {
    if (world.match.rules.roundSeconds <= 0) return;
    const seconds = Math.ceil(world.match.timeRemaining);
    if (seconds > 5 || seconds === this.lastCountdown || !world.match.isLive) return;
    this.lastCountdown = seconds;
    this.context.audio.play('countdown');
  }

  // --- keyboard -------------------------------------------------------------

  private bindKeys(): void {
    if (this.keyHandlersBound) return;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.keyHandlersBound = true;
  }

  private unbindKeys(): void {
    if (!this.keyHandlersBound) return;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.keyHandlersBound = false;
    this.keys.clear();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    this.keys.add(event.code);

    if (event.code === 'Escape') {
      this.openPause();
      return;
    }
    if (!this.context.settings.keyboardFallback || !this.world) return;

    // Keyboard moves are queued as synthetic detector output, so they travel
    // the exact same path as a real punch. No special case in the simulation.
    const technique = KEY_MOVES[event.code];
    if (technique) {
      this.queued.push({
        kind: technique.endsWith('Kick') || technique === 'kneeStrike' ? 'kick' : 'punch',
        technique,
        side: MOVES[technique].limb.startsWith('left') ? 'left' : 'right',
        height: MOVES[technique].height,
        power: 0.85,
        angle: 0,
        confidence: 1,
        timestamp: performance.now(),
      });
    } else if (event.code === 'Space') {
      this.queued.push({
        kind: 'jump',
        technique: 'none',
        side: 'none',
        height: 'mid',
        power: 1,
        angle: 0,
        confidence: 1,
        timestamp: performance.now(),
      });
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  /** Overlays keyboard posture onto the camera's, when any key is held. */
  private applyKeyboard(world: World): void {
    const motion = world.fighters[this.localSlot].input.motion;
    const left = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const right = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    const down = this.keys.has('KeyS') || this.keys.has('ArrowDown');
    const guard = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    // Стрелки — экранные: «вправо» двигает бойца вправо, с какой бы стороны
    // от противника он ни стоял.
    if (left || right) {
      motion.stepX = right ? 1 : -1;
      motion.advance = 0;
    }
    if (down) motion.crouch = 1;
    if (guard) {
      motion.guarding = true;
      motion.guardHeight = down ? 0.2 : 0.7;
    }
  }

  // --- flow -----------------------------------------------------------------

  private openPause(): void {
    if (this.finished) return;
    this.context.audio.play('back');
    this.context.push('pause', { mode: this.mode });
  }

  private onMatchEnd(winner: 'p1' | 'p2' | 'draw' | 'timeout'): void {
    if (this.finished) return;
    this.finished = true;

    const playerWon = winner === (this.localSlot === 0 ? 'p1' : 'p2');
    this.context.audio.play(playerWon ? 'victory' : 'defeat');
    let reward: Reward | null = null;

    const progress = this.context.progress;
    const next = { ...progress };
    if (this.mode !== 'training') {
      if (playerWon) {
        next.wins = progress.wins + 1;
        if (this.mode === 'arcade') next.arcadeStage = Math.max(progress.arcadeStage, this.stage + 1);
        if (this.mode === 'survival') {
          next.survivalBest = Math.max(progress.survivalBest, this.streak + 1);
        }
      } else {
        next.losses = progress.losses + 1;
      }
      const perfectRounds = this.world?.match.results.filter((r) => r.perfect).length ?? 0;
      next.perfects = progress.perfects + perfectRounds;

      // Деньги и опыт считаются здесь, а не на экране итогов: выживание до
      // него не доходит вовсе, а платить за пройденный бой надо всё равно.
      reward = rewardFor({
        won: playerWon,
        rounds: this.world?.match.results ?? [],
        damageDealt: this.damageDealt,
        bestCombo: this.bestCombo,
        perfects: perfectRounds,
        difficulty: DIFFICULTIES[this.context.settings.difficulty]?.rewardScale ?? 1,
        mode: this.mode,
        stage: this.mode === 'survival' ? this.streak : this.stage,
      });

      const before = levelFromXp(progress.xp);
      next.xp = progress.xp + reward.xp;
      const after = levelFromXp(next.xp);

      // Бонус за уровень начисляется за каждый пройденный, а не за последний:
      // один бой может закрыть сразу два, и пропустить один из них было бы
      // тихой потерей.
      let bonus = 0;
      for (let level = before.level; level < after.level; level++) bonus += levelUpBonus(level);

      next.coins = progress.coins + reward.coins + bonus;
      next.records = withRecord(progress.records, {
        mode: this.mode,
        score: this.recordScore(playerWon),
        character: this.world?.fighters[this.localSlot].character.id ?? 'kai',
        at: Date.now(),
      });

      this.levelsGained = after.level - before.level;
      this.levelBonus = bonus;
      this.context.saveProgress(next);
    }

    // Survival does not stop for a results screen between opponents: winning
    // simply brings the next one out, with whatever health is left.
    if (this.mode === 'survival' && playerWon && this.world) {
      const local = this.world.fighters[this.localSlot];
      const carryHealth = local.healthRatio;
      const playerCharacter = local.character.id;
      const beaten = this.world.fighters[this.remoteSlot].character.id;
      const nextOpponentId = pickSurvivalOpponent(playerCharacter, beaten);
      const arenaId = pickSurvivalArena(this.streak + 1);

      window.setTimeout(() => {
        this.context.replace('fight', {
          mode: 'survival',
          playerCharacter,
          opponentCharacter: nextOpponentId,
          arenaId,
          streak: this.streak + 1,
          carryHealth,
        });
      }, 2200);
      return;
    }

    // Let the knockout play out before cutting to the results.
    window.setTimeout(() => {
      this.context.replace('results', {
        mode: this.mode,
        winner,
        stage: this.mode === 'survival' ? this.streak : this.stage,
        playerCharacter: this.world?.fighters[this.localSlot].character.id,
        opponentCharacter: this.world?.fighters[this.remoteSlot].character.id,
        rounds: this.world?.match.results ?? [],
        reward,
        levelsGained: this.levelsGained,
        levelBonus: this.levelBonus,
      });
    }, 2400);
  }

  /**
   * Чем меряется рекорд в этом режиме.
   *
   * У режимов нет общей единицы: в аркаде важна ступень, в выживании — длина
   * серии, в бою против человека — комбо. Складывать их в одну колонку было
   * бы враньём, поэтому таблица хранит число вместе с режимом и показывает их
   * раздельно.
   */
  private recordScore(won: boolean): number {
    if (this.mode === 'arcade') return won ? this.stage + 1 : this.stage;
    if (this.mode === 'survival') return this.streak + (won ? 1 : 0);
    return this.bestCombo;
  }

  override onSettingsChanged(settings: Settings): void {
    this.scene?.setQuality(QUALITY_PRESETS[settings.quality]);
    if (this.scene) {
      this.scene.allowFlashes = settings.flashes;
      this.scene.allowDamageNumbers = settings.damageNumbers;
    }
    this.context.vision.setPoseRate(QUALITY_PRESETS[settings.quality].visionHz);
  }

  // --- drawing --------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D): void {
    const scene = this.scene;
    const world = this.world;
    if (!scene || !world) return;

    const blank = scene.draw();
    scene.drawPost();
    scene.drawHud(this.mode !== 'training');
    if (blank) this.drawBlankSceneNotice(ctx, blank);

    if (this.mode === 'survival') this.drawSurvivalStreak(ctx);

    // Подсказка вместо предупреждения, а не вместе с ним. Когда человека не
    // видно, режим «ошибка» говорит то же самое, только конкретнее, и две
    // панели об одном налезали друг на друга внизу экрана.
    this.drawAssistNotice(ctx);
    this.drawForgiveNotice(ctx);
    const coached = this.drawCoachHint(ctx);
    if (!coached && !this.context.vision.status.present) this.drawTrackingWarning(ctx);
    if (this.mode === 'training') this.drawTrainingOverlay(ctx);
    if (this.context.settings.debugOverlay) this.drawDebug(ctx);
  }

  /**
   * Shown when the scene painted nothing.
   *
   * A black screen with a working HUD is the least debuggable thing this game
   * can do, and "the game doesn't work" is all a player can reasonably report
   * about it. So the frame says what went wrong and offers the way out, and
   * the game keeps running underneath in case the fault clears on its own —
   * which, now that the camera repairs itself, it usually does.
   */
  private drawBlankSceneNotice(ctx: CanvasRenderingContext2D, reason: string): void {
    const width = 720;
    const height = 180;
    const x = (DESIGN_WIDTH - width) / 2;
    const y = (DESIGN_HEIGHT - height) / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(10, 5, 10, 0.92)';
    chamferedRect(ctx, x, y, width, height, 18);
    ctx.fill();
    ctx.strokeStyle = Palette.gold;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = Palette.gold;
    font(ctx, 30, 'display', 700);
    ctx.fillText('СЦЕНА НЕ НАРИСОВАЛАСЬ', DESIGN_WIDTH / 2, y + 56);

    ctx.fillStyle = Palette.paper;
    font(ctx, 20, 'ui', 500);
    ctx.fillText(reason, DESIGN_WIDTH / 2, y + 100);
    ctx.fillStyle = Palette.ash500;
    font(ctx, 17, 'ui', 400);
    ctx.fillText('Нажми ESC и зайди в бой заново', DESIGN_WIDTH / 2, y + 138);
    ctx.restore();
  }

  /**
   * Сообщение о том, что игра подстроила пороги под игрока.
   *
   * Подстройка нужна: правильного порога, подходящего всем, не существует, и
   * когда человек десять раз почти ударил и ни разу не попал, виноват порог, а
   * не человек. Но молча подкрученная сложность — это обман, даже когда он в
   * пользу игрока: он лишает смысла и попадание, и промах. Поэтому игра
   * говорит вслух, один раз, и не извиняется.
   */
  private drawAssistNotice(ctx: CanvasRenderingContext2D): void {
    const assist = this.context.vision.analyzer.assist;
    if (assist.justChanged) {
      assist.justChanged = false;
      this.assistShownAt = this.elapsed;
      this.assistPercent = assist.percent;
      this.context.audio.play('click');
    }

    const age = this.elapsed - this.assistShownAt;
    if (this.assistShownAt === 0 || age > 3) return;

    const fade = clamp(Math.min(age / 0.2, (3 - age) / 0.4), 0, 1);
    const width = 560;
    const x = (DESIGN_WIDTH - width) / 2;
    const y = 190;

    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = 'rgba(8, 12, 8, 0.9)';
    chamferedRect(ctx, x, y, width, 76, 12);
    ctx.fill();
    ctx.strokeStyle = alpha(Palette.venom, 0.6);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = Palette.venom;
    font(ctx, 24, 'display', 700);
    ctx.fillText('ПОДСТРОИЛ ПОД ТЕБЯ', DESIGN_WIDTH / 2, y + 34);

    ctx.fillStyle = Palette.ash300;
    font(ctx, 16, 'ui', 500);
    ctx.fillText(
      `Удары засчитываются легче на ${this.assistPercent}% — бей как бьёшь`,
      DESIGN_WIDTH / 2,
      y + 60,
    );
    ctx.restore();
  }

  /**
   * Режим прощения: одна и та же ошибка повторилась пять раз, и игра перестала
   * спорить — дальше такие движения засчитываются как задуманные.
   *
   * Об этом говорится вслух по той же причине, что и о подстройке порогов:
   * тихо изменённые правила лишают смысла и попадание, и промах. А ещё
   * человеку важно понять, что подсказка пропала не потому, что он наконец
   * «сделал правильно», а потому, что игра поверила ему на слово.
   */
  private drawForgiveNotice(ctx: CanvasRenderingContext2D): void {
    const forgiveness = this.context.vision.analyzer.forgiveness;
    if (forgiveness.justForgiven) {
      this.forgiveLabel = MISTAKE_SHORT[forgiveness.justForgiven] ?? '';
      forgiveness.justForgiven = null;
      this.forgiveShownAt = this.elapsed;
      this.context.audio.play('click');
    }

    const age = this.elapsed - this.forgiveShownAt;
    if (this.forgiveShownAt === 0 || age > 3.2) return;

    const fade = clamp(Math.min(age / 0.2, (3.2 - age) / 0.4), 0, 1);
    const width = 620;
    const x = (DESIGN_WIDTH - width) / 2;
    // Под сообщением о подстройке, если оба на экране одновременно.
    const y = this.assistShownAt !== 0 && this.elapsed - this.assistShownAt < 3 ? 276 : 190;

    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = 'rgba(8, 12, 8, 0.9)';
    chamferedRect(ctx, x, y, width, 76, 12);
    ctx.fill();
    ctx.strokeStyle = alpha(Palette.venom, 0.6);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.fillStyle = Palette.venom;
    font(ctx, 24, 'display', 700);
    ctx.fillText('ПОНЯЛ ТЕБЯ — ЗАСЧИТЫВАЮ', DESIGN_WIDTH / 2, y + 34);

    ctx.fillStyle = Palette.ash300;
    font(ctx, 16, 'ui', 500);
    ctx.fillText(
      this.forgiveLabel
        ? `«${this.forgiveLabel}» 5 раз подряд — дальше такие движения идут в зачёт`
        : 'Ошибка повторилась 5 раз — дальше такие движения идут в зачёт',
      DESIGN_WIDTH / 2,
      y + 60,
    );
    ctx.restore();
  }

  /**
   * Режим «ошибка»: что именно не засчиталось и что с этим делать.
   *
   * Самая важная панель в игре, хотя выглядит скромнее всех. Без неё
   * непризнанное движение неотличимо от сломанной игры: человек бьёт, ничего
   * не происходит, и единственное доступное ему объяснение — «не работает».
   * Он не может знать, промахнулся ли он на сантиметр или стоит не в том
   * конце комнаты, а значит не может ничего исправить.
   *
   * Поэтому здесь ровно три вещи и ни одной лишней: что не так, что сделать,
   * и насколько близко было. Полоска близости несёт больше всего смысла —
   * «дотянул 85%» и «дотянул 20%» требуют разных поправок, и одно слово
   * «мимо» их не различает.
   *
   * Живёт внизу по центру, под бойцами и над кромкой кадра: достаточно на
   * виду, чтобы прочитать боковым зрением, и достаточно в стороне, чтобы не
   * закрывать то, ради чего человек сюда пришёл.
   */
  private drawCoachHint(ctx: CanvasRenderingContext2D): boolean {
    const hint = this.context.vision.coach;
    if (!hint) return false;

    // Подсказка не выскакивает: за 180 мс она проявляется и так же уходит.
    // Мигающий текст в бою читается как ошибка игры, а не как совет.
    const age = (performance.now() - hint.timestamp) / 1000;
    const fade = clamp(Math.min(age / 0.18, (2.2 - age) / 0.3), 0, 1);
    if (fade <= 0.01) return false;

    const width = 660;
    const height = 118;
    const x = (DESIGN_WIDTH - width) / 2;
    const y = DESIGN_HEIGHT - 232;

    ctx.save();
    ctx.globalAlpha = fade;

    ctx.fillStyle = 'rgba(10, 6, 12, 0.88)';
    chamferedRect(ctx, x, y, width, height, 14);
    ctx.fill();
    ctx.strokeStyle = alpha(Palette.gold, 0.55);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Полоса слева — она же индикатор близости. Цвет от «совсем не то» к
    // «ещё чуть-чуть», чтобы состояние читалось раньше, чем прочитан текст.
    const near = clamp(hint.progress, 0, 1);
    const bar = mix(Palette.rose, Semantic.health, near);
    ctx.fillStyle = bar;
    ctx.fillRect(x, y + height * (1 - near), 4, height * near);
    ctx.fillStyle = alpha(bar, 0.22);
    ctx.fillRect(x, y, 4, height);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = Palette.gold;
    font(ctx, 26, 'display', 700);
    ctx.fillText(hint.title.toUpperCase(), x + 26, y + 44);

    ctx.fillStyle = Palette.paper;
    font(ctx, 18, 'ui', 500);
    ctx.fillText(hint.fix, x + 26, y + 76);

    // Число рядом со словами: без него «почти» и «совсем мимо» выглядят
    // одинаково, а поправка нужна разная.
    ctx.fillStyle = alpha(Palette.ash500, 0.9);
    font(ctx, 15, 'ui', 500);
    ctx.fillText(`получилось на ${Math.round(near * 100)}%`, x + 26, y + 101);

    // Сколько раз уже повторилась эта ошибка: на пятом игра засчитает сама.
    // Видно заранее, чтобы человек понимал — его не игнорируют, счёт идёт.
    const repeats = this.context.vision.analyzer.forgiveness.countOf(hint.code);
    if (repeats > 0 && repeats < FORGIVE_AFTER) {
      ctx.textAlign = 'right';
      ctx.fillStyle = alpha(Palette.venom, 0.85);
      ctx.fillText(
        `повтор ${repeats}/${FORGIVE_AFTER} — на ${FORGIVE_AFTER}-м засчитаю сам`,
        x + width - 22,
        y + 101,
      );
    }

    ctx.restore();
    return true;
  }

  /**
   * The "step back into frame" warning.
   *
   * Non-negotiable in a camera game: if the player walks out of shot, their
   * fighter stops responding and they have no way to know why. This tells them,
   * immediately and unmissably.
   */
  private drawTrackingWarning(ctx: CanvasRenderingContext2D): void {
    const pulse = 0.65 + Math.sin(this.elapsed * 5) * 0.35;

    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const width = 560;
    const height = 92;
    const x = (DESIGN_WIDTH - width) / 2;
    const y = DESIGN_HEIGHT - 240;

    ctx.fillStyle = 'rgba(8, 4, 8, 0.86)';
    chamferedRect(ctx, x, y, width, height, 16);
    ctx.fill();
    ctx.strokeStyle = Palette.rose;
    ctx.lineWidth = 2;
    ctx.stroke();

    // The same distinction calibration makes: the model finding nobody and the
    // model finding a torso without hips are different problems with opposite
    // fixes, and a fighter mid-round has no time to work out which one it is.
    const skeleton = this.context.vision.skeleton;
    const partial = skeleton.hasLandmarks;

    font(ctx, TypeScale.heading, 'display');
    ctx.fillStyle = Palette.rose;
    ctx.fillText(partial ? 'ОТОЙДИ НАЗАД' : 'ВЕРНИСЬ В КАДР', DESIGN_WIDTH / 2, y + 40);

    font(ctx, TypeScale.label, 'ui', 500);
    ctx.fillStyle = Palette.ash300;
    ctx.fillText(
      partial
        ? 'Видно только верх тела — нужны плечи, таз и ноги'
        : 'Камера тебя не видит — встань напротив и добавь света',
      DESIGN_WIDTH / 2,
      y + 68,
    );

    ctx.restore();
  }

  /**
   * Survival streak.
   *
   * The only number that matters in this mode, so it gets its own place on
   * screen rather than being buried in a results screen the player never
   * reaches while they are still winning.
   */
  private drawSurvivalStreak(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const y = 172;
    font(ctx, TypeScale.micro, 'ui', 700);
    ctx.letterSpacing = '0.26em';
    ctx.fillStyle = Palette.ash400;
    ctx.fillText('ПОБЕД ПОДРЯД', DESIGN_WIDTH / 2, y);
    ctx.letterSpacing = '0px';

    font(ctx, 58, 'display');
    ctx.fillStyle = Palette.venom;
    ctx.shadowColor = Palette.venom;
    ctx.shadowBlur = 18;
    ctx.fillText(String(this.streak), DESIGN_WIDTH / 2, y + 42);
    ctx.restore();
  }

  /** Training mode: what the camera saw, and whether it registered. */
  private drawTrainingOverlay(ctx: CanvasRenderingContext2D): void {
    const analyzer = this.context.vision.analyzer;
    const last = analyzer.debug.lastAction;
    const motion = this.context.vision.motion;

    const width = 420;
    const height = 260;
    const x = 64;
    const y = DESIGN_HEIGHT - height - 64;

    ctx.save();
    ctx.fillStyle = 'rgba(6, 7, 14, 0.8)';
    chamferedRect(ctx, x, y, width, height, 16);
    ctx.fill();
    ctx.strokeStyle = alpha(Palette.gold, 0.35);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.label, 'ui', 700);
    ctx.letterSpacing = '0.2em';
    ctx.fillStyle = Palette.gold;
    ctx.fillText('ЧТО ВИДИТ КАМЕРА', x + 24, y + 32);
    ctx.letterSpacing = '0px';

    font(ctx, TypeScale.body, 'ui', 600);
    ctx.fillStyle = Palette.paper;
    if (last) {
      const move = MOVES[last.technique];
      ctx.fillText(
        move && move.damage > 0 ? move.label : last.kind.toUpperCase(),
        x + 24,
        y + 74,
      );
      font(ctx, TypeScale.label, 'ui', 500);
      ctx.fillStyle = Palette.ash300;
      ctx.fillText(
        `сила ${(last.power * 100).toFixed(0)}% · уверенность ${(last.confidence * 100).toFixed(0)}%`,
        x + 24,
        y + 102,
      );
    } else {
      font(ctx, TypeScale.body, 'ui', 500);
      ctx.fillStyle = Palette.ash500;
      ctx.fillText('пока ничего — ударь', x + 24, y + 74);
    }

    // Held state, as a row of indicator pills.
    const states: [string, boolean][] = [
      ['БЛОК', motion.guarding],
      ['ПРИСЕД', motion.crouch > 0.45],
      ['В ВОЗДУХЕ', motion.airborne],
      ['УКЛОН', Math.abs(motion.lean) > 0.35],
    ];

    let pillX = x + 24;
    const pillY = y + 146;
    font(ctx, TypeScale.micro, 'ui', 700);
    for (const [label, active] of states) {
      const textWidth = ctx.measureText(label).width;
      const pillWidth = textWidth + 24;
      ctx.fillStyle = active ? alpha(Palette.venom, 0.22) : 'rgba(255,255,255,0.05)';
      chamferedRect(ctx, pillX, pillY - 13, pillWidth, 26, 6);
      ctx.fill();
      ctx.fillStyle = active ? Palette.venom : Palette.ash500;
      ctx.fillText(label, pillX + 12, pillY);
      pillX += pillWidth + 8;
    }

    font(ctx, TypeScale.micro, 'ui', 500);
    ctx.fillStyle = Palette.ash500;
    ctx.fillText(
      `распознано ${analyzer.debug.actionCount} · отброшено ${analyzer.debug.suppressedCount}` +
        (analyzer.assist.percent > 0 ? ` · помощь +${analyzer.assist.percent}%` : ''),
      x + 24,
      y + height - 58,
    );

    // Топ причин, по которым движения не засчитывались.
    //
    // «Распознано 0» — это факт без объяснения, и человеку с ним нечего
    // делать. А «не дотянулся ×47» — уже диагноз: порог стоит не там, или
    // стоять надо иначе. Один этот список отличает «игра сломана» от
    // «я делаю не то, и вот что именно».
    const top = [...analyzer.mistakes.tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    if (top.length > 0) {
      ctx.fillStyle = alpha(Palette.gold, 0.85);
      ctx.fillText(
        top.map(([code, count]) => `${MISTAKE_SHORT[code] ?? code} ×${count}`).join(' · '),
        x + 24,
        y + height - 34,
      );
    }

    ctx.restore();
  }

  private drawDebug(ctx: CanvasRenderingContext2D): void {
    const world = this.world;
    const vision = this.context.vision;
    if (!world) return;

    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    font(ctx, TypeScale.micro, 'ui', 600);
    ctx.fillStyle = Palette.ash400;

    const lines = [
      `tick ${world.tickCount}`,
      `vision ${vision.status.hz.toFixed(0)} Гц / ${vision.status.inferenceMs.toFixed(1)} мс`,
      `качество ${(vision.status.quality * 100).toFixed(0)}%`,
      `частицы ${this.scene?.particles.count ?? 0}`,
      `p1 ${world.p1.state} f${world.p1.moveFrame}`,
      `p2 ${world.p2.state} f${world.p2.moveFrame}`,
      `timeScale ${world.timeScale.toFixed(2)}`,
    ];

    let y = 150;
    for (const line of lines) {
      ctx.fillText(line, DESIGN_WIDTH - 24, y);
      y += 18;
    }
    ctx.restore();
  }
}

/** Picks the next survival opponent, avoiding the one just beaten. */
function pickSurvivalOpponent(playerId: string, justBeaten: string): string {
  const pool = CHARACTERS.filter(
    (character) => character.id !== playerId && character.id !== justBeaten,
  );
  if (pool.length === 0) return justBeaten;
  return pool[Math.floor(Math.random() * pool.length)].id;
}

/** Rotates arenas so a long streak does not happen entirely in one place. */
function pickSurvivalArena(streak: number): string {
  return ARENAS[streak % ARENAS.length].id;
}

/** Keyboard fallback bindings. */
const KEY_MOVES: Record<string, keyof typeof MOVES> = {
  KeyJ: 'jab',
  KeyK: 'cross',
  KeyL: 'hook',
  KeyU: 'uppercut',
  KeyI: 'overhead',
  KeyN: 'lowKick',
  KeyM: 'midKick',
  Comma: 'highKick',
  Period: 'pushKick',
  Slash: 'kneeStrike',
};
