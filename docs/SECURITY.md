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
| Delete somebody else's account | `delete_own_account()` takes no arguments and reads the caller from `auth.uid()` |
| Set a password shorter than the stated policy | `minimum_password_length = 8` in GoTrue, not only in the client's validator |

**A hidden button is not a security boundary.** Every action is validated
server-side on authoritative state regardless of what the UI rendered.

---

## Pseudonymous identity and abuse (Refresh B)

Supabase anonymous players are authenticated users, not the unauthenticated
`anon` API role. No RLS policy may infer a verified email from `authenticated`.
The existing account-scoped authorization remains valid for normal play; no
email-dependent play/social gate was added. Identity is taken from verified
Auth/session state and never from anonymous signup metadata or payload UUIDs.

The handle allocator runs within the auth-user/profile/wallet transaction. Its
unique index arbitrates concurrent allocation; filtered candidates retry only a
username collision. Signup metadata cannot choose an anonymous player's initial
handle or bypass moderation. Existing rename limits and normalization remain.
One 25,000-chip opening ledger entry belongs to each new UUID. Restore, refresh,
linking, and retries on the same UUID cannot award another opening grant. No
editable local economy/competition data reaches the server through this flow.

Hosted activation must enable anonymous Auth, email confirmations, manual
linking, the email-change OTP template, working SMTP, and CAPTCHA. The app has
an optional native hCaptcha integration; only its public site key/origin may be
`EXPO_PUBLIC_`. The secret belongs to Auth settings. Retain signup/IP limits
(default 30 anonymous creations/hour/IP), monitor creation volume and abuse,
and tune protections before release without requiring email for play. CAPTCHA
and IP limits reduce farming; they do not establish a unique human or prevent
all multi-account play. Virtual chips cannot be transferred between players,
private stacks cannot enter global wallets, and no new economic merge exists.
Repeated deletion/recreation remains subject to Auth signup limits and starts
an unrelated UUID; deletion never replenishes the previous wallet.

Direct friend-request INSERT is revoked because it bypassed the existing RPC's
20/hour limit. Presence now exposes only accepted, unblocked friends recently
seen by the server (90-second window); it does not accept client-authored UUIDs
or `in_game` claims. Shared Realtime presence read/write policies are removed.

Email securing verifies ownership before password attachment. Verification runs
in a detached client so a code for another pending UUID cannot replace this
player. Owned-email conflicts are not merged. A fully lost anonymous-creation
response can leave an inaccessible orphan because Auth offers no creation
idempotency key; no device data is imported into its replacement. A lost linking
response is reconciled using the current server user and refresh on the same ID.

Unlinked credentials lost through sign-out, keychain clearing, reinstall or a
lost device may be unrecoverable. The app warns at destructive boundaries and
reports keychain write failures. Atomic storage preserves the previous complete
credential during replacement. Push registration/retirement are ordered, use the
captured verified credential, and reject stale local association updates.

There is no automatic age-based deletion of anonymous players: they are normal
persistent players and may own funds, active seats and relationships. Any future
orphan cleanup requires an operational retention policy, activity/ownership
checks, and the established seat/economic cleanup path. Never bulk-delete
`auth.users` merely because `is_anonymous` is true.

See [Refresh B](./astra-refresh/refresh-b.md) for current proof and activation
limits. The [Refresh-A audit](./astra-refresh/baseline-audit.md) remains historical
evidence for its own checkpoint.

## Authorization

Every Edge Function command authenticates first and derives identity from the
session. The server never accepts a client-supplied `userId`, wallet balance,
seat ownership, hand result, shuffle or tournament placement.

## The trust boundary, item by item

Assume the client is hostile: the bundle is readable, `EXPO_PUBLIC_*` values are
public, the code can be modified, local storage can be rewritten, Supabase can be
called directly with hand-crafted payloads, any object id can be substituted, and
no UI restriction exists. Client secrecy is not a boundary. Each row below names
what OWNS the value and where the client's copy comes from; the third column is
how it was checked in phase 10, not how it was intended.

