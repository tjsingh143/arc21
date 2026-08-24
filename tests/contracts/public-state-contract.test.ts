/**
 * The wire contract and the engine's payload describe the SAME object.
 *
 * `shared/contracts/public-game-state.ts` has claimed in its own header, since
 * the day it was written, that "tests/contracts/public-state-contract.test.ts
 * asserts, at compile time and at runtime, that this schema and the engine's
 * interface describe the same object. Adding a field to one without the other
 * fails the suite."
 *
 * THAT FILE DID NOT EXIST. The claim was a description of a guard nobody had
 * written, and the cost of its absence was this:
 *
 *   `legalActionSetSchema` never named `canStartNextHand`. `z.object` STRIPS
 *   unknown keys — a narrower payload is a valid one, so there is no parse
 *   error and nothing to notice. The server sent `canStartNextHand: true` at
 *   every HAND_COMPLETE; the client parsed it away to `undefined`; and
 *   `app/table/[gameId].tsx` gates the "Next hand" button on exactly that
 *   field. So **no online table could ever start a second hand through the
 *   UI** — private, public, Quick Play, tournament or daily alike. The screen
 *   fell through to "Waiting for the next hand.", a sentence describing the
 *   thing it was itself preventing.
 *
 * It survived a 1,600-test suite because every layer was individually right.
 * The engine sets the flag. `tests/engine/next-hand.test.ts` proves it. The
 * server returns it — a script against the running stack confirms
 * `canStartNextHand: true` in both the command reply and the poll. The store's
 * `nextHand()` is unit-tested by calling it. The button exists in the JSX. The
 * only thing wrong was a schema silently deleting the field in between, and
 * nothing in the repository compared the two shapes.
 *
 * So this file compares them, in the two ways that can each catch what the
 * other misses:
 *
 *   COMPILE TIME — a contract value must be assignable to the engine type.
 *   That direction is the load-bearing one: a field missing from the schema
 *   makes the contract type too narrow, and the assignment fails. (The reverse
 *   direction does NOT catch it, because a value with extra properties is
 *   assignable to a narrower type.)
 *
 *   RUN TIME — a real engine payload is parsed through the schema and compared
 *   KEY FOR KEY at every level. This catches what the type check cannot: a
 *   field that is present in both types but whose schema entry is `.optional()`
 *   or otherwise strips at run time, and a field added to the engine that the
 *   schema has never heard of.
 */

import { describe, expect, it } from "vitest";

import { publicGameStateSchema } from "../../shared/contracts/public-game-state.js";
import type { ContractPublicGameState } from "../../shared/contracts/public-game-state.js";
import { toPublicState } from "../../shared/blackjack/public-state.js";
import type { PublicGameState } from "../../shared/blackjack/public-state.js";
import type { LegalActionSet } from "../../shared/blackjack/legal-actions.js";
import { betAndDeal, harness } from "../helpers/engine-harness.js";

/*
 * COMPILE-TIME. Not a runtime assertion — the value is never read. If the
 * contract type is missing a field the engine type requires, `tsc --noEmit`
 * fails on this line and `npm run typecheck` is a gate in CI.
 *
 * Deliberately this direction only. Engine-assignable-to-contract would pass
 * with a field missing from the schema, because TypeScript allows a wider value
 * where a narrower type is expected once it is not a fresh object literal —
 * which is precisely why the drift went unnoticed.
 */
const _contractIsAtLeastTheEngineShape: PublicGameState = null as unknown as ContractPublicGameState;
void _contractIsAtLeastTheEngineShape;

/** Same, one level down, where the field that went missing lives. */
const _legalSetIsAtLeastTheEngineShape: LegalActionSet =
  null as unknown as ContractPublicGameState["legalActions"][string];
void _legalSetIsAtLeastTheEngineShape;

/** Every key of `value`, recursively, as sorted dotted paths. Arrays use `[]`. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    // One representative element is enough: the schema is one element schema.
    return value.length === 0 ? [] : keyPaths(value[0], `${prefix}[]`);
  }
  if (value === null || typeof value !== "object") return [];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    paths.push(path);
    paths.push(...keyPaths(child, path));
  }
  return paths.sort();
}

/**
 * Four real snapshots covering every phase this contract has to carry. A
 * fixture built by hand would only ever contain the fields whoever wrote it
 * remembered — which is the failure being guarded against.
 */
function snapshots(): { phase: string; payload: PublicGameState }[] {
  const shoe = "10S 10D 6H 9C 5H";
  const betting = harness({ shoe });
  const dealt = betAndDeal(harness({ shoe }), 100);
  const settled = betAndDeal(harness({ shoe }), 100).send({ type: "STAND", seatId: "s1" });
  // An ace up, so the insurance offer is live and its fields are populated.
  const insurance = betAndDeal(harness({ shoe: "10S AD 6H 9C 5H" }), 100);

  return [
    { phase: "BETTING_OPEN", payload: toPublicState(betting.state) },
    { phase: "PLAYER_TURNS", payload: toPublicState(dealt.state) },
    { phase: "HAND_COMPLETE", payload: toPublicState(settled.state) },
    { phase: "INSURANCE_OFFER", payload: toPublicState(insurance.state) },
  ];
}

