/**
 * Arc 21 — request authentication.
 *
 * The single entry point through which a handler learns who is calling. There
 * is deliberately no variant that takes a user id, a seat id or a display name
 * from the request body: a modified client controls every byte it sends, so a
 * `userId` field would be an authorization bypass with extra steps.
 */

import { CommandError } from "./command-errors.ts";
import { verifyAccessToken, JwtVerificationError, type VerifiedIdentity } from "./jwt.ts";

/**
 * Extracts and verifies the bearer token.
 *
 * Note that `--no-verify-jwt` on `supabase functions serve` disables the
 * *gateway's* check only. This runs inside the function and is unaffected, which
 * is exactly why the integration tests can prove an unauthenticated request is
 * refused even with the gateway check off.
 */
export async function authenticate(request: Request): Promise<VerifiedIdentity> {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) {
    throw new CommandError("UNAUTHENTICATED", "no authorization header");
  }

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match?.[1]) {
    throw new CommandError("UNAUTHENTICATED", "authorization header is not a bearer token");
  }

  try {
    return await verifyAccessToken(match[1]);
  } catch (error) {
    if (error instanceof JwtVerificationError) {
      // The reason is logged, never returned: telling a caller *why* its forged
      // token failed is free reconnaissance.
      throw new CommandError("UNAUTHENTICATED", error.message);
    }
    throw error;
  }
}
