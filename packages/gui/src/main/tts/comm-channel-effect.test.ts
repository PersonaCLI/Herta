import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The comm-channel effect is a vendored CJS module (the voice repo's
 * `examples/node/comm-channel-effect.cjs`, kept byte-for-byte so its parity
 * record — max discrepancy 0.00003685 against the 13 approved auditions —
 * still describes what ships). These are that repo's own tests, ported, so a
 * re-vendor that changes behaviour fails here rather than in the listener's
 * ear. Loaded through `require` because that is how the worker loads it.
 */
const require = createRequire(import.meta.url);
const { applyCommChannel, COMM_CHANNEL_PRESETS } =
  require("./comm-channel-effect.cjs") as {
    applyCommChannel: (
      samples: ArrayLike<number>,
      sampleRate: number,
      options?: { preset?: string; noiseRelativeDb?: number },
    ) => Float32Array;
    COMM_CHANNEL_PRESETS: Record<string, object>;
  };

describe("comm-channel effect (vendored)", () => {
  // The tests that run the DSP are CPU-bound over seconds of 24/48 kHz audio
  // and scale with machine load: the textured test takes ~0.6 s alone and
  // took 5.7 s under full-suite contention — past vitest's 5 s default — and
  // the four preset × rate sweeps sit at 0.25–0.4 s alone, within the same
  // slowdown's reach. Fixtures stay as the upstream tests have them (the
  // textured test's silent second is what lets the gate's 60 ms release reach
  // silence before the tail); the bound is each test's own.
  const DSP_TEST_TIMEOUT_MS = 30_000;

  it("offers the shipped preset and the older clean one", () => {
    expect(Object.keys(COMM_CHANNEL_PRESETS).sort()).toEqual([
      "terminal",
      "terminal_textured",
    ]);
  });

  for (const sampleRate of [24000, 48000]) {
    for (const preset of ["terminal", "terminal_textured"]) {
      it(
        `${preset} @ ${sampleRate}: silence stays silent, output is finite and length-preserving, input untouched`,
        () => {
          expect(applyCommChannel([], sampleRate, { preset })).toHaveLength(0);
          const silence = new Float32Array(sampleRate / 2);
          expect(applyCommChannel(silence, sampleRate, { preset })).toEqual(
            silence,
          );
          const x = Float32Array.from(
            { length: sampleRate / 2 },
            (_, i) => 0.25 * Math.sin((2 * Math.PI * 1200 * i) / sampleRate),
          );
          const copy = x.slice();
          const y = applyCommChannel(x, sampleRate, { preset });
          expect(y).toHaveLength(x.length);
          expect(x).toEqual(copy);
          expect(y.every((v) => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(
            true,
          );
        },
        DSP_TEST_TIMEOUT_MS,
      );
    }
  }

  it(
    "the textured preset is deterministic, differs from the clean one, and its noise decays in silence",
    () => {
      const rate = 24000;
      const x = Float32Array.from({ length: rate * 2 }, (_, i) =>
        i < rate ? 0.2 * Math.sin((2 * Math.PI * 1200 * i) / rate) : 0,
      );
      const a = applyCommChannel(x, rate, { preset: "terminal_textured" });
      expect(a).toEqual(
        applyCommChannel(x, rate, { preset: "terminal_textured" }),
      );
      expect(a).not.toEqual(applyCommChannel(x, rate, { preset: "terminal" }));
      // No perpetual hiss: the last 100 ms of a silent tail is silent.
      expect(a.slice(-2400).every((v) => Math.abs(v) < 1e-7)).toBe(true);
    },
    DSP_TEST_TIMEOUT_MS,
  );

  it("keeps the unit's sample count — the reveal's timing IS the synthesis timing", () => {
    const rate = 24000;
    const x = Float32Array.from(
      { length: 12345 },
      (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate),
    );
    expect(
      applyCommChannel(x, rate, { preset: "terminal_textured" }),
    ).toHaveLength(12345);
  });

  it("rejects what it cannot process, loudly", () => {
    expect(() => applyCommChannel([Number.NaN], 24000)).toThrow();
    expect(() => applyCommChannel([0], 8000)).toThrow();
    expect(() => applyCommChannel([0], 24000, { preset: "missing" })).toThrow();
    expect(() =>
      applyCommChannel([0], 24000, {
        preset: "terminal_textured",
        noiseRelativeDb: Number.POSITIVE_INFINITY,
      }),
    ).toThrow();
  });
});
