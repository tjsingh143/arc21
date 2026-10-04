/**
 * Arc 21 — binding a mutating request to the player who asked for it.
 *
 * Every social and room RPC names only the OTHER party: `send_friend_request`
 * takes the recipient, `join_private_room` takes a code. WHO is acting comes
 * from the JWT the SDK attaches as the request leaves — and the SDK attaches
 * whatever session it holds at that moment, not the one the player held when
 * they tapped. Between those two moments sits an `await`, because each of these
 * paths reads the session first in order to tell "signed out" apart from "the
 * server did not answer".
 *
 * That gap was reproduced rather than reasoned about. Player A started a friend
 * request, the session read was held across a real sign-in to player B, and the
 * row landed in the database with **B as the sender**. The store's own player
 * scope discarded the reply afterwards, which is exactly why nothing on screen
 * said anything: the UI was right and the database was wrong. Discarding a
 * result cannot undo a write.
 *
 * So the credential is chosen ONCE and travels with the request:
 *
 *  - `capturePlayerScope()` is read before the first `await`, so the revision is
 *    the one the caller dispatched under. **Call this as the first statement of
 *    a mutating method**, ahead of any other await: a binding taken after one is
 *    a binding to whoever is current by then, which is the defect.
 *  - The identity is checked after the session read and again immediately before
 *    the request, and a changed player REFUSES. Not as the new player, and not
 *    as the old one either — that dispatch is over.
 *  - The verified token is pinned into the request's own `Authorization` header.
 *    The SDK's `fetchWithAuth` fills that header in only when it is absent, so a
 *    pinned one wins and a sign-in landing inside the fetch cannot substitute
 *    the replacement player's JWT. `session-intent.ts` pins the same way for the
 *    economic one-shots; this is that rule for the mutations that have no
 *    idempotency record to fall back on.
 *
 * This is not a second authentication system and it grants nothing. The server
 * still verifies the JWT and RLS still decides. What it prevents is one player's
 * intent ever being SENT as another player's.
 *
 * Its premise is that the player the app shows is the player SDK storage holds,
 * because the session read above comes from storage. The final Refresh-B audit
 * broke that premise with a keychain that refused a sign-in's write: the app
 * showed the new player while storage — and so every request — still held the
 * old one (B-R6). `secure-session-storage.ts` now refuses such a write before
 * GoTrue can announce the new player, so an identity change is adopted only once
 * storage serves it.
 *
 * And the session storage serves is not yet a player. A credential restored
 * from the keychain is served by the SDK before the auth server has said its
 * account exists, and the final Refresh-B audit (B-H1) used exactly that window:
 * Inventory granted cosmetics and Daily opened a ranked game as a player nobody
 * had confirmed, because each asked the SDK, not the app, who was signed in. So
 * the SDK's session counts here only when it belongs to the player the app has
 * ADOPTED (`adopted-player.ts`), and that is checked again before every write.
 * `confirmedSession` is the same rule for the loaders, and it is the only way
 * account-owned code outside the auth adapter may read the session
 * (`tests/contracts/confirmed-player-boundary.test.ts`).
 */

import { capturePlayerScope } from "../../features/player/player-scope.js";
import { adoptedPlayer, mayActAs } from "./adopted-player.js";
import type { ArcSupabaseClient } from "./client.js";
import { isTimedOut, withTimeout } from "./with-timeout.js";

type SessionRead = Awaited<ReturnType<ArcSupabaseClient["auth"]["getSession"]>>;

/**
 * The SDK's session, if — and only if — it is the adopted player's; otherwise
 * the same answer as nobody signed in. Shaped like `auth.getSession()` so a
 * loader's "signed out" branch is exactly the branch an unconfirmed, erased or
 * not-yet-adopted credential takes.
 */
