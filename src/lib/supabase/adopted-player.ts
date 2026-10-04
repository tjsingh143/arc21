/**
 * Arc 21 — the player the app has ADOPTED, as the network layer sees it.
 *
 * Six facts are easy to run together, and the final Refresh-B audit (B-H1)
 * caught the app running the first two into the last:
 *
 *   1. the keychain holds credential material;
 *   2. that material can be read;
 *   3. the credential can authenticate;
 *   4. the auth server confirms its account exists;
 *   5. the app has ADOPTED that player — the Auth store shows it;
 *   6. account-owned server work may be done as that player.
 *
 * The SDK produces a session from (1) and (2) alone — a restored credential,
 * before anybody has asked the server about it — and attaches it to every
 * request it sends. Screens that asked `auth.getSession()` "is somebody signed
 * in?" took a yes for (6). Measured against the real backend: with `/user`
 * unreachable and nobody adopted, Inventory granted four cosmetics and Daily
 * opened a RANKED game as the restored, unconfirmed player.
 *
 * The rule is that (6) requires (5), and (5) happens only on the auth server's
 * word (`supabase-auth-adapter.ts`). The Auth store publishes whom it has
 * adopted here on every change (`auth-store.ts`); account-owned code learns who
 * the player is only through `player-binding.ts`, which consults it; and the
 * production client's own fetch refuses to send as a credential that was never
 * adopted in this process (`client.ts`).
 *
 * MANAGED CLIENTS. The rule applies to every client whose identity the app's
 * lifecycle manages: the production client from birth (`client.ts`), and any
 * client the auth adapter is attached to. A harness that builds a client by
 * hand and never involves the identity lifecycle has no adopted player to
 * compare with; there is no such client in the shipped app.
 *
 * This grants nothing. The server still verifies every JWT and RLS still
 * decides. What it prevents is the device ever SENDING account-owned work as a
 * credential the server has not vouched for in this process.
 */

let adopted: string | null = null;
const managed = new WeakSet<object>();
/** Every player adopted while a given client was the app's client — a departing player included. */
const adoptedOn = new WeakMap<object, Set<string>>();

/** Called by the Auth store on every change of the player it shows. Nothing else adopts. */
export function publishAdoptedPlayer(client: object | null, userId: string | null): void {
  adopted = userId;
  if (client === null || userId === null) return;
  const players = adoptedOn.get(client) ?? new Set<string>();
  players.add(userId);
  adoptedOn.set(client, players);
}

/** The player the app shows, or null: nobody, or nobody yet confirmed. */
export function adoptedPlayer(): string | null {
  return adopted;
}

/** From here on, `client`'s requests are subject to the adoption rule. */
export function manageIdentity(client: object): void {
  managed.add(client);
}

/**
 * Whether account-owned work may be prepared as `userId` on `client` NOW: only
 * as the player the app has adopted. Checked when a request is bound and again
 * immediately before it is written.
 */
export function mayActAs(client: object, userId: string): boolean {
  return !managed.has(client) || userId === adopted;
}

/**
 * For the few calls that name nobody and act as whoever the SDK holds (the
 * presence heartbeat): only once the app has adopted somebody. The dispatch
 * floor below then refuses a credential that is not that player's.
 */
export function someoneIsAdopted(client: object): boolean {
  return !managed.has(client) || adopted !== null;
}

/**
 * The floor for anything the client sends: a credential adopted at some point
 * while this was the app's client. Wider than `mayActAs` on purpose — a
 * departure already bound to the player who is leaving (a push retirement) must
 * still be able to finish after the next player is adopted — and never wide
 * enough for a credential nobody adopted: a restored one awaiting
 * confirmation, or an erased one.
 */
export function mayDispatchAs(client: object, userId: string): boolean {
  return !managed.has(client) || (adoptedOn.get(client)?.has(userId) ?? false);
}

/** What the dispatch floor throws instead of sending: nothing left the device. */
export class UnadoptedCredentialError extends Error {
  constructor() {
    super("Not sent: no player confirmed by the auth server holds this credential on this device.");
    this.name = "UnadoptedCredentialError";
  }
}

/**
 * The production client's fetch (`client.ts`): every request is checked as it
 * leaves, because the SDK attaches whatever session it holds to anything sent
 * through it — including a loader that never asked who the player is.
 *
 * Passed: the auth server's own endpoints (confirmation happens there), a
 * request carrying only the publishable key, and one whose bearer names a
 * player adopted on this client (`mayDispatchAs`). Refused: everything else —
 * a restored credential awaiting the server's word, an erased player's, or a
 * player the SDK switched to before the app adopted them. The subject is read
 * from the token only to compare it; the token is never kept or logged, and
 * the server still verifies it.
 */
export function adoptionGatedFetch(
  baseUrl: string,
  publishableKey: string,
  clientOf: () => object | null,
): typeof fetch {
  const authPath = new URL("auth/v1/", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).pathname;
  const permitted = (client: object, input: RequestInfo | URL, init?: RequestInit): boolean => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(target).pathname.startsWith(authPath)) return true;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const authorization = headers.get("Authorization");
    if (authorization === null) return true;
    const token = authorization.replace(/^Bearer\s+/i, "");
    if (token === publishableKey) return true;
    const subject = subjectOf(token);
    return subject !== null && mayDispatchAs(client, subject);
  };
  return (input, init) => {
    const client = clientOf();
    if (client !== null && !permitted(client, input, init)) return Promise.reject(new UnadoptedCredentialError());
    return globalThis.fetch(input, init);
  };
}

/** A JWT's `sub`, unverified: only to say whom a request would be sent as. */
function subjectOf(token: string): string | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(base64UrlToLatin1(payload)) as { sub?: unknown };
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Byte-for-byte, as Latin-1 — enough to JSON-parse a claim set and read an
 * ASCII `sub`, with no `atob`, `Buffer` or `TextDecoder` to depend on.
 */
function base64UrlToLatin1(segment: string): string {
  let buffer = 0;
  let bits = 0;
  let text = "";
  for (const char of segment) {
    if (char === "=") break;
    const value = BASE64URL.indexOf(char === "+" ? "-" : char === "/" ? "_" : char);
    if (value < 0) throw new Error("not base64url");
    buffer = ((buffer << 6) | value) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      text += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return text;
}
