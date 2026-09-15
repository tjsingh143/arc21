import { describe, expect, it } from "vitest";

import {
  describeDealerUpCardForAnnouncement,
  describeOutcomeForAnnouncement,
  YOUR_TURN_ANNOUNCEMENT,
} from "../../src/features/table/outcome-announcement.js";

describe("accessibility announcement text", () => {
  it("names a win with the chip delta", () => {
    expect(describeOutcomeForAnnouncement("BLACKJACK", 150)).toBe("Blackjack. You won 150 chips.");
    expect(describeOutcomeForAnnouncement("WIN", 100)).toBe("Win. You won 100 chips.");
  });

  it("names a loss with the chip delta as a positive amount", () => {
    expect(describeOutcomeForAnnouncement("BUST", -100)).toBe("Bust. You lost 100 chips.");
    expect(describeOutcomeForAnnouncement("LOSS", -50)).toBe("Loss. You lost 50 chips.");
  });

  it("names a push and a full surrender with no chip figure", () => {
    expect(describeOutcomeForAnnouncement("PUSH", 0)).toBe("Push.");
    expect(describeOutcomeForAnnouncement("SURRENDER", -50)).toBe("Surrender. You lost 50 chips.");
  });

  it("announces the dealer's up-card by spoken rank, not a digit", () => {
    expect(describeDealerUpCardForAnnouncement("Six")).toBe("Dealer shows Six.");
  });

  it("has a fixed turn announcement", () => {
    expect(YOUR_TURN_ANNOUNCEMENT).toBe("Your turn.");
  });
});
