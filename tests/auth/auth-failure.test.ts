/**
 * Error classification.
 *
 * The point of this file is that a screen never renders a message a service
 * wrote. Every branch below turns an outside error into one of our own codes,
 * and the default is a generic message rather than whatever prose arrived.
 */

import { describe, expect, it } from "vitest";

import {
  AUTH_FAILURE_MESSAGES,
  authFailure,
  classifyAuthError,
} from "../../src/features/auth/auth-failure.js";

describe("network failures", () => {
  it.each([
    { name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch" },
    { name: "TypeError", message: "Network request failed" },
    { message: "Failed to fetch" },
    { status: 0 },
  ])("classifies %j as NETWORK", (error) => {
    expect(classifyAuthError(error).code).toBe("NETWORK");
  });
});

describe("codes", () => {
  it.each([
    ["invalid_credentials", "INVALID_CREDENTIALS"],
    ["email_not_confirmed", "EMAIL_NOT_CONFIRMED"],
    ["over_request_rate_limit", "RATE_LIMITED"],
    ["over_email_send_rate_limit", "RATE_LIMITED"],
    ["user_already_exists", "EMAIL_IN_USE"],
    ["email_exists", "EMAIL_IN_USE"],
    ["weak_password", "WEAK_PASSWORD"],
    ["same_password", "SAME_PASSWORD"],
    ["pkce_code_verifier_not_found", "RECOVERY_LINK_INVALID"],
    ["email_address_invalid", "INVALID_EMAIL"],
    ["signup_disabled", "SIGNUP_DISABLED"],
    ["user_banned", "ACCOUNT_DISABLED"],
  ] as const)("maps %s", (code, expected) => {
    expect(classifyAuthError({ code, status: 400, message: "" }).code).toBe(expected);
  });
});

describe("status codes", () => {
  it("treats 429 as rate limited even with no code", () => {
    expect(classifyAuthError({ status: 429, message: "" }).code).toBe("RATE_LIMITED");
  });

  it("treats 5xx as a server problem", () => {
    expect(classifyAuthError({ status: 503, message: "" }).code).toBe("SERVER");
  });
});

describe("message fallbacks", () => {
  it("recognises the classic GoTrue 400 with no code", () => {
    expect(
      classifyAuthError({ status: 400, message: "Invalid login credentials" }).code,
    ).toBe("INVALID_CREDENTIALS");
  });

  it("falls back to SERVER for an unrecognised 4xx", () => {
    expect(classifyAuthError({ status: 418, message: "teapot" }).code).toBe("SERVER");
  });

  it("falls back to UNKNOWN for nothing at all", () => {
    expect(classifyAuthError(null).code).toBe("UNKNOWN");
    expect(classifyAuthError(undefined).code).toBe("UNKNOWN");
    expect(classifyAuthError({}).code).toBe("UNKNOWN");
  });
});

describe("what reaches the player", () => {
  it("never carries the server's own wording", () => {
    const failure = classifyAuthError({
      status: 500,
      message: "Database error saving new user: duplicate key value violates constraint",
    });

    expect(failure.message).toBe(AUTH_FAILURE_MESSAGES.SERVER);
    expect(failure.message).not.toContain("Database");
    expect(failure.message).not.toContain("constraint");
  });

  it("does not distinguish a missing account from a wrong password", () => {
    // Both must produce identical copy — otherwise sign-in is an account
    // enumeration oracle.
    const wrongPassword = classifyAuthError({ code: "invalid_credentials", status: 400 });
    const noSuchAccount = classifyAuthError({ status: 400, message: "Invalid login credentials" });

    expect(wrongPassword.message).toBe(noSuchAccount.message);
  });

  it("attaches a field when there is an obvious one", () => {
    expect(authFailure("EMAIL_IN_USE").field).toBe("email");
    expect(authFailure("WEAK_PASSWORD").field).toBe("password");
    expect(authFailure("USERNAME_UNAVAILABLE").field).toBe("username");
    expect(authFailure("NETWORK").field).toBeUndefined();
  });

  it("has wording for every code", () => {
    for (const [code, message] of Object.entries(AUTH_FAILURE_MESSAGES)) {
      expect(message, code).toBeTypeOf("string");
      expect(message.length, code).toBeGreaterThan(10);
    }
  });
});
