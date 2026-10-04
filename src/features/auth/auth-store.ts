/**
 * Every online player has a Supabase identity, including an unlinked player.
 * `guest` is retained only as the internal device-local Practice fallback.
 * Credentials stay in the SDK/keychain; passwords and OTPs are arguments only.
 */
import { create } from "zustand";
import { SqliteKeyValueStore } from "../../lib/persistence/key-value-store.js";
import { publishAdoptedPlayer } from "../../lib/supabase/adopted-player.js";
import { builtSupabaseClient, getSupabase, type ArcSupabaseClient } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import { createUnconfiguredAuthAdapter, type AuthAdapter, type AuthResult, type AuthSessionSnapshot } from "./auth-adapter.js";
import { authFailure, classifyAuthError, type AuthFailure } from "./auth-failure.js";
import { initialAuthFormState, reduceAuthForm, type AuthFormEvent, type AuthFormMode, type AuthFormState } from "./auth-machine.js";
import { validateEmail, validatePassword } from "./credentials.js";
import { GuestIdentityStore, type GuestIdentity } from "./guest.js";
import { createSupabaseAuthAdapter } from "./supabase-auth-adapter.js";

export const AUTH_HYDRATE_TIMEOUT_MS = 2_000;
export type AuthMode = "unknown" | "guest" | "account";
export interface AuthStoreState {
  readonly hydrated: boolean;
  readonly mode: AuthMode;
  readonly session: AuthSessionSnapshot | null;
  readonly guest: GuestIdentity | null;
  readonly configured: boolean;
  readonly configurationMessage: string | null;
  readonly form: AuthFormState;
  readonly bootstrapStatus: "idle" | "connecting" | "ready" | "unavailable";
  readonly bootstrapFailure: AuthFailure | null;
  /** A deliberate sign-out pauses automatic creation until Connect or relaunch. */
  readonly automaticBootstrap: boolean;
  hydrate: () => Promise<void>;
  ensurePlayer: () => Promise<void>;
  dispatch: (event: AuthFormEvent) => void;
  setMode: (mode: AuthFormMode) => void;
  signIn: (password: string, expectedUserId?: string | null) => Promise<void>;
  startSecuring: (email: string) => Promise<AuthFailure | null>;
  verifySecuringEmail: (email: string, code: string) => Promise<AuthFailure | null>;
  setSecuredPassword: (password: string) => Promise<AuthFailure | null>;
  requestPasswordReset: () => Promise<void>;
  completePasswordReset: (code: string, newPassword: string, expectedUserId?: string | null) => Promise<AuthFailure | null>;
  signOut: (expectedUserId?: string | null) => Promise<void>;
  deleteAccount: (expectedUserId?: string | null) => Promise<boolean>;
  continueAsGuest: () => Promise<void>;
}
let adapterOverride: AuthAdapter | null = null;
const adapters = new WeakMap<ArcSupabaseClient, AuthAdapter>();
let guestStore: GuestIdentityStore | null = null;
let unsubscribe: (() => void) | null = null;
let hydration: Promise<void> | null = null;
let bootstrap: Promise<void> | null = null;
export function setAuthAdapter(next: AuthAdapter | null): void { adapterOverride = next; }
export function setGuestIdentityStore(next: GuestIdentityStore | null): void { guestStore = next; }
export function disposeAuthSubscription(): void {
  unsubscribe?.(); unsubscribe = null;
  hydration = null; bootstrap = null;
}
export function activeAuthAdapter(): AuthAdapter {
  if (adapterOverride) return adapterOverride;
  const availability = getSupabase();
  if (availability.status !== "ready") return createUnconfiguredAuthAdapter(authFailure("NOT_CONFIGURED", availability.message));
  let adapter = adapters.get(availability.client);
  if (!adapter) { adapter = createSupabaseAuthAdapter(availability.client); adapters.set(availability.client, adapter); }
  return adapter;
}
function activeGuestStore(): GuestIdentityStore {
  guestStore ??= new GuestIdentityStore(new SqliteKeyValueStore());
  return guestStore;
}

