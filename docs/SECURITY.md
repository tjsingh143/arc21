# Arc 21 — Security

The threat model is an **adversarial modified client**. Every control below
assumes the app binary, its storage and its network traffic are fully under the
attacker's control.

---

## What a modified client must never be able to do

| Attack | Control |
|--------|---------|
| Choose its own cards | Shoe order is generated and held server-side |
| See the future shoe | `toPublicState` never serialises undealt cards; asserted by `assertNoHiddenCardLeak` |
| See the hole card early | Replaced by a `{ hidden: true }` placeholder until reveal |
| Credit its own wallet | No client write path to `wallets` or `wallet_ledger`; RLS denies all client writes |
| Settle a hand twice | Idempotency keys + row locking + a single transaction |
| Submit another player's action | Identity derives from the auth session, never from the payload |
| Claim a prize twice | Unique idempotency key on every ledger entry |
| Manufacture leaderboard stats | Stats written only by server commands |
| Bypass a table buy-in | Buy-in debit and stack creation happen in one transaction |
| Replay an accepted economic command | `clientActionId` uniqueness returns the first committed result |
| Act out of turn or illegally | Server re-runs `getLegalActions` on authoritative state |

**A hidden button is not a security boundary.** Every action is validated
server-side on authoritative state regardless of what the UI rendered.

---

## Authorization

Every Edge Function command authenticates first and derives identity from the
session. The server never accepts a client-supplied `userId`, wallet balance,
seat ownership, hand result, shuffle or tournament placement.

## Row Level Security — the full audit

Every table in `public` is listed. Not a sample, not the interesting ones: all
of them, so that a table added tomorrow is missing from this document rather
than quietly absent from the review.

Audited 2026-08-18 (phase 14, session 2) against the running database, and
re-derivable at any time from `supabase/tests/20_authorization_surface.test.sql`,
which asserts the same claims mechanically.

**Two rules cover the whole table and are worth stating once rather than
thirty-four times.**

1. RLS is enabled on every table, and **RLS with no policy is deny-all**. A
   table with no policy for a command cannot be reached with that command by any
   client role, whatever the grant says.
2. A client's identity in every policy is `auth.uid()` from the verified JWT.
   No policy takes a user id from a column the client can write.

`server-owned` in the Grants column means no client role holds any write
privilege, and the table additionally carries a `deny_client_write` trigger — the
privilege system refuses first, and the trigger refuses if the privilege system
is ever loosened.

