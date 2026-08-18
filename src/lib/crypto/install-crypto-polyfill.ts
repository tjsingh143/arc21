/**
 * Installs `globalThis.crypto.getRandomValues` on React Native.
 *
 * The shared engine's `CryptoRandomSource` throws on construction when no CSPRNG
 * is present rather than silently falling back to `Math.random()`. That is the
 * correct behaviour — a quietly weak shuffle is exactly the defect this product
 * promises does not exist — but it means the host must provide Web Crypto before
 * any shoe is created.
 *
 * Hermes does not ship Web Crypto, so we bridge `expo-crypto`, which is backed by
 * the platform's secure random generator (SecRandomCopyBytes on iOS,
 * SecureRandom on Android).
 *
 * Import this once, at the very top of the root layout, before any game module.
 */

import * as ExpoCrypto from "expo-crypto";

export function installCryptoPolyfill(): void {
  const existing = globalThis.crypto as Crypto | undefined;

  if (typeof existing?.getRandomValues === "function") {
    return;
  }

  const shim = {
    getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
      if (array === null) return array;
      ExpoCrypto.getRandomValues(array as unknown as Uint8Array);
      return array;
    },
    randomUUID: () => ExpoCrypto.randomUUID(),
  };

  if (existing) {
    // Some runtimes expose a partial `crypto`; fill in only what is missing.
    Object.defineProperties(existing, {
      getRandomValues: { value: shim.getRandomValues, configurable: true, writable: true },
      randomUUID: {
        value: existing.randomUUID ?? shim.randomUUID,
        configurable: true,
        writable: true,
      },
    });
    return;
  }

  Object.defineProperty(globalThis, "crypto", {
    value: shim,
    configurable: true,
    writable: true,
  });
}
