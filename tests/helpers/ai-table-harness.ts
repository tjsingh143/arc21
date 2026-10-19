/**
 * AI tables for tests: an engine table with computer seats, and the person's
 * command applied the way `game-command` applies it — the engine first, then
 * every computer decision the table is waiting on, in the same step.
 *
 * Built on the same preordered-shoe technique as `engine-harness.ts`, so a test
 * can name the exact cards every seat and the dealer receive.
 */

import {
  aiTableRules,
  AI_TABLE_STACK,
  applyCommand,
  createGame,
  createPreorderedShoe,
  SeededTestRandomSource,
  startSession,
  type EngineCommand,
  type EngineEvent,
  type EngineState,
  type SeatSeed,
} from "../../shared/blackjack/index.js";
import {
  driveAiSeats,
  type AiSeatAction,
  type AiSeatContext,
} from "../../supabase/functions/_shared/ai-seat-driver.js";
import { cards } from "./engine-harness.js";

export type SeatKind = "ai" | "person";

/** The server's own layout: a computer player either side of the person. */
export const DEFAULT_LAYOUT: readonly SeatKind[] = ["ai", "person", "ai"];

/** Seat ids by position: `ai-0`, `person-1`, `ai-2` for the default layout. */
export function seatIdAt(kind: SeatKind, index: number): string {
  return `${kind}-${index}`;
}

export const AI_TEST_CONTEXT: AiSeatContext = {
  random: new SeededTestRandomSource(4242),
  now: "2026-10-05T12:00:00.000Z",
};

function seedsFor(layout: readonly SeatKind[], stacks?: readonly number[]): SeatSeed[] {
  return layout.map((kind, index) => {
    const stack = stacks?.[index] ?? AI_TABLE_STACK;
    return kind === "ai"
      ? { seatId: seatIdAt(kind, index), displayName: `AI Player ${index}`, stack, isAi: true }
      : { seatId: seatIdAt(kind, index), userId: `user-${index}`, displayName: "Person", stack };
  });
}

/** Filler that never forms a natural, long enough to survive the safety reserve. */
function defaultPad(): string {
  return Array.from({ length: 60 }, () => "5C 6D 7H 8S 9C").join(" ");
}

/**
 * An AI table in its first betting window, dealt from exactly `shoe`.
 *
 * Deal order is every seat's first card in seating order, the dealer's upcard,
 * every seat's second card, then the dealer's hole card — so for the default
 * three-seat layout the first eight cards are: ai-0, person-1, ai-2, UP,
 * ai-0, person-1, ai-2, HOLE.
 */
export function aiTable(options: {
  shoe: string;
  layout?: readonly SeatKind[];
  stacks?: readonly number[];
  pad?: string;
}): EngineState {
  const created = createGame({
    gameId: "ai-table-test",
    rules: aiTableRules(),
    seats: seedsFor(options.layout ?? DEFAULT_LAYOUT, options.stacks),
    random: new SeededTestRandomSource(1),
  });
  const fixture = createPreorderedShoe(cards(options.shoe), cards(options.pad ?? defaultPad()));
  return startSession({ ...created, shoe: fixture }, AI_TEST_CONTEXT).state;
}

/** An AI table dealt from a real shuffle, for many-hand runs. */
export function shuffledAiTable(seed: number, layout: readonly SeatKind[] = DEFAULT_LAYOUT): EngineState {
  const created = createGame({
    gameId: `ai-shuffled-${seed}`,
    rules: aiTableRules(),
    seats: seedsFor(layout),
    random: new SeededTestRandomSource(seed),
  });
  return startSession(created, { ...AI_TEST_CONTEXT, random: new SeededTestRandomSource(seed + 1) })
    .state;
}

export interface PersonStep {
  readonly state: EngineState;
  /** The person's own events, then every computer decision's, in order. */
  readonly events: readonly EngineEvent[];
  readonly aiActions: readonly AiSeatAction[];
}

/** One command from the person, exactly as `game-command` handles it. */
export function personSends(
  state: EngineState,
  command: EngineCommand,
  context: AiSeatContext = AI_TEST_CONTEXT,
): PersonStep {
  const applied = applyCommand(state, command, context);
  const drive = driveAiSeats(applied.state, context);
  return {
    state: drive.state,
    events: [...applied.events, ...drive.events],
    aiActions: drive.actions,
  };
}

/** The person stakes `amount` and locks it — the client's two commands. */
export function personBets(
  state: EngineState,
  amount: number,
  seatId = "person-1",
  context: AiSeatContext = AI_TEST_CONTEXT,
): PersonStep {
  const placed = personSends(state, { type: "PLACE_BET", seatId, amount }, context);
  const locked = personSends(placed.state, { type: "LOCK_BET", seatId }, context);
  return {
    state: locked.state,
    events: [...placed.events, ...locked.events],
    aiActions: [...placed.aiActions, ...locked.aiActions],
  };
}
