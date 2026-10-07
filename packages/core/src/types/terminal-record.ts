import type { ExecutionStatus } from "../bridge/types.js";

/**
 * Canonical system-block labels emitted by the v0.2 harness into
 * TerminalRecord. These are the ONLY two labels the harness may write.
 *
 * - "系统"          — environment, file, and permission facts
 *                     (read/list results, write summaries, command status,
 *                      permission outcomes, truncation notices, compaction)
 * - "差分协处理器"  — coding-backend operational status
 *                     (accepted / planning / done / failed; workflow-level
 *                      tool start: reading / writing / running / verifying)
 *
 * The casual name "板砖" remains in narrative text only — Herta refers to
 * 板砖 in her own blocks, and "@板砖" is the delegation trigger token. The
 * harness must NEVER emit "→ 板砖" as a system label. See SPEC v0.2 §5.3 / D7.
 */
export type SystemBlockLabel = "系统" | "差分协处理器";

export const SYSTEM_BLOCK_LABELS: readonly SystemBlockLabel[] = [
  "系统",
  "差分协处理器",
] as const;

export function isSystemBlockLabel(value: string): value is SystemBlockLabel {
  return (SYSTEM_BLOCK_LABELS as readonly string[]).includes(value);
}

/**
 * A user-authored block, fenced as （开拓者 说）...（/开拓者 说） when
 * rendered into the narrative grammar. User text is data — the serializer
 * (Slice 3) is responsible for escaping any delimiter-like content so
 * users cannot forge Herta/system blocks by injection (SPEC §11.1).
 */
export interface UserBlock {
  readonly kind: "user";
  readonly text: string;
  /** A steer (ADR 0063 §1.10): words the user interjected into 板砖's
   *  running work, projected in event order between the rows they
   *  interrupted. Not a turn of its own — rewind withdraws the turn that
   *  holds it, and the ⟲ control never sits on it. Absent on every other
   *  user block. Never enters the prompt (the serializer reads `text`). */
  readonly steer?: true;
  /** A 继续 (ADR 0071 §1.4): the user asked to continue an interrupted 板砖
   *  run. A turn of its own — rewind withdraws it like any user turn — and a
   *  regenerate after a crash re-runs it as a resume, not as chat. Never
   *  enters the prompt (the serializer reads `text`). */
  readonly resume?: true;
  /** Wall-clock ISO time the block was emitted/persisted. Optional for
   *  backward compat (pre-timestamp sessions lack it). Stamped at the output
   *  boundaries (live sink emit + JSONL persist), never at construction — the
   *  actor serializer ignores it (D7/D8: it never enters Herta's prompt). */
  readonly at?: string;
}

/**
 * A Herta-authored block, fenced as （我 说）...（/我 说）（speech）
 * or （我 想）...（/我 想）（thought）. Includes both primary actor blocks
 * and in-turn narrative beats inserted during @板砖 execution (SPEC §6.4).
 *
 * Surface discriminator (Slice 10):
 *   - "speech":   user-visible, rendered to stdout, may contain @板砖
 *                 dispatch triggers and inline tool envelopes.
 *   - "thought":  internal monologue, persisted but NEVER rendered. May
 *                 contain inline tool envelopes (planning reads). @板砖
 *                 in a thought is plain text — no dispatch (SPEC §3 F).
 *
 * Backward compatibility: pre-Slice-10 JSONL entries lack the field; the
 * v2-record-reader defaults missing `surface` to "speech" so old sessions
 * resume cleanly.
 *
 * `selfCorrection` (N8/N8b, 2026-05-23): set on a speech block that
 * was committed via the supervisor-veto retry path. Holds the
 * supervisor's veto reason verbatim. INVISIBLE to the CLI renderer
 * (the speech text alone reaches stdout), but the serializer
 * prepends it as `——<text>\n\n` prose before the speech envelope
 * so future-turn LLM prompts carry the lesson:
 *
 *   ——<correction>
 *
 *   （我 说）
 *   <speech>
 *   （/我 说）
 *
 * Without this anchor the model loses memory of "I was self-
 * corrected on X" the moment the turn ends, and the same mistake
 * (e.g. calling 瓦尔特 by 杨叔) repeats on every subsequent turn.
 * Only valid on `surface: "speech"`.
 */
