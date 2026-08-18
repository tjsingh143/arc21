/**
 * Arc 21 — the wallet, read-only.
 *
 * Nothing exported here writes a balance, and nothing exported here can be
 * composed into something that does. Chips move only through
 * `public.apply_wallet_delta`, server-side.
 */

export {
  describeLedgerEntry,
  LEDGER_REASON_LABELS,
  toLedgerEntries,
  toWalletSnapshot,
  walletLedgerRowSchema,
  walletRowSchema,
  type LedgerEntry,
  type WalletSnapshot,
} from "./wallet.js";

export {
  describeRecoveryGrant,
  evaluateRecoveryGrant,
  formatTimeRemaining,
  latestGrantAt,
  RECOVERY_GRANT_COOLDOWN_MS,
  RECOVERY_GRANT_REASON,
  RECOVERY_GRANT_THRESHOLD,
  type RecoveryGrantBlocker,
  type RecoveryGrantEligibility,
  type RecoveryGrantInput,
} from "./recovery-grant.js";

export {
  createSupabaseWalletGateway,
  createUnconfiguredWalletGateway,
  LEDGER_PAGE_SIZE,
  type WalletFetchOutcome,
  type WalletGateway,
} from "./wallet-gateway.js";

export {
  activeWalletGateway,
  selectBalance,
  selectRecoveryGrant,
  setWalletGateway,
  useWalletStore,
  type WalletStatus,
  type WalletStoreState,
} from "./wallet-store.js";
