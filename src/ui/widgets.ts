import { clamp, damp, lerp, TAU } from '@/core/math';
import { alpha, Ease, font, mix, Palette, Semantic, TypeScale } from '@/render/theme';
import type { PointerState } from './cursor';

/**
 * Canvas widgets.
 *
 * An immediate-mode toolkit: each widget is a function called during draw that
 * both paints itself and reports whether it was activated. There is no retained
 * tree, no layout engine and no event plumbing — with a dozen screens, the
 * bookkeeping of a retained system would cost far more than it saved.
 *
 * Two constraints shaped everything here, and both come from the hand cursor:
 *
 * **Targets must be large.** A hand-tracked pointer has roughly 15–20 px of
 * jitter at arm's length. Nothing interactive is smaller than 64 px tall, and
 * most things are 90.
 *
 * **Hover must be unmistakable.** With a dwell click, the player is asking
 * "am I on it yet?" continuously. Every widget answers with motion, not just
 * colour: it lifts, it brightens, and its dwell ring fills.
 */

export interface WidgetContext {
  ctx: CanvasRenderingContext2D;
  pointer: PointerState;
  /** Seconds since the previous frame. */
  dt: number;
  /** Called with the id under the cursor, so the gesture layer can dwell. */
  setHover: (id: string | null) => void;
  /** Play a UI sound. */
  sound?: (name: 'hover' | 'click' | 'back' | 'error') => void;
}

/** Per-widget animation state, keyed by id and kept between frames. */
interface WidgetAnim {
  hover: number;
  press: number;
  /** Whether the cursor was over this widget last frame. */
  wasHovered: boolean;
}

const animations = new Map<string, WidgetAnim>();
/** Ids touched this frame, so stale entries can be dropped. */
let touchedThisFrame = new Set<string>();

export function beginWidgetFrame(): void {
  touchedThisFrame = new Set<string>();
}

export function endWidgetFrame(): void {
  // Drop state for widgets that no longer exist, or the map grows forever as
  // the player moves between screens.
  for (const key of animations.keys()) {
    if (!touchedThisFrame.has(key)) animations.delete(key);
  }
}

