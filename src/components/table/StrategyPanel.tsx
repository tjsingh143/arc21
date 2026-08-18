/**
 * The learning intelligence that sits directly above the action dock.
 *
 * Collapsed by default so the table stays sparse — the specification's warning
 * against hiding needed state behind gestures applies to bankroll and legal
 * actions, not to optional analysis, which should stay out of the way until
 * asked for.
 *
 * When the strategy tables cannot answer, this renders NOTHING. It never
 * substitutes a guess: a wrong recommendation in a teaching product is worse
 * than silence.
 */

import { useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";

import { colors, MIN_TOUCH_TARGET, radius, spacing } from "../../design/tokens";
import { AppText } from "../ui/AppText";
import {
  actionLabel,
  explainRecommendation,
  format,
  formatMagnitude,
  type TableAdvice,
} from "../../features/practice/advice";
import type { AssistanceMode } from "../../features/practice/practice-store";

export interface StrategyPanelProps {
  mode: AssistanceMode;
  advice: TableAdvice;
}

export function StrategyPanel({ mode, advice }: StrategyPanelProps) {
  const [expanded, setExpanded] = useState(false);

  // Play and Challenge withhold the answer during the decision. Challenge shows
  // its feedback afterwards through a separate component.
  if (mode === "play" || mode === "challenge") return null;
  if (!advice.recommendation) return null;

  const action = advice.recommendation.action;
  const isAnalysis = mode === "analysis";

  return (
    <View style={styles.container}>
      <Pressable
        onPress={() => setExpanded((open) => !open)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={
          isAnalysis
            ? `Recommended play ${actionLabel(action)}. ${expanded ? "Hide" : "Show"} analysis.`
            : `Recommended play ${actionLabel(action)}. ${expanded ? "Hide" : "Show"} explanation.`
        }
        style={({ pressed }) => [styles.chip, pressed ? styles.pressed : null]}
      >
        <AppText variant="overline" color="textSecondary">
          Recommended
        </AppText>
        <AppText variant="bodyStrong" color="accent">
          {actionLabel(action).toUpperCase()}
        </AppText>
        <AppText variant="caption" color="textSecondary">
          {expanded ? "Hide" : isAnalysis ? "View analysis" : "Why?"}
        </AppText>
      </Pressable>

      {/*
        Analysis expands into a bottom sheet rather than inline. Inline growth
        pushed the dealer's cards off screen — you cannot reason about a
        decision you can no longer see. Learn's one-line rationale is short
        enough to stay inline.
      */}
      {expanded && isAnalysis ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setExpanded(false)}>
          <Pressable
            style={styles.scrim}
            accessibilityRole="button"
            accessibilityLabel="Close analysis"
            onPress={() => setExpanded(false)}
          >
            <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
              <View style={styles.sheetHandle} />
              {renderDetail()}
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}

      {expanded && !isAnalysis ? renderDetail() : null}
    </View>
  );

  function renderDetail() {
    return (
        <View style={styles.detail}>
          <View style={styles.detailHeader}>
            <AppText variant="caption" color="textSecondary">
              {advice.handLabel}
            </AppText>
            <AppText variant="caption" color="textSecondary">
              {`Dealer ${advice.upcardLabel}`}
            </AppText>
          </View>

          <AppText variant="body" color="textSecondary">
            {explainRecommendation(advice)}
          </AppText>

          {isAnalysis && advice.evs.length > 0 ? (
            <View style={styles.evTable}>
              <AppText variant="overline" color="textSecondary">
                Expected value per bet
              </AppText>
              {advice.evs.map((entry) => {
                const isBest = entry.action === action;
                return (
                  <View key={entry.action} style={styles.evRow}>
                    <AppText
                      variant="body"
                      color={isBest ? "textPrimary" : "textSecondary"}
                      accessibilityLabel={`${actionLabel(entry.action)}, expected value ${format(entry.ev)}`}
                    >
                      {actionLabel(entry.action)}
                    </AppText>
                    <AppText
                      variant="body"
                      color={isBest ? "success" : "textSecondary"}
                      numeric
                    >
                      {format(entry.ev)}
                    </AppText>
                  </View>
                );
              })}
            </View>
          ) : null}

          {/* Estimates, and labelled as such — the model carries documented
              approximations and must not imply more precision than it has. */}
          <AppText variant="caption" color="textDisabled">
            Estimates for Arc Standard: 6 decks, dealer stands soft 17, double
            after split, late surrender.
          </AppText>
        </View>
    );
  }
}

export interface ChallengeFeedbackProps {
  correct: boolean;
  recommended: string;
  evLost: number | null;
  onDismiss: () => void;
}

/**
 * Post-decision feedback for Challenge mode. Non-blocking by design: the hand
 * continues underneath, and this never becomes a modal the player must clear.
 */
export function ChallengeFeedback({
  correct,
  recommended,
  evLost,
  onDismiss,
}: ChallengeFeedbackProps) {
  return (
    <Pressable
      onPress={onDismiss}
      accessibilityRole="button"
      accessibilityLabel={
        correct
          ? "Correct. Best play."
          : `Better play was ${recommended}${evLost ? `, costing about ${formatMagnitude(evLost)} of a bet` : ""}`
      }
      accessibilityLiveRegion="polite"
      style={[styles.feedback, correct ? styles.feedbackGood : styles.feedbackBad]}
    >
      <AppText variant="bodyStrong" color={correct ? "success" : "warning"}>
        {correct ? "✓ Best play" : `Better: ${recommended}`}
      </AppText>
      {!correct && evLost !== null && evLost > 0 ? (
        <AppText variant="caption" color="textSecondary" numeric>
          {`Costs about ${formatMagnitude(evLost)} of a bet on average`}
        </AppText>
      ) : null}
    </Pressable>
  );
}

const MODES: { id: AssistanceMode; label: string; hint: string }[] = [
  { id: "play", label: "Play", hint: "No assistance" },
  { id: "learn", label: "Learn", hint: "Shows the recommended play" },
  { id: "analysis", label: "Analysis", hint: "Shows expected value for every action" },
  { id: "challenge", label: "Challenge", hint: "Grades each decision after you make it" },
];

export function AssistanceModeSelector({
  mode,
  onChange,
}: {
  mode: AssistanceMode;
  onChange: (mode: AssistanceMode) => void;
}) {
  return (
    <View style={styles.modeRow} accessibilityRole="radiogroup">
      {MODES.map((entry) => {
        const active = entry.id === mode;
        return (
          <Pressable
            key={entry.id}
            onPress={() => onChange(entry.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={entry.label}
            accessibilityHint={entry.hint}
            style={({ pressed }) => [
              styles.modeChip,
              active ? styles.modeChipActive : null,
              pressed ? styles.pressed : null,
            ]}
          >
            <AppText variant="caption" color={active ? "textPrimary" : "textSecondary"}>
              {entry.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  pressed: {
    opacity: 0.75,
  },
  detail: {
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.small,
    backgroundColor: colors.surfaceSoft,
  },
  scrim: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxxl,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.borderStrong,
    marginBottom: spacing.md,
  },
  detailHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  evTable: {
    gap: spacing.xs,
  },
  evRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 2,
  },
  feedback: {
    alignItems: "center",
    gap: 2,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.small,
    borderWidth: 1,
  },
  feedbackGood: {
    borderColor: colors.success,
    backgroundColor: "rgba(126,214,167,0.08)",
  },
  feedbackBad: {
    borderColor: colors.warning,
    backgroundColor: "rgba(242,201,109,0.08)",
  },
  modeRow: {
    flexDirection: "row",
    gap: spacing.xs,
  },
  modeChip: {
    flex: 1,
    minHeight: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  modeChipActive: {
    borderColor: colors.accent,
    backgroundColor: colors.surfaceRaised,
  },
});
