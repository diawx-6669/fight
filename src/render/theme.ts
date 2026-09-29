/**
 * Visual language.
 *
 * One palette, one type scale, one set of easing curves, used by every screen.
 * The game is almost entirely canvas-drawn, so none of this can come from CSS —
 * but the discipline is the same as a stylesheet's: if a colour is not in this
 * file, it does not appear on screen.
 */

export const Palette = {
  // Neutrals — the ink the whole game is drawn in.
  ink900: '#04040a',
  ink800: '#07070d',
  ink700: '#0c0d16',
  ink600: '#141626',
  ink500: '#1e2236',
  ink400: '#2c3147',

  ash500: '#3f465c',
  ash400: '#5a6076',
  ash300: '#8a91a8',
  ash200: '#c3c8d8',
  paper: '#f2f4fb',
  white: '#ffffff',

  // Accents.
  ember: '#ff5a2b',
  emberSoft: '#ff8a5c',
  blood: '#d92b3f',
  bloodDeep: '#8f1424',
  frost: '#35d6ff',
  frostSoft: '#8ceaff',
  venom: '#9dff4f',
  gold: '#ffc247',
  violet: '#a874ff',
  rose: '#ff4d6d',
} as const;

/** Semantic colours, so a change of intent is a one-line edit. */
export const Semantic = {
  playerAccent: Palette.ember,
  opponentAccent: Palette.frost,
  health: Palette.ember,
  healthLost: Palette.blood,
  healthCritical: Palette.rose,
  stamina: Palette.frostSoft,
  staminaLow: Palette.gold,
  meter: Palette.gold,
  meterFull: Palette.white,
  danger: Palette.rose,
  success: Palette.venom,
  hudBackdrop: 'rgba(4, 4, 10, 0.72)',
  hudBorder: 'rgba(255, 255, 255, 0.1)',
} as const;

export const Fonts = {
  // Both faces cover Cyrillic, which the previous pairing did not — every
  // Russian word in the game was falling back to a system sans.
  display: "'Oswald', 'Arial Narrow', sans-serif",
  ui: "'Exo 2', 'Segoe UI', system-ui, sans-serif",
} as const;

/** Type scale in CSS pixels at a 1080p reference height, scaled by the renderer. */
export const TypeScale = {
  hero: 96,
  title: 56,
  heading: 34,
  subheading: 24,
  body: 18,
  label: 14,
  micro: 11,
} as const;

/** Easing curves. Named for what they are for, not for their formula. */
export const Ease = {
  /** Enters decisively, settles gently. The default for anything appearing. */
  out: (t: number): number => 1 - Math.pow(1 - t, 3),
  /** Starts slowly, commits. For anything leaving. */
  in: (t: number): number => t * t * t,
  /** Symmetric. For anything that moves and comes back. */
  inOut: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  /** Overshoots slightly — for impact numbers and score pops. */
  back: (t: number): number => {
    const c = 1.7;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  },
  /** Bounces to a stop. For the round counter. */
  elastic: (t: number): number => {
    if (t === 0 || t === 1) return t;
    const p = 0.36;
    return Math.pow(2, -10 * t) * Math.sin(((t - p / 4) * (2 * Math.PI)) / p) + 1;
  },
} as const;

/** Parses `#rrggbb` into components. Cached, because it is called per particle. */
const rgbCache = new Map<string, [number, number, number]>();

export function toRgb(hex: string): [number, number, number] {
  const cached = rgbCache.get(hex);
  if (cached) return cached;

  let value = hex.replace('#', '');
  if (value.length === 3) {
    value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
  }
  const int = parseInt(value, 16);
  const rgb: [number, number, number] = [(int >> 16) & 255, (int >> 8) & 255, int & 255];
  rgbCache.set(hex, rgb);
  return rgb;
}

/** `rgba()` string from a hex colour and an alpha. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = toRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Linear blend between two hex colours, returned as `rgb()`. */
export function mix(from: string, to: string, t: number): string {
  const [r1, g1, b1] = toRgb(from);
  const [r2, g2, b2] = toRgb(to);
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return `rgb(${Math.round(r1 + (r2 - r1) * clamped)}, ${Math.round(
    g1 + (g2 - g1) * clamped,
  )}, ${Math.round(b1 + (b2 - b1) * clamped)})`;
}

/** Brightens or darkens a colour. Positive lightens, negative darkens. */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = toRgb(hex);
  const adjust = (channel: number) => {
    const value = amount >= 0 ? channel + (255 - channel) * amount : channel * (1 + amount);
    return Math.round(Math.max(0, Math.min(255, value)));
  };
  return `rgb(${adjust(r)}, ${adjust(g)}, ${adjust(b)})`;
}

/** Sets a canvas font from the scale, with a weight for the UI face. */
export function font(
  ctx: CanvasRenderingContext2D,
  size: number,
  face: 'display' | 'ui' = 'ui',
  weight = 600,
): void {
  ctx.font =
    face === 'display'
      ? `${size}px ${Fonts.display}`
      : `${weight} ${size}px ${Fonts.ui}`;
}
