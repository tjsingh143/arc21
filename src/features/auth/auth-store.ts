/**
 * Arc 21 — auth session state.
 *
 * A thin coordinator. It owns no rules: validation lives in `credentials.ts`,
 * every transition goes through `reduceAuthForm`, every remote call goes through
 * an `AuthAdapter`, and error classification lives in `auth-failure.ts`. If you
 * find yourself deciding here whether an email is well formed, you are in the
 * wrong file.
 *
 * Two invariants this file is responsible for:
 *
 *   * **The password is an argument, never a field.** `signIn(password)` hands
 *     it to the adapter and forgets it. It is never assigned into the store, so
 *     it cannot reach a devtools trace, a serialised state dump or a crash
 *     report.
 *   * **Nothing hangs.** Hydration is time-bounded like the practice table's,
 *     and every adapter call is bounded inside the adapter. A build with no
 *     Supabase configuration settles into a stated "not configured" state
 *     immediately rather than waiting on a request it never sent.
 *
 * Guest is the default resting state, not a failure. `mode` starts `unknown`,
 * becomes `guest` when hydration finds no session, and `account` when it finds
 * one. There is no state in which the player has nothing.
 */

import { create } from "zustand";

import { SqliteKeyValueStore } from "../../lib/persistence/key-value-store.js";
import { getSupabase } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import {
  createUnconfiguredAuthAdapter,
  type AuthAdapter,
  type AuthSessionSnapshot,
} from "./auth-adapter.js";
import { authFailure, classifyAuthError, type AuthFailure } from "./auth-failure.js";
import {
  initialAuthFormState,
  reduceAuthForm,
  type AuthFormEvent,
  type AuthFormMode,
  type AuthFormState,
} from "./auth-machine.js";
import { normaliseUsername } from "./credentials.js";
import { GuestIdentityStore, type GuestIdentity } from "./guest.js";
import { createSupabaseAuthAdapter } from "./supabase-auth-adapter.js";

/** How long hydration waits for local storage before continuing as a guest. */
export const AUTH_HYDRATE_TIMEOUT_MS = 2_000;

export type AuthMode = "unknown" | "guest" | "account";

export interface AuthStoreState {
  /** True once hydration has settled — including when it timed out or failed. */
  readonly hydrated: boolean;
  readonly mode: AuthMode;
  readonly session: AuthSessionSnapshot | null;
  readonly guest: GuestIdentity | null;
  /** False when this build has no usable Supabase configuration. */
  readonly configured: boolean;
  /** Plain-language reason, when `configured` is false. */
  readonly configurationMessage: string | null;
  readonly form: AuthFormState;

  hydrate: () => Promise<void>;
  dispatch: (event: AuthFormEvent) => void;
  setMode: (mode: AuthFormMode) => void;

