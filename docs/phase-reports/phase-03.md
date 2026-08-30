# Phase 3 — Supabase, migrations, authentication, account lifecycle, foundational authorization

Date: 2026-08-29 · Branch: `phase14-s2-security` · Preceded by phase 2 (PASS)

The database and the auth stack were **built** before this phase: 43 migrations,
453 pgTAP assertions, an authorization gate that refuses a wrong grant at
migration time, and a client that will not start if it is handed a server
secret. Most of it is right, and the parts that are right are right for stated
reasons rather than by accident.

What this phase found is that the **account lifecycle** — the one flow both app
stores require and the one flow nothing had exercised end to end — was broken in
four places, and that a fifth policy was stated in a comment and enforced
nowhere. Every one was reproduced against the running stack before it was
touched, and every fix has a regression **proved to fail when the fix is
removed**.

---

## A. Defects found and fixed

### A1. Account deletion failed outright for anyone who had played Quick Play

`join_matchmaking` makes whoever arrives first at a tier the host of the room it
creates — "the host by accident of arriving first", in its own comment.
`rooms.host_user_id` cascades from `auth.users`, so deleting that account deleted
the room. `matchmaking_queue.room_id` referenced `rooms` with **no `on delete`
clause**, so the SECOND player's queue row blocked the cascade:

```
ERROR:  update or delete on table "rooms" violates foreign key constraint
        "matchmaking_queue_room_id_fkey" on table "matchmaking_queue"
DETAIL: Key (id)=(669e9f84-…) is still referenced from table "matchmaking_queue".
CONTEXT: SQL statement "delete from auth.users where id = v_user_id"
```

PostgREST renders that as a 409 naming a constraint. `docs/PRIVACY.md` said
holding a live seat was "the only condition under which deletion is declined";
this was a second one, undocumented, and reached by playing one public table
with one other person in it.

**Reproduced** in `del-probe`: two accounts, `join_matchmaking('casual')` twice,
then delete. Fails every time.

### A2. …and deleting it evicted the other players from their table

Even where the cascade would have succeeded, it deleted a lobby other people were
sitting in, because its host had left. `leave_room` has always had the right
answer — migrate the host to the longest-joined member, close the room only when
nobody remains — and `delete_own_account` never called it.

It does now: `perform public.leave_room(v_room_id)` for each room the caller is
in, rather than restating the rule. After the fix the same probe leaves the other
player seated, still matched, and holding the lobby.

### A3. A departed seat kept the departed player's name

`game_session_seats.user_id` is `on delete set null` so a game other people
played is not deleted under them. `display_name` is a **copy** of the profile's
display name taken when the seat opened, and no foreign key touches it. So a
deleted account stayed named, by name, on every table it had ever sat at, visible
to every other participant through `game_session_seats_select_participant` — while
both the migration's own header and `docs/PRIVACY.md` said the row "no longer
identifies you".

Now anonymised to `Deleted player` before the delete, because afterwards there is
no `user_id` left to find the rows by. Notifications another player is holding
*about* the account (`data->>'from_user_id'`) are deleted outright: each names the
departing player in its body and deep-links to a profile about to stop existing.

### A4. Deletion was refused to a player who had already left

The guard counted every seat of the player's in an ACTIVE session — including
seats with status `left`, which are written only after `settleTableClosure` has
returned the escrow. So leaving a busy public table and then trying to delete
produced

```
ERROR:  leave your table before deleting your account
```

telling the player to do the thing they had just done, for as long as the other
players kept the table running. The predicate is now `seat.status <> 'left'`.
`active` and `disconnected` still refuse — a disconnected seat's chips are still
in escrow — and both are asserted.

### A5. A concurrent signup lost its account, with HTTP 500

`handle_new_user` asks whether a requested handle is taken and then inserts it,
and `not exists (select …)` answers against COMMITTED rows. Two signups a
millisecond apart both find it free; the second violates `profiles_username_key`,
which aborts the trigger, aborts the `auth.users` insert that fired it, and
answers the player:

