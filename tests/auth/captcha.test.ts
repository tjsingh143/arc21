import { describe, expect, it, vi } from "vitest";
import {
  CaptchaError,
  createCaptchaBroker,
  interpretCaptchaMessage,
  readCaptchaConfig,
  type EnabledCaptchaConfig,
} from "../../src/features/auth/captcha.js";

const SITE_KEY = "10000000-ffff-ffff-ffff-000000000001";
const CONFIG: EnabledCaptchaConfig = {
  status: "enabled", siteKey: SITE_KEY, baseUrl: "https://hcaptcha.com",
};

describe("public CAPTCHA configuration", () => {
  it("leaves local and unconfigured builds usable without a CAPTCHA provider", async () => {
    expect(readCaptchaConfig({})).toEqual({ status: "disabled" });
    await expect(createCaptchaBroker(() => readCaptchaConfig({})).acquire()).resolves.toBeUndefined();
  });

  it("accepts a public site key and normalizes an HTTPS origin", () => {
    expect(readCaptchaConfig({ EXPO_PUBLIC_HCAPTCHA_SITE_KEY: SITE_KEY })).toEqual(CONFIG);
    expect(readCaptchaConfig({
      EXPO_PUBLIC_HCAPTCHA_SITE_KEY: ` ${SITE_KEY} `,
      EXPO_PUBLIC_HCAPTCHA_BASE_URL: " https://verify.arc21.example/ ",
    })).toEqual({ ...CONFIG, baseUrl: "https://verify.arc21.example" });
  });

  it.each([
    { EXPO_PUBLIC_HCAPTCHA_SITE_KEY: "0xprivate-hcaptcha-secret" },
    { EXPO_PUBLIC_HCAPTCHA_BASE_URL: "https://verify.arc21.example" },
    { EXPO_PUBLIC_HCAPTCHA_SITE_KEY: SITE_KEY, EXPO_PUBLIC_HCAPTCHA_BASE_URL: "http://example.com" },
    { EXPO_PUBLIC_HCAPTCHA_SITE_KEY: SITE_KEY, EXPO_PUBLIC_HCAPTCHA_BASE_URL: "https://user:password@example.com" },
    { EXPO_PUBLIC_HCAPTCHA_SITE_KEY: SITE_KEY, EXPO_PUBLIC_HCAPTCHA_BASE_URL: "https://example.com/?token=secret" },
    { EXPO_PUBLIC_HCAPTCHA_SITE_KEY: SITE_KEY, EXPO_PUBLIC_HCAPTCHA_BASE_URL: "javascript:alert(1)" },
  ])("fails closed for invalid configured values %#", async (env) => {
    const broker = createCaptchaBroker(() => readCaptchaConfig(env));
    const provider = vi.fn();
    broker.register(provider);
    await expect(broker.acquire()).rejects.toMatchObject({ code: "captcha_failed", reason: "invalid_config" });
    expect(provider).not.toHaveBeenCalled();
  });
});

describe("single-use CAPTCHA lifecycle", () => {
  it("does not bypass configured CAPTCHA if the native provider is unavailable", async () => {
    await expect(createCaptchaBroker(() => CONFIG).acquire()).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("never reuses a token for another auth request", async () => {
    const broker = createCaptchaBroker(() => CONFIG);
    const provider = vi.fn().mockResolvedValueOnce("first-token").mockResolvedValueOnce("second-token");
    broker.register(provider);
    await expect(broker.acquire()).resolves.toBe("first-token");
    await expect(broker.acquire()).resolves.toBe("second-token");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("does not share a pending token between competing auth intents", async () => {
    const broker = createCaptchaBroker(() => CONFIG);
    let resolve!: (token: string) => void;
    const provider = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
    broker.register(provider);
    const first = broker.acquire();
    await expect(broker.acquire()).rejects.toMatchObject({ reason: "busy" });
    resolve("one-use-token");
    await expect(first).resolves.toBe("one-use-token");
    expect(provider).toHaveBeenCalledOnce();
  });

  it("allows a fresh attempt after cancellation without returning an empty token", async () => {
    const broker = createCaptchaBroker(() => CONFIG);
    broker.register(vi.fn().mockRejectedValueOnce(new CaptchaError("cancelled")).mockResolvedValueOnce("new-token"));
    await expect(broker.acquire()).rejects.toMatchObject({ code: "captcha_failed", reason: "cancelled" });
    await expect(broker.acquire()).resolves.toBe("new-token");
  });

  it("sanitizes provider failures and rejects malformed results", async () => {
    const broker = createCaptchaBroker(() => CONFIG);
    broker.register(vi.fn().mockRejectedValueOnce(new Error("vendor secret payload")).mockResolvedValueOnce(""));
    await expect(broker.acquire()).rejects.toEqual(new CaptchaError("failed"));
    await expect(broker.acquire()).rejects.toEqual(new CaptchaError("failed"));
  });

  it("unregisters a removed provider while preserving a later mounted provider", async () => {
    const broker = createCaptchaBroker(() => CONFIG);
    const removeOld = broker.register(async () => "old-token");
    const removeCurrent = broker.register(async () => "current-token");
    removeOld();
    await expect(broker.acquire()).resolves.toBe("current-token");
    removeCurrent();
    await expect(broker.acquire()).rejects.toMatchObject({ reason: "unavailable" });
  });
});

describe("native hCaptcha messages", () => {
  it("does not submit the SDK's successful open notification as a token", () => {
    expect(interpretCaptchaMessage({ success: true, nativeEvent: { data: "open" } })).toEqual({ kind: "pending" });
    // The SDK continues initializing after this advisory event.
    expect(interpretCaptchaMessage({ nativeEvent: { data: "error", description: "loading timeout" } })).toEqual({ kind: "pending" });
  });

  it("accepts only a successful token and distinguishes cancellation", () => {
    const token = "P1_" + "x".repeat(100);
    expect(interpretCaptchaMessage({ success: true, nativeEvent: { data: token } })).toEqual({ kind: "token", token });
    expect(interpretCaptchaMessage({ success: false, nativeEvent: { data: token } })).toEqual({ kind: "failed" });
    expect(interpretCaptchaMessage({ nativeEvent: { data: "challenge-closed" } })).toEqual({ kind: "cancelled" });
    expect(interpretCaptchaMessage({ nativeEvent: { data: "expired" } })).toEqual({ kind: "failed" });
  });
});
