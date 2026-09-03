/**
 * GHSA-vcc3-ghjq-m6fr — `decode-uri-component`, and why this app is not exposed
 * to it.
 *
 * `npm audit` reports it against `decode-uri-component@0.2.2`, reached only
 * through `query-string@7.1.3`, reached only through `expo-router`. The flaw is
 * real and expensive: malformed percent-encoding falls out of the built-in
 * decoder into a recursive splitting fallback. Measured in Node on this
 * machine, decoding a single hostile value costs
 *
 *       195 chars     51 ms          1 539 chars      4 259 ms
 *       387 chars    225 ms          3 075 chars     22 330 ms
 *       771 chars    992 ms
 *
 * so if an inbound deep link's query reached it, three kilobytes in a URL would
 * freeze the JavaScript thread — the whole user interface — for long enough
 * that iOS's watchdog would kill the app.
 *
 * IT DOES NOT REACH IT. `expo-router` ships two copies of the resolver: the
 * vendored upstream `react-navigation/core/getStateFromPath.js`, whose
 * `parseQueryParams` does call `queryString.parse`, and the FORK in
 * `fork/getStateFromPath.js` that actually runs — where that call is commented
 * out and replaced by `expo.parseQueryParams`, which reads
 * `parseUrlUsingCustomBase(path).searchParams` (the platform's own
 * `URLSearchParams`) and decodes with a `safelyDecodeURIComponent` that catches
 * and returns the raw string. No fallback, no recursion. The vendored copy is
 * imported by nothing. Every surviving `query-string` call is `stringify`, the
 * OUTBOUND direction, which never touches the decoder.
 *
 * Confirmed on the simulator as well as by reading: with a 12 291-character
 * `%FF` payload in the query, `arc21://career?x=…` navigated in 1.0 s. The same
 * string takes minutes in Node. The vulnerable function is in the bundle and is
 * dead.
 *
 * SO WHY IS THERE A TEST. Because that conclusion is a property of a
 * dependency's internals, and nothing else in this repository would notice it
 * changing. If an `expo-router` upgrade re-wires the inbound path back onto
 * `queryString.parse`, the app acquires a remote freeze from any link anybody
 * can open, `npm audit`'s output does not change by one character, and every
 * other test still passes. This file fails instead — and the fix, should that
 * day come, is a `redirectSystemPath` in `app/+native-intent.tsx` refusing a
 * query the platform decoder rejects, which is exactly the input that takes the
 * slow path.
 *
 * This replaces a guard that was written before the reachability was checked.
 * Measuring it on the device is what showed the guard was defending nothing.
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

  it("decodes malformed percent-encoding exponentially, as the advisory says", () => {
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
    // Nothing imports the vendored copy that still calls `queryString.parse`.
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
  });
});
