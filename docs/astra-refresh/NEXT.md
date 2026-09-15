> Historical September 6 checkpoint. Refresh A completed with PASS on September 14 PDT.
> [baseline-audit.md](./baseline-audit.md) contains the final verdict and evidence;
> the pending work and runtime instructions below are superseded. Refresh B has not begun.

# Refresh A — minimal continuation checkpoint

Written 2026-09-06, state checked at 18:24 PDT. **INCOMPLETE; no audit PASS.**
Resume here, then consult AGENTS.md and specific evidence below. Work solo in this checkout;
no agents/worktrees, Refresh B, push, or repeat of valid expensive work.

## Branch / HEAD / dirty files
Branch: `phase14-s2-security`; HEAD: `58dcf39fc66a3d1fcb81a20c34beb77875ff929a`.
Upstream remains `origin/phase11-adversarial-qa`. No audit commit yet; all changes unstaged.
`AGENTS.claude-backup.md` is the original USER file: preserve and EXCLUDE from the commit.
Modified tracked files:
```text
app/(auth)/create-account.tsx
app/_layout.tsx
app/auth/recovery.tsx
app/career/[slug].tsx
app/career/index.tsx
app/daily/index.tsx
docs/LAUNCH_STATE.md
src/components/table/BettingBar.tsx
src/components/ui/BackBar.tsx
src/features/auth/auth-failure.ts
src/features/auth/auth-store.ts
src/features/auth/supabase-auth-adapter.ts
src/features/career/career-server-store.ts
src/features/daily/daily-store.ts
src/features/matchmaking/matchmaking-store.ts
src/features/quick-play/quick-play-store.ts
src/features/tournament/tournament-store.ts
tests/auth/auth-failure.test.ts
tests/deep-links/decode-uri-component-reachability.test.ts
tests/e2e/practice-resume.yaml
tests/engine/fairness.test.ts
tests/matchmaking/take-seat.test.ts
tests/server/career.integration.test.ts
tests/server/economy-authority.integration.test.ts
tests/server/password-recovery.integration.test.ts
tests/server/two-client-table.integration.test.ts
tests/tournament/tournament-store.test.ts
```
Untracked files (including this checkpoint):
```text
AGENTS.claude-backup.md
AGENTS.md
docs/astra-refresh/NEXT.md
docs/astra-refresh/REFRESH-A-HANDOFF.md
docs/astra-refresh/baseline-audit.md
src/lib/supabase/session-intent.ts
supabase/migrations/20260909120000_career_attempt_counts.sql
supabase/tests/30_career_attempt_counts.test.sql
tests/auth/password-recovery.test.ts
tests/auth/session-intent.test.ts
tests/e2e/career-ranked-return.yaml
tests/e2e/cold-deep-links.yaml
tests/e2e/complete-ranked-session.yaml
tests/e2e/daily-ranked-result.yaml
tests/server/entry-response-loss.integration.test.ts
```

## Defect status
- D1 **VALIDATED through auth store/GoTrue; native recheck pending**: retained PKCE exchange plus one adapter per SDK client fixes corrected-password retry. Earlier adapter-only evidence missed the store creating a fresh adapter each submission.
- D2 **VALIDATED native**: cold Learn Back/root navigation now has a Home destination.
- D3 **VALIDATED native**: every recovery branch offers an actual Sign in control.
- D4 **VALIDATED native**: cold Create Account existing-account CTA opens Sign in.
- D5 **VALIDATED stores/server**: Quick/public/Sprint reuse an intent across response loss, reconcile, and avoid false no-charge claims.
- D6 **VALIDATED stores/server**: Career/Daily single/double lost opens and malformed replies reconcile actual attempts/seats; native build contains fixes.
- D7 **VALIDATED stores/server; native retry pending**: failed/malformed Daily entry reads cannot advertise an empty ranked history; UI has Try again.
- D8 **FIXED BUT NEEDS REVERIFICATION**: map/node refresh on focus; combined local/server star totals agree. Native return showed new star/replay/reward copy, then exact count exposed D9; map/successor assertions never ran.
- D9 **VALIDATED database/server; native count pending**: Career counted once at start AND completion (1 run → 2; 2 → 4). Migration preserves start count and repairs aggregates from actual attempt rows; regression now requires exact counts, including resume/drill.

