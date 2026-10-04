/**
 * Arc 21 — the Supabase implementation of `AuthAdapter`.
 *
 * Owns supported SDK operations, same-player linking checks and error
 * translation. The mutation queue bounds the public wait while retaining
 * ownership of any SDK operation that is still running after that wait.
 * Read-only calls are bounded separately; human CAPTCHA time is excluded.
 *
 * A departure (sign-out, and the local half of account deletion) is judged by
 * what the keychain still holds, not by what GoTrue announced. GoTrue emits
 * SIGNED_OUT from inside its removal whether or not the credential actually
 * left, and keeps serving whatever storage returns. The final Refresh-B audit
 * (B-F2) showed nobody on screen while the departed player's credential was
 * still served, restored on relaunch and used for a friend request. So the
 * announcement is held while a departure runs and released only on the
 * storage's `removed` verdict (`secure-session-storage.ts`, point 3).
 *
 * And a credential is not a player until the server has said its account
 * exists. One the keychain restores may name an account erased since it was
 * stored — by this device, when a deletion lost its reply or its process
 * before the credential could leave, or by another device — and a cold launch
 * used to adopt that UUID as an ordinary ready player (B-G1). So only a player
 * the server has confirmed in this process reaches the store: GoTrue's own
 * announcements of any other player are dropped, and the adapter announces a
 * player itself at the moment the server vouches for it (`confirm`) — from a
 * sign-in's or a sign-up's own response, or by asking (`restore`). An answer
 * that never comes adopts nobody and removes nothing.
 *
 * And only the SERVER answers. `restore` used to ask through the SDK's
 * `getUser()`, which reads the session back out of the keychain before it
 * sends anything; the final Refresh-B audit (B-H3) made that read throw, and
 * the SDK returned `AuthSessionMissingError` without a request — the same name
 * GoTrue's own `session_not_found` is given. The adapter took it for the
 * server's word and adopted an ERASED account, having sent no `/user` at all.
 * So the question is now asked directly, with the exact restored token, and a
 * verdict can be made only out of an HTTP response the adapter itself received
 * (`askAuthServer`, `verdictOf`). No response, no verdict, nobody adopted.
 */

import { createTransientAuthClient, type ArcSupabaseClient } from "../../lib/supabase/client.js";
import { manageIdentity, mayActAs } from "../../lib/supabase/adopted-player.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import {
  authFailure,
  classifyAuthError,
  CREDENTIAL_RETAINED_AFTER_DELETION,
  DELETION_NOT_STARTED,
  ENDED_CREDENTIAL_RETAINED,
  ERASED_CREDENTIAL_RETAINED,
  type AuthFailure,
} from "./auth-failure.js";
import { normaliseEmail } from "./credentials.js";
import {
  getSessionStorageDurability,
  lastSessionRemoval,
  sessionRemovalMark,
  sessionRemovalSince,
  sessionStorageAcceptsChanges,
  type SessionRemovalOutcome,
} from "../../lib/supabase/secure-session-storage.js";
import { acquireCaptchaToken } from "./captcha.js";
import { createAuthMutationQueue } from "./auth-mutation-queue.js";
import { reportReachability } from "../../lib/connectivity/connectivity-store.js";
import type {
  AuthAdapter,
  AuthResult,
  AuthSessionSnapshot,
  AuthVoidResult,
  SignInRequest,
} from "./auth-adapter.js";

/** The subset of a Supabase session this app is allowed to care about. */
interface SessionLike {
  access_token?: string;
  expires_at?: number | null;
  user: {
    id: string;
    email?: string | null;
    email_confirmed_at?: string | null;
    confirmed_at?: string | null;
    is_anonymous?: boolean;
    new_email?: string | null;
  };
}

const NETWORK: AuthFailure = authFailure("NETWORK");

/**
 * What the auth server ANSWERED about one access token, or that it never did.
 *
 * `answered` is constructed in exactly one place — from the `Response` to the
 * adapter's own `GET /auth/v1/user` — so its existence is the proof that a
 * request went out and the server replied. A keychain that throws, a session
 * the SDK cannot load, a transport failure or a timeout produce `answered:
 * false`, and nothing else; there is no path from a locally generated error to
 * an answer (B-H3).
 */
