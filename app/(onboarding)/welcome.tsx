/**
 * First launch — three pages and a way in.
 *
 * The shape of this screen is an argument about what a first run is for. It is
 * not a funnel: there is no purchase prompt, no reward wheel, no notification
 * permission ask, and no account wall. Three short pages say what the product
 * is, and the way in is one obvious tap that works offline.
 *
 * The disclosure — 18+, virtual chips, no cash prizes — is on screen the whole
 * time rather than behind another tap. It is the one thing a player is entitled
 * to read before they start, so it is not something to page past.
 *
 * "Create Account" and "Sign In" lead to the real auth screens. They used to
 * open a note explaining that Arc 21 had no account service, which was true when
 * it was written and stopped being true three phases later — so onboarding was
 * still saying accounts did not exist while `app/(auth)/` was signing people in.
 * Guest is still first, still one tap, and still complete.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { router } from "expo-router";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { Button } from "../../src/components/ui/Button";
import { colors, layout, MIN_TOUCH_TARGET, radius, spacing } from "../../src/design/tokens";
import { useMotion } from "../../src/design/motion";
import {
  StrategyChipIllustration,
  TableCircleIllustration,
  WelcomeHandIllustration,
} from "../../src/features/onboarding/illustrations";
import {
  accountOption,
  ACCOUNT_OPTIONS,
  clampPageIndex,
  offsetForPageIndex,
  ONBOARDING_DISCLOSURE,
  ONBOARDING_PAGE_COUNT,
  ONBOARDING_PAGES,
  pageIndexFromOffset,
  type OnboardingPageId,
} from "../../src/features/onboarding/pages";
import { useOnboardingStore } from "../../src/features/onboarding/onboarding-store";

const ILLUSTRATIONS: Record<OnboardingPageId, () => React.ReactElement> = {
  table: WelcomeHandIllustration,
  strategy: StrategyChipIllustration,
  together: TableCircleIllustration,
};

export default function WelcomeScreen() {
  const { width } = useWindowDimensions();
  const motion = useMotion();
  const complete = useOnboardingStore((state) => state.complete);
  const completion = useOnboardingStore((state) => state.completion);

  const [page, setPage] = useState(0);
  const scrollRef = useRef<ScrollView>(null);

  const settle = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      setPage(pageIndexFromOffset(event.nativeEvent.contentOffset.x, width));
    },
    [width],
  );

  const goToPage = useCallback(
    (index: number) => {
      const target = clampPageIndex(index);
      setPage(target);
      scrollRef.current?.scrollTo({
        x: offsetForPageIndex(target, width),
        // Reduce Motion turns the page jump into a cut rather than a slide.
        animated: !motion.reduceMotion,
      });
    },
    [motion.reduceMotion, width],
  );

  /**
   * Guest is the whole of the entry flow: flip the flag, and the effect below
   * takes the player to Home.
   *
   * Navigating inline here — `complete()` immediately followed by
   * `router.replace()` — raced: the same state flip is what `app/index.tsx`
   * keys its own redirect on, so two navigations could be issued for one tap
   * and cancel each other. Measured at roughly one failure in three, on the
   * very first thing every player does.
   *
   * Driving navigation from committed state instead means exactly one
   * navigation happens, after React has settled.
   */
  const continueAsGuest = useCallback(() => {
    complete("guest");
  }, [complete]);

  useEffect(() => {
    if (!completion) return;
    // `replace` rather than `push` — the introduction must not sit under Home in
    // the back stack, where a system back gesture would return the player to a
    // screen they have already finished with.
    router.replace("/(tabs)/home");
  }, [completion]);

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <View style={styles.brand}>
        <AppText variant="overline" color="textDisabled">
          Arc 21
        </AppText>
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={settle}
        // A slow drag that never gains momentum fires only this one.
        onScrollEndDrag={settle}
        style={styles.pager}
        contentContainerStyle={styles.pagerContent}
      >
        {ONBOARDING_PAGES.map((entry) => {
          const Illustration = ILLUSTRATIONS[entry.id];
          return (
            /*
              Each page is itself vertically scrollable. The content is centred
              when it fits, which is every phone at default text size, and
              scrolls when it does not — at the largest accessibility text sizes
              a fixed layout would simply clip the sentence explaining the app.
            */
            <ScrollView
              key={entry.id}
              style={{ width }}
              contentContainerStyle={styles.page}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.pageInner}>
                <Illustration />
                <AppText variant="display" align="center">
                  {entry.title}
                </AppText>
                <AppText variant="body" color="textSecondary" align="center">
                  {entry.body}
                </AppText>
                {/* Said here, on the page that promises it, rather than
                    discovered later on a button that does nothing. */}
                {entry.caveat ? (
                  <AppText variant="caption" color="textDisabled" align="center">
                    {entry.caveat}
                  </AppText>
                ) : null}
              </View>
            </ScrollView>
          );
        })}
      </ScrollView>

      <PageDots active={page} onSelect={goToPage} />

      <View style={styles.dock}>
        <Button
          label="Continue as Guest"
          onPress={continueAsGuest}
          testID="onboarding-guest"
          accessibilityHint="Starts playing on this device. No account needed."
        />

        <View style={styles.accountRow}>
          {ACCOUNT_OPTIONS.map((option) => (
            <Button
              key={option.id}
              label={option.label}
              variant="secondary"
              size="medium"
              onPress={() => {
                /*
                 * Onboarding is marked complete on the way out, and recorded as
                 * an `account` entry rather than a guest one.
                 *
                 * Without that, `app/index.tsx` reads an unset flag on the next
                 * launch and sends a signed-in player back to the carousel. The
                 * two facts are kept apart on purpose: "has seen the disclosure"
                 * and "has an account" are different things, and a future
                 * disclosure change needs to know which.
                 */
                complete("account");
                router.push(option.route as never);
              }}
              testID={`onboarding-${option.id}`}
              accessibilityHint={option.hint}
            />
          ))}
        </View>
        <AppText variant="caption" color="textDisabled" align="center">
          {accountOption("create-account").hint}
        </AppText>

        <View style={styles.disclosure}>
          {ONBOARDING_DISCLOSURE.map((line, index) => (
            <AppText
              key={line}
              variant="caption"
              color={index === 0 ? "textSecondary" : "textDisabled"}
              align="center"
            >
              {line}
            </AppText>
          ))}
        </View>
      </View>
    </SafeAreaView>
  );
}

