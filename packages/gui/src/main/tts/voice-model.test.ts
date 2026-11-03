import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { packTarGz } from "../../../scripts/tar-pack.mjs";
import {
  createVoiceModelService,
  downloadVoiceModel,
  type FetchLike,
  VoiceModelError,
  type VoiceModelState,
  voiceModelPaths,
} from "./voice-model.js";

const BUNDLE_ID = "herta-best-e72";
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "herta-vm-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");

/** A complete bundle (every file the runtime opens) as a manifest-bearing
 *  archive, plus the pins a real build would carry. */
function makeArchive(opts: { release?: string; corruptFile?: boolean } = {}) {
  const files: Record<string, Buffer> = {
    "model.int8-81mb.onnx": Buffer.alloc(4000, 3),
    "voices.bin": Buffer.alloc(900, 5),
    "frontend/tokens.txt": Buffer.from("a 0\n"),
    "frontend/lexicon-us-en.txt": Buffer.from("x\n"),
    "frontend/lexicon-zh.txt": Buffer.from("y\n"),
    "frontend/phone-zh.fst": Buffer.from("p"),
    "frontend/date-zh.fst": Buffer.from("d"),
    "frontend/number-zh.fst": Buffer.from("n"),
    "frontend/espeak-ng-data/phontab": Buffer.from("t"),
  };
  const manifest = {
    schema: 1,
    release: opts.release ?? BUNDLE_ID,
    model: "model.int8-81mb.onnx",
    runtime_voice: "voices.bin",
    files: Object.entries(files).map(([path, data]) => ({
      path,
      bytes: data.length,
      sha256: sha(data),
    })),
  };
  if (opts.corruptFile === true) {
    files["frontend/tokens.txt"] = Buffer.from("tampered\n");
  }
  const entries = [
    ...Object.entries(files).map(([path, data]) => ({ path, data })),
    { path: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
  ].sort((a, b) => (a.path < b.path ? -1 : 1));
  const gz = packTarGz(entries);
  const unpacked = entries.reduce((n, e) => n + e.data.length, 0);
  return {
    gz,
    archive: {
      url: "https://example.invalid/herta-best-e72.tar.gz",
      sha256: sha(gz),
      bytes: gz.length,
      unpackedBytes: unpacked,
    },
  };
}

/** A fetch that streams `buf` in `chunk`-byte pieces and honours the signal. */
function fetchOf(
  buf: Buffer,
  opts: { chunk?: number; status?: number; hangAfter?: number } = {},
): FetchLike {
  const chunk = opts.chunk ?? 1024;
  return async (_url, init) => {
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        return new Promise<void>((resolve, reject) => {
          if (init.signal.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          if (opts.hangAfter !== undefined && offset >= opts.hangAfter) {
            // Never deliver more; only the abort signal ends this.
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
            return;
          }
          if (offset >= buf.length) {
            controller.close();
            resolve();
            return;
          }
          controller.enqueue(buf.subarray(offset, offset + chunk));
          offset += chunk;
          resolve();
        });
      },
    });
    return new Response(stream, { status: opts.status ?? 200 });
  };
}

