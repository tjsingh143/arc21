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

    backend.entries.delete("k.1");

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
});
