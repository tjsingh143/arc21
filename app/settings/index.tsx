/**
 * Settings.
 *
 * Two honesty rules run through this screen:
 *
 *   1. **A control that changes nothing is a lie.** Where a preference has a
 *      live adapter — sound, haptics, assistance mode — it is wired to it and
 *      takes effect immediately. Where a preference is stored for a surface that
 *      does not read it yet, the section says so in plain words instead of
 *      letting the player believe they have changed something.
 *   2. **Anything needing a server is an explicit unavailable state**, never a
 *      disabled control with no explanation and never a fabricated one. There is
 *      the real auth store, so it describes the session that actually exists.
 *
 * Music defaults OFF and never autoplays. No music ships yet, so rather than a
 * switch that silences silence, the row states the position plainly.
 */

import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import Constants from "expo-constants";

import { useAuthStore } from "../../src/features/auth/auth-store";
import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { ScreenHeader } from "../../src/components/ui/ScreenHeader";
import { colors, layout, MIN_TOUCH_TARGET, radius, spacing } from "../../src/design/tokens";
import { useReduceMotion } from "../../src/design/motion";
import {
  ASSISTANCE_MODE_HINTS,
  ASSISTANCE_MODE_LABELS,
  ASSISTANCE_MODES,
  describeSettingsFailure,
  STATS_VISIBILITY_LABELS,
  STATS_VISIBILITY_NOTE,
  type StatsVisibility,
} from "../../src/features/settings/settings";
import { useSettings } from "../../src/features/settings/use-settings";
import { syncProfilePrivacy } from "../../src/features/settings/profile-privacy";
import { usePushRegistration } from "../../src/features/notifications";
import { applyDailyReminderPreference } from "../../src/lib/notifications/daily-reminder";
import { hasRoute } from "../../src/features/home/route-availability";
import { useRouteIndex } from "../../src/features/home/use-route-index";
import { usePracticeStore, type AssistanceMode } from "../../src/features/practice/practice-store";

