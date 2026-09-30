import { clamp } from '@/core/math';
import { CHARACTERS } from '@/game/characters';
import { levelFromXp } from '@/game/economy';
import { forMode, modeLabel, modeUnit } from '@/game/records';
import { rarityOf, RARITY_COLOR, RARITY_LABEL } from '@/game/cases';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '@/render/renderer';
import { alpha, font, mix, Palette, Semantic, TypeScale } from '@/render/theme';
import { MenuBackdrop } from '../backdrop';
import { Screen, type ScreenContext } from '../screen';
import { button, panel, sectionTitle } from '../widgets';

/**
 * Таблица рекордов и профиль игрока.
 *
 * Рекорды здесь свои, а не чужие, и это осознанное решение. Без сервера
 * «рейтинг» пришлось бы населить выдуманными именами с выдуманными числами —
 * и человек соревновался бы с декорацией. Собственные пять лучших результатов
 * на режим — меньше по замаху и полностью честно: каждая строка когда-то
 * действительно случилась.
 *
 * Строки хранятся вместе с режимом и не складываются в одну колонку: ступень
 * аркады, длина серии в выживании и лучшее комбо — разные величины, и общий
 * «счёт» из них был бы числом без смысла.
 */

const MODES = ['arcade', 'survival', 'versus', 'online'] as const;

export class RecordsScreen extends Screen {
  readonly id = 'records' as const;
  override readonly visionMode = 'hands' as const;

  private readonly backdrop = new MenuBackdrop();

  constructor(context: ScreenContext) {
    super(context);
  }

  enter(): void {
    super.enter();
    this.backdrop.accent = Palette.frost;
    this.context.audio.setMusicIntensity(0.1);
  }

  update(dt: number): void {
    super.update(dt);
    this.backdrop.update(dt);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    this.backdrop.draw(ctx);
    sectionTitle(ctx, 120, 120, 620, 'РЕКОРДЫ', Palette.frost);

    this.drawProfile(ctx, { x: 120, y: 210, w: 620, h: 420 });
    this.drawRoster(ctx, { x: 120, y: 656, w: 620, h: 268 });
    this.drawTable(ctx, { x: 790, y: 210, w: DESIGN_WIDTH - 910, h: 750 });

    if (
      button(this.context.widgets, {
        id: 'records-back',
        rect: { x: 120, y: DESIGN_HEIGHT - 120, w: 260, h: 78 },
        label: 'НАЗАД',
        glyph: 'back',
        align: 'center',
      })
    ) {
      this.context.audio.play('back');
      this.context.pop();
    }
  }

