import type {
  SystemBlock,
  SystemBlockDigest,
  TerminalRecord,
  TerminalRecordBlock,
} from "@herta/core";
import { COMPACTION_TEXT } from "./compaction-text.js";
import type { PromptLang } from "./prompt-lang.js";

/**
 * Render a single system block into one digest line per the
 * template table in spec §4.1. Returns null when the block hits
 * a skip rule (Planning / patch.preview).
 *
 * Used by `buildCompactionBody` to produce the per-line content
 * of a compacted `→ 系统  [历史已压缩 · 板砖]` summary. Exported for
 * unit testability.
 *
 * `lang` reaches only the handful of lines that are harness prose
 * (the no-output marker, the excerpt's elision note) — see
 * `compaction-text.ts` for why those localize and the operation verbs
 * around them do not. Defaults to `zh`.
 *
 * Two-tier (M-projection-3, 2026-07-04): blocks written since the
 * structured `digest` field exists render from that data; the legacy
 * body-regex path below survives ONLY for records persisted before it
 * (and for bridge-built marker blocks, which carry `role` instead).
 * The regexes had already rotted twice against reworded bodies —
 * summarizeInput's human-form args broke the `{"path":…}` patterns,
 * and the tests line moved label + format — degrading silently to the
 * 60-char fallback; the structured field ends that failure mode for
 * all new records.
 *
 * See docs/superpowers/specs/2026-05-24-narrative-compaction-design.md §4.1.
 */
export function digestSystemBlock(
  block: SystemBlock,
  lang: PromptLang = "zh",
): string | null {
  if (block.digest !== undefined)
    return renderStructuredDigest(block.digest, lang);
  const body = block.body;

  if (block.label === "差分协处理器") {
    // Reading {"path":"X", ...}
    const readMatch = body.match(/^Reading\s+\{[^}]*"path"\s*:\s*"([^"]+)"/);
    if (readMatch !== null) return `Reading ${readMatch[1]}`;

    // Writing {"path":"X", ...}
    const writeMatch = body.match(/^Writing\s+\{[^}]*"path"\s*:\s*"([^"]+)"/);
    if (writeMatch !== null) return `Writing ${writeMatch[1]}`;

    // Running {"argv":["a","b","c", ...]}
    const runMatch = body.match(/^Running\s+\{[^}]*"argv"\s*:\s*\[([^\]]+)\]/);
    if (runMatch !== null) {
      const argv = (runMatch[1] ?? "")
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .join(" ");
      return `Running \`${argv}\``;
    }

    // Planning — skip per spec §4.1
    if (body.startsWith("Planning")) return null;

    // B1 no-op marker — role:"noop-marker" (body-prefix fallback for
    // pre-role persisted records).
    if (block.role === "noop-marker" || body.startsWith("无产出")) {
      return COMPACTION_TEXT[lang].noOutput;
    }

    // Fallback — first non-empty line, truncated to 60 chars.
    return fallbackDigest(body);
  }

  if (block.label === "系统") {
    // patch preview — skip per spec §4.1 (Writing covers it)
    if (body.startsWith("patch preview")) return null;

    // ↳ tests: N passed, M failed
    const testsMatch = body.match(
      /↳\s+tests:\s*(\d+)\s+passed,\s*(\d+)\s+failed/,
    );
    if (testsMatch !== null) {
      const passed = Number.parseInt(testsMatch[1] ?? "0", 10);
      const failed = Number.parseInt(testsMatch[2] ?? "0", 10);
      if (failed === 0) return `Tests: ${passed}/${passed} passed`;
      return `Tests: ${passed} passed, ${failed} failed`;
    }

    // ↳ <tool> failed: <code>: <message>
    const failMatch = body.match(/↳\s+(\w+)\s+failed:\s*(\w+):/);
    if (failMatch !== null) {
      return `${failMatch[1]} failed (${failMatch[2]})`;
    }

    return fallbackDigest(body);
  }

  return null;
}

function fallbackDigest(body: string): string {
  const firstNonEmpty =
    body.split("\n").find((line) => line.trim().length > 0) ?? "";
  // Mark the cut. This was a silent mid-word truncation: a 200-char body
  // arrived in the prompt as its first 60 characters with nothing to say
  // the sentence had been amputated, which reads as a complete (and
  // sometimes reversed) statement. `…` is language-neutral, so no prose
  // table needed, and the ellipsis takes the 60th slot rather than adding
  // a 61st so the digest's length budget is unchanged.
  if (firstNonEmpty.length <= 60) return firstNonEmpty;
  return `${firstNonEmpty.slice(0, 59)}…`;
}

/**
 * Render a digest line from the structured field (spec §4.1 template
 * table, data-driven). Mirrors the legacy body-regex renderings where
 * they were still reachable; the tests line renders from status +
 * summary because `TestRunSummary` carries no pass/fail counts (the
 * legacy "N passed, M failed" pattern never matched real projected
 * bodies — detectTestRun's summary is "exit 0, 3.21s").
 */