function anim(id: string, dt: number, hovered: boolean, pressed: boolean): WidgetAnim {
  touchedThisFrame.add(id);
  let state = animations.get(id);
  if (!state) {
    state = { hover: 0, press: 0, wasHovered: false };
    animations.set(id, state);
  }
  state.hover = damp(state.hover, hovered ? 1 : 0, 0.07, dt);
  state.press = damp(state.press, pressed ? 1 : 0, 0.04, dt);
  return state;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function hitTest(rect: Rect, pointer: PointerState): boolean {
  return (
    pointer.active &&
    pointer.x >= rect.x &&
    pointer.x <= rect.x + rect.w &&
    pointer.y >= rect.y &&
    pointer.y <= rect.y + rect.h
  );
}

// --- primitives -------------------------------------------------------------

export function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * The angular plate every panel and button is built from.
 * A chamfered corner reads as "fighting game" in a way a rounded one does not.
 */
export function chamferedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  cut: number,
): void {
  const c = Math.min(cut, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

/** Dwell ring drawn around a hovered widget. */
function drawDwell(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  progress: number,
): void {
  if (progress <= 0.01) return;

  const inset = 3;
  const perimeter = (rect.w + rect.h - inset * 4) * 2;
  ctx.save();
  ctx.strokeStyle = Palette.gold;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.shadowColor = Palette.gold;
  ctx.shadowBlur = 10;
  ctx.setLineDash([perimeter * progress, perimeter]);
  chamferedRect(ctx, rect.x + inset, rect.y + inset, rect.w - inset * 2, rect.h - inset * 2, 12);
  ctx.stroke();
  ctx.restore();
}

// --- widgets ----------------------------------------------------------------

export interface ButtonOptions {
  id: string;
  rect: Rect;
  label: string;
  /** Optional second line, smaller and dimmer. */
  hint?: string;
  accent?: string;
  disabled?: boolean;
  /** Draws as the primary call to action. */
  primary?: boolean;
  /** Icon glyph drawn to the left of the label. */
  glyph?: 'play' | 'back' | 'gear' | 'user' | 'globe' | 'target' | 'trophy' | 'camera';
  /** Label alignment. Defaults to left, which suits menu rows. */
  align?: 'left' | 'center';
}

export function button(context: WidgetContext, options: ButtonOptions): boolean {
  const { ctx, pointer, dt } = context;
  const { rect, id } = options;
  const accent = options.accent ?? (options.primary ? Palette.ember : Palette.ash300);
  const disabled = options.disabled ?? false;

  const hovered = !disabled && hitTest(rect, pointer);
  const state = anim(id, dt, hovered, hovered && pointer.down);

  if (hovered) {
    context.setHover(id);
    if (!state.wasHovered) context.sound?.('hover');
  }
  const activated = hovered && pointer.pressed;
  state.wasHovered = hovered;
  if (activated) context.sound?.('click');

  // Lift on hover, sink on press: the only two verbs a button needs.
  const lift = state.hover * 6 - state.press * 4;
  const x = rect.x;
  const y = rect.y - lift;

  ctx.save();
  ctx.globalAlpha = disabled ? 0.34 : 1;

  // Plate.
  const fill = ctx.createLinearGradient(x, y, x, y + rect.h);
  if (options.primary) {
    fill.addColorStop(0, mix(accent, Palette.white, 0.16 + state.hover * 0.14));
    fill.addColorStop(1, mix(accent, Palette.ink900, 0.28));
  } else {
    fill.addColorStop(0, mix(Palette.ink600, Palette.ink500, state.hover));
    fill.addColorStop(1, Palette.ink800);
  }
  ctx.fillStyle = fill;
  chamferedRect(ctx, x, y, rect.w, rect.h, 14);
  ctx.fill();

  // Edge.
  ctx.strokeStyle = options.primary
    ? alpha(Palette.white, 0.28 + state.hover * 0.3)
    : alpha(accent, 0.24 + state.hover * 0.5);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Accent bar down the left edge, brightening on hover. It costs four pixels
  // and it is what makes a row of buttons scannable.
  ctx.fillStyle = accent;
  ctx.globalAlpha *= 0.55 + state.hover * 0.45;
  ctx.fillRect(x, y + 10, 4, rect.h - 20);
  ctx.globalAlpha = disabled ? 0.34 : 1;

  if (state.hover > 0.02 && !disabled) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = state.hover * 0.14;
    ctx.fillStyle = accent;
    chamferedRect(ctx, x, y, rect.w, rect.h, 14);
    ctx.fill();
    ctx.restore();
  }

  // Label.
  const centered = options.align === 'center' || (!options.hint && !options.glyph);
  const leftPad = 34 + (options.glyph ? 40 : 0);
  const textX = centered ? x + rect.w / 2 : x + leftPad;
  const available = rect.w - (centered ? 32 : leftPad + 24);

  ctx.textAlign = centered ? 'center' : 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = options.primary ? Palette.white : mix(Palette.ash200, Palette.white, state.hover);

  // Shrink to fit rather than spilling past the plate. A label that runs off
  // the edge of its own button is the single most obvious sign of a UI that
  // was never looked at.
  fitText(
    ctx,
    options.label,
    options.hint ? TypeScale.subheading : TypeScale.heading,
    available,
    'display',
  );
  ctx.fillText(options.label, textX, options.hint ? y + rect.h / 2 - 12 : y + rect.h / 2 + 1);

  if (options.hint) {
    fitText(ctx, options.hint, TypeScale.label, available, 'ui', 500);
    ctx.fillStyle = Palette.ash400;
    ctx.fillText(options.hint, textX, y + rect.h / 2 + 18);
  }

  if (options.glyph) {
    drawGlyph(ctx, options.glyph, x + 46, y + rect.h / 2, 16, accent);
  }

  ctx.restore();

  if (hovered) drawDwell(ctx, { ...rect, y }, pointer.dwell);
  return activated;
}

export interface SliderOptions {
  id: string;
  rect: Rect;
  label: string;
  value: number;
  min: number;
  max: number;
  /** Formats the value for display. */
  format?: (value: number) => string;
  /** Snap increments; omit for continuous. */
  step?: number;
  accent?: string;
}

/** Returns the new value, or the old one when untouched. */
export function slider(context: WidgetContext, options: SliderOptions): number {
  const { ctx, pointer, dt } = context;
  const { rect, id } = options;
  const accent = options.accent ?? Palette.ember;

  const trackY = rect.y + rect.h - 22;
  const trackHeight = 10;
  // The grab area is the whole widget, not just the 10px track — essential
  // with a hand cursor.
  const hovered = hitTest(rect, pointer);
  const state = anim(id, dt, hovered, hovered && pointer.down);

  if (hovered) context.setHover(id);

  let value = options.value;
  if (hovered && pointer.down) {
    const t = clamp((pointer.x - rect.x) / rect.w, 0, 1);
    value = options.min + t * (options.max - options.min);
    if (options.step) value = Math.round(value / options.step) * options.step;
    value = clamp(value, options.min, options.max);
  }

  const ratio = clamp((value - options.min) / (options.max - options.min), 0, 1);

  ctx.save();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  font(ctx, TypeScale.body, 'ui', 600);
  ctx.fillStyle = mix(Palette.ash300, Palette.white, state.hover);
  ctx.fillText(options.label, rect.x, rect.y + 20);

  ctx.textAlign = 'right';
  ctx.fillStyle = accent;
  font(ctx, TypeScale.body, 'ui', 700);
  ctx.fillText(
    options.format ? options.format(value) : value.toFixed(2),
    rect.x + rect.w,
    rect.y + 20,
  );

  // Track.
  ctx.fillStyle = alpha(Palette.white, 0.08);
  roundedRect(ctx, rect.x, trackY, rect.w, trackHeight, trackHeight / 2);
  ctx.fill();

  // Fill.
  ctx.fillStyle = accent;
  if (ratio > 0.001) {
    roundedRect(ctx, rect.x, trackY, rect.w * ratio, trackHeight, trackHeight / 2);
    ctx.fill();
  }

  // Handle.
  const handleX = rect.x + rect.w * ratio;
  const handleRadius = 13 + state.hover * 4;
  ctx.fillStyle = Palette.white;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 12 + state.hover * 14;
  ctx.beginPath();
  ctx.arc(handleX, trackY + trackHeight / 2, handleRadius, 0, TAU);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.restore();
  return value;
}

export interface ToggleOptions {
  id: string;
  rect: Rect;
  label: string;
  hint?: string;
  value: boolean;
  accent?: string;
}

export function toggle(context: WidgetContext, options: ToggleOptions): boolean {
  const { ctx, pointer, dt } = context;
  const { rect, id } = options;
  const accent = options.accent ?? Palette.ember;

  const hovered = hitTest(rect, pointer);
  const state = anim(id, dt, hovered, hovered && pointer.down);
  if (hovered) context.setHover(id);

  const activated = hovered && pointer.pressed;
  if (activated) context.sound?.('click');
  const value = activated ? !options.value : options.value;

  const switchWidth = 74;
  const switchHeight = 36;
  const switchX = rect.x + rect.w - switchWidth;
  const switchY = rect.y + (rect.h - switchHeight) / 2;

  ctx.save();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  font(ctx, TypeScale.body, 'ui', 600);
  ctx.fillStyle = mix(Palette.ash200, Palette.white, state.hover);
  ctx.fillText(options.label, rect.x, options.hint ? rect.y + rect.h / 2 - 11 : rect.y + rect.h / 2);

  if (options.hint) {
    font(ctx, TypeScale.micro, 'ui', 500);
    ctx.fillStyle = Palette.ash400;
    ctx.fillText(options.hint, rect.x, rect.y + rect.h / 2 + 12);
  }

  // The switch itself. The travel of the knob is the feedback.
  const t = animations.get(`${id}:knob`) ?? { hover: value ? 1 : 0, press: 0, wasHovered: false };
  animations.set(`${id}:knob`, t);
  touchedThisFrame.add(`${id}:knob`);
  t.hover = damp(t.hover, value ? 1 : 0, 0.05, dt);

  ctx.fillStyle = mix(alpha(Palette.white, 0.1), accent, t.hover);
  roundedRect(ctx, switchX, switchY, switchWidth, switchHeight, switchHeight / 2);
  ctx.fill();

  ctx.strokeStyle = alpha(Palette.white, 0.16 + state.hover * 0.3);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const knobX = lerp(switchX + switchHeight / 2, switchX + switchWidth - switchHeight / 2, t.hover);
  ctx.fillStyle = Palette.white;
  ctx.shadowColor = value ? accent : 'transparent';
  ctx.shadowBlur = value ? 12 : 0;
  ctx.beginPath();
  ctx.arc(knobX, switchY + switchHeight / 2, switchHeight / 2 - 5, 0, TAU);
  ctx.fill();

  ctx.restore();

  if (hovered) drawDwell(ctx, rect, pointer.dwell);
  return value;
}

export interface SegmentedOptions {
  id: string;
  rect: Rect;
  label?: string;
  options: readonly { label: string; value: string }[];
  value: string;
  accent?: string;
}

/** A row of exclusive choices — difficulty, rounds, quality. */
export function segmented(context: WidgetContext, config: SegmentedOptions): string {
  const { ctx, pointer, dt } = context;
  const accent = config.accent ?? Palette.ember;
  const { rect } = config;

  let result = config.value;
  const labelHeight = config.label ? 28 : 0;

  if (config.label) {
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    font(ctx, TypeScale.body, 'ui', 600);
    ctx.fillStyle = Palette.ash300;
    ctx.fillText(config.label, rect.x, rect.y + 18);
    ctx.restore();
  }

  const count = config.options.length;
  const gap = 8;
  const itemWidth = (rect.w - gap * (count - 1)) / count;
  const itemY = rect.y + labelHeight;
  const itemHeight = rect.h - labelHeight;

  for (let i = 0; i < count; i++) {
    const option = config.options[i];
    const itemRect: Rect = {
      x: rect.x + i * (itemWidth + gap),
      y: itemY,
      w: itemWidth,
      h: itemHeight,
    };
    const id = `${config.id}:${option.value}`;
    const selected = option.value === config.value;
    const hovered = hitTest(itemRect, pointer);
    const state = anim(id, dt, hovered, hovered && pointer.down);

    if (hovered) context.setHover(id);
    if (hovered && pointer.pressed) {
      result = option.value;
      context.sound?.('click');
    }

    ctx.save();
    ctx.fillStyle = selected
      ? mix(accent, Palette.ink900, 0.38)
      : mix(Palette.ink700, Palette.ink600, state.hover);
    chamferedRect(ctx, itemRect.x, itemRect.y, itemRect.w, itemRect.h, 10);
    ctx.fill();

    ctx.strokeStyle = selected
      ? accent
      : alpha(Palette.white, 0.1 + state.hover * 0.28);
    ctx.lineWidth = selected ? 2 : 1.25;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    font(ctx, TypeScale.label + 3, 'ui', 700);
    ctx.fillStyle = selected ? Palette.white : mix(Palette.ash300, Palette.white, state.hover);
    ctx.fillText(option.label, itemRect.x + itemWidth / 2, itemRect.y + itemHeight / 2);
    ctx.restore();

    if (hovered) drawDwell(ctx, itemRect, pointer.dwell);
  }

  return result;
}

// --- decoration -------------------------------------------------------------

/** A titled panel. */
export function panel(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  title?: string,
  accent: string = Palette.ember,
): void {
  ctx.save();
  ctx.fillStyle = 'rgba(6, 7, 14, 0.82)';
  chamferedRect(ctx, rect.x, rect.y, rect.w, rect.h, 20);
  ctx.fill();

  ctx.strokeStyle = alpha(Palette.white, 0.08);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // A short accent rule at the top-left corner: enough to anchor the panel
  // without drawing a full frame around it.
  ctx.fillStyle = accent;
  ctx.fillRect(rect.x, rect.y, 78, 3);

  if (title) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    font(ctx, TypeScale.label, 'ui', 700);
    ctx.fillStyle = Palette.ash400;
    ctx.letterSpacing = '0.22em';
    ctx.fillText(title.toUpperCase(), rect.x + 28, rect.y + 44);
    ctx.letterSpacing = '0px';
  }

  ctx.restore();
}