| State | Owner | Verified by |
|---|---|---|
| **Wallet balance** | `public.wallets`, written only by `apply_wallet_delta` as `postgres` | No client grant, no write policy, `deny_client_write`, and no API role holds EXECUTE — `service_role` lost the last one this phase. A player calling the RPC gets 403 |
| **Ledger** | `public.wallet_ledger`, append-only, unique idempotency key per entry | `guard_ledger_append_only`; `SELECT`-only for its owner; no column-level write grant, which a table-level check cannot see and the gate checks separately |
| **The online shoe** | `private.game_state_private.engine_state` | The `private` schema has no USAGE for any API role. Measured on a live table: 312 cards, 304 undealt, and **not one of their ids** appears in the create-session reply, the public state, `game_sessions`, `game_session_seats`, `game_events`, `player_actions`, `hand_records` or `hand_players` |
| **Shoe index** | same row, same schema | Same sweep. `toPublicState` carries the shoe's *penetration*, never its position in a card list |
| **The dealer's hidden card** | same row | Measured at PLAYER_TURNS with `holeCardRevealed: false`: the card's id appears in none of the eight readable surfaces, and the public state carries `{"hidden":true}` in its place. The three cards the seat HAD been dealt do appear — the positive control, so the sweep is not passing on a mismatch |
| **Game version** | `private.game_state_private.version`, bumped inside the command transaction | A client sends `expectedVersion` and is answered `stale` with the authoritative snapshot; nothing is applied. A negative or fractional one is a 400 |
| **The active actor** | the engine's `activeSeatId` on authoritative state | `assertCommandIsLegal` re-runs `getLegalActions` server-side. `isBettingTurn` is the one definition of whose turn it is to stake, and the sequential Sprint table answers `NOT_YOUR_TURN` |
| **Legal actions** | `shared/blackjack/legal-actions.ts`, run on the row, not on the request | The seat id comes from the DB lookup; the request has no seat field to confuse |
| **Competitive statistics** | `player_stats`, `player_mode_stats`, `player_decision_periods`, `player_daily_xp` | server-owned, `deny_client_write`, and attacked over HTTP with a real token in `tests/server/rls-writes.integration.test.ts` — including a forged `repeatable_xp: 999999`, which is how the missing trigger was found in phase 9 |
| **Career rewards** | `career_progress`, `career_attempts`, paid by `settleCareerReward` under `reward_claimed_at` | A drill's scenarios are REGENERATED from a secret in `private.career_drill_seeds` and graded server-side; a client may send any answers and cannot send a different question. `SUBMIT_CAREER_DRILL` against another account's `attemptId` is `NOT_A_PARTICIPANT` |
| **Tournament state** | `private.game_state_private` plus `tournaments`, moved only by `_shared/session-boundary.ts` | server-owned tables; the boundary runs inside the command transaction, before the engine deals |
| **Tournament placement** | `tournament_entries.placement`, written by the boundary | server-owned; a forged `placement: 1` over PostgREST is refused, and since this phase the row is not even readable by a stranger |
| **Daily state and seed** | `daily_challenges.seed_secret` | Excluded from the column grant, so `select *`, `select=seed_secret`, `order=seed_secret` and `seed_secret=like.*` are all **HTTP 403 from the privilege system** rather than filtered by a policy — a filter would leave a blind oracle. Measured, all four |
| **Leaderboards** | four `SECURITY DEFINER` functions over server-owned inputs | The inputs carry `deny_client_write`; the six functions that write them are revoked from every client role, checked over HTTP rather than inferred |
| **Cosmetic ownership** | `user_cosmetics`, granted by `grant_earned_cosmetics_for` from level and career progress | `SELECT`-only for its owner; a forged `INSERT` is refused, and `equip_cosmetic` re-checks ownership in a trigger, so equipping an unowned item fails at the database |

