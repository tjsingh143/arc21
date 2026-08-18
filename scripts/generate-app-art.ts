/**
 * Arc 21 — the app icon and the splash mark, generated.
 *
 * The same policy as the sound palette: nothing is downloaded, bought,
 * borrowed or traced, and "originally generated" is a checkable claim because
 * a committed script re-derives the committed bytes. `tests/art` regenerates
 * both images and compares them with the files on disk.
 *
 * The mark is one thing: an arch over the numerals 21, drawn in the accent
 * ink on the app's background. Deliberately NOT a card, a chip or an ace —
 * that is what every other blackjack app reaches for, and this product's whole
 * position is that it is not one of those. The vocabulary is the same
 * compass-and-straight-edge language as the cosmetics: two capsule strokes and
 * three ring segments, nothing rendered, no gradient, no bevel, no shadow.
 *
 *   npm run art:generate
 *
 * Rendering is a signed-distance rasteriser with 4× supersampling — pure
 * arithmetic, so the pixels are identical on every run and every machine. The
 * PNG stream is compressed with node:zlib at a pinned level; the byte-compare
 * test would surface a zlib behaviour change, which has not happened in the
 * lifetime of this codebase's toolchain.
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "images");

// The two inks. The icon must stay within the app's own palette.
const BACKGROUND = { r: 0x0b, g: 0x0d, b: 0x10 };
const ACCENT = { r: 0xf0, g: 0xb3, b: 0x6a };

// ---------------------------------------------------------------------------
// Signed-distance shapes
//
// Every drawing below is a union of two primitives: a capsule (a stroke
// between two points with round caps) and a ring segment (a circular arc with
// a stroke width and round caps). A compass and a straight edge, in code.
// ---------------------------------------------------------------------------

interface Point {
  x: number;
  y: number;
}

interface Capsule {
  kind: "capsule";
  a: Point;
  b: Point;
  halfWidth: number;
}

interface ArcSegment {
  kind: "arc";
  centre: Point;
  radius: number;
  halfWidth: number;
  /**
   * Angle range in radians, y-down screen convention (0 = right, π/2 = down,
   * -π/2 = up). Must be a contiguous range within (-π, π] — the distance
   * function clamps to it without handling wrap-around.
   */
  from: number;
  to: number;
}

type Shape = Capsule | ArcSegment;

function capsuleDistance(px: number, py: number, shape: Capsule): number {
  const abx = shape.b.x - shape.a.x;
  const aby = shape.b.y - shape.a.y;
  const apx = px - shape.a.x;
  const apy = py - shape.a.y;
  const lengthSquared = abx * abx + aby * aby;
  const t =
    lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / lengthSquared));
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  return Math.sqrt(dx * dx + dy * dy) - shape.halfWidth;
}

function arcDistance(px: number, py: number, shape: ArcSegment): number {
  const dx = px - shape.centre.x;
  const dy = py - shape.centre.y;
  const angle = Math.atan2(dy, dx);
  const clamped = Math.max(shape.from, Math.min(shape.to, angle));
  const nx = shape.centre.x + shape.radius * Math.cos(clamped);
  const ny = shape.centre.y + shape.radius * Math.sin(clamped);
  const ex = px - nx;
  const ey = py - ny;
  return Math.sqrt(ex * ex + ey * ey) - shape.halfWidth;
}

function distance(px: number, py: number, shapes: readonly Shape[]): number {
  let nearest = Infinity;
  for (const shape of shapes) {
    const d =
      shape.kind === "capsule" ? capsuleDistance(px, py, shape) : arcDistance(px, py, shape);
    if (d < nearest) nearest = d;
  }
  return nearest;
}

const degrees = (value: number): number => (value * Math.PI) / 180;

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

/**
 * The arch and the numerals, described on a unit square and scaled by the
 * caller. Stroke weight is uniform across the whole mark — one pen.
 */
