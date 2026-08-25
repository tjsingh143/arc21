# Phase 2 — Offline Practice, learning modes, strategy, local persistence, Practice stats

Date: 2026-08-24 · Branch: `phase14-s2-security` · Preceded by phase 1 (PASS)

Practice was **built** before this phase: a table, four assistance modes, a
generated strategy chart, a drill bank, a Statistics screen and a SQLite save.
Almost all of it worked. What this phase found is that several of the pieces were
wired to nothing, and that the failures were of the kind this repository keeps
recording — silent, plausible, and invisible to a green suite.

Nine defects, each fixed and each with a regression test **proved to fail when
its fix is removed**. Two were found only by running the thing on a device.

---

## A. Defects found and fixed

### A1. Reset bankroll, start and mode change were never written to disk

`resetBankroll`, `start` and `setMode` mutated the store and returned. The save
happened on the next *dispatch*, so a player who reset their bankroll and then
killed the app came back to the session they had just discarded — with the old
bankroll, the old hand and the old mode.

The persistence itself was correct; nothing called it. **Test:** two cases in
`tests/features/practice-resume.test.ts` kill the app immediately after each
mutation. Proved by deleting `void persistNow()` from `resetBankroll` — both fail.

### A2. A corrupt save destroyed every cumulative statistic

Session and statistics shared one JSON blob under one key. Any reason to reject
the session — a truncated write, a schema bump, a ruleset change — took the
player's entire history with it: hands played, accuracy, mastery, all of it, for
a hand that had nothing to do with them.

Now two records (`practice:session`, `practice:stats`) written statistics-first,
plus a real v1 → v2 forward migration that fills new counters with zero and drops
unknown keys rather than refusing the file. `LoadResult` carries `stats`
independently of `session`, so an unusable session is archived and the history
survives. **Test:** sixteen cases in `tests/features/practice-error-states.test.ts`.
Proved by making a session failure delete the stats record — four fail.

### A3. The decision log was never persisted

Mastery survived a restart because it lived in the stats blob. The decision log
did not, so Statistics' *Decision behaviour*, *Streaks* and *Trend* emptied on
every launch while Mastery kept counting — three sections of one screen
disagreeing with the fourth about the same session. **Proved** by blanking
`decisionLog` in `serialisePractice`: one test fails.

### A4. Insurance was recorded as a credit, not a net

`INSURANCE_SETTLED` carries `credit`. The fold added it as though it were a net
result, so lifetime net chips drifted from the bankroll by exactly the amount
staked — 390 chips over 18 insurances in the first probe.

Subtracting `before.insuranceBet` fixed most of it and left a 25-chip gap in one
case: when the dealer peeks and **has** a natural, the engine takes the insurance
and settles the whole round in the *same* command, so `before.insuranceBet` is
still zero. The stake is now the larger of the pre-command bet and any
`INSURANCE_TAKEN` in the same batch. **Verified** by a seeded 200-hand
conservation property — `netChips` equals the bankroll delta exactly, over three
randomised runs.

### A5. No outcome, betting or action statistics existed at all

The store consumed engine events for sound and discarded them. Nothing counted a
win, a loss, a push, a blackjack, a bust, a surrender, a double, a split, chips
wagered or a streak — and the Statistics screen said so, with a constant named
`HAND_RESULTS_UNAVAILABLE`. That message described the store, not the product.

`src/features/practice/practice-record.ts` is the fold that was missing: a pure,
runtime-neutral reducer from engine events to statistics. `HAND_RESULTS_UNAVAILABLE`
is deleted. Hand history records totals and outcomes and **no cards** — asserted
by scanning the serialised record for `rank`, `suit` and `cards`.

### A6. The strategy diagnostic was computed and thrown away

The advisor returns `null` plus a diagnostic when it cannot answer. The table
hid the hint and dropped the diagnostic, which makes a **hole in the tables**
indistinguishable from an advisor with nothing to say. Failing safe is three
things and only two were happening.