function renderStructuredDigest(
  d: SystemBlockDigest,
  lang: PromptLang,
): string | null {
  switch (d.kind) {
    case "op": {
      if (d.verb === "Planning") return null; // skip per spec §4.1
      if (d.verb === "Running") return `Running \`${d.arg}\``;
      return `${d.verb} ${d.arg}`.trim();
    }
    case "tests":
      return d.status === "passed"
        ? `Tests passed (${d.summary})`
        : `Tests ${d.status} (${d.summary})`;
    case "tool-fail":
      return `${d.tool} failed (${d.code})`;
    case "skip":
      return null;
    case "patch":
      // Compaction keeps the MAGNITUDE, not the diff: after a compaction the
      // patch body is gone, and "she changed 96 lines of spawn-git.ts" is the
      // part worth carrying forward. Unmeasurable changes say so.
      return d.add === undefined || d.del === undefined
        ? `Patched ${d.files.join(", ")} (via a command, no line diff)`
        : `Patched ${d.files.join(", ")} (+${d.add} -${d.del})`;
    case "bg":
      // One line per lifecycle row; the consecutive-state suppression in the
      // bridge already keeps these sparse.
      return `background ${d.id}: ${d.state}`;
    case "todo":
      // Legacy rows (nothing writes them since ADR 0073): the plan layout
      // AND the "todo k/n" progress rows were working state, not operations
      // — same skip rationale as the Planning op rows before them (spec §4.1).
      return null;
    case "excerpt":
      // The CITATION survives compaction, the excerpt does not (ADR 0027):
      // the content rode `evidenceDetail`, which this summary never carries,
      // so a later turn keeps knowing she was shown that span without
      // re-paying its tokens every turn thereafter.
      //
      // The elision is stated, not left implicit. Every other bullet here
      // digests a block that never had a body to lose — `Reading foo.ts` is
      // the WHOLE of what that block ever said. This one is the exception:
      // Herta really did read those lines last turn, and a bare citation
      // formatted exactly like its neighbours invites her to keep quoting
      // from a span that is no longer in front of her — the same
      // fabricated-receipt failure supervisor rule 9 exists to catch, except
      // sourced from the harness rather than from her. Saying `正文已略去`
      // costs four characters and makes "I was shown this" and "I can still
      // read this" two distinguishable states.
      return `Excerpt ${d.path}:${d.from}-${d.to} · ${COMPACTION_TEXT[lang].excerptElided}`;
    case "finding":
      // NOT elided (ADR 0039): the claim is the conclusion the brief was for,
      // short by schema; dropping it would drop the one thing worth keeping.
      // The cites travel so a later turn can send 板砖 back to them.
      return `Finding: ${d.claim}${d.cites.length > 0 ? ` (${d.cites.join(", ")})` : ""}`;
    case "search":
      // Third member of the excerpt/attachment family (2026-08-17): the hit
      // list rode `evidenceDetail` and is gone once this folds, so the
      // citation says so — the counts stay, the lines do not. Same fabricated
      // -quote hazard, same four-character remedy.
      return `Search /${d.pattern}/ · ${d.matches} matches in ${d.files} files · ${COMPACTION_TEXT[lang].searchElided}`;
    case "attachment": {
      // Same two-state contract as `excerpt` above, and the same hazard for
      // the same reason: she really was shown the head of this document last
      // turn, and a citation formatted like its neighbours would invite her
      // to keep quoting a body that is no longer in front of her.
      //
      // What survives is deliberately the PATH, not just the name. The file
      // is still on disk, so "开拓者 gave me a spec at <path>" is the one
      // digest line here that stays actionable after compaction — she can
      // send 板砖 back to it. A bare name would leave her knowing a document
      // existed and unable to reach it.
      // An IMAGE keeps its CAPTION through the fold, where a document keeps
      // only its citation (ADR 0048 §1). The two look alike and are not: a
      // document's head was an excerpt of text that is still on disk and
      // still re-readable, so eliding it loses nothing permanently. A
      // caption is the ONLY textual form the picture ever had — the actor
      // cannot re-read pixels — so dropping it here would erase the moment
      // from precisely the timescales this design exists to reach: the
      // recap, the 废案 distillation, and the next session's few-shots.
      // This is why the caption rides the body rather than evidenceDetail.
      const tail =
        d.caption !== undefined
          ? d.caption
          : d.unreadable === undefined
            ? COMPACTION_TEXT[lang].excerptElided
            : COMPACTION_TEXT[lang].attachmentUnreadable[d.unreadable];
      // The outline sidecar survives the fold by citation (2026-08-23) —
      // path included, for the same reason the document's path is kept.
      const outline =
        d.outline !== undefined
          ? ` · ${COMPACTION_TEXT[lang].attachmentOutline(d.outline.entries, d.outline.path)}`
          : "";
      return `Attachment ${d.name} (${d.path}) · ${tail}${outline}`;
    }
    case "digest":
      // The overview rode evidenceDetail and is gone; the sidecar is not —
      // keep its path so a later turn sends 板砖 to `cat` it rather than
      // re-digest (ADR 0043).
      return `Digest ${d.source} → ${d.path} · ${d.chunks} chunks · ${COMPACTION_TEXT[lang].excerptElided}`;
    case "undo": {
      // The 开拓者 took a turn's edits back (ADR 0074). What a later turn
      // must keep is what is STILL changed — a file skipped or a command's
      // edit is on disk, and "the edits were undone" alone would let her
      // assume a clean tree.
      const back = d.files
        .filter((f) => f.result === "restored" || f.result === "deleted")
        .map((f) => f.path);
      const kept = d.files
        .filter(
          (f) =>
            f.result !== "restored" &&
            f.result !== "deleted" &&
            f.result !== "unchanged",
        )
        .map((f) => `${f.path} (${f.result.replace("_", " ")})`);
      const parts = [
        `Undid the turn's edits: ${back.length > 0 ? back.join(", ") : "nothing to restore"}`,
        ...(kept.length > 0 ? [`still changed: ${kept.join(", ")}`] : []),
        ...(d.commands.length > 0
          ? [`changed by commands, not undone: ${d.commands.join(", ")}`]
          : d.commandsUnknown
            ? ["commands ran; their changes, if any, not undone"]
            : []),
      ];
      return parts.join(" · ");
    }
    case "text":
      return fallbackDigest(d.text);
  }
}

