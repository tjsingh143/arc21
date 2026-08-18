/**
 * Metro configuration.
 *
 * Two customisations, both required:
 *
 * 1. BUNDLE MODE. `getBundleModeMetroConfig` mutates the Expo default config to
 *    add the worklets module-id factory, the React Native resolver shims and the
 *    inline requires that Bundle Mode depends on. It pairs with
 *    `bundleMode: true` in babel.config.js — enabling one without the other
 *    produces a broken bundle. Bundle Mode is the current recommended workaround
 *    for the increased Hermes memory usage SDK 57 reports with Reanimated.
 *
 * 2. TYPESCRIPT `.js` SPECIFIERS. `shared/` imports its own modules with
 *    explicit `.js` extensions ("./types.js" resolving to types.ts). That is
 *    required because the same engine is imported by Supabase Edge Functions,
 *    where Deno mandates explicit extensions. TypeScript and Vite both perform
 *    the .js→.ts mapping natively; Metro does not, so we add it here.
 *
 *    The mapping is applied only as a FALLBACK, after normal resolution has
 *    already failed, so no existing resolution behaviour changes.
 */
const { getDefaultConfig } = require("expo/metro-config");
const { getBundleModeMetroConfig } = require("react-native-worklets/bundleMode");

const config = getBundleModeMetroConfig(getDefaultConfig(__dirname));

const upstreamResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  try {
    return upstreamResolveRequest(context, moduleName, platform);
  } catch (error) {
    // A relative "./foo.js" that does not exist may be TypeScript's way of
    // referring to "./foo.ts". Retry without the extension and let Metro's
    // normal sourceExts search find the TypeScript file.
    const isRelative = moduleName.startsWith("./") || moduleName.startsWith("../");
    if (isRelative && moduleName.endsWith(".js")) {
      return upstreamResolveRequest(context, moduleName.slice(0, -".js".length), platform);
    }
    throw error;
  }
};

module.exports = config;
