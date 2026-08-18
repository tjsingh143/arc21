/**
 * The onboarding gate's hydration.
 *
 * The load-bearing test here is the last one. A native storage module that
 * fails to initialise returns a promise that never settles — not a rejection,
 * which is already handled — and an unbounded read would leave the app on an
 * empty background with no way forward. That exact failure has happened in this
 * project once already, at the Practice table, which is why the bound is
 * copied from it rather than reinvented.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { MemoryKeyValueStore, type KeyValueStore } from "../../src/lib/persistence/key-value-store.js";
import {
  ONBOARDING_KEY,
  OnboardingFlagStore,
} from "../../src/features/onboarding/onboarding-flag.js";
import {
  ONBOARDING_HYDRATE_TIMEOUT_MS,
  setOnboardingFlagStore,
  useOnboardingStore,
} from "../../src/features/onboarding/onboarding-store.js";
import { decideLaunchDestination } from "../../src/features/onboarding/launch.js";

/** A store that accepts every write and never answers a read. */
const WEDGED: KeyValueStore = {
  get: () => new Promise<string | null>(() => {}),
  set: () => new Promise<void>(() => {}),
  remove: () => new Promise<void>(() => {}),
};

const FAILING: KeyValueStore = {
  get: () => Promise.reject(new Error("storage unavailable")),
  set: () => Promise.reject(new Error("storage unavailable")),
  remove: () => Promise.reject(new Error("storage unavailable")),
};

/** Lets a fire-and-forget write land before the assertion reads it back. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useOnboardingStore.setState({ hydrated: false, completion: null });
  setOnboardingFlagStore(null);
});

describe("hydration", () => {
  it("reports a first launch when nothing is stored", async () => {
    setOnboardingFlagStore(new OnboardingFlagStore(new MemoryKeyValueStore()));

    await useOnboardingStore.getState().hydrate();

    const state = useOnboardingStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.completion).toBeNull();
    expect(decideLaunchDestination(state).kind).toBe("onboarding");
  });

  it("restores a completed flag and goes straight to the app", async () => {
    const store = new MemoryKeyValueStore();
    await new OnboardingFlagStore(store).complete("guest", new Date("2026-08-01T00:00:00.000Z"));
    setOnboardingFlagStore(new OnboardingFlagStore(store));

    await useOnboardingStore.getState().hydrate();

    const state = useOnboardingStore.getState();
    expect(state.completion?.entry).toBe("guest");
    expect(decideLaunchDestination(state).kind).toBe("app");
  });

  it("shows onboarding rather than failing when the stored record is corrupt", async () => {
    const store = new MemoryKeyValueStore();
    await store.set(ONBOARDING_KEY, '{"schemaVersion":1,"garbage":true}');
    setOnboardingFlagStore(new OnboardingFlagStore(store));

    await useOnboardingStore.getState().hydrate();

    const state = useOnboardingStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.completion).toBeNull();
    expect(decideLaunchDestination(state).kind).toBe("onboarding");
  });

  it("shows onboarding when the read rejects", async () => {
    setOnboardingFlagStore(new OnboardingFlagStore(FAILING));

    await expect(useOnboardingStore.getState().hydrate()).resolves.toBeUndefined();

    const state = useOnboardingStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.completion).toBeNull();
  });

  it("falls through instead of hanging when storage never answers", async () => {
    setOnboardingFlagStore(new OnboardingFlagStore(WEDGED));

    const started = Date.now();
    await useOnboardingStore.getState().hydrate();
    const elapsed = Date.now() - started;

    const state = useOnboardingStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.completion).toBeNull();
    // Settled by the bound, not by storage — and the app has somewhere to go.
    expect(decideLaunchDestination(state).kind).toBe("onboarding");
    expect(elapsed).toBeLessThan(ONBOARDING_HYDRATE_TIMEOUT_MS + 1_500);
  });

  it("is idempotent", async () => {
    setOnboardingFlagStore(new OnboardingFlagStore(new MemoryKeyValueStore()));

    await useOnboardingStore.getState().hydrate();
    useOnboardingStore.getState().complete("guest");
    const afterCompletion = useOnboardingStore.getState().completion;

    // A second hydrate must not read the (not yet written) flag back over the
    // completion the player just made, which would bounce them to onboarding.
    await useOnboardingStore.getState().hydrate();

    expect(useOnboardingStore.getState().completion).toBe(afterCompletion);
  });
});

describe("completion", () => {
  it("opens the gate immediately, without waiting on the disk", () => {
    setOnboardingFlagStore(new OnboardingFlagStore(WEDGED));

    useOnboardingStore.getState().complete("guest");

    // The write is still pending — and the player is already through.
    const state = useOnboardingStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.completion?.entry).toBe("guest");
    expect(decideLaunchDestination(state).kind).toBe("app");
  });

  it("persists what it put in memory, byte for byte", async () => {
    const store = new MemoryKeyValueStore();
    setOnboardingFlagStore(new OnboardingFlagStore(store));

    useOnboardingStore.getState().complete("guest");
    await settled();

    const persisted = await new OnboardingFlagStore(store).read();
    expect(persisted).toEqual(useOnboardingStore.getState().completion);
  });

  it("does not throw when the write fails", async () => {
    setOnboardingFlagStore(new OnboardingFlagStore(FAILING));

    expect(() => useOnboardingStore.getState().complete("guest")).not.toThrow();
    await settled();

    expect(useOnboardingStore.getState().completion?.entry).toBe("guest");
  });
});

describe("reset", () => {
  it("replays the introduction on the next launch", async () => {
    const store = new MemoryKeyValueStore();
    setOnboardingFlagStore(new OnboardingFlagStore(store));

    useOnboardingStore.getState().complete("guest");
    await settled();
    await useOnboardingStore.getState().reset();

    expect(useOnboardingStore.getState().completion).toBeNull();
    expect(await store.get(ONBOARDING_KEY)).toBeNull();
  });

  it("clears in memory even when the durable clear fails", async () => {
    setOnboardingFlagStore(new OnboardingFlagStore(FAILING));
    useOnboardingStore.getState().complete("guest");

    await expect(useOnboardingStore.getState().reset()).rejects.toThrow();

    expect(useOnboardingStore.getState().completion).toBeNull();
  });
});
