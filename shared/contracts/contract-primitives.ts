/**
 * Arc 21 — shared contract primitives.
 *
 * This package is runtime-neutral: no React, React Native, Expo, Supabase or
 * Deno imports anywhere in `shared/contracts`. The mobile client, the Edge
 * Functions and the test suite parse the same schemas, so there is exactly one
 * definition of what a command looks like on the wire.
 *
 * Every object schema in this package is STRICT. A client that can smuggle an
 * extra field past validation is a client that can probe for one that is read,
 * so an unexpected key is a hard rejection rather than a silently stripped one.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

export const uuidSchema = z.uuid();

/**
 * ISO-8601 with an explicit offset. `clientSentAt` is telemetry only — the
 * server never derives a deadline, a settlement or an ordering decision from a
 * client clock — but it is still validated so a malformed field cannot ride
 * along into a log or an event payload.
 */
export const isoTimestampSchema = z.iso.datetime({ offset: true });

/**
 * Chips are integers. `z.int()` rejects NaN, Infinity and fractions, and the
 * ceiling keeps a value comfortably inside both `Number.MAX_SAFE_INTEGER` and
 * the `bigint` columns it will eventually be compared against.
 */
export const MAX_CHIP_AMOUNT = 1_000_000_000_000;

export const chipAmountSchema = z.int().min(0).max(MAX_CHIP_AMOUNT);

/** Monotonic engine state version. A fresh, unstarted game is version 0. */
export const stateVersionSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Event sequence numbers start at 1 and never repeat within a session. */
export const eventSeqSchema = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

// ---------------------------------------------------------------------------
// Cards
//
// Mirrors `Card` / `HiddenCard` in shared/blackjack/types.ts. The hidden form is
// a placeholder rather than an omission, so a client can render a face-down
// card without ever receiving its identity.
// ---------------------------------------------------------------------------

export const suitSchema = z.enum(["S", "H", "D", "C"]);

export const rankSchema = z.enum([
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
]);

export const cardSchema = z.strictObject({
  id: z.string().min(1).max(64),
  suit: suitSchema,
  rank: rankSchema,
  deckIndex: z.int().min(0).max(16),
});

export const hiddenCardSchema = z.strictObject({
  hidden: z.literal(true),
});

export const maybeHiddenCardSchema = z.union([cardSchema, hiddenCardSchema]);

// ---------------------------------------------------------------------------
// Engine-shaped enums
//
// These repeat the engine's exact spelling on purpose. `tests/contracts` asserts
// that the two stay identical, so a divergence fails the suite instead of
// producing a payload the client cannot narrow.
// ---------------------------------------------------------------------------

export const gamePhaseSchema = z.enum([
  "SESSION_READY",
  "BETTING_OPEN",
  "BETTING_LOCKED",
  "INITIAL_DEAL",
  "INSURANCE_OFFER",
  "DEALER_PEEK",
  "PLAYER_TURNS",
  "DEALER_REVEAL",
  "DEALER_TURN",
  "SETTLEMENT",
  "HAND_COMPLETE",
  "BETWEEN_HANDS",
  "SESSION_COMPLETE",
]);

export const playerHandStatusSchema = z.enum([
  "ACTIVE",
  "STOOD",
  "BUSTED",
  "SURRENDERED",
  "DOUBLED_COMPLETE",
  "BLACKJACK",
  "TWENTY_ONE",
  "RESOLVED",
]);

export const playerActionTypeSchema = z.enum([
  "HIT",
  "STAND",
  "DOUBLE",
  "SPLIT",
  "SURRENDER",
]);

export const handOutcomeKindSchema = z.enum([
  "WIN",
  "LOSS",
  "PUSH",
  "BLACKJACK",
  "BUST",
  "SURRENDER",
]);

export const handOutcomeSchema = z.strictObject({
  kind: handOutcomeKindSchema,
  credit: chipAmountSchema,
  /** `credit - wager`. Negative on a loss, so it is not a chip amount. */
  net: z.int().min(-MAX_CHIP_AMOUNT).max(MAX_CHIP_AMOUNT),
});

export const tableTierSchema = z.enum(["casual", "standard", "high"]);

export type Suit = z.infer<typeof suitSchema>;
export type Rank = z.infer<typeof rankSchema>;
export type ContractCard = z.infer<typeof cardSchema>;
export type ContractHiddenCard = z.infer<typeof hiddenCardSchema>;
export type ContractMaybeHiddenCard = z.infer<typeof maybeHiddenCardSchema>;
export type ContractGamePhase = z.infer<typeof gamePhaseSchema>;
export type ContractPlayerHandStatus = z.infer<typeof playerHandStatusSchema>;
export type ContractPlayerActionType = z.infer<typeof playerActionTypeSchema>;
export type ContractHandOutcome = z.infer<typeof handOutcomeSchema>;
export type ContractTableTier = z.infer<typeof tableTierSchema>;
