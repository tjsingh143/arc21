/**
 * How a mode card on the Play tab describes itself.
 *
 * THE DEFECT THIS CLOSES. The badge said "Offline" or "Online" from
 * `mode.availability`, and took its COLOUR from a different property entirely —
 * `playable`, meaning "does a route exist for this yet". Those two agreed while
 * the online modes were unbuilt, and stopped agreeing the moment they shipped:
 * every mode is reachable now, so `playable` is true for all six, and all four
 * ONLINE cards were rendering their badge in the green reserved for "this works
 * with no server at all". The label said one thing and the colour said the
 * opposite, on the screen whose entire job is stating which modes need a server.
 *
 * The colour comes from the same field as the word now, and the pair is
 * asserted in `tests/home/play-mode-presentation.test.ts` rather than looked at.
 *
 * Pure and free of React Native so it can be.
 */

export type ModeAvailability = "offline" | "online";

export interface ModeBadge {
  /** Exactly what the card renders. */
  readonly label: "Offline" | "Online";
  /**
   * `success` is reserved for "needs no server", because that is the claim it
   * makes everywhere else in this app. An online mode is not a WARNING — it is
   * simply a different thing — so it gets the neutral tone rather than a colour
   * that reads as a problem.
   */
  readonly tone: "success" | "neutral";
}

export function modeBadge(availability: ModeAvailability): ModeBadge {
  return availability === "offline"
    ? { label: "Offline", tone: "success" }
    : { label: "Online", tone: "neutral" };
}

export interface ModeNotice {
  readonly text: string;
  /**
   * `warning` is a REFUSAL — this mode cannot be opened. `secondary` is a
   * statement of what it needs once opened. Rendering both in the warning
   * colour is how "needs an account" starts reading as "broken".
   */
  readonly tone: "warning" | "secondary";
}

/**
 * The line under a mode card, or `null`.
 *
 * `reason` used to render only when `playable` was false, which meant that the
 * moment every mode became reachable the copy stopped appearing anywhere — six
 * carefully written sentences about what each online mode needs, shown to
 * nobody. A guest deserves to know an account is wanted BEFORE tapping, so a
 * playable mode with a reason states it quietly instead.
 */
export function modeNotice(mode: {
  readonly playable: boolean;
  readonly reason?: string;
}): ModeNotice | null {
  if (mode.reason === undefined || mode.reason === "") return null;
  return { text: mode.reason, tone: mode.playable ? "secondary" : "warning" };
}
