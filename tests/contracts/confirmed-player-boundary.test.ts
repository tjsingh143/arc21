/**
 * Account-owned code learns who the player is only from the confirmed-player
 * boundary.
 *
 * THE DEFECT THIS GATE EXISTS FOR (Refresh-B B-H1). With the auth server not
 * yet answering for a restored credential and nobody adopted, Inventory's
 * `load()` granted four cosmetics and Daily opened a RANKED game as that
 * credential. Each store had asked `client.auth.getSession()` "is somebody
 * signed in?" — and the SDK serves a restored session before anybody has asked
 * the server whether its account exists. The app's own answer (the Auth store
 * adopts a player only on the server's word) was never consulted.
 *
 * The rule is now one function: `confirmedSession` / `bindCurrentPlayer` in
 * `player-binding.ts` count the SDK's session only when it is the ADOPTED
 * player's (`adopted-player.ts`). This scan keeps it that way, like
 * `every-command-has-a-caller.test.ts` and `no-write-path.test.ts` do for their
 * rules: a behavioural test catches only what some test exercises, while a scan
 * catches a new direct read the moment it is written.
 *
 * WHAT A FAILURE MEANS. Either a store has started asking the SDK who is signed
 * in — route it through `confirmedSession` — or a module talks to the server
 * without the boundary at all. `ALLOWED_DIRECT_READS` is the auth boundary
 * itself; adding to it is a statement that the file decides adoption, not a way
 * to quiet the test.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;

/** The only files that may read the SDK's session or user directly: the ones that decide adoption. */
const ALLOWED_DIRECT_READS: ReadonlyMap<string, string> = new Map([
  ["src/features/auth/supabase-auth-adapter.ts", "the auth adapter: asks the server and decides who is confirmed"],
  ["src/lib/supabase/player-binding.ts", "the boundary itself: counts the SDK session only for the adopted player"],
]);

/** Modules that reach the server, and how each takes part in the boundary. */
const BOUNDARY_IMPORT = /from "[./]*(?:lib\/)?(?:supabase\/)?(?:player-binding|session-intent|adopted-player|game-command)\.js"/;

function sourceFiles(...dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".d.ts")) out.push(path);
    }
  };
  for (const dir of dirs) walk(join(ROOT, dir));
  return out.map((path) => relative(ROOT, path)).sort();
}

const FILES = sourceFiles("src", "app");

/** Files that name these methods without sending anything: the client factory and the generated types. */
const NAMES_WITHOUT_CALLING: ReadonlySet<string> = new Set(["src/lib/supabase/client.ts", "src/lib/supabase/database.types.ts"]);
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");

describe("the confirmed-player boundary (B-H1)", () => {
  it("scans the files it claims to scan", () => {
    // A scan over nothing passes having proved nothing.
    expect(FILES.length).toBeGreaterThan(150);
    expect(FILES).toContain("src/features/cosmetics/cosmetics-store.ts");
    expect(FILES).toContain("src/features/daily/daily-store.ts");
    for (const file of ALLOWED_DIRECT_READS.keys()) expect(FILES).toContain(file);
  });

  it.each(FILES)("%s does not ask the SDK who is signed in", (file) => {
    if (ALLOWED_DIRECT_READS.has(file)) return;
    const source = read(file);
    expect(source).not.toMatch(/\.auth\s*\.\s*getSession\s*\(/);
    expect(source).not.toMatch(/\.auth\s*\.\s*getUser\s*\(/);
  });

  it.each(FILES.filter((file) => /\.(rpc|functions\.invoke)\s*\(|\.from\(\s*"|\.channel\(/.test(read(file))))(
    "%s reaches the server, and does so through the boundary",
    (file) => {
      // The auth adapter IS the boundary's other half; the generated types and
      // the client factory name these methods without calling the server.
      if (ALLOWED_DIRECT_READS.has(file) || NAMES_WITHOUT_CALLING.has(file)) return;
      expect(read(file)).toMatch(BOUNDARY_IMPORT);
    },
  );

  it("the production client is identity-managed from birth and sends through the dispatch floor", () => {
    const source = read("src/lib/supabase/client.ts");
    expect(source).toMatch(/fetch:\s*adoptionGatedFetch\(/);
    expect(source).toMatch(/manageIdentity\(client\)/);
  });

  it("the Auth store publishes every change of the player it shows", () => {
    const source = read("src/features/auth/auth-store.ts");
    expect(source).toMatch(/useAuthStore\.subscribe\(publishAdoption\)/);
  });
});
