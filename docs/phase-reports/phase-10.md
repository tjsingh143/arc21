# Phase 10 — Backend / API security

**Verdict: PASS.** 2026-09-02, against the live local stack, on a database reset
from empty.

Five defects fixed, each one measured before the fix and re-measured after, and
three of them proved to fail by reverting the fix in the running system. One
further finding is a launch-configuration item that cannot be validated without
SMTP credentials, and is recorded in `docs/RELEASE.md` with the exact settings.

**No known exploitable critical or high authorization or secret-exposure defect
remains.**

---

## The one-paragraph version

The authorization *shape* of this project was already very strong: a deploy-time
gate that refuses a migration adding an unexpected grant, RLS on every table, a
second `deny_client_write` lock underneath the server-owned ones, and a pgTAP
file that asks the catalogue rather than a list somebody maintains. What phase 10
did differently is that it **read rows and sent payloads** instead of reading
grants, with two real tokens against the running stack — and the two defects that
found are both the same shape: *a control that was asserted against an empty
fixture*. `tournament_entries` was readable by every authenticated account in the
system, 152 rows of `user_id`, live `chips`, `placement` and `prize_chips`, while
the IDOR sweep classified it "a stranger must see NONE of it" and passed because
its fixture never created an entry. And `service_role` — which the foundation
migration had deliberately stripped of every table privilege, with the reasoning
written out — still held `EXECUTE` on `apply_wallet_delta`, measured minting a
million chips through `/rest/v1/rpc/` in one request. Beyond those: a refused
32 MB request body was buffered in full before being refused; the app shipped a
**microphone permission** and an iOS background-audio mode for a game that never
records and explicitly disables background playback; and the Settings privacy
note claimed to control "your profile and standings" when a `private` profile is
still on the leaderboards by name, which the specification actually requires.

---

## Security findings

| # | Severity | Finding | Where | Disposition |
|---|---|---|---|---|
| **F-01** | **Medium** | `tournament_entries` readable by every authenticated account — measured at **152 rows** to a fresh second account, carrying `user_id`, live `chips`, `placement` and `prize_chips` for every entrant in the database. `sprint_standings` refuses a non-participant the same numbers with a `42501`. Contradicted `docs/SECURITY.md`, and `rls-idor.integration.test.ts` classified the table as OWNED and passed on an empty fixture | `tournament_entries_select_visible`, third clause | **FIXED** — clause dropped, `20260904120000`. Re-measured 152 → 0 for a stranger, 1 → 1 for the owner. Regression proved to fail by reverting in the running system, in two places |
| **F-02** | **Medium** (defence in depth) | `service_role` held `EXECUTE` on `apply_wallet_delta`. Measured: one POST to `/rest/v1/rpc/apply_wallet_delta` carrying nothing but the service key answered **HTTP 200** and moved a wallet from 24,450 to 1,024,450 | `20260813120200_wallets.sql` grant | **FIXED** — revoked, `20260904120000`. Now `HTTP 403 permission denied for function apply_wallet_delta`. `service_role` reaches nothing in `public` at all; the gate refuses a re-grant |
| **F-03** | **Low** | The build requested the **microphone** (`NSMicrophoneUsageDescription`, Android `RECORD_AUDIO`) and declared iOS `UIBackgroundModes: [audio]` plus two Android foreground-service permissions and a media-session service. `expo-audio`'s plugin defaults them on; the app never records, and `configureAudioSession` sets `shouldPlayInBackground: false` explicitly | `app.json` plugin entry | **FIXED** — the plugin is configured explicitly. Android permissions now `MODIFY_AUDIO_SETTINGS` only; both iOS keys gone from the introspected config and from the prebuilt project |
| **F-04** | **Low** | A refused request body was buffered in full first: a 32 MB body with a valid token was read into memory and then rejected, taking 2.5 s. This runtime retires workers on a memory or CPU limit | `_shared/http-json.ts` | **FIXED** — the stream is read in chunks and nothing past `MAX_BODY_BYTES` is retained, **while still draining**. Same request now refused in 0.7 s. The intermediate fix that cancelled instead is what taught the lesson: it turned the 400 into a 60-second stall and an HTTP 504 |
| **F-05** | **Low** | Settings said the privacy control governs "who can see your profile and **standings**". Measured: a `private` profile is still on `leaderboard_weekly_xp` by display name (4,242 XP, read by a stranger) and still findable by `search_players`. Both are the specification working | `STATS_VISIBILITY_NOTE` | **FIXED IN COPY, deliberately not in the boards.** The note now states what the column enforces and says out loud what stays visible. `tests/settings/privacy-copy.test.ts` pins it |
| **F-06** | **Low** | `/auth/v1/signup` answers **HTTP 422 `user_already_exists`, "User already registered"** for an address that already has an account — a user-enumeration oracle. Sign-in is already indistinguishable (byte-identical `invalid_credentials` for a wrong password and an unknown account) | GoTrue `enable_confirmations = false` | **DOCUMENTED, launch config.** It is a consequence of confirmations being off, which is itself a local-development value. `docs/RELEASE.md` now carries the four auth settings that must change, what each one buys and what was measured about it. Cannot be validated locally: it does nothing until real SMTP exists, which is an external blocker |

