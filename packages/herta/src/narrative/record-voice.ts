import {
  type DoneMarkerSummary,
  type EvidenceSection,
  isBrowserOpVerb,
  isServerOpVerb,
  type SystemBlock,
} from "@herta/core";
import { isPageDigest, pageFoldLine, pageRowForHerta } from "./page-voice.js";
import type { PromptLang } from "./prompt-lang.js";
import { serverFoldLine, serverRowForHerta } from "./server-voice.js";

/**
 * 板砖's rows as Herta reads them (ADR 0079 §2, owner 2026-10-16: "the
 * herta's context should be written like 自传").
 *
 * The record is unchanged — canonical, persisted, read by 板砖, the CLI and
 * the GUI as before. This is the projection into her prompt: what was done
 * and what came of it, in the session's language, without the store's
 * bookkeeping. Dropped: the routine command's exit code and line count, the
 * log and sandbox paths, the `cd <workspace> &&` plumbing, durations, the
 * `↳ label:` scaffolding and the English row codes. Kept: commands and their
 * output, what changed and by how much, test results, findings with their
 * `file:line`, failures and why, what was remembered, and the excerpts and
 * diffs she judges — D3 needs every one of them.
 *
 * Applied per block after the record's compaction (`serialize.ts`), so it
 * reaches the main turn, a beat's fresh window and every other projection
 * alike. A row the projection does not know keeps its own text.
 */

type Texts = {
  readonly verb: Record<string, string | null>;
  readonly lines: (from: number, to: number) => string;
  readonly cite: (path: string, from: number, to: number) => string;
  readonly exitCode: (code: string) => string;
  readonly output: string;
  readonly moreNotShown: string;
  readonly remembered: string;
  readonly tests: Record<"passed" | "failed" | "skipped" | "not_run", string>;
  readonly change: (files: string, add?: number, del?: number) => string;
  readonly excerpt: (path: string, from: number, to: number) => string;
  readonly readExcerpt: (path: string, from: number, to: number) => string;
  readonly finding: (claim: string, cites: readonly string[]) => string;
  readonly search: (pattern: string, matches: number, files: number) => string;
  /** A search detail's header and its note of matches left out. */
  readonly matches: (pattern: string) => string;
  readonly moreMatches: (n: number) => string;
  readonly toolFail: (tool: string, message: string) => string;
  readonly bg: (id: string, state: string, exit?: number | null) => string;
  readonly digest: (name: string, chunks: number, cached: boolean) => string;
  /** web_search's op arg, the query (ADR 0080). */
  readonly query: (q: string) => string;
  readonly webResults: (n: number) => string;
  readonly webPage: (host: string, title: string) => string;
  readonly webSearched: (q: string, n: number) => string;
  readonly webRead: (host: string, title: string) => string;
  readonly noop: string;
  readonly done: (m: DoneMarkerSummary) => string;
  readonly labels: Record<string, string>;
  readonly ran: (cmd: string, exit: string) => string;
  readonly timedOut: (cmd: string) => string;
  readonly listJoin: string;
  readonly aside: (note: string) => string;
};

const ZH_STATE: Record<string, string> = {
  completed: "做完了",
  blocked: "卡住了",
  failed: "没做成",
  // The user's own Stop — never a failure (audit 2026-07-24, 1.4).
  interrupted: "停下了",
  partial: "做了一部分",
};
const EN_STATE: Record<string, string> = {
  completed: "Done",
  blocked: "Blocked",
  failed: "Failed",
  interrupted: "Stopped",
  partial: "Partly done",
};

