/**
 * Every screen this app navigates to is a screen that exists.
 *
 * THE DEFECT THIS GATE EXISTS FOR. Quick Play shipped three controls pointing
 * at routes that are not routes: "Play Practice" and "Play Practice instead"
 * sent the player to `/game` (the file is `app/game/practice.tsx`, so the route
 * is `/game/practice`), and "Create an account" sent them to `/auth/sign-up`
 * (it is `/(auth)/create-account`). One of the three is the specification's own
 * answer to a player who cannot afford the tier they picked — *"offer: lower
 * tier / Practice / eligible Recovery Grant"* — so the recovery path from an
 * empty balance ended on expo-router's unmatched-route screen.
 *
 * WHY NOTHING CAUGHT IT. `app.json` sets `experiments.typedRoutes`, which
 * writes `.expo/types/router.d.ts`; that file's module augmentation is the only
 * thing that makes `router.push("/nowhere")` a type error. `tsconfig.json`
 * listed it under `include` AND listed `.expo` under `exclude`, and `exclude`
 * filters `include` — so the augmentation was never in the program and typed
 * routes checked nothing for the life of the project. The `exclude` is fixed,
 * but the generated file is gitignored: a fresh checkout typechecks clean with
 * no route checking at all, which is the "a coverage threshold that matches no
 * files reads as enforcement" shape this repository already keeps a list of.
 *
 * So the gate lives HERE, reading the route tree off disk and the navigation
 * targets out of the source, and needs nothing generated to work.
 *
 * WHAT A FAILURE HERE MEANS. Either the target is a typo, or a screen was moved
 * or renamed and one of its callers was missed. It is never fixed by adding the
 * string to a list.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_KINDS,
  destinationFor,
  pathFor,
} from "../../src/features/notifications/notifications.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const APP = join(ROOT, "app");

/** Where a navigation target could legitimately be written. */
const SCANNED = ["app", "src"];

// ---------------------------------------------------------------------------
// The route tree, read off disk
// ---------------------------------------------------------------------------

/**
 * Every route `expo-router` will serve, as a file-system route pattern.
 *
 * `app/(tabs)/home.tsx` yields BOTH `/(tabs)/home` and `/home`: a group's
 * parenthesised segment is optional in a href, and this app writes it both
 * ways — `/(auth)/create-account` in one place and `/social` in another.
 */
function routePatterns(): string[] {
  const patterns = new Set<string>();

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.endsWith(".tsx") && !entry.endsWith(".ts")) continue;
      // `_layout` is not a route, and neither is anything expo-router treats
      // as a convention file (`+not-found`, `+html`).
      if (entry.startsWith("_") || entry.startsWith("+")) continue;

      const withoutExtension = relative(APP, path).replace(/\.[jt]sx?$/, "");
      const segments = withoutExtension.split("/").filter((s) => s !== "index");
      const full = `/${segments.join("/")}`;
      patterns.add(full === "/" ? "/" : full);

      const withoutGroups = segments.filter((s) => !/^\(.*\)$/.test(s));
      patterns.add(withoutGroups.length === 0 ? "/" : `/${withoutGroups.join("/")}`);
    }
  };

  walk(APP);
  return [...patterns].sort();
}

const ROUTES = routePatterns();

