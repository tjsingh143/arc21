/**
 * Arc 21 — the client's view of the friend graph.
 *
 * Every relationship in this file is decided by the server. There is no local
 * friend list, no cached "pending" flag that survives a failed request, and no
 * function here that can make two people friends: the client asks, reads the
 * answer back, and renders it.
 *
 * The validation is not ceremony. A friend row carries a *person's name* to the
 * screen, and a malformed one must never be rendered as a blank card or a
 * player called "undefined" — a friend list is exactly the surface where an
 * invented row reads as real. Anything that fails to parse is dropped and
 * counted, so the screen can say the list is incomplete instead of quietly
 * showing a shorter one.
 *
 * Runtime-neutral: no React, no React Native, no Expo, no Supabase.
 */

import { z } from "zod";

/**
 * The server returns nothing below this, because a one-character query matches
 * most of the table. It is mirrored here so the client can say *why* it is not
 * searching rather than sending a request it knows will come back empty.
 */
export const MIN_SEARCH_LENGTH = 2;

export const SEARCH_TOO_SHORT = `Type at least ${MIN_SEARCH_LENGTH} characters to search for someone.`;

/** How `search_players` describes the caller's standing with a player. */
export type Relationship = "friends" | "outgoing_pending" | "incoming_pending" | "none";

/**
 * Every state a relationship can land in after an action, including `blocked`.
 *
 * `blocked` is a result the caller can cause but never a state the caller is
 * *told* about: `search_players` omits blocked people entirely, and the server
 * reports acting on one as "no such player". Nothing in this file may turn that
 * silence back into a disclosure.
 */
export type RelationshipState = Relationship | "blocked";

export interface PlayerSummary {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly level: number;
}

export interface SearchResult extends PlayerSummary {
  readonly relationship: Relationship;
}

export interface Friend extends PlayerSummary {
  /** ISO 8601, straight from `profiles.last_seen_at`. */
  readonly lastSeenAt: string;
}

export interface FriendRequest {
  readonly direction: "incoming" | "outgoing";
  /** The *other* person. The caller is always the second party. */
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly createdAt: string;
}

/**
 * Somebody the player has blocked.
 *
 * Only ever that direction. `list_blocked` returns the caller's own blocks and
 * nothing else, so there is no shape here that could carry "people who blocked
 * you" — the type is part of keeping a block undisclosed to the person blocked.
 *
 * No level and no last-seen, unlike a friend. A block is not a profile card,
 * and the row exists to be undone rather than read.
 */
export interface BlockedPlayer {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  /** ISO 8601, straight from `blocks.created_at`. The server orders on it. */
  readonly blockedAt: string;
}

// ---------------------------------------------------------------------------
// Row validation
// ---------------------------------------------------------------------------

const playerId = z.uuid();
const handle = z.string().min(1);
const displayName = z.string().min(1);
/** `profiles.level` is a positive integer; a level is never fractional. */
const level = z.number().int().min(0);
/**
 * Timestamps are kept as opaque strings, exactly as the wallet keeps
 * `updated_at`. Asserting a particular ISO shape here would drop a real friend
 * over a microsecond field or an offset spelling, and the only thing the screen
 * does with the value is describe it.
 */
const timestamp = z.string().min(1);

const relationshipSchema = z.enum([
  "friends",
  "outgoing_pending",
  "incoming_pending",
  "none",
]);

const relationshipStateSchema = z.enum([
  "friends",
  "outgoing_pending",
  "incoming_pending",
  "none",
  "blocked",
]);

export const searchResultRowSchema = z.object({
  id: playerId,
  username: handle,
  display_name: displayName,
  level,
  relationship: relationshipSchema,
});

export const friendRowSchema = z.object({
  id: playerId,
  username: handle,
  display_name: displayName,
  level,
  last_seen_at: timestamp,
});

export const friendRequestRowSchema = z.object({
  direction: z.enum(["incoming", "outgoing"]),
  other_id: playerId,
  username: handle,
  display_name: displayName,
  created_at: timestamp,
});

export const blockedPlayerRowSchema = z.object({
  id: playerId,
  username: handle,
  display_name: displayName,
  blocked_at: timestamp,
});

