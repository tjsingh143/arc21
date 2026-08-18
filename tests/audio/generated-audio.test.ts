/**
 * The sound palette, as committed files.
 *
 * These assert three separate things, and the middle one is the reason the
 * others are worth having:
 *
 *   1. every cue the app can ask for EXISTS as a file, so a `playSound` call
 *      cannot be silently unplayable on a device;
 *   2. every committed file is exactly what the generator produces today — the
 *      claim in `docs/ASSET_LICENSES.md` that the assets are originally
 *      generated is only checkable if regenerating reproduces them byte for
 *      byte;
 *   3. the audio itself is well formed and restrained: a canonical WAV header,
 *      a peak below full scale, silence at both ends, and a loss no louder than
 *      the win it follows.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CUES, OUTPUT_DIR, SAMPLE_RATE, toWav } from "../../scripts/generate-audio.js";
import { SOUND_NAMES } from "../../src/lib/audio/audio.js";

function fileFor(name: string): Buffer {
  return readFileSync(join(OUTPUT_DIR, `${name}.wav`));
}

interface Wav {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  samples: number[];
}

/** A deliberately strict reader: anything unexpected throws rather than coerces. */
function parseWav(buffer: Buffer): Wav {
  expect(buffer.toString("ascii", 0, 4)).toBe("RIFF");
  expect(buffer.toString("ascii", 8, 12)).toBe("WAVE");
  expect(buffer.toString("ascii", 12, 16)).toBe("fmt ");
  expect(buffer.readUInt16LE(20)).toBe(1); // PCM

  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  expect(buffer.toString("ascii", 36, 40)).toBe("data");

  const dataBytes = buffer.readUInt32LE(40);
  expect(dataBytes).toBe(buffer.length - 44);

  const samples: number[] = [];
  for (let i = 0; i < dataBytes / 2; i++) {
    samples.push(buffer.readInt16LE(44 + i * 2) / 32_767);
  }
  return { channels, sampleRate, bitsPerSample, samples };
}

function peakOf(samples: readonly number[]): number {
  return samples.reduce((peak, sample) => Math.max(peak, Math.abs(sample)), 0);
}

const NAMES = Object.keys(CUES);

describe("every cue the app can play exists", () => {
  it("has a file for every SoundName", () => {
    // The union in `audio.ts` is what call sites are checked against; this is
    // what proves the union is not ahead of the assets.
    for (const name of SOUND_NAMES) {
      expect(existsSync(join(OUTPUT_DIR, `${name}.wav`)), name).toBe(true);
    }
  });

  it("generates nothing the app cannot ask for", () => {
    // And not behind, either: a cue with no name is a cue nothing will play.
    expect([...NAMES].sort()).toEqual([...SOUND_NAMES].sort());
  });
});

describe("the committed files are what the generator produces", () => {
  it.each(NAMES)("%s is byte-identical when regenerated", (name) => {
    const build = CUES[name];
    expect(build).toBeDefined();
    // Not "close enough": identical. The noise source is a seeded LCG precisely
    // so this can be an equality rather than a tolerance.
    expect(toWav(build!()).equals(fileFor(name))).toBe(true);
  });
});

describe("the audio is well formed", () => {
  it.each(NAMES)("%s is mono 16-bit PCM at the declared rate", (name) => {
    const wav = parseWav(fileFor(name));
    expect(wav.channels).toBe(1);
    expect(wav.bitsPerSample).toBe(16);
    expect(wav.sampleRate).toBe(SAMPLE_RATE);
  });

  it.each(NAMES)("%s starts and ends at silence", (name) => {
    // A buffer that begins or ends on a non-zero sample clicks on every
    // playback. The fade exists for this; this is what checks it is still there.
    const { samples } = parseWav(fileFor(name));
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(0);
  });

  it.each(NAMES)("%s never reaches full scale", (name) => {
    const { samples } = parseWav(fileFor(name));
    const peak = peakOf(samples);
    expect(peak).toBeGreaterThan(0.1);
    // These play over a game, not as the game.
    expect(peak).toBeLessThanOrEqual(0.5);
  });

  it.each(NAMES)("%s is under half a second", (name) => {
    const { samples } = parseWav(fileFor(name));
    expect(samples.length / SAMPLE_RATE).toBeLessThanOrEqual(0.6);
  });
});

describe("the palette is restrained in the way the specification asks", () => {
  it("makes a loss quieter than a win", () => {
    // "No aggressive red flash, no punitive shake" is about motion; this is the
    // same principle in sound. A loss must never be the loudest thing a player
    // hears.
    const loss = peakOf(parseWav(fileFor("loss")).samples);
    const win = peakOf(parseWav(fileFor("win")).samples);
    const blackjack = peakOf(parseWav(fileFor("blackjack")).samples);

    expect(loss).toBeLessThan(win);
    expect(win).toBeLessThan(blackjack);
  });

  it("makes the cues that repeat most the quietest", () => {
    // A card sound plays four times a hand and a chip tap once per chip. Either
    // one at win volume would be exhausting within a session.
    const card = peakOf(parseWav(fileFor("cardDeal")).samples);
    const win = peakOf(parseWav(fileFor("win")).samples);
    expect(card).toBeLessThan(win);
  });

  it("keeps the whole palette small enough to bundle without thought", () => {
    const total = NAMES.reduce((sum, name) => sum + fileFor(name).length, 0);
    expect(total).toBeLessThan(200 * 1024);
  });
});