type UserAnswer =
  | {
      readonly answered: true;
      readonly status: number;
      /** False when the body was not a JSON object. */
      readonly readable: boolean;
      readonly userId: string | null;
      /** GoTrue's error code: `code` from a versioned answer, `error_code` from an older one. */
      readonly code: string | null;
    }
  | { readonly answered: false };

/**
 * What a server answer says about the account a restored credential names.
 *
 * GoTrue checks the token's signature, then looks its subject up, then its
 * session — so `user_not_found` is the account having been erased, and nothing
 * else; `session_not_found` is a session ended while its account was FOUND.
 * Measured on the local GoTrue v2.195.0: an erased account's still-valid token
 * is answered 403 `user_not_found` although its sessions went with it, and a
 * revoked session of a live account 403 `session_not_found`. No answer at all,
 * a 5xx, or a body that cannot be read is no verdict, and must never be taken
 * for either; the failure each is reported as is the one the SDK's own error
 * mapping gives the same answer, so a screen says what it said before.
 */
type Existence =
  | { readonly kind: "exists" }
  | { readonly kind: "erased" }
  | { readonly kind: "ended" }
  | { readonly kind: "unknown"; readonly failure: AuthFailure };

/** The statuses `@supabase/auth-js` 2.112.3 treats as infrastructure, not as an answer (`NETWORK_ERROR_CODES`). */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530,
]);

function verdictOf(answer: UserAnswer, playerId: string): Existence {
  if (!answer.answered) return { kind: "unknown", failure: NETWORK };
  const { status, readable, code } = answer;
  if (status >= 200 && status < 300) {
    if (!readable) return { kind: "unknown", failure: NETWORK };
    return answer.userId === playerId
      ? { kind: "exists" }
      : { kind: "unknown", failure: authFailure("IDENTITY_CHANGED") };
  }
  if (RETRYABLE_STATUSES.has(status)) {
    return { kind: "unknown", failure: classifyAuthError({ name: "AuthRetryableFetchError", status }) };
  }
  if (!readable) return { kind: "unknown", failure: classifyAuthError({ name: "AuthUnknownError" }) };
  if (code === "user_not_found") return { kind: "erased" };
  if (code === "session_not_found") return { kind: "ended" };
  return { kind: "unknown", failure: classifyAuthError({ name: "AuthApiError", status, code: code ?? undefined }) };
}

/** GoTrue's own transport for a client: where it is, what it sends, how. */
interface AuthTransport {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetch: typeof fetch;
}

/**
 * Read off the client's auth half (`@supabase/auth-js` 2.112.3: `url`,
 * `headers`, `fetch`). Using the SDK's own transport keeps the request on the
 * same project, headers and fetch as every other auth call. A shape this does
 * not recognise asks nothing, which is no verdict: fail closed
 * (`tests/auth/user-verification-provenance.test.ts` pins the shape).
 */
function authTransportOf(client: ArcSupabaseClient): AuthTransport | null {
  const auth = client.auth as unknown as { readonly url?: unknown; readonly headers?: unknown; readonly fetch?: unknown };
  if (typeof auth.url !== "string" || typeof auth.fetch !== "function") return null;
  if (typeof auth.headers !== "object" || auth.headers === null) return null;
  return { url: auth.url, headers: auth.headers as Record<string, string>, fetch: auth.fetch as typeof fetch };
}

