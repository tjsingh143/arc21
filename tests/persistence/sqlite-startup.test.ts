import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteKeyValueStore } from "../../src/lib/persistence/key-value-store.js";

const openDatabaseAsync = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/persistence/open-sqlite.js", () => ({ openSqliteDatabase: openDatabaseAsync }));

beforeEach(() => {
  openDatabaseAsync.mockReset();
});

describe("independent stores hydrating the same SQLite database", () => {
  it("opens once while settings, guest identity and onboarding start together", async () => {
    const rows = new Map([["settings", "saved-settings"], ["guest", "saved-guest"]]);
    let opening = false;
    openDatabaseAsync.mockImplementation(async () => {
      if (opening) throw new Error("concurrent native database initialization");
      opening = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      opening = false;
      return {
        execAsync: async () => undefined,
        getFirstAsync: async (_sql: string, [key]: string[]) => rows.has(key!) ? { value: rows.get(key!) } : null,
        runAsync: async (_sql: string, [key, value]: string[]) => { rows.set(key!, value!); },
      };
    });
    const settings = new SqliteKeyValueStore();
    const guest = new SqliteKeyValueStore();
    const onboarding = new SqliteKeyValueStore();
    expect(await Promise.all([
      settings.get("settings"), guest.get("guest"), onboarding.set("onboarding", "complete"),
    ])).toEqual(["saved-settings", "saved-guest", undefined]);
    expect(await new SqliteKeyValueStore().get("onboarding")).toBe("complete");
    expect(openDatabaseAsync).toHaveBeenCalledTimes(1);
  });

  it("allows a later read to recover after native initialization rejects", async () => {
    openDatabaseAsync.mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue({ execAsync: async () => undefined, getFirstAsync: async () => ({ value: "persisted" }) });
    const store = new SqliteKeyValueStore("retry.db");
    await expect(store.get("guest")).rejects.toThrow("temporarily unavailable");
    expect(await store.get("guest")).toBe("persisted");
  });
});
