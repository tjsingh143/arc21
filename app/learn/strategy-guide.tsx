/**
 * Strategy Guide — the chart.
 *
 * EVERY CELL IS READ FROM `ARC_STANDARD_STRATEGY_TABLE`. Nothing on this screen
 * is transcribed from a published chart and nothing decides what the right play
 * is: `src/features/learn/strategy-chart.ts` reshapes solver output into rows
 * and columns, and `tests/learn/strategy-chart.test.ts` asserts that the letter
 * rendered here is the action `adviseAction` returns for the same state. A
 * hand-typed chart is a guessed strategy, and it would drift from the engine the
 * first time the solver ran again.
 *
 * The rows and columns come from the table's own key space too, so a ruleset
 * that solves for more states renders more rows without an edit here.
 *
 * ACCESSIBILITY: the letter is the encoding. The tint behind it is decoration —
 * every cell shows H/S/D/P/R and carries a spoken label ("Hard 16 against dealer
 * 10: surrender if allowed, otherwise hit"), so a player who cannot separate the
 * hues reads exactly the same chart.
 */

import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard } from "../../src/components/ui/Card";
import { colors, layout, MIN_TOUCH_TARGET, radius, spacing } from "../../src/design/tokens";
import { ARC_STANDARD_STRATEGY_TABLE } from "../../shared/strategy/index.js";
import type { ColorToken } from "../../src/design/tokens";
import { format, formatProbability } from "../../src/features/practice/advice";
import {
  buildStrategyChart,
  chartRowAccessibilityLabel,
  CHART_LEGEND,
  CHART_TABS,
  type ChartCell,
  type ChartCode,
  type ChartTab,
} from "../../src/features/learn/strategy-chart";

/** Cell geometry. 48 keeps every cell a legal touch target in its own right. */
const CELL = MIN_TOUCH_TARGET;
const LABEL_COLUMN = 56;
const HEADER_HEIGHT = 32;

/**
 * Tint and letter colour per code.
 *
 * Decoration only — the letter is what the cell means. Each tint is a dark,
 * desaturated ground chosen so its letter clears contrast against it, rather
 * than the saturated red/green/yellow blocks a casino chart uses.
 */
const CODE_STYLE: Readonly<Record<ChartCode, { background: string; ink: ColorToken }>> = {
  H: { background: colors.surfaceSoft, ink: "textPrimary" },
  S: { background: "#1D3A2D", ink: "success" },
  D: { background: colors.accentSoft, ink: "accent" },
  P: { background: "#1D3247", ink: "info" },
  R: { background: "#3C2426", ink: "danger" },
};

