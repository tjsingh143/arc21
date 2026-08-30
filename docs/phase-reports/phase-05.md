# Phase 5 — Mobile product, table UX, Career, Profile, Statistics, Settings, accessibility

Date: 2026-08-30 · Branch: `phase14-s2-security` · Preceded by phase 4 (PASS)

The mobile product was **built** before this phase and much of it is built well:
the four-destination shell is real, Home swaps its primary card on the
specification's own offline rule, Practice is genuinely offline-first, the Career
map locks and unlocks from a rule rather than a literal, Statistics leads with
unaided accuracy rather than win rate, and every "requires an account" surface
refuses instead of fabricating a zero.

What this phase found is a **consistent shape of defect rather than a list of
unrelated ones**: the product had been finished screen by screen, and the screens
that were finished LAST — the server tables, and the profile — kept the parts of
the first ones that nobody had gone back for. Practice had a split-hand selector;
the other two tables did not. Practice wired Repeat; the other two passed
`lastBet={0}`. The Settings model had a preference for confirming an online
leave; nothing read it. The database had a whole rename subsystem — two triggers,
a unique key, two rate-limit policies and a documented HTTP-status fix — and the
app had no control that could reach any of it.

Eight defects found and fixed — the last of them visible only on a screen. **Every fix has a regression proved to fail when
the fix is removed**, and the one that crosses into the database is proved
against the running stack rather than reasoned about.

> The Arc 21 PDF was not present in this working tree or anywhere on this
> machine (`find / -iname "*arc*21*.pdf"` returned nothing). `docs/ROUTES.md`,
> `docs/AUDIT.md`, `CLAUDE.md` and the phase brief were used as the
> specification of record. Stated rather than left implicit.

---

## A. Defects found and fixed

### A1. "Confirm before leaving an online table" was a preference that governed nothing

`AppSettings.confirmLeavingOnlineGame` was declared, defaulted to `true`, listed
in the Zod schema, normalised on every save and written to disk. A
full-repository grep for its name returned **three hits, all inside
`settings.ts` itself**:

```
src/features/settings/settings.ts:38:  confirmLeavingOnlineGame: boolean;
src/features/settings/settings.ts:78:  confirmLeavingOnlineGame: true,
src/features/settings/settings.ts:164:  confirmLeavingOnlineGame: z.boolean().optional(),
```

No Settings row offered it and no call site read it. This is the
built-but-never-connected pattern the project keeps rediscovering, in its
quietest form yet: the stored value was real and well-formed, so a blob
inspected on disk looked like a working feature.

What it should have been guarding is not cosmetic. **"Leave table" sends
`CASH_OUT`** — it closes the seat and returns the escrowed stack — and it is the
only economic command in the app a single mis-tap can fire. It is drawn at the
top-left of the table, exactly where a thumb reaches for a back button that
`TABLE_SCREEN_OPTIONS` deliberately removed.

Fixed with `shouldConfirmLeavingTable` in `leave-guard.ts` — pure, on the
testable side of the React Native wall — and a `confirmThenLeave` in the table's
`Frame` that **both** leave paths go through: the control, and the
`beforeRemove` listener that catches the Android hardware back button and a deep
link resetting the stack. The Settings row is in the Gameplay section.

`stack > 0` is part of the predicate on purpose. A seat holding nothing has
nothing to lose by leaving, and confirming that trains people to dismiss the
dialog without reading it — which is how a confirmation stops being one.

Regression: `tests/table/leave-confirmation.test.ts`. **10 of its 11 assertions
fail with the fix reverted.**

### A2. Two "requires an account" empty states told the player the build had no sign-in

```
Statistics → Competition   "This build has no sign-in yet, so there is no record
                            to show — not a record of zero."
Profile    → Level         "This build has no sign-in, so there is no level to
                            show…"
```

Both were true when written and false by the time anyone read them. What makes
this worse than a stale comment is that **a refusal has to name something the
player can do**, and these named the opposite: a guest was told the feature did
not exist, on a screen one tap from the sign-in that would have provided it.

