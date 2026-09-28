import { clamp } from '@/core/math';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '@/render/renderer';
import { Ease, font, Palette, TypeScale } from '@/render/theme';
import { SENSITIVITY_PRESETS, sensitivityLabel } from '@/settings';
import { Screen, type ScreenContext, type ScreenParams } from '../screen';
import { button, panel, slider, toggle, type Rect } from '../widgets';

/**
 * Pause.
 *
 * Deliberately thin: resume, adjust the two settings a player actually wants
 * to change mid-fight, quit. Everything else belongs in the full settings
 * screen, and offering it here just makes it slower to get back to the fight.
 *
 * Sensitivity is here because it is the one setting whose right value is only
 * discoverable *during* a fight — a player who finds their hooks are being
 * missed needs to fix that without losing the round.
 */

export class PauseScreen extends Screen {
  readonly id = 'pause' as const;
  readonly visionMode = 'hands' as const;

  private confirmingQuit = false;

  constructor(context: ScreenContext) {
    super(context);
  }

  enter(_params?: ScreenParams): void {
    super.enter();
    this.confirmingQuit = false;
  }

  update(dt: number): void {
    super.update(dt);
    // The open-palm gesture resumes, which is what a player instinctively does
    // when they want the menu to go away.
    if (this.context.vision.gesture.backFired && this.elapsed > 0.5) this.resumeFight();
  }

  private resumeFight(): void {
    this.context.audio.play('back');
    this.context.pop();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const appear = Ease.out(clamp(this.elapsed / 0.24, 0, 1));

    // Dim the fight rather than replacing it: the player keeps their bearings.
    ctx.save();
    ctx.globalAlpha = appear * 0.82;
    ctx.fillStyle = '#04040a';
    ctx.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = appear;
    ctx.translate(0, (1 - appear) * 26);

    if (this.confirmingQuit) this.drawQuitConfirm(ctx);
    else this.drawMain(ctx);

    ctx.restore();
  }

  private drawMain(ctx: CanvasRenderingContext2D): void {
    const width = 720;
    const height = 640;
    const rect: Rect = {
      x: (DESIGN_WIDTH - width) / 2,
      y: (DESIGN_HEIGHT - height) / 2,
      w: width,
      h: height,
    };

    panel(ctx, rect, 'пауза', Palette.ember);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.title, 'display');
    ctx.fillStyle = Palette.paper;
    ctx.fillText('ПАУЗА', DESIGN_WIDTH / 2, rect.y + 104);
    ctx.restore();

    const settings = this.context.settings;
    const contentX = rect.x + 52;
    const contentWidth = width - 104;

    // Sensitivity.
    const nextSensitivity = slider(this.context.widgets, {
      id: 'pause:sensitivity',
      rect: { x: contentX, y: rect.y + 160, w: contentWidth, h: 70 },
      label: 'ЧУВСТВИТЕЛЬНОСТЬ',
      value: settings.sensitivity,
      min: 0.5,
      max: 1.7,
      step: 0.05,
      format: (value) => `${sensitivityLabel(value)} · ${value.toFixed(2)}`,
    });
    if (Math.abs(nextSensitivity - settings.sensitivity) > 0.001) {
      this.context.applySettings({ ...settings, sensitivity: nextSensitivity });
    }

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.micro, 'ui', 500);
    ctx.fillStyle = Palette.ash500;
    const preset = SENSITIVITY_PRESETS.reduce((best, candidate) =>
      Math.abs(candidate.value - settings.sensitivity) < Math.abs(best.value - settings.sensitivity)
        ? candidate
        : best,
    );
    ctx.fillText(preset.hint, contentX, rect.y + 248);
    ctx.restore();

    // Camera preview toggle.
    const showCamera = toggle(this.context.widgets, {
      id: 'pause:camera',
      rect: { x: contentX, y: rect.y + 274, w: contentWidth, h: 64 },
      label: 'ПОКАЗЫВАТЬ КАМЕРУ',
      hint: 'Маленькое окно в углу экрана',
      value: settings.showCamera,
    });
    if (showCamera !== settings.showCamera) {
      this.context.applySettings({ ...settings, showCamera });
    }

    const showSkeleton = toggle(this.context.widgets, {
      id: 'pause:skeleton',
      rect: { x: contentX, y: rect.y + 346, w: contentWidth, h: 64 },
      label: 'СКЕЛЕТ ПОВЕРХ КАМЕРЫ',
      hint: 'Видно, что именно распознаёт игра',
      value: settings.showSkeleton,
    });
    if (showSkeleton !== settings.showSkeleton) {
      this.context.applySettings({ ...settings, showSkeleton });
    }

    // Actions.
    const buttonY = rect.y + height - 150;
    if (
      button(this.context.widgets, {
        id: 'pause:resume',
        rect: { x: contentX, y: buttonY, w: contentWidth, h: 82 },
        label: 'ПРОДОЛЖИТЬ',
        glyph: 'play',
        primary: true,
      })
    ) {
      this.resumeFight();
    }

    const half = (contentWidth - 16) / 2;
    if (
      button(this.context.widgets, {
        id: 'pause:settings',
        rect: { x: contentX, y: buttonY + 96, w: half, h: 68 },
        label: 'НАСТРОЙКИ',
        glyph: 'gear',
        accent: Palette.ash300,
      })
    ) {
      this.context.push('settings');
    }

    if (
      button(this.context.widgets, {
        id: 'pause:quit',
        rect: { x: contentX + half + 16, y: buttonY + 96, w: half, h: 68 },
        label: 'ВЫЙТИ',
        glyph: 'back',
        accent: Palette.rose,
      })
    ) {
      this.confirmingQuit = true;
      this.context.audio.play('click');
    }
  }

  /** Quitting mid-match loses progress, so it asks once. */
  private drawQuitConfirm(ctx: CanvasRenderingContext2D): void {
    const width = 640;
    const height = 330;
    const rect: Rect = {
      x: (DESIGN_WIDTH - width) / 2,
      y: (DESIGN_HEIGHT - height) / 2,
      w: width,
      h: height,
    };

    panel(ctx, rect, 'выйти из боя', Palette.rose);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.heading, 'display');
    ctx.fillStyle = Palette.paper;
    ctx.fillText('ВЫЙТИ ИЗ БОЯ?', DESIGN_WIDTH / 2, rect.y + 116);

    font(ctx, TypeScale.body, 'ui', 500);
    ctx.fillStyle = Palette.ash300;
    ctx.fillText('Текущий бой не засчитается', DESIGN_WIDTH / 2, rect.y + 160);
    ctx.restore();

    const half = (width - 104 - 16) / 2;
    const y = rect.y + height - 110;

    if (
      button(this.context.widgets, {
        id: 'pause:quit-no',
        rect: { x: rect.x + 52, y, w: half, h: 76 },
        label: 'ОСТАТЬСЯ',
        accent: Palette.ash300,
      })
    ) {
      this.confirmingQuit = false;
      this.context.audio.play('back');
    }

    if (
      button(this.context.widgets, {
        id: 'pause:quit-yes',
        rect: { x: rect.x + 52 + half + 16, y, w: half, h: 76 },
        label: 'ВЫЙТИ',
        primary: true,
        accent: Palette.rose,
      })
    ) {
      this.context.audio.play('click');
      this.context.reset('menu');
    }
  }
}
