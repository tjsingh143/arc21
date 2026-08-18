/**
 * Unpredictable identifiers.
 *
 * Two callers need one: the `clientActionId` that makes an economic command
 * replay-safe, and the local guest identity. Both are generated from the
 * platform CSPRNG.
 *
 * `Math.random()` is not used here for the same reason it is not used for a
 * shoe. A guessable `clientActionId` is not merely untidy: the server's
 * idempotency table returns *the first committed result* for a key it has
 * already seen, so a client that can predict another client's next key can
 * cause that player's next command to be answered with someone else's outcome
 * rather than being applied. The value must be unguessable, not merely unique.
 *
 * Like the engine's `CryptoRandomSource`, this throws when no CSPRNG is present
 * rather than degrading. `installCryptoPolyfill()` runs at the top of the root
 * layout, so on a device it is always available; a throw here means the polyfill
 * was removed, which is a defect worth failing loudly on.
 */

function cryptoOrThrow(): Crypto {
  const source = globalThis.crypto as Crypto | undefined;
  if (!source || typeof source.getRandomValues !== "function") {
    throw new Error(
      "No CSPRNG available. installCryptoPolyfill() must run before any identifier is generated.",
    );
  }
  return source;
}

/** RFC 4122 version 4, from the platform CSPRNG. */
export function randomUuid(): string {
  const source = cryptoOrThrow();
  if (typeof source.randomUUID === "function") return source.randomUUID();

  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  // Version 4, variant 10xx — set explicitly so the value is a well-formed UUID
  // and not merely 16 random bytes formatted like one.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A fresh idempotency key for one command attempt.
 *
 * Generated once per *intent* and reused across retries of that same intent —
 * that is the whole point. Generating a new one when a request times out would
 * turn "did my bet land?" into "place the bet twice".
 */
export function newClientActionId(): string {
  return randomUuid();
}

/**
 * The local guest identity.
 *
 * Namespaced so it can never be mistaken for a server `user_id` in a log, a
 * cache key or a payload. A guest has no server identity at all; anything that
 * receives this string and expects a UUID is a bug, and the prefix makes that
 * bug visible immediately rather than three layers down.
 */
export function newGuestId(): string {
  return `guest_${randomUuid()}`;
}

export function isGuestId(value: string): boolean {
  return value.startsWith("guest_");
}
