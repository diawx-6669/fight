import { clamp, TAU } from '@/core/math';
import { getCharacter } from '@/game/characters';
import type { RoundResult } from '@/game/match';
import type { GameMode } from '@/game/world';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '@/render/renderer';
import { alpha, Ease, font, Palette, TypeScale } from '@/render/theme';
import { MenuBackdrop } from '../backdrop';
import { Screen, type ScreenContext, type ScreenParams } from '../screen';
import { button, chamferedRect, panel, type Rect } from '../widgets';

/**
 * Results.
 *
 * The screen a player sees most often, and the one most games treat as an
 * afterthought. Two jobs: say clearly who won, and give the player a reason to
 * press the button again within four seconds.
 *
 * The round-by-round breakdown does the second job. "You lost 2-1 and the last
 * round was 8% health" is a completely different feeling from "you lost", and
 * it is the difference between quitting and rematching.
 */

interface ResultParams extends ScreenParams {
  mode: GameMode;
  winner: 'p1' | 'p2' | 'draw' | 'timeout';
  stage: number;
  playerCharacter: string;
  opponentCharacter: string;
  rounds: RoundResult[];
}

export class ResultsScreen extends Screen {
  readonly id = 'results' as const;
  readonly visionMode = 'hands' as const;

  private readonly backdrop = new MenuBackdrop(40);
  private params: ResultParams | null = null;
  private playerWon = false;

  /** Counts up the stat numbers, because a number that counts is read. */
  private countUp = 0;

  constructor(context: ScreenContext) {
    super(context);
  }

  enter(params?: ScreenParams): void {
    super.enter();
    this.params = (params as ResultParams) ?? null;
    this.playerWon = this.params?.winner === 'p1';
    this.countUp = 0;
    this.backdrop.accent = this.playerWon ? Palette.gold : Palette.rose;
  }

  update(dt: number): void {
    super.update(dt);
    this.backdrop.update(dt);
    this.countUp = clamp(this.countUp + dt * 0.9, 0, 1);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    this.backdrop.draw(ctx);
    if (!this.params) return;

    this.drawVerdict(ctx);
    this.drawMatchup(ctx);
    this.drawRounds(ctx);
    this.drawStats(ctx);
    this.drawControls(ctx);
  }

  private drawVerdict(ctx: CanvasRenderingContext2D): void {
    const t = Ease.out(clamp(this.elapsed / 0.5, 0, 1));
    const label = this.params?.winner === 'draw' ? 'НИЧЬЯ' : this.playerWon ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ';
    const color = this.params?.winner === 'draw' ? Palette.ash200 : this.playerWon ? Palette.gold : Palette.rose;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(DESIGN_WIDTH / 2, 178);
    // A slight horizontal squeeze on arrival, released as it settles.
    ctx.scale(1 + (1 - t) * 0.18, 1 - (1 - t) * 0.1);
    ctx.globalAlpha = t;

    font(ctx, 132, 'display');
    ctx.lineWidth = 12;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 50 * t;
    ctx.fillText(label, 0, 0);
    ctx.restore();

    // A ring that expands out from the word, once.
    if (this.elapsed < 1) {
      const ringT = Ease.out(clamp(this.elapsed / 0.9, 0, 1));
      ctx.save();
      ctx.globalAlpha = (1 - ringT) * 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = 4 * (1 - ringT) + 1;
      ctx.beginPath();
      ctx.ellipse(DESIGN_WIDTH / 2, 178, 260 + ringT * 520, 90 + ringT * 180, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawMatchup(ctx: CanvasRenderingContext2D): void {
    const params = this.params;
    if (!params) return;

    const player = getCharacter(params.playerCharacter);
    const opponent = getCharacter(params.opponentCharacter);
    const y = 300;

    ctx.save();
    ctx.textBaseline = 'middle';

    ctx.textAlign = 'right';
    font(ctx, 54, 'display');
    ctx.fillStyle = this.playerWon ? Palette.white : Palette.ash400;
    ctx.fillText(player.name, DESIGN_WIDTH / 2 - 90, y);

    ctx.textAlign = 'left';
    ctx.fillStyle = this.playerWon ? Palette.ash400 : Palette.white;
    ctx.fillText(opponent.name, DESIGN_WIDTH / 2 + 90, y);

    // Score in the middle.
    const p1Wins = params.rounds.filter(
      (r) => r.winner === 'p1' || (r.winner === 'timeout' && r.p1Health > r.p2Health),
    ).length;
    const p2Wins = params.rounds.filter(
      (r) => r.winner === 'p2' || (r.winner === 'timeout' && r.p2Health > r.p1Health),
    ).length;

    ctx.textAlign = 'center';
    font(ctx, 62, 'display');
    ctx.fillStyle = Palette.gold;
    ctx.fillText(`${p1Wins} : ${p2Wins}`, DESIGN_WIDTH / 2, y);
    ctx.restore();
  }

  /** One card per round, showing how much health each side kept. */
  private drawRounds(ctx: CanvasRenderingContext2D): void {
    const rounds = this.params?.rounds ?? [];
    if (rounds.length === 0) return;

    const cardWidth = 250;
    const gap = 20;
    const totalWidth = rounds.length * cardWidth + (rounds.length - 1) * gap;
    const startX = (DESIGN_WIDTH - totalWidth) / 2;
    const y = 372;
    const height = 200;

    for (let i = 0; i < rounds.length; i++) {
      const round = rounds[i];
      const local = clamp((this.elapsed - 0.35 - i * 0.12) / 0.4, 0, 1);
      if (local <= 0) continue;

      const x = startX + i * (cardWidth + gap);
      const playerWonRound =
        round.winner === 'p1' || (round.winner === 'timeout' && round.p1Health > round.p2Health);

      ctx.save();
      ctx.globalAlpha = Ease.out(local);
      ctx.translate(0, (1 - Ease.out(local)) * 26);

      ctx.fillStyle = 'rgba(8, 9, 17, 0.88)';
      chamferedRect(ctx, x, y, cardWidth, height, 16);
      ctx.fill();
      ctx.strokeStyle = playerWonRound ? alpha(Palette.gold, 0.5) : 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      font(ctx, TypeScale.label, 'ui', 700);
      ctx.letterSpacing = '0.2em';
      ctx.fillStyle = Palette.ash400;
      ctx.fillText(`РАУНД ${round.round}`, x + cardWidth / 2, y + 32);
      ctx.letterSpacing = '0px';

      font(ctx, 36, 'display');
      ctx.fillStyle = playerWonRound ? Palette.gold : Palette.rose;
      ctx.fillText(
        round.perfect ? 'ИДЕАЛЬНО' : playerWonRound ? 'ПОБЕДА' : 'ПОРАЖЕНИЕ',
        x + cardWidth / 2,
        y + 72,
      );

      // Two health bars, mirrored — the shape of the round at a glance.
      this.drawRoundBar(ctx, x + 24, y + 110, cardWidth - 48, round.p1Health * local, Palette.ember);
      this.drawRoundBar(ctx, x + 24, y + 140, cardWidth - 48, round.p2Health * local, Palette.frost);

      font(ctx, TypeScale.micro, 'ui', 500);
      ctx.fillStyle = Palette.ash500;
      ctx.fillText(
        `${(round.durationFrames / 60).toFixed(1)} с`,
        x + cardWidth / 2,
        y + height - 22,
      );

      ctx.restore();
    }
  }

  private drawRoundBar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    ratio: number,
    color: string,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(x, y, width, 10);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, width * clamp(ratio, 0, 1), 10);
  }

  private drawStats(ctx: CanvasRenderingContext2D): void {
    const progress = this.context.progress;
    const rect: Rect = { x: (DESIGN_WIDTH - 900) / 2, y: 610, w: 900, h: 130 };
    panel(ctx, rect, 'всего', this.playerWon ? Palette.gold : Palette.rose);

    const entries: [string, number][] = [
      ['ПОБЕД', progress.wins],
      ['ПОРАЖЕНИЙ', progress.losses],
      ['УДАРОВ', progress.totalHits],
      ['ЛУЧШЕЕ КОМБО', progress.bestCombo],
      ['ИДЕАЛЬНЫХ', progress.perfects],
    ];

    const columnWidth = rect.w / entries.length;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < entries.length; i++) {
      const [label, value] = entries[i];
      const x = rect.x + columnWidth * (i + 0.5);

      font(ctx, 42, 'display');
      ctx.fillStyle = Palette.paper;
      ctx.fillText(String(Math.round(value * Ease.out(this.countUp))), x, rect.y + 72);

      font(ctx, TypeScale.micro, 'ui', 700);
      ctx.letterSpacing = '0.16em';
      ctx.fillStyle = Palette.ash500;
      ctx.fillText(label, x, rect.y + 100);
      ctx.letterSpacing = '0px';
    }
    ctx.restore();
  }

