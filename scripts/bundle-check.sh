#!/usr/bin/env bash
#
# Arc 21 — prove the app still bundles.
#
# WHY THIS IS TWO PASSES AND NOT ONE.
#
# Bundle Mode (see `metro.config.js`) has the Babel plugin EXTRACT every worklet
# into its own file under `node_modules/react-native-worklets/.worklets/`, and
# the resolver in `react-native-worklets/bundleMode` then resolves imports of
# those files. `generatedWorkletsDir` is a hard-coded constant in the plugin, so
# there is nowhere else to put them.
#
# They are written DURING the transform. Metro builds its file map by crawling
# once, before transforming anything, and `getSha1` fails for a path the crawl
# never saw:
#
#   Error: Failed to get the SHA-1 for:
#     node_modules/react-native-worklets/.worklets/12466881117457.js
#
# On a machine that has bundled before, the directory is already populated when
# the crawl runs and nothing goes wrong — which is exactly why this was invisible
# here for the life of the project and failed on the first clean checkout CI ever
# gave it. Reproduced locally by moving the directory aside: pass one fails, and
# leaves 509 files behind; pass two succeeds.
#
# So the first pass exists to populate the directory and its failure is expected
# and ignored; the second pass is the one whose result is the gate. If the
# SECOND pass fails, the bundle is genuinely broken.
#
# `--clear` on both: it wipes Metro's transform cache, not the generated worklet
# files, so pass two still starts from a cold cache and still sees them.

set -uo pipefail

OUT="${1:-/tmp/arc21-export}"
PRIME="${OUT}-prime"

# The plugin WRITES into that directory and never creates it. With the directory
# absent it fails differently — `[Worklets] Babel plugin exception: ENOENT ...
# open '.../.worklets/12466881117457.js'` — and then pass one leaves nothing
# behind for pass two, so both fail. `npm ci` on the runner happened to leave the
# directory in place and produced the SHA-1 error instead; creating it here means
# the script does not depend on which of the two a given install gives you.
mkdir -p node_modules/react-native-worklets/.worklets

echo "pass 1 of 2 — priming the Bundle Mode worklet artefacts (failure expected on a clean install)"
npx expo export --platform ios --output-dir "$PRIME" --clear > /dev/null 2>&1 || true
rm -rf "$PRIME"

generated=$(ls node_modules/react-native-worklets/.worklets 2>/dev/null | wc -l | tr -d ' ')
echo "pass 1 left ${generated} generated worklet files"

echo "pass 2 of 2 — the bundle that counts"
npx expo export --platform ios --output-dir "$OUT" --clear