/**
 * Build the compaction summary body from a list of source system
 * blocks. Applies the template table via `digestSystemBlock`, drops
 * entries that hit a skip rule (Planning / patch.preview), runs the
 * consecutive-same-verb coalesce (`Reading a` + `Reading b` →
 * `Reading a, b`), and assembles the result with the
 * `[历史已压缩 · 板砖]` header.
 *
 * Returns the empty string when every input block hit a skip rule —
 * the caller (`compactRecordForPrompt`) treats this as "no
 * compaction possible" and passes the original run through verbatim
 * rather than emitting a meaningless header with no bullets.
 *
 * See docs/superpowers/specs/2026-05-24-narrative-compaction-design.md §4.3 / §4.4.
 */
export function buildCompactionBody(
  blocks: readonly SystemBlock[],
  lang: PromptLang = "zh",
): string {
  // 1. Map blocks through the template; drop skipped entries.
  const lines: string[] = [];
  for (const block of blocks) {
    const digest = digestSystemBlock(block, lang);
    if (digest !== null) lines.push(digest);
  }
  if (lines.length === 0) return "";

  // 2. Consecutive-same-verb coalesce. Only Reading and Writing
  //    coalesce (those are the verbs that commonly run in batches);
  //    Running / Tests / failed entries stay one-per-bullet.
  const coalesced: string[] = [];
  for (const line of lines) {
    const verb = matchCoalesceVerb(line);
    const last = coalesced[coalesced.length - 1];
    if (verb !== null && last !== undefined) {
      const lastVerb = matchCoalesceVerb(last);
      if (lastVerb !== null && lastVerb.verb === verb.verb) {
        coalesced[coalesced.length - 1] =
          `${lastVerb.verb} ${lastVerb.rest}, ${verb.rest}`;
        continue;
      }
    }
    coalesced.push(line);
  }

  // 3. Assemble with header.
  const header = COMPACTION_TEXT[lang].header;
  const bullets = coalesced.map((l) => `- ${l}`).join("\n");
  return `${header}\n${bullets}`;
}

function matchCoalesceVerb(
  line: string,
): { verb: "Reading" | "Writing"; rest: string } | null {
  const m = line.match(/^(Reading|Writing)\s+(.+)$/);
  if (m === null) return null;
  const verb = m[1] as "Reading" | "Writing";
  const rest = m[2] ?? "";
  return { verb, rest };
}

/**
 * Options for `compactRecordForPrompt`.
 *
 * `minRunSize` — minimum contiguous system blocks required to
 * trigger compaction. Runs shorter than this pass through verbatim.
 * Default 2 (collapses any pair of adjacent system blocks).
 *
 * `lang` — session interaction language, selecting the harness prose in
 * `compaction-text.ts` (header, no-output marker, excerpt elision note).
 * Default `zh`; the operation verbs are canonical and never localize.
 */
export interface CompactOptions {
  readonly minRunSize?: number;
  readonly lang?: PromptLang;
  /**
   * Attachment fold decisions made elsewhere, over a record this call sees
   * only a piece of (ADR 0033 §6g amendment, 2026-09-22). The fold's window
   * counts user turns and later mentions across the WHOLE record, so a
   * projection that compacts a slice — the beat's head, everything up to the
   * prior dispatch — must not decide from the slice alone: it would keep a
   * head the main turn has already folded, and fold one a later mention has
   * re-opened. Omitted, the decision is made over `record` itself — the
   * main-turn shape, where the record IS the whole record.
   */
  readonly attachmentFolds?: AttachmentFolds;
}

