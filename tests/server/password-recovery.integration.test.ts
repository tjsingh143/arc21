/**
 * The password-reset deep link, end to end against the REAL local stack.
 *
 * This is the journey `docs/IMPLEMENTATION_STATUS.md` recorded as genuinely
 * broken: `resetPasswordForEmail` sent no `redirectTo`, so GoTrue fell back to
 * `site_url` — a web URL this app never serves — and nothing handled the
 * recovery link even if it had arrived at the right place. Both are fixed in
 * `supabase-auth-adapter.ts`; this file proves it by actually running the
 * journey, the same way `tests/server/realtime.integration.test.ts` proves
 * reconnect rather than reasoning about the code.
 *
 * The local stack runs Mailpit at 127.0.0.1:54324, so every step below is
 * exercised for real: request the reset, read the actual email, follow the
 * actual link (capturing its redirect rather than fetching an `arc21://` URL,
 * which no HTTP client can open), exchange the code, set the new password, and
 * confirm it by signing in with it.
 *
 * A SKIP IS NOT A PASS. The guard requires a 401 from a function, for the same
 * reason every other file in this directory does.
 *
 *   supabase start
 *   supabase functions serve --no-verify-jwt
 */

import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { stackUp } from "./stack-guard.js";
import { createClient } from "@supabase/supabase-js";
import { disposeAuthSubscription, setGuestIdentityStore, useAuthStore } from "../../src/features/auth/auth-store.js";
import { setSupabaseAvailabilityForTests, type ArcSupabaseClient } from "../../src/lib/supabase/client.js";

import { GuestIdentityStore } from "../../src/features/auth/guest.js";
import { MemoryKeyValueStore } from "../../src/lib/persistence/key-value-store.js";
afterEach(() => {
  disposeAuthSubscription(); setGuestIdentityStore(null); setSupabaseAvailabilityForTests(null);
});

const SUPABASE_URL = "http://127.0.0.1:54321";
const AUTH_ADMIN = `${SUPABASE_URL}/auth/v1/admin/users`;
const MAILPIT = "http://127.0.0.1:54324";

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

/** Matches `supabase-auth-adapter.ts`'s constant — literally, on purpose. See its comment. */
const PASSWORD_RECOVERY_REDIRECT_URL = "arc21://auth/recovery";

async function createUserWithPassword(email: string, password: string): Promise<string> {
  const response = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return json.id;
}

interface MailpitMessage {
  ID: string;
}

/** Polls rather than assuming the mail has landed by the time this asks. */
async function findMessageTo(address: string, deadlineMs = 5_000): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
    );
    const json = (await response.json()) as { messages: MailpitMessage[] };
    if (json.messages.length > 0) return json.messages[0]!.ID;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no reset email arrived for ${address} within ${deadlineMs}ms`);
}

async function verifyLinkFrom(messageId: string): Promise<string> {
  const response = await fetch(`${MAILPIT}/api/v1/message/${messageId}`);
  const json = (await response.json()) as { Text: string };
  // The actual text GoTrue's default recovery template sends, read from the
  // actual email — not a template file assumed to match it.
  const match = json.Text.match(/https?:\/\/\S*\/auth\/v1\/verify\?\S+/);
  if (!match) throw new Error(`no verify link found in email body:\n${json.Text}`);
  return match[0];
}

const suite = stackUp ? describe : describe.skip;

suite("password reset, end to end via Mailpit", () => {
  it(
    "uses the shipped auth store to recover, including a corrected password after the first choice is refused",
    async () => {
      const email = `it-recovery-${crypto.randomUUID()}@arc21.test`;
      const oldPassword = crypto.randomUUID();
      const newPassword = `${crypto.randomUUID()}-Aa1`;
      await createUserWithPassword(email, oldPassword);

      // `flowType: "pkce"` matches `src/lib/supabase/client.ts` exactly. Left
      // at the SDK's default (implicit), GoTrue redirects with tokens in a
      // hash fragment instead of a `code` query param — a real difference in
      // server behaviour driven entirely by client configuration, caught by
      // this test failing against the wrong shape before this line was added.
      const requester = createClient(SUPABASE_URL, LOCAL_ANON_KEY, {
        auth: { flowType: "pkce" },
      });
      setSupabaseAvailabilityForTests({ status: "ready", client: requester as ArcSupabaseClient });
      setGuestIdentityStore(new GuestIdentityStore(new MemoryKeyValueStore()));
      useAuthStore.setState({ hydrated: false, session: null, mode: "unknown", guest: null });
      await useAuthStore.getState().hydrate();
      useAuthStore.getState().setMode("signIn");
      useAuthStore.getState().dispatch({ type: "EDIT_EMAIL", value: email });
      await useAuthStore.getState().requestPasswordReset();
      expect(useAuthStore.getState().form.status.kind).toBe("resetLinkSent");

      const messageId = await findMessageTo(email);
      const verifyLink = await verifyLinkFrom(messageId);

      // This IS the regression: without `redirectTo`, GoTrue used `site_url`
      // and the link would never have pointed at this app at all.
      expect(verifyLink).toContain(`redirect_to=${PASSWORD_RECOVERY_REDIRECT_URL}`);

      // GoTrue's verify endpoint 303s to `redirect_to` with the PKCE code
      // attached. No HTTP client can navigate an `arc21://` URL — this reads
      // the Location header instead of following it, exactly what the OS does
      // for the app rather than a browser.
      const verified = await fetch(verifyLink, { redirect: "manual" });
      expect([301, 302, 303, 307, 308]).toContain(verified.status);
      const location = verified.headers.get("location");
      expect(location).not.toBeNull();
      expect(location).toMatch(new RegExp(`^${PASSWORD_RECOVERY_REDIRECT_URL}\\?`));

      const redirectUrl = new URL(location!.replace("arc21://", "https://arc21.invalid/"));
      const code = redirectUrl.searchParams.get("code");
      expect(code).not.toBeNull();

      // An independent client verifies the result by actually signing in.
      const completer = createClient(SUPABASE_URL, LOCAL_ANON_KEY, {
        auth: { flowType: "pkce" },
      });
      // GoTrue rejects reusing the old password AFTER consuming the PKCE code.
      // A player can then correct their choice on the same screen. Repeating
      // exchangeCodeForSession on that second submission strands the reset.
      const refused = await useAuthStore.getState().completePasswordReset(code!, oldPassword);
      expect(refused).toMatchObject({ code: "SAME_PASSWORD" });
      const updated = await useAuthStore.getState().completePasswordReset(code!, newPassword);
      expect(updated).toBeNull();

      // The proof that matters: the OLD password no longer works, and the NEW
      // one does — not merely that the calls returned success.
      const oldStillWorks = await completer.auth.signInWithPassword({ email, password: oldPassword });
      expect(oldStillWorks.error).not.toBeNull();

      const newWorks = await completer.auth.signInWithPassword({ email, password: newPassword });
      expect(newWorks.error).toBeNull();
      expect(newWorks.data.session).not.toBeNull();
    },
    15_000,
  );
});
