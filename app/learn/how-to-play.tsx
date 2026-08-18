/**
 * How to Play — the rules, end to end.
 *
 * Every rule-dependent sentence on this screen is BUILT FROM `ARC_STANDARD_RULES`
 * through `src/features/learn/ruleset-facts.ts`, not typed into a paragraph. A
 * rules article is the easiest surface in a product to turn into a lie: someone
 * writes "dealer stands on soft 17", the ruleset changes two releases later, and
 * the article keeps confidently teaching the wrong game. Here it cannot — the
 * sentence changes with the rules, and `tests/learn/ruleset-facts.test.ts` feeds
 * variant rulesets through the same functions to prove the branches are real.
 *
 * Illustrations use the real `PlayingCard`, the same component the table renders,
 * so an example can never show a card the game could not deal.
 */

import { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard } from "../../src/components/ui/Card";
import { PlayingCard } from "../../src/components/cards/PlayingCard";
import { colors, layout, radius, spacing } from "../../src/design/tokens";
import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";
import type { Card, Rank, Suit } from "../../shared/blackjack/types.js";
import {
  dealerRuleSentence,
  doubleRuleSentence,
  insurancePayoutRatio,
  insuranceStakeDescription,
  NO_PROFIT_CLAIM,
  rulesetFacts,
  settlementRows,
  splitAceTwentyOneSentence,
  splitRuleSentence,
  surrenderRuleSentence,
  VIRTUAL_CHIPS_DISCLAIMER,
} from "../../src/features/learn/ruleset-facts";

const RULES = ARC_STANDARD_RULES;

/**
 * An illustration card. Constructed here rather than drawn from a shoe, because
 * nothing on this screen is a hand in play — and given a stable id so the same
 * example renders identically every time.
 */
function illustration(rank: Rank, suit: Suit, slot: string): Card {
  return { id: `article:${slot}:${rank}${suit}`, suit, rank, deckIndex: 0 };
}

