/**
 * Arc 21 — sound.
 *
 * The palette is deliberately tiny: a card, a chip, a win, a blackjack. No
 * casino crowd, no slot jingles, no coins raining. Music is not shipped at all —
 * the specification allows one understated ambient loop defaulting to off, and
 * "off by default and absent" is the same thing to a player with less to go
 * wrong.
 *
 * EVERY CUE IS ORIGINALLY GENERATED. `scripts/generate-audio.ts` synthesises all
 * nine from oscillators, envelopes and filtered noise written in this
 * repository — nothing sampled, bought, borrowed or traced — and the output is
 * deterministic, so regenerating produces byte-identical files.
 * `docs/ASSET_LICENSES.md` records them; `tests/audio/` asserts their contents.
 *
 * The indirection through a sink is not ceremony. `expo-audio` has no native
 * backing under Node, and this module is imported by the same table code the
 * unit tests drive, so tests install `RecordingAudioSink` and assert which cues
 * a hand asks for without a device.
 */

export type SoundName =
  | "cardDeal"
  | "cardFlip"
  | "chipTap"
  | "buttonPress"
  | "win"
  | "blackjack"
  | "loss"
  | "tournamentAdvance"
  | "friendInvite";

/**
 * Every cue, in one list.
 *
 * Exported so the asset table, the preloader and the tests all derive from the
 * same source rather than three drifting copies — a missing entry is then a
 * compile error rather than a cue that silently never plays.
 */
export const SOUND_NAMES: readonly SoundName[] = [
  "cardDeal",
  "cardFlip",
  "chipTap",
  "buttonPress",
  "win",
  "blackjack",
  "loss",
  "tournamentAdvance",
  "friendInvite",
];

export interface AudioSink {
  play(name: SoundName): void;
  preload(names: readonly SoundName[]): Promise<void>;
}

/**
 * The sink before a device one is installed, and the one the tests run against
 * by default. Silent by construction — it cannot accidentally play the wrong
 * thing, and it costs nothing per call.
 */
export class SilentAudioSink implements AudioSink {
  play(): void {}
  async preload(): Promise<void> {}
}

/** Records calls so tests can assert the table asks for the right sounds. */
export class RecordingAudioSink implements AudioSink {
  readonly played: SoundName[] = [];
  play(name: SoundName): void {
    this.played.push(name);
  }
  async preload(): Promise<void> {}
}

let sink: AudioSink = new SilentAudioSink();
let enabled = true;

export function setAudioSink(next: AudioSink): void {
  sink = next;
}

/** Wired to the Settings toggle. */
export function setSoundEnabled(next: boolean): void {
  enabled = next;
}

export function soundEnabled(): boolean {
  return enabled;
}

export function playSound(name: SoundName): void {
  if (!enabled) return;
  try {
    sink.play(name);
  } catch {
    // Sound is never load-bearing. A failed cue must not interrupt a hand.
  }
}

/**
 * Frequently used cues are preloaded so the first card of a session does not
 * stutter while a file decodes.
 */
export async function preloadTableSounds(): Promise<void> {
  try {
    await sink.preload(["cardDeal", "cardFlip", "chipTap", "buttonPress", "win", "loss"]);
  } catch {
    // Preloading is an optimisation, not a requirement.
  }
}

/**
 * Maps a settled hand to its cue.
 *
 * Alongside `hapticForOutcome`, and for the same reason: the mapping from an
 * outcome to how it is signalled lives in one place, so sound and haptics cannot
 * disagree about what just happened. A push and a surrender are silent — not
 * every outcome needs a noise, and a push in particular is the game saying
 * nothing happened.
 */
export function soundForOutcome(kind: string): void {
  switch (kind) {
    case "BLACKJACK":
      playSound("blackjack");
      break;
    case "WIN":
      playSound("win");
      break;
    case "BUST":
    case "LOSS":
      playSound("loss");
      break;
    default:
      break;
  }
}
