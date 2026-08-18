/**
 * Arc 21 — session storage for Supabase Auth.
 *
 * The persisted auth session contains a refresh token. A refresh token is a
 * long-lived bearer credential: whoever holds it can mint access tokens for that
 * account until it is revoked. Under this project's threat model — a device and
 * its storage fully under an attacker's control — it does not belong in
 * AsyncStorage or SQLite alongside the practice save. It goes in the platform
 * keychain / keystore, which is what `expo-secure-store` wraps.
 *
 * Two implementation details matter and are easy to get wrong:
 *
 *   1. **The 2048-byte limit.** iOS SecureStore warns and can fail above roughly
 *      2 KB per value, and a Supabase session — two JWTs plus the user record —
 *      routinely exceeds that once `user_metadata` is populated. The value is
 *      therefore chunked, with a manifest under the caller's key. Getting this
 *      wrong produces the worst kind of bug: sign-in works, and the session
 *      silently fails to survive a restart for *some* accounts.
 *
 *   2. **This adapter must never throw.** GoTrue awaits storage inside its own
 *      initialisation; a rejected read there leaves the client wedged with no
 *      session and no error surfaced to the UI. Every operation here degrades to
 *      "no stored session" instead, which is recoverable by signing in again.
 *
 * The module is imported lazily and typed structurally so this file stays
 * loadable in a plain Node test process, where `expo-secure-store` has no native
 * backing — the same approach `src/lib/persistence/key-value-store.ts` uses.
 */

/** The shape `@supabase/supabase-js` expects for `auth.storage`. */
export interface SupportedStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Characters per chunk.
 *
 * The platform limit is roughly 2,048 **bytes**, and `String.prototype.slice`
 * counts **UTF-16 units**. A display name in a non-Latin script is three UTF-8
 * bytes per unit, so a chunk size chosen against the byte limit directly would
 * overflow for exactly the users least likely to be tested against. 650 units
 * cannot exceed 1,950 bytes even in the worst case, which leaves headroom for
 * the key itself.
 */
export const CHUNK_SIZE = 650;

/**
 * Above this many chunks something is wrong; refuse rather than write a hundred
 * keychain entries. 48 chunks is roughly a 30 KB session — far larger than any
 * legitimate one.
 */
const MAX_CHUNKS = 48;

const MANIFEST_PREFIX = "arc21.chunked.v1:";

/**
 * The subset of `expo-secure-store` used here, declared structurally so no
 * build-time dependency on its typings is required.
 */
export interface SecureStoreLike {
  getItemAsync(key: string, options?: Record<string, unknown>): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: Record<string, unknown>): Promise<void>;
  deleteItemAsync(key: string, options?: Record<string, unknown>): Promise<void>;
  WHEN_UNLOCKED_THIS_DEVICE_ONLY?: unknown;
}

/**
 * Chunking session storage over any secure backend.
 *
 * Exported with the backend injected so the chunk arithmetic — the part with
 * real failure modes — is tested against an in-memory double rather than a
 * simulator.
 */
export class ChunkedSecureSessionStorage implements SupportedStorage {
  constructor(
    private readonly backend: SecureStoreLike,
    private readonly options: Record<string, unknown> = {},
  ) {}

