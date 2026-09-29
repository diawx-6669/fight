import { clamp, damp, lerp, TAU } from '@/core/math';
import type { Fighter } from '@/game/fighter';
import type { Match } from '@/game/match';
import { CRITICAL_HEALTH_RATIO } from '@/game/constants';
import { DESIGN_WIDTH } from './renderer';
import { alpha, Ease, font, mix, Palette, Semantic, TypeScale } from './theme';

/**
 * Above this many rounds the win pips stop being information and become
 * noise. Endless modes ask for a win count they can never reach, and one pip
 * per win would paper the top of the screen with circles.
 */
const MAX_DRAWN_PIPS = 7;

/**
 * The heads-up display.
 *
 * A fighting-game HUD has one job: tell the player, without them looking away
 * from the middle of the screen, how close each fighter is to losing. Anything
 * that does not serve that is decoration and has to earn its pixels.
 *
 * Two details here are load-bearing rather than cosmetic:
 *
 * **The lag bar.** Damage is drawn twice — the real bar snaps down instantly,
 * and a second bar behind it drains towards the new value over half a second.
 * The gap between them is how the player *sees* how much a combo cost them.
 * Without it, a 300-damage combo and a 60-damage jab look identical.
 *
 * **Critical pulse.** Below a quarter health the bar breathes. Peripheral
 * vision is very good at motion and very bad at colour, so a pulse reaches a
 * player who is concentrating on the fight in a way that turning the bar red
 * never will.
 */

interface BarState {
  /** The trailing bar, chasing the true value. */
  lag: number;
  /** Set when damage lands, to flash the bar. */
  flash: number;
}

export class Hud {
  private readonly bars: [BarState, BarState] = [
    { lag: 1, flash: 0 },
    { lag: 1, flash: 0 },
  ];

  private time = 0;

  /** Combo counters, one per fighter, with their own pop animation. */
  private readonly combos: [{ hits: number; age: number }, { hits: number; age: number }] = [
    { hits: 0, age: 99 },
    { hits: 0, age: 99 },
  ];

  /** Announcement banner: "ROUND 1", "FIGHT", "K.O.". */
  private announcement = '';
  private announcementAge = 99;
  private announcementLife = 1.4;
  private announcementColor: string = Palette.paper;

  announce(text: string, color: string = Palette.paper, life = 1.4): void {
    this.announcement = text;
    this.announcementAge = 0;
    this.announcementLife = life;
    this.announcementColor = color;
  }

