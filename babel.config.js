/**
 * babel-preset-expo auto-injects `react-native-worklets/plugin`, but injects it
 * with no options — which means Bundle Mode cannot be turned on that way.
 *
 * Bundle Mode is the current recommended workaround for the increased Hermes
 * memory usage that SDK 57 reports when Reanimated is imported, so we disable
 * the preset's automatic injection and add the plugin ourselves with
 * `bundleMode: true`. The matching Metro configuration lives in metro.config.js;
 * both halves are required.
 */
module.exports = function babelConfig(api) {
  api.cache(true);

  return {
    presets: [["babel-preset-expo", { worklets: false, reanimated: false }]],
    plugins: [["react-native-worklets/plugin", { bundleMode: true }]],
  };
};