/**
 * Walks the record and replaces each run of ≥`minRunSize` contiguous
 * system blocks with one synthetic compaction summary block. Pure,
 * deterministic, does not mutate the input.
 *
 * Compaction is asymmetric: main turns / supervisor / router opt in
 * (default behavior); an in-turn beat runs it only over the record up to
 * the PRIOR dispatch's marker and keeps the fresh window after it
 * verbatim (`verbatimSinceLastDispatch`, serialize.ts) so the beat sees
 * the full board output of the invocation that just fired it. The
 * attachment fold is the one lane that reaches the fresh window too —
 * decided over the whole record, applied by `foldAttachments` (ADR 0033
 * §6g amendment, 2026-09-22).
 *
 * Per-`@板砖`-invocation collapse is the design intent; this
 * function approximates it as per-contiguous-system-run collapse.
 * When an in-turn beat fires between system blocks of the same
 * invocation, the run splits — each pre-beat / post-beat run gets
 * its own summary, preserving the beat as a narrative anchor in
 * between (spec §3).
 *
 * See docs/superpowers/specs/2026-05-24-narrative-compaction-design.md §7.
 */
/** An attachment block (ADR 0033) — the one system-block shape produced by a
 *  USER act rather than by the bridge or the backend. */
function isAttachmentBlock(b: TerminalRecordBlock): b is SystemBlock {
  return b.kind === "system" && b.digest?.kind === "attachment";
}

/**
 * How many user turns keep an attachment's head excerpt verbatim (State 1)
 * before it folds to a citation. Counted from the fold ANCHOR — the block
 * itself, or the most recent user message that names the file — so the drop
 * turn plus the next two follow-ups all read the head, and naming the file
 * later re-opens the same window (owner 2026-08-11).
 */
export const ATTACHMENT_VERBATIM_USER_TURNS = 3;

/**
 * How many further user turns a freshly folded citation carries the re-read
 * hint (`attachmentRereadHint`). The user's follow-up may not name the file,
 * and Herta's only route back to the body is a 板砖 dispatch — for a few
 * turns after the fold the harness says so under the citation, then the
 * hint expires and the bare citation remains (owner 2026-08-11: "like the
 * meta-think parts — and completely remove the hint after N turns").
 */
export const ATTACHMENT_HINT_USER_TURNS = 3;

/** The attachment projection's three states — see foldAttachmentForPrompt. */
export type AttachmentFoldState = "verbatim" | "citation-hint" | "citation";

/**
 * The fold state of every attachment block in a record, keyed by BLOCK
 * IDENTITY — the record's blocks are distinct objects, and a `slice` keeps
 * them, so a decision made over the whole record can be applied to any piece
 * of it. Produced by `decideAttachmentFolds`; consumed by
 * `compactRecordForPrompt` (its `attachmentFolds` option) and by
 * `foldAttachments`. A block absent from the map is treated as verbatim: the
 * projection never folds what nobody decided.
 */
export type AttachmentFolds = ReadonlyMap<SystemBlock, AttachmentFoldState>;

/**
 * How many user turns after the newest FOLDED done-marker the compaction
 * summary carries the diff re-read hint (`diffRereadHint`). Patch previews
 * are prompt-skipped once their run compacts, so a follow-up question about
 * the changed lines has nothing to quote — the E2E lab (2026-08-11) caught
 * the resulting invented detail fossilizing into recap and dream. Same
 * decay rationale as ATTACHMENT_HINT_USER_TURNS.
 */
export const DIFF_REREAD_HINT_USER_TURNS = 3;

/**
 * Per-block two-state fold for attachment blocks (ADR 0033, amended §6g).
 *
 * The run-compaction below CANNOT give attachments the "verbatim in its own
 * turn, a citation forever after" lifecycle, because it only folds runs of
 * ≥ minRunSize contiguous system blocks. `show_excerpt` blocks always sit
 * inside a dispatch's run, so folding reaches them; an attachment block sits
 * ALONE between a herta block and the user's next message, and a run of one
 * passes through verbatim — which would keep the document's head excerpt in
 * every subsequent prompt of the session. The two-state lane has to be
 * per-block here.
 *
 * The original key was the done-marker's — one speech after the block ends
 * State 1. That protected against fabricated quotes after the conversation
 * moved on, but punished the conversation that STAYED on the document: the
 * user's first follow-up question already found the head gone, and Herta's
 * only honest paths were a 板砖 re-read or answering from her own prior
 * commentary — the confabulation hazard the fold exists to prevent, created
 * by it (owner 2026-08-11). The key is now a record-structural window:
 *
 *   State 1 (verbatim) while EITHER
 *     - Herta has not SPOKEN since the block (she is reading the head in the
 *       turn that responds to it — same speech-only rule as the done-marker,
 *       audit 2026-07-24 1.10: a （我 想） must not flip it), OR
 *     - fewer than ATTACHMENT_VERBATIM_USER_TURNS user messages follow the
 *       fold anchor. The anchor starts at the block and MOVES to the most
 *       recent user message whose text names the file (case-insensitive
 *       substring of the display name) — returning to the document re-opens
 *       the window, and the window can expire again after it.
 *   State 2 (both exhausted): the head is dropped and the body says so
 *   (`· 正文已略去`), leaving the citation. "I was shown this" and "I can
 *   still read this" stay two distinguishable states — the same
 *   fabricated-quote hazard the excerpt digest documents. For the first
 *   ATTACHMENT_HINT_USER_TURNS turns of this state the citation carries a
 *   second line — the re-read hint — because the follow-up that needs the
 *   body back may not name the file, and her only route to it is a 板砖
 *   dispatch; the hint then expires (State 3, the bare citation), so an old
 *   attachment does not nudge every later turn toward a dispatch.
 *
 * Deliberately NOT wall-clock ("keep it while the conversation continues
 * without a long break" was the first proposal): every fold decision here is
 * a pure function of the record, so the same record always builds the same
 * prompt — reopening a session later must not change what Herta can read
 * (recap cache keying, rewind, and the labs all assume this).
 *
 * An unreadable attachment has no detail to drop and its body already says
 * why; appending an elision note would claim a body that never existed, so it
 * passes through unchanged in both states.
 */