/**
 * Parses a page of rows, dropping any that do not validate.
 *
 * Dropping rather than failing the whole read is the right trade for a list:
 * one unreadable row should not hide the nine legible ones around it. The count
 * comes back so the screen can say the list is partial.
 */
function parseRows<TSchema extends z.ZodType, TOut>(
  rows: readonly unknown[],
  schema: TSchema,
  toItem: (row: z.infer<TSchema>) => TOut,
): { readonly items: readonly TOut[]; readonly dropped: number } {
  const items: TOut[] = [];
  let dropped = 0;

  for (const row of rows) {
    const parsed = schema.safeParse(row);
    if (!parsed.success) {
      dropped += 1;
      continue;
    }
    items.push(toItem(parsed.data));
  }

  return { items, dropped };
}

export function toSearchResults(rows: readonly unknown[]): {
  readonly results: readonly SearchResult[];
  readonly dropped: number;
} {
  const { items, dropped } = parseRows(rows, searchResultRowSchema, (row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    level: row.level,
    relationship: row.relationship,
  }));
  return { results: items, dropped };
}

export function toFriends(rows: readonly unknown[]): {
  readonly friends: readonly Friend[];
  readonly dropped: number;
} {
  const { items, dropped } = parseRows(rows, friendRowSchema, (row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    level: row.level,
    lastSeenAt: row.last_seen_at,
  }));
  return { friends: items, dropped };
}

/**
 * Parses pending requests, incoming first.
 *
 * Incoming requests are the only rows on this screen that are waiting on the
 * player. An outgoing request is waiting on somebody else, so it never sits
 * above one that needs an answer. `sort` is stable, so the server's
 * newest-first ordering survives within each group.
 */
export function toFriendRequests(rows: readonly unknown[]): {
  readonly requests: readonly FriendRequest[];
  readonly dropped: number;
} {
  const { items, dropped } = parseRows(rows, friendRequestRowSchema, (row) => ({
    direction: row.direction,
    id: row.other_id,
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at,
  }));

  const requests = [...items].sort(
    (a, b) => (a.direction === "incoming" ? 0 : 1) - (b.direction === "incoming" ? 0 : 1),
  );

  return { requests, dropped };
}

/**
 * Parses the blocked list, keeping the server's newest-first order.
 *
 * A malformed row matters more here than anywhere else on the screen: this is
 * the only list whose rows exist to be *undone*, and a dropped row is somebody
 * the player cannot unblock. It is counted for that reason, so the section can
 * say the list is short rather than imply the block is already gone.
 */
export function toBlockedPlayers(rows: readonly unknown[]): {
  readonly blocked: readonly BlockedPlayer[];
  readonly dropped: number;
} {
  const { items, dropped } = parseRows(rows, blockedPlayerRowSchema, (row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    blockedAt: row.blocked_at,
  }));
  return { blocked: items, dropped };
}

