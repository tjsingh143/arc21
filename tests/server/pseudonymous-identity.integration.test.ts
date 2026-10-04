/** Real GoTrue + Mailpit + Postgres proof. No fabricated player JWTs. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { stackUp } from "./stack-guard.js";
import { createSupabaseAuthAdapter } from "../../src/features/auth/supabase-auth-adapter.js";
import type { ArcSupabaseClient } from "../../src/lib/supabase/client.js";

const URL = "http://127.0.0.1:54321";
// Published local-only test keys, identical to the existing integration suites.
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const ADMIN_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
function sdk(storage = new Map<string, string>(), fetcher: typeof fetch = fetch): ArcSupabaseClient {
  return createClient(URL, ANON, {
    auth: { flowType: "pkce", autoRefreshToken: false, detectSessionInUrl: false, storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: (key) => { storage.delete(key); },
    } },
    global: { fetch: fetcher },
  }) as ArcSupabaseClient;
}
const clients = Array.from({ length: 4 }, () => sdk());
const ids: string[] = [];
const admin = createClient(URL, ADMIN_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
function adapter(client: ArcSupabaseClient) {
  return createSupabaseAuthAdapter(client, { verificationClient: () => sdk() });
}
async function emailCode(address: string): Promise<string> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const response = await fetch(`http://127.0.0.1:54324/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
    const inbox = await response.json() as { messages: { ID: string }[] };
    if (inbox.messages?.[0]) {
      const mail = await (await fetch(`http://127.0.0.1:54324/api/v1/message/${inbox.messages[0].ID}`)).json() as { Text: string };
      const code = /\b(\d{6})\b/.exec(mail.Text)?.[1];
      if (code) return code;
      throw new Error("verification email has no six-digit code");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("verification email did not arrive");
}
async function identityState(client: ArcSupabaseClient) {
  const id = (await client.auth.getSession()).data.session!.user.id;
  const [profile, wallet, ledger, stats, friends, blocks, inventory] = await Promise.all([
    client.from("profiles").select("id,username,display_name,xp,level").eq("id", id).single(),
    client.from("wallets").select("balance,lifetime_credited").eq("user_id", id).single(),
    client.from("wallet_ledger").select("delta,reason,idempotency_key").eq("user_id", id).order("created_at"),
    client.from("player_stats").select("user_id,hands_played").eq("user_id", id).single(),
    client.rpc("list_friends"), client.rpc("list_blocked"), client.rpc("my_inventory"),
  ]);
  for (const result of [profile, wallet, ledger, stats, friends, blocks, inventory]) expect(result.error).toBeNull();
  return { profile: profile.data, wallet: wallet.data, ledger: ledger.data, stats: stats.data, friends: friends.data, blocks: blocks.data, inventory: inventory.data };
}
const suite = stackUp ? describe : describe.skip;
suite("pseudonymous identity lifecycle", () => {
  beforeAll(async () => {
    const results = await Promise.all(clients.map((client) => client.auth.signInAnonymously({ options: { data: { username: "admin", display_name: "Forged", is_anonymous: false, balance: 9999999 } } })));
    for (const result of results) {
      if (result.data.user) ids.push(result.data.user.id);
      expect(result.error).toBeNull();
      expect(result.data.user?.is_anonymous).toBe(true);
    }
  });
  afterAll(async () => {
    for (const id of ids) {
      const result = await admin.auth.admin.deleteUser(id);
      expect(result.error).toBeNull();
    }
  });
  it("creates unique filtered word handles and exactly one reconciled opening grant concurrently", async () => {
    const handles: string[] = [];
    for (const client of clients) {
      const state = await identityState(client);
      const profile = state.profile!;
      handles.push(profile.username);
      expect(profile.username).toMatch(/^[a-z]+_[a-z]+(?:_\d{6})?$/);
      expect(profile.display_name).toBe(profile.username);
      expect(profile.xp).toBe(0);
      expect(state.wallet?.balance).toBe(25000);
      expect(state.ledger).toHaveLength(1);
      expect(state.ledger?.[0]).toMatchObject({ delta: 25000, reason: "initial_grant", idempotency_key: `initial_grant:${profile.id}` });
    }
    expect(new Set(handles).size).toBe(clients.length);
  });
  it("restores and refreshes the same identity without creating a second opening grant", async () => {
    const client = clients[0]!;
    const current = (await client.auth.getSession()).data.session!;
    const storage = new Map<string, string>();
    const first = sdk(storage);
    expect((await first.auth.setSession(current)).error).toBeNull();
    const restored = sdk(storage);
    const boundary = adapter(restored);
    const results = await Promise.all([boundary.ensurePlayer(), boundary.ensurePlayer()]);
    for (const result of results) expect(result).toMatchObject({ ok: true, session: { account: { userId: ids[0], isAnonymous: true } } });
    const refresh = await restored.auth.refreshSession();
    expect(refresh.error).toBeNull();
    expect(refresh.data.user?.id).toBe(ids[0]);
    const tokenClaims = JSON.parse(Buffer.from(refresh.data.session!.access_token.split(".")[1]!, "base64url").toString());
    expect(tokenClaims.is_anonymous).toBe(true);
    // Use the rotated session for subsequent steps too.
    await client.auth.setSession(refresh.data.session!);
    expect((await identityState(client)).ledger).toHaveLength(1);
  });
  it("keeps anonymous RLS/economy boundaries and creates rate-limited friendships through the RPC", async () => {
    const a = clients[0]!, b = clients[1]!;
    expect((await a.from("wallets").select("balance").eq("user_id", ids[1]!)).data).toEqual([]);
    expect((await a.from("wallets").update({ balance: 999999 } as never).eq("user_id", ids[0]!)).error).not.toBeNull();
    expect((await a.from("friend_requests").insert({ sender_id: ids[0]!, receiver_id: ids[1]! } as never)).error).not.toBeNull();
    expect((await a.rpc("send_friend_request", { p_to: ids[1]! })).error).toBeNull();
    expect((await b.rpc("accept_friend_request", { p_from: ids[0]! })).error).toBeNull();
    expect((await a.rpc("block_player", { p_other: ids[2]! })).error).toBeNull();
    expect((await a.rpc("touch_last_seen")).error).toBeNull();
    expect((await b.rpc("touch_last_seen")).error).toBeNull();
    const visible = await a.rpc("list_friend_presence");
    expect(visible.error).toBeNull();
    expect(visible.data).toEqual([{ user_id: ids[1], state: "available" }]);
    expect((await clients[2]!.rpc("list_friend_presence")).data).toEqual([]);
  });
  it("verifies actual email ownership then attaches a password to the same identity and all its state", async () => {
    const a = clients[0]!;
    const boundary = adapter(a);
    const email = `b-secure-${randomUUID()}@arc21.test`;
    const before = await identityState(a);
    expect(await boundary.setSecuredPassword("Refresh-B-password-1")).toMatchObject({ ok: false, failure: { code: "EMAIL_NOT_CONFIRMED" } });
    expect(await boundary.startSecuring(email)).toMatchObject({ ok: true, verificationRequired: true, session: { account: { userId: ids[0], isAnonymous: true, pendingEmail: email } } });
    expect(await boundary.verifySecuringEmail(email, await emailCode(email))).toMatchObject({ ok: true, session: { account: { userId: ids[0], isAnonymous: false, emailConfirmed: true } } });
    expect(await boundary.setSecuredPassword("Refresh-B-password-1")).toMatchObject({ ok: true });
    expect(await identityState(a)).toEqual(before);
    const secondDevice = sdk();
    const signedIn = await secondDevice.auth.signInWithPassword({ email, password: "Refresh-B-password-1" });
    expect(signedIn.error).toBeNull();
    expect(signedIn.data.user?.id).toBe(ids[0]);
    const conflict = await adapter(clients[1]!).startSecuring(email);
    expect(conflict).toMatchObject({ ok: false, failure: { code: "EMAIL_IN_USE" } });
    expect((await clients[1]!.auth.getSession()).data.session?.user.id).toBe(ids[1]);
    expect((await identityState(clients[1]!)).wallet?.balance).toBe(25000);
  });
  it("does not replace a player when a code belongs to a different pending UUID", async () => {
    const email = `b-pending-${randomUUID()}@arc21.test`;
    const a = adapter(clients[2]!), b = adapter(clients[3]!);
    expect(await a.startSecuring(email)).toMatchObject({ ok: true });
    expect(await b.startSecuring(email)).toMatchObject({ ok: true });
    const code = await emailCode(email);
    // The most recent mail is for player 3. Player 2 cannot adopt it.
    expect(await a.verifySecuringEmail(email, code)).toMatchObject({ ok: false, failure: { code: "IDENTITY_CHANGED" } });
    expect((await clients[2]!.auth.getSession()).data.session?.user.id).toBe(ids[2]);
    // The intended player reconciles server verification, even though its code
    // was consumed in the detached client and it never received those tokens.
    expect(await b.verifySecuringEmail(email, code)).toMatchObject({ ok: true, session: { account: { userId: ids[3], isAnonymous: false } } });
    expect((await identityState(clients[3]!)).ledger).toHaveLength(1);
  });
});
