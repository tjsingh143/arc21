/**
 * Every cosmetic in the catalogue resolves to artwork, and nothing else does.
 *
 * This is the test that would have caught the audio adapter: a component can
 * be built, typechecked and green while connected to nothing. The catalogue is
 * parsed from the SQL that writes it — not re-declared here — so adding a
 * cosmetic to the database without drawing it fails this file, and so does
 * deleting a cosmetic while leaving its art behind. No orphans in either
 * direction, in any of the three layers: the catalogue, the key list the stores
 * validate against, and the component registry itself.
 *
 * The source moved out of `supabase/seed.sql` and into a migration, because the
 * seed does not run on `supabase db push` and a deployed project therefore had
 * no cosmetics at all. Parsing the migration keeps this test pointed at the
 * statement that actually creates the rows — which is the whole reason it reads
 * SQL rather than a TypeScript list.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  AVATAR_KEYS,
  CARD_BACK_KEYS,
  TABLE_THEME_KEYS,
  DEFAULT_ASSET_KEYS,
} from "../../src/features/cosmetics/art/keys.js";
import {
  AVATAR_ART,
  CARD_BACK_ART,
  TABLE_THEME_ART,
} from "../../src/features/cosmetics/art/registry.js";

// The art imports `react-native-svg`, which cannot load outside a native
// runtime. The registry's job under test is the KEYING, not the rendering —
// the drawings themselves are judged on a screen, where a unit test cannot
// grade them — so the SVG primitives are stubbed and everything else is real.
// (`vi.mock` is hoisted above the imports, so the order here is cosmetic.)
vi.mock("react-native-svg", () => {
  const stub = () => null;
  return {
    __esModule: true,
    default: stub,
    Svg: stub,
    Circle: stub,
    G: stub,
    Line: stub,
    Path: stub,
    Polygon: stub,
    Rect: stub,
  };
});

const cataloguePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "supabase",
  "migrations",
  "20260823110000_catalogue_ships_in_migrations.sql",
);
const seed = readFileSync(cataloguePath, "utf8");

/**
 * Each catalogue row lists `asset_key` immediately followed by `unlock_type`,
 * so one expression captures both. Anchored to the three kind prefixes, which
 * nothing else in the migration uses.
 */
const CATALOGUE_ROW = /'((?:avatars|card_backs|tables)\/[a-z0-9_]+)',\s*'([a-z_]+)'/g;

function seedEntries(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const match of seed.matchAll(CATALOGUE_ROW)) {
    entries.set(match[1] as string, match[2] as string);
  }
  return entries;
}

function seedKeysWithPrefix(prefix: string): string[] {
  return [...seedEntries().keys()].filter((key) => key.startsWith(`${prefix}/`)).sort();
}

describe("the catalogue and the art registry agree in both directions", () => {
  it("parses the expected catalogue size from the migration that writes it", () => {
    // 24 cosmetics: 12 avatars, 8 card backs, 4 table themes. If this fails,
    // the regex or the catalogue changed — either way the rest of the file
    // would be asserting against the wrong catalogue.
    expect(seedKeysWithPrefix("avatars")).toHaveLength(12);
    expect(seedKeysWithPrefix("card_backs")).toHaveLength(8);
    expect(seedKeysWithPrefix("tables")).toHaveLength(4);
  });

  it("every avatar in the catalogue has art, and no art is orphaned", () => {
    expect(Object.keys(AVATAR_ART).sort()).toEqual(seedKeysWithPrefix("avatars"));
    expect([...AVATAR_KEYS].sort()).toEqual(seedKeysWithPrefix("avatars"));
  });

  it("every card back in the catalogue has art, and no art is orphaned", () => {
    expect(Object.keys(CARD_BACK_ART).sort()).toEqual(seedKeysWithPrefix("card_backs"));
    expect([...CARD_BACK_KEYS].sort()).toEqual(seedKeysWithPrefix("card_backs"));
  });

  it("every table theme in the catalogue has art, and no art is orphaned", () => {
    expect(Object.keys(TABLE_THEME_ART).sort()).toEqual(seedKeysWithPrefix("tables"));
    expect([...TABLE_THEME_KEYS].sort()).toEqual(seedKeysWithPrefix("tables"));
  });

  it("every avatar and card back entry is a component", () => {
    for (const art of Object.values(AVATAR_ART)) expect(typeof art).toBe("function");
    for (const art of Object.values(CARD_BACK_ART)) expect(typeof art).toBe("function");
  });

  it("every table theme carries a flat surface colour", () => {
    for (const theme of Object.values(TABLE_THEME_ART)) {
      expect(theme.surface).toMatch(/^#[0-9A-Fa-f]{6}$/);
      if (theme.Element !== null) expect(typeof theme.Element).toBe("function");
    }
  });

  it("the fallback for every slot is a default unlock in the catalogue", () => {
    // What a guest or a fresh account sees must be something everybody owns.
    const entries = seedEntries();
    expect(entries.get(DEFAULT_ASSET_KEYS.avatar)).toBe("default");
    expect(entries.get(DEFAULT_ASSET_KEYS.card_back)).toBe("default");
    expect(entries.get(DEFAULT_ASSET_KEYS.table_theme)).toBe("default");
  });
});
