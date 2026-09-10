/**
 * THIRD-PARTY-NOTICES.md — generated from what the installer actually ships.
 *
 *   node packages/gui/scripts/third-party-notices.mjs          # (re)write
 *   node packages/gui/scripts/third-party-notices.mjs --check  # release gate
 *
 * WHY THIS EXISTS (pre-publish audit BL26, closed 2026-08-16). The packaged
 * app is a single rollup bundle per process; every third-party library in it
 * is redistributed inside our binary. MIT/ISC/BlueOak require the copyright
 * and permission notice to travel with the code; Apache-2.0 (pdfjs-dist, since
 * ADR 0038) additionally requires a copy of the license itself. Until this
 * file, the installer carried only our own LICENSE.
 *
 * WHY GENERATED FROM THE BUNDLE, not from package.json. Manifests over-count
 * (better-sqlite3 is a declared dependency and is tree-shaken clean out — the
 * packaging invariant CI greps for) and a hand-kept list under-counts the day
 * someone adds a dependency. `electron.vite.config.ts` writes
 * `out/bundle-manifest.json` — every module id rollup rendered into main,
 * preload and renderer — and this script maps those ids to package roots,
 * reads each package's own license file, and renders a deterministic
 * document. `--check` regenerates and diffs, so `pnpm dist*`, mac-build and
 * the daily CI all fail when a new dependency ships without its notice.
 *
 * NOT covered here, on purpose: Electron / Chromium / Node — electron-builder
 * places LICENSE.electron.txt and LICENSES.chromium.html beside the binary
 * itself; and the character / voice / artwork IP, which is not software and
 * is addressed by the scope note in LICENSE. Both are pointed to in the
 * preamble so a reader of this file is not left thinking it is the whole
 * story.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const MANIFEST = resolve(HERE, "../out/bundle-manifest.json");
const OUTPUT = resolve(REPO_ROOT, "THIRD-PARTY-NOTICES.md");
const CHECK = process.argv.includes("--check");

if (!existsSync(MANIFEST)) {
  console.error(
    `third-party-notices: ${MANIFEST} not found — run the GUI build first ` +
      "(pnpm build:gui); electron.vite.config.ts writes it.",
  );
  process.exit(2);
}

/** @type {Record<string, string[]>} */
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const sections = ["main", "preload", "renderer"];
for (const s of sections) {
  if (!Array.isArray(manifest[s])) {
    console.error(
      `third-party-notices: manifest has no "${s}" section — the build did ` +
        "not run all three targets; run a full pnpm build:gui.",
    );
    process.exit(2);
  }
}

// ---- module id → package root ---------------------------------------------

/**
 * `.../node_modules/.pnpm/<x>@<v>/node_modules/<name>/lib/a.js` → the root of
 * `<name>` (scoped names take two segments). Anything without a
 * `/node_modules/` segment is our own source; anything starting with `\0` is
 * a rollup virtual module (commonjs helpers, vite polyfills). Both skipped.
 */
function packageRootOf(id) {
  if (id.startsWith("\0")) return null;
  const norm = id.replace(/\\/g, "/");
  const marker = "/node_modules/";
  const at = norm.lastIndexOf(marker);
  if (at === -1) return null;
  const rest = norm.slice(at + marker.length);
  const seg = rest.split("/");
  const name = seg[0]?.startsWith("@") ? `${seg[0]}/${seg[1]}` : seg[0];
  if (!name) return null;
  return {
    name,
    root: norm.slice(0, at + marker.length + name.length),
  };
}

/** @type {Map<string, {name:string, version:string, root:string, sections:Set<string>}>} */
const packages = new Map();
for (const section of sections) {
  for (const id of manifest[section]) {
    const hit = packageRootOf(id);
    if (hit === null) continue;
    const pj = readJson(join(hit.root, "package.json"));
    if (pj === null) {
      console.error(`third-party-notices: no package.json at ${hit.root}`);
      process.exit(2);
    }
    // Workspace packages (@herta/*) live under node_modules as symlinks in
    // some layouts; they are ours, not third-party.
    if (pj.private === true && String(pj.name ?? "").startsWith("@herta/")) {
      continue;
    }
    const key = `${pj.name}@${pj.version}`;
    const entry = packages.get(key) ?? {
      name: pj.name,
      version: pj.version,
      root: hit.root,
      sections: new Set(),
    };
    entry.sections.add(section);
    packages.set(key, entry);
  }
}

