/**
 * Private table — open one, or join with a code.
 *
 * The screen states the economics before anything else, because they are the
 * surprising part: the chips here are the table's own, nothing is at stake from
 * the global wallet, and nothing won here can leave. That is the anti-collusion
 * rule, and a player who does not know it will assume the opposite.
 *
 * The seated half renders the specification's list for this screen exactly —
 * room code, copy/share, host, seat list, ready states, invite friends, start,
 * leave — plus the host's power to remove somebody while the table is still a
 * lobby. Every one of those is the server's decision; what is here is the way
 * to ask.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Share, StyleSheet, TextInput, View } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { useBorderColor } from "../../src/design/accessibility";
import { colors, layout, MIN_TOUCH_TARGET, radius, spacing } from "../../src/design/tokens";
import { useAuthStore } from "../../src/features/auth";
import { selectFriends, useFriendsStore } from "../../src/features/friends";
import { usePushRegistration } from "../../src/features/notifications";
import { useSettings } from "../../src/features/settings/use-settings";
import { useRoomInvites } from "../../src/features/rooms/use-room-invites";
import {
  canRemoveMember,
  canSetReady,
  canStartTable,
  describeReadiness,
  isReady,
  mayOpenDealtTable,
  ROOM_CODE_LENGTH,
  shareMessage,
  useRoomsStore,
} from "../../src/features/rooms";

/** The specification's room settings: 2–5 human seats. */
const SEAT_CHOICES = [2, 3, 4, 5] as const;
const DEFAULT_SEATS = 5;

