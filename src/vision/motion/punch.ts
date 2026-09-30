import { clamp, remapClamped } from '@/core/math';
import { NumericRing } from '@/core/pool';
import { DEPTH_WEIGHT, Joint } from '../skeleton';
import {
  action,
  type ActionEvent,
  type MotionContext,
  type MotionDetector,
  type MotionState,
  type StrikeHeight,
  type Technique,
} from './types';

/**
 * Punch detection.
 *
 * The naive approach — "fire when the wrist moves fast" — produces a game that
 * punches every time you scratch your nose. What actually distinguishes a
 * punch is a *ballistic extension*: the wrist accelerates away from the
 * shoulder, the elbow straightens, and then it all stops. Three phases.
 *
 * So each arm runs a tiny state machine:
 *
 *   idle ──(radial speed crosses threshold)──▶ extending
 *   extending ──(speed peaks and starts to fall)──▶ fire, then recovering
 *   recovering ──(arm folds back, or timeout)──▶ idle
 *
 * Firing on the *peak* rather than on full extension matters: it puts the hit
 * at the moment the player perceives impact, around 60ms earlier than lockout,
 * and that 60ms is the difference between "instant" and "laggy".
 */

type Phase = 'idle' | 'extending' | 'recovering';

interface ArmTracker {
  readonly side: 'left' | 'right';
  phase: Phase;
  /** Distance from shoulder to wrist, body units. */
  reach: number;
  previousReach: number;
  /** Rate of change of `reach`, body units per second. */
  radialSpeed: number;
  peakSpeed: number;
  /** Where the wrist was when the extension began, for measuring the arc. */
  startX: number;
  startY: number;
  startZ: number;
  startExtension: number;
  /**
   * Пик скорости движения, не дотянувшего до порога. Нужен, чтобы сообщить о
   * «слишком плавном» ударе один раз за попытку, в её конце, а не на каждом
   * кадре, пока рука идёт: режим прощения считает попытки, а не кадры.
   */
  subPeak: number;
  phaseElapsed: number;
  cooldown: number;
  /** Сколько секунд модель подряд не видит эту руку. */
  hiddenFor: number;
  /** Short history of radial speed, to confirm a peak rather than a blip. */
  speedHistory: NumericRing;
}

function createArm(side: 'left' | 'right'): ArmTracker {
  return {
    side,
    phase: 'idle',
    reach: 0,
    previousReach: 0,
    radialSpeed: 0,
    peakSpeed: 0,
    startX: 0,
    startY: 0,
    startZ: 0,
    startExtension: 0,
    subPeak: 0,
    phaseElapsed: 0,
    cooldown: 0,
    hiddenFor: 0,
    speedHistory: new NumericRing(6),
  };
}

/**
 * Radial speed, in body-units per second, that starts an extension.
 *
 * Tuned against a player standing far enough back for their whole body to be
 * in frame — and that qualifier turned out to matter enormously, because a
 * body unit is the player's torso and the torso is *measured differently*
 * depending on framing. With hips in shot it comes from hip to shoulder; with
 * only the upper body visible it is estimated from shoulder width, and comes
 * out nearly twice as large. Every distance is divided by it, so the same
 * physical punch produces roughly half the body-space speed when the player
 * sits close to a laptop.
 *
 * The result was a game that worked in testing and recognised nothing at all
 * for anyone playing at a desk — the most common way this game is played. The
 * constant below is therefore a *reference*, rescaled per player by
 * `launchSpeedFor` against what their own calibration measured.
 */
const LAUNCH_SPEED = 2.6;

/** Reach the reference threshold above was tuned against, in body units. */
const REFERENCE_REACH = 1.55;

/**
 * The launch threshold in this player's units.
 *
 * `reachForward` is the furthest their wrist got from their shoulder during
 * calibration, measured in the same body units the detector sees at play time.
 * Dividing by the reference turns a constant that assumed one framing into one
 * that follows the player: sit closer, and both the measured reach and the
 * threshold shrink together.
 *
 * Clamped because calibration can go wrong — a player who never extended their
 * arm during the reach stage would otherwise end up with a threshold so low
 * that scratching their nose throws a jab.
 */
