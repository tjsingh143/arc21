# Arc 21 — Code samples

Six implementation boundaries from the published repository. These excerpts show specific code paths; they do not establish deployment readiness or replace the test and release evidence in the README.

Reviewed October 11, 2026. Every code block below is a contiguous, verbatim excerpt from source at commit `059ee0b`. Links pin the exact file and line range. Separate ranges have separate blocks; no code is rewritten or elided inside a block.

The older Drive source copy remains a historical archive. Current source is in the public GitHub repository; these excerpts remain pinned to their stated historical commit.

## 1. Randomness refuses a weak fallback

Construction fails when Web Crypto is unavailable. The source refills an unsigned-integer buffer rather than substituting a weaker generator.

[shared/blackjack/rng.ts, lines 20–42](https://github.com/tjsingh143/arc21/blob/059ee0ba9b848254fecd024daae7e2a60be374aa/shared/blackjack/rng.ts#L20-L42)

```ts
export class CryptoRandomSource implements RandomSource {
  private readonly buffer = new Uint32Array(64);
  private cursor = this.buffer.length;

  constructor() {
    if (typeof globalThis.crypto?.getRandomValues !== "function") {
      throw new Error(
        "No cryptographically secure random source available. Refusing to fall " +
          "back to Math.random() for gameplay. Install a Web Crypto polyfill " +
          "(expo-crypto / react-native-get-random-values) before dealing cards.",
      );
    }
  }

  nextUint32(): number {
    // Refill in blocks; getRandomValues is comparatively expensive per call.
    if (this.cursor >= this.buffer.length) {
      globalThis.crypto.getRandomValues(this.buffer);
      this.cursor = 0;
    }
    return this.buffer[this.cursor++]!;
  }
}
```

## 2. Locking before wallet replay

The wallet row is locked before the idempotency lookup. A committed replay returns its original ledger entry, while reuse across accounts is rejected. The rest of the function applies the ledger and balance update in the same transaction.

[supabase/migrations/20260813120200_wallets.sql, lines 153–200](https://github.com/tjsingh143/arc21/blob/059ee0ba9b848254fecd024daae7e2a60be374aa/supabase/migrations/20260813120200_wallets.sql#L153-L200)

```sql
create or replace function public.apply_wallet_delta(
  p_user_id         uuid,
  p_delta           bigint,
  p_reason          public.ledger_reason,
  p_idempotency_key text,
  p_reference_type  text default null,
  p_reference_id    uuid default null,
  p_metadata        jsonb default '{}'::jsonb
)
returns public.wallet_ledger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wallet    public.wallets;
  v_existing  public.wallet_ledger;
  v_entry     public.wallet_ledger;
begin
  -- Take the wallet lock FIRST. The lock, not the read, is what serialises a
  -- replay: two concurrent callers holding the same idempotency key both miss
  -- the other's uncommitted ledger row under READ COMMITTED, so a replay guard
  -- placed ahead of the lock lets the loser reach the INSERT and raise 23505
  -- instead of returning the first committed result. Blocking on the lock
  -- first means the loser resumes after the winner commits, and the next
  -- statement takes a fresh snapshot that contains the winner's row.
  select * into v_wallet
  from public.wallets
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'no wallet for user %', p_user_id using errcode = 'P0002';
  end if;

  -- Replay of an already-committed command: return the first result unchanged.
  select * into v_existing
  from public.wallet_ledger
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing.user_id <> p_user_id then
      raise exception
        'idempotency key % already belongs to a different account', p_idempotency_key
        using errcode = '23505';
    end if;
    return v_existing;
  end if;
```

## 3. Command replay before session closure

The command path locks engine state, resolves replay, and then checks session closure and the expected version. A stale request receives the authoritative public snapshot without applying its action.

[supabase/functions/game-command/index.ts, lines 363–419](https://github.com/tjsingh143/arc21/blob/059ee0ba9b848254fecd024daae7e2a60be374aa/supabase/functions/game-command/index.ts#L363-L419)

```ts
  // --- The write lock ------------------------------------------------------
  // Taken before anything else is read, exactly as apply_wallet_delta takes the
  // wallet lock before consulting its idempotency key: under READ COMMITTED two
  // concurrent replays would otherwise both miss the other's uncommitted row.
  const locked = await lockEngineState(tx, command.gameId);
  const session = locked ? await loadSession(tx, command.gameId) : null;
  const seat = locked && session ? await findSeat(tx, command.gameId, userId) : null;

  // A caller who is not a participant learns nothing about whether the game
  // exists. Distinguishing the two would let a modified client enumerate live
  // session ids by timing or by response code.
  if (!locked || !session || !seat) {
    await refuseIfHammering(tx, userId, log);
    throw new CommandError("NOT_A_PARTICIPANT", `no seat for ${userId} in ${command.gameId}`);
  }
  log.seatId = seat.id;

  // --- Idempotency ---------------------------------------------------------
  // Deliberately ahead of the "is this seat still live" check: the command that
  // closes a table also ends the seat, so its own retry must still resolve.
  const applied = await findAppliedCommand(tx, command.gameId, command.clientActionId);
  if (applied) {
    if (applied.userId !== userId) {
      // Someone is replaying another account's action id. It is not a hit.
      throw new CommandError("IDEMPOTENCY_CONFLICT", `action ${command.clientActionId} belongs to another account`);
    }
    // Byte-for-byte the first committed result: no recomputation, no second
    // chip movement, no second card.
    return { response: applied.response, outcome: "replayed", stateVersion: applied.appliedVersion };
  }

  if (seat.status === "left" || session.status === "completed" || session.status === "abandoned") {
    await refuseIfHammering(tx, userId, log);
    throw new CommandError("SESSION_CLOSED", `session ${command.gameId} is ${session.status}`);
  }

  const state = locked.state;

  // --- Optimistic concurrency ---------------------------------------------
  // Nothing is applied. The authoritative snapshot goes back so the client can
  // resynchronise and decide for itself whether to retry.
  if (command.expectedVersion !== state.version) {
    return {
      response: {
        status: "stale",
        // Advice travels with the snapshot a resynchronising client reads, or
        // a Learn table would lose its recommendation on every refresh — and
        // the table screen refreshes on a timer.
        publicState: {
          ...sanitise(state),
          advice: adviceFor({ state, seatId: seat.id, assistance: session.assistance }),
        },
      },
      outcome: "stale",
      stateVersion: state.version,
    };
  }
```

## 4. Composition-sensitive expected value

The hit branch weights each available card, temporarily removes it for recursion, restores the count, and memoizes by composition and hand state. This is one branch of the solver; split rules and dealer conditioning are handled elsewhere in the file.

[scripts/strategy-solver.ts, lines 325–362](https://github.com/tjsingh143/arc21/blob/059ee0ba9b848254fecd024daae7e2a60be374aa/scripts/strategy-solver.ts#L325-L362)

```ts
function hitEV(counts: Counts, hardTotal: number, hasAce: boolean, ctx: PlayerContext): number {
  const key = `${compositionKey(counts)}|${hardTotal}|${hasAce ? 1 : 0}`;
  const cached = ctx.hitMemo.get(key);
  if (cached !== undefined) return cached;

  const remaining = totalCards(counts);
  let ev = 0;

  for (const value of VALUES) {
    const available = at(counts, value);
    if (available === 0) continue;
    const p = available / remaining;

    const nextHard = hardTotal + value;
    if (nextHard > 21) {
      ev -= p;
      continue;
    }

    const nextHasAce = hasAce || value === 1;
    const nextBest = bestTotalOf(nextHard, nextHasAce);
    const stand = standEVOf(ctx, nextBest);

    if (nextBest === 21) {
      ev += p * stand;
      continue;
    }

    counts[value] = available - 1;
    const hit = hitEV(counts, nextHard, nextHasAce, ctx);
    counts[value] = available;

    ev += p * Math.max(stand, hit);
  }

  ctx.hitMemo.set(key, ev);
  return ev;
}
```

## 5. Hiding the dealer hole card

The unrevealed hole card is replaced by a placeholder. The displayed total is calculated from the visible cards in the return value that follows this excerpt.

[shared/blackjack/public-state.ts, lines 158–170](https://github.com/tjsingh143/arc21/blob/059ee0ba9b848254fecd024daae7e2a60be374aa/shared/blackjack/public-state.ts#L158-L170)

```ts
  // The hole card is replaced by a placeholder, not merely omitted, so the
  // client can render a face-down card without ever receiving its identity.
  const dealerCards: MaybeHiddenCard[] = state.dealer.cards.map((card, index) => {
    const isHole = index === 1 && rules.dealerHoleCard;
    if (isHole && !state.dealer.holeCardRevealed) {
      return { hidden: true };
    }
    return card;
  });

  const faceUpCards = state.dealer.holeCardRevealed
    ? state.dealer.cards
    : state.dealer.cards.filter((_, index) => !(index === 1 && rules.dealerHoleCard));
```

## 6. Offering a reachable Deal control

The control considers the staged bet and whether the seat may place a bet. This is an interface affordance; the authoritative command path still checks legality.

[src/features/table/betting-affordance.ts, lines 33–50](https://github.com/tjsingh143/arc21/blob/059ee0ba9b848254fecd024daae7e2a60be374aa/src/features/table/betting-affordance.ts#L33-L50)

```ts
export function canDealStagedBet(legal: LegalActionSet, stagedBet: number): boolean {
  if (legal.canLockBet) return true;
  /*
   * The seat may not stake anything right now, so a staged pile is not a bet
   * worth offering to send.
   *
   * This became reachable with the Sprint Tournament, which bets one seat at a
   * time: every seat but the current bettor is answered NO_ACTIONS, and the
   * earlier fallback ("no bounds, so trust whatever is staged") would have
   * offered Deal to all three of them. The engine would have refused it
   * NOT_YOUR_TURN, which is the right answer to the wrong question — a control
   * that can only be refused should not be offered.
   */
  if (!legal.canPlaceBet) return false;
  const bounds = legal.betBounds;
  if (!bounds) return stagedBet > 0;
  return stagedBet >= bounds.min && stagedBet <= bounds.max;
}
```
