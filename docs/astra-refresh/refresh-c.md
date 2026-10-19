# Astra Refresh C — AI Tables

**Current status: final independent verdict reported in the approved publication
handoff — `ASTRA REFRESH C: PASS`.** The handoff reports 439 server tests,
3,056 unit tests, 672 database assertions, 18 private-admission regressions and
63 migrations replayed. A complete prior audit hash manifest was not located
during publication, so no cryptographic comparison with that snapshot is claimed.

The implementation is published as `554defeb76c073703004bc10fa3c5ef8a63b88d2`
on `refresh-c-ai-tables`, with [PR #5](https://github.com/tjsingh143/arc21/pull/5)
open. It has not been integrated into `main` or deployed; Refresh D/E have not
begun. Integration validation and hosted CI are separate from the prior PASS.

**Historical implementation record:** the sections below retain the earlier
review findings, repairs and verification on their original terms. The October
14 independent review returned FAIL on C-1–C-4; the subsequent closure review
accepted C-2–C-4 but found the private-admission C-1 bypass. Sections 13–14 record
the repairs. Their awaiting-review and uncommitted Git-state statements describe
those checkpoints, before the final PASS and publication recorded above.

- **Starting commit:** `059ee0ba9b848254fecd024daae7e2a60be374aa`
  (`Fix Expo SDK 57 dependency compatibility`), then `main` = `origin/main`.
  The Refresh B checkpoint `2476511c55ea7122ce0eeffeaa87efd4e0e22b23` was
  verified to be its ancestor; `059ee0b` changes only `package.json` and
  `package-lock.json`.
- **Branch:** `refresh-c-ai-tables`, created from that commit; now published in
  PR #5, not merged.
- **Scope:** AI Tables as a first-class mode. Refresh A and B are complete and
  were not reopened; Refresh D (Home hierarchy) and E (release polish) were not
  begun. The only Play-surface change is one mode card and the screen it opens.
- `AGENTS.claude-backup.md` is the user's local file: untracked, unread, not
  staged, not modified.

---

## 0. What existed before

There was no AI, bot or computer-player code anywhere in `app`, `src`, `shared`,
`supabase` or `tests`. The only prior requirement is the specification's own
V1.1 note (`.spec-extracted.txt`, "COMPUTER PLAYERS"), which Refresh C follows
where it constrains and departs from only where the Refresh C brief is explicit:

| Specification (V1.1 "Table Ambience") | Refresh C |
|---|---|
| "explicitly labeled unranked" computer seats | Labelled `AI` from a server flag; unranked by an allowlist (§7) |
| "They draw from the same fair shoe" | Same CSPRNG shoe, dealt by the same engine (§2) |
| "They do not see hidden cards / do not know future cards" | Structural: the policy's only input is built from `PublicGameState` (§3) |
| "They do not manipulate the shoe" | A computer player can only send a command the engine accepts from a person (§5) |
| "Their betting uses bankroll/history only" | Flat table minimum; leaves when its stack cannot cover it (§4) |
| "a configurable probability of following basic strategy" and "possible personality profiles" (Steady/Bold/Learner) | **Not built.** The brief asks for one deterministic, directly testable policy and no difficulty levels or personalities; "possible" profiles are not a requirement. Recorded as deferred (§11) |
| "Ranked public multiplayer and ranked tournaments must not silently substitute bots"; "No hidden bots presented as humans"; "Never silently insert AI into a ranked public game" | Enforced in the DATABASE: an AI seat cannot be stored at any table but an AI table (§8) |

`docs/FINAL_RELEASE_REPORT.md` listed "optional, clearly labelled, unranked
computer seats" as deferred V1.1 work and its acceptance row "No fake human bots
— Nothing in the server seats a non-account". That row is historical and is not
edited; after Refresh C the accurate statement is: the server seats a non-account
ONLY at an `ai_table`, only flagged, only labelled, and the database refuses it
everywhere else.

## 1. What was built

An `ai_table` session: one person at the middle of three seats, with a computer
player either side, 5,000 table chips per seat, bets 20–500, Arc Standard rules,
no clocks, unranked, closed economy. Entered from a Play-tab card →
`/table/ai` → **Sit down** → the shared `/table/[gameId]` table. Computer players
act on the server inside the person's own commands.

Every figure is centralised in `shared/blackjack/rules.ts`
(`AI_TABLE_STACK`, `AI_TABLE_MIN_BET`, `AI_TABLE_MAX_BET`,
`AI_TABLE_SEAT_COUNT`, `AI_TABLE_PLAYER_SEAT_INDEX`, `aiTableRules()`); the
seat names ("AI Player 1", "AI Player 2") are generated in `create-session`.
Three seats was chosen as the smallest table that hands the turn from a computer
player to the person AND from the person to a computer player every hand,
within the 2–5 shape of the shared tables and readable on a phone. No
configuration UI was added.

## 2. How an AI seat is represented

| Layer | Field | Notes |
|---|---|---|
| Engine | `SeatState.isAi?: boolean`, `SeatSeed.isAi?` | Optional, set only when true, so a person's persisted seat is unchanged and old states load. `createGame` throws if an AI seed carries a `userId`. |
| Wire | `PublicSeat.isAi?: true`, `publicSeatSchema.isAi: z.literal(true).optional()` | Emitted ONLY on an AI seat. The contract is strict, so an always-present key would make every older client refuse every table; this way every existing table's payload is byte-for-byte unchanged. |
| Database | `game_session_seats.is_ai boolean not null default false` | `user_id` null, `buy_in` 0 (both CHECK constraints). A placement trigger confines AI seats to `ai_table` sessions and allows one person per AI table. |

**Why not `userId === null` or a name.** `SeatState.userId` is also null for a
Practice seat; `game_session_seats.user_id` is also null for a seat whose account
was deleted (`on delete set null`) — 101 such rows existed in the local database
when the migration was applied. A display name is free text a person chooses. The
UI labels a seat from `isAi` only; `tests/table/seat-presence.test.ts` asserts a
person named "AI Player 1" gets no label.

**The engine never reads the flag.** `tests/engine/ai-seat.test.ts` plays the
same scripted commands (bets, insurance taken and declined, every legal play by
rotation, 10–25 hands per seed, five seeds) on two tables differing only in which
seats are flagged, and requires every intermediate state (flag aside) and every
event to be identical. Mutation M5 (§10.3) — dealing AI seats out of the hand —
fails it.

No fake Auth user exists for a computer player; it holds no JWT, owns no wallet,
and `my_active_session()`, `findSeat`, statistics, XP, notifications and
cash-out all key on `user_id`, which an AI seat never has.

## 3. What a computer player can see

`supabase/functions/_shared/ai-seat-policy.ts`:

- `decideAiSeatAction(observation: AiSeatObservation)` — the policy's ONLY input.
- `observeAiSeat(table: PublicGameState, seatId, rules)` — the ONLY builder,
  taking the output of `toPublicState` (the project's single sanitisation
  boundary). It returns null for any seat that is not an AI seat.

An observation holds: the phase; the seat's own stack, staged bet, lock, sitting
out and connected flags; its own hands (ids, cards, status, `cameFromSplit`); the
active hand id when it is this seat's turn; the dealer's FIRST card if it is
face-up (the upcard; index 1 is the hole card and is never read); the legal set
the engine computed for the seat; and the published ruleset (a Fair Play claim,
readable by `anon`). Cards and the legal set are copied, so the observation holds
no reference into engine state. Other players' cards are public but unused by
basic strategy, so they are left out.

It does not contain — and has no type through which it could contain — the shoe,
`nextIndex`, undealt cards, the hole card, a random source, the player's balance,
level, history or anything about the person.

**Enforcement, four independent ways** (`tests/ai-table/ai-seat-observation.test.ts`):

1. **Shape.** The observation's keys (top level, seat, hand) are an allowlist.
   `observeAiSeat(engineState, …)` is a compile-time error (`@ts-expect-error`),
   and type-level checks assert `AiSeatObservation` has no `shoe`/`dealer`.
2. **Bytes.** Over every state of three ~300-hand scripted sessions (thousands of
   states, 200+ with a face-down hole card): `assertNoHiddenCardLeak` passes for
   every AI observation, and the hole card's id is absent by direct check — with
   a positive control that the seat's own card ids and the upcard id ARE present.
3. **Behaviour.** For every sampled state where an AI decision was taken with the
   hole card face down: replacing the hole card with a different undealt card, or
   reversing the order of every undealt card, yields an IDENTICAL observation and
   IDENTICAL decision (and the engine states provably differ).
4. **Source.** The policy file names none of `EngineState`, `BlackjackGameState`,
   `SeatState`, `DealerState`, `Shoe`, `RandomSource`, `CommandContext`, `.shoe`,
   `nextIndex`, `holeCard`, `createShoe`, `drawCard`, `applyCommand`, never
   indexes `dealer.cards[1]`, and imports only the engine barrel and the strategy
   advisor.

In production the driver also runs `assertNoHiddenCardLeak(observation, state)`
on every observation before the policy sees it, so a future widening fails the
command rather than informing a computer player. Mutation M4 (§10.3) — the
driver handing the policy the engine's hole card — is caught by that guard.

## 4. How a computer player decides

Deterministic, stateless, no randomness:

| Situation | Decision |
|---|---|
| Betting, nothing staged | `PLACE_BET` of `betBounds.min` (the table minimum), taken from the engine's own bounds |
| Betting, bet staged | `LOCK_BET` |
| Betting, stack cannot cover the minimum | `LEAVE` — the only legal way out of a round it cannot join; an AI table has no clock to sit it out |
| Insurance offered (including even money) | `DECLINE_INSURANCE` — basic strategy, and the shipped chart was solved with insurance always declined |
| Its turn | `adviseAction` — the SAME solved chart, keyed to `rulesetId@version`, that grades players and powers Learn/Analysis. No second chart exists. |
| Its turn, advisor returns null | `STAND` (`AI_SEAT_FALLBACK_ACTION`) — the engine's own documented default for an undecided hand, always legal on an active hand, one step to finish the turn |
| `HAND_COMPLETE` | Nothing. A computer player never sends `NEXT_HAND` |
| Sitting out / left | Nothing |

`cameFromSplitAces` is not on the public hand; it cannot change the answer for
an active hand (it only decides whether a split two-card 21 is a natural, and
that 21 is completed by the engine before any decision).

Proof (`tests/ai-table/ai-seat-policy.test.ts`): every two-card decision —
55 starting pairs × 10 upcards, 540 after the naturals — equals the GENERATED
TABLE'S cell (read directly, not through the advisor); three-card hands follow the
cell's fallback; an unsolved ruleset id and an H17 edit without a version bump
(`RULES_MISMATCH`) both stand; over 1,000+ sampled real states the policy answers
exactly when `aiSeatOwesDecision` says the table waits on the seat (totality),
only with offered actions (legality), and identically on clones (determinism).

## 5. How computer players act on the server

`supabase/functions/_shared/ai-seat-driver.ts`, called in the same transaction as
the command that needs it:

- `game-command`: after `applyCommand` of the person's command, if
  `seatsComputerPlayers(session.mode)` (only `ai_table`). Its events are appended
  after the person's; the idempotency record, the persisted state, the
  broadcast and `syncSeatRow` all describe the table as the person next finds it.
- `create-session` `OPEN_AI_TABLE`: after `startSession` (a no-op today, kept so
  "a stored AI table never waits on a computer player" has no exceptions).

Each decision takes **the person's path**: it is turned into the same
`GameCommandRequest` a client sends (with a fixed, never-recorded action id), run
through `assertCommandIsLegal` on authoritative state, translated by
`toEngineCommand`, and applied by `applyCommand`. An illegal AI decision is
refused with the same code a person would get (asserted: `WRONG_PHASE`,
`ILLEGAL_ACTION`, `INSURANCE_NOT_AVAILABLE`, `BET_ABOVE_MAXIMUM`,
`NOT_YOUR_TURN`), and `applyAiSeatDecision` refuses any seat that is not an AI
seat.

**When they are asked.** Insurance: at once. Turns: whenever it is theirs.
Betting: only once every connected, non-sitting-out PERSON has locked a bet
(`aiSeatsMayBet`, computed from the public snapshot). Two failure modes this
avoids: computer players locking first would let the last one DEAL while the
person was still choosing, and a person leaving during betting would otherwise
deal a hand to computers alone.

**Termination.** A computer player can never start a hand, so one drive is
bounded by one hand: ≤ 2 betting decisions (or 1 leave), 1 insurance answer,
3 splits and ≤ 10 decisions on each of ≤ 4 hands (a hand auto-completes at 21 or
a bust and every card adds ≥ 1 to its hard total) = 46 per AI seat.
`AI_SEAT_COMMAND_LIMIT_PER_SEAT` is 64; reaching it THROWS (`AiSeatDriverError`),
the whole command rolls back, and the table is left exactly as it was. If an AI
seat still owes a decision when the policy declines to make one, that throws
too. Both are bugs by construction, never refusals.

**Versions, retries, staleness.** Each accepted engine command still bumps the
version exactly once, so one person's command moves the version by
`1 + (AI decisions)`; clients already read `expectedVersion` from the latest
snapshot. A replayed person's command returns the stored response before the
driver is reached — the computer players never act twice. A stale version applies
nothing, the driver included.

**Timeouts.** None: like a solo table, an AI table carries no clock, because
nothing waits on the person but the person. `RESOLVE_TIMEOUT` is refused.

**Leaving, ending, resuming.** A computer seat never keeps a table open:
`settleTableClosure` counts only connected PEOPLE when deciding `sessionEnded`,
so the person leaving (CASH_OUT, or LEAVE through `game-command`) completes the
session. Mid-hand, CASH_OUT is refused `SESSION_BUSY` as everywhere. A killed app
finds the table through `my_active_session()` (mode `ai_table`) and the Play
resume card or `/table/ai`'s "Return to your AI table"; `OPEN_AI_TABLE` itself
answers a player already at an AI table with that table (`resumed: true`).

**Concurrency.** *(Rewritten by the C-1/C-2 repair, §13.)* `OPEN_AI_TABLE` first
takes the player's `seat_admission` advisory lock — the SAME lock every other
mode's admission takes, inside `assertNoOtherLiveSeat` — so a double tap, a
retried request or a Quick Play / Daily open sent at the same moment waits and
then finds the first. Then it answers a request id it has answered before from
`private.ai_table_open_requests`, closed table or not. The original text here
described a private `ai_table_open:` lock that serialised AI opens with each other
only; the audit showed that left a cross-mode race (C-1) and no replay protection
after closure (C-2).

**Cost.** Measured over 980 scripted hands in Node: 0.56 ms per AI decision,
~2 ms per drive, at most 12 decisions in one command.

## 6. Economy — closed

- `ai_table` is in `ALL_SESSION_MODES` and NOT in `WALLET_BACKED_MODES`. Every
  seat's 5,000 chips are created at the table, wagered there and destroyed with
  it: no buy-in, no ledger row, `escrow_chips` 0 for life, and
  `settleTableClosure` returns 0 for a closed economy whatever the stack.
- A person can win only from the house (the dealer); a computer player has no
  wallet. If an AI table's stack could reach a wallet, beating the dealer at a
  table whose chips were created for free would mint chips on demand.
- `FREE_STACK_RESET_MODES = ["private_table", "ai_table"]`: a person whose stack
  cannot cover the minimum may restart from the table stack between hands
  (`RESET_PRIVATE_STACK`, unchanged on the wire; the server reads the restored
  figure from the session's own mode). Never a wallet-backed mode.
- **Regression** (`tests/server/ai-table.integration.test.ts`): three real hands
  at the table maximum, then the person's stack set (fixture SQL) to 50,000 table
  chips — ten times the start — and cashed out: `returned: 0`, wallet unchanged,
  ledger unchanged, no ledger row referencing the game, session `completed`,
  `escrow_chips` 0. **Mutation S1** — `ai_table` added to `WALLET_BACKED_MODES` —
  fails it with `expected 50000 to be +0`.

## 7. Statistics and progression — none

- `SETTLEMENT_RECORDING_MODES` (new, `settlement-accounting.ts`) is an allowlist
  of every server mode that recorded hands before Refresh C — `solo`,
  `private_table`, `public_table`, `tournament`, `daily_challenge`, `career` —
  so their behaviour is unchanged and `ai_table` records NO lifetime statistics
  and NO repeatable XP (the weekly XP board's entire input). Until Refresh C the
  recording was unconditional, which would have made the first new mode count by
  accident.
- `ai_table` is in neither `GRADED_MODES` nor `ACCURACY_ELIGIBLE_MODES`: the
  person's decisions are not graded and do not reach the strategy board; the
  computer players' decisions are never recorded as anybody's.
- No tournament, daily, career, cosmetic or leaderboard path reads an AI table.
- **Proof:** after 30+ server-side commands of play, the person's `player_stats`
  reads `hands_played 0, chips_wagered 0`, `player_daily_xp` and
  `player_decision_periods` are empty, and `profiles.xp` is 0. **Mutation S3** —
  recording unconditionally — fails it with `hands_played: 11`.
- The Play card and `/table/ai` say so before a table opens: "Unranked. Hands
  here earn no XP and change no statistics, accuracy or leaderboard." Whether AI
  hands should ever count is a product decision, and the allowlist is where it
  would be made.

## 8. Database

**Forward migration `supabase/migrations/20261005120000_ai_tables.sql`** (no
existing migration edited):

- `alter type public.game_mode add value if not exists 'ai_table'`
- `game_session_seats.is_ai boolean not null default false` + column comments
- CHECK `game_session_seats_ai_seat_has_no_account` (`not is_ai or user_id is null`)
- CHECK `game_session_seats_ai_seat_has_no_buy_in` (`not is_ai or buy_in = 0`)
- `guard_ai_seat_placement()` + trigger `game_session_seats_guard_ai_placement`
  (`before insert or update of is_ai, game_session_id`): an AI seat only at an
  `ai_table`; one person per `ai_table`. Revoked from `public`, `anon`,
  `authenticated`.
- Ends with `select public.assert_client_authorization_surface();`. No client
  grant changed; `game_session_seats` stays server-written, participant-readable.

**A deployment-relevant finding in the migration's first draft.** It copied the
`commit; begin;` split `20260823130000_career_attempts.sql` uses around its enum
change. Applied with `supabase migration up --local` onto the existing database,
the CLI reported success while ONLY the enum label persisted: the column, both
constraints, the trigger and the migration-history row were rolled back. The CLI
sends a file as one batch whose Sync commits only an implicit transaction; the
`commit;` committed the label and the `begin;` opened an explicit block the batch
left open until the connection closed. The split was unnecessary (since
PostgreSQL 12 `add value` may run in a transaction; the label is only *used* in a
PL/pgSQL body parsed at first execution), so the file is now one transaction and
says why. The fixed file then applied forward over the existing 6,671 seats
(every one reading `is_ai = false`) with its history row. `20260823130000`
contains the same construct; it was NOT re-tested under `migration up` and is
recorded in §11 rather than touched.

pgTAP `supabase/tests/33_ai_tables.test.sql` (25 assertions): the column and its
default; an AI table seated as `openAiTable` seats it; an AI seat refused with an
account and with a buy-in; refused at a `solo`, `public_table`, `private_table`,
`tournament`, `daily_challenge`, `career` and `practice` session (one attempt
each); a person's seat cannot be relabelled; a second person refused; the
person's `my_active_session()` names the AI table; the person sees all three
seats; a stranger sees no seat, no session and no active session; a client
cannot write a seat; the guard is not executable by a client role; the
authorization surface is unchanged. `16_sprint_and_daily.test.sql`'s enum parity
assertion now lists `ai_table` — that assertion exists to fail until a new mode
is classified, and it did.

## 9. Product surface and client

- **Play tab:** one "AI Table" card (online badge; structure line derived from
  `AI_TABLE_SEAT_COUNT`). No other Play/Home change.
- **`app/table/ai.tsx`:** the terms (computer players marked AI, same shoe, see
  only their own cards and the upcard, basic strategy, table minimum), the table
  chips and band, "Unranked…", then **Sit down**. Resume card when the player is
  at an AI table ("Return to your AI table") or elsewhere (Sit down disabled,
  return offered). Unconfigured or signed-out → Practice and Connect, as Quick
  Play does.
- **`src/features/ai-table/ai-table-store.ts`:** `open()` sends
  `{ action: "OPEN_AI_TABLE" }` through `sendSessionIntent` (one request id
  across a lost reply, the confirmed player's pinned credential), maps
  `SESSION_ALREADY_ACTIVE` to "return to it below", refreshes
  `my_active_session()`. It never predicts or plays anything.
- **Shared table (`app/table/[gameId].tsx`):** other seats show an "AI" badge
  from `isAi` (accessibility label "Computer player"); every hand of another seat
  is drawn (split hands were previously hidden), each with "Bet N · Won/Lost N ·
  Push"; an AI seat waiting to bet reads "Bets when you deal".
- **Free reset offer:** `mayResetPrivateStack` now also recognises a connected
  seat that cannot stake (`canPlaceBet || canLockBet || betLocked` false) — the
  only shape a broke person takes at an AI table, which has no betting clock to
  sit them out. The same predicate serves private tables (offered without the
  15-second wait); the server's guard is unchanged.
- **Leave copy (correctness fix on the AI table's own path):** the confirmation
  said "N chips return to your balance" at every table. It now derives a
  `ChipDestination` from the session's mode: `wallet` (Quick Play, public —
  wording unchanged, and the two E2E flows asserting it are unaffected), `table`
  ("This table's N chips stay with it — nothing is added to your balance"), or
  `unknown` (no claim). The held-leave notice likewise only promises returning
  chips at a wallet-backed table. **Side effect, recorded deliberately:** this
  also corrects the same false promise at private, tournament, daily and career
  tables, because the copy is now derived from the economy instead of assuming
  every table is wallet-backed. `WALLET_BACKED_SESSION_MODES` /
  `FREE_RESET_TABLE_MODES` are client mirrors held equal to the server's lists by
  tests.
- `ACTIVE_SESSION_MODES` includes `ai_table` ("AI Table"; "You are still seated
  at your AI table…").

## 10. Tests and evidence

### 10.1 Added or materially changed tests

| File | What it proves |
|---|---|
| `tests/engine/ai-seat.test.ts` (new) | Flag carried/projected/refused with an account; reducer blind to it over five seeds of real shuffles |
| `tests/ai-table/ai-seat-policy.test.ts` (new) | Betting, insurance, 540 chart cells, fallbacks, never NEXT_HAND, totality, legality, determinism |
| `tests/ai-table/ai-seat-observation.test.ts` (new) | Hidden-information boundary: shape, bytes, behaviour, source |
| `tests/ai-table/ai-seat-driver.test.ts` (new) | Betting gate, both turn transitions, consecutive AI turns, split/double/surrender, insurance, natural, broke AI seat, person leaving, never NEXT_HAND, the person's path and its refusal codes, never acting for a person, the bound throwing, determinism, 3 × 60-hand lifecycle |
| `tests/ai-table/ai-table-store.test.ts` (new) | The client asks and nothing more; one request id across a lost reply; refusals mapped |
| `tests/helpers/ai-table-harness.ts` (new) | Preordered-shoe AI tables; the person's command applied as `game-command` applies it |
| `tests/contracts/ai-table-contract.test.ts` (new) | `OPEN_AI_TABLE` names nothing about the table; the reply carries no wallet fields |
| `tests/contracts/public-state-contract.test.ts` | An AI-seated snapshot (AI seat FIRST, so the key sweep sees `isAi`); `isAi` accepted only as `true` |
| `tests/progression/session-economics.test.ts` | `ai_table` classified closed; the only AI mode; reset modes never wallet-backed |
| `tests/progression/settlement-accounting.test.ts` | The recording allowlist; AI tables neither recorded, graded nor counted |
| `tests/table/{active-session,broke-affordance,leave-confirmation,seat-presence}.test.ts` | Client mirrors equal the server's lists; AI copy; generalised reset predicate; destination-aware leave copy; AI labels from the flag only |
| `tests/server/ai-table.integration.test.ts` (new; 15 tests — first recorded here as 14 — and 29 after §13) | Real stack: seating, RLS, AI acting in the person's command, many hands, no records, retry replay, stale, closed-economy mint regression, ending on leave, resume, one live seat both ways, six racing opens, reset |
| `supabase/tests/33_ai_tables.test.sql` (new, 25), `16_sprint_and_daily.test.sql` | Database refusals and reads (§8) |
| `tests/e2e/ai-table.yaml` (new) | Native flow (§10.4) |

### 10.2 Gates

*(Replaced at the C-1..C-4 repair, October 17, 2026, with what was actually run on
the repaired tree. Load is from `uptime` at the time.)*

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS — 0 errors, 21 warnings, all in files this work did not touch (the audit's count) |
| `npm run check:functions` | PASS — all three functions |
| `npx vitest run --exclude 'tests/server/**' --maxWorkers=2` | PASS — **153 files / 3,056 tests** (audit: 152 / 3,043; +1 file, +13 tests) |
| `COVERAGE=1 npx vitest run --coverage --maxWorkers=2` | PASS — 151 files / 3,030 tests, every per-area threshold met |
| `supabase test db` (local DB, no reset) | PASS — **33 files / 672 assertions** (audit: 665; +7 in `33_ai_tables`) |
| `npx vitest run tests/server/ai-table.integration.test.ts` | PASS — 29 / 29 (15 pre-existing, 14 added) |
| `npm run test:server` (fresh `functions serve`, load 10–15) | **NOT GREEN** — 31 of 38 files passed, **358 tests passed, 0 tests failed**; 7 files failed: six could not COLLECT (`stack-guard.ts:133`, the 5 s probe abandoned) and `stale-identity-push` failed in CLEANUP on GoTrue `504 Processing this request timed out` from `admin.deleteUser`. The runtime log for the run holds 124 CPU soft-limit and 2 hard-limit events; its one `INTERNAL` is a test's deliberately injected failure |
| the seven files above, `--maxWorkers=1`, no code change | PASS — 7 files / 66 tests |
| `npm run contrast:check` | PASS — 0 failing pairings |
| `npm run bundle:check` (two fresh `--clear` passes) | PASS — iOS Hermes bundle 6.5 MB |
| `npm run doctor` | **FAIL** 20/21 — 10 Expo SDK patch mismatches (e.g. `expo` 57.0.26 vs `~57.0.30`). `package.json`/lockfile are byte-identical to `059ee0b`; the expected versions moved upstream (`@latest`). Baseline dependency state, not a Refresh C regression; not changed here (dependency upgrades were out of scope) |
| `git diff --check` | PASS |

**Classification of the server-suite failure: environmental, with evidence, and
the gate itself is still recorded as not green.** Every failure is a reachability
probe or an auth-server timeout under load, the same signature the audit's own
full run had (two probe failures and a Realtime timeout, passing in isolation);
no assertion about product behaviour failed; and the same files pass when run
alone with no change. The broad suite was not re-run to chase a green result.
`supabase db reset` was NOT run (it would destroy the local data this session was
told to preserve), so the migrations' clean apply-from-empty was not repeated
here; `20261017120000` was applied forward with `supabase migration up --local`
and its history row and table checked afterwards.

### 10.3 Mutations (each must FAIL its tests)

| # | Protection removed | Result |
|---|---|---|
| M1 | Betting gate (AI seats bet before the person locks) | 6 driver tests failed |
| M2 | Observation gains a field (copied from the public snapshot) | Shape allowlist failed; the byte sweep could not fire because a public copy holds only the `{hidden:true}` placeholder — the structural guarantee working |
| M3 | Policy ignores the chart (always HIT) | 2 policy tests failed |
| M4 | Driver widens the observation with the ENGINE's hole card | Production leak guard threw; 8+ driver tests failed |
| M5 | Reducer deals AI seats out of the hand | Engine blindness test failed for all five seeds |
| M6 | AI tables record statistics/XP (allowlist) | 2 settlement tests failed |
| M7 | `ai_table` wallet-backed (unit) | 4 economy tests failed |
| S1 | `ai_table` wallet-backed (running server) | `expected 50000 to be +0` |
| S2 | Computer seats keep the table open (closure) | Session stayed `active`; LEAVE gave `HAND_COMPLETE` not `SESSION_COMPLETE` |
| S3 | `game-command` records unconditionally (running server) | `hands_played: 11` |

Every mutation was applied with a script that backs the file up, mutates one
exact anchor, runs, and restores; the restored code was re-run green (and the
Edge runtime re-served) afterwards.

### 10.4 Native evidence

*(Measured at the C-1..C-4 repair, October 17, 2026. iOS simulator only.)*

- **Build:** `LANG=en_US.UTF-8 npx expo run:ios --configuration Release --device
  <iPhone 17 Pro UDID> --no-bundler`, started 2026-10-18T00:45:10Z, `› Build
  Succeeded` and installed. The command exited 1 AFTER installing, on Expo's
  attempt to open a dev-client URL (`simctl openurl … exited with code 60`),
  which a Release build does not use.
- **Freshness:** the installed `main.jsbundle` is dated 17:51 local, after the last
  repaired source edit (17:15); and it CONTAINS the repaired C-4 sentence ("Finish
  your hand to leave — this table has no clock, so it waits for you.", stored by
  Hermes as UTF-16 because of the dash — one occurrence), with the existing
  "Bets when you deal" and "Leaving when this hand ends" as positive controls.
- **Device:** iPhone 17 Pro simulator; local Supabase stack with a fresh
  `functions serve`; `npx tsx scripts/e2e-account.ts` before each run; load 6–12.
- **`tests/e2e/ai-table.yaml`: PASS** — exit 0, 79 steps COMPLETED, 0 FAILED, on
  its fourth run. The three earlier runs, each diagnosed from its own failure
  screenshot: (1) the deal stopped at INSURANCE_OFFER (dealer ace) and the modal
  sheet hid "Bet 20" from the tree — a flow defect, fixed by answering the offer
  first; (2) `sign-in.yaml`'s `hideKeyboard` landed on "Email me a reset link" and
  the password never arrived — the recorded Maestro pitfall, untouched subflow;
  (3) the person's turn with the action dock BELOW THE FOLD, so `when: visible`
  never found Stand — fixed in the flow by scrolling to it (see the observation
  in §11).
- **`tests/e2e/ai-table-leave-mid-hand.yaml` (new, C-4): PASS** first run — exit 0,
  58 COMPLETED, 0 FAILED. Screenshot `ai-table-leave-held` shows the person's live
  hand (hard 20, Hit/Stand live) under "Leaving when this hand ends. Finish your
  hand to leave — this table has no clock, so it waits for you."; after Stand the
  held leave completed by itself and the app left the table, and the AI Table
  screen then offered Sit down with no table to resume (asked of the server).
- **Not native-verified:** C-3 (account switch during an open) — proved at the
  production store with controlled replies, not on a device; Android; a physical
  iOS device; hosted Supabase/Realtime. Screenshots and logs are in the session
  scratchpad, not the repository.

## 11. Deferred, not done, and observations

**Deliberately not built in Refresh C:** difficulty levels, personalities and the
specification's "possible" probabilistic profiles; any AI betting strategy beyond
a flat minimum; configuration UI (seat count, stakes); step-by-step pacing or
animation of computer turns (the table renders the server's snapshot per command
and plays the event batch's sounds; a hand where computer players act can
therefore move several steps at once — presentation work for D/E); AI tables
recording statistics or XP (a product decision for `SETTLEMENT_RECORDING_MODES`);
the Refresh D Home hierarchy.

**External, not software defects:** Android has not been built or run; physical
iOS devices, hosted Supabase deployment of the migration and functions, and
hosted Realtime behaviour are unverified here, as for Refresh A/B.

**Observations outside C, recorded and not changed:**

1. `20260823130000_career_attempts.sql` uses the `commit; begin;` split that
   rolled back this file's first draft under `supabase migration up` (§8). It has
   applied correctly in every local `db reset`; it was not re-tested as a lone
   pending file. Relevant to whoever first deploys the migrations to a hosted
   project.
2. `RESET_PRIVATE_STACK`'s "actually broke" guard reads the stack AFTER a staged,
   unlocked bet, and the reset leaves that staged bet in place — so a client that
   stages a bet larger than what remains can reset with the bet still staged.
   Closed-economy table chips only (private and AI tables); no wallet or record
   effect; the shipped client stages and locks together. Pre-existing; unchanged.
3. The advisory lock in §5 serialises AI-table opens with each other. The
   one-live-seat rule ACROSS modes is the pre-existing `assertNoOtherLiveSeat`,
   which reads without a shared lock in every mode; a race between two DIFFERENT
   modes' opens for one player was not examined. **→ The audit examined it and it
   was real (C-1); repaired in §13.**
4. No `create-session` action that opens a table is rate-limited (`OPEN`, daily
   replays and career attempts included — `rate_limit_policies` holds none of
   them). `OPEN_AI_TABLE` follows that posture rather than inventing a new one:
   one live seat per player bounds a player to one table at a time, so the cost of
   abuse is serial table creation, exactly as for Quick Play today.

**Known remaining Refresh C implementation blockers:** none known to the
implementing agent. This is not a verdict; the independent audit decides.
*(Historical: written before the audit, which then found four. See §13.)*

**Observations made during the repair, recorded and not changed** (outside the
four findings):

5. **The action dock can sit below the fold at an AI table.** On an iPhone 17 Pro
   simulator at default text size, three seats' hands and result lines push Hit /
   Stand off-screen at the person's turn, so the person must scroll to act.
   Presentation work for Refresh D/E; the native flows now scroll to the dock.
6. **Quick Play's held-leave wording** ("Leaving when this hand ends. Your chips
   come back automatically.") was left unchanged: it promises the chips, which is
   true, and asserts nothing about the hand finishing by itself, but a solo table
   has no clock either. `online-leave-mid-hand.yaml` asserts its prefix.
7. **`IDEMPOTENCY_CONFLICT`'s player-facing message** reads "That action id has
   already been used by another account" — written for game commands. For a
   request id reused across `OPEN` / `OPEN_AI_TABLE` by one account the code is
   right and the sentence is not; no shipped client can produce that request.

## 12. Files

Production: `shared/blackjack/{types,reducer,public-state,rules}.ts`,
`shared/contracts/{public-game-state,session-command}.ts`,
`supabase/functions/_shared/{ai-seat-policy,ai-seat-driver}.ts` (new),
`supabase/functions/_shared/{session-economics,settlement-accounting,close-table,structured-log}.ts`,
`supabase/functions/{create-session,game-command}/index.ts`,
`supabase/migrations/20261005120000_ai_tables.sql` (new),
`app/table/ai.tsx` (new), `app/(tabs)/play.tsx`, `app/table/[gameId].tsx`,
`src/features/ai-table/` (new),
`src/features/table/{active-session,broke-affordance,leave-guard,seat-presence,index}.ts`.
Docs: this file, `docs/ARCHITECTURE.md`, `docs/DATABASE.md`, `docs/SECURITY.md`,
`docs/ROUTES.md`, `docs/LAUNCH_STATE.md`, `AGENTS.md`, `CLAUDE.md`.

Added or changed by the C-1..C-4 repair (§13):
`supabase/functions/create-session/index.ts`,
`supabase/migrations/20261017120000_ai_table_open_requests.sql` (new),
`src/features/player/reset-player-state.ts`,
`src/features/table/{active-session,leave-guard,index}.ts`, `app/table/[gameId].tsx`;
tests `tests/server/ai-table.integration.test.ts`,
`tests/ai-table/ai-table-account-switch.test.ts` (new),
`tests/table/{leave-confirmation,active-session}.test.ts`,
`supabase/tests/33_ai_tables.test.sql`, `tests/e2e/ai-table.yaml`,
`tests/e2e/ai-table-leave-mid-hand.yaml` (new); docs this file,
`docs/{ARCHITECTURE,DATABASE,SECURITY,LAUNCH_STATE,RELEASE}.md`.

## 13. Independent audit (FAIL) and the repair of C-1 to C-4

**The audit.** An independent Astra audit of this tree (October 14, 2026, a
separate session; its report is not stored in this repository) ended
**`ASTRA REFRESH C: FAIL`**: one P1 and three P2 findings, plus the two
placeholders above. It is reproduced here in substance and is not overwritten.
The repair below was done by the IMPLEMENTING agent on October 17, 2026; it is
not a closure verdict. Each regression was run against the unrepaired code first
and failed, then passed against the repair; the server protections were then
each removed again (mutation) to show the new tests catch their absence.

### C-1 (P1) — concurrent AI and human admissions gave one player two live seats

- **Audit:** `OPEN_AI_TABLE` + `OPEN` (casual) sent together: both 200 in 5/5.
- **Independently confirmed root cause:** `assertNoOtherLiveSeat`
  (`create-session/index.ts`) is a read of COMMITTED seats followed, later in the
  same transaction, by the seat insert — check-then-insert. The only lock was
  `openAiTable`'s `ai_table_open:<user>`, which no other mode takes. Not specific
  to AI tables: every pair of modes shared the gap.
- **Repair:** `lockSeatAdmission(tx, user)` —
  `pg_advisory_xact_lock(hashtext('seat_admission:' || user))`, held to commit —
  is the FIRST statement of `assertNoOtherLiveSeat`, so every seat-taking path
  (`open`, `openAiTable`, `joinPublicTable`, `startDailyChallenge`,
  `startCareerNode`, `registerSprint`) takes it and none can be added without it.
  `open` and `openAiTable` also take it before their idempotency lookups, so a
  concurrent copy of ONE request still finds the first instead of being refused.
  Lock order: room row / daily row / sprint lock → admission → wallet everywhere;
  nothing holding the admission lock waits on the earlier ones, so no cycle.
  Database-level alternatives were rejected: a partial unique index cannot see the
  session's status, and a pending sprint entry is a seat with no seat row.
- **Regressions** (`tests/server/ai-table.integration.test.ts`, suite "C-1"): a
  DETERMINISTIC interleaving — a second connection holds the player's `profiles`
  row `for update`, which parks each admission at its first insert AFTER its
  check; the test waits until both requests are parked (directly, or behind the
  other's admission lock) before releasing. Four orderings (AI→Quick, Quick→AI,
  AI→Daily, Daily→AI): the first is seated, the second `409
  SESSION_ALREADY_ACTIVE`, one live seat, one session, no orphan, wallet and
  ledger exactly as one admission leaves them, `my_active_session()` names the
  winner. Plus: the other mode admits normally after the winner closes; five
  free-running races, alternating which is sent first.
- **Before:** all four interleavings `expected 200 to be 409`; free-running
  `expected [...] to have a length of 1 but got 2`. **After:** pass.
  **Mutation** (lock removed from `assertNoOtherLiveSeat` only): the AI↔Daily
  interleavings fail; the AI↔Quick ones stay green because `open`/`openAiTable`
  hold it themselves — which is why the lock lives in the shared check.

### C-2 (P2) — replaying the original AI-open after closure opened another table

- **Audit:** open → cash out → byte-identical replay → 200, NEW game, `resumed: false`.
- **Root cause:** `openAiTable` ignored `clientRequestId`; "the live AI seat you
  hold" was its only replay answer, and it disappears at closure.
- **Repair:** forward migration `20261017120000_ai_table_open_requests.sql` —
  `private.ai_table_open_requests (user_id, client_request_id) → game_session_id`,
  unique per player, no API-role grant, RLS on, cascading from `profiles` and
  `game_sessions`, ending with `assert_client_authorization_surface()`. Written in
  the answering transaction for a NEW table AND for a resume answer (a resuming
  request's delayed duplicate is just as able to open a table after closure). A
  recorded request is answered with its table as it now stands (`resumed: true`,
  `SESSION_COMPLETE` once closed) — the shape `describeExistingSession` gives a
  replayed Quick Play open — and seats nobody. A request id already spent on the
  other open action is `409 IDEMPOTENCY_CONFLICT` in both directions, before
  anything is charged. Scoped by the JWT's player. AI tables opened before the
  migration have no record (a mode that has never shipped).
- **Regressions** (suite "C-2"): the audit's exact sequence; live replay then
  post-closure replay; a resuming request's duplicate after closure; six
  concurrent copies → one table; a new request id after closure → a new table;
  another account's identical id → its own table and seat; cross-action reuse
  refused both ways with the wallet unchanged. pgTAP (`33_ai_tables`, +7): table
  exists, one record per player and id, per-account scoping, no API grants, RLS,
  unreadable by a client role, cascade with the table.
- **Before:** `expected '635dc53e…' to be '21d562cf…'` (a new game) and the
  cross-action case `expected 200 to be 409`. **After:** pass. **Mutations:**
  record not written at creation → the audit sequence and cross-action tests
  fail; not written on resume → the resuming-request test fails; early lock
  removed from `openAiTable` → both concurrent-copies tests fail with 409.

### C-3 (P2) — an account switch during an open left the next player's entry disabled

- **Audit:** `opening: true` survived the switch; B's `open()` returned null unsent.
- **Root cause:** `playerScopedSetter` correctly dropped A's late reply —
  including its `opening: false` — and `resetPlayerState()` reset Quick Play's
  equivalent flag but not the new AI store. No server defect: the request was sent
  with A's pinned credential, and `sendSessionIntent` returns `unknown` for a
  superseded player, so A's table was never handed to B.
- **Repair:** `resetPlayerState()` resets `useAiTableStore` (`opening: false,
  notice: null`), beside Quick Play. No timeout was added.
- **Regressions** (`tests/ai-table/ai-table-account-switch.test.ts`, new — the
  production store, `sendSessionIntent` and `resetPlayerState()`, replies released
  by hand): the audit's order (A's reply after the switch, then B opens: B's
  request is sent as `token-b` and B gets B's table, A's open resolves null);
  A's reply landing while B's own open is in flight (B's stays pending and is
  answered by B's reply only); A's late refusal; A's late transport failure (not
  retried as anybody); and a no-switch control.
- **Before:** 4 of 5 failed (`expected true to be false`, B's open never sent,
  `{ opening: true }`); the control passed. **After:** 5 / 5.

### C-4 (P2) — a mid-hand leave promised a completion the table could not deliver

- **Audit:** at `PLAYER_TURNS` with `deadlineAt: null`, CASH_OUT 409
  `SESSION_BUSY`, polls unchanged, RESOLVE_TIMEOUT 422, and the screen said "You do
  not need to do anything else."
- **Confirmed contract:** the held leave is completed by the poll at the first
  boundary `canCloseSeat` accepts, and the action dock stays live while it is
  held — so the existing, correct contract is "finish your hand, then you leave".
  Only the sentence was wrong, and it was wrong at every clockless closed-economy
  table (AI, daily, career), not only AI. No autoplay or timeout was invented.
- **Repair:** `UNTIMED_SESSION_MODES` / `handCompletionForMode` in
  `active-session.ts` (the modes `create-session` opens with `SOLO_TIMING` or
  `AI_TABLE_TIMING`, both null); `describeLeavingAtBoundary(destination,
  completion)` says "Leaving when this hand ends. Finish your hand to leave — this
  table has no clock, so it waits for you." where the person must finish, keeps
  "You do not need to do anything else." where a clock stands the hand (private,
  tournament), claims nothing before the mode is known, and leaves the
  wallet-backed wording unchanged.
- **Regressions:** `tests/table/leave-confirmation.test.ts` (copy per case, and
  that the screen passes the completion) and `tests/table/active-session.test.ts`
  (classification); server lifecycle in suite "C-4" — CASH_OUT 409 at the person's
  turn, three polls unchanged, RESOLVE_TIMEOUT 422 with the version unmoved, the
  session still `active`, then the person stands to `HAND_COMPLETE` and CASH_OUT
  returns 0 with the session `completed`, no live seat and the wallet untouched;
  native `tests/e2e/ai-table-leave-mid-hand.yaml` (§10.4).
- **Before:** the AI-table copy rendered "Leaving when this hand ends. You do not
  need to do anything else." (`expected … to match /finish your hand/i`).
  **After:** pass. The server-lifecycle test passed before and after: the server
  was already right.

### What remains before independent closure

*(Superseded by §14's list; kept as written on October 17.)*

1. A separate, bounded independent closure review of the repaired tree.
2. A green `npm run test:server` in one run (here: 0 failed tests but 7 files not
   collected/cleaned under load; all pass in isolation) — on an idle host or CI.
3. `npm run doctor`'s SDK patch drift — a dependency decision outside Refresh C.
4. A clean `supabase db reset` + `supabase test db` from empty, including
   `20261017120000`, where wiping the local data is acceptable (CI does this).
5. External, as before: Android, physical iOS, hosted migration/function deploy,
   hosted Realtime.

## 14. Closure review (FAIL on C-1) and the private-admission repair

**The review.** A separate independent closure review (October 18, 2026; its
report and probe log are not in this repository) returned
**`ASTRA REFRESH C: FAIL`** on one finding and accepted C-2, C-3 and C-4. That
verdict stands as recorded. The repair below was done by the implementing agent
and is not a closure verdict.

### C-1 (closure) — a private deal gave a seated player a second live seat

- **Review:** with no race at all, (A) a player at an AI table hosted and dealt a
  private table, and (B) another host dealt them into one: both requests 200, two
  live seats, `my_active_session()` naming only the private one.
- **Root cause (confirmed in source):** `startPrivateTable`
  (`create-session/index.ts`) inserts a `game_session_seats` row for EVERY
  `joined` member of the room and called neither `lockSeatAdmission` nor
  `assertNoOtherLiveSeat` for anybody. §13's repair put the lock inside the check,
  so it covered every path that seats THE CALLER; the private deal is the one
  path that seats people other than the caller, and it skipped the check. Not
  specific to AI tables: a Quick Play seat (with escrow) and a Daily attempt were
  bypassed the same way, and so was a second private room sharing a member (a
  player may be `joined` in several private lobbies).
- **Seat-creating paths, all traced:** `open`, `openAiTable`, `joinPublicTable`,
  `startDailyChallenge`, `startCareerNode`, `registerSprint` (pending entry) and
  `dealSprintTable` (seats the whole field) in `create-session`;
  `session-boundary.ts` and `syncSeatRow` only ever END a seat or copy engine
  state; no SQL function inserts seats. Only the private deal skipped admission.
- **Repair (`create-session/index.ts` only, no schema change):**
  1. After the room lock and the host/count checks, and before anything is
     written, `lockSeatAdmissions(tx, members)` takes every member's
     `seat_admission` lock, ordered by the lock key (`hashtext`) then the id. Then
     each member is checked by `assertNoOtherLiveSeat` under those locks. Any
     ineligible member throws `SESSION_ALREADY_ACTIVE` (internal detail names the
     member) and the transaction writes nothing: no session, no seat, no room
     change. No wallet is touched on this path, as before.
  2. **Lock order:** room row → every member's admission lock (global key order)
     → seat inserts. Single-player paths hold one admission key and never wait for
     a second, so they cannot close a cycle; two private deals request shared keys
     in the same order, so one queues behind the other. Ordering by the KEY, not
     by id alone, keeps that true when two ids hash alike.
  3. **Sibling, same function:** the room was read by id alone. It is now read
     `where … and mode = 'private_table'`, as `joinPublicTable` reads
     `mode = 'public_table'`. Before, a matched public room (joined members, no
     game yet) could be dealt as a private table by its first arrival, seating a
     matched stranger. Worse, the room stayed `public_table`/`active` while
     pointing at a `private_table` game, so the queue kept allocating its free
     seats: measured during this repair, when a pre-repair probe room was handed
     to `game-command.integration.test.ts`, whose player was debited 2,000 by
     `JOIN_PUBLIC_TABLE` and returned 0 by `CASH_OUT` (`expected +0 to be 2000`).
     Chips were destroyed, not minted. The three probe rooms were closed by hand.
  4. **Sibling, the shared check:** `assertNoOtherLiveSeat` read live seats and
     pending sprint entries in two statements, each with its own READ COMMITTED
     snapshot. `dealSprintTable` turns an entry into a seat in one commit without
     the entrants' locks (it holds the fourth registrant's, and taking more after
     it would break the lock order). A deal committing between the two reads was
     seen by neither. Now one statement answers all three questions (seat
     elsewhere, own seat, pending entry); the decision order is unchanged.
  5. Client: the lobby's start refusal now also says "nobody can still be playing
     at another table" (`src/features/rooms/rooms-gateway.ts`), so the refusal
     names something the host can do.
- **Regressions:** `tests/server/private-admission.integration.test.ts` (new, 18
  tests, real Edge Function + Postgres; seats asserted from
  `game_session_seats`/`game_sessions`, not only `my_active_session()`), with
  `tests/server/admission-barrier.ts` (new; §13's profile-row barrier, plus an
  advisory-lock holder and a `tournament_entries` holder). §13's C-1 suite is
  unchanged.
  - A, B: AI seat → private deal by self / by another host.
  - D: Quick Play → private (escrow stays the only money moved); Daily → private.
  - C/D: private seat → AI, Quick Play and Daily all refused, wallet untouched.
  - E: barrier interleavings in both orders for private vs AI, Quick Play and
    Daily (6); two private deals sharing a member; a deterministic deadlock probe
    (members seated `[x, y]` and `[y, x]`, a controller holding `x`'s lock); five
    free-running overlapping three-seat deals.
  - F/G: one of three members at an AI table → whole deal refused, nothing
    partial, the busy member's AI engine version unchanged; after that member
    cashes out, the same room deals all three.
  - H/I: stranger and non-host refused before the deal; host retry and member
    late tap land on the same game; one seat per member bound to that member's
    id, stack 5,000, buy-in 0, escrow 0; every seat bets and locks through its own
    JWT and the hand reaches PLAYER_TURNS / INSURANCE_OFFER / HAND_COMPLETE;
    every wallet stays at the 25,000 opening grant with only `initial_grant`.
  - Siblings: a public room refused (403 `NOT_A_PARTICIPANT`, room unchanged);
    a sprint deal committed between the two reads, then the admission refused.
- **Before (original bytes):** 15 of 17 failed (`expected 200 to be 409`;
  `[200, 200]` for the free-running pairs; `expected 200 to be 403` for the public
  room). The 2 that passed were the committed private → other-mode direction
  (the existing check already saw a committed private seat) and the ordinary
  table. The deadlock probe was added after the repair; it is proved by mutation.
- **After:** 18 / 18, in two consecutive runs. A third attempt did not collect:
  the stack guard's 5 s probe met a cold worker just after a CPU hard-limit
  retirement in `functions serve`'s log (environment, not product).
- **Mutations** (applied with a script, the file restored and SHA-256 checked
  after each, then served on a restarted runtime):
  - global lock order removed: the deadlock probe fails `[200, 500]` and the
    runtime logs `deadlock detected`; the free-running overlap test fails too;
  - only the CALLER checked: 9 tests fail, every case where the conflicting player
    is not the caller (B, Quick Play, the three "other mode first" interleavings,
    shared-member and overlap deals, F/G). The "private first" interleavings stay
    green because the locks are still held, which is correct;
  - room-mode filter removed: the public-room test fails `expected 200 to be 403`.
  - The two-statement check is the original code, so the before-repair run is its
    mutation: the sprint interleaving failed there with only `openAiTable` involved.

### Verification (October 18, 2026, local; load average 6–14)

| Gate | Result |
|---|---|
| `npx vitest run tests/server/private-admission.integration.test.ts` | 18 / 18 (twice; see above) |
| AI, private rooms, Quick Play, game-command, entry-response-loss, sprint, career, economy guards/authority, two-client, object substitution, rejection contract, account lifecycle, stale-identity table (14 files) | 217 / 218; the one failure was the probe room in item 3, and after closing it `game-command` passed 44 / 44 on a restarted runtime. A `twenty simultaneous commands` timeout, with 88 CPU soft-limit events on the accumulated runtime, also passed after the restart (9 events) |
| `npm run test:server` (one run, restarted runtime) | **39 files / 439 tests passed, exit 0** (70 soft-limit, 0 hard-limit events) |
| `npx tsc --noEmit` | clean |
| `npm run lint` | 0 errors, 21 warnings, none in a changed file |
| `npm run check:functions` | all three functions typecheck |
| `npm run test:unit` | 153 files / 3,056 passed |
| `npm run test:coverage` | 151 files / 3,030 passed; per-area thresholds met (exit 0) |
| `supabase test db` (existing local DB, not reset) | 33 files / 672 assertions, PASS |
| **Clean migration replay** | a SEPARATE disposable stack (`project_id = arc21replay`, own ports and volumes, studio/smtp/edge/analytics off) started from empty: **63 / 63 migrations applied**, `schema_migrations` identical to `supabase/migrations`, `private.ai_table_open_requests` present, then `supabase test db` **672 / 672 PASS**; the stack and its volumes were then removed. The existing `arc21` database was never reset |

**Native.** Not re-run. The only client change is one refusal sentence that no
Maestro flow asserts, and the accepted AI-table and mid-hand-leave evidence in
§10.4 does not touch it.

### What remains before independent closure

1. Independent reverification of C-1 as repaired here.
2. `npm run doctor`'s SDK patch drift — a dependency decision outside Refresh C.
3. External, as before: Android, physical iOS, hosted migration and function
   deploy, hosted Realtime.
4. Observed, not changed: `startPrivateTable` does not check `rooms.status` or
   `expires_at` before dealing (`joinPublicTable` does). It does not affect the
   one-live-seat invariant, which now holds whatever the room's state.

**Git state:** branch `refresh-c-ai-tables` at `059ee0b`, nothing staged or
committed. This repair added `tests/server/private-admission.integration.test.ts`
and `tests/server/admission-barrier.ts`, and modified
`supabase/functions/create-session/index.ts`,
`src/features/rooms/rooms-gateway.ts`, this file and the C-1 admission line in
`docs/{ARCHITECTURE,DATABASE,SECURITY}.md`. All other Refresh C work, and the
untracked `AGENTS.claude-backup.md`, are as they were.
