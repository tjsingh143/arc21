/**
 * "Offline" — said once, at the top of the app, and only when it is true.
 *
 * The specification asks several screens to show an offline state. Rendering
 * that in each of them would mean five copies of the same sentence and five
 * chances for one of them to be stale, so it is one strip above the navigator.
 *
 * WHAT IT CLAIMS, precisely: the SERVER did not answer the last two requests.
 * Not "there is no network" — nothing here asks the radio, because a phone on a
 * captive-portal wifi has a network and cannot reach Arc 21, and a banner that
 * says the opposite of the truth exactly when it matters is worse than none.
 *
 * WHAT IT DOES NOT DO: block anything. Practice, the strategy guide, drills and
 * offline career practice all work with no server at all, so the banner names
 * what is unavailable and leaves everything else alone. It is also `unknown`
 * until the first request, so a cold launch into Practice never shows it.
 */

import { StyleSheet, View } from "react-native";

import { AppText } from "./AppText";
import { colors, layout, spacing } from "../../design/tokens";
import { useConnectivityStore } from "../../lib/connectivity/connectivity-store";

export function OfflineBanner() {
  const status = useConnectivityStore((state) => state.status);
  if (status !== "offline") return null;

  return (
    <View
      style={styles.banner}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      testID="offline-banner"
    >
      <AppText variant="caption" color="textPrimary" align="center">
        Offline — the server is not answering. Practice, the guide and drills still work.
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingHorizontal: layout.screenPadding,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceRaised,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
});
