import { clamp, damp, TAU, wrapIndex } from '@/core/math';
import { CHARACTERS, isUnlocked, statBars, type Character } from '@/game/characters';
import { ARENAS, getArena } from '@/game/arenas';
import { Fighter } from '@/game/fighter';
import { FighterAnimator } from '@/game/animation';
import type { GameMode } from '@/game/world';
import { BASE_PPM, Camera2D, HORIZON_Y } from '@/render/camera2d';
import { SilhouetteRenderer } from '@/render/silhouette';
import { ClothSystem } from '@/render/ribbons';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '@/render/renderer';
import { alpha, Ease, font, mix, Palette, TypeScale } from '@/render/theme';
import { Screen, type ScreenContext, type ScreenParams } from '../screen';
import { button, chamferedRect, panel, statBar, type Rect } from '../widgets';
import { wrapLines } from './mode';

/**
 * Character select.
 *
 * The fighter is rendered live, in the same pipeline the fight uses, shadow
 * boxing on a loop. A static portrait would be cheaper and would also throw
 * away the one thing this game has that a normal fighting game does not: the
 * roster is made of *silhouettes in motion*, and motion is what distinguishes
 * them. Vega's reach and Grom's bulk are legible in two seconds of animation
 * and invisible in a still.
 */

/**
 * Preview framing, derived rather than guessed.
 *
 * `worldToScreen` maps the ground plane to `HORIZON_Y + (cameraY - 1.1) * ppm`,
 * so these constants are chosen together: the feet land at `PREVIEW_FLOOR_Y`,
 * a full 1.8 m fighter spans roughly 475 px above it, and the whole figure
 * clears the roster strip along the bottom of the screen.
 */
const PREVIEW_ZOOM = 1.45;
const PREVIEW_CAMERA_X = 1.25;
const PREVIEW_CAMERA_Y = 0.6;
const PREVIEW_PPM = BASE_PPM * PREVIEW_ZOOM;
const PREVIEW_FLOOR_Y = HORIZON_Y + (PREVIEW_CAMERA_Y - 1.1) * PREVIEW_PPM;
const PREVIEW_CENTER_X = DESIGN_WIDTH / 2 - PREVIEW_CAMERA_X * PREVIEW_PPM;

export class CharacterScreen extends Screen {
  readonly id = 'character' as const;
  readonly visionMode = 'hands' as const;

  private mode: GameMode = 'versus';
  private index = 0;
  private scrollOffset = 0;

  /** A live fighter used purely as a mannequin. */
  private preview: Fighter | null = null;
  private animator = new FighterAnimator(0x51de);
  private cloth: ClothSystem | null = null;
  private readonly silhouette = new SilhouetteRenderer();
  private readonly camera = new Camera2D();

  /** Animates the stat bars when the selection changes. */
  private statReveal = 0;
  /** Scripted shadow-boxing loop for the mannequin. */
  private shadowTimer = 0;

  constructor(context: ScreenContext) {
    super(context);
  }

  enter(params?: ScreenParams): void {
    super.enter();
    this.mode = (params?.mode as GameMode) ?? 'versus';
    this.camera.snapTo(0, 1.1, 1.05);
    this.rebuildPreview();
  }

  private get roster(): readonly Character[] {
    return CHARACTERS;
  }

  private get current(): Character {
    return this.roster[this.index];
  }

  private rebuildPreview(): void {
    const character = this.current;
    this.preview = new Fighter({
      characterId: character.id,
      slot: 0,
      controller: 'ai',
      startX: 0,
    });
    this.preview.enter('idle');
    this.animator = new FighterAnimator(0x51de + this.index);
    this.cloth = new ClothSystem(this.preview, 12, 0x51de + this.index);
    this.cloth.resetTo(this.preview);
    this.statReveal = 0;
    this.shadowTimer = 0;
  }

  private select(delta: number): void {
    const next = wrapIndex(this.index + delta, this.roster.length);
    if (next === this.index) return;
    this.index = next;
    this.rebuildPreview();
    this.context.audio.play('hover');
  }

  update(dt: number): void {
    super.update(dt);

    const swipe = this.context.vision.gesture.swipe;
    if (swipe === 'left') this.select(1);
    else if (swipe === 'right') this.select(-1);

    this.statReveal = damp(this.statReveal, 1, 0.16, dt);
    this.scrollOffset = damp(this.scrollOffset, this.index, 0.12, dt);

    const preview = this.preview;
    if (preview) {
      this.driveShadowBoxing(preview, dt);
      preview.tick(4, 0);
      this.animator.update(preview, preview.rig, dt);
      this.cloth?.update(preview, dt);
      preview.boxes.syncHurtboxes(preview.rig);
    }
  }

