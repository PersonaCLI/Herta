import { describe, expect, it } from "vitest";
import {
  isLoopbackHost,
  pageUrlAllowed,
  typedPageUrl,
} from "./browser-page.js";

describe("where a browser page may go (ADR 0083 §8)", () => {
  it("http, https and about:blank; no file, chrome, devtools or javascript", () => {
    for (const ok of [
      "http://localhost:5173/",
      "https://example.com/a?b=1",
      "about:blank",
    ])
      expect(pageUrlAllowed(ok), ok).toBe(true);
    for (const no of [
      "file:///C:/Windows/win.ini",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "javascript:alert(1)",
      "data:text/html,<p>x</p>",
      "about:config",
      "not a url",
    ])
      expect(pageUrlAllowed(no), no).toBe(false);
  });

  it("loopback is this machine only — not the LAN, not a look-alike", () => {
    for (const host of [
      "localhost",
      "app.localhost",
      "127.0.0.1",
      "127.8.9.10",
      "::1",
      "[::1]",
      "LOCALHOST",
    ])
      expect(isLoopbackHost(host), host).toBe(true);
    for (const host of [
      "192.168.1.1",
      "10.0.0.2",
      "printer.local",
      "intranet",
      "localhost.evil.com",
      "128.0.0.1",
    ])
      expect(isLoopbackHost(host), host).toBe(false);
  });

  it("the URL bar: a dev server over http, a bare host over https, a word is no address", () => {
    expect(typedPageUrl("localhost:5173/login")).toBe(
      "http://localhost:5173/login",
    );
    expect(typedPageUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
    expect(typedPageUrl("example.com")).toBe("https://example.com/");
    expect(typedPageUrl("  https://example.com/a?b=1  ")).toBe(
      "https://example.com/a?b=1",
    );
    expect(typedPageUrl("about:blank")).toBe("about:blank");
    for (const no of [
      "",
      "hello",
      "two words.com",
      "file:///etc/passwd",
      "chrome://settings",
      "javascript:alert(1)",
    ])
      expect(typedPageUrl(no), no).toBeNull();
  });
});
