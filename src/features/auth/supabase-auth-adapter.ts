/**
 * Arc 21 — the Supabase implementation of `AuthAdapter`.
 *
 * The only file in `src/features/auth` that knows Supabase exists. Everything it
 * does is translation: SDK shapes in, `AuthResult` out; SDK errors in,
 * `AuthFailure` out. No policy decisions are made here — they belong in
 * `auth-machine.ts`, which is pure and tested.
 *
 * Every call is bounded by `withTimeout`. An auth request to a host that
 * silently drops packets otherwise leaves a "Signing in…" button pressed for
 * the platform's own timeout, which on mobile can exceed a minute.
 */

import type { ArcSupabaseClient } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import {
  authFailure,
  classifyAuthError,
  type AuthFailure,
} from "./auth-failure.js";
import { normaliseEmail, normaliseUsername } from "./credentials.js";
import type {
  AuthAdapter,
  AuthResult,
  AuthSessionSnapshot,
  AuthVoidResult,
  SignInRequest,
  SignUpRequest,
} from "./auth-adapter.js";

/** The subset of a Supabase session this app is allowed to care about. */
interface SessionLike {
  expires_at?: number | null;
  user: {
    id: string;
    email?: string | null;
    email_confirmed_at?: string | null;
    confirmed_at?: string | null;
  };
}

const NETWORK: AuthFailure = authFailure("NETWORK");

/**
 * Where a password-recovery email sends the player back to.
 *
 * Must match, literally, both `additional_redirect_urls` in
 * `supabase/config.toml` (GoTrue refuses to redirect anywhere not on that
 * list) and the route at `app/auth/recovery.tsx`. There is no single source
 * of truth across a TOML file and a filesystem route, so this constant and
 * the comment on that screen are each the other's warning.
 */
export const PASSWORD_RECOVERY_REDIRECT_URL = "arc21://auth/recovery";