export async function confirmedSession(client: ArcSupabaseClient): Promise<SessionRead> {
  const read = await client.auth.getSession();
  const session = read.data.session;
  if (session !== null && !mayActAs(client, sessionPlayer(session) ?? "")) return { data: { session: null }, error: null };
  return read;
}

/**
 * Pins the project's publishable key onto a read of PUBLIC data, so it is sent
 * as nobody rather than as whatever session the SDK holds — which, before the
 * auth server has confirmed a restored player, is a credential nobody has been
 * confirmed for (B-H1). The key is read from the client's own auth headers; a
 * client without one leaves the request as it is, and the production client's
 * dispatch floor then refuses an unadopted bearer.
 */
export function sentAsNobody<T extends { setHeader(name: string, value: string): T }>(
  request: T,
  client: ArcSupabaseClient,
): T {
  const headers = (client.auth as unknown as { readonly headers?: Readonly<Record<string, unknown>> }).headers;
  const key = headers?.apikey;
  return typeof key === "string" && key !== "" ? request.setHeader("Authorization", `Bearer ${key}`) : request;
}

/** A session's player id, read defensively: a session naming nobody is nobody the app adopted. */
export function sessionPlayer(session: { readonly user?: { readonly id?: unknown } | null }): string | null {
  return typeof session.user?.id === "string" ? session.user.id : null;
}

/**
 * Why nothing was sent.
 *
 * `identity-changed` is its own answer on purpose. It is neither "you are signed
 * out" — somebody is signed in, just not the player who asked — nor "the server
 * is unreachable", which would blame a server that was never called.
 */
export type PlayerBindingFailure = "unreachable" | "signed-out" | "identity-changed";

export interface BoundPlayer {
  /** The verified uuid this work belongs to. */
  readonly userId: string;
  /** The pinned `Authorization` header value for every request of this intent. */
  readonly authorization: string;
  /**
   * False once the app has moved to another player.
   *
   * Re-checked by the caller immediately before the write. A caller that awaits
   * anything else in between would otherwise be trusting a check it made
   * earlier, which is the shape of the defect this module exists for.
   */
  isCurrent(): boolean;
}

export type PlayerBinding =
  | { readonly ok: true; readonly player: BoundPlayer }
  | { readonly ok: false; readonly reason: PlayerBindingFailure };

export async function bindCurrentPlayer(
  client: ArcSupabaseClient,
  timeoutMs?: number,
): Promise<PlayerBinding> {
  // BEFORE the first await. See the header.
  const isCurrent = capturePlayerScope();

  let read;
  try {
    read = await withTimeout(client.auth.getSession(), timeoutMs);
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (isTimedOut(read)) return { ok: false, reason: "unreachable" };
  // The session that came back may already belong to somebody else, and even a
  // correct one is no longer this dispatch's to use.
  if (!isCurrent()) return { ok: false, reason: "identity-changed" };

  const session = read.data.session;
  if (session === null) return { ok: false, reason: "signed-out" };
  // Served, but not the adopted player: nobody confirmed yet (a restored
  // credential the server has not answered for), or somebody the app has not
  // switched to. Neither may act (B-H1).
  if (!mayActAs(client, session.user.id)) {
    return { ok: false, reason: adoptedPlayer() === null ? "signed-out" : "identity-changed" };
  }

  const userId = session.user.id;
  return {
    ok: true,
    player: {
      userId,
      authorization: `Bearer ${session.access_token}`,
      isCurrent: () => isCurrent() && mayActAs(client, userId),
    },
  };
}

/**
 * Pins the bound credential onto one PostgREST request.
 *
 * `setHeader` is the SDK's documented per-request escape hatch, and it is the
 * only way to authenticate ONE query as somebody other than whoever the shared
 * client happens to hold. Setting it on the client would change every request
 * in flight, including the next player's.
 */
export function sentAs<T extends { setHeader(name: string, value: string): T }>(
  request: T,
  player: BoundPlayer,
): T {
  return request.setHeader("Authorization", player.authorization);
}
