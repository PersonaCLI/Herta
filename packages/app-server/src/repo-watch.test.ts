import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { watchGitDir } from "./repo-watch.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function mkDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean): Promise<boolean> => {
  for (let i = 0; i < 400 && !ok(); i += 1) await sleep(5);
  return ok();
};

describe("watchGitDir (ADR 0058 amendment — the git dir, never the worktree)", () => {
  it("fires for HEAD and for a ref under refs/, not for a worktree file, and stops on close", async () => {
    const root = mkDir("watch-");
    const gitDir = join(root, ".git");
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    let fired = 0;
    const stop = watchGitDir(gitDir, () => {
      fired += 1;
    });
    // One write delivers SEVERAL events (the directory, the file, the
    // recursive watcher's own view), and under suite load they trail in
    // over hundreds of milliseconds — so every negative check below first
    // waits for the count to hold still. Timing here is the OS's, not the
    // watcher's; the watcher has no handle on the worktree by construction.
    const settled = async (): Promise<number> => {
      for (;;) {
        const seen = fired;
        await sleep(250);
        if (fired === seen) return seen;
      }
    };
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/side\n");
    expect(await until(() => fired >= 1)).toBe(true);
    const before = await settled();
    writeFileSync(join(gitDir, "refs", "heads", "main"), "abc\n");
    expect(await until(() => fired > before)).toBe(true);

    // The worktree is not watched: an edit there is the focus refresh's job.
    const quiet = await settled();
    writeFileSync(join(root, "a.ts"), "edit\n");
    await sleep(250);
    expect(fired).toBe(quiet);

    stop();
    const stopped = await settled();
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    await sleep(250);
    expect(fired).toBe(stopped);
  });

  it("the git dir vanishing closes every handle and reports `gone` once — no storm (2026-09-10)", async () => {
    const root = mkDir("watch-gone-");
    const gitDir = join(root, ".git");
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    let plain = 0;
    let gone = 0;
    const stop = watchGitDir(gitDir, (g) => {
      if (g === true) gone += 1;
      else plain += 1;
    });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/side\n");
    expect(await until(() => plain >= 1)).toBe(true);
    // `rm -rf .git` from beside the app.
    rmSync(gitDir, { recursive: true, force: true });
    expect(await until(() => gone >= 1)).toBe(true);
    // Whatever the platform emitted while the dir went, the callbacks end
    // with the handles: no runaway count, and nothing more afterwards.
    const settledPlain = plain;
    await sleep(300);
    expect(gone).toBe(1);
    expect(plain).toBe(settledPlain);
    expect(plain).toBeLessThan(200);
    expect(() => stop()).not.toThrow();
  });

  it("follows a linked worktree's commondir pointer for refs, and survives an unwatchable dir", () => {
    const root = mkDir("watch-wt-");
    const common = join(root, ".git");
    mkdirSync(join(common, "refs"), { recursive: true });
    const linked = join(common, "worktrees", "wt");
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, "commondir"), "../..\n");
    const stop = watchGitDir(linked, () => undefined);
    expect(typeof stop).toBe("function");
    stop();
    // A dir that does not exist: no throw, a no-op stop.
    const gone = watchGitDir(join(root, "nope", ".git"), () => undefined);
    expect(() => gone()).not.toThrow();
  });
});