export interface HertaBlock {
  readonly kind: "herta";
  readonly surface: "speech" | "thought";
  readonly text: string;
  readonly selfCorrection?: string;
  /** Wall-clock ISO time the block was emitted/persisted. See `UserBlock.at`. */
  readonly at?: string;
}

/**
 * Structured mirror of a done-marker's `body` roll-up, carried ALONGSIDE the
 * canonical `body` so a localizing renderer (the GUI) can compose a fully
 * translated summary without parsing the canonical Chinese string. The `body`
 * remains the single canonical shared-record text (what Herta's prompt and the
 * CLI renderer read, per D7); this field is display-only data for renderers
 * that translate. Only the done-marker carries it — the noop-marker needs no
 * counts, so it is recognised by `role: "noop-marker"` alone. Set ONLY by the
 * bridge (buildDoneMarker); absent on bus-streamed blocks and on records
 * persisted before this field existed (renderers fall back to `body`).
 */
export interface DoneMarkerSummary {
  readonly kind: "done";
  /** completed / blocked / failed / interrupted / partial — maps to
   *  完成/受阻/失败/中断/部分完成. */
  readonly state: ExecutionStatus;
  /** Count of changed files (0 when the run touched none). */
  readonly fileCount: number;
  /** Present only when the run executed ≥1 test; mirrors the `tests P/F` roll-up. */
  readonly tests?: { readonly passed: number; readonly failed: number };
  /** Count of residual risks flagged by the backend (0 when none). */
  readonly riskCount: number;
  /**
   * Total lines added / removed across the changed files (2026-08-25).
   *
   * Present only when EVERY changed file carried a per-file diff. A dispatch
   * that changed anything through a command — `sed -i`, a heredoc, an `mv` —
   * has no diff for that file, and a partial total would read as the whole
   * truth. Absent is the honest answer; the file count still stands.
   */
  readonly lines?: { readonly add: number; readonly del: number };
  /**
   * Git outcome identity (ADR 0049 §4): a commit is the one operation whose
   * IDENTITY is the outcome, and a marker that reports only file counts
   * drops it. `commit` is the short sha git's own summary line reported for
   * the run's LAST successful commit; `pushedRef` the destination branch of
   * its last successful push. Parsed deterministically from command output
   * by the bridge; absent when the run made no commit/push (the usual case).
   */
  readonly git?: {
    readonly commit?: string;
    readonly pushedRef?: string;
  };
  /** Set (only ever `true`) when the run TERMINATED ABNORMALLY — runBrief
   *  itself threw rather than returning a report (the bridge-failure marker,
   *  canonical body `失败 · 运行异常中止`). Neutral machine field (D2):
   *  localizing renderers compose "run aborted" / 运行异常中止 from it
   *  instead of fabricating a synthetic risk count. Absent on ordinary
   *  completion markers. */
  readonly aborted?: true;
  /** Set (only ever `true`) on the marker the harness wrote for a run the
   *  app exited during, when its session next opened (ADR 0071 §1.2;
   *  canonical segment `应用意外退出`, state `interrupted`). */
  readonly crashed?: true;
  /** Set (only ever `true`) when the run stopped at the harness's step limit
   *  (state `interrupted`, continuable; canonical segment `步数已达上限`,
   *  2026-09-29). */
  readonly stepLimit?: true;
}

/** How a step the app exited during ended, as far as the harness can tell
 *  (ADR 0071 §1.3). */
export type CutoffOutcome =
  /** Never dispatched: it waited for approval, or was queued behind another. */
  | "not_started"
  /** A read-only step cut short: no side effect. */
  | "read_interrupted"
  /** The file holds the written content. */
  | "write_applied"
  /** The file is as it was (or still absent). */
  | "write_not_applied"
  /** The file is neither: it was changed after the app exited. */
  | "write_changed_since"
  /** Harness state (findings): rebuilt from finished steps. */
  | "state_not_applied"
  /** A command, or anything else with side effects: it may have partly run. */
  | "outcome_unknown";