  /**
   * Scripts the mannequin: a loop of guard, jab, cross, step, kick. It is not
   * the AI — the AI needs an opponent — just a fixed rhythm chosen to show off
   * each character's reach and speed.
   */
  private driveShadowBoxing(fighter: Fighter, dt: number): void {
    this.shadowTimer += dt;
    const beat = 1.05 / this.current.stats.speed;

    fighter.input.motion.guarding = true;
    fighter.input.motion.guardHeight = 0.62;
    fighter.input.motion.advance = Math.sin(this.shadowTimer * 0.9) * 0.12;
    fighter.guarding = true;
    fighter.guardHeight = 0.62;

    if (this.shadowTimer < beat || fighter.state === 'attacking') return;
    this.shadowTimer = 0;

    const routine = ['jab', 'cross', 'hook', 'midKick', 'jab', 'uppercut', 'highKick'] as const;
    const pick = routine[Math.floor(this.elapsed / beat) % routine.length];
    fighter.startMove(pick, 0.85);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    this.drawBackground(ctx);
    this.drawPreview(ctx);
    this.drawRoster(ctx);
    this.drawInfo(ctx);
    this.drawControls(ctx);
  }

  private drawBackground(ctx: CanvasRenderingContext2D): void {
    const visuals = this.current.visuals;
    const gradient = ctx.createRadialGradient(
      PREVIEW_CENTER_X,
      DESIGN_HEIGHT * 0.45,
      0,
      PREVIEW_CENTER_X,
      DESIGN_HEIGHT * 0.45,
      DESIGN_WIDTH * 0.8,
    );
    gradient.addColorStop(0, mix(Palette.ink700, visuals.rim, 0.1));
    gradient.addColorStop(0.5, Palette.ink800);
    gradient.addColorStop(1, Palette.ink900);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);

