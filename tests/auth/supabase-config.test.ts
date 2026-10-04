/**
 * Supabase configuration and session storage.
 *
 * The first half of this file guards a shipping accident: anything in an
 * `EXPO_PUBLIC_*` variable is compiled into the app bundle and is public, so a
 * service-role key placed there would hand every attacker a key that bypasses
 * Row Level Security entirely. The check refuses to start rather than starting
 * insecurely — the app degrades to "offline only", which is recoverable, instead
 * of shipping a root credential, which is not.
 *
 * The second half covers the 2 KB SecureStore limit. A Supabase session exceeds
 * it once user metadata is populated, and getting the chunking wrong produces a
 * bug that only appears for *some* accounts, only after a restart.
 */

import { describe, expect, it } from "vitest";

import {
  describeConfigProblems,
  looksLikeServerSecret,
  readSupabaseConfig,
} from "../../src/lib/supabase/config.js";
import {
  ChunkedSecureSessionStorage,
  CHUNK_SIZE,
  type SecureStoreLike,
  type SessionStorageDurability,
} from "../../src/lib/supabase/secure-session-storage.js";

/** A syntactically valid unsigned JWT carrying the given claims. */
function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

const ANON_KEY = jwt({ iss: "supabase", ref: "abcdefghijklmnop", role: "anon", exp: 2000000000 });
const SERVICE_KEY = jwt({
  iss: "supabase",
  ref: "abcdefghijklmnop",
  role: "service_role",
  exp: 2000000000,
});

describe("configuration", () => {
  it("accepts a publishable key and an https URL", () => {
    const config = readSupabaseConfig({
      EXPO_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON_KEY,
    });

    expect(config.status).toBe("configured");
  });

  it("accepts the local stack over plain HTTP", () => {
    // 127.0.0.1 has no network path to intercept, and refusing it would make
    // local development impossible.
    const config = readSupabaseConfig({
      EXPO_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON_KEY,
    });

    expect(config.status).toBe("configured");
  });

  it("strips a trailing slash so URLs do not double up", () => {
    const config = readSupabaseConfig({
      EXPO_PUBLIC_SUPABASE_URL: "https://x.supabase.co/",
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON_KEY,
    });

    expect(config).toMatchObject({ status: "configured", url: "https://x.supabase.co" });
  });

  it("reports missing values rather than throwing", () => {
    const config = readSupabaseConfig({});

    expect(config).toMatchObject({ status: "not-configured" });
    if (config.status === "not-configured") {
      expect([...config.problems].sort()).toEqual(["MISSING_KEY", "MISSING_URL"]);
    }
  });

  it("treats blank strings as missing", () => {
    const config = readSupabaseConfig({
      EXPO_PUBLIC_SUPABASE_URL: "   ",
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
    });

    expect(config.status).toBe("not-configured");
  });

  it("rejects an unusable URL", () => {
    const config = readSupabaseConfig({
      EXPO_PUBLIC_SUPABASE_URL: "supabase.co",
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON_KEY,
    });

    expect(config).toMatchObject({ status: "not-configured" });
    if (config.status === "not-configured") expect(config.problems).toContain("INVALID_URL");
  });

  it("rejects plain HTTP to a remote host", () => {
    // A bearer token over plain HTTP is a session handed to anyone on the path.
    const config = readSupabaseConfig({
      EXPO_PUBLIC_SUPABASE_URL: "http://abcdefghijklmnop.supabase.co",
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON_KEY,
    });

    expect(config).toMatchObject({ status: "not-configured" });
    if (config.status === "not-configured") expect(config.problems).toContain("INSECURE_URL");
  });
});

