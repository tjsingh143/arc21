# Arc 21 — Database

Postgres 17 on Supabase. Migrations, seed data and pgTAP tests live in
`supabase/`. This document describes what is there and how to run it.

The threat model is the one in [SECURITY.md](./SECURITY.md): an adversarial
modified client with full control of the app binary, its storage and its
network traffic. Every design decision below follows from that.

---

## Running it locally

Docker must be running. Node lives in `/opt/homebrew/bin`.

```bash
export PATH="/opt/homebrew/bin:$PATH"
cd /Users/tj/arc21

supabase start          # first run pulls images; slow
supabase db reset       # drop, re-apply every migration, then seed.sql
supabase test db        # pgTAP suite
supabase stop           # when you are done
```

`supabase db reset` is the only supported way to apply a schema change during
development. Migrations are never edited after they have been applied to a
deployed environment; local iteration edits freely and resets.

| Service | URL |
|---------|-----|
| API | `http://127.0.0.1:54321` |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| Studio | `http://127.0.0.1:54323` |
| Mail catcher | `http://127.0.0.1:54324` |

pgTAP is created inside each test's transaction and rolled back with it, so the
extension is never installed into a deployed database.

---

## The private schema boundary

This is the single most important thing in the schema.

`private.game_state_private` holds the serialised `BlackjackGameState`: the
undealt shoe **in order** and the dealer's hole card before reveal. One readable
row of it lets a modified client win every remaining hand of that shoe. It is
the database half of the guarantee that `toPublicState` makes in the engine.

```
game_state_private
  game_session_id  uuid  primary key -> public.game_sessions(id)
  engine_state     jsonb            -- shoe order, nextIndex, hole card
  version          bigint           -- equals game_sessions.version
  updated_at       timestamptz
```

Four independent barriers stand in front of it:

| # | Barrier | Where |
|---|---------|-------|
| 1 | The `private` schema is not in `[api] schemas`, so PostgREST will not route to it | `supabase/config.toml` |
| 2 | No API role holds `USAGE` on the schema — not `anon`, not `authenticated`, not `service_role` | `20260813120000_foundation.sql` |
| 3 | No API role holds any privilege on the table | `20260813120500_games.sql` |
| 4 | RLS is enabled with **zero** policies, so no row can match | `20260813120500_games.sql` |

Barriers 2–4 are re-asserted at migration time in
`20260813121200_hardening.sql`, so a deploy fails rather than silently opening
the boundary. `supabase/tests/01_private_state.test.sql` tests each barrier
separately, and does so **as a seated participant of the session** — the most
privileged position a client can occupy.

`service_role` is deliberately excluded as well. The intended server path is a
direct Postgres connection as `postgres` — which is what the command
transaction in ARCHITECTURE.md needs anyway, since `SELECT … FOR UPDATE` held
across several statements does not survive PostgREST's connection model — or a
`SECURITY DEFINER` function in `public` owned by `postgres`.

**No such accessor function exists yet**; it belongs to the command API in the
next phase, and inventing its versioning contract early would only have to be
redone. When that work happens, add a definer function. Do **not** reach for
`grant usage on schema private to service_role` instead: that removes barrier 2
and re-exposes the shoe to anything holding the service key, including a leaked
one.

Confirmed end-to-end against the running API:

```
GET /rest/v1/game_state_private   (Accept-Profile: private)
→ 406  PGRST106  "Invalid schema: private.
   Only the following schemas are exposed: public, graphql_public"
```

### The other secret: daily challenge seeds

Every player faces the identical shoe in a daily challenge, produced by
`CounterStreamRandomSource` from `daily_challenges.seed_secret`. That makes the
seed exactly as dangerous as the shoe.

It stays on `daily_challenges` but is removed from the client's **column**
privileges: `authenticated` holds a column-level `SELECT` listing every column
except `seed_secret`. `select seed_secret` is refused, and so is `select *`.
Clients read `public.daily_challenges_public`, a `security_invoker` view that
does not carry the column at all.

