import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCsp } from "./csp.js";

describe("buildCsp (audit BL2)", () => {
  let dir: string;
  let indexHtmlPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "herta-csp-"));
    indexHtmlPath = join(dir, "index.html");
    writeFileSync(
      indexHtmlPath,
      `<!doctype html><html><head>
         <style>#boot-splash{inset:0}</style>
         <script>var hint = null;</script>
       </head><body>
         <script type="module" src="./main.js"></script>
       </body></html>`,
      "utf8",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const packaged = () => buildCsp({ isPackaged: true, indexHtmlPath });
  const dev = () =>
    buildCsp({
      isPackaged: false,
      indexHtmlPath,
      devOrigin: "http://localhost:5173",
    });

  it("packaged: denies everything by default and blocks outbound connections", () => {
    const csp = packaged();
    expect(csp).toContain("default-src 'none'");
    // The directive that stops an injected script exfiltrating a transcript —
    // the renderer never talks to the network, the main process does. The one
    // opening is the read-only asset scheme (ADR 0057 §3); no origin, no
    // 'self' (which on a file:// document would match every local file).
    expect(csp).toMatch(/connect-src herta-asset:(;|$)/);
    expect(csp).not.toMatch(/connect-src[^;]*'self'/);
    expect(csp).not.toMatch(/connect-src[^;]*(https?:|ws)/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });

  it("packaged: hashes the inline script instead of allowing inline scripts", () => {
    const csp = packaged();
    expect(csp).toMatch(
      /script-src 'self' 'wasm-unsafe-eval' 'sha256-[A-Za-z0-9+/=]+'/,
    );
    // (style-src keeps its inline allowance for React's style attributes;
    // the script directive must not.)
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    // 'wasm-unsafe-eval' permits WebAssembly compilation only (ADR 0057 §3);
    // the string-eval keyword must stay out of the packaged policy.
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("the hash tracks the FILE, so editing the script cannot silently break it", () => {
    // A hardcoded hash would stop matching on the next edit and the only
    // symptom would be the theme flash returning — a regression nobody would
    // trace back to a CSP constant.
    const before = packaged();
    writeFileSync(
      indexHtmlPath,
      `<html><head><script>var hint = "changed";</script></head></html>`,
      "utf8",
    );
    expect(packaged()).not.toBe(before);
    expect(packaged()).toMatch(/'sha256-[A-Za-z0-9+/=]+'/);
  });

  it("ignores <script src=…> tags — only inline sources need a hash", () => {
    writeFileSync(
      indexHtmlPath,
      `<html><body><script type="module" src="./main.js"></script></body></html>`,
      "utf8",
    );
    expect(packaged()).toContain("script-src 'self'");
    expect(packaged()).not.toContain("sha256-");
  });

  it("keeps the allowances the renderer actually needs", () => {
    const csp = packaged();
    // React writes inline style attributes everywhere; index.html has an
    // inline <style> for the boot splash.
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    // Voice clips are served over the custom scheme.
    expect(csp).toContain("herta-voice:");
    // Vite inlines small assets as data: URIs; attachment images ride their
    // own scheme (ADR 0048) rather than the record; the 3D device card's
    // scalar maps load as images over its scheme (ADR 0057).
    expect(csp).toContain(
      "img-src 'self' data: blob: herta-attachment: herta-asset: herta-flow:",
    );
    // The viewer's PDF renderer runs pdf.js's worker from the bundle (ADR
    // 0054 §5) — the one directive that opened since the audit; workers
    // from anywhere else stay refused.
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).not.toContain("worker-src 'none'");
  });

  it("dev: relaxes exactly what Vite needs, and nothing else", () => {
    const csp = dev();
    expect(csp).toContain("'unsafe-eval'"); // HMR
    expect(csp).toContain("http://localhost:5173");
    expect(csp).toContain("ws:"); // HMR socket
    // The asset scheme is a fixture of both policies, not a dev relaxation.
    expect(csp).toMatch(/connect-src[^;]*herta-asset:/);
    // Still no plugins/frames even in dev.
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("survives a missing index.html rather than throwing at startup", () => {
    const csp = buildCsp({
      isPackaged: true,
      indexHtmlPath: join(dir, "does-not-exist.html"),
    });
    expect(csp).toContain("script-src 'self'");
  });
});