describe("refusing a server secret in the client bundle", () => {
  it("refuses a legacy service_role JWT", () => {
    const config = readSupabaseConfig({
      EXPO_PUBLIC_SUPABASE_URL: "https://x.supabase.co",
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: SERVICE_KEY,
    });

    expect(config).toMatchObject({ status: "not-configured" });
    if (config.status === "not-configured") {
      expect(config.problems).toContain("SERVER_SECRET_IN_CLIENT_BUNDLE");
    }
  });

  it.each([
    "sb_secret_abcdef0123456789",
    "sbp_0123456789abcdef0123456789abcdef01234567",
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  ])("refuses %s", (key) => {
    expect(looksLikeServerSecret(key)).toBe(true);
  });

  it("allows an anon key and a modern publishable key", () => {
    expect(looksLikeServerSecret(ANON_KEY)).toBe(false);
    expect(looksLikeServerSecret("sb_publishable_abcdef0123456789")).toBe(false);
  });

  it("does not mistake an arbitrary opaque string for a secret", () => {
    expect(looksLikeServerSecret("not-a-jwt-at-all")).toBe(false);
  });

  it("explains itself without printing the key", () => {
    const message = describeConfigProblems(["SERVER_SECRET_IN_CLIENT_BUNDLE"]);

    expect(message).toContain("server secret");
    expect(message).not.toContain(SERVICE_KEY);
  });

  it("has honest wording for a plain missing configuration", () => {
    expect(describeConfigProblems(["MISSING_URL", "MISSING_KEY"])).toContain(
      "no server configured",
    );
  });
});

/** An in-memory stand-in for the platform keychain. */
function fakeSecureStore(): SecureStoreLike & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    async getItemAsync(key) {
      return entries.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      entries.set(key, value);
    },
    async deleteItemAsync(key) {
      entries.delete(key);
    },
  };
}