`seed_commitment` — the SHA-256 of the secret — is published from the moment the
challenge opens, and a trigger proves it genuinely hashes to the stored secret.
A commitment nobody verifies is theatre, so the check is in the database rather
than in a runbook. `revealed_seed` may only be written once `closes_at` has
passed.

**And until phase 9 nothing ever wrote it.** The column, the trigger, the
projection, the client parser and the render branch all existed, and no code path
in the product published a seed — so the commitment could not be checked by
anybody, while the Daily screen told the player it could. A commitment nobody CAN
verify is worse than one nobody does. `reveal_closed_daily_seeds()` publishes
every challenge whose window has closed and is called by
`ensure_todays_daily_challenge()` as its first act — on demand rather than on a
schedule, for the same reason the challenge row itself is created that way.
`latest_verifiable_daily_challenge()` returns the seed, the commitment and **no
verdict**: the device recomputes SHA-256 itself, because a server that also
answered "yes, it matches" would be asking to be believed twice.

The shoe is deterministic at every shuffle, not only the first.
`dailyShoeSource(seed, shuffleNumber)` keys the stream on the shuffle number, so
an attempt that passes the cut card is dealt a second shoe every other entrant is
also dealt. Before phase 9 that reshuffle came from the CSPRNG.

---

## Authorization model

Three layers, applied to every table. They are independent on purpose: any one
of them failing alone still leaves the data protected.

| Layer | Mechanism | Answers |
|-------|-----------|---------|
| Privilege | `GRANT` / `REVOKE`, column-level where it matters | *Does this verb exist for this role?* |
| Policy | Row Level Security | *Which rows may this user touch?* |
| Trigger | Guard functions | *Is this specific change legitimate at all?* |

Default privileges for `anon` and `authenticated` are revoked in the first
migration, so a table is unreachable until it is deliberately granted. Every
table then revokes and re-grants explicitly, so the intent is readable in the
file rather than inherited from a global setting.

`supabase/tests/02_wallets.test.sql` and `03_profiles.test.sql` test the layers
one at a time: they hand the missing `GRANT` to `authenticated` mid-transaction,
prove RLS still holds, then add a permissive policy too and prove the trigger
still holds.

### What a client may write

That list is short, and the hardening migration fails the deploy if it grows
without being updated:

| Table | Verbs | Notes |
|-------|-------|-------|
| `profiles` | `UPDATE` | Only `username`, `display_name`, `bio`, `avatar_url`, `country_code`, `privacy` |
| `friend_requests` | `INSERT`, `UPDATE` | `UPDATE` restricted to `status` |
| `friendships` | `DELETE` | Unfriending. Creation is server-side |
| `blocks` | `INSERT`, `DELETE` | |
| `loadouts` | `INSERT`, `UPDATE` | Slots validated against ownership and kind |
| `push_tokens` | `INSERT`, `UPDATE`, `DELETE` | Own device registration |
| `notifications` | `UPDATE`, `DELETE` | `UPDATE` restricted to `read_at` |

Everything else is read-only to a client, or invisible to it.

### Progression and money

`profiles.level` and `profiles.xp` decide table access and cosmetic unlocks, so
they are the obvious target. `authenticated` has no `UPDATE` privilege on those
two columns, and `guard_profile_server_columns()` refuses the change even if
that privilege is granted by mistake later.

`wallets` and `wallet_ledger` have **no** client write path at all — `SELECT`
and nothing else, no `INSERT`/`UPDATE`/`DELETE` policy, and a guard trigger
underneath. Chips move only through `public.apply_wallet_delta()`, which is
`SECURITY DEFINER`, executable by `service_role` only, and:

- locks the wallet row `FOR UPDATE`
- returns the first committed result when the idempotency key is already present
- lets `balance >= 0` and `balance_after >= 0` — real `CHECK` constraints —
  reject an overdraft rather than trusting a comparison in application code

