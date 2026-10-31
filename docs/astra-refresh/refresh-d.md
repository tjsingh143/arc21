# Astra Refresh D — Home and Play product hierarchy

**Integration status (October 30, 2026):** Refresh D passed independent Astra
review and was merged into `main` through
[PR #6](https://github.com/tjsingh143/arc21/pull/6), merge commit
[`d6a82c25fd13379b7ac9cd64530432366320b511`](https://github.com/tjsingh143/arc21/commit/d6a82c25fd13379b7ac9cd64530432366320b511).
The approved implementation commit `6963ba63276852bfd2801b83ae83d9b3b062b699`
and the Expo SDK 57 patch-alignment commit
`6439bc5bf013f376e151dccbe5870f609c1a8f87` are preserved. The PR head passed
[both hosted CI jobs](https://github.com/tjsingh143/arc21/actions/runs/41005500200)
before the merge, and the separate
[post-merge `main` CI](https://github.com/tjsingh143/arc21/actions/runs/41112209782)
on the merge commit also passed both jobs. Integration is not a production or store
deployment; physical-device VoiceOver (§10.7) remains unverified, and Refresh E
has not begun. See [Launch State](../LAUNCH_STATE.md) for current status. The
record below is retained as written at its checkpoints, including the
uncommitted and awaiting-review statements that follow.

**Current status: local implementation, awaiting independent review.** The
changes are in the working tree of branch `refresh-d-home-hierarchy`. At the time
of writing they are uncommitted, not pushed, not merged into `main` and not
deployed. This record is not an approval: a bounded independent review decides
D's closure. Refresh E has not begun.

D is client-only. No blackjack rule, shuffle, hidden-card boundary, payout,
progression accounting, wire contract, migration or Edge Function changed.

§§0–8 are the first session's record, which ended without native evidence
(§6). §9 is the native verification session of 2026-10-28, which built, ran and
repaired against it; nothing above §9 was rewritten to look as though those
checks had already passed. §10 is the acceptance-gap session of 2026-10-29,
which repaired the large-text breaks and one offline message, and records its
own evidence without revising §9.

---

## 0. Baseline

- **Starting point:** `origin/main` = `ae70b9bf34681e19572656ddbaf871c6991be9de`
  (`docs: enforce neutral implementation attribution`), fetched on 2026-10-28.
  It matches the handoff commit and contains the Refresh C merge
  `9eba544ca2d7fb115dc75dcdd0ec078cea479564` (PR #5).
- **Prior checkout:** `refresh-c-ai-tables` @ `6a3eca5`, with no tracked
  modifications. It is an ancestor of `origin/main`, and the two differ only in
  nine documentation files. No untracked file collided with the target tree.
- **Branch:** `refresh-d-home-hierarchy` created at `ae70b9b`. The session's
  shell sandbox refused writes to `.git/config`, so `git switch -c` updated the
  index and working tree, then stopped before moving `HEAD`. `HEAD` was then
  pointed at the new branch with `git symbolic-ref`. Index and working tree
  were verified equal to `origin/main` before that step. **No upstream is
  configured** for the branch.
- **Untracked files left as found:** `AGENTS.claude-backup.md` (protected:
  unread, unmodified, unstaged); `.serena/.gitignore` and `.serena/project.yml`.
  `.claude/settings.local.json` was written during this session by
  `cc-init --sandbox-only`, at the operator's choice, to give the sandboxed
  shell read access to the repository. It is not part of D.

## 1. Before and after

| Surface | Before D | After D |
|---|---|---|
| **Play** order | Flat list: Practice, Career, Quick Play, Public Table, AI Table, Sprint, Daily | Three sections: **Play for chips** (*With other people*: Public, Private, Sprint; *Solo, against the dealer*: Quick Play, Daily), **AI Tables**, **Practice and progress** (Practice, Career, plus Learn and Leaderboards links) |
| Private tables on Play | Absent (reachable only from Social) | A card opening the existing lobby, `/table/lobby` |
| Play card claims | One generic sentence per mode ("Online play uses your server-recorded chips.") | A facts line built from classified fields: who is at the table, whose chips, what it counts toward |
| **Home** (ready player) | Quick Play, Practice, Career, mastery, six tiles | Held-seat return (if any), then **Play for chips** (a table with other people, then Quick Play labelled solo, then Daily and Sprint links), **AI Tables**, **Practice and progress**, links |
| Home human multiplayer | No entry | "Find a public table" (primary) and "Private table with friends" |
| Home AI Tables | No entry | A card opening `/table/ai`'s terms screen |
| Home held seat | Not shown (Play only) | "Return to your table" above everything, or "could not check" when the lookup fails |
| Home without a ready player | Practice, Career, a generic "Online" note | Practice first, then one card stating why online play cannot open (unconfigured / server not answering / connecting / no player) with **Connect** where it can help |
| Card controls | Pressable cards wrapping a Button with the same action | Inert cards; the Button is the one control (Home). Play cards: one labelled pressable, no inner Button |

## 2. The hierarchy, as implemented

`src/features/home/product-hierarchy.ts` is the single definition, rendered by
both `app/(tabs)/home.tsx` and `app/(tabs)/play.tsx`. It is pure, with no React
Native import, so all of it runs under the unit suite.

| Tier | Mode | Entry route | Facts line rendered on Play |
|---|---|---|---|
| Play for chips · with other people | Public Table | `/table/public` | With other players · Buy-in from your chips · Counts toward XP, statistics and accuracy |
| | Private Table | `/table/lobby` | With other players · Table chips only · Counts toward XP and statistics |
| | Sprint Tournament | `/tournament` | With other players · Entry fee from your chips · Counts toward XP and statistics |
| Play for chips · solo | Quick Play | `/table/quick` | Solo · Buy-in from your chips · Counts toward XP, statistics and accuracy |
| | Daily Challenge | `/daily` | Solo · No buy-in · Counts toward XP, statistics and accuracy |
| AI Tables | AI Table | `/table/ai` | With computer players · Table chips only · Unranked: no XP, statistics or accuracy |
| Practice and progress | Practice | `/game/practice` | Solo · Practice chips, kept on this device |
| | Career | `/career` | Solo |

**Every claim is a field held equal to what the server enforces**
(`tests/home/product-hierarchy.test.ts`):

- *Buy-in from your chips* ⇔ `WALLET_BACKED_MODES` (`session-economics.ts`).
- *Entry fee* only for the Sprint, at `SPRINT.entryFee`. Its hands and
  elimination hand are also held to `SPRINT`. `create-session`'s only wallet
  debits are table buy-ins and the Sprint entry, which is why the Daily
  Challenge reads *No buy-in*.
- *Counts toward XP and statistics* ⇔ `SETTLEMENT_RECORDING_MODES`; *…and
  accuracy* ⇔ `ACCURACY_ELIGIBLE_MODES`.
- *With other players* ⇔ the table runs a clock (`handCompletionForMode` is
  `clock`). A clock exists because somebody else is waiting on you. The
  untimed tables are Quick Play, the Daily Challenge, Career and the AI table,
  and only the AI table has anybody else at it.
- Every server session mode except the unused `practice` enum value has a card,
  and every card's route resolves to a file under `app/`. None is
  `/table/[gameId]` or a career session, so no card bypasses a setup screen.
- Quick Play's title, purpose, structure, facts and spoken label are checked
  against wording that would imply company, with a positive control showing the
  pattern catches it.

The AI section's summary is derived from `AI_TABLE_SEAT_COUNT`: "You and 2
computer players, each labelled AI, deciding and dealt on the server from the
same fair shoe. Unranked, with table chips only: nothing moves to or from your
balance."

## 3. Interaction and state decisions

1. **"Ready" means the server has vouched for the player and is still
   answering.** `onlineAvailability` is ready only when `useAuthStore.session` is
   set (the adapter sets it only after the server answers for the credential,
   B-G1) and connectivity is not `offline`. Configuration is read from
   `getSupabase()`. The auth store's `configured` copy is false until `hydrate`
   runs, so using it would have printed "no server configured" for a moment on
   every configured launch.
2. **Without a ready player, Practice leads Home** and one card names the
   reason. No functioning mode is hidden: Daily and Sprint move into Home's links,
   and Play keeps every card with an explanation and a **Play Practice** button
   above them.
3. **The held seat is asked about on Home.** For a ready player Home calls
   `my_active_session()` whenever it comes into focus. A held seat makes the
   server refuse every new table, so the return card sits above the tables Home
   would otherwise offer. The public-table button drops to secondary while it is
   shown. Asking on focus rather than once is deliberate, because a tab stays
   mounted and a player returning from a cash-out would otherwise be offered a
   table they had left. This adds one RPC per Home focus for a ready player.
4. **An unanswered lookup is never "no seat".** `homeResume` maps any
   `unavailable` status to `unknown`, rendered as "Arc 21 could not check whether
   you are still seated at a table…" with **Check again**, on Home and Play.
5. **Account replacement.** `homeResume` shows nothing to a player who is not
   ready, as a second lock beside `resetPlayerState`. The store's scoped setter
   drops a previous player's late answer, which is proven through the production
   store and reset in `tests/home/home-resume-scope.test.ts`. Play's lookup moved
   from once-at-mount to on-focus, keyed on the player, so a player confirmed or
   replaced after the tab first mounted is asked about.
6. **Inert cards, one control.** Every Home card is a plain container whose
   Button is the only control, so its lines stay separate accessibility elements
   in reading order. `home-practice` stays on the Practice button, the element
   flows have always tapped. Play cards remain single labelled pressables whose
   label now includes the Online/Offline badge and the facts line.
   `Tile`'s label now carries its detail, which it previously held only as a
   hint. Tier headings are announced as headers.
7. **Quick Play keeps its memory.** The remembered stakes and assistance still
   head its Home card. Its button opens the setup screen ("Open Quick Play"),
   which confirms the buy-in before anything is spent; it no longer reads
   "Deal", which promised a deal the button does not perform.
8. **No new routes.** Private tables use `/table/lobby`; AI Tables use
   `/table/ai`.
9. **Back control wording.** `app/table/ai.tsx` and `app/table/quick.tsx`
   labelled their back control "Back to Play". D adds Home entries to both, and
   `BackBar` returns to whichever screen opened them (or Home on a cold link), so
   both now use the default "Back".

## 4. Files

| File | Change |
|---|---|
| `src/features/home/product-hierarchy.ts` | **New.** Tiers, modes, claims, sections, links, `onlineAvailability`, `homeResume`, `homeLayout` |
| `app/(tabs)/home.tsx` | Rendered from `homeLayout`; new tiered blocks; held-seat return; inert cards; `home-screen` anchor |
| `app/(tabs)/play.tsx` | Rendered from `PLAY_SECTIONS`; facts lines; unavailable note with Practice; resume via `homeResume` on focus |
| `src/components/ui/Card.tsx` | `SectionHeading`; `Tile` label carries its detail |
| `src/features/home/play-mode-presentation.ts` | `modeAccessibilityLabel` speaks the badge and the facts line (optional fields; existing output unchanged) |
| `app/table/ai.tsx`, `app/table/quick.tsx` | `BackBar` label (decision 9) |
| `tests/home/product-hierarchy.test.ts` | **New**, 44 tests |
| `tests/home/home-play-screens.test.ts` | **New**, 8 tests |
| `tests/home/home-resume-scope.test.ts` | **New**, 4 tests |
| `tests/e2e/home-hierarchy.yaml` | **New** native flow (§6) |
| `tests/e2e/ai-table.yaml` | After the mid-hand kill, Home must show the held AI seat's return card |
| `tests/e2e/every-screen.yaml` | Play reached and asserted by its own ids; stale assertion replaced (§5.4); unconfigured Home asserts Practice first |
| `tests/e2e/practice-{hand,analysis,resume}.yaml` | Scroll to `home-practice` before tapping it |
| `tests/e2e/career-map-return.yaml` | Career card by `play-mode-career` |
| 15 further flows | "Home is showing" anchor `home-practice` → `home-screen`. Kept as `home-practice` where no player is confirmed and Practice is what is proven: `refresh-b/offline-practice`, `offline-existing-launch`, `erased-account-launch` |
| `docs/ROUTES.md`, `README.md`, `docs/LAUNCH_STATE.md`, `docs/RELEASE.md`, `AGENTS.md`, `CLAUDE.md` | Current-truth updates only |

## 5. Tests and evidence

### 5.1 Red before green

The screen-contract file was run against the unchanged Refresh C screens before
either was edited: **7 of its tests failed**. Play kept its own `MODES` list,
Home had no layout model, pressable cards wrapped Buttons, and there was no
`home-screen` anchor. The model and account-scope tests passed at that point,
having been written against the new module. After the screens were rebuilt,
all passed.

### 5.2 Mutations (each must fail tests)

Each mutation was applied to `product-hierarchy.ts`, `tests/home` was run, and
the file was restored and verified byte-identical with `cmp`.

| Mutation | Result |
|---|---|
| M1 Quick Play classified as "with other people" | 3 failed |
| M2 Private table claims a wallet buy-in | 1 failed |
| M3 AI Tables above chip tables on Home | 4 failed |
| M4 An unanswered lookup read as "no seat" | 2 failed |

### 5.3 Gates (2026-10-28, this host, sandboxed shell)

| Command | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `EXPO_NO_TELEMETRY=1 EXPO_NO_DOTENV=1 npx expo lint` | exit 0 — 0 errors, 21 warnings, none in a file D changed |
| `npx vitest run tests/home` | 4 files, 67 tests passed |
| `npm run test:unit` | 3,112 passed, **1 failed (environmental, §5.5)**, 156 files |
| `COVERAGE=1 npx vitest run --coverage --exclude tests/career/catalogue-sql.test.ts` | exit 0 — 153 files, 3,082 tests, every per-area threshold met |
| `node --import tsx scripts/check-contrast.ts` | exit 0 — 50 + 2 pairings, 0 failing (D adds no token or pairing) |
| `EXPO_NO_TELEMETRY=1 EXPO_NO_DOTENV=1 bash scripts/bundle-check.sh $TMPDIR/arc21-export` | exit 0 — iOS Hermes bundle 6.5 MB |
| `npx expo-doctor@latest` (temp npm cache) | 19/21; the 2 failures are network lookups the sandbox refused (`ENOTFOUND exp.host`, React Native Directory) |
| `git diff --check` | clean |

**Not run, with reasons.** `npm run test:server`, `supabase test db` and
`npm run check:functions` were not run: D changes no server code, contract,
migration or function, and the sandboxed shell cannot reach Docker. The RPC Home
now calls, `my_active_session()`, is covered by the existing server and pgTAP
suites.

### 5.4 A stale native assertion repaired

`tests/e2e/every-screen.yaml` asserted `.*Needs an account.*` on the Play tab.
That copy stopped rendering in `2476511` (Refresh B), and `refresh-b.md` records
the flow as not re-run since. It now asserts `play-online-unavailable` and
`.*no server configured.*`. The flow also reached Play by waiting for
`.*Sprint Tournament.*`, which Home's new Sprint link would satisfy on Home
itself, so it now waits for `play-screen`.

### 5.5 Environmental limitations of this session

The Bash sandbox denies local socket binding, reads of `.env.local`, writes under
`~/.expo`, `~/.npm/_npx` and `.git/config`, CoreSimulator and DerivedData, and
some network hosts.

- `tests/career/catalogue-sql.test.ts` spawns the `tsx` CLI, whose IPC pipe
  cannot `listen` (`EPERM`). Its assertion was reproduced with
  `node --import tsx scripts/generate-career-nodes.ts --stdout`, whose output is
  **byte-identical** to `supabase/migrations/20260823120000_career_catalogue.sql`.
  D changes none of its inputs.
- `expo lint` and `expo export` were run with `EXPO_NO_DOTENV=1` and
  `EXPO_NO_TELEMETRY=1`. The bundle is therefore the unconfigured one CI builds,
  since `.env.local` is gitignored.

## 6. Native verification — not performed

**No iOS build or Maestro run was possible in this session**: `xcrun simctl`
cannot reach CoreSimulator and DerivedData is unreadable from the sandbox. Large
text sizes, VoiceOver reading order, safe areas and touch behaviour are
therefore **unverified on a device**. The flows below were written and reviewed
against the rendered strings and testIDs, but none has run.

Steps for the independent run (Release build of this working tree, idle host;
check `uptime` first):

```sh
export PATH="/opt/homebrew/bin:$PATH"
LANG=en_US.UTF-8 npx expo run:ios --configuration Release --device <UDID> --no-bundler
export JAVA_HOME=/opt/homebrew/opt/openjdk

# Connected (.env.local present; supabase start; npx tsx scripts/e2e-account.ts)
maestro --device <UDID> test tests/e2e/home-hierarchy.yaml
maestro --device <UDID> test tests/e2e/ai-table.yaml
maestro --device <UDID> test tests/e2e/practice-hand.yaml

# Unconfigured (.env.local moved aside, rebuilt)
maestro --device <UDID> test tests/e2e/every-screen.yaml
```

Then sweep the other flows whose anchor changed (§4), and repeat Home and Play
at `accessibility-extra-extra-extra-large` with VoiceOver.

**One open question about Maestro itself.** This repository's notes disagree on
whether a Maestro `visible` condition matches an element scrolled out of view.
`every-screen.yaml` waited successfully on a below-the-fold card, yet records a
scrolled-off header "reading as a missing screen". The `home-screen` anchor is
on the always-visible scroll container, as `+not-found`'s `not-found` id already
is in passing flows, so the anchor holds under either reading. Taps scroll
first, because `tapOn` does not scroll under either.

## 7. Observations, deferred, not changed

1. **Private-table XP versus the lobby's copy.** `app/table/lobby.tsx` says
   "Unranked. Hands here do not count towards leaderboards." The server
   records private-table hands as statistics and repeatable XP.
   `SETTLEMENT_RECORDING_MODES` lists `private_table`, `game-command/index.ts`
   writes for every mode in it, and `two-client-table.integration.test.ts`
   asserts `hands_played: 1` and 5 XP at a private room. Repeatable XP is the
   weekly XP board's input. D's Play card states what the server does. Which of
   the two should change is a product decision and was not made here.
2. **Social's private-table card** carries `accessibilityLabel="Private table"`
   on a pressable, which hides its body from a screen reader. This is the defect
   class D removed from Home and Play, on a screen D does not own.
3. **The AI table's action dock can sit below the fold** (Refresh C §11
   observation 5). That is the table screen, not Home or Play.
4. **The Daily card's "20 hands"** is the shipped default. A challenge row may
   carry another count, and the Daily screen states the real one.

## 8. Excluded from D

Refresh E; any change to rules, shuffling, settlement, wallet, progression,
contracts, migrations or Edge Functions; GitHub publication, merge, deployment
and store work; a general audit of earlier milestones.

## 9. Native verification and completion — 2026-10-28 (PDT)

A second bounded session, with the shell sandbox disabled, on the same host.
Everything below was measured in that session; nothing was carried over.

### 9.1 Preflight

**Git.** `refresh-d-home-hierarchy`, `HEAD` = `ae70b9bf34681e19572656ddbaf871c6991be9de`
= `origin/main`, nothing staged, one worktree, `git fsck` clean, no lock files,
`git diff --check` clean. The reflog shows the first session's `symbolic-ref`
move (an entry with an empty message, `6a3eca5` → `ae70b9b`). It was checked
rather than trusted: every file that differs between those two commits and that D
did not edit is byte-identical to `ae70b9b`, and in the five D also edited, every
line `ae70b9b` added is present except the three "Refresh D/E have not begun"
sentences D replaced. The branch still has no upstream, which is harmless with
nothing to push, and was left as it is. `AGENTS.claude-backup.md`, `.serena/` and
`.claude/settings.local.json` were not read, modified or staged.

**Native tools.**

| Check | Result | Class if it failed |
|---|---|---|
| Xcode | 26.6 (17F113), `/Applications/Xcode.app/Contents/Developer` | — |
| Simulator runtime | iOS 26.5 (23F77); iPhone 17 Pro booted, `simctl spawn` and `io screenshot` worked | — |
| Unix sockets | bind + listen in the scratch directory worked | — (EPERM in session 1) |
| DerivedData | writable | — (unreadable in session 1) |
| Maestro | 2.8.0, with `JAVA_HOME=/opt/homebrew/opt/openjdk` as CLAUDE.md documents | B without it |
| Docker | not running at start, socket present; `open -a Docker` → 29.7.2 | C (stopped service) |
| Supabase | `supabase start` (no reset); 63 of 63 migrations applied, last `20261017120000`; REST 200; `game-command` 401 once `supabase functions serve --no-verify-jwt` was started | C |
| Host | 8 cores, 8 GB RAM, swap 7.5–13.8 GB in use; load 5 at start, 100–210 during the native build and while macOS `mediaanalysisd` ran | D |

`.env.local` was not read: the operator's safety hook refused a command naming
it, and it was not worked around. Configuration was established from the built
bundle instead (§9.2).

### 9.2 Fresh Release builds

Fingerprint: SHA-256 over `git diff HEAD` plus D's six new files (the protected
and tool files excluded).

| | Connected | Unconfigured |
|---|---|---|
| Command | `LANG=en_US.UTF-8 npx expo run:ios --configuration Release --device <UDID> --no-bundler` | the same, prefixed `EXPO_NO_DOTENV=1` — `.env.local` stays in place |
| Device | iPhone 17 Pro `D16C4292-…`, iOS 26.5 | iPhone 17e `CD295409-…`, iOS 26.5 |
| Tree | `d1c8389f…0531` | `064d8927…5503` — differs from the connected build by Maestro YAML only; no `app/` or `src/` change between them |
| Result | Build Succeeded, 0 errors, 3 warnings, installed, exit 0 | Build Succeeded, 0 errors, installed; the CLI then exited 1 inside its post-install `simctl openurl` of a dev-client URL (stack trace in `openUrlAsync`), after the install |
| Bundle id | `com.arc21.app` | `com.arc21.app` |
| `main.jsbundle` | 20:45:33; contains `home-screen`, "Find a public table", the §9.4 lobby sentence; **not** the old lobby sentence; contains the local server URL | 22:06:38; Refresh-D strings present; **no** server URL |

The Oct 17 build already on the simulator was replaced and not used as evidence.

**Two environment defects stopped the first build, both in the gitignored,
generated `ios/` directory and neither in Refresh D:**

1. *Stale pod snapshot* (class B). `pod install` refused `ExpoModulesCore`: the
   Pods were installed on Oct 5, and `6a3eca5` (Refresh C, Oct 19) moved
   `expo` and a dozen `expo-*` packages to newer patches. `node_modules`
   matched `package-lock.json` exactly and `app.json` had not changed, so no
   prebuild was needed. Fixed with
   `pod update <27 local Expo pods> --no-repo-update`; `Podfile.lock` equals
   `Pods/Manifest.lock` afterwards.
2. *Broken Node in Xcode's script phases* (class B). `ios/.xcode.env.local`
   pinned `NODE_BINARY=/opt/homebrew/Cellar/node/26.7.0/bin/node`, which no
   longer starts (`dyld: Library not loaded: libsimdjson.33.dylib`; Homebrew's
   simdjson is now 5.0.5). React Native writes that file only when it is missing,
   so a Homebrew upgrade broke it in place. Changed to `/opt/homebrew/bin/node`
   (v26.12.0), Homebrew's stable symlink. The previous value is quoted here.

### 9.3 Maestro, on the fresh builds

Every run's exit code and `COMPLETED` count were checked; logs and screenshots
are in the session's scratch directory, not in the repository (Maestro records
`inputText` values).

| Flow | Build | Result | Notes |
|---|---|---|---|
| `home-hierarchy.yaml` | connected | **PASS**, 73 steps | after the three test repairs in §9.5 (runs 1–3 failed, each classified first) |
| `ai-table.yaml` | connected | **PASS**, 84 steps | includes the held AI seat's return card on Home after a mid-hand kill |
| `practice-hand.yaml` | connected | **PASS**, 22 steps | Practice below the fold, scrolled to and played |
| `practice-analysis.yaml` | connected | **PASS**, 32 steps | |
| `practice-resume.yaml` | connected | **PASS**, 38 steps | first run failed: started on a settled hand left by the two flows before it, against its own documented precondition; rerun after `scripts/e2e-fresh-app.ts` |
| `career-map-return.yaml` | connected | **PASS**, 22 steps | after the anchor repair in §9.5 |
| `career-node.yaml` | connected, fresh app | **PASS**, 28 steps | |
| `refresh-b/fresh-player.yaml` | connected, fresh app | **PASS**, 15 steps | |
| `hostile-deep-link.yaml` | connected | **PASS**, 11 steps | |
| `online-table.yaml` | connected | **PASS**, 59 steps | a real buy-in, hand and cash-out |
| `online-leave-mid-hand.yaml` | connected | **PASS**, 25 steps | first two runs met onboarding at launch: the device had been reset, and `sign-in.yaml` reached the sign-in screen by deep link, which never completes onboarding (CLAUDE.md). Its `when onboarding-sign-in` probe was evaluated before onboarding had rendered. Passed after onboarding was completed through the guest button, then `sign-in.yaml` |
| `sign-in.yaml` (+ `refresh-b/sign-in-existing.yaml`) | connected | **PASS**, 23 steps | after the §9.5 repair |
| `every-screen.yaml` | unconfigured, iPhone 17e | **PARTIAL** — 78 steps, then a failure outside D | Everything D owns passed: Home with Practice first and `home-online-unavailable`, Play by `play-screen` with `play-online-unavailable` and ".*no server configured.*", Sprint and Daily by id. It stopped at step 85, `tapOn: "Statistics"` on the **Profile** screen, which D does not touch (not in its diff) |
| `dead-ends.yaml` | connected, fresh app | **FAIL, pre-existing** | it needs "signed out on a configured build", and since Refresh B (`2476511`) the guest button creates a funded pseudonymous player, so Quick Play shows its setup (balance 25,000) instead of `quick-practice`. Last recorded passing in Refresh A. D changed only its two Home anchors, which completed |
| `cold-deep-links.yaml` | connected | **FAIL, pre-existing** | `auth-username` no longer exists in `app/` or `src/`; it was removed in `2476511` and the flow was last edited on 2026-09-14. D changed only its Home anchors; 25 steps completed first |

**Not run,** each for a stated reason. D changed only their Home anchor
(`home-practice` → `home-screen`), which the flows above exercise:
`refresh-b/offline-reconnect.yaml` (needs Kong stopped and restored),
`refresh-b/unverified-protected-work.yaml` (needs the auth container stopped),
`refresh-b/recovery-complete.yaml` and `password-recovery-retry.yaml` (need a
Mailpit recovery link opened on the device), `social-refresh-after-accept.yaml`
(needs a second account to accept through its own UI), and
`two-client-public-leave.yaml` / `two-client-public-survives.yaml` (two
simulators; this 8 GB host was already swapping 7–13 GB with one).

### 9.4 The private-table copy (§7.1), resolved

Confirmed from source. `private_table` is in `SETTLEMENT_RECORDING_MODES`, so
`game-command` pays repeatable XP and records statistics for it. Supabase's
`leaderboard_weekly_xp` sums `player_daily_xp` across every mode.
`private_table` is not in `ACCURACY_ELIGIBLE_MODES`, so it never reaches strategy
accuracy. "Unranked. Hands here do not count towards leaderboards." was false.

The smallest truthful change was to the copy, with no XP, statistics or
leaderboard rule touched. `recordingSentence(mode)` in `product-hierarchy.ts`
composes the sentence from the same `recording` field that the Play card's facts
line uses, and that field is already held against both server lists. The lobby
now reads "Hands here earn XP for the weekly XP leaderboard and count toward your
statistics, but not toward strategy accuracy." "Unranked" stays for a table that
records nothing, which is only the AI table.

Red before green: `tests/home` was run with the two new tests and before the
change. **2 failed** (the function did not exist, and the lobby kept the old
sentence). After the change, 69 of 69 passed. `home-hierarchy.yaml` asserts the
sentence on the device's lobby.

### 9.5 Repairs

Test-only, with each assertion's behaviour kept:

1. `refresh-b/sign-in-existing.yaml`: it scrolled to "Secured player" and then
   asserted the email beneath it, which was still below the fold (screenshot).
   It now scrolls to the email, the last line asserted, then asserts both.
2. `home-hierarchy.yaml` gained what the acceptance asked for and it lacked. It
   now opens the **Public** setup screen ("Your chips are at stake here") and
   **Quick Play** setup (`quick-balance`, which renders only for a confirmed
   player) and returns from each, pressing nothing that queues, buys or deals. It
   also asserts the §9.4 sentence in the lobby.
3. `centerElement: true` on every scroll-then-tap that D introduced:
   `home-hierarchy` (×3), `practice-{hand,analysis,resume}`, `career-map-return`
   and `every-screen` (Sprint, Daily). Measured cause: with Quick Play's button
   at the clipped bottom edge of Home's scroll view, Maestro counted it 100%
   visible and tapped its centre. That centre was under the tab bar, on the
   Play/Learn boundary, and the screenshot shows the **Learn** tab opened. A
   player sees a half-visible button and scrolls; this is not an app defect.
   `accessibility-settings-persist.yaml` already used the same remedy.
4. `career-map-return.yaml` waited for Play's subtitle after Back. Career is now
   the last card on Play, and Back restores the scroll position it was opened
   from (screenshot: Career on screen, header off it). It now waits for
   `play-screen` and asserts `play-mode-career`, which proves more.
5. `every-screen.yaml` asserted the onboarding labels "Create Account" and
   "Sign In". Refresh B removed account creation from onboarding and labelled
   sign-in "Recover a player", so it now asserts `onboarding-sign-in`.

Application: the lobby copy (§9.4). No other application code changed in this
session.

### 9.6 Visual and accessibility evidence

- **Default size (iPhone 17 Pro).** Home reads Play for chips (With other people:
  "Find a public table" primary, "Private table with friends"; Quick Play · Solo;
  Daily and Sprint links), then AI Tables, then Practice and progress (Practice,
  Career, links). Play reads With other people (Public, Private, Sprint), Solo
  against the dealer, AI Tables, then Practice and progress. Nothing clipped or
  overlapping.
  *Cosmetic:* in a two-tile link row the titles sit at different heights when
  one detail wraps to two lines (Learn beside Friends).
- **Narrower device.** The unconfigured layout passed on the iPhone 17e.
- **Largest Dynamic Type (`accessibility-extra-extra-extra-large`).** Home and
  Play were walked top to bottom and the screenshots read. Body copy reflows,
  buttons stay on one line within `MAX_FIXED_CONTROL_FONT_SCALE`, and the
  "QUICK PLAY · SOLO" overline wraps without truncating.
  **Observation, pre-existing:** on Play, a card title breaks **mid-word** beside
  its badge ("Publi / c / Table"). The `cardHeader`, `cardTitle` (flexShrink)
  and badge (flexShrink 0) styles and the title are identical at `HEAD`; D moved
  that markup into `ModeCard` unchanged. It was not changed here, because those
  styles are the documented fix for a badge clipped to "Offlin", and changing the
  wrap needs its own decision.
  The size was set back to `large` afterwards.
- **Accessibility tree** (`maestro hierarchy`, default size). Home lists, in
  order: header, PLAY FOR CHIPS and its summary, then the people card's overline,
  title, two sentences and two buttons as separate elements, then the Quick Play
  card the same way, then the Daily and Sprint links as "Label. Detail." Lower
  down, Practice reads "Resume your session" and "Bankroll 5,000 · hand 1" as its
  own elements before "Continue Practice". On Play, each card is one element
  whose label is title, Online/Offline, purpose, structure and facts line, and
  each group heading comes before its cards.
- **VoiceOver itself was not operated.** No spoken output was captured. The tree
  above is what VoiceOver traverses, but spoken order, rotor headings and focus
  movement on a real device remain **unverified**.

### 9.7 Automated gates (this session, normal commands, quiet host)

| Command | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx expo lint` | exit 0 — 0 errors, 21 warnings; the only one in a D-touched file is the pre-existing `Array<T>` at `app/table/lobby.tsx:382`, not the changed line |
| `npx vitest run tests/home` | 4 files, 69 passed |
| `npm run test:unit` | **156 files, 3,115 passed, 0 failed**. `catalogue-sql.test.ts`, which failed EPERM in session 1, passes. The increase from 3,113 is the two §9.4 tests. This includes the active-session and account-switch tests (`tests/home/home-resume-scope.test.ts`) |
| `npm run test:coverage` | exit 0 — 154 files, 3,089 tests, every per-area threshold met (the solver and server tests are excluded from the coverage run by `vitest.config`) |
| `npm run contrast:check` | exit 0 — 50 + 2 pairings, 0 failing |
| `npm run bundle:check` | exit 0 — iOS Hermes bundle 6.5 MB |
| `npm run doctor` (`expo-doctor@latest` 1.21.5) | **20/21**. The one failure is patch drift: `expo` 57.0.31, `expo-network` 57.0.3, `expo-notifications` 57.0.24 and `expo-router` 57.0.29 are expected, against 57.0.30 / 57.0.2 / 57.0.23 / 57.0.28 installed. Those versions were published on 2026-10-21/22, after the lockfile's last change (`6a3eca5`, 2026-10-19). D changes neither `package.json` nor the lockfile. The remedy is `npx expo install --fix`, a dependency change outside this assignment; `expo.install.exclude` would only make the check blind. Session 1's 19/21 came from network lookups the sandbox refused, which now succeed |
| `git diff --check` | clean |

Not run: `npm run test:server`, `supabase test db`, `npm run check:functions`.
Neither session changed server code, a contract, a migration or a function, and
no evidence here contradicts the Refresh C closure. The RPC Home calls,
`my_active_session()`, was exercised live by `ai-table.yaml`'s return card.

### 9.8 Files changed in this session

| File | Change |
|---|---|
| `src/features/home/product-hierarchy.ts` | `recordingSentence` (§9.4) |
| `app/table/lobby.tsx` | lobby line from `recordingSentence(PLAY_MODES["private-table"])` |
| `tests/home/product-hierarchy.test.ts` | +1 test (now 45) |
| `tests/home/home-play-screens.test.ts` | +1 test (now 9) |
| `tests/e2e/home-hierarchy.yaml` | Public and Quick Play routes, lobby sentence, centred scrolls |
| `tests/e2e/refresh-b/sign-in-existing.yaml`, `career-map-return.yaml`, `every-screen.yaml`, `practice-{hand,analysis,resume}.yaml` | §9.5 |
| `docs/astra-refresh/refresh-d.md` | this section and the pointer under the title |
| `ios/Pods`, `ios/Podfile.lock`, `ios/.xcode.env.local` | gitignored, host-local (§9.2) |

Whole working tree against `ae70b9b`: 34 tracked files modified and 6 new D files
untracked; nothing staged, committed or pushed.

### 9.9 Status

All three tiers render on device in the intended order, and every new entry
lands on its setup screen. The flows D's change touches pass on fresh Release
builds, Practice, AI Tables, Career and online play keep working, and the copy
contradiction is fixed. **Still open:** VoiceOver speech (§9.6); the
not-run orchestrated flows (§9.3); the pre-existing failures in `every-screen`
(Profile, after D's sections), `dead-ends` and `cold-deep-links`, all from
before D; the large-text mid-word break on Play; Expo Doctor's upstream patch
drift. An independent review decides D's closure, not this record.

## 10. Acceptance-gap closure — 2026-10-29 (PDT)

A third bounded session on the same host, branch and `HEAD`. It closed the gaps
§9.9 left open: the large-text breaks, the unexecuted and failed flows, and an
accessibility audit. Everything below was measured in this session. §9's results
are cited only where §10.9 says they still apply.

### 10.1 Preflight

`refresh-d-home-hierarchy`, `HEAD` = `ae70b9bf34681e19572656ddbaf871c6991be9de`,
nothing staged. The 34 modified tracked files and the 6 new D files matched
§9.8. `AGENTS.claude-backup.md` and `.serena/` were not read, modified or
staged. Host: 8 GB of RAM, with 11.1 of 12.3 GB of swap in use at the start, so
every native run used one simulator, sequentially. Supabase was already running
(the Edge runtime was stopped and was started with
`supabase functions serve --no-verify-jwt`). Kong and GoTrue were each
`docker stop`ped for the offline proofs and started again straight afterwards.
The database was neither reset nor written by hand. Every query below is a
read.

### 10.2 Large text: three layout defects, fixed

**Reproduced first**, on the iPhone 17e (390 pt) at
`accessibility-extra-extra-extra-large`, using §9's unconfigured build:

- **Play:** "Priva / te / Table" and "Sprin / t / Tourn / amen / t" beside the
  badge.
- **Home link tiles**, two to a row: "Lear / n", "Chall / enge", "Sprin / t",
  "Frien / ds"; and in the details, "strateg / y" and "everyo / ne". **§9.6
  walked Home at this size and missed these.** This is the same defect class,
  and worse than Play's.
- **Home career card** (found after the first two were fixed): "FOUNDATIONS0/".
  The "0/18 ★" badge runs into the overline and is cut off at the card's edge.
  This markup and row style are unchanged from `HEAD`. It is fixed here because
  Home is D's screen.

**Measured causes.**

1. A badge that refuses to shrink beside a title that does, and half-width
   tiles: both leave a word a sliver of width.
2. React Native's own Dynamic Type multipliers. At AX5 React Native scales by
   **3.571**, not iOS's 3.12 (`RCTAccessibilityManager.mm`). Card-title words
   were measured with CoreText in the system semibold face. At that scale,
   "Tournament" in the 19 pt card title is about 359 pt, and "Leaderboards" in
   the 16 pt tile title about 350 pt. The text column is 324 pt on a 390 pt
   phone and 309 pt on a 375 pt one (the width less 2 × (16 + 1 + 16)). So even
   a full-width title still breaks inside its widest word.

**Fix**, following the repository's existing idiom (`rowStacksAtFontScale`,
already used by `ScreenHeader` and the assistance selector):

- **Play card header:** above `STACK_ABOVE_FONT_SCALE`, the badge goes under
  the title (`cardHeaderStacked`).
- **Link tiles:** one to a row, on Home and on Play. `inRows(items, perRow)`
  moved from `home.tsx` into `product-hierarchy.ts`, so the two screens share
  one definition. Its old comment, "so a large text size still leaves each a
  readable width", was what the screenshot disproved.
- **New `MAX_TITLE_FONT_SCALE = 2.9`** in `type-metrics.ts`, applied to the
  Play card title and the `Tile` title. `Tile` is used only by Home and Play.
  The value is the widest word's fit in the narrowest column
  (309 / (19 × 5.294) = 3.07), less 5% for the gap between a CoreText
  measurement and the device. It applies only at React Native's two largest
  sizes (3.143 and 3.571). Body copy still scales all the way.
- **Home career card header** stacks the same way.

**Red before green.**
- `tests/design/font-scale-stacking.test.ts` gained 4 tests; 2 failed before
  the change. One fails on any title word nobody has measured; one is a
  positive control showing the cap is needed.
- `tests/home/home-play-screens.test.ts` gained 4 tests: 3 for the Play and
  tile layout (all red), then 1 for the career header (red).

**Native evidence**, Release builds of this tree:

| Device · size | Result |
|---|---|
| 17e · `large` | Unchanged: badge beside the title, tiles two across |
| 17e · `extra-extra-extra-large` (1.353, just below the threshold) | Tiles two across. "Leaderboards", "Daily Challenge" and "Sprint Tournament" whole; Sprint Tournament beside its badge |
| 17e · AX5, connected | All eight Play titles whole, each badge on its own line ("Tournament" measured about 292 pt on screen, against 291.7 predicted). Home walked top to bottom; every tile one per row and whole |
| 17e · AX5, unconfigured | Not-ready Home walked to the footer: Learn, Daily Challenge, Sprint Tournament, Friends, Leaderboards each whole. Career header "FOUNDATIONS" / "0/18 ★" stacked |
| **iPhone SE (3rd generation), 375 pt** · AX5 | "Sprint / Tournament" and "Leaderboards" whole, with room to spare. This is the narrowest column the cap was sized for. The simulator was created for this check and deleted afterwards |

Before-and-after screenshots are in the session's scratch directory.

**Residual, not changed:** body copy can still break inside one very long word
at AX5 on a narrow phone, for example the career node summary's "recommende / d".
`CLAUDE.md` keeps body copy uncapped on purpose, and the text is career content
that D does not own.

### 10.3 Offline Home named the wrong reason: fixed

Running the offline flows with D's own state asserted turned up a D defect.
With Kong stopped, an **existing** player's Home card read: "Online tables need
your player identity, which connects without an email or password." Beneath
it, the bootstrap's own caption said "Could not reach the server."

**Cause.** The connectivity store only calls itself offline after
`OFFLINE_AFTER_FAILURES = 2` transport failures in a row. A failed bootstrap
reports one. So `onlineAvailability` fell through to its no-player branch,
even though the auth store held `bootstrapFailure.code === "NETWORK"`.

**Fix.** `onlineAvailability` takes a required `serverUnreached`, which both
screens pass from `bootstrapFailure?.code === "NETWORK"`, and it reads that
state as offline. A required field means neither screen can omit it.

**Red before green.** 2 tests failed before the change.

**On device after the fix.** The card reads "The Arc 21 server is not
answering, so online tables cannot open right now. Practice, Career and Learn
keep working." for an existing player with Kong stopped, a player with only
GoTrue stopped, and a brand-new player. Client-only: no server, contract or
connectivity rule changed.

### 10.4 Builds

| Build | Source fingerprint (SHA-256 of `git diff HEAD` + D's new source and test files) | Used for |
|---|---|---|
| Connected, 01:27 | (large-text fix only) | the first AX5 captures and the first passing `home-hierarchy` run |
| Connected, 02:03 | `69fe13c1fca780f6` (+ §10.3) | sequences A, B and C; audit development |
| Unconfigured, 04:21 | `faf6d8b1768eeabe` (+ career header) — **final** | `every-screen`, not-ready Home at AX5, unconfigured audit |
| Connected, 04:34 | `faf6d8b1768eeabe` — **final** | `home-hierarchy`, sequence B, connected audit, the SE check |

Every build was `npx expo run:ios --configuration Release --device <17e>
--no-bundler`. The unconfigured ones were prefixed `EXPO_NO_DOTENV=1`, and
`.env.local` was neither moved nor read. Each finished Build Succeeded with
exit 0. Each `main.jsbundle` was checked for the presence or absence of the
local server URL and for this session's identifiers. From the 02:03 build to
the final one, the only change was the career header's accessibility-size
branch.

### 10.5 Maestro outcomes

Every run's exit code and `COMPLETED` count were read. The `probe-*` flows are
scratch flows, not added to the repository. They assert D's own state: the
unavailable card, Practice above the fold, no balance, "Find a public table"
absent or present, and Play's note.

**Sequence B, existing player, Kong stopped (gateway `000`), then restored.**
Run on the 02:03 build and again on the final build.

| Step | 02:03 build | Final build |
|---|---|---|
| `offline-existing-launch` | pass, 10 steps | pass, 10 steps |
| `probe-unready` | pass, 12 steps | pass, 12 steps |
| `offline-existing-reconnect` | pass, 8 steps | pass, 8 steps |
| `probe-ready` | pass, 9 steps | pass, 9 steps |

- On the final build, the first run of the sequence was **invalid**. My
  wrapper passed `-e HANDLE=…` as one quoted zsh word, so the reconnect flow
  asserted `@undefined` (89 occurrences in its log) and failed. In that run the
  launch flow's `assertNotVisible '@${HANDLE}'` was vacuous. The whole sequence
  was repeated with the variable passed literally, and `maestro.log` shows
  `@witty_crane` resolved in both flows. The 02:03-build runs passed it
  literally from the start.
- User count unchanged throughout (11,137 on the 02:03 build; 11,139 on the
  final build). The same player was restored.

**Sequence C, only GoTrue stopped, 02:03 build.** `/auth/v1/user` answered
`000` here, where Refresh B recorded 502; REST answered 200.

| Step | Result |
|---|---|
| `unverified-protected-work` | pass, 14 steps |
| `probe-unready` | pass, 12 steps |
| `probe-connect` | pass, 7 steps |
| `unverified-protected-work-resume` | pass, 14 steps |
| `probe-ready` | pass, 9 steps |

`probe-connect` presses Home's new **Connect for online play** while GoTrue is
down. The control reports "Could not reach the server" and **creates nobody**:
users stayed at 11,137 → 11,137.

**Sequence A, new player, 02:03 build.** After `scripts/e2e-fresh-app.ts`
(which resets the simulator's app store and keychain, not the database).

| Step | Kong | Result |
|---|---|---|
| `offline-practice` (a full Practice hand) | stopped | pass, 28 steps |
| `probe-unready` | stopped | pass, 12 steps |
| `offline-reconnect` | restored | pass, 9 steps |
| `probe-ready` | restored | pass, 9 steps |

Readbacks: users stayed at 11,137 while offline. Afterwards there was exactly
one new player, `mint_goose_155843`. Its wallet is 25,000 and its ledger is one
row, `initial_grant` 25,000, so local Practice was not uploaded.

**`home-hierarchy.yaml`, connected.**

| Build | Result |
|---|---|
| 01:27 | Run 1 **failed, harness.** The recorded `hideKeyboard` gesture tapped "Email me a reset link": `auth.users.recovery_sent_at` = 08:52:43.6 UTC, inside the Hide Keyboard step (01:52:39.3–01:52:45.3 PDT), and the device showed the reset notice rather than Home. Run 2 **passed**, 78 steps |
| Final | **Pass**, 78 steps, first run |

That stray reset sent one email to local Mailpit. No password changed.

**`every-screen.yaml`, unconfigured.** Two runs: the 04:13 build and the final
04:21 build. Each completed 78 steps, including D's 15 Home and Play
assertions, and stopped at step 86, `tapOn: "Statistics"` on **Profile**; see
§10.6.

Between the user readbacks of sequences A and B, the count rose from 11,138 to
11,139. In that window, the only run on a configured build was the final
`home-hierarchy`, which launches a reset app whose automatic bootstrap creates a
player before signing in. That attribution is inferred, not traced.

### 10.6 Disposition of the flows §9.3 left failed or unexecuted

Classes are the brief's: (1) directly exercises D behaviour, (2) selectors or
navigation changed by D, (3) unrelated with a demonstrated pre-existing defect,
(4) needs setup that could not reasonably be supplied here. Each class was
established from the diff and the source, not from §9's notes.

| Flow | D's change to it | Class | Outcome and evidence |
|---|---|---|---|
| `every-screen.yaml` | stale assertion and Play anchors (§5.4, §9.5) | 1, 2 → **3** | D's sections pass. The stop is at Profile: the flow scrolls *up* to "Practice is saved on this device", then taps "Statistics", a button further down (`app/profile/index.tsx:286`) and off screen, and `tapOn` does not scroll. `app/profile/` is unchanged against `HEAD`. The flow's assertion was not changed |
| `dead-ends.yaml` | two Home anchors | 2 → **3** | Not rerun. It asserts `quick-sign-up` and ".*needs an account.*". Both exist in `app/table/quick.tsx` before `2476511` (Refresh B) and in neither `HEAD` nor the working tree, so it fails whatever D does. D's `quick.tsx` change is the `BackBar` label only |
| `cold-deep-links.yaml` | two Home anchors | 2 → **3** | Not rerun. `auth-username` exists before `2476511` and nowhere at `HEAD`. The flow was last edited 2026-09-14 |
| `refresh-b/offline-reconnect.yaml` | Home anchor | **1, 2** | **Pass** (sequence A) |
| `refresh-b/unverified-protected-work.yaml` | Home anchor | **1, 2** | **Pass** (sequence C), with `-resume` |
| `refresh-b/recovery-complete.yaml` | Home anchor after recovery | 2, **4** | Not run. It needs `request-recovery.yaml` and the real Mailpit link opened on the device, and it rewrites a secured account's password. The only secured e2e account, `e2e-lobby`, is the one every connected flow signs in with. The same auth-screen → `home-screen` transition passed inside `home-hierarchy` (`sign-in-existing`) |
| `password-recovery-retry.yaml` | Home anchor ×2 | 2, **4** | Not run, for the same reason. It also needs a disposable secured account's current password |
| `social-refresh-after-accept.yaml` | `tapOn: Home` → `home-screen` | 2, **4** | Not run. It needs a second account to accept through its own UI |
| `two-client-public-leave.yaml`, `two-client-public-survives.yaml` | Home anchor after leaving | 2, **4** | Not run. They need two booted simulators, and this host was swapping 11 GB with one. Leaving a table and returning to `home-screen` passed in §9.3's `online-table` and `online-leave-mid-hand`, on §9's build, not on the final one |

**Recorded, not changed:** `app/profile/index.tsx:204` builds Profile's spoken
label as "Strategy accuracy ${headline.accuracy} per cent". `headline.accuracy`
is an object, so the device's tree reads **"Your statistics. Strategy accuracy
[object Object] per cent, unaided."** The line is identical at `HEAD` and was
last changed in `2476511`. It is an accessibility defect on a screen D does not
own.

### 10.7 Accessibility verification

**What was possible.**
- Real VoiceOver is not available on the Simulator, and no spoken output was
  captured.
- The Accessibility Inspector GUI could not be operated: this session had no
  desktop control.
- Instead, `XCUIApplication.performAccessibilityAudit(for: .all)` (the XCTest
  API that runs the same categories of audit as the Inspector's Audit tab) ran
  against the installed `com.arc21.app`. It ran from a throwaway UI-test bundle
  in the scratch directory. The repository's `ios/` project was not touched.
- **This is not a claim that the Inspector was run.**

**A measured property of the audit.** It scrolls elements into view while it
works. Started at Home's footer, one audit left the page at the public-table
card, while a tree-only query moved nothing (byte-identical screenshots). So
each pass covers off-screen content. My early attempts to page between audits
appeared to stall for that reason. Their per-page counts are not reported, and
one early AX5 run that never left Home's first screen is not counted.

| Build · state | Passes | Issues |
|---|---|---|
| Final connected · `large` and AX5 · Home and Play from the top, ×2 each | 8 | **0** |
| Final unconfigured · `large` and AX5 · Home and Play, ×2 each | 8 (one Maestro open step returned 1; that pass audited the screen already shown) | **0** |
| 02:03 connected · AX5 · Home and Play, in a paging loop | 71 (Home 41, Play 30) | **0** |

The audit types include clipped text, Dynamic Type, hit region (tap target),
contrast, element description, trait and element detection.

**One open finding, unlocated.**
- What: "Potentially inaccessible text" (element detection), with **no element
  attached**.
- When it appears: at default size, only when an all-types audit **starts at
  Home's footer**. 02:03 build: 2 of 2 such runs; final build: 1 of 2. Earlier
  runs of the same kind also reported it.
- When it does not: element detection run alone from the same position gave 0
  in every run, never at AX5, and never on Play.
- Hypothesis, unconfirmed: the career badge draws "0/18 ★" while D labels it
  "0 of 18 stars". At `HEAD` that card was a labelled pressable that hid the
  badge. Confirming would need another build for a heuristic finding.

**Order and labels** (default-size tree, connected). Header, then PLAY FOR
CHIPS and its summary, then the people card's overline, title, two sentences
and two buttons. Then the Quick Play card, then Daily and Sprint as one element
each ("Label. Detail."). Then AI TABLES and its card, then PRACTICE AND
PROGRESS with Practice, Career and Mastery. Then Learn, Friends and
Leaderboards, the footer and the tab bar. No duplicate interactive element.

**Not verified here:**
- **Heading semantics**, from source only: `SectionHeading` and Play's group
  titles set `accessibilityRole="header"` (`Card.tsx:173`, `play.tsx:261`). The
  tools available expose no traits, so this was not verified by an
  accessibility tool.
- **Physical-device VoiceOver** (spoken order, rotor headings, focus movement)
  is external release evidence and remains unverified.

### 10.8 Automated gates (final tree, quiet host)

| Command | Result |
|---|---|
| `npx vitest run tests/home tests/design` | 160 passed |
| `npm run test:unit` | **156 files, 3,125 passed, 0 failed** (3,115 + this session's 10) |
| `npm run test:coverage` | exit 0 — 154 files, 3,099 tests, every per-area threshold met |
| `npx tsc --noEmit` | exit 0 |
| `npx expo lint` | 0 errors, 21 warnings; none in a file changed this session |
| `npm run contrast:check` | exit 0 — 50 + 2 pairings, 0 failing |
| `npm run bundle:check` | exit 0 — iOS Hermes bundle 6.5 MB |
| `git diff --check` | clean |

Not run, and why: `npm run test:server`, `supabase test db` and
`npm run check:functions`, because no server code, contract, migration or
function changed. `npm run doctor`, because no dependency changed; §9.7's
upstream patch drift stands as recorded.

### 10.9 What still stands from §9

- §9.3's passes on flows this session did not rerun: `ai-table`,
  `practice-hand`, `practice-analysis`, `practice-resume`, `career-map-return`,
  `career-node`, `fresh-player`, `hostile-deep-link`, `online-table`,
  `online-leave-mid-hand`. They ran on §9's build. This session's changes since
  then:
  - Accessibility-size layout branches, plus `inRows`, which renders
    identically at ordinary sizes.
  - The offline message, which these flows do not reach.
  - None of these flows runs at an accessibility size.
- §9.4 (lobby copy), §9.5 (test repairs) and §9.6 at default size.
- §9.6's large-text observation is superseded by §10.2.

### 10.10 Files changed in this session

| File | Change |
|---|---|
| `src/design/type-metrics.ts` | `MAX_TITLE_FONT_SCALE` |
| `src/components/ui/Card.tsx` | `Tile` title capped |
| `src/features/home/product-hierarchy.ts` | `inRows(items, perRow)` moved here; `onlineAvailability` takes `serverUnreached` |
| `app/(tabs)/play.tsx` | card header stacks, title capped, support tiles via `inRows`, `serverUnreached` |
| `app/(tabs)/home.tsx` | link rows via `inRows`, career header stacks, `serverUnreached` |
| `tests/design/font-scale-stacking.test.ts` | +4 tests |
| `tests/home/home-play-screens.test.ts` | +5 tests |
| `tests/home/product-hierarchy.test.ts` | +1 test; `serverUnreached` added to its calls |
| `docs/astra-refresh/refresh-d.md` | this section and the pointer under the title |

No Maestro flow in the repository was changed in this session. No backend,
migration, settlement, contract or blackjack-rule file changed.

### 10.11 Git state at the end of this session

`refresh-d-home-hierarchy`, `HEAD` = `ae70b9bf34681e19572656ddbaf871c6991be9de`,
nothing staged, committed, pushed or deployed. The tracked files modified now
are §9.8's 34 plus `src/design/type-metrics.ts` and
`tests/design/font-scale-stacking.test.ts`. The D files that are new and
untracked are §9's six. `AGENTS.claude-backup.md` and `.serena/` remain
untouched. The iPhone 17e was left shut down at `large` text, holding the final
connected build.


## 11. Post-integration repository maintenance — October 30, 2026

### Baseline and scope

Inspected public `tjsingh143/arc21`, `main` at
`8c98ddb7a3c61b3336ff33bf291cf1067a647e6c`. PR #6 is merged;
`6963ba6` and `6439bc5` are ancestors, and the merge tree equals the PR head.
The only other remote branch was the already-merged `refresh-d-home-hierarchy`;
there were no open PRs, GitHub releases or repository rulesets. The branch was
retained. `main` was unprotected: CI runs on PRs and main pushes, but no branch
rule makes those checks mandatory. No deployment or release was performed.

Review covered all 765 tracked paths, repository metadata, the 44-file Refresh D
diff, current documentation, workflow commands and logs, configuration and
lockfile consistency, and broad authorship/credential-pattern searches. Home,
Play, product hierarchy, accessibility components, account-scoped resume state,
setup-screen integration and associated tests were read against the milestone
record. No additional Refresh D application defect was established. This is a
repository maintenance review, not exhaustive security or native certification.

### Corrections

- README now leads with actual capabilities and architecture, describes Refresh
  D's connected/offline hierarchy, gives native development commands, and links
  commit-specific verification instead of foregrounding older milestone totals.
- Architecture removes the uninstalled RNTL claim and documents the shared
  hierarchy, held-seat behavior and account boundary.
- Test Plan separates current CI evidence from its retained historical totals
  and describes the actual coverage gates and required server command.
- Release guidance uses 63 migrations, scopes the old zero-defect verdict to
  its checkpoint, and exposes current dependency findings. The historical audit
  has an explicit scope banner; its original observations are unchanged.
- Current asset descriptions identify source and geometry without manual or
  tool-authorship claims. Current milestone summaries omit unnecessary model
  labels; historical audit provenance, filenames, third-party notices and Git
  attribution remain intact. AI Tables functionality is unchanged.
- CI header comments no longer describe the public repository as private or
  claim that only one Node version has ever been exercised. Workflow steps,
  coverage thresholds and failure behavior are unchanged.
- Compatible dependency maintenance and remaining advisories are recorded in
  [Dependency disposition](dependency-disposition.md). Application/Edge Function
  Zod versions are aligned; no game rule, migration or API schema was edited.

### Evidence boundaries

The existing [baseline CI run](https://github.com/tjsingh143/arc21/actions/runs/41113669213)
on `8c98ddb` passed both jobs: 3,125 unit tests, 3,099 coverage tests,
439 server tests, 672 SQL assertions and 63 migrations. Its lint result was
0 errors / 21 warnings; Doctor passed 21/21 and the iOS Hermes bundle was 6.5 MB.
Those are independently inspected hosted results, not local reruns.

Local baseline verification used Node 24.22.1 and a clean `npm ci`. Typecheck
and lint passed (21 warnings); `npm run test:unit` reported 3,124 passed and one
failure because this execution environment denied the Unix socket used by the
`tsx` CLI in the catalogue-generation test. The same generation was separately
run with `node --import tsx scripts/generate-career-nodes.ts --stdout` and
compared byte-for-byte with the committed migration. No test was disabled or
weakened to hide the environment restriction.

After dependency maintenance, a clean `npm ci`, `npm run typecheck`,
`npm run lint` (0 errors / 21 warnings) and `npm run doctor` (21/21) passed.
The full unit and coverage commands again encountered only the same socket
restriction: 3,124/3,125 and 3,098/3,099 tests passed respectively. This is not a
local full-suite pass. The catalogue comparison and
`node --import tsx scripts/check-contrast.ts` passed. Local Edge Function
checking could not fetch Zod through Deno's registry connection; hosted CI must
verify all three functions and the running backend before merging.

All relative Markdown file links resolved in the tracked tree. Manifest and
lockfile root dependencies matched. The credential-pattern candidate was a
synthetic configuration test fixture; no real secret was established by this
bounded scan. GitHub secret-scanning/Dependabot administration was not exposed
by the available connector, so no claim is made about those private settings.
The About description and topics were empty; the connector has no repository
metadata write operation. The README provides the project description.

Physical-device VoiceOver, Android execution, production activation and the
unlocated accessibility heuristic in §10.7 remain outside this review's proof.
The earlier checkpoint records above retain their original wording and results.
Refresh E has not begun.
