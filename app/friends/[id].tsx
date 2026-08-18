/**
 * A friend's profile.
 *
 * Four facts, all of them the server's: display name, handle, level, and when
 * they were last seen. Nothing is derived, nothing is filled in, and there is
 * no message box — a friendship in Arc 21 grants a place at a private table,
 * not a channel to write to somebody.
 *
 * The facts come from the friends list rather than a second read of their
 * profile, so what this screen shows is the row that was tapped. Someone who is
 * not in that list gets a stated absence, never an invented profile.
 *
 * Both destructive actions are confirmed, and the confirmations say what each
 * one actually does — including where a block can be undone, and what undoing
 * one does not bring back.
 */

import { useEffect, useMemo, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { colors, layout, radius, spacing } from "../../src/design/tokens";
import { describeLastSeen, selectFriend, useFriendsStore } from "../../src/features/friends";

export default function FriendProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const playerId = typeof id === "string" ? id : "";

  // Subscribed, never read through `useFriendsStore.getState()` — see the note
  // in `app/(tabs)/social.tsx`.
  const status = useFriendsStore((state) => state.status);
  const pending = useFriendsStore((state) => state.pending);
  const actionError = useFriendsStore((state) => state.actionError);
  const refresh = useFriendsStore((state) => state.refresh);
  const removeFriend = useFriendsStore((state) => state.removeFriend);
  const blockPlayer = useFriendsStore((state) => state.blockPlayer);

  const [leaving, setLeaving] = useState(false);

  // Only from a standing start. Refreshing an already-loaded list would blank
  // it mid-render and flash "not in your friends list" at somebody who is.
  useEffect(() => {
    if (status.kind === "idle") void refresh();
  }, [status.kind, refresh]);

  const friend = useMemo(() => selectFriend(status, playerId), [status, playerId]);
  const asOf = useMemo(
    () => (status.kind === "ready" ? new Date(status.fetchedAt) : new Date()),
    [status],
  );

  const busy = pending !== null || leaving;

  function confirmRemove(): void {
    if (friend === null) return;
    Alert.alert(
      `Remove ${friend.displayName}?`,
      "You both drop off each other's friends lists. They are not told, and either of you can send a new request afterwards.",
      [
        { text: "Keep as a friend", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            setLeaving(true);
            // Only leave if it actually happened. Navigating away on a refusal
            // would dismiss the message saying nothing was changed.
            void removeFriend(friend.id).then((removed) => {
              setLeaving(false);
              if (removed) router.back();
            });
          },
        },
      ],
    );
  }

  function confirmBlock(): void {
    if (friend === null) return;
    /*
     * The last two sentences are the ones that matter, and they say different
     * things on purpose. A block is reversible, and saying where keeps somebody
     * from avoiding a safety tool because they think it is permanent — but
     * reversing it restores nothing, so "you can undo this" must not be read as
     * "you can put things back". The friendship does not return.
     */
    Alert.alert(
      `Block ${friend.displayName}?`,
      "They are removed from your friends, neither of you will find the other in search, and neither can send a request. They are never told. You can undo this under Blocked on the Social tab — that lets you find each other again, but it does not restore the friendship.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Block",
          style: "destructive",
          onPress: () => {
            setLeaving(true);
            void blockPlayer(friend.id).then((blocked) => {
              setLeaving(false);
              if (blocked) router.back();
            });
          },
        },
      ],
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={{ paddingHorizontal: layout.screenPadding }}>
        <BackBar label="Back to Social" testID="friend-back" />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {status.kind === "idle" || status.kind === "loading" ? (
          <SurfaceCard>
            <AppText variant="bodyStrong">Reading your friends…</AppText>
          </SurfaceCard>
        ) : friend === null ? (
          <SurfaceCard>
            <AppText variant="sectionTitle">Not in your friends list</AppText>
            <UnavailableNote>
              {status.kind === "ready"
                ? "Nobody with that id is on your list. They may have been removed, or the link may be out of date. Nothing about them is shown, because there is nothing to show."
                : status.message}
            </UnavailableNote>
            <Button
              label="Back to Social"
              variant="secondary"
              testID="friend-missing-back"
              accessibilityHint="Returns to your friends list"
              onPress={() => router.back()}
              style={styles.cta}
            />
          </SurfaceCard>
        ) : (
          <>
            <View style={styles.identity}>
              <View style={styles.avatar} accessible accessibilityLabel="Profile picture placeholder">
                <AppText variant="sectionTitle">
                  {friend.displayName.slice(0, 1).toUpperCase()}
                </AppText>
              </View>
              <View style={styles.identityText}>
                <AppText variant="pageTitle">{friend.displayName}</AppText>
                <AppText variant="caption" color="textSecondary">
                  {`@${friend.username}`}
                </AppText>
              </View>
            </View>

            <SurfaceCard>
              <AppText variant="overline" color="textSecondary">
                Level
              </AppText>
              <AppText variant="display" numeric>
                {String(friend.level)}
              </AppText>
              <AppText variant="caption" color="textSecondary">
                {describeLastSeen(friend.lastSeenAt, asOf)}
              </AppText>
              <AppText variant="caption" color="textDisabled">
                Level comes from the server and reflects their play, not yours.
                Their chips, statistics and results are theirs and are not shown
                here.
              </AppText>
            </SurfaceCard>

            {actionError !== null ? (
              <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="polite">
                <AppText variant="caption" color="danger">
                  {actionError}
                </AppText>
              </View>
            ) : null}

            <View style={styles.actions}>
              <Button
                label="Remove friend"
                variant="secondary"
                disabled={busy}
                testID="friend-remove"
                accessibilityHint="Asks you to confirm first"
                onPress={confirmRemove}
              />
              <Button
                label="Block"
                variant="danger"
                disabled={busy}
                testID="friend-block"
                accessibilityHint="Asks you to confirm first. Can be undone under Blocked on the Social tab, though that does not restore the friendship."
                onPress={confirmBlock}
              />
            </View>

            <AppText variant="caption" color="textDisabled">
              There is no way to message someone in Arc 21. Friends can be
              invited to a private table when private tables are built; nothing
              on this screen sends them anything.
            </AppText>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  identity: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    paddingTop: spacing.sm,
  },
  identityText: { flex: 1, gap: 2 },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actions: { gap: spacing.md },
  banner: {
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.md,
  },
  cta: { marginTop: spacing.md },
});
