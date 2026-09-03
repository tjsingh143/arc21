/**
 * WHAT AN ATTACKER ACTUALLY SENDS, against the running functions.
 *
 * TypeScript does not validate an attacker and neither does a schema nobody has
 * fed a hostile value to. `shared/contracts` is strict and every object schema in
 * it rejects an unknown key — which is a claim about a schema, not about the
 * endpoint. This file sends the payloads.
 *
 * Two rules decide every assertion here.
 *
 *   **4xx, never 5xx.** A 5xx means the payload reached something that was not
 *   expecting it. `INVALID_REQUEST` is the endpoint doing its job; `INTERNAL` is
 *   the endpoint being surprised, and this project has already shipped a 200
 *   carrying `"message":"undefined"` because a code was not in the union.
 *
 *   **Nothing internal comes back.** A rejection carries a stable code, a fixed
 *   sentence and a request id. Not a Zod issue quoting the offending value, not
 *   a driver message, not a relation name.
 *
 * THE BODY CAP is here rather than in a unit test because the thing worth
 * asserting is what the ENDPOINT does with 32 MB, and that behaviour lives in
 * the interaction between the function, the runtime and the gateway in front of
 * it. Phase 10 measured all three shapes of it: `arrayBuffer()` held the whole
 * body and answered in 2.5 s; a read that CANCELLED at the cap answered in 60 s
 * with an HTTP 504 from the gateway, because a blocked upstream write means the
 * reply is never collected; a read that drains without retaining answers in
 * under a second. Only the last is both bounded in memory and prompt, and a unit
 * test over a `Request` object would have called the middle one a success.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { COMMAND_REJECTION_CODES } from "../../shared/contracts/index.js";
import { stackUp } from "./stack-guard.js";

const FUNCTIONS = "http://127.0.0.1:54321/functions/v1";
const AUTH_ADMIN = "http://127.0.0.1:54321/auth/v1/admin/users";

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** No `iat` — see the note in `rejection-contract.integration.test.ts`. */
function signToken(sub: string, claims: Record<string, unknown> = {}): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({
    sub,
    role: "authenticated",
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
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
      email: `hostile-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return json.id;
}

interface Answer {
  status: number;
  raw: string;
  body: Record<string, unknown>;
}

/**
 * Deliberately NOT `call-function.ts`.
 *
 * That helper validates the request it is given and replays a lost reply, both
 * of which are exactly wrong here: half of these payloads are not valid requests,
 * and a retry would hide a deterministic answer. This posts the bytes.
 */
async function postRaw(
  fn: string,
  token: string | null,
  body: string,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const sent: Record<string, string> = {
    apikey: LOCAL_ANON_KEY,
    "content-type": "application/json",
    ...headers,
  };
  if (token) sent.Authorization = `Bearer ${token}`;
  const response = await fetch(`${FUNCTIONS}/${fn}`, { method: "POST", headers: sent, body });
  const raw = await response.text();
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  return {
    status: response.status,
    raw,
    body: (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>,
  };
}

const iso = () => new Date().toISOString();
const GAME = "00000000-0000-4000-8000-000000000999";

const suite = stackUp ? describe : describe.skip;

suite("hostile payloads to game-command", () => {
  let token = "";
  let strangerId = "";

  beforeAll(async () => {
    strangerId = await createUser();
    token = signToken(strangerId);
  }, 60_000);

  const envelope = () => ({
    gameId: GAME,
    clientActionId: crypto.randomUUID(),
    expectedVersion: 0,
    clientSentAt: iso(),
  });

  /**
   * Each case is a shape a modified client can produce. The name is the attack,
   * not the field.
   */
  const cases: { name: string; body: unknown }[] = [
    { name: "a malformed uuid where a game id goes", body: { ...envelope(), gameId: "not-a-uuid", type: "STAND" } },
    { name: "a missing idempotency key", body: { gameId: GAME, expectedVersion: 0, clientSentAt: iso(), type: "STAND" } },
    {
      // The one that would be an authorization bypass with extra steps.
      name: "a userId smuggled alongside a valid command",
      body: { ...envelope(), type: "STAND", userId: "00000000-0000-4000-8000-000000000001" },
    },
    { name: "a negative wager", body: { ...envelope(), type: "PLACE_BET", payload: { amount: -100 } } },
    { name: "a fractional wager", body: { ...envelope(), type: "PLACE_BET", payload: { amount: 10.5 } } },
    { name: "a wager larger than the chip ceiling", body: { ...envelope(), type: "PLACE_BET", payload: { amount: 1e18 } } },
    { name: "a wager sent as a string", body: { ...envelope(), type: "PLACE_BET", payload: { amount: "500" } } },
    { name: "a wager sent as null", body: { ...envelope(), type: "PLACE_BET", payload: { amount: null } } },
    {
      // `ADVANCE` drives the dealer and settlement cascade. It is absent from
      // the request union on purpose: unrepresentable beats checked-for.
      name: "the engine's own ADVANCE command",
      body: { ...envelope(), type: "ADVANCE" },
    },
    { name: "a command type that does not exist", body: { ...envelope(), type: "SETTLE" } },
    { name: "a command type that is an object", body: { ...envelope(), type: { toString: "STAND" } } },
    { name: "a negative state version", body: { ...envelope(), type: "STAND", expectedVersion: -1 } },
    { name: "a fractional state version", body: { ...envelope(), type: "STAND", expectedVersion: 1.5 } },
    { name: "a timestamp that is not one", body: { ...envelope(), type: "STAND", clientSentAt: "yesterday" } },
    { name: "a timestamp with no offset", body: { ...envelope(), type: "STAND", clientSentAt: "2026-09-02T00:00:00" } },
    { name: "a payload on a command that takes none", body: { ...envelope(), type: "STAND", payload: { amount: 5 } } },
    { name: "an unknown key inside a payload", body: { ...envelope(), type: "PLACE_BET", payload: { amount: 50, seatId: GAME } } },
    { name: "a prototype-pollution key", body: { ...envelope(), type: "STAND", constructor: { prototype: { admin: true } } } },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.name}`, async () => {
      const answer = await postRaw("game-command", token, JSON.stringify(testCase.body));

      expect(answer.status, answer.raw).toBeGreaterThanOrEqual(400);
      expect(answer.status, answer.raw).toBeLessThan(500);
      expect(answer.body.status).toBe("rejected");
      expect(COMMAND_REJECTION_CODES as readonly string[]).toContain(answer.body.code);

      // Nothing internal, and nothing echoed. A Zod issue can quote the value it
      // rejected, and an error message is not a place to reflect input.
      const message = String(answer.body.message ?? "");
      expect(message).not.toMatch(/undefined|NaN/);
      expect(message).toMatch(/\(ref [0-9a-f-]{36}\)$/);
      expect(answer.raw).not.toMatch(/select |insert |relation |pg_|postgres|ZodError/i);
      expect(answer.raw).not.toMatch(/at .*\(.*:\d+:\d+\)/);
    }, 30_000);
  }

  /** Bodies that are not objects at all, which never reach a field check. */
  const rawBodies: { name: string; raw: string }[] = [
    { name: "a JSON array", raw: "[1,2,3]" },
    { name: "a bare null", raw: "null" },
    { name: "a bare string", raw: '"STAND"' },
    { name: "a bare number", raw: "42" },
    { name: "truncated JSON", raw: '{"gameId":' },
    { name: "an empty body", raw: "" },
  ];

  for (const testCase of rawBodies) {
    it(`refuses ${testCase.name}`, async () => {
      const answer = await postRaw("game-command", token, testCase.raw);
      expect(answer.status, answer.raw).toBeGreaterThanOrEqual(400);
      expect(answer.status, answer.raw).toBeLessThan(500);
    }, 30_000);
  }

  it("refuses a body that is not JSON at all, whatever the content type claims", async () => {
    const answer = await postRaw("game-command", token, "<xml/>", { "content-type": "application/json" });
    expect(answer.status).toBe(400);
    const wrongType = await postRaw("game-command", token, "{}", { "content-type": "text/plain" });
    expect(wrongType.status).toBe(400);
  }, 30_000);

  /**
   * THE BODY CAP, and it is a timing assertion as much as a status one.
   *
   * `MAX_BODY_BYTES` is 8 KB. A 32 MB body has to be refused, and it has to be
   * refused PROMPTLY: the version of this code that cancelled the stream at the
   * cap was correct about memory and turned the same request into a 60-second
   * stall and an HTTP 504. The bound below is deliberately loose — this is a
   * load-sensitive host, and the difference being asserted is seconds against a
   * minute, not milliseconds.
   */
  it("refuses a 32 MB body quickly, without buffering it", async () => {
    const giant = JSON.stringify({ ...envelope(), type: "STAND", pad: "x".repeat(32 * 1024 * 1024) });
    const startedAt = Date.now();
    const answer = await postRaw("game-command", token, giant);
    const elapsed = Date.now() - startedAt;

    expect(answer.status, answer.raw).toBe(400);
    expect(answer.body.code).toBe("INVALID_REQUEST");
    expect(
      elapsed,
      `a 32 MB body took ${elapsed} ms to refuse. A stall here means the body is ` +
        `being cancelled rather than drained, and the gateway answers 504.`,
    ).toBeLessThan(30_000);
  }, 120_000);

  it("refuses a body just over the cap that declares no length", async () => {
    // Chunked, so `content-length` is absent and only the stream count applies.
    const overCap = JSON.stringify({ ...envelope(), type: "STAND", pad: "x".repeat(9_000) });
    const answer = await postRaw("game-command", token, overCap);
    expect(answer.status).toBe(400);
    expect(answer.body.code).toBe("INVALID_REQUEST");
  }, 30_000);

  it("still accepts an ordinary command of ordinary size", async () => {
    // The control. Every refusal above means nothing if the endpoint refuses
    // everything: this one gets past validation and is turned away by
    // AUTHORIZATION instead, which is a different answer and the right one.
    const answer = await postRaw(
      "game-command",
      token,
      JSON.stringify({ ...envelope(), type: "STAND" }),
    );
    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe("NOT_A_PARTICIPANT");
  }, 30_000);
});

