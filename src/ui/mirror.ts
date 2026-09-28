import { clamp, TAU } from '@/core/math';
import { BONES, type Skeleton } from '@/vision/skeleton';
import { HAND_BONES, type HandFrame } from '@/vision/handTracker';
import { alpha, mix, Palette } from '@/render/theme';

/**
 * The camera preview.
 *
 * A small picture-in-picture of what the webcam sees, with the tracked skeleton
 * drawn over it. It lives on its own DOM canvas rather than in the game's
 * design space, because it is a piece of *hardware feedback* rather than part
 * of the game world — it should stay the same physical size whatever the game
 * is doing, and it should be trivially hideable.
 *
 * It exists for one reason: when tracking goes wrong, the player needs to see
 * *why*. Backlit? Half out of frame? Sleeve swallowing the wrist? The preview
 * answers all of those in a glance, and no amount of on-screen text does.
 */

export interface MirrorOptions {
  canvas: HTMLCanvasElement;
  video: HTMLVideoElement;
}

export class CameraMirror {
  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly ctx: CanvasRenderingContext2D | null;

  private width = 0;
  private height = 0;

  visible = true;
  showSkeleton = false;
  mirrored = true;

  constructor(options: MirrorOptions) {
    this.canvas = options.canvas;
    this.video = options.video;
    this.ctx = this.canvas.getContext('2d');
  }

  private sync(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);

    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      this.canvas.width = width;
      this.canvas.height = height;
    }
    return true;
  }

  draw(skeleton: Skeleton | null, hands: readonly HandFrame[] | null, quality: number): void {
    this.canvas.dataset.visible = this.visible ? 'true' : 'false';
    if (!this.visible || !this.ctx) return;
    if (!this.sync()) return;

    const ctx = this.ctx;
    const { width, height } = this;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // The video, letterboxed and mirrored to match the game's convention.
    if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
      const videoAspect = this.video.videoWidth / this.video.videoHeight;
      const canvasAspect = width / height;

      let drawWidth = width;
      let drawHeight = height;
      if (videoAspect > canvasAspect) drawWidth = height * videoAspect;
      else drawHeight = width / videoAspect;

      const offsetX = (width - drawWidth) / 2;
      const offsetY = (height - drawHeight) / 2;

      ctx.save();
      if (this.mirrored) {
        ctx.translate(width, 0);
        ctx.scale(-1, 1);
      }
      ctx.globalAlpha = 0.72;
      ctx.drawImage(this.video, offsetX, offsetY, drawWidth, drawHeight);
      ctx.restore();

      // Darken it: the preview must never compete with the game for attention.
      ctx.fillStyle = 'rgba(4, 4, 10, 0.34)';
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.fillStyle = 'rgba(8, 8, 16, 0.9)';
      ctx.fillRect(0, 0, width, height);
    }

    if (this.showSkeleton && skeleton?.present) this.drawSkeleton(ctx, skeleton, width, height);
    if (this.showSkeleton && hands) this.drawHands(ctx, hands, width, height);

    this.drawQualityBar(ctx, width, height, quality);
  }

  /**
   * The tracked body. Bones are tinted by confidence, so a limb the model is
   * guessing about is visibly dimmer — the fastest possible diagnosis of a
   * lighting problem.
   */
  private drawSkeleton(
    ctx: CanvasRenderingContext2D,
    skeleton: Skeleton,
    width: number,
    height: number,
  ): void {
    // `raw` is already mirrored by the tracker, and so is the video above, so
    // the two line up without any further flipping here.
    const project = (x: number, y: number): [number, number] => [x * width, y * height];

    ctx.lineCap = 'round';
    for (const [a, b] of BONES) {
      const ja = skeleton.rawAt(a);
      const jb = skeleton.rawAt(b);
      const confidence = Math.min(ja.visibility, jb.visibility);
      if (confidence < 0.2) continue;

      const [ax, ay] = project(ja.x, ja.y);
      const [bx, by] = project(jb.x, jb.y);

      ctx.strokeStyle = mix(Palette.ash500, Palette.venom, confidence);
      ctx.globalAlpha = 0.4 + confidence * 0.6;
      ctx.lineWidth = 2 + confidence * 2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    for (let i = 0; i < skeleton.raw.length; i++) {
      const joint = skeleton.raw[i];
      if (joint.visibility < 0.3) continue;
      const [jx, jy] = project(joint.x, joint.y);
      ctx.fillStyle = joint.visibility > 0.7 ? Palette.white : Palette.gold;
      ctx.beginPath();
      ctx.arc(jx, jy, 2.2, 0, TAU);
      ctx.fill();
    }
  }

  private drawHands(
    ctx: CanvasRenderingContext2D,
    hands: readonly HandFrame[],
    width: number,
    height: number,
  ): void {
    for (const hand of hands) {
      if (!hand.present) continue;

      ctx.strokeStyle = alpha(Palette.frost, 0.8);
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (const [a, b] of HAND_BONES) {
        const pa = hand.points[a];
        const pb = hand.points[b];
        ctx.moveTo(pa.x * width, pa.y * height);
        ctx.lineTo(pb.x * width, pb.y * height);
      }
      ctx.stroke();

      ctx.fillStyle = Palette.frostSoft;
      for (const point of hand.points) {
        ctx.beginPath();
        ctx.arc(point.x * width, point.y * height, 1.8, 0, TAU);
        ctx.fill();
      }
    }
  }

  /** A thin quality strip along the bottom edge. */
  private drawQualityBar(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    quality: number,
  ): void {
    const value = clamp(quality, 0, 1);
    const barHeight = Math.max(2, height * 0.022);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(0, height - barHeight, width, barHeight);

    ctx.fillStyle = value > 0.7 ? Palette.venom : value > 0.4 ? Palette.gold : Palette.rose;
    ctx.fillRect(0, height - barHeight, width * value, barHeight);
  }
}
