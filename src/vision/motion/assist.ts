import { clamp } from '@/core/math';
import type { MistakeCode } from './coach';

/**
 * Автоподстройка порогов под конкретного человека.
 *
 * Игра может ошибиться в калибровке, человек может стоять ближе или дальше,
 * бить короче или мягче, камера может врать о масштабе. Любая из этих причин
 * даёт одно и то же снаружи: человек бьёт, а игра молчит. И любая из них
 * приводит к одному и тому же выводу игрока — «не работает».
 *
 * Правильного порога, подходящего всем, не существует. Зато существует
 * наблюдаемый факт: если за десять секунд человек десять раз *почти* ударил и
 * ни разу не попал, значит порог стоит не там. Не человек делает не то — если
 * бы он делал не то, промахи были бы разными и далёкими от порога, а не
 * стабильно близкими к нему.
 *
 * Поэтому здесь считается ровно это: сколько было попаданий и сколько
 * промахов «чуть-чуть». Стабильное «чуть-чуть» без попаданий опускает порог,
 * попадания возвращают его обратно. Игра подстраивается под человека, а не
 * требует, чтобы человек подстроился под неё.
 *
 * Две вещи, без которых это было бы жульничеством:
 *
 *   **Потолок.** Порог опускается не больше чем в полтора раза. Игра, где
 *   засчитывается любое шевеление, перестаёт быть игрой: ценность попадания
 *   исчезает вместе с ценностью промаха.
 *
 *   **Честность.** Подстройка не тихая. Игра говорит, что сделала её, и в
 *   настройках это видно числом. Незаметно подкрученная сложность — это
 *   обман, даже когда он в пользу игрока.
 */

/** Насколько сильно можно облегчить пороги. */
const MAX_ASSIST = 1.5;

/** Промахи ближе этого к порогу считаются «почти попал». */
const NEAR_MISS_PROGRESS = 0.4;

/** Столько близких попыток подряд без попаданий — повод опустить порог. */
const MISSES_TO_HELP = 5;

/**
 * Минимальный промежуток между засчитанными промахами.
 *
 * Один выброс руки порождает пять-шесть записей об ошибке — по одной на кадр,
 * пока рука идёт. Считать их как пять отдельных попыток значит включить помощь
 * после первого же слабого удара. Нас интересуют попытки, а не кадры, и
 * триста миллисекунд — примерно столько, сколько занимает одна.
 */
const ATTEMPT_GAP_MS = 300;

/** Насколько опускаем за один шаг. */
const STEP = 0.12;

/** За сколько секунд забываются старые промахи. */
const WINDOW_SECONDS = 14;

/** Ошибки, которые говорят о пороге, а не о позе человека. */
const THRESHOLD_MISTAKES = new Set<MistakeCode>([
  'punchTooSlow',
  'punchTooShort',
  'punchNotExtended',
  'kickTooLow',
  'kickTooSlow',
]);

export class AutoAssist {
  /**
   * Множитель, на который делятся пороги. `1` — без помощи.
   * Читается детекторами через контекст.
   */
  level = 1;

  /** Поднялся ли уровень помощи только что — чтобы сказать об этом один раз. */
  justChanged = false;

  private nearMisses: number[] = [];
  private lastHitAt = 0;
  private lastChangeAt = 0;
  private lastCountedAt = 0;

  /** Игрок попал. Лучший из возможных сигналов, что порог в порядке. */
  noteHit(now: number): void {
    this.lastHitAt = now;
    this.nearMisses.length = 0;

    // Возвращаем порог на место постепенно: резкий откат сразу после первого
    // удачного удара снова оставил бы человека без попаданий.
    if (this.level > 1 && now - this.lastChangeAt > 4000) {
      this.level = Math.max(1, this.level - STEP * 0.5);
      this.lastChangeAt = now;
    }
  }

  /** Игрок почти попал. Считается только то, что относится к порогу. */
  noteMistake(code: MistakeCode, progress: number, now: number): void {
    if (!THRESHOLD_MISTAKES.has(code)) return;
    if (progress < NEAR_MISS_PROGRESS) return;
    if (now - this.lastCountedAt < ATTEMPT_GAP_MS) return;

    this.lastCountedAt = now;
    this.nearMisses.push(now);
    const cutoff = now - WINDOW_SECONDS * 1000;
    while (this.nearMisses.length > 0 && this.nearMisses[0] < cutoff) this.nearMisses.shift();

    const dry = now - this.lastHitAt > WINDOW_SECONDS * 1000 || this.lastHitAt === 0;
    if (!dry || this.nearMisses.length < MISSES_TO_HELP) return;
    if (now - this.lastChangeAt < 3000) return;
    if (this.level >= MAX_ASSIST) return;

    this.level = clamp(this.level + STEP, 1, MAX_ASSIST);
    this.lastChangeAt = now;
    this.justChanged = true;
    this.nearMisses.length = 0;
  }

  /** Насколько сейчас легче, в процентах — для настроек и отладки. */
  get percent(): number {
    return Math.round((this.level - 1) * 100);
  }

  reset(): void {
    this.level = 1;
    this.nearMisses.length = 0;
    this.lastHitAt = 0;
    this.lastChangeAt = 0;
    this.lastCountedAt = 0;
    this.justChanged = false;
  }
}
