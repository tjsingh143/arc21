/**
 * Arc 21 — the sign-in / create-account state machine.
 *
 * A pure reducer. No React, no Supabase, no storage, no clock. Both screens
 * render this and nothing else, so every state a player can reach is reachable
 * in a test, and a screen cannot invent a state the machine does not have.
 *
 * ── The password is not in this state. ──────────────────────────────────────
 *
 * `SUBMIT` carries a password so validation can measure it; the reducer measures
 * it and drops it. It is never assigned to a field, never returned, never part
 * of any value this module produces. That is the whole mechanism behind "never
 * log a password": there is no state object to accidentally serialise into a
 * log line, a crash report, an analytics event or a Redux-style devtools trace,
 * because the password was never in one. The screen holds it in local component
 * state and hands it straight to the adapter.
 *
 * ── The typed email survives everything. ────────────────────────────────────
 *
 * Every transition carries `email` and `username` forward. A failed sign-in that
 * clears the address is the single most irritating bug in this genre of screen,
 * and the way it happens is a reducer that returns a fresh initial state on
 * failure. This one never does; `initialAuthFormState` is only reached by an
 * explicit reset.
 *
 * ── State vocabulary ────────────────────────────────────────────────────────
 *
 *   idle                  nothing has been attempted, or the player is editing
 *   validating            checked locally, problems found, nothing sent
 *   submitting            a request is in flight
 *   verificationRequired  the account exists; a confirmation email was sent
 *   resetLinkSent         a password-reset email was sent
 *   usernameUnavailable   the requested handle was taken, reserved or filtered
 *   signedIn              there is a session
 *   failed                everything else, carrying a classified failure code
 *
 * `failed` covers network errors, invalid credentials and rate limiting; the
 * code distinguishes them and `authStateName` gives each its own name for the
 * screens and the tests.
 */

import {
  authFailure,
  type AuthFailure,
  type AuthFailureCode,
} from "./auth-failure.js";
import {
  hasFieldErrors,
  normaliseEmail,
  normaliseUsername,
  validateSignIn,
  validateSignUp,
  type CredentialFieldErrors,
} from "./credentials.js";

export type AuthFormMode = "signIn" | "signUp";

export type AuthFormStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "validating" }
  | { readonly kind: "submitting" }
  | { readonly kind: "verificationRequired"; readonly email: string }
  | { readonly kind: "resetLinkSent"; readonly email: string }
  | {
      readonly kind: "usernameUnavailable";
      readonly requested: string;
      /**
       * The handle the server gave instead, when the account was created
       * anyway. Null when the request failed outright.
       */
      readonly assigned: string | null;
    }
  | { readonly kind: "signedIn" }
  | { readonly kind: "failed"; readonly failure: AuthFailure };

export interface AuthFormState {
  readonly mode: AuthFormMode;
  readonly status: AuthFormStatus;
  /** Preserved across every transition. */
  readonly email: string;
  /** Preserved across every transition. Unused in sign-in mode. */
  readonly username: string;
  readonly fieldErrors: CredentialFieldErrors;
}

export type AuthFormEvent =
  | { readonly type: "SET_MODE"; readonly mode: AuthFormMode }
  | { readonly type: "EDIT_EMAIL"; readonly value: string }
  | { readonly type: "EDIT_USERNAME"; readonly value: string }
  | { readonly type: "EDIT_PASSWORD" }
  /** The password is measured and discarded. See the header. */
  | { readonly type: "SUBMIT"; readonly password: string }
  | { readonly type: "SUBMIT_RESET" }
  | { readonly type: "SUCCEEDED"; readonly verificationRequired: boolean }
  | {
      readonly type: "USERNAME_SUBSTITUTED";
      readonly requested: string;
      readonly assigned: string;
    }
  | { readonly type: "RESET_LINK_SENT" }
  | { readonly type: "FAILED"; readonly failure: AuthFailure }
  | { readonly type: "DISMISS" };

export function initialAuthFormState(
  mode: AuthFormMode,
  email = "",
  username = "",
): AuthFormState {
  return { mode, status: { kind: "idle" }, email, username, fieldErrors: {} };
}

