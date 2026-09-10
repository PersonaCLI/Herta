import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  SpeechSynthesizer,
  SynthesisRequest,
  SynthesizedAudio,
} from "@herta/app-server";
import { type UtilityProcess, utilityProcess } from "electron";
import { TTS_EFFECT, TTS_MODEL_FILE, ttsBundleComplete } from "./tts-path.js";

/**
 * Herta's neural-voice coordinator (ADR 0042) — the main-process half of the
 * synthesizer the app-server's streaming sink drives.
 *
 * It owns ONE `utilityProcess` running `tts-worker.cjs`: native ONNX
 * inference must not run on the main or renderer thread (model load and
 * per-sentence synthesis block long enough to stutter the UI), and a native
 * addon crash must be isolated and restartable rather than fatal.
 *
 * Everything here is best-effort by construction. Voice is an enhancement
 * layered over the paced text reveal, never load-bearing for the record:
 *   - `available()` is false unless the bundle is complete, the runtime was
 *     found, the user has it enabled, and the worker has not failed for
 *     good — the sink then simply uses the text reveal.
 *   - a `synthesize` that fails, is cancelled, or outlives its deadline
 *     resolves `null`, and the reveal types that one unit unvoiced.
 *   - a worker crash rejects everything in flight, and the NEXT request
 *     starts a fresh worker (bounded — see `MAX_RESTARTS`).
 *
 * The worker is started lazily on the first request, so an install that
 * never speaks never pays the ~6 s model load or the ~200 MB of resident
 * memory.
 */

/** Worker failures allowed per app run — a start that never reaches
 *  `ready`, or a crash after it (2026-09-10: only failed starts were
 *  counted, so an addon that died on every `generate` was re-forked and
 *  reloaded the model on every sentence, forever). Past this the voice
 *  stays off until the app is relaunched: a worker that dies repeatedly is
 *  a broken install (missing native lib, incompatible CPU), and retrying
 *  forever would spend seconds of model load on every sentence. */
const MAX_RESTARTS = 3;

/** How long one unit may take before the reveal gives up on it and types
 *  that unit unvoiced. Generous: the non-VNNI reference CPU (i7-9750H)
 *  measures RTF ~0.55 on the e72 graph — a long sentence is ~5 s of
 *  synthesis — and the model load (~3.5 s) rides on the FIRST request. The
 *  budget is kept at the e30 numbers (RTF ~0.8, ~6 s load) on purpose: a
 *  slower CPU than the reference one is the case the cap exists for. */
const REQUEST_TIMEOUT_MS = 25_000;
const FIRST_REQUEST_TIMEOUT_MS = 45_000;
/** How long the worker may take to answer `init` with `ready` (the model
 *  load). A worker that neither answers nor exits — a native hang in
 *  `createTts`, a stalled read from a network drive — used to leave the
 *  first request pending with no deadline at all (the per-unit timer was
 *  armed only after the start), and the reply with it until the stop click
 *  (2026-09-10). Counts against MAX_RESTARTS like any failed start. */
const INIT_TIMEOUT_MS = FIRST_REQUEST_TIMEOUT_MS;
/** Utterances whose synthesis fell behind are remembered so their later
 *  units answer null at once; bounded, and utterance ids are never
 *  reused, so the oldest are simply forgotten. */
const MAX_ABANDONED = 32;

type WorkerMessage =
  | {
      readonly type: "ready";
      readonly sampleRate: number;
      readonly effect?: string;
    }
  | { readonly type: "initError"; readonly message: string }
  | {
      readonly type: "audio";
      readonly id: number;
      readonly samples: Int16Array;
      readonly sampleRate: number;
      readonly durationMs: number;
    }
  | {
      readonly type: "synthError";
      readonly id: number;
      readonly message?: string;
      readonly cancelled?: boolean;
    };

interface Pending {
  readonly resolve: (a: SynthesizedAudio | null) => void;
  readonly timer: NodeJS.Timeout;
  readonly utteranceId: string;
}

