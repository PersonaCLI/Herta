import { describe, expect, it } from "vitest";
import {
  expandWindowsEnv,
  mergeWindowsPath,
  parseRegPathOutput,
  resolveWindowsPath,
} from "./win-path.js";

describe("parseRegPathOutput", () => {
  const regOutput = [
    "",
    "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    "    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\nodejs\\",
    "",
  ].join("\r\n");

  it("extracts the value from reg query output (REG_EXPAND_SZ, CRLF)", () => {
    expect(parseRegPathOutput(regOutput)).toBe(
      "%SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\nodejs\\",
    );
  });

  it("accepts REG_SZ (a user PATH set without variables)", () => {
    expect(parseRegPathOutput("    Path    REG_SZ    C:\\Users\\u\\bin")).toBe(
      "C:\\Users\\u\\bin",
    );
  });

  it("returns null when the value is absent or empty", () => {
    expect(parseRegPathOutput("ERROR: The system was unable to find it.")).toBe(
      null,
    );
    expect(parseRegPathOutput("    Path    REG_SZ    ")).toBe(null);
    expect(parseRegPathOutput("")).toBe(null);
  });
});

describe("expandWindowsEnv", () => {
  it("expands %VAR% case-insensitively and leaves unknown references literal", () => {
    const env = { SystemRoot: "C:\\Windows" };
    expect(
      expandWindowsEnv("%systemroot%\\system32;%NO_SUCH_VAR%\\bin", env),
    ).toBe("C:\\Windows\\system32;%NO_SUCH_VAR%\\bin");
  });
});

describe("mergeWindowsPath", () => {
  it("appends missing entries, preserving base order and spelling", () => {
    expect(mergeWindowsPath("C:\\a;C:\\b", ["C:\\c", "C:\\a"])).toBe(
      "C:\\a;C:\\b;C:\\c",
    );
  });

  it("dedupes case-insensitively — the base spelling wins", () => {
    expect(mergeWindowsPath("C:\\Nodejs", ["c:\\nodejs", "C:\\x"])).toBe(
      "C:\\Nodejs;C:\\x",
    );
  });

  it("drops empty entries (a trailing `;` is common in real PATHs)", () => {
    expect(mergeWindowsPath("C:\\a;;", ["", "C:\\b"])).toBe("C:\\a;C:\\b");
  });
});

describe("resolveWindowsPath", () => {
  it("is a no-op off win32 and never probes there", async () => {
    let probed = 0;
    const r = await resolveWindowsPath({
      platform: "darwin",
      env: { PATH: "/usr/bin" },
      probe: async () => {
        probed += 1;
        return "C:\\x";
      },
    });
    expect(r).toBeNull();
    expect(probed).toBe(0);
  });

  it("appends registry entries missing from the inherited PATH, machine before user", async () => {
    const r = await resolveWindowsPath({
      platform: "win32",
      env: { PATH: "C:\\inherited", SystemRoot: "C:\\Windows" },
      probe: async (hive) =>
        hive === "machine"
          ? "%SystemRoot%\\system32;C:\\Program Files\\nodejs\\"
          : "C:\\Users\\u\\AppData\\Roaming\\npm",
    });
    expect(r).toBe(
      "C:\\inherited;C:\\Windows\\system32;C:\\Program Files\\nodejs\\;C:\\Users\\u\\AppData\\Roaming\\npm",
    );
  });

  it("returns null when the inherited PATH already covers the registry (nothing to change)", async () => {
    const r = await resolveWindowsPath({
      platform: "win32",
      env: { PATH: "C:\\Windows\\system32;C:\\nodejs" },
      probe: async (hive) =>
        hive === "machine" ? "c:\\windows\\SYSTEM32" : "C:\\NODEJS",
    });
    expect(r).toBeNull();
  });

  it("returns null when both hives are unreadable, and survives a throwing probe", async () => {
    expect(
      await resolveWindowsPath({
        platform: "win32",
        env: { PATH: "C:\\a" },
        probe: async () => null,
      }),
    ).toBeNull();
    expect(
      await resolveWindowsPath({
        platform: "win32",
        env: { PATH: "C:\\a" },
        probe: async () => {
          throw new Error("registry unavailable");
        },
      }),
    ).toBeNull();
  });

  // win32-only: hits the real registry through the real reg.exe — proves the
  // query shape and the parser against a live machine PATH (every Windows
  // machine PATH contains %SystemRoot%\system32).
  //
  // Not under test here: the 2 s startup budget on each probe. Under
  // full-suite contention a reg.exe spawn has taken 2.7 s (~88 ms alone), and
  // a probe killed at its deadline is reported as "hive unreadable" — the
  // resolver then answers with the user PATH alone, which this assertion
  // would misread as a wrong PATH. So the probe deadline is lifted PAST the
  // per-test timeout: a registry too slow for the suite fails as a timeout,
  // and a missing system32 can only mean the query or the parser is wrong.
  const REAL_REGISTRY_TEST_TIMEOUT_MS = 30_000;
  it.skipIf(process.platform !== "win32")(
    "reads the real machine PATH from the registry",
    async () => {
      const r = await resolveWindowsPath({
        platform: "win32",
        // An empty inherited PATH forces the merge to differ, so the resolved
        // value IS the expanded registry PATH.
        env: { PATH: "", SystemRoot: process.env.SystemRoot },
        probeTimeoutMs: REAL_REGISTRY_TEST_TIMEOUT_MS * 2,
      });
      expect(r).not.toBeNull();
      expect((r ?? "").toLowerCase()).toContain("system32");
    },
    REAL_REGISTRY_TEST_TIMEOUT_MS,
  );
});
