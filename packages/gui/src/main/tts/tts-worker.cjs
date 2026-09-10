// Herta neural-voice worker (ADR 0042) — runs in an Electron utilityProcess
// so native sherpa-onnx inference never blocks the main or renderer thread,
// and a native-addon crash is isolated to (and restartable in) this process.
//
// It is a PLAIN .cjs shipped as-is (never bundled — rollup cannot bundle a
// native addon): electron-vite copies it to out/main, and the coordinator
// forks it by absolute path. sherpa-onnx-node is required from the ABSOLUTE
// path the main process resolves and passes in `init`, so this file is
// independent of the packaged app's module-resolution layout (asar, pnpm
// symlinks, extraResources) — the one thing that reliably breaks otherwise.
//
// Protocol (see synthesizer.ts). `init` names the bundle root, the model
// file inside it, the runtime path and the comm-channel effect; requests are
// processed one at a time (a single OfflineTts handle is not reentrant);
// `cancel` drops an utterance's not-yet-started requests. Audio crosses back
// as Int16 PCM with the effect already applied.

"use strict";

const path = require("node:path");
// The comm-channel ("station terminal") treatment — the voice repo's
// examples/node/comm-channel-effect.cjs, vendored verbatim beside this file
// and emitted next to it by electron.vite.config.ts. Pure JS, whole-unit,
// deterministic; ~5 ms per second of audio.
const { COMM_CHANNEL_PRESETS, applyCommChannel } = require(
  path.join(__dirname, "comm-channel-effect.cjs"),
);
// Punctuation placeholders that keep a Chinese sentence ONE model sequence
// inside sherpa (see sherpa-punctuation.cjs). Used only when the bundle's
// lexicon carries the placeholder rows; otherwise the text goes as is.
const { createSherpaTextMapper } = require(
  path.join(__dirname, "sherpa-punctuation.cjs"),
);

let tts = null;
let sherpa = null;
/** Comm-channel preset applied to every unit, or "none" for the dry voice. */
let effect = "none";
/** Text mapper built from the bundle's lexicons at init (see
 *  sherpa-punctuation.cjs); `punctuation` false = the text goes as is. */
let mapper = { punctuation: false, english: false, toSherpaText: (t) => t };
/** FIFO of { id, utteranceId, seq, text, lang, low }. A `low` entry (the
 *  veto reaction's filler, ADR 0042 §7b) waits until no normal entry is
 *  queued — it must never delay the reply's own sentences. */
const queue = [];
/** The next entry to synthesize: the first normal one, else the head. */
function takeNext() {
  const normal = queue.findIndex((req) => req.low !== true);
  const at = normal >= 0 ? normal : 0;
  return queue.splice(at, 1)[0];
}
/** Utterance ids whose queued (not-yet-started) work should be dropped. */
const cancelled = new Set();
let draining = false;

// NOTE: no transfer list. Electron's MessagePortMain.postMessage accepts only
// MessagePortMain[] there — an ArrayBuffer in that argument throws. The audio
// is structured-CLONED instead, which is cheap at this scale: 24 kHz mono
// Int16 is 48 KB per second, so a 5-second sentence copies ~240 KB.
function reply(message) {
  process.parentPort.postMessage(message);
}

/**
 * sherpa's espeak build can mishandle non-ASCII ABSOLUTE paths on Windows,
 * so the worker sets its cwd to the model root and passes RELATIVE paths —
 * exactly what examples/node/synthesize.cjs does. `nativePath` normalizes a
 * path under cwd to a forward-slash relative form.
 */
function nativePath(file) {
  const rel = path.relative(process.cwd(), file);
  const selected =
    rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
  return selected.split(path.sep).join("/");
}

function createTts(modelRoot, modelFile) {
  const frontend = path.join(modelRoot, "frontend");
  return new sherpa.OfflineTts({
    model: {
      kokoro: {
        model: nativePath(path.join(modelRoot, modelFile)),
        voices: nativePath(path.join(modelRoot, "voices.bin")),
        tokens: nativePath(path.join(frontend, "tokens.txt")),
        dataDir: nativePath(path.join(frontend, "espeak-ng-data")),
        lexicon: [
          nativePath(path.join(frontend, "lexicon-us-en.txt")),
          nativePath(path.join(frontend, "lexicon-zh.txt")),
        ].join(","),
      },
      debug: false,
      numThreads: Math.max(
        1,
        Math.min(4, require("node:os").availableParallelism()),
      ),
      provider: "cpu",
    },
    ruleFsts: ["phone-zh.fst", "date-zh.fst", "number-zh.fst"]
      .map((name) => nativePath(path.join(frontend, name)))
      .join(","),
    maxNumSentences: 1,
  });
}

function toInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      // Yield first so a `cancel` posted while the previous (blocking)
      // synthesis ran is processed before the next unit starts.
      await new Promise((r) => setImmediate(r));
      const req = takeNext();
      if (req === undefined) break;
      if (cancelled.has(req.utteranceId)) {
        reply({ type: "synthError", id: req.id, cancelled: true });
        continue;
      }
      try {
        // silenceScale 1.0 = the model's own pauses. sherpa's DEFAULT is 0.2
        // (the voice repo's example copies it), and sherpa applies it to every
        // pause it detects in the rendered audio: on the sample sentence it
        // cut 1.0 s of pauses out of a 5.0 s render, and the owner heard the
        // result as "obviously degraded" against the Python-side listening
        // reference (2026-09-05). At 1.0 sherpa's output is the raw model
        // output to the millisecond.
        const gc = new sherpa.GenerationConfig({
          sid: 0,
          speed: 1.0,
          silenceScale: 1.0,
        });
        // SYNCHRONOUS generate, not generateAsync. Under Electron's
        // utilityProcess the addon's async worker rejects every call with
        // "TTS settlement failed" (live run, 2026-08-22) while the same call
        // succeeds under plain Node — its NAPI deferred cannot settle in this
        // host. Blocking is the right answer here anyway: this process exists
        // so that synthesis has a thread of its own to block, and the loop
        // yields between units below so `cancel` still lands promptly.
        const audio = tts.generate({
          text:
            mapper.punctuation && req.lang === "zh"
              ? mapper.toSherpaText(req.text)
              : req.text,
          generationConfig: gc,
          // Electron's V8 refuses EXTERNAL ArrayBuffers ("External buffers
          // are not allowed", live run 2026-08-22) — the addon's default.
          // This asks it to copy the samples into an ordinary buffer
          // instead; the copy is one float array per sentence.
          enableExternalBuffer: false,
        });
        // A cancel that landed WHILE this synthesized: discard the result.
        if (cancelled.has(req.utteranceId)) {
          reply({ type: "synthError", id: req.id, cancelled: true });
          continue;
        }
        // The terminal treatment, per unit. Whole-utterance DSP by design
        // (its makeup gain and noise envelope are computed over the unit),
        // and the sample count is unchanged, so the reveal's timing is the
        // synthesis timing.
        const wet =
          effect === "none"
            ? audio.samples
            : applyCommChannel(audio.samples, audio.sampleRate, {
                preset: effect,
              });
        const samples = toInt16(wet);
        const durationMs = (wet.length / audio.sampleRate) * 1000;
        reply({
          type: "audio",
          id: req.id,
          samples,
          sampleRate: audio.sampleRate,
          durationMs,
        });
      } catch (err) {
        reply({
          type: "synthError",
          id: req.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    draining = false;
  }
}

process.parentPort.on("message", (evt) => {
  const data = evt.data;
  if (data.type === "init") {
    try {
      if (typeof data.modelFile !== "string" || data.modelFile === "") {
        throw new Error("init without a modelFile");
      }
      const wanted = typeof data.effect === "string" ? data.effect : "none";
      if (wanted !== "none" && COMM_CHANNEL_PRESETS[wanted] === undefined) {
        throw new Error(`unknown comm-channel effect "${wanted}"`);
      }
      effect = wanted;
      sherpa = require(data.sherpaPath);
      process.chdir(data.modelRoot);
      const fs = require("node:fs");
      const frontend = path.join(data.modelRoot, "frontend");
      const readText = (name) => {
        try {
          return fs.readFileSync(path.join(frontend, name), "utf8");
        } catch {
          return "";
        }
      };
      mapper = createSherpaTextMapper({
        lexiconZhText: readText("lexicon-zh.txt"),
        lexiconEnText: readText("lexicon-us-en.txt"),
      });
      tts = createTts(data.modelRoot, data.modelFile);
      reply({
        type: "ready",
        sampleRate: tts.sampleRate,
        effect,
        placeholders: mapper.punctuation,
        english: mapper.english,
      });
    } catch (err) {
      reply({
        type: "initError",
        message:
          err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    }
    return;
  }
  if (data.type === "synth") {
    if (tts === null) {
      reply({
        type: "synthError",
        id: data.id,
        message: "worker not initialized",
      });
      return;
    }
    cancelled.delete(data.utteranceId); // a fresh request re-arms the utterance
    queue.push({
      id: data.id,
      utteranceId: data.utteranceId,
      seq: data.seq,
      text: data.text,
      lang: data.lang,
      low: data.low === true,
    });
    void drain();
    return;
  }
  if (data.type === "cancel") {
    cancelled.add(data.utteranceId);
    // Drop this utterance's queued (not-yet-started) requests immediately.
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].utteranceId === data.utteranceId) {
        reply({ type: "synthError", id: queue[i].id, cancelled: true });
        queue.splice(i, 1);
      }
    }
    return;
  }
  if (data.type === "shutdown") {
    process.exit(0);
  }
});
