/**
 * Arc 21 — performance measurement.
 *
 * The engine's hot-path figures have been quoted in `docs/IMPLEMENTATION_STATUS.md`
 * since phase 13, but they were produced by an ad-hoc script that was never
 * committed — so nobody could re-derive them, and a regression would have gone
 * unnoticed until someone happened to measure again. This file is that script,
 * committed, so the numbers in the docs have something behind them.
 *
 *   npm run benchmark
 *
 * `NODE_OPTIONS=--expose-gc` matters and the npm script sets it: `tsx`
 * re-executes in a child process, so a bare `node --expose-gc tsx …` does not
 * reach the code that runs. Without it the heap figures are whatever the
 * collector happened to have done and can even come out negative.
 *
 * QUOTE THE RANGE, NOT ONE RUN. Five consecutive runs on an otherwise idle
 * host (load ~5) measured 752, 758, 782, 803 and 808 µs per hand. A single
 * cold run on the same commit measured 1,242 µs — 1.6× the steady figure — so
 * a one-shot number is not evidence of a regression. Re-run before believing
 * one, and check `uptime` first, for the same reason Maestro needs an idle
 * machine.
 *
 * WHAT THIS CANNOT MEASURE. Native frame timing — whether the deal animation
 * actually holds 60 fps on a device — needs Instruments driving a real build,
 * which cannot be automated from this environment. The animation section below
 * checks the TIMING BUDGET the animation is configured with (a arithmetic
 * property of the constants in `src/design/motion.ts`), not the frames a GPU
 * produced. Do not quote it as a frame-rate measurement. Likewise the heap
 * figures are Node's, not a device's RSS.
 */

import { performance } from "node:perf_hooks";

import {
  applyCommand,
  beginNextHand,
  createGame,
  startSession,
  type CommandContext,
  type EngineState,
} from "../shared/blackjack/reducer.js";
import { SeededTestRandomSource } from "../shared/blackjack/rng.js";
import { getLegalActions } from "../shared/blackjack/legal-actions.js";
import { durations } from "../src/design/motion-timing.js";

const SEAT = "bench";

function fresh(): EngineState {
  const random = new SeededTestRandomSource(20260822);
  const state = createGame({
    gameId: "bench",
    seats: [{ seatId: SEAT, displayName: "Bench", stack: 1_000_000_000 }],
    random,
  });
  return startSession(state, { random }).state;
}

/**
 * Plays one hand: bet, lock, then stand on every hand the seat is given.
 * Standing rather than playing strategy keeps the command count stable, which
 * is what makes run-to-run comparison meaningful.
 */
function playHand(state: EngineState, context: CommandContext): { state: EngineState; commands: number } {
  let commands = 0;
  let next = applyCommand(state, { type: "PLACE_BET", seatId: SEAT, amount: 100 }, context).state;
  commands += 1;
  next = applyCommand(next, { type: "LOCK_BET", seatId: SEAT }, context).state;
  commands += 1;

  if (next.phase === "INSURANCE_OFFER") {
    next = applyCommand(next, { type: "DECLINE_INSURANCE", seatId: SEAT }, context).state;
    commands += 1;
  }

  let guard = 0;
  while (next.phase === "PLAYER_TURNS" && guard < 20) {
    const legal = getLegalActions(next, SEAT);
    if (!legal.actions.includes("STAND")) break;
    next = applyCommand(next, { type: "STAND", seatId: SEAT }, context).state;
    commands += 1;
    guard += 1;
  }

  return { state: next, commands };
}

function benchmarkEngine(hands: number): void {
  const random = new SeededTestRandomSource(20260822);
  const context: CommandContext = { random };
  let state = fresh();
  let commands = 0;

  const started = performance.now();
  for (let i = 0; i < hands; i += 1) {
    const played = playHand(state, context);
    commands += played.commands;
    state = beginNextHand(played.state, context).state;
    commands += 1;
  }
  const elapsed = performance.now() - started;

  console.log(`Engine hot path`);
  console.log(`  ${hands.toLocaleString()} hands · ${commands.toLocaleString()} commands in ${elapsed.toFixed(0)} ms`);
  console.log(`  ${((elapsed * 1000) / hands).toFixed(0)} µs per hand · ${((elapsed * 1000) / commands).toFixed(0)} µs per command`);
  console.log(`  shoe reshuffled ${state.shoe.shuffleNumber} times`);
}

/**
 * Peak heap across a practice-length session.
 *
 * NODE's heap, not a device's memory. What it can genuinely show is a LEAK —
 * heap that grows without bound as hands accumulate — which is the failure
 * mode worth catching here, because the engine returns new state per command
 * and a retained reference to every prior state would look exactly like this.
 */
function benchmarkMemory(hands: number): void {
  const random = new SeededTestRandomSource(20260822);
  const context: CommandContext = { random };
  let state = fresh();

  global.gc?.();
  const before = process.memoryUsage().heapUsed;

  for (let i = 0; i < hands; i += 1) {
    const played = playHand(state, context);
    state = beginNextHand(played.state, context).state;
  }

  global.gc?.();
  const after = process.memoryUsage().heapUsed;
  const deltaKb = (after - before) / 1024;

  console.log(`\nMemory over ${hands} hands (Node heap, not device RSS)`);
  console.log(`  before ${(before / 1024 / 1024).toFixed(1)} MB · after ${(after / 1024 / 1024).toFixed(1)} MB · delta ${deltaKb >= 0 ? "+" : ""}${deltaKb.toFixed(0)} KB`);
  console.log(`  ${global.gc ? "with --expose-gc" : "WITHOUT --expose-gc: run `node --expose-gc` for a settled figure"}`);
}

/**
 * The deal's timing budget.
 *
 * Not a frame measurement — see the file header. This states the arithmetic:
 * the last of four staggered cards starts at 3 × stagger and runs for one
 * card duration, so the whole deal occupies a known wall-clock window, and
 * every frame in it has a fixed budget at 60 Hz.
 */
function reportAnimationBudget(): void {
  const cards = 4;
  const lastStart = (cards - 1) * durations.cardStagger;
  const total = lastStart + durations.cardDeal;
  const frames = total / (1000 / 60);

  console.log(`\nFour-card deal timing budget (configured, not measured on a GPU)`);
  console.log(`  stagger ${durations.cardStagger} ms · per-card ${durations.cardDeal} ms`);
  console.log(`  last card starts at ${lastStart} ms, deal completes at ${total} ms`);
  console.log(`  ${total} ms is ${frames.toFixed(0)} frames at 60 Hz (16.67 ms each)`);
  console.log(`  settlement rest: resultHold ${durations.resultHold} ms · feedbackHold ${durations.feedbackHold} ms`);
}

benchmarkEngine(5_000);
benchmarkMemory(50);
reportAnimationBudget();
