/**
 * WHAT ONE CLIENT REQUEST MAY ASK THE SERVER TO DO.
 *
 * Phase 11 attacked the running system rather than reading the grants, and the
 * three findings below are one shape: *a client names how much work happens, and
 * nothing says how much is too much.* None of them is an authorization defect —
 * every row involved is a row the caller is entitled to — which is exactly why
 * the authorization sweeps in `rls-idor` and `object-substitution` could not see
 * any of them.
 *
 *   * `leaderboard_*` took `p_limit` from the caller unbounded. Measured:
 *     `p_limit => 2147483647` answered HTTP 200 with every ranked row.
 *   * `register_push_token` had no per-account ceiling. Measured: **200 rows in
 *     1.9 s**, and `pending_push_deliveries` JOINS notifications to tokens, so
 *     each of those is another copy of every message the account is ever sent.
 *   * `search_players` built a LIKE pattern from unescaped input, so the
 *     two-character minimum its own comment relies on — "a one-character query
 *     would return most of the table" — was defeated by `'%%'`. Measured: 108
 *     calls, **445 distinct accounts**, nothing refused.
 *
 * `supabase/tests/25_bounded_reads.test.sql` proves the two CEILINGS bite, by
 * moving them to a number a fixture can exceed. This file proves the same three
 * things where a client actually stands: over HTTP, holding a real token.
 *
 * A SKIP IS NOT A PASS — see `stack-guard.ts`.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { stackUp } from "./stack-guard.js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const REST = `${SUPABASE_URL}/rest/v1`;
const AUTH_ADMIN = `${SUPABASE_URL}/auth/v1/admin/users`;

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Backdated `iat` — PostgREST refuses one that is ahead of its own clock. */
function signToken(sub: string): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({
    sub,
    role: "authenticated",
    aud: "authenticated",
    iat: Math.floor(Date.now() / 1000) - 60,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const signature = crypto
    .createHmac("sha256", LOCAL_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function createUser(prefix: string): Promise<string> {
  const response = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      email: `${prefix}-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return json.id;
}

async function rpc(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${REST}/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args),
  });
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    body = raw;
  }
  return { status: response.status, body, raw };
}

/** Throws rather than returning a sentinel — a harness error must not read as a result. */
async function rowCount(token: string, path: string): Promise<number> {
  const response = await fetch(`${REST}/${path}`, {
    headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  const raw = await response.text();
  if (response.status !== 200) throw new Error(`GET ${path} answered ${response.status}: ${raw}`);
  const rows = JSON.parse(raw) as unknown;
  if (!Array.isArray(rows)) throw new Error(`GET ${path} did not answer a list: ${raw}`);
  return rows.length;
}

const suite = stackUp ? describe : describe.skip;

suite("a leaderboard page has a ceiling", () => {
  let token = "";
  beforeAll(async () => {
    token = signToken(await createUser("bounded-board"));
  });

  it("answers a 2,147,483,647-row page with at most the ceiling", async () => {
    /*
     * The LOCAL board is far below 10,000, so this assertion cannot show the
     * clamp biting — `25_bounded_reads.test.sql` does that by moving the ceiling
     * to three. What it proves here is the half a pgTAP file cannot: that the
     * clamp is on the path a CLIENT reaches, over PostgREST, with a real token,
     * and that an absurd page is answered rather than refused.
     */
    const huge = await rpc(token, "leaderboard_weekly_xp", {
      p_limit: 2_147_483_647,
      p_offset: 0,
    });
    expect(huge.status).toBe(200);
    expect(Array.isArray(huge.body)).toBe(true);
    expect((huge.body as unknown[]).length).toBeLessThanOrEqual(10_000);

    // And every board, so a fifth one added later is not the unbounded one.
    for (const board of [
      "leaderboard_tournament_wins",
      "leaderboard_strategy_accuracy",
    ] as const) {
      const answer = await rpc(token, board, { p_limit: 2_147_483_647, p_offset: 0 });
      expect(answer.status, board).toBe(200);
      expect((answer.body as unknown[]).length, board).toBeLessThanOrEqual(10_000);
    }
    const daily = await rpc(token, "leaderboard_daily_challenge", {
      p_date: null,
      p_limit: 2_147_483_647,
      p_offset: 0,
    });
    expect(daily.status).toBe(200);
    expect((daily.body as unknown[]).length).toBeLessThanOrEqual(10_000);
  });

  it("still pages the way the client asks, and still answers my position", async () => {
    // The regression that would matter more than the finding: the client asks
    // for PAGE_SIZE (25), and `my_leaderboard_position` reads a board at the
    // ceiling to find the caller. Clamping below what it asks for would leave
    // every player outside the top page quietly without a position.
    const page = await rpc(token, "leaderboard_weekly_xp", { p_limit: 25, p_offset: 0 });
    expect(page.status).toBe(200);
    expect((page.body as unknown[]).length).toBeLessThanOrEqual(25);

    const position = await rpc(token, "my_leaderboard_position", { p_category: "weekly_xp" });
    expect(position.status).toBe(200);
    expect(Array.isArray(position.body)).toBe(true);
  });
});

suite("an account holds a bounded number of devices", () => {
  let userId = "";
  let token = "";
  beforeAll(async () => {
    userId = await createUser("bounded-push");
    token = signToken(userId);
  });

  it("keeps ten registrations out of forty, including the one just made", async () => {
    let accepted = 0;
    let lastToken = "";
    for (let i = 0; i < 40; i += 1) {
      lastToken = `ExponentPushToken[${crypto.randomUUID()}]`;
      const answer = await rpc(token, "register_push_token", {
        p_token: lastToken,
        p_platform: "ios",
        p_device_id: crypto.randomUUID(),
        p_kinds: ["your_turn"],
        // Device writes are ordered (B-H4); each token is a new device.
        p_revision: 1,
      });
      // EVICTS, never refuses. A player who really has replaced a phone eleven
      // times must still be able to register the eleventh.
      expect(answer.status, answer.raw).toBeLessThan(300);
      accepted += 1;
    }
    expect(accepted).toBe(40);

    // `user_id=eq.` is not decoration: a read through RLS is scoped to what the
    // POLICY permits, not to "your own rows".
    expect(await rowCount(token, `push_tokens?user_id=eq.${userId}&select=id`)).toBe(10);

    // The registration the caller just made must be one of the survivors, or the
    // call that registered the device is the call that unregistered it.
    expect(
      await rowCount(
        token,
        `push_tokens?user_id=eq.${userId}&token=eq.${encodeURIComponent(lastToken)}&select=id`,
      ),
    ).toBe(1);
  }, 30_000);
});

suite("the player directory is searched as text, and not without limit", () => {
  let token = "";
  let targetId = "";
  let handle = "";

  beforeAll(async () => {
    token = signToken(await createUser("bounded-search"));
    targetId = await createUser("bounded-target");
    handle = `zebra${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const patch = await fetch(`${REST}/profiles?id=eq.${targetId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: LOCAL_ANON_KEY,
        Authorization: `Bearer ${signToken(targetId)}`,
      },
      body: JSON.stringify({ username: handle, display_name: "Zebra Tester" }),
    });
    if (patch.status >= 300) throw new Error(`could not name the target: ${await patch.text()}`);
  });

  it("treats % and _ as characters, not as a wildcard", async () => {
    /*
     * `search_players` returns at most 25 rows and requires two characters, and
     * the comment on that guard says why: "a one-character query would return
     * most of the table; make the caller be specific". `'%%'` is two characters
     * that match everything, so the guard held only against people who were not
     * trying. Measured before the fix: `'%%'`, `'__'`, `'_a'` and `'%a'` each
     * answered 25 rows on a database where `'zz'` answered none.
     */
    for (const query of ["%%", "__", "_a", "%a", "%zebra%"]) {
      const answer = await rpc(token, "search_players", { p_query: query });
      expect(answer.status, `${query}: ${answer.raw}`).toBe(200);
      expect((answer.body as unknown[]).length, query).toBe(0);
    }
  });

  it("still finds a player by prefix, by handle and by part of a display name", async () => {
    // The finding is worth nothing if the fix broke search. Escaping must change
    // what a metacharacter means and nothing else.
    for (const query of [handle.slice(0, 5), handle, "Zebra", "ebra Tes"]) {
      const answer = await rpc(token, "search_players", { p_query: query });
      expect(answer.status, `${query}: ${answer.raw}`).toBe(200);
      const found = (answer.body as { id: string }[]).some((row) => row.id === targetId);
      expect(found, query).toBe(true);
    }
  });

  it("refuses a directory walk, with a code and a sentence the client can show", async () => {
    /*
     * Escaping bounds what ONE query returns; only a limit bounds how many
     * queries there are. Every other social action was already limited —
     * `friend_request`, `room_create`, `room_join`, `matchmaking_enroll` — and
     * the directory search was the one that was not.
     *
     * A FRESH account, because the budget is per player: reusing the account
     * above would spend a budget the assertions above already drew on.
     */
    const walker = signToken(await createUser("bounded-walk"));
    const seen = new Set<string>();
    let refusals = 0;
    let accepted = 0;
    let firstRefusal: { status: number; code: unknown; message: unknown } | null = null;

    for (const character of "abcdefghijklmnopqrstuvwxyz0123456789") {
      for (const pattern of [`%${character}`, `${character}%`, `_${character}`]) {
        const answer = await rpc(walker, "search_players", { p_query: pattern });
        if (answer.status === 200) {
          accepted += 1;
          const rows = answer.body as { id: string; username: string; display_name: string }[];
          expect(rows.length).toBeLessThanOrEqual(25);
          for (const row of rows) {
            // Generated word_word names legitimately contain underscores.
            // Each result must match the LITERAL text, never wildcard semantics.
            expect(row.username.startsWith(pattern) || row.display_name.toLowerCase().includes(pattern), `${pattern}: ${row.username}`).toBe(true);
            seen.add(row.id);
          }
          continue;
        }
        refusals += 1;
        const body = answer.body as { code?: unknown; message?: unknown };
        firstRefusal ??= { status: answer.status, code: body.code, message: body.message };
      }
    }

    // 108 calls. Before this phase: 0 refused, 445 distinct accounts enumerated.
    expect(accepted).toBe(30);
    expect(refusals).toBe(78);
    // This known visible player contains neither metacharacter: even a single
    // returned row would prove wildcard injection, regardless of global fixtures.
    expect(seen.has(targetId)).toBe(false);

    // `PTnnn` is the SQLSTATE PostgREST renders as HTTP nnn. The username rename
    // limit once raised `55000` and told a player the server had broken.
    expect(firstRefusal?.status).toBe(429);
    expect(firstRefusal?.code).toBe("PT429");
    // A refusal must name something the player can do, so the sentence carries
    // the ceiling and when it clears.
    expect(String(firstRefusal?.message)).toMatch(/limit of \d+ for this action/);
    expect(String(firstRefusal?.message)).toMatch(/try again in/);
  }, 30_000);
});
