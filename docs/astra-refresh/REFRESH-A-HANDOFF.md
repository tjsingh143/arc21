> Historical September 6 checkpoint. Refresh A completed with PASS on September 14 PDT.
> [baseline-audit.md](./baseline-audit.md) contains the final verdict and evidence;
> the pending work and runtime instructions below are superseded. Refresh B has not begun.

# ASTRA PRODUCT REFRESH A — continuation handoff

**Checkpoint written 2026-09-06 in `/Users/tj/arc21`; live state captured at
12:43–12:44 PDT.**
**Refresh A is unfinished. No baseline PASS has been issued. There are open,
locally fixable client defects.** This document is the continuation authority for
work performed in this Astra audit; older release reports are historical claims.
The user requested this checkpoint before any more implementation or expensive
verification. This checkpoint turn made no production-code changes and ran no
build or test suite.

## 1. Mission and non-negotiable instructions

Independently audit the CURRENT Arc 21 baseline through source inspection,
production client callers, real local Supabase authority, and actual rendered
simulator controls. Do not trust the earlier agent's Phase-12 PASS as fact.

- Continue this checkout and its saved evidence. Do not restart the audit or
  repeat completed expensive work unless subsequent changes/failures require it.
- Work in the main Codex session yourself. **No subagents, parallel agents,
  secondary Codex processes, teams, or additional worktrees.** Ordinary test
  runner workers are not agents; avoid excessive host load.
- Existing defects: reproduce → fix root cause → meaningful regression →
  reverify through the production path. A source-only or helper-only PASS is not
  adequate. Inspect screenshots and ask the server/database at checkpoints.
- **Do not begin Refresh B.** No pseudonymous-user system, AI Tables, or new
  Home hierarchy. Preserve current product decisions unless fixing an existing
  defect requires a change.
- Do not ask routine implementation questions. Use repository/specification
  evidence and engineering judgment. Ask only for genuinely unrecoverable
  information, irreconcilable product decisions, external credentials/account
  decisions, or irreversible destructive actions.
- Keep concise progress commentary at least every 60 seconds during work.
- Finish `docs/astra-refresh/baseline-audit.md`, update relevant launch docs,
  retain a concise durable `AGENTS.md`, and make a local checkpoint commit when
  the audit is complete. **Do not push.**
- The user has now specifically requested only this handoff in this turn.
  Implementation and testing resume in the next session/request.

The eventual final stop condition, only when justified by completed evidence:

```text
ASTRA BASELINE AUDIT: PASS

KNOWN CURRENT RELEASE-BLOCKING SOFTWARE DEFECTS: 0
```

These lines are a future condition, **not this handoff's verdict**.

## 2. Exact git/worktree state

- Repository: `/Users/tj/arc21` (macOS, zsh).
- Branch: `phase14-s2-security`.
- HEAD: `58dcf39fc66a3d1fcb81a20c34beb77875ff929a`.
- HEAD subject: `phase 12: production release candidate`.
- Origin, fetch and push: `https://github.com/tjsingh143/arc21.git`.
- Upstream: `origin/phase11-adversarial-qa`; it is not the branch's own name.
  Starting HEAD was one commit ahead of this upstream.
- No audit commit, push, rebase, or worktree has been made. Changes are unstaged.
- The sole initial user change was **untracked `AGENTS.claude-backup.md`**.
  Preserve it and **exclude it from the audit commit**. It is historical context,
  not the current Codex instruction file.
- Lockfile/package versions and migrations have not been changed by this audit.
- `ios/`, `android/`, `.env.local`, dependencies, and generated build outputs are
  ignored. Do not stage credentials or generated native projects.

Dirty files immediately before this handoff was written, followed by this new
handoff itself:

```text
 M app/(auth)/create-account.tsx
 M app/_layout.tsx
 M app/auth/recovery.tsx
 M docs/LAUNCH_STATE.md
 M src/components/table/BettingBar.tsx
 M src/components/ui/BackBar.tsx
 M src/features/auth/auth-failure.ts
 M src/features/auth/supabase-auth-adapter.ts
 M src/features/career/career-server-store.ts
 M src/features/daily/daily-store.ts
 M src/features/matchmaking/matchmaking-store.ts
 M src/features/quick-play/quick-play-store.ts
 M src/features/tournament/tournament-store.ts
 M tests/auth/auth-failure.test.ts
 M tests/deep-links/decode-uri-component-reachability.test.ts
 M tests/e2e/practice-resume.yaml
 M tests/engine/fairness.test.ts
 M tests/matchmaking/take-seat.test.ts
 M tests/server/economy-authority.integration.test.ts
 M tests/server/password-recovery.integration.test.ts
 M tests/server/two-client-table.integration.test.ts
 M tests/tournament/tournament-store.test.ts
?? AGENTS.claude-backup.md                  # USER FILE: exclude
?? AGENTS.md
?? docs/astra-refresh/baseline-audit.md
?? docs/astra-refresh/REFRESH-A-HANDOFF.md
?? src/lib/supabase/session-intent.ts
?? tests/auth/password-recovery.test.ts
?? tests/auth/session-intent.test.ts
?? tests/e2e/cold-deep-links.yaml
?? tests/server/entry-response-loss.integration.test.ts
```

Recent preceding commits: `08b0326` (phase 11 count the runs), `f0b847c`
(concurrency documentation correction), `67ea465` (SDK realignment wording),
`9f33e99` (SDK note). Do not infer verification from these subjects.

## 3. Exact interruption point and first next actions

The last implementation/test work occurred **2026-09-05 at 23:04 PDT**.

1. A real native ranked Career First Deal session finished all ten hands. The
   database recorded **2 stars, 2,100 final practice-stack chips, and one 200-chip
   Career reward**. Returning to the node showed the stale pre-completion CTA:
   `Play ranked`, first-reward copy, and no `career-server-record`. The failing
   native flow is `device-competitive-continue.log`.
2. Inspecting `app/career/[slug].tsx` found `RankedCta` refreshes server progress
   only while `loaded` is false. `app/career/index.tsx` has the same one-time
   `serverLoaded` guard. No focus/return invalidation has been implemented.
   The fresh-session action is to finish this root-cause investigation/fix and
   add a real regression for returning after ranked completion. **Do not replay
   the already completed ten hands merely to rediscover their result.**
3. While that native run proceeded, real response-loss tests reproduced the
   existing Career/Daily opening failure message after the server had already
   created an attempt. Their two production stores were patched to use the
   new shared intent retry. Six entry-loss integrations plus six existing
   Career/Daily unit files passed: **7 files / 118 tests** at 23:02:59.
4. Then the same boundary audit found **Daily treats failure to read
   `my_daily_entry` as `attempt = null`**, which offers a fresh ranked attempt
   despite an existing entry. A real SDK/GoTrue regression was added and failed
   at 23:04:13. **This defect has NOT been fixed.**
5. The entry-loss file now has **9 tests**. The most recent focused run selected
   the Daily read failure and the two double-response-loss cases: **1 failed,
   2 passed, 6 intentionally unselected/skipped**. No full run of the current
   nine-test file has occurred. Current TypeScript/lint/native build evidence
   predates the Career/Daily store edits and these last three tests.
6. Native Daily play **never started**: the continuation flow stopped at the
   Career record assertion before its Daily section. The device account still
   has **zero `daily_entries` rows**, confirmed at handoff.

