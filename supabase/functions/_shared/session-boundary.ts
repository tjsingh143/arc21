/**
 * What happens between hands in a mode that has a shape.
 *
 * An ordinary table just deals the next hand. A Career node stops after its own
 * hand count and awards its stars; a Daily Challenge stops after
 * twenty; a Sprint Tournament changes its bet ceiling at hand nine, eliminates
 * the lowest stack after hand six, plays sudden death when that boundary ties,
 * and settles placements after hand twelve. All of that has to happen at exactly
 * one moment — after a hand has settled and before the next one opens — and in
 * the same transaction as the command that triggers it, or a tournament can be
 * left half-eliminated by a dropped connection.
 *
 * The rules of BLACKJACK are not here and never will be. What is here is the
 * shape of a competition: who is still in it, what they may bet, where the button
 * sits, what a placement pays. The engine is asked to deal the next hand; it is
 * never told what a hand is worth.
 */

import type { EngineState } from "../../../shared/blackjack/index.js";
import { CommandError } from "./command-errors.ts";
import { toInteger, type Tx } from "./postgres-client.ts";
import { applyWalletDelta, findLedgerEntry } from "./session-repository.ts";
import { dailyScore, isComplete } from "./daily-challenge.ts";
import {
  activeEntries,
  buttonOffsetFor,
  computePlacements,
  decideBankruptcies,
  decideElimination,
  decideFinal,
  maxBetForHand,
  rotateToButton,
  SPRINT,
  type EntryStanding,
} from "./tournament-format.ts";
import { notifyTournamentResult } from "./notify.ts";
import { careerNodeBySlug, evaluateStars } from "./career/index.ts";
import { settleCareerReward } from "./career-rewards.ts";

export interface BoundaryResult {
  /**
   * True when the session is over and the engine must NOT deal another hand.
   * The caller closes the session instead of advancing.
   */
  finished: boolean;
  /** Human-readable, for the structured log. Never contains card identities. */
  note?: string;
}

/**
 * Runs the boundary for a session about to start its next hand.
 *
 * Called with `state` at HAND_COMPLETE, BEFORE the engine advances. Mutating the
 * state here is deliberate and narrow: it changes the posted bet limits, the
 * seating order and which seats are sitting out — table configuration, all of it
 * — and never a card, a wager or an outcome.
 */
export async function resolveHandBoundary(
  tx: Tx,
  params: {
    gameId: string;
    mode: string;
    state: EngineState;
    now: string;
  },
): Promise<BoundaryResult> {
  if (params.mode === "daily_challenge") return await dailyBoundary(tx, params);
  if (params.mode === "tournament") return await sprintBoundary(tx, params);
  if (params.mode === "career") return await careerBoundary(tx, params);
  return { finished: false };
}

// ---------------------------------------------------------------------------
// Career
// ---------------------------------------------------------------------------

/**
 * Stop after the node's hand count, award the stars, pay the reward once.
 *
 * Every number `evaluateStars` is given here was written by the server: the
 * hand count is the engine's, the finishing bankroll is the seat's stack in the
 * authoritative state, and the decision counters were accumulated by
 * `game-command` as each action was graded against the strategy tables BEFORE
 * it was applied. The client reports nothing, which is the whole of "a
 * reward-bearing attempt requires server authority".
 *
 * `evaluateStars` is the same pure function the offline runner calls — moved to
 * `_shared/career`, not copied, so there is one definition of what a star is.
 *
 * BANKROLL EXHAUSTION IS A COMPLETION. A player who runs out of chips has
 * finished what they came to do; the specification's rule is that one star is
 * always awarded for completing a node, so variance can slow progression and
 * can never wall anybody out of the rest of the product.
 */
