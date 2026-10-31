# Arc 21 — Architecture

## Principles

1. **One engine.** `shared/blackjack` is runtime-neutral TypeScript with no host
   imports. The client, the server and the tests use the same module. There is
   never a second implementation of the rules.
2. **The server is the authority for anything that matters.** Chips, shoe order,
   the hole card, competitive statistics and placements are decided server-side.
   A modified client must be useless by design, not by obscurity.
3. **Animation follows state.** The client renders authoritative events. It never
   invents a card, and animation is never the source of truth.
4. **Correctness before polish; fairness before engagement.**

---

## Stack

| Layer | Choice |
|-------|--------|
| App | Expo SDK 57, React Native 0.86, React 19.2 |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` |
| Routing | Expo Router |
| Animation | Reanimated 4.x, Gesture Handler |
| Client state | Zustand (small local/UI state) |
| Server cache | TanStack Query |
| Validation | Zod at every external boundary |
| Backend | Supabase — Postgres, Auth, Realtime, Edge Functions |
| Local storage | Expo SQLite; SecureStore for sensitive values |
| Tests | Vitest (logic, stores and source-contract checks), pgTAP (database), Maestro (native E2E) |

Native dependency versions are resolved with `npx expo install`, never pinned by
hand against an incompatible SDK. Development builds are used rather than Expo Go.

**Known caveat:** Expo SDK 57 reports increased Hermes memory usage when
importing Reanimated. Worklets bundle mode is the current workaround and must be
enabled, with memory measured on real devices.

---

## Repository layout

```
app/        Expo Router routes (tabs, game, career, social, settings…)
src/        Client implementation — components, design tokens, features, lib, state
shared/     Runtime-neutral domain: blackjack engine, strategy, contracts
supabase/   Migrations, seed data, database tests, Edge Functions
scripts/    Development tooling (strategy table generation, asset validation)
tests/      Vitest suites and fixtures
docs/       This documentation
```

`shared/blackjack` must never import from `src/` or `app/`.

---

## Authority boundaries

| Domain | Authority |
|--------|-----------|
| Practice cards and stats | Local |
| UI animation and sequencing | Client, derived from authoritative events |
| User preferences | Local, with selected cloud sync |
| Global wallet | **Server only** |
| Online shoe order | **Server only** |
| Dealer hole card | **Server only** until reveal |
| Online action legality | **Server** (re-runs `getLegalActions`) |
| Multiplayer timers | **Server** timestamps and deadlines |
| Competitive stats, career rewards | **Server** |
| Tournament state, leaderboards | **Server** |
| Daily challenge shoe | **Server** |
| Cosmetics ownership | **Server** |

Offline or client-authoritative results never affect global chips, competitive
leaderboards or ranked progression.

---

## Player identity (Refresh B)

Opening the configured app restores Supabase Auth or calls `signInAnonymously`.
Every online player has a real server UUID and the `authenticated` database role.
`is_anonymous` is Auth-owned classification, not client metadata. It describes
recoverability, not permission to play: public/private tables, Sprint, Daily,
Career, wallet, cosmetics, friends and notifications use the same authorization
for unlinked and secured players.

The Auth INSERT trigger allocates a unique filtered `word_word` handle, with a
numeric suffix on collision. `username` remains the canonical normalized handle;
`display_name` is the separately editable public presentation name, initially the
assigned handle. Existing players and their names are unchanged.

Optional securing is `updateUser({email})` → email-change OTP verification →
`updateUser({password})`. The UUID never changes. OTP verification uses an
unpersisted SDK client, compares the verified UUID with the current player, and
only then adopts the returned session. A conflict with an existing email is a
refusal, never a merge. OAuth providers are not configured or offered in this
phase; any future OAuth path must use supported identity linking and preserve
these same UUID checks.

Auth mutations remain serialized after a UI timeout. Queued intents that expire
before starting are discarded. Human CAPTCHA time is outside the network
request deadline. Local expected-player guards prevent a queued delete, login,
or credential change from acting after another identity replaces the session.
Keychain writes use two chunk generations and an atomic manifest switch, with
backward reads of the previous storage format. The SDK owns refresh and tokens;
Zustand holds only a non-secret identity snapshot.

The app renders before network authentication. SQLite Practice, local settings,
learning and offline Career practice survive outages and the transition from an
old device-local identity. No local chips, XP, competitive results or achievements
are uploaded. Foreground and network-restoration events can resume failed
connection attempts; cancellation, a rate limit, or an intentional sign-out
requires an explicit Connect action. Server data caches clear when the UUID
changes; old asynchronous replies cannot refill them. Economic response-loss
retries retain both the same intent ID and the original session credential.

Unlinked players have no cross-device recovery promise. Sign-out and replacement
by sign-in/recovery warn before losing access. Profile offers optional securing
without interrupting play. Deletion keeps its existing server-owned cleanup and
active-seat restrictions. A later cold launch creates a new player, never
resurrects the deleted identity.

Presence is now a bounded friend-only RPC projection from verified heartbeats
and server seat state. The global client-authored Realtime roster is denied.
Full decisions and evidence are in [Refresh B](./astra-refresh/refresh-b.md).

---

## Home and Play (Refresh D)

`src/features/home/product-hierarchy.ts` defines the modes, entry routes,
participant types, chip stakes and recording claims shared by both tabs.
`tests/home/product-hierarchy.test.ts` checks those claims against the server's
wallet, settlement and accuracy allowlists; display copy does not grant access.

The order is Play for chips (human tables first, then solo modes), AI Tables,
and Practice and progress. Home shows a held-seat return before new tables and
refreshes it on focus for the confirmed player. Player-scoped setters discard
late replies after an account change. A failed lookup is shown as unknown,
not as evidence that no seat exists.

Without a confirmed player and reachable server, Home leads with offline
Practice and explains the connection state. Play retains its mode catalogue
with an availability notice. Setup screens and the server still enforce entry
requirements. Home cards contain separate buttons; Play cards are single
labelled controls. At larger text sizes, headers and link rows stack vertically.
See [Refresh D](./astra-refresh/refresh-d.md) for native evidence and the
remaining physical-device VoiceOver gap.

---

## The engine

`applyCommand(state, command, context) → { state, events }`

Pure. Illegal commands throw a typed `EngineError` and leave the input state
untouched, so there is no partial mutation to roll back. One accepted command
increments `version` exactly once.

Transitions requiring no player input — dealing, peeking, dealer play,
settlement — run automatically inside a single command via `cascade`, stopping at
the next phase that awaits a decision. This is why a single `LOCK_BET` can emit
the entire deal-through-settlement event sequence when no player decision is
needed.

### Phases

```
SESSION_READY → BETTING_OPEN → BETTING_LOCKED → INITIAL_DEAL
                                                     ↓
                          ┌─── dealer ace? ───→ INSURANCE_OFFER
                          │                          ↓
                          └──────────────────→ DEALER_PEEK
                                                     ↓
                                    dealer natural? ─┴─→ PLAYER_TURNS
                                          ↓                   ↓
                                    DEALER_REVEAL ←───────────┘
                                          ↓
                                     DEALER_TURN → SETTLEMENT → HAND_COMPLETE
                                                                      ↓
                                                                BETWEEN_HANDS
                                                                      ↓
                                                                BETTING_OPEN
