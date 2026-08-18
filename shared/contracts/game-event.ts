/**
 * Arc 21 — the public event contract.
 *
 * Mirrors `EngineEvent` from shared/blackjack/types.ts. The engine's event
 * stream is already sanitised by construction — the hole card is dealt as a
 * bodiless `HOLE_CARD_DEALT` and only named later by `HOLE_CARD_REVEALED`, and
 * no event ever carries an undealt card. Restating the shape here lets the
 * client validate the stream and lets the contract tests prove the two
 * definitions have not drifted.
 *
 * Each event is wrapped with the ordering metadata ARCHITECTURE.md requires:
 * a monotonic `seq` per session, so a client can detect a gap and refetch an
 * authoritative snapshot rather than rendering a hand that never happened.
 */

import { z } from "zod";
import {
  cardSchema,
  chipAmountSchema,
  eventSeqSchema,
  handOutcomeSchema,
  playerActionTypeSchema,
  playerHandStatusSchema,
  stateVersionSchema,
} from "./contract-primitives.js";

const seatId = z.string().min(1).max(128);
const handId = z.string().min(1).max(128);
const handTotal = z.int().min(0).max(64);
const handNumber = z.int().min(0);

export const engineEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("BETTING_OPENED"), handNumber }),
  z.strictObject({ type: z.literal("BET_PLACED"), seatId, amount: chipAmountSchema }),
  z.strictObject({ type: z.literal("BET_LOCKED"), seatId, amount: chipAmountSchema }),
  z.strictObject({
    type: z.literal("SHOE_SHUFFLED"),
    shuffleNumber: z.int().min(0),
    deckCount: z.int().min(1).max(16),
  }),
  z.strictObject({
    type: z.literal("CARD_DEALT"),
    to: z.enum(["DEALER", "SEAT"]),
    seatId: seatId.optional(),
    handId: handId.optional(),
    card: cardSchema.nullable(),
  }),
  // Deliberately bodiless. The hole card's identity must never appear in a
  // public event stream before the reveal.
  z.strictObject({ type: z.literal("HOLE_CARD_DEALT") }),
  z.strictObject({ type: z.literal("INSURANCE_OFFERED") }),
  z.strictObject({ type: z.literal("INSURANCE_TAKEN"), seatId, amount: chipAmountSchema }),
  z.strictObject({ type: z.literal("INSURANCE_DECLINED"), seatId }),
  z.strictObject({ type: z.literal("DEALER_PEEKED"), hasBlackjack: z.boolean() }),
  z.strictObject({ type: z.literal("TURN_STARTED"), seatId, handId }),
  z.strictObject({
    type: z.literal("PLAYER_ACTION"),
    seatId,
    handId,
    action: playerActionTypeSchema,
  }),
  z.strictObject({
    type: z.literal("HAND_SPLIT"),
    seatId,
    fromHandId: handId,
    newHandIds: z.tuple([handId, handId]),
  }),
  z.strictObject({
    type: z.literal("HAND_STATUS_CHANGED"),
    seatId,
    handId,
    status: playerHandStatusSchema,
  }),
  // Emitted only in DEALER_REVEAL, at which point the card is public.
  z.strictObject({ type: z.literal("HOLE_CARD_REVEALED"), card: cardSchema }),
  z.strictObject({ type: z.literal("DEALER_STOOD"), total: handTotal }),
  z.strictObject({ type: z.literal("DEALER_BUSTED"), total: handTotal }),
  z.strictObject({
    type: z.literal("HAND_SETTLED"),
    seatId,
    handId,
    outcome: handOutcomeSchema,
  }),
  z.strictObject({ type: z.literal("INSURANCE_SETTLED"), seatId, credit: chipAmountSchema }),
  z.strictObject({ type: z.literal("SEAT_LEFT"), seatId }),
  z.strictObject({
    type: z.literal("TIMEOUT_RESOLVED"),
    seatId,
    appliedAction: z.string().min(1).max(64),
  }),
  z.strictObject({ type: z.literal("HAND_COMPLETED"), handNumber }),
  z.strictObject({ type: z.literal("SHOE_EXHAUSTED_INVARIANT"), handNumber }),
]);

export const publicGameEventSchema = z.strictObject({
  /** Monotonic per session. Clients track lastAppliedSeq and refetch on a gap. */
  seq: eventSeqSchema,
  /** The engine state version this event was emitted at. */
  stateVersion: stateVersionSchema,
  handNumber,
  event: engineEventSchema,
});

export type ContractEngineEvent = z.infer<typeof engineEventSchema>;
export type PublicGameEvent = z.infer<typeof publicGameEventSchema>;
export type ContractEngineEventType = ContractEngineEvent["type"];
