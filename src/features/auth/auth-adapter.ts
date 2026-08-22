/**
 * Arc 21 — the auth boundary.
 *
 * Everything above this interface — the state machine, the store, both screens
 * and every test — is written against these six methods and knows nothing about
 * Supabase. That is what makes adding Sign in with Apple later a new adapter
 * method and a new button, rather than a rewrite of the sign-in flow: the
 * optional `signInWithProvider` is already the shape it will arrive in.
 *
 * Three properties are enforced by the types rather than by convention:
 *
 *   * **No method throws.** Every one returns a result union, so a caller cannot
 *     forget to handle failure and cannot accidentally let an auth error escape
 *     into a React render.
 *   * **No method returns a token.** The snapshot carries an account id, an
 *     address and an expiry — never an access token, never a refresh token.
 *     Application state has no business holding either; the SDK keeps them in
 *     the keychain.
 *   * **No method accepts an identity.** There is no `userId` parameter
 *     anywhere. Identity is whatever the verified session says it is.
 */

import type { AuthFailure } from "./auth-failure.js";

export interface AuthAccount {
  /** The server's `auth.users.id`. A guest has no equivalent. */
  readonly userId: string;
  readonly email: string | null;
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
      /**
       * Null when the project requires email confirmation: the account now
       * exists but nobody is signed in yet.
       */
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

  signUp(request: SignUpRequest): Promise<AuthResult>;
  signIn(request: SignInRequest): Promise<AuthResult>;
  signOut(): Promise<AuthVoidResult>;

  /**
   * Erases the account.
   *
   * Irreversible, and separate from `signOut` on purpose: the two share a
   * final state but nothing else, and a single method with a boolean would put
   * account deletion one wrong argument away from an ordinary sign-out.
   */
  deleteAccount(): Promise<AuthVoidResult>;

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
  completePasswordReset(code: string, newPassword: string): Promise<AuthVoidResult>;

  /**
   * Reads the handle the server actually assigned.
   *
   * Separate from `signUp` because it needs a session: the row is created by a
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
    signUp: refuse,
    signIn: refuse,
    signOut: refuseVoid,
    deleteAccount: refuseVoid,
    requestPasswordReset: refuseVoid,
    completePasswordReset: refuseVoid,
    fetchAssignedUsername: async () => null,
    onAuthStateChange: () => () => {},
  };
}