```
500 {"code":"23505","message":"duplicate key value violates unique constraint
     \"profiles_username_key\"","detail":"Key (username)=(race_2c736cbd) …"}
```

**Measured through the real GoTrue: twelve concurrent pairs, twelve 500s, zero
recoveries.** Nothing had promised the handle — the very same function already
falls back to a derived one when the name is taken. The insert now catches
`unique_violation` on that ONE constraint and derives a fresh base; a duplicate
primary key is re-raised, because that means the account already has a profile
and is a real fault. Eight-way race after the fix: **eight accounts, eight
distinct handles, exactly one holder of the requested name.**

### A6. The eight-character password minimum was enforced nowhere

`src/features/auth/credentials.ts` sets `PASSWORD_MIN_LENGTH = 8` and explains
why. Its own header says the module is "deliberately client-side only" and "not a
security control" — both true, and together they left the policy stated in one
place and enforced in none, because GoTrue's `minimum_password_length` was 6. A
plain POST to `/auth/v1/signup` set a six-character password on an account
carrying a competitive record and a friend list.

`supabase/config.toml` now says 8. Verified against the running stack: 6 and 7
are refused `weak_password` — *"Password should be at least 8 characters"* — and
8 succeeds. Raising it affects passwords being SET, so no existing account is
locked out.

### A7. `private.career_drill_seeds` had no RLS

The two older private tables carry RLS with no policies — a deny-all that costs
nothing because `postgres` and `service_role` hold BYPASSRLS. The table added in
`20260823130000` did not. **Nothing was exposed**: the `private` schema grants
USAGE to no API role and is not in `[api] schemas`, and PostgREST answers
`PGRST205 Could not find the table` for it. But the barrier is meant to be two
deep, and nothing was asking. `assert_client_authorization_surface()` now refuses
a `private` table without RLS, the same way it already refuses a `public` one.

---

## B. What was checked and found correct

Not everything that was verified is a defect, and the negative results are the
point of an audit.

### B1. The client/server secret boundary

Three `EXPO_PUBLIC_` variables exist in the whole repository — `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `ENV` — and no other. `src`, `app` and `shared` carry
no service-role key, no `sb_secret_`, no connection string; the only matches for
those strings are inside `config.ts`'s own detector, which **refuses to build a
client** when handed one (`SERVER_SECRET_IN_CLIENT_BUNDLE`) and refuses plain
HTTP to a non-loopback host. `.env.local` holds only the published local
development defaults.

`service_role` holds **no grant on any table in this schema**, deliberately: the
Edge Functions connect to Postgres directly. Reaching for the service key over
PostgREST answers 403 with a hint suggesting you grant it, which is the opposite
of what this project wants — written into `account-lifecycle.integration.test.ts`
so the next person does not spend the same twenty minutes.

### B2. Migration integrity

`supabase db reset` applies all **44** migrations plus the seed from an empty
database, three times over this phase, exit 0 each time. `supabase db lint`
reports no schema errors across `extensions`, `private` and `public`. The
corrective migration is additive and self-verifying: its last line calls
`assert_client_authorization_surface()`, which is what CLAUDE.md requires of a
migration that changes a grant.

Both functions it redefines were taken from the **last** file to define them —
`handle_new_user` from `20260823150000`, the gate from `20260823190000`, checked
with `grep -l 'create or replace function public.<name>'` first, because copying
an earlier version silently reverts everything a later one added. The gate's live
definition was diffed against that file to confirm it before a line was changed.

### B3. The data model foundation

All 28 named domains exist, plus the private engine state:

`private.game_state_private`, `private.game_commands`,
`private.career_drill_seeds`.

Seven tables exist beyond the specified list, each because a domain needed
splitting rather than duplicating: `game_session_seats`, `career_attempts`,
`matchmaking_queue`, `player_daily_xp`, `player_decision_periods`,
`rate_limit_policies`, `rate_limit_events`. **No parallel duplicate of a
specified domain exists.**

### B4. Private versus public state

Four independent barriers, each verified against the running stack rather than
read:

1. `[api] schemas = ["public", "graphql_public"]` — `private` is not exposed.
2. The `private` schema grants USAGE to nobody: `nspacl` is `postgres=UC/postgres`
   alone.
3. Every table in it has RLS enabled with no policies (barrier 3 was A7).
4. A real authenticated token asking for it gets
   `PGRST205 Could not find the table 'public.game_state_private'`.

The daily-challenge seed is protected one level finer: `daily_challenges` has no
table-level grant at all, only **column** grants that omit `seed_secret`.
`has_column_privilege('authenticated', …, 'seed_secret', 'SELECT')` is false, a
`select=seed_secret` answers 403, and the gate asserts both directions.

### B5. Authentication, run against the real GoTrue

| Journey | Result |
|---|---|
| Sign up with a requested handle | 200, profile created with that handle, wallet funded 25,000 |
| Sign in, correct password | 200 with a refresh token, `expires_in` 3600 |
| Sign in, wrong password | 400 `invalid_credentials` |
| Sign in, no such account | **the identical** 400 `invalid_credentials` — no enumeration oracle |
| Token refresh | 200, refresh token rotated |
| Old refresh token, inside `refresh_token_reuse_interval` | accepted, as configured (10 s) |
| `GET /user` with the access token | 200, correct email |
| Password reset with the app's `redirectTo` | link carries `redirect_to=arc21://auth/recovery`, 303s to it with a PKCE `code` |
| Sign out, scope `local` | 204; the refresh token then answers `refresh_token_not_found` |
| Weak password | 422 `weak_password` |
| Anonymous sign-in | 422 `anonymous_provider_disabled` — guest is local, and correctly not a server identity |

