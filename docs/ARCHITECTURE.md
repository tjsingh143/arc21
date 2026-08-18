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
| Tests | Vitest (pure TS), RNTL (components), pgTAP (database), Maestro (E2E) |

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
