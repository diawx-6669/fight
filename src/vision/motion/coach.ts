/**
 * Режим «ошибка»: игра объясняет, что именно пошло не так.
 *
 * Детектор удара отказывает в семи разных местах — рука не видна, замах
 * слишком медленный, кисть не прошла нужного расстояния, локоть не
 * выпрямился, не вышло время, ещё идёт откат, качество картинки упало. До
 * этого модуля каждый из них просто возвращал `null`, и снаружи все семь
 * выглядели одинаково: ничего не произошло. Игрок бьёт, на экране тихо, и
 * единственный доступный ему вывод — «игра сломана».
 *
 * Это хуже, чем кажется. Человек не знает, промахнулся он на сантиметр или
 * стоит не в том конце комнаты, поэтому не может ничего исправить — он может
 * только бить сильнее и злиться. Подсказка «движение не распознано» тут не
 * помогает совершенно: она повторяет то, что он уже видит.
 *
 * Поэтому каждый отказ теперь несёт три вещи:
 *
 *   1. **Что именно не так** — конкретная причина, а не факт отказа.
 *   2. **Что изменить** — действие, которое человек может выполнить прямо
 *      сейчас, одним движением.
 *   3. **Насколько близко** — доля от порога. «Дотянул 80%» и «дотянул 20%»
 *      требуют совершенно разных поправок, и без этого числа игрок не может
 *      отличить «почти получилось» от «делаю не то».
 *
 * Оценка близости заодно решает, какую из ошибок показывать, когда их за кадр
 * набралось несколько: ближайшая к успеху полезнее всех прочих, потому что
 * именно её человек исправит следующей попыткой.
 */

/** Что именно не получилось. */
export type MistakeCode =
  | 'outOfFrame'
  | 'lowLight'
  | 'armHidden'
  | 'legsHidden'
  | 'punchTooSlow'
  | 'punchTooShort'
  | 'punchNotExtended'
  | 'punchTooSoon'
  | 'kickTooLow'
  | 'kickTooSlow'
  | 'jumpTooLow'
  | 'crouchTooShallow'
  | 'dodgeTooSmall';

export interface Mistake {
  code: MistakeCode;
  /** Какая сторона тела, если ошибка про конечность. */
  side: 'left' | 'right' | 'none';
  /**
   * Насколько близко было к порогу, `[0, 1]`.
   * `0.8` — почти получилось, `0.1` — движение было совсем не тем.
   */
  progress: number;
  /** Отметка времени кадра камеры, миллисекунды. */
  timestamp: number;
}

interface Advice {
  /** Заголовок: что произошло. Коротко, читается за полсекунды. */
  title: string;
  /** Что сделать. Ровно одно действие. */
  fix: string;
  /**
   * Приоритет при равной близости. Проблемы кадра и света важнее ошибок
   * техники: пока человека не видно, поправлять удар бессмысленно.
   */
  weight: number;
}

const LEFT = 'левая';
const RIGHT = 'правая';

function hand(side: 'left' | 'right' | 'none'): string {
  if (side === 'left') return LEFT;
  if (side === 'right') return RIGHT;
  return 'рука';
}

/**
 * Тексты подсказок.
 *
 * Каждая написана как указание, а не как диагноз. «Удар не распознан» —
 * диагноз, и он бесполезен. «Выпрями руку до конца» — указание, и его можно
 * выполнить.
 */