export default function HowToPlayScreen() {
  const facts = useMemo(() => rulesetFacts(RULES), []);
  const settlement = useMemo(() => settlementRows(RULES), []);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={{ paddingHorizontal: layout.screenPadding }}>
        <BackBar />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <AppText variant="pageTitle" accessibilityRole="header">
            How to Play
          </AppText>
          <AppText variant="body" color="textSecondary">
            Blackjack in full, described exactly as Arc 21 deals it.
          </AppText>
        </View>

        {/* -------------------------------------------------------------- */}
        <Section title="The goal">
          <Paragraph>
            Beat the dealer&apos;s hand without going over 21. That is the whole
            game. You are not trying to get as close to 21 as possible, and you
            are not playing against the other people at the table — only against
            the dealer.
          </Paragraph>
          <Paragraph>
            Go over 21 and you bust: the hand is over and the bet is lost
            immediately, before the dealer draws a single card. That asymmetry is
            where the house edge comes from, and it is why standing on a bad hand
            is often the right answer.
          </Paragraph>
        </Section>

        {/* -------------------------------------------------------------- */}
        <Section title="What the cards are worth">
          <CardFan
            label="Number cards are worth their number; every picture card is worth 10"
            cards={[
              illustration("7", "H", "value-7"),
              illustration("10", "S", "value-10"),
              illustration("K", "D", "value-k"),
            ]}
          />
          <Paragraph>
            2 through 10 are worth their face value. Jack, queen and king are all
            worth 10 — there is no difference between them at the table. Suits
            never matter for anything.
          </Paragraph>
        </Section>

        {/* -------------------------------------------------------------- */}
        <Section title="The ace is worth 1 or 11">
          <CardFan
            label="Ace and six, a soft 17"
            cards={[illustration("A", "S", "soft-a"), illustration("6", "H", "soft-6")]}
          />
          <Paragraph>
            An ace counts as 11 whenever that does not bust you, and as 1 when it
            would. A hand holding an ace still counted as 11 is called{" "}
            <AppText variant="bodyStrong">soft</AppText>, because one more card
            cannot bust it — the ace quietly drops to 1 instead.
          </Paragraph>
          <Paragraph>
            Ace and six is a soft 17. Draw a nine and it does not bust: it becomes
            a hard 16. That safety net is why soft hands are played so differently
            from hard ones, and why the Strategy Guide keeps them on separate
            tabs.
          </Paragraph>
        </Section>

        {/* -------------------------------------------------------------- */}
        <Section title="Blackjack">
          <CardFan
            label="Ace and king, a blackjack"
            cards={[illustration("A", "S", "bj-a"), illustration("K", "H", "bj-k")]}
          />
          <Paragraph>
            An ace with any ten-value card on your first two cards is a blackjack
            — a natural. It pays{" "}
            <AppText variant="bodyStrong">
              {`${RULES.blackjackPayoutNumerator}:${RULES.blackjackPayoutDenominator}`}
            </AppText>{" "}
            instead of the usual even money, and it beats every other 21.
          </Paragraph>
          <Paragraph>
            If the dealer also has blackjack the hand is a push. {splitAceTwentyOneSentence(RULES)}
          </Paragraph>
        </Section>

        {/* -------------------------------------------------------------- */}
        <Section title="Your turn">
          <Move name="Hit" summary="Take another card.">
            You can keep hitting as long as you are under 21. Reach 21 exactly and
            the hand completes on its own — the only thing another card could do
            is bust it.
          </Move>

          <Move name="Stand" summary="Take no more cards.">
            Your total is locked in and play moves on. Standing on 16 against a
            dealer ten feels wrong and is still the least bad option on many
            hands; the chart says which.
          </Move>

          <Move name="Double" summary="Double the bet, take exactly one card.">
            {doubleRuleSentence(RULES)}
          </Move>

          <Move name="Split" summary="Turn a pair into two hands.">
            {splitRuleSentence(RULES)}
          </Move>

          <Move name="Surrender" summary="Give up the hand, keep half the bet.">
            {surrenderRuleSentence(RULES)}
          </Move>
        </Section>

        {/* -------------------------------------------------------------- */}
        <Section title="Insurance">
          <Paragraph>
            When the dealer&apos;s upcard is an ace you are offered insurance: a
            separate side bet of {insuranceStakeDescription(RULES)}, paying{" "}
            {insurancePayoutRatio(RULES)} if the dealer&apos;s hidden card is a
            ten and losing otherwise.
          </Paragraph>
          <Paragraph>
            It is offered before the dealer checks, so it is a genuine wager on
            whether that card is a ten. Roughly four cards in thirteen are, which
            is why basic strategy declines insurance on every hand, including
            when you hold a blackjack yourself. &ldquo;Even money&rdquo; is the
            same bet under a friendlier name.
          </Paragraph>
        </Section>

        {/* -------------------------------------------------------------- */}
        <Section title="How the dealer plays">
          <Paragraph>{dealerRuleSentence(RULES)}</Paragraph>
          <Paragraph>
            The dealer has no choices to make and no strategy to adapt. The same
            fixed procedure runs whether you are winning or losing, whether it is
            your first hand or your thousandth, and whatever your balance is.
          </Paragraph>
          <Paragraph>
            If every hand at the table has already busted or surrendered, the
            dealer reveals but does not draw — there is nothing left to beat.
          </Paragraph>
        </Section>

        {/* -------------------------------------------------------------- */}
        <Section title="Push">
          <Paragraph>
            A push is a tie: your total and the dealer&apos;s are equal, so the
            bet comes back and nothing is won or lost. Two blackjacks push as
            well. A push is not a loss, and the drills and statistics never count
            it as one.
          </Paragraph>
        </Section>

        {/* -------------------------------------------------------------- */}
        <Section title="What each result returns">
          <SurfaceCard>
            {settlement.map((row) => (
              <View key={row.result} style={styles.settleRow}>
                <View style={styles.settleHead}>
                  <AppText variant="bodyStrong">{row.result}</AppText>
                  <AppText variant="bodyStrong" color="accent" numeric>
                    {row.returns}
                  </AppText>
                </View>
                <AppText variant="caption" color="textSecondary">
                  {row.note}
                </AppText>
              </View>
            ))}
          </SurfaceCard>
          <AppText variant="caption" color="textDisabled">
            Stated as what returns to your stack, because that is what actually
            happens: the bet leaves your chips when you commit it, so a winning
            hand pays back the stake and the win together.
          </AppText>
        </Section>

        {/* -------------------------------------------------------------- */}
        <Section title="This table at a glance">
          <SurfaceCard>
            {facts.map((fact) => (
              <View key={fact.label} style={styles.factRow}>
                <AppText variant="caption" color="textSecondary" style={styles.factLabel}>
                  {fact.label}
                </AppText>
                <AppText variant="body" style={styles.factValue}>
                  {fact.value}
                </AppText>
              </View>
            ))}
          </SurfaceCard>
          <AppText variant="caption" color="textDisabled">
            Rule variations change correct play. Every chart and drill in Arc 21 is
            solved for these exact rules rather than borrowed from another table.
          </AppText>
        </Section>

        {/* -------------------------------------------------------------- */}
        <View style={styles.actions}>
          <Button
            label="Strategy Guide"
            onPress={() => router.push("/learn/strategy-guide")}
            accessibilityHint="The full chart for these rules"
          />
          <Button
            label="Drills"
            onPress={() => router.push("/learn/drills")}
            variant="secondary"
            accessibilityHint="Practise one decision at a time"
          />
        </View>

        <View style={styles.disclaimer} accessibilityRole="summary">
          <AppText variant="caption" color="textSecondary">
            {VIRTUAL_CHIPS_DISCLAIMER}
          </AppText>
          <AppText variant="caption" color="textSecondary">
            {NO_PROFIT_CLAIM}
          </AppText>
        </View>

        <Button label="Back" onPress={() => router.back()} variant="quiet" />
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Article furniture
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <AppText variant="sectionTitle" accessibilityRole="header">
        {title}
      </AppText>
      {children}
    </View>
  );
}

