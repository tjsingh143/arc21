/**
 * What each assistance mode offers AFTER the decision.
 *
 * The specification is precise about this and the four modes differ on purpose:
 *
 *   Play       optional hand history ONLY — no analytics, ever
 *   Learn      the normal result; the rationale was available before the choice
 *   Analysis   the full decision log
 *   Challenge  immediate correct/incorrect feedback (a separate component)
 *
 * So this sheet has two tabs and Play can only ever see one of them. That is not
 * a styling decision: showing a Play-mode player a graded decision log after the
 * hand would make Play a coaching mode, and the whole point of Play is that it
 * is not one.
 *
 * NOTHING HERE IS A CARD. The history records totals and outcomes rather than
 * the cards that made them — a per-hand card list is shoe information wearing a
 * different hat, and a player reviewing their play needs the total they stood
 * on, not the order the deck came out in.
 *
 * Never rendered with invented rows: an empty history says so.
 */

import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { colors, MIN_TOUCH_TARGET, radius, spacing } from "../../design/tokens";
import { formatChipDelta, formatChips } from "../../design/typography";
import { AppText } from "../ui/AppText";
import { actionLabel, formatMagnitude } from "../../features/practice/advice";
import type { PracticeHandRecord } from "../../features/practice/practice-record";
import { reviewTabsFor, type ReviewTab } from "../../features/practice/assistance";
import type { AssistanceMode, DecisionFeedback } from "../../features/practice/practice-store";
import type { HandOutcomeKind } from "../../../shared/blackjack/types";

const TAB_LABEL: Readonly<Record<ReviewTab, string>> = {
  hands: "Hands",
  decisions: "Decisions",
};

export interface ReviewSheetProps {
  mode: AssistanceMode;
  handHistory: readonly PracticeHandRecord[];
  decisionLog: readonly DecisionFeedback[];
  onClose: () => void;
}

export function ReviewSheet({ mode, handHistory, decisionLog, onClose }: ReviewSheetProps) {
  const tabs = reviewTabsFor(mode);
  const [tab, setTab] = useState<ReviewTab>(tabs[0] ?? "hands");
  const active = tabs.includes(tab) ? tab : (tabs[0] ?? "hands");

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      {/*
        The dismiss target is a SIBLING of the sheet, never its parent.

        A `Pressable` carrying `accessibilityLabel="Close review"` with the sheet
        inside it collapses every string within — on iOS a label on a pressable
        replaces the text of everything it contains. That would have reduced the
        whole review, every hand and every graded decision, to the two words
        "Close review" for anyone using VoiceOver: a history surface that
        announces nothing but its own exit.

        An absolutely-filled Pressable behind the sheet keeps
        tap-outside-to-dismiss and leaves the content speaking for itself. The
        sheet no longer needs to stop propagation, because it is no longer inside
        the thing it was defending against.
      */}
      <View style={styles.scrim}>
        <Pressable
          style={styles.scrimTap}
          accessibilityRole="button"
          accessibilityLabel="Close review"
          onPress={onClose}
        />
        <View style={styles.sheet}>
          <View style={styles.handle} />

          {tabs.length > 1 ? (
            <View style={styles.tabRow} accessibilityRole="tablist">
              {tabs.map((candidate) => (
                <Pressable
                  key={candidate}
                  onPress={() => setTab(candidate)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: candidate === active }}
                  accessibilityLabel={TAB_LABEL[candidate]}
                  style={[styles.tab, candidate === active ? styles.tabActive : null]}
                >
                  <AppText
                    variant="caption"
                    color={candidate === active ? "textPrimary" : "textSecondary"}
                  >
                    {TAB_LABEL[candidate]}
                  </AppText>
                </Pressable>
              ))}
            </View>
          ) : (
            <AppText variant="sectionTitle">Hand history</AppText>
          )}

          <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
            {active === "hands" ? (
              <HandList records={handHistory} />
            ) : (
              <DecisionList entries={decisionLog} />
            )}
          </ScrollView>

          <AppText variant="caption" color="textDisabled">
            {active === "hands"
              ? `The last ${handHistory.length} hands recorded on this device.`
              : `The last ${decisionLog.length} graded decisions recorded on this device.`}
          </AppText>
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function HandList({ records }: { records: readonly PracticeHandRecord[] }) {
  if (records.length === 0) {
    return (
      <AppText variant="body" color="textSecondary">
        No hands yet. Play one and it appears here — nothing on this screen is
        filled in ahead of time.
      </AppText>
    );
  }

  return (
    <View style={styles.rows}>
      {records.map((record) => (
        <HandRow key={`${record.handNumber}-${record.net}-${record.wagered}`} record={record} />
      ))}
    </View>
  );
}