| Table | RLS | Policies | Client grants | Why that grant |
|---|---|---|---|---|
| `blocks` | yes | select / insert / delete own | `SELECT`, `INSERT`, `DELETE` to `authenticated` | You manage your own block list; a block is only ever your own row |
| `career_nodes` | yes | select active | `SELECT` to `anon` + `authenticated` | The career map is a catalogue. It describes the product, not a person |
| `career_progress` | yes | select own | `SELECT` to `authenticated` | Your own stars. Every write is a server reward |
| `cosmetics` | yes | select active | `SELECT` to `anon` + `authenticated` | Catalogue. Carries no price column and no player reference |
| `daily_challenges` | yes | select once open | column-level `SELECT` to `authenticated`, **excluding `seed_secret`** | The commitment and the format are public; the seed is the shoe. `select *` is refused by the privilege system, not filtered by a policy |
| `daily_entries` | yes | select own | `SELECT` to `authenticated` | Your own attempt. The board is published separately as server-produced, public-safe output |
| `friend_requests` | yes | select participants / insert as sender / update participants | `SELECT`, `INSERT` + `UPDATE (status)` to `authenticated` | You can accept or decline; `status` is the only column either party may move |
| `friendships` | yes | select own / delete own | `SELECT`, `DELETE` to `authenticated` | Unfriending is a client action. Creating a friendship is not — that is `accept_friend_request` |
| `game_events` | yes | select participant | `SELECT` to `authenticated` | Public event payloads for a table you hold a seat at |
| `game_session_seats` | yes | select participant | `SELECT` to `authenticated` | Stacks and seat state at your own table. server-owned |
| `game_sessions` | yes | select participant | `SELECT` to `authenticated` | The session you are seated at. server-owned |
| `hand_players` | yes | select participant | `SELECT` to `authenticated` | Your own settlement history. server-owned |
| `hand_records` | yes | select participant | `SELECT` to `authenticated` | Hands you played. server-owned |
| `loadouts` | yes | select / insert / update own | `SELECT`, `INSERT` + `UPDATE` on the three slot columns | Equipping is a client action; ownership is re-checked by a trigger, so equipping an unowned item is refused by the database |
| `matchmaking_queue` | yes | select own | `SELECT` to `authenticated` | Your own place in the queue. The queue is not a directory of who is playing |
| `notifications` | yes | select / update / delete own | `SELECT`, `DELETE` + `UPDATE (read_at)` to `authenticated` | You may mark your own read and delete it. `read_at` is the only writable column, enforced by comparing the whole row rather than a column list |
| `player_actions` | yes | select own | `SELECT` to `authenticated` | Your own action log. server-owned |
| `player_daily_xp` | yes | select own | `SELECT` to `authenticated` | Your own daily cap progress. server-owned |
| `player_decision_periods` | yes | select own | `SELECT` to `authenticated` | "62 of the 100 decisions you need this week". server-owned |
| `player_mode_stats` | yes | select own | `SELECT` to `authenticated` | Your own per-mode statistics. server-owned |
| `player_stats` | yes | select own | `SELECT` to `authenticated` | Your own lifetime statistics. server-owned |
| `profiles` | yes | select self / select visible / update self | `SELECT` + `UPDATE` on six columns: `display_name`, `username`, `bio`, `avatar_url`, `country_code`, `privacy` | The mutable half of your identity. `level`, `xp` and `username_changed_at` are absent from the grant AND blocked by a trigger |
| `push_tokens` | yes | select / insert / update / delete own | `SELECT`, `INSERT`, `DELETE` + `UPDATE` on three columns | A device registers and retires itself |
| `rate_limit_events` | yes | **none — deny all** | none | Nothing needs to read another player's attempt history, or their own. Stated as no policy rather than `using (false)`, which reads as an oversight |
| `rate_limit_policies` | yes | **none — deny all** | none | The limits are server configuration. A client learns a limit by being refused, which tells it the number and when to retry |
| `room_members` | yes | select same room | `SELECT` to `authenticated` | Who else is at your table. Membership is resolved by a `SECURITY DEFINER` helper, because a policy on `room_members` that queries `room_members` recurses |
| `rooms` | yes | select member | `SELECT` to `authenticated` | Your own table. There is deliberately **no** policy allowing a room to be found by code, so a client cannot enumerate live codes with a range query — joining goes through `join_private_room` |
| `rulesets` | yes | select active | `SELECT` to `anon` + `authenticated` | The rules of the game are a Fair Play claim and are meant to be readable |
| `tournament_entries` | yes | select visible | `SELECT` to `authenticated` | Entries in a tournament you are in |
| `tournament_matches` | yes | select visible | `SELECT` to `authenticated` | Matches in a tournament you are in |
| `tournaments` | yes | select all | `SELECT` to `anon` + `authenticated` | The tournament schedule is a listing, not a person |
| `user_cosmetics` | yes | select own | `SELECT` to `authenticated` | What you own. Granting is server-side, from level and career progress |
| `wallet_ledger` | yes | select own | `SELECT` to `authenticated` | Append-only history of your own chips. **No client write of any kind, at table or column level** |
| `wallets` | yes | select own | `SELECT` to `authenticated` | Your own balance. **No client write of any kind, at table or column level** |

Six tables take a client write — `friend_requests`, `friendships`, `blocks`,
`loadouts`, `push_tokens`, `notifications` — and `profiles` takes a column-level
one. The other twenty-seven are server-owned. That list is asserted, not
described: adding a seventh fails
`supabase/tests/20_authorization_surface.test.sql`.

### The function surface

`anon` can execute **one** function in `public`: `is_client_role()`, which the
guard triggers call and which reports the caller's own role back to the caller.
`authenticated` can execute 54, each one either a relationship predicate an RLS
policy needs, a guard or CHECK helper that runs with the invoker's rights, or an
RPC the app actually calls.

