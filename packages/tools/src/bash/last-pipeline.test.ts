import { describe, expect, it } from "vitest";
import { pipelinesOf } from "./last-pipeline.js";

/** The line's last pipeline: the one the shell's statuses belong to. */
const stages = (command: string) =>
  pipelinesOf(command)?.at(-1)?.stages ?? null;

describe("the last pipeline: which stages the shell's last statuses belong to", () => {
  it("a single command is a pipeline of one", () => {
    expect(stages("npm test")).toEqual(["npm test"]);
  });

  it("a pipe gives its stages, left to right; `|&` is a pipe too", () => {
    expect(stages("npm test 2>&1 | tee log.txt")).toEqual([
      "npm test 2>&1",
      "tee log.txt",
    ]);
    expect(stages("npm test |& tee log.txt | tail -20")).toEqual([
      "npm test",
      "tee log.txt",
      "tail -20",
    ]);
  });

  it("only the LAST pipeline, whatever ran before it", () => {
    expect(stages("cd sub && npm test 2>&1 | tail -40")).toEqual([
      "npm test 2>&1",
      "tail -40",
    ]);
    expect(stages("npm test | tee log; echo done")).toEqual(["echo done"]);
    expect(stages("npm test || true")).toEqual(["true"]);
    expect(stages("a\nb | c\n")).toEqual(["b", "c"]);
    // A trailing separator ends nothing new.
    expect(stages("npm test | tail -5;")).toEqual(["npm test", "tail -5"]);
  });

  it("a redirection's `&` and `>|` are not separators", () => {
    expect(stages("npm test >out.txt 2>&1")).toEqual([
      "npm test >out.txt 2>&1",
    ]);
    expect(stages("npm test &>all.log | cat")).toEqual([
      "npm test &>all.log",
      "cat",
    ]);
    expect(stages("echo x >| f.txt")).toEqual(["echo x >| f.txt"]);
  });

  it("quotes and escapes keep their text together", () => {
    expect(stages(`grep "a | b; c" f.txt | wc -l`)).toEqual([
      `grep "a | b; c" f.txt`,
      "wc -l",
    ]);
    expect(stages("echo 'it; is | fine' | cat")).toEqual([
      "echo 'it; is | fine'",
      "cat",
    ]);
    expect(stages("echo a\\|b | cat")).toEqual(["echo a\\|b", "cat"]);
    expect(stages(`echo "say \\"hi\\" | no" | cat`)).toEqual([
      `echo "say \\"hi\\" | no"`,
      "cat",
    ]);
  });

  it("answers null for what it does not model, so the caller falls back", () => {
    for (const line of [
      "(npm test) | tee log",
      "{ npm test; } | tee log",
      "npm test | tee $(date +%s).log",
      'npm test | tee "$(date +%s).log"',
      "npm test | tee `date +%s`.log",
      "cat <<'EOF' | npm test\nx\nEOF",
      "npm test | tail -5 # the tail",
      "if npm test | tee log; then echo ok; fi",
      "for f in a b; do npm test | tail; done",
      "! npm test | tee log",
      "time npm test | tail -3",
      "npm test | tee log &",
      "npm test \\\n  | tee log",
      "npm test | | tee log",
      "npm test |",
      'echo "unterminated | cat',
      "",
      "   ",
    ]) {
      expect(pipelinesOf(line), JSON.stringify(line)).toBeNull();
    }
  });
});

describe("pipelinesOf: the whole line, and what joins its parts", () => {
  it("names each pipeline's stages and its join to the next", () => {
    expect(pipelinesOf("cd pkg && npm test 2>&1 | tee log; echo done")).toEqual(
      [
        { stages: ["cd pkg"], join: "&&" },
        { stages: ["npm test 2>&1", "tee log"], join: ";" },
        { stages: ["echo done"], join: "" },
      ],
    );
    expect(pipelinesOf("npm test || true")).toEqual([
      { stages: ["npm test"], join: "||" },
      { stages: ["true"], join: "" },
    ]);
  });

  it("a line break joins like a semicolon; a trailing separator joins the last pipeline to nothing", () => {
    expect(pipelinesOf("a\nb | c\n")).toEqual([
      { stages: ["a"], join: ";" },
      { stages: ["b", "c"], join: "" },
    ]);
    expect(pipelinesOf("npm test;")).toEqual([
      { stages: ["npm test"], join: "" },
    ]);
    // A blank part between two separators is not a pipeline.
    expect(pipelinesOf("a;\n\nb")).toEqual([
      { stages: ["a"], join: ";" },
      { stages: ["b"], join: "" },
    ]);
  });

  it("a keyword anywhere, not only at the end, leaves the line unread", () => {
    expect(pipelinesOf("if true; then npm test; fi; echo x")).toBeNull();
    expect(pipelinesOf("time npm test && echo ok")).toBeNull();
  });
});
