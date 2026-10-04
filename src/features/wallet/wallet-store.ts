import { playerScopedSetter } from "../player/player-scope.js";
/**
 * Arc 21 — wallet view state.
 *
 * A cache of what the server said, and a status describing why it is not there
 * when it is not. Nothing in this store mutates a balance; the only action is
 * `refresh`.
 *
 * The states matter more than the data. A wallet surface has four ways to have
 * no number — no server configured, nobody signed in, the server unreachable,
 * the row unreadable — and every one of them must be a sentence rather than a
 * zero or a spinner that never stops. A rendered `0` is a *claim* about
 * someone's chips, and it is the one wrong answer that looks exactly like a
 * right one.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import {
  createSupabaseWalletGateway,
  createUnconfiguredWalletGateway,
  type WalletGateway,
} from "./wallet-gateway.js";
import {
  evaluateRecoveryGrant,
  type RecoveryGrantEligibility,
} from "./recovery-grant.js";
import type { LedgerEntry, WalletSnapshot } from "./wallet.js";

export type WalletStatus =
  /** Nothing has been requested yet. */
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly wallet: WalletSnapshot;
      readonly entries: readonly LedgerEntry[];
      /** Ledger rows that failed validation; the screen says the list is partial. */
      readonly dropped: number;
      readonly lastGrantAt: Date | null;
      /** ISO 8601 — how stale the number on screen is. */
      readonly fetchedAt: string;
    }
  /** No server in this build. Offline play is unaffected. */
  | { readonly kind: "not-configured"; readonly message: string }
  /** A guest has no server wallet. Not an error. */
  | { readonly kind: "signed-out"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

export interface WalletStoreState {
  readonly status: WalletStatus;
  /**
   * What the last claim said, or null. Held separately from `status` because a
   * refusal is not a broken wallet — the balance on screen is still correct and
   * still worth showing.
   */
  readonly grantNotice: string | null;
  readonly claiming: boolean;
  refresh: () => Promise<void>;
  /**
   * Ask the server for a Recovery Grant.
   *
   * An ASK, not a write. It sends no amount and no balance: `claim_recovery_grant`
   * reads the caller's identity from the JWT, evaluates the identical rule
   * `evaluateRecoveryGrant` displays against authoritative state, and credits
   * under a unique idempotency key. A modified client that forced the button
   * visible gains nothing — the server refuses, and a replayed claim credits at
   * most once regardless.
   */
  claim: () => Promise<boolean>;
  /** Drops the cached balance. Called on sign-out so no number outlives a session. */
  clear: () => void;
}

let gatewayOverride: WalletGateway | null = null;

export function setWalletGateway(next: WalletGateway | null): void {
  gatewayOverride = next;
}

export function activeWalletGateway(): WalletGateway {
  if (gatewayOverride !== null) return gatewayOverride;

  const availability = getSupabase();
  if (availability.status !== "ready") {
    return createUnconfiguredWalletGateway(availability.message);
  }
  return createSupabaseWalletGateway(availability.client);
}

export const useWalletStore = create<WalletStoreState>((set, get) => ({
  status: { kind: "idle" },
  grantNotice: null,
  claiming: false,

  refresh: async () => {
    const setForPlayer = playerScopedSetter(set);
    if (get().status.kind === "loading") return;
    setForPlayer({ status: { kind: "loading" } });

    let outcome;
    try {
      outcome = await activeWalletGateway().fetch();
    } catch {
      // A gateway is not supposed to throw, but a wallet screen is not the
      // place to find out that one did.
      setForPlayer({ status: { kind: "unavailable", message: "Your chips could not be loaded." } });
      return;
    }

    if (!outcome.ok) {
      switch (outcome.reason) {
        case "not-configured":
          setForPlayer({ status: { kind: "not-configured", message: outcome.message } });
          return;
        case "signed-out":
          setForPlayer({ status: { kind: "signed-out", message: outcome.message } });
          return;
        default:
          setForPlayer({ status: { kind: "unavailable", message: outcome.message } });
          return;
      }
    }

    setForPlayer({
      status: {
        kind: "ready",
        wallet: outcome.wallet,
        entries: outcome.entries,
        dropped: outcome.dropped,
        lastGrantAt: outcome.lastGrantAt,
        fetchedAt: new Date().toISOString(),
      },
    });
  },

  claim: async () => {
    const setForPlayer = playerScopedSetter(set);
    if (get().claiming) return false;
    setForPlayer({ claiming: true, grantNotice: null });

    let outcome;
    try {
      outcome = await activeWalletGateway().claimRecoveryGrant();
    } catch {
      setForPlayer({ claiming: false, grantNotice: "The grant was not confirmed. Refresh your balance before retrying." });
      return false;
    }
    setForPlayer({ claiming: false });

    if (!outcome.ok) {
      // The server's own wording where there is one. It knows the authoritative
      // balance and the authoritative cooldown; this layer knows a cached copy
      // of both, and saying something different from the server would be worse
      // than saying nothing.
      setForPlayer({ grantNotice: outcome.message });
      return false;
    }

    // The balance moved, so everything showing it must be re-read rather than
    // patched locally — the ledger has a new row too.
    if (!setForPlayer.isCurrent()) return false;
    await get().refresh();
    setForPlayer({ grantNotice: "Recovery grant credited." });
    return setForPlayer.isCurrent();
  },

  clear: () => set({ status: { kind: "idle" }, grantNotice: null, claiming: false }),
}));

/**
 * The balance, or null when there is not one to show.
 *
 * Returning null rather than 0 is the whole point — `ScreenHeader` renders
 * "Guest" for null and a figure for a number, so an unknown balance can never
 * be painted as an empty one.
 */
export function selectBalance(status: WalletStatus): number | null {
  return status.kind === "ready" ? status.wallet.balance : null;
}

/**
 * Recovery grant eligibility for the current view, or null when there is no
 * balance to judge.
 *
 * `now` is a parameter so a screen can re-derive a countdown on a timer without
 * this module owning a clock, and so the boundaries stay testable.
 */
export function selectRecoveryGrant(
  status: WalletStatus,
  now: Date,
): RecoveryGrantEligibility | null {
  if (status.kind !== "ready") return null;
  return evaluateRecoveryGrant({
    balance: status.wallet.balance,
    lastGrantAt: status.lastGrantAt,
    now,
  });
}
