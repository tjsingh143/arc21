/**
 * Arc 21 — what went wrong, in a form the UI can switch on.
 *
 * Auth errors arrive as prose from a service that may reword them at any time.
 * Rendering that prose directly produces two problems: copy in the app changes
 * without a release, and internal detail ("Database error saving new user")
 * reaches a player who can do nothing with it. So every error is classified into
 * a closed union here, and every message the user sees is written here.
 *
 * The classification is structural — it reads `code`, `status` and `name` off a
 * plain object — so this module needs no import from the Supabase SDK and every
 * branch is testable in a plain Node process.
 *
 * One deliberate non-decision: sign-in never distinguishes "no such account"
 * from "wrong password". Both are `INVALID_CREDENTIALS` with identical copy.
 * Telling them apart is an account-enumeration oracle, and a friendlier error
 * message is not worth handing an attacker a list of registered addresses.
 */

export type AuthFailureCode =
  /** The request never reached a verdict — offline, DNS, timeout, TLS. */
  | "NETWORK"
  /** Wrong email or wrong password. Deliberately indistinguishable. */
  | "INVALID_CREDENTIALS"
  /** The account exists but the address has not been confirmed yet. */
  | "EMAIL_NOT_CONFIRMED"
  /** Supabase Auth's own rate limit, or the app's. */
  | "RATE_LIMITED"
  /** Sign-up: something is already registered against that address. */
  | "EMAIL_IN_USE"
  /** Sign-up: the requested handle is taken, reserved, or filtered. */
  | "USERNAME_UNAVAILABLE"
  | "WEAK_PASSWORD"
  | "SAME_PASSWORD"
  | "INVALID_EMAIL"
  /**
   * The password-recovery deep link is missing its code, or the code was
   * rejected — already used, expired, or issued to a different device's PKCE
   * verifier. Distinct from `INVALID_CREDENTIALS`: nothing about a password
   * was tried, so the same "does not match an account" copy would be wrong.
   */
  | "RECOVERY_LINK_INVALID"
  /** New registrations are closed server-side. */
  | "SIGNUP_DISABLED"
  | "ACCOUNT_DISABLED"
  /** This build has no Supabase configuration at all. */
  | "NOT_CONFIGURED"
  /** The server answered, but with something unusable. */
  | "SERVER"
  | "PERSISTENCE_UNAVAILABLE"
  /**
   * A departure the keychain did not complete: the credential is still stored,
   * so the player is still signed in on this device. Never "signed out".
   */
  | "CREDENTIAL_NOT_REMOVED"
  /**
   * The credential this device restored names an account the server says no
   * longer exists. It was not adopted, and its departure was finished here.
   */
  | "ACCOUNT_DELETED"
  | "IDENTITY_CHANGED"
  | "PLAYER_CHANGED"
  | "VERIFICATION_CODE_INVALID"
  | "CAPTCHA_FAILED"
  | "UNKNOWN";

export interface AuthFailure {
  readonly code: AuthFailureCode;
  /** Ready to render. Never the raw server string. */
  readonly message: string;
  /** The field to attach the message to, when there is an obvious one. */
  readonly field?: "email" | "password" | "username";
}

export const AUTH_FAILURE_MESSAGES: Record<AuthFailureCode, string> = {
  NETWORK: "Could not reach the server. Check your connection and try again.",
  INVALID_CREDENTIALS: "That email and password do not match an account.",
  EMAIL_NOT_CONFIRMED:
    "This account still needs its email confirmed. Check your inbox for the link.",
  RATE_LIMITED: "Too many attempts. Wait a minute and try again.",
  EMAIL_IN_USE: "That email belongs to another player. Use another email to secure this player, or sign in to the existing player. Progress and chips are never merged.",
  USERNAME_UNAVAILABLE: "That username is taken or not available.",
  WEAK_PASSWORD: "That password is too easy to guess. Try a longer one.",
  SAME_PASSWORD: "Choose a different password from your current one.",
  INVALID_EMAIL: "That does not look like an email address.",
  RECOVERY_LINK_INVALID:
    "This reset link is invalid or has expired. Request a new one from Sign in.",
  SIGNUP_DISABLED: "New accounts are closed at the moment.",
  ACCOUNT_DISABLED: "This account is not available. Contact support if that is unexpected.",
  NOT_CONFIGURED:
    "This build has no server configured, so accounts are unavailable. Everything offline still works.",
  SERVER: "The server had a problem with that. Try again in a moment.",
  PERSISTENCE_UNAVAILABLE: "Secure device credentials could not be read or changed. Unlock or restart this device before reconnecting. Practice remains available.",
  CREDENTIAL_NOT_REMOVED: "This device could not remove its saved sign-in, so you are still signed in here. Try again in a moment.",
  ACCOUNT_DELETED: "The player saved on this device was deleted, so it was not restored and its sign-in has been removed. Connect to start a new player. Practice remains available.",
  IDENTITY_CHANGED: "This verification belongs to a different player. Your current player has not been replaced.",
  PLAYER_CHANGED: "Your player session changed before this action started. Reopen the screen and try again for your current player.",
  VERIFICATION_CODE_INVALID: "That code is invalid or expired. Check the email or request a new code.",
  CAPTCHA_FAILED: "Verification was not completed. You can try again or keep playing Practice.",
  UNKNOWN: "Something went wrong. Try again.",
};

/** `CREDENTIAL_NOT_REMOVED` before anything was sent: the account is untouched. */
export const DELETION_NOT_STARTED =
  "This device cannot change its saved sign-in right now, so nothing was deleted. Try again in a moment.";

