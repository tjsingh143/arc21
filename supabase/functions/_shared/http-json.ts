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

/** Correlates a client-visible rejection with the server-side detail. */
export function newRequestId(): string {
  return crypto.randomUUID();
}
