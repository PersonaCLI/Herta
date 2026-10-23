import type { MessageKey } from "../../i18n/keys.js";
import type { SystemBlock } from "./group-record.js";

type CutoffOutcome = Extract<
  NonNullable<SystemBlock["evidence"]>[number],
  { kind: "cutoff" }
>["steps"][number]["outcome"];

/** The crash marker's outcome words (ADR 0071 §1.2), by outcome. */
const CUTOFF_KEY: Record<CutoffOutcome, MessageKey> = {
  not_started: "evidence.cutoff.notStarted",
  read_interrupted: "evidence.cutoff.readInterrupted",
  write_applied: "evidence.cutoff.writeApplied",
  write_not_applied: "evidence.cutoff.writeNotApplied",
  write_changed_since: "evidence.cutoff.writeChangedSince",
  state_not_applied: "evidence.cutoff.stateNotApplied",
  outcome_unknown: "evidence.cutoff.outcomeUnknown",
};

/**
 * Shorten a filename from the MIDDLE for display (owner 2026-08-10: a long
 * name wrapped the attachment row onto three lines).
 *
 * Middle, not end: the extension is the most informative few characters in a
 * filename — `…-summary-20260806-超级无敌长的文件.txt` still reads as a text
 * file, `jiuwen-vs-aisf-sysagent-multi-inten…` does not. CSS `text-overflow`
 * can only cut the end, which is why this is done in JS.
 *
 * Display-only (D7): the record body, the digest and Herta's prompt all keep
 * the real name — she must be able to say which file, and 板砖 resolves the
 * path, not this. The full name also stays visible in the evidence pane's
 * `↳ 附件 <name>` header, which wraps freely.
 *
 * Budget is in CHARACTERS, not measured width. A CJK name is wider per
 * character, so this under-fills rather than over-fills for those — the safe
 * direction, and it keeps the function pure and testable.
 */
export function middleTruncateName(name: string, max = 44): string {
  const chars = [...name]; // surrogate-safe: never split an emoji or CJK-ext
  if (chars.length <= max) return name;
  // Keep the extension whole when it is a plausible one; otherwise keep a
  // fixed tail so the end of the name is still recognisable.
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] ?? "";
  const tail = Math.max(ext.length, 8);
  const head = Math.max(4, max - tail - 1);
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/** Localized display verbs for projected op steps, keyed by the digest's
 *  harness-authored verb union. Exported for the rail 操作轨迹 card
 *  (2026-08-17), which renders the same verbs outside a record row. */
export const VERB_KEY: Record<string, MessageKey> = {
  Reading: "activity.verb.reading",
  Writing: "activity.verb.writing",
  Running: "activity.verb.running",
  Inspecting: "activity.verb.inspecting",
  "Saving memory": "activity.verb.savingMemory",
  Searching: "activity.verb.searching",
  Stopping: "activity.verb.stopping",
  Digesting: "activity.verb.digesting",
  "Searching the web": "activity.verb.searchingWeb",
  "Reading web page": "activity.verb.readingWeb",
  // The page steps (ADR 0083 §10).
  "Opening page": "activity.verb.openingPage",
  "Reading page": "activity.verb.readingPage",
  "Finding on page": "activity.verb.findingOnPage",
  "Reading console": "activity.verb.readingConsole",
  "Reading network": "activity.verb.readingNetwork",
  Clicking: "activity.verb.clicking",
  Typing: "activity.verb.typing",
  Pressing: "activity.verb.pressing",
  Scrolling: "activity.verb.scrolling",
  Choosing: "activity.verb.choosing",
  "Resizing page": "activity.verb.resizingPage",
  "Taking screenshot": "activity.verb.takingScreenshot",
};

type PageDigest = Extract<
  NonNullable<SystemBlock["digest"]>,
  { kind: "page-open" | "page-read" | "page-act" | "page-shot" }
>;

/** `N word`, the count localized. */
const counted = (n: number, word: string): string =>
  `${n.toLocaleString()} ${word}`;

/**
 * A page step's result row (ADR 0083 §10), localized from its digest. The
 * page's own words — its route, title, element names — and what 板砖 typed
 * are data and stay verbatim; only the chrome translates.
 */
