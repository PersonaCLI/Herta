import { promises as fs } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { isPathInside } from "@herta/core";

/**
 * The file-viewer read (ADR 0050 §2): one bounded, workspace-jailed read
 * for the renderer's viewer panel. User-only display chrome — the content
 * never reaches a model or the record, so the jail here is about the
 * RENDERER not being handed an arbitrary-filesystem read primitive, not
 * about model containment (that is `@herta/tools`' path-safety, which the
 * GUI main process deliberately does not import).
 */
export interface ReadWorkspaceFileOk {
  readonly ok: true;
  /** UTF-8 text, cut at MAX_VIEWER_BYTES when `truncated`. */
  readonly content: string;
  readonly truncated: boolean;
  /** Total file size in bytes (the honest number when truncated). */
  readonly size: number;
  /** Workspace-relative path, normalized to forward slashes. */
  readonly relative: string;
}
export interface ReadWorkspaceFileErr {
  readonly ok: false;
  readonly reason:
    | "not_found"
    | "not_a_file"
    | "outside_workspace"
    | "binary"
    | "unreadable";
}
export type ReadWorkspaceFileResult =
  | ReadWorkspaceFileOk
  | ReadWorkspaceFileErr;

/** Viewer read cap. Big enough for any file a person would read in a side
 *  panel; the panel says the file continues and offers 打开 for the rest. */
export const MAX_VIEWER_BYTES = 1_500_000;

/** The BYTES read's ceiling (ADR 0054 §2): the attachment store's own
 *  ceiling, so nothing a session holds is unreadable by size. Whole or
 *  refused — a truncated ZIP or PDF is garbage, not a preview. */
export const MAX_VIEWER_RICH_BYTES = 64 * 1024 * 1024;

export interface ReadWorkspaceBytesOk {
  readonly ok: true;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly relative: string;
}
export interface ReadWorkspaceBytesErr {
  readonly ok: false;
  readonly reason:
    | "not_found"
    | "not_a_file"
    | "outside_workspace"
    | "too_large"
    | "unreadable";
}
export type ReadWorkspaceBytesResult =
  | ReadWorkspaceBytesOk
  | ReadWorkspaceBytesErr;

/** NUL inside the head is the classic text/binary sniff — git's own. */
const BINARY_SNIFF_BYTES = 8_000;

/**
 * Resolve `inputPath` (workspace-relative or absolute) against the
 * workspace, realpath it (symlink hops collapse before the jail check),
 * and judge where it LANDS. Three answers, kept apart on purpose: an
 * in-workspace name that doesn't exist ("missing") must read as a missing
 * file, while a name that resolves outside — including an innocent-named
 * symlink whose target escapes — must read as refused ("outside").
 */
export async function resolveInsideWorkspace(
  workspaceRoot: string,
  inputPath: string,
): Promise<
  | { readonly kind: "ok"; readonly abs: string; readonly relative: string }
  | { readonly kind: "outside" }
  /** `relative` is the in-workspace spelling of a name with no inode —
   *  what the diff tab hands git for a DELETED tracked file (ADR 0059 §5).
   *  Absent when the name never resolved far enough to have one. */
  | { readonly kind: "missing"; readonly relative?: string }
> {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0)
    return { kind: "missing" };
  const candidate = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(workspaceRoot, inputPath);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(workspaceRoot);
  } catch {
    return { kind: "missing" };
  }
  // The ONE containment rule (core): the platform's own case policy, which
  // is what the win32-only lowercase fold here used to spell by hand.
  const isInside = (p: string): boolean => isPathInside(realRoot, p);
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    // No inode to judge — fall back to the unresolved spelling: an
    // in-workspace name is a missing file, an outside one is refused.
    return isInside(candidate)
      ? {
          kind: "missing",
          relative: candidate
            .slice(realRoot.length)
            .replace(/^[\\/]/, "")
            .split(sep)
            .join("/"),
        }
      : { kind: "outside" };
  }
  if (!isInside(real)) return { kind: "outside" };
  const relative = real
    .slice(realRoot.length)
    .replace(/^[\\/]/, "")
    .split(sep)
    .join("/");
  return { kind: "ok", abs: real, relative };
}

export async function readWorkspaceFileBounded(
  workspaceRoot: string,
  inputPath: string,
): Promise<ReadWorkspaceFileResult> {
  const resolved = await resolveInsideWorkspace(workspaceRoot, inputPath);
  if (resolved.kind === "outside")
    return { ok: false, reason: "outside_workspace" };
  if (resolved.kind === "missing") return { ok: false, reason: "not_found" };
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved.abs);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!stat.isFile()) return { ok: false, reason: "not_a_file" };
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(resolved.abs, "r");
    const cap = Math.min(stat.size, MAX_VIEWER_BYTES);
    const buf = Buffer.alloc(cap);
    const { bytesRead } = await fh.read(buf, 0, cap, 0);
    const head = buf.subarray(0, Math.min(bytesRead, BINARY_SNIFF_BYTES));
    if (head.includes(0)) return { ok: false, reason: "binary" };
    // A UTF-8 BOM decodes to ﻿ and paints as a ghost glyph on line 1
    // of the panel (seen live on a PowerShell-written attachment) — the
    // viewer is presentation, so shed it.
    const text = buf.subarray(0, bytesRead).toString("utf8");
    return {
      ok: true,
      content: text.startsWith("\uFEFF") ? text.slice(1) : text,
      truncated: stat.size > MAX_VIEWER_BYTES,
      size: stat.size,
      relative: resolved.relative,
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/**
 * The rich kinds' read (ADR 0054 §2): the same jail, the whole file as
 * bytes, refused over MAX_VIEWER_RICH_BYTES. No sniffing — the renderer
 * chose this read by extension and its parser is the judge of the bytes.
 */
export async function readWorkspaceBytesBounded(
  workspaceRoot: string,
  inputPath: string,
): Promise<ReadWorkspaceBytesResult> {
  const resolved = await resolveInsideWorkspace(workspaceRoot, inputPath);
  if (resolved.kind === "outside")
    return { ok: false, reason: "outside_workspace" };
  if (resolved.kind === "missing") return { ok: false, reason: "not_found" };
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved.abs);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!stat.isFile()) return { ok: false, reason: "not_a_file" };
  if (stat.size > MAX_VIEWER_RICH_BYTES)
    return { ok: false, reason: "too_large" };
  try {
    const buf = await fs.readFile(resolved.abs);
    // A fresh Uint8Array over its own buffer: a Node Buffer may be a view
    // into a shared pool, and structured clone would carry the whole pool.
    const bytes = new Uint8Array(buf.byteLength);
    bytes.set(buf);
    return { ok: true, bytes, size: stat.size, relative: resolved.relative };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}
