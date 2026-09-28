import { clamp } from '@/core/math';
import type { GameMode } from '@/game/world';
import { DIFFICULTIES, DIFFICULTY_ORDER, type DifficultyId } from '@/game/ai/difficulty';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '@/render/renderer';
import { Ease, font, Palette, TypeScale } from '@/render/theme';
import { MenuBackdrop } from '../backdrop';
import { Screen, type ScreenContext } from '../screen';
import { button, chamferedRect, panel, segmented, type Rect } from '../widgets';

/**
 * Mode select.
 *
 * Four modes, each a card, plus the difficulty picker that applies to all of
 * them. Difficulty lives here rather than in Settings on purpose: it is a
 * choice about *this* match, and burying it two menus deep is how players end
 * up fighting the wrong opponent for an hour and concluding the game is unfair.
 */

interface ModeCard {
  mode: GameMode;
  title: string;
  subtitle: string;
  description: string;
  accent: string;
  /** Requires a second person in front of the camera. */
  needsTwo?: boolean;
}

const MODES: readonly ModeCard[] = [
  {
    mode: 'arcade',
    title: 'АРКАДА',
    subtitle: 'Лестница из шести боёв',
    description:
      'Проходи противников одного за другим. Каждая победа открывает новых бойцов и арены.',
    accent: Palette.ember,
  },
  {
    mode: 'versus',
    title: 'СПАРРИНГ',
    subtitle: 'Один бой против ИИ',
    description: 'Выбери бойца, арену и противника. Быстрый бой без последствий.',
    accent: Palette.frost,
  },
  {
    mode: 'survival',
    title: 'ВЫЖИВАНИЕ',
    subtitle: 'Сколько продержишься',
    description:
      'Бесконечная череда противников. Здоровье восстанавливается лишь частично между боями.',
    accent: Palette.venom,
  },
  {
    mode: 'training',
    title: 'ТРЕНИРОВКА',
    subtitle: 'Без таймера и поражений',
    description:
      'Манекен, который не бьёт в ответ. Показывает, какие удары распознаются и насколько точно.',
    accent: Palette.gold,
  },
];

export class ModeScreen extends Screen {
  readonly id = 'mode' as const;
  readonly visionMode = 'hands' as const;

  private readonly backdrop = new MenuBackdrop(34);
  private selected = 0;

  constructor(context: ScreenContext) {
    super(context);
  }

  enter(): void {
    super.enter();
    this.backdrop.accent = MODES[this.selected].accent;
  }

  update(dt: number): void {
    super.update(dt);
    this.backdrop.update(dt);
    this.backdrop.accent = MODES[this.selected].accent;

    // Open-palm swipes flick between cards, which is much less tiring than
    // pointing at a specific one across the screen.
    const swipe = this.context.vision.gesture.swipe;
    if (swipe === 'left') this.selected = clamp(this.selected + 1, 0, MODES.length - 1);
    else if (swipe === 'right') this.selected = clamp(this.selected - 1, 0, MODES.length - 1);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    this.backdrop.draw(ctx);
    this.drawHeader(ctx);
    this.drawCards(ctx);
    this.drawDetail(ctx);
    this.drawDifficulty(ctx);
    this.drawControls(ctx);
  }

  private drawHeader(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalAlpha = this.appear;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    font(ctx, TypeScale.label, 'ui', 700);
    ctx.letterSpacing = '0.32em';
    ctx.fillStyle = MODES[this.selected].accent;
    ctx.fillText('РЕЖИМ', 128, 96);
    ctx.letterSpacing = '0px';

    font(ctx, TypeScale.title, 'display');
    ctx.fillStyle = Palette.paper;
    ctx.fillText('ВО ЧТО ИГРАЕМ', 128, 148);
    ctx.restore();
  }