function launchSpeedFor(reachForward: number): number {
  const ratio = Number.isFinite(reachForward) && reachForward > 0
    ? reachForward / REFERENCE_REACH
    : 1;

  // Вниз — да, вверх — никогда, и это не осторожность, а исправление ошибки.
  //
  // Калибровка просит вытянуть руку *максимально далеко*. В бою человек бьёт
  // нормально, а нормальный удар короче предельного вытягивания. То есть
  // `reachForward` систематически больше того размаха, которым человек
  // действительно бьёт, — и порог, растущий вместе с ним, наказывал именно за
  // честную калибровку: чем добросовестнее человек тянулся на разминке, тем
  // выше игра поднимала ему планку и тем меньше ударов засчитывала.
  //
  // Измерено: один и тот же удар при размахе 1.0 проходит, при 1.55 и выше —
  // ни разу. Поэтому вверх множитель не идёт.
  return LAUNCH_SPEED * clamp(ratio, 0.45, 1);
}

/** Below this the extension is treated as finished. */
const SETTLE_SPEED = 0.7;

/** A strike that has not resolved in this long was not a punch. */
const MAX_EXTENSION_TIME = 0.42;

/** Minimum gap between punches from the same arm, seconds. */
const ARM_COOLDOWN = 0.22;

/**
 * Сколько кисть обязана пройти, долей от калиброванного размаха.
 *
 * Было 0.3 — и это никогда не могло работать. Удар засчитывается на *пике
 * скорости*, а не на полном выпрямлении: так он приходится на момент, когда
 * человек чувствует удар, а не на шестьдесят миллисекунд позже. К пику кисть
 * проходит чуть больше половины пути. Требовать от неё треть предельного
 * размаха — при том что сам предельный размах больше боевого — значит
 * требовать больше, чем удар даёт физически.
 */
const MIN_TRAVEL_RATIO = 0.18;

/** Границы требования к пути, в телесных единицах. */
const MIN_TRAVEL_FLOOR = 0.12;
const MIN_TRAVEL_CEILING = 0.34;

/**
 * How far from the centre line a wrist is "tucked into a guard" and how far it
 * has "left" one, in body units. Between them the guard penalty fades out.
 */
const TUCK_IN = 0.35;
const TUCK_OUT = 0.95;

export class PunchDetector implements MotionDetector {
  readonly name = 'punch';

  private readonly arms: ArmTracker[] = [createArm('left'), createArm('right')];

  /** Populated so the renderer can draw a trail on the arm that is mid-punch. */
  readonly activeArms = { left: 0, right: 0 };

  /** Работает ли вторая рука — чтобы отличить «рука пропала» от «руки опущены». */
  private otherArmActive(side: 'left' | 'right'): boolean {
    const other = this.arms.find((a) => a.side !== side);
    return !!other && (other.phase !== 'idle' || Math.abs(other.radialSpeed) > 0.8);
  }

  update(context: MotionContext, state: MotionState): ActionEvent | null {
    const { skeleton } = context;
    if (!skeleton.present) {
      this.reset();
      return null;
    }

    let fired: ActionEvent | null = null;
    for (const arm of this.arms) {
      const event = this.updateArm(arm, context, state);
      // At most one action leaves the detector per frame. If both arms peak on
      // the same frame the stronger one wins and the other is dropped rather
      // than queued — a simultaneous double punch is not a move in this game.
      if (event && (!fired || event.power > fired.power)) fired = event;
    }
    return fired;
  }

