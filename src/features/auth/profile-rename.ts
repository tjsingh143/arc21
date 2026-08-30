/**
 * Changing your display name or your handle.
 *
 * THE DEFECT THIS CLOSES. The server has implemented renaming since the profiles
 * migration and hardened it twice since:
 *
 *   `guard_profile_username`               normalises to lowercase, refuses a
 *                                          reserved or unpermitted handle
 *   `normalise_profile_display_name`       sanitises, refuses a name with no
 *                                          visible character
 *   `profile_username_change`              1 per 30 days, from
 *                                          `rate_limit_policies`
 *   `profile_display_name_change`          5 per hour
 *   `profiles_username_key`                the handle is unique
 *
 * `docs/AUDIT.md` records the limits being MEASURED over HTTP — "the 2nd rename
 * in 30 days returns 429" — and `CLAUDE.md` carries the fix that made that a
 * 429 instead of a 500, written up in terms of the player it misled: "a player
 * who renamed themselves twice in a month was told the server had broken."
 *
 * No player could reach any of it. Nothing in the app has ever written
 * `profiles.username` or `profiles.display_name` after signup — the Profile
 * screen READ both and offered no way to change either. Five server-side rules,
 * two rate-limit policies and a documented HTTP-status fix, all guarding a door
 * with no handle on the inside.
 *
 * ── WHY THE CLIENT VALIDATES AT ALL ─────────────────────────────────────────
 *
 * Not as a security control; the server decides. `credentials.ts` says the same
 * of its own rules and is right to. It is here so an obviously-wrong handle is
 * refused without a round trip and without spending one of the player's ONE
 * rename per thirty days on a typo. That budget is the reason this file exists
 * rather than the screen simply sending whatever was typed.
 *
 * Runtime-neutral: no React, React Native or Expo import.
 */

import {
  normaliseUsername,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  validateUsername,
} from "./credentials.js";

/** Matches `sanitise_display_name`'s bounds. The server is still the authority. */
export const DISPLAY_NAME_MAX_LENGTH = 30;

/**
 * Why a rename was refused, in the vocabulary the screen renders.
 *
 * `RATE_LIMITED` is the one that has to be distinguishable: it is the only
 * refusal where the player did nothing wrong and the answer is "later", so
 * collapsing it into a generic failure would tell somebody to fix a name that
 * is perfectly good.
 */
export type RenameFailureReason =
  | "NOT_SIGNED_IN"
  | "NOT_CONFIGURED"
  | "UNREACHABLE"
  | "INVALID"
  | "TAKEN"
  | "RESERVED"
  | "RATE_LIMITED"
  | "REFUSED";

export interface RenameRequest {
  /** Absent means "leave it alone", which is not the same as an empty string. */
  readonly displayName?: string;
  readonly username?: string;
}

export type RenameOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RenameFailureReason; readonly message: string };

/**
 * Client-side checks, mirroring the server's format rules only.
 *
 * Returns the field message, or undefined when there is nothing to say. The
 * reserved-name list is deliberately NOT mirrored: it lives in the database,
 * changes without an app release, and a stale copy here would refuse a handle
 * the server would have allowed.
 */
export function validateDisplayName(displayName: string): string | undefined {
  const trimmed = displayName.trim();
  if (trimmed === "") return "Your display name needs at least one visible character.";
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    return `Keep your display name to ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`;
  }
  return undefined;
}

export { validateUsername };

/**
 * What actually changed, with each field normalised the way the server will
 * normalise it.
 *
 * Returns an empty object when nothing differs, which the caller treats as "do
 * not send a request at all". That matters more here than it usually would: a
 * PATCH that sets `username` to its current value is a no-op to the trigger
 * (`is not distinct from old.username` returns early) but STILL costs a request,
 * and a UI that fires one on every Save teaches the player nothing about why
 * their one rename per thirty days disappeared.
 */
export function changedFields(input: {
  current: { displayName: string; username: string };
  draft: { displayName: string; username: string };
}): RenameRequest {
  const request: { displayName?: string; username?: string } = {};

  const displayName = input.draft.displayName.trim();
  if (displayName !== input.current.displayName.trim()) request.displayName = displayName;

  const username = normaliseUsername(input.draft.username);
  if (username !== normaliseUsername(input.current.username)) request.username = username;

  return request;
}

export function hasChanges(request: RenameRequest): boolean {
  return request.displayName !== undefined || request.username !== undefined;
}

/**
 * Maps a PostgREST error onto a reason and a sentence.
 *
 * The codes are the server's own, and each one is raised by a specific guard:
 *
 *   PT429   `enforce_rate_limit` — PostgREST renders `PTnnn` as HTTP nnn, which
 *           is exactly why the limit was moved off 55000
 *   23505   `profiles_username_key` — somebody else has the handle
 *   23514   `guard_profile_username` (reserved) or
 *           `normalise_profile_display_name` (nothing visible left)
 *
 * Anything else is reported as itself rather than guessed at: a refusal the
 * client does not understand must not be dressed up as one it does.
 */
export function describeRenameError(error: {
  code?: string | null;
  message?: string | null;
}): { reason: RenameFailureReason; message: string } {
  const code = error.code ?? "";
  const raw = error.message ?? "";

  if (code === "PT429" || /rate limit/i.test(raw)) {
    return {
      reason: "RATE_LIMITED",
      message:
        "You have changed that recently. A handle can be changed once every 30 days " +
        "and a display name five times an hour — try again later.",
    };
  }
  if (code === "23505") {
    return { reason: "TAKEN", message: "That handle is already taken. Try another." };
  }
  if (code === "23514") {
    // Both guards raise 23514; the message names which. "reserved" is the
    // handle guard's own word.
    if (/reserved|not permitted/i.test(raw)) {
      return { reason: "RESERVED", message: "That handle is not available. Try another." };
    }
    return {
      reason: "INVALID",
      message: "Your display name needs at least one visible character.",
    };
  }

  return {
    reason: "REFUSED",
    message: raw.trim() === "" ? "That change was refused." : raw,
  };
}

/**
 * The rule the screen states BEFORE the player commits.
 *
 * A limit a player learns about by hitting it is a trap; one they are told
 * about is a rule. This is the same reasoning the tournament screen applies to
 * its entry fee.
 */
export const RENAME_LIMIT_NOTE =
  `Your handle can be changed once every 30 days, is lowercase, and is ` +
  `${USERNAME_MIN_LENGTH}–${USERNAME_MAX_LENGTH} letters, numbers or underscores. ` +
  "Your display name can be changed up to five times an hour.";
