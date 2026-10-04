/**
 * The Refresh-B table blocker, against the real backend.
 *
 * The independent Astra re-audit reproduced this on September 28, 2026. Player A
 * and replacement player B both held active 5,000-chip seats in ONE private game.
 * A's Leave was held at the gateway's session read, a real password sign-in moved
 * the app to B, and releasing A's work cashed out **B**: B's seat `left`, B's
 * stack 0, A still `active`. The store discarded the reply afterwards, so nothing
 * on screen was wrong and the database was.
 *
 * `§13`'s repair had deliberately exempted this gateway, arguing that the server
 * refuses a caller with no seat at the named game. The argument is wrong for the
 * reason the audit gives in one line: **a multiplayer table has more than one
 * participant**, so `NOT_A_PARTICIPANT` never fires, and the `gameId:seatId`
 * idempotency key the server derives belongs to B too. A game id is a table, not
 * an identity.
 *
 * This is that reproduction, kept as a regression and inverted. Real GoTrue, real
 * Postgres, real Edge Functions, real `@supabase/supabase-js` with PKCE, the
 * production rooms gateway to open and deal the table, the production online
 * table store and gateway to enter and leave it, and the production Auth store
 * and adapter for the switch. The one fault injected is the audit's own — a single
 * `getSession()` completion held open across a real `signInWithPassword`.
 *
 * It asserts on the DATABASE, because that is where the defect was. Both stale
 * cases below would pass against the bug if they only checked the store's return
 * value: the store returned `false` in the audit's reproduction too.
 *
 * Two players switch, on two separate clients, because a client can only be
 * switched once: one proves the confirmed CASH_OUT defect, the other proves the
 * same thing for an ordinary `game-command` that the server would have ACCEPTED
 * as B. `tests/table/stale-identity-table.test.ts` carries the wire-level proof
 * for the retry paths and for `RESET_PRIVATE_STACK`, which needs a busted stack
 * this fixture has no cheap way to reach.
 *
 * The last case is the positive control, and it is not decoration: a harness that
 * could no longer cash anybody out would satisfy every assertion above it while
 * proving nothing at all.
 *
 * Private session chips are the medium, exactly as in the audit. A private table
 * is not wallet-backed (`session-economics.ts`), so the seat's stack is the
 * economic quantity at risk here; the global wallet/ledger invariant is asserted
 * across every wallet in the database before and after regardless.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

import { stackUp } from "./stack-guard.js";
import { activeAuthAdapter, useAuthStore } from "../../src/features/auth/auth-store.js";
import { resetPlayerState } from "../../src/features/player/reset-player-state.js";
import { createSupabaseRoomsGateway } from "../../src/features/rooms/rooms-gateway.js";
import { useOnlineTableStore } from "../../src/features/table/online-table-store.js";
import {
  setSupabaseAvailabilityForTests,
  type ArcSupabaseClient,
} from "../../src/lib/supabase/client.js";

const URL = "http://127.0.0.1:54321";
// Published local-only test keys, identical to the existing integration suites.
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const ADMIN_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/**
 * `flowType: "pkce"` because `src/lib/supabase/client.ts` sets it deliberately. A
 * test client on the SDK's default would prove a different mechanism while
 * looking like it proved this one.
 */
function sdk(): ArcSupabaseClient {
  const storage = new Map<string, string>();
  return createClient(URL, ANON, {
    auth: {
      flowType: "pkce",
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => { storage.set(key, value); },
        removeItem: (key) => { storage.delete(key); },
      },
    },
  }) as ArcSupabaseClient;
}

const admin = createClient(URL, ADMIN_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** The client whose player is replaced in the CASH_OUT case. */
const deviceOne = sdk();
/** The client whose player is replaced in the `game-command` case. */
const deviceTwo = sdk();
/**
 * One replacement player per case, each holding its own seat at the same table.
 *
 * TWO of them, not one, and the reason is a measurement rather than caution. With
 * a single replacement the second case passed against the DEFECT: the first case's
 * stale Leave had already closed that player's seat, so the second case's bet was
 * refused `SESSION_CLOSED` — a case shielded by the previous case's damage proves
 * nothing. Separate seats make each case independent of the other's outcome and of
 * the order they run in.
 */
const peerOne = sdk();
const peerTwo = sdk();

const created: string[] = [];
let playerOne = "";
let playerTwo = "";
let replacementOne = "";
let replacementTwo = "";
let seatOne = "";
let seatTwo = "";
let gameId = "";
interface Credential { readonly email: string; readonly password: string }
const credentialOne: Credential = {
  email: `b-stale-table-${randomUUID()}@arc21.test`,
  password: `Stale-${randomUUID()}!`,
};
const credentialTwo: Credential = {
  email: `b-stale-table-${randomUUID()}@arc21.test`,
  password: `Stale-${randomUUID()}!`,
};

/**
 * The database, directly, for readbacks the client cannot make.
 *
 * `game_session_seats` is readable by a participant — but the engine state lives
 * in the `private` schema with no client grants at all, which is exactly the
 * point of it, and `service_role` holds no table privilege in `public` either.
 * So the READBACKS come through psql while every mutation under test goes through
 * the product's own path.
 *
 * It THROWS when it cannot run. A helper that swallows a failure turns "the
 * readback never happened" into "the assertion passed".
 */
function database(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-Atc", sql],
    { encoding: "utf8" },
  ).trim();
}

