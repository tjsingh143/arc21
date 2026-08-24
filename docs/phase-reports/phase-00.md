# Phase 0 — Repository recovery, interrupted-work reconciliation, trustworthy baseline

**Date:** 2026-08-24 · **Branch:** `phase14-s2-security` · **Result: PASS**
**Product code changed: none.** One stale comment corrected; two documents added.

---

## A. What was actually on disk

The phase brief anticipated partially-written work in the working tree. **There
was none.** Verified, not assumed:

```
git status            → nothing to commit, working tree clean
git stash list        → empty
git status -uall      → no untracked files
git log               → HEAD 575a022, 29 commits ahead of origin
```

The interrupted session's work was **already committed**. `git reflog` shows an
unbroken run of closure commits R1–R20 with one `reset: moving to HEAD` at
HEAD@{14}, which changed no files.

So the reconciliation question became: *is what was committed coherent and
complete?* — not *what is half-written?*

---

## B. The interrupted work — the Daily Challenge "18 vs 20 items"

The brief named `tests/server/call-function.ts` and the symptom
`expected [ 18 items ] to deeply equal [ 20 items ]`. Both are real and both are
committed, in `63cd822` ("Closure R11: a lost reply read as a shuffled shoe").

**Classification: correct and complete.** Not deleted, not re-declared solved on
the previous session's say-so. Verified independently, four ways:

1. **The file is whole.** 167 lines, a documented header, no dangling helper, no
   stub. `npx tsc --noEmit` exit 0 and `npm run check:functions` clean.
2. **The cause is sound.** The Edge runtime retires a user worker on a CPU soft
   limit and answers an in-flight request with a 5xx *after that command has
   committed*. The old `playOut` carried `if (next.status !== 200) break`, so a
   lost `NEXT_HAND` reply truncated the attempt — a short array with every card
   it did record agreeing, which is exactly the reported shape.
3. **It has a regression test that needs no stack.**
   `tests/server/call-function.test.ts` drives the caller against a stub
   answering what the runtime was observed to answer.
4. **THE RETRY WAS OBSERVED FIRING, LIVE, IN THIS PHASE.** A server run at host
   load ~11 logged seven absorptions of real runtime failures:

   ```
   [call-function] game-command answered HTTP 546 on attempt 1;
     replaying the identical body. {"code":"WORKER_LIMIT", …}
   ```

   That is the machinery working, announcing itself on stderr as designed, and
   the suite passing because of it — not despite it.

`playOut` can no longer return a truncated attempt: every command must be
accepted, a `stale` verdict counts as a refusal even at HTTP 200, and
`SESSION_COMPLETE` is asserted **before** the array is handed back.

**No Daily Challenge product work is owed.** The mode itself was never at fault;
the test was less robust than the app it tests.

---

## C. The blocker the previous session could not clear — CLEARED

`.claude/RESUME.md` opened with a blocker stopping `npm run test:server` (116
tests) and every Maestro flow: the local Edge Functions could not reach Postgres,
every command answering

```
HTTP 500 {"code":"INTERNAL"} … "Error: getaddrinfo ENOTFOUND supabase_db_arc21"
```

It had ruled out ~10 hypotheses and concluded "worth trying next: an OLDER
Supabase CLI", suspecting `node:net` vs native `Deno.connect`.

### The mechanism, proven rather than inferred

That suspicion was right, and this is the measurement that settles it — one
Deno 2.1.4 container, one network, four call paths:

| call | `supabase_db_arc21` | `db` |
|------|---------------------|------|
| `Deno.resolveDns` | `proto error: Label contains invalid characters` | ✅ 172.18.0.2 |
| `node:dns.lookup` | `ENOTFOUND` | ✅ 172.18.0.2 |
| `node:net.connect` | `ENOTFOUND` | ✅ OK |
| `Deno.connect` (native) | ✅ **OK** | ✅ OK |

Docker's own DNS resolves the name fine (`nslookup` from busybox on the same
network → 172.18.0.2). The refusal is **client-side and unconditional**: Deno's
hickory resolver will not *parse* a DNS label containing an underscore (invalid
per RFC 1035), so it never issues a query. `postgres.js` connects through
`node:net`, which takes the failing path. Native `Deno.connect` accepts the same
name because it goes to the OS resolver.

### The fix — no repository change, and CI already had it right

The db container's network aliases are `db` and `db.supabase.internal`; the
underscored container NAME is not among them. What differs is which string the
CLI injects:

| how the runtime is started | injected `SUPABASE_DB_URL` | works |
|---|---|---|
| `supabase start` (containerised runtime) | `…@supabase_db_arc21:5432` | ❌ |
| `supabase functions serve` | `…@db:5432` | ✅ |

```bash
supabase start --ignore-health-check
supabase functions serve --no-verify-jwt
```

Probe result after the change — the stack-guard's own command, signed for an
account that does not exist:

```
STATUS 403 {"code":"NOT_A_PARTICIPANT", …}     # was: 500 INTERNAL
```

The function reached Postgres, took the engine-state lock, found no seat and
refused correctly.

Two things worth recording. **`.github/workflows/ci.yml` already runs
`supabase functions serve --no-verify-jwt`** — CI would never have hit this. The
blocker was local-workflow drift toward `supabase start`'s runtime, not a repo
or CI defect. And an override is *not* available: the CLI refuses env names
beginning with `SUPABASE_` (`Env name cannot start with SUPABASE_, skipping`)
and overwrites `[edge_runtime.secrets]`, both verified here. The right fix was
never to touch `databaseUrl()` — a deployed project uses a real DNS name.

---

## D. Baseline verification — every gate, run

