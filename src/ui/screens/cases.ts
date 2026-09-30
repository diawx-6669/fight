import { clamp } from '@/core/math';
import { CHARACTERS } from '@/game/characters';
import {
  CASES, DUPLICATE_REFUND, openCase, RARITY_COLOR, RARITY_LABEL, rarityOf,
  type CaseDefinition, type CaseDrop, type Rarity,
} from '@/game/cases';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '@/render/renderer';
import { alpha, Ease, font, mix, Palette, TypeScale } from '@/render/theme';
import { MenuBackdrop } from '../backdrop';
import { Screen, type ScreenContext } from '../screen';
import { button, chamferedRect, panel, sectionTitle } from '../widgets';

/**
 * Экран кейсов.
 *
 * Здесь два состояния и больше никаких: витрина и открытие. Разделены они не
 * ради простоты кода, а потому что это разные моменты — в одном человек
 * считает деньги, в другом смотрит, что выпало, и между ними не должно быть
 * ничего, что отвлекает.
 *
 * Шансы напечатаны на каждом кейсе до покупки. Это главное решение всего
 * экрана: скрытая вероятность — то, чем кейсы заслужили дурную славу, а
 * прятать её здесь не от кого. Валюта зарабатывается боями, продажи нет, и
 * единственное, что даёт сокрытие шансов, — ощущение обмана.
 */

type Phase = 'shop' | 'opening' | 'revealed';

/** Сколько длится прокрутка перед тем, как показать бойца. */
const SPIN_SECONDS = 2.1;

export class CasesScreen extends Screen {
  readonly id = 'cases' as const;
  override readonly visionMode = 'hands' as const;

  private readonly backdrop = new MenuBackdrop();

  private phase: Phase = 'shop';
  private drop: CaseDrop | null = null;
  private opened: CaseDefinition | null = null;
  private spin = 0;
  private spinStartedAt = 0;

  /** Лента лиц, крутящаяся при открытии. Строится один раз на открытие. */
  private reel: string[] = [];

  constructor(context: ScreenContext) {
    super(context);
  }

  enter(): void {
    super.enter();
    this.phase = 'shop';
    this.drop = null;
    this.backdrop.accent = Palette.gold;
    this.context.audio.setMusicIntensity(0.12);
  }

