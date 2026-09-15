/**
 * Arc 21 — auth.
 *
 * The screens import from here. Nothing outside this folder should reach for
 * `supabase-auth-adapter.ts` directly: the adapter boundary is the whole reason
 * OAuth can be added later without touching a screen.
 */

export {
  createUnconfiguredAuthAdapter,
  type AuthAccount,
  type AuthAdapter,
  type AuthResult,
  type AuthSessionSnapshot,
  type AuthVoidResult,
  type OAuthProvider,
  type SignInRequest,
  type SignUpRequest,
} from "./auth-adapter.js";

export {
  AUTH_FAILURE_MESSAGES,
  authFailure,
  classifyAuthError,
  type AuthFailure,
  type AuthFailureCode,
} from "./auth-failure.js";

export {
  authStateName,
  describeAuthStatus,
  failedWith,
  initialAuthFormState,
  isBusy,
  reduceAuthForm,
  type AuthFormEvent,
  type AuthFormMode,
  type AuthFormState,
  type AuthFormStatus,
  type AuthStateName,
} from "./auth-machine.js";

export {
  AUTH_HYDRATE_TIMEOUT_MS,
  activeAuthAdapter,
  disposeAuthSubscription,
  setAuthAdapter,
  setGuestIdentityStore,
  useAuthStore,
  type AuthMode,
  type AuthStoreState,
} from "./auth-store.js";

export {
  hasFieldErrors,
  normaliseEmail,
  normaliseUsername,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  USERNAME_PATTERN,
  validateEmail,
  validatePassword,
  validateSignIn,
  validateSignUp,
  validateUsername,
  type CredentialFieldErrors,
  type SignInDraft,
  type SignUpDraft,
} from "./credentials.js";

export {
  buildGuestIdentity,
  GUEST_IDENTITY_KEY,
  GUEST_SCHEMA_VERSION,
  GuestIdentityStore,
  parseGuestIdentity,
  serialiseGuestIdentity,
  type GuestIdentity,
} from "./guest.js";

export {
  assertNoEconomicImport,
  buildGuestConversionPlan,
  CONVERSION_DISCARD_REASONS,
  describeConversion,
  type ConversionDiscard,
  type GuestConversionInput,
  type GuestConversionPlan,
  type PracticeHistoryImport,
} from "./conversion.js";

export { createSupabaseAuthAdapter } from "./supabase-auth-adapter.js";

export {
  useAccountProfileStore,
  type AccountProfile,
  type AccountProfileState,
} from "./account-profile-store.js";
