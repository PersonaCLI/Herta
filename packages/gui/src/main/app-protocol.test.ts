import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_BLANK_URL,
  APP_INDEX_URL,
  APP_ORIGIN,
  appContentType,
  isAppDocumentUrl,
  resolveAppFilePath,
} from "./app-protocol.js";

/** The interface on a scheme of its own (owner 2026-11-12): the handler
 *  serves the built interface's directory and nothing else. */

const ROOT = resolve("/app/out/renderer");

describe("resolveAppFilePath — the guard", () => {
  it("maps the interface's own files under the root", () => {
    expect(resolveAppFilePath(APP_INDEX_URL, ROOT)).toBe(
      join(ROOT, "index.html"),
    );
    expect(resolveAppFilePath(`${APP_ORIGIN}/`, ROOT)).toBe(
      join(ROOT, "index.html"),
    );
    expect(
      resolveAppFilePath(`${APP_ORIGIN}/assets/index-C1CPJCN_.js`, ROOT),
    ).toBe(join(ROOT, "assets", "index-C1CPJCN_.js"));
    expect(
      resolveAppFilePath(
        `${APP_ORIGIN}/assets/pdf.worker.min-CHFwMXne.mjs?v=1#x`,
        ROOT,
      ),
    ).toBe(join(ROOT, "assets", "pdf.worker.min-CHFwMXne.mjs"));
    expect(resolveAppFilePath(`${APP_ORIGIN}/assets/%E5%9B%BE.png`, ROOT)).toBe(
      join(ROOT, "assets", "图.png"),
    );
  });

  it("cannot be walked out of the root", () => {
    for (const url of [
      `${APP_ORIGIN}/../main/index.js`,
      `${APP_ORIGIN}/assets/../../main/index.js`,
      `${APP_ORIGIN}/%2e%2e/%2e%2e/main/index.js`,
      `${APP_ORIGIN}/..%2f..%2fmain/index.js`,
      `${APP_ORIGIN}/assets/..%5c..%5cmain%5cindex.js`,
      `${APP_ORIGIN}/C:/Windows/win.ini.js`,
      `${APP_ORIGIN}//evil.example/x.js`,
    ]) {
      const got = resolveAppFilePath(url, ROOT);
      // Whatever a parser folds a traversal into, it stays inside or is
      // refused; it is never a path outside the root.
      if (got !== null) expect(got.startsWith(ROOT), url).toBe(true);
    }
    expect(
      resolveAppFilePath(
        `${APP_ORIGIN}/assets/..%5c..%5cmain%5cindex.js`,
        ROOT,
      ),
    ).toBeNull();
    expect(resolveAppFilePath(`${APP_ORIGIN}/a%00.js`, ROOT)).toBeNull();
  });

  it("answers for its own scheme and host only", () => {
    for (const url of [
      "herta-app://other/index.html",
      "herta-app://app.evil.example/index.html",
      "herta-app://user:pw@app/index.html",
      "herta-app://app:8080/index.html",
      "herta-asset://app/index.html",
      "file:///app/out/renderer/index.html",
      "https://app/index.html",
      "not a url",
    ]) {
      expect(resolveAppFilePath(url, ROOT), url).toBeNull();
    }
  });

  it("serves the kinds of file a built interface holds, and no other", () => {
    for (const name of [
      "a.exe",
      "a.sh",
      "a.node",
      "a.txt",
      "a.pem",
      "a",
      ".env",
      "a.js.bak",
    ]) {
      expect(
        resolveAppFilePath(`${APP_ORIGIN}/${name}`, ROOT),
        name,
      ).toBeNull();
    }
    // A module script is refused by a standard scheme without a script type.
    expect(appContentType("x.js")).toBe("text/javascript; charset=utf-8");
    expect(appContentType("x.MJS")).toBe("text/javascript; charset=utf-8");
    expect(appContentType("x.wasm")).toBe("application/wasm");
    expect(appContentType("index.html")).toBe("text/html; charset=utf-8");
  });

  it("has a content type for every file of the built interface", () => {
    // The build's own output, when there is one: a new kind of asset that
    // the handler would answer 404 for is caught here, not in a release.
    const out = resolve(__dirname, "../../out/renderer");
    if (!existsSync(out)) return;
    const missing = new Set<string>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (appContentType(path) === null) missing.add(extname(name));
      }
    };
    walk(out);
    expect([...missing]).toEqual([]);
  });
});

describe("isAppDocumentUrl — the one address the window may be at", () => {
  it("is the interface's document, with any query or fragment", () => {
    expect(isAppDocumentUrl(APP_INDEX_URL)).toBe(true);
    expect(isAppDocumentUrl(`${APP_INDEX_URL}?x=1`)).toBe(true);
    expect(isAppDocumentUrl(`${APP_INDEX_URL}#top`)).toBe(true);
  });

  it("is nothing else: another file, the blank page, a look-alike, a file: page", () => {
    for (const url of [
      `${APP_ORIGIN}/assets/index.js`,
      APP_BLANK_URL,
      `${APP_ORIGIN}/index.html.evil`,
      "herta-app://app.evil.example/index.html",
      "file:///C:/app/out/renderer/index.html",
      "https://example.com/index.html",
    ]) {
      expect(isAppDocumentUrl(url), url).toBe(false);
    }
  });
});
