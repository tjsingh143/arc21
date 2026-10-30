/**
 * Refresh D — the held-seat card on Home belongs to the player looking at it.
 *
 * Home now asks `my_active_session()` and offers "Return to your table" above
 * everything else. The store it reads is a module-level cache, so the case that
 * matters is the account boundary: player A's lookup is still out when the
 * device's player is replaced, and A's seat answers afterwards. Driven through
 * the PRODUCTION store and the production `resetPlayerState()` (what
 * `usePlayerState` calls when the confirmed user id changes); only the gateway
 * is fake, and its reply is released by hand so the order is the test's.
 */

import { afterEach, describe, expect, it } from "vitest";

import { homeLayout, homeResume } from "../../src/features/home/product-hierarchy.js";
import { resetPlayerState } from "../../src/features/player/reset-player-state.js";
import {
  setActiveSessionGateway,
  useActiveSessionStore,
  type ActiveSessionGateway,
  type ActiveSessionOutcome,
} from "../../src/features/table/active-session-store.js";
import type { ActiveSession } from "../../src/features/table/active-session.js";

const SEAT_OF_A: ActiveSession = {
  gameId: "b3bcfb9b-8199-452b-b808-c5ce4d8b74c5",
  seatId: "41745c30-26b5-40fe-8e81-406a448c5a3c",
  mode: "solo",
  tier: "casual",
  startedAt: null,
};

/** A gateway whose next answer waits for the test. */
function heldGateway(): { gateway: ActiveSessionGateway; release: (outcome: ActiveSessionOutcome) => void } {
  let release: (outcome: ActiveSessionOutcome) => void = () => undefined;
  const gateway: ActiveSessionGateway = {
    kind: "fake",
    fetch: () =>
      new Promise<ActiveSessionOutcome>((resolve) => {
        release = resolve;
      }),
  };
  return { gateway, release: (outcome) => release(outcome) };
}

const homeFor = (playerReady: boolean) =>
  homeLayout({
    online: { kind: "ready" },
    resume: homeResume(useActiveSessionStore.getState().status, playerReady),
    hasCareer: false,
    hasMastery: false,
  });

afterEach(() => {
  setActiveSessionGateway(null);
  useActiveSessionStore.setState(useActiveSessionStore.getInitialState(), true);
});

describe("Home's held-seat card across a change of player", () => {
  it("offers the seat when the lookup answers for the same player", async () => {
    const { gateway, release } = heldGateway();
    setActiveSessionGateway(gateway);

    const pending = useActiveSessionStore.getState().refresh();
    release({ ok: true, session: SEAT_OF_A });
    await expect(pending).resolves.toEqual(SEAT_OF_A);

    expect(homeFor(true)[0]).toBe("resume");
  });

  it("never shows the previous player's seat when its answer arrives late", async () => {
    const { gateway, release } = heldGateway();
    setActiveSessionGateway(gateway);

    const pending = useActiveSessionStore.getState().refresh();
    expect(useActiveSessionStore.getState().status.kind).toBe("loading");

    // The confirmed player changes while A's lookup is out.
    resetPlayerState();
    release({ ok: true, session: SEAT_OF_A });
    await expect(pending).resolves.toBeNull();

    expect(useActiveSessionStore.getState().status).toEqual({ kind: "idle" });
    expect(homeFor(true)).not.toContain("resume");
  });

  it("reports an unreachable lookup as unknown, not as no seat", async () => {
    const { gateway, release } = heldGateway();
    setActiveSessionGateway(gateway);

    const pending = useActiveSessionStore.getState().refresh();
    release({ ok: false, reason: "unreachable" });
    await pending;

    expect(homeFor(true)[0]).toBe("resume-unknown");
  });

  it("shows nothing about a seat once the player is no longer ready", async () => {
    const { gateway, release } = heldGateway();
    setActiveSessionGateway(gateway);

    const pending = useActiveSessionStore.getState().refresh();
    release({ ok: true, session: SEAT_OF_A });
    await pending;

    // e.g. signed out, or the server stopped answering, before the reset runs.
    expect(homeFor(false)).not.toContain("resume");
    expect(homeFor(false)).not.toContain("resume-unknown");
  });
});
