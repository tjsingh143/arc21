import { afterEach, describe, expect, it, vi } from "vitest";

import { resetPlayerState } from "../../src/features/player/reset-player-state.js";
import { setWalletGateway, useWalletStore } from "../../src/features/wallet/wallet-store.js";
import { useCareerServerStore } from "../../src/features/career/career-server-store.js";
import { useNotificationsStore } from "../../src/features/notifications/notifications-store.js";
import type { WalletFetchOutcome, WalletGateway } from "../../src/features/wallet/wallet-gateway.js";
import { useAccountProfileStore } from "../../src/features/auth/account-profile-store.js";
import { useAuthStore } from "../../src/features/auth/auth-store.js";
import { setSupabaseAvailabilityForTests, type ArcSupabaseClient } from "../../src/lib/supabase/client.js";
import { setFriendsGateway, useFriendsStore } from "../../src/features/friends/friends-store.js";
import type { FriendsGateway, RelationshipOutcome } from "../../src/features/friends/friends-gateway.js";

const wallet = (balance: number): WalletFetchOutcome => ({
  ok: true,
  wallet: { balance, lifetimeCredited: balance, lifetimeDebited: 0, version: 1, updatedAt: "2026-09-15T00:00:00Z" },
  entries: [], dropped: 0, lastGrantAt: null,
});

afterEach(() => {
  resetPlayerState();
  setWalletGateway(null);
  setFriendsGateway(null);
  setSupabaseAvailabilityForTests(null);
  useAccountProfileStore.getState().clear();
  useAuthStore.setState({ session: null });
});

describe("player-scoped server caches", () => {
  it("does not report an old friendship acceptance as a new player's success", async () => {
    let finish!: (value: RelationshipOutcome) => void;
    const reply = new Promise<RelationshipOutcome>((resolve) => { finish = resolve; });
    const load = vi.fn();
    setFriendsGateway({ kind: "fake", acceptRequest: () => reply, load } as unknown as FriendsGateway);
    const pending = useFriendsStore.getState().acceptRequest("friend-of-old-player");
    resetPlayerState();
    finish({ ok: true, relationship: "friends" });
    expect(await pending).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(useFriendsStore.getState().pending).toBeNull();
  });

  it("uses the confirmed profile handle across identity screens, without adopting a late old-player reply", async () => {
    const session = (userId: string) => ({ account: { userId, username: "old_handle", email: null, emailConfirmed: false, isAnonymous: true, pendingEmail: null }, expiresAt: 2_000_000_000 });
    const row = { id: "player-a", username: "confirmed_handle", display_name: "Presentation" };
    let response = Promise.resolve({ data: row, error: null });
    const client = {
      auth: { getSession: async () => ({ data: { session: { user: { id: "player-a" } } } }) },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => response }) }) }),
    } as unknown as ArcSupabaseClient;
    setSupabaseAvailabilityForTests({ status: "ready", client });
    useAuthStore.setState({ session: session("player-a") });
    await useAccountProfileStore.getState().load();
    expect(useAuthStore.getState().session?.account.username).toBe("confirmed_handle");

    let finish!: (value: { data: typeof row; error: null }) => void;
    response = new Promise((resolve) => { finish = resolve; });
    const pending = useAccountProfileStore.getState().load();
    resetPlayerState();
    useAccountProfileStore.getState().clear();
    useAuthStore.setState({ session: session("player-b") });
    finish({ data: row, error: null });
    await pending;
    expect(useAccountProfileStore.getState().profile).toBeNull();
    expect(useAuthStore.getState().session?.account.username).toBe("old_handle");
    expect(useAuthStore.getState().session?.account.userId).toBe("player-b");
  });

  it("cannot restore the previous player's wallet after a delayed response", async () => {
    let resolveOld!: (value: WalletFetchOutcome) => void;
    const oldReply = new Promise<WalletFetchOutcome>((resolve) => { resolveOld = resolve; });
    setWalletGateway({ kind: "fake", fetch: () => oldReply } as WalletGateway);
    const oldRead = useWalletStore.getState().refresh();

    resetPlayerState();
    setWalletGateway({ kind: "fake", fetch: async () => wallet(25_000) } as WalletGateway);
    await useWalletStore.getState().refresh();
    resolveOld(wallet(99_999));
    await oldRead;

    const state = useWalletStore.getState().status;
    expect(state.kind === "ready" && state.wallet.balance).toBe(25_000);
  });

  it("clears server progression and notification counts at an identity boundary", () => {
    useCareerServerStore.setState({ progress: { old: { stars: 3, attempts: 7, completed: true, rewardClaimed: true } }, loaded: true });
    useNotificationsStore.setState({ unread: 4, busy: true });
    resetPlayerState();
    expect(useCareerServerStore.getState().progress).toEqual({});
    expect(useCareerServerStore.getState().loaded).toBe(false);
    expect(useNotificationsStore.getState().unread).toBe(0);
    expect(useNotificationsStore.getState().busy).toBe(false);
  });
});