  update(fighters: readonly [Fighter, Fighter], dt: number): void {
    this.time += dt;
    this.announcementAge += dt;

    for (let i = 0; i < 2; i++) {
      const fighter = fighters[i];
      const bar = this.bars[i];
      const ratio = fighter.healthRatio;

      if (ratio < bar.lag - 0.0001) {
        // Hold briefly, then drain — the hold is what makes the gap readable.
        bar.flash = Math.min(1, bar.flash + dt * 6);
        bar.lag = damp(bar.lag, ratio, 0.16, dt);
      } else {
        bar.lag = ratio;
        bar.flash = Math.max(0, bar.flash - dt * 2.4);
      }

      const combo = this.combos[i];
      if (fighter.comboHits > combo.hits) {
        combo.hits = fighter.comboHits;
        combo.age = 0;
      } else if (fighter.comboHits === 0) {
        combo.age += dt;
        if (combo.age > 1.2) combo.hits = 0;
      } else {
        combo.age += dt;
      }
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    fighters: readonly [Fighter, Fighter],
    match: Match,
    options: { showTimer?: boolean; opacity?: number } = {},
  ): void {
    const opacity = options.opacity ?? 1;
    if (opacity <= 0.01) return;

    ctx.save();
    ctx.globalAlpha = opacity;

    this.drawFighterPanel(ctx, fighters[0], match, 0);
    this.drawFighterPanel(ctx, fighters[1], match, 1);

    if (options.showTimer !== false) this.drawTimer(ctx, match);

    this.drawCombo(ctx, fighters[0], 0);
    this.drawCombo(ctx, fighters[1], 1);
    this.drawAnnouncement(ctx);

    ctx.restore();
  }

  // --- panels ---------------------------------------------------------------

  private drawFighterPanel(
    ctx: CanvasRenderingContext2D,
    fighter: Fighter,
    match: Match,
    slot: 0 | 1,
  ): void {
    const mirrored = slot === 1;
    const margin = 64;
    const width = 660;
    const height = 26;
    const x = mirrored ? DESIGN_WIDTH - margin - width : margin;
    const y = 58;

    const bar = this.bars[slot];
    const ratio = fighter.healthRatio;
    const critical = ratio <= CRITICAL_HEALTH_RATIO;

    ctx.save();

    // Name and character, outside the bar so it never covers the fill.
    ctx.textAlign = mirrored ? 'right' : 'left';
    ctx.textBaseline = 'alphabetic';
    font(ctx, TypeScale.subheading, 'display');
    ctx.fillStyle = Palette.paper;
    const labelX = mirrored ? x + width : x;
    ctx.fillText(fighter.character.name, labelX, y - 14);

    // Round pips.
    this.drawRoundPips(ctx, match, slot, mirrored ? x + width : x, y - 40, mirrored);

    // Track.
    this.drawBarFrame(ctx, x, y, width, height);

    // Lag bar: what you *had* a moment ago.
    if (bar.lag > ratio + 0.001) {
      const lagWidth = width * bar.lag;
      const lagX = mirrored ? x + width - lagWidth : x;
      // Bright enough to read at a glance; this segment is the damage report.
      ctx.fillStyle = mix(Palette.blood, Palette.rose, 0.35 + bar.flash * 0.5);
      ctx.fillRect(lagX, y, lagWidth, height);
    }

    // Real bar.
    const fillWidth = width * ratio;
    const fillX = mirrored ? x + width - fillWidth : x;

    const pulse = critical ? 0.78 + Math.sin(this.time * 7) * 0.22 : 1;
    const gradient = ctx.createLinearGradient(fillX, y, fillX, y + height);
    const top = critical ? Palette.rose : mix(Semantic.health, Palette.gold, 0.25);
    const bottom = critical ? Palette.bloodDeep : Semantic.health;
    gradient.addColorStop(0, top);
    gradient.addColorStop(1, bottom);

    ctx.globalAlpha = pulse;
    ctx.fillStyle = gradient;
    ctx.fillRect(fillX, y, fillWidth, height);
    ctx.globalAlpha = 1;

    // A bright cap at the leading edge, so the bar has a readable "head".
    if (fillWidth > 4) {
      const capX = mirrored ? fillX : fillX + fillWidth - 3;
      ctx.fillStyle = alpha(Palette.white, 0.7);
      ctx.fillRect(capX, y, 3, height);
    }

    // Stamina, a thin strip under the health bar.
    this.drawThinBar(
      ctx,
      x,
      y + height + 5,
      width,
      6,
      fighter.staminaRatio,
      mirrored,
      fighter.staminaRatio < 0.3 ? Semantic.staminaLow : Semantic.stamina,
    );

    // Super meter, thinner still and gold.
    this.drawMeter(ctx, x, y + height + 15, width, 7, fighter, mirrored);

    ctx.restore();
  }

  private drawBarFrame(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    ctx.fillStyle = Semantic.hudBackdrop;
    ctx.fillRect(x - 2, y - 2, width + 4, height + 4);
    ctx.strokeStyle = Semantic.hudBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 2.5, y - 2.5, width + 5, height + 5);
  }

