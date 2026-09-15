/**
 * Social — the people you play with.
 *
 * Friends are server-authoritative: a friendship, a pending request and a block
 * are all rows only the database may write, and this screen never holds an
 * opinion about any of them. It asks, reads the answer, and renders it.
 *
 * It renders NO sample friends, NO placeholder requests and NO zeros. Every
 * empty section says which of the several different empty things it is —
 * nobody has been added yet, the list has not been read, there is no account,
 * or there is no server in this build — because "no friends" is a claim about
 * the player, and an unread list must never make it.
 *
 * The Blocked section is the exception to "every section states its empty
 * state": it is absent entirely when the server says nobody is blocked. A
 * standing "Blocked — none" heading would put a moderation surface in front of
 * every player who has never needed one, and there is no claim being suppressed
 * — an absent section says nothing. A *failed* read does still appear, because
 * hiding that one would tell somebody looking for a block to undo that it is
 * already gone.
 *
 * A guest is offered an account, not blocked: Practice is local, always
 * available, and unaffected by anything on this screen.
 *
 * There is no text chat and no free-text field anywhere in Arc 21's social
 * surfaces. That is a product decision, not a missing feature.
 */

import { useCallback, useEffect, useMemo } from "react";
import { router, useFocusEffect } from "expo-router";
import {
  describePresence,
  usePresenceStore,
  type PresenceState,
} from "../../src/features/presence";
import { Alert, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { ScreenHeader } from "../../src/components/ui/ScreenHeader";
import { colors, layout, MIN_TOUCH_TARGET, radius, spacing } from "../../src/design/tokens";
import { typography } from "../../src/design/typography";
import { useAuthStore } from "../../src/features/auth/auth-store";
import { useNotificationsStore, usePushRegistration } from "../../src/features/notifications";
import { useSettings } from "../../src/features/settings/use-settings";
import {
  describeLastSeen,
  presentRequest,
  presentSearchResult,
  presentUnblockConfirmation,
  selectBlocked,
  selectFriends,
  selectIncomingRequests,
  selectOutgoingRequests,
  shouldShowBlocked,
  useFriendsStore,
  type BlockedPlayer,
  type Friend,
  type FriendRequest,
  type SearchResult,
  type SearchStatus,
} from "../../src/features/friends";

export default function SocialScreen() {
  const online = usePresenceStore((state) => state.online);
  const joinPresence = usePresenceStore((state) => state.join);
  const leavePresence = usePresenceStore((state) => state.leave);

  /*
   * Every value is subscribed to, never read with `useFriendsStore.getState()`.
   * The React Compiler memoises against the stable getter reference, so a value
   * read that way freezes at its first value — which is how a permanently
   * disabled button once survived a green test suite.
   */
  const status = useFriendsStore((state) => state.status);
  const blockedStatus = useFriendsStore((state) => state.blocked);
  const searchStatus = useFriendsStore((state) => state.searchStatus);
  const query = useFriendsStore((state) => state.query);
  const pending = useFriendsStore((state) => state.pending);
  const actionError = useFriendsStore((state) => state.actionError);
  const refresh = useFriendsStore((state) => state.refresh);
  const setQuery = useFriendsStore((state) => state.setQuery);
  const search = useFriendsStore((state) => state.search);
  const clearSearch = useFriendsStore((state) => state.clearSearch);
  const sendRequest = useFriendsStore((state) => state.sendRequest);
  const acceptRequest = useFriendsStore((state) => state.acceptRequest);
  const declineRequest = useFriendsStore((state) => state.declineRequest);
  const unblockPlayer = useFriendsStore((state) => state.unblockPlayer);

  const unreadNotifications = useNotificationsStore((state) => state.unread);
  const loadNotifications = useNotificationsStore((state) => state.load);
  const offerPush = usePushRegistration((state) => state.offer);
  const { settings, update: updateSettings } = useSettings();

  const authSession = useAuthStore((state) => state.session);
  const authHydrated = useAuthStore((state) => state.hydrated);
  const hydrateAuth = useAuthStore((state) => state.hydrate);

  /*
   * Presence is joined here rather than at app start, and left when Social
   * closes. Joining per screen would publish and withdraw a player several
   * times a minute, which reads to their friends as someone flickering in and
   * out of existence.
   */
  useEffect(() => {
    const userId = authSession?.account.userId;
    if (!userId) return;
    joinPresence(userId, "available");
    return () => leavePresence();
  }, [authSession?.account.userId, joinPresence, leavePresence]);

  useEffect(() => {
    if (!authHydrated) void hydrateAuth();
  }, [authHydrated, hydrateAuth]);

  // Tabs stay mounted while the other player accepts or removes a friendship.
  // Re-read when returning, including the inbox badge. Search results contain
  // relationship state too, so discard that stale search on return/account change.
  useFocusEffect(useCallback(() => {
    if (!authHydrated) return;
    clearSearch();
    void refresh();
    void loadNotifications();
  }, [authHydrated, authSession?.account.userId, clearSearch, refresh, loadNotifications]));

  /*
   * Accepting a friend request is one of the moments the specification names for
   * asking about notifications, and the reasoning is worth keeping: this is the
   * first point at which somebody else can cause something to happen to you.
   * Before it there is nothing to be told about, which is why onboarding is
   * explicitly the wrong place to ask.
   *
   * `enable` is a no-op after the OS has already answered, so a player who said
   * no once is not asked again on every acceptance.
   */
  const onAccept = useCallback(
    async (playerId: string) => {
      await acceptRequest(playerId);
      const granted = await offerPush("accepted-friend-request", settings);
      if (granted) await updateSettings(granted);
    },
    [acceptRequest, offerPush, settings, updateSettings],
  );

  const friends = useMemo(() => selectFriends(status), [status]);
  const incoming = useMemo(() => selectIncomingRequests(status), [status]);
  const outgoing = useMemo(() => selectOutgoingRequests(status), [status]);
  const blocked = useMemo(() => selectBlocked(blockedStatus), [blockedStatus]);

  /*
   * "Last seen" is measured against the moment the list was read, not against a
   * clock that keeps running. A row that silently ages from "2 minutes ago" to
   * "40 minutes ago" while the screen sits open is reporting the age of the
   * fetch as if it were news about the friend.
   */
  const fetchedAt = status.kind === "ready" ? status.fetchedAt : null;
  const asOf = useMemo(() => (fetchedAt === null ? new Date() : new Date(fetchedAt)), [fetchedAt]);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <ScreenHeader title="Social" subtitle="Play with people you know." />

        {actionError !== null ? (
          <View style={styles.banner} accessibilityRole="alert" accessibilityLiveRegion="polite">
            <AppText variant="caption" color="danger">
              {actionError}
            </AppText>
          </View>
        ) : null}

        {status.kind === "idle" || status.kind === "loading" ? (
          <SurfaceCard>
            <AppText variant="bodyStrong">Reading your friends…</AppText>
            <AppText variant="body" color="textSecondary">
              Your friends and any pending requests are being read from the
              server. Nothing is listed until they arrive.
            </AppText>
          </SurfaceCard>
        ) : null}

        {status.kind === "signed-out" ? <GuestState message={status.message} /> : null}

        {status.kind === "not-configured" ? (
          <SurfaceCard>
            <AppText variant="sectionTitle">Friends need a server</AppText>
            <UnavailableNote>{status.message}</UnavailableNote>
            <AppText variant="body" color="textSecondary">
              Practice is local to this device and is unaffected — it deals the
              same six-deck shoe offline, signed out, and with no server at all.
            </AppText>
            <Button
              label="Play Practice"
              testID="friends-practice"
              accessibilityHint="Offline blackjack with disposable chips"
              onPress={() => router.push("/game/practice")}
              style={styles.cta}
            />
          </SurfaceCard>
        ) : null}

        {status.kind === "unavailable" ? (
          <SurfaceCard>
            <AppText variant="sectionTitle">Your friends could not be read</AppText>
            <UnavailableNote>{status.message}</UnavailableNote>
            <Button
              label="Try again"
              variant="secondary"
              testID="friends-retry"
              accessibilityHint="Asks the server for your friends again"
              onPress={() => void refresh()}
              style={styles.cta}
            />
          </SurfaceCard>
        ) : null}

        {status.kind === "ready" ? (
          <>
            {status.dropped > 0 ? (
              <UnavailableNote>
                {`${status.dropped} ${status.dropped === 1 ? "entry" : "entries"} could not be read and ${status.dropped === 1 ? "is" : "are"} not shown. What is listed below is complete apart from ${status.dropped === 1 ? "it" : "those"}.`}
              </UnavailableNote>
            ) : null}

            {/* ---------------------------------------------------------- */}
            <View style={styles.section}>
              <AppText variant="sectionTitle">Requests</AppText>

              {status.requestsUnavailable !== null ? (
                <UnavailableNote>{status.requestsUnavailable}</UnavailableNote>
              ) : (incoming?.length ?? 0) + (outgoing?.length ?? 0) === 0 ? (
                <SurfaceCard>
                  <AppText variant="body" color="textSecondary">
                    Nobody has asked to be your friend, and you have no requests
                    waiting on anyone else.
                  </AppText>
                </SurfaceCard>
              ) : (
                <>
                  {incoming?.map((request) => (
                    <RequestRow
                      key={request.id}
                      request={request}
                      busy={pending !== null}
                      pending={pending === request.id}
                      onAccept={() => void onAccept(request.id)}
                      onDecline={() => void declineRequest(request.id)}
                    />
                  ))}
                  {outgoing?.map((request) => (
                    <RequestRow
                      key={request.id}
                      request={request}
                      busy={pending !== null}
                      pending={pending === request.id}
                    />
                  ))}
                </>
              )}
            </View>

            {/* ---------------------------------------------------------- */}
            <View style={styles.section}>
              <AppText variant="sectionTitle">Friends</AppText>

              {friends === null || friends.length === 0 ? (
                <SurfaceCard>
                  <AppText variant="body" color="textSecondary">
                    You have not added anyone yet. Search below to find someone by
                    their username — nobody is added for you, and nothing here is
                    suggested.
                  </AppText>
                </SurfaceCard>
              ) : (
                friends.map((friend) => (
                  <FriendRow
                    key={friend.id}
                    friend={friend}
                    asOf={asOf}
                    presence={online.get(friend.id)}
                  />
                ))
              )}
            </View>

            {/* ---------------------------------------------------------- */}
            <View style={styles.section}>
              <AppText variant="sectionTitle">Add someone</AppText>

              <SearchField
                value={query}
                onChangeText={setQuery}
                onSubmit={() => void search()}
                onClear={clearSearch}
              />

              <SearchResults
                status={searchStatus}
                busy={pending !== null}
                pendingId={pending}
                onAdd={(playerId) => void sendRequest(playerId)}
                onAccept={(playerId) => void onAccept(playerId)}
              />
            </View>

            {/* ---------------------------------------------------------- */}
            {/* Absent when there is nobody blocked — see the file header. */}
            {shouldShowBlocked(blockedStatus) ? (
              <View style={styles.section}>
                <AppText variant="sectionTitle">Blocked</AppText>

                {blockedStatus.kind === "unavailable" ? (
                  <UnavailableNote>{blockedStatus.message}</UnavailableNote>
                ) : (
                  <>
                    <AppText variant="caption" color="textSecondary">
                      Neither of you can find the other in search, and neither can
                      send a request. They were never told about the block, and
                      they are not told if you undo it.
                    </AppText>

                    {blocked?.map((player) => (
                      <BlockedRow
                        key={player.id}
                        player={player}
                        busy={pending !== null}
                        pending={pending === player.id}
                        onUnblock={() => void unblockPlayer(player.id)}
                      />
                    ))}

                    {blockedStatus.kind === "ready" && blockedStatus.dropped > 0 ? (
                      <UnavailableNote>
                        {`${blockedStatus.dropped} ${blockedStatus.dropped === 1 ? "block" : "blocks"} could not be read, so ${blockedStatus.dropped === 1 ? "it is" : "they are"} not listed here and cannot be undone from this screen. ${blockedStatus.dropped === 1 ? "It is" : "They are"} still in force.`}
                      </UnavailableNote>
                    ) : null}
                  </>
                )}
              </View>
            ) : null}
          </>
        ) : null}

        {/* ------------------------------------------------------------- */}
        <View style={styles.section}>
          <AppText variant="sectionTitle">Private table</AppText>
          <SurfaceCard
            onPress={() => router.push("/table/lobby")}
            accessibilityLabel="Private table"
            accessibilityHint="Open a table for friends, or join one with a code"
            testID="social-private-table"
          >
            <AppText variant="bodyStrong">Play with friends</AppText>
            <AppText variant="body" color="textSecondary">
              Two to five of you at one table, sharing a dealer and a shoe.
              Everybody starts on 5,000 table chips that belong to the table —
              nothing is taken from your balance, and nothing won there is added
              to it.
            </AppText>
          </SurfaceCard>
        </View>

        <View style={styles.section}>
          <AppText variant="sectionTitle">Leaderboards</AppText>
          <SurfaceCard
            onPress={() => router.push("/leaderboards")}
            testID="social-leaderboards"
            accessibilityLabel="Leaderboards"
            accessibilityHint="Weekly XP, tournament wins, strategy accuracy and the daily challenge"
          >
            <AppText variant="bodyStrong">Four boards, all server-recorded</AppText>
            <AppText variant="body" color="textSecondary">
              {"Weekly XP, tournament wins, strategy accuracy and today's daily " +
                "challenge. Global bankroll is deliberately not one of them."}
            </AppText>
          </SurfaceCard>
        </View>

        <View style={styles.section}>
          <AppText variant="sectionTitle">Notifications</AppText>
          <SurfaceCard
            onPress={() => router.push("/notifications")}
            testID="social-notifications"
            accessibilityLabel="Notifications"
            accessibilityHint="Friend requests, table invites and tournament results"
          >
            <AppText variant="bodyStrong">
              {unreadNotifications > 0
                ? `${unreadNotifications} unread`
                : "Everything Arc 21 has told you"}
            </AppText>
            <AppText variant="body" color="textSecondary">
              Kept on the server, so it is here whether or not your device was
              able to show it at the time.
            </AppText>
          </SurfaceCard>
        </View>

        <View style={styles.section}>
          <AppText variant="sectionTitle">Not in this build</AppText>
          <UnavailableNote>Arc 21 has no text chat by design.</UnavailableNote>
        </View>

        <AppText variant="caption" color="textDisabled" align="center" style={styles.footer}>
          Private tables use their own session chips, so playing with friends can
          never move chips between accounts.
        </AppText>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * The guest state.
 *
 * It offers an account and says plainly what an account does *not* change,
 * because the fear this screen has to answer is that signing in is required to
 * keep playing. It is not, and never will be.
 */
function GuestState({ message }: { message: string }) {
  return (
    <SurfaceCard>
      <AppText variant="sectionTitle">Friends need an account</AppText>
      <AppText variant="body" color="textSecondary">
        {message}
      </AppText>
      <AppText variant="body" color="textSecondary">
        Practice is unaffected. It is local to this device, works offline and
        signed out, and never touches a server wallet, friends list or
        leaderboard.
      </AppText>
      <Button
        label="Sign in or create an account"
        testID="friends-sign-in"
        accessibilityHint="Opens the sign-in screen"
        onPress={() => router.push("/(auth)/sign-in")}
        style={styles.cta}
      />
      <Button
        label="Play Practice"
        variant="secondary"
        testID="friends-practice"
        accessibilityHint="Offline blackjack, no account needed"
        onPress={() => router.push("/game/practice")}
      />
    </SurfaceCard>
  );
}

function FriendRow({
  friend,
  asOf,
  presence,
}: {
  friend: Friend;
  asOf: Date;
  presence: PresenceState | undefined;
}) {
  /*
   * Live presence when the channel reports them, and only then. Absence from
   * the channel is NOT evidence of being offline — they may simply not have
   * opened Social — so it falls back to the timestamp rather than asserting
   * something the data cannot support.
   */
  const live = describePresence(presence);
  const lastSeen = describeLastSeen(friend.lastSeenAt, asOf);
  const standing = live ?? lastSeen;

  return (
    <SurfaceCard
      onPress={() => router.push(`/friends/${friend.id}`)}
      testID={`friend-row-${friend.username}`}
      accessibilityLabel={`${friend.displayName}, @${friend.username}, level ${friend.level}. ${standing}.`}
      accessibilityHint="Opens their profile, where you can remove or block them"
    >
      <AppText variant="bodyStrong">{friend.displayName}</AppText>
      <AppText variant="caption" color="textSecondary">
        {`@${friend.username} · Level ${friend.level}`}
      </AppText>
      <AppText variant="caption" color={live ? "success" : "textDisabled"}>
        {standing}
      </AppText>
    </SurfaceCard>
  );
}

function RequestRow({
  request,
  busy,
  pending,
  onAccept,
  onDecline,
}: {
  request: FriendRequest;
  busy: boolean;
  pending: boolean;
  onAccept?: () => void;
  onDecline?: () => void;
}) {
  const view = presentRequest(request);

  return (
    <SurfaceCard>
      <AppText variant="bodyStrong">{view.title}</AppText>
      <AppText variant="caption" color="textSecondary">
        {`${view.handle} · ${view.detail}`}
      </AppText>

      {view.canAccept && onAccept && onDecline ? (
        <View style={styles.rowActions}>
          <Button
            label="Accept"
            size="medium"
            pending={pending}
            disabled={busy && !pending}
            testID={`request-accept-${request.username}`}
            accessibilityHint={`Become friends with ${view.title}`}
            onPress={onAccept}
          />
          <Button
            label="Decline"
            size="medium"
            variant="secondary"
            disabled={busy}
            testID={`request-decline-${request.username}`}
            accessibilityHint={`Refuse the request from ${view.title}. They are not told.`}
            onPress={onDecline}
          />
        </View>
      ) : null}
    </SurfaceCard>
  );
}

/**
 * One blocked player, and the one thing that can be done about it.
 *
 * The card does not open a profile the way a friend's row does. There is no
 * profile to open — a blocked player is deliberately unreadable from here, and
 * a tappable card would suggest otherwise.
 *
 * The confirmation is not ceremony either. Unblocking is a change to a safety
 * decision the player made on purpose, and its wording has to correct the
 * expectation that it puts things back: it does not.
 */
function BlockedRow({
  player,
  busy,
  pending,
  onUnblock,
}: {
  player: BlockedPlayer;
  busy: boolean;
  pending: boolean;
  onUnblock: () => void;
}) {
  const confirmation = presentUnblockConfirmation(player);

  function confirmUnblock(): void {
    Alert.alert(confirmation.title, confirmation.body, [
      { text: "Keep blocked", style: "cancel" },
      { text: "Unblock", onPress: onUnblock },
    ]);
  }

  return (
    <SurfaceCard>
      <AppText variant="bodyStrong">{player.displayName}</AppText>
      <AppText variant="caption" color="textSecondary">
        {`@${player.username}`}
      </AppText>

      <View style={styles.rowActions}>
        <Button
          label="Unblock"
          size="medium"
          variant="secondary"
          pending={pending}
          disabled={busy && !pending}
          testID={`blocked-unblock-${player.username}`}
          accessibilityHint={`Asks you to confirm, then unblocks ${player.displayName}. You do not become friends again.`}
          onPress={confirmUnblock}
        />
      </View>
    </SurfaceCard>
  );
}

/**
 * Search results, or the stated reason there are none.
 *
 * Four different empty results live here — nothing searched for, too few
 * characters, a search still running, and a search that genuinely matched
 * nobody — and each one says which it is.
 */
function SearchResults({
  status,
  busy,
  pendingId,
  onAdd,
  onAccept,
}: {
  status: SearchStatus;
  busy: boolean;
  pendingId: string | null;
  onAdd: (playerId: string) => void;
  onAccept: (playerId: string) => void;
}) {
  switch (status.kind) {
    case "idle":
      return (
        <AppText variant="caption" color="textDisabled">
          Search by username or display name. Nobody is suggested to you, and no
          contacts are read from this device.
        </AppText>
      );
    case "too-short":
      return (
        <AppText variant="caption" color="warning" accessibilityRole="alert">
          {status.message}
        </AppText>
      );
    case "searching":
      return (
        <AppText variant="caption" color="textDisabled">
          {`Searching for “${status.query}”…`}
        </AppText>
      );
    case "failed":
      return (
        <AppText variant="caption" color="danger" accessibilityRole="alert">
          {status.message}
        </AppText>
      );
    case "results":
      if (status.results.length === 0) {
        return (
          <AppText variant="caption" color="textSecondary">
            {`Nobody matches “${status.query}”. Usernames are exact — ask them for theirs rather than guessing.`}
          </AppText>
        );
      }
      return (
        <>
          <AppText variant="caption" color="textDisabled">
            {`Results for “${status.query}”`}
          </AppText>
          {status.results.map((result) => (
            <SearchRow
              key={result.id}
              result={result}
              busy={busy}
              pending={pendingId === result.id}
              onAdd={() => onAdd(result.id)}
              onAccept={() => onAccept(result.id)}
            />
          ))}
          {status.dropped > 0 ? (
            <AppText variant="caption" color="textDisabled">
              {`${status.dropped} ${status.dropped === 1 ? "result" : "results"} could not be read and ${status.dropped === 1 ? "is" : "are"} not listed.`}
            </AppText>
          ) : null}
        </>
      );
  }
}

function SearchRow({
  result,
  busy,
  pending,
  onAdd,
  onAccept,
}: {
  result: SearchResult;
  busy: boolean;
  pending: boolean;
  onAdd: () => void;
  onAccept: () => void;
}) {
  const view = presentSearchResult(result);

  return (
    <SurfaceCard>
      <AppText variant="bodyStrong">{view.title}</AppText>
      <AppText variant="caption" color="textSecondary">
        {`${view.handle} · ${view.detail}`}
      </AppText>

      {view.action !== null && view.actionLabel !== null ? (
        <View style={styles.rowActions}>
          <Button
            label={view.actionLabel}
            size="medium"
            pending={pending}
            disabled={busy && !pending}
            testID={`search-${view.action}-${result.username}`}
            accessibilityHint={
              view.action === "accept"
                ? `Become friends with ${view.title}`
                : `Send ${view.title} a friend request`
            }
            onPress={view.action === "accept" ? onAccept : onAdd}
          />
        </View>
      ) : null}
    </SurfaceCard>
  );
}

/**
 * The one free-text field on this screen.
 *
 * It searches and nothing else: there is no message to send with a request and
 * no note attached to it, which is what stops a friend request from becoming an
 * unmoderated message channel.
 */
function SearchField({
  value,
  onChangeText,
  onSubmit,
  onClear,
}: {
  value: string;
  onChangeText: (next: string) => void;
  onSubmit: () => void;
  onClear: () => void;
}) {
  return (
    <View style={styles.field}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder="username"
        placeholderTextColor={colors.textDisabled}
        // Handles are lower-case in this product; leaving these on is how
        // "Sam_21" gets typed and nothing is found.
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="search"
        onSubmitEditing={onSubmit}
        maxLength={20}
        testID="friends-search-input"
        accessibilityLabel="Search for a player by username"
        style={styles.input}
      />
      <View style={styles.rowActions}>
        <Button
          label="Search"
          size="medium"
          testID="friends-search-submit"
          accessibilityHint="Looks for players matching what you typed"
          onPress={onSubmit}
        />
        {value.length > 0 ? (
          <Button
            label="Clear"
            size="medium"
            variant="quiet"
            testID="friends-search-clear"
            accessibilityHint="Empties the search box and the results"
            onPress={onClear}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.xl,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  section: { gap: spacing.md },
  rowActions: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  field: { gap: spacing.sm },
  input: {
    ...(typography.body as object),
    color: colors.textPrimary,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  banner: {
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.md,
  },
  cta: { marginTop: spacing.md },
  footer: { marginTop: spacing.lg },
});
