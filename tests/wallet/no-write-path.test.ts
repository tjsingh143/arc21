/**
 * There is no client code path that writes a balance.
 *
 * The database already guarantees this four ways: `authenticated` holds `SELECT`
 * and nothing else on `wallets` and `wallet_ledger`, neither table has an
 * INSERT/UPDATE/DELETE policy, a guard trigger refuses client writes underneath,
 * and `apply_wallet_delta` is executable by `service_role` only.
 *
 * So why test the client at all? Because those are the controls that stop an
 * attack, and this is the control that stops an *accident*. The realistic
 * regression is not somebody forging a ledger row — that fails at the database.
 * It is somebody adding an optimistic local balance update to make a screen feel
 * faster, and shipping a client whose displayed chips disagree with the server's.
 *
 * This scans the source rather than the behaviour, deliberately. A behavioural
 * test can only catch a write that is on a path a test happens to exercise; a
 * source scan catches the line the moment it is written.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;

const SCANNED = [
  "src/features/wallet",
  "src/features/auth",
  "src/lib/supabase",
];

function sourceFiles(relative: string): string[] {
  const absolute = join(ROOT, relative);
  const out: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(path);
    }
  };

  walk(absolute);
  return out;
}

/** Strips comments so prose *about* writes does not read as a write. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const FILES = SCANNED.flatMap(sourceFiles);

/**
 * The only server functions client code may call.
 *
 * Both take no arguments, which is the property that actually matters: each
 * derives the caller from the verified session and decides everything itself,
 * so neither can carry a number of chips or somebody else's user id. Adding to
 * this list is fine; adding one that accepts parameters is not.
 */
const ALLOWED_RPCS = ["claim_recovery_grant", "delete_own_account"];

describe("the scan itself", () => {
  it("actually found the source", () => {
    // A scan over an empty file list passes vacuously and proves nothing, which
    // is exactly how this kind of test rots.
    expect(FILES.length).toBeGreaterThan(10);
    expect(FILES.some((path) => path.endsWith("wallet-gateway.ts"))).toBe(true);
  });
});

describe("no client write reaches the database", () => {
  it.each(FILES)("%s issues no insert, upsert or rpc", (file) => {
    const source = code(readFileSync(file, "utf8"));

    expect(source, `${file} calls .insert()`).not.toMatch(/\.insert\s*\(/);
    expect(source, `${file} calls .upsert()`).not.toMatch(/\.upsert\s*\(/);
    // `apply_wallet_delta` is executable by service_role only, so naming it
    // here could only ever be a mistake.
    expect(source, `${file} names apply_wallet_delta`).not.toContain("apply_wallet_delta");

    /*
     * Two RPCs are permitted from client code: `claim_recovery_grant` and
     * `delete_own_account`.
     *
     * This used to be a blanket ban, which was too blunt — the Recovery Grant
     * is a required feature and a claim has to reach the server somehow. The
     * property actually worth protecting is not "no rpc", it is **no client
     * code path names an amount of chips**. So the ban is now specific, and it
     * is paired with the argument check below, which is the stronger half.
     */
    for (const call of source.matchAll(/\.rpc\s*\(\s*(["'`])([\w-]+)\1([^)]*)\)/g)) {
      expect(ALLOWED_RPCS, `${file} calls an unexpected rpc`).toContain(call[2]);
      // No second argument: the server derives identity, eligibility and the
      // top-up itself. A params object here would be a number of chips chosen
      // by the client, which is the thing this whole file exists to prevent.
      expect((call[3] ?? "").trim(), `${file} passes arguments to an rpc`).toBe("");
    }
  });

  it.each(FILES)("%s only ever selects from a table", (file) => {
    const source = code(readFileSync(file, "utf8"));

    // Every `from("table")` must be followed immediately by `.select(`.
    for (const match of source.matchAll(/\.from\((["'`])(\w+)\1\)\s*\.(\w+)\s*\(/g)) {
      expect(match[3], `${file}: .from("${match[2] ?? ""}") followed by .${match[3] ?? ""}()`).toBe(
        "select",
      );
    }
  });

  it("never writes to wallets or wallet_ledger under any spelling", () => {
    for (const file of FILES) {
      const source = code(readFileSync(file, "utf8"));
      for (const table of ["wallets", "wallet_ledger"]) {
        if (!source.includes(`"${table}"`)) continue;
        // The only permitted verb on either table, client-side, is select.
        const verbs = [...source.matchAll(/\.from\((["'`])(\w+)\1\)\s*\.(\w+)\s*\(/g)]
          .filter((match) => match[2] === table)
          .map((match) => match[3]);
        expect(new Set(verbs), `${file} → ${table}`).toEqual(new Set(["select"]));
      }
    }
  });
});

describe("the wallet module cannot express a write", () => {
  it("exports nothing whose name suggests one", async () => {
    const wallet: Record<string, unknown> = await import("../../src/features/wallet/index.js");

    const suspicious = Object.keys(wallet).filter((name) =>
      /^(set|write|credit|debit|grant|claim|apply|award|add|deduct|transfer)/.test(name),
    );

    // `setWalletGateway` is the test seam and is expected; anything else is a
    // new verb that needs justifying.
    expect(suspicious).toEqual(["setWalletGateway"]);
  });

  it("exposes only asks on the gateway, never a write", async () => {
    const { createUnconfiguredWalletGateway } = await import(
      "../../src/features/wallet/wallet-gateway.js"
    );
    const gateway = createUnconfiguredWalletGateway("no server");

    // Both methods are questions. Neither accepts an argument, so neither can
    // carry an amount — which is what makes the pair safe, not their number.
    expect(Object.keys(gateway).sort()).toEqual(["claimRecoveryGrant", "fetch", "kind"]);
    expect(gateway.fetch.length, "fetch takes no argument").toBe(0);
    expect(gateway.claimRecoveryGrant.length, "claimRecoveryGrant takes no argument").toBe(0);
  });
});

describe("no server secret can reach the bundle", () => {
  it("never reads a service-role key or a database URL from the environment", () => {
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      const references = [...source.matchAll(/process\.env\.(\w+)/g)].map((match) => match[1]);

      for (const name of references) {
        // Only EXPO_PUBLIC_ values are compiled into the app, and only these two
        // are safe to be there.
        expect(
          [
            "EXPO_PUBLIC_SUPABASE_URL",
            "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
          ],
          `${file} reads process.env.${name ?? ""}`,
        ).toContain(name);
      }
    }
  });
});
