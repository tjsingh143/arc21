/**
 * Arc 21 — chart geometry.
 *
 * Pure arithmetic for the progress rings and bars on the statistics screens, so
 * the maths is unit-testable and the SVG components stay declarative.
 *
 * The recurring hazard these functions exist to remove: a `Rate` with no sample
 * has `value: null`, and `null` coerces to `0` in arithmetic. A ring drawn from
 * a coerced null renders an empty track that looks exactly like 0% accuracy —
 * so every function here takes `number | null` and answers `null` for "nothing
 * to draw" rather than quietly drawing zero.
 *
 * Runtime-neutral: no React, React Native or Expo imports.
 */

/** Clamps a fraction into `[0, 1]`, preserving "unknown". */
export function clampFraction(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

export interface RingGeometry {
  /** Centre of the square viewport. */
  centre: number;
  radius: number;
  circumference: number;
  /**
   * `strokeDasharray` for the filled arc, or null when there is no sample.
   * A null means the caller must not draw the arc at all.
   */
  dashArray: string | null;
  /** Rotation that starts the arc at twelve o'clock rather than three. */
  rotation: number;
}

/**
 * Geometry for a circular progress ring.
 *
 * The radius is inset by half the stroke so the stroke lands inside the
 * viewport instead of being clipped by it.
 */
export function ringGeometry(size: number, strokeWidth: number, value: number | null): RingGeometry {
  const safeSize = Math.max(1, size);
  const safeStroke = Math.max(0, Math.min(strokeWidth, safeSize / 2));
  const centre = safeSize / 2;
  const radius = Math.max(0, centre - safeStroke / 2);
  const circumference = 2 * Math.PI * radius;

  const fraction = clampFraction(value);
  const filled = fraction === null ? null : circumference * fraction;

  return {
    centre,
    radius,
    circumference,
    dashArray: filled === null ? null : `${filled} ${Math.max(0, circumference - filled)}`,
    rotation: -90,
  };
}

/**
 * Width of a bar's filled portion, in the same units as `trackWidth`.
 *
 * Returns 0 for an unknown value rather than null, because a bar with no sample
 * still draws its empty track — but the caller must label it "—" rather than
 * "0%", which is why `clampFraction` is exported separately.
 */
export function barFill(value: number | null, trackWidth: number): number {
  const fraction = clampFraction(value);
  if (fraction === null) return 0;
  return Math.max(0, trackWidth) * fraction;
}

/**
 * Heights for a set of sparkline columns, scaled so the tallest fills the box.
 *
 * Buckets with no sample are `null` and must be skipped by the renderer: a
 * zero-height column and a genuinely-zero-accuracy column would look identical.
 *
 * The scale is anchored at zero, not at the minimum value. Auto-zooming the
 * baseline is how a wobble between 94% and 96% is made to look like a collapse.
 */
export function sparklineHeights(
  values: readonly (number | null)[],
  boxHeight: number,
  minimumHeight = 2,
): (number | null)[] {
  const height = Math.max(0, boxHeight);
  return values.map((value) => {
    const fraction = clampFraction(value);
    if (fraction === null) return null;
    return Math.max(minimumHeight, height * fraction);
  });
}
