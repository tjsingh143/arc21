/** The native boundary; kept lazy so stores remain importable in plain Node. */
export async function openSqliteDatabase(name: string): Promise<SqliteDatabase> {
  const SQLite = await import("expo-sqlite");
  return SQLite.openDatabaseAsync(name) as Promise<SqliteDatabase>;
}

export interface SqliteDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: unknown[]): Promise<unknown>;
  getFirstAsync<T>(sql: string, params: unknown[]): Promise<T | null>;
}
