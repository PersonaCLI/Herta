import { describe, expect, it } from "vitest";
import { attachmentImageUrl } from "../shared/attachment-image.js";
import { resolveAttachmentPath } from "./attachment-protocol.js";

// win32 spells the root differently; the guard is the same shape either way.
const ROOT = process.platform === "win32" ? "E:\\repo" : "/repo";
const sep = process.platform === "win32" ? "\\" : "/";

const resolveUrl = (url: string) => resolveAttachmentPath(url, ROOT);
const resolveRel = (rel: string) => resolveUrl(attachmentImageUrl(rel));

describe("resolveAttachmentPath", () => {
  it("resolves a stored attachment under the workspace", () => {
    expect(resolveRel(".herta/attachments/s1/shot-ab12cd34.png")).toBe(
      [ROOT, ".herta", "attachments", "s1", "shot-ab12cd34.png"].join(sep),
    );
  });

  it("round-trips a filename that needs encoding", () => {
    // Attachment names keep the user's own spelling; the URL must survive
    // spaces, parentheses and CJK.
    expect(resolveRel(".herta/attachments/s1/报告 (最终)-ab12cd34.png")).toBe(
      [ROOT, ".herta", "attachments", "s1", "报告 (最终)-ab12cd34.png"].join(
        sep,
      ),
    );
  });

  it("refuses anything outside the attachment tree", () => {
    // The renderer is sandboxed from the filesystem on purpose. This scheme
    // must not become a read-any-file primitive for it.
    expect(resolveRel("package.json")).toBe(null);
    expect(resolveRel(".herta/settings.json")).toBe(null);
    expect(resolveRel(".herta/logs/run.log")).toBe(null);
    expect(resolveRel("src/main/key-store.ts")).toBe(null);
  });

  it("resolves a screenshot the page steps kept, and nothing else of theirs outside it (ADR 0083 §11)", () => {
    expect(resolveRel(".herta/browser/s1/shot-3.png")).toBe(
      [ROOT, ".herta", "browser", "s1", "shot-3.png"].join(sep),
    );
    // Claimed as the browser store, resolved outside it.
    expect(resolveRel(".herta/browser/../attachments/../settings.json")).toBe(
      null,
    );
    expect(resolveRel(".herta/browser/../logs/run.log")).toBe(null);
  });

  it("refuses a traversal that escapes the workspace", () => {
    expect(resolveRel(".herta/attachments/../../../etc/passwd")).toBe(null);
    expect(resolveRel("../outside.png")).toBe(null);
  });

  it("refuses a traversal that lands back inside the root but outside attachments", () => {
    // The subtle one: this stays under the workspace, so a root-only guard
    // would pass it. The claim AND the resolved path are both checked.
    expect(resolveRel(".herta/attachments/../settings.json")).toBe(null);
    expect(resolveRel(".herta/attachments/s1/../../logs/run.log")).toBe(null);
  });

  it("refuses an absolute path injected as the relative one", () => {
    expect(resolveUrl("herta-attachment://file//etc/passwd")).toBe(null);
    expect(resolveUrl("herta-attachment://file/C:/Windows/win.ini")).toBe(null);
  });

  it("refuses a malformed URL or an empty path", () => {
    expect(resolveUrl("not a url")).toBe(null);
    expect(resolveUrl("herta-attachment://file/")).toBe(null);
    expect(resolveUrl("herta-attachment://file/%E0%A4%A")).toBe(null);
  });

  it("refuses a backslash-spelled path that dodges the prefix check", () => {
    // A Windows-style separator must not let `.herta\attachments\..` slip
    // past a check written for forward slashes.
    expect(
      resolveUrl("herta-attachment://file/.herta%5Cattachments%5C..%5Cx.png"),
    ).toBe(null);
  });
});
