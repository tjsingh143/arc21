/**
 * Arc 21 — Supabase client configuration.
 *
 * Two values, and only two, may reach the app bundle:
 *
 *   EXPO_PUBLIC_SUPABASE_URL
 *   EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
 *
 * Everything prefixed `EXPO_PUBLIC_` is inlined into the JavaScript that ships
 * to devices, so it is public by definition. The publishable key is fine there —
 * it is powerless without a session because Row Level Security governs every
 * table. A service-role key is not fine there: it bypasses RLS entirely and
 * would hand every attacker the wallet, the shoe and the hole card. This module
 * therefore does more than read two strings — it *refuses to start* if the value
 * it was handed looks like a server secret, because a leak that ships is not
 * something a code review catches after the fact.
 *
 * The parsing is a pure function over a plain record so every branch is testable
 * without a bundler, a device or a network. `readEnvConfig()` is the only part
 * that touches `process.env`, and it references each variable as a literal
 * member expression because that is what Expo's Babel transform substitutes at
 * build time — a computed lookup like `env[name]` would silently read undefined
 * in a release build.
 */

/** Why configuration was rejected. Every one of these is a stated state, never a crash. */
export type SupabaseConfigProblem =
  | "MISSING_URL"
  | "MISSING_KEY"
  | "INVALID_URL"
  | "INSECURE_URL"
  | "SERVER_SECRET_IN_CLIENT_BUNDLE";

export type SupabaseConfig =
  | { readonly status: "configured"; readonly url: string; readonly publishableKey: string }
  | { readonly status: "not-configured"; readonly problems: readonly SupabaseConfigProblem[] };

export interface SupabaseEnv {
  readonly EXPO_PUBLIC_SUPABASE_URL?: string | undefined;
  readonly EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string | undefined;
}

/**
 * `URL` is only partially implemented in React Native's Hermes runtime, and its
 * behaviour has differed between versions — which makes it the wrong thing to
 * base a security check on. A deliberate regex is boring, deterministic, and
 * identical on every platform.
 */
const URL_PATTERN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/[^\s]*)?$/i;

/** Loopback hosts, where plain HTTP is the local Supabase stack rather than a downgrade. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/**
 * Key prefixes Supabase uses for secrets. `sb_secret_` is the modern secret-key
 * format; the legacy format is a JWT whose payload carries `service_role`.
 */
const SECRET_KEY_PREFIXES = ["sb_secret_", "sbp_", "postgres://", "postgresql://"];

export function readSupabaseConfig(env: SupabaseEnv): SupabaseConfig {
  const url = (env.EXPO_PUBLIC_SUPABASE_URL ?? "").trim();
  const key = (env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "").trim();

  const problems: SupabaseConfigProblem[] = [];

  if (url === "") {
    problems.push("MISSING_URL");
  } else if (!URL_PATTERN.test(url)) {
    problems.push("INVALID_URL");
  } else if (isInsecureRemoteUrl(url)) {
    // A bearer token over plain HTTP to a remote host is a session handed to
    // anyone on the path. Local development against 127.0.0.1 is exempt because
    // there is no path.
    problems.push("INSECURE_URL");
  }

  if (key === "") {
    problems.push("MISSING_KEY");
  } else if (looksLikeServerSecret(key)) {
    problems.push("SERVER_SECRET_IN_CLIENT_BUNDLE");
  }

  if (problems.length > 0) return { status: "not-configured", problems };
  return { status: "configured", url: stripTrailingSlash(url), publishableKey: key };
}