export default function SettingsScreen() {
  const { settings, ready, failure, update, reset } = useSettings();
  const reduceMotion = useReduceMotion();
  const routes = useRouteIndex();

  const setPracticeMode = usePracticeStore((state) => state.setMode);
  const resetStats = usePracticeStore((state) => state.resetStats);

  const failureMessage = describeSettingsFailure(failure);
  const version = typeof Constants.expoConfig?.version === "string"
    ? Constants.expoConfig.version
    : null;

  function chooseAssistance(mode: AssistanceMode): void {
    void update({ defaultAssistanceMode: mode });
    // Applied to the table now, not only to the next one. The practice store
    // persists its mode with the session, so this survives a restart.
    setPracticeMode(mode);
  }

  /**
   * The visibility choice is stored locally AND carried to the profile row.
   *
   * It used to be stored only, which meant the control displayed the player's
   * answer back to them while `profiles.privacy` stayed at its default of
   * `public` for every account ever created. The write is best-effort: a guest
   * has no row to write, and a preference that blocks on the network is a
   * control that feels broken. `syncProfilePrivacy` also runs when a session
   * appears, which is what covers a choice made before signing in.
   */
  async function changeVisibility(visibility: StatsVisibility): Promise<void> {
    await update({ statsVisibility: visibility });
    await syncProfilePrivacy(visibility);
  }

  function confirmResetStatistics(): void {
    Alert.alert(
      "Reset practice statistics?",
      "This clears your accuracy, hands played and decision history on this device. Your chips and the hand in progress are not affected. It cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Reset", style: "destructive", onPress: () => resetStats() },
      ],
    );
  }

  function confirmResetSettings(): void {
    Alert.alert("Reset all settings?", "Every preference on this screen returns to its default.", [
      { text: "Cancel", style: "cancel" },
      { text: "Reset", style: "destructive", onPress: () => void reset() },
    ]);
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={{ paddingHorizontal: layout.screenPadding }}>
        <BackBar />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScreenHeader title="Settings" subtitle="Stored on this device." />

        {failureMessage ? <UnavailableNote>{failureMessage}</UnavailableNote> : null}

        {/* ------------------------------------------------------------ */}
        <Section title="Gameplay">
          <SurfaceCard>
            <AppText variant="bodyStrong">Assistance at the table</AppText>
            <AppText variant="caption" color="textSecondary">
              How much the table tells you before you act. Applied to Practice now
              and kept for the next table.
            </AppText>

            <View style={styles.choices}>
              {ASSISTANCE_MODES.map((mode) => (
                <Button
                  key={mode}
                  label={ASSISTANCE_MODE_LABELS[mode]}
                  size="medium"
                  variant={settings.defaultAssistanceMode === mode ? "primary" : "secondary"}
                  onPress={() => chooseAssistance(mode)}
                  accessibilityHint={ASSISTANCE_MODE_HINTS[mode]}
                  style={styles.choice}
                />
              ))}
            </View>
            <AppText variant="caption" color="textDisabled">
              {ASSISTANCE_MODE_HINTS[settings.defaultAssistanceMode]}
            </AppText>
          </SurfaceCard>

          <SurfaceCard>
            <ToggleRow
              label="Large card labels"
              detail="Bigger ranks and suits on the cards themselves."
              value={settings.largeCardLabels}
              disabled={!ready}
              onChange={(next) => void update({ largeCardLabels: next })}
            />
            <UnavailableNote>
              Saved on this device. No screen in this build reads it yet, so
              nothing changes on the table until one does.
            </UnavailableNote>
          </SurfaceCard>
        </Section>

        {/* ------------------------------------------------------------ */}
        <Section title="Audio">
          <SurfaceCard>
            <ToggleRow
              label="Sound effects"
              detail="Cards, chips and hand results."
              value={settings.soundEnabled}
              disabled={!ready}
              onChange={(next) => void update({ soundEnabled: next })}
            />
            <ToggleRow
              label="Haptics"
              detail="A short tap when a card lands or a hand settles."
              value={settings.hapticsEnabled}
              disabled={!ready}
              onChange={(next) => void update({ hapticsEnabled: next })}
            />

            <View style={styles.divider} />

            {/*
              A switch that silences silence would be theatre. No music ships,
              so the row states the position instead of pretending to control it.
            */}
            <StaticRow label="Music" value="Off" />
            <AppText variant="caption" color="textDisabled">
              No music ships in this build. If it ever does it will default to off
              and will never start on its own.
            </AppText>

            <AppText variant="caption" color="textDisabled">
              Every cue is generated from scratch by a script in this repository —
              nothing sampled or borrowed — and the silent switch on your device
              is respected. Other apps keep playing.
            </AppText>
          </SurfaceCard>
        </Section>

        {/* ------------------------------------------------------------ */}
        <Section title="Accessibility">
          <SurfaceCard>
            <StaticRow
              label="Reduce Motion"
              value={reduceMotion ? "On, from your device" : "Off, from your device"}
            />
            <AppText variant="caption" color="textSecondary">
              {"Arc 21 follows your system Reduce Motion setting. Change it in " +
                "your device's accessibility settings and animations here shorten " +
                "to a crossfade."}
            </AppText>

            <View style={styles.divider} />

            <ToggleRow
              label="Always reduce motion"
              detail="Shorten animations even when your device is not asking for it."
              value={settings.reducedMotion}
              disabled={!ready}
              onChange={(next) => void update({ reducedMotion: next })}
            />
            <ToggleRow
              label="Increased contrast"
              detail="Stronger borders and brighter secondary text."
              value={settings.increasedContrast}
              disabled={!ready}
              onChange={(next) => void update({ increasedContrast: next })}
            />
            <ToggleRow
              label="Larger table text"
              detail="Bigger totals and labels at the table."
              value={settings.largerTableText}
              disabled={!ready}
              onChange={(next) => void update({ largerTableText: next })}
            />
          </SurfaceCard>
        </Section>

        {/* ------------------------------------------------------------ */}
        <Section title="Notifications">
          <NotificationsSection />
        </Section>

        {/* ------------------------------------------------------------ */}
        <Section title="Privacy">
          <SurfaceCard>
            <AppText variant="bodyStrong">Where your data lives</AppText>
            <AppText variant="body" color="textSecondary">
              Practice results, settings and career stars stay on this device and
              are never uploaded. An account adds a chip balance, statistics,
              friends and leaderboard standing, which are recorded on the server
              because they have to be checked rather than trusted.
            </AppText>
            <AppText variant="caption" color="textDisabled">
              None of it is used to build an advertising profile of you, and
              nothing you do is sold.
            </AppText>
          </SurfaceCard>

          <SurfaceCard>
            <AppText variant="bodyStrong">Who can see your statistics</AppText>
            <View style={styles.choices}>
              {(Object.keys(STATS_VISIBILITY_LABELS) as StatsVisibility[]).map((visibility) => (
                <Button
                  key={visibility}
                  label={STATS_VISIBILITY_LABELS[visibility]}
                  size="medium"
                  variant={settings.statsVisibility === visibility ? "primary" : "secondary"}
                  onPress={() => void changeVisibility(visibility)}
                  disabled={!ready}
                  style={styles.choice}
                />
              ))}
            </View>
            <UnavailableNote>{STATS_VISIBILITY_NOTE}</UnavailableNote>
          </SurfaceCard>

          <SurfaceCard>
            <AppText variant="bodyStrong">Reset practice statistics</AppText>
            <AppText variant="body" color="textSecondary">
              Clears accuracy, hands played and your decision history on this
              device. Your chips and any hand in progress are left alone.
            </AppText>
            <Button
              label="Reset statistics"
              variant="danger"
              size="medium"
              onPress={confirmResetStatistics}
              accessibilityHint="Asks you to confirm first"
              style={styles.cta}
            />
          </SurfaceCard>
        </Section>

        {/* ------------------------------------------------------------ */}
        <Section title="Account">
          <AccountSection />
        </Section>

        {/* ------------------------------------------------------------ */}
        <Section title="About">
          <SurfaceCard>
            <LinkRow
              label="Fair Play"
              detail="How the shuffle works, in plain language."
              onPress={() => router.push("/settings/fair-play")}
            />
            {hasRoute(routes, "/learn/how-to-play") ? (
              <LinkRow
                label="How to Play"
                detail="The rules, end to end."
                onPress={() => router.push("/learn/how-to-play")}
              />
            ) : null}
            {hasRoute(routes, "/learn/strategy-guide") ? (
              <LinkRow
                label="Strategy Guide"
                detail="The full chart for these exact rules."
                onPress={() => router.push("/learn/strategy-guide")}
              />
            ) : null}
          </SurfaceCard>

          <SurfaceCard>
            <StaticRow label="Version" value={version ?? "Unknown"} />
            <AppText variant="caption" color="textSecondary">
              Arc 21 is a simulated card game. Virtual chips have no monetary
              value, cannot be purchased, and cannot be exchanged for money or
              prizes.
            </AppText>
          </SurfaceCard>

          <Button
            label="Reset all settings"
            variant="quiet"
            size="medium"
            onPress={confirmResetSettings}
            accessibilityHint="Asks you to confirm first"
          />
        </Section>

        <Button label="Back" variant="quiet" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * Sign-in state, and the two irreversible-ish things a player can do to it.
 *
 * This section used to say Arc 21 "has no sign-in yet", which stopped being
 * true when the auth screens landed and nobody came back to it. It now reads
 * the real store, so it cannot describe a build that no longer exists.
 */
function AccountSection() {
  const mode = useAuthStore((state) => state.mode);
  const session = useAuthStore((state) => state.session);
  const deleteAccount = useAuthStore((state) => state.deleteAccount);
  const signOut = useAuthStore((state) => state.signOut);
  const [busy, setBusy] = useState(false);

  if (mode !== "account" || session === null) {
    return (
      <SurfaceCard>
        <AppText variant="bodyStrong">Playing as a guest</AppText>
        <AppText variant="body" color="textSecondary">
          Practice, the strategy guide and drills all work without an account and
          stay on this device. An account adds a chip balance, career rewards and
          playing with friends.
        </AppText>
        <Button label="Sign in or create an account" onPress={() => router.push("/(auth)/sign-in")} />
      </SurfaceCard>
    );
  }

  const confirmDeletion = () => {
    /*
     * Two deliberate steps, and the destructive one is not the default button.
     * The specification asks for a deliberate confirmation; an OK/Cancel alert
     * where OK is the fast path is not that.
     */
    Alert.alert(
      "Delete your account?",
      "Your chips, career stars, statistics and friends are erased permanently. " +
        "This cannot be undone. Practice on this device is unaffected.",
      [
        { text: "Keep my account", style: "cancel" },
        {
          text: "Delete permanently",
          style: "destructive",
          onPress: () => {
            setBusy(true);
            void deleteAccount()
              .then((deleted) => {
                if (!deleted) {
                  // The store keeps the session when deletion is refused — the
                  // account still exists, and saying otherwise would be a lie.
                  Alert.alert(
                    "Account not deleted",
                    "Nothing was changed. If you are sitting at a table, leave it first and try again.",
                  );
                }
              })
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  };

  return (
    <SurfaceCard>
      <AppText variant="bodyStrong">Signed in</AppText>
      <AppText variant="body" color="textSecondary">
        {session.account.email ?? "Your account"}
      </AppText>
      {!session.account.emailConfirmed ? (
        <AppText variant="caption" color="warning">
          Email not confirmed yet.
        </AppText>
      ) : null}

      <Button
        label="Sign out"
        variant="secondary"
        disabled={busy}
        onPress={() => void signOut()}
      />
      <Button
        label={busy ? "Deleting…" : "Delete account"}
        variant="quiet"
        disabled={busy}
        testID="delete-account"
        onPress={confirmDeletion}
      />
      <AppText variant="caption" color="textDisabled">
        Deleting erases your chips, stars, statistics and friends for good.
      </AppText>
    </SurfaceCard>
  );
}

/**
 * Notifications.
 *
 * Every switch here reaches the server. The per-kind toggles are sent with the
 * device's registration and the sender pushes only what this device asked for,
 * so turning "Your turn" off changes what the queue does rather than what this
 * screen looks like.
 *
 * The master switch is also where permission is asked for — one of the four
 * moments the specification allows, and pointedly not onboarding.
 */
function NotificationsSection() {
  const { settings, ready, update } = useSettings();
  const unavailable = usePushRegistration((state) => state.unavailable);
  const busy = usePushRegistration((state) => state.busy);
  const enable = usePushRegistration((state) => state.enable);
  const disable = usePushRegistration((state) => state.disable);
  const sync = usePushRegistration((state) => state.sync);

  const setMaster = async (next: boolean) => {
    if (!next) {
      await update({ notificationsEnabled: false });
      await disable();
      // The daily reminder is scheduled on this device, so turning the master
      // switch off has to cancel it here — the server has nothing to stop.
      await applyDailyReminderPreference(false);
      return;
    }

    // Ask FIRST, and only record the preference if the OS agreed. A switch that
    // stays on while the system refuses is a switch that lies.
    const granted = await enable("settings-toggle", {
      ...settings,
      notificationsEnabled: true,
    });
    if (granted) await update({ notificationsEnabled: true });
  };

  const setKind = async (patch: Partial<typeof settings>) => {
    const next = { ...settings, ...patch };
    await update(patch);
    await sync(next);
    if (patch.notifyDailyChallenge !== undefined) {
      await applyDailyReminderPreference(patch.notifyDailyChallenge);
    }
  };

  return (
    <SurfaceCard>
      <ToggleRow
        label="Notifications"
        detail="Friend requests, table invites and tournament results."
        value={settings.notificationsEnabled}
        disabled={!ready || busy}
        onChange={(next) => void setMaster(next)}
      />

      <View style={styles.divider} />

      <ToggleRow
        label="Friends and invites"
        detail="Someone adds you, accepts you, or invites you to a table."
        value={settings.notifyFriendRequests}
        disabled={!ready || busy || !settings.notificationsEnabled}
        onChange={(next) => void setKind({ notifyFriendRequests: next })}
      />
      <ToggleRow
        label="Your turn"
        detail="A hand was played for you because the timer ran out."
        value={settings.notifyYourTurn}
        disabled={!ready || busy || !settings.notificationsEnabled}
        onChange={(next) => void setKind({ notifyYourTurn: next })}
      />
      <ToggleRow
        label="Daily Challenge"
        detail="One reminder each evening, scheduled on this device."
        value={settings.notifyDailyChallenge}
        disabled={!ready || busy || !settings.notificationsEnabled}
        onChange={(next) => void setKind({ notifyDailyChallenge: next })}
      />

      <AppText variant="caption" color="textDisabled">
        Tournament results always arrive when notifications are on: you entered
        one deliberately, and it announces itself once and settles once. Arc 21
        never sends anything to get you to come back.
      </AppText>

      {unavailable ? (
        <UnavailableNote>{unavailable}</UnavailableNote>
      ) : null}

      <Button
        label="Open notifications"
        variant="secondary"
        testID="settings-notifications"
        onPress={() => router.push("/notifications")}
      />
    </SurfaceCard>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <AppText variant="sectionTitle">{title}</AppText>
      {children}
    </View>
  );
}

/**
 * A switch row.
 *
 * The whole row IS the control — a `Pressable` carrying the switch role, with
 * the `Switch` inside it rendered as a non-interactive indicator.
 *
 * It did not used to be. The row was a plain `View` under a comment claiming
 * it was "the accessible control rather than just the switch, so the target
 * comfortably clears 48dp"; nothing about it was pressable, so the only target
 * was the iOS `Switch` — 51×31pt, UNDER the 48dp minimum in height — and
 * tapping the label did nothing at all. `minHeight: MIN_TOUCH_TARGET` on the
 * row sized a box that could not be tapped. Found by driving the Settings
 * screen with Maestro: all three accessibility taps reported COMPLETED and no
 * switch moved.
 */
function ToggleRow({
  label,
  detail,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  detail: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={() => onChange(!value)}
      disabled={disabled}
      style={styles.row}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={detail}
      accessibilityState={{ disabled, checked: value }}
    >
      <View style={styles.rowText}>
        <AppText variant="body" color={disabled ? "textDisabled" : "textPrimary"}>
          {label}
        </AppText>
        <AppText variant="caption" color="textSecondary">
          {detail}
        </AppText>
      </View>
      {/*
        `pointerEvents="none"` so the row's press is the single source of the
        change: a Switch that also handled its own toggle would fire twice
        where the two targets overlap, landing back on the original value.
      */}
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        trackColor={{ false: colors.surfaceSoft, true: colors.accentSoft }}
        thumbColor={value ? colors.accent : colors.textSecondary}
        ios_backgroundColor={colors.surfaceSoft}
      />
    </Pressable>
  );
}

/** A row that reports state the player cannot change here. */
function StaticRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant="body">{label}</AppText>
      <AppText variant="bodyStrong" color="textSecondary">
        {value}
      </AppText>
    </View>
  );
}

function LinkRow({
  label,
  detail,
  onPress,
}: {
  label: string;
  detail: string;
  onPress: () => void;
}) {
  return (
    <Button
      label={label}
      variant="secondary"
      size="medium"
      onPress={onPress}
      accessibilityHint={detail}
      style={styles.link}
    />
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
  },
  rowText: { flex: 1, gap: 2 },
  choices: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  choice: {
    flexGrow: 1,
    flexBasis: 96,
    paddingHorizontal: spacing.sm,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
  },
  link: {
    marginTop: spacing.sm,
    borderRadius: radius.small,
  },
  cta: { marginTop: spacing.md },
});
