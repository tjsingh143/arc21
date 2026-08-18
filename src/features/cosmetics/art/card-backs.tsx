/**
 * Arc 21 — the eight card backs.
 *
 * Each is a single centred motif or one simple lattice, in at most two colours
 * over a flat field. The bar every one of them must clear: it reads at 40 px
 * wide — the compact size other players' seats use — and it never competes
 * with a card face beside it. Fields stay dark so a back can never be mistaken
 * for a face across a table.
 *
 * Original by construction: every mark is drawn from primitives in this file,
 * and none may resemble another game's back.
 */

import Svg, { Circle, G, Line, Path, Rect } from "react-native-svg";

import { colors, cosmeticColors, radius } from "../../../design/tokens";

export interface CardBackArtProps {
  width: number;
  height: number;
}

export type CardBackArt = (props: CardBackArtProps) => React.JSX.Element;

/**
 * The house back: concentric rounded frames over a diagonal lattice, with a
 * single arc — the product's namesake — at the centre. This drawing predates
 * the cosmetic catalogue; it is the same art that has always been the default.
 */
export function ArcStandard({ width, height }: CardBackArtProps) {
  const inset = width * 0.09;
  const latticeStep = width * 0.18;

  const lattice: number[] = [];
  for (let offset = -height; offset < width + height; offset += latticeStep) {
    lattice.push(offset);
  }

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Rect x={0} y={0} width={width} height={height} rx={radius.small} fill={colors.surfaceRaised} />
      <G opacity={0.35}>
        {lattice.map((offset, index) => (
          <Line
            key={index}
            x1={offset}
            y1={0}
            x2={offset + height}
            y2={height}
            stroke={colors.accent}
            strokeWidth={1}
          />
        ))}
      </G>
      <Rect
        x={inset}
        y={inset}
        width={width - inset * 2}
        height={height - inset * 2}
        rx={radius.small * 0.6}
        fill="none"
        stroke={colors.accent}
        strokeWidth={1.5}
        opacity={0.8}
      />
      <Path
        d={`M ${width * 0.28} ${height * 0.66} Q ${width * 0.5} ${height * 0.22} ${width * 0.72} ${height * 0.66}`}
        fill="none"
        stroke={colors.accent}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Matte, quiet, unbothered: one field, one hairline frame, nothing else. */
export function Slate({ width, height }: CardBackArtProps) {
  const inset = width * 0.1;
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Rect x={0} y={0} width={width} height={height} rx={radius.small} fill={colors.surfaceSoft} />
      <Rect
        x={inset}
        y={inset}
        width={width - inset * 2}
        height={height - inset * 2}
        rx={radius.small * 0.5}
        fill="none"
        stroke={colors.borderStrong}
        strokeWidth={1.5}
      />
    </Svg>
  );
}

/** Warm metal and straight edges: a doubled frame with chamfered corners. */
export function Brass({ width, height }: CardBackArtProps) {
  const outer = width * 0.09;
  const inner = width * 0.2;
  const chamfer = width * 0.16;
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Rect x={0} y={0} width={width} height={height} rx={radius.small} fill={colors.surfaceRaised} />
      <Rect
        x={outer}
        y={outer}
        width={width - outer * 2}
        height={height - outer * 2}
        fill="none"
        stroke={colors.accent}
        strokeWidth={1.5}
      />
      <Rect
        x={inner}
        y={inner}
        width={width - inner * 2}
        height={height - inner * 2}
        fill="none"
        stroke={colors.accent}
        strokeWidth={1.5}
        opacity={0.7}
      />
      {/* Chamfers: one straight cut across each corner, between the frames. */}
      <G stroke={colors.accent} strokeWidth={1.5}>
        <Line x1={outer} y1={outer + chamfer} x2={outer + chamfer} y2={outer} />
        <Line x1={width - outer - chamfer} y1={outer} x2={width - outer} y2={outer + chamfer} />
        <Line x1={width - outer} y1={height - outer - chamfer} x2={width - outer - chamfer} y2={height - outer} />
        <Line x1={outer + chamfer} y1={height - outer} x2={outer} y2={height - outer - chamfer} />
      </G>
    </Svg>
  );
}

