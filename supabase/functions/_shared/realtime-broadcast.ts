/**
 * Arc 21 — post-commit broadcast.
 *
 * Sequencing is deliberate: COMMIT first, broadcast second. A message sent
 * before the transaction commits could describe a state that then rolls back,
 * and clients would render a hand that never happened.
 *
 * Broadcast is therefore best-effort by design and never fails the request.
 * `public.game_events` is the durable, ordered record; a client that misses a
 * message detects the `seq` gap and refetches an authoritative snapshot, which
 * is precisely the recovery ARCHITECTURE.md specifies.
 *
 * The payload can only be a sanitised one: this module accepts `PublicGameState`
 * and `PublicGameEvent`, so there is no overload that would take engine state.
 */

import type { PublicGameState } from "../../../shared/blackjack/index.js";
import type { PublicGameEvent } from "../../../shared/contracts/index.js";
import { serviceRoleKey, supabaseUrl } from "./env.ts";
import { logWarn, type LogFields } from "./structured-log.ts";

const BROADCAST_TIMEOUT_MS = 2_000;

export function gameTopic(gameId: string): string {
  return `game:${gameId}`;
}

export async function broadcastSnapshot(
  publicState: PublicGameState,
  events: PublicGameEvent[],
  logFields: LogFields,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BROADCAST_TIMEOUT_MS);

  try {
    const key = serviceRoleKey();
    const response = await fetch(`${supabaseUrl()}/realtime/v1/api/broadcast`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        apikey: key,
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        messages: [
          {
            topic: gameTopic(publicState.gameId),
            event: "state",
            payload: { publicState, events },
          },
        ],
      }),
    });

    if (!response.ok) {
      logWarn("broadcast rejected", logFields, `status ${response.status}`);
    }
  } catch (error) {
    // Never rethrown. The command is already committed and the caller has its
    // authoritative response; a failed fan-out is a delivery problem, not a
    // correctness one.
    logWarn("broadcast failed", logFields, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}
