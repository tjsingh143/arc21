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
 * tournaments and the daily challenge are closed because their stacks are a
 * scoring medium and their only wallet exposure is the entry fee going out.
 */
export const WALLET_BACKED_MODES = ["solo", "public_table"] as const;

/**
 * Every mode the database's `game_mode` enum can hold.
 *
 * Listed exhaustively so a new mode has to be classified here to be playable
 * rather than defaulting into either answer.
 * `supabase/tests/16_sprint_and_daily.test.sql` asserts the enum's labels match
 * this list, so adding a seventh mode fails the suite until someone decides which
 * side of the line it falls on.
 */
export const ALL_SESSION_MODES = [
  "practice",
  "solo",
  "private_table",
  "public_table",
  "tournament",
  "daily_challenge",
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
