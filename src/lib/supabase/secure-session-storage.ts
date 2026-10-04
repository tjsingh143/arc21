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
 *   2. **This adapter must never throw — with one exception.** GoTrue awaits
 *      storage inside its own initialisation; a rejected read there leaves the
 *      client wedged with no session and no error surfaced to the UI. Every read
 *      here degrades to "no stored session" instead, and a removal never
 *      rejects either (point 3). An unlinked player cannot recover by signing
 *      in, so a failed replacement must leave its prior session intact.
 *
 *      The exception is a failed write that would change WHICH PLAYER is stored.
 *      GoTrue keeps no session in memory: every `getSession()`, and so every
 *      outbound request, reads it back from here. And GoTrue treats a resolved
 *      `setItem` as "the new session is now current" — it announces SIGNED_IN
 *      the moment `setItem` returns. So a swallowed failure while replacing
 *      player A with player B produced exactly the split the Refresh-B audit
 *      reproduced (B-R6): the app showed B, and every request was still sent
 *      as A, because A was what this adapter kept serving. Such a write now
 *      REJECTS, before GoTrue announces anything: the sign-in fails, and the app
 *      and its requests both stay with the player that is actually stored. A
 *      failed write for the SAME player (a token refresh, securing on the same
 *      UUID) still degrades as before — identity cannot split on those, and
 *      refusing them would only take a working player offline.
 *
 *   3. **A removal is a verdict, not a hope.** Removal still never throws —
 *      GoTrue calls it inside its own refresh-failure handler, where a
 *      rejection would strand every caller waiting on that refresh. But
 *      swallowing its failure let the final Refresh-B audit (B-F2) sign a
 *      player out while their credential stayed in the keychain: the app
 *      showed nobody, GoTrue went on serving the old player, and a relaunch
 *      restored them. The installed iOS wrapper does not even report a failed
 *      `SecItemDelete`. So a removal now checks what a fresh start could
 *      restore, falls back to OVERWRITING the head with a tombstone (which
 *      every read, including a relaunch's, treats as nothing stored) and then
 *      to breaking the value's chunks, and reports `removed` only once nothing
 *      is restorable. Otherwise it reports `retained`: the credential is still
 *      served, and the durability warning it raises is sticky — a later
 *      successful READ of that surviving credential is not evidence it left.
 *      What the app does with each verdict is `supabase-auth-adapter.ts`'s job.
 *
 *   4. **Absent, present or unknown — decided in one place.** A read and a
 *      removal's verdict used to parse the stored format separately, and they
 *      disagreed about one shape: a head naming chunks the native store says
 *      are not there. The removal rightly called that `absent` — the value can
 *      never be reassembled — while every later read called it a storage
 *      failure. Breaking the chunks is the removal's own last resort, so a
 *      sign-out could create that shape, report success, and leave every
 *      relaunch refusing to start a player for ever, the keychain long since
 *      healthy (B-G3). Both now ask `inspect`. The native store answers `null`
 *      only for an item that does not exist — iOS and Android both THROW for a
 *      keychain that is locked or failing — so only a throw is `unreadable`,
 *      and an unreadable keychain still proves nothing and starts nobody.
 *
 * Long values use two generation banks. Their manifest changes only after all
 * new chunks have been stored; the previous bank is retired after that commit.
 * A process killed between any two native writes therefore restores either the
 * complete old value or the complete new one, never a mixture of both.
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

export type SessionStorageDurability = "unknown" | "durable" | "unavailable";

/**
 * A write that would have made GoTrue announce a player this storage does not
 * serve. See the header, point 2.
 *
 * Structural, like every auth error this app reads: `classifyAuthError` matches
 * the `code`, so the player is told the device could not save the credential —
 * never that the password was wrong, and never anything about either account.
 */
export class SessionReplacementError extends Error {
  readonly code = "session_not_persisted";

  constructor() {
    super("The replacement credential could not be stored on this device.");
    this.name = "SessionReplacementError";
  }
}

/**
 * What a removal achieved, judged by what a fresh start could restore:
 * `removed` — nothing; `retained` — the value that was asked to leave is still
 * served, and would be restored on the next launch.
 */
export type SessionRemovalOutcome = "removed" | "retained";

let durability: SessionStorageDurability = "unknown";
const durabilityListeners = new Set<() => void>();

// The session key's removals, in order. A departure takes a mark before it
// asks GoTrue to sign out and reads the verdict afterwards, so a removal it did
// not cause (or no removal at all) is never mistaken for its own.
let removals = 0;
let lastRemoval: SessionRemovalOutcome | null = null;

function reportSessionRemoval(outcome: SessionRemovalOutcome): void {
  removals += 1;
  lastRemoval = outcome;
}

/** Taken before a departure; see `sessionRemovalSince`. */
export const sessionRemovalMark = (): number => removals;

/** The latest session removal after `mark`, or `none` if nothing was removed. */
export function sessionRemovalSince(mark: number): SessionRemovalOutcome | "none" {
  return removals === mark || lastRemoval === null ? "none" : lastRemoval;
}

/** The most recent session removal's verdict, whoever asked for it. */
export const lastSessionRemoval = (): SessionRemovalOutcome | null => lastRemoval;

/** No credentials or error details are exposed through this UI status seam. */
export const getSessionStorageDurability = (): SessionStorageDurability => durability;

export function subscribeSessionStorageDurability(listener: () => void): () => void {
  durabilityListeners.add(listener);
  return () => durabilityListeners.delete(listener);
}

function reportSessionStorageDurability(next: SessionStorageDurability): void {
  if (durability === next) return;
  durability = next;
  for (const listener of durabilityListeners) {
    try {
      listener();
    } catch {
      // A UI observer cannot break GoTrue's awaited storage operation.
    }
  }
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

const LEGACY_MANIFEST_PREFIX = "arc21.chunked.v1:";
const MANIFEST_PREFIX = "arc21.chunked.v2:";

/**
 * A head that names nothing. Written only when the platform will not delete
 * the head itself; every read treats it exactly like an absent key, and the
 * next stored credential simply overwrites it.
 */
export const REMOVED_HEAD = "arc21.removed.v2";

interface Generation {
  readonly bank: 0 | 1;
  readonly count: number;
}

/**
 * What the native store holds for one key (header, point 4).
 *
 * `absent`: nothing, or the tombstone. `present`: the value every read serves.
 * `broken`: a head naming material the native store answers is not there, or a
 * manifest that cannot be parsed — nothing can reassemble it, on this launch or
 * any other, so it is an absence and not a fault. `unreadable`: a native read
 * threw, which has proved nothing either way.
 */
type Holding =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly value: string }
  | { readonly kind: "broken"; readonly head: string }
  | { readonly kind: "unreadable" };

// Supabase's processLock serializes Auth, but this adapter also protects its
// own read/replace/remove sequence, including two adapters sharing a backend.
const operations = new WeakMap<SecureStoreLike, Map<string, Promise<void>>>();

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
  private readonly failedWrites = new Set<string>();
  /** Keys whose last removal left the value restorable. Only a commit clears it. */
  private readonly retained = new Set<string>();
  /** The broken head each key's leftovers were last swept for, so a refusing platform is asked once. */
  private readonly swept = new Map<string, string>();

  constructor(
    private readonly backend: SecureStoreLike,
    private readonly options: Record<string, unknown> = {},
    private readonly reportDurability: (key: string, status: SessionStorageDurability) => void = () => undefined,
    private readonly reportRemoval: (key: string, outcome: SessionRemovalOutcome) => void = () => undefined,
  ) {}

  async getItem(key: string): Promise<string | null> {
    return this.serialise(key, () => this.read(key));
  }

  /** Serving a value is not evidence that an earlier failure was repaired. */
  private degraded(key: string): SessionStorageDurability {
    return this.failedWrites.has(key) || this.retained.has(key) ? "unavailable" : "durable";
  }

  /**
   * After a read proved nothing is stored. An earlier read that THREW is no
   * longer the keychain's state — it just answered — but a write or removal
   * this instance saw fail still is.
   */
  private absence(key: string): SessionStorageDurability {
    return this.degraded(key) === "unavailable" ? "unavailable" : "unknown";
  }

  /** The committed value, exactly as every later `getItem` will serve it. */
  private async read(key: string): Promise<string | null> {
    const holding = await this.inspect(key);
    switch (holding.kind) {
      case "present":
        this.reportDurability(key, this.degraded(key));
        return holding.value;
      case "broken":
        // Nothing to restore, exactly as a removal's verdict says: an absence,
        // never a reason to refuse the next player. Clearing the leftovers is
        // tidiness, and nothing depends on it succeeding.
        await this.sweep(key, holding.head);
        this.reportDurability(key, this.absence(key));
        return null;
      case "absent":
        this.reportDurability(key, this.absence(key));
        return null;
      case "unreadable":
        this.reportDurability(key, "unavailable");
        return null;
    }
  }

  /**
   * The one judgement of what is stored (header, point 4). Never throws: a
   * native read that throws is `unreadable`, and only that is.
   */
  private async inspect(key: string): Promise<Holding> {
    try {
      const head = await this.backend.getItemAsync(key, this.options);
      if (head === null || head === REMOVED_HEAD) return { kind: "absent" };
      const generation = readGeneration(head);
      const legacy = head.startsWith(LEGACY_MANIFEST_PREFIX);
      // A plain value is served as it stands; a malformed manifest never is.
      if (generation === null && !legacy) {
        return head.startsWith(MANIFEST_PREFIX) ? { kind: "broken", head } : { kind: "present", value: head };
      }
      const count = generation?.count ?? readCount(head.slice(LEGACY_MANIFEST_PREFIX.length));
      if (count === null) return { kind: "broken", head };
      const parts: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const part = await this.backend.getItemAsync(
          generation === null ? legacyChunkKey(key, index) : generationChunkKey(key, generation.bank, index),
          this.options,
        );
        // A chunk the store says does not exist can never be reassembled. Never
        // hand GoTrue a truncated JSON blob or a mixture of generations.
        if (part === null) return { kind: "broken", head };
        parts.push(part);
      }
      return { kind: "present", value: parts.join("") };
    } catch {
      return { kind: "unreadable" };
    }
  }

  /**
   * Best-effort removal of what a broken head leaves behind — chunk fragments
   * of a dead credential. Nothing here can make it restorable again (no step
   * writes credential material), so a crash at any point leaves an absence,
   * and a platform that refuses is not asked again for the same head.
   */
  private async sweep(key: string, head: string): Promise<void> {
    if (this.swept.get(key) === head) return;
    this.swept.set(key, head);
    await attempt(() => this.backend.deleteItemAsync(key, this.options));
    await this.breakChunks(key, head);
    try {
      await this.clearGeneration(key, 0);
      await this.clearGeneration(key, 1);
      await this.clearLegacyChunks(key, head);
    } catch {
      // Unrestorable leftovers only. The next stored credential's commit, or a
      // later launch, retires them.
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    return this.serialise(key, async () => {
      if (await this.replace(key, value)) return;
      this.failedWrites.add(key);
      this.reportDurability(key, "unavailable");
      await this.refuseUnstoredPlayer(key, value);
    });
  }

  /**
   * After a replacement that did not commit: may GoTrue still be told it did?
   *
   * Only if the player it would announce is the player this storage serves,
   * because that is who every later request is sent as. Asked of the storage
   * itself rather than inferred from which native call threw, so a write that
   * reported failure but landed anyway — a platform that updates its in-memory
   * copy before a failed flush — is judged by what reads now return. Nothing
   * readable, or a different player, refuses: the sign-in fails closed.
   */
  private async refuseUnstoredPlayer(key: string, value: string): Promise<void> {
    const next = storedPlayerOf(value);
    // Not a session (a PKCE verifier, or anything else): no identity to split.
    if (next === undefined) return;
    const served = await this.read(key);
    if (served === value) {
      this.failedWrites.delete(key);
      this.reportDurability(key, "durable");
      return;
    }
    if (next !== null && storedPlayerOf(served) === next) return;
    throw new SessionReplacementError();
  }

  /** Writes a value; true only once the head names it, which is the commit. */
  private async replace(key: string, value: string): Promise<boolean> {
    // Validate before touching the previous credential, including its chunks.
    const count = Math.ceil(value.length / CHUNK_SIZE);
    if (count > MAX_CHUNKS) return false;
    let committed = false;
    try {
      const previous = await this.backend.getItemAsync(key, this.options);
      if (previous?.startsWith(LEGACY_MANIFEST_PREFIX)) {
        // Keep the cleanup inventory across a crash after switching away
        // from the v1 head. Its chunks remain untouched until the commit.
        await this.backend.setItemAsync(
          `${key}.v2.legacy`,
          String(readCount(previous.slice(LEGACY_MANIFEST_PREFIX.length)) ?? MAX_CHUNKS),
          this.options,
        );
      }
      if (count <= 1) {
        // A single native item is the commit. Cleanup must follow it.
        await this.backend.setItemAsync(key, value, this.options);
        committed = true;
        this.failedWrites.delete(key);
        this.retained.delete(key);
        this.swept.delete(key);
        this.reportDurability(key, "durable");
        await this.clearGeneration(key, 0);
        await this.clearGeneration(key, 1);
      } else {
        const bank = readGeneration(previous)?.bank === 0 ? 1 : 0;
        const descriptor = generationKey(key, bank);
        const pendingCount = readCount(await this.backend.getItemAsync(descriptor, this.options)) ?? 0;
        // Written first, so an interrupted write leaves a bounded inventory
        // for the next replacement/removal. It never changes the live head.
        await this.backend.setItemAsync(descriptor, String(Math.max(count, pendingCount)), this.options);
        for (let index = 0; index < count; index += 1) {
          await this.backend.setItemAsync(
            generationChunkKey(key, bank, index),
            value.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
            this.options,
          );
        }
        await this.backend.setItemAsync(key, `${MANIFEST_PREFIX}${bank}:${count}`, this.options);
        committed = true;
        this.failedWrites.delete(key);
        this.retained.delete(key);
        this.swept.delete(key);
        this.reportDurability(key, "durable");
        // From this point a failed delete is harmless to the committed value.
        await this.clearGeneration(key, bank === 0 ? 1 : 0);
        for (let index = count; index < pendingCount; index += 1) {
          await this.backend.deleteItemAsync(generationChunkKey(key, bank, index), this.options);
        }
        await this.backend.setItemAsync(descriptor, String(count), this.options);
      }
      await this.clearLegacyChunks(key, previous);
    } catch {
      // Never invalidate the committed head to recover from a failed write.
      // A failed first write still cannot promise durability; no credential
      // is downgraded into ordinary storage or emitted to logs. Whether the
      // failure may be reported to GoTrue is the caller's question.
    }
    return committed;
  }

  /**
   * Never throws (see the header, point 3), and never reports a removal that a
   * relaunch could undo. Each step is judged by `restorable`, not by whether the
   * native call happened to reject.
   */
  async removeItem(key: string): Promise<void> {
    return this.serialise(key, async () => {
      let previous: string | null = null;
      try {
        previous = await this.backend.getItemAsync(key, this.options);
      } catch {
        // Unknown inventory: the ladder below still decides by reading back.
      }
      // Commit absence first. A crash during cleanup cannot resurrect a
      // half-deleted session through a manifest that still points at it.
      await attempt(() => this.backend.deleteItemAsync(key, this.options));
      let state = await this.restorable(key);
      if (state !== "absent") {
        // Refused, or ignored without a word. Overwriting the head commits the
        // same absence: nothing reads a tombstone as a credential.
        await attempt(() => this.backend.setItemAsync(key, REMOVED_HEAD, this.options));
        state = await this.restorable(key);
      }
      if (state !== "absent" && previous !== null) {
        // Last resort: a value missing any one chunk can never be reassembled.
        await this.breakChunks(key, previous);
        state = await this.restorable(key);
      }
      if (state !== "absent") {
        this.retained.add(key);
        this.reportDurability(key, "unavailable");
        this.reportRemoval(key, "retained");
        return;
      }
      this.failedWrites.delete(key);
      this.retained.delete(key);
      this.reportDurability(key, "unknown");
      this.reportRemoval(key, "removed");
      try {
        await this.clearGeneration(key, 0);
        await this.clearGeneration(key, 1);
        await this.clearLegacyChunks(key, previous);
      } catch {
        // Unreachable leftovers only. Their descriptors keep them on the next
        // replacement's or removal's inventory.
      }
    });
  }

  /**
   * What a fresh start could restore for `key`. `read` can only tell GoTrue
   * "a value" or "nothing"; a removal needs to know which nothing: an
   * unreadable keychain has proved nothing, so it is `unknown`, never `absent`.
   */
  private async restorable(key: string): Promise<"absent" | "present" | "unknown"> {
    const holding = await this.inspect(key);
    if (holding.kind === "present") return "present";
    return holding.kind === "unreadable" ? "unknown" : "absent";
  }

  /** Deletes every chunk the head names, each on its own: one gone is enough. */
  private async breakChunks(key: string, head: string): Promise<void> {
    const generation = readGeneration(head);
    const count = generation?.count ?? (head.startsWith(LEGACY_MANIFEST_PREFIX)
      ? readCount(head.slice(LEGACY_MANIFEST_PREFIX.length))
      : null);
    if (count === null) return;
    for (let index = 0; index < count; index += 1) {
      await attempt(() => this.backend.deleteItemAsync(
        generation === null ? legacyChunkKey(key, index) : generationChunkKey(key, generation.bank, index),
        this.options,
      ));
    }
  }

  private async clearGeneration(key: string, bank: 0 | 1): Promise<void> {
    const descriptor = generationKey(key, bank);
    const count = readCount(await this.backend.getItemAsync(descriptor, this.options));
    if (count === null) return;
    for (let index = 0; index < count; index += 1) {
      await this.backend.deleteItemAsync(generationChunkKey(key, bank, index), this.options);
    }
    await this.backend.deleteItemAsync(descriptor, this.options);
  }

  private async clearLegacyChunks(key: string, head: string | null): Promise<void> {
    const descriptor = `${key}.v2.legacy`;
    const count = head?.startsWith(LEGACY_MANIFEST_PREFIX)
      ? readCount(head.slice(LEGACY_MANIFEST_PREFIX.length)) ?? MAX_CHUNKS
      : readCount(await this.backend.getItemAsync(descriptor, this.options));
    if (count === null) return;
    for (let index = 0; index < count; index += 1) {
      await this.backend.deleteItemAsync(legacyChunkKey(key, index), this.options);
    }
    await this.backend.deleteItemAsync(descriptor, this.options);
  }

  private async serialise<T>(key: string, operation: () => Promise<T>): Promise<T> {
    let keys = operations.get(this.backend);
    if (keys === undefined) {
      keys = new Map();
      operations.set(this.backend, keys);
    }
    const pending = (keys.get(key) ?? Promise.resolve()).then(operation);
    const settled = pending.then(() => undefined, () => undefined);
    keys.set(key, settled);
    try {
      return await pending;
    } finally {
      if (keys.get(key) === settled) keys.delete(key);
    }
  }
}

