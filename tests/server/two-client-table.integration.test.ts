/**
 * TWO GENUINELY INDEPENDENT CLIENTS AT ONE SERVER-AUTHORITATIVE TABLE.
 *
 * Not two seats in one array. Two accounts, two GoTrue sessions obtained by
 * signing in with a password, two Supabase clients, two Realtime channels, and
 * — the part that makes this a client test rather than another server test —
 * the APP'S OWN gateway on both sides. Every command below goes through
 * `createSupabaseTableGateway`, the same factory `activeTableGateway()` returns
 * on a phone, so what is proved is the code that ships and not a paraphrase of
 * it written for a test.
 *
 * WHY THAT DISTINCTION IS THE POINT OF THIS FILE. Every defect this project has
 * had at a shared table survived a green server suite, because the server suite
 * sends commands straight to the function and the app does not:
 *
 *   - `lockBet` was correct, unit-tested, and wired to a Deal button that could
 *     never be pressed at an online table;
 *   - `INSURANCE` and `DECLINE_INSURANCE` were applied correctly by the server
 *     and had no client method at all, so the offer could not be answered;
 *   - `CASH_OUT` was implemented and tested with zero client callers;
 *   - and, found in this phase, `RESOLVE_TIMEOUT` was reachable from the app
 *     only as `snapshot()`'s deliberately-stale `expectedVersion: 0`, so an
 *     expired deadline was never resolved by anybody and one absent player
 *     froze a table for everybody.
 *
 * WHAT IS ASSERTED, in the order the phase asks for it: A opens a room, B joins
 * by code, both read the same lobby, the table is dealt, both bet independently,
 * the two clients agree card for card, actions are sequential by seat, the
 * dealer resolves, settlement agrees on both sides, several hands complete, one
 * client disconnects and the other carries on, and the disconnected client
 * reconnects to authoritative state rather than to its own stale copy.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { stackUp } from "./stack-guard.js";
import { callFunction } from "./call-function.js";
import {
  createSupabaseTableGateway,
  seqRangeOf,
  type TableEvents,
  type TableGateway,
} from "../../src/features/table/online-table-gateway.js";
import type { ArcSupabaseClient } from "../../src/lib/supabase/client.js";
import type { PublicGameState } from "../../shared/blackjack/index.js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const REST = `${SUPABASE_URL}/rest/v1`;
const AUTH_ADMIN = `${SUPABASE_URL}/auth/v1/admin/users`;

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

/**
 * One client, mirroring the real one's `auth` options.
 *
 * `flowType: "pkce"` is deliberate in `src/lib/supabase/client.ts` and a test
 * client that omitted it would silently get the SDK's implicit default —
 * genuinely different server behaviour, proved wrong while looking right. The
 * one option that cannot be mirrored is `storage`: the app's is the device
 * keychain through `expo-secure-store`, which has no Node backing, so each
 * client here keeps its session in memory. That is the correct difference —
 * two processes on two phones do not share a keychain either, and the whole
 * point of this file is that these two sessions are separate.
 */
function newClient(): ArcSupabaseClient {
  return createClient(SUPABASE_URL, LOCAL_ANON_KEY, {
    auth: {
      flowType: "pkce",
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }) as unknown as ArcSupabaseClient;
}

interface Client {
  readonly id: string;
  readonly email: string;
  readonly supabase: ArcSupabaseClient;
  readonly table: TableGateway;
  /** The raw access token, for the room RPCs the table gateway does not cover. */
  readonly token: string;
}

let open: SupabaseClient[] = [];

afterEach(async () => {
  for (const client of open) {
    await client.realtime.disconnect();
    await client.auth.signOut({ scope: "local" }).catch(() => undefined);
  }
  open = [];
});

/**
 * A real account with a real session.
 *
 * `signInWithPassword` rather than a hand-signed token, so the client holds a
 * genuine GoTrue session and `client.functions.invoke` sends the same header a
 * phone would. A helper that reads something must THROW when it cannot: a
 * sentinel here would turn a harness failure into an assertion about a wallet.
 */
async function signedInClient(): Promise<Client> {
  const email = `two-client-${crypto.randomUUID()}@arc21.test`;
  const password = crypto.randomUUID();

  const created = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const account = (await created.json()) as { id?: string };
  if (!account.id) throw new Error(`could not create an account: ${created.status}`);

  const supabase = newClient();
  open.push(supabase as unknown as SupabaseClient);

  const session = await supabase.auth.signInWithPassword({ email, password });
  if (session.error || !session.data.session) {
    throw new Error(`could not sign in: ${session.error?.message ?? "no session"}`);
  }

  return {
    id: account.id,
    email,
    supabase,
    table: createSupabaseTableGateway(supabase),
    token: session.data.session.access_token,
  };
}

async function rpc(client: Client, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${REST}/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_ANON_KEY,
      Authorization: `Bearer ${client.token}`,
    },
    body: JSON.stringify(args),
  });
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = raw;
  }
  return { status: response.status, body };
}