/** Reads the build-time environment. The only impure function in this file. */
export function readEnvConfig(): SupabaseConfig {
  return readSupabaseConfig({
    // Written as literal member expressions on purpose — see the file header.
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}

/**
 * Whether a key is a server secret that must never ship in a client bundle.
 *
 * Recognises both key formats:
 *
 *   * the modern `sb_secret_…` / `sbp_…` prefixes, and anything that is plainly
 *     a database connection string;
 *   * a legacy JWT whose payload claims `"role": "service_role"`.
 *
 * The JWT branch decodes the payload rather than substring-matching the whole
 * token, because base64 of an ordinary anon key can contain arbitrary letters
 * and a raw `indexOf("service_role")` would be both false-positive and
 * false-negative prone.
 */
export function looksLikeServerSecret(key: string): boolean {
  const lowered = key.toLowerCase();
  if (SECRET_KEY_PREFIXES.some((prefix) => lowered.startsWith(prefix))) return true;

  const claims = decodeJwtClaims(key);
  if (claims === null) return false;

  const role = claims["role"];
  return typeof role === "string" && role !== "anon" && role !== "authenticated";
}

/**
 * Decodes a JWT payload without verifying it.
 *
 * Verification is meaningless here — we do not hold the signing secret and are
 * not trusting the contents, only classifying them. Returns null for anything
 * that is not a three-segment token with a JSON object payload.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;

  const payload = segments[1];
  if (payload === undefined || payload === "") return null;

  let json: string;
  try {
    json = decodeBase64Url(payload);
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64url → UTF-8, implemented directly.
 *
 * `atob` exists in Node and in React Native's polyfill set, but it is not
 * guaranteed on every Hermes configuration and it does not accept the base64url
 * alphabet. Twenty lines of lookup table removes an environmental dependency
 * from a check that must never silently stop running.
 */
export function decodeBase64Url(input: string): string {
  const normalised = input.replace(/-/g, "+").replace(/_/g, "/");

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of normalised) {
    if (character === "=") break;
    const value = BASE64_ALPHABET.indexOf(character);
    if (value < 0) throw new Error("not base64");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  // Minimal UTF-8 decode. JWT payloads are JSON, which is overwhelmingly ASCII,
  // but a non-ASCII claim must not corrupt the parse.
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte < 0x80) {
      out += String.fromCharCode(byte);
    } else if (byte >= 0xc0 && byte < 0xe0) {
      out += String.fromCharCode(((byte & 0x1f) << 6) | ((bytes[index + 1] ?? 0) & 0x3f));
      index += 1;
    } else if (byte >= 0xe0 && byte < 0xf0) {
      out += String.fromCharCode(
        ((byte & 0x0f) << 12) |
          (((bytes[index + 1] ?? 0) & 0x3f) << 6) |
          ((bytes[index + 2] ?? 0) & 0x3f),
      );
      index += 2;
    } else {
      // Astral plane characters are not expected in a JWT claim set; skipping
      // the continuation bytes keeps the decode from desynchronising.
      index += 3;
    }
  }
  return out;
}

function isInsecureRemoteUrl(url: string): boolean {
  if (!/^http:\/\//i.test(url)) return false;
  const host = url.slice("http://".length).split("/")[0]?.split(":")[0] ?? "";
  return !LOOPBACK_HOSTS.has(host.toLowerCase());
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Plain-language explanation, for a screen rather than a log.
 *
 * Screens are required to say "not configured" honestly rather than failing
 * oddly, so the wording lives with the model and cannot drift between the two
 * screens that render it.
 */
export function describeConfigProblems(problems: readonly SupabaseConfigProblem[]): string {
  if (problems.includes("SERVER_SECRET_IN_CLIENT_BUNDLE")) {
    return (
      "This build was configured with a server secret instead of the publishable key, " +
      "so online play is disabled. Nothing has been sent anywhere."
    );
  }
  if (problems.includes("INSECURE_URL")) {
    return (
      "This build points at an unencrypted server address, so online play is " +
      "disabled rather than sending your sign-in over plain HTTP."
    );
  }
  if (problems.includes("INVALID_URL")) {
    return "This build has an unusable server address, so online play is unavailable.";
  }
  return (
    "This build has no server configured, so accounts and online play are " +
    "unavailable. Everything offline still works."
  );
}
