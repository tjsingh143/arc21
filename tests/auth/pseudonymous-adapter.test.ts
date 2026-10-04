import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArcSupabaseClient } from "../../src/lib/supabase/client.js";
import { createSupabaseAuthAdapter } from "../../src/features/auth/supabase-auth-adapter.js";

const uid = "11111111-2222-4333-8444-555555555555";
const user = { id: uid, is_anonymous: true, email: "", new_email: "" };
const session = { user, access_token: "not-a-real-token", refresh_token: "not-a-real-refresh" };
const ok = (value: unknown) => ({ data: value, error: null });
function fixture(timeoutMs = 1000) {
  const auth = {
    getSession: vi.fn().mockResolvedValue(ok({ session: null })),
    getUser: vi.fn().mockResolvedValue(ok({ user })),
    signInAnonymously: vi.fn().mockResolvedValue(ok({ session, user })),
    signInWithPassword: vi.fn().mockResolvedValue(ok({ session })),
    updateUser: vi.fn().mockResolvedValue(ok({ user })),
    refreshSession: vi.fn().mockResolvedValue(ok({ session })),
    setSession: vi.fn().mockResolvedValue(ok({ session })),
    signOut: vi.fn().mockResolvedValue({ error: null }),
    // GoTrue's transport, which a restore now asks directly (`GET /user` with
    // the restored token) instead of through `getUser()` (B-H3).
    url: "http://auth.test/auth/v1",
    headers: {},
    fetch: vi.fn(async () => new Response(JSON.stringify(user), { status: 200, headers: { "content-type": "application/json" } })),
  };
  const detached = { auth: { verifyOtp: vi.fn().mockResolvedValue(ok({ session, user })) } };
  const adapter = createSupabaseAuthAdapter({ auth } as unknown as ArcSupabaseClient, {
    timeoutMs, verificationClient: () => detached as unknown as ArcSupabaseClient,
  });
  return { auth, detached, adapter };
}
afterEach(() => vi.useRealTimers());
describe("supported pseudonymous authentication", () => {
  it("restores an existing permanent session without creating another player", async () => {
    const { adapter, auth } = fixture();
    auth.getSession.mockResolvedValue(ok({ session: { ...session, user: { ...user, is_anonymous: false, email: "old@example.com" } } }));
    expect(await adapter.ensurePlayer()).toMatchObject({ ok: true, session: { account: { userId: uid, isAnonymous: false } } });
    expect(auth.signInAnonymously).not.toHaveBeenCalled();
  });
  it("does not create a replacement after a failed session read", async () => {
    const { adapter, auth } = fixture();
    auth.getSession.mockResolvedValue({ data: { session: null }, error: { name: "AuthRetryableFetchError" } });
    expect(await adapter.ensurePlayer()).toMatchObject({ ok: false, failure: { code: "NETWORK" } });
    expect(auth.signInAnonymously).not.toHaveBeenCalled();
  });
  it("serializes a late anonymous response before a subsequent sign-in, even after UI timeout", async () => {
    vi.useFakeTimers();
    const { adapter, auth } = fixture(10);
    let finish!: () => void;
    auth.signInAnonymously.mockImplementation(() => new Promise((resolve) => {
      finish = () => { auth.getSession.mockResolvedValue(ok({ session })); resolve(ok({ session, user })); };
    }));
    const first = adapter.ensurePlayer();
    await vi.advanceTimersByTimeAsync(11);
    expect(await first).toMatchObject({ ok: false, failure: { code: "NETWORK" } });
    const second = adapter.ensurePlayer();
    const signIn = adapter.signIn({ email: "old@example.com", password: "secret-value" });
    await vi.advanceTimersByTimeAsync(1);
    expect(auth.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    finish();
    await Promise.all([second, signIn]);
    expect(auth.signInAnonymously).toHaveBeenCalledTimes(1);
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);
  });
  it("verifies on a detached client and never adopts another pending player's code", async () => {
    const { adapter, auth, detached } = fixture();
    const pending = { ...user, new_email: "secure@example.com" };
    auth.getUser.mockResolvedValue(ok({ user: pending }));
    auth.getSession.mockResolvedValue(ok({ session: { ...session, user: pending } }));
    detached.auth.verifyOtp.mockResolvedValue(ok({ session: { ...session, user: { ...user, id: "another-player" } }, user: { ...user, id: "another-player" } }));
    expect(await adapter.verifySecuringEmail("secure@example.com", "123456")).toMatchObject({ ok: false, failure: { code: "IDENTITY_CHANGED" } });
    expect(auth.setSession).not.toHaveBeenCalled();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
  it("reconciles already-verified email before attempting to consume an OTP again", async () => {
    const { adapter, auth, detached } = fixture();
    const secured = { ...user, is_anonymous: false, email: "secure@example.com", email_confirmed_at: "2026-09-15" };
    auth.getUser.mockResolvedValue(ok({ user: secured }));
    auth.getSession.mockResolvedValue(ok({ session }));
    auth.refreshSession.mockResolvedValue(ok({ session: { ...session, user: secured } }));
    expect(await adapter.verifySecuringEmail("secure@example.com", "123456")).toMatchObject({ ok: true, session: { account: { userId: uid, isAnonymous: false } } });
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(detached.auth.verifyOtp).not.toHaveBeenCalled();
  });
  it("requires verified email before attaching a password", async () => {
    const { adapter, auth } = fixture();
    auth.getSession.mockResolvedValue(ok({ session }));
    expect(await adapter.setSecuredPassword("a-password")).toMatchObject({ ok: false, failure: { code: "EMAIL_NOT_CONFIRMED" } });
    expect(auth.updateUser).not.toHaveBeenCalled();
  });
  it("refuses an auth intent if the player changed while it was queued", async () => {
    const { adapter, auth } = fixture();
    auth.getSession.mockResolvedValue(ok({ session }));
    expect(await adapter.signIn({ email: "old@example.com", password: "password", expectedUserId: "departed-player" }))
      .toMatchObject({ ok: false, failure: { code: "PLAYER_CHANGED" } });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(await adapter.deleteAccount("departed-player"))
      .toMatchObject({ ok: false, failure: { code: "PLAYER_CHANGED" } });
  });
  it("does not time out a human challenge or create a player before it completes", async () => {
    vi.useFakeTimers();
    const { auth } = fixture();
    let solve!: (token: string) => void;
    const captcha = () => new Promise<string>((resolve) => { solve = resolve; });
    const adapter = createSupabaseAuthAdapter({ auth } as unknown as ArcSupabaseClient, { timeoutMs: 10, captcha });
    let settled = false;
    const pending = adapter.ensurePlayer().then((result) => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    expect(auth.signInAnonymously).not.toHaveBeenCalled();
    solve("single-use-test-token");
    expect(await pending).toMatchObject({ ok: true });
    expect(auth.signInAnonymously).toHaveBeenCalledWith({ options: { captchaToken: "single-use-test-token" } });
  });
  it("drops an expired queued sign-in instead of switching players much later", async () => {
    vi.useFakeTimers();
    const { adapter, auth } = fixture(10);
    let finish!: () => void;
    auth.signInAnonymously.mockImplementation(() => new Promise((resolve) => { finish = () => resolve(ok({ session, user })); }));
    const creating = adapter.ensurePlayer();
    await vi.advanceTimersByTimeAsync(1);
    const queued = adapter.signIn({ email: "old@example.com", password: "password" });
    await vi.advanceTimersByTimeAsync(11);
    expect(await queued).toMatchObject({ ok: false, failure: { code: "NETWORK" } });
    finish();
    await creating;
    await vi.advanceTimersByTimeAsync(1);
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

});
