/**
 * Arc 21 — the sound palette, synthesised.
 *
 * Every cue this app plays is generated here, from oscillators, envelopes and
 * filtered noise written in this file. No sample is downloaded, bought, borrowed
 * or traced. That is not a stylistic preference: `docs/ASSET_LICENSES.md` makes
 * an unlicensed asset a release blocker, and a generator is the one form of
 * "originally generated" that can be re-derived and audited by anybody who has
 * the repository.
 *
 * The output is DETERMINISTIC — the noise source is a seeded LCG, not
 * `Math.random` — so regenerating produces byte-identical files and a diff means
 * somebody changed the recipe rather than the weather.
 *
 *   npm run audio:generate
 *
 * WHAT THE PALETTE IS NOT
 *
 * No casino crowd. No slot jingle. No coins raining. Nothing longer than half a
 * second. A loss is quieter than a win and gets no sting at all — losing a hand
 * is an ordinary outcome of a fair game, not a mistake to be buzzed at.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SAMPLE_RATE = 22_050;
const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "audio");

// ---------------------------------------------------------------------------
// Signal primitives
// ---------------------------------------------------------------------------

type Signal = Float64Array;

function silence(seconds: number): Signal {
  return new Float64Array(Math.round(seconds * SAMPLE_RATE));
}

/**
 * A deterministic noise source.
 *
 * A plain LCG. The point is not statistical quality — it is feeding a filter —
 * but it must be reproducible, so `Math.random` is not an option even here.
 */
function noiseSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state / 0xffff_ffff) * 2 - 1;
  };
}

/** Exponential decay with a short linear attack — no click at either end. */
function envelope(length: number, attackSeconds: number, decayShape: number): Signal {
  const out = new Float64Array(length);
  const attack = Math.max(1, Math.round(attackSeconds * SAMPLE_RATE));
  for (let i = 0; i < length; i++) {
    const rise = i < attack ? i / attack : 1;
    const position = i / length;
    out[i] = rise * Math.exp(-decayShape * position);
  }
  return out;
}

/** A sine partial added into a buffer, with an optional linear pitch glide. */
function addTone(
  target: Signal,
  params: {
    startSample: number;
    lengthSamples: number;
    frequency: number;
    endFrequency?: number;
    amplitude: number;
    attackSeconds: number;
    decayShape: number;
    /** Relative level of the third harmonic. Adds body without brightness. */
    harmonic?: number;
  },
): void {
  const env = envelope(params.lengthSamples, params.attackSeconds, params.decayShape);
  const endFrequency = params.endFrequency ?? params.frequency;
  let phase = 0;
  let harmonicPhase = 0;

  for (let i = 0; i < params.lengthSamples; i++) {
    const index = params.startSample + i;
    if (index >= target.length) break;

    const position = i / params.lengthSamples;
    const frequency = params.frequency + (endFrequency - params.frequency) * position;
    phase += (2 * Math.PI * frequency) / SAMPLE_RATE;
    harmonicPhase += (2 * Math.PI * frequency * 3) / SAMPLE_RATE;

    const body =
      Math.sin(phase) + (params.harmonic ?? 0) * Math.sin(harmonicPhase);
    target[index] = (target[index] ?? 0) + params.amplitude * (env[i] ?? 0) * body;
  }
}

/**
 * A band-limited noise burst — the sound of card stock moving.
 *
 * A two-pole resonator over white noise, with the centre frequency gliding down
 * over the burst. That downward glide is what makes it read as a card sliding
 * rather than as a hiss.
 */
function addNoiseBurst(
  target: Signal,
  params: {
    startSample: number;
    lengthSamples: number;
    centreStart: number;
    centreEnd: number;
    resonance: number;
    amplitude: number;
    attackSeconds: number;
    decayShape: number;
    seed: number;
  },
): void {
  const env = envelope(params.lengthSamples, params.attackSeconds, params.decayShape);
  const nextNoise = noiseSource(params.seed);
  let previous = 0;
  let beforePrevious = 0;

  for (let i = 0; i < params.lengthSamples; i++) {
    const index = params.startSample + i;
    if (index >= target.length) break;

    const position = i / params.lengthSamples;
    const centre = params.centreStart + (params.centreEnd - params.centreStart) * position;
    const theta = (2 * Math.PI * centre) / SAMPLE_RATE;
    const radius = params.resonance;

    // Standard two-pole resonator: y[n] = x[n] + 2r·cosθ·y[n-1] − r²·y[n-2]
    const input = nextNoise() * (1 - radius);
    const value = input + 2 * radius * Math.cos(theta) * previous - radius * radius * beforePrevious;
    beforePrevious = previous;
    previous = value;

    target[index] = (target[index] ?? 0) + params.amplitude * (env[i] ?? 0) * value;
  }
}

