/**
 * Arc 21 — playing cards, rendered programmatically.
 *
 * No image assets: cards are drawn from vector primitives, so they stay crisp at
 * every density, cost nothing in bundle size, and are original by construction.
 *
 * ACCESSIBILITY: suit identity never depends on colour. Every card carries a
 * suit *glyph* (shape) and an accessible label ("Ace of Spades"), so red/black
 * is decoration rather than information. Diamonds and hearts are additionally
 * distinguishable by outline weight for users who cannot separate the hues.
 */

import { memo, useMemo } from "react";
import { StyleSheet, View, Text, type ViewStyle } from "react-native";

import { cardAccessibilityLabel } from "../../../shared/blackjack/cards.js";
import type { Card, Suit } from "../../../shared/blackjack/types.js";
import { cardBackArt } from "../../features/cosmetics/art/registry.js";
import { useLoadoutStore } from "../../features/cosmetics/loadout-store.js";
import { useBorderColor } from "../../design/accessibility";
import { cardSizes, colors, radius, type CardSize } from "../../design/tokens";

const SUIT_GLYPH: Record<Suit, string> = {
  S: "♠",
  H: "♥",
  D: "♦",
  C: "♣",
};

/** Red suits use the card-red token; black suits use card ink. */
function suitColor(suit: Suit): string {
  return suit === "H" || suit === "D" ? colors.cardRed : colors.cardInk;
}

export interface PlayingCardProps {
  card: Card;
  size?: CardSize;
  /** Dims the card when another hand has focus. */
  dimmed?: boolean;
  style?: ViewStyle;
}

export const PlayingCard = memo(function PlayingCard({
  card,
  size = "hero",
  dimmed = false,
  style,
}: PlayingCardProps) {
  const dimensions = cardSizes[size];
  const ink = suitColor(card.suit);
  const glyph = SUIT_GLYPH[card.suit];

  // Rank text scales with the card so "10" stays legible at compact sizes.
  const rankFontSize = dimensions.width * (card.rank === "10" ? 0.3 : 0.36);
  const cornerGlyphSize = dimensions.width * 0.2;
  const centerGlyphSize = dimensions.width * 0.46;

  return (
    <View
      style={[
        styles.container,
        {
          width: dimensions.width,
          height: dimensions.height,
          opacity: dimmed ? 0.55 : 1,
        },
        style,
      ]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={cardAccessibilityLabel(card)}
    >
      <View style={styles.face}>
        <View style={styles.corner}>
          <Text
            style={[styles.rank, { fontSize: rankFontSize, color: ink }]}
            allowFontScaling={false}
            numberOfLines={1}
          >
            {card.rank}
          </Text>
          <Text
            style={[styles.cornerGlyph, { fontSize: cornerGlyphSize, color: ink }]}
            allowFontScaling={false}
          >
            {glyph}
          </Text>
        </View>

        <Text
          style={[styles.centerGlyph, { fontSize: centerGlyphSize, color: ink }]}
          allowFontScaling={false}
        >
          {glyph}
        </Text>
      </View>
    </View>
  );
});

export interface CardBackProps {
  size?: CardSize;
  style?: ViewStyle;
  /** Announced for the dealer's face-down card. */
  accessibilityLabel?: string;
}

/**
 * The face-down card, drawn with whichever back is equipped.
 *
 * The art lives in `src/features/cosmetics/art/card-backs.tsx`, keyed by the
 * catalogue's `asset_key` — every drawing is original geometric construction.
 * This component subscribes to the loadout store, so every table shows the
 * change the moment a back is equipped, and a guest gets the Arc Standard
 * default without any fetch.
 */
export const CardBack = memo(function CardBack({
  size = "hero",
  style,
  accessibilityLabel = "Face-down card",
}: CardBackProps) {
  const { width, height } = cardSizes[size];

  /*
   * Derived with `useMemo` from subscribed state rather than by calling a store
   * getter during render — that freezes the value under the React Compiler.
   */
  const cardBackKey = useLoadoutStore((state) => state.loadout.cardBackKey);
  const Back = useMemo(() => cardBackArt(cardBackKey), [cardBackKey]);

  return (
    <View
      style={[styles.container, { width, height }, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      <Back width={width} height={height} />
    </View>
  );
});

/** Outline placeholder marking where a card will land. */
export const CardSlot = memo(function CardSlot({ size = "hero" }: { size?: CardSize }) {
  const { width, height } = cardSizes[size];
  const borderColor = useBorderColor();
  return (
    <View
      style={[
        styles.slot,
        { width, height, borderRadius: radius.small, borderColor },
      ]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
});

const styles = StyleSheet.create({
  container: {
    borderRadius: radius.small,
    overflow: "hidden",
    backgroundColor: colors.cardFace,
    // A subtle lift so overlapping cards in a fan stay separable.
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  face: {
    flex: 1,
    backgroundColor: colors.cardFace,
    padding: 4,
  },
  corner: {
    alignItems: "center",
    alignSelf: "flex-start",
  },
  rank: {
    fontWeight: "700",
    includeFontPadding: false,
  },
  cornerGlyph: {
    marginTop: -2,
    includeFontPadding: false,
  },
  centerGlyph: {
    position: "absolute",
    right: 6,
    bottom: 2,
    includeFontPadding: false,
    opacity: 0.9,
  },
  slot: {
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    backgroundColor: "transparent",
  },
});
