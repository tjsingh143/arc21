/**
 * Turning a notification row into a push message, and reading what comes back.
 *
 * The delivery record is the part worth guarding. Without push credentials
 * nothing is actually sent, and a sender that recorded those rows as "sent"
 * would make its own audit trail useless — `docs/AUDIT.md` grades push delivery
 * on the difference. So the mock transport reports a distinct outcome and these
 * assert it survives every path through the summariser.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  ANDROID_CHANNELS,
  EXPO_BATCH_SIZE,
  EXPO_PUSH_ENDPOINT,
  ExpoPushTransport,
  MockPushTransport,
  chunk,
  classifyTicket,
  summariseDelivery,
  toExpoMessage,
  type PendingDelivery,
} from "../../supabase/functions/_shared/push-message.js";

const DELIVERY: PendingDelivery = {
  notificationId: "11111111-1111-4111-8111-111111111111",
  token: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
  platform: "ios",
  kind: "table_invite",
  title: "Table invite",
  body: "A friend invited you to a private table.",
  data: { room_code: "ABCDEF" },
};

describe("building a message", () => {
  it("carries the kind, because that is what the client routes on", () => {
    const message = toExpoMessage(DELIVERY);
    expect(message.data.kind).toBe("table_invite");
    expect(message.data.room_code).toBe("ABCDEF");
    expect(message.to).toBe(DELIVERY.token);
  });

  it("adds nothing of its own beyond the kind and the id", () => {
    // The database allowlists what may be in `data`. This asserts the sender is
    // not a second place where something could be attached.
    const message = toExpoMessage(DELIVERY);
    expect(Object.keys(message.data).sort()).toEqual(["kind", "notificationId", "room_code"]);
  });

  it("gives the turn notification a short life and a high priority", () => {
    // A "your turn" that surfaces four minutes later is an apology, not a
    // notification: the hand was played by the timeout default long ago.
    const urgent = toExpoMessage({ ...DELIVERY, kind: "your_turn" });
    expect(urgent.priority).toBe("high");
    expect(urgent.ttl).toBeLessThanOrEqual(60);
    expect(urgent.channelId).toBe(ANDROID_CHANNELS.timeCritical);
  });

  it("lets everything else keep", () => {
    const ordinary = toExpoMessage(DELIVERY);
    expect(ordinary.priority).toBe("default");
    expect(ordinary.ttl).toBeGreaterThan(3_600);
    expect(ordinary.channelId).toBe(ANDROID_CHANNELS.default);
  });

  it("uses the device's own sound, never a custom one", () => {
    // The specification's word for push is "neutral".
    expect(toExpoMessage(DELIVERY).sound).toBe("default");
  });
});

describe("batching", () => {
  it("splits at the push service's limit", () => {
    const items = Array.from({ length: 250 }, (_, index) => index);
    const batches = chunk(items);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(EXPO_BATCH_SIZE);
    expect(batches[2]).toHaveLength(50);
  });

  it("handles an empty queue", () => {
    expect(chunk([])).toEqual([]);
  });

  it("refuses a nonsensical size rather than looping forever", () => {
    expect(() => chunk([1, 2, 3], 0)).toThrow();
  });
});

describe("reading a ticket", () => {
  it("accepts an ok", () => {
    expect(classifyTicket({ status: "ok" })).toEqual({
      outcome: "sent",
      detail: null,
      retireToken: false,
    });
  });

  it("treats anything unrecognised as a failure, not a success", () => {
    // A sender that reads an unfamiliar response as success stops being an audit
    // trail the first time the push service changes its wording.
    expect(classifyTicket({ status: "something-new" }).outcome).toBe("failed");
    expect(classifyTicket(undefined).outcome).toBe("failed");
  });

  it("retires a token the service says is dead", () => {
    const verdict = classifyTicket({
      status: "error",
      message: "not registered",
      details: { error: "DeviceNotRegistered" },
    });
    expect(verdict.outcome).toBe("failed");
    expect(verdict.retireToken).toBe(true);
    // The device has no way to know its own token died, so retiring it is the
    // server's job.
    expect(verdict.detail).toBe("DeviceNotRegistered");
  });

  it("does not retire a token over an ordinary rejection", () => {
    expect(classifyTicket({ status: "error", message: "MessageTooBig" }).retireToken).toBe(false);
  });
});

describe("recording what happened to a notification", () => {
  it("never claims a mocked send was sent", () => {
    // The honest branch, and the reason the enum has a `mocked` member at all.
    const summary = summariseDelivery("mock", [
      { outcome: "sent", detail: null, retireToken: false },
    ]);
    expect(summary.delivery).toBe("mocked");
    expect(summary.detail).toMatch(/credentials/);
  });

  it("counts one device arriving as delivered, even if another failed", () => {
    // A player on a phone and a dead tablet token has been notified.
    expect(
      summariseDelivery("expo", [
        { outcome: "failed", detail: "DeviceNotRegistered", retireToken: true },
        { outcome: "sent", detail: null, retireToken: false },
      ]).delivery,
    ).toBe("sent");
  });

  it("reports a failure with the service's own reason", () => {
    const summary = summariseDelivery("expo", [
      { outcome: "failed", detail: "MessageRateExceeded", retireToken: false },
    ]);
    expect(summary.delivery).toBe("failed");
    expect(summary.detail).toBe("MessageRateExceeded");
  });

  it("fails rather than silently succeeding on an empty response", () => {
    expect(summariseDelivery("expo", []).delivery).toBe("failed");
  });
});

describe("the mock transport", () => {
  it("records what it would have sent and reports it as not sent", async () => {
    const transport = new MockPushTransport();
    const tickets = await transport.send([toExpoMessage(DELIVERY)]);

    expect(transport.sent).toHaveLength(1);
    // Deliberately not `{status: "ok"}`. Nothing was delivered.
    expect(tickets[0]?.status).not.toBe("ok");
    expect(classifyTicket(tickets[0]).outcome).toBe("failed");
  });
});

describe("the Expo transport", () => {
  /*
   * `fetch` is stubbed rather than reached.
   *
   * The interesting behaviour is entirely in what this does with a REPLY — and
   * the replies that matter are the unhappy ones, which a real push service will
   * not produce on demand. A transport-level failure must become a per-message
   * verdict rather than an exception, because a batch that throws leaves every
   * row in it `pending` forever and retries a permanently broken payload on every
   * run.
   */
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function stubFetch(response: { ok: boolean; status?: number; body?: unknown }): () => Request[] {
    const seen: Request[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(String(input), init));
      return Promise.resolve({
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        json: () => Promise.resolve(response.body ?? {}),
      } as Response);
    }) as typeof fetch;
    return () => seen;
  }

  it("posts the batch to the push service and returns its tickets", async () => {
    const seen = stubFetch({ ok: true, body: { data: [{ status: "ok" }] } });
    const transport = new ExpoPushTransport("secret-token");

    const tickets = await transport.send([toExpoMessage(DELIVERY)]);

    expect(tickets).toEqual([{ status: "ok" }]);
    expect(seen()[0]?.url).toBe(EXPO_PUSH_ENDPOINT);
    expect(seen()[0]?.headers.get("authorization")).toBe("Bearer secret-token");
  });

  it("turns an HTTP failure into a verdict for every message, not an exception", async () => {
    stubFetch({ ok: false, status: 429 });
    const transport = new ExpoPushTransport("secret-token");

    const tickets = await transport.send([toExpoMessage(DELIVERY), toExpoMessage(DELIVERY)]);

    expect(tickets).toHaveLength(2);
    for (const ticket of tickets) {
      expect(classifyTicket(ticket).outcome).toBe("failed");
      expect(ticket.message).toContain("429");
    }
  });

  it("treats a reply with no data as a failure rather than a silent success", async () => {
    stubFetch({ ok: true, body: {} });
    const transport = new ExpoPushTransport("secret-token");

    const tickets = await transport.send([toExpoMessage(DELIVERY)]);
    expect(classifyTicket(tickets[0]).outcome).toBe("failed");
  });

  it("names itself, because the delivery record depends on which transport ran", async () => {
    expect(new ExpoPushTransport("t").name).toBe("expo");
    expect(new MockPushTransport().name).toBe("mock");
  });
});
