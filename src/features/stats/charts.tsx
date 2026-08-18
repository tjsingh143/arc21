/**
 * Arc 21 — statistics charts.
 *
 * Deliberately quiet: a ring, some bars, a sparkline. No sweeping gauges, no
 * needles, no glowing meters — a slot-machine meter would turn a measure of
 * skill into a reward animation, which is exactly the framing this product
 * avoids.
 *
 * Two rules every chart here follows:
 *
 *   1. **Colour is never the only encoding.** Every ring and bar renders its
 *      own number and its own sample size, so the chart is still readable in
 *      greyscale, by a screen reader, or by anyone who cannot separate the
 *      accent from the track.
 *   2. **No sample is drawn as zero.** A `Rate` with no denominator renders an
 *      empty track and an em dash, never a 0% arc — see `gauge.ts`.
 *
 * Geometry lives in `gauge.ts` so it can be tested without rendering.
 */

import { StyleSheet, View } from "react-native";
import Svg, { Circle, Rect } from "react-native-svg";

import { AppText } from "../../components/ui/AppText";
import { colors, radius, spacing, type ColorToken } from "../../design/tokens";
import { barFill, ringGeometry, sparklineHeights } from "./gauge.js";
import { describeSample, formatPercent, type Rate } from "./rate.js";

export interface AccuracyRingProps {
  value: Rate;
  /** Rendered inside the ring, under the percentage. Keep it to a word or two. */
  caption: string;
  /** Full sentence for assistive technology, e.g. "Unaided accuracy". */
  label: string;
  size?: number;
  strokeWidth?: number;
  tone?: ColorToken;
}

/**
 * A single progress ring.
 *
 * The arc is omitted entirely when there is no sample, rather than drawn at
 * length zero — an empty ring beside "—" reads as "not measured", which is what
 * it is, while an empty ring beside "0%" reads as failure.
 */
export function AccuracyRing({
  value,
  caption,
  label,
  size = 128,
  strokeWidth = 10,
  tone = "accent",
}: AccuracyRingProps) {
  const geometry = ringGeometry(size, strokeWidth, value.value);
  const percent = formatPercent(value);

  return (
    <View
      style={[styles.ring, { width: size, height: size }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={
        value.value === null
          ? `${label}: not measured yet`
          : `${label}: ${percent}, from ${describeSample(value.denominator, "decision")}`
      }
    >
      <Svg width={size} height={size}>
        <Circle
          cx={geometry.centre}
          cy={geometry.centre}
          r={geometry.radius}
          stroke={colors.surfaceSoft}
          strokeWidth={strokeWidth}
          fill="none"
        />
        {geometry.dashArray !== null ? (
          <Circle
            cx={geometry.centre}
            cy={geometry.centre}
            r={geometry.radius}
            stroke={colors[tone]}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={geometry.dashArray}
            fill="none"
            // Start at twelve o'clock; SVG arcs otherwise begin at three.
            transform={`rotate(${geometry.rotation} ${geometry.centre} ${geometry.centre})`}
          />
        ) : null}
      </Svg>

      <View style={styles.ringCentre} pointerEvents="none">
        <AppText variant="display" numeric>
          {percent}
        </AppText>
        <AppText variant="caption" color="textSecondary">
          {caption}
        </AppText>
      </View>
    </View>
  );
}

export interface RateBarProps {
  label: string;
  value: Rate;
  /** What the denominator counts, e.g. "decision". */
  unit?: string;
  tone?: ColorToken;
}

/**
 * A labelled horizontal bar.
 *
 * Built from views rather than SVG on purpose: a percentage-width view keeps
 * crisp rounded ends at any container width, where a stretched SVG viewBox
 * would distort the end caps.
 */
export function RateBar({ label, value, unit = "decision", tone = "accent" }: RateBarProps) {
  const percent = formatPercent(value);
  const fillPercent = barFill(value.value, 100);

  return (
    <View
      style={styles.barRow}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={
        value.value === null
          ? `${label}: no ${unit}s yet`
          : `${label}: ${percent}, ${value.numerator} of ${describeSample(value.denominator, unit)}`
      }
    >
      <View style={styles.barHeader}>
        <AppText variant="body">{label}</AppText>
        <View style={styles.barFigures}>
          <AppText variant="bodyStrong" numeric>
            {percent}
          </AppText>
          <AppText variant="caption" color="textSecondary" numeric>
            {value.denominator === 0
              ? `no ${unit}s yet`
              : `${value.numerator} / ${describeSample(value.denominator, unit)}`}
          </AppText>
        </View>
      </View>

      <View style={styles.barTrack}>
        {value.value === null ? null : (
          <View
            style={[styles.barFill, { width: `${fillPercent}%`, backgroundColor: colors[tone] }]}
          />
        )}
      </View>
    </View>
  );
}

export interface SparklineProps {
  /** Oldest first. Null entries are buckets with no sample and are not drawn. */
  values: readonly (number | null)[];
  label: string;
  height?: number;
  tone?: ColorToken;
}

/**
 * Accuracy over time, as columns.
 *
 * The scale is anchored at zero rather than at the minimum value: a chart that
 * rescales to its own range turns a wobble between 94% and 96% into a cliff.
 */
export function Sparkline({ values, label, height = 44, tone = "info" }: SparklineProps) {
  if (values.length === 0) return null;

  const columnWidth = 100 / values.length;
  const heights = sparklineHeights(values, height);

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={label}>
      <Svg width="100%" height={height} viewBox={`0 0 100 ${height}`} preserveAspectRatio="none">
        {heights.map((columnHeight, index) => {
          const x = index * columnWidth;
          const barWidth = Math.max(0.5, columnWidth - 1.5);

          return (
            <Rect
              key={index}
              x={x}
              y={columnHeight === null ? 0 : height - columnHeight}
              width={barWidth}
              height={columnHeight ?? height}
              fill={columnHeight === null ? colors.surfaceSoft : colors[tone]}
              opacity={columnHeight === null ? 0.5 : 1}
            />
          );
        })}
      </Svg>
    </View>
  );
}

/** A label/value pair. The workhorse of every statistics card. */
export function StatRow({
  label,
  value,
  detail,
  tone = "textPrimary",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: ColorToken;
}) {
  return (
    <View style={styles.statRow} accessible accessibilityLabel={`${label}: ${value}`}>
      <View style={styles.statLabel}>
        <AppText variant="body" color="textSecondary">
          {label}
        </AppText>
        {detail ? (
          <AppText variant="caption" color="textDisabled">
            {detail}
          </AppText>
        ) : null}
      </View>
      <AppText variant="bodyStrong" color={tone} numeric>
        {value}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  ring: {
    alignItems: "center",
    justifyContent: "center",
  },
  ringCentre: {
    // Written out rather than spreading StyleSheet.absoluteFillObject, which is
    // absent from React Native's current type definitions.
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  barRow: {
    gap: spacing.xs,
  },
  barHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  barFigures: {
    alignItems: "flex-end",
  },
  barTrack: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSoft,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: radius.pill,
  },
  statRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
    minHeight: 28,
  },
  statLabel: {
    flexShrink: 1,
  },
});
