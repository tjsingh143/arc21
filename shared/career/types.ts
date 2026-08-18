/**
 * Arc 21 — career vocabulary.
 *
 * Runtime-neutral: this module must never import React, React Native, Expo,
 * Supabase or any other host-specific package. The same definitions are read by
 * the mobile client, by the future server-authoritative reward path, and by the
 * test suite, so there is exactly one description of what a career node is.
 *
 * Two properties are load-bearing and are asserted in `tests/career/`:
 *
 *   - Thresholds are **integer percentages**, never floats. Star evaluation
 *     compares `correct * 100 >= percent * decisions`, which is exact at the
 *     boundary; `correct / decisions >= 0.85` is not.
 *   - A node declares either a hand count (standard) or a decision count
 *     (drill), never both and never neither.
 */

/** The three MVP chapters, in route order. */
export type CareerChapterId = "foundations" | "workshop" | "skyline";

/**
 * How a node produces its decisions.
 *
 *   standard  a real session dealt from a normal, fairly shuffled shoe
 *   drill     constructed scenarios chosen to exercise one decision family
 *
 * The distinction is user-facing and must stay that way: a drill is not an
 * organically shuffled casino hand, and the product never implies it is.
 */
export type CareerNodeFormat = "standard" | "drill";

/**
 * Mirrors the Practice table's assistance modes. Redeclared here rather than
 * imported because `src/features/practice/practice-store.ts` is a Zustand
 * module and `shared/` may not depend on the client. The two unions are
 * structurally identical and a test asserts they stay that way.
 */
export type CareerAssistanceMode = "play" | "learn" | "analysis" | "challenge";

/** Which decision family a drill node draws its scenarios from. */
export type DrillFocus = "double" | "pair" | "surrender" | "soft" | "split" | "mixed";

/**
 * Which decisions count toward the accuracy star.
 *
 *   all       every graded decision, including ones made with the recommended
 *             play already on screen (Learn / Analysis)
 *   unaided   only decisions made without the answer visible
 *
 * A "correct" choice made while reading the recommendation measures nothing
 * about the player, so any node that withholds the answer grades on `unaided`.
 */
export type AccuracyBasis = "all" | "unaided";

/**
 * The third star's target.
 *
 *   finish_bankroll  end the session with at least `percentOfStart`% of the
 *                    bankroll it began with. Integer chips: the requirement is
 *                    `ceil(start * percent / 100)`.
 *   accuracy         a higher accuracy bar than the second star (drills, which
 *                    have no bankroll)
 *   ev_lost          total estimated expectation given up across the session,
 *                    in units of the original wager, at or below the threshold
 */
export type MasteryObjective =
  | { readonly kind: "finish_bankroll"; readonly percentOfStart: number }
  | { readonly kind: "accuracy"; readonly percent: number }
  | { readonly kind: "ev_lost"; readonly maxEvLost: number };

/**
 * A first-completion reward.
 *
 * These are **declared, not credited**. The global wallet and XP are
 * server-authoritative (see docs/ARCHITECTURE.md), and no server path exists
 * yet, so a locally completed node marks its reward as owed and awards nothing.
 * Crediting chips from a client that a modified client could also credit is
 * exactly the thing the security model forbids.
 */
export interface CareerReward {
  readonly chips: number;
  readonly xp: number;
}

export interface CareerChapter {
  readonly id: CareerChapterId;
  readonly order: number;
  readonly title: string;
  readonly subtitle: string;
}

export interface CareerNode {
  /** Short stable identifier, e.g. "F1". Used in logs and tests. */
  readonly id: string;
  /** URL segment for `/career/[slug]`. */
  readonly slug: string;
  readonly chapter: CareerChapterId;
  /** Position within the chapter, 1-based. */
  readonly order: number;
  readonly title: string;
  /** One plain line describing what the node asks of the player. */
  readonly summary: string;

  readonly format: CareerNodeFormat;
  /** Hands to play. Non-null exactly when `format` is `"standard"`. */
  readonly hands: number | null;
  /** Decisions to answer. Non-null exactly when `format` is `"drill"`. */
  readonly decisions: number | null;
  /** Non-null exactly when `format` is `"drill"`. */
  readonly drillFocus: DrillFocus | null;

  readonly assistance: CareerAssistanceMode;
  readonly accuracyBasis: AccuracyBasis;

  /** Chips the session starts with. Session-local; never the global wallet. */
  readonly startingBankroll: number;
  /**
   * Wager ceiling as a percentage of the starting bankroll, or null for the
   * table maximum. Only "Controlled Risk" constrains it today.
   */
  readonly maxWagerPercentOfStart: number | null;

  /** Second star: strategy accuracy, as an integer percentage. */
  readonly accuracyStarPercent: number;
  /** Third star. */
  readonly mastery: MasteryObjective;

  readonly reward: CareerReward;
  /** Slug of the node that must earn at least one star first. */
  readonly prerequisiteSlug: string | null;
}
