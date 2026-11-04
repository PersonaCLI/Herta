import type { PromptLang } from "./prompt-lang.js";

/**
 * CN/EN prose for the harness's **elision markers** — the lines a
 * projection writes to tell Herta that something which used to be in
 * front of her no longer is.
 *
 * Why these localize when record chrome does not: `→ 系统`,
 * `（我 说）`, `Reading {…}` and friends are the record's canonical
 * grammar, identical in every session (D2/D7, ADR 0017/0018 — display
 * localizes, the record does not). These strings are neither — they are
 * the harness talking TO Herta about her own prompt, the same register
 * as `session-recap-runtime`'s `〔更早的 N 段记录因篇幅略去〕`, which
 * has been per-lang since the EN interaction slices. An EN session
 * should not be told its history was compacted in Chinese.
 *
 * `板砖` stays literal in both: it is the wire token, and the EN prompt
 * corpus already treats it as a proper noun in English prose ("I call it
 * 板砖 — 'the brick'", prompts-en/EnvSet.txt). The `@Brick` alias of
 * ADR 0015 is a *display* alias and deliberately does not reach here.
 *
 * Wording discipline — these markers are read by a model that must not
 * claim to have seen what it cannot see, so each one states the fact
 * plainly (`历史已压缩`, not the old label-shaped `压缩历史`) and the
 * whole family shares one verb for removal (略去 / elided).
 */
export const COMPACTION_TEXT = {
  zh: {
    /** Header of a compacted contiguous-system-run summary block. */
    header: "板砖之前做过的事（细节不在手边）：",
    /** A run still working while the Trailblazer talks (ADR 0085 §3): its
     *  state, named, as the first line of the run in her view… */
    runLive: (steps: number) => `板砖还在跑，这一趟到现在 ${steps} 步。`,
    /** …and the header of its earlier steps, folded. */
    runLiveHeader: "这一趟前面做过的（细节不在手边）：",
    /** Appended to an excerpt citation once its text is gone. Shared with the
     *  attachment citation: the fact is identical ("the body is no longer in
     *  front of you"), and two phrasings for one fact would only invite the
     *  model to read a distinction into them. */
    excerptElided: "正文已略去",
    /** Appended to a folded search citation (2026-08-17): the matched lines
     *  are no longer in front of her; the counts survive. */
    searchElided: "匹配行已略去",
    /** Why an attachment carries no text at all. Distinct from the elision
     *  above, and the distinction is load-bearing: elided means she WAS shown
     *  it and no longer is; these mean it was never readable, so there is
     *  nothing she could ever have seen. */
    attachmentUnreadable: {
      binary: "非文本文件，未取正文",
      too_large: "文件过大，未取正文",
      empty: "未提取到文本",
      read_error: "读取失败",
      denied: "涉及密钥或凭据，已拒收",
      removed: "开拓者已移除",
      encrypted: "文档已加密，未取正文",
      unsupported: "暂不支持的文档格式，未取正文",
      no_caption: "图片已存，未能读图",
    },
    /** An attachment as Herta reads it (ADR 0079): the notes a projected row
     *  carries in place of the store's bookkeeping. Each sits in an aside
     *  after the name — `附件 hw.pdf（读过，原文不在手边）` once the text is
     *  no longer in front of her (owner, 2026-10-16: the first wording,
     *  「内容已不在眼前，需要时让板砖重读」, read wrong in her 自传). "Not at
     *  hand" already says it can be fetched; no separate reminder. The
     *  opening-only form is for a document that ran past what she was shown. */
    attachmentNotAtHand: "读过，原文不在手边",
    attachmentOpeningNotAtHand: "读过开头，原文不在手边",
    /** After a head the document runs past. */
    attachmentHeadOnly: "仅开头部分，正文更长",
    /** Above an outline preview. */
    attachmentContents: (total: number, shown: number) =>
      shown < total
        ? `目录（共 ${total} 条，这里是前 ${shown} 条）：`
        : `目录（共 ${total} 条）：`,
    /** Where a PDF's picture stands in its text: a picture she cannot see. */
    pictureMark: "（图）",
    /** Second line under the newest FOLDED done-marker (E2E 2026-08-11):
     *  patch previews are prompt-skipped after their turn, so a follow-up
     *  question about "which lines changed" found nothing to quote and got
     *  invented detail instead — which then fossilized into recap and dream.
     *  Same prescription as the attachment hint: for a few turns, say the
     *  diff is re-readable, then stop nudging. */
    diffRereadHint: "（改动的 diff 不在手边）",
    /** Digest of a `role: "noop-marker"` block. */
    noOutput: "板砖这次什么也没动。",
    /** Footer replacing the tail of an over-long ```diff fence on the
     *  user's screen, where the evidence it names is one click away. */
    diffSuppressed: (suppressed: number) =>
      `… (另有 ${suppressed} 行已略去 — 完整 diff 在证据里)`,
    /** The same footer in Herta's prompt, in her own words (ADR 0079 §2). */
    diffNotShown: (suppressed: number) => `……（还有 ${suppressed} 行没贴出来）`,
  },
  en: {
    header: "What 板砖 did before (details not at hand):",
    runLive: (steps: number) =>
      `板砖 is still running: ${steps} step${steps === 1 ? "" : "s"} so far.`,
    runLiveHeader: "Earlier in this run (details not at hand):",
    excerptElided: "body elided",
    searchElided: "matched lines elided",
    attachmentUnreadable: {
      binary: "not a text file, no body taken",
      too_large: "file too large, no body taken",
      empty: "no text extracted",
      read_error: "could not be read",
      denied: "credential-shaped, refused",
      removed: "withdrawn by the Trailblazer",
      encrypted: "password-protected, no body taken",
      unsupported: "unsupported document format, no body taken",
      no_caption: "image stored, not read",
    },
    attachmentNotAtHand: "read it; the original isn't at hand",
    attachmentOpeningNotAtHand: "read the opening; the original isn't at hand",
    attachmentHeadOnly: "only the opening; the document runs longer",
    attachmentContents: (total: number, shown: number) =>
      shown < total
        ? `Contents (${total} entries, the first ${shown} shown):`
        : `Contents (${total} entries):`,
    pictureMark: "(figure)",
    diffRereadHint: "(the diff isn't at hand)",
    noOutput: "板砖 did nothing this time.",
    diffSuppressed: (suppressed: number) =>
      `… (${suppressed} more lines suppressed — full diff in evidence)`,
    diffNotShown: (suppressed: number) =>
      `…(${suppressed} more lines not shown)`,
  },
} as const satisfies Record<PromptLang, unknown>;