export default function StrategyGuideScreen() {
  const [tab, setTab] = useState<ChartTab>("hard");
  const [selected, setSelected] = useState<ChartCell | null>(null);
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  // Keep complete row labels and action letters inside their cells at every
  // text size. The chart already scrolls horizontally when columns get wider.
  const chartScale = Math.max(1, fontScale);
  const cellSize = Math.ceil(CELL * chartScale);
  const labelWidth = Math.ceil(LABEL_COLUMN * chartScale);
  const headerHeight = Math.ceil(HEADER_HEIGHT * chartScale);
  const cellSizeStyle = { width: cellSize, height: cellSize };

  const chart = useMemo(() => buildStrategyChart(ARC_STANDARD_STRATEGY_TABLE, tab), [tab]);
  const activeTab = CHART_TABS.find((entry) => entry.id === tab) ?? CHART_TABS[0]!;

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={{ paddingHorizontal: layout.screenPadding }}>
        <BackBar />
      </View>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          // Room for the detail panel so the last row is never trapped under it.
          selected ? { paddingBottom: 180 + insets.bottom } : null,
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <AppText variant="pageTitle" accessibilityRole="header">
            Strategy Guide
          </AppText>
          {/*
            The ruleset banner is mandatory and is built from the summary the
            SOLVER recorded, not from the live rules. Basic strategy is
            rule-specific; a chart that does not say which rules it belongs to is
            misinformation waiting to happen.
          */}
          <AppText variant="caption" color="accent">
            {chart.rulesetLine}
          </AppText>
          <AppText variant="caption" color="textSecondary">
            {chart.rulesetDetail}
          </AppText>
        </View>

        <View style={styles.tabs} accessibilityRole="tablist">
          {CHART_TABS.map((entry) => {
            const active = entry.id === tab;
            return (
              <Pressable
                key={entry.id}
                onPress={() => {
                  setTab(entry.id);
                  setSelected(null);
                }}
                accessibilityRole="tab"
                accessibilityLabel={`${entry.label} totals`}
                accessibilityState={{ selected: active }}
                style={({ pressed }) => [
                  styles.tab,
                  active ? styles.tabActive : null,
                  pressed ? styles.pressed : null,
                ]}
              >
                <AppText
                  variant="bodyStrong"
                  color={active ? "textPrimary" : "textSecondary"}
                >
                  {entry.label}
                </AppText>
              </Pressable>
            );
          })}
        </View>

        <AppText variant="caption" color="textSecondary">
          {activeTab.blurb}
        </AppText>

        {/* ---------------------------------------------------------------
            The grid. The row-label column sits OUTSIDE the horizontal
            scroller, which is what keeps "16" or "A,7" on screen while the
            dealer columns scroll under your thumb on a phone.
        ---------------------------------------------------------------- */}
        <View style={styles.grid}>
          <View style={[styles.labelColumn, { width: labelWidth }]}>
            <View style={[styles.headerCell, styles.labelCell, { width: labelWidth, height: headerHeight }]}>
              <AppText variant="overline" color="textDisabled">
                You
              </AppText>
            </View>
            {chart.rows.map((row) => (
              <View
                key={row.rowValue}
                style={[styles.rowLabel, styles.labelCell, { width: labelWidth, height: cellSize }]}
                accessible
                accessibilityLabel={row.accessibilityLabel}
              >
                <AppText variant="bodyStrong" numeric>
                  {row.label}
                </AppText>
              </View>
            ))}
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.scrollBody}
          >
            <View>
              <View style={styles.gridRow} accessibilityRole="summary" accessibilityLabel="Dealer upcard">
                {chart.upcards.map((upcard) => (
                  <View key={upcard.value} style={[styles.cellBox, styles.headerCell, { width: cellSize, height: headerHeight }]}>
                    <AppText variant="caption" color="textSecondary" numeric>
                      {upcard.label}
                    </AppText>
                  </View>
                ))}
              </View>

              {chart.rows.map((row) => (
                <View key={row.rowValue} style={styles.gridRow}>
                  {row.cells.map((cell, index) =>
                    cell === null ? (
                      // The table has no entry for this coordinate. An em-dash,
                      // never an invented action — the same fail-safe the
                      // advisor uses.
                      <View
                        key={`${row.rowValue}:${index}`}
                        style={[styles.cellBox, styles.emptyCell, cellSizeStyle]}
                        accessible
                        accessibilityLabel={`${row.accessibilityLabel}: no entry`}
                      >
                        <AppText variant="body" color="textDisabled">
                          —
                        </AppText>
                      </View>
                    ) : (
                      <Cell
                        key={cell.key}
                        cell={cell}
                        size={cellSize}
                        selected={selected?.key === cell.key}
                        onPress={() =>
                          setSelected((current) => (current?.key === cell.key ? null : cell))
                        }
                      />
                    ),
                  )}
                </View>
              ))}
            </View>
          </ScrollView>
        </View>

        <AppText variant="caption" color="textDisabled">
          Scroll sideways for the rest of the dealer&apos;s upcards. Tap any cell
          for what it means and what the solver priced it at.
        </AppText>

        {/* ---------------------------------------------------------------- */}
        <SurfaceCard>
          <AppText variant="overline" color="textSecondary">
            Legend
          </AppText>
          {CHART_LEGEND.map((entry) => (
            <View key={entry.code} style={styles.legendRow}>
              <View
                style={[styles.legendChip, {
                  backgroundColor: CODE_STYLE[entry.code].background,
                  width: Math.ceil(32 * chartScale),
                  height: Math.ceil(32 * chartScale),
                }]}
              >
                <AppText variant="bodyStrong" color={CODE_STYLE[entry.code].ink}>
                  {entry.code}
                </AppText>
              </View>
              <AppText variant="body" color="textSecondary" style={styles.legendText}>
                {entry.meaning}
              </AppText>
            </View>
          ))}
          <AppText variant="caption" color="textDisabled">
            A cell&apos;s fallback is part of the solved data, not a rule invented
            here: when doubling is off the table — on a hand you have already hit,
            for example — the fallback is what to do instead.
          </AppText>
        </SurfaceCard>

        <SurfaceCard>
          <AppText variant="overline" color="textSecondary">
            One chart, one ruleset
          </AppText>
          <AppText variant="body" color="textSecondary">
            These letters are correct for {chart.rulesetLine.split(" · ")[0]} and
            nothing else. Change the deck count, let the dealer hit soft 17,
            remove doubling after a split or remove surrender, and cells move.
            Arc 21 solves a separate chart per ruleset rather than reusing a
            neighbouring one.
          </AppText>
          <AppText variant="caption" color="textDisabled" numeric>
            {`${ARC_STANDARD_STRATEGY_TABLE.metadata.entryCount} solved cells · expectation ${format(
              ARC_STANDARD_STRATEGY_TABLE.metadata.expectedValuePerUnit,
            )} per unit wagered playing this chart from the top of the shoe`}
          </AppText>
          <AppText variant="caption" color="textDisabled">
            Basic strategy minimises the house edge — it does not remove it. No
            strategy makes blackjack profitable.
          </AppText>
        </SurfaceCard>

        <Button label="Back" onPress={() => router.back()} variant="quiet" />
      </ScrollView>

      {selected ? (
        <CellDetail
          cell={selected}
          bottomInset={insets.bottom}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

function Cell({
  cell,
  size,
  selected,
  onPress,
}: {
  cell: ChartCell;
  size: number;
  selected: boolean;
  onPress: () => void;
}) {
  const style = CODE_STYLE[cell.code];

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={cell.accessibilityLabel}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.cellBox,
        { width: size, height: size },
        styles.cell,
        { backgroundColor: style.background },
        selected ? styles.cellSelected : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <AppText variant="bodyStrong" color={style.ink}>
        {cell.code}
      </AppText>
      {/*
        The fallback gets a mark of its own so "D" and "Ds" are distinguishable
        without reading the tint: the dot means "there is a second answer here
        when the first play is not available".
      */}
      {cell.fallback ? (
        <AppText variant="caption" color="textDisabled" style={styles.fallbackDot}>
          ·
        </AppText>
      ) : null}
    </Pressable>
  );
}

/**
 * "Hard 16 vs 10". Built from the cell's own state rather than by slicing its
 * accessibility label, so changing the spoken wording cannot silently reshape
 * the heading.
 */
function cellTitle(cell: ChartCell): string {
  const { handClass, playerTotal, pairValue } = cell.state;
  const rowValue = handClass === "pair" ? (pairValue ?? playerTotal) : playerTotal;
  return `${chartRowAccessibilityLabel(handClass, rowValue)} vs ${cell.upcardLabel}`;
}

/**
 * What one cell means, priced.
 *
 * EVs come from `actionEVs`, which is precomputed solver output. This is the
 * chart view, so it lists everything the cell prices — including plays that
 * would be illegal on a hand you had already hit — and says so.
 */
function CellDetail({
  cell,
  bottomInset,
  onClose,
}: {
  cell: ChartCell;
  bottomInset: number;
  onClose: () => void;
}) {
  return (
    <View
      style={[styles.detail, { paddingBottom: spacing.lg + bottomInset }]}
      accessibilityViewIsModal
      onAccessibilityEscape={onClose}
    >
      <View style={styles.detailHead}>
        <View style={styles.detailTitle}>
          <AppText variant="bodyStrong">{cellTitle(cell)}</AppText>
        </View>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close cell detail"
          style={({ pressed }) => [styles.close, pressed ? styles.pressed : null]}
        >
          <AppText variant="bodyStrong" color="textSecondary">
            ✕
          </AppText>
        </Pressable>
      </View>

      <ScrollView
        style={styles.detailBody}
        contentContainerStyle={styles.detailContent}
        testID="strategy-detail-scroll"
      >
        <AppText variant="body" color="accent">
          {cell.meaning}
        </AppText>
        {cell.evs.length > 0 ? (
          <>
            <View style={styles.evRow}>
              {cell.evs.map((entry) => (
                <View key={entry.action} style={styles.evChip}>
                  <AppText variant="caption" color="textSecondary">
                    {entry.action.charAt(0) + entry.action.slice(1).toLowerCase()}
                  </AppText>
                  <AppText
                    variant="bodyStrong"
                    numeric
                    color={entry.action === cell.action ? "accent" : "textPrimary"}
                  >
                    {format(entry.ev)}
                  </AppText>
                </View>
              ))}
            </View>
            <AppText variant="caption" color="textDisabled">
              Expected result per unit of the original bet, from the solver. Doubling
              ranges wider because a doubled loss really does cost twice the bet.
              Actions the hand in front of you cannot take are still priced here —
              this is the chart, not a live hand.
            </AppText>
          </>
        ) : (
          <AppText variant="caption" color="textDisabled">
            This cell carries no priced actions, so no expected values are shown.
          </AppText>
        )}

        {/*
          The same two probabilities the Analysis mode shows at the table, from
          the same solved cell. Absent entirely when the table does not carry
          them — a chart generated before they existed is still a valid chart, and
          a figure computed here to fill the gap would be indistinguishable from
          a solved one.
        */}
        {cell.probabilities ? (
          <>
            <View style={styles.evRow}>
              <View style={styles.evChip}>
                <AppText variant="caption" color="textSecondary">
                  Bust if you hit
                </AppText>
                <AppText variant="bodyStrong" numeric>
                  {formatProbability(cell.probabilities.bustIfHit)}
                </AppText>
              </View>
              <View style={styles.evChip}>
                <AppText variant="caption" color="textSecondary">
                  Dealer busts
                </AppText>
                <AppText variant="bodyStrong" numeric>
                  {formatProbability(cell.probabilities.dealerBust)}
                </AppText>
              </View>
            </View>
            <AppText variant="caption" color="textDisabled">
              Both from the same solve as the values above. The dealer figure
              assumes they have already checked for blackjack and do not have one,
              which is the only position you are ever asked to play from.
            </AppText>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  header: { gap: spacing.xs, paddingTop: spacing.sm },

  tabs: {
    flexDirection: "row",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xs,
  },
  tab: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.small - 4,
  },
  tabActive: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },

  grid: { flexDirection: "row" },
  labelColumn: {
    width: LABEL_COLUMN,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  labelCell: {
    width: LABEL_COLUMN,
    alignItems: "flex-start",
    paddingLeft: spacing.xs,
  },
  rowLabel: {
    height: CELL,
    justifyContent: "center",
  },
  scrollBody: { paddingRight: spacing.lg },
  gridRow: { flexDirection: "row" },
  headerCell: {
    height: HEADER_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  cellBox: {
    width: CELL,
    height: CELL,
    alignItems: "center",
    justifyContent: "center",
  },
  cell: {
    borderWidth: 1,
    borderColor: colors.background,
    borderRadius: 4,
  },
  cellSelected: {
    borderColor: colors.textPrimary,
    borderWidth: 2,
  },
  emptyCell: { opacity: 0.4 },
  fallbackDot: {
    position: "absolute",
    right: 4,
    top: 1,
  },

  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  legendChip: {
    width: 32,
    height: 32,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  legendText: { flexShrink: 1 },

  detail: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "85%",
    gap: spacing.sm,
    padding: spacing.lg,
    backgroundColor: colors.surfaceRaised,
    borderTopWidth: 1,
    borderTopColor: colors.borderStrong,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
  },
  detailHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  detailTitle: { flexShrink: 1, gap: 2 },
  detailBody: { flexShrink: 1 },
  detailContent: { gap: spacing.sm },
  close: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
  },
  evRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  evChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.small,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    minWidth: 76,
  },

  pressed: { opacity: 0.75 },
});
