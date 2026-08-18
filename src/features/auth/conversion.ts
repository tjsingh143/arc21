/**
 * Arc 21 — turning a guest into an account.
 *
 * This is the single most dangerous piece of client code in the product, and it
 * is worth being explicit about why.
 *
 * Everything a guest has is stored on a device the player fully controls. The
 * practice bankroll, the accuracy figures, the career stars, the drill streaks —
 * all of it is a number in a local database that anyone with a text editor can
 * change. If any of it could become server state at conversion time, then the
 * entire server-authority model would have a hole in it shaped like a sign-up
 * form: play offline, edit the save, create an account, arrive with a million
 * chips and a perfect competitive record.
 *
 * So the rule is absolute, and it is expressed three ways so that breaking it
 * requires breaking all three:
 *
 *   1. **The plan has no economic field.** There is nowhere in
 *      `GuestConversionPlan` to put chips. A future author who wants to credit
 *      a balance has to add a field, which is a visible change to a reviewed
 *      type, not a one-line assignment hidden in a screen.
 *   2. **Imported history is typed `scope: "practice"` and `competitive:
 *      false`.** Both are literal types with exactly one inhabitant, so no
 *      assignment can widen them.
 *   3. **`assertNoEconomicImport` re-checks the plan at runtime** against an
 *      allowlist of permitted fields, in the same spirit as the engine's
 *      `assertNoHiddenCardLeak`. A refactor that widens the shape fails loudly
 *      instead of leaking quietly.
 *
 * What *does* carry over: preferences, which are personal taste and cost
 * nothing, and practice statistics, which are imported as self-reported
 * practice history and are never comparable with anyone else's.
 *
 * Runtime-neutral and pure. The two types it borrows are type-only imports and
 * are erased at compile time.
 */

import type { PracticeStats } from "../practice/practice-store.js";
import type { AppSettings } from "../settings/settings.js";

/** Deliberately dropped, and named so the omission is visible in the UI. */
export type ConversionDiscard =
  | "LOCAL_BANKROLL"
  | "LOCAL_ACHIEVEMENTS"
  | "LOCAL_CAREER_STARS"
  | "LOCAL_LEADERBOARD_STANDING";

export const CONVERSION_DISCARD_REASONS: Record<ConversionDiscard, string> = {
  LOCAL_BANKROLL:
    "Practice chips stay in Practice. Your account starts with the standard opening grant from the server.",
  LOCAL_ACHIEVEMENTS:
    "Offline achievements stay offline. Competitive rewards are earned on server tables.",
  LOCAL_CAREER_STARS:
    "Career stars earned offline remain on this device; server progression starts fresh.",
  LOCAL_LEADERBOARD_STANDING:
    "Nothing recorded offline can place you on a leaderboard.",
};

/**
 * Practice statistics, imported as practice history and nothing else.
 *
 * `scope` and `competitive` are literal types with one inhabitant each. They
 * exist so that a value of this type cannot be handed to anything expecting
 * competitive statistics without a cast that a reviewer will see.
 */
export interface PracticeHistoryImport {
  readonly scope: "practice";
  readonly competitive: false;
  /** Recorded on a device the player controls, and labelled as such. */
  readonly selfReported: true;

  readonly handsPlayed: number;
  readonly decisions: number;
  readonly correct: number;
  readonly unaidedDecisions: number;
  readonly unaidedCorrect: number;
  readonly hardDecisions: number;
  readonly hardCorrect: number;
  readonly softDecisions: number;
  readonly softCorrect: number;
  readonly pairDecisions: number;
  readonly pairCorrect: number;
}

export interface GuestConversionPlan {
  readonly guestId: string;
  /** ISO 8601. */
  readonly convertedAt: string;
  /** Personal taste. Carried verbatim. */
  readonly preferences: AppSettings;
  /** Null when there is nothing worth importing. */
  readonly practiceHistory: PracticeHistoryImport | null;
  readonly discarded: readonly ConversionDiscard[];
}

export interface GuestConversionInput {
  readonly guestId: string;
  readonly preferences: AppSettings;
  readonly stats: PracticeStats | null;
  readonly now: Date;
}

/**
 * Everything a conversion is allowed to move, and nothing else.
 *
 * Note what is absent: no balance, no delta, no idempotency key, no ledger
 * reason. This function cannot express a chip movement, which is the point —
 * chips move only through `public.apply_wallet_delta`, server-side, and a
 * client-built plan is not an input to it.
 */
export function buildGuestConversionPlan(input: GuestConversionInput): GuestConversionPlan {
  return {
    guestId: input.guestId,
    convertedAt: input.now.toISOString(),
    preferences: { ...input.preferences },
    practiceHistory: input.stats === null ? null : toPracticeHistory(input.stats),
    // Listed on every conversion, whether or not the player had any, so the
    // screen can always say what does not carry over rather than only
    // mentioning it when it happens to be non-zero.
    discarded: [
      "LOCAL_BANKROLL",
      "LOCAL_ACHIEVEMENTS",
      "LOCAL_CAREER_STARS",
      "LOCAL_LEADERBOARD_STANDING",
    ],
  };
}

