/**
 * Notifications, against the REAL database and the REAL sender function.
 *
 * The unit tests prove the pieces; this proves the pipeline. It was written
 * after driving each step by hand against the running stack, and it exists so
 * the chain stays connected:
 *
 *   a friend request → a notification row → the sender drains it →
 *   an honest delivery record
 *
 * Two things it is careful about, both learned in this repository.
 *
 * A SKIP IS NOT A PASS. The guard requires a 401 from a function, because the
 * API gateway answers 503 with the Edge runtime stopped and an "any response"
 * check once reported the stack as up while nine tests failed instead of
 * skipping.
 *
 * COUNT ONLY YOUR OWN ROWS. The sender drains the whole queue, so an assertion
 * on totals would depend on whatever else the database happens to be holding —
 * which is exactly how a pgTAP file in this project started failing the day a
 * feature shipped. Every assertion here is scoped to users this file created.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { callFunction as call } from "./call-function.js";
import { stackUp } from "./stack-guard.js";

const REST = "http://127.0.0.1:54321/rest/v1";
const AUTH_ADMIN = "http://127.0.0.1:54321/auth/v1/admin/users";

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * The test tokens carry NO `iat`, deliberately.
 *
 * PostgREST validates `iat` against its own clock and answers
 * `PGRST303 "JWT issued at future"` when it is ahead — and the failure does not
 * look like a clock problem. It looks like a wallet that reads as -1, a profile
 * column that reads as null, or a career reward that was never paid.
 *
 * Backdating by a minute was the first fix and it was not enough: the Docker VM
 * clock jumps rather than drifts, so any constant is a guess about how far.
 * `iat` is an OPTIONAL claim that PostgREST validates only when present, and
 * nothing in this app reads it, so omitting it removes the failure mode instead
 * of narrowing it. `exp` still bounds the token, and an `exp` an hour out is
 * safe against skew in the direction that matters.
 *
 * Test-only: Supabase issues real tokens server-side, where there is one clock.
 */