async function careerBoundary(
  tx: Tx,
  params: { gameId: string; state: EngineState; now: string },
): Promise<BoundaryResult> {
  const rows = await tx<
    {
      attempt_id: string;
      user_id: string;
      node_id: string;
      node_code: string;
      decisions_total: unknown;
      decisions_optimal: unknown;
      unaided_total: unknown;
      unaided_optimal: unknown;
      ev_lost_micros: unknown;
      starting_chips: unknown;
    }[]
  >`
    select a.id as attempt_id, a.user_id, a.career_node_id as node_id, n.code as node_code,
           a.decisions_total, a.decisions_optimal, a.unaided_total, a.unaided_optimal,
           a.ev_lost_micros, a.starting_chips
    from public.career_attempts a
    join public.career_nodes n on n.id = a.career_node_id
    where a.game_session_id = ${params.gameId}::uuid and a.status = 'in_progress'
    for update of a
  `;
  const row = rows[0];
  // No live attempt means this session has already been finalised — a replayed
  // NEXT_HAND, most likely. Nothing to do, and nothing to pay twice.
  if (!row) return { finished: false };

  const node = careerNodeBySlug(row.node_code);
  if (!node) throw new CommandError("INTERNAL", `attempt names unknown node ${row.node_code}`);

  const seat = params.state.seats[0];
  if (!seat) throw new CommandError("INTERNAL", "career session has no seat");

  const handsTarget = node.hands ?? 0;
  const finalChips = seat.stack;
  // Below the table minimum there is no legal bet left to place, so the session
  // cannot continue whatever the hand count says.
  const broke = finalChips < params.state.rules.minBet;
  const reachedTarget = handsTarget > 0 && params.state.handNumber >= handsTarget;
  if (!reachedTarget && !broke) return { finished: false };

  const decisions = toInteger(row.decisions_total, "career_attempts.decisions_total");
  const correct = toInteger(row.decisions_optimal, "career_attempts.decisions_optimal");
  const unaided = toInteger(row.unaided_total, "career_attempts.unaided_total");
  const unaidedCorrect = toInteger(row.unaided_optimal, "career_attempts.unaided_optimal");
  const evLostMicros = toInteger(row.ev_lost_micros, "career_attempts.ev_lost_micros");
  const startingChips = toInteger(row.starting_chips, "career_attempts.starting_chips");

  const evaluation = evaluateStars(node, {
    nodeId: node.id,
    completed: true,
    completionReason: broke && !reachedTarget ? "bankroll_exhausted" : "target_reached",
    handsPlayed: params.state.handNumber,
    decisions,
    correct,
    unaidedDecisions: unaided,
    unaidedCorrect,
    estimatedEvLost: evLostMicros / 1_000_000,
    startingBankroll: startingChips,
    endingBankroll: finalChips,
  });

  await tx`
    update public.career_attempts
    set status = 'completed', completed_at = ${params.now}::timestamptz,
        stars = ${evaluation.stars}::int,
        hands_played = ${params.state.handNumber}::int,
        final_chips = ${finalChips}::bigint
    where id = ${row.attempt_id}::uuid
  `;

  await settleCareerReward(tx, {
    userId: row.user_id,
    nodeId: row.node_id,
    node,
    stars: evaluation.stars,
    // The finishing bankroll is the node's own score. A drill scores on correct
    // answers instead; both are best-of in `record_career_completion`.
    score: finalChips,
  });

  closeOut(params.state);
  return {
    finished: true,
    note: `career ${node.slug} complete: ${evaluation.stars}★ at ${finalChips}`,
  };
}

// ---------------------------------------------------------------------------
// Daily Challenge
// ---------------------------------------------------------------------------

/**
 * Stop after the challenge's hand count, score the attempt, pay the reward once.
 *
 * The score is the ending bankroll and nothing else — no time term, because the
 * specification is explicit that completion speed is not a skill metric.
 */
