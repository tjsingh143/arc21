/** Drop only the response AFTER the real server committed. Exercise the shipped
 * stores and SDK, not a hand-written OPEN caller or a mocked transaction. */
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it } from "vitest";
import { stackUp } from "./stack-guard.js";
import { setSupabaseAvailabilityForTests, type ArcSupabaseClient } from "../../src/lib/supabase/client.js";
import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import { setQuickPlayStorage, useQuickPlayStore } from "../../src/features/quick-play/quick-play-store.js";
import { useMatchmakingStore } from "../../src/features/matchmaking/matchmaking-store.js";
import { useTournamentStore } from "../../src/features/tournament/tournament-store.js";
import { useWalletStore } from "../../src/features/wallet/wallet-store.js";
import { useActiveSessionStore } from "../../src/features/table/active-session-store.js";
import { useCareerServerStore } from "../../src/features/career/career-server-store.js";
import { useDailyStore } from "../../src/features/daily/daily-store.js";

const URL = "http://127.0.0.1:54321";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

// The service key is the published local-development default, never an app secret.
const ADMIN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
let client: ArcSupabaseClient | null = null;
afterEach(async () => {
  await client?.auth.signOut({ scope: "local" });
  await client?.realtime.disconnect();
  setSupabaseAvailabilityForTests(null);
  useWalletStore.getState().clear();
  useActiveSessionStore.getState().clear();
});

