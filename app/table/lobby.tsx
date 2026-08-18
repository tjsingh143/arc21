/**
 * Private table — open one, or join with a code.
 *
 * The screen states the economics before anything else, because they are the
 * surprising part: the chips here are the table's own, nothing is at stake from
 * the global wallet, and nothing won here can leave. That is the anti-collusion
 * rule, and a player who does not know it will assume the opposite.
 */

import { useCallback, useEffect, useMemo } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { colors, layout, radius, spacing } from "../../src/design/tokens";
import { useAuthStore } from "../../src/features/auth";
import { selectFriends, useFriendsStore } from "../../src/features/friends";
import { usePushRegistration } from "../../src/features/notifications";
import { useSettings } from "../../src/features/settings/use-settings";
import { useRoomInvites } from "../../src/features/rooms/use-room-invites";
import { canStartTable, ROOM_CODE_LENGTH, useRoomsStore } from "../../src/features/rooms";

export default function PrivateTableLobby() {
  const status = useRoomsStore((state) => state.status);
  const codeInput = useRoomsStore((state) => state.codeInput);
  const notice = useRoomsStore((state) => state.notice);
  const setCodeInput = useRoomsStore((state) => state.setCodeInput);
  const createRoom = useRoomsStore((state) => state.createRoom);
  const joinRoom = useRoomsStore((state) => state.joinRoom);
  const refresh = useRoomsStore((state) => state.refresh);
  const startTable = useRoomsStore((state) => state.startTable);
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
    await createRoom(5);
    const granted = await offerPush("created-private-table", settings);
    if (granted) await updateSettings(granted);
  }, [createRoom, offerPush, settings, updateSettings]);

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

  /*
   * Navigate from committed state rather than inside the button handler.
   * Routing in the same tick as the state change raced the redirect once
   * already in this project, roughly one launch in three.
   */
  useEffect(() => {
    if (!dealt) return;
    router.replace({
      pathname: "/table/[gameId]",
      params: { gameId: dealt.gameId, seatId: dealt.seatId },
    });
  }, [dealt]);

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
            invitable={invitable.map((friend) => ({
              id: friend.id,
              label: friend.displayName,
              invited: invited.includes(friend.id),
              busy: inviteBusy === friend.id,
            }))}
            inviteNotice={inviteNotice}
            onInvite={(friendId) => void invite(seated.room.id, friendId)}
            members={seated.members.map((member) => ({
              key: member.userId,
              label: member.displayName,
              seat: member.seatIndex + 1,
              isHost: member.isHost,
            }))}
            maxSeats={seated.room.maxSeats}
            startable={startable}
            onStart={() => void startTable()}
            onLeave={() => void leave()}
          />
        ) : (
          <View style={styles.actions}>
            <Button
              label="Open a table"
              testID="room-create"
              accessibilityHint="Opens a table and gives you a code to share"
              onPress={() => void onCreate()}
              disabled={status.kind === "working"}
            />

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

interface SeatedLobbyProps {
  code: string;
  invitable: Array<{ id: string; label: string; invited: boolean; busy: boolean }>;
  inviteNotice: string | null;
  onInvite: (friendId: string) => void;
  members: Array<{ key: string; label: string; seat: number; isHost: boolean }>;
  maxSeats: number;
  startable: boolean;
  onStart: () => void;
  onLeave: () => void;
}

function SeatedLobby({
  code,
  invitable,
  inviteNotice,
  onInvite,
  members,
  maxSeats,
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
      </SurfaceCard>

      <SurfaceCard>
        <AppText variant="bodyStrong">
          {members.length} of {maxSeats} seated
        </AppText>
        {members.map((member) => (
          <View key={member.key} style={styles.seatRow}>
            <AppText variant="body">
              {member.seat}. {member.label}
            </AppText>
            {member.isHost ? (
              <AppText variant="caption" color="textSecondary">
                Host
              </AppText>
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
        button being hidden is a courtesy, not the control.
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