`competition.ts`'s own header documents the sibling half of the same expiry —
`hasAccount` written as the literal `false` and never revisited — while the copy
underneath went on asserting what that literal had assumed. `STATS_VISIBILITY_NOTE`
already carries the lesson verbatim ("a privacy note is the single worst place in
a product for a sentence that has quietly expired"), which is what makes these
worth a guard rather than a fix: the rule was known, written down, and two
strings still drifted past it.

Both now say "You are playing as a guest" and name the action.

Regression: `tests/stats/expired-copy.test.ts` sweeps every string these two
modules produce. **3 of 5 fail with the fix reverted.**

### A3. A split was unreadable at two of the three tables that deal cards

Splitting is legal everywhere in this product, up to four hands, and the three
screens handled it three different ways:

| screen | before |
|---|---|
| `app/game/practice.tsx` | a chip row plus the active hand at hero size — correct |
| `app/career/play/[slug].tsx` | the active hand ALONE; no row, so the other hands' totals, wagers and bust status were not on screen at all |
| `app/table/[gameId].tsx` | **every** hand at hero size, stacked vertically |

The online case reaches the most players: Quick Play, public tables, private
tables, tournaments and the daily challenge all render `/table/[gameId]`. It is
also the least usable — `HandCards` at hero size is the largest thing the felt
draws, four stacked do not fit a phone in portrait, and the only thing marking
the hand the dock was about to act on was a one-pixel border.

The presentation MOVED into `src/features/table/split-hands.ts` (pure, runtime
neutral) and `src/components/table/HandSelector.tsx`, and Practice was switched
to them — so there is one implementation for three tables rather than one plus
two absences. The chip row is `View`s carrying their own accessibility labels,
never a `Pressable`: the engine decides which hand is live and plays them in
order, so a tappable chip would either do nothing or contradict the rules, and a
labelled `Pressable` replaces the text of everything inside it on iOS (four
surfaces lost to that already).

A settled hand's chip shows its STATUS, not its total: "Hand 2 · 21" beside a
dealer blackjack reads as a win.

### A4. The career table never showed the result of a hand

`OutcomeBadge` was rendered by Practice and by the online table. The career
table settled a hand and went straight to "Next hand" — so the one screen in the
product whose entire purpose is teaching correct play never told the player how
the hand had turned out. Fixed in the same change as A3.

Regression for A3 and A4: `tests/table/split-hands.test.ts`, 21 assertions.
**The whole file fails to load with the fix reverted** (the module is gone), and
its screen-level assertions fail independently.

### A5. Repeat was a permanently disabled control at every server and career table

`BettingBar` has always drawn Clear / Repeat / Deal and gates Repeat on
`lastBet > 0`. Practice passes both for real. The other two did not:

```
app/table/[gameId].tsx      lastBet={0}   onRepeat={() => undefined}
app/career/play/[slug].tsx  lastBet={0}   onRepeat={() => {}}
```

So at every server table — Quick Play, public, private, tournament, daily — and
at every career node, the button rendered and could never become enabled. Not a
dead button in the loudest sense; a worse one, because nothing about the screen
suggested the feature was missing rather than merely unavailable right now.

These are the tables where it earns its place: a career node is ten to twenty
hands at one stake, and an online table is where a player bets the same amount
hand after hand while other people take their turns.

Both stores now record the wager the server (or the engine) ACCEPTED at
`LOCK_BET`, and `repeatBet` **stages** it — the specification's rule is that a
previous bet may be suggested next hand and never silently committed, so the
player still presses Deal. It stages through `addChip` so the clamp against the
stack and the table maximum lives in exactly one place. `lastBet` resets on
`enter`, `forgetTable`, `start` and `abandon`: a different table has different
limits and a different stack.

Regression: `tests/table/repeat-bet.test.ts`, driving the real store through a
fake gateway. **10 of 11 fail with the fix reverted.**

### A6. A server table stated neither its rules, nor the hand, nor the shoe — nor the player's own stack

`PublicGameState` has carried `rulesSummary`, `handNumber` and `shoe` since the
wire contract was written. `app/table/[gameId].tsx` rendered none of them.

The asymmetry is what makes it a defect. Practice puts "Hand 3 · Shoe 1" in its
header and Home advertises "Six decks, dealer stands on soft 17, blackjack pays
3:2" on a card — both tables whose rules the player already knows, because there
is one local ruleset. The SERVER tables are the ones where the rules are not the
player's own choice, and they were the ones that said nothing. The rules change
the correct play and the house edge; a real table prints them on the felt.

In the same block: **every other seat rendered its stack and this seat did not.**
The player's own chips appeared only inside `BettingBar`'s "Available", so from
the deal until the next betting round they could see four other people's stacks
and not their own.

`src/features/table/table-rules.ts` derives both lines from the snapshot rather
than typing them — the rule `fair-play-facts.ts` states for the Fair Play page,
applied to the felt. Every clause is stated in both directions ("no surrender"
rather than an omission), because a missing clause is indistinguishable from a
clause nobody wrote.

Regression: `tests/table/table-rules.test.ts`, 9 assertions. **Fails to load
with the fix reverted.**

### A7. The whole rename subsystem was a door with no handle on the inside

Five server-side guards and two rate-limit policies have covered renaming since
phase 3:

```
guard_profile_username             lowercases; refuses a reserved handle    (23514)
normalise_profile_display_name     sanitises; refuses an invisible name     (23514)
profiles_username_key              the handle is unique                     (23505)
profile_username_change            1 per 30 days                            (PT429)
profile_display_name_change        5 per hour                               (PT429)
grant update (username, display_name, …) on public.profiles
```

`docs/AUDIT.md` records both limits being measured over HTTP against the live
stack. `CLAUDE.md` carries the fix that made the refusal a 429 rather than a
500, written up in terms of the player it misled: *"a player who renamed
themselves twice in a month was told the server had broken."*

**No player could reach any of it.** Nothing in the app had ever written either
column after signup — the Profile screen read both and offered no way to change
either, so a player was stuck for good with whatever handle the signup form
derived. All that enforcement guarded a door with no handle, and the
HTTP-status fix improved a message nobody could see.

Added: `src/features/auth/profile-rename.ts` (pure — what changed, what is worth
sending, and how each server error code renders), `rename()` on
`useAccountProfileStore`, and an `EditIdentityCard` on Profile that states both
limits **before** the player commits. A limit learned by tripping it is a trap;
one stated is a rule.

Three details that matter:

- **The row is re-read, never patched locally.** Both columns are normalised by
  triggers, so the stored value is not necessarily the typed one. Echoing the
  draft would show a value that does not exist.
- **A timeout is reported as silence, not as failure.** A rename that timed out
  may have applied, and telling the player it failed invites a second attempt
  that spends the one change they get every thirty days.
- **`changedFields` sends nothing when nothing changed**, comparing the handle
  *normalised* — `guard_profile_username` lowercases before deciding, so "SamV"
  IS the current handle and a PATCH for it would spend a request to no effect.

The editor is **keyed** on the stored values rather than synchronised by a
`setState` inside an effect. `npm run lint` rejected the first version
(`react-hooks`: "Calling setState synchronously within an effect can trigger
cascading renders") and the key is both idiomatic and better behaved: a refused
save keeps what the player typed, because the row did not change.

Regressions: `tests/auth/profile-rename.test.ts` (19), and
`tests/server/profile-rename.integration.test.ts` (8) **against the running
stack** — the real PATCH, with an ordinary player's token, asserting the
lowercase normalisation, the reserved refusal, the taken handle, the invisible
display name, that a second handle change answers **HTTP 429 and not 500**, and
that one player cannot rename another.

---

## B. A guard that had quietly stopped covering the thing it was named for

`tests/wallet/no-write-path.test.ts` scans client source for database writes.
Its header is precise about why it exists: the database already stops an
*attack*, and this stops an *accident* — somebody adding an optimistic local
balance update.

It scanned three directories: `src/features/wallet`, `src/features/auth`,
`src/lib/supabase`. **`src/features/settings` was not among them**, and
`profile-privacy.ts` has written `profiles.privacy` from there since phase 3.
So the one client write the product already had was invisible to the scan that
claimed no client write existed — the same shape as CLAUDE.md's pgTAP lesson
("a test that names the tables it checks stops checking"), one layer up.

Rather than exempt the new rename, the guard was **strengthened**:

- `src/features/settings` added to the scan, so both writes are now inside it.
- The blanket "every `.from()` is followed by `.select(`" replaced with an
  explicit allowlist: `profiles` accepts `update`, every other table is
  select-only, and `wallets` / `wallet_ledger` remain banned under every
  spelling by the assertion that was already there.
- A new assertion that any `profiles.update()` names only columns inside
  `grant update (…) on public.profiles` — either as an object literal, or as a
  variable declared in the same file as a typed `Partial<Pick<ProfileRow, …>>`,
  so tsc rejects a column the schema lacks and this test rejects one the grant
  lacks.

**Proved to fail on three separate breaches** rather than assumed to work:

```
a .from("wallets").update() in a scanned file
  → .from("wallets").update() is not an allowed client write
  → wallets: expected Set{ 'update' } to deeply equal Set{ 'select' }

.update({ privacy, chips: 999 })
  → writes profiles.chips: expected [ 'username', 'display_name', …(4) ] to include 'chips'

.update(anything)   (an untyped variable)
  → .update(anything) is not a typed profile patch: expected null not to be null
```

The file grew from 61 to 104 assertions and still passes.

---

## C. What was checked and found already correct

Recorded so the next phase does not re-audit it, and so a later regression has a
baseline.

| Brief | Finding |
|---|---|
| **A. Shell** | Splash → onboarding → guest/auth → Home is real and `decideLaunchDestination` is unit-tested. Four destinations only; Profile from the header. The table is outside the tabs group so it goes full screen. `TABLE_SCREEN_OPTIONS.gestureEnabled: false` plus the `beforeRemove` listener close all three route-removal paths — now with A1's confirmation in front of them. |
| **B. Home** | Real paths to Quick Play, Practice, Career, Daily, Tournament, Friends, Leaderboards. The primary card swaps to Practice for a guest or an offline device, which is the specification's own rule. The career card names the next unfinished node from either record, not `CAREER_NODES[0]`. No fabricated balances or results. |
| **C. Play** | Every mode routes somewhere real; the "Return to your table" card from phase 4 is present. No mode is described as having an easy or hard dealer. |
| **D. Learn** | Practice, Strategy Guide and Decision Drills all connect to the generated tables. |
| **G. Actions** | Hit/Stand primary, Double/Split visible-when-legal and never behind an overflow, Surrender a quieter control. Illegal actions render disabled rather than disappearing, so the dock does not reflow. `pending` disables everything while a command is in flight and no card is invented locally. |
| **I. Insurance** | The offer renders INSTEAD of the controls and is unmounted the instant the phase advances, at both the online and career tables. |
| **J. Career** | 18 nodes across 3 chapters, generated and asserted. `isNodeUnlocked` requires ≥1 star on the prerequisite and completion always awards the first star — including `bankroll_exhausted` — so bad cards cannot gate progression. Node detail states format, assistance, starting chips, table rules, maximum wager, all three star requirements and the player's best result before anything starts. Ranked-versus-offline is stated in the button labels, not chosen quietly. |
| **K. Profile** | Display name and @username from `public.profiles`, never the email. Avatar from the equipped loadout. Statistics, Inventory, Friends, Settings and the account-deletion path all reachable. (Renaming was the gap — A7.) |
| **L. Statistics** | Headline is unaided accuracy, not win rate, with the sample beside every percentage and an em dash rather than 0% for an unattempted category. Mode filter across all four sources. Streaks are labelled as luck. |
| **M. Settings** | Assistance, sound, haptics, all three accessibility switches, notification moments, privacy, account and About are wired and take effect. Music is an honest `StaticRow` reading "Off" because no music ships — a switch that silences silence would be theatre. `ToggleRow` is a real `Pressable` (the plain-`View` defect is fixed). (Leave-confirmation was the gap — A1.) |
| **N. Accessibility** | Suit never depends on colour: every card carries a glyph and an "Ace of Spades" label. The hole card is labelled "Face-down card". Values are spoken in words ("Soft 17", "Bust, 24"). `MIN_TOUCH_TARGET` on the chips and controls. `MAX_FIXED_CONTROL_FONT_SCALE` caps only fixed-geometry chrome. `npm run contrast:check`: 46 pairings, 0 failing, with the four deliberate sub-3:1 borders having passing Increased-contrast substitutes. |
| **O. Audio** | Every cue generated by `scripts/generate-audio.ts` and byte-compared by `tests/audio`. Driven by server events at the shared table, never by a snapshot diff. No crowd noise, no jingles; the loss cue is asserted quieter than the win. |
| **P. Errors / offline** | One `OfflineBanner` above the navigator, claiming only that the server did not answer — it asks no radio-state library, because a captive portal has a network and cannot reach Arc 21. `connection: reconnecting` is kept separate from `notice` and states that the hand has not stopped. `RATE_LIMITED` is a verdict and is never retried. |
| **Q. Responsible product** | `CHIPS_NOT_MONEY_FOOTER` on Home, Profile, Statistics and Fair Play; Settings carries its own statement. `tests/stats/fair-play.test.ts` bans the words that would make the page a false claim. No loss-chasing language anywhere. |
| **S. Anti-fake sweep** | 229 files across `app`, `src`, `shared`. Every hit for `TODO`, `FIXME`, `placeholder`, `mock`, `fake`, `hardcoded`, `demo` is either a comment explaining why something is NOT faked, a legitimate `placeholder` prop, or the `"fake"` member of a gateway union that only tests construct — `grep -rn 'kind: "fake"' src app shared` returns nothing. No `onPress={() => undefined}` or `onPress={() => {}}` remains in the product. |

The sweep was run with a zsh **array**, and prints its file count before its
result, because the phase 2 version reported nine directories clean before it had
scanned a single file.

---

## D. Measured

Stack live throughout; the database was not reset during this phase (phase 4
reset it from empty and the migration head is unchanged).

| Check | Before | After |
|---|---|---|
| `npx tsc --noEmit` | clean | clean |
| `npm run lint` | 0 errors, 37 warnings | 0 errors, 37 warnings |
| `npm run check:functions` | all 3 typecheck | all 3 typecheck |
| `npm run test:unit` | 105 files / 2,052 | **112 files / 2,183** |
| `npm run test:server` | 16 files / 167 | **17 files / 175** |
| `npm run contrast:check` | 46 pairings, 0 failing | 46 pairings, 0 failing |

`tsc` caught a defect the runtime did not: `tests/table/split-hands.test.ts`
built a `Card` without `deckIndex`, and vitest ran it green because vitest does
not typecheck. Worth recording — a test that passes is not a test that compiles.

---

## E. Runtime QA — driven on the simulator, not reasoned about

Built and installed with `LANG=en_US.UTF-8 npx expo run:ios`, Metro live, the
Supabase stack live, on **iPhone 17 Pro (iOS 26.5)** unless stated.

| Flow | Result |
|---|---|
| `practice-hand.yaml` | **exit 0**, every step COMPLETED — a hand played to settlement and the next one started |
| `career-node.yaml` | **exit 0**, all 20 hand iterations, `career-result-done` reached and stars progressed |
| `online-table.yaml` | **exit 0** after the flow was updated for A1 — see below |
| `every-screen.yaml` | **exit 0**, with `.env.local` moved aside as `CLAUDE.md` requires |

Step counts were read from the log rather than trusted to the exit code: a
Maestro run with no booted simulator exits 0 having done nothing, and the tell is
the absence of `COMPLETED` lines.

### `online-table.yaml` failed on its last step, and the failure was the fix

The flow reached hand 12, tapped "Leave table", and then could not find Home. The
failure screenshot is the evidence, and it shows four of this phase's changes
working at once on a real device against a real server:

```
  Hand 2 · Shoe 1                                        ← A6, progress line
  6 decks · dealer stands soft 17 · blackjack pays 3:2
        · double after split · late surrender            ← A6, rules line
  YOU                                          1,950     ← A6, own stack
  ┌─────────────────────────────────────────────┐
  │ Leave this table?                           │
  │ Your seat closes and 1,950 chips return to  │        ← A1, the confirmation
  │ your balance. You cannot rejoin this table  │
  │ afterwards.                                 │
  │             [ Stay ]  [ Leave table ]       │
  └─────────────────────────────────────────────┘
```

The amount in the dialog matches the stack rendered above it, because both come
from the same snapshot. The flow predated the confirmation, so it was updated to
answer it — and it now asserts the dialog rather than merely surviving it. With
that, it passes end to end, including the assertion that **matters most**: after
leaving, reopening Quick Play does not answer "you are already seated at a
table". The confirmation did not break the cash-out.

### The rename, driven through its own control

`tests/server/profile-rename.integration.test.ts` proves the request. It does not
prove a player can reach it — the exact gap that has cost this project three
defects — so the control was driven on the device with a temporary flow (not
committed; its assertions live in the two test files).

Two runs were needed, and the first one is worth recording:

1. `inputText` without a preceding `tapOn` typed into nothing. The fields stayed
   unchanged and **Save stayed correctly disabled** — `hasChanges` gating the
   button, proved by accident.
2. `tapOn` the field, then type — and then the assertion `.*Phase Five.*`
   **passed while the save had not happened**, because it matched the text still
   sitting in the input. The screenshot showed the editor still open and the
   header still reading the old handle. On iOS the first tap outside a focused
   `TextInput` is consumed dismissing the keyboard, so the tap on Save landed on
   nothing.

Fixed with `hideKeyboard` first, and by asserting the RESULT — the editor
closing, which only happens on success. The final screenshot shows the header
reading **"Phase Five"** with **@p8bce5180caaa** unchanged beneath it: only the
field that moved was sent, which is `changedFields` doing its job.

That is the third time this phase that an assertion on a tap, or on an input,
would have passed over a failure. **Assert the result.**

### A8. The chip row rendered as two ellipses with the labels spilling out

Found by looking at the screen, which is the only way it could have been found.

`HandSelector`'s `ScrollView` carried no `flexGrow: 0` and its content container
no `alignItems: "center"`. Inside Practice's `playerArea` — a column with
`flexGrow: 1`, `minHeight: 200` and `justifyContent: "center"` — the ScrollView
expanded to the space available and its children stretched to match it. With
`borderRadius: radius.pill` (999) on a box two hundred points tall, the result is
an **ellipse**, with "Hand 1 · 13" written across the middle and out of it.

Everything about it was correct except the rendering: the right two hands, the
right totals, the right one marked active, the right single hero hand beneath.
`tsc`, `lint` and 21 unit assertions were all green, and none of them can see a
shape.

Fixed with `flexGrow: 0` on the ScrollView and `alignItems: "center"` on the row,
and **re-captured on the device** — proper pills, sized to their labels:

```
  ( Hand 1 · 16 )  ( Hand 2 · 15 )        ← accent border on the active one
  ┌──────────────┐
  │  J♣      6♠  │
  │ Hard 16 · Bet 100 │                   ← only the active hand at hero size
  └──────────────┘
  [ Hit ] [ Stand ]  [ Double ] [ Split(disabled) ]
```

The split had to be provoked to see it at all: no committed flow splits, because
every one of them stands. A temporary flow played Practice until `action-split`
was **enabled** — `enabled: true` in the selector, not merely visible, because
`ActionDock` renders an illegal action disabled rather than hiding it and a tap
on the greyed button would have COMPLETED and done nothing.

### Form factors

| Device | Checked |
|---|---|
| iPhone 17 Pro (notched, 1206×2622) | all four flows above |
| iPhone 17e (smaller, 1170×2532) | `online-table.yaml` **exit 0** on an idle machine — 12 hands, the leave confirmation, the cash-out, and the server confirming the seat was released. Plus the split capture above. |

The first small-phone attempt was made at **load average 142** — a second
simulator booting while Metro re-bundled — and the Quick Play buy-in did not
complete. Rather than retry into a green tick, the machine was brought back to
idle first (`until [ load < 8 ]`), and the same flow then passed on the same
commit. That is the condition `CLAUDE.md` documents for Maestro, met head on: an
`npx expo run:ios` build drives load past 85 and Spotlight indexes the fresh
DerivedData for minutes afterwards. **Build, wait for idle, then run flows.**

### Harness notes worth carrying forward

- The simulator got into a **broken install state** mid-session: `simctl
  get_app_container` returned a `com.arc21.app-<timestamp>.app` placeholder path
  and every launch failed with `FBSOpenApplicationServiceErrorDomain code=1`.
  `simctl uninstall` + `simctl install` from DerivedData fixed it — and checking
  the container path FIRST is what distinguished it from an app regression, as
  `CLAUDE.md` already advises.
- Separately, the XCUITest driver refused to start (`Failed to connect to
  127.0.0.1:54474`, repeating). Killing `maestro-driver-ios`, shutting the
  simulator down and rebooting it cleared it.
