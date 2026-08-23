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

const PROBE = "http://127.0.0.1:54321/functions/v1/game-command";

/**
 * Only a 401 proves the FUNCTION is serving.
 *
 * "Any HTTP answer" is not enough: with the Edge runtime stopped, the API
 * gateway is still listening on this port and replies 503 — which made this
 * guard report the stack as up and every test fail instead of skip. An
 * unauthenticated command is rejected by the function's own auth check, so a
 * 401 is the narrowest signal that the code under test is actually reachable.
 */
async function probeStack(): Promise<boolean> {
  try {
    const response = await fetch(PROBE, { method: "POST", body: "{}" });
    return response.status === 401;
  } catch {
    return false;
  }
}

export const stackUp = await probeStack();

const required = process.env.ARC21_REQUIRE_SERVER_STACK === "1";

if (!stackUp) {
  const how =
    "Run `supabase start` and `supabase functions serve --no-verify-jwt`, then " +
    "confirm `curl -s -o /dev/null -w '%{http_code}' -X POST " +
    `${PROBE}` +
    " -H 'content-type: application/json' -d '{}'` prints 401.";
  if (required) {
    // Thrown at import: the file fails to collect, so the run cannot come back
    // green having exercised none of the server.
    throw new Error(
      `[tests/server] ARC21_REQUIRE_SERVER_STACK=1 but the local stack is not reachable. ${how}`,
    );
  }
  console.warn(`[tests/server] SKIPPED — local stack not reachable. ${how}`);
}