export function createSupabaseAuthAdapter(
  client: ArcSupabaseClient,
  options: { readonly timeoutMs?: number } = {},
): AuthAdapter {
  const { timeoutMs } = options;
  // A PKCE code is single-use; a refused password does not undo its exchange.
  // Keep only the verified flow's identity so the same screen can retry the
  // password update. Never reuse it for a different code or signed-in account.
  let recovery: { code: string; userId: string } | null = null;

  async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
    // `Promise.resolve` because PostgREST's builder is a thenable, not a Promise.
    const result = await withTimeout(Promise.resolve(work), timeoutMs);
    return isTimedOut(result) ? null : result;
  }

  return {
    kind: "supabase",

    async getSession(): Promise<AuthResult> {
      const result = await bounded(client.auth.getSession());
      if (result === null) return { ok: false, failure: NETWORK };
      if (result.error) return { ok: false, failure: classifyAuthError(result.error) };
      return {
        ok: true,
        session: toSnapshot(result.data.session as SessionLike | null),
        verificationRequired: false,
      };
    },

    async signIn(request: SignInRequest): Promise<AuthResult> {
      const result = await bounded(
        client.auth.signInWithPassword({
          email: normaliseEmail(request.email),
          password: request.password,
        }),
      );
      if (result === null) return { ok: false, failure: NETWORK };
      if (result.error) return { ok: false, failure: classifyAuthError(result.error) };
      return {
        ok: true,
        session: toSnapshot(result.data.session as SessionLike | null),
        verificationRequired: result.data.session === null,
      };
    },

    async signUp(request: SignUpRequest): Promise<AuthResult> {
      const result = await bounded(
        client.auth.signUp({
          email: normaliseEmail(request.email),
          password: request.password,
          options: {
            // Read by `public.handle_new_user()`, which normalises it, runs it
            // through the same reserved-name filter a rename uses, and falls
            // back to a derived handle if it is taken or refused. The requested
            // handle is a request, never a guarantee — which is why the store
            // reads the assigned one back.
            data: { username: normaliseUsername(request.username) },
          },
        }),
      );
      if (result === null) return { ok: false, failure: NETWORK };
      if (result.error) return { ok: false, failure: classifyAuthError(result.error) };

      /*
       * When email confirmation is enabled and the address is already
       * registered, Supabase deliberately returns a success with an obfuscated
       * user and an empty `identities` array rather than an error, so that
       * sign-up cannot be used to enumerate accounts.
       *
       * We deliberately do NOT unpick that signal to show "email already in
       * use". Doing so would rebuild the exact oracle the server is protecting
       * against, in the client, for a marginal copy improvement. The player is
       * told to check their email — which is correct in both cases, because in
       * both cases an email is what arrives.
       */
      return {
        ok: true,
        session: toSnapshot(result.data.session as SessionLike | null),
        verificationRequired: result.data.session === null,
      };
    },

    async signOut(): Promise<AuthVoidResult> {
      recovery = null;
      /*
       * Local scope, not global.
       *
       * The default revokes every refresh token for the account, which signs the
       * player out of their other devices too. SECURITY.md permits being signed
       * in on several devices; "sign out" on this phone must mean this phone.
       */
      const result = await bounded(client.auth.signOut({ scope: "local" }));
      if (result === null) return { ok: false, failure: NETWORK };
      if (result.error) return { ok: false, failure: classifyAuthError(result.error) };
      return { ok: true };
    },

    async deleteAccount(): Promise<AuthVoidResult> {
      /*
       * The server erases the account; `delete_own_account()` takes no
       * arguments and reads the caller from the verified session, so this
       * cannot be pointed at anyone else.
       *
       * Clear the SDK's saved session only after confirmed deletion. Clearing
       * Zustand alone lets a cold launch restore the deleted account; clearing
       * either session before a refusal would sign out an account that remains.
       */
      const result = await bounded(client.rpc("delete_own_account"));
      if (result === null) return { ok: false, failure: NETWORK };
      if (result.error) return { ok: false, failure: classifyAuthError(result.error) };
      recovery = null;
      // The account is already gone. The SDK removes its saved session even
      // when GoTrue answers that the user no longer exists. A logout error
      // cannot turn confirmed deletion into an "account not deleted" verdict.
      await bounded(client.auth.signOut({ scope: "local" })).catch(() => null);
      return { ok: true };
    },

    async requestPasswordReset(email: string): Promise<AuthVoidResult> {
      const result = await bounded(
        // Without `redirectTo`, GoTrue falls back to `site_url` — a web URL
        // this app never serves. The email would have arrived and looked
        // sent; the link just would not have opened anything.
        client.auth.resetPasswordForEmail(normaliseEmail(email), {
          redirectTo: PASSWORD_RECOVERY_REDIRECT_URL,
        }),
      );
      if (result === null) return { ok: false, failure: NETWORK };
      if (result.error) return { ok: false, failure: classifyAuthError(result.error) };
      return { ok: true };
    },

    async completePasswordReset(code: string, newPassword: string): Promise<AuthVoidResult> {
      // The exchange reads the code verifier `resetPasswordForEmail` stored
      // via PKCE, on THIS device, and turns the one-time code into a session.
      // Nothing here trusts the code as an identity — GoTrue does that
      // verification, and a code that fails it never reaches `updateUser`.
      if (recovery?.code === code) {
        const current = await bounded(client.auth.getSession());
        if (current === null) return { ok: false, failure: NETWORK };
        if (current.error) return { ok: false, failure: classifyAuthError(current.error) };
        if (current.data.session?.user.id !== recovery.userId) {
          recovery = null;
          return { ok: false, failure: authFailure("RECOVERY_LINK_INVALID") };
        }
      } else {
        recovery = null;
        const exchanged = await bounded(client.auth.exchangeCodeForSession(code));
        if (exchanged === null) return { ok: false, failure: NETWORK };
        if (exchanged.error) return { ok: false, failure: classifyAuthError(exchanged.error) };
        if (!exchanged.data.session) {
          return { ok: false, failure: authFailure("RECOVERY_LINK_INVALID") };
        }
        recovery = { code, userId: exchanged.data.session.user.id };
      }

      const updated = await bounded(client.auth.updateUser({ password: newPassword }));
      if (updated === null) return { ok: false, failure: NETWORK };
      if (updated.error) return { ok: false, failure: classifyAuthError(updated.error) };
      recovery = null;
      return { ok: true };
    },

    async fetchAssignedUsername(): Promise<string | null> {
      const session = await bounded(client.auth.getSession());
      const userId = session?.data.session?.user.id;
      if (userId === undefined) return null;

      const result = await bounded(
        client.from("profiles").select("username").eq("id", userId).maybeSingle(),
      );
      if (result === null || result.error) return null;

      const username = (result.data as { username?: unknown } | null)?.username;
      return typeof username === "string" ? username : null;
    },

    onAuthStateChange(listener): () => void {
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        if (recovery && session?.user.id !== recovery.userId) recovery = null;
        listener(toSnapshot(session as SessionLike | null));
      });
      return () => data.subscription.unsubscribe();
    },
  };
}

function toSnapshot(session: SessionLike | null): AuthSessionSnapshot | null {
  if (session === null) return null;
  const user = session.user;
  return {
    account: {
      userId: user.id,
      email: user.email ?? null,
      emailConfirmed: Boolean(user.email_confirmed_at ?? user.confirmed_at),
      // Read separately; see `AuthAdapter.fetchAssignedUsername`.
      username: null,
    },
    expiresAt: session.expires_at ?? null,
  };
}
