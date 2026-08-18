/**
 * The auth form state machine, transition by transition.
 *
 * Two tests here are load-bearing rather than merely thorough:
 *
 *   * **The password never enters the state.** It is passed to `SUBMIT` so the
 *     reducer can measure it, and the reducer must drop it. If it ever lands in
 *     the state object it becomes serialisable — into a log line, a crash
 *     report, an analytics payload or a devtools trace — and "never log a
 *     password" stops being a property of the code and becomes a promise.
 *   * **The typed email survives every failure.** Losing the address on a wrong
 *     password is the classic form bug, and it happens exactly when a reducer
 *     returns a fresh initial state on failure.
 */

import { describe, expect, it } from "vitest";

import { authFailure, type AuthFailureCode } from "../../src/features/auth/auth-failure.js";
import {
  authStateName,
  describeAuthStatus,
  initialAuthFormState,
  isBusy,
  reduceAuthForm,
  type AuthFormEvent,
  type AuthFormState,
} from "../../src/features/auth/auth-machine.js";

const PASSWORD = "hunter2-correct-horse";

function run(state: AuthFormState, ...events: AuthFormEvent[]): AuthFormState {
  return events.reduce(reduceAuthForm, state);
}

function signInReady(): AuthFormState {
  return run(initialAuthFormState("signIn"), {
    type: "EDIT_EMAIL",
    value: "sam@example.com",
  });
}

function signUpReady(): AuthFormState {
  return run(
    initialAuthFormState("signUp"),
    { type: "EDIT_EMAIL", value: "sam@example.com" },
    { type: "EDIT_USERNAME", value: "sam_21" },
  );
}

describe("the password is never state", () => {
  it("is absent from the state after a submit", () => {
    const state = run(signInReady(), { type: "SUBMIT", password: PASSWORD });

    expect(JSON.stringify(state)).not.toContain(PASSWORD);
    expect(Object.values(state).flatMap((value) => [value])).not.toContain(PASSWORD);
  });

  it("is absent after a failed submit, when a naive reducer would echo it back", () => {
    const state = run(
      signInReady(),
      { type: "SUBMIT", password: PASSWORD },
      { type: "FAILED", failure: authFailure("INVALID_CREDENTIALS") },
    );

    expect(JSON.stringify(state)).not.toContain(PASSWORD);
  });

  it("is absent even when it was the thing that failed validation", () => {
    const state = run(signUpReady(), { type: "SUBMIT", password: "short" });

    expect(authStateName(state.status)).toBe("validating");
    expect(state.fieldErrors.password).toBeTypeOf("string");
    expect(JSON.stringify(state)).not.toContain("short");
  });

  it("carries no value on the password edit event", () => {
    // The event type itself has no `value` field, so there is nothing for the
    // reducer to store even by accident.
    const state = run(signInReady(), { type: "EDIT_PASSWORD" });
    expect(JSON.stringify(state)).not.toContain(PASSWORD);
  });
});

describe("the typed email survives", () => {
  const failures: AuthFailureCode[] = [
    "NETWORK",
    "INVALID_CREDENTIALS",
    "RATE_LIMITED",
    "EMAIL_NOT_CONFIRMED",
    "SERVER",
    "UNKNOWN",
    "NOT_CONFIGURED",
  ];

  it.each(failures)("after %s", (code) => {
    const state = run(
      signInReady(),
      { type: "SUBMIT", password: PASSWORD },
      { type: "FAILED", failure: authFailure(code) },
    );

    expect(state.email).toBe("sam@example.com");
  });

  it("survives a retry after a failure", () => {
    const state = run(
      signInReady(),
      { type: "SUBMIT", password: PASSWORD },
      { type: "FAILED", failure: authFailure("INVALID_CREDENTIALS") },
      { type: "EDIT_PASSWORD" },
      { type: "SUBMIT", password: PASSWORD },
    );

    expect(state.email).toBe("sam@example.com");
    expect(authStateName(state.status)).toBe("submitting");
  });

  it("survives switching between sign-in and create-account", () => {
    const state = run(signInReady(), { type: "SET_MODE", mode: "signUp" });

    expect(state.mode).toBe("signUp");
    expect(state.email).toBe("sam@example.com");
  });
});

