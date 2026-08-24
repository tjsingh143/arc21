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
 * Throws when it cannot be found. A helper that reads something must throw
 * rather than return a sentinel: a null here would silently skip the cleanup
 * below and leave the next flow starting from a state nobody chose.
 */
async function findUserId(email: string): Promise<string> {
  const response = await fetch(`${AUTH_ADMIN}?page=1&per_page=200`, {
    headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${LOCAL_SERVICE_KEY}` },
  });
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

async function main(): Promise<void> {
  const email = argument("email") ?? DEFAULT_EMAIL;
  const udid = argument("udid") ?? bootedUdid();

  await ensureAccount(email);
  await leaveAnyOpenRoom(await findUserId(email));

  // Onto the simulator's pasteboard, which is what the flow long-presses to
  // paste into both fields.
  execFileSync("xcrun", ["simctl", "pbcopy", udid], { input: email });
  process.stdout.write(`pasteboard on ${udid} holds the credential\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