interface SeatRow {
  readonly user_id: string;
  readonly status: string;
  readonly stack: number;
}

/** Every seat at the game under test, ordered, as the database holds it. */
function seats(): readonly SeatRow[] {
  expect(gameId).toMatch(/^[0-9a-f-]{36}$/);
  return JSON.parse(
    database(
      `select coalesce(json_agg(json_build_object('user_id', t.user_id, 'status', t.status, 'stack', t.stack)
                                order by t.seat_index), '[]'::json)
       from (
         select user_id::text as user_id, status, stack, seat_index from public.game_session_seats
         where game_session_id = '${gameId}'::uuid
       ) t`,
    ),
  ) as readonly SeatRow[];
}

/** The engine's own version and the bet posted on each seat. */
function engine(): { version: number; bets: Record<string, number> } {
  const row = database(
    `select json_build_object(
       'version', version,
       'bets', (select coalesce(json_object_agg(s->>'seatId', (s->>'originalBet')::int), '{}'::json)
                from jsonb_array_elements(engine_state->'seats') s)
     )
     from private.game_state_private where game_session_id = '${gameId}'::uuid`,
  );
  return JSON.parse(row) as { version: number; bets: Record<string, number> };
}

/**
 * The global economic invariant, asked of EVERY wallet rather than of this
 * fixture's. Same aggregate the Refresh-B native passes use.
 */
function walletInvariant(): string {
  return database(
    `select format('mismatch=%s negative=%s multigrant=%s',
       (select count(*) from public.wallets w
         where w.balance <> coalesce((select sum(l.delta) from public.wallet_ledger l where l.user_id = w.user_id), 0)),
       (select count(*) from public.wallets where balance < 0),
       (select count(*) from (
          select user_id from public.wallet_ledger where reason = 'initial_grant'
          group by user_id having count(*) <> 1) x))`,
  );
}

/** One player's balance and ledger total. */
function walletOf(userId: string): string {
  return database(
    `select format('%s/%s',
       coalesce((select balance from public.wallets where user_id = '${userId}'::uuid), -1),
       coalesce((select sum(delta) from public.wallet_ledger where user_id = '${userId}'::uuid), 0))`,
  );
}

/**
 * The production identity wiring, as the app installs it at its root.
 *
 * `usePlayerState` is a React hook and cannot run here — it reaches expo-sqlite
 * and the audio adapters through Settings — so its identity-change body is
 * installed directly: the production auth store, the production adapter's own
 * auth subscription, and the production `resetPlayerState()` when the user id
 * moves. Returns its own teardown, because a second client is wired later.
 */
async function wireAuth(client: ArcSupabaseClient, expected: string): Promise<() => void> {
  setSupabaseAvailabilityForTests({ status: "ready", client });
  const adapter = activeAuthAdapter();
  const snapshot = await adapter.getSession();
  expect(snapshot).toMatchObject({ ok: true });
  if (!snapshot.ok) throw new Error("the fixture player has no session");
  useAuthStore.setState({ session: snapshot.session, mode: "account", configured: true, hydrated: true });
  const stopAuth = adapter.onAuthStateChange((session) => {
    useAuthStore.setState({ session, mode: session ? "account" : "guest" });
  });
  const stopIdentity = useAuthStore.subscribe((next, previous) => {
    if ((next.session?.account.userId ?? null) === (previous.session?.account.userId ?? null)) return;
    resetPlayerState();
  });
  expect(useAuthStore.getState().session?.account.userId).toBe(expected);
  return () => { stopIdentity(); stopAuth(); };
}