async function dailyBoundary(
  tx: Tx,
  params: { gameId: string; state: EngineState; now: string },
): Promise<BoundaryResult> {
  const rows = await tx<
    {
      challenge_id: string;
      hand_count: unknown;
      reward_chips: unknown;
      reward_xp: unknown;
      entry_id: string | null;
      entry_status: string | null;
      user_id: string;
    }[]
  >`
    select c.id as challenge_id, c.hand_count, c.reward_chips, c.reward_xp,
           e.id as entry_id, e.status as entry_status, s.host_user_id as user_id
    from public.game_sessions s
    join public.daily_challenges c on c.id = s.daily_challenge_id
    left join public.daily_entries e
      on e.daily_challenge_id = c.id and e.user_id = s.host_user_id
    where s.id = ${params.gameId}::uuid
  `;
  const row = rows[0];
  if (!row) throw new CommandError("INTERNAL", "no daily challenge for this session");

  const handCount = toInteger(row.hand_count, "daily_challenges.hand_count");
  if (!isComplete(params.state.handNumber, handCount)) return { finished: false };

  const seat = params.state.seats[0];
  if (!seat) throw new CommandError("INTERNAL", "daily challenge session has no seat");
  const finalChips = seat.stack;
  const score = dailyScore({ handsPlayed: params.state.handNumber, finalChips });

  /*
   * An unranked replay has no entry row, so there is nothing to write and nothing
   * to pay. This is the enforcement of "an unranked replay must not overwrite a
   * ranked score": the row that would have to be overwritten is never reached,
   * rather than being reached and then compared.
   */
  if (row.entry_id && row.entry_status === "in_progress") {
    await tx`
      update public.daily_entries
      set status = 'completed',
          hands_played = ${params.state.handNumber}::int,
          final_chips = ${finalChips}::bigint,
          score = ${score}::bigint,
          completed_at = ${params.now}::timestamptz
      where id = ${row.entry_id}::uuid
    `;

    const rewardChips = toInteger(row.reward_chips, "daily_challenges.reward_chips");
    const rewardXp = toInteger(row.reward_xp, "daily_challenges.reward_xp");

    // Derived from the challenge and the player, never from a request id, so a
    // retried final command cannot pay a second reward.
    const key = `daily_reward:${row.challenge_id}:${row.user_id}`;
    if (rewardChips > 0 && !(await findLedgerEntry(tx, key))) {
      const ledger = await applyWalletDelta(tx, {
        userId: row.user_id,
        delta: rewardChips,
        reason: "daily_challenge_reward",
        idempotencyKey: key,
        referenceId: row.challenge_id,
        metadata: { score, handsPlayed: params.state.handNumber },
      });
      await tx`
        update public.daily_entries set reward_ledger_id = ${ledger.id}::uuid
        where id = ${row.entry_id}::uuid
      `;
      if (rewardXp > 0) {
        await tx`select public.award_milestone_xp(${row.user_id}::uuid, ${rewardXp}::int)`;
      }
    }
  }

  /*
   * A completed challenge can extend a daily streak, and a paid reward can move a
   * level — both of which unlock cosmetics. Granting here means a player finds the
   * item waiting for them rather than having to open the inventory to trigger it.
   * Idempotent, so a replayed finalisation grants nothing twice.
   */
  await tx`select public.grant_earned_cosmetics_for(${row.user_id}::uuid)`;

  closeOut(params.state);
  return { finished: true, note: `daily complete at ${finalChips}` };
}

// ---------------------------------------------------------------------------
// Sprint Tournament
// ---------------------------------------------------------------------------

interface SprintRow {
  tournament_id: string;
  tie_break_boundary: number | null;
  tie_break_hands_used: unknown;
  scheduled_hands_played: unknown;
  initial_button: unknown;
}

interface EntryRow {
  id: string;
  user_id: string;
  status: string;
  eliminated_after_hand: number | null;
  seat_id: string | null;
}