/** Turns `/career/[slug]` into a matcher for `/career/anything`. */
function matcherFor(pattern: string): RegExp {
  const body = pattern
    .split("/")
    .filter((s) => s.length > 0)
    .map((segment) => {
      if (/^\[\.\.\..+\]$/.test(segment)) return ".+";
      if (/^\[.+\]$/.test(segment)) return "[^/]+";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^/${body}$`);
}

const MATCHERS = ROUTES.map((pattern) => ({ pattern, matcher: matcherFor(pattern) }));

function resolves(target: string): boolean {
  const path = target.split("?")[0]?.split("#")[0] ?? target;
  return MATCHERS.some(({ matcher }) => matcher.test(path));
}

// ---------------------------------------------------------------------------
// The targets, read out of the source
// ---------------------------------------------------------------------------

interface Target {
  readonly file: string;
  readonly line: number;
  readonly value: string;
}

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(path);
    }
  };
  walk(join(ROOT, directory));
  return out;
}

/**
 * The syntactic positions a route can be written in, in this repository.
 *
 * A template literal is normalised by replacing each `${…}` with a placeholder
 * segment, so `` `/career/${node.slug}` `` is asked about as `/career/x` and is
 * answered by `/career/[slug]`.
 */
const PATTERNS: readonly RegExp[] = [
  /\brouter\.(?:push|replace|navigate|prefetch|dismissTo)\(\s*(["'`])(\/[^"'`\n]*)\1/g,
  /\bpathname\s*:\s*(["'`])(\/[^"'`\n]*)\1/g,
  /\broute\s*:\s*(["'`])(\/[^"'`\n]*)\1/g,
  /\bhref\s*=\s*\{?\s*(["'`])(\/[^"'`\n]*)\1/g,
  /\bhref\s*:\s*(["'`])(\/[^"'`\n]*)\1/g,
];

function collectTargets(): Target[] {
  const found: Target[] = [];

  for (const directory of SCANNED) {
    for (const file of sourceFiles(directory)) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (const pattern of PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          const raw = match[2];
          if (raw === undefined) continue;
          const value = raw.replace(/\$\{[^}]*\}/g, "x");
          const before = text.slice(0, match.index ?? 0);
          found.push({
            file: relative(ROOT, file),
            line: before.split("\n").length,
            value,
          });
          void lines;
        }
      }
    }
  }

  return found;
}

const TARGETS = collectTargets();

// ---------------------------------------------------------------------------

describe("the route tree", () => {
  it("was read off disk and is not empty", () => {
    // A scan that finds nothing passes having proved nothing — the same trap as
    // a coverage gate whose include pattern matches no files.
    expect(ROUTES.length).toBeGreaterThan(20);
    expect(ROUTES).toContain("/game/practice");
    expect(ROUTES).toContain("/(auth)/create-account");
    expect(ROUTES).toContain("/create-account");
    expect(ROUTES).toContain("/table/[gameId]");
  });

  it("does not contain the routes the dead controls named", () => {
    // Positive control for the matcher: these are the two strings that shipped,
    // so a matcher loose enough to accept them would make this file useless.
    expect(resolves("/game")).toBe(false);
    expect(resolves("/auth/sign-up")).toBe(false);
  });
});

describe("every navigation target in the app", () => {
  it("was found by the scan", () => {
    expect(TARGETS.length).toBeGreaterThan(25);
  });

  it("resolves to a screen that exists", () => {
    const unresolved = TARGETS.filter((target) => !resolves(target.value)).map(
      (target) => `${target.file}:${target.line} → ${target.value}`,
    );
    expect(unresolved).toEqual([]);
  });
});

describe("every notification destination", () => {
  /*
   * `pathFor` builds its paths by hand rather than from a route constant, and a
   * tapped push is the one navigation nobody exercises by walking the app. The
   * kinds carrying a parameter are asked with a well-formed one, because
   * `destinationFor` deliberately falls back to a parameterless screen when the
   * payload's is not the shape of the thing it claims to be.
   */
  it("resolves to a screen that exists", () => {
    const data = {
      room_code: "ABC123",
      game_id: "11111111-2222-4333-8444-555555555555",
    };

    const unresolved = NOTIFICATION_KINDS.filter(
      (kind) => !resolves(pathFor(destinationFor({ kind, data }))),
    );

    expect(unresolved).toEqual([]);
  });

  it("resolves for a payload carrying nothing usable, too", () => {
    const unresolved = NOTIFICATION_KINDS.filter(
      (kind) => !resolves(pathFor(destinationFor({ kind, data: {} }))),
    );

    expect(unresolved).toEqual([]);
  });
});
