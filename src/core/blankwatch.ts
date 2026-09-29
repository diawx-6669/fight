/**
 * Watches for a frame that drew nothing.
 *
 * A black screen is the single least actionable bug report a game can
 * produce. Canvas 2D has no equivalent of a shader compile error: a transform
 * built from a `NaN`, a layer that failed to allocate, a draw call skipped by
 * a guard that should never have been true — all of them paint nothing, none
 * of them say a word, and the player is left with "the game doesn't work".
 *
 * So the game checks its own output. A few hundred pixels are read back a
 * handful of times after each screen change, and if every sample comes back
 * black the game says so, on screen, along with whatever the caller knows
 * about why.
 *
 * Two deliberate limits keep this honest:
 *
 *   * **It only samples at the start.** Reading pixels back from a canvas
 *     stalls the GPU pipeline, so this is not something to do every frame.
 *     Four samples over the first few seconds of a screen catches the failure
 *     that matters — the screen that is born black — and then gets out of the
 *     way for good.
 *   * **It needs every sample to be black.** One dark frame during a fade is
 *     normal. Four in a row, seconds apart, is not.
 */

/** Mean channel value below which a frame is, for practical purposes, black. */
const BLACK_THRESHOLD = 2.5;

/** Seconds after a screen change at which to sample. */
const SAMPLE_TIMES = [0.6, 1.6, 2.8, 4];

/** The probe is tiny on purpose: this is a brightness question, not an image. */
const PROBE_WIDTH = 48;
const PROBE_HEIGHT = 27;

export class BlankFrameWatch {
  private probe: HTMLCanvasElement | null = null;
  private probeCtx: CanvasRenderingContext2D | null = null;

  private elapsed = 0;
  private nextSample = 0;
  private blackSamples = 0;

  /** True once every scheduled sample has come back black. */
  blank = false;

  /** Restarts the watch — call on every screen change. */
  reset(): void {
    this.elapsed = 0;
    this.nextSample = 0;
    this.blackSamples = 0;
    this.blank = false;
  }

  /** Call once per frame, after the frame has been drawn. */
  update(canvas: HTMLCanvasElement, dt: number): void {
    if (this.nextSample >= SAMPLE_TIMES.length) return;

    this.elapsed += dt;
    if (this.elapsed < SAMPLE_TIMES[this.nextSample]) return;
    this.nextSample++;

    const brightness = this.sample(canvas);

    // A failed read tells us nothing; treat it as "not black" so a browser
    // that refuses the readback never produces a false accusation.
    if (brightness === null || brightness > BLACK_THRESHOLD) {
      this.nextSample = SAMPLE_TIMES.length;
      return;
    }

    this.blackSamples++;
    if (this.blackSamples === SAMPLE_TIMES.length) this.blank = true;
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
      ctx.clearRect(0, 0, PROBE_WIDTH, PROBE_HEIGHT);
      ctx.drawImage(canvas, 0, 0, PROBE_WIDTH, PROBE_HEIGHT);
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
