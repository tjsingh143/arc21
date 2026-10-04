/**
 * Profile.
 *
 * Level and XP are SERVER-OWNED, and this screen reads them rather than
 * computing them: `my_level_progress` derives a level from stored XP, so there
 * is no arithmetic here that could disagree with the leaderboards.
 *
 * There is deliberately no "Level 1, 0 / 500 XP" fallback. A zero is a value,
 * and a value nobody earned asserts the app is keeping score of something it is
 * not. A guest, and a signed-in player whose progression could not be read, are
 * told which of those they are.
 *
 * That mattered more than it looks. Until this phase's audit, `hasAccount` was
 * the literal `false` — written when there genuinely was no sign-in, and never
 * revisited once accounts, XP and the level curve shipped. Every signed-in
 * player saw the guest profile, and the level bar could not appear for anybody.
 *
 * What this device knows on its own is still shown either way: strategy accuracy
 * from practice decisions, hands played, and career stars earned locally.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle, Path } from "react-native-svg";

import { getSessionStorageDurability, subscribeSessionStorageDurability } from "../../src/lib/supabase/secure-session-storage";
import { ConnectPlayerButton } from "../../src/components/ui/ConnectPlayerButton";
import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { colors, layout, radius, spacing } from "../../src/design/tokens";
import { formatChips } from "../../src/design/typography";
import { AccuracyRing, StatRow } from "../../src/features/stats/charts";
import {
  describeProgressionUnavailable,
  summariseProfile,
  type ProfileIdentity,
} from "../../src/features/stats/profile";
import { describeSample, formatPercent, sampleCaveat } from "../../src/features/stats/rate";
import { useLevelStore } from "../../src/features/stats/level-store";
import { useLoadoutStore } from "../../src/features/cosmetics";
import { CosmeticAvatar } from "../../src/features/cosmetics/art";
import { useAccountProfileStore, useAuthStore } from "../../src/features/auth";
import type { AccountProfile } from "../../src/features/auth/account-profile-store";
import { AuthField } from "../../src/features/auth/auth-ui";
import { USERNAME_MAX_LENGTH } from "../../src/features/auth/credentials";
import {
  changedFields,
  DISPLAY_NAME_MAX_LENGTH,
  hasChanges,
  RENAME_LIMIT_NOTE,
  validateDisplayName,
  validateUsername,
} from "../../src/features/auth/profile-rename";
import { useCompetitionStore } from "../../src/features/stats/competition-store";
import { usePracticeStore } from "../../src/features/practice/practice-store";
import { useCareerProgress } from "../../src/features/career/use-career-progress";
import { TOTAL_CAREER_STARS } from "../../shared/career/nodes.js";
import { totalStars } from "../../shared/career/progress.js";
import { CHIPS_NOT_MONEY_FOOTER } from "../../src/features/settings/fair-play-facts";

export default function ProfileScreen() {
  const durability = useSyncExternalStore(subscribeSessionStorageDurability, getSessionStorageDurability);
  const stats = usePracticeStore((state) => state.stats);
  const hydrate = usePracticeStore((state) => state.hydrate);
  const hydrated = usePracticeStore((state) => state.hydrated);

  // Same reason as Home and Statistics: the record is on disk, and a profile
  // that reports an empty one because it never read it is simply wrong.
  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const { progress, ready } = useCareerProgress();

  const session = useAuthStore((state) => state.session);
  const accountProfile = useAccountProfileStore((state) => state.profile);
  const loadAccountProfile = useAccountProfileStore((state) => state.load);
  const competitionRecord = useCompetitionStore((state) => state.record);
  const loadCompetition = useCompetitionStore((state) => state.load);
  const authHydrated = useAuthStore((state) => state.hydrated);
  const hydrateAuth = useAuthStore((state) => state.hydrate);
  const levelRecord = useLevelStore((state) => state.record);
  const loadLevel = useLevelStore((state) => state.load);

  useEffect(() => {
    if (!authHydrated) void hydrateAuth();
  }, [authHydrated, hydrateAuth]);

  const avatarKey = useLoadoutStore((state) => state.loadout.avatarKey);
  const loadLoadout = useLoadoutStore((state) => state.load);

  // Re-read on every change of session: signing out must empty this screen, and
  // a level left over from a previous account is somebody else's figure. The
  // loadout follows the same rule — an equipped avatar belongs to an account.
  useEffect(() => {
    if (authHydrated) {
      void loadLevel();
      void loadLoadout();
    }
    void loadAccountProfile();
    void loadCompetition();
  }, [
    authHydrated,
    session?.account.userId,
    loadLevel,
    loadLoadout,
    loadAccountProfile,
    loadCompetition,
  ]);

  const profile = summariseProfile({
    stats,
    careerStars: { earned: totalStars(progress), available: TOTAL_CAREER_STARS },
    hasAccount: session !== null,
    /*
     * The profile row's own fields, not the email.
     *
     * This read `session.account.email` — the email address, in the largest
     * type on the screen. `public.profiles` carries a server-normalised
     * `display_name` and `username`, both put through the reserved-name and
     * profanity filter, and the specification's hierarchy is
     * "Avatar / Display name / @username".
     */
    displayName: accountProfile?.displayName ?? null,
    username: accountProfile?.username ?? null,
    progression: levelRecord,
    tournamentWins: competitionRecord?.tournamentWins ?? null,
  });

  const { identity, headline, progression } = profile;

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={{ paddingHorizontal: layout.screenPadding }}>
        <BackBar />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.identity}>
          <Avatar identity={identity} avatarKey={avatarKey} />
          <View style={styles.identityText}>
            <AppText variant="pageTitle">{identity.displayName}</AppText>
            <AppText variant="caption" color="textSecondary">
              {identity.detail}
            </AppText>
          </View>
        </View>

        {!session ? <SurfaceCard><ConnectPlayerButton /><Button label="Recover an existing player" variant="quiet" onPress={() => router.push("/(auth)/sign-in")} /></SurfaceCard> : null}
        {session && durability === "unavailable" ? <UnavailableNote>This device could not save your player credentials securely. Access may be lost after closing the app. Add a recovery email to keep this player.</UnavailableNote> : null}
        {session?.account.isAnonymous ? <SurfaceCard>
          <AppText variant="bodyStrong">Your player, automatically connected</AppText>
          <AppText variant="caption" color="textSecondary">Keep playing with this identity. An optional recovery email lets you keep it if you lose this device’s credentials or move to another device.</AppText>
          <Button label="Secure your player" variant="secondary" onPress={() => router.push("/(auth)/create-account")} />
          <Button label="Sign in to an existing player" variant="quiet" onPress={() => router.push("/(auth)/sign-in")} />
        </SurfaceCard> : null}
        {/*
          THE DOOR THAT HAD NO HANDLE ON THE INSIDE.

          `guard_profile_username`, `normalise_profile_display_name`, the unique
          key and TWO rate-limit policies have guarded renaming since phase 3 —
          `docs/AUDIT.md` records the 30-day limit being measured over HTTP —
          and nothing in this app had ever written either column after signup.
          A player was stuck with whatever handle the signup form derived.

          Only for a signed-in player, because there is no row to change
          otherwise. A guest sees the account card further down instead.
        */}
        {accountProfile ? (
          /*
            KEYED ON THE STORED VALUES, which is how the drafts stay in step
            with the server without a `setState` inside an effect — the pattern
            the React Compiler lint rejects, and rightly: it schedules a second
            render pass on every change of the row.

            A successful save changes the row, so this remounts with the new
            name already in the fields. A REFUSED one does not, so the refusal
            stays on screen with what the player typed still in place.
          */
          <EditIdentityCard
            key={`${accountProfile.userId}:${accountProfile.displayName}:${accountProfile.username}`}
            profile={accountProfile}
          />
        ) : null}

        {/* Level and XP: absent, and the screen says why rather than showing a
            level the player has not earned. */}
        {progression.status === "unavailable" ? (
          <SurfaceCard>
            <AppText variant="bodyStrong">
              {describeProgressionUnavailable(progression.reason).title}
            </AppText>
            <UnavailableNote>
              {describeProgressionUnavailable(progression.reason).body}
            </UnavailableNote>
          </SurfaceCard>
        ) : null}

        <SurfaceCard
          onPress={() => router.push("/stats")}
          accessibilityLabel={`Your statistics. Strategy accuracy ${headline.accuracy} per cent, unaided.`}
          accessibilityHint="Accuracy, play and decision behaviour in full"
        >
          <View style={styles.ringRow}>
            <AccuracyRing
              value={headline.accuracy}
              caption="unaided"
              label="Strategy accuracy, unaided"
              size={104}
            />
            <View style={styles.ringSide}>
              <AppText variant="overline" color="textSecondary">
                Strategy accuracy
              </AppText>
              <AppText variant="caption" color="textSecondary">
                {headline.accuracy.denominator === 0
                  ? "Measured on decisions made with no recommendation on screen. You have not made one yet."
                  : `From ${describeSample(headline.accuracy.denominator, "decision")} made with no recommendation on screen.`}
              </AppText>
              {sampleCaveat(headline.accuracy.denominator) ? (
                <AppText variant="caption" color="warning">
                  {sampleCaveat(headline.accuracy.denominator)}
                </AppText>
              ) : null}
            </View>
          </View>

          <View style={styles.divider} />

          <StatRow
            label="Including hinted decisions"
            value={formatPercent(headline.accuracyIncludingAided)}
            detail={describeSample(headline.accuracyIncludingAided.denominator, "decision")}
            tone="textSecondary"
          />
          <StatRow label="Practice hands played" value={formatChips(headline.handsPlayed)} />
          {/*
            Tournament wins, from the server. Absent — an em dash — rather than
            zero when it could not be read: a zero is a value, and this screen's
            whole discipline is that no number appears unless somebody earned it.
          */}
          <StatRow
            label="Tournament wins"
            value={headline.tournamentWins === null ? "—" : String(headline.tournamentWins)}
          />
          <StatRow
            label="Career stars"
            value={
              ready
                ? `${headline.careerStars.earned} / ${headline.careerStars.available} ★`
                : "—"
            }
            detail={ready ? "Earned on this device" : "Loading your progress…"}
          />
        </SurfaceCard>

        {/*
          Accuracy, not win rate. A profile headlined by win percentage would be
          reporting the shoe's behaviour as if it were the player's skill.
        */}
        <AppText variant="caption" color="textDisabled">
          Accuracy is the measure here, not win rate. Blackjack results over a few
          hundred hands are dominated by luck — you can play every hand correctly
          and still lose — so a win percentage would say more about the cards than
          about you.
        </AppText>

        {/*
          TWO ROWS OF TWO, not four across.

          `Button` carries `flex: 1`, so four in one row each got a quarter of a
          393pt screen — about 74pt before padding — and `numberOfLines={2}`
          then split the labels mid-word: "Statist / ics", "Invent / ory",
          "Friend / s", "Settin / gs". At the DEFAULT text size, which is worse
          than the Dynamic Type case CLAUDE.md already records for the action
          dock: that one only breaks at the largest setting.

          `flexWrap` would not have fixed it. A `flex: 1` child has a flex-basis
          of 0, so it never overflows its line and never wraps — it just shrinks
          further. The row count is the thing that had to change.
        */}
        <View style={styles.actions}>
          <Button label="Statistics" onPress={() => router.push("/stats")} />
          <Button
            label="Inventory"
            variant="secondary"
            testID="profile-inventory"
            accessibilityHint="Avatars, card backs and table themes you have earned"
            onPress={() => router.push("/profile/inventory")}
          />
        </View>
        <View style={styles.actions}>
          {/*
            The Social TAB, not a `/friends` route — there is not one. Friends,
            requests and blocks all live on `app/(tabs)/social.tsx`, and the
            route contract forbids a dead link, so this names the screen that
            exists rather than the one the specification's button label implies.
          */}
          <Button
            label="Friends"
            variant="secondary"
            onPress={() => router.push("/(tabs)/social")}
            testID="profile-friends"
          />
          <Button
            label="Settings"
            variant="secondary"
            onPress={() => router.push("/settings")}
          />
        </View>

        <SurfaceCard>
          <AppText variant="bodyStrong">Your data</AppText>
          <AppText variant="body" color="textSecondary">
            Practice results and settings stay on this device. Your online
            player’s chips, progression, statistics, friends and leaderboard
            standing live on the server and are checked there.
          </AppText>
        </SurfaceCard>

        <Button label="Back" variant="quiet" onPress={() => router.back()} />

        <AppText variant="caption" color="textDisabled" align="center">
          {CHIPS_NOT_MONEY_FOOTER}
        </AppText>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Change your display name and your handle.
 *
 * TWO FIELDS, ONE SAVE, and the limits stated BEFORE the player commits rather
 * than discovered by hitting them. A handle can be changed once every thirty
 * days; a limit somebody learns about by tripping it is a trap.
 *
 * The card renders the SERVER's values, not the draft, once a save succeeds:
 * both columns are normalised by triggers — the handle is lowercased, the
 * display name sanitised — so echoing what was typed would show a value that
 * does not exist. `rename` re-reads the row for exactly that reason.
 *
 * Nothing is validated here as a security control. `credentials.ts` says the
 * same of its own rules and is right to: the checks below only stop a typo
 * spending a thirty-day budget on a round trip the server would refuse.
 */
