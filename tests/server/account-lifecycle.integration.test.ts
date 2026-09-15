/**
 * ACCOUNT CREATION AND DELETION, against the real GoTrue and the real database.
 *
 * Two things live here that cannot be asserted anywhere else.
 *
 * 1. THE SIGNUP RACE. `handle_new_user` asks whether a requested handle is taken
 *    and then inserts it, and `not exists (select …)` answers against COMMITTED
 *    rows. Two signups a millisecond apart both find the handle free; the second
 *    violates `profiles_username_key`, which aborts the trigger, aborts the
 *    `auth.users` insert that fired it, and answers the player **HTTP 500** with
 *    no account. Twelve concurrent pairs produced twelve 500s before the fix.
 *
 *    This needs genuine concurrency through GoTrue, so pgTAP — one session, one
 *    transaction — cannot express it. `23_account_lifecycle.test.sql` covers
 *    everything about the lifecycle that a single session CAN prove; this covers
 *    the part that needs two.
 *
 * 2. DELETION THROUGH THE RPC THE APP ACTUALLY CALLS, with a token, over HTTP.
 *    The pgTAP file sets `request.jwt.claims` by hand, which proves the function
 *    but not that `authenticated` may reach it or that PostgREST renders the
 *    refusal as something the client can act on.
 *
 * A SKIP IS NOT A PASS. The guard requires a 401 from a function, for the same
 * reason every other file in this directory does.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import { stackUp } from "./stack-guard.js";
import { disposeAuthSubscription, setGuestIdentityStore, useAuthStore } from "../../src/features/auth/auth-store.js";
import { GuestIdentityStore } from "../../src/features/auth/guest.js";
import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import { setSupabaseAvailabilityForTests, type ArcSupabaseClient } from "../../src/lib/supabase/client.js";

afterEach(() => {
  disposeAuthSubscription();
  setGuestIdentityStore(null);
  setSupabaseAvailabilityForTests(null);
});

const SUPABASE_URL = "http://127.0.0.1:54321";
const AUTH = `${SUPABASE_URL}/auth/v1`;
const REST = `${SUPABASE_URL}/rest/v1`;

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/*
 * `service_role` HOLDS NO GRANT ON ANY TABLE IN THIS SCHEMA, deliberately: the
 * Edge Functions connect to Postgres directly and nothing is meant to reach the
 * data through PostgREST with a master key. So a profile is read here with a
 * real player's token — `profiles` is a directory to `authenticated` — and a
 * deleted account is confirmed gone through GoTrue's admin API, which is the
 * one thing the service key is still for. Written down because reaching for the
 * service key is the obvious move and it answers 403 with a hint suggesting you
 * grant it, which is the opposite of what this project wants.
 */

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * Backdated by 60 seconds, the same allowance the functions' own verifier makes.
 * PostgREST refuses a token whose `iat` is ahead of ITS clock, and the host and
 * the database container drift by a second or two under load — which does not
 * look like a clock problem, it looks like a wallet that reads as empty.
 */
function signToken(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({ sub, role: "authenticated", aud: "authenticated", iat: now - 60, exp: now + 3600 });
  const signature = crypto
    .createHmac("sha256", LOCAL_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

interface HttpResult {
  status: number;
  body: unknown;
  raw: string;
}

async function http(url: string, init: RequestInit & { key?: string } = {}): Promise<HttpResult> {
  const { key = LOCAL_ANON_KEY, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      ...(rest.headers ?? {}),
    },
  });
  const raw = await response.text();
  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* a 204 has no body */
  }
  return { status: response.status, body, raw };
}

const signUp = (email: string, username?: string) =>
  http(`${AUTH}/signup`, {
    method: "POST",
    body: JSON.stringify({
      email,
      password: "integration-password-123",
      ...(username === undefined ? {} : { data: { username } }),
    }),
  });

const suite = stackUp ? describe : describe.skip;

