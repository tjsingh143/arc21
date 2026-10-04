/** Native hCaptcha UI. Mount once alongside the root navigator. */
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, StyleSheet, View, type AppStateStatus, AppState } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Hcaptcha } from "@hcaptcha/react-native-hcaptcha";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useAccessibilityPrefs } from "../../design/accessibility";
import { colors, spacing } from "../../design/tokens";
import {
  CaptchaError,
  interpretCaptchaMessage,
  registerCaptchaProvider,
  type EnabledCaptchaConfig,
} from "./captcha";

interface Challenge {
  readonly config: EnabledCaptchaConfig;
  readonly resolve: (token: string) => void;
  readonly reject: (error: CaptchaError) => void;
}

export function CaptchaProvider() {
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const active = useRef<Challenge | null>(null);
  const { increasedContrast } = useAccessibilityPrefs();

  const cancel = useCallback(() => {
    const current = active.current;
    active.current = null;
    setChallenge(null);
    current?.reject(new CaptchaError("cancelled"));
  }, []);

  useEffect(() => {
    const unregister = registerCaptchaProvider((config) => new Promise<string>((resolve, reject) => {
      const next = { config, resolve, reject };
      active.current = next;
      setChallenge(next);
    }));
    // Challenge tokens expire and must not outlive an interrupted attempt.
    const subscription = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "background") cancel();
    });
    return () => {
      unregister();
      subscription.remove();
      const current = active.current;
      active.current = null;
      current?.reject(new CaptchaError("unavailable"));
    };
  }, [cancel]);

  if (!challenge) return null;

  return (
    <Modal visible transparent={false} animationType="none" onRequestClose={cancel}>
      <SafeAreaView style={styles.screen} accessibilityViewIsModal onAccessibilityEscape={cancel}>
        <View style={styles.header}>
          <AppText variant="sectionTitle" accessibilityRole="header">Player verification</AppText>
          <AppText color="textSecondary">Complete this check to connect. Practice is available if you cancel.</AppText>
        </View>
        <Hcaptcha
          size="invisible"
          siteKey={challenge.config.siteKey}
          url={challenge.config.baseUrl}
          theme={increasedContrast ? "contrast" : "dark"}
          backgroundColor={colors.background}
          showLoading
          loadingIndicatorColor={colors.accent}
          sentry={false}
          userJourney={false}
          onMessage={(event) => {
            if (active.current !== challenge) return;
            const result = interpretCaptchaMessage(event);
            if (result.kind === "pending") return;
            active.current = null;
            setChallenge(null);
            if (result.kind === "token") {
              event.markUsed?.();
              challenge.resolve(result.token);
            } else {
              challenge.reject(new CaptchaError(result.kind));
            }
          }}
        />
        <View style={styles.footer}>
          <Button label="Cancel verification" variant="secondary" onPress={cancel} testID="captcha-cancel" />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { padding: spacing.lg, gap: spacing.sm },
  footer: { padding: spacing.lg, flexDirection: "row" },
});
