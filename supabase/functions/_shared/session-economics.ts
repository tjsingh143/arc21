import { AI_TABLE_STACK, PRIVATE_TABLE_STACK } from "../../../shared/blackjack/index.js";

/**
 * Which tables owe chips back to a wallet, and which do not.
 *
 * This exists because the answer was previously nowhere, and the cost of that
 * was a live chip mint: a private table seats every player on
 * `PRIVATE_TABLE_STACK` chips that came out of nothing — `buy_in` is 0 and
 * `escrow_chips` is 0, deliberately, because those chips belong to the table —
 * and `settleTableClosure` credited them to the global wallet on the way out.
 * Measured, not theorised: 25,000 became 30,000, repeatable once per table.
 *
 * The distinction is per MODE, not per seat. A winning player at a public table
 * legitimately cashes out far more than their own buy-in, having won the rest
 * from other seats' escrow, so there is no per-seat cap to check. What separates
 * the two cases is where the chips on the felt came from in the first place.
 */

/**
 * Modes whose table stack was debited from a wallet and must be credited back.
 *
 * Everything absent from this list is a closed economy: its chips are created
 * at the table, spent at the table and destroyed with it. Private tables are
 * closed so two accounts cannot transfer a bankroll by agreeing to lose;
 * tournaments, the daily challenge and career nodes are closed because their
 * stacks are a scoring medium and their only wallet exposure is a fee out or a
 * reward in — never the stack itself. A career node starts on 2,000 chips that
 * came from nowhere and vanish with the session; crediting them to a wallet
 * would mint 2,000 chips per attempt, which is the mistake this list exists to
 * make impossible.
 *
 * AN AI TABLE IS NOT HERE, and must never be. Every seat at one — the player's
 * and each computer player's — starts on `AI_TABLE_STACK` chips the server
 * created. A computer player owns no wallet, so a chip the player wins from one
 * was never debited from anybody: crediting an AI table's stack to a wallet
 * would mint exactly the chips the computer players lost, every hand, on
 * demand. No chip enters an AI table and none leaves it.
 */
export const WALLET_BACKED_MODES = ["solo", "public_table"] as const;

/**
 * Every mode the database's `game_mode` enum can hold.
 *
 * Listed exhaustively so a new mode has to be classified here to be playable
 * rather than defaulting into either answer.
 * `supabase/tests/16_sprint_and_daily.test.sql` asserts the enum's labels match
 * this list, so adding a mode fails the suite until someone decides which side
 * of the line it falls on. `career` did, in this phase.
 */
export const ALL_SESSION_MODES = [
  "practice",
  "solo",
  "private_table",
  "public_table",
  "tournament",
  "daily_challenge",
  "career",
  "ai_table",
] as const;

export type SessionMode = (typeof ALL_SESSION_MODES)[number];

/** Whether this table's chips may cross back into the global wallet. */
export function chipsCameFromWallet(mode: string): boolean {
  return (WALLET_BACKED_MODES as readonly string[]).includes(mode);
}

/**
 * Guard for a mode string arriving from the database.
 *
 * An unrecognised mode is treated as a hard error rather than as "not wallet
 * backed", because a silent false here would strand a real player's real chips
 * inside a table they cannot cash out of.
 */
export function isKnownSessionMode(mode: string): mode is SessionMode {
  return (ALL_SESSION_MODES as readonly string[]).includes(mode);
}

/**
 * Closed-economy tables where a seat that cannot cover the minimum may start
 * again from the table's own stack, between hands.
 *
 * A private table has had this from the start — the specification's "permit a
 * free reset to 5,000 between hands; private mode is unranked". An AI table is
 * the same kind of table: its chips are its own, it is unranked, and a player
 * who runs out at one has no other way to keep playing it. Without a reset a
 * broke player would sit at an AI table that can never deal again.
 *
 * NEVER a wallet-backed mode: a free reset there is chips out of nothing.
 * `tests/progression/session-economics.test.ts` asserts the two lists share no
 * member.
 */
export const FREE_STACK_RESET_MODES = ["private_table", "ai_table"] as const;

export function allowsFreeStackReset(mode: string): boolean {
  return (FREE_STACK_RESET_MODES as readonly string[]).includes(mode);
}

/**
 * The stack a free reset restores, for a mode that allows one, or null.
 *
 * Read from the engine's own constants rather than restated, so the figure a
 * reset restores cannot drift from the figure the table opened with.
 */
export function freeResetStackFor(mode: string): number | null {
  switch (mode) {
    case "private_table":
      return PRIVATE_TABLE_STACK;
    case "ai_table":
      return AI_TABLE_STACK;
    default:
      return null;
  }
}

/**
 * Modes whose tables seat computer-controlled players.
 *
 * Exactly one, and the specification is why: "Ranked public multiplayer and
 * ranked tournaments must not silently substitute bots", "No hidden bots
 * presented as humans", "Never silently insert AI into a ranked public game".
 * The server answers for AI seats only at a table of this mode, and the
 * database refuses an AI seat anywhere else (`guard_ai_seat_placement`), so a
 * computer player cannot appear at a public, private, tournament, daily,
 * career or Quick Play table by any route.
 */
export const AI_SEAT_MODES = ["ai_table"] as const;

export function seatsComputerPlayers(mode: string): boolean {
  return (AI_SEAT_MODES as readonly string[]).includes(mode);
}
