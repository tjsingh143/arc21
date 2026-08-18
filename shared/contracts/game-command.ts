/**
 * Arc 21 — the game command request contract.
 *
 * One shape crosses the wire for every authoritative action. Three fields carry
 * the whole safety story:
 *
 *   `clientActionId`   makes retries free. The first accepted result for a given
 *                      id is returned verbatim forever after, so a dropped
 *                      response can never settle a hand twice.
 *   `expectedVersion`  makes staleness explicit. A client that acted on an old
 *                      snapshot gets the authoritative snapshot back and nothing
 *                      is applied.
 *   `type` + `payload` are the only things the client gets to choose. There is
 *                      deliberately no seatId, no userId, no amount of anyone
 *                      else's chips: identity comes from the verified JWT and
 *                      the seat is looked up server-side.
 */

import { z } from "zod";
import {
  chipAmountSchema,
  isoTimestampSchema,
  stateVersionSchema,
  uuidSchema,
} from "./contract-primitives.js";

/**
 * Every command type the server accepts from a client.
 *
 * `ADVANCE` from the engine's own `EngineCommandType` is deliberately absent:
 * it drives dealer and settlement steps, is issued only by the server's own
 * cascade, and a client that could send it would be able to skip a decision
 * point. Making it unrepresentable in the request union is stronger than
 * checking for it in a handler.
 */
export const GAME_COMMAND_TYPES = [
  "PLACE_BET",
  "LOCK_BET",
  "INSURANCE",
  "DECLINE_INSURANCE",
  "HIT",
  "STAND",
  "DOUBLE",
  "SPLIT",
  "SURRENDER",
  "RESOLVE_TIMEOUT",
  "LEAVE",
  /**
   * Starts the next round from HAND_COMPLETE.
   *
   * Unlike `ADVANCE` this skips no decision point: HAND_COMPLETE has none
   * pending. It exists because the engine deliberately parks there so a
   * settlement is never animated over, which left every server-authoritative
   * table unable to reach hand two.
   */
  "NEXT_HAND",
] as const;

export type GameCommandType = (typeof GAME_COMMAND_TYPES)[number];

/** Command types that never carry a payload. */
const PAYLOAD_FREE_COMMAND_TYPES = GAME_COMMAND_TYPES.filter(
  (type): type is Exclude<GameCommandType, "PLACE_BET"> => type !== "PLACE_BET",
);

const commandEnvelope = {
  gameId: uuidSchema,
  clientActionId: uuidSchema,
  expectedVersion: stateVersionSchema,
  clientSentAt: isoTimestampSchema,
};

/**
 * `PLACE_BET` carries an absolute amount, not a delta — chip taps accumulate in
 * the UI and the engine receives the final intended wager. That is what makes
 * the command naturally idempotent under retry, before the idempotency ledger
 * is even consulted.
 *
 * Zero is legal: it clears a staged bet, which is an ordinary action rather than
 * a rule violation. Table minimums are enforced by the engine against
 * authoritative state, never here — a bound in a client-side schema is a
 * convenience, not a control.
 */
export const placeBetPayloadSchema = z.strictObject({
  amount: chipAmountSchema,
});

/** Strict and empty: an unexpected key on a payload-free command is rejected. */
export const emptyPayloadSchema = z.strictObject({});

export const placeBetCommandSchema = z.strictObject({
  ...commandEnvelope,
  type: z.literal("PLACE_BET"),
  payload: placeBetPayloadSchema,
});

const payloadFreeCommandSchemas = PAYLOAD_FREE_COMMAND_TYPES.map((type) =>
  z.strictObject({
    ...commandEnvelope,
    type: z.literal(type),
    // Optional on the wire so a client need not send `payload: {}`, but still
    // strict: `{ payload: { amount: 1 } }` on a HIT is a rejection.
    payload: emptyPayloadSchema.optional().default({}),
  }),
);

export const gameCommandRequestSchema = z.discriminatedUnion("type", [
  placeBetCommandSchema,
  ...payloadFreeCommandSchemas,
]);

/** The parsed, trusted shape. `payload` is always present after parsing. */
export type GameCommandRequest = z.infer<typeof gameCommandRequestSchema>;

/** The shape a client may send, where a payload-free `payload` is optional. */
export type GameCommandRequestInput = z.input<typeof gameCommandRequestSchema>;

export type PlaceBetCommand = z.infer<typeof placeBetCommandSchema>;

export function isPlaceBetCommand(
  command: GameCommandRequest,
): command is PlaceBetCommand {
  return command.type === "PLACE_BET";
}