`strategy-diagnostics.ts` is the third: a bounded, de-duplicating sink that
counts occurrences per `ruleset|code|key`, evicts least-recently-*seen* rather
than oldest-inserted, and announces a hole to listeners once rather than once per
hand. It records no cards, no shoe, no hole card and nothing about the player.

### A7. The Analysis sheet was invisible to VoiceOver — and so was the review sheet

Both sheets were a `Pressable` scrim carrying an `accessibilityLabel` **wrapping**
the sheet. On iOS a label on a pressable *replaces* the text of everything inside
it, so the entire analysis — four expected values, both probabilities, the
ruleset caption — collapsed into the two words "Close analysis", and the whole
review collapsed into "Close review".

Nothing looked wrong. The screenshot of the failure shows every number rendered
correctly. It was found only by asserting on the RESULT: a Maestro probe could
not see "Bust if you hit" on a screenshot that plainly showed it.

The dismiss target is now a **sibling** of the sheet occupying exactly the
visible scrim above it — not an ancestor, and not an `absoluteFill` whose centre
lies under the sheet where a coordinate-driven tap would hit the sheet instead.
`tests/e2e/practice-analysis.yaml` asserts the sheets' *content*.

### A8. `career-node.yaml` navigated to the wrong screen

`tapOn: ".*Career.*"` matched the **Home** card, whose accessibility label also
names the career, and tapping it opens the active node rather than the map. The
flow then failed a map assertion while sitting on a perfectly rendered node
screen. A regex matching two destinations is not a selector; it now reaches the
map by `arc21://career`. Pre-existing and outside Practice, fixed because a red
flow in the standard gate is worse than the scope line.

### A9. `practice-resume.yaml` proved a bankroll, not a hand

The flow asserted the restored bankroll and wager. A fresh shoe dealt behind a
restored bankroll satisfies both. It now copies the player's and dealer's totals
before the kill and asserts them after, plus that no settlement or review surface
has appeared — so a phantom card, a duplicated deal or an early settlement fails
it. Proved discriminating by asserting a deliberately wrong total and watching it
fail.

---

## B. The four assistance modes

The contract used to live inside the table's JSX. It is now data in
`src/features/practice/assistance.ts`, read by the components and asserted
directly — the lesson this repository recorded from a correct `lockBet` wired to
a button nobody could press.

| Mode | During the decision | After it |
|---|---|---|
| Play | nothing | hand history only |
| Learn | one-line recommendation, expandable | the normal result |
| Analysis | recommendation + EV per action + two probabilities | full decision log |
| Challenge | nothing | correct/incorrect, ideal action, mistake size |

Two properties are load-bearing and both are asserted: **Play and Challenge are
identical while the player decides** (otherwise a Challenge grade measures
reading, and the unaided-accuracy headline measures nothing), and **Play never
gains a decision log** (a graded transcript afterwards is coaching with a delay).
A recommendation never blocks another choice — one test plays HIT against a
SURRENDER recommendation and asserts the engine accepts it and grades it wrong.

### The Analysis probabilities — why these two, and no others

The specification asks for "validated probabilities and EV where the data is
legitimately available". Two are legitimately available, and they are now
computed by the solver and emitted into every cell:

- **`bustIfHit`** — P(one more card takes this hand over 21), from the same
  depleted shoe that produced the EVs. Exactly 0 for every soft hand, which is a
  real answer rather than a missing one.
