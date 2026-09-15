/**
 * The account the server-configured E2E flows sign in with.
 *
 * WHY THIS EXISTS AT ALL. Every Maestro flow in this repository until now ran
 * against an UNCONFIGURED build — `every-screen.yaml` asserts
 * ".*no server configured.*" in five places — so no flow had ever signed in,
 * and nothing walked a screen whose content comes from the server. That is the
 * gap this script closes: it makes a real, confirmed account exist in the local
 * database and puts its credential where the simulator can paste it.
 *
 * WHY THE PASSWORD IS THE EMAIL. Two fields, one pasteboard. `inputText` drops
 * characters in ordinary fields on this simulator — documented in CLAUDE.md,
 * and a half-typed password fails a sign-in in a way that reads as a broken
 * auth screen — so anything that must arrive exactly is pasted. Making the two
 * values identical means one `simctl pbcopy` serves both fields. The account is
 * local-only, in a database that is wiped by `supabase db reset`, and its
 * password is on a line of a public repository, which is the point: it is not a
 * secret and must never be mistaken for one.
 *
 * Idempotent. Re-running with the account already present is a success, because
 * the flows do not care whether this run or an earlier one created it.
 *
 *   npx tsx scripts/e2e-account.ts [--udid <simulator>] [--email <address>]
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import { OPEN_ROOM_FILTER } from "../src/features/rooms/rooms-gateway.js";

/** Published local-development key. Identical on every machine, useless elsewhere. */
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const DEFAULT_EMAIL = "e2e-lobby@arc21.test";
const SUPABASE_URL = "http://127.0.0.1:54321";
const AUTH_ADMIN = `${SUPABASE_URL}/auth/v1/admin/users`;
const REST = `${SUPABASE_URL}/rest/v1`;
const FUNCTIONS = `${SUPABASE_URL}/functions/v1`;

/** Published local-development key. Identical on every machine, useless elsewhere. */
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** No `iat` — see the note in `tests/server/economy-guards.integration.test.ts`. */
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

/**
 * The account's user id, whether this run created it or an earlier one did.
 *
 * ASKS FOR THE ONE ACCOUNT, rather than listing and searching. The first
 * version of this fetched `?page=1&per_page=200` and scanned the result, which
 * is the same mistake as asserting a place on a global leaderboard: it worked
 * on a fresh database and stopped working silently as the integration suites
 * filled the local one. By the time it was first run for real there were
 * **2,868 accounts**, the one being looked for was not in the first two
 * hundred, and the script died on "no account after ensuring it exists" —
 * which reads as a broken creation step rather than a broken lookup. The E2E
 * flow it exists for had therefore never run at all.
 *
 * GoTrue's `filter` is a SUBSTRING search over email and phone, so the exact
 * comparison stays: `e2e-lobby@arc21.test` must not be satisfied by
 * `e2e-lobby@arc21.test.invalid`.
 *
 * Throws when it cannot be found. A helper that reads something must throw
 * rather than return a sentinel: a null here would silently skip the cleanup
 * below and leave the next flow starting from a state nobody chose.
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
  if (!found) throw new Error(`no account for ${email} after ensuring it exists`);
  return found.id;
}

/**
 * Leave whatever table this account is still sitting at.
 *
 * NOT tidiness — determinism. `restore()` now puts a player back at their open
 * table, so a flow that ended early leaves the NEXT run looking at a seated
 * lobby instead of the create/join screen, and the failure reads as a missing
 * control. The room is left through `leave_room`, the same call the Leave
 * button makes, so the host role migrates exactly as it would in the app.
 */
