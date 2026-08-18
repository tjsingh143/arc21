/**
 * Typed text primitive. Components pick a typography token rather than writing
 * font sizes, which keeps the hierarchy consistent and auditable.
 */

import { Text, type TextProps, type TextStyle } from "react-native";

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
  return (
    <Text
      style={[
        typography[variant] as TextStyle,
        { color: colors[color] },
        numeric ? tabularNumbers : null,
        align ? { textAlign: align } : null,
        style,
      ]}
      {...rest}
    />
  );
}