function pageStepBody(d: PageDigest, t: (key: MessageKey) => string): string {
  const errors = (n: number): string[] =>
    n > 0 ? [counted(n, t("activity.result.consoleErrors"))] : [];
  switch (d.kind) {
    case "page-open":
      return [
        `↳ ${d.route}`,
        ...(d.title !== "" ? [d.title] : []),
        ...(d.status !== null && d.status >= 400 ? [`HTTP ${d.status}`] : []),
        ...errors(d.errors),
      ].join(" · ");
    case "page-read":
      switch (d.mode) {
        case "tree":
          return `↳ ${counted(d.count, t("activity.result.elements"))}`;
        case "find":
          return `↳ ${counted(d.count, t("activity.result.elements"))} · "${d.query ?? ""}"`;
        case "text":
          return `↳ ${counted(d.count, t("activity.attachment.chars"))}`;
        case "console":
          return `↳ ${counted(d.count, t("activity.result.messages"))} · ${counted(d.failures ?? 0, t("activity.result.errors"))}`;
        case "network":
          return `↳ ${counted(d.count, t("activity.result.requests"))} · ${counted(d.failures ?? 0, t("activity.result.failedRequests"))}`;
      }
      return `↳ ${d.route}`;
    case "page-act": {
      const target = d.target ?? "";
      let what: string;
      switch (d.action) {
        case "click":
          what =
            d.target !== undefined
              ? t("activity.page.click").replace("{target}", target)
              : t("activity.page.clickPoint");
          break;
        case "type":
          what = (
            d.target !== undefined
              ? t("activity.page.type").replace("{target}", target)
              : t("activity.page.typeBare")
          ).replace("{text}", `"${d.typed ?? ""}"`);
          if (d.submit === true) what += t("activity.page.submit");
          break;
        case "key":
          what = t("activity.page.key").replace("{key}", d.key ?? "");
          break;
        case "scroll":
          what =
            d.direction === "up"
              ? t("activity.page.scrollUp")
              : t("activity.page.scrollDown");
          break;
        case "select":
          what =
            d.value !== undefined
              ? t("activity.page.select")
                  .replace("{target}", target)
                  .replace("{value}", `"${d.value}"`)
              : t("activity.page.toggle").replace("{target}", target);
          break;
        case "resize":
          what = [
            t(`activity.page.resize.${d.preset ?? "desktop"}`),
            ...(d.scheme !== undefined ? [t(`activity.page.${d.scheme}`)] : []),
          ].join(" · ");
          break;
      }
      return [
        `↳ ${what}${d.navigated ? ` → ${d.route}` : ""}`,
        ...(d.hit !== undefined
          ? [t("activity.page.landed").replace("{hit}", d.hit)]
          : []),
        ...errors(d.errors),
      ].join(" · ");
    }
    case "page-shot":
      return [
        `↳ ${d.route}`,
        ...(d.region ? [t("activity.page.region")] : []),
        `${d.width}×${d.height}`,
      ].join(" · ");
  }
}

/**
 * Display body for one activity step (2026-07-10: the projected chrome —
 * verbs, result labels — is always English regardless of locale). Every
 * branch localizes from the STRUCTURED digest — D7: display-only, the
 * canonical record body keeps its English chrome (that is what Herta's
 * prompt reads, and what icon parsing keys on). Anything without the
 * structured data — records persisted before the digest fields existed,
 * signal/timeout exits, patch previews without a skip digest — renders the
 * canonical body verbatim.
 */
