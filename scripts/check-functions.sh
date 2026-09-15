#!/usr/bin/env bash
#
# Typecheck every Edge Function, each with its OWN import map.
#
# `supabase/functions` is excluded from `tsconfig.json`, so `npx tsc --noEmit`
# has never looked at a single line of it. That exclusion is not a mistake — the
# directory's `.js` specifiers only resolve through the per-function
# `deno.json`, and tsc cannot be given a different map per directory — but the
# consequence was that the server's type errors were invisible. `PRIVATE_TIMING`
# shipped in seconds where the engine wanted milliseconds because of it.
#
# Running this for the first time found:
#
#   * eight `throw new CommandError("NOT_FOUND", …)` — a code that is not in
#     `COMMAND_REJECTION_CODES`. Live behaviour: HTTP **200** with
#     `{"status":"rejected","code":"NOT_FOUND","message":"undefined (ref …)"}`,
#     because `HTTP_STATUS[code]` and `PUBLIC_MESSAGES[code]` were both
#     undefined. A client's `functions.invoke` reports that as SUCCESS.
#   * `LedgerReason` missing two labels its own call sites pass.
#   * a seat appended to a live public table with `insuranceDecision` omitted.
#   * a `SeatRow | null` reassigned a `{ id }` literal, which made every use of
#     it downstream unchecked.
#
# Each function is checked from its own directory so the map applies. `deno` is
# fetched through npx rather than being a prerequisite, because the only other
# thing this repository needs Deno for is the Supabase CLI's own container.

set -euo pipefail

cd "$(dirname "$0")/../supabase/functions"

status=0
for dir in */; do
  name="${dir%/}"
  [ "$name" = "_shared" ] && continue
  if [ ! -f "$name/deno.json" ]; then
    # Not cosmetic: a function directory without its own map cannot resolve
    # `shared/**` at all, and the edge runtime loads EVERY function at startup —
    # so one missing map takes the whole stack down with
    # "failed to read file: open shared/contracts/index.js".
    echo "FAIL $name — no deno.json import map"
    status=1
    continue
  fi
  echo "checking $name"
  ( cd "$name" && npx --yes deno@2 check --config deno.json index.ts ) || status=1
done

if [ "$status" -ne 0 ]; then
  echo
  echo "Edge Function typecheck FAILED. These errors are invisible to \`tsc --noEmit\`."
  exit 1
fi
echo "all Edge Functions typecheck"