const TEXTS: Record<PromptLang, Texts> = {
  zh: {
    verb: {
      Running: "运行",
      Reading: "读",
      Writing: "写",
      Inspecting: "查看",
      Searching: "搜索",
      Stopping: "停下",
      Digesting: "通读",
      "Searching the web": "搜索网页",
      "Reading web page": "读网页",
      // The remembered row says what was saved; its kind is bookkeeping.
      "Saving memory": null,
      Planning: null,
    },
    lines: (from, to) =>
      from === to ? `第 ${from} 行` : `第 ${from}–${to} 行`,
    cite: (path, from, to) =>
      `${path} ${from === to ? `第 ${from} 行` : `第 ${from}–${to} 行`}`,
    exitCode: (code) => `没成，退出码 ${code}`,
    output: "输出：",
    moreNotShown: "……（后面还有，没贴全）",
    // 板砖's note, not hers: a saved fact is not something she knows.
    remembered: "板砖记下了：",
    tests: {
      passed: "测试通过",
      failed: "测试没过",
      skipped: "测试跳过了",
      not_run: "测试没跑起来",
    },
    change: (files, add, del) =>
      add === undefined || del === undefined
        ? `改动 ${files}（经由命令，没有逐行改动）`
        : `改动 ${files}（+${add} −${del}）`,
    excerpt: (path, from, to) =>
      `摘录 ${path} ${from === to ? `第 ${from} 行` : `第 ${from}–${to} 行`}：`,
    readExcerpt: (path, from, to) =>
      `读 ${path} ${from === to ? `第 ${from} 行` : `第 ${from}–${to} 行`}`,
    finding: (claim, cites) =>
      `结论：${claim}${cites.length > 0 ? `（${cites.join("，")}）` : ""}`,
    search: (pattern, matches, files) =>
      `搜索 /${pattern}/：${files} 个文件里 ${matches} 处`,
    matches: (pattern) => `匹配 /${pattern}/:`,
    moreMatches: (n) => `（另有 ${n} 处未列出）`,
    toolFail: (tool, message) =>
      `这一步没成（${tool}）${message.length > 0 ? `：${message}` : ""}`,
    bg: (id, state, exit) =>
      state === "running"
        ? `后台命令 ${id} 在跑`
        : state === "stopped"
          ? `后台命令 ${id} 停了`
          : exit === null || exit === undefined
            ? `后台命令 ${id} 被终止`
            : `后台命令 ${id} 结束，退出码 ${exit}`,
    digest: (name, chunks, cached) =>
      `通读了 ${name}，共 ${chunks} 段${cached ? "，用的上回的摘要" : ""}`,
    query: (q) => `「${q}」`,
    webResults: (n) => (n === 0 ? "没搜到结果" : `找到 ${n} 条结果：`),
    webPage: (host, title) =>
      `网页 ${host}${title !== "" ? `「${title}」` : ""}，开头：`,
    webSearched: (q, n) =>
      `搜索过网页「${q}」，${n === 0 ? "没搜到" : `${n} 条结果`}`,
    webRead: (host, title) =>
      `读过网页 ${host}${title !== "" ? `「${title}」` : ""}`,
    noop: "板砖这次什么也没动。",
    done: (m) => {
      const parts: string[] = [];
      if (m.fileCount > 0) {
        parts.push(
          `改了 ${m.fileCount} 个文件${m.lines !== undefined ? `（+${m.lines.add} −${m.lines.del}）` : ""}`,
        );
      }
      if (m.tests !== undefined) {
        // None passed and none failed is not a pass: the tests were
        // skipped or never found (release review 2026-10-22; D3).
        parts.push(
          m.tests.failed > 0
            ? `测试 ${m.tests.passed} 过、${m.tests.failed} 没过`
            : m.tests.passed > 0
              ? `测试 ${m.tests.passed}/${m.tests.passed} 通过`
              : "测试一个都没跑",
        );
      }
      if (m.git?.commit !== undefined) parts.push(`提交 ${m.git.commit}`);
      if (m.git?.pushedRef !== undefined)
        parts.push(`推到了 ${m.git.pushedRef}`);
      if (m.riskCount > 0) parts.push(`留了 ${m.riskCount} 个风险`);
      if (m.aborted === true) parts.push("运行中途出了异常");
      if (m.crashed === true) parts.push("应用意外退出");
      if (m.stepLimit === true) parts.push("步数到了上限");
      const state = ZH_STATE[m.state] ?? m.state;
      return parts.length > 0
        ? `${state}：${parts.join("，")}。`
        : `${state}。`;
    },
    labels: {
      改动文件: "改了：",
      风险: "风险：",
      结论: "结论：",
      依据: "依据：",
      提示: "提示：",
      错误: "错误：",
      中断时: "中断时：",
    },
    ran: (cmd, exit) =>
      exit === "0" ? `运行 \`${cmd}\`` : `运行 \`${cmd}\`（退出码 ${exit}）`,
    timedOut: (cmd) => `运行 ${cmd} 超时`,
    listJoin: "、",
    aside: (note) => `（${note}）`,
  },
  en: {
    verb: {
      Running: "Ran",
      Reading: "Read",
      Writing: "Wrote",
      Inspecting: "Looked at",
      Searching: "Searched",
      Stopping: "Stopped",
      Digesting: "Read through",
      "Searching the web": "Searched the web for",
      "Reading web page": "Read web page",
      "Saving memory": null,
      Planning: null,
    },
    lines: (from, to) => (from === to ? `line ${from}` : `lines ${from}–${to}`),
    cite: (path, from, to) =>
      `${path} ${from === to ? `line ${from}` : `lines ${from}–${to}`}`,
    exitCode: (code) => `Failed, exit code ${code}`,
    output: "Output:",
    moreNotShown: "…(more, not shown)",
    remembered: "板砖 noted: ",
    tests: {
      passed: "Tests passed",
      failed: "Tests failed",
      skipped: "Tests skipped",
      not_run: "Tests did not run",
    },
    change: (files, add, del) =>
      add === undefined || del === undefined
        ? `Changed ${files} (through a command, no line diff)`
        : `Changed ${files} (+${add} −${del})`,
    excerpt: (path, from, to) =>
      `Excerpt of ${path} ${from === to ? `line ${from}` : `lines ${from}–${to}`}:`,
    readExcerpt: (path, from, to) =>
      `Read ${path} ${from === to ? `line ${from}` : `lines ${from}–${to}`}`,
    finding: (claim, cites) =>
      `Finding: ${claim}${cites.length > 0 ? ` (${cites.join(", ")})` : ""}`,
    search: (pattern, matches, files) =>
      `Searched /${pattern}/: ${matches} matches in ${files} files`,
    matches: (pattern) => `Matches for /${pattern}/:`,
    moreMatches: (n) => `(${n} more not listed)`,
    toolFail: (tool, message) =>
      `A step failed (${tool})${message.length > 0 ? `: ${message}` : ""}`,
    bg: (id, state, exit) =>
      state === "running"
        ? `Background command ${id} is running`
        : state === "stopped"
          ? `Background command ${id} stopped`
          : exit === null || exit === undefined
            ? `Background command ${id} was killed`
            : `Background command ${id} exited with code ${exit}`,
    digest: (name, chunks, cached) =>
      `Read through ${name}, ${chunks} parts${cached ? ", from the last summary" : ""}`,
    query: (q) => `"${q}"`,
    webResults: (n) =>
      n === 0 ? "No results" : `Found ${n} result${n === 1 ? "" : "s"}:`,
    webPage: (host, title) =>
      `Page ${host}${title !== "" ? `, "${title}"` : ""} — the opening:`,
    webSearched: (q, n) =>
      `Searched the web for "${q}": ${n === 0 ? "nothing found" : `${n} result${n === 1 ? "" : "s"}`}`,
    webRead: (host, title) =>
      `Read web page ${host}${title !== "" ? `, "${title}"` : ""}`,
    noop: "板砖 did nothing this time.",
    done: (m) => {
      const parts: string[] = [];
      if (m.fileCount > 0) {
        parts.push(
          `changed ${m.fileCount} file${m.fileCount === 1 ? "" : "s"}${m.lines !== undefined ? ` (+${m.lines.add} −${m.lines.del})` : ""}`,
        );
      }
      if (m.tests !== undefined) {
        parts.push(
          m.tests.failed > 0
            ? `tests ${m.tests.passed} passed, ${m.tests.failed} failed`
            : m.tests.passed > 0
              ? `tests ${m.tests.passed}/${m.tests.passed} passed`
              : "no test ran",
        );
      }
      if (m.git?.commit !== undefined) parts.push(`committed ${m.git.commit}`);
      if (m.git?.pushedRef !== undefined)
        parts.push(`pushed to ${m.git.pushedRef}`);
      if (m.riskCount > 0)
        parts.push(`${m.riskCount} risk${m.riskCount === 1 ? "" : "s"} left`);
      if (m.aborted === true) parts.push("the run broke off");
      if (m.crashed === true) parts.push("the app quit unexpectedly");
      if (m.stepLimit === true) parts.push("it reached the step limit");
      const state = EN_STATE[m.state] ?? m.state;
      return parts.length > 0 ? `${state}: ${parts.join(", ")}.` : `${state}.`;
    },
    // Never `Changed:` / `Risks:` / `Evidence:` — the robotic report D3
    // names, which the 废案 gate rejects (`LEAK_MARKERS`), so a seed or a
    // dream that retells the record could not carry them (ADR 0079 §3).
    labels: {
      改动文件: "Changed files: ",
      风险: "Risks left: ",
      结论: "Findings: ",
      依据: "Based on: ",
      提示: "Hint: ",
      错误: "Error: ",
      中断时: "When it stopped: ",
    },
    ran: (cmd, exit) =>
      exit === "0" ? `ran \`${cmd}\`` : `ran \`${cmd}\` (exit code ${exit})`,
    timedOut: (cmd) => `${cmd} timed out`,
    listJoin: ", ",
    aside: (note) => ` (${note})`,
  },
};