- **`dealerBust`** — P(the dealer's final total busts), conditioned exactly as
  every EV is: the dealer has already peeked and does not hold a natural.

They come out of the *same* solve as the EVs beside them rather than a second
model, because a number rendered next to a solver EV must have been produced by
the same arithmetic or the two can disagree and nothing will notice. Where a
table does not carry them, the block is absent — never filled with a figure
computed at render time.

Regeneration was proved purely additive: every one of the 380 cells' 
`recommendedAction` and `evs` is **byte-identical** to the previous table, and
`generated-table.test.ts` still re-solves the whole chart and compares the
emitted file byte for byte.

**Validation is by a different derivation, not a second run of the solver**
(`tests/strategy/probabilities.test.ts`, 18 tests):

- `bustIfHit` against closed-form card counting written out per case. Pair rows
  are used because exactly one two-card composition makes them, so the cell's
  aggregate *is* that composition's value. Hard 16 as 8,8 against a 7: 23 sixes
  + 24 sevens + 24 eights + 24 nines + 94 tens = 189 of 309 = 0.61165, matching
  the emitted cell to five decimals.
- `dealerBust` against a 120,000-trial Monte Carlo that deals from a real
  six-deck multiset and plays the dealer out under the rule read from
  `ARC_STANDARD_RULES`, rejecting the peeked natural. It shares no code with
  `dealerFinalDistribution`. The tolerance is four standard errors, and the test
  asserts that allowance is under one percentage point so it cannot silently
  widen. A second case proves the check can tell peeked from unpeeked
  conditioning — worth more than ten points against an ace.

Per-upcard dealer-bust bands land where six-deck S17 analyses put them: 2 →
35.0-35.6%, 6 → 42.0-42.7%, 7 → 25.9-26.4%, 10 → 22.9-23.2%, A → 16.5-17.0%.

---

## C. Strategy coverage — derived from the engine, not from a list

`completeness.test.ts` enumerates the states a human would write down. That
proves the table covers the list; it does not prove the list covers the game.

`tests/strategy/reachable-coverage.test.ts` enumerates **cards** instead: every
non-bust multiset of 2-8 ranks, against all ten upcards, in all three split
contexts, run through the engine's own `describeStrategyState`, and demands a
recommendation that is a member of every one of the eight legal-action supersets
of {HIT, STAND}. Over 10,000 answered lookups.

It also closes the other direction, which is the half that is easy to fake:
every cell in the table is accounted for. The only rows never reached from real
cards are `hard:4` and `soft:12` — 2,2 and A,A, which the classifier always calls
pairs — and they are **named** rather than absorbed into a tolerance.

The sweep proves it can fail: deleting `hard:16:10` from a copy of the table
makes the advisor return `NO_ENTRY` with that key.

**Rule-version mismatch** is already covered by `lookup.test.ts`: a table keyed
to another ruleset id or version is `RULESET_MISMATCH`; a table whose stamp
matches but whose *rules summary* does not is `RULES_MISMATCH`. Neither falls
back to stale advice.

---

## D. Strategy Guide and Decision Drills

**The Guide** projects the generated table — it does not transcribe a chart.
Rows come from the table's own key space, cells from its entries, and a cell with
no entry renders an em-dash rather than an invented action. Every cell carries
its fallback as *data* ("double if allowed, otherwise hit"), the legend is stated
once and shared with its tests, and the banner is built from
`metadata.rulesSummary` — the rules the solver actually ran over — so it cannot
advertise a rule the chart was not solved for. Tapping a cell now also shows the
two probabilities, from the same solved cell.

**Offline** is structural, not cached. `tests/learn/offline-availability.test.ts`
asserts no Learn, app-Learn or strategy module names `fetch`, a socket, or a
Supabase client; that the table is a committed source module fully populated at
import; and that every chart tab, the whole drill bank and a live recommendation
all build with `globalThis.fetch` replaced by something that throws.

**The Drills** are generated from the table's key space and graded by
`adviseAction` — the same lookup the player meets at the table — so a question
that cannot be graded cannot be asked. Measured: **330 questions**, 150 hard / 80
soft / 100 pairs, and **every** wrong answer of the 1,090 possible is priced.
Section F's "surrender and relevant special cases" is now asserted by name: the
four cells whose answer is surrender under 6D/S17/LS are exactly
`hard:15:10`, `hard:16:9`, `hard:16:10`, `hard:16:11`; the DAS-sensitive pair
cells, the always/never pairs and the soft doubles are each pinned.

**No fake progress:** accuracy is `null` until something is answered, "My
mistakes" is genuinely empty rather than falling back to everything, and answers
are recorded per strategy key through a validating store that discards a corrupt
blob rather than feeding it to the scheduler.

---

## E. Authority separation and error states

A tampered save reaches nothing. The behavioural tests plant an absurd record and
check what comes out; the structural ones assert the wiring does not exist,
because a behavioural test only proves today's call sites. A guest conversion
cannot **express** a chip movement — `netChips`, `maxBankroll`, `balance`,
`delta` and `idempotency` are all absent from the plan's vocabulary — and
`LOCAL_BANKROLL` is named as discarded in every plan. Source scans assert no
practice module names a wallet, ledger, XP, leaderboard, tournament or daily
symbol, and that no competitive feature imports the practice store. `practice` is
absent from `ACCURACY_ELIGIBLE_MODES`.

Error states fail safe without destroying unrelated data: a corrupt session is
archived and removed while statistics survive; a v1 save migrates forward; a
future version is refused rather than guessed at; storage that never resolves
times out into a playable empty session; and a full hand plays with every write
throwing.

---

## F. Anti-fake-completeness sweep

48 files across `src/features/practice`, `src/features/learn`, `app/learn`,
`app/game`, `src/components/table`, `shared/strategy`,
`supabase/functions/_shared/strategy`, `src/features/stats` and `app/stats`.

Zero TODO, FIXME, XXX, HACK, "coming soon", "not implemented", WIP, stub, dummy
or lorem. Five matches for *mock/fake/hardcoded* and one for *placeholder*, all
benign: comments asserting the code is **not** hardcoded, a `placeholder`
parameter naming the em-dash shown when a rate is unknown, and two comments
recording fabrications that were removed in earlier phases.

Worth recording how nearly this sweep lied. The first run reported a clean
`NONE` for every pattern — because `grep -rniE … $DIRS` in zsh does **not**
word-split an unquoted variable, so grep received one nonexistent path, errored,
and the `|| echo NONE` printed reassurance. A sweep that matches nothing is
indistinguishable from a sweep that cannot match anything. The rerun prints the
file count first.

---

## G. Kill / resume — the release gate

Automated (`tests/features/practice-resume.test.ts`): the app is killed by wiping
every in-memory store, and the restored engine state is compared **canonically,
in full** against the pre-kill state — including an active split hand seated on a
fixed shoe (`8S 9C 8H 7D 3D 4C 10H 2S`, giving 8,8 against a 9). Same shoe
position, same cards, same wagers, same bankroll, same active hand index, same
phase, no duplicate settlement, no phantom cards. The decision log and hand
history come back with it.

On device (`tests/e2e/practice-resume.yaml`, iPhone 17 Pro, real SQLite, real
`stopApp`): bet 100, deal, copy the player's and dealer's totals, kill, relaunch,
and assert Home offers "Resume your session · Bankroll 4,900 · hand 1", then that
the table shows the same two totals, the same wager, no `next-hand` control and no
review surface. Confirmed independently by deep-linking from a shell with no
Maestro involved: dealer 8, player 6♥ A♣ "Soft 17 · Bet 100", Hand 1 · Shoe 1.

**A Maestro note worth keeping.** The post-relaunch `tapOn` on the Home card
reported COMPLETED and did nothing, three runs in a row. Every time, the
hierarchy dump held **eight nodes** — the three carrying an accessibility
identifier plus the status bar — while the screenshot showed a complete screen,
and the device log for the same second carried `XCTAS Error: Error getting main
window Unknown kAXError value -25218`. The driver was tapping coordinates from a
snapshot it could not read. Killing stale `maestro-driver-ios` processes fixes it
for a plain launch but **not** after an in-session `stopApp`/`launchApp`; a deep
link does.

---

## H. Coverage

`src/features/practice` is now measured and gated. It earned its place
immediately: `strategy-diagnostics.ts` — the module whose entire job is to make a
silent failure visible — measured **9.09% statements and 0% functions**. Its cap,
its de-duplication and its eviction order were all unexercised. `advice.ts` was
at 77%, with `adviseDiagnosticKey` — the identity the table's recording effect is
keyed on — completely untested.

| Area | Statements | Branches | Functions | Lines | Gate |
|---|---|---|---|---|---|
| `shared/blackjack` | 98.76 | 95.85 | 100 | 99.70 | 90/90/90/90 |
| `_shared/strategy` | 98.12 | 94.40 | 100 | 99.29 | 90/90/90/90 |
| `src/features/practice` | 94.01 | 82.56 | 95.91 | 97.80 | 92/80/94/96 |

The new gate is **proved to fail when breached**, not assumed to work: removing
`tests/features/strategy-diagnostics.test.ts` fails all four metrics
(90.43/79.35/91.83/95.05). The two React hooks in that directory are excluded and
named — they import React Native, which cannot be parsed under Node.

---

## I. Commands run, with results

```
npx tsc --noEmit                       exit 0
npm run lint                           0 errors, 37 warnings (baseline 38)
npm run check:functions                all 3 Edge Functions typecheck
npm run strategy:generate              380 cells, 21.9 s, expectation -0.3345%/unit
                                       0 published-cell disagreements
npm run test:unit                      103 files / 2,017 tests PASS  (phase 1: 94 / 1,901)
npm run test:coverage                  101 files / 1,991 tests, every gate met
npm run test:server                    13 files /   116 tests PASS  (live stack)
maestro practice-hand.yaml             PASS
maestro practice-resume.yaml           PASS  (extended: same cards, no settlement)
maestro practice-analysis.yaml         PASS  (new)
maestro career-node.yaml               PASS  (28 steps, after the selector fix)
```

Host load 4-8 throughout; `uptime` checked before each Maestro run and stale
`maestro-driver-ios` processes killed first.

**Not run:** `every-screen.yaml` — a `.env.local` is present, and that flow
asserts ".*no server configured.*" in five places, which is only true of an
unconfigured build. Documented in `CLAUDE.md`; not a regression and not caused by
this phase. Also not re-run: `supabase test db`, `npm run contrast:check`,
`npm run benchmark`, `expo export` — this phase changed no schema, no colour
token and no engine hot path.

---

## J. Phase 2 exit criteria

| Criterion | Met |
|---|---|
| Complete offline Practice, network-independent | ✅ no `fetch`/Supabase in any Practice or Learn module, asserted with a discriminating scan |
| Exact kill/resume, including a split hand | ✅ canonical full-state compare + on-device flow asserting the same cards |
| All four assistance modes behave as specified | ✅ contract extracted to data and asserted directly, 19 tests |
| Validated strategy coverage | ✅ engine-derived sweep, both directions, proved to find a planted hole |
| Analysis probabilities are validated, not fabricated | ✅ re-derived by closed-form counting and by Monte Carlo, neither sharing solver code |
| Strategy Guide complete and rules-labelled | ✅ projected from the solved table; banner from `metadata.rulesSummary` |
| Decision Drills incl. surrender and special cases | ✅ 330 questions; the four surrender cells named; every wrong answer priced |
| Practice mastery tracking, not mislabelled | ✅ unaided accuracy is the headline; hand streaks captioned "luck, not skill" |
| No authority leak to competitive systems | ✅ behavioural + structural, both directions |
| Local persistence fails safe | ✅ statistics survive a rejected session; migration; archive; no data destroyed |
| Relevant tests green | ✅ 2,017 unit + 116 server + 4 Maestro flows |

**Open, non-blocking, assigned onward:** `every-screen.yaml` has still never been
walked against a build with a server configured — the flow asserts what a screen
*says* in one configuration only. → **Phase 11.**

**PHASE 2: PASS**
