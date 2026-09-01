/**
 * Repeat at a career node, and the rule about WHEN a bet is remembered.
 *
 * `app/career/play/[slug].tsx` passed `BettingBar` a literal `lastBet={0}` and
 * an empty `onRepeat`, so the control was drawn permanently disabled at all 18
 * nodes — the same defect the online table carried, in the second of the three
 * tables that deal cards. A career node is ten to twenty hands at one stake,
 * which is exactly where repeating a bet earns its place.
 *
 * The store had NO tests at all before this file. These cover the behaviour the
 * fix introduced, and one thing the first version of it got wrong: `lastBet`
 * was recorded before the engine had accepted the lock, and `dispatch` swallows
 * an `EngineError` into `error` while leaving `game` untouched — so a refused
 * lock would have left Repeat offering an amount the engine had just refused.
 *
 * This drives the REAL store against the REAL engine. Career deals from an
 * ordinary fair shoe, so nothing here asserts a card.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  CAREER_SEAT_ID,
  useCareerSessionStore,
} from "../../src/features/career/career-session-store.js";
import { careerNodeBySlug, maxWagerForNode, CAREER_RULES } from "../../shared/career/nodes.js";

/** The first node: a standard dealt table, not a drill. */
const SLUG = "first-deal";

beforeEach(() => {
  useCareerSessionStore.getState().abandon();
});

describe("the node this file drives", () => {
  it("exists and is a dealt table rather than a drill", () => {
    // A drill node has no betting bar at all, so it could not exercise any of
    // this — and a slug that stopped existing would make every test below pass
    // vacuously against a null session.
    const node = careerNodeBySlug(SLUG);
    expect(node, `career node "${SLUG}" has been renamed or removed`).not.toBeNull();
    expect(node?.format).toBe("standard");
  });
});

describe("what a fresh session remembers", () => {
  it("remembers nothing, so Repeat cannot be offered", () => {
    useCareerSessionStore.getState().start(SLUG);
    expect(useCareerSessionStore.getState().lastBet).toBe(0);
  });

  it("does nothing when asked to repeat with no history", () => {
    useCareerSessionStore.getState().start(SLUG);
    useCareerSessionStore.getState().repeatBet();
    expect(useCareerSessionStore.getState().stagedBet).toBe(0);
  });
});

describe("after a hand is dealt", () => {
  it("remembers the wager that was locked", () => {
    const store = useCareerSessionStore.getState();
    store.start(SLUG);
    store.addChip(50);
    store.lockBet();

    expect(useCareerSessionStore.getState().lastBet).toBe(50);
  });

  it("offers it again for the next hand, staged and not committed", () => {
    const store = useCareerSessionStore.getState();
    store.start(SLUG);
    store.addChip(50);
    store.lockBet();

    /*
     * Play the hand out and start the next one.
     *
     * ANSWERING THE INSURANCE OFFER IS NOT OPTIONAL HERE. `lockBet` completes
     * the betting round, so its cascade deals — and when the dealer's upcard is
     * an ACE it stops at INSURANCE_OFFER, because only a player can answer
     * that. The first version of this went straight to STAND, which the engine
     * correctly refused at that phase, and `nextHand` was refused after it: the
     * assertion below then read `expected 'INSURANCE_OFFER' to be
     * 'BETTING_OPEN'` about one run in thirteen. Declining is what the absent
     * player's default does anyway.
     *
     * After that, STAND settles this seat and the dealer plays, so the hand
     * reaches HAND_COMPLETE either way.
     */
    if (useCareerSessionStore.getState().game?.phase === "INSURANCE_OFFER") {
      useCareerSessionStore.getState().declineInsurance();
    }
    useCareerSessionStore.getState().act("STAND");
    useCareerSessionStore.getState().nextHand();

    useCareerSessionStore.getState().repeatBet();

    /*
     * STAGED. "A previous bet may be suggested next hand but not silently
     * committed" — the engine holds it as a placed bet (career's `addChip`
     * applies PLACE_BET locally, exactly as Practice does), but the hand is not
     * dealt until the player presses Deal.
     */
    expect(useCareerSessionStore.getState().stagedBet).toBe(50);
    expect(useCareerSessionStore.getState().game?.phase).toBe("BETTING_OPEN");
  });

  it("replaces whatever was staged rather than adding to it", () => {
    const store = useCareerSessionStore.getState();
    store.start(SLUG);
    store.addChip(50);
    store.lockBet();
    // Same three-way cascade as above: a dealer ace parks at INSURANCE_OFFER,
    // where STAND and NEXT_HAND are both refused.
    if (useCareerSessionStore.getState().game?.phase === "INSURANCE_OFFER") {
      useCareerSessionStore.getState().declineInsurance();
    }
    useCareerSessionStore.getState().act("STAND");
    useCareerSessionStore.getState().nextHand();

    useCareerSessionStore.getState().addChip(20);
    useCareerSessionStore.getState().repeatBet();

    // 50, not 70. Repeat means "that bet again", not "that bet on top".
    expect(useCareerSessionStore.getState().stagedBet).toBe(50);
  });
});

