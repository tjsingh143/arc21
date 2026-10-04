/**
 * Optional hCaptcha boundary. Tokens exist only for the auth request that asks
 * for one; neither this module nor the native provider caches or persists them.
 * Supabase Auth, configured with the private hCaptcha secret, verifies them.
 */

export interface CaptchaEnv {
  readonly EXPO_PUBLIC_HCAPTCHA_SITE_KEY?: string;
  readonly EXPO_PUBLIC_HCAPTCHA_BASE_URL?: string;
}

export type CaptchaConfig =
  | { readonly status: "disabled" }
  | { readonly status: "invalid" }
  | { readonly status: "enabled"; readonly siteKey: string; readonly baseUrl: string };

export type EnabledCaptchaConfig = Extract<CaptchaConfig, { status: "enabled" }>;

export class CaptchaError extends Error {
  readonly code = "captcha_failed";

  constructor(readonly reason: "cancelled" | "unavailable" | "invalid_config" | "failed" | "busy") {
    super("Player verification could not finish. Try again when you are ready.");
    this.name = "CaptchaError";
  }
}

/** Public site keys are UUIDs. A secret or arbitrary HTML is never a site key. */
export function readCaptchaConfig(env: CaptchaEnv): CaptchaConfig {
  const siteKey = (env.EXPO_PUBLIC_HCAPTCHA_SITE_KEY ?? "").trim();
  const configuredUrl = (env.EXPO_PUBLIC_HCAPTCHA_BASE_URL ?? "").trim();
  if (siteKey === "" && configuredUrl === "") return { status: "disabled" };
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(siteKey)) {
    return { status: "invalid" };
  }

  const baseUrl = configuredUrl || "https://hcaptcha.com";
  // Only an HTTPS origin: no credentials, query strings, fragments or injected
  // markup. This value is the WebView origin configured for the hCaptcha key.
  if (!/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::\d{1,5})?\/?$/i.test(baseUrl)) {
    return { status: "invalid" };
  }
  return { status: "enabled", siteKey, baseUrl: baseUrl.replace(/\/$/, "") };
}

export function readCaptchaEnv(): CaptchaConfig {
  // Literal accesses are required for Expo to inline public configuration.
  return readCaptchaConfig({
    EXPO_PUBLIC_HCAPTCHA_SITE_KEY: process.env.EXPO_PUBLIC_HCAPTCHA_SITE_KEY,
    EXPO_PUBLIC_HCAPTCHA_BASE_URL: process.env.EXPO_PUBLIC_HCAPTCHA_BASE_URL,
  });
}

type CaptchaHandler = (config: EnabledCaptchaConfig) => Promise<string>;

/** Independent instance for lifecycle tests; production uses the singleton below. */
export function createCaptchaBroker(readConfig: () => CaptchaConfig = readCaptchaEnv) {
  let handler: CaptchaHandler | null = null;
  let pending = false;

  return {
    register(next: CaptchaHandler): () => void {
      handler = next;
      return () => {
        if (handler === next) handler = null;
      };
    },

    async acquire(): Promise<string | undefined> {
      const config = readConfig();
      if (config.status === "disabled") return undefined;
      if (config.status === "invalid") throw new CaptchaError("invalid_config");
      if (!handler) throw new CaptchaError("unavailable");
      // A token is single-use. Sharing a pending challenge between two auth
      // requests would make one request fail, or spend the token on the wrong
      // intent. The caller can retry after the active intent finishes.
      if (pending) throw new CaptchaError("busy");
      pending = true;
      try {
        const token = await handler(config);
        if (typeof token !== "string" || token.trim() === "") throw new CaptchaError("failed");
        return token;
      } catch (error) {
        // Provider error payloads may contain URLs or tokens. Expose only our
        // fixed error, never a vendor message in app logs or form text.
        if (error instanceof CaptchaError) throw error;
        throw new CaptchaError("failed");
      } finally {
        pending = false;
      }
    },
  };
}

const broker = createCaptchaBroker();
export const acquireCaptchaToken = broker.acquire;
export const registerCaptchaProvider = broker.register;

export type CaptchaMessageResult =
  | { readonly kind: "pending" }
  | { readonly kind: "token"; readonly token: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed" };

/** hCaptcha 4.1 marks its `open` event successful, although it is not a token. */
export function interpretCaptchaMessage(event: {
  readonly success?: boolean;
  readonly nativeEvent?: { readonly data?: unknown; readonly description?: unknown };
}): CaptchaMessageResult {
  const data = event.nativeEvent?.data;
  if (data === "open" || event.nativeEvent?.description === "loading timeout") {
    return { kind: "pending" };
  }
  if (data === "cancel" || data === "challenge-closed") return { kind: "cancelled" };
  if (event.success === true && typeof data === "string" && data.length > 35) {
    return { kind: "token", token: data };
  }
  return { kind: "failed" };
}