/**
 * SecureStore keys are restricted to `[A-Za-z0-9._-]`, which the suffix
 * respects. Supabase's own storage key (`sb-<ref>-auth-token`) already does.
 */
function legacyChunkKey(key: string, index: number): string {
  return `${key}.${index}`;
}

function generationKey(key: string, bank: 0 | 1): string {
  return `${key}.v2.${bank}`;
}

function generationChunkKey(key: string, bank: 0 | 1, index: number): string {
  return `${generationKey(key, bank)}.${index}`;
}

function readCount(raw: string | null): number | null {
  if (raw === null || !/^[1-9]\d*$/.test(raw)) return null;
  const count = Number(raw);
  return count <= MAX_CHUNKS ? count : null;
}

/**
 * The player a stored value authenticates as.
 *
 * `undefined` for a value that is not a GoTrue session at all — a PKCE
 * verifier, or anything else stored here — which has no identity to split.
 * `null` for nothing stored, and for a session whose player cannot be read:
 * an unknown player never matches another one, so a failure involving it
 * refuses. Only `user.id` is read; no token is decoded or retained.
 */
export function storedPlayerOf(raw: string | null): string | null | undefined {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  if (!("access_token" in parsed) && !("refresh_token" in parsed)) return undefined;
  const user = (parsed as { user?: { id?: unknown } }).user;
  return typeof user?.id === "string" && user.id.length > 0 ? user.id : null;
}

