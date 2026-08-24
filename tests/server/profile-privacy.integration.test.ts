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
 * The test tokens carry NO `iat`, deliberately.
 *
 * PostgREST validates `iat` against its own clock and answers
 * `PGRST303 "JWT issued at future"` when it is ahead — and the failure does not
 * look like a clock problem. It looks like a wallet that reads as -1, a profile
 * column that reads as null, or a career reward that was never paid.
 *
 * Backdating by a minute was the first fix and it was not enough: the Docker VM
 * clock jumps rather than drifts, so any constant is a guess about how far.
 * `iat` is an OPTIONAL claim that PostgREST validates only when present, and
 * nothing in this app reads it, so omitting it removes the failure mode instead
 * of narrowing it. `exp` still bounds the token, and an `exp` an hour out is
 * safe against skew in the direction that matters.
 *
 * Test-only: Supabase issues real tokens server-side, where there is one clock.
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

/** Calls an RPC as a signed-in player — never as the service role. */
async function rpc(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${REST}/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: LOCAL_SERVICE_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args),
  });
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    body = raw;
  }
  return { status: response.status, body, raw };
}

interface PublicProfileRow {
  user_id: string;
  username: string;
  display_name: string;
  level: number;
  privacy: string;
  is_friend: boolean;
  stats_visible: boolean;
  hands_played: number | null;
  career_stars: number | null;
  tournament_wins: number | null;
  last_seen_at: string;
}

/** The read the friend profile makes. Returns `null` when there is no row. */
async function publicProfile(
  viewerToken: string,
  subjectId: string,
): Promise<PublicProfileRow | null> {
  const result = await rpc(viewerToken, "player_public_profile", { p_user_id: subjectId });
  if (result.status !== 200) {
    // A helper that reads something THROWS when it cannot: a sentinel here
    // would surface later as "expected null to have property username".
    throw new Error(`player_public_profile answered ${result.status}: ${result.raw}`);
  }
  const rows = result.body as PublicProfileRow[];
  return Array.isArray(rows) ? (rows[0] ?? null) : null;
}