Nothing was found in the areas below, and each was checked rather than assumed —
the evidence is in the sections that follow.

---

## A. The trust boundary, item by item

Written out in full in `docs/SECURITY.md` under **"The trust boundary, item by
item"**, with the verification method beside each row rather than the intent.
Fifteen items: wallet, ledger, shoe, shoe index, hole card, game version, active
actor, legal actions, competitive statistics, career rewards, tournament state,
tournament placement, daily state and seed, leaderboards, cosmetic ownership.

**No insecure client-authoritative shortcut was found to remove.** Nothing in
`src` or `app` writes any of the above; `tests/wallet/no-write-path.test.ts`
scans four directories for the attempt rather than waiting for a behavioural test
to trip over it.

## B. Table-by-table database audit

**35 tables and one view in `public`, all of them, from the catalogue.** RLS is
enabled on every table; `assert_client_authorization_surface()` and
`20_authorization_surface.test.sql` both assert it, and the per-table audit in
`docs/SECURITY.md` is now correct about `tournament_entries`, which it was not.

The gate itself gained two rules and, separately, two breach tests it had been
missing: the sentence in `docs/SECURITY.md` claiming "each of those is proved to
FAIL when breached" was true of eight of the ten, because a view without
`security_invoker` and a grant with no policy behind it had never been breached
on purpose. All ten are proved now.

Grants as they stand: seven tables take a client write (`profiles` at column
level, plus `friend_requests`, `friendships`, `blocks`, `loadouts`, `push_tokens`,
`notifications`); the other twenty-eight are `SELECT`-only or unreachable. Every
grant has a policy behind it; two tables — `rate_limit_events`,
`rate_limit_policies` — deliberately have RLS with no policy and no grant, which
is deny-all stated plainly. The one view carries `security_invoker = true`, so it
cannot launder RLS.

**Mass assignment** is closed at two levels rather than one: `profiles` grants
`UPDATE` on six columns and a trigger refuses `level`, `xp` and
`username_changed_at` underneath; `notifications` grants `UPDATE (read_at)` and
its trigger compares the WHOLE ROW rather than a column list, so a column added
tomorrow is not silently writable. **Ownership reassignment** is impossible in
the six client-writable tables: every INSERT policy has a `with check` naming
`auth.uid()`, and every UPDATE policy has one on both sides.

Two things this audit noticed that grants alone do not show:

- **`ALTER DEFAULT PRIVILEGES` in `public` for `supabase_admin` grants `anon`,
  `authenticated` and `service_role` full table rights on anything that role
  creates.** That is stock Supabase and it does not bite here, because Arc 21's
  migrations run as `postgres`, whose default ACL in this schema was narrowed by
  `20260813120000_foundation.sql`. Worth knowing before anybody creates a table
  from the dashboard.