async function fixture(action: string, drops = 1, entryFault: "loss" | "malformed" | null = null, malformedOpen = false) {
  const email = `response-loss-${crypto.randomUUID()}@arc21.test`;
  const password = crypto.randomUUID();
  const created = await fetch(`${URL}/auth/v1/admin/users`, {
    method: "POST", headers: { apikey: ADMIN, Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  expect(created.status).toBe(200);
  const requests: string[] = [];
  const committed: Record<string, unknown>[] = [];
  const entryReads: unknown[] = [];
  const supabase = createClient(URL, ANON, {
    auth: { flowType: "pkce", persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const response = await fetch(input, init);
      const entryRpc = action === "REGISTER_SPRINT" ? "my_sprint_entry" : "my_daily_entry";
      if (entryFault && String(input).endsWith(`/rpc/${entryRpc}`)) {
        expect(response.status).toBe(200);
        entryReads.push(await response.clone().json());
        if (entryFault === "loss") throw new TypeError("Injected loss of the existing entry read");
        return new Response(JSON.stringify([{ status: "in_progress" }]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (String(input).endsWith("/functions/v1/create-session") && typeof init?.body === "string" && JSON.parse(init.body).action === action) {
        requests.push(init.body);
        expect(response.status).toBe(200);
        committed.push(await response.clone().json() as Record<string, unknown>);
        if (requests.length <= drops) throw new TypeError("Injected response loss after commit");
        if (malformedOpen) return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return response;
    } },
  }) as unknown as ArcSupabaseClient;
  client = supabase;
  const signedIn = await supabase.auth.signInWithPassword({ email, password });
  expect(signedIn.error).toBeNull();
  expect(signedIn.data.session).not.toBeNull();
  setSupabaseAvailabilityForTests({ status: "ready", client: supabase });
  setQuickPlayStorage(new MemoryKeyValueStore());
  useQuickPlayStore.setState({ opening: false, notice: null });
  useMatchmakingStore.setState({ status: { kind: "idle" }, notice: null });
  useTournamentStore.setState({ status: { kind: "loading" }, notice: null, registering: false, withdrawing: false });
  useCareerServerStore.setState({ progress: {}, loaded: false, busy: false, notice: null, drill: null, graded: null });
  useDailyStore.setState({ status: { kind: "loading" }, notice: null, starting: false });
  return { supabase, requests, committed, entryReads, restoreEntryRead: () => { entryFault = null; } };
}

async function wallet(expected: number) {
  const balance = await client!.from("wallets").select("balance").single();
  expect(balance.error).toBeNull();
  expect(Number(balance.data?.balance)).toBe(expected);
  const ledger = await client!.from("wallet_ledger").select("delta");
  expect(ledger.error).toBeNull();
  expect(ledger.data!.reduce((sum, row) => sum + Number(row.delta), 0)).toBe(expected);
}

describe.runIf(stackUp)("entry response loss through production stores", () => {
  it("recovers the existing ranked Career attempt after its opening response is lost", async () => {
    const { requests, committed } = await fixture("START_CAREER_NODE");
    const attempt = await useCareerServerStore.getState().start("first-deal");
    expect(committed).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    expect(attempt).toMatchObject({ gameId: committed[0]!.gameId, attemptId: committed[0]!.attemptId });
    expect(useCareerServerStore.getState().notice).toBeNull();
    await wallet(25_000);
  });

  it("recovers the same ranked Daily entry after its opening response is lost", async () => {
    const { requests, committed } = await fixture("START_DAILY_CHALLENGE");
    const attempt = await useDailyStore.getState().start();
    expect(committed).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    expect(attempt).toMatchObject({ gameId: committed[0]!.gameId, ranked: true });
    expect(useDailyStore.getState().notice).toBeNull();
    await wallet(25_000);
  });

  it.each(["loss", "malformed"] as const)("does not offer a fresh ranked Daily attempt after %s of its existing entry read", async (fault) => {
    const { entryReads, restoreEntryRead } = await fixture("START_DAILY_CHALLENGE", 0, fault);
    const opened = await useDailyStore.getState().start();
    expect(opened).toMatchObject({ ranked: true });
    await useDailyStore.getState().load();
    expect(entryReads).toEqual([[expect.objectContaining({ game_session_id: opened!.gameId, status: "in_progress" })]]);
    expect(useDailyStore.getState().status.kind).toBe("unavailable");
    restoreEntryRead();
    await useDailyStore.getState().load();
    expect(useDailyStore.getState().status).toMatchObject({ kind: "ready", attempt: { gameId: opened!.gameId, status: "in_progress" } });
  });

  it.each(["START_CAREER_NODE", "START_DAILY_CHALLENGE"])(
    "reconciles %s when its committed reply is malformed",
    async (action) => {
      const { committed } = await fixture(action, 0, null, true);
      const attempt = action === "START_CAREER_NODE"
        ? await useCareerServerStore.getState().start("first-deal")
        : await useDailyStore.getState().start();
      expect(attempt).toBeNull();
      expect(committed).toHaveLength(1);
      expect(useActiveSessionStore.getState().status).toMatchObject({ kind: "ready", session: { gameId: committed[0]!.gameId } });
      await wallet(25_000);
    },
  );

  it.each(["START_CAREER_NODE", "START_DAILY_CHALLENGE"])(
    "reconciles %s when both committed replies disappear",
    async (action) => {
      const { requests, committed } = await fixture(action, 2);
      const store = action === "START_CAREER_NODE" ? useCareerServerStore : useDailyStore;
      const attempt = action === "START_CAREER_NODE"
        ? await useCareerServerStore.getState().start("first-deal")
        : await useDailyStore.getState().start();
      expect(attempt).toBeNull();
      expect(requests).toHaveLength(2);
      expect(requests[1]).toBe(requests[0]);
      expect(store.getState().notice).not.toMatch(/nothing has been recorded/i);
      expect(useActiveSessionStore.getState().status).toMatchObject({ kind: "ready", session: { gameId: committed[0]!.gameId } });
      if (action === "START_DAILY_CHALLENGE") {
        expect(useDailyStore.getState().status).toMatchObject({ kind: "ready", attempt: { status: "in_progress" } });
      }
      await wallet(25_000);
    },
  );

  it("replays Quick Play with identical intent and returns the paid-for seat", async () => {
    const { requests, committed } = await fixture("OPEN");
    const seat = await useQuickPlayStore.getState().open({ tier: "casual", assistance: "play" });
    await wallet(23_000);
    expect(committed).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    expect(seat).toEqual({ gameId: committed[0]!.gameId, seatId: committed[0]!.seatId });
    expect(useQuickPlayStore.getState().notice).toBeNull();
  });

  it("replays a public buy-in without paying twice", async () => {
    const { requests, committed } = await fixture("JOIN_PUBLIC_TABLE");
    await useMatchmakingStore.getState().queue("casual");
    expect(useMatchmakingStore.getState().status.kind).toBe("matched");
    const seat = await useMatchmakingStore.getState().takeSeat();
    await wallet(23_000);
    expect(committed).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
    expect(seat).toEqual({ gameId: committed[0]!.gameId, seatId: committed[0]!.seatId });
  });

  it("recovers Sprint registration, charging once even if the field fills", async () => {
    const first = await fixture("REGISTER_SPRINT");
    await useTournamentStore.getState().register();
    await wallet(24_500);
    expect(first.requests).toHaveLength(2);
    expect(first.requests[1]).toBe(first.requests[0]);
    expect(useTournamentStore.getState().status).toMatchObject({ kind: "ready", entry: { tournament_id: first.committed[0]!.tournamentId } });
  });

  it.each(["loss", "malformed"] as const)("preserves the paid Sprint entry after %s of its read", async (fault) => {
    const { requests, committed, entryReads, restoreEntryRead } = await fixture("REGISTER_SPRINT", 0, fault);
    await useTournamentStore.getState().register();
    await useTournamentStore.getState().load();
    expect(requests).toHaveLength(1);
    expect(entryReads.length, JSON.stringify(useTournamentStore.getState().status)).toBeGreaterThan(0);
    for (const read of entryReads) {
      expect(read).toEqual([expect.objectContaining({ tournament_id: committed[0]!.tournamentId })]);
    }
    await wallet(24_500);
    expect(useTournamentStore.getState().status.kind).toBe("unavailable");
    restoreEntryRead();
    await useTournamentStore.getState().load();
    expect(useTournamentStore.getState().status).toMatchObject({
      kind: "ready", entry: { tournament_id: committed[0]!.tournamentId },
    });
    expect(requests).toHaveLength(1);
    await wallet(24_500);
  });

  it("reconciles the wallet and live seat when both replies disappear", async () => {
    const { requests, committed } = await fixture("OPEN", 2);
    expect(await useQuickPlayStore.getState().open({ tier: "casual", assistance: "play" })).toBeNull();
    await wallet(23_000);
    expect(requests).toHaveLength(2);
    expect(useQuickPlayStore.getState().notice).not.toMatch(/nothing has been charged/i);
    expect(useActiveSessionStore.getState().status).toMatchObject({ kind: "ready", session: { gameId: committed[0]!.gameId } });
    expect(useWalletStore.getState().status).toMatchObject({ kind: "ready", wallet: { balance: 23_000 } });
  });
});
