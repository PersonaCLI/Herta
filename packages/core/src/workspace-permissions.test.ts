import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  importLegacyChoices,
  legacyChoicesImported,
  readLegacyChoice,
  WorkspacePermissions,
  workspaceKey,
} from "./workspace-permissions.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "herta-permissions-"));
  roots.push(root);
  return root;
}
/** A place for the choices file, outside every workspace of the test. */
function mkStoreFile(): string {
  return join(mkRoot(), ".herta", "review-choices.json");
}
/** A workspace that arrives with the OLD per-workspace file in it. */
function withLegacyFile(body: object | string): string {
  const root = mkRoot();
  mkdirSync(join(root, ".herta"), { recursive: true });
  writeFileSync(
    join(root, ".herta", "permissions.json"),
    typeof body === "string" ? body : JSON.stringify({ version: 1, ...body }),
  );
  return root;
}
const read = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8"));

describe("WorkspacePermissions — the automatic-review choice (ADR 0075)", () => {
  it("starts unset, persists either choice in the one file, and clears back to null", () => {
    const root = mkRoot();
    const file = mkStoreFile();
    const store = new WorkspacePermissions(() => root, file);
    expect(store.autoReview()).toBeNull();
    store.setAutoReview(true);
    expect(new WorkspacePermissions(() => root, file).autoReview()).toBe(true);
    store.setAutoReview(false);
    expect(store.autoReview()).toBe(false);
    expect(read(file)).toEqual({
      version: 1,
      workspaces: { [workspaceKey(root)]: { autoReview: false } },
    });
    store.setAutoReview(null);
    expect(store.autoReview()).toBeNull();
    expect(read(file)).toEqual({ version: 1, workspaces: {} });
  });

  it("writes nothing into the workspace", () => {
    const root = mkRoot();
    const store = new WorkspacePermissions(() => root, mkStoreFile());
    store.setAutoReview(true);
    expect(existsSync(join(root, ".herta"))).toBe(false);
  });

  it("follows the workspace it is asked about, and keeps every workspace's choice in the one file", () => {
    const a = mkRoot();
    const b = mkRoot();
    const file = mkStoreFile();
    let current = a;
    const store = new WorkspacePermissions(() => current, file);
    store.setAutoReview(true);
    current = b;
    expect(store.autoReview()).toBeNull();
    store.setAutoReview(false);
    current = a;
    expect(store.autoReview()).toBe(true);
    // Another object on the same file — another process — sees both, and its
    // write keeps the workspace it did not touch.
    const other = new WorkspacePermissions(() => b, file);
    expect(other.autoReview()).toBe(false);
    other.setAutoReview(null);
    expect(store.autoReview()).toBe(true);
  });

  // The hole the move closed (ADR 0064 amendment 2026-11-12): the file was
  // read as found, so a folder that arrived with one had automatic review on.
  it("a folder that arrives with the old file in it has NO choice: the file is not read", () => {
    const cloned = withLegacyFile({ autoReview: true });
    expect(
      new WorkspacePermissions(() => cloned, mkStoreFile()).autoReview(),
    ).toBeNull();
    expect(new WorkspacePermissions(() => cloned).autoReview()).toBeNull();
    const trusted = withLegacyFile({ trust: "workspace" });
    expect(
      new WorkspacePermissions(() => trusted, mkStoreFile()).autoReview(),
    ).toBeNull();
  });

  it("two spellings of one folder are one workspace", () => {
    const root = mkRoot();
    const file = mkStoreFile();
    new WorkspacePermissions(() => root, file).setAutoReview(true);
    const respelled = join(root, "sub", "..");
    expect(new WorkspacePermissions(() => respelled, file).autoReview()).toBe(
      true,
    );
    if (process.platform === "win32") {
      expect(
        new WorkspacePermissions(() => root.toUpperCase(), file).autoReview(),
      ).toBe(true);
    }
  });

  it("only a boolean is a choice; a malformed or foreign file is none, and is never thrown on", () => {
    const root = mkRoot();
    const key = workspaceKey(root);
    const at = (text: string): boolean | null => {
      const file = mkStoreFile();
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, text);
      return new WorkspacePermissions(() => root, file).autoReview();
    };
    expect(
      at(
        JSON.stringify({
          version: 1,
          workspaces: { [key]: { autoReview: "yes" } },
        }),
      ),
    ).toBeNull();
    expect(at("{not json")).toBeNull();
    expect(at("null")).toBeNull();
    expect(
      at(
        JSON.stringify({
          version: 2,
          workspaces: { [key]: { autoReview: true } },
        }),
      ),
    ).toBeNull();
    expect(at(JSON.stringify({ version: 1, workspaces: [] }))).toBeNull();
    expect(
      at(
        JSON.stringify({
          version: 1,
          workspaces: { [key]: { autoReview: true } },
        }),
      ),
    ).toBe(true);
  });

  it("with no file it holds the choice in memory, for this object only", () => {
    const root = mkRoot();
    const store = new WorkspacePermissions(() => root);
    expect(store.autoReview()).toBeNull();
    store.setAutoReview(true);
    expect(store.autoReview()).toBe(true);
    expect(new WorkspacePermissions(() => root).autoReview()).toBeNull();
    store.setAutoReview(null);
    expect(store.autoReview()).toBeNull();
    expect(existsSync(join(root, ".herta"))).toBe(false);
  });
});

