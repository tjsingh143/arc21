/**
 * Typed text primitive. Components pick a typography token rather than writing
 * font sizes, which keeps the hierarchy consistent and auditable.
 */

import { Text, useWindowDimensions, type TextProps, type TextStyle } from "react-native";

import { useSecondaryTextColor } from "../../design/accessibility";
import { colors, type ColorToken } from "../../design/tokens";
import { tabularNumbers, typography, type TypographyToken } from "../../design/typography";

export interface AppTextProps extends TextProps {
  variant?: TypographyToken;
  color?: ColorToken;
  /** Tabular figures — use for any number that updates in place. */
  numeric?: boolean;
  align?: TextStyle["textAlign"];
}

export function AppText({
  variant = "body",
  color = "textPrimary",
  numeric = false,
  align,
  style,
  ...rest
}: AppTextProps) {
  const { fontScale } = useWindowDimensions();
  // The only colour "Increased contrast" changes app-wide: everywhere else a
  // token is already at or above the AA bar (see check-contrast.ts), so there
  // is nothing to strengthen.
  const secondaryTextColor = useSecondaryTextColor();
  const resolved = color === "textSecondary" ? secondaryTextColor : colors[color];

  return (
    <Text
      // Fabric 0.86 can retain the old measured box after a live Dynamic Type
      // change while drawing larger glyphs. Remount only the native text node
      // when that scale changes; screen, form and game state stay mounted.
      // https://github.com/react/react-native/issues/57512
      key={fontScale}
      style={[
        typography[variant] as TextStyle,
        { color: resolved },
        numeric ? tabularNumbers : null,
        align ? { textAlign: align } : null,
        style,
      ]}
      {...rest}
    />
  );
}
