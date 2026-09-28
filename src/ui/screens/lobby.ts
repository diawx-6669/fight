import { clamp, TAU } from '@/core/math';
import { load, StorageKeys } from '@/core/storage';
import { CHARACTERS, getCharacter, isUnlocked } from '@/game/characters';
import { NetClient, type ConnectionState } from '@/net/client';
import { isValidRoomCode } from '@/net/protocol';
import { DESIGN_HEIGHT, DESIGN_WIDTH } from '@/render/renderer';
import { alpha, Ease, font, mix, Palette, TypeScale } from '@/render/theme';
import { MenuBackdrop } from '../backdrop';
import { Screen, type ScreenContext } from '../screen';
import { button, chamferedRect, panel, spinner, type Rect } from '../widgets';

/**
 * Online lobby.
 *
 * Two ways in, because they solve different problems:
 *
 * - **Quick match** drops the player into a public queue. It needs no
 *   coordination and is the right default when someone just wants a fight.
 * - **Room code** is for playing with a specific person. Both sides type the
 *   same five characters and get paired.
 *
 * The code alphabet excludes `0/O` and `1/I` on purpose — these codes get read
 * aloud over a voice call, and the two minutes lost to "was that a zero or an
 * oh?" are worth more than the four extra characters of entropy.
 */

type Panel = 'home' | 'queue' | 'code' | 'matched';

