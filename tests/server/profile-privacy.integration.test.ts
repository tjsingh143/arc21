/**
 * "Who can see your statistics" — proved against the real database.
 *
 * THE DEFECT THIS COVERS. `public.profiles.privacy` works and always did:
 * `profiles_select_visible` refuses the row when it is `private` and narrows it
 * to friends when it is `friends`, and `04_privacy.test.sql` has asserted that
 * since phase 3. What nothing asserted is that a CLIENT can set it — and
 * nothing could, because `database.types.ts` declared `profiles` read-only, so
 * every write was a compile error. The Settings control therefore stored the
 * player's answer locally and every account in existence stayed at the column
 * default of `public`.
 *
 * Testing the enforcement again would prove nothing new. What is tested here is
 * the half that was missing: that the column grant and the row policy actually
 * accept the update the client now makes, through PostgREST, with an ordinary
 * user's token — and that the update has the effect the Settings screen claims,
 * as seen by a DIFFERENT player.
 *
 * That last part is the point. "Test the CONTROL, not only the function behind
 * it" is in CLAUDE.md because three defects have already survived a test of the
 * function a dead control would have called.
 */

import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { stackUp } from "./stack-guard.js";

const SUPABASE_URL = "http://127.0.0.1:54321";
const REST = `${SUPABASE_URL}/rest/v1`;
const AUTH_ADMIN = `${SUPABASE_URL}/auth/v1/admin/users`;

/** Published local-development keys. Identical on every machine, useless elsewhere. */
const LOCAL_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const LOCAL_SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * Tokens are backdated by a minute, and that is not cosmetic.
 *
 * PostgREST validates `iat` against the DATABASE CONTAINER's clock and answers
 * `PGRST303 "JWT issued at future"` when it is even slightly ahead. The host
 * and the container drift by a second or two under load, so an `iat` of exactly
 * "now" is a coin flip — and the failure does not look like a clock problem. It
 * looks like a wallet that reads as -1, a profile column that reads as null, or
 * a career reward that was never paid.
 *
 * Sixty seconds is the same allowance the FUNCTION's own verifier makes, and it
 * is test-only: Supabase issues real tokens server-side, where there is one
 * clock.
 */
const CLOCK_SKEW_ALLOWANCE_SECONDS = 60;

function signToken(sub: string): string {
  const header = b64({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({ sub, role: "authenticated", aud: "authenticated", iat: now - CLOCK_SKEW_ALLOWANCE_SECONDS, exp: now + 3600 });
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
      email: `privacy-${crypto.randomUUID()}@arc21.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
    }),
  });
  const json = (await response.json()) as { id?: string };
  if (!json.id) throw new Error(`could not create a test user: ${response.status}`);
  return json.id;
}

/** The exact request the client makes: PATCH one column on your own row. */
async function setPrivacy(token: string, userId: string, privacy: string) {
  const response = await fetch(`${REST}/profiles?id=eq.${userId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ privacy }),
  });
  return { status: response.status, body: await response.text() };
}

/**
 * Reads a player's own `privacy` value as that player.
 *
 * NOT as `service_role`: this schema deliberately never granted it SELECT on
 * `profiles`, so a service-key read answers 42501 "permission denied". That is
 * the narrow-surface design working, and it means the honest way to check the
 * value is the way the app itself would — through `profiles_select_self`.
 */
async function readOwnPrivacy(token: string, userId: string): Promise<string | null> {
  const response = await fetch(`${REST}/profiles?select=privacy&id=eq.${userId}`, {
    headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  const rows = (await response.json()) as Array<{ privacy: string }>;
  return rows[0]?.privacy ?? null;
}

/** Can `viewer` see `subject`'s profile row at all? */
async function canSee(viewerToken: string, subjectId: string): Promise<boolean> {
  const response = await fetch(`${REST}/profiles?select=id&id=eq.${subjectId}`, {
    headers: { apikey: LOCAL_SERVICE_KEY, Authorization: `Bearer ${viewerToken}` },
  });
  const rows = (await response.json()) as Array<{ id: string }>;
  return rows.length === 1;
}

const suite = stackUp ? describe : describe.skip;

suite("the visibility control reaches the column that enforces it", () => {
  it("starts public, which is why the sync had to exist", async () => {
    const userId = await createUser();
    // The column default. A player whose local preference says "private" and
    // whose row says this is the exact state the fix removes.
    expect(await readOwnPrivacy(signToken(userId), userId)).toBe("public");
  }, 30_000);

  it("accepts the update a signed-in client makes, for each of the three values", async () => {
    const userId = await createUser();
    const token = signToken(userId);

    for (const privacy of ["private", "friends", "public"] as const) {
      const result = await setPrivacy(token, userId, privacy);
      expect(result.status, `PATCH privacy=${privacy} -> ${result.body}`).toBe(200);
      expect(await readOwnPrivacy(token, userId)).toBe(privacy);
    }
  }, 30_000);

  it("actually hides the profile from another player once set to private", async () => {
    const subjectId = await createUser();
    const viewerId = await createUser();
    const subjectToken = signToken(subjectId);
    const viewerToken = signToken(viewerId);

    // Public: visible. This is the state every account was stuck in.
    expect(await canSee(viewerToken, subjectId)).toBe(true);

    expect((await setPrivacy(subjectToken, subjectId, "private")).status).toBe(200);
    expect(await canSee(viewerToken, subjectId)).toBe(false);

    // And it is reversible, so the control works in both directions rather
    // than being a one-way door.
    expect((await setPrivacy(subjectToken, subjectId, "public")).status).toBe(200);
    expect(await canSee(viewerToken, subjectId)).toBe(true);
  }, 30_000);

  it("refuses to let one player set another player's visibility", async () => {
    const subjectId = await createUser();
    const attackerId = await createUser();
    const subjectToken = signToken(subjectId);
    const attackerToken = signToken(attackerId);

    const result = await setPrivacy(attackerToken, subjectId, "public");
    // RLS matches no row for someone else's id, so nothing is updated. The
    // status may be 200 with an empty representation rather than an error —
    // what matters is that the value did not move.
    expect(result.body).not.toContain(subjectId);
    expect(await readOwnPrivacy(subjectToken, subjectId)).toBe("public");

    // And the same attacker cannot widen their own row beyond the granted
    // column set: `level` is server-owned.
    const escalation = await fetch(`${REST}/profiles?id=eq.${attackerId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: LOCAL_SERVICE_KEY,
        Authorization: `Bearer ${attackerToken}`,
      },
      body: JSON.stringify({ level: 99 }),
    });
    expect(escalation.status).toBeGreaterThanOrEqual(400);
  }, 30_000);
});
