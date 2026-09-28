/**
 * Small, allocation-conscious math helpers shared by the simulation,
 * the vision pipeline and the renderer.
 *
 * Everything here is pure and deterministic — the netcode replays the
 * simulation, so no hidden state and no `Math.random()` are allowed.
 */

export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const EPSILON = 1e-6;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse of `lerp`: where does `value` sit between `a` and `b`? */
export function invLerp(a: number, b: number, value: number): number {
  return Math.abs(b - a) < EPSILON ? 0 : (value - a) / (b - a);
}

export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, invLerp(inMin, inMax, value));
}

/** `remap` clamped to the output range. */
export function remapClamped(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  return lerp(outMin, outMax, clamp01(invLerp(inMin, inMax, value)));
}

/**
 * Frame-rate independent exponential smoothing.
 *
 * `halfLife` is the time in seconds for the gap to halve, which makes tuning
 * intuitive: 0.05 snaps, 0.4 glides.
 */
export function damp(current: number, target: number, halfLife: number, dt: number): number {
  if (halfLife <= 0) return target;
  return target + (current - target) * Math.pow(2, -dt / halfLife);
}

/** Same as `damp` but takes the shortest way around a circle. */
export function dampAngle(current: number, target: number, halfLife: number, dt: number): number {
  return current + shortestAngle(current, target) * (1 - Math.pow(2, -dt / halfLife));
}

/** Move `current` towards `target` by at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Wraps an angle into `(-PI, PI]`. */
export function wrapAngle(angle: number): number {
  let a = (angle + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Signed shortest rotation from `from` to `to`. */
export function shortestAngle(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function lerpAngle(from: number, to: number, t: number): number {
  return from + shortestAngle(from, to) * t;
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.hypot(dx, dy);
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function angleBetween(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}

/**
 * Interior angle at joint `b` formed by the chain a→b→c, in radians `[0, PI]`.
 * Used heavily by the pose analysers (elbow extension, knee bend, …).
 */
export function jointAngle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  const abx = ax - bx;
  const aby = ay - by;
  const cbx = cx - bx;
  const cby = cy - by;
  const denom = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (denom < EPSILON) return 0;
  return Math.acos(clamp((abx * cbx + aby * cby) / denom, -1, 1));
}

export function sign(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

/** Signed value with a dead zone around zero, rescaled so output stays continuous. */
export function deadzone(value: number, threshold: number): number {
  const magnitude = Math.abs(value);
  if (magnitude < threshold) return 0;
  return sign(value) * ((magnitude - threshold) / (1 - threshold));
}

export function approxEqual(a: number, b: number, epsilon = EPSILON): boolean {
  return Math.abs(a - b) <= epsilon;
}

/** Wraps `value` into `[0, length)` — handy for ring buffers and carousels. */
export function wrapIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return ((value % length) + length) % length;
}

/** Mean of a numeric window; returns 0 for an empty window. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return sum / values.length;
}

export function variance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - m;
    sum += d * d;
  }
  return sum / (values.length - 1);
}

export function standardDeviation(values: readonly number[]): number {
  return Math.sqrt(variance(values));
}