export function stepDisplayBody(
  block: SystemBlock,
  t: (key: MessageKey) => string,
): string {
  const d = block.digest;
  if (d === undefined) return block.body;
  switch (d.kind) {
    case "op": {
      const key = VERB_KEY[d.verb];
      return key !== undefined ? `${t(key)} ${d.arg}`.trim() : block.body;
    }
    case "tests":
      // "↳ tests: 3 passed" → "↳ 测试: 3 passed" (summary is tool output —
      // data, not chrome).
      return `↳ ${t("activity.result.tests")}: ${d.summary}`;
    case "tool-fail":
      // Message rides the digest since 2026-07-10; without it (older
      // records) a digest-only render would DROP it — fall back to the body.
      return d.message !== undefined
        ? `↳ ${d.tool} ${t("activity.result.failed")}: ${d.code}: ${d.message}`
        : block.body;
    case "bg": {
      // "↳ background bg-1: running" → "↳ 后台 bg-1：运行中" etc. A null
      // exitCode on an exited row means signal/kill — never a literal null.
      const state =
        d.state === "running"
          ? t("activity.bg.running")
          : d.state === "stopped"
            ? t("activity.bg.stopped")
            : d.exitCode === null || d.exitCode === undefined
              ? `${t("activity.bg.exited")} (${t("activity.bg.signal")})`
              : `${t("activity.bg.exited")} (${d.exitCode})`;
      return `↳ ${t("activity.bg.label")} ${d.id}: ${state}`;
    }
    case "finding":
      // "↳ finding: <claim> — cites" → "↳ 结论: <claim> — cites" (ADR 0039).
      // The claim and cites are backend-authored data, verbatim.
      return `↳ ${t("activity.result.finding")}: ${d.claim}${
        d.cites.length > 0 ? ` — ${d.cites.join(", ")}` : ""
      }`;
    case "search": {
      // "↳ 5 matches in 1 files" → "↳ 5 处匹配 · 1 个文件" (2026-08-17). The
      // pattern is data and stays out of the row (it is in the detail pane).
      const trunc = d.truncated ? ` (${t("activity.result.truncated")})` : "";
      if (d.matches === 0) {
        return `↳ 0 ${t("activity.result.matches")}${trunc}`;
      }
      return `↳ ${d.matches} ${t("activity.result.matches")} · ${d.files} ${t(
        "activity.result.files",
      )}${trunc}`;
    }
    case "text":
      // Exit rows carry structured numbers since 2026-07-10; other text
      // digests (and signal/timeout exits) fall back to the body.
      return d.exitCode !== undefined &&
        d.exitCode !== null &&
        d.lineCount !== undefined
        ? `↳ ${t("activity.result.exit")} ${d.exitCode} · ${d.lineCount} ${t(
            "activity.result.lines",
          )}`
        : block.body;
    case "attachment": {
      // Composed wholly from the digest, so the canonical CN body is never
      // parsed (ADR 0018's pattern). The filename is the user's own data, not
      // chrome, so it is never TRANSLATED — only shortened for the row
      // (see middleTruncateName); the record keeps it whole.
      const label = t("activity.attachment.label");
      const name = middleTruncateName(d.name);
      // A PDF / Word document (ADR 0038) is named as such, with its page
      // count, before anything else — the same order as the canonical body,
      // and for the same reason: the stored path ends in `.pdf.txt` and must
      // never read as a text file the user typed.
      const doc: string[] = [];
      if (d.format !== undefined) {
        doc.push(t(`activity.attachment.format.${d.format}`));
        if (d.pages !== undefined) {
          doc.push(
            `${d.pages.toLocaleString()} ${t("activity.attachment.pages")}`,
          );
        }
      }
      // An image (ADR 0048) names its format and pixel size where a document
      // names its pages — the facts the row states without reading anything.
      if (d.image !== undefined) {
        doc.push(
          t("activity.attachment.image").replace(
            "{f}",
            d.image.format.toUpperCase(),
          ),
        );
        if (d.image.width !== undefined && d.image.height !== undefined) {
          doc.push(`${d.image.width}×${d.image.height}`);
        }
      }
      const head = [`${label} ${name}`, ...doc].join(" · ");
      // The outline count (2026-08-23) shows in both states, as in the
      // canonical body: for an over-cap document it is the one thing the
      // row can say about what is inside.
      const outline =
        d.outline !== undefined
          ? [
              t("activity.attachment.outline").replace(
                "{n}",
                d.outline.entries.toLocaleString(),
              ),
            ]
          : [];
      if (d.unreadable !== undefined) {
        const isDoc = d.format !== undefined;
        const isImage = d.image !== undefined;
        const stored = d.path.length > 0;
        const why =
          d.unreadable === "binary"
            ? t("activity.attachment.unreadable.binary")
            : d.unreadable === "no_caption"
              ? t("activity.attachment.unreadable.noCaption")
              : d.unreadable === "too_large"
                ? // Four meanings by context (mirrors app-server's reasonFor):
                  // an image over the caption ceiling, stored but unread; a
                  // stored text file over the excerpt cap; a PDF over the page
                  // cap, refused whole; an extracted document whose text is
                  // over the char cap, stored in full.
                  isImage
                  ? t("activity.attachment.unreadable.imageTooLarge")
                  : !isDoc
                    ? t("activity.attachment.unreadable.tooLarge")
                    : stored
                      ? t("activity.attachment.unreadable.textTooLong")
                      : t("activity.attachment.unreadable.tooManyPages")
                : d.unreadable === "empty"
                  ? d.format === "pdf"
                    ? t("activity.attachment.unreadable.scanned")
                    : t("activity.attachment.unreadable.empty")
                  : d.unreadable === "denied"
                    ? t("activity.attachment.unreadable.denied")
                    : d.unreadable === "removed"
                      ? t("activity.attachment.unreadable.removed")
                      : d.unreadable === "encrypted"
                        ? t("activity.attachment.unreadable.encrypted")
                        : d.unreadable === "unsupported"
                          ? t("activity.attachment.unreadable.unsupported")
                          : t("activity.attachment.unreadable.readError");
        return [head, why, ...outline].join(" · ");
      }
      // An image's content line is its CAPTION, not a line/char count it has
      // neither of (ADR 0048 §1). The caption is instrument-authored text
      // about the user's picture — data, shown verbatim like a finding's
      // claim, never translated.
      if (d.image !== undefined) {
        return d.caption !== undefined ? `${head} · ${d.caption}` : head;
      }
      const lines = `${d.lines.toLocaleString()} ${t("activity.result.lines")}`;
      const chars = `${d.chars.toLocaleString()} ${t("activity.attachment.chars")}`;
      const extracted =
        d.format !== undefined ? [t("activity.attachment.extracted")] : [];
      return [head, ...extracted, lines, chars, ...outline].join(" · ");
    }
    case "web-search":
      // "↳ web results: 8" → "↳ 8 条结果" (ADR 0080). The titles are in the
      // detail pane.
      return d.results.length === 0
        ? `↳ ${t("activity.result.webNone")}`
        : `↳ ${d.results.length} ${t("activity.result.webResults")}`;
    case "web-fetch":
      // The host is the click target that opens the stored page; the title
      // is the page's own words, verbatim.
      return [
        `↳ ${t("activity.result.page")} ${d.host}`,
        ...(d.title !== "" ? [d.title] : []),
        `${d.chars.toLocaleString()} ${t("activity.attachment.chars")}`,
      ].join(" · ");
    case "page-open":
    case "page-read":
    case "page-act":
    case "page-shot":
      return pageStepBody(d, t);
    case "digest":
      // "↳ digest <path> · 27 chunks (cached)" → localized chrome; the path is
      // data (ADR 0043).
      return `↳ ${t("activity.result.digest")} ${d.path} · ${d.chunks} ${t(
        "activity.result.chunks",
      )}${d.cached ? ` (${t("activity.result.cached")})` : ""}`;
    case "patch": {
      // The magnitude row (2026-08-25). A write was the ONE operation with no
      // `↳` outcome row — every other one answers itself (`↳ 5 处匹配 · 1 个
      // 文件`, `↳ 测试: 3 passed`), and a patch said only "patch preview:
      // <files>", which is a restatement of the Writing row above it.
      //
      // Since 2026-08-25 evening a preview normally FOLDS into the write it
      // previews (`activityRows`), so this renders only the standalone case:
      // a DENIED edit, previewed but never written. The diff body still rides
      // this block, so the existing expander opens it; only the headline
      // changes.
      //
      // Counts absent → an empty preview. The canonical first line
      // (`patch preview: <files>`) is left alone: it at least names the file,
      // where a sentence about the absence of a number would not (owner,
      // 2026-08-25 evening).
      if (d.add === undefined || d.del === undefined) return block.body;
      const nl = block.body.indexOf("\n");
      const head = `↳ +${d.add} −${d.del}`;
      return nl >= 0 ? `${head}${block.body.slice(nl)}` : head;
    }
    case "skip":
      // Pre-2026-08-25 records: the patch preview was the only skip producer.
      // Localize its first-line label, keep the files + diff fence verbatim
      // (the collapsible diff body must stay untouched).
      if (block.body.startsWith("patch preview:")) {
        return `${t("activity.step.patchPreview")}:${block.body.slice(
          "patch preview:".length,
        )}`;
      }
      return block.body;
    default:
      return block.body;
  }
}