  update(dt: number): void {
    super.update(dt);
    this.backdrop.update(dt);

    if (this.phase === 'opening') {
      // Настенные часы, а не дельта кадра.
      //
      // Приложение ограничивает dt сверху, чтобы одна задержка не заставила
      // симуляцию прыгнуть, — для боя это правильно. Но анимация, построенная
      // на ограниченной дельте, на медленной машине идёт в замедленной съёмке:
      // при восьми кадрах в секунду барабан крутится вдвое дольше, чем должен,
      // и это читается как зависание ровно в тот момент, когда человек ждёт
      // результата.
      this.spin = (performance.now() - this.spinStartedAt) / 1000;
      if (this.spin >= SPIN_SECONDS) {
        this.phase = 'revealed';
        this.context.audio.play(this.drop?.duplicate ? 'click' : 'victory');
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    this.backdrop.draw(ctx);
    if (this.phase === 'shop') this.drawShop(ctx);
    else this.drawOpening(ctx);
  }

  // --- витрина ---------------------------------------------------------------

  private drawShop(ctx: CanvasRenderingContext2D): void {
    const { context } = this;
    const progress = context.progress;

    sectionTitle(ctx, 120, 120, 620, 'КЕЙСЫ', Palette.gold);
    this.drawWallet(ctx, DESIGN_WIDTH - 120, 128);

    const width = 460;
    const height = 560;
    const gap = 40;
    const totalWidth = CASES.length * width + (CASES.length - 1) * gap;
    const startX = (DESIGN_WIDTH - totalWidth) / 2;
    const y = 290;

    for (let i = 0; i < CASES.length; i++) {
      const definition = CASES[i];
      const x = startX + i * (width + gap);
      this.drawCase(ctx, definition, { x, y, w: width, h: height }, progress.coins);
    }

    if (
      button(context.widgets, {
        id: 'cases-back',
        rect: { x: 120, y: DESIGN_HEIGHT - 150, w: 260, h: 78 },
        label: 'НАЗАД',
        glyph: 'back',
        align: 'center',
      })
    ) {
      context.audio.play('back');
      context.pop();
    }
  }

  private drawWallet(ctx: CanvasRenderingContext2D, right: number, y: number): void {
    const progress = this.context.progress;
    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = Palette.gold;
    font(ctx, 44, 'display', 700);
    ctx.fillText(`${progress.coins}`, right, y);
    ctx.fillStyle = Palette.ash500;
    font(ctx, TypeScale.label, 'ui', 600);
    ctx.fillText('МОНЕТ', right, y + 28);
    ctx.restore();
  }

  private drawCase(
    ctx: CanvasRenderingContext2D,
    definition: CaseDefinition,
    rect: { x: number; y: number; w: number; h: number },
    coins: number,
  ): void {
    const affordable = coins >= definition.price;
    panel(ctx, rect, undefined, affordable ? Palette.gold : Palette.ash500);

    ctx.save();
    ctx.textAlign = 'center';
    const centre = rect.x + rect.w / 2;

    ctx.fillStyle = affordable ? Palette.paper : Palette.ash500;
    font(ctx, 38, 'display', 700);
    ctx.fillText(definition.name, centre, rect.y + 72);

    ctx.fillStyle = Palette.ash500;
    font(ctx, TypeScale.body, 'ui', 500);
    ctx.fillText(definition.subtitle, centre, rect.y + 106);

    // Таблица шансов — самое важное на карточке, поэтому она в середине, а не
    // мелким шрифтом внизу.
    let rowY = rect.y + 176;
    for (const rarity of ['legendary', 'rare', 'common'] as Rarity[]) {
      const odds = definition.odds[rarity];
      if (odds <= 0) continue;

      const color = RARITY_COLOR[rarity];
      ctx.textAlign = 'left';
      ctx.fillStyle = alpha(color, 0.9);
      font(ctx, TypeScale.label, 'ui', 700);
      ctx.fillText(RARITY_LABEL[rarity], rect.x + 40, rowY);

      ctx.textAlign = 'right';
      ctx.fillStyle = Palette.paper;
      ctx.fillText(`${(odds * 100).toFixed(odds < 0.1 ? 1 : 0)}%`, rect.x + rect.w - 40, rowY);

      // Полоска под строкой: процент читается глазом раньше, чем цифрой.
      ctx.fillStyle = alpha(color, 0.18);
      ctx.fillRect(rect.x + 40, rowY + 10, rect.w - 80, 5);
      ctx.fillStyle = alpha(color, 0.75);
      ctx.fillRect(rect.x + 40, rowY + 10, (rect.w - 80) * odds, 5);

      rowY += 56;
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = Palette.ash500;
    font(ctx, TypeScale.micro, 'ui', 500);
    ctx.fillText('дубликат вернёт монеты', centre, rect.y + rect.h - 136);
    ctx.restore();

    const label = `ОТКРЫТЬ · ${definition.price}`;
    if (
      button(this.context.widgets, {
        id: `case-${definition.id}`,
        rect: { x: rect.x + 40, y: rect.y + rect.h - 108, w: rect.w - 80, h: 76 },
        label,
        align: 'center',
        primary: affordable,
        disabled: !affordable,
        accent: Palette.gold,
      })
    ) {
      this.buy(definition);
    }
  }

  private buy(definition: CaseDefinition): void {
    const { context } = this;
    const progress = context.progress;
    if (progress.coins < definition.price) return;

    // Исход решается здесь, до анимации. Барабан потом показывает уже
    // случившееся — крутить его и решать в конце значило бы, что показанное
    // движение ничего не значит.
    const drop = openCase(definition, progress.owned, (Math.random() * 0x7fffffff) | 0);

    const owned = drop.duplicate ? progress.owned : [...progress.owned, drop.characterId];
    context.saveProgress({
      ...progress,
      coins: progress.coins - definition.price + drop.refund,
      owned,
      casesOpened: progress.casesOpened + 1,
    });

    this.drop = drop;
    this.opened = definition;
    this.phase = 'opening';
    this.spin = 0;
    this.spinStartedAt = performance.now();
    this.reel = buildReel(drop.characterId);
    context.audio.play('click');
  }

  // --- открытие --------------------------------------------------------------

  private drawOpening(ctx: CanvasRenderingContext2D): void {
    const drop = this.drop;
    if (!drop) return;

    const character = CHARACTERS.find((c) => c.id === drop.characterId);
    const color = RARITY_COLOR[drop.rarity];
    const done = this.phase === 'revealed';

    ctx.save();
    ctx.textAlign = 'center';

    ctx.fillStyle = Palette.ash500;
    font(ctx, TypeScale.label, 'ui', 600);
    ctx.fillText(this.opened?.name ?? '', DESIGN_WIDTH / 2, 190);

    const centreY = DESIGN_HEIGHT / 2 - 40;

    if (!done) {
      this.drawReel(ctx, centreY);
    } else {
      // Свечение за бойцом — единственное место, где редкость видно раньше,
      // чем прочитано слово.
      const glow = ctx.createRadialGradient(DESIGN_WIDTH / 2, centreY, 10, DESIGN_WIDTH / 2, centreY, 340);
      glow.addColorStop(0, alpha(color, 0.5));
      glow.addColorStop(1, alpha(color, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(DESIGN_WIDTH / 2 - 360, centreY - 360, 720, 720);

      ctx.fillStyle = color;
      font(ctx, TypeScale.label, 'ui', 700);
      ctx.fillText(RARITY_LABEL[drop.rarity], DESIGN_WIDTH / 2, centreY - 120);

      ctx.fillStyle = Palette.paper;
      font(ctx, 88, 'display', 700);
      ctx.fillText(character?.name ?? '', DESIGN_WIDTH / 2, centreY + 10);

      ctx.fillStyle = Palette.ash300;
      font(ctx, TypeScale.body, 'ui', 500);
      ctx.fillText(character?.tagline ?? '', DESIGN_WIDTH / 2, centreY + 60);

      if (drop.duplicate) {
        ctx.fillStyle = Palette.gold;
        font(ctx, 30, 'display', 700);
        ctx.fillText(`УЖЕ ЕСТЬ · +${drop.refund} МОНЕТ`, DESIGN_WIDTH / 2, centreY + 140);
      } else {
        ctx.fillStyle = Palette.venom;
        font(ctx, 30, 'display', 700);
        ctx.fillText('НОВЫЙ БОЕЦ', DESIGN_WIDTH / 2, centreY + 140);
      }
    }
    ctx.restore();

    if (!done) return;

    const y = DESIGN_HEIGHT - 190;
    if (
      button(this.context.widgets, {
        id: 'case-again',
        rect: { x: DESIGN_WIDTH / 2 - 340, y, w: 320, h: 82 },
        label: 'ЕЩЁ РАЗ',
        align: 'center',
        primary: true,
        accent: Palette.gold,
      })
    ) {
      this.phase = 'shop';
      this.context.audio.play('click');
    }

    if (
      button(this.context.widgets, {
        id: 'case-done',
        rect: { x: DESIGN_WIDTH / 2 + 20, y, w: 320, h: 82 },
        label: 'ХВАТИТ',
        align: 'center',
      })
    ) {
      this.context.audio.play('back');
      this.context.pop();
    }
  }

  /**
   * Барабан.
   *
   * Замедляется по кубической кривой и останавливается ровно на выпавшем
   * бойце. Замедление — единственное, что отличает ожидание от задержки:
   * равномерная прокрутка той же длины читается как «игра думает».
   */
  private drawReel(ctx: CanvasRenderingContext2D, centreY: number): void {
    const t = clamp(this.spin / SPIN_SECONDS, 0, 1);
    const eased = Ease.out(t);

    const cell = 260;
    const stopIndex = this.reel.length - 3;
    const offset = eased * stopIndex * cell;

    ctx.save();
    ctx.beginPath();
    ctx.rect(DESIGN_WIDTH / 2 - 560, centreY - 130, 1120, 260);
    ctx.clip();

    for (let i = 0; i < this.reel.length; i++) {
      const x = DESIGN_WIDTH / 2 + i * cell - offset;
      if (x < DESIGN_WIDTH / 2 - 700 || x > DESIGN_WIDTH / 2 + 700) continue;

      const id = this.reel[i];
      const character = CHARACTERS.find((c) => c.id === id);
      const color = RARITY_COLOR[rarityOf(id)];
      const distance = Math.abs(x - DESIGN_WIDTH / 2) / 560;
      const fade = clamp(1 - distance, 0.1, 1);

      ctx.globalAlpha = fade;
      ctx.fillStyle = alpha(color, 0.16);
      chamferedRect(ctx, x - 110, centreY - 110, 220, 220, 14);
      ctx.fill();
      ctx.strokeStyle = alpha(color, 0.7);
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.fillStyle = Palette.paper;
      font(ctx, 30, 'display', 700);
      ctx.fillText(character?.name ?? '', x, centreY + 12);
    }
    ctx.restore();

    // Метка по центру: без неё непонятно, где барабан остановится.
    ctx.save();
    ctx.fillStyle = mix(Palette.gold, Palette.white, 0.3);
    ctx.fillRect(DESIGN_WIDTH / 2 - 2, centreY - 150, 4, 30);
    ctx.fillRect(DESIGN_WIDTH / 2 - 2, centreY + 120, 4, 30);
    ctx.restore();
  }
}

/**
 * Лента для барабана: случайные лица, а на предпоследнем месте — выпавший.
 *
 * Предпоследнем, а не последнем, чтобы за ним оставалось ещё одно лицо:
 * барабан, останавливающийся на самом краю ленты, выглядит как обрыв.
 */
function buildReel(winner: string): string[] {
  const reel: string[] = [];
  for (let i = 0; i < 24; i++) {
    reel.push(CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)].id);
  }
  reel[reel.length - 3] = winner;
  return reel;
}

void DUPLICATE_REFUND;