**This was not true before this session, and the reason is worth knowing.** A
newly created function carries Postgres's default ACL, which is `EXECUTE TO
PUBLIC` — every role, `anon` included. A migration that writes only

```sql
grant execute on function … to authenticated;
```

adds a privilege without removing the default one, and reads as though it were
the whole story. Sixteen migrations did exactly that, so `anon` could execute
seventeen functions including all four leaderboards. Nothing was exploited by
it — the client refuses to read a board without a session — but the grant said
one thing and the product did another.

`public.assert_client_authorization_surface()` now refuses any function in
`public` that is executable by `PUBLIC`, which catches the whole class without
anybody maintaining a list.

### The gate

`supabase/migrations/20260813121200_hardening.sql` introduced DO blocks that fail
the MIGRATION — and therefore the deploy — if a client role gains something
unexpected. They ran once, thirteenth of thirty-two, and never saw anything
applied after them.

Those checks are now `public.assert_client_authorization_surface()`, called at
the end of `20260818120000_authorization_gate.sql` and again from pgTAP. **A
migration that changes a grant should call it as its last line.** It enforces:

1. RLS enabled on every table in `public`
2. no grant of any kind on the `private` schema to an API role
3. no function in `public` executable by `PUBLIC`, including via a default ACL
4. the exact `anon` and `authenticated` function allowlists
5. no unexpected client write on any table
6. no column-level write on `wallets` or `wallet_ledger` — invisible to
   table-level checks, which is why it is separate
7. no client-readable view without `security_invoker`, which would otherwise run
   with its owner's rights and launder RLS
8. no client grant without a policy to permit it, so a dead grant cannot sit
   around looking like a feature somebody should finish

Each of those is proved to FAIL when breached, in
`supabase/tests/20_authorization_surface.test.sql`. A gate nobody has watched
fail is a gate nobody should trust.

---

## Money integrity

- Wallets use an **append-only ledger**. A correction is a new entry, never an
  edit to history.
- Every ledger row carries `delta`, `balance_after`, `reason`, an optional
  reference, and a **unique idempotency key**.
- A table buy-in debits the wallet once into a server-owned table stack; wagers
  move within that stack; the remainder returns to the wallet when the session
  closes safely. This minimises wallet mutations and makes reconciliation simple.
- `balance >= 0` is a database constraint, not application logic.
- All chip math is integer. No floating-point arithmetic touches a balance.
- A room row is never deleted while wallet escrow remains unreconciled.
- A server crash cannot both retain an active table stack and credit it back.

---

## Input validation

- Zod schemas at every external boundary; strict TypeScript throughout
- Postgres constraints as the last line of defence
- Length limits on all free text
- Username: 3–20 chars, lowercase-normalised handle, `[a-z0-9_]`, unique,
  server-validated, profanity/reserved-name filtered, rate-limited changes
- Display name: 1–24 visible characters, Unicode permitted after sanitisation
- Room codes: 6 uppercase characters excluding visually ambiguous glyphs
  (`O`/`0`, `I`/`1`), giving sufficient entropy against guessing
- A room code alone is never treated as authorization

## Rate limiting

Supabase Auth's own limits apply to authentication. Everything else is enforced
in the database, where this project's authorization model already lives.

**Every number is in one table**, `public.rate_limit_policies`, read through
`rate_limit_for(action)`. No enforcement point carries a window of its own, and
`19_rate_limits.test.sql` asserts that none of them does by pattern-matching the
function bodies.

| Action | Limit | Where it is enforced |
|---|---|---|
| friend requests | 20 / hour | `send_friend_request` |
| room creation | 5 / minute **and** 40 / hour | `create_private_room` |
| room join attempts | 10 / minute | `join_private_room` |
| matchmaking enrolments | 10 / minute, 60 / hour | `join_matchmaking` |
| username change | 1 / 30 days | `guard_profile_username` trigger |
| display-name change | 5 / hour | `guard_profile_display_name_rate` trigger |
| game commands outside an active game | 30 / minute | `game-command` Edge Function |

An action may carry more than one policy — that is how "room creation per
minute/hour" is expressed without inventing two action names — and the tighter
window refuses first.

### The window rolls

Every decision counts events strictly newer than `now() - window_length`. A limit
that resets on the hour is a limit that can be doubled at 59 minutes past.

### A refusal is not recorded

Deliberate, and the difference between a limit and a ban. If a refusal also wrote
an event, a caller hammering faster than the window drains would keep their own
window permanently full and never get back in. Only allowed attempts are
recorded, so the window always drains in exactly `window_length`.

### A refusal does not leak

The friend graph answers "no such player" for both a missing account and a block,
so a caller cannot use it to enumerate. A rate-limit refusal must not undo that.
Two rules hold it:

- the limit is consumed **before** any lookup of the thing being acted on, so the
  refusal is a pure function of the caller's own history and cannot differ by
  target;
- the message says only how often the action may be taken and when to retry. It
  names no account, no room, no code and no game.

### Refusals are HTTP 429

Raised with SQLSTATE `PT429`, which PostgREST maps to HTTP 429. The pre-existing
username limit raised `55000`, which PostgREST renders as **HTTP 500** — a player
who renamed themselves twice in a month was told the server had broken. Measured
against the running stack, then fixed.

### Why a failed room join returns no row instead of raising

A limit consumed inside the caller's transaction is rolled back with that
transaction. For five of the six actions that is harmless, because the attempt
being charged is one that then succeeds. A room join is the opposite: the attempt
worth limiting is the one that finds nothing, because this is the control that
makes guessing a six-character code impractical.

So `join_private_room` returns **no row** — for an unknown code, an expired
table, a full one and a block alike — rather than raising. The attempt commits
and is counted. This also closes a small oracle that predated it: "that table is
full" told a guesser their code had hit a real live room, while "that table is
not available" told them it had not.

The rate limit itself still raises. That is the case where rolling back is
correct: a refusal must not be recorded.

---

## Secrets

- **Never** place a service-role key or any server secret in an `EXPO_PUBLIC_*`
  variable. Those are compiled into the client bundle and are public by definition.
- Mobile environment variables carry only publishable client configuration:
  `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
