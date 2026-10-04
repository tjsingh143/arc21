import { playerScopedSetter } from "../player/player-scope.js";
/**
 * Arc 21 — asking the server which table the player is at.
 *
 * One method, and it takes no arguments: `public.my_active_session()` derives
 * the caller from the verified session, so there is no user id to send and no
 * way for a client to ask about anybody else. It returns an ADDRESS — a game id,
 * a seat id and what kind of table it is — and nothing about chips, cards or
 * other players.
 *
 * The store caches the answer so the Play screen and the Quick Play screen can
 * both read it without two round trips, and clears it on sign-out for the same
 * reason the wallet does: no fact about an account may outlive its session.
 */

import { create } from "zustand";

import type { ArcSupabaseClient } from "../../lib/supabase/client.js";
import { confirmedSession } from "../../lib/supabase/player-binding.js";
import { getSupabase } from "../../lib/supabase/client.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import { parseActiveSessionRows, type ActiveSession } from "./active-session.js";

export type ActiveSessionFailureReason = "not-configured" | "signed-out" | "unreachable";

export type ActiveSessionOutcome =
  /** `session` is null when the player holds no live seat. That is not a failure. */
  | { readonly ok: true; readonly session: ActiveSession | null }
  | { readonly ok: false; readonly reason: ActiveSessionFailureReason };

export interface ActiveSessionGateway {
  readonly kind: "supabase" | "unconfigured" | "fake";
  fetch(): Promise<ActiveSessionOutcome>;
}

export function createUnconfiguredActiveSessionGateway(): ActiveSessionGateway {
  return { kind: "unconfigured", fetch: async () => ({ ok: false, reason: "not-configured" }) };
}

export function createSupabaseActiveSessionGateway(
  client: ArcSupabaseClient,
  options: { readonly timeoutMs?: number } = {},
): ActiveSessionGateway {
  const { timeoutMs } = options;

  async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
    const result = await withTimeout(Promise.resolve(work), timeoutMs);
    return isTimedOut(result) ? null : result;
  }

  return {
    kind: "supabase",
    async fetch(): Promise<ActiveSessionOutcome> {
      const session = await bounded(confirmedSession(client));
      if (session === null) return { ok: false, reason: "unreachable" };
      if (!session.data.session) return { ok: false, reason: "signed-out" };

      const result = await bounded(client.rpc("my_active_session"));
      if (result === null) return { ok: false, reason: "unreachable" };
      if (result.error) return { ok: false, reason: "unreachable" };

      return { ok: true, session: parseActiveSessionRows(result.data) };
    },
  };
}

export type ActiveSessionStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  /** The answer. `session` null means there is genuinely no live seat. */
  | { readonly kind: "ready"; readonly session: ActiveSession | null }
  /**
   * The question could not be asked.
   *
   * Deliberately distinct from `ready` with a null session: "you are not at a
   * table" and "we could not find out" are different statements, and offering a
   * fresh buy-in on the strength of the second one is how a player ends up
   * being refused by the server a moment later with no explanation.
   */
  | { readonly kind: "unavailable"; readonly reason: ActiveSessionFailureReason };

export interface ActiveSessionStoreState {
  readonly status: ActiveSessionStatus;
  refresh: () => Promise<ActiveSession | null>;
  clear: () => void;
}

let gatewayOverride: ActiveSessionGateway | null = null;

export function setActiveSessionGateway(next: ActiveSessionGateway | null): void {
  gatewayOverride = next;
}

export function activeSessionGateway(): ActiveSessionGateway {
  if (gatewayOverride !== null) return gatewayOverride;
  const availability = getSupabase();
  if (availability.status !== "ready") return createUnconfiguredActiveSessionGateway();
  return createSupabaseActiveSessionGateway(availability.client);
}

export const useActiveSessionStore = create<ActiveSessionStoreState>((set) => ({
  status: { kind: "idle" },

  refresh: async () => {
    const setForPlayer = playerScopedSetter(set);
    setForPlayer({ status: { kind: "loading" } });

    let outcome: ActiveSessionOutcome;
    try {
      outcome = await activeSessionGateway().fetch();
    } catch {
      setForPlayer({ status: { kind: "unavailable", reason: "unreachable" } });
      return null;
    }

    if (!outcome.ok) {
      setForPlayer({ status: { kind: "unavailable", reason: outcome.reason } });
      return null;
    }

    setForPlayer({ status: { kind: "ready", session: outcome.session } });
    return setForPlayer.isCurrent() ? outcome.session : null;
  },

  clear: () => set({ status: { kind: "idle" } }),
}));

/**
 * The live seat to offer, or null.
 *
 * Derived rather than read from a getter during render: calling a Zustand getter
 * in a render body freezes the value under the React Compiler, which is how the
 * Deal button stayed permanently disabled for a whole phase.
 */
export function selectActiveSession(status: ActiveSessionStatus): ActiveSession | null {
  return status.kind === "ready" ? status.session : null;
}
