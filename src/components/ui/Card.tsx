/**
 * Surface primitives shared by Home, Play and Career.
 *
 * `UnavailableNote` is load-bearing for the product's honesty rule: a surface
 * that needs a server we do not have yet says so plainly. It never renders
 * zeros, fake friends or an empty leaderboard that would read as real data.
 */

import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { useBorderColor } from "../../design/accessibility";
import { colors, MIN_TOUCH_TARGET, radius, spacing } from "../../design/tokens";
import { MAX_TITLE_FONT_SCALE } from "../../design/type-metrics";
import { AppText } from "./AppText";

export interface SurfaceCardProps {
  children: React.ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Dims the card and blocks interaction. */
  disabled?: boolean;
  /**
   * `StyleProp` rather than a bare `ViewStyle`, so a caller can compose a base
   * style with a conditional one — a selected tab, a highlighted row — without
   * merging objects by hand at every call site.
   */
  style?: StyleProp<ViewStyle>;
  /**
   * Marks a card used as a tab or an option. Passed through to
   * `accessibilityState`, because a screen reader announcing four identical
   * buttons with no indication of which is active is not usable.
   */
  selected?: boolean;
  testID?: string;
}

export function SurfaceCard({
  children,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  style,
  selected,
  testID,
}: SurfaceCardProps) {
  const borderColor = useBorderColor();

  if (!onPress) {
    /*
     * `testID` travels down this branch too.
     *
     * It did not, and the omission was invisible in the way this project's
     * accessibility defects always are: `app/table/[gameId].tsx` has carried
     * `<SurfaceCard testID="table-advice">` with no `onPress` since the advice
     * panel shipped, so the id existed in the source, matched nothing in the
     * tree, and any flow selecting on it would have failed while looking like a
     * broken screen. An inert card is the RIGHT shape for a container whose
     * control is a Button inside it — a labelled Pressable replaces the text of
     * everything within it on iOS — so this branch needs to stay addressable.
     */
    return (
      <View
        testID={testID}
        style={[styles.card, { borderColor }, disabled ? styles.disabled : null, style]}
      >
        {children}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole={selected === undefined ? "button" : "tab"}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={selected === undefined ? { disabled } : { disabled, selected }}
      style={({ pressed }) => [
        styles.card,
        // Only the pressable variant needs the floor: a plain, non-interactive
        // SurfaceCard can be any height. Without this, a card whose only
        // content is a short label — a category tab, a compact chip — renders
        // under 48dp, which `scripts/check-contrast.ts`'s sibling concern
        // (touch target size) has no automated check for, so it goes unnoticed
        // until someone measures it. `inventory-tab-*` was exactly this shape.
        styles.pressableMinHeight,
        { borderColor },
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

/**
 * Small labelled tile used in rows on Home and Play.
 *
 * The label carries the DETAIL as well as the name. It used to be the name
 * alone with the detail as a hint — and a hint is spoken last, only when hints
 * are on, and is not part of the element's text — so "Daily Challenge" was
 * announced without "Same shoe for everyone", which is the half that says what
 * it is. A labelled pressable replaces its children on iOS, so whatever the
 * tile shows has to be in the label.
 */
export function Tile({
  label,
  detail,
  onPress,
  disabled = false,
  testID,
  accessibilityLabel,
  accessibilityHint,
}: {
  label: string;
  detail: string;
  onPress?: () => void;
  disabled?: boolean;
  testID?: string;
  /** Defaults to the label and the detail together. */
  accessibilityLabel?: string;
  /** What activating it does. Nothing a player needs in order to choose. */
  accessibilityHint?: string;
}) {
  return (
    <SurfaceCard
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityLabel={accessibilityLabel ?? `${label}. ${detail}.`}
      accessibilityHint={accessibilityHint}
      style={styles.tile}
    >
      <AppText
        variant="bodyStrong"
        color={disabled ? "textDisabled" : "textPrimary"}
        maxFontSizeMultiplier={MAX_TITLE_FONT_SCALE}
      >
        {label}
      </AppText>
      <AppText variant="caption" color="textSecondary">
        {detail}
      </AppText>
    </SurfaceCard>
  );
}

/**
 * The heading above a group of cards — one tier of Home or Play.
 *
 * Announced as a header, so a screen-reader user can move between tiers with
 * the headings rotor instead of hearing every card in between. The visible
 * overline is upper-cased by its typography token, so an E2E flow should
 * select it by `testID`, never by its title as written here.
 */
export function SectionHeading({
  title,
  summary,
  testID,
}: {
  title: string;
  summary?: string;
  testID?: string;
}) {
  return (
    <View style={styles.sectionHeading} testID={testID}>
      <AppText variant="overline" color="textSecondary" accessibilityRole="header">
        {title}
      </AppText>
      {summary ? (
        <AppText variant="caption" color="textSecondary">
          {summary}
        </AppText>
      ) : null}
    </View>
  );
}

/**
 * States a capability the build does not have yet, in the user's terms.
 *
 * The alternative — a disabled button with no explanation, or worse, zeros
 * standing in for real numbers — reads as broken or, much worse, as true.
 */
export function UnavailableNote({ children }: { children: React.ReactNode }) {
  const borderColor = useBorderColor();
  return (
    <View style={[styles.unavailable, { borderColor }]} accessibilityRole="summary">
      <AppText variant="caption" color="textSecondary">
        {children}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  tile: {
    flex: 1,
    minHeight: MIN_TOUCH_TARGET + spacing.lg,
    justifyContent: "center",
  },
  pressableMinHeight: {
    minHeight: MIN_TOUCH_TARGET,
  },
  pressed: {
    opacity: 0.8,
    transform: [{ scale: 0.995 }],
  },
  disabled: {
    opacity: 0.55,
  },
  sectionHeading: {
    gap: spacing.xs,
  },
  unavailable: {
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    padding: spacing.md,
  },
});