```

`PLAYER_TURNS` owns a seat cursor and a per-seat split-hand cursor. The cursor is
re-derived on every cascade pass, which both advances past completed hands and
handles first positioning when the deal skipped the peek entirely.

### Legal actions

`getLegalActions(state, actorId)` is the single authority. The client renders its
controls from it; the server independently re-runs it before accepting any
command. **A hidden button is a UI convenience, never a security boundary.**

---

## Server command model

Blackjack is turn-based and low-frequency, so authoritative state lives in
Postgres and each command is one transaction. Edge Functions are stateless
invocations — a game room must never live only in Function memory.

```
CLIENT ──authenticated GameCommand──▶ EDGE FUNCTION
                                            │
                                    transaction / RPC
                                            ▼
                                  POSTGRES (authoritative)
                                    ├── wallet ledger
                                    ├── game state (private schema)
                                    ├── event log
                                    └── stats / progression
                                            │
                                            ▼
                                    REALTIME BROADCAST
                                            │
                                            ▼
                                     ALL TABLE CLIENTS
```

Per command:

```
BEGIN
  authenticate (identity from the session, never from the payload)
  validate payload (Zod)
  verify room membership
  SELECT authoritative state FOR UPDATE
  if clientActionId already applied → return the first committed result
  if expectedVersion != current      → return STALE_VERSION + current snapshot
  verify phase, actor, action legality, stack and bet
  apply the shared engine command
  apply wallet / session / stat deltas
  increment version, append public events, persist private state
  record the idempotency result
