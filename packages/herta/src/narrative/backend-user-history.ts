/**
 * The user-only replay 板砖 receives as task context (ADR 0025 slice 2,
 * ADR 0033/0038 for attachments): the newest message kept whole, older
 * ones under a message and char cap. Split out of backend-bridge.ts on
 * 2026-09-11 (the post-0.1.5 refactor pass); bodies moved unchanged.
 */
import type { TerminalRecord } from "@herta/core";
import type { PromptLang } from "./prompt-lang.js";

/** Caps for the user-message replay (ADR 0025 slice 2). Before these, the
 *  backend received EVERY user block in the session — the one unbounded
 *  context-growth vector on the input side (workingHistory and
 *  recentDialogue were already tightly capped). The newest message is the
 *  task and is always kept whole regardless of the char cap. */
const USER_HISTORY_MAX_MESSAGES = 24;
const USER_HISTORY_MAX_CHARS = 16_000;

export interface ExtractedUserMessages {
  readonly messages: ReadonlyArray<{ text: string }>;
  /** How many older user messages the caps elided (0 = complete replay). */
  readonly omitted: number;
}

/**
 * Harness-authored line telling 板砖 that a document arrived and where it is
 * (ADR 0033). Localized like the rest of the backend's own prose (ADR 0016);
 * the filename and path are data and stay verbatim in both.
 *
 * Three shapes, because the three states need different things from 板砖:
 * a readable file it should open, a stored-but-unexcerpted file it can still
 * search (binary / oversized), and a file that never landed at all.
 *
 * A PDF / Word document (ADR 0038) is named as such, with its page count, and
 * the line says the path holds EXTRACTED TEXT — otherwise a `.pdf.txt` path
 * beside a `report.pdf` name reads as a puzzle, and a coprocessor that goes
 * looking for the "real" PDF finds nothing. The not-on-disk shapes carry the
 * specific reason (scanned, encrypted, unsupported, over the page cap) so
 * 板砖 can tell the user what to do rather than diagnosing a read failure.
 */
export function attachmentTaskLine(
  d: {
    name: string;
    path: string;
    unreadable?: string;
    format?: "pdf" | "docx";
    pages?: number;
    pageMarker?: string;
    outline?: { path: string; entries: number };
  },
  lang: PromptLang,
): string {
  const en = lang === "en";
  const kind = d.format === "pdf" ? "PDF" : en ? "Word document" : "Word 文档";
  const pagesNote =
    d.pages !== undefined
      ? en
        ? `, ${d.pages} pages`
        : `，${d.pages} 页`
      : "";
  // "(PDF, 12 pages)" / "（PDF，12 页）" — empty for a plain text file.
  const docNote =
    d.format !== undefined
      ? en
        ? ` (${kind}${pagesNote})`
        : `（${kind}${pagesNote}）`
      : "";
  if (d.unreadable === "removed") {
    // Withdrawn on purpose. 板砖 must neither look for the file nor treat its
    // absence as a fault — and must not act on a document the user took back.
    return en
      ? `[attachment] The Trailblazer provided a file (${d.name}) and then WITHDREW it. It is gone from disk — do not look for it, and do not act on its contents.`
      : `〔附件〕开拓者曾提供文件（${d.name}），随后又撤回了它。文件已从磁盘删除——不要去找它，也不要再依据它的内容行事。`;
  }
  if (d.unreadable === "denied") {
    // Refused, not broken — 板砖 must not diagnose a "read failure" on a file
    // the harness rejected on purpose, and must not go looking for it.
    return en
      ? `[attachment] The Trailblazer tried to provide a file (${d.name}) but the harness refused it: credential-shaped files are never ingested. It is NOT on disk — do not look for it.`
      : `〔附件〕开拓者尝试提供文件（${d.name}），但框架拒收了它——密钥/凭据形状的文件一律不收。文件不在磁盘上——不要去找它。`;
  }
  if (d.path.length === 0) {
    if (d.format !== undefined) {
      // A document that never made it to disk, with the reason the user can
      // act on. `too_large` with no path is the page cap (ADR 0038 §4);
      // `read_error` here is a parse failure, not an I/O one.
      const why = documentFailureReason(d.unreadable, en);
      return en
        ? `[attachment] The Trailblazer tried to provide a document (${d.name}${docNote}) but ${why}. Nothing was stored — do not look for it.`
        : `〔附件〕开拓者尝试提供文档（${d.name}${docNote}），但${why}。未存盘——不要去找它。`;
    }
    return en
      ? `[attachment] The Trailblazer tried to provide a file (${d.name}) but it could not be read. It is NOT on disk — do not look for it.`
      : `〔附件〕开拓者尝试提供文件（${d.name}），但读取失败，文件不在磁盘上——不要去找它。`;
  }
  // The stored path is WORKSPACE-RELATIVE, and the line says so: in the
  // large-document lab (2026-08-23) the actor re-spelled the citation as
  // `~/.herta/attachments/…` in her dispatch and the backend spent four
  // commands (one a `find /`) on a home directory that holds no such thing.
  const where = en
    ? `${d.path} (relative to the workspace root)`
    : `${d.path}（相对工作区根目录）`;
  if (d.format !== undefined) {
    // Stored as extracted text. Say so, and say what "took no excerpt" means
    // for a document — over the char cap, still readable/searchable in full,
    // and long enough that locating first beats reading from the top.
    const noHead =
      d.unreadable !== undefined
        ? en
          ? " The harness took no head excerpt from it (the text is long); the full text is on disk — search for headings or keywords to locate what the task needs, then read that range. If the task needs the WHOLE document (a summary, an index, what it covers), call digest_document on the path once instead of reading it end to end."
          : "框架未取其开头（正文过长）；全文在磁盘上——先按标题或关键词检索定位，再分段读取需要的范围。若任务需要整份文档的内容（总结、索引、它讲了什么），对该路径调用一次 digest_document，不要从头读到尾。"
        : en
          ? " Read it with your file tools if the task needs it; for the whole document's content at once (a summary, an index), call digest_document on the path."
          : "任务需要时用文件工具自行读取；若需要整份文档的内容（总结、索引），对该路径调用 digest_document。";
    // The navigation aids (2026-08-23): the exact page-marker shape the FILE
    // carries (from the digest, not the session language), and the outline
    // sidecar with its column legend. Both absent for records from before
    // they existed, so an old citation still reads as it did.
    const markerNote =
      d.pageMarker !== undefined
        ? en
          ? ` Each page of the text begins with a line of the form \`${d.pageMarker}\`, so \`grep -n\` for that prefix is a page→line map and a cite of that line is a page cite.`
          : ` 正文每页以「${d.pageMarker}」一行起始：按该前缀 \`grep -n\` 即得页码→行号表，引用该行即引用页码。`
        : "";
    const outlineNote =
      d.outline !== undefined
        ? en
          ? ` Its outline (${d.outline.entries} entries — the document's own bookmarks/headings, one per line as \`title (p.<page> · L<line>)\`, nested by indent) is at ${d.outline.path}; read it first to jump to the part the task needs.`
          : ` 文档自带目录（${d.outline.entries} 条，来自书签/标题样式，每行形如「标题 (p.页 · L行)」，缩进表层级）存于 ${d.outline.path}——先读目录，再跳到任务需要的部分。`
        : "";
    return en
      ? `[attachment] The Trailblazer provided a document: ${d.name}${docNote}. The harness extracted its text to ${where} — that path IS the document, as plain text; there is no separate ${d.format} file.${noHead}${markerNote}${outlineNote}`
      : `〔附件〕开拓者提供了文档：${d.name}${docNote}。框架已将其正文提取为纯文本，存于 ${where}——该路径就是这份文档的文本版，没有另外的 ${d.format === "pdf" ? "PDF" : "docx"} 文件。${noHead}${markerNote}${outlineNote}`;
  }
  if (d.unreadable !== undefined) {
    return en
      ? `[attachment] The Trailblazer provided a file: ${d.name} — at ${where}. The harness took no excerpt from it (${d.unreadable}); it is on disk and you may still search it.`
      : `〔附件〕开拓者提供了文件：${d.name}，位于 ${where}。框架未从中取正文（${d.unreadable}）；文件在磁盘上，仍可检索。`;
  }
  return en
    ? `[attachment] The Trailblazer provided a file: ${d.name} — at ${where}. Read it with your file tools if the task needs it.`
    : `〔附件〕开拓者提供了文件：${d.name}，位于 ${where}。任务需要时用文件工具自行读取。`;
}

