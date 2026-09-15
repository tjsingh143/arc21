/**
 * The signed-in player's own profile row: display name and handle.
 *
 * The Profile screen rendered `session.account.email` as the display name. Two
 * things wrong with that, and the second is the worse one:
 *
 *   * it is not the display name. `public.profiles` carries `display_name` and
 *     `username`, both server-normalised, both put through the reserved-name
 *     and profanity filter, and the specification's profile hierarchy is
 *     "Avatar / Display name / @username";
 *   * it puts an EMAIL ADDRESS at the top of a screen, in the largest type on
 *     it. A screenshot of your own profile should not disclose your email.
 *
 * Scoped to `id = <you>` deliberately. `public.profiles` is a directory —
 * `profiles_select_visible` shows any authenticated caller a profile that is
 * `public`, not blocked either way — so an unfiltered read returns strangers,
 * and `rows[0]` is one of them. Verified: the policy honours `privacy`, refuses
 * `private`, and requires friendship for `friends`.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import type { ProfileRow } from "../../lib/supabase/database.types.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import {
  describeRenameError,
  hasChanges,
  type RenameOutcome,
  type RenameRequest,
} from "./profile-rename.js";

export interface AccountProfile {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
}

export interface AccountProfileState {
  /** Null for a guest, and null when the row could not be read. */
  readonly profile: AccountProfile | null;
  readonly loaded: boolean;
  load: () => Promise<void>;
  /**
   * Change the display name, the handle, or both.
   *
   * ADDED BECAUSE THE SERVER HALF HAD NO CLIENT HALF. `guard_profile_username`,
   * `normalise_profile_display_name`, `profiles_username_key` and two entries
   * in `rate_limit_policies` have guarded renaming since phase 3, and
   * `docs/AUDIT.md` records the 30-day limit being measured over HTTP — while
   * nothing in this app had ever written either column after signup.
   *
   * The row is re-read from the server on success rather than patched locally:
   * both columns are NORMALISED by triggers (the handle is lowercased, the
   * display name sanitised), so what the player typed is not necessarily what
   * is stored, and showing them their own input back would be showing them a
   * value that does not exist.
   */
  rename: (request: RenameRequest) => Promise<RenameOutcome>;
  clear: () => void;
}

function toProfile(value: unknown): AccountProfile | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (typeof row !== "object" || row === null) return null;
  const candidate = row as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.username !== "string" ||
    typeof candidate.display_name !== "string"
  ) {
    return null;
  }
  return {
    userId: candidate.id,
    username: candidate.username,
    displayName: candidate.display_name,
  };
}

export const useAccountProfileStore = create<AccountProfileState>((set) => ({
  profile: null,
  loaded: false,

  load: async () => {
    const availability = getSupabase();
    if (availability.status !== "ready") {
      set({ profile: null, loaded: true });
      return;
    }

    const session = await withTimeout(
      Promise.resolve(availability.client.auth.getSession()),
      undefined,
    );
    if (isTimedOut(session) || !session.data.session) {
      set({ profile: null, loaded: true });
      return;
    }

    const result = await withTimeout(
      Promise.resolve(
        availability.client
          .from("profiles")
          .select("id, username, display_name")
          .eq("id", session.data.session.user.id)
          .maybeSingle(),
      ),
      undefined,
    );
    if (isTimedOut(result) || result.error) {
      set({ loaded: true });
      return;
    }

    set({ profile: toProfile(result.data), loaded: true });
  },

  rename: async (request) => {
    // Nothing to do, and deliberately not a request: a PATCH that sets a column
    // to its current value costs a round trip and teaches the player nothing.
    if (!hasChanges(request)) return { ok: true };

    const availability = getSupabase();
    if (availability.status !== "ready") {
      return {
        ok: false,
        reason: "NOT_CONFIGURED",
        message: "This build has no server configured, so a profile cannot be changed.",
      };
    }

    const session = await withTimeout(
      Promise.resolve(availability.client.auth.getSession()),
      undefined,
    );
    if (isTimedOut(session)) {
      return { ok: false, reason: "UNREACHABLE", message: "The server did not answer." };
    }
    if (!session.data.session) {
      return {
        ok: false,
        reason: "NOT_SIGNED_IN",
        message: "Sign in to change your profile.",
      };
    }

    /*
     * Built as a typed partial rather than a `Record<string, string>`: the
     * client is generically typed against `database.types.ts`, which rejects a
     * column it does not know about at compile time. That is worth keeping —
     * a typo'd column name in an UPDATE is silently accepted by PostgREST as a
     * filter-only request that changes nothing.
     */
    const patch: Partial<Pick<ProfileRow, "display_name" | "username">> = {};
    if (request.displayName !== undefined) patch.display_name = request.displayName;
    if (request.username !== undefined) patch.username = request.username;

    const result = await withTimeout(
      Promise.resolve(
        availability.client
          .from("profiles")
          .update(patch)
          .eq("id", session.data.session.user.id),
      ),
      undefined,
    );
    if (isTimedOut(result)) {
      /*
       * Silence, not a refusal — and the two must not be confused here of all
       * places. A rename that timed out MAY have applied, and telling the
       * player it failed would invite a second attempt that spends the one
       * change they get every thirty days. The reload below settles it.
       */
      await useAccountProfileStore.getState().load();
      return {
        ok: false,
        reason: "UNREACHABLE",
        message:
          "The server did not answer, so your profile may or may not have changed. " +
          "Check the name shown above before trying again.",
      };
    }
    if (result.error) {
      const described = describeRenameError(result.error);
      return { ok: false, ...described };
    }

    // Re-read rather than patch: both columns are normalised by triggers, so
    // the stored value is not necessarily the typed one.
    await useAccountProfileStore.getState().load();
    return { ok: true };
  },

  clear: () => set({ profile: null, loaded: false }),
}));
