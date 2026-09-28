import { clamp } from '@/core/math';
import { createLogger } from '@/core/logger';
import { Rng } from '@/core/rng';

const log = createLogger('audio');

/**
 * Audio, synthesised from nothing.
 *
 * There are no sound files in this project. Every impact, every menu blip and
 * the entire soundtrack are generated with oscillators and noise buffers at
 * runtime.
 *
 * That began as a constraint — no asset pipeline, no megabytes to download
 * before the first punch — and turned into a feature. A synthesised hit can
 * take its pitch from the damage dealt and its brightness from where it
 * landed, so no two punches in a match sound the same. A sample library would
 * need dozens of variations to get halfway there.
 *
 * The browser will not let audio start before a gesture, so the whole graph is
 * built lazily on the first real interaction and everything before that is a
 * no-op rather than an error.
 */

export type SfxName =
  | 'hover'
  | 'click'
  | 'back'
  | 'error'
  | 'punchLight'
  | 'punchHeavy'
  | 'kick'
  | 'block'
  | 'parry'
  | 'whiff'
  | 'knockdown'
  | 'guardBreak'
  | 'jump'
  | 'land'
  | 'roundStart'
  | 'ko'
  | 'victory'
  | 'defeat'
  | 'meterFull'
  | 'countdown';

export interface AudioSettings {
  master: number;
  music: number;
  sfx: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;

  /** Shared noise buffer, generated once — the basis of every impact. */
  private noiseBuffer: AudioBuffer | null = null;

  private readonly rng = new Rng(0xa11d10);
  private settings: AudioSettings = { master: 0.8, music: 0.5, sfx: 0.9 };

  private musicTimer = 0;
  private musicStep = 0;
  private musicRoot = 55;
  private musicScale: readonly number[] = [0, 2, 3, 5, 7, 8, 10];
  private musicPlaying = false;
  private musicIntensity = 0;

  /** Rate limiter, so a flurry of hits does not stack into clipping. */
  private recentSounds = new Map<SfxName, number>();

  get isReady(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** Builds the graph. Safe to call repeatedly; must follow a user gesture. */
  async unlock(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }

    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    } catch (error) {
      log.warn('AudioContext unavailable', error);
      return;
    }

    const ctx = this.ctx;

    // A compressor at the end of the chain is not optional here: synthesised
    // transients are far spikier than samples, and ten of them in a combo will
    // clip without one.
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -14;
    this.compressor.knee.value = 24;
    this.compressor.ratio.value = 8;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.22;

    this.masterGain = ctx.createGain();
    this.musicGain = ctx.createGain();
    this.sfxGain = ctx.createGain();

    this.musicGain.connect(this.masterGain);
    this.sfxGain.connect(this.masterGain);
    this.masterGain.connect(this.compressor);
    this.compressor.connect(ctx.destination);

    this.applyVolumes();
    this.buildNoiseBuffer();

