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
  formatProbability,
  type TableAdvice,
} from "../../features/practice/advice";
import {
  ASSISTANCE_MODES,
  assistanceMode,
  showsProbabilities,
  showsStrategyPanel,
} from "../../features/practice/assistance";
import type { AssistanceMode } from "../../features/practice/practice-store";

export interface StrategyPanelProps {
  mode: AssistanceMode;
  advice: TableAdvice;
}

export function StrategyPanel({ mode, advice }: StrategyPanelProps) {
  const [expanded, setExpanded] = useState(false);

  /*
   * ONE PREDICATE, TESTED DIRECTLY.
   *
   * `showsStrategyPanel` folds both reasons for silence together: the MODE
   * withholds the answer (Play and Challenge, which must be identical during a
   * decision), or the TABLES have none to give. It lives in
   * `features/practice/assistance.ts` so the product's teaching contract can be
   * asserted without rendering anything — the lesson this repository learned
   * from a correct `lockBet` wired to a button nobody could press.
   */
  if (!showsStrategyPanel(mode, advice)) return null;
  if (!advice.recommendation) return null;

  const action = advice.recommendation.action;
  const isAnalysis = assistanceMode(mode).showsExpectedValues;

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
          {/*
            THE DISMISS TARGET IS A SIBLING OF THE SHEET, NOT ITS PARENT.

            It used to wrap it: a `Pressable` carrying
            `accessibilityLabel="Close analysis"` with the sheet inside. On iOS a
            label on a pressable REPLACES the text of everything within it, so
            the entire analysis — the EV table, both probabilities, the ruleset
            caption — collapsed into the single word "Close analysis" in the
            accessibility tree. The screen looked perfect and a VoiceOver user
            was told nothing at all, which is a strange failure for the mode
            whose whole purpose is explaining a decision.

            Found by asserting on the RESULT rather than on the tap: a Maestro
            probe could not see "Bust if you hit" on a screenshot that plainly
            showed it. This repository has been caught by the same rule twice
            before, on the Home card and on the accessibility switches.

            An absolutely-filled Pressable behind the sheet keeps
            tap-outside-to-dismiss working, and the sheet's own content is no
            longer inside anything that speaks for it — so it no longer needs to
            stop propagation either.
          */}
          <View style={styles.scrim}>
            <Pressable
              style={styles.scrimTap}
              accessibilityRole="button"
              accessibilityLabel="Close analysis"
              onPress={() => setExpanded(false)}
            />
            <View style={styles.sheet}>
              <View style={styles.sheetHandle} />
              {renderDetail()}
            </View>
          </View>
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

          {/*
            THE TWO PROBABILITIES, AND ONLY WHERE THE SOLVER PRODUCED THEM.

            Rendered from `advice.probabilities`, which is null when the table
            being served does not carry them — in which case this whole block is
            absent rather than filled with a number computed somewhere else. A
            probability estimated here would sit beside solver-exact EVs looking
            exactly like one of them.

            Both are properties of the POSITION rather than of any one action,
            which is why they sit apart from the EV table rather than as extra
            columns in it.
          */}
          {showsProbabilities(mode, advice) && advice.probabilities !== null ? (
            <View style={styles.evTable}>
              <AppText variant="overline" color="textSecondary">
                This position
              </AppText>
              <View style={styles.evRow}>
                <AppText variant="body" color="textSecondary">
                  Bust if you hit
                </AppText>
                <AppText
                  variant="body"
                  color="textPrimary"
                  numeric
                  accessibilityLabel={`Chance of busting on one more card, ${formatProbability(
                    advice.probabilities.bustIfHit,
                  )}`}
                >
                  {formatProbability(advice.probabilities.bustIfHit)}
                </AppText>
              </View>
              <View style={styles.evRow}>
                <AppText variant="body" color="textSecondary">
                  Dealer busts
                </AppText>
                <AppText
                  variant="body"
                  color="textPrimary"
                  numeric
                  accessibilityLabel={`Chance the dealer busts, ${formatProbability(
                    advice.probabilities.dealerBust,
                  )}`}
                >
                  {formatProbability(advice.probabilities.dealerBust)}
                </AppText>
              </View>
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

/** The selector renders the contract, rather than a second copy of its labels. */
const MODES = ASSISTANCE_MODES.map(assistanceMode);

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
  /*
   * The dismiss target is exactly the VISIBLE scrim — the space above the
   * sheet — rather than the whole screen behind it. An `absoluteFill` sibling
   * works for a pointer and for VoiceOver, but its centre lies under the sheet,
   * so anything that activates a control by its coordinates (a UI test, an
   * accessibility switch scanner) aims at the middle of the screen and hits the
   * sheet instead. A hit area should be where the control looks like it is.
   */
  scrimTap: {
    flex: 1,
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
    minHeight: MIN_TOUCH_TARGET,
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
