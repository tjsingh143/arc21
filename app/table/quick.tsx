/**
 * Quick Play — pick your stakes and how much help you want, then deal.
 *
 * The server half of this has been complete and heavily tested since the
 * economy shipped; nothing had ever sent it. The Play screen's card said so
 * plainly rather than pretending the reason was something a player could fix,
 * which is why this screen exists rather than a route being quietly added.
 *
 * WHAT THE SPECIFICATION ASKS FOR HERE, and where each part is:
 *
 *   "First authenticated Quick Play opens setup. Remember the selection
 *    afterward"                                    → `useQuickPlayStore.remember`
 *   three tiers with fixed buy-in / min / max      → `TABLE_TIERS`, read from the
 *                                                    engine, never retyped
 *   "High … unlock at level 10"                    → checked here AND beside the
 *                                                    money in `create-session`
 *   "If the player cannot afford the selected tier, offer: lower tier /
 *    Practice / eligible Recovery Grant. Never route directly to a
 *    real-money purchase."                         → the affordability block
 *   assistance selector PLAY/LEARN/ANALYSIS/CHALLENGE → sent once, at OPEN
 *   "Guest Quick Play should transparently redirect to equivalent local
 *    Practice rather than pretending to alter a global wallet."
 *                                                  → the signed-out branch
 *
 * There is no purchase anywhere on this screen and there never will be. The way
 * back from a low balance is a grant, a smaller table, or Practice.
 */

