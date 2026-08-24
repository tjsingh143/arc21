/**
 * The one place that decides whether `tests/server/**` runs or skips.
 *
 * These tests exercise the REAL Edge Functions over HTTP, so they cannot run on
 * a machine with no local stack. They skip there rather than fail, which keeps a
 * checkout green for someone without Docker — but a skip is not a pass, and CI
 * must never accept one. `ARC21_REQUIRE_SERVER_STACK=1` turns the skip into a
 * loud failure for exactly that reason: the workflow sets it, so a CI job whose
 * stack failed to come up reports a broken stack instead of a green suite that
 * tested nothing.
 *
 * The probe was duplicated in four files before this module existed. It is one
 * probe now, run once at import.
 */

import { createHmac } from "node:crypto";

const PROBE = "http://127.0.0.1:54321/functions/v1/game-command";

/** Published local-development secret. Identical on every machine. */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * A token for an account that does not exist. Enough to get PAST the auth
 * check, which is the whole point: the probe below needs the function to reach
 * the database, and it cannot do that while it is refusing the caller.
 */
function probeToken(): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({
    sub: "00000000-0000-4000-8000-0000000000ff",
    role: "authenticated",
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  const signature = createHmac("sha256", LOCAL_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Only a 401 proves the FUNCTION is serving.
 *
 * "Any HTTP answer" is not enough: with the Edge runtime stopped, the API
 * gateway is still listening on this port and replies 503 — which made this
 * guard report the stack as up and every test fail instead of skip. An
 * unauthenticated command is rejected by the function's own auth check, so a
 * 401 is the narrowest signal that the code under test is actually reachable.
 */
async function functionIsServing(): Promise<boolean> {
  try {
    const response = await fetch(PROBE, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    return response.status === 401;
  } catch {
    return false;
  }
}

/**
 * AND THE FUNCTION CAN REACH THE DATABASE, which the 401 does not prove.
 *
 * The auth check runs before anything is read, so a function that is serving
 * perfectly and cannot resolve Postgres answers 401 exactly like a healthy one.
 * That is not hypothetical: after the database container was recreated while
 * the Edge runtime kept running, every command returned
 *
 *     HTTP 500 {"code":"INTERNAL"} … "Error: getaddrinfo ENOTFOUND supabase_db_arc21"
 *
 * while this guard said the stack was up. A hundred-odd server tests then ran
 * against it and reported product failures — a broken container network, read
 * as a broken product. `docker restart supabase_edge_runtime_arc21` is the fix;
 * knowing that is what was needed is the hard part.
 *
 * So the probe sends a real command, signed for an account that does not exist,
 * naming a game that does not exist. `handle()` takes the engine-state lock
 * BEFORE anything else, so this reaches Postgres on every code path:
 *
 *   database reachable   → NOT_A_PARTICIPANT, a 4xx. The stack is up.
 *   database unreachable → INTERNAL, a 500. The stack is NOT up.
 *
 * It moves nothing and creates nothing: the command is refused either way.
 */
async function functionCanReachTheDatabase(): Promise<boolean> {
  try {
    const response = await fetch(PROBE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${probeToken()}` },
      body: JSON.stringify({
        gameId: "00000000-0000-4000-8000-0000000000fe",
        clientActionId: "00000000-0000-4000-8000-0000000000fd",
        type: "NEXT_HAND",
        payload: {},
        expectedVersion: 1,
        clientSentAt: new Date().toISOString(),
      }),
      // BOUNDED, for the same reason the CI step is: a gateway that accepts the
      // socket and never answers is what a half-started stack looks like, and an
      // unbounded fetch there hangs the whole suite at import.
      signal: AbortSignal.timeout(5000),
    });
    // Anything but a server error. A 4xx here is the RIGHT answer — it means the
    // function looked, and found nothing.
    return response.status < 500;
  } catch {
    return false;
  }
}

export const stackUp = (await functionIsServing()) && (await functionCanReachTheDatabase());

const required = process.env.ARC21_REQUIRE_SERVER_STACK === "1";

if (!stackUp) {
  const how =
    "Run `supabase start` and `supabase functions serve --no-verify-jwt`, then " +
    "confirm `curl -s -o /dev/null -w '%{http_code}' -X POST " +
    `${PROBE}` +
    " -H 'content-type: application/json' -d '{}'` prints 401. If it does and " +
    "this still fails, the functions are serving but cannot reach Postgres — " +
    "`docker logs supabase_edge_runtime_arc21 | grep ENOTFOUND`, and " +
    "`docker restart supabase_edge_runtime_arc21` after the database container " +
    "has been recreated.";
  if (required) {
    // Thrown at import: the file fails to collect, so the run cannot come back
    // green having exercised none of the server.
    throw new Error(
      `[tests/server] ARC21_REQUIRE_SERVER_STACK=1 but the local stack is not reachable. ${how}`,
    );
  }
  console.warn(`[tests/server] SKIPPED — local stack not reachable. ${how}`);
}