/** A section heading with a rule running off to the right. */
export function sectionTitle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  text: string,
  accent: string = Palette.ember,
): void {
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  font(ctx, TypeScale.heading, 'display');
  ctx.fillStyle = Palette.paper;
  ctx.fillText(text, x, y);

  const textWidth = ctx.measureText(text).width;
  const lineStart = x + textWidth + 22;
  const gradient = ctx.createLinearGradient(lineStart, y, x + width, y);
  gradient.addColorStop(0, alpha(accent, 0.6));
  gradient.addColorStop(1, alpha(accent, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(lineStart, y - 1, Math.max(0, x + width - lineStart), 2);
  ctx.restore();
}

/** Small monochrome glyphs, drawn rather than loaded as an icon font. */
export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: NonNullable<ButtonOptions['glyph']>,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (glyph) {
    case 'play':
      ctx.beginPath();
      ctx.moveTo(-size * 0.4, -size * 0.6);
      ctx.lineTo(size * 0.7, 0);
      ctx.lineTo(-size * 0.4, size * 0.6);
      ctx.closePath();
      ctx.fill();
      break;

    case 'back':
      ctx.beginPath();
      ctx.moveTo(size * 0.4, -size * 0.6);
      ctx.lineTo(-size * 0.4, 0);
      ctx.lineTo(size * 0.4, size * 0.6);
      ctx.stroke();
      break;

    case 'gear': {
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.4, 0, TAU);
      ctx.stroke();
      for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * TAU;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * size * 0.55, Math.sin(angle) * size * 0.55);
        ctx.lineTo(Math.cos(angle) * size * 0.85, Math.sin(angle) * size * 0.85);
        ctx.stroke();
      }
      break;
    }

    case 'user':
      ctx.beginPath();
      ctx.arc(0, -size * 0.35, size * 0.32, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, size * 0.75, size * 0.62, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
      break;

    case 'globe':
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.75, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, 0, size * 0.34, size * 0.75, 0, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-size * 0.75, 0);
      ctx.lineTo(size * 0.75, 0);
      ctx.stroke();
      break;

    case 'target':
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.75, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.34, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.08, 0, TAU);
      ctx.fill();
      break;

    case 'trophy':
      ctx.beginPath();
      ctx.moveTo(-size * 0.45, -size * 0.7);
      ctx.lineTo(size * 0.45, -size * 0.7);
      ctx.lineTo(size * 0.32, size * 0.1);
      ctx.lineTo(-size * 0.32, size * 0.1);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, size * 0.1);
      ctx.lineTo(0, size * 0.5);
      ctx.moveTo(-size * 0.4, size * 0.75);
      ctx.lineTo(size * 0.4, size * 0.75);
      ctx.stroke();
      break;

    case 'camera':
      ctx.strokeRect(-size * 0.75, -size * 0.5, size * 1.5, size);
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.3, 0, TAU);
      ctx.stroke();
      break;
  }

  ctx.restore();
}

