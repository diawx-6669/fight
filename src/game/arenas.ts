import { Rng, hashSeed } from '@/core/rng';

/**
 * Arenas.
 *
 * Every background is generated rather than drawn: a seeded random walk builds
 * a skyline, a temple roofline or a forest canopy, and the renderer paints the
 * resulting polygon as a flat silhouette. That keeps the whole game a single
 * bundle with no image assets, and it means each arena is a handful of numbers
 * instead of a megabyte of PNG.
 *
 * It also happens to be the right art direction. A shadow duel wants the world
 * behind it to be shapes and light, nothing more — a photographic background
 * would fight the fighters for attention and win.
 */

export type LayerShape = 'mountains' | 'skyline' | 'forest' | 'temple' | 'dunes' | 'ruins' | 'waves';

export interface ArenaLayer {
  readonly shape: LayerShape;
  /** How fast this layer scrolls relative to the camera, `0` = infinitely far. */
  readonly parallax: number;
  /** Baseline height as a fraction of the viewport, measured from the bottom. */
  readonly baseline: number;
  /** Peak-to-trough variation, as a fraction of the viewport. */
  readonly amplitude: number;
  /** Horizontal feature density; higher means more, narrower features. */
  readonly density: number;
  /** Fill colour. */
  readonly color: string;
  /** Extra atmospheric haze blended over this layer, `[0, 1]`. */
  readonly haze: number;
}

export interface ArenaLighting {
  /** Sky gradient, top to bottom. */
  readonly skyTop: string;
  readonly skyMid: string;
  readonly skyBottom: string;
  /** The big light source behind the fighters. */
  readonly sun: string;
  readonly sunRadius: number;
  /** Where the sun sits, in viewport fractions. */
  readonly sunX: number;
  readonly sunY: number;
  /** Colour the fighters are rim-lit with. */
  readonly rim: string;
  /** Ground plane colour. */
  readonly ground: string;
  /** Fog colour drifting across the floor. */
  readonly fog: string;
  /** Overall exposure multiplier for post-processing. */
  readonly exposure: number;
}

export type WeatherKind = 'none' | 'rain' | 'snow' | 'embers' | 'petals' | 'dust';

export interface Arena {
  readonly id: string;
  readonly name: string;
  readonly subtitle: string;
  readonly layers: readonly ArenaLayer[];
  readonly lighting: ArenaLighting;
  readonly weather: WeatherKind;
  /** Particles per second for the weather system. */
  readonly weatherDensity: number;
  /** Musical key the generative soundtrack uses here. */
  readonly musicalRoot: number;
  readonly musicalMode: 'minor' | 'dorian' | 'phrygian' | 'aeolian';
  readonly unlockWins: number;
}

