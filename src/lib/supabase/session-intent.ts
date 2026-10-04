import type { ArcSupabaseClient } from "./client.js";
import { mayActAs } from "./adopted-player.js";
import { confirmedSession, sessionPlayer } from "./player-binding.js";
import { readRejection, type ServerRejection } from "./rejection.js";
import { isTimedOut, withTimeout } from "./with-timeout.js";
import { capturePlayerScope } from "../../features/player/player-scope.js";

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
  const scopeIsCurrent = capturePlayerScope();
  let token: string;
  let userId: string;
  try {
    const session = await withTimeout(confirmedSession(client), timeoutMs);
    if (isTimedOut(session) || session.error || !session.data.session || !scopeIsCurrent()) return { kind: "unknown" };
    token = session.data.session.access_token;
    userId = sessionPlayer(session.data.session) ?? "";
  } catch { return { kind: "unknown" }; }
  // An economic intent is sent only as the ADOPTED player — never as a restored
  // credential the auth server has not confirmed (B-H1: a ranked Daily was
  // opened that way) — and that is asked again before each attempt.
  const isCurrent = () => scopeIsCurrent() && mayActAs(client, userId);
  if (!isCurrent()) return { kind: "unknown" };
  const body = {
    ...intent,
    clientRequestId: globalThis.crypto.randomUUID(),
    clientSentAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!isCurrent()) return { kind: "unknown" };
    try {
      // Pin the verified credential for this intent, including a response-loss
      // retry. A later login must never spend another player's wallet.
      const result = await withTimeout(client.functions.invoke("create-session", { body, headers: { Authorization: `Bearer ${token}` } }), timeoutMs);
      if (!isCurrent()) return { kind: "unknown" };
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
