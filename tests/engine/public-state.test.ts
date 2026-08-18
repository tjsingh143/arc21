/**
 * These tests are the automated form of the product's core trust claim: a
 * client cannot see the future shoe or the dealer's hole card.
 */

import { describe, expect, it } from "vitest";

import {
  assertNoHiddenCardLeak,
  toPublicState,
} from "../../shared/blackjack/public-state.js";
import { isHiddenCard } from "../../shared/blackjack/types.js";
import { betAndDeal, harness } from "../helpers/engine-harness.js";

describe("public state sanitisation", () => {
  it("never serialises an undealt card", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C 5H" }), 100);
    const payload = toPublicState(h.state);
    expect(() => assertNoHiddenCardLeak(payload, h.state)).not.toThrow();
  });

  it("replaces the hole card with a placeholder before reveal", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C 5H" }), 100);
    const payload = toPublicState(h.state);

    expect(payload.dealer.cards).toHaveLength(2);
    expect(isHiddenCard(payload.dealer.cards[0]!)).toBe(false);
    expect(isHiddenCard(payload.dealer.cards[1]!)).toBe(true);
    expect(payload.dealer.holeCardRevealed).toBe(false);
  });

  it("shows only the face-up total before reveal", () => {
    // Dealer holds 10 up with 9 in the hole; the public total must read 10.
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C 5H" }), 100);
    expect(toPublicState(h.state).dealer.displayedTotal).toBe(10);
  });

  it("reveals the hole card and full total after the dealer plays", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C 5H" }), 100).send({
      type: "STAND",
      seatId: "s1",
    });
    const payload = toPublicState(h.state);

    expect(payload.dealer.holeCardRevealed).toBe(true);
    expect(payload.dealer.cards.every((card) => !isHiddenCard(card))).toBe(true);
    // 10 + 9 = 19: the dealer stands and never draws the 5.
    expect(payload.dealer.displayedTotal).toBe(19);
    expect(payload.dealer.cards).toHaveLength(2);
  });

  it("detects a leak if the hole card is ever included", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C 5H" }), 100);
    // Simulate a regression that widens the payload.
    const leaky = { ...toPublicState(h.state), oops: h.state.dealer.cards[1] };
    expect(() => assertNoHiddenCardLeak(leaky, h.state)).toThrow(/hole card/);
  });

  it("detects a leak if future shoe order is ever included", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C 5H" }), 100);
    const leaky = { ...toPublicState(h.state), oops: h.state.shoe.cards };
    expect(() => assertNoHiddenCardLeak(leaky, h.state)).toThrow(/undealt card/);
  });

  it("exposes player cards, which are public information at a real table", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C 5H" }), 100);
    const payload = toPublicState(h.state);
    expect(payload.seats[0]!.hands[0]!.cards).toHaveLength(2);
    expect(payload.seats[0]!.hands[0]!.total).toBe(16);
  });

  it("reports shoe progress without revealing order", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C 5H" }), 100);
    const payload = toPublicState(h.state);
    expect(payload.shoe.shuffleNumber).toBe(1);
    expect(typeof payload.shoe.approximateRemainingDecks).toBe("number");
    expect(JSON.stringify(payload.shoe)).not.toContain("id");
  });

  it("carries the monotonic version so clients can detect staleness", () => {
    const h = betAndDeal(harness({ shoe: "10S 10D 6H 9C 5H" }), 100);
    expect(toPublicState(h.state).version).toBe(h.state.version);
  });
});
