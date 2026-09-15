/**
 * Renaming, driven the way the app now drives it, against the real database.
 *
 * THE DEFECT THIS COVERS. Every server-side half of renaming has existed and
 * been enforced since phase 3 — `guard_profile_username`,
 * `normalise_profile_display_name`, `profiles_username_key`, and two rows in
 * `rate_limit_policies` — and `docs/AUDIT.md` records both limits being
 * measured over HTTP. Nothing in the app had ever written either column after
 * signup, so all of that guarded a door with no handle on the inside.
 *
 * Asserting the enforcement again would prove nothing new; pgTAP already does.
 * What is proved here is the half that was missing: that the column grants and
 * the row policy actually ACCEPT the PATCH the client now makes, with an
 * ordinary player's token — and that each refusal comes back with the code
 * `describeRenameError` is built to read.
 *
 * "Test the CONTROL, not only the function behind it" is in CLAUDE.md because
 * three defects have survived a test of the function a dead control would have
 * called. This is the control's own request.
 *
 * The rename NORMALISES on the way in, so every assertion reads the row back
 * rather than trusting the request body.
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { stackUp } from "./stack-guard.js";
import { describeRenameError } from "../../src/features/auth/profile-rename.js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const REST = `${SUPABASE_URL}/rest/v1`;
const AUTH_ADMIN = `${SUPABASE_URL}/auth/v1/admin/users`;

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * No `iat`, for the reason `profile-privacy.integration.test.ts` documents at
 * length: PostgREST validates it against its own clock and answers PGRST303
 * when the host is ahead, and the failure never looks like a clock problem.
 */
function signToken(sub: string): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({ sub, role: "authenticated", aud: "authenticated", exp: now + 3600 });
  const signature = crypto
    .createHmac("sha256", LOCAL_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

async function createUser(): Promise<string> {
  const response = await fetch(AUTH_ADMIN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
    },
    body: JSON.stringify({
      email: `rename-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return json.id;
}

/** The exact request `useAccountProfileStore.rename` makes. */
async function rename(
  token: string,
  userId: string,
  patch: Record<string, string>,
): Promise<{ status: number; code: string | null; message: string | null }> {
  const response = await fetch(`${REST}/profiles?id=eq.${userId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
  });
  const raw = await response.text();
  let body: { code?: string; message?: string } | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) && typeof parsed === "object" && parsed !== null) {
      body = parsed as { code?: string; message?: string };
    }
  } catch {
    // A non-JSON body is itself the finding; the status carries it.
  }
  return { status: response.status, code: body?.code ?? null, message: body?.message ?? null };
}

/**
 * Reads the row as its OWNER.
 *
 * Not as `service_role`: this schema never granted it SELECT on `profiles`, so
 * a service-key read answers 42501. The honest way to check is the app's way.
 */