function readGeneration(head: string | null): Generation | null {
  if (head === null || !head.startsWith(MANIFEST_PREFIX)) return null;
  const match = /^([01]):([1-9]\d*)$/.exec(head.slice(MANIFEST_PREFIX.length));
  const count = readCount(match?.[2] ?? null);
  return count === null ? null : { bank: match?.[1] === "0" ? 0 : 1, count };
}

/** A native mutation whose effect is judged afterwards by reading, not by its rejection. */
async function attempt(mutation: () => Promise<void>): Promise<void> {
  try {
    await mutation();
  } catch {
    // Judged by the read-back that follows.
  }
}

/**
 * In-memory fallback, used when the secure backend cannot be loaded at all —
 * web, or a misconfigured native build.
 *
 * It is deliberately NOT durable: the alternative would be silently downgrading
 * a refresh token into unprotected storage, which is exactly the thing this
 * module exists to prevent. An unlinked player can lose access after a restart;
 * the production factory exposes that lack of durability to the UI.
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

let nativeModule: Promise<SecureStoreLike | null> | null = null;

/** The platform keychain module, or null where it cannot be loaded. Shared. */
function loadSecureStore(): Promise<SecureStoreLike | null> {
  nativeModule ??= (async () => {
    try {
      return (await import("expo-secure-store")) as unknown as SecureStoreLike;
    } catch {
      return null;
    }
  })();
  return nativeModule;
}

