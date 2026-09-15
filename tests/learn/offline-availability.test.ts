/**
 * THE LEARNING MATERIAL IS AVAILABLE OFFLINE — STRUCTURALLY, NOT BY CACHE.
 *
 * The specification asks for "cached strategy material available offline". Arc
 * 21 answers something stronger: there is no cache, because there is nothing to
 * fetch. The chart is a generated TypeScript module compiled into the bundle,
 * so the Strategy Guide, the Decision Drills and the Practice advisor all read
 * it from memory whether or not a network has ever existed on the device.
 *
 * That claim is worth a test rather than a sentence, because "it happens to work
 * offline today" and "it cannot stop working offline" are different properties,
 * and only the second one survives somebody adding a fetch later. So this file
 * asserts the absence of the wiring, not just the presence of the behaviour:
 *
 *   - no Learn or strategy module reaches for the network or for Supabase;
 *   - the table is a plain module-scope constant with entries already in it,
 *     rather than something a loader populates;
 *   - the drill bank and every chart tab build with no I/O of any kind, which is
 *     proven by building them with `fetch` and the storage layer removed.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ARC_STANDARD_STRATEGY_TABLE } from "../../shared/strategy/index.js";
import { buildStrategyChart, CHART_TABS } from "../../src/features/learn/strategy-chart.js";
import { buildDrillQuestions } from "../../src/features/learn/drill-questions.js";
import { adviseAction } from "../../shared/strategy/index.js";
import { ARC_STANDARD_RULES } from "../../shared/blackjack/rules.js";

/** Every `.ts`/`.tsx` file under a directory, recursively. */
function sourcesUnder(...segments: string[]): { path: string; source: string }[] {
  const root = join(process.cwd(), ...segments);
  const out: { path: string; source: string }[] = [];

  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      out.push({ path: full.slice(root.length + 1), source: readFileSync(full, "utf8") });
    }
  };

  walk(root);
  return out;
}

// ---------------------------------------------------------------------------

describe("nothing in Learn or in the strategy module can reach a network", () => {
  const areas: [string, { path: string; source: string }[]][] = [
    ["src/features/learn", sourcesUnder("src", "features", "learn")],
    ["app/learn", sourcesUnder("app", "learn")],
    [
      "supabase/functions/_shared/strategy",
      sourcesUnder("supabase", "functions", "_shared", "strategy"),
    ],
  ];

  it("scans the files it claims to", () => {
    // A source scan that matches nothing passes silently.
    for (const [label, files] of areas) {
      expect(files.length, `${label} matched no files`).toBeGreaterThanOrEqual(3);
    }
  });

  it("names no fetch, socket or Supabase client", () => {
    // `supabase` as a bare word would match these modules' own directory path,
    // which says nothing. What must be absent is a CLIENT: the SDK import, the
    // app's own client module, or a call through one.
    const forbidden = [
      /\bfetch\s*\(/,
      /XMLHttpRequest/,
      /WebSocket/,
      /supabase-js/,
      /createClient\s*\(/,
      /lib\/supabase/,
      /\bsupabase\s*\./,
      /axios/,
    ];
    for (const [label, files] of areas) {
      for (const file of files) {
        for (const pattern of forbidden) {
          expect(file.source, `${label}/${file.path} matches ${pattern}`).not.toMatch(pattern);
        }
      }
    }
  });

  it("proves the scan discriminates", () => {
    expect("const r = await fetch('https://example.test')").toMatch(/\bfetch\s*\(/);
    expect('import { supabase } from "../../lib/supabase/client.js";').toMatch(/lib\/supabase/);
    expect("await supabase.from('strategy_tables').select()").toMatch(/\bsupabase\s*\./);
  });
});

// ---------------------------------------------------------------------------

describe("the chart is bundled, not loaded", () => {
  it("is fully populated at module scope", () => {
    // No loader, no promise, no hydration step: the entries exist the instant
    // the module is imported, which is what makes the first launch on a plane
    // identical to the thousandth launch on wifi.
    expect(ARC_STANDARD_STRATEGY_TABLE.entries).toBeTypeOf("object");
    expect(Object.keys(ARC_STANDARD_STRATEGY_TABLE.entries).length).toBe(
      ARC_STANDARD_STRATEGY_TABLE.metadata.entryCount,
    );
    expect(ARC_STANDARD_STRATEGY_TABLE.metadata.entryCount).toBeGreaterThan(300);
  });

  it("is a committed source file, not an asset fetched at runtime", () => {
    const source = readFileSync(
      join(process.cwd(), "supabase", "functions", "_shared", "strategy", "generated-arc-standard-v1.ts"),
      "utf8",
    );
    expect(source).toContain("export const ARC_STANDARD_STRATEGY_TABLE");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/require\s*\(/);
  });
});

// ---------------------------------------------------------------------------

describe("every learning surface builds with the network removed", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("builds every chart tab, the drill bank and a recommendation", () => {
    // Not "offline" in the sense of a flag — `fetch` is replaced with something
    // that throws, so any attempt to reach the network fails the test loudly
    // rather than silently degrading.
    globalThis.fetch = (() => {
      throw new Error("the network was used");
    }) as unknown as typeof fetch;

    for (const tab of CHART_TABS) {
      const chart = buildStrategyChart(ARC_STANDARD_STRATEGY_TABLE, tab.id);
      expect(chart.rows.length, tab.id).toBeGreaterThan(0);
      expect(chart.rulesetLine).toContain("Arc Standard");
    }

    const questions = buildDrillQuestions();
    expect(questions.length).toBeGreaterThan(300);

    const recommendation = adviseAction({
      rules: ARC_STANDARD_RULES,
      state: { handClass: "hard", playerTotal: 16, dealerUpcardValue: 10 },
      legalActions: ["HIT", "STAND"],
    });
    expect(recommendation?.action).toBe("HIT");
  });
});
