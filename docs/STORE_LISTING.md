# Store listing — drafts

Draft copy for the App Store and Google Play, plus the screenshot plan and the
age-rating rationale.

**Nothing here has been submitted.** No App Store Connect or Play Console
account exists for this project; see `docs/RELEASE.md` for what that blocks.

---

## The rules this copy is written under

These are not style preferences. Listing copy is the one surface a reviewer,
a regulator and a player all read, and it is the easiest place in the whole
product to say something the app does not do.

1. **The positioning is fixed and must be matched exactly:** a simulated card
   game, 18+, virtual chips with no monetary value, no real-money gambling, no
   cash prizes.
2. **The listing may not say anything stronger or different from the app.** The
   in-app disclosure is a constant — `CHIPS_NOT_MONEY_FOOTER` in
   `src/features/settings/fair-play-facts.ts` — and `app.json`'s
   `extra.disclaimer` is pinned to it by `tests/stats/fair-play.test.ts`. Quote
   that string; do not paraphrase it.
3. **No claim of external audit, certification, testing-house approval,
   licensing or published RTP.** None exists. This is absolute invariant 8, and
   store copy is precisely where it would be tempting — "certified fair" is a
   phrase that sells. `FORBIDDEN_CLAIM_TERMS` lists the words; the same sweep
   that guards the Fair Play screen should be run over any edit to this file.
4. **No claim that playing here improves real-money outcomes.** It does not, and
   the app says so on the Fair Play screen and at onboarding.

### Verified, not assumed

Every length above was measured, not estimated:

```
OK  App Store name               6 / 30
OK  App Store subtitle          30 / 30
OK  Promotional text           149 / 170
OK  Keywords                    95 / 100
OK  Description               2242 / 4000
OK  Play title                  28 / 30
OK  Play short description      73 / 80
```

The `FORBIDDEN_CLAIM_TERMS` sweep was run over every fenced copy block on this
page. It returns exactly one hit — "certified", in the sentence *"Arc 21 has
**not** been tested or certified by any external laboratory, regulator or
auditor"*. That is the negation, and it is the sentence that makes the listing
honest; it is the same exemption `tests/stats/fair-play.test.ts` grants
`NO_CERTIFICATION_STATEMENT`. **Do not "fix" it.** Any other hit is a real
problem.

---

## App Store

### Name (30 characters max)

```
Arc 21
```

### Subtitle (30 characters max)

```
Simulated blackjack. No money.
```

### Promotional text (170 characters max)

```
Learn blackjack properly. Every hand is dealt from a real shuffle, the strategy
advice is computed rather than copied, and none of it costs anything.
```

### Keywords (100 characters max, comma separated, no spaces)

```
blackjack,21,card game,strategy,basic strategy,practice,trainer,simulated,solitaire card,casino
```

Deliberately absent: "bet", "wager", "win money", "real money", "cash",
"jackpot", "free chips", "slots". Some of those would draw real-money-gambling
review; the rest would be untrue.

### Description (4,000 characters max)

```
Arc 21 is a simulated blackjack game. Virtual chips have no monetary value and
cannot be redeemed for money or prizes. There is nothing to buy.

LEARN THE GAME PROPERLY

Practice runs entirely on your device — offline, signed out, whenever you want.
Play a hand, and Arc 21 tells you what the correct decision was and why. The
recommendations come from an expected-value solver computed for these exact
rules, not from a chart copied off the internet. When the tables have no answer
for a situation, you are shown nothing rather than a guess.

Drills isolate the decisions people actually get wrong, weighted by the ones
you have missed before.

A CAREER, NOT A GRIND

Work through a series of nodes, each with its own objective. A node always
awards its first star for finishing it, so a bad run of cards can never block
your progress.

PLAY WITH OTHER PEOPLE

Public tables, private rooms with a code, sprint tournaments and a daily
challenge that deals every player the identical shoe. Server-authoritative:
your device never decides a card, a payout or a result.

SEE WHAT YOU ARE ACTUALLY DOING

Statistics that mean something — decision accuracy against basic strategy, the
expected value you have given away, and where. Empty states say why they are
empty. Nothing shows you a record of zero and calls it a record.

FAIR BY CONSTRUCTION, AND CHECKABLE

Six decks, shuffled with your device's cryptographically secure random number
generator using an unbiased shuffle. The cut card sits around 75% through the
shoe. Cards come off the shoe in the order they were shuffled into it. Nothing
looks at whether you are winning or losing, and there is no difficulty setting
hidden behind the table.

The Fair Play screen inside the app describes all of this in detail, including
what it is NOT: Arc 21 has not been tested or certified by any external
laboratory, regulator or auditor, and that page is not an audit. It is a
description of how the code works.

WHAT THIS IS NOT

No real-money gambling. No wagering, cash-out, purchases, loot boxes, prize
wheels or paid advantage. No advertising. Playing well here does not improve
your chances of winning money anywhere else — basic strategy narrows the house
edge, it never removes it.

18+.
```

