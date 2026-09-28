/**
 * A tiny mutable 2D vector.
 *
 * The renderer runs hundreds of these per frame, so the API is built around
 * in-place mutation (`addTo`, `scaleBy`) with explicit allocation points
 * (`Vec2.of`, `clone`). Nothing here allocates unless the name says it does.
 */
export class Vec2 {
  x: number;
  y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static of(x: number, y: number): Vec2 {
    return new Vec2(x, y);
  }

  static zero(): Vec2 {
    return new Vec2(0, 0);
  }

  static fromAngle(angle: number, length = 1): Vec2 {
    return new Vec2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  set(x: number, y: number): this {
    this.x = x;
    this.y = y;
    return this;
  }

  copyFrom(other: Readonly<Vec2>): this {
    this.x = other.x;
    this.y = other.y;
    return this;
  }

  clone(): Vec2 {
    return new Vec2(this.x, this.y);
  }

  addTo(other: Readonly<Vec2>): this {
    this.x += other.x;
    this.y += other.y;
    return this;
  }

  addScaled(other: Readonly<Vec2>, scale: number): this {
    this.x += other.x * scale;
    this.y += other.y * scale;
    return this;
  }

  subFrom(other: Readonly<Vec2>): this {
    this.x -= other.x;
    this.y -= other.y;
    return this;
  }

  scaleBy(scalar: number): this {
    this.x *= scalar;
    this.y *= scalar;
    return this;
  }

  negate(): this {
    this.x = -this.x;
    this.y = -this.y;
    return this;
  }

  get length(): number {
    return Math.hypot(this.x, this.y);
  }

  get lengthSq(): number {
    return this.x * this.x + this.y * this.y;
  }

  get angle(): number {
    return Math.atan2(this.y, this.x);
  }

  normalize(): this {
    const len = this.length;
    if (len > 1e-6) {
      this.x /= len;
      this.y /= len;
    }
    return this;
  }

  limit(max: number): this {
    const lenSq = this.lengthSq;
    if (lenSq > max * max && lenSq > 1e-12) {
      const scale = max / Math.sqrt(lenSq);
      this.x *= scale;
      this.y *= scale;
    }
    return this;
  }

  rotate(angle: number): this {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const x = this.x * c - this.y * s;
    this.y = this.x * s + this.y * c;
    this.x = x;
    return this;
  }

  /** Rotate 90° counter-clockwise — the cheap way to get a normal. */
  perpendicular(): this {
    const x = this.x;
    this.x = -this.y;
    this.y = x;
    return this;
  }

  lerpTo(other: Readonly<Vec2>, t: number): this {
    this.x += (other.x - this.x) * t;
    this.y += (other.y - this.y) * t;
    return this;
  }

  dot(other: Readonly<Vec2>): number {
    return this.x * other.x + this.y * other.y;
  }

  /** 2D analogue of the cross product — the z of the 3D result. */
  cross(other: Readonly<Vec2>): number {
    return this.x * other.y - this.y * other.x;
  }

  distanceTo(other: Readonly<Vec2>): number {
    return Math.hypot(other.x - this.x, other.y - this.y);
  }

  equals(other: Readonly<Vec2>, epsilon = 1e-6): boolean {
    return Math.abs(this.x - other.x) <= epsilon && Math.abs(this.y - other.y) <= epsilon;
  }

  isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y);
  }

  toString(): string {
    return `Vec2(${this.x.toFixed(3)}, ${this.y.toFixed(3)})`;
  }
}

/** Plain-data variant for snapshots that get structured-cloned over the wire. */
export interface Point {
  x: number;
  y: number;
}

export function point(x: number, y: number): Point {
  return { x, y };
}
