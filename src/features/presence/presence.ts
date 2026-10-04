/**
 * Who is online.
 *
 * Presence is **ephemeral** and deliberately so. It lives in a Realtime channel
 * and nowhere else: nothing is written to the database, so a crashed client or
 * a killed app leaves no stale "online" row behind to be believed later. The
 * only durable trace is `profiles.last_seen_at`, which is a timestamp and reads
 * as one.
 *
 * That distinction is the whole design. A green dot derived from a timestamp is
 * a guess dressed as a fact — the player may have closed the app the instant
 * after it was written. A dot derived from a live channel is a claim the
 * connection itself is making, and it disappears when the connection does.
 */

import { z } from "zod";

/** The states the specification names. `available` is the default when idle. */
export type PresenceState = "available" | "in_game" | "offline";

export const PRESENCE_TOPIC = "presence:players";

/**
 * What each client publishes about itself.
 *
 * Only a user id and a state — no display name, no table id, no chips. A
 * presence payload is broadcast to everyone tracking the channel, so it carries
 * the minimum that answers "can I invite them right now?" and nothing that
 * would leak where someone is sitting or what they hold.
 */
export const presenceEntrySchema = z.object({
  userId: z.string().uuid(),
  state: z.enum(["available", "in_game"]),
});

export type PresenceEntry = z.infer<typeof presenceEntrySchema>;

/**
 * Collapse a Realtime presence map into "who is online, and doing what".
 *
 * One person can hold several entries at once — the specification permits being
 * signed in on more than one device. `in_game` wins over `available`, because a
 * player at a table on their phone is at a table regardless of the tablet idling
 * on Home.
 */
export function summarisePresence(raw: unknown): Map<string, PresenceState> {
  const online = new Map<string, PresenceState>();
  if (raw === null || typeof raw !== "object") return online;

  for (const entries of Object.values(raw as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      const parsed = presenceEntrySchema.safeParse(entry);
      // A malformed entry is dropped, never rendered as an unknown person
      // online. Presence is decoration; a bad row must not invent a friend.
      if (!parsed.success) continue;

      const existing = online.get(parsed.data.userId);
      if (existing === "in_game") continue;
      online.set(parsed.data.userId, parsed.data.state);
    }
  }

  return online;
}

/** Parse only the server's friend-scoped, verified identity projection. */
export function presenceFromRows(raw: unknown): Map<string, PresenceState> {
  const result = new Map<string, PresenceState>();
  if (!Array.isArray(raw)) return result;
  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;
    const parsed = presenceEntrySchema.safeParse({ userId: row.user_id, state: row.state });
    if (parsed.success) result.set(parsed.data.userId, parsed.data.state);
  }
  return result;
}

/**
 * The word shown beside a friend.
 *
 * Returns `null` when the player is not on the channel, so the caller falls
 * back to "Last seen …" rather than asserting they are offline — absence from a
 * channel and a known-offline state are different claims, and only one of them
 * is supported by evidence.
 */
export function describePresence(state: PresenceState | undefined): string | null {
  switch (state) {
    case "in_game":
      return "In a game";
    case "available":
      return "Recently active";
    default:
      return null;
  }
}
