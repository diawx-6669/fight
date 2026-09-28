/**
 * Leveled logging with per-channel scoping.
 *
 * Vision debugging is noisy enough to hide everything else, so each subsystem
 * gets its own channel that can be silenced independently. Levels are read from
 * the URL (`?log=vision,net` or `?log=all`) so a player can produce a useful
 * bug report without a rebuild.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const CHANNEL_COLORS: Record<string, string> = {
  app: '#8ceaff',
  vision: '#9dff4f',
  motion: '#ffc247',
  game: '#ff8a5c',
  render: '#c39bff',
  net: '#ff5a8a',
  audio: '#5cffd0',
  ui: '#a0b4ff',
};

let globalLevel: LogLevel = import.meta.env?.DEV ? 'info' : 'warn';
const enabledChannels = new Set<string>();
let allChannelsEnabled = true;

/** Reads `?log=` once at boot; safe to call before the DOM exists. */
export function configureLoggingFromUrl(search: string = location.search): void {
  const params = new URLSearchParams(search);
  const level = params.get('loglevel') as LogLevel | null;
  if (level && level in LEVEL_ORDER) globalLevel = level;

  const channels = params.get('log');
  if (!channels) return;
  if (channels === 'all') {
    allChannelsEnabled = true;
    globalLevel = 'debug';
    return;
  }
  allChannelsEnabled = false;
  for (const name of channels.split(',')) {
    const trimmed = name.trim();
    if (trimmed) enabledChannels.add(trimmed);
  }
  globalLevel = 'debug';
}

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

function shouldLog(channel: string, level: Exclude<LogLevel, 'silent'>): boolean {
  if (LEVEL_ORDER[globalLevel] < LEVEL_ORDER[level]) return false;
  // Errors and warnings always get through, whatever channel filter is set.
  if (level === 'error' || level === 'warn') return true;
  return allChannelsEnabled || enabledChannels.has(channel);
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Logs a message at most once per unique key, for per-frame warnings. */
  onceWarn(key: string, ...args: unknown[]): void;
}

const seenOnce = new Set<string>();

export function createLogger(channel: string): Logger {
  const color = CHANNEL_COLORS[channel] ?? '#8a91a8';
  const badge = `%c${channel}`;
  const style = `color:${color};font-weight:600`;

  return {
    debug(...args) {
      if (shouldLog(channel, 'debug')) console.debug(badge, style, ...args);
    },
    info(...args) {
      if (shouldLog(channel, 'info')) console.info(badge, style, ...args);
    },
    warn(...args) {
      if (shouldLog(channel, 'warn')) console.warn(badge, style, ...args);
    },
    error(...args) {
      if (shouldLog(channel, 'error')) console.error(badge, style, ...args);
    },
    onceWarn(key, ...args) {
      const id = `${channel}:${key}`;
      if (seenOnce.has(id)) return;
      seenOnce.add(id);
      if (shouldLog(channel, 'warn')) console.warn(badge, style, ...args);
    },
  };
}
