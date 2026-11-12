import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalRecordBlock } from "../types/terminal-record.js";
import { V2RecordPersister } from "./v2-record-persister.js";

/**
 * The two rewrites work on bytes (review 2026-11-10, second pass): a rewind
 * shortens the file where the first withdrawn block starts, a replacement
 * writes one new line between the bytes around it. They used to decode,
 * split, parse every line and write the whole file back. This holds the new
 * ones to what the old ones produced.
 */

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "v2-persist-bytes-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const HEADER = `${JSON.stringify({
  _kind: "session_meta",
  version: 1,
  sessionId: "s",
  startedAt: "2026-11-12T00:00:00.000Z",
  workspaceRoot: "/w",
})}\n`;

function fileWith(body: string): V2RecordPersister {
  const file = join(tmp, `${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, HEADER + body, "utf8");
  return V2RecordPersister.forResume({ sessionFile: file });
}

/** The truncation as it was written before: every line parsed, the kept
 *  ones joined and written back. The reference the new one is held to. */
function truncatedAsBefore(raw: string, keepBlockCount: number): string {
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const header = lines[0];
  if (header === undefined) return raw;
  const kept: string[] = [header];
  let blockCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    let parsed: { _kind?: string };
    try {
      parsed = JSON.parse(line) as { _kind?: string };
    } catch {
      break;
    }
    const isBlock = parsed._kind === undefined;
    if (isBlock && blockCount >= keepBlockCount) break;
    kept.push(line);
    if (isBlock) blockCount += 1;
  }
  return `${kept.join("\n")}\n`;
}

function replacedAsBefore(
  raw: string,
  blockIndex: number,
  block: TerminalRecordBlock,
): string {
  const lines = raw.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let blockCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    let parsed: { _kind?: string; at?: unknown };
    try {
      parsed = JSON.parse(line) as { _kind?: string; at?: unknown };
    } catch {
      return raw;
    }
    if (parsed._kind !== undefined) continue;
    if (blockCount === blockIndex) {
      lines[i] = JSON.stringify(
        block.at === undefined && typeof parsed.at === "string"
          ? { ...block, at: parsed.at }
          : block,
      );
      return `${lines.join("\n")}\n`;
    }
    blockCount += 1;
  }
  return raw;
}

/** A small deterministic generator, so a failure names its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** A session body: blocks and meta lines in any order. Some blocks spell
 *  `"_kind"` in their text, as a transcript about this file does. */
function body(next: () => number): { text: string; blocks: number } {
  const lines: string[] = [];
  let blocks = 0;
  const n = Math.floor(next() * 14);
  for (let i = 0; i < n; i++) {
    const roll = next();
    if (roll < 0.2) {
      lines.push(
        JSON.stringify(
          roll < 0.1
            ? { _kind: "workspace_set", path: `/w/${i}`, at: "t" }
            : { _kind: "turn_end", outcome: "completed", at: "t" },
        ),
      );
      continue;
    }
    blocks += 1;
    const text =
      roll < 0.4
        ? `the header says {"_kind":"session_meta"} — line ${i}`
        : roll < 0.6
          ? `多行\n文本 ${i} with "quotes" and a \\ backslash`
          : `plain ${i}`;
    lines.push(
      JSON.stringify(
        roll < 0.8
          ? {
              kind: "user",
              text,
              at: `2026-11-12T00:00:${String(i).padStart(2, "0")}.000Z`,
            }
          : { kind: "system", label: "系统", body: text },
      ),
    );
  }
  return { text: lines.map((l) => `${l}\n`).join(""), blocks };
}

