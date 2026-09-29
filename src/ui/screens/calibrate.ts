import { clamp, TAU } from '@/core/math';
import { BONES, Joint, type Skeleton } from '@/vision/skeleton';
import { assessFraming } from '@/vision/calibration';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '@/render/renderer';
import { alpha, Ease, font, mix, Palette, TypeScale } from '@/render/theme';
import { MenuBackdrop } from '../backdrop';
import { Screen, type ScreenContext, type ScreenParams } from '../screen';
import { button, chamferedRect, panel, spinner, type Rect } from '../widgets';

/**
 * Calibration.
 *
 * This screen is the difference between a player saying "the game doesn't see
 * my punches" and "the game feels like it's reading my mind". It takes eight
 * seconds and it has to earn every one of them, which means showing the player
 * exactly what the camera sees at all times.
 *
 * The live skeleton overlay is not a debug view left in by accident. Watching
 * their own tracked body move is how a player learns where to stand, how much
 * light they need, and what "in frame" means — lessons no instruction text has
 * ever successfully delivered.
 */

export class CalibrateScreen extends Screen {
  readonly id = 'calibrate' as const;
  readonly visionMode = 'pose' as const;

  private readonly backdrop = new MenuBackdrop(28);
  private nextScreen: string | null = null;
  private cameraError: { title: string; hint: string } | null = null;
  private unsubscribe: (() => void)[] = [];
  private finishedAt = -1;

  /** Seconds since the tracker last produced a usable skeleton. */
  private blindFor = 0;

  constructor(context: ScreenContext) {
    super(context);
  }

  enter(params?: ScreenParams): void {
    super.enter();
    this.backdrop.accent = Palette.venom;
    this.nextScreen = (params?.next as string) ?? null;
    this.cameraError = null;
    this.finishedAt = -1;
    this.blindFor = 0;

    const { vision } = this.context;
    this.unsubscribe = [
      vision.events.on('error', (error) => {
        this.cameraError = error;
        this.context.audio.play('error');
      }),
      vision.events.on('calibrated', () => {
        this.finishedAt = this.elapsed;
        this.context.audio.play('meterFull');
      }),
    ];

    void this.begin();
  }

  private async begin(): Promise<void> {
    const { vision } = this.context;
    const started = await vision.startCamera(this.context.settings.cameraDeviceId || undefined);
    if (!started) return;
    vision.setMirrored(this.context.settings.mirrored);
    await vision.setMode('pose');
    vision.startCalibration();
  }

  exit(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.context.vision.cancelCalibration();
  }

