# Release readiness

What stands between this repository and a build in a store, what each item is
blocked on, and every defect deliberately carried forward rather than fixed.

**Last updated:** 2026-09-04 (phase 12, the production release candidate).

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
| **A Supabase cloud project** | free tier | Deploying the 58 migrations, the three Edge Functions, and the function secrets; and filling the two `EXPO_PUBLIC_*` values a shipped bundle needs | Everything, locally: `supabase db reset && supabase test db` passes, the functions serve, and `.env.example` names every variable and where each one comes from |
| **APNs key / FCM credentials** | with the accounts above | A real push. The sender records `mocked` rather than `sent` when no credentials exist, so this fails honestly rather than silently | `send-notifications`, the token schema, the four `PermissionMoment`s, and the no-op adapter |
| **A physical iOS device** | — | Removing the largest verification gap below | Simulator coverage, on iPhone 17 Pro and 17 Pro Max / iOS 26.5, against a **Release** build |
| **An Android SDK, and an emulator or device** | free | Building and running the Android app at all | The generated Gradle project (`npx expo prebuild --platform android`), `targetSdk 36`, and a permission set with no `SYSTEM_ALERT_WINDOW`. **Nothing Android has ever been compiled or run**: this machine has no Android SDK, no `adb` and no emulator |

### What a Supabase cloud project needs on the day

- `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in the
  build environment. These are public by design and safe in the bundle.
- Function secrets — **never** behind an `EXPO_PUBLIC_` prefix:
  `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
  `DAILY_CHALLENGE_SEED_SECRET`. `ARC21_JWT_ISSUER` is optional and is left
  unset locally on purpose; see `supabase/functions/_shared/env.ts`, which is
  the only module that reads any of them.
- The password-reset redirect string registered in `additional_redirect_urls`.
  GoTrue refuses to redirect anywhere not on that list, so the value the client
  passes and the value the project allows must agree by more than convention.

### Four auth settings that are local-development values today

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
  held to; no image file exists. The simulator can produce every required size —
  Apple requires a 6.9-inch iPhone set (1320 × 2868) and, because
  `ios.supportsTablet` is true, a 13-inch iPad set (2064 × 2752). Curating and
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
