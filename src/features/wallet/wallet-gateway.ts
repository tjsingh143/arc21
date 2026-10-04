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
import { bindCurrentPlayer, sentAs, type BoundPlayer } from "../../lib/supabase/player-binding.js";
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
  | "unreadable"
  /** The app moved to another player before this was sent. See `stale-identity` below. */
  | "stale-identity";

/**
 * What a refused player binding is, in wallet terms.
 *
 * Narrower than either outcome's own union so it is assignable to BOTH: the
 * binding happens before a read or a write is distinguishable, and it cannot
 * answer `unreadable` or `refused` because nothing was read or asked.
 */
type WalletBindingFailure = {
  readonly ok: false;
  readonly reason: "unreachable" | "signed-out" | "stale-identity";
  readonly message: string;
};

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
      /**
       * `refused` means the server judged the player ineligible. `stale-identity`
       * means the app moved to another player while this was being prepared, so
       * nothing was asked for and no wallet moved — a grant credited to whoever
       * signed in next would be chips nobody earned.
       */
      readonly reason:
        | "refused"
        | "unreachable"
        | "signed-out"
        | "not-configured"
        | "stale-identity";
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

  /**
   * The player this call belongs to, or the stated reason there is none.
   *
   * Called as the FIRST statement of both methods, so the scope it captures is
   * the caller's. The grant is why this is not merely an "is anybody signed in"
   * check: `claim_recovery_grant()` names no player and moves chips, so a session
   * read held across a sign-in would credit the REPLACEMENT player's wallet and
   * spend their cooldown. See `player-binding.ts`.
   */
  async function bindPlayer(): Promise<{ readonly ok: true; readonly player: BoundPlayer } | WalletBindingFailure> {
    const binding = await bindCurrentPlayer(client, timeoutMs);
    if (binding.ok) return binding;
    switch (binding.reason) {
      case "unreachable":
        return { ok: false, reason: "unreachable", message: UNREACHABLE };
      case "signed-out":
        return { ok: false, reason: "signed-out", message: SIGNED_OUT };
      default:
        return { ok: false, reason: "stale-identity", message: STALE_IDENTITY };
    }
  }

  return {
    kind: "supabase",

    async fetch(): Promise<WalletFetchOutcome> {
      const bound = await bindPlayer();
      if (!bound.ok) return bound;

      const walletResult = await bounded(
        sentAs(
          client
            .from("wallets")
            .select("id, user_id, balance, lifetime_credited, lifetime_debited, version, updated_at")
            .maybeSingle(),
          bound.player,
        ),
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
        sentAs(
          client
            .from("wallet_ledger")
            .select(
              "id, user_id, delta, balance_after, reason, reference_type, reference_id, created_at",
            )
            .order("created_at", { ascending: false })
            .limit(LEDGER_PAGE_SIZE),
          bound.player,
        ),
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
        sentAs(
          client
            .from("wallet_ledger")
            .select("created_at")
            .eq("reason", RECOVERY_GRANT_REASON)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          bound.player,
        ),
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
      const bound = await bindPlayer();
      if (!bound.ok) return bound;
      // The last gate before chips move. A check made earlier is not a check
      // made now.
      if (!bound.player.isCurrent()) {
        return { ok: false, reason: "stale-identity", message: STALE_IDENTITY };
      }

      const result = await bounded(sentAs(client.rpc("claim_recovery_grant"), bound.player));
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
const SIGNED_OUT = "Connect to see your chips. Practice chips are separate and stay on this device.";
const UNREADABLE = "Your wallet could not be read. Nothing has been changed.";
/*
 * Nothing was asked for and no chips moved, for either player. That is the whole
 * of what this sentence may claim.
 */
const STALE_IDENTITY =
  "You are signed in as a different player now, so that was not sent. Nothing has been changed.";
const GRANT_APPLIED_UNREADABLE =
  "Your chips were restored, but the new balance could not be read back. Reopen this screen to see it.";