Recommended immediate continuation sequence:

- Read `AGENTS.md`, this handoff, the current diff, the two failing logs, and
  their production callers. Do not reset the DB or app merely to get a clean
  screen; current stale Career state is useful reproduction evidence.
- Fix the proven Daily read-as-empty defect in `daily-store.ts::load`; on an
  unreadable entry, do not render the fresh-ranked plan. The new failing test
  already exercises the real existing entry and drops its successful read.
- Fix ranked Career progress refresh on return/focus in the map and node
  detail (determine appropriate lifecycle from existing navigation code).
  Verify successor unlock/replay wording/record, not just the store's loaded
  flag. The map already combines local and server unlock records; **do not
  incorrectly replace that product decision with local-only/server-only gating**.
- Re-run changed tests/TypeScript/lint, then make an **incremental** native
  Release build once these fixes are ready. Existing native builds prove the
  native toolchain; a new build is needed only because the newest code is not
  embedded in the installed artifact.
- Continue native Daily, account, multiplayer, Sprint, error and accessibility
  coverage using the preserved fixtures and flows below. Finish documentation
  and the local commit only after all open defects are resolved.

## 4. Defect ledger and all uncommitted production changes

### D1 — PKCE recovery code consumed twice on a corrected password retry

**Fixed; real GoTrue regression passed; full successful recovery UI still pending.**
On a valid recovery link, submitting the existing password exchanges the code
successfully, then GoTrue refuses the password (`same_password`). Correcting the
password on the same screen formerly tried the consumed code again.

- `src/features/auth/supabase-auth-adapter.ts`: retains the verified recovery
  `{code,userId}` in the adapter closure after exchange; a same-code retry must
  still have a current session for that verified user. Different code exchanges
  independently. Sign-out/replaced identity invalidates the retained flow;
  successful password update clears it.
- `src/features/auth/auth-failure.ts`: useful `SAME_PASSWORD` classification;
  `pkce_code_verifier_not_found` becomes `RECOVERY_LINK_INVALID`.
- Evidence: `recovery-reproduction.log` failed through the shipped adapter;
  `recovery-after.log` passed, including old-password login failing and corrected
  password login succeeding. The earlier `recovery-before.log` ran zero tests
  because functions were restarting (503), not because recovery was tested.

### D2 — cold Learn Back had no route to return to

**Fixed and native verified.**

- `src/components/ui/BackBar.tsx`: ordinary Back uses `router.canGoBack()`;
  otherwise replaces with `/(tabs)/home`. Explicit custom handlers still win.
- `app/_layout.tsx`: `unstable_settings.initialRouteName = "(tabs)"` anchors
  cold deep links to Home, covering other footer Back/Practice Close/table-return
  paths as well as BackBar.
- `device-cold-before.log` and failure screenshot reproduce dead Learn Back.
  `back-ready.log`, then the cold-link section of `device-round-one.log`, pass
  on the patched Release. Initial immediate post-navigation taps in
  `device-cold-after.log`/`device-cold-settled.log` missed; retain those failures.

### D3 — missing-code recovery instructions offered no actual way to Sign in

**Fixed and native verified.**

- `app/auth/recovery.tsx`: Sign in button exists outside every recovery branch,
  including missing code, invalid code and form; disabled while busy;
  `testID="recovery-sign-in"`.
- `recovery-missing-before.png` shows the old dead end.
  `recovery-ready.log` and cold-link section of `device-round-one.log` verify
  actual Sign in form destinations for missing and rejected recovery links.

### D4 — cold Create Account's existing-account CTA returned Home

**Fixed and native verified.**

- `app/(auth)/create-account.tsx`: `I already have an account` now replaces with
  `/(auth)/sign-in` instead of `router.back()`.
- `device-create-before.log` failed and photographed Home as wrong destination.
  The identical reproduction, `/tmp/.../cold-create-before.yaml`, passed as
  the first section of `device-round-two.log` after the 22:44 Release build.

### D5 — uncertain economic responses falsely claimed nothing was charged

**Quick Play/public/Sprint fixed; real production-store regressions passed.**

- New `src/lib/supabase/session-intent.ts`: creates one UUID and timestamp for
  a create-session intent, tries at most twice with the identical body, retries
  only transport/timeout/unreadable responses. A parsed rejection, including
  `INTERNAL`, is final and is never retried. Caller must reconcile if unknown.
- `src/features/quick-play/quick-play-store.ts`: uses helper for `OPEN`, avoids
  overlapping opening intent, truthful uncertain wording, wallet/active-seat
  refresh on unknown or malformed accepted response.
- `src/features/matchmaking/matchmaking-store.ts`: same helper for
  `JOIN_PUBLIC_TABLE`, wallet/active-seat reconciliation and truthful seat
  uncertainty instead of claiming no charge.
- `src/features/tournament/tournament-store.ts`: same boundary for register and
  withdraw; mutually excludes pending register/withdraw; reloads entry and
  wallet; parsed rejection wording retained; failure to read entry becomes
  unavailable rather than inviting registration as though no entry existed.
- `entry-loss-reproduction.log`: four real failing cases, committed server
  responses dropped after HTTP 200; wallets really debited.
- `entry-loss-final.log`: four real production-store integrations plus nine
  Sprint unit tests passed (13). Latest 118-test run also passed these four.
- Lost withdrawal response was also exercised against the real server and
  refunded exactly once in `entry-loss-complete.log`; that run nevertheless
  failed because its assertion expected the first reply's wording rather than
  the replay's truthful zero-additional-refund wording. The permanent integration
  was narrowed to registration because shared Sprint pool fill made waiting-
  only withdrawal assumptions invalid. Withdrawal caller regression remains in
  the nine unit tests and original real server refund/idempotency tests.
  Do not call the intermediate failed integration a wholly passed test.

### D6 — Career/Daily opening response loss falsely claimed no attempt recorded

**Patched; partial validation complete; not in installed native Release.**

- `src/features/career/career-server-store.ts`: `START_CAREER_NODE` uses shared
  intent retry, guards `busy`, and refreshes progress/active seat after two lost
  replies. Common unreachable copy no longer says nothing was recorded.
  `SUBMIT_CAREER_DRILL` still uses its previous bounded caller; only its shared
  unreachable wording changed. Do not claim a new drill retry implementation.
- `src/features/daily/daily-store.ts`: `START_DAILY_CHALLENGE` uses shared intent
  retry, guards `starting`, reloads Daily/active seat if unknown, then sets
  uncertainty notice; parsed server rejection is shown. Store initializer now
  receives `get` as well as `set`.
- `competitive-entry-loss-before.log`: two failures after real committed opens.
- `competitive-entry-loss-after.log`: 7 files / 118 passed, including both new
  single-lost-reply integrations (six entry-loss cases at that time).
- Two newer double-lost-reply cases passed in `daily-entry-read-before.log`,
  with byte-identical retries, unchanged 25,000 wallet/ledger, authoritative
  active seat; Daily additionally reloads its in-progress ranked attempt.
- Awaiting final typecheck/lint/current nine-test run and fresh native embedding.

### D7 — failed Daily entry read is rendered as an empty ranked history

**OPEN, reproduced, regression currently red. Do not PASS.**

`src/features/daily/daily-store.ts::load` currently does:

