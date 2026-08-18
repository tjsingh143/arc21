/**
 * Arc 21 — the four table themes.
 *
 * A theme is a flat surface tone and at most one restrained geometric element.
 * No felt texture, no vignette, no photorealism: the table's job is to
 * disappear behind the cards, so every surface sits within a shade of the app
 * background and every element is a hairline. Each theme's element is a
 * different kind of mark — an arc, a corner rule, a horizon — so the four stay
 * distinguishable even though none of them is allowed to be loud.
 */

import Svg, { Line, Path } from "react-native-svg";

import { cosmeticColors } from "../../../design/tokens";

export interface ThemeElementProps {
  width: number;
  height: number;
}

export interface TableThemeArt {
  /** Flat colour behind everything at the table. */
  readonly surface: string;
  /** The one permitted element, or null for a plain surface. */
  readonly Element: ((props: ThemeElementProps) => React.JSX.Element) | null;
}

/** The default: a desaturated surface green under a single high arc. Not baize. */
export const ArcGreen: TableThemeArt = {
  surface: cosmeticColors.arcGreenSurface,
  Element: ({ width, height }) => (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Path
        d={`M ${-width * 0.1} ${height * 0.3} Q ${width * 0.5} ${height * 0.12} ${width * 1.1} ${height * 0.3}`}
        fill="none"
        stroke={cosmeticColors.arcGreenLine}
        strokeWidth={2}
      />
    </Svg>
  ),
};

/** Warm timber under one corner rule, like the edge of a bench. */
export const WorkshopOak: TableThemeArt = {
  surface: cosmeticColors.workshopOakSurface,
  Element: ({ width, height }) => (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Path
        d={`M ${width * 0.06} ${height * 0.3} L ${width * 0.06} ${height * 0.06} L ${width * 0.55} ${height * 0.06}`}
        fill="none"
        stroke={cosmeticColors.workshopOakLine}
        strokeWidth={2}
      />
    </Svg>
  ),
};

/** Dusk blue with a low horizon. */
export const SkylineDusk: TableThemeArt = {
  surface: cosmeticColors.skylineDuskSurface,
  Element: ({ width, height }) => (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Line
        x1={0}
        y1={height * 0.78}
        x2={width}
        y2={height * 0.78}
        stroke={cosmeticColors.skylineDuskLine}
        strokeWidth={2}
      />
    </Svg>
  ),
};

/** The quietest surface in the set: nothing on it at all. */
export const Midnight: TableThemeArt = {
  surface: cosmeticColors.midnightSurface,
  Element: null,
};
