/**
 * The server's clock, on the client's screen.
 *
 * `deadlineAt` has been on every snapshot since the wire contract was written,
 * carrying the comment "Clients render countdowns against server time" — and
 * no client code read it. Nothing rendered a countdown, and, far worse, nothing
 * ever asked the server to RESOLVE an expired one.
 *
 * That second half is the one that mattered. Arc 21 has no long-lived game
 * process: the specification is explicit that a deadline is a stored
 * `deadline_at` and that "when a deadline is visually reached, any connected
 * client may request RESOLVE_TIMEOUT", which the server honours only if its own
 * clock agrees. The single `RESOLVE_TIMEOUT` this app sent was
 * `TableGateway.snapshot()`'s, deliberately pinned to `expectedVersion: 0` so
 * that it can never apply — it is a read dressed as a command. So an absent
 * player froze a shared table for everybody, indefinitely, with the fifteen
 * second timer that exists to prevent exactly that already long expired.
 * Measured against the running stack: at a two-seat private table sixteen
 * seconds past the betting deadline, the client's own poll answered `stale`
 * with the phase unchanged, and the same command at the current version
 * advanced it to PLAYER_TURNS in one round trip.
 *
 * Nothing here decides anything. The countdown is presentation, and the request
 * is a request: the server checks `server_now >= deadline_at` itself and
 * refuses with DEADLINE_NOT_REACHED otherwise, so a device with a fast clock
 * can only ever waste one round trip.
 *
 * Runtime-neutral on purpose — no React, no React Native — so it is testable
 * under Node. See the `src/design` note in CLAUDE.md for why that boundary
 * keeps being drawn.
 */

/**
 * How long a client waits AFTER the deadline before asking.
 *
 * Two devices and a server do not share a clock. Without a grace the fastest
 * client in the room sends a request the server refuses, every render tick, for
 * as long as the skew lasts; with one, the request lands once and the phase
 * moves. It is deliberately short — this is skew tolerance, not a second timer
 * — and it is the client's own courtesy, not a rule: the server would refuse an
 * early request anyway.
 */
export const TIMEOUT_RESOLVE_GRACE_MS = 750;

/** How often the countdown re-renders. One second, because it shows seconds. */
export const COUNTDOWN_TICK_MS = 1_000;

/**
 * How long before the same version may be asked about again.
 *
 * THE MARKER ALONE DEADLOCKS, and it did — on the two-simulator run, visibly.
 * `alreadyAskedForVersion` stops a tick-per-second burst, but an ask that goes
 * unanswered leaves the version exactly where it was, so "already asked at 28"
 * blocks every later attempt at 28 and the table freezes for that client with
 * the deadline permanently expired. The failure was the very one this whole
 * mechanism exists to prevent, reached by the mechanism itself. Caught on the
 * simulator: the local edge runtime saturated (104 CPU soft limits), one ask was
 * lost, and the client sat at "Reconnecting…" on hand 8 with a lapsed clock.
 *
 * So the marker bounds the RATE and never the total. A version that has already
 * been asked about is asked again once this has elapsed — which also covers the
 * other case a marker alone gets wrong: a client whose clock is a couple of
 * seconds fast, refused DEADLINE_NOT_REACHED, must ask again rather than give
 * up on a table it may be the only one watching.
 */
export const TIMEOUT_RETRY_MS = 2_000;

/**
 * Whole seconds left, floored at zero, or `null` when this table has no clock.
 *
 * A solo table, a career node and a practice hand carry no deadline ON PURPOSE
 * — there is nobody else waiting — so `null` here means "no clock", never "out
 * of time", and the caller must render nothing rather than a zero.
 */
export function secondsUntilDeadline(deadlineAt: string | null, now: Date): number | null {
  if (deadlineAt === null) return null;
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline)) return null;
  return Math.max(0, Math.ceil((deadline - now.getTime()) / 1_000));
}

/**
 * Whether this client should ask the server to resolve the expired deadline.
 *
 * `alreadyAskedForVersion` is the whole of the debouncing. A version is the
 * server's own counter and it moves the instant the timeout applies, so asking
 * once per version means asking once per expiry — where a time-based cooldown
 * would need a second clock to be right about.
 *
 * Refused while a command is in flight, and while the connection is silent: a
 * request into silence tells the player nothing, and the poll will discover
 * what happened.
 */
export function shouldRequestTimeoutResolution(params: {
  readonly deadlineAt: string | null;
  readonly version: number;
  readonly now: Date;
  readonly pending: boolean;
  readonly connected: boolean;
  readonly alreadyAskedForVersion: number | null;
  /** `Date.now()` of the last ask, or null if none has been made. */
  readonly lastAskedAt: number | null;
}): boolean {
  if (params.deadlineAt === null) return false;
  if (params.pending || !params.connected) return false;

  // Already asked about THIS version, recently. Bounded by time rather than
  // refused outright: see `TIMEOUT_RETRY_MS` for the deadlock that caused.
  if (
    params.alreadyAskedForVersion === params.version &&
    params.lastAskedAt !== null &&
    params.now.getTime() - params.lastAskedAt < TIMEOUT_RETRY_MS
  ) {
    return false;
  }

  const deadline = Date.parse(params.deadlineAt);
  if (!Number.isFinite(deadline)) return false;
  return params.now.getTime() >= deadline + TIMEOUT_RESOLVE_GRACE_MS;
}

