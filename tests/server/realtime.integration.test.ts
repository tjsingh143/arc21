/**
 * Realtime broadcast and stale-version recovery, against the REAL Edge
 * Functions, the REAL database and the REAL Realtime server.
 *
 * Two acceptance properties, proved with ONE two-client scenario rather than
 * reasoned about from the code:
 *
 *   - "Reconnect" (SOCIAL): a second client that is only listening — never
 *     polling — receives the first client's action over its subscribed
 *     channel. That is what lets a client that dropped and came back catch up
 *     without the player doing anything.
 *   - "Stale versions recover" (MULTIPLAYER): a client acting on a version the
 *     server has already moved past gets `stale` and the authoritative
 *     snapshot back, with nothing applied — never a silent second commit.
 *
 * `broadcastSnapshot` (supabase/functions/_shared/realtime-broadcast.ts) fires
 * AFTER commit, over the service-role broadcast REST API, on the topic
 * `game:<gameId>` — the same one `online-table-gateway.ts`'s `subscribe`
 * listens to. This file is the other end of that channel.
 *
 * A SKIP IS NOT A PASS. The guard requires a 401 from a function, because the
 * API gateway answers 503 with the Edge runtime stopped and an "any response"
 * check once reported the stack as up while nine tests failed instead of
 * skipping.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { callFunction as call } from "./call-function.js";
import { stackUp } from "./stack-guard.js";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";


const SUPABASE_URL = "http://127.0.0.1:54321";
const REST = `${SUPABASE_URL}/rest/v1`;
const AUTH_ADMIN = `${SUPABASE_URL}/auth/v1/admin/users`;

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * The test tokens carry NO `iat`, deliberately.
 *
 * PostgREST validates `iat` against its own clock and answers
 * `PGRST303 "JWT issued at future"` when it is ahead — and the failure does not
 * look like a clock problem. It looks like a wallet that reads as -1, a profile
 * column that reads as null, or a career reward that was never paid.
 *
 * Backdating by a minute was the first fix and it was not enough: the Docker VM
 * clock jumps rather than drifts, so any constant is a guess about how far.
 * `iat` is an OPTIONAL claim that PostgREST validates only when present, and
 * nothing in this app reads it, so omitting it removes the failure mode instead
 * of narrowing it. `exp` still bounds the token, and an `exp` an hour out is
 * safe against skew in the direction that matters.
 *
 * Test-only: Supabase issues real tokens server-side, where there is one clock.
 */