/** `CREDENTIAL_NOT_REMOVED` after the server erased the account. */
export const CREDENTIAL_RETAINED_AFTER_DELETION =
  "Your account was deleted, but this device could not remove its saved sign-in. Sign out to finish.";

/**
 * `CREDENTIAL_NOT_REMOVED` when a launch finds the erased account's credential
 * and still cannot remove it. Nobody is shown, so there is nothing to sign out
 * of: connecting again retries the removal.
 */
export const ERASED_CREDENTIAL_RETAINED =
  "The player saved on this device was deleted, so it was not restored, but this device could not remove its saved sign-in yet. Try connecting again in a moment. Practice remains available.";

/**
 * `CREDENTIAL_NOT_REMOVED` when a launch finds a credential whose session the
 * server says has ended, and cannot remove it. Nobody is shown: the server
 * refused that credential, so it is not adopted. Connecting again retries.
 */
export const ENDED_CREDENTIAL_RETAINED =
  "The sign-in saved on this device has ended, so it was not restored, but this device could not remove it yet. Try connecting again in a moment. Practice remains available.";

const FIELD_BY_CODE: Partial<Record<AuthFailureCode, AuthFailure["field"]>> = {
  EMAIL_IN_USE: "email",
  INVALID_EMAIL: "email",
  EMAIL_NOT_CONFIRMED: "email",
  WEAK_PASSWORD: "password",
  SAME_PASSWORD: "password",
  USERNAME_UNAVAILABLE: "username",
};

export function authFailure(code: AuthFailureCode, message?: string): AuthFailure {
  const field = FIELD_BY_CODE[code];
  return field === undefined
    ? { code, message: message ?? AUTH_FAILURE_MESSAGES[code] }
    : { code, message: message ?? AUTH_FAILURE_MESSAGES[code], field };
}

/** The subset of an auth error this module reads. Structural on purpose. */
export interface AuthErrorLike {
  readonly name?: string;
  readonly code?: string;
  readonly status?: number;
  readonly message?: string;
}

/**
 * Maps anything thrown or returned by the auth layer onto a code.
 *
 * Ordering matters: the explicit `code` is trusted first because it is the
 * stable contract, `status` second, and the message text only as a last resort —
 * message matching is exactly the brittle thing this function exists to contain,
 * so it is confined to the bottom of the file rather than spread through the UI.
 */
export function classifyAuthError(error: unknown): AuthFailure {
  if (error === null || error === undefined) return authFailure("UNKNOWN");

  const candidate = error as AuthErrorLike;
  const code = typeof candidate.code === "string" ? candidate.code : "";
  const status = typeof candidate.status === "number" ? candidate.status : undefined;
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";

  // A fetch that never completed. `AuthRetryableFetchError` is the SDK's own
  // wrapper; status 0 and React Native's "Network request failed" cover the
  // cases that reach us unwrapped.
  if (
    name === "AuthRetryableFetchError" ||
    name === "TypeError" ||
    status === 0 ||
    message.includes("network request failed") ||
    message.includes("failed to fetch")
  ) {
    return authFailure("NETWORK");
  }

  switch (code) {
    case "captcha_failed":
    case "captcha_verification_failed":
      return authFailure("CAPTCHA_FAILED");
    case "anonymous_provider_disabled":
      return authFailure("SIGNUP_DISABLED");
    case "invalid_credentials":
    case "invalid_grant":
      return authFailure("INVALID_CREDENTIALS");
    case "email_not_confirmed":
      return authFailure("EMAIL_NOT_CONFIRMED");
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
    case "over_sms_send_rate_limit":
      return authFailure("RATE_LIMITED");
    case "user_already_exists":
    case "email_exists":
      return authFailure("EMAIL_IN_USE");
    case "weak_password":
      return authFailure("WEAK_PASSWORD");
    case "same_password":
      return authFailure("SAME_PASSWORD");
    case "email_address_invalid":
    case "email_address_not_authorized":
      return authFailure("INVALID_EMAIL");
    case "signup_disabled":
      return authFailure("SIGNUP_DISABLED");
    case "user_banned":
      return authFailure("ACCOUNT_DISABLED");
    // `SessionReplacementError`: the keychain could not take a DIFFERENT
    // player's credential, so the sign-in was refused before anything adopted
    // it. The device kept the player it had; that is the whole message.
    case "session_not_persisted":
      return authFailure("PERSISTENCE_UNAVAILABLE");
    // GoTrue's PKCE code-exchange failures: the code was already used, the
    // OTP behind it expired before it was clicked, or `flow_state` (which
    // holds the code verifier) was not found — all mean the same thing to a
    // player: this link no longer works.
    case "otp_expired":
    case "bad_code_verifier":
    case "flow_state_expired":
    case "flow_state_not_found":
    case "pkce_code_verifier_not_found":
      return authFailure("RECOVERY_LINK_INVALID");
    default:
      break;
  }

  if (status === 429) return authFailure("RATE_LIMITED");
  if (status !== undefined && status >= 500) return authFailure("SERVER");

  // Message matching, last and least. Older GoTrue releases answer 400 with no
  // `code` at all, and these two phrases are the ones that matter enough to be
  // worth the fragility.
  if (message.includes("invalid login credentials")) return authFailure("INVALID_CREDENTIALS");
  if (message.includes("already registered")) return authFailure("EMAIL_IN_USE");
  if (message.includes("email not confirmed")) return authFailure("EMAIL_NOT_CONFIRMED");

  if (status !== undefined && status >= 400) return authFailure("SERVER");
  return authFailure("UNKNOWN");
}
