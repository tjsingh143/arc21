/**
 * Every action the server accepts is one the app can actually send.
 *
 * THE DEFECT THIS GATE EXISTS FOR, and it is this repository's oldest shape.
 * `RESET_PRIVATE_STACK` was in `shared/contracts/session-command.ts`, had a
 * handler in `create-session` with three correct guards, had its own entry in
 * `structured-log.ts`, and had a `tests/server` case asserting its refusal for a
 * missing game. It was the specification's answer to a private player running
 * out of chips — *"permit a free reset to 5,000 between hands"* — and **no line
 * of `src`, `app` or `scripts` had ever sent it.** A player who busted at a
 * private table sat out every remaining hand of it.
 *
 * Nothing failed. `tsc` cannot notice an action nobody dispatches, the server
 * suite reached the handler directly over HTTP, and the screen fell through to
 * a sentence that reads perfectly — "Waiting for the next hand." — for ever.
 *
 * So this scans the SOURCE, like `tests/wallet/no-write-path.test.ts` and for
 * the same reason: a behavioural test can only catch what some other test
 * happens to exercise, while a scan catches an action the moment it is added
 * with nothing to send it.
 *
 * WHAT A FAILURE HERE MEANS. Either the client half was forgotten, or the
 * action genuinely has no client caller by design — in which case it belongs in
 * `SERVER_ONLY` below, WITH the reason. Adding a name there is a deliberate
 * statement that no player can ever invoke it; it is not a way to quiet the
 * test.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;

/** Where a client caller could legitimately live. */
const SCANNED = ["src", "app", "scripts"];

/**
 * Actions with no client caller ON PURPOSE.
 *
 * Empty today. Every one of the nine session actions and all twelve game
 * commands is reachable from the app — which is the point: this list existing
 * and being empty is a stronger statement than the test passing.
 */
const SERVER_ONLY: ReadonlyMap<string, string> = new Map();

function sourceFiles(relative: string): string[] {
  const absolute = join(ROOT, relative);
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

  walk(absolute);
  return out;
}

const CLIENT_SOURCE = SCANNED.flatMap(sourceFiles)
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

/** The action names the contract declares, read from the contract itself. */
function declaredActions(relative: string): string[] {
  const source = readFileSync(join(ROOT, relative), "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/z\.literal\("([A-Z_]+)"\)/g)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return [...names].sort();
}

describe("the wire contract and the client agree on what can be sent", () => {
  /*
   * Read from the file rather than typed out here. A list typed here would stop
   * covering the contract the moment somebody added an action to it — the same
   * failure as a pgTAP file that names the tables it checks.
   */
  const sessionActions = declaredActions("shared/contracts/session-command.ts");

  it("found the session actions to check", () => {
    // A scan that matches nothing reads as enforcement. CLAUDE.md carries this
    // lesson from a coverage gate that passed against zero files.
    expect(sessionActions.length).toBeGreaterThanOrEqual(9);
    expect(sessionActions).toContain("RESET_PRIVATE_STACK");
    expect(CLIENT_SOURCE.length).toBeGreaterThan(100_000);
  });

  it.each(sessionActions)("`%s` has a client caller", (action) => {
    if (SERVER_ONLY.has(action)) return;
    expect(
      CLIENT_SOURCE.includes(`"${action}"`),
      `${action} is accepted by create-session and nothing in src/, app/ or ` +
        `scripts/ ever sends it. Either wire it up, or record it in SERVER_ONLY ` +
        `with the reason no player may invoke it.`,
    ).toBe(true);
  });

  /**
   * The same question for play, where the answer is not "every one".
   *
   * `LEAVE` is deliberately unsent: the app leaves a table through
   * `CASH_OUT` at `create-session`, which settles the escrow in the same
   * transaction. A client-sent `LEAVE` would take the identical closure path —
   * `game-command` calls `settleTableClosure` too — so this is a choice about
   * which boundary owns the money, not a missing half.
   */
  const gameCommandTypes = (() => {
    const source = readFileSync(join(ROOT, "shared/contracts/game-command.ts"), "utf8");
    const block = source.slice(
      source.indexOf("export const GAME_COMMAND_TYPES"),
      source.indexOf("] as const;", source.indexOf("export const GAME_COMMAND_TYPES")),
    );
    return [...block.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1] as string);
  })();

  it("found the game commands to check", () => {
    expect(gameCommandTypes).toHaveLength(12);
  });

  it.each(gameCommandTypes)("`%s` has a client caller", (type) => {
    if (type === "LEAVE") return; // see above
    expect(
      CLIENT_SOURCE.includes(`"${type}"`),
      `${type} is accepted by game-command and nothing in the app ever sends it.`,
    ).toBe(true);
  });
});
