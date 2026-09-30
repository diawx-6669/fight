import type { RecordEntry } from '@/settings';

/**
 * Таблица рекордов.
 *
 * Локальная и честная. Соблазн сделать «рейтинг» с чужими именами велик, но
 * без сервера эти имена пришлось бы выдумать — а таблица, где человек
 * соревнуется с придуманными числами, не рейтинг, а декорация. Здесь лежат
 * собственные лучшие результаты игрока, и каждая строка настоящая.
 *
 * Когда релей будет где-то поднят, эта же структура уходит на сервер без
 * изменений: строка уже содержит всё, что нужно для общей таблицы.
 */

/** Сколько строк хранится на режим. Больше никто не смотрит. */
const PER_MODE = 5;

export const MODE_LABEL: Record<string, string> = {
  arcade: 'АРКАДА',
  survival: 'ВЫЖИВАНИЕ',
  versus: 'СВОБОДНЫЙ БОЙ',
  online: 'ОНЛАЙН',
  training: 'ТРЕНИРОВКА',
};

/** Чем меряется результат в этом режиме — подпись к колонке со счётом. */
export const MODE_UNIT: Record<string, string> = {
  arcade: 'ступень',
  survival: 'серия',
  versus: 'комбо',
  online: 'комбо',
  training: 'комбо',
};

export function modeLabel(mode: string): string {
  return MODE_LABEL[mode] ?? mode.toUpperCase();
}

export function modeUnit(mode: string): string {
  return MODE_UNIT[mode] ?? 'счёт';
}

/**
 * Добавляет результат, оставляя по пять лучших на режим.
 *
 * Нулевые результаты не записываются: строка «аркада, ступень 0» ничего не
 * говорит и только вытесняет настоящие.
 */
export function withRecord(
  records: readonly RecordEntry[],
  entry: RecordEntry,
): RecordEntry[] {
  if (entry.score <= 0) return [...records];

  const kept = [...records, entry];
  const byMode = new Map<string, RecordEntry[]>();
  for (const record of kept) {
    const list = byMode.get(record.mode) ?? [];
    list.push(record);
    byMode.set(record.mode, list);
  }

  const out: RecordEntry[] = [];
  for (const list of byMode.values()) {
    // Сортировка по счёту, а при равном — по свежести: повторить рекорд
    // сегодня приятнее, чем смотреть на прошлогоднюю дату.
    list.sort((a, b) => b.score - a.score || b.at - a.at);
    out.push(...list.slice(0, PER_MODE));
  }
  return out;
}

/** Лучшие строки по всем режимам, для экрана рекордов. */
export function bestByMode(records: readonly RecordEntry[]): RecordEntry[] {
  const best = new Map<string, RecordEntry>();
  for (const record of records) {
    const current = best.get(record.mode);
    if (!current || record.score > current.score) best.set(record.mode, record);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/** Все строки режима, от лучшей к худшей. */
export function forMode(records: readonly RecordEntry[], mode: string): RecordEntry[] {
  return records
    .filter((r) => r.mode === mode)
    .sort((a, b) => b.score - a.score || b.at - a.at);
}
