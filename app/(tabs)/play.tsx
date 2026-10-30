/**
 * Play — the game-mode selector.
 *
 * Every mode states who is at the table, whose chips are at stake and what a
 * hand there counts toward, and whether it needs a server. A mode that cannot
 * open in this state says why above the list, rather than being a button that
 * explains itself afterwards.
 *
 * THE ORDER IS THE PRODUCT (Refresh D). Chip play first — tables with other
 * people, then solo tables against the dealer — then AI Tables, then Practice
 * and progress. It used to be a flat list that led with Practice and put the
 * multiplayer tables fourth. The sections, the order and every claim on a card
 * come from `src/features/home/product-hierarchy.ts`, which Home renders too,
 * so the two screens cannot disagree about what a mode is.
 *
 * No mode is ever described as having an "easy" or "hard" dealer, because none
 * does: the dealer follows fixed rules and never varies with anything.
 */

import { useCallback, useMemo } from "react";
import { router, useFocusEffect } from "expo-router";
import { ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  SectionHeading,
  SurfaceCard,
  Tile,
  UnavailableNote,
} from "../../src/components/ui/Card";
import { ScreenHeader } from "../../src/components/ui/ScreenHeader";
import { AppText } from "../../src/components/ui/AppText";
import { Button } from "../../src/components/ui/Button";
import { colors, layout, radius, spacing } from "../../src/design/tokens";
import { MAX_TITLE_FONT_SCALE, rowStacksAtFontScale } from "../../src/design/type-metrics";
import {
  modeAccessibilityHint,
  modeAccessibilityLabel,
  modeBadge,
} from "../../src/features/home/play-mode-presentation";
import {
  PLAY_MODES,
  PLAY_SECTIONS,
  PLAY_SUPPORT_LINKS,
  homeResume,
  inRows,
  linkAccessibilityLabel,
  modeFacts,
  onlineAvailability,
  type PlayMode,
} from "../../src/features/home/product-hierarchy";
import { useAuthStore } from "../../src/features/auth";
import {
  describeActiveSession,
  describeActiveSessionMode,
  resumeTargetFor,
  useActiveSessionStore,
} from "../../src/features/table";
import { useConnectivityStore } from "../../src/lib/connectivity/connectivity-store";
import { getSupabase } from "../../src/lib/supabase/client";

/**
 * One mode, as ONE accessibility element.
 *
 * A labelled `Pressable` REPLACES its children in the iOS accessibility tree,
 * so the label is composed from exactly what the card renders, in the order it
 * renders it: title, badge, purpose, structure and the facts line. The hint
 * says what activating it does. The card has no Button inside it, so there is
 * one touch target and one element.
 */
function ModeCard({ mode }: { mode: PlayMode }) {
  const badge = modeBadge(mode.availability);
  const facts = modeFacts(mode);
  // At an accessibility size the badge goes under the title: beside it, it left
  // the title a sliver and the 17e drew "Publi / c / Table".
  const { fontScale } = useWindowDimensions();
  const stacked = rowStacksAtFontScale(fontScale);
  return (
    <SurfaceCard
      onPress={() => router.push(mode.route as never)}
      testID={`play-mode-${mode.id}`}
      accessibilityLabel={modeAccessibilityLabel({
        title: mode.title,
        availability: mode.availability,
        purpose: mode.purpose,
        structure: mode.structure,
        facts,
        playable: true,
      })}
      accessibilityHint={modeAccessibilityHint({ playable: true })}
    >
      <View style={[styles.cardHeader, stacked ? styles.cardHeaderStacked : null]}>
        <AppText
          variant="sectionTitle"
          style={styles.cardTitle}
          maxFontSizeMultiplier={MAX_TITLE_FONT_SCALE}
        >
          {mode.title}
        </AppText>
        {/*
          * Word and colour from the SAME field. They used to come from
          * different ones and disagreed for every online mode the moment those
          * modes shipped.
          */}
        <View
          style={[
            styles.badge,
            badge.tone === "success" ? styles.badgeOffline : styles.badgeOnline,
          ]}
        >
          <AppText variant="caption" color={badge.tone === "success" ? "success" : "textSecondary"}>
            {badge.label}
          </AppText>
        </View>
      </View>

      <AppText variant="body" color="textSecondary">
        {mode.purpose}
      </AppText>

      {/* Structure, not a time promise — how long a session takes is up to the
          player, and claiming "about 5 minutes" would be a guess. */}
      <AppText variant="caption" color="textDisabled" numeric>
        {mode.structure}
      </AppText>

      <AppText variant="caption" color="textSecondary">
        {facts}
      </AppText>
    </SurfaceCard>
  );
}