  update(dt: number): void {
    super.update(dt);
    this.backdrop.update(dt);

    if (this.context.vision.skeleton.present) this.blindFor = 0;
    else this.blindFor += dt;

    // Give the player a moment to read "готово" before moving on.
    if (this.finishedAt >= 0 && this.elapsed - this.finishedAt > 1.6) {
      this.finishedAt = -1;
      if (this.nextScreen) this.context.replace(this.nextScreen as never);
      else this.context.pop();
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    this.backdrop.draw(ctx);

    if (this.cameraError) {
      this.drawError(ctx);
      return;
    }

    const { vision } = this.context;
    const state = vision.calibrator.state;

    this.drawHeader(ctx, state.prompt, state.hint);
    this.drawSkeletonPanel(ctx, vision.skeleton);
    this.drawProgress(ctx, state.progress, state.stage);
    this.drawSteps(ctx, state.stage);

    if (state.stage === 'done') this.drawResult(ctx);
    if (state.stage === 'failed') this.drawFailure(ctx, state.problem);

    this.drawControls(ctx);
  }

  /**
   * Why nothing is happening.
   *
   * The original build showed a spinner and «ищу тебя…» whatever the cause,
   * which is the least useful thing it could say: the player has no way to
   * tell a model that failed to download from a body that is simply too close
   * to the camera, and the two need opposite responses. Each branch below maps
   * to a different thing the player should actually do.
   */
  private diagnose(): { title: string; hint: string; colour: string } {
    const { vision } = this.context;
    const skeleton = vision.skeleton;

    if (!vision.status.cameraActive) {
      return {
        title: 'Камера не запущена',
        hint: 'Разреши доступ к камере и обнови страницу.',
        colour: Palette.rose,
      };
    }

    if (!vision.status.poseReady) {
      return {
        title: 'Модель распознавания ещё не загрузилась',
        hint: 'Это несколько мегабайт. Если висит дольше минуты — проверь интернет.',
        colour: Palette.gold,
      };
    }

    if (!skeleton.hasLandmarks) {
      return {
        title: 'Не вижу человека в кадре',
        hint: 'Встань напротив камеры и добавь света — в темноте модель не находит тело.',
        colour: Palette.gold,
      };
    }

    // Upper-body play is supported, so the only remaining failure is the one
    // thing tracking genuinely cannot do without: both shoulders.
    return {
      title: 'Не вижу плечи',
      hint: 'Повернись лицом к камере, чтобы в кадр попали оба плеча.',
      colour: Palette.gold,
    };
  }

  /** Says which tracking mode is running, and what it costs. */
  private drawModeBadge(ctx: CanvasRenderingContext2D, x: number, y: number, width: number): void {
    const skeleton = this.context.vision.skeleton;
    if (!skeleton.present) return;

    const full = skeleton.legsVisible;
    const label = full ? 'ВСЁ ТЕЛО' : 'ВЕРХ ТЕЛА';
    const note = full ? 'доступны все приёмы' : 'удары ногами недоступны';
    const colour = full ? Palette.venom : Palette.gold;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    font(ctx, TypeScale.micro, 'ui', 700);
    ctx.letterSpacing = '0.22em';
    const labelWidth = ctx.measureText(label).width;
    const pillWidth = labelWidth + 34;
    const pillX = x + width / 2 - pillWidth / 2;

    ctx.fillStyle = alpha(colour, 0.16);
    chamferedRect(ctx, pillX, y - 13, pillWidth, 26, 7);
    ctx.fill();
    ctx.strokeStyle = alpha(colour, 0.55);
    ctx.lineWidth = 1.25;
    ctx.stroke();

    ctx.fillStyle = colour;
    ctx.fillText(label, x + width / 2, y);
    ctx.letterSpacing = '0px';

    font(ctx, TypeScale.micro, 'ui', 500);
    ctx.fillStyle = Palette.ash500;
    ctx.fillText(note, x + width / 2, y + 22);
    ctx.restore();
  }

  // --- pieces ---------------------------------------------------------------

  private drawHeader(ctx: CanvasRenderingContext2D, prompt: string, hint: string): void {
    ctx.save();
    ctx.globalAlpha = this.appear;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    font(ctx, TypeScale.label, 'ui', 700);
    ctx.letterSpacing = '0.32em';
    ctx.fillStyle = Palette.venom;
    ctx.fillText('КАЛИБРОВКА', DESIGN_WIDTH / 2, 92);
    ctx.letterSpacing = '0px';

    font(ctx, TypeScale.title, 'display');
    ctx.fillStyle = Palette.paper;
    ctx.fillText(prompt, DESIGN_WIDTH / 2, 152);

    font(ctx, TypeScale.body, 'ui', 500);
    ctx.fillStyle = Palette.ash400;
    ctx.fillText(hint, DESIGN_WIDTH / 2, 196);

    ctx.restore();
  }

  /** Paints the webcam frame, letterboxed into the panel and dimmed. */
  private drawCameraFrame(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const video = this.context.vision.camera.video;
    if (video.readyState < 2 || video.videoWidth === 0) return;

    const videoAspect = video.videoWidth / video.videoHeight;
    const panelAspect = width / height;

    // Cover, not contain: an empty band inside the panel reads as a bug.
    let drawWidth = width;
    let drawHeight = height;
    if (videoAspect > panelAspect) drawWidth = height * videoAspect;
    else drawHeight = width / videoAspect;

    const offsetX = x + (width - drawWidth) / 2;
    const offsetY = y + (height - drawHeight) / 2;

    ctx.save();
    ctx.globalAlpha = 0.55;
    if (this.context.settings.mirrored) {
      // Matches the mirrored landmark coordinates drawn on top of it.
      ctx.translate(x * 2 + width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
    ctx.restore();

    // Knock the contrast back so the skeleton stays the brightest thing here.
    ctx.save();
    ctx.fillStyle = 'rgba(5, 6, 12, 0.45)';
    ctx.fillRect(x, y, width, height);
    ctx.restore();
  }

  /**
   * The live skeleton, drawn large and centred.
   * Joints are tinted by confidence, so a limb the model is unsure about
   * visibly dims — which tells the player to move into better light without a
   * single word of explanation.
   */
  private drawSkeletonPanel(ctx: CanvasRenderingContext2D, skeleton: Skeleton): void {
    const width = 520;
    const height = 560;
    const x = (DESIGN_WIDTH - width) / 2;
    const y = 246;
    const rect: Rect = { x, y, w: width, h: height };

    panel(ctx, rect, 'камера', Palette.venom);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 10, y + 60, width - 20, height - 80);
    ctx.clip();

    // The live frame, behind the skeleton.
    //
    // A panel labelled «КАМЕРА» that shows nothing but a spinner is worse than
    // no panel: the whole point of this screen is letting the player see how
    // they are framed, and the advice below ("step back", "add light") is
    // unactionable if they cannot see what the camera sees.
    this.drawCameraFrame(ctx, x + 10, y + 60, width - 20, height - 80);

    if (!skeleton.present) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      spinner(ctx, x + width / 2, y + height / 2 - 92, 26, this.elapsed, Palette.venom);

      // Give tracking a couple of seconds before explaining itself — a player
      // still walking into frame does not need a diagnosis.
      if (this.blindFor < 2.5) {
        font(ctx, TypeScale.body, 'ui', 600);
        ctx.fillStyle = Palette.ash500;
        ctx.fillText('ищу тебя…', x + width / 2, y + height / 2 - 20);
        ctx.restore();
        return;
      }

      const problem = this.diagnose();
      font(ctx, TypeScale.subheading, 'display');
      ctx.fillStyle = problem.colour;
      ctx.fillText(problem.title, x + width / 2, y + height / 2 - 14);

      font(ctx, TypeScale.label, 'ui', 500);
      ctx.fillStyle = Palette.ash300;
      wrapText(ctx, problem.hint, x + width / 2, y + height / 2 + 24, width - 90, 24);

      ctx.restore();
      return;
    }

    // Map normalised image space into the panel, preserving aspect.
    const viewW = width - 60;
    const viewH = height - 110;
    const viewX = x + 30;
    const viewY = y + 76;

    const project = (jointX: number, jointY: number): [number, number] => [
      viewX + jointX * viewW,
      viewY + jointY * viewH,
    ];

    // Bones.
    ctx.lineCap = 'round';
    for (const [a, b] of BONES) {
      const ja = skeleton.rawAt(a);
      const jb = skeleton.rawAt(b);
      const confidence = Math.min(ja.visibility, jb.visibility);
      if (confidence < 0.2) continue;

      const [ax, ay] = project(ja.x, ja.y);
      const [bx, by] = project(jb.x, jb.y);

      ctx.strokeStyle = mix(Palette.ink500, Palette.venom, confidence);
      ctx.lineWidth = 5 * confidence + 1;
      ctx.globalAlpha = 0.35 + confidence * 0.65;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }

    // Joints.
    for (let i = 0; i < skeleton.raw.length; i++) {
      const joint = skeleton.rawAt(i as never);
      if (joint.visibility < 0.25) continue;
      const [jx, jy] = project(joint.x, joint.y);
      ctx.globalAlpha = 0.4 + joint.visibility * 0.6;
      ctx.fillStyle = joint.visibility > 0.7 ? Palette.white : Palette.gold;
      ctx.beginPath();
      ctx.arc(jx, jy, 3.4, 0, TAU);
      ctx.fill();
    }

    // Hands get a highlight ring: they are what the player is being asked to move.
    ctx.globalAlpha = 1;
    for (const id of [Joint.LeftWrist, Joint.RightWrist]) {
      const joint = skeleton.rawAt(id);
      if (joint.visibility < 0.4) continue;
      const [jx, jy] = project(joint.x, joint.y);
      ctx.strokeStyle = Palette.ember;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(jx, jy, 12 + Math.sin(this.elapsed * 4) * 2, 0, TAU);
      ctx.stroke();
    }

    ctx.restore();

    // Framing advice, under the skeleton.
    const framing = assessFraming(skeleton);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.label, 'ui', 600);
    ctx.fillStyle = framing.ok ? Palette.venom : Palette.gold;
    ctx.fillText(framing.hint, x + width / 2, y + height - 44);
    ctx.restore();

    this.drawModeBadge(ctx, x, y + height + 18, width);
  }

