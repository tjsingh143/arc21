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
| `hand_records` | Completed-hand archive. Dealer cards may only be stored once `completed_at` is set |
| `hand_players` | One settled player hand. `net = credit - wager` is a constraint |
| `player_actions` | Per-decision log with optional strategy grading. Readable only by the player who made the decision |
| `private.game_state_private` | See above |

`game_session_seats` is not in the original table list but is required: RLS needs
a membership table that exists from the moment a room is created, before any
hand has been dealt.

`hand_records.dealer_cards` deserves its own note. A hand-history table is
exactly the sort of place a hole card leaks from — an "archive" row written at
deal time would publish the dealer's down card to every participant before the
peek. The constraint makes that shape unstorable rather than merely discouraged.

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
```

**355 assertions across 19 files.** They test authorization by **acting as the
attacker** — `SET LOCAL ROLE authenticated` plus a `request.jwt.claims` subject,
which is exactly the context PostgREST establishes for a real request.

Two real defects surfaced while writing them, both fixed:

1. **`handle_new_user` could not resolve a username collision.** The derived
   handle was `'p' || substr(id, 1, 12)`, and the collision branch retried the
   same string — so two accounts sharing their first twelve hex digits would
   deadlock on the unique index instead of falling back. Now suffixed until free.
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
- **Rate limiting.** Application-level limits (friend requests per hour, room
  creation per minute) are named in the specification and are not enforced in the
  database. Idempotency keys and the per-room and per-pair dedupe keys blunt the
  obvious abuse, but they are not a limiter.
- **A scheduler for the push sender.** `send-notifications` is invokable and
  drains a bounded slice per call; nothing calls it on a timer. Notifications
  therefore reach the in-app inbox immediately and a device only when something
  invokes the sender.
- **The daily challenge's own accuracy.** A daily entry does not record the
  accuracy or EV lost of its attempt, so that board ranks on score then
  submission time and the specification's tie-breaks above that are absent rather
  than approximated. Decisions ARE graded server-side and feed the weekly
  strategy board — the gap is the per-entry figure, not the grading.
