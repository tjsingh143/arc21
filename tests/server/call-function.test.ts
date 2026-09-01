/**
 * The Edge-Function caller's own contract.
 *
 * `call-function.ts` exists because the local Edge runtime retires a user worker
 * when its isolate trips the CPU soft limit, and answers a request already in
 * flight with HTTP 500 `WorkerAlreadyRetired` — AFTER that command has committed.
 * The full evidence is in that file's header.
 *
 * That condition cannot be provoked against the real stack: retirement is the
 * runtime's decision, not an input. So the sequence is reproduced against a stub
 * that answers exactly what the runtime was observed to answer, and the four
 * things the retry must get right are asserted directly.
 *
 * NEEDS NO SUPABASE STACK, and deliberately does not import `stack-guard.js`:
 * a helper that every server suite depends on should be provable without one.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { callFunctionAt } from "./call-function.js";

/** Verbatim from `docker logs supabase_edge_runtime_arc21`. */
const RETIRED_BODY = JSON.stringify({
  code: "Internal Server Error",
  message:
    "request cannot be handled because the worker has already retired: WorkerAlreadyRetired",
});

interface Received {
  readonly body: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
}

interface Stub {
  readonly base: string;
  readonly received: Received[];
  close(): Promise<void>;
}

/** Answers `replies[n]` to the n-th request, then repeats the last one forever. */
async function stubServer(replies: Array<{ status: number; body: string }>): Promise<Stub> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf8"),
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
      });
      const reply = replies[received.length - 1] ?? replies[replies.length - 1]!;
      response.writeHead(reply.status, { "Content-Type": "application/json" });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/functions/v1`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let open: Stub | null = null;
/**
 * Collects the retry diagnostics instead of letting them reach stderr. Two
 * reasons: this file provokes 5xx on purpose and would otherwise be the loudest
 * thing in a green server run, drowning the ONE warning that means something;
 * and the diagnostic is part of the contract, so it is asserted rather than
 * merely suppressed.
 */
let warnings: string[] = [];
const collect = (message: string) => {
  warnings.push(message);
};

afterEach(async () => {
  await open?.close();
  open = null;
  warnings = [];
});

describe("callFunction", () => {
  /**
   * THE REGRESSION. Before this helper existed, every server suite called
   * `fetch` once and handed the 500 straight to the assertion — which is how a
   * Daily Challenge attempt that lost one `NEXT_HAND` reply came back two hands
   * short and was reported as `expected [ 18 items ] to deeply equal [ 20 items ]`.
   */
  it("replays a retired-worker 500 and returns the answer that arrives", async () => {
    open = await stubServer([
      { status: 500, body: RETIRED_BODY },
      { status: 200, body: JSON.stringify({ status: "accepted", publicState: { version: 7 } }) },
    ]);

    const result = await callFunctionAt(
      open.base,
      "game-command",
      "token-abc",
      { gameId: "g", clientActionId: "the-one-key", type: "NEXT_HAND", expectedVersion: 6 },
      collect,
    );

    expect(result.status).toBe(200);
    expect(result.body.status).toBe("accepted");
    expect(open.received).toHaveLength(2);
    // The absorption is announced. A retry nobody can see is how an intermittent
    // becomes a mystery, and Vitest 4 discards `console` output from a PASSING
    // test — which is precisely the run this warning exists for.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("game-command answered HTTP 500 on attempt 1");
    expect(warnings[0]).toContain("WorkerAlreadyRetired");
  });

  /**
   * The load-bearing half. A retry that mints a fresh `clientActionId` is not a
   * retry — it is a second command, and the server's idempotency record cannot
   * collapse it. `JSON.stringify` runs once, outside the loop, for this reason.
   */
  it("replays a byte-identical body, so the idempotency key survives the retry", async () => {
    open = await stubServer([
      { status: 500, body: RETIRED_BODY },
      { status: 503, body: "upstream connect error" },
      { status: 200, body: JSON.stringify({ status: "accepted" }) },
    ]);

    await callFunctionAt(
      open.base,
      "game-command",
      "token-abc",
      { clientActionId: "the-one-key", clientSentAt: "2026-08-24T00:00:00.000Z" },
      collect,
    );

    expect(open.received).toHaveLength(3);
    const [first, second, third] = open.received;
    expect(second!.body).toBe(first!.body);
    expect(third!.body).toBe(first!.body);
    expect(first!.body).toContain('"clientActionId":"the-one-key"');
    // And the credentials go with it, or the replay is a different request.
    expect(second!.authorization).toBe("Bearer token-abc");
    expect(third!.authorization).toBe("Bearer token-abc");
    expect(third!.contentType).toBe("application/json");
  });

  /** A 4xx is the server's verdict. Retrying one would discard the answer. */
  it("never retries a refusal", async () => {
    for (const status of [401, 403, 409, 422, 429]) {
      const stub = await stubServer([{ status, body: JSON.stringify({ code: "REFUSED" }) }]);
      try {
        const result = await callFunctionAt(stub.base, "game-command", "t", {}, collect);
        expect(result.status).toBe(status);
        expect(stub.received).toHaveLength(1);
        expect(warnings).toHaveLength(0);
      } finally {
        await stub.close();
      }
    }
  });

  /**
   * THE DEFECT THIS CLOSES, and it hid another one for a whole phase.
   *
   * A 500 carrying `{"status":"rejected","code":…}` is OUR HANDLER answering.
   * The runtime did not lose the reply; the command ran and failed. Replaying
   * it is a second attempt at something that just went wrong, and the second
   * attempt often succeeds — which is precisely how this helper made the
   * `CASH_OUT`/`JOIN_PUBLIC_TABLE` lock inversion invisible. That deadlock
   * answered this exact envelope on three runs out of three and the race test
   * PASSED all three, because by the time the body was replayed the other
   * transaction had committed.
   *
   * It matches the app: `online-table-gateway.ts` reads a parseable rejection —
   * INTERNAL included — as `refused`, and retries only an answer it could not
   * read. And it cannot regress the intermittent this file exists for: a
   * retired worker is answered by the gateway and never reaches the handler, so
   * it cannot produce this envelope.
   */
  it("never retries the function's own rejection envelope, whatever the status", async () => {
    open = await stubServer([
      {
        status: 500,
        body: JSON.stringify({
          status: "rejected",
          code: "INTERNAL",
          message: "Something went wrong. No chips were moved. (ref abc)",
        }),
      },
      { status: 200, body: JSON.stringify({ status: "accepted" }) },
    ]);

    const result = await callFunctionAt(open.base, "create-session", "t", {}, collect);

    expect(result.status).toBe(500);
    expect(result.body.code).toBe("INTERNAL");
    // Asked once. A second attempt would have been answered 200 and the caller
    // would never have learnt the command failed.
    expect(open.received).toHaveLength(1);
    expect(warnings).toHaveLength(0);
  });

  /**
   * The other side of the same line: a 5xx the handler did NOT write is still
   * the retired-worker case, and is still replayed.
   */
  it("still replays a 5xx whose body is not a rejection envelope", async () => {
    open = await stubServer([
      { status: 500, body: JSON.stringify({ error: "worker has already retired" }) },
      { status: 200, body: JSON.stringify({ status: "accepted" }) },
    ]);

    const result = await callFunctionAt(open.base, "game-command", "t", {}, collect);

    expect(result.status).toBe(200);
    expect(open.received).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });

  /**
   * The line between "absorbed a blip" and "hid a broken function". A 5xx that
   * persists is RETURNED, with its body, so the test that provoked it fails on
   * the server's own words.
   */
  it("surfaces a 5xx that does not go away, body intact", async () => {
    open = await stubServer([{ status: 500, body: JSON.stringify({ code: "INTERNAL" }) }]);

    const result = await callFunctionAt(open.base, "game-command", "t", {}, collect);

    expect(result.status).toBe(500);
    expect(result.body.code).toBe("INTERNAL");
    expect(open.received).toHaveLength(3);
  });

  /** A dead stack raises rather than being retried into an empty-body assertion. */
  it("throws when nothing is listening", async () => {
    // Bound and closed, so the port is known to be free.
    const dead = await stubServer([{ status: 200, body: "{}" }]);
    const base = dead.base;
    await dead.close();

    await expect(callFunctionAt(base, "game-command", "t", {}, collect)).rejects.toThrow(
      /could not be called after 3 attempts/,
    );
  });

  /** An unparseable body is not an exception; the raw text is kept for the message. */
  it("keeps the raw body when it is not JSON", async () => {
    open = await stubServer([{ status: 502, body: "<html>Bad Gateway</html>" }]);

    const result = await callFunctionAt(open.base, "game-command", "t", {}, collect);

    expect(result.status).toBe(502);
    expect(result.body).toEqual({});
    expect(result.raw).toBe("<html>Bad Gateway</html>");
  });
});