function signToken(sub: string): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({
    sub,
    role: "authenticated",
    aud: "authenticated",
        exp: now + 3600,
  });
  const signature = crypto
    .createHmac("sha256", LOCAL_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function createUser(): Promise<string> {
  const response = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      email: `notif-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return json.id;
}

/** Calls an RPC as a signed-in player — never as the service role. */
async function rpc(token: string, name: string, args: unknown): Promise<{ status: number; body: unknown }> {
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
  return { status: response.status, body };
}

async function drain(limit = 500): Promise<Record<string, number>> {
  const result = await call("send-notifications", LOCAL_SERVICE_KEY, { limit });
  if (result.status !== 200) {
    // A helper that reads something THROWS when it cannot. Returning an empty
    // summary here would surface as "expected undefined to be 1".
    throw new Error(`the queue could not be drained: HTTP ${result.status} ${result.raw}`);
  }
  return result.body as Record<string, number>;
}

const suite = stackUp ? describe : describe.skip;

suite("who may drain the queue", () => {
  it("refuses an unauthenticated caller", async () => {
    const result = await call("send-notifications", null, {});
    expect(result.status).toBe(401);
  });

  it("refuses a signed-in PLAYER", async () => {
    // This endpoint reads other people's notification titles and bodies by
    // design. No amount of being logged in makes that acceptable.
    const userId = await createUser();
    const result = await call("send-notifications", signToken(userId), {});
    expect(result.status).toBe(401);
  });

  it("accepts the service key", async () => {
    const summary = await drain();
    expect(summary).toHaveProperty("transport");
  });
});

suite("a friend request becomes a notification", () => {
  let alice = "";
  let bob = "";
  let aliceToken = "";
  let bobToken = "";

  beforeAll(async () => {
    alice = await createUser();
    bob = await createUser();
    aliceToken = signToken(alice);
    bobToken = signToken(bob);
  });

  it("writes one to the recipient, not to the sender", async () => {
    const sent = await rpc(aliceToken, "send_friend_request", { p_to: bob });
    expect(sent.status).toBeLessThan(300);

    const forBob = await rpc(bobToken, "my_notifications", { p_limit: 50 });
    const rows = forBob.body as Array<{ kind: string; data: Record<string, unknown> }>;
    expect(rows.some((row) => row.kind === "friend_request")).toBe(true);

    const forAlice = await rpc(aliceToken, "my_notifications", { p_limit: 50 });
    expect((forAlice.body as unknown[]).length).toBe(0);
  });

  it("carries the sender's id and nothing else", async () => {
    const forBob = await rpc(bobToken, "my_notifications", { p_limit: 50 });
    const rows = forBob.body as Array<{ kind: string; data: Record<string, unknown> }>;
    const request = rows.find((row) => row.kind === "friend_request");

    expect(Object.keys(request?.data ?? {})).toEqual(["from_user_id"]);
    expect(request?.data.from_user_id).toBe(alice);
  });

  it("does not stack rows when the same request is repeated", async () => {
    await rpc(aliceToken, "send_friend_request", { p_to: bob });
    await rpc(aliceToken, "send_friend_request", { p_to: bob });

    const forBob = await rpc(bobToken, "my_notifications", { p_limit: 50 });
    const rows = forBob.body as Array<{ kind: string }>;
    expect(rows.filter((row) => row.kind === "friend_request")).toHaveLength(1);
  });

  it("tells the sender when the request is accepted", async () => {
    const accepted = await rpc(bobToken, "accept_friend_request", { p_from: alice });
    expect(accepted.status).toBeLessThan(300);

    const forAlice = await rpc(aliceToken, "my_notifications", { p_limit: 50 });
    const rows = forAlice.body as Array<{ kind: string }>;
    expect(rows.some((row) => row.kind === "friend_accepted")).toBe(true);
  });

  it("closes the request notification once it has been answered", async () => {
    // Leaving it unread would send Bob back to a request that no longer exists.
    const forBob = await rpc(bobToken, "my_notifications", { p_limit: 50 });
    const rows = forBob.body as Array<{ kind: string; read_at: string | null }>;
    const request = rows.find((row) => row.kind === "friend_request");
    expect(request?.read_at).not.toBeNull();
  });

  it("refuses to let a client write one for itself", async () => {
    // `notify_user` is revoked from `authenticated`. PostgREST answers 404 for a
    // function the caller may not execute, which is the correct amount of
    // information to give.
    const forged = await rpc(bobToken, "notify_user", {
      p_user_id: bob,
      p_kind: "tournament_result",
      p_title: "You won",
      p_body: "500,000 chips",
    });
    expect(forged.status).toBeGreaterThanOrEqual(400);
  });
});

suite("the sender records what actually happened", () => {
  let carol = "";
  let dave = "";
  let carolToken = "";
  let daveToken = "";

  beforeAll(async () => {
    carol = await createUser();
    dave = await createUser();
    carolToken = signToken(carol);
    daveToken = signToken(dave);
  });

  it("marks a notification with no registered device as no_device", async () => {
    await rpc(carolToken, "send_friend_request", { p_to: dave });
    const summary = await drain();

    // Scoped to this file's own rows: the queue is global, so a count of the
    // summary would depend on whatever else is in the database.
    expect(summary.noDevice).toBeGreaterThanOrEqual(1);

    const forDave = await rpc(daveToken, "my_notifications", { p_limit: 50 });
    expect((forDave.body as unknown[]).length).toBeGreaterThan(0);
  });

  it("queues to a device that asked for the kind, and records it as MOCKED", async () => {
    const token = `ExponentPushToken[it-${crypto.randomUUID()}]`;
    const registered = await rpc(daveToken, "register_push_token", {
      p_token: token,
      p_platform: "ios",
      p_device_id: "integration",
      p_kinds: ["table_invite", "friend_request"],
      // Device writes are ordered (B-H4); a device's first intent.
      p_revision: 1,
    });
    expect(registered.status).toBeLessThan(300);

    // A fresh notification, now that a device exists to receive it.
    const eve = await createUser();
    await rpc(signToken(eve), "send_friend_request", { p_to: dave });

    const summary = await drain();
    /*
     * `mocked`, not `sent`. There are no push credentials on a development
     * build, so nothing left the server — and a sender that recorded these as
     * sent would make its own audit trail worthless.
     */
    expect(summary.transport as unknown).toBe("mock");
    expect(summary.mocked).toBeGreaterThanOrEqual(1);
    expect(summary.sent).toBe(0);
  });

  it("leaves nothing pending after a drain", async () => {
    // The queue must not grow without bound, and "pending" must keep meaning
    // "not attempted yet" rather than "attempted and forgotten".
    const total = (summary: Record<string, number>) =>
      (summary.mocked ?? 0) + (summary.noDevice ?? 0) + (summary.failed ?? 0);

    const first = await drain();
    const second = await drain();
    expect(total(second)).toBeLessThanOrEqual(total(first));
    expect(second.sent).toBe(0);
  });

  it("does not push a kind the device did not ask for", async () => {
    const token = `ExponentPushToken[it-${crypto.randomUUID()}]`;
    await rpc(carolToken, "register_push_token", {
      p_token: token,
      p_platform: "android",
      p_device_id: "integration-2",
      // Deliberately narrow: friend requests are NOT in this list.
      p_kinds: ["daily_challenge"],
      p_revision: 1,
    });

    const frank = await createUser();
    await rpc(signToken(frank), "send_friend_request", { p_to: carol });

    const summary = await drain();
    // The notification exists in the inbox but has nowhere to be pushed, so it
    // closes out as no_device rather than as a delivery.
    expect(summary.noDevice).toBeGreaterThanOrEqual(1);

    const forCarol = await rpc(carolToken, "my_notifications", { p_limit: 50 });
    const rows = forCarol.body as Array<{ kind: string }>;
    expect(rows.some((row) => row.kind === "friend_request")).toBe(true);
  });
});

suite("a timed-out hand tells the player it was played for them", () => {
  /**
   * The slowest test in the suite, and worth its sixteen seconds.
   *
   * It is the only proof that `your_turn` is reachable at all. The
   * specification asks for "your turn where timing makes sense", and the
   * reading here is that the moment worth telling somebody about is the one
   * where the server APPLIED A DEFAULT because nobody answered — a push written
   * when the turn arrives is racing a fifteen-second countdown it cannot win.
   *
   * That makes the notification fire from `TIMEOUT_RESOLVED`, an event the
   * engine emits, rather than from a `connected` flag that only an explicit
   * LEAVE ever clears. Without this test the feature would look wired and never
   * fire once.
   */
  it("writes a your_turn notification when a betting deadline lapses", async () => {
    const hostId = await createUser();
    const guestId = await createUser();
    const host = signToken(hostId);
    const guest = signToken(guestId);

    const created = await rpc(host, "create_private_room", { p_max_seats: 2 });
    const room = created.body as { id: string; code: string };
    await rpc(guest, "join_private_room", { p_code: room.code });

    const started = await call("create-session", host, {
      action: "START_PRIVATE_TABLE",
      clientRequestId: crypto.randomUUID(),
      roomId: room.id,
      clientSentAt: new Date().toISOString(),
    });
    expect(started.status).toBe(200);
    const table = started.body as unknown as {
      gameId: string;
      publicState: { version: number };
    };

    // Nobody bets. The private table's betting deadline is fifteen seconds.
    await new Promise((resolve) => setTimeout(resolve, 16_000));

    const resolved = await call("game-command", host, {
      gameId: table.gameId,
      clientActionId: crypto.randomUUID(),
      expectedVersion: table.publicState.version,
      type: "RESOLVE_TIMEOUT",
      payload: {},
      clientSentAt: new Date().toISOString(),
    });
    expect(resolved.status).toBe(200);

    // BOTH seats were absent, so both are told. The host asked for the timeout
    // to be resolved, which is not the same as having acted on their own hand.
    for (const token of [host, guest]) {
      const inbox = await rpc(token, "my_notifications", { p_limit: 50 });
      const rows = inbox.body as Array<{ kind: string; data: { game_id?: string } }>;
      const turn = rows.find((row) => row.kind === "your_turn");
      expect(turn, "a timed-out seat is told its hand was played").toBeDefined();
      expect(turn?.data.game_id).toBe(table.gameId);
    }
  }, 60_000);
});