describe("the sanitised snapshot contract", () => {
  it("accepts every payload the engine actually produces", () => {
    for (const { phase, payload } of snapshots()) {
      const parsed = publicGameStateSchema.safeParse(payload);
      expect(parsed.success, `${phase}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  /**
   * THE ONE THAT WOULD HAVE CAUGHT IT. Validation passing is not the claim —
   * `z.object` strips silently and reports success. The claim is that nothing
   * was REMOVED on the way through.
   */
  it("strips nothing: every key the engine sends survives the parse", () => {
    for (const { phase, payload } of snapshots()) {
      const parsed = publicGameStateSchema.parse(payload);
      const sent = keyPaths(payload);
      const received = keyPaths(parsed);
      const dropped = sent.filter((path) => !received.includes(path));
      expect(dropped, `${phase} lost ${dropped.join(", ")}`).toEqual([]);
    }
  });

  /** And nothing invented: a schema default would be a field the server never sent. */
  it("adds nothing the engine did not send", () => {
    for (const { phase, payload } of snapshots()) {
      const parsed = publicGameStateSchema.parse(payload);
      const sent = keyPaths(payload);
      const added = keyPaths(parsed).filter((path) => !sent.includes(path));
      expect(added, `${phase} gained ${added.join(", ")}`).toEqual([]);
    }
  });

  /**
   * The specific field, named, because a general test that happens to cover a
   * specific defect is worth pinning to the defect. If `keyPaths` is ever
   * loosened, this still fails.
   */
  it("carries canStartNextHand, which gates the only way to play a second hand", () => {
    const settled = betAndDeal(harness({ shoe: "10S 10D 6H 9C 5H" }), 100).send({
      type: "STAND",
      seatId: "s1",
    });
    const payload = toPublicState(settled.state);
    expect(payload.phase).toBe("HAND_COMPLETE");
    expect(payload.legalActions.s1?.canStartNextHand).toBe(true);

    const parsed = publicGameStateSchema.parse(payload);
    // Before the fix this read `undefined`, and the button it gates was
    // therefore never rendered at any server table.
    expect(parsed.legalActions.s1?.canStartNextHand).toBe(true);
  });

  /**
   * EVERY object in this contract is strict, and this is the structural half of
   * the fix.
   *
   * Sixty-one schemas across `shared/contracts` use `z.strictObject`. Exactly
   * one used `z.object` — `legalActionSetSchema` — and that is the one that
   * deleted a field. Nothing chose the exception; it was a `strict` somebody
   * did not type.
   *
   * Asserted as BEHAVIOUR rather than by reading `_def.catchall`: an unknown key
   * must be REFUSED, not quietly dropped. A client older than its server now
   * fails loudly instead of rendering a table with a control silently missing,
   * which is the trade the rest of this directory already made and the only one
   * of the two failure modes anybody would notice.
   */
  it("refuses an unknown field rather than deleting it", () => {
    const settled = betAndDeal(harness({ shoe: "10S 10D 6H 9C 5H" }), 100).send({
      type: "STAND",
      seatId: "s1",
    });
    const payload = toPublicState(settled.state) as unknown as Record<string, unknown>;

    // One level down, where the drift happened.
    const legal = payload.legalActions as Record<string, Record<string, unknown>>;
    const widened = {
      ...payload,
      legalActions: { s1: { ...legal.s1, canDoSomethingNew: true } },
    };
    expect(publicGameStateSchema.safeParse(widened).success).toBe(false);

    // And at the top level.
    expect(publicGameStateSchema.safeParse({ ...payload, somethingNew: 1 }).success).toBe(false);
  });

  /**
   * The guard proves it discriminates rather than being assumed to work: a
   * schema that omits one field must FAIL the round-trip check above.
   */
  it("fails when a field is dropped from the schema", () => {
    const settled = betAndDeal(harness({ shoe: "10S 10D 6H 9C 5H" }), 100).send({
      type: "STAND",
      seatId: "s1",
    });
    const payload = toPublicState(settled.state);

    // Exactly what the real schema did: a `z.object` over the legal action set
    // with one key missing. It parses happily and returns less than it was given.
    const narrowed = publicGameStateSchema.parse(payload) as unknown as Record<string, unknown>;
    const legal = { ...(narrowed.legalActions as Record<string, Record<string, unknown>>).s1 };
    delete legal.canStartNextHand;
    const stripped = { ...narrowed, legalActions: { s1: legal } };

    const sent = keyPaths(payload);
    const received = keyPaths(stripped);
    expect(sent.filter((path) => !received.includes(path))).toEqual([
      "legalActions.s1.canStartNextHand",
    ]);
  });
});
