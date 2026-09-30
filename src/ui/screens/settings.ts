import { QUALITY_PRESETS, type QualityTier } from '@/core/device';
import { clearAll } from '@/core/storage';
import type { CameraInfo } from '@/vision';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '@/render/renderer';
import { font, Palette, TypeScale } from '@/render/theme';
import { DEFAULT_PROGRESS, DEFAULT_SETTINGS, SENSITIVITY_PRESETS, sensitivityLabel } from '@/settings';
import { startingRoster } from '@/game/cases';
import { MenuBackdrop } from '../backdrop';
import { Screen, type ScreenContext } from '../screen';
import { button, panel, sectionTitle, segmented, slider, toggle, type Rect } from '../widgets';

/**
 * Settings.
 *
 * Organised by what breaks, not by what the code calls things. A player opens
 * this screen because something is wrong — the game isn't seeing their punches,
 * it's running badly, it's too loud — so the tabs are named after those
 * complaints and the first control in each tab is the one most likely to fix it.
 */

type Tab = 'input' | 'game' | 'video' | 'audio';

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'input', label: 'УПРАВЛЕНИЕ' },
  { id: 'game', label: 'ИГРА' },
  { id: 'video', label: 'ГРАФИКА' },
  { id: 'audio', label: 'ЗВУК' },
];

export class SettingsScreen extends Screen {
  readonly id = 'settings' as const;
  readonly visionMode = 'hands' as const;

  private readonly backdrop = new MenuBackdrop(30);
  private tab: Tab = 'input';
  private cameras: CameraInfo[] = [];
  private confirmingReset = false;

  constructor(context: ScreenContext) {
    super(context);
  }

  enter(): void {
    super.enter();
    this.backdrop.accent = Palette.ash300;
    this.confirmingReset = false;
    void this.context.vision.listCameras().then((cameras) => {
      this.cameras = cameras;
    });
  }

  update(dt: number): void {
    super.update(dt);
    this.backdrop.update(dt);
    if (this.context.vision.gesture.backFired && this.elapsed > 0.5) this.goBack();
  }

  private goBack(): void {
    this.context.audio.play('back');
    this.context.pop();
  }

  draw(ctx: CanvasRenderingContext2D): void {
    this.backdrop.draw(ctx);
    this.drawHeader(ctx);
    this.drawTabs(ctx);

    const rect: Rect = { x: 128, y: 300, w: DESIGN_WIDTH - 256, h: 540 };
    panel(ctx, rect, TABS.find((t) => t.id === this.tab)?.label ?? '', Palette.ember);

    switch (this.tab) {
      case 'input':
        this.drawInputTab(ctx, rect);
        break;
      case 'game':
        this.drawGameTab(ctx, rect);
        break;
      case 'video':
        this.drawVideoTab(ctx, rect);
        break;
      case 'audio':
        this.drawAudioTab(ctx, rect);
        break;
    }

    this.drawFooter(ctx);
    if (this.confirmingReset) this.drawResetConfirm(ctx);
  }

  private drawHeader(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalAlpha = this.appear;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.label, 'ui', 700);
    ctx.letterSpacing = '0.32em';
    ctx.fillStyle = Palette.ember;
    ctx.fillText('НАСТРОЙКИ', 128, 96);
    ctx.letterSpacing = '0px';
    ctx.restore();

