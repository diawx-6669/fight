import { DESIGN_HEIGHT, DESIGN_WIDTH } from '@/render/renderer';
import { font, Palette, TypeScale } from '@/render/theme';
import { MenuBackdrop } from '../backdrop';
import { Screen, type ScreenContext, type ScreenParams } from '../screen';
import { button, panel, type Rect } from '../widgets';

/**
 * The error screen.
 *
 * Reached when something has gone wrong that the player can plausibly fix:
 * camera permission denied, models failed to download, browser too old. Every
 * message here pairs *what happened* with *what to do about it*, because a
 * camera game that says only "NotAllowedError" has effectively ended for that
 * player.
 */

interface ErrorParams extends ScreenParams {
  title: string;
  hint: string;
  /** Extra technical detail, shown small. */
  detail?: string;
  /** Whether retrying is worth offering. */
  recoverable?: boolean;
}

export class ErrorScreen extends Screen {
  readonly id = 'error' as const;
  // No camera on this screen: whatever went wrong, asking for it again
  // immediately is not going to help.
  readonly visionMode = 'off' as const;

  private readonly backdrop = new MenuBackdrop(18);
  private params: ErrorParams = {
    title: 'Что-то пошло не так',
    hint: 'Попробуй обновить страницу.',
    recoverable: true,
  };

  constructor(context: ScreenContext) {
    super(context);
  }

  enter(params?: ScreenParams): void {
    super.enter();
    this.backdrop.accent = Palette.rose;
    if (params) this.params = { ...this.params, ...(params as ErrorParams) };
  }

  update(dt: number): void {
    super.update(dt);
    this.backdrop.update(dt);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    this.backdrop.draw(ctx);

    const width = 900;
    const height = 480;
    const rect: Rect = {
      x: (DESIGN_WIDTH - width) / 2,
      y: (DESIGN_HEIGHT - height) / 2,
      w: width,
      h: height,
    };

    panel(ctx, rect, 'ошибка', Palette.rose);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // A broken-glyph mark rather than a generic warning triangle: it belongs to
    // this game's visual language, which matters even on the failure path.
    const markY = rect.y + 110;
    ctx.save();
    ctx.translate(DESIGN_WIDTH / 2, markY);
    ctx.strokeStyle = Palette.rose;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -34);
    ctx.lineTo(24, -10);
    ctx.lineTo(14, 8);
    ctx.moveTo(24, 18);
    ctx.lineTo(0, 36);
    ctx.lineTo(-26, 18);
    ctx.lineTo(-14, 8);
    ctx.lineTo(-24, -10);
    ctx.stroke();
    ctx.restore();

    font(ctx, TypeScale.title, 'display');
    ctx.fillStyle = Palette.paper;
    ctx.fillText(this.params.title, DESIGN_WIDTH / 2, rect.y + 200);

    font(ctx, TypeScale.body, 'ui', 500);
    ctx.fillStyle = Palette.ash300;
    wrapCentred(ctx, this.params.hint, DESIGN_WIDTH / 2, rect.y + 252, width - 160, 30);

    if (this.params.detail) {
      font(ctx, TypeScale.micro, 'ui', 500);
      ctx.fillStyle = Palette.ash500;
      wrapCentred(ctx, this.params.detail, DESIGN_WIDTH / 2, rect.y + 340, width - 160, 20);
    }

    ctx.restore();

    const buttonY = rect.y + height - 60;
    const half = (width - 104 - 20) / 2;

    if (
      button(this.context.widgets, {
        id: 'error:reload',
        rect: { x: rect.x + 52, y: buttonY, w: half, h: 82 },
        label: 'ОБНОВИТЬ СТРАНИЦУ',
        primary: true,
        accent: Palette.rose,
      })
    ) {
      location.reload();
    }

    if (
      button(this.context.widgets, {
        id: 'error:menu',
        rect: { x: rect.x + 52 + half + 20, y: buttonY, w: half, h: 82 },
        label: 'В МЕНЮ',
        glyph: 'back',
        accent: Palette.ash300,
        disabled: this.params.recoverable === false,
      })
    ) {
      this.context.reset('menu');
    }
  }
}

function wrapCentred(
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