export const ARENAS: readonly Arena[] = [
  {
    id: 'dusk-temple',
    name: 'ХРАМ НА ЗАКАТЕ',
    subtitle: 'Там, где тени длиннее людей',
    layers: [
      { shape: 'mountains', parallax: 0.04, baseline: 0.42, amplitude: 0.2, density: 0.5, color: '#2a1d2e', haze: 0.55 },
      { shape: 'mountains', parallax: 0.1, baseline: 0.34, amplitude: 0.16, density: 0.8, color: '#1e1524', haze: 0.35 },
      { shape: 'temple', parallax: 0.2, baseline: 0.3, amplitude: 0.22, density: 1.1, color: '#150f1c', haze: 0.2 },
      { shape: 'forest', parallax: 0.38, baseline: 0.22, amplitude: 0.12, density: 2.4, color: '#0d0a13', haze: 0.08 },
      { shape: 'ruins', parallax: 0.66, baseline: 0.14, amplitude: 0.1, density: 1.6, color: '#07050b', haze: 0 },
    ],
    lighting: {
      skyTop: '#1b1030',
      skyMid: '#5c2244',
      skyBottom: '#ff7a3d',
      sun: '#ffb45c',
      sunRadius: 0.16,
      sunX: 0.62,
      sunY: 0.58,
      rim: '#ff9a5c',
      ground: '#0a0710',
      fog: '#4a2a3e',
      exposure: 1,
    },
    weather: 'embers',
    weatherDensity: 14,
    musicalRoot: 57,
    musicalMode: 'phrygian',
    unlockWins: 0,
  },

  {
    id: 'rain-rooftops',
    name: 'КРЫШИ ПОД ДОЖДЁМ',
    subtitle: 'Неон, вода и чужие окна',
    layers: [
      { shape: 'skyline', parallax: 0.05, baseline: 0.5, amplitude: 0.26, density: 1.3, color: '#141b2e', haze: 0.6 },
      { shape: 'skyline', parallax: 0.13, baseline: 0.42, amplitude: 0.3, density: 2, color: '#0e1424', haze: 0.4 },
      { shape: 'skyline', parallax: 0.27, baseline: 0.3, amplitude: 0.28, density: 2.8, color: '#090d1a', haze: 0.22 },
      { shape: 'ruins', parallax: 0.55, baseline: 0.16, amplitude: 0.12, density: 2.2, color: '#050710', haze: 0.06 },
    ],
    lighting: {
      skyTop: '#060a18',
      skyMid: '#0d1830',
      skyBottom: '#1c3358',
      sun: '#35d6ff',
      sunRadius: 0.1,
      sunX: 0.3,
      sunY: 0.32,
      rim: '#7fe4ff',
      ground: '#070a14',
      fog: '#1d3350',
      exposure: 0.92,
    },
    weather: 'rain',
    weatherDensity: 160,
    musicalRoot: 50,
    musicalMode: 'aeolian',
    unlockWins: 0,
  },

  {
    id: 'frozen-pass',
    name: 'ЛЕДЯНОЙ ПЕРЕВАЛ',
    subtitle: 'Здесь даже эхо замерзает',
    layers: [
      { shape: 'mountains', parallax: 0.03, baseline: 0.55, amplitude: 0.3, density: 0.4, color: '#26303f', haze: 0.7 },
      { shape: 'mountains', parallax: 0.09, baseline: 0.44, amplitude: 0.26, density: 0.7, color: '#1a222f', haze: 0.45 },
      { shape: 'mountains', parallax: 0.22, baseline: 0.3, amplitude: 0.2, density: 1.2, color: '#111823', haze: 0.22 },
      { shape: 'forest', parallax: 0.48, baseline: 0.18, amplitude: 0.1, density: 3, color: '#080c13', haze: 0.05 },
    ],
    lighting: {
      skyTop: '#0a1220',
      skyMid: '#1b2b42',
      skyBottom: '#4d6f92',
      sun: '#d8ecff',
      sunRadius: 0.13,
      sunX: 0.45,
      sunY: 0.4,
      rim: '#bfe2ff',
      ground: '#0c1119',
      fog: '#3e5872',
      exposure: 1.05,
    },
    weather: 'snow',
    weatherDensity: 70,
    musicalRoot: 52,
    musicalMode: 'dorian',
    unlockWins: 2,
  },

  {
    id: 'blossom-court',
    name: 'ДВОР В ЦВЕТУ',
    subtitle: 'Красиво до тех пор, пока не начнётся',
    layers: [
      { shape: 'mountains', parallax: 0.04, baseline: 0.4, amplitude: 0.14, density: 0.6, color: '#3a2434', haze: 0.5 },
      { shape: 'temple', parallax: 0.14, baseline: 0.32, amplitude: 0.2, density: 0.9, color: '#28182a', haze: 0.28 },
      { shape: 'forest', parallax: 0.3, baseline: 0.26, amplitude: 0.16, density: 2, color: '#1a0f1e', haze: 0.14 },
      { shape: 'forest', parallax: 0.58, baseline: 0.18, amplitude: 0.14, density: 3.2, color: '#0d0711', haze: 0.04 },
    ],
    lighting: {
      skyTop: '#2b1430',
      skyMid: '#5c2540',
      skyBottom: '#ff9fb0',
      sun: '#ffd9e2',
      sunRadius: 0.15,
      sunX: 0.5,
      sunY: 0.52,
      rim: '#ffb8c8',
      ground: '#120a14',
      fog: '#6a3550',
      exposure: 1.02,
    },
    weather: 'petals',
    weatherDensity: 26,
    musicalRoot: 55,
    musicalMode: 'dorian',
    unlockWins: 4,
  },

  {
    id: 'ash-desert',
    name: 'ПЕПЕЛЬНАЯ ПУСТОШЬ',
    subtitle: 'Ветер уносит всё, кроме счетов',
    layers: [
      { shape: 'dunes', parallax: 0.04, baseline: 0.36, amplitude: 0.12, density: 0.5, color: '#3a2a22', haze: 0.65 },
      { shape: 'ruins', parallax: 0.12, baseline: 0.3, amplitude: 0.2, density: 0.8, color: '#2a1d18', haze: 0.4 },
      { shape: 'dunes', parallax: 0.3, baseline: 0.22, amplitude: 0.1, density: 1.4, color: '#1a120f', haze: 0.18 },
      { shape: 'ruins', parallax: 0.6, baseline: 0.14, amplitude: 0.14, density: 1.8, color: '#0c0808', haze: 0.04 },
    ],
    lighting: {
      skyTop: '#2a1508',
      skyMid: '#6b2f10',
      skyBottom: '#c96a22',
      sun: '#ffd07a',
      sunRadius: 0.2,
      sunX: 0.7,
      sunY: 0.48,
      rim: '#ffab52',
      ground: '#100a08',
      fog: '#6a4022',
      exposure: 1.08,
    },
    weather: 'dust',
    weatherDensity: 40,
    musicalRoot: 49,
    musicalMode: 'phrygian',
    unlockWins: 7,
  },

  {
    id: 'void',
    name: 'ПУСТОТА',
    subtitle: 'Только ты и то, что ты есть',
    layers: [
      { shape: 'waves', parallax: 0.06, baseline: 0.34, amplitude: 0.1, density: 0.7, color: '#141024', haze: 0.5 },
      { shape: 'waves', parallax: 0.18, baseline: 0.26, amplitude: 0.12, density: 1.2, color: '#0c0918', haze: 0.25 },
      { shape: 'ruins', parallax: 0.5, baseline: 0.14, amplitude: 0.18, density: 1, color: '#05040c', haze: 0 },
    ],
    lighting: {
      skyTop: '#04030a',
      skyMid: '#0a0618',
      skyBottom: '#1d0a2a',
      sun: '#ff2b55',
      sunRadius: 0.11,
      sunX: 0.5,
      sunY: 0.42,
      rim: '#ff4d6d',
      ground: '#050309',
      fog: '#2a0a24',
      exposure: 0.95,
    },
    weather: 'embers',
    weatherDensity: 8,
    musicalRoot: 46,
    musicalMode: 'minor',
    unlockWins: 10,
  },
];