  private updateArm(
    arm: ArmTracker,
    context: MotionContext,
    state: MotionState,
  ): ActionEvent | null {
    const { skeleton, calibration, dt, sensitivity, assist } = context;

    const shoulderId = arm.side === 'left' ? Joint.LeftShoulder : Joint.RightShoulder;
    const wristId = arm.side === 'left' ? Joint.LeftWrist : Joint.RightWrist;
    const elbowId = arm.side === 'left' ? Joint.LeftElbow : Joint.RightElbow;

    const shoulder = skeleton.at(shoulderId);
    const wrist = skeleton.at(wristId);
    const elbow = skeleton.at(elbowId);

    arm.cooldown = Math.max(0, arm.cooldown - dt);

    // An arm the model cannot see reliably must not throw punches — an
    // occluded wrist snapping back into view reads as an enormous velocity.
    const visibility = Math.min(shoulder.visibility, wrist.visibility, elbow.visibility);
    if (visibility < 0.5) {
      // Молчать здесь — худший из вариантов: человек бьёт изо всех сил рукой,
      // которой модель просто не видит, и не получает ни удара, ни объяснения.
      //
      // Но и жаловаться на каждый кадр нельзя: опущенная вдоль тела рука часто
      // не видна, и это никому не мешает. Поэтому говорим о двух вещах —
      // о руке, потерянной прямо посреди удара, и о руке, которой нет уже
      // долго, пока вторая работает. И то и другое человек хочет знать.
      arm.hiddenFor += dt;
      const lostMidPunch = arm.phase === 'extending';
      const lostForLong = arm.hiddenFor > 1 && this.otherArmActive(arm.side);
      if (lostMidPunch) {
        // Рука пропала посреди выброса — удар был, его просто не досмотрели.
        // Намерение понятно, и режим прощения может его исполнить.
        context.mistakes.note(
          'armHidden', arm.side, Math.max(visibility / 0.5, 0.5), context.now,
          punchIntent(arm.side, arm.side === 'left' ? 'jab' : 'cross', 'mid', context.now),
        );
      } else if (lostForLong) {
        context.mistakes.note('armHidden', arm.side, visibility / 0.5, context.now);
      }
      arm.phase = 'idle';
      arm.speedHistory.clear();
      this.activeArms[arm.side] = 0;
      return null;
    }
    arm.hiddenFor = 0;

    arm.previousReach = arm.reach;
    // С глубиной: удар прямо в камеру удлиняет руку не в кадре, а к объективу.
    arm.reach = skeleton.armReach(arm.side);
    arm.radialSpeed = dt > 0 ? (arm.reach - arm.previousReach) / dt : 0;
    arm.speedHistory.push(arm.radialSpeed);

    const extension = skeleton.armExtension(arm.side);
    // Thresholds scale with sensitivity and with how far the player is standing:
    // a distant player produces smaller body-space velocities.
    const launchThreshold =
      (launchSpeedFor(calibration.reachForward) / (sensitivity * assist)) *
      (1 + calibration.noiseFloor * 3);

    switch (arm.phase) {
      case 'idle': {
        if (arm.cooldown > 0) {
          if (arm.radialSpeed > launchThreshold) {
            context.mistakes.note(
              'punchTooSoon', arm.side,
              1 - arm.cooldown / (ARM_COOLDOWN / Math.max(sensitivity, 0.5)), context.now,
              punchIntent(arm.side, arm.side === 'left' ? 'jab' : 'cross', 'mid', context.now),
            );
          }
          break;
        }
        // Guarding is a held pose, not a punch, so the bar goes up while the
        // hands are at the face — otherwise settling into a stance throws
        // jabs. But a flat penalty for guarding is much worse than it looks:
        // hands up at the face *is* the fighting stance this game teaches, so
        // a player standing correctly pays it on every single punch, and pays
        // it silently. That is a plausible shape for "the game doesn't see me".
        //
        // What actually separates the two is where the hand goes. A guard
        // adjustment stays tucked towards the centre line; a punch leaves. So
        // the penalty fades as the hand does: full while tucked in at the
        // face, gone by the time the wrist has committed outward.
        //
        // Expressed as one number rather than an early return, because the
        // near-miss below has to measure against whichever bar is actually in
        // force — otherwise a soft punch from a guard is rejected by one
        // threshold and explained against another.
        const tucked = state.guarding
          ? remapClamped(Math.abs(wrist.x), TUCK_OUT, TUCK_IN, 0, 1)
          : 0;
        const bar = launchThreshold * (1 + tucked * 0.4);

        if (arm.radialSpeed > bar) {
          arm.phase = 'extending';
          arm.phaseElapsed = 0;
          arm.peakSpeed = arm.radialSpeed;
          arm.startX = wrist.x;
          arm.startY = wrist.y;
          arm.startZ = wrist.z;
          arm.startExtension = extension;
          arm.subPeak = 0;
          break;
        }

        // Движение было, но не дотянуло до порога. Это самая частая причина
        // жалобы «игра меня не видит»: человек бьёт плавно, а детектор ждёт
        // баллистического выброса.
        //
        // Нижняя граница отделяет попытку ударить от обычного движения рукой.
        // Треть порога ловит удар вполсилы и всё ещё пропускает мимо ушей
        // почёсывание носа.
        //
        // Сообщаем один раз, когда попытка закончилась — скорость пошла на
        // спад. Раньше запись шла на каждом кадре, пока рука разгонялась, и
        // один удар выглядел как пять неудачных: и подсказка, и счётчик
        // повторов врали.
        if (arm.radialSpeed > bar * 0.3) {
          if (arm.subPeak === 0) {
            arm.startX = wrist.x;
            arm.startY = wrist.y;
          }
          arm.subPeak = Math.max(arm.subPeak, arm.radialSpeed);
        }
        if (arm.subPeak > 0 && (arm.radialSpeed < arm.subPeak * 0.6 || arm.radialSpeed <= bar * 0.3)) {
          const technique = classifyPunch(
            arm.side, wrist.x - arm.startX, wrist.y - arm.startY, extension, wrist.y, shoulder.y,
          );
          context.mistakes.note(
            'punchTooSlow', arm.side, arm.subPeak / bar, context.now,
            punchIntent(arm.side, technique, punchHeight(wrist.y, shoulder.y), context.now),
          );
          arm.subPeak = 0;
        }
        break;
      }

      case 'extending': {
        arm.phaseElapsed += dt;
        arm.peakSpeed = Math.max(arm.peakSpeed, arm.radialSpeed);
        this.activeArms[arm.side] = clamp(arm.radialSpeed / launchThreshold, 0, 1.5);

        const decelerating = arm.radialSpeed < arm.peakSpeed * 0.55;
        const stalled = arm.radialSpeed < SETTLE_SPEED;
        const timedOut = arm.phaseElapsed > MAX_EXTENSION_TIME;

        if (!decelerating && !stalled && !timedOut) break;

        const event = this.resolve(arm, context, wrist.x, wrist.y, wrist.z, extension, shoulder.y);
        arm.phase = 'recovering';
        arm.phaseElapsed = 0;
        arm.cooldown = ARM_COOLDOWN / Math.max(sensitivity, 0.5);
        return event;
      }

      case 'recovering': {
        arm.phaseElapsed += dt;
        this.activeArms[arm.side] *= 0.82;
        // Back to idle once the arm folds again or enough time passes that the
        // player has clearly stopped, whichever comes first.
        if (extension < 0.55 || arm.phaseElapsed > 0.3) {
          arm.phase = 'idle';
          arm.speedHistory.clear();
          this.activeArms[arm.side] = 0;
        }
        break;
      }
    }

    return null;
  }

