/**
 * A link that leads nowhere.
 *
 * `arc21://` is a public URL scheme: anything on the device can open one, and a
 * link that was valid last month is not necessarily valid today. Without this
 * file expo-router falls back to its own `Unmatched` screen — a light-themed
 * developer page reading "Unmatched Route / Page could not be found." whose one
 * control is `<Link href={pathname} replace>`, which navigates to the SAME
 * unmatched path. On a cold start from a deep link there is no history behind
 * it either, so a player who followed a stale invitation had no way back into
 * the app at all.
 *
 * It says what happened and offers the two places worth going: Home, and
 * Practice, which needs no account, no balance and no network.
 */

import { router } from "expo-router";
import { ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../src/components/ui/AppText";
import { Button } from "../src/components/ui/Button";
import { ScreenHeader } from "../src/components/ui/ScreenHeader";
import { SurfaceCard } from "../src/components/ui/Card";
import { colors, layout, spacing } from "../src/design/tokens";

export default function NotFoundScreen() {
  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content} testID="not-found">
        <ScreenHeader title="That link led nowhere" subtitle="Nothing is wrong with your account." />

        <SurfaceCard>
          <AppText variant="body" color="textSecondary">
            The screen this link points at does not exist in this version of
            Arc 21. It may have been an old invitation, or a link built by
            something other than the app.
          </AppText>
        </SurfaceCard>

        <Button
          label="Go to Home"
          onPress={() => router.replace("/(tabs)/home")}
          testID="not-found-home"
        />
        <Button
          label="Play Practice"
          variant="quiet"
          onPress={() => router.replace("/game/practice")}
          testID="not-found-practice"
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    flexGrow: 1,
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xl,
    gap: spacing.lg,
  },
});