function foldAttachmentForPrompt(
  block: SystemBlock,
  state: AttachmentFoldState,
  lang: PromptLang,
): SystemBlock {
  if (state === "verbatim") return block;
  // No detail means nothing was ever elided — unreadable and removed blocks
  // pass through unchanged, and the hint stays away too: for `removed` the
  // file is gone from disk, so inviting a re-read would be a lie.
  if (block.evidenceDetail === undefined || block.evidenceDetail.length === 0) {
    return block;
  }
  const { evidenceDetail: _dropped, ...rest } = block;
  const text = COMPACTION_TEXT[lang];
  const hint =
    state === "citation-hint" ? `\n${text.attachmentRereadHint}` : "";
  return {
    ...rest,
    body: `${block.body} · ${text.excerptElided}${hint}`,
  };
}

/** Characters that can appear INSIDE a filename. A display-name match
 *  flanked by one of these is part of a longer name, not a reference to
 *  this file. */
const FILENAME_CHAR = /[A-Za-z0-9._-]/;

/** Shortest display name usable as a re-inflation needle. Below this the
 *  name is too weak to be evidence of intent even with boundaries — a file
 *  called `a` would re-open its window on the English article. */
const MIN_REFERENCE_NAME_LEN = 3;

/**
 * Does `text` REFERENCE the file called `needle` (both already lowercased)?
 *
 * Boundary-checked, not a bare substring test (self-review 2026-08-11). The
 * first cut used `includes`, and its comment claimed the extension made
 * collisions impossible — which covers a bare WORD colliding ("spec"), not
 * one filename sitting inside another: `report.md` is a suffix of
 * `final-report.md`, so naming the long file re-inflated the short one too.
 * A match counts only when neither flank is a filename character.
 *
 * The flank class cannot carry CJK names — the SECOND review round caught
 * that the fix above held for Latin and silently failed for the product's
 * primary case: `报告.md` inside `年度报告.md` has flank `度`, which is not
 * a "filename character", so the boundary test passed. And the class cannot
 * simply grow CJK, because prose-flank and name-interior-flank are locally
 * indistinguishable in a spaceless script — `回到报告.md` (a legitimate
 * reference) has exactly the same shape. What disambiguates is knowledge the
 * character class does not have: the OTHER attachments' names. A match lying
 * inside an occurrence of a longer SIBLING attachment's name is that
 * sibling's reference, not this file's — and both-files-attached is
 * precisely how the collision arises. `longerSiblings` carries the record's
 * attachment names that strictly contain `needle`; a match covered by one is
 * skipped. Residual, accepted and documented: a longer CJK name that is NOT
 * itself an attachment still collides (`新版质检报告.md` mentioned in prose
 * while only `质检报告.md` was attached) — the cost is one spurious
 * re-inflated head, and the alternative (suppressing CJK-flank matches
 * outright) would break every spaceless CJK prose reference.
 */
function mentionsFile(
  text: string,
  needle: string,
  longerSiblings: readonly string[],
): boolean {
  if (needle.length < MIN_REFERENCE_NAME_LEN) return false;
  for (let from = 0; ; ) {
    const at = text.indexOf(needle, from);
    if (at === -1) return false;
    from = at + 1;
    const before = at > 0 ? text.charAt(at - 1) : "";
    const after =
      at + needle.length < text.length ? text.charAt(at + needle.length) : "";
    if (
      (before !== "" && FILENAME_CHAR.test(before)) ||
      (after !== "" && FILENAME_CHAR.test(after))
    ) {
      continue;
    }
    // Sibling containment: is this occurrence inside a longer attachment
    // name present at the covering position in the text?
    let covered = false;
    for (const sib of longerSiblings) {
      for (
        let inSib = sib.indexOf(needle);
        inSib !== -1 && !covered;
        inSib = sib.indexOf(needle, inSib + 1)
      ) {
        const sibStart = at - inSib;
        if (sibStart >= 0 && text.startsWith(sib, sibStart)) covered = true;
      }
      if (covered) break;
    }
    if (!covered) return true;
  }
}