The ledger is append-only. `UPDATE` is rejected for **every** role including the
server: a correction is a new row, never an edit to history.

---

## Tables

### Identity and progression

| Table | Purpose |
|-------|---------|
| `profiles` | Public identity. `level` / `xp` are server-owned |
| `player_stats` | Lifetime statistics. Private to the owner, server-written |
| `player_mode_stats` | Statistics bucketed by mode and `ruleset_key`, because decision accuracy is only comparable within one ruleset version |

### Economy

| Table | Purpose |
|-------|---------|
| `wallets` | Global chip balance. `balance >= 0` is a constraint |
| `wallet_ledger` | Append-only history. Unique `idempotency_key` per entry |

### Social

| Table | Purpose |
|-------|---------|
| `friend_requests` | Readable by sender and receiver only |
| `friendships` | Undirected edge stored once with `user_id_a < user_id_b`. Created by a trigger when a request is accepted, never written directly |
| `blocks` | Directed. Readable only by the blocker — a blocked user is never told. Blocking severs the friendship and cancels anything pending |

### Game

| Table | Purpose |
|-------|---------|
| `rulesets` | Persisted `BlackjackRules` values. `CHECK` constraints keep `key`/`version` from drifting from the JSON payload |
| `game_sessions` | One table/room. Sanitised metadata; `escrow_chips` blocks deletion while chips are unreconciled |
| `game_session_seats` | Seat occupancy and table stack. The membership source every game-scoped policy consults |
| `game_events` | Append-only sanitised event stream with a monotonic `seq`. `visibility` is `public` or `seat`; a seat-scoped row reaches only its recipient |
| `hand_records` | **V1.1, unwritten.** Completed-hand archive. Dealer cards may only be stored once `completed_at` is set |
| `hand_players` | **V1.1, unwritten.** One settled player hand. `net = credit - wager` is a constraint |
| `player_actions` | **V1.1, unwritten.** Per-decision log with optional strategy grading. Readable only by the player who made the decision |
| `private.game_state_private` | See above |

`game_session_seats` is not in the original table list but is required: RLS needs
a membership table that exists from the moment a room is created, before any
hand has been dealt.

`hand_records.dealer_cards` deserves its own note. A hand-history table is
exactly the sort of place a hole card leaks from — an "archive" row written at
deal time would publish the dealer's down card to every participant before the
peek. The constraint makes that shape unstorable rather than merely discouraged.

**Those three tables are empty, and that is the specification's instruction.**
"hand history/replay" is listed under **V1.1 — DO NOT LET THESE DELAY MVP**, so
the schema is architected for it and nothing writes a row. The tables, their
CHECK constraints, their indexes, their RLS policies and their
`deny_client_write` triggers all exist and are asserted; the archive does not.
Until this note existed, the migration header said "Written by the server at
settlement" and this table said "Completed-hand archive" — both describing a
feature that records nothing, which is the same class of untruth as a screen
claiming a shipped feature is missing.

`tests/server/rls-idor.integration.test.ts` asserts they are EMPTY rather than
skipping them: zero rows after a full hand at a Quick Play table is the evidence
that this is a decision. The day one gains a row, that test fails and the
participant-visibility assertions have to be written before the suite is green.

### Career, competition, cosmetics

| Table | Purpose |
|-------|---------|
| `career_nodes` | Public catalogue. 18 nodes, each gated on the previous one |
| `career_progress` | Per-user, readable by its owner, entirely server-written. `reward_ledger_id` ties a claimed reward to the row that paid it |
| `tournaments` / `tournament_entries` / `tournament_matches` | Public brackets and standings, server-written. A winner must be one of the two entries in the slot |
| `daily_challenges` / `daily_entries` | See the seed discussion above |