  async getItem(key: string): Promise<string | null> {
    try {
      const head = await this.backend.getItemAsync(key, this.options);
      if (head === null) return null;
      if (!head.startsWith(MANIFEST_PREFIX)) return head;

      const count = Number.parseInt(head.slice(MANIFEST_PREFIX.length), 10);
      if (!Number.isInteger(count) || count <= 0 || count > MAX_CHUNKS) return null;

      const parts: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const part = await this.backend.getItemAsync(chunkKey(key, index), this.options);
        // A partial write, or a chunk evicted by an OS keychain migration, is
        // not recoverable into a valid session. Treat it as absent rather than
        // handing GoTrue a truncated JSON blob it will throw on.
        if (part === null) return null;
        parts.push(part);
      }
      return parts.join("");
    } catch {
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      // Always clear the previous representation first. Writing a short value
      // over a previously chunked one would otherwise leave orphan chunks that
      // a later long write could half-overwrite.
      await this.clearChunks(key);

      if (value.length <= CHUNK_SIZE) {
        await this.backend.setItemAsync(key, value, this.options);
        return;
      }

      const chunks: string[] = [];
      for (let offset = 0; offset < value.length; offset += CHUNK_SIZE) {
        chunks.push(value.slice(offset, offset + CHUNK_SIZE));
      }
      if (chunks.length > MAX_CHUNKS) {
        // Refusing to persist is better than writing a session we cannot read
        // back: the user stays signed in for this launch and signs in again
        // next time, rather than hitting a corrupt restore forever.
        return;
      }

      for (const [index, chunk] of chunks.entries()) {
        await this.backend.setItemAsync(chunkKey(key, index), chunk, this.options);
      }
      await this.backend.setItemAsync(key, `${MANIFEST_PREFIX}${chunks.length}`, this.options);
    } catch {
      // A session that fails to persist costs a re-sign-in. A throw here costs
      // the whole auth client.
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      await this.clearChunks(key);
      await this.backend.deleteItemAsync(key, this.options);
    } catch {
      // Sign-out must complete in memory whatever the keychain does.
    }
  }

  private async clearChunks(key: string): Promise<void> {
    const head = await this.backend.getItemAsync(key, this.options);
    if (head === null || !head.startsWith(MANIFEST_PREFIX)) return;

    const count = Number.parseInt(head.slice(MANIFEST_PREFIX.length), 10);
    const bounded = Number.isInteger(count) && count > 0 ? Math.min(count, MAX_CHUNKS) : MAX_CHUNKS;
    for (let index = 0; index < bounded; index += 1) {
      await this.backend.deleteItemAsync(chunkKey(key, index), this.options);
    }
  }
}

/**
 * SecureStore keys are restricted to `[A-Za-z0-9._-]`, which the suffix
 * respects. Supabase's own storage key (`sb-<ref>-auth-token`) already does.
 */
function chunkKey(key: string, index: number): string {
  return `${key}.${index}`;
}

/**
 * In-memory fallback, used when the secure backend cannot be loaded at all —
 * web, or a misconfigured native build.
 *
 * It is deliberately NOT durable: the alternative would be silently downgrading
 * a refresh token into unprotected storage, which is exactly the thing this
 * module exists to prevent. The cost is signing in again after a restart.
 */
export class EphemeralSessionStorage implements SupportedStorage {
  private readonly entries = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.entries.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/**
 * The production adapter.
 *
 * `expo-secure-store` is imported on first use rather than at module scope, so
 * importing anything in this folder from a Node test process does not reach for
 * a native module that is not there.
 */
export function createSecureSessionStorage(): SupportedStorage {
  let backend: Promise<SecureStoreLike | null> | null = null;

  const load = async (): Promise<SecureStoreLike | null> => {
    backend ??= (async () => {
      try {
        return (await import("expo-secure-store")) as unknown as SecureStoreLike;
      } catch {
        return null;
      }
    })();
    return backend;
  };

  const fallback = new EphemeralSessionStorage();
  let resolved: SupportedStorage | null = null;

  const resolve = async (): Promise<SupportedStorage> => {
    if (resolved !== null) return resolved;

    const module = await load();
    resolved =
      module === null
        ? fallback
        : new ChunkedSecureSessionStorage(module, {
            // Keeps the refresh token off iCloud Keychain sync and unreadable
            // while the device is locked. Auto-refresh only runs in the
            // foreground, so the stricter accessibility class costs nothing.
            keychainAccessible: module.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          });
    return resolved;
  };

  return {
    getItem: async (key) => (await resolve()).getItem(key),
    setItem: async (key, value) => (await resolve()).setItem(key, value),
    removeItem: async (key) => (await resolve()).removeItem(key),
  };
}