/**
 * Sanitises before importing.
 *
 * These numbers came from local storage, so they are claims, not facts. They
 * cannot affect chips or standing, but a negative hand count or a "correct"
 * figure larger than the decision count would corrupt every accuracy percentage
 * derived from them — so each is coerced to a non-negative integer and each
 * "correct" tally is clamped to its own denominator.
 *
 * `estimatedEvLost` is deliberately not imported: it is a floating-point figure
 * and nothing that crosses into account-scoped storage needs to be.
 */
function toPracticeHistory(stats: PracticeStats): PracticeHistoryImport {
  const decisions = count(stats.decisions);
  const unaidedDecisions = Math.min(count(stats.unaidedDecisions), decisions);
  const hardDecisions = count(stats.hardDecisions);
  const softDecisions = count(stats.softDecisions);
  const pairDecisions = count(stats.pairDecisions);

  return {
    scope: "practice",
    competitive: false,
    selfReported: true,

    handsPlayed: count(stats.handsPlayed),
    decisions,
    correct: Math.min(count(stats.correct), decisions),
    unaidedDecisions,
    unaidedCorrect: Math.min(count(stats.unaidedCorrect), unaidedDecisions),
    hardDecisions,
    hardCorrect: Math.min(count(stats.hardCorrect), hardDecisions),
    softDecisions,
    softCorrect: Math.min(count(stats.softCorrect), softDecisions),
    pairDecisions,
    pairCorrect: Math.min(count(stats.pairCorrect), pairDecisions),
  };
}

function count(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * The complete set of fields a conversion plan may carry.
 *
 * An allowlist rather than a list of forbidden words. A denylist scanning for
 * "balance", "level" or "xp" reads well in a review and then rejects a
 * perfectly innocent future preference called `musicVolumeLevel`, or misses a
 * field called `openingGift`. Enumerating what is permitted has neither failure
 * mode: anything new is refused until someone deliberately adds it here, which
 * is exactly the review moment this guard exists to force.
 *
 * `preferences` is exempt from key checking — it is device taste, carried
 * verbatim, and writes to the preferences store rather than to anything
 * economic.
 */
const ALLOWED_PLAN_KEYS: ReadonlySet<string> = new Set([
  "guestId",
  "convertedAt",
  "preferences",
  "practiceHistory",
  "discarded",
]);

const ALLOWED_HISTORY_KEYS: ReadonlySet<string> = new Set([
  "scope",
  "competitive",
  "selfReported",
  "handsPlayed",
  "decisions",
  "correct",
  "unaidedDecisions",
  "unaidedCorrect",
  "hardDecisions",
  "hardCorrect",
  "softDecisions",
  "softCorrect",
  "pairDecisions",
  "pairCorrect",
]);

/**
 * Fails loudly if a plan has grown a field that could move money or standing.
 *
 * The counterpart to `assertNoHiddenCardLeak` in the engine, and used the same
 * way: wired into the test suite so widening the shape breaks a test instead of
 * quietly shipping. Cheap enough to call in a development build too.
 */
export function assertNoEconomicImport(plan: GuestConversionPlan): void {
  for (const key of Object.keys(plan)) {
    if (!ALLOWED_PLAN_KEYS.has(key)) {
      throw new Error(
        `Guest conversion plan carries an unexpected field "${key}". Nothing earned ` +
          "offline may create chips, XP or competitive standing; add the field to " +
          "ALLOWED_PLAN_KEYS only if it genuinely cannot.",
      );
    }
  }

  if (plan.practiceHistory === null) return;

  // Belt and braces for the literal types: a cast can defeat the compiler, but
  // not this.
  const history = plan.practiceHistory as unknown as Record<string, unknown>;
  if (history["scope"] !== "practice" || history["competitive"] !== false) {
    throw new Error("Imported guest history must be practice-scoped and non-competitive.");
  }

  for (const [key, value] of Object.entries(history)) {
    if (!ALLOWED_HISTORY_KEYS.has(key)) {
      throw new Error(`Imported guest history carries an unexpected field "${key}".`);
    }
    if (typeof value === "number" && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`Imported guest history field "${key}" must be a non-negative integer.`);
    }
  }
}

/** One line for the conversion screen, listing what does not travel. */
export function describeConversion(plan: GuestConversionPlan): readonly string[] {
  const lines: string[] = [];
  if (plan.practiceHistory === null) {
    lines.push("Your settings carry over to the new account.");
  } else {
    lines.push(
      "Your settings carry over, and your practice statistics are imported as practice history.",
    );
  }
  for (const discard of plan.discarded) lines.push(CONVERSION_DISCARD_REASONS[discard]);
  return lines;
}
