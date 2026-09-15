/**
 * A refusal is a refusal, over the wire.
 *
 * `toRejectedResponse` promises a caller "a stable code, a fixed
 * human-readable sentence and a request id". Eight call sites in
 * `create-session` threw `CommandError("NOT_FOUND", …)`, and `NOT_FOUND` is not
 * in `COMMAND_REJECTION_CODES`. Both lookups keyed on it returned undefined, so
 * the wire carried:
 *
 *   HTTP 200 {"status":"rejected","code":"NOT_FOUND","message":"undefined (ref …)"}
 *
 * Two failures in one. The player is shown the word "undefined", and — worse —
 * `functions.invoke` treats 200 as SUCCESS, so `result.error` is null and the
 * client reads a body that has no `gameId` in it. The refusal never reaches the
 * code that handles refusals.
 *
 * It was invisible to every existing test because nothing asserted the SHAPE of
 * a rejection, only its code, and invisible to `tsc --noEmit` because
 * `supabase/functions` is excluded from `tsconfig.json`. `npm run
 * check:functions` covers the compile half; this covers the wire half, which is
 * the half that decides what a player sees.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { COMMAND_REJECTION_CODES } from "../../shared/contracts/index.js";
import { callFunction as post } from "./call-function.js";
import { stackUp } from "./stack-guard.js";

const AUTH_ADMIN = "http://127.0.0.1:54321/auth/v1/admin/users";

const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

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
  const payload = b64({ sub, role: "authenticated", aud: "authenticated", exp: now + 3600 });
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
      email: `reject-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return json.id;
}

const iso = () => new Date().toISOString();
const MISSING = "00000000-0000-4000-8000-000000000999";

const suite = stackUp ? describe : describe.skip;

suite("every rejection is a real rejection", () => {
  let token = "";
  beforeAll(async () => {
    token = signToken(await createUser());
  });

  /**
   * One case per thing a client can name that may not exist. Each one was a
   * `NOT_FOUND` throw, and each one answered 200 with "undefined".
   */
  const cases: { name: string; body: Record<string, unknown> }[] = [
    {
      name: "a public room that does not exist",
      body: { action: "JOIN_PUBLIC_TABLE", roomId: MISSING },
    },
    {
      name: "a private room that does not exist",
      body: { action: "START_PRIVATE_TABLE", roomId: MISSING },
    },
    {
      name: "a private stack reset for a table that does not exist",
      body: { action: "RESET_PRIVATE_STACK", gameId: MISSING },
    },
    {
      name: "a cash-out from a table that does not exist",
      body: { action: "CASH_OUT", gameId: MISSING },
    },
    {
      name: "a career node that is not in the catalogue",
      body: { action: "START_CAREER_NODE", nodeSlug: "not-a-real-node" },
    },
    {
      name: "a drill attempt that does not exist",
      body: { action: "SUBMIT_CAREER_DRILL", attemptId: MISSING, answers: ["HIT"] },
    },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.name} with a code, a sentence and a status`, async () => {
      const result = await post("create-session", token, {
        ...testCase.body,
        clientRequestId: crypto.randomUUID(),
        clientSentAt: iso(),
      });

      // A refusal must NOT be 200. `functions.invoke` reports 200 as success,
      // so a 200 rejection never reaches the client's refusal handling at all.
      expect(result.status).toBeGreaterThanOrEqual(400);
      expect(result.status).toBeLessThan(500);

      expect(result.body.status).toBe("rejected");
      // The code has to be one the contract declares, or both lookups keyed on
      // it return undefined and the whole envelope degrades silently.
      expect(COMMAND_REJECTION_CODES as readonly string[]).toContain(result.body.code);

      const message = String(result.body.message ?? "");
      expect(message).not.toMatch(/undefined|null|NaN/);
      expect(message).toMatch(/\(ref [0-9a-f-]{36}\)$/);
      // And still nothing internal: no SQL, no relation names, no stack frames.
      expect(result.raw).not.toMatch(/select |insert |relation |pg_|postgres/i);
      expect(result.raw).not.toMatch(/at .*\(.*:\d+:\d+\)/);
    }, 30_000);
  }
});
