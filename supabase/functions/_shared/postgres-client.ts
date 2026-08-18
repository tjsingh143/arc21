/**
 * Arc 21 — the typed Postgres client.
 *
 * WHY A DIRECT CONNECTION AND NOT PostgREST / supabase-js
 *
 * Two independent reasons, both from DATABASE.md:
 *
 *   1. `SELECT … FOR UPDATE` must be held across several statements. PostgREST
 *      hands out a connection per request, so a lock taken in one call is gone
 *      by the next — the command transaction described in ARCHITECTURE.md is
 *      simply not expressible through it.
 *   2. The authoritative engine state lives in the `private` schema, which no
 *      API role can reach. Not `anon`, not `authenticated`, and deliberately not
 *      `service_role` either, so that a leaked service key still cannot read the
 *      shoe. The connection here authenticates as `postgres`.
 *
 * The connection string comes from the Function runtime's `SUPABASE_DB_URL` and
 * never appears in a response or a log.
 */

import postgres from "postgres";
import { databaseUrl } from "./env.ts";

export type Sql = postgres.Sql<Record<string, never>>;
export type Tx = postgres.TransactionSql<Record<string, never>>;

let pool: Sql | null = null;

export function db(): Sql {
  if (pool) return pool;
  pool = postgres(databaseUrl(), {
    // An Edge Function invocation handles one command. A small pool is enough
    // and keeps a burst of cold starts from exhausting Postgres connections.
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
    // Safe with a transaction-mode pooler in front, which production may have.
    prepare: false,
    // NOTICE output can quote row values; it is not wanted anywhere near a log.
    onnotice: () => {},
    connection: { application_name: "arc21-edge" },
  });
  return pool;
}

/**
 * Thrown to unwind a transaction on purpose. `postgres.js` rolls back on any
 * throw, so this carries the value the caller wants back after the rollback.
 */
export class RollbackSignal<T> extends Error {
  readonly value: T;
  constructor(value: T) {
    super("transaction rolled back deliberately");
    this.name = "RollbackSignal";
    this.value = value;
  }
}

/**
 * Runs `body` inside one transaction. Everything the command touches — engine
 * state, session row, seat row, event log, idempotency record and the wallet —
 * commits together or not at all. There is no partial settlement.
 */
export async function withTransaction<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  return (await db().begin((tx) => body(tx as Tx))) as T;
}

// ---------------------------------------------------------------------------
// Numeric coercion
//
// `bigint` columns arrive as strings from the driver so a value beyond
// `Number.MAX_SAFE_INTEGER` cannot be silently rounded. Chips and versions are
// small, but "small" is an assumption, and an assumption about money is a
// defect waiting to happen — so every read is converted through one checked
// function rather than an implicit `+value`.
// ---------------------------------------------------------------------------

export function toInteger(value: unknown, field: string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${field} is not a safe integer`);
    }
    return value;
  }
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`${field} exceeds the safe integer range`);
    }
    return Number(value);
  }
  if (typeof value === "string") {
    if (!/^-?\d+$/.test(value)) {
      throw new Error(`${field} is not an integer`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`${field} exceeds the safe integer range`);
    }
    return parsed;
  }
  throw new Error(`${field} is not a number`);
}

/** Serialises a value for a `jsonb` parameter. Always paired with `::jsonb`. */
export function asJsonb(value: unknown): string {
  return JSON.stringify(value);
}
