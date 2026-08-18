/**
 * Arc 21 — credential validation.
 *
 * Pure, runtime-neutral, and deliberately *client-side only*. Nothing here is a
 * security control: the server validates every one of these rules again on
 * authoritative state, and a modified client can send whatever it likes. What
 * this file buys is a decent experience — telling someone their handle is too
 * short before a network round trip, rather than after one.
 *
 * The username rule is the exception worth reading carefully. It mirrors the
 * *format* half of `public.username_is_permitted` — `^[a-z0-9_]{3,20}$`, the
 * same expression the column CHECK constraint uses. It deliberately does NOT
 * mirror the reserved-name and profanity lists: those are a server authority
 * that will change, a copy here would drift from them silently, and a client
 * that answers "unavailable" from a stale list is worse than one that asks.
 *
 * Passwords pass through this module but are never stored by it, never returned
 * from it, and never appear in any value it produces. See `auth-machine.ts`.
 */

/** Same expression as the `profiles.username` CHECK constraint. */
export const USERNAME_PATTERN = /^[a-z0-9_]{3,20}$/;

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

/**
 * Eight rather than Supabase's default six.
 *
 * Chips have no monetary value, but an account carries a competitive record and
 * a friend list, and six characters is not a password.
 */
export const PASSWORD_MIN_LENGTH = 8;

/**
 * GoTrue hashes with bcrypt, which ignores everything past 72 bytes. A longer
 * password is not stronger, and — worse — a client that accepts 100 characters
 * teaches the user a password that a stricter server release will later reject.
 */
export const PASSWORD_MAX_LENGTH = 72;

/**
 * Pragmatic rather than RFC 5322 exhaustive: one `@`, something either side, a
 * dot in the domain, no whitespace. Every stricter regex in circulation rejects
 * addresses that genuinely deliver; the authoritative check is the verification
 * email arriving.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export interface CredentialFieldErrors {
  readonly email?: string;
  readonly password?: string;
  readonly username?: string;
}

/**
 * Trims and lowercases.
 *
 * Addresses are case-insensitive in every mailbox anyone actually uses, and
 * GoTrue stores them lowercased — so normalising here means "Sam@x.com" and
 * "sam@x.com" are one account in the UI as well as in the database, instead of
 * producing an "already registered" error the user cannot explain.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Trims and lowercases the handle.
 *
 * The database stores lowercase only, so a typed "Sam_21" must become "sam_21"
 * before it is checked — otherwise the client rejects a handle the server would
 * have accepted.
 */
export function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function validateEmail(email: string): string | undefined {
  const value = normaliseEmail(email);
  if (value === "") return "Enter your email address.";
  if (value.length > 254) return "That email address is too long.";
  if (!EMAIL_PATTERN.test(value)) return "That does not look like an email address.";
  return undefined;
}

export function validatePassword(password: string): string | undefined {
  if (password === "") return "Enter a password.";
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  return undefined;
}

export function validateUsername(username: string): string | undefined {
  const value = normaliseUsername(username);
  if (value === "") return "Choose a username.";
  if (value.length < USERNAME_MIN_LENGTH) {
    return `Usernames are at least ${USERNAME_MIN_LENGTH} characters.`;
  }
  if (value.length > USERNAME_MAX_LENGTH) {
    return `Usernames are at most ${USERNAME_MAX_LENGTH} characters.`;
  }
  if (!USERNAME_PATTERN.test(value)) {
    return "Use lowercase letters, numbers and underscores only.";
  }
  return undefined;
}

export interface SignInDraft {
  readonly email: string;
  readonly password: string;
}

export interface SignUpDraft extends SignInDraft {
  readonly username: string;
}

/** Empty object means "nothing to correct here", which is the only success signal. */
export function validateSignIn(draft: SignInDraft): CredentialFieldErrors {
  return compact({
    email: validateEmail(draft.email),
    // Sign-in checks presence only. Applying the length rule to an existing
    // account would lock out anyone who registered under an older policy, and
    // reporting "too short" on a sign-in attempt tells an attacker something
    // about the password they typed.
    password: draft.password === "" ? "Enter your password." : undefined,
  });
}

export function validateSignUp(draft: SignUpDraft): CredentialFieldErrors {
  return compact({
    email: validateEmail(draft.email),
    password: validatePassword(draft.password),
    username: validateUsername(draft.username),
  });
}

export function hasFieldErrors(errors: CredentialFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

function compact(errors: Record<string, string | undefined>): CredentialFieldErrors {
  const out: Record<string, string> = {};
  for (const [field, message] of Object.entries(errors)) {
    if (message !== undefined) out[field] = message;
  }
  return out as CredentialFieldErrors;
}
