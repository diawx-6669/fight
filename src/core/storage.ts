/**
 * Persistence for settings, progression and the calibration profile.
 *
 * `localStorage` throws in private-mode Safari and can be disabled outright,
 * so every access is guarded and falls back to an in-memory map. The game must
 * stay playable even when nothing can be saved.
 */

const PREFIX = 'shadowstrike:';

const memoryFallback = new Map<string, string>();
let storageAvailable: boolean | null = null;

function isAvailable(): boolean {
  if (storageAvailable !== null) return storageAvailable;
  try {
    const probe = `${PREFIX}__probe__`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    storageAvailable = true;
  } catch {
    storageAvailable = false;
  }
  return storageAvailable;
}

function readRaw(key: string): string | null {
  if (!isAvailable()) return memoryFallback.get(key) ?? null;
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return memoryFallback.get(key) ?? null;
  }
}

function writeRaw(key: string, value: string): void {
  memoryFallback.set(key, value);
  if (!isAvailable()) return;
  try {
    window.localStorage.setItem(PREFIX + key, value);
  } catch {
    // Quota exceeded or storage blocked — the memory fallback already has it.
  }
}

export function load<T>(key: string, fallback: T): T {
  const raw = readRaw(key);
  if (raw === null) return fallback;
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

export function save<T>(key: string, value: T): void {
  try {
    writeRaw(key, JSON.stringify(value));
  } catch {
    // Value contained a cycle — nothing we can do, and nothing worth crashing for.
  }
}

/**
 * Merges a stored object over defaults so that adding a new setting in a later
 * version does not wipe a returning player's preferences.
 */
export function loadMerged<T extends object>(key: string, defaults: T): T {
  const stored = load<Partial<T> | null>(key, null);
  if (!stored || typeof stored !== 'object') return { ...defaults };
  return { ...defaults, ...stored };
}

export function remove(key: string): void {
  memoryFallback.delete(key);
  if (!isAvailable()) return;
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Wipes every SHADOWSTRIKE key, leaving other sites on the origin alone. */
export function clearAll(): void {
  memoryFallback.clear();
  if (!isAvailable()) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(PREFIX)) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export const StorageKeys = {
  settings: 'settings',
  calibration: 'calibration',
  progress: 'progress',
  roster: 'roster',
  playerName: 'player-name',
  stats: 'stats',
} as const;