/**
 * Fades both ends, then peak-normalises. In that order.
 *
 * The fade is not cosmetic: a buffer that starts or stops at a non-zero sample
 * clicks on every playback, and a click on every card is the fastest way to make
 * someone turn sound off.
 *
 * Normalising SECOND matters, and the first version got it wrong. A chip tap
 * peaks about a millisecond in, which sat inside the fade-in — so the level was
 * measured before the fade and then quietly reduced by it, and the cue came out
 * at 0.166 where 0.30 was asked for. Measured, not assumed: `tests/audio`
 * asserts the peak of every generated file.
 *
 * The fade-in is deliberately much shorter than the fade-out. Four milliseconds
 * of rise blunts a transient that is only one millisecond long; half a
 * millisecond is enough to start from zero and keeps the attack intact.
 */
function finish(signal: Signal, peak: number): Signal {
  const fadeIn = Math.max(1, Math.round(0.0005 * SAMPLE_RATE));
  const fadeOut = Math.max(1, Math.round(0.004 * SAMPLE_RATE));

  const faded = new Float64Array(signal.length);
  for (let i = 0; i < signal.length; i++) {
    const head = Math.min(1, i / fadeIn);
    const tail = Math.min(1, (signal.length - 1 - i) / fadeOut);
    faded[i] = (signal[i] ?? 0) * head * tail;
  }

  let maximum = 0;
  for (const sample of faded) maximum = Math.max(maximum, Math.abs(sample));
  if (maximum === 0) return faded;

  const scale = peak / maximum;
  for (let i = 0; i < faded.length; i++) faded[i] = (faded[i] ?? 0) * scale;
  return faded;
}

