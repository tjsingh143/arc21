/**
 * GHSA-vcc3-ghjq-m6fr: guard the current Expo inbound-link boundary.
 *
 * decode-uri-component@0.2.2 is bundled through query-string@7. Expo supplies
 * its forked resolver, whose inbound query parsing uses URLSearchParams and
 * bounded built-in decoding. The upstream parser remains bundled but is
 * overridden; active query-string calls construct outbound URLs.
 *
 * These checks cover the installed dependency graph and resolver wiring. The
 * upstream dangerous call is a positive control for the source scan. The CPU
 * check establishes the malformed-input hazard without claiming its asymptotic
 * complexity or extrapolating an iOS watchdog outcome from a Node timing.
 *
 * Native Release results and the matching source-map inventory are recorded in
 * docs/astra-refresh/dependency-disposition.md. Recheck both when the installed
 * router, parser or dependency graph changes; presence in the bundle alone
 * neither proves nor disproves exposure through the application's entry points.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

const routerFile = (relative: string) =>
  readFileSync(require.resolve(`expo-router/build/${relative}`), "utf8");

/** Comments are stripped so a commented-out call is never read as a live one. */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the hazard is real", () => {
  it("is still the vulnerable version, so this file is still worth running", () => {
    const installed = require("decode-uri-component/package.json") as { version: string };
    // The advisory covers <= 0.4.2; 0.5.0 is the fix and is ESM-only, which
    // `query-string@7`'s `require()` cannot load — that is why no override.
    expect(installed.version).toBe("0.2.2");
  });

  it("spends excessive CPU in the malformed-encoding fallback", () => {
    const decode = require("decode-uri-component") as (value: string) => string;
    const payload = "%" + "FF%".repeat(400) + "FF";

    const started = performance.now();
    decode(payload);
    const cost = performance.now() - started;

    expect(
      cost,
      `${payload.length} hostile characters decoded in ${cost.toFixed(0)} ms — if this is now ` +
        "fast the advisory has been fixed and this whole file can go",
    ).toBeGreaterThan(100);
  });
});

describe("and the inbound deep-link path does not go near it", () => {
  it("resolves an incoming URL with the fork, not the vendored upstream copy", () => {
    const linking = withoutComments(routerFile("getLinkingConfig.js"));
    expect(linking).toMatch(/getStateFromPath/);
    expect(linking).toContain('require("./link/linking")');
    expect(withoutComments(routerFile("link/linking.js"))).toContain('require("../fork/getStateFromPath")');
    // The override cannot resolve to the core fallback that still parses.
    for (const file of ["getLinkingConfig.js", "fork/getStateFromPath.js"]) {
      expect(withoutComments(routerFile(file))).not.toMatch(/react-navigation\/core\/getStateFromPath/);
    }
  });

  it("parses the query with URLSearchParams and a decoder that cannot recurse", () => {
    const forks = withoutComments(routerFile("fork/getStateFromPath-forks.js"));
    expect(forks).toMatch(/function parseQueryParams/);
    expect(forks).toMatch(/parseUrlUsingCustomBase\)?\(path\)\.searchParams/);
    expect(forks).toMatch(/function safelyDecodeURIComponent/);
    // The whole point: the live resolver never requires `query-string`.
    expect(forks).not.toMatch(/require\(["']query-string["']\)/);
    expect(withoutComments(routerFile("fork/getStateFromPath.js"))).not.toMatch(
      /queryString\.parse/,
    );
  });

  it("uses query-string only to BUILD urls, never to read one", () => {
    /*
     * `stringify` encodes with `strict-uri-encode` and never calls
     * `decodeComponent` — verified by reading `query-string/index.js`, where
     * the only call site is inside the parse helper. A live `queryString.parse`
     * anywhere in the router is what would make this app vulnerable.
     */
    const live = [
      "fork/getPathFromState.js",
      "fork/getPathFromState-forks.js",
      "fork/getStateFromPath.js",
      "fork/getStateFromPath-forks.js",
      "getLinkingConfig.js",
    ];
    for (const file of live) {
      expect(withoutComments(routerFile(file)), `${file} parses a query with query-string`).not.toMatch(
        /queryString\.parse\s*\(/,
      );
    }

    /*
     * AND THE PATTERN ABOVE CAN ACTUALLY FIND IT. A "not.toMatch" sweep passes
     * just as happily against a typo, which is the shape of gate this project
     * has shipped broken twice — a coverage threshold matching no files, and a
     * source scan whose directory list never expanded. The vendored upstream
     * copy is the positive control: it still holds the call, so a pattern that
     * cannot see it here is a pattern that proves nothing above.
     */
    const vendored = withoutComments(routerFile("react-navigation/core/getStateFromPath.js"));
    expect(vendored).toMatch(/queryString\.parse\s*\(/);
  });

  it("reaches the vulnerable package through expo-router alone", () => {
    // If a second dependency ever pulls `query-string` in, the reasoning above
    // covers only half the app and this file has to be rewritten.
    const queryStringPath = require.resolve("query-string/package.json");
    expect(queryStringPath).toContain("node_modules/query-string");
    const consumer = require("query-string/package.json") as { version: string };
    expect(consumer.version).toMatch(/^7\./);
    const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")) as {
      packages: Record<string, { dependencies?: Record<string, string> }>;
    };
    const consumers = Object.entries(lock.packages)
      .filter(([, pkg]) => pkg.dependencies?.["query-string"] !== undefined)
      .map(([path]) => path);
    expect(consumers).toEqual(["node_modules/expo-router"]);
  });
});