**Sprint tournament state** (added 20260817200000). `tournaments` carries
`initial_button` (drawn by the server's CSPRNG so no seat holds a standing
positional advantage), `tie_break_hands_used`, `tie_break_boundary` (which
boundary a sudden-death hand is resolving, or NULL) and
`scheduled_hands_played`. That last one is deliberately **not** the engine's hand
number: a tie-break hand is an extra hand at its boundary, so counting it among
the twelve would shorten the tournament and move the hand-9 bet ceiling early.
`tournament_entries` gains `eliminated_after_hand` (placement ordering is measured
in hands, and two players can go out in the same second), `in_tie_break`,
`prize_chips` and `prize_xp`.

**Reading a tournament.** `sprint_standings(p_tournament_id)` and
`my_sprint_entry()` are caller-scoped like the social predicates: they take the
tournament, never a user id, and derive the viewer from `auth.uid()`, so neither
can be turned into an oracle for whether some other account is entered in
something. `sprint_standings` exists rather than a client-side join because
standings need display names, and reaching `profiles` through the entries policy
would hide a competitor whose profile privacy is `private` — leaving a live
tournament with a nameless seat. `sprint_format()` is granted to `anon` too: it
reads no table, takes no arguments, and returns published configuration that a
signed-out player must be able to read before deciding to spend an entry fee.

**Today's daily challenge** is created on demand rather than by a scheduler,
because a cron job that has not run is an outage while a row created by the first
person to open the screen cannot be late. The pair is deliberate:
`ensure_daily_challenge_for(date)` does the work and is granted to **no** API role
(the session Edge Function reaches it as `postgres`), while
`ensure_todays_daily_challenge()` is the checked wrapper clients call and reads its
result back through `daily_challenges_public`, so it cannot return the seed even by
accident. Both take the UTC date from the server: a client that could name a date
could shop for a shoe whose cards it had already seen.

**One-off XP** goes through `award_milestone_xp(user_id, xp)`, which is uncapped
and does not touch `player_daily_xp`. That cap exists to stop repeatable grinding;
a tournament placement costs a 500-chip entry and needs a full field, and a daily
reward is available once per date, so running either through the repeatable cap
would let an evening of ordinary hands swallow a prize a player had earned.
| `cosmetics` | Public catalogue. No `price` column, and no unlock type that could express a purchase or a random draw |
| `user_cosmetics` | Server-granted ownership |
| `loadouts` | Equipped set. Client-writable, but a trigger validates every slot against ownership and kind |

### Notifications

| Table | Purpose |
|-------|---------|
| `push_tokens` | Per-device registration, self-managed. `allowed_kinds` is the device's own list of what it wants pushed — device-scoped rather than account-scoped, because a phone and a tablet reasonably want different things |
| `notifications` | Server-written. A client may change `read_at` and nothing else |

**`public.notify_user` is the only writer, and it is revoked from `anon` and
`authenticated`.** Everything that causes a notification calls it from inside its
own transaction — a tournament that fails to commit tells nobody it is starting.
A client cannot post itself a tournament win, and cannot forge one from another
player, because there is no grant under which the function executes.

**`notifications.data` carries deep-link parameters and nothing else**, enforced
by a CHECK against `notification_data_is_safe`: an allowlist of keys, each
holding a string or number no longer than 64 characters. An array fails, a nested
object fails, and an unlisted key fails — so a daily-challenge seed, a shoe order
or a hole card cannot travel in a push payload even by accident. The 1100
migration said this in a comment for five phases; a comment is not a constraint.

**Delivery is recorded honestly.** `notification_delivery` has a `mocked` member
distinct from `sent`, and `sent_at` is stamped only when a push was really
accepted by the push service. Without APNs/FCM credentials the sender runs its
mock transport and every row says `mocked` — so "how many pushes have we actually
sent" stays an answerable question, and a development run cannot be mistaken for
evidence that push works.

`dedupe_key` collapses repeats per player: inviting the same friend to the same
table twice is one notification, and a reconnect loop cannot flood a device.