No client-authoritative shortcut was found to remove: nothing in `src` or `app`
writes any of the above, and `tests/wallet/no-write-path.test.ts` scans four
directories for the attempt rather than waiting for a behavioural test to trip
over it.

## Row Level Security — the full audit

Every table in `public` is listed. Not a sample, not the interesting ones: all
of them, so that a table added tomorrow is missing from this document rather
than quietly absent from the review.

Audited 2026-08-18 (phase 14, session 2) and re-audited 2026-09-02 (phase 10)
against the running database, and re-derivable at any time from
`supabase/tests/20_authorization_surface.test.sql`, which asserts the same claims
mechanically. **The phase 10 pass read rows rather than grants**, with two real
tokens against the live stack, and that is what found the one table below whose
policy did not match this document — see `tournament_entries`.

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
| `career_attempts` | yes | select own | `SELECT` to `authenticated` | Your own reward-bearing attempts. Every counter on the row was written by the server from its own state; the client reports nothing into it |
| `career_progress` | yes | select own | `SELECT` to `authenticated` | Your own stars. Every write is a server reward |
| `cosmetics` | yes | select active | `SELECT` to `anon` + `authenticated` | Catalogue. Carries no price column and no player reference |
| `daily_challenges` | yes | select once open | column-level `SELECT` to `authenticated`, **excluding `seed_secret`** | The commitment and the format are public; the seed is the shoe. `select *` is refused by the privilege system, not filtered by a policy |
| `daily_entries` | yes | select own | `SELECT` to `authenticated` | Your own attempt. The board is published separately as server-produced, public-safe output |
| `friend_requests` | yes | select participants / update participants | `SELECT` + `UPDATE (status)` to `authenticated` | Creation uses the rate-limited RPC; `status` is the only column either party may move |
| `friendships` | yes | select own / delete own | `SELECT`, `DELETE` to `authenticated` | Unfriending is a client action. Creating a friendship is not — that is `accept_friend_request` |
| `game_events` | yes | select participant | `SELECT` to `authenticated` | Public event payloads for a table you hold a seat at |
| `game_session_seats` | yes | select participant | `SELECT` to `authenticated` | Stacks and seat state at your own table. server-owned |
| `game_sessions` | yes | select participant | `SELECT` to `authenticated` | The session you are seated at. server-owned |
| `hand_players` | yes | select participant | `SELECT` to `authenticated` | Settlement history. Server-owned, and **V1.1: nothing writes it yet** |
| `hand_records` | yes | select participant | `SELECT` to `authenticated` | Hands you played. Server-owned, and **V1.1: nothing writes it yet** |
| `loadouts` | yes | select / insert / update own | `SELECT`, `INSERT` + `UPDATE` on the three slot columns | Equipping is a client action; ownership is re-checked by a trigger, so equipping an unowned item is refused by the database |
| `matchmaking_queue` | yes | select own | `SELECT` to `authenticated` | Your own place in the queue. The queue is not a directory of who is playing |
| `notifications` | yes | select / update / delete own | `SELECT`, `DELETE` + `UPDATE (read_at)` to `authenticated` | You may mark your own read and delete it. `read_at` is the only writable column, enforced by comparing the whole row rather than a column list |
| `player_actions` | yes | select own | `SELECT` to `authenticated` | Your own action log. server-owned |
| `player_daily_xp` | yes | select own | `SELECT` to `authenticated` | Your own daily cap progress. server-owned, and since phase 9 also `deny_client_write` — this table IS the weekly XP board |
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
| `tournament_entries` | yes | select own **or** in the same tournament | `SELECT` to `authenticated` | Your own entry, and the entries of the field you are playing. Competitors must see each other's stacks — that is what bankroll-position strategy is — and nobody else may. **Phase 10 narrowed this**: see below |
| `tournament_matches` | yes | select in the same tournament | `SELECT` to `authenticated` | Matches in a tournament you are in. V1.1 shape; nothing writes the table yet |
| `tournaments` | yes | select all | `SELECT` to `anon` + `authenticated` | The tournament schedule is a listing, not a person |
| `user_cosmetics` | yes | select own | `SELECT` to `authenticated` | What you own. Granting is server-side, from level and career progress |
| `wallet_ledger` | yes | select own | `SELECT` to `authenticated` | Append-only history of your own chips. **No client write of any kind, at table or column level** |
| `wallets` | yes | select own | `SELECT` to `authenticated` | Your own balance. **No client write of any kind, at table or column level** |