function Paragraph({ children }: { children: React.ReactNode }) {
  return (
    <AppText variant="body" color="textSecondary">
      {children}
    </AppText>
  );
}

/**
 * One move, as a labelled block rather than a bullet.
 *
 * The name and the one-line summary are separated so a screen reader announces
 * "Double. Double the bet, take exactly one card." before the detail, which is
 * the order someone scanning the screen reads them in anyway.
 */
function Move({
  name,
  summary,
  children,
}: {
  name: string;
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.move} accessible accessibilityLabel={`${name}. ${summary}`}>
      <View style={styles.moveHead}>
        <AppText variant="bodyStrong">{name}</AppText>
        <AppText variant="caption" color="accent" style={styles.moveSummary}>
          {summary}
        </AppText>
      </View>
      <AppText variant="body" color="textSecondary">
        {children}
      </AppText>
    </View>
  );
}

/**
 * A few real cards, with one accessible label for the group.
 *
 * Each `PlayingCard` already announces itself ("Ace of Spades"), so the fan is
 * marked as a single element with the caption as its label — otherwise a screen
 * reader reads three card names with no indication of what they illustrate.
 */
function CardFan({ cards, label }: { cards: readonly Card[]; label: string }) {
  return (
    <View style={styles.fanBlock}>
      <View style={styles.fan} accessible accessibilityLabel={label}>
        {cards.map((card) => (
          <PlayingCard key={card.id} card={card} size="medium" />
        ))}
      </View>
      <AppText variant="caption" color="textDisabled">
        {label}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.xl,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  header: { gap: spacing.xs, paddingTop: spacing.sm },
  section: { gap: spacing.md },
  fanBlock: { gap: spacing.sm },
  fan: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  move: {
    gap: spacing.xs,
    paddingLeft: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
  },
  moveHead: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: spacing.sm,
    flexWrap: "wrap",
  },
  moveSummary: { flexShrink: 1 },
  settleRow: {
    gap: 2,
    paddingVertical: spacing.xs,
  },
  settleHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  factRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.lg,
    paddingVertical: spacing.xs,
  },
  factLabel: { paddingTop: 3 },
  factValue: { flexShrink: 1, textAlign: "right" },
  actions: { gap: spacing.md },
  disclaimer: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
  },
});