/** `cd <workspace> && ` the model writes before a command: plumbing. */
const CD_PREFIX = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/;

/** A receipt as she reads it: the command and any failure, without the
 *  log path, the duration or the `cd` plumbing. Other receipts keep their
 *  own words. */
export function receiptForHerta(item: string, lang: PromptLang): string {
  const t = TEXTS[lang];
  const bare = item
    .replace(/\s+—\s+(?:partial output captured,\s+)?log at [^\s（]+/u, "")
    // A tool call's id as its "source" is bookkeeping too.
    .replace(/（call_[A-Za-z0-9_]+）/gu, "")
    .trim();
  // A receipt may carry its source after it, `（…）`; that stays.
  const ran = /^ran `(.*)` \(exit ([^,)]+), [\d.]+s\)(.*)$/su.exec(bare);
  if (ran !== null) {
    const cmd = (ran[1] ?? "").replace(CD_PREFIX, "");
    return `${t.ran(cmd, (ran[2] ?? "").trim())}${ran[3] ?? ""}`;
  }
  const timedOut = /^timed out: (.*) \(\d+ms\)(.*)$/su.exec(bare);
  if (timedOut !== null) {
    const cmd = (timedOut[1] ?? "").replace(CD_PREFIX, "");
    return `${t.timedOut(cmd)}${timedOut[2] ?? ""}`;
  }
  return bare;
}

/** `a.ts:1-10, b.ts:3-4` (an op row's argument) with each range read as
 *  lines; anything else as it was. */
function citeRanges(arg: string, lang: PromptLang): string {
  return arg.replace(/([^\s,:]+):(\d+)-(\d+)/gu, (_m, path, from, to) =>
    TEXTS[lang].cite(String(path), Number(from), Number(to)),
  );
}

/**
 * A row's `↳ label: …` detail as she reads it: each label in plain words,
 * the output and code under it untouched, the truncation note without the
 * log path. Lines the projection does not know keep their words, less the
 * arrow.
 */
