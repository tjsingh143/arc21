/**
 * The wallet view.
 *
 * The rule this file enforces is that there are four different ways to have no
 * balance — no server configured, nobody signed in, the server unreachable, the
 * row unreadable — and every one of them must be a sentence rather than a `0`.
 *
 * A rendered zero is a *claim* about someone's chips. It is the single wrong
 * answer that looks exactly like a right one, and it is what a wallet screen
 * shows by default if nobody thinks about the empty states.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { setSupabaseAvailabilityForTests } from "../../src/lib/supabase/client.js";
import {
  selectBalance,
  selectRecoveryGrant,
  setWalletGateway,
  useWalletStore,
} from "../../src/features/wallet/wallet-store.js";
import type {
  WalletFetchOutcome,
  WalletGateway,
} from "../../src/features/wallet/wallet-gateway.js";
import {
  toLedgerEntries,
  toWalletSnapshot,
  type WalletSnapshot,
} from "../../src/features/wallet/wallet.js";

const NOW = new Date("2026-08-15T12:00:00.000Z");

const WALLET: WalletSnapshot = {
  balance: 1_500,
  lifetimeCredited: 10_000,
  lifetimeDebited: 8_500,
  version: 7,
  updatedAt: "2026-08-15T11:00:00.000Z",
};

function gateway(outcome: WalletFetchOutcome): WalletGateway {
  return {
    kind: "fake",
    fetch: async () => outcome,
    claimRecoveryGrant: async () => ({
      ok: false,
      reason: "refused",
      message: "the grant path is exercised in its own tests",
    }),
  };
}

beforeEach(() => {
  setSupabaseAvailabilityForTests(null);
  setWalletGateway(null);
  useWalletStore.setState({ status: { kind: "idle" } });
});

describe("row validation", () => {
  it("accepts a well-formed wallet row", () => {
    expect(
      toWalletSnapshot({
        id: "w",
        user_id: "u",
        balance: 1_500,
        lifetime_credited: 10_000,
        lifetime_debited: 8_500,
        version: 7,
        updated_at: "2026-08-15T11:00:00.000Z",
      }),
    ).toEqual(WALLET);
  });

  it.each([
    ["a fractional balance", { balance: 1_500.5 }],
    ["a negative balance", { balance: -1 }],
    ["a string balance", { balance: "1500" }],
    ["a missing balance", { balance: undefined }],
  ])("rejects %s rather than rendering it", (_label, override) => {
    // No floating point may reach a balance, and a malformed row must not be
    // silently coerced into a number the player will read as theirs.
    expect(
      toWalletSnapshot({
        id: "w",
        user_id: "u",
        lifetime_credited: 0,
        lifetime_debited: 0,
        version: 0,
        updated_at: "2026-08-15T11:00:00.000Z",
        ...override,
      }),
    ).toBeNull();
  });

  it("drops unreadable ledger rows and counts them", () => {
    const { entries, dropped } = toLedgerEntries([
      {
        id: "a",
        user_id: "u",
        delta: -500,
        balance_after: 1_500,
        reason: "table_buy_in",
        reference_type: null,
        reference_id: null,
        created_at: "2026-08-15T11:00:00.000Z",
      },
      // A zero delta records nothing, and the database forbids it.
      {
        id: "b",
        user_id: "u",
        delta: 0,
        balance_after: 1_500,
        reason: "correction",
        reference_type: null,
        reference_id: null,
        created_at: "2026-08-15T11:00:00.000Z",
      },
      { id: "c", reason: "not_a_reason" },
    ]);

    expect(entries).toHaveLength(1);
    expect(dropped).toBe(2);
  });
});

describe("states with no balance", () => {
  it("says so when this build has no server", async () => {
    setWalletGateway(
      gateway({ ok: false, reason: "not-configured", message: "No server in this build." }),
    );

    await useWalletStore.getState().refresh();

    const { status } = useWalletStore.getState();
    expect(status.kind).toBe("not-configured");
    expect(selectBalance(status)).toBeNull();
  });

  it("treats a guest as signed out, not as broke", async () => {
    setWalletGateway(gateway({ ok: false, reason: "signed-out", message: "Sign in to see chips." }));

    await useWalletStore.getState().refresh();

    const { status } = useWalletStore.getState();
    expect(status.kind).toBe("signed-out");
    expect(selectBalance(status)).toBeNull();
  });

  it("says the server is unreachable rather than showing zero", async () => {
    setWalletGateway(gateway({ ok: false, reason: "unreachable", message: "Could not reach." }));

    await useWalletStore.getState().refresh();

    const { status } = useWalletStore.getState();
    expect(status.kind).toBe("unavailable");
    expect(selectBalance(status)).toBeNull();
  });

  it("says the row was unreadable rather than showing zero", async () => {
    setWalletGateway(gateway({ ok: false, reason: "unreadable", message: "Unreadable." }));

    await useWalletStore.getState().refresh();

    expect(useWalletStore.getState().status.kind).toBe("unavailable");
  });

  it("survives a gateway that throws", async () => {
    setWalletGateway({
      kind: "fake",
    claimRecoveryGrant: async () => ({
      ok: false as const,
      reason: "refused" as const,
      message: "not exercised here",
    }),
      fetch: () => Promise.reject(new Error("boom")),
    });

    await expect(useWalletStore.getState().refresh()).resolves.toBeUndefined();

    expect(useWalletStore.getState().status.kind).toBe("unavailable");
  });

  it("reports no balance before anything has been fetched", () => {
    expect(selectBalance({ kind: "idle" })).toBeNull();
    expect(selectBalance({ kind: "loading" })).toBeNull();
  });
});

describe("a successful read", () => {
  it("exposes the balance and the history", async () => {
    setWalletGateway(
      gateway({ ok: true, wallet: WALLET, entries: [], dropped: 0, lastGrantAt: null }),
    );

    await useWalletStore.getState().refresh();

    const { status } = useWalletStore.getState();
    expect(status.kind).toBe("ready");
    expect(selectBalance(status)).toBe(1_500);
  });

  it("drops the cached balance on clear, so no number outlives a session", async () => {
    setWalletGateway(
      gateway({ ok: true, wallet: WALLET, entries: [], dropped: 0, lastGrantAt: null }),
    );
    await useWalletStore.getState().refresh();

    useWalletStore.getState().clear();

    expect(selectBalance(useWalletStore.getState().status)).toBeNull();
  });
});

describe("recovery grant, from the store's view", () => {
  it("is offered below the threshold with no prior grant", async () => {
    setWalletGateway(
      gateway({ ok: true, wallet: WALLET, entries: [], dropped: 0, lastGrantAt: null }),
    );
    await useWalletStore.getState().refresh();

    expect(selectRecoveryGrant(useWalletStore.getState().status, NOW)?.eligible).toBe(true);
  });

  it("is withheld while the cooldown runs", async () => {
    setWalletGateway(
      gateway({
        ok: true,
        wallet: WALLET,
        entries: [],
        dropped: 0,
        lastGrantAt: new Date(NOW.getTime() - 60 * 60 * 1_000),
      }),
    );
    await useWalletStore.getState().refresh();

    const eligibility = selectRecoveryGrant(useWalletStore.getState().status, NOW);
    expect(eligibility?.eligible).toBe(false);
    expect(eligibility?.blockedBy).toEqual(["COOLDOWN"]);
  });

  it("claims nothing when there is no balance to judge", () => {
    // An unknown balance must not become an eligibility claim in either
    // direction.
    expect(selectRecoveryGrant({ kind: "idle" }, NOW)).toBeNull();
    expect(selectRecoveryGrant({ kind: "signed-out", message: "" }, NOW)).toBeNull();
  });
});