import { useEffect, useMemo, useState } from "react";
import { router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { colors, layout, radius, spacing } from "../../src/design/tokens";
import { formatChips } from "../../src/design/typography";
import { TABLE_TIERS } from "../../shared/blackjack";
import type { AssistanceMode } from "../../shared/contracts/index.js";
import type { TierId } from "../../src/features/matchmaking";
import { useQuickPlayStore, DEFAULT_SELECTION } from "../../src/features/quick-play";
import {
  describeActiveSession,
  resumeTargetFor,
  selectActiveSession,
  useActiveSessionStore,
} from "../../src/features/table";
import {
  describeRecoveryGrant,
  formatTimeRemaining,
  selectBalance,
  selectRecoveryGrant,
  useWalletStore,
} from "../../src/features/wallet";
import { useLevelStore } from "../../src/features/stats/level-store";

/** The four assistance modes, in the specification's own order. */
const ASSISTANCE: readonly { id: AssistanceMode; label: string; detail: string }[] = [
  { id: "play", label: "Play", detail: "No guidance during the hand." },
  { id: "learn", label: "Learn", detail: "The recommended play is shown before you choose." },
  { id: "analysis", label: "Analysis", detail: "Expected value for every legal action." },
  { id: "challenge", label: "Challenge", detail: "No hint before you act." },
];

/**
 * Learn and Analysis put the answer on screen before the choice, which the
 * specification excludes from the ranked accuracy board. Said here, before the
 * choice is made, rather than discovered later from a board a player is missing
 * from.
 */
function countsTowardsAccuracy(assistance: AssistanceMode): boolean {
  return assistance === "play" || assistance === "challenge";
}

export default function QuickPlaySetup() {
  const walletStatus = useWalletStore((state) => state.status);
  const refreshWallet = useWalletStore((state) => state.refresh);
  const claimGrant = useWalletStore((state) => state.claim);
  const claiming = useWalletStore((state) => state.claiming);
  const grantNotice = useWalletStore((state) => state.grantNotice);

  const level = useLevelStore((state) => state.record);
  const loadLevel = useLevelStore((state) => state.load);

  const activeStatus = useActiveSessionStore((state) => state.status);
  const refreshActive = useActiveSessionStore((state) => state.refresh);

  const remembered = useQuickPlayStore((state) => state.remembered);
  const opening = useQuickPlayStore((state) => state.opening);
  const notice = useQuickPlayStore((state) => state.notice);
  const load = useQuickPlayStore((state) => state.load);
  const open = useQuickPlayStore((state) => state.open);

  /*
   * The remembered selection is the DEFAULT, not an initial state to copy in.
   *
   * Copying it in an effect once it loaded was the obvious shape and lints as
   * "calling setState synchronously within an effect can trigger cascading
   * renders" — correctly: the value arrives asynchronously and the copy would
   * re-render every screen that reads it. Deriving instead means the override
   * is null until the player touches something, and the remembered value shows
   * the moment it arrives with no second render of its own.
   */
  const [tierChoice, setTierChoice] = useState<TierId | null>(null);
  const [assistanceChoice, setAssistanceChoice] = useState<AssistanceMode | null>(null);
  const [now, setNow] = useState(() => new Date());

  const tier = tierChoice ?? remembered?.tier ?? DEFAULT_SELECTION.tier;
  const assistance = assistanceChoice ?? remembered?.assistance ?? DEFAULT_SELECTION.assistance;

  useEffect(() => {
    void load();
    void refreshWallet();
    void loadLevel();
    // Asked before the player can be refused, not only after. A seat held from
    // a killed session is exactly the state in which the balance on this screen
    // looks wrong, and it is the answer to why.
    void refreshActive();
  }, [load, refreshWallet, loadLevel, refreshActive]);

  // A ticking clock, so a cooldown countdown actually advances.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  /*
   * Derived with `useMemo` from subscribed state, never by calling a store
   * getter during render — under the React Compiler that freezes the value.
   */
  const balance = useMemo(() => selectBalance(walletStatus), [walletStatus]);
  const grant = useMemo(() => selectRecoveryGrant(walletStatus, now), [walletStatus, now]);
  /*
   * The seat the player already holds, if any.
   *
   * `open()` refuses with SESSION_ALREADY_ACTIVE when one exists, and used to
   * answer "leave that table first" — advice that could not be followed,
   * because the game id had reached this client once and was gone. The chips
   * were stranded for good. This is the way back.
   */
  const active = useMemo(() => selectActiveSession(activeStatus), [activeStatus]);
  const playerLevel = level?.level ?? 1;

  const selected = useMemo(
    () => TABLE_TIERS.find((candidate) => candidate.id === tier) ?? TABLE_TIERS[0]!,
    [tier],
  );

  const locked = playerLevel < selected.unlockLevel;
  const affordable = balance === null || balance >= selected.buyIn;
  /** The best tier this balance can actually sit at, or null when none can. */
  const cheaperTier = useMemo(() => {
    if (balance === null) return null;
    return (
      [...TABLE_TIERS]
        .filter((candidate) => candidate.buyIn <= balance && playerLevel >= candidate.unlockLevel)
        .sort((a, b) => b.buyIn - a.buyIn)[0] ?? null
    );
  }, [balance, playerLevel]);

  const signedOut = walletStatus.kind === "signed-out";
  const unconfigured = walletStatus.kind === "not-configured";

  async function deal(): Promise<void> {
    const opened = await open({ tier, assistance });
    if (!opened) return;
    router.replace({
      pathname: "/table/[gameId]",
      params: { gameId: opened.gameId, seatId: opened.seatId },
    });
  }

  /*
   * "Guest Quick Play should transparently redirect to equivalent local
   * Practice rather than pretending to alter a global wallet." Offered rather
   * than performed, because a screen that navigated away on its own would be
   * indistinguishable from a broken button.
   */
  if (signedOut || unconfigured) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <BackBar label="Back to Play" />
        <ScrollView contentContainerStyle={styles.content}>
          <SurfaceCard>
            <AppText variant="sectionTitle">Practice plays the same game</AppText>
            <AppText variant="body" color="textSecondary">
              {signedOut
                ? "Quick Play uses your global chip balance, so it needs an account. Practice deals the identical rules from the identical engine and needs nothing at all."
                : walletStatus.message}
            </AppText>
          </SurfaceCard>
          <Button label="Play Practice" onPress={() => router.replace("/game")} testID="quick-practice" />
          {signedOut ? (
            <Button
              label="Create an account"
              variant="quiet"
              onPress={() => router.push("/auth/sign-up")}
              testID="quick-sign-up"
            />
          ) : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <BackBar label="Back to Play" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <SurfaceCard>
          <AppText variant="overline" color="textSecondary">
            Your balance
          </AppText>
          <AppText variant="pageTitle" numeric testID="quick-balance">
            {balance === null ? "—" : formatChips(balance)}
          </AppText>
          <AppText variant="caption" color="textSecondary">
            The buy-in leaves your wallet when the table opens and the remainder comes back when
            you leave. Nothing is spent by looking.
          </AppText>
        </SurfaceCard>

        {/*
          * Inert card, Button inside it: a labelled `Pressable` replaces the
          * text of everything within it in the iOS accessibility tree.
          */}
        {active ? (
          <SurfaceCard testID="quick-resume-card">
            <AppText variant="sectionTitle">You are still at a table</AppText>
            <AppText variant="body" color="textSecondary">
              {describeActiveSession(active)}
            </AppText>
            <Button
              label="Return to your table"
              onPress={() => router.replace(resumeTargetFor(active) as never)}
              testID="quick-resume"
            />
          </SurfaceCard>
        ) : null}

        <AppText variant="sectionTitle">Stakes</AppText>
        {TABLE_TIERS.map((candidate) => {
          const tierLocked = playerLevel < candidate.unlockLevel;
          const tooExpensive = balance !== null && balance < candidate.buyIn;
          return (
            <Pressable
              key={candidate.id}
              onPress={() => setTierChoice(candidate.id as TierId)}
              disabled={tierLocked}
              accessibilityRole="radio"
              accessibilityState={{ selected: tier === candidate.id, disabled: tierLocked }}
              accessibilityLabel={`${candidate.label}, buy-in ${candidate.buyIn} chips`}
              testID={`quick-tier-${candidate.id}`}
              style={[
                styles.tier,
                tier === candidate.id ? styles.tierSelected : null,
                tierLocked ? styles.tierLocked : null,
              ]}
            >
              <View style={styles.tierHeader}>
                <AppText variant="bodyStrong" color={tierLocked ? "textSecondary" : "textPrimary"}>
                  {candidate.label}
                </AppText>
                <AppText variant="bodyStrong" numeric color={tooExpensive ? "warning" : "textPrimary"}>
                  {formatChips(candidate.buyIn)}
                </AppText>
              </View>
              <AppText variant="caption" color="textSecondary">
                {`Bets ${formatChips(candidate.minBet)}–${formatChips(candidate.maxBet)}, in tens`}
              </AppText>
              {tierLocked ? (
                <AppText variant="caption" color="textSecondary">
                  {`Unlocks at level ${candidate.unlockLevel}. You are level ${playerLevel}.`}
                </AppText>
              ) : null}
            </Pressable>
          );
        })}

        <AppText variant="sectionTitle">Assistance</AppText>
        {ASSISTANCE.map((mode) => (
          <Pressable
            key={mode.id}
            onPress={() => setAssistanceChoice(mode.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: assistance === mode.id }}
            accessibilityLabel={`${mode.label}. ${mode.detail}`}
            testID={`quick-assistance-${mode.id}`}
            style={[styles.tier, assistance === mode.id ? styles.tierSelected : null]}
          >
            <AppText variant="bodyStrong">{mode.label}</AppText>
            <AppText variant="caption" color="textSecondary">
              {mode.detail}
            </AppText>
          </Pressable>
        ))}

        {!countsTowardsAccuracy(assistance) ? (
          <UnavailableNote>
            Learn and Analysis show the answer before you choose, so these hands do not count
            towards the strategy-accuracy leaderboard. Everything else — chips, XP, statistics —
            counts exactly as it always does.
          </UnavailableNote>
        ) : null}

        {/*
          Cannot afford it. Three ways out, and not one of them is a purchase.
        */}
        {!affordable ? (
          <SurfaceCard>
            <AppText variant="sectionTitle">Not enough for this table</AppText>
            <AppText variant="body" color="textSecondary">
              {`${selected.label} needs ${formatChips(selected.buyIn)} and you have ${formatChips(balance ?? 0)}.`}
            </AppText>

            {cheaperTier ? (
              <Button
                label={`Play ${cheaperTier.label} instead — ${formatChips(cheaperTier.buyIn)}`}
                variant="secondary"
                onPress={() => setTierChoice(cheaperTier.id as TierId)}
                testID="quick-lower-tier"
              />
            ) : null}

            {grant?.eligible ? (
              <Button
                label={claiming ? "Requesting…" : "Claim a recovery grant"}
                onPress={() => void claimGrant()}
                disabled={claiming}
                testID="quick-recovery-grant"
              />
            ) : grant ? (
              <AppText variant="caption" color="textSecondary" testID="quick-grant-status">
                {grant.blockedBy.includes("COOLDOWN") && grant.availableAt
                  ? `Another recovery grant in ${formatTimeRemaining(grant.msUntilAvailable)}.`
                  : describeRecoveryGrant(grant)}
              </AppText>
            ) : null}

            <Button
              label="Play Practice instead"
              variant="quiet"
              onPress={() => router.replace("/game")}
              testID="quick-practice-fallback"
            />
          </SurfaceCard>
        ) : null}

        {grantNotice ? (
          <AppText variant="caption" color="textSecondary" testID="quick-grant-notice">
            {grantNotice}
          </AppText>
        ) : null}

        <Button
          label={opening ? "Dealing…" : `Deal — ${formatChips(selected.buyIn)} buy-in`}
          onPress={() => void deal()}
          disabled={opening || locked || !affordable}
          testID="quick-deal"
        />

        {notice ? (
          <AppText variant="caption" color="textSecondary" testID="quick-notice">
            {notice}
          </AppText>
        ) : null}
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
  },
  tier: {
    padding: spacing.md,
    gap: spacing.xs,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    minHeight: 64,
    justifyContent: "center",
  },
  tierSelected: { borderColor: colors.accent, borderWidth: 2 },
  tierLocked: { opacity: 0.5 },
  tierHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
});