```ts
const attemptResult = await bounded(client.rpc("my_daily_entry"));
const attempt = attemptResult && !attemptResult.error
  ? toAttempt(attemptResult.data) : null;
```

An existing ranked entry was created through the actual store/server. The
regression drops only the successful `my_daily_entry` HTTP 200 read via the real
SDK fetch boundary. The store still yields `status.kind === "ready"` instead of
`"unavailable"`, meaning a read failure can advertise a fresh ranked attempt.
Failing test name: `does not offer a fresh ranked Daily attempt when its existing
entry cannot be read`, in `tests/server/entry-response-loss.integration.test.ts`.
Evidence: `daily-entry-read-before.log`. No fix has been applied.

### D8 — ranked Career completion leaves node/map server progress stale

**OPEN, native reproduction plus database evidence. No fix/regression added yet.**

- A's First Deal ranked attempt completed ten real server hands, 2 stars,
  final stack 2,100, one 200-chip reward; wallet/ledger now 25,250.
- Returned node still shows `Play ranked`, `Earns 200 chips and 40 XP the first
  time you finish it`, and no server record. The saved failure screenshot visibly
  includes the complete CTA region, so this is not merely an offscreen selector.
- Node detail `RankedCta` only refreshes if `loaded` is false. Career index does
  the same with `serverLoaded`. A cached empty progress map survives returning
  from the ranked table. Audit both return/focus paths and successor unlock.
- `device-competitive-continue.log`, screenshot path in section 7, and
  `handoff-database-state.log` are the reproduction. The device remains on this
  stale node screen at handoff; `handoff-device-current.png` confirms it.
- Detail header stars use offline progress; map node stars/unlocks already
  combine local/server records, while map total/chapter labels use local totals.
  Inspect consistency when fixing the known stale-record problem; do not
  silently count the offline stars as ranked results or grant rewards locally.

### Additional production edit for a meaningful native regression

- `src/components/table/BettingBar.tsx`: adds `testID="bet-staged"` to the
  displayed staged wager. This supports the corrected resume proof; gameplay
  rules/behavior are unchanged. Included in the 22:44 installed Release.

No engine, server function, SQL migration, wallet authority, or package/lockfile
implementation was changed by this audit.

## 5. Every added/strengthened regression

| File | What changed / what it actually proves |
|---|---|
| `tests/auth/password-recovery.test.ts` (new) | Five adapter cases: same-code correction, changed account, sign-out, different code, successful-flow replay. |
| `tests/auth/auth-failure.test.ts` | Same-password and missing PKCE verifier classifications. |
| `tests/server/password-recovery.integration.test.ts` | Replaced SDK-only paraphrase with shipped auth adapter; actual reset email/303/PKCE, refused existing password, corrected retry, old/new login checks. |
| `tests/auth/session-intent.test.ts` (new) | Parsed INTERNAL never retried; bounded timeout retries with identical intent body. |
| `tests/server/entry-response-loss.integration.test.ts` (new) | Nine CURRENT cases: Quick/public/Sprint opening recovery, Quick double loss, Career/Daily single loss, Career/Daily double loss, Daily failed entry read. Uses independently authenticated real GoTrue clients and production stores; injects loss only after a real HTTP 200 response. The Daily read case is still failing. |
| `tests/tournament/tournament-store.test.ts` | Nine current cases including uncertain registration/withdrawal, unreadable entry must not become empty, and actual reconciliation behavior. One new withdrawal test postdates the 2,428-unit sweep and passed separately. |
| `tests/matchmaking/take-seat.test.ts` | Removed expectation that a FunctionsFetchError proves no charge; expects truthful uncertainty. |
| `tests/server/economy-authority.integration.test.ts` | Recovery Grant race now reaches eligibility by actual wagers/cash-outs (~53 hands in focused run), requires exactly one success among eight parallel claims, reconciles ledger, then reaches/refuses cooldown after another real buy-in. Previous test passed on eight refusals. |
| `tests/engine/fairness.test.ts` | Exact dealing-event order, including hole-card cursor advancement, rather than only membership in consumed cards. |
| `tests/server/two-client-table.integration.test.ts` | New five independent GoTrue/SDK clients using shipped gateways: three hands, same public snapshots, host migration, reconnect, all leave, unchanged private-table wallets/ledger. |
| `tests/deep-links/decode-uri-component-reachability.test.ts` | Corrected claim that vendored core decoder is absent; it is bundled via a barrel fallback. Added live Expo linking → fork checks and lockfile consumer check. Existing positive-control/source checks and slow vulnerable decoder probe retained. |
| `tests/e2e/cold-deep-links.yaml` (new) | Cold Learn Back → Home, missing/invalid recovery → actual Sign in, cold Create Account existing-account CTA → actual Sign in. Branch destinations are asserted. |
| `tests/e2e/practice-resume.yaml` | Requires staged 100, actual live decision (advances naturals if necessary), captures totals, kills/reopens, verifies same wager/player/dealer totals and live hand. No fixed-wallet/random-natural assumption; no pre-deal false success. |

Temporary audit Maestro flows live under the evidence directory, not in the
repository. Some are useful to retain as regression tests after repairing their
known assumptions. In particular, do not promote `device-extra-screens.yaml`'s
initial profile assertion without the stronger save/reopen check described below.

## 6. Completed verification and failed attempts that must remain visible

All basenames in this document resolve under **`/tmp/arc21-astra-baseline/`**
unless a different path is stated. The directory was restricted to the user
(chmod 700) because logs/dumps can contain test identities and local state.

### Valid completed gates — do not restart these by default

| Evidence | Actual result and validity |
|---|---|
| `npm-ci.log` | Clean install succeeded, 904 packages. Packages/lockfile unchanged since. |
| `typecheck.log` | Initial strict TS passed. |
| `lint.log` | Initial 0 errors / 37 warnings. |
| `functions-typecheck.log` | All three Edge Functions typechecked. Server code unchanged since. |
| `unit.log` | Initial 125 files / 2,415 tests passed. |
| `coverage.log` | Per-area coverage gates passed. Global 70.55% statements, 65.66% branches, 71.31% functions, 72.53% lines; global is not the gate. Docker-executed functions are not unit-instrumented. Predates audit edits. |
| `contrast.log` | 50 color pairs, zero failures. Tokens unchanged. |
| `doctor.log` | Expo Doctor 21/21. Dependencies/config unchanged. |
| `bundle.log` | Fresh dependency/bundle validation succeeded, including worklet priming. |
| `db-reset-second.log` | All 58 application migrations plus seed applied from empty. No migration changed since. |
| `pgtap.log` | 29 SQL files / 582 assertions passed. No SQL changed since. |
| `recovery-after.log` | Real GoTrue password recovery through patched adapter passed. |
| `focused-unit.log` | 3 files / 69 passed after early auth/fairness changes. |
| `recovery-grant-play.log` | Strengthened real eligible race/cooldown test passed; 82.35s test, 86.92s total. |
| `five-client-complete-second.log` | Five-client complete flow passed in 6.16s test / 6.75s total; three other cases intentionally unselected. Also included among the 306 later server passes. |
| `unit-final.log` | 127 files / 2,428 passed at Sep 5 07:55. One subsequent withdrawal unit test separately passed. Predates latest Career/Daily edits. |
| `typecheck-final.log`, `lint-final.log` | TS passed / lint 0 errors, same 37 warnings at ~08:00. |
| `entry-loss-final.log` | Four real entry-loss integrations + nine Sprint units = 2 files / 13 passed. |
| `changed-regressions-final.log` | 3 files / 17 passed at 22:44: decoder reachability, Sprint store, intent timeout/verdict tests. |
| `typecheck-device-fixes.log` | TS completed successfully after Create Account CTA and betting testID edits, before Career/Daily edits. Tool session 85948 was polled to exit 0. |
| `competitive-entry-loss-after.log` | 7 files / 118 passed at 23:02:59: six entry-loss integrations plus existing Career/Daily unit files. Predates the last three additions. |
| `daily-entry-read-before.log` | Most recent selected run: 1 FAILED Daily read guard, 2 PASSED Career/Daily double-loss reconciliation, 6 unselected. Not a green gate. |
| `database-authority-final.log` | Sep 5 22:45: zero app tables lacking RLS, 28 client-write guard triggers, zero wallet/ledger mismatches, `assert_client_authorization_surface()` passed. |
| `handoff-database-state.log` | Read-only Sep 6 checkpoint of both native accounts, balances/ledger, ranked result, no Daily entries for A, and released seats. |