Five tables take a table-level client write — `friendships`, `blocks`,
`loadouts`, `push_tokens`, `notifications` — while `profiles` and
`friend_requests` take selected-column updates. The other twenty-seven are
server-owned. That list is asserted, not described: adding another write fails
`supabase/tests/20_authorization_surface.test.sql`.

### The one row of that table the database disagreed with, and how it was found

`tournament_entries_select_visible` shipped with a third clause:

```sql
or exists (select 1 from public.profiles p where p.id = tournament_entries.user_id)
```

The reasoning it carried was sound in shape — nested access inside a policy is
evaluated as the invoking role, so a hidden profile yields no row and the entry
stays hidden, which keeps visibility rules in one place instead of restating them.
What it missed is that `profiles.privacy` **defaults to `public`**, so for an
ordinary account the subquery is simply true and the clause collapses to "anyone
signed in".

Measured before the fix: a second account created seconds earlier, with no
friendship, no shared table and no tournament of its own, read **152 entry rows**
— `user_id`, live `chips`, `placement` and `prize_chips` for every entrant in the
database. `public.sprint_standings` refuses a non-participant exactly those
numbers with a `42501`, so the sanctioned read path and the table underneath it
disagreed about the same data.

Three artefacts described the tighter rule and only the policy did otherwise:
this document, `sprint_standings`, and
`tests/server/rls-idor.integration.test.ts`, which classified the table as OWNED
— "a stranger must see NONE of it" — and passed the whole time **because its
fixture never created an entry**. The file's own header warns that "a sweep over
empty tables passes having proved nothing", and it had one inside it. Both halves
are now covered: that sweep reads every OWNED table with **no filter at all** and
asserts relationally that every row it gets back belongs to the caller, and
`tests/server/sprint-tournament.integration.test.ts` holds the positive proof —
a real four-player tournament, where a competitor sees the whole field and a
stranger sees none of it.

### What the profile privacy setting does, and what it does not do

`profiles.privacy` is the column behind Settings → "Statistics visibility", and
phase 10 measured all three of its effects rather than reading them off the
policy:

* a direct read of `profiles` returns **nothing** to a stranger — measured;
* `player_public_profile` answers `stats_visible = false` with every statistic
  NULL rather than zero — measured;
* and it does **not** take the player off the leaderboards, or hide them from
  `search_players`. Measured: a `private` account with 4,242 weekly XP came back
  on `leaderboard_weekly_xp` under its display name, to a stranger, and came back
  from `search_players` on a six-character prefix of its handle.

Both of those are the specification working. Its leaderboard section asks for a
global board carrying "avatar, display name, value" and forbids only exposing "a
private email or account identifiers"; friend search is specified as "search
exact or partial username", and a player nobody can find is a player nobody can
befriend. What was wrong was the SENTENCE on the Settings screen, which claimed
the control governed "your profile and standings" — and a leaderboard placement
is precisely a standing. `STATS_VISIBILITY_NOTE` now states what the column
enforces, and `tests/settings/privacy-copy.test.ts` pins the claim to it.

### The function surface

`anon` can execute **one** function in `public`: `is_client_role()`, which the
guard triggers call and which reports the caller's own role back to the caller.
`authenticated` can execute 61, each one either a relationship predicate an RLS
policy needs, a guard or CHECK helper that runs with the invoker's rights, or an
RPC the app actually calls.

