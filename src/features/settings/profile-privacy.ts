/**
 * Arc 21 — carrying "Statistics visibility" to the column that enforces it.
 *
 * ── The defect this exists to fix ───────────────────────────────────────────
 *
 * `public.profiles.privacy` is real and it works. `profiles_select_visible`
 * refuses the row outright when it is `private`, and narrows it to friends when
 * it is `friends`; the client even holds a column-level UPDATE grant on it,
 * granted for exactly this purpose.
 *
 * Nothing ever wrote it. The Settings screen's three-way control wrote
 * `statsVisibility` into LOCAL preferences and stopped there, so every account
 * sat at the column default — `'public'` — no matter what the player chose. The
 * control persisted, survived a restart and displayed the player's answer back
 * to them, and changed nothing about who could see them. The enforcement was
 * never the missing part; being told the answer was.
 *
 * The defaults disagreed in the worse direction, too: local defaults to
 * `private`, the column defaults to `public`. So the player most likely to care
 * — the one who never opened Settings because the default already said private
 * — was the one most exposed.
 *
 * ── Why it is shaped like this ──────────────────────────────────────────────
 *
 * `use-settings.ts` deliberately imports no Supabase and no auth, so that the
 * preference record stays loadable in a plain Node test process. The sync
 * therefore lives here and is CALLED by the screen, rather than being buried in
 * the store's `update`.
 *
 * It is also best-effort by design. A preference write that blocks on the
 * network is a toggle that feels broken, and a player with no account has
 * nothing to sync — so "not signed in" and "no server configured" are ordinary
 * outcomes, not failures. What must never happen is the reverse: the local
 * value showing `private` while the server still says `public`. `syncOnSignIn`
 * exists for that case, because the preference can be set before an account
 * exists at all.
 */

import { supabaseClientOrNull } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import type { StatsVisibility } from "./settings.js";

/**
 * The mapping is the identity, and that is worth stating rather than assuming.
 *
 * `StatsVisibility` and `public.profile_privacy` have the same three members
 * because they describe the same thing. If either ever gains a member, this
 * function stops compiling — which is the point of writing it out instead of
 * casting.
 */
export function profilePrivacyFor(visibility: StatsVisibility): "public" | "friends" | "private" {
  switch (visibility) {
    case "public":
      return "public";
    case "friends":
      return "friends";
    case "private":
      return "private";
  }
}

export type PrivacySyncOutcome =
  | { status: "written"; privacy: "public" | "friends" | "private" }
  /** No account, or no server. Neither is an error. */
  | { status: "skipped"; reason: "not-configured" | "signed-out" }
  | { status: "failed"; reason: "unreachable" | "rejected"; message: string };

/** Bounded so a slow network cannot leave a preference write hanging. */
const SYNC_TIMEOUT_MS = 8_000;

/**
 * Writes the caller's visibility choice to their own profile row.
 *
 * RLS restricts the update to the caller's own row and the column grant
 * restricts it to this column, so there is nothing here to trust from the
 * client beyond the value itself — which is one of three.
 */
export async function syncProfilePrivacy(
  visibility: StatsVisibility,
): Promise<PrivacySyncOutcome> {
  const client = supabaseClientOrNull();
  if (client === null) return { status: "skipped", reason: "not-configured" };

  const session = await withTimeout(client.auth.getSession(), SYNC_TIMEOUT_MS);
  if (isTimedOut(session)) {
    return { status: "failed", reason: "unreachable", message: "The server did not answer." };
  }

  const userId = session.data.session?.user.id;
  if (!userId) return { status: "skipped", reason: "signed-out" };

  const privacy = profilePrivacyFor(visibility);
  const result = await withTimeout(
    Promise.resolve(client.from("profiles").update({ privacy }).eq("id", userId)),
    SYNC_TIMEOUT_MS,
  );
  if (isTimedOut(result)) {
    return { status: "failed", reason: "unreachable", message: "The server did not answer." };
  }
  if (result.error) {
    return { status: "failed", reason: "rejected", message: result.error.message };
  }

  return { status: "written", privacy };
}
