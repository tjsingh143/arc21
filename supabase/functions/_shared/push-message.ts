/**
 * Arc 21 — turning a notification row into a push message.
 *
 * Pure and side-effect free, so the interesting parts — what reaches a device,
 * what is done with a rejection, how a batch is split — are testable without a
 * push service, credentials or a network.
 *
 * The one rule worth restating here: **a push payload carries deep-link
 * parameters and nothing else.** The database enforces that with a key
 * allowlist on `notifications.data`; this module never adds a field of its own
 * beyond the kind, so there is no second place for a seed or a card to enter.
 */

/** A row from `pending_push_deliveries()`. */
export interface PendingDelivery {
  notificationId: string;
  token: string;
  platform: "ios" | "android";
  kind: string;
  title: string;
  body: string;
  data: Record<string, string | number>;
}

/** The Expo push service's message shape. */
export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, string | number>;
  sound: "default" | null;
  priority: "default" | "high";
  channelId?: string;
  ttl?: number;
}

/** Expo accepts at most 100 messages per request. */
export const EXPO_BATCH_SIZE = 100;

export const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

/**
 * Kinds that are worth waking a screen for immediately.
 *
 * Only one qualifies. "Your turn" expires — a table with a fifteen-second action
 * timer has already moved on by the time a batched notification lands, which is
 * the whole reason the specification hedges it with "where timing makes sense".
 * Everything else is news that keeps.
 */
const TIME_CRITICAL_KINDS = new Set(["your_turn"]);

/**
 * How long a message stays worth delivering.
 *
 * A "your turn" that surfaces four minutes later is not a notification, it is an
 * apology: the hand was played by the timeout default long ago. The push service
 * drops it instead. Everything else keeps for a day.
 */
const TIME_CRITICAL_TTL_SECONDS = 45;
const DEFAULT_TTL_SECONDS = 86_400;

/**
 * Android needs a channel, and the channel decides the sound and importance the
 * OS applies. One channel per urgency, not one per kind, so the notification
 * settings a player sees on the device stay legible.
 */
export const ANDROID_CHANNELS = {
  timeCritical: "arc21-turn",
  default: "arc21-default",
} as const;

export function toExpoMessage(delivery: PendingDelivery): ExpoPushMessage {
  const urgent = TIME_CRITICAL_KINDS.has(delivery.kind);

  return {
    to: delivery.token,
    title: delivery.title,
    body: delivery.body,
    // `kind` is what the client routes on. The rest is whatever deep-link
    // parameters the writer attached, already allowlisted by the database.
    data: { ...delivery.data, kind: delivery.kind, notificationId: delivery.notificationId },
    // A neutral treatment: the device's own notification sound, never a custom
    // jingle. The specification's word for push is "neutral".
    sound: "default",
    priority: urgent ? "high" : "default",
    channelId: urgent ? ANDROID_CHANNELS.timeCritical : ANDROID_CHANNELS.default,
    ttl: urgent ? TIME_CRITICAL_TTL_SECONDS : DEFAULT_TTL_SECONDS,
  };
}

export function chunk<T>(items: readonly T[], size: number = EXPO_BATCH_SIZE): T[][] {
  if (size < 1) throw new Error("chunk size must be at least 1");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

/** One entry of the push service's response array. */
export interface ExpoPushTicket {
  status?: string;
  message?: string;
  details?: { error?: string };
}

export type DeliveryOutcome = "sent" | "failed";

export interface TicketVerdict {
  outcome: DeliveryOutcome;
  /** Short, safe to store and to log. Never carries the token. */
  detail: string | null;
  /**
   * True when the push service says this token is dead. The token is retired
   * server-side, because the device it belonged to has no way to know and will
   * never ask.
   */
  retireToken: boolean;
}

/**
 * Reads one ticket.
 *
 * Anything unrecognised is `failed`, not `sent`. A sender that treats an
 * unfamiliar response as success stops being an audit trail the first time the
 * push service changes its wording.
 */
export function classifyTicket(ticket: ExpoPushTicket | undefined): TicketVerdict {
  if (!ticket) {
    return { outcome: "failed", detail: "no ticket returned", retireToken: false };
  }
  if (ticket.status === "ok") {
    return { outcome: "sent", detail: null, retireToken: false };
  }

  const error = ticket.details?.error;
  return {
    outcome: "failed",
    // The service's own message, capped. It describes the rejection, not the
    // recipient.
    detail: (error ?? ticket.message ?? "rejected").slice(0, 200),
    retireToken: error === "DeviceNotRegistered",
  };
}

/** What the database records for a notification once its devices are answered. */
export type RecordedDelivery = "sent" | "mocked" | "failed";

/**
 * One notification, several devices, one recorded outcome.
 *
 * A player signed in on a phone and a tablet produces two push messages. If
 * either arrives, the notification was delivered — a dead tablet token does not
 * make a delivered phone notification a failure.
 *
 * The mock transport short-circuits this: nothing was delivered anywhere, and
 * the row says so rather than claiming a success it did not have.
 */
export function summariseDelivery(
  transport: PushTransport["name"],
  verdicts: readonly TicketVerdict[],
): { delivery: RecordedDelivery; detail: string | null } {
  if (transport === "mock") {
    return { delivery: "mocked", detail: "no push credentials configured" };
  }
  if (verdicts.length === 0) {
    return { delivery: "failed", detail: "no ticket returned" };
  }
  if (verdicts.some((verdict) => verdict.outcome === "sent")) {
    return { delivery: "sent", detail: null };
  }
  return {
    delivery: "failed",
    detail: verdicts.find((verdict) => verdict.detail)?.detail ?? "rejected",
  };
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/**
 * What a sender needs from a push service.
 *
 * Two implementations exist: the real Expo one, and the mocked one used when no
 * credentials are configured. The mocked one does not pretend — it reports a
 * distinct outcome that the database records as `mocked`, so nobody can read a
 * development run as evidence that push works.
 */
export interface PushTransport {
  readonly name: "expo" | "mock";
  send(messages: readonly ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
}

export class MockPushTransport implements PushTransport {
  readonly name = "mock" as const;
  /** Retained for assertions in tests and for the function's own log line. */
  readonly sent: ExpoPushMessage[] = [];

  send(messages: readonly ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
    this.sent.push(...messages);
    // Deliberately NOT `{status: "ok"}`: nothing was delivered, and the caller
    // must be able to tell the difference.
    return Promise.resolve(messages.map(() => ({ status: "mocked" })));
  }
}

export class ExpoPushTransport implements PushTransport {
  readonly name = "expo" as const;
  readonly #accessToken: string;

  constructor(accessToken: string) {
    this.#accessToken = accessToken;
  }

  async send(messages: readonly ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
    const response = await fetch(EXPO_PUSH_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
        "accept-encoding": "gzip, deflate",
      },
      body: JSON.stringify(messages),
    });

    if (!response.ok) {
      // A transport-level failure is every message in the batch failing, and it
      // is reported per message so no row is left `pending` forever.
      const status = response.status;
      return messages.map(() => ({ status: "error", message: `push service returned ${status}` }));
    }

    const parsed = (await response.json()) as { data?: ExpoPushTicket[] };
    return parsed.data ?? messages.map(() => ({ status: "error", message: "no data in response" }));
  }
}
