/**
 * "Offline" must mean the server did not answer, not that a library said so.
 *
 * There was no connectivity signal in the app at all, so the offline states the
 * specification asks for — "Quick Play online CTA becomes Practice",
 * "Social/leaderboard cards show offline state", "show cached profile with an
 * Offline badge" — had nothing to drive them.
 *
 * The signal is deliberately NOT `expo-network` or NetInfo. Both answer "is
 * there a network interface", which is the wrong question: a phone on a
 * captive-portal wifi has one and cannot reach Arc 21, so the banner would say
 * the opposite of the truth exactly when it matters.
 *
 * These are the boundaries that decide whether a player is told they are
 * offline. Getting either wrong is a lie in one direction or the other.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  OFFLINE_AFTER_FAILURES,
  useConnectivityStore,
} from "../../src/lib/connectivity/connectivity-store.js";
import { isTimedOut, withTimeout } from "../../src/lib/supabase/with-timeout.js";

beforeEach(() => {
  useConnectivityStore.getState().reset();
});

const status = () => useConnectivityStore.getState().status;

describe("what counts as offline", () => {
  it("starts unknown, so a cold launch into Practice shows nothing", () => {
    // Not "online" and not "offline": nothing has been asked yet, and asserting
    // either would be a claim the app has not earned.
    expect(status()).toBe("unknown");
  });

  it("does not cry offline on a single failure", () => {
    // One timeout is a hiccup. Flashing a banner at somebody whose connection
    // is fine teaches them to ignore it.
    useConnectivityStore.getState().report(false);
    expect(status()).not.toBe("offline");
  });

  it("says offline on the second consecutive failure", () => {
    for (let i = 0; i < OFFLINE_AFTER_FAILURES; i += 1) {
      useConnectivityStore.getState().report(false);
    }
    expect(status()).toBe("offline");
  });

  it("comes back on a single success", () => {
    for (let i = 0; i < OFFLINE_AFTER_FAILURES; i += 1) {
      useConnectivityStore.getState().report(false);
    }
    useConnectivityStore.getState().report(true);
    // One good answer is enough. Requiring two would leave the banner up while
    // the app was plainly working.
    expect(status()).toBe("online");
    expect(useConnectivityStore.getState().consecutiveFailures).toBe(0);
  });

  it("resets the failure run, so two failures an hour apart are not an outage", () => {
    useConnectivityStore.getState().report(false);
    useConnectivityStore.getState().report(true);
    useConnectivityStore.getState().report(false);
    expect(status()).toBe("online");
  });

  it("records when the last answer arrived", () => {
    useConnectivityStore.getState().report(true, 1_700_000_000_000);
    expect(useConnectivityStore.getState().lastReachableAt).toBe(1_700_000_000_000);
  });
});

describe("what withTimeout reports", () => {
  it("reports reachable when the server answers at all", async () => {
    // A REFUSAL is an answer. A 403, a 409, a rate limit — the server was
    // reached, and treating those as an outage would put "you are offline" in
    // front of a player who is plainly not.
    const refusal = { error: { message: "forbidden" }, data: null };
    expect(await withTimeout(Promise.resolve(refusal), 1_000)).toBe(refusal);
    expect(status()).toBe("online");
  });

  it("reports unreachable when nothing answers in time", async () => {
    const stuck = new Promise<never>(() => undefined);
    expect(isTimedOut(await withTimeout(stuck, 5))).toBe(true);
    expect(useConnectivityStore.getState().consecutiveFailures).toBe(1);
  });

  it("reports unreachable on a transport failure, and still throws", async () => {
    await expect(withTimeout(Promise.reject(new Error("network down")), 1_000)).rejects.toThrow(
      "network down",
    );
    // The caller's own catch must still see it: swallowing the rejection here
    // would turn a crash into a silent no-op.
    expect(useConnectivityStore.getState().consecutiveFailures).toBe(1);
  });

  it("two dead requests put the app offline through the real path", async () => {
    const stuck = () => new Promise<never>(() => undefined);
    await withTimeout(stuck(), 5);
    await withTimeout(stuck(), 5);
    expect(status()).toBe("offline");
  });
});