export const useAuthStore = create<AuthStoreState>((set, get) => {
  function apply(event: AuthFormEvent): AuthFormState {
    const next = reduceAuthForm(get().form, event); set({ form: next }); return next;
  }
  function adopt(session: AuthSessionSnapshot | null): void {
    if (!session) { set({ session: null, mode: "guest", bootstrapStatus: "idle" }); return; }
    const known = get().session?.account.userId === session.account.userId ? get().session?.account.username : null;
    set({
      session: known && !session.account.username ? { ...session, account: { ...session.account, username: known } } : session,
      mode: "account", bootstrapStatus: "ready", bootstrapFailure: null,
    });
  }
  async function readHandle(): Promise<void> {
    const id = get().session?.account.userId;
    if (!id) return;
    const username = await activeAuthAdapter().fetchAssignedUsername().catch(() => null);
    const current = get().session;
    if (username && current?.account.userId === id) adopt({ ...current, account: { ...current.account, username } });
  }
  async function ensureGuest(): Promise<void> {
    if (get().guest) return;
    const result = await withTimeout(activeGuestStore().ensure(), AUTH_HYDRATE_TIMEOUT_MS);
    if (!isTimedOut(result)) set({ guest: result });
  }
  async function secure(operation: () => Promise<AuthResult>): Promise<AuthFailure | null> {
    try {
      const result = await operation();
      if (!result.ok) return result.failure;
      if (result.session) adopt(result.session);
      return null;
    } catch (cause) { return classifyAuthError(cause); }
  }
  return {
    hydrated: false, mode: "unknown", session: null, guest: null,
    configured: false, configurationMessage: null, form: initialAuthFormState("signIn"),
    bootstrapStatus: "idle", bootstrapFailure: null, automaticBootstrap: true,
    hydrate: () => {
      if (get().hydrated) return Promise.resolve();
      hydration ??= (async () => {
        const availability = getSupabase();
        const configured = availability.status === "ready";
        set({ configured, configurationMessage: configured ? null : availability.message });
        await ensureGuest().catch(() => undefined);
        // The app opens before any network authentication. Practice needs no server.
        set({ hydrated: true, mode: "guest", automaticBootstrap: true });
        if (!configured) { set({ bootstrapStatus: "unavailable" }); return; }
        unsubscribe?.();
        unsubscribe = activeAuthAdapter().onAuthStateChange((session) => {
          adopt(session);
          // Do not call another SDK method inside its auth-state callback lock.
          if (session) setTimeout(() => { void readHandle(); }, 0);
        });
        await get().ensurePlayer();
      })().finally(() => { hydration = null; });
      return hydration;
    },
    ensurePlayer: () => {
      if (!get().hydrated) return get().hydrate();
      if (bootstrap) return bootstrap;
      if (!get().configured) { set({ bootstrapStatus: "unavailable", bootstrapFailure: authFailure("NOT_CONFIGURED") }); return Promise.resolve(); }
      set({ automaticBootstrap: true, bootstrapStatus: "connecting", bootstrapFailure: null });
      bootstrap = (async () => {
        try {
          const result = await activeAuthAdapter().ensurePlayer();
          if (!result.ok) {
            set({ bootstrapStatus: get().session ? "ready" : "unavailable", bootstrapFailure: result.failure });
            return;
          }
          adopt(result.session);
          await readHandle();
        } catch (cause) {
          set({ bootstrapStatus: get().session ? "ready" : "unavailable", bootstrapFailure: classifyAuthError(cause) });
        }
      })().finally(() => { bootstrap = null; });
      return bootstrap;
    },
    dispatch: (event) => { apply(event); },
    setMode: (mode) => { apply({ type: "SET_MODE", mode }); },
    signIn: async (password, expectedUserId = get().session?.account.userId ?? null) => {
      if (apply({ type: "SUBMIT", password }).status.kind !== "submitting") return;
      try {
        const result = await activeAuthAdapter().signIn({ email: get().form.email, password, expectedUserId });
        if (!result.ok) { apply({ type: "FAILED", failure: result.failure }); return; }
        adopt(result.session); await readHandle();
        apply({ type: "SUCCEEDED", verificationRequired: result.verificationRequired });
      } catch (cause) { apply({ type: "FAILED", failure: classifyAuthError(cause) }); }
    },
    startSecuring: (email) => {
      const error = validateEmail(email);
      return error ? Promise.resolve(authFailure("INVALID_EMAIL", error)) : secure(() => activeAuthAdapter().startSecuring(email, get().session?.account.userId ?? null));
    },
    verifySecuringEmail: (email, code) => {
      if (!/^\d{6}$/.test(code)) return Promise.resolve(authFailure("VERIFICATION_CODE_INVALID"));
      return secure(() => activeAuthAdapter().verifySecuringEmail(email, code, get().session?.account.userId ?? null));
    },
    setSecuredPassword: (password) => {
      const error = validatePassword(password);
      return error ? Promise.resolve(authFailure("WEAK_PASSWORD", error)) : secure(() => activeAuthAdapter().setSecuredPassword(password, get().session?.account.userId ?? null));
    },
    requestPasswordReset: async () => {
      if (apply({ type: "SUBMIT_RESET" }).status.kind !== "submitting") return;
      try {
        const result = await activeAuthAdapter().requestPasswordReset(get().form.email);
        apply(result.ok ? { type: "RESET_LINK_SENT" } : { type: "FAILED", failure: result.failure });
      } catch (cause) { apply({ type: "FAILED", failure: classifyAuthError(cause) }); }
    },
    completePasswordReset: async (code, password, expectedUserId = get().session?.account.userId ?? null) => {
      try {
        const result = await activeAuthAdapter().completePasswordReset(code, password, expectedUserId);
        return result.ok ? null : result.failure;
      } catch (cause) { return classifyAuthError(cause); }
    },
    signOut: async (expectedUserId = get().session?.account.userId ?? null) => {
      set({ automaticBootstrap: false });
      const result = await activeAuthAdapter().signOut(expectedUserId).catch((cause: unknown) => ({ ok: false, failure: classifyAuthError(cause) }) as const);
      if (!result.ok) {
        // A timed-out operation may still be pending. Never assert that stored
        // credentials were removed until the SDK confirms it or emits SIGNED_OUT.
        apply({ type: "FAILED", failure: result.failure }); return;
      }
      adopt(null); set({ form: initialAuthFormState("signIn") });
      await ensureGuest();
    },
    deleteAccount: async (expectedUserId = get().session?.account.userId ?? null) => {
      const result = await activeAuthAdapter().deleteAccount(expectedUserId).catch((cause: unknown) => ({ ok: false, failure: classifyAuthError(cause) }) as const);
      if (!result.ok) { apply({ type: "FAILED", failure: result.failure }); return false; }
      adopt(null); set({ automaticBootstrap: false, form: initialAuthFormState("signIn") });
      await ensureGuest(); return true;
    },
    continueAsGuest: async () => { await ensureGuest(); if (!get().session) set({ mode: "guest" }); },
  };
});

/*
 * The player shown here is the ADOPTED player: this store takes one only from
 * the adapter, which delivers a player only on the auth server's word. Account-
 * owned work may be done only as that player (`adopted-player.ts`, B-H1), so the
 * network layer is told on every change, synchronously, whoever set it.
 */
function publishAdoption(state: AuthStoreState): void {
  publishAdoptedPlayer(builtSupabaseClient(), state.session?.account.userId ?? null);
}
publishAdoption(useAuthStore.getState());
useAuthStore.subscribe(publishAdoption);
