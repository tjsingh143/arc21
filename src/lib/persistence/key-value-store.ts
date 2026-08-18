/**
 * A minimal durable key/value store.
 *
 * The interface exists so persistence logic can be unit-tested without a device:
 * the SQLite implementation is the production path, the in-memory one is used by
 * tests. Nothing above this layer knows which it is talking to.
 */

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Test/fallback implementation. Not durable. */
export class MemoryKeyValueStore implements KeyValueStore {
  private readonly entries = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.entries.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

/**
 * Expo SQLite implementation.
 *
 * SQLite rather than plain async storage because Practice state is the local
 * source of truth for a session in progress: a torn write would lose a hand the
 * player is mid-way through, and SQLite gives atomic writes for free.
 *
 * The module is imported lazily so this file stays importable in a plain Node
 * test process, where `expo-sqlite` has no native backing.
 */
export class SqliteKeyValueStore implements KeyValueStore {
  private ready: Promise<SqliteDatabase> | null = null;

  constructor(private readonly databaseName = "arc21.db") {}

  private async database(): Promise<SqliteDatabase> {
    this.ready ??= (async () => {
      const SQLite = (await import("expo-sqlite")) as unknown as SqliteModule;
      const db = await SQLite.openDatabaseAsync(this.databaseName);
      await db.execAsync(
        "create table if not exists kv (key text primary key not null, value text not null);",
      );
      return db;
    })();
    return this.ready;
  }

  async get(key: string): Promise<string | null> {
    const db = await this.database();
    const row = await db.getFirstAsync<{ value: string }>(
      "select value from kv where key = ?;",
      [key],
    );
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    const db = await this.database();
    await db.runAsync(
      "insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value;",
      [key, value],
    );
  }

  async remove(key: string): Promise<void> {
    const db = await this.database();
    await db.runAsync("delete from kv where key = ?;", [key]);
  }
}

// Structural types for the lazily imported module, so this file needs no
// build-time dependency on expo-sqlite's typings.
interface SqliteDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: unknown[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, params: unknown[]): Promise<T | null>;
}

interface SqliteModule {
  openDatabaseAsync(name: string): Promise<SqliteDatabase>;
}
