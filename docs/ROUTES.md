# Arc 21 — Route Contract

The single source of truth for navigation paths. Screens are built in parallel,
so a screen that links to another must use the path recorded here rather than
inventing one. **Adding a route means adding a row here first.**

Expo Router auto-discovers routes from the filesystem; `app/_layout.tsx`
declares no screen list, so no shared file needs editing to add one.

## Shell

| Path | File | Purpose |
|------|------|---------|
| `/` | `app/index.tsx` | Entry. Routes to onboarding on first launch, otherwise the tabs. |
| `/(onboarding)/welcome` | `app/(onboarding)/welcome.tsx` | Three-page intro + 18+ disclosure. First launch only. |
| `/(tabs)/home` | `app/(tabs)/home.tsx` | Home base. For a server-confirmed player: a held seat's return first, then chip play (a table with other people, then solo Quick Play), then AI Tables, then Practice and progress. Otherwise Practice leads and one card says why online play cannot open. |
| `/(tabs)/play` | `app/(tabs)/play.tsx` | Game-mode selector, in three sections: Play for chips (with other people; solo against the dealer), AI Tables, Practice and progress. |
| `/(tabs)/learn` | `app/(tabs)/learn.tsx` | Learning hub linking to the routes below. |
| `/(tabs)/social` | `app/(tabs)/social.tsx` | Friends, blocked players, private tables, leaderboards. |
| `+not-found` | `app/+not-found.tsx` | Any `arc21://` URL naming a screen that does not exist. Not a route a control ever points at — it is where expo-router sends what it cannot match, and without it the fallback is expo-router's own light-themed `Unmatched` page whose one control links to the same unmatched path. `tests/e2e/dead-ends.yaml` drives a bad deep link into it and back out. |

Four bottom destinations only: **HOME, PLAY, LEARN, SOCIAL**. Profile opens from
the avatar in the top-right header, never a fifth tab.

Home and Play render one product hierarchy (Astra Refresh D), defined with every
mode's route and claims in `src/features/home/product-hierarchy.ts`. Every mode
card and link there opens the mode's own entry screen below — never
`/table/[gameId]` directly — and `tests/home/product-hierarchy.test.ts` checks
that each target exists. The record is
[`docs/astra-refresh/refresh-d.md`](./astra-refresh/refresh-d.md).

## Chip tables

| Path | File | Purpose |
|------|------|---------|
| `/table/public` | `app/table/public.tsx` | Public table: stakes, then a wait for other players. Queueing costs nothing; the buy-in leaves the wallet only when a seat is taken. Reached from Home ("Find a public table") and Play. |
| `/table/quick` | `app/table/quick.tsx` | Quick Play, SOLO: stakes and assistance, then Deal. Remembers the last setup. Reached from Home and Play. |
| `/table/lobby` | `app/table/lobby.tsx` | Private table lobby (see Social and private tables below). Also reached from Home ("Private table with friends") and Play. |

Each opens the shared table `/table/[gameId]` only after its own setup.

## Full-screen (tab bar hidden)

| Path | File | Purpose |
|------|------|---------|
| `/game/practice` | `app/game/practice.tsx` | The Practice table. **Exists.** |

## Learning

| Path | File | Purpose |
|------|------|---------|
| `/learn/how-to-play` | `app/learn/how-to-play.tsx` | Rules article. |
| `/learn/strategy-guide` | `app/learn/strategy-guide.tsx` | Hard / Soft / Pairs chart. |
| `/learn/drills` | `app/learn/drills.tsx` | Decision drill categories. |
| `/learn/drills/[category]` | `app/learn/drills/[category].tsx` | A drill session. |

## Competition

| Path | File | Purpose |
|------|------|---------|
| `/tournament` | `app/tournament/index.tsx` | Sprint Tournament: the format and entry fee before anything is spent, then registration, standings and the final result. |
| `/daily` | `app/daily/index.tsx` | Daily Challenge: today's format, the published seed commitment, the one ranked attempt, and the fairness card for the most recently CLOSED challenge — whose seed the device hashes itself to check the commitment. |

