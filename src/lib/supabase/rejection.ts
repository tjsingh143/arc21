/**
 * Reading the server's verdict out of a failed `functions.invoke`.
 *
 * A rejection arrives with the contract's own HTTP status — 401, 403, 409, 422,
 * 429 — so `functions.invoke` reports it as an error and hands back the
 * `Response` rather than the body. Decoding it is what distinguishes "the
 * server answered and said no" from "nothing answered", which is the
 * distinction every retry decision and every player-facing message rests on.
 *
 * This lived inside `online-table-gateway.ts` until a second caller needed it.
 * It is here rather than copied because a second copy is how the two would
 * drift, and the thing they would drift on is whether a refusal counts as a
 * failure worth retrying.
 */

import { z } from "zod";

/** The rejection envelope, as `toRejectedResponse` builds it on the server. */
const rejectionSchema = z.object({
  status: z.literal("rejected"),
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(500),
});

export interface ServerRejection {
  readonly code: string;
  readonly message: string;
}

/** A Response, structurally — `FunctionsFetchError` carries something else. */
function responseLike(value: unknown): { json: () => Promise<unknown> } | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { json?: unknown };
  return typeof candidate.json === "function"
    ? (value as { json: () => Promise<unknown> })
    : null;
}

/**
 * The server's verdict, or null when nothing recognisable came back.
 *
 * Null is the important return: a 503 from the API gateway with the Edge
 * runtime down, an HTML error page from a captive portal, or a body that fails
 * the schema all mean the same thing — this client did not learn what happened
 * to its command, and must not pretend otherwise.
 */
export async function readRejection(error: unknown): Promise<ServerRejection | null> {
  const context = responseLike((error as { context?: unknown } | null)?.context);
  if (context === null) return null;

  let body: unknown;
  try {
    body = await context.json();
  } catch {
    return null;
  }

  const parsed = rejectionSchema.safeParse(body);
  return parsed.success ? { code: parsed.data.code, message: parsed.data.message } : null;
}