/** Progress arc used by loading states. */
export function spinner(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  time: number,
  color: string = Palette.ember,
): void {
  ctx.save();
  ctx.strokeStyle = alpha(color, 0.18);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.stroke();

  const start = time * 2.4;
  const sweep = 0.6 + Math.sin(time * 2) * 0.45;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(x, y, radius, start, start + sweep * Math.PI);
  ctx.stroke();
  ctx.restore();
}

/** A labelled stat bar, used on the character select. */
export function statBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  label: string,
  value: number,
  accent: string,
  animated: number,
): void {
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  font(ctx, TypeScale.micro, 'ui', 700);
  ctx.fillStyle = Palette.ash400;
  ctx.letterSpacing = '0.16em';
  ctx.fillText(label, x, y);
  ctx.letterSpacing = '0px';

  const barX = x + 132;
  const barWidth = width - 132;
  const segments = 10;
  const gap = 3;
  const segmentWidth = (barWidth - gap * (segments - 1)) / segments;
  const filled = value * segments * animated;

  for (let i = 0; i < segments; i++) {
    const amount = clamp(filled - i, 0, 1);
    ctx.fillStyle =
      amount > 0 ? mix(Semantic.hudBorder, accent, amount) : 'rgba(255, 255, 255, 0.07)';
    ctx.fillRect(barX + i * (segmentWidth + gap), y - 5, segmentWidth, 10);
  }

  ctx.restore();
}

/**
 * Sets a font size that makes `text` fit within `maxWidth`, down to a floor.
 * Returns the size actually used.
 */
export function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  preferred: number,
  maxWidth: number,
  face: 'display' | 'ui' = 'display',
  weight = 700,
): number {
  let size = preferred;
  font(ctx, size, face, weight);
  if (maxWidth <= 0) return size;

  let width = ctx.measureText(text).width;
  // A handful of steps is plenty; below 62% of the intended size the label is
  // unreadable anyway and the layout is what needs fixing.
  while (width > maxWidth && size > preferred * 0.62) {
    size -= Math.max(1, preferred * 0.06);
    font(ctx, size, face, weight);
    width = ctx.measureText(text).width;
  }
  return size;
}

/** Fades a whole screen in or out; returns the alpha to use. */
export function screenFade(elapsed: number, duration = 0.32): number {
  return Ease.out(clamp(elapsed / duration, 0, 1));
}