/**
 * Display text for a block's evidence detail — the pane behind 展开明细 /
 * "show detail".
 *
 * Composed from the STRUCTURED `evidence` sections, for the same reason every
 * other row localizes from its digest: the canonical `evidenceDetail` string
 * is the record, it is what Herta's prompt reads, and per ADR 0018 it stays
 * Chinese in every language — so an English session used to open this pane on
 * `↳ 输出:` / `↳ 摘录` / `↳ 改动文件:`. Only the section LABEL is translated;
 * command output, excerpt bodies, paths, risks and todos are backend-authored
 * data and stay verbatim.
 *
 * Falls back to the canonical string for records persisted before `evidence`
 * existed (and for any block that carries a detail but no sections).
 */
export function stepDisplayDetail(
  block: SystemBlock,
  t: (key: MessageKey) => string,
): string | undefined {
  const sections = block.evidence;
  if (sections === undefined || sections.length === 0) {
    return block.evidenceDetail;
  }
  return sections
    .map((s) => {
      switch (s.kind) {
        case "output":
          return `↳ ${t("evidence.output")}:\n${s.text}`;
        case "excerpt":
          return `↳ ${t("evidence.excerpt")} ${s.path}:${s.from}-${s.to}\n${s.text}`;
        case "files":
          return `↳ ${t("evidence.files")}: ${s.paths.join(", ")}`;
        case "risks":
          return `↳ ${t("evidence.risks")}: ${s.items.join("; ")}`;
        case "todos":
          return `↳ ${t("evidence.todos")}: ${s.items.join("; ")}`;
        case "evidence":
          return `↳ ${t("evidence.evidence")}: ${s.items.join("; ")}`;
        case "findings":
          return `↳ ${t("evidence.findings")}: ${s.items.join("; ")}`;
        case "attachment": {
          // The clipped note is part of the evidence, not decoration: without
          // it a head excerpt reads as the entire document, to the user and
          // to anyone reading this pane over their shoulder.
          const note = s.clipped ? `\n${t("evidence.attachment.clipped")}` : "";
          return `↳ ${t("evidence.attachment")} ${s.name}\n${s.text}${note}`;
        }
        case "outline": {
          // Same stance as the clipped note: a preview must say it is one.
          const shown =
            s.items.length < s.total
              ? ` ${t("evidence.outline.shown").replace("{n}", String(s.items.length))}`
              : "";
          return `↳ ${t("evidence.outline").replace("{n}", String(s.total))}${shown}\n${s.items.join("\n")}`;
        }
        case "digest":
          // The "model-generated" label is part of the evidence (ADR 0043):
          // without it a reader takes a flash précis for the document.
          return `↳ ${t("evidence.digest")
            .replace("{source}", s.source)
            .replace("{n}", String(s.chunks))
            .replace("{path}", s.path)}\n${s.text}`;
        case "matches": {
          // Same stance as the clipped note above: an omitted count is part
          // of the evidence, or the list reads as the whole result.
          const more =
            s.omitted > 0
              ? `\n${t("evidence.matches.omitted").replace("{n}", String(s.omitted))}`
              : "";
          return `↳ ${t("evidence.matches")} /${s.pattern}/:\n${s.items.join("\n")}${more}`;
        }
        case "web-results":
          // Each result's URL on its own line, where the row makes it a
          // link to the OS browser (ADR 0080 §5).
          return `↳ ${t("evidence.webResults")}:\n${s.items
            .map((i) => `- ${i.title}（${i.site}）\n  ${i.url}`)
            .join("\n")}`;
        case "web-page":
          return `↳ ${t("evidence.webPage")} ${s.title}\n${s.url}\n${s.text}`;
        case "page": {
          // A page step's read, bounded (ADR 0083 §10); what the bound left
          // out is counted, or the list reads as the whole page.
          const omitted =
            s.omitted > 0 && s.mode !== "text"
              ? `\n${t("evidence.page.omitted").replace("{n}", String(s.omitted))}`
              : "";
          return `↳ ${t(`evidence.page.${s.mode}`)}:\n${s.text}${omitted}`;
        }
        case "error":
          return `↳ ${t("evidence.error")}: ${s.message}`;
        case "hint":
          return `↳ ${t("evidence.hint")}: ${s.text}`;
        case "cutoff":
          // The steps are verbatim (a command, a path); only the outcome
          // words are the harness's, so they translate.
          return `↳ ${t("evidence.cutoff")}: ${s.steps
            .map((c) => `${c.step} — ${t(CUTOFF_KEY[c.outcome])}`)
            .join("; ")}`;
        default:
          // A section kind this renderer predates: fall back rather than drop
          // evidence on the floor.
          return block.evidenceDetail ?? "";
      }
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * The latest OPERATION step for the live status line (bug 3, 2026-07-10):
 * result rows ("↳ exit 1 · 0 lines", "↳ tests: …") read as a weird "current
 * activity" while the backend works — the op that produced them stays the
 * honest in-flight label until the next op starts. Result rows still show in
 * the expanded history. Falls back to the last step of any kind (a run whose
 * only rows so far are results), then undefined for an empty list.
 */
export function latestOpStep(
  steps: readonly SystemBlock[],
): SystemBlock | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const b = steps[i];
    if (b === undefined) continue;
    // A legacy todo row (records before ADR 0073) is never the live state.
    if (b.digest?.kind === "todo") continue;
    // Failures are headline-eligible (2026-07-23): a tool_crashed / failed
    // row IS the current state of the run — hiding it behind the last op
    // made crashes invisible until the history was expanded.
    if (
      b.digest?.kind === "op" ||
      b.digest?.kind === "tool-fail" ||
      !b.body.trimStart().startsWith("↳")
    ) {
      return b;
    }
  }
  return steps[steps.length - 1];
}