async function sprintBoundary(
  tx: Tx,
  params: { gameId: string; state: EngineState; now: string },
): Promise<BoundaryResult> {
  const tournamentRows = await tx<SprintRow[]>`
    select t.id as tournament_id, t.tie_break_boundary, t.tie_break_hands_used,
           t.scheduled_hands_played, t.initial_button
    from public.game_sessions s
    join public.tournaments t on t.id = s.tournament_id
    where s.id = ${params.gameId}::uuid
    for update of t
  `;
  const tournament = tournamentRows[0];
  if (!tournament) throw new CommandError("INTERNAL", "no tournament for this session");

  const tieBreakUsed = toInteger(tournament.tie_break_hands_used, "tie_break_hands_used");
  const initialButton = toInteger(tournament.initial_button ?? 0, "initial_button");

  /*
   * A sudden-death hand is an EXTRA hand, not the next scheduled one.
   *
   * The hand that just settled was a tie-break hand exactly when a boundary was
   * already being resolved when it started. Those do not count towards the twelve,
   * so the scheduled counter — not the engine's hand number — decides where the
   * boundaries and the bet ceiling fall.
   */
  const wasTieBreakHand = tournament.tie_break_boundary !== null;
  const scheduledPlayed =
    toInteger(tournament.scheduled_hands_played, "scheduled_hands_played") +
    (wasTieBreakHand ? 0 : 1);

  await tx`
    update public.tournaments
    set scheduled_hands_played = ${scheduledPlayed}::int, updated_at = now()
    where id = ${tournament.tournament_id}::uuid
  `;

  const entryRows = await tx<EntryRow[]>`
    select e.id, e.user_id, e.status, e.eliminated_after_hand,
           (select seat.id from public.game_session_seats seat
            where seat.game_session_id = ${params.gameId}::uuid and seat.user_id = e.user_id
            limit 1) as seat_id
    from public.tournament_entries e
    where e.tournament_id = ${tournament.tournament_id}::uuid
    order by e.bracket_seed
  `;

  // Standings come from the ENGINE's stacks, which are the authoritative chips,
  // and are written back to the entries so competitors can read them. The
  // entries are a projection; they are never the source.
  const standings: EntryStanding[] = entryRows.map((entry) => ({
    entryId: entry.id,
    stack: stackOf(params.state, entry.seat_id),
    eliminatedAfterHand: entry.eliminated_after_hand,
  }));

  for (const standing of standings) {
    await tx`
      update public.tournament_entries
      set chips = ${standing.stack}::bigint, score = ${standing.stack}::bigint,
          in_tie_break = false
      where id = ${standing.entryId}::uuid
    `;
  }
  for (const seat of params.state.seats) seat.sitOutNextHand = false;

  const handsPlayed = params.state.handNumber;

  /*
   * Which boundary, if any, this hand has just reached — counted in SCHEDULED
   * hands.
   *
   * A tie-break in progress pins the boundary: a sudden-death hand played after
   * hand six is an EXTRA hand at that boundary, not hand seven, so it must be
   * judged — and priced — as hand six.
   */
  const boundary =
    tournament.tie_break_boundary ??
    (scheduledPlayed >= SPRINT.scheduledHands
      ? SPRINT.scheduledHands
      : scheduledPlayed === SPRINT.eliminationHand
        ? SPRINT.eliminationHand
        : null);

  const atFinal = boundary === SPRINT.scheduledHands;
  const tieBreakNowUsed = tournament.tie_break_boundary === null ? tieBreakUsed : tieBreakUsed + 1;

  if (boundary === null) {
    // An ordinary hand. ONLY the bankrupt go out: the specification eliminates a
    // player who cannot make the minimum bet the moment it is true, and nobody
    // else until hand six. `decideBankruptcies` rather than `decideElimination`
    // for exactly that reason — the ranked elimination must be unreachable here.
    const decision = decideBankruptcies(standings);
    if (decision.kind === "eliminate") {
      await eliminate(tx, decision.entryIds, handsPlayed, params);
      const remaining = standings.filter((s) => !decision.entryIds.includes(s.entryId));
      if (activeEntries(remaining).length <= 1) {
        return await finaliseSprint(tx, tournament.tournament_id, params, handsPlayed);
      }
    }
    return openNextSprintHand(params, handsPlayed, scheduledPlayed, initialButton);
  }

  const decision = atFinal
    ? decideFinal(standings, tieBreakNowUsed)
    : decideElimination(standings, tieBreakNowUsed);

  if (decision.kind === "tie_break") {
    // Sudden death: the tied players alone, at this boundary's bet ceiling, with
    // the button still rotating. Everyone else is held out of exactly one hand.
    await tx`
      update public.tournaments
      set tie_break_boundary = ${boundary}::int,
          tie_break_hands_used = ${tieBreakNowUsed}::int,
          updated_at = now()
      where id = ${tournament.tournament_id}::uuid
    `;

    const tiedSeatIds = new Set(
      entryRows
        .filter((entry) => decision.entryIds.includes(entry.id))
        .map((entry) => entry.seat_id)
        .filter((seatId): seatId is string => seatId !== null),
    );

    for (const seat of params.state.seats) {
      if (!tiedSeatIds.has(seat.seatId)) seat.sitOutNextHand = true;
    }
    for (const entryId of decision.entryIds) {
      await tx`
        update public.tournament_entries set in_tie_break = true where id = ${entryId}::uuid
      `;
    }

    params.state.rules = { ...params.state.rules, maxBet: maxBetForHand(boundary) };
    rotateButton(params.state, handsPlayed, initialButton);
    return {
      finished: false,
      note: `tie-break ${tieBreakNowUsed}/${SPRINT.maxTieBreakHands} at hand ${boundary}`,
    };
  }

  // The boundary resolved, one way or the other.
  await tx`
    update public.tournaments
    set tie_break_boundary = null, tie_break_hands_used = ${tieBreakNowUsed}::int, updated_at = now()
    where id = ${tournament.tournament_id}::uuid
  `;

  if (decision.kind === "eliminate") {
    await eliminate(tx, decision.entryIds, boundary, params);
  }

  const survivors = standings.filter(
    (standing) => decision.kind !== "eliminate" || !decision.entryIds.includes(standing.entryId),
  );

  if (atFinal || activeEntries(survivors).length <= 1) {
    return await finaliseSprint(tx, tournament.tournament_id, params, handsPlayed);
  }

  return openNextSprintHand(params, handsPlayed, scheduledPlayed, initialButton);
}

