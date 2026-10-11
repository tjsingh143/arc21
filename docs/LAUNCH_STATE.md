# Arc 21 Launch State

**Latest completed work:** [Refresh B closure verification](./astra-refresh/refresh-b.md#26-closure-verification-audit--october-4-2026),
**PASS, October 4, 2026 PDT**. **Known current Refresh-B release-blocking software
defects: 0.** The implementation is published in this repository; both hosted CI
jobs passed at `059ee0ba9b848254fecd024daae7e2a60be374aa`
([run](https://github.com/tjsingh143/arc21/actions/runs/37243705811)).
No store submission or cloud deployment is established. Refresh C/D/E has not
begun here. External activation remains.

Read [baseline-audit.md](./astra-refresh/baseline-audit.md) for the historical
22 verified findings, native/backend evidence, final gates and local checkpoint.
The final gates include 2,446 unit tests, 2,420 coverage tests, 320 real server
tests, 592 SQL assertions, all 59 migrations and the final iOS Release installed
on both simulators. [RELEASE.md](./RELEASE.md) keeps external activation and
unverified platform/device work explicit. The phase verdicts below are historical.

**After Refresh A (publication, 2026-09-15):** one backend hotfix, for a
pre-existing Edge Function issue the CI experiment found — an early
authentication/operator refusal returned before the request body was read could
be lost by the edge runtime, leaving the caller waiting. Every function now drains
an unread body through the existing capped reader before replying; refusal codes,
statuses and ordering are unchanged. Evidence and the controlled experiment are in
pull request #2. The Refresh A checkpoint itself (`a52199d`) is unchanged.

**Last numbered phase:** 12 — Production Release Candidate
(**PASS, 2026-09-04**; see `docs/FINAL_RELEASE_REPORT.md`)

**Phase 12 — PASS.** The last software phase. It set out to DISPROVE that Arc 21
was ready and found **fourteen** things, all fixed: three Quick Play controls
pointing at routes that are not routes (typed routes had been silently disabled
by one line of `tsconfig.json` for the life of the project); no `+not-found`
screen, so any bad `arc21://` link was a dead end; a departed player drawn at the
table for ever under "Disconnected — their clock keeps running", which is untrue
of all three ways a seat is vacated; an advertised analytics integration that
does not exist; a **Face ID permission** shipped for an API the app never calls; a
privacy manifest declaring **no collected data** while the app collects five
kinds; Android's **"Display over other apps"**; EAS Update channels for a project
with no `expo-updates`; **iPad declared supported with no iPad layout**, under a
rule iPadOS 26 changed; and five defects in the repository's own tooling and
flows, including a cleanup script that could strand an account and a sign-in flow
that walked around onboarding and made every later flow fail.

The phase-12 requirement matrix, commands, device evidence and external owner
actions remain in **`docs/FINAL_RELEASE_REPORT.md`** as historical evidence.
The independent Refresh-A audit above supersedes its software-readiness verdict
and measurements. This file remains the index of what a later change must not undo.

Detailed evidence lives in `docs/phase-reports/`. `docs/FINALIZATION_STATUS.md`
remains the historical ledger and `docs/AUDIT.md` grades every area by HOW it was
verified.

---

## Phase Status

| Phase | Status | One-line basis |
|-------|--------|----------------|
| 0 — Baseline | **PASS** | Every gate below run and green on 2026-08-24. |
| 1 — Blackjack Engine | **PASS** | 471 engine tests; six defects fixed, each regression proved to fail without its fix. |
| 2 — Practice / Learning / Local Persistence | **PASS** | Nine defects fixed, each regression proved to fail without its fix; kill/resume verified on device with the same CARDS, not just the same bankroll. |
| 3 — Database / Auth | **PASS** | Seven defects fixed, each regression proved to fail without its fix; the account lifecycle run end to end against the real GoTrue. |
| 4 — Economy / Server Solo | **PASS** | Three defects fixed, each regression proved to fail without its fix; every economic command replayed, every modified-client attack run against the live stack. |
| 5 — Mobile Product / Career / Stats | **PASS** | Eight defects fixed, each regression proved to fail without its fix; the rename proved against the live stack, the last defect found only by looking at a rendered screen, and a guard that had stopped covering its own subject strengthened and proved to fail on three breaches. |
| 6 — Social / Private Multiplayer | **PASS** (reverified) | Seventeen defects fixed, each regression proved to fail without its fix; the Realtime game topic was found open in BOTH directions and closed with policies; two iOS simulators played 25 unattended hands at one private table, then walked the whole open→join→deal→leave→close lifecycle end to end with the server asked at each leave. **An independent pass then re-proved every B14/B15 regression by reverting its fix, found three further defects, and re-walked the lifecycle on a freshly reset database** — `phase-06-verification.md`. |
| 7 — Public Multiplayer | **PASS** | Eight defects fixed, each regression proved to fail without its fix by reverting it in the running system. A public table did not take a second player at all; nobody ever observed `waiting`, so three specified controls were unreachable; a public room's code admitted anyone; its accidental host could kick strangers; a leave racing a join deadlocked. Two TEST defects were hiding real ones. |
| 8 — Sprint Tournament | **PASS** | Seven defects fixed, six proved to fail by reverting the fix in the running system. Betting was not sequential at all — the format's defining mechanic was absent; a settlement-window timeout dealt the next hand with NO boundary, so a tournament could never finish or pay; a paid entry could never be given up; registering did not check for a seat elsewhere, in either direction; and the result vanished in the transaction that created it. |
| 9 — Daily / Leaderboards / Cosmetics | **PASS** | Five defects fixed, each proved to fail by reverting it in the running system. The "18 vs 20" intermittent was REPRODUCED on purpose against the real functions and is now a regression test; a bankrupt daily attempt could never end; the challenge took a second live seat and hid the first; a mid-challenge reshuffle would have come from the CSPRNG; and the seed was never published, so the commitment could not be checked by anybody. |
| 10 — Backend/API Security | **PASS** | Six findings, five fixed and each proved to fail by reverting it in the running system. `tournament_entries` was readable by EVERY authenticated account — 152 rows of live stacks and prizes — and the IDOR sweep that classified it "a stranger must see NONE of it" passed on an empty fixture; `service_role` could mint a million chips through `/rest/v1/rpc/` in one request; the app shipped a microphone permission for a game that never records. |
| 11 — Adversarial QA / E2E / CI | **PASS** | Ten defects fixed, each proved to fail by reverting it in the running system. A leaderboard page had no ceiling and answered `p_limit=2147483647` with every ranked row; one account registered **200 push devices in 1.9 s**, and each is an outbound message per notification; `search_players` was an unmetered directory dump — **108 calls enumerated 445 accounts** — whose LIKE metacharacters were unescaped; a notification payload was interpolated into a router path; the Practice assistance pills drew their labels OUTSIDE the pill at accessibility text sizes; and a cash-out the server deferred settled the chips and left the player on a dead screen that had to be force-quit. The `decode-uri-component` advisory phase 10 deferred was measured and found **not runtime-reachable** — the guard written for it was deleted rather than shipped. The two-simulator public-table lifecycle phase 7 deferred was walked end to end. **CI ran on a real runner for the first time, and kept earning its place: a commit that changed two MARKDOWN FILES failed the database job**, on two assertions that treated a shared public table as the test's own — the escrow of a table three players were sitting at, and a room strangers had already finished with. The load generator written to reproduce that then produced **eleven HTTP 500s from the product**: a public table allocated seat indices as `max + 1` over every row it had ever held against a `0..6` check, so the eighth player ever to sit there was refused by a constraint — and the table stayed active, advertising free seats and answering 500 to everyone, for the rest of its life. It failed both jobs at first: every function in `public` shipped executable by `anon` on any database whose migrations are applied by the role a current CLI uses — the foundation revoked default privileges on functions in `private` and, despite saying "the same protection for `public`", not in `public` — the app-art test compared compressed PNG bytes, which Node's bundled zlib makes platform-dependent; thirteen packages had drifted from the versions Expo SDK 57 expects; and the app could only be bundled on a machine that had bundled before. The device QA was then re-run against a **Release** build, because the one crash seen in this phase was a data race in `expo-notifications`' unsynchronised process-global delegate array — real, and reachable only by a debug build standing up several React Native runtimes while it waits on Metro. |
| 11 — reverification | **PASS** (independent) | Phase 11's ledger re-checked item by item and F-10 re-proved by reverting the allocator in the running function — the eighth arrival answered HTTP 500 again. Three further defects, all on the path that fix opened up: **a public table's engine seat list grew without bound** (twelve seats on a five-seat table after ten ordinary arrivals and departures, the snapshot 2,040 B → 6,442 B, every departed player drawn on every remaining screen under "Disconnected — their clock keeps running"); **leaving left a `matched` matchmaking reservation behind**, so the next search was answered "Seat found" for a room the player was no longer a member of and the buy-in came back HTTP 403 for two minutes; and underneath that, **a returning player was seated on their own departed row** with no buy-in taken, because `findSeat` answers with the latest seat whatever its status and the buy-in key was derived from the player rather than the seat. Two phase-11 tests strengthened: a flow assertion that could not fail, and four flows tapping non-optionally inside a conditional `repeat`. |
| 12 — Production Release Candidate | **PASS** | Fourteen findings, all fixed. Typed routes had been disabled by `tsconfig.json`'s `exclude: [".expo"]` — `exclude` filters `include` — so `router.push("/nowhere")` had never been a type error and **three Quick Play controls led nowhere**, one of them the specification's own recovery path for a player who cannot afford their tier. There was no `+not-found` screen, so any unmatched `arc21://` link landed on expo-router's developer page whose only control links to the same unmatched path. A player who LEFT a table was drawn on every remaining screen as `0 · Yet to bet · Disconnected — their clock keeps running.` for the life of the table, and none of that is true of a departed seat. The build shipped a **Face ID** usage string for an API it never calls and a privacy manifest saying it collects nothing; Android shipped **SYSTEM_ALERT_WINDOW**; `eas.json` named EAS Update channels with no `expo-updates` installed; and `ios.supportsTablet` was true with no iPad layout, which iPadOS 26 turned from a cosmetic question into a requirement to support all orientations and dynamic resizing. Five more were the repository's own tooling: a cleanup script that could not play a table out of `INSURANCE_OFFER` and therefore stranded accounts (the FOURTH helper caught by that phase), a sign-in flow that deep-linked around onboarding and left every later flow photographing the carousel, 54 `when`-guarded taps that were two reads of the screen, an audit flow that had never walked Inventory with a server present, and five stale counts asserting things about the build that had stopped being true. **26 Maestro runs on a Release build across two simulators, zero failures, zero crash reports.** `npm audit` works on this machine again and agrees exactly with the GitHub Global Advisory Database. |

Every phase has run. **The MVP software is complete**; what remains is in
`docs/FINAL_RELEASE_REPORT.md` §G, and every item there is blocked on something
that must be bought, registered, signed for or physically present.

---

## What phase 12 established that a later phase must not undo

- **`tsconfig.json` MUST NOT EXCLUDE `.expo`.** `experiments.typedRoutes` writes
  `.expo/types/router.d.ts`, and that file's module augmentation is the only
  thing that makes `router.push("/nowhere")` a type error. `exclude` filters
  `include`, so listing `.expo` removed it from the program and typed routes
  checked nothing for the life of the project — three Quick Play controls shipped
  pointing at `/game` and `/auth/sign-up`. The generated file is gitignored, so a
  checkout without it typechecks clean rather than failing, which is why the real
  gate is `tests/contracts/every-route-target-exists.test.ts`: it reads the route
  tree off disk and the targets out of the source and needs nothing generated.
- **`app/+not-found.tsx` IS LOAD-BEARING.** Without it expo-router falls back to
  its own `Unmatched` page, whose one control is `<Link href={pathname} replace>`
  — the same unmatched path — so a stale `arc21://` link on a cold start had no
  way back into the app. `tests/e2e/dead-ends.yaml` drives a bad deep link into
  it and out again.
- **`connected: false` MEANS DEPARTED, AND ONLY ONE OF THE THREE WAYS LEAVES A
  CLOCK RUNNING.** The table screen said "Disconnected — their clock keeps
  running" for every one of them and "Yet to bet" beside it, which is untrue of a
  player who cashed out and of one eliminated from a tournament.
  `seat-presence.ts` is the predicate; `isVacatedSeat` cannot substitute, because
  it exists to let a NEWCOMER reuse a slot and nobody new ever joins a private
  room.
- **A PLUGIN'S DEFAULTS ARE PERMISSIONS YOU ARE SHIPPING, and this is the second
  time.** Phase 10 removed `expo-audio`'s microphone; phase 12 removed
  `expo-secure-store`'s `NSFaceIDUsageDescription` (`faceIDPermission: false`)
  and React Native's `SYSTEM_ALERT_WINDOW` on Android
  (`android.blockedPermissions`). The Release `Info.plist` now carries **no usage
  description at all**; check that, not `app.json`.
- **THE PRIVACY MANIFEST MUST DESCRIBE WHAT THE APP COLLECTS.** Expo's template
  ships `NSPrivacyCollectedDataTypes` EMPTY, which is a claim, and it was false:
  Arc 21 collects an email address, a user id, gameplay records, profile content
  and a push token. `ios.privacyManifests` in `app.json` now declares all five
  from `docs/PRIVACY.md`, and the plugin MERGES, so the required-reason entries
  survive.
- **`ios.supportsTablet` IS A PROMISE ABOUT A LAYOUT, AND iPadOS 26 MADE IT A
  BIGGER ONE.** `UIRequiresFullScreen` is now ignored and an iPad app is expected
  to support all orientations and dynamic resizing — so an iPad-native
  declaration can no longer be narrowed by a plist key. Arc 21's design target is
  phone portrait and no tablet layout exists, so the declaration was changed to
  match: `supportsTablet: false`. It still runs on iPad, in the one layout that
  has been designed and tested.
- **ANY HELPER THAT DRIVES A HAND MUST ANSWER `INSURANCE_OFFER` FOR SOMEBODY
  ELSE'S SEAT.** `scripts/e2e-account.ts` is the FOURTH to be caught by the phase
  after betting closes. Its own `DECLINE_INSURANCE` is correctly refused when the
  phase is held by an absent player's PENDING decision; only `RESOLVE_TIMEOUT`,
  and waiting for the deadline, moves that table.
- **A FLOW THAT REACHES THE AUTH SCREEN BY DEEP LINK NEVER COMPLETES
  ONBOARDING.** `onboarding:completion` is written by the onboarding BUTTONS, and
  `app/index.tsx` reads it on every launch — so a flow that walks around it
  leaves every later flow photographing the carousel. The app is right to re-show
  it: the flag records that the 18+ disclosure has been seen, and somebody who
  deep-linked past it has not seen it.
- **`npm audit` WORKS ON THIS MACHINE AGAIN**, and agrees exactly with the
  GitHub Global Advisory Database: five distinct advisories, four of them in
  packages the shipped bundle does not contain. Phase 10 and phase 11 both
  recorded that it could not run here. Re-measure rather than inherit.

---

## What the phase 11 REVERIFICATION established that a later phase must not undo

- **A LIST THAT ONLY EVER GROWS IS A DEFECT AS SOON AS SOMETHING STOPS CAPPING
  IT.** `joinPublicTable` appended every arrival to the engine's seat list and
  nothing ever removed one — harmless only because the seat-index defect answered
  the eighth arrival HTTP 500 first. With that fixed, ten ordinary arrivals and
  departures left TWELVE seats on a five-seat table, the snapshot grew 2,040 B →
  6,442 B, and each departed player was drawn on every remaining screen under
  "Disconnected — their clock keeps running". A newcomer takes a VACATED SLOT
  now, exactly as they take the seat index a departure freed; `isVacatedSeat` is
  the predicate and it requires no chips, no wager and no hand as well as
  `connected: false`, because a player who leaves MID-HAND is disconnected while
  their committed hand is still resolving.
- **A DEPARTURE ENDS THE RESERVATION THAT PRODUCED THE SEAT.**
  `release_room_seat` released the room membership and left `matchmaking_queue`
  reading `matched` at the room just left, and `join_matchmaking` hands a live
  entry back rather than enrolling again — so a player who left a public table
  and searched again was shown "Seat found" for a room they were no longer a
  member of and refused the buy-in HTTP 403 for the two minutes housekeeping
  takes. Closed at BOTH ends: where the reservation is spent, and where it is
  read back.
- **`findSeat` ANSWERS WITH THE LATEST SEAT WHATEVER ITS STATUS**, deliberately,
  so that a cash-out can find its own idempotency record on a retry — which means
  every OTHER caller has to say whether it wants a LIVE one. `joinPublicTable`
  did not, and handed a returning player their departed row. And the buy-in key
  had to move with it: keyed on the player, a second visit found the first
  visit's ledger row and skipped the debit. It is `public_buy_in:<game>:<seatId>`
  now, the same shape as the cash-out key.
- **AN ASSERTION THAT PASSES BEFORE THE THING IT TESTS HAPPENS IS NOT AN
  ASSERTION.** `two-client-public-leave.yaml` ended by asserting the matchmaking
  tier chooser was visible, "asked of the SERVER" — but that screen does not poll
  until a tier is tapped, so the chooser is what a cold mount shows whatever the
  server thinks. It takes the seat now.
- **A TAP GUARDED BY `when` IS TWO READS OF THE SCREEN, NOT ONE.** Four flows
  tapped non-optionally inside a conditional `repeat`; the tap that LANDS
  navigates away, and the next iteration's `when` evaluated against a hierarchy
  captured mid-transition sends the tap at a control that has gone.
  `practice-hand` failed exactly that way on a Release build at load 5.6, with
  the failure screenshot showing the Practice table already open. The two-client
  flows already carried `optional: true` for this reason; the rest do now.

## What phase 11 established that a later phase must not undo

- **A CEILING ON WHAT ONE REQUEST MAY ASK THE SERVER TO PRODUCE.**
  `leaderboard_page_maximum()` and `push_tokens_per_account_maximum()` are each
  stated once, revoked from every client role, and READ by the functions that
  need them. Testing either is the hard part: a local database is far below both,
  so `25_bounded_reads.test.sql` MOVES the constant inside the transaction and
  asserts the answer follows. Asserting that `p_limit = 2147483647` returns
  "everything" would pass identically with the clamp present and absent.
- **A `LIKE` PATTERN BUILT FROM USER INPUT NEEDS `escape`, AND A SEARCH NEEDS A
  LIMIT.** `search_players` had neither: `%%` matched every profile and 108 calls
  enumerated 445 accounts unrefused. The limit lives INSIDE the function, which
  is why it is `volatile` — a wrapper that spends the limit while the unlimited
  function stays granted is a stated policy, not an enforced one.
- **`now()` IS FIXED FOR A TRANSACTION**, so "keep the newest N" cannot mean
  "and therefore the row I just wrote survives". Forty registrations in one
  statement tie exactly, and a random uuid decides. Name the row you must keep.
- **A DEEP LINK'S PAYLOAD IS NOT A PATH SEGMENT.** `destinationFor` shape-checks
  a room code and a game id before either reaches the router; `../../settings`
  in a push payload used to produce `/room/../../settings`.
- **AN ADVISORY IS A CLAIM ABOUT A DEPENDENCY, NOT ABOUT THIS APP.**
  `decode-uri-component` is genuinely catastrophic — 22 s for three kilobytes —
  and `expo-router`'s live resolver never calls it: the file that does is a
  vendored upstream copy imported by nothing. Measured on the device as well as
  read. **The guard written for it was deleted rather than shipped**, because
  code justified by a false claim is worse than no code. What remains is
  `tests/deep-links/decode-uri-component-reachability.test.ts`, which fails if an
  upgrade ever re-wires the inbound path — something `npm audit` would not
  report by one character.
- **A ROW OF FIXED-COUNT CONTROLS MUST REFLOW ABOVE `STACK_ABOVE_FONT_SCALE`,
  AND `flexWrap` DOES NOT DO IT.** A `flex: 1` child has a flex-basis of 0, so it
  never overflows its line and never wraps — it only shrinks. The row COUNT is
  what changes. The threshold is one export in `type-metrics.ts`, read by both
  `ScreenHeader` and the assistance selector.
- **NAVIGATION AFTER A DEFERRED LEAVE BELONGS TO THE SCREEN, AND THE POLL IS NOT
  A CALLER OF IT.** A cash-out refused mid-hand is held and completed by the
  store's poll; that path settles the seat and returns the chips and does not
  navigate. `shouldExitAfterHeldLeave` is the missing half. The wallet was
  correct throughout, which is exactly why nothing else noticed.
- **A DEFAULT PRIVILEGE IS PER (ROLE, SCHEMA, OBJECT TYPE), SO "IS THIS LOCKED
  DOWN" HAS A DIFFERENT ANSWER DEPENDING ON WHO APPLIES THE MIGRATION.** The
  stock image ships `postgres | public | f` granting EXECUTE to nobody and
  `supabase_admin | public | f` granting it to anon, authenticated and
  service_role. The CLI here applies as `postgres`; a newer one applies as
  `supabase_admin`. `20260813120000_foundation.sql` now revokes the function
  default in `public` explicitly, which is what its own comment had claimed for
  the life of the project. Found by the FIRST CI run this repository has ever
  had, at migration thirteen, naming twenty-three functions.
- **A BYTE-COMPARE OF COMPRESSED OUTPUT IS A COMPARE OF THE COMPRESSOR.** Node
  does not bundle one zlib, so `deflateSync(..., { level: 9 })` on macOS arm64
  and on a Linux x64 runner emit different valid streams for identical input.
  `tests/art/generated-app-art.test.ts` compares decoded PIXELS now. Whenever a
  test asserts "regenerating reproduces the file", ask whether the claim is
  about the file or about the thing inside it.
- **THE TWO-SIMULATOR PUBLIC TABLE IS STAGEABLE ONLY AGAINST A DRAINED POOL.**
  Allocation is global and a public table keeps taking players, so a room left by
  `npm run test:server` is one the device account is correctly matched into.
  `scripts/e2e-public-drain.ts` is the narrow form of the `db reset` that
  `public-matchmaking.yaml` demands. A waiting queue entry expires in five
  minutes and an expiry RELEASES the room seat — as does a relaunch between
  being allocated and taking the seat.

---

## Architecture truths a future phase must not rediscover

`CLAUDE.md` is authoritative and long; these are the ones that bite first.

- **One engine.** `shared/blackjack` is runtime-neutral. Never write a second
  implementation of a rule. Phase 1 found the one that existed: the dealer's
  drawing rule was in `playDealer` AND in `scripts/strategy-solver.ts`, so the
  strategy chart could be solved for a dealer the engine does not deal. It is now
  `dealerMustDraw` in `hand-value.ts`, called by both.
- **A disconnected seat is a DEPARTED seat.** `connected` is cleared by LEAVE, by
  a closure and by tournament elimination, and nothing ever sets it back, so
  `openBetting` sits it out. Before phase 1 a player who left mid-hand kept being
  staked the table minimum every hand by the betting timeout.
- **Three definitions mirror the engine's vocabularies** — the TS union, a Zod
  enum in `shared/contracts`, and a Postgres enum in the foundation migration.
  `tests/engine/status-taxonomy.test.ts` compares all three; add a value to one
  and you must add it to the others.
- **`toPublicState()` is the only sanitisation boundary.** Undealt cards and the
  unrevealed hole card never leave the server.
- **A REALTIME TOPIC IS PUBLIC UNTIL A CHANNEL SAYS OTHERWISE, and an empty
  policy set does NOT mean deny.** `realtime.messages` had RLS enabled and no
  policy for the whole life of the project, which meant Realtime never consulted
  it: `game:<gameId>` was readable by anyone holding the ANON KEY and writable by
  any account, so a stranger could watch a table and push a forged state onto a
  player's screen. Both were measured, not inferred. Fixed in
  `20260831120000_realtime_channel_authorization.sql`: both ends declare
  `private: true`, reading a game topic needs a live seat at that game, and the
  only topic a client may write is the presence roster. **A new channel needs a
  policy the day it is added** — and `supabase/tests/20_authorization_surface.test.sql`
  fails if the policy set changes shape.
- **AN ACTION IN THE WIRE CONTRACT WITH NO CLIENT CALLER IS A FEATURE THAT DOES
  NOT EXIST.** `RESET_PRIVATE_STACK` — the specification's free reset for a
  private player who runs out of chips — was contracted, handled, guarded three
  ways and logged, and no line of `src`, `app` or `scripts` had ever sent it. A
  broke seat is sat out by `openBetting` and `getLegalActions` answers
  NO_ACTIONS, so the table screen said "Waiting for the next hand." for the life
  of the table. `tests/contracts/every-command-has-a-caller.test.ts` reads the
  action names out of the contract file and fails for any without a caller; its
  `SERVER_ONLY` allowlist is deliberately empty. The reset also has to clear
  `sittingOut`, because `openBetting` clears it only at the START of a hand.
- **THE `your_turn` PUSH CARRIES A GAME ID AND NO SEAT ID**, because
  `notifications.data` may hold only short scalars by CHECK constraint.
  `resolveTableSeat` asks `my_active_session()` when the route did not name a
  seat, with `checked` in COMPONENT state — the `mayOpenDealtTable` rule again.
  Without it the one message written to bring an absent player back opened a
  screen saying "This screen needs a table to open".
- **A PUBLIC TABLE KEEPS TAKING PLAYERS, AND A LONE PLAYER WAITS.** Two rules
  that phase 7 had to add before public multiplayer existed at all.
  `poll_matchmaking` considered only rooms at `status = 'lobby'`, and the buy-in
  sets a room `active` — so two people who both chose Casual ten seconds apart
  were sent to two different tables, and `joinPublicTable`'s mid-shoe branch was
  unreachable. It also opened a table for a lone player on their FIRST poll, so
  `waiting` never lasted long enough to be seen and the twenty-second Keep
  Waiting / Play Solo / Cancel offer could not be reached by anybody. A
  candidate room must now be `lobby` or `active`, have somebody in it
  (`seats.taken > 0` — an emptied leftover is not a table) and have room; and a
  new one is opened only when another live enrolment exists at that tier.
- **THE ROOM ROW IS LOCKED BEFORE THE ENGINE STATE, ALWAYS.**
  `JOIN_PUBLIC_TABLE` took rooms → engine → wallet and `CASH_OUT` took engine →
  wallet → rooms, which became reachable the moment a running table started
  taking players: one player leaving as another sits down deadlocked, and the
  loser got HTTP 500 for an ordinary leave. `lockRoomForSession` fixes the ORDER
  rather than the odds. `tests/contracts/room-lock-order.test.ts` holds the
  allowlist of every function that may touch a room row, so a sixth one fails a
  test instead of a race.
- **A PUBLIC ROOM IS NOT A PRIVATE ONE THAT HAPPENS TO BE LISTED.** Its code is
  shown to matched players, and `join_private_room` did not check `visibility` —
  so a shared code seated a stranger past the queue, the tier and the
  one-live-seat guard. `remove_room_member` likewise let whoever arrived first
  at a tier (the host by accident, not by choice) kick players matchmaking had
  seated. Both refuse for public rooms now.
- **`SESSION_BUSY` IS A "NOT YET", AND WAS RENDERED AS A "NO".** A mid-hand
  cash-out is correctly refused, and the screen promised the chips came back
  when the hand settled — while nothing made that happen. A player who tapped
  leave and stopped watching stayed seated, stood in by the action timer hand
  after hand, buy-in in escrow. The intent is now held in `leavingWhenSafe` and
  completed at the first safe boundary; staking chips cancels it. The phase test
  is `canCloseSeat` in `shared/blackjack/table-closure.ts`, which the SERVER
  refuses with too — one implementation, so the client cannot ask every three
  seconds for something about to be refused.
- **`SPLIT` CAN SETTLE THE HAND**, like `LOCK_BET`. A split pair of aces takes
  one card each and stands both, so a seat splitting aces as the last actor runs
  the dealer and settles inside its own command. Assert the ACCOUNTING (the
  debit plus whatever the hand returned), never the debit alone.
- **THE DAILY CHALLENGE'S SHOE IS DETERMINISTIC AT EVERY SHUFFLE, NOT JUST THE
  FIRST.** Randomness reaches the engine at exactly two points — `createShoe`
  when the session opens and `reshuffle` inside `openBetting` once the cut card
  is passed. The second used to come from `serverRandom()`, so an attempt that
  crossed the cut would have been dealt a shoe nobody else was dealt with
  nothing failing anywhere. `dailyShoeSource(seed, shuffleNumber)` keys the
  stream on the shuffle number; `game-command` picks the source from the SESSION
  ROW's mode. Latent at twenty hands (worst of 400 greedy attempts: index 160 of
  a 234-card cut) and ordinary past forty, and `hand_count` is the challenge
  row's, capped only at 100.
- **AN ATTEMPT ENDS IN TWO WAYS.** `attemptCompletion` — the hand count, OR a
  stack below the table minimum. A Daily Challenge carries no clocks on purpose,
  so an attempt left at BETTING_OPEN with no affordable bet can never be moved by
  anybody: measured, the server dealt hand 2 and offered the seat `actions: []`
  with `betBounds: null`, and because `startDailyChallenge` RESUMES an
  in-progress attempt that account's one ranked run for the day was
  permanently unfinishable. `careerBoundary` has had this branch all along.
- **A NEW SEAT IS A NEW SEAT IN EVERY MODE.** `START_DAILY_CHALLENGE` did not
  call `assertNoOtherLiveSeat`, so a player holding a solo table was given a
  second live seat and `my_active_session()` — which orders by start time — then
  named only the newer one, stranding the buy-in. Same shape as the Sprint entry
  phase 8 closed, in the one mode neither phase had checked. The guard sits
  BELOW the resume branch: returning to an open attempt takes no new seat.
- **THE SEED REVEAL IS THE OTHER HALF OF THE COMMITMENT, AND IT HAD NO
  PRODUCER.** The column, the trigger, the projection, the parser and the render
  branch all existed, and nothing in the product ever wrote `revealed_seed` — so
  the screen promised a check nobody could make. `reveal_closed_daily_seeds()`
  runs from `ensure_todays_daily_challenge`, on demand rather than on a
  schedule; `latest_verifiable_daily_challenge()` returns the seed, the
  commitment and NO VERDICT, and the device recomputes SHA-256 itself.
- **A LEADERBOARD PAGES ON `row_number()`, NOT ON `rank`.** `rank` is what a
  player reads (equal XP is equal placing) and is not a total order, so paging on
  it can put one row on two pages and another on none. Every board computes both
  over the identical window; only `rank` is returned. Adding a defaulted
  parameter would have created a second function and made
  `leaderboard_weekly_xp(100)` ambiguous, so the old arities are dropped.
- **`deny_client_write` IS THE SECOND LOCK, AND FIVE TABLES DID NOT HAVE IT.**
  The first lock is the absence of a grant, and sixteen migrations have added one
  by accident. `player_daily_xp` — the weekly XP board's whole input — took a
  single grant to become forgeable (measured at HTTP 201 with 999,999 XP);
  `wallet_ledger`, `rooms`, `room_members` and `matchmaking_queue` were the same
  shape. `20_authorization_surface.test.sql` now asks the CATALOGUE which tables
  lack the trigger rather than naming them.
- **`every-screen.yaml` ASSUMED A SCROLL POSITION AND IT FINALLY BIT.** Returning
  from Leaderboards left Social at the TOP, and the flow waited for a footer that
  was in the tree and not on screen — under a comment stating that "returning
  keeps that position". `CLAUDE.md` already records the rule it broke. It is a
  `scrollUntilVisible` now. Two consecutive failures, then exit 0 with 87 steps.
- **A TEST HELPER THAT RETRIES A 5xx CAN HIDE A DETERMINISTIC SERVER FAULT.**
  `call-function.ts` replayed the deadlock's own `{"status":"rejected",
  "code":"INTERNAL"}` envelope and the race test passed three times out of
  three. A 5xx carrying our rejection envelope is a VERDICT — the handler
  answered — and is no longer retried, which is exactly what
  `online-table-gateway.ts` already did.
- **THE CASCADE AFTER BETTING CLOSES STOPS IN THREE PLACES.** PLAYER_TURNS,
  HAND_COMPLETE on a natural, and **INSURANCE_OFFER on a dealer ace** — about
  one hand in thirteen. That is the whole of the `reachPlayerTurns` failure
  phase 6 recorded as unreproduced, and it was silently failing a second test
  too. Any test that closes betting and then asserts a phase must accept all
  three, or answer the offer.
- **THE SPECIFICATION'S TEXT IS IN THIS REPOSITORY.** `.spec-extracted.txt` and
  `.spec-partB.txt` (gitignored); the PDF is at `~/Desktop`. `phase-06.md`
  states it is not on this machine and worked from `docs/` instead, which is how
  the free-reset requirement went unread.
- **Integer chips only**; chips move only through `apply_wallet_delta`; identity
  comes from the verified JWT.
- **Edge-function imports:** reaching into `shared/` uses `.js` specifiers
  resolved by a PER-FUNCTION `deno.json` import map; everything WITHIN
  `supabase/functions` uses `.ts`. A new function directory without a copy of
  that map takes the WHOLE stack down at startup.
- **`supabase/functions` is excluded from `tsconfig.json`** — it is typechecked
  only by `npm run check:functions`.
- Server-needed code lives in `supabase/functions/_shared/`; `shared/` holds a
  one-line barrel re-exporting it.
- **Account deletion is TOTAL and refuses for exactly one reason.** It is
  refused only while the caller still HOLDS a seat (`active` or `disconnected`)
  at a running table — a `left` seat is already settled, and refusing on one
  told a player to leave a table they had left. A lobby the departing player
  hosts is handed over through `leave_room`, never deleted from under the
  players in it. `23_account_lifecycle.test.sql` asks the CATALOGUE which
  cascading references survive, so a new table with a user column and no cascade
  fails it without anybody editing it.
- **A foreign key anonymises a REFERENCE, not the copy beside it.**
  `game_session_seats.display_name` is a copy of the profile's name; nothing
  cleared it, so a deleted player stayed named on every table they had sat at.
  Deletion now sets it to `Deleted player` explicitly.
- **A uniqueness pre-check is advisory.** `handle_new_user` checks whether a
  handle is taken and then inserts it; concurrent signups for one handle gave
  the loser HTTP 500 and no account. The insert now catches `unique_violation`
  on `profiles_username_key` and derives a fresh handle. Third version of this
  same bug — see `docs/DATABASE.md`.
- **Practice statistics and the Practice session are SEPARATE records.**
  `practice:stats` and `practice:session`, written statistics-first. They shared
  one blob before phase 2, so any reason to reject a session — a truncated write,
  a schema bump, a ruleset change — destroyed the player's entire history along
  with it.
- **Failing safe on strategy is THREE things, not two:** play continues, the
  recommendation is hidden, and the reason is RECORDED
  (`features/practice/strategy-diagnostics.ts`). Without the third, a hole in the
  tables is indistinguishable from an advisor with nothing to say.
- **A label on a `Pressable` REPLACES the text of everything inside it on iOS.**
  So a scrim that wraps a sheet silences the sheet. Both Practice sheets did
  this; the dismiss target is now a sibling occupying the visible scrim only.
  This has now bitten three times (the Home card, the accessibility switches,
  these two sheets) — always invisibly, always with a perfect screenshot.

- **A live seat must be ADDRESSABLE, not just refusable.** Every online mode
  refuses a second buy-in while a seat is held, and the game id reached the
  client once — in the reply to the buy-in — and lived only in a route
  parameter. Losing it locked the account out of Quick Play, Public Tables and
  Career for ever with the buy-in stranded, and all three refusals advised the
  player to "leave that table first". `public.my_active_session()` is the ask
  that was missing; its predicate is `assertNoOtherLiveSeat`'s, and the server
  suite asserts they agree by provoking the refusal rather than by comparing two
  copies of a predicate.
- **A solo or career table has no clocks on purpose**, so `RESOLVE_TIMEOUT`
  cannot rescue a hand its player walked away from and nothing marks a session
  abandoned. The way back is the only way back.
- **XP has no idempotency key**, so anything that grants it must ride on
  something that does — `career_progress.reward_claimed_at` for a career reward.
  The chips were always safe; the ledger's unique key sees to that.
- **A replayed command's payload is not byte-identical.** It is served from
  `private.game_commands` as `jsonb`, which sorts keys by length then bytewise.
  Same value, different bytes: assert equality of the parsed body.
- **`LOCK_BET` can settle the hand.** A natural — the player's or the dealer's —
  lands on HAND_COMPLETE inside the same cascade, so a test that assumes
  PLAYER_TURNS after locking passes about fifteen times in sixteen. Deal again
  rather than retrying the assertion.
- **An inert `SurfaceCard` is the right shape and used to be unaddressable.**
  With no `onPress` it renders a plain `View`, which is what keeps a labelled
  `Pressable` from silencing everything inside it — and that branch dropped
  `testID`, so `table-advice` had matched nothing in the tree since the advice
  panel shipped. Both branches forward it now.

- **A PREFERENCE THAT NOTHING READS IS A FEATURE THAT DOES NOT EXIST.**
  `confirmLeavingOnlineGame` was declared, defaulted, validated and persisted,
  and a full-repository grep found three references, all inside `settings.ts`.
  The stored blob was well-formed, so it looked like a working feature on disk.
  It now gates the only economic command a single mis-tap can fire — "Leave
  table" sends `CASH_OUT` — through `shouldConfirmLeavingTable`, and BOTH leave
  paths go through it: the control and the `beforeRemove` listener.
- **THE THREE TABLES THAT DEAL CARDS MUST SHARE THEIR PRESENTATION.** Practice,
  the career table and `/table/[gameId]` each render `BettingBar`, `ActionDock`
  and `HandCards`, and the two written later kept the gaps the first one had
  already filled: no split-hand chip row, `lastBet={0}` with an empty
  `onRepeat`, and — at the career table — no `OutcomeBadge` at all.
  `src/features/table/split-hands.ts` and `HandSelector.tsx` are now the single
  implementation. When you touch one table, check the other two.
- **A SERVER TABLE MUST STATE ITS OWN TERMS.** `rulesSummary`, `handNumber` and
  `shoe` have been on every snapshot since the wire contract was written and
  `/table/[gameId]` rendered none of them — so the tables where the rules are
  NOT the player's own choice were the only ones that never said what they were.
  `table-rules.ts` derives both lines from the snapshot; nothing is typed.
  In the same block, every OTHER seat rendered its stack and the player's own
  did not, outside the betting bar.
- **RENAMING EXISTED ON THE SERVER AND HAD NO CONTROL.** Two triggers, a unique
  key, two rate-limit policies, a column-level grant, and a documented
  55000 → PT429 fix "so a player who renamed twice in a month is not told the
  server broke" — and nothing in the app had ever written either column after
  signup. `profile-rename.ts` plus `EditIdentityCard` are the missing half;
  `tests/server/profile-rename.integration.test.ts` drives every one of those
  guards over HTTP, including the 429.
- **`tests/wallet/no-write-path.test.ts` NAMES THE DIRECTORIES IT SCANS**, and
  had stopped covering one: `src/features/settings` wrote `profiles.privacy`
  from outside the scan. It now scans four directories and allowlists exactly
  one table, one verb and six columns — and it is proved to fail on a wallet
  write, an off-allowlist column and an untyped patch, rather than assumed to.

- **BETTING ORDER IS A POSTED TABLE PROPERTY, AND THE SPRINT TOURNAMENT IS THE
  ONLY TABLE THAT USES IT.** `BlackjackRules.sequentialBetting` sits beside the
  bet band; it changes who may stake at a given moment and no cell of the
  strategy chart, so it does not bump `rulesetId@version`. Before phase 8 it did
  not exist: `activeSeatId` was null for the whole betting round, every seat
  could stake at once, and one seven-second clock covered all four players —
  measured, with the last seat in button order locking before the first and the
  server answering 200. `isBettingTurn` is the single definition; three callers
  share it, and the server answers **NOT_YOUR_TURN** rather than WRONG_PHASE.
- **A SETTLEMENT-WINDOW TIMEOUT STARTS THE NEXT HAND, and it used to start it
  with no competition boundary at all.** `game-command` ran `resolveHandBoundary`
  for `NEXT_HAND` only, while the engine's `RESOLVE_TIMEOUT` at HAND_COMPLETE
  calls `advanceToNextHand`. Measured: hand two dealt with
  `scheduled_hands_played` still 0 — so hand six never eliminated, the ceiling
  never rose, and a tournament could never reach twelve or pay a prize. The
  Daily Challenge's twenty-hand stop and a Career node's stars went the same
  way. `commandStartsNextHand` is the predicate now, and the deadline check is
  PART of it: `assertCommandIsLegal` returns early for `RESOLVE_TIMEOUT`, and
  the boundary runs before the engine.
- **A SUDDEN-DEATH HAND IS AN EXTRA HAND AT ITS BOUNDARY.** It does not consume
  one of the twelve and it carries the boundary's ceiling, which is why
  `tournaments.scheduled_hands_played` is counted separately from the engine's
  hand number. The button keeps rotating through it.
- **A TOURNAMENT ENTRY IS A SEAT ALREADY BOUGHT.** It becomes a real seat when
  somebody ELSE registers fourth, so `assertNoOtherLiveSeat` refuses a pending
  entry as well as a live seat — and `REGISTER_SPRINT` refuses a player already
  seated, which it did not, so an account holding a solo table was dealt a
  second live seat and `my_active_session()` lost the first. The refusal names
  something the player can do, because `WITHDRAW_SPRINT` now exists: an entry
  whose field never fills is refundable, and a `registering` tournament older
  than thirty minutes is cancelled and refunded through the ledger.
- **AN ASSERTION OVER AN EMPTY TABLE IS NOT AN ASSERTION.**
  `tests/server/rls-idor.integration.test.ts` classified `tournament_entries` as
  OWNED — "a stranger must see NONE of it" — and passed for its whole life
  because its fixture never registered for a tournament. The policy handed
  **152 rows** of `user_id`, live `chips`, `placement` and `prize_chips` to any
  signed-in account, because its third clause was
  `exists (select 1 from profiles p where p.id = user_id)` and `profiles.privacy`
  DEFAULTS to `public`, so the clause is simply true. The file's own header warns
  about exactly this ("a sweep over empty tables passes having proved nothing")
  and had one inside it. The fix in the TEST is the one that generalises: sweep
  each owned table with **no filter at all** and assert RELATIONALLY that every
  row returned belongs to the caller. That needs no fixture, and on a shared
  database it is being asked against hundreds of other accounts' rows.
- **`service_role` MUST REACH NOTHING IN `public`, AND THE FOUNDATION MIGRATION
  ONLY SAID IT ABOUT TABLES.** It kept `EXECUTE` on `apply_wallet_delta` —
  measured minting 1,000,000 chips through `/rest/v1/rpc/` with nothing but the
  key. Every real caller reaches that function as `postgres`, over the Edge
  Functions' direct database connection, so nothing legitimate wanted the grant.
  The gate now states it as "no function at all" rather than as an allowlist,
  because the correct number is zero.
- **A POLICY WITH NO `to` CLAUSE APPLIES TO `PUBLIC`, WHICH INCLUDES `anon`.**
  Five did. All five were harmless — the first lock is that `anon` holds no grant
  — and this repository has broken the first lock by accident sixteen times. The
  gate refuses a sixth.
- **A REFUSED REQUEST BODY MUST BE DRAINED, NOT CANCELLED.** The cap is on what is
  RETAINED: `readJsonBody` counts every byte and keeps none past 8 KB, so no
  caller chooses how much memory a Function allocates. It must still read to the
  end, because the gateway in front buffers the request and then waits for a
  reply — an upstream that stops reading blocks that write, and the same 32 MB
  request went from "HTTP 400 in 2.5 s" to "HTTP 504 after 60 s" when the first
  version of this fix cancelled at the cap. Both numbers measured; the second was
  a regression I introduced and then had to un-introduce.
- **A PLUGIN'S DEFAULTS ARE PERMISSIONS YOU ARE SHIPPING.** `expo-audio` defaults
  `recordAudioAndroid` and `enableBackgroundPlayback` to true, so a blackjack game
  that never records asked for the **microphone** on both platforms and declared
  iOS `UIBackgroundModes: [audio]` — while its own `configureAudioSession` sets
  `shouldPlayInBackground: false`. `npx expo config --type public` is where you
  see it; `--type introspect` shows what a prebuild would write, and it merges
  over the EXISTING `ios/` project, so a stale key survives a fixed `app.json`
  until it is deleted from the plist.
- **A UNIT TEST CANNOT SEE A SHAPE.** `HandSelector`'s chip row rendered as two
  ELLIPSES with the labels spilling out of them — a `ScrollView` with no
  `flexGrow: 0` expanded to fill `playerArea`, its children stretched, and
  `radius.pill` (999) on a 200-point-tall box is an ellipse. `tsc`, `lint` and 21
  green assertions could not see it; one screenshot could. When a change is
  visual, LOOK at it.

## Current migration head

Refresh B's local head is
`supabase/migrations/20261004120000_push_registration_intent_order.sql` (61 migrations;
32 pgTAP files / 640 assertions). Forward preservation and clean-application evidence
are in [Refresh B](./astra-refresh/refresh-b.md). No hosted migration was applied.

The latest completed Refresh-A checkpoint used
`supabase/migrations/20260909120000_career_attempt_counts.sql`
(59 migrations, all applied from scratch cleanly in the final September 14 PDT
Refresh-A gate, followed by 30 pgTAP files / 592 assertions and 25 server files /
320 tests).

Refresh A added the Career attempt-count repair: starts count once, completion
preserves that count, and existing aggregates are reconciled to actual attempt
rows. It changes no rewards, XP, chips or stars. Recovery details are in
`docs/DATABASE.md`; SQL and real start/play/replay regressions pass.

The phase 11 reverification added two:

- `20260908120000_a_room_must_not_close_under_a_newcomer.sql` —
  `poll_matchmaking` confirms its candidate room while holding that room's own
  row lock, so a room a concurrent `release_room_seat` is closing is no longer a
  candidate; and `join_matchmaking` will not hand back a `matched` entry whose
  room has closed, so a player stranded by such a race re-enrols instead of
  retrying a refusal. Root cause and recovery, answering different questions.
  `28_a_room_must_not_close_under_a_newcomer.test.sql` pins both; reverting both
  bodies fails 3 of its 6 assertions.

- `20260907120000_leaving_clears_the_reservation.sql` — `release_room_seat`
  cancels the matchmaking reservation that produced the seat it is releasing,
  and `join_matchmaking` will not hand back a `matched` entry whose room
  membership has gone. Both bodies are taken from the LAST migration to define
  each function. `27_leaving_clears_the_reservation.test.sql` pins both ends and
  the reconnect the second one must not break; reverting both bodies fails 3 of
  its 9 assertions.

Phase 11 added two:

- `20260905120000_bounded_client_reads.sql` — the leaderboard page ceiling, the
  per-account push-token ceiling with LRU eviction, and `search_players`
  escaping its `LIKE` metacharacters and spending a `player_search` limit.
- `20260906120000_seat_index_reuse.sql` — the partial unique index over
  `status <> 'left'`, so a seat index freed by a departure is reusable.

Phase 10 added one:

- `20260904120000_least_privilege_and_entry_visibility.sql` — narrows
  `tournament_entries_select_visible` to "your own entry, or the field you are
  playing" and `tournament_matches_select_visible` to the same; revokes
  `service_role`'s last privilege in `public`; names `authenticated` in the five
  policies that named `PUBLIC`; and adds gate blocks 10 and 11 for the last two.
  Both new blocks are proved to FAIL on a deliberate breach in
  `20_authorization_surface.test.sql`.

Phase 9 added three:

- `20260903120000_leaderboard_pagination.sql` — every board takes `p_offset` as
  well as `p_limit` and pages on `row_number()` over the same window `rank()`
  uses, so a shared rank cannot put a player on two pages. The one-argument
  arities are DROPPED rather than left beside the new ones: a defaulted
  parameter makes `leaderboard_weekly_xp(100)` ambiguous. `my_leaderboard_position`
  is redefined from the last file that defined it. The tournament board also
  stops counting withdrawn entries.
- `20260903130000_daily_seed_reveal.sql` — `reveal_closed_daily_seeds()` and
  `latest_verifiable_daily_challenge()`, the half of the commitment scheme that
  had no producer, plus `ensure_todays_daily_challenge` calling the first as its
  first act. The authorization gate is redefined (from the last file that
  defined it) with one name added; it refused this migration on its first run,
  which is the gate working.
- `20260903140000_server_owned_write_guards.sql` — `deny_client_write` on the
  five tables that lacked it: `player_daily_xp`, `wallet_ledger`, `rooms`,
  `room_members` and `matchmaking_queue`. Found by attacking the first and then
  asking the catalogue about the rest.

Phase 8 added one:

- `20260902120000_sprint_withdrawal_and_result.sql` — `tournament_refund` on
  `ledger_reason`; `my_sprint_entry` returns a tournament that finished within
  the last day, so the result page has something to render, and stops counting
  withdrawn entries towards the field; `sprint_standings` drops withdrawn
  entries. Both functions copied from the LAST migration that defined them.

Phase 7 added one:

- `20260901120000_public_tables_keep_taking_players.sql` — `poll_matchmaking`
  finds a running table and opens a new one only when somebody is waiting to
  share it, and reports `others_waiting` truthfully from every branch;
  `retire_empty_lobby_room` closes a lobby nobody is in;
  `expire_stale_queue_entries` releases a matched-but-unfunded reservation after
  two minutes; `join_private_room` and `remove_room_member` refuse public rooms;
  the already-seated refusal is `PT409` rather than a 500.

  Note it redefines five functions, three of which had been redefined by LATER
  migrations than the ones that introduced them — each body was taken from the
  LAST file that defined it, per the `create or replace` rule in `CLAUDE.md`.

Phase 6 added three:

- `20260830130000_room_lifecycle_and_presence.sql` — a room now retires when its
  session ends, a newcomer cannot join a table that has already dealt,
  `release_room_seat` lets the server retire a seat on a player's behalf (host
  migration included), and `touch_last_seen()` makes the presence fallback real.
- `20260830140000_refusals_are_not_faults.sql` — five functions raised `P0002`,
  which PostgREST renders as **HTTP 500**. `PT404` is the mapped code.
- `20260831120000_realtime_channel_authorization.sql` — the policies
  `realtime.messages` had never had. See "Architecture truths" below.

## Important contracts / interfaces

- `mayOpenDealtTable({ checked, dealt })` in
  `src/features/rooms/lobby-affordance.ts` — the lobby may replace itself with a
  table only when the pointer has been checked against the server ON THIS MOUNT.
  `dealt` is module-level and outlives the screen that set it, so a seat settled
  at the table screen otherwise sends the player straight back onto it, for ever.
  `checked` is component state deliberately: anything module-level arrives
  already true, carried over from the mount before, which is the shape of the
  bug. `restore()` clearing the value cannot substitute — it is asynchronous and
  the navigation effect is not.
- `src/features/table/table-deadline.ts` — the RN-free half of the server clock:
  the countdown copy, the skew grace and the predicate for when a client may ask
  the server to resolve a lapsed deadline. Arc 21 runs no game process, so a
  connected client asking is the ONLY thing that moves an expired timer.
- `public.release_room_seat(room_id, user_id)` — `leave_room`'s body with the
  identity as a parameter, so an Edge Function can retire a seat for a player who
  cashed out. Server-only; host migration lives here and touches no game state.

- `shared/contracts` — wire schemas. Strict; a non-strict schema once silently
  DELETED `canStartNextHand` and stopped every online table after hand one.
- `supabase/functions/_shared/session-economics.ts` — the single answer to which
  modes are wallet-backed. Getting it wrong mints chips.
- `_shared/session-boundary.ts` — competition shape; never touches a card.
- `_shared/decision-grading.ts` — `ACCURACY_ELIGIBLE_MODES` allowlist.
- `tests/server/call-function.ts` — the ONE way a server test calls a function.
  Replays a 5xx with a byte-identical body (same idempotency key) — UNLESS the
  body is our own `{"status":"rejected","code":…}` envelope, which is the
  handler answering rather than a lost reply, and is returned as the verdict it
  is. Retrying it hid a deterministic deadlock for a whole phase.
- `tests/server/public-seat.ts` — the ONE way a server test gets a public seat.
  Two accounts minimum, because a table is opened only when there is somebody to
  share it with; it mints a further partner if one of them is absorbed into
  another suite's table, which allocation being global makes ordinary.
- `shared/blackjack/table-closure.ts` — `canCloseSeat`, the single answer to
  "may this seat leave with its chips right now". The server refuses with it
  (`canCloseSession`) and the client waits on it (`shouldCompleteLeave`).
- `src/features/table/leave-guard.ts` — every rule about leaving a table, on the
  testable side of the React Native wall: the screen options, `mayLeaveTable`,
  `shouldConfirmLeavingTable`, `tableExitSequence` and `shouldCompleteLeave`.
- `tests/contracts/room-lock-order.test.ts` — the allowlist of functions that
  may touch a room row, and the assertion that each takes the room lock before
  the engine lock.
- `tests/server/stack-guard.ts` — the ONE probe deciding whether server tests
  run. Requires a 401 AND a sub-500 answer to a real command.
- `public.my_active_session()` — where the caller's own chips are. Argument-free,
  identity from `auth.uid()`, and it mirrors `assertNoOtherLiveSeat`'s predicate.
- `src/features/table/active-session.ts` — the RN-free half of the resume path:
  parsing, wording and the `canResume` predicate the card is gated on.
- `shared/blackjack/legal-actions.ts` — `isBettingTurn`, the single answer to
  "may this seat stake chips right now". True for every seat at an ordinary
  table; true for one seat at a time at a sequential one.
- `_shared/session-boundary.ts` — `commandStartsNextHand`, the single answer to
  "is this the command that starts the next hand". `NEXT_HAND`, or a
  `RESOLVE_TIMEOUT` at HAND_COMPLETE whose deadline has actually passed.
- `tests/server/sprint-table.ts` — the ONE way a server test gets a four-player
  Sprint Tournament. Drains the waiting pool first, and never assumes a betting
  order: it reads the one the server published, which is also the only way a
  test can notice if that order stops being enforced.
- `public.assert_client_authorization_surface()` — the deploy-time gate, ten
  rules. A migration that changes a grant calls it as its last line, and
  `20_authorization_surface.test.sql` runs it again and proves **every one of the
  ten** fails on a deliberate breach. Two are new in phase 10 — `service_role`
  reaches nothing in `public`, and no policy on a `public` table names the
  `PUBLIC` role — and two that already existed had no breach test until now (a
  view without `security_invoker`, and a grant with no policy behind it), so the
  claim in `docs/SECURITY.md` that each rule is proved to fail was true of eight
  of the ten and is now true of all of them.
- `tests/server/object-substitution.integration.test.ts` — the BOLA sweep. Every
  id the wire contract lets a client name, named by a stranger, with the victim's
  stack, seat, wallet and room membership read back afterwards and a CONTROL
  proving the endpoints do not simply refuse everybody.
- `tests/server/hostile-payloads.integration.test.ts` — every malformed payload
  and forged credential, over the wire. Its rule is **4xx, never 5xx**, and its
  32 MB case is a TIMING assertion as much as a status one: the version of
  `readJsonBody` that cancelled at the cap answered 504 after 64 seconds.

## Known unresolved defects

**No known current release-blocking software defect.** Refresh A's 22 findings
are verified in [baseline-audit.md](./astra-refresh/baseline-audit.md). The
current dependency feed retains **four advisories / 18 package entries** after
compatible fixes; [dependency-disposition.md](./astra-refresh/dependency-disposition.md)
records the actual bundle, parser, native malformed-link test and remaining
build-tool exposure. Final local environment observations, restored faults and
external verification limits are explicit in the audit and `docs/RELEASE.md`.

### Historical observations through phase 12

These are the September 4 observations, including then-current dependency
counts, timings and already superseded CI statements. They are retained as
history; the Refresh-A results above are the current authority.

0. **Five advisories in the BUILD TOOLCHAIN, one in the bundle and not
   reachable** (re-measured 2026-09-04, phase 12, from TWO independent sources
   that agree). **`npm audit` runs on this machine again** — the endpoint that
   hung reproducibly through phases 10 and 11 is answering — and it reports 19
   flagged packages, 15 moderate and 4 high, resolving to **five distinct
   advisories**. The GitHub Global Advisory Database, asked about all 926
   `name@version` pairs in the committed lockfile, returns **six**, one of which
   it labels *"Duplicate Advisory"* of another. The same five either way:
   `image-size` ×2 (**high**, and **unfixed at every published version** — the
   advisory covers `<= 2.0.2` and 2.0.2 is the latest), `@xmldom/xmldom`,
   `uuid` and `decode-uri-component`.

   **The four build-time ones are not in the app.** Metro's own source map for
   the shipped bundle lists **2,643 modules** and none belongs to `image-size`,
   `@xmldom/xmldom`, `uuid`, `metro`, `@expo/config-plugins`, `xcode` or
   `plist` — with `decode-uri-component` (1) and `query-string` (1) present as
   the positive control, because a sweep that returns zero for everything has
   proved nothing. `image-size` reaches the project through `metro`, the
   bundler; `@xmldom/xmldom` and `uuid` through `@expo/config-plugins`, which
   runs at `expo prebuild`.

   **The fifth IS in the bundle and is not runtime-reachable.** The `expo-router`
   file that calls `queryString.parse` is a vendored upstream copy imported by
   nothing; the live resolver uses `URLSearchParams`. Measured on the device in
   phase 11 (a 12,291-character hostile query navigated in 1.0 s) and pinned by
   `tests/deep-links/decode-uri-component-reachability.test.ts`.

   Nothing was upgraded and nothing needed to be: `npm audit fix --dry-run`
   changes nothing, `--force` would install `expo-router@5.1.11` — a downgrade
   of fifty-two majors — and `metro` and `@expo/config-plugins` are pinned by
   `react-native@0.86.3` and `expo-splash-screen` at the versions Expo SDK 57
   expects and expo-doctor checks.

1. **Local edge runtime is load-gated** (environment, not product). Above host
   load ~12 the runtime hits CPU soft/hard limits and retires workers; the
   stack-guard's 5 s probe then reports a healthy stack as absent. Measured:
   6 concurrent requests at load 13–16 → 3 answered, 3 × HTTP 504 after 150 s;
   the same 4-way test at load 5.8 → all under 0.2 s. **Run the server suite on
   an idle machine**, exactly as `CLAUDE.md` already requires for Maestro.
   Seen twice again in phase 3, in both of its shapes: a collection failure from
   the stack guard, and `accepts exactly one of twenty simultaneous commands`
   timing out at 90 s. **`functions serve` ALSO accumulates** — the failing runs
   had logged 45 CPU soft-limit and 16 hard-limit events; a freshly restarted
   one logged 21 and went green. Restart it before a full server run. And never
   `docker restart supabase_edge_runtime_arc21` while it is running: that kills
   the process and the gateway then answers 503.
2. **`rate_limit_events` FK violation for a non-existent user** — a validly
   signed token for an account that does not exist cannot have its rate limit
   recorded (`rate_limit_events_user_id_fkey`). Logged as a warning and handled.
   **Phase 10 looked at it and is leaving it**: reaching that branch needs a
   token signed by the project's own key for a `sub` that has no row in
   `auth.users`, which only somebody holding the signing secret can produce — and
   that person does not need a rate-limit bypass. It fails closed (the command is
   already being refused), it is logged, and it cannot be triggered by any real
   credential. Not a defect; a stated consequence.
3. **`supabase start` reports containers unhealthy on this host** (`vector`,
   `analytics`, `storage`) while the containers themselves work. Use
   `supabase start --ignore-health-check`. Environment, not repo.
4. **CI has never executed on a runner.** Every step has been run locally in the
   workflow's order. → **Phase 11.**
5. **`tests/strategy/generated-table.test.ts` is load-gated.** Its `beforeAll`
   re-solves the six-deck chart against a 180 s budget. Measured on this host by
   loading it on purpose: **29.9 s at load 5.8, 149.7 s at load 25.** Above
   roughly load 30 it crosses the budget and fails with a hook timeout that
   reads like a solver regression. Environment, not product — but a shared CI
   runner is exactly that machine. → **Phase 11.**
6. **Maestro's load sensitivity was met head on, not worked around.**
   `online-table.yaml` on an iPhone 17e failed at load average **142** — a second
   simulator booting while Metro re-bundled — with the Quick Play buy-in never
   completing. Bringing the machine back to idle first and re-running the same
   commit passed. Nothing product-side changed between the two. The rule stands:
   **build, wait for `uptime` below ~10, then run flows.**
7. **An unauthenticated caller sending a large body holds a gateway connection.**
   The Function answers 401 before reading a byte, which is the correct server
   behaviour — but the gateway in front has already buffered the request and
   cannot deliver a reply into a connection the upstream stopped reading, so the
   caller waits 60 s and gets a 504. Measured at 8 MB and 32 MB. With a token the
   same bodies are refused in under a second, because the body is then read (and
   discarded past the cap). Supabase Cloud caps request size before a function
   sees it. → **Owner action**: confirm against the cloud gateway once a
   Supabase project exists. Nothing in this repository can change it, and the
   product's own answer (HTTP 400 in under a second, with a token) is correct.
8. **One runtime-reachable dependency advisory**, `decode-uri-component` via
   `expo-router` → `query-string`, which parses incoming deep links. The
   advisory's shape does not reproduce at the installed version (20,000 bare
   percent signs decode in 0.63 ms), and the "fix" would break the app —
   `decode-uri-component@0.5.0` is pure ESM and `query-string@7` `require()`s it.
   The other four advisories are build-time only, traced to their paths rather
   than counted. → **Closed by observation 0 above**, which re-measured it in
   phase 12 from two independent sources and pinned the reachability argument in
   `tests/deep-links/decode-uri-component-reachability.test.ts`.
9. **Four GoTrue settings are local-development values** — `enable_confirmations`
   off, no captcha, `secure_password_change` off, no session timebox. The first
   is also the project's one user-enumeration oracle (`/auth/v1/signup` answers
   `user_already_exists`). None can be validated without SMTP. → **Owner
   action**, and the one that matters is `enable_confirmations = true`; itemised
   with what each buys in `docs/RELEASE.md` and in
   `docs/FINAL_RELEASE_REPORT.md` §G.4.
10. **The simulator reached a broken install state twice in phase 5.**
   `simctl get_app_container` returned a `com.arc21.app-<timestamp>.app`
   placeholder and every launch failed `FBSOpenApplicationServiceErrorDomain
   code=1`; separately the XCUITest driver refused to start with a repeating
   `Failed to connect to 127.0.0.1:54474`. Both cleared by `simctl uninstall` +
   `install` from DerivedData, and by rebooting the simulator with stale
   `maestro-driver-ios` processes killed. Harness, not product — but check the
   container path FIRST, because a missing app reads as a broken flow.

## External blockers

Apple Developer, Play Console, Expo/EAS project id, a domain (privacy policy,
support, AND the account-deletion request page Google Play requires alongside
the in-app path), a Supabase cloud project, APNs/FCM credentials, a physical iOS
device, and an Android SDK with an emulator or device — **nothing Android has
ever been compiled or run here**. Each is written out with its exact owner
action and its exact verification in `docs/FINAL_RELEASE_REPORT.md` §G, and
summarised in `docs/RELEASE.md`. None blocked any phase of the build.

## Historical green verification — 2026-09-04 (phase 12, the release candidate)

From a **clean dependency install**, against a database reset from empty, with
`supabase functions serve` restarted first:

```
rm -rf node_modules && npm ci       exit 0, 9.8 s
npx tsc --noEmit                    exit 0
npm run check:functions             all 3 Edge Functions typecheck
npm run lint                        0 errors, 37 warnings (baseline unchanged)
npm run test:unit                 125 files / 2,415 tests PASS  (phase 11: 123 / 2,399)
npm run test:server                23 files /   302 tests PASS, 167 s
supabase db reset                  58 migrations applied from empty, exit 0
supabase test db                   29 files /   582 assertions PASS
npm run test:coverage              per-area gates pass, exit 0
npm run contrast:check             50 pairings, 0 failing (+2 Increased-contrast substitutes)
npm run benchmark                  809 µs/hand at load 19.5; heap +12 KB over 50 hands
npm run bundle:check               exit 0, 6.2 MB Hermes bundle
npx expo-doctor@latest             21/21 checks passed
npx expo prebuild --clean          iOS + Android generated from app.json
npx expo run:ios --configuration Release   Build Succeeded
```

Maestro, **Release build**, two simulators (iPhone 17 Pro + 17 Pro Max, iOS
26.5): **38 runs, 0 failures, and no Arc21 crash report written by any of them**
— 26 against the build carrying every code fix and 12 more against the final
artifact, which differs only by `supportsTablet: false`
— `dead-ends` (new), the three Practice flows, `career-node`, `mc-sign-in` ×2,
`online-table`, `every-screen-online`, the eight-flow private two-client
scenario, the five-flow public two-client scenario, both Sprint flows,
`private-lobby`, `public-matchmaking` and `online-leave-mid-hand`. The
`expo-notifications` `EXC_BAD_ACCESS` phase 11 diagnosed did not recur. Also
walked: the Release build on a **13-inch iPad Pro**, which is what settled the
`supportsTablet` question.

`every-screen.yaml` was NOT re-run: it asserts `.*no server configured.*`, which
a Release build inlines at bundle time, so it needs a second build with
`.env.local` moved aside. Nothing in the unconfigured path changed this phase and
`dead-ends.yaml` exercises the same component branch signed out. Stated rather
than left to be assumed.

**CI has NOT run on this phase's commit.** The last SHA CI verified is `ac9ae0a`;
pushing is an owner action (`docs/FINAL_RELEASE_REPORT.md` §G.10).

## Previous green verification — 2026-09-04 (phase 11 reverification)

Against a database reset from empty (57 migrations) with `functions serve`
restarted first, and carrying this pass's three fixes:

```
npx tsc --noEmit                    exit 0
npm run lint                        0 errors, 37 warnings (baseline unchanged)
npm run check:functions             all 3 Edge Functions typecheck
npm run test:unit                 123 files / 2,399 tests PASS  (phase 11: 122 / 2,395)
npm run test:server                23 files /   302 tests PASS  (phase 11:  23 /   300)
supabase db reset                  58 migrations applied from empty, exit 0
supabase test db                   29 files /   582 assertions PASS (phase 11: 27 / 567)
npm run test:coverage              per-area gates pass, exit 0
npm run contrast:check             50 pairings, 0 failing (+2 Increased-contrast substitutes)
npm run benchmark                  781 µs/hand at load 4.9; heap +11 KB over 50 hands
npx expo-doctor@latest             21/21 checks passed
npm run bundle:check               exit 0
```

Maestro, **Release build**, two simulators (iPhone 17 Pro + 17 Pro Max, iOS
26.5), **31 runs and no Arc21 crash report written by any of them**: the
two-simulator public-table lifecycle twice end to end, `practice-hand`,
`practice-analysis`, `practice-resume`, `career-node`, `online-table`,
`every-screen-online`, `mc-sign-in` ×3, plus four hostile deep links, the
accessibility labels asserted on the rendered table, a hand-edited local store
proved unable to reach the server, and five cold starts (4.6–6.8 s to a rendered
Home on this host).

One server-suite failure was seen and diagnosed rather than retried: the 32 MB
body test timed out in a run whose runtime log carried 48 CPU soft-limit events,
and the same request measured **HTTP 400 in 824–1,845 ms** against a fresh
`functions serve`, with the whole suite then 302/302.

**CI is green on both jobs for the code head `ac9ae0a` — run 33865868043.** That is
the commit this phase finally stands on, and it is NOT the one the reverification
first pushed. The progression, because the middle steps are the interesting ones:

* run 33848267009 · `fc5568e` · the reverification's three fixes · **green**,
  first attempt;
* run 33849934174 · `8467389` · documentation only · **green**;
* run 33852015342 · `011cbdc` · documentation only · **RED** — one server test
  of 302, `six matched public rooms and none could be sat at: 409
  SESSION_CLOSED`. A third markdown-only commit failing the database job for a
  real reason. Not retried: reproduced with two transactions against the running
  stack, root-caused to `poll_matchmaking` handing out a room it held no lock on
  while `release_room_seat` was closing it, fixed and pinned;
* run 33863844020 · `aeb8a76` · that fix · **database job green — the job that
  had been red** — and the other job then red at `npx expo-doctor@latest`, 20/21,
  on three SDK-57 patches Expo published at 07:46–08:05 UTC while this closure
  was running. Not caused by the commit, which changed two `.sql` files; the run
  two hours earlier had passed 21/21 on the same `package.json`;
* run 33865868043 · `ac9ae0a` · `npx expo install --fix`, patch-level and inside the
  `~` ranges already declared · **green**, both jobs.

The runner reproduced every local number on that last run: 58 migrations applied
from scratch (ending `20260908120000_a_room_must_not_close_under_a_newcomer.sql`),
`Files=29, Tests=582` of pgTAP, 23 files / 302 server tests, 0 lint errors,
123 files / 2,399 unit tests, coverage gates green, expo-doctor 21/21, and the
iOS bundle. **The CODE head CI has verified is `ac9ae0a`; anything later on this
branch is documentation only.**

**Registry-backed dependency audit.** `npm audit` still cannot run here — the
registry answers package metadata (HTTP 200) but its
`POST /-/npm/v1/security/advisories/bulk` endpoint hangs up reproducibly
(HTTP 000 after 30 s), and Dependabot alerts are disabled for the repository. The
**GitHub Global Advisory Database** is reachable and was asked about all **926**
`name@version` pairs in the committed lockfile: **six advisories**, two of them
high (`image-size`, unfixed upstream at every published version), and **none of
them in the shipped bundle** — proved from Metro's own source map, whose 2,641
modules contain no `image-size`, `@xmldom/xmldom`, `uuid`, `metro`,
`@expo/config-plugins` or `xcode`, and do contain `decode-uri-component` and
`query-string` as the positive control. Full analysis in §Y of the verification
report.

## Previous green verification — 2026-09-02 (end of phase 10)

Against a database reset from empty, with `functions serve` already up:

```
npx tsc --noEmit                    exit 0
npm run check:functions             all 3 Edge Functions typecheck
npm run lint                        0 errors, 37 warnings (baseline unchanged)
npm run test:unit                 119 files / 2,366 tests PASS  (phase 9: 118 / 2,359)
npm run test:server                22 files /   294 tests PASS  (phase 9:  20 /   250)
supabase test db                   25 files /   539 tests PASS  (phase 9:  25 /   532)
npm run test:coverage              per-area gates pass, exit 0
npm run contrast:check             50 pairings, 0 failing
supabase db reset                  54 migrations applied from empty, exit 0
```

Plus the phase's own adversarial probe against the live stack — **59 probes,
0 failures**: 4 cross-user reads, 13 object substitutions, 21 malformed payloads,
8 forged credentials and 2 least-privilege checks — and a separate leak probe
that plays a hand to PLAYER_TURNS, reads the authoritative row out of
`private.game_state_private` by superuser, and finds **every undealt card id and
the down hole card absent from all eight surfaces a client can read**, with the
cards that seat HAS been dealt present as the control. Maestro was NOT re-run: no
client screen changed this phase beyond one sentence of Settings copy, which has
its own test.

## Previous green verification — 2026-09-02 (end of phase 9)

Against a database reset from empty, with `functions serve` restarted first:

```
npx tsc --noEmit                    exit 0
npm run check:functions             all 3 Edge Functions typecheck
npm run lint                        0 errors, 37 warnings (baseline unchanged)
npm run test:unit                 118 files / 2,359 tests PASS  (phase 8: 118 / 2,330)
npm run test:server                20 files /   250 tests PASS  (phase 8:  20 /   243)
supabase test db                   25 files /   532 tests PASS  (phase 8:  25 /   520)
npm run test:coverage              per-area gates pass, exit 0
npm run contrast:check             50 pairings, 0 failing (+2 Increased-contrast)
npm run benchmark                  802 µs/hand (range 752–808)
supabase db reset                  53 migrations applied from empty, exit 0

Maestro, iPhone 17 Pro Max (iOS 26.5), dev build, Metro restarted with `--clear`
AFTER the client edits and confirmed by its pid's start time:
  every-screen-online.yaml          exit 0, 46 steps COMPLETED
  every-screen.yaml                 exit 0, 87 steps COMPLETED (.env.local aside)

Daily Challenge stability, live stack: 12 consecutive runs during development,
10 further quiet runs after the final reset, 4 runs started five seconds into a
full `npm run test:unit` — the shape the historical intermittent was seen in —
and 3 confirmation runs against the final code. **29 runs, 0 failures**, with no
`[call-function]` retry warning in any of them.
```

`contrast:check` went from 46 pairings to 50: `accent` is used as body TEXT in
five places and had only ever been measured as a button FILL. All four new
pairings pass, 7.54:1 at the worst.

## Previous green verification — 2026-09-01 (end of phase 7)

```
npx tsc --noEmit                    exit 0
npm run lint                        0 errors, 37 warnings (unchanged)
npm run check:functions             all 3 Edge Functions typecheck
npm run test:unit                 116 files / 2,299 tests PASS  (phase 6: 115 / 2,280)
npm run test:server                19 files /   223 tests PASS  (phase 6:  18 /   199)
                                    live stack, against a freshly reset database
supabase test db                   25 files /   513 tests PASS  (phase 6:  25 /   494)
npm run contrast:check             46 pairings, 0 failing (+2 Increased-contrast substitutes)
npm run test:coverage              per-area gates pass, exit 0
supabase db reset                  49 migrations applied from empty, exit 0

Maestro, iPhone 17 Pro (iOS 26.5), dev build, Metro restarted with `--clear`
AFTER the client edits and confirmed by its pid's start time — CLAUDE.md's
stale-bundle rule:
  online-table.yaml                 exit 0, 44 steps COMPLETED
  public-matchmaking.yaml           exit 0, 31 steps COMPLETED  (new this phase)

`public-matchmaking.yaml` is the first time the twenty-second Keep Waiting /
Play Solo / Cancel offer has been on a screen: before this phase no player ever
observed `waiting`. It REQUIRES a database reset first, and its header says why
— a public table left open by `tests/server` is one this account is correctly
matched into, and the first run was answered "Seat found — 4 already seated",
which is the phase's own fix working and makes the lone-player path
unobservable. Same class as `every-screen.yaml` needing `.env.local` moved
aside.
```

Each of phase 7's fixes was re-proved by REVERTING it in the running system:
removing the `v_waiting = 0` guard, removing `seats.taken > 0` with
`retire_empty_lobby_room` no-opped and a leftover room built through the public
API, removing `lockRoomForSession` from `cashOut`, and inverting the lock order
in `create-session` — each fails the named test, and the failure messages name
the defect rather than a symptom.

## Previous green verification — 2026-08-31 (end of phase 6)

```
npx tsc --noEmit                    exit 0  (covers tests/ too — see below)
npm run lint                        0 errors (37 warnings, unchanged)
npm run check:functions             all 3 Edge Functions typecheck
npm run test:unit                  113 files / 2,239 tests PASS  (phase 5: 112 / 2,183)
npm run test:server                 18 files /   194 tests PASS  (phase 5:  17 /   175)
                                    live stack, against a freshly reset database
supabase test db                    25 files /   494 tests PASS  (phase 5:  25 /   483)
npm run contrast:check              46 pairings, 0 failing (+2 Increased-contrast substitutes)
npm run test:coverage               per-area gates pass
supabase db reset                   48 migrations applied from empty, exit 0

Two iOS simulators, two accounts, one local backend (phase 6's multi-client proof):
  iPhone 17 Pro + iPhone 17 Pro Max, e2e-lobby@ and e2e-guest@arc21.test
  room created · code typed · both lobbies "2 of 2 seated" · host dealt ·
  BOTH devices reached the table · both rendered the countdown ·
  the table advanced unattended from hand 1 to hand 25 (client-driven
  RESOLVE_TIMEOUT, over and over) · both placed deliberate 100-chip bets ·
  after both left: room `closed`, session `completed`, 0 seats

  Re-run END TO END on the build carrying the B14/B15 lobby fixes, room QW9RGX,
  eight flows, every one exit 0 — host-open · guest-join · host-deal ·
  guest-table · HOST LEAVES (lobby offers a new table) · play a deliberate
  100-chip bet · unattended advance to a 20-chip default · GUEST LEAVES (last
  seat out). The server was asked at both leave points rather than the
  screenshots being trusted: after the host left, room `active`, session
  `active`, host migrated to the guest, host seat `left` with stack 0 and
  membership `left`, guest seat `active` on 5,040; after the guest left, room
  `closed`, session `completed`, 0 held seats, 0 joined members.

THE UNEXPLAINED TRANSIENT IS NOW EXPLAINED — see
`docs/phase-reports/phase-06-verification.md`. It was recorded here as "in the
first of three `test:server` runs, `economy-authority.integration.test.ts` threw
once inside the `reachPlayerTurns` helper … unreproduced, not diagnosed."
Reproduced on demand in the verification pass at four runs in twenty, and
confirmed from the engine row: `LOCK_BET`'s cascade parks at INSURANCE_OFFER
whenever the dealer's upcard is an ACE, and the helper handled only PLAYER_TURNS
and HAND_COMPLETE. It is test nondeterminism, not a product defect. Three more
tests carried the same assumption and are fixed with it — the helper now
declines the offer, and 25 consecutive runs pass.

Maestro, iPhone 17 Pro (iOS 26.5), dev build + Metro, stack live:
  practice-hand.yaml                exit 0, every step COMPLETED
  career-node.yaml                  exit 0, all 20 hand iterations, stars progressed
  online-table.yaml                 exit 0
  every-screen.yaml                 exit 0, with .env.local moved aside
```

## Verification pass — 2026-08-31, same day

**Phase 6 — PASS (independently reverified).** `phase-06-verification.md`.

Every B14/B15 regression re-proved by REVERTING its fix. Five further problems
found and fixed: two product defects (`RESET_PRIVATE_STACK` had no client caller
and its server half left the seat sitting out; the `your_turn` push led to "this
screen needs a table to open") and three tests asserting one phase where the
cascade legitimately has three. Re-measured on a database reset from empty:

```
npx tsc --noEmit                    exit 0
npm run lint                        0 errors, 37 warnings (unchanged)
npm run check:functions             all 3 Edge Functions typecheck
npm run test:unit                 115 files / 2,280 tests PASS  (+2 files, +41)
npm run test:server                18 files /   199 tests PASS  (+5)
supabase test db                   25 files /   494 tests PASS
supabase db reset                  48 migrations applied from empty, exit 0
npm run contrast:check             46 pairings, 0 failing

Two iOS simulators, two accounts, one local backend, room PFD86N — ten flows,
every one exit 0, with the server asked at each checkpoint:
  before any leave     room active,   session active,    2 members, 2 seats
  after the HOST left  room active,   session active,    1 member,  1 seat,
                       host migrated to the guest, host seat `left` on 0
  after the GUEST left room closed,   session completed, 0 members, 0 seats
  wallets untouched at 25,000 each; zero table_buy_in/table_cash_out rows
```

The database WAS reset during phase 6: all 48 migrations applied from empty,
including the three this phase added.

**`tsc` covers `tests/` and vitest does not typecheck.**
`tests/table/split-hands.test.ts` built a `Card` with no `deckIndex` and ran
green under vitest; `npx tsc --noEmit` caught it. A test that passes is not a
test that compiles.