  private resolve(
    arm: ArmTracker,
    context: MotionContext,
    wristX: number,
    wristY: number,
    wristZ: number,
    extension: number,
    shoulderY: number,
  ): ActionEvent | null {
    const { calibration, sensitivity, assist, now } = context;

    const travelX = wristX - arm.startX;
    const travelY = wristY - arm.startY;
    const travelZ = (wristZ - arm.startZ) * DEPTH_WEIGHT;
    const travel = Math.hypot(travelX, travelY, travelZ);

    // Что человек пытался сделать — на случай отказа ниже. Режим прощения
    // исполнит именно это, если ошибка будет повторяться.
    const intended = punchIntent(
      arm.side,
      classifyPunch(arm.side, travelX, travelY, extension, wristY, shoulderY),
      punchHeight(wristY, shoulderY),
      now,
    );

    // Reject twitches: the hand must actually have gone somewhere.
    // Требование к пути ограничено и сверху, и снизу.
    //
    // Калибровка может записать что угодно — человек мог махать рукой вместо
    // того, чтобы тянуться, мог не дотянуться вовсе. Но путь, который кисть
    // успевает пройти до пика скорости, задаётся не калибровкой, а тем, как
    // устроен сам удар: у всех он выходит в пределах трети телесной единицы.
    // Потолок здесь — защита от калибровки, после которой не проходит ни один
    // удар; пол — от калибровки, после которой проходит любое шевеление.
    const minTravel = clamp(
      calibration.reachForward * MIN_TRAVEL_RATIO,
      MIN_TRAVEL_FLOOR,
      MIN_TRAVEL_CEILING,
    ) / (sensitivity * assist);
    if (travel < minTravel) {
      // Нижняя граница у самой жалобы. Возврат руки к лицу проходит через
      // точку, где расстояние до плеча снова растёт, и это иногда открывает
      // фазу выброса на один кадр — с путём около нуля. Формально это отказ,
      // но человек в этот момент не бил, и подсказка «ты не дотянулся, 0%»
      // была бы неправдой о том, чего он не делал.
      if (travel > minTravel * 0.25) {
        context.mistakes.note('punchTooShort', arm.side, travel / minTravel, now, intended);
      }
      return null;
    }

    // Reject flails: a punch ends straighter than it started.
    const extensionGain = extension - arm.startExtension;
    if (extensionGain < 0.08 && extension < 0.62) {
      // Из двух порогов берём тот, к которому человек ближе: подсказка должна
      // указывать на то, что он почти выполнил, а не на случайный из двух.
      context.mistakes.note(
        'punchNotExtended', arm.side,
        Math.max(extensionGain / 0.08, extension / 0.62), now, intended,
      );
      return null;
    }

    const launch = launchSpeedFor(calibration.reachForward);
    const power = remapClamped(arm.peakSpeed, launch * 0.9, launch * 3.4, 0.35, 1);

    const angle = Math.atan2(travelY, travelX);
    const technique = classifyPunch(arm.side, travelX, travelY, extension, wristY, shoulderY);
    const height = punchHeight(wristY, shoulderY);

    // Confidence blends how clean the extension was with how good the tracking
    // is overall; the combat layer uses it to scale chip damage on marginal hits.
    const cleanliness = clamp(extension * 0.6 + clamp(extensionGain * 2, 0, 1) * 0.4, 0, 1);
    const confidence = clamp(cleanliness * (1 - calibration.noiseFloor * 2), 0.2, 1);

    return action({
      kind: 'punch',
      technique,
      side: arm.side,
      height,
      power,
      angle,
      confidence,
      timestamp: now,
    });
  }

