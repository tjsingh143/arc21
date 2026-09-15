/**
 * `withUnreadBodyDrained` — the contract, without a runtime.
 *
 * What it is FOR can only be shown against the edge runtime, and
 * `tests/server/hostile-payloads.integration.test.ts` shows it: before this
 * existed, unauthenticated refusals were lost there. This file pins the half a
 * `Request` object can prove — that the reply is handed back only after the body
 * has been read to its end, that a body the handler already read is left alone,
 * and that the reply itself is never altered or replaced.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_BODY_BYTES,
  drainUnreadBody,
  readJsonBody,
  withUnreadBodyDrained,
} from "../../supabase/functions/_shared/http-json.js";

interface TrackedBody {
  stream: ReadableStream<Uint8Array>;
  /** Chunks the consumer has pulled, and whether it reached the end. */
  pulled: () => number;
  finished: () => boolean;
}

/** A body of `chunks` chunks, each delivered after a macrotask, so reads are observable. */
function trackedBody(chunks: number, chunkBytes: number, failAt?: number): TrackedBody {
  let pulled = 0;
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (failAt !== undefined && pulled === failAt) {
        controller.error(new Error("caller disconnected"));
        return;
      }
      if (pulled === chunks) {
        finished = true;
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x20));
    },
  });
  return { stream, pulled: () => pulled, finished: () => finished };
}

function post(body: ReadableStream<Uint8Array> | string, contentType = "application/json"): Request {
  return new Request("http://functions.test/game-command", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
    duplex: "half",
  } as RequestInit);
}

const refusal = () => new Response('{"code":"UNAUTHENTICATED"}', { status: 401 });

describe("withUnreadBodyDrained", () => {
  it("reads an unread body to its end before handing back the handler's reply", async () => {
    const body = trackedBody(40, 1024);
    const reply = refusal();
    const served = withUnreadBodyDrained(async () => reply);

    const answered = await served(post(body.stream));

    expect(body.finished()).toBe(true);
    expect(body.pulled()).toBe(40);
    // The same reply, untouched: the drain decides WHEN it is sent, never WHAT.
    expect(answered).toBe(reply);
    expect(answered.status).toBe(401);
  });

  it("drains a body far past the cap, as the capped reader already does", async () => {
    const chunkBytes = 64 * 1024;
    const chunks = Math.ceil((4 * 1024 * 1024) / chunkBytes);
    expect(chunks * chunkBytes).toBeGreaterThan(MAX_BODY_BYTES);
    const body = trackedBody(chunks, chunkBytes);

    const answered = await withUnreadBodyDrained(async () => refusal())(post(body.stream));

    expect(body.finished()).toBe(true);
    expect(answered.status).toBe(401);
  });

  it("leaves a body the handler already read alone, and returns its reply", async () => {
    const request = post(JSON.stringify({ type: "STAND" }));
    let parsed: unknown;
    const served = withUnreadBodyDrained(async (incoming) => {
      parsed = await readJsonBody(incoming);
      return new Response("{}", { status: 200 });
    });

    const answered = await served(request);

    expect(parsed).toEqual({ type: "STAND" });
    expect(request.bodyUsed).toBe(true);
    expect(answered.status).toBe(200);
  });

  it("drains the body a content-type refusal left unread", async () => {
    // `readJsonBody` refuses a wrong content type BEFORE reading, so this path
    // needs the drain as much as an authentication refusal does.
    const body = trackedBody(8, 512);
    const served = withUnreadBodyDrained(async (incoming) => {
      await expect(readJsonBody(incoming)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      return new Response("{}", { status: 400 });
    });

    const answered = await served(post(body.stream, "text/plain"));

    expect(body.finished()).toBe(true);
    expect(answered.status).toBe(400);
  });

  it("still answers when the caller disconnects mid-body", async () => {
    const body = trackedBody(10, 256, 3);
    const answered = await withUnreadBodyDrained(async () => refusal())(post(body.stream));
    expect(answered.status).toBe(401);
    expect(body.finished()).toBe(false);
  });

  it("does nothing for a request with no body", async () => {
    const preflight = new Request("http://functions.test/game-command", { method: "OPTIONS" });
    await expect(drainUnreadBody(preflight)).resolves.toBeUndefined();
    const answered = await withUnreadBodyDrained(async () => new Response(null, { status: 204 }))(preflight);
    expect(answered.status).toBe(204);
  });
});
