/**
 * The app icon and splash mark, as committed files.
 *
 * The same three-part claim the audio test makes:
 *
 *   1. both files EXIST, so the build cannot silently ship without an icon;
 *   2. each committed file is exactly what the generator produces today —
 *      "originally generated" (docs/ASSET_LICENSES.md) is only checkable if
 *      regenerating reproduces the bytes;
 *   3. the images are what they claim to be: correct dimensions, a valid PNG
 *      signature, the icon fully opaque (iOS rejects icons that use alpha)
 *      and the splash mark transparent outside the mark so the splash
 *      screen's own background shows through.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { IMAGES, OUTPUT_DIR } from "../../scripts/generate-app-art.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Png {
  width: number;
  height: number;
  /** Filter-stripped RGBA bytes. */
  pixels: Buffer;
}

/** A deliberately strict reader for the one PNG shape the generator writes. */
function parsePng(buffer: Buffer): Png {
  expect(buffer.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  expect(buffer.toString("ascii", 12, 16)).toBe("IHDR");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  expect(buffer.readUInt8(24)).toBe(8); // bit depth
  expect(buffer.readUInt8(25)).toBe(6); // RGBA

  // Chunks: IHDR then exactly one IDAT then IEND, as the generator writes.
  const idatLength = buffer.readUInt32BE(33);
  expect(buffer.toString("ascii", 37, 41)).toBe("IDAT");
  const raw = inflateSync(buffer.subarray(41, 41 + idatLength));

  const stride = width * 4 + 1;
  expect(raw.length).toBe(height * stride);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride]).toBe(0); // filter type 0 on every scanline
    raw.copy(pixels, y * width * 4, y * stride + 1, (y + 1) * stride);
  }
  return { width, height, pixels };
}

describe("generated app art", () => {
  it("regenerating reproduces every committed file byte for byte", () => {
    for (const [name, build] of Object.entries(IMAGES)) {
      const committed = readFileSync(join(OUTPUT_DIR, `${name}.png`));
      expect(build().equals(committed), `${name}.png drifted from its generator`).toBe(true);
    }
  });

  it("the icon is 1024×1024 and fully opaque", () => {
    const png = parsePng(readFileSync(join(OUTPUT_DIR, "icon.png")));
    expect(png.width).toBe(1024);
    expect(png.height).toBe(1024);
    for (let i = 3; i < png.pixels.length; i += 4) {
      if (png.pixels[i] !== 255) {
        throw new Error(`icon has a translucent pixel at byte ${i}`);
      }
    }
  });

  it("the splash mark is 512×512 with a transparent field", () => {
    const png = parsePng(readFileSync(join(OUTPUT_DIR, "splash-icon.png")));
    expect(png.width).toBe(512);
    expect(png.height).toBe(512);
    // The corner is field, not mark: transparent so the splash screen's own
    // #0B0D10 shows through. The centre region must carry visible ink.
    expect(png.pixels[3]).toBe(0);
    let inked = 0;
    for (let i = 3; i < png.pixels.length; i += 4) {
      if ((png.pixels[i] as number) > 128) inked++;
    }
    expect(inked).toBeGreaterThan(1_000);
  });
});
