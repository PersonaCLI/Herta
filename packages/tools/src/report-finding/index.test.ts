import {
  type AgentEvent,
  BackgroundHost,
  FindingsLedger,
  InMemoryEventBus,
  MAX_FINDINGS,
  NoopMemoryManager,
  ReadLedger,
} from "@herta/core";
import { afterEach, describe, expect, it } from "vitest";
import { mkTmpWorkspace, type TmpWorkspace } from "../testing/tmp-workspace.js";
import { type ReportFindingData, reportFindingTool } from "./index.js";

let ws: TmpWorkspace;
afterEach(async () => {
  if (ws) await ws.cleanup();
});

function ctx(workspaceRoot: string, findings = new FindingsLedger()) {
  return {
    sessionId: "s",
    signal: new AbortController().signal,
    workspaceRoot,
    reads: new ReadLedger(),
    bg: new BackgroundHost(),
    bus: new InMemoryEventBus<AgentEvent>(),
    memory: new NoopMemoryManager(),
    findings,
  };
}
const noop = () => {};
const run = (input: unknown, c: ReturnType<typeof ctx>) =>
  reportFindingTool().run({ id: "f1", tool: "report_finding", input }, c, noop);

describe("report_finding (ADR 0039)", () => {
  it("records a cited conclusion into the ledger and returns it", async () => {
    ws = await mkTmpWorkspace({
      "log.txt": Array.from({ length: 44 }, (_, i) => `line ${i + 1}`).join(
        "\n",
      ),
    });
    const ledger = new FindingsLedger();
    const r = await run(
      {
        claim:
          "The run died of CUDA OOM in the discriminator, not in data loading.",
        cites: ["log.txt:33", "log.txt:20-24"],
      },
      ctx(ws.root, ledger),
    );
    expect(r.ok).toBe(true);
    const data = r.data as ReportFindingData;
    expect(data).toEqual({
      index: 1,
      claim:
        "The run died of CUDA OOM in the discriminator, not in data loading.",
      cites: ["log.txt:33", "log.txt:20-24"],
    });
    expect(r.summary).toBe(
      "finding #1: The run died of CUDA OOM in the discriminator, not in data loading. — log.txt:33, log.txt:20-24",
    );
    expect(ledger.all()).toHaveLength(1);
  });

  it("refuses an uncited or one-word claim at the schema", async () => {
    ws = await mkTmpWorkspace({});
    const c = ctx(ws.root);
    const uncited = await run(
      { claim: "Everything is fine here.", cites: [] },
      c,
    );
    expect(uncited.ok).toBe(false);
    expect(uncited.error?.code).toBe("invalid_input");
    expect(uncited.error?.message).toContain("uncited");
    const terse = await run({ claim: "OOM", cites: ["a"] }, c);
    expect(terse.ok).toBe(false);
    expect(c.findings.size).toBe(0);
  });

  it("an over-long claim is told its length and to split (ADR 0083 step 7 lab)", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "x\n" });
    const c = ctx(ws.root);
    const long = await run(
      { claim: "很长的结论。".repeat(80), cites: ["a.txt"] },
      c,
    );
    expect(long.ok).toBe(false);
    expect(long.suggestion).toContain("480 characters");
    expect(long.suggestion).toContain("a finding of its own");
    // Any other refusal keeps the usage line.
    const uncited = await run(
      { claim: "Everything is fine here.", cites: [] },
      c,
    );
    expect(uncited.suggestion).toMatch(/^usage:/);
  });

  it("verifies every cite against disk — a fabricated path or out-of-range line fails the whole call", async () => {
    ws = await mkTmpWorkspace({ "log.txt": "a\nb\nc\n" });
    const c = ctx(ws.root);
    const ghost = await run(
      {
        claim: "The config enables multi-GPU.",
        cites: ["configs/runtime.yml:3"],
      },
      c,
    );
    expect(ghost.ok).toBe(false);
    expect(ghost.error?.code).toBe("invalid_cite");
    expect(ghost.error?.message).toContain("no such file");
    const beyond = await run(
      {
        claim: "The last line names the launcher.",
        cites: ["log.txt:1", "log.txt:99"],
      },
      c,
    );
    expect(beyond.ok).toBe(false);
    expect(beyond.error?.message).toContain("beyond the end");
    const inverted = await run(
      { claim: "Lines two through one.", cites: ["log.txt:2-1"] },
      c,
    );
    expect(inverted.ok).toBe(false);
    // Nothing partial was recorded.
    expect(c.findings.size).toBe(0);
  });

  it("accepts a bare path (whole file / directory) and a range ending exactly at the last line", async () => {
    ws = await mkTmpWorkspace({ "src/a.ts": "1\n2\n3\n", "src/b.ts": "x\n" });
    const c = ctx(ws.root);
    const r = await run(
      {
        claim: "src/ holds only two modules and neither exports a default.",
        cites: ["src", "src/a.ts:1-3"],
      },
      c,
    );
    expect(r.ok).toBe(true);
    expect((r.data as ReportFindingData).cites).toEqual([
      "src",
      "src/a.ts:1-3",
    ]);
  });

  it("reaches attachments and .herta/logs through the read carve-outs, and nothing else under .herta", async () => {
    ws = await mkTmpWorkspace({
      ".herta/attachments/s1/log-ab.txt": "warn\nCUDA out of memory\n",
      ".herta/logs/run-1.log": "exit 1\n",
      ".herta/keys/deepseek": "sk-x\n",
    });
    const c = ctx(ws.root);
    const ok = await run(
      {
        claim: "The attached log shows an out-of-memory failure.",
        cites: [
          ".herta/attachments/s1/log-ab.txt:2",
          ".herta/logs/run-1.log:1",
        ],
      },
      c,
    );
    expect(ok.ok).toBe(true);
    const denied = await run(
      {
        claim: "The key file is present in the workspace.",
        cites: [".herta/keys/deepseek"],
      },
      c,
    );
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("invalid_cite");
  });

  it("caps findings per brief and says so", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "x\n" });
    const c = ctx(ws.root);
    for (let i = 0; i < MAX_FINDINGS; i += 1) {
      const r = await run(
        {
          claim: `Conclusion number ${i + 1} about a.txt.`,
          cites: ["a.txt:1"],
        },
        c,
      );
      expect(r.ok).toBe(true);
      expect((r.data as ReportFindingData).index).toBe(i + 1);
    }
    const over = await run(
      { claim: "One conclusion too many for the cap.", cites: ["a.txt:1"] },
      c,
    );
    expect(over.ok).toBe(false);
    expect(over.error?.code).toBe("findings_cap");
    expect(c.findings.size).toBe(MAX_FINDINGS);
  });

  it("works without a ledger in the context (index 0, still validated)", async () => {
    ws = await mkTmpWorkspace({ "a.txt": "x\n" });
    const { findings: _f, ...bare } = ctx(ws.root);
    const r = await reportFindingTool().run(
      {
        id: "f",
        tool: "report_finding",
        input: {
          claim: "A cited claim with no ledger present.",
          cites: ["a.txt:1"],
        },
      },
      bare,
      noop,
    );
    expect(r.ok).toBe(true);
    expect((r.data as ReportFindingData).index).toBe(0);
  });

  // ADR 0016 amendment (2026-09-03): `claim` reaches the user verbatim, so
  // the description names the conversation's language for it.
  it("names the session's language for the claim; zh is the default", () => {
    const zh = reportFindingTool().schema().description;
    expect(zh).toContain("Write `claim` in Chinese (中文)");
    expect(reportFindingTool({ lang: "zh" }).schema().description).toBe(zh);
    const en = reportFindingTool({ lang: "en" }).schema().description;
    expect(en).toContain("Write `claim` in English");
    expect(en).not.toMatch(/[一-鿿]/);
    expect(en.split("Write `claim`")[0]).toBe(zh.split("Write `claim`")[0]);
  });
});
