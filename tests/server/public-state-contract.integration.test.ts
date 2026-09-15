/**
 * The wire contract, against the REAL server.
 *
 * `tests/contracts/public-state-contract.test.ts` compares the schema with the
 * ENGINE's payload, which is the right comparison for a field the engine
 * computes. It cannot see one thing: what the SERVER adds on the way out.
 * `game-command` attaches `advice` after sanitisation, `create-session` builds
 * its own opening reply, and either could grow a field the client's schema has
 * never heard of.
 *
 * That matters more since `legalActionSetSchema` became strict. Strict is the
 * right default — it was the one schema in `shared/contracts` that was not, and
 * the field it silently deleted was the only way to play a second hand at a
 * server table — but strict turns "the server sent something new" from a silent
 * strip into a hard refusal, and the place to find that out is here rather than
 * on a player's screen.
 *
 * So this parses what the running Edge Functions actually return, at every phase
 * a table passes through, with EXACTLY the schema the client uses.
 */

import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { publicGameStateSchema } from "../../shared/contracts/index.js";
import { callFunction as call } from "./call-function.js";
import { stackUp } from "./stack-guard.js";

const AUTH_ADMIN = "http://127.0.0.1:54321/auth/v1/admin/users";

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** No `iat` — PostgREST rejects one that is ahead of its own clock. */
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

async function createUser(): Promise<string> {
  const response = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      email: `contract-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return json.id;
}

const iso = () => new Date().toISOString();
const suite = stackUp ? describe : describe.skip;

suite("what the server actually puts on the wire", () => {
  let token = "";
  let gameId = "";
  let seatId = "";
  /** One snapshot per phase the table passed through, as the server sent it. */
  const seen = new Map<string, unknown>();

  /** Parsed with the client's own schema, and told which phase failed. */
  function accept(label: string, payload: unknown): void {
    const parsed = publicGameStateSchema.safeParse(payload);
    expect(
      parsed.success,
      `${label}: ${JSON.stringify(parsed.error?.issues ?? [], null, 2)}`,
    ).toBe(true);
  }

  beforeAll(async () => {
    if (!stackUp) return;
    token = signToken(await createUser());

    // `learn` assistance on purpose: it is the only setting under which the
    // server attaches `advice` to the payload, and advice is exactly the kind of
    // server-side addition a schema derived from the engine cannot know about.
    const opened = await call("create-session", token, {
      action: "OPEN",
      clientRequestId: crypto.randomUUID(),
      tier: "casual",
      assistance: "learn",
      clientSentAt: iso(),
    });
    if (opened.status !== 200) {
      throw new Error(`could not open a table: HTTP ${opened.status} ${opened.raw}`);
    }
    gameId = String(opened.body.gameId);
    seatId = String(opened.body.seatId);
    seen.set("create-session OPEN", opened.body.publicState);

    /**
     * `phase` is deliberately a bare `string`. Typing it as the phase union
     * lets TypeScript narrow it from the loop guard and then reject every later
     * comparison as impossible — which is a statement about one iteration, not
     * about a value the server replaces on every reply.
     */
    interface Tracked {
      version: number;
      phase: string;
      activeSeatId: string | null;
    }
    let state = opened.body.publicState as unknown as Tracked;
    const send = async (type: string, payload?: Record<string, unknown>) => {
      const result = await call("game-command", token, {
        gameId,
        clientActionId: crypto.randomUUID(),
        type,
        ...(payload ? { payload } : {}),
        expectedVersion: state.version,
        clientSentAt: iso(),
      });
      if (result.status !== 200) {
        throw new Error(`${type} was refused: HTTP ${result.status} ${result.raw}`);
      }
      const next = result.body.publicState as unknown as Tracked;
      state = next;
      // Keyed by phase, so a full hand contributes one snapshot per phase it
      // actually reached rather than one per command.
      seen.set(`game-command ${next.phase}`, next);
      return result;
    };

    /*
     * Read through a call, never as `state.phase` directly. TypeScript narrows
     * the property from the loop guard and then rejects every later comparison
     * as impossible — a statement about one iteration, not about a value the
     * server replaces on each reply. `playOut` in
     * `game-command.integration.test.ts` uses the same `phaseNow()` for the same
     * reason.
     */
    const phaseNow = (): string => state.phase;

    // Up to eight hands, which is enough to meet an insurance offer more often
    // than not — that phase carries the fields the drift was found in.
    for (let hand = 1; hand <= 8; hand += 1) {
      if (phaseNow() !== "BETTING_OPEN") break;
      await send("PLACE_BET", { amount: 50 });
      await send("LOCK_BET");
      for (let step = 0; step < 30 && phaseNow() !== "HAND_COMPLETE"; step += 1) {
        if (phaseNow() === "INSURANCE_OFFER") {
          await send("DECLINE_INSURANCE");
          continue;
        }
        if (phaseNow() === "PLAYER_TURNS" && state.activeSeatId === seatId) {
          await send("STAND");
          continue;
        }
        break;
      }
      if (phaseNow() !== "HAND_COMPLETE") break;
      // The stale read the table polls on every three seconds. It is a
      // different code path from a command reply and returns its own payload.
      const poll = await call("game-command", token, {
        gameId,
        clientActionId: crypto.randomUUID(),
        type: "RESOLVE_TIMEOUT",
        payload: {},
        expectedVersion: 0,
        clientSentAt: iso(),
      });
      expect(poll.status).toBe(200);
      expect(poll.body.status).toBe("stale");
      seen.set("poll (stale)", poll.body.publicState);

      await send("NEXT_HAND");
    }
  }, 120_000);

  it("sends a payload the client's schema accepts, at every phase", () => {
    // Not a formality: a table that never left BETTING_OPEN would pass an
    // "every snapshot parses" test having proved almost nothing.
    expect(seen.size).toBeGreaterThanOrEqual(4);
    for (const [label, payload] of seen) accept(label, payload);
  });

  /**
   * The specific field, from the SERVER rather than from the engine. The client
   * schema dropped it for a whole phase and the button it gates was never
   * rendered at any server table.
   */
  it("sends canStartNextHand, and the client keeps it", () => {
    const settled = seen.get("game-command HAND_COMPLETE");
    expect(settled, "no hand reached HAND_COMPLETE").toBeDefined();
    const parsed = publicGameStateSchema.parse(settled);
    expect(parsed.legalActions[seatId]?.canStartNextHand).toBe(true);
  });

  /**
   * `advice` is attached by the server AFTER sanitisation, so the engine-side
   * contract test cannot see it. A `learn` table is the only place it appears.
   */
  it("keeps the server's own additions rather than stripping them", () => {
    // Named rather than searched for, so this cannot pass by finding nothing.
    // Eight hands at a `learn` table always reach a pending decision at least
    // once; a run that did not would be worth failing on by itself.
    const turn = seen.get("game-command PLAYER_TURNS");
    expect(turn, "no hand reached PLAYER_TURNS in eight tries").toBeDefined();

    const parsed = publicGameStateSchema.parse(turn);
    expect(parsed.advice, "a learn table must carry the server's recommendation").toBeDefined();
    expect(parsed.advice?.seatId).toBe(seatId);
    // The advisor's answer, not a placeholder — and `actionEvMicros` is null on
    // `learn`, which is `analysis`-only.
    expect(parsed.advice?.recommended).toMatch(/^(HIT|STAND|DOUBLE|SPLIT|SURRENDER)$/);
    expect(parsed.advice?.actionEvMicros).toBeNull();
  });
});