```
npx tsc --noEmit                    exit 0
npm run lint                        0 errors, 38 warnings
npm run check:functions             create-session, game-command, send-notifications
npm run test:unit                   86 files / 1,639 tests PASS   (92 s)
npm run test:server                 13 files /   116 tests PASS  (120 s, load 5.8)
npm run test:coverage               exit 0 — 84 files / 1,613 tests
supabase test db                    23 files /   453 assertions PASS
supabase db lint                    No schema errors found
npm run contrast:check              2 pairings, 0 failing
npx expo-doctor@latest              21/21 checks passed
npx expo export --platform ios      6.1 MB Hermes bundle, exit 0
supabase db reset                   43 migrations applied from scratch + seed
```

Coverage's 84/1,613 versus unit's 86/1,639 reconciles exactly: `vitest.config.mts`
excludes `tests/strategy/solver.test.ts` and `generated-table.test.ts` from the
COVERAGE run only (17 minutes under v8 instrumentation, and they measure
`scripts/`, which no gate covers). Both still run in `npm test`.

### The one finding worth more than its size: the server suite is load-gated

Four runs of the same 116 tests, same commit, same stack:

| host load | outcome | absorptions | duration |
|-----------|---------|-------------|----------|
| 13–16 | 8–9 files fail at *collection* | 3 | 378 s |
| ~11 | 115/116 — the 1 was my own flag error | 7 | 150 s |
| **5.8** | **116/116 PASS** | **0** | **120 s** |

Isolated to a direct measurement, with no test suite involved:

```
6 concurrent requests, load 13–16 → 3 × HTTP 401 fast, 3 × HTTP 504 after 150 s
4 concurrent requests, load  5.8  → 4 × HTTP 401, all under 0.2 s
```

and the runtime's own log during the bad runs:

```
CPU time soft limit reached: isolate: …
CPU time hard limit reached: isolate: …
user worker failed to respond: request has been cancelled by supervisor
user worker failed to respond: … the worker has already retired
```

**The ceiling is load-driven, not structural.** This is the same phenomenon R11
documented, amplified by a busy host. It explains all three failure shapes at
once: `stack-guard.ts`'s 5 s probe reporting a healthy stack as absent (its
timeout is bounded deliberately, and it has no retry), the racing tests hitting
vitest's 30 s timeout, and the 504s.

**The guard was deliberately left alone.** Raising its bound would let those
files collect and then fail on real timeouts — turning a clear "stack not
reachable" signal into a spread of product-looking failures, which is precisely
the trap that file's own header exists to prevent. The correct response is
`CLAUDE.md`'s existing rule for Maestro, now known to apply to the server suite
too: **run it on an idle machine.**

---

## E. Baseline breakage fixed

None existed. Nothing was half-written, no import was broken, no migration
malformed. The only correction was factual drift in a checked-in file:

- `.github/workflows/ci.yml` claimed the two jobs run "1,564 + 100 = 1,664"
  tests. Measured today: **1,639 + 116 = 1,755**. Corrected.
- `docs/FINALIZATION_STATUS.md` carries the same older figures at line 788, and
  was **deliberately not changed** — it is a dated ledger entry recording what
  was true at R11, and rewriting history in a ledger is not a fix.

---

## F. Anti-fake-completeness sweep

`TODO|FIXME|HACK|placeholder|stub|mock|fake|temporary|Coming Soon|not implemented`
across `src/`, `shared/`, `supabase/functions/`, `app/`:

- **32 hits, 31 of them the design token `spacing.xxxl`** matching `XXX`.
- **Zero** TODO, FIXME or HACK anywhere in the production path.
- One genuine hit: `src/features/auth/auth-adapter.ts:124`,
  `signInWithProvider?(…)` — an **optional** interface member documented as "not
  implemented today… so the screens can feature-detect it". It is absent, not
  faked; no screen claims social sign-in. Legitimate.

---

## G. Environment notes for the next context

- **Docker Desktop has 3.8 GiB and 8 CPUs.** Not the constraint — the stack
  peaks near 2.1 GiB.
- **`supabase start` fails its health gate on this host** with `vector`,
  `analytics` and `storage` "unhealthy" while those containers work (vector logs
  `Vector has started` / `Healthcheck passed`). Use `--ignore-health-check`.
- **`supabase test db` timed out once** immediately after a db reset and passed
  on retry; the db container had just restarted.
- **NordVPN's system network extension is active** on this host. It did not
  explain anything observed here, but it is worth knowing before diagnosing a
  network symptom.
- **`.env.local` EXISTS**, so `tests/e2e/every-screen.yaml` will fail its five
  `.*no server configured.*` assertions until it is moved aside and Metro
  restarted. That is expected, not a regression.
- Observation for **Phase 10**: a validly signed token for a non-existent account
  cannot have its rate limit recorded —
  `rate_limit_events_user_id_fkey` violation, logged as a warning and handled.
  Unreachable in production, where tokens exist only for real accounts.

---

## Phase 0 exit criteria

| Criterion | Met |
|---|---|
| Current repository state fully understood | ✅ clean tree, no stash, history read |
| Interrupted writes reconciled | ✅ none uncommitted; R11 verified complete four ways |
| Repository coherent | ✅ tsc, lint, deno check, 1,639 + 116 + 453 green |
| Baseline build/typecheck/tests known | ✅ every gate above, with numbers |
| No unexplained half-implemented changes | ✅ sweep clean; the one hit is a documented optional |
| Remaining defects assigned to later phases | ✅ Phases 10 and 11; rest are environment |
| Persistent launch state ready for fresh context | ✅ `docs/LAUNCH_STATE.md` + this report |

**PHASE 0: PASS**