// ---- per-package metadata ---------------------------------------------------

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function licenseId(pj) {
  const l = pj.license ?? pj.licenses;
  if (typeof l === "string") return l;
  if (Array.isArray(l)) return l.map((x) => x?.type ?? String(x)).join(" OR ");
  if (l && typeof l === "object" && typeof l.type === "string") return l.type;
  return "UNKNOWN";
}

function authorLine(pj) {
  const a = pj.author;
  if (typeof a === "string") return a;
  if (a && typeof a === "object" && typeof a.name === "string") return a.name;
  return null;
}

function repoUrl(pj) {
  const r = pj.repository;
  let url = typeof r === "string" ? r : r?.url;
  if (typeof url !== "string") return pj.homepage ?? null;
  url = url.replace(/^git\+/, "").replace(/\.git$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  url = url
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://");
  return url;
}

/** Every license-ish file the package ships, in a stable order. Apache
 *  packages may carry a NOTICE beside the LICENSE; both must travel. */
function licenseFiles(root) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^(LICEN[CS]E|COPYING|NOTICE)(\.|$)/i.test(n))
    .sort((a, b) => a.localeCompare(b))
    .map((n) => ({
      name: n,
      text: readFileSync(join(root, n), "utf8")
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+$/gm, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    }));
}

/** Fallback when a package declares a license but ships no text. Only the
 *  MIT/ISC shapes are anticipated; anything else is reported and stops the
 *  run rather than being papered over. */
const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const entries = [...packages.values()]
  .map((e) => {
    const pj = readJson(join(e.root, "package.json")) ?? {};
    const files = licenseFiles(e.root);
    const id = licenseId(pj);
    if (files.length === 0) {
      if (id !== "MIT") {
        console.error(
          `third-party-notices: ${e.name}@${e.version} declares "${id}" but ` +
            "ships no license file — add its text by hand before shipping.",
        );
        process.exit(2);
      }
      const who = authorLine(pj);
      files.push({
        name: "(no license file in package; MIT text as declared)",
        text: `${who ? `Copyright (c) ${who}\n\n` : ""}${MIT_TEXT}`,
      });
    }
    return {
      ...e,
      license: id,
      author: authorLine(pj),
      url: repoUrl(pj),
      files,
    };
  })
  .sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );

// ---- files shipped OUTSIDE the bundles --------------------------------------

/**
 * The 3D device card's Basis Universal transcoder (ADR 0057) is copied from
 * three's examples into `src/renderer/public/device-scene/basis/`, which
 * Vite carries into out/renderer as-is — never rendered into a chunk, so the
 * manifest above cannot see it. Listed by hand, gated on the file actually
 * being in the build output, with the Apache-2.0 text kept beside it in
 * resources/licenses (three's package ships only a README pointer).
 */
const BASIS_WASM = resolve(
  HERE,
  "../out/renderer/device-scene/basis/basis_transcoder.wasm",
);
const extras = [];
if (existsSync(BASIS_WASM)) {
  const three = readJson(resolve(HERE, "../node_modules/three/package.json"));
  const text = readFileSync(
    resolve(HERE, "../resources/licenses/basis-universal-LICENSE.txt"),
    "utf8",
  )
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  extras.push({
    name: "basis_universal (KTX2 transcoder)",
    version: `as vendored by three ${three?.version ?? "unknown"}`,
    license: "Apache-2.0",
    author: "Binomial LLC",
    url: "https://github.com/BinomialLLC/basis_universal",
    sections: new Set(["renderer"]),
    shipped: "renderer assets (out/renderer/device-scene/basis/)",
    files: [{ name: "LICENSE", text }],
  });
}
/**
 * The neural-voice runtime (ADR 0042 / ADR 0061): `sherpa-onnx-node` and its
 * platform package are staged by `scripts/stage-tts.mjs` into
 * `<resources>/tts-runtime/` as a plain directory — a native addon the
 * worker `require`s by path, never rendered into a chunk, so the manifest
 * above cannot see it either. Neither npm package ships a license file; the
 * texts are kept in resources/licenses. Gated on the DEPENDENCY being
 * installed rather than on the staged directory: the daily CI regenerates
 * the notices without ever staging, and gating on `tts-runtime/` would have
 * it report the release's notices as stale.
 */
