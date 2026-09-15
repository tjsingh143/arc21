# Astra Refresh A — independent baseline audit

**ASTRA BASELINE AUDIT: PASS**

**KNOWN CURRENT RELEASE-BLOCKING SOFTWARE DEFECTS: 0**

Final local verification: **September 14, 2026 PDT / September 15 UTC**.
Refresh A is complete. Refresh B has not begun. This verdict supersedes the
in-progress statements in the dated history below; failed runs remain recorded
as failures, with their separate successful follow-ups identified.

## Final scope and evidence

All 22 identified product findings are verified. The final review includes the
shipped client stores, screens, Edge Functions and database paths, with actual
iOS Release interaction and independent server/ledger observations. Unit tests
are supporting evidence, not a substitute for those paths.

The current durable evidence directory is
`/Users/tj/arc21-evidence/astra-refresh-a-20260911/`. Earlier D1/D7/D10/D11/D12/D13
evidence is preserved at the locations in its dated sections. Previously valid
proofs were retained where later changes did not invalidate them. The matching
source manifests and maps document each batched Release change.

| Findings / area | Final result and decisive evidence |
| --- | --- |
| D1 — password recovery | VERIFIED. One real PKCE exchange, same-password refusal, corrected submission and subsequent native password sign-in; original-password sign-in refused. Current full server suite also exercises the shipped auth store. |
| D2–D4 — cold-link return and auth navigation | VERIFIED. Cold Learn, recovery errors and Create Account reach their real return/sign-in destinations. Final boundary and Career return flows preserve those paths. |
| D5–D6 — economic and ranked-entry response loss | VERIFIED. Production stores retain one intent across lost replies, reconcile committed wallet/seat/attempt state, and do not retry parsed refusals. Current server suite includes all real response-loss regressions. |
| D7 — unreadable Daily history | VERIFIED. Failed/malformed reads cannot become a new ranked attempt; native retry restores the existing entry. |
| D8–D10 — Career progress, attempt count and completion wallet | VERIFIED. Native retained-route progress/rewards agree with the server; one start counts once. Forward repair applied from empty with 59 migrations; current SQL/server regressions pass. |
| D11–D12 — Social refresh and account deletion | VERIFIED. Native friendship acceptance refreshes the retained tab; confirmed deletion clears SDK persistence and remains signed out after cold launch. |
| D13 — unreadable Sprint entry | VERIFIED. Native paid-entry read failure and restored retry preserve one entry/debit; the full read ACL is restored. |
| D14 — reconciliation / private lifecycle | VERIFIED. `private-closure-verified.json`: deliberate play, cancel without departure, one actual departure, surviving authoritative seat and host transfer, eventual room closure. Real response-order regressions reject state rewind, seat resurrection and duplicate feedback. |
| Public multiplayer | PASS. `public-closure-verified.json`: six native flows, three seat lifetimes, exactly three buy-ins/cash-outs, seat-slot reuse and survivor continuity; final version 47, zero escrow, wallets equal ledgers. |
| D15 / Sprint table and completion | VERIFIED. Actual native chosen wagers, eliminated-entry UI and completed-result UI; existing fields finish through normal server commands, including the tie hand. `sprint-elimination-closure-verified.json` reconciles placements, prizes, XP, single entry debits and empty active-session lookups. |
| D16 — shared settlement accounting | VERIFIED. Every authenticated seat receives its own statistics/XP and matching public projection, independent of the command actor; exact replay pays no second time. `social-shared-closure-verified.json` closes both native seats and reconciles 640 / 641 settled hands. |
| D17 — SQLite initialization | VERIFIED. Shared serialized initialization and retry after rejection; five standalone starts, settings writes/cold persistence and the exact live Practice hand restored in `final-native-storage.xml` and the inspected before/after images. |
| D18–D21 — Dynamic Type, hand labels, chart/detail and error recovery | VERIFIED. Same-process text remeasurement, complete wrapped wager/total, scaled chart cells, reachable scrolling detail/Close and unknown-link recovery at maximum text size. `accessibility-native-after.xml`, `accessibility-viewport-followup.xml`, `font-change-after.json`. |
| D22 — Career map return | VERIFIED. Final Release normal/cold Back and maximum-text Back pass in `final-a-native-return.xml` and `final-a-native-career-max.xml`. |
| Remaining Social/account/navigation/error states | PASS. Saved profile rename survives cold launch and is restored; block/cancel/unblock, request acceptance, real invitation/inbox join, friend-record privacy and stale table/room refusal. `final-boundaries-verified.json` confirms the read-only boundary flows mutate none of the compared account, wallet, room, game or Social records. |
| Dependency/security reconciliation | PASS within the documented runtime/build boundary. Four advisories remain visible across 18 package entries; compatible fixes applied, actual bundle and inbound parser inspected, final native malformed-link navigation passes. See [dependency-disposition.md](./dependency-disposition.md). This is not a clean npm-audit claim. |

## Final current-code gates

| Gate | Result | Durable evidence |
| --- | --- | --- |
| Clean dependency install | PASS; final package/lockfile unchanged since install | `final-current-npm-ci.log` |
| TypeScript / lint | PASS; 0 lint errors, 38 warnings | `final-a-typecheck.log`, `final-a-lint.log` |
| Edge Function typechecks | PASS; all three production functions | `final-a-functions.log` |
| Unit suite | PASS; 129 files / 2,446 tests | `final-a-unit.log` |
| Coverage | PASS; 127 files / 2,420 tests, all per-area thresholds | `final-a-coverage.log` |
| Contrast | PASS; 50 required default pairings and two Increased contrast substitutes. Four intentionally subdued default borders remain explicitly reported by the check. | `final-a-contrast.log` |
| Expo Doctor | PASS; 21/21 | `final-a-doctor.log` |
| Bundle Mode | PASS from installed dependencies | `final-a-bundle.log` |
| Clean native prebuild / final Release build | PASS; native configuration unchanged since clean prebuild, final incremental build uses two workers | `final-current-prebuild-ios.log`, `final-a-release-ios.log` |
| Actual iOS artifact / both installs | PASS; final bundle installed on both named simulators and standalone Home inspected | `final-a-release-source.json`, `final-a-release-install-a.json`, `final-a-release-install-b.json`, `final-a-native-config.json` |
| Local stack / clean reset | PASS; all 59 migration versions exactly match the checkout; functions re-served and database-backed readiness checked | `final-a-supabase-start.json`, `final-a-db-reset.json`, `final-a-backend-preflight.json` |
| pgTAP / authorization | PASS; 30 files / 592 assertions | `final-a-pgtap.log` |
| Required full server suite | PASS; 25 files / 320 tests, no skipped suite | `final-a-server.log`, `final-a-backend-gates.json` |
| Final integrity / fault restoration | PASS; 505 wallets reconcile, no negative balances, duplicate live seats or idle transactions; permissions and application services restored | `final-a-postflight.json` |

Final embedded bundle SHA-256:
`c765bef7b87057f591cbf4525d27fa988456847da2ec7ad53434512ece8970b9`.
Matching map SHA-256:
`268691b7dad713f7e5297c9e62c86aa65b2017c167820d62ff59bba7170cb447`.
The final postflight rechecks all **378** recorded source/configuration files
against the built-artifact manifest with no mismatch. Later edits only finalize
audit/release documentation and correct the unused Daily-seed environment example.

The server sweep recovered one local `WorkerAlreadyRetired` HTTP 500 using the
existing identical-body retry. The function log attributes it to the local
Supabase `per_worker` CPU budget retiring the isolate; the failing stack is in
the runtime dispatcher, before the Arc 21 handler. It is preserved in
`final-a-runtime-retirement.json`, not presented as a product crash or a run with
zero HTTP failures. All 320 tests passed without changing timeouts or
assertions. XCTest/SpringBoard failures and simulator boot warnings are likewise
separate from the reproduced SQLite product crash and its verified fix.

The clean reset's pre-reset database is preserved in `final-a-pre-reset.dump`
(mode 0600; hash in `final-a-pre-reset-backup.json`). The current disposable
database contains the final server-suite fixtures, so earlier simulator account
logins are no longer accounts in that reset database. No injected outage, read
ACL change, observer, proxy or fixture fault remains. Application services are
running and unpaused; both simulators are shut down, system text is restored to
`large`, and the three app accessibility overrides were restored. Studio,
pg_meta and analytics were already stopped before this continuation; vector's
pre-existing health failure is recorded separately from the application services.

The complete intended diff and untracked files were reviewed, including the
lockfile, migration, test changes and historical handoffs. The original
`AGENTS.claude-backup.md` is preserved and excluded. The final checkpoint is the
local commit introducing this verdict; its commit/tree and the reviewed-file
inventory are recorded in the durable evidence directory. Nothing is pushed or
deployed by Refresh A.

This is the local software baseline verdict. Cloud deployment, store accounts,
real push credentials/delivery, physical-device verification and the unbuilt
Android target remain explicit external activation/verification work in
[RELEASE.md](../RELEASE.md). They are not represented as completed by simulator
or local-backend evidence. No known locally fixable release blocker remains.

## Dated audit history