| Function | Caller | Purpose |
|----------|--------|---------|
| `notify_user` | Server only | The single writer |
| `register_push_token` / `retire_push_token` | The player | This device, and the kinds it wants |
| `my_notifications` / `unread_notification_count` / `mark_notifications_read` | The player | Their own inbox |
| `invite_friend_to_room` | The player | Checked four ways server-side: you are at the table, they are a confirmed friend, neither has blocked the other, and a repeat is one notification |
| `pending_push_deliveries` / `pending_without_device` / `record_push_delivery` / `deactivate_push_token` | Server only | The sender's view. Reads other people's titles by design, so no client role may execute any of them |

---

## Conventions

- UUID primary keys throughout; `timestamptz` for every time column. Both are
  asserted in `00_schema.test.sql`.
- Chips are `bigint`. There is no `real` or `double precision` column anywhere
  in `public`, and that too is asserted rather than assumed.
- Enum labels that mirror the engine (`hand_outcome_kind`, `player_hand_status`,
  `player_action_type`, `insurance_decision`) use the engine's exact spelling, so
  a row round-trips into a TypeScript union with no translation layer to drift.
- Free text is length-limited at the column. Usernames are
  `^[a-z0-9_]{3,20}$`; room codes are `^[A-HJ-NP-Z2-9]{6}$` — no `O`/`0`, no
  `I`/`1`.
- `cosmetic_unlock_type` has no `purchase` and no `random` member. Making the
  thing unrepresentable is stronger than a note in a document.

---

## Seed data

`supabase/seed.sql` is catalogue data only — no users, no wallets, no secrets.

- The **Arc Standard** ruleset (`arc-standard@1`), verbatim from
  `ARC_STANDARD_RULES` in `shared/blackjack/rules.ts`
- **18 career nodes**: `FOUNDATIONS`, `THE_WORKSHOP`, `SKYLINE`, six each, each
  gated on the previous one, with chapter finales awarding a card back
- **24 cosmetics**: 12 avatars, 8 card backs, 4 table themes, every one earned by
  a level, a career node, a chapter, a daily streak or a tournament placement

Daily challenges are deliberately **not** seeded: a row requires a real
`seed_secret`, and a secret in a version-controlled file is not a secret. The
pgTAP suite mints its own throwaway row.

`06_catalog.test.sql` asserts the seeded ruleset against the values in
BLACKJACK_RULES.md field by field, so editing one without the other fails the
suite.

---

## Reversibility and recovery

The specification asks that migrations be "reversible where reasonable or include
documented recovery". This is the position for every one of them, so that a bad
deploy is answered by reading rather than by improvising. The count was
forty-four when this section was written and is **fifty-three** now; the nine
added since are all additive DDL or `create or replace` of a function body, and
fall under the "additive" heading below without changing what it says. The three
phase 9 added are `20260903120000_leaderboard_pagination.sql` (which DROPS the
one-argument board arities — recovery is to recreate them from
`20260817300000` and `20260818110000`, and nothing else references them),
`20260903130000_daily_seed_reveal.sql` and
`20260903140000_server_owned_write_guards.sql` (five triggers; dropping them
restores the prior shape and loses nothing).

**There is no down-migration framework, and adding one would be worse than not
having it.** A `down.sql` that nobody runs is a file that describes a rollback
somebody believes in; the recovery below is what would actually be done.

### The shape of the history

| Class | Count | Reversal |
|---|---|---|
| Additive DDL — new tables, columns, indexes, policies, functions, triggers | 29 | `drop` the objects it created. Losing whatever those objects hold |
| `alter type … add value` | 1 | **Not reversible.** Postgres has no `drop value` |
| Backfills that TRANSFORMED existing rows | 2 | Not reversible. Both are re-derivable, which is the recovery |

### The three that are not a plain `drop`

**`20260815190000_starting_wallet_and_recovery_reason.sql`** adds
`recovery_grant` to the `ledger_reason` enum. Postgres cannot remove an enum
value, and removing one would mean rewriting every column of that type.

