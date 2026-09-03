/**
 * The public-table two-client scenario's view of the SERVER.
 *
 * Phase 7 built public multiplayer and deliberately did not walk it on two
 * devices: `public-matchmaking.yaml` proves the lone-player wait and the tier
 * gate, and stops before a seat is ever taken. So the thing nobody had watched
 * was the one that matters — two independent accounts matched into the SAME
 * public room, both charged, both dealt, and one leaving without ending the
 * table for the other.
 *
 * This is the half of that scenario a screenshot cannot show. It asks the
 * server, AS EACH ACCOUNT, through PostgREST and the same RPCs the app calls —
 * never with the service key, so every answer is one that account is genuinely
 * entitled to and RLS is part of what is being proved.
 *
 *   npx tsx scripts/two-client-public.ts --email <address> --what display-name
 *   npx tsx scripts/two-client-public.ts --email <address> --what state
 *   npx tsx scripts/two-client-public.ts --email <address> --what wallet
 *
 * `display-name` exists because the other player's card on the table is
 * labelled with their handle, and `handle_new_user` derives a random one — so a
 * flow cannot hard-code it and reading it off a screenshot would mean OCR. It
 * is passed in as `-e OTHER=…`, exactly as the private scenario passes the room
 * code.
 *
 * THROWS rather than printing a sentinel when it cannot read something. A helper
 * that answers `-1` for an unreadable wallet turns a harness fault into an
 * assertion about the wrong subject — this repository has paid for that once
 * already, with three failures spent on "expected 25200 to be 199".
 */

import crypto from "node:crypto";

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";

const SUPABASE_URL = "http://127.0.0.1:54321";
const AUTH_ADMIN = `${SUPABASE_URL}/auth/v1/admin/users`;
const REST = `${SUPABASE_URL}/rest/v1`;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * Backdated by sixty seconds, the same allowance the Edge Function's verifier
 * makes. PostgREST rejects a token whose `iat` is in the FUTURE by its own
 * clock — `PGRST303 "JWT issued at future"` — and the host and the database
 * container drift by a second or two under load. It never looks like a clock
 * problem: it looks like a wallet that reads as null.
 */
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

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

/** Exact match: GoTrue's `filter` is a SUBSTRING search over email and phone. */
async function findUserId(email: string): Promise<string> {
  const response = await fetch(`${AUTH_ADMIN}?filter=${encodeURIComponent(email)}&per_page=200`, {
    headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${LOCAL_SERVICE_KEY}` },
  });
  if (!response.ok) {
    throw new Error(`could not look up ${email}: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { users?: Array<{ id: string; email: string }> };
  const found = body.users?.find((user) => user.email === email);
  if (!found) throw new Error(`no account for ${email}`);
  return found.id;
}

async function asUser(token: string, path: string): Promise<unknown> {
  const response = await fetch(`${REST}/${path}`, {
    headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} answered ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function rpc(token: string, name: string): Promise<unknown> {
  const response = await fetch(`${REST}/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`rpc ${name} answered ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function main(): Promise<void> {
  const email = argument("email");
  if (!email) throw new Error("--email is required");
  const what = argument("what") ?? "state";

  const userId = await findUserId(email);
  const token = signToken(userId);

  if (what === "display-name") {
    /*
     * Read through `profiles` as the account itself. A directory read returns
     * every profile the policy permits, so it is filtered by id — CLAUDE.md
     * records a helper that took `rows[0]` from this very table and asserted a
     * stranger's XP.
     */
    const rows = (await asUser(token, `profiles?select=display_name&id=eq.${userId}`)) as Array<{
      display_name: string;
    }>;
    const name = rows[0]?.display_name;
    if (!name) throw new Error(`${email} has no display name`);
    process.stdout.write(`${name}\n`);
    return;
  }

  if (what === "wallet") {
    const rows = (await asUser(token, `wallets?select=balance&user_id=eq.${userId}`)) as Array<{
      balance: number;
    }>;
    const balance = rows[0]?.balance;
    if (typeof balance !== "number") throw new Error(`could not read ${email}'s wallet`);
    process.stdout.write(`${balance}\n`);
    return;
  }

  if (what === "state") {
    /*
     * `my_active_session()` is the product's own answer to "where are your
     * chips" — the same predicate `assertNoOtherLiveSeat` refuses on, which the
     * server suite asserts they agree about. Using it here means this script
     * reports what the APP would report, not a second opinion assembled from
     * raw tables.
     */
    const active = await rpc(token, "my_active_session");
    const session = (Array.isArray(active) ? active[0] : active) as
      | { game_session_id?: string; seat_id?: string; mode?: string }
      | undefined;

    const balanceRows = (await asUser(token, `wallets?select=balance&user_id=eq.${userId}`)) as Array<{
      balance: number;
    }>;

    /*
     * Every seat at that table, not only this account's. The participant policy
     * shows a player the other stacks on purpose, which is what makes a
     * one-sided read here a legitimate proof that both accounts are at the SAME
     * table — asked as one of them, never as the service role.
     */
    const seats = session?.game_session_id
      ? await asUser(
          token,
          `game_session_seats?select=id,seat_index,user_id,display_name,stack,buy_in,status,connected` +
            `&game_session_id=eq.${session.game_session_id}&order=seat_index.asc`,
        )
      : [];

    process.stdout.write(
      `${JSON.stringify(
        {
          email,
          userId,
          walletBalance: balanceRows[0]?.balance ?? null,
          activeSession: session?.game_session_id ?? null,
          mode: session?.mode ?? null,
          mySeat: session?.seat_id ?? null,
          seats,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  throw new Error(`unknown --what "${what}"`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
