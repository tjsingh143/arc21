/**
 * Arc 21 — XP and level progression.
 *
 * Runtime-neutral: nothing in this package imports React, React Native, Expo,
 * Supabase or Deno. The client renders a level bar from it, the Edge Function
 * that grants XP decides awards with it, and the test suite exercises it — one
 * curve, one cap, one definition of what a level is. A second implementation of
 * the curve on the server would be a second answer to "what level am I?".
 */

export * from "./types.js";
export * from "./xp.js";
