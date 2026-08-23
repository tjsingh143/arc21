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
 * THE PRIMARY CARD SWAPS, AND THAT IS THE SPECIFICATION'S OWN RULE.
 * "Quick Play online CTA becomes Practice" when there is no account and no
 * server, so a guest is offered the thing that actually works rather than a
 * button that would explain itself afterwards. A signed-in player gets Quick
 * Play, resuming their last setup in one tap.
 *
 * The career card used to name `CAREER_NODES[0]` — a literal — so it advertised
 * "First Deal" to somebody who had finished the chapter. It names the next
 * unfinished node now, with its chapter and its stars, which is what the
 * specification asks a progression card to carry.
 */

import { useEffect, useMemo } from "react";
import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { SurfaceCard, Tile, UnavailableNote } from "../../src/components/ui/Card";
import { ScreenHeader } from "../../src/components/ui/ScreenHeader";
import { AppText } from "../../src/components/ui/AppText";
import { Button } from "../../src/components/ui/Button";
import { colors, layout, spacing } from "../../src/design/tokens";
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
import { usePracticeStore } from "../../src/features/practice/practice-store";
import { useQuickPlayStore } from "../../src/features/quick-play";
import { useAuthStore } from "../../src/features/auth";
import { CHIPS_NOT_MONEY_FOOTER } from "../../src/features/settings/fair-play-facts";

