/**
 * The room code the host's device just created, read from the database.
 *
 * The two-client Maestro scenario runs on two simulators sequentially, and the
 * guest's flow needs the six characters the host's screen is showing. Reading
 * them off a screenshot would mean OCR; reading them from the host's own row
 * costs one request and cannot be misread.
 *
 * It asks AS THE HOST — a token signed for that account, through PostgREST, so
 * `rooms_select_member` is the filter. There is no service-role read here and no
 * user id in the query: the policy answers "the rooms this caller is a joined
 * member of", which is exactly the question. That also makes this a small extra
 * proof that the room really is the host's.
 *
 *   CODE=$(npx tsx scripts/two-client-code.ts)
 *   CODE=$(npx tsx scripts/two-client-code.ts --email e2e-guest@arc21.test)
 *
 * Prints the code and nothing else, so it can be captured directly. Throws when
 * it cannot find one: a helper that reads something must never return a
 * sentinel, or a harness failure becomes an assertion about the wrong subject.
 */

import crypto from "node:crypto";

import { OPEN_ROOM_FILTER } from "../src/features/rooms/rooms-gateway.js";

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";

const SUPABASE_URL = "http://127.0.0.1:54321";
const AUTH_ADMIN = `${SUPABASE_URL}/auth/v1/admin/users`;
const REST = `${SUPABASE_URL}/rest/v1`;
const DEFAULT_EMAIL = "e2e-lobby@arc21.test";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** No `iat` — see the note in `tests/server/realtime.integration.test.ts`. */
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

/**
 * Exact match, not a substring.
 *
 * GoTrue's `filter` searches email and phone as a SUBSTRING, so
 * `e2e-lobby@arc21.test` would also be satisfied by
 * `e2e-lobby@arc21.test.invalid` — the same trap `scripts/e2e-account.ts`
 * documents, and the reason neither of them lists and scans.
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
  if (!found) throw new Error(`no account for ${email}`);
  return found.id;
}

async function main(): Promise<void> {
  const email = argument("email") ?? DEFAULT_EMAIL;
  const userId = await findUserId(email);
  const token = signToken(userId);

  // The app's own filter, imported rather than paraphrased: a change to what
  // the lobby considers an open room changes this too.
  const response = await fetch(
    `${REST}/rooms?select=code,status&or=(${encodeURIComponent(OPEN_ROOM_FILTER)})` +
      `&order=created_at.desc&limit=1`,
    { headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${token}` } },
  );
  const rows = (await response.json()) as unknown;
  if (!Array.isArray(rows)) {
    throw new Error(`could not read rooms: ${response.status} ${JSON.stringify(rows)}`);
  }
  const room = rows[0] as { code?: string } | undefined;
  if (!room?.code) throw new Error(`${email} has no open room — did the host flow run?`);

  process.stdout.write(`${room.code}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
