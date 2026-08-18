/**
 * Credential validation.
 *
 * The username rule is the one that matters most: it must accept exactly what
 * `profiles.username`'s CHECK constraint accepts, because a client that is
 * stricter than the database silently forbids legal handles, and one that is
 * looser sends a request the database will reject with an error the player
 * cannot act on.
 */

import { describe, expect, it } from "vitest";

import {
  hasFieldErrors,
  normaliseEmail,
  normaliseUsername,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_PATTERN,
  validateEmail,
  validatePassword,
  validateSignIn,
  validateSignUp,
  validateUsername,
} from "../../src/features/auth/credentials.js";

describe("normalisation", () => {
  it("lowercases and trims an address", () => {
    expect(normaliseEmail("  Sam@Example.COM ")).toBe("sam@example.com");
  });

  it("lowercases and trims a handle", () => {
    // The column stores lowercase only. Rejecting "Sam_21" instead of folding it
    // would refuse a handle the server would have accepted.
    expect(normaliseUsername(" Sam_21 ")).toBe("sam_21");
  });
});

describe("email", () => {
  it.each(["a@b.co", "sam.smith+tag@example.co.uk", "SAM@EXAMPLE.COM"])("accepts %s", (email) => {
    expect(validateEmail(email)).toBeUndefined();
  });

  it.each(["", "   ", "sam", "sam@", "@example.com", "sam@example", "sam @example.com"])(
    "rejects %j",
    (email) => {
      expect(validateEmail(email)).toBeTypeOf("string");
    },
  );

  it("rejects an address longer than the column allows", () => {
    expect(validateEmail(`${"a".repeat(250)}@example.com`)).toBeTypeOf("string");
  });
});

describe("password", () => {
  it("accepts the minimum length", () => {
    expect(validatePassword("a".repeat(PASSWORD_MIN_LENGTH))).toBeUndefined();
  });

  it("rejects one character below the minimum", () => {
    expect(validatePassword("a".repeat(PASSWORD_MIN_LENGTH - 1))).toBeTypeOf("string");
  });

  it("accepts the bcrypt limit and rejects one past it", () => {
    // bcrypt ignores everything past 72 bytes, so accepting 73 would teach a
    // password whose tail does nothing.
    expect(validatePassword("a".repeat(PASSWORD_MAX_LENGTH))).toBeUndefined();
    expect(validatePassword("a".repeat(PASSWORD_MAX_LENGTH + 1))).toBeTypeOf("string");
  });
});

describe("username", () => {
  it.each(["abc", "sam_21", "a_b_c", "01234567890123456789"])("accepts %s", (username) => {
    expect(validateUsername(username)).toBeUndefined();
    expect(USERNAME_PATTERN.test(username)).toBe(true);
  });

  it.each(["ab", "a".repeat(21), "sam-21", "sam 21", "sam!", "sám", ""])(
    "rejects %j",
    (username) => {
      expect(validateUsername(username)).toBeTypeOf("string");
    },
  );

  it("accepts a handle that only needs case folding", () => {
    expect(validateUsername("SamTwentyOne")).toBeUndefined();
  });

  it("leaves reserved and filtered names to the server", () => {
    // `admin` is refused by `username_is_permitted`, not by the client. Copying
    // that word list here would drift from it silently; the server's verdict is
    // reported back instead.
    expect(validateUsername("admin")).toBeUndefined();
  });
});

describe("form validation", () => {
  it("passes a complete sign-up", () => {
    const errors = validateSignUp({
      email: "sam@example.com",
      password: "correct horse",
      username: "sam_21",
    });
    expect(hasFieldErrors(errors)).toBe(false);
  });

  it("reports every bad field at once rather than one at a time", () => {
    const errors = validateSignUp({ email: "nope", password: "short", username: "!!" });
    expect(Object.keys(errors).sort()).toEqual(["email", "password", "username"]);
  });

  it("checks only presence of the password when signing in", () => {
    // Applying the length rule to sign-in would lock out anyone registered
    // under an older policy, and "too short" leaks a fact about what was typed.
    expect(validateSignIn({ email: "sam@example.com", password: "old" })).toEqual({});
    expect(validateSignIn({ email: "sam@example.com", password: "" }).password).toBeTypeOf(
      "string",
    );
  });
});
