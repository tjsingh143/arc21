/**
 * The Sprint Tournament format.
 *
 * Everything here is pure arithmetic over the structure: bet ceilings by hand,
 * where the button sits, who is eliminated at a boundary, what each placement
 * pays. No database, no engine, no clock — which is what makes it testable
 * against the exact boundary cases that decide someone's placement.
 *
 * It lives under `supabase/functions/_shared` rather than `shared/` for the
 * tooling reason recorded in CLAUDE.md: the Supabase CLI bind-mounts files
 * outside `supabase/functions` one at a time from a module graph that does not
 * pick up anything new, so a fresh file under `shared/` typechecks, passes
 * tests, and then fails at runtime with "no such file or directory". Verified
 * again while building this phase, against `shared/strategy`:
 *
 *   failed to read file: open shared/strategy/index.js: no such file or directory
 *
 * Nothing is duplicated from `shared/` here, so there is no mirror to guard.
 */

/**
 * The format, verbatim from the specification.
 *
 * Chips are integers everywhere and every derived figure below stays integral:
 * a prize split floors, and a bet ceiling is a constant rather than a fraction
 * of a stack.
 */
export const SPRINT = {
  code: "sprint",
  seats: 4,
  startingStack: 10_000,
  scheduledHands: 12,
  minBet: 100,
  /** Hands 1–8. */
  earlyMaxBet: 2_000,
  /** Hands 9–12, when position play matters and the ceiling opens up. */
  lateMaxBet: 5_000,
  lateBetsFromHand: 9,
  /** After this hand settles, the lowest remaining stack goes out. */
  eliminationHand: 6,
  /** The only global-wallet exposure in the whole format. */
  entryFee: 500,
  /** Index 0 is first place. Fourth place pays nothing, which is not a bug. */
  prizeChips: [2_000, 1_000, 500, 0],
  /** XP by placement, paid alongside the prize. */
  prizeXp: [200, 120, 80, 40],
  maxTieBreakHands: 5,
  /**
   * How long a tournament may sit `registering` before the server cancels it and
   * refunds every entry.
   *
   * The specification's lobby idle timeout, applied to the one other place a
   * player can be left holding a paid seat that never happens. Without it a
   * registrant whose three companions never arrived keeps a spent 500 chips and
   * is refused every other online mode for the life of the database — which was
   * the measured behaviour before this existed.
   */
  registrationWindowMinutes: 30,
  betMillis: 7_000,
  actionMillis: 15_000,
  /** Short: a tournament table should not sit idle between hands. */
  settlementMillis: 8_000,
} as const;

/**
 * The bet ceiling for a given hand.
 *
 * A tie-break hand is played *at* a boundary and carries that boundary's
 * ceiling, because it is an extra hand rather than a later one — a sudden-death
 * hand after hand 6 must not hand the tied players hand-9 limits.
 */
export function maxBetForHand(handNumber: number): number {
  return handNumber >= SPRINT.lateBetsFromHand ? SPRINT.lateMaxBet : SPRINT.earlyMaxBet;
}

/**
 * Where the button sits for a hand, as an offset into the seating order.
 *
 * Hand 1 sits on `initialButton`, chosen by the server's CSPRNG so no seat has
 * a standing positional advantage, and moves one seat clockwise per hand
 * thereafter. Tie-break hands keep rotating: the specification says "continue
 * button rotation", so the count is of hands played, not of scheduled hands.
 */
export function buttonOffsetFor(handsPlayed: number, initialButton: number, seatCount: number): number {
  if (seatCount <= 0) throw new Error("a tournament table has at least one seat");
  const offset = initialButton + handsPlayed;
  // JavaScript's % keeps the sign of the dividend, so a negative initialButton
  // would otherwise produce a negative index.
  return ((offset % seatCount) + seatCount) % seatCount;
}

/**
 * Rotates a seating order so the button acts first.
 *
 * The engine deals and positions its turn cursor in `state.seats` order, so
 * moving the button IS rotating that array — there is no separate ordering to
 * keep in step, and therefore no second implementation of "who acts first".
 */
export function rotateToButton<T>(seats: readonly T[], offset: number): T[] {
  if (seats.length === 0) return [];
  const at = ((offset % seats.length) + seats.length) % seats.length;
  return [...seats.slice(at), ...seats.slice(0, at)];
}

// ---------------------------------------------------------------------------
// Standings, elimination and placement
// ---------------------------------------------------------------------------

export interface EntryStanding {
  entryId: string;
  stack: number;
  /** Null while still in the tournament. */
  eliminatedAfterHand: number | null;
}