    if (ctx.state === 'suspended') await ctx.resume();
    log.info('audio ready');
  }

  private buildNoiseBuffer(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = this.rng.range(-1, 1);
    this.noiseBuffer = buffer;
  }

  setSettings(settings: AudioSettings): void {
    this.settings = settings;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.masterGain || !this.musicGain || !this.sfxGain || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(clamp(this.settings.master, 0, 1), now, 0.05);
    this.musicGain.gain.setTargetAtTime(clamp(this.settings.music, 0, 1) * 0.5, now, 0.08);
    this.sfxGain.gain.setTargetAtTime(clamp(this.settings.sfx, 0, 1), now, 0.05);
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }

  // --- helpers --------------------------------------------------------------

  private now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Returns `false` when the same sound fired too recently. */
  private throttle(name: SfxName, minimumGap: number): boolean {
    const now = this.now();
    const last = this.recentSounds.get(name) ?? -99;
    if (now - last < minimumGap) return false;
    this.recentSounds.set(name, now);
    return true;
  }

  private tone(options: {
    type: OscillatorType;
    frequency: number;
    /** Frequency at the end of the sweep; omit to hold. */
    endFrequency?: number;
    duration: number;
    gain: number;
    attack?: number;
    /** Destination gain node; defaults to the SFX bus. */
    destination?: AudioNode;
    detune?: number;
  }): void {
    const ctx = this.ctx;
    const bus = options.destination ?? this.sfxGain;
    if (!ctx || !bus) return;

    const now = ctx.currentTime;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = options.type;
    oscillator.frequency.setValueAtTime(options.frequency, now);
    if (options.endFrequency !== undefined) {
      // Exponential ramps cannot pass through zero, hence the floor.
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(options.endFrequency, 1),
        now + options.duration,
      );
    }
    if (options.detune) oscillator.detune.value = options.detune;

    const attack = options.attack ?? 0.004;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(options.gain, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);

    oscillator.connect(gain);
    gain.connect(bus);
    oscillator.start(now);
    oscillator.stop(now + options.duration + 0.02);
  }

  private noise(options: {
    duration: number;
    gain: number;
    /** Band-pass centre frequency. */
    frequency: number;
    q?: number;
    /** Sweep the filter down over the sound's life. */
    endFrequency?: number;
    destination?: AudioNode;
  }): void {
    const ctx = this.ctx;
    const bus = options.destination ?? this.sfxGain;
    if (!ctx || !bus || !this.noiseBuffer) return;

    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    // Start at a random offset so repeated impacts do not sound identical.
    const offset = this.rng.range(0, 1.5);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(options.frequency, now);
    filter.Q.value = options.q ?? 1.2;
    if (options.endFrequency !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(options.endFrequency, 20),
        now + options.duration,
      );
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(options.gain, now + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(bus);
    source.start(now, offset);
    source.stop(now + options.duration + 0.02);
  }

  // --- sound effects --------------------------------------------------------

  /**
   * Plays a sound. `intensity` in `[0, 1]` shapes it — a light jab and a
   * finishing blow are the same synthesis with different numbers.
   */
  play(name: SfxName, intensity = 0.5): void {
    if (!this.ctx) return;
    const power = clamp(intensity, 0, 1);

    switch (name) {
      case 'hover':
        if (!this.throttle('hover', 0.06)) return;
        this.tone({ type: 'sine', frequency: 880, endFrequency: 1180, duration: 0.07, gain: 0.05 });
        break;

      case 'click':
        this.tone({ type: 'triangle', frequency: 640, endFrequency: 1320, duration: 0.09, gain: 0.12 });
        this.noise({ duration: 0.05, gain: 0.05, frequency: 3200, q: 2 });
        break;

      case 'back':
        this.tone({ type: 'triangle', frequency: 520, endFrequency: 280, duration: 0.14, gain: 0.1 });
        break;

      case 'error':
        this.tone({ type: 'square', frequency: 160, endFrequency: 110, duration: 0.2, gain: 0.09 });
        break;

      case 'punchLight':
        // A short filtered noise burst is the "air"; the sine is the "meat".
        this.noise({ duration: 0.09, gain: 0.3 + power * 0.25, frequency: 1600, endFrequency: 420, q: 0.9 });
        this.tone({ type: 'sine', frequency: 180 - power * 40, endFrequency: 60, duration: 0.14, gain: 0.35 + power * 0.25 });
        break;

      case 'punchHeavy':
        this.noise({ duration: 0.16, gain: 0.4 + power * 0.3, frequency: 1100, endFrequency: 180, q: 0.7 });
        this.tone({ type: 'sine', frequency: 120 - power * 30, endFrequency: 42, duration: 0.3, gain: 0.55 + power * 0.3 });
        this.tone({ type: 'triangle', frequency: 320, endFrequency: 90, duration: 0.12, gain: 0.18 });
        break;

      case 'kick':
        this.noise({ duration: 0.2, gain: 0.35 + power * 0.3, frequency: 820, endFrequency: 150, q: 0.6 });
        this.tone({ type: 'sine', frequency: 96, endFrequency: 38, duration: 0.34, gain: 0.6 + power * 0.25 });
        break;

      case 'block':
        // Bright, metallic, and short — it should read as "stopped", not "hit".
        this.noise({ duration: 0.1, gain: 0.3, frequency: 3400, endFrequency: 1800, q: 3 });
        this.tone({ type: 'square', frequency: 520, endFrequency: 380, duration: 0.07, gain: 0.1 });
        break;

      case 'parry':
        this.tone({ type: 'sine', frequency: 1320, endFrequency: 2640, duration: 0.22, gain: 0.22 });
        this.tone({ type: 'sine', frequency: 1980, endFrequency: 3300, duration: 0.18, gain: 0.12, detune: 8 });
        this.noise({ duration: 0.14, gain: 0.16, frequency: 5200, q: 4 });
        break;

      case 'whiff':
        if (!this.throttle('whiff', 0.09)) return;
        this.noise({ duration: 0.16, gain: 0.1 + power * 0.1, frequency: 900, endFrequency: 2400, q: 1.4 });
        break;

      case 'jump':
        this.tone({ type: 'sine', frequency: 220, endFrequency: 440, duration: 0.14, gain: 0.14 });
        break;

      case 'land':
        this.noise({ duration: 0.14, gain: 0.18 + power * 0.2, frequency: 400, endFrequency: 120, q: 0.8 });
        break;

      case 'knockdown':
        this.tone({ type: 'sine', frequency: 88, endFrequency: 30, duration: 0.5, gain: 0.6 });
        this.noise({ duration: 0.4, gain: 0.3, frequency: 600, endFrequency: 90, q: 0.5 });
        break;

      case 'guardBreak':
        this.noise({ duration: 0.34, gain: 0.34, frequency: 2600, endFrequency: 400, q: 2.2 });
        this.tone({ type: 'sawtooth', frequency: 320, endFrequency: 90, duration: 0.3, gain: 0.2 });
        break;

      case 'meterFull':
        this.tone({ type: 'sine', frequency: 660, endFrequency: 990, duration: 0.3, gain: 0.16 });
        this.tone({ type: 'sine', frequency: 990, endFrequency: 1320, duration: 0.36, gain: 0.1 });
        break;

      case 'roundStart':
        this.tone({ type: 'sawtooth', frequency: 220, endFrequency: 660, duration: 0.42, gain: 0.2 });
        this.noise({ duration: 0.5, gain: 0.12, frequency: 2000, endFrequency: 300, q: 0.8 });
        break;

      case 'countdown':
        this.tone({ type: 'square', frequency: 880, duration: 0.1, gain: 0.12 });
        break;

      case 'ko':
        this.tone({ type: 'sawtooth', frequency: 160, endFrequency: 40, duration: 1.1, gain: 0.4 });
        this.tone({ type: 'sine', frequency: 80, endFrequency: 26, duration: 1.4, gain: 0.5 });
        this.noise({ duration: 0.9, gain: 0.26, frequency: 1400, endFrequency: 80, q: 0.5 });
        break;

      case 'victory':
        this.arpeggio([0, 4, 7, 12], 330, 0.1, 0.2);
        break;

      case 'defeat':
        this.arpeggio([0, -3, -7, -12], 220, 0.16, 0.18);
        break;
    }
  }

  private arpeggio(steps: readonly number[], root: number, spacing: number, gain: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (let i = 0; i < steps.length; i++) {
      const frequency = root * Math.pow(2, steps[i] / 12);
      window.setTimeout(() => {
        this.tone({ type: 'triangle', frequency, duration: 0.5, gain, attack: 0.01 });
      }, i * spacing * 1000);
    }
  }

  /** Impact sound chosen from the move and how hard it landed. */
  playImpact(limb: 'hand' | 'foot', severity: number, blocked: boolean): void {
    if (blocked) {
      this.play('block', severity);
      return;
    }
    if (limb === 'foot') this.play('kick', severity);
    else this.play(severity > 0.6 ? 'punchHeavy' : 'punchLight', severity);
  }

  // --- music ----------------------------------------------------------------

  /**
   * Generative soundtrack.
   *
   * A sparse arpeggio over a drone, in the arena's own key. It does not
   * develop, it does not have a chorus, and that is deliberate: this is music
   * to fight over, and anything with a hook would compete with the fight for
   * the player's attention within two rounds.
   */
  startMusic(root: number, mode: 'minor' | 'dorian' | 'phrygian' | 'aeolian'): void {
    if (!this.ctx) return;
    this.musicRoot = root;
    this.musicScale = SCALES[mode];
    this.musicPlaying = true;
    this.musicStep = 0;
    this.musicTimer = 0;
    this.startDrone();
  }

  stopMusic(): void {
    this.musicPlaying = false;
    this.stopDrone();
  }

  /** Raises the intensity as a round gets tense. */
  setMusicIntensity(intensity: number): void {
    this.musicIntensity = clamp(intensity, 0, 1);
  }

  private droneNodes: { oscillator: OscillatorNode; gain: GainNode }[] = [];

  private startDrone(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicGain) return;
    this.stopDrone();

    // Two detuned saws a fifth apart. Unglamorous and extremely effective.
    const base = midiToFrequency(this.musicRoot - 12);
    for (const [ratio, level, detune] of [
      [1, 0.09, -6],
      [1.5, 0.05, 7],
      [2, 0.03, 0],
    ] as const) {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      oscillator.type = 'sawtooth';
      oscillator.frequency.value = base * ratio;
      oscillator.detune.value = detune;

      filter.type = 'lowpass';
      filter.frequency.value = 420;
      filter.Q.value = 0.7;

      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(level, ctx.currentTime + 2.4);

      oscillator.connect(filter);
      filter.connect(gain);
      gain.connect(this.musicGain);
      oscillator.start();

      this.droneNodes.push({ oscillator, gain });
    }
  }

  private stopDrone(): void {
    const ctx = this.ctx;
    for (const node of this.droneNodes) {
      if (ctx) {
        node.gain.gain.cancelScheduledValues(ctx.currentTime);
        node.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
        node.oscillator.stop(ctx.currentTime + 1.5);
      } else {
        node.oscillator.stop();
      }
    }
    this.droneNodes = [];
  }

  /** Call every frame; schedules the next note when one is due. */
  update(dt: number): void {
    if (!this.musicPlaying || !this.ctx || !this.musicGain) return;

    this.musicTimer += dt;
    // Tempo rises with intensity: 92 bpm at rest, ~132 when someone is nearly out.
    const beat = 60 / (92 + this.musicIntensity * 40) / 2;
    if (this.musicTimer < beat) return;
    this.musicTimer -= beat;

    const step = this.musicStep++;
    // A sparse pattern: most steps are silent, which leaves room for the fight.
    const density = 0.22 + this.musicIntensity * 0.3;
    if (!this.rng.chance(density)) return;

    const degree = this.musicScale[this.rng.int(0, this.musicScale.length - 1)];
    const octave = this.rng.chance(0.25) ? 12 : 0;
    const note = this.musicRoot + degree + octave;

    this.tone({
      type: 'triangle',
      frequency: midiToFrequency(note),
      duration: 0.5 + this.rng.range(0, 0.4),
      gain: 0.055 + this.musicIntensity * 0.03,
      attack: 0.02,
      destination: this.musicGain,
    });

    // A soft percussive tick on the downbeat keeps a pulse under the drone.
    if (step % 4 === 0) {
      this.noise({
        duration: 0.08,
        gain: 0.04 + this.musicIntensity * 0.04,
        frequency: 240,
        endFrequency: 90,
        q: 1,
        destination: this.musicGain,
      });
    }
  }

  dispose(): void {
    this.stopMusic();
    void this.ctx?.close();
    this.ctx = null;
  }
}

const SCALES: Record<'minor' | 'dorian' | 'phrygian' | 'aeolian', readonly number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};

function midiToFrequency(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}