  reset(): void {
    for (const arm of this.arms) {
      arm.phase = 'idle';
      arm.peakSpeed = 0;
      arm.phaseElapsed = 0;
      arm.cooldown = 0;
      arm.subPeak = 0;
      arm.speedHistory.clear();
    }
    this.activeArms.left = 0;
    this.activeArms.right = 0;
  }
}

/**
 * Picks the technique from the shape of the arc.
 *
 * `travelX`/`travelY` are in body units, y-up, x pointing to the player's right.
 * The lead hand throws jabs, the rear hand throws crosses — in a mirrored
 * orthodox stance that maps onto left and right respectively.
 */
function classifyPunch(
  side: 'left' | 'right',
  travelX: number,
  travelY: number,
  extension: number,
  wristY: number,
  shoulderY: number,
): Technique {
  const horizontal = Math.abs(travelX);
  const vertical = travelY;

  // Rising hard from below the shoulder with a bent arm: uppercut.
  if (vertical > horizontal * 1.1 && vertical > 0.28 && wristY < shoulderY + 0.25) {
    return 'uppercut';
  }

  // Coming down from above: overhead.
  if (vertical < -horizontal * 1.2 && vertical < -0.3 && wristY > shoulderY) {
    return 'overhead';
  }

  // Wide lateral arc that never fully straightens: hook.
  if (horizontal > 0.32 && extension < 0.82) {
    return 'hook';
  }

  // Straight punches: the lead hand is faster and lighter.
  return side === 'left' ? 'jab' : 'cross';
}

function punchHeight(wristY: number, shoulderY: number): StrikeHeight {
  if (wristY > shoulderY + 0.18) return 'high';
  if (wristY < shoulderY - 0.55) return 'low';
  return 'mid';
}

/** Удар, который человек, судя по всему, пытался нанести. */
function punchIntent(
  side: 'left' | 'right',
  technique: Technique,
  height: StrikeHeight,
  now: number,
): ActionEvent {
  return action({
    kind: 'punch',
    technique,
    side,
    height,
    power: 0.6,
    angle: 0,
    confidence: 0.6,
    timestamp: now,
  });
}
