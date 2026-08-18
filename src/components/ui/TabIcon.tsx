/**
 * Tab bar icons, drawn from geometric primitives.
 *
 * No icon dependency and no image assets — these are four simple glyphs, and
 * pulling in a font or SVG library for them would cost more than it saves.
 *
 * Each icon is paired with a visible text label in the tab bar. The shape is
 * reinforcement, never the sole carrier of meaning, so the tabs stay usable for
 * anyone who cannot distinguish the glyphs.
 */

import Svg, { Circle, Path, Rect } from "react-native-svg";

import { colors } from "../../design/tokens";

export type TabIconName = "home" | "play" | "learn" | "social";

export interface TabIconProps {
  name: TabIconName;
  focused: boolean;
  size?: number;
}

export function TabIcon({ name, focused, size = 24 }: TabIconProps) {
  const stroke = focused ? colors.accent : colors.textSecondary;
  const strokeWidth = focused ? 2 : 1.6;
  const common = {
    stroke,
    strokeWidth,
    fill: "none",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === "home" ? (
        // A roof over a door.
        <Path d="M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" {...common} />
      ) : null}

      {name === "play" ? (
        // Two cards, fanned — the table.
        <>
          <Rect x="4" y="6" width="10" height="14" rx="2" {...common} />
          <Path d="M9.5 5.5 17.5 3.6a2 2 0 0 1 2.4 1.5l2 9.6" {...common} />
        </>
      ) : null}

      {name === "learn" ? (
        // An open book.
        <>
          <Path d="M12 6.5C10.5 5 8.4 4.4 4 4.5v13c4.4-.1 6.5.5 8 2 1.5-1.5 3.6-2.1 8-2v-13c-4.4-.1-6.5.5-8 2z" {...common} />
          <Path d="M12 6.5v13" {...common} />
        </>
      ) : null}

      {name === "social" ? (
        // Two figures.
        <>
          <Circle cx="9" cy="8" r="3.2" {...common} />
          <Path d="M3.5 20c0-3.2 2.5-5.4 5.5-5.4s5.5 2.2 5.5 5.4" {...common} />
          <Path d="M16 5.6a3.2 3.2 0 0 1 0 6.3M17.2 14.9c2.1.5 3.6 2.4 3.6 5.1" {...common} />
        </>
      ) : null}
    </Svg>
  );
}