**`service_role` can execute ZERO**, and until phase 10 it could execute one:
`apply_wallet_delta`. The foundation migration had already revoked its default
table and sequence privileges and written down the reason — the server reaches
this schema as `postgres`, over the Edge Functions' direct database connection,
or through a `SECURITY DEFINER` function owned by `postgres`, so the key needs
nothing here — and that sentence was simply never applied to functions. It was
measured before it was removed: a POST to `/rest/v1/rpc/apply_wallet_delta`
carrying nothing but the service key answered **HTTP 200** and moved a wallet
from 24,450 to 1,024,450. A service key is a root credential and this was
defence in depth rather than a client-reachable hole, but "root" is a reason to
take the last verb away rather than to leave it. A leaked service key now reads
no table, writes no table and executes no function in `public`.

**Every parameterised function a client may execute derives identity from
`auth.uid()`** — asked of the catalogue, not remembered: of the 38 that take an
argument, 34 reference `auth.uid()` in their own body and the other four are
pure (`level_from_total_xp`, `notification_data_is_safe`, `sanitise_display_name`,
`username_is_permitted`). None of them takes a user id it then trusts.

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
9. **no privilege of any kind for `service_role` in `public`** — not a table
   grant and not a function EXECUTE. Stated as "nothing" rather than as an
   allowlist, because the correct number is zero and an allowlist is a place for
   the number to grow
10. **no policy on a `public` table names the `PUBLIC` role.** A policy written
    without a `to` clause applies to every role, `anon` included. Five did, and
    all five were harmless because `anon` holds no grant on those tables — which
    is the FIRST lock, and this repository has added a client grant by accident
    sixteen times. Naming the role is the second

Each of those is proved to FAIL when breached, in
`supabase/tests/20_authorization_surface.test.sql`. A gate nobody has watched
fail is a gate nobody should trust — and that applies one rule at a time: this
sentence was here before phase 10 and was true of eight of the ten, because
rules 7 and 8 had no breach case. They have one each now.

### The second lock: `deny_client_write`

The gate above protects the FIRST lock — that no client grant exists. The second
is a `BEFORE INSERT OR UPDATE OR DELETE` trigger on each server-owned table,
raising `42501` whenever `current_user` is `anon` or `authenticated`. It matters
because sixteen migrations have added a client grant by accident, and a table
whose only protection is the absence of one is a single migration from being
writable.

Phase 9 found **five tables without it**, and found the first by attacking it
rather than by reading:

| table | why it matters |
|-------|----------------|
| `player_daily_xp` | the weekly XP leaderboard's entire input. Granting `insert` to `authenticated` made PostgREST answer **HTTP 201** with `repeatable_xp: 999999` on the caller's own row |
| `wallet_ledger` | the append-only record every balance is reconciled against; `wallets` beside it has carried the trigger since the foundation migration |
| `rooms`, `room_members`, `matchmaking_queue` | a forged room, a forged seat at one, or a forged place in the queue |

Every function that writes any of them is `SECURITY DEFINER` — checked in
`pg_proc.prosecdef`, not assumed — so nothing legitimate changed. The other four
were found by asking the CATALOGUE which tables lack the trigger instead of
recalling which should have it, and `20_authorization_surface.test.sql` now asks
the same question on every run: any table in `public` outside the seven a client
genuinely writes must carry the guard. Proved by dropping one trigger and
watching the test name the table.

`tests/server/rls-writes.integration.test.ts` attacks the four leaderboard inputs
over HTTP with a real session token, plus `user_cosmetics` and the six
server-only functions behind them, so the refusals are measured rather than
inferred from the grants.

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

**TypeScript does not validate an attacker, so phase 10 sent the payloads
instead of reading the schemas.** Every one of these went to the live
`game-command` with a valid session token, and every one was refused 4xx —
never 5xx, which would mean it reached something that was not expecting it:

| Sent | Answer |
|---|---|
| `gameId: "not-a-uuid"` | 400 `INVALID_REQUEST` |
| no `clientActionId` | 400 `INVALID_REQUEST` |
| a `userId` field alongside a valid command | 400 `INVALID_REQUEST` (strict schemas reject an unknown key rather than stripping it) |
| `amount: -100` / `10.5` / `1e18` / `"NaN"` | 400 `INVALID_REQUEST` |
| `type: "ADVANCE"` — the engine's own cascade command | 400 `INVALID_REQUEST`; it is not in the request union at all |
| `type: "SETTLE"` | 400 `INVALID_REQUEST` |
| `expectedVersion: -1` / `1.5` | 400 `INVALID_REQUEST` |
| `expectedVersion: 999999` | not an error: `stale`, with the authoritative snapshot and nothing applied |
| `clientSentAt: "yesterday"` | 400 `INVALID_REQUEST` |
| a payload on a payload-free command | 400 `INVALID_REQUEST` |
| a JSON array, `null`, or a bare string as the whole body | 400 `INVALID_REQUEST` |
| a 32 MB body | 400 `INVALID_REQUEST` |

And over PostgREST, against the constraints rather than the application:

| Sent | Answer |
|---|---|
| a 500-character `display_name` | 400, `profiles_display_name_ch…` CHECK |
| a 300-character `username` | 400, the username CHECK |
| `display_name` of only spaces | 400, "display\_name must contain at least one visible character" |
| a `NUL` inside `display_name` | 400 `22P05` — Postgres refuses the escape; nothing stores a truncated name |
| a bidi override inside `display_name` | accepted and **sanitised**: the override is stripped by `sanitise_display_name` and the remaining text stored |
| `join_private_room('; drop table public.wallets; --')` | 200 with a null row — the same answer an unknown code gets — and `public.wallets` still there afterwards, checked rather than assumed |
| `search_players('%')` | 0 rows; a query under two characters returns nothing by design |
| `search_players('%_%')` | **0 rows.** The row here used to read "25 rows, the function's own cap", which was true and stopped being true in phase 11: `%` and `_` are escaped now, so the query is matched as the three literal characters and nothing has that handle. Re-measured against the running stack |

**The request body is bounded on what it RETAINS, not on what it is told.**
`MAX_BODY_BYTES` is 8 KB and `readJsonBody` reads the stream in chunks, counting
every byte and keeping none once the cap is passed — so no caller can choose how
much memory a Function allocates, and `content-length` is not consulted at all,
because a client controls it and there is no work to save by believing it. The
body is also **drained** rather than cancelled, which is not optional: a first
attempt that cancelled at the cap turned a 32 MB request from "HTTP 400 in 2.5 s"
into a 60-second stall and an HTTP 504, because the gateway in front buffers the
request and then waits for a reply that a blocked upstream write never lets it
collect. All three numbers were measured; draining without retaining has neither
problem, and the same 32 MB request is now refused in 0.7 s.

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
| player search | 30 / minute **and** 300 / hour | `search_players` |
| username change | 1 / 30 days | `guard_profile_username` trigger |
| display-name change | 5 / hour | `guard_profile_display_name_rate` trigger |
| game commands outside an active game | 30 / minute | `game-command` Edge Function |

An action may carry more than one policy — that is how "room creation per
minute/hour" is expressed without inventing two action names — and the tighter
window refuses first.

### What the search limit bounds, and what it does not

`player_search` was added in phase 11 beside the metacharacter escaping, and it
bounds **that function**: 108 calls of the form `%<c>`, `<c>%`, `_<c>` returned
0 accounts and 78 × `PT429`. It is worth being exact about what it does not do,
because the finding was written up as bounding a directory walk.

`profiles` carries a `SELECT` grant to `authenticated` and the
`profiles_select_visible` policy, so an authenticated caller can read the public
half of the directory straight from PostgREST without going through
`search_players` at all. Re-measured on this stack: one request returned **690
profiles in 68 ms**, carrying `id`, `username`, `display_name`, `bio`,
`avatar_url`, `country_code`, `level`, `xp` and the timestamps — and `anon` was
refused `42501`, because the grant is to `authenticated` alone.

