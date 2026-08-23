# Release readiness

What stands between this repository and a build in a store, what each item is
blocked on, and every defect deliberately carried forward rather than fixed.

**Last updated:** 2026-08-22 (phase 14, session 6).

Three documents end at this one — [STORE_LISTING.md](./STORE_LISTING.md),
[PRIVACY.md](./PRIVACY.md) and [TERMS.md](./TERMS.md) — because each of them
runs into the same boundary: a credential this project does not hold. This page
is where that boundary is written down once, instead of three times in three
different wordings.

---

## The short answer

The app builds, installs and runs. `app.json` declares version **1.0.0**,
`ios.buildNumber` **1** and `android.versionCode` **1**; `expo-doctor` reports
21/21; a release build (no Metro, 6 MB embedded bundle, icon in `Assets.car`)
launches on the iOS simulator. `eas.json` carries development, preview and
production profiles, validated against `@expo/eas-json`'s own schema.

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
| **A domain and hosting** | varies | The privacy-policy URL Apple requires and the support URL both stores require | The text those two pages must serve, in PRIVACY.md and TERMS.md. Publish them at stable URLs and record the URLs in STORE_LISTING.md's "Support and marketing URLs" section |
| **A Supabase cloud project** | free tier | Deploying the 32 migrations, the three Edge Functions, and the function secrets; and filling the two `EXPO_PUBLIC_*` values a shipped bundle needs | Everything, locally: `supabase db reset && supabase test db` passes, the functions serve, and `.env.example` names every variable and where each one comes from |
| **APNs key / FCM credentials** | with the accounts above | A real push. The sender records `mocked` rather than `sent` when no credentials exist, so this fails honestly rather than silently | `send-notifications`, the token schema, the four `PermissionMoment`s, and the no-op adapter |
| **An analytics provider key** | optional | Nothing required for release | A vendor-neutral interface with a console adapter. Leaving `ANALYTICS_WRITE_KEY` blank is a supported configuration, not a stub |
| **A physical iOS device** | — | Removing the largest verification gap below | Simulator coverage, on iPhone 17 Pro / iOS 26.5 |

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

---

## Not blocked on anything

These need no credential. They are open because phase 14 ran out of sessions,
not because anything stands in the way.

- **CI has never executed on a runner.** `origin` exists
  (`github.com/tjsingh143/arc21`) and this branch is 7 commits ahead of it;
  `.github/workflows/ci.yml` arrived in session 5 and has therefore never been
  on the remote. Every step in it was run locally and its output pasted into
  that session's report, so what is unproven is only the runner plumbing —
  `actions/checkout`, `actions/setup-node`, `supabase/setup-cli`. Pushing the
  branch is the whole of the remaining work.
- **The six store screenshots have never been captured.** STORE_LISTING.md's
  screenshot plan names each screen, its caption and the rules the images are
  held to; no image file exists. The simulator can produce every required size.
- **`every-screen.yaml` has never walked a build with a server configured.** It
  asserts `.*no server configured.*` in five places, copy that appears only
  while `EXPO_PUBLIC_SUPABASE_URL` is unset — so it passes as the repository is
  checked out and fails the moment a real URL is present. A shipped build is
  always the second kind. Making the flow cover both states is a change to its
  contract, which is why it was not made mid-phase. Until then: move
  `.env.local` aside before running it, and know that a `.env.local` is present
  in this working copy.

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
