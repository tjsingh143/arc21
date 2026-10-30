/**
 * Home — a home base, not a promotional lobby.
 *
 * What is deliberately absent matters as much as what is here: no rotating
 * offers, no purchase packages, no countdown sales, no wheel, no second
 * currency, no automatic modal rewards. Play is one tap away.
 *
 * Everything server-dependent states that plainly instead of rendering zeros
 * that would read as real results.
 *
 * WHAT HOME LEADS WITH (Refresh D). Arc 21 is for playing blackjack for chips,
 * with other people first. A ready player sees, in order: tables with other
 * people and solo Quick Play, then AI Tables, then Practice and progress. The
 * order and every claim in it — who is at a table, whose chips, what it counts
 * toward — come from `src/features/home/product-hierarchy.ts`, which the Play
 * tab renders too, and whose claims are tested against the server's own lists.
 *
 * A player the SERVER has not confirmed cannot open any of the first two
 * tiers, so for them Practice leads and one card says why online play is not
 * open. That is the specification's "Quick Play online CTA becomes Practice",
 * applied to everything online. Nothing becomes unreachable: the formats move
 * to the links at the bottom, and every screen states what it needs.
 *
 * EVERY CARD IS INERT, AND ITS BUTTON IS THE CONTROL. Cards here used to be
 * pressables wrapping a Button with the same action: two overlapping touch
 * targets, two focusable elements on Android, and on iOS a card label that hid
 * the Button entirely. That forced the label to restate the card — which is
 * how "Play Practice" once stood in for "Resume your session · Bankroll 4,900 ·
 * hand 1" and a screen reader was never told a session existed. An inert card
 * keeps each line its own element, read in order, and the Button names the
 * action. `home-practice` stays on the Practice button, which is the element
 * native flows have always tapped.
 *
 * The career card names the next unfinished node, with its chapter and its
 * stars. It once named `CAREER_NODES[0]` — a literal — so it advertised "First
 * Deal" to somebody who had finished the chapter.
 */

import { useCallback, useEffect, useMemo } from "react";
import { router, useFocusEffect } from "expo-router";
import { ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  SectionHeading,
  SurfaceCard,
  Tile,
  UnavailableNote,
} from "../../src/components/ui/Card";
import { ConnectPlayerButton } from "../../src/components/ui/ConnectPlayerButton";
import { ScreenHeader } from "../../src/components/ui/ScreenHeader";
import { AppText } from "../../src/components/ui/AppText";
import { Button } from "../../src/components/ui/Button";
import { colors, layout, spacing } from "../../src/design/tokens";
import { rowStacksAtFontScale } from "../../src/design/type-metrics";
import { formatChips } from "../../src/design/typography";
import {
  CAREER_CHAPTERS,
  CAREER_NODES,
  careerNodesInChapter,
} from "../../shared/career/nodes.js";
import {
  chapterStars,
  nextRecommendedNode,
  starsForNode,
} from "../../shared/career/progress.js";
import { useCareerProgress } from "../../src/features/career/use-career-progress";
import { useCareerServerStore } from "../../src/features/career/career-server-store";
import {
  AI_TABLES_SUMMARY,
  HOME_CHIP_FORMAT_LINKS,
  PLAY_MODES,
  homeLayout,
  homeLinks,
  homeResume,
  inRows,
  linkAccessibilityLabel,
  modeFacts,
  onlineAvailability,
  stakeSentence,
  type HomeBlock,
  type ProductLink,
} from "../../src/features/home/product-hierarchy";
import { usePracticeStore } from "../../src/features/practice/practice-store";
import { useQuickPlayStore } from "../../src/features/quick-play";
import { useAuthStore } from "../../src/features/auth";
import {
  describeActiveSession,
  describeActiveSessionMode,
  resumeTargetFor,
  useActiveSessionStore,
} from "../../src/features/table";
import { useConnectivityStore } from "../../src/lib/connectivity/connectivity-store";
import { getSupabase } from "../../src/lib/supabase/client";
import { CHIPS_NOT_MONEY_FOOTER } from "../../src/features/settings/fair-play-facts";

function LinkRows({ links }: { links: readonly ProductLink[] }) {
  const { fontScale } = useWindowDimensions();
  const stacked = rowStacksAtFontScale(fontScale);
  return (
    <>
      {inRows(links, stacked ? 1 : 2).map((row) => (
        <View key={row.map((link) => link.id).join("+")} style={styles.tileRow}>
          {row.map((link) => (
            <Tile
              key={link.id}
              label={link.label}
              detail={link.detail}
              testID={`home-${link.testID}`}
              accessibilityLabel={linkAccessibilityLabel(link)}
              onPress={() => router.push(link.route as never)}
            />
          ))}
        </View>
      ))}
    </>
  );
}

