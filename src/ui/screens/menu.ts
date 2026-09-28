import { clamp, TAU } from '@/core/math';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '@/render/renderer';
import { alpha, Ease, font, Palette, TypeScale } from '@/render/theme';
import { MenuBackdrop } from '../backdrop';
import { Screen, type ScreenContext } from '../screen';
import { button, drawGlyph, type Rect } from '../widgets';

/**
 * The title screen.
 *
 * Its real job is not to list options — it is to answer, in the first three
 * seconds, "can this thing see me?". A player who opens a camera game and gets
 * a menu with no feedback assumes it is broken. So the tracking state is the
 * loudest element after the logo, and the primary button changes its label
 * depending on whether the player has ever calibrated.
 */

interface MenuItem {
  id: string;
  label: string;
  hint: string;
  glyph: 'play' | 'globe' | 'target' | 'gear' | 'trophy' | 'camera';
  action: () => void;
  primary?: boolean;
  accent?: string;
}

export class MenuScreen extends Screen {
  readonly id = 'menu' as const;
  readonly visionMode = 'hands' as const;
  readonly allowBack = false;

  private readonly backdrop = new MenuBackdrop();
  private items: MenuItem[] = [];
  private logoPulse = 0;

  constructor(context: ScreenContext) {
    super(context);
    this.buildItems();
  }

  private buildItems(): void {
    const { context } = this;
    const calibrated = context.vision.calibration.capturedAt > 0;

    this.items = [
      {
        id: 'play',
        label: calibrated ? 'В БОЙ' : 'НАЧАТЬ',
        hint: calibrated ? 'Аркада, спарринг, выживание' : 'Сначала быстрая настройка под тебя',
        glyph: 'play',
        primary: true,
        accent: Palette.ember,
        action: () => {
          if (calibrated) context.push('mode');
          else context.push('calibrate', { next: 'mode' });
        },
      },
      {
        id: 'online',
        label: 'ОНЛАЙН',
        hint: 'Бой против другого игрока',
        glyph: 'globe',
        accent: Palette.frost,
        action: () => context.push('lobby'),
      },
      {
        id: 'calibrate',
        label: 'КАЛИБРОВКА',
        hint: 'Настроить распознавание под себя',
        glyph: 'target',
        accent: Palette.venom,
        action: () => context.push('calibrate'),
      },
      {
        id: 'settings',
        label: 'НАСТРОЙКИ',
        hint: 'Камера, качество, звук',
        glyph: 'gear',
        accent: Palette.ash300,
        action: () => context.push('settings'),
      },
    ];
  }

  enter(): void {
    super.enter();
    this.buildItems();
    this.backdrop.accent = Palette.ember;
    this.context.audio.setMusicIntensity(0.1);
  }

  update(dt: number): void {
    super.update(dt);
    this.backdrop.update(dt);
    this.logoPulse += dt;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    this.backdrop.draw(ctx);

    const appear = this.appear;
    this.drawLogo(ctx, appear);
    this.drawItems(ctx, appear);
    this.drawTrackingStatus(ctx, appear);
    this.drawFooter(ctx, appear);
  }

  private drawLogo(ctx: CanvasRenderingContext2D, appear: number): void {
    const x = 132;
    const y = 250;
    const slide = (1 - Ease.out(appear)) * -60;

    ctx.save();
    ctx.globalAlpha = appear;
    ctx.translate(slide, 0);

    // Mark.
    const markX = x + 26;
    const markY = y - 96;
    const breathe = 1 + Math.sin(this.logoPulse * 1.6) * 0.04;
    ctx.save();
    ctx.translate(markX, markY);
    ctx.scale(breathe, breathe);
    ctx.shadowColor = Palette.ember;
    ctx.shadowBlur = 30;
    const gradient = ctx.createLinearGradient(0, -34, 0, 34);
    gradient.addColorStop(0, Palette.ember);
    gradient.addColorStop(1, Palette.blood);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(0, -36);
    ctx.lineTo(26, -10);
    ctx.lineTo(16, 8);
    ctx.lineTo(28, 20);
    ctx.lineTo(0, 38);
    ctx.lineTo(-28, 20);
    ctx.lineTo(-16, 8);
    ctx.lineTo(-26, -10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Wordmark.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    font(ctx, 116, 'display');
    ctx.letterSpacing = '0.06em';

    const textGradient = ctx.createLinearGradient(x, y - 90, x, y);
    textGradient.addColorStop(0, Palette.white);
    textGradient.addColorStop(1, Palette.ash400);
    ctx.fillStyle = textGradient;
    ctx.fillText('SHADOWSTRIKE', x, y);
    ctx.letterSpacing = '0px';

    // Underline, drawn as a gradient rule that fades out to the right.
    const rule = ctx.createLinearGradient(x, 0, x + 620, 0);
    rule.addColorStop(0, Palette.ember);
    rule.addColorStop(1, alpha(Palette.ember, 0));
    ctx.fillStyle = rule;
    ctx.fillRect(x, y + 18, 620, 3);

    font(ctx, TypeScale.body, 'ui', 500);
    ctx.fillStyle = Palette.ash400;
    ctx.letterSpacing = '0.3em';
    ctx.fillText('ТВОЁ ТЕЛО — ЭТО КОНТРОЛЛЕР', x + 4, y + 54);
    ctx.letterSpacing = '0px';

    ctx.restore();
  }

  private drawItems(ctx: CanvasRenderingContext2D, appear: number): void {
    const startY = 370;
    const height = 96;
    const gap = 16;
    const width = 560;
    const x = 132;

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      // Stagger: each row arrives a beat after the one above it.
      const delay = 0.06 * i;
      const local = clamp((this.elapsed - delay) / 0.34, 0, 1);
      if (local <= 0) continue;

      const rect: Rect = { x, y: startY + i * (height + gap), w: width, h: height };

      ctx.save();
      ctx.globalAlpha = local * appear;
      ctx.translate((1 - Ease.out(local)) * -40, 0);

      if (
        button(this.context.widgets, {
          id: `menu:${item.id}`,
          rect,
          label: item.label,
          hint: item.hint,
          glyph: item.glyph,
          primary: item.primary,
          accent: item.accent,
        })
      ) {
        item.action();
      }

      ctx.restore();
    }
  }