/** Reads the single text value the mutating RPCs return. */
export function toRelationshipState(value: unknown): RelationshipState | null {
  const parsed = relationshipStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// What a row offers, and what it says
// ---------------------------------------------------------------------------

export interface RequestPresentation {
  readonly title: string;
  readonly handle: string;
  readonly detail: string;
  readonly canAccept: boolean;
  readonly canDecline: boolean;
}

/**
 * What a pending request row shows and offers.
 *
 * Outgoing requests carry no action because the server has no operation for
 * withdrawing one — and a "Cancel" button that quietly did something else, or
 * nothing, would be worse than its absence. The row says who is being waited on
 * instead.
 */
export function presentRequest(request: FriendRequest): RequestPresentation {
  const incoming = request.direction === "incoming";
  return {
    title: request.displayName,
    handle: `@${request.username}`,
    detail: incoming ? "Wants to be your friend" : "Sent — waiting for them to accept",
    canAccept: incoming,
    canDecline: incoming,
  };
}

export interface SearchPresentation {
  readonly title: string;
  readonly handle: string;
  readonly detail: string;
  /** `null` when the row is already in a state the player cannot move it out of here. */
  readonly action: "add" | "accept" | null;
  readonly actionLabel: string | null;
}

export function presentSearchResult(result: SearchResult): SearchPresentation {
  const common = {
    title: result.displayName,
    handle: `@${result.username}`,
  };

  switch (result.relationship) {
    case "friends":
      return { ...common, detail: "Already your friend", action: null, actionLabel: null };
    case "outgoing_pending":
      return {
        ...common,
        detail: "Request sent — waiting for them",
        action: null,
        actionLabel: null,
      };
    case "incoming_pending":
      return {
        ...common,
        detail: "Asked to be your friend",
        action: "accept",
        actionLabel: "Accept",
      };
    case "none":
      return { ...common, detail: `Level ${result.level}`, action: "add", actionLabel: "Add" };
  }
}

export interface UnblockConfirmation {
  readonly title: string;
  readonly body: string;
}

/**
 * What the player is agreeing to when they unblock somebody.
 *
 * The body exists to correct one specific wrong expectation: that undoing a
 * block puts things back. It does not. `unblock_player` deletes a row in
 * `blocks` and nothing else — no friendship is restored, no request is
 * resurrected — so the two are strangers who can find each other again, which
 * is a different thing from being friends again and has to be said before the
 * tap rather than discovered after it.
 */
export function presentUnblockConfirmation(player: BlockedPlayer): UnblockConfirmation {
  return {
    title: `Unblock ${player.displayName}?`,
    body:
      "You will be able to find each other in search again, and either of you can send a friend request. " +
      "It does not make you friends and does not bring back a friendship you had before — you are strangers again. " +
      "They are not told, just as they were not told about the block.",
  };
}

/**
 * Re-states one search row from what the server just said about it.
 *
 * The RPCs return the resulting relationship, so the row can be corrected from
 * the server's own answer rather than from a guess about what the tap probably
 * did. A blocked player disappears from the results because a repeat of the
 * same search would no longer return them.
 */
export function applySearchRelationship(
  results: readonly SearchResult[],
  playerId: string,
  next: RelationshipState,
): readonly SearchResult[] {
  if (next === "blocked") {
    return results.filter((result) => result.id !== playerId);
  }
  return results.map((result) =>
    result.id === playerId ? { ...result, relationship: next } : result,
  );
}

/**
 * How long ago a friend was last seen.
 *
 * Deliberately "last seen" and never "online". Presence needs a live channel
 * this build does not have, and a green dot derived from a timestamp is a claim
 * that somebody is there right now — which is exactly the claim that cannot be
 * supported by a column written at some unstated moment in the past.
 */
export function describeLastSeen(lastSeenAt: string, now: Date): string {
  const seen = Date.parse(lastSeenAt);
  if (!Number.isFinite(seen)) return "Last seen unknown";

  const elapsed = now.getTime() - seen;
  if (elapsed < 0) return "Last seen just now";

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Last seen just now";
  if (minutes < 60) return `Last seen ${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last seen ${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `Last seen ${days} day${days === 1 ? "" : "s"} ago`;
  return "Last seen over a week ago";
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export const FRIENDS_ACTION_FAILED = "That did not go through, and nothing has changed.";

/**
 * Player-facing wording for a refusal from one of the friend RPCs.
 *
 * The wallet shows the server's own message, because `claim_recovery_grant`
 * writes its refusals for a player to read. These functions do not: they raise
 * terse fragments meant for a log. More importantly, `'no such player'` is
 * *deliberately* the same message for a missing account and a block, and
 * translating it into anything more specific here would undo that — telling
 * somebody they were blocked confirms both that the account exists and who
 * blocked them.
 */
export function describeRpcFailure(
  error: { readonly message?: string | null; readonly code?: string | null } | null | undefined,
): string {
  const message = (error?.message ?? "").toLowerCase();

  if (message.includes("cannot add yourself")) return "You cannot add yourself.";
  if (message.includes("cannot block yourself")) return "You cannot block yourself.";
  if (message.includes("no such player")) return "That player could not be found.";
  if (message.includes("no pending request")) return "That request is no longer there.";

  return FRIENDS_ACTION_FAILED;
}
