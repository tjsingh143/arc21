import { describe, expect, it, vi } from "vitest";
import { sendSessionIntent } from "../../src/lib/supabase/session-intent.js";
import type { ArcSupabaseClient } from "../../src/lib/supabase/client.js";

describe("session intent transport boundary", () => {
  it("does not retry a parsed refusal, including INTERNAL", async () => {
    const invoke = vi.fn(async () => ({ data: null, error: {
      context: new Response(JSON.stringify({ status: "rejected", code: "INTERNAL", message: "Unavailable." }), { status: 500 }),
    } }));
    expect(await sendSessionIntent({ functions: { invoke } } as unknown as ArcSupabaseClient, { action: "OPEN" }))
      .toEqual({ kind: "rejected", rejection: { code: "INTERNAL", message: "Unavailable." } });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("bounds silent transport and retries byte-identical intent", async () => {
    const invoke = vi.fn(() => new Promise<never>(() => undefined));
    expect(await sendSessionIntent({ functions: { invoke } } as unknown as ArcSupabaseClient, { action: "OPEN" }, 5))
      .toEqual({ kind: "unknown" });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]).toEqual(invoke.mock.calls[0]);
  });
});