  private drawProgress(ctx: CanvasRenderingContext2D, progress: number, stage: string): void {
    if (stage === 'done' || stage === 'failed') return;

    const width = 520;
    const x = (DESIGN_WIDTH - width) / 2;
    const y = 838;

    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillRect(x, y, width, 6);

    ctx.fillStyle = Palette.venom;
    ctx.shadowColor = Palette.venom;
    ctx.shadowBlur = 12;
    ctx.fillRect(x, y, width * clamp(progress, 0, 1), 6);
    ctx.restore();
  }

  /** The four stages, with the current one highlighted. */
  private drawSteps(ctx: CanvasRenderingContext2D, stage: string): void {
    const steps: { key: string; label: string }[] = [
      { key: 'framing', label: 'КАДР' },
      { key: 'rest', label: 'ПОКОЙ' },
      { key: 'reach', label: 'РАЗМАХ' },
      { key: 'stance', label: 'СТОЙКА' },
    ];
    const activeIndex = steps.findIndex((step) => step.key === stage);

    const y = 880;
    const gap = 150;
    const totalWidth = gap * (steps.length - 1);
    const startX = (DESIGN_WIDTH - totalWidth) / 2;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < steps.length; i++) {
      const x = startX + i * gap;
      const done = activeIndex > i || stage === 'done';
      const active = activeIndex === i;

      if (i < steps.length - 1) {
        ctx.strokeStyle = done ? Palette.venom : 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x + 16, y);
        ctx.lineTo(x + gap - 16, y);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(x, y, active ? 12 : 9, 0, TAU);
      if (done || active) {
        ctx.fillStyle = Palette.venom;
        ctx.shadowColor = Palette.venom;
        ctx.shadowBlur = active ? 16 : 0;
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      font(ctx, TypeScale.micro, 'ui', 700);
      ctx.letterSpacing = '0.16em';
      ctx.fillStyle = active ? Palette.paper : done ? Palette.ash300 : Palette.ash500;
      ctx.fillText(steps[i].label, x, y + 30);
      ctx.letterSpacing = '0px';
    }

    ctx.restore();
  }

