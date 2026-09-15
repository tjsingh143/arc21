/**
 * The authoritative economy, against the REAL Edge Functions and the REAL
 * database.
 *
 * This file is the half of phase 4 that nothing else covered. `game-command`
 * proves a command cannot be replayed into a second charge; `economy-guards`
 * proves a second SEAT cannot charge a second buy-in; `career` proves a node
 * pays once. What none of them asked:
 *
 *   - can a caller who never learned the outcome retry every economic command
 *     safely, not just the two that had tests? (§K — "this is critical")
 *   - does an INTENTIONAL failure at each of the five economic points leave the
 *     database exactly as it found it? (§L)
 *   - does the balance still reconcile with the ledger after a session? (§C)
 *   - can a modified client write a wallet, a ledger row, a seat stack or a
 *     statistic through PostgREST? (§M — asserted only by a SOURCE SCAN before
 *     this file, which proves what the client says, not what the server does)
 *   - and can a player who lost their game id ever reach their chips again?
 *     (§G — they could not. See `20260830120000_active_session_lookup.sql`.)
 *
 * Everything here goes through `callFunction`, which replays a 5xx with a
 * BYTE-IDENTICAL body. That is not incidental to this suite: it means every run
 * is itself an idempotency assertion, because a retry that duplicated an effect
 * would fail these tests on doubled chips rather than passing quietly.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { callFunction as call } from "./call-function.js";
import { stackUp } from "./stack-guard.js";

const REST = "http://127.0.0.1:54321/rest/v1";
const AUTH_ADMIN = "http://127.0.0.1:54321/auth/v1/admin/users";

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

/** The specification's opening balance, and the Casual tier's buy-in. */
const OPENING_GRANT = 25_000;
const CASUAL_BUY_IN = 2_000;
/** Below this the Recovery Grant is available; it restores TO the second figure. */
const GRANT_THRESHOLD = 2_000;
const GRANT_RESTORES_TO = 5_000;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const iso = () => new Date().toISOString();

/**
 * No `iat`, deliberately — PostgREST validates it against its own clock and the
 * Docker VM's jumps rather than drifts, so any constant is a guess about how
 * far. The failure does not look like a clock problem: it looks like a wallet
 * that reads as null. See `economy-guards.integration.test.ts` for the full note.
 */