This audit started on 2026-09-04 and resumed on 2026-09-05 after a usage-limit
interruption. Prior phase verdicts are claims, not evidence for this audit.
Refresh B, pseudonymous accounts, AI Tables, and the new Home hierarchy are out
of scope. All work is in the main session and original checkout; no delegation,
secondary worktrees, additional Codex processes, or pushes.

## Repository and runtime recovered

- Checkout: `/Users/tj/arc21`; branch `phase14-s2-security`.
- Starting HEAD: `58dcf39fc66a3d1fcb81a20c34beb77875ff929a`.
- Upstream: `origin/phase11-adversarial-qa`, one commit behind the starting HEAD.
- Origin: `https://github.com/tjsingh143/arc21.git`.
- The initial worktree contained only the untracked historical
  `AGENTS.claude-backup.md`; it is preserved and excluded from this work.
- Node 26.7.0, npm 11.19.0, Supabase CLI 2.115.0, Xcode 26.6,
  iOS 26.5 simulators, Maestro 2.8.0.
- Raw logs and runtime artifacts: `/tmp/arc21-astra-baseline/`.
  `pre-audit-database.dump` preserves the pre-reset local database.
- The original 137-page Arc 21 specification PDF was inspected; acceptance
  criteria and Definition of Done on pages 130–136 were extracted independently
  to `pdf-acceptance.txt` in the evidence directory.

## Completed verification

| Gate | Observed result | Evidence file |
|---|---|---|
| Clean dependency install | Passed, 904 packages | `npm-ci.log` |
| Strict TypeScript, initial state | Passed | `typecheck.log` |
| Lint, initial state | 0 errors, 37 warnings | `lint.log` |
| Edge Functions typecheck | All three passed | `functions-typecheck.log` |
| Unit suite, initial state | 125 files, 2,415 passed | `unit.log` |
| Coverage, initial state | Per-area gates passed | `coverage.log` |
| Contrast | 50 pairings, none failed | `contrast.log` |
| Expo Doctor | 21/21 passed | `doctor.log` |
| iOS bundle | Passed from freshly installed dependencies | `bundle.log` |
| Migrations from empty | All 58 applied | `db-reset-second.log` |
| pgTAP / authorization | 29 files, 582 assertions passed | `pgtap.log` |
| Recovery defect reproduction | Failed on corrected second submission | `recovery-reproduction.log` |
| Recovery fix against real GoTrue | Passed | `recovery-after.log` |
| Focused changed unit tests | 3 files, 69 passed | `focused-unit.log` |
| Eligible Recovery Grant race | Exactly one successful grant and cooldown refusal | `recovery-grant-play.log` |
| Server suite including new five-client test | 302 passed; new comparison assertion failed | `server-full.log` |
| Clean native iOS prebuild / Release build | Build succeeded, installed on iPhone 17 Pro; 0 errors, 2 warnings | `prebuild-ios.log`, `release-ios.log` |
| Five independent GoTrue clients, complete flow | Passed: three hands, host migration, reconnect, all leave, ledger unchanged | `five-client-complete-second.log` |
| Changed unit suite | 127 files, 2,428 passed (one subsequent withdrawal unit regression separately passed) | `unit-final.log`, `entry-loss-final.log` |
| Changed TypeScript / lint | Passed / 0 errors, same 37 warnings | `typecheck-final.log`, `lint-final.log` |
| Entry response loss | Four production-store integrations passed; debit/ledger reconciliation | `entry-loss-final.log` |
| Final server sweep | 306 passed; twenty-command test timed out with gateway 504s during concurrent native/bundle work | `server-final.log` |
| Isolated twenty-command race | Passed in 1.28 seconds, no gateway retry: one accepted, nineteen stale | `concurrency-isolated.log` |
| Updated Release builds | Both succeeded and installed, 0 errors / 1 warning | `release-ios-final.log`, `release-ios-anchored.log` |
| Final source-map export | Passed, 2,644 modules | `bundle-final.log`, `dependency-reachability.log` |

The first database reset failed during Supabase base-schema initialization,
before any application migration. Concurrent Realtime/analytics initialization
and severe host resource contention were observed. Stopping those services and
resetting again applied every migration. Functions were then re-served from the
checkout; a gateway 503 during restart was retained in `recovery-before.log`
as a stack failure with zero tests, not a product-test verdict.

## Reproduced defect and fixes so far

**Password recovery consumed its authorization code twice.** The original test
called SDK methods directly and bypassed the production adapter. Through the
actual adapter, submit the existing password on a valid recovery link: GoTrue
consumes the PKCE code and refuses the password. Correcting the password on the
same screen attempted a second exchange and returned a generic server error.

The adapter now retains the verified flow for the password-update retry, checks
that the current account still matches, and clears it after success. Different
codes must be verified independently. Same-password and missing-verifier errors
have useful classifications. The real GoTrue test checks that the old password
fails and the corrected password signs in; unit regressions cover account
replacement, sign-out, different codes, and completed-flow replay.

## Test-integrity improvements so far

- The Recovery Grant race never reached eligibility and passed when all eight
  callers were refused. It now spends down through real server wagers and
  cash-outs, requires exactly one successful grant, reconciles the ledger, and
  reaches the cooldown guard with a subsequent real buy-in.
- The engine's dealing-order test checked membership of a consumed-card set.
  It now compares the exact engine event order, including cursor advancement
  for concealed hole cards.
- A five-client private-table test uses independent GoTrue sessions and the
  shipped room/table gateways. Its first run stopped because optional absent
  advice and explicit null advice were compared as different game states.
  The comparison was corrected on resume. A second test assumption incorrectly
  expected a null private-table cash-out balance; the server correctly returns
  the unchanged 25,000 balance. The complete flow then passed.

**Cold deep-link return paths.** A cold Learn link had no previous route, and
Back did nothing (`device-cold-before.log` and its failure screenshot). BackBar
now falls back to Home; the root navigator also anchors cold links to Home so
footer controls, Practice Close, and a cashed-out table can return. A missing
recovery code rendered instructions to use Sign in but no control; Sign in is
now available in every recovery state. Independent settled-screen taps reached
Home and the actual Sign in form (`back-ready.log`, `recovery-ready.log`). The
expanded cold-link regression passed in `device-round-one.log`.

**Response loss after a debit.** Quick Play, public buy-in, and Sprint reported
that nothing was charged after the real server had committed. Reproduced with
actual GoTrue sessions, SDK, production stores, and fetch dropping only replies
after HTTP 200; wallet and ledger read back 23,000 / 24,500. The three stores
now use one bounded retry of the identical intent and reconcile authoritative
wallet/seat/entry state if neither reply arrives. Parsed refusals, including
INTERNAL, are never retried. Sprint withdrawal uses the same boundary; an
unreadable entry read no longer becomes an empty entry inviting registration.
`entry-loss-reproduction.log` is the failing evidence; `entry-loss-final.log`
passes the four integration cases plus nine Sprint store tests. A real lost
withdrawal reply also refunded once in the earlier run; its initial assertion
incorrectly expected the first response's wording instead of the server's
explicit zero-additional-refund replay wording. That assertion was corrected.

## Device evidence recovered and extended on September 5

- The 08:07 `device-round-one.log` finished, rather than remaining active. Cold
  Learn and both recovery error return paths passed. Real sign-in, all four
  leaderboard tabs, Daily commitment and closed-seed verification, Sprint
  format, Social, inbox, statistics, profile, and inventory screens passed and
  were captured. Practice completed a wager and reached Next hand.
- That run failed at Practice resume because its chip tap left a zero wager;
  neither Career nor Quick Play ran in that invocation. The regression now
  requires a staged 100-chip wager and an actual live decision before killing
  the app, then compares wager and player/dealer totals after restoration.
  `device-round-two.log` passed the revised flow; the two screenshots show the
  same 10-clubs/10-spades hand against a concealed dealer hand headed by J-hearts.
- A cold Create Account link exposed another real navigation error: “I already
  have an account” returned Home. `device-create-before.log` reproduced it.
  The CTA now replaces with Sign in. The same reproduction passed in
  `device-round-two.log` on the updated Release build (`release-ios-account-return.log`,
  zero errors / one warning). TypeScript and 17 focused regressions also passed.
- The same device run completed all ten hands of the **offline** First Deal
  Career node and returned to its local stars. The temporary flow filename
  `career-online.yaml` was misleading: it tapped Practice offline and is not
  ranked Career evidence.
- Quick Play passed the actual production buy-in, wager, settlement, Next hand,
  leave confirmation, cash-out, Home return, and new setup. The database
  independently shows 25,000 → 23,000 → 25,050, with one 2,000 debit and one
  2,050 cash-out; the session is completed with zero escrow.
- `device-extra.log` reached Learn rules, Hard/Soft/Pairs strategy charts, drill
  answer feedback/next/finish, cosmetic equip, accessibility settings and Fair
  Play. Screenshots were visually inspected. Device SQLite confirms reduced
  motion, increased contrast, and larger table text persisted after restart.
  Its initial profile rename assertion only matched the edited form text; that
  is explicitly **not** save evidence. The strengthened flow requires the
  editor to close and the name to survive a cold reopen.

## September 6 continuation