async function leaveAnyOpenRoom(userId: string): Promise<void> {
  const token = signToken(userId);
  const headers = { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${token}` };

  const found = await fetch(
    `${REST}/rooms?select=id&or=(${encodeURIComponent(OPEN_ROOM_FILTER)})&limit=1`,
    { headers },
  );
  const rows = (await found.json()) as unknown;
  if (!Array.isArray(rows)) throw new Error(`could not read open rooms: ${JSON.stringify(rows)}`);
  const room = rows[0] as { id?: string } | undefined;
  if (!room?.id) return;

  const left = await fetch(`${REST}/rpc/leave_room`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ p_room_id: room.id }),
  });
  if (!left.ok) throw new Error(`could not leave ${room.id}: ${left.status} ${await left.text()}`);
  process.stdout.write(`left a table still open from an earlier run\n`);
}

/**
 * Cash out of whatever TABLE this account is still seated at.
 *
 * The same reason as `leaveAnyOpenRoom`, one layer over: a flow that ends early
 * — and an E2E flow that fails ends early by definition — leaves a live seat on
 * the server, and every quick-play, public-table and matchmaking screen then
 * refuses with "You are already seated at a table, and your chips are there."
 * The NEXT run reads that as a broken Deal button. It cost one run to find,
 * which is one more than it needed to.
 *
 * Cashed out through `create-session`'s CASH_OUT, the same call the Leave
 * button makes, so the escrow is settled exactly as it would be in the app —
 * the idempotency key is derived from `gameId:seatId`, so this cannot credit
 * twice however many times it runs.
 *
 * A seat that cannot be given up mid-hand USED TO BE left alone, on the grounds
 * that "it will settle on its own". That is true of a table with clocks and
 * false of every table this account actually plays: solo, career and the daily
 * challenge carry NO clocks on purpose, so `RESOLVE_TIMEOUT` can never fire and
 * a hand left mid-play stays mid-play for ever. A run of
 * `online-leave-mid-hand.yaml` that failed at the insurance offer left exactly
 * that, and the next run of any flow was answered "You are already seated at a
 * table" — which is the product working, and unstageable.
 *
 * So the hand is PLAYED OUT first, through `game-command`, using the same three
 * branches `reachPlayerTurns` in `tests/server` needs for the same reason: the
 * cascade after betting closes stops at PLAYER_TURNS, at INSURANCE_OFFER when
 * the dealer shows an ace, or at HAND_COMPLETE on a natural. Standing and
 * declining are the server's own absent-player defaults, so nothing here plays
 * the hand differently from letting a clock run out.
 */
async function leaveAnyOpenTable(userId: string): Promise<void> {
  const token = signToken(userId);
  const headers = { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${token}` };

  // Own seats only. `game_session_seats_select_participant` correctly shows a
  // player the OTHER stacks at a table they are at, so a filter on the user id
  // is required rather than implied — a lesson this repository has already
  // learned twice.
  const found = await fetch(
    `${REST}/game_session_seats` +
      `?select=game_session_id,status&user_id=eq.${userId}&status=eq.active&limit=5`,
    { headers },
  );
  const rows = (await found.json()) as unknown;
  if (!Array.isArray(rows)) throw new Error(`could not read seats: ${JSON.stringify(rows)}`);

  for (const row of rows as Array<{ game_session_id?: string }>) {
    if (!row.game_session_id) continue;
    const response = await fetch(`${FUNCTIONS}/create-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "CASH_OUT",
        gameId: row.game_session_id,
        clientRequestId: crypto.randomUUID(),
        clientSentAt: new Date().toISOString(),
      }),
    });
    if (response.ok) {
      process.stdout.write(`cashed out of a table left open from an earlier run\n`);
      continue;
    }
    const body = await response.text();
    if (!/SESSION_BUSY/.test(body)) {
      throw new Error(`could not cash out ${row.game_session_id}: ${response.status} ${body}`);
    }

    // Mid-hand. Play it to a boundary and ask again.
    await playToBoundary(token, row.game_session_id);
    const retry = await fetch(`${FUNCTIONS}/create-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "CASH_OUT",
        gameId: row.game_session_id,
        clientRequestId: crypto.randomUUID(),
        clientSentAt: new Date().toISOString(),
      }),
    });
    if (!retry.ok) {
      throw new Error(
        `played a table to its boundary and still could not cash out ` +
          `${row.game_session_id}: ${retry.status} ${await retry.text()}`,
      );
    }
    process.stdout.write(`played out a hand left mid-play, then cashed out\n`);
  }
}

/**
 * Stand the current hand out until the seat can be given up.
 *
 * Every command carries `expectedVersion`, and the version is read back from
 * the server's own answer rather than counted here — a stale one is answered
 * with the authoritative snapshot and applies nothing, which is exactly what
 * the first call wants.
 */
