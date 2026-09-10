import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { verifyBundle } from "./bundle-verify.js";
import { extractTar } from "./tar-extract.js";
import { ttsBundleComplete } from "./tts-path.js";

/**
 * The voice model as a DOWNLOAD (ADR 0061): the user asks for it in
 * Settings → Voice, the app fetches one archive, verifies it against the
 * hash pinned in `tts-release.ts`, extracts it beside the final directory,
 * re-verifies every file against the manifest inside, and only then renames
 * it into place. Nothing partial ever answers to the bundle's path:
 * `available()` sees either the previous state or the whole new one.
 *
 * Pure Node — `fetch` is injected (Electron's proxy-aware `net.fetch` in the
 * app, a fake in tests), so this unit-tests without electron.
 */
export type VoiceModelPhase = "absent" | "downloading" | "ready" | "failed";

/** Why a download did not end in a bundle — a KEY the Settings row
 *  localizes, never a raw message (the user cannot act on a stack). */
export type VoiceModelFailure =
  | "network"
  | "http"
  | "size"
  | "hash"
  | "archive"
  | "verify"
  | "disk"
  | "cancelled";

export interface VoiceModelArchive {
  readonly url: string;
  readonly sha256: string;
  /** The archive's exact size — a download that grows past it is cut. */
  readonly bytes: number;
  /** The extracted bundle's size — the extractor's bomb cap. */
  readonly unpackedBytes: number;
}

export interface VoiceModelState {
  readonly phase: VoiceModelPhase;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly unpackedBytes: number;
  readonly error?: VoiceModelFailure;
}

export class VoiceModelError extends Error {
  constructor(
    readonly reason: VoiceModelFailure,
    message: string,
  ) {
    super(message);
    this.name = "VoiceModelError";
  }
}

export type FetchLike = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<Response>;

export interface DownloadVoiceModelOptions {
  /** The directory that holds bundles (`<userData>/tts`). */
  readonly root: string;
  readonly bundleId: string;
  readonly archive: VoiceModelArchive;
  readonly fetch: FetchLike;
  readonly signal: AbortSignal;
  readonly onProgress: (receivedBytes: number, totalBytes: number) => void;
}

/** Paths a bundle id owns under the root. */
export function voiceModelPaths(
  root: string,
  bundleId: string,
): {
  readonly final: string;
  readonly installing: string;
  readonly download: string;
} {
  return {
    final: join(root, bundleId),
    installing: join(root, `${bundleId}.installing`),
    download: join(root, `${bundleId}.download`),
  };
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** The local disk saying no — a full volume, a permission, a dying drive.
 *  Told apart from the transfer (2026-09-10): a `write` that fails with
 *  ENOSPC inside the body loop used to be reported as `network`, and the
 *  Settings row then sent the user to check their VPN with 60 MB of a 76 MB
 *  download on a full disk. */
const DISK_CODES: ReadonlySet<string> = new Set([
  "ENOSPC",
  "EDQUOT",
  "EACCES",
  "EPERM",
  "EIO",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "EBUSY",
]);
function isDiskError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && DISK_CODES.has(code);
}

/** `rm -rf` with a few retries: Windows holds a directory a moment after
 *  its last handle closes, and the worker's model files are the case. */
