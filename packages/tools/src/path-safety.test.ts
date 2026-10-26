import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  globReachesHertaState,
  hertaStateWriteDenial,
  holdsWorkspace,
  mentionsHertaState,
  namesHertaState,
  resolveSafePath,
  workspaceSpelling,
} from "./path-safety.js";
import { mkTmpWorkspace, type TmpWorkspace } from "./testing/tmp-workspace.js";

describe("globReachesHertaState — a pattern bash would expand (review 2026-09-30)", () => {
  it("matches under bash's default rule: a leading dot must be spelled", () => {
    for (const p of [
      ".her?a/permissions.json",
      ".[h]erta",
      ".h*",
      ".*",
      ".HER?A",
      "stash/.her*/x",
      ".[!x]erta",
      ".[[:alpha:]]erta",
      ".herta*",
    ]) {
      expect(globReachesHertaState(p), p).toBe(true);
    }
    for (const p of [
      "*",
      "?herta",
      "[.]herta",
      "build/*",
      "*.json",
      ".herta?",
      ".hert",
      ".herta",
      "src/x.ts",
      ".her[",
    ]) {
      expect(globReachesHertaState(p), p).toBe(false);
    }
  });
});

async function canCreateFileSymlinks(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), "herta-symlink-probe-"));
  try {
    await writeFile(join(probe, "target.txt"), "x");
    await symlink(join(probe, "target.txt"), join(probe, "link.txt"));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

describe("hertaStateWriteDenial — the harness's own state is not command-writable (2026-09-30)", () => {
  it("denies a path through .herta, judged relative to the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "herta-state-guard-"));
    try {
      expect(
        hertaStateWriteDenial(root, join(root, ".herta", "permissions.json")),
      ).not.toBeNull();
      expect(hertaStateWriteDenial(root, join(root, ".herta"))).not.toBeNull();
      expect(
        hertaStateWriteDenial(root, join(root, "src", ".herta", "x")),
      ).not.toBeNull();
      expect(hertaStateWriteDenial(root, join(root, "src", "a.ts"))).toBeNull();
      expect(hertaStateWriteDenial(root, root)).toBeNull();
      // Outside the workspace is not this guard's: it asks as leaving it.
      expect(
        hertaStateWriteDenial(root, join(tmpdir(), ".herta", "x")),
      ).toBeNull();
      // A managed workspace lives UNDER a `.herta`: its own files stay
      // writable; only a `.herta` inside it is state.
      const managed = join(root, ".herta", "workspaces", "abc");
      await mkdir(managed, { recursive: true });
      expect(
        hertaStateWriteDenial(managed, join(managed, "out.txt")),
      ).toBeNull();
      expect(
        hertaStateWriteDenial(managed, join(managed, ".herta", "p.json")),
      ).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("follows a link planted outside .herta that points into it", async () => {
    const root = await mkdtemp(join(tmpdir(), "herta-state-link-"));
    try {
      await mkdir(join(root, ".herta"));
      await symlink(
        join(root, ".herta"),
        join(root, "lnk"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(
        hertaStateWriteDenial(root, join(root, "lnk", "permissions.json")),
      ).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("names .herta in shell text as a path component only", () => {
    for (const body of [
      "echo x > .herta/p.json",
      "cp a .HERTA/p.json",
      'cat > ".herta/x"',
      "cd .herta && ls",
      "del .herta\\p.json",
    ]) {
      expect(mentionsHertaState(body), body).toBe(true);
    }
    for (const body of ["echo hertaland", "cat my.herta.txt", "x.herta2/y"]) {
      expect(mentionsHertaState(body), body).toBe(false);
    }
  });

  it("a managed sandbox's own root names .herta without reaching its state (release review 2026-10-13)", () => {
    const home = "C:\\Users\\u";
    const ws = "C:\\Users\\u\\.herta\\workspaces\\abc";
    const names = (text: string) => namesHertaState(text, ws, home);
    for (const text of [
      "cd C:\\Users\\u\\.herta\\workspaces\\abc && npm test",
      "cd C:/Users/u/.herta/workspaces/abc && npm test",
      "cd /c/users/u/.herta/workspaces/abc && npm test",
      "node ~/.herta/workspaces/abc/x.js",
      'cat "$HOME/.herta/workspaces/abc/out.txt"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: bash's own ${HOME}
      "cat ${HOME}/.herta/workspaces/abc/out.txt",
    ]) {
      expect(names(text), text).toBe(false);
    }
    for (const text of [
      "cd /c/Users/u/.herta/workspaces/abc && cat x > .herta/p.json",
      "echo x > C:/Users/u/.herta/workspaces/abc/.herta/p.json",
      "echo x > ~/.herta/workspaces/other/.herta/p.json",
      'echo x > "$PWD/.herta/p.json"',
      // Another sandbox is not this workspace.
      "cd ~/.herta/workspaces/abcd && ls",
    ]) {
      expect(names(text), text).toBe(true);
    }
    // An ordinary project: nothing to take out.
    expect(namesHertaState("cd /e/repo && make", "E:\\repo", home)).toBe(false);
  });
});

describe("resolveSafePath", () => {
  beforeEach(async () => {
    ws = await mkTmpWorkspace({
      "src/foo.ts": "x",
      "src/.gitkeep": "",
      ".git/HEAD": "ref: refs/heads/main\n",
      ".env": "SECRET=1\n",
      ".env.example": "SECRET=\n",
      ".env.local": "SECRET=local\n",
      "keys/private.pem": "-----BEGIN RSA-----",
      "keys/access.key": "abc",
      "keys/cert.p12": "bin",
      "deepseek-api-key.txt": "sk-test",
      id_rsa: "key",
      "id_rsa.pub": "key.pub",
      id_ecdsa: "key",
      ".netrc": "machine x",
      ".npmrc": "//r/:_authToken=sk",
      ".pgpass": "host:5432:db:u:p",
      ".git-credentials": "https://u:p@github.com",
      "config/credentials": "aws creds",
      "credentials.ts": "export const x = 1;",
      ".ssh/config": "Host *",
      ".aws/credentials": "[default]",
      ".herta/keys/deepseek": "sk",
      ".herta/memory/project.jsonl": "{}",
      ".herta/logs/run.log": "log",
      ".herta/attachments/s1/report.md": "# report",
      ".herta/capsules/project.json": "{}",
      "ok.md": "ok",
    });
  });

  it("allows a path inside the workspace", async () => {
    const r = await resolveSafePath(ws.root, "src/foo.ts");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.relative).toBe("src/foo.ts");
      expect(r.resolved.startsWith(ws.root)).toBe(true);
    }
  });

  it("allows the workspace root itself", async () => {
    const r = await resolveSafePath(ws.root, ".");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relative).toBe("");
  });

  it("denies a path outside the workspace via parent traversal", async () => {
    const r = await resolveSafePath(ws.root, "../../etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_outside_workspace");
  });

  it("denies a symlink that escapes the workspace", async () => {
    const symlinkable = await canCreateFileSymlinks();
    if (!symlinkable) {
      // Windows without admin / Developer Mode cannot create file symlinks.
      // The realpath-based escape check is also exercised on Windows by the
      // parent-traversal test above; skip without failing.
      return;
    }
    const outside = `${ws.root}-sibling`;
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "leak");
    await symlink(join(outside, "secret.txt"), join(ws.root, "linked.txt"));
    const r = await resolveSafePath(ws.root, "linked.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_outside_workspace");
    await rm(outside, { recursive: true, force: true });
  });

  it("denies .git/ paths", async () => {
    const r = await resolveSafePath(ws.root, ".git/HEAD");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_denied");
  });

  it("denies .env", async () => {
    const r = await resolveSafePath(ws.root, ".env");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_denied");
  });

  it("denies .env.local but allows .env.example", async () => {
    const denied = await resolveSafePath(ws.root, ".env.local");
    const allowed = await resolveSafePath(ws.root, ".env.example");
    expect(denied.ok).toBe(false);
    expect(allowed.ok).toBe(true);
  });

  it("denies *.pem", async () => {
    const r = await resolveSafePath(ws.root, "keys/private.pem");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_denied");
  });

  it("denies *.key", async () => {
    const r = await resolveSafePath(ws.root, "keys/access.key");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_denied");
  });

  it("denies *-api-key.txt", async () => {
    const r = await resolveSafePath(ws.root, "deepseek-api-key.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_denied");
  });

  it("denies id_rsa and id_rsa.pub", async () => {
    const a = await resolveSafePath(ws.root, "id_rsa");
    const b = await resolveSafePath(ws.root, "id_rsa.pub");
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
  });

  it("denies .herta/keys/<anything>", async () => {
    const r = await resolveSafePath(ws.root, ".herta/keys/deepseek");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("path_denied");
  });

  it("denies the whole .herta tree (memory/logs/capsules), not just keys (audit T3.4)", async () => {
    for (const p of [
      ".herta",
      ".herta/memory/project.jsonl",
      ".herta/logs/run.log",
      ".herta/capsules/project.json",
    ]) {
      const r = await resolveSafePath(ws.root, p);
      expect(r.ok, `expected ${p} denied`).toBe(false);
      if (!r.ok) expect(r.code).toBe("path_denied");
    }
  });

  describe("harness-evidence read carve-out (ADR 0025 slice 2)", () => {
    const opts = { allowHarnessReadPaths: true };

    it("allows files beneath .herta/logs/ and .herta/tool-results/ with the flag", async () => {
      const a = await resolveSafePath(ws.root, ".herta/logs/run.log", opts);
      expect(a.ok).toBe(true);
      const b = await resolveSafePath(
        ws.root,
        ".herta/tool-results/task-1/call_01.json",
        opts,
      );
      expect(b.ok).toBe(true);
    });

    it("without the flag the same paths stay denied", async () => {
      const r = await resolveSafePath(ws.root, ".herta/logs/run.log");
      expect(r.ok).toBe(false);
    });

    it("the carve-out covers ONLY the two evidence subtrees, never the rest of .herta", async () => {
      for (const p of [
        ".herta",
        ".herta/logs", // the directory itself, not a file beneath it
        ".herta/keys/deepseek",
        ".herta/memory/project.jsonl",
        ".herta/capsules/project.json",
        ".herta/logs-evil/x.log", // prefix must match a whole segment
      ]) {
        const r = await resolveSafePath(ws.root, p, opts);
        expect(r.ok, `expected ${p} denied`).toBe(false);
      }
    });

    it("credential basenames stay denied even inside the carve-out", async () => {
      const r = await resolveSafePath(ws.root, ".herta/logs/id_rsa", opts);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("path_denied");
    });

    it("a symlink inside logs pointing at .herta/keys is judged on its target", async () => {
      const linkPath = join(ws.root, ".herta", "logs", "sneaky.log");
      try {
        await symlink(join(ws.root, ".herta", "keys", "deepseek"), linkPath);
      } catch {
        return; // symlink creation unavailable (Windows non-admin) — skip
      }
      const r = await resolveSafePath(ws.root, ".herta/logs/sneaky.log", opts);
      expect(r.ok).toBe(false);
    });
  });

  describe("attachment read carve-out (ADR 0033)", () => {
    const opts = { allowAttachmentPaths: true };

    it("allows a file beneath .herta/attachments/ with the flag", async () => {
      const r = await resolveSafePath(
        ws.root,
        ".herta/attachments/s1/report.md",
        opts,
      );
      expect(r.ok).toBe(true);
    });

    it("without the flag the same path stays denied", async () => {
      const r = await resolveSafePath(
        ws.root,
        ".herta/attachments/s1/report.md",
      );
      expect(r.ok).toBe(false);
    });

    // The two carve-outs are separate flags precisely so that neither implies
    // the other; if they ever collapse into one, these two fail.
    // search_text carries the flag too (2026-08-10): the ADR justified STORING
    // oversized/binary attachments on the grounds that they stay searchable,
    // and the backend's citation line says so to 板砖 — a promise the ordinary
    // guard silently broke.
    it("search_text's per-file gate reaches an attachment with the flag", async () => {
      const r = await resolveSafePath(
        ws.root,
        ".herta/attachments/s1/report.md",
        { allowAttachmentPaths: true },
      );
      expect(r.ok).toBe(true);
    });

    it("the attachment flag does NOT open the harness-evidence subtrees", async () => {
      for (const p of [".herta/logs/run.log", ".herta/tool-results/t/c.json"]) {
        const r = await resolveSafePath(ws.root, p, opts);
        expect(r.ok, `expected ${p} denied`).toBe(false);
      }
    });

    it("the harness-evidence flag does NOT open attachments", async () => {
      const r = await resolveSafePath(
        ws.root,
        ".herta/attachments/s1/report.md",
        { allowHarnessReadPaths: true },
      );
      expect(r.ok).toBe(false);
    });

    it("covers only files strictly beneath the prefix", async () => {
      for (const p of [
        ".herta/attachments", // the directory itself
        ".herta/attachments-evil/x.md", // prefix must match a whole segment
      ]) {
        const r = await resolveSafePath(ws.root, p, opts);
        expect(r.ok, `expected ${p} denied`).toBe(false);
      }
    });

    // A user can attach a file with any name at all, so the credential guard
    // matters MORE here than in the harness carve-out, not less.
    it("credential basenames stay denied even inside the carve-out", async () => {
      const r = await resolveSafePath(
        ws.root,
        ".herta/attachments/s1/id_rsa",
        opts,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("path_denied");
    });

    it("a symlink inside attachments pointing at .herta/keys is judged on its target", async () => {
      const linkPath = join(ws.root, ".herta", "attachments", "s1", "s.md");
      try {
        await symlink(join(ws.root, ".herta", "keys", "deepseek"), linkPath);
      } catch {
        return; // symlink creation unavailable (Windows non-admin) — skip
      }
      const r = await resolveSafePath(
        ws.root,
        ".herta/attachments/s1/s.md",
        opts,
      );
      expect(r.ok).toBe(false);
    });
  });

  it("denies the unified credential basenames (audit T3.4)", async () => {
    for (const p of [
      ".netrc",
      ".npmrc",
      ".pgpass",
      ".git-credentials",
      "config/credentials",
      "id_ecdsa",
      "keys/cert.p12",
    ]) {
      const r = await resolveSafePath(ws.root, p);
      expect(r.ok, `expected ${p} denied`).toBe(false);
      if (!r.ok) expect(r.code).toBe("path_denied");
    }
  });

  it("denies sensitive .ssh/.aws directory segments (audit T3.4)", async () => {
    for (const p of [".ssh/config", ".aws/credentials"]) {
      const r = await resolveSafePath(ws.root, p);
      expect(r.ok, `expected ${p} denied`).toBe(false);
      if (!r.ok) expect(r.code).toBe("path_denied");
    }
  });

  it("still allows ordinary files whose names merely contain credential words", async () => {
    const r = await resolveSafePath(ws.root, "credentials.ts");
    expect(r.ok).toBe(true);
  });

  it("falls back to lexical resolve when target does not exist (ENOENT)", async () => {
    const r = await resolveSafePath(ws.root, "src/missing.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relative).toBe("src/missing.ts");
  });

  it("allows a deeply nonexistent path under an existing ancestor", async () => {
    // Exercises realpathViaExistingAncestor walking up more than one
    // level ("new/" doesn't exist either) and re-joining the suffix.
    const r = await resolveSafePath(ws.root, "src/new/deep/file.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relative).toBe("src/new/deep/file.ts");
  });

  it("denies a NONEXISTENT target under a directory link that escapes the workspace", async () => {
    // The write_new_file hole: the target never exists, so plain
    // realpath() throws ENOENT — the old fallback kept the UNRESOLVED
    // candidate, the prefix check passed, and the write landed outside
    // the repo through the in-workspace directory link. The ancestor
    // walk must canonicalize the link and fail the prefix check.
    const outside = `${ws.root}-sneak`;
    await mkdir(outside, { recursive: true });
    try {
      try {
        // "junction" works without admin on Windows; the type argument
        // is ignored on POSIX (plain directory symlink).
        await symlink(outside, join(ws.root, "escape"), "junction");
      } catch {
        return; // environment cannot create directory links; skip
      }
      const r = await resolveSafePath(ws.root, "escape/new-file.ts");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("path_outside_workspace");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("normalizes the relative path to forward slashes", async () => {
    const r = await resolveSafePath(ws.root, "src/foo.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.relative.includes("\\")).toBe(false);
  });

  it.skipIf(process.platform !== "win32")(
    "denies Win32 name-equivalent credential/tree targets (trailing dot/space, ::$DATA) — write bypass (audit T3.4 review)",
    async () => {
      // Win32 CreateFile trims trailing dots/spaces and resolves ::$DATA, so
      // these NONEXISTENT write targets land on the denied name — the denylist
      // must compare against the canonical form.
      for (const p of [".env ", "id_rsa.", ".env::$DATA", ".herta \\x.json"]) {
        const r = await resolveSafePath(ws.root, p);
        expect(r.ok, `expected ${JSON.stringify(p)} denied`).toBe(false);
        if (!r.ok) expect(r.code).toBe("path_denied");
      }
    },
  );
});

/** Run `fn` as if on `platform` (path-safety reads process.platform per call). */
async function onPlatform<T>(
  platform: NodeJS.Platform,
  fn: () => Promise<T>,
): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  try {
    return await fn();
  } finally {
    if (real !== undefined) Object.defineProperty(process, "platform", real);
  }
}

describe("resolveSafePath — POSIX tool credentials (platform review 2026-09-23)", () => {
  beforeEach(async () => {
    ws = await mkTmpWorkspace({ "src/a.ts": "x" });
  });

  it("denies the credential FILE of a home layout, wherever the workspace holds one", async () => {
    for (const p of [
      ".docker/config.json",
      ".kube/config",
      ".config/gh/hosts.yml",
      ".config/gcloud/credentials.db",
      ".local/share/keyrings/login.keyring",
      "Library/Keychains/login.keychain-db",
      ".pypirc",
      ".dockercfg",
    ]) {
      const r = await resolveSafePath(ws.root, p);
      expect(r.ok, `expected ${p} denied`).toBe(false);
      if (!r.ok) expect(r.code).toBe("path_denied");
    }
  });

  it("leaves the look-alikes that are ordinary repo content alone", async () => {
    for (const p of [
      ".docker/Dockerfile",
      ".kube/deploy.yaml",
      "debian/usr/share/keyrings/archive.gpg", // a package's PUBLIC keys
      "config/gh.ts",
      // Review 2026-09-23: the tool's settings, not its secret, and code
      // that merely shares the keychain folder's name.
      "dotfiles/.config/gh/config.yml",
      "dotfiles/.config/gcloud/configurations/config_default",
      "Sources/Library/Keychains/KeychainStore.swift",
    ]) {
      const r = await resolveSafePath(ws.root, p);
      expect(r.ok, `expected ${p} allowed`).toBe(true);
    }
  });
});

describe("resolveSafePath — macOS folds case like the filesystem (platform review 2026-09-23)", () => {
  it("a new `.GIT` directory is a `.git` on macOS, and an unrelated name on Linux", async () => {
    ws = await mkTmpWorkspace({ "sub/.keep": "" });
    const target = "sub/.GIT/hooks/pre-commit";
    const mac = await onPlatform("darwin", () =>
      resolveSafePath(ws.root, target, { mutation: true }),
    );
    expect(mac.ok).toBe(false);
    if (!mac.ok) expect(mac.code).toBe("path_denied");
    const linux = await onPlatform("linux", () =>
      resolveSafePath(ws.root, target, { mutation: true }),
    );
    expect(linux.ok).toBe(true);
  });

  it("a `Head` file completes the bare-repo shape on macOS", async () => {
    ws = await mkTmpWorkspace({ "objects/.keep": "", "refs/.keep": "" });
    const mac = await onPlatform("darwin", () =>
      resolveSafePath(ws.root, "Head", { mutation: true }),
    );
    expect(mac.ok).toBe(false);
    if (!mac.ok) expect(mac.message).toContain("bare-repository");
  });
});

describe("resolveSafePath — bare-repo shape guard (ADR 0049 §6)", () => {
  // The vector: git treats any directory holding HEAD + objects/ + refs/ as
  // a BARE REPO and runs hooks from it. No segment is `.git`, so the
  // per-segment tree denial never fires — these writes all passed the jail
  // before the guard existed (fails-pre-fix).
  it("denies the write that completes the triple — from either side", async () => {
    ws = await mkTmpWorkspace({
      "objects/.keep": "",
      "refs/.keep": "",
    });
    // objects/ and refs/ exist; writing HEAD is the final piece.
    const head = await resolveSafePath(ws.root, "HEAD", { mutation: true });
    expect(head.ok).toBe(false);
    if (!head.ok) expect(head.code).toBe("path_denied");

    // And from the other side: HEAD + refs/ exist, writing into objects/.
    const ws2 = await mkTmpWorkspace({
      HEAD: "ref: refs/heads/main\n",
      "refs/.keep": "",
    });
    try {
      const obj = await resolveSafePath(ws2.root, "objects/aa/bb", {
        mutation: true,
      });
      expect(obj.ok).toBe(false);
    } finally {
      await ws2.cleanup();
    }
  });

  it("denies hooks writes into an already-shaped directory, root or subdir", async () => {
    ws = await mkTmpWorkspace({
      "bare.git/HEAD": "ref: refs/heads/main\n",
      "bare.git/objects/.keep": "",
      "bare.git/refs/.keep": "",
    });
    const r = await resolveSafePath(ws.root, "bare.git/hooks/pre-commit", {
      mutation: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("hooks");
  });

  it("an incomplete shape stays writable — no name blocklist", async () => {
    // Honest projects have objects/ or hooks/ directories; only the
    // completed triple is dangerous.
    ws = await mkTmpWorkspace({ "objects/.keep": "" });
    expect(
      (await resolveSafePath(ws.root, "HEAD", { mutation: true })).ok,
    ).toBe(true); // no refs/ — not the final piece
    expect(
      (await resolveSafePath(ws.root, "objects/model.obj", { mutation: true }))
        .ok,
    ).toBe(true); // no HEAD file
    expect(
      (await resolveSafePath(ws.root, "hooks/deploy.ts", { mutation: true }))
        .ok,
    ).toBe(true); // root is not shaped
  });

  it("reads are untouched — the guard is mutation-only", async () => {
    ws = await mkTmpWorkspace({
      HEAD: "data\n",
      "objects/.keep": "",
      "refs/.keep": "",
    });
    expect((await resolveSafePath(ws.root, "HEAD")).ok).toBe(true);
  });
});

describe("workspaceSpelling / holdsWorkspace — the same place, however it is spelled (Mac findings 2026-10-24, item 3)", () => {
  it("a link from outside into the workspace lands inside, spelled from the root", async () => {
    const base = await mkdtemp(join(tmpdir(), "herta-spelling-"));
    const ws = join(base, "ws");
    const alias = join(base, "alias");
    try {
      await mkdir(join(ws, ".herta"), { recursive: true });
      await symlink(
        ws,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(workspaceSpelling(ws, join(alias, ".herta", "p.json"))).toBe(
        join(ws, ".herta", "p.json"),
      );
      // A name not yet created is re-joined under its existing ancestor.
      expect(workspaceSpelling(ws, join(alias, "new", "f.txt"))).toBe(
        join(ws, "new", "f.txt"),
      );
      expect(workspaceSpelling(ws, alias)).toBe(ws);
      expect(workspaceSpelling(ws, join(base, "elsewhere.txt"))).toBeNull();
      // The root and what holds it; not what it holds.
      expect(holdsWorkspace(alias, ws)).toBe(true);
      expect(holdsWorkspace(base, ws)).toBe(true);
      expect(holdsWorkspace(join(alias, "src"), ws)).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("a link from inside to outside keeps the answer its spelling gives", async () => {
    const base = await mkdtemp(join(tmpdir(), "herta-spelling-"));
    const ws = join(base, "ws");
    const outside = join(base, "outside");
    try {
      await mkdir(ws, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(
        outside,
        join(ws, "out"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(workspaceSpelling(ws, join(ws, "out", "x"))).toBe(
        join(ws, "out", "x"),
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin")(
    "another case of the root is the root, and its .herta is refused",
    async () => {
      const { existsSync } = await import("node:fs");
      const base = await mkdtemp(join(tmpdir(), "herta-spelling-"));
      const ws = join(base, "verify", "ws");
      const upper = join(base, "VERIFY", "WS");
      try {
        await mkdir(join(ws, ".herta"), { recursive: true });
        if (!existsSync(upper)) return; // a case-sensitive volume
        const target = join(upper, ".herta", "permissions.json");
        expect(hertaStateWriteDenial(ws, target)).not.toBeNull();
        expect(workspaceSpelling(ws, target)).toBe(
          join(ws, ".herta", "permissions.json"),
        );
        expect(holdsWorkspace(upper, ws)).toBe(true);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    },
  );
});