suite("account creation under contention", () => {
  it(
    "gives every one of eight simultaneous signups an account, and one of them the handle",
    async () => {
      // One handle, eight requests, all in flight together. Before the fix this
      // produced seven HTTP 500s and seven players with no account.
      const wanted = `race${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const results = await Promise.all(
        Array.from({ length: 8 }, (_unused, index) =>
          signUp(`race-${crypto.randomUUID()}-${index}@arc21.test`, wanted),
        ),
      );

      // The assertion that would have failed, stated as the failure it was.
      const failures = results.filter((result) => result.status !== 200);
      expect(
        failures.map((f) => `${f.status} ${f.raw.slice(0, 120)}`),
        "a concurrent signup must not be answered with a server error",
      ).toEqual([]);

      const ids = results.map((result) => (result.body as { user: { id: string } }).user.id);
      expect(new Set(ids).size).toBe(8);

      const profiles = await http(
        `${REST}/profiles?id=in.(${ids.join(",")})&select=id,username,display_name`,
        { headers: { Authorization: `Bearer ${signToken(ids[0]!)}` } },
      );
      expect(profiles.status).toBe(200);
      const rows = profiles.body as { id: string; username: string; display_name: string }[];

      // Every account exists, every handle is distinct, and exactly one player
      // got what they asked for — the other seven get a derived handle rather
      // than an error, which is what the requested handle always promised.
      expect(rows).toHaveLength(8);
      expect(new Set(rows.map((row) => row.username)).size).toBe(8);
      expect(rows.filter((row) => row.username === wanted)).toHaveLength(1);

      // The display name follows the handle the player actually got. Leaving it
      // as the requested one would show seven players a name that belongs to
      // the eighth.
      for (const row of rows) {
        expect(row.display_name).toBe(row.username);
      }
    },
    30_000,
  );

  it("still hands a solitary signup the handle it asked for", async () => {
    const wanted = `solo${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const created = await signUp(`solo-${crypto.randomUUID()}@arc21.test`, wanted);
    expect(created.status).toBe(200);

    const id = (created.body as { user: { id: string } }).user.id;
    const profile = await http(`${REST}/profiles?id=eq.${id}&select=username`, {
      headers: { Authorization: `Bearer ${signToken(id)}` },
    });
    expect((profile.body as { username: string }[])[0]?.username).toBe(wanted);
  });

  it("refuses a reserved handle by DERIVING one, never by failing the signup", async () => {
    // `admin` is on the reserved list. The account must still be created.
    const created = await signUp(`reserved-${crypto.randomUUID()}@arc21.test`, "admin");
    expect(created.status).toBe(200);

    const id = (created.body as { user: { id: string } }).user.id;
    const profile = await http(`${REST}/profiles?id=eq.${id}&select=username`, {
      headers: { Authorization: `Bearer ${signToken(id)}` },
    });
    const username = (profile.body as { username: string }[])[0]?.username;
    expect(username).not.toBe("admin");
    expect(username).toMatch(/^p[0-9a-f]{12}$/);
  });
});

suite("account deletion through the RPC the app calls", () => {
  it("deletes through the shipped store and stays signed out after restoring SDK storage", async () => {
    const email = `delete-${crypto.randomUUID()}@arc21.test`;
    const created = await signUp(email);
    expect(created.status).toBe(200);
    const id = (created.body as { user: { id: string } }).user.id;
    const storage = new Map<string, string>();
    const sdk = () => createClient(SUPABASE_URL, LOCAL_ANON_KEY, {
      auth: {
        autoRefreshToken: false,
        storage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => { storage.set(key, value); },
          removeItem: (key: string) => { storage.delete(key); },
        },
      },
    });
    const client = sdk();
    const signedIn = await client.auth.signInWithPassword({ email, password: "integration-password-123" });
    expect(signedIn.error).toBeNull();
    const token = signedIn.data.session!.access_token;
    setGuestIdentityStore(new GuestIdentityStore(new MemoryKeyValueStore()));
    setSupabaseAvailabilityForTests({ status: "ready", client: client as ArcSupabaseClient });
    useAuthStore.setState({ hydrated: false, mode: "unknown", session: null, guest: null });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().session?.account.userId).toBe(id);

    // The wallet the bootstrap funded is readable before, and the proof that
    // the token works at all.
    const before = await http(`${REST}/wallets?user_id=eq.${id}&select=balance`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(before.status).toBe(200);
    expect((before.body as { balance: number }[])[0]?.balance).toBe(25000);

    expect(await useAuthStore.getState().deleteAccount()).toBe(true);
    expect(useAuthStore.getState().mode).toBe("guest");

    // The same still-valid token now reads nothing, because there is nothing.
    const after = await http(`${REST}/wallets?user_id=eq.${id}&select=balance`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(after.status).toBe(200);
    expect(after.body).toEqual([]);

    // The auth record itself, asked of GoTrue rather than of a table.
    const gone = await http(`${AUTH}/admin/users/${id}`, {
      key: LOCAL_SERVICE_KEY,
      headers: { Authorization: `Bearer ${LOCAL_SERVICE_KEY}` },
    });
    expect(gone.status).toBe(404);

    // A cold native start creates another SDK client against the same saved
    // session. Clearing only Zustand would resurrect the deleted identity.
    disposeAuthSubscription();
    const restored = sdk();
    setSupabaseAvailabilityForTests({ status: "ready", client: restored as ArcSupabaseClient });
    useAuthStore.setState({ hydrated: false, mode: "unknown", session: null });
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().mode).toBe("guest");
    expect(useAuthStore.getState().session).toBeNull();
    expect((await restored.auth.getSession()).data.session).toBeNull();

    // And the credentials no longer sign in.
    const signIn = await http(`${AUTH}/token?grant_type=password`, {
      method: "POST",
      body: JSON.stringify({ email, password: "integration-password-123" }),
    });
    expect(signIn.status).toBe(400);
  }, 20_000);

  it("refuses an unauthenticated caller rather than deleting nothing quietly", async () => {
    const refused = await http(`${REST}/rpc/delete_own_account`, { method: "POST", body: "{}" });
    // `anon` holds no EXECUTE on it at all, so this never reaches the function.
    expect(refused.status).toBe(401);
  });
});
