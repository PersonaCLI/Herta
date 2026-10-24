import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSafePath } from "./path-safety.js";
import {
  canonicalWorkspaceRoot,
  isRefusedSystemDir,
  validateWorkspaceRoot,
} from "./validate-workspace-root.js";

describe("validateWorkspaceRoot", () => {
  let tmp: string;
  beforeEach(() => {
    // Canonical, as every root the validator hands back is (audit S8) —
    // macOS's os.tmpdir() is reached through `/var` → `/private/var`.
    tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "ws-val-")));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("accepts an existing directory outside protected roots", () => {
    // Home is a SIBLING here: a home inside the workspace is now refused.
    const r = validateWorkspaceRoot(tmp, {
      home: join(tmpdir(), "herta-ws-val-elsewhere-home"),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved).toBe(tmp);
  });
  it("rejects a directory that CONTAINS home — /home, /Users, C:\\Users (2026-09-23)", () => {
    const r = validateWorkspaceRoot(tmp, { home: join(tmp, "someone") });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("ws_forbidden_root");
      expect(r.message).toContain("contains the home directory");
    }
  });
  it("rejects a non-existent path", () => {
    const r = validateWorkspaceRoot(join(tmp, "nope"), { home: tmp });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ws_not_found");
  });
  it("rejects a drive/filesystem root", () => {
    const root = parse(tmp).root;
    const r = validateWorkspaceRoot(root, { home: tmp });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ws_forbidden_root");
  });
  it("rejects the home root itself", () => {
    const r = validateWorkspaceRoot(tmp, { home: tmp });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ws_forbidden_root");
  });
  it("rejects anything inside ~/.herta", () => {
    const herta = join(tmp, ".herta", "workspaces", "x");
    const r = validateWorkspaceRoot(herta, { home: tmp });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ws_forbidden_root");
  });
  it("rejects an OS system dir even when it doesn't exist (e.g. /etc)", () => {
    const r = validateWorkspaceRoot("/etc", { home: tmp });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ws_forbidden_root");
  });
  // Windows resolves these onto the drive (C:\etc), which is no system
  // directory there; the decision itself is pinned platform-free below.
  it.skipIf(process.platform === "win32")(
    "a `..` cannot walk out of a scratch exception into a system dir (2026-10-24)",
    () => {
      for (const p of ["/var/folders/../../etc", "/var/www/../../etc"]) {
        const r = validateWorkspaceRoot(p, { home: tmp });
        expect(r.ok, p).toBe(false);
        if (!r.ok) expect(r.code, p).toBe("ws_forbidden_root");
      }
    },
  );
  it.runIf(process.platform === "darwin")(
    "macOS: /tmp spelled as the OS hands it back (/private/tmp) is judged as /tmp is (2026-10-24)",
    () => {
      expect(validateWorkspaceRoot("/private/tmp", { home: tmp })).toEqual({
        ok: true,
        resolved: "/private/tmp",
      });
      for (const p of ["/private", "/private/etc", "/private/var/log"]) {
        const r = validateWorkspaceRoot(p, { home: tmp });
        expect(r.ok, p).toBe(false);
        if (!r.ok) expect(r.code, p).toBe("ws_forbidden_root");
      }
      const walked = validateWorkspaceRoot("/private/var/folders/../../etc", {
        home: tmp,
      });
      expect(walked.ok).toBe(false);
    },
  );
  it("rejects a System32 segment on any drive", () => {
    const r = validateWorkspaceRoot(join("D:\\", "x", "System32"), {
      home: tmp,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ws_forbidden_root");
  });
});

describe("isRefusedSystemDir — layouts a test machine cannot build (2026-09-23)", () => {
  it("Fedora's atomic desktops: a project under /home → /var/home is the user's, not the system's", () => {
    // Silverblue / Kinoite / Bazzite / Bluefin: canonicalization turns
    // `/home/u/proj` into `/var/home/u/proj`, which matched the `/var` entry —
    // and not one folder could be opened.
    expect(
      isRefusedSystemDir("/var/home/u/proj", "/home/u/proj", "/var/home/u"),
    ).toBe(false);
  });

  it("the rest of /var and the other system trees are still refused", () => {
    expect(
      isRefusedSystemDir("/var/lib/docker", "/var/lib/docker", "/home/u"),
    ).toBe(true);
    expect(isRefusedSystemDir("/etc/nginx", "/etc/nginx", "/home/u")).toBe(
      true,
    );
    expect(isRefusedSystemDir("/usr/lib", "/usr/lib", "/var/home/u")).toBe(
      true,
    );
  });

  it("/var/www holds web projects, like /var/folders holds macOS scratch", () => {
    expect(
      isRefusedSystemDir("/var/www/site", "/var/www/site", "/home/u"),
    ).toBe(false);
    expect(
      isRefusedSystemDir(
        "/var/folders/ab/T/x",
        "/var/folders/ab/T/x",
        "/Users/u",
      ),
    ).toBe(false);
  });

  it("a scratch spelling never exempts where the path lands (2026-10-24)", () => {
    // Typed through a scratch dir, landing in /etc: by `..`, or by a link.
    expect(isRefusedSystemDir("/etc", "/var/www/../../etc", "/home/u")).toBe(
      true,
    );
    expect(
      isRefusedSystemDir("/etc", "/var/folders/ab/T/sneaky", "/Users/u"),
    ).toBe(true);
    // A scratch spelling landing on a scratch or ordinary dir stays allowed.
    expect(
      isRefusedSystemDir("/srv/www/site", "/var/www/site", "/home/u"),
    ).toBe(false);
  });

  it("without a home, nothing is exempt", () => {
    expect(isRefusedSystemDir("/var/home/u/proj", "/var/home/u/proj", "")).toBe(
      true,
    );
  });
});

describe("a symlinked root is canonicalized (audit S8)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "ws-link-")));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  // Creating a directory symlink needs elevation or Developer Mode on Windows.
  const canSymlink = (): boolean => {
    const probe = join(tmp, `.probe-${Math.random().toString(36).slice(2)}`);
    try {
      mkdirSync(join(tmp, "probe-target"), { recursive: true });
      symlinkSync(join(tmp, "probe-target"), probe, "junction");
      rmSync(probe, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };

  it("resolves the root so paths inside it compare equal", () => {
    if (!canSymlink()) return;
    const real = join(tmp, "real-project");
    const link = join(tmp, "linked-project");
    mkdirSync(real);
    symlinkSync(real, link, "junction");

    const r = validateWorkspaceRoot(link, { home: join(tmp, "home") });
    expect(r.ok).toBe(true);
    // The whole point: resolveSafePath realpaths every candidate file, so a
    // root left as the symlink means `<link>/a.ts` canonicalizes to
    // `<real>/a.ts`, fails the prefix check, and EVERY file operation is
    // denied as outside the workspace.
    if (r.ok) expect(r.resolved).toBe(realpathSync(link));
    if (r.ok) expect(r.resolved).toBe(real);
  });

  it("the symptom: file operations under a symlinked root now resolve", async () => {
    if (!canSymlink()) return;
    const real = join(tmp, "real-project");
    const link = join(tmp, "linked-project");
    mkdirSync(real);
    writeFileSync(join(real, "a.ts"), "x", "utf8");
    symlinkSync(real, link, "junction");

    // What the raw symlinked root does — this is the bug, verbatim: every
    // candidate is canonicalized, so nothing can ever be "inside" a root that
    // is not. 100% of file operations denied.
    const viaLink = await resolveSafePath(link, "a.ts");
    expect(viaLink.ok).toBe(false);
    if (!viaLink.ok) expect(viaLink.code).toBe("path_outside_workspace");

    // What validateWorkspaceRoot now hands the runtime instead.
    const check = validateWorkspaceRoot(link, { home: join(tmp, "home") });
    expect(check.ok).toBe(true);
    if (check.ok) {
      const viaCanonical = await resolveSafePath(check.resolved, "a.ts");
      expect(viaCanonical.ok).toBe(true);
    }
  });

  it("still refuses a symlink that points into a system directory", () => {
    if (!canSymlink() || process.platform === "win32") return;
    const link = join(tmp, "sneaky");
    symlinkSync("/etc", link);
    const r = validateWorkspaceRoot(link, { home: join(tmp, "home") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ws_forbidden_root");
  });
});

// win32-only: `subst` maps a drive letter onto a directory — the shape of a
// user's F: workspace ("挂在F盘", user report 2026-08-24). The JS realpathSync
// walk cannot see through it (a mapping is not a reparse point), while the
// native realpath `resolveSafePath` uses resolves it — so a root left in the
// mapped spelling denies EVERY candidate, `run_command`'s own cwd "." first.
describe.skipIf(process.platform !== "win32")(
  "a subst-mapped drive root is canonicalized like the files inside it",
  () => {
    let tmp: string;
    let drive: string | null = null;
    beforeEach(() => {
      tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "ws-subst-")));
      mkdirSync(join(tmp, "ws"));
      writeFileSync(join(tmp, "ws", "a.ts"), "x", "utf8");
      // A free letter, scanned high to low; `subst` needs no elevation but a
      // policy may still refuse it — then the tests no-op (canSymlink pattern).
      drive = null;
      for (const letter of "ZYXWVUTSRQPONMLKJHG") {
        if (existsSync(`${letter}:\\`)) continue;
        const r = spawnSync("subst", [`${letter}:`, tmp], {
          windowsHide: true,
        });
        if (r.status === 0) {
          drive = `${letter}:`;
          break;
        }
      }
    });
    afterEach(() => {
      if (drive !== null) {
        spawnSync("subst", [drive, "/D"], { windowsHide: true });
        drive = null;
      }
      rmSync(tmp, { recursive: true, force: true });
    });

    it("resolves the mapping to the native spelling", () => {
      if (drive === null) return;
      expect(canonicalWorkspaceRoot(`${drive}\\ws`)).toBe(join(tmp, "ws"));
    });

    it("the symptom: file operations under a mapped root now resolve", async () => {
      if (drive === null) return;
      const mapped = `${drive}\\ws`;

      // The bug, verbatim: a root kept in the mapped spelling can contain
      // nothing — the candidate realpaths to the underlying path.
      const raw = await resolveSafePath(mapped, "a.ts");
      expect(raw.ok).toBe(false);
      if (!raw.ok) expect(raw.code).toBe("path_outside_workspace");

      const check = validateWorkspaceRoot(mapped, { home: join(tmp, "home") });
      expect(check.ok).toBe(true);
      if (check.ok) {
        expect(check.resolved).toBe(join(tmp, "ws"));
        // run_command resolves its cwd "." before anything else — this exact
        // call failing is what "板砖本地命令都调不出来" looked like.
        const cwd = await resolveSafePath(check.resolved, ".");
        expect(cwd.ok).toBe(true);
        const file = await resolveSafePath(check.resolved, "a.ts");
        expect(file.ok).toBe(true);
      }
    });
  },
);

describe("canonicalWorkspaceRoot", () => {
  it("falls back to the lexical resolve for a path that does not exist", () => {
    // The caller is about to reject it; a throw here would surface as an
    // opaque EIO instead of "no such directory".
    const missing = join(tmpdir(), "herta-does-not-exist-9f3a2b");
    expect(canonicalWorkspaceRoot(missing)).toBe(resolve(missing));
  });

  it("is idempotent", () => {
    const once = canonicalWorkspaceRoot(tmpdir());
    expect(canonicalWorkspaceRoot(once)).toBe(once);
  });
});
