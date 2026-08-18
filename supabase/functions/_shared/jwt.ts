/**
 * Arc 21 — JWT verification.
 *
 * SECURITY.md, first line of the authorization section: identity derives from
 * the session, never from the payload. This module is where that becomes true.
 * It verifies the signature against the project's own JWKS with Web Crypto, and
 * only then does the caller learn a user id.
 *
 * Things this deliberately does NOT do:
 *   - trust the `alg` header to select a verification strategy without checking
 *     it against the key's own type ("alg confusion" is exactly how a project
 *     that accepts RS256 gets forged tokens signed with its public key as an
 *     HMAC secret)
 *   - accept `alg: "none"`
 *   - accept a token whose `role` is not `authenticated`, which is what a
 *     publishable anon key is
 *   - fall back to reading `sub` out of an unverified payload for any reason
 */

import { expectedIssuer, jwks } from "./env.ts";

export interface VerifiedIdentity {
  /** `auth.users.id`. The ONLY source of identity in this codebase. */
  userId: string;
  /** GoTrue session id, when present. Useful for one-seat-per-user policy. */
  sessionId: string | undefined;
  expiresAt: number;
}

interface JsonWebKey_ {
  kty: string;
  alg?: string;
  kid?: string;
  use?: string;
  k?: string;
  crv?: string;
  [key: string]: unknown;
}

/** Signature algorithms accepted, and how each is imported and verified. */
const ALGORITHMS = {
  HS256: {
    keyTypes: ["oct"],
    importAlgorithm: { name: "HMAC", hash: "SHA-256" } as HmacImportParams,
    verifyAlgorithm: { name: "HMAC" } as AlgorithmIdentifier,
  },
  RS256: {
    keyTypes: ["RSA"],
    importAlgorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as RsaHashedImportParams,
    verifyAlgorithm: { name: "RSASSA-PKCS1-v1_5" } as AlgorithmIdentifier,
  },
  ES256: {
    keyTypes: ["EC"],
    importAlgorithm: { name: "ECDSA", namedCurve: "P-256" } as EcKeyImportParams,
    verifyAlgorithm: { name: "ECDSA", hash: "SHA-256" } as EcdsaParams,
  },
} as const;

type SupportedAlgorithm = keyof typeof ALGORITHMS;

function isSupportedAlgorithm(value: string): value is SupportedAlgorithm {
  return value === "HS256" || value === "RS256" || value === "ES256";
}

/** Tolerance for clock drift between the auth server and this runtime. */
const CLOCK_SKEW_SECONDS = 60;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class JwtVerificationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "JwtVerificationError";
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function base64UrlToBytes(value: string): Uint8Array {
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new JwtVerificationError("segment is not valid base64url");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeJsonSegment(segment: string): Record<string, unknown> {
  const text = new TextDecoder().decode(base64UrlToBytes(segment));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JwtVerificationError("segment is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new JwtVerificationError("segment is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

let cachedKeys: JsonWebKey_[] | null = null;
const importedKeys = new Map<string, CryptoKey>();

function loadJwks(): JsonWebKey_[] {
  if (cachedKeys) return cachedKeys;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jwks());
  } catch {
    throw new JwtVerificationError("SUPABASE_JWKS is not valid JSON");
  }
  const keys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new JwtVerificationError("SUPABASE_JWKS carries no keys");
  }
  cachedKeys = keys as JsonWebKey_[];
  return cachedKeys;
}

/**
 * Selects a key for the header, then confirms the key's own type matches the
 * algorithm family. A token claiming RS256 can never be verified against the
 * symmetric key, and vice versa, regardless of what `kid` it names.
 */
