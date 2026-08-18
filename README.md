# Arc 21

A simulated blackjack game for iOS and Android — clean, portrait-first, and
mathematically transparent.

> **Arc 21 is a temporary development codename.** It has not been
> trademark-cleared.

> **This is a simulated card game.** Virtual chips have no monetary value. They
> cannot be withdrawn or exchanged for money or prizes. There is no real-money
> gambling, no cash-out, and no in-app purchases.

---

## Status

Engine phase complete. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)
for exactly what is built and what is not.

```
Tests       189 passed (8 files)
Statements  96.99%
Branches    91.94%
Typecheck   clean
```

## Getting started

Requires Node 22+.

```bash
npm install
npm test
npm run typecheck
```

The Expo application has not been initialised yet — `shared/blackjack` is
runtime-neutral and runs standalone under Vitest today.

## Layout

| Path | Contents |
|------|----------|
| `shared/blackjack/` | The authoritative game engine. No host imports. |
| `shared/strategy/` | Generated basic-strategy and EV tables (pending) |
| `app/`, `src/` | Expo Router routes and client implementation (pending) |
| `supabase/` | Migrations, RLS, Edge Functions (pending) |
| `tests/` | Vitest suites and deterministic fixtures |
| `docs/` | Architecture, rules, security, test plan |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — engine, authority boundaries, command model
- [Blackjack rules](docs/BLACKJACK_RULES.md) — Arc Standard, settlement, fairness invariants
- [Security](docs/SECURITY.md) — threat model, RLS, money integrity
- [Test plan](docs/TEST_PLAN.md) — coverage targets and the full matrix
- [Asset licenses](docs/ASSET_LICENSES.md) — original-asset policy

## Core invariants

The engine exists to make these true, and the test suite exists to keep them true:

- One implementation of the rules, shared by client, server and tests.
- Production shuffles use a CSPRNG with unbiased Fisher-Yates. `Math.random()`
  never determines gameplay.
- Cards are never modified in response to wins, losses, purchases, engagement,
  player level or desired drama.
- Clients never receive undealt cards or the unrevealed dealer hole card.
- Chips are integers. No floating-point arithmetic touches a balance.
- The shoe is never reshuffled mid-hand, and a card is never fabricated.
