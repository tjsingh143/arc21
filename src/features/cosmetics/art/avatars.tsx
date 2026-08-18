/**
 * Arc 21 — the twelve avatars.
 *
 * Abstract geometric marks, not faces: closer to a maker's stamp than a
 * portrait. Every one is two or three primitives on the same 48-unit grid with
 * the same stroke weight, drawn with nothing a compass and a straight edge
 * could not produce. The binding constraint is that each must be recognisably
 * distinct at 32 px — each mark therefore has a different silhouette, not a
 * different amount of detail.
 *
 * The ink is the accent token throughout, with two deliberate exceptions that
 * are part of the design rather than decoration: Night Shift is drawn in info
 * blue, and Laurel — the tournament win — in success green.
 */

import Svg, { Circle, Line, Path, Polygon, Rect } from "react-native-svg";

import { colors } from "../../../design/tokens";

export interface AvatarMarkProps {
  /** Rendered size in px. The drawing scales from a fixed 48-unit grid. */
  size: number;
}

export type AvatarMark = (props: AvatarMarkProps) => React.JSX.Element;

const VIEW_BOX = "0 0 48 48";

/** The dealer's layout: three cards in order above the rail. */
export function HouseDealer({ size }: AvatarMarkProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX}>
      <Rect x={9} y={15} width={8} height={11} rx={1.5} fill={colors.accent} />
      <Rect x={20} y={15} width={8} height={11} rx={1.5} fill={colors.accent} />
      <Rect x={31} y={15} width={8} height={11} rx={1.5} fill={colors.accent} />
      <Rect x={9} y={31} width={30} height={2.5} rx={1.25} fill={colors.accent} />
    </Svg>
  );
}

/** One chip, seen from above: a dashed edge and a plain centre. */
export function FirstChip({ size }: AvatarMarkProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX}>
      <Circle
        cx={24}
        cy={24}
        r={13}
        stroke={colors.accent}
        strokeWidth={4.5}
        strokeDasharray="6.81 6.81"
        fill="none"
      />
      <Circle cx={24} cy={24} r={5.5} stroke={colors.accent} strokeWidth={2.5} fill="none" />
    </Svg>
  );
}

/** A set square — the first instrument anyone is handed. */
export function Apprentice({ size }: AvatarMarkProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX}>
      <Path
        d="M11.5 11.5 L11.5 36.5 L36.5 36.5 Z"
        stroke={colors.accent}
        strokeWidth={3}
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M17 24 L17 31 L24 31 Z"
        stroke={colors.accent}
        strokeWidth={2}
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/** A compass mid-arc: lines drawn before the cards are dealt. */
export function Draftsman({ size }: AvatarMarkProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX}>
      <Path
        d="M13 37 A24 24 0 0 0 35 37"
        stroke={colors.accentSoft}
        strokeWidth={2.5}
        strokeLinecap="round"
        fill="none"
      />
      <Line x1={24} y1={14} x2={14} y2={35} stroke={colors.accent} strokeWidth={3} strokeLinecap="round" />
      <Line x1={24} y1={14} x2={34} y2={35} stroke={colors.accent} strokeWidth={3} strokeLinecap="round" />
      <Circle cx={24} cy={12} r={3} fill={colors.accent} />
    </Svg>
  );
}

/** Post and lintel: structure over instinct. */
export function Architect({ size }: AvatarMarkProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX}>
      <Rect x={10} y={12.5} width={28} height={5} fill={colors.accent} />
      <Rect x={13.5} y={20.5} width={6} height={15.5} fill={colors.accent} />
      <Rect x={28.5} y={20.5} width={6} height={15.5} fill={colors.accent} />
    </Svg>
  );
}

/** The moon over a shoe that does not care what time it is. Info blue. */
export function NightShift({ size }: AvatarMarkProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX}>
      <Path
        d="M28 11 A13.5 13.5 0 1 0 21 37 A15.5 15.5 0 0 1 28 11 Z"
        fill={colors.info}
      />
    </Svg>
  );
}

/** Rings of experience — the long way round, three times. */
export function OldHand({ size }: AvatarMarkProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX}>
      <Path d="M8 32 A16 16 0 0 1 40 32" stroke={colors.accent} strokeWidth={3} strokeLinecap="round" fill="none" />
      <Path d="M13 32 A11 11 0 0 1 35 32" stroke={colors.accent} strokeWidth={3} strokeLinecap="round" fill="none" />
      <Path d="M18 32 A6 6 0 0 1 30 32" stroke={colors.accent} strokeWidth={3} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

/** A stepped footing: what everything after it stands on. */
export function Foundation({ size }: AvatarMarkProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX}>
      <Rect x={17} y={16.5} width={14} height={5.5} fill={colors.accent} />
      <Rect x={13} y={24.5} width={22} height={5.5} fill={colors.accent} />
      <Rect x={9} y={32.5} width={30} height={5.5} fill={colors.accent} />
    </Svg>
  );
}

/** A hex nut: The Workshop's mark. */
export function Machinist({ size }: AvatarMarkProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX}>
      <Polygon
        points="36.1,31 24,38 11.9,31 11.9,17 24,10 36.1,17"
        stroke={colors.accent}
        strokeWidth={3}
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx={24} cy={24} r={5} stroke={colors.accent} strokeWidth={2.5} fill="none" />
    </Svg>
  );
}

/** Three towers off one baseline. */
export function Skyline({ size }: AvatarMarkProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX}>
      <Rect x={11.5} y={22} width={6.5} height={13} fill={colors.accent} />
      <Rect x={20.75} y={13} width={6.5} height={22} fill={colors.accent} />
      <Rect x={30} y={18} width={6.5} height={17} fill={colors.accent} />
      <Rect x={9} y={35} width={30} height={2.5} rx={1.25} fill={colors.accent} />
    </Svg>
  );
}

/** A clock with its hands still on: seven days without missing one. */
export function Clockwork({ size }: AvatarMarkProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX}>
      <Circle cx={24} cy={24} r={13.5} stroke={colors.accent} strokeWidth={3} fill="none" />
      <Line x1={24} y1={24} x2={24} y2={15.5} stroke={colors.accent} strokeWidth={3} strokeLinecap="round" />
      <Line x1={24} y1={24} x2={30.5} y2={27.5} stroke={colors.accent} strokeWidth={3} strokeLinecap="round" />
      <Circle cx={24} cy={24} r={2} fill={colors.accent} />
    </Svg>
  );
}

/** Two branches around first place. Success green, for the win it marks. */
export function Laurel({ size }: AvatarMarkProps) {
  return (
    <Svg width={size} height={size} viewBox={VIEW_BOX}>
      <Path
        d="M14 34 A17 17 0 0 1 21 12"
        stroke={colors.success}
        strokeWidth={3}
        strokeLinecap="round"
        fill="none"
      />
      <Path
        d="M34 34 A17 17 0 0 0 27 12"
        stroke={colors.success}
        strokeWidth={3}
        strokeLinecap="round"
        fill="none"
      />
      <Circle cx={24} cy={31} r={3} fill={colors.success} />
    </Svg>
  );
}