/** Why a document (ADR 0038) never reached disk, in words 板砖 can relay. */
export function documentFailureReason(
  unreadable: string | undefined,
  en: boolean,
) {
  switch (unreadable) {
    case "empty":
      return en
        ? "no text could be extracted (it is probably a scanned or image-only file)"
        : "未提取到文本（很可能是扫描件或纯图片）";
    case "encrypted":
      return en
        ? "it is password-protected and could not be opened"
        : "文档已加密，无法打开";
    case "unsupported":
      return en
        ? "its format is not supported (legacy .doc/.xls/.ppt, .xlsx/.pptx, or an encrypted package)"
        : "暂不支持该文档格式（旧版 .doc/.xls/.ppt、.xlsx/.pptx，或加密的文档包）";
    case "too_large":
      return en
        ? "it exceeds the page limit and was refused whole"
        : "页数超过上限，整份未提取";
    default:
      return en ? "it could not be parsed" : "解析失败";
  }
}

/**
 * Build the backend's task context from the record.
 *
 * Named for user MESSAGES but no longer only that: attachment blocks are
 * folded in as harness-authored citation lines (ADR 0033). They have to be.
 * The backend receives task evidence exclusively through this function, and an
 * attachment is a `system` block — so filtering on `kind === "user"` alone
 * meant Herta could see a document her coprocessor had no way to find. That is
 * the failure mode this feature would otherwise ship with, silently: everything
 * looks right until 板砖 is asked to use the file.
 *
 * The head excerpt is deliberately NOT replayed. 板砖 has the path and four
 * tools that read; pre-feeding it content would pay for the same bytes twice
 * and cap what it can see at the head.
 */
export function extractUserMessages(
  record: TerminalRecord,
  lang: PromptLang = "zh",
): ExtractedUserMessages {
  const all: { text: string }[] = [];
  for (const block of record) {
    if (block.kind === "user") {
      all.push({ text: block.text });
    } else if (block.kind === "system" && block.digest?.kind === "attachment") {
      // An attachment that could not be read is still worth naming: the task
      // may well BE "why can't you read this?", and silence would leave 板砖
      // inventing an answer about a file it was never told about.
      all.push({ text: attachmentTaskLine(block.digest, lang) });
    }
  }
  // Keep from the newest backwards until either cap trips. The newest
  // message always survives whole — it IS the task.
  const kept: { text: string }[] = [];
  let chars = 0;
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const m = all[i];
    if (m === undefined) continue;
    if (kept.length > 0) {
      if (kept.length >= USER_HISTORY_MAX_MESSAGES) break;
      if (chars + m.text.length > USER_HISTORY_MAX_CHARS) break;
    }
    kept.push(m);
    chars += m.text.length;
  }
  kept.reverse();
  return { messages: kept, omitted: all.length - kept.length };
}