/**
 * Decide the fold state for the attachment block at `idx`. Fold only when
 * Herta has spoken since AND the user-turn window past the anchor is
 * exhausted; a fresh fold carries the re-read hint for a further
 * ATTACHMENT_HINT_USER_TURNS turns — see `foldAttachmentForPrompt` for the
 * full contract.
 */
function attachmentFoldDecision(
  record: TerminalRecord,
  idx: number,
  block: SystemBlock,
  lastSpeechIdx: number,
  userIdxs: readonly number[],
  attachmentNames: readonly string[],
): AttachmentFoldState {
  if (idx >= lastSpeechIdx) return "verbatim";
  // Anchor: the most recent user message after the block that REFERENCES the
  // file (boundary + sibling-checked — see mentionsFile), else the block.
  const name =
    block.digest?.kind === "attachment" ? block.digest.name : undefined;
  let anchor = idx;
  if (name !== undefined && name.length > 0) {
    const needle = name.toLowerCase();
    const longerSiblings = attachmentNames.filter(
      (n) => n.length > needle.length && n.includes(needle),
    );
    for (let k = userIdxs.length - 1; k >= 0; k--) {
      const ui = userIdxs[k];
      if (ui === undefined || ui <= idx) break;
      const ub = record[ui];
      if (
        ub?.kind === "user" &&
        mentionsFile(ub.text.toLowerCase(), needle, longerSiblings)
      ) {
        anchor = ui;
        break;
      }
    }
  }
  let turnsAfterAnchor = 0;
  for (const ui of userIdxs) {
    if (ui > anchor) turnsAfterAnchor += 1;
  }
  if (turnsAfterAnchor < ATTACHMENT_VERBATIM_USER_TURNS) return "verbatim";
  return turnsAfterAnchor <
    ATTACHMENT_VERBATIM_USER_TURNS + ATTACHMENT_HINT_USER_TURNS
    ? "citation-hint"
    : "citation";
}

/**
 * Drop a verbatim-passed-through block's `evidenceDetail` once Herta has
 * SPOKEN since it (self-review 2026-08-11). The citation — the body — always
 * survives; only the detail goes.
 *
 * The run-compaction below reaches a block's detail only when the block sits
 * in a run of ≥ minRunSize. A block that lands ALONE passes through verbatim,
 * detail included, in EVERY later prompt of the session — and the bridge
 * produces exactly that shape whenever a BeatPolicy beat fires next to the
 * block (`patch preview → Writing → 【beat】 → done-marker` leaves the marker
 * by itself). ADR 0033 §1 found this hole for attachments and closed it with
 * a per-block fold, while asserting that `show_excerpt` "always sits inside a
 * dispatch's run" — false for the same beat reason, so ADR 0027's "verbatim
 * in its own turn, a citation forever after" was silently broken for every
 * stranded excerpt (≤ 4000 chars each) and command-output tail. Ten stranded
 * excerpts is the ~40K chars of permanent prompt weight ADR 0033 used to
 * justify building the attachment fold in the first place.
 *
 * Keyed on SPEECH, like every other two-state lane here (audit 2026-07-24,
 * 1.10). Attachments never reach this — they carry their own richer fold —
 * and neither does the State-1 pass-through done-marker, which is emitted
 * outside this branch precisely so its roll-up survives its verdict turn.
 */
function foldStrandedDetail(
  block: TerminalRecordBlock,
  spokenSince: boolean,
  lang: PromptLang = "zh",
): TerminalRecordBlock {
  if (!spokenSince || block.kind !== "system") return block;
  if (block.evidenceDetail === undefined) return block;
  const { evidenceDetail: _dropped, ...rest } = block;
  // Say that the body went, exactly as the attachment fold and the excerpt
  // digest do ("The elision is stated, not left implicit"). Dropping it
  // SILENTLY leaves a row like `↳ exit 0 · 14 lines` that reads as the whole
  // of what that block ever said — so a later turn quotes figures from a span
  // no longer in front of her, and nothing in the record contradicts it. The
  // R-2 probe (2026-08-12) measured the cost: asked to read back a folded
  // result, reciting it from memory was caught only 1/3 of the time, because
  // the judge could not tell the content had ever been there. With the note,
  // both she and the supervisor can see that the receipt is gone.
  return {
    ...rest,
    body: `${block.body} · ${COMPACTION_TEXT[lang].excerptElided}`,
  };
}

/**
 * The record positions the two-state lanes count from: the newest herta
 * SPEECH and every user block, in order.
 *
 * The speech lower-bounds the attachment and stranded-detail folds — a block
 * she has not yet responded to stays verbatim regardless of the user-turn
 * window. Speech only, same rule as the done-marker walk and for the same
 * reason (audit 2026-07-24, 1.10): a （我 想） committed after the block must
 * not flip it. The user indices are what the attachment fold's window and
 * anchor search count (attachmentFoldDecision) and what the diff re-read
 * hint counts; collected once per record.
 */
