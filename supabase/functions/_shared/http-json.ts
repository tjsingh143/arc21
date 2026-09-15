/**
 * Arc 21 — HTTP plumbing for the command functions.
 *
 * Small, boring and defensive: a bounded body, a required content type, a fixed
 * method, and a JSON response that never carries an unexpected header.
 */

import { CommandError } from "./command-errors.ts";

/**
 * The mobile client is not a browser origin, but the Functions endpoint is
 * reachable from one (the web build, and any tooling). Only the headers the
 * client genuinely sends are allowed through.
 */
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-max-age": "86400",
};

/** A command body has no legitimate reason to be large. */
export const MAX_BODY_BYTES = 8 * 1024;

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      // Authoritative state is never cacheable by an intermediary.
      "cache-control": "no-store",
    },
  });
}

export function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * Reads a JSON body with a hard size cap on what is RETAINED.
 *
 * Two rules, and the second took two measurements to get right.
 *
 * 1. THE CAP IS COUNTED ON BYTES READ, never on `content-length`. A client
 *    controls that header and may simply omit it, so it is not consulted at all:
 *    a second source of truth that can disagree with the first is worse than one
 *    that cannot, and there is no work to save by believing it (see rule 2).
 *
 * 2. THE BODY IS ALWAYS DRAINED, even the part being refused. This runtime sits
 *    behind a gateway that buffers the request and then waits for the reply, so
 *    a function that stops reading mid-body leaves that gateway blocked writing
 *    upstream and the response is never collected.
 *
 *    MEASURED, in both directions. `await request.arrayBuffer()` held a whole
 *    32 MB body in memory and then rejected it — correct answer, 2.5 s, and an
 *    allocation this runtime retires workers over. Replacing it with a read that
 *    CANCELLED at the cap fixed the memory and broke the answer: the same
 *    request went from HTTP 400 in 2.5 s to a 60-second stall and an HTTP 504
 *    from the gateway, and an 8 MB body that used to be refused instantly did
 *    the same. Draining without retaining has neither problem, and the same
 *    32 MB request is refused in 0.7 s.
 *
 * So the peak this function can be made to hold is `MAX_BODY_BYTES` plus one
 * chunk, whatever a caller sends, and the refusal is delivered at once.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  if (request.method !== "POST") {
    throw new CommandError("INVALID_REQUEST", `method ${request.method}`);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new CommandError("INVALID_REQUEST", "content-type is not application/json");
  }

  const read = await readCapped(request);
  if (read.overflowed) {
    throw new CommandError(
      "INVALID_REQUEST",
      `body of ${read.bytesSeen} bytes exceeds the ${MAX_BODY_BYTES}-byte cap`,
    );
  }
  if (read.body.byteLength === 0) {
    throw new CommandError("INVALID_REQUEST", "empty body");
  }

  try {
    return JSON.parse(new TextDecoder().decode(read.body)) as unknown;
  } catch {
    // The parser's message quotes the offending input; it is not returned.
    throw new CommandError("INVALID_REQUEST", "body is not valid JSON");
  }
}

interface CappedBody {
  /** The bytes kept. Empty once the cap was passed — a truncated body is not one. */
  body: Uint8Array;
  /** Everything the caller sent, counted whether or not it was kept. */
  bytesSeen: number;
  overflowed: boolean;
}

/**
 * Reads to the end of the body, keeping at most `MAX_BODY_BYTES` of it.
 *
 * Past the cap the chunks are counted and dropped rather than appended, so a
 * caller cannot choose how much memory this function allocates. Chunks under the
 * cap are collected in a list and joined once, so the peak is the body itself
 * rather than the repeated copy a per-chunk concat would make.
 */
async function readCapped(request: Request): Promise<CappedBody> {
  const body = request.body;
  if (!body) return { body: new Uint8Array(0), bytesSeen: 0, overflowed: false };

  const reader = body.getReader();
  let chunks: Uint8Array[] = [];
  let kept = 0;
  let bytesSeen = 0;
  let overflowed = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytesSeen += value.byteLength;
      if (overflowed) continue;
      if (bytesSeen > MAX_BODY_BYTES) {
        // Release what was collected; keep draining so the reply can be sent.
        overflowed = true;
        chunks = [];
        kept = 0;
        continue;
      }
      chunks.push(value);
      kept += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  if (overflowed) return { body: new Uint8Array(0), bytesSeen, overflowed };

  const out = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: out, bytesSeen, overflowed: false };
}

/**
 * Serves `handler`, then finishes reading any request body it left unread
 * BEFORE the response is handed to the runtime.
 *
 * Every function refuses a caller it cannot identify before it reads the body —
 * `authenticate` and `assertOperator` run first, and `readJsonBody` itself
 * refuses a wrong method or content type before reading. That ordering is right
 * and stays: an unauthenticated body is never parsed and never reaches the
 * database. But a response returned while the runtime is still writing the
 * request body into the function can be LOST. Edge runtime v1.74.3 logs
 * `error in user worker connection: user body write aborted` and the caller
 * never receives the refusal, so it waits until its own timeout.
 *
 * MEASURED before this existed, against unauthenticated POSTs to the running
 * functions: 12 of 180 requests carrying an 8,170-byte body went unanswered
 * across all three functions, and 147 of 200 carrying 64 KB in a minimal
 * function that refused without reading — one `write aborted` line per lost
 * reply. The same function draining first answered 200 of 200. In CI it was
 * the intermittent `pgTAP and server integration` failure, on code from before
 * Astra Refresh A as well as after it.
 *
 * The drain is `readCapped`, so what an unauthenticated caller can make this
 * HOLD is the same `MAX_BODY_BYTES` plus one chunk as any other request, and it
 * is discarded. What it can make this SPEND is the time and CPU of reading what
 * it uploads — exactly what a caller with a valid token could already cause
 * through the oversize refusal in `readJsonBody`, and bounded the same way: by
 * the runtime's per-isolate CPU limit. Measured after this change, 17 of 18
 * unauthenticated 1, 8 and 32 MB bodies were refused 401 in 0.05–3.3 s; the
 * eighteenth, 32 MB at host load 25, reached that CPU hard limit and the
 * supervisor ended the worker, as the authenticated 32 MB case also can. Stopping
 * the read early is not the alternative: that was measured as a 60 s gateway
 * stall (rule 2 of `readJsonBody`).
 *
 * A body the handler already read is left alone, and a caller who disconnects
 * mid-body is not an error worth reporting: nobody is waiting for the reply.
 */
export function withUnreadBodyDrained(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const response = await handler(request);
    await drainUnreadBody(request);
    return response;
  };
}

export async function drainUnreadBody(request: Request): Promise<void> {
  if (!request.body || request.bodyUsed) return;
  try {
    await readCapped(request);
  } catch {
    // The caller went away mid-body; there is no one left to answer.
  }
}

/** Correlates a client-visible rejection with the server-side detail. */
export function newRequestId(): string {
  return crypto.randomUUID();
}
