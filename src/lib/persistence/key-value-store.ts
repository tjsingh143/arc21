/**
 * A minimal durable key/value store.
 *
 * The interface exists so persistence logic can be unit-tested without a device:
 * the SQLite implementation is the production path, the in-memory one is used by
 * tests. Nothing above this layer knows which it is talking to.
 */

import { openSqliteDatabase, type SqliteDatabase } from "./open-sqlite.js";

// Settings, guest identity and onboarding hydrate through separate store
// instances at startup. Share their database initialization before native work
// begins: Expo dispatches opens concurrently and lazily creates its filesystem
// manager. Serializing opens also covers callers using different database names.
const databases = new Map<string, Promise<SqliteDatabase>>();
let openingDatabase: Promise<void> = Promise.resolve();

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
  constructor(private readonly databaseName = "arc21.db") {}

  private async database(): Promise<SqliteDatabase> {
    const existing = databases.get(this.databaseName);
    if (existing) return existing;

    const ready = openingDatabase.then(async () => {
      const db = await openSqliteDatabase(this.databaseName);
      await db.execAsync(
        "create table if not exists kv (key text primary key not null, value text not null);",
      );
      return db;
    });
    databases.set(this.databaseName, ready);
    openingDatabase = ready.then(() => undefined, () => {
      // A transient initialization failure must not poison every later read.
      if (databases.get(this.databaseName) === ready) databases.delete(this.databaseName);
    });
    return ready;
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