function recordLandmarks(record: TerminalRecord): {
  lastSpeechIdx: number;
  userIdxs: readonly number[];
} {
  let lastSpeechIdx = -1;
  for (let k = record.length - 1; k >= 0; k--) {
    const b = record[k];
    if (b !== undefined && b.kind === "herta" && b.surface === "speech") {
      lastSpeechIdx = k;
      break;
    }
  }
  const userIdxs: number[] = [];
  record.forEach((b, k) => {
    if (b.kind === "user") userIdxs.push(k);
  });
  return { lastSpeechIdx, userIdxs };
}

/**
 * Decide the fold state of every attachment block in `record`, over the whole
 * of it (ADR 0033 §6g). This is the one place the decision is made; the
 * main-turn `compactRecordForPrompt` calls it on the record it is given, and
 * a projection that renders the record in pieces calls it on the whole record
 * FIRST and hands the result to each piece — see `CompactOptions.
 * attachmentFolds` for why the piece must not decide for itself.
 */
export function decideAttachmentFolds(record: TerminalRecord): AttachmentFolds {
  const { lastSpeechIdx, userIdxs } = recordLandmarks(record);
  // Every attachment display name in the record (lowercased) — the sibling
  // set mentionsFile uses to keep a short name from matching inside a longer
  // sibling's occurrence (the CJK-flank collision the boundary class cannot
  // see).
  const attachmentNames = record
    .filter(isAttachmentBlock)
    .map((b) => (b.digest?.kind === "attachment" ? b.digest.name : ""))
    .filter((n) => n.length > 0)
    .map((n) => n.toLowerCase());
  const folds = new Map<SystemBlock, AttachmentFoldState>();
  record.forEach((b, k) => {
    if (isAttachmentBlock(b)) {
      folds.set(
        b,
        attachmentFoldDecision(
          record,
          k,
          b,
          lastSpeechIdx,
          userIdxs,
          attachmentNames,
        ),
      );
    }
  });
  return folds;
}

/**
 * Apply already-decided attachment folds to `blocks` and nothing else: no
 * run compaction, no stranded-detail fold, no diff treatment. This is the
 * attachment lane on its own, for a projection that wants a piece of the
 * record otherwise verbatim — the beat's fresh window (serialize.ts), which
 * must show the CURRENT run in full and yet not re-inflate a document the
 * main turn has already folded (ADR 0033 §6g amendment, 2026-09-22).
 */
export function foldAttachments(
  blocks: TerminalRecord,
  folds: AttachmentFolds,
  lang: PromptLang = "zh",
): TerminalRecord {
  return blocks.map((b) =>
    isAttachmentBlock(b)
      ? foldAttachmentForPrompt(b, folds.get(b) ?? "verbatim", lang)
      : b,
  );
}