    // A pool of light on the floor under the mannequin, aligned with where the
    // camera actually puts its feet rather than with a guessed fraction.
    const floorY = PREVIEW_FLOOR_Y;
    const pool = ctx.createRadialGradient(
      PREVIEW_CENTER_X,
      floorY,
      0,
      PREVIEW_CENTER_X,
      floorY,
      420,
    );
    pool.addColorStop(0, alpha(visuals.rim, 0.14));
    pool.addColorStop(1, alpha(visuals.rim, 0));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = pool;
    ctx.beginPath();
    ctx.ellipse(PREVIEW_CENTER_X, floorY, 420, 90, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    // The character's name, enormous and ghosted behind the figure.
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, 300, 'display');
    ctx.fillStyle = visuals.rim;
    ctx.fillText(this.current.name, PREVIEW_CENTER_X, DESIGN_HEIGHT * 0.38);
    ctx.restore();
  }

  private drawPreview(ctx: CanvasRenderingContext2D): void {
    const preview = this.preview;
    if (!preview) return;

    // The mannequin stands slightly left of centre, leaving the right side for
    // the stat panel.
    // Framed so the fighter fills the free space left of the stat panel and
    // stands clear of the roster strip below. Large enough that build and
    // reach differences read at a glance — the point of animating it at all.
    this.camera.x = PREVIEW_CAMERA_X;
    this.camera.y = PREVIEW_CAMERA_Y;
    this.camera.zoom = PREVIEW_ZOOM;

    ctx.save();
    ctx.globalAlpha = Ease.out(this.appear);
    this.cloth?.draw(ctx, this.camera, preview);
    this.silhouette.draw(ctx, preview, this.camera, { glow: 1.4 });
    ctx.restore();
  }

  /** The roster strip along the bottom. */
  private drawRoster(ctx: CanvasRenderingContext2D): void {
    const roster = this.roster;
    const size = 108;
    const gap = 18;
    const totalWidth = roster.length * size + (roster.length - 1) * gap;
    const startX = (DESIGN_WIDTH - totalWidth) / 2;
    const y = DESIGN_HEIGHT - 246;

    for (let i = 0; i < roster.length; i++) {
      const character = roster[i];
      const unlocked = isUnlocked(character, this.context.progress.owned);
      const rect: Rect = { x: startX + i * (size + gap), y, w: size, h: size };
      const selected = i === this.index;

      const pointer = this.context.widgets.pointer;
      const hovered =
        pointer.active &&
        pointer.x >= rect.x &&
        pointer.x <= rect.x + rect.w &&
        pointer.y >= rect.y &&
        pointer.y <= rect.y + rect.h;

      if (hovered) {
        this.context.widgets.setHover(`char:${character.id}`);
        if (pointer.pressed && unlocked && i !== this.index) {
          this.index = i;
          this.rebuildPreview();
          this.context.audio.play('click');
        }
      }

      ctx.save();
      const lift = selected ? 12 : hovered ? 6 : 0;
      ctx.translate(0, -lift);

      // Tile.
      ctx.fillStyle = selected
        ? mix(character.visuals.bodyInner, character.visuals.rim, 0.2)
        : 'rgba(10, 11, 20, 0.85)';
      chamferedRect(ctx, rect.x, rect.y, rect.w, rect.h, 14);
      ctx.fill();

      ctx.strokeStyle = selected ? character.visuals.rim : 'rgba(255,255,255,0.1)';
      ctx.lineWidth = selected ? 2.5 : 1.25;
      if (selected) {
        ctx.shadowColor = character.visuals.rim;
        ctx.shadowBlur = 22;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (unlocked) {
        // A tiny silhouette bust, built from three shapes. Enough to tell the
        // characters apart at this size, and it stays on-style.
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2 + 8;
        // Lifted well off the tile colour: a silhouette drawn in the body's
        // own near-black is invisible against a near-black plate, which made
        // the whole roster strip read as six identical empty squares.
        ctx.fillStyle = selected
          ? mix(character.visuals.bodyInner, character.visuals.rim, 0.42)
          : mix(character.visuals.bodyInner, character.visuals.rim, 0.24);
        ctx.beginPath();
        ctx.arc(cx, cy - 22, 13 * character.stats.build, 0, TAU);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(cx - 22 * character.stats.build, cy + 26);
        ctx.quadraticCurveTo(cx, cy - 14, cx + 22 * character.stats.build, cy + 26);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = character.visuals.rim;
        ctx.lineWidth = 2;
        ctx.globalAlpha = selected ? 1 : 0.5;
        ctx.beginPath();
        ctx.arc(cx - 3, cy - 22, 13 * character.stats.build, Math.PI * 0.7, Math.PI * 1.55);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        // Locked: a padlock and the requirement.
        ctx.strokeStyle = Palette.ash500;
        ctx.lineWidth = 2.5;
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        ctx.strokeRect(cx - 13, cy - 4, 26, 22);
        ctx.beginPath();
        ctx.arc(cx, cy - 4, 9, Math.PI, 0);
        ctx.stroke();

        font(ctx, TypeScale.micro, 'ui', 700);
        ctx.textAlign = 'center';
        ctx.fillStyle = Palette.ash500;
        // Не «столько-то побед», а «из кейса»: побед больше недостаточно.
        ctx.fillText('ИЗ КЕЙСА', cx, rect.y + rect.h - 12);
      }

      ctx.restore();
    }

    // Name under the strip.
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.label, 'ui', 600);
    ctx.fillStyle = Palette.ash400;
    ctx.fillText('ЛАДОНЬЮ ВЛЕВО/ВПРАВО — ПЕРЕКЛЮЧИТЬ', DESIGN_WIDTH / 2, y + size + 34);
    ctx.restore();
  }

  /** Name, tagline, description and stat bars. */
  private drawInfo(ctx: CanvasRenderingContext2D): void {
    const character = this.current;
    const rect: Rect = { x: DESIGN_WIDTH - 690, y: 150, w: 560, h: 560 };
    panel(ctx, rect, 'боец', character.visuals.rim);

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    font(ctx, 78, 'display');
    ctx.fillStyle = Palette.white;
    ctx.fillText(character.name, rect.x + 30, rect.y + 132);

    font(ctx, TypeScale.body, 'ui', 600);
    ctx.fillStyle = character.visuals.rim;
    ctx.fillText(character.tagline, rect.x + 32, rect.y + 168);

    font(ctx, TypeScale.label + 1, 'ui', 500);
    ctx.fillStyle = Palette.ash300;
    const lines = wrapLines(ctx, character.description, rect.x + 32, rect.y + 214, rect.w - 64, 26, 4);

    const statsY = rect.y + 240 + lines * 26;
    const bars = statBars(character);
    for (let i = 0; i < bars.length; i++) {
      const reveal = clamp((this.statReveal - i * 0.08) * 1.6, 0, 1);
      statBar(
        ctx,
        rect.x + 32,
        statsY + i * 38,
        rect.w - 64,
        bars[i].label,
        bars[i].value,
        character.visuals.rim,
        Ease.out(reveal),
      );
    }

    ctx.restore();
  }

  private drawControls(ctx: CanvasRenderingContext2D): void {
    void ctx;
    const y = DESIGN_HEIGHT - 116;
    const unlocked = isUnlocked(this.current, this.context.progress.owned);

    if (
      button(this.context.widgets, {
        id: 'char:back',
        rect: { x: 128, y, w: 220, h: 74 },
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
        id: 'char:start',
        rect: { x: DESIGN_WIDTH - 128 - 360, y, w: 360, h: 74 },
        label: unlocked ? 'В БОЙ' : 'НЕТ В КОЛЛЕКЦИИ',
        glyph: 'play',
        primary: true,
        disabled: !unlocked,
        accent: this.current.visuals.rim,
      })
    ) {
      this.startFight();
    }
  }

  private startFight(): void {
    const { progress } = this.context;
    const opponentPool = CHARACTERS.filter((c) => c.id !== this.current.id);
    // Arcade picks its own ladder; the other modes take a random legal pairing.
    const stage = this.mode === 'arcade' ? clamp(progress.arcadeStage, 0, opponentPool.length - 1) : -1;
    const opponent =
      stage >= 0
        ? opponentPool[stage]
        : opponentPool[Math.floor(Math.random() * opponentPool.length)];

    const arenaPool = ARENAS.filter((arena) => progress.wins >= arena.unlockWins);
    const arena = arenaPool[Math.floor(Math.random() * arenaPool.length)] ?? getArena('dusk-temple');

    this.context.push('fight', {
      mode: this.mode,
      playerCharacter: this.current.id,
      opponentCharacter: opponent.id,
      arenaId: arena.id,
      stage: Math.max(stage, 0),
    });
  }
}