export default function HomeScreen() {
  // At an accessibility size a card's badge goes under its overline: beside
  // it, the 17e drew "FOUNDATIONS0/" with the star count cut off at the edge.
  const { fontScale } = useWindowDimensions();
  const stackHeaders = rowStacksAtFontScale(fontScale);
  const stats = usePracticeStore((state) => state.stats);
  const game = usePracticeStore((state) => state.game);
  const hydrate = usePracticeStore((state) => state.hydrate);
  const hydrated = usePracticeStore((state) => state.hydrated);

  // Home must hydrate too, not just the table. Without this, a player who was
  // killed mid-hand comes back to a card offering a *new* session, because the
  // saved one has not been read yet — the hand is intact on disk but invisible.
  // `hydrate` is idempotent, so the table calling it as well is harmless.
  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  /*
   * Whether online play can be OFFERED. `session` is set only once the server
   * has answered for the player (a credential restored from the keychain is
   * not a player until then), and offline means the server has stopped
   * answering. Configuration is read from its source, not from the auth
   * store's copy: that copy is false until `hydrate` runs, which would have
   * printed "no server configured" for a moment on every configured launch.
   */
  const userId = useAuthStore((state) => state.session?.account.userId ?? null);
  const authHydrated = useAuthStore((state) => state.hydrated);
  const hydrateAuth = useAuthStore((state) => state.hydrate);
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

  const { progress } = useCareerProgress();
  const serverCareer = useCareerServerStore((state) => state.progress);
  const remembered = useQuickPlayStore((state) => state.remembered);
  const loadQuickPlay = useQuickPlayStore((state) => state.load);

  useEffect(() => {
    if (!authHydrated) void hydrateAuth();
    void loadQuickPlay();
  }, [authHydrated, hydrateAuth, loadQuickPlay]);

  /*
   * WHERE THE PLAYER'S CHIPS ARE, asked each time Home comes into view — and
   * only for a ready player. A held seat makes the server refuse every new
   * table, so Home says so above the tables it would otherwise offer. Asked on
   * focus rather than once, because a tab stays mounted: a player who cashed
   * out and came back would otherwise be offered a table they had left. Keyed
   * on the player, so a replacement player is asked about, and the previous
   * player's late answer is dropped by the store's scoped setter.
   */
  const activeStatus = useActiveSessionStore((state) => state.status);
  const refreshActive = useActiveSessionStore((state) => state.refresh);
  useFocusEffect(
    useCallback(() => {
      if (playerReady && userId !== null) void refreshActive();
    }, [playerReady, userId, refreshActive]),
  );
  const resume = useMemo(() => homeResume(activeStatus, playerReady), [activeStatus, playerReady]);

  const bankroll = game?.seats[0]?.stack ?? null;

  /*
   * The next node, from EITHER record.
   *
   * Ranked progress lives on the server and offline practice lives on the
   * device; a player who finished three nodes on another phone should not be
   * shown node one here. Merged with `useMemo` on subscribed state, never by
   * reading a store getter during render.
   */
  const nextNode = useMemo(() => {
    const local = nextRecommendedNode(progress);
    const firstUnfinishedOnServer = CAREER_NODES.find(
      (node) => serverCareer[node.slug]?.completed !== true,
    );
    if (!local) return firstUnfinishedOnServer ?? null;
    if (!firstUnfinishedOnServer) return local;
    // Whichever is FURTHER along, so neither record can drag the other back.
    const localIndex = CAREER_NODES.findIndex((node) => node.slug === local.slug);
    const serverIndex = CAREER_NODES.findIndex(
      (node) => node.slug === firstUnfinishedOnServer.slug,
    );
    return serverIndex > localIndex ? firstUnfinishedOnServer : local;
  }, [progress, serverCareer]);

  const nextChapter = useMemo(
    () => CAREER_CHAPTERS.find((chapter) => chapter.id === nextNode?.chapter) ?? null,
    [nextNode],
  );
  const chapterProgress = useMemo(() => {
    if (!nextChapter) return null;
    const local = chapterStars(progress, nextChapter.id);
    const fromServer = careerNodesInChapter(nextChapter.id).reduce(
      (total, node) =>
        total + Math.max(starsForNode(progress, node.slug), serverCareer[node.slug]?.stars ?? 0),
      0,
    );
    return { earned: Math.max(local.earned, fromServer), available: local.available };
  }, [nextChapter, progress, serverCareer]);

  const accuracy =
    stats.decisions > 0 ? Math.round((stats.correct / stats.decisions) * 100) : null;

  const blocks = useMemo(
    () =>
      homeLayout({
        online,
        resume,
        hasCareer: nextNode !== null,
        hasMastery: accuracy !== null,
      }),
    [online, resume, nextNode, accuracy],
  );

  function renderBlock(block: HomeBlock) {
    switch (block) {
      case "resume":
        if (resume.kind !== "seated") return null;
        return (
          // Inert, with the Button as the control — the same shape as the Play
          // tab's resume card, for the same reason.
          <SurfaceCard key={block} testID="home-resume-card">
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
              testID="home-resume"
              style={styles.cta}
            />
          </SurfaceCard>
        );

      case "resume-unknown":
        return (
          // "We could not find out" is not "you are not at a table", so it is
          // said rather than left as an absent card that reads as the second.
          <View key={block} style={styles.section} testID="home-resume-unknown">
            <UnavailableNote>
              Arc 21 could not check whether you are still seated at a table. If you are, a
              new table will be refused until you return to it.
            </UnavailableNote>
            <Button
              label="Check again"
              variant="quiet"
              size="medium"
              onPress={() => void refreshActive()}
              testID="home-resume-retry"
            />
          </View>
        );

      case "chip-tables": {
        const publicTable = PLAY_MODES["public-table"];
        const privateTable = PLAY_MODES["private-table"];
        const quickPlay = PLAY_MODES["quick-play"];
        return (
          <View key={block} style={styles.section} testID="home-chip-tables">
            <SectionHeading
              title="Play for chips"
              summary="Dealt on the server, at tables with other people or on your own."
            />

            {/*
              The leading entry: a table with other people. Public is the
              primary action because it is the one a player can take right now
              with nobody to invite; a private table is the second, for friends.
            */}
            <SurfaceCard testID="home-people-card">
              <AppText variant="overline" color="accent">
                With other people
              </AppText>
              <AppText variant="sectionTitle">Sit at a table with other players</AppText>
              <AppText variant="body" color="textSecondary">
                {`${publicTable.purpose} ${stakeSentence(publicTable)}`}
              </AppText>
              <Button
                label="Find a public table"
                // A held seat is the one action that leads; a second primary
                // beside it would be offering a table the server will refuse.
                variant={resume.kind === "seated" ? "secondary" : "primary"}
                onPress={() => router.push("/table/public")}
                testID="home-public-table"
                accessibilityHint="Opens public table setup. You choose stakes before any chips are taken."
                style={styles.cta}
              />
              <AppText variant="body" color="textSecondary" style={styles.cta}>
                {`${privateTable.purpose} ${stakeSentence(privateTable)}`}
              </AppText>
              <Button
                label="Private table with friends"
                variant="secondary"
                onPress={() => router.push("/table/lobby")}
                testID="home-private-table"
                accessibilityHint="Opens the private table lobby"
                style={styles.ctaTight}
              />
            </SurfaceCard>

            {/*
              Quick Play is SOLO chip play, and says so in its overline: a table
              of one, using the wallet. It resumes the last setup in one tap —
              to the setup screen, which still states the buy-in before dealing.
            */}
            <SurfaceCard testID="home-quick-play-card">
              <AppText variant="overline" color="accent">
                Quick Play · Solo
              </AppText>
              <AppText variant="sectionTitle">
                {remembered ? "Resume your last setup" : "A table of your own"}
              </AppText>
              <AppText variant="body" color="textSecondary">
                {remembered
                  ? `${remembered.tier[0]!.toUpperCase()}${remembered.tier.slice(1)} stakes · ${remembered.assistance} assistance`
                  : "Pick your stakes and how much help you want."}
              </AppText>
              <AppText variant="caption" color="textSecondary">
                {`${quickPlay.purpose} ${stakeSentence(quickPlay)}`}
              </AppText>
              <Button
                label="Open Quick Play"
                variant="secondary"
                onPress={() => router.push("/table/quick")}
                testID="home-quick-play"
                accessibilityHint="Opens Quick Play setup. The buy-in is confirmed there before anything is spent."
                style={styles.cta}
              />
            </SurfaceCard>

            <LinkRows links={HOME_CHIP_FORMAT_LINKS} />
          </View>
        );
      }

      case "ai-table": {
        const ai = PLAY_MODES["ai-table"];
        return (
          <View key={block} style={styles.section} testID="home-ai-tables">
            <SectionHeading title="AI Tables" />
            <SurfaceCard testID="home-ai-table-card">
              <AppText variant="overline" color="accent">
                AI Table · Unranked
              </AppText>
              <AppText variant="sectionTitle">Play beside computer players</AppText>
              <AppText variant="body" color="textSecondary">
                {AI_TABLES_SUMMARY}
              </AppText>
              <AppText variant="caption" color="textSecondary" numeric>
                {`${ai.structure} · needs a connection`}
              </AppText>
              <Button
                label="Open AI Tables"
                variant="secondary"
                onPress={() => router.push("/table/ai")}
                testID="home-ai-table"
                accessibilityHint="Shows the AI Table's terms before a table opens"
                style={styles.cta}
              />
            </SurfaceCard>
          </View>
        );
      }

      case "practice":
        return (
          <View key={block} style={styles.section}>
            {playerReady ? <SectionHeading title="Practice and progress" /> : null}
            <SurfaceCard testID="home-practice-card">
              <AppText variant="overline" color={playerReady ? "textSecondary" : "accent"}>
                Practice
              </AppText>
              <AppText variant="sectionTitle">
                {bankroll === null ? "Play offline, at your own pace" : "Resume your session"}
              </AppText>
              <AppText variant="body" color="textSecondary">
                {bankroll === null
                  ? "Six decks, dealer stands on soft 17, blackjack pays 3:2."
                  : `Bankroll ${formatChips(bankroll)} · hand ${game?.handNumber ?? 1}`}
              </AppText>
              <AppText variant="caption" color="textSecondary">
                {modeFacts(PLAY_MODES.practice)}
              </AppText>
              <Button
                label={bankroll === null ? "Play Practice" : "Continue Practice"}
                // The lead action whenever online play cannot open.
                variant={playerReady ? "secondary" : "primary"}
                onPress={() => router.push("/game/practice")}
                testID="home-practice"
                accessibilityHint="Opens the offline Practice table"
                style={styles.cta}
              />
            </SurfaceCard>
          </View>
        );

      case "online-unavailable":
        if (online.kind === "ready") return null;
        return (
          <SurfaceCard key={block} testID="home-online-unavailable">
            <AppText variant="overline" color="textSecondary">
              Online play
            </AppText>
            <AppText variant="sectionTitle">Tables with other people, Quick Play and AI Tables</AppText>
            <AppText variant="body" color="textSecondary">
              {online.message}
            </AppText>
            {/* Only somebody with no player can be helped by connecting one. */}
            {configured && userId === null ? (
              <View style={styles.cta}>
                <ConnectPlayerButton testID="home-connect" />
              </View>
            ) : null}
          </SurfaceCard>
        );

      case "career":
        if (!nextNode) return null;
        return (
          <SurfaceCard key={block} testID="home-career-card">
            <View style={[styles.cardHeader, stackHeaders ? styles.cardHeaderStacked : null]}>
              <AppText variant="overline" color="textSecondary">
                {nextChapter?.title ?? "Career"}
              </AppText>
              {chapterProgress ? (
                <AppText
                  variant="caption"
                  color="textSecondary"
                  numeric
                  accessibilityLabel={`${chapterProgress.earned} of ${chapterProgress.available} stars`}
                >
                  {`${chapterProgress.earned}/${chapterProgress.available} ★`}
                </AppText>
              ) : null}
            </View>
            <AppText variant="sectionTitle">{nextNode.title}</AppText>
            <AppText variant="body" color="textSecondary">
              {nextNode.summary}
            </AppText>
            <Button
              label="Continue Career"
              variant="secondary"
              onPress={() => router.push(`/career/${nextNode.slug}`)}
              testID="home-career"
              accessibilityHint={`Opens ${nextNode.title}`}
              style={styles.cta}
            />
          </SurfaceCard>
        );

      case "mastery":
        if (accuracy === null) return null;
        return (
          <SurfaceCard key={block} testID="home-mastery">
            <AppText variant="overline" color="textSecondary">
              Your mastery
            </AppText>
            <AppText variant="display" numeric>
              {`${accuracy}%`}
            </AppText>
            <AppText variant="caption" color="textSecondary" numeric>
              {`strategy accuracy over ${stats.decisions} decision${stats.decisions === 1 ? "" : "s"}`}
            </AppText>
          </SurfaceCard>
        );

      case "links":
        /*
          Every tile leads somewhere real. Several need a player, and each
          screen says so on arrival rather than being greyed out here: a
          disabled tile teaches a player nothing about what they are missing.
        */
        return (
          <View key={block} style={styles.section} testID="home-links">
            <LinkRows links={homeLinks(online)} />
          </View>
        );
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        // The layout-independent anchor for "Home is showing". Which card is
        // first now depends on whether online play can open, so no card's id
        // can stand in for the screen.
        testID="home-screen"
      >
        {/* The header reads the session and the wallet itself — see ScreenHeader. */}
        <ScreenHeader title="Arc 21" subtitle="Blackjack, without the noise." />

        {blocks.map(renderBlock)}

        <AppText variant="caption" color="textDisabled" align="center" style={styles.disclaimer}>
          {CHIPS_NOT_MONEY_FOOTER}
        </AppText>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  cta: {
    marginTop: spacing.md,
  },
  ctaTight: {
    marginTop: spacing.sm,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardHeaderStacked: {
    flexDirection: "column",
    alignItems: "flex-start",
    justifyContent: "flex-start",
  },
  tileRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  section: {
    gap: spacing.sm,
  },
  disclaimer: {
    marginTop: spacing.lg,
  },
});