const one = (value: unknown) => (Array.isArray(value) ? value[0] : value);
const iso = () => new Date().toISOString();

/** Sends one command through the app's gateway and returns the new state. */
async function send(
  client: Client,
  gameId: string,
  type: string,
  version: number,
  payload: Record<string, unknown> = {},
): Promise<{ state: PublicGameState; events: TableEvents }> {
  const result = await client.table.command(gameId, { type, expectedVersion: version, payload });
  if (!result.ok) {
    throw new Error(`${type} was refused: ${result.code ?? result.reason} ${result.message}`);
  }
  return { state: result.state, events: result.events };
}

async function readTable(client: Client, gameId: string): Promise<PublicGameState> {
  const snapshot = await client.table.snapshot(gameId);
  if (!snapshot.ok) throw new Error(`snapshot failed: ${snapshot.reason} ${snapshot.message}`);
  return snapshot.state;
}

/** Every card on the table, as one comparable string. */
function cardsOnTable(state: PublicGameState): string {
  const dealer = state.dealer.cards
    .map((card) => ("hidden" in card ? "??" : `${card.rank}${card.suit}`))
    .join(",");
  const seats = [...state.seats]
    .sort((left, right) => left.seatId.localeCompare(right.seatId))
    .map(
      (seat) =>
        `${seat.displayName}:${seat.hands
          .map((hand) => hand.cards.map((card) => `${card.rank}${card.suit}`).join("+"))
          .join("|")}`,
    )
    .join(" ");
  return `dealer[${dealer}] ${seats}`;
}

const suite = stackUp ? describe : describe.skip;