  private drawProfile(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; w: number; h: number }): void {
    const progress = this.context.progress;
    const level = levelFromXp(progress.xp);

    panel(ctx, rect, 'ПРОФИЛЬ', Palette.frost);

    ctx.save();
    ctx.textAlign = 'left';

    ctx.fillStyle = Palette.paper;
    font(ctx, 72, 'display', 700);
    ctx.fillText(`${level.level}`, rect.x + 40, rect.y + 140);

    ctx.fillStyle = Palette.ash500;
    font(ctx, TypeScale.label, 'ui', 600);
    ctx.fillText('УРОВЕНЬ', rect.x + 40, rect.y + 168);

    // Полоса опыта: число без полосы не показывает, насколько близко следующий.
    const barX = rect.x + 200;
    const barW = rect.w - 240;
    const barY = rect.y + 120;
    ctx.fillStyle = alpha(Palette.frost, 0.16);
    ctx.fillRect(barX, barY, barW, 18);
    ctx.fillStyle = Palette.frost;
    ctx.fillRect(barX, barY, barW * clamp(level.ratio, 0, 1), 18);

    ctx.fillStyle = Palette.ash500;
    font(ctx, TypeScale.micro, 'ui', 500);
    ctx.fillText(
      level.needed > 0 ? `${level.into} / ${level.needed} опыта` : 'максимальный уровень',
      barX,
      barY + 40,
    );

    const stats: [string, string][] = [
      ['Монет', `${progress.coins}`],
      ['Побед', `${progress.wins}`],
      ['Поражений', `${progress.losses}`],
      ['Кейсов открыто', `${progress.casesOpened}`],
      ['Лучшее комбо', `${progress.bestCombo}`],
      ['Чистых раундов', `${progress.perfects}`],
    ];

    let y = rect.y + 232;
    for (const [label, value] of stats) {
      ctx.fillStyle = Palette.ash500;
      font(ctx, TypeScale.body, 'ui', 500);
      ctx.textAlign = 'left';
      ctx.fillText(label, rect.x + 40, y);

      ctx.fillStyle = Palette.paper;
      font(ctx, TypeScale.body, 'ui', 700);
      ctx.textAlign = 'right';
      ctx.fillText(value, rect.x + rect.w - 40, y);
      y += 30;
    }
    ctx.restore();
  }

  private drawRoster(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; w: number; h: number }): void {
    const owned = this.context.progress.owned;
    panel(ctx, rect, `БОЙЦЫ · ${owned.length} ИЗ ${CHARACTERS.length}`, Palette.gold);

    ctx.save();
    let y = rect.y + 76;
    for (const character of CHARACTERS) {
      const has = owned.includes(character.id);
      const rarity = rarityOf(character.id);
      const color = RARITY_COLOR[rarity];

      ctx.fillStyle = has ? color : alpha(Palette.ash500, 0.5);
      ctx.fillRect(rect.x + 36, y - 12, 5, 18);

      ctx.textAlign = 'left';
      ctx.fillStyle = has ? Palette.paper : Palette.ash500;
      font(ctx, TypeScale.body, 'ui', 700);
      ctx.fillText(has ? character.name : '? ? ?', rect.x + 56, y);

      ctx.textAlign = 'right';
      ctx.fillStyle = alpha(color, has ? 0.9 : 0.4);
      font(ctx, TypeScale.micro, 'ui', 700);
      ctx.fillText(RARITY_LABEL[rarity], rect.x + rect.w - 36, y);
      y += 34;
    }
    ctx.restore();
  }

  private drawTable(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; w: number; h: number }): void {
    panel(ctx, rect, 'ЛУЧШИЕ РЕЗУЛЬТАТЫ', Palette.frost);

    ctx.save();
    let y = rect.y + 76;
    let any = false;

    for (const mode of MODES) {
      const rows = forMode(this.context.progress.records, mode);
      if (rows.length === 0) continue;
      any = true;

      ctx.textAlign = 'left';
      ctx.fillStyle = Palette.gold;
      font(ctx, TypeScale.label, 'ui', 700);
      ctx.fillText(modeLabel(mode), rect.x + 36, y);

      ctx.textAlign = 'right';
      ctx.fillStyle = Palette.ash500;
      font(ctx, TypeScale.micro, 'ui', 500);
      ctx.fillText(modeUnit(mode), rect.x + rect.w - 36, y);
      y += 14;

      ctx.fillStyle = alpha(Palette.frost, 0.25);
      ctx.fillRect(rect.x + 36, y, rect.w - 72, 2);
      y += 30;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const character = CHARACTERS.find((c) => c.id === row.character);
        // Первая строка ярче остальных: рекорд — это одна строка, а не пять.
        const tone = i === 0 ? Palette.paper : mix(Palette.ash300, Palette.ash500, 0.5);

        ctx.textAlign = 'left';
        ctx.fillStyle = i === 0 ? Semantic.health : Palette.ash500;
        font(ctx, TypeScale.micro, 'ui', 700);
        ctx.fillText(`${i + 1}`, rect.x + 36, y);

        ctx.fillStyle = tone;
        font(ctx, TypeScale.body, 'ui', i === 0 ? 700 : 500);
        ctx.fillText(character?.name ?? row.character, rect.x + 70, y);

        ctx.fillStyle = Palette.ash500;
        font(ctx, TypeScale.micro, 'ui', 500);
        ctx.fillText(formatDate(row.at), rect.x + 260, y);

        ctx.textAlign = 'right';
        ctx.fillStyle = tone;
        font(ctx, 26, 'display', 700);
        ctx.fillText(`${row.score}`, rect.x + rect.w - 36, y + 2);
        y += 34;
      }
      y += 26;
    }

    if (!any) {
      ctx.textAlign = 'center';
      ctx.fillStyle = Palette.ash500;
      font(ctx, TypeScale.body, 'ui', 500);
      ctx.fillText('Пока пусто — проведи бой', rect.x + rect.w / 2, rect.y + rect.h / 2);
    }
    ctx.restore();
  }
}

function formatDate(at: number): string {
  const date = new Date(at);
  const day = `${date.getDate()}`.padStart(2, '0');
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  return `${day}.${month}`;
}
