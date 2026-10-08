import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_VIEWER_BYTES,
  MAX_VIEWER_RICH_BYTES,
  readWorkspaceBytesBounded,
  readWorkspaceFileBounded,
  resolveInsideWorkspace,
} from "./read-workspace-file.js";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true });
});
async function mkRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "viewer-read-"));
  roots.push(r);
  return r;
}

describe("readWorkspaceFileBounded (ADR 0050 §2)", () => {
  it("reads a workspace-relative text file with its relative path", async () => {
    const ws = await mkRoot();
    await mkdir(join(ws, "src"));
    await writeFile(join(ws, "src", "a.ts"), "one\ntwo\n");
    const r = await readWorkspaceFileBounded(ws, "src/a.ts");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe("one\ntwo\n");
    expect(r.relative).toBe("src/a.ts");
    expect(r.truncated).toBe(false);
  });

  it("refuses paths that resolve outside the workspace", async () => {
    const ws = await mkRoot();
    const outside = await mkRoot();
    await writeFile(join(outside, "secret.txt"), "x");
    for (const p of [
      join(outside, "secret.txt"),
      `../${outside.split(/[\\/]/).pop()}/secret.txt`,
    ]) {
      const r = await readWorkspaceFileBounded(ws, p);
      expect(r.ok, p).toBe(false);
      if (!r.ok) expect(r.reason).toBe("outside_workspace");
    }
  });

  it("a symlink is judged by where it lands, not where it sits", async () => {
    const ws = await mkRoot();
    const outside = await mkRoot();
    await writeFile(join(outside, "target.txt"), "x");
    try {
      await symlink(join(outside, "target.txt"), join(ws, "innocent.txt"));
    } catch {
      return; // no symlink privilege on this machine — nothing to prove
    }
    const r = await readWorkspaceFileBounded(ws, "innocent.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("outside_workspace");
  });

  it("a missing in-workspace file is not_found, not a jail message", async () => {
    const ws = await mkRoot();
    const r = await readWorkspaceFileBounded(ws, "gone.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_found");
  });

  it("a directory is not_a_file", async () => {
    const ws = await mkRoot();
    await mkdir(join(ws, "dir"));
    const r = await readWorkspaceFileBounded(ws, "dir");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_a_file");
  });

  it("binary content answers binary instead of mojibake", async () => {
    const ws = await mkRoot();
    await writeFile(join(ws, "b.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    const r = await readWorkspaceFileBounded(ws, "b.bin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("binary");
  });

  it("an oversized file returns a truncated prefix and the honest size", async () => {
    const ws = await mkRoot();
    const big = "x".repeat(MAX_VIEWER_BYTES + 10_000);
    await writeFile(join(ws, "big.txt"), big);
    const r = await readWorkspaceFileBounded(ws, "big.txt");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBe(MAX_VIEWER_BYTES);
    expect(r.size).toBe(big.length);
  });

  it("resolveInsideWorkspace normalizes to forward slashes", async () => {
    const ws = await mkRoot();
    await mkdir(join(ws, "a", "b"), { recursive: true });
    await writeFile(join(ws, "a", "b", "c.txt"), "x");
    const r = await resolveInsideWorkspace(ws, join("a", "b", "c.txt"));
    expect(r.kind === "ok" ? r.relative : r.kind).toBe("a/b/c.txt");
  });

  it("`.` is the workspace itself — what the device card's path opens", async () => {
    const ws = await mkRoot();
    const r = await resolveInsideWorkspace(ws, ".");
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" ? r.relative : null).toBe("");
  });
});

describe("readWorkspaceBytesBounded (ADR 0054 §2)", () => {
  it("returns the whole file as bytes — binary or not — with its relative path", async () => {
    const ws = await mkRoot();
    await mkdir(join(ws, "img"));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
    await writeFile(join(ws, "img", "a.png"), png);
    const r = await readWorkspaceBytesBounded(ws, "img/a.png");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Buffer.from(r.bytes).equals(png)).toBe(true);
    expect(r.size).toBe(png.length);
    expect(r.relative).toBe("img/a.png");
    // A copy, not a view into Node's shared pool.
    expect(r.bytes.byteOffset).toBe(0);
    expect(r.bytes.buffer.byteLength).toBe(png.length);
  });

  it("shares the jail and the answers: outside, missing, a directory", async () => {
    const ws = await mkRoot();
    const outside = await mkRoot();
    await writeFile(join(outside, "s.pdf"), "x");
    await mkdir(join(ws, "dir"));
    const out = await readWorkspaceBytesBounded(ws, join(outside, "s.pdf"));
    expect(out.ok === false && out.reason).toBe("outside_workspace");
    const missing = await readWorkspaceBytesBounded(ws, "nope.pdf");
    expect(missing.ok === false && missing.reason).toBe("not_found");
    const dir = await readWorkspaceBytesBounded(ws, "dir");
    expect(dir.ok === false && dir.reason).toBe("not_a_file");
  });

  it("the ceiling is the attachment store's (64 MB) — whole or refused, never a cut file", () => {
    expect(MAX_VIEWER_RICH_BYTES).toBe(64 * 1024 * 1024);
    expect(MAX_VIEWER_RICH_BYTES).toBeGreaterThan(MAX_VIEWER_BYTES);
  });
});
