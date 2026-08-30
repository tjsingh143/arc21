# Privacy policy — draft

**Status: draft, unpublished.** This is the text the privacy-policy page must
serve. Apple requires a reachable privacy-policy URL and Google Play requires a
Data safety declaration that agrees with it; no domain or hosting exists for
this project, so neither is live. See `docs/RELEASE.md`.

**Last reviewed:** 2026-08-22, against the schema in `supabase/migrations/` and
the client code in `src/`. It describes what the code actually does, not a
template. If it ever disagrees with the code, the code is right and this is a
bug.

---

## The short version

Arc 21 collects an email address so you can have an account, and stores the
results of the games you play on our server so that statistics, leaderboards
and multiplayer work. That is all. There is no advertising, no analytics
provider, no tracking across other apps or sites, and nothing is sold or shared
with anyone.

You can play without an account at all. Practice, the strategy guide and the
drills run entirely on your device and never touch the server.

---

## What is collected, and why

### If you never create an account

**Nothing leaves your device.** Practice hands, drill history, your practice
bankroll, career progress and settings are stored locally with `expo-sqlite`
and `expo-secure-store`. No request is made to any server. Deleting the app
deletes all of it.

### If you create an account

| Data | Where it comes from | Why it exists |
|---|---|---|
| Email address | You type it | It is the account identifier and the only way to reset a password. Held by Supabase Auth. |
| Password | You type it | Stored only as a salted hash by Supabase Auth. Arc 21's own code never stores, logs or transmits the plaintext — the sign-in screen holds it in component state and nowhere else. |
| Username, display name | You choose them | Shown to other players on leaderboards, friend lists and at a table. |
| Bio (optional, ≤160 characters) | You type it | Shown on your profile. |
| Country code (optional) | You choose it | Regional leaderboards. |
| Avatar and cosmetic selection | You choose them | Shown to other players. |
| Gameplay records | Generated as you play | Hands, decisions, wagers, outcomes, XP, career progress, tournament and daily-challenge entries. These are what statistics, leaderboards, progression and anti-cheat are computed from. |
| Virtual chip balance and ledger | Generated as you play | An append-only record of every chip movement. It is the record from which a balance can be rebuilt, which is why it is never deleted piecemeal. |
| Friend relationships and blocks | You create them | The social features. |
| Push token and an optional device identifier | Your device, only if you grant notification permission | To deliver a notification you asked for. Removed when you turn notifications off. |
| Timestamps: account creation, last seen, last username change | Generated | Ordinary account housekeeping. The username timestamp exists to enforce the rename rate limit. |

Nothing else. In particular Arc 21 does **not** collect: your name, address,
phone number, contacts, precise or coarse location, advertising identifier,
photos, microphone or camera input, health data, or any biometric.

---

## What is not done

- **No advertising.** No ad SDK is present in the app.
- **No analytics provider.** None is configured. There is no Firebase, no
  Amplitude, no Segment, no Sentry, no crash reporter.
- **No tracking.** Nothing follows you to another app or website, and no
  advertising identifier is read. Arc 21 does not need App Tracking
  Transparency permission because there is nothing to ask about.
- **No sale or sharing of data.** Not to anyone, for any purpose, ever. There
  is no third party to sell it to: the only processor is the database host.
- **No profiling for advertising**, and no automated decision-making with a
  legal or similarly significant effect.
- **No sensitive-category data** is collected at all.

---

## Who can see what

- **Public by default on a profile:** username, display name, avatar, level, and
  the statistics that feed leaderboards. A profile privacy setting controls
  this.
- **Never visible to other players:** your email address, your password, your
  push token, your device identifier, your practice data, and the raw ledger.
- **Never visible to anyone, including you, while a game is live:** the
  undealt shoe and the dealer's hole card. These are held in a separate
  database schema no client role can read, and the only thing that ever builds
  a client payload strips them. That is a fairness measure, described in the
  Fair Play screen and in `docs/SECURITY.md`.

---

## Where it is stored, and who processes it

Gameplay data and account data are stored in a PostgreSQL database hosted by
**Supabase**, which is the only third-party processor. Supabase provides
authentication, the database and the push-delivery relay. Push notifications
are delivered through **Expo's push service**, which forwards to Apple (APNs)
and Google (FCM); those messages carry a title, a body and deep-link parameters
only — a database constraint restricts the payload to a fixed set of keys
holding short scalars, so nothing else can ride out in one even by accident.

The hosting region is chosen when the project is created and is not yet fixed.
**This section must be completed with the actual region before publication.**

---

## How long it is kept

- Account data and gameplay records: until you delete the account.
- Push tokens: until you turn notifications off or the token stops working.
- Rate-limit records: they age out of a rolling window measured in minutes,
  hours or, for one limit, thirty days.
- Local practice data: until you delete the app. Settings → Reset practice
  statistics clears accuracy, hands played and decision history on the device;
  it deliberately leaves your practice chips and any hand in progress alone.

---

## Deleting your account

Settings → Delete account. This is a real deletion, not a flag: it calls
`delete_own_account()`, which removes the account row, and every table that
holds your data references it with `on delete cascade`. Your profile,
statistics, ledger, friendships, tournament entries, cosmetics and push tokens
go with it.

**It refuses while you still hold a seat at a running table**, and says so.
Deleting an account mid-hand would strand the other players at that table and
leave chips in escrow with no owner, so leave the table first. This is the only
condition under which deletion is declined. Having *previously* played at a
table that is still running is not a reason: once you have stood up, your seat
is settled and deletion proceeds.

**If you host a table, it is handed over rather than closed.** The longest-seated
player becomes the host, exactly as it would if you had simply left. A table is
only closed when nobody else is sitting at it.

Two consequences worth stating plainly, because they are not reversible:

- **A deleted account cannot be recovered**, and neither can the chips,
  progress or record attached to it.
- **Rows that describe a shared event may survive in an anonymised form** where
  another player's record depends on them — a completed tournament's result, or
  a hand another player also played. They no longer identify you: the seat you
  sat in keeps its cards and its outcome, and its name becomes "Deleted
  player". Notifications other players are holding *about* you — a friend
  request, a table invite — are deleted outright rather than anonymised,
  because each one names you and points at a profile that no longer exists.

Local practice data is on your device and is not touched by account deletion;
deleting the app removes it.

---

## Your rights

Depending on where you live you may have the right to access, correct, export
or erase your data, and to object to processing. Deletion is available in the
app, immediately, with no request needed. For anything else, use the support
contact on the store listing.

**The support contact does not exist yet.** It is blocked on the same missing
credential as everything else on this page and must be filled in before
publication.

---

## Children

Arc 21 is for adults: 18 and over. It is not directed at children, and it is
not distributed through any children's programme on either store. The app
states its age requirement before the first hand is dealt.

---

## Changes

If this policy changes in a way that affects what is collected, the app will
say so in-app rather than only editing this page quietly.

---

## Before this can be published

| Item | Needs |
|---|---|
| A URL that serves this text | A domain and hosting |
| The hosting region | A Supabase cloud project |
| A support email or page | The owner's decision, plus somewhere to host it |
| Data safety form on Play | A Play Console account |
| Privacy nutrition labels on Apple | An App Store Connect account |

The nutrition labels and the Data safety form must be filled in from **this
document**, not written independently. Two descriptions of the same behaviour
drift, and the one nobody reads is the one that becomes wrong.
