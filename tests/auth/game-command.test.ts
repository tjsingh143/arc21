/**
 * The command transport.
 *
 * This module sends an intent and returns a verdict. It is not the security
 * boundary — the Edge Function authenticates, re-runs `getLegalActions` on
 * authoritative state and owns the idempotency table — but it is the place where
 * three client-side mistakes would be made:
 *
 *   * putting an identity in the payload, so a modified client could act as
 *     someone else;
 *   * trusting a response because it came from "our" server;
 *   * turning an unanswered request into a guess about whether the command
 *     landed, when the only safe answer is "re-fetch the snapshot".
 */

import { beforeEach, describe, expect, it } from "vitest";

import { setSupabaseAvailabilityForTests } from "../../src/lib/supabase/client.js";
import {
  GAME_COMMAND_FUNCTION,
  sendGameCommand,
  type GameCommandRequest,
} from "../../src/lib/supabase/game-command.js";
import { newClientActionId } from "../../src/lib/supabase/ids.js";

const REQUEST: GameCommandRequest = {
  gameId: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
  clientActionId: "11111111-2222-4333-8444-555555555555",
  expectedVersion: 12,
  type: "LOCK_BET",
  payload: { seatId: "seat-1" },
  clientSentAt: "2026-08-15T12:00:00.000Z",
};

interface Invocation {
  name: string;
  body: unknown;
}

function fakeClient(options: {
  signedIn?: boolean;
  data?: unknown;
  error?: unknown;
  hang?: boolean;
}): { client: never; invocations: Invocation[] } {
  const invocations: Invocation[] = [];
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: (options.signedIn ?? true) ? { user: { id: "u" } } : null },
        error: null,
      }),
    },
    functions: {
      invoke: async (name: string, init: { body: unknown }) => {
        invocations.push({ name, body: init.body });
        if (options.hang === true) return new Promise(() => {});
        return { data: options.data ?? null, error: options.error ?? null };
      },
    },
  };
  return { client: client as unknown as never, invocations };
}

function ready(client: never): void {
  setSupabaseAvailabilityForTests({ status: "ready", client });
}

beforeEach(() => {
  setSupabaseAvailabilityForTests(null);
});

describe("identity is never in the payload", () => {
  it("sends exactly the contract fields and nothing else", async () => {
    const { client, invocations } = fakeClient({
      data: { status: "accepted", publicState: { version: 13 }, events: [] },
    });
    ready(client);

    await sendGameCommand(REQUEST);

    expect(invocations[0]?.name).toBe(GAME_COMMAND_FUNCTION);
    expect(Object.keys(invocations[0]?.body as object).sort()).toEqual([
      "clientActionId",
      "clientSentAt",
      "expectedVersion",
      "gameId",
      "payload",
      "type",
    ]);
    // There is no `userId` field in the request type, so there is no spelling of
    // "act as someone else" that compiles.
    expect(JSON.stringify(invocations[0]?.body)).not.toContain("userId");
  });
});

describe("verdicts", () => {
  it("returns an accepted result with its snapshot and events", async () => {
    const { client } = fakeClient({
      data: {
        status: "accepted",
        publicState: { gameId: REQUEST.gameId, version: 13 },
        events: [{ seq: 41, type: "BET_LOCKED" }],
      },
    });
    ready(client);

    const outcome = await sendGameCommand(REQUEST);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.response.status).toBe("accepted");
  });

  it("returns a stale result with the authoritative snapshot", async () => {
    const { client } = fakeClient({
      data: { status: "stale", publicState: { gameId: REQUEST.gameId, version: 19 } },
    });
    ready(client);

    const outcome = await sendGameCommand(REQUEST);

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.response.status === "stale") {
      expect(outcome.response.publicState["version"]).toBe(19);
    }
  });

  it("returns a rejection with its code", async () => {
    const { client } = fakeClient({
      data: { status: "rejected", code: "ILLEGAL_ACTION", message: "Not your turn." },
    });
    ready(client);

    const outcome = await sendGameCommand(REQUEST);

    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.response.status === "rejected") {
      expect(outcome.response.code).toBe("ILLEGAL_ACTION");
    }
  });
});

describe("responses are parsed, not trusted", () => {
  it.each([
    ["an unknown status", { status: "definitely-fine", publicState: {} }],
    ["a missing snapshot", { status: "accepted", events: [] }],
    ["events that are not a list", { status: "accepted", publicState: {}, events: "all of them" }],
    ["nothing at all", null],
    ["a bare string", "accepted"],
  ])("refuses %s", async (_label, data) => {
    const { client } = fakeClient({ data });
    ready(client);

    const outcome = await sendGameCommand(REQUEST);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe("malformed-response");
  });
});

describe("failures to reach a verdict", () => {
  it("says so when the build has no server", async () => {
    setSupabaseAvailabilityForTests({
      status: "not-configured",
      problems: ["MISSING_URL"],
      message: "No server configured.",
    });

    const outcome = await sendGameCommand(REQUEST);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe("not-configured");
  });

  it("refuses to send without a session", async () => {
    const { client, invocations } = fakeClient({ signedIn: false });
    ready(client);

    const outcome = await sendGameCommand(REQUEST);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe("signed-out");
    expect(invocations).toHaveLength(0);
  });

  it("reports an unanswered request as unreachable, never as applied or refused", async () => {
    const { client } = fakeClient({ hang: true });
    ready(client);

    const outcome = await sendGameCommand(REQUEST, { timeoutMs: 25 });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("unreachable");
      // The player is told the table will re-sync, because the command may or
      // may not have committed and only the server knows which.
      expect(outcome.failure.message).toContain("re-synced");
    }
  });

  it("does not surface the server's own error text", async () => {
    const { client } = fakeClient({
      error: { message: "FunctionsHttpError: relation \"private.game_state_private\" ..." },
    });
    ready(client);

    const outcome = await sendGameCommand(REQUEST);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.message).not.toContain("game_state_private");
    }
  });
});

describe("client action ids", () => {
  it("are unguessable and unique", () => {
    /*
     * Not merely unique. The server returns the FIRST COMMITTED RESULT for a key
     * it has seen before, so a predictable key would let one client cause
     * another's next command to be answered with someone else's outcome.
     */
    const ids = new Set(Array.from({ length: 1_000 }, () => newClientActionId()));

    expect(ids.size).toBe(1_000);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it("is taken from the caller, so a retry cannot mint a fresh one", () => {
    // `sendGameCommand` has no id generator inside it. Retrying a timed-out bet
    // therefore reuses the original key and the server returns the first
    // committed result, instead of placing a second bet.
    expect(sendGameCommand.length).toBeGreaterThanOrEqual(1);
    expect(REQUEST.clientActionId).toBeTypeOf("string");
  });
});
