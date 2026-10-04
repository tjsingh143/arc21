# Astra Refresh B — pseudonymous players

**Closure verification — October 4, 2026: ASTRA REFRESH B: PASS (§26).**
**KNOWN CURRENT REFRESH-B RELEASE-BLOCKING SOFTWARE DEFECTS: 0**
The H1–H4 repair and immediate regressions are verified. External activation and
physical-platform limitations remain; prior verdicts below are historical.

**Bounded repair of B-H1–B-H4 — October 4, 2026: a repair record, NOT a verdict (§25).**
Group A (authoritative player confirmation) and Group B (authoritative notification-intent
ordering, one migration) are implemented with regressions, negative controls, broad gates and
renewed Release evidence. §24's FAIL stands until an independent re-audit. No checkpoint.

**FINAL independent re-audit — October 4, 2026: ASTRA REFRESH B: FAIL.**
Four confirmed blockers, **B-H1–B-H4**, are consolidated in **§24**. B-G3 is
fixed; the complete B-G1/B-G2 and confirmation/actor invariants still fail.
No checkpoint. All earlier verdicts and repair records below are historical.

**Latest independent verdict — October 3, 2026: ASTRA REFRESH B: FAIL.**
Three confirmed blockers, **B-G1, B-G2, B-G3**, are consolidated in **§22**.
B-F1 and B-F3 privacy are fixed; B-F2 remains incomplete. No checkpoint.
The earlier status and all repair history below are preserved as history.

**Current status — September 30, 2026: ASTRA REFRESH B: FAIL.**
Final independent re-audit completed; three consolidated release blockers,
**B-F1–B-F3**, detailed in **§20**. The original B-R1–B-R6 reproductions pass,
but privacy timeout/caller variants and failed credential removal prevent PASS.
No checkpoint commit. All prior FAIL and repair history below is preserved.

**Previous status/history (superseded by §20):**

**Status: FINAL consolidated independent re-audit FAILED on September 29, 2026.
Six confirmed release-blocking software defects, B-R1–B-R6. NOT checkpointed.**
See §18 for the current verdict, consolidated reproductions, independent repair
verification, current server result and remaining external/unproven classifications.
The originally reported social and table races are repaired under normal credential
storage; the additional identity and persistence defects prevent final Refresh-B
approval. No production code was changed during this audit.

**September 28 verdict and subsequent repair/evidence history (retained):**
The original social regression now passes, but an analogous account-switch defect
was reproduced in table cash-out: an initiating player's delayed Leave can close
the replacement player's seat when both belong to the same game. See §15 for the
then-current verdict and preserved reproduction. The original FAIL (§12), bounded
repair (§13), and renewed native evidence (§14) remain intact as history.
**§14 supersedes §3's build row and every native row of §4a and §4b**, but it does
not establish PASS. No checkpoint commit has been made. The September 28 re-audit
stopped at the confirmed product defect as required at that time; §18 instead
continues across independent surfaces and consolidates all confirmed blockers.

**§16 is the bounded repair of the §15 blocker, dated September 28, 2026.** It binds
every online-table intent to the player who dispatched it and pins that credential
onto the request, adds two regression files that were measured to FAIL when the
repair is removed, and renews SOME of the native evidence the repair invalidated on
a fresh Release build. **§16.8 is explicitly PARTIAL and names the two-device proofs
it did not renew, and why.** §16 supersedes §14.1's build row and the table rows of
§14.2 only for what it actually re-measured. It is a repair, not a verdict: Refresh B
is still FAILED and un-checkpointed, and HEAD is still the starting SHA.

**§17 closes §16.8's named gap, dated September 28, 2026.** It renews every
two-device table proof §16.8.3 listed as NOT RENEWED — two pseudonymous players in
one real public table, reconnect, leave/cash-out with the survivor unaffected,
rejoin, the private create → join → felt → play → leave chain, and the stack reset,
for which a flow now exists — on the SAME §16 Release binary, re-fingerprinted as
unchanged (0 of 246 production source files moved). It changed no production code.
**It is evidence, not a verdict:** §12 and §15 remain the standing audit verdicts,
no blocker of theirs is rebutted, and Refresh B is still FAILED and
un-checkpointed.

- Starting SHA: `47dba201ace488d932bb4e479416f52f79a6f176` (HEAD is still this
  commit; all Refresh B work is uncommitted in the working tree).
- Branch: `astra-refresh-b`, no upstream. No push, merge, hosted deployment or
  history rewrite.
- Refresh A remains complete at its audited checkpoint `a52199d`; its
  [record](./baseline-audit.md) is unchanged. The post-A hotfix and published main
  are the starting baseline, not part of B's claimed evidence.
- Scope: automatic real pseudonymous identity, optional same-player recovery
  credentials, generated handles, and the account/social/presence boundaries they
  touch. Nothing from Refresh C/D/E.
- `AGENTS.claude-backup.md` is intentionally untracked and is not part of B.
- Evidence lives OUTSIDE the repository, at
  `/Users/tj/arc21-evidence/astra-refresh-b-20260915/` (called `$E` below). It
  holds logs, JUnit XML, Maestro debug output, screenshots and database snapshots.
  Harness credentials (`closure-credentials.json`, `native-credentials.json`) are
  mode 0600 there and are not in Git.

## 1. Implemented architecture

1. The configured app renders local Practice immediately, then restores Auth or
   creates a supported Supabase anonymous user. Existing permanent sessions are
   restored unchanged. A device-local fallback (`guest` internally, "Offline
   player" in the UI) remains for offline/unconfigured operation; it is not an
   online identity.
2. All online players have verified Auth UUIDs and the `authenticated` RLS role.
   No email is required for public/private multiplayer, Daily, Sprint, Career,
   wallet, social, presence, profile, cosmetics, statistics or notifications.
3. The server generates the unique canonical `username`: a curated short
   adjective and animal, with a random six-digit suffix on a collision. Every
   candidate passes the existing reserved-name/profanity filter. The unique index
   resolves concurrent races; failures other than a username collision are not
   swallowed. `display_name` starts as the handle and stays a separate
   presentation field. Existing names, moderation and rename limits are intact.
4. **Secure your player**: request an email change, verify the six-digit
   email-change OTP, then attach a password. The email must be verified before a
   password can be set. Verification uses a detached, non-persisted SDK client;
   the UUID it returns must equal the current UUID before its tokens are adopted.
   An email conflict never merges players. A verified email alone is recoverable
   through a password reset; a password adds direct sign-in. No OAuth provider is
   configured or offered. Any future OAuth must use supported identity linking,
   never an unrelated signup followed by copying competitive state.
5. Profile, wallet, ledger, progression, friends, blocks, cosmetics and seat
   ownership stay on the same UUID when a player is secured. An Auth UPDATE cannot
   trigger a new opening grant. Bootstrap performs one atomic 25,000-chip grant
   per newly inserted UUID, preserving existing wallet/version semantics. No
   local economic or competitive data is uploaded; Practice and settings stay on
   the device.
6. Auth operations are serialized (`src/features/auth/auth-mutation-queue.ts`)
   even after their UI wait times out. Expired queued intents are discarded.
   CAPTCHA human interaction is not treated as a network timeout.
   Expected-player guards stop a queued destructive action acting on a newly
   switched identity. Two-generation keychain writes preserve a complete old or
   new credential across an interrupted write, and the previous format is still
   read.
7. An identity change clears server caches, invalidates late replies and
   navigation, and re-associates permitted push state. Economic retries keep
   their original verified credential and idempotency key. Sign-out, recovery and
   sign-in all warn before replacing an unlinked player
   (`confirm-player-replacement.ts`). An intentional sign-out or deletion pauses
   automatic creation until the player taps Connect or relaunches the app.
8. Friend requests must go through the rate-limited RPC; direct INSERT is
   revoked. Friend presence comes from a server-only UUID/activity projection
   (`list_friend_presence`) with mutual block checks. The global, spoofable
   Realtime presence roster is no longer accessible.

## 2. Migration and runtime configuration

- Forward migration `supabase/migrations/20260915120000_pseudonymous_players.sql`
  (new): `generated_player_handle`, a redefined `handle_new_user`,
  `revoke insert on friend_requests`, two dropped Realtime presence policies,
  `list_friend_presence`, and a redefined `assert_client_authorization_surface`.
  No older migration was edited and no existing profile or economy was
  backfilled. A clean reset applies all **60** migrations.
- pgTAP file `supabase/tests/31_pseudonymous_identity.test.sql` (new).
- Auth (`supabase/config.toml`): anonymous sign-in and manual linking enabled,
  email confirmations required, email-change OTP template at
  `supabase/templates/email-change.html`. Local settings were read back from
  `/auth/v1/settings` (`$E/closure-auth-settings.txt`): anonymous on, email on,
  autoconfirm off.
- Default anonymous creation cap stays at 30/IP/hour. No limit was raised for
  tests.
- Optional native hCaptcha: public site key and HTTPS origin in app config; the
  secret lives only in hosted Auth. Cancelling keeps offline Practice available.
- `scripts/prepare-local-stack.ts` pins the ignored local PostgREST image to
  `v16.3`. Upstream v16.1 has a stale cached clock (`PGRST303 JWT issued at
  future`) that the first real-JWT tests exposed. No product retry was added.
- Expo and expo-notifications were aligned to 57.0.23/57.0.19 through Expo's own
  installer, for newly published SDK patch requirements. No opt-in scene
  lifecycle feature was enabled.
- Working-tree size: 96 tracked files changed (+2,160/−1,726) plus the new files
  listed by `git status`.

## 3. Verification gates (exact counts)

| Gate | Result | Evidence (`$E/…`) | When |
|---|---|---|---|
| Typecheck (`tsc --noEmit`) | pass | `closure-typecheck.log` | Sep 24, final tree |
| Lint | 0 errors / 21 warnings | `closure-lint.log` | Sep 24 |
| `npm run check:functions` | all Edge Functions typecheck | `closure-check-functions.log` | Sep 24 |
| Unit (`npm run test:unit`) | **133 files / 2,510 tests pass** | `closure-unit.log` | Sep 24 |
| Coverage (`npm run test:coverage`) | **131 files / 2,484 tests pass**, per-area thresholds met | `closure-coverage.log` | Sep 24 |
| Clean reset | 60 migrations, latest `20260915120000` | `clean-reset.log`; user-run reset Sep 26 | Sep 16 / Sep 26 |
| pgTAP (`supabase test db`) | **31 files / 610 assertions, PASS** | `closure-sql.log` | Sep 26, after reset |
| Authorization gate | `assert_client_authorization_surface()` passes | checked Sep 26 | Sep 26 |
| Server suite, full (`npm run test:server`) | **333 / 335 pass**; the 2 failures are classified ENVIRONMENT (§6) | `closure-server.log` | Sep 26 |
| Server rerun of the two failing files | `game-command` **44/44**, `table-reconciliation` **2/2** | `closure-server-rerun*.log` | Sep 26 |
| Earlier full server run (unchanged server code) | 26 files / **335/335** | `server-final.log` | Sep 16 |
| Real pseudonymous/Auth/Mailpit suite | 5/5 (inside the server suite) | `pseudonymous-v163.log`, `closure-server.log` | Sep 16 / 26 |
| Contrast, Expo Doctor 21/21, iOS bundle export | pass | `contrast.log`, `doctor-aligned.log`, `bundle.log` | earlier pass; not rerun |
| iOS Release build | BUILD SUCCEEDED; 261 source fingerprints match current files | `native-release-resume-build.log`, `native-build-resume.json` | Sep 23; no `src`/`app`/`shared`/`supabase/functions` file is newer |

No production file changed after these gates. The only later edits are the
Maestro flows under `tests/e2e/refresh-b/` and this document.

## 4. Native flows proven (iOS Release, simulator)

Device A: iPhone 17 Pro, iOS 26.5, `D16C4292-…`. Device B: iPhone 17 Pro Max,
`064733EE-…`. Every flow ran on the Release app against the local stack. No
session was injected and no fixture account was used unless the row says so.
Each proof pairs the Maestro result with a server-side database/Auth readback.

### 4a. Sept 23 (pre-reset players; the UUIDs have since been reset away — evidence remains valid as recorded)

| Flow | Result | Evidence |
|---|---|---|
| Fresh entry, generated handle `lucky_ibis`, UUID `54682e50…`, no credentials | pass | `native-a-settled.xml`, `native-a-initial-identity.txt` |
| Four refresh-token rotations on the same UUID; exactly one grant; wallet = ledger = 25,000 | pass | `native-a-before-restore.txt` |
| Cold stop/relaunch keeps UUID and handle | pass | `native-a-cold.xml`, `native-a-after-cold.txt` |
| Device B fresh entry `steady_lark` `9c373a3e…`, its own single grant | pass | `native-b-fresh.xml`, `native-two-players.txt` |
| Two pseudonymous devices: public queue, join, shared seat in game `6b2d5bef…`; both wallets 23,000 = ledger | pass | `native-public-{queue,join,seat}.xml`, `native-public-both.png` |
| Reconnect / leave / rejoin; the survivor keeps playing and cashes out | pass | `native-public-reconnect-leave.xml`, `native-public-survives.xml` |
| Display-name edit `RiverPlayer` persists cold; handle unchanged; wallets 24,825 / 25,060 = ledger, one grant each | pass | `native-profile-name.xml`, `native-after-play-rename.txt` |
| Friend request through the rate-limited RPC; pending on both sides; accept | send: JUnit **failure** (the assertion omitted the displayed `@` prefix; the request DID reach the RPC — pending DB row and screenshot), then pending **pass** without resending, accept **pass** | `native-social-send.xml`, `native-social-pending.xml`, `native-social-accept.xml` |

### 4b. Sept 26 closure (after the reset; all on Device A)

| # | Flow | Result | Server-side readback (`$E/…`) |
|---|---|---|---|
| 1 | Fresh install → **`early_ferret`** `93af15b0-f518-4389-b67d-15635e3a0638`, anonymous | pass `closure-fresh-player.xml` | 25,000 = ledger, 1 grant (`closure-state-1-fresh.txt`) |
| 2 | Secure: request code to `closure-a-20260926@arc21.test` | pass `closure-secure-email.xml` | `email_change` = exact address on the same UUID; Mailpit's newest message is to exactly that address (`closure-state-2-email-pending.txt`) |
| 3 | Verify the OTP from that mail, then set a password | pass `closure-secure-verify-2.xml` | **Same UUID** `93af15b0…` now `is_anonymous=false`, email confirmed, password set, one `email` identity, handle unchanged, 25,000 = ledger, 1 grant. User count unchanged at 551, so no second player (`closure-state-3-secured.txt`) |
| 4 | Fresh install → second unlinked player **`soft_fawn`** `0077d4b7…` | pass `closure-fresh-player-2b.xml` | 1 grant (`closure-state-4-second-player.txt`) |
| 5 | Already-owned email: `soft_fawn` tries the address `early_ferret` owns | pass `closure-link-conflict.xml` ("That email belongs to another player") | `soft_fawn` still anonymous with no pending change; `early_ferret` untouched (`closure-state-5-conflict.txt`) |
| 6 | Replacement warning on sign-in (**"Leave this player? … Players are never merged"**) → Cancel keeps `soft_fawn`; unsecured **Sign out?** warning ("Signing out can permanently lose access to its chips, progress and friends") → Cancel keeps it | pass `closure-replacement-cancel-4.xml`; screenshots `replace-unlinked-warning.png`, `unlinked-signout-warning.png` | no identity change (`closure-state-6-cancel.txt`) |
| 7 | Sign in to the secured player from the device holding `soft_fawn` (confirming the replacement) | pass `closure-sign-in-existing.xml`; Settings shows the secured email | Auth `login`, actor `93af15b0…` (`closure-sign-in-auth.txt`) |
| 8 | Lost-device recovery: fresh install (`green_orca`) → request reset on device → the REAL Mailpit link redirects to `arc21://auth/recovery?code=…` (PKCE, verifier in this Keychain) → new password → "Recover instead" warning → Home as the secured player | pass `closure-request-recovery-3.xml`, `closure-recovery-complete-2.xml` (new flow `recovery-complete.yaml`) | `user_updated_password` actor `93af15b0…`; old password now **400**, new password **200 for `93af15b0…`** (`closure-recovery-mail.txt`, `closure-state-8-recovered.txt`) |
| 9 | Delete the secured account through Settings ("Keep my account" first, then "Delete permanently") | pass `closure-delete-player.xml`; the device shows "Offline player" and does not silently create a new one | `auth.users`, `auth.identities`, `profiles`, `wallets`, `wallet_ledger` rows for `93af15b0…` all 0 (`closure-state-9-deleted.txt`) |
| 10 | Offline Practice: fresh install, local API gateway (Kong) **stopped** (gateway answers nothing); a full Practice hand plays; Home has no online balance | pass `closure-offline-practice.xml` | user count unchanged at 552, so nothing was created while offline (`closure-offline.txt`) |
| 11 | Gateway restored → foreground connects automatically → **`royal_bison`** `ca2bf921…`; local Practice history (1 hand, 1 decision) is still shown | pass `closure-offline-reconnect.xml`, screenshot `newly-connected-profile-preserves-practice.png` | exactly one new player; wallet exactly the 25,000 grant, so local results were not uploaded (`closure-offline.txt`) |

### Wallet / ledger / opening grant

Final aggregate over **every** wallet in the local database, after the full
server suite and all native flows (`$E/closure-state-final.txt`): **553 users,
553 wallets, 0 wallet≠ledger, 0 negative balances, 0 wallets whose
`initial_grant` count is not exactly 1.** The same aggregate held at every step
in §4b. The secured player kept its single grant through securing, sign-in and
recovery.

### Same-UUID securing and recovery

Proven natively (§4b rows 2–3, 7–8) and by the server suite's real Mailpit OTP
tests. Securing changed `is_anonymous` on the SAME row; recovery and sign-in
authenticate that same UUID; conflicts refuse rather than merge.

### Account-switch / stale-response safety

Covered by `tests/auth/player-state-isolation.test.ts`,
`tests/auth/pseudonymous-adapter.test.ts` and the store tests in the unit gate
(queued intents bound to an expected player, cache clearing, late-reply
invalidation). Exercised natively by rows 6–8, where the player is replaced with
a warning and no state from `soft_fawn`/`green_orca` appeared on the recovered
player. There is no native test that forces a late network reply across a
switch; that remains unit-level evidence.

## 5. Harness changes made during closure (tests only; no assertion weakened)

- `secure-email.yaml`: `Select All` (not offered by the iOS 26 edit menu) was
  replaced with tap/erase twice, because a tap puts the cursor at a word
  boundary. The exact-recipient assertion is unchanged, and the recipient was
  also checked server-side.
- `secure-verify.yaml`: the number pad has no dismiss key and covers Verify while
  Verify stays in the accessibility tree, so `scrollUntilVisible` "found" it and
  the tap hit the keyboard. Auth logged no `/verify` request, confirming this. The
  flow now taps the static handle text (the screen uses
  `keyboardShouldPersistTaps="handled"`), and taps "Email verified" after the
  password.
- `replacement-cancel.yaml`, `request-recovery.yaml`: relaunch at the start
  (keychain/SQLite kept) so a form or sheet left by a previous run cannot carry
  over. `replacement-cancel` also dismisses iOS's "Save Password?" sheet, which
  appears after the app leaves the abandoned form (the same step
  `sign-in-existing.yaml` already had).
- New `recovery-complete.yaml`.
- Evidence harness `$E/closure-native.py` (outside Git). Mail lookups match the
  EXACT recipient and take the newest message; the older harness matched
  substrings. It accepts Auth's 303 recovery redirect as well as 302, and it
  never prints tokens or the recovery code.

## 6. Harness and environment failures, and how each was classified

| Symptom | Classification | Basis |
|---|---|---|
| Sep 24: DB recreated mid-flow; 0 users; schema at `20260909120000`; Auth "hostname resolving error" | **ENVIRONMENT — stack collision.** A separate session in `/Users/tj/Desktop/Attest` ran `supabase db reset` from `Attest/arc21 copy`, whose `config.toml` also says `project_id = "arc21"` and so shares these containers | `closure-stack-collision.txt`. The user later reset from this repository and confirmed the Attest workload had finished |
| Sep 24: XCTest runner force-quit (DeviceUnreachable); `eraseText` suffix; `hideKeyboard` on number pad | HARNESS | see §5; recorded in `high-*` artefacts |
| Full server run: `table-reconciliation` HTTP **546** | ENVIRONMENT — local Edge runtime killed the worker (`CPU time hard limit reached` at the same second, 00:28:03.73) | `closure-functions.log`: 88 soft-limit / 3 hard-limit events in that run, load rising to 11. Passed 2/2 on rerun |
| Full server run: lost-reply test saw 5 retries, not 4 | ENVIRONMENT — one extra 5xx from the same worker retirements; the test counts transport retries | passed within `game-command` 44/44 on rerun, no hard-limit event during it |
| First rerun: `game-command` failed to collect (stack-guard 5 s probe) | ENVIRONMENT — load 15 from unrelated system work (Spotlight, mobileassetd) | waited for load < 6; passed 44/44 |
| `fresh-player` second run stayed on onboarding | ENVIRONMENT — swallowed tap at load 27 (`mediaanalysisd`); the app had already created the player on launch, as designed | rerun at load ~8 passed with the SAME player, no orphan |
| `replacement-cancel`: `@soft_fawn` not visible | HARNESS — iOS "Save Password?" system sheet covering a correct profile (screenshot) | §5 |
| `request-recovery` retry: malformed address | HARNESS — stale form kept from the previous run; the flow's assertion correctly failed | §5 |
| Recovery link: `HTTP Error 303` | HARNESS — only 302 was accepted | §5; a fresh link was requested so the evidence stays clean |

**No product defect was found in the closure pass, and no production code,
timeout, retry policy or assertion threshold was changed.** Auth events for the
harness errors confirm the product behaved correctly each time.

`wp1_clean.py` was not running at any point in this pass, so no process was
suspended or signalled.

## 7. Restored local services

- Sidecars stopped for native testing on Sep 23 (Studio, pg-meta, analytics,
  vector) were started again and are healthy (`closure-services-restored.txt`).
  `supabase status` still names imgproxy and pooler as stopped: both are
  disabled in `config.toml` (`[db.pooler] enabled = false`, no image
  transformation) and have never had containers.
- Kong was stopped for the offline proof and restarted immediately afterwards
  (gateway answers 401 again).
- `supabase functions serve --no-verify-jwt` was restarted before the server
  suite, per CLAUDE.md. It is running, logging to `$E/closure-functions.log`.
- The local database now holds the B schema plus test players from the server
  suite and these flows. Attest's seeded users were removed by the user's reset.

## 8. Recovery model and limitations

- An unlinked player cannot be recovered after credential clearing, sign-out,
  reinstall, device loss or moving devices. The app says so before sign-out,
  sign-in and recovery (proven, §4b row 6).
- A fully lost anonymous-creation response can leave an inaccessible server
  orphan; Supabase has no idempotent anonymous-creation primitive. Serialized
  restore-before-create prevents duplicate requests from mounts or reconnects.
  No orphan wallet is merged or imported. The closure pass itself deliberately
  created orphans (`soft_fawn`, `green_orca`) by reinstalling.
- Anonymous does not mean temporary. No age-only cleanup is installed. A future
  retention job needs an explicit policy plus activity, seat, ownership and
  economic checks; blanket deletion of Auth users is unsafe.
- CAPTCHA and IP limits mitigate account farming but cannot prove one human per
  identity. CAPTCHA was not exercised on a device in B; locally it is off.
- Not proven natively in B: an UNCONFIGURED build (no `.env.local`). Offline was
  proven with the gateway down instead, and the unconfigured path rests on unit
  tests and Refresh A's `every-screen.yaml` (not rerun). Also not proven: Android,
  physical devices, and a forced late reply across an account switch (unit-level
  only).
- The final full server run was 333/335 with both failures classified as
  environment and both files green on rerun. There is no single uninterrupted
  335/335 run after the Sep 26 reset; the last one is Sep 16, and server code has
  not changed since.
- Lint carries 21 pre-existing-style warnings, 0 errors.

## 9. Hosted activation (not performed)

Enable anonymous Auth and manual linking, require email confirmation, install
the matching OTP template, configure delivery SMTP and the exact recovery
redirect (`arc21://auth/recovery` in `additional_redirect_urls`), and enable
hCaptcha with the private Auth secret plus a matching public native build
configuration. Keep signup/IP limits and tune them against monitored volume and
abuse. Verify CAPTCHA, including accessibility and error/cancel paths, on
physical devices. Apply the forward migration through the normal reviewed
release process, and confirm the hosted PostgREST version does not have the
v16.1 clock defect. Push credentials, Android and physical-device release checks
remain external work carried over from Refresh A. No hosted setting, data or
deployment was changed.

## 10. Known blockers

The closure agent reported none at handoff. The independent review subsequently
reproduced the account-switch blocker in §12. A bounded repair for it is recorded
in §13, with its own verification. The final re-audit passed the targeted social
regressions but reproduced the directly analogous table cash-out blocker in §15.
A bounded repair for THAT is recorded in §16, again with its own verification and
its own fail-with-the-repair-removed measurement. No blocker in this defect class
is outstanding; no other blocker was searched for. Two things §16 could not finish
are stated in it rather than hidden: no single uninterrupted 28-file server run was
obtainable on this host (every file passes alone — §16.6), and the two-device native
table proofs could not be taken at all (§16.8.3, §16.8.4). Refresh B remains FAILED
and un-checkpointed.

## 11. What the independent reviewer must scrutinize

1. `handle_new_user` and `assert_client_authorization_surface` are REDEFINED by
   `20260915120000`. Per CLAUDE.md, confirm each started from the LAST earlier
   definition (e.g. the `unique_violation` fallback in `handle_new_user`, every
   earlier gate check), and that the opening grant fires only on INSERT.
2. The same-UUID guard in the securing path (detached client's returned UUID
   compared before tokens are adopted) and the conflict path never merging.
3. `auth-mutation-queue.ts` and the expected-player guards: can a queued
   sign-out, delete or economic retry act on a different player than intended?
4. RLS/grants: the `friend_requests` insert revoke, the dropped Realtime presence
   policies, and `list_friend_presence`'s block checks and grants (no `anon`, no
   `service_role`).
5. That no local Practice, XP or bankroll data reaches the server
   (`src/features/player/`, the auth adapters, and §4b row 11).
6. The harness edits in §5: confirm none weakened an assertion.
7. Hosted differences: the PostgREST pin is local-only; review CAPTCHA
   configuration and anonymous-user abuse posture before activation.
8. Account deletion of a SECURED player was proven; review that deleting an
   anonymous player behaves the same.

## 12. Final independent audit — September 27, 2026

**ASTRA REFRESH B: FAIL**

Reviewed as one primary agent, without subagents or Goal mode, on
`astra-refresh-b` at starting/unchanged HEAD
`47dba201ace488d932bb4e479416f52f79a6f176`. Review stopped at the first confirmed
product defect, as required. No production code or tests were changed, no
checkpoint was committed, and nothing was pushed or deployed. Refresh C did not
begin.

### Release-blocking defect: a stale social intent can act as the replacement player

`src/features/friends/friends-gateway.ts:216–242` awaits `getSession()` but
retains neither the expected player nor the credential for the subsequent RPC.
Its mutating RPC uses the shared Supabase client's session at dispatch time.
`src/features/friends/friends-store.ts:259–289` captures a player scope, but only
checks it **after** the gateway has completed the server mutation. Resetting the
store and rejecting the old response therefore cannot prevent the wrong-player
write. The Auth mutation queue serializes Auth operations, not social RPCs.

Independent reproduction used the actual production friends store/gateway and
Auth adapter, the installed Supabase SDK, and the running local GoTrue/Postgres
stack. Three fresh local fixture identities were created. The only injected
delay held one `getSession()` completion across a real password sign-in; no
Auth verdict, RPC response, credential, or database result was fabricated.

1. Anonymous A (`dc2107c9-04e4-45ec-b468-8381a5f94ae5`) started a friend request
   to fixture C (`62d6dfb0-f804-4ff0-8be0-a8bda978ac26`). Its session read was
   held before the gateway continued.
2. The production Auth adapter signed in to secured B
   (`97c02538-cdac-49ce-857e-ccecfb54cb16`), with A as the expected old identity.
   The Auth event updated the player and called the production state reset,
   matching the root subscription's identity-change behavior. The pending UI
   action was cleared.
3. Releasing A's delayed work caused `send_friend_request` to run as B. C's
   authenticated database read returned a pending request with **B as sender**.
   The original store action returned `false`, demonstrating that the response
   guard worked while the server mutation had already affected B.
4. All three fixture users were deleted after readback; their cascade cleanup
   succeeded. Existing evidence and players were preserved.

Classification: **product defect / category A, Refresh-B release blocking**.
The server correctly enforces the supplied authenticated identity; this is a
client intent-to-identity binding failure, not an RLS bypass or environment
failure. It directly contradicts the claimed protection against previous-player
work mutating a replacement player. The existing isolation test uses a fake
gateway with an already-pending response, so it proves stale-cache suppression
but does not exercise credential selection before the real RPC.

Preserved evidence (outside Git):

- `$E/independent-audit-stale-social.ts`: bounded reproduction script, including
  real Auth setup, production call sites, timing injection, readback assertions,
  and fixture cleanup. It prints no tokens or passwords.
- `$E/independent-audit-stale-social.log`: exact UUIDs and database result.
- `$E/independent-audit-failure-manifest.json`: reviewed source SHA-256 hashes,
  branch, HEAD, and capture time.

Smallest repair scope: bind each social mutation to the initiating player and
credential through dispatch, reject invalidated work before issuing the write,
and ensure an intervening SDK token lookup cannot substitute the replacement
player. Add a regression that switches identities before the real gateway
dispatches and asserts no replacement-player mutation. Review the analogous
`requireSession()`-then-mutation paths in `rooms-gateway.ts` within that bounded
repair; they were identified statically but not separately reproduced here.
Do not treat a post-response store check alone as the repair.

### Independently reviewed before the stop

- Confirmed branch, starting HEAD, uncommitted worktree, and intentionally
  untracked `AGENTS.claude-backup.md`.
- Compared the redefined authorization gate against its last effective prior
  definition in `20260904120000_least_privilege_and_entry_visibility.sql`.
  The only body differences add `list_friend_presence` to the authenticated
  allowlist and remove `friend_requests:INSERT`; no prior assertion was lost.
- Compared bootstrap against its last effective prior definition in
  `20260829120000_account_lifecycle_completeness.sql`. Username uniqueness
  collisions still retry, unrelated uniqueness failures still raise, and the
  opening wallet/ledger rows remain in the Auth INSERT transaction.
- Inspected detached OTP verification and the same-UUID check before adopting
  tokens, the Auth queue and expected-player checks, session-intent credential
  pinning, state invalidation, and the relevant production social callers.

The full 335-test server suite, broad gates, and native flows were not rerun in
this audit: the confirmed blocker made further completion checks unnecessary.
The closure's 333/335 environment classification, remaining native evidence,
hosted activation requirements, and unproven-platform classifications were not
fully adjudicated before this required stop. Their earlier recorded results
are not promoted to independent PASS. A fresh final audit is required after the
bounded repair.

## 13. Bounded repair of the §12 blocker — September 27, 2026

**The §12 FAIL record above is unchanged and is not softened by this section.**
Refresh B is still NOT independently passed and NOT checkpointed. HEAD is still
`47dba201ace488d932bb4e479416f52f79a6f176` and nothing has been committed, pushed,
merged or deployed. What follows is the repair and its targeted verification, for
a fresh independent audit to judge.

### Root cause

One defect class, in four files, with one shape:

> **await a session read, then issue a mutating request whose identity the SDK
> chooses when the request leaves.**

`friends-gateway.ts`'s `requireSession()` (and its twins in `rooms-gateway.ts`
and `wallet-gateway.ts`) awaited `client.auth.getSession()` only to tell "signed
out" apart from "unreachable". It kept neither the player nor the credential, and
the RPC that followed was authenticated by whatever session the shared client
held at fetch time. Every one of these RPCs names only the OTHER party —
`send_friend_request(p_to)`, `join_private_room(p_code)`,
`claim_recovery_grant()` — so the acting player comes entirely from the JWT.

`friends-store.ts` captured a player scope and checked it **after** the gateway
returned. That is a guard on the CACHE, not on the write: it discards a reply,
and a reply is not a row. It is why the audit saw a correct screen above a wrong
database.

The Auth mutation queue serialises Auth operations, so it never applied here.
`sendSessionIntent` (the economic one-shots) had already solved this correctly by
pinning the verified token per intent; the social, room and wallet paths had not
been brought in line with it.

### The production fix

New file `src/lib/supabase/player-binding.ts` — one helper, no parallel auth
system, no second source of session ownership. It reuses the existing
`capturePlayerScope()` revision and the existing verified session; the server
still verifies the JWT and RLS still decides.

`bindCurrentPlayer(client, timeoutMs)`:

1. reads `capturePlayerScope()` **before its first `await`**, so the revision is
   the caller's dispatch, not whoever is current by the time the session read
   returns;
2. refuses `identity-changed` if the scope moved while the session was being
   read — not as the new player, and not as the old one either, because that
   dispatch is over;
3. returns the bound `userId` and a pinned `Authorization` value.

`sentAs(request, player)` puts that value on the ONE request, through
postgrest-js's documented `setHeader`. The SDK's `fetchWithAuth` fills
`Authorization` in only when it is absent, so a pinned header wins and a sign-in
landing inside the fetch cannot substitute the replacement player's JWT. Edge
Function calls pass the same value in `headers`, exactly as `session-intent.ts`
already does. Measured, not assumed: see the pinning case in the regression.

Each mutating method now calls `bindPlayer()` as its FIRST statement and
re-checks `player.isCurrent()` immediately before the write.

Production files changed:

| File | What changed |
|---|---|
| `src/lib/supabase/player-binding.ts` (new) | `bindCurrentPlayer`, `sentAs`, `BoundPlayer` |
| `src/features/friends/friends-gateway.ts` | `requireSession` → `bindPlayer`; all six mutations and all four reads bound and pinned; new `stale-identity` failure reason |
| `src/features/friends/friends-store.ts` | comment only — states that the post-response scope check protects the cache and is not the write guard |
| `src/features/rooms/rooms-gateway.ts` | `requireSession` → `bindPlayer`; `create`, `join`, `setReady`, `removeMember`, `start`, `leave`, `read`, `findOpenRoom`, `findSeat` bound and pinned; new `stale-identity` reason |
| `src/features/rooms/use-room-invites.ts` | `invite_friend_to_room` bound and pinned |
| `src/features/wallet/wallet-gateway.ts` | `claim_recovery_grant` and the wallet/ledger reads bound and pinned; new `stale-identity` reason |

No migration, no RLS policy, no Edge Function and no server code changed. No
existing assertion, timeout, rate limit or concurrency test was weakened or
relaxed.

`stale-identity` is a stated reason rather than a borrowed one. Both stores map
it through their `default` branch to `unavailable`, and in practice it is rarely
rendered because the identity change has already cleared the screen — but
"signed out" would be false (somebody IS signed in) and "unreachable" would blame
a server that was never called.

### Analogous mutation paths reviewed

| Path | Verdict |
|---|---|
| `friends-gateway.ts` — six relationship RPCs | **Same root cause. Fixed.** The audited one. |
| `rooms-gateway.ts` — `create`, `join`, `setReady`, `removeMember`, `start`, `leave` | **Same root cause. Fixed.** `create_private_room` and `join_private_room` name no player at all, so a held read could have opened or joined a table as whoever signed in next. |
| `use-room-invites.ts` — `invite_friend_to_room` | **Fixed.** No held read of its own, so the window was one microtask rather than a whole sign-in — but it writes a notification into somebody else's inbox and it is the same unbound-credential shape. |
| `wallet-gateway.ts` — `claim_recovery_grant` | **Same root cause. Fixed, and it moves chips.** Found by asking which other calls have the audited shape. A held read across a sign-in would have credited the REPLACEMENT player's wallet and spent their grant cooldown. |
| `session-intent.ts` — every `create-session` economic intent (buy-in, career, daily, sprint, quick play, matchmaking seat) | **Already correct.** It pins the verified token per intent and re-checks the player scope before each attempt. This repair follows its pattern rather than adding a second one. |
| `online-table-gateway.ts` — `game-command` send, `CASH_OUT`, `RESET_PRIVATE_STACK` | **Same shape, not exploitable, deliberately unchanged.** Every one is addressed to an existing `gameId`, and both functions refuse a caller with no seat there (`NOT_A_PARTICIPANT`, `game-command/index.ts:376`, `create-session/index.ts:849`, `:988`, `:1035`). A replacement player therefore cannot mutate anything through them, and the cash-out key is derived from `gameId:seatId`. Binding them would also make accepted native table evidence stale for no security gain; recommended as a separate consistency change, not part of this repair. |
| `matchmaking-store.ts` — `join_matchmaking`, `leave_matchmaking` | **Not affected.** `queue()` already checks `setForPlayer.isCurrent()` BEFORE the write, which is precisely the guard friends lacked. The credential is not pinned, so the sub-millisecond fetch-token window remains; noted, not part of this repair. |
| `notifications-store.ts` (`mark_notifications_read`), `cosmetics-store.ts` (`equip_cosmetic`) | **Not affected.** Both dispatch with no awaited session read in front of them, and neither writes anything outside the caller's own rows. |
| `presence-store.ts` (`touch_last_seen`) | **Not affected.** No held read, and it updates only the caller's own presence row. |
| `push.ts` (`register_push_token`, `retire_push_token`) | **Not affected.** Already captures the player scope (`push.ts:166`). |
| `supabase-auth-adapter.ts` (`delete_own_account`) | **Not affected.** Already goes through the Auth mutation queue's `expectedUserId` guard. |

### Regression added

Two files, both driving PRODUCTION store → PRODUCTION gateway → real
`@supabase/supabase-js`. Neither uses a fake gateway: that is what the superseded
test did, and a fake gateway cannot have this defect, because the bug is in which
credential the real SDK attaches to a real request. The only fault injected in
either file is the audit's own — one `getSession()` completion held across the
account switch.

`tests/auth/stale-identity-mutation.test.ts` (unit gate, 5 tests, no Docker).
A real SDK client over a recording transport, with the SDK's stored session
swapped mid-flight as a sign-in swaps it and the production `resetPlayerState()`
at the identity boundary. Assertions are on the WIRE — which requests left, and
with whose token:

1. player A's friend request is never sent as B (and no reload is either);
2. an uninterrupted request goes with the DISPATCHING player's pinned token, not
   the newer token in storage — this is the case that proves the pin rather than
   just the gate;
3. a private table is never joined as B;
4. a recovery grant is never claimed into B's wallet;
5. a room invitation is never sent as B.

`tests/server/stale-identity-social.integration.test.ts` (server gate, 2 tests).
The audit's reproduction, inverted into a regression: real GoTrue, real Postgres,
three real fixture identities, the production `useAuthStore` and the production
Supabase Auth adapter, and a real `signInWithPassword` switch from anonymous A to
secured B with A named as the player being replaced. It asserts on the DATABASE:

- `friend_requests` for the recipient is **empty** — neither B's id nor A's;
- B's own `list_friends` and `list_friend_requests`, read as B, are empty;
- no stale UI survived the switch (`pending`, `actionError`, `status`,
  `searchStatus`);
- and the second test is a **positive control**: the same store, gateway and
  client, with nobody switching underneath, still writes a request whose sender is
  B. A harness that had stopped being able to write anything would otherwise
  satisfy every assertion above it.

Fixture users are deleted in `afterAll` and the local user table was confirmed
clean afterwards.

**Both files were proved to FAIL against the defect**, rather than assumed to
work: with the scope gate and the header pin removed from `player-binding.ts`,
all five unit cases fail — `expected [ 'Bearer token-b' ] to deeply equal [ ]`
and `expected 'Bearer token-a-rotated' to be 'Bearer token-a'` — and the server
case fails on the database readback naming the replacement player as
`sender_id`. The file was then restored byte-for-byte (verified by `diff`).

### Targeted verification (September 27, 2026)

`supabase functions serve` was restarted first, per CLAUDE.md; the accumulated
process had been up 14.5 hours with 107 CPU soft-limit events in its log. Host
load was 3–9 throughout. The pre-existing `$E/closure-functions.log` was not
touched; the fresh run logs outside it.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npm run lint` | **0 errors / 21 warnings** — identical to the recorded baseline; no new warning |
| New unit regression | **5/5 pass**; 5/5 fail with the fix removed |
| New server regression | **2/2 pass**; 1/2 fails with the fix removed, on the database readback |
| `npm run test:unit` | **134 files / 2518 tests pass** (133 / 2513 in this working tree before the repair) |
| `npm run test:server`, full | **27 files / 337 tests pass**, one uninterrupted green run — better than the §3 row's 333/335 with two environment failures |
| Friends / rooms / auth / matchmaking unit files | 21 files / 410 pass |
| `private-rooms`, `two-client-table`, `pseudonymous-identity`, `stale-identity-social` | 4 files / 44 pass |
| `rls-writes`, `rls-idor`, `profile-privacy`, `notifications` | 4 files / 43 pass |
| `economy-authority`, `economy-guards`, `quick-play`, `account-lifecycle` | 4 files / 51 pass |

Not run, and why: `npm run check:functions` and `supabase test db` — nothing under
`supabase/functions` or `supabase/migrations` changed. `test:coverage` — the
coverage `include` globs cover `shared/**`, `supabase/functions/_shared/**` and
`src/features/practice/*`, none of which this repair touches, so no threshold can
have moved.

### Prior Refresh-B evidence that is now STALE

**The iOS Release build proof in §3 is stale, and with it every native row in
§4.** That row's claim is that no `src`/`app`/`shared`/`supabase/functions` file
is newer than the build (261 matching source fingerprints). Six `src` files are
now newer and one is new, so the Release binary no longer contains the code under
test.

Which proofs must be renewed, and why each:

- **Every row of §4a and §4b.** `src/components/ui/ScreenHeader.tsx` renders
  `header-chips` from `useWalletStore`, which is now served by the bound
  `wallet-gateway.fetch()` — so every screen in every flow executes changed code.
  A new `--configuration Release` build and a re-run of both tables is required
  before Refresh B can be checkpointed.
- **Specifically the social rows** (`native-social-send`, `native-social-pending`,
  `native-social-accept`, `tests/e2e/refresh-b/social-send.yaml`,
  `every-screen-online.yaml`) — `friends-gateway.ts` is the file the audit
  localised.
- **Specifically the table rows** (`native-public-{queue,join,seat}`,
  `native-public-reconnect-leave`, `native-public-survives`,
  `social-private-invite`) — `rooms-gateway.ts` and `use-room-invites.ts`.
- **§4b row 11's "local results were not uploaded" wallet readback** and the
  §4 aggregate `553 users / 0 wallet≠ledger / exactly one grant each` — the
  wallet READ path changed. The invariant is unchanged and the full server suite
  re-proves it against the database, but the native readback was taken with the
  old binary.

Everything else recorded in §3 stands on its own terms: the migration count, the
pgTAP run, the authorization gate, contrast, Expo Doctor and the bundle export
are all unaffected by these six files, and the server suite has been re-run green
in full.

### What the independent re-auditor must verify

1. That `bindCurrentPlayer` reads `capturePlayerScope()` **before any `await`**,
   and that every caller invokes `bindPlayer()` as its first statement — a
   binding taken after an await is a binding to the wrong player and is the
   original defect with extra steps.
2. That the pinned `Authorization` actually reaches the wire and wins. The SDK's
   `fetchWithAuth` sets that header only `if (!headers.has("Authorization"))`;
   confirm that is still true of the installed `@supabase/supabase-js`
   (2.112.3) rather than taking this note's word for it.
3. That **no mutating client call remains unbound** other than the
   `online-table-gateway.ts` ones argued above — and that the argument holds:
   re-derive that every `game-command` and `create-session` action carrying a
   `gameId` refuses a caller with no seat in it.
4. That `invalidatePlayerScope()` really fires on every identity change, i.e.
   that `usePlayerState` is installed at the app root and that `adopt()` is the
   only writer of `useAuthStore.session`. Note the known window this fix does NOT
   close and does not need to: between the SDK swapping its session and the app's
   auth subscription delivering the change, a bound request still goes out on the
   PINNED token — as the player who asked for it, which is correct attribution,
   not a wrong-player write.
5. That the two regression files fail when the repair is removed. Do not take the
   measurement above on trust; it is a two-line edit to `player-binding.ts`.
6. That the positive control in the server regression is doing its job — delete
   it and the file would pass against a harness that can no longer write at all.
7. The renewed native evidence listed above, on a fresh Release build.
8. Everything §11 already asks for, none of which this repair addresses.

### Preserved audit evidence

`$E/independent-audit-stale-social.ts`, `$E/independent-audit-stale-social.log`
and `$E/independent-audit-failure-manifest.json` are unchanged. The repro script
is the ancestor of the server regression and should be read alongside it.

### Remaining blockers

None found in this defect class. No other blocker was looked for: this was a
bounded repair, not a second audit, and §11's list plus §9's hosted activation
work are all still outstanding.

## 14. Native-evidence renewal after the §13 repair — September 27, 2026

**This section renews only the native proofs §13 declared stale. It is not a
PASS.** §12's FAIL record and §13's repair record are unchanged above, HEAD is
still `47dba201ace488d932bb4e479416f52f79a6f176`, nothing has been committed,
pushed, merged or deployed, and Refresh B remains un-audited and
un-checkpointed. No production file was changed in this pass.

Evidence from this pass is in `$E` under the `renewal-` prefix, so every
`closure-` and `native-` artefact from §4 is preserved beside it.

### 14.1 The fresh iOS Release build

```
LANG=en_US.UTF-8 npx expo run:ios --configuration Release \
  --device D16C4292-670D-4036-BDB1-2E9B31B11D3D --no-bundler
```

| Claim | Evidence |
|---|---|
| **Build Succeeded**, 0 errors / 3 warnings | `renewal-release-build.log` |
| Configuration is **Release** | the product is written to `Build/Products/Release-iphonesimulator/Arc21.app` — the Release product directory, not Debug; the log's `Bundle React Native code and images` phase re-bundled (`Eager bundle does not match new options, bundling again`), and the installed app carries an embedded `main.jsbundle` and no dev-menu payload |
| Nothing served the app a different bundle | `lsof -ti:8081` was empty immediately after the build and again after the last flow, so no Metro was running that could have substituted one, and the app can only have run its embedded bundle. This is the check CLAUDE.md's stale-bundler note asks for. Note that `expo run:ios` ends by opening a dev-client URL pointing at 8081; with nothing listening there it is inert |
| The binary is the code under test | `renewal-build.json`: bundle SHA-256 `8bfbb1cb4560…`, 6,396,900 bytes, built 2026-09-27T21:04:46Z, **246 source files fingerprinted, 0 newer than the bundle** |
| The binary contains the **repair** | the two reason strings the repair introduced — `stale-identity` and `identity-changed` — are both present in the Hermes bytecode. Treated as a POSITIVE control only: `Players are never merged` returns zero hits from the same scan although that copy plainly renders, which is exactly why CLAUDE.md says a string scan of a `.hbc` cannot prove absence |
| No tracked production source changed between the build and the end of the flows | `renewal-build-after-flows.json` and `renewal-build-final.json`, taken after the last flow of each half of the pass, are both **byte-identical** to `renewal-build.json`: same bundle SHA-256, all 246 source SHA-256 values equal, empty difference list |

The freshness method is `renewal-freshness.py` (outside Git). It fingerprints
every tracked and untracked `.ts/.tsx/.js/.jsx/.json` file under `app/`, `src/`
and `shared/` and reports any whose mtime is newer than the bundle — the same
claim §3's row made, re-derived rather than inherited.

### 14.2 Renewed native flows

Device A: iPhone 17 Pro `D16C4292-…`. Device B: iPhone 17 Pro Max
`064733EE-…`, booted and installed with the same Release product. Every flow ran
on the Release app against the local stack; no session was injected. Each row
pairs the Maestro result with a server-side readback, because a screen cannot
say whose row was written.

Players created by this pass: **A** `301af11d-1f99-45e8-af71-c801b3128109`
(`gentle_moth`, later display name `RiverPlayer`, later secured, finally
deleted); **B** `18f20b99-fcf6-4ec3-bc6f-61fadbcdda72` (`agile_snail`);
**C** `5aaf6b64-…` (`gold_snail`); **D** `12b58ec3-…` (`brisk_cobra`);
**E** `94191126-…` (`crisp_bunny`).

| # | Required proof | Flow (evidence `$E/renewal-…`) | Result | Server-side readback |
|---|---|---|---|---|
| 1 | Fresh pseudonymous entry | `fresh-player.yaml` → `-fresh-player.{xml,log}` | pass 40s | `-state-1-fresh-a.txt`: users 1308→**1309**, A anonymous, no email, handle `gentle_moth` generated by the server, 25,000 = ledger, **1 grant**. The rendered profile (`refresh-b-generated-handle.png`) shows the handle and "Secure your player" — no credential was asked for |
| 2 | Cold relaunch / session restoration | `cold-player.yaml` → `-cold-player.*` | pass 28s | `-state-2-cold-a.txt`: same UUID, same handle, user count unchanged, still **1 grant**. `auth.sessions` held the SAME single row created at first launch, so the stored session was restored rather than replaced |
| 2b | Token renewal | the device's own session, left to renew itself; `cold-player.yaml` again afterwards → `-cold-after-rotation.*` | pass 15s | `-state-18-rotation.txt`: the SDK rotated the refresh token at 23:17:13Z under the SAME `auth.sessions` row (one revoked token, one live, still one session), and a cold relaunch on the rotated credential restored the same UUID, the same handle and the same single grant. See §14.5 |
| 4 | Profile persistence | `profile-rename-persist.yaml` → `-profile-name.*` | pass 1m19s | `-state-3-rename-a.txt`: `display_name` = `RiverPlayer` after a full stop/relaunch, `username` untouched, wallet = ledger, 1 grant |
| — | Second pseudonymous player | `fresh-player.yaml` on B → `-fresh-player-b.*` | pass 43s | `-state-4-fresh-b.txt`: users 1309→**1310**, exactly one new player, its own single grant |
| 3 | Public multiplayer, queue | `two-client-public-queue.yaml` → `-public-queue.*` | pass 32s | pool drained first (`-public-drain.txt`: 6 rooms closed, 32 queue entries expired, 0 open), so the table under test is this pass's |
| 3 | Public multiplayer, match + seat + buy-in | `two-client-public-join.yaml` → `-public-join.*` | pass 45s | B matched, "Seat found", buy-in charged only on taking the seat |
| 3 | **Both users in one real game** | `two-client-public-seat.yaml` (`OTHER=agile_snail`) → `-public-seat.*` | pass 1m34s | `-state-5-public-seated.txt`: ONE `game_session` `c18348ff-…` holding **both** seats — `agile_snail` at index 0 and `RiverPlayer` at index 1, both `active`, both `connected`. Each wallet debited exactly 2,000 (B 24,970→22,970; A 25,000→23,000), wallet = ledger for both. The flow's own `${OTHER}` assertion is the same fact rendered on A's screen |
| 3 | Reconnect, leave, rejoin, cash-out | `two-client-public-leave.yaml` → `-public-leave.*` | pass 2m7s | B relaunched cold and found its live seat through the Play tab's resume card (`my_active_session()`), cashed out, re-queued, **took a seat again at the same table**, and left again — three seat rows for `c18348ff` all settled to `left`, stack 0 |
| 3 | The remaining player stays functional | `two-client-public-survives.yaml` → `-public-survives.*` | pass 5m50s | `-state-6-public-closed.txt`: A was still seated after B's cash-out, was dealt in again, played on and cashed out. Both wallets reconcile |
| 5 | Friend request send | `refresh-b/social-send.yaml` (`OTHER=agile_snail`) on A | pass 18s | `-state-7-social.txt`: one `friend_requests` row, **sender = A**, receiver = B, `pending`. This is the exact write §12 showed landing under the wrong player |
| 5 | Pending state | `refresh-b/social-pending.yaml` on A | pass 8s | no second request was sent; the row is unchanged |
| 5 | Accept | `refresh-b/social-accept.yaml` (`OTHER=gentle_moth`) on B | pass 14s | request `accepted` at 21:59:48, and a `friendships` row for the pair. Notifications: `friend_request` into **B's** inbox when A sent, `friend_accepted` into **A's** inbox when B accepted — correct attribution at both ends |
| 6 | Private room create | `two-client-host-open.yaml` on A → `-room-create.*` | pass 30s | `-state-8-rooms.txt`: room `BV8XB8`, **host = A**, `lobby`, 2 seats, A `joined`. `create_private_room` names no player, so the host comes entirely from the bound JWT |
| 6 | Friend invitation | **new** `refresh-b/room-invite.yaml` (`PEER_ID=<B>`) → `-room-invite.*` | pass 13s | a `table_invite` notification in **B's** inbox at 22:02:20, carrying `from_user_id` and `room_code` and no other key |
| 6 | Private room join | `two-client-guest-join.yaml` (`CODE=BV8XB8`) on B → `-room-join.*` | pass 40s | B `joined` the room A hosts |
| 8 | Securing, step 1 | `refresh-b/secure-email.yaml` on A → `-secure-email.*` | pass 41s | `-state-9-email-pending.txt`: `email_change` is EXACTLY `renewal-a-20260927@arc21.test` on the same UUID, still anonymous; Mailpit's newest message is addressed to exactly that address and nothing else |
| 8 | Securing, step 2 — **SAME UUID** | `refresh-b/secure-verify.yaml` on A → `-secure-verify.*` | pass 32s | `-state-10-secured.txt`: the same row `301af11d…` is now `is_anonymous=false`, email confirmed, password set, **one** `email` identity, handle `gentle_moth` and display name `RiverPlayer` unchanged, 24,810 = ledger, **still exactly 1 grant**, and the user count did not move — no second player, no second grant from the Auth UPDATE |
| 10 | Already-owned email does not merge | `refresh-b/link-conflict.yaml` on a third player → `-link-conflict.*` | pass 31s | `-state-11-conflict-cancel.txt`: C still anonymous with NO pending change, A untouched, user count unchanged |
| 10 | Replacement + unsecured sign-out warnings, both cancelled | `refresh-b/replacement-cancel.yaml` → `-replacement-cancel.*` | pass 1m32s | C unchanged. Screenshots `replace-unlinked-warning.png`, `unlinked-signout-warning.png`, `cancelled-switch-retains-player.png` |
| 9 | Sign in to the secured player from another state | `refresh-b/sign-in-existing.yaml` on B → `-sign-in-existing.*` | pass 1m40s | `-state-12-signin.txt`: Auth `login` with actor = A's UUID at 22:11:42, Settings showing the secured email; C still exists, unmerged |
| 9 | Recovery deep link, new password, old refused | `refresh-b/request-recovery.yaml` + the REAL Mailpit link + `refresh-b/recovery-complete.yaml` on a fresh player D | pass 46s / 1m4s | `-state-13-recovered.txt`: Auth answered the mail link **HTTP 303** to `arc21://auth/recovery?code=…` (PKCE, verifier in that device's Keychain); `user_updated_password` actor = A; asked of GoTrue directly, **old password HTTP 400, new password HTTP 200 for `301af11d…`**; same handle, same display name, 24,810 = ledger, 1 grant; D still exists, unmerged |
| 11 | Offline Practice | `refresh-b/offline-practice.yaml` with Kong **stopped** → `-offline-practice.*` | pass 1m11s | `-state-14-offline.txt`: with the gateway answering nothing (`curl` 000), a full Practice hand played and Home rendered no online balance. Users **1312 before, 1312 while offline** — nothing was created |
| 11 | Local Practice does not become server state | `refresh-b/offline-reconnect.yaml` after restoring Kong → `-offline-reconnect.*` | pass 15s | exactly **one** new player `crisp_bunny`; its wallet is 25,000 and its ledger holds **one row, `initial_grant` 25,000, and nothing else**, while the rendered profile still shows "Practice hands played 1" and "1 decision" from the offline session (`newly-connected-profile-preserves-practice.png`) |
| 10 | Secured deletion | `refresh-b/delete-player.yaml` on B → `-delete-player.*` | pass 24s | `-state-15-deleted.txt`: `auth.users`, `auth.identities`, `profiles`, `wallets`, `wallet_ledger`, `friend_requests`, `rooms` and `friendships` rows for `301af11d…` are all **0**; the device shows "Offline player" and did not silently create a replacement (user count 1313→1312, newest user unchanged) |

Every flow in the table passed. Step counts were read from each run's
`commands.json` rather than from the exit code, per CLAUDE.md's note that a
Maestro exit of 0 does not mean the flow ran.

### 14.3 Wallet / ledger / opening grant

Asked of **every** wallet in the local database, not of this pass's players, at
every stage and finally in `renewal-state-16-final.txt`:

| | users | wallets | wallet ≠ ledger | negative | `initial_grant` count ≠ 1 |
|---|---|---|---|---|---|
| before any flow | 1308 | 1308 | **0** | **0** | **0** |
| after the public-table chain | 1310 | 1310 | **0** | **0** | **0** |
| after securing | 1310 | 1310 | **0** | **0** | **0** |
| final, after deletion | 1312 | 1312 | **0** | **0** | **0** |

The buy-in/cash-out cycles are the strongest part of this: B went 25,000 →
24,970 → 22,970 → 24,930 across two public buy-ins and three cash-outs, and its
balance equalled its ledger at every reading. The secured player kept its single
grant through securing, sign-in and recovery, and the reads that produced these
balances on screen are the ones `wallet-gateway.ts` now binds and pins.

### 14.4 Friends, rooms and wallet behaviour after the player-binding repair

The repair is a refusal path, so the thing to prove natively is that it refuses
nothing it should not. Every mutation the repair touched was exercised and every
one wrote the row it was supposed to, under the player who asked for it:

- `send_friend_request` — sender is A, the device that tapped it.
- the accept RPC — `accepted` plus a `friendships` row, and a `friend_accepted`
  notification into A's inbox, from B's device.
- `create_private_room` — host is A; the RPC names no player at all.
- `invite_friend_to_room` — a `table_invite` in **B's** inbox naming A.
- `join_private_room` — B joined by code.
- `claim_recovery_grant` is not reachable from these flows; it is covered by the
  §13 unit regression, which asserts on the wire that it is never claimed into
  the replacement player's wallet.
- the bound wallet reads served `header-chips` on every screen of every flow and
  reconciled against the ledger at every reading above.

**The §13 regression evidence is preserved and not replaced.**
`tests/auth/stale-identity-mutation.test.ts` (5 tests) and
`tests/server/stale-identity-social.integration.test.ts` (2 tests) remain the
proof of the security invariant — that a mutation initiated as player A cannot
be dispatched or committed as player B across an account switch — because that
race cannot be staged from a device. This renewal proves the complementary
thing: that the repair did not regress normal product behaviour. Neither
substitutes for the other, and nothing here weakens either file.

### 14.5 Token renewal

§4a's row recorded four refresh-token rotations on the old binary. On the new
one, session RESTORATION is proven (row 2 above: the same `auth.sessions` row
survives a cold relaunch, same UUID, same handle, no duplicate grant), and two
further sessions were legitimately created on the same UUID by sign-in and by
recovery. A refresh-token ROTATION was not observed, for an ordinary reason:
`jwt_expiry` is 3600 and no session in this pass reached its refresh margin
while a flow was running.

**It was then taken, by waiting rather than by forcing.** The app was left
foregrounded on device A holding `crisp_bunny` `94191126-…`, whose session was
created at 22:19:12Z, and the SDK renewed it by itself at **23:17:13Z** — the
`auth.sessions` row's `refreshed_at` moved while the row itself stayed the same,
and `auth.refresh_tokens` went from one live token to **one revoked and one
live**. That the session row is unchanged is what makes it a rotation rather
than a second sign-in: a sign-in inserts a second session, and there is still
exactly one. Note for a re-auditor that `refresh_tokens.parent` is EMPTY on both
rows in this GoTrue build, so it is not the discriminator — the session is.

A cold relaunch was then run against the rotated credential
(`renewal-cold-after-rotation.*`, pass 15s): the same UUID, the same handle
`crisp_bunny`, no new session, no new token, balance 25,000 = ledger and **still
exactly one grant**. Evidence: `renewal-state-18-rotation.txt`.

So row 2b is renewed on the fresh Release build: session restoration, token
rotation, and restoration again across the rotation, all on one UUID with one
opening grant and no duplicate.

### 14.6 Failures, and how each was classified

| Symptom | Classification | Basis |
|---|---|---|
| First `two-client-public-join` run: `Assertion is false: id: table-my-stack is visible`, after `Leave table` had already been asserted | **ENVIRONMENT — a driver read during screen settle at load 22.6.** Not a product defect and not a stale selector | The hierarchy Maestro SAVED for the failing step is a COMPLETE 80-node dump that CONTAINS `table-my-stack`, enabled, with text `2,000` and bounds `[378,282][424,304]` — so it was on screen while the assertion read false for 8 s. The failure screenshot shows the table rendered with the stack, and the database showed the seat taken and the buy-in charged. A probe asserting the same id on the same unchanged screen COMPLETED immediately. The chain was then re-staged from a drained pool at load 6.0 and **passed end to end**, which is the evidence in §14.2 — the failing run is not counted as a pass. Both runs are kept: `renewal-public-join/2026-09-27_142539/` is the failure (its `screen-hierarchy/` and `screenshots/` are the basis above) and `renewal-public-join/2026-09-27_144352/` is the pass, which is also what `renewal-public-join.xml` records |
| Cleanup leave held mid-hand, "Reconnecting… The hand has not stopped" | **PRODUCT WORKING** | A leave asked for mid-hand is held until the committed wager resolves, which `two-client-public-leave.yaml`'s own comment states. It settled and the seat released on the next attempt |
| Edge runtime logged 158 CPU soft-limit and **33 hard-limit** events during this pass (`renewal-functions.log`) | ENVIRONMENT, recorded but not implicated | `supabase functions serve` was restarted before the flows (the previous process had been up 6h19m with 48 soft-limit events) and both functions answered **401** before and after. No flow failed with a 5xx and no readback was missing. Noted because §6 saw three hard-limit events coincide with an HTTP 546, so a re-auditor should know the count was much higher here without a matching symptom |

**No product defect was found, and no production code, timeout, retry policy or
assertion threshold was changed.**

### 14.7 Harness changes

One addition, no edits, nothing weakened:

- **New `tests/e2e/refresh-b/room-invite.yaml`.** §13 requires renewed native
  evidence for `use-room-invites.ts`, and the only existing flow that taps
  `friend-invite` is `social-private-invite.yaml`, which OPENS by accepting a
  pending friend request — it cannot run against a friendship that already
  exists, which is precisely the state the renewed social rows leave behind. The
  invite half is extracted with the same selectors and the same assertion
  (`Invited`, the rendered result of the server's answer, not the tap), and the
  notification it produces is read back server-side. Same precedent as §5's
  `recovery-complete.yaml`.
- No repository flow was edited. The scratchpad-only probe and cleanup flows used
  to classify the failure above are not evidence and are not in the repository.
- Harness scripts outside Git: `renewal-native.py` (descended from
  `closure-native.py`, unchanged in the two ways that matter — mail lookups match
  the EXACT recipient and take the newest message, and no token, password or
  recovery code is ever printed) and `renewal-freshness.py`.

Because the only change is a new test file, nothing else was invalidated:
`check:functions`, `supabase test db`, the full server suite and `test:coverage`
were **not** rerun, and this pass changed no production or server code that could
require them.

### 14.8 Environment and service cleanup

- Host load was checked before each expensive step and the public chain was
  re-staged once for it. The stale `maestro-driver-ios` XCTest runner found
  running for 19h55m at the start was killed, per CLAUDE.md.
- `supabase functions serve --no-verify-jwt` was restarted before the flows and
  is running, logging to `renewal-functions.log`. Both functions answer 401.
- **Kong** was stopped for the offline proof and restarted immediately
  afterwards; the gateway answers 200 on `/rest/v1/` and `/auth/v1/settings`
  again. No other sidecar was stopped, so none needed restoring; all twelve
  containers are up.
- The database was **not** reset. No hosted Supabase setting, data or deployment
  was touched.
- Device B was booted for this pass and the Release product installed on it.
  Both simulators are left booted.
- Orphans deliberately created, as in §8: `gold_snail`, `brisk_cobra` and
  `crisp_bunny` are unlinked players left behind by reinstalls, and `agile_snail`
  is the surviving second device player. The room `BV8XB8` was removed by the
  cascade when its host was deleted.

### 14.9 What this replaces, and what still stands

**Replaced.** §3's iOS Release build row and **every row of §4a and §4b** are
superseded by §14.1 and §14.2 for the purpose of judging the current tree. The
older rows are preserved as the historical record of the pre-repair binary and
must not be read as current evidence.

**Still valid, and deliberately not rerun.** §3's migration count and clean
reset, the pgTAP run, the authorization gate, contrast, Expo Doctor and the iOS
bundle export — none is affected by the six repair files or by this pass's one
new test file. §13's targeted verification (typecheck, lint 0/21, both
regressions including their fail-with-the-fix-removed measurement, unit 134
files / 2,518 tests, server 27 files / 337 tests in one uninterrupted run) is
unchanged and is the current gate evidence.

**Still outstanding, unchanged by this pass.** Everything in §8's limitations,
§9's hosted activation, §11's review list and §13's re-auditor list. Not proven
natively in B: an UNCONFIGURED build, Android, physical devices, CAPTCHA on a
device, a forced late reply across an account switch (unit-level only). A refresh-token
rotation was outstanding when §14.5 was first written and is no longer: §14.5
records it as taken.

### 14.10 Exact state for the independent re-auditor

- Branch `astra-refresh-b`, HEAD `47dba201ace488d932bb4e479416f52f79a6f176`,
  everything uncommitted in the working tree. Nothing pushed, merged or deployed.
- `AGENTS.claude-backup.md` remains intentionally untracked and is not part of B.
- Production files changed relative to §13: **none**. This pass added exactly one
  file, `tests/e2e/refresh-b/room-invite.yaml`, and this section.
- The Release binary at
  `…/Build/Products/Release-iphonesimulator/Arc21.app`, bundle SHA-256
  `8bfbb1cb4560…`, corresponds to the tree as `renewal-build.json` and
  `renewal-build-after-flows.json` fingerprint it. Rebuild and compare rather
  than trusting the hash.
- **Refresh B is still NOT independently passed and NOT checkpointed.** §12
  remains the standing audit verdict; §13 is an unreviewed repair; §14 is renewed
  evidence for that repair, not a verdict on it. A fresh independent audit is
  still required.

## 15. Final independent re-audit — September 28, 2026

**ASTRA REFRESH B: FAIL**

Classification: **product defect / category A, Refresh-B release-blocking
software defect**. This is a confirmed replacement-player mutation, not a harness
failure or an unsupported claim. Review stopped on confirmation, per the audit's
real-defect rule. One primary agent only; no subagents or Goal mode.

Branch and unchanged HEAD: `astra-refresh-b`,
`47dba201ace488d932bb4e479416f52f79a6f176`. No production source or repository
test was changed by this review. This document is the only repository edit made
by the re-auditor. No checkpoint commit, push, merge, deployment, hosted change,
or Refresh C/D/E work occurred.

### Original social repair: targeted current verification passes

Independently read `player-binding.ts`, its production friends gateway callers,
the player-scope/reset subscription, the Auth adapter, and the regression's real
store → gateway → SDK → Auth/database path. The repair captures the scope before
the session await, rejects invalidated work before the write, and supplies an
explicit per-request Authorization header rather than changing session ownership.

Ran the current regression files against the running local stack, requiring
backend reachability rather than allowing a skip:

```
ARC21_REQUIRE_SERVER_STACK=1 npx vitest run \
  tests/auth/stale-identity-mutation.test.ts \
  tests/server/stale-identity-social.integration.test.ts --maxWorkers=1
```

**2 files / 7 tests PASS** (5 unit, 2 real-backend), including the normal-operation
positive control. Evidence: `$E/final-reaudit-social-regression.log`. These results
confirm the original held-session social race is rejected in the current tree;
they do not prove the analogous paths deliberately excluded by §13 are safe.

### Confirmed blocker: a delayed Leave closes replacement B's seat in the same game

The §13 exception for `online-table-gateway.ts` is incorrect. It assumes the
replacement player has no seat in the named game. Multiplayer permits both A and
B to be participants, so `NOT_A_PARTICIPANT` does not reject B. The server selects
the seat from the verified JWT it actually receives; a game ID is not a binding
to the player who initiated the request.

- `src/features/table/online-table-gateway.ts:367`: `requestCashOut` awaits
  `requireSession()` and then invokes `create-session` with no player-scope check
  or pinned Authorization. The SDK can attach B's current credential.
- `src/features/table/online-table-store.ts:719`: `leaveTable` checks its
  captured `tableGeneration` only **after** the gateway's server mutation. The
  correct stale-response discard cannot undo that mutation.
- `supabase/functions/create-session/index.ts:1033`: `cashOut` finds the seat
  using the supplied verified user's ID. When B is also seated, it finds B's
  seat, passes membership, and applies LEAVE to B at line 1067. The
  `gameId:seatId` idempotency key also belongs to B, so it does not protect A's
  intent from this first wrong-player dispatch.

The independent reproduction used real GoTrue sessions, the installed SDK with
PKCE and `processLock`, the production Auth store/adapter, production room
gateways to create/join/start a private table, and production online table
store/gateway to enter and leave. The Auth subscription called the production
`resetPlayerState()` on identity change, matching the root hook's boundary.
The only timing injection held one `getSession()` completion across a real
password sign-in. No credentials, Auth verdicts, table snapshots, or server
responses were fabricated, and no production file was altered.

1. Anonymous A `95f4263e-a265-480e-a765-bb020c3c6678` and secured B
   `1762c2d3-957f-4faf-b552-f4f4167124ab` both held active 5,000-chip seats in
   private game `21a65e8b-f049-4fd9-88a0-6dfb98781939`, phase `BETTING_OPEN`.
2. A called the production store's `leaveTable()`. Its gateway session read was
   held after reading A's session, before dispatching CASH_OUT.
3. The production Auth store signed in to B with A as the expected old player.
   Auth changed to B, the table reset to `idle`, and the pending action cleared.
4. Releasing A's delayed work sent the cash-out under the shared client's B
   identity. Direct database readback showed A's seat still `active`, stack
   5,000; B's seat changed to **`left`, stack 0**. The old store call returned
   `false`, proving again that UI suppression had occurred after a wrong-player
   write.
5. Both disposable fixture users were deleted; a database read confirmed zero
   fixture users remained. Existing players/evidence were preserved.

This proof uses private session stacks. It establishes a real unauthorized
replacement-player seat mutation; it does **not** claim a measured global-wallet
loss. No public-wallet reproduction is needed to establish this blocker.

Evidence preserved outside Git:

- `$E/final-reaudit-stale-table.ts`: complete bounded reproduction and cleanup.
- `$E/final-reaudit-stale-table.log`: fixture IDs, before/after seat readbacks,
  successful defect assertions, and confirmed cleanup.
- `$E/final-reaudit-failure-manifest.json`: source/evidence SHA-256 hashes,
  branch, HEAD and capture time.

### Smallest bounded repair

Bind the online table gateway's intents to the initiating player and credential
before asynchronous session work; reject invalidated work before dispatch and
before any retry, and pin that same credential on the outbound request. Cover
`CASH_OUT` and the directly analogous `game-command` and `RESET_PRIVATE_STACK`
paths in this gateway while preserving request IDs, server JWT authority and
cash-out/idempotency semantics. Add a regression through the production store
and gateway where A and replacement B are **both seated in the same game**, plus
a normal-operation control. Membership alone must not be treated as intent
binding. Renew affected native Release evidence after the production repair.
No repair was made in this audit.

### Review boundary

The required stop occurred during the analogous mutation review. The remaining
migration/RLS, same-UUID securing, broader account-switch, local-authority,
harness, native-evidence freshness/sufficiency and external-activation
adjudication were not completed in this session. Their preserved evidence and
historical review notes remain claims on their existing terms, not a new PASS.
The reported full unit **134 files / 2,518 tests** and server **27 files / 337
tests** were not rerun or promoted to independent complete-audit evidence here.
No native build or flow was rerun: a confirmed software blocker already requires
FAIL. `AGENTS.claude-backup.md`, evidence and credentials remain unstaged; the
index is empty and HEAD remains the starting SHA. This audit conversation ends
with FAIL and must not be resumed.


## 16. Bounded repair of the §15 blocker — September 28, 2026

**The §15 FAIL record above is unchanged and is not softened by this section.**
Refresh B is still NOT independently passed and NOT checkpointed. HEAD is still
`47dba201ace488d932bb4e479416f52f79a6f176`, nothing has been committed, pushed,
merged or deployed, no hosted Supabase setting or datum was touched, and §12–§15
are preserved verbatim above as history. What follows is the repair, its
verification and the native evidence it invalidated and renewed, for a fresh
independent audit to judge.

### 16.1 Root cause

One sentence, and it is the §13 sentence with the exemption removed:

> **await a session read, then issue a mutating request whose identity the SDK
> chooses when the request leaves** — and a `gameId` does not narrow that to one
> player, because a multiplayer table has more than one participant.

`online-table-gateway.ts`'s `requireSession()` awaited `client.auth.getSession()`
only to tell "signed out" apart from "unreachable". It kept neither the player nor
the credential, so the request that followed was authenticated by whatever session
the shared client held at fetch time. Every table call names a table and never a
player: `CASH_OUT { gameId }`, `RESET_PRIVATE_STACK { gameId }`, and every
`game-command` body, whose own unit test asserts that "there is no spelling of
'act as someone else' that compiles" — true of the payload, and the JWT is the
other half.

§13 exempted this file with a written argument: both functions refuse a caller
with no seat at the named game, so a replacement player could not mutate anything
through them. **The argument's premise is false.** `create-session/index.ts:1033`
finds the seat with `findSeat(tx, command.gameId, userId)`, where `userId` is the
verified JWT's — so when B is ALSO seated there, `NOT_A_PARTICIPANT` never fires,
`canCloseSession` passes, and `applyCommand(..., { type: "LEAVE", seatId: seat.id })`
closes B's seat. The `gameId:seatId` idempotency key the exemption also cited is
derived from the seat the server just found, which is B's, so it protects nothing
of A's. Membership is not intent binding.

The store's guard was on the wrong side of the write, exactly as the friends store's
was: `online-table-store.ts`'s `if (generation !== tableGeneration) return false;`
runs AFTER the gateway has returned, so it discards a reply. A reply is not a row.
That is why the audit saw a correct screen above a wrong database, and why the
reproduction's `leaveTable()` returning `false` was evidence of the guard working
rather than of the seat being safe.

### 16.2 The production fix

No new mechanism. `src/lib/supabase/player-binding.ts` — the helper §13 introduced
and which the re-audit independently verified — is reused unchanged and is
**byte-identical** to the copy in the §14 build (SHA-256 `bd776b3ef6a5…`). The
server still derives authority from the verified JWT and RLS still decides.

Each outbound path now:

1. calls `bindPlayer()` as its **first statement**, so `capturePlayerScope()` is
   read before any `await` and the revision belongs to the caller's dispatch;
2. refuses `stale-identity` if the scope moved while the session was being read —
   not as the new player, and not as the old one either, because that dispatch is
   over;
3. re-checks `player.isCurrent()` immediately before the write, and **again inside
   every retry attempt**;
4. pins the bound `Authorization` onto the request itself.

The pin is a mechanism, not an assertion, and both halves were re-derived against
the installed SDK (`@supabase/supabase-js` **2.112.3**, `functions-js` 2.112.3)
rather than inherited from §13's note:

- `FunctionsClient.invoke` composes `{...contentType, ...this.headers, ...headers}`
  — the call-level `headers` are spread LAST, so they beat the client-level header
  that `setAuth` rewrites on every auth event;
- `fetchWithAuth` still sets `Authorization` only `if (!headers.has("Authorization"))`,
  so a sign-in landing inside the fetch cannot substitute the replacement player's
  JWT.

Production files changed:

| File | What changed |
|---|---|
| `src/features/table/online-table-gateway.ts` | `requireSession` → `bindPlayer`; `snapshot`, `command`, `cashOut` and `resetPrivateStack` all bound and pinned; `attempt` and the stack-reset attempt re-check the player FIRST, so the binding covers each retry; new `stale-identity` failure reason |
| `src/features/table/online-table-store.ts` | comment only — states that the post-response `tableGeneration` check guards the SCREEN and is not the write guard |
| `src/lib/supabase/game-command.ts` | `sendGameCommand` bound and pinned; new `stale-identity` transport failure. It has **no production caller** (the table gateway does its own invoke), but it is exported from `src/lib/supabase/index.ts` with the identical shape, and CLAUDE.md's rule about two files doing one job applies: the one that does not get fixed is now the bug |

No migration, no RLS policy, no Edge Function and no server code changed. No
existing assertion, timeout, retry policy, rate limit or concurrency test was
weakened or relaxed. `src/lib/supabase/player-binding.ts` was not edited.

`stale-identity` is a stated reason rather than a borrowed one, for the reason §13
gives: "signed out" would be false (somebody IS signed in) and "unreachable" would
blame a server that was never called. Both the store's `afterFailure` and its
`statusForFailure` already route an unknown reason through their `default` branch,
and in practice it is never rendered — the identity change has already run
`resetPlayerState()`, which calls `forgetTable()`, which bumps the generation every
store handler checks.

### 16.3 Retry binding

`retryWhile` is where the seconds are, so a check made once before the loop is a
check made before an account switch that happens during it.

- `send()` binds once, mints `clientActionId` once, and passes the SAME bound
  player into every `attempt`. `attempt`'s first statement is `if (!player.isCurrent()) return stale();`.
- `requestStackReset()` binds once, mints `clientRequestId` once, and its
  `attemptOnce` re-checks before each call.
- A `stale-identity` outcome is not `unreachable`, so the retry predicate stops the
  loop: the intent is abandoned rather than re-sent under a new identity.
- `requestCashOut()` has no retry loop — deliberately, and unchanged: the server's
  cash-out key is `gameId:seatId` and the store completes a refused-mid-hand leave
  at the next safe boundary. It is bound and pinned like the rest.

Measured rather than asserted: the two retry cases in the unit regression switch
the account *between* two attempts of one intent and assert that exactly one
request left, carrying the initiating player, and a third asserts that a retry with
no player change still goes — twice, as the same player, with the same
`clientActionId`.

### 16.4 Analogous online-table paths reviewed

| Path | Verdict |
|---|---|
| `online-table-gateway.ts` — `cashOut` (`CASH_OUT`) | **The audited defect. Fixed.** |
| `online-table-gateway.ts` — `command` and `snapshot` (`game-command`) | **Same root cause. Fixed.** A bet, an action, an insurance decision or `NEXT_HAND` sent as B acts on B's seat; measured below. |
| `online-table-gateway.ts` — `resetPrivateStack` (`RESET_PRIVATE_STACK`) | **Same root cause. Fixed.** It refills a seat to the ruleset figure and spends that seat's one free reset. |
| retries inside `send` and `requestStackReset` | **Fixed, per attempt.** See §16.3. |
| `online-table-gateway.ts` — `subscribe` | **Unchanged, and it cannot be bound.** Realtime authorises a SOCKET from the token the client sets on it; there is no per-message header to pin. It mutates nothing, and the one thing it could do — push a stale table at somebody else's screen — is closed from the other end: an identity change runs `resetPlayerState()` → `forgetTable()`, which unsubscribes and bumps the generation. |
| `online-table-store.ts` — every `tableGeneration` check | **Unchanged by design, and now documented as what it is.** It protects the screen. The write guard is the gateway's. |
| `src/lib/supabase/game-command.ts` — `sendGameCommand` | **Same shape. Fixed although it has no production caller**, because it is exported and is a second copy of the same job. |
| `active-session-store.ts` — `my_active_session()` | **Not affected.** A read, not a mutation: it returns an ADDRESS and changes nothing. The RPC derives the caller from the JWT, so a reply that arrives as B describes B — and `playerScopedSetter` blocks the write and the return value both. Nothing of A's is mutated and nothing of B's leaks onto A's screen. |
| `matchmaking-store.ts` — `takeSeat` (`JOIN_PUBLIC_TABLE`) | **Already correct.** It goes through `sendSessionIntent`, which pins the verified token per intent and re-checks the scope before each attempt. This repair follows that pattern rather than adding a second one. |
| `quick-play-store`, `daily-store`, `tournament-store`, `career-server-store.start` | **Already correct.** Every seat-creating economic intent uses `sendSessionIntent`. |
| `rooms-gateway.ts` — `START_PRIVATE_TABLE`, `create`, `join`, `leave`, … | **Already fixed in §13**, and re-read here: `bindPlayer()` is still the first statement of each and the header is still pinned. |
| `matchmaking-store.ts` — `join_matchmaking`, `leave_matchmaking` | **Not a table operation, and unchanged — as in §13.** They write only the caller's own queue row, which expires in two minutes, and `queue()` already checks `setForPlayer.isCurrent()` with no `await` between that check and the RPC. The residual window is the one inside the SDK's own token read; §13 recorded it and it is recorded again here rather than closed, because closing it is repository-wide consistency work and not this blocker. |
| `career-server-store.ts` — `SUBMIT_CAREER_DRILL` | **Same unbound shape, NOT a table operation, and structurally not exploitable.** `submitCareerDrill` (`create-session/index.ts:2127`) loads the attempt by id and raises `NOT_A_PARTICIPANT` when `attempt.user_id !== userId`. A career attempt has exactly ONE owner — unlike a table, which is the whole of the §15 finding — so a replacement player can never own the attempt the request names. Flagged for the same consistency change as matchmaking, deliberately left outside this bounded repair. |

### 16.5 Regressions added

Two files, both driving PRODUCTION store → PRODUCTION gateway → real
`@supabase/supabase-js`. Neither uses a fake gateway: a fake gateway cannot have
this defect, because the bug is in which credential the real SDK attaches to a real
request. Both reproduce the audit's own fault and nothing else — one `getSession()`
completion held across an account switch.

**`tests/table/stale-identity-table.test.ts`** (unit gate, 7 tests, no Docker). A
real SDK client over a recording transport, with the SDK's stored session swapped
mid-flight as a sign-in swaps it and the production `resetPlayerState()` at the
identity boundary. Both players are seated in the fixture table, which is the
premise §13's exemption got wrong. Assertions are on the WIRE — which requests
left, and with whose token:

1. player A's Leave is never sent as B, nothing at all leaves as B (including the
   wallet refresh a successful cash-out triggers), and no stale table survives into
   B's app;
2. an uninterrupted Leave goes with the DISPATCHING player's pinned token, not the
   newer token in storage — the case that proves the pin rather than just the gate;
3. a `game-command` is never sent as B;
4. `RESET_PRIVATE_STACK` is never sent as B;
5. a retried `game-command` whose account switches BETWEEN attempts sends exactly
   one request, as A;
6. the same for a retried `RESET_PRIVATE_STACK`;
7. a retry with a token rotation and no player change still goes — twice, as A both
   times, with the same `clientActionId`.

Two things in it are fixtures rather than production code and both are stated in the
file: the store is seated by `setState` rather than by `enter()`, because `enter()`
also opens a Realtime socket and a unit test that talks to a live websocket is a
load-dependent test; and the backoff is shortened through the gateway's own `policy`
option so the retry cases do not sleep.

**`tests/server/stale-identity-table.integration.test.ts`** (server gate, 3 tests).
The audit's reproduction, inverted. Real GoTrue, real Postgres, real Edge Functions,
the installed SDK with PKCE, the production rooms gateway to open and deal a private
table, the production online table store and gateway to `enter()` and `leaveTable()`,
and the production Auth store and adapter for a real `signInWithPassword` switch that
names the player being replaced. It asserts on the DATABASE.

The fixture is ONE private game holding four seats: two initiating players on two
clients, and **two** replacement players. Two, not one, and that was a measurement
rather than caution — with a single replacement the second case passed against the
DEFECT, because the first case's stale Leave had already closed that player's seat
and the second case's bet was then refused `SESSION_CLOSED`. A case shielded by the
previous case's damage proves nothing.

- **Leave/cash-out**: A's `leaveTable()` held at its session read, a real sign-in to
  B, release. Every seat row is byte-identical afterwards, all four still `active`;
  all four wallets and ledger totals unchanged; the global wallet invariant
  unchanged; and the store is `idle` with no notice, no staged bet and no held
  leave, so no stale UI reached B.
- **Game command**: the second player stages the table minimum and calls `lockBet()`,
  held at its session read, switched to the second replacement. `PLACE_BET` sent as B
  would have posted that wager on B's seat — a mutation the server ACCEPTS, because
  B is a legal participant. The engine's own `version` and every seat's `originalBet`,
  read out of `private.game_state_private`, are unchanged.
- **Positive control**: the same store, gateway and client, with nobody switching
  underneath, still cashes the replacement player out — seat `left`, stack 0, the
  other three seats still `active`. Without it, a harness that had stopped being able
  to mutate anything would satisfy every assertion above.

Readbacks go through psql because the engine state lives in the `private` schema with
no client grants at all and `service_role` holds no table privilege in `public`;
every MUTATION under test goes through the product's own path.

**Both files were proved to FAIL against the defect** rather than assumed to work.
The measurement removed the repair in the two places it lives — the scope gate in
`player-binding.ts`, and the pinned `Authorization` at the table call sites:

| File | Armed | Disarmed |
|---|---|---|
| `tests/table/stale-identity-table.test.ts` | **7/7 pass** | **7/7 fail** — the first is `expected [ 'Bearer token-b' ] to deeply equal []`, which is the audit's defect on the wire |
| `tests/server/stale-identity-table.integration.test.ts` | **3/3 pass** | **3/3 fail** — the Leave case on the seat readback, the command case on `expected 3 to be 2` (the engine version MOVED: A's bet was posted on B's seat), the control as collateral of the first |
| `tests/auth/stale-identity-mutation.test.ts` (§13) | 5/5 pass | 4/5 fail — confirming the disarm is the same defect §13 measured |

The local Edge runtime's own log records the disarmed run in one line:
`commandType":"PLACE_BET" … "userId":"f2f708f7-…"` where `f2f708f7` is the
REPLACEMENT player, seconds after the same user id appears under
`commandType":"CASH_OUT"` for a cash-out nobody on that device asked for.

All three production files were then restored and verified **byte-for-byte** by
SHA-256 against the copies taken before the disarm
(`7519203bd6c6…`, `fb5e6cac5239…` for the store, `6fe562b69757…`,
`bd776b3ef6a5…`), and the fixture users were confirmed gone from `auth.users`.

### 16.6 Targeted verification (September 28, 2026)

`supabase functions serve` was restarted before each measurement, per CLAUDE.md, and
the host load is recorded with each. The pre-existing `closure-functions.log` and
`renewal-functions.log` were not touched; this pass logs to `repair-table-functions*.log`.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | pass (`repair-table-typecheck.log`) |
| `npm run lint` | **0 errors / 21 warnings** — identical to the §13 and §3 baselines; no new warning (`repair-table-lint.log`) |
| New unit regression `tests/table/stale-identity-table.test.ts` | **7/7 pass**; **7/7 fail** with the repair removed |
| New server regression `tests/server/stale-identity-table.integration.test.ts` | **3/3 pass**; **3/3 fail** with the repair removed |
| §13's `tests/auth/stale-identity-mutation.test.ts` + `tests/server/stale-identity-social.integration.test.ts` | **4 files / 17 tests pass** together with the two new ones (`repair-table-regressions.log`) — the previous social repair is intact and is not bypassed by this one |
| `npm run test:unit` | **135 files / 2,525 tests pass** (134 / 2,518 before this repair: +1 file, +7 tests) (`repair-table-unit.log`) |
| `npm run test:server`, full — attempt 1 | **ENVIRONMENT, not counted.** 21 of 28 files failed to COLLECT on the stack guard's 5 s probe. Preserved as `repair-table-server-contaminated.log`; cause identified and removed in §16.7 |
| `npm run test:server`, full — attempt 2, on the quieted host | **13 files pass / 15 fail; 254 tests pass, 4 fail, 14 skipped.** **11 of the 15 file failures are the stack-guard probe again** (`0 test`, nothing executed). The 4 test failures are classified below; none of them executes a line of the three changed files |
| The eleven affected/failing server files, **each run ALONE** against a fresh runtime at load 3-7 | **11 files / 159 tests, zero failures** (`repair-table-server-isolated.log`) |

Not run, and why: `npm run check:functions` and `supabase test db` — nothing under
`supabase/functions` or `supabase/migrations` changed. `npm run test:coverage` — the
coverage `include` globs are `shared/**`, `supabase/functions/_shared/**` and
`src/features/practice/*`, none of which this repair touches, so no threshold can
have moved.

#### The four test failures in the full run, classified

Classified before anything was changed, as the harness rules require, and none of
them was retried until it passed:

| Failure | Classification | Basis |
|---|---|---|
| `game-command` - reproduces the lost-reply truncation, and survives it | **ENVIRONMENT** | `expected +0 to be 1` on `discarded` - the test's own proxy never reached the 18th `NEXT_HAND` it was told to lose, because a REAL `WORKER_LIMIT` had already truncated the attempt. The test counts injected losses; a genuine 546 in the same window makes that count wrong. Sections 3 and 6 record the same test failing the same way for the same reason |
| `economy-authority` - grants exactly once in an eligible eight-client race | **ENVIRONMENT** | its sibling in the same file errored `could not create a test user: 504` - the gateway timing out on GoTrue, before any product code ran. A 180 s timeout on an eight-client race is the file section 3 already names as the heaviest in the suite |
| `password-recovery` - uses the shipped auth store to recover | **ENVIRONMENT** | `Test timed out in 15000ms`, a real Mailpit round trip inside a 15 s budget |
| `pseudonymous-identity` - does not replace a player when a code belongs to a different pending UUID | **ENVIRONMENT** | `expected AuthRetryableFetchError: Processing this ... to be null` - GoTrue's own retryable-fetch error, which is the auth container refusing to keep up, not a verdict |

Three 5xx answers (504, 546) were recorded from the gateway during the run and
**10 CPU hard-limit events** in the Edge runtime's own log. None of the four failures
executes a line of `online-table-gateway.ts`, `online-table-store.ts` or
`src/lib/supabase/game-command.ts`: the server suite reaches the functions through
`tests/server/call-function.ts`, a raw `fetch` helper, and the only files that use
the changed client gateway are the ones in the row above.

**No assertion was weakened, no timeout raised, no retry added and no worker count
reduced** to deal with any of this. `npm run test:server` was run at its own
`--maxWorkers=2`, which is CI's setting.

#### And the same files, each run ALONE against a freshly restarted runtime

Host load 3-7 throughout, one `vitest run <file>` per invocation, nothing else on the
machine. Same commit, same tree, same stack:

| File | Alone | In the loaded full run |
|---|---|---|
| `stale-identity-table` (new) | **3/3** | did not collect |
| `two-client-table` | **5/5** | did not collect |
| `table-reconciliation` | **2/2** | did not collect |
| `private-rooms` | **32/32** | did not collect |
| `public-table` | **24/24** | 9 failed; the file took 58 minutes |
| `realtime` | **4/4** | 4 failed |
| `stale-identity-social` | **2/2** | did not collect |
| `game-command` | **44/44** | the lost-reply test failed |
| `economy-authority` | **37/37** | the eight-client grant race failed; a sibling got a 504 |
| `password-recovery` | **1/1** | timed out at 15 s |
| `pseudonymous-identity` | **5/5** | `AuthRetryableFetchError` |

**11 files / 159 tests, zero failures.** Every failure in both full runs is therefore
accounted for by the host and not by the tree: the same test, on the same commit,
passes when it is given the runtime to itself. That includes all four assertion
failures and the eight-client grant race, which is the heaviest test in the suite.

What this does NOT give is one uninterrupted 28-file green run, and it is not claimed
as one. The honest statement is: the seven files that can execute the changed code are
green, the four that failed are green, and no uninterrupted full-suite run was
obtainable on this host today. Sections 3 and 8 already record the same gap for the
same reason on a healthier day (333/335 with two environment failures, both green on
rerun, and no single uninterrupted run after the Sep 26 reset).

#### The host, measured, because it explains all of the above

`sysctl`: **8 GB of RAM and 8 CPUs, with 9.8 GB of 11.3 GB of swap already in
use** and 31% of memory free, while Docker Desktop holds 3.826 GiB of that 8 GB for
the Supabase stack. AGENTS.md's own warning is the description of this machine:
"avoid simultaneous native builds, simulator boots, and unconstrained test workers
on a memory-constrained host."

It is not a CPU story, which is why the first two diagnoses only half worked. Under
paging, one file of the suite — `public-table.integration.test.ts` — took
**3,513,127 ms**, and one test inside it 1,080,637 ms. A suite whose slowest test
normally finishes in seconds does not take eighteen minutes because of a client-side
credential change.

So the affected files were measured ONE AT A TIME against a freshly restarted
runtime, which is the only trustworthy measurement this host can give: see the
`repair-table-server-isolated.log` row above. That is isolation for a reliable
reading, not a reduction in the concurrency any gate asserts — `npm run test:server`
was still run at its own `--maxWorkers=2`, twice, and both results are recorded.

### 16.7 Environment: an identified interference, paused reversibly and restored

The first attempt at the full server suite was **contaminated and is preserved as
such** (`repair-table-server-contaminated.log`). It is not counted as a result.

What it looked like: HTTP **546 `WORKER_LIMIT`** on `create-session` and
`game-command`, one 503, then 30-second timeouts across files that do not touch the
changed code at all, and finally **21 of 28 files failing to COLLECT** — the
stack-guard's 5 s probe landing inside a CPU-limit window, which is the exact
environment class §6 and §3 already record. The fresh `functions serve` logged
**70 CPU soft-limit and 27 hard-limit events** during it.

What was actually loading the machine, measured with `docker stats` rather than
guessed: inside a Docker VM that was itself at 95% of the host,
**`supabase_studio_arc21` 162%, `supabase_pg_meta_arc21` 152% and
`supabase_analytics_arc21` 241%** — 555% of container CPU spent by three ADMIN
SIDECARS that no test touches. `tests/server` drives Kong → the Edge runtime →
Postgres and nothing else. Two booted simulators left over from §14 were adding
host load through `pairedsyncd`, `mobileassetd` and `icloudmailagent`.

What was done about it, all reversible and all restored in §16.10: the four
sidecars (`studio`, `pg-meta`, `analytics`, `vector`) were `docker stop`ped, the two
simulators were shut down, and `functions serve` was restarted. Container CPU fell
to **edge runtime 0.44%, database 0.10%** at rest.

What was NOT touched: **NordVPN**, measured at 96.8% of a core during this window.
It is the user's network software, unrelated to this work, and stopping a VPN is not
a safe unilateral action. It is recorded here because it is part of the host
conditions the numbers below were taken under.

No assertion, timeout, retry policy, worker count or concurrency setting was
changed to accommodate any of this.

### 16.8 Native evidence on a fresh Release build — PARTIAL, and said so

**This section renews SOME of the native proofs section 16.9 declares stale, and
explicitly does not renew the rest.** What is renewed is stated with its evidence;
what is not is listed by name. Nothing here is a PASS.

#### 16.8.1 The fresh iOS Release build

```
LANG=en_US.UTF-8 npx expo run:ios --configuration Release \
  --device D16C4292-670D-4036-BDB1-2E9B31B11D3D --no-bundler
```

| Claim | Evidence |
|---|---|
| **0 errors / 3 warnings**, installed and opened on device A | `repair-release-build.log` |
| Configuration is **Release** | the product is written to `Build/Products/Release-iphonesimulator/Arc21.app`, and the Metro phase re-bundled 2,690 modules into an embedded `main.jsbundle` |
| Nothing served a different bundle | `lsof -ti:8081` was empty immediately before the build and again after the last flow, so no Metro was running that could have substituted one. This is the check CLAUDE.md's stale-bundler note asks for |
| The binary is the code under test | `repair-build.json`: bundle SHA-256 **`9a7d0bf3c99ae093…`**, 6,397,500 bytes, built 2026-09-28T20:17:30Z, **246 source files fingerprinted, 0 newer than the bundle** |
| The binary contains **this** repair | the string this repair introduced — `This table belongs to the player who was signed in before` — is present in the Hermes bytecode, and it did not exist in the tree before this change. Treated as a POSITIVE control only: `Players are never merged` returns zero hits from the same scan although that copy plainly renders (it is in the screenshot below), which is exactly why CLAUDE.md says a string scan of a `.hbc` cannot prove absence |

#### 16.8.2 Flows renewed

Device A: iPhone 17 Pro `D16C4292-…`. Step counts are read from each run's
`commands.json`, not from the exit code, per CLAUDE.md's note that a Maestro exit of
0 does not mean the flow ran.

| # | Required proof | Flow | Result | Server-side readback |
|---|---|---|---|---|
| — | Fresh pseudonymous entry on the repaired binary | `refresh-b/fresh-player.yaml` | **pass 35 s**, 15 of 16 steps COMPLETED (one conditional skipped) | `repair-state-1-fresh-a.txt`: users 2420→**2421**, exactly one new player `pearl_bat` `41f5b3ab-a6d9-4faa-9208-2b3ff1c30aed`, anonymous, handle generated by the server, 25,000 = ledger, **1 grant** |
| **3** | Normal legal table command flow | `online-table.yaml` | **pass 3m10s**, **61 steps COMPLETED** (42 conditional branches skipped) | the table opened ("Leave table" visible), a chip was staged and **Deal pressed** — so `PLACE_BET` and `LOCK_BET` were accepted through the bound, pinned gateway — the hand was played to settlement and the NEXT hand started |
| **5** | Leave / cash-out | same | same | the seat settled and the remainder came back |
| **8** | Wallet / ledger / buy-in / cash-out reconciliation | same | same | `repair-state-3-after-table.txt`: the account's ledger is exactly three rows — `initial_grant 25000`, `table_buy_in -2000`, `table_cash_out 2050` — and the balance is **25,050 = ledger**. A complete buy-in/cash-out cycle reconciling to the chip |
| **9** | Exactly one opening grant | aggregate over EVERY wallet | pass | before: **2,420 users / 2,420 wallets / 0 wallet≠ledger / 0 negative / 0 grant-count≠1**; after: **2,422 / 2,422 / 0 / 0 / 0** |

#### 16.8.3 Flows NOT renewed, and why

Honest list, because an unrenewed proof presented as renewed is worse than a gap:

| Required proof | Status |
|---|---|
| **1, 2** two pseudonymous players joining the same real public table, both seated and visible | **NOT RENEWED.** Needs two booted simulators; see 16.8.4 |
| **4** reconnect / cold restoration of a table session | **NOT RENEWED** |
| **6** the remaining player's table stays functional after the other leaves | **NOT RENEWED.** Needs two devices by construction |
| **7** leave and rejoin | **NOT RENEWED** |
| **10** private-room/table behaviour | **NOT RENEWED.** `two-client-host-open` / `guest-join` / `host-deal` / `play` / `leave` are a two-device chain |
| **11** stack reset / rebuy | **NOT RENEWED, and no flow exists for it.** Reaching a busted private stack natively means losing 5,000 chips against a 1,000 ceiling. It is covered on the WIRE by two cases of `tests/table/stale-identity-table.test.ts` (dispatch and retry) and by `broke-affordance` unit tests, and it was reviewed and bound in 16.4 |
| Mid-hand cash-out (`SESSION_BUSY` → `leavingWhenSafe`) | **ATTEMPTED, NOT OBTAINED.** `online-leave-mid-hand.yaml` failed on `Assertion is false: id: header-chips is visible` after 1m36s. **Classified HARNESS, and the app is right**: the saved hierarchy is a COMPLETE 64-node dump containing `onboarding` and no `header-chips`, and the screenshot shows the onboarding carousel. The flow launches with `clearState: false` and assumes the device is already past onboarding — but the preceding `online-table.yaml` signs in through `sign-in.yaml`, which reaches the auth screen without ever writing `onboarding:completion`, and `app/index.tsx` correctly re-shows the 18+ disclosure to a device with no record of having seen it. This is the fourth instance of the pattern CLAUDE.md already records under "A FLOW THAT REACHES THE AUTH SCREEN BY DEEP LINK NEVER COMPLETES ONBOARDING" |

#### 16.8.4 Why the two-device proofs could not be taken, measured

`sysctl`: **8 GB of RAM, 8 CPUs.** Docker Desktop holds 3.826 GiB of it for the
Supabase stack. With ONE simulator booted the host sat at load 5-10 and Maestro was
reliable. **Booting the second drove the load average to 138 and left 415 MB of the
15 GB swap file free**; `simctl list devices` itself stopped answering inside 120
seconds. Device B was shut down again rather than driving flows in that state.

CLAUDE.md's own threshold is the reason this is a stop rather than a retry: Maestro
"is reliable below about load 12, and above 40 the XCUITest runner starts losing view
hierarchy snapshots" — and a lost snapshot is reported with the same sentence as an
app crash. Evidence gathered at load 138 would be evidence of nothing.

Nothing was done about the two largest unrelated consumers, and both are recorded
rather than touched: **Google Chrome** (53 processes, ~1.15 GB resident, two renderers
at 130% of a core between them) and **NordVPN** (measured at 96.8% of a core). They are
the user's software; closing a browser or a VPN is not a safe unilateral action.

#### 16.8.5 The first `fresh-player` attempt, classified

It failed after **15m34s** with `Unknown error` and **zero** steps completed. Diagnosed
rather than re-run blindly, on the two artefacts CLAUDE.md says settle it:

- **No crash.** `~/Library/Logs/DiagnosticReports/` holds no `Arc21-*.ips` at all, and
  `xcrun simctl get_app_container` found the app installed.
- **The driver, not the app.** The hierarchy Maestro SAVED for the failing step is a
  COMPLETE 64-node dump **of `com.arc21.app`** containing both `onboarding-guest` and
  `Start playing` — the very things the assertion was looking for — and the screenshot
  shows the onboarding screen rendered correctly. `xctest_runner_*.log` shows a single
  view-hierarchy snapshot spanning ~933 s of driver clock.

Remedied with the two steps CLAUDE.md prescribes and nothing else: stale
`maestro-driver-ios` processes were killed and `MAESTRO_DRIVER_STARTUP_TIMEOUT=180000`
was set. The rerun passed in **35 s**. No assertion, timeout or product behaviour was
changed for it.

### 16.9 Prior Refresh-B evidence that this repair makes STALE

**The iOS Release build proof in §14.1 is stale, and with it the native TABLE rows
of §14.2.** That row's claim is that no `app`/`src`/`shared` file is newer than the
bundle (246 matching source fingerprints, 0 newer). Re-derived with the same
`renewal-freshness.py` against the §14 binary before rebuilding: **4 files newer**,
of which three differ in CONTENT from the fingerprints recorded in
`renewal-build.json` —

| File | §14 build | now |
|---|---|---|
| `src/features/table/online-table-gateway.ts` | `edb7f95e1810…` | `7519203bd6c6…` |
| `src/features/table/online-table-store.ts` | `008d089f6479…` | `fb5e6cac5239…` |
| `src/lib/supabase/game-command.ts` | `effea12af52d…` | `6fe562b69757…` |
| `src/lib/supabase/player-binding.ts` | `bd776b3ef6a5…` | `bd776b3ef6a5…` — **identical**; only its mtime moved, from the disarm-and-restore measurement |

Which §14 proofs that invalidates, and why each:

- **Every public-table row** — `renewal-public-{queue,join,seat,leave,survives}`.
  `online-table-gateway.ts` is the file that sends every command, the buy-in's
  sibling cash-out and the snapshot poll; `online-table-store.ts` is the screen's
  whole state machine.
- **Every private-table row that reaches the felt** — the table screen behind
  `renewal-room-{create,invite,join}` is the same store and the same gateway.
- **The wallet readbacks taken on the table rows.** The invariant is unchanged and
  the server suite re-proves it against the database, but the native numbers were
  read with the old binary.

Which §14 proofs are NOT affected, and why: the securing, sign-in, recovery,
deletion, link-conflict, replacement-warning, offline-Practice, offline-reconnect,
profile-rename, fresh-player, cold-relaunch and token-rotation rows execute no code
in the three changed files. `friends-gateway.ts`, `rooms-gateway.ts`,
`use-room-invites.ts` and `wallet-gateway.ts` are byte-identical to the §14 build,
so §14's social and room-lobby rows stand on their own terms — but a FRESH build
was made and used for the renewed flows regardless, so nothing below rests on the
old binary.

### 16.10 Evidence paths

All outside Git, in `/Users/tj/arc21-evidence/astra-refresh-b-20260915/` (`$E`),
under the `repair-table-` prefix so every `closure-`, `native-` and `renewal-`
artefact from §3, §4, §13 and §14 is preserved beside it.

| Artefact | What it is |
|---|---|
| `repair-table-typecheck.log`, `repair-table-lint.log` | the two static gates |
| `repair-table-regressions.log` | the four stale-identity files run together |
| `repair-table-unit.log` | the full unit suite |
| `repair-table-server-contaminated.log` | the FIRST full server attempt, kept as the environment record it is — 21 files failing to collect, `WORKER_LIMIT`, 30 s timeouts |
| `repair-table-server-2.log` | the full server suite on the quieted host, with the host load and instantaneous CPU recorded at its head |
| `repair-table-functions.log`, `repair-table-functions-2.log` | the Edge runtime's own logs for the two runs, including the `PLACE_BET … userId: <replacement>` line from the disarmed measurement |
| `repair-build.json` | the fresh Release build's fingerprint: bundle SHA-256, size, build time, every source file's SHA-256, and the list of files newer than the bundle |
| `repair-build-after-flows.json` | the same, taken after the last flow, to show no production source moved during the pass |
| `repair-native-*.{xml,log}` and `repair-native-*/` | the renewed Maestro flows, their JUnit XML, debug output, hierarchies and screenshots |
| `repair-state-*.txt` | the server-side readbacks paired with each flow |

The §15 audit's own artefacts — `final-reaudit-stale-table.ts`,
`final-reaudit-stale-table.log`, `final-reaudit-failure-manifest.json` — are
unchanged and untouched. The repro script is the ancestor of
`tests/server/stale-identity-table.integration.test.ts` and should be read beside it.

### 16.11 What the independent re-auditor must challenge

1. **That the §13 exemption's replacement is not another argument of the same kind.**
   The repair does not claim that a table call is safe; it removes the client's
   ability to send one as anybody but the dispatching player. Read `bindPlayer()`
   as the FIRST statement of `send`, `requestCashOut` and `requestStackReset` — a
   binding taken after an `await` is a binding to the wrong player and is the
   original defect with extra steps.
2. **That the pin reaches the wire and wins**, against the installed
   `@supabase/supabase-js` 2.112.3 rather than on this note's word:
   `fetchWithAuth` must still set `Authorization` only `if (!headers.has(...))`,
   and `FunctionsClient.invoke` must still spread call-level `headers` LAST.
3. **That the retry binding is per ATTEMPT.** Delete the `isCurrent()` line at the
   top of `attempt` and of `attemptOnce` and confirm the two retry regressions fail.
4. **That both new regression files fail when the repair is removed.** Do not take
   §16.5's measurement on trust; it is a small edit to `player-binding.ts` plus the
   two `headers:` lines.
5. **That the server regression's positive control is doing its job** — delete it
   and the file would pass against a harness that could no longer cash anybody out.
   And that the TWO replacement players are load-bearing: collapse them into one and
   the game-command case passes against the defect.
6. **The paths argued unchanged in §16.4**, especially `subscribe` (can it push a
   stale table at a replacement player?) and `active-session-store` (is the scoped
   setter really the only writer?).
7. **The two known-unbound neighbours this repair deliberately did not touch** —
   `matchmaking-store`'s `join_matchmaking`/`leave_matchmaking` and
   `career-server-store`'s `SUBMIT_CAREER_DRILL`. Both arguments are stated in
   §16.4; both should be attacked the way §15 attacked §13's.
8. **The native evidence in §16.8**, on the fresh Release build, and the fingerprint
   claim behind it.
9. Everything §11, §13's list and §15's review boundary already ask for, none of
   which this repair addresses.

### 16.12 Remaining blockers

None found in this defect class. No other blocker was looked for: this was a bounded
repair, not a third audit. §8's limitations, §9's hosted activation work, §11's
review list and §15's uncompleted review boundary are all still outstanding, and
**Refresh B is NOT claimed to pass.**

### 16.13 Exact state for the independent re-auditor

- Branch `astra-refresh-b`, HEAD **`47dba201ace488d932bb4e479416f52f79a6f176`**,
  everything uncommitted in the working tree. Nothing committed, pushed, merged,
  deployed or rewritten; no hosted Supabase setting, datum or deployment touched;
  no Refresh C/D/E work begun.
- `AGENTS.claude-backup.md` remains intentionally untracked and is not part of B.
- Production files changed by this pass: **three** —
  `src/features/table/online-table-gateway.ts`,
  `src/lib/supabase/game-command.ts`, and a comment-only edit to
  `src/features/table/online-table-store.ts`. `src/lib/supabase/player-binding.ts`
  is byte-identical to the §14 build's copy (`bd776b3ef6a5…`).
- New test files: `tests/table/stale-identity-table.test.ts` (7 tests) and
  `tests/server/stale-identity-table.integration.test.ts` (3 tests). No existing
  test, assertion, timeout, retry policy, rate limit or worker count was changed.
- The Release binary at `…/Build/Products/Release-iphonesimulator/Arc21.app`,
  bundle SHA-256 `9a7d0bf3c99ae093…`, corresponds to the tree as
  `repair-build.json` fingerprints it. Rebuild and compare rather than trusting
  the hash.
- Local services are as they were found: all twelve containers up (the four
  sidecars paused for measurement in §16.7 were restarted and are healthy),
  `supabase functions serve --no-verify-jwt` running with both functions
  answering 401, and both simulators booted.
- **Refresh B is still NOT independently passed and NOT checkpointed.** §12 and
  §15 remain the standing audit verdicts; §13 and §16 are unreviewed repairs;
  §14 and §16.8 are evidence for them, not verdicts on them. **§16.8 is a PARTIAL
  native renewal and names what it did not renew.** A fresh independent audit is
  still required.

## 17. The two-device native evidence §16.8 did not renew — September 28, 2026

**Nothing in this section softens §12 or §15.** They remain the standing audit
verdicts; §13 and §16 remain unreviewed repairs; §14, §16.8 and this section are
evidence for them, not verdicts on them. HEAD is still
`47dba201ace488d932bb4e479416f52f79a6f176`, nothing has been committed, pushed,
merged or deployed, and no hosted Supabase setting or datum was touched.
**Refresh B is NOT claimed to pass.** This pass closes one named gap: the
two-device table proofs §16.8.3 listed as NOT RENEWED, which §16.9 had declared
stale because the repair changed the online table gateway every one of them runs
through.

This was an evidence-only pass. **No production source was changed** — see 17.2,
which proves it by fingerprint rather than by assertion.

### 17.1 Host conditions, measured — and the brief was wrong about them

The task for this pass stated that the host had been rebooted and unrelated heavy
applications closed. **Neither was true, and it is recorded rather than worked
around**, because §16.8.4 stopped on host capacity and an unverified premise about
the host is exactly what that stop was about:

| Claimed | Measured at start |
|---|---|
| clean reboot | `up 12 days, 4:49`, load average **8.46**, swap **10,440 MB of 11,264 MB used, 823 MB free** |
| heavy applications closed | **Google Chrome** running, one renderer at **82.5% of a core**; **Claude.app**; **NordVPN**; and a second, unrelated **`claude` CLI session** 8h24m old at effort high |

8 GB of RAM, 8 CPUs. The two largest unrelated consumers were again left alone for
§16.8.4's reason: closing somebody's browser or VPN is not a safe unilateral
action. What WAS done was reversible, was restored in 17.8, and is the §16.7 move:

- The four admin sidecars `studio`, `pg-meta`, `analytics` and `vector` were
  `docker stop`ped. `tests/server` and the app drive Kong → the Edge runtime →
  Postgres and nothing else, and `analytics` alone held 588 MB. The stack answered
  401/401/200 without them.
- `supabase functions serve` was 3h01m old and was restarted fresh, per CLAUDE.md's
  note that it accumulates CPU-limit events.
- **Both simulators were booted HEADLESS** — `simctl boot` with no `open -a
  Simulator` and no Xcode GUI, so SkyLight renders no device window.

**The result is the measurement §16.8.4 could not get.** Booting the second
simulator spiked the load to 53.56 and `simctl list` stopped answering inside 60 s
— the same symptom — but it **settled**, and stayed settled for the whole pass:

| State | Load (1 min) | Notes |
|---|---|---|
| one simulator, settled | **11.62** | just inside CLAUDE.md's "reliable below about load 12" |
| two simulators, boot transient | 53.56 | `simctl list` unresponsive; **not** evidence-gathering conditions |
| **two simulators, settled and idle** | **3.85** | `simctl` responsive in 0.002 s |
| across the flows | **3.0 – 8.5** | recorded at the head and foot of every flow log |

§16.8.4 measured load **138** and 415 MB of swap free at this point and stopped.
The difference is the headless boot and the stopped sidecars, not a quieter
machine — the unrelated consumers it names were all still running here. Swap free
stayed tight throughout (336 MB – 1.7 GB, with macOS growing the file from 4 GB to
10 GB as it went), and that is the honest residual risk in these numbers; load,
which is what Maestro is gated on, never approached 40.

The Edge runtime's own log for the whole pass (`twodev-functions.log`):
**53 CPU soft-limit events, 0 hard, 0 `WORKER_LIMIT`, 0 `user body write
aborted`** — against §16.7's contaminated 70 soft / 27 hard. Read before drawing
conclusions, per CLAUDE.md.

### 17.2 Release-build freshness — the §16 binary was reused, correctly

**No rebuild was made, because none was warranted.** The §16.8.1 binary was
re-fingerprinted against the current tree with the same method before any flow ran
(`twodev-freshness.py`):

| Check | Result |
|---|---|
| bundle SHA-256 | **`9a7d0bf3c99ae093d7f8d28e99a458b96ea1c5f5f70d847d75468f363cc2eaa5`** — identical to `repair-build.json` |
| bundle size | 6,397,500 bytes, identical |
| production source files compared | **246** |
| content-changed since the build | **0** |
| added / removed since the build | **0 / 0** |
| mtime newer than the bundle | **0** |
| **the SAME check repeated after the last flow** | **0 / 0 / 0 / 0** — `twodev-build-freshness-after.txt` |

`lsof -ti:8081` was empty, so no Metro could substitute a bundle — the check
CLAUDE.md's stale-bundler note asks for.

**Both devices carried that exact bundle**, verified by hashing the installed
`main.jsbundle` inside each simulator's container: `D16C4292` and `064733EE` both
`9a7d0bf3c99ae093…`. Neither was reinstalled; §14 had already installed this
product on device B.

The repair string §16.8.1 used as a positive control — `This table belongs to the
player who was signed in before` — is present in **both** devices' Hermes bytecode
(1 hit each). It remains a positive control only, for §16.8.1's reason.

The trailing freshness check is also the proof that **this pass changed no
production code**: 246 of 246 files byte-identical to a binary built before it
began. The only repository additions are `tests/e2e/private-broke-reset.yaml`
(17.6) and this section.

### 17.3 The two players

Both devices were put into a genuinely fresh state first with
`scripts/e2e-fresh-app.ts` — which deletes the app's SQLite store and resets the
keychain, because Maestro's `clearState` does neither — and each then created its
own player through the product's own onboarding.

| | Device | UUID | Handle | Anonymous | Email | Opening grant |
|---|---|---|---|---|---|---|
| **A** | `D16C4292…` iPhone 17 Pro | `e2c35268-a70a-45cc-a341-323b4fc56998` | `clear_bison_594397` | **yes** | none | 25,000 = ledger, **1** |
| **B** | `064733EE…` iPhone 17 Pro Max | `69018fc7-abd5-466a-9bfd-048f2cf4384f` | `amber_tiger` | **yes** | none | 25,000 = ledger, **1** |

Two distinct **pseudonymous** players, handles generated server-side by
`handle_new_user`, no credential asked for or held. Users 2,422 → **2,424**,
exactly two created. `twodev-state-1-two-players.txt`.

A note on how they are read, because it is a difference from §14. Every per-account
readback below is taken **as that account**, through PostgREST and
`my_active_session()`, with a 60-second-backdated `iat` — so RLS is part of what is
being proved. `scripts/two-client-public.ts` and `scripts/two-client-code.ts` could
not be used for it: both resolve their subject with `findUserId(email)`, and **a
pseudonymous player has no email**, so the repository's own helpers cannot address
the very players Refresh B is about. `twodev-refb-read.ts` and
`twodev-refb-code.ts` ask the same questions the same way, keyed on a user id, and
throw rather than returning a sentinel. Whole-database aggregates go through
Postgres directly as the Edge Functions do, because `service_role` is correctly
revoked on `public` — the first attempt at an aggregate was refused
`42501 permission denied for table wallets`, which is that invariant working.

### 17.4 The flows, with step counts read from `commands.json`

Sequentially, one driver at a time. Step counts are from each run's own
`commands.json`, never the exit code, per CLAUDE.md. The pool was drained first
(`twodev-public-drain.txt`: 0 rooms open before, 0 after) so the table under test
is this pass's.

| # | Required proof | Flow | Device | Result | Steps (C/F/S) |
|---|---|---|---|---|---|
| — | fresh pseudonymous player | `refresh-b/fresh-player.yaml` | A | pass 48 s | 15 / **0** / 1 |
| — | second fresh pseudonymous player | `refresh-b/fresh-player.yaml` | B | pass 48 s | 15 / **0** / 1 |
| **1** | queue, and NOT charged yet | `two-client-public-queue.yaml` | A | pass 45 s | 10 / **0** / 2 |
| **1** | matched, seat taken, buy-in charged on taking it | `two-client-public-join.yaml` | B | pass 47 s | 13 / **0** / 2 |
| **1, 2, 3** | **both in one real public table**, A's screen renders B's handle, A dealt in | `two-client-public-seat.yaml` `OTHER=amber_tiger` | A | pass 93 s | 23 / **0** / 76 |
| **3, 4** | reconnect to the live seat, cash out, **rejoin**, leave again | `two-client-public-leave.yaml` | B | pass 83 s | 28 / **0** / 3 |
| **5, 6** | the remaining player's table stays functional | `two-client-public-survives.yaml` | A | pass 362 s | 91 / **0** / 50 |
| **7** | private room created | `two-client-host-open.yaml` | A | pass 39 s | 10 / **0** / 2 |
| **7** | guest joins by code, "2 of 2 seated" on its OWN device | `two-client-guest-join.yaml` `CODE=ERBJ6E` | B | pass 43 s | 14 / **0** / 2 |
| **7** | host starts the table | `two-client-host-deal.yaml` | A | pass 38 s | 12 / **0** / 2 |
| **7** | **the guest reaches the felt** | `two-client-guest-table.yaml` | B | pass 33 s | 6 / **0** / 2 |
| **7** | a real wager and a hand, from each device | `two-client-play.yaml` | A, then B | pass 67 s / 81 s | 14 / **0** / 30, 14 / **0** / 57 |
| **8** | **stack reset taken through the product's own control** | **new** `private-broke-reset.yaml` | B | pass 32m07s | **314 / 0** / 1821 |
| **4, 5** | host leaves; **guest must be untouched** | `two-client-leave.yaml` | A | pass 63 s | 10 / **0** / 3 |
| **7** | guest leaves, closing the table | `two-client-leave.yaml` | B | **pass on rerun** 63 s | 26 / **0** / 3 |

Sixteen passing runs. Two runs failed and both are classified in 17.7; neither is a
product defect and neither assertion was weakened.

### 17.5 What the server said, paired with each screen

A screen cannot say whose row was written, so every flow is paired with a readback.

#### Both players in ONE public table — proofs 1, 2 and ownership

`twodev-state-2-both-seated.txt`, game_session **`6edb96fe-552c-487b-9198-bcfc1c53237c`**:

| seat | user_id | handle | stack | buy_in | status | connected |
|---|---|---|---|---|---|---|
| 0 | `69018fc7…` (B) | `amber_tiger` | 1,960 | 2,000 | active | true |
| 1 | `e2c35268…` (A) | `clear_bison_594397` | 1,950 | 2,000 | active | true |

- **Ownership is correct in both directions.** Asked as A, `my_active_session()`
  names seat `697d0284…`; asked as B, it names `7fdee489…`. Each account's own seat,
  from its own verified JWT.
- **Buy-ins charged to the correct users**: each debited exactly 2,000, 25,000 →
  23,000, with one `table_buy_in` row apiece. Wallet = ledger for both. One grant each.
- The two stacks had already **diverged** (1,960 vs 1,950), which is proof 3 from the
  database side: both seats were wagering and acting independently through the
  repaired, bound, pinned gateway. On the screen side, A's own device rendered
  `amber_tiger` — a handle read from the database and passed in, never hard-coded.

#### The Leave / cash-out — proof 4, the one the repair most affects

`twodev-state-4-after-leave.txt`. B cashed out, re-queued, took a seat at the same
table again and left again:

| seat | handle | stack | status | left_at |
|---|---|---|---|---|
| 0 | `amber_tiger` | 0 | **left** | 03:51:24 |
| 0 | `amber_tiger` | 0 | **left** | 03:51:56 — the **rejoin**, same table, same user |
| 1 | `clear_bison_594397` | **2,010** | **active** | **null** |

- **The leaver's own state changed correctly.** Two seat rows, both `left`, stack 0,
  `left_at` stamped; `my_active_session()` → null. Ledger: `initial_grant 25000`,
  `table_buy_in -2000`, `table_cash_out +1980`, `table_buy_in -2000`,
  `table_cash_out +2000` → **24,980 = ledger**, one grant.
- **The survivor was not touched.** Seat still `active`, connected, `left_at` null,
  stack **2,010** — and its wallet still **23,000 with no `table_cash_out` row at
  all**. That absence is the point: §15's defect was a `CASH_OUT` dispatched under
  the wrong player's credential closing the OTHER seat in the same game. Here the
  leaver's cash-out wrote the leaver's seat and the leaver's ledger, and nothing else.
- **Proof 7, rejoin, is in the same readback.** The second seat row is a fresh
  `joined_at`, a fresh 2,000 debit and its own cash-out, at the same
  `game_session_id`, under the same `user_id` — identity ownership preserved across a
  departure and return, and reconciled at both ends.

#### The survivor — proofs 5 and 6, sampled rather than inferred

The seat table was sampled every 3 s through `two-client-public-survives.yaml`
(`twodev-state-5-survivor-samples.txt`), so the table's behaviour after a departure
is recorded as it happened:

- The survivor's stack moved through **twelve** distinct values — 2,010 → 2,030 →
  1,980 → 2,030 → 2,080 → 2,030 → 2,080 → 2,030 → 1,980 → 2,030 → 1,980 → 1,960 —
  then cashed out to stack 0, wallet 23,000 → **24,960**. It was dealt in and played
  on, alone, at a table the other player had left. `settleTableClosure` returned
  `sessionEnded` false while it remained, and the session went `completed` only after
  its own departure.
- **The departed player's row is identical in all 246 samples**: stack 0, `left`,
  `connected false`, wallet **24,980**. An entire play session and a second cash-out
  by the remaining player moved neither its seat nor its wallet by one chip.

#### The private table — proof 7, and proof 4 again in §15's own setting

Room **`ERBJ6E`**, `host_user_id` = A, which `create_private_room` derives entirely
from the bound JWT because it names no player. Game session
**`f9d99ead-2f9b-4f9b-8104-3d61a128db3c`**, mode `private_table`, both seated with
**`buy_in` 0** and 5,000 session stacks, and **both wallets unchanged** at 24,960
and 24,980 — private stacks never enter the global wallet, which is the
anti-collusion design rather than a shortcut. `twodev-state-7-private-seated.txt`.

**This is where §15 reproduced its blocker — on private session stacks — so the
host's departure here is the direct analogue.** `twodev-state-9-private-host-left.txt`:

- Host A's seat → `left`, stack 0, `left_at` 04:59:19; `my_active_session()` → null.
- **Guest B untouched**: seat `active`, connected, `left_at` null, stack **4,940**.
- The session stayed **`active`** — a seat closing and a table closing are different
  events — and the room's `host_user_id` transferred to B, which is correct.
- Neither wallet moved.

Under §15's defect the leaver's delayed cash-out set the *other* player's seat to
`left`, stack 0. It set its own.

#### The stack reset — proof 8

Covered in 17.6.

#### Final reconciliation

`twodev-state-10-final.txt`. Both sessions `completed`, room `closed`, all four seat
rows `left`.

| | wallet | ledger sum | reconciles | opening grants | negative |
|---|---|---|---|---|---|
| **A** `e2c35268…` | **24,960** | 24,960 | **yes** | **1** | no |
| **B** `69018fc7…` | **24,980** | 24,980 | **yes** | **1** | no |

Asked of **every** wallet in the database, not of this pass's two:

| | users | wallets | wallet ≠ ledger | negative | `initial_grant` ≠ 1 |
|---|---|---|---|---|---|
| before any flow | 2,422 | 2,422 | **0** | **0** | **0** |
| both players seated | 2,424 | 2,424 | **0** | **0** | **0** |
| public table closed | 2,424 | 2,424 | **0** | **0** | **0** |
| after the stack reset | 2,424 | 2,424 | **0** | **0** | **0** |
| **final** | **2,424** | **2,424** | **0** | **0** | **0** |

Every chip is accounted for. A's 24,960 is 25,000 − 2,000 + 1,960; B's 24,980 is
25,000 − 2,000 + 1,980 − 2,000 + 2,000. The private table and its free reset appear
in neither, which is the invariant.

### 17.6 The stack reset, and the flow that had never existed

§16.8.3 recorded proof 11 as "**NOT RENEWED, and no flow exists for it**". One
exists now: **`tests/e2e/private-broke-reset.yaml`**, the only repository addition
this pass makes besides this section.

It matters because of what `broke-affordance.ts`'s own header says: `RESET_PRIVATE_STACK`
was the one action of the nine in `session-command.ts` with **no client caller** for
the life of the private-table feature. The control exists now — and until this flow,
nothing had ever pressed it on a device. CLAUDE.md's rule is the reason that is not
a formality: a test that calls `resetStack` proves `resetStack` works and proves
nothing about whether a player stuck at a table can reach it.

**How the stack was run down, and why it is legitimate play.** `mayResetPrivateStack`
offers the reset only at `BETTING_OPEN`, for a `connected` seat the engine has
actually sat out — which at a private table can only mean a stack that cannot cover
the 20-chip minimum. Reaching that means genuinely losing 5,000 chips. The flow
wagers the table ceiling and then **hits until the hand is over**: a legal action
sequence a real player can choose, deliberately bad, and **no card, shoe, seed or
outcome is influenced in any way** — invariant 1 is untouched, and the server dealt
exactly as it would for anybody.

Measured, from `twodev-state-8-reset-samples-2.txt`:

- The seat fell **5,030 → 10** over 69 hands, in 500-chip steps while the ceiling was
  affordable and then in 20-chip steps once it was not.
- At 10 chips the engine sat the seat out, the product offered the reset, and the
  flow asserted what the screen SAYS before pressing it: `table-broke-title`,
  "You are out of table chips", and "Nothing here touches your balance in either
  direction".
- The control was pressed and **the stack went 10 → 5,000** in one step. Screenshots
  `refresh-b-private-broke-offer` and `refresh-b-private-stack-reset`.
- **It executed for the initiating player only.** Across the same sampling window the
  other seat continued its own unrelated drift, 4,930 → 4,800 in ordinary 20-chip
  steps, with no jump and no change in kind.
- **Neither wallet moved.** A stayed 24,960 and B stayed 24,980 across the whole
  run-down and the reset — no ledger row of any reason was written for either. The
  reset is free and the chips are the table's.

The assertion is on the RESULT throughout — the broke panel, then its absence and a
full stack — never on a tap having COMPLETED, which CLAUDE.md records three defects
for.

### 17.7 The two failures, classified

Neither is a product defect. Both are recorded with what settled them, and **no
assertion, product behaviour, retry policy or arbitrary timeout was changed for
either**.

**1. `private-broke-reset.yaml`, first run — HARNESS, iteration budget.** Failed
after 14m06s on `Assertion is false: id: table-broke-title is visible`, with
**117 steps COMPLETED and the stack down from 5,030 to 2,410**. The product was
demonstrably working: the stack fell by 500 a hand exactly as legitimate play does.
What ran out was my loop's 120 iterations. The rate limit is the OTHER seat — an
idle companion must be stood down by its own 15-second clock every hand, so a hand
costs 30–45 s whatever the driving device does. The budget was raised to 400 **with
that measurement written into the flow**, and the rerun passed with 314 steps
COMPLETED and 0 FAILED. The failed run is preserved. Raising an iteration budget to
let a flow reach a state it was converging on is not the same act as raising a
timeout to mask resource exhaustion, which this pass did not do.

One real limitation in that flow, stated rather than hidden: its denomination ladder
is 1,000 → 500 → 10, with no 100 or 50 rung, so below a 500 stack it stages 10,
which is under the minimum, and the seat is defaulted at 20 a hand instead of
wagering what it could. That is why the run-down's tail took as long as it did. The
flow is correct and the evidence stands; a 100/50 rung would make it faster.

**2. `two-client-leave.yaml` on device B, first run — HARNESS, and the app was
right.** Failed after 56 s on `Assertion is false: id: room-create is visible`.
Diagnosed on the artefacts, not re-run blindly:

- **Not a degraded hierarchy.** The saved dump is **83,514 bytes and 68 nodes** — a
  COMPLETE read — where the signature of a lost snapshot is the eight
  identifier-bearing nodes CLAUDE.md describes. The driver saw the screen fine.
- **Not a crash.** The dump is of `com.arc21.app`, showing the TABLE: `table-countdown`,
  `table-my-stack` and all five action controls.
- **The app did the right thing.** Only **3** of the flow's steps COMPLETED, so its
  opening `repeat while visible: table-countdown` block never ran a single iteration —
  the guard was evaluated at an instant the countdown was not on screen, so the leave
  was never asked for. The flow then deep-linked to the lobby while B **still held a
  live dealt seat**, and the lobby correctly sent it back to its own table rather than
  abandoning an open stack. The engine row confirms the table was healthy at that
  moment: `BETTING_OPEN`, hand 69, version 351, updated 11 s earlier.
- The rerun passed with **26** steps COMPLETED — the block ran this time — and the
  jump from 3 to 26 is what identifies the cause rather than guessing at it.

This is CLAUDE.md's "A TAP GUARDED BY `when` IS TWO READS OF THE SCREEN" one level
up: not a tap that missed, but a whole guarded block skipped because its condition
was true only between hands. The flow is a pre-existing one and was **not** edited;
it is noted here because it will do this again, and `optional`-style tolerance or a
guard on "still at a table" rather than on the countdown would fix it.

### 17.8 Environment, restored

Everything paused for this pass was put back and verified, not assumed:

- **All twelve containers up.** The four sidecars were `docker start`ed and
  `docker ps` counts 12 of 12.
- `create-session`, `game-command` and `send-notifications` each answer **401** — the
  function's own guard, not the gateway's — and PostgREST answers **200**.
- **Both simulators shut down**, which is the state this session found them in.
- `supabase functions serve --no-verify-jwt` left running, as found.
- `twodev-environment-restored.txt` records all of it with the host at load 3.73.

Nothing was done to Chrome, NordVPN or the unrelated `claude` session, and nothing
in the database was cleaned up: the two pseudonymous players, their two completed
sessions and their reconciling ledgers are left in place as the evidence they are.

### 17.9 Evidence paths

All outside Git, in `/Users/tj/arc21-evidence/astra-refresh-b-20260915/` (`$E`),
under the `twodev-` prefix so every `closure-`, `native-`, `renewal-`, `repair-` and
`final-reaudit-` artefact from §3, §4, §13, §14, §15 and §16 is preserved beside it.
**69 artefacts.** `twodev-manifest.json` carries branch, HEAD, capture time, the
Release bundle's SHA-256, the player and session ids, and a SHA-256 for each of the
60 evidence files.

| Artefact | What it is |
|---|---|
| `twodev-state-0-baseline.txt` … `twodev-state-10-final.txt` | the server-side readback paired with each stage, including whole-database integrity at five points |
| `twodev-state-5-survivor-samples.txt` | the seat table sampled every 3 s through the survivor flow — 246 identical samples of the departed row |
| `twodev-state-8-reset-samples{,-2}.txt` | the same, through both stack-reset attempts: the 5,030 → 10 → 5,000 progression and the other seat's independence |
| `twodev-native-*.{log,xml}` and `twodev-native-*/` | each Maestro run: host load either side, JUnit XML, debug output, hierarchies, screenshots, and the `commands.json` step counts |
| `twodev-functions.log` | the Edge runtime's own log for the whole pass (53 soft / 0 hard / 0 `WORKER_LIMIT`) |
| `twodev-build-freshness-after.txt` | the freshness check repeated after the last flow — 0 of 246 source files changed |
| `twodev-refb-read.ts`, `twodev-refb-code.ts`, `twodev-integrity.*`, `twodev-sample.*`, `twodev-run-flow.sh`, `twodev-freshness.py` | every harness tool this pass used, preserved so the readbacks can be re-derived rather than believed |

### 17.10 What this renews, and what it does not

**Renewed.** Every two-device table row §16.8.3 listed as NOT RENEWED, on the same
fresh Release binary §16.8.1 fingerprinted, now proven on two devices:

| §16.8.3 item | Status |
|---|---|
| **1, 2** two pseudonymous players in one real public table, both seated and visible | **RENEWED** |
| **4** reconnect / cold restoration of a table session | **RENEWED** |
| **6** the remaining player's table stays functional after the other leaves | **RENEWED** |
| **7** leave and rejoin | **RENEWED** |
| **10** private-room/table behaviour, create → join → felt → play → leave | **RENEWED** |
| **11** stack reset / rebuy | **RENEWED**, and a flow exists for it now |

With them, the §14.2 rows §16.9 declared stale — every `renewal-public-*` row, every
private-table row that reaches the felt, and the wallet readbacks taken on them —
have current equivalents taken on the current binary. **The native half of §16.9's
stale list is closed.**

**Not renewed, and not attempted.** Mid-hand cash-out
(`online-leave-mid-hand.yaml`), which §16.8.3 recorded as ATTEMPTED, NOT OBTAINED
for an onboarding-flag reason that is a known harness defect and unrelated to this
repair. It is not one of the two-device proofs this pass was asked to close.

**Still outstanding, unchanged.** §8's limitations, §9's hosted activation, §11's
review list, §15's uncompleted review boundary, §16.11's eleven challenges and
§16.12. This pass adjudicated none of them and rebutted none of §12's or §15's
findings. **No product blocker was found in these flows, and Refresh B is NOT
declared PASS.** A fresh independent audit is still required, and §16.11's items
4, 5 and 3 — the fail-with-repair-removed measurements — remain things to be
re-derived rather than taken on trust.

### 17.11 Exact state for the independent re-auditor

- Branch `astra-refresh-b`, HEAD **`47dba201ace488d932bb4e479416f52f79a6f176`**,
  everything uncommitted. Nothing committed, pushed, merged, deployed or rewritten;
  no hosted setting, datum or deployment touched; no Refresh C/D/E work begun.
- **Production source changed by this pass: none**, proven by 246 of 246 fingerprints
  identical to a binary built before it started, re-checked after the last flow.
- Repository additions: `tests/e2e/private-broke-reset.yaml` and this section.
- `AGENTS.claude-backup.md` remains intentionally untracked and is not part of B.
- The Release binary at `…/Build/Products/Release-iphonesimulator/Arc21.app`, bundle
  SHA-256 `9a7d0bf3c99ae093…`, is the §16 build, unmodified and installed on both
  simulators. Rebuild and compare rather than trusting the hash.
- Players left in the local database: `e2c35268-a70a-45cc-a341-323b4fc56998`
  (`clear_bison_594397`, 24,960) and `69018fc7-abd5-466a-9bfd-048f2cf4384f`
  (`amber_tiger`, 24,980), both anonymous, both reconciling, one grant each. Sessions
  `6edb96fe-…` (public, completed) and `f9d99ead-…` (private, completed); room
  `ERBJ6E` closed.
- Local services as found: twelve containers up, `functions serve` running with all
  three functions answering 401, both simulators shut down.
- **§12 and §15 remain the standing audit verdicts.** §13 and §16 are unreviewed
  repairs; §14, §16.8 and §17 are evidence for them, not verdicts on them.


## 18. Final independent consolidated re-audit — September 29, 2026

**ASTRA REFRESH B: FAIL**

**KNOWN CURRENT REFRESH-B RELEASE-BLOCKING SOFTWARE DEFECTS: 6**

This bounded independent audit is complete. It continued after findings and
adjudicated the remaining meaningful independent surfaces, as instructed. One
primary agent, no delegation or Goal mode; no production changes. Starting branch
`astra-refresh-b`, HEAD
`47dba201ace488d932bb4e479416f52f79a6f176`.

### Confirmed findings (preserved as a batch)

B-R1–B-R3 use the actual production store, installed Supabase SDK with PKCE and
`processLock`, real GoTrue password sign-in through the production Auth store and
adapter, and `resetPlayerState()` on the Auth identity change. The sole timing
injection delays one SDK credential lookup **before reading storage**. After a
real A → B sign-in, that lookup resumes normally. No JWT, session result, server
verdict or database mutation is fabricated. Database readbacks establish the
wrong-player effects. Fixture cleanup returned zero remaining users.

Evidence outside Git: `$E/reaudit-final-analogous.ts` and
`$E/reaudit-final-analogous.log`, where `$E` is
`/Users/tj/arc21-evidence/astra-refresh-b-20260915/`.

**B-R1 — Medium / P2 — stale matchmaking cancellation changes replacement B.**
Release blocker (category A). `src/features/matchmaking/matchmaking-store.ts`,
`cancel()` sends unpinned `leave_matchmaking`; `queue()` and mutating
`poll_matchmaking` have the analogous dispatch boundary. Reproduction: A
`ca038720-9ca9-4b57-9c69-82da2469e39e` and B
`86500471-a461-4c99-bc3b-61079ab38c4c` each have a waiting queue entry. A calls
production `cancel()`, the SDK lookup is delayed, and production sign-in switches
to B. Release it: B becomes `cancelled`, A stays `waiting`. RLS/auth.uid correctly
choose B, which is exactly the wrong actor for A's intent. Queue expiry and absence
of a wallet debit do not prevent the replacement-player mutation. The prior §13 /
§16 matchmaking exemption is rejected. Smallest repair: bind/pin queue, cancel and
poll (poll can allocate a room), carry that binding through each dispatch/retry,
and add real-backend stale-identity plus uninterrupted positive controls. No
server authority redesign is needed.

**B-R2 — Medium / P2 — stale “Mark all read” consumes B's unread inbox.**
Release blocker (category A). `src/features/notifications/notifications-store.ts`,
`markAllRead()` dispatches `mark_notifications_read({p_ids:null})` unpinned.
Reproduction: A `8f86208e-3161-4902-9241-b5a427c684ff` and B
`eedf74a1-353d-4ab3-9fef-cf975334da86` each receive a real friend-request
notification. Hold A's credential lookup, sign in as B, release: A's `read_at`
remains null, B's becomes non-null. `playerScopedSetter` only guards local state;
it cannot undo that write. Smallest repair: initiating-player gate and pinned
credential for mark-all dispatch, plus the bounded regression/positive control.
The single-ID variant is separately reviewed: its explicit notification ID and
server `user_id = auth.uid()` prevent B from inheriting A's notification write.

**B-R3 — Medium / P2 — stale cosmetic selection equips replacement B.**
Release blocker (category A). `src/features/cosmetics/cosmetics-store.ts`,
`equip()` sends unpinned `equip_cosmetic`. Reproduction: both users legitimately
own the default avatar through `grant_earned_cosmetics`; both loadouts have null
slots. A `5d9c5397-7d39-4165-8a83-df5def2d6bc0` starts equip, its credential
lookup pauses, and sign-in switches to B `d6f67154-fc9e-47b2-9fa1-1e2cbbeeea6b`.
Release: B's avatar becomes `a773632c-628d-4a02-9fec-3c8336c263e4`; A's remains
null. Item ownership is not initiating-player binding when both players own the
same item. Smallest repair: bind/pin equip before asynchronous work; guard its
post-response follow-up; add real-backend regression and positive control.

**B-R4 — High / P1 — stale privacy sync makes replacement B's profile public.**
Release blocker (category A). `src/features/settings/profile-privacy.ts`,
`syncProfilePrivacy()` takes no initiating-player scope before its session await.
Unlike rename, its `eq(id, userId)` is not enough: the ID itself can already be B's.
Reproduction: both profiles private; A
`492f76c4-8115-49bc-a291-6f7af43c3cd8` starts a public-visibility sync, hold its
session lookup before storage is read, switch through production sign-in to B
`d7a236ff-b9b3-4efe-bb7c-df29e5a14b34`. Complete B's current private sync first
(the root hook's current-preference behavior); then release A's older request.
B becomes `public`; A remains `private`. This can expose statistics B's current
choice hides. Evidence: `$E/reaudit-final-analogous.ts`,
`$E/reaudit-final-privacy.log`; fixture cleanup zero. Smallest repair: capture
initiating scope before the first await and pin/check that player's credential and
row identity before the PATCH, with a regression that keeps the current private
choice after a delayed prior-player public choice. Relevant callers:
`use-profile-privacy-sync.ts` and Settings.

**B-R5 — Medium / P2 — stale push retirement disables replacement B's device.**
Release blocker (category A, exercised with native boundary doubles).
`src/lib/notifications/push.ts`, `retireDevice()` pins whichever session its await
returns but captures no initiating-player scope. Start A's production retirement,
hold its session lookup, sign in as B, finish B's normal production
`registerDevice()` restoration, then release retirement. The database token row
still belongs to B but `is_active` changes **true → false**. The server's
`user_id = auth.uid()` check therefore does not save it. Evidence:
`$E/reaudit-final-shadow/tests/reaudit-push.test.ts`,
`$E/reaudit-final-push.log`, `reaudit-final-push-result.json`,
`reaudit-final-push-cleanup.txt`. Real production source (absolute imports from the
repository), SDK/PKCE/processLock, Auth store/adapter, registration and retirement
RPCs, and database; only React Native platform, granted OS permission and a
non-deliverable Expo token/project are doubled. No push was sent. This proves
registration-state corruption, not physical-device delivery. Smallest repair:
capture retirement's initiating scope before its session await and recheck before
the serialized device mutation; preserve its pinned token and normal departure
ordering; add stale-retirement/restoration and uninterrupted controls.

**B-R6 — High / P1 — failed credential replacement reports B signed in while requests still act as A.**
Release blocker (category A). Affected:
`src/lib/supabase/secure-session-storage.ts` (`setItem` swallows a pre-commit
replacement failure while retaining the prior credential),
`src/features/auth/supabase-auth-adapter.ts` (`signIn` accepts the SDK result),
`src/features/auth/auth-store.ts` (Auth event/result adoption), and the
`player-binding.ts` assumption that a current scope necessarily names the same
player as SDK storage.

Reproduction uses the production chunked storage adapter over an injected keychain
backend, real SDK with PKCE/processLock, real Auth, production Auth/friends stores,
and production player reset. First save anonymous A successfully. During real
password sign-in to B, make native keychain replacement writes throw; reads of
A's committed credential continue to work. Sign-in still reports `signedIn` and
the Auth store shows **B**, while a fresh SDK `getSession()` returns **A**. A new
friend request initiated from that B state succeeds with **A as sender**, despite
using the repaired friends gateway. A
`1c98ffe0-8512-44c7-8133-7f3c5a658d84`, B
`d3304530-26e1-4179-892a-3e922af95d56`, recipient
`5ec545a4-21f9-4d9d-b215-369fcc2e0676`; readback shows sender A. Durability is
reported unavailable, but the warning does not prevent wrong-account requests.
Evidence: `$E/reaudit-final-storage.ts`, `$E/reaudit-final-storage.log`; fixture
cleanup zero. This establishes cross-account acting identity, not measured wallet
loss. It violates **authenticated identity consistency / no cross-account action
substitution**.

Smallest repair: preserve atomic storage while making failed identity replacement
fail closed across SDK/session adoption and request binding. A successful visible
sign-in must agree with the credential subsequently read by outbound operations;
otherwise retain/reconcile the prior identity or block online operations explicitly.
Do not merely hide the warning or discard a late response. Add a real-SDK
storage-failure regression through Auth adoption and a subsequent protected
mutation, with successful switch and token-rotation controls.

B-R1–B-R5 violate **“stale player-A work cannot mutate player B.”** B-R6 exposes the
reverse acting-identity mismatch after a persistence failure. No production repair
was made. Whole-system identity safety is **NOT ADJUDICABLE UNTIL B-R1 THROUGH
B-R6 ARE REPAIRED**. Specifically: matchmaking isolation (B-R1), bulk inbox
isolation (B-R2), loadout isolation (B-R3), privacy preservation across switches
(B-R4), push departure/restoration ordering (B-R5), and online identity consistency
under failed keychain replacement, including the binding helper's premise (B-R6).
The normal-storage held-session social/table repairs, migration review and ordinary
native table economics remain independently meaningful and were completed.

### 18.1 Previous blockers and analogous paths independently adjudicated

The **§12 social repair is accepted for its original delayed-auth race**.
`bindCurrentPlayer()` captures the player revision before its first await, rejects
a changed revision after session lookup and at dispatch, and `sentAs()` pins the
initiating JWT on each request. The installed SDK only supplies Authorization if
the per-request header is absent. This prevents the bad server mutation, rather
than merely dropping its response. Uninterrupted social operations still succeed.

The **§15 table repair is accepted for its original shared-game Leave race**.
The online gateway binds once before asynchronous work, rechecks each attempt and
pins the original credential. Command/reset retries retain the same request ID,
expected version and player; parsed rejections do not become transport retries.
Cash-out retains the server's seat-based idempotency and the store's held-Leave
and player-generation guards. Normal play, valid Leave and response-loss recovery
remain functional. `game-command.ts` follows the binding rule too; no current
production caller bypassing the online gateway was found.

These conclusions were re-measured using production gateways and the real local
backend, not inferred from mocks: all **4 files / 17 repair-regression tests pass**.
In a separate copy under `$E/reaudit-final-shadow/`, disabling the binding gate and
credential pinning made **4 files fail, 16 tests fail and 1 pass**. The real-server
social test again wrote as the replacement player; the shared-game table tests
again mutated the replacement seat. Repository production files were never
disarmed. Original production hashes are in
`reaudit-final-disarm-source-hashes.json`; exact results in
`reaudit-final-regressions.log` and `reaudit-final-disarmed.log`. B-R6 limits the
helper's premise under failed storage replacement; it does not erase these
normal-storage measurements.

| Reviewed surface | Independent conclusion |
|---|---|
| Friends, room create/join/leave/invite/open/start/ready/remove, wallet read/recovery grant | Initiating binding and pinned credentials reviewed, including production callers. Protected against the measured delayed-switch race; B-R6 remains a shared identity-consistency limitation. |
| Public/private table command, Leave/cash-out, reset/rebuy and transport retries | Original repair verified as above. Request IDs, expected versions and response reconciliation preserved. |
| Matchmaking queue/cancel/poll | B-R1. `poll_matchmaking` can allocate a room and must not be exempted as a read. |
| Quick Play, Daily, Sprint entry/withdrawal, Career start, matchmaking seat acquisition | `session-intent` captures scope and pins credential/body/idempotency key across retries; stores guard later state adoption. |
| Career drill submission left unbound | Real server condition prevents substitution: the unique attempt must belong to the verified user, otherwise `NOT_A_PARTICIPANT`. Two users cannot both own the attempt. |
| Notification single-ID mark-read | Explicit immutable notification ID plus `user_id = auth.uid()` prevents replacement-player writes. Bulk mark-read is B-R2. |
| Cosmetic entitlement materialization | Server derives eligibility; no client XP, score or achievement is trusted. Player-selected equip is B-R3. |
| Profile rename | Captured scope plus explicit initiating row ID and RLS protect replacement identity. Privacy sync is B-R4. |
| Presence heartbeat | No supplied user, time, game state or arbitrary presence payload; the currently authenticated player is actually active. Friend projection derives game membership and recent activity on the server. |
| Push registration / retirement | Registration captures scope/revision and pins dispatch. Retirement is B-R5. |
| Account-scoped reads and late replies | Player-scoped setters and active-session identity checks prevent stale response adoption; wallet requests also pin identity. Subject to B-R6's separate persisted/visible identity inconsistency. |
| Securing, sign-in, recovery, sign-out and deletion | Shared per-client mutation queue, expected-user guards, expired-intent rejection and locking after UI timeout reviewed. Same-UUID securing verified; failed credential replacement is B-R6. No separate queue-bypass defect established. |

### 18.2 Migration, Auth, authority and economic conclusions

The new migration was compared with the **last effective definitions**, not older
copies: `handle_new_user` from
`20260829120000_account_lifecycle_completeness.sql` and
`assert_client_authorization_surface` from
`20260904120000_least_privilege_and_entry_visibility.sql`.

- Bootstrap retains the specific `profiles_username_key` collision retry and
  rethrows unrelated unique violations. Candidate filtering, the unique index,
  random collision suffix and bounded 100-attempt loop handle concurrency without
  accepting client-supplied anonymous handles. The Auth trigger remains **AFTER
  INSERT only**, with profile/stat/wallet/grant creation in its transaction.
- The authorization assertion retains the earlier RLS, private-schema, PUBLIC
  function privilege, service-role, column-grant, security-invoker view and policy
  restrictions. Its intended changes add the authenticated presence RPC and
  remove friend-request INSERT from the client write allowlist. The assertion
  passed against the running database.
- Direct client friend-request INSERT is revoked; bounded RPC creation preserves
  rate limits. Remaining participant UPDATE is restricted by transition/identity
  guards. Player search keeps its rate/size bounds and literal escaping; both-way
  blocks apply. `list_friend_presence` exposes accepted, unblocked friends and
  server-derived activity only. Global presence Realtime publication/write access
  is removed; the actual remaining Realtime policy is authenticated, seated-game
  SELECT. Bootstrap/allocator functions are not API-callable, including by
  `service_role`; `private` remains inaccessible to client roles.
- Pseudonymous users have verified Auth UUIDs and authenticated server access.
  Securing updates the same UUID. Detached OTP verification must return the
  expected/current UUID before token adoption; an already-owned email cannot
  merge accounts. Email verification precedes password attachment. Recovery is
  an explicit, warned identity change. Existing secured-account flows passed the
  current backend suite. B-R6 prevents approval of failed-persistence adoption.
- No conversion/import path promotes local chips, XP, achievements, ranking or
  competitive statistics into server authority. Practice remains local;
  competitive requests contain intent, identifiers and choices, with server
  grading/settlement. Server engine, hidden-card boundary, lock order, private
  stack isolation and transaction/idempotency implementations are unchanged by
  this patch and their relevant current server tests pass.
- The historical §17 **2,424-wallet** readback reconciles. A fresh read after this
  audit's full server run saw **2,934 wallets, 0 wallet/ledger mismatches, 0 negative
  balances and 0 opening-grant-count violations**, including wallets with a
  missing grant in the count. The increased population comes from local test
  fixtures. Every new defect-reproduction fixture was cleaned up. Evidence:
  `reaudit-final-db-surface.txt`. No measured economic loss is claimed for B-R6;
  correct balances do not excuse its wrong acting identity.

### 18.3 Verification accepted, rerun and bounded

| Evidence | Result and classification |
|---|---|
| ONE current `npm run test:server` | **28 files / 340 tests PASS**, uninterrupted, 179.79 seconds; `reaudit-final-server.log`. Local runtime was healthy. This replaces the prior inability to obtain one uninterrupted full result. |
| Current social/table regressions | **4 files / 17 tests PASS**; real-server cases included. Disarmed-copy negative control reproduced both original defects, as detailed above. |
| Current targeted Auth/config/storage/isolation/CAPTCHA/session-intent tests | **5 files / 67 tests PASS**; `reaudit-final-auth-unit.log`. Existing helper tests did not cover B-R6's real-SDK adoption mismatch. |
| New bounded reproductions | B-R1–B-R4 real production store/SDK/Auth/backend readbacks; B-R5 real production push logic/backend with native boundary doubles; B-R6 real SDK/Auth/storage adapter with failing keychain backend. All six confirmed, cleanup verified. These are findings, not green release gates. |
| Preserved post-table-repair broad unit gate | **135 files / 2,525 tests PASS** in `repair-table-unit.log`; not rerun because audit changed no production code. |
| Preserved typecheck / lint | Typecheck PASS; lint **0 errors / 21 warnings**. No production edit invalidated these records. |
| pgTAP, coverage, doctor, bundle and broad native gates | Existing evidence reviewed in its stated scope; not automatically rerun. No claim that unit coverage measures Edge code running inside Docker. |

No repeated broad server run was used to obtain green. The isolated disarmed
tests and six defect reproductions are deliberate targeted negative controls,
not unexplained production-suite failures. No known blocker made the independent
database or ordinary table-economics checks meaningless, so those were completed.

### 18.4 Renewed native Release evidence adjudicated

The actual built bundle and **both installed simulator bundles** hash to
`9a7d0bf3c99ae093d7f8d28e99a458b96ea1c5f5f70d847d75468f363cc2eaa5`
(6,397,500 bytes). The repair marker is present. Freshness was re-derived:
**246 of 246 production files match, zero changed/added/removed, zero newer than
the build** (`reaudit-final-freshness.txt`). The Release build and recorded launch
evidence support an inlined bundle without Metro substitution. No native rebuild
or broad rerun was warranted.

§17's paired database readbacks, command reports, JUnit and selected failure/reset
screenshots support two distinct anonymous UUIDs in the same real public game,
correct individual buy-ins and seat ownership, cold restoration, correct Leave
with survivor unaffected, continued survivor play, rejoin, and private
create/join/felt/play/leave. In the actual fixtures **B is the public leaver and A
the survivor**; this reverses the question's illustrative labels but tests the
same invariant. B's wallet ends 24,980; A's ends 24,960, with only each player's
legitimate ledger effects. Private reset reaches **10 → 5,000** for B, the other
seat continues without a reset, and neither global wallet changes.

All 17 preserved JUnit reports were read: 16 success, one failed visibility-guard
attempt, plus the separately preserved first reset failure command report.
The reset failure exhausts a 120-loop convergence budget while the stack is
still falling; the enlarged harness budget subsequently reaches the same product
threshold, without a product change. The Leave failure's screenshot shows a live
table; its guard skipped the Leave action between hand states. The later valid
attempt and database readback succeed. These two are **harness failures**, not
concealed product failures.

Of the 60 §17 artifact fingerprints, 59 still match in full. The live
`twodev-functions.log` was appended to by the still-running local runtime and this
audit's server traffic: its original **10,077-line / 194,261-byte prefix** matches
the recorded hash exactly. The preserved original evidence was not overwritten.
This distinction is recorded instead of calling the whole manifest unchanged.

**Mid-hand native cash-out remains NOT RENEWED** (`online-leave-mid-hand.yaml`);
§17 does not prove it. Current backend cash-out/response-loss coverage and reviewed
held-Leave behavior provide separate support, sufficient for classification C
below, but are not a native PASS for that scenario. No native evidence repairs or
overrides B-R1–B-R6.

### 18.5 External/unproven classification and final repository state

| Item | Classification |
|---|---|
| B-R1–B-R6 | **A — Refresh-B release-blocking software defects.** |
| Android build/runtime and physical-device validation | **B — external release validation, unproven.** iOS simulator evidence cannot be promoted to those platforms. |
| Physical-hardware CAPTCHA, accessibility, cancel/error UX | **B — activation/device validation, unproven.** Local unit and configured simulator/SDK behavior do not establish the physical challenge experience. |
| Hosted Supabase / hosted PostgREST | **B — external activation and compatibility work, unproven.** Local PostgREST 16.3 is the tested pin; hosted compatibility must be checked independently. Hosted Supabase was not modified. |
| APNs/FCM/EAS delivery | **B — external activation/device validation.** B-R5 is nevertheless a confirmed software defect in registration state; delivery setup cannot repair it. |
| Intentionally unconfigured native build | **C — non-blocking limitation for this bounded software audit, not a native PASS.** Configuration fail-closed tests and inspected routing support fallback; the tested backend-unavailable Practice case is explicitly different. |
| Native mid-hand cash-out renewal | **C — limited native evidence**, separately covered by current backend tests and held-Leave source review; not relabeled renewed. |
| Exact forced-switch races on physical/native UI | **C — reproduction boundary.** Actual production store/SDK/backend races establish the defects and repair behavior; native boundary doubles and storage fault injection are explicitly identified above. |
| 21 lint warnings, slow stack-reset convergence, unlinked identity loss | **C — recorded limitations.** Unlinked replacement/destructive-loss warnings remain; no local-economic recovery/import is permitted. |

Hosted activation still requires: forward deployment of the new migration;
anonymous Auth and manual identity linking; email confirmation; correct OTP and
email-change templates; SMTP/delivery; `arc21://auth/recovery` in
`additional_redirect_urls`; public hCaptcha site/origin configuration and the
private Auth hCaptcha secret; signup/IP limits and monitoring; and a verified
hosted PostgREST version/compatibility. None was activated or marked passed here.

The full tracked diff from the requested starting SHA and the intended untracked
Refresh-B additions were reviewed across UI, Auth/gateways/stores, configuration,
dependency changes, migration, tests, harnesses and release documentation. The
patch is coherent Refresh-B scope, but is **not approved for checkpoint** because
of the six findings. The first FAIL → social repair → first native renewal →
second FAIL → table repair → partial renewal → §17 final two-device renewal chain
is retained. This audit changes only this record in the repository; scripts,
logs, disarmed-copy sources and readbacks live outside Git under `$E`.

Final branch remains `astra-refresh-b`; starting and final HEAD both remain
`47dba201ace488d932bb4e479416f52f79a6f176`. Index inspection is empty: no
`AGENTS.claude-backup.md`, evidence, credentials or other files staged. No commit,
push, merge, deployment, hosted mutation or history rewrite. No Refresh C/D/E.

**ASTRA REFRESH B: FAIL — six confirmed blockers, consolidated for a separate
bounded repair pass.** That pass must repair the six cases and add regressions
through actual SDK/Auth adoption and remote mutation; in particular, it must
cover the credential-storage premise shared by otherwise bound operations.
Only the checks and native evidence invalidated by those repairs need renewal.

## 19. Consolidated bounded repair of B-R1 through B-R6 — September 29, 2026

**This is a repair record, not a verdict. Refresh B is NOT claimed to pass.**
§18's FAIL and its six findings are preserved above exactly as written; so is
the whole chain before it. One primary agent, no subagents, no Goal mode. Branch
`astra-refresh-b`, HEAD still `47dba201ace488d932bb4e479416f52f79a6f176`;
nothing committed, pushed, merged, deployed or rewritten; no hosted Supabase
setting, datum or deployment touched; no Refresh C/D/E work begun.
`AGENTS.claude-backup.md` remains intentionally untracked.

Evidence from this pass is outside Git in
`$E/consolidated-repair-20260929/` (`$R` below), so every earlier `closure-`,
`native-`, `renewal-`, `repair-`, `twodev-` and `reaudit-final-` artefact is
preserved beside it.

### 19.1 Starting state, verified rather than assumed

- The tracked diff from `47dba20` was **byte-identical** to the audit's preserved
  `reaudit-final-tracked.patch` (SHA-256 `8ba401e3…` both), and this record's
  file hashed `2ed4c77c…` — the audit's own `audit_record_sha256` — before this
  section was appended. The six findings therefore applied to exactly this tree.
- For negative controls, the audited tree was rebuilt OUTSIDE the repository
  (`git archive 47dba20` + `git apply reaudit-final-tracked.patch` + the audited
  untracked production files) under the session scratchpad. Its
  `player-binding.ts` hashes `bd776b3e…`, the value the audit recorded in
  `reaudit-final-disarm-source-hashes.json`, and its `secure-session-storage.ts`
  hashes `b18361d0…`, the fingerprint in `repair-build.json`. No repository file
  was ever disarmed.

### 19.2 B-R6 first: the root cause, and the fail-closed repair

**Root cause, read from the installed SDK (`@supabase/auth-js` 2.112.3).** GoTrue
keeps no session in memory: `__loadSession()` reads storage on EVERY
`getSession()`, and `fetchWithAuth` calls `getSession()` for every request — so
the keychain adapter IS the SDK's current-session authority. Every identity-
adopting path (`signInWithPassword`, `signInAnonymously`, `exchangeCodeForSession`,
`_setSession`, `_updateUser`, `_callRefreshToken`) awaits `_saveSession()` and
only THEN notifies (`SIGNED_IN`, `PASSWORD_RECOVERY`, `USER_UPDATED`,
`TOKEN_REFRESHED`), and each rethrows a non-Auth error instead of swallowing it.
`ChunkedSecureSessionStorage.setItem` resolved after a replacement it had NOT
committed. GoTrue read that as "B is stored" and announced B; the auth store
adopted B through its listener; every request kept reading A. That is the whole
split.

**The repair — `src/lib/supabase/secure-session-storage.ts`.** `setItem` now
REJECTS (`SessionReplacementError`, code `session_not_persisted`) when a write
did not commit AND the player it would install is not the player storage now
serves. Storage is asked, not inferred: after a failed write it reads back what
every later request will be given. Consequences, each measured:

| Case | Behaviour |
|---|---|
| Successful replacement | unchanged — commits, resolves, durability `durable` |
| Failed replacement A → B (the audit's) | rejects before GoTrue announces anything; A is still served; durability `unavailable` |
| First write on a device that cannot store one (none → X) | rejects; nothing is announced |
| Failed write for the SAME player (token rotation, same-UUID securing) | degrades exactly as before — resolves, older same-player token still served, durability `unavailable`. Identity cannot split on these, and refusing them would only take a working player offline |
| Not a session at all (PKCE verifier, anything else) | unchanged historical never-throw behaviour |
| Write reported failure but landed (a platform that updates memory before a failed flush) | judged by the read-back: storage serves the new value, so it resolves as durable |
| Read-back itself fails | rejects — the served player cannot be confirmed |
| Session whose player cannot be read | treated as unknown, never as a match: rejects on failure |
| Partial replacement (chunks written, head not) | the head never moved, so the prior credential is served; rejects |
| Rollback / rollback failure | no rollback exists or is needed: the committed head is never touched before the new one commits (unchanged design) |
| Process death at every native mutation boundary | 9 boundaries measured: 4 refused → A restored, 4 announced → B restored, 1 refused → B restored (killed after the head landed: a dead process announces nothing, and its relaunch adopts B). **Zero "announced B, relaunch restores A"** |
| Relaunch | adopts whatever storage holds, through the unchanged `hydrate()` → `ensurePlayer()` path |

`src/features/auth/auth-failure.ts` maps `session_not_persisted` to the existing
`PERSISTENCE_UNAVAILABLE` copy — structural, like every other classification.
**No change to `auth-store.ts`, `supabase-auth-adapter.ts` or the binding's
logic was needed or made**: the SDK now fails before announcing, and the
adapter's existing serialized-mutation `catch` turns the rejection into a
failure result. `player-binding.ts` gained only a header paragraph recording its
premise (the player shown is the player storage holds) and where that premise is
now enforced. Nothing here hides a warning or discards a late response; the
refusal happens before any adoption, and no UI check was added.

**Why `removeItem` still never throws.** `_callRefreshToken` calls
`_removeSession()` inside its own error handler before settling
`refreshingDeferred`; a throwing removal would strand every concurrent waiter on
that promise. Residual, recorded rather than repaired because it cannot surface a
DIFFERENT player: a failed keychain delete during sign-out lets GoTrue emit
`SIGNED_OUT` while A's credential survives. The app then shows no player; a
sign-in is refused `PLAYER_CHANGED` by the adapter's expected-user guard (storage
still names A), and a relaunch restores A. No player B can become visible.

**Two analogues of the same swallowed write, repaired by the same change and
proved:**

- **Recovery.** `completePasswordReset` exchanges the PKCE code (a write of the
  recovered player R) and then calls `updateUser({ password })`, which reads its
  credential back from storage. Measured on the AUDITED code with the keychain
  refusing writes (`$R/b-r6-recovery-analog-prefix-probe.json`): the reset
  reported success, the screen went P → R → P, and **the PRIOR player P's
  password was changed** — P's old password stopped working and the new one
  worked — while R's was untouched. Repaired: the exchange is refused
  `PERSISTENCE_UNAVAILABLE` before any password is sent.
- **First creation.** On a device that cannot store any credential, anonymous
  creation used to show the new player while the SDK held no session at all.
  Now nothing is shown.

### 19.3 B-R1 to B-R5: one root cause, one repair pattern

**Shared root cause.** Each is a player-scoped RPC that names no player — or a
row id taken from a session read AFTER an await — dispatched without capturing
the initiating player's scope before the first await and without pinning the
credential. The SDK attaches whichever credential it reads as the request
leaves, so work begun as A was sent as B, and the server's `auth.uid()` scoping
correctly acted on B.

**Repair.** The established mechanism, unchanged: `bindCurrentPlayer()` captures
the scope synchronously before the first await, refuses `identity-changed` if
the player moved before the credential was read, and `sentAs()` pins that
credential into the request's own `Authorization` header (which `fetchWithAuth`
only fills when absent). No new authentication path, no second binding helper.

| Finding | File | What is bound | Follow-ups |
|---|---|---|---|
| **B-R1** | `src/features/matchmaking/matchmaking-store.ts` | `queue` (`join_matchmaking`), `poll` (`poll_matchmaking`, which can allocate a room), `cancel` (`leave_matchmaking`); `keepWaiting` goes through `queue`; `takeSeat` was already bound by `session-intent` | `queue`'s read-back poll rides on the SAME binding (`pollAs`) and is skipped once the player changed |
| **B-R2** | `src/features/notifications/notifications-store.ts` | `markAllRead` (`p_ids: null`) | the reload runs only while the same player is current |
| **B-R3** | `src/features/cosmetics/cosmetics-store.ts` | `equip` (`equip_cosmetic`) | inventory and loadout reloads only while the same player is current |
| **B-R4** | `src/features/settings/profile-privacy.ts` | `syncProfilePrivacy` — scope captured synchronously, credential pinned, target row = the BOUND player's own id; returns `skipped / identity-changed` once stale | a per-player ordered lane: one player's choices are written in the order made (the root hook and Settings both sync), and the lane restarts on a player change so the new player's write never waits behind the old one's refusal |
| **B-R5** | `src/lib/notifications/push.ts` | `retireDevice` — bound before its session read; refused if the credential cannot be read under the departing player's scope | once bound, it is deliberately allowed to COMPLETE as the departing player (see below) |

**B-R5's one deliberate difference from registration.** `retire_push_token`
updates only `user_id = auth.uid() and token = p_token`, so a retirement carrying
the DEPARTING player's pinned credential can only ever touch that player's own
row. The defect was a retirement carrying the NEW player's credential, which the
binding now refuses. Refusing an already-bound retirement for a later switch
would regress departure: measured on the wire and against the database, when a
retirement queues behind the departing player's own in-flight registration, that
registration lands and only the retirement then switches it off — refused, the
departed player's pushes would keep arriving on a device the next player holds.
Registration is the opposite case (`on conflict (token) do update set user_id`
would hand the row back to the departed player), so a stale registration stays
refused, as the audit accepted.

### 19.4 Production files changed (8)

Fingerprints are `$R/prebuild-freshness.txt` (audited build → this tree):

| File | Audited | Now | Change |
|---|---|---|---|
| `src/lib/supabase/secure-session-storage.ts` | `b18361d0f6dc…` | `6587fb9dfecd…` | B-R6 fail-closed replacement |
| `src/features/auth/auth-failure.ts` | `650d6fa8ef21…` | `47f61c7bffeb…` | one classification |
| `src/lib/supabase/player-binding.ts` | `bd776b3ef6a5…` | `7c73d5bd9b8b…` | **comment only** |
| `src/features/matchmaking/matchmaking-store.ts` | `a056d980feb3…` | `1dd344f6843a…` | B-R1 |
| `src/features/notifications/notifications-store.ts` | `3a3caf19cf1e…` | `99041b1d42bb…` | B-R2 |
| `src/features/cosmetics/cosmetics-store.ts` | `7700d86e7073…` | `d4838000afdf…` | B-R3 |
| `src/features/settings/profile-privacy.ts` | `00b6ce2fcd7a…` | `96ebdf21aef3…` | B-R4 |
| `src/lib/notifications/push.ts` | `9c3e79254e46…` | `53cebd478eeb…` | B-R5 |

No other production file changed — the same freshness run reports 0 added, 0
removed and exactly these 8 content changes among 246 sources. No migration,
RLS, Edge Function, native configuration or dependency changed, so pgTAP,
`check:functions` and a prebuild were not needed.

### 19.5 Maintained regressions added — 6 files, 40 tests

| File | Tier | Tests | What it proves |
|---|---|---|---|
| `tests/auth/credential-replacement.test.ts` | unit, storage boundary | 10 | every row of the 19.2 table, including the crash-boundary property |
| `tests/server/credential-replacement.integration.test.ts` | **real SDK / GoTrue / Postgres** | 6 | the audit's B-R6 reproduction inverted: production chunked adapter over a keychain that refuses writes, real password sign-in through the production store (hydrated by its own `hydrate()`), then: refused with `PERSISTENCE_UNAVAILABLE`; screen, SDK and keychain all still A; a friend request from that state lands with sender A = the visible player; relaunch restores A; **positive control** — the same sign-in with a working keychain switches screen, SDK, keychain and a sent request to B together, and relaunch restores B; **token rotation** — persisted with a working keychain, degraded (not refused) for the same player with a failing one; **recovery analogue** — refused before any password changes, proved by signing in with each password; **first creation** — nothing shown |
| `tests/auth/stale-identity-player-state.test.ts` | wire, production stores + real supabase-js + recording transport | 11 | B-R1 cancel / queue (session-read hold AND dispatch-lookup hold) / poll, B-R2, B-R3, B-R4 never sent as B; a positive control per finding (sent as A with A's PINNED token across an unannounced rotation); B-R4 same-player ordering |
| `tests/server/stale-identity-player-state.integration.test.ts` | **real backend**, database readbacks for BOTH players | 7 | the audit's B-R1–B-R4 reproductions inverted, plus the queue dispatch case, plus a positive control each (B's own cancel, Mark all read, equip and privacy changes land on B only) and same-player ordering |
| `tests/notifications/stale-push-retirement.test.ts` | wire, production `push.ts` (native boundary doubled) | 3 | B-R5 never sent as B; a bound retirement behind an in-flight registration completes as A in order; normal departure order |
| `tests/server/stale-identity-push.integration.test.ts` | **real backend**, token-row readbacks | 3 | the audit's B-R5 reproduction inverted (`{owner: B, active: true}` survives), positive controls for A and B, and the queued-departure case (`{owner: A, active: false}`, then B's restoration) |

Every stale case follows the brief's shape: the operation begins as A, the
relevant identity step is held, the account switches through a real sign-in,
the stale work resumes, B's server state is unchanged, A's stale result does not
populate B's client state, and an uninterrupted same-player control still works.
Fixture players are cleaned up (`admin.deleteUser`, token rows deleted).

**One existing test adapted, nothing weakened.**
`tests/matchmaking/take-seat.test.ts` mocked `rpc` as a bare promise; the queue
now pins its credential with `setHeader`, the real PostgREST builder's API. The
mock became builder-shaped, the original notice assertion is unchanged, and the
case now also asserts the request carried the player's own token.

### 19.6 Negative controls — the regressions fail on the audited code

Run in the out-of-repository audited tree (19.1) with the identical test files:

| Tier | Result on audited code | Log |
|---|---|---|
| unit / wire (3 files, 24 tests) | **17 fail**, 7 pass | `$R/negative-control-unit.log` |
| real backend (3 files, 16 tests) | **12 fail**, 4 pass | `$R/negative-control-server.log` |

What passes on the audited code is what SHOULD pass on either: same-player
degrade and non-session never-throw at the storage boundary; relaunch and
same-player rotation; the B-R2 and B-R3 positive controls; B-R5's two departure
controls; and the first-lookup queue case, which the audited `queue()` already
refused (below). The B-R1 positive control and B-R4's ordering control FAIL on
the audited code, because it pinned nothing and ordered nothing. The failures
reproduce each finding with the audit's own values — B-R1 B's search gone
(cancelled) while A's stays `waiting`; B-R2 B `0` unread / A `1`; B-R3 B's
avatar `a773632c-628d-4a02-9fec-3c8336c263e4` (the same item id the audit read)
/ A `none`; B-R4 the stale sync reported `written public`, having written B's
row; B-R5 `{owner: B, active: false}`; B-R6 sign-in `signedIn` under the failing
keychain — plus the queue dispatch gap (B enrolled), the same-player ordering gap
(B ended `public` after choosing `friends`), the recovery analogue and the
unstored first player. The remaining failures in those files are cascades of the
first.

**One regression was found non-discriminating and corrected before this table
was taken.** The first B-R1 queue case held the FIRST credential lookup; the
audited `queue()` already re-checked the scope after its own session read, so it
passed on the audited code. Its real gap is the SDK's SECOND lookup, made for the
request itself; the case now holds that one (wire and server), and fails on the
audited code by enrolling B. The first-lookup case is kept as well.

### 19.7 Analogous paths inspected — bounded to the changed files and callers

| Path | Conclusion |
|---|---|
| `markRead` (single id) | unchanged — explicit id, `user_id = auth.uid()`, not rate-limited: a stale call as B matches no row (the audit's own conclusion, re-read) |
| cosmetics `load` → `grant_earned_cosmetics` | unchanged — idempotent materialisation of what the server derives the CURRENT player has earned; no initiating player's intent is carried. Stale replies are dropped by the scoped setter |
| notifications / loadout / inventory reads | unchanged — reads, dropped by `playerScopedSetter` when stale |
| `takeSeat`, `keepWaiting` | already bound (`session-intent`), or bound through `queue` |
| `registerDevice` | unchanged — the audit accepted its scope capture and in-queue recheck; stale registration must stay refused (19.3) |
| profile-privacy callers (`use-profile-privacy-sync.ts`, Settings) | unchanged — they call the bound function |
| **recovery exchange, first anonymous creation** | the same swallowed write — repaired and proved (19.2) |
| same-UUID securing, token refresh | deliberately degrade as before (19.2); identity cannot split |
| `removeItem` / sign-out | residual recorded (19.2); cannot surface a different player |
| revision-lag window in `bindCurrentPlayer` (B committed to storage, scope not yet bumped) | reviewed, not changed: the SIGNED_IN notify that bumps the scope runs within a few microtasks of the write settling, while a concurrent reader must re-read the whole chunked value behind the per-key queue first. Recorded for the re-auditor, not claimed closed by proof |

No other defect class was looked for; this was not an audit.

### 19.8 Verification (September 29, 2026)

| Gate | Result | Log |
|---|---|---|
| typecheck | pass (`tsc --noEmit`) | — |
| lint | **0 errors / 21 warnings** — identical to the baseline, none in a changed file | `$R/lint.log` |
| full unit suite | **138 files / 2,549 tests pass** (baseline 135 / 2,525, plus the 3 new unit files / 24 tests) | `$R/unit-full.log` |
| every new B-R1–B-R6 regression | **6 files / 40 tests pass** | `$R/new-regressions.log` |
| previous social/table regressions | **4 files / 17 tests pass** | `$R/previous-social-table-regressions.log` |
| Auth / storage / matchmaking / notifications / cosmetics / settings / push areas | **26 files / 370 tests pass**; the audit's 5-file Auth set **5 / 67** | `$R/targeted-areas.log` |
| pgTAP, `check:functions`, coverage, doctor, bundle | not rerun — no database, RLS, Edge Function, dependency or native-config change | — |

### 19.9 The one full `npm run test:server`

`supabase functions serve` was restarted first, per CLAUDE.md (the previous
process was 19h33m old — and was still appending to §17's
`twodev-functions.log`; stopping it added only its 271-byte shutdown lines, and
nothing has written there since). `game-command` answered 401 `UNAUTHENTICATED`
from the function itself before the run.

**Result: 31 files; 30 passed, 1 failed to collect; 342 tests passed, 0
failed.** Duration 234 s, load 3.1 before and 7.8 after (`$R/server-full.log`,
`$R/server-full-uptime.txt`).

The one file, `entry-response-loss.integration.test.ts`, never ran: its
import-time stack-guard probe did not get its 401 inside 5 s. **Classified
ENVIRONMENT, from the runtime's own log** (`$R/functions-serve.log`): the run
logged 37 CPU soft-limit and **2 hard-limit** events, and at 23:19:24Z and
23:19:56Z the supervisor killed a worker and cancelled its in-flight requests
(`request has been cancelled by supervisor`). The probe traffic — identifiable
by its fixed nonexistent-account token — is logged for 29 files; the missing
probes coincide with those cancellations. This is the failure mode CLAUDE.md
records ("the stack guard's 5 s probe landed inside a CPU time … window"), the
file exercises Edge Functions this batch did not touch, and no assertion failed
anywhere in the run.

Per the brief the broad suite was not rerun to obtain green. The one uncollected
file was then run on its own: **1 file / 14 tests pass**
(`$R/server-uncollected-file-rerun.log`). Every one of the 356 server tests in
this tree (the baseline 340 plus these 16) has therefore passed against it, with
the one environmental collection failure stated.

### 19.10 Native Release evidence: what this repair made stale, and what was renewed

**The §16.8 binary was stale, measured.** §17's own `twodev-freshness.py`, run
against `9a7d0bf3c99ae093…` before building (`$R/prebuild-freshness.txt`):
exactly the 8 files of 19.4 content-changed, 0 added, 0 removed. A fresh Release
build was therefore made; nothing below rests on an older binary.

#### 19.10.1 The fresh iOS Release build

```
LANG=en_US.UTF-8 npx expo run:ios --configuration Release \
  --device D16C4292-670D-4036-BDB1-2E9B31B11D3D --no-bundler
```

| Claim | Evidence |
|---|---|
| **Build Succeeded, 0 errors / 3 warnings**, installed on device A | `$R/release-build.log` |
| Configuration is **Release**, re-bundled | `Release-iphonesimulator/Arc21.app`; the bundle phase logged `Eager bundle does not match new options, bundling again` |
| Nothing could serve a different bundle | `lsof -ti:8081` empty before the build, after it, and after the last flow (`$R/release-build-host.txt`, `$R/build-freshness-after-flows.txt`) |
| The binary is this tree | `$R/build.json` (`$R/build-fingerprint.py`, the `repair-build.json` method): bundle SHA-256 **`3eba8f7c5ae685297811683e8e5ef68c3c44076649cfedbb5549892dc62cd422`**, 6,402,721 bytes, built 2026-09-29T23:32:26Z, **246 sources, 0 newer** |
| **Both** simulators carry it | the installed `main.jsbundle` in device A's and device B's containers both hash `3eba8f7c…` (`$R/build-fingerprint.txt`) |
| Positive control only | this repair's `session_not_persisted` and `SessionReplacementError` message are present in the Hermes bytecode (1 hit each), and §16's table-repair string still is. A string scan cannot prove absence (CLAUDE.md) |
| No production source moved during the pass | re-checked after the last flow: bundle identical, **0 changed / 0 added / 0 removed / 0 newer** |

Load peaked at 132 during compilation; no flow ran until the one-minute load was
below 12, and every flow log records the host either side.

#### 19.10.2 Which native evidence the eight files touch

| Changed path | Native gate that exercised it | Decision |
|---|---|---|
| storage FIRST write (anonymous creation) | `fresh-player` (§14 row 1, §16.8, §17) | **renewed** on both devices |
| storage restore on relaunch | `cold-player` (§14 row 2) | **renewed** |
| storage SAME-player write (token rotation) | §14.5 row 2b | **renewed** — four rotations by the SDK itself on the new binary, then a cold relaunch onto the rotated credential |
| storage identity-changing write (sign-in replacement — B-R6's success path) | `sign-in-existing` (§14 row 9) | **renewed** inside `public-matchmaking.yaml`, whose `sign-in.yaml` IS `refresh-b/sign-in-existing.yaml`, through the product's own replacement warning; followed by a protected mutation (`social-send`) |
| B-R1 queue / poll / Keep Waiting / cancel | §14 and §17 public rows (queue, match, seat, leave-and-rejoin); `public-matchmaking.yaml` | **renewed**: the whole client surface on one device, and the allocation path on two |
| B-R2 Mark all read | **none** — no flow in the repository has ever tapped it | not a native gate: proven at the wire and against the real backend (19.5) |
| B-R3 equip | **none** — `every-screen-online` loads the inventory and never equips | same |
| B-R4 privacy | the Settings control: no flow changes it. The ROOT sync runs in every online flow | the normal path was **observed** natively: both fresh players read `privacy = private` although the column defaults to `public` — written by the bound, pinned sync on this binary. The stale path is proven below the native tier |
| B-R5 retirement | **unreachable in this build**: `app.json` has no EAS project id, so `retireDevice()` returns before any network call | proven at the wire and against the real backend with the native boundary doubled (19.5), as the audit did |
| every failure path (keychain refusing writes, forced account switches) | cannot be staged on a simulator | proven at the SDK / server tiers by design |

#### 19.10.3 Flows, with step counts from each run's `commands.json`

Device A: iPhone 17 Pro `D16C4292…`; device B: iPhone 17 Pro Max `064733EE…`, both
booted HEADLESS (§17.1's method). One driver at a time. Evidence
`$R/native-<name>.{log,xml}` and `$R/native-<name>/`; readbacks `$R/state-*.txt`.

| Proof | Flow | Device | Result | C / F / S | Server-side readback |
|---|---|---|---|---|---|
| fresh pseudonymous player, first keychain write | `refresh-b/fresh-player.yaml` | A | **FAIL** 40 s — lost tap, see 19.10.4 | 6 / 1 / 0 | — |
| same, rerun on the same fresh-install state | `refresh-b/fresh-player.yaml` | A | **pass** 22 s | 15 / 0 / 1 | `agile_dove_360335` `cf27ba36-de7e-4482-a8ab-bd626fb90e89`: anonymous, no email, **privacy `private`**, 25,000 = ledger, **1 grant**, exactly one user since the reset, one session (`state-01`, `state-02`) |
| token rotation by the SDK itself | the app left running | A | four rotations | — | ONE session row `2a94df14…` created 23:37:01Z, `refreshed_at` 03:35:30Z, **5 refresh tokens / 4 revoked** — rotation, not re-sign-in; the keychain holds the committed head and generation it rewrote (`state-01`) |
| cold relaunch onto the rotated credential | `refresh-b/cold-player.yaml` `HANDLE=agile_dove_360335` | A | **pass** 14 s | 9 / 0 / 1 | still one user, one session, no new token (`state-03`) |
| **account replacement (B-R6 success path) + B-R1 queue → wait → Keep Waiting → Cancel** | `public-matchmaking.yaml` (pool drained first: 6 rooms closed, 28 entries expired, `state-04`) | A | **pass** 2 m 14 s | 53 / 0 / 5 | one new session for `witty_crane` (the `e2e-lobby` fixture) — GoTrue `login`, actor `adec8953…`, 03:39:41Z; the replaced `agile_dove_360335` **still exists, anonymous, unmerged, wallet untouched**; exactly one `casual` queue row, **owned by `witty_crane`**, **`cancelled`**, **0 ledger rows** — nothing charged (`state-05`) |
| a protected mutation after the replacement | `refresh-b/social-send.yaml` `OTHER=agile_dove_360335` | A | **pass** 16 s | 12 / 0 / 1 | `friend_requests`: **sender `witty_crane`** — the player on screen — to `agile_dove_360335`, `pending` (`state-06`) |
| second fresh pseudonymous player | `refresh-b/fresh-player.yaml` | B | **pass** 28 s, first run from a fresh install | 15 / 0 / 1 | `fair_quail_267511` `56f24139-15eb-4df9-944d-6490c420b05c`: anonymous, **privacy `private`**, 25,000 = ledger, 1 grant, 1 session (`state-07`) |
| queue, not charged | `two-client-public-queue.yaml` | A | **pass** 30 s | 10 / 0 / 2 | pool empty before (`state-08`) |
| matched by B's poll, seat taken, buy-in on taking it | `two-client-public-join.yaml` | B | **pass** 37 s | 13 / 0 / 2 | see next row |
| **both players in ONE public game**, A's screen shows B | `two-client-public-seat.yaml` `OTHER=fair_quail_267511` | A | **pass** 1 m 1 s | 20 / 0 / 77 | game `925f2208-c0a5-43cb-8888-2712690e754c`: `fair_quail_267511` index 0 and `witty_crane` index 1, both `active`; both queue rows owned by their own players and matched to the same room `76459402…`; each wallet debited exactly **2,000**, wallet = ledger for both (`state-09`) |
| cold relaunch, cash-out, **re-queue and re-seat**, leave again | `two-client-public-leave.yaml` | B | **pass** 2 m 1 s | 29 / 0 / 3 | B's two seat rows at the same table both settled `left`; both of B's queue rows released `cancelled`; A still `active`; B 25,090 = ledger (−2,000 +2,070 −2,000 +2,020) (`state-10`) |
| cleanup (harness, not evidence) | `scripts/e2e-account.ts` cashed out `witty_crane` | — | — | — | all seats `left`, game `completed`, room `closed`; 24,960 and 25,090 = ledger (`state-11`) |
| aggregate over EVERY wallet | — | — | — | — | before **3,935 users / 3,935 wallets / 0 wallet≠ledger / 0 negative / 0 grant-count≠1**; after **3,937 / 3,937 / 0 / 0 / 0** — exactly the two players this pass created (`state-00`, `state-12`) |

#### 19.10.4 The one failed run, classified

`fresh-player` on device A, first attempt: `Assertion is false: id: header-chips is
visible` after the `onboarding-guest` tap reported COMPLETED. **Classified
HARNESS — a lost tap — on direct evidence, not by rerunning until green:**

- **The tap's handler never ran.** "Start playing" does nothing but write
  `onboarding:completion` and navigate. The app's own SQLite store held
  `auth:guest:v1`, `practice:session`, `practice:stats` and **no**
  `onboarding:completion`; after the rerun's tap, it did.
- **The app was alive and correct throughout** — same process hours later, no
  `Arc21-*.ips` crash report, screenshot `$R/fresh-player-A-state-after-pause.png`.
  Its launch-time bootstrap had created the player (GoTrue `/signup` 200 at
  23:37:01Z) and COMMITTED its session: the device keychain held exactly the
  adapter's head `sb-127-auth-token`, one generation descriptor and two chunks
  (identified by SHA-1 of the adapter's key names under service `app:no-auth`).
  This is the path this repair changed, working natively.
- The tap landed about 0.7 s after that signup, while the five-minute load was
  still ~32 from the Xcode build — the pattern CLAUDE.md records for this very
  button ("the single `tapOn: onboarding-guest` occasionally did nothing").

The rerun continued the same fresh-install state rather than resetting it:
`launchApp` cold-relaunched the app onto its stored credential with onboarding
still pending, and it passed. Device B's `fresh-player` then passed first time
from a fresh install. A usage-limit pause separated the first attempt (23:37Z)
from the rerun (03:36Z); that is why the rotation row counts four rotations.
No flow, selector, timeout or assertion was changed.

#### 19.10.5 Not renewed natively, and why

- **Mark all read (B-R2), equip (B-R3), the Settings privacy control (B-R4) and
  push retirement (B-R5)** — never exercised by any native flow, or unreachable
  in this build (19.10.2). Documented rather than answered with a new E2E suite,
  as the brief directs; the maintained regressions in 19.5 are their proof.
- **Securing (§14 rows 8), recovery (row 9), deletion, link-conflict,
  replacement-cancel, offline Practice/reconnect, private rooms, the stack reset,
  `online-table`, the survivor row** — not invalidated in behaviour: they run
  table, room, securing and recovery code this batch did not change, and their
  storage writes take the SUCCESS branch renewed above (first write,
  same-player write, identity-changing write). They were not rerun.
- **Mid-hand native cash-out** remains NOT RENEWED, exactly as §18.4 records.

### 19.11 Environment, and its restoration

- `supabase functions serve --no-verify-jwt` restarted before the server suite
  (19.9) and left RUNNING, logging to `$R/functions-serve.log`; both functions
  answer 401. §17's `twodev-functions.log` stopped growing at 5,527,236 bytes
  when the old process exited (its last 271 bytes are that shutdown).
- The four admin sidecars (`studio`, `pg-meta`, `analytics`, `vector`) were
  stopped for the two-device flows at 03:42:35Z — §17.1's method — and restarted
  afterwards; all twelve containers are up and healthy
  (`$R/environment-sidecars.txt`).
- Both simulators were found shut down, booted headless for the pass, and shut
  down again. The Release product `3eba8f7c…` is installed on both.
- The public pool was drained once before the matchmaking flows (`state-04`);
  the database was **not** reset. No hosted Supabase setting, datum or
  deployment was touched.
- Left behind deliberately, as in §8 and §14.8: `agile_dove_360335` and
  `fair_quail_267511` are unlinked players whose only credentials were on
  simulator keychains; the friend request `witty_crane → agile_dove_360335`
  stays pending. Every maintained regression deletes its own fixtures.
- Anonymous sign-ins are rate-limited locally (30 per hour per IP); this pass
  budgeted them, and no test or flow was refused for it.

### 19.12 Residuals and remaining blockers

**No known unrepaired instance of B-R1 through B-R6.** No other blocker was
looked for: this was a bounded repair, not an audit. Recorded residuals, for
the re-auditor to weigh:

1. **Sign-out whose keychain delete fails** (19.2): no player shown, the
   previous credential still stored; cannot surface a different player.
2. **A native write that APPLIES its value yet reports failure, with the
   read-back also failing and storage recovering later in the same process.**
   The adapter then refuses (keeps the old player shown) while storage would
   later serve the new one. iOS cannot produce the first half —
   `SecItemAdd`/`SecItemUpdate` apply or fail as a unit, read from
   `expo-secure-store` 57.0.4's source — and Android is external and unproven
   (§18.5).
3. **The `bindCurrentPlayer` revision-lag window** (19.7): reviewed, not
   changed, not claimed closed by proof.
4. **B-R5's bound-retirement completion** (19.3) — a deliberate choice that
   differs from the audit's suggested in-queue recheck; argued and measured, and
   the audit should attack it.

Everything §18.5 classifies B or C (Android, physical devices, CAPTCHA on
hardware, hosted activation, APNs/FCM/EAS delivery, the unconfigured build,
native mid-hand cash-out, lint warnings) is unchanged by this pass.

### 19.13 What Astra must independently re-audit

1. **B-R6's rule, against the installed SDK.** That every adoption path in
   `@supabase/auth-js` 2.112.3 saves before it notifies and rethrows a non-Auth
   error; that the identity-scoped rejection cannot be defeated through the
   same-player degrade branch; the read-back comparisons; the crash-boundary
   property; and the reason `removeItem` stays non-throwing.
2. **The recovery analogue**: re-measure `$R/b-r6-recovery-analog-prefix-probe.*`
   on the audited tree and the regression on this one.
3. **B-R1–B-R5**: each binding is the first await of its method; follow-ups are
   gated on the same binding; B-R4's lane (ordering, restart on a player change,
   no cross-player wait); B-R5's completion choice.
4. **That every new regression fails on the audited code** (19.6) — rebuild the
   shadow rather than trusting `$R/negative-control-*.log` — and the one case
   found non-discriminating and corrected.
5. **The classifications**: the uncollected server file (19.9) and the lost tap
   (19.10.4), from their artefacts.
6. **The native scope decisions** (19.10.2, 19.10.5) and the freshness claim —
   rebuild and compare rather than trusting `3eba8f7c…`.
7. The residuals in 19.12.

### 19.14 Exact state

- Branch `astra-refresh-b`, HEAD **`47dba201ace488d932bb4e479416f52f79a6f176`**,
  everything uncommitted; the index is empty. Nothing committed, pushed,
  merged, deployed or rewritten; no hosted change; no Refresh C/D/E work.
- `AGENTS.claude-backup.md` remains intentionally untracked and untouched.
- Production files changed by this pass: the **8** in 19.4 (seven tracked, plus
  the untracked `player-binding.ts`, comment only).
- Tests: **6 new files** (19.5) and one adapted mock
  (`tests/matchmaking/take-seat.test.ts`); no assertion, timeout, retry policy,
  rate limit or worker count weakened.
- Documentation: this section; §§1–18 are unchanged above it.
- Release binary `…/Build/Products/Release-iphonesimulator/Arc21.app`, bundle
  SHA-256 `3eba8f7c5ae68529…`, corresponds to this tree as `$R/build.json`
  fingerprints it.
- **Refresh B is NOT claimed to pass.** §18 remains the standing verdict; this
  section is an unreviewed repair and the evidence for it. A fresh independent
  re-audit is required.

## 20. Final independent re-audit — September 30, 2026

**ASTRA REFRESH B: FAIL**

**Three confirmed current release-blocking software findings: B-F1, B-F2,
B-F3. No checkpoint commit.** The audit continued after each finding and completed
the remaining independent surfaces. This supersedes §18's current verdict and
adjudicates §19's repair claims; all earlier FAIL/repair history remains intact.
No production code or maintained test was edited. One primary agent, no
subagents, no Goal mode, no Refresh C/D/E.

Branch and starting/final HEAD: `astra-refresh-b`,
`47dba201ace488d932bb4e479416f52f79a6f176`. No upstream is configured.
The index was empty at the start and remains empty.

Evidence for this audit is outside the repository:
`/Users/tj/arc21-evidence/astra-refresh-b-final-20260930/` (**`$F` below**).
The repair evidence was located at
`/Users/tj/arc21-evidence/astra-refresh-b-20260915/consolidated-repair-20260929/`
(**`$R` below**), not the separate `astra-refresh-b-repair-20260929` path in the
brief. The latter does not exist. `$F/findings.json` is the machine-readable
consolidated finding set. Scripts, fault injection and readbacks are retained.

### 20.1 B-R1 through B-R6: independent conclusions

| Finding | Result on current production code |
|---|---|
| **B-R6 — failed A → B storage replacement** | **Original defect repaired.** Real GoTrue/store/SDK tests refuse adoption before notification when the keychain still serves A; successful replacement and relaunch agree on B. Recovery refuses before changing either account's password. The broader credential-cleanup architecture is **not approved**, because B-F2 is confirmed. |
| **B-R1 — matchmaking** | **Repaired.** Cancellation, queue and mutating poll bind before their first await; queue's readback retains the same binding. The corrected dispatch-lookup test actually distinguishes old/new code. Real database readbacks preserve B's queue; positive controls work. |
| **B-R2 — Mark All Read** | **Repaired.** Bulk update has the initiating credential pinned and its reload is scope-gated. Both players' database unread counts are asserted. Single-row `markRead` has an explicit notification ID and server ownership filtering, so a substituted identity cannot consume another inbox. |
| **B-R3 — equip** | **Repaired.** Credential is pinned even when both accounts own the same cosmetic; stale inventory/loadout follow-ups are discarded. Real backend assertions and uninterrupted controls pass. |
| **B-R4 — privacy** | **Exact helper-level cross-player reproduction repaired; product surface NOT fully repaired.** Direct calls bind actor and target consistently. B-F1 breaks ordering after timeout; B-F3 bypasses the intended initiation boundary in the actual Settings caller, including a reproduced cross-player overwrite. |
| **B-R5 — retirement** | **Repaired.** Bound departure may finish as A after a switch. `retire_push_token` predicates on BOTH token and `auth.uid()`; it cannot deactivate B's row. The device mutation lane retains the actual operation even after a caller timeout. An additional probe let A bind, held its native token result, registered B completely, then released A: B remained active. |

The previous social/table repairs remain intact: **4 files / 17 tests pass**,
including real backend actor/seat assertions. Friends/rooms/table gateways pin
per-request credentials; table retries retain the initiating credential and
request ID and refuse stale retries. Scope setters discard stale replies.
The storage repair did not remove these protections.

### 20.2 Consolidated confirmed blockers

#### B-F1 — High: timeout releases privacy ordering while the old write is live

**Affected:** `src/features/settings/profile-privacy.ts:116` and `:137`, using
`src/lib/supabase/with-timeout.ts`.

**Reproduction:** Use one real authenticated player. Start `public`; hold the
actual authenticated PostgREST PATCH before delivery, without mocking the SDK or
server. Immediately call `private`. At the unchanged **8,000 ms** timeout the
older call returns `failed/unreachable`, which resolves the lane's tail. The
newer PATCH succeeds and the database reads `private`. Release the old PATCH:
the database becomes **`public`**. Measured elapsed time: 8,337 ms.

**Violated invariant:** an older delayed privacy write must not overwrite the
newer intended and acknowledged private state. The queue orders bounded waits,
not actual writes. This is a product/privacy defect, not a test or host timeout.

**Evidence:** `$F/residuals.probe.test.ts`,
`$F/residuals-probe-verified.log`, `$F/probe-results.json` (`privacy`). Native
transport is the delay seam; authentication, production sync and database writes
are real. The probe asserts the defect and therefore exits successfully.

**Smallest repair scope:** preserve ownership/order of the actual privacy
operation after the UI wait expires, and ensure an unresolved old write cannot
overwrite a newer acknowledged choice. A local timeout or abort alone is not a
server verdict. Maintain a delayed-delivery/timeout regression.

#### B-F2 — High: failed credential removal can report successful sign-out

**Affected:** `src/lib/supabase/secure-session-storage.ts:163` and `:294`,
`src/features/auth/supabase-auth-adapter.ts` (`signOut`, `deleteAccount`), and
Auth-store adoption/hydration.

**Reproduction:** Persist A through the production secure-storage factory;
hydrate the real production Auth store on a real SDK/GoTrue client. Make only
the native keychain deletion reject. Call production `signOut(A)`. Before the
call returns, the durability history is **`unavailable → durable`**; the final
form is **`idle`**, the shown player is **null**, and the SDK still restores A.
A fresh client/hydration restores A. A production friends-store request then
commits with **A as the sender**. This is not merely an inaccessible token left
on disk or a visibly refused sign-out.

A second native double makes deletion resolve without deleting, reflecting the
installed iOS wrapper's ignored `SecItemDelete` return statuses. It produces the
same successful-looking sign-out and restores A. Physical Keychain failure was
not induced; the fault injection is at the native boundary, with all production
layers above it intact.

The account-deletion analogue was also measured: server deletion succeeds and
`auth.users` contains **zero** rows for A, but failed local cleanup leaves A in
storage and a cold hydration **adopts the deleted UUID**. No server account,
wallet or privileges were resurrected; this is another manifestation of the
same removal/adoption defect, not a separate finding.

**Cause and violated invariant:** `removeItem` swallows failure, allowing
`SIGNED_OUT(null)` while its next read still serves A. Unlike a failed write,
failed removal has no sticky state; `read` can report the surviving credential
as durable. The SDK's own SIGNED_OUT handling calls Realtime `setAuth()` and
reads the credential again. The adapter's later global durability check is
therefore not a reliable removal verdict. Successful sign-out must not retain
and restore usable departed credentials; the no-player screen and authenticated
SDK must not disagree. The ordinary expiry of an already-issued access token is
not the defect—the app continues serving and re-adopting that credential.

**Evidence:** `$F/probe-results.json` (`signoutThrows`, `signoutSilent`,
`accountDeletion`), `$F/residuals.probe.test.ts`,
`$F/signout-diagnostic.probe.test.ts`, `$F/signout-diagnostic-results.json`,
`$F/signout-diagnostic.log`. The diagnostic captures the state immediately after
sign-out, **before** its own SDK read, confirming that the audit did not create
the durability reset. Fixture cleanup is asserted and recorded as zero rows.
Installed `expo-secure-store/ios/SecureStoreModule.swift` ignores the three
`SecItemDelete` statuses; installed SupabaseClient `_handleTokenChanged` performs
the Realtime refresh on SIGNED_OUT. Supabase documents that issued access tokens
remain valid until expiry: [sign-out reference](https://supabase.com/docs/reference/javascript/auth-signout).

**Smallest repair scope:** make credential removal an explicit, verified outcome
that reads cannot erase; do not report successful departure or re-adopt retained
credentials after failed cleanup. Cover rejected and silently unsuccessful
native deletes, process/relaunch behavior and confirmed-account-deletion cleanup.
Preserve the SDK's non-deadlocking refresh cleanup; simply throwing from every
`removeItem` is not a sufficient repair design.

#### B-F3 — High: Settings binds privacy only after its local-save await

**Affected:** `app/settings/index.tsx:81` (`changeVisibility`),
`src/features/settings/use-settings.ts` (`update`), and the shared ownership of
sync between that caller and `use-profile-privacy-sync.ts`.

**Reproduction:** A chooses `public` in the current Settings callback. Hold the
completion of its local settings save; the optimistic setting has already
changed. Let the root sync run for A. Switch to B through the real production
sign-in store; B chooses `private` and both B's screen/root syncs complete. The
database reads B = `private`. Release A's old local save. Its callback now calls
`syncProfilePrivacy(public)` for the first time, captures **B**, and changes B to
**`public`**, while the latest local preference remains **`private`**.

Also reproduced with one player and no switch: delayed completion of the older
save enqueues its `public` sync after the later `private` choice. This case does
not require B-F1's network timeout.

**Violated invariant:** the initiating player and intent order must be captured
before the UI operation's first await. A correct binding inside a later-invoked
helper does not recover the original actor or the original order. The root hook
cannot repair this late duplicate write: no setting/identity changes when the
old callback resumes, so there is no new effect to restore the private value.

**Evidence:** `$F/settings-handler-extracted.ts`,
`$F/settings-caller.probe.test.ts`, `$F/settings-caller-results.json`,
`$F/settings-caller.log`: two reproduced database overwrites. To avoid substituting
a hand-written approximation, the probe parses the current screen with the
TypeScript AST, extracts and transpiles the **actual current callback**, then
executes it with the production settings store and privacy sync. Only native
settings persistence completion and audio/haptics are doubled; account switching,
SDK and database are real. Root sync invocations are explicitly driven, not
claimed to be a mounted React/native E2E flow.

**Smallest repair scope:** bind/capture the screen's intent before local-persistence
awaits, or eliminate the stale duplicate screen sync in favor of one owner that
preserves identity and order. Add maintained regressions reaching this caller
and its interaction with root sync, for both account-switch and same-player
ordering. Repairing only the helper's timeout lane does not fix B-F3.

### 20.3 Credential replacement and documented residuals

| Required challenge | Independent adjudication |
|---|---|
| Normal A → B replacement | Real SDK/backend positive control, protected request and relaunch all B. |
| Replacement fails before durable change | Refused; visible/SDK/durable identity all A; backend request sent as A. |
| Native write lands but reports failure, readback works | Adapter accepts the value it actually serves; maintained test covers this. A readback alone is not proof of physical flush durability on a platform whose memory and disk diverge. |
| New bank succeeds, head fails | Previous head/bank remains intact; new identity rejected. |
| Head commits, old-bank cleanup fails | `committed` remains true; complete new bank is served; cleanup does not roll back identity. |
| Interruption/relaunch at replacement stages | Maintained fault-boundary test checks complete A or B after every native mutation. If the process dies just after commit, no surviving UI adoption is assumed. Existing storage tests also cover legacy/chunk cleanup and serialization. |
| Same-player token refresh | Identity unchanged with successful or degraded persistence; real backend controls pass. Token durability failure is reported, not a claim that the new token was saved. |
| Same-UUID securing | Installed SDK saves before USER_UPDATED/SIGNED_IN; same UUID is required by detached verification/adoption. No new identity is introduced by the tolerated same-player failure branch. Earlier securing acceptance remains valid. |
| Recovery changing credentials | Real recovery exchange failure is refused before `updateUser`; both old passwords are checked. The shadow still reproduces the vulnerability. |
| Sign-out deletion failure | **B-F2**, not an accepted residual. The claim that failure cannot matter because no different player is shown is insufficient: apparent successful sign-out leaves usable A and relaunch re-adopts A. |
| Account deletion cleanup failure | Server deletion holds, but deleted identity is re-adopted locally; included in **B-F2**. |
| Applied-write error plus unreadable readback, later recovery | Logically still capable of old-visible/new-stored disagreement. The inspected iOS set/update implementation has no failure-throwing step after a successful native write; not reproduced on iOS. Android's memory-before-commit behavior is outside the previously accepted iOS scope and remains **external/unproven**, not labeled universally safe. |

The installed SDK (auth-js 2.112.3) awaits `_saveSession` before notifying on the
relevant sign-in, setSession, recovery and user-update paths, and propagates the
non-Auth replacement error. The production adapter classifies it as
`PERSISTENCE_UNAVAILABLE`. The storage's bank protocol, serialization and
`storedPlayerOf` comparison were inspected directly, not inferred from green
tests. Context7/official SDK documentation was a cross-check; installed source
was the version-specific authority.

**Binding timing:** the SDK `fetchWithAuth` awaits its own current-token lookup
but only fills Authorization when absent. A pinned A header therefore remains A
even when B becomes current immediately before transport dispatch. Explicit
row targets use the same bound UUID. Revision checks/production setters prevent
late results populating B. Root installs its synchronous identity-change
subscription before hydration. `$F/binding-timing.probe.test.ts` initiated
**216** binding reads around real keychain set/delete stages during six real
replacements; all returned `identity-changed`. This supports the inspected
serialization/notification ordering; it is not a universal proof for unsupported
storage platforms. No additional normal-operation binding TOCTOU defect was
confirmed. B-F2 and B-F3 are distinct failures outside that successfully bound
request window.

**Push completion:** the intentional post-switch retirement is sound for A → B.
`mutateDevice` chains the actual promise, unlike B-F1's lane. Stale registrations
are refused before entering their mutation; a bound retirement's A credential
cannot match B's restored row. `$F/push-bound-late.probe.test.ts` and
`$F/push-bound-late-results.json` add the previously unmeasured ordering where B
finishes registering BEFORE A's already-bound retirement is released: B stays
`{owner: B, active: true}`. Physical Expo delivery remains external.

### 20.4 Verification and regression quality

| Current independent verification | Result / evidence |
|---|---|
| Typecheck | PASS, `$F/typecheck.log` |
| Lint | 0 errors / 21 warnings, `$F/lint.log`; no auto-fix |
| Full unit suite, constrained to two workers | **138 files / 2,549 tests PASS**, `$F/unit-full.log` |
| Six repair regression files | **40 PASS** (24 unit/wire, 16 real backend), included in `$F/maintained-57.log` |
| Previous social/table regressions | **4 files / 17 PASS**, same log; total 10 files / 57 |
| One uninterrupted full server command | **31 files / 356 tests PASS**, 328.27 s, `$F/server-full.log`; no stack reset or rerun-to-green |
| External independent probes | Storage/privacy residuals: 4; actual Settings caller: 2; binding timing: 1; late bound push: 1. These **8** assertions include assertions that defects exist. Sign-out diagnostic separately repeats only the removal case to locate the status reset. |
| Negative unit/wire controls on preserved audited shadow | **17 fail / 7 pass**, `$F/negative-unit-reverified.log` |
| Negative real-backend controls on same shadow | **12 fail / 4 pass**, `$F/negative-server-reverified.log` |

The shadow is outside the worktree. Its relevant eight production hashes match
the repair's pre-build fingerprints (`$F/negative-source-hashes.json`), and the
six new regression files match current files. It was executed without modifying
the live worktree or weakening tests. Some unit failures are missing newly
exported symbols, so those alone would be weak negative evidence; the transport
assertions and twelve real-backend failures reproduce the actors/state changes,
including recovery changing the wrong password. The corrected matchmaking
second-lookup test fails on the old dispatch behavior. Positive controls that
should survive old code do survive.

The maintained regressions genuinely reach the real authentication/storage and
server mutation boundaries. Their principal gaps are now concrete: no privacy
write held beyond its timeout, no current Settings caller before helper entry,
and no production-factory sign-out deletion-failure case. They are credible but
not complete enough to establish final PASS.

One initial **audit-only harness** run completed all four residual assertions
but its cleanup tried to admin-delete the user already deleted by the product,
received 404, and stopped before writing its results. That log is preserved as
`$F/residuals-probe.log`. Cleanup was corrected only in the external probe to
accept the known already-deleted row and verify no fixtures remain; results were
then preserved in the verified run. No maintained test was changed.

The repair's earlier 30/31 server result was an environment collection failure:
its log names `entry-response-loss.integration.test.ts`, the Edge runtime logged
WORKER_LIMIT, and the omitted current file independently passed 14 tests. The
current uninterrupted 356-test pass supersedes that limitation. No pgTAP or
migration reset was needed: these repairs did not change their dependencies.

### 20.5 Native evidence and its actual limits

The archived Release product still hashes
`3eba8f7c5ae685297811683e8e5ef68c3c44076649cfedbb5549892dc62cd422`.
Re-running the fingerprint comparison found **246/246 sources, zero changed,
added, removed or newer** (`$F/native-freshness.txt`). Build log shows a new bundle
and Build Succeeded; reported 0 errors / 3 warnings is consistent with it.
No Metro listener was present during this audit.

The preserved ten flow XML files contain nine passes and the documented first
fresh-player failure. Their logs/readbacks establish creation, four refresh
rotations, cold relaunch, replacement and subsequent friend request as the shown
player, matchmaking/keep-waiting/cancel, two-device matched seats, and leave/rejoin
with reconciled wallets. The failed first tap remains classified harness from
its no-onboarding-write evidence and subsequent same-state run, not relabeled a
pass. No native flow was rerun in this audit.

Simulator B's installed bundle was independently re-hashed and matches. The
recorded simulator A bundle path no longer exists and there is currently no
`Arc21.app/main.jsbundle` under A's application bundle directory. The original
matching-A-install claim is accepted as **preserved historical evidence**, not
claimed re-measured now. `$F/native-artifact-review.json` records this distinction.
The unchanged archived product and source fingerprints establish source/build
freshness; an absent current installation is not evidence of a source regression.

Mark All Read, equip, the Settings privacy control and push retirement are **not
native E2E passes**. Lower-level production SDK/backend tests are sufficient for
the identity guarantees on Mark All Read, equip and bound push retirement in
this bounded audit. Settings privacy is specifically NOT approved because the
missed caller boundary is now a reproduced defect. Physical storage failures,
Expo push/APNs/FCM/EAS, Android, hardware CAPTCHA and the unconfigured-build
native case remain unproven/external as before. Mid-hand native cash-out was not
renewed. Normal-flow Release evidence does not override B-F1–B-F3.

### 20.6 Integrity, patch hygiene and final state

Final aggregate database readback (`$F/integrity-final.txt`): **4,434 users /
4,434 wallets; 0 wallet/ledger mismatches; 0 negative balances; 0 opening-grant
counts other than one**. This renews the invariant over the current database,
whose size changed through requested test runs. No users were created just to
inflate that number; the new audit probes delete their own fixtures.

The baseline tracked patch was preserved in `$F/start-tracked.patch`; immediately
before writing this record it was **byte-for-byte unchanged**. Repair production
hashes still match the Release record. Tracked scope/configuration/dependency
changes and intended untracked additions were checked; no new engine, settlement,
server-command, RLS or economic bypass was introduced by the eight-file repair.
The earlier accepted migration/handle/same-UUID/no-merge/no-import conclusions are
not reopened. This is not approval to checkpoint the failing patch.

The candidate-file secret scan covered 145 files: only published local-demo JWTs
and a deliberately fake `sb_secret_abcdef0123456789` refusal-test fixture were
flagged (`$F/patch-hygiene.json`). No real staged credential was found; **nothing
is staged**. `AGENTS.claude-backup.md` remains untracked and untouched. All audit
probes/evidence remain outside Git. `git diff --check` passes. Final inspection of
status, diff and cached diff confirms this session's only repository edit is
this documentation record.

Hosted activation is still outstanding: migration deployment; anonymous Auth,
manual linking and confirmed email; OTP/email-change templates and SMTP;
`arc21://auth/recovery`; public hCaptcha site/origin and private Auth secret;
signup limits/monitoring; hosted PostgREST compatibility; physical EAS/APNs/FCM
configuration and validation. None was activated or claimed passed here.

**ASTRA REFRESH B: FAIL**

**Current consolidated blocker set: B-F1, B-F2, B-F3.** No commit, push, merge,
deployment, hosted mutation, reset, stash, clean or history rewrite. Refresh
C/D/E has not begun. A separate bounded repair should address these three
production boundaries and renew only the proof their changes invalidate.

## 21. Final bounded repair of B-F1, B-F2 and B-F3 — September 30 to October 3, 2026

**This is a repair record, not a verdict. Refresh B is NOT claimed to pass.**
§20's FAIL and its three findings are preserved above exactly as written, as is
every earlier FAIL, repair and piece of evidence. One primary agent, no
subagents, no Goal mode, no Refresh C/D/E. Branch `astra-refresh-b`, HEAD still
`47dba201ace488d932bb4e479416f52f79a6f176`; nothing committed, pushed, merged,
deployed, reset, stashed, cleaned or rewritten; no hosted Supabase setting,
datum or deployment touched. `AGENTS.claude-backup.md` remains intentionally
untracked and untouched. The work began on September 30 and resumed on October
3 after a usage-limit pause; the tree was re-verified on resumption.

Evidence is outside Git in
`/Users/tj/arc21-evidence/astra-refresh-b-final-repair-20260930/` (**`$X`
below**). The audit's own directory (`$F`) was read, never written: its probes
were COPIED into `$X/audit-probes-rerun/` before being run again.

### 21.1 Starting state, verified rather than assumed

- The tracked diff from `47dba20` hashed `55bc51ab…`, byte-identical to the
  audit's `$F/final-tracked.patch`; `git status` hashed `bb9add48…`, identical
  to `$F/final-status.txt`; the index was empty. The three findings therefore
  applied to exactly this tree. Start-time copies: `$X/start-tracked.patch`,
  `$X/start-status.txt`, `$X/start-untracked-sha256.txt` (46 untracked files).
- This record hashed `c0baef7d…` before this section was added.
- The other long-running `claude` process on the host was checked: it is this
  session itself; the second one runs in an unrelated directory. Nothing else
  wrote to this repository.

### 21.2 B-F2 — credential teardown: root cause

Read from the installed SDK (`@supabase/auth-js` 2.112.3) and the audited code:

1. `ChunkedSecureSessionStorage.removeItem` swallowed every failure, and a
   silent one — the installed iOS wrapper ignores `SecItemDelete`'s status — was
   not even a failure to it. It reported nothing a caller could act on.
2. GoTrue's `_removeSession()` removes the session key, then the PKCE
   verifiers, then **notifies `SIGNED_OUT`** — whatever the storage did. The
   production adapter forwarded that to the Auth store, which adopted "no
   player" before `signOut()` had even returned.
3. supabase-js answers `SIGNED_OUT` by refreshing Realtime's token, which READS
   the session back; the surviving credential was served and reported
   `durable`, erasing the `unavailable` the failed removal had set. So the
   adapter's later global-durability check said nothing was wrong, and sign-out
   reported success. Every later request, and every relaunch, read A.
4. Account deletion ran the same removal after `delete_own_account()`; with the
   removal failing, a cold hydration adopted the erased UUID.

`removeItem` cannot simply throw: GoTrue's `_callRefreshToken` calls
`_removeSession()` inside its own error handler before settling
`refreshingDeferred`, so a rejection there strands every caller waiting on that
refresh. That constraint shaped the repair.

### 21.3 B-F2 — the fail-closed repair

**Storage (`secure-session-storage.ts`, header point 3).** A removal is now a
verdict about what a fresh start could restore:

| Step | What it does | Judged by |
|---|---|---|
| 1 | delete the head (the commit, as before) | `restorable()` — the native store read directly; a read that THROWS is `unknown`, never `absent` |
| 2 | if anything is still restorable: overwrite the head with a tombstone, `arc21.removed.v2`, which every read — including a relaunch's — treats as nothing stored | same |
| 3 | if still restorable: delete each chunk the head names (one gone makes the value unrecoverable) | same |
| verdict | `removed` only when nothing is restorable; otherwise `retained` | — |

`retained` is sticky: the key stays `unavailable` through later successful
reads of the surviving credential (the audit's seam), until a write commits or
a later removal succeeds. Removal still never throws. The verdict of each
session-key removal is published (`sessionRemovalMark` / `sessionRemovalSince`
/ `lastSessionRemoval`); PKCE and other keys never stand in for it.

**Adapter (`supabase-auth-adapter.ts`).** A departure — sign-out, and the local
half of deletion — runs `depart()`, which HOLDS any `SIGNED_OUT` GoTrue
announces while it runs and releases it only on the storage's `removed`
verdict. It is released from the actual operation, which keeps running after a
UI timeout, so a caller that gave up still ends up showing what the keychain
holds.

| Case | Result |
|---|---|
| removal `removed` | signed out; also when the server could not confirm the revocation, because GoTrue removes the local session even then and nothing restorable remains |
| removal `retained` | sign-out REFUSED, `CREDENTIAL_NOT_REMOVED`; the player is never shown as gone, the SDK and a relaunch keep serving them, and a retry once the keychain recovers completes |
| GoTrue stopped before removing anything | the classified error; the player is still stored |
| GoTrue drops a session on its own (refused refresh, session the server no longer knows) and the keychain keeps it | the screen re-derives from what GoTrue now serves — what a relaunch would restore: a still-valid credential keeps its player, a dead one is not shown |

**Deletion.** `delete_own_account()` is irreversible and the credential must
leave the device after it. So before anything is sent, a keychain write probe
(`sessionStorageAcceptsChanges`) asks whether the device can change a saved
credential at all; if not, deletion is refused with nothing sent. After the
server erases the account, a `retained` verdict is reported as
`CREDENTIAL_NOT_REMOVED` with its own copy ("Your account was deleted, but this
device could not remove its saved sign-in. Sign out to finish."), never as a
clean deletion; deleting again and signing out are both harmless and both
finish it. Settings shows that message instead of the generic "check your
connection" text, which would be false there.

Not changed: B-R6's replacement semantics (`setItem`, `refuseUnstoredPlayer`,
same-player degrade), the refresh path, linking, recovery. The tombstone is
overwritten by the next stored credential like any other head.

### 21.4 B-F1 — privacy ordering after a timeout: root cause and repair

**Root cause.** The per-player lane ordered bounded WAITS, not writes. A PATCH
that timed out released the lane while it was still deliverable, and it was
unconditional, so whenever it arrived it overwrote whatever had been written
since — the audit's acknowledged `private` turned back into `public`.

**Repair — the server decides (`profile-privacy.ts`).** Every write names the
row version it replaces. The sync reads `profiles.updated_at` with the same
pinned credential, then PATCHes `privacy` only `where id = <bound player> and
updated_at = <that version>`, returning the new version.
`profiles_set_updated_at` moves that column on EVERY update, including one that
sets an unchanged value, so a newer write always moves the version and an older
request, however late it arrives, matches nothing. A write that finds the row
moved (a later choice, another device, a server update of another column)
reads again and retries, at most three attempts, only while its bound player is
still current; otherwise it reports `failed/contended` and never writes over a
version it did not see.

This needed **no migration, grant, RLS or Edge Function change**: the owner
already holds table SELECT (so it can read its own `updated_at`) and the
column UPDATE grant on `privacy`. The per-player lane is kept for in-order
delivery and restarts on a player change, so B's writes never wait behind A's.
It is now safe for it to release on a timeout.

### 21.5 B-F3 — the Settings caller: root cause and repair

**Root cause.** `changeVisibility` awaited the LOCAL save before calling the
sync, so the write was bound to whoever was signed in when the save finished
and ordered by when it finished. The audit held A's save across a sign-in to B
and B's own "private"; released, it wrote A's "public" onto B. Reproducing it
also exposed the local half: the settings store's saves completed in any order,
so the held older save landed LAST and left "public" on disk under "private" in
memory — and the next launch would load and sync it.

**Repair — one owner, ordered saves.**

- `useProfilePrivacySync` at the root is the ONLY caller of the sync; its body
  is `reconcileProfilePrivacy(userId, ready, statsVisibility)`. It sees each
  choice the moment `update` records it in memory, synchronously at the tap,
  before any disk save is awaited, and runs under the player current then.
- `changeVisibility` now only records the choice (`void update(...)`), like
  every other control on the screen.
- `use-settings.ts` saves one at a time, each writing the record as it stands
  when its turn comes, so the newest choice is the one on disk.

**Shared architecture decisions (B-F1 + B-F3).** Identity is captured when the
intent is created, before anything is awaited: the root effect binds through
`syncProfilePrivacy` → `bindCurrentPlayer`, unchanged. Order on this device
comes from the in-memory record and the per-player lane. Order against
anything still in flight comes from the server's version check. No local
generation, no ignored response, no cancelled promise stands in for the
server's verdict.

### 21.6 Bounded analogous review

| Path | Conclusion |
|---|---|
| Other credential teardown in `src/` and `app/` | none — `depart()` is the only caller of `auth.signOut`; `expo-secure-store` is reached only from the storage module. The in-memory fallback reports `removed` |
| GoTrue-initiated removals (refresh refused, session missing, invalid session) | the adapter re-derives what is served (21.3); covered by two regressions |
| PKCE verifier removal | goes through the same ladder; a tombstoned verifier reads as absent; never a session verdict |
| **Notifications `setKind` (same screen)** | **the identical pipeline**: it awaited the local save, then synced a tap-time snapshot, bound to whoever was current after the save. Repaired the same way: the player scope is captured before the save, and the device's CURRENT preferences are sent. Unreachable in this build (no EAS project id, so registration returns before any network call), so it is documented, not natively proven |
| Notifications master switch | reviewed, unchanged: it retires this device's registration, which the device-wide "off" makes correct for whoever is signed in |
| Other ordering lanes | the auth mutation queue and the push device lane chain the ACTUAL operation, not a bounded wait; only the privacy lane released early |
| Daily reminder | device-local and ordered by the now-ordered saves; unchanged |

### 21.7 Production files changed (7)

| File | Audited (start) | Repaired | Change |
|---|---|---|---|
| `src/lib/supabase/secure-session-storage.ts` | `6587fb9dfecd…` | `62ddcb6a8f58…` | B-F2 verified removal, sticky `retained`, removal verdicts, deletion probe |
| `src/features/auth/supabase-auth-adapter.ts` | `f3c2d8c1c131…` | `79831ccc46a5…` | B-F2 departure gate, verdict-driven sign-out/deletion, re-derive |
| `src/features/auth/auth-failure.ts` | `47f61c7bffeb…` | `b099acec618a…` | `CREDENTIAL_NOT_REMOVED` and its copy |
| `src/features/settings/profile-privacy.ts` | `96ebdf21aef3…` | `6fc8122b2eed…` | B-F1 version-conditional write |
| `src/features/settings/use-profile-privacy-sync.ts` | `d4948398ccb9…` | `3b43ce8a79c3…` | B-F3 single owner, `reconcileProfilePrivacy` |
| `src/features/settings/use-settings.ts` | `ffae7e9e78a9…` | `b39e5c564f88…` | B-F3 ordered, latest-wins saves |
| `app/settings/index.tsx` | `0cfa05a0c9a5…` | `f8606657a43a…` | B-F3 caller; `setKind` analogue; deletion message |

The "audited" column is the code the audit measured: the shadow's
`secure-session-storage.ts`, `auth-failure.ts` and `profile-privacy.ts` match
the audit's own "current" fingerprints in `$F/negative-source-hashes.json`. No
migration, RLS, grant, Edge Function, dependency or native configuration
changed — so pgTAP, migrations, `check:functions` and a prebuild were not
needed, and none was run. Full hashes, including the state at the negative
controls: `$X/final-source-hashes.json`.

**Four post-review refinements**, made after a line-by-line review of this
diff against the audited code and BEFORE any native flow ran — which is why
there are two Release builds (21.11):

1. `secure-session-storage.ts`: the factory's existing doc comment was
   re-attached to the factory (the new helpers had been inserted between
   them). Comment position only.
2. `supabase-auth-adapter.ts`: the re-derive after a GoTrue-initiated retained
   removal is bounded by `withTimeout`; an answer that never comes leaves the
   screen as it is rather than guessing.
3. `app/settings/index.tsx`: a keychain that kept the credential gets its own
   alert title, "Sign-in still on this device", because "Deletion not
   confirmed" contradicted the post-erasure message ("Your account was
   deleted…").
4. `use-settings.ts`: the ordered save moved to module level, so the store's
   body keeps its original shape and the diff shows only `update` and `reset`
   changing. Same behaviour.

They were re-verified on the final tree (21.10) — typecheck, lint, the full
unit suite and the server files that exercise them — and the final Release
build was made from it.

### 21.8 Maintained regressions — 4 new files, 42 tests

| File | Tier | Tests | What it proves |
|---|---|---|---|
| `tests/auth/credential-departure.test.ts` | storage boundary + the full app path: production Auth store (own `hydrate()`), adapter, real supabase-js, PRODUCTION storage factory over an `expo-secure-store` double; GoTrue HTTP faked | 24 | the ladder (working, rejected and silent deletes; head refused but chunks deletable; the OTHER bank is not a removal; an unreadable keychain is never "empty"; retry and commit clear `retained`); a crash at every native mutation of a removal, for three delete behaviours, restores all of the credential or nothing and never follows a `removed` verdict; the audit's reproduction inverted (shown, SDK and keychain agree, relaunch is not A, nothing is sent as A); refused sign-out shows A throughout (store history empty), keeps serving and restoring A, keeps `unavailable` through reads, and a retry completes; a sign-out whose UI wait expires still ends showing what the keychain holds; deletion with a rejected delete leaves nothing a relaunch adopts; deletion refused before the RPC when the keychain cannot change; a keychain breaking AFTER the erasure is reported, and a retry finishes; GoTrue-initiated removals keep a still-valid player and drop a dead one; a `/logout` the server fails does not undo a departure the keychain completed (case 6); a deletion the server refuses removes nothing (case 10); the verdict is the departure's own |
| `tests/server/credential-departure.integration.test.ts` | **real GoTrue + Postgres**, production storage factory over the audit's own native double, production store, adapter and friends store | 5 | the audit's reproduction inverted: after a rejected delete the relaunched app is a DIFFERENT player and the friend request's sender (database) is not A; the silent iOS shape; a keychain refusing every change refuses the sign-out, with screen, SDK, keychain, a protected request (sender = the shown player) and the relaunch all A, then a retry completes; confirmed deletion with a rejected delete: `auth.users` 0 rows and a relaunch that is not the erased UUID; deletion refused before the server is asked, with the account still there, then the positive control |
| `tests/settings/privacy-ordering.test.ts` | settings store + the ACTUAL `changeVisibility`, compiled from `app/settings/index.tsx` (the audit's AST method) + real supabase-js over an in-memory PostgREST model of the version check | 9 | saves finish in order and a held save cannot leave the older choice on disk (and a reset behind one); the screen handler makes no write of its own; the root reconciliation's gating; the audit's B-F1 shape on the wire — the released old PATCH matches 0 rows and the row's version does not move; re-read and win on interference; give up (`contended`) without writing over an unseen version; uninterrupted control; a stale write is never sent |
| `tests/server/privacy-ordering.integration.test.ts` | **real GoTrue + PostgREST + Postgres**, production store + sign-in, settings store, the ACTUAL screen handler, the root effect driven as React drives it | 4 | uninterrupted control through screen, store, disk and column; **B-F1**: the old PATCH is held before delivery past the 8 s timeout, "private" is acknowledged, the old request is released and ANSWERED with no matched row — the column stays `private` and its `updated_at` does not move; **B-F3 same player**: a held save sends nothing afterwards, column, memory and disk all `private`; **B-F3 across players**: A's held save, a real sign-in to B, B's "private", release — B's column and version unchanged, no PATCH after the release, A's choice stayed A's, nothing of A leaks into the device |

Changed, nothing weakened: `tests/auth/stale-identity-player-state.test.ts`'s
B-R4 fixture now answers the version read with a row, and its expected PATCH
targets now include the version predicate; every original assertion (actor,
target row, value, order) is unchanged. `tests/features/local-state-authority.test.ts`
failed on the new keychain probe key, exactly as that gate is designed to; the
key was classified after checking what it reaches (a nonce written, read back
once and deleted; never read as state; authorises nothing), and the gate's
privileged-verb scan now covers `secure-session-storage.ts` too.

Two focused native flows were added (21.11): `tests/e2e/refresh-b/sign-out.yaml`
and `tests/e2e/refresh-b/privacy-control.yaml`.

### 21.9 Negative controls — the regressions fail on the audited code

The audited tree was rebuilt OUTSIDE the repository (`git archive 47dba20`, the
start patch `55bc51ab…`, the start-time untracked files) and the new
regression files copied in; its fingerprints are in 21.7. No live file was
disarmed or modified; `$X/negative-source-hashes.json` records both trees.

| Tier | On audited code | Of the failures | Log |
|---|---|---|---|
| unit / wire (2 files, 33 tests) | **26 fail**, 7 pass | **19 behavioural**: the SDK still A after sign-out (rejected and silent deletes), relaunch storage still A, the durability warning erased by a read, chunk breaking absent, a refused-everything sign-out reported as success, a timed-out sign-out never removing A, the erased account's credential still stored, deletion not refused before the RPC, deletion after a post-erasure keychain failure reported clean, a GoTrue-dropped session hidden while still served, the older choice left on disk (twice), the screen handler syncing after its save, the released old PATCH applied, blind overwrites of an unseen version (twice), and a sign-out reported as FAILED for a device that was in fact signed out (case 6 — a reporting contradiction, not a leak). **7 new-feature-only**: the removal verdict callback (4), two new exports, a protocol with no version read | `$X/negative-unit.log` |
| real backend (2 files, 9 tests) | **8 fail**, 1 pass | all 8 behavioural, at the audit's own measurements: SDK still A after "successful" sign-out (×2), sign-out reported clean with the keychain refusing everything, the erased player's credential still served, deletion not refused; and the privacy column reading **`public`** where `private` was acknowledged — B-F1, B-F3 same player and B-F3 across players (B's column) | `$X/negative-server.log`, `$X/negative-server-privacy-reordered.log` |

The 8 passes are exactly the controls that should pass on either code: the
three crash-boundary cases (the audited removal also committed absence first),
the ordinary sign-out, the dead credential not shown, the deletion the server
refuses (case 10), and the two uninterrupted privacy sequences. Cases 6 and 10
were added after the main shadow run, to cover two of the brief's eleven
teardown cases explicitly, and were run against the same shadow on their own
(`$X/negative-unit-cases-6-10.log`).

**Two refinements before the final table, both recorded.** The first shadow run
showed some failures only on a new symbol, so behavioural assertions were
reordered ahead of verdict assertions (none removed), the ordinary-sign-out
control stopped depending on a new export (its verdict check moved to its own
test), and the in-memory PostgREST model was corrected: an UNVERSIONED PATCH
applies, as real PostgREST would — the first model refused it, which made the
audited code fail for the wrong reason. In the server file the database
readbacks were moved ahead of the request-count and response-shape checks so
the control reports the column value itself.

**The audit's own probes, re-run unchanged against the repaired tree** (only
their output paths redirected into `$X/audit-probes-rerun/`; identical
otherwise, verified by diff):

| Probe | Audit read | Now |
|---|---|---|
| B-F1 (`residuals`) | `afterOld: public` | **`afterOld: private`**; old outcome `failed/unreachable`, latest `written private` |
| sign-out, delete rejects | `shown null`, SDK **A**, relaunch **A**, friend request sender **A** | `shown null`, SDK **null**, relaunch a **new** player, sender = that new player |
| sign-out, delete silent | SDK A, relaunch A | SDK null, relaunch a new player |
| account deletion | relaunch adopts the erased UUID | relaunch is a new player; `auth.users` 0 for the erased UUID |
| Settings caller across players | `bAfter: public` | **`bAfter: private`**, local `private` |
| Settings caller, one player | `after: public` | **`after: private`** |

The probes assert the DEFECTS, so their assertions now fail; that is the
evidence. The three players the relaunches created — something the audit's
cleanup did not expect, because the audited relaunch re-adopted A — were
removed by id after confirming they were the only users created in that
window (`$X/audit-probes-rerun/window-*.txt`).

### 21.10 Verification (October 3, 2026)

| Gate | Result | Log |
|---|---|---|
| typecheck | pass | `$X/typecheck.log` |
| lint | **0 errors / 21 warnings — finding-for-finding identical to the audit's** | `$X/lint.log` |
| full unit suite (two workers) | **140 files / 2,580 tests pass** = the audited 138 / 2,549 + 2 files / 31 tests (2,582 after cases 6 and 10, below) | `$X/unit-full.log` (the first run, before the probe key was classified, is kept as `$X/unit-full-first-run-unclassified-key.log`) |
| B-R1–B-R6 maintained regressions | **6 files / 40 pass** | `$X/targeted-regressions.log` |
| previous social/table regressions | **4 files / 17 pass** | same |
| new B-F1/B-F2/B-F3 regressions | **4 files / 40 pass** | same — one run, 14 files / 97 tests; cases 6 and 10, added afterwards, pass in the unit file's own run (24 / 24) and in every full unit run after it |
| Auth / storage / settings / privacy / player-state areas | all within the full unit suite and the full server run below | — |
| **ONE full `npm run test:server`** (before the post-review refinements) | **33 files / 365 tests pass**, 341 s, uninterrupted = the audited 31 / 356 + 2 files / 9 tests | `$X/server-full.log` |
| pgTAP, migrations, `check:functions`, prebuild | not run — no database, RLS, grant, Edge Function, dependency or native-configuration change | — |

`supabase functions serve` was restarted before the server run, as CLAUDE.md
directs (the previous process had run since September 29; stopping it added
only its 271-byte shutdown lines to §19's log). Over the run the runtime logged
71 CPU soft-limit events, **0 hard-limit** events and **0** supervisor
cancellations (`$X/server-full-runtime-events.txt`).

**One collection failure, classified, not rerun to green.** The very first
standalone run of `privacy-ordering.integration.test.ts`, after three idle days,
failed to collect: the stack guard's 5-second database probe did not answer in
time. Probed by hand immediately afterwards: the function answered 401 in
0.21 s and the database probe `403 NOT_A_PARTICIPANT` in 788 ms. **Environment**
(a cold Edge worker), the CLAUDE.md shape; rerun unchanged
(`$X/classifications.txt`).

**Re-verified on the FINAL tree, after the four post-review refinements
(21.7):** typecheck pass (`$X/typecheck-final.log`); lint 0 / 21, findings
unchanged (`$X/lint-final.log`); full unit suite **140 files / 2,582 pass**, the audited 2,549 plus 33
new unit / wire tests (`$X/unit-full-final.log`); the server files that exercise the refinements —
`credential-departure`, `privacy-ordering` and the B-R4 file
`stale-identity-player-state` — **3 files / 16 pass**
(`$X/targeted-server-final.log`).

**The full server suite on the final tree.** `functions serve` was restarted
again first. That run (`$X/server-full-final.log`) passed **25 files / 282
tests**, and 8 files did not complete — **with no assertion failure in any test
that ran**: 7 failed to collect, because the stack guard's 5-second probe was
abandoned (the gateway logged exactly 7 × 499 on `game-command`), and
`pseudonymous-identity` met GoTrue `/signup` answering 504 at its first sign-in
(4 × 504; 33 timeout lines in the auth container). The one 500 was the suite's
own injected "failure during prize settlement", whose test passed; the 82 ×
429 were the suite's own rate-limit assertions, none from GoTrue's sign-in
caps. **Classified ENVIRONMENT, from the host:** macOS had grown swap to 10,240
MB with 9,177 MB used — the native flows had just finished with the simulator
still booted and the app running — whereas the clean first run was taken
before the simulator was booted. The simulator was shut down (swap fell to
5,700 MB used) and **only those 8 files** were run again, unchanged: **8 files
/ 83 tests pass** (`$X/server-failed-files-rerun.log`). So every one of the
365 server tests has passed on the final tree (282 + 83), and all 365 passed in
one uninterrupted run on the pre-review tree; the brief's single broad run was
not repeated to obtain green (`$X/classifications.txt`,
`$X/server-full-final-environment.txt`).

The pre-repair independent baseline was: previous social/table 17/17,
consolidated repaired set 40/40, unit 2,549, server 31/356, typecheck pass, lint
0/21. Every one still holds, and every new test is in addition to it.

### 21.11 Native Release evidence: what this repair made stale, and what was renewed

**The accepted binary was stale, measured.** §19's fingerprint method, run
against its record (`3eba8f7c…`) before building, found exactly the 7 changed
sources of 21.7 and nothing else, of 246 (`$X/prebuild-freshness.txt`).

| Changed path | Native gate | Decision |
|---|---|---|
| storage first write and reads, the new listener wrapper (`SIGNED_IN` / `INITIAL_SESSION` pass straight through) | `refresh-b/fresh-player` | **renewed** |
| restore on relaunch | `refresh-b/cold-player` | **renewed** |
| the root owner and the version-conditional write | every online flow writes `privacy` at start; the Settings control itself had no flow | **renewed**, plus a NEW focused `refresh-b/privacy-control.yaml` |
| sign-out: the departure gate and the verified removal | none — `replacement-cancel` cancels its sign-out, and `password-recovery-retry` signs out only inside a recovery chain | NEW focused `refresh-b/sign-out.yaml`, with a cold relaunch |
| account replacement through the new listener wrapper | `refresh-b/sign-in-existing` + a protected mutation (`refresh-b/social-send`) | **renewed** |
| deletion: probe, RPC, gated departure, then a cold launch | `refresh-b/delete-player` + `account-delete-cold-launch` | **renewed** |
| every failure path — a keychain refusing deletes or writes, a held PATCH, a held local save, a switch mid-flight | cannot be staged on a simulator | proven at the SDK / backend tiers (21.8), as the audit did |
| tables, matchmaking, two-device play, rooms, securing, recovery | untouched by the 7 files | not renewed |

**Two Release builds; the second is the evidence.** Build 1 (`c275bfa0…`,
20:08:57Z) was superseded BEFORE any flow ran, because the post-review
refinements (21.7) changed shipped code. Its CLI exited 1 after "Build
Succeeded": the post-install `simctl openurl` to an `expo-development-client`
URL timed out (POSIX 60) under the compile load; a Release build run with
`--no-bundler` has neither a dev client nor Metro. Classified HARNESS/CLI and
kept as `$X/release-build-1-superseded.log`.

| Claim | Evidence |
|---|---|
| Build Succeeded, **0 errors / 1 warning**, re-bundled ("Eager bundle does not match new options"), CLI exit 0, installed on device A | `$X/release-build.log` |
| The binary is this tree | bundle SHA-256 **`3f2999e9bb48520819d9c7fb0b15c89671622883b8980923ab700e015c3c189d`**, 6,416,363 bytes, built 2026-10-03T20:22:36Z, **246 sources, 0 newer** (`$X/build.json`, `$X/build-fingerprint.txt`) |
| Device A runs exactly it | the installed `main.jsbundle` hashes the same |
| Nothing else could serve a bundle | no listener on 8081 before the build, before the flows and after them |
| Positive control only | the tombstone, `CREDENTIAL_NOT_REMOVED`, the probe key and the new alert title are present in the bundle (1 hit each); a string scan cannot prove absence |
| No source moved during the pass | after the last flow: same bundle, **0 changed / 0 added / 0 removed / 0 newer** (`$X/build-freshness-after-flows.txt`) |

**Flows.** Device A, iPhone 17 Pro `D16C4292…`, booted headless, one driver;
the one-minute load was under 12 before each flow, and anonymous sign-ins were
budgeted against the local 30-per-hour cap, so the first flow waited until the
earlier server runs had aged out of that window. Every row pairs the Maestro
result (step counts from the run's own `commands.json`) with a server
readback. Evidence: `$X/native-<n>-<name>.{log,xml}`, `$X/native-<n>-<name>/`,
`$X/state-<n>-*.txt`.

| # | Flow | Result (C / F / S) | Server-side readback |
|---|---|---|---|
| 01 | `refresh-b/fresh-player`, after `e2e-fresh-app.ts` reset SQLite and the keychain | **pass** 22 s (15 / 0 / 1) | `avid_bee` `dd3c8e7b-e334-4724-9e34-d62e861e4ae5`: anonymous, **privacy `private`** although the column defaults to `public`; the gateway log shows the device's `GET profiles?select=updated_at` then `PATCH …&updated_at=eq.2026-10-03T20:55:03.607007+00:00&select=updated_at` → 200; 25,000 = ledger, 1 grant, 1 session; users 4,946 → 4,947 |
| 02 | `refresh-b/cold-player` `HANDLE=avid_bee` | **pass** (9 / 0 / 1) | the same UUID, the same single session and live token; users unchanged |
| 03 | NEW `refresh-b/privacy-control` `VISIBILITY=Anyone` | **pass** (8 / 0 / 1) | column **`public`**, version 20:57:03.580776 |
| 04 | the same, `VISIBILITY=Only me` | **pass** (8 / 0 / 1) | column **`private`**, version 20:57:41.552615. The four PATCHes of rows 01–04 each name exactly the version the previous write produced: one write per choice, no second owner |
| 05 | NEW `refresh-b/sign-out` `HANDLE=avid_bee` | **pass** 38 s (19 / 0 / 2) | `/logout` 204 at 20:58:28Z; "Offline player" shown; `avid_bee` **0 sessions, 0 live tokens**; the cold relaunch had nothing to restore and created **`hazel_boar`** `5bd49f8f…` (anonymous, 1 grant) — `avid_bee` was not restored |
| 06 | `refresh-b/sign-in-existing` with a disposable secured account X, replacing `hazel_boar` | **pass** (26 / 0 / 4) | `login`, actor X `0b3334f5-6276-414a-bd65-80c4a314688a`, at 21:00:13Z, 1 session; `hazel_boar` still exists, unmerged, wallet intact. One extra device `/recover` at 21:00:05Z — **HARNESS**, below |
| 07 | `refresh-b/social-send` `OTHER=avid_bee` | **pass** (12 / 0 / 1) | `friend_requests`: **sender `calm_heron_357306` (X) — the player shown** → `avid_bee`, `pending` |
| 08 | `refresh-b/delete-player` `EMAIL=X` | **pass** (15 / 0 / 1) | gateway: `rpc/delete_own_account` 204, then `/logout` 403 (the erased user; GoTrue removes locally); X's users, identities, sessions, profile, wallet, ledger and friend requests are all **0**; "Offline player"; no replacement created (4,949 → 4,948) |
| 09 | `account-delete-cold-launch` `EMAIL` / `PASSWORD` of X | **FAIL** (6 / 1 / 1) — **HARNESS** | the cold launch created **`azure_owl_034920`** `6af9fe72-82ec-4ad1-9bac-67bdeb27f544` (anonymous, 1 grant) — **not X**. The failure: see below |
| 10 | the same flow, its scroll corrected | **pass** (26 / 0 / 2) | the second launch restored `azure_owl` (no new user); X's password grant refused **400** at 21:07:59Z; X still 0 rows |

**The failed run, classified from its artefacts.** Row 09 failed on
`assertVisible: This player has no recovery credentials.*` straight after
`scrollUntilVisible: Your player`. The failure screenshot shows Settings with
"Your player — @azure_owl_034920" at the bottom edge; the saved hierarchy ends
at y≈866 of 874 pt, with the title at `[33,818][369,840]` and the caption
absent, below the fold. The scroll stopped as soon as the title entered the
viewport. The state the flow exists to prove was on screen and in the
database. The flow now scrolls to the LAST line it asserts and asserts both
lines — stronger, not weaker — and row 10 passed.

**Two extra `/recover` requests, classified.** Rows 06 and 10 each logged a
device `POST /auth/v1/recover` (21:00:05Z and 21:07:48Z). Both fall INSIDE
Maestro's `Hide Keyboard` step (21:00:01.2–21:00:06.8Z and
21:07:44.9–21:07:49.9Z in each run's `maestro.log`) and before the
`auth-submit` tap. The keyboard-dismiss gesture landed on "Email me a reset
link", directly beneath "Sign in". **HARNESS**: the app sent a reset for the
address in the field, which is what that button does; no link was opened; X's
password then signed in (row 06), and X was later deleted, so the second
request reached nobody (GoTrue answers 200 for any address).

**Credentials in evidence.** The runner redacts `PASSWORD=` arguments in its
log and scrubs the value from Maestro's debug output; the disposable password
appears in no evidence file (checked after rows 06, 09 and 10). It existed
only in a scratch file outside the repository, deleted after the pass.

**Not renewed natively, and why.** The failure paths above; Notifications
`setKind`, which is unreachable in this build (no EAS project id); everything
§19.10.5 lists for code this pass did not touch; and mid-hand native cash-out,
which remains NOT RENEWED as §18.4 and §20.5 record.

### 21.12 Wallet / ledger / opening grant

Asked of **every** wallet in the local database (`$X/integrity.sql`):

| Stage | users | wallets | wallet ≠ ledger | negative | `initial_grant` count ≠ 1 |
|---|---|---|---|---|---|
| before the native flows (`state-00`) | 4,946 | 4,946 | **0** | **0** | **0** |
| after them (`state-11`) | 4,949 | 4,949 | **0** | **0** | **0** |
| final, after the final-tree server runs (`state-12`, `$X/integrity-final.txt`) | 5,442 | 5,442 | **0** | **0** | **0** |

The native pass created four players and deleted one (X), exactly the 4,946 →
4,949 movement; the server suites account for the rest, as §20.6 observed of
its own run. These repairs touch no economic code.

### 21.13 Residuals and remaining blockers

**No known unrepaired instance of B-F1, B-F2 or B-F3.** No other blocker was
looked for; this was a bounded repair, not an audit. Recorded for the
re-auditor to weigh:

1. **Deletion whose keychain fails between the probe and the cleanup.** If the
   pre-flight write succeeds and, moments later, the keychain refuses the
   delete, the overwrite AND every chunk delete, the account is already erased
   and its credential stays restorable. The app reports it
   (`CREDENTIAL_NOT_REMOVED`, "Your account was deleted… Sign out to finish")
   and keeps showing what storage holds rather than claiming a clean departure;
   a relaunch before the user signs out would restore the erased UUID until its
   access token expires (≤ 1 hour locally), with every server request refused
   for a user that no longer exists. Both "sign out" and "delete again" finish
   it. A durable second-medium record could close it at the cost of a new
   dependency in the credential path; not built.
2. **A process killed after the server erased the account and before the local
   removal** restores the erased UUID on relaunch, for the same bounded time.
   That window predates this repair and is not a removal failure (nothing was
   reported); recorded because it shares the symptom.
3. **A refused sign-out after the server revoked the session.** GoTrue revokes
   before it removes, so when the keychain then refuses, the player stays shown
   and usable until the access token expires, after which GoTrue's own refresh
   failure drops it (re-derived as dead). Consistent at every moment; an
   unlinked player who chose sign-out loses that player, as the confirmation
   already warns.
4. **The version token is `updated_at`, i.e. `now()`, a transaction's start
   time.** Two committed updates of one row sharing a microsecond-identical
   start time would not move it. An unrelated profile write between the read
   and the PATCH costs a retry; three attempts, then `contended`.
5. **Notifications `setKind`'s lane-entry order.** Two near-simultaneous
   registrations that read different preference snapshots can still enter the
   push device lane in either order. Unreachable in this build (no EAS
   project id); a complete fix would read the allowlist inside `mutateDevice`.
6. **Platform scope unchanged.** A platform whose keychain applies a write in
   memory before a failed flush (§18.5's Android note) could pass the
   tombstone's read-back and lose it on relaunch. iOS was inspected; Android
   remains external and unproven. Physical keychain failure was never induced;
   every fault was injected at the native module boundary, as the audit's were.
7. Everything §18.5 and §20.5 classify as external — hosted activation,
   APNs/FCM/EAS, Android, hardware CAPTCHA, the unconfigured build, mid-hand
   native cash-out, lint warnings — is unchanged by this pass.

### 21.14 What Astra must challenge next

1. **The removal verdict.** That `restorable()` agrees with what a relaunch
   restores in every head/chunk/legacy shape; that "unknown" can never become
   "removed"; that `retained` is sticky against every read path, including
   supabase-js's SIGNED_OUT Realtime refresh; that the tombstone cannot be
   mistaken for a credential or block a later sign-in.
2. **The departure gate.** That no `SIGNED_OUT` can reach the store as "no
   player" while a credential is still served — including during a UI timeout,
   a concurrent auto-refresh tick, and GoTrue-initiated removals — and that the
   re-derive cannot loop or show a dead credential.
3. **Deletion.** The probe's predictive value (a write that reads back), the
   post-erasure `retained` handling and copy, and residuals 1–2. Try a keychain
   that refuses writes only after the RPC; try killing the process after it.
4. **The refresh constraint.** That `removeItem` still never rejects, so
   `_callRefreshToken` can always settle `refreshingDeferred`.
5. **The privacy version check against the real database.** That every
   accepted privacy write moves `updated_at` (including a same-value write and
   one that races another column's update); that an older request is refused
   however late; that `contended` is reachable only through real interference;
   that no grant, RLS or migration change was needed or made.
6. **The single owner.** That nothing else calls `syncProfilePrivacy`; that the
   root effect's identity binding is before its first await; that a player
   switch between a tap and the effect is the device-wide preference's ordinary
   reconciliation, not one player's intent becoming another's; that the
   ordered saves leave the newest record on disk in every interleaving.
7. **The negative controls** — rebuild the shadow rather than trusting the
   logs — and the two refinements made to them (21.9).
8. **The adapted B-R4 fixture and the local-state classification** (21.8):
   that neither weakened its test.
9. **The analogous `setKind` repair** and residual 5.
10. **The native scope decisions and freshness** (21.11): rebuild and compare
    rather than trusting `3f2999e9…`. Build 1 (`c275bfa0…`) was superseded
    before any flow ran.

### 21.15 Exact state

- Branch `astra-refresh-b`, HEAD **`47dba201ace488d932bb4e479416f52f79a6f176`**,
  everything uncommitted; the index is empty. Nothing committed, pushed,
  merged, deployed, reset, stashed, cleaned or rewritten; no hosted change; no
  Refresh C/D/E work.
- `AGENTS.claude-backup.md` remains intentionally untracked and untouched.
- Production files changed by this pass: the **7** in 21.7, all tracked.
- Tests: **4 new files, 42 tests** (21.8); **2 changed** (the B-R4 fixture in
  the untracked `stale-identity-player-state.test.ts`, one classification in
  the tracked `local-state-authority.test.ts`); **2 new native flows** in the
  untracked `tests/e2e/refresh-b/`; **one native flow corrected**, the tracked
  `account-delete-cold-launch.yaml` (21.11). No assertion, timeout, retry
  policy, rate limit or worker count weakened.
- Release binary `…/Build/Products/Release-iphonesimulator/Arc21.app`, bundle
  SHA-256 `3f2999e9bb485208…`, corresponds to this tree as `$X/build.json`
  fingerprints it, and is installed on device A. Simulator A was shut down
  after the pass (21.10); simulator B was not used.
- `supabase functions serve --no-verify-jwt` is RUNNING (restarted twice in
  this pass), logging to `$X/functions-serve.log`; earlier logs are kept
  beside it. The database was not reset. No hosted setting touched.
- The disposable native account X was deleted by the product itself (21.11);
  the relaunch-created players of the audit-probe re-run were removed by id
  (21.9). `avid_bee`, `hazel_boar` and `azure_owl_034920` are unlinked players
  whose only credentials were on the simulator, left as earlier passes left
  theirs; the friend request X → `avid_bee` went with X.
- Documentation: this section; §§1–20 are unchanged above it.
- **Refresh B is NOT claimed to pass.** §20 remains the standing verdict; this
  section is an unreviewed repair and its evidence. A fresh independent
  re-audit is required.

## 22. Final independent bounded re-audit — October 3, 2026

**ASTRA REFRESH B: FAIL**

**Consolidated confirmed release-blocking software defects: B-G1, B-G2, B-G3.**
No checkpoint. This review continued after each finding through the remaining
independent surfaces. One primary agent; no subagents or Goal mode. No production
code or maintained test was edited. §§1–21 and all earlier FAIL/repair evidence
are preserved.

Branch `astra-refresh-b`, no upstream. Starting and final HEAD:
**`47dba201ace488d932bb4e479416f52f79a6f176`**. All Refresh B remains uncommitted.
The starting tracked patch was byte-identical to §21's final tracked patch. The
seven final repair source hashes match; the archived Release matches the current
246-source inventory. Evidence for this review is outside Git:
`/Users/tj/arc21-evidence/astra-refresh-b-independent-20261003/` (**`$G`**).
`$X` and `$F` retain their meanings from §§21 and 20.

### 22.1 Confirmed findings — the complete consolidated list

#### B-G1 — P1: incomplete account deletion is forgotten on cold launch

**Product defect; release-blocking.** The post-erasure warning works in the
surviving process, but a cold launch adopts the erased UUID as an ordinary ready
player. This is the remaining deletion half of B-F2, beyond its maintained
successful-tombstone reproduction.

**Reproduction:** persist a real secured A through the production storage
factory and hydrate the production Auth store. Call its `deleteAccount(A)`.
Run three independent variants after the real `delete_own_account` has committed:

1. Make native writes AND deletes fail only after the RPC returns. Preflight
   therefore passes legitimately. The call reports `CREDENTIAL_NOT_REMOVED`
   and says the account was deleted, as designed.
2. Lose the successful RPC response. No keychain fault is necessary. The call
   reports `NETWORK` and never executes local removal.
3. Withhold that response indefinitely, then discard the client and launch a
   new one over its surviving native entries. This models termination before
   the response/local removal; it is not a claim of a physical simulator kill.

Restore healthy native storage, cold-hydrate a fresh production SDK/store, and
read the database. In **all three** cases `auth.users(A) = 0`, yet
`shown = SDK = stored = A`, `bootstrapStatus = ready`, and
`bootstrapFailure = null`. A production friend request fails and creates no
row. The account is not recreated and no unauthorized successful mutation was
observed; the defect is erased-identity adoption and loss of truthful lifecycle
state, lasting until credential expiry or manual departure.

**Affected:** `src/features/auth/supabase-auth-adapter.ts` (`createOrRestore`,
`getSession`, auth-state forwarding and `deleteAccount`), and
`src/features/auth/auth-store.ts` (hydration/adoption). `createOrRestore` returns
an unexpired locally stored session without checking whether its account still
exists; `INITIAL_SESSION` can also adopt it. Local cleanup/preflight state is
not durable lifecycle state.

**Violated invariant:** an erased identity must not be re-adopted as a usable
online player; an incomplete destructive departure must remain represented
truthfully across relaunch. Retaining the same UUID in three local views is not
sufficient evidence that this UUID is still a verified, usable server account.

**Evidence:** `$G/deletion-boundary.probe.test.ts`,
`deletion-boundary.log` (**3 assertions of the defect pass**) and
`deletion-boundary-results.json`. Actual GoTrue/Postgres, production Auth
store/adapter/storage factory and friends store; native faults and the RPC
response boundary alone are controlled. Fixtures are removed.

**Smallest bounded repair:** reconcile a potentially erased stored session
before adopting it as ready, including the initial SDK announcement. A durable
pending/confirmed-deletion record or server-existence verification on restore
can preserve/recover that distinction. Definitive erasure must prevent adoption;
network uncertainty must fail closed without destroying a valid unlinked player.
Retry cleanup separately. No atomic transaction spanning Postgres and Keychain
is required to avoid this software defect.

#### B-G2 — P2: a delayed notification sync can undo the newest opt-out

**Product defect; release-blocking for the supported push configuration.** This
is directly in the analogous `setKind` change from §21, not a broader push audit.
The local save is now ordered, but the registration's preference snapshot is
captured before several asynchronous steps and before entry to `mutateDevice`.

**Reproduction:** execute the actual `setKind` extracted from
`app/settings/index.tsx` with production Settings/push stores, real supabase-js
and the real registration RPC/database. Start with notifications enabled and
registered. Set `notifyYourTurn=true`; hold the native
`getExpoPushTokenAsync` response for that registration. Set
`notifyYourTurn=false` and await its acknowledged registration. The database
allowlist excludes `your_turn`. Release the old token response and let both
handlers finish: local memory and persisted settings remain **false**, but
`push_tokens.allowed_kinds` contains **`your_turn`** again.

Only the OS permission/EAS/token boundary is doubled, with a non-deliverable
fixture token. SDK auth methods are unchanged in the final probe. A preliminary
session-read-delay probe reached the same result and is also preserved. No
notification was sent and no claim about APNs/FCM delivery is made.

**Affected:** `app/settings/index.tsx:527`,
`src/features/notifications/use-push-registration.ts` (`sync`), and
`src/lib/notifications/push.ts:163` (`registerDevice`, snapshot before lane).
**Violated invariant:** the newest opt-out must govern the authoritative device
allowlist after all pending work settles. A current-player guard does not order
two intents belonging to that same player.

**Evidence:** `$G/notification-ordering.probe.test.ts`,
`notification-ordering.log` and `notification-ordering-results.json`.
An initial audit-only readback used the wrong column name `kinds`; its failure
is preserved as `notification-ordering-first-harness-error.log`. The probe was
corrected to the schema's `allowed_kinds`; no maintained test was changed.

**Smallest bounded repair:** order complete preference-sync intents, or resolve
the latest allowlist inside the serialized device mutation while retaining
player/revision guards. An older captured snapshot must not commit last. Add a
regression at this caller/native/backend boundary.

The current Release has no EAS project id, so this path is dormant there. That
is a deployment limitation, not a software remedy: configuring the already
supported push feature activates a proven opt-out defect. §21.13 residual 5 is
therefore rejected as an acceptable platform-only residual.

#### B-G3 — P2: successful chunk invalidation leaves bootstrap permanently unavailable

**Product defect; release-blocking.** `restorable()` correctly decides that a
missing chunk makes a credential absent. But `read()` interprets the same
persistent state as unavailable storage. The new removal ladder can create
that state deliberately and report success.

**Reproduction:** save A's real chunked session; refuse deletion of the session
HEAD and all writes (including the tombstone), while allowing chunk deletion.
Call the production store's sign-out. It succeeds: form `idle`, no shown/SDK/
restorable player. The head remains `arc21.chunked.v2:0:4`, with its chunks gone.
Restore **all** native operations to working. Cold-hydrate a new production SDK
and retry `ensurePlayer`/Connect. No player is created; bootstrap remains
`unavailable` / `PERSISTENCE_UNAVAILABLE`. Restarting or unlocking as instructed
cannot repair this stable head shape.

**Affected:** `src/lib/supabase/secure-session-storage.ts:245` (missing-chunk
read), `:379` (break-chunks removal) and
`src/features/auth/supabase-auth-adapter.ts:170` (bootstrap durability gate).
**Violated invariant:** successful removal of a non-restorable credential must
allow recovery/new-player bootstrap when the storage platform is healthy. A
known absent credential cannot indefinitely masquerade as an unreadable one.

**Evidence:** `$G/chunk-relaunch.probe.test.ts`, `chunk-relaunch.log` and
`chunk-relaunch-results.json`; real backend, SDK and production store/factory.
The maintained storage-level test covers the null read but not this subsequent
production bootstrap. Its result does not adjudicate this failure.

**Smallest bounded repair:** reconcile this incomplete-bank state to a durable
absent/tombstoned state, or safely allow replacement after proving no credential
is restorable. Preserve fail-closed behavior for genuinely throwing/unreadable
storage and B-R6's replacement guarantees. Add cold-launch/Connect coverage
through the production factory, not only `getItem() === null`.

### 22.2 B-F1 and B-F3 independently adjudicated

**B-F1: FIXED for the audited timeout/reordering failure.** The update actually
carries both the bound owner and the exact `updated_at` string read from the row.
There is no conversion through a millisecond JavaScript `Date`. The real backend
regression holds the public PATCH before delivery for longer than the 8-second
caller timeout, acknowledges private, releases public, and checks **private in
Postgres**, an unchanged version and an empty result for the late PATCH. It
passed in this review's current server run. This is not just a stale-response
guard.

The lane serializes ordinary same-player choices. A timed-out underlying request
has no continuation that re-reads/retries after a newer choice; its bounded
wrapper has returned. Response loss after commit leaves the next writer reading
the committed version; loss before commit leaves the late request conditional
on its old version. Zero-row updates re-read/retry at most three times only while
the binding is current; persistent interference reports `contended`. Stale
version, zero-match, interference/retry, fast sequences and player-switch tests
passed. A retry newly requested by the user is a new intent, not a resurrected
continuation of the timed-out request.

**Timestamp residual: non-blocking, not a unique-version guarantee.** Direct
catalog readback (`$G/privacy-schema.txt`) confirms `timestamptz`, precision 6,
a BEFORE UPDATE trigger assigning `now()`, and no authenticated UPDATE grant on
`updated_at`. PostgreSQL defines `now()` as transaction start time, with
microsecond timestamp resolution ([date/time functions](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT),
[date/time types](https://www.postgresql.org/docs/current/datatype-datetime.html)).
Two writes in one transaction can share a token; separate transactions can also
have identical start timestamps. Therefore §21's absolute claim that EVERY
update moves it is too strong.

That fact does not by itself defeat this particular flow. Each app PATCH is a
separate PostgREST transaction preceded by a completed HTTP version read. In the
B-F1 sequence the replacement private transaction starts after the old version
has been observed and the old PATCH's eight-second timeout. Two simultaneous
PATCHes reading the same old version cannot both match merely because their
NEW timestamps coincide: the first successful PATCH has already changed the
predicate value. No app/RPC path was found that deliberately issues these
privacy writes twice inside one shared transaction or lets a client choose the
timestamp. A repeat/collision of a stored token is not mathematically ruled out
(e.g. extraordinary clock behavior), but no realistic correctness-breaking
route through this application's write mechanism was established. Classified
**B: documented non-blocking residual**, not C/impossible and not dismissed just
because the time window is small.

**B-F3 privacy: FIXED.** Repository search confirms root reconciliation is the
sole production server-sync caller. The actual Settings handler only updates
local preference; memory changes synchronously. Module-level save serialization
persists the latest snapshot in order. The maintained cross-player and
same-player regressions delay the disk save before the old caller would have
bound its identity, execute the real screen handler, sign in through the
production store, and check server privacy, version, request count, memory and
disk after release. Both pass; loading that final persisted `private` value
cannot resurrect public on root reconciliation. The root-effect scheduling is
modeled, not a mounted native React test; the renewed native Settings flow
supplies the ordinary UI/root boundary evidence. Device-wide preferences are
still deliberately reconciled when a new player signs in. The adjacent
notification change is separately defective as B-G2 above.

### 22.3 B-F2 challenge matrix and remaining residual classifications

| Challenge | Independent conclusion |
|---|---|
| Normal sign-out; rejected or silently ignored head delete | Pass when deletion or tombstone establishes absence; real SDK/backend and native evidence. |
| Every change refused | Sign-out refused, A stays shown/served/restorable; protected request's database actor is A; retry completes. Sticky failure survives readback. |
| Head and tombstone refused; chunks deletable | Credential invalidation works, but cold bootstrap fails: **B-G3**. |
| Only other bank removed; partial live-bank removal; readback throws | Other-bank removal is not counted; missing live chunk proves absence; throwing reads remain unknown/retained. Recovery from absent-bank state is **B-G3**. |
| Kill during local removal | Maintained native-mutation-boundary simulations restore complete A or absence. They do not cover post-erasure/pre-removal lifecycle: **B-G1**, or bootstrap after chunk invalidation: **B-G3**. |
| Remote sign-out succeeds, local cleanup fails | Refusal is truthful while unexpired A is still served; remote refresh revocation is not local credential deletion. |
| Remote sign-out fails, local cleanup succeeds | Successful local departure, covered by the installed SDK path and maintained wire test. |
| Storage already unwritable before account deletion | Preflight refuses before RPC; real account survives. |
| Server erases account, cleanup fails afterward | Immediate warning is correct; relaunch forgets it: **B-G1**. |
| Repeated sign-out/deletion | Healthy-storage retries complete; partial-bank Connect retry does not (**B-G3**). |
| Same-player token refresh and B-R6 A → B replacement | Earlier regression guarantees preserved; identity-changing failed writes still reject before adoption. |

The residual where a platform accepts/prechecks a write then later refuses
cleanup is **A: release-blocking software defect B-G1** as currently recovered
by the app. The OS failure itself is external; forgetting erasure and adopting
the dead UUID is avoidable application behavior. A platform that reports
successful durable storage while keeping only a volatile value remains
**B: external/platform validation work**, especially Android; this audit does
not claim to solve lying durability primitives.

Process death after server erasure and before local cleanup is **A: B-G1**.
The interruption cannot be eliminated atomically across systems, but its
persisted state must be reconciled safely on launch. Timestamp collision is
**C in the mission's three-way residual classification: documented non-blocking
residual** (and **B** in its separate A/B/C timestamp-question terminology).
Android remains **B: external/platform release work**, unproven. No Android or
physical-keychain fault test is claimed.

### 22.4 Regression quality, prior protection and current gates

The four new maintained files contain **42 tests**: 33 unit/wire and 9 real
backend. All passed on the current tree during this review. They exercise
production storage factory, Auth store hydration, actual SDK, extracted screen
handler and authoritative database readbacks; they are credible regressions.
Their concrete missing boundaries are now B-G1, B-G2 and B-G3.

The preserved shadow still exists. Independently re-hashing its seven relevant
production files matched the audited vulnerable hashes, and all four regression
files matched the current files byte-for-byte (`$G/source-and-shadow-check.json`).
The negative logs show 25 failures/6 passes before the two added cases; those
cases add 1 behavioral failure/1 positive control. Backend adds 8 behavioral
failures/1 pass. Thus **34/42 fail, 8/42 pass**, including **27 behavioral**
failures; the other seven are new-symbol/protocol checks. The substantive
privacy failures report actual `public` database values where `private` was
required, and credential failures report the retained SDK/restored identity.
The distinction from repaired code is verified without modifying the live tree
or rerunning the entire negative backend suite. Eight intended positive controls
and the separation of symbol-only failures are accepted; the stronger claim
that 26 reproduce the previous measurements is consistent with the inspected
failure sites (the extra behavioral case is remote-revocation failure copy).

| Current independent verification | Result |
|---|---|
| Typecheck | PASS, `$G/typecheck.log` |
| Lint | **0 errors / 21 warnings**, `$G/lint.log`; no auto-fix |
| Full unit suite, 2 workers | **140 files / 2,582 PASS**, `$G/unit-full.log` |
| B-R1–B-R6 regressions | **40/40 PASS**, contained in current unit/server runs |
| Prior social/table regressions | **17/17 PASS**, contained in current unit/server runs |
| New B-F1/F2/F3 regressions | **42/42 PASS**, contained in current unit/server runs |
| ONE current full server run | **32 files pass / 1 file fails; 364 tests pass / 1 fails; 365 total**, 211.91 s; `$G/server-full.log` |
| Independent defect probes | 3 post-erasure variants, 1 notification ordering and 1 chunk-relaunch assertion reproduce defects; external evidence only |

**The current server run is NOT a PASS.**
`hostile-payloads.integration.test.ts` lost one of 40 unauthenticated
`create-session` at-cap refusals at its existing 10-second reply bound. The
other 364 tests passed. The local gateway logged **499** for that request
(`$G/server-gateway.log`); the preserved runtime interval has no body-write-abort,
WORKER_LIMIT or hard-limit explanation. Its one command error is the test's
intentional prize-settlement failure. No simulator was booted; startup memory
query reported 30% free, about 6 GB existing swap. It would be unsupported to
assert this was necessarily the earlier simulator resource problem. Classification:
**unproven attribution** of a local delivery-timeout failure, not a confirmed new
Refresh-B product finding and not a green gate. No repeat-to-green was run.
This failure still requires explanation or a clean justified verification before
a future PASS; the prior split run is not substituted for it.

The secure-storage modifications preserve player binding for normal/retained
live credentials; unchanged social, room, table, matchmaking, cosmetics,
notification mutations and push retirement retain pinned headers and revision
guards. The B-R6 and stale-mutation suites passed against them. No reason was
found to repeat all 216 old timing probes. B-G2 is a separate same-player
preference-ordering error, not a regression of the cross-player retirement test.
No schema/RLS/function change was made by the seven-file repair, so unrelated
pgTAP/database suites were not rerun.

### 22.5 Release/native evidence and economic integrity

The archived Release bundle was rehashed independently:
**`3f2999e9bb48520819d9c7fb0b15c89671622883b8980923ab700e015c3c189d`**,
6,416,363 bytes. **246/246 source fingerprints; zero changed, added, removed or
newer.** Device A's installed `main.jsbundle` has that exact hash. Device B still
has the earlier `3eba8f7c…` bundle; §21 did not claim renewed flows on B.
`$G/native-artifact-review.json` records both instead of conflating them.

All ten preserved XML results were parsed: nine successful flows and the one
explicitly failed first deletion-cold-launch run. The failure screenshot was
visually inspected: the new player's handle is at the bottom edge and the
asserted recovery text is below the viewport. Its corrected scroll/rerun and
server readbacks support the documented harness classification. Keyboard/reset
requests are consistent with the saved step ordering, not evidence that the
product bypassed sign-in or resurrected the deleted account.

Accepted normal-path evidence: fresh pseudonymous player and cold restore;
Settings public/private with server version readbacks and one write per tap;
local sign-out/server revocation followed by a different cold-launch player;
replacement sign-in and friend request whose database sender is the displayed
player; deletion with all relevant server rows absent followed by a fresh
player. No broad native rerun was necessary. These ordinary passes do not
adjudicate the injected persistent states in B-G1/G3. The final source/build
freshness is accepted, not final software correctness.

Read-only final integrity: **5,934 users / 5,934 wallets; 0 wallet/ledger
mismatches; 0 negative balances; 0 opening-grant-count violations**
(`$G/integrity-final.txt`). Requested tests account for the increase; no users
were created solely to increase the aggregate, and audit-probe fixtures were
deleted. No economic production code was changed by this audit.

### 22.6 Repository hygiene and disposition

This review's only repository edit is this documentation record. The tracked
baseline patch is unchanged, the repair hashes and maintained tests remain
unchanged, and `git diff --check` passes. The index is empty:
`AGENTS.claude-backup.md`, external evidence, credentials and local environment
artifacts are not staged. No reset, stash, clean or history rewrite. The complete
checkpoint staging/commit step is intentionally not performed on FAIL.

Hosted activation remains outstanding: migration deployment, anonymous Auth,
manual linking/confirmed email, OTP/email-change templates and SMTP,
`arc21://auth/recovery`, public hCaptcha origin/site and private Auth secret,
signup limits/monitoring and hosted PostgREST compatibility. Physical
EAS/APNs/FCM, Android, hardware CAPTCHA, unconfigured-build native validation and
previously unrenewed mid-hand cash-out remain external/unproven. None was
activated or claimed passed here.

**ASTRA REFRESH B: FAIL**

**Known current confirmed Refresh-B release-blocking software defects: 3 —
B-G1, B-G2, B-G3.** B-F1 and B-F3 privacy are independently fixed; B-F2 is not
fully closed. No commit, push, deployment or hosted mutation. Refresh C/D/E has
not begun. The next repair should stay bounded to these three findings and the
specific evidence they invalidate; this review is complete and stops here.

## 23. Bounded repair of B-G1, B-G2 and B-G3 — October 3 to 4, 2026

**This is a repair record, not a verdict. Refresh B is NOT claimed to pass.**
§22's FAIL and its three findings are preserved above exactly as written, as is
every earlier FAIL, repair and piece of evidence. One primary agent, no
subagents, no Goal mode, no Refresh C/D/E. Branch `astra-refresh-b`, HEAD still
`47dba201ace488d932bb4e479416f52f79a6f176`; nothing committed, pushed, merged,
deployed, reset, stashed, cleaned or rewritten; no hosted Supabase setting,
datum or deployment touched. `AGENTS.claude-backup.md` remains untracked and
byte-identical (`d3477698…`). The work began on October 3 and resumed on
October 4 after a usage-limit pause; the stack, simulator, bundle and source
freshness were re-verified on resumption (23.11).

Evidence is outside Git in
`/Users/tj/arc21-evidence/astra-refresh-b-g-repair-20261003/` (**`$R`** in this
section only). The audit's directory (`$G`) was read, never written: its three
probes were COPIED into `$R/audit-probes-rerun/` before being run again.

### 23.1 Starting state, verified rather than assumed

- The tracked diff from `47dba20` hashed `8d65145f…`, byte-identical to the
  audit's `$G/final-tracked.patch`; `git status` hashed `92c3baf8…`, identical
  to `$G/final-status.txt`; the index was empty. Start-time copies:
  `$R/start-tracked.patch`, `$R/start-status.txt`,
  `$R/start-untracked-sha256.txt` (52 untracked files).
- This record hashed `a6f7cb9a…` before this section was added.
- The audited tree was copied OUTSIDE the repository before any edit
  (`$R/shadow/`); its nine production files hash exactly to §21's repaired
  hashes, i.e. the code the audit measured (`$R/shadow-source-hashes.txt`).
- GoTrue's answers were MEASURED before anything was designed on them
  (`$R/gotrue-user-endpoint-probe.json`, local GoTrue v2.195.0): an erased
  account's still-unexpired token gets `403 user_not_found` from `/user` (and
  from `/logout`); a revoked session of an existing account gets
  `403 session_not_found`; a live one gets 200.

### 23.2 B-G1 — root cause

Read from the audited adapter and the installed SDK (`@supabase/auth-js`
2.112.3):

1. `createOrRestore` returned whatever unexpired session `getSession()` read
   from the keychain. `getSession()` is local; nothing asked the server whether
   the account still existed.
2. Independently, the adapter forwarded every GoTrue announcement to the store,
   and GoTrue announces a stored session twice on start-up — the `SIGNED_IN`
   that `_recoverAndRefresh` queues and the `INITIAL_SESSION` every new
   subscriber receives. A verifying `ensurePlayer` alone would have been
   overtaken: the store adopted the restored player before any answer.
3. The deletion's knowledge that it had erased the account lived only in the
   process (the form's `CREDENTIAL_NOT_REMOVED`). A lost reply produced only
   `NETWORK`; a dead process produced nothing.

PostgREST accepts an erased account's still-valid JWT (it checks signature and
expiry, not `auth.users`), which is why the audit saw a `ready` player whose
friend request then failed at a foreign key rather than at authentication.

### 23.3 B-G3 — root cause

Two functions in `secure-session-storage.ts` parsed one stored format and
disagreed about exactly one shape: a head (`arc21.chunked.v2:0:4`) naming
chunks the native store answers do not exist. The removal ladder's
`restorable()` rightly called it `absent` — it can never be reassembled — so the
removal reported `removed` and sign-out succeeded. `read()` called the same shape
a storage FAILURE and reported durability `unavailable`, and `createOrRestore`
refuses to create a player while durability is `unavailable`. The ladder's own
last resort (break the chunks when neither the head delete nor the tombstone
write lands) creates that shape deliberately, nothing ever repaired it, and every
later launch read it and refused again. The keychain's health was never the
question.

### 23.4 The shared lifecycle architecture (B-G1 + B-G3)

One reconciliation in two layers, run at every cold bootstrap and every Connect
(`createOrRestore`; table in the adapter's own comment):

**Layer 1 — the keychain: one judgement (`inspect`, storage header point 4).**
A read and a removal's verdict now use the same function:

| Holding | Meaning | Read returns | Durability reported | A removal that leaves it so reports |
|---|---|---|---|---|
| `absent` | nothing, or the tombstone | null | `unknown` — `unavailable` only if a write or removal THIS instance saw fail | `removed` |
| `present` | a complete value | the value | `durable` (or the sticky `unavailable`) | `retained` |
| `broken` | a head naming material the native store answers is not there, or a malformed manifest | null, after a best-effort sweep | as `absent` | `removed` |
| `unreadable` | a native read THREW | null | `unavailable` | `unknown`, never `removed` |

`null` from `expo-secure-store` means "no such item" on both platforms — read
from the installed 57.0.4 sources: iOS returns nil only on `errSecItemNotFound`
(a locked keychain throws `errSecInteractionNotAllowed`); Android returns null
only for an item it can never decrypt, which it deletes — so only a THROW is
indeterminate. The sweep deletes the broken head, every chunk it names and the
generation descriptors; it writes nothing, so a crash anywhere in it leaves an
absence; it is attempted once per head per instance; nothing waits on it, so
cleanup correctness never depends on cleanup succeeding. Reporting `unknown`
for a proven absence also means a launch that found the keychain locked is not
stuck once it unlocks: the next read proves absence and Connect can proceed.

**Layer 2 — the server: `restore`.** A restorable credential is asked about with
its OWN token (`GET /auth/v1/user`) before anybody is shown:

| GoTrue's answer | Verdict | What happens |
|---|---|---|
| the user, same id | exists | confirmed; adopted |
| 403 `user_not_found` | erased | never adopted; the departure the deletion could not finish is finished (`depart`): `ACCOUNT_DELETED`, automatic creation paused exactly as after any deletion, Connect starts a new player — or `CREDENTIAL_NOT_REMOVED` with its own copy when the keychain still refuses |
| 403 `session_not_found` | ended — the account was FOUND, since GoTrue checks the subject before the session | GoTrue removes it itself; nothing left → an ordinary start; the keychain kept it → shown, consistently with what is served, exactly as B-F2's re-derive does mid-run |
| network failure, 5xx, timeout, unreadable answer | no verdict | nothing adopted, nothing removed; the root's reconnect handler retries a `NETWORK` failure |

**The gate.** Only a player the server has confirmed IN THIS PROCESS reaches the
store. GoTrue's own announcements of any other player — the start-up `SIGNED_IN`
and `INITIAL_SESSION`, or a sign-in's `SIGNED_IN` before its call returns — are
dropped, and the adapter announces a player itself at the moment the server
vouches for it (`confirm`): from a sign-in's, a sign-up's or a recovery
exchange's own response, or from `restore`. Announcing from the operation, not
its caller, preserves B-R6's guarantee that a reply arriving after the UI
stopped waiting still ends with the screen showing what the SDK serves — proved
by three controls that FAIL when that announcement is disarmed (23.9).

The durable, authoritative record of an erasure is therefore the server's own
`auth.users`, re-asked at every launch; there is no client-side "probably
deleted" flag. A relaunch over an erased account's credential with the keychain
still refusing is represented truthfully on every launch until it can finish.

### 23.5 B-G2 — root cause

`registerDevice(preferences)` captured the caller's snapshot when CALLED and
carried it through three awaits — the session read, the OS permission read and
the native Expo token request — before entering the device lane
(`mutateDevice`). The lane serialises WRITES in the order they reach it, which
is not the order the player chose them. Holding the older "Your turn: on" at its
token request let the newer "off" be written and acknowledged first; released,
the older registration entered the lane last and wrote its tap-time snapshot.
§21 had already moved `setKind`'s read of the store after the save, which
shortened the window but left the snapshot outside the lane: §21.13's residual 5
was the defect.

### 23.6 B-G2 — the ordering architecture

The allowlist is resolved INSIDE the device lane, immediately before the write:

- `registerDevice(source)` takes a `PreferenceSource` — the preferences, or how
  to read them — and resolves it in the lane's work function, after everything
  that can be delayed and before anything is written.
- `sync()` and `restore()`, the two "bring the server in step with Settings"
  operations, carry no preferences any more: their source is the Settings record
  itself (`devicePreferences`), in memory the moment a switch moves and saved
  behind it in order (§21's ordered saves).
- `enable(moment, preferences)` still names its preferences: it registers a
  state Settings records only once the server accepted it (a master switch must
  not stay on when the OS or server says no). A control proves enabling still
  registers the kinds being switched on before Settings records them.
- The lane still waits for each write's ACTUAL settlement, not the 12-second UI
  wait, so a later write cannot overtake an earlier one on the device.

So the last write carries the newest choice that existed when it was sent, and
no choice is newer than one sent after it. The old request is not ignored,
dropped or cancelled: it writes, and what it writes is the newest choice.
`sign-in.tsx`, `recovery.tsx`, `use-player-state.ts` and the Settings
sign-out-failure path were passing `useSettingsStore.getState().settings` to
`restore`; the change at each is the argument's removal. No migration: the
server's `register_push_token` remains a last-write-wins upsert.

### 23.7 Production files changed (9)

| File | Audited | Repaired | Change |
|---|---|---|---|
| `src/lib/supabase/secure-session-storage.ts` | `62ddcb6a…` | `e9c8ebf2…` | B-G3: `inspect`, `read` by it, sweep, absence durability; `restorable` by `inspect` |
| `src/features/auth/supabase-auth-adapter.ts` | `79831ccc…` | `cc7da35c…` | B-G1: `existenceOf`, `restore`, `finishErasure`, `afterEndedSession`, the confirmation gate, `confirm` from sign-in / sign-up / recovery exchange |
| `src/features/auth/auth-failure.ts` | `b099acec…` | `a307a02a…` | `ACCOUNT_DELETED` and `ERASED_CREDENTIAL_RETAINED` copy |
| `src/lib/notifications/push.ts` | `53cebd47…` | `d83b0b54…` | B-G2: `PreferenceSource`, resolved inside the lane |
| `src/features/notifications/use-push-registration.ts` | `af6e78f0…` | `a5d26965…` | B-G2: `sync()` / `restore()` read Settings at the write |
| `app/settings/index.tsx` | `f8606657…` | `48f629da…` | `setKind` calls `sync()`; sign-out-failure `restore()`; import back to HEAD's |
| `app/(auth)/sign-in.tsx` | `8dd3776c…` | `4fb72f1b…` | `restore()`; unused import removed |
| `app/auth/recovery.tsx` | `19c00926…` | `e88eabc1…` | `restore()`; unused import removed |
| `src/features/player/use-player-state.ts` | `c02d0213…` | `d4a8c23f…` | `restore()` (×2) |

Full hashes: `$R/production-source-hashes.json`. No migration, RLS, grant, Edge
Function, dependency or native-configuration change (`app.json`,
`package.json`, `package-lock.json`, `eas.json`, Babel, Metro and TypeScript
configuration byte-identical to the start) — so pgTAP, migrations,
`check:functions` and a prebuild were not needed, and none was run.

### 23.8 Maintained regressions — 4 new files, 59 tests

| File | Tier | Tests | What it proves |
|---|---|---|---|
| `tests/auth/credential-reconciliation.test.ts` | the production store (own `hydrate()`), adapter, real supabase-js and the PRODUCTION storage factory over an `expo-secure-store` double; GoTrue answered with the measured shapes | 39 | **B-G1**: an existing account restored (control) after one `/user` question with its own token; an account erased elsewhere never shown, its credential removed, `ACCOUNT_DELETED`, Connect then starts a player; `INITIAL_SESSION`/start-up `SIGNED_IN` never deliver an unconfirmed player while `/user` is held; offline and 503 are no verdict (nothing adopted or removed; restored once reachable); an ended session dropped then an ordinary start; an ended session the keychain keeps is shown, an ERASED one the keychain keeps is not; the audit's three variants (cleanup refused, reply lost, process ended) each relaunch to the `ERASURE_FINISHED` state; a keychain still refusing at relaunch says so truthfully and converges via Connect; a deletion that never reached the server is NOT taken for an erasure; uninterrupted deletion and sign-out (control). **B-G3**: the audit's reproduction (sign-out succeeds, keychain recovers, launch starts a player, leftovers swept BEFORE the new player is requested); the same without a relaunch; a creation tried while writes are still refused (B-R6 refusal) then the next launch; one chunk evicted, all chunks gone, a malformed manifest; a genuinely unreadable keychain and a head-readable/chunk-throwing keychain both fail closed with nothing created or touched; an unreadable launch later readable is not stuck; nine storage shapes on which a relaunch's read and a removal's verdict agree and an absence is never `unavailable`; the sweep cut at every native mutation; a refusing platform asked once. **Gate controls (VISIBLE == OUTBOUND)**: a sign-in and a creation answered after the UI stopped waiting, and a recovery whose new password is refused after the exchange, all end showing what the SDK serves |
| `tests/notifications/registration-ordering.test.ts` | the ACTUAL `setKind` compiled from `app/settings/index.tsx` (the audit's method), production Settings (ordered saves) and push stores, `push.ts`, real supabase-js over a last-write-wins model of `register_push_token`; only the OS permission, Expo token and EAS id doubled | 7 | **B-G2**: ON held at the token AND at the permission read, OFF acknowledged, ON released → memory, disk and server all OFF, and the released registration still wrote (not dropped); the mirror image → all ON; a `restore` handed a stale copy and delayed does not write it; uninterrupted choices (control); enabling registers the kinds being switched on before Settings records them (control) |
| `tests/server/credential-reconciliation.integration.test.ts` | **real GoTrue + Postgres**; the audit's own native double, production factory, store, adapter and friends store | 10 | the audit's B-G1 reproduction inverted, all three faults: relaunch `{seenErased:false, shown/sdk/stored:null, bootstrap:unavailable, failure:ACCOUNT_DELETED, rows:0}`, friend request refused with no row, nothing sent as the erased UUID; Connect then starts a NEW anonymous player whose friend request's database sender is the player shown; existing account restored (control) and asked about once with its own token; a deletion that never reached the server restores the account; an unreachable `/user` adopts and removes nothing, then restores; **B-G3** the audit's chunk-relaunch reproduction inverted (a new anonymous player, the departed player's sessions 0); an unreadable keychain fails closed and the player survives |
| `tests/server/notification-ordering.integration.test.ts` | **real GoTrue + PostgREST + Postgres**; the audit's probe inverted | 3 | ON held / OFF acknowledged / ON released → **`push_tokens.allowed_kinds` without `your_turn`**, memory and disk OFF, row still the player's and active; the mirror image → `your_turn` present; uninterrupted control |

**Changed, nothing weakened:** in `tests/auth/credential-departure.test.ts`, the
fixture of "a session GoTrue drops on its own, which the keychain keeps, stays
shown while it is still served" answered `/user` with `session_not_found` from
the FIRST request. A launch now asks `/user` before adopting anyone, so the
server must end the session AFTER the launch for that test to be about a session
dropped mid-run; the fixture now does exactly that. Every assertion is
unchanged, and the adapted file passes 24/24 on the audited code too (23.9).

**Three new native flows** (`tests/e2e/refresh-b/`): `offline-existing-launch`,
`offline-existing-reconnect`, `erased-account-launch` (23.11).

### 23.9 Negative controls

The new regression files were copied into `$R/shadow/` (the audited tree;
hashes identical, `$R/negative-test-hashes.txt`). No live file was disarmed.

| Tier | On audited code | Of the failures | Log |
|---|---|---|---|
| unit / wire (2 new files, 46 tests) | **30 fail**, 16 pass | **27 behavioural**, 3 new-protocol only (the `/user` question itself, and the two sweep-mechanics tests that need a sweep to exist) | `$R/negative-unit.log` |
| real backend (2 new files, 13 tests) | **9 fail**, 4 pass | **8 behavioural**, 1 new-protocol only (the `/user` question) | `$R/negative-server.log` |
| the adapted departure file | **24 / 24 pass** | — | `$R/negative-unit.log` |

The behavioural server failures reproduce the audit's own measurements in their
diffs: B-G1 ×3 `seenErased: true, shown = sdk = stored = <the erased UUID>,
bootstrap: ready, failure: null`; B-G3 `fresh: false, bootstrap: unavailable,
PERSISTENCE_UNAVAILABLE`, durability `unavailable`; B-G2 `server: true` after
release (and its mirror `server: false`). The 20 passes are exactly the
controls (`$R/negative-controls.json` classifies every row).

**The gate's controls have teeth.** The three VISIBLE == OUTBOUND controls pass
on the audited code (GoTrue's own event delivered those players) and on the
repaired code; with `confirm`'s announcement disarmed in a separate copy of the
REPAIRED tree (`$R/shadow-repaired-disarmed/`, adapter `36aefe90…` vs live
`cc7da35c…`), all three FAIL (`$R/shadow-repaired-disarmed-adoption-controls.log`).
The first version of the recovery control passed even disarmed — the following
`USER_UPDATED` delivered the player — so it was strengthened to the case only
the announcement protects (password refused after the exchange) before this
table was taken.

**The audit's own probes, re-run unchanged against the repaired tree** (output
paths only redirected; `diff`-verified):

| Probe | Audit read | Now |
|---|---|---|
| deletion boundary ×3 | `shown = sdk = stored = A, bootstrap: ready, failure: null`, `rows: 0` | `shown/sdk/stored: null, bootstrap: unavailable, failure: ACCOUNT_DELETED`, `rows: 0`; friend request refused, no row |
| chunk relaunch | before durability `unavailable`; after `bootstrap: unavailable, PERSISTENCE_UNAVAILABLE` | before durability `unknown`; after a new player `ready`, `failure: null` |
| notification ordering | `afterRelease.kinds` includes `your_turn` | `afterRelease.kinds` without `your_turn`; memory and disk false |

The probes assert the DEFECTS, so their assertions now fail; that is the
evidence (`$R/audit-probes-rerun/*.log`, `*-results.json`). The player the
chunk probe's relaunch now creates was removed by the probe's own cleanup.

Three leaked fixtures of this repair's OWN first server-file run (its second
suite's users were created after the first suite's cleanup had run) were found
by a user-count check, deleted by id, and the file was restructured so one outer
suite owns cleanup; every later run left 0 users behind.

### 23.10 Verification

| Gate | Result | Log |
|---|---|---|
| typecheck | pass | `$R/typecheck.log` |
| lint | **0 errors / 21 warnings — finding-for-finding identical to the audit's** | `$R/lint.log` |
| full unit suite (two workers) | **142 files / 2,628 pass** = the audited 2,582 + 46 new | `$R/unit-full.log` |
| targeted unit set | **9 files / 115 pass**: new 39 + 7; B-F 24 + 9; B-R 10 + 11 + 3; social/table 5 + 7 | `$R/targeted-unit.log` |
| new server regressions | **2 files / 13 pass** | 23.8; within the full run |
| **ONE full `npm run test:server`** | **35 files: 34 pass, 1 fail; 378 tests: 377 pass, 1 fail** (= the audited 365 + 13 new), 347.74 s | `$R/server-full.log` |
| B-R1–B-R6 | **40 / 40**: unit 24 above + server 16 in the full run's passing files | — |
| social/table | **17 / 17**: unit 12 above + server 5 in the full run | — |
| B-F1–B-F3 | **42 / 42**: unit 33 above + server 9 in the full run | — |
| account lifecycle / cold bootstrap / recovery server files | pass, in the full run | — |
| pgTAP, migrations, `check:functions`, prebuild | not run — no database, RLS, grant, Edge Function, dependency or native-configuration change | — |

`supabase functions serve` was restarted before the full run (CLAUDE.md); the
previous process had served since October 3 14:08 and appended only its 271
shutdown bytes to §21's log (`$R/x-functions-serve-log-size-before-stop.txt`).
The function answered 401 and the stack guard's database probe
`403 NOT_A_PARTICIPANT` before the run; no simulator was booted; load 5.05.

**The one failure, classified ENVIRONMENT, not rerun to green**
(`$R/server-full-classification.txt`): `game-command … the daily challenge >
reproduces the lost-reply truncation, and survives it` read its OWN
injected-loss counter as 0 instead of 1. The runtime log records 63 CPU
soft-limit and **2 CPU hard-limit** events (01:19:59.30Z, 01:20:00.40Z) followed
by supervisor-cancelled requests, and Kong answered exactly two `game-command`
requests **546** at 01:20:01Z — one replayed by the harness (logged). The test's
"pre-fix caller" is deliberately a plain `fetch` that stops at the first non-200,
so a real 546 ended its loop before the 18th `NEXT_HAND` where its proxy injects
the lost reply. The test drives only `game-command` with raw signed JWTs; this
repair changed no server code. The window's one other 5xx is the sprint suite's
intentional "injected failure during prize settlement" (passed). **The audit's
previously unexplained `hostile-payloads` refusal-delivery timeout did not
recur** — that file passed. Supplementary only, not a substitute: that single
test alone, at load 4, passed in 25 s with no new hard-limit event
(`$R/server-supplementary-lost-reply.log`).

### 23.11 Native Release evidence

**What was stale, measured.** §21's fingerprint method against its record
(`3f2999e9…`) found exactly the nine changed sources of 23.7 and nothing else,
of 246 (`$R/prebuild-freshness.txt`).

| Changed path | Native gate | Decision |
|---|---|---|
| storage `inspect` / `read`; first write | `refresh-b/fresh-player` | renewed |
| restore verified by `/user`; the gate | `refresh-b/cold-player` + gateway readback of the device's `GET /auth/v1/user` | renewed |
| no verdict → nothing adopted or removed; reconnect restores | NEW `offline-existing-launch` (Kong stopped) + NEW `offline-existing-reconnect` | added |
| departure + relaunch | `refresh-b/sign-out` | renewed |
| `signIn` confirms its own session (B-R6) | `refresh-b/sign-in-existing` + `refresh-b/social-send` (database sender) | renewed |
| ordinary deletion + relaunch | `refresh-b/delete-player` + `account-delete-cold-launch` | renewed |
| an erased account's credential at launch (B-G1) | NEW `erased-account-launch`, the account erased by the product's own `delete_own_account` from a SECOND session while the app was stopped — to the device, what a lost reply or a killed process leaves | added |
| `completePasswordReset` confirms the exchange | `refresh-b/request-recovery` + the REAL Mailpit link + `refresh-b/recovery-complete` | renewed |
| injected keychain faults, a lost reply, a killed process | cannot be staged on a simulator | proven at the SDK / backend tiers (23.8–23.9), as the audit did |
| B-G2 registration ordering | unreachable: no EAS project id, so `registerDevice` returns before any network call | proven at the wire and real-backend tiers with the native token boundary doubled; **not natively claimed** |

**The build.**

| Claim | Evidence |
|---|---|
| Build Succeeded, **0 errors / 1 warning**, re-bundled ("Eager bundle does not match new options"), CLI exit 0, installed on device A | `$R/release-build.log` |
| The binary is this tree | bundle SHA-256 **`ec64835dfba123944df58602cda4575540f1a030632098a2faa03f347457bc5f`**, 6,423,380 bytes, built 2026-10-04T01:35:14Z, **246 sources, 0 newer**; the record carries all nine repaired hashes (`$R/build.json`, `$R/build-fingerprint.txt`) |
| Device A runs exactly it; nothing else could serve a bundle | installed `main.jsbundle` hashes the same; no listener on 8081 before, during or after |
| Positive control only | the `ACCOUNT_DELETED` and erased-retained copy, `user_not_found`, `AuthSessionMissingError`, the tombstone and manifest prefix are present (1 hit each); a string scan cannot prove absence (`$R/bundle-positive-controls.txt`) |
| No source moved | re-checked before the flows (after the pause) and after them: same bundle, **0 changed / 0 added / 0 removed / 0 newer** (`$R/build-freshness-before-flows.txt`, `…-after-flows.txt`) |

**Flows.** Device A, iPhone 17 Pro `D16C4292…`, booted headless, one driver; the
one-minute load under 12 before each flow; anonymous sign-ins budgeted (0 in
the hour before the pass). Rows pair Maestro's own step counts with server
readbacks; gateway lines carry the device's user agent (`Arc21/1 CFNetwork`).
Evidence: `$R/native-<n>-<name>.{log,xml}`, `$R/native-<n>-<name>/`,
`$R/state-<n>-*.txt`, `$R/gateway-<n>.txt`, `$R/native-journal.txt`.

| # | Flow | Result (C / F / S) | Server-side readback |
|---|---|---|---|
| 00 | `e2e-fresh-app.ts` | SQLite and keychain reset | users 6,433 |
| 01 | `fresh-player` | **pass** (15 / 0 / 1) | one `POST /signup 200`, **no `/user`** (nothing stored to verify); **`able_yak_166021`** `ad67b7fb…` anonymous, 25,000 = ledger, 1 grant, 1 session |
| 02 | `cold-player` | **pass** (9 / 0 / 1) | the device's **`GET /auth/v1/user 200`** at launch; same UUID; users 6,434 |
| 03 | `offline-existing-launch` (Kong stopped, gateway `000`) | **FAIL** (8 / 1 / 1) — **HARNESS** | the screenshot shows "Offline player" with the caption below the fold: the scroll stopped at the title (§21.11's row 09 shape). Corrected to scroll to the last asserted line and assert both |
| 03b | the same, corrected | **pass** (12 / 0 / 1) | "Offline player" + "Could not reach the server…"; users unchanged; the player's session and live token **intact** |
| 04 | `offline-existing-reconnect` (Kong restored) | **FAIL** (4 / 1 / 0) — **HARNESS** | the app resumed on Settings, where the screenshot already shows **"Your player @able_yak_166021"**, and the flow waited for Home's balance; gateway `GET /auth/v1/user 200`. Corrected to open Home first, and the PAIR repeated |
| 03c / 04b | the pair again | **pass** (12 / 0 / 1), **pass** (10 / 0 / 2) | offline: nothing created or removed; after the gateway returned and the app was foregrounded, the device's `GET /auth/v1/user 200` and the **same** UUID, 1 session, 1 live token; users still 6,434 |
| 05 | `sign-out` | **pass** (19 / 0 / 2) | `/logout?scope=local 204`; `able_yak` **0 sessions, 0 live tokens**; the relaunch created **`fond_jay_417977`** `19bde49a…` |
| 06 | `sign-in-existing` (X1) | **pass** (26 / 0 / 4) | launch verified `fond_jay` (`/user 200`); `token?grant_type=password 200`; X1 `crisp_wren_856655` 1 session; `fond_jay` still exists, unmerged |
| 07 | `social-send` | **pass** (12 / 0 / 1) | `friend_requests`: sender **X1 `crisp_wren_856655` — the player shown** → `able_yak`, pending |
| 08 | `delete-player` (X1) | **pass** (15 / 0 / 1) | `rpc/delete_own_account 204`, `/logout 403`; X1's users, identities, sessions, profile, wallet, ledger, friend requests all **0** |
| 09 | `account-delete-cold-launch` (X1) | **pass** (26 / 0 / 2) | nothing to restore → **`fair_hare`** `87284418…`; X1's password **400**; X1 0 rows |
| 10 | `sign-in-existing` (X2) | **pass** (26 / 0 / 4) | X2 `mild_orca_494427` signed in, 1 session |
| 11 | X2 erased from a second session (`delete_own_account` **204**), app stopped; `erased-account-launch` | **B-G1 half passed; FAIL (12 / 1 / 1) after Connect — HARNESS** | the device's **`GET /auth/v1/user 403`** then **`/logout 403`**; screenshot: "Offline player" + "The player saved on this device was deleted, so it was not restored…"; `/signup` only after Connect (`amber_crane`). The post-Connect scroll ran DOWN past the taller signed-in card (screenshot shows "Sign out"/"Delete account"); corrected to read the new player on Profile, and the WHOLE scenario repeated with X3 |
| 12 | `sign-in-existing` (X3) | **pass** (26 / 0 / 4) | X3 `cozy_heron_896463` signed in |
| 13 | X3 erased from a second session (**204**), app stopped; `erased-account-launch` corrected | **pass** (18 / 0 / 2) | **`GET /auth/v1/user 403`, `/logout 403`**; X3 never shown; the deletion message shown; `/signup` 34 s later, only after Connect → **`misty_falcon`** `c2944931…` on Profile, not X3 |
| 14 | `request-recovery` (X4) | **pass** (12 / 0 / 1) | the device sent the reset; the real Mailpit link answered **303 → `arc21://auth/recovery`** with a PKCE code, opened on the device (`$R/state-14-recovery-link.txt`; the code is never exported) |
| 15 | `recovery-complete` (X4) | **pass** (18 / 0 / 3) | `token?grant_type=pkce 200`, `PUT /user 200`; audit `login`, `user_updated_password`, `user_modified` for X4; asked of GoTrue directly, **old password 400, new 200**; Settings shows "Secured player" with X4's address |

**Classified, not hidden.** Rows 06, 09, 10, 12 and 14 each logged a device
`POST /auth/v1/recover` INSIDE Maestro's `Hide Keyboard` step and before the
submit tap (timestamps per run in `$R/native-journal.txt`): the dismiss gesture
lands on "Email me a reset link" beneath the form, exactly as §21.11 recorded.
**HARNESS**; no such link was opened, and X1–X3 were erased. Rows 03, 04 and 11
are HARNESS failures whose screenshots show the state the flow exists to prove;
each was corrected to assert MORE, and its scenario re-run in full.

The disposable passwords existed only in a scratch file outside the repository,
deleted after the pass; a scan of every evidence file found none of them. Five
anonymous players were created by the flows (`able_yak_166021`,
`fond_jay_417977`, `fair_hare`, `amber_crane`, `misty_falcon`), each 25,000 =
ledger with one grant, left as earlier passes left theirs; X1–X3 were erased by
the product; X4 (`shiny_bison_047724`, secured) remains, its credentials only on
the simulator. Simulator A was shut down afterwards; simulator B was not used.

### 23.12 Wallet / ledger / opening grant

Asked of **every** wallet (`$R/integrity.sql`):

| Stage | users | wallets | wallet ≠ ledger | negative | `initial_grant` count ≠ 1 |
|---|---|---|---|---|---|
| before the native flows (`$R/state-00-before-native.txt`) | 6,433 | 6,433 | **0** | **0** | **0** |
| final (`$R/integrity-final.txt`) | 6,437 | 6,437 | **0** | **0** | **0** |

6,433 → 6,437 is exactly the five flow-created players plus the two
admin-created accounts made after the first readback (X3, X4) minus the three
the product erased (X1, X2, X3). The increase from the audit's 5,934 is this
repair's test runs; no user was created to raise the count. No economic code
changed.

### 23.13 Residuals and remaining blockers

**No known unrepaired instance of B-G1, B-G2 or B-G3.** No other blocker was
looked for beyond the bounded review below; this was a repair, not an audit.

1. **An erased account whose access token has ALREADY EXPIRED** (more than
   about an hour after the erasure locally) cannot be asked about: `/user` needs
   a valid token, and the refresh is refused with `refresh_token_not_found`,
   which GoTrue gives for a revoked session too. GoTrue drops it as dead and the
   launch starts a new player WITHOUT the deletion notice. The erased UUID is
   still never adopted. A client-side marker could add the notice but was
   deliberately not made a source of truth.
2. **The erased/ended distinction rests on GoTrue looking the subject up before
   the session** (`maybeLoadUserOrSession`), measured on local v2.195.0. Hosted
   GoTrue's version must be re-checked at activation.
3. **An existing player launched offline is not shown until the server answers.**
   Fail-closed by design (D): "Offline player", Practice available, the root's
   reconnect handler restores the same player when reachable (natively proved,
   rows 03c/04b). A 401/403 other than the two verdicts (e.g. `bad_jwt`) is
   `SERVER` and waits for Connect rather than the reconnect handler.
4. **A revoked-but-unexpired session at launch** used to be adopted until its
   token expired; it is now dropped at launch (a new player starts) — or, if the
   keychain keeps it, shown exactly as B-F2 shows it mid-run.
5. **In the SAME process, a deletion whose reply was lost** keeps showing the
   player with the `NETWORK` failure, as B-F2 left it; deleting again is
   harmless (an erased caller's `delete_own_account` answers 204) and the next
   launch reconciles.
6. **Screen stores that read the SDK's session directly** (for example
   `useAccountProfileStore.load()` on Profile mount) can issue READS with a
   restored credential during the launch's verification window — row 02's
   gateway shows two such profile reads in the same second as `/user`. Read-only;
   for an erased account they return nothing, offline they fail, and they write
   nothing to the shown identity unless it matches. The two automatic launch-time
   WRITES — the privacy reconciliation and the push re-association — are keyed on
   the store's shown, i.e. confirmed, player. Pre-existing pattern; not widened.
7. **B-R6's sticky write failure** still refuses creation for the rest of a
   process in which a creation's keychain write already failed (no orphan server
   players); the next launch proceeds (regression in 23.8).
8. **The sweep is best-effort**: on a platform refusing deletes, unrestorable
   fragments remain until the next commit or launch retires them.
9. **B-G2 orders on the device.** The last write carries the newest choice as of
   its sending; a write whose transport FAILED after the server received it,
   yet was processed after a later write, could still land late. A server-side
   preference revision on `push_tokens` would close that and needs a migration;
   not built. B-G2 remains unreachable in this build (no EAS project id) and is
   proved at the wire and real-backend tiers only.
10. **Android** null-versus-throw semantics were read in the installed module's
    source, not device-tested; physical keychain faults were never induced.
11. Everything §18.5, §20.5 and §22 classify as external — hosted activation,
    APNs/FCM/EAS, Android, hardware CAPTCHA, the unconfigured build, mid-hand
    native cash-out, lint warnings — is unchanged by this pass.

### 23.14 What Astra must challenge

1. **The gate.** That no path delivers an unconfirmed player to the store:
   `INITIAL_SESSION`, the start-up `SIGNED_IN`, `TOKEN_REFRESHED` before
   verification, `PASSWORD_RECOVERY`, `setSession`, the re-derive, and an
   announcement arriving after `confirmed` was cleared by a deletion.
2. **`confirm` from the operation.** That every server-issued session is
   confirmed exactly where it is issued (sign-in, sign-up, recovery exchange,
   restore, ended-but-kept) and nowhere else; that double adoption is harmless;
   that B-R6's refused writes never reach `confirm`.
3. **The existence verdicts.** The `user_not_found` / `session_not_found` order
   (residual 2); that every other answer is no verdict; that `ACCOUNT_DELETED`
   pausing creation matches the deletion's own end state; the ended-but-kept
   choice (residual 4) versus failing closed.
4. **`inspect`.** That it equals the old `restorable()` on every shape (the
   nine-shape agreement test); that only a throw is `unreadable`; that the
   absence durability (`unknown`) cannot clear a sticky write or removal
   failure; that the sweep can never make anything restorable.
5. **B-G2.** That reading Settings inside the lane is newest-intent-wins for
   every caller (`setKind`, `offer`, `restore`, `enable`); that `enable`'s named
   preferences cannot be overtaken; residual 9.
6. **The negative controls** — rebuild the shadow rather than trusting the logs
   — the disarmed-announcement copy, and the adapted departure fixture (23.8).
7. **The server run's one ENVIRONMENT classification** (23.10), from its
   runtime and gateway logs.
8. **The native scope and freshness** (23.11): rebuild and compare rather than
   trusting `ec64835d…`; the three HARNESS rows and their corrections.
9. **Residuals 1, 3 and 6** as product behaviour.

### 23.15 Exact state

- Branch `astra-refresh-b`, HEAD **`47dba201ace488d932bb4e479416f52f79a6f176`**,
  everything uncommitted; the index is empty. Nothing committed, pushed,
  merged, deployed, reset, stashed, cleaned or rewritten; no hosted change; no
  Refresh C/D/E work.
- `AGENTS.claude-backup.md` remains intentionally untracked and untouched.
- Production files changed by this pass: the **9** in 23.7 — eight tracked, and
  `src/features/player/use-player-state.ts`, inside the `src/features/player/`
  directory `git status` already listed as untracked at the start.
- Tests: **4 new files, 59 tests**; **1 changed** (the fixture in the untracked
  `credential-departure.test.ts`); **3 new native flows** in the untracked
  `tests/e2e/refresh-b/`. No assertion, timeout, retry policy, rate limit or
  worker count weakened.
- Release binary `…/Release-iphonesimulator/Arc21.app`, bundle `ec64835d…`,
  installed on device A; simulator A shut down after the pass.
- `supabase functions serve --no-verify-jwt` is RUNNING since October 3 18:16,
  logging to `$R/functions-serve.log`. The database was not reset; Kong was
  stopped twice for the offline proof and restarted immediately (health 200,
  function 401).
- Documentation: this section; §§1–22 are unchanged above it.
- **Refresh B is NOT claimed to pass.** §22 remains the standing verdict; this
  section is an unreviewed repair and its evidence. A fresh independent
  re-audit is required.

## 24. FINAL independent Refresh-B re-audit — October 4, 2026

**ASTRA REFRESH B: FAIL**

**Four confirmed release-blocking software defects: B-H1, B-H2, B-H3 and
B-H4. No checkpoint commit.** The review continued after each finding through
all remaining independent requested surfaces. This is the final bounded review,
not a restart of the historical migration/RLS/multiplayer/economics audit.
One primary agent; no subagents or Goal mode; no Refresh C/D/E work.

Branch and starting/current HEAD independently checked:
`astra-refresh-b`, **`47dba201ace488d932bb4e479416f52f79a6f176`**.
The initial tracked patch was byte-identical to §23's `final-tracked.patch`;
the nine repaired production hashes match its record. The index was empty.
The only repository edit made by this review is this documentation record.
Production code and maintained tests were not edited. No reset, stash, clean,
history rewrite, commit, push, deployment or hosted Supabase change.

Evidence for this section is
`/Users/tj/arc21-evidence/astra-refresh-b-final-20261004/` (**`$H`** below).
§23's evidence directory is **`$R`** below. The original record is preserved as
`$H/refresh-b.before-final-audit.md`; all previous audit and repair sections
remain below/above as historical evidence. Audit-only probe sources, configs,
logs and readbacks are outside the repository. Their passing assertions
**assert the reproduced defects**, not a passing product.

### 24.1 Consolidated confirmed blockers

#### B-H1 — P1: verification gates adoption, but not screen state or protected requests

**Reproduction (real GoTrue, Postgres and running Edge Functions):** persist a
valid existing player's session through the production secure-storage factory;
cold-hydrate the production Auth store while only that device's `/auth/v1/user`
request fails with a network error. The result correctly has no shown player,
`bootstrap: unavailable`, `failure: NETWORK`. Open Inventory and Daily through
the same production `load()` functions their screen mount effects call, then
invoke Daily's visible start action. No account verification has succeeded.

**Measured:** `shown: null` throughout; retained player
`8ad43474-ed9e-4676-a9d2-9b9a562c5d5d`; Inventory becomes `ready`, grants **four
cosmetics** (`public.user_cosmetics` count **0 → 4**); Daily becomes `ready` and
opens a **ranked** game `d2855025-c722-4181-b5be-a3200bb4fa01` as that player.
The recorded outbound actor on every RPC and `create-session` is the unadopted
UUID. This is neither a helper-only discrepancy nor merely temporary read data.
The fixture was removed by the probe's verified cleanup.

**Affected surface:** `src/features/cosmetics/cosmetics-store.ts:52` calls
`grant_earned_cosmetics` before its inventory read; `src/features/daily/daily-store.ts:65`
calls `ensure_todays_daily_challenge`, and its `start()` calls
`src/lib/supabase/session-intent.ts`. `app/profile/inventory.tsx` and
`app/daily/index.tsx` load without a confirmed-player guard. The Play routes are
available regardless of verification. `session-intent.ts` and
`src/lib/supabase/player-binding.ts` bind the SDK credential and scope revision,
not a server-confirmed adopted player. That was a valid premise before the new
intentional interval in which SDK identity and adopted identity differ.

**Violated invariant:** no protected actor or ready player-owned feature state
from an unverified restored credential. §23.13's claim that only harmless reads
can occur before verification is false. JWT validity/server authorization of the
RPC does not make the application's account-verification gate effective.

**Evidence:** `$H/verification-window.test.ts`,
`$H/H1-verification-window.json`, `$H/independent-probes.log`.

**Smallest bounded repair:** carry the confirmation/adoption boundary into
production loaders and protected dispatch; refuse or defer account-owned work
until its captured actor is confirmed, and invalidate results across that
boundary. Cover mutating "load" RPCs and the actual screen start action in
maintained backend regressions. Do not weaken server authority or replace it
with local identity. No repair was made here.

#### B-H2 — P1: a delayed notification offer restores stale opt-ins AND public privacy

**Reproduction:** an existing confirmed player has notifications off and a
`public` statistics preference. A friend-acceptance notification offer captures
Settings and starts an OS permission-status read; hold that read's earlier
`undetermined` answer. `busy` is still false. While it is held, enable
notifications through Settings, turn Friends ON then explicitly OFF, and choose
`private` statistics. Wait for both current settings and authoritative writes.
Release the older OS answer. Its `offer()` computes preferences from its old
argument, calls `enable()` with that object, and returns it. The production
Social/Tournament/Lobby callers persist the entire returned object.

**Measured against Postgres:** before release, Friends memory/disk/server all
**OFF**. After the old registration, memory/disk remain **OFF**, server becomes
**ON**. After the caller persists the return value, all three are **ON**.
Additionally, `profiles.privacy` changes **private → public**, with memory and
disk also `public`, when the root's actual `reconcileProfilePrivacy` body runs
for the resulting Settings change. The offer returned all **14 AppSettings
keys**, not only notification keys. This is why an unrelated explicit privacy
choice is undone. The prior privacy version/CAS protection correctly treats
that stale snapshot's newly issued write as current; it cannot infer the lost
intent.

**Affected surface:** `src/features/notifications/use-push-registration.ts:132`
(`offer`, its pre-busy permission await and captured `preferences`), `enable`
at line 104, `preferencesAfterGrant` in `notifications.ts`, and
`updateSettings(granted)` at `app/(tabs)/social.tsx:143`,
`app/table/lobby.tsx:140`, `app/tournament/index.tsx:63`. The root privacy effect
then synchronizes the overwritten visibility. Settings' busy flag protects the
normal single master-enable operation; it does not cover this earlier offer
await or reject its obsolete intent.

**Violated invariant:** an older asynchronous offer must not defeat a later
explicit opt-out or broaden the user's explicit profile privacy. The repair's
current-value read covers `sync` and `restore`, but **not all production
preference sources or their later persistence**. This is one consolidated
finding because both consequences come from the same obsolete full snapshot.

**Evidence:** `$H/push-offer.test.ts`, `$H/H2-stale-offer.json`,
`$H/H2-stale-offer-initial.json`, `$H/offer-privacy-probe.log`.
Production Auth, Settings, registration, RPC and privacy synchronization run;
only the native permission/token boundary is doubled. The actual `setKind`
handler is compiled from the screen source. This is not a native-push claim.

**Smallest bounded repair:** make pending offers/enables respect newer Settings
and player intents across their earliest await and final persistence; emit a
narrow notification patch rather than spreading an old AppSettings object;
ensure opt-out wins in the registration lane and caller. Add the delayed-offer
plus unrelated-privacy-change backend regression. No repair was made here.

#### B-H3 — P1: a locally generated session-missing error re-adopts an erased UUID

**Reproduction (real GoTrue/Postgres):** persist a player, erase that account
remotely, and cold-hydrate over the retained credential. Let
`createOrRestore()` read storage successfully. During the real SDK's
`getUser()` call, make native keychain reads throw, then recover them when that
call returns. No Auth response is substituted: the probe invokes the original
SDK method while toggling only the native storage fault.

The installed SDK's `_getUser` first calls `_useSession`. With no readable
access token it **locally returns `AuthSessionMissingError`**, without making
`GET /user` (`node_modules/@supabase/auth-js/src/GoTrueClient.ts:3239`).
`existenceOf()` treats the error's **name alone** as proof that the server found
the account but its session ended. `afterEndedSession()` rereads the recovered
keychain and calls `confirm(served)`.

**Measured:** account `8c40f0c7-b026-4b8e-af83-037f6a1fc38d` has **0 auth.users
rows**, but is observed in the store and becomes **shown = SDK = stored**,
`bootstrap: ready`, `failure: null`. There are **zero `/auth/v1/user` requests**;
profile reads are sent as the erased UUID. The exact original B-G1 unsafe state
has returned through a different branch.

**Affected surface:** `src/features/auth/supabase-auth-adapter.ts:94`
(`existenceOf`, especially line 101), `restore` at line 270, and
`afterEndedSession` at lines 317–325. The native storage classifier properly
reported unreadable; the Auth adapter incorrectly promoted that SDK-local
absence to an authoritative existence verdict.

**Violated invariant:** an unverified restored credential must never become a
normal ready player; an unreadable/indeterminate keychain is not server account
confirmation. The INITIAL_SESSION/SIGNED_IN filter itself remains operative,
but the adapter's own `confirm()` bypasses it on this branch.

**Evidence:** `$H/verification-window.test.ts`,
`$H/H3-local-session-missing.json`, `$H/independent-probes.log`.

**Smallest bounded repair:** adjudicate restoration using the exact credential
being verified, and distinguish an actual authoritative ended-session response
from a locally synthesized SDK error. An indeterminate local reread must retain
the credential and adopt nobody. Preserve B-F2's truthful live retained-session
behavior without treating it as proof for a cold launch. Add the interleaved
read-fault regression through the real SDK and backend. No repair made here.

#### B-H4 — P2: device serialization does not order writes after ambiguous transport failure

**Reproduction (actual local HTTP proxy + real PostgREST/Postgres):** with a
registered device, turn Your turn ON. A loopback proxy accepts the complete
registration request, keeps its work queued, and closes the client connection.
The production call reports `Could not register this device`; its promise
settles and the device lane advances. Turn Your turn OFF and wait for its
successful database write. Release the already accepted older request from the
proxy to the real RPC, preserving its original body and authorization.

**Measured:** before releasing it, memory/disk/server all **OFF**. The old
request receives **204** from PostgREST; afterwards memory **OFF**, disk **OFF**,
server **ON**. The device is not restarted and no second device is involved.
The proxy models accepted server work outliving a disconnected caller; it does
not change preferences or fake database responses. Its listener and fixtures
are closed/removed after the probe.

**Affected surface:** `src/lib/notifications/push.ts:49` (`mutateDevice`, the
settled/rejected promise releasing its lane) and `registerDevice`'s RPC body;
`public.register_push_token` remains an unconditional last-arrival upsert of
`push_tokens.allowed_kinds` in migration
`20260817400000_notification_delivery.sql:214`.

**Violated invariant:** newest preference must win at the actual authoritative
write boundary. A connection's settlement is not settlement of accepted remote
work. §23.13 residual 9 is therefore **a current software blocker**, not simply
external EAS/physical-device validation. The original delayed-token fix does
not cover this separate transport boundary.

**Evidence:** `$H/push-transport.test.ts`,
`$H/H4-transport-ordering.json`, `$H/transport-probe.log`.

**Smallest bounded repair:** give registration/opt-out operations an
authoritative causal ordering or equivalent durable reconciliation that rejects
an obsolete accepted write, including transport failure and restart. A
per-token version/CAS protocol is one bounded option; no account-wide preference
semantics or broad economic migration is implied. Test the delayed accepted
request against final Postgres state. No repair made here.

### 24.2 B-G1, B-G3 and the four-way credential consistency result

- **B-G1: NOT closed.** The maintained existing-account, erased-account,
  response-loss, process-death and failed-cleanup cold-launch reproductions pass.
  Ordinary INITIAL_SESSION/SIGNED_IN events cannot adopt an unconfirmed UUID.
  Additional audit controls sent INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED,
  PASSWORD_RECOVERY and USER_UPDATED during a held verification; none bypassed
  the event filter. A later successful answer adopted the stored player after
  the UI timeout. **B-H3 is an independent adapter-confirmation bypass.**
- Offline/503 responses retain the credential and adopt nobody; reconnect or
  explicit retry restores an existing account. Empty, wrong-UUID and malformed
  `/user` answers were additionally tested through two launches: none deletes
  or adopts; normal answers then restore. A timeout is not deletion. A real
  remote `session_not_found` and the SDK's locally synthesized same-name error
  must be distinguished; §23 did not do so.
- Normal replacement sign-in, delayed sign-in/signup completion, recovery
  exchange with refused password, fresh pseudonymous creation and successful
  deletion/sign-out retain their maintained passing controls and native evidence.
- **B-G3: independently fixed for the requested absent/broken/unreadable cases.**
  One `inspect` classifies plain/complete values, tombstones, missing chunks and
  malformed manifests. Any missing required chunk is provably non-restorable;
  read exceptions remain indeterminate. Stale descriptors do not become a head.
  `read` and removal's `restorable` share that interpretation. Sweeps only
  delete, cannot restore secret material, and refusal/partial deletion cannot
  make a broken value valid. Existing shape, every-mutation interruption,
  refusal, chunk-throw and later-storage-recovery tests pass. Sticky write or
  retained-removal failures are not cleared by an ordinary successful read.
- **B-R6 and B-F2's original protections still pass:** a failed A → B durable
  replacement rejects before announcing B; a failed sign-out that leaves A
  restorable does not silently announce clean departure. **Combined four-way
  consistency nevertheless fails:** B-H1 allows protected actor A with no
  confirmed/adopted player, and B-H3 allows ready A with no server account.
  This is not a reason to discard the independently meaningful storage results.

**Expired erased credential residual:** tested with real retained tokens of a
remotely erased account and an expired local session deadline, forcing the
actual SDK refresh path. No erased UUID was adopted, its account remained absent,
and the eventual new UUID had exactly one opening grant. There is an additional
qualification to §23's wording: the first launch in this probe stopped at
`unavailable / SERVER` after refresh refusal; **Connect** then created the new
player. The initial audit-only assertion expecting immediate automatic creation
failed and is preserved (`gate-controls.log`); the diagnostic controls and real
backend agree (`expired-control.json`, `expired-real-backend.json`,
`expired-backend.log`). This is an **unsupported automatic-creation detail / UX
limitation**, not another authority blocker: no merge, old identity attribution,
new grant to the erased identity, or false continued-access claim occurred.
Loss of the more specific deletion notice remains non-blocking. B-H3 is separate.

### 24.3 Requests during verification and notification residual adjudication

Read paths were traced from the screens to stores and the current deployed
function bodies (`$H/read-rpc-definitions.txt`), not classified from HTTP verbs:
profile; level/competition; loadout/inventory; Career; Daily; Sprint;
leaderboards/personal rank; active-session lookup; inbox; and friend/search
surfaces can read SDK identity without consulting Auth-store confirmation.
They expose profile/loadout/progression, owned cosmetics, competition history,
active game addresses, notifications and social data appropriate to that SDK
actor. Several feature stores can become `ready` while the Auth store has nobody.
Profile's main identity/XP copy does check `hasAccount`, but that is not a
universal store/render guard (for example Inventory and Daily).

Most inspected projections are stable reads. Concrete exceptions:
`grant_earned_cosmetics` inserts inventory/loadout rows;
`ensure_todays_daily_challenge` creates today's challenge and reveals closed
seeds; and **`search_players` consumes `enforce_rate_limit('player_search')`**.
Presence's heartbeat is an explicit `touch_last_seen` write, with normal callers
keyed to shown identity; it is not evidence that all SDK-based loaders are safe.
The root privacy/push effects are shown-player keyed as claimed. That does not
protect the independent screen mutations in B-H1.

The installed `usePlayerState` subscription resets caches and increments player
scope when a confirmed UUID is adopted/replaced, and older replies are rejected
by that revision. No new cross-player cache-survival defect was demonstrated.
That does not make preconfirmation display or mutation harmless, nor require
waiting for replacement before classifying B-H1.

**B-G2 original ordering scenarios pass:** held ON → acknowledged OFF → released
ON; the inverse; permission/token holds; restore with old caller arguments;
normal uninterrupted registration; final real database readbacks. `sync` and
`restore` resolve current Settings inside the lane, and UI timeout alone does
not release an unsettled write. Normal master enable holds `busy`, but the
old-offer gap (B-H2) and ambiguous transport settlement (B-H4) remain.

**Two devices:** `push_tokens` is keyed by **token**, with `user_id`, per-token
allowlist and active flag; delivery requires the particular token's active
allowlist. Settings is device-local. One physical device's opt-out is not an
account-wide promise to turn off another device's separate token. No new
cross-device last-writer-wins requirement is imposed. Foreground/reconnect and
ordinary cold restore resend current local Settings; a process restart erases
the in-memory lane and cannot retroactively order older accepted server work.
That is the same causal gap B-H4 proves without needing a restart.

### 24.4 Regression quality and current verification

The four new maintained files contain **59 tests: 46 unit/wire (39 + 7), 13
real-backend (10 + 3)**. The prompt's 39-unit/20-backend split is not the actual
file split. They exercise production storage factory, store hydration, SDK,
Auth adapter and registration, the compiled Settings handler, and real database
readbacks. They are useful regressions, but omit B-H1's other screen callers,
B-H3's read failure *inside* SDK verification, B-H2's offer/persistence path and
B-H4's accepted work after transport failure.

The departure fixture adaptation changes when its server fixture becomes ended
(after successful launch); original assertions remain intact, and one assertion
that A was adopted is added. This preserves its original mid-run scenario.

| Current independent gate | Result | Evidence |
|---|---|---|
| Typecheck | PASS | `$H/typecheck.log` |
| Lint | 0 errors / 21 warnings | `$H/lint.log` |
| Full unit, two workers | **142 files / 2,628 PASS** | `$H/unit-full.log` |
| Targeted unit | **9 files / 115 PASS** | `$H/targeted-unit.log`, `targeted-test-inventory.json` |
| ONE full `npm run test:server` | **35 files / 378 PASS**, uninterrupted, 257.61 s | `$H/server-full.log` |
| B-R1–B-R6 maintained regressions | **40/40 PASS** (24 unit + 16 server) | current suites |
| Prior social/table | **17/17 PASS** (12 unit + 5 server) | current suites |
| B-F1–B-F3 maintained regressions | **42/42 PASS** (33 unit + 9 server) | current suites |
| New maintained backend files | **13/13 PASS**, included above | current server run |

The 115 targeted tests are 39 reconciliation + 7 registration + 24 departure +
9 privacy + 10 replacement + 11 stale-player-state + 3 push-retirement +
5 stale-social-mutation + 7 stale-table. The historical protections pass their
existing scenarios; **B-H2 still violates privacy via a previously untested
upstream caller**, so these counts are not a universal claim that privacy is safe.

Negative controls were independently checked, not taken on trust:
all nine vulnerable production hashes match §23's shadow, live repaired hashes
match §23, and the four new tests plus departure fixture match the shadow
byte-for-byte (`source-shadow-review.json`). Rerunning the shadow unit set
reproduced **30/46 new failures (27 behavioral, 3 protocol) + 24/24 departure
passes** (`negative-unit-reproduced.log`). The preserved backend control has
**9/13 failures (8 behavioral, 1 protocol)**, including the old erased UUID,
chunk poison and database allowlist diffs. Its hashes/logs were inspected; no
additional negative backend run was needed. The repaired disarmed shadow differs
by only the `confirm()` announcement; rerunning its three adoption controls
produced **3/3 failures** (`disarmed-controls-reproduced.log`). The live tree
was never disarmed.

The prior 377/378 run's CPU-hard-limit/546 explanation is consistent with the
preserved runtime and the failing test's plain-fetch early-break logic; the
current clean full run independently resolves the broad gate without repeating
it to manufacture green. No DB reset or unrelated pgTAP/RLS/function suite was
run: §23 changed no server, schema, grants or dependency boundary for those gates.

### 24.5 Release/native evidence and residual classification

Independently rehashed archive and installed Device A `main.jsbundle`:
**`ec64835dfba123944df58602cda4575540f1a030632098a2faa03f347457bc5f`**,
6,423,380 bytes. **246/246 source fingerprints, 0 changed/added/removed/newer**
(`$H/build-freshness.txt`, `native-artifact-review.json`). No native rebuild or
flow rerun was necessary for evidence freshness; the software blockers above
remain blockers in this same binary.

Parsed all **18** saved XML reports: **15 passing flow runs and 3 failed runs**.
The three failure screenshots were visually inspected: offline text below the
fold; reconnect assertion looking for Home balance while Settings already shows
the restored player; and post-Connect downward scroll past the signed-in card.
Their corrected full scenarios passed. Gateway timings and Maestro ordering
support the documented keyboard-dismiss accidental reset-link taps as harness
interactions, not autonomous authentication. No failure was silently counted as
passed (`native-xml-detail.json`; §23's original logs/screenshots/readbacks).

Accepted native evidence on the repaired Release: offline existing-player
launch and same-player reconnect; fresh creation/cold restore; sign-out;
replacement sign-in and friend-request sender readback; deletion/cold launch;
remote-erasure launch with `/user 403`, deletion message and signup only after
Connect; and real Mailpit → `arc21://auth/recovery` PKCE exchange/password update,
old password 400/new password 200. These ordinary scenarios do not test the
injected H3 timing or H1/H2/H4 cases.

Residuals are classified explicitly:

- **Current software blockers (A):** B-H1–B-H4, including the documented
  ambiguous notification-write residual. Not waived because EAS is absent.
- **External activation/release validation (B):** hosted GoTrue erased/ended
  semantics/version, Android behavior, physical keychain/platform fault behavior,
  physical EAS/APNs/FCM registration/delivery, hardware CAPTCHA, unconfigured-build
  native validation, and previously unrenewed mid-hand native cash-out. None is
  claimed passed. Native-token doubles plus real production/Auth/backend logic
  are sufficient to test the software registration contract; they prove no
  physical delivery.
- **Non-blocking limitations (C):** offline restored identity stays unadopted
  until verified; expired erased sessions lose deletion-specific copy and may
  require Connect after the refresh refusal; provably unusable keychain
  fragments can remain when cleanup is refused. Existing lint warnings remain.

Hosted Supabase was not modified. Existing activation requirements remain:
migration deployment, anonymous Auth, manual linking/confirmed email, OTP/email
change templates and SMTP, `arc21://auth/recovery`, public hCaptcha origin/site
and private Auth secret, signup limits/monitoring, hosted PostgREST compatibility,
and revalidation of `/user` erased/ended behavior. No external item was silently
promoted to a pass.

### 24.6 Economic integrity, hygiene and disposition

One final read-only aggregate: **6,933 users / 6,933 wallets; 0 wallet/ledger
mismatches; 0 negative balances; 0 opening-grant-count violations**
(`$H/integrity-final.txt`). The full maintained server suite creates its normal
fixtures; this review's additional probe users were cleaned up, including its
new pseudonymous expiry-control player. No users were made to increase counts.
No economic production code was changed.

The candidate-file inventory contains 103 tracked modifications and 59 untracked
files (including the intentional backup and this existing untracked report).
The initial complete tracked patch matches the previously recorded repair patch;
changed shared dependencies and their callers were reviewed without reopening
accepted unrelated historical security work. The final secret-pattern inventory
found only the two published local-demo JWT values and the intentionally fake
secret refusal fixture (also quoted in the old report), not a new real secret.
The index is empty; no credentials, scratch artifacts, local evidence or local
environment files are staged. `AGENTS.claude-backup.md` remains untouched and
untracked, SHA-256 `d34776982b696fb465d6bdec9e9d5e01419c5876383b732d40447f143e0fcb1c`.
Exact pre-existing untracked paths: `$H/untracked-inventory.txt`. No new
repository file was added by the audit. Audit evidence stays outside Git.

**ASTRA REFRESH B: FAIL**

**Confirmed current release-blocking software defects: 4 — B-H1 (P1), B-H2
(P1), B-H3 (P1), B-H4 (P2).** B-G3 is adjudicated fixed; the original B-G1/G2
reproductions pass but their complete requested invariants do not. Original
B-F2/B-R6 regressions pass, while combined confirmation/actor consistency fails.
The independent verification, native evidence and hygiene checks above remain
meaningful despite these findings. **No checkpoint, push, deployment or hosted
mutation. Refresh C/D/E has not begun.** This review is complete.

## 25. Bounded repair of B-H1, B-H2, B-H3 and B-H4 — October 4, 2026

**This is a repair record, not a verdict. Refresh B is NOT claimed to pass.**
§24's FAIL and its four findings are preserved above exactly as written, as is
every earlier FAIL, repair and piece of evidence. One primary agent, no
subagents, no Goal mode, no Refresh C/D/E. Branch `astra-refresh-b`, HEAD still
`47dba201ace488d932bb4e479416f52f79a6f176`; nothing committed, pushed, merged,
deployed, reset, stashed, cleaned or rewritten; no hosted Supabase setting,
datum or deployment touched. `AGENTS.claude-backup.md` remains untracked and
byte-identical (`d3477698…`). The work paused once for about four hours on a
usage limit; the stack, source and bundle freshness were re-verified on
resumption (25.12).

Evidence is outside Git in
`/Users/tj/arc21-evidence/astra-refresh-b-h-repair-20261004/` (**`$K`** in this
section only). The audit's directory (`$H`) was read, never written.

The four findings were repaired as the two architecture problems they are:
**Group A — authoritative player confirmation (B-H3 + B-H1)**, then **Group B —
authoritative notification-intent consistency (B-H2 + B-H4)**.

### 25.1 Starting state, verified rather than assumed

- The tracked diff from `47dba20` hashed `e21c183e…`, byte-identical to the
  audit's `$H/final-tracked.patch`; `git status` hashed `e3e8aa9f…`, identical
  to `$H/final-status.txt`; the index was empty; 59 untracked paths
  (`$K/start-*.txt`, `$K/start-tracked.patch`).
- This record hashed `f3a5c145…` before this section was added
  (`$K/refresh-b.before-s25.md`).
- The audited tree was copied OUTSIDE the repository before any edit
  (`$K/shadow/`, 345 source hashes in `$K/shadow-source-hashes.txt`); its
  adapter, `push.ts`, registration store and Settings screen hash exactly to
  §23.7's repaired hashes, i.e. the code the audit measured.

### 25.2 B-H3 — root cause and the provenance repair

**Root cause, read from the audited adapter and the installed SDK
(`@supabase/auth-js` 2.112.3).** `restore()` asked "does this account exist?"
through `client.auth.getUser()` with no argument. That call loads the session
back out of storage (`_useSession` → `__loadSession`) BEFORE it sends anything,
and with nothing readable it RETURNS `AuthSessionMissingError` locally
(`GoTrueClient.ts:3239`). GoTrue's own `session_not_found` answer is mapped to
the very same class (`handleError`, `lib/fetch.ts:138`). `existenceOf` read the
error's NAME as the server's verdict "session ended, account found", and
`afterEndedSession` re-read the recovered keychain and `confirm()`ed it. So a
keychain read fault became server confirmation of an erased account, with zero
`/user` requests.

**Repair (`supabase-auth-adapter.ts`).** The existence question is now asked
directly — `askAuthServer(client, token)`: one `GET {auth}/user` carrying exactly
the restored credential's access token, sent through the client's own GoTrue
transport (`url`, `headers`, `fetch`, pinned for 2.112.3 by a test; an
unrecognised shape asks nothing and is no verdict). Its result type makes
provenance structural:

| What happened | `UserAnswer` | Verdict |
|---|---|---|
| fetch threw, transport unknown, no token | `answered: false` | **no verdict** — `NETWORK`, nothing adopted or removed |
| 2xx, body is the same account | answered | `exists` → `confirm` |
| 2xx, another id / unreadable body | answered | no verdict (`IDENTITY_CHANGED` / `NETWORK`) |
| 500–504, 520–530 | answered | no verdict (`NETWORK`, the SDK's own retryable list) |
| 4xx `user_not_found` | answered | `erased` → departure finished, `ACCOUNT_DELETED` |
| 4xx `session_not_found` | answered | `ended` → removed; never adopted (below) |
| any other 4xx / unreadable 4xx | answered | no verdict (`SERVER` / `UNKNOWN`, as the SDK mapped them) |

A verdict can only be built from a `Response` the adapter itself received; there
is no path from a locally generated error to one. The 12-row answer table
(`user-verification-provenance.test.ts`) passes on BOTH the audited and the
repaired adapter — the re-implementation classifies every real server answer
exactly as before — and only the local-failure rows differ.

**The cold-launch "ended but kept" branch.** At a launch, the server's answer
about this exact credential being `session_not_found` means it cannot
authenticate. The audited code then re-read the keychain and adopted whatever it
served — the mechanism §24 named. Following §24's recommendation ("preserve
B-F2's truthful live retained-session behaviour without treating it as proof for
a cold launch"), `finishEndedSession` removes it as any departure is: removed →
an ordinary start (unchanged behaviour); kept by the keychain → **not adopted**,
`CREDENTIAL_NOT_REMOVED` with its own copy (`ENDED_CREDENTIAL_RETAINED`), and
Connect retries the removal. Mid-run, B-F2's live behaviour (`rederive`) is
untouched.

### 25.3 B-H1 — root cause and the central confirmation gate

**Root cause.** Twelve account-owned stores and the push registration asked
`client.auth.getSession()` "is somebody signed in?", and `bindCurrentPlayer` /
`sendSessionIntent` did the same. The SDK serves a restored credential before anybody has asked the server
about it, and attaches it to every request it sends — so with `/user` failing
and nobody adopted, Inventory's load granted cosmetics and Daily opened a ranked
game. Separately, three paths never asked at all (`my_career_progress`, a career
drill submission, and the public `sprint_format` read), and the presence
heartbeat acts as whoever the SDK holds.

**One rule, at the identity boundary, with a dispatch floor beneath it.**
"Server-authority-bearing player work requires the server-confirmed current
player" is implemented as: the SDK's session counts only when it belongs to the
player the app has ADOPTED — and the Auth store adopts a player only on the
auth server's word.

1. **Adoption is published** (`auth-store.ts` → `adopted-player.ts`): every
   change of the shown player is pushed, synchronously, to a tiny registry the
   network layer reads.
2. **Identity resolution** (`player-binding.ts`): `confirmedSession(client)`
   returns the SDK session only if it is the adopted player's, and otherwise
   exactly what "nobody signed in" returns; `bindCurrentPlayer` refuses
   (`signed-out` when nobody is adopted, `identity-changed` when the SDK serves
   somebody else) and re-checks adoption immediately before every write;
   `sendSessionIntent` likewise. The twelve store loaders, push registration, the
   career refresh and drill, and single-notification mark-read now take their
   identity from here; the public format read is sent as nobody
   (`sentAsNobody`). A contract test scans `src/` and `app/` so no file but the
   adapter and the boundary itself can read the SDK session again.
3. **The dispatch floor** (`client.ts`, `adoptionGatedFetch`): the production
   client's own fetch refuses any non-auth request whose bearer is not a player
   adopted on that client in this process. It catches what never asked — the
   presence heartbeat, a loader's un-pinned request racing a sign-in, anything
   added later — and lets a departing player's already-bound retirement finish
   (B-R5). Auth endpoints and publishable-key-only requests pass.

"Managed" clients: the production client is subject to the rule from birth
(before the adapter exists, because a screen's first load can run before the
root starts hydration); any client the auth adapter is attached to becomes
subject to it. A harness client built by hand with no identity lifecycle has no
adopted player to compare with; none exists in the shipped app.

Offline Practice is untouched: it sends nothing. Screens that load keyed on the
adopted player now reload after confirmation; Inventory was the one that loaded
on mount only and is now keyed the same way.

### 25.4 Startup-reachable operations, reclassified under the gate

The bounded review: every account-owned server call reachable from a screen or
root hook at start-up, traced to the store and, where it matters, to the
deployed function body (§24's `read-rpc-definitions.txt`). "Read-only" was not
taken from the HTTP verb.

| Operation | Effect on the server | Before (audited) | Now, while nobody is adopted |
|---|---|---|---|
| `grant_earned_cosmetics` (Inventory load) | **writes** inventory/loadout rows | sent as the restored player | not sent (`confirmedSession`); screen says "Connect…" |
| `ensure_todays_daily_challenge` (Daily load) | **writes** today's row, reveals closed seeds | sent | not sent |
| `START_DAILY_CHALLENGE` (Daily start) | **writes** a ranked game | sent | not sent (`sendSessionIntent`) |
| `search_players` (Social search) | **spends** the caller's rate-limit budget | sent | not sent (`bindCurrentPlayer`) |
| `touch_last_seen` (presence) | **writes** `last_seen_at` | sent as whoever the SDK held | not sent (presence waits for an adopted player; dispatch floor) |
| profile privacy sync, push registration | **write** | keyed to the shown player already | unchanged; also re-checked at the write |
| `my_career_progress` (Career refresh) | read | sent with **no** identity check at all | not sent |
| career drill submission | **writes**, pays | unbound, unpinned | not sent; now pinned to the adopted player |
| `mark_notifications_read` (one id) | **writes** `read_at` | unbound | not sent; pinned |
| profile, level, competition, loadout, inventory, notifications, sprint entry/standings, daily entry, active session, wallet, friends, leaderboard rank | read of the player's own data | sent | not sent |
| leaderboard boards | read; executable by `authenticated` only | sent as the restored player | not sent |
| `sprint_format` | read of published configuration | sent as the restored player | sent as NOBODY (publishable key) |
| Realtime `game:<id>` | read | subscribed only after a bound snapshot | unchanged — the snapshot is now gated too |

Nothing populates player state before confirmation, so nothing can survive into
the adopted player's screens; adoption still resets every player store
(`resetPlayerState`).

### 25.5 B-H2 — root cause and the narrow notification contract

**Root cause.** `offer(moment, preferences)` was handed the screen's whole
Settings record, awaited the OS permission read BEFORE `busy` was set, computed
`preferencesAfterGrant` from that old record, registered it, and RETURNED it;
Social, Lobby and Tournament then `updateSettings(granted)` — all fourteen keys.
Any choice made during the await was restored: Friends ON again, and
`statsVisibility` back to public, which the root's privacy effect then wrote to
`profiles.privacy`. The privacy CAS was right to accept it: the stale snapshot
issued a genuinely new write.

**Repair — no Settings snapshot crosses an await.**

- **A notification patch, not a record** (`notifications.ts`): `grantPatch(moment)`
  names only the notification keys a grant switches on; `notificationPatchOf`
  strips anything else from whatever it is handed. `preferencesAfterGrant` is
  now `{...current, ...grantPatch(moment)}`.
- **Intent identity** (`use-settings.ts`): every explicit notification choice
  advances an in-memory counter synchronously as it is recorded (and a disk load
  or reset does too). `captureNotificationIntent()` returns "is nothing newer?".
- **`offer(moment)`** takes no preferences: it reads Settings itself, refuses to
  act before they are loaded, captures the intent before its first await, and is
  OBSOLETE the moment any notification choice is made after it began — it then
  registers nothing and records nothing. If still current when granted, it
  records its own patch into Settings AS THEY STAND, in the same synchronous step
  as its last check. Callers only call it.
- **`enable(moment, patch)`** registers the device's Settings as they stand at
  the write with the patch applied, inside the lane, and writes nothing once the
  intent is obsolete (`superseded`). Recording stays the caller's (the master
  switch records only `notificationsEnabled`, under `busy`). If a newer choice
  arrives while its write is in flight, it re-sends the newest Settings or, with
  notifications now off, retires the device — both carrying a newer revision.

So a delayed offer can change only notification keys, only while it is the
newest notification intent; it cannot touch privacy or any other Setting at all.

### 25.6 B-H4 — ownership, root cause and authoritative ordering

**Ownership domain, established first.** `push_tokens` is keyed by TOKEN: one
row per device, holding its owner, its kind allowlist and its active flag;
delivery reads the particular token's allowlist. Settings are device-local and
`20260817400000` says so ("the phone in a pocket and the tablet on a shelf
reasonably want different things"). The preference is therefore PER DEVICE, and
the ordering domain must be per token — a per-user revision would let one phone's
write defeat another phone's separate, legitimate choice.

**Root cause.** The device lane serialises writes on the device. A write the
server had accepted could still commit after a newer acknowledged one when its
connection failed; `register_push_token` was an unconditional last-arrival
upsert. No device-side ordering can order work that has already left the device.

**Repair — the order travels with the write.**

- **Server** (`20261004120000_push_registration_intent_order.sql`):
  `push_tokens.intent_revision bigint not null default 0`. Both RPCs take
  `p_revision` (required, ≥ 1) and return `{applied, revision}`.
  `register_push_token` applies only when `p_revision` is greater than the row's
  — one `insert … on conflict (token) do update … where intent_revision <
  excluded.intent_revision`, which locks the row and compares against its
  latest committed version — and evicts only when applied. `retire_push_token`
  is ordered by the same revision and stays confined to the caller's own row,
  reporting the revision only for that row. Equal = the same intent replayed
  (no-op); lower = obsolete (no-op). Old arities dropped; grants identical.
- **Device** (`push.ts`): each registration and retirement allocates its revision
  INSIDE the lane, in the order writes are made — `max(last + 1, Date.now())`,
  persisted before it is sent (`push:intent-revision:v1`, classified in the
  local-state inventory) — so the last write carries the newest Settings AND the
  highest revision. A row already holding a NEWER revision than this install
  ever allocated (reinstall, clock set back) is answered by moving the counter
  above it and re-sending once, as the newest intent; within one install nothing
  in the lane is older than the write being made, so this cannot resurrect an
  obsolete intent. A registration's retry is pinned to its player and re-checks
  adoption first.

**The invariant.** For each device token, the database holds the newest intent
that device has sent, regardless of transport failures, retries, replays or
arrival order; a departed player's stale registration cannot take a device
back from the next player; two devices of one account cannot affect each other.

### 25.7 Migration, grants, types and hosted forward-migration

**Migration required: yes, for B-H4 only** —
`supabase/migrations/20261004120000_push_registration_intent_order.sql`.
Started from the LAST definitions (`register_push_token` in `20260905120000`,
eviction included; `retire_push_token` in `20260817400000`), per CLAUDE.md. The
old arities are DROPPED rather than left beside the ordered ones. The migration
ends with `select public.assert_client_authorization_surface();`.

- **Applied locally without a reset** (`supabase migration up --local`; the
  database's users and wallets were preserved) — `$K/migration-up.log`.
- **Effective grants/ACLs/RLS, before vs after** (`$K/grants-before.txt`,
  `grants-after.txt`, `grants-diff.txt`): the two functions changed signature
  with an identical ACL (`postgres`, `authenticated`; `SECURITY DEFINER`); the
  new column appears under `authenticated`'s PRE-EXISTING table-level
  INSERT/SELECT privileges on `push_tokens` (no new grant statement, no UPDATE
  on it); RLS flags and every policy unchanged.
- **Client types** (`database.types.ts`, the hand-maintained authorised
  surface): both RPCs take `p_revision` and return `{applied, revision}`.
- **Schema consistency**: the CLI's shadow build applied all **61/61**
  migration files from scratch, the new one included, without error; the live
  catalogue holds exactly the objects the file defines (`$K/live-*.sql`). Both
  `supabase db diff` engines produced output contradicted by direct catalogue
  queries AND by the migration files (e.g. "drop policy
  `friend_requests_insert_as_sender`" — created in `20260813120300`, dropped in
  `20260915120000`, absent live), while reporting no difference for the new
  column; classified ENVIRONMENT/TOOLING, preserved, not relied on
  (`$K/migration-consistency.txt`).

**Hosted forward-migration requirements (not performed):** deploy
`20261004120000` together with, or before, the client that sends `p_revision`;
an older build's 4-argument/1-argument calls are refused with PGRST202, which
that build already reports as "Could not register this device" — acceptable
only because nothing is released. No backfill: every existing row starts at
revision 0 and any device write (≥ 1) applies. Confirm PostgREST's schema cache
reloaded, run `32_push_intent_order.test.sql` against staging, and keep the
existing activation items (§24.5), including re-validating GoTrue's
`user_not_found` / `session_not_found` answers, which the direct `/user` request
now reads.

### 25.8 Production files changed (31)

29 modified and 2 added; full audited → repaired hashes in
`$K/production-source-hashes.json`.

| Area | Files | Why |
|---|---|---|
| B-H3 | `src/features/auth/supabase-auth-adapter.ts` (`cc7da35c…` → `7382436f…`), `src/features/auth/auth-failure.ts` | direct, provenance-carrying `/user`; ended-at-launch never adopted; `ENDED_CREDENTIAL_RETAINED` copy |
| B-H1 boundary | `src/lib/supabase/adopted-player.ts` (new), `src/lib/supabase/player-binding.ts`, `src/lib/supabase/session-intent.ts`, `src/lib/supabase/client.ts`, `src/features/auth/auth-store.ts` | adoption published; `confirmedSession`, binding and intents require the adopted player; dispatch floor; managed clients |
| B-H1 call sites | `account-profile-store`, `career-server-store`, `cosmetics-store`, `loadout-store`, `daily-store`, `leaderboards-store`, `notifications-store`, `quick-play-store`, `tournament-store`, `competition-store`, `level-store`, `active-session-store`, `presence-store`; `app/profile/inventory.tsx` | identity from the boundary (13 one-call substitutions, plus the three paths that never asked); Inventory reloads on adoption |
| B-H2 | `src/features/notifications/notifications.ts`, `src/features/notifications/use-push-registration.ts`, `src/features/settings/use-settings.ts`; `app/(tabs)/social.tsx`, `app/table/lobby.tsx`, `app/tournament/index.tsx`, `app/settings/index.tsx` | patch + intent identity; callers no longer persist a snapshot |
| B-H4 | `src/lib/notifications/push.ts` (`d83b0b54…` → `924b3c61…`), `src/lib/supabase/database.types.ts`, `supabase/migrations/20261004120000_push_registration_intent_order.sql` (new) | device-allocated revision on every write; ordered RPCs |

No Edge Function, dependency, `app.json`, `package.json`, lockfile, Babel, Metro
or TypeScript configuration changed (byte-identical to the start), so
`check:functions` and a prebuild were not needed and not run.

### 25.9 Maintained regressions

**New files — 6 test files (290 tests) and 1 pgTAP file (30 assertions).**

| File | Tier | Tests | What it proves |
|---|---|---|---|
| `tests/auth/user-verification-provenance.test.ts` | production store (`hydrate()`), adapter, real supabase-js, PRODUCTION storage factory over an `expo-secure-store` double; GoTrue answered with the measured shapes and every request recorded WITH its answered status | 17 | **B-H3**: the audit's interleaving (keychain throws inside `getUser()`) → erased player never adopted, verdict = one answered `/user` 403 with the restored token; an SDK-made session-missing error with NO server answer → no verdict, nothing adopted or removed, then the server's answer applied; the token unreadable while the launch obtains it → no question, nobody adopted, credential intact, `PERSISTENCE_UNAVAILABLE`, then recovery reconciles to `ACCOUNT_DELETED` and Connect starts a player; the request is a real `GET /auth/v1/user` with exactly the restored token and the project key, `getUser()` not asked; an unrecognised transport asks nothing (fail closed); a 12-row table of server answers (200 same / other / unreadable, 403 `user_not_found` ×2, `session_not_found`, `bad_jwt`, 422, 500, 503, unreadable 403, transport failure) — only "200, same account" adopts and only then is anything sent as the player |
| `tests/auth/confirmation-gate.test.ts` | production store and adapter over real supabase-js; recording fake backend | 5 | **B-H1**: the audit's reproduction inverted (`/user` unreachable: Inventory and Daily never `ready`, no grant, no ranked game, nothing sent as the player; then confirmation and the same operations work); with verification IN FLIGHT, a sweep of every startup-reachable load AND first action (cosmetics load/equip, loadout, daily load/start, level, competition, account profile, notifications load/mark-all, leaderboard, tournament load/register, career refresh/start, active session, Quick Play open, wallet refresh/claim, friends refresh/search/send, matchmaking queue, room create, privacy sync, presence join/heartbeat) sends nothing as the player, then the same sweep reaches the server once confirmed; the production client's dispatch floor refuses an unadopted credential, passes the auth server, the adopted player, a departing player's bound retirement and a publishable-key request, and refuses a never-adopted or malformed bearer |
| `tests/contracts/confirmed-player-boundary.test.ts` | source scan of `src/` and `app/` | 245 | no file but the adapter and the boundary reads `auth.getSession`/`getUser`; every module that reaches the server imports the boundary; the production client is managed and gated; the Auth store publishes every change. Guards against an empty scan |
| `tests/notifications/notification-intent.test.ts` | production Settings (ordered saves) and push stores, `push.ts`, real supabase-js over a PostgREST double applying the SAME revision rule as the migration | 9 | **B-H2**: the audit's offer reproduction inverted (overtaken offer writes and records nothing; Friends and privacy stay); a current offer records only its keys into Settings as they stand; an offer whose write is in flight when notifications are turned off ends RETIRED; nothing before Settings load; `enable` registers only notification keys and does not record. **B-H4** device side: revisions strictly increase across registrations and retirements and are on disk BEFORE each request arrives; a restarted process continues above its persisted revision even with the clock set back; a row holding a newer revision (reinstall) → re-sent once above it and applied; an equal-revision answer (replay) is success and not re-sent |
| `tests/server/confirmation-gate.integration.test.ts` | **real GoTrue + Postgres + Edge Functions**; the audit's native double, production storage factory, store, adapter and stores | 5 | the audit's B-H1 reproduction inverted with Postgres as witness (`user_cosmetics`, `daily_entries`, seats, `rate_limit_events`, `last_seen_at` all unchanged; nothing sent as the player), then confirmation → cosmetics granted, Daily `ready`, a ranked game opened (DB rows); the audit's B-H3 interleaving inverted against real GoTrue (one `/user`, answered 403; never adopted; credential removed); keychain unreadable at launch → no question, then 403 applied; a REAL revoked session kept by the keychain → `/user` 403 `session_not_found`, not adopted, nothing sent as it; positive control |
| `tests/server/notification-intent-order.integration.test.ts` | **real PostgREST + Postgres**; ACTUAL `setKind`/`setMaster` (Settings) and `onAccept` (Social) compiled from the screens; a real HTTP proxy | 9 | CASE 1 (audit's B-H4 inverted: accepted ON outlives its connection, newer OFF wins in Postgres); CASE 2 (mirror); CASE 3 (audit's B-H2 inverted: Friends OFF and `profiles.privacy` private in memory, disk and Postgres; the obsolete offer wrote nothing); CASE 3b (current offer keeps a newer privacy choice); CASE 4 (rapid toggles); CASE 5 (old intent retried → refused, no change); CASE 6 (newest intent's reply lost → replay idempotent); a late registration cannot re-activate a retired device; positive control (each choice reaches Postgres with a newer revision) |
| `supabase/tests/32_push_intent_order.test.sql` | pgTAP | 30 | column shape; privileges (authenticated only; no unordered arity survives); the six orderings at the database boundary; ordered retirement; per-device ownership (a departed player's stale registration and retirement cannot take the next player's device, nor learn its revision); missing/zero revision refused; a second device is ordered on its own |

**Changed maintained tests — nothing weakened; each change is either the new
protocol or a deliberate strengthening.**

| File | Change | Why it is not a weakening |
|---|---|---|
| `tests/auth/credential-reconciliation.test.ts` | the case "an ENDED session the keychain keeps … shown, as mid-run (B-F2)" now asserts NOT adopted at a launch, `CREDENTIAL_NOT_REMOVED` with its copy, nothing sent as the player, and that Connect then removes it and starts a player | the behaviour §24 told the repair to stop; strictly stronger. Fails on the audited tree (25.10) |
| `tests/server/credential-departure.integration.test.ts` | B-F2's "keychain refuses every change" case: after the refused sign-out, the RELAUNCH no longer adopts A (its session was revoked by that sign-out's own `/logout`; `/user` answers `session_not_found`); asserts nobody shown, `CREDENTIAL_NOT_REMOVED`, credential still stored and served, and a protected request NOT sent (no row) | every other assertion of the case — refusal, A still shown mid-run, A's database actor mid-run, retry completes — is unchanged. B-F2's invariant (screen and outbound actor agree) now holds as "nobody shown and nothing sent". Fails on the audited tree only at that line (25.10) |
| `tests/auth/pseudonymous-adapter.test.ts` | the fixture gives its fake client a GoTrue transport answering `/user` | the restore now asks over HTTP; assertions unchanged; the audited adapter passes the changed file too (9/9) |
| `tests/features/local-state-authority.test.ts` | classifies the new key `push:intent-revision:v1` | the guard did its job; the entry says what the key can reach (nothing competitive) |
| `supabase/tests/18_notifications.test.sql`, `25_bounded_reads.test.sql`; `tests/server/notifications.integration.test.ts`, `bounded-reads.integration.test.ts`, `rls-idor.integration.test.ts` | pass the now-required `p_revision` (and `p_kinds` where a default was relied on) | the RPC signature changed; no assertion changed |
| `tests/e2e/refresh-b/fresh-player.yaml` | the onboarding tap inside the maintained `repeat`/`optional` pattern | 25.12; the assertions that prove the tap landed are unchanged |

**Two new native flows**: `tests/e2e/refresh-b/unverified-protected-work.yaml`
and `…-resume.yaml` (25.12).

### 25.10 Negative controls

The new and changed tests were copied into `$K/shadow/` (the audited tree). The
live tree was never disarmed. Where an import does not exist in the audited
tree, the shadow COPY was adapted and the diff kept
(`$K/negative-control-unit-adaptations.diff`,
`$K/negative-control-shadow-test-adaptation.diff`). The Group B real-backend
control ran **before the migration was applied** — audited client against the
audited database function. Every row is classified in
`$K/negative-controls.json`.

| File | On the audited code | Behavioural failures |
|---|---|---|
| `server/confirmation-gate` | **3 fail** / 2 pass | Inventory `ready` with nobody adopted; the erased UUID adopted (keychain throwing inside `getUser()`); a real revoked session adopted at a launch. Passing: unreadable-at-launch (already fail-closed by B-G3), positive control |
| `server/notification-intent-order` | **8 fail** / 1 pass | **6 behavioural**: database ON after the accepted ON outlived its connection (the audit's B-H4); the mirror; Friends ON in memory, disk and Postgres (the audit's B-H2); `statsVisibility` restored to public; a retried old intent re-applied; a stale registration re-activated a retired device. 2 protocol-only (replay answered 204; revision readback). Passing: rapid toggles (ordered on the device since B-G2) |
| `auth/user-verification-provenance` | **3 fail** / 14 pass | the audit's interleaving adopts the erased player; an SDK-made session-missing error with no server answer adopts; 1 protocol (`getUser()` asked). The 14 passing are the 12-row answer table — every REAL server answer is classified identically by both adapters — and two fail-closed cases |
| `auth/confirmation-gate` (copy without the dispatch-floor block) | **2 fail** / 0 pass | Inventory/Daily ready and account work sent as the restored player; the startup sweep sends account work as it |
| `contracts/confirmed-player-boundary` | **24 fail** / 220 pass | static: the direct session reads in the audited stores, `push.ts` and `session-intent.ts`; no floor in `client.ts`; no publishing in `auth-store.ts` |
| `notifications/notification-intent` | 8 fail / 1 pass | protocol only (the audited `offer(moment, preferences)` signature; revision-less writes against the revision-modelling double). The behavioural Group B evidence is the real-backend row above |
| the rewritten reconciliation case; the changed departure case | 1 fail each | the deliberate behaviour change, at exactly the changed assertion |

Logs: `$K/negative-server.log`, `negative-server-groupB.log`,
`negative-server-departure.log`, `negative-unit.log`; hashes in
`$K/negative-*-hashes.txt`.

### 25.11 Verification

| Gate | Result | Log |
|---|---|---|
| typecheck | pass (also re-run on the final tree) | `$K/typecheck.log` |
| lint | **0 errors / 21 warnings — finding-for-finding identical to the audit's** | `$K/lint.log`, `lint-final.log` |
| full unit suite (two workers) | **146 files / 2,907 pass** = the audited 2,628 + 276 in the four new files + 3 new per-file cases of `no-write-path` for `adopted-player.ts` | `$K/unit-full.log` |
| new H1–H4 unit regressions | **276 / 276** (17 + 5 + 245 + 9) | `$K/targeted-unit.log` |
| the audit's nine-file targeted set | **115 / 115** (39 + 7 + 24 + 9 + 10 + 11 + 3 + 5 + 7) | same |
| auth / notification / settings directories | all pass in the full run; `tests/auth`, `tests/notifications`, `tests/settings` also run alone | `$K/targeted-unit.log` and the full run |
| **ONE full `npm run test:server`** | **37 files: 33 pass, 4 fail; 392 tests: 380 pass, 3 fail, 9 skipped**, 221.44 s (= the audited 378 + 14 new) | `$K/server-full.log` |
| — of which caused by this repair | **11 tests in 3 files**: fixtures still calling the REPLACED `register_push_token` shape (PGRST202) — `notifications` (1), `bounded-reads` (1), `rls-idor` (its `beforeAll` threw, 9 skipped). Fixtures given `p_revision`; those files plus `hostile-payloads` re-run once: **4 files / 74 pass** | `$K/server-affected-rerun.log` |
| — ENVIRONMENT | **1**: `hostile-payloads` "2 of 40 … got no reply": at 15:51:47.577Z the runtime logged `CPU time soft limit reached` for one isolate, then exactly two `user worker failed to respond: … worker has already retired`. Those requests never reached the handler; no Edge Function code changed. Passed in the supplementary re-run with no further retirement | `$K/functions-serve.log` |
| new server regressions | **14 / 14** inside the full run (5 + 9) | — |
| B-R1–B-R6 | **40 / 40**: unit 24 + server 16 (replacement 6, stale player state 7, stale push 3) | — |
| stale-social / table | **17 / 17**: unit 12 + server 5 | — |
| B-F1–B-F3 | **42 / 42**: unit 33 + server 9 (departure 5 incl. the changed case, privacy 4) | — |
| B-G1–B-G3 | **59 / 59**: unit 46 + server 13 | — |
| **pgTAP** | **32 files / 640 assertions, PASS** (the new file adds 30) | `$K/pgtap.log` |
| migration / grants / schema | 25.7 | `$K/migration-*`, `grants-*` |

`supabase functions serve` was restarted before the full run (it had served
since October 3 18:16); the function answered 401, no simulator was booted,
load 2.9, and the anonymous sign-in budget was unused for the hour. Per-file
server counts come from `vitest list` (no extra execution, no sign-ins spent):
`$K/server-test-list.txt`.

### 25.12 Native Release evidence

**What was stale, measured.** §23's own fingerprint script against its record
found exactly the 29 changed + 1 added shipped sources of 25.8 and nothing else,
of 247 (`$K/prebuild-freshness.txt`). Every native row on `ec64835d…` was
therefore stale.

**The build.** Native configuration unchanged, so no prebuild:
`expo run:ios --configuration Release --device <A> --no-bundler` — **Build
Succeeded, 0 errors** (the 3 warnings are third-party: a Pods run-script notice
and `ExpoHeadModule.swift`; Hermes notes on vendor globals) —
`$K/release-build.log`.

| Claim | Evidence |
|---|---|
| The binary is this tree | bundle SHA-256 **`4ae8fdeef1cbee98cddd8ba7cf64f42ae5b2da8e505d8247d4dda04243f590a0`**, 6,438,104 bytes, built 2026-10-04T16:01:12Z, **247 sources, 0 newer** (`$K/build.json`, `build-fingerprint.txt`) |
| Device A runs exactly it; nothing else could serve a bundle | the installed `main.jsbundle` hashes the same; no listener on 8081 before, during or after |
| Positive control only | `push:intent-revision:v1`, `p_revision`, `UnadoptedCredentialError`, the ended-credential copy, `X-Supabase-Api-Version` present (`$K/bundle-positive-controls.txt`) |
| No source moved | after the pause and again after the flows: same bundle, **0 changed / 0 added / 0 removed / 0 newer** (`$K/build-freshness-after-flows.txt`) |

**Flows.** Device A, iPhone 17 Pro `D16C4292…`, one driver, load under 12 before
each run. Rows pair Maestro's step counts with server readbacks; gateway lines
are filtered to the device's user agent (`$K/gateway.sh`). Journal:
`$K/native-journal.txt`.

| # | Flow | Result (C / F / S) | Server-side readback |
|---|---|---|---|
| 00 | `e2e-fresh-app.ts` | reset | users 7,458 |
| 01, 01b | `fresh-player` | **HARNESS ×2**: "iOS driver not ready in time" before any step (0 completed, no device traffic); the runner sat suspended `wait_for_debugger` at `AcquiredPID`. Stale driver processes killed, then simulator A re-booted (app and bundle unchanged) | — |
| 01c, 01d | `fresh-player` | **HARNESS ×2 (lost tap)**: onboarding still on screen 30 s after the tap; the device's own SQLite store had NO `onboarding:completion`, so `complete("guest")` never ran; the app's launch bootstrap had meanwhile created and adopted a player and read its wallet AS it. Timeline: start-up effects began ~5 s after launch, the tap came at +6.4 s, beside the driver's `kAXError -25218` | each launch created a player (`dea3a542…`, `fe05108c…`) |
| X01 | experiment, no relaunch | **pass**: on the settled screen the same tap reached Home in 3 s and wrote `onboarding:completion` — the app responds; the flow then took the maintained `repeat`/`optional` tap | — |
| 01e | `fresh-player` | **pass** (17 / 0 / 3) | `POST /signup 200`, no `/user`; **`shiny_mink_583174`** `c9ff5db5…` anonymous, 25,000 = ledger, 1 grant, 1 session |
| 02 | `cold-player` | **pass** (9 / 0 / 1) | the device's **first** line is `GET /auth/v1/user 200`, every `/rest` line after it (in §23's row 02 profile reads completed BEFORE `/user` — its residual 6) |
| 03 | NEW `unverified-protected-work` — **only GoTrue stopped**: `/auth/v1/user` → 502, PostgREST 200 (the audit's B-H1 condition) | **pass** (16 / 0 / 2) | across Home, Inventory and Daily the device's **only** request: `GET /auth/v1/user 502`; Inventory "Connect to see cosmetics…", Daily "Connect for the Daily Challenge…" with Try again, no start; P1's cosmetics **0 → 0**, daily entries 0, seats 0, `last_seen_at` and rate-limit events unchanged |
| 04 | NEW `…-resume` (GoTrue restarted) | **HARNESS** (10 / 1 / 3): after `/user 200` the device sent `grant_earned_cosmetics`, `my_inventory`, `ensure_todays_daily_challenge`, `my_daily_entry`, `latest_verifiable_daily_challenge` (all 200; cosmetics 0 → 4); the screenshot shows the READY Daily screen with the start control below the fold — a wait does not scroll. Corrected to scroll; the PAIR re-run | cosmetics 4 |
| 03b / 04b | the pair again | **pass** (16 / 0 / 2), **pass** (16 / 0 / 4) | 03b: only `GET /auth/v1/user 502`; 04b: `/user 200` first, then Inventory and Daily load, the start control is present, the profile shows `@shiny_mink_583174`; no daily entry created |
| 05 / 06 | `offline-existing-launch` (Kong stopped) / `…-reconnect` | **pass**, **pass** | offline: P1 not shown, its session and live token intact; reconnect: `/user 200` before any `/rest` |
| 07 | `sign-out` | **pass** (19 / 0 / 2) | `/logout?scope=local 204`; P1 **0 sessions, 0 live tokens**; the relaunch created **`brave_goose_115482`** `beddb1c9…` |
| 08 | `sign-in-existing` (X1) | **pass** | launch verified (`/user 200`); `token?grant_type=password 200` |
| 09 | `social-send` (X1 → P1) | **pass** | `friend_requests`: sender **X1 `polar_yak_799038` — the player shown** → P1, pending |
| 10 | `delete-player` (X1) | **pass** | `rpc/delete_own_account 204` (through the dispatch floor, as the adopted player), `/logout 403`; X1's users, identities, sessions, profile, wallet, ledger and friend requests all **0** |
| 11 | `account-delete-cold-launch` | **pass** | nothing restored → **`brisk_camel_056836`** `86c04ff9…`, 1 grant; X1's password **400** |
| 12 | `sign-in-existing` (X2 `brisk_dove`) | **pass** | — |
| 13 | X2 erased from a second session (`delete_own_account` **204**), app stopped; `erased-account-launch` | **pass** (18 / 0 / 2) | the device's **`GET /auth/v1/user 403`** (the direct request) then `/logout 403`; nothing sent as X2; `/signup` only after Connect, a minute later → **`smart_yak_432920`** |
| 14 | `request-recovery` (X3) | **pass** | the device's `/recover`; the real Mailpit link answered **303 → `arc21://auth/recovery`** with a PKCE code, opened on the device (`$K/state-14-recovery-link.txt`; the code is never exported) |
| 15 | `recovery-complete` (X3) | **pass** | `token?grant_type=pkce 200`, `PUT /user 200`; asked of GoTrue directly, **old password 400, new 200** |

**Classified, not hidden.** Rows 08, 11 and 12 each logged a device
`POST /auth/v1/recover` INSIDE Maestro's `Hide Keyboard` step and before the
submit tap (timestamps in the journal): the documented dismiss-gesture landing
on "Email me a reset link" — HARNESS, as in §21.11 and §23. Rows 01–01d and 04
are HARNESS failures whose artefacts show why; each was corrected (driver
processes, simulator re-boot, the maintained tap pattern, a scroll) and its
scenario re-run in full.

**Group B natively:** unreachable — with no EAS project id `registerDevice`
returns before any network call, and the offer path would raise a real OS
permission prompt. Proven at the wire, against the real PostgREST/Postgres, and
in pgTAP; **not natively claimed**.

**Hygiene finding, fixed.** The disposable passwords lived in a scratch file
outside the repository, deleted after the pass — but Maestro's own per-run
artefacts (`commands.json`, `logs/maestro.log`) record `inputText`, and a scan
of every evidence file found them in rows 08, 11, 12 and 15. They were redacted
in place, in `$K` and in Maestro's `~/.maestro/tests` debug output, and a
re-scan found **0**. X1 and X2 were erased; X3's old password is refused.

Players created by the flows: `shiny_mink_583174`, `brave_goose_115482`,
`brisk_camel_056836`, `smart_yak_432920`, plus `dea3a542…` and `fe05108c…` from
the two lost-tap launches — each 25,000 = ledger with one grant, left as earlier
passes left theirs. X1 and X2 were erased by the product; X3
(`native-x3-…@arc21.test`, secured) remains. Simulator A was shut down
afterwards; simulator B was not used.

### 25.13 Wallet / ledger / opening grant

One final read-only aggregate over **every** wallet (`$K/integrity.sql`):

| Stage | users | wallets | wallet ≠ ledger | negative | `initial_grant` count ≠ 1 |
|---|---|---|---|---|---|
| final (`$K/integrity-final.txt`) | **7,465** | **7,465** | **0** | **0** | **0** |

7,458 → 7,465 across the native pass is exactly the six product-created
anonymous players plus X3 (X1 and X2 created and erased). The increase from the
audit's 6,933 before that is the maintained server suites' persistent fixtures
(the audit's own run grew the count by a similar amount); no user was created to
raise the count. No economic code changed.

### 25.14 Residuals and external limitations

**No known unrepaired instance of B-H1, B-H2, B-H3 or B-H4.** No wider audit
was attempted beyond the bounded review in 25.4.

1. **Cold launch over a revoked session the keychain keeps** is now refused
   (`CREDENTIAL_NOT_REMOVED`) instead of adopted; a secured player whose
   sign-out the keychain refused is therefore not re-shown after a relaunch, and
   Connect removes the credential and starts a new player. Mid-run (B-F2)
   behaviour is unchanged.
2. **Managed clients only.** The adoption rule binds the production client and
   any client the auth adapter drives; a hand-built harness client without the
   adapter is unmanaged. No such client exists in the app.
3. **`sprint_format` is not executable by `anon`** (pre-existing least
   privilege). Sent as nobody, it is refused for a signed-out device and during
   verification, so Tournament shows its "could not reach" copy in those states.
4. **Revision recovery has one contrived gap**: after a reinstall AND a clock set
   back below the row's revision, a write still in flight from before the
   reinstall that carries a higher revision could land after the newest one.
   Within one install the order is exact.
5. **Direct client table grants on `push_tokens`** (INSERT, UPDATE of
   `is_active`/`device_id`/`last_used_at`, DELETE) pre-exist and bypass the
   ordering; only a modified client would use them, on its own rows only; grants
   were deliberately left as they were. A forged high `intent_revision` on its
   own row is self-healing (the next write moves above it).
6. **`deactivate_push_token`** (the sender retiring a dead token) does not bump
   the revision: it records a server-side fact, not a device intent.
7. **Notification ordering is per device token** by design (25.6); there is no
   account-wide preference, so one device's choice never overrides another's.
8. **Native Group B coverage** requires an EAS project and physical/APNs/FCM
   tokens — external. Native keychain faults cannot be staged on a simulator;
   B-H3 is proven at the SDK and real-backend tiers.
9. `supabase db diff` is unreliable in this environment (25.7).
10. Everything §24.5 classifies as external — hosted activation (now including
    deploying `20261004120000`), hosted GoTrue's `/user` semantics, Android,
    physical keychain faults, EAS/APNs/FCM, hardware CAPTCHA, the unconfigured
    build, mid-hand native cash-out, lint warnings — is unchanged.

### 25.15 What Astra must verify next

1. **Provenance (B-H3).** That no path builds an existence verdict without an
   HTTP response the adapter received; inject faults into the token read, the
   transport, the SDK helper and the transport accessor; confirm the 12-row
   answer equivalence with the audited adapter; re-run the audit's H3 probe.
2. **The gate (B-H1).** Try every store, the presence heartbeat, realtime and
   anything else to send account-owned work as an unadopted credential —
   restored-unverified, verification in flight, offline, erased, mid sign-in —
   on both a harness client (identity layer) and the production client
   (dispatch floor); confirm a departing player's bound retirement still
   finishes (B-R5) and that legitimate work resumes after confirmation;
   re-run the audit's H1 probe.
3. **The cold-launch ended-session change** and the one changed B-F2 assertion
   (25.9), against §24's recommendation.
4. **B-H2.** Offer obsolescence (any notification choice after it began), the
   current offer recording only its keys, an enable overtaken in flight
   (re-synced or retired), nothing before Settings load; re-run the audit's
   offer probe adapted to `offer(moment)`.
5. **B-H4.** The ordering at the database boundary (pgTAP 32) and through the
   app with a real lost connection: the six cases, retirement ordering,
   per-device independence, reinstall/clock rebase; re-run the audit's
   transport probe (its late request now answers 200 `{applied:false}`).
6. **The migration**: dropped arities, identical ACLs, the hosted deployment
   order.
7. **The negative controls** — rebuild the shadow rather than trusting the logs.
8. **The server run's classifications** (25.11) from its runtime log.
9. **The native scope and freshness** (25.12): rebuild and compare against
   `4ae8fdee…`; the HARNESS rows and their corrections.

### 25.16 Exact state

- Branch `astra-refresh-b`, HEAD **`47dba201ace488d932bb4e479416f52f79a6f176`**,
  everything uncommitted; the index is empty. Nothing committed, pushed,
  merged, deployed, reset, stashed, cleaned or rewritten; no hosted change; no
  Refresh C/D/E work.
- `AGENTS.claude-backup.md` remains intentionally untracked and untouched.
- Production files changed by this pass: the **31** in 25.8. New maintained
  tests: **6 files + 1 pgTAP file**; changed tests as listed in 25.9; two new
  native flows and one hardened flow in the untracked `tests/e2e/refresh-b/`.
  No assertion, timeout, retry policy, rate limit or worker count weakened.
- Local database migrated to `20261004120000` (no reset). Release binary
  `…/Release-iphonesimulator/Arc21.app`, bundle `4ae8fdee…`, installed on
  device A; simulator A shut down.
- `supabase functions serve --no-verify-jwt` is RUNNING since October 4 08:48
  (local), logging to `$K/functions-serve.log`. GoTrue and Kong were each
  stopped for the native unavailability proofs and restarted immediately
  (health 200, function 401).
- Documentation: this section and one status line at the top; §§1–24 are
  unchanged.
- **Refresh B is NOT claimed to pass.** §24 remains the standing verdict; this
  section is an unreviewed repair and its evidence. A fresh independent
  re-audit is required.

## 26. Closure verification audit — October 4, 2026

**ASTRA REFRESH B: PASS**

**KNOWN CURRENT REFRESH-B RELEASE-BLOCKING SOFTWARE DEFECTS: 0**

This verdict supersedes §24 for the exact final H1–H4 repair recorded in §25.
It is a bounded closure verification, not a claim that the application has no
possible bugs. One GPT-6 Astra primary at xhigh; no subagents, Goal mode, or
older-thread resumption. Refresh C/D/E has not begun. No production code or
maintained test was changed by this audit.

Branch: `astra-refresh-b`. Baseline and pre-checkpoint HEAD:
`47dba201ace488d932bb4e479416f52f79a6f176`.
Independent evidence: `/Users/tj/arc21-evidence/astra-refresh-b-closure-20261004/`
(**`$V`** below). The repair evidence is §25's **`$K`**; §24's evidence remains
historical and intact.

### 26.1 H1–H4 adjudication

| Finding | Closure conclusion |
|---|---|
| **B-H1 — FIXED** | The production Auth store synchronously publishes adoption. `confirmedSession`, `bindCurrentPlayer`, and `sendSessionIntent` require that adopted player. The production client is identity-managed from construction and rejects non-auth requests with a never-adopted bearer. Inventory and Daily cannot become ready or mutate before confirmation. The real-backend reproduction proves unchanged cosmetics, Daily entries, seats, rate-limit events and last-seen state, then proves cosmetics grants and ranked Daily creation work after confirmation. |
| **B-H2 — FIXED** | The actual Social/Lobby/Tournament callers no longer persist a returned whole Settings object. Offers capture notification intent before their earliest await, cancel when overtaken, and merge only their owned notification keys into current Settings. The actual Settings/Social handlers reproduce the old delayed offer with a newer Friends OFF and privacy private: memory, persisted Settings, and Postgres stay at those newer choices. A still-current offer also preserves independently changed privacy. |
| **B-H3 — FIXED** | Restoration asks `GET /auth/v1/user` directly with the exact restored token. A verdict derives from the received response, never an SDK exception name. Valid same-user replies permit adoption; erased and ended credentials are not adopted. An unreadable keychain sends no question and preserves credentials; network failure, timeout, 5xx and unusable responses adopt nobody and provide no deletion verdict. The real SDK/keychain-fault regression and real GoTrue 403 controls pass. Ordinary sign-in and password recovery adopt the server-issued session normally. |
| **B-H4 — FIXED** | Both push RPCs apply only a greater per-token revision. The real HTTP proxy accepts an old ON, loses its connection, lets a newer OFF commit, then delivers the old ON: final **Postgres remains OFF**. The mirror ends **ON**. Equal-revision replay, stale retry, and late registration after retirement leave the newest row intact. These are database assertions, not local-state substitutes. |

The confirmation gate is sound for this defect class. Account-owned startup
loaders use the shared boundary; public-format requests without adoption use the
publishable key. `sprint_format` remains refused to `anon`, with unavailable copy,
rather than borrowing an unconfirmed bearer. Offline Practice is unchanged.
The dispatch floor deliberately allows an already-bound departing player's
retirement; current-player binding and player-scope guards still govern ordinary
work. The maintained contract scan meaningfully forbids direct SDK session/user
reads outside the two boundary modules, checks server modules' participation,
and checks construction/publication. Its import checks are structural, not a
formal proof of every possible future call; behavioral and native evidence test
the critical production behavior that the scan alone cannot establish.

B-R6's failed durable replacement remains fail-closed. B-F2's retained live
credential remains truthfully reported. Its changed cold-launch assertion is a
strengthening: the server-revoked credential retained by the keychain is served
but never adopted or used for protected work. B-G1 erased-account handling and
B-G3 broken/unreadable credential recovery remain green. Normal account-owned
server authority requires the server-confirmed current player.

### 26.2 Notification revisions and narrow database delta

Revisions are allocated in the device mutation lane using
`max(last + 1, Date.now(), floor + 1)` and persisted before requests are sent.
Register and retire share that counter and the row's ordering domain. The
maintained restart test preserves the counter even with a backward clock;
stale smaller revisions cannot change a newer row; an equal revision is a
no-op; a newer server floor is rebased and retried. Independent devices have
separate token rows, matching device-local notification preferences.

`20261004120000_push_registration_intent_order.sql` is migration 61. Its live
function bodies match the repository file. Only the five-argument register and
two-argument retire functions exist; both return the typed `{applied, revision}`
shape. Effective ACLs are `postgres` and `authenticated` only: **anon false,
service_role false** for EXECUTE. Fixed search paths and Auth-derived ownership
remain. Retirement cannot change another owner's row or disclose its revision;
malformed/missing revisions are refused. Registration retains the existing
same-device token reassignment semantics rather than accepting a payload owner.
The before/after grants, RLS flags and policies match exactly except the intended
function signatures and new column's inherited INSERT/SELECT privileges.
`assert_client_authorization_surface()` passes independently.

The recorded clean shadow applied all **61 migrations in the exact current
order**, including this migration, without error; forward application succeeded.
Those logs were checked against the current filenames, live catalogue and
migration body. No database reset or historical migration re-audit was needed.
The unreliable schema-diff output is not used as authorization evidence.

The reinstall-plus-clock-rollback residual requires loss of the persisted
revision domain together with a backward clock and an outstanding old request
above the visible database floor. It is not demonstrated by normal supported
process restart, and does not block this software closure. Clock fallback after
local revision-store failure is not a universal durable-ordering guarantee.
Existing direct push-token table grants are unchanged and confined by existing
RLS; modified own-row writes are outside the shipped ordered RPC path. No new
broader privilege was added. Server retirement of an invalid delivery token
remains a server fact rather than a device preference intent.

### 26.3 Current verification and regression quality

| Current closure run | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | **0 errors / 21 warnings** |
| `npm run test:unit -- --maxWorkers=2` | **146 files / 2,907 PASS** |
| **ONE `npm run test:server`** | **37 files / 392 PASS / 0 failed / 0 skipped**, 314.96 seconds |
| `supabase test db` | **32 files / 640 assertions PASS**, including all 30 new ordering assertions |
| H1–H4 maintained grouping | **290/290** (276 unit/contract + 14 real-backend) |
| B-R1–B-R6 | **40/40** |
| Stale social/table | **17/17** |
| B-F1–B-F3 | **42/42** |
| B-G1–B-G3 | **59/59** |

Logs are `$V/typecheck.log`, `lint.log`, `unit-full.log`, `server-full.log`,
`functions-serve.log`, and `pgtap.log`; grouping counts are recorded in
`regression-counts.json`. The full suites include every maintained family.
The server run began after the local Edge service's initial 503 was resolved by
starting `supabase functions serve --no-verify-jwt` and confirming a 401 response.
Auth health was 200. Runtime CPU-limit retirements occurred; one HTTP 504 was
logged and handled by the already-existing identical-body retry. **No assertion
failed and no supplementary server run was used to manufacture green.**

The H1/H3 tests run production hydration, storage factory, adapter and loaders
with the actual SDK and real GoTrue/Postgres/Edge Functions. The H2/H4 tests
compile the actual screen handlers, run production Settings/notification logic,
and forward real request bodies and authorization through a local HTTP proxy
to real PostgREST. Native permission/token doubles do not replace the critical
confirmation, mutation or database ordering boundary.

Negative-control source adaptations and failure logs were inspected. All 75
comparable production files in the vulnerable shadow match §24's independent
source fingerprints. The controls exhibit behavioral H1/H3 failures and six
behavioral H2/H4 failures against the old RPC, separately from protocol-only
failures. They were not rerun against an intentionally downgraded live database.

### 26.4 Release/native evidence

Full SHA-256, independently recomputed for both built and installed bundles:

`4ae8fdeef1cbee98cddd8ba7cf64f42ae5b2da8e505d8247d4dda04243f590a0`

The Release bundle is 6,438,104 bytes, built October 4 at 16:01:12 UTC. All
**247** recorded app/src/shared source hashes match, with **0 changed, added or
removed** sources. Current production hashes also match the repair's 31-file
change record. `$V/build-native-review.json` preserves this comparison.

The native command records, result XML, screenshots, gateway requests and
server readbacks substantiate cold restore, erased-account refusal, offline and
reconnect behavior, sign-in, deletion and password recovery. In the auth-only
outage, the device's **only request was `GET /auth/v1/user 502`**; Inventory and
Daily remained unavailable and their database counts did not change. After Auth
returned, `/user 200` preceded account work; Inventory and Daily became usable.
Recovery used PKCE and the real password update, with old/new password readbacks.

**Count correction:** this repair directory contains **16 successful maintained
native runs**, **5 failed harness attempts** (two driver failures before any
step, two lost onboarding taps, one missing scroll), and **one successful
diagnostic tap**. The brief's 21-success/9-failure count is not the count of this
repair corpus. The failed resume screenshot shows the ready Daily content above
the fold; the corrected paired run scrolls to its start control and passes.
The other failed attempts have successful complete replacements. Three recorded
Hide Keyboard gestures caused unintended recovery requests during successful
flows; their timestamps support the harness classification. These are preserved
limitations, not hidden product passes.

An additional closure native replay was attempted, but CoreSimulator reported
**Data Migration Failed during boot**, before the app or flow ran. The simulator
was shut down without changing its install or credentials. No new native pass
is claimed from that attempt. The unchanged-binary evidence above and current
real-backend reproductions are sufficient for this bounded closure.

Physical Expo/EAS/APNs/FCM delivery is **not tested**. H2/H4 software ordering is
supported by production logic, deterministic native-token boundaries, real Auth,
PostgREST/Postgres and pgTAP. Android, physical keychain faults, hosted GoTrue
behavior and hosted activation (including deploying the new migration with the
compatible client) remain external/unproven release work. They are not a claim
of production deployment or physical push validation.

### 26.5 Integrity, patch hygiene and checkpoint

One independent read-only aggregate after the required suites:
**7,961 users / 7,961 wallets / 0 wallet-ledger mismatches / 0 negative balances /
0 opening-grant-count violations** (`$V/integrity-final.txt`). The increase from
§25's 7,465 is the maintained server suites' fixtures; no users were created for
this aggregate or for additional native testing. No economic implementation
changed.

The full baseline patch inventory, tracked diff, repair delta, intended untracked
files and staged checkpoint are reviewed. The starting tracked diff was
byte-identical to §25's final patch. Earlier accepted production areas remain
byte-identical except the documented H1–H4 dependency changes. New files are the
identity/confirmation modules, local-stack helper, migrations, email template,
maintained regressions/native flows and this report. No scratch/evidence directory,
local credential, generated native project or real secret belongs in the patch.
The candidate secret scan's three apparent hits are deliberate invalid fixtures
or historical text quoting them; local Supabase demo keys are public fixtures.
`git diff --check` passes.

The only audit-authored repository changes are this closure record and the
current release/database documentation pointers. `AGENTS.claude-backup.md` is
preserved unchanged, untracked and unstaged. The authorized local checkpoint
subject is **`Complete Astra Refresh B pseudonymous user system`**; its SHA is
reported with the final disposition rather than embedded in its own content.
No push, deployment, reset, stash, clean, history rewrite or hosted change was
performed. Local function service remains available; no simulator remains booted.
Refresh C/D/E has not begun.

## Sources consulted

- [Supabase anonymous users](https://supabase.com/docs/guides/auth/auth-anonymous)
- [Supabase identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking)
- [Supabase Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits)
- [Auth v2.195 user updates](https://github.com/supabase/auth/blob/v2.195.0/internal/api/user.go)
- [Auth v2.195 verification](https://github.com/supabase/auth/blob/v2.195.0/internal/api/verify.go)
- [PostgREST clock defect](https://github.com/PostgREST/postgrest/issues/5196)
- [PostgREST releases](https://github.com/PostgREST/postgrest/blob/main/CHANGELOG.md)
- [Expo network events](https://docs.expo.dev/versions/latest/sdk/network/)
- [hCaptcha test keys](https://docs.hcaptcha.com/#integration-testing-test-keys)