describe("chunked secure session storage", () => {
  it("round-trips a short value in one key", async () => {
    const backend = fakeSecureStore();
    const storage = new ChunkedSecureSessionStorage(backend);

    await storage.setItem("sb-auth-token", "short");

    expect(await storage.getItem("sb-auth-token")).toBe("short");
    expect(backend.entries.size).toBe(1);
  });

  it("round-trips a session larger than the platform limit", async () => {
    const backend = fakeSecureStore();
    const storage = new ChunkedSecureSessionStorage(backend);
    const session = JSON.stringify({ access_token: "a".repeat(4_000), user: { id: "u" } });

    await storage.setItem("sb-auth-token", session);

    expect(session.length).toBeGreaterThan(CHUNK_SIZE);
    expect(backend.entries.size).toBeGreaterThan(1);
    expect(await storage.getItem("sb-auth-token")).toBe(session);
  });

  it("leaves no orphan chunks when a long value is replaced by a short one", async () => {
    const backend = fakeSecureStore();
    const storage = new ChunkedSecureSessionStorage(backend);

    await storage.setItem("k", "x".repeat(5_000));
    await storage.setItem("k", "small");

    expect(await storage.getItem("k")).toBe("small");
    expect(backend.entries.size).toBe(1);
  });

  it("reports a missing chunk as no session rather than truncated JSON", async () => {
    const backend = fakeSecureStore();
    const storage = new ChunkedSecureSessionStorage(backend);
    await storage.setItem("k", "y".repeat(5_000));

    backend.entries.delete("k.v2.0.1");

    // Half a session is not a session. GoTrue would throw on the parse.
    expect(await storage.getItem("k")).toBeNull();
  });

  it("removes every chunk on sign-out", async () => {
    const backend = fakeSecureStore();
    const storage = new ChunkedSecureSessionStorage(backend);
    await storage.setItem("k", "z".repeat(5_000));

    await storage.removeItem("k");

    expect(backend.entries.size).toBe(0);
    expect(await storage.getItem("k")).toBeNull();
  });

  it("never throws when the keychain fails", async () => {
    const broken: SecureStoreLike = {
      getItemAsync: () => Promise.reject(new Error("keychain locked")),
      setItemAsync: () => Promise.reject(new Error("keychain locked")),
      deleteItemAsync: () => Promise.reject(new Error("keychain locked")),
    };
    const storage = new ChunkedSecureSessionStorage(broken);

    // A throwing storage adapter wedges GoTrue's initialisation, which is a far
    // worse outcome than losing a persisted session.
    await expect(storage.setItem("k", "v")).resolves.toBeUndefined();
    await expect(storage.getItem("k")).resolves.toBeNull();
    await expect(storage.removeItem("k")).resolves.toBeUndefined();
  });

  it("reads existing v1/plain sessions and removes legacy chunks only after migration commits", async () => {
    const backend = fakeSecureStore();
    backend.entries.set("plain", "old plaintext representation inside the keychain");
    const previous = "old-session".repeat(200);
    backend.entries.set("k", `arc21.chunked.v1:${Math.ceil(previous.length / CHUNK_SIZE)}`);
    for (let offset = 0; offset < previous.length; offset += CHUNK_SIZE) {
      backend.entries.set(`k.${offset / CHUNK_SIZE}`, previous.slice(offset, offset + CHUNK_SIZE));
    }
    const storage = new ChunkedSecureSessionStorage(backend);
    expect(await storage.getItem("plain")).toBe(backend.entries.get("plain"));
    expect(await storage.getItem("k")).toBe(previous);

    await storage.setItem("k", "new-session".repeat(200));
    expect(await new ChunkedSecureSessionStorage(backend).getItem("k")).toBe("new-session".repeat(200));
    expect([...backend.entries.keys()].some((key) => /^k\.\d+$/.test(key))).toBe(false);
    expect(backend.entries.has("k.v2.legacy")).toBe(false);
  });

  it.each([
    ["v2", "old".repeat(700), "new".repeat(900)],
    ["v1", "legacy".repeat(350), "replacement".repeat(250)],
    ["plain", "old-short", "new".repeat(900)],
    ["v2", "old".repeat(700), "new-short"],
  ])("restores a complete value after a crash at every mutation boundary (%s)", async (format, previous, next) => {
    const initial = fakeSecureStore();
    if (format === "v1") {
      initial.entries.set("k", `arc21.chunked.v1:${Math.ceil(previous.length / CHUNK_SIZE)}`);
      for (let offset = 0; offset < previous.length; offset += CHUNK_SIZE) {
        initial.entries.set(`k.${offset / CHUNK_SIZE}`, previous.slice(offset, offset + CHUNK_SIZE));
      }
    } else {
      await new ChunkedSecureSessionStorage(initial).setItem("k", previous);
    }
    const before = new Map(initial.entries);

    // Count the actual native mutation boundaries, then kill the fake process
    // before and after each one. Once killed, every later operation fails too:
    // catch/cleanup cannot accidentally make the simulated crash recoverable.
    let mutations = 0;
    const counter: SecureStoreLike = {
      ...initial,
      setItemAsync: async (key, value) => { mutations += 1; initial.entries.set(key, value); },
      deleteItemAsync: async (key) => { mutations += 1; initial.entries.delete(key); },
    };
    await new ChunkedSecureSessionStorage(counter).setItem("k", next);

    for (let boundary = 0; boundary <= mutations; boundary += 1) {
      const backend = fakeSecureStore();
      for (const [key, value] of before) backend.entries.set(key, value);
      let writes = 0;
      const crash = (): void => {
        if (writes >= boundary) throw new Error("simulated process termination");
      };
      const interrupted: SecureStoreLike = {
        getItemAsync: async (key) => { crash(); return backend.entries.get(key) ?? null; },
        setItemAsync: async (key, value) => { crash(); backend.entries.set(key, value); writes += 1; crash(); },
        deleteItemAsync: async (key) => { crash(); backend.entries.delete(key); writes += 1; crash(); },
      };
      await new ChunkedSecureSessionStorage(interrupted).setItem("k", next);

      const restarted = new ChunkedSecureSessionStorage(backend);
      const restored = await restarted.getItem("k");
      const committed = backend.entries.get("k") !== before.get("k");
      expect(restored, `crash boundary ${boundary}`).toBe(committed ? next : previous);

      // A later complete replacement must retire both abandoned generations
      // and a legacy migration's inventory. No token chunks accumulate.
      await restarted.setItem("k", "finished");
      expect([...backend.entries], `cleanup after boundary ${boundary}`).toEqual([["k", "finished"]]);
    }
  });

  it("preserves the committed credential when a replacement exceeds the bounded size", async () => {
    const backend = fakeSecureStore();
    const states: SessionStorageDurability[] = [];
    const storage = new ChunkedSecureSessionStorage(backend, {}, (_key, state) => states.push(state));
    const previous = "saved".repeat(400);
    await storage.setItem("k", previous);
    const before = new Map(backend.entries);

    await storage.setItem("k", "x".repeat(CHUNK_SIZE * 48 + 1));
    expect(backend.entries).toEqual(before);
    expect(states.at(-1)).toBe("unavailable");
    expect(await storage.getItem("k")).toBe(previous);
    // Reading the old credential is not evidence the rotated replacement was
    // saved. The warning must survive that read.
    expect(states.at(-1)).toBe("unavailable");
    await storage.setItem("k", "saved replacement");
    expect(states.at(-1)).toBe("durable");
  });

  it("reports an interrupted replacement without treating post-commit cleanup failure as lost durability", async () => {
    const backend = fakeSecureStore();
    const states: SessionStorageDurability[] = [];
    let failSet = false;
    let failDelete = false;
    const fallible: SecureStoreLike = {
      ...backend,
      setItemAsync: async (key, value) => {
        if (failSet) throw new Error("keychain unavailable");
        backend.entries.set(key, value);
      },
      deleteItemAsync: async (key) => {
        if (failDelete) throw new Error("cleanup unavailable");
        backend.entries.delete(key);
      },
    };
    const storage = new ChunkedSecureSessionStorage(fallible, {}, (_key, state) => states.push(state));
    await storage.setItem("k", "old".repeat(700));
    failSet = true;
    await storage.setItem("k", "next".repeat(700));
    expect(states.at(-1)).toBe("unavailable");
    expect(await storage.getItem("k")).toBe("old".repeat(700));
    expect(states.at(-1)).toBe("unavailable");

    failSet = false;
    failDelete = true;
    await storage.setItem("k", "next".repeat(700));
    expect(states.at(-1)).toBe("durable");
    expect(await new ChunkedSecureSessionStorage(backend).getItem("k")).toBe("next".repeat(700));
  });

  it("serializes replacements, reads and removal across adapters sharing a backend", async () => {
    const backend = fakeSecureStore();
    let release!: () => void;
    let writing!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { writing = resolve; });
    let blockOnce = true;
    const delayed: SecureStoreLike = {
      ...backend,
      setItemAsync: async (key, value) => {
        if (blockOnce) {
          blockOnce = false;
          writing();
          await blocked;
        }
        backend.entries.set(key, value);
      },
    };
    const first = new ChunkedSecureSessionStorage(delayed);
    const second = new ChunkedSecureSessionStorage(delayed);
    const replacement = first.setItem("k", "first".repeat(400));
    await entered;
    const read = second.getItem("k");
    const newer = second.setItem("k", "second".repeat(400));
    const remove = first.removeItem("k");
    release();

    await Promise.all([replacement, newer, remove]);
    expect(await read).toBe("first".repeat(400));
    expect(await first.getItem("k")).toBeNull();
    expect(backend.entries.size).toBe(0);
  });

  it("commits sign-out before deleting chunks, even if cleanup fails", async () => {
    const backend = fakeSecureStore();
    await new ChunkedSecureSessionStorage(backend).setItem("k", "credential".repeat(300));
    const interrupted: SecureStoreLike = {
      ...backend,
      deleteItemAsync: async (key) => {
        if (key !== "k") throw new Error("process died during cleanup");
        backend.entries.delete(key);
      },
    };
    await new ChunkedSecureSessionStorage(interrupted).removeItem("k");
    expect(await new ChunkedSecureSessionStorage(backend).getItem("k")).toBeNull();
    await new ChunkedSecureSessionStorage(backend).removeItem("k");
    expect(backend.entries.size).toBe(0);
  });

  it.each(["arc21.chunked.v1:2junk", "arc21.chunked.v1:49", "arc21.chunked.v2:4:2", "arc21.chunked.v2:0:0"])(
    "does not treat a malformed manifest as a credential: %s",
    async (head) => {
      const backend = fakeSecureStore();
      backend.entries.set("k", head);
      expect(await new ChunkedSecureSessionStorage(backend).getItem("k")).toBeNull();
    },
  );

  it("keeps Unicode chunks under the byte bound and forwards native accessibility options", async () => {
    const backend = fakeSecureStore();
    const options = { keychainAccessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" };
    const observed: (Record<string, unknown> | undefined)[] = [];
    const native: SecureStoreLike = {
      getItemAsync: async (key, supplied) => { observed.push(supplied); return backend.entries.get(key) ?? null; },
      setItemAsync: async (key, value, supplied) => {
        observed.push(supplied);
        expect(Buffer.byteLength(value)).toBeLessThan(2048);
        expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
        backend.entries.set(key, value);
      },
      deleteItemAsync: async (key, supplied) => { observed.push(supplied); backend.entries.delete(key); },
    };
    const storage = new ChunkedSecureSessionStorage(native, options);
    const value = "界🌊".repeat(1500);
    await storage.setItem("k", value);
    expect(await storage.getItem("k")).toBe(value);
    await storage.removeItem("k");
    expect(observed.every((supplied) => supplied === options)).toBe(true);
  });
});