/** A group of entries that cannot be separated by the format's own criteria. */
export interface TiedGroup {
  stack: number;
  entryIds: string[];
}

/** Still playing: not eliminated. Says nothing about whether they can afford a bet. */
export function activeEntries(standings: readonly EntryStanding[]): EntryStanding[] {
  return standings.filter((entry) => entry.eliminatedAfterHand === null);
}

/**
 * Entries that cannot cover the minimum bet.
 *
 * The specification is explicit that these are already out before the
 * elimination boundary is considered: "if a player already became unable to make
 * minimum bet before hand six, they are already eliminated". Note the test is
 * against the table minimum, not against zero — a stack of 50 at a 100 minimum
 * is just as finished as an empty one.
 */
export function bankruptEntries(standings: readonly EntryStanding[]): EntryStanding[] {
  return activeEntries(standings).filter((entry) => entry.stack < SPRINT.minBet);
}

/**
 * The group holding the lowest stack among active entries.
 *
 * Returns every entry on that stack, not one of them. A single-member group is
 * a clean elimination; a larger one is a tie that has to be played out.
 */
export function lowestStackGroup(standings: readonly EntryStanding[]): TiedGroup | null {
  const active = activeEntries(standings);
  if (active.length === 0) return null;

  const lowest = active.reduce((min, entry) => Math.min(min, entry.stack), Infinity);
  return {
    stack: lowest,
    entryIds: active.filter((entry) => entry.stack === lowest).map((entry) => entry.entryId).sort(),
  };
}

/** The mirror image, for resolving a tie at the top after the final hand. */
export function highestStackGroup(standings: readonly EntryStanding[]): TiedGroup | null {
  const active = activeEntries(standings);
  if (active.length === 0) return null;

  const highest = active.reduce((max, entry) => Math.max(max, entry.stack), -Infinity);
  return {
    stack: highest,
    entryIds: active.filter((entry) => entry.stack === highest).map((entry) => entry.entryId).sort(),
  };
}

export type BoundaryDecision =
  | { kind: "eliminate"; entryIds: string[] }
  | { kind: "tie_break"; entryIds: string[] }
  | { kind: "nothing_to_do" };

/**
 * Who is out for being unable to bet, at ANY hand.
 *
 * This is the only elimination that happens away from the hand-six boundary, and
 * it is deliberately a separate function from `decideElimination`. The first
 * version of this module had one function for both, and calling it after every
 * ordinary hand quietly turned the format into "lowest stack out every hand": a
 * measured run eliminated three players by hand three and settled the tournament
 * nine hands early. Splitting them means the ranked elimination cannot be reached
 * from an ordinary hand at all.
 */
export function decideBankruptcies(standings: readonly EntryStanding[]): BoundaryDecision {
  const bankrupt = bankruptEntries(standings);
  if (bankrupt.length === 0) return { kind: "nothing_to_do" };
  return { kind: "eliminate", entryIds: bankrupt.map((entry) => entry.entryId).sort() };
}

/**
 * What happens at the hand-six elimination boundary, and only there.
 *
 * Order matters and is the specification's, not a convenience: bankrupts go
 * first and *instead of* the ranked elimination, because they are already out
 * when the boundary is reached. Eliminating the lowest survivor on top of them
 * would take two players out at one boundary.
 */
export function decideElimination(
  standings: readonly EntryStanding[],
  tieBreakHandsUsed: number,
): BoundaryDecision {
  const bankrupt = bankruptEntries(standings);
  if (bankrupt.length > 0) {
    return { kind: "eliminate", entryIds: bankrupt.map((entry) => entry.entryId).sort() };
  }

  const active = activeEntries(standings);
  // Nothing left to separate: one player standing needs no elimination.
  if (active.length <= 1) return { kind: "nothing_to_do" };

  const lowest = lowestStackGroup(standings);
  if (!lowest) return { kind: "nothing_to_do" };

  if (lowest.entryIds.length === 1) {
    return { kind: "eliminate", entryIds: lowest.entryIds };
  }

  /*
   * A tie for the elimination spot. Play a sudden-death hand among exactly those
   * players and ask again.
   *
   * The cap is the specification's five hands. Past it the tie is accepted
   * rather than played forever, and the whole tied group goes out sharing one
   * placement: the boundary has to resolve, and leaving them all in would
   * silently change the format from twelve hands with four players to twelve
   * hands with four players and no elimination.
   */
  if (tieBreakHandsUsed >= SPRINT.maxTieBreakHands) {
    return { kind: "eliminate", entryIds: lowest.entryIds };
  }
  return { kind: "tie_break", entryIds: lowest.entryIds };
}

