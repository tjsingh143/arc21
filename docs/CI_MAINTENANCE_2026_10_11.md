# SDK 57 dependency maintenance — October 11, 2026

The account-wide repository review triggered [CI run 38166858215](https://github.com/tjsingh143/arc21/actions/runs/38166858215)
at documentation commit `648dec68f28da4b4c5b2a1c7e9dac7765f3a2e37`.
That run exposed Expo patch-version drift and one server-test timeout.
The earlier October 4 release and CI measurements retain their original scope.

## Dependency alignment

Expo Doctor initially passed 20 of 21 checks. Its SDK dependency check requested
four patch updates. Installing the current Expo patch exposed three additional
module requirements. npm and `expo install --fix` regenerated the package manifest
and lockfile within SDK 57:

| Package | Previous locked version | Updated locked version |
|---|---|---|
| expo | 57.0.26 | 57.0.27 |
| expo-asset | 57.0.18 | 57.0.19 |
| expo-constants | 57.0.20 | 57.0.21 |
| expo-linking | 57.0.11 | 57.0.12 |
| expo-notifications | 57.0.21 | 57.0.22 |
| expo-router | 57.0.24 | 57.0.25 |
| expo-sqlite | 57.0.3 | 57.0.4 |

Required Expo transitive patches are also recorded in the lockfile. Unchanged
optional-platform metadata was preserved to keep the diff focused. Dependency
validation remains enabled; no package is excluded from Expo Doctor.
The [Expo CLI reference](https://docs.expo.dev/more/expo-cli/#version-validation)
describes the SDK alignment commands.

## Fresh portable verification

The final aligned lockfile installed successfully with `npm ci` on Linux using
Node 24.19.0 and npm 11.9.0. Hosted CI continues to use its pinned Node 26 runtime.

| Check | Observed result |
|---|---|
| TypeScript typecheck | passed |
| ESLint | zero errors; 21 existing warnings retained |
| Expo Doctor | 21 of 21 checks passed |
| Unit suites | 2,907 tests in 146 files passed |
| Coverage run and per-area gates | 2,881 tests in 144 files passed; gates passed |
| Contrast gate | passed, including Increased Contrast substitutes |
| Cold iOS Hermes bundle export | passed; 6.4 MB bundle |

The local executor refused the optional Unix-socket listener used by the `tsx`
CLI. A scratch-only `npx tsx` adapter invoked the same TypeScript entry points
through Node's `--import tsx` loader for generator checks. The tracked scripts,
tests, assertions and timeout settings were unchanged. The initial executor
failures and the successful portable runs were kept in the audit working record.

## Server timeout and retry

The original hosted database job passed pgTAP and 391 of 392 server tests.
`records nothing for an unranked private table` timed out at its existing
120-second limit. The failed job was rerun against the same source commit;
pgTAP and all 392 server tests then passed. The original failure remains in the
workflow history. This establishes a successful retry, without identifying the
cause of that intermittent timeout.

The dependency-maintenance commit triggers a fresh complete hosted workflow.
Its result is linked from the account-wide audit record. Native simulator and
physical-device tests, Android builds, cloud deployment, store submission and
live push delivery were not repeated for this patch update.