*Recovery:* none is needed. An unused label costs nothing and breaks nothing. The
failure that WOULD matter is the reverse — a future migration recreating the type
without a label that ledger rows still use — and
`supabase/tests/22_migration_recovery.test.sql` asserts every reason the server
writes is still present, and that no ledger row refers to a label the type has
lost.

**`20260817320000_derive_level_from_xp.sql`** backfills `profiles.level` from
`xp`. The prior values are gone, and they were all `1` — the column had been
stored since the first migration and never written by anything.

*Recovery:* re-derive. The backfill is the same statement the trigger runs, so
running it again is safe and idempotent:

```sql
update public.profiles set level = public.level_from_total_xp(xp)
where level <> public.level_from_total_xp(xp);
```

`22_migration_recovery.test.sql` asserts that no row currently disagrees, which
is what makes that statement a recovery rather than a hope.

**`20260818100000_rate_limits.sql`** seeds `rate_limit_events` from
`profiles.username_changed_at`, so that moving rename enforcement from the column
to the table did not hand every recently-renamed player a free second rename.

*Recovery:* re-derive, from a column that is still there and is still stamped on
every rename. Rolling the whole migration back is `drop table rate_limit_events,
rate_limit_policies cascade` plus restoring the five function bodies it replaced;
the events lost are one window of rate-limit history, which by construction stops
mattering after `window_length`.

### What the additive twenty-nine actually mean by "reversible"

Dropping a table drops its rows. So "reversible" here means the SCHEMA returns to
its prior shape, not that the data comes back. In practice that distinction only
bites on three of them, and it is worth naming which:

- `20260813120200_wallets.sql` — dropping `wallet_ledger` destroys the only
  record from which balances can be rebuilt. Every other table in this schema is
  derivable or replaceable; this one is the record of account.
- `20260813120500_games.sql` and `private.game_state_private` — dropping either
  ends every table in progress. There is no partial recovery for a session whose
  engine state is gone; the closed-economy modes lose nothing, and a
  wallet-backed table's escrow would need reconciling from `game_sessions.escrow_chips`
  against the ledger.
- `20260813120900_daily.sql` — dropping `daily_entries` loses a day's ranked
  attempts, and they cannot be replayed: one ranked attempt per UTC date is
  enforced by never writing a second row, so re-playing would produce nothing.

### The forward guarantee, which is the one that is actually tested

`supabase db reset` applies all fifty-three from an empty database on every run of
the test suite, and `20260818120000_authorization_gate.sql` fails the migration
if the authorization surface is wrong when it finishes. A migration that cannot
apply cleanly from scratch is caught before it is ever deployed, which is the
half of this that gets exercised daily.

---

## Tests

```
supabase/tests/
  00_schema.test.sql             structural invariants, RLS coverage
  01_private_state.test.sql      the private engine state, barrier by barrier
  02_wallets.test.sql            no client write path, layer by layer
  03_profiles.test.sql           level and xp are not client-writable
  04_privacy.test.sql            cross-user isolation
  05_daily_challenge.test.sql    seed secrecy and commitment verification
                                 (fixtures sit on dates a live challenge cannot
                                 occupy: an earlier version used today's date and
                                 collided the moment the mode became playable)
  06_catalog.test.sql            seeded ruleset, career map, cosmetics
  07_game_access.test.sql        visibility follows the seat, not the room code
  08_account_bootstrap.test.sql  profile, stats, wallet and opening grant
  09_ledger_apply_order.test.sql the ledger replays to the balance, under races
  10_recovery_grant.test.sql     the broke-player top-up and its cooldown
  11_delete_account.test.sql     erasure, and what survives it
  12_settlement_record.test.sql  statistics and the daily XP cap
  13_friends.test.sql            the friend graph, blocks and their wording
  14_rooms.test.sql              private rooms, codes and expiry
  15_matchmaking.test.sql        queueing and per-tier allocation
  16_sprint_and_daily.test.sql   tournament shape and the deterministic shoe
  17_leaderboards_and_cosmetics  board projections, decisions, unlocks
  18_notifications.test.sql      the notification writer, payload allowlist and
                                 delivery record
  19_rate_limits.test.sql        every window is a policy row, and refusals are
                                 not themselves recorded
  20_authorization_surface.test  the whole client authorization surface, as a
                                 function called from migrations and from here
  21_daily_tiebreak.test.sql     the daily board's tie-breaks come from the
                                 attempt, not the week bucket
  22_migration_recovery.test.sql the three derived states are re-derivable
  23_account_lifecycle.test.sql  deletion is total and refuses for exactly one
                                 stated reason. Does NOT name the tables it
                                 checks: it asks the catalogue for every
                                 cascading reference to the account, so a table
                                 added later without a cascade fails it with no
                                 edit
```