const BY_ID = new Map(ARENAS.map((arena) => [arena.id, arena]));

export function getArena(id: string): Arena {
  return BY_ID.get(id) ?? ARENAS[0];
}

export function unlockedArenas(wins: number): readonly Arena[] {
  return ARENAS.filter((arena) => wins >= arena.unlockWins);
}

/**
 * Generates the silhouette for one layer as a height field.
 *
 * Returns `samples + 1` heights in `[0, 1]` of the viewport, which the renderer
 * turns into a filled polygon. Seeded by arena and layer index so the same
 * arena looks identical every time it loads — and identical on both machines
 * in an online match, which matters more than it sounds: a player describing
 * "the gap between the two towers" needs it to be there for their opponent too.
 */
export function generateLayerHeights(
  arenaId: string,
  layerIndex: number,
  layer: ArenaLayer,
  samples: number,
): Float32Array {
  const rng = new Rng(hashSeed(`${arenaId}:${layerIndex}`));
  const heights = new Float32Array(samples + 1);

  switch (layer.shape) {
    case 'skyline':
      buildSkyline(heights, layer, rng);
      break;
    case 'temple':
      buildTemple(heights, layer, rng);
      break;
    case 'forest':
      buildForest(heights, layer, rng);
      break;
    case 'ruins':
      buildRuins(heights, layer, rng);
      break;
    case 'dunes':
    case 'waves':
      buildSmooth(heights, layer, rng, layer.shape === 'waves' ? 3 : 2);
      break;
    case 'mountains':
    default:
      buildMountains(heights, layer, rng);
      break;
  }

  return heights;
}

/** Fractal ridge noise — jagged peaks with smaller peaks on them. */
function buildMountains(heights: Float32Array, layer: ArenaLayer, rng: Rng): void {
  const n = heights.length;
  const octaves = 4;
  const phases = Array.from({ length: octaves }, () => rng.range(0, Math.PI * 2));

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let value = 0;
    let amplitude = 1;
    let frequency = layer.density * 2.5;
    for (let o = 0; o < octaves; o++) {
      // Absolute sine makes ridges rather than rolling hills.
      value += Math.abs(Math.sin(t * frequency * Math.PI + phases[o])) * amplitude;
      amplitude *= 0.48;
      frequency *= 2.07;
    }
    heights[i] = layer.baseline + (value / 1.9 - 0.5) * layer.amplitude;
  }
}