describe("truncateToBlockCount — by bytes", () => {
  it("leaves what the line-by-line rewrite left, on 400 generated files", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const next = rng(seed);
      const made = body(next);
      const keep = Math.floor(next() * (made.blocks + 2));
      const p = fileWith(made.text);
      const before = readFileSync(p.sessionFile, "utf8");
      p.truncateToBlockCount(keep);
      expect(readFileSync(p.sessionFile, "utf8"), `seed ${seed}`).toBe(
        truncatedAsBefore(before, keep),
      );
    }
  });

  it("a block whose text spells the meta key is a block, not a meta line", () => {
    const p = fileWith("");
    p.appendBlock({ kind: "user", text: 'what is {"_kind":"turn_end"} for?' });
    p.appendBlock({ kind: "user", text: "second" });
    p.appendBlock({ kind: "user", text: "third" });
    p.truncateToBlockCount(1);
    const lines = readFileSync(p.sessionFile, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({
      text: 'what is {"_kind":"turn_end"} for?',
    });
  });

  it("shortens the file in place: the kept bytes are the file's own first bytes", () => {
    const p = fileWith("");
    for (let i = 0; i < 50; i++) p.appendBlock({ kind: "user", text: `m${i}` });
    const before = readFileSync(p.sessionFile);
    p.truncateToBlockCount(20);
    const after = readFileSync(p.sessionFile);
    expect(after.length).toBeLessThan(before.length);
    expect(after.equals(before.subarray(0, after.length))).toBe(true);
    expect(after[after.length - 1]).toBe(0x0a);
    // Keeping everything touches nothing.
    const size = statSync(p.sessionFile).size;
    p.truncateToBlockCount(20);
    p.truncateToBlockCount(999);
    expect(statSync(p.sessionFile).size).toBe(size);
  });

  it("a failed append's fragment goes; a whole line left unended is ended", () => {
    const cut = fileWith(`${JSON.stringify({ kind: "user", text: "a" })}\n`);
    appendFileSync(cut.sessionFile, '{"kind":"user","text":"half');
    cut.truncateToBlockCount(5);
    expect(readFileSync(cut.sessionFile, "utf8")).toBe(
      `${HEADER}${JSON.stringify({ kind: "user", text: "a" })}\n`,
    );

    const whole = fileWith(`${JSON.stringify({ kind: "user", text: "a" })}\n`);
    appendFileSync(
      whole.sessionFile,
      JSON.stringify({ kind: "user", text: "b" }),
    );
    whole.truncateToBlockCount(5);
    const text = readFileSync(whole.sessionFile, "utf8");
    expect(
      text.endsWith(`${JSON.stringify({ kind: "user", text: "b" })}\n`),
    ).toBe(true);
    // And the unended line is cut like any other when it is withdrawn.
    whole.truncateToBlockCount(1);
    expect(readFileSync(whole.sessionFile, "utf8")).toBe(
      `${HEADER}${JSON.stringify({ kind: "user", text: "a" })}\n`,
    );
  });

  it("leaves a file with no whole header alone", () => {
    const file = join(tmp, "partial.jsonl");
    writeFileSync(file, '{"_kind":"session_me', "utf8");
    const p = V2RecordPersister.forResume({ sessionFile: file });
    p.truncateToBlockCount(0);
    p.replaceBlockAt(0, { kind: "system", label: "系统", body: "x" });
    expect(readFileSync(file, "utf8")).toBe('{"_kind":"session_me');
  });
});

describe("replaceBlockAt — by bytes", () => {
  const TOMBSTONE: TerminalRecordBlock = {
    kind: "system",
    label: "系统",
    body: "附件已移除",
  };

  it("leaves what the line-by-line rewrite left, on 400 generated files", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const next = rng(seed + 10_000);
      const made = body(next);
      const index = Math.floor(next() * (made.blocks + 2));
      const p = fileWith(made.text);
      const before = readFileSync(p.sessionFile, "utf8");
      p.replaceBlockAt(index, TOMBSTONE);
      expect(readFileSync(p.sessionFile, "utf8"), `seed ${seed}`).toBe(
        replacedAsBefore(before, index, TOMBSTONE),
      );
    }
  });

  it("every byte outside the replaced line is the file's own", () => {
    const p = fileWith("");
    for (let i = 0; i < 30; i++)
      p.appendBlock({ kind: "user", text: `行 ${i}` });
    const before = readFileSync(p.sessionFile, "utf8").split("\n");
    p.replaceBlockAt(12, TOMBSTONE);
    const after = readFileSync(p.sessionFile, "utf8").split("\n");
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i++) {
      // Block 12 is line 13: the header is line 0.
      if (i === 13)
        expect(JSON.parse(after[i] ?? "{}")).toMatchObject(TOMBSTONE);
      else expect(after[i]).toBe(before[i]);
    }
  });
});
