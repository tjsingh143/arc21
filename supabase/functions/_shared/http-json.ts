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
 * Reads a JSON body with a hard size cap.
 *
 * The cap is enforced on the bytes actually read rather than on
 * `content-length`, which a client controls and may simply omit.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  if (request.method !== "POST") {
    throw new CommandError("INVALID_REQUEST", `method ${request.method}`);
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new CommandError("INVALID_REQUEST", "content-type is not application/json");
  }

  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength === 0) {
    throw new CommandError("INVALID_REQUEST", "empty body");
  }
  if (raw.byteLength > MAX_BODY_BYTES) {
    throw new CommandError("INVALID_REQUEST", `body of ${raw.byteLength} bytes exceeds the cap`);
  }

  try {
    return JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch {
    // The parser's message quotes the offending input; it is not returned.
    throw new CommandError("INVALID_REQUEST", "body is not valid JSON");
  }
}

/** Correlates a client-visible rejection with the server-side detail. */
export function newRequestId(): string {
  return crypto.randomUUID();
}