function markShapes(size: number): Shape[] {
  const s = (value: number): number => value * size;
  const stroke = s(0.062) / 2;

  // The arch: the top of one circle, ends stopping short of the horizontal so
  // it reads as an arch rather than a half-frame. The numerals sit entirely
  // beneath it — the two must never collide at any size.
  const arch: ArcSegment = {
    kind: "arc",
    centre: { x: s(0.5), y: s(0.6) },
    radius: s(0.36),
    halfWidth: stroke,
    from: degrees(-160),
    to: degrees(-20),
  };

  // Digit metrics. Both numerals sit on one baseline, centred under the arch.
  const digitHeight = s(0.26);
  const baseline = s(0.78);
  const top = baseline - digitHeight;

  // "2": an open top curve, a straight diagonal to the corner, a flat base.
  // The pair is placed by its OPTICAL centre: the "1" has no mass right of its
  // stem, so the geometric span sits a little right of the arch's axis.
  const twoWidth = s(0.17);
  const twoLeft = s(0.5) - twoWidth - s(0.005);
  const twoCurveRadius = twoWidth / 2;
  const twoCurveCentre = { x: twoLeft + twoWidth / 2, y: top + twoCurveRadius };
  const twoCurveEndAngle = degrees(30);
  const twoCurveEnd = {
    x: twoCurveCentre.x + twoCurveRadius * Math.cos(twoCurveEndAngle),
    y: twoCurveCentre.y + twoCurveRadius * Math.sin(twoCurveEndAngle),
  };
  const two: Shape[] = [
    {
      kind: "arc",
      centre: twoCurveCentre,
      radius: twoCurveRadius,
      halfWidth: stroke,
      from: degrees(-175),
      to: twoCurveEndAngle,
    },
    { kind: "capsule", a: twoCurveEnd, b: { x: twoLeft, y: baseline }, halfWidth: stroke },
    {
      kind: "capsule",
      a: { x: twoLeft, y: baseline },
      b: { x: twoLeft + twoWidth, y: baseline },
      halfWidth: stroke,
    },
  ];

  // "1": a short rising flag into a straight stem. No serif, no base.
  const oneStem = s(0.5) + s(0.145);
  const one: Shape[] = [
    {
      kind: "capsule",
      a: { x: oneStem - s(0.062), y: top + s(0.058) },
      b: { x: oneStem, y: top },
      halfWidth: stroke,
    },
    { kind: "capsule", a: { x: oneStem, y: top }, b: { x: oneStem, y: baseline }, halfWidth: stroke },
  ];

  return [arch, ...two, ...one];
}

// ---------------------------------------------------------------------------
// Rasterising
// ---------------------------------------------------------------------------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Coverage-sampled fill: 2×2 supersampling with a half-pixel soft edge per
 * sample. Enough antialiasing that the mark is clean at 60 px, with no
 * randomness anywhere.
 */
function rasterise(
  size: number,
  shapes: readonly Shape[],
  background: Rgba,
  ink: Rgba,
): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const offsets = [0.25, 0.75];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let coverage = 0;
      for (const oy of offsets) {
        for (const ox of offsets) {
          const d = distance(x + ox, y + oy, shapes);
          coverage += Math.max(0, Math.min(1, 0.5 - d));
        }
      }
      coverage /= 4;

      const index = (y * size + x) * 4;
      const alpha = background.a + (ink.a - background.a) * coverage;
      pixels[index] = Math.round(background.r + (ink.r - background.r) * coverage);
      pixels[index + 1] = Math.round(background.g + (ink.g - background.g) * coverage);
      pixels[index + 2] = Math.round(background.b + (ink.b - background.b) * coverage);
      pixels[index + 3] = Math.round(alpha);
    }
  }
  return pixels;
}

// ---------------------------------------------------------------------------
// PNG container — written by hand, like the WAV container in generate-audio.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** RGBA8, non-interlaced, filter 0 on every scanline, one pinned zlib level. */
function toPng(size: number, pixels: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type 6 = truecolour with alpha
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter method
  ihdr.writeUInt8(0, 12); // no interlace

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter type 0: none
    const row = pixels.subarray(y * size * 4, (y + 1) * size * 4);
    Buffer.from(row).copy(raw, y * (size * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The two images
// ---------------------------------------------------------------------------

const OPAQUE_BACKGROUND: Rgba = { ...BACKGROUND, a: 255 };
const TRANSPARENT: Rgba = { r: ACCENT.r, g: ACCENT.g, b: ACCENT.b, a: 0 };
const INK: Rgba = { ...ACCENT, a: 255 };

export const IMAGES: Record<string, () => Buffer> = {
  /** 1024×1024, opaque — iOS rejects icons with an alpha channel in use. */
  icon() {
    return toPng(1024, rasterise(1024, markShapes(1024), OPAQUE_BACKGROUND, INK));
  },

  /**
   * The splash shows the same mark, transparent behind it: expo-splash-screen
   * already paints the #0B0D10 field and centres this image over it.
   */
  "splash-icon"() {
    return toPng(512, rasterise(512, markShapes(512), TRANSPARENT, INK));
  },
};

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const [name, build] of Object.entries(IMAGES)) {
    const png = build();
    writeFileSync(join(OUTPUT_DIR, `${name}.png`), png);
    console.log(`${name.padEnd(14)} ${(png.byteLength / 1024).toFixed(1)} KiB`);
  }
}

/*
 * Only when run directly: `tests/art` imports IMAGES to regenerate both files
 * and compare them byte for byte with what is committed, exactly as the audio
 * test does — a module that wrote on import would overwrite its own evidence.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) main();

export { OUTPUT_DIR, markShapes, toPng };
