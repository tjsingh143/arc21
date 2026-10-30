# Release readiness

What stands between this repository and a build in a store, what each item is
blocked on, and every defect deliberately carried forward rather than fixed.

**Latest integrated feature: Refresh C — AI Tables (October 19, 2026).**
Its final independent review reported **Refresh C: PASS**; prior failed
findings and subsequent repairs are recorded in [Refresh C §§13–14](./astra-refresh/refresh-c.md).
The reported final review totals were 439 server tests, 3,056 unit tests,
672 database assertions, 18 private-admission regressions and 63 migrations.

Refresh C was merged into `main` through
[PR #5](https://github.com/tjsingh143/arc21/pull/5) at
[`9eba544ca2d7fb115dc75dcdd0ec078cea479564`](https://github.com/tjsingh143/arc21/commit/9eba544ca2d7fb115dc75dcdd0ec078cea479564).
The integrated feature-branch revision passed [both hosted CI jobs](https://github.com/tjsingh143/arc21/actions/runs/39218823512):
lint, typechecks, 3,056 unit tests, 3,030 coverage tests with gates passed,
Expo Doctor 21/21, the iOS Hermes bundle, 63 migrations, 672 database
assertions and 439 server tests. The [post-merge `main` CI](https://github.com/tjsingh143/arc21/actions/runs/39305983730)
has a separate run record.

**Previous milestone: Refresh B (October 4, 2026): PASS.** Its closure review
found zero known release-blocking software defects within the Refresh-B scope.
The historical evidence and external limitations are in
[Refresh B §26](./astra-refresh/refresh-b.md#26-closure-verification-audit--october-4-2026);
both hosted CI jobs passed at `059ee0ba9b848254fecd024daae7e2a60be374aa`
([run](https://github.com/tjsingh143/arc21/actions/runs/37243705811)).

**Release boundary:** A source merge and green CI are not store approval or
a production deployment. Hosted migration/application activation and remaining
platform/device checks have not been established. Refresh D (Home and Play
hierarchy) is a client-only local implementation awaiting independent review
([record](./astra-refresh/refresh-d.md)); it adds no migration or function.
Refresh E has not begun.

For release, Refresh C adds two forward migrations,
`20261005120000_ai_tables.sql` and `20261017120000_ai_table_open_requests.sql`,
which must reach the database with or before the Edge Functions and client that
use them — the functions write `game_session_seats.is_ai`, the `ai_table` mode
and `private.ai_table_open_requests`. Each migration is one transaction by
design (see [Refresh C §8](./astra-refresh/refresh-c.md)).

**Historical Refresh A verification:** 2026-09-14 PDT.

**ASTRA BASELINE AUDIT: PASS**

**KNOWN CURRENT RELEASE-BLOCKING SOFTWARE DEFECTS: 0**

The independent [baseline audit](./astra-refresh/baseline-audit.md) records checkpoint-specific
software evidence: all 22 product findings verified, 2,446 unit tests, 2,420
coverage tests with per-area thresholds, 320 real server tests, 592 SQL
assertions, a clean reset of all 59 migrations and the final iOS Release
installed on both simulators. Final postflight confirms wallet/ledger equality,
restored permissions and running application services. These counts and verdicts
belong to Refresh A only. Refresh B and C are integrated into GitHub `main`; no store submission or cloud deployment is established.

The [dependency disposition](./astra-refresh/dependency-disposition.md) retains
four advisories across 18 package entries and explains their actual runtime/build
exposure; this is not a clean npm audit. No reachable release-blocking exploit
was established in the audited paths.

The activation requirements and verification gaps below remain open. Phase-12
measurements, pricing and store-policy statements below are historical, not
newly verified activation evidence. Refresh A does not claim an Android build,
physical-device pass, live push delivery or cloud deployment.

Three documents end at this one — [STORE_LISTING.md](./STORE_LISTING.md),
[PRIVACY.md](./PRIVACY.md) and [TERMS.md](./TERMS.md) — because each of them
runs into the same boundary: a credential this project does not hold. This page
is where that boundary is written down once, instead of three times in three
different wordings.

---

## The short answer

The app builds, installs and runs. `app.json` declares version **1.0.0**,
`ios.buildNumber` **1** and `android.versionCode` **1**; `expo-doctor` reports
21/21; a **Release** build (no Metro, 6.2 MB embedded `main.jsbundle`, icon in
`Assets.car`) was produced from a `--clean` prebuild in phase 12 and walked by
26 Maestro runs on two simulators. `eas.json` carries development, preview and
production profiles.

Android targets **API 36** (`react-native`'s version catalogue: `minSdk 24`,
`compileSdk 36`, `targetSdk 36`), which is what Google Play has required of new
apps and updates since 31 August 2026. The Android project has never been
BUILT: this machine has no Android SDK, no `adb` and no emulator, so that is on
the external list below rather than claimed here.

**Nothing has been submitted anywhere, and nothing has been deployed anywhere.**
No App Store Connect account, no Play Console account, no Expo account, no
Supabase cloud project, no domain. Every server result quoted in
[AUDIT.md](./AUDIT.md) was measured against a **local** stack.

---

## Blocked on a credential

Each row is blocked on something that must be bought, registered or signed for.
None is blocked on a decision, and none is blocked on code that has not been
written.

| Needed | Costs | What it unblocks | What already exists |
|--------|-------|------------------|---------------------|
| **Apple Developer Program** | $99/yr | App Store Connect record, TestFlight, an APNs key, and installing on a physical device | Bundle id `com.arc21.app`, build number, `usesNonExemptEncryption` verified in the generated `Info.plist`; listing copy and age-rating rationale in STORE_LISTING.md |
| **Google Play Console** | $25 once | Play submission and the Data safety declaration | `com.arc21.app`, `versionCode`, an app-bundle build profile, and the Play half of the listing copy |
| **Expo account + EAS project id** | free tier | `eas build`, `eas submit`, and `getExpoPushTokenAsync` — **no device can be issued a push token without it**, which is why push is graded ABSENT in AUDIT.md | `eas.json`, schema-validated. `eas config` has never run: it needs the account |
| **A domain and hosting** | varies | The privacy-policy URL Apple requires, the support URL both stores require, and the **account-deletion request page Google Play requires in addition to the in-app path** | The text those pages must serve, in PRIVACY.md and TERMS.md, and the deletion route itself (`delete_own_account()`, Settings → Delete account). Publish them at stable URLs and record the URLs in STORE_LISTING.md's "Support and marketing URLs" section |
| **A Supabase cloud project** | free tier | Deploying the 61 migrations, the three Edge Functions, and the function secrets; and filling the public build configuration | Local migration/function evidence and Refresh-B activation settings are recorded in [Refresh B](./astra-refresh/refresh-b.md); `.env.example` names the environment variables |
| **APNs key / FCM credentials** | with the accounts above | A real push. The sender records `mocked` rather than `sent` when no credentials exist, so this fails honestly rather than silently | `send-notifications`, the token schema, the four `PermissionMoment`s, and the no-op adapter |
| **A physical iOS device** | — | Removing the largest verification gap below | Simulator coverage, on iPhone 17 Pro and 17 Pro Max / iOS 26.5, against a **Release** build |
| **An Android SDK, and an emulator or device** | free | Building and running the Android app at all | The generated Gradle project (`npx expo prebuild --platform android`), `targetSdk 36`, and a permission set with no `SYSTEM_ALERT_WINDOW`. **Nothing Android has ever been compiled or run**: this machine has no Android SDK, no `adb` and no emulator |

### What a Supabase cloud project needs on the day

- `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in the
  build environment. These are public by design and safe in the bundle.
- Function secrets — **never** behind an `EXPO_PUBLIC_` prefix:
  `SUPABASE_DB_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
  `ARC21_JWT_ISSUER` is optional and is left
  unset locally on purpose; see `supabase/functions/_shared/env.ts`, which is
  the only module that reads any of them.
- Daily seeds need no environment variable. `ensure_daily_challenge_for()`
  generates each day's secret with Postgres CSPRNG bytes, stores it in the
  protected `daily_challenges.seed_secret` column, and publishes its commitment.
- The password-reset redirect string registered in `additional_redirect_urls`.
  GoTrue refuses to redirect anywhere not on that list, so the value the client
  passes and the value the project allows must agree by more than convention.

### Auth settings and hosted activation

Refresh B enables anonymous Auth, manual linking and email confirmations locally,
and installs an email-change OTP template. Hosted activation must mirror those
settings, configure SMTP and the exact recovery redirect, and enable native
hCaptcha with its private secret in Auth and public site key/origin in the build.
See [Refresh B](./astra-refresh/refresh-b.md) for the current evidence and limits.

The following measurements are historical phase-10 observations. In particular,
the `enable_confirmations = false` local value below is superseded by Refresh B.

Phase 10 measured each of these against the running GoTrue rather than reading
them off `supabase/config.toml`, and each is a deliberate local convenience that
must change with the project. None can be validated locally, because three of
them do nothing until real SMTP exists — which is itself blocked on a credential.

| Setting | Local value | What it must be, and why |
|---|---|---|
| `auth.email.enable_confirmations` | `false` | **`true`.** Two things follow from it and both matter. It stops anybody claiming an email address they do not own — with confirmations off, `/auth/v1/signup` returns a live session for any address on the first request. And it closes the one user-enumeration oracle this project has: with confirmations off GoTrue must answer a duplicate signup honestly, and it does — measured, **HTTP 422 `user_already_exists`, "User already registered"** — while sign-in is already indistinguishable for a wrong password and an unknown account (measured: byte-identical `invalid_credentials` for both). With confirmations on, a duplicate signup returns the ordinary "check your email" shape and the address is told about the attempt instead of the caller. |
| `auth.captcha` | absent | **Enabled** (hCaptcha or Turnstile). `[auth.rate_limit]` already caps sign-ups and sign-ins at 30 per five minutes **per IP address**, which is a speed limit rather than an identity check. |
| `auth.email.secure_password_change` | `false` | **`true`.** With it off, a stolen access token can set a new password without knowing the old one. It is worth knowing that the blast radius is already bounded: a password change DOES revoke every other refresh token, measured — the second device's next refresh answered `refresh_token_not_found` — so the attacker locks the owner out rather than sitting alongside them, and the owner recovers by email. |
| `auth.sessions.timebox` / `inactivity_timeout` | unset | A decision, not an oversight. A blackjack app that signs a player out every 24 hours is worse for most people than one that does not, and `jwt_expiry` is already one hour with rotation on. Record whichever way it goes; do not leave it unstated. |

What was measured and needs no change: the eight-character minimum is enforced
on **both** paths that set a password (signup answered 422 "Password should be at
least 8 characters", and so did `PUT /auth/v1/user`); `signOut({ scope: "local" })`
ends this device's session and leaves another device signed in; and a deleted
account's refresh token is dead immediately while its unexpired access token
reads nothing at all.

---

## Not blocked on anything

These need no credential. They are open because phase 14 ran out of sessions,
not because anything stands in the way.

- **The six store screenshots have never been captured.** STORE_LISTING.md's
  screenshot plan names each screen, its caption and the rules the images are
  held to; the audit screenshots are verification evidence, not a curated store
  set. The current app is portrait-phone only: `app.json` sets
  `ios.supportsTablet` to **false**, so the previous iPad screenshot claim did
  not match the shipped configuration. Confirm current store size requirements
  when preparing the listing. Curating and
  captioning them is an owner decision rather than an engineering task, which is
  why it is listed and not done.

**Two items that stood here are closed.** CI has run on a real runner since
phase 11 (`.github/workflows/ci.yml`, both jobs green on `ac9ae0a`, run
33865868043). And `every-screen.yaml`'s counterpart now exists:
`every-screen-online.yaml` walks the same screens on a build that HAS a server,
including the Inventory screen added in phase 12, so the audit covers both
configurations rather than only the one nobody ships.

---

## Deferred defects

None.

The one that stood here — `JOIN_PUBLIC_TABLE` not checking whether the player
was already seated — was fixed on 2026-08-23. The note said it needed a
force-quit to reach; it did not. Being MATCHED costs nothing and is not being
seated, so a matched player could open a solo table and then take the public
seat, paying two buy-ins out of one wallet through nothing but ordinary calls.
Two further faults came with it, in `join_matchmaking` and `leave_matchmaking`.
`docs/FINALIZATION_STATUS.md` records the reproduction, the three causes and the
evidence; `tests/server/economy-guards.integration.test.ts` is what keeps it
fixed.
