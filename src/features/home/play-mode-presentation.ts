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

/**
 * What a screen reader is told about a mode card.
 *
 * THE DEFECT, and it was found by an E2E assertion that stopped matching.
 *
 * `SurfaceCard` is a plain `View` when it has no `onPress` and a `Pressable`
 * with an `accessibilityLabel` when it does. On iOS **a labelled accessibility
 * element REPLACES its children in the tree** — CLAUDE.md records the same fact
 * about `testID` vs `accessibilityLabel`. So the moment every mode on the Play
 * tab became reachable, every card became pressable and labelled, and the whole
 * body of each card — the purpose, the structure line, and the note saying an
 * account is needed — **stopped existing for a screen reader**. A sighted player
 * reads four lines per card; a VoiceOver user heard one word: the title.
 *
 * It cannot be fixed with the HINT. A hint is supplementary, is spoken last and
 * only after a pause, is suppressed entirely when the user has hints turned
 * off — and it is not part of an element's matchable text, which is why the
 * audit flow could not see it either. The LABEL is what carries content.
 *
 * So the label is composed from exactly what the card renders, in the order it
 * renders it, and the hint goes back to describing the ACTION — which is what a
 * hint is for.
 *
 * The specification's acceptance criterion is "Screen readers can identify
 * cards/actions". A card that announces its name and withholds its stakes, its
 * seat count and the fact that it needs an account does not meet it.
 *
 * Refresh D added the two remaining things a Play card SHOWS and a screen
 * reader was not told: the Online/Offline badge beside the title, and the facts
 * line (who is at the table, whose chips, what it counts toward). Both are
 * optional so a caller that renders neither is described exactly as before.
 */
export function modeAccessibilityLabel(mode: {
  readonly title: string;
  readonly availability?: ModeAvailability;
  readonly purpose: string;
  readonly structure: string;
  readonly facts?: string;
  readonly playable: boolean;
  readonly reason?: string;
}): string {
  const notice = modeNotice(mode);
  const parts = [mode.title];
  if (mode.availability !== undefined) parts.push(modeBadge(mode.availability).label);
  parts.push(mode.purpose, mode.structure);
  if (mode.facts !== undefined && mode.facts !== "") parts.push(mode.facts);
  if (notice !== null) parts.push(notice.text);
  // Full stops between the parts, so a screen reader pauses rather than running
  // "High stakesNeeds an account" together.
  return parts.map((part) => (part.endsWith(".") ? part : `${part}.`)).join(" ");
}

/**
 * The hint, which describes what happens when the card is activated.
 *
 * Separate from the label on purpose: a hint answers "what will this do?", and
 * VoiceOver speaks it after a pause and only when hints are enabled. Nothing a
 * player needs in order to CHOOSE belongs here — that is the label's job.
 */
export function modeAccessibilityHint(mode: { readonly playable: boolean }): string {
  return mode.playable ? "Opens this mode" : "Not available in this build";
}
