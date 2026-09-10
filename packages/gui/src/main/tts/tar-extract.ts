import { mkdir, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isPathInside } from "@herta/core";

/**
 * A streaming ustar reader for the voice-model archive (ADR 0061).
 *
 * The archive is produced by `scripts/tar-pack.mjs` (regular files only) and
 * reaches this code ONLY after its SHA-256 matched the hash pinned in the
 * app, so this is not a general-purpose tar implementation and does not try
 * to be one: it accepts regular files and directories, refuses everything
 * else (links, devices, PAX/GNU extensions), and refuses any path that would
 * land outside `dest`. The hash pin is the security boundary; these checks
 * are the belt to its braces.
 *
 * Streaming so a 116 MB bundle never sits in memory: the gunzip stream's
 * chunks are consumed as they arrive and each file is written as its bytes
 * pass through.
 */
const BLOCK = 512;

export interface TarExtractResult {
  readonly files: number;
  readonly bytes: number;
}

export interface TarExtractOptions {
  /** Refuse an archive whose declared file sizes sum past this (a bomb, a
   *  wrong archive) — the caller knows the bundle's unpacked size. */
  readonly maxBytes: number;
}

class ByteReader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;
  private readonly it: AsyncIterator<Uint8Array>;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.it = source[Symbol.asyncIterator]();
  }

  /** Buffer at least `n` bytes, or until the source ends. */
  private async fill(n: number): Promise<void> {
    while (this.buffered < n && !this.done) {
      const { value, done } = await this.it.next();
      if (done) {
        this.done = true;
        break;
      }
      if (value.length > 0) {
        this.chunks.push(value);
        this.buffered += value.length;
      }
    }
  }

  /** Exactly `n` bytes, or null at a clean end (0 buffered); throws on a
   *  truncated stream. */
  async take(n: number): Promise<Buffer | null> {
    await this.fill(n);
    if (this.buffered === 0 && n > 0) return null;
    if (this.buffered < n) throw new Error("archive truncated");
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0];
      if (head === undefined) throw new Error("archive truncated");
      const want = n - off;
      if (head.length <= want) {
        out.set(head, off);
        off += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, want), off);
        this.chunks[0] = head.subarray(want);
        off += want;
      }
    }
    this.buffered -= n;
    return out;
  }

  /** Up to `n` bytes (at least 1 unless the stream ended). */
  async takeUpTo(n: number): Promise<Buffer | null> {
    await this.fill(1);
    const head = this.chunks[0];
    if (head === undefined) return null;
    const m = Math.min(n, head.length);
    const out = Buffer.from(head.subarray(0, m));
    if (m === head.length) this.chunks.shift();
    else this.chunks[0] = head.subarray(m);
    this.buffered -= m;
    return out;
  }
}

function field(h: Buffer, off: number, len: number): string {
  const raw = h.subarray(off, off + len);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul === -1 ? len : nul).toString("utf8");
}

function octal(h: Buffer, off: number, len: number): number {
  const s = field(h, off, len).trim();
  if (s.length === 0) return 0;
  if (!/^[0-7]+$/.test(s)) throw new Error("bad octal field in tar header");
  return Number.parseInt(s, 8);
}

function checksumOk(h: Buffer): boolean {
  const declared = octal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    sum += i >= 148 && i < 156 ? 0x20 : (h[i] ?? 0);
  }
  return sum === declared;
}

/** The safe absolute target for an entry path, or a thrown error. */
export function safeEntryPath(dest: string, entry: string): string {
  if (
    entry.length === 0 ||
    entry.startsWith("/") ||
    entry.includes("\\") ||
    entry.includes("\0") ||
    entry.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    throw new Error(`refusing tar entry path: ${JSON.stringify(entry)}`);
  }
  const root = resolve(dest);
  const target = resolve(root, ...entry.split("/"));
  if (!isPathInside(root, target)) {
    throw new Error(`tar entry escapes the target: ${JSON.stringify(entry)}`);
  }
  return target;
}

/**
 * Extract a tar stream into `dest` (created as needed). Throws on any
 * malformed, truncated, oversized or unsafe archive; the caller removes the
 * partial `dest`.
 */
export async function extractTar(
  source: AsyncIterable<Uint8Array>,
  dest: string,
  opts: TarExtractOptions,
): Promise<TarExtractResult> {
  const reader = new ByteReader(source);
  await mkdir(dest, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (;;) {
    const h = await reader.take(BLOCK);
    if (h === null) break; // clean end without the zero blocks — accept
    if (h.every((b) => b === 0)) {
      // End-of-archive marker (two zero blocks); anything after is ignored.
      break;
    }
    if (!checksumOk(h)) throw new Error("bad tar header checksum");
    const magic = field(h, 257, 6);
    if (magic !== "ustar") throw new Error("not a ustar archive");
    const name = field(h, 0, 100);
    const prefix = field(h, 345, 155);
    const entry = prefix.length > 0 ? `${prefix}/${name}` : name;
    const size = octal(h, 124, 12);
    const type = h[156] ?? 0x30;
    const target = safeEntryPath(dest, entry);
    if (type === 0x35 /* '5' directory */) {
      if (size !== 0) throw new Error("directory entry with a size");
      await mkdir(target, { recursive: true });
      continue;
    }
    if (type !== 0x30 && type !== 0) {
      throw new Error(
        `unsupported tar entry type ${String.fromCharCode(type)}`,
      );
    }
    bytes += size;
    if (bytes > opts.maxBytes) throw new Error("archive larger than expected");
    await mkdir(dirname(target), { recursive: true });
    const fh = await open(target, "w");
    try {
      let remaining = size;
      while (remaining > 0) {
        const chunk = await reader.takeUpTo(remaining);
        if (chunk === null) throw new Error("archive truncated");
        await fh.write(chunk);
        remaining -= chunk.length;
      }
    } finally {
      await fh.close();
    }
    const pad = (BLOCK - (size % BLOCK)) % BLOCK;
    if (pad > 0 && (await reader.take(pad)) === null) {
      throw new Error("archive truncated");
    }
    files += 1;
  }
  return { files, bytes };
}

/** Convenience for callers holding the archive on disk. */
export function tarTargetPath(dest: string, entry: string): string {
  return join(dest, ...entry.split("/"));
}
