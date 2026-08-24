/**
 * A friend's profile.
 *
 * The specification names nine things: avatar, display name, username, level,
 * presence, public stats according to privacy setting, career stars, tournament
 * wins, and Invite to Table — plus Remove Friend and Block. This screen showed
 * the first four and a last-seen line for a whole phase, because there was no
 * source for the rest: `my_competition_record` and `my_career_progress` both
 * derive from `auth.uid()` and answer only about the caller, correctly.
 * `player_public_profile` is that source, and this is its only call site.
 *
 * WHAT COMES FROM WHERE, because it is three different kinds of claim.
 *
 *   IDENTITY comes from the friends list — the row that was tapped — so the
 *   screen has a name to render before any network call finishes, and somebody
 *   who is not on that list gets a stated absence rather than an invented
 *   profile.
 *
 *   THE RECORD comes from `player_public_profile`, which decides visibility
 *   itself from `profiles.privacy`. This file never recomputes that: a second
 *   implementation of a privacy rule is a rule that will eventually disagree
 *   with the first, and the client's version is the one a player would see.
 *
 *   PRESENCE comes from the Realtime channel and nothing else. It is ephemeral
 *   by design — nothing is written to the database — so a crashed client leaves
 *   no stale "online" behind. Absence from the channel is reported as offline
 *   WITH the last-seen line and a sentence saying the app cannot tell a signed-
 *   out player from one on a bad connection.
 *
 * Both destructive actions are confirmed, and the confirmations say what each
 * one actually does — including where a block can be undone, and what undoing
 * one does not bring back.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { colors, layout, radius, spacing } from "../../src/design/tokens";
import { useAuthStore } from "../../src/features/auth/auth-store";
import {
  activeFriendsGateway,
  describeHiddenRecord,
  hasRecord,
  presentPresence,
  presentRecord,
  selectFriend,
  useFriendsStore,
  type PlayerProfile,
} from "../../src/features/friends";
import { usePresenceStore } from "../../src/features/presence";
import {
  describeInviteUnavailable,
  inviteAffordance,
  useRoomInvites,
  useRoomsStore,
} from "../../src/features/rooms";

/** The profile read, kept apart from the friends list it is shown beside. */
type ProfileRead =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly profile: PlayerProfile }
  /** The server returned no row. One sentence covers all three causes. */
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string };

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

  const viewerId = useAuthStore((state) => state.session?.account.userId ?? null);

  // Subscribed, never read through a getter during render — the React Compiler
  // memoises against the stable function reference and freezes the value.
  const online = usePresenceStore((state) => state.online);
  const joinPresence = usePresenceStore((state) => state.join);
  const leavePresence = usePresenceStore((state) => state.leave);

  const roomsStatus = useRoomsStore((state) => state.status);
  const restoreRoom = useRoomsStore((state) => state.restore);
  const invite = useRoomInvites((state) => state.invite);
  const inviteBusy = useRoomInvites((state) => state.busy);
  const invited = useRoomInvites((state) => state.invited);
  const inviteNotice = useRoomInvites((state) => state.notice);

  const [leaving, setLeaving] = useState(false);
  /*
   * Tagged with the player it belongs to rather than reset to `loading` at the
   * top of the effect. Setting state synchronously inside an effect triggers a
   * cascading render — and the tag is the better answer anyway: it means a
   * profile can never be shown for one player while another's id is in the URL,
   * which a reset-then-fetch would allow for exactly one frame.
   */
  const [read, setRead] = useState<{ readonly of: string; readonly result: ProfileRead }>({
    of: "",
    result: { kind: "loading" },
  });
  const profile: ProfileRead = read.of === playerId ? read.result : { kind: "loading" };

  // Only from a standing start. Refreshing an already-loaded list would blank
  // it mid-render and flash "not in your friends list" at somebody who is.
  useEffect(() => {
    if (status.kind === "idle") void refresh();
  }, [status.kind, refresh]);

  /*
   * Presence, if nobody else already holds the channel.
   *
   * Social joins it on mount and leaves on unmount, and a push keeps Social
   * mounted underneath — but a DEEP LINK straight to `arc21://friends/<id>`
   * arrives with no channel at all, and that is the case this covers. The
   * `joined` flag is read once through the store's own getter rather than
   * subscribed to: subscribing would re-run this effect the moment the channel
   * connects and immediately tear it down again.
   */
  const ownsPresence = useRef(false);
  useEffect(() => {
    if (viewerId === null) return;
    if (usePresenceStore.getState().joined) return;
    ownsPresence.current = true;
    joinPresence(viewerId, "available");
    return () => {
      if (!ownsPresence.current) return;
      ownsPresence.current = false;
      leavePresence();
    };
  }, [viewerId, joinPresence, leavePresence]);

  /*
   * The table this player is at, if any, so "Invite to table" can be offered
   * against a real room id. `restore()` is the same call the lobby makes when
   * it mounts and is a plain read; it opens nothing.
   */
  useEffect(() => {
    if (roomsStatus.kind === "idle") void restoreRoom();
  }, [roomsStatus.kind, restoreRoom]);

  /*
   * The profile read, once per player.
   *
   * Its three outcomes are kept apart on purpose. `missing` is the server
   * answering with NO ROW, which it does identically for a block in either
   * direction, a user id that never existed and a deleted account — so this
   * screen must state one absence for all three, or a block becomes
   * discoverable by the person blocked. `failed` is a read that did not happen
   * and says so; it is never rendered as an empty record.
   */
  useEffect(() => {
    if (playerId === "") return;
    let current = true;
    void activeFriendsGateway()
      .profile(playerId)
      .then((outcome) => {
        if (!current) return;
        const result: ProfileRead = !outcome.ok
          ? { kind: "failed", message: outcome.message }
          : outcome.profile === null
            ? { kind: "missing" }
            : { kind: "ready", profile: outcome.profile };
        setRead({ of: playerId, result });
      });
    return () => {
      current = false;
    };
  }, [playerId]);

  const friend = useMemo(() => selectFriend(status, playerId), [status, playerId]);
  const asOf = useMemo(
    () => (status.kind === "ready" ? new Date(status.fetchedAt) : new Date()),
    [status],
  );

  const presence = useMemo(
    () =>
      profile.kind === "ready"
        ? presentPresence(online.get(playerId), profile.profile.lastSeenAt, asOf)
        : friend !== null
          ? presentPresence(online.get(playerId), friend.lastSeenAt, asOf)
          : null,
    [profile, online, playerId, friend, asOf],
  );

  const room = roomsStatus.kind === "seated" ? roomsStatus.state : null;
  const affordance = useMemo(
    () => inviteAffordance(room, viewerId, playerId),
    [room, viewerId, playerId],
  );
  const alreadyInvited = invited.includes(playerId);

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
              <AppText variant="display" numeric testID="friend-level">
                {String(profile.kind === "ready" ? profile.profile.level : friend.level)}
              </AppText>
              {presence !== null ? (
                <>
                  <AppText variant="bodyStrong" testID="friend-presence">
                    {presence.label}
                  </AppText>
                  <AppText variant="caption" color="textSecondary">
                    {presence.detail}
                  </AppText>
                </>
              ) : null}
              <AppText variant="caption" color="textDisabled">
                Level comes from the server and reflects their play, not yours.
                Their chip balance is theirs alone and is never shown.
              </AppText>
            </SurfaceCard>

            {/*
              * The record. Four states, and they are four different sentences:
              * still reading, read and hidden by their own privacy setting,
              * read and genuinely empty, and not read at all. Only the third
              * one may show numbers, and none of them shows a zero standing in
              * for something unknown.
              */}
            <SurfaceCard>
              <AppText variant="overline" color="textSecondary">
                Record
              </AppText>
              {profile.kind === "loading" ? (
                <AppText variant="caption" color="textSecondary">
                  Reading their record…
                </AppText>
              ) : profile.kind === "failed" ? (
                <UnavailableNote>{profile.message}</UnavailableNote>
              ) : profile.kind === "missing" ? (
                <UnavailableNote>
                  Nothing about this player could be read. Nothing is shown,
                  because there is nothing to show.
                </UnavailableNote>
              ) : profile.profile.record === null ? (
                <UnavailableNote>{describeHiddenRecord(profile.profile)}</UnavailableNote>
              ) : !hasRecord(profile.profile.record) ? (
                <UnavailableNote>
                  {`${profile.profile.displayName} has no record yet. That is no record, not a record of zero.`}
                </UnavailableNote>
              ) : (
                <View style={styles.stats} testID="friend-record">
                  {presentRecord(profile.profile.record).map((row) => (
                    <View key={row.key} style={styles.statRow}>
                      <AppText variant="caption" color="textSecondary">
                        {row.label}
                      </AppText>
                      <AppText variant="bodyStrong" numeric>
                        {row.value}
                      </AppText>
                    </View>
                  ))}
                </View>
              )}
            </SurfaceCard>

            {actionError !== null ? (
              <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="polite">
                <AppText variant="caption" color="danger">
                  {actionError}
                </AppText>
              </View>
            ) : null}

            <View style={styles.actions}>
              {/*
                * Invite to Table. Offered only when it could actually be
                * accepted — every branch of `inviteAffordance` mirrors a check
                * inside `invite_friend_to_room`, plus the two the server would
                * allow and a player could not use. When there is no table, the
                * button becomes the way to open one rather than a dead control
                * with a tooltip.
                */}
              {affordance.kind === "invite" ? (
                <Button
                  label={alreadyInvited ? "Invited" : "Invite to table"}
                  variant="primary"
                  disabled={busy || alreadyInvited || inviteBusy === playerId}
                  pending={inviteBusy === playerId}
                  testID="friend-invite"
                  accessibilityHint={`Sends ${friend.displayName} an invite to the table you are at`}
                  onPress={() => void invite(affordance.roomId, playerId)}
                />
              ) : affordance.kind === "no-table" ? (
                <Button
                  label="Open a private table"
                  variant="primary"
                  disabled={busy}
                  testID="friend-open-table"
                  accessibilityHint="Opens the private table screen, where you can create a table and invite them"
                  onPress={() => router.push("/table/lobby")}
                />
              ) : null}
              {describeInviteUnavailable(affordance, friend.displayName) !== null ? (
                <AppText variant="caption" color="textSecondary" testID="friend-invite-note">
                  {describeInviteUnavailable(affordance, friend.displayName)}
                </AppText>
              ) : null}
              {inviteNotice !== null ? (
                <AppText variant="caption" color="danger" accessibilityLiveRegion="polite">
                  {inviteNotice}
                </AppText>
              ) : null}

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
              There is no way to message someone in Arc 21. An invite sends one
              notification naming your table and nothing else; it is the only
              thing on this screen that reaches them at all.
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
  stats: { gap: spacing.sm, marginTop: spacing.xs },
  statRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  banner: {
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.md,
  },
  cta: { marginTop: spacing.md },
});
