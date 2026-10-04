/**
 * The auth store: hydration, the guest path, and the flows end to end.
 *
 * The most important case in this file is the last section. A build with no
 * `EXPO_PUBLIC_SUPABASE_*` values must settle into a stated "not configured"
 * state — immediately, with no request attempted and no promise left pending.
 * The failure mode being designed against is not a crash, which is obvious and
 * gets fixed; it is a sign-in button that spins forever against a host that was
 * never configured, which looks like a slow network and gets shipped.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import { setSupabaseAvailabilityForTests } from "../../src/lib/supabase/client.js";
import type {
  AuthAdapter,
  AuthResult,
  AuthSessionSnapshot,
  AuthVoidResult,
} from "../../src/features/auth/auth-adapter.js";
import { authFailure } from "../../src/features/auth/auth-failure.js";
import { authStateName, initialAuthFormState } from "../../src/features/auth/auth-machine.js";
import {
  disposeAuthSubscription,
  setAuthAdapter,
  setGuestIdentityStore,
  useAuthStore,
} from "../../src/features/auth/auth-store.js";
import { GuestIdentityStore } from "../../src/features/auth/guest.js";

const PASSWORD = "correct-horse-battery";

function session(userId = "11111111-2222-4333-8444-555555555555"): AuthSessionSnapshot {
  return {
    account: { userId, email: "sam@example.com", emailConfirmed: true, username: null, isAnonymous: false, pendingEmail: null },
    expiresAt: 2_000_000_000,
  };
}

interface FakeOptions {
  signIn?: AuthResult;
  ensurePlayer?: AuthResult;
  securing?: AuthResult;
  getSession?: AuthResult;
  signOut?: AuthVoidResult;
  reset?: AuthVoidResult;
  completeReset?: AuthVoidResult | (() => AuthVoidResult);
  assignedUsername?: string | null;
}

function fakeAdapter(options: FakeOptions = {}): AuthAdapter & { calls: string[] } {
  const calls: string[] = [];
  const none: AuthResult = { ok: true, session: null, verificationRequired: false };

  return {
    kind: "fake",
    calls,
    async getSession() {
      calls.push("getSession");
      return options.getSession ?? none;
    },
    async signIn() {
      calls.push("signIn");
      return options.signIn ?? none;
    },
    async ensurePlayer() {
      calls.push("ensurePlayer");
      return options.ensurePlayer ?? options.getSession ?? none;
    },
    async startSecuring() { calls.push("startSecuring"); return options.securing ?? none; },
    async verifySecuringEmail() { calls.push("verifySecuringEmail"); return options.securing ?? none; },
    async setSecuredPassword() { calls.push("setSecuredPassword"); return options.securing ?? none; },
    async deleteAccount() {
      this.calls.push("deleteAccount");
      return { ok: true } as const;
    },
    async signOut() {
      calls.push("signOut");
      return options.signOut ?? { ok: true };
    },
    async requestPasswordReset() {
      calls.push("requestPasswordReset");
      return options.reset ?? { ok: true };
    },
    async completePasswordReset() {
      calls.push("completePasswordReset");
      if (typeof options.completeReset === "function") return options.completeReset();
      return options.completeReset ?? { ok: true };
    },
    async fetchAssignedUsername() {
      calls.push("fetchAssignedUsername");
      return options.assignedUsername ?? null;
    },
    onAuthStateChange() {
      calls.push("onAuthStateChange");
      return () => {};
    },
  };
}

function configured(): void {
  // The client is never touched in these tests — the adapter is injected — so a
  // placeholder is enough to make the build look configured.
  setSupabaseAvailabilityForTests({ status: "ready", client: {} as never });
}

function notConfigured(): void {
  setSupabaseAvailabilityForTests({
    status: "not-configured",
    problems: ["MISSING_URL", "MISSING_KEY"],
    message: "This build has no server configured, so accounts are unavailable.",
  });
}

beforeEach(() => {
  disposeAuthSubscription();
  setAuthAdapter(null);
  setGuestIdentityStore(new GuestIdentityStore(new MemoryKeyValueStore()));
  setSupabaseAvailabilityForTests(null);
  useAuthStore.setState({
    hydrated: false,
    mode: "unknown",
    session: null,
    guest: null,
    configured: false,
    configurationMessage: null,
    form: initialAuthFormState("signIn"),
    bootstrapStatus: "idle", bootstrapFailure: null, automaticBootstrap: true,
  });
});

describe("hydration", () => {
  it("settles into guest mode with a local identity when nobody is signed in", async () => {
    configured();
    setAuthAdapter(fakeAdapter());

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.mode).toBe("guest");
    expect(state.session).toBeNull();
    expect(state.guest?.guestId.startsWith("guest_")).toBe(true);
  });

  it("restores an existing session and reads back the assigned handle", async () => {
    configured();
    setAuthAdapter(
      fakeAdapter({
        getSession: { ok: true, session: session(), verificationRequired: false },
        assignedUsername: "sam_21",
      }),
    );

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.mode).toBe("account");
    expect(state.session?.account.username).toBe("sam_21");
  });

  it("opens as a guest when the auth service is unreachable", async () => {
    configured();
    const adapter = fakeAdapter({ getSession: { ok: false, failure: authFailure("NETWORK") } });
    setAuthAdapter(adapter);

    await useAuthStore.getState().hydrate();

    // The offline product must not be gated on a server answering.
    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().mode).toBe("guest");
  });

  it("is idempotent", async () => {
    configured();
    const adapter = fakeAdapter();
    setAuthAdapter(adapter);

    await useAuthStore.getState().hydrate();
    await useAuthStore.getState().hydrate();

    expect(adapter.calls.filter((call) => call === "ensurePlayer")).toHaveLength(1);
  });

  it("does not hang when local storage never answers", async () => {
    configured();
    setAuthAdapter(fakeAdapter());
    setGuestIdentityStore(
      new GuestIdentityStore({
        get: () => new Promise<string | null>(() => {}),
        set: () => new Promise<void>(() => {}),
        remove: () => new Promise<void>(() => {}),
      }),
    );

    const started = Date.now();
    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().hydrated).toBe(true);
    expect(useAuthStore.getState().mode).toBe("guest");
    expect(Date.now() - started).toBeLessThan(6_000);
  }, 15_000);
});

describe("sign in", () => {
  it("sends nothing when the form does not validate", async () => {
    configured();
    const adapter = fakeAdapter();
    setAuthAdapter(adapter);

    await useAuthStore.getState().signIn("");

    expect(adapter.calls).not.toContain("signIn");
    expect(authStateName(useAuthStore.getState().form.status)).toBe("validating");
  });

  it("adopts the session and reports signedIn", async () => {
    configured();
    setAuthAdapter(
      fakeAdapter({ signIn: { ok: true, session: session(), verificationRequired: false } }),
    );
    useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: "sam@example.com" });

    await useAuthStore.getState().signIn(PASSWORD);

    const state = useAuthStore.getState();
    expect(state.mode).toBe("account");
    expect(authStateName(state.form.status)).toBe("signedIn");
  });

  it("keeps the typed email after invalid credentials", async () => {
    configured();
    setAuthAdapter(
      fakeAdapter({ signIn: { ok: false, failure: authFailure("INVALID_CREDENTIALS") } }),
    );
    useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: "sam@example.com" });

    await useAuthStore.getState().signIn(PASSWORD);

    const state = useAuthStore.getState();
    expect(authStateName(state.form.status)).toBe("invalidCredentials");
    expect(state.form.email).toBe("sam@example.com");
    expect(state.mode).toBe("unknown");
  });

  it("never puts the password in the store", async () => {
    configured();
    setAuthAdapter(fakeAdapter());
    useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: "sam@example.com" });

    await useAuthStore.getState().signIn(PASSWORD);

    const { hydrate, dispatch, setMode, signIn, startSecuring, signOut, ...data } =
      useAuthStore.getState();
    expect(JSON.stringify(data)).not.toContain(PASSWORD);
  });

  it("reports a rate limit as its own state", async () => {
    configured();
    setAuthAdapter(fakeAdapter({ signIn: { ok: false, failure: authFailure("RATE_LIMITED") } }));
    useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: "sam@example.com" });

    await useAuthStore.getState().signIn(PASSWORD);

    expect(authStateName(useAuthStore.getState().form.status)).toBe("rateLimited");
  });

  it("turns a thrown error into a state rather than a rejection", async () => {
    configured();
    const adapter = fakeAdapter();
    adapter.signIn = () => Promise.reject(new TypeError("Network request failed"));
    setAuthAdapter(adapter);
    useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: "sam@example.com" });

    await expect(useAuthStore.getState().signIn(PASSWORD)).resolves.toBeUndefined();

    expect(authStateName(useAuthStore.getState().form.status)).toBe("networkError");
  });
});

describe("pseudonymous lifecycle", () => {
  const anonymous = (): AuthSessionSnapshot => ({ ...session(), account: { ...session().account, isAnonymous: true, email: null, emailConfirmed: false, pendingEmail: null } });
  it("automatically adopts a real server identity and assigned handle", async () => {
    configured();
    setAuthAdapter(fakeAdapter({ ensurePlayer: { ok: true, session: anonymous(), verificationRequired: false }, assignedUsername: "brisk_gecko" }));
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState()).toMatchObject({ mode: "account", bootstrapStatus: "ready", session: { account: { isAnonymous: true, username: "brisk_gecko" } } });
  });
  it("coalesces concurrent hydration and makes offline Practice available while creation is pending", async () => {
    configured();
    let resolve!: (result: AuthResult) => void;
    const adapter = fakeAdapter();
    adapter.ensurePlayer = vi.fn(() => new Promise<AuthResult>((done) => { resolve = done; }));
    setAuthAdapter(adapter);
    const first = useAuthStore.getState().hydrate();
    const second = useAuthStore.getState().hydrate();
    await vi.waitFor(() => expect(adapter.ensurePlayer).toHaveBeenCalledTimes(1));
    expect(useAuthStore.getState()).toMatchObject({ hydrated: true, mode: "guest", bootstrapStatus: "connecting" });
    resolve({ ok: true, session: anonymous(), verificationRequired: false });
    await Promise.all([first, second]);
    expect(useAuthStore.getState().mode).toBe("account");
  });
  it("can connect after an offline first launch without importing local state", async () => {
    configured();
    const adapter = fakeAdapter({ ensurePlayer: { ok: false, failure: authFailure("NETWORK") } });
    setAuthAdapter(adapter);
    await useAuthStore.getState().hydrate();
    const localIdentity = useAuthStore.getState().guest;
    adapter.ensurePlayer = vi.fn(async (): Promise<AuthResult> => ({ ok: true, session: anonymous(), verificationRequired: false }));
    await useAuthStore.getState().ensurePlayer();
    expect(adapter.ensurePlayer).toHaveBeenCalledWith();
    expect(useAuthStore.getState().guest).toBe(localIdentity);
    expect(useAuthStore.getState().mode).toBe("account");
  });
  it("keeps the same UUID across email securing and keeps secrets out of store state", async () => {
    configured();
    const secured = session();
    useAuthStore.setState({ session: anonymous(), mode: "account" });
    const adapter = fakeAdapter({ securing: { ok: true, session: secured, verificationRequired: false } });
    setAuthAdapter(adapter);
    expect(await useAuthStore.getState().startSecuring("sam@example.com")).toBeNull();
    expect(await useAuthStore.getState().verifySecuringEmail("sam@example.com", "123456")).toBeNull();
    expect(await useAuthStore.getState().setSecuredPassword(PASSWORD)).toBeNull();
    expect(useAuthStore.getState().session?.account.userId).toBe(secured.account.userId);
    expect(JSON.stringify(useAuthStore.getState())).not.toContain(PASSWORD);
    expect(JSON.stringify(useAuthStore.getState())).not.toContain("123456");
  });
  it("retains the current player on email conflict and rejects malformed input before sending", async () => {
    configured();
    const current = anonymous();
    useAuthStore.setState({ session: current, mode: "account" });
    const adapter = fakeAdapter({ securing: { ok: false, failure: authFailure("EMAIL_IN_USE") } });
    setAuthAdapter(adapter);
    expect((await useAuthStore.getState().startSecuring("bad"))?.code).toBe("INVALID_EMAIL");
    expect(adapter.calls).not.toContain("startSecuring");
    expect((await useAuthStore.getState().startSecuring("sam@example.com"))?.code).toBe("EMAIL_IN_USE");
    expect(useAuthStore.getState().session).toBe(current);
    expect((await useAuthStore.getState().verifySecuringEmail("sam@example.com", "x"))?.code).toBe("VERIFICATION_CODE_INVALID");
    expect(adapter.calls).not.toContain("verifySecuringEmail");
  });
});

describe("password reset", () => {
  it("reports the link as sent without revealing whether the account exists", async () => {
    configured();
    setAuthAdapter(fakeAdapter());
    useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: "sam@example.com" });

    await useAuthStore.getState().requestPasswordReset();

    expect(authStateName(useAuthStore.getState().form.status)).toBe("resetLinkSent");
  });

  it("does not send with an unusable address", async () => {
    configured();
    const adapter = fakeAdapter();
    setAuthAdapter(adapter);

    await useAuthStore.getState().requestPasswordReset();

    expect(adapter.calls).not.toContain("requestPasswordReset");
  });

  it("completes with the code from the link, and returns null on success", async () => {
    configured();
    const adapter = fakeAdapter({ completeReset: { ok: true } });
    setAuthAdapter(adapter);

    const failure = await useAuthStore.getState().completePasswordReset("a-code", "new-password-1");

    expect(failure).toBeNull();
    expect(adapter.calls).toContain("completePasswordReset");
  });

  it("returns the adapter's failure rather than throwing, for a used or expired code", async () => {
    configured();
    setAuthAdapter(
      fakeAdapter({
        completeReset: {
          ok: false,
          failure: { code: "RECOVERY_LINK_INVALID", message: "This reset link is invalid or has expired." },
        },
      }),
    );

    const failure = await useAuthStore.getState().completePasswordReset("stale-code", "new-password-1");

    expect(failure?.code).toBe("RECOVERY_LINK_INVALID");
  });

  it("classifies a thrown error rather than letting it escape to the screen", async () => {
    configured();
    setAuthAdapter(
      fakeAdapter({
        completeReset: () => {
          throw { code: "otp_expired" };
        },
      }),
    );

    const failure = await useAuthStore.getState().completePasswordReset("dead-code", "new-password-1");

    expect(failure?.code).toBe("RECOVERY_LINK_INVALID");
  });
});

describe("sign out", () => {
  it("returns to guest mode and clears the form", async () => {
    configured();
    setAuthAdapter(fakeAdapter());
    useAuthStore.setState({ session: session(), mode: "account" });

    await useAuthStore.getState().signOut();

    const state = useAuthStore.getState();
    expect(state.session).toBeNull();
    expect(state.mode).toBe("guest");
    expect(state.guest).not.toBeNull();
  });

  it("does not claim credentials were removed when sign-out is unconfirmed", async () => {
    // Someone who asked to sign out on a train must not stay signed in because
    // the tunnel ate the request.
    configured();
    setAuthAdapter(fakeAdapter({ signOut: { ok: false, failure: authFailure("NETWORK") } }));
    useAuthStore.setState({ session: session(), mode: "account" });

    await useAuthStore.getState().signOut();

    expect(useAuthStore.getState().session).not.toBeNull();
    expect(useAuthStore.getState().automaticBootstrap).toBe(false);
  });
});

describe("with no Supabase configuration", () => {
  it("hydrates into guest mode and says why, without crashing", async () => {
    notConfigured();

    await useAuthStore.getState().hydrate();

    const state = useAuthStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.mode).toBe("guest");
    expect(state.configured).toBe(false);
    expect(state.configurationMessage).toContain("no server configured");
  });

  it("still gives the guest a local identity", async () => {
    notConfigured();

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().guest?.guestId.startsWith("guest_")).toBe(true);
  });

  it("refuses a sign-in immediately rather than hanging", async () => {
    notConfigured();
    await useAuthStore.getState().hydrate();
    useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: "sam@example.com" });

    const started = Date.now();
    await useAuthStore.getState().signIn(PASSWORD);

    expect(authStateName(useAuthStore.getState().form.status)).toBe("notConfigured");
    // Settled by the missing configuration, not by a network timeout.
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("refuses securing and a reset without a configured backend", async () => {
    notConfigured();
    await useAuthStore.getState().hydrate();
    useAuthStore.getState().setMode("signUp");
    useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: "sam@example.com" });
    useAuthStore.getState().dispatch({ type: "EDIT_USERNAME", value: "sam_21" });

    expect((await useAuthStore.getState().startSecuring("sam@example.com"))?.code).toBe("NOT_CONFIGURED");

    await useAuthStore.getState().requestPasswordReset();
    expect(authStateName(useAuthStore.getState().form.status)).toBe("notConfigured");
  });

  it("lets a guest carry on regardless", async () => {
    notConfigured();
    await useAuthStore.getState().hydrate();

    await useAuthStore.getState().continueAsGuest();

    expect(useAuthStore.getState().mode).toBe("guest");
  });
});
