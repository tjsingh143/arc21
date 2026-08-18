/**
 * Arc 21 — reading the wallet.
 *
 * Two methods, and neither one takes an amount. There is deliberately no
 * `credit`, no `debit` and no `apply`: the interface is the client's entire
 * vocabulary for talking about chips, and it can only ask.
 *
 * `claimRecoveryGrant` is an ask, not a write. It sends no arguments — the
 * server decides eligibility from the locked balance and computes the top-up
 * itself — so there is still no path by which client code names a number of
 * chips.
 *
 * That is not the security control — the database is, four ways over — but it is
 * the thing that makes the security control legible. A reviewer reading this
 * file can see in ten seconds that no client code path writes a balance, without
 * having to trace every call site.
 *
 * Note what the queries do NOT do: none of them filters by a user id. Row Level
 * Security scopes `wallets` and `wallet_ledger` to `auth.uid()`, so an unfiltered
 * `select` returns exactly the caller's own rows. Passing a client-held id would
 * add nothing except a second, weaker place for identity to come from — and
 * identity comes from the verified session, never from the client.
 */

import type { ArcSupabaseClient } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import { RECOVERY_GRANT_REASON } from "./recovery-grant.js";
import {
  toLedgerEntries,
  toWalletSnapshot,
  type LedgerEntry,
  type WalletSnapshot,
} from "./wallet.js";

/** Enough history to explain the current balance without paging. */
export const LEDGER_PAGE_SIZE = 25;

export type WalletFetchFailureReason =
  | "not-configured"
  | "signed-out"
  | "unreachable"
  | "unreadable";

export type WalletFetchOutcome =
  | {
      readonly ok: true;
      readonly wallet: WalletSnapshot;
      readonly entries: readonly LedgerEntry[];
      /** Rows that failed validation and were not rendered. */
      readonly dropped: number;
      /** Most recent recovery grant, for the eligibility display. */
      readonly lastGrantAt: Date | null;
    }
  | {
      readonly ok: false;
      readonly reason: WalletFetchFailureReason;
      readonly message: string;
    };

/** What came back from asking for a Recovery Grant. */
export type RecoveryGrantOutcome =
  | { readonly ok: true; readonly balance: number }
  | {
      readonly ok: false;
      /** `refused` means the server judged the player ineligible. */
      readonly reason: "refused" | "unreachable" | "signed-out" | "not-configured";
      readonly message: string;
    };

export interface WalletGateway {
  readonly kind: "supabase" | "unconfigured" | "fake";
  fetch(): Promise<WalletFetchOutcome>;
  claimRecoveryGrant(): Promise<RecoveryGrantOutcome>;
}

export function createUnconfiguredWalletGateway(message: string): WalletGateway {
  return {
    kind: "unconfigured",
    fetch: async () => ({ ok: false, reason: "not-configured", message }),
    claimRecoveryGrant: async () => ({ ok: false, reason: "not-configured", message }),
  };
}