/** Makes two accounts confirmed friends through the real request flow. */
async function befriend(aToken: string, aId: string, bToken: string, bId: string): Promise<void> {
  const sent = await rpc(aToken, "send_friend_request", { p_to: bId });
  if (sent.status !== 200) throw new Error(`send_friend_request: ${sent.status} ${sent.raw}`);
  const accepted = await rpc(bToken, "accept_friend_request", { p_from: aId });
  if (accepted.status !== 200) {
    throw new Error(`accept_friend_request: ${accepted.status} ${accepted.raw}`);
  }
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

/**
 * `player_public_profile` — the read a friend's profile is built from.
 *
 * The specification's FRIEND PROFILE list is nine things, and five of them are
 * numbers about somebody else: public stats, career stars and tournament wins.
 * Nothing in this schema could answer that before — `my_competition_record` and
 * `my_career_progress` both derive from `auth.uid()` and correctly answer only
 * about the caller — so the screen showed four items for a whole phase.
 *
 * A read that returns one player's record TO ANOTHER PLAYER is the most
 * disclosure-shaped thing in this schema, so it is proved here against the real
 * database with two real tokens rather than asserted in a comment. The rule it
 * implements, from Settings' own wording that privacy "controls who can see
 * your profile and standings":
 *
 *   identity  — returned to anybody not blocked, because `search_players`
 *               already discloses username, display name and level and hiding
 *               them here would conceal nothing;
 *   NUMBERS   — governed by `profiles.privacy`, all of them, not just the ones
 *               the word "stats" obviously covers;
 *   a block   — in EITHER direction, returns no row at all. Not an empty
 *               profile: the same answer as a user id that never existed.
 */
suite("one player's profile, as another player may see it", () => {
  it("gives a stranger the identity and the numbers when the record is public", async () => {
    const subjectId = await createUser();
    const viewerId = await createUser();
    const subject = signToken(subjectId);
    const viewer = signToken(viewerId);

    expect((await setPrivacy(subject, subjectId, "public")).status).toBe(200);

    const row = await publicProfile(viewer, subjectId);
    expect(row).not.toBeNull();
    expect(row?.user_id).toBe(subjectId);
    expect(row?.is_friend).toBe(false);
    expect(row?.stats_visible).toBe(true);
    // Zero, because this account has played nothing — and zero is the honest
    // answer only because the record IS visible. The next test is the one that
    // proves the difference.
    expect(row?.hands_played).toBe(0);
    expect(row?.career_stars).toBe(0);
    expect(row?.tournament_wins).toBe(0);
  }, 30_000);

  /**
   * NULL, NOT ZERO, and this is the assertion the whole design turns on. A zero
   * here would render as a real record of nothing, which is a different and
   * untrue claim about somebody — and it is exactly what a `coalesce` written
   * one line too early would produce.
   */
  it("returns no numbers at all — null, not zero — when the record is private", async () => {
    const subjectId = await createUser();
    const viewerId = await createUser();
    const subject = signToken(subjectId);
    const viewer = signToken(viewerId);

    expect((await setPrivacy(subject, subjectId, "private")).status).toBe(200);

    const row = await publicProfile(viewer, subjectId);
    expect(row).not.toBeNull();
    // Identity still comes back. Withholding it would conceal nothing that
    // `search_players` does not already disclose.
    expect(row?.username).toBeTruthy();
    expect(typeof row?.level).toBe("number");
    expect(row?.stats_visible).toBe(false);
    expect(row?.hands_played).toBeNull();
    expect(row?.career_stars).toBeNull();
    expect(row?.tournament_wins).toBeNull();
  }, 30_000);

  it("shows a friends-only record to a confirmed friend and to nobody else", async () => {
    const subjectId = await createUser();
    const friendId = await createUser();
    const strangerId = await createUser();
    const subject = signToken(subjectId);
    const friend = signToken(friendId);
    const stranger = signToken(strangerId);

    expect((await setPrivacy(subject, subjectId, "friends")).status).toBe(200);

    // Before the friendship: identity yes, numbers no.
    const beforeRow = await publicProfile(friend, subjectId);
    expect(beforeRow?.is_friend).toBe(false);
    expect(beforeRow?.stats_visible).toBe(false);
    expect(beforeRow?.hands_played).toBeNull();

    await befriend(subject, subjectId, friend, friendId);

    const afterRow = await publicProfile(friend, subjectId);
    expect(afterRow?.is_friend).toBe(true);
    expect(afterRow?.stats_visible).toBe(true);
    expect(afterRow?.hands_played).toBe(0);

    // A stranger is unaffected by somebody else's friendship.
    const strangerRow = await publicProfile(stranger, subjectId);
    expect(strangerRow?.is_friend).toBe(false);
    expect(strangerRow?.stats_visible).toBe(false);
    expect(strangerRow?.career_stars).toBeNull();
  }, 60_000);

  /**
   * A block must not be discoverable by the person blocked. So the answer is NO
   * ROW — byte-identical to a user id that never existed — and it is the same
   * in both directions, because a blocker who could still read the profile
   * would have a one-way mirror.
   */
  it("returns nothing at all across a block, in either direction", async () => {
    const oneId = await createUser();
    const twoId = await createUser();
    const one = signToken(oneId);
    const two = signToken(twoId);

    // Both public, so nothing but the block can be doing the hiding.
    expect((await setPrivacy(one, oneId, "public")).status).toBe(200);
    expect((await setPrivacy(two, twoId, "public")).status).toBe(200);
    expect(await publicProfile(one, twoId)).not.toBeNull();

    const blocked = await rpc(one, "block_player", { p_other: twoId });
    expect(blocked.status).toBe(200);

    // The blocker sees nothing...
    expect(await publicProfile(one, twoId)).toBeNull();
    // ...and neither does the person blocked, who is never told why.
    expect(await publicProfile(two, oneId)).toBeNull();

    // The same answer a user id that never existed gets.
    expect(await publicProfile(one, "00000000-0000-4000-8000-000000000999")).toBeNull();
  }, 60_000);

  it("always shows a player their own record, whatever they set", async () => {
    const subjectId = await createUser();
    const subject = signToken(subjectId);
    expect((await setPrivacy(subject, subjectId, "private")).status).toBe(200);

    const row = await publicProfile(subject, subjectId);
    expect(row?.stats_visible).toBe(true);
    expect(row?.hands_played).toBe(0);
  }, 30_000);

  it("refuses an unauthenticated caller", async () => {
    const subjectId = await createUser();
    const response = await fetch(`${REST}/rpc/player_public_profile`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: LOCAL_SERVICE_KEY,
        Authorization: `Bearer ${LOCAL_SERVICE_KEY}`,
      },
      body: JSON.stringify({ p_user_id: subjectId }),
    });
    // `revoke execute … from public, anon` plus the function's own auth.uid()
    // check. Either way it must not answer with a profile.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain(subjectId);
  }, 30_000);
});
