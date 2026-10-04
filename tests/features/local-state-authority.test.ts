/**
 * EVERY PIECE OF STATE THIS APP KEEPS ON THE DEVICE, AND WHAT IT CAN REACH.
 *
 * `practice-authority.test.ts` answers this question for the Practice save,
 * which is the biggest of them. This file answers it for the REST of the
 * inventory — career progress, drill history, the guest identity, the settings
 * blob, the Quick Play selection, the onboarding flag — and, more importantly,
 * makes the inventory itself something the source is asked for rather than
 * something a test remembers.
 *
 * That distinction is the whole point. `11_delete_account.test.sql` warned in
 * its own comment that naming the tables it checked would miss a table added
 * later, then named six; sixteen migrations went by. A hand-written list of
 * storage keys would rot the same way, and the key nobody added to the list is
 * exactly the one worth checking. So the list is derived, and a key added
 * tomorrow fails this file until somebody has classified it.
 *
 * THE THREAT. All of this is a SQLite file and a keychain item inside the
 * app's own container. A player with a jailbroken device, a simulator, or a
 * filesystem backup can set any of it to anything. The question is never
 * "can they edit it" — they can — but "supposing they do, what moves?" The
 * answer has to be: local content only. No chips, no XP, no leaderboard, no
 * ranked accuracy, no career reward, no tournament placement, no daily result.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

const FILES = sourceFiles(SRC);
const read = (path: string) => readFileSync(path, "utf8");

/**
 * Comments are removed before any "this symbol must not appear" scan.
 *
 * Both of these modules DESCRIBE the server's wallet movement in their own
 * headers — `quick-play-store.ts` explains that `create-session` debits through
 * `apply_wallet_delta`, and `career-persistence.ts` says in as many words that
 * it has no `rewardClaimed: true` write path. Prose that documents the boundary
 * is the opposite of a breach of it, and a scan that cannot tell the two apart
 * would push people to stop writing the prose.
 */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * The inventory, asked of the source.
 *
 * Every persisted key in this app is declared as a `const … = "…"` whose name
 * ends in `_KEY`, and read or written through `KeyValueStore`. Scanning for the
 * declaration finds them wherever they live.
 */
function declaredStorageKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  for (const path of FILES) {
    for (const match of read(path).matchAll(
      /(?:export\s+)?const\s+([A-Z0-9_]*_KEY)\s*(?::\s*\w+\s*)?=\s*"([^"]+)"/g,
    )) {
      keys.set(match[2]!, path);
    }
  }
  return keys;
}

/**
 * What each key is, and why it cannot be authority. `STRATEGY` marks a value
 * that is not persistence at all — a lookup into the generated chart — and is
 * listed so the scan above does not have to be made cleverer to exclude it.
 */
const CLASSIFIED: Record<string, string> = {
  "practice:session": "Practice save — covered in full by practice-authority.test.ts",
  "practice:stats": "Practice statistics — self-reported, excluded from ranked accuracy",
  "practice:archive": "Quarantined unparseable Practice blob, never read back into play",
  "career:progress": "Local stars and unlocks; chips and XP are settled server-side",
  "career:archive": "Quarantined unparseable career blob",
  "learn:drill-history": "Drill answers for the local Learn screens",
  "settings:v1": "Preferences — sound, motion, contrast, text size, notification toggles",
  "auth:guest:v1": "A guest's local id. Explicitly not a credential; authorises nothing",
  "onboarding:completion": "Whether onboarding has been seen",
  "arc21.quickplay.selection.v1": "Which stake the Quick Play screen last showed",
  "arc21.session-probe":
    "A nonce account deletion's pre-flight writes to the keychain, reads back once and deletes; never read as state, authorises nothing",
  "push:intent-revision:v1":
    "The last intent revision this device sent with a push registration (B-H4). It orders only this device's own notification-preference writes, compared by the server per token; a lowered or forged value can only get the device's own write refused and re-sent above the row. Grants nothing",
  "hard:11:6": "STRATEGY — a chart lookup in the onboarding showcase, not stored state",
};

/**
 * Verbs only the SERVER may perform. A local-persistence module naming any of
 * these is granting something, which is the finding this file exists to catch.
 *
 * Reads are deliberately absent. `quick-play-store.ts` calls
 * `useWalletStore.getState().refresh()` after the server has debited the
 * buy-in, because the header caches the balance and would otherwise keep
 * showing the old number — asking what the wallet now says is the opposite of
 * changing it. An earlier version of this list forbade `useWalletStore`
 * outright and failed on exactly that line, which would have pushed a correct
 * refresh out of the code to satisfy a test.
 */
const PRIVILEGED = [
  "apply_wallet_delta",
  "applyWalletDelta",
  "wallet_ledger",
  "award_milestone_xp",
  "awardMilestoneXp",
  "repeatable_xp",
  "player_daily_xp",
  "tournament_entries",
  "daily_entries",
  "settleCareerReward",
  "record_career_completion",
  "grant_earned_cosmetics_for",
];

/** The only shape in which a local module may touch the wallet at all. */
const WALLET_READ_ONLY = /useWalletStore\.getState\(\)\.refresh\(\)/;