/** One step of the crash marker's `cutoff` section. */
export interface CutoffStep {
  /** The tool and its target: `edit_file src/a.ts`, `run_command npm test`. */
  readonly step: string;
  readonly outcome: CutoffOutcome;
}

/**
 * Structured digest data carried alongside a bus-projected system block's
 * rendered `body` (M-projection-3, 2026-07-04). Compaction
 * (`digestSystemBlock` in @herta/herta) previously regex-parsed the RENDERED
 * body strings back apart — a coupling that had already rotted twice
 * (summarizeInput's human-form args broke the `{"path":…}` patterns, and the
 * tests line moved label + format) with no error, only silently degraded
 * summaries. The writer (projectBackendEvent) now records WHAT the block is
 * as data; compaction renders digest lines from this and falls back to the
 * legacy regexes only for records persisted before the field existed.
 *
 * Same stance as `markerSummary`: the canonical `body` stays the single
 * shared-record text; this is derived data for downstream projections.
 */
/** What taking a turn's edits back did to one file (ADR 0074 §3). */
export type UndoFileResult =
  /** Its first bytes are back. */
  | "restored"
  /** The turn created it; it is gone again. */
  | "deleted"
  /** Already as it was. */
  | "unchanged"
  /** Changed since 板砖 wrote it: left alone, never overwritten. */
  | "changed_since"
  /** Its bytes were not kept (the bound, or a failed capture): left alone. */
  | "not_kept"
  /** No longer inside the workspace: refused. */
  | "outside_workspace"
  /** It should have been restored and the write failed: left as it was. */
  | "failed";

