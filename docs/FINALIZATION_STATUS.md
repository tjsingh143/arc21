# Arc 21 — Final production-MVP closure ledger

**Mission:** take the repository as it stands to a production-MVP release candidate
against the authoritative specification
(`Arc 21 — Deep Research, Product Specification, and Claude Code Master Build Prompt.pdf`,
137 pages; Part B "MASTER BUILD PROMPT" is the binding half, and the
"MVP ACCEPTANCE CRITERIA" and "DEFINITION OF DONE" sections at its end are the gate).

This file is the finite release ledger. It is not a progress report and it is not
a roadmap. Every material MVP requirement appears here exactly once with the
evidence that decided its status. **A row is VERIFIED COMPLETE only from objective
evidence — a command and its output, a file and its line — never from a document
claiming it.**

| Status | Meaning |
|---|---|
| **VERIFIED COMPLETE** | Objective evidence recorded in the row |
| **IN PROGRESS** | Being worked in this mission |
| **FAILED** | Defect found, fix required |
| **EXTERNAL BLOCKER** | Needs a credential/account/device this machine does not have. Implementation, configuration and local verification are finished |
| **DEFERRED V1.1/FUTURE** | Explicitly out of MVP scope per the specification |

---

## Mission state

**Started:** 2026-08-22. Branch `phase14-s2-security`.

**Baseline measured at the start, before any change:**

```
npx tsc --noEmit            → exit 0
npm test                    → 77 files, 1544 tests, all passed (76.6 s)
```

Local Supabase stack up (12 containers healthy); iOS simulator iPhone 17 Pro booted
with `com.arc21.app` installed; Maestro on PATH; host load average 5.5.

**Section index below is filled as evidence lands. See `.claude/RESUME.md` for the
resume protocol if this session is interrupted.**

---

## Ledger

### R1 — A player could be charged two buy-ins out of one wallet · **VERIFIED COMPLETE**

**Severity:** blocker. Two live escrows from one wallet, on the ordinary path.

**Reproduced** against the running stack, by client-reachable calls only, before
any fix existed. `tests/server/economy-guards.integration.test.ts` failed exactly
here:

```
× refuses a public buy-in while the player holds a live solo seat
  AssertionError: expected 200 to be 409
× refuses to queue a player who already holds a live seat
  AssertionError: expected 200 to be greater than or equal to 400
```

**Root cause — three faults, not one.**

1. `joinPublicTable` (`supabase/functions/create-session/index.ts`) had no
   already-seated check. The solo path had one; the public path bought in
   regardless. The buy-in idempotency key is derived from the GAME, so two
   games are two keys and both are honoured.
2. `join_matchmaking` reused an existing enrolment by `status = 'waiting'`. A
   MATCHED player holds a `matched` row, so the lookup missed, a second
   enrolment was inserted, and `poll_matchmaking` allocated it a different room
   because the first had left `lobby` when it opened.
3. `leave_matchmaking` cancelled `waiting` only — found while fixing (2), and
   fatal to it: once a re-queue reuses a matched entry, a player who backs out
   of a match holds a dead one for ever and keeps an unfunded lobby seat.

`docs/RELEASE.md` carried this as needing a force-quit. **It does not.** Being
MATCHED is not being seated and costs nothing, so a matched player can open a
solo table first and then take the public seat — two escrows, no force-quit, no
race, no service-role fixture.

**Fix.**
- `assertNoOtherLiveSeat(tx, userId, exceptGameId)` in `create-session`, called
  from the solo path (`exceptGameId` null) and from `joinPublicTable`
  (`exceptGameId` = the room's own session, so a reconnect stays idempotent).
- `supabase/migrations/20260823100000_one_live_seat.sql` redefines
  `join_matchmaking` **from the last version** (`20260818100000_rate_limits.sql`,
  not the original) so the rate-limit charge survives, and `leave_matchmaking`
  to release an unfunded lobby seat while never releasing a funded one.
- Client half: `takeSeat` collapsed every refusal into "That seat could not be
  taken." `SESSION_ALREADY_ACTIVE` now names the table holding the chips, and
  `readRejection` moved to `src/lib/supabase/rejection.ts` rather than being
  copied — one decoder, two callers.

**Evidence after the fix.**

```
tests/server/economy-guards.integration.test.ts   3 passed
supabase test db                                  431 assertions, Result: PASS  (was 422)
npm test                                          79 files, 1554 tests passed   (was 1544)
ARC21_REQUIRE_SERVER_STACK=1 vitest run tests/server   6 files, 59 tests passed
npx tsc --noEmit                                  exit 0
```

The client-side guard was proved to discriminate: removing the
`SESSION_ALREADY_ACTIVE` branch fails `take-seat.test.ts` and nothing else.