describe("the old per-workspace file, read once (ADR 0064 amendment 2026-11-12)", () => {
  it("readLegacyChoice: a boolean, or the trust it replaced; nothing else", () => {
    expect(readLegacyChoice(withLegacyFile({ autoReview: true }))).toBe(true);
    expect(readLegacyChoice(withLegacyFile({ autoReview: false }))).toBe(false);
    expect(readLegacyChoice(withLegacyFile({ trust: "workspace" }))).toBe(true);
    expect(readLegacyChoice(withLegacyFile({ trust: "ask" }))).toBe(false);
    // A choice made since the trust it replaced wins.
    expect(
      readLegacyChoice(
        withLegacyFile({ trust: "workspace", autoReview: false }),
      ),
    ).toBe(false);
    expect(readLegacyChoice(withLegacyFile({ trust: "always" }))).toBeNull();
    expect(readLegacyChoice(withLegacyFile({ autoReview: "yes" }))).toBeNull();
    expect(readLegacyChoice(withLegacyFile("{not json"))).toBeNull();
    expect(readLegacyChoice(withLegacyFile("null"))).toBeNull();
    expect(readLegacyChoice(mkRoot())).toBeNull();
    // Remembered commands from before 2026-10-10 ride along and are ignored.
    expect(
      readLegacyChoice(
        withLegacyFile({
          commandAllow: [{ argvPrefix: ["npm", "run"], anyArgs: true }],
          trust: "workspace",
        }),
      ),
    ).toBe(true);
  });

  it("carries the named workspaces' choices over, once per surface", () => {
    const file = mkStoreFile();
    const on = withLegacyFile({ autoReview: true });
    const off = withLegacyFile({ trust: "ask" });
    const none = mkRoot();
    expect(legacyChoicesImported(file, "desktop")).toBe(false);
    expect(
      importLegacyChoices({
        file,
        surface: "desktop",
        workspaces: [on, off, none],
      }),
    ).toBe(2);
    expect(new WorkspacePermissions(() => on, file).autoReview()).toBe(true);
    expect(new WorkspacePermissions(() => off, file).autoReview()).toBe(false);
    expect(new WorkspacePermissions(() => none, file).autoReview()).toBeNull();
    expect(legacyChoicesImported(file, "desktop")).toBe(true);

    // A folder that turns up afterwards is never imported, whatever it holds.
    const later = withLegacyFile({ autoReview: true });
    expect(
      importLegacyChoices({ file, surface: "desktop", workspaces: [later] }),
    ).toBe(0);
    expect(new WorkspacePermissions(() => later, file).autoReview()).toBeNull();

    // The other surface has its own one time, and its own mark.
    expect(legacyChoicesImported(file, "cli")).toBe(false);
    expect(
      importLegacyChoices({ file, surface: "cli", workspaces: [later] }),
    ).toBe(1);
    expect(new WorkspacePermissions(() => later, file).autoReview()).toBe(true);
    expect(read(file).imported).toEqual(["desktop", "cli"]);
  });

  it("a choice already made here is kept over the old file's, and an import of nothing still marks the surface", () => {
    const file = mkStoreFile();
    const root = withLegacyFile({ autoReview: true });
    new WorkspacePermissions(() => root, file).setAutoReview(false);
    expect(
      importLegacyChoices({ file, surface: "desktop", workspaces: [root] }),
    ).toBe(0);
    expect(new WorkspacePermissions(() => root, file).autoReview()).toBe(false);

    const empty = mkStoreFile();
    expect(
      importLegacyChoices({ file: empty, surface: "cli", workspaces: [] }),
    ).toBe(0);
    expect(legacyChoicesImported(empty, "cli")).toBe(true);
    // A later choice keeps the mark.
    new WorkspacePermissions(() => root, empty).setAutoReview(true);
    expect(legacyChoicesImported(empty, "cli")).toBe(true);
  });

  it("leaves the old file where it is", () => {
    const file = mkStoreFile();
    const root = withLegacyFile({ autoReview: true });
    importLegacyChoices({ file, surface: "desktop", workspaces: [root] });
    expect(existsSync(join(root, ".herta", "permissions.json"))).toBe(true);
  });
});