export function detailForHerta(
  detail: string,
  lang: PromptLang,
  /** The row's structured sections: a list line is rebuilt from its items,
   *  since the joined string cannot be split back — a command's own `; `
   *  breaks it. */
  sections: readonly EvidenceSection[] = [],
): string {
  const t = TEXTS[lang];
  const items = (kind: "evidence" | "findings" | "risks"): string[] | null => {
    const s = sections.find((e) => e.kind === kind);
    return s !== undefined &&
      (s.kind === "evidence" || s.kind === "findings" || s.kind === "risks")
      ? [...s.items]
      : null;
  };
  const sep = lang === "en" ? "; " : "；";
  // A web row's detail — carried whole as the done-marker's tail when the
  // run ended on it — is rebuilt from its evidence, as the row itself is:
  // its header names the URL and the stored path, and her view never does
  // (ADR 0080 §5). Passed through as an unknown line, both reached her
  // verdict prompt and the dream's digest (release review 2026-10-22).
  const [head = "", ...body] = detail.split("\n");
  // A search's matches: its header and its note of what was left out in the
  // session's language — they reached an English prompt in Chinese (release
  // review 2026-10-22). The match lines are the files' own.
  const searched = /^↳ 匹配 \/(.*)\/:$/su.exec(head);
  if (searched !== null) {
    return [
      t.matches(searched[1] ?? ""),
      ...body.map((line) => {
        const more = /^（另有 (\d+) 处未列出）$/u.exec(line);
        return more !== null ? t.moreMatches(Number(more[1])) : line;
      }),
    ].join("\n");
  }
  if (head === "↳ 网页结果:") {
    const s = sections.find((e) => e.kind === "web-results");
    const listed =
      s?.kind === "web-results"
        ? s.items.map((i) => `- ${i.title}${t.aside(i.site)}`)
        : body;
    return [t.webResults(listed.length), ...listed].join("\n");
  }
  if (head.startsWith("↳ 网页 ")) {
    const s = sections.find((e) => e.kind === "web-page");
    const url =
      s?.kind === "web-page"
        ? s.url
        : (/（(\S+?)，存于 /u.exec(head)?.[1] ?? "");
    const title =
      s?.kind === "web-page"
        ? s.title
        : (/^↳ 网页 「(.*)」（/su.exec(head)?.[1] ?? "");
    return [t.webPage(url !== "" ? hostOf(url) : "", title), ...body].join(
      "\n",
    );
  }
  return detail
    .split("\n")
    .map((line) => {
      if (/^…\(truncated(?:, full log: .*)?\)$/u.test(line))
        return t.moreNotShown;
      if (!line.startsWith("↳ ")) return line;
      if (line === "↳ 输出:") return t.output;
      const excerpt = /^↳ 摘录 (.+):(\d+)-(\d+)$/u.exec(line);
      if (excerpt !== null) {
        return t.excerpt(
          excerpt[1] ?? "",
          Number(excerpt[2]),
          Number(excerpt[3]),
        );
      }
      if (line.startsWith("↳ 摘要 "))
        return lang === "en"
          ? "Summary (model-written):"
          : "摘要（模型生成）：";
      const labelled = /^↳ ([^:：]+)[:：] ?(.*)$/su.exec(line);
      if (labelled !== null) {
        const label = labelled[1] ?? "";
        const rest = labelled[2] ?? "";
        const plain = t.labels[label];
        if (plain !== undefined) {
          if (label === "改动文件")
            return `${plain}${rest.split(", ").join(t.listJoin)}`;
          if (label === "依据") {
            const receipts = items("evidence") ?? rest.split("; ");
            return `${plain}${receipts.map((r) => receiptForHerta(r, lang)).join(sep)}`;
          }
          if (label === "结论" || label === "风险") {
            const listed = items(label === "结论" ? "findings" : "risks");
            return `${plain}${listed !== null ? listed.join(sep) : rest}`;
          }
          return `${plain}${rest}`;
        }
      }
      return line.slice(2);
    })
    .join("\n");
}

/** The memory-save row's opening, as the bridge writes it (ADR 0077). */
const REMEMBERED = "↳ remembered: ";

/**
 * What a memory-save row says was saved, or null for any other row. The
 * bridge writes that row with its body only — no digest, in every record
 * since memory_save existed — so it is known by its body.
 */
function rememberedFact(block: SystemBlock): string | null {
  const kind = block.digest?.kind;
  return (kind === undefined || kind === "text") &&
    block.body.startsWith(REMEMBERED)
    ? block.body.slice(REMEMBERED.length)
    : null;
}

/** Whether this is a memory-save row: the fold reads it as what was
 *  remembered (`foldedRunLine`), though it carries no digest. */
export function isRememberedRow(block: SystemBlock): boolean {
  return rememberedFact(block) !== null;
}

/** A stored document's name from its store path: no directory, no content
 *  hash, no `.txt`. */
function docName(path: string): string {
  const base = path.split(/[\\/]/u).pop() ?? path;
  return base.replace(/\.txt$/u, "").replace(/-[0-9a-f]{8}(?=\.)/u, "");
}

/**
 * One of 板砖's rows as she reads it, or null for a row with nothing for her
 * (a memory save's kind, a planning step, a routine command that printed
 * nothing). Attachment rows are the fold's (`compact-record.ts`); rows with
 * no structured digest — written before it existed, or harness notes —
 * keep their own text, except the memory save's, which never had one.
 */
