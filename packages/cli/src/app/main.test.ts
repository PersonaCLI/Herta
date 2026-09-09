import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockReadable, MockWritable } from "../testing/mock-streams.js";
import { main } from "./main.js";

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

describe("main", () => {
  it("--help prints usage to stdout and returns 0", async () => {
    const out = new MockWritable();
    const err = new MockWritable();
    const code = await main(["--help"], {
      stdout: out,
      stderr: err,
      stdin: process.stdin,
    });
    expect(code).toBe(0);
    expect(out.full()).toContain("usage");
    expect(out.full()).toContain("--help");
    expect(out.full()).toContain("--version");
  });

  it("--version prints version to stdout and returns 0", async () => {
    const out = new MockWritable();
    const err = new MockWritable();
    const code = await main(["--version"], {
      stdout: out,
      stderr: err,
      stdin: process.stdin,
    });
    expect(code).toBe(0);
    expect(out.full()).toMatch(/Herta v\d+\.\d+\.\d+/);
  });

  // A real temp workspace, never a made-up absolute path: main creates
  // `<cwd>/.herta/.gitignore` before the key lookup, and on Windows a
  // root-relative `/x` resolves against the current drive — the earlier
  // `/nonexistent-test-cwd` left `E:\nonexistent-test-cwd\.herta` on the
  // owner's disk for a month (2026-08-06).
  it("missing API key returns 2 with stderr message", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "herta-main-key-"));
    try {
      process.env.DEEPSEEK_API_KEY = "";
      const out = new MockWritable();
      const err = new MockWritable();
      const code = await main([], {
        stdout: out,
        stderr: err,
        stdin: process.stdin,
        cwd: tmp,
        homedir: join(tmp, "home"),
      });
      expect(code).toBe(2);
      expect(err.full()).toContain("DeepSeek API key");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("main — --lang flag", () => {
  it("--help mentions --lang", async () => {
    const out = new MockWritable();
    const err = new MockWritable();
    const code = await main(["--help"], {
      stdout: out,
      stderr: err,
      stdin: process.stdin,
    });
    expect(code).toBe(0);
    expect(out.full()).toContain("--lang");
  });

  it("--lang with an invalid value exits 2 before any key lookup", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "herta-main-lang-"));
    try {
      const out = new MockWritable();
      const err = new MockWritable();
      const code = await main(["--lang", "de"], {
        stdout: out,
        stderr: err,
        stdin: process.stdin,
        cwd: tmp,
        homedir: join(tmp, "home"),
      });
      expect(code).toBe(2);
      expect(err.full()).toContain("--lang");
      expect(err.full()).toContain("de");
      // Fails on flag validation, not on the missing API key.
      expect(err.full()).not.toContain("API key");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bare --lang (missing value) exits 2", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "herta-main-lang-"));
    try {
      const out = new MockWritable();
      const err = new MockWritable();
      const code = await main(["--lang"], {
        stdout: out,
        stderr: err,
        stdin: process.stdin,
        cwd: tmp,
        homedir: join(tmp, "home"),
      });
      expect(code).toBe(2);
      expect(err.full()).toContain("expected zh or en");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("main — per-session language pinning", () => {
  function writeEnSession(cwd: string, sessionId: string): void {
    const tdir = join(cwd, ".herta", "transcript", "v2");
    mkdirSync(tdir, { recursive: true });
    const header = JSON.stringify({
      _kind: "session_meta",
      version: 1,
      sessionId,
      startedAt: "2026-07-01T00:00:00.000Z",
      workspaceRoot: cwd,
      lang: "en",
    });
    writeFileSync(
      join(tdir, `${sessionId}.jsonl`),
      `${header}\n{"kind":"user","text":"hi"}\n`,
      "utf8",
    );
  }

  it("--resume keeps the header language over a conflicting --lang and warns", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "herta-main-pin-"));
    try {
      writeEnSession(tmp, "eeee1111");
      process.env.DEEPSEEK_API_KEY = "";
      const out = new MockWritable();
      const err = new MockWritable();
      const code = await main(["--resume", "eeee", "--lang", "zh"], {
        stdout: out,
        stderr: err,
        stdin: process.stdin,
        cwd: tmp,
        homedir: join(tmp, "home"),
      });
      // Still exits 2 at the key lookup — the pin (and its warning) runs first.
      expect(code).toBe(2);
      expect(err.full()).toContain("created as en");
      expect(err.full()).toContain("per-session language is pinned");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--resume with a MATCHING --lang does not warn", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "herta-main-pin-"));
    try {
      writeEnSession(tmp, "eeee1111");
      process.env.DEEPSEEK_API_KEY = "";
      const out = new MockWritable();
      const err = new MockWritable();
      const code = await main(["--resume", "eeee", "--lang", "en"], {
        stdout: out,
        stderr: err,
        stdin: process.stdin,
        cwd: tmp,
        homedir: join(tmp, "home"),
      });
      expect(code).toBe(2); // key lookup still fails; that's all
      expect(err.full()).not.toContain("pinned");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The one test here that boots the WHOLE CLI (the other ten return at
  // --help / a flag error / the key lookup): backend stack, actor stack —
  // which materializes the eleven EN seed 废案 into the temp workspace and
  // reads them back for the static prefix — the JSONL header, then readline
  // to EOF. All real disk I/O plus first-touch tool setup: ~¼ s alone in a
  // vitest worker, 9× that under a contended full suite here, and past the
  // 5 s default in three of three full-suite runs on 2026-09-08/09 (each
  // passing alone). No timer, delay or child process is on the path, so
  // fake timers cannot make it deterministic; the budget is what the test
  // assumed. Bounded rather than open: a REPL that stops exiting on EOF
  // must still fail, not hang the suite.
  it("a new session persists its birth language into the JSONL header", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "herta-main-hdr-"));
    try {
      process.env.DEEPSEEK_API_KEY = "test-key-not-used-offline";
      const stdin = new MockReadable();
      stdin.end(); // immediate EOF → the REPL exits before any turn runs
      const out = new MockWritable();
      const err = new MockWritable();
      const code = await main(["--lang", "en"], {
        stdout: out,
        stderr: err,
        stdin: stdin as unknown as NodeJS.ReadStream,
        cwd: tmp,
        homedir: join(tmp, "home"),
      });
      expect(code).toBe(0);
      const tdir = join(tmp, ".herta", "transcript", "v2");
      const files = readdirSync(tdir).filter((f) => f.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
      const firstLine =
        readFileSync(join(tdir, files[0] ?? ""), "utf8").split("\n")[0] ?? "";
      expect(JSON.parse(firstLine).lang).toBe("en");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("main — --resume flag", () => {
  it("--help mentions --resume and latest", async () => {
    const out = new MockWritable();
    const err = new MockWritable();
    const code = await main(["--help"], {
      stdout: out,
      stderr: err,
      stdin: process.stdin,
    });
    expect(code).toBe(0);
    const text = out.full();
    expect(text).toContain("--resume");
    expect(text).toContain("latest");
  });

  it("--resume <unknown-id> exits 2 with stderr error", async () => {
    // An isolated (and real, see the key test above) cwd so we don't see any
    // real sessions.
    const tmp = mkdtempSync(join(tmpdir(), "herta-main-resume-"));
    try {
      const out = new MockWritable();
      const err = new MockWritable();
      const code = await main(["--resume", "does-not-exist-zzzzz"], {
        stdout: out,
        stderr: err,
        stdin: process.stdin,
        cwd: tmp,
        homedir: join(tmp, "home"),
      });
      expect(code).toBe(2);
      expect(err.full()).toContain("no session matching");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