- **Five policies named the `PUBLIC` role** rather than `authenticated`. All five
  were harmless — `anon` holds no grant on those tables, so the policy is never
  consulted for it — and all five are now explicit, with the gate refusing a
  sixth. Same argument as `deny_client_write`: the first lock has been broken by
  accident sixteen times in this repository.

## C. RLS tests, allowed and denied

`tests/server/rls-idor.integration.test.ts` sweeps every client-readable table
with two real tokens. The filtered sweep it already had is now joined by an
**unfiltered** one, and that is the change that matters: the filtered form asks
"can a stranger see the OWNER's rows", which needs the owner to have a row before
it means anything, and that dependency is exactly what hid F-01. The unfiltered
form asserts **relationally** — every row that comes back must belong to the
caller — which is meaningful on a shared local database holding rows from
hundreds of accounts, and needs no fixture at all.

Covered by name: profiles and their private fields, friend requests, friendships,
blocks, room memberships, game sessions, seats and events, wallet, ledger, stats
(lifetime, per-mode, weekly XP, decision periods), career progress and attempts,
tournament entries, daily entries, cosmetics and loadout, push tokens, and
notifications. `tests/server/rls-writes.integration.test.ts` covers the write
half, including forging a leaderboard figure six ways.

The positive control for tournaments lives in
`tests/server/sprint-tournament.integration.test.ts`, where a real four-player
tournament exists: a competitor sees the whole field — which the format needs —
and a stranger sees none of it, three ways, and `sprint_standings` agrees with
the table rather than being stricter than it.

## D. Server-only state

Proved on a live table parked at PLAYER_TURNS with `holeCardRevealed: false`. The
authoritative row was read straight out of `private.game_state_private` **by
superuser psql, not through any client path**, and compared against everything a
client may read for that game. One run's transcript, verbatim — the shoe
position and the byte counts differ run to run because the cards do, which is the
point of running it against a live table rather than a fixture:

```
shoe 312 cards, nextIndex 8, 304 undealt; hole card down

PASS  create-session reply         1,125 bytes   undealt ids: 0   hole card: no
PASS  publicState at PLAYER_TURNS  1,372 bytes   undealt ids: 0   hole card: no
PASS  game_sessions row              497 bytes   undealt ids: 0   hole card: no
PASS  game_session_seats rows        346 bytes   undealt ids: 0   hole card: no
PASS  game_events rows             7,913 bytes   undealt ids: 0   hole card: no
PASS  player_actions rows              2 bytes   undealt ids: 0   hole card: no
PASS  hand_records rows                2 bytes   undealt ids: 0   hole card: no
PASS  hand_players rows                2 bytes   undealt ids: 0   hole card: no
PASS  control: 3 of the 8 DEALT card ids ARE visible in publicState
PASS  the hole card renders as {"hidden":true}
```

The control matters: without it every line above would also pass against a
comparison that never matches anything. Re-run after every fix in this phase and
again on the final database reset — the second run reached PLAYER_TURNS in one
step instead of three, with 308 undealt instead of 304, and answered the same
way.

The Daily Challenge seed is refused by the **privilege system** rather than
filtered by a policy, which is the difference between "you cannot read it" and
"you cannot read it directly". All four shapes measured, all HTTP 403:
`select=seed_secret`, `select=*`, `order=seed_secret`, and
`seed_secret=like.a*` — the last one being the blind oracle a filtering policy
would have left open. `private.game_state_private`, `private.game_commands` and
`private.career_drill_seeds` are unreachable; the schema carries no `USAGE` for
any API role, `service_role` included.

## E. Privileged database functions

114 functions in `public`. **Every `SECURITY DEFINER` function has an explicit
`search_path`** — asked of `pg_proc.proconfig`, zero exceptions. Exactly one
function contains dynamic SQL (`assert_client_authorization_surface`, over the
catalogue, with no client input) and no function anywhere interpolates a
parameter into SQL text.

