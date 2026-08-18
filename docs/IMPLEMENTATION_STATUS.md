# Arc 21 — Implementation Status

> **Arc 21 is a temporary development codename.** It has not been trademark-cleared.
> Arc 21 is a simulated card game. Virtual chips have no monetary value, cannot be
> withdrawn, and cannot be exchanged for money or prizes.

Last updated: 2026-08-18

---

## Current phase

**Phase 14 has begun. Session 1 of 6: the cosmetics system is visible, and the
app has a face.**

Twenty-four cosmetics were earnable, ownable and equippable — and **not one of
them rendered anything**. Equipping changed a database row and nothing else
happened anywhere in the app. `my_loadout()` was granted to `authenticated`
and had zero client consumers: the same defect class as the audio adapter, at
larger scale.

All 24 now render, from hand-authored `react-native-svg` components in
`src/features/cosmetics/art/` — flat vector geometry in the token palette, a
drafting vocabulary (set square, compass, hex nut, stepped footing) that tracks
the three career chapters. Not a face, not a felt texture, not a casino. The
equipped loadout flows through a new `loadout-store` consumed by Profile, every
leaderboard row, `CardBack` at every table, and a `TableSurface` layer behind
the practice, career and shared tables (private, public, tournament and daily
all render through the shared frame). A guest, a signed-out player and a fresh
account all resolve to the three `unlock_type = default` items; an asset key
this build cannot draw falls back to the slot's default rather than a blank.

The proof that this cannot silently regress:
`tests/cosmetics/registry.test.ts` parses the catalogue out of
`supabase/seed.sql` and asserts every `asset_key` resolves to a component with
no orphans in either direction — the test that would have caught the audio
adapter.

Verified on device, not just in tests: an account was created, given XP
server-side, and the real `grant_earned_cosmetics()` path granted 11 items on
opening Inventory. Equipping First Chip, Brass and Midnight visibly changed
the Profile avatar, the dealer's hole-card back at the practice table, the
table surface (pixel-sampled at exactly `#07090E`), and the player's own
leaderboard row — while the other rows showed the default mark from their
empty loadouts.