export interface TtsSynthesizerOpts {
  /** Candidate bundle roots in priority order (see `resolveTtsModelRoots`);
   *  the first COMPLETE one is used, re-probed on `refreshBundle()` because
   *  the bundle is a download now (ADR 0061) and can appear or go while the
   *  app runs. */
  readonly modelRoots: readonly string[];
  /** The ONNX graph inside the bundle. Default `TTS_MODEL_FILE`. */
  readonly modelFile?: string;
  /** Comm-channel preset the worker applies to every unit (`"none"` for
   *  the dry voice). Default `TTS_EFFECT` — the station-terminal sound. */
  readonly effect?: string;
  /** Absolute path to `tts-worker.cjs` in the built output. */
  readonly workerPath: string;
  /** Absolute path to the `sherpa-onnx-node` entry module, or null when the
   *  runtime could not be located (see `resolveSherpaEntry`). */
  readonly sherpaPath: string | null;
  /** The live user setting (Settings → Voice → 实时语音). Read per call, so
   *  a toggle applies to the very next speech stream with no restart. */
  readonly enabled: () => boolean;
  /** Diagnostics sink; defaults to console. Content-free by contract — the
   *  text being synthesized is never logged (memory discipline). */
  readonly log?: (line: string) => void;
}

export interface TtsSynthesizer extends SpeechSynthesizer {
  /** Stop the worker and reject everything in flight. Idempotent. */
  dispose(): void;
  /** Stop the worker (rejecting everything in flight) WITHOUT disposing: the
   *  next request forks a fresh one. For a bundle about to be deleted — the
   *  worker holds its files open — and not counted as a restart. */
  stopWorker(): void;
  /** Re-probe the candidate roots (ADR 0061: after a download landed or a
   *  bundle was removed). Returns whether a complete bundle is present; a
   *  worker running on a root that changed is stopped. */
  refreshBundle(): boolean;
  /** Diagnostics for the Settings pane / tests. */
  status(): {
    readonly bundle: boolean;
    readonly runtime: boolean;
    readonly enabled: boolean;
    readonly failed: boolean;
    readonly running: boolean;
    /** The root in use, or null without a complete bundle. */
    readonly modelRoot: string | null;
  };
}