Repository recovery matched the handoff's branch, HEAD, and dirty files. The
existing stack and simulator were healthy; no reset, clean install, or clean
native prebuild was repeated.

- **D7 fixed:** Daily now distinguishes an explicitly empty entry result from a
  failed or malformed read, and rejects a row for another challenge. An
  unavailable screen offers a real retry. The real SDK regression captures the
  existing in-progress row before dropping/corrupting its HTTP 200 response,
  checks that no fresh-ranked plan is available, and restores the read to prove
  the same attempt reappears.
- **D8 verified on native:** Career map and node refresh ranked
  progress on focus, including return from a retained table route. Header and
  chapter star totals now use the same maximum of local/server stars as node
  cards; the local best card explicitly says offline. No reward is computed or
  granted locally. A new native regression advances Hit or Hold, preserving the
  already-completed First Deal evidence, then checks replay wording, record,
  map update, and Double Time's ranked prerequisite.
- **D9 verified:** one Career attempt was counted at both start and completion.
  The forward migration `20260909120000_career_attempt_counts.sql` preserves
  the start count and repairs existing aggregates from actual attempt rows.
  `pgtap-career-count-after.log` passed 30 files / 592 assertions;
  `career-count-after.log` passed all six Career integrations. No database reset
  was repeated. `device-career-repaired.log` then verified the existing Hit or
  Hold run displays exactly one attempt, the map displays 3/54 stars and 3/18
  chapter stars, two completed nodes, and Double Time's ranked button is enabled.
- **D10 reproduced, fixed and verified on native:** the retained Career
  header displayed 25,250 after the server wallet and ledger had reached 25,450.
  A seat already released by settlement bypassed the ordinary cash-out wallet
  refresh. The closed-seat branch now re-reads the authoritative wallet.
  `completion-wallet-before.log` reproduces the exact mismatch; all 50
  table-store regressions pass in `completion-wallet-after.log`.
- **D1 validation gap found and fixed:** the earlier adapter-only regression
  missed `auth-store.ts` creating a new adapter on each submission. The stored
  verified recovery flow was therefore lost in the real screen's caller.
  `recovery-store-before.log` reproduced the corrected-password failure through
  `useAuthStore`. Adapters now live for their SDK client's lifetime; sign-out or
  identity replacement invalidates the retained flow. The integration now uses
  the actual store for requesting and completing recovery, and checks old/new
  password sign-in against GoTrue.
- `continuation-changed-regressions.log`: 10 files / 155 tests passed, including
  store-level GoTrue recovery. `entry-loss-current.log`: all 12 current
  response-loss cases passed, including single/double lost committed replies,
  malformed committed replies, and lost/malformed Daily entry reads. Wallet and
  ledger assertions use the real database through authenticated SDK reads.
- `continuation-typecheck.log` passed; `continuation-lint.log` has zero errors
  and the same 37 warnings. Later small response-envelope checks remain subject
  to final gates. `release-ios-continuation.log` records the incremental Release
  build/install: zero errors, two warnings.
- **Daily native completion:** A played all 20 hands of the September 7 UTC
  ranked challenge, ending at 4,600. One 1,000-chip reward brought wallet and
  ledger to 26,450. `native-ranked-checked.log` records the exact entry and
  ledger; `device-daily-result.log` and screenshots show the result, unranked
  replay wording, verified previous-day commitment, and Daily leaderboard
  position 1/1 with 4,600 and 20 hands. The initial helper wrongly staked 50
  against Daily's 100 minimum; it was stopped without a wager, corrected to
  100, and continued the same entry. The temporary continuation also incorrectly
  expected Daily to remain mounted despite its `router.replace`; the explicit
  result reopen passed. Neither harness failure is relabeled as a passing run.
- `refresh-a-current-typecheck.log` passed after the current malformed-open
  guards, Career count tests and D10. `refresh-a-current-lint.log` passed with
  zero errors / 37 warnings. Full final unit/coverage and current artifact
  verification remain pending.

## Unfinished work at September 6 resume

- Complete D1's full native recovery; preserve already completed native evidence.
- Complete native reconnect, private/public multiplayer, tournament, social,
  account, navigation, accessibility and remaining error-state evidence.
- Finish security/dependency reachability assessment and final reconciliation.
- Run final checks appropriate to all changes, update launch documentation,
  complete this report, and make the requested local checkpoint commit.

`AGENTS.md` now contains the durable repository map; it contains no temporary
audit findings. No code has been committed or pushed by this audit yet.

## September 6 late continuation — fault-state recovery

Before any new device testing, `resume-fault-state-verified.log` checked the
actual `my_daily_entry()` ACL against migration
`20260817200000_daily_challenge_and_sprint.sql`: authenticated EXECUTE present,
anon and PUBLIC EXECUTE absent. The prior session had already restored the grant
(`daily-read-grant-restored.log`); no additional grant mutation was needed.
The current authorization-surface gate passed, an authenticated read returned
A's completed 20-hand/4,600 entry, and no idle-in-transaction connection remained.
The only audit runtime process was the existing function server; no Maestro,
build, test, proxy or fault-injection process remained. Gameplay services were
healthy and the function endpoint returned the expected unauthenticated 401.

**D7 native recovery is verified.** `device-daily-read-error.log` asserts the
unavailable/retry state and absence of a fresh-ranked CTA. In the subsequent
`device-daily-retry-social.log`, tapping `daily-retry` restored the existing
4,600-after-20-hands result and unranked replay CTA; its saved screenshot was
visually inspected on resumption. That combined flow failed later at a Social
assertion, not Daily. The screenshot shows the expected outgoing request, but
the selector omitted the username prefix in the same text node. Preserve the
failed combined run as a harness failure, not a product defect or a whole-flow
pass. The B login/reward/social YAML existed but had no execution evidence.

`resume-release-installed-hashes.json` records the Release artifact and both
installed simulators matching SHA-256
`1715b735c9cfb9c6394e0f3512f3e6d99a885b0f2490e2ee0d002439a89e2100`
(6,232,833 bytes). B received this existing artifact without a rebuild.

**D10 native proof passed** in `resume-b-reward-social-continuation.log`:
B entered ranked First Deal from a retained Career map, completed all ten hands,
returned to exactly one attempt and a 25,200 header without a process restart.
`resume-b-career-wallet-social-db.log` confirms ten hands, one star, final stack
1,650, exactly one 200-chip reward, and wallet = ledger = 25,200.
The first prepared-flow run stopped at Settings because its email assertion was
offscreen; the continuation scrolled to the Account section and verified the
exact identity before playing. This was a harness correction. The continuation
also opened B's friend-request inbox and accepted A; the database confirms the
accepted request. Its subsequent friend-profile tap failed and is being checked
separately. Neither combined run is represented as wholly passing.

**D11 reproduced and fixed; updated-Release verification pending:** after B
accepted, A's retained Social tab still said the request was waiting and that
there were no friends, even after Home → Social. The real native failure and
inspected screenshot are in `resume-a-friend-return-before.log`; the preceding
database log proves acceptance. Social read only on mount/auth-mode changes.
It now refreshes friends and the inbox badge on focus/account identity changes,
discarding stale search relationship results. The native regression is
`tests/e2e/social-refresh-after-accept.yaml`; it requires another account to
accept while the sender's pending screen remains mounted. A fresh process
loading an already-accepted friendship does not satisfy that regression.
B's profile tap was covered by the expected iOS notification-permission prompt;
the accepted friendship itself was already visible underneath it.

## September 9 continuation — recovered after host reboot

Branch, HEAD, and existing changes match the handoff. D7 and D10 remain verified;
neither has been repeated. The host rebooted September 7 at 16:42 PDT. At resume
both simulators were shut down, Docker was stopped, and the entire prior
`/tmp/arc21-astra-baseline/` directory was absent. The named pending/remove/build
logs and disposable-signup artifacts therefore could not be opened there.

Durable Maestro logs survived in `~/.maestro/tests/2026-09-07_134016/` and
`2026-09-07_134148/`. They establish B's native profile/private-record/inbox and
removal steps, then A's completed pending request at 13:43:37 PDT: both pending
messages were visible and the accepted friend row was absent. The recovered
database independently retains request `50e2c0de-05b2-4d5d-86d6-9c59b9d684e3`,
created September 7 at 20:43:35 UTC, still pending from A (`687e48ea…`,
`e2e-lobby@arc21.test`) to B (`fc3d2cc0…`, `astra-guest@arc21.test`), with no
friendship. Thus the interrupted request did complete, but its sender process
did not survive the later reboot. Reuse this request while establishing fresh
retained Social state before B accepts; do not claim process continuity across
the reboot.

The September 7 Release artifact and both installed bundles match SHA-256
`4d094da12b111fa045903307dd1cfed1a3fb02f165e47bc03209f341d2bb2d09`
(6,232,674 bytes). No rebuild, reinstall, database reset, or account reset was
needed. Docker's retained database was recovered and functions re-served from
the checkout; database reads and the expected unauthenticated function 401
confirm reachability. A's initial simulator boot reported Data Migration Failed
but reached its home screen; subsequent real app behavior is checked separately.

