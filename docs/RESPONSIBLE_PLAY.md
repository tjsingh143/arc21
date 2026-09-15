# Responsible play

**This one is different from the other two documents in `docs/`: it is not only
a draft for a page that does not exist yet. It ships.**

The statements below are rendered inside the app, on the Fair Play screen,
under "Playing responsibly". They come from `responsiblePlayStatements()` in
`src/features/settings/fair-play-facts.ts`, and `tests/stats/fair-play.test.ts`
asserts them. This file explains the reasoning; the app is where a player
actually reads it.

That split is deliberate. A responsible-play policy that lives only on a
website is written for the store reviewer. The person who needs it is already
holding the app.

---

## The six statements, and what each one is checked against

| Statement | Claim | Checkable against |
|---|---|---|
| **For adults** | 18+, and the app says so before the first hand | The onboarding disclosure, `src/features/onboarding/pages.ts` |
| **Nothing here is a bet** | No money in, none out, nothing to buy, no prizes | No purchase, cash-out or prize path exists in the codebase |
| **This does not transfer to real money** | Playing well here does not improve real-money outcomes; basic strategy narrows the house edge and never removes it | `NO_PROFIT_CLAIM`, and the EV solver the advice is generated from |
| **Running out costs you nothing** | Below 2,000 chips a Recovery Grant restores the bankroll, once every 12 hours | `RECOVERY_GRANT_THRESHOLD` and `RECOVERY_GRANT_COOLDOWN_MS`, which the copy is generated from rather than transcribed |
| **Nothing here is designed to keep you playing** | No login streak, no consecutive-day bonus, nothing lost by not playing; the one reminder is device-scheduled and has an off switch | No streak mechanic exists in the schema or the client; the reminder toggle is in Settings |
| **If real gambling is causing you harm** | Arc 21 is a simulation, not treatment, not advice, and not affiliated with any support organisation | Deliberately names no service — see below |

---

## Why the last statement names no helpline

The obvious thing to write is a phone number. It is also the wrong thing, for
three reasons:

1. **A number is wrong in most of the world.** Support services are national.
   One number in an app distributed globally is a number that is useless or
   misleading for the majority of the people who read it.
2. **It implies a relationship that does not exist.** Arc 21 has no affiliation
   with any support organisation, has not been endorsed by one, and printing a
   service's number next to the product's own name reads as though it had.
   That is the same class of false claim as "independently audited" — the app
   borrowing credibility it has not earned.
3. **It would go stale silently.** A number that changes is a number nobody in
   this repository would notice had changed, and the failure mode is a person
   in trouble calling a dead line.

So the statement says what is true and points outward: a national support
service is the right place to look, and this app is not one.

`tests/stats/fair-play.test.ts` asserts that this statement contains no URL and
no digit sequence. If somebody adds a number later, that test fails and they
have to make the case for it.

---

## What the product does not do, and why that is the real policy

Responsible-play copy is easy. The design decisions behind it are the part that
matters, and most of them were made in earlier phases for other reasons:

- **There is nothing to buy.** No in-app purchase, no chip packs, no
  subscription, no rewarded video. The commonest harm pattern in a social
  casino game — spending real money to keep playing — has no code path here.
- **Losing costs nothing and is recoverable.** The Recovery Grant means running
  out is a pause, not a wall, and there is no way to pay to skip it.
- **No loss is amplified.** No red flash, no shake, no sting. `tests/audio`
  asserts the loss cue is quieter than the win cue, and only a win gets a halo.
  A game that makes losing loud is a game teaching you to chase.
- **No outcome is ever manipulated.** Cards are never influenced by your
  results, your balance, your level or how long you have played. This is
  absolute invariant 1 and it is the foundation the rest of this rests on: a
  game that tuned its shuffle to keep you playing would make every other
  sentence on this page meaningless.
- **Practice is free of all of it.** No account, no bankroll, no leaderboard,
  no server. If somebody wants to play blackjack without any of the
  competitive machinery, that is a first-class mode, not a demo.
- **The one notification is opt-in, device-scheduled and switchable.**

---

## Store declarations this supports

Both stores ask about simulated gambling and about responsible-gaming
provision. The answers are in `docs/STORE_LISTING.md` under "Age rating
rationale", and they must stay consistent with this page and with the app. All
three currently say the same thing; if one changes, all three change.