**One false alarm, recorded because the shape of it recurs.** A hand-rolled probe
sent `redirect_to` in the JSON body and saw GoTrue fall back to `site_url`, which
reads exactly like a broken allow-list. It is not: `/recover` takes the redirect
as a **query parameter**, which is what supabase-js sends.
`password-recovery.integration.test.ts` — which drives the real SDK with
`flowType: "pkce"`, follows the real link out of Mailpit, exchanges the code and
signs in with the new password — was right all along. Verify the test before
believing the bug.

### B6. Auth storage

The persisted session holds a refresh token, which is a long-lived bearer
credential, and it goes to the platform keychain via `expo-secure-store` with
`WHEN_UNLOCKED_THIS_DEVICE_ONLY` — not to AsyncStorage beside the practice save.
Two implementation details are load-bearing and both are already right: values
are **chunked** at 650 UTF-16 units because iOS SecureStore fails above roughly
2 KB and a session with populated `user_metadata` exceeds it, and the adapter
**never throws**, because GoTrue awaits storage inside its own initialisation and
a rejected read there wedges the client with no session and no error. The
fallback when the native module is absent is deliberately **ephemeral** rather
than a silent downgrade to unprotected storage.

No password is stored anywhere; the sign-in and recovery screens hold it in
component state and nothing else. No raw token is logged.

### B7. Foundational RLS — the write half, which nothing had tested

`rls-idor.integration.test.ts` sweeps every client-readable table with a
stranger's token. It **reads**. Nothing in the repository asserted a DENIED case
for an INSERT, an UPDATE or a DELETE against somebody else's data — the three
verbs where a wrong policy does damage rather than leaking.

`tests/server/rls-writes.integration.test.ts` now covers all thirteen client
write grants with a second real token. Every case:

| Attempt | Answer |
|---|---|
| Rename yourself | 200, one row |
| Rename another player | 200, **zero rows** — `using` hides it |
| Set your own `xp`, `level` or `username_changed_at` | 403 — column grant, not policy |
| Insert or delete a profile | 403 — no grant exists |
| Insert a push token for another player | 403 `new row violates row-level security policy` |
| Update or delete another player's push token | zero rows; the row is unchanged afterwards |
| Forge a block as another player | 403 |
| Insert a loadout for another player | 403 |
| Insert any notification | 403 — `notify_user` is server-only |
| Mark or delete another player's notification | zero rows; still there afterwards |
| Send a friend request as somebody else | 403 |
| Accept your OWN sent request | 403 *"only the receiver may accept or decline a friend request"* |
| Delete a friendship you are not in | zero rows |
| Anything at all, unauthenticated | 401, every one |

