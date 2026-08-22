/**
 * `arc21://auth/recovery` — the password-reset deep link.
 *
 * A REAL directory, not the `(auth)` route GROUP that `sign-in.tsx` and
 * `create-account.tsx` live in — a group's parenthesised segment is stripped
 * from its URL, so `/(auth)/sign-in` is reached at `/sign-in`. This route
 * needs a literal, stable path because it is registered by exact string with
 * Supabase (`additional_redirect_urls` in `supabase/config.toml`) and minted
 * into every reset email by `PASSWORD_RECOVERY_REDIRECT_URL` in
 * `supabase-auth-adapter.ts` — nothing here can rename it unilaterally.
 *
 * The same discipline as `app/room/[code].tsx` applies: the link is an
 * address, not a key. `code` is a one-time PKCE authorization code GoTrue
 * issues after verifying the emailed OTP — this screen never reads a
 * password, a userId or a session out of the URL, only the code, and the
 * server is what decides whether it is still good.
 *
 * A link this screen cannot use is refused locally when that is knowable
 * without a request (no code at all — the same "malformed" discipline the
 * room invite uses), and otherwise by the server's own answer to the code
 * exchange, which fails closed as `RECOVERY_LINK_INVALID` rather than
 * quietly signing nobody in.
 */

import { useCallback, useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { colors, layout, spacing } from "../../src/design/tokens";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, validatePassword } from "../../src/features/auth/credentials";
import { AuthField, AuthStatusBanner } from "../../src/features/auth/auth-ui";
import { useAuthStore } from "../../src/features/auth/auth-store";

export default function PasswordRecovery() {
  const params = useLocalSearchParams<{
    code?: string;
    error?: string;
    error_description?: string;
  }>();

  const hydrate = useAuthStore((state) => state.hydrate);
  const hydrated = useAuthStore((state) => state.hydrated);
  const configured = useAuthStore((state) => state.configured);
  const completePasswordReset = useAuthStore((state) => state.completePasswordReset);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  // The password lives here and nowhere else — same rule as sign-in.tsx.
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const code = typeof params.code === "string" && params.code.length > 0 ? params.code : null;
  const linkError =
    typeof params.error === "string"
      ? (params.error_description ?? "This reset link is invalid or has expired.")
      : null;

  const submit = useCallback(async () => {
    if (code === null || busy) return;

    const passwordError = validatePassword(password);
    if (passwordError) {
      setMessage(passwordError);
      return;
    }
    if (password !== confirm) {
      setMessage("Those two passwords do not match.");
      return;
    }

    setBusy(true);
    setMessage(null);
    const failure = await completePasswordReset(code, password);
    setPassword("");
    setConfirm("");
    setBusy(false);

    if (failure) {
      setMessage(failure.message);
      return;
    }
    // The adapter's own onAuthStateChange has already adopted the session —
    // nothing to do here but leave.
    setDone(true);
  }, [code, busy, password, confirm, completePasswordReset]);

  useEffect(() => {
    if (!done) return;
    router.replace("/(tabs)/home");
  }, [done]);

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.titleBlock}>
            <AppText variant="pageTitle">Reset your password</AppText>
          </View>

          {!configured ? (
            <UnavailableNote>
              This build has no server configured, so accounts are unavailable.
            </UnavailableNote>
          ) : linkError !== null ? (
            <SurfaceCard>
              <AppText variant="bodyStrong" testID="recovery-link-error">
                {linkError}
              </AppText>
              <AppText variant="caption" color="textSecondary">
                Request a new reset link from Sign in.
              </AppText>
              <Button
                label="Go to Sign in"
                onPress={() => router.replace("/(auth)/sign-in")}
                style={styles.cta}
              />
            </SurfaceCard>
          ) : code === null ? (
            // No request sent: an address this app cannot use is not a reason
            // to ask the server anything, the same rule `app/room/[code].tsx`
            // applies to a malformed table code.
            <UnavailableNote>
              That link is missing its reset code. Request a new one from Sign in.
            </UnavailableNote>
          ) : (
            <SurfaceCard>
              <AuthField
                label="New password"
                value={password}
                onChangeText={setPassword}
                secure
                autoComplete="new-password"
                textContentType="newPassword"
                editable={!busy}
                maxLength={PASSWORD_MAX_LENGTH}
                hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
                testID="recovery-password"
                returnKeyType="next"
              />
              <AuthField
                label="Confirm new password"
                value={confirm}
                onChangeText={setConfirm}
                secure
                autoComplete="new-password"
                textContentType="newPassword"
                editable={!busy}
                maxLength={PASSWORD_MAX_LENGTH}
                testID="recovery-confirm"
                returnKeyType="go"
                onSubmitEditing={() => void submit()}
              />

              <AuthStatusBanner message={message} tone={message === null ? "info" : "danger"} />

              <Button
                label="Set new password"
                onPress={() => void submit()}
                pending={busy}
                testID="recovery-submit"
                style={styles.cta}
              />
            </SurfaceCard>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  content: {
    padding: layout.screenPadding,
    paddingBottom: spacing.xxxl,
    gap: spacing.lg,
    maxWidth: layout.maxTableWidth,
    width: "100%",
    alignSelf: "center",
  },
  titleBlock: { gap: spacing.xs, paddingTop: spacing.lg },
  cta: { marginTop: spacing.md },
});