describe("the local-state inventory", () => {
  it("is exactly what has been classified — a new key fails until it is", () => {
    const found = [...declaredStorageKeys().keys()].sort();
    expect(
      found,
      "a storage key exists that nothing has decided is safe. Classify it in CLASSIFIED " +
        "after checking what it can reach, rather than adding it to make this pass.",
    ).toEqual(Object.keys(CLASSIFIED).sort());
  });

  it("finds the keys in the modules that own them", () => {
    const keys = declaredStorageKeys();
    expect(keys.get("career:progress")).toContain(join("features", "career"));
    expect(keys.get("auth:guest:v1")).toContain(join("features", "auth"));
    expect(keys.get("settings:v1")).toContain(join("features", "settings"));
    expect(keys.get("learn:drill-history")).toContain(join("features", "learn"));
  });
});

describe("no module that persists local state can grant anything competitive", () => {
  const owners = () =>
    [...new Set([...declaredStorageKeys()].filter(([key]) => key !== "hard:11:6").map(([, p]) => p))];

  it("covers the files it claims to", () => {
    // The same guard `practice-authority.test.ts` carries: a scan over an empty
    // file list is the empty-fixture mistake in another costume.
    const files = owners();
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it("names no wallet, XP, tournament or reward-GRANTING symbol", () => {
    for (const path of owners()) {
      const source = withoutComments(read(path));
      for (const symbol of PRIVILEGED) {
        expect(source, `${path} names "${symbol}"`).not.toContain(symbol);
      }
    }
  });

  it("proves the scan discriminates", () => {
    /*
     * A `not.toContain` sweep passes just as well against a misspelled symbol
     * or an empty list — the shape of gate this project has shipped broken more
     * than once. The control is the server file that actually pays a career
     * reward: every one of these verbs is a thing only it may do, so the scan
     * must light up on it. That NO file under `src/` can serve as the control
     * is precisely the property being claimed.
     */
    const control = withoutComments(
      readFileSync(join(process.cwd(), "supabase", "functions", "_shared", "career-rewards.ts"), "utf8"),
    );
    const found = PRIVILEGED.filter((symbol) => control.includes(symbol));
    expect(found.length, "the privileged-verb list no longer matches the code that grants").toBeGreaterThanOrEqual(3);
  });
});

describe("the Quick Play selection, which names a buy-in", () => {
  const quickPlay = () => read(join(SRC, "features", "quick-play", "quick-play-store.ts"));

  it("touches the wallet only to re-read it", () => {
    const source = withoutComments(quickPlay())
      .split("\n")
      .filter((line) => !line.startsWith("import "))
      .join("\n");
    for (const use of source.match(/useWalletStore[^;\n]*/g) ?? []) {
      expect(use, `quick-play does something to the wallet other than refresh: ${use}`).toMatch(
        WALLET_READ_ONLY,
      );
    }
  });

  it("accepts a persisted tier only from a fixed list, never as written", () => {
    /*
     * The stored blob names the tier, and the tier decides how many chips leave
     * the wallet — so this is the one local value with a number attached. It is
     * matched against a literal allowlist on load, and the SERVER re-reads the
     * buy-in from the tier rather than being told an amount, so a hand-edited
     * `"tier": "free"` resolves to nothing and falls back to the default.
     */
    const source = withoutComments(quickPlay());
    expect(source).toMatch(/const TIERS: readonly TierId\[\] = \["casual", "standard", "high"\]/);
    expect(source).toMatch(/TIERS\.find\(\(candidate\) => candidate === parsed\.tier\)/);
    expect(source).toMatch(/if \(!tier \|\| !assistance\) return null;/);
    // No amount is ever sent — only the tier's name.
    expect(source).not.toMatch(/buyIn:|buy_in:|amount:/);
  });
});

describe("career progress in particular", () => {
  const persistence = () => read(join(SRC, "features", "career", "career-persistence.ts"));

  it("clamps a hand-edited star count rather than trusting it", () => {
    // Three stars is the maximum a node can hold. An edited 99 must not print
    // ninety-nine stars on the map, so the schema bounds it on the way in.
    expect(persistence()).toMatch(/bestStars:\s*z\.number\(\)\.int\(\)\.min\(0\)\.max\(3\)/);
  });

  it("has no write path for a claimed reward, because the server owns that", () => {
    const source = withoutComments(persistence());
    expect(source).not.toMatch(/rewardClaimed\s*:\s*true/);
    expect(source).not.toMatch(/rewardOwed\s*:\s*true/);
    // The header says exactly this in prose; the assertion is about the code.
    expect(persistence()).toContain("`rewardClaimed: true` write path");
  });

  it("is settled on the server under a key derived from the node and the player", () => {
    /*
     * The one that matters. Even a perfectly forged local progress blob cannot
     * be paid twice, because the ledger's idempotency key names the node and
     * the account — never a client-supplied request id, which a modified client
     * could vary at will to buy a second credit.
     */
    const rewards = readFileSync(
      join(process.cwd(), "supabase", "functions", "_shared", "career-rewards.ts"),
      "utf8",
    );
    expect(rewards).toMatch(/const key = `career_reward:\$\{params\.nodeId\}:\$\{params\.userId\}`/);
    expect(rewards).toMatch(/idempotencyKey: key/);
    // The amounts come from the server's own node definition, not from a payload.
    expect(rewards).toMatch(/params\.node\.reward\.chips/);
    expect(rewards).toMatch(/params\.node\.reward\.xp/);
  });
});
