/**
 * Put the simulator's Arc 21 into the state a NEW INSTALL is actually in.
 *
 * WHY THIS EXISTS, and it is a finding rather than a convenience.
 *
 * `launchApp: clearState: true` does not do what every flow in this repository
 * assumed it does. On iOS it resets permissions and relaunches; it leaves the
 * app's **Documents** directory alone. Measured, not guessed:
 *
 *   $ xcrun simctl get_app_container <udid> com.arc21.app data
 *   …/Documents/SQLite/arc21.db          ← still there after clearState
 *
 * That one file holds onboarding completion, the Practice session and career
 * progress — `SqliteKeyValueStore` is the production path for all three. And
 * `clearState` does not touch the KEYCHAIN either, which is where
 * `src/lib/supabase/client.ts` keeps the Supabase session.
 *
 * So `every-screen.yaml`, whose first assertion is that ONBOARDING is on screen,
 * has never actually started from a fresh install. It passed because the
 * simulator happened to be in the right state, and it failed the moment two
 * flows that sign in had run on the same device — reported as
 * "Assertion is false: id: onboarding-guest is visible", against an app that had
 * done exactly the right thing.
 *
 * WHAT THIS DOES, and what it deliberately does NOT do. It terminates the app,
 * deletes the SQLite file, and resets the simulator keychain. It does not
 * `simctl uninstall`: that once ran for five minutes and left the app MISSING,
 * which reads as a broken flow for every run afterwards, and is recorded in
 * CLAUDE.md for that reason.
 *
 *   npx tsx scripts/e2e-fresh-app.ts [--udid <simulator>] [--keep-keychain]
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const BUNDLE_ID = "com.arc21.app";

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** The booted simulator, unless one was named. */
function bootedUdid(): string {
  const listed = execFileSync("xcrun", ["simctl", "list", "devices", "booted"], {
    encoding: "utf8",
  });
  const match = /\(([0-9A-F-]{36})\) \(Booted\)/.exec(listed);
  if (!match?.[1]) {
    throw new Error(
      "no booted simulator. `xcrun simctl boot <udid>` first — a Maestro run against " +
        "a shut-down simulator exits 0 having done nothing, which is worse than failing.",
    );
  }
  return match[1];
}

function main(): void {
  const udid = argument("udid") ?? bootedUdid();

  // Terminated first, or SQLite writes its in-memory pages back over the file
  // that was just deleted. `|| true` in spirit: an app that is not running is
  // the state we want, not an error.
  try {
    execFileSync("xcrun", ["simctl", "terminate", udid, BUNDLE_ID], { stdio: "ignore" });
  } catch {
    // Not running. Fine.
  }

  let container: string;
  try {
    container = execFileSync("xcrun", ["simctl", "get_app_container", udid, BUNDLE_ID, "data"], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(
      `${BUNDLE_ID} is not installed on ${udid}. Build and install it first:\n` +
        `  LANG=en_US.UTF-8 npx expo run:ios --device ${udid}`,
    );
  }

  const sqlite = join(container, "Documents", "SQLite");
  if (existsSync(sqlite)) {
    rmSync(sqlite, { recursive: true, force: true });
    process.stdout.write("removed the app's SQLite store — onboarding, Practice and Career\n");
  } else {
    process.stdout.write("no SQLite store to remove; the app is already fresh\n");
  }

  if (flag("keep-keychain")) {
    process.stdout.write("keychain left alone (--keep-keychain), so a session may survive\n");
    return;
  }

  // The Supabase session. `clearState: true` does not clear this, which is why a
  // relaunch can show onboarding for a moment and then land on Home.
  execFileSync("xcrun", ["simctl", "keychain", udid, "reset"], { stdio: "ignore" });
  process.stdout.write("reset the simulator keychain — no session survives\n");
}

main();