async function playToBoundary(token: string, gameId: string): Promise<void> {
  const command = async (type: string) => {
    const response = await fetch(`${FUNCTIONS}/game-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        gameId,
        clientActionId: crypto.randomUUID(),
        type,
        expectedVersion: version,
        clientSentAt: new Date().toISOString(),
      }),
    });
    const parsed = (await response.json()) as {
      publicState?: { version?: number; phase?: string };
    };
    if (typeof parsed.publicState?.version === "number") version = parsed.publicState.version;
    return { ok: response.ok, phase: parsed.publicState?.phase };
  };

  // A deliberately stale version, answered with the snapshot and nothing else.
  let version = 0;
  let phase = (await command("RESOLVE_TIMEOUT")).phase;

  for (let step = 0; step < 24; step += 1) {
    if (phase === "BETTING_OPEN" || phase === "HAND_COMPLETE" || phase === undefined) return;

    const answer = await command(
      phase === "INSURANCE_OFFER" ? "DECLINE_INSURANCE" : "STAND",
    );
    if (answer.ok) {
      phase = answer.phase;
      continue;
    }

    /*
     * A REFUSAL HERE IS USUALLY ABOUT SOMEBODY ELSE'S SEAT, and this helper is
     * the FOURTH in this repository to be caught by the phase after betting
     * closes. `reachPlayerTurns`, `dealAHand` and `standToSettlement` each
     * assumed the cascade stops in two places; this one knew about the third
     * and still could not act on it.
     *
     * `INSURANCE_OFFER` holds while ANY seat's decision is `PENDING`, and at a
     * tournament table three of the four seats belong to accounts that are not
     * here. This account's own decision is already recorded, so
     * `DECLINE_INSURANCE` is correctly refused — there is nothing left for it to
     * answer — and the table can only move when the server applies the absent
     * players' defaults at the deadline. `RESOLVE_TIMEOUT` is how that is asked
     * for, and it is refused until the deadline has actually passed.
     *
     * Measured: `could not play <gameId> out of INSURANCE_OFFER` on a table the
     * sprint flow left behind, which stranded the account — so the NEXT flow was
     * told "You are already seated at a table", which is the product working and
     * reads as a matchmaking regression.
     */
    const nudged = await command("RESOLVE_TIMEOUT");
    if (nudged.ok && nudged.phase !== undefined && nudged.phase !== phase) {
      phase = nudged.phase;
      continue;
    }

    // The deadline has not passed yet. Modes that carry no clocks never reach
    // here — they hold one seat, so this account's own command is accepted.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  throw new Error(
    `twenty-four commands did not end the hand at ${gameId}; last phase ${phase}`,
  );
}

async function ensureAccount(email: string): Promise<void> {
  const response = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
    },
    // The password IS the email — see the note at the top of this file.
    body: JSON.stringify({ email, password: email, email_confirm: true }),
  });

  if (response.ok) {
    process.stdout.write(`created ${email}\n`);
    return;
  }

  const body = await response.text();
  // Already there is the ordinary case on a second run, and is not a failure.
  if (response.status === 422 || /already been registered|already exists/i.test(body)) {
    process.stdout.write(`${email} already exists\n`);
    return;
  }
  throw new Error(`could not create ${email}: ${response.status} ${body}`);
}

/**
 * Yesterday's challenge, so the Daily screen has something to VERIFY.
 *
 * The fairness view checks the most recently CLOSED challenge: today's seed is
 * secret by design, so a database reset on the same UTC day leaves nothing for
 * it to show and the card is correctly absent. Production reaches this state on
 * its second day without anybody doing anything; a local run has to be given it.
 *
 * The seed is minted by the DATABASE, exactly as `ensure_daily_challenge_for`
 * does, so the commitment is a real SHA-256 of a real secret rather than a
 * fixture that happens to look like one — which is the only version of this
 * worth putting in front of the verification code.
 *
 * `docker exec psql` rather than PostgREST: `daily_challenges` is server-owned
 * and carries a `deny_client_write` trigger, which is the point of it.
 */
function seedYesterdaysChallenge(): void {
  const statement = `
    insert into public.daily_challenges
      (challenge_date, ruleset_id, seed_secret, seed_commitment,
       hand_count, starting_chips, tier, reward_chips, reward_xp, opens_at, closes_at)
    select (now() at time zone 'utc')::date - 1, r.id, s.secret,
           encode(extensions.digest(s.secret, 'sha256'), 'hex'),
           20, 5000, 'standard', 1000, 150,
           ((now() at time zone 'utc')::date - 1)::timestamptz,
           ((now() at time zone 'utc')::date)::timestamptz
    from public.rulesets r,
         (select 'arc21:daily:' || ((now() at time zone 'utc')::date - 1)::text || ':'
                 || encode(extensions.gen_random_bytes(32), 'hex') as secret) s
    where r.is_active
    limit 1
    on conflict (challenge_date) do nothing`;
  try {
    execFileSync(
      "docker",
      ["exec", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-tAc", statement],
      { encoding: "utf8" },
    );
    process.stdout.write("yesterday's challenge exists, so the seed reveal has something to publish\n");
  } catch {
    // No Docker, or a database that is not local. The account still works; only
    // the fairness card will be absent, which is the honest state without one.
    process.stdout.write("could not seed yesterday's challenge (no local database?)\n");
  }
}

async function main(): Promise<void> {
  const email = argument("email") ?? DEFAULT_EMAIL;
  const udid = argument("udid") ?? bootedUdid();

  await ensureAccount(email);
  seedYesterdaysChallenge();
  const userId = await findUserId(email);
  await leaveAnyOpenRoom(userId);
  await leaveAnyOpenTable(userId);

  // Onto the simulator's pasteboard, which is what the flow long-presses to
  // paste into both fields.
  execFileSync("xcrun", ["simctl", "pbcopy", udid], { input: email });
  process.stdout.write(`pasteboard on ${udid} holds the credential\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
