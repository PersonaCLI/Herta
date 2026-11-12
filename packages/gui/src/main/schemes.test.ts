import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const registered = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: (schemes: unknown[]) => {
      registered.calls.push(schemes);
    },
    handle: () => undefined,
  },
  net: {},
  BrowserWindow: class {},
}));

import { PRIVILEGED_SCHEMES, registerPrivilegedSchemes } from "./schemes.js";

/** Every scheme in one call (2026-11-12): Electron keeps "secure" only for
 *  the schemes of its last `registerSchemesAsPrivileged`. */

describe("registerPrivilegedSchemes", () => {
  it("declares all five schemes in a single call", () => {
    registered.calls.length = 0;
    registerPrivilegedSchemes();
    expect(registered.calls).toHaveLength(1);
    const names = (registered.calls[0] as { scheme: string }[]).map(
      (s) => s.scheme,
    );
    expect(names.sort()).toEqual([
      "herta-app",
      "herta-asset",
      "herta-attachment",
      "herta-flow",
      "herta-voice",
    ]);
  });

  it("every one is standard and secure: a secure page may load them all", () => {
    for (const entry of PRIVILEGED_SCHEMES) {
      expect(entry.privileges?.standard, entry.scheme).toBe(true);
      expect(entry.privileges?.secure, entry.scheme).toBe(true);
    }
    // No two entries for one scheme.
    expect(new Set(PRIVILEGED_SCHEMES.map((s) => s.scheme)).size).toBe(
      PRIVILEGED_SCHEMES.length,
    );
  });

  it("is the only place in the main process that declares a scheme", () => {
    const callSites: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
        const text = readFileSync(path, "utf8");
        // The call itself, not a mention in a comment.
        const calls = text
          .split("\n")
          .filter(
            (line) =>
              line.includes("registerSchemesAsPrivileged(") &&
              !line.trimStart().startsWith("*") &&
              !line.trimStart().startsWith("//"),
          );
        for (const _ of calls) callSites.push(name);
      }
    };
    walk(__dirname);
    expect(callSites).toEqual(["schemes.ts"]);
  });
});