New raw evidence is stored outside temporary storage at
`/Users/tj/arc21-evidence/astra-refresh-a-20260909/`, including copies of the two
recovered Maestro logs, installed bundle hashes, and `d11-recovered-db.log`.
D11 verification is now continuing against the same pending request.

## September 10 continuation — D11 final closure

**D11 VERIFIED.** The corrected `social-refresh-after-accept.yaml` completed
in full inside `d11-single-lifecycle.yaml`: JUnit reports one test, zero failures,
and the runner exited 0. `d11-single-lifecycle.xml`, the complete command log,
and visually inspected screenshots are under the durable September 9 evidence
directory. The earlier `d11-a-after.log` remains a partial run whose final
screenshot swipe overshot the search field; it is not relabeled as a full pass.

A first rerun setup created pending request `6c741d8b…`, but XCTest teardown
crashed both Arc 21 and SpringBoard in the same injected
`XCTAutomationSession` callback. The crash reports are retained. No acceptance
occurred in that interrupted lifecycle. The clean run reloaded the pending
request and stale search relationship, then kept A's runner alive while B
accepted through native UI. A read-only local harness observed the database and
recorded A's process at the three boundaries; it made no friendship mutation.
`d11-lifecycle-before.json`, `d11-lifecycle-after-accept.json`, and
`d11-lifecycle-after-return.json` all record **PID 63998**, with the same start
time. The database changed from pending/no friendship to accepted/exactly one
friendship. Home → Social displayed the accepted friend and removed both stale
pending messages; the search input was empty with no Clear control.

`d11-clean-run-source-bundles.json` confirms no recorded source differences and
both installed Release bundles still match `4d094da1…`. D11 is closed; no
product fix was needed during this final verification. Native D1 recovery is
next. Refresh B has not begun.

## September 10 evening continuation — D1 final closure

**D1 VERIFIED.** The existing recovery run had finished after the earlier
interruption. Its JUnit reported one failure at the Home assertion following
the **new-password sign-in**, after both recovery submissions had completed.
The failure screenshot shows Home behind the native iOS Save Password alert.
The original run remains a failed combined flow; its completed steps are retained.

The disposable account is `astra-native-recovery-0910@arc21.test`
(`7ebd9ada-9ed8-489f-b11f-5967f71c8d60`). Evidence is under
`/Users/tj/arc21-evidence/astra-refresh-a-20260909/`:

- `d1-native-baseline-request.log` and its commands/screenshots prove native
  sign-in with the original password, sign-out, and the real native reset
  request. `d1-native-real-link.json` records the local mailbox message and
  GoTrue's 303 redirect to the native recovery route; the flow then opened it.
- `d1-native-recovery-retry` commands and inspected screenshots show the
  original password refused and the corrected password submitted on the same
  recovery screen. `d1-gotrue-final.json` records exactly one PKCE exchange at
  16:47:28 UTC, `PUT /user` 422 `same_password` at 16:47:29, then `PUT /user`
  200 at 16:47:41. No recovery request, verify link or second PKCE exchange
  occurred between those submissions or afterward.
- The same native run signed out at 16:48:13 UTC, entered the corrected
  password, and signed in successfully at 16:48:30. GoTrue attributes that
  password login to this account; the saved native failure screenshot shows
  its 25,000-chip Home underneath the iOS prompt.
- On resumption, a tap left that stale prompt visible. The failed continuation
  and screenshot are retained as harness evidence. After reopening the already
  authenticated app, a second continuation's Settings scroll reached the
  account section at its timeout boundary. That failed flow is also retained;
  neither failure involved another reset or password change.
- `d1-native-final-login-proof.log` / `.xml` then passed **1/1 Flow Passed**,
  exit 0. It verified the exact signed-in email, signed out, submitted the old
  password, and displayed the credential-refusal message with the email
  preserved and no wallet header. The inspected screenshot and GoTrue's
  00:15:41 UTC September 11 `invalid_credentials` 400 corroborate the refusal.
- `d1-current-password-wallet.log` confirms the corrected password matches,
  the original does not, wallet = ledger = 25,000, and exactly one opening
  grant. `d1-closure-source-bundles.json` confirms unchanged recorded production
  source and both installed bundles matching `4d094da1…`; D11 remains valid.

The regression harness now handles the iOS save-password prompt before its
Home assertion and allows Settings enough time to scroll to Account. No product
source was changed during D1 closure. No account was recreated, no additional
recovery link was requested or followed, and the same-screen retry was not rerun.

Remaining Refresh-A work: native reconnect, private/public multiplayer, Sprint,
remaining Social/profile/account/navigation/accessibility/error states, final
security/dependency reconciliation, current-code gates, documentation, and the
requested local checkpoint. Refresh B has not begun.

## September 10 late continuation — deletion and Sprint read closure

Resumed at the same branch/HEAD and inspected the current diff, the retained
backend, both booted simulators, and saved results before running anything.
No Maestro, build, test, or fault-injection process was still running; the
existing function server and database were reachable (unauthenticated
create-session 401, zero idle-in-transaction connections). D1, D7, D10, and D11
remain verified and were not repeated.

**D12 account deletion: fixed; updated native proof in progress.** The saved
`account-delete-store-before.log` fails specifically when a second SDK client
hydrates the deleted identity from persisted storage. The native old-artifact
proof independently deleted the server account (auth/profile/wallet/ledger all
zero) but restored its identity after cold launch; the inspected evidence is
`account-deleted-cold-restored.png`. The adapter now clears recovery state and
locally signs out the SDK only after confirmed RPC deletion. Refused deletion
retains the existing account session. `account-delete-store-after.log` passes
all five lifecycle integrations, including shipped-store deletion, simulated
cold storage hydration, and deleted-credential refusal.

**D13 Sprint entry read: fixed; updated native proof in progress.** The saved
`sprint-entry-read-after.log` completed with **2 files / 23 tests passed**, not
an interrupted or assumed result. The shipped-store integration verifies one
registration request, wallet = ledger = 24,500, unavailable state during lost
or malformed entry reads, and recovery of the same paid tournament with no
second request or charge. The first lost-read assertion assumed exactly one
automatic load and encountered none; the harness now explicitly loads and
checks all intercepted authoritative rows. The malformed-row case reproduced
the product defect. Only an explicit empty array now establishes no entry;
unavailable UI exposes `tournament-retry`. `d12-d13-typecheck.log` passed.

One updated Release was built and installed for both fixes, with zero errors
and two warnings. `d12-d13-release-source.json` records 377 production/config
hashes; `d12-d13-release-installed.json` matches the built and installed bundle
SHA-256 `0127986ecaa37d70cb72ae06be9e60cfd642babd0dd82d7b5073ab26c8f1b055`.
New evidence remains in `/Users/tj/arc21-evidence/astra-refresh-a-20260909/`.

**D12 VERIFIED on the updated Release.** A new disposable account,
`astra-delete-release-0911a@arc21.test` (`71101f41-2b13-4e21-a2fa-4e3c82e43a95`),
was created once and signed in through native UI. `d12-native-sign-in.xml`
passes 1/1 and confirms its 25,000-chip header and exact Settings identity.
The next runner initially opened on SpringBoard and failed before touching
Delete; that failed `d12-native-delete` run is retained as a harness failure.

`d12-native-delete-complete.log` / `.xml` then passed **1/1 Flow Passed**, exit 0:
cancel preserved the account; Delete permanently returned to guest; the
read-only local evidence callback confirmed auth/profile/wallet/ledger all
removed; native stop/relaunch retained guest state with no deleted identity,
Sign out, or Delete account; the deleted credentials were refused in native UI.
The callback ran again after the cold-launch refusal and confirmed all four
counts remained zero. `d12-native-db-before.json` records one of each and
wallet = ledger = 25,000; `d12-native-db-after.json` and `after-cold.json` record
zero. The cold-guest and credential-refusal screenshots were visually checked.
No storage, keychain, app install, or account reset occurred after deletion.
The reusable cold-launch regression is `tests/e2e/account-delete-cold-launch.yaml`.
No additional product fix or D1 recovery recheck was needed.

**D13 VERIFIED on the same updated Release.** New account
`astra-sprint-release-0911a@arc21.test` (`7fdfb412-af53-4b09-9fef-61beafed3212`)
paid through native UI. The local harness temporarily revoked only the
authenticated `my_sprint_entry()` read, restored it, and compared the full ACL
with its original value in a `finally` block. The native screen displayed
unavailable + Try again with no register/rematch/withdraw control. Tapping
`tournament-retry` recovered its paid entry. `d13-native-paid.json`,
`d13-native-unavailable.json`, and `d13-native-recovered.json` all record PID
**61806**, identical start time, entry `00314180-a7ae-4e29-bf23-cf1b2290c2f2`,
tournament `b314842b-3713-411c-9e95-a556b7680c7d`, and wallet = ledger = **24,500**
with exactly one -500 entry movement. Screenshots were visually checked.

The same native flow then withdrew and showed its refund sentence and 25,000
Home header. Its final observer failed because it incorrectly expected the
historical entry row to disappear; the server correctly retains `withdrawn`.
The failed `d13-native-complete.xml` is preserved, not called a whole-flow pass.
The corrected observer verifies that exact withdrawn entry, one -500 debit,
one +500 refund, and wallet = ledger = 25,000. `d13-native-postflight.log` / `.xml`
passed **1/1 Flow Passed**, exit 0, after cold reopening Home and confirming no
active entry/table is offered. No registration/payment/recovery step was replayed.

