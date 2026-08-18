/**
 * Shared pieces of the two auth screens.
 *
 * They live here rather than being written twice so that a field cannot end up
 * with autocorrect enabled on one screen and disabled on the other — which is
 * the sort of difference nobody notices until an address arrives capitalised.
 *
 * `AuthField` never receives a logging callback, never receives an analytics
 * hook, and does not know whether it is holding a password. The screen decides
 * that with `secure`, and the value goes nowhere except the component's own
 * state and the adapter call.
 */

import { StyleSheet, TextInput, View, type KeyboardTypeOptions } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { colors, MIN_TOUCH_TARGET, radius, spacing } from "../../design/tokens";
import { typography } from "../../design/typography";

export interface AuthFieldProps {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  /** Shown under the field, in the danger colour. */
  error?: string | undefined;
  placeholder?: string;
  secure?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoComplete?: React.ComponentProps<typeof TextInput>["autoComplete"];
  textContentType?: React.ComponentProps<typeof TextInput>["textContentType"];
  editable?: boolean;
  maxLength?: number;
  hint?: string;
  testID?: string;
  onSubmitEditing?: () => void;
  returnKeyType?: React.ComponentProps<typeof TextInput>["returnKeyType"];
}

export function AuthField({
  label,
  value,
  onChangeText,
  error,
  placeholder,
  secure = false,
  keyboardType,
  autoComplete,
  textContentType,
  editable = true,
  maxLength,
  hint,
  testID,
  onSubmitEditing,
  returnKeyType,
}: AuthFieldProps) {
  return (
    <View style={styles.field}>
      <AppText variant="overline" color="textSecondary">
        {label}
      </AppText>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textDisabled}
        secureTextEntry={secure}
        // Addresses and handles are lower-case in this product; leaving these
        // on is how "Sam@Example.com" reaches the server.
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        keyboardType={keyboardType}
        autoComplete={autoComplete}
        textContentType={textContentType}
        editable={editable}
        maxLength={maxLength}
        testID={testID}
        onSubmitEditing={onSubmitEditing}
        returnKeyType={returnKeyType}
        accessibilityLabel={label}
        accessibilityHint={hint}
        style={[
          styles.input,
          error === undefined ? null : styles.inputError,
          editable ? null : styles.inputDisabled,
        ]}
      />
      {error === undefined ? (
        hint === undefined ? null : (
          <AppText variant="caption" color="textDisabled">
            {hint}
          </AppText>
        )
      ) : (
        <AppText variant="caption" color="danger" accessibilityRole="alert">
          {error}
        </AppText>
      )}
    </View>
  );
}

/**
 * The one-line status message.
 *
 * `accessibilityLiveRegion` / `accessibilityRole="alert"` so a screen reader
 * announces a failure instead of leaving a blind user pressing a button that
 * silently does nothing.
 */
export function AuthStatusBanner({
  message,
  tone = "info",
}: {
  message: string | null;
  tone?: "info" | "danger" | "success";
}) {
  if (message === null) return null;

  const color = tone === "danger" ? "danger" : tone === "success" ? "success" : "textSecondary";
  return (
    <View
      style={[styles.banner, tone === "danger" ? styles.bannerDanger : null]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <AppText variant="caption" color={color}>
        {message}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: spacing.xs },
  input: {
    ...(typography.body as object),
    color: colors.textPrimary,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  inputError: { borderColor: colors.danger },
  inputDisabled: { opacity: 0.5 },
  banner: {
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  bannerDanger: { borderColor: colors.danger },
});
