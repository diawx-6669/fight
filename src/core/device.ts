import { createLogger } from './logger';

const log = createLogger('app');

/**
 * Capability and performance probing.
 *
 * The vision pipeline is the expensive part of this game, and what a machine
 * can afford varies wildly — a desktop with a discrete GPU runs pose tracking
 * at 60 Hz, a mid-range phone manages 20. Rather than shipping one setting that
 * is wrong everywhere, the game measures the device and picks a tier, which the
 * player can still override in Settings.
 */

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface DeviceProfile {
  readonly isMobile: boolean;
  readonly isTouch: boolean;
  readonly isSafari: boolean;
  readonly isFirefox: boolean;
  /** `navigator.hardwareConcurrency`, floored to something sane. */
  readonly cores: number;
  /** Device memory in GB when the browser reports it, else a guess. */
  readonly memoryGb: number;
  readonly pixelRatio: number;
  readonly supportsWebGL2: boolean;
  readonly supportsWebGPU: boolean;
  readonly supportsOffscreenCanvas: boolean;
  readonly supportsCamera: boolean;
  readonly isSecureContext: boolean;
  readonly suggestedTier: QualityTier;
}

function detectWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

function suggestTier(
  cores: number,
  memoryGb: number,
  isMobile: boolean,
  webgl2: boolean,
): QualityTier {
  if (!webgl2) return 'low';
  if (isMobile) return cores >= 8 && memoryGb >= 6 ? 'medium' : 'low';
  if (cores >= 12 && memoryGb >= 16) return 'ultra';
  if (cores >= 8 && memoryGb >= 8) return 'high';
  if (cores >= 4) return 'medium';
  return 'low';
}

let cached: DeviceProfile | null = null;

export function getDeviceProfile(): DeviceProfile {
  if (cached) return cached;

  const ua = navigator.userAgent;
  const isMobile = /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua);
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  const isFirefox = /firefox/i.test(ua);

  const cores = Math.max(2, navigator.hardwareConcurrency || 4);
  const memoryGb =
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? (isMobile ? 4 : 8);
  const supportsWebGL2 = detectWebGL2();

  cached = {
    isMobile,
    isTouch,
    isSafari,
    isFirefox,
    cores,
    memoryGb,
    // Above 3x the extra pixels buy nothing visible and cost a lot of fill rate.
    pixelRatio: Math.min(window.devicePixelRatio || 1, 3),
    supportsWebGL2,
    supportsWebGPU: 'gpu' in navigator,
    supportsOffscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    supportsCamera: Boolean(navigator.mediaDevices?.getUserMedia),
    isSecureContext: window.isSecureContext,
    suggestedTier: suggestTier(cores, memoryGb, isMobile, supportsWebGL2),
  };

  log.info('device profile', cached);
  return cached;
}

/** Quality knobs each tier implies. The renderer reads these every frame. */
export interface QualitySettings {
  readonly maxParticles: number;
  readonly trailSegments: number;
  readonly clothSegments: number;
  readonly bloom: boolean;
  readonly grain: boolean;
  readonly chromaticAberration: boolean;
  readonly shadowBlur: boolean;
  readonly parallaxLayers: number;
  readonly renderScale: number;
  /** Target pose-tracking rate; the vision loop throttles down to this. */
  readonly visionHz: number;
}

export const QUALITY_PRESETS: Record<QualityTier, QualitySettings> = {
  low: {
    maxParticles: 120,
    trailSegments: 6,
    clothSegments: 5,
    bloom: false,
    grain: false,
    chromaticAberration: false,
    shadowBlur: false,
    parallaxLayers: 3,
    renderScale: 0.75,
    // Модель считается в воркере и кадры игре не ест, а 20 Гц — это 50 мс
    // между снимками: удар целиком укладывается в три кадра.
    visionHz: 25,
  },
  medium: {
    maxParticles: 320,
    trailSegments: 10,
    clothSegments: 8,
    bloom: true,
    grain: false,
    chromaticAberration: false,
    shadowBlur: true,
    parallaxLayers: 4,
    renderScale: 0.9,
    visionHz: 30,
  },
  high: {
    maxParticles: 700,
    trailSegments: 16,
    clothSegments: 12,
    bloom: true,
    grain: true,
    chromaticAberration: true,
    shadowBlur: true,
    parallaxLayers: 6,
    renderScale: 1,
    visionHz: 45,
  },
  ultra: {
    maxParticles: 1400,
    trailSegments: 24,
    clothSegments: 16,
    bloom: true,
    grain: true,
    chromaticAberration: true,
    shadowBlur: true,
    parallaxLayers: 7,
    renderScale: 1,
    visionHz: 60,
  },
};

