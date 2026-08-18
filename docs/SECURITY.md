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

## Row Level Security

RLS is enabled on every exposed table. Principles:

- `profiles` — public reads limited to safe fields per the privacy setting; users
  update only their own mutable fields; **`level` and `xp` are never
  client-writable**
- `wallets`, `wallet_ledger` — users may `SELECT` their own rows; no client
  `INSERT`/`UPDATE`/`DELETE` at all
- `friend_requests` — readable only by sender and receiver
- `game_sessions`, `game_events` — participants read sanitized state and public
  event payloads only
- **`game_state_private` — no client access whatsoever.** It lives in a
  server-only schema with no grants to the mobile roles, and holds the engine
  state including future shoe order
- `career_progress` — users read their own; all reward writes are server-controlled
- `cosmetics` — catalog readable; `user_cosmetics` acquisition server-controlled
- Leaderboards — public-safe materialized output only; never emails or account ids

Authorization is covered by automated tests, not assumed.

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

Supabase Auth's own limits apply to authentication. Application-level limits
cover friend requests per hour, room creation per minute and hour, room join
attempts per minute, matchmaking enrollments, profile rename frequency, and game
commands sent outside an active game.

Limits are named constants in configuration, not magic numbers scattered through
handlers.

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