export function compactRecordForPrompt(
  record: TerminalRecord,
  opts?: CompactOptions,
): TerminalRecord {
  const minRunSize = opts?.minRunSize ?? 2;
  const lang = opts?.lang ?? "zh";

  const { lastSpeechIdx, userIdxs } = recordLandmarks(record);

  // The attachment folds: decided here over `record` in the main-turn shape,
  // or handed in by a caller that decided over a larger record this is a
  // piece of (see CompactOptions.attachmentFolds).
  const attachmentFolds =
    opts?.attachmentFolds ?? decideAttachmentFolds(record);

  // Done-marker two-state lifecycle: find the last done-marker; the verdict
  // is "spoken" if any herta block appears after it. In State 1 (verdict turn,
  // none after) the done-marker is passed through verbatim so its evidenceDetail
  // roll-up reaches Herta's prompt; in State 2 (verdict spoken) it folds into
  // the summary by body like any system block, dropping the redundant roll-up.
  //
  // Backward-walk-and-stop (arch audit 2026-07-15): the decision depends only
  // on the record TAIL, so walk backward from the end and stop at the first
  // herta block (some herta block then follows every done-marker → State 2,
  // no pass-through) or the first done-marker (it is the LAST one and no
  // herta block follows it → State 1, pass it through). Blocks before the
  // stop point provably cannot change the outcome; this replaces the previous
  // two full-record forward scans and yields the identical passThroughIdx —
  // the serialized projection is byte-for-byte unchanged (equivalence pinned
  // against a naive reference in serialize.test.ts).
  let passThroughIdx = -1;
  for (let k = record.length - 1; k >= 0; k--) {
    const b = record[k];
    if (b === undefined) continue;
    // Only SPEECH counts as "the verdict was spoken" (audit 2026-07-24,
    // 1.10). A bare `kind === "herta"` also matched a （我 想）— and on the
    // mood-routed path that is the NORMAL post-dispatch shape: committing the
    // @板砖 speech resets the consecutive-thought counter, so the next
    // iteration is forced back to thought, committing one AFTER the
    // done-marker. Current-turn thoughts survive the prompt filter while no
    // speech follows, so they reached here and flipped the marker into
    // State 2 — folding it into the compaction summary and dropping its
    // evidenceDetail. The prompt that lost `↳ 改动文件 / 风险 / 待办` was
    // therefore precisely the one generating Herta's SYNTHESIS speech: she
    // reported the run without naming which files changed or what was still
    // open, and ADR 0025's unfinished-todo inheritance was cut at that point.
    if (b.kind === "herta" && b.surface === "speech") break;
    if (b.kind === "system" && b.role === "done-marker") {
      passThroughIdx = k;
      break;
    }
  }

  // Diff re-read hint (E2E lab 2026-08-11). Patch previews are prompt-SKIPPED
  // once their run compacts, so "改了哪几行?" one turn after a dispatch found
  // nothing to quote and got invented detail — which then fossilized into
  // recap and dream. Same prescription as the attachment fold's hint, same
  // decay: for DIFF_REREAD_HINT_USER_TURNS user turns after the newest
  // FOLDED done-marker (State 2 — the verdict was spoken; a State-1 marker
  // still carries its verbatim roll-up and needs no nudge), the projection
  // appends one line saying the diff is re-readable via 板砖. Then it stops
  // nudging. Prompt-only; the record never changes.
  let diffHintIdx = -1;
  if (passThroughIdx === -1) {
    for (let k = record.length - 1; k >= 0; k--) {
      const b = record[k];
      if (b?.kind === "system" && b.role === "done-marker") {
        let turnsAfter = 0;
        for (const ui of userIdxs) {
          if (ui > k) turnsAfter += 1;
        }
        if (turnsAfter <= DIFF_REREAD_HINT_USER_TURNS) diffHintIdx = k;
        break;
      }
    }
  }

  const output: TerminalRecordBlock[] = [];
  let i = 0;
  while (i < record.length) {
    const current = record[i];
    if (current === undefined) {
      i += 1;
      continue;
    }
    if (current.kind === "system") {
      // Attachment blocks never join a run: they are a user act, and folding
      // one into a `[历史已压缩 · 板砖]` summary would file the user's own
      // document under 板砖's name. Each carries its own two-state fold.
      if (isAttachmentBlock(current)) {
        output.push(
          foldAttachmentForPrompt(
            current,
            attachmentFolds.get(current) ?? "verbatim",
            lang,
          ),
        );
        i += 1;
        continue;
      }
      // Find the end of the contiguous system run (attachment blocks end a
      // run for the reason above; the segment after one restarts cleanly).
      let j = i + 1;
      while (j < record.length) {
        const b = record[j];
        if (b?.kind !== "system" || isAttachmentBlock(b)) break;
        j += 1;
      }
      // If the pass-through done-marker is inside this run, exclude it from
      // the compacted summary and emit it verbatim after.
      const hasPassThrough = passThroughIdx >= i && passThroughIdx < j;
      const compactEnd = hasPassThrough ? passThroughIdx : j;
      const runLength = compactEnd - i;

      // The hinted done-marker rides in this run: the hint line lands on the
      // summary that swallowed it (or on the marker itself when the run
      // passes through verbatim, below).
      const hintInRun = diffHintIdx >= i && diffHintIdx < compactEnd;
      if (runLength >= minRunSize) {
        const runBlocks = record.slice(i, compactEnd) as readonly SystemBlock[];
        const body = buildCompactionBody(runBlocks, lang);
        if (body.length > 0) {
          output.push({
            kind: "system",
            label: "系统",
            body: hintInRun
              ? `${body}\n${COMPACTION_TEXT[lang].diffRereadHint}`
              : body,
          });
        } else {
          // All entries in the run hit a skip rule — pass them
          // through verbatim rather than emitting an empty-header
          // summary (spec §4.4). Still a verbatim pass-through, so the
          // stranded-detail fold applies (see foldStrandedDetail).
          for (let k = 0; k < runBlocks.length; k++) {
            const b = runBlocks[k];
            if (b !== undefined) {
              output.push(foldStrandedDetail(b, i + k < lastSpeechIdx, lang));
            }
          }
        }
      } else {
        // Run shorter than minRunSize — pass through verbatim, minus any
        // stranded evidenceDetail (the hinted marker, if here, also gains
        // its hint line).
        for (let k = i; k < compactEnd; k++) {
          const b = record[k];
          if (b === undefined) continue;
          const folded = foldStrandedDetail(b, k < lastSpeechIdx, lang);
          output.push(
            k === diffHintIdx && folded.kind === "system"
              ? {
                  ...folded,
                  body: `${folded.body}\n${COMPACTION_TEXT[lang].diffRereadHint}`,
                }
              : folded,
          );
        }
      }
      // Emit the pass-through done-marker verbatim (State 1).
      if (hasPassThrough) {
        const dm = record[passThroughIdx];
        if (dm !== undefined) output.push(dm);
      }
      // Advance past what we just emitted. On a pass-through, resume right
      // AFTER the done-marker so the remaining system blocks in this run
      // (if any) are re-collapsed as their own run rather than dropped.
      i = hasPassThrough ? passThroughIdx + 1 : j;
    } else {
      output.push(current);
      i += 1;
    }
  }
  return output;
}