/** 16-bit mono PCM in a canonical 44-byte WAV container. */
function toWav(signal: Signal): Buffer {
  const bytesPerSample = 2;
  const dataBytes = signal.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // format 1 = PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < signal.length; i++) {
    const clamped = Math.max(-1, Math.min(1, signal[i] ?? 0));
    buffer.writeInt16LE(Math.round(clamped * 32_767), 44 + i * bytesPerSample);
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

/** Equal temperament, A4 = 440. Written out so the intervals are readable. */
const NOTE = {
  G3: 196.0,
  A3: 220.0,
  C5: 523.25,
  E5: 659.25,
  G5: 783.99,
  A5: 880.0,
  C6: 1_046.5,
} as const;

/**
 * Peak levels, relative.
 *
 * A win is louder than a card, and a loss is quieter than either. Nothing
 * reaches full scale: these play over a game, not as the game.
 */
const LEVEL = {
  quiet: 0.22,
  soft: 0.3,
  normal: 0.42,
  emphatic: 0.5,
} as const;

const CUES: Record<string, () => Signal> = {
  /** A card sliding onto the felt. Noise, not a tone. */
  cardDeal() {
    const signal = silence(0.12);
    addNoiseBurst(signal, {
      startSample: 0,
      lengthSamples: signal.length,
      centreStart: 2_400,
      centreEnd: 1_100,
      resonance: 0.982,
      amplitude: 1,
      attackSeconds: 0.003,
      decayShape: 7,
      seed: 0x5eed_0001,
    });
    return finish(signal, LEVEL.quiet);
  },

  /** The hole card turning over: two transients, the second softer. */
  cardFlip() {
    const signal = silence(0.18);
    addNoiseBurst(signal, {
      startSample: 0,
      lengthSamples: Math.round(0.07 * SAMPLE_RATE),
      centreStart: 3_000,
      centreEnd: 1_800,
      resonance: 0.978,
      amplitude: 1,
      attackSeconds: 0.002,
      decayShape: 9,
      seed: 0x5eed_0002,
    });
    addNoiseBurst(signal, {
      startSample: Math.round(0.075 * SAMPLE_RATE),
      lengthSamples: Math.round(0.09 * SAMPLE_RATE),
      centreStart: 1_900,
      centreEnd: 900,
      resonance: 0.98,
      amplitude: 0.7,
      attackSeconds: 0.002,
      decayShape: 8,
      seed: 0x5eed_0003,
    });
    return finish(signal, LEVEL.quiet);
  },

  /** A chip set down. Short, woody, no ring. */
  chipTap() {
    const signal = silence(0.08);
    addTone(signal, {
      startSample: 0,
      lengthSamples: signal.length,
      frequency: 2_450,
      endFrequency: 2_100,
      amplitude: 0.8,
      attackSeconds: 0.001,
      decayShape: 16,
    });
    addNoiseBurst(signal, {
      startSample: 0,
      lengthSamples: Math.round(0.02 * SAMPLE_RATE),
      centreStart: 4_200,
      centreEnd: 3_000,
      resonance: 0.95,
      amplitude: 0.5,
      attackSeconds: 0.001,
      decayShape: 12,
      seed: 0x5eed_0004,
    });
    return finish(signal, LEVEL.soft);
  },

  /** Button feedback. Barely there by design — it accompanies a haptic. */
  buttonPress() {
    const signal = silence(0.05);
    addTone(signal, {
      startSample: 0,
      lengthSamples: signal.length,
      frequency: 920,
      amplitude: 1,
      attackSeconds: 0.004,
      decayShape: 11,
    });
    return finish(signal, LEVEL.quiet);
  },

  /** An ordinary win: two notes, a fifth apart, unhurried. */
  win() {
    const signal = silence(0.36);
    const note = Math.round(0.17 * SAMPLE_RATE);
    addTone(signal, {
      startSample: 0,
      lengthSamples: note,
      frequency: NOTE.C5,
      amplitude: 1,
      attackSeconds: 0.008,
      decayShape: 4,
      harmonic: 0.12,
    });
    addTone(signal, {
      startSample: Math.round(0.15 * SAMPLE_RATE),
      lengthSamples: Math.round(0.2 * SAMPLE_RATE),
      frequency: NOTE.G5,
      amplitude: 0.9,
      attackSeconds: 0.008,
      decayShape: 4,
      harmonic: 0.12,
    });
    return finish(signal, LEVEL.normal);
  },

  /**
   * A natural blackjack. The one moment that earns a little more: a major
   * triad and a single high note above it. Still under half a second.
   */
  blackjack() {
    const signal = silence(0.48);
    const step = Math.round(0.085 * SAMPLE_RATE);
    const notes = [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6];
    notes.forEach((frequency, index) => {
      addTone(signal, {
        startSample: index * step,
        lengthSamples: Math.round(0.24 * SAMPLE_RATE),
        frequency,
        amplitude: index === notes.length - 1 ? 0.75 : 0.9,
        attackSeconds: 0.006,
        decayShape: 3.4,
        harmonic: 0.1,
      });
    });
    return finish(signal, LEVEL.emphatic);
  },

  /**
   * A loss.
   *
   * One soft note that falls a whole tone, quieter than the win and with no
   * dissonance in it. There is no sting here, and that is the point.
   */
  loss() {
    const signal = silence(0.26);
    addTone(signal, {
      startSample: 0,
      lengthSamples: signal.length,
      frequency: NOTE.A3,
      endFrequency: NOTE.G3,
      amplitude: 1,
      attackSeconds: 0.012,
      decayShape: 4,
      harmonic: 0.08,
    });
    return finish(signal, LEVEL.quiet);
  },

  /** Advancing in a tournament. Four rising notes, resolved on the octave. */
  tournamentAdvance() {
    const signal = silence(0.56);
    const step = Math.round(0.11 * SAMPLE_RATE);
    [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6].forEach((frequency, index) => {
      addTone(signal, {
        startSample: index * step,
        lengthSamples: Math.round(0.16 * SAMPLE_RATE),
        frequency,
        amplitude: 0.9,
        attackSeconds: 0.008,
        decayShape: 4.5,
        harmonic: 0.1,
      });
    });
    return finish(signal, LEVEL.normal);
  },

  /** A friend invite. A two-note ping, warm rather than urgent. */
  friendInvite() {
    const signal = silence(0.3);
    addTone(signal, {
      startSample: 0,
      lengthSamples: Math.round(0.14 * SAMPLE_RATE),
      frequency: NOTE.E5,
      amplitude: 1,
      attackSeconds: 0.01,
      decayShape: 4.5,
      harmonic: 0.08,
    });
    addTone(signal, {
      startSample: Math.round(0.12 * SAMPLE_RATE),
      lengthSamples: Math.round(0.17 * SAMPLE_RATE),
      frequency: NOTE.A5,
      amplitude: 0.85,
      attackSeconds: 0.01,
      decayShape: 4.5,
      harmonic: 0.08,
    });
    return finish(signal, LEVEL.soft);
  },
};

// ---------------------------------------------------------------------------

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  let total = 0;
  for (const [name, build] of Object.entries(CUES)) {
    const wav = toWav(build());
    writeFileSync(join(OUTPUT_DIR, `${name}.wav`), wav);
    total += wav.byteLength;
    const seconds = ((wav.byteLength - 44) / 2 / SAMPLE_RATE).toFixed(3);
    console.log(`${name.padEnd(20)} ${seconds}s  ${(wav.byteLength / 1024).toFixed(1)} KiB`);
  }
  console.log(`\n${Object.keys(CUES).length} cues, ${(total / 1024).toFixed(1)} KiB total`);
}

/*
 * Only when run directly.
 *
 * `tests/audio` imports `CUES` to re-synthesise every cue and compare it byte
 * for byte with the committed file — which is what makes "the output is
 * deterministic" a checked claim rather than an assertion in a comment. A module
 * that wrote to disk on import would have that test overwrite the very files it
 * is meant to be verifying.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) main();

export { CUES, OUTPUT_DIR, SAMPLE_RATE, toWav };