export function systemRowForHerta(
  block: SystemBlock,
  lang: PromptLang,
): SystemBlock | null {
  const t = TEXTS[lang];
  const { evidenceDetail, ...rest } = block;
  const detail =
    evidenceDetail !== undefined && evidenceDetail.length > 0
      ? detailForHerta(evidenceDetail, lang, block.evidence ?? [])
      : undefined;
  const withDetail = (body: string): SystemBlock => ({
    ...rest,
    body,
    ...(detail !== undefined ? { evidenceDetail: detail } : {}),
  });

  // Its detail already dropped by the compaction (the note on its first
  // line; a hint line may follow): read in its folded form.
  const [first = "", ...after] = block.body.split("\n");
  if (
    block.digest?.kind !== "attachment" &&
    first.endsWith(elisionNote(lang))
  ) {
    const row = elidedRowForHerta({ ...block, body: first }, lang);
    return row === null
      ? null
      : { ...row, body: [row.body, ...after].join("\n") };
  }

  if (block.role === "done-marker" && block.markerSummary !== undefined) {
    // The first line is the roll-up; anything after it is a note the
    // compaction added (the diff hint) and stays.
    const [, ...after] = block.body.split("\n");
    return withDetail([t.done(block.markerSummary), ...after].join("\n"));
  }
  if (block.role === "noop-marker") return { ...rest, body: t.noop };

  const fact = rememberedFact(block);
  if (fact !== null) return { ...rest, body: `${t.remembered}${fact}` };

  const d = block.digest;
  if (d === undefined) return block;
  // A page step's result row says what came of it whole — the page, the
  // element, the error — so its op row says nothing more (ADR 0083 §10).
  if (isPageDigest(d))
    return { ...rest, body: pageRowForHerta(block, d, lang) };
  if (d.kind === "server")
    return { ...rest, body: serverRowForHerta(block, d, lang) };
  switch (d.kind) {
    case "op": {
      if (isBrowserOpVerb(d.verb) || isServerOpVerb(d.verb)) return null;
      const verb = t.verb[d.verb];
      if (verb === null) return null;
      const arg = opArg(d.verb, d.arg, lang);
      return withDetail(joinStep(verb ?? d.verb, arg));
    }
    case "text": {
      if (d.exitCode !== undefined) {
        const lines: string[] = [];
        if (d.exitCode !== 0) lines.push(t.exitCode(String(d.exitCode)));
        if (detail !== undefined) lines.push(detail);
        return lines.length > 0 ? { ...rest, body: lines.join("\n") } : null;
      }
      return withDetail(block.body.replace(/^↳ /u, ""));
    }
    case "tests": {
      const summary = d.summary
        .replace(/\bexit \d+,?\s*/u, "")
        .replace(/,?\s*[\d.]+s\b/u, "")
        .trim();
      return withDetail(
        `${t.tests[d.status]}${summary.length > 0 ? t.aside(summary) : ""}`,
      );
    }
    case "patch": {
      const [, ...diff] = block.body.split("\n");
      return withDetail(
        [t.change(d.files.join(t.listJoin), d.add, d.del), ...diff].join("\n"),
      );
    }
    case "excerpt":
      // The detail opens with its own header; the body only repeated it.
      return detail !== undefined
        ? { ...rest, body: namePages(detail, lang) }
        : { ...rest, body: namePages(t.excerpt(d.path, d.from, d.to), lang) };
    case "finding":
      return withDetail(namePages(t.finding(d.claim, d.cites), lang));
    case "search": {
      // The detail opens with its header, which the body now says.
      const lines = (detail ?? "").split("\n");
      const items = lines[0] === t.matches(d.pattern) ? lines.slice(1) : lines;
      return {
        ...rest,
        body: [t.search(d.pattern, d.matches, d.files), ...items]
          .filter((l) => l.length > 0)
          .join("\n"),
      };
    }
    case "tool-fail":
      return withDetail(t.toolFail(d.tool, d.message ?? ""));
    case "bg":
      return withDetail(t.bg(d.id, d.state, d.exitCode));
    case "digest":
      return withDetail(t.digest(docName(d.source), d.chunks, d.cached));
    case "web-search": {
      // Rebuilt from the structured list: the detail line names no URL, and
      // her view never does.
      const items = d.results.map((r) => `- ${r.title}${t.aside(r.site)}`);
      return {
        ...rest,
        body: [t.webResults(d.results.length), ...items].join("\n"),
      };
    }
    case "web-fetch": {
      // The opening without the detail's header line, which names the URL
      // and the stored path — bookkeeping in her notes.
      const page = block.evidence?.find((e) => e.kind === "web-page");
      const text = page?.kind === "web-page" ? page.text : "";
      return {
        ...rest,
        body: [t.webPage(d.host, d.title), ...(text !== "" ? [text] : [])].join(
          "\n",
        ),
      };
    }
    default:
      return block;
  }
}

/** A step's argument as she reads it: a command in backticks, a query
 *  quoted, a page as its host — never a URL (ADR 0080 §5) — and a range in
 *  words. */
function opArg(verb: string, arg: string, lang: PromptLang): string {
  if (verb === "Running") return `\`${arg}\``;
  if (verb === "Searching the web") return TEXTS[lang].query(arg);
  if (verb === "Reading web page") return hostOf(arg);
  return namePages(citeRanges(arg, lang), lang);
}

/** A page `web_fetch` stored (`.herta/web/<host>-<hash>.md`), named as the
 *  site's page — the stored path is bookkeeping in her notes (ADR 0080 §5).
 *  A command keeps its words: it is quoted as 板砖 ran it. */
