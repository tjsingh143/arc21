/**
 * Empty the public-table pool, so a two-client scenario meets a real queue.
 *
 * WHY THIS EXISTS. Allocation is GLOBAL and a public table keeps taking players
 * while it has room — the phase 7 fix that made public tables public. So a room
 * left behind by `npm run test:server`, or by an earlier run of this scenario,
 * is a table the device account is CORRECTLY matched into. The first run of
 * `two-client-public-queue.yaml` after a server suite was answered
 * "Seat found — 4 already seated", which is the product working exactly as
 * specified and makes the two-device scenario impossible to stage: device A
 * takes the fifth seat of a stranger's table, the room is then full, and device
 * B is allocated a brand new one. Two clients, two tables, nothing proved.
 *
 * `public-matchmaking.yaml` states the same premise and answers it with
 * `supabase db reset`. That works and costs both accounts, both keychain
 * sessions and two sign-in flows. This is the narrower version of the same
 * step, and it is the move `tests/server/sprint-table.ts` already makes for the
 * tournament pool: drain first, deliberately, rather than retry and hope.
 *
 * LOCAL HARNESS ONLY. It reaches the database directly through the running
 * container, because `20260904120000_least_privilege_and_entry_visibility.sql`
 * revoked `service_role`'s access to `public` — correctly, and this is not a
 * product path that should have a way in.
 *
 *   npx tsx scripts/e2e-public-drain.ts
 *
 * Prints what it closed. Throws if the container is not there, rather than
 * reporting a clean pool it never looked at — the empty-fixture mistake in the
 * shape a helper takes.
 */

import { execFileSync } from "node:child_process";

const CONTAINER = "supabase_db_arc21";

function psql(statement: string): string {
  try {
    return execFileSync(
      "docker",
      ["exec", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", statement],
      { encoding: "utf8" },
    ).trim();
  } catch (error: unknown) {
    throw new Error(
      `could not reach ${CONTAINER} — is the stack up? ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function main(): void {
  const before = psql(
    `select count(*) from public.rooms
     where visibility = 'public' and mode = 'public_table' and status in ('lobby', 'active')`,
  );

  /*
   * The candidate set is exactly `poll_matchmaking`'s: a public table of this
   * mode whose room is `lobby` or `active`. Closing the room is enough — the
   * allocation joins to the session and skips a room whose session is gone, but
   * a `lobby` room with no session at all is still a candidate on its own.
   */
  const closed = psql(
    `with drained as (
       update public.rooms
       set status = 'closed'
       where visibility = 'public' and mode = 'public_table' and status in ('lobby', 'active')
       returning id
     )
     select count(*) from drained`,
  );

  /*
   * And the queue itself. An entry already `matched` to one of those rooms
   * would otherwise be reported back verbatim — `poll_matchmaking` returns a
   * matched entry without re-allocating, on purpose, so that a seated player is
   * never moved. Expiring the leftovers is what makes the next poll allocate.
   */
  const queue = psql(
    `with drained as (
       update public.matchmaking_queue
       set status = 'expired'
       where status in ('waiting', 'matched')
       returning id
     )
     select count(*) from drained`,
  );

  const after = psql(
    `select count(*) from public.rooms
     where visibility = 'public' and mode = 'public_table' and status in ('lobby', 'active')`,
  );

  process.stdout.write(
    `public rooms open before: ${before}, closed: ${closed}, queue entries expired: ${queue}, open after: ${after}\n`,
  );

  if (after !== "0") {
    throw new Error(`${after} public rooms are still open — the pool was not drained`);
  }
}

main();