### What's New (first release)

```
First release.
```

---

## Google Play

### Title (30 characters max)

```
Arc 21 — Simulated Blackjack
```

### Short description (80 characters max)

```
Simulated blackjack with real strategy training. Virtual chips only. 18+.
```

### Full description (4,000 characters max)

The App Store description above, unchanged. It already avoids
platform-specific language, and two descriptions that drift apart is exactly
the failure this repository keeps finding.

### Play Console declarations

| Declaration | Answer |
|---|---|
| Contains ads | No |
| In-app purchases | No |
| Target audience | 18+ |
| Gambling with real money | No |
| Simulated gambling | Yes |
| Data safety — collected | Email address, in-app gameplay data (see `docs/PRIVACY.md`) |
| Data safety — shared with third parties | None |
| Data safety — deletion | Yes, in-app: Settings → Delete account (`delete_own_account()`) |
| Account creation required | No — Practice, the strategy guide and drills work signed out |

---

## Age rating rationale

**Target rating: 18+ on both stores.**

Arc 21 simulates a casino card game. It involves no real money at any point:
there is no purchase path, no cash-out, no prize, and no way to convert a
virtual chip into anything. That makes it *simulated gambling*, not gambling —
but simulated gambling is itself a rated content type on both stores, and the
honest answer to the questionnaire is the one that produces the highest rating,
not the one that produces the widest audience.

Questionnaire answers, and why:

| Question | Answer | Why |
|---|---|---|
| Real-money gambling or betting | **No** | No money enters or leaves. Invariant 2, and there is no code path that could. |
| Simulated gambling | **Yes, frequent** | Blackjack against a dealer for chips is the entire product. |
| Contests / prizes | **No** | Tournaments and the daily challenge pay virtual chips only, which are non-transferable and worth nothing. |
| In-app purchases | **No** | Nothing is for sale. |
| Advertising | **No** | No ad SDK is present. |
| User-generated content | **Limited** | A display name, username and 160-character bio. No free-text chat exists. |
| Social features | **Yes** | Friends, private rooms and leaderboards. |
| Alcohol, drugs, violence, sexual content | **No** | None. |

The app states 18+ before the first hand is dealt — it is the first line of the
onboarding disclosure (`src/features/onboarding/pages.ts`) — and repeats it in
the responsible-play section of the Fair Play screen. Store copy and app copy
therefore agree, which is the point.

**A note on the user-generated-content answer.** There is no chat, so the only
free text another player can see is a display name, a username and a bio. That
is still user-generated content and should be declared as such; a listing that
answers "none" and then ships a bio field is a listing that is wrong.

---

## Screenshot plan

Six screenshots per platform, in this order. The order is the argument: what it
is, that it teaches, that it is honest, that it has depth.

| # | Screen | Caption | Why it is here |
|---|---|---|---|
| 1 | Practice table mid-hand, action dock visible | "Play a hand. Offline, signed out, free." | The product in one image. Shows the table, the cards and the controls without needing an account. |
| 2 | Advice shown after a decision | "Every decision, graded against basic strategy." | The differentiator. This is why somebody installs it. |
| 3 | Fair Play screen, the shoe-in-numbers card | "The shuffle, described in numbers you can check." | Trust. Also the screen that carries the no-certification statement, so a reviewer sees it early. |
| 4 | Statistics — accuracy and EV lost | "See what you are actually costing yourself." | Depth, and it demonstrates the empty-state rule if the account is new. |
| 5 | Career map | "A career that a bad run of cards cannot block." | Progression without a grind. |
| 6 | Daily Challenge | "The same shoe, dealt to everybody, once a day." | The multiplayer/competitive hook, stated fairly. |

Rules for the images themselves:

- **Real screenshots of the real app.** No mockup frames with invented numbers,
  no composited screens that do not exist. A store image showing a balance or a
  statistic the app cannot produce is a fabricated record.
- **No chip totals large enough to read as a jackpot**, and no currency symbol
  anywhere near a chip count. Chips are not money and the images must not imply
  otherwise.
- Dark palette as shipped. No added glow, gold rims or confetti — the design
  brief is "not a casino", and the store images are where that gets abandoned
  first.
- Captions must be true of the screen they sit on.

Required sizes: iPhone 6.9" and 6.5" (App Store); phone, 7" and 10" tablet
(Play). All are produced from the simulator; a physical device has never run
this build (`docs/RELEASE.md`).

---

## Support and marketing URLs

Both stores require a support URL, and Apple requires a privacy-policy URL.
**Neither exists**: this project has no domain and no hosting, and inventing one
would produce a listing that fails review at the first click.

`docs/PRIVACY.md` and `docs/TERMS.md` hold the text those pages must serve. The
owner needs to publish them at stable URLs and put the URLs here before
submission. That is the last outstanding item on this page and it is blocked on
a credential, not on a decision.