async function readOwn(
  token: string,
  userId: string,
): Promise<{ username: string; display_name: string } | null> {
  const response = await fetch(
    `${REST}/profiles?select=username,display_name&id=eq.${userId}`,
    { headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` } },
  );
  const rows = (await response.json()) as Array<{ username: string; display_name: string }>;
  const row = rows[0];
  /*
   * THROWS rather than returning a sentinel. A helper that returns a default
   * when it cannot read turns a harness error into a confusing assertion
   * failure — CLAUDE.md records the wallet helper that returned -1 and cost
   * three runs to diagnose.
   */
  if (!row) throw new Error(`profile ${userId} was not readable by its own token`);
  return row;
}

/** A handle nobody else will have taken. Within `^[a-z0-9_]{3,20}$`. */
function freshHandle(): string {
  return `t${crypto.randomUUID().replace(/-/g, "").slice(0, 15)}`;
}

/*
 * `stackUp` is a top-level-await CONSTANT, not a function — the guard runs once
 * per file and the suite is selected from it, so a stopped stack SKIPS rather
 * than failing eight times. It requires a 401 from the function AND a sub-500
 * answer to a real command: with the Edge runtime down the gateway still
 * answers 503, and an "any response" check once reported the stack as up while
 * nine tests failed instead of skipping.
 */
const suite = stackUp ? describe : describe.skip;

suite("renaming, against the running stack", () => {
  it("accepts the display-name PATCH the client makes", async () => {
    const userId = await createUser();
    const token = signToken(userId);

    const result = await rename(token, userId, { display_name: "Vale of Arc" });
    expect(result.status, result.message ?? "").toBeLessThan(300);

    expect((await readOwn(token, userId))?.display_name).toBe("Vale of Arc");
  });

  it("accepts a handle change and stores it lowercased", async () => {
    const userId = await createUser();
    const token = signToken(userId);
    const handle = freshHandle();

    const result = await rename(token, userId, { username: handle.toUpperCase() });
    expect(result.status, result.message ?? "").toBeLessThan(300);

    /*
     * The whole reason the store re-reads the row instead of echoing the draft:
     * `guard_profile_username` lowercases, so the stored value is not the value
     * that was sent.
     */
    expect((await readOwn(token, userId))?.username).toBe(handle);
  });

  it("changes both columns in one request", async () => {
    const userId = await createUser();
    const token = signToken(userId);
    const handle = freshHandle();

    const result = await rename(token, userId, {
      display_name: "Both At Once",
      username: handle,
    });
    expect(result.status, result.message ?? "").toBeLessThan(300);

    const row = await readOwn(token, userId);
    expect(row?.display_name).toBe("Both At Once");
    expect(row?.username).toBe(handle);
  });

  it("refuses a reserved handle with the code the client reads", async () => {
    const userId = await createUser();
    const token = signToken(userId);

    const result = await rename(token, userId, { username: "admin" });
    expect(result.status).toBeGreaterThanOrEqual(400);
    // The client's mapping is exercised on the SERVER's own error, not a
    // fabricated one — that is the point of running this against the stack.
    expect(describeRenameError(result).reason).toBe("RESERVED");
  });

  it("refuses a handle somebody else holds", async () => {
    const taken = freshHandle();
    const firstId = await createUser();
    const firstToken = signToken(firstId);
    expect((await rename(firstToken, firstId, { username: taken })).status).toBeLessThan(300);

    const secondId = await createUser();
    const secondToken = signToken(secondId);
    const result = await rename(secondToken, secondId, { username: taken });

    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(describeRenameError(result).reason).toBe("TAKEN");
  });

  it("rate-limits the SECOND handle change, as 429 and not 500", async () => {
    const userId = await createUser();
    const token = signToken(userId);

    expect((await rename(token, userId, { username: freshHandle() })).status).toBeLessThan(300);

    const second = await rename(token, userId, { username: freshHandle() });
    /*
     * HTTP 429, not 500. The limit used to raise SQLSTATE 55000, which
     * PostgREST renders as a 500 — so a player who renamed twice in a month was
     * told the server had broken. That fix has never been reachable from the
     * app until now, which is precisely why it is asserted from the client's
     * own request shape.
     */
    expect(second.status).toBe(429);
    expect(describeRenameError(second).reason).toBe("RATE_LIMITED");
    expect(describeRenameError(second).message).toMatch(/30 days/);
  });

  it("refuses a display name with nothing visible in it", async () => {
    const userId = await createUser();
    const token = signToken(userId);

    // A zero-width space: `char_length` counts it, so a length check alone
    // accepts a name that renders as empty.
    const result = await rename(token, userId, { display_name: "​" });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(describeRenameError(result).reason).toBe("INVALID");
  });

  it("cannot rename anybody else", async () => {
    const victimId = await createUser();
    const victimToken = signToken(victimId);
    const before = await readOwn(victimToken, victimId);

    const attackerId = await createUser();
    const attackerToken = signToken(attackerId);

    // `profiles_update_self` is `using (id = auth.uid())`, so the row simply is
    // not in the attacker's update scope: PostgREST reports success over an
    // empty set rather than an error. The proof is that nothing changed.
    await rename(attackerToken, victimId, { display_name: "Owned" });

    expect((await readOwn(victimToken, victimId))?.display_name).toBe(before?.display_name);
  });
});
