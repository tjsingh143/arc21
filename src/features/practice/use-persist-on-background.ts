/**
 * Flushes the Practice session when the app leaves the foreground.
 *
 * Autosave after every command is fire-and-forget so a disk write never blocks
 * a card from landing. That leaves a narrow window where an app killed
 * immediately after an action dies before its write completes — and the hand the
 * player was in the middle of is the exact thing they would notice losing.
 *
 * Backgrounding is the last moment the app reliably gets before iOS suspends or
 * kills it, so it is where the write is forced to land.
 *
 * Lives in the UI layer because `AppState` comes from react-native, which has no
 * backing in the Node test process that imports the store.
 */

import { useEffect } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { usePracticeStore } from "./practice-store";

export function usePersistOnBackground(): void {
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next: AppStateStatus) => {
      // "inactive" fires on iOS during transitions (app switcher, incoming
      // call) and often precedes a kill, so it is included deliberately.
      if (next === "background" || next === "inactive") {
        void usePracticeStore.getState().flush();
      }
    });

    return () => subscription.remove();
  }, []);
}
