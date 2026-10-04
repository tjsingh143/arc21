import type { StoreApi } from "zustand";

let revision = 0;

/** Invalidate outstanding reads before changing the player shown by the app. */
export function invalidatePlayerScope(): void {
  revision += 1;
}

export function capturePlayerScope(): () => boolean {
  const captured = revision;
  return () => captured === revision;
}

/** A reply for a previous identity must never repopulate its cleared cache. */
export function playerScopedSetter<T>(set: StoreApi<T>["setState"]): StoreApi<T>["setState"] & { isCurrent: () => boolean } {
  const isCurrent = capturePlayerScope();
  const scoped = ((update: T | Partial<T> | ((state: T) => T | Partial<T>), replace?: boolean) => {
    if (!isCurrent()) return;
    if (replace) set(update as T, true);
    else set(update, false);
  }) as StoreApi<T>["setState"];
  return Object.assign(scoped, { isCurrent });
}
