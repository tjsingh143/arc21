/**
 * Arc 21 — the push sender.
 *
 * Drains `notifications` rows that have not been delivered, pushes each to every
 * device that asked for that kind, and records what actually happened.
 *
 * WHAT THIS IS NOT
 *
 * It is not a scheduler and it does not decide what a player should be told.
 * Notifications are written by the routines that cause them — a friend request,
 * a full tournament, a settled placement — inside those commands' transactions.
 * This function only moves them to devices, which is why it can be run late, run
 * twice, or not run at all without changing what a player sees in the app.
 *
 * NO CREDENTIALS IS A SUPPORTED STATE
 *
 * Without `EXPO_ACCESS_TOKEN` there is no push service to talk to. The mock
 * transport runs instead and every row is recorded as `mocked` — never `sent`,
 * and `sent_at` stays null. A development run therefore cannot be mistaken for
 * evidence that push delivery works. `docs/AUDIT.md` grades it on exactly that
 * basis.
 *
 * WHO MAY CALL IT
 *
 * The service-role key, and nothing else. A player's token is refused: this
 * endpoint reads other people's notification titles and bodies by design, which
 * no signed-in user may do. The key never leaves the server — it is not an
 * `EXPO_PUBLIC_*` value and the mobile client has no path to it.
 */

import { CommandError, classify, toRejectedResponse } from "../_shared/command-errors.ts";
import { db } from "../_shared/postgres-client.ts";
import { jsonResponse, newRequestId, preflightResponse, readJsonBody } from "../_shared/http-json.ts";
import { logError, logInfo, logWarn, type LogFields } from "../_shared/structured-log.ts";
import { optionalEnv, serviceRoleKey } from "../_shared/env.ts";
import {
  ExpoPushTransport,
  MockPushTransport,
  chunk,
  classifyTicket,
  summariseDelivery,
  toExpoMessage,
  type ExpoPushMessage,
  type PendingDelivery,
  type PushTransport,
  type TicketVerdict,
} from "../_shared/push-message.ts";

/** A cap on one invocation, so a backlog is drained in bounded slices. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

interface DeliveryRow {
  notification_id: string;
  token: string;
  platform: "ios" | "android";
  kind: string;
  title: string;
  body: string;
  data: Record<string, string | number>;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return preflightResponse();

  const requestId = newRequestId();
  const log: LogFields = { requestId, fn: "send-notifications" };
  const startedAt = Date.now();

  try {
    assertOperator(request);
    const limit = readLimit(await readJsonBody(request).catch(() => ({})));

    const transport: PushTransport = buildTransport();
    const summary = await drain(transport, limit, log);

    log.durationMs = Date.now() - startedAt;
    logInfo("push queue drained", log);

    return jsonResponse({ transport: transport.name, ...summary }, 200);
  } catch (error) {
    const rejection = classify(error);
    log.code = rejection.code;
    log.durationMs = Date.now() - startedAt;

    if (rejection.code === "INTERNAL") {
      logError("push send failed", log, error);
    } else {
      logWarn("push send rejected", log, rejection.internalDetail);
    }

    return jsonResponse(toRejectedResponse(rejection, requestId), rejection.httpStatus);
  }
});

// ---------------------------------------------------------------------------

/**
 * Operator authentication.
 *
 * Deliberately NOT `authenticate()`. That verifies a player's session and would
 * let any signed-in account drain — and read — the whole queue. The comparison
 * is length-checked first and then constant-time, so a wrong key leaks nothing
 * about how wrong it was.
 */
function assertOperator(request: Request): void {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match?.[1]) {
    throw new CommandError("UNAUTHENTICATED", "no bearer token");
  }
  if (!timingSafeEqual(match[1], serviceRoleKey())) {
    throw new CommandError("UNAUTHENTICATED", "not the service key");
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function readLimit(body: unknown): number {
  const raw = (body as { limit?: unknown } | null)?.limit;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
}

function buildTransport(): PushTransport {
  const accessToken = optionalEnv("EXPO_ACCESS_TOKEN");
  return accessToken ? new ExpoPushTransport(accessToken) : new MockPushTransport();
}

// ---------------------------------------------------------------------------

interface DrainSummary {
  sent: number;
  mocked: number;
  failed: number;
  noDevice: number;
  tokensRetired: number;
}

/**
 * Each notification is recorded in its own statement rather than one transaction
 * over the batch. If the push service accepts fifty messages and then times out,
 * the fifty that were accepted must stay accepted — rolling them back would push
 * them all a second time on the next run.
 */
async function drain(transport: PushTransport, limit: number, log: LogFields): Promise<DrainSummary> {
  const sql = db();

  const rows = await sql<DeliveryRow[]>`
    select notification_id, token, platform, kind, title, body, data
    from public.pending_push_deliveries(${limit}::int)
  `;

  const summary: DrainSummary = { sent: 0, mocked: 0, failed: 0, noDevice: 0, tokensRetired: 0 };

  // One notification may target several devices; the verdicts are collected per
  // notification so the row records one honest outcome.
  const verdictsByNotification = new Map<string, TicketVerdict[]>();
  const deadTokens = new Set<string>();

  const deliveries: PendingDelivery[] = rows.map((row) => ({
    notificationId: row.notification_id,
    token: row.token,
    platform: row.platform,
    kind: row.kind,
    title: row.title,
    body: row.body,
    data: row.data ?? {},
  }));

  for (const batch of chunk(deliveries)) {
    const messages: ExpoPushMessage[] = batch.map(toExpoMessage);
    let tickets;
    try {
      tickets = await transport.send(messages);
    } catch (error) {
      // A transport that throws is every message in the batch failing. Recording
      // that is better than leaving the rows pending forever, which would retry
      // a permanently broken payload on every run.
      logWarn("push transport threw", log, error instanceof Error ? error.message : String(error));
      tickets = batch.map(() => ({ status: "error", message: "transport error" }));
    }

    batch.forEach((delivery, index) => {
      const verdict = classifyTicket(tickets[index]);
      if (verdict.retireToken) deadTokens.add(delivery.token);

      const existing = verdictsByNotification.get(delivery.notificationId);
      if (existing) existing.push(verdict);
      else verdictsByNotification.set(delivery.notificationId, [verdict]);
    });
  }

  for (const [notificationId, verdicts] of verdictsByNotification) {
    const { delivery, detail } = summariseDelivery(transport.name, verdicts);
    await sql`
      select public.record_push_delivery(
        ${notificationId}::uuid,
        ${delivery}::public.notification_delivery,
        ${detail}
      )
    `;
    if (delivery === "sent") summary.sent++;
    else if (delivery === "mocked") summary.mocked++;
    else summary.failed++;
  }

  for (const token of deadTokens) {
    await sql`select public.deactivate_push_token(${token})`;
    summary.tokensRetired++;
  }

  // Notifications nobody can receive: no permission granted, or no device wants
  // this kind. Closed out as `no_device` so the queue does not grow without
  // bound, and so "pending" keeps meaning "not attempted yet".
  const orphans = await sql<{ pending_without_device: string }[]>`
    select pending_without_device from public.pending_without_device(${limit}::int)
  `;
  for (const orphan of orphans) {
    await sql`
      select public.record_push_delivery(
        ${orphan.pending_without_device}::uuid,
        'no_device'::public.notification_delivery,
        ${"no active device registered for this kind"}
      )
    `;
    summary.noDevice++;
  }

  return summary;
}