/** "Won", "Lost", "Push" — plain words for what the engine settled. */
function describeOutcome(kind: HandOutcomeKind): string {
  switch (kind) {
    case "BLACKJACK":
      return "Blackjack";
    case "WIN":
      return "Won";
    case "PUSH":
      return "Push";
    case "BUST":
      return "Bust";
    case "SURRENDER":
      return "Surrendered";
    case "LOSS":
      return "Lost";
  }
}

function HandRow({ record }: { record: PracticeHandRecord }) {
  const dealer = record.dealerBusted
    ? "Dealer bust"
    : record.dealerTotal === null
      ? "Dealer did not play"
      : `Dealer ${record.dealerTotal}`;

  const hands = record.outcomes
    .map((kind, index) => {
      const total = record.playerTotals[index];
      return total === undefined
        ? describeOutcome(kind)
        : `${total} · ${describeOutcome(kind)}`;
    })
    .join("   ");

  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={`Hand ${record.handNumber}. ${hands}. ${dealer}. ${
        record.net === 0 ? "Push" : `Net ${formatChipDelta(record.net)}`
      }.`}
    >
      <View style={styles.rowMain}>
        <AppText variant="caption" color="textDisabled" numeric>
          {`Hand ${record.handNumber} · ${formatChips(record.wagered)} wagered`}
        </AppText>
        <AppText variant="body" numeric>
          {hands || "—"}
        </AppText>
        <AppText variant="caption" color="textSecondary" numeric>
          {record.insuranceNet === 0
            ? dealer
            : `${dealer} · insurance ${formatChipDelta(record.insuranceNet)}`}
        </AppText>
      </View>
      <AppText
        variant="bodyStrong"
        numeric
        color={record.net > 0 ? "success" : record.net < 0 ? "danger" : "textSecondary"}
      >
        {record.net === 0 ? "Push" : formatChipDelta(record.net)}
      </AppText>
    </View>
  );
}

function DecisionList({ entries }: { entries: readonly DecisionFeedback[] }) {
  if (entries.length === 0) {
    return (
      <AppText variant="body" color="textSecondary">
        No graded decisions yet. A decision is only graded when the validated
        tables can actually adjudicate it.
      </AppText>
    );
  }

  return (
    <View style={styles.rows}>
      {entries.map((entry, index) => (
        <View
          key={`${entry.handNumber}-${index}-${entry.chosen}`}
          style={styles.row}
          accessible
          accessibilityLabel={
            entry.correct
              ? `Hand ${entry.handNumber}, ${entry.handLabel} against ${entry.upcardLabel}. ${actionLabel(entry.chosen)}. Best play.`
              : `Hand ${entry.handNumber}, ${entry.handLabel} against ${entry.upcardLabel}. You played ${actionLabel(entry.chosen)}; ${actionLabel(entry.recommended)} was better.`
          }
        >
          <View style={styles.rowMain}>
            <AppText variant="caption" color="textDisabled" numeric>
              {`Hand ${entry.handNumber}`}
            </AppText>
            <AppText variant="body">
              {`${entry.handLabel} vs ${entry.upcardLabel}`}
            </AppText>
            <AppText variant="caption" color="textSecondary">
              {entry.correct
                ? `${actionLabel(entry.chosen)} — best play`
                : `Played ${actionLabel(entry.chosen)}, better was ${actionLabel(entry.recommended)}`}
            </AppText>
          </View>
          {/* An unpriced mistake shows no number at all: "we could not price
              this" is not the same statement as "this cost nothing". */}
          <AppText
            variant="bodyStrong"
            numeric
            color={entry.correct ? "success" : "warning"}
          >
            {entry.correct
              ? "✓"
              : entry.evLost === null
                ? "—"
                : `−${formatMagnitude(entry.evLost)}`}
          </AppText>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
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
    backgroundColor: colors.surfaceRaised,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    padding: spacing.lg,
    gap: spacing.md,
    maxHeight: "80%",
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
  },
  tabRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  tab: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabActive: {
    borderColor: colors.accent,
    backgroundColor: colors.surfaceSoft,
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    paddingBottom: spacing.sm,
  },
  rows: {
    gap: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowMain: {
    flex: 1,
    gap: 2,
  },
});