export type SystemBlockDigest =
  | {
      /** A workflow step ("Reading foo.ts") — verb from workflowLabel,
       *  arg from summarizeInput's human-facing argument. */
      readonly kind: "op";
      readonly verb:
        | "Reading"
        | "Writing"
        | "Running"
        | "Planning"
        | "Inspecting"
        | "Saving memory"
        /** search_text (2026-08-17; was `Reading "pattern"`). */
        | "Searching"
        /** command_stop (2026-08-17; was `Running bg-N`, which read as a
         *  second launch — Herta reads these rows). */
        | "Stopping"
        /** digest_document (ADR 0043): a side-model pass over a whole
         *  attached document — neither a read nor a run, and worth its own
         *  word because it spends model tokens. */
        | "Digesting";
      readonly arg: string;
    }
  | {
      /** A `digest_document` result (ADR 0043). The overview rides
       *  `evidenceDetail` (the two-state lane, like an excerpt); the digest
       *  keeps the citation — which document, where the sidecar is, how
       *  many chunks — so a later turn can send 板砖 back to the sidecar
       *  rather than re-digest. `cached` says no model ran this time. */
      readonly kind: "digest";
      /** The attachment's stored text (source). */
      readonly source: string;
      /** The `.digest.txt` sidecar. */
      readonly path: string;
      readonly chunks: number;
      readonly cached: boolean;
    }
  | {
      /** A recognized test run (run_command + detectTestRun). */
      readonly kind: "tests";
      readonly status: "passed" | "failed" | "skipped" | "not_run";
      readonly summary: string;
    }
  | {
      /** A failed tool call. */
      readonly kind: "tool-fail";
      readonly tool: string;
      readonly code: string;
      /** The failure message (2026-07-10): lets the GUI compose a LOCALIZED
       *  failure row without dropping the message the canonical body carries.
       *  Optional — absent on records persisted before it existed (renderers
       *  fall back to the body verbatim). Same trust class as the body
       *  (sanitized at projection). */
      readonly message?: string;
    }
  | {
      /** Contributes no digest line. Kept for records persisted before the
       *  `patch` digest below existed — the patch preview used to be the only
       *  producer, and a renderer must still fall back to its body. */
      readonly kind: "skip";
    }
  | {
      /**
       * A patch preview, with its MAGNITUDE (2026-08-25).
       *
       * The diff itself stays in the block body; the digest carries the
       * counts so a renderer can say `↳ +96 −5` without re-parsing the fence,
       * and so Herta reads the same number the user sees.
       *
       * `add`/`del` are absent when the change reached the tree through a
       * COMMAND rather than an editor — a `sed -i`, a heredoc, an `mv`. There
       * is no per-file diff for those, and rendering them as `+0 −0` would
       * state a number nobody measured.
       */
      readonly kind: "patch";
      readonly files: readonly string[];
      readonly add?: number;
      readonly del?: number;
    }
  | {
      /** A managed background command's lifecycle row (ADR 0025 slice 4;
       *  structured 2026-07-23 so renderers localize instead of falling back
       *  to the raw English chrome). */
      readonly kind: "bg";
      readonly id: string;
      readonly state: "running" | "stopped" | "exited";
      /** Present only for state "exited"; null = ended by signal/kill. */
      readonly exitCode?: number | null;
    }
  | {
      /** LEGACY — a todo-list projection from before ADR 0073 removed the
       *  backend's todo list. Nothing writes it now; records persisted
       *  earlier still carry it (a layout block, then `todo k/n: <current>`
       *  progress rows), so every reader must still recognise the kind. They
       *  skip it: it was working state, and the op rows beside it say what
       *  was done. The body stays in the record as Herta read it. */
      readonly kind: "todo";
      readonly total: number;
      readonly completed: number;
      readonly current?: string;
    }
  | {
      /** A `show_excerpt` presentation row (ADR 0027). The excerpt itself
       *  lives in `evidenceDetail` — prompt-visible for the turn, dropped
       *  when the block folds into the compaction summary — so the digest
       *  carries only the CITATION, which is what a later turn needs to know
       *  ("she was shown lines 120-140 of x.ts") without re-paying for the
       *  content. */
      readonly kind: "excerpt";
      readonly path: string;
      readonly from: number;
      readonly to: number;
    }
  | {
      /** A document the 开拓者 handed over (ADR 0033). Same lifecycle split as
       *  `excerpt` above and for the same reason: the head excerpt rides
       *  `evidenceDetail` and is dropped when the block folds, so the digest
       *  keeps only the CITATION — what the file is and where it sits. A later
       *  turn goes on knowing "开拓者 gave me a spec, it is at <path>" without
       *  re-paying for the text, and can reach the file again through 板砖. */
      readonly kind: "attachment";
      readonly name: string;
      /** Workspace-relative, so a later dispatch can reach it. */
      readonly path: string;
      /** The ORIGINAL document's stored copy (ADR 0038 amendment, 2026-09-03):
       *  `report-<hash>.pdf` beside the `.pdf.txt` above, kept so the file
       *  viewer (ADR 0054) can show the PDF / Word / spreadsheet / deck
       *  itself. USER-ONLY: it never enters the block body, a task line or a
       *  compaction line — 板砖 is never pointed at bytes no tool reads.
       *  Present for every document the ingest could store, extraction
       *  outcome aside (a scanned PDF, an .xlsx); absent for text and image
       *  attachments and on records persisted before it. */
      readonly source?: string;
      readonly lines: number;
      readonly chars: number;
      /** Set when the stored file is TEXT EXTRACTED from a PDF or Word
       *  document (ADR 0038): `path` then ends in `.pdf.txt` / `.docx.txt`,
       *  and the row and 板砖's citation say the text was extracted rather
       *  than letting a `.txt` path imply the user typed it. Absent for a
       *  plain text attachment and on records persisted before ADR 0038. */
      readonly format?: "pdf" | "docx";
      /** PDF page count, when the document opened far enough to know it —
       *  present on the ordinary path and on `too_large` (page cap) /
       *  `empty` (scanned) outcomes. */
      readonly pages?: number;
      /** An IMAGE attachment (ADR 0048): the stored file is the picture
       *  itself, and `caption` below — not an excerpt — is what the record
       *  says about it. Absent for every text/document attachment. */
      readonly image?: {
        readonly format: "png" | "jpeg" | "gif" | "webp" | "bmp";
        /** Pixel dimensions when the header format makes them cheap to read
         *  (PNG/GIF/JPEG); absent otherwise — never estimated. */
        readonly width?: number;
        readonly height?: number;
      };
      /**
       * What the captioning instrument saw (ADR 0048 §1).
       *
       * Unlike a head excerpt this is NOT a preview of something still
       * readable: it is the image's only textual form, which is why it rides
       * the block BODY rather than `evidenceDetail`. The detail is dropped
       * when the block folds; the caption must survive into recaps, dreams
       * and later sessions, because after the fold it is all that remains of
       * a moment the 开拓者 actually shared.
       *
       * Authored by a vision sidecar, never by Herta — the record keeps it in
       * the `→ 系统` register for exactly that reason. Same trust class as an
       * attachment's text: model output about user-supplied bytes, redacted
       * and sanitized at construction. Absent when captioning was unavailable
       * or failed (`unreadable: "no_caption"`).
       */
      readonly caption?: string;
      /** Why no excerpt was taken, when none was. Absent on the ordinary path.
       *  Present means the block's body SAYS the file could not be read as
       *  text — never silence, because Herta speaking about a document she was
       *  never shown is the failure supervisor rule 9 exists to prevent, one
       *  step upstream of 板砖.
       *
       *  `denied` is the credential guard (ADR 0033 review): the ingest
       *  refuses credential-shaped SOURCES (id_rsa, .env, anything under
       *  .ssh/) outright, because the stored name gains a hash suffix that
       *  the basename denylist no longer matches — deny-at-the-door is the
       *  only place the deny works. Nothing is stored for this state.
       *
       *  `removed` is the 开拓者 taking it back (2026-08-10). The block is
       *  MARKED, never deleted: block indices are counted by rewind, topic
       *  anchors and the sink cursor, and — the real reason — if Herta has
       *  already spoken about the document, erasing its citation would leave
       *  her own words referring to something that never happened. The file
       *  is gone from disk; the record still says one arrived and then went.
       *
       *  `encrypted` and `unsupported` arrived with ADR 0038: a
       *  password-protected PDF, and a document format we recognize but do
       *  not decode (legacy .doc/.xls/.ppt, .xlsx/.pptx, an OLE package named
       *  .docx). Both are actionable by the user in a way `read_error` /
       *  `binary` are not, which is why they are named. Nothing is stored for
       *  either.
       *
       *  `no_caption` is an IMAGE that was stored but not read (ADR 0048):
       *  no key, the instrument errored or timed out, or the picture is over
       *  the caption ceiling. Named rather than folded into `read_error`
       *  because the file IS on disk and IS citable — a vision-capable 板砖
       *  can still be sent to look at it, which is the remedy the row exists
       *  to leave open. */
      readonly unreadable?:
        | "binary"
        | "too_large"
        | "empty"
        | "read_error"
        | "denied"
        | "removed"
        | "encrypted"
        | "unsupported"
        | "no_caption";
      /** The exact page-marker line shape the stored text carries, with `N`
       *  for the number (`── 第 N 页 ──` / `── page N ──`; `pageMarkerShape`
       *  in core). PDF only, 2026-08-23: the ingest opens every page with
       *  that line so a page is a greppable, citable location rather than an
       *  estimate. Recorded here — not re-derived from the session language
       *  — so 板砖's citation quotes the shape the FILE has. Absent for
       *  Word/text attachments and on records persisted before it existed. */
      readonly pageMarker?: string;
      /** A deterministic outline stored beside the text (2026-08-23): PDF
       *  bookmarks (`getOutline`) or Word heading styles, one line per entry
       *  with the page (PDF) and the line it starts at. Absent when the
       *  document carries none — Chrome-printed PDFs, plain letters — so its
       *  presence is itself a fact about the file, never a guess. */
      readonly outline?: {
        /** Workspace-relative sidecar path (`…pdf.outline.txt`). */
        readonly path: string;
        readonly entries: number;
      };
    }
  | {
      /** A search_text result (2026-08-17). Same lifecycle split as `excerpt`:
       *  the matched lines ride `evidenceDetail` (verbatim this turn, dropped
       *  on fold); the digest keeps the CITATION — what was searched and how
       *  much it found — so a later turn knows a search happened without
       *  re-paying for the lines. Before this row existed a search's only
       *  trace was its op row, and 板砖's "found 5 matches" reached nobody. */
      readonly kind: "search";
      /** The pattern as the model wrote it (backend-derived; sanitized). */
      readonly pattern: string;
      readonly matches: number;
      readonly files: number;
      /** The tool clipped its own result (maxMatches / scan budget). */
      readonly truncated: boolean;
    }
  | {
      /** A conclusion the backend recorded via `report_finding` (ADR 0039).
       *  Unlike excerpt/search this is NOT two-state: the claim IS the
       *  deliverable, short by schema, and it survives compaction whole —
       *  the citations make it checkable, and Herta may send 板砖 back to
       *  any of them. */
      readonly kind: "finding";
      readonly claim: string;
      readonly cites: readonly string[];
    }
  | {
      /** The 开拓者 took the latest turn's edits back (ADR 0074 §4): what
       *  happened to each file, and what commands changed (never restored).
       *  Display-only, like every digest — Herta reads the body, which
       *  names the same results; this lets the turn's card show them per
       *  file without parsing it. Paths are workspace-relative. */
      readonly kind: "undo";
      readonly files: readonly {
        readonly path: string;
        readonly result: UndoFileResult;
      }[];
      readonly commands: readonly string[];
      /** Commands ran, and what they changed could not be read. */
      readonly commandsUnknown: boolean;
      /** Some of the turn's bytes were never kept. */
      readonly incomplete: boolean;
    }
  | {
      /** No richer structure — digest to the text's first line, truncated. */
      readonly kind: "text";
      readonly text: string;
      /** Structured mirror of a run_command exit row (2026-07-10): lets the
       *  GUI compose a localized "↳ exit N · M lines" without parsing the
       *  body. Both optional — absent on non-exit text digests and on records
       *  persisted before they existed (fall back to the body/text). */
      readonly exitCode?: number | null;
      readonly lineCount?: number;
    };

