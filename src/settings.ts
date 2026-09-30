import { clamp } from '@/core/math';
import type { QualityTier } from '@/core/device';
import { getDeviceProfile } from '@/core/device';
import { load, loadMerged, save, StorageKeys } from '@/core/storage';
import type { DifficultyId } from '@/game/ai/difficulty';
import { CHARACTERS } from '@/game/characters';

/**
 * Player settings.
 *
 * Every entry here exists because something can go wrong with a camera-driven
 * game that cannot go wrong with a gamepad: the room is dark, the player is
 * left-handed, the webcam is mirrored in hardware, the machine is too slow to
 * track at 30 Hz, the player is in a shared space and does not want a camera
 * preview on screen. All of it needs to be adjustable without a rebuild.
 */

export interface Settings {
  // --- input --------------------------------------------------------------
  /**
   * Detection sensitivity. Lower means bigger, more deliberate movements are
   * required; higher means the game reacts to smaller gestures. The single
   * most important setting in the game.
   */
  sensitivity: number;

  /** Mirror the camera. On by default, because a mirror is what people expect. */
  mirrored: boolean;

  /** Show the camera preview in the corner. */
  showCamera: boolean;

  /** Draw the tracked skeleton over the preview. */
  showSkeleton: boolean;

  /**
   * Версия умолчаний, уже применённых к сохранённым настройкам. Нужна, чтобы
   * новое умолчание (скелет включён) дошло и до тех, у кого настройки уже
   * сохранены со старым, — один раз, не перетирая их собственный выбор потом.
   */
  defaultsRevision: number;

  /** Selected camera, or empty for the system default. */
  cameraDeviceId: string;

  /** Let the keyboard drive a fighter too, for testing and for one-armed play. */
  keyboardFallback: boolean;

  // --- gameplay -----------------------------------------------------------
  difficulty: DifficultyId;
  /** Rounds needed to win a match. */
  roundsToWin: number;
  /** Seconds per round, or 0 for unlimited. */
  roundSeconds: number;
  /** Let the AI adapt to the player's level over a match. */
  dynamicDifficulty: boolean;

  // --- presentation -------------------------------------------------------
  quality: QualityTier;
  /** Follow the device's own suggestion and adapt at runtime. */
  autoQuality: boolean;
  /** Screen shake intensity, `0` disables it entirely. */
  screenShake: number;
  /** Slow motion on big hits. Some players find it disorienting. */
  slowMotion: boolean;
  /** Full-screen flashes. Off is the accessible choice. */
  flashes: boolean;
  /** Damage numbers floating off hits. */
  damageNumbers: boolean;

  // --- audio --------------------------------------------------------------
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;

  // --- interface ----------------------------------------------------------
  /** Control menus with hand gestures rather than the mouse. */
  handControl: boolean;
  /** Seconds of hover needed for a dwell click. */
  dwellTime: number;
  /** Show the frame-data and tracking debug overlay. */
  debugOverlay: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 1,
  mirrored: true,
  showCamera: true,
  // Скелет виден по умолчанию: без него игрок не может понять, *что* видит
  // камера, и любая ошибка распознавания выглядит как «игра не работает».
  showSkeleton: true,
  defaultsRevision: 2,
  cameraDeviceId: '',
  keyboardFallback: true,

  difficulty: 'fighter',
  roundsToWin: 2,
  roundSeconds: 99,
  dynamicDifficulty: true,

  quality: 'high',
  autoQuality: true,
  screenShake: 1,
  slowMotion: true,
  flashes: true,
  damageNumbers: true,

  masterVolume: 0.8,
  musicVolume: 0.5,
  sfxVolume: 0.9,

  handControl: true,
  dwellTime: 1.1,
  debugOverlay: false,
};

/** Clamps everything into a sane range, in case stored data has been edited. */
function sanitize(settings: Settings): Settings {
  return {
    ...settings,
    sensitivity: clamp(settings.sensitivity, 0.4, 1.8),
    roundsToWin: clamp(Math.round(settings.roundsToWin), 1, 5),
    roundSeconds: settings.roundSeconds <= 0 ? 0 : clamp(Math.round(settings.roundSeconds), 30, 300),
    screenShake: clamp(settings.screenShake, 0, 1.5),
    masterVolume: clamp(settings.masterVolume, 0, 1),
    musicVolume: clamp(settings.musicVolume, 0, 1),
    sfxVolume: clamp(settings.sfxVolume, 0, 1),
    dwellTime: clamp(settings.dwellTime, 0.5, 2.5),
  };
}

