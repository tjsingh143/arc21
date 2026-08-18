/**
 * Arc 21 — onboarding content and paging arithmetic.
 *
 * Three pages, no more. An introduction that outlasts the player's patience
 * teaches nothing; the product has to be the argument.
 *
 * Copy and paging maths live here rather than in the screen so both are
 * testable, and so a wording change never means touching layout code.
 */

export type OnboardingPageId = "table" | "strategy" | "together";

export interface OnboardingPage {
  id: OnboardingPageId;
  title: string;
  body: string;
  /**
   * An honest qualifier shown under the body, for a page that describes
   * something this build cannot yet do. Null when the page describes what is
   * already here.
   */
  caveat: string | null;
}

export const ONBOARDING_PAGES: readonly OnboardingPage[] = [
  {
    id: "table",
    title: "Blackjack, without the noise.",
    body: "Play a polished version of classic blackjack.",
    caveat: null,
  },
  {
    id: "strategy",
    title: "Learn every decision.",
    body: "Optional guidance explains Hit, Stand, Double, Split and Surrender.",
    caveat: null,
  },
  {
    id: "together",
    title: "Play together.",
    body: "Join friends, public tables, tournaments and daily challenges.",
    // Stated up front rather than discovered on a dead button later. Every
    // one of these needs a server this build does not have.
    caveat: "Online play needs an account. It is not available in this build yet.",
  },
] as const;

export const ONBOARDING_PAGE_COUNT = ONBOARDING_PAGES.length;

/** Keeps an index inside `[0, count - 1]`, and returns 0 for an empty set. */
export function clampPageIndex(index: number, count: number = ONBOARDING_PAGE_COUNT): number {
  if (!Number.isFinite(index) || count <= 0) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), count - 1);
}

/**
 * Which page a horizontal scroll offset has landed on.
 *
 * Rounds rather than floors so a scroll that stops one pixel short of the
 * boundary — which is normal on a real device — still reports the page the
 * player is actually looking at. A zero or negative page width (a layout pass
 * that has not measured yet) reports page 0 instead of dividing by zero.
 */
export function pageIndexFromOffset(
  offsetX: number,
  pageWidth: number,
  count: number = ONBOARDING_PAGE_COUNT,
): number {
  if (!Number.isFinite(offsetX) || !Number.isFinite(pageWidth) || pageWidth <= 0) return 0;
  return clampPageIndex(Math.round(offsetX / pageWidth), count);
}

/** Left edge of a page, for programmatic paging from the page indicator. */
export function offsetForPageIndex(
  index: number,
  pageWidth: number,
  count: number = ONBOARDING_PAGE_COUNT,
): number {
  if (!Number.isFinite(pageWidth) || pageWidth <= 0) return 0;
  return clampPageIndex(index, count) * pageWidth;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * The disclosure, as separate lines so the screen can weight the first one.
 *
 * This is the text the whole gate exists to put in front of someone, and it is
 * kept here — in a tested module — rather than inline in a component, so that
 * "did we still say it?" is a test rather than a code review.
 */
export const ONBOARDING_DISCLOSURE: readonly string[] = [
  "18+. Virtual chips have no monetary value.",
  "No real-money gambling or cash prizes. Practising here does not improve your chances of winning money anywhere else.",
] as const;

/** The account paths. Neither exists in this build, and both say so. */
export type AccountAction = "create-account" | "sign-in";

export interface AccountOption {
  id: AccountAction;
  label: string;
  /** The route this opens. Real screens, not a message explaining their absence. */
  route: string;
  /** What an account is for, in one line. Shown under the buttons. */
  hint: string;
}

/**
 * The two account routes offered at the end of onboarding.
 *
 * These used to carry an `unavailable` message explaining that Arc 21 had no
 * account service. That was true when it was written and stopped being true
 * three phases later, and nobody came back to it — so onboarding was still
 * telling people accounts did not exist while `app/(auth)/` was signing them in.
 * They are routes now, and the audit flow opens them.
 *
 * Guest play is deliberately still first and still complete. Nothing here is a
 * gate: Practice, the strategy guide and drills never need an account.
 */
export const ACCOUNT_OPTIONS: readonly AccountOption[] = [
  {
    id: "create-account",
    label: "Create Account",
    route: "/(auth)/create-account",
    hint: "Adds a chip balance, career rewards, friends and leaderboards. Practice never needs one.",
  },
  {
    id: "sign-in",
    label: "Sign In",
    route: "/(auth)/sign-in",
    hint: "Signs in to an Arc 21 account you already have.",
  },
] as const;

export function accountOption(id: AccountAction): AccountOption {
  // Non-null assertion avoided: the caller gets a real value or a thrown bug,
  // never `undefined` leaking into a rendered string.
  const option = ACCOUNT_OPTIONS.find((candidate) => candidate.id === id);
  if (option === undefined) throw new Error(`Unknown account option "${id}"`);
  return option;
}
