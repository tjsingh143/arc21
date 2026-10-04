/**
 * Quick Play — the fastest path to an ordinary server-authoritative table.
 *
 * The server half of this has existed and been the most heavily covered path in
 * `tests/server` since the economy shipped: `create-session` handles
 * `action: "OPEN"`, debits the tier's buy-in once through `apply_wallet_delta`,
 * builds the shoe from the CSPRNG and returns the sanitised snapshot. Nothing
 * ever sent it. The Play screen's card had no route because the SCREEN did not
 * exist, and said so.
 *
 * What this store owns is the SELECTION, and remembering it. The specification
 * asks for setup on the first authenticated Quick Play and one-tap afterwards,
 * so the tier and the assistance mode are persisted locally — they are a
 * preference, not a fact about money, and the server re-reads the tier's buy-in
 * from its own table whatever this remembers.
 *
 * ASSISTANCE IS SENT ONCE, AT OPEN. It is recorded on the session row and
 * decides two things the client must not: whether the server sends advice with
 * the snapshot, and whether the session's decisions count towards the qualified
 * accuracy board. A client that could name its assistance per decision could
 * opt a mistake out of its own accuracy.
 */

import { create } from "zustand";
import { playerScopedSetter } from "../player/player-scope.js";

import type { AssistanceMode } from "../../../shared/contracts/index.js";
import type { TierId } from "../matchmaking/matchmaking.js";
import { getSupabase } from "../../lib/supabase/client.js";
import { confirmedSession } from "../../lib/supabase/player-binding.js";
import { sendSessionIntent } from "../../lib/supabase/session-intent.js";
import { isTimedOut, withTimeout } from "../../lib/supabase/with-timeout.js";
import { SqliteKeyValueStore, type KeyValueStore } from "../../lib/persistence/key-value-store.js";
import { useWalletStore } from "../wallet/wallet-store.js";
import { useActiveSessionStore } from "../table/active-session-store.js";

const STORAGE_KEY = "arc21.quickplay.selection.v1";

export interface QuickPlaySelection {
  readonly tier: TierId;
  readonly assistance: AssistanceMode;
}

export const DEFAULT_SELECTION: QuickPlaySelection = { tier: "casual", assistance: "play" };

const UNREACHABLE = "Could not confirm the table. Check your balance and return to any active table below before trying again.";
const SIGNED_OUT = "Connect for Quick Play. Your player identity is created automatically; Practice works offline.";

/** Swapped for an in-memory store in tests, exactly as career persistence is. */
let storage: KeyValueStore | null = null;

export function setQuickPlayStorage(next: KeyValueStore | null): void {
  storage = next;
}

function activeStorage(): KeyValueStore {
  storage ??= new SqliteKeyValueStore();
  return storage;
}

const TIERS: readonly TierId[] = ["casual", "standard", "high"];
const ASSISTANCE: readonly AssistanceMode[] = ["play", "learn", "analysis", "challenge"];

/**
 * Reads a persisted selection, or null.
 *
 * A stored value that is not one of the known ids is DROPPED rather than
 * repaired. The tier decides how many chips leave the wallet; guessing at a
 * corrupted one would be guessing with somebody's money.
 */
export function parseSelection(raw: string | null): QuickPlaySelection | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { tier?: unknown; assistance?: unknown };
    const tier = TIERS.find((candidate) => candidate === parsed.tier);
    const assistance = ASSISTANCE.find((candidate) => candidate === parsed.assistance);
    if (!tier || !assistance) return null;
    return { tier, assistance };
  } catch {
    return null;
  }
}

export interface QuickPlayState {
  /** Null until loaded, and null afterwards if nothing was ever chosen. */
  readonly remembered: QuickPlaySelection | null;
  readonly loaded: boolean;
  readonly opening: boolean;
  readonly notice: string | null;

  load: () => Promise<void>;
  remember: (selection: QuickPlaySelection) => Promise<void>;
  /** Opens the table. Returns the ids the table screen needs, or null. */
  open: (selection: QuickPlaySelection) => Promise<{ gameId: string; seatId: string } | null>;
  clearNotice: () => void;
}

