import { describe, expect, it, vi } from "vitest";

import { createSupabaseAuthAdapter } from "../../src/features/auth/supabase-auth-adapter.js";
import type { ArcSupabaseClient } from "../../src/lib/supabase/client.js";

function fixture() {
  const session = { user: { id: "recovery-owner" } };
  const auth = {
    exchangeCodeForSession: vi.fn()
      .mockResolvedValueOnce({ data: { session }, error: null })
      .mockResolvedValue({ data: { session: null }, error: { code: "flow_state_not_found" } }),
    getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    updateUser: vi.fn()
      .mockResolvedValueOnce({ error: { code: "same_password" } })
      .mockResolvedValue({ error: null }),
  };
  return { auth, adapter: createSupabaseAuthAdapter({ auth } as unknown as ArcSupabaseClient) };
}

describe("the password update after a verified recovery exchange", () => {
  it("retries a refused update without exchanging the one-time code again", async () => {
    const { auth, adapter } = fixture();
    expect(await adapter.completePasswordReset("code", "old-password"))
      .toMatchObject({ ok: false, failure: { code: "SAME_PASSWORD" } });
    expect(await adapter.completePasswordReset("code", "new-password")).toEqual({ ok: true });
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(auth.updateUser).toHaveBeenLastCalledWith({ password: "new-password" });
  });

  it.each([null, { user: { id: "another-account" } }])(
    "refuses the retry if the recovery session was replaced with %j",
    async (session) => {
      const { auth, adapter } = fixture();
      await adapter.completePasswordReset("code", "old-password");
      auth.getSession.mockResolvedValue({ data: { session }, error: null });
      expect(await adapter.completePasswordReset("code", "new-password"))
        .toMatchObject({ ok: false, failure: { code: "RECOVERY_LINK_INVALID" } });
      expect(auth.updateUser).toHaveBeenCalledTimes(1);
    },
  );

  it("requires a different code to be verified independently", async () => {
    const { auth, adapter } = fixture();
    await adapter.completePasswordReset("code", "old-password");
    expect(await adapter.completePasswordReset("unverified-code", "new-password"))
      .toMatchObject({ ok: false, failure: { code: "RECOVERY_LINK_INVALID" } });
    expect(auth.exchangeCodeForSession).toHaveBeenLastCalledWith("unverified-code");
    expect(auth.updateUser).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a completed recovery flow", async () => {
    const { auth, adapter } = fixture();
    await adapter.completePasswordReset("code", "old-password");
    expect(await adapter.completePasswordReset("code", "new-password")).toEqual({ ok: true });
    expect(await adapter.completePasswordReset("code", "third-password"))
      .toMatchObject({ ok: false, failure: { code: "RECOVERY_LINK_INVALID" } });
    expect(auth.exchangeCodeForSession).toHaveBeenCalledTimes(2);
    expect(auth.updateUser).toHaveBeenCalledTimes(2);
  });
});
