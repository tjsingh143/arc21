/**
 * AI Tables — sitting down with computer players.
 *
 * What this store owns is the ASK and nothing else. The table itself is a
 * server table like any other: `/table/[gameId]` renders its snapshots and sends
 * the person's commands, and the computer players act on the SERVER, inside
 * those commands. Nothing here predicts, plays or names anything for them — a
 * client that drove a computer seat would be a client that could drive any seat.
 *
 * The request names nothing. How many computer players, where the person sits,
 * the stakes and every seat's stack are the server's, and no chip leaves the
 * wallet: an AI table is a closed economy whose chips are its own.
 *
 * ONE INTENT, ONE REQUEST ID. `sendSessionIntent` retries a lost reply once with
 * the SAME id, and the server answers a player who already holds an AI table
 * with that table, so neither a retry nor a double tap can seat anybody twice.
 */

import { create } from "zustand";

import { getSupabase } from "../../lib/supabase/client.js";
import { confirmedSession } from "../../lib/supabase/player-binding.js";
import { sendSessionIntent } from "../../lib/supabase/session-intent.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import { playerScopedSetter } from "../player/player-scope.js";
import { useActiveSessionStore } from "../table/active-session-store.js";

/** Said when no verdict arrived: the table may or may not exist now. */
export const AI_TABLE_UNREACHABLE =
  "Could not confirm the table. If it opened, it is waiting for you — check below before trying again.";

export const AI_TABLE_SIGNED_OUT =
  "Connect to play at an AI table. Your player identity is created automatically; Practice works offline.";

/**
 * The one refusal worth its own words. "Could not be opened" would send the
 * player to try again, which the server would refuse identically; the table
 * they are already at is the thing to go back to, and the resume card names it.
 */
export const AI_TABLE_ALREADY_SEATED =
  "You are already seated at another table. Return to it below — leave it there before starting an AI table.";

export const AI_TABLE_UNREADABLE =
  "The table opened, but the reply could not be read. Return to it below.";

export interface AiTableOpened {
  readonly gameId: string;
  readonly seatId: string;
  /** True when the server answered with the AI table the player already held. */
  readonly resumed: boolean;
}

export interface AiTableState {
  readonly opening: boolean;
  readonly notice: string | null;
  /** Sits the player down. Returns what the table screen needs, or null. */
  open: () => Promise<AiTableOpened | null>;
  clearNotice: () => void;
}

async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
  const result = await withTimeout(Promise.resolve(work), undefined);
  return isTimedOut(result) ? null : result;
}

/**
 * Reads the ids out of an accepted reply, or null.
 *
 * Only the address is needed here — the table screen reads its own snapshot the
 * moment it opens — so a reply is accepted on its status and two ids rather than
 * failing the whole entry on a detail the next screen will re-read anyway.
 */
export function readAiTableOpened(data: unknown): AiTableOpened | null {
  if (typeof data !== "object" || data === null) return null;
  const reply = data as { status?: unknown; gameId?: unknown; seatId?: unknown; resumed?: unknown };
  if (reply.status !== "ai_table_opened") return null;
  if (typeof reply.gameId !== "string" || typeof reply.seatId !== "string") return null;
  return { gameId: reply.gameId, seatId: reply.seatId, resumed: reply.resumed === true };
}

export const useAiTableStore = create<AiTableState>((set, get) => ({
  opening: false,
  notice: null,

  open: async () => {
    // A reply for a player who has since been replaced must not land on this
    // screen's state for the new one.
    const setForPlayer = playerScopedSetter(set);
    if (get().opening) return null;

    const availability = getSupabase();
    if (availability.status !== "ready") {
      setForPlayer({ notice: availability.message });
      return null;
    }

    const session = await bounded(confirmedSession(availability.client));
    if (session === null) {
      setForPlayer({ notice: AI_TABLE_UNREACHABLE });
      return null;
    }
    if (!session.data.session) {
      setForPlayer({ notice: AI_TABLE_SIGNED_OUT });
      return null;
    }

    if (!setForPlayer.isCurrent()) return null;
    setForPlayer({ opening: true, notice: null });
    const result = await sendSessionIntent(availability.client, { action: "OPEN_AI_TABLE" });
    if (!setForPlayer.isCurrent()) return null;
    setForPlayer({ opening: false });

    if (result.kind === "unknown") {
      // The table may exist. Ask where the player is seated rather than guess,
      // so the resume card can offer it.
      setForPlayer({ notice: AI_TABLE_UNREACHABLE });
      await useActiveSessionStore.getState().refresh();
      return null;
    }

    if (result.kind === "rejected") {
      if (result.rejection.code === "SESSION_ALREADY_ACTIVE") {
        void useActiveSessionStore.getState().refresh();
        setForPlayer({ notice: AI_TABLE_ALREADY_SEATED });
        return null;
      }
      setForPlayer({ notice: result.rejection.message });
      return null;
    }

    const opened = readAiTableOpened(result.data);
    if (opened === null) {
      setForPlayer({ notice: AI_TABLE_UNREADABLE });
      await useActiveSessionStore.getState().refresh();
      return null;
    }

    // The player now HOLDS a seat, so the cached answer to "where are you
    // seated" is out of date the moment this returns.
    void useActiveSessionStore.getState().refresh();
    if (!setForPlayer.isCurrent()) return null;
    return opened;
  },

  clearNotice: () => set({ notice: null }),
}));