That is the specification working rather than a hole: it asks for a searchable
directory and for global boards of "avatar, display name, value", and a player
nobody can find is a player nobody can befriend. A `private` or `friends-only`
profile is NOT in that answer — the policy requires `privacy = 'public'` or a
friendship — which is the distinction that matters, and it is the same one
`player_public_profile` draws for statistics. PostgREST's `max_rows` (1,000)
caps a single page; `offset` is not bounded, so the public directory is
enumerable by design and the limit above is not what stops it.

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
- `src/lib/supabase/config.ts` **refuses to start online play** if the value it
  was handed looks like one: an `sb_secret_`/`sbp_` prefix, a database URL, or a
  JWT whose decoded payload claims a role other than `anon` or `authenticated`.
  A leak that ships is not something a code review catches afterwards.
- The whole tree, the configuration, the scripts and the git history were swept
  in phase 10 for service keys, database passwords, JWT signing secrets, APNs and
  FCM credentials, API tokens, private keys and hardcoded passwords. **No real
  credential is present and none has ever been committed** — the only long
  secrets in the repository are the published Supabase local-development
  defaults (`iss: supabase-demo`, `postgres:postgres@127.0.0.1`,
  `super-secret-jwt-token-with-at-least-32-characters-long`), which are identical
  on every machine and useless against anything else, and they appear only in
  `tests/` and `scripts/`. `.env.local` is gitignored and has never been tracked;
  `.env.example` carries names with empty values.
- `npx expo config --type public` — what actually ships — carries the app name,
  the scheme, the icons, the plugin list and the "virtual chips" disclaimer. No
  key, no URL, no secret.
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

**A password-recovery code is not a session, and only GoTrue verifies it.**
`arc21://auth/recovery`'s `code` query parameter is a one-time PKCE
authorization code the client never inspects, decodes or trusts — it is handed
straight to `exchangeCodeForSession`, and the server rejects a used, expired or
mismatched one (`RECOVERY_LINK_INVALID`) rather than the client guessing at
its validity. `additional_redirect_urls` in `supabase/config.toml` lists this
exact string, not a `arc21://**` glob, so GoTrue itself refuses to redirect a
recovery flow anywhere else — the allowlist is what stops the link being
retargeted, not client-side handling of wherever it happens to land.

**The eight-character password minimum is enforced by the server.**
`src/features/auth/credentials.ts` has always stated eight and its own header
says it is "deliberately client-side only" and "not a security control" — which
was accurate and left the policy enforced nowhere, because GoTrue's default
`minimum_password_length` is six. A plain POST to `/auth/v1/signup`, or the
recovery flow driven by a modified client, set a six-character password on an
account carrying a competitive record and a friend list. `supabase/config.toml`
now says eight. Raising it affects passwords being SET, so no existing account
is locked out.

**Account deletion is total, and refuses for exactly one reason.** It is refused
while the caller still holds a seat — `active` or `disconnected` — at a running
table, because those seats hold escrowed chips. It is NOT refused for a seat the
player has already left, even at a table that is still running: `left` is
written only after `settleTableClosure` has returned the escrow. A lobby the
departing player hosts is handed to the longest-seated member through
`leave_room`, the one implementation of that rule, rather than deleted from
under the players in it. Shared history survives with `user_id` nulled AND the
seat's copied `display_name` replaced, because a foreign key anonymises the
reference and not the name beside it.

**The push sender is service-role only.** `send-notifications` reads other
players' notification titles and bodies by design, so a signed-in player's token
is refused as firmly as no token at all. The comparison against the service key
is length-checked and then constant-time.

**Permission is asked at a moment, never at onboarding.** The four moments are
enumerated in a union type; a grant switches on the master preference and the
moment's own category, and nothing else.

## Local storage

Stored locally: onboarding flag, preferences, audio/haptic settings, internal
offline identity, device Practice stats, the offline Practice session, cached strategy
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
