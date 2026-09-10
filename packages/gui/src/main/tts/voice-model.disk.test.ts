import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A full disk during the download (2026-09-10). Its own file: the hoisted
 * mock of `node:fs/promises` must not reach the sibling suite, whose
 * downloads write real files. Same shape as the persister's fuse test:
 * `vi.hoisted` state, `importOriginal` for everything but `open`.
 */
const state = vi.hoisted(() => ({ failWrite: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    default: real,
    open: async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      if (!state.failWrite) return fh;
      return new Proxy(fh, {
        get(target, prop, receiver) {
          if (prop === "write") {
            return async () => {
              const err = new Error(
                "ENOSPC: no space left on device, write",
              ) as NodeJS.ErrnoException;
              err.code = "ENOSPC";
              throw err;
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
  };
});

const { downloadVoiceModel } = await import("./voice-model.js");

const dirs: string[] = [];
afterEach(() => {
  state.failWrite = false;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("downloadVoiceModel — the local disk saying no", () => {
  it("a write that fails with ENOSPC is reported as `disk`, not `network`", async () => {
    const root = mkdtempSync(join(tmpdir(), "herta-vm-disk-"));
    dirs.push(root);
    state.failWrite = true;
    const body = Buffer.alloc(4096, 1);
    await expect(
      downloadVoiceModel({
        root,
        bundleId: "herta-best-e72",
        archive: {
          url: "https://example.invalid/x.tar.gz",
          sha256: "0".repeat(64),
          bytes: body.length,
          unpackedBytes: 1 << 20,
        },
        fetch: async () => new Response(body, { status: 200 }),
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).rejects.toMatchObject({ reason: "disk" });
  });
});
