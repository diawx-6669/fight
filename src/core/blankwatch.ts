/**
 * Watches for a frame that drew nothing.
 *
 * A black screen is the single least actionable bug report a game can
 * produce. Canvas 2D has no equivalent of a shader compile error: a transform
 * built from a `NaN`, a layer that failed to allocate, a draw call skipped by
 * a guard that should never have been true — all of them paint nothing, none
 * of them say a word, and the player is left with "the game doesn't work".
 *
 * So the game checks its own output. A few hundred pixels are read back about
 * once a second, and when they keep coming back black the game says so — and,
 * before saying anything, tries the plain renderer to see whether that fixes
 * it.
 *
 * Two deliberate limits keep this honest:
 *
 *   * **It samples rarely.** Reading pixels back from a canvas stalls the
 *     pipeline, so this is emphatically not a per-frame check. It has to keep
 *     watching rather than only check at the start, because the failures worth
 *     catching include the ones that arrive later — a lost canvas, a layer
 *     that stops allocating — and a screen that is fine for ten seconds and
 *     then goes black is still a black screen.
 *   * **It takes the median of a window.** One dark frame during a fade is
 *     normal, and a warning pulsing over an otherwise black screen is not
 *     brightness. The median ignores both, and a game that recovers stops
 *     being accused as soon as the window refills.
 */

/** Mean channel value below which a frame is, for practical purposes, black. */
const BLACK_THRESHOLD = 6;

/** Seconds between samples. */
const SAMPLE_INTERVAL = 1.3;

/**
 * How many samples the verdict is taken over, and why it is their median.
 *
 * A blank fight screen is not perfectly black: the HUD, the training panel and
 * the "step back into frame" warning all still draw, and the warning *pulses*.
 * Measured, that puts the frame around 3.6 with peaks landing either side of
 * any sensible threshold — so a rule needing several black samples in a row
 * never fired, because the pulse kept clearing the count, and the exact
 * failure this watch exists for went unreported by the watch.
 */
const WINDOW = 5;

/** The probe is tiny on purpose: this is a brightness question, not an image. */
const PROBE_WIDTH = 48;
const PROBE_HEIGHT = 27;

/**
 * Vertical slice of the canvas the probe reads, as fractions of its height.
 *
 * Only the middle. The bands above and below hold the HUD — health bars,
 * names, the timer — and those are drawn in design space by code that never
 * touches the camera, so they survive every failure this watch exists to
 * catch. Averaging them in was enough to lift a completely black scene above
 * any sensible threshold, which is exactly how the first version of this
 * managed to watch a black screen and say nothing.
 */
const BAND_TOP = 0.26;
const BAND_BOTTOM = 0.8;

export class BlankFrameWatch {
  private probe: HTMLCanvasElement | null = null;
  private probeCtx: CanvasRenderingContext2D | null = null;

  private lastSampleAt = 0;
  private readonly window: number[] = [];

  /** True while the median of the recent samples is black. */
  blank = false;

  /** The last brightness read, for the diagnostic panel. `-1` before any. */
  lastBrightness = -1;

  /** Restarts the watch — call on every screen change. */
  reset(): void {
    this.lastSampleAt = performance.now() / 1000;
    this.window.length = 0;
    this.blank = false;
  }

  /**
   * Call once per frame, after the frame has been drawn.
   *
   * Paced by the wall clock rather than by the frame delta on purpose. The
   * app clamps its delta so one long stall cannot make the simulation leap,
   * and on a machine drawing four frames a second that clamp makes every
   * clock built on it run at a fraction of real time — this watch included,
   * which is how it came to take twenty seconds to collect three samples and
   * never reach a verdict. A watchdog has to measure the time that actually
   * passed, especially since a struggling machine is exactly the one it is
   * there for.
   */
  update(canvas: HTMLCanvasElement): void {
    const now = performance.now() / 1000;
    if (this.lastSampleAt === 0) this.lastSampleAt = now;
    if (now - this.lastSampleAt < SAMPLE_INTERVAL) return;
    this.lastSampleAt = now;

    const brightness = this.sample(canvas);

    // A failed read tells us nothing, and must not count either way: a browser
    // that refuses the readback should never produce an accusation.
    if (brightness === null) return;

    this.window.push(brightness);
    if (this.window.length > WINDOW) this.window.shift();
    if (this.window.length < WINDOW) return;

    const sorted = [...this.window].sort((a, b) => a - b);
    const median = sorted[(WINDOW - 1) >> 1];
    this.lastBrightness = median;
    this.blank = median < BLACK_THRESHOLD;
  }

  /** Mean brightness of the canvas, `0`–`255`, or `null` if it cannot be read. */
  private sample(canvas: HTMLCanvasElement): number | null {
    if (canvas.width === 0 || canvas.height === 0) return null;

    if (!this.probe) {
      this.probe = document.createElement('canvas');
      this.probe.width = PROBE_WIDTH;
      this.probe.height = PROBE_HEIGHT;
      this.probeCtx = this.probe.getContext('2d', { willReadFrequently: true });
    }
    const ctx = this.probeCtx;
    if (!ctx) return null;

    try {
      const top = canvas.height * BAND_TOP;
      const height = canvas.height * (BAND_BOTTOM - BAND_TOP);

      ctx.clearRect(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
      ctx.drawImage(
        canvas,
        0, top, canvas.width, height,
        0, 0, PROBE_WIDTH, PROBE_HEIGHT,
      );
      const data = ctx.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      }
      return sum / (data.length / 4);
    } catch {
      // A tainted canvas, or a context lost mid-read.
      return null;
    }
  }
}