// Every test here writes a real bundle: streamed to disk, extracted, each
// file verified, swapped into place — and some remove it again. A second or
// so alone; a single install took 2.6 s beside other test files, and one test
// went past the default 5 s in a loaded suite (2026-11-03).
describe("downloadVoiceModel", { timeout: 30_000 }, () => {
  it("downloads, verifies, extracts and swaps the bundle into place", async () => {
    const root = tmp();
    const { gz, archive } = makeArchive();
    const progress: number[] = [];
    const res = await downloadVoiceModel({
      root,
      bundleId: BUNDLE_ID,
      archive,
      fetch: fetchOf(gz, { chunk: 700 }),
      signal: new AbortController().signal,
      onProgress: (r) => progress.push(r),
    });
    expect(res.files).toBe(10);
    const p = voiceModelPaths(root, BUNDLE_ID);
    expect(existsSync(join(p.final, "model.int8-81mb.onnx"))).toBe(true);
    expect(existsSync(join(p.final, "manifest.json"))).toBe(true);
    expect(existsSync(p.installing)).toBe(false);
    expect(existsSync(p.download)).toBe(false);
    expect(progress[progress.length - 1]).toBe(archive.bytes);
  });

  it("refuses an archive whose hash is not the pinned one, leaving nothing behind", async () => {
    const root = tmp();
    const { gz, archive } = makeArchive();
    await expect(
      downloadVoiceModel({
        root,
        bundleId: BUNDLE_ID,
        archive: { ...archive, sha256: "0".repeat(64) },
        fetch: fetchOf(gz),
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).rejects.toMatchObject({ reason: "hash" });
    expect(readdirSync(root)).toEqual([]);
  });

  it("cuts a download that grows past the pinned size", async () => {
    const root = tmp();
    const { gz, archive } = makeArchive();
    await expect(
      downloadVoiceModel({
        root,
        bundleId: BUNDLE_ID,
        archive: { ...archive, bytes: archive.bytes - 10 },
        fetch: fetchOf(gz, { chunk: 64 }),
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).rejects.toMatchObject({ reason: "size" });
    expect(readdirSync(root)).toEqual([]);
  });

  it("reports an HTTP failure as such", async () => {
    const root = tmp();
    const { gz, archive } = makeArchive();
    await expect(
      downloadVoiceModel({
        root,
        bundleId: BUNDLE_ID,
        archive,
        fetch: fetchOf(gz, { status: 404 }),
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).rejects.toMatchObject({ reason: "http" });
  });

  it("a cancel mid-stream ends as `cancelled` with the temp file gone", async () => {
    const root = tmp();
    const { gz, archive } = makeArchive();
    const ac = new AbortController();
    const p = downloadVoiceModel({
      root,
      bundleId: BUNDLE_ID,
      archive,
      fetch: fetchOf(gz, { chunk: 256, hangAfter: 512 }),
      signal: ac.signal,
      onProgress: (r) => {
        if (r >= 512) ac.abort(new DOMException("cancelled", "AbortError"));
      },
    });
    await expect(p).rejects.toMatchObject({ reason: "cancelled" });
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a bundle whose files do not match its own manifest", async () => {
    const root = tmp();
    const { gz, archive } = makeArchive({ corruptFile: true });
    await expect(
      downloadVoiceModel({
        root,
        bundleId: BUNDLE_ID,
        archive,
        fetch: fetchOf(gz),
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).rejects.toMatchObject({ reason: "verify" });
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a bundle for another release", async () => {
    const root = tmp();
    const { gz, archive } = makeArchive({ release: "herta-best-e30" });
    await expect(
      downloadVoiceModel({
        root,
        bundleId: BUNDLE_ID,
        archive,
        fetch: fetchOf(gz),
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).rejects.toBeInstanceOf(VoiceModelError);
  });

  it("a previously installed bundle survives a failed download", async () => {
    const root = tmp();
    const good = makeArchive();
    const base = {
      root,
      bundleId: BUNDLE_ID,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    };
    await downloadVoiceModel({
      ...base,
      archive: good.archive,
      fetch: fetchOf(good.gz),
    });
    const bad = makeArchive({ corruptFile: true });
    await expect(
      downloadVoiceModel({
        ...base,
        archive: bad.archive,
        fetch: fetchOf(bad.gz),
      }),
    ).rejects.toMatchObject({ reason: "verify" });
    expect(
      existsSync(join(voiceModelPaths(root, BUNDLE_ID).final, "voices.bin")),
    ).toBe(true);
  });
});

// The service over the same real installs: the same budget.
describe("createVoiceModelService", { timeout: 30_000 }, () => {
  function service(
    fetch: FetchLike,
    archive: ReturnType<typeof makeArchive>["archive"],
    extra: {
      beforeRemove?: () => void;
      afterChange?: () => void;
      onChange?: (s: VoiceModelState) => void;
    } = {},
  ) {
    const root = tmp();
    const changes: VoiceModelState[] = [];
    const { onChange, ...rest } = extra;
    const svc = createVoiceModelService({
      root,
      bundleId: BUNDLE_ID,
      archive,
      fetch,
      onChange: (s) => {
        changes.push(s);
        onChange?.(s);
      },
      log: () => undefined,
      progressEveryMs: 0,
      ...rest,
    });
    return { svc, root, changes };
  }

  it("absent → downloading (with progress) → ready, then remove → absent", async () => {
    const { gz, archive } = makeArchive();
    let after = 0;
    let before = 0;
    const { svc, changes, root } = service(
      fetchOf(gz, { chunk: 500 }),
      archive,
      {
        afterChange: () => {
          after += 1;
        },
        beforeRemove: () => {
          before += 1;
        },
      },
    );
    expect((await svc.state()).phase).toBe("absent");
    const end = await svc.download();
    expect(end.phase).toBe("ready");
    expect(changes[0]?.phase).toBe("downloading");
    expect(
      changes.some((c) => c.phase === "downloading" && c.receivedBytes > 0),
    ).toBe(true);
    expect(changes[changes.length - 1]?.phase).toBe("ready");
    expect(after).toBe(1);
    // A second download is a no-op on a ready bundle.
    expect((await svc.download()).phase).toBe("ready");
    const gone = await svc.remove();
    expect(gone.phase).toBe("absent");
    expect(before).toBe(1);
    expect(after).toBe(2);
    expect(existsSync(voiceModelPaths(root, BUNDLE_ID).final)).toBe(false);
  });

  it("a failed download reports its reason and a retry can succeed", async () => {
    const { gz, archive } = makeArchive();
    let calls = 0;
    const fetch: FetchLike = (url, init) => {
      calls += 1;
      return fetchOf(gz, { status: calls === 1 ? 500 : 200 })(url, init);
    };
    const { svc } = service(fetch, archive);
    const first = await svc.download();
    expect(first.phase).toBe("failed");
    expect(first.error).toBe("http");
    expect((await svc.state()).phase).toBe("failed");
    const second = await svc.download();
    expect(second.phase).toBe("ready");
  });

  it("cancel ends the download as absent, not failed", async () => {
    const { gz, archive } = makeArchive();
    let landed!: () => void;
    const firstChunks = new Promise<void>((resolve) => {
      landed = resolve;
    });
    const { svc, changes } = service(
      fetchOf(gz, { chunk: 256, hangAfter: 512 }),
      archive,
      {
        onChange: (s) => {
          if (s.phase === "downloading" && s.receivedBytes > 0) landed();
        },
      },
    );
    const p = svc.download();
    // Let the first chunks land, then cancel. Waited for, not slept on: a
    // cancel that came while the download was still looking at the disk
    // ended it before it said anything (2026-11-03).
    await firstChunks;
    svc.cancel();
    const end = await p;
    expect(end.phase).toBe("absent");
    expect(end.error).toBeUndefined();
    expect(changes[changes.length - 1]?.phase).toBe("absent");
  });

  it("concurrent download() calls share one run", async () => {
    const { gz, archive } = makeArchive();
    const { svc } = service(fetchOf(gz), archive);
    const [a, b] = await Promise.all([svc.download(), svc.download()]);
    expect(a.phase).toBe("ready");
    expect(b.phase).toBe("ready");
  });

  // The bundle is looked at asynchronously now (the service runs on the
  // app's main thread, ADR 0068), inside the download's own slot: a remove
  // that lands during that look stops the download before any fetch.
  it("a remove during download()'s first look fetches nothing", async () => {
    const { gz, archive } = makeArchive();
    let fetched = 0;
    const fetch: FetchLike = (url, init) => {
      fetched += 1;
      return fetchOf(gz)(url, init);
    };
    const { svc, changes } = service(fetch, archive);
    const started = svc.download();
    const gone = await svc.remove();
    expect((await started).phase).toBe("absent");
    expect(gone.phase).toBe("absent");
    expect(fetched).toBe(0);
    expect(changes.some((c) => c.phase === "downloading")).toBe(false);
  });
});

describe("createVoiceModelService — leftovers are swept at start (ADR 0061 §4.4)", () => {
  it("removes a crashed install's .installing and .download when the service is made, and leaves the bundle alone", async () => {
    const root = tmp();
    const p = voiceModelPaths(root, BUNDLE_ID);
    mkdirSync(p.installing, { recursive: true });
    writeFileSync(join(p.installing, "part"), "1");
    writeFileSync(p.download, "partial");
    mkdirSync(p.final, { recursive: true });
    writeFileSync(join(p.final, "keep"), "k");
    const { archive } = makeArchive();
    const svc = createVoiceModelService({
      root,
      bundleId: BUNDLE_ID,
      archive,
      fetch: fetchOf(Buffer.alloc(0)),
      onChange: () => undefined,
      log: () => undefined,
    });
    await svc.sweep();
    expect(existsSync(p.installing)).toBe(false);
    expect(existsSync(p.download)).toBe(false);
    expect(existsSync(join(p.final, "keep"))).toBe(true);
  });
});
