import { describe, expect, it } from "vitest";
import {
  allowedEnvKeys,
  findDisallowedEnvKey,
  isShellLocalName,
} from "./env-guard.js";

describe("findDisallowedEnvKey", () => {
  it("passes the inert config keys the parameter exists for", () => {
    expect(
      findDisallowedEnvKey({ NODE_ENV: "test", PORT: "3000", CI: "1" }),
    ).toBeNull();
    expect(
      findDisallowedEnvKey({ TZ: "UTC", LANG: "C", NO_COLOR: "1" }),
    ).toBeNull();
  });

  it("is case-insensitive (Windows env lookups fold case)", () => {
    expect(findDisallowedEnvKey({ node_env: "test" })).toBeNull();
    expect(findDisallowedEnvKey({ Port: "3000" })).toBeNull();
    expect(findDisallowedEnvKey({ path: "/evil" })).toBe("path");
    expect(findDisallowedEnvKey({ Path: "/evil" })).toBe("Path");
  });

  // ── The exploit that inverted this guard (audit 2026-08-05, S1) ──────────
  // REPRODUCED against the real binary before the fix: `git diff` is
  // unconditional allow-tier — no approval card anywhere in its path — and
  //   GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.external GIT_CONFIG_VALUE_0=<cmd>
  // made it execute <cmd>. The old denylist enumerated git's exec-hook
  // variables and did not contain GIT_CONFIG_*, which can set every one of
  // them (and any other git config key).
  it("rejects the GIT_CONFIG_* family that turned `git diff` into RCE", () => {
    expect(findDisallowedEnvKey({ GIT_CONFIG_COUNT: "1" })).toBe(
      "GIT_CONFIG_COUNT",
    );
    expect(findDisallowedEnvKey({ GIT_CONFIG_KEY_0: "diff.external" })).toBe(
      "GIT_CONFIG_KEY_0",
    );
    expect(findDisallowedEnvKey({ GIT_CONFIG_VALUE_0: "sh payload.sh" })).toBe(
      "GIT_CONFIG_VALUE_0",
    );
    expect(findDisallowedEnvKey({ GIT_CONFIG_GLOBAL: "/tmp/evil" })).toBe(
      "GIT_CONFIG_GLOBAL",
    );
    expect(findDisallowedEnvKey({ GIT_CONFIG_SYSTEM: "/tmp/evil" })).toBe(
      "GIT_CONFIG_SYSTEM",
    );
    // …and the exec hooks the old list did cover, still covered.
    expect(findDisallowedEnvKey({ GIT_SSH_COMMAND: "evil" })).toBe(
      "GIT_SSH_COMMAND",
    );
    expect(findDisallowedEnvKey({ GIT_EXTERNAL_DIFF: "evil" })).toBe(
      "GIT_EXTERNAL_DIFF",
    );
    // GIT_TRACE writes to an attacker-chosen absolute path, unseen by the
    // path guards.
    expect(findDisallowedEnvKey({ GIT_TRACE: "/etc/cron.d/x" })).toBe(
      "GIT_TRACE",
    );
  });

  it("rejects module search paths (a planted module executes on import)", () => {
    // `pytest` is unconditional allow-tier; PYTHONPATH + a planted
    // sitecustomize.py is the same shape as the git one.
    for (const key of [
      "PYTHONPATH",
      "NODE_PATH",
      "PERL5LIB",
      "RUBYLIB",
      "GEM_PATH",
      "CLASSPATH",
    ]) {
      expect(findDisallowedEnvKey({ [key]: "/evil" })).toBe(key);
    }
  });

  it("rejects binary resolution, loaders, and interpreter preloads", () => {
    expect(findDisallowedEnvKey({ PATH: "/evil" })).toBe("PATH");
    expect(findDisallowedEnvKey({ COMSPEC: "evil.exe" })).toBe("COMSPEC");
    expect(findDisallowedEnvKey({ LD_PRELOAD: "/x.so" })).toBe("LD_PRELOAD");
    expect(findDisallowedEnvKey({ DYLD_INSERT_LIBRARIES: "/x.dylib" })).toBe(
      "DYLD_INSERT_LIBRARIES",
    );
    expect(findDisallowedEnvKey({ NODE_OPTIONS: "--require ./x" })).toBe(
      "NODE_OPTIONS",
    );
    expect(findDisallowedEnvKey({ PERL5OPT: "-Mevil" })).toBe("PERL5OPT");
    expect(findDisallowedEnvKey({ RUBYOPT: "-revil" })).toBe("RUBYOPT");
    expect(findDisallowedEnvKey({ BASH_ENV: "/evil.sh" })).toBe("BASH_ENV");
    expect(findDisallowedEnvKey({ PYTHONSTARTUP: "/evil.py" })).toBe(
      "PYTHONSTARTUP",
    );
  });

  it("rejects the variables a denylist would have missed NEXT", () => {
    // The point of the inversion: these were never on the old list either.
    expect(findDisallowedEnvKey({ GOFLAGS: "-toolexec=/evil" })).toBe(
      "GOFLAGS",
    );
    expect(findDisallowedEnvKey({ npm_config_script_shell: "/evil" })).toBe(
      "npm_config_script_shell",
    );
    expect(findDisallowedEnvKey({ CARGO_BUILD_RUSTC: "/evil" })).toBe(
      "CARGO_BUILD_RUSTC",
    );
    expect(findDisallowedEnvKey({ MAKEFLAGS: "--eval=$(evil)" })).toBe(
      "MAKEFLAGS",
    );
  });

  it("rejects an unrecognized key rather than reasoning about it", () => {
    // Fail-closed: the previous guard passed anything it did not recognize,
    // which is precisely how GIT_CONFIG_* got through.
    expect(findDisallowedEnvKey({ MY_APP_FLAG: "1" })).toBe("MY_APP_FLAG");
    expect(findDisallowedEnvKey({ SOME_FUTURE_LOADER_VAR: "x" })).toBe(
      "SOME_FUTURE_LOADER_VAR",
    );
  });

  it("returns a disallowed key even when mixed with allowed ones", () => {
    const got = findDisallowedEnvKey({
      NODE_ENV: "x",
      GIT_CONFIG_COUNT: "1",
      PORT: "3000",
    });
    expect(got).toBe("GIT_CONFIG_COUNT");
  });

  it("exposes the allowed set for the error message", () => {
    expect(allowedEnvKeys).toContain("NODE_ENV");
    expect(allowedEnvKeys).toContain("PORT");
    expect(allowedEnvKeys).not.toContain("PATH");
    expect(allowedEnvKeys.every((k) => k === k.toUpperCase())).toBe(true);
  });
});

describe("isShellLocalName (review 2026-11-10)", () => {
  it("takes the names a script gives its own variables", () => {
    for (const name of ["f", "i", "line", "file", "dir", "_", "pkg_name", "n2"])
      expect(isShellLocalName(name), name).toBe(true);
  });

  it("refuses anything with a capital in it — the environment's own spelling", () => {
    for (const name of ["PATH", "NODE_OPTIONS", "FILE", "Path", "myVar", "F"])
      expect(isShellLocalName(name), name).toBe(false);
  });

  it("refuses the lower-case names programs do read", () => {
    for (const name of [
      "npm_config_script_shell",
      "npm_package_name",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "tmp",
      "temp",
      "tmpdir",
      "windir",
    ])
      expect(isShellLocalName(name), name).toBe(false);
  });

  it("is not a name at all: no verdict of local", () => {
    for (const name of ["", "1f", "a-b", "a b", "a=b", "$f"])
      expect(isShellLocalName(name), name).toBe(false);
  });
});