`anon` may execute **one** (`is_client_role`, which reports the caller's own role
to the caller). `authenticated` may execute 61. `service_role` may now execute
**none**.

**Every parameterised function a client may execute derives identity from
`auth.uid()`** — of the 38 taking an argument, 34 reference it in their own body
and the other four are pure (`level_from_total_xp`,
`notification_data_is_safe`, `sanitise_display_name`, `username_is_permitted`).
None takes a user id it then trusts. Spot-checked by reading bodies as well as
counting: `mark_notifications_read(uuid[])` scopes its UPDATE to `user_id = v_me`
whatever ids it is handed; `retire_push_token(text)` likewise, so a guessed Expo
token cannot retire somebody else's device; `equip_cosmetic` re-checks ownership
in a trigger.

## F. Edge Functions

Three: `create-session`, `game-command`, `send-notifications`.

All three authenticate FIRST, before reading a body, and identity comes only from
`_shared/identity.ts` → `_shared/jwt.ts`. That verifier refuses `alg: "none"`,
refuses an algorithm the named key's own type does not match (the "alg confusion"
class), refuses a token whose `role` is not `authenticated`, checks `exp`, `nbf`
and `iat` against a stated 60-second skew, and never reads `sub` from an
unverified payload. Measured, all of it — see the table under H.

`send-notifications` is the exception and is right to be: it reads other players'
notification titles and bodies, so it authenticates against the service key with
a length check and then a constant-time comparison, and refuses a player's valid
session as firmly as no token at all.

Error handling returns a stable code from a closed union, a fixed sentence and a
request id. No SQL, no driver text, no stack frame and no echo of the input
reaches a client; the underlying error is written to the server log against that
request id and nowhere else.

## G. BOLA / IDOR

Every id the wire contract lets a client name, named by somebody else, against
the live functions: `gameId` (`CASH_OUT`, `RESET_PRIVATE_STACK`, and all twelve
`game-command` types), `roomId` (`START_PRIVATE_TABLE`, `JOIN_PUBLIC_TABLE`, and
the five room RPCs), `attemptId` (`SUBMIT_CAREER_DRILL`), `userId`
(`remove_room_member`, `invite_friend_to_room`), `tournamentId`
(`sprint_standings`). Every one refused 4xx, and — asserted rather than inferred
— the victim's stack, seat status, wallet and room membership were unchanged
afterwards.

Encoded as `tests/server/object-substitution.integration.test.ts`, which carries
a **control**: the owner does one of the same things and it works, so nothing in
that file is passing because the endpoint refuses everybody. There is also a
second fixture account in it, and the comment says why — one account cannot hold
both a solo table and a career attempt, because `assertNoOtherLiveSeat` correctly
refuses the second, and writing it the obvious way fails the FIXTURE while
looking like a broken guard.