const SHERPA_PKG = resolve(HERE, "../node_modules/sherpa-onnx-node/package.json");
if (existsSync(SHERPA_PKG)) {
  const sherpa = readJson(SHERPA_PKG) ?? {};
  const licenseText = (name) =>
    readFileSync(resolve(HERE, `../resources/licenses/${name}`), "utf8")
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+$/gm, "")
      .trim();
  extras.push({
    name: "sherpa-onnx (neural-voice runtime)",
    version: String(sherpa.version ?? "unknown"),
    license: "Apache-2.0",
    author: "The next-gen Kaldi team (Xiaomi Corporation)",
    url: "https://github.com/k2-fsa/sherpa-onnx",
    sections: new Set(["main"]),
    shipped: "resources/tts-runtime/ (native addon, utility process)",
    files: [{ name: "LICENSE", text: licenseText("sherpa-onnx-LICENSE.txt") }],
  });
  extras.push({
    name: "onnxruntime (bundled by sherpa-onnx)",
    version: `as bundled by sherpa-onnx ${sherpa.version ?? "unknown"}`,
    license: "MIT",
    author: "Microsoft Corporation",
    url: "https://github.com/microsoft/onnxruntime",
    sections: new Set(["main"]),
    shipped: "resources/tts-runtime/ (native library)",
    files: [{ name: "LICENSE", text: licenseText("onnxruntime-LICENSE.txt") }],
  });
}
const listed = [...entries, ...extras].sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);

// ---- render ----------------------------------------------------------------

const where = (s) =>
  [...s]
    .sort()
    .map(
      (x) =>
        ({ main: "main process", preload: "preload", renderer: "renderer" })[x],
    )
    .join(", ");

let md = "";
md += "# Third-party notices\n\n";
md +=
  "Herta's installers ship the app as bundled JavaScript: every library below\n" +
  "is compiled into the main-process or renderer bundle and redistributed\n" +
  "inside the binary under its own license, reproduced here in full. This file\n" +
  "is GENERATED from the bundle itself (`packages/gui/scripts/third-party-notices.mjs`,\n" +
  "reading the module manifest `electron.vite.config.ts` writes at build time),\n" +
  "so it lists exactly what ships — not what is declared — and a release build\n" +
  "fails if it goes stale.\n\n";
md +=
  "Not listed here, because they travel separately:\n\n" +
  "- **Electron, Chromium and Node.js** — electron-builder places\n" +
  "  `LICENSE.electron.txt` and `LICENSES.chromium.html` next to the executable.\n" +
  "- **Herta's own code** — MIT, see `LICENSE`.\n" +
  "- **The character, artwork and voice** — not software; see the scope note at\n" +
  "  the top of `LICENSE` (Herta is a character from Honkai: Star Rail, ©\n" +
  "  HoYoverse; this is an unofficial fan project).\n\n";

md += "## Summary\n\n";
md += "| Package | Version | License | Bundled into |\n";
md += "|---|---|---|---|\n";
for (const e of listed) {
  md += `| ${e.name} | ${e.version} | ${e.license} | ${e.shipped ?? where(e.sections)} |\n`;
}
md += "\n";

md += "## Licenses\n\n";
for (const e of listed) {
  md += `### ${e.name} ${e.version} — ${e.license}\n\n`;
  const meta = [];
  if (e.author) meta.push(`Author: ${e.author}`);
  if (e.url) meta.push(`Source: ${e.url}`);
  meta.push(
    e.shipped
      ? `Shipped as: ${e.shipped}`
      : `Bundled into: ${where(e.sections)}`,
  );
  md += `${meta.map((m) => `- ${m}`).join("\n")}\n\n`;
  for (const f of e.files) {
    if (e.files.length > 1) md += `**${f.name}**\n\n`;
    md += "```text\n";
    md += `${f.text}\n`;
    md += "```\n\n";
  }
}
md = `${md.trimEnd()}\n`;

// ---- write or check --------------------------------------------------------

if (CHECK) {
  const current = existsSync(OUTPUT)
    ? readFileSync(OUTPUT, "utf8").replace(/\r\n?/g, "\n")
    : "";
  if (current !== md) {
    console.error(
      `third-party-notices: ${OUTPUT} is STALE against the current bundle ` +
        `(${listed.length} packages). Regenerate with\n` +
        "  node packages/gui/scripts/third-party-notices.mjs\n" +
        "and commit the result — a dependency shipped without its notice.",
    );
    process.exit(1);
  }
  console.log(
    `third-party-notices: up to date (${listed.length} packages: ` +
      `${listed.map((e) => e.name).join(", ")})`,
  );
} else {
  writeFileSync(OUTPUT, md);
  console.log(
    `third-party-notices: wrote ${OUTPUT} (${listed.length} packages)`,
  );
  for (const e of listed) {
    console.log(
      `  ${e.name}@${e.version}  ${e.license}  [${where(e.sections)}]`,
    );
  }
}