The initial D13 setup also exposed a sign-in harness fault: after Save Password,
the same loop could reopen Sign in over an already successful login and then
retype into a populated field. It was interrupted before registration. The
named sign-in harness now checks for Home/the password prompt before opening
Sign in. This changed only test YAML. The successful paid proof first verified
the exact account in Settings. `d13-native-acl-restored.json` confirms the
authenticated grant restored and anon/PUBLIC still excluded. D13 needs no
additional product fix. Full Sprint table/completion and other outstanding
Refresh-A native paths remain to be completed; no baseline PASS is claimed yet.

## September 11 continuation — live-table reconciliation

Resumed on `phase14-s2-security`, HEAD `58dcf39`, with the existing changes
unstaged and upstream still `origin/phase11-adversarial-qa`. Read the latest
continuations and durable evidence; no earlier conversation was reconstructed.
Both simulators and the retained backend were running, with no test/build/fault
process in progress. The function returned the expected unauthenticated 401,
the database had zero idle-in-transaction connections, and `my_sprint_entry()`
still had exactly its restored authenticated grant. D1, D7, D10, D11, D12 and
D13 remain verified; no completed native flow was replayed on resumption.

**D14 reproduced and fixed; updated native proof pending.** The running
production store accepted a delayed real snapshot after newer state: a dealt
Quick Play hand regressed from version 3 to version 1, removing its cards and
restoring the pre-bet displayed stack. A separate delayed poll resurrected
`at-table` after a successful cash-out. Both failures are preserved in
`table-reconciliation-before-confirmed.log` under the new durable directory
`/Users/tj/arc21-evidence/astra-refresh-a-20260911/`. The harness delays only the
delivery of a real HTTP 200, without replacing its state or server transaction.
An earlier run also hit the local GoTrue/PostgREST `JWT issued at future`
timing issue during its wallet read; it is retained separately and does not
establish a product authentication failure.

The store now rejects older versions from HTTP and Realtime, deduplicates
feedback when a broadcast arrives before its HTTP reply, and ignores requests
from an earlier table-screen lifetime (including re-entry to the same game).
`table-reconciliation-targeted.log` passes **15 files / 240 tests**, including
both real-function regressions, exact wallet/ledger restoration after cash-out,
late-command/broadcast ordering and late closed-seat refusal tests.
`table-typecheck.log` passes. Only `online-table-store.ts` differs from the
377-file production/config manifest recorded for D12/D13. Their deletion and
Sprint waiting-entry/read/withdraw paths remain valid. One updated Release is
being prepared for the remaining shared-table/reconnect/multiplayer/Sprint
checks. Refresh B has not begun; no baseline PASS is claimed.

### September 11 midday resumption — retained native D14 evidence

The saved background runner **completed after the previous cutoff**:
`private-b-recover-play.xml` reports **1/1 passed**, exit 0. No replay was
needed. Client B restored game `d5712948-0dce-44c5-99af-aa7e5cce1919` and its
original seat `64d88484-2827-4729-a9c2-6a07aae07c5e`, reaching version 8,
then deliberately placed and locked 50 chips in hand 3 (events 44/45,
versions 10/11; final observation version 13). This flow launches the app;
its PID changed from 19723 to 20504. It proves same-seat restoration and
continued native play, not same-process recovery on B.

Client A's preceding outage proof is **1/1 passed** in
`private-a-reconnect.xml`: PID 20107 and start time remained unchanged before,
during and after the function pause; the reconnect banner appeared and cleared,
the same two seats remained, and authoritative version advanced from 2 to 3.
Both restored-state files confirm the function container running and unpaused.
The built and both installed Release bundles match SHA-256
`ccebabcf55c375e795f3ac2fd42ab4f3c52c96eee4381c7b6afb93630aad8930`
(`d14-release-installed.json`); `d14-release-source.json` identifies the source.

On midday inspection, both app processes still existed and were displaying
hand 337 of that same private game; `private-resume-current.json` records
version 1301, the same active seat IDs, and no duplicate seat creation. Wallets
and ledger sums remained A **25,000** (3 movements), B **25,200** (2 movements),
unchanged across all outage/recovery/wager observations. The retained idle
table had continued through its ordinary deadlines; it was not reset. Live
screenshots were inspected. Functions still answered expected unauthenticated
401, the database had zero idle-in-transaction connections, and the Sprint
read ACL remained exactly `{postgres=X/postgres,authenticated=X/postgres}`.
Host wager/cancel/departure and survivor checks are continuing on this table
before D14/private lifecycle closure.

The first midday host-play continuation failed its wager assertion: the driver
found the chip near a betting deadline, but `bet-deal` was gone by its next
read. No host BET_PLACED/BET_LOCKED event exists from that run. Its 14-iteration
budget then exhausted before the next betting window. This is a harness
failure, retained in `private-a-live-play-leave.xml`, not a new product defect.
`two-client-play.yaml` now allows multiple ordinary table cycles and requires
`table-hand-value` to show this player’s own 100-chip wager, so another seat’s
wager cannot satisfy it. No timer or production assertion was weakened. The
completed failed driver took time to exit; an attempted observer restart hit
the still-bound port before launching another native flow. That setup failure
is retained as `private-a-runner-port-busy.log`. The function remained running
and unpaused throughout.

Two further native attempts did not exercise the host wager. The first exceeded
Maestro's driver-start timeout; its XCTest HTTP server started late. A later
attachment found SpringBoard instead of the table. `Arc21-2026-09-11-130631.ips`
shows PID 20107 faulting inside the injected
`XCTAutomationSession initWithAccessibilityFramework:dataSource:` callback
(EXC_BAD_ACCESS); the SpringBoard crash report is retained too. These are
harness/platform interruptions, not evidence of a game-command crash. Host
load exceeded 300 on this 8 GB machine. B's simulator was shut down to reduce
pressure; the authoritative private game and both seats were preserved. A's
subsequent continuation must restore its existing seat and cannot claim the
old PID survived. The earlier successful same-process outage proof is intact.

Public matchmaking preparation found four old integration-fixture tables.
`public-fixture-cashout.py` verified their test-only identities and safe betting
phase, then sent 18 real CASH_OUT requests through the production function.
All succeeded; the last exit closed each table, leaving zero open public rooms
and zero wallet/ledger mismatches (`public-fixture-cashout.log` and JSON). No
room, seat, balance, or ledger was edited directly to empty that pool.

### September 11 evening continuation — recovered host play and departure

The first inspection found `private-a-restored-play-leave` had completed with
an assertion failure, not a pass. Its native command trace and retained database
events establish valid host play: hands 349/350/352/353 placed and locked
100/100/200/100 chips (events 7373/7374, 7393/7394, 7443/7444, 7465/7466).
`private-recovered-host-actions.json` preserves exact event times. Those times
match the native Deal taps. No host wager was replayed on this resumption.
The harness required `Bet 100` inside `table-hand-value`, but `HandCards` renders
these as separate sibling text nodes. `two-client-play.yaml` now locates the
wager to the right of this player's value. Its former impossible selector
caused the loop to continue after accepted wagers; these were distinct native
commands, not duplicate server processing. The failed artifacts remain intact.

`private-a-cancel-depart.xml` passes **1/1**, exit 0, on the installed D14 Release.
The read-only callbacks record cancellation preserving game `d5712948…`, both
original active seats and the host. Actual departure emitted exactly one
`SEAT_LEFT` (20471), marked A's seat left, and transferred `rooms.host_user_id`
to B while the game and room stayed active. A reached Home, then reopened the
private lobby to create/join without restoring its departed seat. Wallets and
ledger sums stayed A **25,000** / B **25,200**, with unchanged movement counts.
Evidence is `private-a-before-cancel.json`, `private-a-cancelled-leave-evening.json`,
`private-a-left-evening.json`, and `private-a-no-resurrection-evening.json` in the
September 11 durable directory. No fault was injected; functions are running
and unpaused, Sprint read ACL is restored, and idle-in-transaction count is zero.
The host began at load 5 with one booted simulator. B is now being booted alone
before native survivor/last-departure verification and public multiplayer.

## September 12 continuation — D14 and private lifecycle closure

**D14 VERIFIED; private multiplayer lifecycle complete.** The retained
`private-b-survivor-close-public.xml` completed **1/1 passed**, exit 0, before
resumption. It was inspected and not replayed. B restored its original seat
`64d88484…` in the same game at version **3761**, after A's departure at 3758.
Its screenshot shows a live betting countdown and correctly labels A's zeroed
seat “No longer playing at this table.” B's actual departure emitted exactly
one further `SEAT_LEFT` (20500), closed the room and completed the game at
version **3764**. The subsequent private lobby offered create/join; neither
original seat was resurrected. Final September 12 database inspection preserves
that completed state. `private-closure-verified.json` checks all eight lifecycle
observations, original seat IDs, nondecreasing versions, one departure per seat,
host migration, final closure, and unchanged wallet/ledger equality and counts.
The survivor, final Home and create/join screenshots were inspected.