  /**
   * The tracking readout.
   *
   * Deliberately prominent. It is the answer to "is my camera working", and a
   * player should be able to check it without opening settings.
   */
  private drawTrackingStatus(ctx: CanvasRenderingContext2D, appear: number): void {
    const { vision } = this.context;
    const x = DESIGN_WIDTH - 132;
    // High enough to clear the camera preview, which is a DOM element pinned
    // to the bottom-right corner and knows nothing about this layout.
    const y = DESIGN_HEIGHT - 400;

    const active = vision.status.cameraActive;
    const seeing = vision.status.present;
    const color = !active ? Palette.rose : seeing ? Palette.venom : Palette.gold;
    const label = !active ? 'КАМЕРА ВЫКЛЮЧЕНА' : seeing ? 'ТЕБЯ ВИДНО' : 'ВСТАНЬ В КАДР';

    ctx.save();
    ctx.globalAlpha = appear;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    // Pulsing dot.
    const pulse = 0.6 + Math.sin(this.logoPulse * 3) * 0.4;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 16 * pulse;
    ctx.beginPath();
    ctx.arc(x - 210, y, 7, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;

    font(ctx, TypeScale.label, 'ui', 700);
    ctx.letterSpacing = '0.2em';
    ctx.fillStyle = color;
    ctx.fillText(label, x, y);
    ctx.letterSpacing = '0px';

    if (active) {
      font(ctx, TypeScale.micro, 'ui', 500);
      ctx.fillStyle = Palette.ash400;
      ctx.fillText(
        `${vision.status.hz.toFixed(0)} Гц · ${vision.status.inferenceMs.toFixed(0)} мс`,
        x,
        y + 22,
      );
    }

    // Whatever went wrong with the camera is said here, in place, rather than
    // taking over the screen. The player can still navigate with a mouse.
    const problem = vision.status.lastError;
    if (problem) {
      font(ctx, TypeScale.micro, 'ui', 600);
      ctx.fillStyle = Palette.rose;
      ctx.fillText(problem.title, x, y + 46);
      ctx.fillStyle = Palette.ash400;
      font(ctx, TypeScale.micro, 'ui', 500);
      ctx.fillText(problem.hint, x, y + 66);
    }

    ctx.restore();
  }

  private drawFooter(ctx: CanvasRenderingContext2D, appear: number): void {
    const { progress } = this.context;
    ctx.save();
    ctx.globalAlpha = appear * 0.8;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    const y = DESIGN_HEIGHT - 66;
    font(ctx, TypeScale.micro, 'ui', 600);
    ctx.fillStyle = Palette.ash500;
    ctx.letterSpacing = '0.18em';

    const stats = [
      `ПОБЕД ${progress.wins}`,
      `ЛУЧШЕЕ КОМБО ${progress.bestCombo}`,
      `ИДЕАЛЬНЫХ ${progress.perfects}`,
    ];
    let x = 134;
    for (const stat of stats) {
      ctx.fillText(stat, x, y);
      x += ctx.measureText(stat).width + 44;
    }
    ctx.letterSpacing = '0px';

    // Gesture hint sits above the stats on the left, well clear of the
    // preview panel in the opposite corner.
    ctx.fillStyle = Palette.ash500;
    drawGlyph(ctx, 'camera', 140, y - 34, 11, Palette.ash500);
    ctx.fillText('ЩИПОК — ВЫБОР · ОТКРЫТАЯ ЛАДОНЬ — НАЗАД', 162, y - 34);

    ctx.letterSpacing = '0px';
    ctx.restore();
  }
}
