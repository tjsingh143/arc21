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
 * therefore lives here and is CALLED — by the root hook, see below — rather
 * than being buried in the store's `update`.
 *
 * It is also best-effort by design. A preference write that blocks on the
 * network is a toggle that feels broken, and a player with no account has
 * nothing to sync — so "not signed in" and "no server configured" are ordinary
 * outcomes, not failures. What must never happen is the reverse: the local
 * value showing `private` while the server still says `public`. `syncOnSignIn`
 * exists for that case, because the preference can be set before an account
 * exists at all.
 *
 * ── Whose row, and in what order ────────────────────────────────────────────
 *
 * A write belongs to the player the app showed when it was asked for, and it
 * is bound to that player before anything is awaited (`player-binding.ts`): the
 * credential is pinned, and the row is that player's own id. The Refresh-B
 * audit (B-R4) held player A's "public" across a sign-in to B, let B's own
 * "private" land, and then released A's — which read the session only after
 * the switch, and so wrote "public" onto B's profile. It is now refused.
 *
 * One player's writes also go out in the order they were asked for, and the
 * queue restarts when the player changes, so a new player's write never waits
 * behind the previous player's refused one.
 *
 * ── Why order on this device is not enough ──────────────────────────────────
 *
 * The queue waits only as long as a caller is willing to: a write that times
 * out releases it. The final Refresh-B audit (B-F1) held player A's "public"
 * PATCH past that timeout, let the next choice, "private", land and be
 * acknowledged, and then released the old request — and the column read
 * "public". A timeout is not a verdict; the request was still able to commit.
 *
 * So the SERVER decides. Every write names the row version it replaces —
 * `profiles.updated_at`, which the `profiles_set_updated_at` trigger moves on
 * every update, including one that sets the same value — and only matches the
 * row while it is still that version. A newer write moves the version, so an
 * older request that arrives late, whenever it arrives, matches nothing. A
 * write that finds the row moved (a later choice, another device, a server
 * update of another column) reads it again and retries, a bounded number of
 * times, while the player it belongs to is still the player shown.
 *
 * Who asks: `use-profile-privacy-sync.ts` at the root is the one caller. The
 * Settings screen used to call too, AFTER awaiting its local save, and so bound
 * the write to whoever was current when the save finished (B-F3).
 */

import { capturePlayerScope } from "../player/player-scope.js";
import { supabaseClientOrNull, type ArcSupabaseClient } from "../../lib/supabase/client.js";
import { bindCurrentPlayer, sentAs } from "../../lib/supabase/player-binding.js";
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
  /**
   * No account, or no server. Neither is an error. `identity-changed`: the app
   * moved to another player before this was sent, so it was sent for nobody.
   */
  | { status: "skipped"; reason: "not-configured" | "signed-out" | "identity-changed" }
  /**
   * `contended`: the row kept moving between reading it and writing it, so the
   * write was never allowed to replace a version it had not seen.
   */
  | { status: "failed"; reason: "unreachable" | "rejected" | "contended"; message: string };

/** Bounded so a slow network cannot leave a preference write hanging. */
const SYNC_TIMEOUT_MS = 8_000;

/** Reads-then-writes before a write that keeps finding the row moved gives up. */
const MAX_ATTEMPTS = 3;

const UNREACHABLE: PrivacySyncOutcome = {
  status: "failed",
  reason: "unreachable",
  message: "The server did not answer.",
};

/** The current player's writes, in the order they were asked for. */
let lane: { readonly isCurrent: () => boolean; tail: Promise<unknown> } | null = null;

/**
 * Writes the caller's visibility choice to their own profile row.
 *
 * RLS restricts the update to the caller's own row and the column grant
 * restricts it to this column, so there is nothing here to trust from the
 * client beyond the value itself — which is one of three.
 */
export function syncProfilePrivacy(
  visibility: StatsVisibility,
): Promise<PrivacySyncOutcome> {
  // BEFORE anything is awaited: the choice belongs to the player shown now.
  const isCurrent = capturePlayerScope();
  const client = supabaseClientOrNull();
  if (client === null) return Promise.resolve({ status: "skipped", reason: "not-configured" });

  if (lane === null || !lane.isCurrent()) lane = { isCurrent, tail: Promise.resolve() };
  const queue = lane;
  const write = queue.tail.then(() => writePrivacy(client, visibility, isCurrent));
  queue.tail = write.catch(() => undefined);
  return write;
}

async function writePrivacy(
  client: ArcSupabaseClient,
  visibility: StatsVisibility,
  isCurrent: () => boolean,
): Promise<PrivacySyncOutcome> {
  // Checked synchronously before binding, so the binding's own scope is the
  // one this write was asked for under — not whoever is current by its turn.
  if (!isCurrent()) return { status: "skipped", reason: "identity-changed" };
  const bound = await bindCurrentPlayer(client, SYNC_TIMEOUT_MS);
  if (!bound.ok) {
    if (bound.reason === "unreachable") return UNREACHABLE;
    return { status: "skipped", reason: bound.reason === "signed-out" ? "signed-out" : "identity-changed" };
  }
  if (!bound.player.isCurrent()) return { status: "skipped", reason: "identity-changed" };

  const privacy = profilePrivacyFor(visibility);
  const own = bound.player.userId;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // The version this write will replace, read with the same pinned credential.
    const read = await withTimeout(
      Promise.resolve(sentAs(client.from("profiles").select("updated_at").eq("id", own), bound.player)),
      SYNC_TIMEOUT_MS,
    );
    if (isTimedOut(read)) return UNREACHABLE;
    if (read.error) return { status: "failed", reason: "rejected", message: read.error.message };
    const version = versionOf(read.data);
    if (version === null) {
      return { status: "failed", reason: "rejected", message: "The profile row could not be read." };
    }
    if (!bound.player.isCurrent()) return { status: "skipped", reason: "identity-changed" };

    // Matches only while the row is still that version. However late this
    // request arrives, a newer write has moved the version and it matches
    // nothing — which is the point, and why a timeout below is safe to report.
    const result = await withTimeout(
      Promise.resolve(
        sentAs(
          client.from("profiles").update({ privacy }).eq("id", own).eq("updated_at", version).select("updated_at"),
          bound.player,
        ),
      ),
      SYNC_TIMEOUT_MS,
    );
    if (isTimedOut(result)) return UNREACHABLE;
    if (result.error) return { status: "failed", reason: "rejected", message: result.error.message };
    if (versionOf(result.data) !== null) return { status: "written", privacy };
    // Someone moved the row after it was read. Read it again — but only for the
    // player this write belongs to.
    if (!bound.player.isCurrent()) return { status: "skipped", reason: "identity-changed" };
  }
  return { status: "failed", reason: "contended", message: "The profile kept changing while this was saved." };
}

/** The one row's `updated_at`, or null when there is not exactly one row. */
function versionOf(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const version = (rows[0] as { updated_at?: unknown } | null)?.updated_at;
  return typeof version === "string" && version.length > 0 ? version : null;
}