export default function PlayScreen() {
  /*
   * Whether online play can be offered — the same reading Home makes. The
   * auth store's `session` exists only once the server has answered for the
   * player, and configuration is read from its source rather than from a copy
   * that is false until hydration.
   */
  const userId = useAuthStore((state) => state.session?.account.userId ?? null);
  const authHydrated = useAuthStore((state) => state.hydrated);
  const bootstrapStatus = useAuthStore((state) => state.bootstrapStatus);
  const bootstrapFailure = useAuthStore((state) => state.bootstrapFailure);
  const offline = useConnectivityStore((state) => state.status) === "offline";
  const configured = useMemo(() => getSupabase().status === "ready", []);
  const online = useMemo(
    () =>
      onlineAvailability({
        configured,
        hasPlayer: userId !== null,
        offline,
        serverUnreached: bootstrapFailure?.code === "NETWORK",
        connecting: !authHydrated || bootstrapStatus === "connecting",
      }),
    [configured, userId, offline, bootstrapFailure, authHydrated, bootstrapStatus],
  );
  const playerReady = online.kind === "ready";

  /*
   * WHERE THE PLAYER'S CHIPS ARE, asked whenever this screen comes into view.
   *
   * A buy-in leaves the wallet for a server-owned table stack, and the server
   * refuses a second one while the seat is still held. The game id and the seat
   * id reached the client exactly once, in the reply to the OPEN, so a player
   * who killed the app mid-hand was refused SESSION_ALREADY_ACTIVE by every
   * mode below with no way back. `my_active_session()` derives the seat from
   * `auth.uid()` using the SAME predicate as the server's one-live-seat control.
   *
   * Asked on focus and keyed on the player: a tab stays mounted, so asking once
   * at mount missed a player who was confirmed — or replaced — afterwards.
   */
  const activeStatus = useActiveSessionStore((state) => state.status);
  const refreshActive = useActiveSessionStore((state) => state.refresh);
  useFocusEffect(
    useCallback(() => {
      if (playerReady && userId !== null) void refreshActive();
    }, [playerReady, userId, refreshActive]),
  );

  // Derived from subscribed state with `useMemo`, never by calling a store
  // getter during render — the React Compiler memoises against the stable
  // function reference and freezes the value.
  const resume = useMemo(() => homeResume(activeStatus, playerReady), [activeStatus, playerReady]);
  const { fontScale } = useWindowDimensions();
  const stacked = rowStacksAtFontScale(fontScale);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        testID="play-screen"
      >
        <ScreenHeader title="Play" subtitle="Same rules everywhere." />

        {/*
          * Not a pressable card. A labelled `Pressable` REPLACES the text of
          * everything inside it in the iOS accessibility tree, which has cost
          * this project three surfaces already — so the card is inert and the
          * Button inside it is the control.
          */}
        {resume.kind === "seated" ? (
          <SurfaceCard testID="play-resume-card">
            <AppText variant="overline" color="textSecondary">
              Still at a table
            </AppText>
            <AppText variant="sectionTitle">{describeActiveSessionMode(resume.session.mode)}</AppText>
            <AppText variant="body" color="textSecondary">
              {describeActiveSession(resume.session)}
            </AppText>
            <Button
              label="Return to your table"
              onPress={() => router.replace(resumeTargetFor(resume.session) as never)}
              testID="play-resume"
            />
          </SurfaceCard>
        ) : null}

        {resume.kind === "unknown" ? (
          <View style={styles.notice} testID="play-resume-unknown">
            <UnavailableNote>
              Arc 21 could not check whether you are still seated at a table. If you are, a
              new table will be refused until you return to it.
            </UnavailableNote>
            <Button
              label="Check again"
              variant="quiet"
              size="medium"
              onPress={() => void refreshActive()}
              testID="play-resume-retry"
            />
          </View>
        ) : null}

        {/*
          * Said once, above everything it applies to, with the thing that does
          * work beside it. The modes stay listed — what each one IS does not
          * change with the connection, and each screen restates what it needs.
          */}
        {online.kind !== "ready" ? (
          <View style={styles.notice} testID="play-online-unavailable">
            <UnavailableNote>{online.message}</UnavailableNote>
            <Button
              label="Play Practice"
              variant="secondary"
              size="medium"
              onPress={() => router.push("/game/practice")}
              testID="play-practice-fallback"
              accessibilityHint="Opens the offline Practice table"
            />
          </View>
        ) : null}

        {PLAY_SECTIONS.map((section) => (
          <View key={section.tier} style={styles.section} testID={section.testID}>
            <SectionHeading title={section.title} summary={section.summary} />
            {section.groups.map((group) => (
              <View key={group.title ?? section.tier} style={styles.group}>
                {group.title !== null ? (
                  <AppText variant="bodyStrong" color="textSecondary" accessibilityRole="header">
                    {group.title}
                  </AppText>
                ) : null}
                {group.modes.map((id) => (
                  <ModeCard key={id} mode={PLAY_MODES[id]} />
                ))}
              </View>
            ))}
            {section.tier === "practice"
              ? inRows(PLAY_SUPPORT_LINKS, stacked ? 1 : 2).map((row) => (
                  <View key={row.map((link) => link.id).join("+")} style={styles.tileRow}>
                    {row.map((link) => (
                      <Tile
                        key={link.id}
                        label={link.label}
                        detail={link.detail}
                        testID={`play-${link.testID}`}
                        accessibilityLabel={linkAccessibilityLabel(link)}
                        onPress={() => router.push(link.route as never)}
                      />
                    ))}
                  </View>
                ))
              : null}
          </View>
        ))}

        <AppText variant="caption" color="textDisabled" align="center" style={styles.footer}>
          The dealer follows the same fixed rules in every mode. No mode deals
          differently, and nothing changes the cards based on how you are doing.
        </AppText>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.md,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  // Space between tiers is larger than space between cards, so the grouping
  // reads before any heading is.
  section: { gap: spacing.md, marginTop: spacing.lg },
  group: { gap: spacing.md },
  notice: { gap: spacing.sm },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  // The title yields width and the badge keeps it. Without the pair, a title
  // grown by Dynamic Type pushed the "Offline" pill off the right edge, where
  // it rendered as a clipped "Offlin" — the one word on the card that says
  // whether the mode works without an account.
  cardTitle: { flexShrink: 1 },
  cardHeaderStacked: {
    flexDirection: "column",
    alignItems: "flex-start",
    justifyContent: "flex-start",
  },
  badge: {
    flexShrink: 0,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  badgeOffline: { borderColor: colors.success },
  badgeOnline: { borderColor: colors.border },
  tileRow: { flexDirection: "row", gap: spacing.md },
  footer: { marginTop: spacing.lg },
});
