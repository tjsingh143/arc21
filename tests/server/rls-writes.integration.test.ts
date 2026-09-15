/**
 * WHAT A SECOND ACCOUNT CAN WRITE — the other half of the IDOR sweep.
 *
 * `rls-idor.integration.test.ts` reads. It walks every client-readable table
 * with a stranger's token and proves the stranger gets nothing. It does not
 * write a single row, so nothing in this repository asserted the DENIED case for
 * an INSERT, an UPDATE or a DELETE against somebody else's data — the three
 * verbs where getting a policy wrong does damage rather than leaking.
 *
 * WHAT IS COVERED, and why it is exactly this. `assert_client_authorization_
 * surface()` refuses any client write grant outside a fixed list of thirteen —
 * `20_authorization_surface.test.sql` runs it — so the list below is complete by
 * construction: a fourteenth grant fails that gate rather than silently slipping
 * past this file. What the gate cannot say is whether the POLICY behind each
 * grant actually scopes it to the owner, which is what this file asks, in the
 * only terms that matter: with a second real token.
 *
 *   profiles:UPDATE        friend_requests:INSERT   friend_requests:UPDATE
 *   friendships:DELETE     blocks:INSERT            blocks:DELETE
 *   loadouts:INSERT        loadouts:UPDATE          push_tokens:INSERT
 *   push_tokens:UPDATE     push_tokens:DELETE       notifications:UPDATE
 *   notifications:DELETE
 *
 * TWO SHAPES OF DENIAL, and both are correct. A write whose row would violate a
 * `with check` is refused outright — HTTP 403, "new row violates row-level
 * security policy". A write whose FILTER selects rows the `using` clause hides
 * matches nothing and answers 200 with an empty list: PostgREST cannot refuse
 * what it cannot see. Asserting "403" everywhere would have been wrong; what
 * matters is that the other account's row is UNCHANGED, so every case below
 * checks the row afterwards rather than trusting the status code.
 *
 * A SKIP IS NOT A PASS. The guard requires a 401 from a function.
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

/** Backdated 60s: PostgREST refuses an `iat` ahead of its own clock. */
function signToken(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({ sub, role: "authenticated", aud: "authenticated", iat: now - 60, exp: now + 3600 });
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
  const body = (await response.json()) as { id?: string };
  // A helper that reads something must THROW when it cannot. Returning a
  // sentinel turns a harness fault into a product failure that reads as real.
  if (!body.id) throw new Error(`could not create ${prefix}: HTTP ${response.status}`);
  return body.id;
}

interface Result {
  status: number;
  body: unknown;
  raw: string;
}