/** Holds ONE `getSession()` completion on this client. The audit's fault, exactly. */
function holdOneSessionRead(client: ArcSupabaseClient): {
  reached: Promise<void>;
  release: () => void;
  restore: () => void;
} {
  const original = client.auth.getSession.bind(client.auth);
  let release!: () => void;
  let reach!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { reach = resolve; });
  let holdOnce = true;
  client.auth.getSession = async () => {
    const result = await original();
    if (holdOnce) { holdOnce = false; reach(); await gate; }
    return result;
  };
  return { reached, release, restore: () => { client.auth.getSession = original; } };
}

/** The real sign-in, through the production store, naming the player it replaces. */
async function signInAsReplacement(
  credential: Credential,
  replaced: string,
  becomes: string,
): Promise<void> {
  useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: credential.email });
  await useAuthStore.getState().signIn(credential.password, replaced);
  expect(useAuthStore.getState().session?.account.userId).toBe(becomes);
}

const suite = stackUp ? describe : describe.skip;

suite("a table mutation cannot be committed as the replacement player", () => {
  let unwire: (() => void) | null = null;
  let walletBefore = "";

  beforeAll(async () => {
    for (const [client, label] of [[deviceOne, "one"], [deviceTwo, "two"]] as const) {
      const signed = await client.auth.signInAnonymously();
      expect(signed.error, label).toBeNull();
      const id = signed.data.user!.id;
      created.push(id);
      if (label === "one") playerOne = id; else playerTwo = id;
    }

    // Two secured players to switch TO, created through the admin API. What
    // matters here is that each switch is a real GoTrue password sign-in; the
    // securing flow itself is proven by `pseudonymous-identity`.
    for (const [credential, client, label] of [
      [credentialOne, peerOne, "one"],
      [credentialTwo, peerTwo, "two"],
    ] as const) {
      const b = await admin.auth.admin.createUser({
        email: credential.email,
        password: credential.password,
        email_confirm: true,
      });
      expect(b.error, label).toBeNull();
      const id = b.data.user!.id;
      created.push(id);
      if (label === "one") replacementOne = id; else replacementTwo = id;
      const login = await client.auth.signInWithPassword(credential);
      expect(login.error, label).toBeNull();
    }

    /*
     * ONE private game holding all four, which is the premise the §13 exemption
     * got wrong. Opened and dealt through the production rooms gateway.
     */
    const host = createSupabaseRoomsGateway(deviceOne);
    const room = await host.create(4);
    expect(room).toMatchObject({ ok: true });
    if (!room.ok) throw new Error(room.message);
    for (const client of [deviceTwo, peerOne, peerTwo]) {
      const joined = await createSupabaseRoomsGateway(client).join(room.room.code);
      expect(joined).toMatchObject({ ok: true });
    }
    const started = await host.start(room.room.id);
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) throw new Error(started.message);
    gameId = started.gameId;
    seatOne = started.seatId;

    const found = await createSupabaseRoomsGateway(deviceTwo).findSeat(gameId);
    expect(found).toMatchObject({ ok: true });
    if (!found.ok || found.seatId === null) throw new Error("the second player has no seat");
    seatTwo = found.seatId;

    // The premise, measured rather than assumed: four ACTIVE seats, each on the
    // private ruleset's stack, and both replacement players among them.
    const opening = seats();
    expect(opening).toHaveLength(4);
    for (const row of opening) {
      expect(row.status).toBe("active");
      expect(row.stack).toBe(opening[0]!.stack);
    }
    expect(opening[0]!.stack).toBeGreaterThan(0);
    expect(opening.map((row) => row.user_id).sort()).toEqual(
      [playerOne, playerTwo, replacementOne, replacementTwo].sort(),
    );

    walletBefore = walletInvariant();
    expect(walletBefore).toBe("mismatch=0 negative=0 multigrant=0");
  });

  afterAll(async () => {
    unwire?.();
    resetPlayerState();
    useAuthStore.setState({ session: null, mode: "guest" });
    setSupabaseAvailabilityForTests(null);
    for (const client of [deviceOne, deviceTwo, peerOne, peerTwo]) await client.realtime.disconnect();
    for (const id of [...created].reverse()) {
      const result = await admin.auth.admin.deleteUser(id);
      expect(result.error).toBeNull();
    }
  });

  it("closes nobody's seat when a Leave's account switches mid-dispatch", async () => {
    unwire = await wireAuth(deviceOne, playerOne);
    await useOnlineTableStore.getState().enter(gameId, seatOne);
    expect(useOnlineTableStore.getState().status.kind).toBe("at-table");

    const before = seats();
    const players = [playerOne, playerTwo, replacementOne, replacementTwo];
    const walletsBefore = players.map(walletOf);

    const held = holdOneSessionRead(deviceOne);
    const leaving = useOnlineTableStore.getState().leaveTable();
    await held.reached;
    expect(useAuthStore.getState().session?.account.userId).toBe(playerOne);
    expect(useOnlineTableStore.getState().pending).toBe(true);

    await signInAsReplacement(credentialOne, playerOne, replacementOne);
    // The identity boundary has already torn A's table down.
    expect(useOnlineTableStore.getState().status).toEqual({ kind: "idle" });

    held.release();
    expect(await leaving).toBe(false);
    held.restore();

    /*
     * THE ASSERTION THE AUDIT FAILED ON. It read the replacement player's seat as
     * `left` with a stack of 0 while the initiating player stayed `active`.
     * Nothing may have moved: A's intent was never B's to send, and by the time
     * it could have gone it was no longer A's dispatch either.
     */
    expect(seats()).toEqual(before);
    for (const row of seats()) expect(row.status).toBe("active");
    expect(players.map(walletOf)).toEqual(walletsBefore);
    expect(walletInvariant()).toBe(walletBefore);

    // And no stale table state leaked into the new player's app.
    expect(useOnlineTableStore.getState()).toMatchObject({
      status: { kind: "idle" },
      notice: null,
      pending: false,
      stagedBet: 0,
      leavingWhenSafe: false,
    });
  });

  it("posts nobody's bet when a game command's account switches mid-dispatch", async () => {
    unwire?.();
    unwire = await wireAuth(deviceTwo, playerTwo);
    await useOnlineTableStore.getState().enter(gameId, seatTwo);
    const entered = useOnlineTableStore.getState().status;
    expect(entered.kind).toBe("at-table");
    if (entered.kind !== "at-table") throw new Error("the second player is not at the table");
    expect(entered.state.phase).toBe("BETTING_OPEN");

    const minimum = entered.state.legalActions[seatTwo]?.betBounds?.min;
    expect(minimum).toBeGreaterThan(0);
    useOnlineTableStore.getState().addChip(minimum!);
    expect(useOnlineTableStore.getState().stagedBet).toBe(minimum);

    const before = engine();
    const seatsBefore = seats();

    const held = holdOneSessionRead(deviceTwo);
    // `lockBet` sends PLACE_BET first. Sent as the replacement player it would
    // have staged this wager on the REPLACEMENT player's seat — a mutation the
    // server accepts, because that seat is a legal participant in this game.
    const locking = useOnlineTableStore.getState().lockBet();
    await held.reached;
    expect(useAuthStore.getState().session?.account.userId).toBe(playerTwo);

    await signInAsReplacement(credentialTwo, playerTwo, replacementTwo);
    held.release();
    await locking;
    held.restore();

    const after = engine();
    expect(after.version).toBe(before.version);
    expect(after.bets).toEqual(before.bets);
    for (const posted of Object.values(after.bets)) expect(posted).toBe(0);
    expect(seats()).toEqual(seatsBefore);
    expect(walletInvariant()).toBe(walletBefore);
    expect(useOnlineTableStore.getState().status).toEqual({ kind: "idle" });
  });

  it("still cashes the replacement player out, as the replacement player", async () => {
    /*
     * THE POSITIVE CONTROL. Same store, same gateway, same client — the only
     * difference is that nobody switches underneath it. Without this the two
     * cases above would be satisfied by a harness that had simply stopped being
     * able to mutate anything.
     */
    const own = await createSupabaseRoomsGateway(deviceTwo).findSeat(gameId);
    expect(own).toMatchObject({ ok: true });
    if (!own.ok || own.seatId === null) throw new Error("the replacement player has no seat");
    expect(own.seatId).not.toBe(seatTwo);
    expect(useAuthStore.getState().session?.account.userId).toBe(replacementTwo);

    await useOnlineTableStore.getState().enter(gameId, own.seatId);
    expect(useOnlineTableStore.getState().status.kind).toBe("at-table");
    expect(await useOnlineTableStore.getState().leaveTable()).toBe(true);

    const closed = seats().find((row) => row.user_id === replacementTwo);
    expect(closed).toMatchObject({ status: "left", stack: 0 });
    // The other three seats are untouched: a seat closing is not a table closing.
    for (const row of seats().filter((seat) => seat.user_id !== replacementTwo)) {
      expect(row.status).toBe("active");
    }
    /*
     * A private table is NOT wallet-backed (`session-economics.ts`), so this
     * returns nothing to the global wallet — which is itself worth asserting, and
     * is why the seat stack above is the economic quantity in this proof.
     */
    expect(walletInvariant()).toBe(walletBefore);
  });
});