export default function HomeScreen() {
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

  const session = useAuthStore((state) => state.session);
  const authHydrated = useAuthStore((state) => state.hydrated);
  const hydrateAuth = useAuthStore((state) => state.hydrate);

  const { progress } = useCareerProgress();
  const serverCareer = useCareerServerStore((state) => state.progress);
  const remembered = useQuickPlayStore((state) => state.remembered);
  const loadQuickPlay = useQuickPlayStore((state) => state.load);

  useEffect(() => {
    if (!authHydrated) void hydrateAuth();
    void loadQuickPlay();
  }, [authHydrated, hydrateAuth, loadQuickPlay]);

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

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* The header reads the session and the wallet itself — see ScreenHeader.
            This comment used to say Arc 21 had "no auth backend, so no server
            wallet to show", which stopped being true several phases ago. */}
        <ScreenHeader title="Arc 21" subtitle="Blackjack, without the noise." />

        {/*
          The label CARRIES the card's content, and that is not a nicety.

          `SurfaceCard` renders a Pressable, and on iOS an accessibilityLabel on
          a pressable REPLACES the text of everything inside it. This card said
          "Play Practice" and nothing else, so VoiceOver announced a static
          phrase while the screen showed "Resume your session · Bankroll 4,900 ·
          hand 1" — a player using a screen reader could not tell whether they
          had a session in progress, let alone what was in it.

          It also explains a Maestro failure that two sessions attributed to a
          dev-build reload race: `practice-resume` asserts ".*4,900.*" after a
          relaunch, and 4,900 was never in the accessibility tree to be found.
          The persistence had been working the whole time; the screenshot beside
          the failure shows the restored bankroll plainly.
        */}
        {/*
          The PRIMARY card. Quick Play for a signed-in player, resuming their
          last setup in one tap; Practice for everybody else, because the
          specification's offline rule is that the Quick Play CTA BECOMES
          Practice rather than explaining itself.
        */}
        {session !== null ? (
          <SurfaceCard
            onPress={() => router.push("/table/quick")}
            testID="home-quick-play"
            accessibilityLabel={
              remembered
                ? `Quick Play. Resume ${remembered.tier} stakes.`
                : "Quick Play. A standard table using your chip balance."
            }
            accessibilityHint="A server-authoritative table using your global chips"
          >
            <AppText variant="overline" color="accent">
              Quick Play
            </AppText>
            <AppText variant="sectionTitle">
              {remembered ? "Resume your last setup" : "A table of your own"}
            </AppText>
            <AppText variant="body" color="textSecondary">
              {remembered
                ? `${remembered.tier[0]!.toUpperCase()}${remembered.tier.slice(1)} stakes · ${remembered.assistance} assistance`
                : "Pick your stakes and how much help you want."}
            </AppText>
            <Button
              label={remembered ? "Deal" : "Set up"}
              onPress={() => router.push("/table/quick")}
              style={styles.cta}
            />
          </SurfaceCard>
        ) : null}

        <SurfaceCard
          onPress={() => router.push("/game/practice")}
          testID="home-practice"
          accessibilityLabel={
            bankroll === null
              ? "Play Practice. Play offline, at your own pace."
              : `Resume your session. Bankroll ${formatChips(bankroll)}, hand ${game?.handNumber ?? 1}.`
          }
          accessibilityHint="Offline blackjack with disposable chips"
        >
          <AppText variant="overline" color="accent">
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
          <Button
            label={bankroll === null ? "Play Practice" : "Continue"}
            onPress={() => router.push("/game/practice")}
            style={styles.cta}
          />
        </SurfaceCard>

        {/*
          The progression card: chapter, node, stars, continue — the four things
          the specification asks it to carry. It used to name `CAREER_NODES[0]`,
          a literal, so it advertised "First Deal" to a player who had finished
          the chapter.
        */}
        {nextNode ? (
          <SurfaceCard
            onPress={() => router.push(`/career/${nextNode.slug}`)}
            testID="home-career"
            accessibilityLabel={
              chapterProgress
                ? `Career. ${nextChapter?.title}, ${chapterProgress.earned} of ${chapterProgress.available} stars. Next: ${nextNode.title}.`
                : `Career. Next: ${nextNode.title}.`
            }
            accessibilityHint="Structured challenges that build correct decisions"
          >
            <View style={styles.cardHeader}>
              <AppText variant="overline" color="textSecondary">
                {nextChapter?.title ?? "Career"}
              </AppText>
              {chapterProgress ? (
                <AppText variant="caption" color="textSecondary" numeric>
                  {`${chapterProgress.earned}/${chapterProgress.available} ★`}
                </AppText>
              ) : null}
            </View>
            <AppText variant="sectionTitle">{nextNode.title}</AppText>
            <AppText variant="body" color="textSecondary">
              {nextNode.summary}
            </AppText>
            <Button
              label="Continue"
              variant="secondary"
              onPress={() => router.push(`/career/${nextNode.slug}`)}
              style={styles.cta}
            />
          </SurfaceCard>
        ) : null}

        {accuracy !== null ? (
          <SurfaceCard>
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
        ) : null}

        {/*
          The four compact tiles the specification names, plus Learn — which is
          the one thing on this screen that needs nothing at all and is where a
          new player should go first.

          Every tile leads somewhere real. Three of them need an account, and
          each screen says so on arrival rather than being greyed out here: a
          disabled tile teaches a player nothing about what they are missing.
        */}
        <View style={styles.tileRow}>
          <Tile
            label="Practice"
            detail="Offline, unlimited"
            onPress={() => router.push("/game/practice")}
          />
          <Tile label="Learn" detail="Guide and drills" onPress={() => router.push("/(tabs)/learn")} />
        </View>
        <View style={styles.tileRow}>
          <Tile
            label="Daily Challenge"
            detail="Same shoe for everyone"
            onPress={() => router.push("/daily")}
          />
          <Tile
            label="Tournament"
            detail="Four players, 12 hands"
            onPress={() => router.push("/tournament")}
          />
        </View>
        <View style={styles.tileRow}>
          <Tile
            label="Friends"
            detail="Requests and presence"
            onPress={() => router.push("/(tabs)/social")}
          />
          <Tile
            label="Leaderboards"
            detail="Weekly standing"
            onPress={() => router.push("/leaderboards")}
          />
        </View>

        {/*
          Said ONCE, and only to somebody it applies to. It used to be
          unconditional, so a signed-in player was told they needed an account
          on the screen that was already showing their balance.
        */}
        {session === null ? (
          <View style={styles.section}>
            <AppText variant="sectionTitle">Online</AppText>
            <UnavailableNote>
              Daily Challenge, tournaments, friends and leaderboards need an Arc 21
              account, because each of them is recorded on the server rather than
              taken on trust. Practice, the strategy guide and drills never do.
            </UnavailableNote>
          </View>
        ) : null}

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
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
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