/** The bet ceiling and the button for the hand about to open. */
function openNextSprintHand(
  params: { state: EngineState },
  handsPlayed: number,
  scheduledPlayed: number,
  initialButton: number,
): BoundaryResult {
  const nextScheduledHand = scheduledPlayed + 1;

  // Scheduled hands 1–8 cap at 2,000; 9–12 at 5,000. This is the posted table
  // limit changing, which is a property of the format rather than of blackjack, so
  // it is written here and read by the engine's own bet validation.
  params.state.rules = { ...params.state.rules, maxBet: maxBetForHand(nextScheduledHand) };

  // The button rotates on every hand DEALT, tie-break hands included — the
  // specification's "continue button rotation" — so this counts engine hands
  // while the ceiling above counts scheduled ones.
  rotateButton(params.state, handsPlayed, initialButton);

  return {
    finished: false,
    note: `scheduled hand ${nextScheduledHand}, max bet ${params.state.rules.maxBet}`,
  };
}

/**
 * Moves the button one seat clockwise.
 *
 * The engine deals and positions its turn cursor in `state.seats` order, so this
 * is a rotation of that array and nothing else. Seat rows in the database keep
 * their original `seat_index`; the engine's order is action order, which is what
 * "the button determines the first bettor and the first to act" means.
 */
function rotateButton(state: EngineState, handsPlayed: number, initialButton: number): void {
  const previous = buttonOffsetFor(handsPlayed - 1, initialButton, state.seats.length);
  const next = buttonOffsetFor(handsPlayed, initialButton, state.seats.length);
  // The array is already rotated to `previous`, so shift by the difference rather
  // than by the absolute offset.
  const shift = ((next - previous) % state.seats.length + state.seats.length) % state.seats.length;
  state.seats = rotateToButton(state.seats, shift);
}

async function eliminate(
  tx: Tx,
  entryIds: readonly string[],
  afterHand: number,
  params: { gameId: string; state: EngineState; now: string },
): Promise<void> {
  for (const entryId of entryIds) {
    const rows = await tx<{ user_id: string }[]>`
      update public.tournament_entries
      set status = 'eliminated',
          eliminated_after_hand = ${afterHand}::int,
          eliminated_at = ${params.now}::timestamptz,
          in_tie_break = false
      where id = ${entryId}::uuid
      returning user_id
    `;
    const userId = rows[0]?.user_id;
    if (!userId) continue;

    const seatRows = await tx<{ id: string }[]>`
      update public.game_session_seats
      set status = 'left', left_at = ${params.now}::timestamptz
      where game_session_id = ${params.gameId}::uuid and user_id = ${userId}::uuid
      returning id
    `;
    const seatId = seatRows[0]?.id;

    const seat = params.state.seats.find((candidate) => candidate.seatId === seatId);
    if (seat) {
      /*
       * `connected = false` is what actually keeps them out. `sittingOut` alone is
       * reinstated by the next betting round for any seat that is connected and
       * can cover the minimum — which an eliminated player with chips still left
       * would be. Their stack stays on the seat rather than being zeroed, because
       * the result screen reports the bankroll they went out on.
       */
      seat.sittingOut = true;
      seat.connected = false;
      seat.sitOutNextHand = false;
    }
  }
}

/**
 * Placements, prizes and XP, once.
 *
 * "Duplicate prize impossible" is a named acceptance criterion, and the thing
 * that makes it true is not the check below but the ledger's unique idempotency
 * key: `sprint_prize:<tournamentId>:<userId>` can exist at most once, whatever
 * this function is asked to do.
 */