- Server secrets live in Supabase Function secret storage.
- Daily Challenge seeds are stored server-side only and are never sent to a
  client while the challenge is active.

## Notifications and deep links

Three separate boundaries, because a notification is the one piece of content
this app both writes and receives through a channel it does not control.

**A notification is server-written.** `public.notify_user` is revoked from `anon`
and `authenticated`, so there is no grant under which a modified client can post
itself "you won a tournament" or forge one from another player. The
`notifications` UPDATE policy allows a client to change `read_at` only, enforced
by a trigger that compares the whole row rather than a list of columns — a list
would leave every column added later silently writable, which is exactly what had
already happened.

**A payload carries deep-link parameters and nothing else.**
`notifications.data` has a CHECK against an allowlist of keys holding short
scalars. An array fails, so a shoe cannot travel; an unlisted key fails, so a
seed cannot; and 64 characters is not enough to hide much in the keys that are
allowed. The client re-validates on arrival, because a push payload reaches the
app through the operating system.

**A payload never names a route.** The destination for a tapped notification is
derived from its KIND by a closed union in
`src/features/notifications/notifications.ts`. A payload naming `/settings`, an
external URL or `../../` changes nothing about where the tap leads. This is the
open-redirect defence, and it is a compile-time property rather than a check.

**A room code is an address, not authorisation.** `arc21://room/CODE` is resolved
by `join_private_room`, which re-checks the room's status, expiry and capacity
and whether either player has blocked the other. The refusal wording is
deliberately the same for all of those, so a link cannot be used to probe whether
a table exists.

**The push sender is service-role only.** `send-notifications` reads other
players' notification titles and bodies by design, so a signed-in player's token
is refused as firmly as no token at all. The comparison against the service key
is length-checked and then constant-time.

**Permission is asked at a moment, never at onboarding.** The four moments are
enumerated in a union type; a grant switches on the master preference and the
moment's own category, and nothing else.

## Local storage

Stored locally: onboarding flag, preferences, audio/haptic settings, guest
identity, guest practice stats, the offline Practice session, cached strategy
tables, cached public profile, cosmetics metadata index, and the last active
online game id.

**Never stored locally:** server shoe order, service-role secrets, raw passwords,
any authority over the competitive wallet, or hidden tournament seeds.

Authenticated sessions use the supported Supabase storage adapter, with sensitive
values protected via SecureStore.

---

## Logging

Structured logs carry game id, room id, state version, command id, event seq,
user id where privacy allows, and an error code.

Logs **never** contain passwords, tokens, the hidden shoe, an unrevealed dealer
hole card, a daily challenge seed, or service credentials. The same exclusions
apply to analytics events and crash reports.

---

## Multiple devices

A user may be signed in on several devices for profile viewing, but gameplay
allows **one active seat session per user per game**. Conflicting gameplay
commands from a second device are rejected or require explicit control transfer;
two devices may never race the same hand.

---

## Disconnects

A disconnected seat is reserved for 90 seconds and may be reclaimed by
authenticated session. Timers continue — backgrounding does not pause an online
match, and leaving is never a way to escape a committed wager. Private-room host
ownership transfers to the longest-connected eligible member; **the host never
owns the dealer or the shoe**, so host migration cannot influence gameplay.