function signToken(sub: string): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({ sub, role: "authenticated", aud: "authenticated", exp: now + 3600 });
  const signature = crypto
    .createHmac("sha256", LOCAL_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function createUser(): Promise<string> {
  const response = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      email: `it-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return json.id;
}



async function rpc(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${REST}/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args),
  });
  const raw = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: response.status, body: parsed };
}

const iso = () => new Date().toISOString();

const suite = stackUp ? describe : describe.skip;

let openClients: SupabaseClient[] = [];
afterEach(async () => {
  for (const client of openClients) await client.realtime.disconnect();
  openClients = [];
});

suite("realtime broadcast and stale-version recovery", () => {
  it(
    "delivers a broadcast to a listening client, and answers a stale command with the same state",
    async () => {
      const hostId = await createUser();
      const guestId = await createUser();
      const host = signToken(hostId);
      const guest = signToken(guestId);

      const created = await rpc(host, "create_private_room", { p_max_seats: 2 });
      const room = (Array.isArray(created.body) ? created.body[0] : created.body) as {
        id: string;
        code: string;
      };
      await rpc(guest, "join_private_room", { p_code: room.code });

      const started = await call("create-session", host, {
        action: "START_PRIVATE_TABLE",
        clientRequestId: crypto.randomUUID(),
        roomId: room.id,
        clientSentAt: iso(),
      });
      expect(started.status).toBe(200);
      const initialState = started.body.publicState as { gameId: string; version: number };
      const gameId = initialState.gameId;
      const startingVersion = initialState.version;

      // A second client that only LISTENS — it never calls `game-command` or
      // `snapshot`, so anything it learns arrived over the channel alone. This
      // is the "reconnect" proof: the guest's screen would update with no poll
      // and no action of its own.
      //
      // AUTHENTICATED, and the channel is PRIVATE. The topic used to be neither:
      // this client held the anon key and nothing else, and it worked. That was
      // the defect — see `20260831120000_realtime_channel_authorization.sql`.
      // The guest's token is used because the guest holds a seat at this table,
      // which is now exactly what the read policy asks for.
      //
      // BOTH `accessToken` AND `setAuth`, and neither alone is enough. Measured,
      // in both directions:
      //
      //   * `setAuth(guest)` alone SUBSCRIBES and then receives nothing. A
      //     client built by `createClient` runs its own auth listener, and this
      //     one holds no session, so shortly after start-up it sets the socket's
      //     token back to the anon key — after the explicit call. The channel
      //     joins as the guest and is refused as `anon` when Realtime re-checks
      //     it to deliver, so the failure appears as a message that never
      //     arrives rather than as a subscribe error.
      //   * `accessToken` alone never subscribes at all: it is what the SDK uses
      //     for PostgREST, and it does not reach the socket by itself.
      //
      // This is CLAUDE.md's "a test client must mirror the real client's auth
      // options" one layer down — the real app holds a genuine session, so it
      // has neither problem.
      const listener = createClient(SUPABASE_URL, LOCAL_ANON_KEY, {
        accessToken: async () => guest,
      });
      listener.realtime.setAuth(guest);
      openClients.push(listener);
      const received: Array<{ publicState: { version: number; phase: string } }> = [];

      const subscribed = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("channel did not subscribe in time")), 5_000);
        const channel: RealtimeChannel = listener
          .channel(`game:${gameId}`, { config: { private: true } })
          .on("broadcast", { event: "state" }, (message: { payload: unknown }) => {
            received.push(message.payload as { publicState: { version: number; phase: string } });
          })
          .subscribe((status: string) => {
            if (status === "SUBSCRIBED") {
              clearTimeout(timer);
              resolve();
            }
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              clearTimeout(timer);
              reject(new Error(`channel subscribe failed: ${status}`));
            }
          });
      });
      await subscribed;

      // The host acts. This is the only place any command is sent for the
      // guest's state to change.
      const placed = await call("game-command", host, {
        gameId,
        clientActionId: crypto.randomUUID(),
        expectedVersion: startingVersion,
        type: "PLACE_BET",
        payload: { amount: 100 },
        clientSentAt: iso(),
      });
      expect(placed.status).toBe(200);
      const newVersion = (placed.body.publicState as { version: number }).version;
      expect(newVersion).toBeGreaterThan(startingVersion);

      // Poll the in-memory buffer rather than the network — the broadcast
      // already happened or it did not; this just waits for this process to
      // have received it.
      const deadline = Date.now() + 5_000;
      while (received.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // eslint-disable-next-line no-console
      console.log(
        "[realtime proof] broadcasts received by the listening-only client:",
        JSON.stringify(received),
      );
      expect(received.length).toBeGreaterThan(0);
      expect(received[0]?.publicState.version).toBe(newVersion);

      // Now the guest, whose own idea of the version is still the STARTING
      // one, sends a command at that stale version. The server must not apply
      // it — it must answer with the authoritative snapshot instead.
      const stale = await call("game-command", guest, {
        gameId,
        clientActionId: crypto.randomUUID(),
        expectedVersion: startingVersion,
        type: "STAND",
        payload: {},
        clientSentAt: iso(),
      });

      // eslint-disable-next-line no-console
      console.log("[stale-version proof] response to the guest's stale command:", JSON.stringify(stale.body));
      expect(stale.status).toBe(200);
      expect(stale.body.status).toBe("stale");
      expect((stale.body.publicState as { version: number }).version).toBe(newVersion);
    },
    15_000,
  );
});

/**
 * ROOM ISOLATION — the half of "Realtime" that was never a rule.
 *
 * `game:<gameId>` was a PUBLIC broadcast topic. Both of these were measured
 * against the running stack before the policies existed, and both succeeded:
 *
 *   * a client holding nothing but the anon key subscribed and received a
 *     table's fan-out in full — every seat's display name, stack and posted
 *     bet. `game_session_seats` is readable only by a participant, so the
 *     broadcast went around its own RLS.
 *   * a second account broadcast `{ event: "state", … }` onto the topic and a
 *     seated player's handler received it. `subscribe()` parses whatever
 *     arrives and hands it to `applyPushedState`, so that is a forged table on
 *     another player's screen — a client-supplied state, which invariant 6
 *     exists to forbid.
 *
 * Both are now refused by `realtime.messages` policies, and these two tests are
 * the reason they cannot come back. They assert the REFUSAL, not the absence of
 * a message: a channel that silently receives nothing would pass a weaker test
 * written the obvious way.
 */
suite("a game topic belongs to the players at that game", () => {
  it(
    "refuses a subscriber who holds no seat, and an anonymous one",
    async () => {
      const hostId = await createUser();
      const host = signToken(hostId);
      const created = await rpc(host, "create_private_room", { p_max_seats: 2 });
      const room = (Array.isArray(created.body) ? created.body[0] : created.body) as {
        id: string;
        code: string;
      };
      // A table needs both its seats filled before the host may deal.
      expect((await rpc(signToken(await createUser()), "join_private_room", { p_code: room.code })).status).toBe(200);

      const started = await call("create-session", host, {
        action: "START_PRIVATE_TABLE",
        clientRequestId: crypto.randomUUID(),
        roomId: room.id,
        clientSentAt: iso(),
      });
      expect(started.status).toBe(200);
      const gameId = (started.body.publicState as { gameId: string }).gameId;

      /** Subscribes and resolves with the status, or the error Realtime gave. */
      const join = async (token: string | null): Promise<string> => {
        const client =
          token === null
            ? createClient(SUPABASE_URL, LOCAL_ANON_KEY)
            : createClient(SUPABASE_URL, LOCAL_ANON_KEY, { accessToken: async () => token });
        if (token !== null) client.realtime.setAuth(token);
        openClients.push(client);
        return await new Promise<string>((resolve) => {
          const timer = setTimeout(() => resolve("TIMED_OUT"), 8_000);
          client
            .channel(`game:${gameId}`, { config: { private: true } })
            .subscribe((status: string, error?: Error) => {
              if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
                clearTimeout(timer);
                resolve(error ? `${status}: ${error.message}` : status);
              }
            });
        });
      };

      const strangerId = await createUser();
      const stranger = await join(signToken(strangerId));
      const anonymous = await join(null);

      // eslint-disable-next-line no-console
      console.log("[isolation proof] stranger:", stranger, "| anonymous:", anonymous);
      expect(stranger).not.toBe("SUBSCRIBED");
      expect(stranger).toContain("permissions");
      expect(anonymous).not.toBe("SUBSCRIBED");

      // AND THE OLD WAY IN. A plain, non-private subscribe is still allowed to
      // JOIN — a public topic is open to anyone by definition, and that is what
      // the client used to do. What it must no longer get is a message, because
      // the server now publishes privately. Asserting the join is refused would
      // have missed this: the exposure was never the join, it was the payload.
      const eavesdropper = createClient(SUPABASE_URL, LOCAL_ANON_KEY);
      openClients.push(eavesdropper);
      const overheard: unknown[] = [];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 8_000);
        eavesdropper
          .channel(`game:${gameId}`)
          .on("broadcast", { event: "state" }, (message: { payload: unknown }) => {
            overheard.push(message.payload);
          })
          .subscribe((status: string) => {
            if (status === "SUBSCRIBED") {
              clearTimeout(timer);
              resolve();
            }
          });
      });

      // Make the table produce a real broadcast while that socket is listening.
      const snapshot = await call("game-command", host, {
        gameId,
        clientActionId: crypto.randomUUID(),
        expectedVersion: 0,
        type: "RESOLVE_TIMEOUT",
        payload: {},
        clientSentAt: iso(),
      });
      const version = (snapshot.body.publicState as { version: number }).version;
      const bet = await call("game-command", host, {
        gameId,
        clientActionId: crypto.randomUUID(),
        expectedVersion: version,
        type: "PLACE_BET",
        payload: { amount: 20 },
        clientSentAt: iso(),
      });
      expect(bet.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      // eslint-disable-next-line no-console
      console.log("[isolation proof] a public subscriber overheard:", JSON.stringify(overheard));
      expect(overheard).toEqual([]);
    },
    30_000,
  );

  it(
    "refuses a forged state pushed by an account with no seat",
    async () => {
      const hostId = await createUser();
      const guestId = await createUser();
      const host = signToken(hostId);
      const guest = signToken(guestId);

      const created = await rpc(host, "create_private_room", { p_max_seats: 2 });
      const room = (Array.isArray(created.body) ? created.body[0] : created.body) as {
        id: string;
        code: string;
      };
      expect((await rpc(guest, "join_private_room", { p_code: room.code })).status).toBe(200);

      const started = await call("create-session", host, {
        action: "START_PRIVATE_TABLE",
        clientRequestId: crypto.randomUUID(),
        roomId: room.id,
        clientSentAt: iso(),
      });
      expect(started.status).toBe(200);
      const gameId = (started.body.publicState as { gameId: string }).gameId;

      // The guest is genuinely seated, so this listener is entitled to the topic.
      const listener = createClient(SUPABASE_URL, LOCAL_ANON_KEY, { accessToken: async () => guest });
      listener.realtime.setAuth(guest);
      openClients.push(listener);
      const received: unknown[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("seated listener did not subscribe")), 8_000);
        listener
          .channel(`game:${gameId}`, { config: { private: true } })
          .on("broadcast", { event: "state" }, (message: { payload: unknown }) => {
            received.push(message.payload);
          })
          .subscribe((status: string) => {
            if (status === "SUBSCRIBED") {
              clearTimeout(timer);
              resolve();
            }
          });
      });

      // A third account with no seat anywhere near this table pushes a state
      // through the broadcast API, which is the one route a client has left.
      const mallory = signToken(await createUser());
      const forged = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: LOCAL_ANON_KEY,
          Authorization: `Bearer ${mallory}`,
        },
        body: JSON.stringify({
          messages: [
            {
              topic: `game:${gameId}`,
              event: "state",
              private: true,
              payload: { publicState: { gameId, version: 9_999, phase: "HAND_COMPLETE" }, events: [] },
            },
          ],
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 3_000));

      // eslint-disable-next-line no-console
      console.log(
        "[injection proof] broadcast API answered",
        forged.status,
        "and the seated listener received",
        JSON.stringify(received),
      );
      // The endpoint may well ACCEPT the request — what must not happen is
      // delivery, so the assertion is about the seated player's screen.
      expect(received).toEqual([]);
    },
    30_000,
  );
});

/** The former global, client-authored roster must be inaccessible. Friend-only
 * server presence is proved in pseudonymous-identity.integration.test.ts. */
suite("the presence roster", () => {
  const PRESENCE_TOPIC = "presence:players";

  /** A client holding a genuine GoTrue session, as the app has. */
  async function signedIn(): Promise<{ id: string; client: SupabaseClient }> {
    const email = `presence-${crypto.randomUUID()}@arc21.test`;
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

    const client = createClient(SUPABASE_URL, LOCAL_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    openClients.push(client);
    const session = await client.auth.signInWithPassword({ email, password });
    if (session.error || !session.data.session) {
      throw new Error(`could not sign in: ${session.error?.message ?? "no session"}`);
    }
    return { id: account.id, client };
  }

  it("refuses the global roster for signed-in and unauthenticated sockets", async () => {
    const alice = await signedIn();
    const unauthenticated = createClient(SUPABASE_URL, LOCAL_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    openClients.push(unauthenticated);
    try {
      for (const client of [alice.client, unauthenticated]) {
        const status = await new Promise<string>((resolve) => {
          const timer = setTimeout(() => resolve("TIMED_OUT"), 8_000);
          client.channel(PRESENCE_TOPIC, { config: { presence: { key: alice.id }, private: true } })
            .subscribe((next) => {
              if (["SUBSCRIBED", "CHANNEL_ERROR", "TIMED_OUT"].includes(next)) {
                clearTimeout(timer); resolve(next);
              }
            });
        });
        // A transport timeout is not proof of an authorization refusal.
        expect(status).toBe("CHANNEL_ERROR");
      }
    } finally {
      const removed = await fetch(`${AUTH_ADMIN}/${alice.id}`, { method: "DELETE", headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${LOCAL_SERVICE_KEY}` } });
      expect(removed.ok).toBe(true);
    }
  }, 20_000);
});