    sectionTitle(ctx, 128, 148, DESIGN_WIDTH - 256, 'ПОДСТРОЙ ПОД СЕБЯ');
  }

  private drawTabs(ctx: CanvasRenderingContext2D): void {
    void ctx;
    const chosen = segmented(this.context.widgets, {
      id: 'settings:tabs',
      rect: { x: 128, y: 196, w: DESIGN_WIDTH - 256, h: 76 },
      options: TABS.map((tab) => ({ label: tab.label, value: tab.id })),
      value: this.tab,
    });
    if (chosen !== this.tab) this.tab = chosen as Tab;
  }

  // --- tabs -----------------------------------------------------------------

  private drawInputTab(ctx: CanvasRenderingContext2D, rect: Rect): void {
    const settings = this.context.settings;
    const x = rect.x + 48;
    const width = rect.w - 96;
    let y = rect.y + 88;

    const sensitivity = slider(this.context.widgets, {
      id: 'set:sensitivity',
      rect: { x, y, w: width, h: 70 },
      label: 'ЧУВСТВИТЕЛЬНОСТЬ РАСПОЗНАВАНИЯ',
      value: settings.sensitivity,
      min: 0.5,
      max: 1.7,
      step: 0.05,
      format: (value) => `${sensitivityLabel(value)} · ${value.toFixed(2)}`,
    });
    if (Math.abs(sensitivity - settings.sensitivity) > 0.001) {
      this.context.applySettings({ ...settings, sensitivity });
    }

    // The hint changes with the value, which turns an abstract number into a
    // description of what the player will actually experience.
    const preset = SENSITIVITY_PRESETS.reduce((best, candidate) =>
      Math.abs(candidate.value - settings.sensitivity) < Math.abs(best.value - settings.sensitivity)
        ? candidate
        : best,
    );
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.micro, 'ui', 500);
    ctx.fillStyle = Palette.ash500;
    ctx.fillText(preset.hint, x, y + 86);
    ctx.restore();

    y += 118;

    const mirrored = toggle(this.context.widgets, {
      id: 'set:mirror',
      rect: { x, y, w: width, h: 64 },
      label: 'ЗЕРКАЛЬНАЯ КАМЕРА',
      hint: 'Поднимаешь правую руку — боец поднимает правую',
      value: settings.mirrored,
    });
    if (mirrored !== settings.mirrored) {
      this.context.applySettings({ ...settings, mirrored });
    }

    y += 74;

    const handControl = toggle(this.context.widgets, {
      id: 'set:hands',
      rect: { x, y, w: width, h: 64 },
      label: 'УПРАВЛЕНИЕ МЕНЮ РУКАМИ',
      hint: 'Указательный палец — курсор, щипок — выбор',
      value: settings.handControl,
    });
    if (handControl !== settings.handControl) {
      this.context.applySettings({ ...settings, handControl });
    }

    y += 74;

    const keyboard = toggle(this.context.widgets, {
      id: 'set:keyboard',
      rect: { x, y, w: width, h: 64 },
      label: 'КЛАВИАТУРА КАК ЗАПАСНОЙ ВАРИАНТ',
      hint: 'J/K/L — руки, N/M — ноги, пробел — прыжок',
      value: settings.keyboardFallback,
    });
    if (keyboard !== settings.keyboardFallback) {
      this.context.applySettings({ ...settings, keyboardFallback: keyboard });
    }

    y += 84;

    // Camera picker, only when there is more than one to pick from.
    if (this.cameras.length > 1) {
      const chosen = segmented(this.context.widgets, {
        id: 'set:camera',
        rect: { x, y, w: width, h: 84 },
        label: 'КАМЕРА',
        options: this.cameras.slice(0, 4).map((camera) => ({
          label: camera.label.slice(0, 18),
          value: camera.deviceId,
        })),
        value: settings.cameraDeviceId || this.cameras[0].deviceId,
      });
      if (chosen !== settings.cameraDeviceId) {
        this.context.applySettings({ ...settings, cameraDeviceId: chosen });
        void this.context.vision.startCamera(chosen);
      }
    }

    if (
      button(this.context.widgets, {
        id: 'set:recalibrate',
        rect: { x, y: rect.y + rect.h - 104, w: 340, h: 76 },
        label: 'КАЛИБРОВКА',
        glyph: 'target',
        accent: Palette.venom,
      })
    ) {
      this.context.push('calibrate');
    }
  }

  private drawGameTab(ctx: CanvasRenderingContext2D, rect: Rect): void {
    void ctx;
    const settings = this.context.settings;
    const x = rect.x + 48;
    const width = rect.w - 96;
    let y = rect.y + 88;

    const rounds = segmented(this.context.widgets, {
      id: 'set:rounds',
      rect: { x, y, w: width, h: 84 },
      label: 'РАУНДОВ ДО ПОБЕДЫ',
      options: [
        { label: '1', value: '1' },
        { label: '2', value: '2' },
        { label: '3', value: '3' },
      ],
      value: String(settings.roundsToWin),
    });
    if (Number(rounds) !== settings.roundsToWin) {
      this.context.applySettings({ ...settings, roundsToWin: Number(rounds) });
    }

    y += 108;

    const time = segmented(this.context.widgets, {
      id: 'set:time',
      rect: { x, y, w: width, h: 84 },
      label: 'ВРЕМЯ РАУНДА',
      options: [
        { label: '60 С', value: '60' },
        { label: '99 С', value: '99' },
        { label: '180 С', value: '180' },
        { label: 'БЕЗ ЛИМИТА', value: '0' },
      ],
      value: String(settings.roundSeconds),
    });
    if (Number(time) !== settings.roundSeconds) {
      this.context.applySettings({ ...settings, roundSeconds: Number(time) });
    }

    y += 116;

    const dynamic = toggle(this.context.widgets, {
      id: 'set:dynamic',
      rect: { x, y, w: width, h: 64 },
      label: 'ПОДСТРАИВАТЬ СЛОЖНОСТЬ',
      hint: 'Противник слегка подтягивается под твой уровень',
      value: settings.dynamicDifficulty,
    });
    if (dynamic !== settings.dynamicDifficulty) {
      this.context.applySettings({ ...settings, dynamicDifficulty: dynamic });
    }

    y += 74;

    const debug = toggle(this.context.widgets, {
      id: 'set:debug',
      rect: { x, y, w: width, h: 64 },
      label: 'ОТЛАДОЧНАЯ ПАНЕЛЬ',
      hint: 'Частота распознавания, состояния бойцов, счётчики',
      value: settings.debugOverlay,
    });
    if (debug !== settings.debugOverlay) {
      this.context.applySettings({ ...settings, debugOverlay: debug });
    }
  }

  private drawVideoTab(ctx: CanvasRenderingContext2D, rect: Rect): void {
    const settings = this.context.settings;
    const x = rect.x + 48;
    const width = rect.w - 96;
    let y = rect.y + 88;

    const quality = segmented(this.context.widgets, {
      id: 'set:quality',
      rect: { x, y, w: width, h: 84 },
      label: 'КАЧЕСТВО',
      options: [
        { label: 'НИЗКОЕ', value: 'low' },
        { label: 'СРЕДНЕЕ', value: 'medium' },
        { label: 'ВЫСОКОЕ', value: 'high' },
        { label: 'МАКСИМУМ', value: 'ultra' },
      ],
      value: settings.quality,
    });
    if (quality !== settings.quality) {
      // Choosing by hand turns off the automatic tier, otherwise the game would
      // immediately override the player's decision.
      this.context.applySettings({
        ...settings,
        quality: quality as QualityTier,
        autoQuality: false,
      });
    }

    const preset = QUALITY_PRESETS[settings.quality];
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.micro, 'ui', 500);
    ctx.fillStyle = Palette.ash500;
    ctx.fillText(
      `частиц до ${preset.maxParticles} · распознавание ${preset.visionHz} Гц · ` +
        `${preset.bloom ? 'свечение' : 'без свечения'}`,
      x,
      y + 104,
    );
    ctx.restore();

    y += 132;

    const auto = toggle(this.context.widgets, {
      id: 'set:autoquality',
      rect: { x, y, w: width, h: 64 },
      label: 'АВТОМАТИЧЕСКОЕ КАЧЕСТВО',
      hint: 'Снижает качество, если падает частота кадров',
      value: settings.autoQuality,
    });
    if (auto !== settings.autoQuality) {
      this.context.applySettings({ ...settings, autoQuality: auto });
    }

    y += 78;

    const shake = slider(this.context.widgets, {
      id: 'set:shake',
      rect: { x, y, w: width, h: 66 },
      label: 'ТРЯСКА ЭКРАНА',
      value: settings.screenShake,
      min: 0,
      max: 1.5,
      step: 0.1,
      format: (value) => (value === 0 ? 'ВЫКЛ' : `${Math.round(value * 100)}%`),
    });
    if (Math.abs(shake - settings.screenShake) > 0.001) {
      this.context.applySettings({ ...settings, screenShake: shake });
    }

    y += 86;

    const flashes = toggle(this.context.widgets, {
      id: 'set:flashes',
      rect: { x, y, w: width, h: 64 },
      label: 'ВСПЫШКИ НА ВЕСЬ ЭКРАН',
      hint: 'Отключи, если вспышки мешают',
      value: settings.flashes,
    });
    if (flashes !== settings.flashes) {
      this.context.applySettings({ ...settings, flashes });
    }

    y += 74;

    const slowMotion = toggle(this.context.widgets, {
      id: 'set:slowmo',
      rect: { x, y, w: width, h: 64 },
      label: 'ЗАМЕДЛЕНИЕ НА СИЛЬНЫХ УДАРАХ',
      value: settings.slowMotion,
    });
    if (slowMotion !== settings.slowMotion) {
      this.context.applySettings({ ...settings, slowMotion });
    }
  }

  private drawAudioTab(ctx: CanvasRenderingContext2D, rect: Rect): void {
    void ctx;
    const settings = this.context.settings;
    const x = rect.x + 48;
    const width = rect.w - 96;
    let y = rect.y + 96;

    const percent = (value: number) => `${Math.round(value * 100)}%`;

    const master = slider(this.context.widgets, {
      id: 'set:master',
      rect: { x, y, w: width, h: 70 },
      label: 'ОБЩАЯ ГРОМКОСТЬ',
      value: settings.masterVolume,
      min: 0,
      max: 1,
      step: 0.05,
      format: percent,
    });
    y += 100;

    const music = slider(this.context.widgets, {
      id: 'set:music',
      rect: { x, y, w: width, h: 70 },
      label: 'МУЗЫКА',
      value: settings.musicVolume,
      min: 0,
      max: 1,
      step: 0.05,
      format: percent,
      accent: Palette.frost,
    });
    y += 100;

    const sfx = slider(this.context.widgets, {
      id: 'set:sfx',
      rect: { x, y, w: width, h: 70 },
      label: 'ЗВУКИ УДАРОВ',
      value: settings.sfxVolume,
      min: 0,
      max: 1,
      step: 0.05,
      format: percent,
      accent: Palette.venom,
    });

    if (
      Math.abs(master - settings.masterVolume) > 0.001 ||
      Math.abs(music - settings.musicVolume) > 0.001 ||
      Math.abs(sfx - settings.sfxVolume) > 0.001
    ) {
      this.context.applySettings({
        ...settings,
        masterVolume: master,
        musicVolume: music,
        sfxVolume: sfx,
      });
    }

    if (
      button(this.context.widgets, {
        id: 'set:testsound',
        rect: { x, y: rect.y + rect.h - 104, w: 300, h: 76 },
        label: 'ПРОВЕРИТЬ ЗВУК',
        accent: Palette.venom,
      })
    ) {
      this.context.audio.play('punchHeavy', 0.9);
    }
  }

  // --- chrome ---------------------------------------------------------------

  private drawFooter(ctx: CanvasRenderingContext2D): void {
    void ctx;
    const y = DESIGN_HEIGHT - 128;

    if (
      button(this.context.widgets, {
        id: 'set:back',
        rect: { x: 128, y, w: 220, h: 78 },
        label: 'НАЗАД',
        glyph: 'back',
        accent: Palette.ash400,
      })
    ) {
      this.goBack();
    }

    if (
      button(this.context.widgets, {
        id: 'set:reset',
        rect: { x: DESIGN_WIDTH - 128 - 300, y, w: 300, h: 78 },
        label: 'СБРОСИТЬ ВСЁ',
        accent: Palette.rose,
      })
    ) {
      this.confirmingReset = true;
      this.context.audio.play('click');
    }
  }

  /** Wiping progress is irreversible, so it asks — and says what it will erase. */
  private drawResetConfirm(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.fillStyle = 'rgba(4, 4, 10, 0.86)';
    ctx.fillRect(0, 0, DESIGN_WIDTH, DESIGN_HEIGHT);
    ctx.restore();

    const width = 680;
    const height = 330;
    const rect: Rect = {
      x: (DESIGN_WIDTH - width) / 2,
      y: (DESIGN_HEIGHT - height) / 2,
      w: width,
      h: height,
    };
    panel(ctx, rect, 'сброс', Palette.rose);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.heading, 'display');
    ctx.fillStyle = Palette.paper;
    ctx.fillText('СБРОСИТЬ ВСЕ ДАННЫЕ?', DESIGN_WIDTH / 2, rect.y + 116);

    font(ctx, TypeScale.body, 'ui', 500);
    ctx.fillStyle = Palette.ash300;
    ctx.fillText(
      'Настройки, калибровка, победы и открытые бойцы — всё',
      DESIGN_WIDTH / 2,
      rect.y + 158,
    );
    ctx.restore();

    const half = (width - 104 - 16) / 2;
    const y = rect.y + height - 110;

    if (
      button(this.context.widgets, {
        id: 'set:reset-no',
        rect: { x: rect.x + 52, y, w: half, h: 76 },
        label: 'ОТМЕНА',
        accent: Palette.ash300,
      })
    ) {
      this.confirmingReset = false;
      this.context.audio.play('back');
    }

    if (
      button(this.context.widgets, {
        id: 'set:reset-yes',
        rect: { x: rect.x + 52 + half + 16, y, w: half, h: 76 },
        label: 'СБРОСИТЬ',
        primary: true,
        accent: Palette.rose,
      })
    ) {
      clearAll();
      this.context.applySettings({ ...DEFAULT_SETTINGS });
      // Сброс берёт значения по умолчанию, а не перечисляет поля руками:
      // перечисление ломается каждый раз, когда в прогрессе появляется новое
      // поле, и ломается молча — сброшенный игрок просто оставался без него.
      this.context.saveProgress({ ...DEFAULT_PROGRESS, owned: startingRoster() });
      this.confirmingReset = false;
      this.context.audio.play('error');
      this.context.reset('menu');
    }
  }
}
