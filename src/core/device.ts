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
    visionHz: 20,
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
export class AdaptiveQuality {
  private samples: number[] = [];
  private lastChange = 0;
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

  sample(fps: number, now: number): void {
    if (!this.enabled) return;
    this.samples.push(fps);
    if (this.samples.length < 120) return;

    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    this.samples.length = 0;

    // Leave at least four seconds between changes, otherwise the tier
    // oscillates around the threshold and the look of the game flickers.
    if (now - this.lastChange < 4000) return;

    const index = this.order.indexOf(this.tier);
    if (avg < 42 && index > 0) {
      this.lastChange = now;
      this.setTier(this.order[index - 1]);
    } else if (avg > 58 && index < this.order.length - 1) {
      this.lastChange = now;
      this.setTier(this.order[index + 1]);
    }
  }
}