describe("transitions", () => {
  it("starts idle", () => {
    expect(authStateName(initialAuthFormState("signIn").status)).toBe("idle");
    expect(isBusy(initialAuthFormState("signIn"))).toBe(false);
  });

  it("goes to validating when the form is incomplete, and sends nothing", () => {
    const state = run(initialAuthFormState("signIn"), { type: "SUBMIT", password: "" });

    expect(authStateName(state.status)).toBe("validating");
    expect(state.fieldErrors.email).toBeTypeOf("string");
    expect(state.fieldErrors.password).toBeTypeOf("string");
    expect(isBusy(state)).toBe(false);
  });

  it("goes to submitting when every field is good", () => {
    const state = run(signInReady(), { type: "SUBMIT", password: PASSWORD });

    expect(authStateName(state.status)).toBe("submitting");
    expect(isBusy(state)).toBe(true);
  });

  it("ignores a second submit while one is in flight", () => {
    const submitting = run(signInReady(), { type: "SUBMIT", password: PASSWORD });
    const again = reduceAuthForm(submitting, { type: "SUBMIT", password: PASSWORD });

    // Double-tapping "Sign in" must not produce two requests.
    expect(again).toBe(submitting);
  });

  it("reaches verificationRequired", () => {
    const state = run(
      signUpReady(),
      { type: "SUBMIT", password: PASSWORD },
      { type: "SUCCEEDED", verificationRequired: true },
    );

    expect(authStateName(state.status)).toBe("verificationRequired");
    expect(describeAuthStatus(state.status)).toContain("sam@example.com");
  });

  it("reaches signedIn", () => {
    const state = run(
      signInReady(),
      { type: "SUBMIT", password: PASSWORD },
      { type: "SUCCEEDED", verificationRequired: false },
    );

    expect(authStateName(state.status)).toBe("signedIn");
  });

  it.each([
    ["NETWORK", "networkError"],
    ["INVALID_CREDENTIALS", "invalidCredentials"],
    ["RATE_LIMITED", "rateLimited"],
    ["NOT_CONFIGURED", "notConfigured"],
    ["USERNAME_UNAVAILABLE", "usernameUnavailable"],
    ["SERVER", "error"],
  ] as const)("names %s as %s", (code, expected) => {
    const state = run(
      signInReady(),
      { type: "SUBMIT", password: PASSWORD },
      { type: "FAILED", failure: authFailure(code) },
    );

    expect(authStateName(state.status)).toBe(expected);
  });

  it("attaches a failure to its field when it has one", () => {
    const state = run(
      signUpReady(),
      { type: "SUBMIT", password: PASSWORD },
      { type: "FAILED", failure: authFailure("EMAIL_IN_USE") },
    );

    expect(state.fieldErrors.email).toBeTypeOf("string");
  });

  it("reports a substituted username with both names", () => {
    const state = run(
      signUpReady(),
      { type: "SUBMIT", password: PASSWORD },
      { type: "USERNAME_SUBSTITUTED", requested: "sam_21", assigned: "p3f8a9b2c1d4" },
    );

    expect(authStateName(state.status)).toBe("usernameUnavailable");
    const message = describeAuthStatus(state.status) ?? "";
    expect(message).toContain("sam_21");
    expect(message).toContain("p3f8a9b2c1d4");
    // The field now shows the handle they actually have.
    expect(state.username).toBe("p3f8a9b2c1d4");
  });

  it("reaches resetLinkSent without revealing whether the address exists", () => {
    const state = run(signInReady(), { type: "SUBMIT_RESET" }, { type: "RESET_LINK_SENT" });

    expect(authStateName(state.status)).toBe("resetLinkSent");
    expect(describeAuthStatus(state.status)).toContain("If sam@example.com has an account");
  });

  it("refuses a reset with no usable address, without asking for a password", () => {
    const state = run(initialAuthFormState("signIn"), { type: "SUBMIT_RESET" });

    expect(authStateName(state.status)).toBe("validating");
    expect(state.fieldErrors.email).toBeTypeOf("string");
    expect(state.fieldErrors.password).toBeUndefined();
  });
});

describe("editing clears complaints but not facts", () => {
  it("clears a failure when the player starts fixing it", () => {
    const failed = run(
      signInReady(),
      { type: "SUBMIT", password: PASSWORD },
      { type: "FAILED", failure: authFailure("INVALID_CREDENTIALS") },
    );
    const editing = reduceAuthForm(failed, { type: "EDIT_PASSWORD" });

    expect(authStateName(editing.status)).toBe("idle");
  });

  it("clears only the edited field's message", () => {
    const invalid = run(initialAuthFormState("signUp"), { type: "SUBMIT", password: "" });
    const editing = reduceAuthForm(invalid, { type: "EDIT_EMAIL", value: "s" });

    expect(editing.fieldErrors.email).toBeUndefined();
    expect(editing.fieldErrors.password).toBeTypeOf("string");
  });

  it("does not un-send a verification email when the address is edited", () => {
    const sent = run(
      signUpReady(),
      { type: "SUBMIT", password: PASSWORD },
      { type: "SUCCEEDED", verificationRequired: true },
    );
    const editing = reduceAuthForm(sent, { type: "EDIT_EMAIL", value: "sam2@example.com" });

    expect(authStateName(editing.status)).toBe("verificationRequired");
  });

  it("returns to idle on an explicit dismiss", () => {
    const failed = run(
      signInReady(),
      { type: "SUBMIT", password: PASSWORD },
      { type: "FAILED", failure: authFailure("NETWORK") },
    );

    expect(authStateName(reduceAuthForm(failed, { type: "DISMISS" }).status)).toBe("idle");
  });
});