  private drawResult(ctx: CanvasRenderingContext2D): void {
    const profile = this.context.vision.calibration;
    const t = this.finishedAt >= 0 ? clamp((this.elapsed - this.finishedAt) / 0.4, 0, 1) : 1;

    ctx.save();
    ctx.globalAlpha = Ease.out(t);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    font(ctx, TypeScale.hero, 'display');
    ctx.fillStyle = Palette.venom;
    ctx.shadowColor = Palette.venom;
    ctx.shadowBlur = 40;
    ctx.fillText('ГОТОВО', DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2);
    ctx.shadowBlur = 0;

    const quality = Math.round(profile.quality * 100);
    font(ctx, TypeScale.body, 'ui', 600);
    ctx.fillStyle = quality > 70 ? Palette.venom : quality > 45 ? Palette.gold : Palette.rose;
    ctx.fillText(`Качество отслеживания: ${quality}%`, DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2 + 62);

    if (quality <= 45) {
      font(ctx, TypeScale.label, 'ui', 500);
      ctx.fillStyle = Palette.ash400;
      ctx.fillText(
        'Добавь света или встань подальше — станет заметно лучше',
        DESIGN_WIDTH / 2,
        DESIGN_HEIGHT / 2 + 96,
      );
    }

    ctx.restore();
  }