export function createTtsSynthesizer(opts: TtsSynthesizerOpts): TtsSynthesizer {
  const log =
    opts.log ?? ((line: string) => console.log(`[herta-tts] ${line}`));
  // Probed at construction and again on `refreshBundle()`: the bundle is a
  // DOWNLOAD (ADR 0061), so it can appear — or be removed — while the app
  // runs. The first complete root wins (the downloaded copy before the dev
  // workspace's).
  const firstComplete = (): string | null =>
    opts.modelRoots.find((r) => ttsBundleComplete(r)) ?? null;
  let activeRoot = firstComplete();
  let bundleOk = activeRoot !== null;
  const runtimeOk = opts.sherpaPath !== null;
  if (!bundleOk) {
    log(`no model bundle under ${opts.modelRoots.join(" | ")} — voice off`);
  }
  if (!runtimeOk) log("sherpa-onnx-node not found — voice disabled");

  let worker: UtilityProcess | null = null;
  let ready: Promise<void> | null = null;
  let restarts = 0;
  let failed = false;
  let disposed = false;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  /** Utterances cancelled while their worker request was still in flight. */
  const cancelledUtterances = new Set<string>();
  /**
   * Utterances a unit of which timed out (2026-09-10). The worker drains
   * its queue in order on one thread, so once one unit has fallen a whole
   * deadline behind, every later unit of the same utterance is queued
   * behind the same slow work and would each wait out the same 25 s while
   * the worker burned a core on audio nobody would play — and the NEXT
   * reply queued behind all of it. Instead the whole utterance is
   * abandoned at the first timeout: its in-flight units resolve null now,
   * the worker drops what it has not started, and its later units answer
   * null without a request. The reply types unvoiced from there.
   */
  const abandoned = new Set<string>();

  const settle = (id: number, audio: SynthesizedAudio | null): void => {
    const p = pending.get(id);
    if (p === undefined) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(audio);
  };

  const rejectAll = (): void => {
    for (const id of [...pending.keys()]) settle(id, null);
  };

  /** Resolve an utterance's in-flight requests null and tell the worker to
   *  drop its queued ones — a veto, an interrupt, or a unit that fell too
   *  far behind. */
  const cancelUtterance = (utteranceId: string): void => {
    cancelledUtterances.add(utteranceId);
    for (const [id, p] of [...pending.entries()]) {
      if (p.utteranceId === utteranceId) settle(id, null);
    }
    try {
      worker?.postMessage({ type: "cancel", utteranceId });
    } catch {
      // worker already gone — nothing queued to drop
    }
  };

  const abandon = (utteranceId: string): void => {
    abandoned.add(utteranceId);
    while (abandoned.size > MAX_ABANDONED) {
      const oldest = abandoned.values().next().value;
      if (oldest === undefined) break;
      abandoned.delete(oldest);
    }
    cancelUtterance(utteranceId);
  };

  /** One more failure against the budget; past it the voice is off for
   *  the run. */
  const countFailure = (what: string): void => {
    restarts += 1;
    if (restarts >= MAX_RESTARTS) {
      failed = true;
      log(`giving up after ${restarts} ${what} — voice off this run`);
    }
  };

  const teardown = (): void => {
    if (worker !== null) {
      try {
        worker.postMessage({ type: "shutdown" });
      } catch {
        // already gone
      }
      try {
        worker.kill();
      } catch {
        // already gone
      }
    }
    worker = null;
    ready = null;
  };

  const start = (): Promise<void> => {
    if (ready !== null) return ready;
    const modelRoot = activeRoot;
    if (modelRoot === null) {
      return Promise.reject(new Error("no complete model bundle"));
    }
    ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      // The model load's own deadline (see INIT_TIMEOUT_MS): a worker that
      // neither answers nor exits is torn down by the catch below and
      // counted like a failed start.
      const initDeadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        log(`worker did not become ready within ${INIT_TIMEOUT_MS} ms`);
        reject(new Error("worker init timed out"));
      }, INIT_TIMEOUT_MS);
      const child = utilityProcess.fork(opts.workerPath, [], {
        serviceName: "herta-tts",
        stdio: "ignore",
        env: {
          ...process.env,
          // macOS/Linux prebuilts co-locate their shared libraries with the
          // .node. The addon's own loader resolves them by rpath in the
          // normal case; these are the documented fallback for builds where
          // it does not (see sherpa-onnx-node/addon.js's error text).
          ...(opts.sherpaPath !== null
            ? libraryPathEnv(dirname(opts.sherpaPath))
            : {}),
        },
      });
      worker = child;
      child.on("message", (msg: WorkerMessage) => {
        if (msg.type === "ready") {
          if (!settled) {
            settled = true;
            clearTimeout(initDeadline);
            log(
              `worker ready (sampleRate ${msg.sampleRate}, effect ${msg.effect ?? "none"})`,
            );
            resolve();
          }
          return;
        }
        if (msg.type === "initError") {
          log(`worker init failed: ${msg.message}`);
          if (!settled) {
            settled = true;
            clearTimeout(initDeadline);
            reject(new Error(msg.message));
          }
          return;
        }
        if (msg.type === "audio") {
          const p = pending.get(msg.id);
          // A cancel that landed while this synthesized: discard the audio.
          if (p !== undefined && cancelledUtterances.has(p.utteranceId)) {
            settle(msg.id, null);
            return;
          }
          settle(msg.id, {
            samples: msg.samples,
            sampleRate: msg.sampleRate,
            durationMs: msg.durationMs,
          });
          return;
        }
        if (msg.type === "synthError") {
          if (msg.cancelled !== true && msg.message !== undefined) {
            log(`synthesis failed: ${msg.message}`);
          }
          settle(msg.id, null);
        }
      });
      child.on("exit", (code) => {
        // Ours, or one `teardown` already let go of (a stop, a bundle
        // change, a dispose — none of which is a failure).
        const ours = worker === child;
        if (ours) {
          worker = null;
          ready = null;
        }
        rejectAll();
        if (disposed) return;
        log(`worker exited (code ${code})`);
        if (!settled) {
          settled = true;
          clearTimeout(initDeadline);
          reject(new Error(`worker exited during init (code ${code})`));
          return; // counted by the start's catch below
        }
        // A crash AFTER a successful start — the addon died on a sentence.
        if (ours) countFailure("worker crashes");
      });
      child.postMessage({
        type: "init",
        modelRoot,
        modelFile: opts.modelFile ?? TTS_MODEL_FILE,
        effect: opts.effect ?? TTS_EFFECT,
        sherpaPath: opts.sherpaPath,
      });
    });
    // A failed start counts against the restart budget and clears `ready`
    // so the next request may try again (up to MAX_RESTARTS).
    ready.catch(() => {
      teardown();
      countFailure("failed starts");
    });
    return ready;
  };

  return {
    available(): boolean {
      return !disposed && bundleOk && runtimeOk && !failed && opts.enabled();
    },

    async synthesize(req: SynthesisRequest): Promise<SynthesizedAudio | null> {
      if (disposed || !bundleOk || !runtimeOk || failed) return null;
      // The rest of an utterance that fell behind types unvoiced at once.
      if (abandoned.has(req.utteranceId)) return null;
      // A request for an utterance re-arms it (a retry / respeak reuses the
      // id space only within one stream, but the cancel latch must not
      // outlive the cancel that set it).
      cancelledUtterances.delete(req.utteranceId);
      const first = worker === null;
      try {
        await start();
      } catch {
        return null;
      }
      const child = worker;
      if (child === null) return null;
      const id = nextId++;
      return new Promise<SynthesizedAudio | null>((resolve) => {
        const timer = setTimeout(
          () => {
            log(
              `request ${id} timed out — the rest of that utterance types unvoiced`,
            );
            abandon(req.utteranceId);
          },
          first ? FIRST_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
        );
        pending.set(id, { resolve, timer, utteranceId: req.utteranceId });
        try {
          child.postMessage({
            type: "synth",
            id,
            utteranceId: req.utteranceId,
            seq: req.seq,
            text: req.text,
            lang: req.lang,
            // The worker's queue lets a normal request pass a low one.
            ...(req.priority === "low" ? { low: true } : {}),
          });
        } catch (err) {
          log(
            `postMessage failed: ${err instanceof Error ? err.message : err}`,
          );
          settle(id, null);
        }
      });
    },

    cancel(utteranceId: string): void {
      // Resolve this utterance's in-flight requests now: the reveal is gone
      // (a veto, an interrupt) and nothing is waiting for the audio.
      cancelUtterance(utteranceId);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      rejectAll();
      teardown();
    },

    stopWorker(): void {
      rejectAll();
      teardown();
    },

    refreshBundle(): boolean {
      const next = firstComplete();
      if (next !== activeRoot && worker !== null) {
        // The worker holds the OLD root's files open; a bundle that moved
        // or went away must not keep answering from a stale process.
        rejectAll();
        teardown();
      }
      activeRoot = next;
      bundleOk = next !== null;
      return bundleOk;
    },

    status() {
      return {
        bundle: bundleOk,
        runtime: runtimeOk,
        enabled: opts.enabled(),
        failed,
        running: worker !== null,
        modelRoot: activeRoot,
      };
    },
  };
}

