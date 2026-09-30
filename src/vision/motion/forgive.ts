import type { Mistake, MistakeCode } from './coach';
import type { ActionEvent } from './types';

/**
 * Режим прощения: пять одинаковых ошибок — и игра перестаёт спорить.
 *
 * Подсказки режима «ошибка» полезны ровно до тех пор, пока человек может по
 * ним что-то исправить. Если он пятый раз подряд слышит «удар слишком
 * плавный», а бьёт уже изо всех сил, то проблема не в нём: камера стоит не
 * так, свет не тот, рукав съедает кисть, модель ошибается на этом человеке.
 * Шестая такая же подсказка ничего не исправит — она только злит.
 *
 * Поэтому каждая ошибка, у которой понятно намерение (удар какой рукой, кик
 * какой ногой, прыжок, уклон), считается. На пятом повторе одной и той же
 * ошибки игра исполняет то, что человек пытался сделать, и дальше в этом бою
 * продолжает исполнять такие попытки сразу, без подсказки.
 *
 * Две оговорки, без которых это превратилось бы в «засчитывается всё подряд»:
 *
 *   **Считаются попытки, а не шевеления.** Попытка должна дойти хотя бы до
 *   заметной доли порога (`MIN_PROGRESS`). Почесать нос — это не «слишком
 *   плавный удар», и прощать тут нечего.
 *
 *   **Одна попытка — один счёт.** Детекторы сообщают об ошибке по одному разу
 *   на попытку, но на всякий случай записи одной и той же ошибки той же
 *   конечностью ближе `ATTEMPT_GAP_MS` друг к другу склеиваются.
 */

/** Сколько раз ошибка должна повториться, чтобы игра её простила. */
export const FORGIVE_AFTER = 5;

/** Записи ближе этого — одна и та же попытка. */
const ATTEMPT_GAP_MS = 350;

/**
 * Насколько близко к порогу должна подойти попытка, чтобы считаться.
 *
 * Уклон — отдельно и строже: «качнулся чуть-чуть» случается при каждом ударе,
 * и прощённый уклон дёргал бы бойца в сторону от любого движения корпусом.
 */
const MIN_PROGRESS: Partial<Record<MistakeCode, number>> = {
  dodgeTooSmall: 0.6,
  punchTooSlow: 0.4,
  // Возврат руки к лицу иногда на кадр открывает фазу выброса с крошечным
  // путём. Это не удар, и прощать его значило бы бить на каждом возврате.
  punchTooShort: 0.4,
};
const DEFAULT_MIN_PROGRESS = 0.3;

export class Forgiveness {
  private readonly counts = new Map<MistakeCode, number>();
  private readonly lastAt = new Map<string, number>();

  /** Ошибки, которые уже прощены. Читается детекторами через контекст. */
  readonly forgiven = new Set<MistakeCode>();

  /** Какую ошибку только что простили — чтобы сказать об этом один раз. */
  justForgiven: MistakeCode | null = null;

  /**
   * Смотрит на ошибку. Если она прощена — возвращает действие, которое надо
   * исполнить вместо подсказки.
   */
  consider(mistake: Mistake): ActionEvent | null {
    const intent = mistake.intent;
    if (!intent) return null;

    const need = MIN_PROGRESS[mistake.code] ?? DEFAULT_MIN_PROGRESS;
    if (mistake.progress < need) return null;

    const key = `${mistake.code}:${mistake.side}`;
    const last = this.lastAt.get(key) ?? -Infinity;
    if (mistake.timestamp - last < ATTEMPT_GAP_MS) return null;
    this.lastAt.set(key, mistake.timestamp);

    const count = (this.counts.get(mistake.code) ?? 0) + 1;
    this.counts.set(mistake.code, count);
    if (count < FORGIVE_AFTER) return null;

    if (!this.forgiven.has(mistake.code)) {
      this.forgiven.add(mistake.code);
      this.justForgiven = mistake.code;
    }

    return {
      ...intent,
      timestamp: mistake.timestamp,
      // Засчитанное по доверию не должно бить как идеальный удар: урон и
      // уверенность держатся в середине, чтобы попадание было, а читерства
      // не было.
      power: Math.min(Math.max(intent.power, 0.5), 0.75),
      confidence: Math.min(intent.confidence, 0.75),
    };
  }

  /** Сколько раз ошибка уже повторилась — для отладочного экрана. */
  countOf(code: MistakeCode): number {
    return this.counts.get(code) ?? 0;
  }

  reset(): void {
    this.counts.clear();
    this.lastAt.clear();
    this.forgiven.clear();
    this.justForgiven = null;
  }
}
