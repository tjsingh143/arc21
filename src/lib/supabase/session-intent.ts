import type { ArcSupabaseClient } from "./client.js";
import { readRejection, type ServerRejection } from "./rejection.js";
import { isTimedOut, withTimeout } from "./with-timeout.js";

type IntentResult =
  | { readonly kind: "accepted"; readonly data: unknown }
  | { readonly kind: "rejected"; readonly rejection: ServerRejection }
  | { readonly kind: "unknown" };

/** An entry/refund can commit before its response disappears. Retry transport
 * loss once with the SAME id and timestamp; a parsed server verdict is final.
 * Callers must reconcile authoritative state if neither reply is available. */
export async function sendSessionIntent(
  client: ArcSupabaseClient,
  intent: Readonly<Record<string, unknown>>,
  timeoutMs?: number,
): Promise<IntentResult> {
  const body = {
    ...intent,
    clientRequestId: globalThis.crypto.randomUUID(),
    clientSentAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await withTimeout(client.functions.invoke("create-session", { body }), timeoutMs);
      if (isTimedOut(result)) continue;
      if (!result.error) return { kind: "accepted", data: result.data };
      const rejection = await readRejection(result.error);
      if (rejection) return { kind: "rejected", rejection };
    } catch {
      // Transport rejection is uncertain, just like a timeout. Reusing this
      // intent cannot buy in or refund twice, even if the first call is late.
    }
  }
  return { kind: "unknown" };
}