  private drawControls(ctx: CanvasRenderingContext2D): void {
    void ctx;
    const params = this.params;
    const y = DESIGN_HEIGHT - 180;
    const width = 340;
    const gap = 20;
    const isArcade = params?.mode === 'arcade';
    const advance = isArcade && this.playerWon;

    const total = width * 3 + gap * 2;
    const startX = (DESIGN_WIDTH - total) / 2;

    if (
      button(this.context.widgets, {
        id: 'results:again',
        rect: { x: startX, y, w: width, h: 84 },
        label: advance ? 'СЛЕДУЮЩИЙ БОЙ' : 'ЕЩЁ РАЗ',
        glyph: 'play',
        primary: true,
        accent: this.playerWon ? Palette.gold : Palette.ember,
      })
    ) {
      this.rematch(advance);
    }

    if (
      button(this.context.widgets, {
        id: 'results:character',
        rect: { x: startX + width + gap, y, w: width, h: 84 },
        label: 'СМЕНИТЬ БОЙЦА',
        glyph: 'user',
        accent: Palette.frost,
      })
    ) {
      this.context.reset('menu');
      this.context.push('character', { mode: params?.mode ?? 'versus' });
    }

    if (
      button(this.context.widgets, {
        id: 'results:menu',
        rect: { x: startX + (width + gap) * 2, y, w: width, h: 84 },
        label: 'В МЕНЮ',
        glyph: 'back',
        accent: Palette.ash300,
      })
    ) {
      this.context.audio.play('back');
      this.context.reset('menu');
    }
  }

  private rematch(advance: boolean): void {
    const params = this.params;
    if (!params) return;

    // On an arcade win the ladder moves on; otherwise the same pairing runs
    // again, which is what a player who just lost a close match wants.
    this.context.replace('fight', {
      mode: params.mode,
      playerCharacter: params.playerCharacter,
      opponentCharacter: advance ? nextOpponent(params) : params.opponentCharacter,
      arenaId: 'dusk-temple',
      stage: advance ? params.stage + 1 : params.stage,
    });
  }
}

function nextOpponent(params: ResultParams): string {
  const pool = ['kai', 'rei', 'grom', 'vega', 'nox', 'umbra'].filter(
    (id) => id !== params.playerCharacter,
  );
  return pool[Math.min(params.stage + 1, pool.length - 1)];
}
