/**
 * Whether the SERVER is reachable — which is not the same as whether the radio
 * is on.
 *
 * The specification asks for offline states in several places: "Quick Play
 * online CTA becomes Practice", "Social/leaderboard cards show offline state",
 * "Offline: show cached profile with an Offline badge". There was no
 * connectivity signal of any kind in the app to drive them.
 *
 * The native network listener only triggers another identity connection after
 * connectivity returns. It does not set this status: a network interface does
 * not prove Arc 21 is reachable through a captive portal or server outage.
 *
 * What this measures instead is the thing the player actually cares about:
 * whether the last request to the server got an answer. Every remote call in
 * the app already goes through `withTimeout`, which is the one place that knows
 * — so that is where the report comes from, and no feature has to remember to
 * call anything.
 *
 * A REFUSAL IS NOT AN OUTAGE. A 403, a 409, a rate limit — all of those are the
 * server answering, and answering is being reachable. Only a timeout or a
 * transport failure moves this to `offline`.
 */

import { create } from "zustand";

export type Reachability = "unknown" | "online" | "offline";

export interface ConnectivityState {
  readonly status: Reachability;
  /**
   * When the last successful answer arrived, as an epoch millisecond value.
   * Null until one has. Screens use it for "last updated" copy.
   */
  readonly lastReachableAt: number | null;
  /**
   * Consecutive failures. One timeout is a hiccup; the banner waits for the
   * second, so a single slow request does not flash "Offline" at somebody whose
   * connection is fine.
   */
  readonly consecutiveFailures: number;

  report: (reachable: boolean, at?: number) => void;
  reset: () => void;
}

/** How many failures in a row before the app calls itself offline. */
export const OFFLINE_AFTER_FAILURES = 2;

export const useConnectivityStore = create<ConnectivityState>((set, get) => ({
  status: "unknown",
  lastReachableAt: null,
  consecutiveFailures: 0,

  report: (reachable, at = Date.now()) => {
    if (reachable) {
      // One good answer is enough to be back. Requiring two would leave the
      // banner up while the app was plainly working.
      if (get().status === "online" && get().consecutiveFailures === 0) {
        set({ lastReachableAt: at });
        return;
      }
      set({ status: "online", lastReachableAt: at, consecutiveFailures: 0 });
      return;
    }

    const failures = get().consecutiveFailures + 1;
    set({
      consecutiveFailures: failures,
      status: failures >= OFFLINE_AFTER_FAILURES ? "offline" : get().status,
    });
  },

  reset: () => set({ status: "unknown", lastReachableAt: null, consecutiveFailures: 0 }),
}));

/**
 * The report function, resolved lazily.
 *
 * `with-timeout.ts` calls this on every remote call, and importing the store
 * from there directly would put a Zustand store in the import graph of a module
 * that is otherwise pure. This keeps the dependency one-way and lets a test
 * swap it.
 */
let reporter: ((reachable: boolean) => void) | null = null;

export function setReachabilityReporter(next: ((reachable: boolean) => void) | null): void {
  reporter = next;
}

export function reportReachability(reachable: boolean): void {
  (reporter ?? ((value: boolean) => useConnectivityStore.getState().report(value)))(reachable);
}