## Exact stopping point / current runtime
- User requested ONLY this checkpoint; no further implementation/tests/builds were started after that request.
- `20260909120000_career_attempt_counts.sql` is APPLIED locally after existing `20260908120000...`; initial `20260906203000...` filename was refused, changed nothing, and was renamed (no `--include-all` workaround).
- **Post-fix tests actually PASSED**: `pgtap-career-count-after.log` = 30 files / 592 assertions; `career-count-after.log` = all 6 Career integrations. Combined command exited 0; no test is still running.
- No Maestro, xcodebuild, Vitest or tsc running at checkpoint. Function server PIDs 83604/83606 remain alive; Docker gameplay services running/healthy. API `http://127.0.0.1:54321`, Mailpit `:54324`; do not reset DB or duplicate function serving.
- A: booted iPhone 17 Pro `D16C4292-670D-4036-BDB1-2E9B31B11D3D`, app `com.arc21.app`, fixture `e2e-lobby@arc21.test` (password=email), user `687e48ea-d0bd-43e6-bdbd-04db6436f48e`.
- A DB freshly checked: wallet=ledger **25,450**; First Deal 1 attempt/2 stars, Hit or Hold 1 attempt/1 star, both completed; **zero Daily entries**. Native Hit or Hold completed 12 hands, final stack 1,950, one 200-chip reward.
- Last native run returned to retained Hit or Hold and showed correct new star/replay text but pre-migration **2 attempts**. `device-career-return.log` failed there. Later `simctl launch` exited 0 (PID 31479); current screen has not been re-inspected. Do not assume its route.
- **Do not replay First Deal or Hit or Hold unnecessarily.** `career-ranked-return.yaml` requires Hit or Hold never completed; A no longer meets that premise. Resume its remaining record/map/Double Time checks with an adapted continuation flow.
- B: `064733EE-3AE8-4D4B-9AA5-792C57DAB403`, not booted; `astra-guest@arc21.test` (password=email), wallet=ledger 25,000. Native login/multiplayer still pending; install A's latest artifact when needed.

## VALIDATED evidence to preserve
All bare evidence basenames below resolve under `/tmp/arc21-astra-baseline/`.
- Current incremental Release: `release-ios-continuation.log`, build/install exited 0, 0 errors/2 warnings. Contains ALL current client changes; only SQL/tests/docs changed afterward. **No rebuild needed for the count migration.**
- Artifact: `/Users/tj/Library/Developer/Xcode/DerivedData/Arc21-cptufpvtpuhrawanrfpayvxxywez/Build/Products/Release-iphonesimulator/Arc21.app`. Current installed hash/source-map match still unrecorded.
- `entry-loss-current.log`: all 12 real SDK/production-store cases passed. `continuation-changed-regressions.log`: 10 files/155 passed, including store-level PKCE correction; `recovery-store-before.log` preserves its failure.
- `career-count-migration-applied.log`, `pgtap-career-count-after.log`, `career-count-after.log` validate D9; `career-count-before.log` and `pgtap-career-count.log` preserve pre-fix failures. `career-count-migration.log` is the refused ordering attempt.
- Preserve clean install, Doctor, contrast, native toolchain/prebuild, original 58 migrations, Recovery Grant race, five-client server flow, cold links, live Practice resume, Quick economy, Learn/drill/profile/settings evidence: detailed index in **REFRESH-A-HANDOFF.md §§6–9**. New migration adds one; no clean reset required.
- Earlier server sweeps were NOT wholly green: 302/1 failure, then 306/1 timeout; five-client and isolated twenty-command rechecks passed. Do not relabel those sweeps or blindly repeat them.