export function reduceAuthForm(state: AuthFormState, event: AuthFormEvent): AuthFormState {
  switch (event.type) {
    case "SET_MODE":
      // Switching between sign-in and create-account keeps the address that has
      // already been typed — that is the whole reason someone switches.
      return {
        ...state,
        mode: event.mode,
        status: { kind: "idle" },
        fieldErrors: {},
      };

    case "EDIT_EMAIL":
      return {
        ...state,
        email: event.value,
        fieldErrors: without(state.fieldErrors, "email"),
        status: clearTransientStatus(state.status),
      };

    case "EDIT_USERNAME":
      return {
        ...state,
        username: event.value,
        fieldErrors: without(state.fieldErrors, "username"),
        status: clearTransientStatus(state.status),
      };

    case "EDIT_PASSWORD":
      // No value carried: the reducer has no business seeing it. Editing the
      // password only clears the message attached to that field.
      return {
        ...state,
        fieldErrors: without(state.fieldErrors, "password"),
        status: clearTransientStatus(state.status),
      };

    case "SUBMIT": {
      if (state.status.kind === "submitting") return state;

      const fieldErrors =
        state.mode === "signUp"
          ? validateSignUp({
              email: state.email,
              password: event.password,
              username: state.username,
            })
          : validateSignIn({ email: state.email, password: event.password });

      if (hasFieldErrors(fieldErrors)) {
        // Checked locally, problems found, nothing sent.
        return { ...state, status: { kind: "validating" }, fieldErrors };
      }
      return { ...state, status: { kind: "submitting" }, fieldErrors: {} };
    }

    case "SUBMIT_RESET": {
      if (state.status.kind === "submitting") return state;

      // Reset needs an address and nothing else, so it is validated on its own
      // rather than through the sign-in rules — otherwise "I forgot my
      // password" would demand the password first.
      const fieldErrors = validateSignIn({ email: state.email, password: "unused" });
      const emailError = fieldErrors.email;
      if (emailError !== undefined) {
        return { ...state, status: { kind: "validating" }, fieldErrors: { email: emailError } };
      }
      return { ...state, status: { kind: "submitting" }, fieldErrors: {} };
    }

    case "SUCCEEDED":
      return {
        ...state,
        fieldErrors: {},
        status: event.verificationRequired
          ? { kind: "verificationRequired", email: normaliseEmail(state.email) }
          : { kind: "signedIn" },
      };

    case "USERNAME_SUBSTITUTED":
      return {
        ...state,
        // The account exists and the player is signed in; what failed is only
        // the handle. Showing the assigned one is more useful than an error.
        username: normaliseUsername(event.assigned),
        fieldErrors: {},
        status: {
          kind: "usernameUnavailable",
          requested: normaliseUsername(event.requested),
          assigned: normaliseUsername(event.assigned),
        },
      };

    case "RESET_LINK_SENT":
      return {
        ...state,
        fieldErrors: {},
        status: { kind: "resetLinkSent", email: normaliseEmail(state.email) },
      };

    case "FAILED": {
      const { failure } = event;
      if (failure.code === "USERNAME_UNAVAILABLE") {
        return {
          ...state,
          fieldErrors: { username: failure.message },
          status: {
            kind: "usernameUnavailable",
            requested: normaliseUsername(state.username),
            assigned: null,
          },
        };
      }
      return {
        ...state,
        // Attach the message to a field when the failure names one, so the
        // error appears where the player has to act, not only at the top.
        fieldErrors:
          failure.field === undefined ? {} : { [failure.field]: failure.message },
        status: { kind: "failed", failure },
      };
    }

    case "DISMISS":
      return { ...state, status: { kind: "idle" } };
  }
}

/**
 * Canonical name for the current state.
 *
 * The screens and the tests both talk in these words, and `failed` is expanded
 * by its code so "network error", "invalid credentials" and "rate limited" are
 * each nameable rather than hiding behind one label.
 */
export type AuthStateName =
  | "idle"
  | "validating"
  | "submitting"
  | "verificationRequired"
  | "resetLinkSent"
  | "usernameUnavailable"
  | "signedIn"
  | "networkError"
  | "invalidCredentials"
  | "rateLimited"
  | "notConfigured"
  | "error";

const NAME_BY_FAILURE: Partial<Record<AuthFailureCode, AuthStateName>> = {
  NETWORK: "networkError",
  INVALID_CREDENTIALS: "invalidCredentials",
  RATE_LIMITED: "rateLimited",
  NOT_CONFIGURED: "notConfigured",
  USERNAME_UNAVAILABLE: "usernameUnavailable",
};

export function authStateName(status: AuthFormStatus): AuthStateName {
  if (status.kind !== "failed") return status.kind;
  return NAME_BY_FAILURE[status.failure.code] ?? "error";
}

/** True while a request is in flight, so the screen can disable its controls. */
export function isBusy(state: AuthFormState): boolean {
  return state.status.kind === "submitting";
}

/**
 * The one-line message for the current status, or null when there is nothing to
 * say. Kept beside the machine so both screens cannot word the same state
 * differently.
 */
export function describeAuthStatus(status: AuthFormStatus): string | null {
  switch (status.kind) {
    case "idle":
    case "submitting":
    case "signedIn":
      return null;
    case "validating":
      return "Check the highlighted fields.";
    case "verificationRequired":
      return `Check ${status.email} for a confirmation link, then sign in.`;
    case "resetLinkSent":
      return `If ${status.email} has an account, a reset link is on its way.`;
    case "usernameUnavailable":
      return status.assigned === null
        ? "That username is taken or not available. Try another."
        : `The username "${status.requested}" was taken, so your account was created as "${status.assigned}". You can change it in Profile.`;
    case "failed":
      return status.failure.message;
  }
}

/** Convenience for call sites that only have a code. */
export function failedWith(code: AuthFailureCode): AuthFormStatus {
  return { kind: "failed", failure: authFailure(code) };
}

function without(
  errors: CredentialFieldErrors,
  field: keyof CredentialFieldErrors,
): CredentialFieldErrors {
  if (errors[field] === undefined) return errors;
  const next = { ...errors };
  delete next[field];
  return next;
}

/**
 * Typing clears a *message*, not a *fact*.
 *
 * A failure or a validation complaint should disappear the moment the player
 * starts fixing it. `signedIn`, `verificationRequired`, `resetLinkSent` and
 * `usernameUnavailable` are facts about the account rather than complaints about
 * the form, so editing a field must not erase them — a player who edits their
 * address after being told to check their inbox has not un-sent the email.
 */
function clearTransientStatus(status: AuthFormStatus): AuthFormStatus {
  switch (status.kind) {
    case "failed":
    case "validating":
      return { kind: "idle" };
    default:
      return status;
  }
}
