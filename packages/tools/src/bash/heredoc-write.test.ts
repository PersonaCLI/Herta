import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { findHeredocWrites, previewHeredocWrites } from "./heredoc-write.js";
import { makeMsysPaths, type ShellPaths } from "./shell-paths.js";

const NATIVE: ShellPaths =
  process.platform === "win32" ? makeMsysPaths(null) : makeMsysPaths(null);

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});
const opts = (root: string) => ({ workspaceRoot: root, paths: NATIVE });

describe("findHeredocWrites (pure)", () => {
  it("the contract's file-write idiom: `mkdir -p d && cat > d/f <<'EOF' … EOF` → one literal write", () => {
    const cmd = [
      "mkdir -p src && cat > src/server.mjs <<'EOF'",
      "import http from 'node:http';",
      "",
      "const port = Number(process.env.PORT) || 4642;",
      "EOF",
    ].join("\n");
    const writes = findHeredocWrites(cmd, opts("/repo"));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.relative).toBe("src/server.mjs");
    expect(writes[0]?.mode).toBe("overwrite");
    expect(writes[0]?.body).toBe(
      "import http from 'node:http';\n\nconst port = Number(process.env.PORT) || 4642;\n",
    );
    expect(writes[0]?.bodyLines).toEqual({ start: 1, end: 4 });
  });

  it("append (`>>`), redirect before the heredoc word, `tee` / `tee -a`, and `<<-` tab stripping", () => {
    expect(
      findHeredocWrites("cat >> notes.md <<'X'\nline\nX", opts("/repo"))[0]
        ?.mode,
    ).toBe("append");
    expect(
      findHeredocWrites("cat <<'X' > out.txt\nline\nX", opts("/repo"))[0]
        ?.relative,
    ).toBe("out.txt");
    const tee = findHeredocWrites(
      "tee -a log.txt <<'X'\nline\nX",
      opts("/repo"),
    )[0];
    expect(tee?.relative).toBe("log.txt");
    expect(tee?.mode).toBe("append");
    expect(
      findHeredocWrites("tee cfg.ini <<'X'\nk=v\nX", opts("/repo"))[0]?.mode,
    ).toBe("overwrite");
    expect(
      findHeredocWrites("cat <<-'X' > a\n\t\tindented\n\tX", opts("/repo"))[0]
        ?.body,
    ).toBe("indented\n");
  });

  it("an UNQUOTED terminator previews only a body the shell would not expand", () => {
    // literal enough
    expect(
      findHeredocWrites("cat > a.txt <<EOF\nplain text\nEOF", opts("/repo")),
    ).toHaveLength(1);
    // $var / $(…) / backticks / backslashes → the shell rewrites the body
    expect(
      findHeredocWrites("cat > a.txt <<EOF\nhi $USER\nEOF", opts("/repo")),
    ).toHaveLength(0);
    expect(
      findHeredocWrites("cat > a.txt <<EOF\nnow: $(date)\nEOF", opts("/repo")),
    ).toHaveLength(0);
    // …but a quoted terminator keeps them literal
    expect(
      findHeredocWrites("cat > a.txt <<'EOF'\nhi $USER\nEOF", opts("/repo")),
    ).toHaveLength(1);
  });

  it("not a knowable file write: heredoc fed to a program, variable target, outside path, two redirects, unterminated", () => {
    expect(
      findHeredocWrites("python3 - <<'PY'\nprint(1)\nPY", opts("/repo")),
    ).toHaveLength(0);
    expect(
      findHeredocWrites("cat > $OUT <<'X'\nline\nX", opts("/repo")),
    ).toHaveLength(0);
    expect(
      findHeredocWrites("cat > /etc/motd <<'X'\nline\nX", opts("/repo")),
    ).toHaveLength(0);
    expect(
      findHeredocWrites("cat > a > b <<'X'\nline\nX", opts("/repo")),
    ).toHaveLength(0);
    expect(
      findHeredocWrites("cat > a.txt <<'X'\nline without end", opts("/repo")),
    ).toHaveLength(0);
    // A program that reads the heredoc and redirects its OWN output: the
    // file gets what the script prints, not the script (2026-10-08).
    expect(
      findHeredocWrites(
        "python3 - > out.txt <<'PY'\nprint(1)\nPY",
        opts("/repo"),
      ),
    ).toHaveLength(0);
    expect(
      findHeredocWrites("cat in.txt > out.txt <<'X'\nline\nX", opts("/repo")),
    ).toHaveLength(0);
  });

  it("two heredocs on one command are both found, in order, with the right spans", () => {
    const cmd = [
      "cat > a.txt <<'A'",
      "1",
      "A",
      "cat > b.txt <<'B'",
      "2",
      "3",
      "B",
    ].join("\n");
    const writes = findHeredocWrites(cmd, opts("/repo"));
    expect(writes.map((w) => w.relative)).toEqual(["a.txt", "b.txt"]);
    expect(writes.map((w) => w.bodyLines)).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 6 },
    ]);
  });
});

describe("previewHeredocWrites (against the disk)", () => {
  it("create: a /dev/null → file diff with every line added; overwrite and append diff against the current content", async () => {
    ws = await mkTmpWorkspace({ "notes.md": "one\ntwo\n" });
    const create = await previewHeredocWrites(
      "mkdir -p src && cat > src/x.mjs <<'EOF'\nexport const x = 1;\nEOF",
      opts(ws.root),
    );
    expect(create).not.toBeNull();
    expect(create?.files).toEqual(["src/x.mjs"]);
    expect(create?.diff).toContain("--- /dev/null");
    expect(create?.diff).toContain("+++ b/src/x.mjs");
    expect(create?.diff).toContain("+export const x = 1;");
    expect(create?.summary).toBe("creates src/x.mjs (1 lines)");
    expect(create?.added).toBe(1);

    const append = await previewHeredocWrites(
      "cat >> notes.md <<'EOF'\nthree\nEOF",
      opts(ws.root),
    );
    expect(append?.summary).toBe("appends to notes.md (+1 lines)");
    expect(append?.diff).toContain(" two");
    expect(append?.diff).toContain("+three");
    expect(append?.diff).not.toContain("-one");

    const overwrite = await previewHeredocWrites(
      "cat > notes.md <<'EOF'\nONE\nEOF",
      opts(ws.root),
    );
    expect(overwrite?.summary).toBe("overwrites notes.md (+1/-2 lines)");
    expect(overwrite?.diff).toContain("-one");
    expect(overwrite?.diff).toContain("-two");
    expect(overwrite?.diff).toContain("+ONE");
  });

  it("no preview for a binary target or when nothing is previewable", async () => {
    ws = await mkTmpWorkspace({});
    await writeFile(join(ws.root, "blob.bin"), Buffer.from([0, 1, 2, 0, 3]));
    expect(
      await previewHeredocWrites(
        "cat > blob.bin <<'EOF'\nx\nEOF",
        opts(ws.root),
      ),
    ).toBeNull();
    expect(
      await previewHeredocWrites("echo hi > a.txt", opts(ws.root)),
    ).toBeNull();
  });
});
