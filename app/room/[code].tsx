/**
 * `arc21://room/CODE` — a shared private-table invite.
 *
 * The specification's rule for this route is one sentence: **do not trust the
 * room code alone as authorization.** Nothing here decides whether the player
 * may sit down. The code is normalised, checked for shape so an obviously
 * malformed link never becomes a request, and then handed to
 * `join_private_room`, which re-checks capacity, expiry, blocks and the room's
 * status server-side. A link is an address, not a key.
 *
 * The three outcomes a link can have are all rendered, because a deep link is
 * the one entry point where the player has no context for a failure: signed out,
 * refused, or joined.
 */

import { useEffect, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { colors, layout, spacing } from "../../src/design/tokens";
import { useAuthStore } from "../../src/features/auth";
import { looksLikeRoomCode, normaliseRoomCode, useRoomsStore } from "../../src/features/rooms";

export default function RoomInvite() {
  const params = useLocalSearchParams<{ code?: string }>();
  const code = useMemo(() => normaliseRoomCode(params.code ?? ""), [params.code]);

  const session = useAuthStore((state) => state.session);
  const status = useRoomsStore((state) => state.status);
  const notice = useRoomsStore((state) => state.notice);
  const setCodeInput = useRoomsStore((state) => state.setCodeInput);
  const joinRoom = useRoomsStore((state) => state.joinRoom);

  // A once-only latch, never rendered. As state it re-ran this effect with its
  // own write and cost a render for a value nothing displays.
  const attempted = useRef(false);

  const wellFormed = looksLikeRoomCode(code);

  useEffect(() => {
    // A guest has no account to seat, and joining is not the moment to force
    // one: the screen says what is needed and offers the route.
    if (!session || !wellFormed || attempted.current) return;
    attempted.current = true;
    setCodeInput(code);
    void joinRoom();
  }, [session, wellFormed, code, setCodeInput, joinRoom]);

  // Joined: hand over to the lobby, which is where a seated player belongs.
  useEffect(() => {
    if (status.kind === "seated") router.replace("/table/lobby");
  }, [status]);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.bar}>
        <BackBar />
      </View>

      <View style={styles.content}>
        <AppText variant="pageTitle" accessibilityRole="header">
          Table invite
        </AppText>

        {!wellFormed ? (
          <UnavailableNote>
            That link does not contain a table code. A code is six letters and
            numbers.
          </UnavailableNote>
        ) : !session ? (
          <SurfaceCard>
            <AppText variant="bodyStrong" testID="room-invite-signed-out">
              {`Table ${code}`}
            </AppText>
            <AppText variant="caption" color="textSecondary">
              Private tables need an account, because a seat belongs to a player
              rather than to a device. Practice stays available without one.
            </AppText>
            <Button
              label="Create account"
              testID="room-invite-sign-in"
              onPress={() => router.push("/(auth)/create-account")}
            />
          </SurfaceCard>
        ) : notice ? (
          /*
           * The server's own words. It deliberately does not distinguish "full"
           * from "expired" from "you are blocked" — the same wording everywhere
           * else in the friend graph, so a link cannot be used to probe.
           */
          <SurfaceCard>
            <AppText variant="bodyStrong" testID="room-invite-refused">
              {notice}
            </AppText>
            <Button
              label="Private tables"
              variant="secondary"
              onPress={() => router.replace("/table/lobby")}
            />
          </SurfaceCard>
        ) : (
          <AppText variant="body" color="textSecondary" testID="room-invite-joining">
            {`Joining table ${code}…`}
          </AppText>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  bar: { paddingHorizontal: layout.screenPadding },
  content: {
    padding: layout.screenPadding,
    gap: spacing.lg,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
});