export function loadSettings(): Settings {
  const stored = loadMerged(StorageKeys.settings, DEFAULT_SETTINGS);
  // A first-time player gets the tier their machine can actually run, not the
  // authored default — a laptop that opens the game at "ultra" and stutters
  // has already made a bad first impression.
  if (!hasStoredSettings()) stored.quality = getDeviceProfile().suggestedTier;

  // Настройки, сохранённые до ревизии 2, несут `showSkeleton: false` как
  // тогдашнее умолчание, а не как выбор человека. Включаем один раз.
  const raw = load<Partial<Settings> | null>(StorageKeys.settings, null);
  if (raw && (raw.defaultsRevision ?? 1) < 2) {
    stored.showSkeleton = true;
    stored.defaultsRevision = 2;
  }
  return sanitize(stored);
}

export function saveSettings(settings: Settings): void {
  save(StorageKeys.settings, sanitize(settings));
}

function hasStoredSettings(): boolean {
  try {
    return window.localStorage.getItem(`shadowstrike:${StorageKeys.settings}`) !== null;
  } catch {
    return false;
  }
}

/** Player progression, kept separate so a settings reset does not wipe it. */
export interface Progress {
  /** Total arcade matches won — the unlock currency. */
  wins: number;
  losses: number;
  /** Highest arcade ladder stage reached. */
  arcadeStage: number;
  /** Best survival streak. */
  survivalBest: number;
  /** Characters the player has used at least once. */
  played: string[];
  /** Total hits landed, for the stats screen. */
  totalHits: number;
  totalDamage: number;
  /** Longest combo ever landed. */
  bestCombo: number;
  /** Perfect rounds. */
  perfects: number;

  /** Монеты — тратятся на кейсы. */
  coins: number;
  /** Суммарный опыт за всё время; уровень выводится из него. */
  xp: number;
  /** Бойцы, которые у игрока есть. Пополняется из кейсов. */
  owned: string[];
  /** Сколько кейсов открыто — для таблицы рекордов. */
  casesOpened: number;
  /** Лучшие результаты по режимам. */
  records: RecordEntry[];
}

/**
 * Строка таблицы рекордов.
 *
 * Хранится списком, а не полем на каждый режим, потому что режимов станет
 * больше, а таблица должна пережить это без миграции.
 */
export interface RecordEntry {
  /** Режим: `arcade`, `survival`, `versus`, `online`. */
  mode: string;
  /** Что именно измеряется: ступень, серия, комбо. */
  score: number;
  /** Боец, которым это сделано. */
  character: string;
  /** Когда, миллисекунды эпохи. */
  at: number;
}

export const DEFAULT_PROGRESS: Progress = {
  wins: 0,
  losses: 0,
  arcadeStage: 0,
  survivalBest: 0,
  played: [],
  totalHits: 0,
  totalDamage: 0,
  bestCombo: 0,
  perfects: 0,
  coins: 0,
  xp: 0,
  owned: [],
  casesOpened: 0,
  records: [],
};

export function loadProgress(): Progress {
  const progress = loadMerged(StorageKeys.progress, DEFAULT_PROGRESS);

  // Сохранение, сделанное до появления кейсов, не знает ни про монеты, ни про
  // владение бойцами. Пустой список владения означал бы, что у человека
  // отобрали всех, включая стартовых, — поэтому пустой список читается как
  // «ещё не размечено» и заполняется стартовым набором плюс тем, что он уже
  // заслужил победами по старым правилам.
  if (!Array.isArray(progress.owned) || progress.owned.length === 0) {
    progress.owned = earnedByWins(progress.wins);
  }
  if (!Array.isArray(progress.records)) progress.records = [];

  return progress;
}

/**
 * Кого игрок открыл бы по старым правилам — по числу побед.
 *
 * Нужно ровно один раз, при переходе на кейсы: отбирать уже заработанное
 * было бы худшим способом познакомить человека с новой механикой.
 */
function earnedByWins(wins: number): string[] {
  return CHARACTERS
    .filter((c) => c.unlockedByDefault || wins >= c.unlockWins)
    .map((c) => c.id);
}

export function saveProgress(progress: Progress): void {
  save(StorageKeys.progress, progress);
}

/** Sensitivity presets, so the slider has meaningful stops rather than numbers. */
export const SENSITIVITY_PRESETS: ReadonlyArray<{ label: string; value: number; hint: string }> = [
  { label: 'СПОКОЙНО', value: 0.65, hint: 'Только явные, размашистые движения' },
  { label: 'ОБЫЧНО', value: 1, hint: 'Сбалансированный вариант для большинства' },
  { label: 'ЧУТКО', value: 1.3, hint: 'Ловит короткие удары, но чаще ошибается' },
  { label: 'МАКСИМУМ', value: 1.7, hint: 'Для тесных комнат и быстрых рук' },
];

export function sensitivityLabel(value: number): string {
  let best = SENSITIVITY_PRESETS[0];
  let bestDistance = Infinity;
  for (const preset of SENSITIVITY_PRESETS) {
    const distance = Math.abs(preset.value - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = preset;
    }
  }
  return best.label;
}