/** A drafting sheet: a faint square grid and one margin rule. */
export function Drafting({ width, height }: CardBackArtProps) {
  const step = width / 6;
  const margin = width * 0.12;

  const verticals: number[] = [];
  for (let x = step; x < width; x += step) verticals.push(x);
  const horizontals: number[] = [];
  for (let y = step; y < height; y += step) horizontals.push(y);

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Rect x={0} y={0} width={width} height={height} rx={radius.small} fill={colors.surfaceSoft} />
      <G stroke={colors.textSecondary} strokeWidth={0.75} opacity={0.28}>
        {verticals.map((x) => (
          <Line key={`v${x}`} x1={x} y1={0} x2={x} y2={height} />
        ))}
        {horizontals.map((y) => (
          <Line key={`h${y}`} x1={0} y1={y} x2={width} y2={y} />
        ))}
      </G>
      <Rect
        x={margin}
        y={margin}
        width={width - margin * 2}
        height={height - margin * 2}
        fill="none"
        stroke={colors.accent}
        strokeWidth={1.5}
      />
    </Svg>
  );
}

/** A drawing-sheet blue field with one elevation: walls and a roofline. */
export function Blueprint({ width, height }: CardBackArtProps) {
  const inset = width * 0.1;
  const houseWidth = width * 0.44;
  const houseHeight = height * 0.22;
  const left = (width - houseWidth) / 2;
  const baseY = height * 0.62;
  const ridgeY = baseY - houseHeight - height * 0.12;

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Rect x={0} y={0} width={width} height={height} rx={radius.small} fill={cosmeticColors.blueprintField} />
      <Rect
        x={inset}
        y={inset}
        width={width - inset * 2}
        height={height - inset * 2}
        rx={radius.small * 0.5}
        fill="none"
        stroke={colors.info}
        strokeWidth={1.25}
        opacity={0.55}
      />
      <G stroke={colors.info} strokeWidth={1.5} fill="none">
        <Rect x={left} y={baseY - houseHeight} width={houseWidth} height={houseHeight} />
        <Path
          d={`M ${left - width * 0.05} ${baseY - houseHeight} L ${width / 2} ${ridgeY} L ${left + houseWidth + width * 0.05} ${baseY - houseHeight}`}
        />
      </G>
    </Svg>
  );
}

/** One meridian through one circle. */
export function Meridian({ width, height }: CardBackArtProps) {
  const r = width * 0.26;
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Rect x={0} y={0} width={width} height={height} rx={radius.small} fill={colors.surfaceRaised} />
      <Line
        x1={width / 2}
        y1={height * 0.08}
        x2={width / 2}
        y2={height * 0.92}
        stroke={colors.accent}
        strokeWidth={1.5}
      />
      <Circle
        cx={width / 2}
        cy={height / 2}
        r={r}
        fill="none"
        stroke={colors.accent}
        strokeWidth={1.5}
      />
    </Svg>
  );
}

/** Thirty dots for thirty days — five columns, six rows, none missed. */
export function ThirtyDays({ width, height }: CardBackArtProps) {
  const columns = 5;
  const rows = 6;
  const stepX = width * 0.13;
  const stepY = height * 0.11;
  const startX = width / 2 - ((columns - 1) / 2) * stepX;
  const startY = height / 2 - ((rows - 1) / 2) * stepY;

  const dots: { x: number; y: number }[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      dots.push({ x: startX + column * stepX, y: startY + row * stepY });
    }
  }

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Rect x={0} y={0} width={width} height={height} rx={radius.small} fill={colors.surfaceRaised} />
      {dots.map((dot, index) => (
        <Circle key={index} cx={dot.x} cy={dot.y} r={width * 0.025} fill={colors.accent} opacity={0.85} />
      ))}
    </Svg>
  );
}

/** Three stands, first in the middle, off one baseline. */
export function Podium({ width, height }: CardBackArtProps) {
  const barWidth = width * 0.15;
  const gap = width * 0.05;
  const baseY = height * 0.68;
  const centre = width / 2;
  const heights = { second: height * 0.24, first: height * 0.34, third: height * 0.18 };

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Rect x={0} y={0} width={width} height={height} rx={radius.small} fill={colors.surfaceRaised} />
      <G fill={colors.accent}>
        <Rect
          x={centre - barWidth * 1.5 - gap}
          y={baseY - heights.second}
          width={barWidth}
          height={heights.second}
        />
        <Rect x={centre - barWidth / 2} y={baseY - heights.first} width={barWidth} height={heights.first} />
        <Rect
          x={centre + barWidth / 2 + gap}
          y={baseY - heights.third}
          width={barWidth}
          height={heights.third}
        />
        <Rect x={width * 0.16} y={baseY} width={width * 0.68} height={height * 0.012 + 1.5} />
      </G>
    </Svg>
  );
}
