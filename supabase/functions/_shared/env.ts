/**
 * Arc 21 — Edge Function environment.
 *
 * Every server secret is read here and nowhere else, so there is one place to
 * audit what the functions can reach. Nothing in this module is ever returned to
 * a client or written to a log.
 *
 * SECURITY.md: a service-role key or any server secret must never appear in an
 * `EXPO_PUBLIC_*` variable. These names are Function-runtime names only.
 */

/** Throws on a missing value rather than degrading to a default. */
export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value || value.trim().length === 0) {
    // The name is safe to state; the value never is.
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value && value.trim().length > 0 ? value : undefined;
}

/**
 * Direct Postgres connection string.
 *
 * DATABASE.md is explicit that this is the intended server path: `SELECT … FOR
 * UPDATE` held across several statements does not survive PostgREST's
 * connection model, and no API role — service_role included — holds USAGE on
 * the `private` schema where the engine state lives.
 */
export function databaseUrl(): string {
  return requireEnv("SUPABASE_DB_URL");
}

/**
 * The project's JWKS, injected by the Functions runtime. Contains the
 * asymmetric signing keys and, on a local stack, the symmetric one. Used to
 * verify a caller's token offline — no round trip to the auth server on the
 * hot path.
 */
export function jwks(): string {
  return requireEnv("SUPABASE_JWKS");
}

export function supabaseUrl(): string {
  return requireEnv("SUPABASE_URL");
}

export function serviceRoleKey(): string {
  return requireEnv("SUPABASE_SERVICE_ROLE_KEY");
}

/**
 * Optional issuer pin. Signature verification against the project's own JWKS
 * already binds a token to this project; setting this adds a second check for
 * deployments that front several issuers. Left unset locally, where the token's
 * issuer is the host-visible URL and the Function sees the in-cluster one.
 */
export function expectedIssuer(): string | undefined {
  return optionalEnv("ARC21_JWT_ISSUER");
}