/** The question itself: `GET /auth/v1/user`, sent with exactly `token`. */
async function askAuthServer(client: ArcSupabaseClient, token: string): Promise<UserAnswer> {
  const transport = authTransportOf(client);
  if (transport === null) return { answered: false };
  const headers = new Headers(transport.headers);
  headers.set("X-Supabase-Api-Version", "2024-01-01");
  headers.set("Authorization", `Bearer ${token}`);
  let response: Response;
  try {
    response = await transport.fetch(`${transport.url}/user`, { method: "GET", headers });
  } catch {
    return { answered: false };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const readable = typeof body === "object" && body !== null && !Array.isArray(body);
  const fields = (readable ? body : {}) as { readonly id?: unknown; readonly code?: unknown; readonly error_code?: unknown };
  return {
    answered: true,
    status: response.status,
    readable,
    userId: typeof fields.id === "string" ? fields.id : null,
    code: typeof fields.code === "string" ? fields.code : typeof fields.error_code === "string" ? fields.error_code : null,
  };
}

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
  options: { readonly timeoutMs?: number; readonly verificationClient?: () => ArcSupabaseClient; readonly captcha?: () => Promise<string | undefined> } = {},
): AuthAdapter {
  const { timeoutMs } = options;
  // This client's identity is now the app's to manage: account-owned work on
  // it may be done only as the player the Auth store adopts (B-H1).
  manageIdentity(client);
  // A PKCE code is single-use; a refused password does not undo its exchange.
  // Keep only the verified flow's identity so the same screen can retry the
  // password update. Never reuse it for a different code or signed-in account.
  let recovery: { code: string; userId: string } | null = null;
  // Retained until the actual request settles, including after a UI timeout.
  // Concurrent mounts/reconnects never start a second anonymous signup.
  let creation: Promise<AuthResult> | null = null;
  let challenge = options.captcha ?? acquireCaptchaToken;
  // Every auth-state listener, so a held SIGNED_OUT can be released to them.
  const listeners = new Set<(session: AuthSessionSnapshot | null) => void>();
  // Set while a departure runs; `announced` records a SIGNED_OUT it is holding.
  let departure: { announced: boolean } | null = null;
  let rederiving = false;
  // The player the server has confirmed in THIS process — the only one whose
  // sessions GoTrue's announcements may deliver to the store (header).
  let confirmed: string | null = null;

  /**
   * The server has just vouched for `session`'s player: from here on it may be
   * shown. Announced from the operation itself, so a caller whose wait expired
   * still ends up showing the player the SDK now serves.
   */
  function confirm(session: SessionLike | null | undefined): void {
    if (!session || session.user.id === confirmed) return;
    confirmed = session.user.id;
    announce(toSnapshot(session));
  }

  /**
   * Signs this device out and says whether the credential actually left.
   *
   * Never throws. The held announcement is released from here — the actual
   * operation, which keeps running after a UI timeout — so a caller that gave
   * up waiting still ends up showing the state the keychain is in.
   */
  async function depart(): Promise<{ readonly error: unknown; readonly removal: SessionRemovalOutcome | "none" }> {
    const mark = sessionRemovalMark();
    const held = { announced: false };
    departure = held;
    let error: unknown = null;
    try {
      /*
       * Local scope, not global.
       *
       * The default revokes every refresh token for the account, which signs the
       * player out of their other devices too. SECURITY.md permits being signed
       * in on several devices; "sign out" on this phone must mean this phone.
       */
      error = (await client.auth.signOut({ scope: "local" })).error;
    } catch (cause) {
      error = cause;
    } finally {
      if (departure === held) departure = null;
    }
    const removal = sessionRemovalSince(mark);
    // Nothing of the departed player remains for anything to confirm.
    if (removal === "removed") confirmed = null;
    // A retained credential is still what GoTrue serves and what a relaunch
    // restores, so its player stays the player shown: the SIGNED_OUT is dropped.
    if (held.announced && removal !== "retained") announce(null);
    return { error, removal };
  }

  function announce(session: AuthSessionSnapshot | null): void {
    for (const listener of listeners) listener(session);
  }

  /**
   * Shows what GoTrue now serves — what a relaunch would restore. Bounded: an
   * answer that never comes proves nothing either way, so the screen is left
   * as it is rather than guessed at.
   */
  async function rederive(listener: (session: AuthSessionSnapshot | null) => void): Promise<void> {
    let session: SessionLike | null = null;
    try {
      const read = await withTimeout(client.auth.getSession(), timeoutMs);
      if (isTimedOut(read)) return;
      session = (read.data.session ?? null) as SessionLike | null;
    } catch {
      session = null;
    } finally {
      rederiving = false;
    }
    // Only a confirmed player is ever shown; an erased one is not, though served.
    if (listeners.has(listener)) listener(session?.user.id === confirmed ? toSnapshot(session) : null);
  }

  async function verifiedSession(): Promise<AuthResult> {
    const verified = await sdkResult(client.auth.getUser());
    if (verified === null) return { ok: false, failure: NETWORK };
    if (verified.error) return { ok: false, failure: classifyAuthError(verified.error) };
    const current = await sdkResult(client.auth.getSession());
    if (current === null) return { ok: false, failure: NETWORK };
    if (!current.data.session || current.data.session.user.id !== verified.data.user.id) {
      return { ok: false, failure: authFailure("IDENTITY_CHANGED") };
    }
    if (current.data.session.user.is_anonymous !== verified.data.user.is_anonymous ||
        current.data.session.user.email !== verified.data.user.email ||
        current.data.session.user.new_email !== verified.data.user.new_email) {
      const refreshed = await sdkResult(client.auth.refreshSession());
      if (refreshed === null) return { ok: false, failure: NETWORK };
      if (refreshed.error) return { ok: false, failure: classifyAuthError(refreshed.error) };
      if (refreshed.data.session?.user.id !== verified.data.user.id) return { ok: false, failure: authFailure("IDENTITY_CHANGED") };
      return { ok: true, session: toSnapshot(refreshed.data.session), verificationRequired: false };
    }
    return { ok: true, session: toSnapshot({ ...current.data.session, user: verified.data.user }), verificationRequired: false };
  }

  /**
   * The credential reconciliation. What the keychain holds, judged by the
   * storage (`secure-session-storage.ts`, point 4), then — for a credential it
   * can restore — by the server:
   *
   *   unreadable keychain              → nothing adopted, removed or created
   *   nothing restorable               → a new player (`create`)
   *   a credential, account exists     → adopted
   *   a credential, account erased     → never adopted; its departure finished
   *   a credential, session ended      → never adopted; removed, then a new player
   *   a credential, no verdict         → nothing adopted, nothing removed
   *
   * "No verdict" includes every answer the server did not give: a keychain
   * that threw, a token the SDK could not load, a transport failure (B-H3).
   */
  async function createOrRestore(): Promise<AuthResult> {
    const current = await client.auth.getSession();
    if (current.error) return { ok: false, failure: classifyAuthError(current.error) };
    if (current.data.session) return restore(current.data.session as SessionLike);
    return create();
  }

  async function create(): Promise<AuthResult> {
    // The keychain could not be read, or kept something it was asked to give
    // up: a new player stored over it might not be the one a relaunch finds.
    if (getSessionStorageDurability() === "unavailable") return { ok: false, failure: authFailure("PERSISTENCE_UNAVAILABLE") };
    const captchaToken = await challenge();
    // Recheck after a human challenge: another supported login may have completed.
    const afterChallenge = await client.auth.getSession();
    if (afterChallenge.error) return { ok: false, failure: classifyAuthError(afterChallenge.error) };
    if (afterChallenge.data.session) return restore(afterChallenge.data.session as SessionLike);
    const result = await client.auth.signInAnonymously({ options: { captchaToken } });
    if (result.error) return { ok: false, failure: classifyAuthError(result.error) };
    confirm(result.data.session as SessionLike | null);
    return { ok: true, session: toSnapshot(result.data.session), verificationRequired: false };
  }

  /**
   * A restored credential becomes a player only on the server's word (header),
   * asked about with that credential's exact token — not through `getUser()`,
   * whose keychain read can fail into a locally made `AuthSessionMissingError`
   * before anything is sent (B-H3). Already confirmed in this process: nothing
   * to ask.
   */
  async function restore(session: SessionLike): Promise<AuthResult> {
    const restored: AuthResult = { ok: true, session: toSnapshot(session), verificationRequired: false };
    if (session.user.id === confirmed) return restored;
    // No token in hand, no question to ask, and so no verdict.
    if (typeof session.access_token !== "string" || session.access_token === "") {
      return { ok: false, failure: authFailure("UNKNOWN") };
    }
    const existence = verdictOf(await askAuthServer(client, session.access_token), session.user.id);
    switch (existence.kind) {
      case "exists":
        confirm(session);
        return restored;
      case "erased":
        return finishErasure();
      case "ended":
        return finishEndedSession();
      case "unknown":
        // Not proof of anything. The credential stays exactly where it is, and
        // the reconnect handler asks again once the server is reachable.
        return { ok: false, failure: existence.failure };
    }
  }

  /**
   * The account is gone; its credential is still here — the deletion lost its
   * reply, its process, or its keychain before the credential could leave, or
   * another device erased it. Finish that departure now, as the deletion would
   * have, and say what happened instead of showing a stranger's fresh player:
   * automatic creation stays paused until Connect, as after any deletion.
   */
  async function finishErasure(): Promise<AuthResult> {
    confirmed = null;
    recovery = null;
    const { error, removal } = await depart();
    if (removal === "retained") {
      return { ok: false, failure: authFailure("CREDENTIAL_NOT_REMOVED", ERASED_CREDENTIAL_RETAINED) };
    }
    // GoTrue stopped before removing anything (offline at `/logout`): retried.
    if (removal === "none" && error) return { ok: false, failure: classifyAuthError(error) };
    return { ok: false, failure: authFailure("ACCOUNT_DELETED") };
  }

  /**
   * The server answered that this exact credential's session has ENDED — its
   * account found, so not erased. A credential the server has just refused is
   * not a player, so it is not adopted, whatever the keychain then serves.
   * Mid-run, a session GoTrue drops while the keychain keeps it stays shown
   * (B-F2, `rederive`): it was confirmed earlier and is still what every request
   * carries. At a launch nothing was confirmed, and treating "still served" as
   * proof would adopt the very credential the server refused (B-H3, §24).
   *
   * It is removed as any departure is. Nothing left: an ordinary start, exactly
   * as for an expired credential whose refresh the server refused. Kept by the
   * keychain: nobody adopted, and Connect retries the removal.
   */
  async function finishEndedSession(): Promise<AuthResult> {
    recovery = null;
    const { error, removal } = await depart();
    if (removal === "retained") {
      return { ok: false, failure: authFailure("CREDENTIAL_NOT_REMOVED", ENDED_CREDENTIAL_RETAINED) };
    }
    // GoTrue stopped before removing anything (offline at `/logout`): retried.
    if (removal === "none" && error) return { ok: false, failure: classifyAuthError(error) };
    return create();
  }


  async function sdkResult<T>(work: PromiseLike<T>): Promise<T | null> {
    // The mutation queue keeps ownership until the SDK request actually settles.
    // Only the public wait is bounded; a timeout cannot release a live mutation.
    return Promise.resolve(work);
  }

  const adapter: AuthAdapter = {
    kind: "supabase",

    async getSession(): Promise<AuthResult> {
      const result = await sdkResult(client.auth.getSession());
      if (result === null) return { ok: false, failure: NETWORK };
      if (result.error) return { ok: false, failure: classifyAuthError(result.error) };
      return {
        ok: true,
        session: toSnapshot(result.data.session as SessionLike | null),
        verificationRequired: false,
      };
    },

    async ensurePlayer(): Promise<AuthResult> {
      creation ??= createOrRestore().catch((cause: unknown): AuthResult => ({ ok: false, failure: classifyAuthError(cause) })).finally(() => { creation = null; });
      return await sdkResult(creation) ?? { ok: false, failure: NETWORK };
    },

    async signIn(request: SignInRequest): Promise<AuthResult> {
      if (creation && await sdkResult(creation) === null) return { ok: false, failure: NETWORK };
      const captchaToken = await challenge();
      const result = await sdkResult(
        client.auth.signInWithPassword({
          email: normaliseEmail(request.email),
          password: request.password,
          options: { captchaToken },
        }),
      );
      if (result === null) return { ok: false, failure: NETWORK };
      if (result.error) return { ok: false, failure: classifyAuthError(result.error) };
      // The server just authenticated this player; its session is the proof.
      confirm(result.data.session as SessionLike | null);
      return {
        ok: true,
        session: toSnapshot(result.data.session as SessionLike | null),
        verificationRequired: result.data.session === null,
      };
    },

    async startSecuring(email: string): Promise<AuthResult> {
      const before = await verifiedSession();
      if (!before.ok || !before.session) return before;
      const account = before.session.account;
      const normalized = normaliseEmail(email);
      if (!account.isAnonymous) {
        return account.email === normalized ? before : { ok: false, failure: authFailure("IDENTITY_CHANGED") };
      }
      const result = await sdkResult(client.auth.updateUser({ email: normalized }));
      if (result === null) return { ok: false, failure: NETWORK };
      if (result.error) return { ok: false, failure: classifyAuthError(result.error) };
      const after = await verifiedSession();
      if (!after.ok || after.session?.account.userId !== account.userId) return after.ok ? { ok: false, failure: authFailure("IDENTITY_CHANGED") } : after;
      return { ...after, verificationRequired: after.session.account.isAnonymous };
    },

    async verifySecuringEmail(email: string, code: string): Promise<AuthResult> {
      const before = await verifiedSession();
      if (!before.ok || !before.session) return before;
      const account = before.session.account;
      const normalized = normaliseEmail(email);
      // Reconcile a lost successful response before consuming the code again.
      if (!account.isAnonymous && account.emailConfirmed && account.email === normalized) return before;
      if (!account.isAnonymous || account.pendingEmail !== normalized) {
        return { ok: false, failure: authFailure("IDENTITY_CHANGED") };
      }
      const detached = options.verificationClient?.() ?? createTransientAuthClient(client);
      if (!detached) return { ok: false, failure: authFailure("SERVER") };
      const result = await sdkResult(detached.auth.verifyOtp({ email: normalized, token: code, type: "email_change" }));
      if (result === null) return { ok: false, failure: NETWORK };
      if (result.error) {
        return { ok: false, failure: result.error.code === "otp_expired" ? authFailure("VERIFICATION_CODE_INVALID") : classifyAuthError(result.error) };
      }
      if (result.data.user?.id !== account.userId || !result.data.session) {
        return { ok: false, failure: authFailure("IDENTITY_CHANGED") };
      }
      const current = await sdkResult(client.auth.getSession());
      if (current === null) return { ok: false, failure: NETWORK };
      if (current.data.session?.user.id !== account.userId) return { ok: false, failure: authFailure("IDENTITY_CHANGED") };
      // Only now may verification replace the token: the server UUID is equal.
      const adopted = await sdkResult(client.auth.setSession({
        access_token: result.data.session.access_token,
        refresh_token: result.data.session.refresh_token,
      }));
      if (adopted === null) return { ok: false, failure: NETWORK };
      if (adopted.error) return { ok: false, failure: classifyAuthError(adopted.error) };
      return verifiedSession();
    },

    async setSecuredPassword(password: string): Promise<AuthResult> {
      const before = await verifiedSession();
      if (!before.ok || !before.session) return before;
      if (before.session.account.isAnonymous || !before.session.account.emailConfirmed) {
        return { ok: false, failure: authFailure("EMAIL_NOT_CONFIRMED") };
      }
      const result = await sdkResult(client.auth.updateUser({ password }));
      if (result === null) return { ok: false, failure: NETWORK };
      // Same password is a successful reconciliation of a lost update response.
      if (result.error && result.error.code !== "same_password") return { ok: false, failure: classifyAuthError(result.error) };
      const after = await verifiedSession();
      if (after.ok && after.session?.account.userId !== before.session.account.userId) return { ok: false, failure: authFailure("IDENTITY_CHANGED") };
      return after;
    },

    async signOut(): Promise<AuthVoidResult> {
      if (creation && await sdkResult(creation) === null) return { ok: false, failure: NETWORK };
      recovery = null;
      const { error, removal } = await depart();
      // Still served, still restored on relaunch: nobody has left this device,
      // whatever the server said about the session.
      if (removal === "retained") return { ok: false, failure: authFailure("CREDENTIAL_NOT_REMOVED") };
      // Nothing restorable remains, which is what signing out of THIS device
      // means. GoTrue removes the local session even when the server could not
      // confirm the revocation, so that answer cannot undo the departure.
      if (removal === "removed") return { ok: true };
      // GoTrue stopped before removing anything; the player is still stored.
      if (error) return { ok: false, failure: classifyAuthError(error) };
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
       *
       * And ask first whether this device can change its saved credential at
       * all. The erasure cannot be taken back, and a keychain that refuses
       * changes now would leave the erased player restorable on the next launch
       * (B-F2). Nothing has been sent yet, so refusing here loses nothing.
       */
      if (!(await sessionStorageAcceptsChanges())) {
        return { ok: false, failure: authFailure("CREDENTIAL_NOT_REMOVED", DELETION_NOT_STARTED) };
      }
      const result = await sdkResult(client.rpc("delete_own_account"));
      if (result === null) return { ok: false, failure: NETWORK };
      if (result.error) return { ok: false, failure: classifyAuthError(result.error) };
      recovery = null;
      // Erased: nothing may confirm this player again, in this process or the next.
      confirmed = null;
      // The account is already gone. The SDK removes its saved session even
      // when GoTrue answers that the user no longer exists, and a logout error
      // cannot turn confirmed deletion into an "account not deleted" verdict.
      // A credential that did not leave, though, is not a clean departure: it
      // would be restored as the erased player, so its player stays shown and
      // is told how to finish. Deleting again is harmless; so is signing out.
      const { error, removal } = await depart();
      if (removal === "retained" || (removal === "none" && error)) {
        return { ok: false, failure: authFailure("CREDENTIAL_NOT_REMOVED", CREDENTIAL_RETAINED_AFTER_DELETION) };
      }
      return { ok: true };
    },

    async requestPasswordReset(email: string): Promise<AuthVoidResult> {
      const captchaToken = await challenge();
      const result = await sdkResult(
        // Without `redirectTo`, GoTrue falls back to `site_url` — a web URL
        // this app never serves. The email would have arrived and looked
        // sent; the link just would not have opened anything.
        client.auth.resetPasswordForEmail(normaliseEmail(email), {
          redirectTo: PASSWORD_RECOVERY_REDIRECT_URL,
          captchaToken,
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
        const current = await sdkResult(client.auth.getSession());
        if (current === null) return { ok: false, failure: NETWORK };
        if (current.error) return { ok: false, failure: classifyAuthError(current.error) };
        if (current.data.session?.user.id !== recovery.userId) {
          recovery = null;
          return { ok: false, failure: authFailure("RECOVERY_LINK_INVALID") };
        }
      } else {
        recovery = null;
        const exchanged = await sdkResult(client.auth.exchangeCodeForSession(code));
        if (exchanged === null) return { ok: false, failure: NETWORK };
        if (exchanged.error) return { ok: false, failure: classifyAuthError(exchanged.error) };
        if (!exchanged.data.session) {
          return { ok: false, failure: authFailure("RECOVERY_LINK_INVALID") };
        }
        recovery = { code, userId: exchanged.data.session.user.id };
        // GoTrue issued this session for the recovered player; the recovery
        // screen relies on it being shown, as the exchange's announcement was.
        confirm(exchanged.data.session as SessionLike);
      }

      const updated = await sdkResult(client.auth.updateUser({ password: newPassword }));
      if (updated === null) return { ok: false, failure: NETWORK };
      if (updated.error) return { ok: false, failure: classifyAuthError(updated.error) };
      recovery = null;
      return { ok: true };
    },

    async fetchAssignedUsername(): Promise<string | null> {
      const session = await sdkResult(client.auth.getSession());
      const userId = session?.data.session?.user.id;
      if (userId === undefined) return null;
      // A profile read as the adopted player only, never as a credential the
      // server has not confirmed (B-H1).
      if (!mayActAs(client, userId)) return null;

      const result = await sdkResult(
        client.from("profiles").select("username").eq("id", userId).maybeSingle(),
      );
      if (result === null || result.error) return null;

      const username = (result.data as { username?: unknown } | null)?.username;
      return typeof username === "string" ? username : null;
    },

    onAuthStateChange(listener): () => void {
      listeners.add(listener);
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        if (recovery && session?.user.id !== recovery.userId) recovery = null;
        if (session !== null && session.user.id !== confirmed) {
          // Not vouched for by the server yet: a credential GoTrue restored
          // from the keychain (INITIAL_SESSION, and the SIGNED_IN it announces
          // on start-up), or a sign-in that has not returned. `confirm`
          // announces it once the server has answered for it (B-G1).
          return;
        }
        if (session === null && departure !== null) {
          // The departure decides, once it knows whether the credential left.
          departure.announced = true;
          return;
        }
        if (session === null && lastSessionRemoval() === "retained" && !rederiving) {
          // GoTrue removed a session on its own — a refresh the server
          // refused, a session it no longer knows — and the keychain kept it.
          // Show what GoTrue will actually serve from now on: a still-valid
          // credential keeps its player, a dead one does not. Re-read outside
          // this callback, which runs inside GoTrue's lock.
          rederiving = true;
          setTimeout(() => { void rederive(listener); }, 0);
          return;
        }
        listener(toSnapshot(session as SessionLike | null));
      });
      return () => {
        listeners.delete(listener);
        data.subscription.unsubscribe();
      };
    },
  };
  // Supabase serializes token refresh itself. Serialize identity-changing app
  // intents as well, including the part after a UI timeout. Otherwise a late
  // updateUser/signup response can overwrite a successful later sign-in.
  const queue = createAuthMutationQueue(timeoutMs);
  const serialize = async <T extends AuthResult | AuthVoidResult>(work: () => Promise<T>, failure: (cause: unknown) => T, expectedUserId?: string | null): Promise<T> => {
    try {
      const result = await queue(async (human) => {
        challenge = () => human(options.captcha ?? acquireCaptchaToken);
        if (expectedUserId !== undefined) {
          const current = await client.auth.getSession();
          if (current.error) return failure(current.error);
          if ((current.data.session?.user.id ?? null) !== expectedUserId) {
            return { ok: false, failure: authFailure("PLAYER_CHANGED") } as T;
          }
        }
        return work();
      });
      if (isTimedOut(result)) { reportReachability(false); return failure({ name: "AuthRetryableFetchError" }); }
      if (!result.ok && result.failure.code === "NETWORK") reportReachability(false);
      return result;
    } catch (cause) { return failure(cause); }
  };
  const resultFailure = (cause: unknown): AuthResult => ({ ok: false, failure: classifyAuthError(cause) });
  const voidFailure = (cause: unknown): AuthVoidResult => ({ ok: false, failure: classifyAuthError(cause) });
  return {
    ...adapter,
    getSession: async () => {
      try {
        const result = await withTimeout(adapter.getSession(), timeoutMs);
        return isTimedOut(result) ? { ok: false, failure: NETWORK } : result;
      } catch (cause) { return resultFailure(cause); }
    },
    ensurePlayer: () => serialize(() => adapter.ensurePlayer(), resultFailure),
    signIn: (value) => serialize(() => adapter.signIn(value), resultFailure, value.expectedUserId),
    startSecuring: (email, expected) => serialize(() => adapter.startSecuring(email), resultFailure, expected),
    verifySecuringEmail: (email, code, expected) => serialize(() => adapter.verifySecuringEmail(email, code), resultFailure, expected),
    setSecuredPassword: (password, expected) => serialize(() => adapter.setSecuredPassword(password), resultFailure, expected),
    signOut: (expected) => serialize(() => adapter.signOut(), voidFailure, expected),
    deleteAccount: (expected) => serialize(() => adapter.deleteAccount(), voidFailure, expected),
    requestPasswordReset: (email) => serialize(() => adapter.requestPasswordReset(email), voidFailure),
    completePasswordReset: (code, password, expected) => serialize(() => adapter.completePasswordReset(code, password), voidFailure, expected),
    fetchAssignedUsername: async () => {
      try {
        const result = await withTimeout(adapter.fetchAssignedUsername(), timeoutMs);
        return isTimedOut(result) ? null : result;
      } catch { return null; }
    },
  };
}

function toSnapshot(session: SessionLike | null): AuthSessionSnapshot | null {
  if (session === null) return null;
  const user = session.user;
  return {
    account: {
      userId: user.id,
      email: user.email || null,
      isAnonymous: user.is_anonymous === true,
      pendingEmail: user.new_email || null,
      emailConfirmed: Boolean(user.email_confirmed_at),
      // Read separately; see `AuthAdapter.fetchAssignedUsername`.
      username: null,
    },
    expiresAt: session.expires_at ?? null,
  };
}
