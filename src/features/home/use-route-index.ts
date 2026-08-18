/**
 * The React binding for `route-availability.ts`.
 *
 * Kept apart from the pure functions so those stay importable in a plain Node
 * test process — this file is the only part that touches Expo Router.
 */

import { useMemo } from "react";
import { useSitemap } from "expo-router";

import { buildRouteIndex } from "./route-availability.js";

/** Every destination the router can currently reach, for `hasRoute`. */
export function useRouteIndex(): ReadonlySet<string> {
  const sitemap = useSitemap();
  return useMemo(() => buildRouteIndex(sitemap), [sitemap]);
}