### Whole server sweeps — do not mislabel them green

- `server-full.log`: Sep 4 22:30, **302 passed / 1 failed** (303 total).
  New five-client comparison treated absent advice vs explicit null as different
  states. All pre-existing 302 cases passed; test comparison was corrected.
- `five-client-complete.log`: next focused run failed on another test assumption:
  private cash-out returned unchanged `walletBalance: 25000`, not null.
  Corrected, then complete flow passed in `five-client-complete-second.log`.
- `server-final.log`: Sep 5 07:58, **306 passed / 1 failed** (307 total),
  24 files, 296.32 seconds total. The twenty-command race hit its 90-second
  timeout amid 18 logged gateway 504 responses while native build and bundle
  export ran concurrently. **The whole sweep did not pass.**
- `concurrency-isolated.log`: same twenty-command test, no concurrent native
  work, passed in 1.28 seconds: one accepted and nineteen stale. **No 5xx retry
  occurred in this isolated run.** The other 43 tests in its file were
  intentionally unselected and had passed in the sweep.
- Host/VM contention is the supported explanation for that failure, not a
  proven universal guarantee. `functions-contention.log` records context.
  Preserve the failed sweep and targeted recheck; do not claim a fresh all-green
  307 run exists. New entry-loss cases now mean 307 is no longer even the current
  suite count. Decide whether an isolated final server sweep is necessary after
  new fixes; no database reset is required for that.

### Other intermediate failures / harness corrections

- `db-reset.log`: failed in Supabase **base schema initialization before app
  migrations**, with LegacyDbSetupError under severe load/Realtime/analytics
  startup contention. Stopped idle services and second reset succeeded.
  `stop-idle-services.log`, `restart-runtime.log` preserve recovery actions.
- `recovery-before.log`: stack 503 at restart, zero tests; not recovery evidence.
- `entry-loss-before.log`: harness import mistake, `stackUp is not a function`,
  zero tests. Corrected to boolean `describe.runIf(stackUp)`.
- `entry-loss-reproduction.log`: four intentional pre-fix product failures.
- `entry-loss-after.log`: three passed, one failed; Sprint field had filled, so
  the waiting-only withdrawal assumption produced no accepted withdrawal replies.
- `entry-loss-complete.log`: 16 passed / 1 failed across three files; real refund
  happened once, wrong expected replay wording failed.
- `entry-loss-verified.log`: five passed / one failed; shared Sprint pool made
  the assumed empty-entry postcondition invalid. Permanent integration now
  supports registration even if the field fills; withdrawal tested separately.
- `device-competitive.log`: YAML parse failure at unquoted `Server record:`;
  zero device coverage. Quoted string before next run.
- `device-competitive-play.log`: profile save/reopen passed and ten ranked hands
  completed, but helper asserted only `table-complete`. Backend settlement
  releases the seat and UI correctly switches to `You are no longer at this
  table…`, so final helper assertion failed. A SIGINT was sent to this audit's
  Java process during recovery; no Maestro process remains. Current helper
  accepts both terminal render states, but that revised whole flow has not yet
  been verified.
- `device-competitive-continue.log`: settled-state Leave worked; then real stale
  Career record assertion failed. Daily steps never ran.
- Exploratory DB reads initially used nonexistent `wallet_ledger.amount`,
  `game_seats`, `equipped_avatar_id`, or `daily_attempt_results`. Those errors
  are query mistakes, not product defects. Correct schema uses `delta`,
  `game_session_seats`, and `daily_entries`; current checkpoint SQL is corrected.

## 7. Native Release and completed actual-device evidence

### Build preservation and exact artifact

- `prebuild-ios.log`: clean iOS Expo prebuild/CocoaPods succeeded.
- `release-ios.log`: original native Release succeeded, **0 errors / 2 warnings**,
  installed on A. The long build completed after an earlier usage interruption;
  do not start it again because an old terminal appeared unfinished.
- `release-ios-final.log`: updated auth/navigation/economic client Release
  succeeded, **0 errors / 1 warning**, installed.
- `release-ios-anchored.log`: root cold-link anchor Release succeeded,
  **0 errors / 1 warning**, installed.
- `release-ios-account-return.log`: latest native build, Sep 5 ~22:44, succeeded,
  **0 errors / 1 warning**, installed A; includes Create Account return fix and
  `bet-staged`. **Predates latest Career/Daily response-loss changes and all
  future D7/D8 fixes.**
- Artifact:
  `/Users/tj/Library/Developer/Xcode/DerivedData/Arc21-cptufpvtpuhrawanrfpayvxxywez/Build/Products/Release-iphonesimulator/Arc21.app`.
- `main.jsbundle`: **6,231,301 bytes**;
  SHA-256 **`aa4d7646dc76c186376953f13c29b20ac093a47d647eff391947f88b73ef2bb8`**.
- `native-bundle-final-inspection.log`: installed A bundle matched artifact;
  positive markers `BETTING_OPEN`, changed Quick uncertainty string and
  `bet-staged`; absent markers `DAILY_CHALLENGE_SEED_SECRET`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, local signing secret.
- `native-artifact-initial.json` is earlier artifact evidence, not the latest
  hash. `dependency-reachability.log` also contains an older hash.
- `bundle-final.log` / `ios-export-final/`: source-map export passed,
  **2,644 modules**. It predates the last small navigation/testID/client changes;
  dependency reachability remains useful because dependencies did not change.
- These are genuine embedded Hermes Release builds running without Metro.
  Expo's CLI still prints a development-client URL / “Waiting on localhost:8081”
  after install; do not mistake that boilerplate for a requirement to run Metro.

A new incremental Release is necessary for the newest client code after fixing
D7/D8. **A repeated clean prebuild/npm ci/migration reset is not necessary.**

### Completed device flows (all native iOS Release, real local stack where online)