Together with the retained real-backend D14 regression and 240 targeted tests,
and A's unchanged-process outage/reconnect and B's earlier 50-chip native wager,
this closes the requested private/reconciliation proof. Broadcast/HTTP feedback
ordering is covered by the targeted store regression; no duplicate processing,
seat creation, rewind or ledger divergence was found. No new production change
was required. D1/D7/D10/D11/D12/D13 remain verified. Refresh B has not begun.

B also queued publicly without a charge in that saved flow. Its five-minute
waiting reservation has since expired, so new public lifecycle work starts
from the current server pool after simulator startup settles. The successful
private proofs are preserved. Public multiplayer, Sprint completion, remaining
screen/error/accessibility checks, dependency reconciliation and final gates
remain open; the overall audit is still in progress.

### September 12 — public multiplayer verified

**Public native lifecycle VERIFIED on the unchanged D14 Release.** Six native
flows passed: B queue, A join, B seat/play (`public-b-seat-play-foreground`),
A play/cancel/depart, A rejoin/depart, and B survive/play/depart. All evidence
remains in the September 11 durable directory under `public-*-september12`.
`public-closure-verified.json` validates 15 captured server observations and
all six passing XML reports for game `5472f9b1…`, room `08ed2ab6…`.

Queueing and the seat offer charged nothing. Taking each seat charged exactly
2,000 chips; both devices saw the other account and each deliberately placed
and locked 100. A's cancelled leave retained its seat. Its actual cash-out
returned **1,920** once and cancelled the old reservation. Rejoining the same
live game allocated a new seat ID in the freed index 0, kept the original row
left, charged exactly one fresh 2,000 buy-in, and returned exactly 2,000 on the
second departure. B remained at its original live seat and deliberately wagered
100 again after those departures. Its final cash-out returned **2,060** once,
closed the room/game at version **47**, and left zero escrow and zero live seats.
The native Play screen then had no resume card. Wallets equal ledger sums at
every observation; final A **24,920**, B **25,260**. The three accepted seat
lifetimes have exactly three buy-ins, three cash-outs and three `SEAT_LEFT`
events. Screenshots confirm slot reuse and survivor play; no product fix was
needed.

The first B seat continuation attached to SpringBoard while its original app
PID **53859** remained alive. No buy-in occurred in that failed XML. Activating
with Maestro `launchApp: { stopApp: false }` preserved the process/reservation
and the missing step passed; `two-client-public-seat.yaml` now does the same.
The postflight verifier initially mishandled SQL's null aggregate for an initial
zero-event snapshot; its saved failure was corrected to treat that as the empty
event set. No native proof was repeated for that parser correction.

A recovered September 11 23:42 crash report also faults in injected
`XCTAutomationSession` callback code after the host flow's final observation;
it is preserved as `Arc21-2026-09-11-234253.ips`. September 12 simulator boot
reported a data-migration failure before normal SpringBoard/app startup. The
installed app subsequently rendered Home and completed the public flows. These
are harness/platform evidence, not independent game crashes. The host was
allowed to settle before native actions; no timer, ACL or backend fault was
introduced. `september12-release-check.json` confirms no production manifest
changes and all three built/installed bundle hashes still match.

Sprint completion is now using three new real Auth fixture accounts registered
through `REGISTER_SPRINT`; their gameplay uses the shipped `game-command`
endpoint. The native account registers and plays through the installed app.
No cards, engine rows, deadlines, outcomes or wallet balances are patched.

### September 12 evening — Sprint result and two new findings

The retained native Sprint job ended with a failed wager assertion; it was not
replayed. Server events prove six distinct native 500-chip placements and locks
on hands 1–6 (sequences 4/5, 41/42, 82/83, 121/122, 158/159, 195/196), matching
the saved Deal taps. The four-seat layout put the own-hand wager below the
viewport after dealing. The helper never scrolled there and kept iterating.
The failed flow remains failed; its accepted actions remain valid evidence.
Three independent real Auth/API peers completed the field through normal
commands and actual deadlines. Tournament `5f88c309…` completed twelve scheduled
hands at game version 133, with one elimination after six. Native A finished
first on **11,250**, earning **2,000 chips / 200 milestone XP** once. The other
survivors shared second and its pooled prize (750 chips / 100 XP each).

`sprint-completed-result.xml` passes **1/1** on the unchanged installed Release
and retained process: settled-seat return, “Finished 1st.”, final stack, prize
standings, no completed-table or withdrawal CTA, and Home wallet **26,420**.
Screenshots were inspected. `sprint-completed-september12.json` records matching
wallet/ledger sums for all four players. Sprint registration/D13 and the prior
multiplayer reconciliation/wallet proofs remain valid.

**D15 reproduced; fix pending:** an eliminated entry while its tournament is
running still offers “Open the table”, which lands on “You are no longer at
this table.” `sprint-eliminated-before.xml` intentionally confirms both screens
on simulator B. A second field was played by four authenticated fixture clients
through production APIs until elimination, then its clients stopped sending
commands. No engine/deadline/outcome was edited. The authoritative lookup in
`sprint-eliminated-running-before.json` names the departed seat; a command from
that account is correctly rejected `SESSION_CLOSED`. The screen excludes
completed tournaments from its CTA but fails to exclude eliminated entries.

**D16 reproduced; fix pending:** shared-hand bookkeeping only records the
command sender. Fresh fixture accounts have settled-event counts **19/13/18**
but player-stat counts **9/5/4**. The same handler synchronizes only the sender's
seat row, leaving another completed Sprint seat at 10,200 while the engine and
result correctly say 10,100. `game-command` applies shared engine events but
calls `accountForSettlement` and `syncSeatRow` only for `seat.id`. The wallet
ledger and Sprint placement calculation use the authoritative engine and are
unaffected; missing hand statistics/XP and stale seat projections require a fix.
The audit remains in progress, with these two newly established defects open.

### September 13 continuation — targeted fixes and profile persistence

**D15 fixed; updated Release verification pending.** The screen and store now
share `tableForEntry`: only an active entry in a running tournament with both
authoritative IDs can open a table. Eliminated players keep their truthful “out”
message even while survivors contest a tie. Ten focused navigation cases cover
historical seat IDs, non-running tournaments, missing IDs and sudden death.

**D16 fixed; real backend regression passed.** The command handler now records
each authenticated seat's own settlement events and synchronizes every engine
seat projection in its existing transaction. The replay guard and engine lock
remain unchanged. `shared-bookkeeping-before.log` reproduces a neighbour's
missing hand/XP and 5,000-versus-4,900 stale projection. Its cleanup also had an
independent harness error: CASH_OUT was sent to the game-command endpoint rather
than the gateway's dedicated `cashOut` method. That cleanup was corrected without
changing the product assertions. `shared-bookkeeping-after.log` passes the same
real shared-hand assertions, including replaying the exact settlement intent
without duplicate statistics or XP. `shared-bookkeeping-production-regressions.log`
passes **2 files / 7 real backend tests**, including the existing two/five-client
lifecycle and D14 reconciliation. TypeScript, **4 files / 67 targeted tests**,
and `d15-d16-functions.log` also pass. A sandbox-denied initial Deno download was
rerun with network access; it was not a product type error. Final native evidence
and current-code gates remain outstanding.

**Profile save/persistence verified.** `profile-rename-persist.xml` passes 1/1:
the native editor closes after saving “Astra Audit A”, and the name survives a
cold relaunch without clearing app data. `profile-rename-persist-server.json`
confirms the server display name and unchanged handle. `profile-name-restored.xml`
passes 1/1 restoring `p7fdfb412af53` through the same UI and cold launch;
`social-before.json` confirms the original server name. No handle was renamed.

Social block cancellation retained the friendship (`social-block-cancelled.json`).
The subsequent real block removed it and created one block (`social-blocked.json`).
Failed continuations are retained: an index selected the background Block button,
a later assertion looked below the viewport, and keyboard handling opened the
Unblock dialog during a search. Screenshots and server reads distinguish these
driver errors from the actual committed block. The final continuation starts
from that existing state; acceptance and blocking are not being replayed.

Compatible security updates installed Vitest/coverage **4.1.11**, js-yaml
**4.3.2**, and xmldom **0.8.15 / 0.9.12**. Their dependency diff is being reconciled
against the current advisory feed; no Expo/React Native/Router version changed.
This requires fresh install/build/current-code gates. The earlier runtime proofs
remain evidence for their unchanged production paths; D15 needs a new bundle.

### September 13 — Social closure, shared bookkeeping and startup finding

`social-search-unblock-continue.xml` passes 1/1: a blocked peer is absent from
search; cancelling Unblock preserves the row; actual Unblock removes it without
recreating a friendship. A fresh real request was then accepted through the UI.
`social-private-invite.xml` and `social-invite-join-foreground.xml` each pass 1/1:
A creates room `42096b4d…` / `4AT3ND`, sends one invitation, and B opens that exact
inbox receipt, joins the same room and sets Ready. The notification becomes read;
wallets stay A 26,420 / B 24,000 and equal their ledger sums. The private invitation
uses the shipped inbox and room-code route, not an injected navigation target.

