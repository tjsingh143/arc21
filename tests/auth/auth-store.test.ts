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

import { beforeEach, describe, expect, it } from "vitest";

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
    account: { userId, email: "sam@example.com", emailConfirmed: true, username: null },
    expiresAt: 2_000_000_000,
  };
}

interface FakeOptions {
  signIn?: AuthResult;
  signUp?: AuthResult;
  getSession?: AuthResult;
  signOut?: AuthVoidResult;
  reset?: AuthVoidResult;
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
    async signUp() {
      calls.push("signUp");
      return options.signUp ?? none;
    },
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

    expect(adapter.calls.filter((call) => call === "getSession")).toHaveLength(1);
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

    const { hydrate, dispatch, setMode, signIn, signUp, signOut, ...data } =
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

describe("sign up", () => {
  function readyToSignUp(): void {
    useAuthStore.getState().setMode("signUp");
    useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: "sam@example.com" });
    useAuthStore.getState().dispatch({ type: "EDIT_USERNAME", value: "sam_21" });
  }

  it("reports verification required when no session comes back", async () => {
    configured();
    setAuthAdapter(fakeAdapter({ signUp: { ok: true, session: null, verificationRequired: true } }));
    readyToSignUp();

    await useAuthStore.getState().signUp(PASSWORD);

    expect(authStateName(useAuthStore.getState().form.status)).toBe("verificationRequired");
  });

  it("reports the substituted handle when the server assigned a different one", async () => {
    /*
     * `handle_new_user()` does not fail on a taken handle — it derives one and
     * creates the account anyway. A client that ignored that would tell the
     * player they own a username they do not have.
     */
    configured();
    setAuthAdapter(
      fakeAdapter({
        signUp: { ok: true, session: session(), verificationRequired: false },
        assignedUsername: "p3f8a9b2c1d4",
      }),
    );
    readyToSignUp();

    await useAuthStore.getState().signUp(PASSWORD);

    const state = useAuthStore.getState();
    expect(authStateName(state.form.status)).toBe("usernameUnavailable");
    // The account was still created, and the player is signed in.
    expect(state.mode).toBe("account");
  });

  it("reports plain success when the requested handle was granted", async () => {
    configured();
    setAuthAdapter(
      fakeAdapter({
        signUp: { ok: true, session: session(), verificationRequired: false },
        assignedUsername: "sam_21",
      }),
    );
    readyToSignUp();

    await useAuthStore.getState().signUp(PASSWORD);

    expect(authStateName(useAuthStore.getState().form.status)).toBe("signedIn");
  });

  it("does not claim a substitution when the handle could not be read", async () => {
    configured();
    setAuthAdapter(
      fakeAdapter({
        signUp: { ok: true, session: session(), verificationRequired: false },
        assignedUsername: null,
      }),
    );
    readyToSignUp();

    await useAuthStore.getState().signUp(PASSWORD);

    // Unknown is not the same as wrong; inventing a substitution message would
    // be the client asserting something it did not read.
    expect(authStateName(useAuthStore.getState().form.status)).toBe("signedIn");
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

  it("clears the local session even when the server call fails", async () => {
    // Someone who asked to sign out on a train must not stay signed in because
    // the tunnel ate the request.
    configured();
    setAuthAdapter(fakeAdapter({ signOut: { ok: false, failure: authFailure("NETWORK") } }));
    useAuthStore.setState({ session: session(), mode: "account" });

    await useAuthStore.getState().signOut();

    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().mode).toBe("guest");
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

  it("refuses a sign-up and a reset the same way", async () => {
    notConfigured();
    await useAuthStore.getState().hydrate();
    useAuthStore.getState().setMode("signUp");
    useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: "sam@example.com" });
    useAuthStore.getState().dispatch({ type: "EDIT_USERNAME", value: "sam_21" });

    await useAuthStore.getState().signUp(PASSWORD);
    expect(authStateName(useAuthStore.getState().form.status)).toBe("notConfigured");

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