The app also has an icon and a splash now: an arch over the numerals 21,
generated deterministically by `scripts/generate-app-art.ts` (a
signed-distance rasteriser writing PNGs through `node:zlib`, the audio
palette's policy applied to pixels). `tests/art` regenerates both and compares
byte for byte. Verified in the native pipeline — `expo config` resolves both,
prebuild wrote them into `Images.xcassets`, the built `Assets.car` carries
AppIcon at 1024 and the splash logo, and both were photographed on the
simulator's home screen and at launch. **They do not appear in `npx expo
export`, correctly:** the export bundles runtime assets only, and icon/splash
are native build-time assets.

### The ninth built-but-never-connected defect

Driving the new account flow end to end found it: **onboarding's "Create
Account" and "Sign In" buttons deterministically dumped every new player on
Home, signed out.** The buttons set `complete("account")` and pushed the auth
route — but the guest path's navigation effect fired on *any* completion and
replaced to Home after commit, clobbering the push on every tap. Last phase's
audit had marked account reachability fixed, and `every-screen.yaml` asserted
the buttons were *visible* — not where they led. The effect now reacts only to
the guest completion, and the fix was verified by creating an account through
the screen.

**Before this: notifications, audio and polish** — and the audit that found
three screens still describing a build that stopped existing five phases ago.

Sound is real. Every cue is synthesised from oscillators, envelopes and filtered
noise by `scripts/generate-audio.ts`: nine files, 103 KiB, nothing sampled,
bought, borrowed or traced. The output is deterministic, so `tests/audio`
re-synthesises each one and compares it byte for byte with the committed file —
which is what makes "originally generated" a checked claim rather than an
assertion in a licence document. The palette is asserted to be restrained too: a
loss is quieter than a win, a win is quieter than a blackjack, and the two cues
that repeat most are the quietest of all.

The audio adapter had been "wired" since phase 4 with a comment saying the call
sites were correct. **There were no call sites.** `playSound` was exported and
never once invoked. There are nine now, one per cue, including at the
server-authoritative table — which meant plumbing the event stream through the
gateway and the store, because a shared table renders snapshots and feedback
driven by a diff between two snapshots cannot tell the second card of a deal from
a redraw.

Notifications are real end to end. A friend request writes a row inside the
command's own transaction, the sender drains it, and the delivery is recorded
honestly — `mocked`, never `sent`, because this build has no push credentials and
a sender that claimed otherwise would make its own audit trail worthless. Two
structural guarantees hold underneath: `notify_user` is revoked from every client
role, so a modified client cannot post itself a tournament win; and
`notifications.data` is constrained to allowlisted keys holding short scalars, so
a daily-challenge seed or a shoe cannot leave through a push payload. The 1100
migration asserted the second of those in a comment. A comment is not a
constraint.

### What the audit found, and what it cost

Three screens were still telling players that Arc 21 had no accounts:

1. **Onboarding** answered "Create Account" and "Sign In" with a note explaining
   there was nothing to sign up to. `app/(auth)/` had been signing people in
   since phase 8. The account screens were unreachable from the one place every
   new player looks.
2. **Profile** passed `hasAccount: false` as a literal. Every signed-in player
   saw the guest profile, and the level bar — which `progressionState` has been
   able to render since phase 6 — could not appear for anybody.
   `my_level_progress`, built last phase, had no caller.
3. **Settings → Privacy** claimed nothing was uploaded because there was no
   account. That one was a false privacy claim, which is the worst kind of stale
   copy to ship.

Each had a test passing beside it the whole time, because each test asserted that
the copy still said what it said. The onboarding test now asserts *reachability*
instead.

### And one deadlock that had been latent for months

`career-node.yaml` tapped "Next hand" from inside its betting branch. An
iteration arriving at a settled hand found no betting bar, skipped the body — and
so did every iteration after it, because nothing else brings the betting bar
back. It failed intermittently, looked like flakiness, and was diagnosed from its
own hierarchy dump: "Hand 2 of 10", with "Next hand" plainly on screen. Each
state is now handled at the top level of the iteration, so a pass cannot leave
the table stuck.

**Before this: leaderboards and cosmetics, and the strategy board is real.**

The specification's bar for that board is "minimum 100 eligible
SERVER-AUTHORITATIVE decisions in period", and until phase 12 there was no
server-side grading at all — `player_stats.decisions_total` had existed since the
first migration and was never written. It is now: every action at a ranked table
is graded against the same advisor the learning screens use, from the
authoritative state as it stood BEFORE the action, and bucketed by ISO week.

Getting there required solving the module-resolution problem this repository had
written off as unfixable, and this phase finally found the actual mechanism: each
function directory carries a generated `deno.json` import map, and that map is
what resolves a `shared/**` specifier. Adding a new function without a copy of it
takes the entire stack down at `supabase start` — which is how the discovery was
made.

**Before that: tournaments and the Daily Challenge — and three defects underneath
them were found and closed.**

The Sprint Tournament is real: four accounts enter for 500 chips each, are seated
on four equal 10,000 stacks, and play twelve scheduled hands with the button
moving one seat per hand, a 2,000 bet ceiling that opens to 5,000 at the ninth
scheduled hand, the lowest stack eliminated after hand six, sudden death when
that boundary ties, and placements paid once at the end.

The Daily Challenge is real too, and its central claim is measured rather than
described: two independent accounts were dealt the **identical shoe**, card for
card, from an HMAC-SHA-256 counter stream over a seed that never leaves the
database.

Before all of this, friends, private tables, presence, Realtime, public
matchmaking and the whole single-player product and server economy were already
complete.

| # | Phase | Status |
|---|-------|--------|
| 1 | Repository and architecture | ✅ **Done** |
| 2 | First playable vertical slice | ✅ **Done** |
| 3 | Complete blackjack engine | ✅ **Done** |
| 4 | Polished local table | ✅ **Done** — table, persistence, animation (Reanimated, reduced-motion aware), haptics, and as of phase 13 nine originally generated sound cues with call sites |
| 5 | Learning and strategy | ✅ **Done** — assistance modes, How to Play, Strategy Guide, Decision Drills with spaced repetition |
| 6 | App shell and career | ✅ **Done** — onboarding, four tabs, Home/Play/Learn/Social, Profile, Stats, Settings, Fair Play, Career map + playable sessions |
| 7 | Supabase foundation | ✅ **Done** — schema, RLS, seed and 237 pgTAP assertions |
| 8 | Server-authoritative solo and economy | ✅ **Done** — attacked five ways and clean; 25,000 opening wallet, Recovery Grant, account deletion, server-side statistics and XP all wired and verified against the live stack |
| 9 | Friends and private tables | ✅ **Done** — friends, presence, private tables seating 2–5 on a shared shoe with the wallet provably untouched, a live table over Realtime, a free reset for a broke seat, and lobby expiry |
| 10 | Public matchmaking | ✅ **Done** — queue, per-tier allocation, buy-in escrow and cash-out, all verified against the live stack. Chips conserved to the unit |
| 11 | Tournaments and daily challenge | ✅ **Done** — a real four-player twelve-hand sprint with elimination, sudden death and paid placements; a deterministic daily shoe proved identical across two accounts. Three defects underneath it found and closed |
| 12 | Leaderboards and cosmetics | ✅ **Done** — four server-recorded boards, decisions graded by the server against the real advisor, and the cosmetic catalogue earnable, equippable and provably inert |
| 13 | Notifications, audio, polish | ✅ **Done** — a server-written notification pipeline with an honest delivery record, nine generated sound cues, deep links, and an audit that found three screens describing a build from five phases ago |
| 14 | Quality and production hardening | 🔶 **In progress — session 1 of 6 done**: all 24 cosmetics render and the equipped loadout is live everywhere; original app icon and splash generated, catalogued and photographed on device; onboarding's broken account routing found and fixed. Remaining: rate limiting, network fault behaviour, accessibility audit, CI/EAS/store metadata, final acceptance sweep |

No placeholder or "Coming Soon" routes have been created. Modes that require
server authority are absent rather than teased.

---

## Verification performed

Not self-reported — actually executed (re-run in full, 2026-08-18, Phase 14
session 1):

```
JS tests    1401 passed (65 files)  — npm test
            (+17 this session: 7 loadout resolution, 7 registry completeness
             parsing seed.sql, 3 app-art byte-compare)
pgTAP        355 passed (19 files)  — supabase test db, after a clean reset
Server        46 passed against the RUNNING Edge Functions, not skipped —
            the 401 gate was checked immediately before the run
E2E         practice-hand · career-node · every-screen all pass on
            iPhone 17 Pro / iOS 26.5
Typecheck   clean (tsc --noEmit)
Lint        0 errors, 32 warnings — identical count to the tree before this
            session, measured on a worktree of the prior commit
Native      rebuilt with the new icon and splash; installs, launches, plays
Migrations  29 applied from scratch + seed, hardening gates passing

A caution for re-runners: this suite run CONCURRENTLY with an Xcode build
reported 15 failures from CPU starvation alone; the identical tree passed
1401/1401 on an idle machine minutes later. Do not diagnose failures
measured under a compile.

Coverage, per area rather than one blanket number:
  shared/blackjack           97.31% statements · 93.81% branches  (gate 90)
  _shared/strategy           98.12% statements · 94.40% branches  (gate 90)
  shared/career              72.61% statements · 63.51% branches  (gate 70/60)
  shared/progression         98.52% statements · 97.50% branches  (gate 90)
  _shared/tournament-format  94.50% statements · 79.16% branches  (gate 90/75)
  _shared/daily-challenge     100%  statements ·  100%  branches  (gate 95)
  _shared/decision-grading   88.46% statements · 83.33% branches  (gate 85/80)
  _shared/session-economics   100%  statements ·  100%  branches  (gate 95)
  _shared/push-message        100%  statements · 96.42% branches  (gate 90/85)
```

The push-message gate was verified to fail when breached, not assumed to work:
temporarily raised to 101% it reported
`ERROR: Coverage for statements (100%) does not meet ... threshold (101%)`, and
was then restored. That check exists because a threshold matching zero files
silently passed in this repository once already.

**Live database integrity, after the full server suite:**

```
wallets = ledger            true
negative balances           0
level disagrees with xp     0
notifications written       38
unsafe payloads             0        <- the data allowlist holds
delivery states             mocked=2, no_device=22, pending=14
pushes actually sent        0        <- honest: no credentials exist
devices registered          4
queued to an unwanted kind  0        <- per-device allowlist is enforced
```

`pushes actually sent = 0` is the number this build should report. Nothing is
delivered without APNs/FCM credentials, and the sender says so rather than
recording a success it did not have.

**Performance review, measured rather than claimed:**

```
Engine hot path    5,000 hands · 19,874 commands in 3,883 ms
                   776 µs per hand · 195 µs per command
                   — about 1% of a 60 fps frame budget per command

iOS export         5.9 MB Hermes bytecode
                   224 KB assets total, of which 103 KB is the sound palette
                   32 bundled assets: 23 PNGs from expo-router, 9 WAVs of ours
```

The nine cues appear in the export's `metadata.json`, which is how "the audio
ships" is known rather than assumed.

Two deliberate structures keep re-render cost down at a live table. `lastEvents`
is set to a single shared `EMPTY_EVENTS` constant on every poll rather than a
fresh `[]`, because the feedback hook decides whether a batch is new by identity
— a new empty array three times a second would replay the last hand's win sound
forever. And the audio sink pools three players for `cardDeal`, because a deal
staggers cards at 60 ms while each cue runs for 120 ms, so a single player would
cut its own tail off on every second card.

Coverage gates are scoped per area deliberately. A single global figure gets
gamed in one of two ways — a well-tested core hides a weak newcomer behind a
good average, or a weak newcomer drags the gate down until someone lowers it for
everyone. The engine, strategy and money primitives decide outcomes and chips
and hold the 90% bar; career is progression logic that cannot mis-settle a
wager, so it carries a lower but honest bar, to be raised as its session runner
lands.

The suite is run repeatedly before any claim of stability. A test that fails only
under load is a real defect — it teaches people to re-run CI instead of reading
it — and two distinct causes have been found and fixed here:

- The solver's six-deck recursions exceeded Vitest's 5s default when competing
  for CPU. Fixed with explicit `testTimeout`/`hookTimeout`.
- `tests/strategy/solver.test.ts` takes seconds normally and **17 minutes** under
  v8 coverage instrumentation, because instrumenting a deep recursion is
  pathological. It is excluded from the coverage run only — the solver lives in
  `scripts/`, which coverage does not measure, so no measured coverage is lost,
  and it still runs and must still pass on every `npm test`. A 20-minute timeout
  would have made a genuine hang indistinguishable from normal operation.

**Live gameplay verification.** The app was run and driven end to end. Five
consecutive hands settled with exact bankroll arithmetic:

```
start 5,000 → Loss 4,900 → Win 5,000 → Win 5,100 → Loss 5,000 → Win 5,100
```

Confirmed on screen: dealer hole card rendered face-down with the displayed
total reflecting **face-up cards only** (ace showing → "11", never the hidden
total); insurance offered only against an ace, at exactly half the wager;
Split correctly legal on K♦ K♣ under the equal-value policy; the 1,000 chip
absent and the 500 chip auto-disabling once it would exceed the table maximum.

**Randomised soak through the live UI**, choosing among legal actions at random:

```
38 hands · 11 splits · 15 doubles · 2 insurance offers · 3 blackjacks
1 shoe reshuffle (reached shoe 2) · 0 errors
```

**In-process fuzz (permanent, in CI).** `tests/features/practice-store.test.ts`
plays 150 randomised hands through the store and asserts after every one that
the bankroll equals the starting bankroll plus the sum of settled outcomes
exactly — proving chips are never created or destroyed, never drift through
rounding, and never go negative. It also asserts the shuffle number cannot
change while a hand is in progress.

---

## Completed requirements

### Shared blackjack engine (`shared/blackjack/`)

Runtime-neutral TypeScript — no React, React Native, Expo or Supabase imports.
The same module serves the client, the future Edge Functions and the tests, so
there is exactly one implementation of the game.

Six-deck configurable engine; full state machine; S17 (H17 configurable); 3:2
naturals; peek; insurance and even money; late surrender; double and DAS; split,
resplit and split-ace restrictions; integer chip math; 75% penetration with
between-hands-only reshuffles; transactional shoe-exhaustion abort; predictable
timeout defaults; sequential multi-seat turn order; typed errors that leave state
untouched; monotonic versioning; and a sanitisation boundary with automated
leak assertions.

### Application shell

- Expo SDK 57.0.12, React Native 0.86.2, React 19.2.3 — matching the spec
- Expo Router, TypeScript strict + `noUncheckedIndexedAccess`
- Reanimated 4 **Bundle Mode enabled** (babel plugin + Metro config), the
  current recommended workaround for SDK 57's Hermes memory overhead
- Design tokens, typography with tabular figures, motion tokens with a
  Reduce Motion hook
- Playing cards rendered **programmatically** from vector primitives — no image
  assets, original by construction, suit never carried by colour alone
- Practice table: betting bar, action dock, insurance sheet, split-hand selector,
  outcome badges, result summary

### Learning modes

All four assistance modes are live at the Practice table, every one backed by
the generated tables — no placeholder advice anywhere.

| Mode | During the decision | After |
|------|--------------------|-------|
| Play | Nothing | Logged for review |
| Learn | "Recommended: HIT", expandable to a rationale | Logged |
| Analysis | Collapsed chip expanding to EVs for every legal action | Logged |
| Challenge | Nothing | Immediate correct/incorrect with the EV cost |

`src/features/practice/advice.ts` is the bridge, and it is deliberately pure so
it can be tested against the real engine. Three properties it guarantees:

- **It never reads hidden state.** Only the player's cards and the dealer's
  *upcard*. A test asserts identical advice for identical upcards over different
  hole cards — if the hole card ever leaked into the model, that test fails.
- **It never recommends an illegal action.** Recommendations are resolved
  against `getLegalActions`, so an unaffordable double falls back to hit.
- **It never guesses.** When the tables cannot answer, it returns null and the
  UI shows nothing. Ungradeable decisions are excluded from accuracy entirely,
  so a state the solver does not price can never be recorded as a mistake.

Strategy accuracy is tracked locally, and separately for decisions made *unaided*
(Play and Challenge) versus with the answer already on screen — a "correct"
choice made while reading the recommendation measures nothing about the player.
Assistance can only be changed between hands, so a graded decision cannot be
converted into a revealed one mid-hand.

### Practice persistence

The session autosaves to SQLite after every accepted engine transition, so an
app kill loses at most the command in flight rather than the hand. The **shoe is
saved with the chips**: resuming with a fresh shoe would silently reshuffle the
composition the player was reasoning about.

A saved blob is treated as untrusted input from disk. Every load is validated —
schema version, ruleset key, and structure — and then *exercised*: the engine is
handed one no-op command to prove the state is actually drivable. A blob can
satisfy every shape check and still be undrivable (an unknown phase, a cursor
past the end of a seat's hands), and it is far better to find that here, where
the session can be archived and replaced, than on the player's first tap.

Anything that fails is archived for diagnosis and removed, so a bad save cannot
crash the app on every launch.

Hydration is also **time-bounded**. A rejected promise was already handled, but a
promise that never settles was not: a storage module that fails to initialise
left the table showing "Shuffling…" forever with no way forward. That was caught
by running the app, not by the tests, and is now covered by one that wedges the
store deliberately.

### Server command layer

`supabase/functions/game-command` and `create-session`, exercised over HTTP
against the running local stack by `tests/server/`. Those tests **skip** when the
stack is not reachable, so a machine without Docker still gets a green suite —
and the guard requires a 401 from the function itself, because the API gateway
answers 503 with the runtime stopped and an "any response" check reported the
stack as up.

Verified by attacking the running function, not by reading the code:

| Attack | Result |
|--------|--------|
| No token / forged signature | 401 |
| Expired beyond clock skew | 401 |
| `alg: none` | 401 |
| `role: "anon"` (the bundled publishable key) | 401 |
| Wrong audience / non-UUID subject | 401 |
| Replayed `clientActionId` | first result returned, no second chip movement |
| Replayed session open | same gameId/seatId/buyIn, one debit |
| Stale `expectedVersion` | `stale` + authoritative snapshot, nothing applied |
| Negative wager | 400 before any state is touched |
| Command on another account's session | rejected |
| Any response body | no undealt card, no hole card, no `nextIndex` |

Errors return a generic message plus a correlation ref matching a structured log
line — no SQL, no stack frames, no row contents.

#### Two defects found and fixed

1. **`jsonb` double-encoding.** `${json}::jsonb` stored a JSON *string* rather
   than an object, so persisted engine state could never be read back: every
   game command returned 500 *after* `create-session` had already debited a
   buy-in. Fixed with `::text::jsonb` at the write sites.
   My first attempt made the reader tolerate strings, which papered over it —
   a `CHECK` constraint (`jsonb_typeof(response) = 'object'`) refused the fudge
   and exposed the real cause. The reader keeps the tolerance as belt-and-braces
   for rows written before the fix.
2. **Session-open replay returned 500** instead of the first committed result,
   so a client retrying after a network blip got an error rather than its table.
   Resolved by the same fix.

#### Still unattacked

Concurrency (two commands racing at the same `expectedVersion`) and double
cash-out. Integer overflow is covered at the contract boundary —
`MAX_CHIP_AMOUNT * 4 < Number.MAX_SAFE_INTEGER` is asserted — but not yet
end-to-end through settlement.

### Crypto

`CryptoRandomSource` throws rather than falling back to `Math.random()`, so the
root layout installs a Web Crypto polyfill backed by `expo-crypto` (platform
secure random) before any game module loads.

---

## Defects found and fixed

1. **Turn cursor never advanced.** Positioned only in the peek branch, so deals
   where the dealer showed neither ace nor ten began player turns with no active
   seat and never progressed. Broke 32 tests at once.
2. **Self-extending action deadline.** Refreshed on every cascade pass, letting
   an online player extend their own clock with no-op commands.
3. **Split-ace status ignored the ruleset**, hardcoding `TWENTY_ONE`.
4. **No way to clear a staged bet.** The store faked it in the UI while the
   engine still held the chips. Fixed at the root: `PLACE_BET` with amount 0 is
   now the authoritative "take chips back off the felt" command.
5. **Legality frozen at first render.** The table called a Zustand getter during
   render. That does not subscribe, and under the React Compiler it memoised
   against a stable function reference and never recomputed — leaving Deal
   permanently disabled. Now derived from subscribed state via `useMemo`.
   *This class of bug is invisible to unit tests and was only caught by running
   the app.*
6. **Insurance sheet stayed mounted after the phase advanced**, rendering
   meaningless props ("Insurance costs 0 chips"). Now conditionally mounted.

### Found by adversarial verification of the database and strategy work

Each was demonstrated with a live exploit against the running stack, not by
reading code, and each fix below was re-verified the same way.

7. **Social-graph RPC oracle.** `are_friends(uuid,uuid)` and
   `has_blocked(uuid,uuid)` are `SECURITY DEFINER`, take an arbitrary pair, and
   were granted to `authenticated` — making them PostgREST endpoints that
   answered questions about *any* two accounts, defeating the RLS on
   `friendships` and `blocks` entirely. Replaced with caller-scoped `viewer_*`
   predicates that derive the viewer from `auth.uid()` and take only the
   counterparty, so there is no pair to probe. Verified: the two-argument
   functions now return `permission denied` for `authenticated`.
8. **Hardening gate blind to column grants.** The deploy gate read only
   table-level grants, so `grant update (balance) on public.wallets to
   authenticated` passed it untouched — on the table the gate singles out as
   mattering most. Added a column-privilege gate. Verified: the old check
   reports `f` for that grant while the new one raises.
9. **Hardening gate blind to views.** It filtered `relkind = 'r'`, so a view
   over `wallets` without `security_invoker` laundered RLS past it. Added a view
   gate. Verified against a live `wallet_summary` view exposing every balance.
10. **Tournament standings leaked account UUIDs.** `tournament_entries` and
    `tournament_matches` had `using (true)` SELECT policies, exposing `user_id`
    — an `auth.users` id — for private profiles and for users who had blocked
    the requester. Now scoped to your own entry, fellow competitors, or entrants
    whose profile is already visible to you (delegated to the profiles policies
    rather than restated).
11. **pgTAP suite was not hermetic.** Global `count(*)` assertions meant it only
    passed against an untouched database. Scoped to per-file fixtures. Verified
    by running it twice against a deliberately dirtied database.
12. **Strategy fail-safe checked only the version stamp**, not the rules — a
    ruleset with the same `id@version` but different strategy-relevant fields
    was served the stale chart silently. Now compares the recorded
    `rulesSummary` against the rules actually in force.
13. **Pair validation reported a symptom, not a cause.** A pair of twelves was
    rejected as "total 24 outside 2..21" when the real problem is that twelve is
    not a card value; for a pair the total is *derived* from `pairValue`, so
    that field is now validated first.
14. **EV helpers could crash the table.** `evMistakeForDecision` threw on a
    missing legal-action set. It now fails safe and returns null, which the UI
    already handles by hiding the number.

---

## Deliberate deviations from the specification

### Safety reserve reduced from 104 cards to 52
The spec asks for both 75% penetration and a 104-card reserve. At six decks these
are mutually exclusive — the cut card falls at index 234 (78 cards left), so a
104-card reserve always trips first at index 209, silently reducing real
penetration to ~67%. Penetration is a user-facing fairness claim, so the cut card
stays primary and the reserve became a true backstop at one deck.
`assertPenetrationIsCoherent` prevents this from regressing. See
[BLACKJACK_RULES.md](./BLACKJACK_RULES.md).

### `PLACE_BET` carries an absolute amount
Chip taps accumulate in the UI; the engine receives the final wager. Idempotent
under network retry. Amount 0 clears.

### Auto-stand on 21
A hand reaching 21 completes automatically — the only outcome of hitting is an
accidental bust. UX safety, not a rule change.

### `babel-preset-expo` added as an explicit devDependency
Required once a custom `babel.config.js` exists: the preset ships nested under
`expo/node_modules` and is not resolvable by bare name from the project root.

### Metro resolves TypeScript `.js` specifiers
`shared/` imports its own modules with explicit `.js` extensions because the same
engine will be imported by Supabase Edge Functions, where Deno mandates them.
TypeScript and Vite map `.js`→`.ts` natively; Metro does not, so `metro.config.js`
adds it as a fallback **after** normal resolution fails, changing nothing else.

### `react-native-web` added as a development verification surface
**Not a product direction** — the spec is explicit that the primary product is
not a web app, and it is not being built as one. Xcode is not installed on this
machine (see blockers), so the web target is currently the only way to actually
run and verify the app rather than merely assert it compiles. It should be
removed, or kept strictly as a dev dependency, once native builds are possible.

---

## Known defects

None outstanding.

### Economy phase — closed out

The three items left behind when this phase was first marked done:

| Item | State |
|------|-------|
| **Opening wallet 25,000** | Done. Was seeding 10,000 — never reconciled against the specification, not a considered deviation |
| **Recovery Grant** | Done. `claim_recovery_grant()` restores a wallet under 2,000 **to** 5,000, once per 12 hours, deciding everything server-side from a locked balance |
| **XP / levels** | Done. Awarded in the settlement transaction, under the 300/day UTC cap |
| **Delete account** | Done. `delete_own_account()` plus a two-step confirmation in Settings → Account |

**XP is deliberately inert.** `shared/progression/` implements the curve
(`100 + 25 × (L-1)`, cap 50, 300/day repeatable cap) at 98% coverage, but no
settlement path calls it yet, so no player earns XP. It is a finished component
awaiting its wiring, not a working feature — recorded here so the distinction
does not blur.

**Server-authoritative statistics are written too.** No Edge Function had ever
written `player_stats`, so hands played online lived in the engine state and the
event log but never reached the statistics screen. Stats and XP share the one
settlement hook — a hand either updates the record or does not settle.

Verified against the live stack: one settled hand produced
`played=1 lost=1 wagered=50 net=-50`, `xp=5`, `daily=5`.

Two properties that must survive any change here:

- The award API takes a **count** of hands and decisions, with nowhere to put a
  stake. "Never award more XP for betting larger amounts" is therefore
  structural rather than a check that could be removed.
- Everything at the level cap reports `null`, not `0`, so a progress bar cannot
  divide by it.

### Money lens — five attack angles against the live stack

Concurrency, cash-out, overflow-through-settlement, self-credit and ledger
integrity were each attacked against the running database and Edge Functions.
Full evidence in [AUDIT.md](./AUDIT.md).

| Angle | Result |
|-------|--------|
| Racing commands at one version | **Clean.** 130+ simultaneous commands, 2/5/20 wide; exactly one accepted every time, with the database confirming a single version bump and a single event |
| Double cash-out | **Clean.** Same and differing request ids, raced, mid-hand, on a closed session, cross-account — one credit in every case; the key is derived from `gameId:seatId`, not from client input |
| Overflow through settlement | **Clean.** Doubled and 3:2 payouts exact at the real ceiling; every chip column is `bigint` and overflow fails closed inside the transaction |
| Self-credit | **Clean.** Every PostgREST write path, the direct `apply_wallet_delta` RPC and repeated Recovery Grants all rejected |
| Ledger apply order | **One defect, fixed.** `created_at` is transaction-start time and inverts under contention, so the ledger could not be replayed in order. No chips were affected. Fixed by adding a `seq` identity assigned under the wallet lock |

The concurrency result is now held by three tests in `tests/server/`, and the
ledger ordering invariant by `supabase/tests/09_ledger_apply_order.test.sql`.

---

## Blocked external integrations

| Integration | Status | What is needed |
|-------------|--------|----------------|
| **iOS native build** | ✅ **Working** | Builds, installs and launches on iPhone 17 Pro / iOS 26.5. Metro bundles 2,449 modules; the app renders correctly and produces no crash reports. **CocoaPods requires a UTF-8 locale** — without `LANG=en_US.UTF-8` it fails with `Encoding::CompatibilityError`, and the build then reports the misleading "sandbox is not in sync with Podfile.lock". Export `LANG`/`LC_ALL` before `pod install` or `expo run:ios`. |
| On-device interaction testing | Not possible yet | `simctl` cannot synthesise taps and `idb` is not installed, so gameplay cannot be driven on the simulator. Deep links reach the app but iOS raises an "Open in Arc 21?" confirmation that itself needs a tap. Gameplay is therefore verified through the web target, which runs the same store and engine. Installing `idb` (or a Maestro E2E suite) would close this gap. |
| Claude Code simulator panel | Unavailable | The MCP simulator server reports "Xcode is installed but not selected" even though `xcode-select -p` returns `/Applications/Xcode.app/Contents/Developer`, first-launch status is clean and the license is accepted. Appears to be a bug in that server. The simulator is driven directly with `xcrun simctl` instead. |
| Android native build | Not attempted | Requires Android Studio + SDK. |
| Supabase cloud project | Local stack in progress | Docker and Supabase CLI are installed and working. Cloud project + keys needed only for deployment. |
| Apple Push / FCM | Not started | Paid developer accounts. Token schema, permission flow and adapter can be built and tested against a no-op adapter first. |
| EAS build credentials | Not started | Expo account. |
| Analytics provider | Not started | Vendor-neutral interface + console adapter until a credential exists. |

---

## Next work (in order)

1. Land the strategy tables and Supabase foundation currently in flight.
2. Wire Learn / Analysis / Challenge assistance modes to the validated tables.
   *No placeholder advice has been shipped* — the spec forbids guessed strategy,
   so those modes are absent until real tables exist.
3. Practice persistence via Expo SQLite, autosaving after every terminal engine
   transition so an app kill resumes the exact hand.
4. Table polish: card deal/flip animation, chip movement, audio, haptics.
5. Component and E2E tests (RNTL + Maestro) for the table interactions that unit
   tests cannot reach — defect 5 above is exactly the class these would catch.
6. App shell: four-tab navigation, onboarding, profile, stats.

---

## Deferred to V1.1 / Future

Explicitly **not** in the MVP: side bets, slot mechanics, loot boxes, wheels,
gems, chip purchases, real-money gambling, cash-out, card-counting tools, text
chat, purchased XP, paid competitive advantages, or a "hot/cold" dealer.

Already supported by `BlackjackRules` and tested, but not shipped: H17,
European no-hole-card, split-by-rank, hit/resplit aces, alternative deck counts.
Shipping any of them requires a new ruleset version, because basic strategy
changes with the rules and strategy tables are keyed to `id@version`.
