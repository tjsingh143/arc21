/**
 * Notifications.
 *
 * The record of what the server told you, whether or not a push message ever
 * reached the device. That ordering matters: push can fail for reasons the app
 * never learns — permission refused, token expired, a build with no credentials
 * — and a feature that only existed as a banner would silently do nothing.
 *
 * Tapping one goes where it is about, derived from its KIND. A notification never
 * carries a route; see `src/features/notifications/notifications.ts`.
 */

import { useCallback, useEffect, useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { colors, layout, spacing } from "../../src/design/tokens";
import {
  KIND_LABELS,
  describeAge,
  destinationFor,
  pathFor,
  useNotificationsStore,
  type AppNotification,
} from "../../src/features/notifications";

export default function Notifications() {
  const router = useRouter();
  const status = useNotificationsStore((state) => state.status);
  const unread = useNotificationsStore((state) => state.unread);
  const busy = useNotificationsStore((state) => state.busy);
  const load = useNotificationsStore((state) => state.load);
  const markRead = useNotificationsStore((state) => state.markRead);
  const markAllRead = useNotificationsStore((state) => state.markAllRead);

  useEffect(() => {
    void load();
  }, [load]);

  // Derived from subscribed state, never by calling a store getter during
  // render — the React Compiler memoises that against the function reference and
  // freezes the value.
  const rows = useMemo(() => (status.kind === "ready" ? status.rows : []), [status]);

  const open = useCallback(
    (notification: AppNotification) => {
      void markRead(notification.id);
      const path = pathFor(destinationFor(notification));
      // `/notifications` IS this screen; navigating to it would push a duplicate.
      if (path !== "/notifications") {
        router.push(path as never);
      }
    },
    [markRead, router],
  );

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.bar}>
        <BackBar />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <AppText variant="pageTitle" accessibilityRole="header">
            Notifications
          </AppText>
          <AppText variant="body" color="textSecondary">
            Everything Arc 21 has told you is kept here, whether or not your device
            was able to show it at the time.
          </AppText>
        </View>

        {status.kind === "loading" ? (
          <AppText variant="body" color="textSecondary">
            Reading your notifications…
          </AppText>
        ) : status.kind === "unavailable" ? (
          <UnavailableNote>{status.message}</UnavailableNote>
        ) : rows.length === 0 ? (
          /*
           * Says WHY it is empty. An empty inbox and a broken inbox look
           * identical otherwise, and a player is entitled to know which they are
           * looking at.
           */
          <SurfaceCard>
            <AppText variant="bodyStrong" testID="notifications-empty">
              Nothing yet.
            </AppText>
            <AppText variant="caption" color="textSecondary">
              Friend requests, table invites and tournament results appear here.
              Arc 21 never sends anything to get you to come back.
            </AppText>
          </SurfaceCard>
        ) : (
          <>
            {unread > 0 ? (
              <Button
                label="Mark all read"
                variant="secondary"
                testID="notifications-mark-all"
                disabled={busy}
                onPress={() => void markAllRead()}
              />
            ) : null}

            <View style={styles.list} testID="notifications-list">
              {rows.map((row) => (
                <SurfaceCard
                  key={row.id}
                  onPress={() => open(row)}
                  testID={`notification-${row.id}`}
                  accessibilityLabel={`${row.title}. ${row.body}`}
                  style={row.read_at === null ? styles.unread : null}
                >
                  <View style={styles.rowHeader}>
                    <AppText variant="caption" color="textSecondary">
                      {KIND_LABELS[row.kind]}
                    </AppText>
                    <AppText variant="caption" color="textDisabled">
                      {describeAge(row.created_at)}
                    </AppText>
                  </View>
                  <AppText
                    variant="bodyStrong"
                    color={row.read_at === null ? "textPrimary" : "textSecondary"}
                  >
                    {row.title}
                  </AppText>
                  <AppText variant="caption" color="textSecondary">
                    {row.body}
                  </AppText>
                </SurfaceCard>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  bar: { paddingHorizontal: layout.screenPadding },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  header: { gap: spacing.xs },
  list: { gap: spacing.md },
  rowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
  },
  unread: { borderColor: colors.accent },
});