  private drawFailure(ctx: CanvasRenderingContext2D, problem: string): void {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.heading, 'display');
    ctx.fillStyle = Palette.rose;
    ctx.fillText('НЕ ПОЛУЧИЛОСЬ', DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2);
    font(ctx, TypeScale.body, 'ui', 500);
    ctx.fillStyle = Palette.ash300;
    ctx.fillText(problem, DESIGN_WIDTH / 2, DESIGN_HEIGHT / 2 + 44);
    ctx.restore();
  }

  private drawError(ctx: CanvasRenderingContext2D): void {
    const error = this.cameraError;
    if (!error) return;

    const width = 760;
    const height = 360;
    const rect: Rect = {
      x: (DESIGN_WIDTH - width) / 2,
      y: (DESIGN_HEIGHT - height) / 2,
      w: width,
      h: height,
    };
    panel(ctx, rect, 'ошибка камеры', Palette.rose);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.heading, 'display');
    ctx.fillStyle = Palette.paper;
    ctx.fillText(error.title, DESIGN_WIDTH / 2, rect.y + 120);

    font(ctx, TypeScale.body, 'ui', 500);
    ctx.fillStyle = Palette.ash300;
    wrapText(ctx, error.hint, DESIGN_WIDTH / 2, rect.y + 170, width - 100, 28);
    ctx.restore();

    if (
      button(this.context.widgets, {
        id: 'calibrate:retry',
        // Inside the panel, not hanging off its bottom edge.
        rect: { x: DESIGN_WIDTH / 2 - 210, y: rect.y + height - 110, w: 420, h: 78 },
        label: 'ПОПРОБОВАТЬ СНОВА',
        primary: true,
        align: 'center',
      })
    ) {
      this.cameraError = null;
      void this.begin();
    }
  }

  private drawControls(ctx: CanvasRenderingContext2D): void {
    void ctx;
    const rect: Rect = { x: 96, y: DESIGN_HEIGHT - 132, w: 240, h: 78 };
    if (
      button(this.context.widgets, {
        id: 'calibrate:back',
        rect,
        label: 'НАЗАД',
        glyph: 'back',
        accent: Palette.ash400,
      })
    ) {
      this.context.audio.play('back');
      this.context.pop();
    }

    // Never leave the player stuck. If tracking has produced nothing for a
    // while, offer a way past: the default profile is a reasonable average and
    // sensitivity can be tuned later from the pause menu.
    if (this.blindFor > 12) {
      if (
        button(this.context.widgets, {
          id: 'calibrate:skip',
          rect: { x: DESIGN_WIDTH - 480, y: DESIGN_HEIGHT - 132, w: 384, h: 78 },
          label: 'ПРОПУСТИТЬ',
          hint: 'Играть с настройками по умолчанию',
          accent: Palette.gold,
        })
      ) {
        this.context.audio.play('click');
        this.context.vision.cancelCalibration();
        if (this.nextScreen) this.context.replace(this.nextScreen as never);
        else this.context.pop();
      }
    }

    const stage = this.context.vision.calibrator.state.stage;
    if (stage === 'failed') {
      if (
        button(this.context.widgets, {
          id: 'calibrate:restart',
          rect: { x: DESIGN_WIDTH - 336, y: DESIGN_HEIGHT - 132, w: 240, h: 78 },
          label: 'ЗАНОВО',
          primary: true,
        })
      ) {
        this.context.vision.startCalibration();
      }
    }
  }
}

/** Wraps text to a width, drawing centred lines. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): void {
  const words = text.split(' ');
  let line = '';
  let offset = 0;

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      ctx.fillText(line, x, y + offset);
      line = word;
      offset += lineHeight;
    } else {
      line = candidate;
    }
  }
  if (line) ctx.fillText(line, x, y + offset);
}

export { wrapText };