## OPEN / REMAINING FINAL GATES
- Native D8 map/successor and D9 repaired-count display; Daily full 20-hand result/reward/leaderboard; D7 retry screen; complete successful account recovery UI.
- Native two-account private/public multiplayer, reconnect/timeout/host migration/cash-out; Sprint waiting/withdraw/refund plus actual field/table/result; social search/add/accept/invite/inbox; disposable signup/sign-in errors/logout/reset/delete.
- Remaining error/offline/navigation/Dynamic Type/table and strategy-grid gesture checks; hostile ~12,291-character `%FF` URL responsiveness; written dependency disposition and final wallet/ledger/authorization reconciliation.
- `continuation-typecheck.log` passed and `continuation-lint.log` had 0 errors/37 warnings, BUT later malformed-open guards/tests and Career tests postdate them: rerun TS/lint. Last full unit/coverage predates this continuation: run final unit/coverage once after fixes.
- SQL change invalidated old database gate: **already rerun and passed 592 assertions**. Original clean-migration evidence + applied forward migration remain valid. Function source/dependencies/config/tokens unchanged: functions typecheck, install/Doctor/contrast need no repeat solely for this SQL fix.
- Final native artifact hash/installed match and current source-map check remain; old map still supports unchanged dependency reachability. 19 transitive audit entries (15 moderate/4 high; five advisories), not zero. Advisory pages reopened; no dependency edits.
- Finish report/launch/release docs, durable AGENTS accuracy, diff/untracked/secret review, `git diff --check`, deliberate local checkpoint commit (exclude backup/credentials/native outputs); no push. No Android/physical/cloud/push-delivery activation evidence: preserve stated external limits.

## Next actions (priority order)
1. Inspect current A route; verify repaired 1-attempt record, retained map refresh/combined totals, and Double Time ranked unlock without redoing completed hands; retain D8/D9 screenshots and DB agreement.
2. Run `tests/e2e/daily-ranked-result.yaml` on A (20 hands via `complete-ranked-session.yaml`); verify exact result/reward/ledger/leaderboard and retry/error path.
3. Boot/install/login B separately; finish private/public two-device flows and Social/inbox/invite controls (handoff §12); one Maestro driver, no simultaneous heavy builds.
4. Complete native Sprint wait/withdraw/refund and four-player table/result; inspect existing local fixture scripts first; full server tournament branch proofs remain valid.
5. Exercise disposable native signup, invalid sign-in/guest, restore/logout, actual Mailpit PKCE reset correction/success, then delete only that disposable account; preserve A/B fixtures.
6. Complete remaining navigation/offline/accessibility/grid/hostile-query checks; dependency disposition and final authority/economy reconciliation.
7. Run required changed-code/final unit/coverage gates and current artifact verification. Broaden server reruns only for invalidated behavior or unresolved failures; no contention with native work.
8. Update baseline/launch/RELEASE (stale tablet claim), handoff completion status and NEXT; inspect diff/untracked/secrets, run diff check, make authorized LOCAL Refresh-A commit; stop without Refresh B.

## Detailed pointers / final stop condition
- `AGENTS.md`: durable rules. `docs/astra-refresh/REFRESH-A-HANDOFF.md`: older full map (this file supersedes its D1/D6–D9/build statuses), especially §§10–12 for remaining scope/commands/fixtures.
- `docs/astra-refresh/baseline-audit.md`: in-progress report; September 6 section exists but predates D9 and final native result. `docs/RELEASE.md`: external activation limits.
- D8/D9 native failure screenshot: `device-career-return/2026-09-06_130617/career-ranked-return/screenshots/step-142-assertCondition-Server_record_[1-3]_of_3.png`; `career-return-checkpoint.log` has completed hands/ledger. `career-return-live.png` shows SpringBoard, NOT gameplay evidence.
- Dependency evidence: `npm-audit.json`, `dependency-reachability.log`, `ios-export-final/`; original specification acceptance: `pdf-acceptance.txt`. Read only relevant artifacts, not the entire evidence directory.
- Only after EVERY original Refresh-A requirement is legitimately complete may the final verdict be:
```text
ASTRA BASELINE AUDIT: PASS
KNOWN CURRENT RELEASE-BLOCKING SOFTWARE DEFECTS: 0
```