suite("two independent clients at one private table", () => {
  it(
    "opens, joins, deals, bets, plays in seat order, settles, and reconnects",
    async () => {
      const alice = await signedInClient();
      const bob = await signedInClient();

      // --- The lobby ------------------------------------------------------
      const created = await rpc(alice, "create_private_room", { p_max_seats: 2 });
      expect(created.status).toBe(200);
      const room = one(created.body) as { id: string; code: string };
      expect(room.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);

      // Typed by hand off a message, lower case and spaced, as a person would.
      const joined = await rpc(bob, "join_private_room", {
        p_code: ` ${room.code.toLowerCase()} `,
      });
      expect(joined.status).toBe(200);
      expect((one(joined.body) as { id: string }).id).toBe(room.id);

      // BOTH clients read the lobby, independently, and see the same two seats.
      for (const client of [alice, bob]) {
        const seen = await rpc(client, "get_room_state", { p_room_id: room.id });
        expect(seen.status).toBe(200);
        const members = seen.body as Array<{
          member_user_id: string;
          member_is_host: boolean;
          member_seat_index: number;
        }>;
        expect(members).toHaveLength(2);
        expect(members.map((m) => m.member_user_id).sort()).toEqual([alice.id, bob.id].sort());
        expect(members.find((m) => m.member_is_host)?.member_user_id).toBe(alice.id);
      }

      // --- The deal -------------------------------------------------------
      // Only the host may. Bob's attempt is refused by the server, not by a
      // disabled button — the button is a courtesy and this is the control.
      const bobTriesToDeal = await callFunction("create-session", bob.token, {
        action: "START_PRIVATE_TABLE",
        clientRequestId: crypto.randomUUID(),
        roomId: room.id,
        clientSentAt: iso(),
      });
      expect(bobTriesToDeal.status).toBe(403);

      const dealt = await callFunction("create-session", alice.token, {
        action: "START_PRIVATE_TABLE",
        clientRequestId: crypto.randomUUID(),
        roomId: room.id,
        clientSentAt: iso(),
      });
      expect(dealt.status).toBe(200);
      const gameId = dealt.body.gameId as string;

      // Each client resolves its OWN seat from `game_session_seats`, which is
      // how a guest reaches the table at all — `start` only tells the host.
      const seatOf: Record<string, string> = {};
      for (const client of [alice, bob]) {
        const seats = await fetch(
          `${REST}/game_session_seats?select=id&game_session_id=eq.${gameId}&user_id=eq.${client.id}`,
          { headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${client.token}` } },
        );
        const rows = (await seats.json()) as Array<{ id: string }>;
        if (!rows[0]) throw new Error(`no seat for ${client.email}`);
        seatOf[client.id] = rows[0].id;
      }
      expect(seatOf[alice.id]).not.toBe(seatOf[bob.id]);

      // --- Several hands --------------------------------------------------
      const HANDS = 3;
      const agreed: string[] = [];

      for (let hand = 1; hand <= HANDS; hand += 1) {
        let table = await readTable(alice, gameId);

        // A shared table always states its clock. This is what the countdown
        // renders and what `resolveTimeout` acts on.
        expect(table.phase).toBe("BETTING_OPEN");
        expect(table.deadlineAt).not.toBeNull();

        // --- Betting: independent, and accepted for both seats ------------
        // Ordinary private-table betting may be simultaneous, so each client
        // sends its own PLACE_BET + LOCK_BET at whatever version it last saw.
        // A version another client has moved past comes back `stale` with the
        // authoritative snapshot; the client adopts it and retries. That is the
        // real client's recovery, not a test-only allowance.
        for (const [client, amount] of [
          [alice, 100],
          [bob, 60],
        ] as const) {
          let version = (await readTable(client, gameId)).version;
          const placed = await send(client, gameId, "PLACE_BET", version, { amount });
          version = placed.state.version;
          const locked = await send(client, gameId, "LOCK_BET", version);
          table = locked.state;
        }

        const aliceSeat = seatOf[alice.id] as string;
        const bobSeat = seatOf[bob.id] as string;

        // Both wagers were accepted, each against its own seat.
        const wagerOf = (state: PublicGameState, seatId: string) =>
          state.seats.find((seat) => seat.seatId === seatId)?.hands[0]?.wager ?? 0;
        expect(wagerOf(table, aliceSeat)).toBe(100);
        expect(wagerOf(table, bobSeat)).toBe(60);

        // An impossible bet is refused. Below the table minimum of 20, and
        // above its maximum of 500 — checked on the SERVER, whatever a client
        // may have clamped.
        const rejected = await alice.table.command(gameId, {
          type: "PLACE_BET",
          expectedVersion: table.version,
          payload: { amount: 5_000 },
        });
        expect(rejected.ok).toBe(false);

        // --- The two clients agree, card for card -------------------------
        const asAlice = await readTable(alice, gameId);
        const asBob = await readTable(bob, gameId);
        expect(cardsOnTable(asBob)).toBe(cardsOnTable(asAlice));
        expect(asBob.version).toBe(asAlice.version);
        agreed.push(cardsOnTable(asAlice));

        // The hole card is never on the wire before the reveal, for EITHER of
        // them. `toPublicState()` is the only sanitisation boundary there is.
        if (!asAlice.dealer.holeCardRevealed) {
          expect(JSON.stringify(asAlice.dealer.cards)).toContain("hidden");
          expect(JSON.stringify(asBob.dealer.cards)).toContain("hidden");
        }

        // --- Insurance, when it is offered --------------------------------
        table = asAlice;
        if (table.phase === "INSURANCE_OFFER") {
          for (const client of [alice, bob]) {
            const current = await readTable(client, gameId);
            if (current.phase !== "INSURANCE_OFFER") continue;
            const seatId = seatOf[client.id] as string;
            if (!current.legalActions[seatId]?.canDeclineInsurance) continue;
            const answered = await send(client, gameId, "DECLINE_INSURANCE", current.version);
            table = answered.state;
          }
          table = await readTable(alice, gameId);
        }

        // --- Actions are sequential by seat -------------------------------
        // Exactly one seat may act at a time, and the OTHER client's command is
        // refused while it is not their turn. That is the assertion; standing
        // in turn is merely how the hand gets played.
        const actedInOrder: string[] = [];
        let guard = 0;
        while (table.phase === "PLAYER_TURNS" && guard < 20) {
          guard += 1;
          const active = table.activeSeatId;
          if (active === null) break;
          actedInOrder.push(active);

          const actor = active === aliceSeat ? alice : bob;
          const other = active === aliceSeat ? bob : alice;

          // The player whose turn it is NOT cannot act, however current their
          // version is. A shared table where both could act would deal the same
          // card twice.
          const outOfTurn = await other.table.command(gameId, {
            type: "HIT",
            expectedVersion: table.version,
            payload: {},
          });
          expect(outOfTurn.ok).toBe(false);
          if (!outOfTurn.ok) expect(outOfTurn.reason).toBe("refused");

          const stood = await send(actor, gameId, "STAND", table.version);
          table = stood.state;
        }

        // Both seats took their turn, one after the other, never together.
        if (actedInOrder.length > 0) {
          expect(new Set(actedInOrder).size).toBe(actedInOrder.length);
        }

        // --- The dealer resolves and both clients agree on the settlement --
        expect(table.phase).toBe("HAND_COMPLETE");
        const settledAlice = await readTable(alice, gameId);
        const settledBob = await readTable(bob, gameId);
        expect(settledBob.dealer.holeCardRevealed).toBe(true);
        expect(cardsOnTable(settledBob)).toBe(cardsOnTable(settledAlice));

        const outcomeOf = (state: PublicGameState, seatId: string) =>
          state.seats.find((seat) => seat.seatId === seatId)?.hands[0]?.outcome?.kind ?? null;
        const stackOf = (state: PublicGameState, seatId: string) =>
          state.seats.find((seat) => seat.seatId === seatId)?.stack ?? -1;

        for (const seatId of [aliceSeat, bobSeat]) {
          expect(outcomeOf(settledBob, seatId)).toBe(outcomeOf(settledAlice, seatId));
          expect(stackOf(settledBob, seatId)).toBe(stackOf(settledAlice, seatId));
          expect(outcomeOf(settledAlice, seatId)).not.toBeNull();
        }

        // Integer chips only, on both clients, in every seat.
        for (const state of [settledAlice, settledBob]) {
          for (const seat of state.seats) expect(Number.isInteger(seat.stack)).toBe(true);
        }

        if (hand < HANDS) {
          // Whoever asks first starts the round for everyone; the other client
          // gets `stale` back rather than a second round.
          const next = await send(bob, gameId, "NEXT_HAND", settledBob.version);
          expect(next.state.phase).toBe("BETTING_OPEN");
          const alsoAsked = await alice.table.command(gameId, {
            type: "NEXT_HAND",
            expectedVersion: settledAlice.version,
            payload: {},
          });
          // Stale is an `ok` snapshot, not a refusal: nothing was applied and
          // the client adopts the authoritative table.
          expect(alsoAsked.ok).toBe(true);
          if (alsoAsked.ok) expect(alsoAsked.state.handNumber).toBe(next.state.handNumber);
        }
      }

      // Three hands, all agreed on by both clients, and no two identical — the
      // shoe advanced rather than the same hand being read three times.
      expect(agreed).toHaveLength(HANDS);
      expect(new Set(agreed).size).toBe(HANDS);

      // --- One client disconnects, the other carries on -------------------
      // A dropped socket is not a departed player: nothing about Bob's seat
      // changes, and Alice's table keeps moving. `realtime.disconnect()` is the
      // closest thing to a phone losing signal that this process can do.
      await bob.supabase.realtime.disconnect();

      const beforeAlone = await readTable(alice, gameId);
      const aloneNext = await send(alice, gameId, "NEXT_HAND", beforeAlone.version);
      expect(aloneNext.state.phase).toBe("BETTING_OPEN");

      const aliceBet = await send(alice, gameId, "PLACE_BET", aloneNext.state.version, {
        amount: 40,
      });
      const aliceLocked = await send(alice, gameId, "LOCK_BET", aliceBet.state.version);

      // Bob's seat is still HIS, still connected, still holding his chips. The
      // hand does not wait for him — the deadline does that — but nothing has
      // taken his seat away either.
      const bobSeatRow = aliceLocked.state.seats.find(
        (seat) => seat.seatId === seatOf[bob.id],
      );
      expect(bobSeatRow).toBeDefined();
      expect(bobSeatRow?.connected).toBe(true);

      // --- The disconnected client reconnects to AUTHORITATIVE state ------
      // Bob's last reading is several versions old. Reconnecting means asking,
      // not merging: whatever he held is replaced by the server's answer.
      const bobsStaleVersion = beforeAlone.version;
      const reconnected = await readTable(bob, gameId);
      expect(reconnected.version).toBeGreaterThan(bobsStaleVersion);
      expect(reconnected.gameId).toBe(gameId);
      expect(reconnected.handNumber).toBe(aliceLocked.state.handNumber);

      // And a command he sends at the version he WAS holding is refused with
      // the authoritative snapshot rather than applied on top of a stale table.
      const staleFromBob = await bob.table.command(gameId, {
        type: "PLACE_BET",
        expectedVersion: bobsStaleVersion,
        payload: { amount: 20 },
      });
      expect(staleFromBob.ok).toBe(true);
      if (staleFromBob.ok) expect(staleFromBob.state.version).toBe(reconnected.version);

      // eslint-disable-next-line no-console
      console.log(
        "[two-client proof] hands agreed by both clients:\n  " + agreed.join("\n  "),
      );
    },
    180_000,
  );

  /**
   * The broadcast, received by the OTHER client's real gateway.
   *
   * `subscribe` is the app's own — the one that parses the payload with the
   * contract schema and now carries the ordering envelope through. The
   * assertion that matters is the `seq`: it exists on the wire, and until this
   * phase the gateway unwrapped it and threw it away, which is what left the
   * store deduping on `version` and replaying every settlement twice.
   */
  it(
    "delivers a sequenced broadcast to the other client's gateway",
    async () => {
      const alice = await signedInClient();
      const bob = await signedInClient();

      const room = one((await rpc(alice, "create_private_room", { p_max_seats: 2 })).body) as {
        id: string;
        code: string;
      };
      await rpc(bob, "join_private_room", { p_code: room.code });
      const dealt = await callFunction("create-session", alice.token, {
        action: "START_PRIVATE_TABLE",
        clientRequestId: crypto.randomUUID(),
        roomId: room.id,
        clientSentAt: iso(),
      });
      const gameId = dealt.body.gameId as string;
      const startingVersion = (dealt.body.publicState as { version: number }).version;

      const received: Array<{ version: number; seq: { first: number; last: number } | null }> = [];
      const stop = bob.table.subscribe(gameId, (state, events) => {
        received.push({ version: state.version, seq: seqRangeOf(events) });
      });

      // Give the channel a moment to join before the command that fans out.
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const placed = await send(alice, gameId, "PLACE_BET", startingVersion, { amount: 100 });

      const deadline = Date.now() + 8_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      stop();

      // eslint-disable-next-line no-console
      console.log("[broadcast proof] received by the other client:", JSON.stringify(received));

      expect(received.length).toBeGreaterThan(0);
      expect(received[0]?.version).toBe(placed.state.version);
      // The envelope survived the trip. A null here is the defect this phase
      // fixed: events arriving with no sequence to order or dedupe them by.
      expect(received[0]?.seq).not.toBeNull();
      expect(received[0]?.seq?.first).toBeGreaterThan(0);
    },
    120_000,
  );
});

/**
 * EVERY MULTI-SEAT ACTION, THROUGH THE REAL FUNCTION.
 *
 * `SPLIT`, `DOUBLE`, `SURRENDER` and taking `INSURANCE` had NEVER been sent to
 * the server by any test in this repository — a grep over `tests/server` finds
 * only `HIT`, `STAND` and `DECLINE_INSURANCE`. Every one of them is in
 * `COMMAND_TYPES`, mapped by `toEngineCommand` and gated by
 * `assertCommandIsLegal`, and all of that was covered by inspection alone. This
 * project's own record is that a command reaching the engine correctly and a
 * command reaching the engine AT ALL are different claims: `INSURANCE` and
 * `DECLINE_INSURANCE` were applied correctly by the server for a whole phase
 * while no client method existed to send either.
 *
 * The shoe is a CSPRNG, so the hand that offers a split cannot be arranged —
 * this plays until the server offers each action and then TAKES it, which is
 * also the closest thing to a real table. The budget is the tail guard, not the
 * expected cost: insurance is the rarest of the four at one dealer ace in
 * thirteen (24 of 312 cards), so the expected run is about thirteen hands and
 * the loop exits the moment all four have been exercised. At 120 hands the
 * chance of never seeing a dealer ace is under one in ten thousand — quoted
 * because a test whose failure probability nobody has computed is a flake
 * waiting to be retried rather than reproduced.
 */
suite("every action a multi-seat table offers", () => {
  it(
    "splits, doubles, surrenders and takes insurance, and settles each correctly",
    async () => {
      const alice = await signedInClient();
      const bob = await signedInClient();

      const room = one((await rpc(alice, "create_private_room", { p_max_seats: 2 })).body) as {
        id: string;
        code: string;
      };
      await rpc(bob, "join_private_room", { p_code: room.code });
      const dealt = await callFunction("create-session", alice.token, {
        action: "START_PRIVATE_TABLE",
        clientRequestId: crypto.randomUUID(),
        roomId: room.id,
        clientSentAt: iso(),
      });
      expect(dealt.status).toBe(200);
      const gameId = dealt.body.gameId as string;

      const seatOf: Record<string, string> = {};
      for (const client of [alice, bob]) {
        const seats = await fetch(
          `${REST}/game_session_seats?select=id&game_session_id=eq.${gameId}&user_id=eq.${client.id}`,
          { headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${client.token}` } },
        );
        const rows = (await seats.json()) as Array<{ id: string }>;
        if (!rows[0]) throw new Error("no seat");
        seatOf[client.id] = rows[0].id;
      }
      const clientForSeat = (seatId: string) => (seatId === seatOf[alice.id] ? alice : bob);

      const exercised = { SPLIT: 0, DOUBLE: 0, SURRENDER: 0, INSURANCE: 0 };
      const BUDGET = 120;
      let table = await readTable(alice, gameId);

      for (let hand = 1; hand <= BUDGET; hand += 1) {
        if (Object.values(exercised).every((count) => count > 0)) break;

        if (table.phase === "HAND_COMPLETE") {
          table = (await send(alice, gameId, "NEXT_HAND", table.version)).state;
        }
        expect(table.phase).toBe("BETTING_OPEN");

        // 100 each: enough that DOUBLE and SPLIT are affordable all run, and a
        // round number so a doubled wager is unmistakable.
        for (const client of [alice, bob]) {
          const version = (await readTable(client, gameId)).version;
          const placed = await send(client, gameId, "PLACE_BET", version, { amount: 100 });
          table = (await send(client, gameId, "LOCK_BET", placed.state.version)).state;
        }

        // --- Insurance: one seat takes it, the other declines --------------
        if (table.phase === "INSURANCE_OFFER") {
          const takerSeat = seatOf[alice.id] as string;
          const takerLegal = table.legalActions[takerSeat];
          if (takerLegal?.canTakeInsurance) {
            const stake = takerLegal.insuranceStake;
            const taken = await send(alice, gameId, "INSURANCE", table.version);
            table = taken.state;
            const seat = table.seats.find((candidate) => candidate.seatId === takerSeat);
            // Half the original wager, as an integer, and actually recorded.
            expect(seat?.insuranceBet).toBe(stake);
            expect(seat?.insuranceBet).toBeGreaterThan(0);
            exercised.INSURANCE += 1;
          }
          // Whoever is still pending answers, so the offer closes.
          for (const client of [alice, bob]) {
            const current = await readTable(client, gameId);
            if (current.phase !== "INSURANCE_OFFER") break;
            const seatId = seatOf[client.id] as string;
            if (!current.legalActions[seatId]?.canDeclineInsurance) continue;
            table = (await send(client, gameId, "DECLINE_INSURANCE", current.version)).state;
          }
          table = await readTable(alice, gameId);
        }

        // --- Player turns: take whatever has not been exercised yet -------
        let guard = 0;
        while (table.phase === "PLAYER_TURNS" && guard < 30) {
          guard += 1;
          const seatId = table.activeSeatId;
          const handId = table.activeHandId;
          if (seatId === null || handId === null) break;
          const actor = clientForSeat(seatId);
          const legal = table.legalActions[seatId];
          const seatBefore = table.seats.find((candidate) => candidate.seatId === seatId);
          const handBefore = seatBefore?.hands.find((candidate) => candidate.id === handId);
          const available = new Set(legal?.actions ?? []);

          if (available.has("SPLIT")) {
            const before = seatBefore?.hands.length ?? 0;
            const wagerBefore = handBefore?.wager ?? 0;
            table = (await send(actor, gameId, "SPLIT", table.version)).state;

            const after = table.seats.find((candidate) => candidate.seatId === seatId);
            expect(after?.hands.length).toBe(before + 1);
            // Each hand carries its own equal wager, and the second was funded
            // from the stack rather than conjured.
            for (const hands of after?.hands ?? []) expect(hands.wager).toBe(wagerBefore);
            /*
             * SEQUENTIAL INSIDE THE SEAT, stated as the rule rather than as an
             * observation of the common case.
             *
             * "The turn stays on this seat after a split" is FALSE for a pair of
             * aces: Arc Standard deals one card to each and stands both, so the
             * seat is finished and the turn correctly passes along the table.
             * Reproduced deliberately over a seeded shoe rather than retried —
             * `A,A` splits to `STOOD,STOOD` with the active seat already `s2` —
             * after this assertion failed one run in ten and read like an
             * ordering defect.
             *
             * What is always true is the rule the specification actually states:
             * the turn does not leave a seat that still has a hand to play.
             */
            const stillToPlay = (after?.hands ?? []).some((candidate) => candidate.status === "ACTIVE");
            if (stillToPlay) {
              expect(table.phase).toBe("PLAYER_TURNS");
              expect(table.activeSeatId).toBe(seatId);
            }
            exercised.SPLIT += 1;
            continue;
          }

          if (available.has("DOUBLE") && exercised.DOUBLE === 0) {
            const wagerBefore = handBefore?.wager ?? 0;
            const stackBefore = seatBefore?.stack ?? 0;
            table = (await send(actor, gameId, "DOUBLE", table.version)).state;

            const after = table.seats.find((candidate) => candidate.seatId === seatId);
            const doubled = after?.hands.find((candidate) => candidate.id === handId);
            expect(doubled?.wager).toBe(wagerBefore * 2);
            expect(doubled?.cards.length).toBe(3);

            /*
             * A DOUBLE CAN SETTLE THE HAND, and the stack assertion has to know
             * that. Doubling the last live hand at the table runs the dealer
             * inside the same command, so the seat has already been CREDITED by
             * the time the reply comes back. Reproduced deliberately at the
             * engine level rather than diagnosed from an intermittent: over a
             * seeded shoe, a doubled 11 against a dealer 16 that busts returns
             * `phase HAND_COMPLETE, stack 10200` from a stack of 9,900 — while
             * the same double that LOSES returns 9,800, which is exactly
             * `stackBefore - wagerBefore` and passes by coincidence. That is why
             * it failed one run in five and looked like a product defect. The
             * same lesson as CLAUDE.md's "`LOCK_BET` CAN SETTLE THE HAND".
             */
            if (table.phase === "PLAYER_TURNS") {
              // Still live: the extra wager came out of the stack, exactly once.
              expect(after?.stack).toBe(stackBefore - wagerBefore);
              expect(doubled?.outcome ?? null).toBeNull();
            } else {
              // Settled in the same command. The doubled wager was still taken
              // from the stack — it is now inside the settlement — so assert the
              // thing that is true either way: the hand is finished, its result
              // is an integer, and it was decided on the DOUBLED amount.
              expect(doubled?.outcome).not.toBeNull();
              expect(Number.isInteger(doubled?.outcome?.net ?? 0)).toBe(true);
              expect(Math.abs(doubled?.outcome?.net ?? 0)).toBeLessThanOrEqual(wagerBefore * 2);
            }
            exercised.DOUBLE += 1;
            continue;
          }

          if (
            available.has("SURRENDER") &&
            exercised.SURRENDER === 0 &&
            exercised.SPLIT > 0 &&
            exercised.DOUBLE > 0
          ) {
            // Taken last of the three, because surrendering ends the hand and
            // would keep costing the run its chances at the other two.
            const wagerBefore = handBefore?.wager ?? 0;
            table = (await send(actor, gameId, "SURRENDER", table.version)).state;

            const after = table.seats.find((candidate) => candidate.seatId === seatId);
            const given = after?.hands.find((candidate) => candidate.id === handId);
            expect(given?.status).toBe("SURRENDERED");
            if (given?.outcome) {
              expect(given.outcome.kind).toBe("SURRENDER");
              // Half the wager back, floored on integers — never a fraction.
              expect(given.outcome.net).toBe(-Math.floor(wagerBefore / 2));
              expect(Number.isInteger(given.outcome.net)).toBe(true);
            }
            exercised.SURRENDER += 1;
            continue;
          }

          table = (await send(actor, gameId, "STAND", table.version)).state;
        }

        // The hand always resolves. A shared table that could park anywhere else
        // is a table nobody can leave.
        expect(["HAND_COMPLETE", "SESSION_COMPLETE"]).toContain(table.phase);
        if (table.phase === "SESSION_COMPLETE") break;

        // Every hand at the table settled, with an integer result.
        for (const seat of table.seats) {
          for (const seatHand of seat.hands) {
            expect(seatHand.outcome).not.toBeNull();
            expect(Number.isInteger(seatHand.outcome?.net ?? 0)).toBe(true);
          }
          expect(Number.isInteger(seat.stack)).toBe(true);
          expect(seat.stack).toBeGreaterThanOrEqual(0);
        }
        expect(table.dealer.holeCardRevealed).toBe(true);
      }

      // eslint-disable-next-line no-console
      console.log("[multi-seat action proof] exercised:", JSON.stringify(exercised));

      expect(exercised.SPLIT).toBeGreaterThan(0);
      expect(exercised.DOUBLE).toBeGreaterThan(0);
      expect(exercised.SURRENDER).toBeGreaterThan(0);
      expect(exercised.INSURANCE).toBeGreaterThan(0);

      // Unranked, whatever was played: a private table records no decision for
      // the strategy board. `ACCURACY_ELIGIBLE_MODES` is an allowlist and
      // `private_table` is deliberately not on it.
      for (const client of [alice, bob]) {
        const decisions = await fetch(
          `${REST}/player_decision_periods?select=decisions_total&user_id=eq.${client.id}`,
          { headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${client.token}` } },
        );
        const rows = (await decisions.json()) as Array<{ decisions_total: number }>;
        expect(rows).toEqual([]);
      }
    },
    240_000,
  );
});