const STORED_PAGE = /\.herta[\\/]web[\\/]([a-z0-9.-]+?)-[0-9a-f]{8}\.md/gu;

/** What a page step stored (`.herta/browser/<session>/shot-3.png`, a whole
 *  tree's `snap-2.txt`), named as what it is: a finding that cites a
 *  screenshot cites "screenshot 3" in her notes (ADR 0083 §10). */
const STORED_SHOT =
  /\.herta[\\/]browser[\\/][^\\/\s，,；;）)]+[\\/](shot|snap)-(\d+)\.(?:png|txt)/gu;

function namePages(text: string, lang: PromptLang): string {
  return text
    .replace(STORED_PAGE, (_m, host: string) =>
      lang === "en" ? `the ${host} page` : `网页 ${host}`,
    )
    .replace(STORED_SHOT, (_m, kind: string, n: string) =>
      kind === "shot"
        ? lang === "en"
          ? `screenshot ${n}`
          : `截图 ${n}`
        : lang === "en"
          ? `page snapshot ${n}`
          : `页面快照 ${n}`,
    );
}

/** A verb and its argument; a 「quoted」 argument sits against the verb, as
 *  Chinese writes it. */
function joinStep(verb: string, arg: string): string {
  return `${verb}${arg.startsWith("「") ? "" : " "}${arg}`.trim();
}

/** A URL's host, or the text itself when it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Why a step failed, in plain words, for the folded line — the tool's own
 *  message is written for 板砖 and stays in the fresh row. */
const FAIL_REASON: Record<PromptLang, Record<string, string>> = {
  zh: {
    invalid_input: "参数不对",
    command_blocked: "命令被拦下了",
    path_denied: "碰到了受保护的路径",
    path_outside_workspace: "路径在工作区外",
    not_found: "找不到",
    read_failed: "读不出来",
    spawn_failed: "启动不了",
    parse_failed: "解析失败",
    file_too_large: "文件太大",
    too_large: "太大",
    binary_file: "是二进制文件",
    timeout: "超时了",
    git_timeout: "git 超时了",
    git_failed: "git 出错了",
    not_a_repo: "不是 git 仓库",
    invalid_pattern: "搜索模式写错了",
    stale_read: "文件读过之后又被改了",
    url_refused: "这个网址没放出去",
    web_rejected: "网站那边不让读",
    web_unavailable: "联网服务没回应",
    web_balance: "DeepSeek 账户没余额了",
    web_auth: "DeepSeek 的密钥被拒了",
    // The editors' and the other tools' own codes (release review
    // 2026-10-22: a stale hunk folded to 「这一步没成」 with no cause).
    hunk_not_found: "要改的那段在文件里没找到",
    edit_not_found: "要改的那段在文件里没找到",
    hunk_ambiguous: "要改的那段在文件里不止一处",
    edit_ambiguous: "要改的那段在文件里不止一处",
    hunk_overlap: "几处改动重叠了",
    read_required: "改之前没先把文件读完",
    file_exists: "文件已经存在",
    parent_invalid: "上级目录用不了",
    insert_out_of_range: "插入的位置超出了文件",
    path_not_absolute: "路径不是绝对路径",
    write_failed: "写不进去",
    unavailable: "暂时用不了",
    tool_crashed: "工具自己出了错",
    malformed_tool_args: "参数格式坏了",
    not_an_attachment: "那不是附件",
    invalid_cite: "引用的位置对不上",
    findings_cap: "结论记得太多了",
    digest_failed: "通读失败",
    permission_failed: "权限检查出了错",
    // The page steps (ADR 0083 §10).
    browser_no_page: "还没有打开页面",
    browser_off_loopback: "这个地址不在本机",
    browser_scheme: "这种地址打不开",
    stale_ref: "页面变了，那个元素已经对不上",
    browser_no_ref: "页面上没有那个元素",
    browser_timeout: "页面没在 15 秒内打开",
    browser_load_failed: "那个地址没有回应",
    browser_password_refused: "密码只在本机的页面上输入",
    browser_unavailable: "页面不在了",
    // The launcher (ADR 0083 §5, §10).
    no_launch_file: "工作区里没有 herta.launch.json",
    bad_launch_file: "herta.launch.json 写得不对",
    no_server_entry: "herta.launch.json 里没有这个服务器",
    server_spawn_failed: "服务器启动不了",
    server_exited: "服务器还没起来就退出了",
    server_timeout: "服务器 60 秒内没起来",
    server_aborted: "启动半路被停下了",
    server_not_running: "那个服务器没在跑",
    unsafe_shim_arg: "参数里有 Windows 不能安全传过去的字符",
  },
  en: {
    invalid_input: "bad arguments",
    command_blocked: "the command was blocked",
    path_denied: "a protected path",
    path_outside_workspace: "a path outside the workspace",
    not_found: "not found",
    read_failed: "could not read it",
    spawn_failed: "could not start it",
    parse_failed: "could not parse it",
    file_too_large: "the file is too large",
    too_large: "too large",
    binary_file: "a binary file",
    timeout: "timed out",
    git_timeout: "git timed out",
    git_failed: "git failed",
    not_a_repo: "not a git repository",
    invalid_pattern: "a bad search pattern",
    stale_read: "the file changed after it was read",
    url_refused: "the URL was not sent",
    web_rejected: "the site would not be read",
    web_unavailable: "the web service did not answer",
    web_balance: "the DeepSeek account is out of credit",
    web_auth: "the DeepSeek key was refused",
    hunk_not_found: "the text to change was not in the file",
    edit_not_found: "the text to change was not in the file",
    hunk_ambiguous: "the text to change was in the file more than once",
    edit_ambiguous: "the text to change was in the file more than once",
    hunk_overlap: "the changes overlapped",
    read_required: "the file was not read in full first",
    file_exists: "the file already exists",
    parent_invalid: "the folder above it is not usable",
    insert_out_of_range: "the insert point is past the end of the file",
    path_not_absolute: "the path was not absolute",
    write_failed: "could not write it",
    unavailable: "unavailable for now",
    tool_crashed: "the tool itself failed",
    malformed_tool_args: "the arguments were malformed",
    not_an_attachment: "that is not an attachment",
    invalid_cite: "a citation pointed at nothing",
    findings_cap: "too many findings recorded",
    digest_failed: "the read-through failed",
    permission_failed: "the permission check failed",
    browser_no_page: "no page was open yet",
    browser_off_loopback: "that address is not on this machine",
    browser_scheme: "that kind of address does not open",
    stale_ref: "the page changed, and that element no longer matches",
    browser_no_ref: "the page has no such element",
    browser_timeout: "the page did not open within 15 seconds",
    browser_load_failed: "nothing answered at that address",
    browser_password_refused:
      "a password is typed only on this machine's pages",
    browser_unavailable: "the page went away",
    no_launch_file: "there is no herta.launch.json in the workspace",
    bad_launch_file: "herta.launch.json is malformed",
    no_server_entry: "herta.launch.json names no such server",
    server_spawn_failed: "the server could not be started",
    server_exited: "the server exited before it was up",
    server_timeout: "the server was not up within 60 seconds",
    server_aborted: "the start was stopped half-way",
    server_not_running: "that server is not running",
    unsafe_shim_arg: "an argument cannot pass safely through Windows",
  },
};