  private drawThinBar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    ratio: number,
    mirrored: boolean,
    color: string,
  ): void {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.fillRect(x, y, width, height);

    const fillWidth = width * clamp(ratio, 0, 1);
    const fillX = mirrored ? x + width - fillWidth : x;
    ctx.fillStyle = color;
    ctx.fillRect(fillX, y, fillWidth, height);
  }

  private drawMeter(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    fighter: Fighter,
    mirrored: boolean,
  ): void {
    const ratio = fighter.meterRatio;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(x, y, width, height);

    const fillWidth = width * ratio;
    const fillX = mirrored ? x + width - fillWidth : x;

    if (ratio >= 1) {
      // A full meter shimmers. It is the one thing on the HUD allowed to
      // demand attention, because it means the player has an option available.
      const shimmer = 0.6 + Math.sin(this.time * 9) * 0.4;
      ctx.save();
      ctx.shadowColor = Semantic.meter;
      ctx.shadowBlur = 14 * shimmer;
      ctx.fillStyle = mix(Semantic.meter, Palette.white, shimmer * 0.5);
      ctx.fillRect(fillX, y, fillWidth, height);
      ctx.restore();
    } else {
      ctx.fillStyle = Semantic.meter;
      ctx.fillRect(fillX, y, fillWidth, height);
    }

    // Quarter ticks, so partial meter is countable at a glance.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    for (let i = 1; i < 4; i++) {
      ctx.fillRect(x + (width * i) / 4, y, 2, height);
    }
  }

  private drawRoundPips(
    ctx: CanvasRenderingContext2D,
    match: Match,
    slot: 0 | 1,
    x: number,
    y: number,
    mirrored: boolean,
  ): void {
    const wins = slot === 0 ? match.p1Wins : match.p2Wins;
    const total = match.rules.roundsToWin;
    const radius = 8;
    const gap = 26;

    // Modes that never end on rounds — training, mainly — ask for an
    // absurd number of wins so the match cannot finish. Drawing one pip per
    // win would paper the top of the screen with a hundred circles, which is
    // exactly what it looked like. A round counter only means anything when
    // there is a realistic number of rounds to count.
    if (total > MAX_DRAWN_PIPS) return;

    for (let i = 0; i < total; i++) {
      const pipX = mirrored ? x - i * gap - radius : x + i * gap + radius;
      const won = i < wins;

      ctx.beginPath();
      ctx.arc(pipX, y, radius, 0, TAU);
      if (won) {
        ctx.fillStyle = Semantic.health;
        ctx.shadowColor = Semantic.health;
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  // --- centre ---------------------------------------------------------------

  private drawTimer(ctx: CanvasRenderingContext2D, match: Match): void {
    if (match.rules.roundSeconds <= 0) return;

    const seconds = Math.ceil(match.timeRemaining);
    const urgent = seconds <= 10;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const scale = urgent ? 1 + Math.sin(this.time * 8) * 0.06 : 1;
    font(ctx, TypeScale.title * scale, 'display');

    ctx.fillStyle = 'rgba(4, 4, 10, 0.72)';
    ctx.fillRect(DESIGN_WIDTH / 2 - 62, 40, 124, 76);
    ctx.strokeStyle = Semantic.hudBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(DESIGN_WIDTH / 2 - 62.5, 39.5, 125, 77);

    ctx.fillStyle = urgent ? Palette.rose : Palette.paper;
    if (urgent) {
      ctx.shadowColor = Palette.rose;
      ctx.shadowBlur = 18;
    }
    ctx.fillText(String(seconds).padStart(2, '0'), DESIGN_WIDTH / 2, 80);
    ctx.restore();
  }

  private drawCombo(ctx: CanvasRenderingContext2D, fighter: Fighter, slot: 0 | 1): void {
    const combo = this.combos[slot];
    if (combo.hits < 2) return;

    const fade = combo.age > 0.9 ? 1 - clamp((combo.age - 0.9) / 0.5, 0, 1) : 1;
    if (fade <= 0.01) return;

    const pop = combo.age < 0.16 ? Ease.back(combo.age / 0.16) : 1;
    const x = slot === 0 ? 180 : DESIGN_WIDTH - 180;

    ctx.save();
    ctx.globalAlpha = fade;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(x, 250);
    ctx.scale(pop, pop);

    font(ctx, 82, 'display');
    ctx.fillStyle = Palette.gold;
    ctx.shadowColor = Palette.gold;
    ctx.shadowBlur = 24;
    ctx.fillText(String(combo.hits), 0, 0);

    ctx.shadowBlur = 0;
    font(ctx, TypeScale.body, 'ui', 700);
    ctx.fillStyle = Palette.ash200;
    ctx.fillText('ПОПАДАНИЙ', 0, 46);

    if (fighter.comboDamage > 0) {
      font(ctx, TypeScale.label, 'ui', 600);
      ctx.fillStyle = Palette.ash400;
      ctx.fillText(`${Math.round(fighter.comboDamage)} УРОНА`, 0, 70);
    }

    ctx.restore();
  }

  private drawAnnouncement(ctx: CanvasRenderingContext2D): void {
    const t = this.announcementAge / this.announcementLife;
    if (t >= 1 || !this.announcement) return;

    // In fast, hold, out slow.
    const appear = clamp(this.announcementAge / 0.22, 0, 1);
    const disappear = clamp((t - 0.72) / 0.28, 0, 1);
    const opacity = appear * (1 - disappear);
    const scale = lerp(1.35, 1, Ease.out(appear)) * lerp(1, 1.12, disappear);

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(DESIGN_WIDTH / 2, 380);
    ctx.scale(scale, scale);

    font(ctx, TypeScale.hero, 'display');
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.strokeText(this.announcement, 0, 0);

    ctx.fillStyle = this.announcementColor;
    ctx.shadowColor = this.announcementColor;
    ctx.shadowBlur = 40 * opacity;
    ctx.fillText(this.announcement, 0, 0);

    ctx.restore();
  }

  reset(): void {
    for (const bar of this.bars) {
      bar.lag = 1;
      bar.flash = 0;
    }
    for (const combo of this.combos) {
      combo.hits = 0;
      combo.age = 99;
    }
    this.announcementAge = 99;
  }
}