async function bounded<T>(work: PromiseLike<T>): Promise<T | null> {
  const result = await withTimeout(Promise.resolve(work), undefined);
  return isTimedOut(result) ? null : result;
}

export const useQuickPlayStore = create<QuickPlayState>((set, get) => ({
  remembered: null,
  loaded: false,
  opening: false,
  notice: null,

  load: async () => {
    if (get().loaded) return;
    let raw: string | null = null;
    try {
      raw = await activeStorage().get(STORAGE_KEY);
    } catch {
      // Storage that never answers must not leave the screen blank; setup is
      // the correct fallback, because nothing has been proven about a choice.
    }
    set({ remembered: parseSelection(raw), loaded: true });
  },

  remember: async (selection) => {
    set({ remembered: selection });
    try {
      await activeStorage().set(STORAGE_KEY, JSON.stringify(selection));
    } catch {
      // A selection that could not be saved is still the selection for this
      // session. Failing the deal over a preference would be absurd.
    }
  },

  open: async (selection) => {
    const setForPlayer = playerScopedSetter(set);
    if (get().opening) return null;
    const availability = getSupabase();
    if (availability.status !== "ready") {
      setForPlayer({ notice: availability.message });
      return null;
    }

    const session = await bounded(confirmedSession(availability.client));
    if (session === null) {
      setForPlayer({ notice: UNREACHABLE });
      return null;
    }
    if (!session.data.session) {
      setForPlayer({ notice: SIGNED_OUT });
      return null;
    }

    if (!setForPlayer.isCurrent()) return null;
    setForPlayer({ opening: true, notice: null });
    const result = await sendSessionIntent(availability.client, {
      action: "OPEN",
      tier: selection.tier,
      assistance: selection.assistance,
    });
    if (!setForPlayer.isCurrent()) return null;
    setForPlayer({ opening: false });

    if (result.kind === "unknown") {
      setForPlayer({ notice: UNREACHABLE });
      await Promise.all([useWalletStore.getState().refresh(), useActiveSessionStore.getState().refresh()]);
      return null;
    }
    if (result.kind === "rejected") {
      const rejection = result.rejection;
      /*
       * Two refusals deserve their own words, because "could not be opened"
       * sends the player to do the wrong thing in both cases.
       */
      if (rejection?.code === "SESSION_ALREADY_ACTIVE") {
        /*
         * Find out WHERE, and say so.
         *
         * This branch used to end at "leave that table first", which is advice
         * the player could not act on: the game id reached the client once, in
         * the reply to the OPEN that is being refused here, and nothing had
         * persisted it or could ask for it back. A player whose app was killed
         * mid-hand was locked out of every server mode for ever with their
         * buy-in stranded. `my_active_session()` is the ask that was missing.
         */
        void useActiveSessionStore.getState().refresh();
        setForPlayer({
          notice:
            "You are already seated at a table, and your chips are there. Return to it below — nothing has been charged for this one.",
        });
        return null;
      }
      if (rejection?.code === "INSUFFICIENT_STACK") {
        setForPlayer({ notice: "That buy-in is more than your balance. Try a lower tier." });
        return null;
      }
      setForPlayer({ notice: rejection?.message ?? UNREACHABLE });
      return null;
    }

    const data = result.data as { gameId?: unknown; seatId?: unknown } | null;
    if (typeof data?.gameId !== "string" || typeof data.seatId !== "string") {
      setForPlayer({
        notice: "The table opened, but the reply could not be read. Reopen Quick Play.",
      });
      await Promise.all([useWalletStore.getState().refresh(), useActiveSessionStore.getState().refresh()]);
      return null;
    }

    await get().remember(selection);
    // The buy-in has left the wallet. The header caches the balance for the
    // life of the session, so without this it keeps showing the old number.
    void useWalletStore.getState().refresh();
    // And the player now HAS a live seat, so the cached answer to "where are
    // your chips" is out of date the moment this returns.
    void useActiveSessionStore.getState().refresh();
    if (!setForPlayer.isCurrent()) return null;
    return { gameId: data.gameId, seatId: data.seatId };
  },

  clearNotice: () => set({ notice: null }),
}));