function EditIdentityCard({ profile }: { profile: AccountProfile }) {
  const rename = useAccountProfileStore((state) => state.rename);

  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [username, setUsername] = useState(profile.username);
  const [busy, setBusy] = useState(false);
  /*
   * Errors only. A success needs no word: the card closes and renders the
   * SERVER's new name, which is stronger evidence than the string "Saved" and
   * cannot disagree with what was actually stored.
   */
  const [refusal, setRefusal] = useState<string | null>(null);

  const request = changedFields({
    current: { displayName: profile.displayName, username: profile.username },
    draft: { displayName, username },
  });

  const displayNameError =
    request.displayName === undefined ? undefined : validateDisplayName(displayName);
  const usernameError = request.username === undefined ? undefined : validateUsername(username);
  const canSave = hasChanges(request) && !displayNameError && !usernameError && !busy;

  async function save(): Promise<void> {
    setBusy(true);
    setRefusal(null);
    const outcome = await rename(request);
    setBusy(false);
    if (outcome.ok) {
      setOpen(false);
      return;
    }
    setRefusal(outcome.message);
  }

  if (!open) {
    return (
      <SurfaceCard>
        <AppText variant="bodyStrong">Your name</AppText>
        <AppText variant="body" color="textSecondary">
          {`${profile.displayName} · @${profile.username}`}
        </AppText>
        <Button
          label="Edit name"
          variant="secondary"
          size="medium"
          testID="profile-edit-name"
          onPress={() => {
            setRefusal(null);
            setOpen(true);
          }}
        />
      </SurfaceCard>
    );
  }

  return (
    <SurfaceCard>
      <AppText variant="bodyStrong">Your name</AppText>
      <AuthField
        label="Display name"
        value={displayName}
        onChangeText={setDisplayName}
        error={displayNameError}
        editable={!busy}
        maxLength={DISPLAY_NAME_MAX_LENGTH}
        testID="profile-display-name"
      />
      <AuthField
        label="Handle"
        value={username}
        onChangeText={setUsername}
        error={usernameError}
        editable={!busy}
        maxLength={USERNAME_MAX_LENGTH}
        testID="profile-username"
      />
      <AppText variant="caption" color="textDisabled">
        {RENAME_LIMIT_NOTE}
      </AppText>
      {refusal ? (
        <AppText variant="caption" color="danger" testID="profile-name-refusal">
          {refusal}
        </AppText>
      ) : null}
      <View style={styles.actions}>
        <Button
          label="Cancel"
          variant="quiet"
          size="medium"
          disabled={busy}
          onPress={() => {
            setDisplayName(profile.displayName);
            setUsername(profile.username);
            setRefusal(null);
            setOpen(false);
          }}
        />
        <Button
          label={busy ? "Saving…" : "Save"}
          size="medium"
          disabled={!canSave}
          pending={busy}
          testID="profile-save-name"
          onPress={() => void save()}
        />
      </View>
    </SurfaceCard>
  );
}