const ADVICE: Record<MistakeCode, (m: Mistake) => Advice> = {
  outOfFrame: () => ({
    title: 'Тебя не видно',
    fix: 'Встань напротив камеры целиком — нужны плечи и руки',
    weight: 100,
  }),
  lowLight: () => ({
    title: 'Камера видит плохо',
    fix: 'Добавь света или убери источник света из-за спины',
    weight: 90,
  }),
  armHidden: (m) => ({
    title: `Не видно руку: ${hand(m.side)}`,
    fix: 'Отойди на шаг назад, чтобы рука не вылетала из кадра',
    weight: 80,
  }),
  legsHidden: () => ({
    title: 'Ног не видно',
    fix: 'Отойди дальше — для ударов ногами нужно, чтобы в кадр влезли ноги',
    weight: 70,
  }),
  punchTooSlow: () => ({
    title: 'Удар слишком плавный',
    fix: 'Выбрасывай руку резко, от плеча, а не веди её',
    weight: 40,
  }),
  punchTooShort: () => ({
    title: 'Удар не дотянулся',
    fix: 'Выпрями руку дальше вперёд — кисть должна уйти от плеча',
    weight: 40,
  }),
  punchNotExtended: () => ({
    title: 'Рука осталась согнутой',
    fix: 'Доводи удар до конца, пока локоть не выпрямится',
    weight: 40,
  }),
  punchTooSoon: (m) => ({
    title: `Слишком часто: ${hand(m.side)}`,
    fix: 'Верни руку к лицу перед следующим ударом',
    weight: 20,
  }),
  kickTooLow: () => ({
    title: 'Нога поднялась низко',
    fix: 'Выше колено — стопа должна уйти вперёд от опорной ноги',
    weight: 40,
  }),
  kickTooSlow: () => ({
    title: 'Кик слишком медленный',
    fix: 'Выбрасывай стопу резче, а не поднимай ногу',
    weight: 40,
  }),
  jumpTooLow: () => ({
    title: 'Прыжок не засчитан',
    fix: 'Оттолкнись сильнее — таз должен заметно уйти вверх',
    weight: 35,
  }),
  crouchTooShallow: () => ({
    title: 'Присед слишком мелкий',
    fix: 'Сядь ниже — согни колени, а не наклоняйся вперёд',
    weight: 35,
  }),
  dodgeTooSmall: () => ({
    title: 'Уклон не засчитан',
    fix: 'Качнись корпусом вбок сильнее и резче',
    weight: 35,
  }),
};

export interface CoachHint {
  code: MistakeCode;
  title: string;
  fix: string;
  /** `[0, 1]` — насколько близко было к засчитанному движению. */
  progress: number;
  timestamp: number;
}

export function adviseOn(mistake: Mistake): CoachHint {
  const advice = ADVICE[mistake.code](mistake);
  return {
    code: mistake.code,
    title: advice.title,
    fix: advice.fix,
    progress: mistake.progress,
    timestamp: mistake.timestamp,
  };
}

/**
 * Сколько ошибка «весит» при выборе одной из нескольких.
 *
 * Близость к порогу — основная часть, но не вся: пока человек вне кадра, его
 * техника не имеет значения, поэтому проблемы видимости всегда перевешивают.
 */
export function mistakeScore(mistake: Mistake): number {
  return ADVICE[mistake.code](mistake).weight + mistake.progress * 10;
}

/**
 * Копилка ошибок за один кадр зрения.
 *
 * Детекторы пишут сюда вместо того, чтобы молча возвращать `null`. Массив
 * переиспользуется между кадрами: это самый горячий путь в игре, и выделять
 * здесь мусор ради диагностики было бы иронично.
 */
export class MistakeLog {
  private readonly items: Mistake[] = [];

  /** Последняя показанная подсказка — её держат на экране пару секунд. */
  private current: CoachHint | null = null;
  private currentAt = 0;

  /**
   * Сколько ошибок каждого вида накопилось за сессию.
   * Это не украшение: если человек сто раз подряд «не дотянулся», значит порог
   * стоит не там, и это видно по числу, а не по ощущениям.
   */
  readonly tally = new Map<MistakeCode, number>();

  note(code: MistakeCode, side: 'left' | 'right' | 'none', progress: number, timestamp: number): void {
    this.items.push({ code, side, progress: Math.max(0, Math.min(1, progress)), timestamp });
    this.tally.set(code, (this.tally.get(code) ?? 0) + 1);
  }

  /**
   * Разбирает накопленное за кадр и обновляет показываемую подсказку.
   *
   * `holdMs` — сколько подсказка живёт на экране. Достаточно долго, чтобы
   * успеть прочитать, и достаточно коротко, чтобы не висеть над уже
   * исправленным движением.
   */
  settle(now: number, holdMs = 2200): void {
    if (this.items.length > 0) {
      let best = this.items[0];
      let bestScore = mistakeScore(best);
      for (let i = 1; i < this.items.length; i++) {
        const score = mistakeScore(this.items[i]);
        if (score > bestScore) {
          best = this.items[i];
          bestScore = score;
        }
      }
      this.current = adviseOn(best);
      this.currentAt = now;
      this.items.length = 0;
    }

    if (this.current && now - this.currentAt > holdMs) this.current = null;
  }

  /** Подсказка, которую стоит показать сейчас, или `null`. */
  get hint(): CoachHint | null {
    return this.current;
  }

  /** Убирает подсказку немедленно — например, когда удар наконец засчитан. */
  clear(): void {
    this.items.length = 0;
    this.current = null;
  }

  resetTally(): void {
    this.tally.clear();
  }
}
