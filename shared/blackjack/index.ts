/**
 * Arc 21 — shared blackjack engine.
 *
 * Runtime-neutral: no React, React Native, Expo or Supabase imports anywhere in
 * this package. The mobile client, the Edge Functions and the test suite all
 * consume this same module, so there is exactly one implementation of the game.
 */

export * from "./types.js";
export * from "./rules.js";
export * from "./cards.js";
export * from "./rng.js";
export * from "./shoe.js";
export * from "./hand-value.js";
export * from "./legal-actions.js";
export * from "./settlement.js";
export * from "./reducer.js";
export * from "./public-state.js";
export * from "./table-closure.js";