Both are reached from the Play tab. The tournament screen reads its format from
`sprint_format()` rather than restating it in copy — that function is granted to
`anon` as well, so a signed-out player can read the real structure before deciding
whether to make an account, which is the specification's "user must know the
format before spending". Entering is the part that needs one, and the screen says
so instead of offering a button that cannot work.

There is no separate tournament table route: a sprint is a shared table, so it
opens `/table/[gameId]` like any other.

## AI Tables (Astra Refresh C)

| Path | File | Purpose |
|------|------|---------|
| `/table/ai` | `app/table/ai.tsx` | AI Table: the terms before anything opens — the computer players, what they can see, the table chips and that nothing is ranked — then **Sit down**. A player already at an AI table is offered **Return to your AI table**; one seated elsewhere is offered the way back to that table instead. |

Reached from the Play tab's AI Table card, Home's AI Tables card (Refresh D), or
`arc21://table/ai`. The table
itself is the shared `/table/[gameId]`, exactly as for every other server mode:
there is no second blackjack screen, and a computer player's seat is drawn by
the same code as anybody else's, labelled AI from the snapshot's `isAi`.

## Progression

| Path | File | Purpose |
|------|------|---------|
| `/career` | `app/career/index.tsx` | Chapter map. |
| `/career/[slug]` | `app/career/[slug].tsx` | Node detail + start. |
| `/career/play/[slug]` | `app/career/play/[slug].tsx` | The session itself — a dealt table for standard nodes, a drill for drill nodes, then the star result. |

## Leaderboards and cosmetics

| Path | File | Purpose |
|------|------|---------|
| `/leaderboards` | `app/leaderboards/index.tsx` | Weekly XP, Tournament Wins, Strategy Accuracy and Daily Challenge, 25 rows at a time with "Load more". Reached from Social. |
| `/profile/inventory` | `app/profile/inventory.tsx` | Avatars, card backs and table themes: owned, locked with their requirement, and equip. Reached from Profile. |

Global bankroll is deliberately not a board. There is no `/shop` route and there
must not be one in the MVP: nothing is purchasable, so a locked cosmetic shows
what to do rather than what it costs.

## Account

| Path | File | Purpose |
|------|------|---------|
| `/(auth)/sign-in` | `app/(auth)/sign-in.tsx` | Email sign-in, password reset request, and the guest path. |
| `/(auth)/create-account` | `app/(auth)/create-account.tsx` | Email + username registration. |

Both screens are reachable as `/sign-in` and `/create-account` once group
segments are stripped. Navigation between them is relative (`./create-account`),
so the group can be renamed without editing either screen. There is no
`/(auth)/reset-password` route: the reset request is sent from the sign-in
screen, where the address has already been typed, and completing a reset needs a
handler for the link in the reset EMAIL — see `/auth/recovery` below.

| Path | File | Purpose |
|------|------|---------|
| `/auth/recovery` | `app/auth/recovery.tsx` | Completes a password reset from the emailed recovery link. |

`app/auth/recovery.tsx` lives in a REAL `auth` directory, not the `(auth)`
GROUP above — a group's parenthesised segment is stripped from its URL, and
this path must be a literal, stable string because it is registered by exact
match in `supabase/config.toml`'s `additional_redirect_urls` and minted into
every reset email by `PASSWORD_RECOVERY_REDIRECT_URL` in
`supabase-auth-adapter.ts`. Phase 14 session 3 found `resetPasswordForEmail`
was called with no `redirectTo` at all — the email sent, and looked sent, but
its link pointed at `site_url` (a web URL this app never serves) rather than
at the app. Fixed alongside adding this route; proved end to end against the
local Mailpit in `tests/server/password-recovery.integration.test.ts`.

Signing in is never a requirement for the offline game — every auth screen keeps
a "Continue as guest" path, and when the build has no Supabase configuration
both screens say so plainly rather than presenting a form that cannot work.