**Two shapes of denial, and both are correct.** A write whose row would violate a
`with check` is refused outright. A write whose FILTER selects rows the `using`
clause hides matches nothing and answers 200 with an empty list — PostgREST
cannot refuse what it cannot see. Asserting 403 everywhere would have been wrong,
so every case checks the target row **afterwards** rather than trusting a status
code.

Coverage is complete by construction rather than by diligence: the gate refuses
any client write grant outside its fixed list of thirteen, so a fourteenth fails
`20_authorization_surface.test.sql` rather than slipping past this file.

Structurally: **35 tables in `public`, RLS enabled on all 35.** Only
`is_client_role` is executable by `anon` — a helper that reports the caller's own
role. `rate_limit_policies` and `rate_limit_events` are deliberately RLS-on,
policy-less and grant-less.

### B8. Anti-fake-completeness sweep

Nine directories, **470 files** reachable by grep — printed, per the zsh
word-splitting lesson, because a sweep that scans nothing prints reassurance.

**Zero** TODO, FIXME, HACK, "mock auth", "fake user", "placeholder profile",
"temporary RLS", "allow-all", or hardcoded credential anywhere. The one
`not implemented` is `signInWithProvider?`, an honestly optional interface member
for OAuth that has not shipped, declared so screens can feature-detect rather
than be rewritten. Every `service_role` mention in `src`/`app`/`shared` is a
comment explaining why the client cannot reach something.

---

## C. Two test defects found while writing the tests

Recorded because both are the kind that pass for the wrong reason.

**`11_delete_account.test.sql` warned against exactly what it did.** Its comment
says "a per-table assertion would silently miss a table added later without a
cascade" — and then names six tables. Sixteen migrations of new tables later,
nothing was checking notifications, push tokens, daily entries, tournament
entries, rooms, room members, the matchmaking queue, career attempts, blocks,
friend requests, friendships, per-mode statistics or the private drill seeds.
`23_account_lifecycle.test.sql` asks the **catalogue** for every cascading
reference to the account instead, so a table added tomorrow fails it with no
edit.

**A filter naming one column of a normalised pair is a coin flip.**
`create_friendship_on_accept` stores `(least(a, b), greatest(a, b))`, so
`friendships?user_id_a=eq.X` matched about half the time — and in the half where
it did not, the "a stranger cannot delete it" assertion passed because it named
no row, not because a policy stopped it. **Reproduced on purpose before fixing
it: seven failures in eight runs**, then zero in eight after
`or=(user_id_a.eq.X,user_id_b.eq.X)`.

---

## D. Every fix proved load-bearing

Each was reverted individually against the live database and the suite re-run.

| Fix removed | Test that fails |
|---|---|
| `seat.status <> 'left'` | 5 *"a player who has already left a still-running table may delete their account"* — `died: P0001` — and 6, 7, 8, 10 behind it |
| seat `display_name` anonymisation | 10 *"and the departed seat no longer says who sat in it"* |
| notifications-about-this-account cleanup | 13 *"a notification another player held ABOUT this account is gone with it"* |
| the `leave_room` hand-over | 14 *"the other player is still seated at the public table its host just deleted themselves from"* and 15 |
| `matchmaking_queue.room_id → on delete set null` | 16 *"a room deleted under a queue entry releases it rather than refusing to go"* |
| `handle_new_user`'s `unique_violation` retry | *"gives every one of eight simultaneous signups an account"* — five of eight answered with a server error |

**The FK change is asserted separately on purpose, and the report says why.** With
the hand-over in place a room is not deleted at all, so reverting the constraint
alone leaves every other assertion passing. That is precisely the shape of change
that rots unnoticed, so assertion 16 deletes a room directly — the only way to
ask the constraint the question.

