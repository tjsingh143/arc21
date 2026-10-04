/**
 * Arc 21 — the auth boundary.
 *
 * Screens and the session store depend on result unions and token-free snapshots.
 * Supabase owns identity and credentials. expectedUserId is only a local
 * stale-intent guard: it is never sent as identity or used instead of Auth.
 * Optional securing modifies the current player, while sign-in/recovery replaces
 * the device session only after the UI has explained any unlinked-player loss.
 */

import type { AuthFailure } from "./auth-failure.js";

export interface AuthAccount {
  /** The server's `auth.users.id`, for every online player. */
  readonly userId: string;
  readonly email: string | null;
  /** Supabase Auth owns this classification; never user metadata. */
  readonly isAnonymous: boolean;
  readonly pendingEmail: string | null;
  readonly emailConfirmed: boolean;
  /**
   * The handle on `public.profiles`, once it has been read back.
   *
   * Null means "not read yet", never "none": the account bootstrap trigger
   * always creates one. It matters because the trigger *substitutes* a derived
   * handle when the requested one is taken or filtered, so the handle a player
   * asked for and the handle they have are not always the same string.
   */
  readonly username: string | null;
}

export interface AuthSessionSnapshot {
  readonly account: AuthAccount;
  /** Epoch seconds, informational. Refresh is the SDK's job, not the UI's. */
  readonly expiresAt: number | null;
}

export type AuthResult =
  | {
      readonly ok: true;
      /** Null only when this result has no signed-in player. */
      readonly session: AuthSessionSnapshot | null;
      readonly verificationRequired: boolean;
    }
  | { readonly ok: false; readonly failure: AuthFailure };

export type AuthVoidResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: AuthFailure };

export interface SignInRequest {
  readonly email: string;
  readonly password: string;
  /** Local intent guard only; never sent as an authenticated identity. */
  readonly expectedUserId?: string | null;
}

export interface SignUpRequest extends SignInRequest {
  /** Requested, not guaranteed. See `AuthAccount.username`. */
  readonly username: string;
}

/** Reserved for the adapter's optional OAuth extension. */
export type OAuthProvider = "apple" | "google";

export interface AuthAdapter {
  /** Identifies the implementation in diagnostics. Never rendered. */
  readonly kind: "supabase" | "unconfigured" | "fake";

  /** The current session, if any. Bounded — never hangs on an unreachable host. */
  getSession(): Promise<AuthResult>;

  /** Restore first; create at most one request at a time. No supplied identity. */
  ensurePlayer(): Promise<AuthResult>;
  startSecuring(email: string, expectedUserId?: string | null): Promise<AuthResult>;
  verifySecuringEmail(email: string, code: string, expectedUserId?: string | null): Promise<AuthResult>;
  setSecuredPassword(password: string, expectedUserId?: string | null): Promise<AuthResult>;
  signIn(request: SignInRequest): Promise<AuthResult>;
  signOut(expectedUserId?: string | null): Promise<AuthVoidResult>;

  /**
   * Erases the account.
   *
   * Irreversible, and separate from `signOut` on purpose: the two share a
   * final state but nothing else, and a single method with a boolean would put
   * account deletion one wrong argument away from an ordinary sign-out.
   */
  deleteAccount(expectedUserId?: string | null): Promise<AuthVoidResult>;

  /**
   * Sends a reset link. Always reports success when the request was accepted,
   * whether or not the address has an account — the alternative is an
   * enumeration oracle.
   */
  requestPasswordReset(email: string): Promise<AuthVoidResult>;

  /**
   * Completes a reset started by `requestPasswordReset`, from the deep link's
   * own `code` — never from anything the player typed. Establishes a session
   * scoped to this reset and sets the new password within it; a used, expired
   * or foreign code fails here as `RECOVERY_LINK_INVALID` rather than
   * appearing to succeed.
   */
  completePasswordReset(code: string, newPassword: string, expectedUserId?: string | null): Promise<AuthVoidResult>;

  /**
   * Reads the handle the server actually assigned.
   *
   * Separate from creation because it needs a session: the row is created by a
   * trigger on `auth.users`, and `profiles` is not readable by `anon`.
   */
  fetchAssignedUsername(): Promise<string | null>;

  /** Returns an unsubscribe function. */
  onAuthStateChange(listener: (session: AuthSessionSnapshot | null) => void): () => void;

  /**
   * Not implemented today. Declared so the shape is agreed now and the screens
   * can feature-detect it (`adapter.signInWithProvider !== undefined`) instead
   * of being rewritten when it lands.
   */
  signInWithProvider?(provider: OAuthProvider): Promise<AuthResult>;
}

/**
 * The adapter used when this build has no Supabase configuration.
 *
 * It answers immediately and honestly rather than existing as a null the caller
 * has to remember to check. Every screen therefore has exactly one code path,
 * and "not configured" is a message rather than a crash or — worse — a spinner
 * waiting on a request that was never sent.
 */
export function createUnconfiguredAuthAdapter(failure: AuthFailure): AuthAdapter {
  const refuse = async (): Promise<AuthResult> => ({ ok: false, failure });
  const refuseVoid = async (): Promise<AuthVoidResult> => ({ ok: false, failure });

  return {
    kind: "unconfigured",
    getSession: refuse,
    ensurePlayer: refuse,
    startSecuring: refuse,
    verifySecuringEmail: refuse,
    setSecuredPassword: refuse,
    signIn: refuse,
    signOut: refuseVoid,
    deleteAccount: refuseVoid,
    requestPasswordReset: refuseVoid,
    completePasswordReset: refuseVoid,
    fetchAssignedUsername: async () => null,
    onAuthStateChange: () => () => {},
  };
}
