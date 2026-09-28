import './styles/main.css';

import { configureLoggingFromUrl, createLogger } from '@/core/logger';
import { getDeviceProfile } from '@/core/device';
import { App } from './app';

/**
 * Entry point.
 *
 * Its whole job is to get from "a blank page" to "a running game" without ever
 * showing the player a broken screen. That means the boot splash stays up until
 * the app is genuinely ready, every failure path produces a sentence a human
 * can act on, and anything unsupported is caught *before* the game tries to use
 * it rather than as a stack trace halfway through a fight.
 */

configureLoggingFromUrl();
const log = createLogger('app');

const boot = document.getElementById('boot');
const bootBar = document.getElementById('boot-bar-fill');
const bootStatus = document.getElementById('boot-status');

function setBootProgress(stage: string, ratio: number): void {
  if (bootStatus) bootStatus.textContent = stage;
  if (bootBar) bootBar.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

function dismissBoot(): void {
  boot?.setAttribute('data-done', 'true');
  // Remove it entirely once the fade is over, so it can never eat a pointer
  // event on a slow machine.
  window.setTimeout(() => boot?.remove(), 700);
}

/** Replaces the page with an explanation. Used only for unrecoverable failures. */
function showFatal(title: string, message: string, detail?: string): void {
  boot?.remove();
  const container = document.createElement('div');
  container.className = 'fatal';

  const heading = document.createElement('h1');
  heading.textContent = title;

  const paragraph = document.createElement('p');
  paragraph.textContent = message;

  container.append(heading, paragraph);

  if (detail) {
    const code = document.createElement('code');
    // textContent, not innerHTML: `detail` can carry an error message from
    // anywhere, and this page is not a place to be clever about markup.
    code.textContent = detail;
    container.append(code);
  }

  document.body.append(container);
}

function checkSupport(): { ok: true } | { ok: false; title: string; message: string } {
  if (!window.isSecureContext) {
    return {
      ok: false,
      title: 'Нужно защищённое соединение',
      message:
        'Браузер не даёт доступ к камере по обычному http. ' +
        'Открой игру по https:// или с localhost.',
    };
  }

  const device = getDeviceProfile();
  if (!device.supportsCamera) {
    return {
      ok: false,
      title: 'Камера недоступна',
      message:
        'Этот браузер не поддерживает захват видео. ' +
        'Попробуй свежий Chrome, Edge, Firefox или Safari.',
    };
  }

  const canvas = document.createElement('canvas');
  if (!canvas.getContext('2d')) {
    return {
      ok: false,
      title: 'Браузер слишком старый',
      message: 'Не удалось создать 2D-контекст холста. Обнови браузер и попробуй снова.',
    };
  }

  return { ok: true };
}

async function bootstrap(): Promise<void> {
  setBootProgress('проверка браузера', 0.08);

  const support = checkSupport();
  if (!support.ok) {
    showFatal(support.title, support.message);
    return;
  }

  const canvas = document.getElementById('stage');
  const video = document.getElementById('camera');
  const mirror = document.getElementById('mirror');

  if (
    !(canvas instanceof HTMLCanvasElement) ||
    !(video instanceof HTMLVideoElement) ||
    !(mirror instanceof HTMLCanvasElement)
  ) {
    showFatal('Страница загрузилась не полностью', 'Обнови страницу — это обычно помогает.');
    return;
  }

  setBootProgress('запуск движка', 0.24);

  let app: App;
  try {
    app = new App({
      canvas,
      video,
      mirror,
      onProgress: (stage, ratio) => setBootProgress(stage, 0.4 + ratio * 0.55),
    });
  } catch (error) {
    log.error('failed to construct app', error);
    showFatal(
      'Не удалось запустить игру',
      'Что-то пошло не так при инициализации. Обнови страницу.',
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  setBootProgress('доступ к камере', 0.45);

  try {
    await app.start();
  } catch (error) {
    // A failure here is usually the camera being refused, which the app itself
    // reports on screen — so the game still opens rather than dying at boot.
    log.warn('start completed with problems', error);
  }

  setBootProgress('готово', 1);
  // A beat at 100% before the fade, so the bar does not appear to jump.
  window.setTimeout(dismissBoot, 260);

  // Expose the app for debugging without shipping a global in production.
  if (import.meta.env?.DEV) {
    (window as unknown as { shadowstrike: App }).shadowstrike = app;
  }

  window.addEventListener('beforeunload', () => app.dispose());
}

// An unhandled rejection at boot would otherwise leave the splash up forever.
window.addEventListener('unhandledrejection', (event) => {
  log.error('unhandled rejection', event.reason);
});

void bootstrap().catch((error) => {
  log.error('bootstrap failed', error);
  showFatal(
    'Игра не запустилась',
    'Обнови страницу. Если не помогает — проверь, что камера подключена и не занята другим приложением.',
    error instanceof Error ? error.message : String(error),
  );
});