function signToken(sub: string): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({
    sub,
    role: "authenticated",
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const signature = crypto
    .createHmac("sha256", LOCAL_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

interface Player {
  readonly id: string;
  readonly token: string;
}

async function createPlayer(): Promise<Player> {
  const response = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      email: `authority-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return { id: json.id, token: signToken(json.id) };
}

/** A REST call made as a signed-in player. Never as the service role. */
async function asPlayer(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${REST}/${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_ANON_KEY,
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    body = raw;
  }
  return { status: response.status, body };
}

async function rpc(token: string, name: string, args: unknown = {}) {
  return await asPlayer(token, `rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
}

interface WalletRow {
  balance: number;
  lifetime_credited: number;
  lifetime_debited: number;
}

/**
 * THROWS rather than returning a sentinel.
 *
 * A helper that answered -1 for an unreadable wallet turned a JWT clock problem
 * into "expected 25200 to be 199" and cost three failures to diagnose. A test
 * helper that reads something must fail loudly when it cannot.
 */
async function walletOf(player: Player): Promise<WalletRow> {
  const result = await asPlayer(
    player.token,
    `wallets?select=balance,lifetime_credited,lifetime_debited&user_id=eq.${player.id}`,
  );
  const rows = result.body as WalletRow[] | null;
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`could not read a wallet: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return rows[0]!;
}

async function balanceOf(player: Player): Promise<number> {
  return (await walletOf(player)).balance;
}

interface LedgerRow {
  delta: number;
  balance_after: number;
  reason: string;
  idempotency_key: string;
}

async function ledgerOf(player: Player): Promise<LedgerRow[]> {
  const result = await asPlayer(
    player.token,
    `wallet_ledger?select=delta,balance_after,reason,idempotency_key&user_id=eq.${player.id}&order=created_at.asc`,
  );
  if (!Array.isArray(result.body)) {
    throw new Error(`could not read a ledger: ${result.status} ${JSON.stringify(result.body)}`);
  }
  return result.body as LedgerRow[];
}

/** Opens a Casual solo table and returns what the server said about it. */
async function openTable(player: Player) {
  const response = await call("create-session", player.token, {
    action: "OPEN",
    clientRequestId: crypto.randomUUID(),
    tier: "casual",
    clientSentAt: iso(),
  });
  return response;
}

interface Table {
  readonly gameId: string;
  readonly seatId: string;
  version: number;
}

/** Sends one command at the table's current version and tracks the new one. */
async function send(
  player: Player,
  table: Table,
  type: string,
  payload?: Record<string, unknown>,
) {
  const response = await call("game-command", player.token, {
    gameId: table.gameId,
    clientActionId: crypto.randomUUID(),
    type,
    ...(payload ? { payload } : {}),
    expectedVersion: table.version,
    clientSentAt: iso(),
  });
  const state = response.body.publicState as { version: number; phase: string } | undefined;
  if (state) table.version = state.version;
  return { response, phase: state?.phase };
}

/**
 * Plays until the seat is actually mid-hand, with a wager committed.
 *
 * NOT just "bet and lock". `LOCK_BET` completes the betting round, so its own
 * cascade runs the deal and can stop at any of THREE places, and this helper
 * has now been wrong about two of them:
 *
 *   - PLAYER_TURNS, the ordinary one;
 *   - HAND_COMPLETE, when a natural — the player's or the dealer's — settles
 *     the round inside that cascade. Assuming PLAYER_TURNS passed about fifteen
 *     times in sixteen and failed the rest;
 *   - **INSURANCE_OFFER, when the dealer's upcard is an ACE.** The cascade
 *     returns while any seat's insurance decision is `PENDING`, because that is
 *     a decision only the player can make.
 *
 * THE THIRD ONE COST A PHASE OF "UNREPRODUCED, NOT DIAGNOSED". A `test:server`
 * run failed here once, the message was lost to a truncated capture, the file
 * then passed alone and the suite passed twice more, and the edge runtime's
 * CPU-limit counts ruled out the usual explanation — so it was recorded as a
 * transient. It is not one. It is a dealer ace: about one hand in thirteen, and
 * this file calls this helper twice, so roughly one run in seven. Reproduced on
 * purpose in the verification pass — run 8 of 20 — and confirmed from the
 * engine row, which was sitting at `INSURANCE_OFFER` with an ace showing while
 * the helper sent `NEXT_HAND` at it and the server correctly answered
 * WRONG_PHASE.
 *
 * Declining is the right answer rather than dealing again: it is what the
 * absent-player default is, it costs nothing, and it leads to the two phases
 * this already knew how to handle.
 */
async function reachPlayerTurns(player: Player, table: Table): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await send(player, table, "PLACE_BET", { amount: 100 });
    const locked = await send(player, table, "LOCK_BET");

    // A dealer ace. Answering the offer is the only way past it, and declining
    // leads to PLAYER_TURNS or — if the dealer had it — HAND_COMPLETE.
    let phase = locked.phase;
    if (phase === "INSURANCE_OFFER") {
      const declined = await send(player, table, "DECLINE_INSURANCE");
      if (declined.response.status !== 200) {
        throw new Error(
          `could not decline insurance: ${declined.response.raw.slice(0, 300)}`,
        );
      }
      phase = declined.phase;
    }

    if (phase === "PLAYER_TURNS") return;

    // A natural. Settle the round and deal another.
    const next = await send(player, table, "NEXT_HAND");
    if (next.response.status !== 200) {
      // The phase is NAMED, so a future failure here diagnoses itself instead
      // of being read as a flake for a second time.
      throw new Error(
        `could not deal another hand from phase ${phase ?? "unknown"}: ` +
          next.response.raw.slice(0, 300),
      );
    }
  }
  throw new Error("twelve consecutive naturals: the shoe is not fair");
}

const suite = stackUp ? describe : describe.skip;

// ---------------------------------------------------------------------------
// §C — the wallet
// ---------------------------------------------------------------------------

suite("the wallet is the server's, and it reconciles", () => {
  let player: Player;

  beforeAll(async () => {
    player = await createPlayer();
  });

  it("opens a registered account on the specified 25,000 chips", async () => {
    expect(await balanceOf(player)).toBe(OPENING_GRANT);
  });

  it("records that grant as a ledger row rather than a bare number", async () => {
    const rows = await ledgerOf(player);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      delta: OPENING_GRANT,
      balance_after: OPENING_GRANT,
      reason: "initial_grant",
    });
  });

  it("still reconciles after chips have moved in both directions", async () => {
    const opened = await openTable(player);
    expect(opened.status).toBe(200);
    const cashed = await call("create-session", player.token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId: opened.body.gameId,
      clientSentAt: iso(),
    });
    expect(cashed.status).toBe(200);

    const wallet = await walletOf(player);
    const rows = await ledgerOf(player);

    // Three independent statements of the same balance. A wallet that agreed
    // with its running total but not with the last row it wrote would mean the
    // two had been updated by different code paths.
    expect(rows.reduce((total, row) => total + row.delta, 0)).toBe(wallet.balance);
    expect(rows.at(-1)!.balance_after).toBe(wallet.balance);
    expect(rows.filter((r) => r.delta > 0).reduce((t, r) => t + r.delta, 0)).toBe(
      wallet.lifetime_credited,
    );
    expect(rows.filter((r) => r.delta < 0).reduce((t, r) => t - r.delta, 0)).toBe(
      wallet.lifetime_debited,
    );

    // And the round trip cost nothing: a buy-in and its return net to zero.
    expect(wallet.balance).toBe(OPENING_GRANT);
    expect(rows.map((row) => row.reason)).toEqual([
      "initial_grant",
      "table_buy_in",
      "table_cash_out",
    ]);
  });

  it("never lets a balance go negative on the way through a session", async () => {
    /*
     * The overdraft itself is refused by the `balance >= 0` CHECK inside
     * `apply_wallet_delta` — a constraint, not a comparison in application code
     * — and `02_wallets.test.sql` asserts that directly against a fixture whose
     * balance it owns. It cannot be reached from here: the only chip sink a
     * fresh account has is LOSING, and a test that plays until broke has no
     * bound on how long it takes.
     *
     * What this asserts is the property that must hold whatever the route: no
     * command in an ordinary session ever leaves the balance below zero, and
     * the escrowed chips are accounted for outside it.
     */
    const player = await createPlayer();
    const opened = await call("create-session", player.token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "standard",
      clientSentAt: iso(),
    });
    expect(opened.status).toBe(200);

    const wallet = await walletOf(player);
    expect(wallet.balance).toBe(OPENING_GRANT - (opened.body.buyIn as number));
    expect(wallet.balance).toBeGreaterThanOrEqual(0);
    // Escrow is not balance. The chips are at the table, and the session row
    // says how many are owed back to a wallet.
    expect(opened.body.buyIn).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// §G — the reconnectable active-game identifier
// ---------------------------------------------------------------------------

suite("a player can always find the table holding their chips", () => {
  it("names the very table the second buy-in was refused for", async () => {
    const player = await createPlayer();
    expect((await rpc(player.token, "my_active_session")).body).toEqual([]);

    const opened = await openTable(player);
    expect(opened.status).toBe(200);

    /*
     * The relationship, not the value.
     *
     * `my_active_session()` and `assertNoOtherLiveSeat` must agree exactly: a
     * resume card pointing at a table the server does not count is a button
     * leading nowhere, and one absent for a table it DOES count leaves the
     * player locked out while the screen insists they are free. So this
     * provokes the refusal and asserts the lookup names the same table, rather
     * than comparing two copies of a predicate.
     */
    const refused = await openTable(player);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("SESSION_ALREADY_ACTIVE");

    const active = (await rpc(player.token, "my_active_session")).body as Record<string, unknown>[];
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      game_session_id: opened.body.gameId,
      seat_id: opened.body.seatId,
      mode: "solo",
      tier: "casual",
    });

    // And the chips really are where it says. Before this lookup existed the
    // player had no way to learn either fact.
    expect(await balanceOf(player)).toBe(OPENING_GRANT - CASUAL_BUY_IN);
  });

  it("goes quiet again the moment the seat is settled, so the offer cannot outlive it", async () => {
    const player = await createPlayer();
    const opened = await openTable(player);
    const cashed = await call("create-session", player.token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId: opened.body.gameId,
      clientSentAt: iso(),
    });
    expect(cashed.status).toBe(200);

    expect((await rpc(player.token, "my_active_session")).body).toEqual([]);
    // The other half of the same fact: the server agrees the player is free.
    expect((await openTable(player)).status).toBe(200);
  });

  it("finds a seat left mid-hand, which is the state that stranded chips", async () => {
    /*
     * A solo table carries no clocks on purpose — one player stalls nobody — so
     * `RESOLVE_TIMEOUT` is refused with DEADLINE_NOT_REACHED and nothing can
     * ever advance a hand its player walked away from. Measured: the table
     * parks at PLAYER_TURNS with the seat still `active` and `escrow_chips` at
     * 2,000. It is playable and cashable; it just could not be ADDRESSED.
     */
    const player = await createPlayer();
    const opened = await openTable(player);
    const table: Table = {
      gameId: opened.body.gameId as string,
      seatId: opened.body.seatId as string,
      version: (opened.body.publicState as { version: number }).version,
    };

    await reachPlayerTurns(player, table);
    const left = await send(player, table, "LEAVE");
    expect(left.response.status).toBe(200);
    // Leaving is never a way to escape a committed wager: the hand stands.
    expect(left.phase).toBe("PLAYER_TURNS");
    expect(await balanceOf(player)).toBe(OPENING_GRANT - CASUAL_BUY_IN);

    const active = (await rpc(player.token, "my_active_session")).body as Record<string, unknown>[];
    expect(active[0]).toMatchObject({
      game_session_id: table.gameId,
      seat_id: table.seatId,
    });

    // And the way back genuinely works: the hand finishes and the chips come home.
    await send(player, table, "STAND");
    const cashed = await call("create-session", player.token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId: table.gameId,
      clientSentAt: iso(),
    });
    expect(cashed.status).toBe(200);
    expect(cashed.body.returned).toBeGreaterThan(0);
    expect((await rpc(player.token, "my_active_session")).body).toEqual([]);
  }, 60_000);

  it("tells one player nothing about another's table", async () => {
    const player = await createPlayer();
    const stranger = await createPlayer();
    await openTable(player);
    expect((await rpc(stranger.token, "my_active_session")).body).toEqual([]);
  });

  it("is closed to an unauthenticated caller", async () => {
    const response = await fetch(`${REST}/rpc/my_active_session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: LOCAL_ANON_KEY },
      body: "{}",
    });
    // A new function's default ACL is EXECUTE TO PUBLIC; the migration writes
    // the revoke/grant pair, and the authorization gate refuses any public
    // function still executable by PUBLIC.
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// §K — the caller never learned the outcome, and retries
// ---------------------------------------------------------------------------

suite("a retry after an unknown outcome duplicates nothing", () => {
  /*
   * THE SITUATION, which is not hypothetical here. The local Edge runtime
   * retires a worker when its isolate trips the CPU soft limit, and a request
   * already in flight is then answered by a worker that is gone — with the
   * "command handled … accepted" log line landing BETWEEN the two. The command
   * COMMITTED and only the reply was lost. `call-function.ts` replays the
   * identical body for exactly that reason.
   *
   * Every case below sends the SAME request twice with the same identifier,
   * which is what a client that did not learn the outcome actually does.
   */

  it("charges one buy-in for a replayed OPEN", async () => {
    const player = await createPlayer();
    const body = {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    };
    const first = await call("create-session", player.token, body);
    const replay = await call("create-session", player.token, body);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body.gameId).toBe(first.body.gameId);
    expect(replay.body.seatId).toBe(first.body.seatId);
    expect(await balanceOf(player)).toBe(OPENING_GRANT - CASUAL_BUY_IN);
    expect((await ledgerOf(player)).filter((r) => r.reason === "table_buy_in")).toHaveLength(1);
  });

  it("credits one cash-out for a replayed CASH_OUT", async () => {
    const player = await createPlayer();
    const opened = await openTable(player);
    const body = {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId: opened.body.gameId,
      clientSentAt: iso(),
    };
    const first = await call("create-session", player.token, body);
    const replay = await call("create-session", player.token, body);

    expect(first.body.returned).toBe(CASUAL_BUY_IN);
    expect(replay.body.returned).toBe(CASUAL_BUY_IN);
    expect(replay.body.walletBalance).toBe(first.body.walletBalance);
    expect(await balanceOf(player)).toBe(OPENING_GRANT);
    expect((await ledgerOf(player)).filter((r) => r.reason === "table_cash_out")).toHaveLength(1);
  });

  it("credits one cash-out even when the retry mints a FRESH request id", async () => {
    /*
     * The sharper case, and the reason the cash-out key is derived from
     * `gameId:seatId` rather than from the client's request id: a client that
     * reconnects and taps "cash out" again has no memory of the id it sent. A
     * key taken from the request would be a new key, and a new key is a second
     * credit.
     */
    const player = await createPlayer();
    const opened = await openTable(player);
    const first = await call("create-session", player.token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId: opened.body.gameId,
      clientSentAt: iso(),
    });
    const second = await call("create-session", player.token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId: opened.body.gameId,
      clientSentAt: iso(),
    });

    expect(first.body.returned).toBe(CASUAL_BUY_IN);
    expect(second.body.returned).toBe(CASUAL_BUY_IN);
    expect(await balanceOf(player)).toBe(OPENING_GRANT);
    expect((await ledgerOf(player)).filter((r) => r.reason === "table_cash_out")).toHaveLength(1);
  });

  it("credits once when a dropped LEAVE is followed by a CASH_OUT", async () => {
    /*
     * Two different COMMANDS, on two different functions, reaching the same
     * money. They share one idempotency key — `table_cash_out:<game>:<seat>` —
     * so they are idempotent against each other and not only against
     * themselves.
     */
    const player = await createPlayer();
    const opened = await openTable(player);
    const version = (opened.body.publicState as { version: number }).version;

    const left = await call("game-command", player.token, {
      gameId: opened.body.gameId,
      clientActionId: crypto.randomUUID(),
      type: "LEAVE",
      expectedVersion: version,
      clientSentAt: iso(),
    });
    expect(left.status).toBe(200);
    expect(await balanceOf(player)).toBe(OPENING_GRANT);

    const cashed = await call("create-session", player.token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId: opened.body.gameId,
      clientSentAt: iso(),
    });
    expect(cashed.status).toBe(200);
    // It REPORTS what was returned; it does not return it a second time.
    expect(cashed.body.returned).toBe(CASUAL_BUY_IN);
    expect(await balanceOf(player)).toBe(OPENING_GRANT);
    expect((await ledgerOf(player)).filter((r) => r.reason === "table_cash_out")).toHaveLength(1);
  });

  it("cannot both preserve a spendable table stack and credit the wallet", async () => {
    /*
     * §F stated as one assertion. After a cash-out the chips exist in exactly
     * one place: the wallet holds them and the seat is settled, so no further
     * command can wager them.
     */
    const player = await createPlayer();
    const opened = await openTable(player);
    const version = (opened.body.publicState as { version: number }).version;

    await call("create-session", player.token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId: opened.body.gameId,
      clientSentAt: iso(),
    });
    expect(await balanceOf(player)).toBe(OPENING_GRANT);

    const bet = await call("game-command", player.token, {
      gameId: opened.body.gameId,
      clientActionId: crypto.randomUUID(),
      type: "PLACE_BET",
      payload: { amount: 100 },
      expectedVersion: version + 1,
      clientSentAt: iso(),
    });
    expect(bet.status).toBeGreaterThanOrEqual(400);
    expect(bet.body.code).toBe("SESSION_CLOSED");
    expect(await balanceOf(player)).toBe(OPENING_GRANT);
  });

  it("returns the first committed result for a replayed game command", async () => {
    const player = await createPlayer();
    const opened = await openTable(player);
    const body = {
      gameId: opened.body.gameId,
      clientActionId: crypto.randomUUID(),
      type: "PLACE_BET",
      payload: { amount: 100 },
      expectedVersion: (opened.body.publicState as { version: number }).version,
      clientSentAt: iso(),
    };
    const first = await call("game-command", player.token, body);
    const replay = await call("game-command", player.token, body);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    /*
     * The same VALUE, not the same bytes.
     *
     * The replay is served from `private.game_commands`, where the first result
     * was stored as `jsonb` — and jsonb does not preserve key order: it sorts
     * keys by length and then bytewise. So the replayed payload is
     * character-for-character different and semantically identical, which is a
     * distinction worth writing down rather than rediscovering as a red test.
     * Nothing was recomputed: no second chip moved and no second card was dealt.
     */
    expect(replay.body).toEqual(first.body);
    expect(await balanceOf(player)).toBe(OPENING_GRANT - CASUAL_BUY_IN);
  });

  it("refuses a claim on another account's idempotency key", async () => {
    const player = await createPlayer();
    const thief = await createPlayer();
    const opened = await openTable(player);
    const stolen = {
      gameId: opened.body.gameId,
      clientActionId: crypto.randomUUID(),
      type: "PLACE_BET",
      payload: { amount: 100 },
      expectedVersion: (opened.body.publicState as { version: number }).version,
      clientSentAt: iso(),
    };
    await call("game-command", player.token, stolen);
    const replayed = await call("game-command", thief.token, stolen);
    // Not a hit: the caller holds no seat at that table at all.
    expect(replayed.status).toBe(403);
    expect(replayed.body.code).toBe("NOT_A_PARTICIPANT");
  });
});

