/**
 * Animation durations, without the animation library.
 *
 * Split from `motion.ts` so a plain Node process — `scripts/benchmark.ts`, a
 * unit test — can read the timing budget without importing React Native and
 * Reanimated. Same split, and same reason, as `format-chips.ts` and
 * `type-metrics.ts`. `motion.ts` re-exports these, so components are
 * unaffected.
 */

export const durations = {
  cardDeal: 200,
  cardStagger: 60,
  dealerFlip: 180,
  chipMove: 250,
  buttonPress: 100,
  resultHold: 1_200,
  feedbackHold: 1_600,
} as const;

export type DurationToken = keyof typeof durations;