## Profile

| Path | File | Purpose |
|------|------|---------|
| `/profile` | `app/profile/index.tsx` | Profile summary. |
| `/stats` | `app/stats/index.tsx` | Full statistics. |
| `/settings` | `app/settings/index.tsx` | Settings, incl. Fair Play. |
| `/settings/fair-play` | `app/settings/fair-play.tsx` | Plain-language fairness disclosure. |

## Rules

- **No placeholder or "Coming Soon" screens.** A route that cannot be built for
  real is left absent; a link to it is omitted rather than dead.
- **E2E selectors are testIDs, and text assertions are regexes.** On iOS an
  `accessibilityLabel` replaces the child text in the accessibility tree, and
  Maestro matches text exactly unless given a pattern — so `assertVisible:
  "First Deal"` silently fails against a card labelled "First Deal, 0 of 3
  stars", while `"PRACTICE"` matches both Home's overline and the table header
  and passes without verifying anything. Prefer `id:` on a real testID; use
  `".*text.*"` when asserting on copy.
- Server-dependent surfaces (friends, leaderboards, wallet) render an explicit
  offline/unavailable state — they never fake data.
- The table hides the tab bar and owns its own header.
- Leaving an active online hand requires confirmation; Practice does not.

## Social and private tables

| Route | Reached from | Renders |
|-------|--------------|---------|
| `app/friends/[id].tsx` | A row in Social → Friends | A friend's profile, with Remove and Block behind a confirmation |
| `app/table/lobby.tsx` | Social → Private table; Home and Play (Refresh D) | Open a table or join with a code; once seated, the code, the seat list, **Invite a friend**, and Deal |
| `app/notifications/index.tsx` | Social → Notifications | Everything the server has told this player, whether or not a push reached the device. Tapping a row goes where it is about |
| `app/room/[code].tsx` | `arc21://room/CODE`, or a table-invite notification | Resolves a shared invite. Signed out, malformed and refused are each rendered distinctly |

## Deep links

`arc21://room/CODE` is the shareable private-table invite named in the
specification, and `app/room/[code].tsx` answers it.

**A code is an address, not a key.** The route normalises it, refuses an
obviously malformed one without making a request, and otherwise hands it to
`join_private_room`, which re-checks the room's status, its expiry, its capacity
and whether either player has blocked the other. Nothing about eligibility is
decided on the device.

The three outcomes a link can have are all rendered, because a deep link is the
one entry point where the player has no context for a failure: signed out (with
the route to an account), refused (in the server's own deliberately
undifferentiated wording, so a link cannot be used to probe whether a table
exists), and joined (handing over to the lobby).

Notification taps route the same way, and the destination is derived from the
notification's KIND rather than read from its payload — see
`src/features/notifications/notifications.ts`. A payload that could name its own
route would be an open redirect wearing an app icon.

**Unblocking has no screen of its own — it is a section of the Social tab.**
`public.list_blocked()` (`supabase/migrations/20260816120000_list_blocked.sql`)
reads back the caller's own blocks and nothing else, which is what makes a
**Blocked** section in `app/(tabs)/social.tsx` possible: one row per person,
each with an Unblock button (`testID="blocked-unblock-<username>"`) behind a
confirmation. The section renders only when there is something to say — somebody
is blocked, rows were dropped, or the read failed. A player who has blocked
nobody sees no heading at all, because a standing "Blocked — none" would put a
moderation surface in front of everyone who has never needed one, and an absent
section claims nothing. A failed read *is* shown, so that somebody looking for a
block to undo is never left to conclude it is already gone.

**Undoing a block restores nothing.** It lets the two find each other in search
and send requests again; the friendship does not come back. The block
confirmation on `app/friends/[id].tsx` states both halves — where the block can
be undone, and what undoing it does not return — so that nobody avoids a safety
tool believing it is permanent, and nobody reads "you can undo this" as "you can
put things back".