/**
 * The page indicator, which is also a control.
 *
 * Dots are commonly decoration; people tap them anyway, so they page here. The
 * active dot is wider as well as brighter — position is never encoded by colour
 * alone — and each carries the page name for a screen reader.
 */
function PageDots({ active, onSelect }: { active: number; onSelect: (index: number) => void }) {
  return (
    <View style={styles.dots}>
      {ONBOARDING_PAGES.map((entry, index) => {
        const selected = index === active;
        return (
          <Pressable
            key={entry.id}
            onPress={() => onSelect(index)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`Page ${index + 1} of ${ONBOARDING_PAGE_COUNT}: ${entry.title}`}
            style={({ pressed }) => [styles.dotTarget, pressed ? styles.pressed : null]}
          >
            <View style={[styles.dot, selected ? styles.dotActive : null]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  brand: {
    alignItems: "center",
    paddingTop: spacing.sm,
  },
  pager: {
    flex: 1,
  },
  pagerContent: {
    // Cross-axis on a horizontal scroller: centres each page vertically.
    alignItems: "center",
  },
  page: {
    paddingHorizontal: layout.screenPadding,
    alignItems: "center",
  },
  pageInner: {
    maxWidth: 420,
    width: "100%",
    alignItems: "center",
    gap: spacing.md,
  },
  dots: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.xs,
  },
  dotTarget: {
    width: 40,
    height: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  dotActive: {
    width: 22,
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  pressed: {
    opacity: 0.7,
  },
  dock: {
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.lg,
    paddingTop: spacing.sm,
    gap: spacing.md,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  accountRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  notice: {
    gap: spacing.sm,
  },
  disclosure: {
    gap: 2,
    paddingTop: spacing.xs,
  },
});