The subsequent native host flow accepted exactly one deliberate 100-chip wager
in game `007b6f19…`. Its later Next hand assertion failed: the screenshot is
already on hand 3 after the short shared settlement window. It is retained as a
failed flow, not relabelled. The app continued normal deadline resolution while
the audit was inactive. `social-shared-current.json` contains 636 settlements per
seat. Both player-stat deltas equal all 636 events, their exact wager sums
(12,800 / 12,720) and net sums (-2,690 / -3,000). This verifies D16's previously
missing neighbour bookkeeping through the running native client and server,
alongside its passing real-backend replay/XP/projection regression. Native
fixture departure and final projection checks are being completed.

**D17 observed and fixed; current Release proof pending.** The first peer launch
for the invitation crashed at 03:17:27 in
`FileSystemManager.ensureDirExists`, called by `SQLiteModule` on its concurrent
async queue. Another thread in that same report is initializing the same path.
This is separate from the earlier injected XCTest crashes and is not dismissed
as a harness failure. The production callers create independent SQLite stores
for settings, guest identity and onboarding; their per-instance promises allow
concurrent native initialization of one database against Expo's lazy filesystem
manager. Five subsequent standalone cold launches did not repeat the intermittent
crash. Its report and all failed artifacts are preserved under `social-invite-join`.

SQLite initialization now shares one promise per database, serializes opens and
allows recovery after a rejected initialization. The native import is isolated
behind a small loader; initial Vitest attempts to mock the native package failed
in Expo/React Native module loading and are retained separately. With that test
boundary corrected, `sqlite-startup-before.log` reproduces competing opens and
the permanently rejected promise; `sqlite-startup-after.log` passes **6 files /
63 tests**. Final native cold-start, Practice and settings persistence checks
remain necessary before closing D17.

The first final gates passed typecheck, lint, **128 files / 2,444 unit tests**,
**126 files / 2,418 coverage tests**, and contrast. Doctor then failed at 20/21
because thirteen SDK patch versions became required. Those original logs remain
intact. Official changelogs and source comparisons are saved in
`expo-sdk-patch-review.json`; dependency changes and transitive changelogs are in
`expo-sdk-transitive-review.json`. The aligned graph now passes Doctor **21/21**
and TypeScript. Router adds optional APIs/native-tabs fixes; Arc 21 uses its
existing Stack/Tabs. Native modules/JSI and build tools also advance, requiring a
fresh build and native bridge/storage/navigation checks. The shipped game,
wallet and reconciliation rules remain unchanged. A new final gate/build pass
will identify this artifact separately. Refresh B has not begun.

**D16 VERIFIED; invitation fixture closed.** Both native departure flows passed
1/1. `social-shared-closure-verified.json` checks game `007b6f19…` completed at
version 2494, the room closed, one departure per seat, and both zeroed seat rows
matching the engine. Final statistics match all **640 / 641** settled hands,
wagers **12,880 / 12,820**, and net **-2,690 / -3,060**. Repeatable XP reached the
server's 300-per-day cap for each player; the exact uncapped per-hand/replay
behavior remains covered by the backend regression. Wallets and ledgers stayed
26,420 / 24,000. No fault, deadline or outcome was injected.

The postflight A crash at 14:13:53 is separately preserved as
`Arc21-2026-09-13-141429.ips`. Its faulting frame is an injected
`XCTAutomationSession` callback, after the successful departure snapshot.
`social-a-postflight-crash-summary.json` records that classification. It is not
the SQLite startup crash and does not invalidate the committed departure proof.

### September 14 continuation — current Release and D15 closure

The background final build completed successfully at 21:39 UTC September 13.
Its ten recorded stages all passed: clean `npm ci`, TypeScript, lint (0 errors /
38 warnings), **129 files / 2,446 unit tests**, **127 files / 2,420 coverage
tests** with the per-area gates, contrast, Doctor 21/21, Bundle Mode export,
clean iOS prebuild and two-worker Release build. The actual embedded bundle is
`a11e47037b9dd2637eecaf4acbf10959557460d4fb364d82ae17ce464fba27dc`; its
matching map is `1fdf84f976c31cb2b8a8b36385e24311d134b11b351dbae74f2ac4cac7156d86`.
`final-release-source.json` matches the current recorded production files, and
`final-release-install-a.json` / `-b.json` verify both installed bundle hashes.
The prior gates and failed Doctor attempt remain separate artifacts.

**D15 VERIFIED.** `sprint-eliminated-after.xml` passes 1/1 on that Release and
the existing eliminated account/field: truthful ongoing-tournament message, no
Open table or Withdraw control. Its screenshot was inspected. The server read
`sprint-eliminated-after-server.json` confirms the field was still running, the
same entry eliminated, and wallet = ledger = 24,000. No tournament was recreated.
The three survivors then completed the existing field through normal
`game-command` actions. `sprint-elimination-final-server.json` records the full
12 scheduled hands plus the earlier tie hand, placements 1–4, prizes
2,000 / 1,000 / 500 / 0 and XP 200 / 120 / 80 / 40. Each account has one entry
debit, each nonzero prize has one ledger credit, and all four wallets reconcile.
The completed-result screen is being checked separately.

Five standalone current-Release cold starts reached Home with the existing
26,420 wallet and the same saved Practice session; all five screenshots in
`sqlite-startup-native-after` were inspected. The guest identity is unchanged
from `final-storage-before.json`. Real Practice kill/resume and settings writes
remain the last D17 storage checks.

`final-release-dependency-reachability.json` records the matching map's 2,646
sources, the bundled decoder/query-string, their overridden upstream parser,
and Expo's active bounded inbound parser. npm `image-size`, npm `uuid` and test
modules are absent. The server-namespace modules in the bundle are the intended
shared strategy/career data and engine primitives, not the private backend.
Native hostile-link responsiveness is still pending.

Booting B caused heavy swapping and a transient load spike above 50. A was shut
down before continuing; subsequent native checks use one booted simulator.
`final-native-host-pressure.json` retains the observation. D15's actual
assertions and screenshot passed after its driver started; no timeout was
relabelled as an application failure.

**D17 VERIFIED.** `final-native-storage.xml` passes 1/1 on the current Release.
It confirms the same eliminated Sprint entry now says “Finished 4th.” with its
10,200 final stack, then writes all three accessibility overrides, cold launches
and reads them back as enabled. It deliberately wagers 100 in offline Practice,
reaches a live decision, kills the app and restores the same hand: 10♦ / 8♣
against the dealer's visible 7♦ and concealed hole card, unchanged 100 bet,
player/dealer totals and available actions. The before/after screenshots were
inspected. `final-storage-b-after.json` independently confirms the unchanged
guest identity, persisted settings and PLAYER_TURNS / hand 1 / last bet 100.
Together with the five standalone starts and the targeted failing-then-passing
initialization regression, this closes D17. It does not claim that five starts
alone establish a statistical crash rate.

`sprint-elimination-no-active-session.json` additionally verifies all four
accounts' real authenticated active-session lookups are empty after completion.
Historical seat/entry rows retained as active survivors are not live tables: the
lookup and admission rules also require an active game session. The tournament
is completed and its prizes reconcile in `sprint-elimination-closure-verified.json`.

### September 14 — maximum-text defects reproduced

The remaining accessibility pass established four locally fixable issues; the
audit remains in progress. These are rendered-product failures, not driver
timeouts inferred to be bugs.