  signIn: (password: string) => Promise<void>;
  signUp: (password: string) => Promise<void>;
  requestPasswordReset: () => Promise<void>;
  /**
   * Completes a reset from the recovery deep link. Deliberately outside
   * `AuthFormState` — the recovery screen is not the sign-in/sign-up form
   * and keeps its own local pending/error state, the same way the password
   * itself is kept local rather than lifted into the store. Returns the
   * failure to render, or null on success; a successful exchange fires the
   * adapter's own `onAuthStateChange` and adopts the session exactly as an
   * ordinary sign-in does.
   */
  completePasswordReset: (code: string, newPassword: string) => Promise<AuthFailure | null>;
  signOut: () => Promise<void>;
  /** Erases the account, then drops to guest. Irreversible. */
  deleteAccount: () => Promise<boolean>;
  /** Leaves the auth screens without signing in. Guest is a real destination. */
  continueAsGuest: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Injectable collaborators
//
// Left null until first use so a plain Node test process never reaches for
// expo-sqlite's or expo-secure-store's native modules — the same arrangement
// the practice and onboarding stores use.
// ---------------------------------------------------------------------------

let adapterOverride: AuthAdapter | null = null;
let guestStore: GuestIdentityStore | null = null;
let unsubscribe: (() => void) | null = null;

export function setAuthAdapter(next: AuthAdapter | null): void {
  adapterOverride = next;
}

export function setGuestIdentityStore(next: GuestIdentityStore | null): void {
  guestStore = next;
}

/**
 * Tears down the auth-state subscription. Called by tests between cases; the app
 * keeps one for its lifetime.
 */
export function disposeAuthSubscription(): void {
  unsubscribe?.();
  unsubscribe = null;
}

export function activeAuthAdapter(): AuthAdapter {
  if (adapterOverride !== null) return adapterOverride;

  const availability = getSupabase();
  if (availability.status !== "ready") {
    return createUnconfiguredAuthAdapter(
      authFailure("NOT_CONFIGURED", availability.message),
    );
  }
  return createSupabaseAuthAdapter(availability.client);
}

function activeGuestStore(): GuestIdentityStore {
  // The same local database the practice save and the onboarding flag use. One
  // local store, not three. Tests inject a memory-backed one instead.
  guestStore ??= new GuestIdentityStore(new SqliteKeyValueStore());
  return guestStore;
}

export const useAuthStore = create<AuthStoreState>((set, get) => {
  function apply(event: AuthFormEvent): AuthFormState {
    const next = reduceAuthForm(get().form, event);
    set({ form: next });
    return next;
  }

  function adoptSession(session: AuthSessionSnapshot | null): void {
    if (session === null) return;
    set({ session, mode: "account" });
  }

  async function ensureGuest(): Promise<GuestIdentity | null> {
    const existing = get().guest;
    if (existing !== null) return existing;

    const result = await withTimeout(activeGuestStore().ensure(), AUTH_HYDRATE_TIMEOUT_MS);
    if (isTimedOut(result)) return null;
    set({ guest: result });
    return result;
  }

  return {
    hydrated: false,
    mode: "unknown",
    session: null,
    guest: null,
    configured: false,
    configurationMessage: null,
    form: initialAuthFormState("signIn"),

    hydrate: async () => {
      if (get().hydrated) return;

      const availability = getSupabase();
      const configured = availability.status === "ready";
      set({
        configured,
        configurationMessage: configured ? null : availability.message,
      });

      // A guest identity exists regardless of whether anyone signs in. Doing
      // this first means the offline product is ready before any network call
      // is attempted, so a slow or absent server never delays the app opening.
      await ensureGuest().catch(() => null);

      if (!configured) {
        set({ hydrated: true, mode: "guest", session: null });
        return;
      }

      const adapter = activeAuthAdapter();

      let session: AuthSessionSnapshot | null = null;
      try {
        const result = await adapter.getSession();
        if (result.ok) session = result.session;
      } catch {
        // An unreachable auth service must not stop the app from opening as a
        // guest. Signing in remains available and will report the failure then.
      }

      if (session !== null) {
        const username = await adapter.fetchAssignedUsername().catch(() => null);
        if (username !== null) {
          session = { ...session, account: { ...session.account, username } };
        }
      }

      // One subscription for the app's lifetime. Token refreshes, expiry and a
      // sign-out performed on another screen all land here rather than being
      // discovered by a failing request.
      disposeAuthSubscription();
      unsubscribe = adapter.onAuthStateChange((next) => {
        set((current) => {
          if (next === null) return { session: null, mode: "guest" as const };
          /*
           * A refresh event carries a session snapshot with no username on it —
           * the handle lives on `profiles`, not on the token. Carrying the known
           * one forward when the account is unchanged stops every token refresh
           * from blanking the name in the header.
           */
          const known =
            current.session?.account.userId === next.account.userId
              ? current.session.account.username
              : null;
          return {
            session:
              known === null ? next : { ...next, account: { ...next.account, username: known } },
            mode: "account" as const,
          };
        });
        if (next === null) void ensureGuest();
      });

      set({
        hydrated: true,
        session,
        mode: session === null ? "guest" : "account",
      });
    },

    dispatch: (event) => {
      apply(event);
    },

    setMode: (mode) => {
      apply({ type: "SET_MODE", mode });
    },

    signIn: async (password) => {
      // Validation gates the request: the machine only reaches `submitting`
      // when every field passed, so nothing is sent for a form the player can
      // still see a problem with.
      if (apply({ type: "SUBMIT", password }).status.kind !== "submitting") return;

      const email = get().form.email;
      try {
        const result = await activeAuthAdapter().signIn({ email, password });
        if (!result.ok) {
          apply({ type: "FAILED", failure: result.failure });
          return;
        }
        adoptSession(result.session);
        apply({ type: "SUCCEEDED", verificationRequired: result.verificationRequired });
      } catch (cause) {
        apply({ type: "FAILED", failure: classifyAuthError(cause) });
      }
    },

    signUp: async (password) => {
      if (apply({ type: "SUBMIT", password }).status.kind !== "submitting") return;

      const { email, username } = get().form;
      const requested = normaliseUsername(username);

      try {
        const result = await activeAuthAdapter().signUp({ email, password, username: requested });
        if (!result.ok) {
          apply({ type: "FAILED", failure: result.failure });
          return;
        }

        adoptSession(result.session);

        if (result.session === null || result.verificationRequired) {
          // No session yet, so the assigned handle cannot be read. The check
          // happens on the first successful sign-in instead.
          apply({ type: "SUCCEEDED", verificationRequired: true });
          return;
        }

        /*
         * `handle_new_user()` substitutes a derived handle when the requested
         * one is taken, reserved or filtered — it does not fail the sign-up. A
         * client that did not read the result back would leave the player
         * believing they own a username they do not, and `profiles` is not
         * readable by `anon`, so this cannot be checked before submitting.
         */
        const assigned = await activeAuthAdapter().fetchAssignedUsername().catch(() => null);
        if (assigned !== null && assigned !== requested) {
          apply({ type: "USERNAME_SUBSTITUTED", requested, assigned });
          return;
        }
        apply({ type: "SUCCEEDED", verificationRequired: false });
      } catch (cause) {
        apply({ type: "FAILED", failure: classifyAuthError(cause) });
      }
    },

    requestPasswordReset: async () => {
      if (apply({ type: "SUBMIT_RESET" }).status.kind !== "submitting") return;

      const email = get().form.email;
      try {
        const result = await activeAuthAdapter().requestPasswordReset(email);
        if (!result.ok) {
          apply({ type: "FAILED", failure: result.failure });
          return;
        }
        apply({ type: "RESET_LINK_SENT" });
      } catch (cause) {
        apply({ type: "FAILED", failure: classifyAuthError(cause) });
      }
    },

    completePasswordReset: async (code, newPassword) => {
      try {
        const result = await activeAuthAdapter().completePasswordReset(code, newPassword);
        return result.ok ? null : result.failure;
      } catch (cause) {
        return classifyAuthError(cause);
      }
    },

    signOut: async () => {
      const result = await activeAuthAdapter()
        .signOut()
        .catch((cause: unknown) => ({ ok: false, failure: classifyAuthError(cause) }) as const);

      /*
       * The local session is dropped whatever the server said.
       *
       * A sign-out that fails because the network is down and leaves the player
       * apparently signed in is the wrong failure direction: they asked to
       * leave, and the refresh token is discarded locally either way.
       */
      set({ session: null, mode: "guest", form: initialAuthFormState("signIn") });
      await ensureGuest();

      if (!result.ok) {
        // Surfaced, but after the local state has already been cleared.
        apply({ type: "FAILED", failure: result.failure });
      }
    },

    deleteAccount: async () => {
      const result = await activeAuthAdapter()
        .deleteAccount()
        .catch((cause: unknown) => ({ ok: false, failure: classifyAuthError(cause) }) as const);

      if (!result.ok) {
        /*
         * The opposite of `signOut`'s failure direction, deliberately. A
         * sign-out that fails should still end the session locally; a deletion
         * that fails must NOT, because the account still exists and dropping
         * the session would hide that from the player.
         */
        apply({ type: "FAILED", failure: result.failure });
        return false;
      }

      set({ session: null, mode: "guest", form: initialAuthFormState("signIn") });
      await ensureGuest();
      return true;
    },

    continueAsGuest: async () => {
      await ensureGuest();
      set({ mode: get().session === null ? "guest" : "account" });
    },
  };
});