| Run / artifacts | Completed behavior; limits |
|---|---|
| `device-dead-ends.log`; `device-dead-ends/2026-09-05_072234/` | First-launch guest path, Home, guest Quick Play's Practice/Create Account CTAs, unknown/dead-link fallback and Home return. |
| `back-ready.log`, `recovery-ready.log` | Settled-screen direct taps prove Learn → Home and missing recovery → actual Sign in after fixes. |
| `device-round-one.log`; `device-round-one/2026-09-05_080712/` | Cold Learn and both recovery error returns passed; genuine sign-in; online screen capture passed; Practice wager/stand/settlement/Next hand passed. **Master then failed at old Practice-resume test with wager 0. Career and Quick Play did not run here.** |
| Round-one `online-screen-capture.yaml` section | Home, all four server leaderboard tabs, Daily commitment and closed-seed SHA-256 verification, Sprint format/fee/entry CTA (no entry), Social, empty notifications inbox, stats tabs, own profile, inventory tabs/counts. Screenshots inspected for layout. |
| `device-round-two.log`; `device-round-two/2026-09-05_224433/` | Entire master passed: cold Create Account existing-account CTA → Sign in; revised live Practice resume; real GoTrue login; all ten **offline Career** First Deal hands/result/local stars; server Quick Play full hand/next/leave/cash-out/setup. |
| `device-extra.log`; `device-extra/2026-09-05_225439/` | Learn hub/rules, Hard/Soft/Pairs charts, mixed drill answer/feedback/next/finish; inventory First Chip equip; accessibility toggles and restart; Fair Play. Initial profile name assertion only matched form input, not saved state — do not count it. |
| `device-competitive-play.log`; `device-competitive-play/2026-09-05_225737/` | Strengthened profile editor-close + cold reopen passed, matches server name. Then actual `career-start-ranked` opened ranked Career and played ten server hands. Entire run failed only at obsolete terminal-state selector; server completion is independently confirmed. |
| `device-competitive-continue.log`; `device-competitive-continue/2026-09-05_230301/` | Correct settled-state Leave succeeded. Returned ranked Career record assertion failed (D8). **No native Daily hands were played.** |

Exact useful screenshot roots append `<flow-name>/takeScreenshot/` beneath each
run timestamp directory:

- Round one flow `device-round-one`: `signed-in-home.png`, `online-screen-1.png`
  through `online-screen-8.png`, `online-screen-final.png`,
  `practice-next-hand.png`, `recovery-missing-code.png`.
- Round two flow `device-round-two`: `create-sign-in-destination.png`,
  `practice-before-kill.png`, `practice-after-kill.png`, `career-result.png`,
  `quick-cashed-out.png`.
- Extra flow `device-extra-screens`: `learn-hub.png`, `learn-rules.png`,
  `strategy-hard.png`, `strategy-soft.png`, `strategy-pairs.png`,
  `drill-feedback.png`, `profile-renamed.png` (form only, NOT save proof),
  `equipped-first-chip.png`, `accessibility-settings.png`,
  `accessibility-restored.png`, `fair-play.png`.
- Competitive play flow `device-profile-commit`:
  `profile-server-restored.png` (valid save proof).
- Competitive continuation flow `device-competitive-continue`:
  `ranked-career-settled.png`; failure screenshot is at
  `screenshots/step-008-assertCondition-career-server-record.png`.
- `/tmp/.../ranked-current.png`: ranked session settled-seat render.
- `/tmp/.../handoff-device-current.png`: Sep 6 current A screen still shows stale
  First Deal ranked CTA. Both this and the failure screenshot were inspected.

Other visual observations: no clipping/dead CTAs in the inspected ordinary-size
screens; strategy chart deliberately scrolls horizontally (remaining columns
and explanation-cell controls still merit a gesture check). Practice restore
screens show exactly **10 clubs + 10 spades vs dealer J hearts + concealed hole**,
100 wager and same live decision after process restart.

## 8. Current runtime, database, accounts, devices

### Runtime/tooling

- Node **26.7.0**, npm **11.19.0**, Supabase CLI **2.115.0**,
  Xcode **26.6**, iOS simulator **26.5**, Maestro **2.8.0**.
- Expo **57**, React Native **0.86.3**, React **19.2.3**;
  TypeScript strict + `noUncheckedIndexedAccess`.
- At Sep 6 12:43 PDT, **no Maestro, xcodebuild, Vitest, Metro/export or tsc
  process was running**. Old tool session IDs are not active work to wait on.
- Supabase function server remains alive: wrapper PID **83604**, actual CLI PID
  **83606**, command `supabase functions serve --no-verify-jwt`.
  Output: `/tmp/arc21-astra-baseline/functions-serve.log`.
  The original function-server tool session may not be recoverable; use the
  actual process/container state. Do not spawn a duplicate server blindly.
- Running Docker containers:
  `supabase_edge_runtime_arc21`, `supabase_db_arc21`,
  `supabase_storage_arc21`, `supabase_rest_arc21`,
  `supabase_realtime_arc21`, `supabase_inbucket_arc21`,
  `supabase_auth_arc21`, `supabase_kong_arc21`, `supabase_vector_arc21`.
  DB/storage/Realtime/Mailpit/Auth reported healthy. Studio, pgmeta and analytics
  were stopped to relieve initial resource contention; gameplay stack is intact.
- Local API/Auth/PostgREST/functions: `http://127.0.0.1:54321`.
  Mailpit HTTP API: `http://127.0.0.1:54324` (container named inbucket).
- `--no-verify-jwt` skips gateway preverification only; functions still verify
  JWTs themselves. Most recent new integrations use actual GoTrue sign-in.
- `pre-audit-database.dump` (~2 MB) preserves the pre-reset local database.
  The current DB contains audit fixtures/finished and abandoned sessions from
  real tests. Do not reset it and lose continuation state.

### Device A — current active device

- iPhone 17 Pro, **`D16C4292-670D-4036-BDB1-2E9B31B11D3D`**, BOOTED.
- Bundle ID: `com.arc21.app`; latest built Release installed.
- Signed in as local fixture **`e2e-lobby@arc21.test`**;
  password is exactly the email (test fixture convention, not a production
  credential).
- Auth/profile id: **`687e48ea-d0bd-43e6-bdbd-04db6436f48e`**.
- Username: **`p687e48ead0bd`**; display name saved by actual UI: **`Astra Audit`**.
- Wallet and sum of ledger: **25,250**, confirmed at handoff.
- Ledger progression: 25,000 initial grant → -2,000 Quick buy-in → +2,050 Quick
  cash-out → +200 ranked Career reward. No direct fixture wallet top-up.
- Quick session **`81afc938-3111-45da-b256-6ffb5aba5e49`**, completed, hand number 2,
  escrow 0; seat **`3fd35ead-a5bb-4b33-a8ff-4c5a34db42e9`** is `left`, stack 0,
  buy-in 2,000, disconnected.
- Ranked First Deal attempt **`97ff1dbb-a8b1-4a5a-b4c2-b9b82615c44a`**;
  game **`4c636c89-23b7-465b-a943-992fdf7c976b`**;
  seat **`b1d41d7e-39cc-465d-a146-1a78e028ee33`**.
  Attempt completed, hands_played 10, final_chips 2,100, stars 2. Seat `left`,
  buy-in 0, stack 2,100 (noncash practice stack); `connected` remains true on
  this released terminal row. Session completed with no escrow.
- No live seat for A; **zero Daily entries for A** at handoff.
- Current rendered screen: First Deal detail, stale `Play ranked` first-reward
  CTA, no server record. Preserve until investigating D8 if possible.