/** Rectangular blocks of varying height — a city. */
function buildSkyline(heights: Float32Array, layer: ArenaLayer, rng: Rng): void {
  const n = heights.length;
  let index = 0;
  while (index < n) {
    const width = Math.max(2, Math.round(rng.range(6, 26) / Math.max(layer.density, 0.3)));
    const height = layer.baseline + rng.range(-0.35, 0.65) * layer.amplitude;
    const end = Math.min(n, index + width);
    for (let i = index; i < end; i++) heights[i] = height;
    index = end;
  }
}

/** Stepped pagoda rooflines, with wide eaves. */
function buildTemple(heights: Float32Array, layer: ArenaLayer, rng: Rng): void {
  const n = heights.length;
  heights.fill(layer.baseline - layer.amplitude * 0.4);

  const tiers = rng.int(2, 4);
  const centre = Math.floor(n * rng.range(0.35, 0.65));
  let halfWidth = Math.floor(n * 0.22);
  let height = layer.baseline - layer.amplitude * 0.1;

  for (let tier = 0; tier < tiers; tier++) {
    const start = Math.max(0, centre - halfWidth);
    const end = Math.min(n, centre + halfWidth);
    for (let i = start; i < end; i++) {
      // Curve the eaves upward at the ends, which is the one detail that makes
      // a rectangle read as a pagoda.
      const edge = Math.abs(i - centre) / Math.max(halfWidth, 1);
      heights[i] = height + Math.pow(edge, 3) * layer.amplitude * 0.16;
    }
    halfWidth = Math.floor(halfWidth * rng.range(0.6, 0.76));
    height += layer.amplitude * rng.range(0.22, 0.34);
  }
}

/** Overlapping conical trees. */
function buildForest(heights: Float32Array, layer: ArenaLayer, rng: Rng): void {
  const n = heights.length;
  heights.fill(layer.baseline - layer.amplitude * 0.5);

  const count = Math.max(4, Math.round(layer.density * 14));
  for (let tree = 0; tree < count; tree++) {
    const centre = rng.int(0, n - 1);
    const width = Math.max(3, Math.round(rng.range(4, 14) / Math.max(layer.density * 0.4, 0.3)));
    const height = layer.baseline + rng.range(0.1, 1) * layer.amplitude;
    for (let offset = -width; offset <= width; offset++) {
      const i = centre + offset;
      if (i < 0 || i >= n) continue;
      const taper = 1 - Math.abs(offset) / width;
      heights[i] = Math.max(heights[i], layer.baseline + (height - layer.baseline) * taper);
    }
  }
}

/** Broken walls and pillars in the foreground. */
function buildRuins(heights: Float32Array, layer: ArenaLayer, rng: Rng): void {
  const n = heights.length;
  heights.fill(0);

  const count = Math.max(3, Math.round(layer.density * 6));
  for (let piece = 0; piece < count; piece++) {
    const centre = rng.int(0, n - 1);
    const width = rng.int(3, 16);
    const height = layer.baseline * rng.range(0.3, 1.2);
    const lean = rng.range(-0.2, 0.2);
    for (let offset = -width; offset <= width; offset++) {
      const i = centre + offset;
      if (i < 0 || i >= n) continue;
      // A crumbling top edge: the height drops off irregularly.
      const crumble = rng.next() < 0.12 ? rng.range(0.4, 0.9) : 1;
      heights[i] = Math.max(heights[i], height * crumble + (offset / width) * lean * height);
    }
  }
}

/** Smooth rolling shapes for dunes and distant water. */
function buildSmooth(heights: Float32Array, layer: ArenaLayer, rng: Rng, octaves: number): void {
  const n = heights.length;
  const phases = Array.from({ length: octaves }, () => rng.range(0, Math.PI * 2));

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    let value = 0;
    let amplitude = 1;
    let frequency = layer.density * 1.6;
    let total = 0;
    for (let o = 0; o < octaves; o++) {
      value += Math.sin(t * frequency * Math.PI * 2 + phases[o]) * amplitude;
      total += amplitude;
      amplitude *= 0.55;
      frequency *= 1.9;
    }
    heights[i] = layer.baseline + (value / total) * layer.amplitude * 0.5;
  }
}
