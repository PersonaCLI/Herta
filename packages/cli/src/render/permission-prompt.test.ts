import type { PermissionRequest } from "@herta/core";
import { describe, expect, it } from "vitest";
import { MockReadable, MockWritable } from "../testing/mock-streams.js";
import { CliAskResolver } from "./permission-prompt.js";
import { makeStyle } from "./style.js";

const style = makeStyle({ enabled: false });

function mkReq(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: "p1",
    call: { id: "c1", tool: "edit_file", input: { path: "x.txt" } },
    reason: "writes file",
    risk: "workspace_write",
    files: ["x.txt"],
    ...overrides,
  };
}

describe("CliAskResolver", () => {
  it("resolves 'allow' when stdin emits 'y'", async () => {
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const ac = new AbortController();
    const promise = resolver.present(mkReq(), ac.signal);
    stdin.feed("y");
    await expect(promise).resolves.toBe("allow");
    expect(stdout.full()).toContain("[y/N]");
  });

  it("resolves 'allow' when stdin emits 'Y'", async () => {
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const ac = new AbortController();
    const promise = resolver.present(mkReq(), ac.signal);
    stdin.feed("Y");
    await expect(promise).resolves.toBe("allow");
  });

  it("resolves 'deny' when stdin emits 'n'", async () => {
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const ac = new AbortController();
    const promise = resolver.present(mkReq(), ac.signal);
    stdin.feed("n");
    await expect(promise).resolves.toBe("deny");
  });

  it("resolves 'deny' on Enter (default-deny)", async () => {
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const ac = new AbortController();
    const promise = resolver.present(mkReq(), ac.signal);
    stdin.feed("\n");
    await expect(promise).resolves.toBe("deny");
  });

  it("renders risk + files before the prompt (diff is rendered earlier via patch.preview bus event)", async () => {
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const ac = new AbortController();
    const promise = resolver.present(
      mkReq({
        diff: "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n+new",
      }),
      ac.signal,
    );
    stdin.feed("y");
    await promise;
    const text = stdout.full();
    expect(text).toContain("workspace_write");
    expect(text).toContain("x.txt");
    // Diff content is NOT rendered here — TranscriptRenderer.renderPatchPreview
    // already showed it via the patch.preview bus event before this prompt
    // fired. Re-rendering would duplicate.
    expect(text).not.toContain("-old");
    expect(text).not.toContain("+new");
  });

  it("rejects with AbortError when the signal aborts — an interrupt is not a decision (audit finding 4)", async () => {
    // This used to resolve "deny", fabricating a user decision: the loop
    // emitted permission.resolved{deny} plus a "User denied <tool>" tool
    // result that entered the report and the next dispatch's working
    // history. The rejection path converges with every other interrupt.
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const ac = new AbortController();
    const promise = resolver.present(mkReq(), ac.signal);
    ac.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const ac = new AbortController();
    ac.abort();
    await expect(resolver.present(mkReq(), ac.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("CliAskResolver.presentDetailed", () => {
  it("renders [y/N] when showRemember is false", async () => {
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const ac = new AbortController();
    const promise = resolver.presentDetailed(mkReq(), ac.signal, {
      showRemember: false,
    });
    stdin.feed("y");
    await promise;
    expect(stdout.full()).toContain("[y/N]");
    expect(stdout.full()).not.toContain("[y/a/N]");
  });

  it("renders [y/a/N] when showRemember is true", async () => {
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const ac = new AbortController();
    const promise = resolver.presentDetailed(mkReq(), ac.signal, {
      showRemember: true,
    });
    stdin.feed("y");
    await promise;
    expect(stdout.full()).toContain("[y/a/N]");
  });

  it("'a' resolves allow_remember when showRemember is true", async () => {
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const ac = new AbortController();
    const promise = resolver.presentDetailed(mkReq(), ac.signal, {
      showRemember: true,
    });
    stdin.feed("a");
    await expect(promise).resolves.toBe("allow_remember");
  });

  it("'A' (capital) also resolves allow_remember", async () => {
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const ac = new AbortController();
    const promise = resolver.presentDetailed(mkReq(), ac.signal, {
      showRemember: true,
    });
    stdin.feed("A");
    await expect(promise).resolves.toBe("allow_remember");
  });

  it("'a' resolves deny when showRemember is false", async () => {
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const ac = new AbortController();
    const promise = resolver.presentDetailed(mkReq(), ac.signal, {
      showRemember: false,
    });
    stdin.feed("a");
    await expect(promise).resolves.toBe("deny");
  });

  it("'y' still resolves allow when showRemember is true", async () => {
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const ac = new AbortController();
    const promise = resolver.presentDetailed(mkReq(), ac.signal, {
      showRemember: true,
    });
    stdin.feed("y");
    await expect(promise).resolves.toBe("allow");
  });

  it("legacy present() falls through to deny on 'a' (third option is internal)", async () => {
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const ac = new AbortController();
    const promise = resolver.present(mkReq(), ac.signal);
    stdin.feed("a");
    // The legacy path uses showRemember: false, so 'a' falls through to deny.
    await expect(promise).resolves.toBe("deny");
  });

  it("[r] turns automatic review on when offered (ADR 0064 amendment 2026-10-10), and falls through to deny when not", async () => {
    const stdin = new MockReadable();
    const stdout = new MockWritable();
    const resolver = new CliAskResolver(stdin, stdout, style);
    const promise = resolver.presentDetailed(
      mkReq({ code: "command_ask_vcs" }),
      new AbortController().signal,
      { showRemember: false, showAutoReview: true },
    );
    stdin.feed("r");
    await expect(promise).resolves.toBe("allow_auto_review");
    const text = stdout.full();
    expect(text).toContain("[y/r/N]");
    expect(text).toContain("[r] turns on automatic review here");

    const stdin2 = new MockReadable();
    const stdout2 = new MockWritable();
    const r2 = new CliAskResolver(stdin2, stdout2, style);
    const p2 = r2.presentDetailed(mkReq(), new AbortController().signal, {
      showRemember: false,
    });
    stdin2.feed("r");
    await expect(p2).resolves.toBe("deny");
    expect(stdout2.full()).not.toContain("[r]");
  });
});
