import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Fake utilityProcess: one child per fork, driven by the test. */
interface FakeChild {
  readonly sent: unknown[];
  readonly killed: () => boolean;
  emit(msg: unknown): void;
  exit(code: number): void;
}
const children: FakeChild[] = [];

vi.mock("electron", () => ({
  utilityProcess: {
    fork: () => {
      const handlers = new Map<string, ((a: unknown) => void)[]>();
      const sent: unknown[] = [];
      let dead = false;
      const child = {
        on(event: string, cb: (a: unknown) => void) {
          const list = handlers.get(event) ?? [];
          list.push(cb);
          handlers.set(event, list);
          return child;
        },
        postMessage(msg: unknown) {
          if (dead) throw new Error("child is gone");
          sent.push(msg);
        },
        kill() {
          dead = true;
          return true;
        },
      };
      children.push({
        sent,
        killed: () => dead,
        emit: (msg) => {
          for (const cb of handlers.get("message") ?? []) cb(msg);
        },
        exit: (code) => {
          dead = true;
          for (const cb of handlers.get("exit") ?? []) cb(code);
        },
      });
      return child;
    },
  },
}));

const { createTtsSynthesizer, resolveSherpaEntry } = await import(
  "./synthesizer.js"
);

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "herta-synth-"));
  dirs.push(d);
  return d;
}
function makeBundle(root: string): string {
  for (const rel of [
    "model.int8-81mb.onnx",
    "voices.bin",
    "frontend/tokens.txt",
    "frontend/lexicon-us-en.txt",
    "frontend/lexicon-zh.txt",
    "frontend/phone-zh.fst",
    "frontend/date-zh.fst",
    "frontend/number-zh.fst",
  ]) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "x");
  }
  mkdirSync(join(root, "frontend", "espeak-ng-data"), { recursive: true });
  return root;
}

function setup(over: { enabled?: () => boolean } = {}) {
  const modelRoot = makeBundle(tmp());
  const synth = createTtsSynthesizer({
    modelRoots: [modelRoot],
    workerPath: "/fake/tts-worker.cjs",
    sherpaPath: "/fake/sherpa-onnx.js",
    enabled: over.enabled ?? (() => true),
    log: () => undefined,
  });
  return { synth, modelRoot };
}

/** Drive the newest child to ready. */
function ready(): FakeChild {
  const child = children[children.length - 1];
  if (child === undefined) throw new Error("no worker forked");
  child.emit({ type: "ready", sampleRate: 24000 });
  return child;
}

const REQ = {
  utteranceId: "u1",
  seq: 0,
  text: "第一句。",
  lang: "zh" as const,
};

