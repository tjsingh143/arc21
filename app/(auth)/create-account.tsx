/** Optional recovery credentials for the SAME server player. No signup here. */
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText } from "../../src/components/ui/AppText";
import { BackBar } from "../../src/components/ui/BackBar";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard } from "../../src/components/ui/Card";
import { ConnectPlayerButton } from "../../src/components/ui/ConnectPlayerButton";
import { colors, layout, spacing } from "../../src/design/tokens";
import { AuthField, AuthStatusBanner } from "../../src/features/auth/auth-ui";
import { useAuthStore } from "../../src/features/auth/auth-store";
import type { AuthFailure } from "../../src/features/auth/auth-failure";
import { PASSWORD_MIN_LENGTH } from "../../src/features/auth/credentials";

export default function SecurePlayerScreen() {
  const userId = useAuthStore((state) => state.session?.account.userId ?? "offline");
  return <SecurePlayerForm key={userId} />;
}

function SecurePlayerForm() {
  const session = useAuthStore((state) => state.session);
  const start = useAuthStore((state) => state.startSecuring);
  const verify = useAuthStore((state) => state.verifySecuringEmail);
  const setSecuredPassword = useAuthStore((state) => state.setSecuredPassword);
  const [emailDraft, setEmail] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [done, setDone] = useState(false);
  const account = session?.account;
  const email = emailDraft ?? account?.pendingEmail ?? account?.email ?? "";
  const verified = account && !account.isAnonymous && account.emailConfirmed;
  const pendingEmail = account?.pendingEmail;
  async function perform(operation: () => Promise<AuthFailure | null>) {
    if (busy) return;
    setBusy(true); setFailure(null);
    const error = await operation();
    setFailure(error); setBusy(false);
    return error;
  }
  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <BackBar />
          <View style={styles.title}>
            <AppText variant="pageTitle">Secure your player</AppText>
            <AppText color="textSecondary">Add a way to recover this player or sign in on another device. Playing stays available either way.</AppText>
          </View>
          <SurfaceCard>
            <AppText variant="bodyStrong">{account?.username ? `@${account.username}` : "Your player"}</AppText>
            <AppText variant="caption" color="textSecondary">Your handle, wallet, progress and friends stay with this same player. Securing does not create another player or add chips.</AppText>
            <AppText variant="caption" color="textSecondary">Practice and settings stay on this device. Local chips and results never become server rewards.</AppText>
          </SurfaceCard>
          {!account ? <SurfaceCard><ConnectPlayerButton /><AppText color="textSecondary">Connect your player before adding recovery credentials.</AppText></SurfaceCard> : done ? (
            <SurfaceCard>
              <AppText variant="sectionTitle" testID="secure-complete">Your player is secured</AppText>
              <AppText color="textSecondary">Use your verified email and password to sign in on another device.</AppText>
              <Button label="Back to Profile" onPress={() => router.replace("/profile")} />
            </SurfaceCard>
          ) : verified ? (
            <SurfaceCard>
              <AppText variant="bodyStrong" testID="secure-email-verified">Email verified</AppText>
              <AppText color="textSecondary">{account.email}</AppText>
              <AppText variant="caption" color="textSecondary">You can now recover this player with an email reset link. Add a password for direct sign-in.</AppText>
              <AuthField label="Password" value={password} onChangeText={setPassword} secure autoComplete="new-password" textContentType="newPassword" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`} editable={!busy} testID="secure-password" />
              <AuthStatusBanner message={failure?.message ?? null} tone="danger" />
              <Button label="Save password" pending={busy} testID="secure-save-password" onPress={() => void perform(async () => {
                const error = await setSecuredPassword(password);
                setPassword(""); if (!error) setDone(true); return error;
              })} />
            </SurfaceCard>
          ) : (
            <SurfaceCard>
              <AuthField label="Recovery email" value={email} onChangeText={setEmail} keyboardType="email-address" autoComplete="email" maxLength={254} editable={!busy} testID="secure-email" />
              <Button label={pendingEmail ? "Send a new code" : "Send verification code"} pending={busy} testID="secure-send-code" onPress={() => void perform(() => start(email))} />
              {pendingEmail ? <>
                <AppText color="textSecondary" testID="secure-code-sent">Enter the six-digit code sent to {pendingEmail}. Keep playing while you wait.</AppText>
                <AuthField label="Verification code" value={code} onChangeText={setCode} keyboardType="number-pad" textContentType="oneTimeCode" maxLength={6} editable={!busy} testID="secure-code" />
                <Button label="Verify email" disabled={busy} testID="secure-verify" onPress={() => void perform(async () => {
                  const error = await verify(pendingEmail, code); setCode(""); return error;
                })} />
              </> : null}
              <AuthStatusBanner message={failure?.message ?? null} tone="danger" />
            </SurfaceCard>
          )}
          <Button label="Keep playing" variant="quiet" onPress={() => router.replace("/(tabs)/home")} />
          <Button label="Sign in to an existing player" variant="quiet" onPress={() => router.push("/(auth)/sign-in")} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background }, flex: { flex: 1 }, title: { gap: spacing.sm },
  content: { padding: layout.screenPadding, paddingBottom: spacing.xxxl, gap: spacing.lg, maxWidth: layout.maxTableWidth, width: "100%", alignSelf: "center" },
});