**469 assertions across 24 files.** They test authorization by **acting as the
attacker** — `SET LOCAL ROLE authenticated` plus a `request.jwt.claims` subject,
which is exactly the context PostgREST establishes for a real request.

Two things pgTAP cannot reach, both in `tests/server/`:

* **concurrency.** One session in one transaction cannot express two signups
  racing for a handle. `account-lifecycle.integration.test.ts` fires eight at
  once through the real GoTrue.
* **the write half of the IDOR sweep.** `rls-idor.integration.test.ts` reads;
  `rls-writes.integration.test.ts` writes, with a second real token, across
  every one of the thirteen client write grants.

Two real defects surfaced while writing them, both fixed:

1. **`handle_new_user` could not resolve a username collision.** The derived
   handle was `'p' || substr(id, 1, 12)`, and the collision branch retried the
   same string — so two accounts sharing their first twelve hex digits would
   deadlock on the unique index instead of falling back. Now suffixed until free.
   Two further versions of the same bug have been found since, and both cost a
   player their account: a derived handle that folded into a forbidden word
   could not be repaired by suffixing at all (fixed in
   `20260823150000`), and a *concurrent* signup for the same requested handle
   violated `profiles_username_key` between the check and the insert, which
   aborted the trigger, aborted the `auth.users` insert, and answered HTTP 500
   (fixed in `20260829120000`). Every version of it looks like a different bug
   and is the same one: **the pre-check is advisory, so the insert must be able
   to fail and recover.**
2. **Guard triggers were unreachable for client roles.** `is_client_role()` had
   its `EXECUTE` revoked from `PUBLIC` and never re-granted. Trigger functions
   run as the invoker, so *every* legitimate client write — renaming yourself,
   accepting a friend request, marking a notification read — failed with
   `permission denied for function is_client_role`. The tests failed on the
   positive cases, not the negative ones, which is precisely why the suite tests
   what should work as well as what should not.

---

## What is not built yet

Everything this section listed for the first several phases — the Edge Functions,
private-state accessors, command idempotency, leaderboards, decision accuracy,
the Realtime publication — has since been built, and the entries stayed here long
after they stopped being true. They are removed rather than reworded, because a
stale gap list is worse than none: it tells a reader not to look for something
that is already there.

What is genuinely absent today:

- **Generated TypeScript types.** `src/lib/supabase/database.types.ts` is
  hand-narrowed to the *authorised* surface on purpose — a client-side write is a
  compile error rather than a runtime rejection. When
  `supabase gen types typescript --local` is adopted, derive from it with `Pick`
  rather than replacing that narrowing.
- **A scheduler for the push sender.** `send-notifications` is invokable and
  drains a bounded slice per call; nothing calls it on a timer. Notifications
  therefore reach the in-app inbox immediately and a device only when something
  invokes the sender.
- **A down-migration framework.** There is none, and this project does not need
  one — see "Reversibility and recovery" above, which states the position for
  every migration individually.