/** `DYLD_LIBRARY_PATH` / `LD_LIBRARY_PATH` pointing at the runtime's own
 *  directory — the documented fallback for prebuilts whose `.node` does not
 *  carry an rpath to its co-located shared libraries. No-op on Windows,
 *  where the loader searches the module's own directory already. */
function libraryPathEnv(dir: string): NodeJS.ProcessEnv {
  const key =
    process.platform === "darwin"
      ? "DYLD_LIBRARY_PATH"
      : process.platform === "linux"
        ? "LD_LIBRARY_PATH"
        : null;
  if (key === null) return {};
  const existing = process.env[key];
  return {
    [key]:
      existing === undefined || existing === "" ? dir : `${dir}:${existing}`,
  };
}

/**
 * Locate the `sherpa-onnx-node` entry module, or null.
 *
 * The runtime is a NATIVE package, so it can never be bundled into
 * `out/main` the way every other dependency is — it has to exist as real
 * files on disk and be `require`d by the worker at runtime. Two layouts:
 *
 *   - PACKAGED: staged into `<resources>/tts-runtime/` by
 *     `scripts/stage-tts.mjs` at build time (a plain directory copy, so no
 *     asar boundary and no pnpm symlink is in the path at runtime).
 *   - DEV: the workspace's own `node_modules`, reached by walking up from
 *     the built main file. pnpm's layout means the package is a symlink
 *     into `.pnpm`; `require` follows it, and the addon's own sibling
 *     lookup (`../sherpa-onnx-<platform>-<arch>/sherpa-onnx.node`) resolves
 *     inside `.pnpm` where the platform package is a real sibling.
 *
 * A PACKAGED app never walks up (2026-09-10): a wrapper copy that
 * electron-builder had packed into app.asar answered the walk-up on a
 * build whose runtime was not staged — `runtime: true` in the Settings
 * pane, the model downloaded, and then the worker's `require` failed on
 * the addon the asar never held. The staged directory is the only layout a
 * packaged app can load from, so it is the only one it looks at.
 *
 * Pure apart from `existsSync`, so it unit-tests without electron.
 */
export function resolveSherpaEntry(opts: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly startDir: string;
}): string | null {
  const candidates: string[] = [];
  if (opts.isPackaged) {
    candidates.push(
      join(
        opts.resourcesPath,
        "tts-runtime",
        "sherpa-onnx-node",
        "sherpa-onnx.js",
      ),
    );
  } else {
    // Walk up looking for a node_modules that holds the package.
    let dir = opts.startDir;
    for (let i = 0; i < 8; i += 1) {
      candidates.push(
        join(dir, "node_modules", "sherpa-onnx-node", "sherpa-onnx.js"),
      );
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