async function finaliseSprint(
  tx: Tx,
  tournamentId: string,
  params: { gameId: string; state: EngineState; now: string },
  handsPlayed: number,
): Promise<BoundaryResult> {
  /*
   * The single gate on paying anything at all.
   *
   * The tournament row is already held FOR UPDATE by the caller, so this read is
   * serialised against any concurrent finalisation. A tournament that is already
   * `completed` has already been settled, and re-settling it is the shape a
   * duplicate prize would take. The ledger's unique idempotency key is the second
   * line rather than the first: it would refuse the chips, but it would not stop
   * a second XP award.
   */
  const statusRows = await tx<{ status: string }[]>`
    select status from public.tournaments where id = ${tournamentId}::uuid
  `;
  if (statusRows[0]?.status === "completed") {
    closeOut(params.state);
    return { finished: true, note: "tournament was already settled" };
  }

  const entryRows = await tx<EntryRow[]>`
    select e.id, e.user_id, e.status, e.eliminated_after_hand,
           (select seat.id from public.game_session_seats seat
            where seat.game_session_id = ${params.gameId}::uuid and seat.user_id = e.user_id
            limit 1) as seat_id
    from public.tournament_entries e
    where e.tournament_id = ${tournamentId}::uuid
  `;

  const standings: EntryStanding[] = entryRows.map((entry) => ({
    entryId: entry.id,
    stack: stackOf(params.state, entry.seat_id),
    eliminatedAfterHand: entry.eliminated_after_hand,
  }));

  const placements = computePlacements(standings);
  const byEntry = new Map(entryRows.map((entry) => [entry.id, entry]));

  for (const placement of placements) {
    const entry = byEntry.get(placement.entryId);
    if (!entry) continue;

    await tx`
      update public.tournament_entries
      set placement = ${placement.placement}::int,
          prize_chips = ${placement.prizeChips}::bigint,
          prize_xp = ${placement.prizeXp}::int,
          status = case when status = 'eliminated' then 'eliminated'::public.tournament_entry_status
                        else 'active'::public.tournament_entry_status end
      where id = ${placement.entryId}::uuid
    `;

    const key = `sprint_prize:${tournamentId}:${entry.user_id}`;
    if (placement.prizeChips > 0 && !(await findLedgerEntry(tx, key))) {
      const ledger = await applyWalletDelta(tx, {
        userId: entry.user_id,
        delta: placement.prizeChips,
        reason: "tournament_prize",
        idempotencyKey: key,
        referenceId: tournamentId,
        metadata: { placement: placement.placement, handsPlayed },
      });
      await tx`
        update public.tournament_entries set prize_ledger_id = ${ledger.id}::uuid
        where id = ${placement.entryId}::uuid
      `;
    }
    if (placement.prizeXp > 0) {
      // Reached only once, because the tournament's `completed` status gates the
      // whole function. That matters most for fourth place, which earns XP and no
      // chips and so has no ledger row to collide with.
      await tx`select public.award_milestone_xp(${entry.user_id}::uuid, ${placement.prizeXp}::int)`;
    }

    // A placement is a cosmetic unlock condition, and the XP just awarded may have
    // moved a level, which is another. Both are evaluated server-side from what the
    // player earned; the call is idempotent.
    await tx`select public.grant_earned_cosmetics_for(${entry.user_id}::uuid)`;

    // Told the same way to everyone, fourth included. Deduped on the tournament,
    // and inside the settlement transaction — nobody hears a placement that was
    // rolled back.
    await notifyTournamentResult(tx, {
      tournamentId,
      userId: entry.user_id,
      placement: placement.placement,
      prizeChips: placement.prizeChips,
    });
  }

  await tx`
    update public.tournaments
    set status = 'completed', ends_at = ${params.now}::timestamptz, updated_at = now()
    where id = ${tournamentId}::uuid
  `;

  closeOut(params.state);
  return { finished: true, note: `tournament settled after ${handsPlayed} hands` };
}

// ---------------------------------------------------------------------------

function stackOf(state: EngineState, seatId: string | null): number {
  if (!seatId) return 0;
  const seat = state.seats.find((candidate) => candidate.seatId === seatId);
  return seat ? seat.stack : 0;
}

/**
 * Ends the table.
 *
 * No chips are moved: a tournament stack and a challenge stack are scoring media
 * that end with the session, which is exactly why `session-economics.ts` lists
 * neither mode as wallet-backed.
 */
function closeOut(state: EngineState): void {
  state.phase = "SESSION_COMPLETE";
  state.actionDeadlineAt = null;
  state.activeSeatIndex = null;
  state.activeHandIndex = null;
}