export default function PrivateTableLobby() {
  const status = useRoomsStore((state) => state.status);
  const codeInput = useRoomsStore((state) => state.codeInput);
  const notice = useRoomsStore((state) => state.notice);
  const setCodeInput = useRoomsStore((state) => state.setCodeInput);
  const createRoom = useRoomsStore((state) => state.createRoom);
  const joinRoom = useRoomsStore((state) => state.joinRoom);
  const refresh = useRoomsStore((state) => state.refresh);
  const restore = useRoomsStore((state) => state.restore);
  const startTable = useRoomsStore((state) => state.startTable);
  const setReady = useRoomsStore((state) => state.setReady);
  const removeMember = useRoomsStore((state) => state.removeMember);
  const dealt = useRoomsStore((state) => state.dealt);
  const leave = useRoomsStore((state) => state.leave);

  const session = useAuthStore((state) => state.session);
  const userId = session?.account.userId ?? null;

  const friendsStatus = useFriendsStore((state) => state.status);
  const refreshFriends = useFriendsStore((state) => state.refresh);
  const invited = useRoomInvites((state) => state.invited);
  const inviteBusy = useRoomInvites((state) => state.busy);
  const inviteNotice = useRoomInvites((state) => state.notice);
  const invite = useRoomInvites((state) => state.invite);

  const offerPush = usePushRegistration((state) => state.offer);
  const { settings, update: updateSettings } = useSettings();

  const [seats, setSeats] = useState<number>(DEFAULT_SEATS);
  const [shareNotice, setShareNotice] = useState<string | null>(null);

  /*
   * Derived from subscribed state with `useMemo`, never by calling a store
   * getter during render: under the React Compiler a getter is memoised against
   * its own stable function reference, so the value freezes at whatever it was
   * on first render. That bug shipped here once and disabled the Deal button.
   */
  const seated = status.kind === "seated" ? status.state : null;
  const startable = useMemo(
    () => (seated ? canStartTable(seated, userId) : false),
    [seated, userId],
  );
  const ready = useMemo(() => (seated ? isReady(seated, userId) : false), [seated, userId]);
  const readyOffered = useMemo(
    () => (seated ? canSetReady(seated, userId) : false),
    [seated, userId],
  );

  /*
   * `checked` IS WHAT STOPS A STALE POINTER NAVIGATING — see
   * `mayOpenDealtTable` for the two devices it was photographed on, and for why
   * `restore()` alone could not do it. Component state on purpose: anything
   * kept in the store would arrive here already true, carried over from the
   * mount before, which is the very shape of the bug.
   */
  const [checked, setChecked] = useState(false);

  /*
   * "Loading/reconnect must preserve room code."
   *
   * Asked once, on mount, before anything else. Without it a host who force-quit
   * came back to an empty lobby AND could not open another one — the server
   * refuses a second live room — so the only way out was to wait thirty minutes
   * for the first to expire.
   */
  useEffect(() => {
    let live = true;
    void restore().finally(() => {
      if (live) setChecked(true);
    });
    return () => {
      live = false;
    };
  }, [restore]);

  // A lobby is a waiting room: other people arrive while you look at it.
  useEffect(() => {
    if (!seated) return;
    const timer = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [seated, refresh]);

  const onJoin = useCallback(() => void joinRoom(), [joinRoom]);

  /*
   * Opening a table is the second moment the specification allows for asking
   * about notifications: from here on, somebody else joining is a thing that
   * happens to you while you are looking at something else.
   */
  const onCreate = useCallback(async () => {
    await createRoom(seats);
    const granted = await offerPush("created-private-table", settings);
    if (granted) await updateSettings(granted);
  }, [createRoom, seats, offerPush, settings, updateSettings]);

  /*
   * The share sheet carries the CODE, and its own Copy action is the "copy"
   * half of the specification's "copy/share" — which is why no clipboard
   * dependency was added for it.
   */
  const onShare = useCallback(async (code: string) => {
    setShareNotice(null);
    try {
      await Share.share({ message: shareMessage(code) });
    } catch {
      // Dismissing the sheet is not a failure, but a sheet that never opened
      // leaves the player looking at an unchanged screen wondering what
      // happened. The code is on screen either way.
      setShareNotice("The share sheet could not be opened. The code above can be typed in by hand.");
    }
  }, []);

  // The invite list needs friends, and a seated lobby is the only place it shows.
  useEffect(() => {
    if (seated) void refreshFriends();
  }, [seated, refreshFriends]);

  const friends = useMemo(() => selectFriends(friendsStatus) ?? [], [friendsStatus]);
  const seatedIds = useMemo(
    () => new Set(seated?.members.map((member) => member.userId) ?? []),
    [seated],
  );
  const invitable = useMemo(
    () => friends.filter((friend) => !seatedIds.has(friend.id)),
    [friends, seatedIds],
  );

  const members = useMemo(
    () =>
      (seated?.members ?? []).map((member) => ({
        key: member.userId,
        label: member.displayName,
        seat: member.seatIndex + 1,
        isHost: member.isHost,
        isReady: member.isReady,
        isYou: member.userId === userId,
        removable: seated ? canRemoveMember(seated, userId, member.userId) : false,
      })),
    [seated, userId],
  );

  /*
   * Navigate from committed state rather than inside the button handler.
   * Routing in the same tick as the state change raced the redirect once
   * already in this project, roughly one launch in three.
   */
  useEffect(() => {
    // A pointer is not enough on its own: it has to have been checked against
    // the server on THIS mount. `dealt` outlives this screen, so without the
    // second line a seat settled at the table sends the player straight back to
    // it, for ever — see `mayOpenDealtTable`.
    if (!dealt) return;
    if (!mayOpenDealtTable({ checked, dealt })) return;
    router.replace({
      pathname: "/table/[gameId]",
      params: { gameId: dealt.gameId, seatId: dealt.seatId },
    });
  }, [checked, dealt]);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.bar}>
        <BackBar />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <AppText variant="pageTitle" accessibilityRole="header">
            Private table
          </AppText>
          <AppText variant="body" color="textSecondary">
            Two to five friends, one dealer, one shoe.
          </AppText>
        </View>

        {/*
          Stated first and plainly. Players reasonably assume a table plays for
          their real balance; here it does not, in either direction.
        */}
        <SurfaceCard>
          <AppText variant="bodyStrong">Everyone starts with 5,000 table chips</AppText>
          <AppText variant="body" color="textSecondary">
            These belong to the table, not to you. Nothing is taken from your
            balance and nothing you win here is added to it — which is what stops
            chips being handed between accounts.
          </AppText>
          <AppText variant="caption" color="textDisabled">
            Unranked. Hands here do not count towards leaderboards.
          </AppText>
        </SurfaceCard>

        {status.kind === "not-configured" || status.kind === "signed-out" ? (
          <UnavailableNote>{status.message}</UnavailableNote>
        ) : null}

        {status.kind === "unavailable" ? <UnavailableNote>{status.message}</UnavailableNote> : null}

        {notice ? (
          <AppText variant="body" color="warning" testID="lobby-notice">
            {notice}
          </AppText>
        ) : null}

        {seated ? (
          <SeatedLobby
            code={seated.room.code}
            readiness={describeReadiness(seated)}
            shareNotice={shareNotice}
            onShare={() => void onShare(seated.room.code)}
            invitable={invitable.map((friend) => ({
              id: friend.id,
              label: friend.displayName,
              invited: invited.includes(friend.id),
              busy: inviteBusy === friend.id,
            }))}
            inviteNotice={inviteNotice}
            onInvite={(friendId) => void invite(seated.room.id, friendId)}
            members={members}
            onRemove={(memberId) => void removeMember(memberId)}
            maxSeats={seated.room.maxSeats}
            ready={ready}
            readyOffered={readyOffered}
            onToggleReady={() => void setReady(!ready)}
            startable={startable}
            onStart={() => void startTable()}
            onLeave={() => void leave()}
          />
        ) : (
          <View style={styles.actions}>
            <SurfaceCard>
              <AppText variant="bodyStrong">Open a table</AppText>
              <SeatChoice value={seats} onChange={setSeats} />
              <AppText variant="caption" color="textDisabled">
                Arc Standard rules. You can start once a second player has
                arrived.
              </AppText>
              <Button
                label="Open a table"
                testID="room-create"
                accessibilityHint="Opens a table and gives you a code to share"
                onPress={() => void onCreate()}
                disabled={status.kind === "working"}
              />
            </SurfaceCard>

            <SurfaceCard>
              <AppText variant="bodyStrong">Join with a code</AppText>
              <TextInput
                value={codeInput}
                onChangeText={setCodeInput}
                placeholder="ABC123"
                placeholderTextColor={colors.textDisabled}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={ROOM_CODE_LENGTH}
                style={styles.codeField}
                testID="room-code-input"
                accessibilityLabel="Table code"
                returnKeyType="go"
                onSubmitEditing={onJoin}
              />
              <AppText variant="caption" color="textDisabled">
                Six characters. The letters O and I and the digits 0 and 1 are
                never used, so there is nothing to mistype.
              </AppText>
              <Button
                label="Join table"
                variant="secondary"
                testID="room-join"
                accessibilityHint="Joins the table with the code you entered"
                onPress={onJoin}
                disabled={status.kind === "working"}
              />
            </SurfaceCard>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** How many seats the table has. Fixed once the room is open. */
function SeatChoice({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  const borderColor = useBorderColor();
  return (
    <View>
      <AppText variant="caption" color="textSecondary">
        Seats
      </AppText>
      <View style={styles.seatChoices} accessibilityRole="radiogroup">
        {SEAT_CHOICES.map((count) => {
          const selected = count === value;
          return (
            <Pressable
              key={count}
              onPress={() => onChange(count)}
              testID={`room-seats-${count}`}
              accessibilityRole="radio"
              accessibilityLabel={`${count} seats`}
              accessibilityState={{ selected }}
              style={[
                styles.seatChoice,
                { borderColor },
                selected ? styles.seatChoiceSelected : null,
              ]}
            >
              <AppText variant="bodyStrong" color={selected ? "textPrimary" : "textSecondary"}>
                {count}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

interface SeatedMember {
  key: string;
  label: string;
  seat: number;
  isHost: boolean;
  isReady: boolean;
  isYou: boolean;
  removable: boolean;
}

interface SeatedLobbyProps {
  code: string;
  readiness: string;
  shareNotice: string | null;
  onShare: () => void;
  invitable: Array<{ id: string; label: string; invited: boolean; busy: boolean }>;
  inviteNotice: string | null;
  onInvite: (friendId: string) => void;
  members: SeatedMember[];
  onRemove: (userId: string) => void;
  maxSeats: number;
  ready: boolean;
  readyOffered: boolean;
  onToggleReady: () => void;
  startable: boolean;
  onStart: () => void;
  onLeave: () => void;
}

function SeatedLobby({
  code,
  readiness,
  shareNotice,
  onShare,
  invitable,
  inviteNotice,
  onInvite,
  members,
  onRemove,
  maxSeats,
  ready,
  readyOffered,
  onToggleReady,
  startable,
  onStart,
  onLeave,
}: SeatedLobbyProps) {
  return (
    <View style={styles.actions}>
      <SurfaceCard>
        <AppText variant="overline" color="textSecondary">
          Share this code
        </AppText>
        <AppText variant="display" numeric testID="room-code">
          {code}
        </AppText>
        <Button
          label="Share code"
          variant="secondary"
          testID="room-share"
          accessibilityHint="Opens the share sheet with this table's code"
          onPress={onShare}
        />
        {shareNotice ? (
          <AppText variant="caption" color="warning" testID="room-share-notice">
            {shareNotice}
          </AppText>
        ) : null}
      </SurfaceCard>

      <SurfaceCard>
        <AppText variant="bodyStrong">
          {members.length} of {maxSeats} seated
        </AppText>
        <AppText variant="caption" color="textSecondary" testID="room-readiness">
          {readiness}
        </AppText>
        {members.map((member) => (
          <View key={member.key} style={styles.seatRow}>
            <View style={styles.seatWho}>
              <AppText variant="body">
                {member.seat}. {member.label}
                {member.isYou ? " (you)" : ""}
              </AppText>
              <AppText
                variant="caption"
                color={member.isReady ? "success" : "textDisabled"}
                testID={`room-member-ready-${member.seat}`}
              >
                {member.isHost ? "Host · " : ""}
                {member.isReady ? "Ready" : "Not ready"}
              </AppText>
            </View>
            {member.removable ? (
              <Button
                label="Remove"
                variant="quiet"
                size="medium"
                testID={`room-remove-${member.seat}`}
                accessibilityHint={`Removes ${member.label} from this table`}
                onPress={() => onRemove(member.key)}
              />
            ) : null}
          </View>
        ))}
        {members.length < 2 ? (
          <AppText variant="caption" color="textDisabled">
            Waiting for one more player. A table needs at least two.
          </AppText>
        ) : null}
      </SurfaceCard>

      {/*
        Readiness tells the host who is looking at the screen. It is deliberately
        not a gate: the specification's start rule is two human players, so a
        player who never touches this is still dealt in.
      */}
      {readyOffered ? (
        <Button
          label={ready ? "I'm not ready" : "I'm ready"}
          variant="secondary"
          testID="room-ready"
          accessibilityHint="Tells everyone else whether you are ready to start"
          onPress={onToggleReady}
        />
      ) : null}

      {/*
        Invites go to CONFIRMED FRIENDS only, and the server checks that again.
        A code is shareable by any means a person likes; an in-app invite is not
        a way to reach a stranger.
      */}
      {members.length < maxSeats ? (
        <SurfaceCard>
          <AppText variant="bodyStrong">Invite a friend</AppText>
          {invitable.length === 0 ? (
            <AppText variant="caption" color="textSecondary">
              Nobody to invite yet — everyone you are friends with is already
              here, or you have not added anyone. The code above works with
              anybody.
            </AppText>
          ) : (
            invitable.map((friend) => (
              <View key={friend.id} style={styles.seatRow}>
                <AppText variant="body">{friend.label}</AppText>
                {friend.invited ? (
                  <AppText variant="caption" color="success">
                    Invited
                  </AppText>
                ) : (
                  <Button
                    label="Invite"
                    variant="quiet"
                    disabled={friend.busy}
                    testID={`room-invite-${friend.label}`}
                    accessibilityHint={`Sends ${friend.label} an invite to this table`}
                    onPress={() => onInvite(friend.id)}
                  />
                )}
              </View>
            ))
          )}
          {inviteNotice ? (
            <AppText variant="caption" color="warning" testID="room-invite-notice">
              {inviteNotice}
            </AppText>
          ) : null}
        </SurfaceCard>
      ) : null}

      {/*
        Only the host deals, and the server enforces it independently — this
        button being disabled is a courtesy, not the control.
      */}
      <Button
        label="Deal the first hand"
        testID="room-start"
        accessibilityHint="Starts the first hand for everyone seated"
        onPress={onStart}
        disabled={!startable}
      />
      {!startable ? (
        <AppText variant="caption" color="textDisabled" align="center">
          The host deals when everyone has arrived.
        </AppText>
      ) : null}

      <Button
        label="Leave table"
        variant="quiet"
        testID="room-leave"
        accessibilityHint="Leaves this table and returns your seat"
        onPress={onLeave}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  bar: { paddingHorizontal: layout.screenPadding },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.xl,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  header: { gap: spacing.xs },
  actions: { gap: spacing.lg },
  seatRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.xs,
    gap: spacing.md,
  },
  seatWho: { flexShrink: 1, gap: 2 },
  seatChoices: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  seatChoice: {
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.small,
    borderWidth: 1,
    backgroundColor: colors.surfaceRaised,
  },
  seatChoiceSelected: {
    backgroundColor: colors.accentSoft,
    borderColor: colors.accent,
  },
  codeField: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 20,
    letterSpacing: 4,
    textAlign: "center",
  },
});