- First Chip avatar was equipped through actual UI and remained visible.
- Settings persisted in SQLite: reducedMotion=true, increasedContrast=true,
  largerTableText=true; largeCardLabels=false; sound/haptics=true;
  notifications and category switches=false; statsVisibility=private;
  confirmLeavingOnlineGame=true. `device-settings-restored.log` records values.
- A data container at last read:
  `/Users/tj/Library/Developer/CoreSimulator/Devices/D16C4292-670D-4036-BDB1-2E9B31B11D3D/data/Containers/Data/Application/0E951890-5274-4463-BA8B-E75B7360AE32`.
  Prefer `simctl get_app_container` over assuming path persists. SQLite is
  `Documents/SQLite/arc21.db`, table `kv(key,value)`, settings key `settings:v1`.
  Do not dump Keychain/session credentials when reading preferences.

### Device B — prepared, not yet exercised in Astra native multiplayer

- iPhone 17 Pro Max,
  **`064733EE-3AE8-4D4B-9AA5-792C57DAB403`**, SHUTDOWN.
- Local fixture **`astra-guest@arc21.test`**, password exactly email;
  auth id **`fc3d2cc0-1258-4a58-88c2-7b487c76736f`**;
  username/display name **`pfc3d2cc01258`**; wallet/ledger **25,000**.
- `device-b-fresh.log` and `device-b-account.log`: fresh app reset and fixture
  creation succeeded. **B has not yet signed in through the UI in this audit.**
- Installed B artifact predates A's last Create Account/betting-testID build.
  Install the common latest/newly rebuilt `.app` after boot; no separate build
  for B is needed.
- Booting B together with heavy work previously drove host load above 80.
  It was shut down to avoid unreliable tests. Boot separately, let it settle,
  run only one Maestro driver at a time; don't kill unrelated user apps.

## 9. Security/engine/economy evidence and remaining reconciliation

Completed source inspection includes root state, package/lockfile, tsconfig,
Expo config, routes, Supabase migrations/functions, test code and CI. Already
read `docs/FINAL_RELEASE_REPORT.md`, `docs/LAUNCH_STATE.md`, `.claude/RESUME.md`,
current architecture/security/release/rules docs and useful historical evidence.
Original PDF:
`/Users/tj/Desktop/Arc 21 — Deep Research, Product Specification, and Claude Code Master Build Prompt.pdf`.
137 pages; acceptance/DoD pages 130–136 extracted to `pdf-acceptance.txt`.
PDF skill was already read/used for that work. Do not re-extract everything.

Durable architecture is in the new concise `AGENTS.md`:

- `shared/blackjack/` single pure engine, `shared/contracts/` strict boundaries.
  Six decks, S17/peek/3:2, insurance/even money, late surrender, double/DAS,
  up to four split hands, one-card split aces/no ace resplit. Production random
  source uses cryptographic randomness; seeded sources are tests except secret
  deterministic Daily. No outcome-manipulation/production Math.random path found.
- Offline Practice and offline Career do not grant account chips/XP/stats.
  Reward Career, Daily, Sprint, multiplayer and all account economy authority are
  server-side. Private table stacks are not wallet value.
- `create-session`, `game-command`, `send-notifications`: production functions.
  Direct Postgres transactions and locks; room → engine/seat lock ordering.
- All wallet movement via `apply_wallet_delta`, integer/nonnegative ledger,
  starting grant 25,000. Casual buy-in 2,000/max bet 500; standard 5,000/max1,000.
  Recovery Grant below 2,000 restores 5,000, at most once per 12h.
- Sprint four players/12 hands, elimination after six, ties/sudden death,
  settlement/prize once. Daily 20 hands, one ranked attempt, hidden server
  HMAC-derived shoe/commitment, closed seed reveal.

Existing server sweeps and reviewed tests cover hostile shipped-client-accessible
requests/RLS: forged cards/future shoe/hole disclosure, wrong seat/room/object
IDs, wallet/ledger writes, buy-in bypass, repeated settlement/cash-out/prize,
forged XP/Career/stats/leaderboards/cosmetics, Daily score/seed/ranked rules,
private protected reads, stale versions, rate limits, transaction fault rollback,
public seat reuse/mid-hand join/reconnect/turnover, private host migration,
Realtime privacy/reconnect, duplicate username races, deletion/token ownership.
Those existing server/SQL implementations have not changed in this audit.
Five genuinely independent GoTrue clients additionally proved complete real
private multiplayer through shipped SDK gateways.

Some rare engine/tie/rollback tests intentionally seed internal state or inject
transaction failures to reach exact branches. That is branch/fault evidence, not
proof a normal client can write those fixtures. Normal production-path tests
and RLS attacks are the separate boundary evidence; do not conflate them.
`tests/server/call-function.ts` was inspected: it retries only unparsed gateway
5xx/transport loss with identical body, never a parsed INTERNAL/rejection, and
uses `process.stderr.write` so a passed test cannot suppress retry warnings.

### Dependency advisories — do not report zero npm advisories

`npm-audit.json`: **19 affected transitive package entries: 15 moderate, 4 high,
representing five distinct advisories**. No dependency changed. Primary advisory
pages already consulted:

- [decode-uri-component GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr)
- [image-size GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
- [image-size GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq)
- [xmldom GHSA-6gmq-8vp8-gcm6](https://github.com/advisories/GHSA-6gmq-8vp8-gcm6)
- [uuid GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)

`dependency-tree.log` and `dependency-reachability.log` inspect actual installed
chains and the 2,644-module source map:

- `image-size`, `@xmldom/xmldom`, affected `node_modules/uuid` are absent from
  runtime bundle; build/development tooling exposure remains to be documented.
  Three `/uuid/` map entries are Expo's own helpers, not the affected npm package.
- `decode-uri-component@0.2.2` is bundled via `query-string@7.1.3` and Expo Router.
  Vendored core's fallback parse is included through its export barrel; claiming
  it was not bundled was wrong. Actual Expo linking/config uses the fork,
  `URLSearchParams` and bounded built-in decoding, not recursive decoder fallback.
  Live query-string calls build outbound URLs. Strengthened dependency regression
  checks that linkage and contains a positive control for the vulnerable code.
- Patched decoder version 0.5.0 changes module format; do not blindly force an
  incompatible dependency override or downgrade the Expo SDK.
- **Still unfinished:** independently open a hostile ~12,291-character `%FF`
  query on the current native Release and prove responsive navigation/Back.
  A historical source comment already claims that experiment; **it was not yet
  performed by Astra** and must not be counted as current evidence.
- Finish a written advisory disposition with these precise runtime/build
  boundaries and sources; current baseline report does not yet contain it.

`database-authority-checkpoint.log` found 35 public + 3 private protected tables,
zero service_role-executable public functions in the audited authorization
surface, and wallet reconciliation. One exploratory trigger-name query counted
zero incorrectly; corrected `database-authority-final.log` counts 28 write guards.
Reconcile again after remaining native economic flows. No secrets should be
copied into documents or commits.

## 10. Remaining Refresh A work (nothing here is completed by this handoff)

1. **D7 Daily failed read and D8 Career stale progress:** fix, meaningful
   regressions, final changed-code validation and native result/return proof.
2. **Daily native ranked session:** UI `arc21://daily`, `daily-start`; play all
   20 hands through shared server table, leave safely, show `daily-score`,
   reconcile authoritative entry/reward/leaderboard. No existing A entry to
   replay. UTC day may differ from older screenshots; read today's server date.
3. **Native multiplayer with two independent simulators/accounts:** sign in B;
   private create/join/lobby/deal, shared cards/turns, actual chosen wager, timeout,
   disconnect/restore/host migration/leave; public queue/match/seat/escrow,
   mid-hand join/reconnect/leave and survivor continuation. Five-client server
   proof is already complete; do not rerun it to substitute for remaining UI.
4. **Sprint native:** waiting entry/withdraw/refund, actual four-player field,
   open shared table and real controls/timeout/return/result. Real server tests
   already cover full 12, hand-six elimination, ties, sudden death, prize exactly
   once and rollback. Complete representative UI connection to those paths; do
   not claim format-card screenshots were actual entry/play.
5. **Account UI:** create a new audit-only account through actual form; initial
   balance/profile/username; invalid sign-in/error/guest return; logout/session
   restore; email-reset request → actual Mailpit link → recovery form correction
   and success if feasible; delete only that new disposable audit account via
   Settings confirmation and verify DB/Auth deletion. Existing real GoTrue
   account-lifecycle/recovery server tests are valid but not native form coverage.
6. **Social/inbox controls:** friend search/add/accept using the two audit
   identities; inspect friend/profile/stat-permission and private invitation
   destinations, notifications list/open/mark-read (currently only empty inbox
   visually exercised). No messaging real people or production accounts.
7. **Remaining navigation/error/accessibility:** unknown/stale table and room
   links, bounded loading/offline/reconnect, cancel/leave recovery, actual
   strategy-grid horizontal scroll/cell detail, increased system Dynamic Type
   on Home/Profile/Table and return; reset system font afterward. App-specific
   reduced motion/contrast/larger table text already toggled/persisted and can
   remain enabled while assessing layout. Audio/haptics toggles if useful;
   do not claim physical sensory verification from a simulator.
8. **Dependency/security closure:** native hostile-query responsiveness,
   advisory disposition, final wallet/ledger/authorization reconciliation and
   report of real evidence/limitations. Preserve failed runs transparently.
9. **Changed-code gates:** see section 11. No fresh clean-install/migration/
   prebuild loop unless dependency/server/config changes warrant it.
10. **Documentation:** update `baseline-audit.md` (currently IN PROGRESS and
    behind the latest D6–D8 work); `docs/LAUNCH_STATE.md` top currently says audit
    in progress. `AGENTS.md` is already ~100 lines of durable repository map;
    inspect for final accuracy, keep temporary findings out. `docs/RELEASE.md`
    still says `ios.supportsTablet` true in its screenshot paragraph even though
    `app.json` is false. Correct that stale claim and link current audit evidence;
    retain historical measurements as historical, not fresh results.
11. **Local checkpoint commit:** stage audit files deliberately, exclude user
    `AGENTS.claude-backup.md`, credentials/native outputs; inspect final diff and
    commit after actual completion. Do not push. Record commit in final response
    and appropriate report without circular self-hash promises.

External/platform limits to document honestly: no Android SDK/adb/emulator,
physical device, Apple/Play/Expo/EAS accounts, Supabase cloud deployment,
APNs/FCM credentials or domain/hosted policy URLs. Android has not been built/run
in this audit. No real push delivery/store submission/cloud operation is verified.
Local sender tests deliberately record mocked/no-device, not delivery. Those are
external activation/platform gaps, not permission to hide locally fixable bugs.
`docs/RELEASE.md` describes activation requirements, but its old costs/store-rule
claims were not independently revalidated in this turn.

## 11. Exactly what validation is now stale and what to rerun

Recent changes after the latest TS/lint/Release:
`career-server-store.ts`, `daily-store.ts`, and five additional cases in
`entry-response-loss.integration.test.ts` (six to nine cases only in the last
step). Future D7/D8 fixes will add further changes.

Required after those fixes, scaled to final diff:

```sh
npm run typecheck
npm run lint
ARC21_REQUIRE_SERVER_STACK=1 npx vitest run tests/server/entry-response-loss.integration.test.ts tests/career tests/daily --maxWorkers=1
```

- The current nine-case file is **not green**. Its Daily read test is intentionally
  the failing reproduction; keep it, fix production root cause, then re-run all
  nine. Add actual return/focus regression for D8, not a source-only assertion
  that a hook name appears.
- Current 118 pass count includes existing pure Career/Daily tests, **not** a
  complete native result flow or a suite of rendered React components.
- After final source fixes, a final unit/coverage run is reasonable to close the
  changed-code gate; the last full unit/coverage evidence predates new callers.
  Do not repeat those sweeps over and over with no further changes.
- Incremental native Release build/install after final client fixes, then targeted
  changed navigation/competitive/error flows on that embedded artifact. Existing
  correct screens/sessions need not all be replayed because a string/caller changed.
- Functions typecheck, empty migrations, pgTAP remain valid unless server/SQL
  changes. No server/SQL change exists now. Existing 302/306 server passes and
  isolated twenty-command success remain valid for unchanged backend behavior.
  The new entry-loss integrations must still run. If choosing a final whole
  server sweep, do it **without** simultaneous native builds, exports, simulator
  boots, or other stress; preserve its raw result and retry diagnostics.
- Final artifact hash / installed match and source-map check should identify the
  exact artifact actually exercised. Old 22:44 bundle cannot validate 23:02 code.
- No formatter script exists. Lint/typecheck and `git diff --check` are applicable;
  do not invent an unrelated formatting migration.
- Hosted CI has not run for this dirty audit state. Historical GitHub run claims
  are not a new CI PASS. Local workflow equivalents have been exercised; no push
  is authorized to trigger hosted CI.

## 12. Continuation commands, prepared flows and harness pitfalls

Read tool availability in the fresh session. Native UI automation has used the
purpose-built **Maestro CLI + simctl screenshots + image inspection**. A prior
CUA `getApp("Simulator")` stalled on a computer-control permission prompt; do
not wait on it or assume those permissions are available. Do not use hidden UI
state or private app hooks as substitutes for actual controls.

Common commands (substitute a new evidence log name; do not overwrite failures):

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk maestro --device D16C4292-670D-4036-BDB1-2E9B31B11D3D test --test-output-dir /tmp/arc21-astra-baseline/<new-run> <flow.yaml> > /tmp/arc21-astra-baseline/<new-run>.log 2>&1
LANG=en_US.UTF-8 npx expo run:ios --configuration Release --device D16C4292-670D-4036-BDB1-2E9B31B11D3D --no-bundler
xcrun simctl install <UDID> <path-to-Arc21.app>
xcrun simctl io <UDID> screenshot /tmp/arc21-astra-baseline/<name>.png
xcrun simctl get_app_container <UDID> com.arc21.app data
xcrun simctl ui <UDID> content_size
xcrun simctl ui <UDID> content_size accessibility-extra-extra-extra-large
# Restore prior content_size after the check (usually large).
docker exec -i supabase_db_arc21 psql -v ON_ERROR_STOP=1 -U postgres -d postgres < /tmp/arc21-astra-baseline/device-checkpoint.sql
```

- The stack is already running. No `npm ci`, `supabase db reset`, or clean
  prebuild belongs at the start of continuation.
- Maestro startup normally takes 30–60 seconds. A logged completed tap can miss
  on a settling screen or hit an offscreen/keyboard-covered element. Assert a
  destination/state change. Prefer hideKeyboard + scrollUntilVisible + required
  postcondition. Bounded state loops handle actual changing online phases;
  optional taps alone are never proof. Avoid arbitrary sleeps/retries that hide
  5xx or real missing controls.
- `clearState: true` is unreliable as a full iOS reset: some flows visibly reset
  local onboarding/progress while Keychain session can persist. The repository
  helper `scripts/e2e-fresh-app.ts --udid <UDID>` explicitly clears simulator
  SQLite and Keychain if a fresh install is truly necessary. Do not apply it to
  A before inspecting the current D8 reproduction.
- `mc-sign-in.yaml` can stop as soon as any account header is visible; it does
  not prove a previously signed-in device changed to requested EMAIL. Sign out
  or use a known fresh fixture first. It takes `-e EMAIL=<fixture-email>`;
  password equals email. `sign-in.yaml` hardcodes A's email.
- `textContentType="newPassword"` can raise the iOS strong-password overlay
  and swallow `inputText`. Actual native signup/reset remain pending. Inspect
  the real keyboard/field; the simulator pasteboard helper is available if
  needed. Do not admin-create an account then claim native signup coverage.
- A green initial profile assertion matched the input text before save. The
  stronger flow hid the keyboard, scrolled to Save, required `profile-edit-name`
  to return, killed/reopened, and required saved name with no editor. DB also
  confirmed. Reuse that pattern.
- Shared server completion may release your seat before the app next fetches;
  `table-complete` is not the only terminal view. Updated temporary
  `complete-server-session.yaml` accepts `This table has finished.` OR
  `You are no longer at this table…`, then leaves. Still verify actual hand
  count/result against DB, not just this generic message.
- `career-start` means **Practice offline**; `career-start-ranked` is real ranked
  entry. `/tmp/.../career-online.yaml` is only a copy of the offline flow with
  clearState=false; its name is misleading. Do not rerun it as ranked proof.
- New temporary `device-competitive.yaml` starts ranked First Deal and then
  Daily. **Do not rerun its First Deal section unnecessarily**; A already
  completed that node. `device-competitive-continue.yaml` expects the old
  settled-table screen, but A is now on the node, so adapt the starting steps.
- `device-profile-commit.yaml` includes both profile mutation and the whole
  competitive flow; it is not an idempotent pure profile smoke (same name has
  no changes and cannot save). Do not blindly rerun from line one.

Prepared native multiplayer sequence (read each flow first):

- B boot/install/login using `tests/e2e/mc-sign-in.yaml` and B EMAIL.
- A `two-client-host-open.yaml`; read actual code with
  `npx tsx scripts/two-client-code.ts` (inspect its arguments/default account).
- B `two-client-guest-join.yaml -e CODE=<code>`; A
  `two-client-host-deal.yaml`; B `two-client-guest-table.yaml` restores a seat
  after process restart. Then `two-client-play.yaml` on each device,
  `two-client-timeout.yaml`, `two-client-leave.yaml`; query host migration/seat
  state. One Maestro process at a time.
- Public helpers/flows: inspect `scripts/e2e-public-drain.ts` before preparing
  old fixture rooms; `two-client-public-queue.yaml`, `two-client-public-join.yaml`,
  `two-client-public-seat.yaml -e OTHER=<actual-display-name>`,
  `two-client-public-leave.yaml`, `two-client-public-survives.yaml`.
  `scripts/two-client-public.ts --email <email> --what state|wallet|display-name`
  reads the server as that fixture. It uses local test JWT signing plus admin
  identity lookup; this is read-only checkpoint evidence, not genuine GoTrue
  login proof. The device sessions and five-client test supply the latter.
- Existing `private-lobby.yaml` only reaches a lobby; existing
  `public-matchmaking.yaml` covers lone-player wait/alternatives/tier gate,
  not two genuinely seated clients. Do not overclaim them.

Sprint preparation uses real production registrations, not direct balance writes:

```sh
npx tsx scripts/e2e-sprint-field.ts --stage waiting
# Then native tests/e2e/sprint-wait-and-withdraw.yaml on A.
npx tsx scripts/e2e-sprint-field.ts --stage waiting
npx tsx scripts/e2e-sprint-field.ts --stage fill
# Three fixture peers are now registered/paid; A is the fourth via UI:
# tests/e2e/sprint-table.yaml
```

Inspect helper before use. It handles leftover global pool entries; filling a
field means withdrawal is legitimately refused. `sprint-table.yaml` checks real
sequential clocks and own deliberate bet; it does not itself complete all twelve
hands. Existing server suite covers full tournament settlement. Plan additional
native result/return proof without falsely claiming the short flow does more.

Other pending selectors and paths:

- Auth form: `auth-email`, `auth-username`, `auth-password`, `auth-submit`.
  Recovery: `recovery-password`, `recovery-confirm`, `recovery-submit`,
  `recovery-sign-in`; Settings `delete-account` → `Delete permanently`.
- Use a newly created disposable address (e.g. `astra-device-<unique>@arc21.test`)
  for signup/reset/delete so A/B multiplayer fixtures remain usable. Local
  Mailpit API endpoints and exact link extraction are implemented in
  `tests/server/password-recovery.integration.test.ts`: read actual email,
  follow `/auth/v1/verify?...` with redirect manual, then open returned
  `arc21://auth/recovery?code=...` on **the device that requested it** (PKCE).
- Social `friends-search-input`, `friends-search-submit`,
  `search-<action>-<username>`, `request-accept-<username>`;
  inbox `notification-<id>`, `notifications-mark-all`.
- `src/lib/notifications/use-notification-routing.ts` validates `kind`,
  `room_code`, `game_id`; friend kinds → Social, table invite → room, your_turn
  → validated table, Daily → Daily, tournament → tournament. OS-injected
  simulator push can test a tap route if available, but is not real APNs delivery.
- Hostile URI responsiveness: generate a long `%FF` query on e.g.
  `arc21://learn/how-to-play?x=...`, assert actual article and responsive Back
  within a bounded duration on current Release; save payload length/timing.

## 13. Documentation status and final handoff checks

- `AGENTS.md` exists as concise architecture/authority/commands/quirks/git map;
  no temporary findings were put there. User requested exactly that, not a giant
  rewritten specification.
- `baseline-audit.md` is a draft marked IN PROGRESS. It records initial gates,
  D1–D5 and device rounds through the early extra screen run; it does **not** yet
  contain the final profile proof, completed ranked result, D6–D8, or full
  dependency reconciliation. This handoff supersedes its unfinished-work
  chronology but does not turn its status into PASS.
- `docs/LAUNCH_STATE.md` top links baseline and says current Astra audit in
  progress; prior phase verdicts distinguished as historical.
- `docs/RELEASE.md` and final launch/report updates remain for audit completion.
- This handoff is intentionally detailed and temporary; do not copy it into
  `AGENTS.md`.

At handoff creation, refreshed git/process/device/database reads confirmed the
state above; no build/test remained running. The completed handoff was read back
and checked against the dirty-file list, recent logs, screenshot, and database
checkpoint for omitted continuation-critical information. No further product
implementation or tests were started. **This turn stops at the user's requested
handoff; resume D7/D8 only in the continuation session/request.**