/**
 * Whether the running clock belongs to THIS seat.
 *
 * Pulled out of the table screen because it is a fact about the snapshot, and
 * because it has been wrong twice in ways nothing could assert about a string:
 * once by taking only the phase (the host's screen read "you stand if you do
 * not" while the other seat was being waited on), and once by assuming every
 * unlocked seat owns the betting clock — which stopped being true the moment
 * the Sprint Tournament started betting one seat at a time.
 *
 * `activeSeatId` is null during BETTING_OPEN at an ORDINARY table, where the
 * one clock covers everybody who has not locked; at a sequential table it names
 * the seat whose seven seconds are running. Both are the same question asked of
 * the server's own answer, rather than two rules.
 */
export function deadlineAwaitsSeat(params: {
  readonly phase: string;
  readonly seatId: string;
  readonly activeSeatId: string | null;
  readonly betLocked: boolean;
  readonly sittingOut: boolean;
  readonly canAnswerInsurance: boolean;
}): boolean {
  switch (params.phase) {
    case "BETTING_OPEN":
      if (params.betLocked || params.sittingOut) return false;
      return params.activeSeatId === null || params.activeSeatId === params.seatId;
    case "INSURANCE_OFFER":
      return params.canAnswerInsurance;
    case "PLAYER_TURNS":
      return params.activeSeatId === params.seatId;
    default:
      // HAND_COMPLETE waits on nobody in particular: whoever asks first starts
      // the next round for everyone.
      return true;
  }
}

/**
 * What the countdown says.
 *
 * It names the default as well as the number, because a bare "3" beside a
 * button is a threat and the specification's whole position on timeouts is that
 * they are predictable and stated. The engine's defaults are stand and decline
 * insurance; a betting window that lapses stakes the table minimum, which is
 * the one a player most needs told in advance.
 *
 * `awaitingYou` IS NOT DECORATION. The first version of this took only the
 * phase, and on a two-simulator run the host's screen read
 * "10 seconds to act · you stand if you do not" while the OTHER seat was the one
 * being waited on — a sentence that is wrong twice, since this player has
 * nothing to do and standing is not what will happen to them. Caught by looking
 * at a rendered screen, which is the only thing that could have caught it: every
 * assertion about this string passed. The caller derives the flag from the
 * snapshot — has this seat locked its bet, is its insurance decision pending, is
 * it the active seat — so the copy follows the server's own account of who the
 * clock is for.
 *
 * Returns `null` when there is no clock, so the caller renders nothing.
 */
export function describeDeadline(params: {
  readonly deadlineAt: string | null;
  readonly phase: string;
  readonly now: Date;
  /** Whether THIS seat is the one the deadline is waiting on. */
  readonly awaitingYou: boolean;
}): string | null {
  const seconds = secondsUntilDeadline(params.deadlineAt, params.now);
  if (seconds === null) return null;

  const clock = seconds === 1 ? "1 second" : `${seconds} seconds`;
  switch (params.phase) {
    case "BETTING_OPEN":
      if (seconds === 0) {
        return "Betting closed — the table minimum is staked for anyone yet to bet.";
      }
      return params.awaitingYou
        ? `${clock} to bet · the table minimum is staked if you do not`
        : `${clock} to bet · the table minimum is staked for anyone who has not`;
    case "INSURANCE_OFFER":
      if (seconds === 0) {
        return "Insurance closed — it is declined for anyone who did not answer.";
      }
      return params.awaitingYou
        ? `${clock} to answer · insurance is declined if you do not`
        : `${clock} · insurance is declined for anyone who does not answer`;
    case "PLAYER_TURNS":
      if (seconds === 0) return "Time — the hand stands.";
      return params.awaitingYou
        ? `${clock} to act · you stand if you do not`
        : `${clock} · their hand stands if they do not act`;
    case "HAND_COMPLETE":
      // Nobody in particular is being waited on: the next round starts for
      // everyone, whoever asks for it first.
      return seconds === 0 ? "Dealing the next hand." : `Next hand in ${clock}`;
    default:
      /*
       * Unreachable with today's engine — `cascade` sets a deadline at exactly
       * the four phases above and clears it everywhere else, and
       * `RESOLVE_TIMEOUT` rejects any other phase with WRONG_PHASE. A phase
       * that grows a deadline later renders the clock and NO promise about what
       * happens, rather than a promise copied from a neighbouring case.
       */
      return seconds === 0 ? null : clock;
  }
}
