/**
 * Create an account.
 *
 * The interesting state here is `usernameUnavailable`, and it is worth knowing
 * why it happens *after* submission rather than before.
 *
 * `public.profiles` grants `SELECT` to `authenticated` and nothing to `anon`, so
 * a signed-out client cannot check whether a handle is free — deliberately, since
 * an open availability endpoint is a handle-enumeration tool. Meanwhile
 * `handle_new_user()` does not fail when the requested handle is taken,
 * reserved or filtered: it substitutes a derived one and creates the account.
 *
 * A client that ignored both facts would tell someone they had signed up as
 * "dealer21" when the server had actually called them "p3f8a9b2c1d4". So the
 * store reads the assigned handle back after sign-up and this screen reports the
 * substitution plainly, with the name they actually have.
 *
 * As on the sign-in screen, the password lives in this component and nowhere
 * else, and the typed email and username survive every failure.
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
import {
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
} from "../../src/features/auth/credentials";

export default function CreateAccountScreen() {
  const hydrate = useAuthStore((state) => state.hydrate);
  const hydrated = useAuthStore((state) => state.hydrated);
  const configured = useAuthStore((state) => state.configured);
  const configurationMessage = useAuthStore((state) => state.configurationMessage);
  const form = useAuthStore((state) => state.form);
  const dispatch = useAuthStore((state) => state.dispatch);
  const setMode = useAuthStore((state) => state.setMode);
  const signUp = useAuthStore((state) => state.signUp);

  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  useEffect(() => {
    setMode("signUp");
  }, [setMode]);

  const state = authStateName(form.status);
  const busy = state === "submitting";

  useEffect(() => {
    if (form.status.kind !== "signedIn") return;
    setPassword("");
    router.replace("/(tabs)/home");
  }, [form.status.kind]);

  const submit = useCallback(() => {
    void signUp(password);
  }, [password, signUp]);

  const message = describeAuthStatus(form.status);
  const tone =
    state === "verificationRequired"
      ? "success"
      : state === "idle" || state === "submitting"
        ? "info"
        : "danger";

  // The account exists in both of these; only the handle or the confirmation is
  // outstanding, so the form gives way to a "what now" card.
  const accountCreated =
    form.status.kind === "verificationRequired" || form.status.kind === "usernameUnavailable";

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
            <AppText variant="pageTitle">Create an account</AppText>
            <AppText variant="caption" color="textSecondary">
              Your account holds your chips and your competitive record. Chips are
              virtual, have no monetary value and cannot be bought.
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
              editable={configured && !busy && !accountCreated}
              maxLength={254}
              testID="auth-email"
              returnKeyType="next"
            />

            <AuthField
              label="Username"
              value={form.username}
              onChangeText={(value) => dispatch({ type: "EDIT_USERNAME", value })}
              error={form.fieldErrors.username}
              placeholder="lowercase_handle"
              hint="Lowercase letters, numbers and underscores. 3 to 20 characters."
              autoComplete="username-new"
              editable={configured && !busy && !accountCreated}
              maxLength={USERNAME_MAX_LENGTH}
              testID="auth-username"
              returnKeyType="next"
            />

            <AuthField
              label="Password"
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                dispatch({ type: "EDIT_PASSWORD" });
              }}
              error={form.fieldErrors.password}
              hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
              secure
              autoComplete="new-password"
              textContentType="newPassword"
              editable={configured && !busy && !accountCreated}
              testID="auth-password"
              returnKeyType="go"
              onSubmitEditing={submit}
            />

            <AuthStatusBanner message={message} tone={tone} />

            {accountCreated ? (
              <Button
                label="Back to sign in"
                onPress={() => router.replace("./sign-in")}
                style={styles.cta}
                testID="auth-submit"
              />
            ) : (
              <Button
                label="Create account"
                onPress={submit}
                pending={busy}
                disabled={!configured}
                style={styles.cta}
                testID="auth-submit"
              />
            )}
          </SurfaceCard>

          <SurfaceCard>
            <AppText variant="bodyStrong">What carries over from guest play</AppText>
            <AppText variant="caption" color="textSecondary">
              Your settings, and your practice statistics as practice history.
              Practice chips, offline achievements and career stars stay on this
              device — nothing earned offline can create chips or a competitive
              record.
            </AppText>
          </SurfaceCard>

          <Button
            label="I already have an account"
            variant="quiet"
            onPress={() => router.back()}
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