  private drawCards(ctx: CanvasRenderingContext2D): void {
    const cardWidth = 372;
    const gap = 24;
    const totalWidth = cardWidth * MODES.length + gap * (MODES.length - 1);
    const startX = (DESIGN_WIDTH - totalWidth) / 2;
    const y = 232;
    const height = 330;

    for (let i = 0; i < MODES.length; i++) {
      const card = MODES[i];
      const delay = i * 0.05;
      const local = clamp((this.elapsed - delay) / 0.36, 0, 1);
      if (local <= 0) continue;

      const selected = i === this.selected;
      const rect: Rect = { x: startX + i * (cardWidth + gap), y, w: cardWidth, h: height };

      ctx.save();
      ctx.globalAlpha = local;
      ctx.translate(0, (1 - Ease.out(local)) * 40);

      const hovered =
        this.context.widgets.pointer.active &&
        this.context.widgets.pointer.x >= rect.x &&
        this.context.widgets.pointer.x <= rect.x + rect.w &&
        this.context.widgets.pointer.y >= rect.y &&
        this.context.widgets.pointer.y <= rect.y + rect.h;

      if (hovered) {
        this.context.widgets.setHover(`mode:${card.mode}`);
        if (this.selected !== i) this.selected = i;
      }

      // Card body.
      const lift = selected ? 10 : 0;
      ctx.translate(0, -lift);

      const gradient = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.h);
      gradient.addColorStop(0, selected ? 'rgba(20, 22, 38, 0.95)' : 'rgba(10, 11, 20, 0.85)');
      gradient.addColorStop(1, 'rgba(5, 5, 11, 0.95)');
      ctx.fillStyle = gradient;
      chamferedRect(ctx, rect.x, rect.y, rect.w, rect.h, 22);
      ctx.fill();

      ctx.strokeStyle = selected ? card.accent : 'rgba(255,255,255,0.08)';
      ctx.lineWidth = selected ? 2.5 : 1.5;
      if (selected) {
        ctx.shadowColor = card.accent;
        ctx.shadowBlur = 28;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      // A large ghosted numeral behind the title — pure decoration that makes
      // the cards feel designed rather than generated.
      ctx.save();
      ctx.globalAlpha = selected ? 0.13 : 0.06;
      font(ctx, 190, 'display');
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = card.accent;
      ctx.fillText(String(i + 1), rect.x + rect.w - 24, rect.y + rect.h - 20);
      ctx.restore();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      font(ctx, 46, 'display');
      ctx.fillStyle = selected ? Palette.white : Palette.ash200;
      ctx.fillText(card.title, rect.x + 30, rect.y + 86);

      font(ctx, TypeScale.label, 'ui', 600);
      ctx.fillStyle = card.accent;
      ctx.fillText(card.subtitle, rect.x + 30, rect.y + 120);

      ctx.fillStyle = Palette.ash400;
      font(ctx, TypeScale.label + 1, 'ui', 500);
      wrapLines(ctx, card.description, rect.x + 30, rect.y + 168, rect.w - 60, 26);

      ctx.restore();
    }
  }

  private drawDetail(ctx: CanvasRenderingContext2D): void {
    const card = MODES[this.selected];
    const rect: Rect = { x: 128, y: 604, w: DESIGN_WIDTH - 256, h: 108 };
    panel(ctx, rect, 'что дальше', card.accent);

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.body, 'ui', 500);
    ctx.fillStyle = Palette.ash300;

    const next =
      card.mode === 'training'
        ? 'Выбери бойца — и сразу на площадку. Таймера и раундов не будет.'
        : card.mode === 'arcade'
          ? 'Выбери бойца. Противников и арены игра подберёт сама.'
          : card.mode === 'survival'
            ? 'Выбери бойца. Дальше — только ты и бесконечная очередь.'
            : 'Выбери бойца, противника и арену.';
    ctx.fillText(next, rect.x + 28, rect.y + 72);
    ctx.restore();
  }

  private drawDifficulty(ctx: CanvasRenderingContext2D): void {
    const settings = this.context.settings;
    const rect: Rect = { x: 128, y: 736, w: DESIGN_WIDTH - 256, h: 92 };

    const chosen = segmented(this.context.widgets, {
      id: 'mode:difficulty',
      rect,
      label: 'СЛОЖНОСТЬ',
      options: DIFFICULTY_ORDER.map((id) => ({ label: DIFFICULTIES[id].label, value: id })),
      value: settings.difficulty,
      accent: MODES[this.selected].accent,
    });

    if (chosen !== settings.difficulty) {
      this.context.applySettings({ ...settings, difficulty: chosen as DifficultyId });
    }

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.label, 'ui', 500);
    ctx.fillStyle = Palette.ash400;
    ctx.fillText(DIFFICULTIES[settings.difficulty].description, rect.x, rect.y + rect.h + 24);
    ctx.restore();
  }

  private drawControls(ctx: CanvasRenderingContext2D): void {
    void ctx;
    const y = DESIGN_HEIGHT - 128;

    if (
      button(this.context.widgets, {
        id: 'mode:back',
        rect: { x: 128, y, w: 220, h: 78 },
        label: 'НАЗАД',
        glyph: 'back',
        accent: Palette.ash400,
      })
    ) {
      this.context.audio.play('back');
      this.context.pop();
    }

    if (
      button(this.context.widgets, {
        id: 'mode:next',
        rect: { x: DESIGN_WIDTH - 128 - 340, y, w: 340, h: 78 },
        label: 'ВЫБРАТЬ БОЙЦА',
        glyph: 'play',
        primary: true,
        accent: MODES[this.selected].accent,
      })
    ) {
      this.context.push('character', { mode: MODES[this.selected].mode });
    }
  }
}

/** Left-aligned word wrap for card descriptions. */
export function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines = 6,
): number {
  const words = text.split(' ');
  let line = '';
  let lines = 0;

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      ctx.fillText(line, x, y + lines * lineHeight);
      lines++;
      if (lines >= maxLines) return lines;
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line && lines < maxLines) {
    ctx.fillText(line, x, y + lines * lineHeight);
    lines++;
  }
  return lines;
}