Two refusal shapes are both correct and both accepted: a raised `PT404` ("you are
not at that table"), and an empty answer from a function that must not raise
because its rate limit has to survive the transaction — `join_private_room` is
the documented case.

## H. Runtime input validation

Sent, not read. Every payload below went to the live `game-command` with a valid
session token; the full matrix is in `docs/SECURITY.md` under **Input
validation**, and every case is now a test in
`tests/server/hostile-payloads.integration.test.ts` (35 assertions).

The rule each one is held to: **4xx, never 5xx** — a 5xx means the payload
reached something that was not expecting it — plus a code from the declared
union, a message ending in `(ref <uuid>)`, and no SQL, relation name, stack frame
or echoed value anywhere in the response.

Malformed UUID, missing property, unexpected property (a smuggled `userId` — the
one that would be an authorization bypass with extra steps), negative wager,
fractional wager, `1e18` wager, string wager, null wager, the engine's own
`ADVANCE`, an unknown command type, a command type that is an object, a negative
state version, a fractional one, a malformed timestamp, a timestamp with no
offset, a payload on a payload-free command, an unknown key inside a payload, a
prototype-pollution key, a JSON array, a bare `null`, a bare string, a bare
number, truncated JSON, an empty body, a non-JSON body, a wrong content type, a
9 KB body just over the cap, and a 32 MB body.

Over PostgREST, against the constraints rather than the application: a
500-character display name (400, CHECK), a 300-character username (400, CHECK), a
whitespace-only display name (400, "must contain at least one visible
character"), a `NUL` byte (400 `22P05` — Postgres refuses the escape rather than
storing a truncated name), a bidi override (accepted and **sanitised**, the
override stripped), `join_private_room('; drop table public.wallets; --')` (the
same null row an unknown code gets, and `public.wallets` still there afterwards —
checked, not assumed), and `search_players` with `%` and `%_%` (0 and 25 rows;
`like` metacharacters are data, not structure).

**A future `expectedVersion` is not an error**: it is answered `stale` with the
authoritative snapshot and nothing applied, which is the optimistic-concurrency
contract working.

## I. Secrets

Swept: the working tree, the configuration, every environment file, the generated
config, `scripts/`, `app.json`, `eas.json`, and the git history (47 commits) —
for service-role keys, database passwords, JWT signing secrets, APNs and FCM
credentials, API tokens, private keys, EAS secrets and hardcoded passwords.

**No real credential is present, and none has ever been committed.** The only
long secrets in the repository are the published Supabase local-development
defaults (`iss: supabase-demo`,
`super-secret-jwt-token-with-at-least-32-characters-long`,
`postgres:postgres@127.0.0.1`) — identical on every machine, useless against
anything else — and they appear only under `tests/` and `scripts/`, never in
`src`, `app` or `supabase/functions`. `.env.local` is gitignored and the only
`.env*` file ever tracked is `.env.example`, whose values are empty.
**No rotation is required.**

`src/lib/supabase/config.ts` remains the belt to that pair of braces: it refuses
to start online play if the value it was handed looks like a server secret — an
`sb_secret_`/`sbp_` prefix, a database URL, or a JWT whose decoded payload claims
a role other than `anon` or `authenticated` — and says so on screen rather than
failing oddly.

## J. Expo public config

`npx expo config --type public` — the thing that actually ships — carries the app
name, slug, description, version, scheme, colours, icons, the plugin list, the
platform blocks and the "virtual chips have no monetary value" disclaimer. **No
key, no URL, no secret.** The only two `EXPO_PUBLIC_*` values the app reads are
the Supabase URL and the publishable key, both public by definition.

The Android permission list changed here, and that was F-03: it read
`RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, FOREGROUND_SERVICE,
FOREGROUND_SERVICE_MEDIA_PLAYBACK` and now reads `MODIFY_AUDIO_SETTINGS` alone.
Two permissions remain that are not ours to remove and are accounted for:
`INTERNET` (obviously), and `READ/WRITE_EXTERNAL_STORAGE` carried by
`expo-file-system` with `android:maxSdkVersion="32"`, so they are inert on every
Android the app targets.

## K. Auth security

Measured against the real GoTrue rather than read off `config.toml`:

| Property | Result |
|---|---|
| Two devices hold independent sessions | yes |
| `signOut({ scope: "local" })` ends this device only | yes — the other device refreshed fine, HTTP 200 |
| …and the device that signed out cannot refresh | yes — HTTP 400 |
| A password change revokes a refresh token held elsewhere | **yes** — `refresh_token_not_found`. This is what bounds the `secure_password_change = false` setting |
| The 8-character minimum on signup | enforced — 422, "Password should be at least 8 characters" |
| …and on `PUT /auth/v1/user`, the recovery path | enforced — 422, same message |
| Wrong password vs unknown account | **byte-identical** `invalid_credentials` |
| Duplicate signup | **leaks** — 422 `user_already_exists`. F-06, launch config |
| A deleted account's refresh token | dead immediately, HTTP 400 |
| …and its unexpired access token | reads nothing — `[]` |
| Account deletion authorization | `delete_own_account()` takes no arguments and reads `auth.uid()` |

Token handling on the client: the session lives in the platform keychain through
`expo-secure-store`, chunked because a Supabase session exceeds iOS's ~2 KB limit,
with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` so it is neither iCloud-synced nor readable
while locked; the adapter degrades to "no stored session" rather than throwing,
because a rejected read inside GoTrue's initialisation wedges the client. The
client is PKCE, and the recovery code is handed straight to
`exchangeCodeForSession` — never inspected, decoded or trusted.

## L. Least privilege

Removed: `service_role`'s last privilege in `public` (F-02); the microphone,
background-audio and foreground-service permissions (F-03); and the `PUBLIC` role
from five policies. Nothing else was found to remove — every remaining grant has
a policy, every policy has a predicate, and no writable column is one the server
owns.

Not removed, with the reason: the four leaderboard functions take an unbounded
`p_limit`. PostgREST's `max_rows = 1000` bounds the answer (measured: a
two-billion limit returned 94 rows, which is every player with XP), and adding a
second bound means redefining four function bodies for no measurable gain.

**Legitimate flows re-verified after the hardening**, not assumed: the full
server suite (22 files, 294 tests) and the full pgTAP suite (25 files, 539
assertions) both pass on a database reset from empty, including a four-player
Sprint Tournament played to twelve hands with prizes paid, a two-client public
table, the career and daily flows, and the account lifecycle end to end.

## M. Logging and analytics

`_shared/structured-log.ts` takes a **closed TypeScript interface**, not a
`Record<string, unknown>` — so engine state is not an assignable value for any
field it accepts, and a shoe cannot be logged by accident rather than by
prohibition. The only place an underlying error's text is recorded is `logError`,
truncated to 500 characters, written server-side against a request id that the
client is given and the text is not.

There are **two `console.` references in the whole of `src`, `app` and `shared`**,
and both are comments. There is no analytics module at all — `ANALYTICS_WRITE_KEY`
is named in `.env.example` and read by nothing — so there is no second place for a
payload to leak. `postgres-client.ts` sets `onnotice: () => {}` so a Postgres
NOTICE cannot carry row values into a log.

## N. Dependencies and configuration

`npm audit` reports 19 flagged packages and **five distinct advisories**. Each was
traced to its actual dependency path rather than counted:

| Advisory | Path | Ships to a device? |
|---|---|---|
| `image-size` ×2 (**high**) | `react-native` → `@react-native/community-cli-plugin` → `metro` | **No** — the bundler |
| `@xmldom/xmldom` | `expo-splash-screen` → `@expo/config-plugins` → `@expo/plist` / `xcode` | **No** — `expo prebuild`, on a developer machine |
| `uuid@7` | `expo-splash-screen` → `@expo/config-plugins` → `xcode` | **No** — same |
| `decode-uri-component` | `expo-router` → `query-string` | **YES** — `getStateFromPath` parses incoming deep links with it |

So exactly one advisory is runtime-reachable, and it is the one worth thinking
about: a deep link is attacker-supplied input arriving through the OS.

Two things were measured rather than assumed. **The advisory's shape does not
reproduce at the installed version**: 20,000 bare percent signs decode in 0.63 ms
and 8–20 nested escapes in about 0.02 ms, against a URL length the OS bounds
anyway. And **the "fix" would break the app**: `decode-uri-component@0.5.0` is
`"type": "module"`, pure ESM, and `query-string@7` `require()`s it — forcing it
through an `overrides` entry would break deep-link parsing on device, silently,
in release. `npm audit`'s own suggestion is to downgrade `expo-router` across a
major version, which is worse.

**Disposition:** left alone, deliberately, per this phase's own instruction not to
force-upgrade Expo dependencies. Dynamic supply-chain verification → phase 11.

Security-sensitive configuration reviewed: `[api] schemas` exposes `public` and
`graphql_public` only — never `private`; `max_rows = 1000` bounds every response;
`db.pooler` is off; the four auth settings that must change at launch are now in
`docs/RELEASE.md`.

## O. Security regression suite

Everything above that could be encoded, was:

| File | New | What it holds |
|---|---|---|
| `tests/server/hostile-payloads.integration.test.ts` | **new**, 35 tests | Every malformed payload and every forged credential, over the wire, against the running functions |
| `tests/server/object-substitution.integration.test.ts` | **new**, 6 tests | The BOLA sweep: every nameable id, named by a stranger, with the victim's state read back and a control |
| `tests/settings/privacy-copy.test.ts` | **new**, 7 tests | The privacy note may not claim more than the column enforces |
| `tests/server/rls-idor.integration.test.ts` | strengthened | The unfiltered, relational sweep that would have caught F-01 |
| `tests/server/sprint-tournament.integration.test.ts` | +1 test | The positive half of F-01, at a real four-player tournament |
| `supabase/tests/20_authorization_surface.test.sql` | +7 assertions | The two new gate rules, each proved to FAIL on a deliberate breach; the two OLD rules that had no breach case (a view without `security_invoker`, a grant with no policy), so all ten are now proved; and the tournament policies asserted from the catalogue |
| `supabase/migrations/20260904120000_…` | **new** | The three fixes and the two new gate blocks |

**Each fix was proved to fail without itself, in the running system:**

- F-01, reverting the policy: `rls-idor` fails with *"tournament_entries answered
  151 row(s) belonging to somebody else (of 151 returned)"*, and
  `sprint-tournament` fails with *"a stranger read the entries of a tournament
  they are not in: expected [ …(4) ] to have a length of +0 but got 4"*.
- F-02, re-granting: the gate refuses with *"service_role can execute public
  function(s); it should reach nothing here: apply_wallet_delta"*.
- The `PUBLIC`-role rule, re-writing one policy without a `to` clause: *"policy/policies
  on a public table name the PUBLIC role rather than a client role:
  player_daily_xp.player_daily_xp_select_own"*.
- F-04, restoring the cancel-at-cap version: the 32 MB case answers **HTTP 504
  after 64 seconds** instead of 400 in 0.7 s.

---

## Gates — 2026-09-02, database reset from empty

```
npx tsc --noEmit                    exit 0
npm run check:functions             all 3 Edge Functions typecheck
npm run lint                        0 errors, 37 warnings (baseline unchanged)
npm run test:unit                 119 files / 2,366 tests PASS  (phase 9: 118 / 2,359)
npm run test:server                22 files /   294 tests PASS  (phase 9:  20 /   250)
supabase test db                   25 files /   539 tests PASS  (phase 9:  25 /   532)
npm run test:coverage              per-area gates pass, exit 0
npm run contrast:check             50 pairings, 0 failing
supabase db reset                  54 migrations applied from empty, exit 0
```

And the adversarial probe itself, re-run against the fixed stack:

```
59 probes pass, 0 fail, 5 informational
  D  server-only state           8/8
  C  cross-user reads            4/4
  G  object substitution        13/13
  H  input validation           21/21
  K  credentials                 8/8
  L  least privilege             2/2   (apply_wallet_delta: HTTP 403,
                                        "permission denied for function")
```

## What is NOT covered, and where it goes

- **Dynamic supply-chain testing** — the one runtime-reachable advisory above.
  → phase 11.
- **The four launch auth settings** cannot be validated without SMTP, which is
  blocked on a credential. → phase 12, documented in `docs/RELEASE.md`.
- **An unauthenticated caller sending a large body** still holds a gateway
  connection for 60 s and gets a 504. The Function answers 401 before reading a
  byte, which is the correct server behaviour; the connection is held by the
  gateway in front, and Supabase Cloud caps request size before a function sees
  it. Recorded rather than worked around. → phase 11 to confirm against a cloud
  gateway.
- **No penetration test by a third party has happened**, and none is claimed.
  `CLAUDE.md`'s eighth invariant stands: never claim an external audit or
  certification.
