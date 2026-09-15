/** Delayed real HTTP responses must not rewind the shipped table store. */
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it } from "vitest";
import { stackUp } from "./stack-guard.js";
import { setSupabaseAvailabilityForTests, type ArcSupabaseClient } from "../../src/lib/supabase/client.js";
import { useOnlineTableStore } from "../../src/features/table/online-table-store.js";
import { useWalletStore } from "../../src/features/wallet/wallet-store.js";

const URL = "http://127.0.0.1:54321";
// Published local-development keys, accepted only by the disposable local stack.
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const ADMIN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
let client: ArcSupabaseClient | null = null;
let release: (() => void) | undefined;

afterEach(async () => {
  release?.();
  useOnlineTableStore.getState().forgetTable();
  await client?.realtime.disconnect();
  await client?.auth.signOut({ scope: "local" });
  setSupabaseAvailabilityForTests(null);
  useWalletStore.getState().clear();
});

async function fixture() {
  const email = `table-order-${crypto.randomUUID()}@arc21.test`;
  const password = crypto.randomUUID();
  const created = await fetch(`${URL}/auth/v1/admin/users`, {
    method: "POST", headers: { apikey: ADMIN, Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  expect(created.status).toBe(200);
  let delayNextSnapshot = false;
  let captured: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const supabase = createClient(URL, ANON, {
    auth: { flowType: "pkce", persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (delayNextSnapshot && String(input).endsWith("/functions/v1/game-command") &&
          typeof init?.body === "string" && JSON.parse(init.body).expectedVersion === 0) {
        delayNextSnapshot = false;
        expect(response.status).toBe(200);
        const body = await response.clone().json();
        expect(body.status).toBe("stale");
        expect(body.publicState.version).toBeGreaterThan(0);
        captured?.();
        await gate;
      }
      return response;
    } },
  }) as unknown as ArcSupabaseClient;
  client = supabase;
  expect((await supabase.auth.signInWithPassword({ email, password })).error).toBeNull();
  setSupabaseAvailabilityForTests({ status: "ready", client: supabase });
  const opened = await supabase.functions.invoke("create-session", { body: {
    action: "OPEN", tier: "casual", assistance: "play", clientRequestId: crypto.randomUUID(), clientSentAt: new Date().toISOString(),
  } });
  expect(opened.error).toBeNull();
  await useOnlineTableStore.getState().enter(opened.data.gameId, opened.data.seatId);
  expect(useOnlineTableStore.getState().status.kind).toBe("at-table");
  return {
    supabase,
    async delayPoll() {
      const ready = new Promise<void>((resolve) => { captured = resolve; });
      delayNextSnapshot = true;
      const poll = useOnlineTableStore.getState().refresh();
      await ready;
      return { finish: async () => { release!(); await poll; } };
    },
  };
}

describe.runIf(stackUp)("table reconciliation through real function replies", () => {
  it("does not rewind a dealt hand when an earlier poll finally arrives", async () => {
    const { delayPoll } = await fixture();
    const before = useOnlineTableStore.getState().status;
    if (before.kind !== "at-table") throw new Error("missing initial table");
    const poll = await delayPoll();
    useOnlineTableStore.getState().addChip(50);
    await useOnlineTableStore.getState().lockBet();
    const dealt = useOnlineTableStore.getState().status;
    if (dealt.kind !== "at-table") throw new Error("missing dealt table");
    expect(dealt.state.version).toBeGreaterThan(before.state.version);
    expect(dealt.state.seats[0]!.hands.length).toBeGreaterThan(0);
    await poll.finish();
    expect(useOnlineTableStore.getState().status).toEqual(dealt);
  });

  it("does not resurrect a cashed-out seat when its in-flight poll returns", async () => {
    const { supabase, delayPoll } = await fixture();
    const poll = await delayPoll();
    expect(await useOnlineTableStore.getState().leaveTable()).toBe(true);
    expect(useOnlineTableStore.getState().status.kind).toBe("idle");
    await poll.finish();
    expect(useOnlineTableStore.getState().status.kind).toBe("idle");
    const wallet = await supabase.from("wallets").select("balance").single();
    const ledger = await supabase.from("wallet_ledger").select("delta");
    expect(wallet.error).toBeNull();
    expect(ledger.error).toBeNull();
    expect(Number(wallet.data!.balance)).toBe(25_000);
    expect(ledger.data!.reduce((sum, row) => sum + Number(row.delta), 0)).toBe(25_000);
  });
});
