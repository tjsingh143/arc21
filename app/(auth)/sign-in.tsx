/**
 * Sign in.
 *
 * Every state this screen can be in comes from `reduceAuthForm`, which is pure
 * and unit-tested: idle, validating, submitting, verification required, network
 * error, invalid credentials, rate limited. The screen renders them; it does not
 * invent them, and it cannot get into one the machine does not have.
 *
 * Three things are deliberate:
 *
 *   1. **The password lives in this component and nowhere else.** It is not in
 *      the store, not in the reducer, not in any value that could be serialised.
 *      There is no `console.log` in this file, and there is nothing to log.
 *   2. **The typed email survives a failure.** It is held in the store, and no
 *      transition clears it — a wrong password does not cost you your address.
 *   3. **No server is a sentence, not a broken form.** When the build has no
 *      Supabase configuration the fields are disabled and the reason is stated,
 *      rather than leaving a Sign In button that fails in an interesting way.
 */

import { useCallback, useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText } from "../../src/components/ui/AppText";
import { Button } from "../../src/components/ui/Button";
import { SurfaceCard, UnavailableNote } from "../../src/components/ui/Card";
import { colors, layout, spacing } from "../../src/design/tokens";
import { AuthField, AuthStatusBanner } from "../../src/features/auth/auth-ui";
import { authStateName, describeAuthStatus } from "../../src/features/auth/auth-machine";
import { useAuthStore } from "../../src/features/auth/auth-store";

export default function SignInScreen() {
  const hydrate = useAuthStore((state) => state.hydrate);
  const hydrated = useAuthStore((state) => state.hydrated);
  const configured = useAuthStore((state) => state.configured);
  const configurationMessage = useAuthStore((state) => state.configurationMessage);
  const form = useAuthStore((state) => state.form);
  const dispatch = useAuthStore((state) => state.dispatch);
  const setMode = useAuthStore((state) => state.setMode);
  const signIn = useAuthStore((state) => state.signIn);
  const requestPasswordReset = useAuthStore((state) => state.requestPasswordReset);
  const continueAsGuest = useAuthStore((state) => state.continueAsGuest);

  // The only place the password exists. Never lifted into shared state.
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  useEffect(() => {
    setMode("signIn");
  }, [setMode]);

  const state = authStateName(form.status);
  const busy = state === "submitting";

  useEffect(() => {
    if (form.status.kind !== "signedIn") return;
    /*
     * The one setState this screen makes from an effect, and it is deliberate.
     * The password is held here and nowhere else (see the note at the top of
     * this file); it is cleared the moment a session exists rather than left
     * in state until the unmount happens to land. The cascading render the
     * rule warns about is one render on a screen `router.replace` is already
     * replacing.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPassword("");
    router.replace("/(tabs)/home");
  }, [form.status.kind]);

  const submit = useCallback(() => {
    void signIn(password);
  }, [password, signIn]);

  const message = describeAuthStatus(form.status);
  const tone =
    state === "verificationRequired" || state === "resetLinkSent"
      ? "success"
      : state === "idle" || state === "submitting"
        ? "info"
        : "danger";

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.titleBlock}>
            <AppText variant="pageTitle">Sign in</AppText>
            <AppText variant="caption" color="textSecondary">
              An account syncs your chips and lets you play at server tables.
              Practice, Learn and Career work without one.
            </AppText>
          </View>

          {configured ? null : (
            <UnavailableNote>
              {configurationMessage ??
                "This build has no server configured, so accounts are unavailable."}
            </UnavailableNote>
          )}

          <SurfaceCard>
            <AuthField
              label="Email"
              value={form.email}
              onChangeText={(value) => dispatch({ type: "EDIT_EMAIL", value })}
              error={form.fieldErrors.email}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoComplete="email"
              textContentType="username"
              editable={configured && !busy}
              maxLength={254}
              testID="auth-email"
              returnKeyType="next"
            />

            <AuthField
              label="Password"
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                // The reducer is told that the field changed, never what it
                // changed to.
                dispatch({ type: "EDIT_PASSWORD" });
              }}
              error={form.fieldErrors.password}
              secure
              autoComplete="current-password"
              textContentType="password"
              editable={configured && !busy}
              testID="auth-password"
              returnKeyType="go"
              onSubmitEditing={submit}
            />

            <AuthStatusBanner message={message} tone={tone} />

            <Button
              label="Sign in"
              onPress={submit}
              pending={busy}
              disabled={!configured}
              testID="auth-submit"
              style={styles.cta}
            />

            <Button
              label="Email me a reset link"
              variant="quiet"
              size="medium"
              onPress={() => void requestPasswordReset()}
              disabled={!configured || busy}
              accessibilityHint="Sends a password reset link to the address above"
            />
          </SurfaceCard>

          <SurfaceCard>
            <AppText variant="bodyStrong">No account yet?</AppText>
            <AppText variant="caption" color="textSecondary">
              Creating one takes an email address and a username.
            </AppText>
            <Button
              label="Create an account"
              variant="secondary"
              size="medium"
              onPress={() => router.push("./create-account")}
              disabled={!configured}
              style={styles.cta}
            />
          </SurfaceCard>

          {/*
            Guest is a destination, not a consolation prize. It stays available
            whether or not there is a server, and it is worded as a choice.
          */}
          <Button
            label="Continue as guest"
            variant="quiet"
            onPress={() => {
              void continueAsGuest();
              router.replace("/(tabs)/home");
            }}
            accessibilityHint="Plays offline without an account"
            testID="auth-guest"
          />
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