async function write(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  token: string | null,
  payload?: unknown,
): Promise<Result> {
  const headers: Record<string, string> = {
    apikey: LOCAL_ANON_KEY,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${REST}/${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const raw = await response.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* an empty body is a valid answer */
  }
  return { status: response.status, body, raw };
}

async function read(token: string, path: string): Promise<unknown[]> {
  const response = await fetch(`${REST}/${path}`, {
    headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  const raw = await response.text();
  if (response.status !== 200) throw new Error(`GET ${path} answered ${response.status}: ${raw}`);
  return JSON.parse(raw) as unknown[];
}

/** Nothing was written: either refused outright, or matched no row. */
function changedNothing(result: Result): boolean {
  if (result.status === 401 || result.status === 403) return true;
  return result.status === 200 && Array.isArray(result.body) && result.body.length === 0;
}

const suite = stackUp ? describe : describe.skip;

suite("what a second account can actually write", () => {
  /** The player who owns everything. */
  let ownerId = "";
  let owner = "";
  /** A signed-in stranger: no friendship, no shared table, no block. */
  let strangerId = "";
  let stranger = "";

  beforeAll(async () => {
    if (!stackUp) return;
    ownerId = await createUser("rlsw-owner");
    owner = signToken(ownerId);
    strangerId = await createUser("rlsw-stranger");
    stranger = signToken(strangerId);
  });

  // -- profiles:UPDATE -------------------------------------------------------

  it("lets a player rename themselves and nobody else", async () => {
    const mine = await write("PATCH", `profiles?id=eq.${ownerId}`, owner, { display_name: "Mine" });
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);

    const theirs = await write("PATCH", `profiles?id=eq.${ownerId}`, stranger, {
      display_name: "Theirs",
    });
    expect(changedNothing(theirs), theirs.raw).toBe(true);

    const [row] = (await read(owner, `profiles?id=eq.${ownerId}&select=display_name`)) as {
      display_name: string;
    }[];
    expect(row?.display_name).toBe("Mine");
  });

  it("refuses a client the columns the server owns, even on its own row", async () => {
    // Column grants, not policies: `xp`, `level` and `username_changed_at` are
    // not in the UPDATE grant at all, so this is a 403 rather than a no-op.
    for (const forbidden of [{ xp: 999_999 }, { level: 100 }, { username_changed_at: null }]) {
      const attempt = await write("PATCH", `profiles?id=eq.${ownerId}`, owner, forbidden);
      expect(attempt.status, `${JSON.stringify(forbidden)} → ${attempt.raw}`).toBe(403);
    }
    const [row] = (await read(owner, `profiles?id=eq.${ownerId}&select=xp,level`)) as {
      xp: number;
      level: number;
    }[];
    expect(row).toEqual({ xp: 0, level: 1 });
  });

  it("gives a client no way to create or destroy a profile at all", async () => {
    const inserted = await write("POST", "profiles", owner, {
      id: crypto.randomUUID(),
      username: `forged${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`,
      display_name: "Forged",
    });
    expect(inserted.status).toBe(403);

    const removed = await write("DELETE", `profiles?id=eq.${ownerId}`, owner);
    expect(removed.status).toBe(403);
    expect(await read(owner, `profiles?id=eq.${ownerId}&select=id`)).toHaveLength(1);
  });

  // -- push_tokens: INSERT, UPDATE, DELETE -----------------------------------

  it("scopes a push token to its owner for all three verbs", async () => {
    const token = `ExponentPushToken[${crypto.randomUUID()}]`;
    const mine = await write("POST", "push_tokens", owner, {
      user_id: ownerId,
      token,
      platform: "ios",
    });
    expect(mine.status).toBe(201);

    // INSERT for somebody else is refused by the `with check`.
    const forged = await write("POST", "push_tokens", owner, {
      user_id: strangerId,
      token: `ExponentPushToken[${crypto.randomUUID()}]`,
      platform: "ios",
    });
    expect(forged.status).toBe(403);
    expect(await read(stranger, `push_tokens?user_id=eq.${strangerId}&select=id`)).toHaveLength(0);

    // UPDATE and DELETE of the owner's token by a stranger reach no row.
    const patched = await write("PATCH", `push_tokens?user_id=eq.${ownerId}`, stranger, {
      is_active: false,
    });
    expect(changedNothing(patched), patched.raw).toBe(true);

    const deleted = await write("DELETE", `push_tokens?user_id=eq.${ownerId}`, stranger);
    expect(changedNothing(deleted), deleted.raw).toBe(true);

    const [surviving] = (await read(
      owner,
      `push_tokens?user_id=eq.${ownerId}&select=is_active`,
    )) as { is_active: boolean }[];
    expect(surviving?.is_active).toBe(true);

    // The owner can still do both, so none of the above passed on inability.
    expect((await write("PATCH", `push_tokens?user_id=eq.${ownerId}`, owner, { is_active: false })).status).toBe(200);
    expect((await write("DELETE", `push_tokens?user_id=eq.${ownerId}`, owner)).status).toBe(200);
  });

  // -- blocks: INSERT, DELETE ------------------------------------------------

  it("will not let one player forge or lift another's block", async () => {
    const forged = await write("POST", "blocks", stranger, {
      blocker_id: ownerId,
      blocked_id: strangerId,
    });
    expect(forged.status).toBe(403);

    const mine = await write("POST", "blocks", owner, {
      blocker_id: ownerId,
      blocked_id: strangerId,
    });
    expect(mine.status).toBe(201);

    const lifted = await write("DELETE", `blocks?blocker_id=eq.${ownerId}`, stranger);
    expect(changedNothing(lifted), lifted.raw).toBe(true);
    expect(await read(owner, `blocks?blocker_id=eq.${ownerId}&select=id`)).toHaveLength(1);

    expect((await write("DELETE", `blocks?blocker_id=eq.${ownerId}`, owner)).status).toBe(200);
  });

  // -- loadouts: INSERT, UPDATE ---------------------------------------------

  it("keeps a loadout to its owner", async () => {
    const forged = await write("POST", "loadouts", stranger, { user_id: ownerId });
    expect(forged.status).toBe(403);

    const theirs = await write("PATCH", `loadouts?user_id=eq.${ownerId}`, stranger, {
      avatar_cosmetic_id: null,
    });
    expect(changedNothing(theirs), theirs.raw).toBe(true);

    // The bootstrap gave the owner a loadout; they can still edit it.
    const mine = await write("PATCH", `loadouts?user_id=eq.${ownerId}`, owner, {
      avatar_cosmetic_id: null,
    });
    expect(mine.status).toBe(200);
  });

  // -- notifications: UPDATE, DELETE ----------------------------------------

  it("lets nobody write a notification, and only its recipient read, mark or remove one", async () => {
    // A client cannot create one at all: `notify_user` is server-only and there
    // is no INSERT grant. A push that anybody could write is a push anybody
    // could use to say anything.
    const forged = await write("POST", "notifications", owner, {
      user_id: ownerId,
      kind: "system",
      title: "t",
      body: "b",
    });
    expect(forged.status).toBe(403);

    // A real one, written the only way one can be — by a server function. The
    // stranger asks to be friends, so the owner is sent a notification.
    const asked = await fetch(`${REST}/rpc/send_friend_request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: LOCAL_ANON_KEY,
        Authorization: `Bearer ${stranger}`,
      },
      body: JSON.stringify({ p_to: ownerId }),
    });
    expect(await asked.text()).toContain("outgoing_pending");

    const mine = (await read(owner, `notifications?select=id,read_at&order=created_at.desc`)) as {
      id: string;
      read_at: string | null;
    }[];
    expect(mine.length).toBeGreaterThan(0);
    const notificationId = mine[0]!.id;

    // The sender cannot see it, cannot mark it read, and cannot delete it.
    expect(await read(stranger, `notifications?id=eq.${notificationId}&select=id`)).toHaveLength(0);

    const marked = await write("PATCH", `notifications?id=eq.${notificationId}`, stranger, {
      read_at: new Date().toISOString(),
    });
    expect(changedNothing(marked), marked.raw).toBe(true);

    const removed = await write("DELETE", `notifications?id=eq.${notificationId}`, stranger);
    expect(changedNothing(removed), removed.raw).toBe(true);
    expect(await read(owner, `notifications?id=eq.${notificationId}&select=id`)).toHaveLength(1);

    // The recipient can do both.
    expect(
      (await write("PATCH", `notifications?id=eq.${notificationId}`, owner, {
        read_at: new Date().toISOString(),
      })).status,
    ).toBe(200);
    expect((await write("DELETE", `notifications?id=eq.${notificationId}`, owner)).status).toBe(200);
  });

  // -- friend_requests: INSERT, UPDATE  /  friendships: DELETE ---------------

  it("will not let a player send a request as somebody else, or answer one addressed to them", async () => {
    // Fresh accounts: the pair above have already blocked each other in an
    // earlier case, and `friend_requests_insert_as_sender` correctly refuses a
    // request across a block — which would make this pass for the wrong reason.
    const senderId = await createUser("rlsw-sender");
    const sender = signToken(senderId);
    const receiverId = await createUser("rlsw-receiver");
    const receiver = signToken(receiverId);

    // Forged sender: refused by the `with check`.
    const forged = await write("POST", "friend_requests", sender, {
      sender_id: receiverId,
      receiver_id: senderId,
    });
    expect(forged.status).toBe(403);

    const real = await write("POST", "friend_requests", sender, {
      sender_id: senderId,
      receiver_id: receiverId,
    });
    expect(real.status).toBe(201);

    /*
     * The policy lets EITHER participant update the row — a sender withdraws,
     * a receiver accepts — so this is not an ownership question but an
     * authority one, and the authority lives in a trigger rather than a policy.
     * A sender must not be able to mark their own request accepted and appear
     * in somebody's friend list uninvited.
     */
    const selfAccepted = await write(
      "PATCH",
      `friend_requests?sender_id=eq.${senderId}&receiver_id=eq.${receiverId}`,
      sender,
      { status: "accepted" },
    );
    expect(selfAccepted.status).toBe(403);
    expect(selfAccepted.raw).toContain("only the receiver may accept or decline a friend request");
    expect(
      await read(receiver, `friendships?select=id`),
      "a self-accepted request must not have created a friendship",
    ).toHaveLength(0);

    // A third party cannot touch it either.
    const meddled = await write(
      "PATCH",
      `friend_requests?sender_id=eq.${senderId}`,
      stranger,
      { status: "declined" },
    );
    expect(changedNothing(meddled), meddled.raw).toBe(true);

    // The receiver accepts properly, through the RPC, and then neither party
    // can delete the OTHER's view of the friendship by pointing at their id.
    const accepted = await fetch(`${REST}/rpc/accept_friend_request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: LOCAL_ANON_KEY,
        Authorization: `Bearer ${receiver}`,
      },
      body: JSON.stringify({ p_from: senderId }),
    });
    expect(await accepted.text()).toContain("friends");

    /*
     * `create_friendship_on_accept` stores the pair as
     * `(least(a, b), greatest(a, b))`, so which column holds the sender is
     * decided by how two random uuids happen to sort. Filtering on `user_id_a`
     * alone matched the row about half the time — and in the half where it did
     * not, the stranger's DELETE below "changed nothing" because it named no
     * row, which is a test passing for the wrong reason rather than a policy
     * working. Both filters name both columns. Reproduced on purpose before it
     * was fixed: seven failures in eight runs.
     */
    const eitherSide = `friendships?or=(user_id_a.eq.${senderId},user_id_b.eq.${senderId})`;

    const meddledFriendship = await write("DELETE", eitherSide, stranger);
    expect(changedNothing(meddledFriendship), meddledFriendship.raw).toBe(true);
    expect(await read(sender, "friendships?select=id")).toHaveLength(1);

    // A participant may end it. That is the whole point of the DELETE grant.
    const ended = await write("DELETE", eitherSide, sender);
    expect(ended.status).toBe(200);
    expect(ended.body).toHaveLength(1);
    expect(await read(receiver, "friendships?select=id")).toHaveLength(0);
  }, 20_000);

  // -- anonymous -------------------------------------------------------------

  /**
   * A MODIFIED CLIENT CANNOT MANUFACTURE A LEADERBOARD FIGURE.
   *
   * Every board is derived from four things, and this is each of them attacked
   * directly over PostgREST with a real, valid session token — which is exactly
   * what a modified client has:
   *
   *   XP                 `player_daily_xp`, and `award_milestone_xp`
   *   strategy accuracy  `player_decision_periods`, and `record_decisions`
   *   a tournament win   `tournament_entries.placement`
   *   a daily score      `daily_entries.score`
   *
   * The refusals come from the PRIVILEGE SYSTEM rather than from application
   * code — no client role holds INSERT or UPDATE on any of these tables, and the
   * functions that write them are revoked from `anon` and `authenticated` — so
   * there is no code path to reach and nothing to forget to check. The point of
   * asserting it here anyway is that a grant added by a later migration would
   * open all of this silently, and `assert_client_authorization_surface()` and
   * this test would then disagree loudly rather than quietly.
   */
  it("gives a modified client no way to manufacture a leaderboard figure", async () => {
    const today = new Date().toISOString().slice(0, 10);

    const attempts: Array<{ what: string; result: Result }> = [
      {
        what: "XP for this week",
        result: await write("POST", "player_daily_xp", owner, {
          user_id: ownerId,
          utc_day: today,
          repeatable_xp: 999_999,
          milestone_xp: 999_999,
        }),
      },
      {
        what: "XP on an existing row",
        result: await write("PATCH", `player_daily_xp?user_id=eq.${ownerId}`, owner, {
          milestone_xp: 999_999,
        }),
      },
      {
        what: "a week of perfect decisions",
        result: await write("POST", "player_decision_periods", owner, {
          user_id: ownerId,
          period_start: today,
          decisions_total: 1_000,
          decisions_optimal: 1_000,
        }),
      },
      {
        what: "accuracy on an existing bucket",
        result: await write("PATCH", `player_decision_periods?user_id=eq.${ownerId}`, owner, {
          decisions_optimal: 1_000,
        }),
      },
      {
        what: "a daily entry with a chosen score",
        result: await write("POST", "daily_entries", owner, {
          user_id: ownerId,
          status: "completed",
          score: 1_000_000,
          final_chips: 1_000_000,
          hands_played: 20,
        }),
      },
      {
        what: "a better score on an existing entry",
        result: await write("PATCH", `daily_entries?user_id=eq.${ownerId}`, owner, {
          score: 1_000_000,
        }),
      },
      {
        what: "a tournament win",
        result: await write("POST", "tournament_entries", owner, {
          user_id: ownerId,
          placement: 1,
          status: "eliminated",
        }),
      },
      {
        what: "a placement on an existing entry",
        result: await write("PATCH", `tournament_entries?user_id=eq.${ownerId}`, owner, {
          placement: 1,
        }),
      },
      {
        what: "cosmetic ownership",
        result: await write("POST", "user_cosmetics", owner, {
          user_id: ownerId,
          source: "default",
        }),
      },
    ];

    for (const attempt of attempts) {
      expect(
        changedNothing(attempt.result),
        `${attempt.what} was not refused: HTTP ${attempt.result.status} ${attempt.result.raw}`,
      ).toBe(true);
    }

    // And the server-only functions behind them are unreachable too, so a client
    // cannot go around the tables by calling what writes them.
    for (const fn of [
      "record_decisions",
      "record_daily_attempt_decisions",
      "award_milestone_xp",
      "grant_earned_cosmetics_for",
      "reveal_closed_daily_seeds",
      "ensure_daily_challenge_for",
    ]) {
      const called = await write("POST", `rpc/${fn}`, owner, {});
      expect(
        called.status,
        `${fn} answered ${called.status}: ${called.raw}`,
      ).toBeGreaterThanOrEqual(400);
    }

    // Nothing landed anywhere, checked rather than inferred from the refusals.
    expect(await read(owner, `player_daily_xp?user_id=eq.${ownerId}&select=milestone_xp`)).toEqual([]);
    expect(
      await read(owner, `player_decision_periods?user_id=eq.${ownerId}&select=decisions_total`),
    ).toEqual([]);
    expect(await read(owner, `daily_entries?user_id=eq.${ownerId}&select=score`)).toEqual([]);
  }, 120_000);

  it("gives an unauthenticated caller no write at all", async () => {
    const attempts: Result[] = [
      await write("PATCH", `profiles?id=eq.${ownerId}`, null, { display_name: "Anon" }),
      await write("POST", "blocks", null, { blocker_id: ownerId, blocked_id: strangerId }),
      await write("POST", "push_tokens", null, {
        user_id: ownerId,
        token: "ExponentPushToken[anon]",
        platform: "ios",
      }),
      await write("POST", "loadouts", null, { user_id: ownerId }),
      await write("DELETE", `friendships?user_id_a=eq.${ownerId}`, null),
      await write("PATCH", `notifications?user_id=eq.${ownerId}`, null, { read_at: null }),
      await write("POST", "friend_requests", null, {
        sender_id: ownerId,
        receiver_id: strangerId,
      }),
    ];
    for (const attempt of attempts) {
      expect(attempt.status, attempt.raw).toBe(401);
    }
  });
});