/** A row's first line, cut at 60 characters with the cut marked. */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length <= 60 ? line : `${line.slice(0, 59)}…`;
}

/** What a folded row says it no longer holds: its text (an excerpt, a
 *  search's lines), a model's summary, or detail in general. */
const NOT_AT_HAND: Record<
  PromptLang,
  Record<"text" | "summary" | "detail", string>
> = {
  zh: { text: "原文不在手边", summary: "摘要不在手边", detail: "细节不在手边" },
  en: {
    text: "not at hand",
    summary: "summary not at hand",
    detail: "details not at hand",
  },
};

/**
 * One of 板砖's rows folded into a line (ADR 0079 §2): what was done and what
 * came of it — changes, results, findings, failures, what was remembered,
 * what she was shown — never how. Null leaves the row out: a step, or a
 * command that came back fine. `lastCommand` is the command a result row
 * answers (they are separate rows), so a failure names what failed.
 */
export function foldedRunLine(
  block: SystemBlock,
  lang: PromptLang,
  lastCommand?: string,
): string | null {
  const t = TEXTS[lang];
  const gone = NOT_AT_HAND[lang];
  if (block.role === "done-marker" && block.markerSummary !== undefined) {
    return t.done(block.markerSummary);
  }
  if (block.role === "noop-marker") return t.noop;
  const fact = rememberedFact(block);
  if (fact !== null) return `${t.remembered}${fact}`;
  const d = block.digest;
  if (d === undefined) return null;
  if (isPageDigest(d)) return pageFoldLine(d, lang);
  if (d.kind === "server") return serverFoldLine(d, lang);
  switch (d.kind) {
    case "op":
      return null;
    case "text":
      if (d.exitCode !== undefined) {
        if (d.exitCode === 0) return null;
        // The receipt's own form, as a line of its own: `Ran …`, where
        // `Based on: ran …` keeps it in lower case.
        return lastCommand !== undefined
          ? opening(t.ran(lastCommand, String(d.exitCode)))
          : t.exitCode(String(d.exitCode));
      }
      return firstLine(d.text.replace(/^↳ /u, ""));
    case "tests": {
      const summary = d.summary
        .replace(/\bexit \d+,?\s*/u, "")
        .replace(/,?\s*[\d.]+s\b/u, "")
        .trim();
      return `${t.tests[d.status]}${summary.length > 0 ? t.aside(summary) : ""}`;
    }
    case "patch":
      return t.change(d.files.join(t.listJoin), d.add, d.del);
    case "excerpt":
      return namePages(
        lang === "en"
          ? `Was shown ${t.cite(d.path, d.from, d.to)}${t.aside(gone.text)}`
          : `看过 ${t.cite(d.path, d.from, d.to)}${t.aside(gone.text)}`,
        lang,
      );
    case "finding":
      return namePages(t.finding(d.claim, d.cites), lang);
    case "search":
      return `${t.search(d.pattern, d.matches, d.files)}${t.aside(gone.text)}`;
    case "tool-fail":
      return t.toolFail(d.tool, FAIL_REASON[lang][d.code] ?? "");
    case "bg":
      // A command still running in the background is worth remembering.
      return t.bg(d.id, d.state, d.exitCode);
    case "digest":
      return `${t.digest(docName(d.source), d.chunks, d.cached)}${t.aside(gone.summary)}`;
    case "web-search":
      return t.webSearched(d.query, d.results.length);
    case "web-fetch":
      return `${t.webRead(d.host, d.title)}${t.aside(gone.text)}`;
    case "undo": {
      const back = d.files
        .filter((f) => f.result === "restored" || f.result === "deleted")
        .map((f) => f.path);
      const left = d.files
        .filter(
          (f) =>
            f.result !== "restored" &&
            f.result !== "deleted" &&
            f.result !== "unchanged",
        )
        .map((f) => f.path);
      const zh = lang !== "en";
      const parts = [
        zh
          ? `撤销了这一轮的改动${back.length > 0 ? `：${back.join("、")}` : "，没有要还原的"}`
          : `Undid the turn's edits${back.length > 0 ? `: ${back.join(", ")}` : ", nothing to restore"}`,
        ...(left.length > 0
          ? [
              zh
                ? `没还原：${left.join("、")}`
                : `not restored: ${left.join(", ")}`,
            ]
          : []),
        ...(d.commands.length > 0
          ? [
              zh
                ? `命令改的没撤：${d.commands.join("、")}`
                : `changed by commands, not undone: ${d.commands.join(", ")}`,
            ]
          : d.commandsUnknown
            ? [
                zh
                  ? "这一轮还跑过命令，它们改的（如果有）没撤"
                  : "commands ran; their changes, if any, not undone",
              ]
            : []),
      ];
      return parts.join(zh ? "；" : "; ");
    }
    default:
      return null;
  }
}