describe("a bet the engine did not accept", () => {
  it("is not remembered", () => {
    /*
     * THE BUG THE FIRST VERSION OF THIS FIX HAD. `lastBet` was set before
     * `dispatch`, which swallows an `EngineError` into `error` and leaves
     * `game` untouched — so a refused lock left Repeat offering an amount the
     * engine had just refused.
     *
     * The refusal is provoked honestly: `LOCK_BET` with nothing placed. The
     * store's own guard returns early on `stagedBet <= 0`, so the command is
     * sent directly to prove the STORE's rule rather than the guard's.
     */
    const store = useCareerSessionStore.getState();
    store.start(SLUG);
    store.addChip(50);
    store.lockBet();
    expect(useCareerSessionStore.getState().lastBet).toBe(50);

    /*
     * A DIFFERENT amount, so the assertion can tell the two versions apart.
     * `addChip` sets `stagedBet` before dispatching, so the staged figure moves
     * to 70 even though the engine refuses `PLACE_BET` once the hand is dealt —
     * and then `LOCK_BET` is refused too.
     *
     * With `lastBet` set BEFORE the dispatch, this leaves Repeat offering 70:
     * an amount the engine refused twice.
     */
    useCareerSessionStore.getState().addChip(20);
    expect(useCareerSessionStore.getState().stagedBet).toBe(70);

    useCareerSessionStore.getState().lockBet();
    expect(useCareerSessionStore.getState().error).not.toBeNull();

    // Still 50: the refused attempt did not overwrite the accepted one.
    expect(useCareerSessionStore.getState().lastBet).toBe(50);
  });
});

describe("the repeat is clamped by the node's own ceiling", () => {
  it("never stages more than the node allows", () => {
    /*
     * A career node can cap the wager at a percentage of the starting bankroll,
     * and `addChip` is the single place that ceiling is applied. `repeatBet`
     * clears and re-stages THROUGH it rather than carrying a copy of the rule.
     */
    const node = careerNodeBySlug(SLUG)!;
    const ceiling = Math.min(node.startingBankroll, maxWagerForNode(node, CAREER_RULES));

    const store = useCareerSessionStore.getState();
    store.start(SLUG);
    store.addChip(ceiling);
    store.lockBet();

    const remembered = useCareerSessionStore.getState().lastBet;
    expect(remembered).toBeGreaterThan(0);
    expect(remembered).toBeLessThanOrEqual(ceiling);
  });
});

describe("leaving the node", () => {
  it("forgets the last bet, because a different node is a different bankroll", () => {
    const store = useCareerSessionStore.getState();
    store.start(SLUG);
    store.addChip(50);
    store.lockBet();
    expect(useCareerSessionStore.getState().lastBet).toBe(50);

    useCareerSessionStore.getState().abandon();
    expect(useCareerSessionStore.getState().lastBet).toBe(0);

    useCareerSessionStore.getState().start(SLUG);
    expect(useCareerSessionStore.getState().lastBet).toBe(0);
  });
});

describe("the seat this store drives", () => {
  it("is the career seat, not the practice one", () => {
    // Guards a copy-paste between two stores that render the same components.
    useCareerSessionStore.getState().start(SLUG);
    expect(useCareerSessionStore.getState().game?.seats[0]?.seatId).toBe(CAREER_SEAT_ID);
  });
});
