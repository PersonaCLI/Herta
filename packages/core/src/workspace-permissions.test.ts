import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspacePermissions } from "./workspace-permissions.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "herta-permissions-"));
  roots.push(root);
  return root;
}
function withFile(body: object): string {
  const root = mkRoot();
  mkdirSync(join(root, ".herta"), { recursive: true });
  writeFileSync(
    join(root, ".herta", "permissions.json"),
    JSON.stringify({ version: 1, ...body }),
  );
  return root;
}
const read = (root: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, ".herta", "permissions.json"), "utf8"));

describe("WorkspacePermissions — the automatic-review choice (ADR 0075)", () => {
  it("starts unset, persists either choice, and clears back to null", () => {
    const root = mkRoot();
    const store = new WorkspacePermissions(() => root);
    expect(store.autoReview()).toBeNull();
    store.setAutoReview(true);
    expect(new WorkspacePermissions(() => root).autoReview()).toBe(true);
    store.setAutoReview(false);
    expect(store.autoReview()).toBe(false);
    expect(read(root)).toEqual({ version: 1, autoReview: false });
    store.setAutoReview(null);
    expect(store.autoReview()).toBeNull();
    expect(read(root)).toEqual({ version: 1 });
  });

  it("follows the workspace it is asked about", () => {
    const a = mkRoot();
    const b = mkRoot();
    let current = a;
    const store = new WorkspacePermissions(() => current);
    store.setAutoReview(true);
    current = b;
    expect(store.autoReview()).toBeNull();
    current = a;
    expect(store.autoReview()).toBe(true);
  });

  it("only a boolean is a choice; a malformed or foreign file is none", () => {
    expect(
      new WorkspacePermissions(() =>
        withFile({ autoReview: "yes" }),
      ).autoReview(),
    ).toBeNull();
    const garbled = mkRoot();
    mkdirSync(join(garbled, ".herta"), { recursive: true });
    writeFileSync(join(garbled, ".herta", "permissions.json"), "{not json");
    expect(new WorkspacePermissions(() => garbled).autoReview()).toBeNull();
    const future = mkRoot();
    mkdirSync(join(future, ".herta"), { recursive: true });
    writeFileSync(
      join(future, ".herta", "permissions.json"),
      JSON.stringify({ version: 2, autoReview: true }),
    );
    expect(new WorkspacePermissions(() => future).autoReview()).toBeNull();
  });

  it("an earlier trust choice carries over, and a choice made since wins", () => {
    expect(
      new WorkspacePermissions(() =>
        withFile({ trust: "workspace" }),
      ).autoReview(),
    ).toBe(true);
    expect(
      new WorkspacePermissions(() => withFile({ trust: "ask" })).autoReview(),
    ).toBe(false);
    expect(
      new WorkspacePermissions(() =>
        withFile({ trust: "always" }),
      ).autoReview(),
    ).toBeNull();
    expect(
      new WorkspacePermissions(() =>
        withFile({ trust: "workspace", autoReview: false }),
      ).autoReview(),
    ).toBe(false);
  });

  it("remembered commands from before 2026-10-10 are ignored, and the next write drops them", () => {
    const root = withFile({
      commandAllow: [
        { argvPrefix: ["npm", "run"], anyArgs: true, addedAt: "x", cwd: "" },
      ],
      trust: "workspace",
    });
    const store = new WorkspacePermissions(() => root);
    expect(store.autoReview()).toBe(true);
    store.setAutoReview(true);
    expect(read(root)).toEqual({ version: 1, autoReview: true });
  });
});