suite("hostile credentials", () => {
  let userId = "";

  beforeAll(async () => {
    userId = await createUser();
  }, 60_000);

  const command = () =>
    JSON.stringify({
      gameId: GAME,
      clientActionId: crypto.randomUUID(),
      expectedVersion: 0,
      clientSentAt: iso(),
      type: "STAND",
    });

  it("refuses alg=none", async () => {
    const forged = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      sub: userId,
      role: "authenticated",
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.`;
    expect((await postRaw("game-command", forged, command())).status).toBe(401);
  }, 30_000);

  it("refuses a token signed with the wrong key", async () => {
    const header = b64({ alg: "HS256", typ: "JWT" });
    const payload = b64({
      sub: userId,
      role: "authenticated",
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const signature = crypto
      .createHmac("sha256", "not-the-projects-secret-not-the-projects-secret")
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(
      (await postRaw("game-command", `${header}.${payload}.${signature}`, command())).status,
    ).toBe(401);
  }, 30_000);

  it("refuses an expired token", async () => {
    expect(
      (await postRaw("game-command", signToken(userId, { exp: Math.floor(Date.now() / 1000) - 3600 }), command())).status,
    ).toBe(401);
  }, 30_000);

  /**
   * The publishable key is a perfectly valid signature over `role: "anon"`, and
   * the service key over `role: "service_role"`. Neither is a player.
   */
  it("refuses the publishable key and the service key as player credentials", async () => {
    expect((await postRaw("game-command", LOCAL_ANON_KEY, command())).status).toBe(401);
    expect((await postRaw("game-command", LOCAL_SERVICE_KEY, command())).status).toBe(401);
  }, 30_000);

  it("refuses a validly signed token claiming a privileged role", async () => {
    // Correctly signed by the project's own key, and still not a session.
    expect((await postRaw("game-command", signToken(userId, { role: "service_role" }), command())).status).toBe(401);
    expect((await postRaw("game-command", signToken(userId, { role: "anon" }), command())).status).toBe(401);
  }, 30_000);

  it("refuses a token whose subject is not a user id", async () => {
    expect((await postRaw("game-command", signToken("' or 1=1 --"), command())).status).toBe(401);
  }, 30_000);

  /**
   * `send-notifications` reads other players' notification titles and bodies by
   * design, so a signed-in player is refused as firmly as no token at all.
   */
  it("refuses a player token and the publishable key at the push sender", async () => {
    expect((await postRaw("send-notifications", signToken(userId), "{}")).status).toBe(401);
    expect((await postRaw("send-notifications", LOCAL_ANON_KEY, "{}")).status).toBe(401);
    expect((await postRaw("send-notifications", null, "{}")).status).toBe(401);
  }, 30_000);
});