// ---------------------------------------------------------------------------
// §L — intentional failures, and what they must leave behind
// ---------------------------------------------------------------------------

suite("an intentional failure leaves no partial economic mutation", () => {
  it("writes no session, no seat and no ledger row when a buy-in is refused", async () => {
    /*
     * `open()` inserts the session row, the seat row and the engine state and
     * debits LAST, so the wallet lock is held for the shortest possible time.
     * That ordering is what makes this worth asserting: any refusal after those
     * inserts must unwind all four, and the only evidence is that nothing is
     * left behind.
     *
     * The reachable refusal for a fresh account is the tier's unlock level —
     * High opens at level 10. The overdraft branch, which fires from the CHECK
     * constraint inside `apply_wallet_delta`, is asserted at the constraint in
     * `02_wallets.test.sql`; it cannot be provoked over HTTP without playing an
     * account broke, and a test that plays until broke has no bound.
     */
    const player = await createPlayer();
    const before = await walletOf(player);
    const ledgerBefore = await ledgerOf(player);

    const refused = await call("create-session", player.token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "high",
      clientSentAt: iso(),
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("TABLE_LOCKED");

    expect(await walletOf(player)).toEqual(before);
    expect(await ledgerOf(player)).toHaveLength(ledgerBefore.length);
    // No seat, and therefore no lock-out either: a refused buy-in must not
    // leave the player holding a seat they were never charged for.
    const seats = await asPlayer(
      player.token,
      `game_session_seats?select=id&user_id=eq.${player.id}&status=neq.left`,
    );
    expect(seats.body).toEqual([]);
    expect((await rpc(player.token, "my_active_session")).body).toEqual([]);
  });

  it("moves nothing when a cash-out is refused mid-hand", async () => {
    const player = await createPlayer();
    const opened = await openTable(player);
    const table: Table = {
      gameId: opened.body.gameId as string,
      seatId: opened.body.seatId as string,
      version: (opened.body.publicState as { version: number }).version,
    };
    await reachPlayerTurns(player, table);

    const before = await balanceOf(player);
    const refused = await call("create-session", player.token, {
      action: "CASH_OUT",
      clientRequestId: crypto.randomUUID(),
      gameId: table.gameId,
      clientSentAt: iso(),
    });

    // "Leaving is never a way to escape a committed wager."
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("SESSION_BUSY");
    expect(await balanceOf(player)).toBe(before);
    // The seat is still held, and still escrowed.
    const seats = (
      await asPlayer(
        player.token,
        `game_session_seats?select=status&user_id=eq.${player.id}&game_session_id=eq.${table.gameId}`,
      )
    ).body as { status: string }[];
    expect(seats[0]?.status).toBe("active");
    expect((await ledgerOf(player)).filter((r) => r.reason === "table_cash_out")).toHaveLength(0);
  }, 60_000);

  it("pays nothing when a recovery grant is refused", async () => {
    const player = await createPlayer();
    const before = await walletOf(player);
    const refused = await rpc(player.token, "claim_recovery_grant");

    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await walletOf(player)).toEqual(before);
    expect((await ledgerOf(player)).filter((r) => r.reason === "recovery_grant")).toHaveLength(0);
  });

  it("pays no career reward for an attempt the caller does not own", async () => {
    /*
     * The cheap half of the career rollback. `career.integration.test.ts` walks
     * two standard nodes to reach a real drill and asserts there that a
     * wrong-length answer sheet grades nothing and pays nothing; repeating that
     * walk here would cost five minutes to re-prove it.
     *
     * What is asserted here is the identity check that stands in front of it:
     * the attempt is named by the CLIENT, and `submitCareerDrill` compares its
     * `user_id` against the verified JWT before anything is graded.
     */
    const player = await createPlayer();
    const before = await walletOf(player);

    for (const attemptId of [crypto.randomUUID(), "00000000-0000-4000-8000-0000000000aa"]) {
      const response = await call("create-session", player.token, {
        action: "SUBMIT_CAREER_DRILL",
        clientRequestId: crypto.randomUUID(),
        attemptId,
        answers: ["HIT", "STAND"],
        clientSentAt: iso(),
      });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("NOT_A_PARTICIPANT");
    }

    expect(await walletOf(player)).toEqual(before);
    expect((await ledgerOf(player)).filter((r) => r.reason === "career_reward")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §I — the Recovery Grant
// ---------------------------------------------------------------------------

suite("the Recovery Grant is decided entirely by the server", () => {
  /** Reach eligibility through real wagers; never seed a wallet or a shoe. */
  async function playDownToGrant(player: Player): Promise<number> {
    let balance = await balanceOf(player);
    for (let hand = 0; hand < 200 && balance >= GRANT_THRESHOLD; hand++) {
      const standard = balance >= 5_000;
      const opened = await call("create-session", player.token, {
        action: "OPEN",
        clientRequestId: crypto.randomUUID(),
        tier: standard ? "standard" : "casual",
        clientSentAt: iso(),
      });
      expect(opened.status, opened.raw).toBe(200);
      const table: Table = {
        gameId: opened.body.gameId as string,
        seatId: opened.body.seatId as string,
        version: (opened.body.publicState as { version: number }).version,
      };
      const command = async (type: string, payload?: Record<string, unknown>) => {
        const result = await send(player, table, type, payload);
        expect(result.response.status, result.response.raw).toBe(200);
        return result.phase;
      };
      await command("PLACE_BET", { amount: standard ? 1_000 : 500 });
      let phase = await command("LOCK_BET");
      if (phase === "INSURANCE_OFFER") phase = await command("DECLINE_INSURANCE");
      // Naturals resolve at the peek. Otherwise deliberately surrender: this
      // tests spending, not profitable strategy, and needs no chosen cards.
      if (phase === "PLAYER_TURNS") phase = await command("SURRENDER");
      expect(phase).toBe("HAND_COMPLETE");
      const cashed = await call("create-session", player.token, {
        action: "CASH_OUT",
        clientRequestId: crypto.randomUUID(),
        gameId: table.gameId,
        clientSentAt: iso(),
      });
      expect(cashed.status, cashed.raw).toBe(200);
      balance = await balanceOf(player);
      expect(balance).toBeGreaterThanOrEqual(0);
    }
    expect(balance).toBeLessThan(GRANT_THRESHOLD);
    expect((await rpc(player.token, "my_active_session")).body).toEqual([]);
    return balance;
  }

  it("refuses a player who is not broke, and says why", async () => {
    const player = await createPlayer();
    const refused = await rpc(player.token, "claim_recovery_grant");
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.body)).toContain(String(GRANT_THRESHOLD));
    expect(await balanceOf(player)).toBe(OPENING_GRANT);
  });

  it("takes no balance, no amount and no clock from the caller", async () => {
    /*
     * "A modified clock/client cannot bypass cooldown", enforced by giving the
     * client nothing to lie with. `claim_recovery_grant()` has no parameters at
     * all: the identity comes from the verified session, the balance is read
     * under a row lock, the amount is computed from it, and the cooldown is
     * measured against `now()` inside the same transaction. PostgREST cannot
     * even resolve an overload that accepts an argument.
     */
    const player = await createPlayer();
    for (const args of [
      { p_amount: 1_000_000 },
      { p_balance: 0 },
      { p_now: "1999-01-01T00:00:00Z" },
      { p_user_id: player.id },
    ]) {
      const response = await rpc(player.token, "claim_recovery_grant", args);
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).toContain("PGRST202");
    }
    expect(await balanceOf(player)).toBe(OPENING_GRANT);
    expect((await ledgerOf(player)).filter((r) => r.reason === "recovery_grant")).toHaveLength(0);
  });

  it("grants exactly once in an eligible eight-client race and enforces the cooldown", async () => {
    const player = await createPlayer();
    const before = await playDownToGrant(player);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => rpc(player.token, "claim_recovery_grant")),
    );
    const granted = results.filter((result) => result.status === 200);
    expect(granted).toHaveLength(1);
    expect(results.filter((result) => result.status >= 500)).toHaveLength(0);

    const rows = (await ledgerOf(player)).filter((r) => r.reason === "recovery_grant");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      balance_after: GRANT_RESTORES_TO,
      delta: GRANT_RESTORES_TO - before,
    });
    expect(await balanceOf(player)).toBe(GRANT_RESTORES_TO);
    expect((await ledgerOf(player)).reduce((sum, row) => sum + row.delta, 0)).toBe(GRANT_RESTORES_TO);

    // Lower the available wallet again through a real buy-in. This refusal
    // must now be the cooldown, not the balance guard that the old test hit.
    const opened = await call("create-session", player.token, {
      action: "OPEN", clientRequestId: crypto.randomUUID(), tier: "standard", clientSentAt: iso(),
    });
    expect(opened.status, opened.raw).toBe(200);
    expect(await balanceOf(player)).toBe(0);
    const cooldown = await rpc(player.token, "claim_recovery_grant");
    expect(cooldown.status).toBe(400);
    expect(JSON.stringify(cooldown.body)).toContain("next recovery grant");
    const closed = await call("create-session", player.token, {
      action: "CASH_OUT", clientRequestId: crypto.randomUUID(), gameId: opened.body.gameId,
      clientSentAt: iso(),
    });
    expect(closed.status, closed.raw).toBe(200);
    expect(await balanceOf(player)).toBe(GRANT_RESTORES_TO);
    expect((await ledgerOf(player)).filter((row) => row.reason === "recovery_grant")).toHaveLength(1);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// §M — the modified client
// ---------------------------------------------------------------------------

suite("a modified client cannot credit itself", () => {
  let player: Player;
  let stranger: Player;
  let gameId: string;
  let version: number;

  beforeAll(async () => {
    player = await createPlayer();
    stranger = await createPlayer();
    const opened = await openTable(player);
    gameId = opened.body.gameId as string;
    version = (opened.body.publicState as { version: number }).version;
  });

  /*
   * `tests/wallet/no-write-path.test.ts` scans the SOURCE for a client write.
   * That proves what this app says; these prove what the server does. Both are
   * worth having — a source scan cannot see a request made by hand.
   */

  it("cannot set its own balance", async () => {
    const response = await asPlayer(player.token, `wallets?user_id=eq.${player.id}`, {
      method: "PATCH",
      body: JSON.stringify({ balance: 999_999 }),
    });
    expect(response.status).toBe(403);
    expect(await balanceOf(player)).toBe(OPENING_GRANT - CASUAL_BUY_IN);
  });

  it("cannot write a ledger row", async () => {
    const response = await asPlayer(player.token, "wallet_ledger", {
      method: "POST",
      body: JSON.stringify({
        user_id: player.id,
        delta: 5_000,
        balance_after: 30_000,
        reason: "correction",
        idempotency_key: `forged:${player.id}`,
      }),
    });
    expect(response.status).toBe(403);
  });

  it("cannot erase its own history", async () => {
    const response = await asPlayer(player.token, `wallet_ledger?user_id=eq.${player.id}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(403);
    expect((await ledgerOf(player)).length).toBeGreaterThan(0);
  });

  it("cannot reach the only function that moves a chip", async () => {
    const response = await rpc(player.token, "apply_wallet_delta", {
      p_user_id: player.id,
      p_delta: 100_000,
      p_reason: "correction",
      p_idempotency_key: `hack:${player.id}`,
    });
    expect(response.status).toBe(403);
    expect(await balanceOf(player)).toBe(OPENING_GRANT - CASUAL_BUY_IN);
  });

  it("cannot enlarge its own table stack", async () => {
    const response = await asPlayer(player.token, `game_session_seats?user_id=eq.${player.id}`, {
      method: "PATCH",
      body: JSON.stringify({ stack: 999_999 }),
    });
    expect(response.status).toBe(403);
  });

  it("cannot submit its own statistics", async () => {
    // §J: competitive statistics are derived from committed settlements, never
    // sent. The client has no write on the table that holds them.
    const response = await asPlayer(player.token, `player_stats?user_id=eq.${player.id}`, {
      method: "PATCH",
      body: JSON.stringify({ chips_net: 999_999, hands_won: 9_999 }),
    });
    expect(response.status).toBe(403);
  });

  it("cannot award itself XP or a level", async () => {
    const response = await asPlayer(player.token, `profiles?id=eq.${player.id}`, {
      method: "PATCH",
      body: JSON.stringify({ xp: 999_999, level: 50 }),
    });
    // The row is the caller's own and the policy permits a rename, so the
    // refusal must come from the column grant rather than from RLS.
    expect(response.status).toBe(403);
  });

  it.each([
    ["a wager larger than the stack", 500_000, 422],
    ["a negative wager", -100, 400],
    ["a fractional wager", 12.5, 400],
    ["a wager beyond the contract ceiling", 9e15, 400],
  ])("refuses %s", async (_label, amount, expected) => {
    const response = await call("game-command", player.token, {
      gameId,
      clientActionId: crypto.randomUUID(),
      type: "PLACE_BET",
      payload: { amount },
      expectedVersion: version,
      clientSentAt: iso(),
    });
    expect(response.status).toBe(expected);
    expect(await balanceOf(player)).toBe(OPENING_GRANT - CASUAL_BUY_IN);
  });

  it("refuses another account's game command", async () => {
    const response = await call("game-command", stranger.token, {
      gameId,
      clientActionId: crypto.randomUUID(),
      type: "PLACE_BET",
      payload: { amount: 100 },
      expectedVersion: version,
      clientSentAt: iso(),
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("NOT_A_PARTICIPANT");
    expect(await balanceOf(stranger)).toBe(OPENING_GRANT);
  });

  it("applies nothing for a stale version, and hands back the authoritative state", async () => {
    const response = await call("game-command", player.token, {
      gameId,
      clientActionId: crypto.randomUUID(),
      type: "PLACE_BET",
      payload: { amount: 100 },
      expectedVersion: 0,
      clientSentAt: iso(),
    });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("stale");
    expect((response.body.publicState as { version: number }).version).toBe(version);
    expect(await balanceOf(player)).toBe(OPENING_GRANT - CASUAL_BUY_IN);
  });

  it("cannot buy a second seat by replaying the buy-in with a fresh id", async () => {
    const response = await call("create-session", player.token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      clientSentAt: iso(),
    });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("SESSION_ALREADY_ACTIVE");
    expect(await balanceOf(player)).toBe(OPENING_GRANT - CASUAL_BUY_IN);
    expect((await ledgerOf(player)).filter((r) => r.reason === "table_buy_in")).toHaveLength(1);
  });
});