/**
 * Watches real frame times and steps the tier down when the machine cannot
 * keep up. Fighting games live or die on a stable frame rate, so we would
 * rather drop particles than drop inputs.
 */
/** Сколько секунд усредняем частоту кадров перед решением. */
const WINDOW_MS = 1500;

/** Пауза между изменениями уровня, чтобы он не мигал у порога. */
const SETTLE_MS = 3000;

/** Ниже этого — понижаем уровень. */
const DROP_FPS = 42;

/** Ниже этого спорить не о чем: сразу на самый низкий уровень. */
const COLLAPSE_FPS = 22;

/** Выше этого — можно попробовать уровень повыше. */
const RAISE_FPS = 58;

export class AdaptiveQuality {
  private samples: number[] = [];
  private lastChange = 0;
  private windowStart = 0;
  private readonly order: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

  constructor(
    private tier: QualityTier,
    private readonly onChange: (tier: QualityTier) => void,
    /** Set false once the player picks a tier by hand. */
    public enabled = true,
  ) {}

  get current(): QualityTier {
    return this.tier;
  }

  setTier(tier: QualityTier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.onChange(tier);
  }

  /**
   * Принимает уровень, выставленный со стороны, не объявляя об этом.
   *
   * Нужно потому, что игрок может поменять качество руками в настройках, и без
   * этого регулятор продолжал бы считать текущим тот уровень, который сам
   * выставил в прошлый раз. Следующее его решение отсчитывалось бы от
   * несуществующего состояния — например, «понизить на ступень» относительно
   * уровня, который человек уже давно сменил.
   */
  syncTier(tier: QualityTier): void {
    this.tier = tier;
    this.samples.length = 0;
    this.windowStart = 0;
  }

  sample(fps: number, now: number): void {
    if (!this.enabled) return;

    this.samples.push(fps);
    if (this.windowStart === 0) this.windowStart = now;

    // Окно измеряется секундами, а не кадрами.
    //
    // Раньше здесь ждали сто двадцать кадров — и это ровно та ошибка, из-за
    // которой регулятор бесполезен именно там, где он нужен. На машине,
    // выдающей восемь кадров в секунду, сто двадцать кадров — это пятнадцать
    // секунд до первого понижения и полминуты до второго. Всё это время
    // человек сидит в неиграбельном тормозе, ради спасения от которого
    // регулятор и написан. Чем хуже машина, тем дольше он молчал.
    if (now - this.windowStart < WINDOW_MS) return;

    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    this.samples.length = 0;
    this.windowStart = now;

    // Leave a few seconds between changes, otherwise the tier oscillates
    // around the threshold and the look of the game flickers.
    if (now - this.lastChange < SETTLE_MS) return;

    const index = this.order.indexOf(this.tier);

    if (avg < DROP_FPS && index > 0) {
      // Насколько плохо, настолько и падаем. Спускаться по одной ступени с
      // паузой на каждой — значит провести ещё несколько секунд в тормозах
      // на пути к уровню, который машина тянет. При десяти кадрах в секунду
      // спорить не о чем: сразу на нижний.
      const step = avg < COLLAPSE_FPS ? index : 1;
      this.lastChange = now;
      this.setTier(this.order[index - step]);
      return;
    }

    // Наверх — только по одной ступени и только с хорошим запасом: ошибка
    // вверх возвращает тормоза, ошибка вниз стоит немного блеска.
    if (avg > RAISE_FPS && index < this.order.length - 1) {
      this.lastChange = now;
      this.setTier(this.order[index + 1]);
    }
  }
}