/**
 * One labelled section of a system block's `evidenceDetail`, carried ALONGSIDE
 * the canonical string so a localizing renderer can compose a translated
 * detail pane instead of printing harness-authored Chinese at an English
 * reader (`↳ 输出:`, `↳ 摘录`, `↳ 改动文件:`).
 *
 * Same stance as `markerSummary` and `digest`, and the same reason: the detail
 * string is assembled from these very values, so a renderer that needed them
 * back would have to regex the rendered text apart — the coupling ADR 0018's
 * display-localization pattern exists to avoid. `evidenceDetail` stays the
 * single canonical text (it is what Herta's prompt reads, what compaction
 * folds, and what the record persists); this is display-only data.
 *
 * The payload strings — command output, excerpt bodies, file paths, risk and
 * todo text — are backend-derived and stay VERBATIM in every language. Only
 * the section's label is a translation.
 */
export type EvidenceSection =
  | {
      /** A bounded command-output tail (`↳ 输出:`). */
      readonly kind: "output";
      readonly text: string;
    }
  | {
      /** A show_excerpt body with its citation (`↳ 摘录 path:from-to`). */
      readonly kind: "excerpt";
      readonly path: string;
      readonly from: number;
      readonly to: number;
      readonly text: string;
    }
  | {
      /** The done-marker's changed-file list (`↳ 改动文件:`). */
      readonly kind: "files";
      readonly paths: readonly string[];
    }
  | {
      /** The done-marker's residual risks (`↳ 风险:`). */
      readonly kind: "risks";
      readonly items: readonly string[];
    }
  | {
      /** LEGACY — the done-marker's unfinished todos (`↳ 待办:`), written
       *  before ADR 0073 removed the backend's todo list. Records persisted
       *  earlier still carry it, and a renderer still shows it: it is part
       *  of what that run reported. */
      readonly kind: "todos";
      readonly items: readonly string[];
    }
  | {
      /** The done-marker's evidence roll-up (`↳ 依据:`) — the backend's own
       *  structured findings (`AgentExecutionReport.evidence`), one summary
       *  line per item.
       *
       *  Added because their ABSENCE was a fabrication site (persona re-test
       *  2026-08-11, finding R-1): a run that ended `部分完成` with no
       *  changed files, no risks and no todos put a marker in the record that
       *  said a dispatch happened and nothing whatsoever about what it found.
       *  Asked what 板砖 concluded, Herta narrated a detailed critique that
       *  appears nowhere — the same geometry as the announce-without-dispatch
       *  gateway: an expectation the record leaves unanswered gets filled by
       *  fluency. These summaries are harness-collected facts, not a
       *  model-authored précis, so projecting them keeps D6 intact (the
       *  report has structured artifacts and deliberately NO Summary field —
       *  Herta must not paraphrase the agent, but she must be able to SEE
       *  it). */
      readonly kind: "evidence";
      readonly items: readonly string[];
    }
  | {
      /** An attached document's head excerpt (`↳ 附件 <name>`). Verbatim from
       *  disk — the harness cut it, so nothing paraphrased it on the way in
       *  (ADR 0033, the same reflex as `show_excerpt`). */
      readonly kind: "attachment";
      readonly name: string;
      readonly path: string;
      readonly text: string;
      /** The head stopped at the presentation bound and the file continues.
       *  Rendered as a note so neither reader mistakes the head for the whole
       *  document. */
      readonly clipped: boolean;
    }
  | {
      /** An attached document's outline (`↳ 目录`), 2026-08-23 — the first
       *  entries of the sidecar the ingest wrote from the PDF's bookmarks or
       *  the Word heading styles, verbatim. Bounded like the head; `total`
       *  says how many the sidecar holds so a preview never reads as the
       *  whole table of contents. Rides `evidenceDetail`'s lifecycle: in
       *  front of Herta while the attachment is fresh, a citation after. */
      readonly kind: "outline";
      readonly name: string;
      /** The sidecar's workspace-relative path. */
      readonly path: string;
      readonly items: readonly string[];
      readonly total: number;
    }
  | {
      /** A document digest's overview (`↳ 摘要`), ADR 0043 — MODEL-GENERATED,
       *  unlike every other section here, and labeled so in the record: a
       *  reader must not take it for the document. `source` names the text
       *  it summarizes; `path` the sidecar holding the per-chunk entries. */
      readonly kind: "digest";
      readonly source: string;
      readonly path: string;
      readonly chunks: number;
      readonly text: string;
    }
  | {
      /** The crash marker's open steps (`↳ 中断时:`), ADR 0071 §1.2: each
       *  step that had no result when the app exited, with the outcome the
       *  harness decided for it. Structured, so a renderer localizes the
       *  outcome words; the steps themselves are verbatim. */
      readonly kind: "cutoff";
      readonly steps: readonly CutoffStep[];
    }
  | {
      /** The done-marker's conclusions (`↳ 结论:`) — the backend's own cited
       *  findings (ADR 0039), one `claim（cites）` per item, listed apart from
       *  the `evidence` receipts because a claim and a receipt are different
       *  kinds of fact. */
      readonly kind: "findings";
      readonly items: readonly string[];
    }
  | {
      /** A search_text hit list (`↳ 匹配 /pattern/:`), one `path:line: content`
       *  item per match, bounded by the bridge (2026-08-17). `omitted` counts
       *  the matches the bound dropped, so neither reader takes the list for
       *  the whole result. Content is already secret-redacted by the tool. */
      readonly kind: "matches";
      readonly pattern: string;
      readonly items: readonly string[];
      readonly omitted: number;
    }
  | {
      /** A failed tool call's own `suggestion` (`↳ 提示:`), 2026-08-17 — the
       *  same sentence the model reads about what went wrong and how to
       *  fix it, so Herta's commentary on a failure is grounded in the
       *  tool's diagnosis rather than her guess at one. */
      readonly kind: "hint";
      readonly text: string;
    }
  | {
      /** The bridge-failure marker's raw error text (`↳ 错误:`). */
      readonly kind: "error";
      readonly message: string;
    };