/** A phrase as the opening of a line: its first letter a capital. */
function opening(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * An excerpt folded while its lines are still in front of her — the
 * done-marker passed through in her verdict turn shows them
 * (`compactRecordForPrompt`): the read, `读 a.ts 第 5–6 行`, never
 * 「原文不在手边」 directly above the lines it says are not at hand. The lab
 * found that pairing teaches her to recite what a fold says she cannot see
 * (ADR 0079 §3). Null for any other row.
 */
export function shownExcerptLine(
  block: SystemBlock,
  lang: PromptLang,
): string | null {
  const d = block.digest;
  return d?.kind === "excerpt"
    ? TEXTS[lang].readExcerpt(d.path, d.from, d.to)
    : null;
}

/**
 * A run with no outcome to report — 板砖 only looked around — still says
 * what it did, so the summary is never empty: its steps, consecutive ones
 * of a kind as one line (`读 a.ts、b.ts`).
 */
export function foldedStepLines(
  blocks: readonly SystemBlock[],
  lang: PromptLang,
): string[] {
  const t = TEXTS[lang];
  const steps: { verb: string; args: string[] }[] = [];
  for (const block of blocks) {
    const d = block.digest;
    if (d?.kind !== "op") continue;
    const verb = t.verb[d.verb];
    if (verb === null || verb === undefined) continue;
    const arg = opArg(d.verb, d.arg, lang);
    const last = steps[steps.length - 1];
    if (last !== undefined && last.verb === verb && d.verb !== "Running") {
      last.args.push(arg);
    } else {
      steps.push({ verb, args: [arg] });
    }
  }
  return steps.map((s) => joinStep(s.verb, s.args.join(t.listJoin)));
}

/** The note the compaction appends to a row whose detail it dropped. */
export function elisionNote(lang: PromptLang): string {
  return lang === "en" ? " · body elided" : " · 正文已略去";
}

/**
 * A row as she reads it once its detail has been dropped (the compaction's
 * stranded-detail fold): its folded line, and for a done-marker the plain
 * note that the detail is not at hand. Null leaves it out.
 */
export function elidedRowForHerta(
  block: SystemBlock,
  lang: PromptLang,
): SystemBlock | null {
  const note = elisionNote(lang);
  const bare: SystemBlock = {
    ...block,
    body: block.body.slice(0, -note.length),
  };
  const line = foldedRunLine(bare, lang);
  if (line === null) return null;
  const { evidenceDetail: _detail, ...rest } = block;
  return block.role === "done-marker"
    ? { ...rest, body: `${line}${TEXTS[lang].aside(NOT_AT_HAND[lang].detail)}` }
    : { ...rest, body: line };
}

/**
 * A user message as Herta reads it (ADR 0072 amendment 2026-10-20): each path
 * the user mentioned with the composer's `@` by its file or folder name —
 * the chip the user saw, never the path. 板砖 reads the message as written
 * (`backend-user-history.ts`), so the path still reaches the one who opens
 * the file. A backticked path (one with whitespace) keeps its ticks.
 */
export function nameMentionedPaths(
  text: string,
  mentions: readonly string[] | undefined,
): string {
  if (mentions === undefined || mentions.length === 0) return text;
  let out = text;
  // Longest first, so `a/b.ts` never cuts into `a/b.ts.map`'s mention.
  for (const path of [...mentions].sort((a, b) => b.length - a.length)) {
    const name = path.replace(/\/+$/u, "").split("/").pop() ?? path;
    if (name === path || name.length === 0) continue;
    out = out.split(`\`${path}\``).join(`\`${name}\``);
    out = out.replace(
      new RegExp(`(^|[^\\w./-])${escapeRegExp(path)}(?![\\w./-])`, "gu"),
      (_m, lead: string) => `${lead}${name}`,
    );
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
