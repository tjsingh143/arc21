/**
 * Entry point.
 *
 * One job: read the onboarding flag, then send the player to the introduction
 * or straight into the app. It holds no branching logic of its own —
 * `decideLaunchDestination` owns that, and is unit-tested — so the rule "never
 * render a destination before the flag has been read" is verified rather than
 * asserted.
 *
 * Two failure modes are designed against explicitly:
 *
 *   - **Flashing the wrong screen.** Redirecting to the tabs optimistically and
 *     correcting a frame later would show the app, then yank it away, on every
 *     first launch. So `pending` renders the background and nothing else.
 *   - **Hanging.** The read is time-bounded in the store, so storage that never
 *     answers falls through to the introduction instead of leaving a blank
 *     screen forever. That has happened in this project once already.
 */

import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Redirect } from "expo-router";

import { colors } from "../src/design/tokens";
import { decideLaunchDestination } from "../src/features/onboarding/launch";
import { useOnboardingStore } from "../src/features/onboarding/onboarding-store";

export default function Index() {
  const hydrated = useOnboardingStore((state) => state.hydrated);
  const completion = useOnboardingStore((state) => state.completion);
  const hydrate = useOnboardingStore((state) => state.hydrate);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const destination = decideLaunchDestination({ hydrated, completion });

  if (destination.kind === "pending") {
    return (
      <View
        style={styles.screen}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Starting Arc 21"
      >
        {/* The OS spinner, not a branded animation: this is a moment that should
            be too short to notice, and never a splash held open for decoration. */}
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    );
  }

  return <Redirect href={destination.href} />;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
  },
});