async function rmRetry(path: string, attempts = 6): Promise<void> {
  for (let i = 0; ; i += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch (err) {
      if (i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
}

async function* abortable(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    if (signal.aborted) throw new VoiceModelError("cancelled", "cancelled");
    yield chunk;
  }
}

/**
 * Download, verify, extract, verify again, swap in. Resolves with the
 * bundle's size; throws a `VoiceModelError` naming why (the temp files are
 * removed before it does). A previously installed bundle survives every
 * failure — it is replaced only in the final rename.
 */
export async function downloadVoiceModel(
  opts: DownloadVoiceModelOptions,
): Promise<{ readonly files: number; readonly bytes: number }> {
  const { archive, signal } = opts;
  const paths = voiceModelPaths(opts.root, opts.bundleId);
  const cleanup = async (): Promise<void> => {
    await rm(paths.download, { force: true }).catch(() => undefined);
    await rmRetry(paths.installing).catch(() => undefined);
  };
  try {
    await mkdir(opts.root, { recursive: true });
    await cleanup();

    // ── 1. fetch to disk, hashing as it lands ─────────────────────────────
    let res: Response;
    try {
      res = await opts.fetch(archive.url, { signal });
    } catch (err) {
      throw new VoiceModelError(
        isAbort(err) || signal.aborted ? "cancelled" : "network",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!res.ok) throw new VoiceModelError("http", `HTTP ${res.status}`);
    const body = res.body as unknown as AsyncIterable<Uint8Array> | null;
    if (body === null) throw new VoiceModelError("network", "empty body");
    const hash = createHash("sha256");
    let received = 0;
    const fh = await open(paths.download, "w").catch((err: unknown) => {
      throw new VoiceModelError("disk", String(err));
    });
    try {
      for await (const chunk of body) {
        if (signal.aborted) throw new VoiceModelError("cancelled", "cancelled");
        received += chunk.length;
        if (received > archive.bytes) {
          throw new VoiceModelError("size", "archive larger than pinned");
        }
        hash.update(chunk);
        await fh.write(chunk);
        opts.onProgress(received, archive.bytes);
      }
    } catch (err) {
      if (err instanceof VoiceModelError) throw err;
      throw new VoiceModelError(
        isAbort(err) || signal.aborted
          ? "cancelled"
          : isDiskError(err)
            ? "disk"
            : "network",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      await fh.close();
    }
    if (received !== archive.bytes) {
      throw new VoiceModelError("size", `got ${received} of ${archive.bytes}`);
    }
    if (hash.digest("hex") !== archive.sha256) {
      throw new VoiceModelError("hash", "archive hash mismatch");
    }

    // ── 2. extract beside the final directory ─────────────────────────────
    let extracted: { files: number; bytes: number };
    try {
      const source = createReadStream(paths.download).pipe(createGunzip());
      extracted = await extractTar(
        abortable(source, signal),
        paths.installing,
        // A little slack for the manifest and block rounding; the pinned
        // hash already rules out a different archive, this rules out a
        // wrong pin.
        { maxBytes: archive.unpackedBytes + (1 << 20) },
      );
    } catch (err) {
      if (err instanceof VoiceModelError) throw err;
      throw new VoiceModelError(
        isDiskError(err) ? "disk" : "archive",
        err instanceof Error ? err.message : String(err),
      );
    }

    // ── 3. verify every file against the manifest it came with ────────────
    const verdict = await verifyBundle(paths.installing, opts.bundleId);
    if (!verdict.ok) throw new VoiceModelError("verify", verdict.reason);
    if (!ttsBundleComplete(paths.installing)) {
      throw new VoiceModelError("verify", "bundle incomplete");
    }

    // ── 4. swap in ────────────────────────────────────────────────────────
    try {
      await rmRetry(paths.final);
      await rename(paths.installing, paths.final);
    } catch (err) {
      throw new VoiceModelError("disk", String(err));
    }
    await rm(paths.download, { force: true }).catch(() => undefined);
    return { files: extracted.files, bytes: verdict.bytes };
  } catch (err) {
    await cleanup();
    if (err instanceof VoiceModelError) throw err;
    throw new VoiceModelError(
      "disk",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Remove an installed bundle (and any leftovers). The caller stops the
 *  worker first — its model files are open while it runs. */
export async function removeVoiceModel(
  root: string,
  bundleId: string,
): Promise<void> {
  const paths = voiceModelPaths(root, bundleId);
  await rmRetry(paths.final);
  await rmRetry(paths.installing).catch(() => undefined);
  await rm(paths.download, { force: true }).catch(() => undefined);
}

// ───── the service the Settings row talks to ─────

export interface VoiceModelServiceOptions {
  readonly root: string;
  readonly bundleId: string;
  readonly archive: VoiceModelArchive;
  readonly fetch: FetchLike;
  /** Every state change, including progress (throttled). */
  readonly onChange: (state: VoiceModelState) => void;
  /** Run before the files are deleted — stop the worker holding them. */
  readonly beforeRemove?: () => Promise<void> | void;
  /** Run after the bundle appeared or disappeared — the synthesizer
   *  re-probes its roots. */
  readonly afterChange?: () => void;
  readonly log?: (line: string) => void;
  /** Minimum ms between progress pushes. */
  readonly progressEveryMs?: number;
  readonly now?: () => number;
}

export interface VoiceModelService {
  state(): VoiceModelState;
  /** Start a download unless one runs or the bundle is present; resolves
   *  with the state it ended in. Never rejects. */
  download(): Promise<VoiceModelState>;
  cancel(): void;
  /** Cancel any download, then delete the bundle. Never rejects. */
  remove(): Promise<VoiceModelState>;
}

export function createVoiceModelService(
  opts: VoiceModelServiceOptions,
): VoiceModelService {
  const log = opts.log ?? ((l: string) => console.log(`[herta-tts] ${l}`));
  const now = opts.now ?? (() => Date.now());
  const every = opts.progressEveryMs ?? 200;
  const paths = voiceModelPaths(opts.root, opts.bundleId);
  let live: VoiceModelState | null = null; // set while downloading
  let inFlight: Promise<VoiceModelState> | null = null;
  let controller: AbortController | null = null;
  let lastError: VoiceModelFailure | null = null;

  const base = (phase: VoiceModelPhase): VoiceModelState => ({
    phase,
    receivedBytes: 0,
    totalBytes: opts.archive.bytes,
    unpackedBytes: opts.archive.unpackedBytes,
  });

  const state = (): VoiceModelState => {
    if (live !== null) return live;
    if (ttsBundleComplete(paths.final)) return base("ready");
    return lastError !== null
      ? { ...base("failed"), error: lastError }
      : base("absent");
  };

  const run = async (): Promise<VoiceModelState> => {
    const ac = new AbortController();
    controller = ac;
    lastError = null;
    live = base("downloading");
    opts.onChange(live);
    let lastPush = now();
    try {
      await downloadVoiceModel({
        root: opts.root,
        bundleId: opts.bundleId,
        archive: opts.archive,
        fetch: opts.fetch,
        signal: ac.signal,
        onProgress: (received, total) => {
          live = {
            ...base("downloading"),
            receivedBytes: received,
            totalBytes: total,
          };
          const t = now();
          if (t - lastPush >= every || received === total) {
            lastPush = t;
            opts.onChange(live);
          }
        },
      });
      log(`voice model ${opts.bundleId} installed at ${paths.final}`);
    } catch (err) {
      const reason =
        err instanceof VoiceModelError ? err.reason : ("disk" as const);
      if (reason !== "cancelled") {
        lastError = reason;
        log(
          `voice model download failed (${reason}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      live = null;
      controller = null;
      inFlight = null;
    }
    const s = state();
    opts.onChange(s);
    opts.afterChange?.();
    return s;
  };

  return {
    state,
    download(): Promise<VoiceModelState> {
      if (inFlight !== null) return inFlight;
      const s = state();
      if (s.phase === "ready") return Promise.resolve(s);
      inFlight = run();
      return inFlight;
    },
    cancel(): void {
      controller?.abort(new DOMException("cancelled", "AbortError"));
    },
    async remove(): Promise<VoiceModelState> {
      if (inFlight !== null) {
        controller?.abort(new DOMException("cancelled", "AbortError"));
        await inFlight;
      }
      try {
        await opts.beforeRemove?.();
        await removeVoiceModel(opts.root, opts.bundleId);
        lastError = null;
        log(`voice model ${opts.bundleId} removed`);
      } catch (err) {
        log(`voice model removal failed: ${String(err)}`);
        lastError = "disk";
      }
      const s = state();
      opts.onChange(s);
      opts.afterChange?.();
      return s;
    },
  };
}
