import { deflateSync } from "node:zlib";

/**
 * Minimal, VALID image bytes for tests (ADR 0048).
 *
 * Real headers rather than stub magic bytes, because the thing under test is
 * header parsing: a fixture that only carried a signature would pass a sniff
 * that never learned to read dimensions. Small enough to build inline; no
 * encoder dependency.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) {
    // The index is masked to a byte, so the lookup is always in range —
    // `noUncheckedIndexedAccess` cannot see that.
    c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** A truecolor PNG of the given size. `payload` overrides the (meaningless)
 *  IDAT body when a test needs particular BYTE LENGTH — e.g. to cross a size
 *  ceiling. */
export function makePng(
  width: number,
  height: number,
  payload?: Buffer,
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", payload ?? deflateSync(Buffer.alloc(16))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A PNG of at least `bytes` total length — for the caption ceiling. The
 *  padding rides an ancillary chunk so the file stays structurally valid. */
export function makePngOfSize(bytes: number): Buffer {
  const base = makePng(8, 8);
  const pad = Math.max(0, bytes - base.length - 12);
  return Buffer.concat([
    base.subarray(0, base.length - 12),
    pngChunk("teXt", Buffer.alloc(pad, 0x61)),
    base.subarray(base.length - 12),
  ]);
}

/** A GIF89a header with the given logical screen size. */
export function makeGif(width: number, height: number): Buffer {
  const head = Buffer.alloc(13);
  head.write("GIF89a", 0, "ascii");
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  return Buffer.concat([head, Buffer.from([0x3b])]);
}

/** A baseline JPEG: SOI, SOF0 carrying the dimensions, EOI. */
export function makeJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(4 + 6);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8, 2); // segment length
  sof[4] = 8; // sample precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    sof.subarray(1),
    Buffer.from([0xff, 0xd9]),
  ]);
}