export function createSupabaseWalletGateway(
  client: ArcSupabaseClient,
  options: { readonly timeoutMs?: number } = {},
): WalletGateway {
  const { timeoutMs } = options;

  async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
    const result = await withTimeout(Promise.resolve(work), timeoutMs);
    return isTimedOut(result) ? null : result;
  }

  return {
    kind: "supabase",

    async fetch(): Promise<WalletFetchOutcome> {
      const session = await bounded(client.auth.getSession());
      if (session === null) {
        return { ok: false, reason: "unreachable", message: UNREACHABLE };
      }
      if (session.data.session === null) {
        return { ok: false, reason: "signed-out", message: SIGNED_OUT };
      }

      const walletResult = await bounded(
        client
          .from("wallets")
          .select("id, user_id, balance, lifetime_credited, lifetime_debited, version, updated_at")
          .maybeSingle(),
      );
      if (walletResult === null) {
        return { ok: false, reason: "unreachable", message: UNREACHABLE };
      }
      if (walletResult.error) {
        return { ok: false, reason: "unreachable", message: UNREACHABLE };
      }

      const wallet = toWalletSnapshot(walletResult.data);
      if (wallet === null) {
        // Either there is no row, or the row is not a wallet. Both are reported
        // as unreadable rather than displayed as a zero balance.
        return { ok: false, reason: "unreadable", message: UNREADABLE };
      }

      const ledgerResult = await bounded(
        client
          .from("wallet_ledger")
          .select(
            "id, user_id, delta, balance_after, reason, reference_type, reference_id, created_at",
          )
          .order("created_at", { ascending: false })
          .limit(LEDGER_PAGE_SIZE),
      );

      // History is supporting detail. A balance that read cleanly is still worth
      // showing when the history behind it did not arrive.
      const ledger =
        ledgerResult === null || ledgerResult.error
          ? { entries: [] as readonly LedgerEntry[], dropped: 0 }
          : toLedgerEntries(ledgerResult.data ?? []);

      /*
       * The last grant is queried separately rather than scanned out of the page
       * above. A player with more than `LEDGER_PAGE_SIZE` entries since their
       * last grant would otherwise look like someone who had never had one, and
       * the screen would offer a grant the server is about to refuse.
       */
      const grantResult = await bounded(
        client
          .from("wallet_ledger")
          .select("created_at")
          .eq("reason", RECOVERY_GRANT_REASON)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      );

      const lastGrantIso =
        grantResult === null || grantResult.error
          ? null
          : ((grantResult.data as { created_at?: unknown } | null)?.created_at ?? null);
      const lastGrantMs = typeof lastGrantIso === "string" ? Date.parse(lastGrantIso) : Number.NaN;

      return {
        ok: true,
        wallet,
        entries: ledger.entries,
        dropped: ledger.dropped,
        lastGrantAt: Number.isFinite(lastGrantMs) ? new Date(lastGrantMs) : null,
      };
    },

    /**
     * Ask the server for a Recovery Grant.
     *
     * Note the call takes no arguments at all — not a user id, not a balance,
     * not an amount. `claim_recovery_grant()` reads the caller's identity from
     * the verified session, locks the wallet, checks the threshold and the
     * twelve-hour cooldown, and computes the top-up itself. A refusal here is
     * the server's judgement, and the eligibility shown on screen is only ever
     * a prediction of it.
     */
    async claimRecoveryGrant(): Promise<RecoveryGrantOutcome> {
      const session = await bounded(client.auth.getSession());
      if (session === null) {
        return { ok: false, reason: "unreachable", message: UNREACHABLE };
      }
      if (!session.data.session) {
        return { ok: false, reason: "signed-out", message: SIGNED_OUT };
      }

      const result = await bounded(client.rpc("claim_recovery_grant"));
      if (result === null) {
        return { ok: false, reason: "unreachable", message: UNREACHABLE };
      }
      if (result.error) {
        // The server states its own reason — an expired cooldown or a balance
        // above the threshold — and it is more accurate than anything this
        // screen could infer, so it is shown rather than replaced.
        return { ok: false, reason: "refused", message: result.error.message };
      }

      const balance = (result.data as { balance_after?: unknown } | null)?.balance_after;
      if (typeof balance !== "number") {
        // The grant was applied; only the echo is unreadable. Say so honestly
        // rather than reporting a balance this code invented.
        return { ok: false, reason: "unreachable", message: GRANT_APPLIED_UNREADABLE };
      }
      return { ok: true, balance };
    },
  };
}

const UNREACHABLE = "Could not reach the server, so your chips are not shown.";
const SIGNED_OUT = "Sign in to see your chips. Practice chips are separate and stay on this device.";
const UNREADABLE = "Your wallet could not be read. Nothing has been changed.";
const GRANT_APPLIED_UNREADABLE =
  "Your chips were restored, but the new balance could not be read back. Reopen this screen to see it.";