/**
 * The avatar.
 *
 * A guest gets the same anonymous glyph the header uses, not a generated
 * identicon: a distinctive auto-generated mark reads as an identity the player
 * was given, when in fact there is no identity here at all.
 *
 * An account shows its EQUIPPED avatar — the loadout store's answer, which is
 * the default House Dealer mark until the player equips something else in
 * Inventory.
 */
function Avatar({
  identity,
  avatarKey,
}: {
  identity: ProfileIdentity;
  avatarKey: string;
}) {
  if (identity.kind !== "guest") {
    return (
      <CosmeticAvatar
        assetKey={avatarKey}
        size={72}
        accessibilityLabel={`Profile picture for ${identity.displayName}`}
      />
    );
  }
  return (
    <View style={styles.avatar} accessible accessibilityLabel="Player profile picture">
      <Svg width={34} height={34} viewBox="0 0 24 24">
        <Circle cx="12" cy="9" r="3.4" stroke={colors.textSecondary} strokeWidth={1.6} fill="none" />
        <Path
          d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"
          stroke={colors.textSecondary}
          strokeWidth={1.6}
          fill="none"
          strokeLinecap="round"
        />
      </Svg>
    </View>
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
  ringRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
  },
  ringSide: { flex: 1, gap: spacing.xs },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
  },
  actions: {
    flexDirection: "row",
    gap: spacing.md,
  },
});
