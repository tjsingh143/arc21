/**
 * Arc 21 — "does this destination actually exist?"
 *
 * The route contract (docs/ROUTES.md) forbids dead links: a route that cannot be
 * built for real is left absent, and a link to it is omitted rather than left to
 * dump the player on an Unmatched screen. The shell links to routes that other
 * parts of the product own and that land at different times, so whether a link
 * is real is a RUNTIME fact, not a compile-time one.
 *
 * Expo Router already knows the answer — it built the route tree — so this reads
 * that tree instead of maintaining a second list that could drift from it. The
 * moment `app/profile/index.tsx` exists, the profile control becomes a button;
 * until then it is inert text rather than a promise the app cannot keep.
 *
 * Structurally typed against Expo Router's sitemap rather than importing it, so
 * these functions stay runtime-neutral and unit-testable in a plain Node process.
 */

export interface SitemapLike {
  href: unknown;
  children: readonly SitemapLike[];
  /** Router-provided screens such as `_sitemap`. Not product destinations. */
  isInternal?: boolean;
  isGenerated?: boolean;
}

/**
 * Removes Expo Router group segments: `/(tabs)/home` → `/home`.
 *
 * Groups are an organisational device with no effect on what the player can
 * reach, so a link written as `/profile` must still match a file that later
 * moves into `app/(account)/profile.tsx`. Matching on both forms means
 * reorganising the filesystem cannot silently disable a control.
 */
export function stripGroupSegments(href: string): string {
  const stripped = href
    .split("/")
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .join("/");
  return stripped === "" ? "/" : stripped;
}

/** Every product destination in the tree, in both raw and group-stripped form. */
export function buildRouteIndex(node: SitemapLike | null | undefined): ReadonlySet<string> {
  const index = new Set<string>();

  const walk = (current: SitemapLike): void => {
    if (typeof current.href === "string" && !current.isInternal && !current.isGenerated) {
      index.add(current.href);
      index.add(stripGroupSegments(current.href));
    }
    for (const child of current.children) walk(child);
  };

  if (node) walk(node);
  return index;
}

/**
 * Whether a link target is reachable.
 *
 * An empty index means the router has not published a tree. That is treated as
 * "unknown", not as "nothing exists": failing closed would disable Practice —
 * a route that certainly exists — on the strength of a missing diagnostic, and
 * would make every control flicker through an unavailable state on first paint.
 * Failing open costs, at worst, one Unmatched screen in a case that does not
 * arise once the router has mounted.
 */
export function hasRoute(index: ReadonlySet<string>, href: string): boolean {
  if (index.size === 0) return true;
  return index.has(href) || index.has(stripGroupSegments(href));
}