/** Same alphabet the server generates from. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class LobbyScreen extends Screen {
  readonly id = 'lobby' as const;
  readonly visionMode = 'hands' as const;

  private readonly backdrop = new MenuBackdrop(36);
  private net: NetClient | null = null;
  private unsubscribe: (() => void)[] = [];

  private panel: Panel = 'home';
  private characterIndex = 0;
  private codeInput = '';
  private sharedCode = '';
  private queuePosition = 0;
  private statusMessage = '';
  private errorMessage = '';
  private connection: ConnectionState = 'idle';

  constructor(context: ScreenContext) {
    super(context);
  }

  enter(): void {
    super.enter();
    this.backdrop.accent = Palette.frost;
    this.panel = 'home';
    this.codeInput = '';
    this.errorMessage = '';
    this.statusMessage = '';

    const savedName = load<string>(StorageKeys.playerName, '');
    this.net = new NetClient({ playerName: savedName || 'Боец' });
    this.wireNet();
    this.net.connect();
  }

  private wireNet(): void {
    const net = this.net;
    if (!net) return;

    this.unsubscribe = [
      net.events.on('state', ({ state }) => {
        this.connection = state;
        this.statusMessage = CONNECTION_LABELS[state] ?? '';
      }),
      net.events.on('queued', ({ position, room }) => {
        this.queuePosition = position;
        if (room) {
          this.sharedCode = room;
          this.panel = 'code';
        } else {
          this.panel = 'queue';
        }
      }),
      net.events.on('matched', (match) => {
        this.panel = 'matched';
        this.context.audio.play('meterFull');
        // A beat on the "found an opponent" card before the fight starts —
        // going straight in gives the player no idea who they are facing.
        window.setTimeout(() => this.startMatch(match.slot, match.arena, match.opponent.character), 1800);
      }),
      net.events.on('error', ({ message }) => {
        this.errorMessage = message;
        this.context.audio.play('error');
      }),
      net.events.on('opponentLeft', () => {
        this.errorMessage = 'Соперник отключился';
        this.panel = 'home';
      }),
    ];
  }

  exit(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    // The client is handed to the fight screen when a match starts; only tear
    // it down if we are leaving without one.
    if (this.panel !== 'matched') this.net?.dispose();
    this.net = null;
  }

  update(dt: number): void {
    super.update(dt);
    this.backdrop.update(dt);
    this.net?.update(dt);

    if (this.context.vision.gesture.backFired && this.elapsed > 0.6) {
      if (this.panel === 'home') this.goBack();
      else this.cancel();
    }
  }

  private goBack(): void {
    this.context.audio.play('back');
    this.context.pop();
  }

  private cancel(): void {
    this.net?.cancelQueue();
    this.panel = 'home';
    this.codeInput = '';
    this.sharedCode = '';
    this.context.audio.play('back');
  }

  private startMatch(slot: 0 | 1, arena: string, opponentCharacter: string): void {
    const net = this.net;
    if (!net) return;
    net.ready();

    // Ownership of the socket transfers to the fight screen here.
    this.net = null;
    this.context.replace('fight', {
      mode: 'online',
      net,
      slot,
      arenaId: arena,
      playerCharacter: this.currentCharacter.id,
      opponentCharacter,
    });
  }

  private get currentCharacter() {
    const unlocked = CHARACTERS.filter((c) => isUnlocked(c, this.context.progress.wins));
    return unlocked[clamp(this.characterIndex, 0, unlocked.length - 1)] ?? getCharacter('kai');
  }

  draw(ctx: CanvasRenderingContext2D): void {
    this.backdrop.draw(ctx);
    this.drawHeader(ctx);

    switch (this.panel) {
      case 'home':
        this.drawHome(ctx);
        break;
      case 'queue':
        this.drawQueue(ctx);
        break;
      case 'code':
        this.drawCode(ctx);
        break;
      case 'matched':
        this.drawMatched(ctx);
        break;
    }

    this.drawStatus(ctx);
  }

  private drawHeader(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalAlpha = this.appear;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    font(ctx, TypeScale.label, 'ui', 700);
    ctx.letterSpacing = '0.32em';
    ctx.fillStyle = Palette.frost;
    ctx.fillText('ОНЛАЙН', 128, 96);
    ctx.letterSpacing = '0px';

    font(ctx, TypeScale.title, 'display');
    ctx.fillStyle = Palette.paper;
    ctx.fillText('БОЙ ПРОТИВ ЧЕЛОВЕКА', 128, 148);
    ctx.restore();
  }

  // --- panels ---------------------------------------------------------------

  private drawHome(ctx: CanvasRenderingContext2D): void {
    const rect: Rect = { x: 128, y: 220, w: DESIGN_WIDTH - 256, h: 480 };
    panel(ctx, rect, 'как играем', Palette.frost);

    const halfWidth = (rect.w - 96 - 32) / 2;
    const cardY = rect.y + 96;
    const cardHeight = 260;

    this.drawOptionCard(
      ctx,
      { x: rect.x + 48, y: cardY, w: halfWidth, h: cardHeight },
      'quick',
      'БЫСТРЫЙ БОЙ',
      'Найти любого соперника из тех, кто сейчас в очереди',
      Palette.frost,
      () => {
        this.net?.queue(this.currentCharacter.id, '');
        this.panel = 'queue';
        this.context.audio.play('click');
      },
    );

    this.drawOptionCard(
      ctx,
      { x: rect.x + 48 + halfWidth + 32, y: cardY, w: halfWidth, h: cardHeight },
      'code',
      'ПО КОДУ',
      'Договорись с другом и введите один и тот же код',
      Palette.gold,
      () => {
        this.panel = 'code';
        this.codeInput = '';
        this.sharedCode = '';
        this.context.audio.play('click');
      },
    );

    // Selected fighter, shown as a reminder of what they will be playing.
    const character = this.currentCharacter;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.label, 'ui', 600);
    ctx.fillStyle = Palette.ash400;
    ctx.fillText('ТВОЙ БОЕЦ', rect.x + 48, rect.y + rect.h - 68);
    font(ctx, 38, 'display');
    ctx.fillStyle = character.visuals.rim;
    ctx.fillText(character.name, rect.x + 190, rect.y + rect.h - 66);
    ctx.restore();

    if (
      button(this.context.widgets, {
        id: 'lobby:character',
        rect: { x: rect.x + rect.w - 340, y: rect.y + rect.h - 100, w: 292, h: 66 },
        label: 'СМЕНИТЬ',
        glyph: 'user',
        accent: Palette.ash300,
      })
    ) {
      const unlocked = CHARACTERS.filter((c) => isUnlocked(c, this.context.progress.wins));
      this.characterIndex = (this.characterIndex + 1) % unlocked.length;
      this.context.audio.play('hover');
    }

    if (
      button(this.context.widgets, {
        id: 'lobby:back',
        rect: { x: 128, y: DESIGN_HEIGHT - 150, w: 220, h: 78 },
        label: 'НАЗАД',
        glyph: 'back',
        accent: Palette.ash400,
      })
    ) {
      this.goBack();
    }
  }

  private drawOptionCard(
    ctx: CanvasRenderingContext2D,
    rect: Rect,
    id: string,
    title: string,
    description: string,
    accent: string,
    onSelect: () => void,
  ): void {
    const pointer = this.context.widgets.pointer;
    const hovered =
      pointer.active &&
      pointer.x >= rect.x &&
      pointer.x <= rect.x + rect.w &&
      pointer.y >= rect.y &&
      pointer.y <= rect.y + rect.h;

    if (hovered) {
      this.context.widgets.setHover(`lobby:${id}`);
      if (pointer.pressed) onSelect();
    }

    ctx.save();
    if (hovered) ctx.translate(0, -6);

    ctx.fillStyle = hovered ? 'rgba(18, 22, 38, 0.95)' : 'rgba(9, 10, 19, 0.88)';
    chamferedRect(ctx, rect.x, rect.y, rect.w, rect.h, 20);
    ctx.fill();
    ctx.strokeStyle = hovered ? accent : 'rgba(255,255,255,0.08)';
    ctx.lineWidth = hovered ? 2.5 : 1.5;
    if (hovered) {
      ctx.shadowColor = accent;
      ctx.shadowBlur = 26;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    font(ctx, 48, 'display');
    ctx.fillStyle = hovered ? Palette.white : Palette.ash200;
    ctx.fillText(title, rect.x + 34, rect.y + 86);

    font(ctx, TypeScale.label + 1, 'ui', 500);
    ctx.fillStyle = Palette.ash400;
    wrap(ctx, description, rect.x + 34, rect.y + 130, rect.w - 68, 26);

    ctx.restore();
  }

  private drawQueue(ctx: CanvasRenderingContext2D): void {
    const rect: Rect = { x: (DESIGN_WIDTH - 720) / 2, y: 280, w: 720, h: 400 };
    panel(ctx, rect, 'поиск соперника', Palette.frost);

    spinner(ctx, DESIGN_WIDTH / 2, rect.y + 150, 44, this.elapsed, Palette.frost);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.heading, 'display');
    ctx.fillStyle = Palette.paper;
    ctx.fillText('ИЩЕМ СОПЕРНИКА', DESIGN_WIDTH / 2, rect.y + 236);

    font(ctx, TypeScale.body, 'ui', 500);
    ctx.fillStyle = Palette.ash400;
    ctx.fillText(
      this.queuePosition > 1 ? `Ты ${this.queuePosition}-й в очереди` : 'Ты первый в очереди',
      DESIGN_WIDTH / 2,
      rect.y + 278,
    );
    ctx.restore();

    if (
      button(this.context.widgets, {
        id: 'lobby:cancel',
        rect: { x: DESIGN_WIDTH / 2 - 150, y: rect.y + rect.h - 40, w: 300, h: 76 },
        label: 'ОТМЕНА',
        accent: Palette.ash300,
      })
    ) {
      this.cancel();
    }
  }

  /** Code entry: five slots plus a character grid sized for a hand cursor. */
  private drawCode(ctx: CanvasRenderingContext2D): void {
    const rect: Rect = { x: (DESIGN_WIDTH - 960) / 2, y: 220, w: 960, h: 600 };
    panel(ctx, rect, 'код комнаты', Palette.gold);

    if (this.sharedCode) {
      this.drawSharedCode(ctx, rect);
      return;
    }

    // Slots.
    const slotWidth = 92;
    const slotGap = 16;
    const totalWidth = slotWidth * 5 + slotGap * 4;
    const slotX = rect.x + (rect.w - totalWidth) / 2;
    const slotY = rect.y + 80;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 5; i++) {
      const x = slotX + i * (slotWidth + slotGap);
      const filled = i < this.codeInput.length;
      const active = i === this.codeInput.length;

      ctx.fillStyle = filled ? 'rgba(255, 194, 71, 0.14)' : 'rgba(255,255,255,0.05)';
      chamferedRect(ctx, x, slotY, slotWidth, 104, 12);
      ctx.fill();
      ctx.strokeStyle = active
        ? Palette.gold
        : filled
          ? alpha(Palette.gold, 0.5)
          : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = active ? 2.5 : 1.5;
      ctx.stroke();

      if (filled) {
        font(ctx, 62, 'display');
        ctx.fillStyle = Palette.white;
        ctx.fillText(this.codeInput[i], x + slotWidth / 2, slotY + 54);
      } else if (active) {
        // Blinking caret.
        const blink = Math.sin(this.elapsed * 6) > 0 ? 1 : 0.15;
        ctx.globalAlpha = blink;
        ctx.fillStyle = Palette.gold;
        ctx.fillRect(x + slotWidth / 2 - 1.5, slotY + 32, 3, 44);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();

    // Character grid.
    const columns = 8;
    const cellSize = 84;
    const cellGap = 10;
    const gridWidth = columns * cellSize + (columns - 1) * cellGap;
    const gridX = rect.x + (rect.w - gridWidth) / 2;
    const gridY = slotY + 150;

    for (let i = 0; i < ALPHABET.length; i++) {
      const column = i % columns;
      const row = Math.floor(i / columns);
      const cell: Rect = {
        x: gridX + column * (cellSize + cellGap),
        y: gridY + row * (cellSize + cellGap),
        w: cellSize,
        h: cellSize,
      };
      this.drawKey(ctx, cell, ALPHABET[i], `key:${ALPHABET[i]}`, () => {
        if (this.codeInput.length < 5) {
          this.codeInput += ALPHABET[i];
          this.context.audio.play('click');
        }
      });
    }

    const actionY = gridY + 4 * (cellSize + cellGap) + 12;
    this.drawKey(
      ctx,
      { x: gridX, y: actionY, w: cellSize * 2 + cellGap, h: 68 },
      'СТЕРЕТЬ',
      'key:del',
      () => {
        this.codeInput = this.codeInput.slice(0, -1);
        this.context.audio.play('back');
      },
      Palette.ash300,
    );

    if (
      button(this.context.widgets, {
        id: 'lobby:join',
        rect: { x: gridX + gridWidth - 320, y: actionY, w: 320, h: 68 },
        label: 'ПОДКЛЮЧИТЬСЯ',
        primary: true,
        accent: Palette.gold,
        disabled: !isValidRoomCode(this.codeInput),
      })
    ) {
      this.net?.queue(this.currentCharacter.id, this.codeInput);
    }

    if (
      button(this.context.widgets, {
        id: 'lobby:code-back',
        rect: { x: 128, y: DESIGN_HEIGHT - 150, w: 220, h: 78 },
        label: 'НАЗАД',
        glyph: 'back',
        accent: Palette.ash400,
      })
    ) {
      this.cancel();
    }
  }

  private drawKey(
    ctx: CanvasRenderingContext2D,
    rect: Rect,
    label: string,
    id: string,
    onPress: () => void,
    accent: string = Palette.gold,
  ): void {
    const pointer = this.context.widgets.pointer;
    const hovered =
      pointer.active &&
      pointer.x >= rect.x &&
      pointer.x <= rect.x + rect.w &&
      pointer.y >= rect.y &&
      pointer.y <= rect.y + rect.h;

    if (hovered) {
      this.context.widgets.setHover(id);
      if (pointer.pressed) onPress();
    }

    ctx.save();
    ctx.fillStyle = hovered ? mix('#141626', accent, 0.28) : 'rgba(12, 13, 22, 0.9)';
    chamferedRect(ctx, rect.x, rect.y, rect.w, rect.h, 10);
    ctx.fill();
    ctx.strokeStyle = hovered ? accent : 'rgba(255,255,255,0.09)';
    ctx.lineWidth = hovered ? 2 : 1.25;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, label.length > 2 ? TypeScale.label : 40, label.length > 2 ? 'ui' : 'display', 700);
    ctx.fillStyle = hovered ? Palette.white : Palette.ash200;
    ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
    ctx.restore();

    // Dwell feedback on the key itself.
    if (hovered && pointer.dwell > 0.01) {
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(
        rect.x + rect.w / 2,
        rect.y + rect.h / 2,
        rect.h * 0.46,
        -Math.PI / 2,
        -Math.PI / 2 + TAU * pointer.dwell,
      );
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Shown to the player who created the room: the code to read out. */
  private drawSharedCode(ctx: CanvasRenderingContext2D, rect: Rect): void {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    font(ctx, TypeScale.body, 'ui', 500);
    ctx.fillStyle = Palette.ash300;
    ctx.fillText('Продиктуй этот код другу', DESIGN_WIDTH / 2, rect.y + 120);

    font(ctx, 150, 'display');
    ctx.letterSpacing = '0.14em';
    ctx.fillStyle = Palette.gold;
    ctx.shadowColor = Palette.gold;
    ctx.shadowBlur = 40;
    ctx.fillText(this.sharedCode, DESIGN_WIDTH / 2, rect.y + 260);
    ctx.shadowBlur = 0;
    ctx.letterSpacing = '0px';

    spinner(ctx, DESIGN_WIDTH / 2, rect.y + 390, 30, this.elapsed, Palette.gold);

    font(ctx, TypeScale.label, 'ui', 500);
    ctx.fillStyle = Palette.ash400;
    ctx.fillText('Ждём, пока он подключится…', DESIGN_WIDTH / 2, rect.y + 460);
    ctx.restore();

    if (
      button(this.context.widgets, {
        id: 'lobby:shared-cancel',
        rect: { x: DESIGN_WIDTH / 2 - 150, y: rect.y + rect.h - 40, w: 300, h: 76 },
        label: 'ОТМЕНА',
        accent: Palette.ash300,
      })
    ) {
      this.cancel();
    }
  }

  private drawMatched(ctx: CanvasRenderingContext2D): void {
    const match = this.net?.match;
    const opponent = match ? getCharacter(match.opponent.character) : getCharacter('kai');
    const player = this.currentCharacter;
    const t = Ease.out(clamp(this.elapsed / 0.6, 0, 1));

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    font(ctx, TypeScale.heading, 'display');
    ctx.fillStyle = Palette.frost;
    ctx.globalAlpha = t;
    ctx.fillText('СОПЕРНИК НАЙДЕН', DESIGN_WIDTH / 2, 300);

    // The two names slide in from opposite sides and meet in the middle.
    const slide = (1 - t) * 260;

    ctx.textAlign = 'right';
    font(ctx, 88, 'display');
    ctx.fillStyle = player.visuals.rim;
    ctx.fillText(player.name, DESIGN_WIDTH / 2 - 110 - slide, 430);

    ctx.textAlign = 'left';
    ctx.fillStyle = opponent.visuals.rim;
    ctx.fillText(opponent.name, DESIGN_WIDTH / 2 + 110 + slide, 430);

    ctx.textAlign = 'center';
    font(ctx, 62, 'display');
    ctx.fillStyle = Palette.ash300;
    ctx.fillText('VS', DESIGN_WIDTH / 2, 430);

    font(ctx, TypeScale.body, 'ui', 500);
    ctx.fillStyle = Palette.ash400;
    ctx.fillText(match?.opponent.name ?? '', DESIGN_WIDTH / 2, 500);

    ctx.restore();
  }

  private drawStatus(ctx: CanvasRenderingContext2D): void {
    const net = this.net;
    ctx.save();
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.micro, 'ui', 600);

    const y = DESIGN_HEIGHT - 110;
    const connected = this.connection === 'connected' || this.connection === 'queued' || this.connection === 'matched';
    ctx.fillStyle = connected ? Palette.venom : Palette.gold;
    ctx.beginPath();
    ctx.arc(DESIGN_WIDTH - 340, y, 6, 0, TAU);
    ctx.fill();

    ctx.fillStyle = Palette.ash400;
    const latency = net ? ` · ${net.latency.toFixed(0)} мс` : '';
    ctx.fillText(`${this.statusMessage}${connected ? latency : ''}`, DESIGN_WIDTH - 128, y);

    if (this.errorMessage) {
      ctx.fillStyle = Palette.rose;
      ctx.fillText(this.errorMessage, DESIGN_WIDTH - 128, y + 24);
    }
    ctx.restore();
  }
}

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  idle: 'не подключено',
  connecting: 'подключение…',
  connected: 'на связи',
  queued: 'в очереди',
  matched: 'соперник найден',
  playing: 'в бою',
  reconnecting: 'переподключение…',
  failed: 'нет связи с сервером',
};

function wrap(
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
