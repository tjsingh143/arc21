/**
 * Arc 21 — the device audio sink.
 *
 * Separate from `audio.ts` because `expo-audio` has no native backing under
 * Node, and `audio.ts` is imported by table code that the unit suite drives. The
 * split is what lets the tests assert which cues a hand asks for without a
 * simulator.
 *
 * THREE THINGS THIS GETS RIGHT ON PURPOSE
 *
 * The iOS silent switch is honoured. `playsInSilentMode: false` means a phone
 * set to silent stays silent, which is the behaviour a person expects from every
 * app that is not a media player. A card game that ignores it is the reason
 * people play with the volume down.
 *
 * Other audio keeps playing. The mode mixes rather than taking the session, so
 * a podcast or a music app is not interrupted or ducked by a chip tap.
 *
 * Players are pooled and never allocated per cue. A hand can ask for four card
 * sounds in 240 ms; creating a player each time is an allocation and a decode on
 * the hot path, and the specification asks for short audio to be pooled.
 */

import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";

import type { AudioSink, SoundName } from "./audio.js";

/**
 * The asset table.
 *
 * `require` rather than a computed path: Metro resolves these at build time, so
 * a missing file is a bundling error rather than a cue that silently does
 * nothing on a device.
 */
const SOURCES: Record<SoundName, number> = {
  cardDeal: require("../../../assets/audio/cardDeal.wav"),
  cardFlip: require("../../../assets/audio/cardFlip.wav"),
  chipTap: require("../../../assets/audio/chipTap.wav"),
  buttonPress: require("../../../assets/audio/buttonPress.wav"),
  win: require("../../../assets/audio/win.wav"),
  blackjack: require("../../../assets/audio/blackjack.wav"),
  loss: require("../../../assets/audio/loss.wav"),
  tournamentAdvance: require("../../../assets/audio/tournamentAdvance.wav"),
  friendInvite: require("../../../assets/audio/friendInvite.wav"),
};

/**
 * How many players each cue keeps.
 *
 * Cards overlap — a four-card deal staggers at 60 ms while each sound runs for
 * 120 ms — so a single player would cut its own tail off on every second card.
 * Everything else is one at a time by nature.
 */
const VOICES: Partial<Record<SoundName, number>> = {
  cardDeal: 3,
  chipTap: 2,
};

export class ExpoAudioSink implements AudioSink {
  readonly #pools = new Map<SoundName, AudioPlayer[]>();
  readonly #cursors = new Map<SoundName, number>();

  play(name: SoundName): void {
    const pool = this.#pool(name);
    if (pool.length === 0) return;

    const cursor = (this.#cursors.get(name) ?? 0) % pool.length;
    this.#cursors.set(name, cursor + 1);

    const player = pool[cursor];
    if (!player) return;

    try {
      // Rewind first: a player asked to play while already playing does nothing
      // on some platforms, which loses the second card of a deal.
      player.seekTo(0);
      player.play();
    } catch {
      // A cue is never load-bearing. A failed sound must not interrupt a hand.
    }
  }

  async preload(names: readonly SoundName[]): Promise<void> {
    for (const name of names) this.#pool(name);
    return Promise.resolve();
  }

  /** Releases native players. Called when the app tears the sink down. */
  release(): void {
    for (const pool of this.#pools.values()) {
      for (const player of pool) {
        try {
          player.remove();
        } catch {
          // Already gone.
        }
      }
    }
    this.#pools.clear();
    this.#cursors.clear();
  }

  #pool(name: SoundName): AudioPlayer[] {
    const existing = this.#pools.get(name);
    if (existing) return existing;

    const created: AudioPlayer[] = [];
    try {
      for (let i = 0; i < (VOICES[name] ?? 1); i++) {
        created.push(createAudioPlayer(SOURCES[name]));
      }
    } catch {
      // A build without the native module. An empty pool plays nothing, which
      // is the correct degradation for sound.
    }
    this.#pools.set(name, created);
    return created;
  }
}

/**
 * Configures the audio session.
 *
 * Best-effort: a failure here means cues may not play, which is not a reason to
 * stop the app from starting.
 */
export async function configureAudioSession(): Promise<void> {
  try {
    await setAudioModeAsync({
      // The silent switch is respected. This is a game, not a media player.
      playsInSilentMode: false,
      shouldPlayInBackground: false,
      // Never take the audio session from whatever the player is listening to.
      // One field, both platforms — `interruptionModeAndroid` is deprecated.
      interruptionMode: "mixWithOthers",
    });
  } catch {
    // Older platform, or no native module. Cues degrade to silence.
  }
}
