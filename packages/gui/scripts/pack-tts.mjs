/**
 * Pack the installed voice-model bundle into the archive the app downloads
 * (ADR 0061), and print the facts `src/main/tts/tts-release.ts` pins.
 *
 *   node scripts/pack-tts.mjs                 # data/tts/herta-best-e72 → out/tts/
 *   node scripts/pack-tts.mjs --out <dir>
 *
 * Deterministic: entries sorted by path, mtime 0, uid/gid 0 (see
 * tar-pack.mjs), so re-packing an unchanged bundle reproduces the same
 * SHA-256. The bundle itself is installed and hash-verified beforehand by
 * the private `scripts/tts-bundle.mjs`; this only wraps what is there and
 * refuses a bundle whose manifest does not verify.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { packTarGz } from "./tar-pack.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
/** Mirrors TTS_BUNDLE_ID in src/main/tts/tts-path.ts. */
const BUNDLE_ID = "herta-best-e72";
const SRC = join(REPO_ROOT, "data", "tts", BUNDLE_ID);

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const OUT_DIR =
  outIdx >= 0 && argv[outIdx + 1] !== undefined
    ? resolve(argv[outIdx + 1])
    : join(REPO_ROOT, "out", "tts");

function fail(msg) {
  console.error(`\n[pack-tts] ERROR: ${msg}\n`);
  process.exit(1);
}

if (!existsSync(join(SRC, "manifest.json"))) {
  fail(`no bundle at ${SRC} — install it first (scripts/tts-bundle.mjs)`);
}
const manifest = JSON.parse(readFileSync(join(SRC, "manifest.json"), "utf8"));
if (manifest.release !== BUNDLE_ID) {
  fail(`bundle release is "${manifest.release}", expected "${BUNDLE_ID}"`);
}

// Every file under the bundle root, including manifest.json itself (the app
// re-verifies each file against it after extraction).
const files = [];
const walk = (d) => {
  for (const entry of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.isFile()) files.push(p);
    else fail(`not a regular file: ${p}`);
  }
};
walk(SRC);
files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// The manifest must describe exactly the files present (minus itself).
const listed = new Set(manifest.files.map((f) => f.path));
let unpacked = 0;
const entries = files.map((p) => {
  const rel = relative(SRC, p).split(sep).join("/");
  const data = readFileSync(p);
  if (rel !== "manifest.json") {
    if (!listed.has(rel)) fail(`${rel} is not in the manifest`);
    const m = manifest.files.find((f) => f.path === rel);
    const hash = createHash("sha256").update(data).digest("hex");
    if (data.length !== m.bytes || hash !== m.sha256) {
      fail(`${rel} does not match the manifest`);
    }
    listed.delete(rel);
  }
  unpacked += data.length;
  return { path: rel, data };
});
if (listed.size > 0)
  fail(`manifest lists missing files: ${[...listed].join(", ")}`);

const archive = packTarGz(entries);
const sha256 = createHash("sha256").update(archive).digest("hex");
mkdirSync(OUT_DIR, { recursive: true });
const target = join(OUT_DIR, `${BUNDLE_ID}.tar.gz`);
writeFileSync(target, archive);
writeFileSync(`${target}.sha256`, `${sha256}  ${BUNDLE_ID}.tar.gz\n`);

console.log(`[pack-tts] ${target}`);
console.log(
  `[pack-tts] files ${entries.length}, unpacked ${unpacked} bytes, archive ${archive.length} bytes`,
);
console.log(`[pack-tts] sha256 ${sha256}`);
console.log(
  "[pack-tts] pin these in src/main/tts/tts-release.ts: " +
    `TTS_ARCHIVE_BYTES = ${archive.length}, TTS_ARCHIVE_SHA256 = "${sha256}", TTS_BUNDLE_BYTES = ${unpacked}`,
);