/**
 * A harness-authored block. The label is one of the two canonical
 * SystemBlockLabel values; "板砖" is not a valid label and must never
 * be constructed (enforced at runtime by the forged-label guard in
 * @herta/herta's serializeTerminalRecord — the funnel every LLM-facing
 * projection passes through — SPEC §5.3).
 */
export interface SystemBlock {
  readonly kind: "system";
  readonly label: SystemBlockLabel;
  readonly body: string;
  /**
   * Fuller evidence (e.g. a bounded command-output tail, or the done-marker
   * roll-up) for Herta's prompt ONLY. INVISIBLE to the CLI renderer — exactly
   * like HertaBlock.selfCorrection. The prompt serializer (serialize.ts)
   * appends it after the body; the CLI renderer (narrative-renderer.ts) reads
   * only `body`. Keeps the screen terse while Herta gets the detail (D7:
   * same record, different overlays). Full output also persists in .herta/logs/.
   */
  readonly evidenceDetail?: string;
  /**
   * Structured mirror of `evidenceDetail` for localizing renderers. See
   * `EvidenceSection`. Set ONLY by the bridge, from the same values that
   * compose the canonical string; absent on records persisted before it
   * existed (renderers fall back to `evidenceDetail` verbatim). Display-only —
   * invisible to Herta's prompt (serialize.ts reads body + evidenceDetail).
   */
  readonly evidence?: readonly EvidenceSection[];
  /**
   * Structural discriminator for a bridge-SYNTHESIZED terminal block (NOT a
   * bus projection). "done-marker" on the run-terminal completion block;
   * "noop-marker" on the 无产出 no-op block. Set ONLY by the bridge
   * (buildDoneMarker / buildNoopMarker); projectBackendEvent never sets it.
   * Used by compaction — done-marker gets the two-state pass-through
   * lifecycle, noop-marker digests to （板砖无产出）. The marker reaches the
   * live record stream like any other block: the bridge appends it to the
   * record and calls sink.flushBlocks (the single canonical-diff projection,
   * 2026-06-01), so no role-aware emit special-casing is needed. Bus-streamed
   * system blocks have no role.
   */
  readonly role?: "done-marker" | "noop-marker";
  /**
   * Structured roll-up mirroring the done-marker `body` for localizing
   * renderers. See `DoneMarkerSummary`. Set ONLY on done-marker blocks by the
   * bridge; the canonical `body` stays authoritative. Display-only — invisible
   * to Herta's prompt (serialize.ts reads body + evidenceDetail, never this).
   */
  readonly markerSummary?: DoneMarkerSummary;
  /**
   * Structured digest data for compaction. See `SystemBlockDigest`. Set by
   * projectBackendEvent on bus-projected blocks; absent on bridge-built
   * marker blocks (their `role` drives compaction) and on records persisted
   * before this field existed (compaction falls back to legacy body
   * parsing). Survives the JSONL round-trip like any other block field.
   */
  readonly digest?: SystemBlockDigest;
  /** Wall-clock ISO time the block was emitted/persisted. See `UserBlock.at`. */
  readonly at?: string;
}

export type TerminalRecordBlock = UserBlock | HertaBlock | SystemBlock;

/**
 * The durable canonical narrative record shared between user and Herta
 * (SPEC §4.2). Both the user terminal renderer and the Herta completion
 * actor consume TerminalRecord. Approval overlay state lives separately
 * in ApprovalOverlayState and is never folded into this record.
 */
export type TerminalRecord = readonly TerminalRecordBlock[];