function selectKey(algorithm: SupportedAlgorithm, kid: string | undefined): JsonWebKey_ {
  const spec = ALGORITHMS[algorithm];
  const candidates = loadJwks().filter(
    (key) =>
      (spec.keyTypes as readonly string[]).includes(key.kty) &&
      (key.alg === undefined || key.alg === algorithm),
  );

  if (candidates.length === 0) {
    throw new JwtVerificationError(`no ${algorithm} key in the project JWKS`);
  }

  if (kid !== undefined) {
    const matched = candidates.find((key) => key.kid === kid);
    if (matched) return matched;
    // A symmetric key is published without a kid on some stacks; only fall
    // through for that case, never for an asymmetric kid that does not exist.
    const unkeyed = candidates.find((key) => key.kid === undefined);
    if (unkeyed) return unkeyed;
    throw new JwtVerificationError("token names an unknown key id");
  }

  const first = candidates[0];
  if (!first) throw new JwtVerificationError(`no ${algorithm} key in the project JWKS`);
  return first;
}

async function importKey(algorithm: SupportedAlgorithm, key: JsonWebKey_): Promise<CryptoKey> {
  const cacheKey = `${algorithm}:${key.kid ?? "default"}`;
  const cached = importedKeys.get(cacheKey);
  if (cached) return cached;

  const spec = ALGORITHMS[algorithm];
  let imported: CryptoKey;

  if (key.kty === "oct") {
    if (typeof key.k !== "string") {
      throw new JwtVerificationError("symmetric key has no material");
    }
    imported = await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(key.k) as unknown as BufferSource,
      spec.importAlgorithm,
      false,
      ["verify"],
    );
  } else {
    imported = await crypto.subtle.importKey(
      "jwk",
      { ...key, ext: true, key_ops: ["verify"] } as JsonWebKey,
      spec.importAlgorithm,
      false,
      ["verify"],
    );
  }

  importedKeys.set(cacheKey, imported);
  return imported;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export async function verifyAccessToken(token: string): Promise<VerifiedIdentity> {
  const segments = token.split(".");
  if (segments.length !== 3) {
    throw new JwtVerificationError("token is not a three-segment JWS");
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];

  const header = decodeJsonSegment(headerSegment);
  const algorithm = header.alg;
  if (typeof algorithm !== "string" || !isSupportedAlgorithm(algorithm)) {
    // Covers "none" and every other unsupported value in one branch.
    throw new JwtVerificationError("unsupported signature algorithm");
  }
  const kid = typeof header.kid === "string" ? header.kid : undefined;

  const key = await importKey(algorithm, selectKey(algorithm, kid));
  const signature = base64UrlToBytes(signatureSegment);
  const signedData = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);

  const valid = await crypto.subtle.verify(
    ALGORITHMS[algorithm].verifyAlgorithm,
    key,
    signature as unknown as BufferSource,
    signedData as unknown as BufferSource,
  );
  if (!valid) {
    throw new JwtVerificationError("signature does not verify");
  }

  // Only now is anything in the payload worth reading.
  const claims = decodeJsonSegment(payloadSegment);
  return validateClaims(claims);
}

function validateClaims(claims: Record<string, unknown>): VerifiedIdentity {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const exp = claims.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    throw new JwtVerificationError("token has no expiry");
  }
  if (exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    throw new JwtVerificationError("token has expired");
  }

  const nbf = claims.nbf;
  if (typeof nbf === "number" && nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new JwtVerificationError("token is not yet valid");
  }

  const iat = claims.iat;
  if (typeof iat === "number" && iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw new JwtVerificationError("token was issued in the future");
  }

  // A publishable/anon key is a perfectly valid signature over role "anon".
  // Rejecting anything that is not an end-user session is what stops it being
  // usable as a player credential.
  if (claims.role !== "authenticated") {
    throw new JwtVerificationError("token is not an authenticated user session");
  }

  const audience = claims.aud;
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (!audiences.includes("authenticated")) {
    throw new JwtVerificationError("token audience is not authenticated");
  }

  const pinnedIssuer = expectedIssuer();
  if (pinnedIssuer !== undefined && claims.iss !== pinnedIssuer) {
    throw new JwtVerificationError("token issuer is not the expected one");
  }

  const subject = claims.sub;
  if (typeof subject !== "string" || !UUID_PATTERN.test(subject)) {
    throw new JwtVerificationError("token subject is not a user id");
  }

  return {
    userId: subject,
    sessionId: typeof claims.session_id === "string" ? claims.session_id : undefined,
    expiresAt: exp,
  };
}