---

## E. Commands run, with results

```
supabase db reset                 exit 0 · 44 migrations + seed, from empty, 3×
supabase db lint                  no schema errors (extensions, private, public)
supabase test db                  24 files / 469 tests · PASS   (was 23 / 453)
npx tsc --noEmit                  exit 0
npm run check:functions           all 3 Edge Functions typecheck
npm run lint                      0 errors, 37 warnings (unchanged)
npm run test:unit                 103 files / 2,017 tests · PASS
npm run test:server               15 files /   130 tests · PASS  (was 13 / 116)
                                  twice: once warm, once against a clean
                                  runtime after a full `db reset`
```

Auth journeys were additionally exercised by hand against the running GoTrue and
Mailpit; the results are the table in B5.

**Two server runs in between did NOT pass, and the reason is worth writing
down** — it is `docs/LAUNCH_STATE.md`'s known observation #1, reproduced by
accident. Both were started while the host's five-minute load average was still
above 25, decaying from the deliberate load experiment in §F.

* One run failed to COLLECT `notifications.integration.test.ts`: the stack
  guard's five-second probe fell inside a `CPU time soft limit reached` window
  and reported a healthy stack as absent — which is exactly the case the guard's
  own message enumerates.
* The next failed `accepts exactly one of twenty simultaneous commands` with
  `Test timed out in 90000ms`. Twenty concurrent requests to a local edge
  runtime that had logged **45 CPU soft-limit and 16 hard-limit events**.

Neither test touches anything this phase changed, and both pass on a quiet host
against a freshly launched `functions serve` — the run recorded above logged 21
CPU-limit events instead of 61 and went green. **`supabase functions serve` also
accumulates: restarting it before a full server run is worth the ten seconds.**
And a `docker restart supabase_edge_runtime_arc21` while `functions serve` is
running KILLS it (`container exited gracefully`), after which the gateway answers
503 and it reads as a broken stack.

---

## F. One observation assigned onward

**`tests/strategy/generated-table.test.ts` is load-gated, like Maestro.** Its
`beforeAll` re-solves the six-deck chart against a 180 s budget. It failed once
in this phase, in a full unit run started immediately after a container restart,
and passed on its own and in a clean re-run.

Rather than retry it and move on, the mechanism was reproduced deliberately —
one busy loop per core:

```
idle (load 5.8)     29.9 s
loaded (load 25)   149.7 s      ← 30 s under the 180 s budget
```

Above roughly load 30 it crosses the limit and fails with a hook timeout that
reads like a solver regression. **Nothing in this phase touches the solver or its
inputs.** The budget was chosen deliberately and is not being raised on the
strength of a loaded-host measurement; the finding is recorded in `CLAUDE.md`
beside the existing Maestro and benchmark load warnings, and the flake belongs to
**Phase 11**, which owns CI, where a shared runner is exactly the loaded machine
this describes.

---

## G. Phase 3 exit criteria

| Requirement | Evidence |
|---|---|
| Reproducible DB | `supabase db reset` from empty, 44 migrations + seed, exit 0, three times |
| Working account lifecycle | Sign-up, sign-in, refresh, sign-out, reset and deletion all run against the real GoTrue; deletion now total, and its five failure modes fixed |
| Safe client/server secret boundary | Three `EXPO_PUBLIC_` variables, no secret in `src`/`app`/`shared`, and a client that refuses to start when handed one |
| Real foundational RLS | 35/35 tables RLS-on; reads swept by `rls-idor`, writes swept by `rls-writes`, both with two real tokens; anon denied everywhere |
| Private game state not client-readable | Four barriers, all four verified against the running stack; `seed_secret` revoked at column level |
| Secure session persistence | Keychain via `expo-secure-store`, chunked, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, never-throwing, with an ephemeral rather than downgraded fallback |
| Clean relevant tests | pgTAP 469/469, db lint clean, tsc 0, functions typecheck, unit 2,017, server 130/130 |

**PHASE 3: PASS**