/**
 * Keeps the refresh token off iCloud Keychain sync and unreadable while the
 * device is locked. Auto-refresh only runs in the foreground, so the stricter
 * accessibility class costs nothing.
 */
const keychainOptions = (module: SecureStoreLike): Record<string, unknown> => ({
  keychainAccessible: module.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
});

// Supabase's default session storage key has this exact suffix. PKCE verifier
// writes and removals must not clear, or stand in for, a session verdict.
const isSessionKey = (key: string): boolean => key.endsWith("-auth-token");

/**
 * The production adapter.
 *
 * `expo-secure-store` is imported on first use rather than at module scope, so
 * importing anything in this folder from a Node test process does not reach for
 * a native module that is not there.
 */
export function createSecureSessionStorage(): SupportedStorage {
  const fallback = new EphemeralSessionStorage();
  let resolved: SupportedStorage | null = null;

  const resolve = async (): Promise<SupportedStorage> => {
    if (resolved !== null) return resolved;

    const module = await loadSecureStore();
    if (module === null) reportSessionStorageDurability("unavailable");
    resolved =
      module === null
        ? fallback
        : new ChunkedSecureSessionStorage(
            module,
            keychainOptions(module),
            (key, status) => {
              if (isSessionKey(key)) reportSessionStorageDurability(status);
            },
            (key, outcome) => {
              if (isSessionKey(key)) reportSessionRemoval(outcome);
            },
          );
    return resolved;
  };

  return {
    getItem: async (key) => (await resolve()).getItem(key),
    setItem: async (key, value) => (await resolve()).setItem(key, value),
    removeItem: async (key) => {
      const storage = await resolve();
      await storage.removeItem(key);
      // A map entry, once deleted, is gone: nothing survives a relaunch here.
      if (storage === fallback && isSessionKey(key)) reportSessionRemoval("removed");
    },
  };
}

const PROBE_KEY = "arc21.session-probe";
let probes = 0;

/**
 * Whether this device can change a saved credential RIGHT NOW.
 *
 * Asked before an irreversible server step that the device must follow by
 * removing its credential — account deletion. Once the account is erased the
 * request cannot be refused any more, so a keychain that already refuses
 * changes must be found out before, not after: otherwise the erased player's
 * credential would stay restorable. A write that reads back is what the
 * removal's tombstone step needs. The probe item holds no credential; it is
 * removed afterwards on a best-effort basis and overwritten by the next probe.
 */
export async function sessionStorageAcceptsChanges(): Promise<boolean> {
  const module = await loadSecureStore();
  // The in-memory fallback keeps nothing across a relaunch.
  if (module === null) return true;
  const options = keychainOptions(module);
  probes += 1;
  const marker = `probe.${probes}.${Date.now()}`;
  try {
    await module.setItemAsync(PROBE_KEY, marker, options);
    return (await module.getItemAsync(PROBE_KEY, options)) === marker;
  } catch {
    return false;
  } finally {
    await attempt(() => module.deleteItemAsync(PROBE_KEY, options));
  }
}