COMMIT
broadcast the sanitized public snapshot
```

No partial settlement is permitted. A duplicate `clientActionId` is harmless; a
stale version returns the authoritative snapshot rather than applying anything.

### Timers without a long-lived process

The server stores an absolute `deadline_at`; clients render countdowns against
server time. At expiry any connected client may request `RESOLVE_TIMEOUT`, but
only the server's own clock authorises the transition, and the first accepted
request wins transactionally. Correctness never depends on a client's clock.

Defaults are deliberately predictable — **stand** for an active hand, **decline**
for insurance, the staged or minimum bet for betting. The engine never plays
basic strategy on an absent user's behalf: doing so would silently alter both
their chips and their recorded decision accuracy.

### AI Tables (Refresh C)

An `ai_table` session seats one person between computer-controlled seats
(`AI_TABLE_*` in `shared/blackjack/rules.ts`: three seats, the person in the
middle, 5,000 table chips each, bets 20–500). A computer player is a
PARTICIPANT, never an authority: it is dealt from the same CSPRNG shoe, offered
the same `getLegalActions`, and settled by the same engine as anybody else.

- **Representation.** `SeatState.isAi` (engine), `PublicSeat.isAi` (wire,
  present only when true so every other table's payload is unchanged), and
  `game_session_seats.is_ai` (database). An AI seat never carries an account:
  `createGame` refuses it and so does a CHECK constraint. The engine never READS
  the flag — `tests/engine/ai-seat.test.ts` plays identical hands with and
  without it and requires identical states and events.
- **What a computer player sees.** `decideAiSeatAction` takes an
  `AiSeatObservation` and nothing else, and the only builder of one,
  `observeAiSeat`, takes the `PublicGameState` that `toPublicState` produced: the
  seat's own cards and stack, the dealer's upcard, the engine's legal set and
  the published ruleset. Never the shoe, the hole card or a random source. The
  driver also runs `assertNoHiddenCardLeak` on every observation in production.
- **How it decides.** Flat table-minimum bets; insurance and even money
  declined; every play from `adviseAction`, the same solved chart that grades
  players; STAND where the chart is silent; never `NEXT_HAND`.
- **When it acts.** Inside the person's own command transaction
  (`_shared/ai-seat-driver.ts`, called by `game-command` after `applyCommand`):
  computer players stake once every person has locked, answer insurance at once,
  and play their turns until the table waits on the person, rests at
  HAND_COMPLETE, or ends. Each decision goes through `assertCommandIsLegal`,
  `toEngineCommand` and `applyCommand` — the person's own path — and bumps the
  version once. One command can therefore carry several AI decisions, all in one
  event batch, one idempotency record and one broadcast; a replay returns that
  record and never re-runs them. A drive is bounded by one hand (≤ 46 decisions
  per AI seat) and throws at 64, rolling the command back.
- **Economy and records.** Closed: no buy-in, no ledger row, `escrow_chips` 0,
  and `ai_table` is absent from `WALLET_BACKED_MODES`, so a cash-out returns
  nothing. A computer seat never keeps a table open, so the session ends when its
  person leaves. AI tables record no statistics and no XP
  (`SETTLEMENT_RECORDING_MODES`) and are neither graded nor counted for accuracy.
  A broke person may reset to the table stack between hands, as at a private
  table.
- **No clocks.** Like a solo table: nothing waits on the person but the person.
  So a leave asked mid-hand is held until the PERSON finishes the hand, and the
  table says exactly that (`UNTIMED_SESSION_MODES`, audit C-4).
- **Admission.** Every seat-taking path in every mode takes the player's
  `seat_admission` advisory lock in `assertNoOtherLiveSeat`, so an AI table and
  another table opened together cannot both seat the player (audit C-1). A
  private deal seats every member, so it takes EVERY member's lock, in one global
  order, and checks each under them; one ineligible member refuses the whole
  deal (C-1 closure finding, Refresh C §13). Each
  `OPEN_AI_TABLE` request id is recorded in `private.ai_table_open_requests`, so
  a replay — even after the table has closed — is answered with its original
  table and opens nothing (audit C-2).

The full record — decisions, evidence, deferrals — is
[Refresh C](./astra-refresh/refresh-c.md).

### Realtime ordering

Events carry a monotonic `seq`. Clients track `lastAppliedSeq`:

- `seq <= lastAppliedSeq` → duplicate, ignore
- `seq == lastAppliedSeq + 1` → apply
- `seq > lastAppliedSeq + 1` → gap, fetch an authoritative snapshot

---

## The sanitisation boundary

`toPublicState` is the **only** function permitted to produce a payload for
Realtime, API responses, client caches, logs or analytics. It must never emit
future shoe order or the unrevealed hole card — which is precisely why nothing
may serialise `BlackjackGameState` directly.

The hole card is replaced by a `{ hidden: true }` placeholder rather than
omitted, so the client can render a face-down card without receiving its
identity. Dealer totals before reveal are computed from face-up cards only.

`assertNoHiddenCardLeak` verifies a serialised payload against the authoritative
state and is wired into the test suite, so a future refactor that widens the
public shape fails loudly instead of leaking silently.

---

## Randomness

`RandomSource` is injectable:

| Source | Use |
|--------|-----|
| `CryptoRandomSource` | Production — Web Crypto, local and server |
| `CounterStreamRandomSource` | Daily Challenge — reproducible from a secret seed |
| `SeededTestRandomSource` | **TEST ONLY** — deterministic fixtures |
| `createPreorderedShoe` | **TEST ONLY** — exact card sequences |

The production source throws on construction if no CSPRNG is available rather
than degrading. A quietly weak shuffle is exactly the defect this product
promises does not exist.

---

## Scaling assumption

Transaction-per-command plus Supabase Realtime is appropriate for an initial
production release of a turn-based game, and must be load-tested before high
concurrency. Because the engine is pure and the command contract is explicit,
both are portable to a dedicated stateful game server if measured contention or
regional latency ever justifies it.
