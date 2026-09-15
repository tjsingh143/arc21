/**
 * Puts the Sprint Tournament pool into a known state for an E2E flow.
 *
 * WHY A SCRIPT AND NOT A FLOW. A tournament needs FOUR accounts before a card is
 * dealt, and Maestro drives one simulator. Every other player therefore has to
 * arrive from outside the device — which is not a shortcut around the product:
 * they register through `create-session`'s real `REGISTER_SPRINT`, pay the real
 * 500-chip entry, and are seated by the same allocation the app uses. The device
 * account is the one under test and does everything through the screen.
 *
 * TWO STAGES, because the flow proves two different things.
 *
 *   --stage waiting  Empty the pool and clear the device account's entry, so
 *                    entering leaves it WAITING. That is the state the phase-8
 *                    withdrawal control exists for: a player whose three
 *                    companions may never arrive.
 *
 *   --stage fill     Register three players into the open tournament, so the
 *                    device account's next entry completes the field and the
 *                    table is dealt.
 *
 * Idempotent and safe to re-run. Draining is bounded: registration deliberately
 * fills the OLDEST tournament still short of players, so a half-filled leftover
 * from an earlier run would otherwise split the field and nothing would deal —
 * the same flake `tests/server/sprint-table.ts` documents.
 *
 *   npx tsx scripts/e2e-sprint-field.ts --stage waiting [--email <address>]
 *   npx tsx scripts/e2e-sprint-field.ts --stage fill    [--email <address>]
 */

import crypto from "node:crypto";

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";

const SUPABASE_URL = "http://127.0.0.1:54321";
const AUTH_ADMIN = `${SUPABASE_URL}/auth/v1/admin/users`;
const FUNCTIONS = `${SUPABASE_URL}/functions/v1`;

const DEFAULT_EMAIL = "e2e-lobby@arc21.test";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** No `iat` — PostgREST validates it against a clock that jumps in the VM. */
function signToken(sub: string): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({
    sub,
    role: "authenticated",
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const signature = crypto
    .createHmac("sha256", LOCAL_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function createThrowawayAccount(): Promise<string> {
  const response = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      email: `e2e-sprint-${crypto.randomUUID()}@arc21.test`,
      password: "e2e-sprint-password",
      email_confirm: true,
    }),
  });
  const body = (await response.json()) as { id?: string };
  if (!body.id) throw new Error(`could not create a field account: ${JSON.stringify(body)}`);
  return body.id;
}

/**
 * The named account's id, or a throw.
 *
 * The exact comparison stays: GoTrue's `filter` is a SUBSTRING search, so
 * `e2e-lobby@arc21.test` must not be satisfied by `e2e-lobby@arc21.test.invalid`.
 */
async function findUserId(email: string): Promise<string> {
  const response = await fetch(`${AUTH_ADMIN}?filter=${encodeURIComponent(email)}&per_page=200`, {
    headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${LOCAL_SERVICE_KEY}` },
  });
  if (!response.ok) {
    throw new Error(`could not look up ${email}: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { users?: Array<{ id: string; email: string }> };
  const found = body.users?.find((user) => user.email === email);
  if (!found) {
    throw new Error(
      `no account for ${email}. Run \`npx tsx scripts/e2e-account.ts\` first — the ` +
        "flows sign in as that account.",
    );
  }
  return found.id;
}

interface SessionAnswer {
  status: number;
  body: Record<string, unknown>;
}

async function session(token: string, body: Record<string, unknown>): Promise<SessionAnswer> {
  const response = await fetch(`${FUNCTIONS}/create-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = { raw };
  }
  return { status: response.status, body: parsed };
}

const registerSprint = (token: string) =>
  session(token, {
    action: "REGISTER_SPRINT",
    clientRequestId: crypto.randomUUID(),
    clientSentAt: new Date().toISOString(),
  });

const withdrawSprint = (token: string) =>
  session(token, {
    action: "WITHDRAW_SPRINT",
    clientRequestId: crypto.randomUUID(),
    clientSentAt: new Date().toISOString(),
  });

/**
 * Empties the waiting pool, using nothing but registration itself.
 *
 * A scout registers: if it lands in a tournament that already had somebody in
 * it, the pool was dirty and the scout FILLS that tournament so it deals and
 * stops being a candidate. Once a scout opens a brand-new tournament (it is the
 * only entry) the pool was clean, and that one is filled too so it does not
 * become the next run's leftover.
 */
async function drain(): Promise<void> {
  for (let round = 0; round < 12; round += 1) {
    const scout = await registerSprint(signToken(await createThrowawayAccount()));
    if (scout.status !== 200) {
      throw new Error(`could not register a scout: ${scout.status} ${JSON.stringify(scout.body)}`);
    }
    const filled = scout.body.entriesFilled as number;
    const required = scout.body.seatsRequired as number;
    for (let seat = 0; seat < required - filled; seat += 1) {
      await registerSprint(signToken(await createThrowawayAccount()));
    }
    process.stdout.write(`drained a tournament that had ${filled} of ${required} seats taken\n`);
    if (filled === 1) return;
  }
  throw new Error("could not drain the sprint tournament pool in twelve rounds");
}

async function main(): Promise<void> {
  const stage = argument("stage");
  const email = argument("email") ?? DEFAULT_EMAIL;
  if (stage !== "waiting" && stage !== "fill") {
    throw new Error("--stage must be `waiting` or `fill`");
  }

  const deviceUserId = await findUserId(email);
  const deviceToken = signToken(deviceUserId);

  if (stage === "waiting") {
    /*
     * The device account's OWN entry first. A flow that ended early leaves one
     * behind, and registration returns that same entry rather than a new one —
     * so the next run would find a tournament in a state nobody chose. Refused
     * withdrawals are fine: an entry that has already been dealt resolves itself.
     */
    const left = await withdrawSprint(deviceToken);
    if (left.status === 200) {
      process.stdout.write(`${email} left a tournament queue from an earlier run\n`);
    } else if ((left.body.code as string | undefined) === "SESSION_BUSY") {
      /*
       * The account is in a tournament that has already been DEALT, and a player
       * cannot buy out of a tournament they are playing — that refusal is the
       * product working. It cannot be cleared from here either: the other three
       * seats belong to throwaway accounts this run has no tokens for, and
       * nothing but a connected client resolves a lapsed deadline.
       *
       * Thrown rather than worked around, because the alternative is a flow that
       * runs against a table nobody chose and reports something true about the
       * wrong tournament.
       */
      throw new Error(
        `${email} is in a tournament that has already been dealt. Finish it on the ` +
          "device, run the flow with a different --email (create it with " +
          "`npx tsx scripts/e2e-account.ts --email <address>`), or `supabase db reset`.",
      );
    }
    await drain();
    process.stdout.write("pool is empty: entering now leaves the device account waiting\n");
    return;
  }

  // `fill`: three more players, so the device account's entry completes a field.
  for (let seat = 0; seat < 3; seat += 1) {
    const joined = await registerSprint(signToken(await createThrowawayAccount()));
    if (joined.status !== 200) {
      throw new Error(`could not seat a field player: ${JSON.stringify(joined.body)}`);
    }
    if (joined.body.gameId) {
      throw new Error(
        "the field filled without the device account in it — the pool was not drained first. " +
          "Run `--stage waiting` before `--stage fill`.",
      );
    }
  }
  process.stdout.write("three players are waiting: the device account's entry deals the table\n");
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
