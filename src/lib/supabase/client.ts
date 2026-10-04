/**
 * Arc 21 — the Supabase client.
 *
 * One client, created once, from publishable configuration only. Three rules
 * shape this file:
 *
 *   1. **No credentials is a state, not a crash.** A build with no
 *      `EXPO_PUBLIC_SUPABASE_*` values must still open, still deal Practice
 *      hands, and still say plainly that accounts are unavailable. `getSupabase`
 *      therefore returns a discriminated union rather than throwing or returning
 *      a half-built client that fails on first use.
 *   2. **No credentials must not HANG either.** A "not configured" client that
 *      still issues network calls to an empty host produces a spinner that never
 *      resolves, which is a worse failure than an honest message. Nothing here
 *      constructs a client unless the configuration passed validation, and every
 *      call site bounds its request with `withTimeout`.
 *   3. **The session lives in the keychain.** See `secure-session-storage.ts`.
 *
 * Session persistence and refresh are the SDK's job, not ours. We never copy an
 * access token into application state, never persist one ourselves, and never
 * log one.
 */

import { createClient, processLock, type SupabaseClient } from "@supabase/supabase-js";

import {
  describeConfigProblems,
  readEnvConfig,
  type SupabaseConfig,
  type SupabaseConfigProblem,
} from "./config.js";
import { createSecureSessionStorage } from "./secure-session-storage.js";
import { adoptionGatedFetch, manageIdentity } from "./adopted-player.js";
import type { Database } from "./database.types.js";

export type ArcSupabaseClient = SupabaseClient<Database>;

export type SupabaseAvailability =
  | { readonly status: "ready"; readonly client: ArcSupabaseClient }
  | {
      readonly status: "not-configured";
      readonly problems: readonly SupabaseConfigProblem[];
      /** Plain-language copy for the screen that has to explain this. */
      readonly message: string;
    };

let cached: SupabaseAvailability | null = null;
const transientFactories = new WeakMap<ArcSupabaseClient, () => ArcSupabaseClient>();

/** Verification must not replace the current identity before its UUID is checked. */
export function createTransientAuthClient(client: ArcSupabaseClient): ArcSupabaseClient | null {
  return transientFactories.get(client)?.() ?? null;
}

/**
 * The client, or a stated reason there is none.
 *
 * Memoised because `createClient` starts a refresh timer and a storage adapter;
 * building a second one would leave two GoTrue instances racing each other over
 * the same keychain entry — a genuinely nasty bug that shows up as a session
 * that randomly signs itself out.
 */
export function getSupabase(): SupabaseAvailability {
  cached ??= buildAvailability(readEnvConfig());
  return cached;
}

/**
 * The client if one has already been built, without building one. For
 * bookkeeping that must not create the SDK client as a side effect.
 */
export function builtSupabaseClient(): ArcSupabaseClient | null {
  return cached?.status === "ready" ? cached.client : null;
}

/** Convenience for the many call sites that only need the client or null. */
export function supabaseClientOrNull(): ArcSupabaseClient | null {
  const availability = getSupabase();
  return availability.status === "ready" ? availability.client : null;
}

export function isSupabaseConfigured(): boolean {
  return getSupabase().status === "ready";
}

export function buildAvailability(config: SupabaseConfig): SupabaseAvailability {
  if (config.status === "not-configured") {
    return {
      status: "not-configured",
      problems: config.problems,
      message: describeConfigProblems(config.problems),
    };
  }

  // Assigned below; the fetch it is read by runs only after construction.
  let built: ArcSupabaseClient | null = null;
  const client = createClient<Database>(config.url, config.publishableKey, {
    auth: {
      storage: createSecureSessionStorage(),
      persistSession: true,
      autoRefreshToken: true,
      /**
       * There is no browser URL to read a session out of in a React Native app,
       * and leaving this on makes the SDK reach for `window.location`.
       */
      detectSessionInUrl: false,
      /**
       * PKCE rather than the implicit flow, so a password-reset or OAuth
       * redirect cannot be completed by anything that merely observed the link.
       */
      flowType: "pkce",
      /**
       * Serialises token refresh across the concurrent callers a screen can
       * produce. Without it, two simultaneous refreshes can each rotate the
       * refresh token and invalidate the other.
       */
      lock: processLock,
    },
    global: {
      headers: { "x-arc21-client": "expo" },
      /**
       * Nothing account-owned leaves as a credential the app has not adopted:
       * the SDK attaches the session it holds to every request, and a restored
       * one is held before the auth server has said its account exists (B-H1).
       * See `adopted-player.ts`.
       */
      fetch: adoptionGatedFetch(config.url, config.publishableKey, () => built),
    },
  });
  built = client;
  // Subject to the adoption rule from birth — before the auth adapter exists,
  // because a screen's first load can run before the root starts hydration.
  manageIdentity(client);

  transientFactories.set(client, () => createClient<Database>(config.url, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "pkce" },
  }));
  return { status: "ready", client };
}

/**
 * Test seam.
 *
 * Tests never build a real client; they inject an availability value directly so
 * the "not configured" path can be exercised without touching the environment,
 * and so a fake can stand in for the network.
 */
export function setSupabaseAvailabilityForTests(next: SupabaseAvailability | null): void {
  cached = next;
}
