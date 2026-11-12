import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  legacyChoicesImported,
  WorkspacePermissions,
} from "../workspace-permissions.js";
import { importLegacyReviewChoices } from "./import-review-choices.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function mkDir(): string {
  const d = mkdtempSync(join(tmpdir(), "herta-review-import-"));
  roots.push(d);
  return d;
}
/** A workspace holding the old per-workspace file. */
function legacyWorkspace(autoReview: boolean): string {
  const root = mkDir();
  mkdirSync(join(root, ".herta"), { recursive: true });
  writeFileSync(
    join(root, ".herta", "permissions.json"),
    JSON.stringify({ version: 1, autoReview }),
  );
  return root;
}
/** A session record as the persister writes its meta lines. */
function sessionFile(
  transcriptDir: string,
  id: string,
  meta: { workspaceRoot: string; backendWorkspace?: string },
  movedTo: readonly string[] = [],
): void {
  mkdirSync(transcriptDir, { recursive: true });
  const lines = [
    JSON.stringify({ _kind: "session_meta", sessionId: id, ...meta }),
    JSON.stringify({ kind: "user", text: "hello" }),
    ...movedTo.map((path) => JSON.stringify({ _kind: "workspace_set", path })),
  ];
  writeFileSync(join(transcriptDir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}
const choice = (file: string, root: string): boolean | null =>
  new WorkspacePermissions(() => root, file).autoReview();

describe("importLegacyReviewChoices — the old per-workspace files, carried over once (ADR 0064 amendment 2026-11-12)", () => {
  it("looks in the workspaces the surface's own session records name: the start, the backend's, every move", async () => {
    const transcriptDir = join(mkDir(), "transcript");
    const file = join(mkDir(), ".herta", "review-choices.json");
    const started = legacyWorkspace(true);
    const backend = legacyWorkspace(false);
    const moved = legacyWorkspace(true);
    const plain = mkDir();
    sessionFile(transcriptDir, "a", {
      workspaceRoot: started,
      backendWorkspace: backend,
    });
    sessionFile(transcriptDir, "b", { workspaceRoot: plain }, [moved]);
    // Not a record: ignored.
    writeFileSync(join(transcriptDir, "notes.txt"), "x");

    expect(
      await importLegacyReviewChoices({
        file,
        surface: "app-server",
        transcriptDir,
      }),
    ).toBe(3);
    expect(choice(file, started)).toBe(true);
    expect(choice(file, backend)).toBe(false);
    expect(choice(file, moved)).toBe(true);
    expect(choice(file, plain)).toBeNull();
  });

  it("never looks in a folder no record names, and never a second time", async () => {
    const transcriptDir = join(mkDir(), "transcript");
    const file = join(mkDir(), ".herta", "review-choices.json");
    const known = legacyWorkspace(true);
    // It holds the same file, and no record of this installation names it.
    const cloned = legacyWorkspace(true);
    sessionFile(transcriptDir, "a", { workspaceRoot: known });
    await importLegacyReviewChoices({
      file,
      surface: "app-server",
      transcriptDir,
    });
    expect(choice(file, known)).toBe(true);
    expect(choice(file, cloned)).toBeNull();

    // A session is opened in the cloned folder afterwards: its record now
    // names it, and the one time has passed.
    sessionFile(transcriptDir, "b", { workspaceRoot: cloned });
    expect(
      await importLegacyReviewChoices({
        file,
        surface: "app-server",
        transcriptDir,
      }),
    ).toBe(0);
    expect(choice(file, cloned)).toBeNull();
  });

  it("no records yet is an answer: nothing is carried over and the surface is marked", async () => {
    const file = join(mkDir(), ".herta", "review-choices.json");
    expect(
      await importLegacyReviewChoices({
        file,
        surface: "cli",
        transcriptDir: join(mkDir(), "no-such-dir"),
      }),
    ).toBe(0);
    expect(legacyChoicesImported(file, "cli")).toBe(true);
    expect(legacyChoicesImported(file, "app-server")).toBe(false);
  });

  it("an unreadable record is skipped, and never thrown on", async () => {
    const transcriptDir = join(mkDir(), "transcript");
    const file = join(mkDir(), ".herta", "review-choices.json");
    const known = legacyWorkspace(true);
    sessionFile(transcriptDir, "a", { workspaceRoot: known });
    writeFileSync(join(transcriptDir, "torn.jsonl"), '{"_kind":"session_me');
    mkdirSync(join(transcriptDir, "dir.jsonl"));
    expect(
      await importLegacyReviewChoices({
        file,
        surface: "app-server",
        transcriptDir,
      }),
    ).toBe(1);
    expect(choice(file, known)).toBe(true);
  });
});