beforeEach(() => {
  children.length = 0;
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("createTtsSynthesizer", () => {
  it("available() folds the bundle, the runtime, the setting and a dead worker into one answer", () => {
    const { synth } = setup();
    expect(synth.available()).toBe(true);

    let on = true;
    const toggled = createTtsSynthesizer({
      modelRoots: [makeBundle(tmp())],
      workerPath: "/fake/w.cjs",
      sherpaPath: "/fake/s.js",
      enabled: () => on,
      log: () => undefined,
    });
    expect(toggled.available()).toBe(true);
    on = false;
    expect(toggled.available()).toBe(false);

    // No runtime, and no bundle: both unavailable, neither throws.
    const noRuntime = createTtsSynthesizer({
      modelRoots: [makeBundle(tmp())],
      workerPath: "/fake/w.cjs",
      sherpaPath: null,
      enabled: () => true,
      log: () => undefined,
    });
    expect(noRuntime.available()).toBe(false);
    expect(noRuntime.status().runtime).toBe(false);

    const noBundle = createTtsSynthesizer({
      modelRoots: [join(tmp(), "absent")],
      workerPath: "/fake/w.cjs",
      sherpaPath: "/fake/s.js",
      enabled: () => true,
      log: () => undefined,
    });
    expect(noBundle.available()).toBe(false);
    expect(noBundle.status().bundle).toBe(false);
    expect(noBundle.status().modelRoot).toBeNull();
  });

  // ── The bundle as a download (ADR 0061) ──────────────────────────────────

  it("the first COMPLETE root wins: a downloaded copy shadows the dev workspace's", () => {
    const downloaded = join(tmp(), "absent-yet");
    const dev = makeBundle(tmp());
    const synth = createTtsSynthesizer({
      modelRoots: [downloaded, dev],
      workerPath: "/fake/w.cjs",
      sherpaPath: "/fake/s.js",
      enabled: () => true,
      log: () => undefined,
    });
    expect(synth.status().modelRoot).toBe(dev);
    makeBundle(downloaded);
    expect(synth.refreshBundle()).toBe(true);
    expect(synth.status().modelRoot).toBe(downloaded);
  });

  it("refreshBundle turns available() on after a download lands, and off after a removal", async () => {
    const root = join(tmp(), "store", "herta-best-e72");
    const synth = createTtsSynthesizer({
      modelRoots: [root],
      workerPath: "/fake/w.cjs",
      sherpaPath: "/fake/s.js",
      enabled: () => true,
      log: () => undefined,
    });
    expect(synth.available()).toBe(false);
    await expect(synth.synthesize(REQ)).resolves.toBeNull();
    expect(children).toHaveLength(0); // no bundle, no fork

    makeBundle(root);
    expect(synth.refreshBundle()).toBe(true);
    expect(synth.available()).toBe(true);
    const p = synth.synthesize(REQ);
    const child = ready();
    expect((child.sent[0] as { modelRoot: string }).modelRoot).toBe(root);
    await Promise.resolve();
    rmSync(root, { recursive: true, force: true });
    // The worker on the vanished root is stopped; nothing answers from it.
    expect(synth.refreshBundle()).toBe(false);
    expect(child.killed()).toBe(true);
    await expect(p).resolves.toBeNull();
    expect(synth.available()).toBe(false);
  });

  it("stopWorker kills the worker without disposing or spending a restart", async () => {
    const { synth } = setup();
    const p = synth.synthesize(REQ);
    const child = ready();
    await Promise.resolve();
    synth.stopWorker();
    expect(child.killed()).toBe(true);
    await expect(p).resolves.toBeNull();
    expect(synth.available()).toBe(true);
    expect(synth.status().running).toBe(false);
    // Still available, and the next request forks afresh — any number of
    // times, since a deliberate stop is not a failure.
    for (let i = 0; i < 4; i += 1) {
      const p2 = synth.synthesize({ ...REQ, seq: i + 1 });
      const fresh = ready();
      await Promise.resolve();
      synth.stopWorker();
      expect(fresh.killed()).toBe(true);
      await expect(p2).resolves.toBeNull();
    }
    expect(synth.available()).toBe(true);
    expect(synth.status().failed).toBe(false);
  });

  it("starts the worker lazily on the first request and reuses it after", async () => {
    const { synth, modelRoot } = setup();
    expect(children).toHaveLength(0); // nothing forked until something speaks

    const p = synth.synthesize(REQ);
    expect(children).toHaveLength(1);
    const child = ready();
    // init carries the bundle root, the graph inside it, the terminal effect
    // and the runtime path the worker requires — the bundle facts default
    // from tts-path.ts so the session service names none of them.
    expect(child.sent[0]).toEqual({
      type: "init",
      modelRoot,
      modelFile: "model.int8-81mb.onnx",
      effect: "terminal_textured",
      sherpaPath: "/fake/sherpa-onnx.js",
    });
    await Promise.resolve();
    const synthMsg = child.sent[1] as { type: string; id: number };
    expect(synthMsg.type).toBe("synth");
    child.emit({
      type: "audio",
      id: synthMsg.id,
      samples: new Int16Array([1, 2, 3]),
      sampleRate: 24000,
      durationMs: 125,
    });
    await expect(p).resolves.toEqual({
      samples: new Int16Array([1, 2, 3]),
      sampleRate: 24000,
      durationMs: 125,
    });

    const p2 = synth.synthesize({ ...REQ, seq: 1 });
    expect(children).toHaveLength(1); // same worker
    await Promise.resolve();
    const second = child.sent[2] as { id: number };
    child.emit({ type: "synthError", id: second.id, cancelled: true });
    await expect(p2).resolves.toBeNull();
  });

  it("a synthesis failure resolves null rather than rejecting (the unit types unvoiced)", async () => {
    const { synth } = setup();
    const p = synth.synthesize(REQ);
    const child = ready();
    await Promise.resolve();
    const msg = child.sent[1] as { id: number };
    child.emit({ type: "synthError", id: msg.id, message: "boom" });
    await expect(p).resolves.toBeNull();
  });

  it("cancel resolves that utterance's in-flight work as null and tells the worker", async () => {
    const { synth } = setup();
    const p = synth.synthesize(REQ);
    const child = ready();
    await Promise.resolve();
    synth.cancel("u1");
    await expect(p).resolves.toBeNull();
    expect(child.sent).toContainEqual({ type: "cancel", utteranceId: "u1" });
  });

  it("audio arriving for an already-cancelled utterance is discarded", async () => {
    const { synth } = setup();
    const p = synth.synthesize(REQ);
    const child = ready();
    await Promise.resolve();
    const msg = child.sent[1] as { id: number };
    synth.cancel("u1");
    await expect(p).resolves.toBeNull();
    // Late audio for the cancelled request must not resurrect anything.
    expect(() =>
      child.emit({
        type: "audio",
        id: msg.id,
        samples: new Int16Array([9]),
        sampleRate: 24000,
        durationMs: 1,
      }),
    ).not.toThrow();
  });

  it("a request that never answers times out and resolves null", async () => {
    vi.useFakeTimers();
    const { synth } = setup();
    const p = synth.synthesize(REQ);
    ready();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(p).resolves.toBeNull();
  });

  it("a worker crash resolves in-flight work and the NEXT request starts a fresh one", async () => {
    const { synth } = setup();
    const p = synth.synthesize(REQ);
    const child = ready();
    await Promise.resolve();
    child.exit(1);
    await expect(p).resolves.toBeNull();
    expect(synth.status().running).toBe(false);

    const p2 = synth.synthesize({ ...REQ, seq: 1 });
    expect(children).toHaveLength(2);
    const fresh = ready();
    await Promise.resolve();
    const msg = fresh.sent[1] as { id: number };
    fresh.emit({
      type: "audio",
      id: msg.id,
      samples: new Int16Array([4]),
      sampleRate: 24000,
      durationMs: 42,
    });
    await expect(p2).resolves.not.toBeNull();
    expect(synth.available()).toBe(true);
  });

  it("gives up after repeated init failures — available() goes false for the run", async () => {
    const { synth } = setup();
    for (let i = 0; i < 3; i += 1) {
      const p = synth.synthesize({ ...REQ, seq: i });
      const child = children[children.length - 1];
      child?.emit({ type: "initError", message: "no addon" });
      await expect(p).resolves.toBeNull();
    }
    expect(synth.available()).toBe(false);
    expect(synth.status().failed).toBe(true);
    // …and it stops forking: a broken install must not pay a model load per
    // sentence forever.
    const before = children.length;
    await expect(synth.synthesize({ ...REQ, seq: 9 })).resolves.toBeNull();
    expect(children).toHaveLength(before);
  });

  it("dispose kills the worker, resolves everything in flight, and stays unavailable", async () => {
    const { synth } = setup();
    const p = synth.synthesize(REQ);
    const child = ready();
    await Promise.resolve();
    synth.dispose();
    await expect(p).resolves.toBeNull();
    expect(child.killed()).toBe(true);
    expect(synth.available()).toBe(false);
    synth.dispose(); // idempotent
    await expect(synth.synthesize(REQ)).resolves.toBeNull();
  });
});

describe("resolveSherpaEntry", () => {
  it("packaged: prefers the staged runtime under resources", () => {
    const res = tmp();
    const staged = join(res, "tts-runtime", "sherpa-onnx-node");
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "sherpa-onnx.js"), "x");
    expect(
      resolveSherpaEntry({
        isPackaged: true,
        resourcesPath: res,
        startDir: join(res, "app", "out", "main"),
      }),
    ).toBe(join(staged, "sherpa-onnx.js"));
  });

  it("packaged: a node_modules copy is NOT a runtime — an asar wrapper without its addon must not report the voice present", () => {
    // The app.asar layout: out/main beside a node_modules holding the JS
    // wrapper only (what electron-builder packed from the production
    // dependency), and no staged tts-runtime under resources.
    const res = tmp();
    const app = join(res, "app.asar");
    const wrapper = join(app, "node_modules", "sherpa-onnx-node");
    mkdirSync(wrapper, { recursive: true });
    writeFileSync(join(wrapper, "sherpa-onnx.js"), "x");
    const startDir = join(app, "out", "main");
    mkdirSync(startDir, { recursive: true });
    expect(
      resolveSherpaEntry({ isPackaged: true, resourcesPath: res, startDir }),
    ).toBeNull();
    // Dev, same tree: the walk-up is the intended path.
    expect(
      resolveSherpaEntry({ isPackaged: false, resourcesPath: res, startDir }),
    ).toBe(join(wrapper, "sherpa-onnx.js"));
  });

  it("dev: walks up to a node_modules that holds the package", () => {
    const root = tmp();
    const pkg = join(root, "node_modules", "sherpa-onnx-node");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "sherpa-onnx.js"), "x");
    const deep = join(root, "packages", "gui", "out", "main");
    mkdirSync(deep, { recursive: true });
    expect(
      resolveSherpaEntry({
        isPackaged: false,
        resourcesPath: "/unused",
        startDir: deep,
      }),
    ).toBe(join(pkg, "sherpa-onnx.js"));
  });

  it("null when the runtime is nowhere to be found", () => {
    expect(
      resolveSherpaEntry({
        isPackaged: false,
        resourcesPath: join(tmp(), "none"),
        startDir: join(tmp(), "a", "b"),
      }),
    ).toBeNull();
  });
});
