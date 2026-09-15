/**
 * Test harness for driving the engine over an exactly known shoe.
 *
 * Deterministic fixtures are the only honest way to test a card game: a
 * statistical "the shuffle looks random" assertion with a loose tolerance would
 * pass on a broken implementation and fail at random on a correct one.
 */

import { parseCardShorthand } from "../../shared/blackjack/cards.js";
import {
  applyCommand,
  beginNextHand,
  createGame,
  startSession,
  type CommandContext,
  type EngineState,
  type SeatSeed,
} from "../../shared/blackjack/reducer.js";
import { SeededTestRandomSource } from "../../shared/blackjack/rng.js";
import {
  createPreorderedShoe,
  needsReshuffle,
  SAFETY_RESERVE_CARDS,
} from "../../shared/blackjack/shoe.js";
import { ARC_STANDARD_RULES, type BlackjackRules } from "../../shared/blackjack/rules.js";
import type { Card, EngineCommand, EngineEvent, Shoe } from "../../shared/blackjack/types.js";

export const TEST_CONTEXT: CommandContext = { random: new SeededTestRandomSource(12345) };

/**
 * Parses a card list like "AS 10H 7D". Each card gets a unique id suffix so
 * repeated ranks in a fixture remain distinct physical cards.
 */
export function cards(spec: string): Card[] {
  return spec
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((shorthand, index) => parseCardShorthand(shorthand, 0, `#${index}`));
}

export interface HarnessOptions {
  rules?: Partial<BlackjackRules>;
  seats?: SeatSeed[];
  /** Cards dealt in exact order. Deal order is P1, dealer up, P2, dealer hole. */
  shoe: string;
  /** Extra cards appended so post-fixture draws do not exhaust the shoe. */
  pad?: string;
}

export interface Harness {
  state: EngineState;
  events: EngineEvent[];
  send(command: EngineCommand): Harness;
  nextHand(): Harness;
  /** Replaces the state directly. For setting up conditions the commands cannot. */
  patch(mutate: (state: EngineState) => EngineState): Harness;
  seat(seatId?: string): EngineState["seats"][number];
  hand(seatId?: string, index?: number): EngineState["seats"][number]["hands"][number];
}

const DEFAULT_SEATS: SeatSeed[] = [{ seatId: "s1", displayName: "Tester", stack: 10_000 }];

/**
 * Builds a session whose shoe is a fixed, known sequence and which has already
 * been advanced into BETTING_OPEN.
 */
export function harness(options: HarnessOptions): Harness {
  const rules: BlackjackRules = { ...ARC_STANDARD_RULES, ...options.rules };

  let state = createGame({
    gameId: "test",
    rules,
    seats: options.seats ?? DEFAULT_SEATS,
    random: new SeededTestRandomSource(1),
  });

  // Replace the shuffled shoe with the fixture. cutIndex is set past the end so
  // no reshuffle interferes with the scripted sequence.
  const fixture = createPreorderedShoe(
    cards(options.shoe),
    options.pad ? cards(options.pad) : cards(defaultPad()),
  );
  assertFixtureSurvivesTheFirstBettingRound(fixture);
  state = { ...state, shoe: fixture };

  const started = startSession(state, TEST_CONTEXT);
  return makeHarness(started.state, [...started.events]);
}

function makeHarness(state: EngineState, events: EngineEvent[]): Harness {
  return {
    state,
    events,
    send(command: EngineCommand) {
      const result = applyCommand(state, command, TEST_CONTEXT);
      return makeHarness(result.state, [...events, ...result.events]);
    },
    nextHand() {
      const result = beginNextHand(state, TEST_CONTEXT);
      return makeHarness(result.state, [...events, ...result.events]);
    },
    patch(mutate: (current: EngineState) => EngineState) {
      return makeHarness(mutate(state), events);
    },
    seat(seatId = "s1") {
      const found = state.seats.find((candidate) => candidate.seatId === seatId);
      if (!found) throw new Error(`No seat ${seatId}`);
      return found;
    },
    hand(seatId = "s1", index = 0) {
      const found = this.seat(seatId).hands[index];
      if (!found) throw new Error(`No hand ${index} for seat ${seatId}`);
      return found;
    },
  };
}

/** Filler cards that never form a natural, keeping fixtures unambiguous. */
function defaultPad(): string {
  return Array.from({ length: 60 }, () => "5C 6D 7H 8S 9C").join(" ");
}

/**
 * A fixture shorter than the safety reserve is thrown away before it is used.
 *
 * `startSession` opens the first betting round, and `openBetting` reshuffles
 * whenever `needsReshuffle` is true — which it is for ANY shoe holding fewer
 * than `SAFETY_RESERVE_CARDS`. The fixture is then replaced by a real shuffled
 * six-deck shoe, and the test carries on against cards nobody chose: it does
 * not error, it does not skip, it silently stops testing what it says it tests.
 *
 * Found by writing a dealer table with a 40-card pad and watching eleven cases
 * fail against random cards. Cheaper to refuse the fixture than to debug it.
 */
function assertFixtureSurvivesTheFirstBettingRound(fixture: Shoe): void {
  if (!needsReshuffle(fixture)) return;
  throw new Error(
    `Fixture shoe of ${fixture.cards.length} cards would be reshuffled away before the ` +
      `first hand: openBetting reshuffles below the ${SAFETY_RESERVE_CARDS}-card safety ` +
      `reserve, replacing it with a random six-deck shoe. Lengthen \`pad\` past ` +
      `${SAFETY_RESERVE_CARDS} cards, or omit it to use the default.`,
  );
}

/** Places and locks a bet for every seat, cascading into the deal. */
export function betAndDeal(h: Harness, amount = 100, seatIds: string[] = ["s1"]): Harness {
  let current = h;
  for (const seatId of seatIds) {
    current = current.send({ type: "PLACE_BET", seatId, amount });
  }
  for (const seatId of seatIds) {
    current = current.send({ type: "LOCK_BET", seatId });
  }
  return current;
}

export function eventTypes(events: EngineEvent[]): string[] {
  return events.map((event) => event.type);
}

export function findEvent<T extends EngineEvent["type"]>(
  events: EngineEvent[],
  type: T,
): Extract<EngineEvent, { type: T }> | undefined {
  return events.find((event) => event.type === type) as
    | Extract<EngineEvent, { type: T }>
    | undefined;
}
