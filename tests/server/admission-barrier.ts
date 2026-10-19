/**
 * Deterministic interleavings for seat ADMISSION, against the local database.
 *
 * Two controls, both held by a separate `psql` connection inside an open
 * transaction, both released by committing it:
 *
 *   - `holdPlayerAdmissions(player)` holds the player's `profiles` row
 *     `for update`. Every admission path reads the profile without a lock and
 *     then inserts a row whose foreign key to that profile needs
 *     `for key share` — a `game_sessions.host_user_id` for a mode the player
 *     opens, a `game_session_seats.user_id` for a private table somebody else
 *     deals them into. So each request parks at its FIRST such insert, after
 *     whatever it checked. This is the barrier the C-1 suite in
 *     `ai-table.integration.test.ts` introduced; it lives here so the private
 *     admission suite can use it without reaching into that file.
 *
 *   - `holdTournamentEntries()` takes `public.tournament_entries` in ACCESS
 *     EXCLUSIVE mode, which parks any statement that reads the table, and then
 *     lets the caller commit a write of its own while the parked statement
 *     waits. That is how a test makes another transaction's commit land
 *     BETWEEN two statements of an admission check.
 *
 * `parked()` counts backends waiting on the holder directly OR on a backend that
 * is itself waiting on it, so a request queued behind another request's
 * admission lock counts too.
 */

import { execFileSync, spawn } from "node:child_process";

/** Fixture SQL against the local container. THROWS when it cannot run. */
export function sql(statement: string): string {
  return execFileSync(
    "docker",
    ["exec", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-tAc", statement],
    { encoding: "utf8" },
  ).trim();
}

export async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export interface Barrier {
  parked(): number;
  /** Runs `statements` inside the holder's transaction, then commits it. */
  release(statements?: string): Promise<void>;
}

async function holdWith(lockStatement: string, heldMarker: RegExp): Promise<Barrier> {
  const psql = spawn("docker", [
    "exec", "-i", "supabase_db_arc21", "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-tA", "-v", "ON_ERROR_STOP=1",
  ]);
  let out = "";
  let err = "";
  psql.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  psql.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
  psql.stdin.write(`begin;\nselect 'pid=' || pg_backend_pid();\n${lockStatement}\n`);
  for (let tries = 0; tries < 100 && !heldMarker.test(out); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const holder = /pid=(\d+)/.exec(out)?.[1];
  if (!holder || !heldMarker.test(out)) throw new Error(`could not hold the barrier: ${out} ${err}`);
  let released: Promise<void> | null = null;
  return {
    parked: () =>
      Number(
        sql(
          `with first as (select pid from pg_stat_activity where ${holder} = any(pg_blocking_pids(pid)))
           select (select count(*) from first)
                + (select count(*) from pg_stat_activity a
                   where exists (select 1 from first f where f.pid = any(pg_blocking_pids(a.pid))))`,
        ),
      ),
    release: (statements = "") =>
      (released ??= new Promise<void>((resolve, reject) => {
        psql.on("close", (code) => {
          // A failed fixture write must fail the test, not pass it silently.
          if (code === 0) resolve();
          else reject(new Error(`barrier transaction failed (${code}): ${err}`));
        });
        psql.stdin.end(`${statements}\ncommit;\n`);
      })),
  };
}

export function holdPlayerAdmissions(playerId: string): Promise<Barrier> {
  return holdWith(
    `select 'held=' || count(*) from (select 1 from public.profiles where id = '${playerId}'::uuid for update) held;`,
    /held=1/,
  );
}

/**
 * Holds the player's own `seat_admission` advisory lock, exactly as an
 * admission in flight would. Used to make two multi-player admissions queue on
 * one member in a known order.
 */
export function holdAdmissionLock(playerId: string): Promise<Barrier> {
  return holdWith(
    `select pg_advisory_xact_lock(hashtext('seat_admission:' || '${playerId}'));\nselect 'held=admission';`,
    /held=admission/,
  );
}

export function holdTournamentEntries(): Promise<Barrier> {
  return holdWith(
    `lock table public.tournament_entries in access exclusive mode;\nselect 'held=entries';`,
    /held=entries/,
  );
}
