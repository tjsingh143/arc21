/**
 * Arc 21 — the three onboarding illustrations.
 *
 * They live here rather than in `app/(onboarding)/` because every file under
 * `app/` is a route: a shared component parked there would become a navigable
 * screen with no content.
 *
 * Two rules shape all three. Nothing is decorative fiction — the cards are real
 * cards and the recommendation is the table's own answer — and nothing is
 * borrowed: the seats on page three are geometric primitives drawn here, not
 * character art. Each is announced as a single accessible image so a screen
 * reader hears one description rather than six card labels.
 */

import { StyleSheet, View } from "react-native";
import Svg, { Circle, G, Path, Polygon, Rect } from "react-native-svg";

import { CardBack, PlayingCard } from "../../components/cards/PlayingCard";
import { AppText } from "../../components/ui/AppText";
import { colors, radius, spacing } from "../../design/tokens";
import { actionLabel } from "../practice/advice";
import {
  strategyShowcase,
  WELCOME_BLACKJACK_PAYOUT_LABEL,
  WELCOME_DEALER_UPCARD,
  WELCOME_HAND_ACCESSIBILITY_LABEL,
  WELCOME_PLAYER_CARDS,
} from "./showcase";

/**
 * One height for all three, so the title below them does not jump as the player
 * swipes. A moving headline reads as a rendering bug.
 */
export const ILLUSTRATION_HEIGHT = 152;

/** Page 1 — a real hand, and the dealer's upcard beside it. */
export function WelcomeHandIllustration() {
  return (
    <Frame accessibilityLabel={WELCOME_HAND_ACCESSIBILITY_LABEL}>
      <View style={styles.handRow}>
        <View style={styles.group}>
          <View style={styles.cards}>
            <PlayingCard card={WELCOME_DEALER_UPCARD} size="compact" />
            <CardBack size="compact" style={styles.overlapCompact} />
          </View>
          <AppText variant="overline" color="textDisabled">
            Dealer
          </AppText>
        </View>

        <View style={styles.group}>
          <View style={styles.cards}>
            {WELCOME_PLAYER_CARDS.map((card, index) => (
              <PlayingCard
                key={card.id}
                card={card}
                size="medium"
                style={index > 0 ? styles.overlapMedium : undefined}
              />
            ))}
          </View>
          <AppText variant="overline" color="textDisabled">
            You
          </AppText>
        </View>
      </View>

      {/* Read from the ruleset, so the screen cannot advertise a payout the
          table does not pay. */}
      <AppText variant="caption" color="textSecondary">
        {`Blackjack pays ${WELCOME_BLACKJACK_PAYOUT_LABEL}`}
      </AppText>
    </Frame>
  );
}

/** Page 2 — one decision, answered by the generated strategy table. */
export function StrategyChipIllustration() {
  const showcase = strategyShowcase();

  // The tables answering nothing is impossible for this cell in a shipped build
  // — a test asserts it — but the fail-safe is kept rather than assumed: an
  // invented recommendation in a teaching product is worse than an empty box.
  if (showcase === null) return <View style={styles.frame} />;

  const { scenario, action } = showcase;
  const play = actionLabel(action);

  return (
    <Frame
      accessibilityLabel={
        `${scenario.handLabel} against a dealer ${scenario.upcardLabel}. ` +
        `Recommended play: ${play}.`
      }
    >
      <View style={styles.cards}>
        {scenario.playerCards.map((card, index) => (
          <PlayingCard
            key={card.id}
            card={card}
            size="compact"
            style={index > 0 ? styles.overlapCompact : undefined}
          />
        ))}
        <View style={styles.versus}>
          <AppText variant="caption" color="textDisabled">
            vs
          </AppText>
        </View>
        <PlayingCard card={scenario.dealerUpcard} size="compact" />
      </View>

      <View style={styles.chip}>
        <AppText variant="overline" color="textSecondary">
          Recommended
        </AppText>
        <AppText variant="bodyStrong" color="accent">
          {play.toUpperCase()}
        </AppText>
      </View>

      <AppText variant="caption" color="textDisabled">
        {`${scenario.handLabel} · dealer ${scenario.upcardLabel}`}
      </AppText>
    </Frame>
  );
}

/**
 * Page 3 — three seats around a dealer.
 *
 * Deliberately abstract: circles carrying three different inner glyphs, so the
 * seats are told apart by SHAPE and not by colour, and nobody is depicted.
 */
export function TableCircleIllustration() {
  return (
    <Frame accessibilityLabel="Three players seated around a dealer, drawn as abstract shapes.">
      <Svg width={240} height={140} viewBox="0 0 240 140">
        {/* The arc motif, echoing the card back. */}
        <Path
          d="M 98 18 Q 120 4 142 18"
          fill="none"
          stroke={colors.accent}
          strokeWidth={2}
          strokeLinecap="round"
          opacity={0.6}
        />

        {/* The dealer: two fanned cards, no face and no figure. */}
        <G rotation={-13} originX={120} originY={44}>
          <Rect
            x={111}
            y={31}
            width={18}
            height={26}
            rx={3}
            fill={colors.surfaceRaised}
            stroke={colors.accent}
            strokeWidth={1.4}
          />
        </G>
        <G rotation={13} originX={120} originY={44}>
          <Rect
            x={111}
            y={31}
            width={18}
            height={26}
            rx={3}
            fill={colors.surfaceRaised}
            stroke={colors.accent}
            strokeWidth={1.4}
          />
        </G>

        {/* The table edge the three seats sit outside of. */}
        <Path
          d="M 26 64 Q 120 130 214 64"
          fill="none"
          stroke={colors.borderStrong}
          strokeWidth={1.5}
          strokeLinecap="round"
        />

        <Seat cx={44} cy={92}>
          <Polygon points="44,84 51,97 37,97" fill={colors.textSecondary} />
        </Seat>

        <Seat cx={120} cy={116}>
          <Rect x={112} y={110} width={16} height={3} rx={1.5} fill={colors.textSecondary} />
          <Rect x={112} y={118} width={16} height={3} rx={1.5} fill={colors.textSecondary} />
        </Seat>

        <Seat cx={196} cy={92}>
          <Polygon points="196,83 205,92 196,101 187,92" fill={colors.textSecondary} />
        </Seat>
      </Svg>
    </Frame>
  );
}

function Seat({ cx, cy, children }: { cx: number; cy: number; children: React.ReactNode }) {
  return (
    <G>
      <Circle
        cx={cx}
        cy={cy}
        r={14}
        fill={colors.surfaceRaised}
        stroke={colors.borderStrong}
        strokeWidth={1.5}
      />
      {children}
    </G>
  );
}

/**
 * One accessible element per illustration.
 *
 * Without this a screen reader walks six separate card labels before reaching
 * the headline that explains them.
 */
function Frame({
  children,
  accessibilityLabel,
}: {
  children?: React.ReactNode;
  accessibilityLabel: string;
}) {
  return (
    <View
      style={styles.frame}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility="no-hide-descendants"
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    height: ILLUSTRATION_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  handRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.xl,
  },
  group: {
    alignItems: "center",
    gap: spacing.xs,
  },
  cards: {
    flexDirection: "row",
    alignItems: "center",
  },
  // Cards overlap the way a real fan does, by roughly a third of a card.
  overlapCompact: {
    marginLeft: -14,
  },
  overlapMedium: {
    marginLeft: -24,
  },
  versus: {
    paddingHorizontal: spacing.md,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
});