/**
 * What happens after the final scheduled hand.
 *
 * A tie for first is worth playing out — it decides the tournament — so it gets
 * the same sudden-death treatment, capped the same way. Ties below first are
 * settled by shared placement and a split prize without extra hands: the
 * specification asks for sudden death "among tied competitors" at "an
 * elimination or final boundary", and second versus third is neither.
 */
export function decideFinal(
  standings: readonly EntryStanding[],
  tieBreakHandsUsed: number,
): BoundaryDecision {
  const highest = highestStackGroup(standings);
  if (!highest || highest.entryIds.length === 1) return { kind: "nothing_to_do" };
  if (tieBreakHandsUsed >= SPRINT.maxTieBreakHands) return { kind: "nothing_to_do" };
  return { kind: "tie_break", entryIds: highest.entryIds };
}

export interface Placement {
  entryId: string;
  placement: number;
  prizeChips: number;
  prizeXp: number;
}

/**
 * Final placements, prizes and XP.
 *
 * The ordering, best to worst:
 *
 *   1. survivors before anyone eliminated — outlasting the field beats a stack;
 *   2. among survivors, the larger stack;
 *   3. among the eliminated, the later elimination;
 *   4. among those eliminated at the same boundary, the larger stack.
 *
 * Entries that tie on all of it share a placement, competition-style: two tied
 * for first are both 1st and the next player is 3rd. Their prizes are POOLED and
 * divided with integer division, and the remainder is not awarded to anyone.
 * That is deliberate — the alternative is picking a winner of the spare chips by
 * some arbitrary key, and an arbitrary key is exactly what "deterministic" is
 * supposed to rule out.
 */
export function computePlacements(standings: readonly EntryStanding[]): Placement[] {
  const ranked = [...standings].sort(compareForPlacement);

  const placements: Placement[] = [];
  let index = 0;
  while (index < ranked.length) {
    // Everyone the comparator cannot separate from the entry at `index`.
    let end = index + 1;
    while (end < ranked.length && compareForPlacement(ranked[index]!, ranked[end]!) === 0) end += 1;

    const groupSize = end - index;
    const placement = index + 1;

    // Pool the prizes for the slots this group occupies, then divide.
    let pooledChips = 0;
    let pooledXp = 0;
    for (let slot = placement; slot < placement + groupSize; slot += 1) {
      pooledChips += SPRINT.prizeChips[slot - 1] ?? 0;
      pooledXp += SPRINT.prizeXp[slot - 1] ?? 0;
    }
    const chipsEach = Math.floor(pooledChips / groupSize);
    const xpEach = Math.floor(pooledXp / groupSize);

    for (let offset = 0; offset < groupSize; offset += 1) {
      placements.push({
        entryId: ranked[index + offset]!.entryId,
        placement,
        prizeChips: chipsEach,
        prizeXp: xpEach,
      });
    }
    index = end;
  }

  return placements;
}

/** Negative when `a` finished better than `b`; zero when they cannot be separated. */
function compareForPlacement(a: EntryStanding, b: EntryStanding): number {
  const aOut = a.eliminatedAfterHand !== null;
  const bOut = b.eliminatedAfterHand !== null;
  if (aOut !== bOut) return aOut ? 1 : -1;

  if (aOut && bOut) {
    // Later elimination is the better finish.
    const byHand = (b.eliminatedAfterHand ?? 0) - (a.eliminatedAfterHand ?? 0);
    if (byHand !== 0) return byHand;
  }

  return b.stack - a.stack;
}

/**
 * The net effect of one completed tournament on the global wallet supply.
 *
 * Worth stating precisely rather than reassuringly: four entry fees take 2,000
 * chips out and the prize schedule puts 3,500 back, so a full sprint is a net
 * SOURCE of 1,500 chips, not a sink. That follows from the specification's own
 * figures — a 500 entry against 2,000/1,000/500 prizes — and it is a deliberate
 * property of an economy with no scarcity to protect: chips have no value, cannot
 * be bought and cannot be withdrawn, and the opening grant is already 25,000.
 *
 * What matters, and what the tests assert, is that every one of those chips
 * moves through `apply_wallet_delta` under a unique idempotency key. Tournament
 * STACKS never touch a wallet in either direction.
 */
export function walletEffectOfFullTournament(): {
  feesTaken: number;
  prizesPaid: number;
  netToWallets: number;
} {
  const feesTaken = SPRINT.entryFee * SPRINT.seats;
  const prizesPaid = SPRINT.prizeChips.reduce<number>((total, prize) => total + prize, 0);
  return { feesTaken, prizesPaid, netToWallets: prizesPaid - feesTaken };
}