- **D18: live Dynamic Type change leaves stale text measurements.** Home's
  labels and wallet draw enlarged glyphs inside their old small boxes. The
  saved `accessibility-home.png` shows the clipping; a standalone cold launch
  at the unchanged maximum size renders them correctly in
  `accessibility-home-cold-before.png`. The installed Fabric implementation
  caches paragraph content/measurement across a layout-context-only change.
  This matches the independent [React Native report #57512](https://github.com/react/react-native/issues/57512).
  `AppText` now subscribes to font scale and remounts only its native text node
  when that scale changes, preserving the surrounding screen and store state.
- **D19: the hand value/wager row cannot wrap.** The exact restored Practice
  hand shows “Hard 18 · Bet 100” extending outside both screen edges at maximum
  text size. `accessibility-screens-max-text` fails its full-visibility check;
  the hierarchy repeatedly measures the value starting at **x=-63**, so vertical
  scrolling cannot repair it. `HandCards` now constrains that row to the
  available width and permits its complete labels to wrap.
- **D20: Strategy Guide uses unbounded detail and fixed text geometry.**
  `accessibility-strategy-before` fails because the detail panel's header and
  Close control are above the screen. `strategy-chart-max-before.png` also
  shows clipped dealer upcards, row numbers and action letters in fixed cells.
  The panel now has a bounded height, fixed reachable header/Close and scrolling
  body; chart/legend geometry grows with text size. Body text is not capped.
- **D21: unknown-link recovery controls are outside a non-scrolling screen.**
  `unknown-link-max-text-before` cannot reach Go to Home or Play Practice. Its
  screenshot shows the explanatory content extending below the viewport and
  scrolling has no effect. The screen now scrolls through its content and
  recovery controls inside the safe area.

These changes await one batched Release rebuild and the exact native
regressions. No new assertions about successful accessibility have been made
from the earlier partially completed flow. Profile's text and navigation
controls were readable in its inspected maximum-text screenshots.

The four accessibility fixes pass TypeScript and **13 files / 238 targeted
design, learning and persistence tests** (`accessibility-typecheck-final.log`,
`accessibility-targeted.log`). Those tests are supporting checks; the saved
native reproductions are the regression gates for these rendering defects.
The system font was restored to `large` and both simulators shut down before
the incremental two-worker Release build. The earlier D15/D17 embedded bundle
is retained as `release-d15-d17.jsbundle`; its map and source manifest remain
unchanged. No dependency, engine, wallet or reconciliation source changed in
this accessibility batch.

### September 14 afternoon — rebuilt accessibility regressions

The incremental two-worker Release build completed successfully at 11:18 UTC.
`accessibility-build-result.json` and `accessibility-release-source.json` record
that artifact: embedded bundle
`ebf3cbb42a04ef72ea94ee8d893a40772c6fbedcba7b7e10b166cdc932b743fd`, matching map
`550b6d0781e38655890acfc22e784f9a1a5f2d1cd869ec3a23a4548d972b6136`.
The installed B bundle matches. The map differs from the preceding D15/D17
artifact only in the four accessibility components; all dependency contents
are unchanged (`accessibility-release-dependency-reachability.json`).

**D18 VERIFIED.** `font-change-after.json` records a live normal-to-maximum
Dynamic Type change with the same standalone process, PID 85193. Both inspected
screenshots show Home remeasuring its labels and wallet correctly without a
restart. The surrounding account and Practice state remain intact.

**D20 and D21 VERIFIED.** `accessibility-native-after.xml` passes all three
flows (screens, Strategy Guide, unknown-link recovery) on that Release at the
maximum system text size. Inspected Strategy Guide images show complete chart
labels/cells and a bounded detail panel with its header/Close still reachable
while the body scrolls. Native taps close it and select Soft/Pairs. The unknown
link's two recovery controls are visible after scrolling; Go to Home succeeds.
The full table wager capture is being supplemented because the first passing
flow captured the total while the wager remained below the felt viewport.
The original screenshots, including a Home transition captured mid-animation,
remain intact; neither is being represented as a settled visual proof.

**D19 VERIFIED.** `accessibility-viewport-followup.xml` passes the narrow
follow-up on the same saved hand, without another wager. Its inspected
`accessibility-practice-wager.png` shows both complete “Hard 18” and “Bet 100”
labels wrapped within the felt, with the action controls reachable. The Home
capture now waits for the route animation and shows a settled, correctly
measured screen. The system text size was then restored to `large`.

The normal-size boundary batch passes stale-table/room refusal, private friend
record and lobby destination, horizontal chart selection, and the cold Learn /
recovery / Create Account return flows (`final-native-boundaries.xml`: 3/4).
The closed game's version/events/seats and both wallets remain unchanged across
the read-only observations. The hostile query reached Career, then failed on
its requested Back control; that flow is preserved as failed, not a decoder PASS.

**D22 reproduced and fixed; native verification pending.** The ordinary
Home → Play → Career route independently reaches the same screen with no Back
button (`career-map-return-before`, failed visible-control assertion). The
Career map is a root Stack route outside the tab bar, and neither its header
nor content renders a return control. iOS edge-swipe is the only direct return;
this violates the existing BackBar's accessible-navigation requirement.
The map now uses that shared BackBar above its scrolling content. The regression
covers ordinary and cold entry; the hostile-link flow will also verify actual
navigation after its malformed query. No gameplay or progression rule changes.

Host load briefly exceeded 80 during this pass. The recorded process inventory
shows a separate eight-worker Python validation job competing with Maestro;
it was left untouched. The Career failure has a rendered screen and the exact
missing-control assertion, and the independent source audit confirms the
omission. It is not inferred from a driver timeout or crash.

### September 14 evening — final current-code gates recovered

`final-a-gates.json` records nine successful stages, completed at 21:24 UTC:
TypeScript, lint (0 errors / 38 warnings), all three Edge Function typechecks,
contrast, Doctor 21/21, **129 files / 2,446 unit tests**, **127 files / 2,420
coverage tests** with every per-area threshold, Bundle Mode export and the
incremental two-worker Release build. The timing-sensitive stages waited for
host load to fall; their assertions and timeouts were not weakened. The valid
clean install and clean native prebuild remain `final-current-npm-ci.log` and
`final-current-prebuild-ios.log`; package/lockfile and native configuration are
unchanged since those gates.

The final artifact is bundle
`c765bef7b87057f591cbf4525d27fa988456847da2ec7ad53434512ece8970b9`, matching map
`268691b7dad713f7e5297c9e62c86aa65b2017c167820d62ff59bba7170cb447`.
`final-a-release-source.json` matches the current production files. Its 2,646
source contents differ from the verified accessibility artifact only in
`app/career/index.tsx`; all dependency contents and resolver checks remain
identical (`final-a-dependency-reachability.json`). The September 14 npm feed
still reports the same four advisories / 18 affected package entries.
Native D22/hostile-link closure and the final reset/pgTAP/server gates remain.

**D22 VERIFIED.** `final-a-native-return.xml` passes both normal/cold Career
return and the malformed-link flow on the final Release. The latter opens a
12,291-character `%FF` query through the installed app's real inbound route,
renders Career, accepts Back and returns to Home with the unchanged wallet and
Practice session. No synthetic decoder or navigation handler is substituted.
`final-a-native-career-max.xml` also passes; inspected screenshots show the
complete Back control at maximum Dynamic Type and the settled Home return.
The system text size is restored to `large`. The prior missing-control failures
remain separate evidence. This closes the remaining native navigation finding
and the native dependency-reachability check.

Final documentation review removed the unused `DAILY_CHALLENGE_SEED_SECRET`
environment instruction: production instead calls `ensure_daily_challenge_for`,
which creates each date's secret with Postgres `gen_random_bytes(32)` and stores
it in the protected row. The runtime and secret handling are unchanged. The
release/deployment and database counts now identify all 59 migrations.

Both simulators now have the final bundle, verified by
`final-a-release-install-a.json` and `-b.json`; their standalone Home screenshots
were inspected. Their existing wallets and saved Practice sessions persisted.
A's simulator boot utility printed “Data Migration Failed” but then completed
installation and a successful standalone launch; this is recorded separately in
`final-a-install-observation.json`, not asserted to be an Arc 21 crash. Both
simulators are shut down and their system text sizes are restored to `large`.
The three app overrides were restored through native UI and independently read
from SQLite (`accessibility-settings-restored.json`).

`final-a-pre-reset.dump` preserves the local database before the final reset,
mode 0600, with its hash in `final-a-pre-reset-backup.json`. `supabase start`
passed. The final clean local reset applied all **59 migrations**, and the
applied-version list exactly matches the repository. Functions were re-served
from current source. `final-a-backend-preflight.json` verifies unauthenticated
401, an authenticated database-backed `NOT_A_PARTICIPANT` 403, and migration
parity. `final-a-pgtap.log` passes **30 files / 592 assertions**. The full
required server suite is now running separately from native/build work.

### September 14 night — Refresh A closed

The background required server sweep completed at **02:52 UTC September 15**:
**25 files / 320 tests passed**, exit 0. One local `WorkerAlreadyRetired` response
was recovered by the existing identical-body retry; its dispatcher stack and
CPU-budget retirement are retained in `final-a-runtime-retirement.json`. No
assertion or timeout was changed. The clean-reset pgTAP result remains 30 files /
592 assertions, with all 59 migrations applied.

`final-a-postflight.json` passes the live authorization-surface check and reads
**505 wallets**, all equal to ledger sums, with zero negative balances, duplicate
live-seat accounts or idle-in-transaction connections. Daily and Sprint have
their exact restored authenticated read grants; client roles cannot use the
private schema. Application services are running and unpaused, both function
routes return the expected unauthenticated 401, and no audit driver/observer is
active. The pre-reset database remains backed up; the current database contains
the new server-suite fixtures. Both simulators are shut down with text/settings
restored, after verified installation of the final bundle.

Final diff review covers **89 intended files**. `final-a-diff-inventory.json`
records their hashes, the published local-only test-key exceptions and zero
unexpected credential patterns. `final-a-lockfile-review.json` accounts for all
88 changed lockfile nodes. All 378 built-artifact manifest files still match.
Working and staged diff checks pass. `AGENTS.claude-backup.md` is unchanged and
excluded. The full intended patch is preserved as `final-a-checkpoint.diff`;
`final-a-checkpoint.json` records the resulting local commit and tree.

The final scope matrix, current gates and activation limits are at the top of
this document. The release index and dependency disposition agree with them.
Every Refresh-A finding is verified, including D14/private departure and host
transfer, public seat reuse, Sprint elimination/completion, shared accounting,
storage, Social/account boundaries and the final accessibility/navigation fixes.
No expensive valid proof was replayed solely because context changed.

**ASTRA BASELINE AUDIT: PASS**

**KNOWN CURRENT RELEASE-BLOCKING SOFTWARE DEFECTS: 0**

Refresh B has not begun. No push or deployment is part of this checkpoint.
