/**
 * The record projection of the backend's work (D7): every pure function
 * that turns an `AgentEvent` — or the run's end — into the `→ 系统` /
 * `→ 差分协处理器` blocks the TerminalRecord carries. Split out of
 * backend-bridge.ts on 2026-09-11 (the post-0.1.5 refactor pass): the
 * bridge drains the bus and fires beats; what a block LOOKS like lives
 * here, importable by tests and renderers without the bridge's runtime.
 * Behaviour-neutral: the bodies moved unchanged.
 */
import type {
  AgentEvent,
  AgentExecutionReport,
  DigestDocumentData,
  DoneMarkerSummary,
  EvidenceSection,
  RunCommandData,
  SearchTextData,
  ShowExcerptData,
  SystemBlock,
  SystemBlockDigest,
  TodoDigestItem,
  TodoItem,
  TodoStatus,
} from "@herta/core";
import {
  composeMarkerSummary,
  countDiffLines as countDiffLinesShared,
  type MarkerSummaryLabels,
} from "@herta/core";
import { boundedTail } from "./bounded-tail.js";
import { sanitizeActorText } from "./escape.js";
import type { GitOutcome } from "./git-outcome.js";

/** system-body sanitize for one string field (see `sanitizeSystemBlock`). */
export function cleanBody(s: string): string {
  return sanitizeActorText(s, { role: "system-body" });
}

/** Sanitize a digest's backend-derived string fields. Compaction renders
 *  digests into `[历史已压缩 · 板砖]` summary bodies that reach prompts, so a
 *  hostile inputSummary must not launder a forged marker through them.
 *  Union-typed literals (`verb`, `status`) are harness-authored — untouched. */
export function sanitizeDigest(digest: SystemBlockDigest): SystemBlockDigest {
  switch (digest.kind) {
    case "op":
      return { ...digest, arg: cleanBody(digest.arg) };
    case "tests":
      return { ...digest, summary: cleanBody(digest.summary) };
    case "tool-fail":
      return {
        ...digest,
        tool: cleanBody(digest.tool),
        code: cleanBody(digest.code),
        ...(digest.message !== undefined
          ? { message: cleanBody(digest.message) }
          : {}),
      };
    case "text":
      return { ...digest, text: cleanBody(digest.text) };
    case "bg":
      // `id` is harness-generated (BackgroundHost) but rides the same
      // sanitize as every other string field — fail closed.
      return { ...digest, id: cleanBody(digest.id) };
    case "excerpt":
      // `path` is backend-derived like every other string field; the line
      // numbers are harness-computed and pass through.
      return { ...digest, path: cleanBody(digest.path) };
    case "search":
      // The pattern is model-authored; the counts are harness-computed.
      return { ...digest, pattern: cleanBody(digest.pattern) };
    case "patch":
      // Paths are backend-derived; the counts are harness-computed from the
      // diff text and pass through.
      return { ...digest, files: digest.files.map(cleanBody) };
    case "finding":
      // Claim AND cites are model-authored (the cites were verified to
      // exist, not to be free of markers).
      return {
        ...digest,
        claim: cleanBody(digest.claim),
        cites: digest.cites.map(cleanBody),
      };
    case "todo":
      // Every string here is backend-authored item text: `current` (the
      // in-flight step) and each `items[].content` (the full list both todo
      // block kinds carry). Sanitize all of them — a renderer prints the
      // items, and compaction may yet learn to. Counts and the `status`
      // literals (a harness-owned enum) pass through.
      return {
        ...digest,
        ...(digest.current === undefined
          ? {}
          : { current: cleanBody(digest.current) }),
        ...(digest.items === undefined
          ? {}
          : {
              items: digest.items.map((item) => ({
                ...item,
                content: cleanBody(item.content),
              })),
            }),
      };
    case "attachment":
      // The filename and path come from OUTSIDE the workspace — the user
      // picked them — so they are the least trusted strings in this union.
      // Counts and the `unreadable` literal are harness-computed.
      return {
        ...digest,
        name: cleanBody(digest.name),
        path: cleanBody(digest.path),
        ...(digest.outline === undefined
          ? {}
          : {
              outline: {
                ...digest.outline,
                path: cleanBody(digest.outline.path),
              },
            }),
      };
    case "digest":
      // Two paths from the filesystem; counts and the flag are harness-made.
      return {
        ...digest,
        source: cleanBody(digest.source),
        path: cleanBody(digest.path),
      };
    case "skip":
      return digest;
  }
}

/** Sanitize an evidence section's backend-derived strings. Every field here is
 *  the same text that composes `evidenceDetail` — command output, excerpt
 *  bodies, repo paths, risk/todo/error prose — so it rides the same cleaner.
 *  A renderer prints these, and skipping them would let a hostile diff forge a
 *  role marker in the detail pane that the canonical string cannot carry. */
export function sanitizeSection(s: EvidenceSection): EvidenceSection {
  switch (s.kind) {
    case "output":
      return { ...s, text: cleanBody(s.text) };
    case "excerpt":
      // Line numbers are harness-computed and pass through.
      return { ...s, path: cleanBody(s.path), text: cleanBody(s.text) };
    case "files":
      return { ...s, paths: s.paths.map(cleanBody) };
    case "risks":
    case "todos":
    case "evidence":
    case "findings":
      return { ...s, items: s.items.map(cleanBody) };
    case "matches":
      // Matched lines come from files a hostile repo (or document) can shape;
      // the pattern from the model. Both ride the cleaner.
      return {
        ...s,
        pattern: cleanBody(s.pattern),
        items: s.items.map(cleanBody),
      };
    case "attachment":
      // `text` is the head of a document the user supplied, so this is the
      // one section whose content never passed through the repo or the
      // backend at all. A planted （我 说） in an uploaded file must not be
      // able to forge an actor block any more than one in a source file can.
      return {
        ...s,
        name: cleanBody(s.name),
        path: cleanBody(s.path),
        text: cleanBody(s.text),
      };
    case "outline":
      // The document's own headings — user-supplied text like the head
      // above, and the same forgery surface.
      return {
        ...s,
        name: cleanBody(s.name),
        path: cleanBody(s.path),
        items: s.items.map(cleanBody),
      };
    case "digest":
      // Model-authored text about a user document: both untrusted origins
      // at once, so it rides the cleaner like everything else.
      return {
        ...s,
        source: cleanBody(s.source),
        path: cleanBody(s.path),
        text: cleanBody(s.text),
      };
    case "error":
      return { ...s, message: cleanBody(s.message) };
    case "hint":
      // Harness-authored in every shipped tool, but a tool is a plugin
      // seam — clean it like the rest.
      return { ...s, text: cleanBody(s.text) };
  }
}

// No `default` arm, deliberately: a future section kind must fail the
// exhaustiveness check here rather than slip through the trust boundary
// unsanitized. (Extracted from the map callback so the exhaustive switch and
// biome's always-return-a-value rule can both hold.)
export function sanitizeEvidence(
  sections: readonly EvidenceSection[],
): readonly EvidenceSection[] {
  return sections.map(sanitizeSection);
}

/**
 * The system-block half of the slice-2 trust boundary: every block the
 * bridge appends to the record carries backend-derived text (tool
 * argv summaries, command output tails, diffs, error messages) that a
 * hostile repo or provider can shape. Neutralize cross-role markers and
 * strip display-unsafe characters at construction so a diff can never
 * open a fake （开拓者 说） block or plant a forged label in tomorrow's
 * prompt. `evidenceDetail` is prompt-only, `digest` feeds compaction
 * summaries, and `evidence` feeds the localized detail pane — all the same
 * trust class as `body`.
 */
// Exported for the ADR 0033 attachment producer (app-server): attachment
// blocks are the one system-block shape built OUTSIDE this bridge, and the
// serializer does NOT sanitize system bodies at read — construction is the
// only gate. Everything bridge-internal keeps calling it directly.
export function sanitizeSystemBlock(block: SystemBlock): SystemBlock {
  return {
    ...block,
    body: cleanBody(block.body),
    ...(block.evidenceDetail !== undefined
      ? { evidenceDetail: cleanBody(block.evidenceDetail) }
      : {}),
    ...(block.evidence !== undefined
      ? { evidence: sanitizeEvidence(block.evidence) }
      : {}),
    ...(block.digest !== undefined
      ? { digest: sanitizeDigest(block.digest) }
      : {}),
  };
}

/** Presentation bounds for a projected search-hit list. Lines/chars match
 *  show_excerpt's presentation lane (this is reading, not a log tail); the
 *  per-line clip keeps a minified one-liner from eating the whole budget. */
const SEARCH_ROW_MAX_ITEMS = 40;
const SEARCH_ROW_MAX_CHARS = 4000;
const SEARCH_ROW_MAX_LINE_CHARS = 200;

/**
 * `↳ N matches in M files` with the hit list in the two-state evidence lane.
 * Item shape `path:line: content` — the citation form 板砖 and Herta both
 * already use for excerpts, so a later "show me line 33" is one hop away.
 */
export function projectSearchResult(data: SearchTextData): SystemBlock {
  const total = data.matches.length;
  const files = new Set(data.matches.map((m) => m.path)).size;
  const body =
    total === 0
      ? `↳ 0 matches${data.truncated ? " (truncated)" : ""}`
      : `↳ ${total} matches in ${files} files${data.truncated ? " (truncated)" : ""}`;
  const items: string[] = [];
  let chars = 0;
  for (const m of data.matches) {
    if (items.length >= SEARCH_ROW_MAX_ITEMS) break;
    const content =
      m.content.length > SEARCH_ROW_MAX_LINE_CHARS
        ? `${m.content.slice(0, SEARCH_ROW_MAX_LINE_CHARS)}…`
        : m.content;
    const item = `${m.path}:${m.line}: ${content}`;
    if (chars + item.length > SEARCH_ROW_MAX_CHARS && items.length > 0) break;
    items.push(item);
    chars += item.length + 1;
  }
  const omitted = total - items.length;
  const block: SystemBlock = {
    kind: "system",
    label: "差分协处理器",
    body,
    digest: {
      kind: "search",
      pattern: data.pattern,
      matches: total,
      files,
      truncated: data.truncated,
    },
  };
  if (items.length === 0) return block;
  const detailLines = [`↳ 匹配 /${data.pattern}/:`, ...items];
  if (omitted > 0) detailLines.push(`（另有 ${omitted} 处未列出）`);
  return {
    ...block,
    evidenceDetail: detailLines.join("\n"),
    evidence: [{ kind: "matches", pattern: data.pattern, items, omitted }],
  };
}

/**
 * Pure projection from a backend-layer bus event to a `→ 差分协处理器`
 * or `→ 系统` SystemBlock. Returns `null` for events that should not
 * appear in TerminalRecord — actor-layer events (D6), happy-path tool
 * finishes (the workflow-start block already covers the user-visible
 * beat), and turn-lifecycle events. Every non-null block is passed
 * through `sanitizeSystemBlock` (slice 2) before it reaches a caller.
 *
 * Mapping per SPEC v0.2 §5.3, §7.3:
 *   tool.call.started (backend, known workflow kind) → → 差分协处理器  "<verb> <inputSummary>"
 *   tool.call.finished (failure)                     → → 系统          "↳ failed: <code>: <message>"
 *   patch.preview                                    → → 系统          "patch preview: <files>\n```diff\n...\n```"
 *   permission.requested                             → null (N3 — the resolver's interactive prompt is the user-facing surface)
 *   permission.resolved                              → null (compaction-companion 2026-05-24 — outcomes no longer enter the record)
 */
export function projectBackendEvent(event: AgentEvent): SystemBlock | null {
  const block = projectBackendEventUnsanitized(event);
  return block === null ? null : sanitizeSystemBlock(block);
}

export function projectBackendEventUnsanitized(
  event: AgentEvent,
): SystemBlock | null {
  if (event.layer !== "backend") return null;

  switch (event.type) {
    case "tool.call.started": {
      // todo_write projects from `plan.updated` instead (2026-07-23): the
      // event carries the full structured list, so the drain emits the first
      // layout block + compact "todo k/n: <current>" progress rows. A
      // started-row here would double-project every update ("Planning 2/3"
      // AND the progress row); a FAILED todo_write still surfaces via the
      // tool.call.finished failure row below.
      if (event.tool === "todo_write") return null;
      const label = workflowLabel(event.tool, event.inputSummary);
      if (label === null) return null;
      // The editor's summary leads with its command word so the verb can be
      // chosen; the row itself reads like edit_file's (`Writing <path>`).
      const arg =
        event.tool === "str_replace_editor"
          ? event.inputSummary
              .replace(/^(view|create|str_replace|insert)\s*/, "")
              .trim()
          : event.inputSummary.trim();
      const body = `${label} ${arg}`.trim();
      return {
        kind: "system",
        label: "差分协处理器",
        body,
        // Structured digest (M-projection-3): compaction digests from THIS,
        // not by regex-parsing the rendered body back apart.
        digest: { kind: "op", verb: label, arg },
      };
    }

    case "tool.call.finished": {
      if (event.result.ok) {
        // show_excerpt exists to be SEEN (ADR 0027): the excerpt rides
        // `evidenceDetail`, which is the two-state lane — verbatim in
        // Herta's prompt for the turn it happened, then dropped when the
        // block folds into the compaction summary. Deliberately NOT the
        // body: bodies become digest lines, so content there would either
        // bloat the digest or survive verbatim into every later prompt.
        if (event.tool === "show_excerpt") {
          const data = event.result.data as ShowExcerptData | undefined;
          if (data === undefined) return null;
          return {
            kind: "system",
            label: "差分协处理器",
            body: `↳ excerpt ${data.relPath}:${data.range[0]}-${data.range[1]}${
              data.truncated ? " (truncated)" : ""
            }`,
            digest: {
              kind: "excerpt",
              path: data.relPath,
              from: data.range[0],
              to: data.range[1],
            },
            evidenceDetail: `↳ 摘录 ${data.relPath}:${data.range[0]}-${data.range[1]}\n${data.excerpt}`,
            evidence: [
              {
                kind: "excerpt",
                path: data.relPath,
                from: data.range[0],
                to: data.range[1],
                text: data.excerpt,
              },
            ],
          };
        }
        // A recorded conclusion (ADR 0039). The claim is the deliverable of
        // an analysis brief, so it is the BODY — short by schema, kept whole
        // through compaction — with its citations, so the reader can check.
        if (event.tool === "report_finding") {
          const data = event.result.data as
            | { claim?: unknown; cites?: unknown }
            | undefined;
          if (typeof data?.claim !== "string") return null;
          const cites = Array.isArray(data.cites)
            ? data.cites.filter((c): c is string => typeof c === "string")
            : [];
          return {
            kind: "system",
            label: "差分协处理器",
            body: `↳ finding: ${data.claim}${cites.length > 0 ? ` — ${cites.join(", ")}` : ""}`,
            digest: { kind: "finding", claim: data.claim, cites },
          };
        }
        // search_text surfaces its hits (2026-08-17). Same reasoning as
        // show_excerpt and for the same lane: a search's op row said only that
        // a search happened, so "which lines mention X" — the answer 板砖 was
        // sent for — reached nobody unless it re-presented the lines. Bounded
        // hard: this is a hit list, not the files.
        if (event.tool === "search_text") {
          const data = event.result.data as SearchTextData | undefined;
          if (data === undefined || !Array.isArray(data.matches)) return null;
          return projectSearchResult(data);
        }
        // digest_document (ADR 0043): the overview rides the two-state lane
        // like an excerpt — in front of Herta this turn, a citation after —
        // and the row says what the sidecar is and how many chunks it holds.
        // Labeled MODEL-GENERATED in the detail: it is the one evidence
        // section in the record that a model wrote about the user's document.
        if (event.tool === "digest_document") {
          const data = event.result.data as DigestDocumentData | undefined;
          if (
            data === undefined ||
            typeof data.digestPath !== "string" ||
            typeof data.overview !== "string"
          )
            return null;
          const overview = data.overview.trim();
          return {
            kind: "system",
            label: "差分协处理器",
            body: `↳ digest ${data.digestPath} · ${data.chunks} chunks${
              data.cached ? " (cached)" : ""
            }`,
            digest: {
              kind: "digest",
              source: data.relPath,
              path: data.digestPath,
              chunks: data.chunks,
              cached: data.cached,
            },
            ...(overview.length > 0
              ? {
                  evidenceDetail: `↳ 摘要 ${data.relPath}（模型生成，共 ${data.chunks} 段，分段摘要见 ${data.digestPath}）\n${overview}`,
                  evidence: [
                    {
                      kind: "digest" as const,
                      source: data.relPath,
                      path: data.digestPath,
                      chunks: data.chunks,
                      text: overview,
                    },
                  ],
                }
              : {}),
          };
        }
        // Success: run_command (incl. the background trio) surfaces a result
        // block — its output is otherwise invisible. The minimal contract's
        // `bash` (ADR 0040) returns the same RunCommandData and gets the same
        // rows. Other tools' successes stay silent; their Writing/Reading
        // start-line already covered them.
        if (
          event.tool !== "run_command" &&
          event.tool !== "bash" &&
          event.tool !== "command_output" &&
          event.tool !== "command_stop"
        )
          return null;
        const data = event.result.data as Partial<RunCommandData> | undefined;
        if (data === undefined) return null;

        // Managed background commands (ADR 0025 slice 4): a "background …"
        // status row instead of an exit row, so the record shows a dev
        // server as running rather than "exit ?". Structured `bg` digest
        // (2026-07-23) lets renderers localize; a null exitCode means the
        // process ended by signal/kill — never render a literal "null".
        if (data.backgroundId !== undefined) {
          const bgState =
            event.tool === "command_stop"
              ? "stopped"
              : data.running === true
                ? "running"
                : "exited";
          const bgVerb =
            bgState === "exited"
              ? data.exitCode === null || data.exitCode === undefined
                ? "exited (signal)"
                : `exited (${data.exitCode})`
              : bgState;
          const bgStdout = (data.stdout ?? "").trimEnd();
          const bgTail =
            event.tool === "command_output" && bgStdout.length > 0
              ? boundedTail(data.stdout ?? "", "", { sourceTruncated: false })
              : { text: "" };
          return {
            kind: "system",
            label: "差分协处理器",
            body: `↳ background ${data.backgroundId}: ${bgVerb}`,
            digest: {
              kind: "bg",
              id: data.backgroundId,
              state: bgState,
              ...(bgState === "exited"
                ? { exitCode: data.exitCode ?? null }
                : {}),
            },
            ...(bgTail.text.length > 0
              ? {
                  evidenceDetail: `↳ 输出:\n${bgTail.text}`,
                  evidence: [{ kind: "output", text: bgTail.text }] as const,
                }
              : {}),
          };
        }

        // Test runs: terse tests line, no output detail (the testRun summary
        // is complete on its own).
        if (data.testRun !== undefined) {
          return {
            kind: "system",
            label: "差分协处理器",
            body: `↳ tests: ${data.testRun.summary}`,
            digest: {
              kind: "tests",
              status: data.testRun.status,
              summary: data.testRun.summary,
            },
          };
        }

        // Non-test: terse exit + line-count body; bounded output tail in detail.
        // exitCode is null only on signal/timeout; on the success path a real
        // timeout returns ok:false, so the timedOut branch here is defensive.
        const exitText =
          data.exitCode === null || data.exitCode === undefined
            ? data.timedOut === true
              ? "timed out"
              : data.signal != null
                ? `signal ${data.signal}`
                : "exit ?"
            : `exit ${data.exitCode}`;
        const stdout = data.stdout ?? "";
        const stderr = data.stderr ?? "";
        const trimmedStdout = stdout.trimEnd();
        const lineCount =
          trimmedStdout.length > 0 ? trimmedStdout.split("\n").length : 0;
        const body = `↳ ${exitText} · ${lineCount} lines`;
        const tail = boundedTail(stdout, stderr, {
          logPath: data.logPath,
          sourceTruncated:
            data.stdoutTruncated === true || data.stderrTruncated === true,
        });
        return {
          kind: "system",
          label: "差分协处理器",
          body,
          // exitCode/lineCount mirror the body's numbers so the GUI can
          // compose a localized exit row (2026-07-10); the canonical body
          // stays authoritative for prompts/compaction. Only stamped for a
          // REAL exit code — signal/timeout rows fall back to the body.
          digest: {
            kind: "text",
            text: body,
            ...(typeof data.exitCode === "number"
              ? { exitCode: data.exitCode, lineCount }
              : {}),
          },
          ...(tail.text.length > 0
            ? {
                evidenceDetail: `↳ 输出:\n${tail.text}`,
                evidence: [{ kind: "output", text: tail.text }] as const,
              }
            : {}),
        };
      }
      // Failure path (structured digest; `message` added 2026-07-10 so the
      // GUI's localized failure row keeps it).
      const err = event.result.error;
      const code = err?.code ?? "unknown";
      // Permission outcomes are exempt (D7 / audit 2026-07-10, finding 5):
      // projecting the denied gate's tool result put "↳ edit_file failed:
      // permission_denied: User denied edit_file" into the canonical record —
      // persisted, streamed, and fed to Herta's prompt — while the
      // permission.requested/resolved cases below correctly return null.
      // Permission is fully user-machine; the record shows only operations
      // that actually ran. Deterministic rule-denies (command_blocked,
      // path_denied, …) still project — those are harness refusals, not user
      // clicks. Mirrors beat-policy.ts's identical exemption.
      if (code === "permission_denied" || code === "permission_failed") {
        return null;
      }
      const message = err?.message ?? "(no message)";
      // The tool's own `suggestion` rides the two-state lane (2026-08-17).
      // Herta reads failure rows and comments on them; with only `code:
      // message` in front of her she diagnosed a search_text refusal as
      // 板砖 "confusing a file with a folder" when the tool had demanded a
      // directory (real session 2026-08-16). The model-facing hint says
      // what actually went wrong and what fixes it — she should read the
      // same sentence 板砖 does, for the turn it happens in.
      const suggestion =
        typeof event.result.suggestion === "string" &&
        event.result.suggestion.trim().length > 0
          ? event.result.suggestion.trim()
          : undefined;
      return {
        kind: "system",
        label: "系统",
        body: `↳ ${event.tool} failed: ${code}: ${message}`,
        digest: { kind: "tool-fail", tool: event.tool, code, message },
        ...(suggestion !== undefined
          ? {
              evidenceDetail: `↳ 提示: ${suggestion}`,
              evidence: [{ kind: "hint", text: suggestion }] as const,
            }
          : {}),
      };
    }

    case "patch.preview": {
      const files = event.files.join(", ");
      const counts = countDiffLines(event.diff);
      // The magnitude goes in the canonical body too, not just the digest:
      // Herta reads this record (D7) and "改了 96 行" is exactly the kind of
      // thing she should be able to say without opening the diff.
      const head =
        counts === null
          ? `patch preview: ${files}`
          : `patch preview: ${files} (+${counts.add} -${counts.del})`;
      const body = [head, "", "```diff", event.diff.trimEnd(), "```"].join(
        "\n",
      );
      return {
        kind: "system",
        label: "系统",
        body,
        digest: {
          kind: "patch",
          files: [...event.files],
          ...(counts ?? {}),
        },
      };
    }

    case "permission.requested": {
      // N3 (2026-05-23): the resolver's interactive `[y/a/N]`
      // prompt IS the user-facing permission request. Projecting
      // a parallel system block here meant two writers landed on
      // stdout for the same logical event — and because the
      // resolver writes synchronously while the bridge drain is
      // on a setImmediate cycle, the system block always raced
      // with the prompt. Dropping the projection eliminates the
      // duplicate. Per CLAUDE.md D7 permission is fully
      // user-machine: NEITHER the request NOR the outcome enters
      // the record (`permission.resolved` below also returns
      // null). The proposed operation reaches the record only
      // through the resulting → 系统 Writing / Running blocks
      // once it actually runs.
      return null;
    }

    case "permission.resolved": {
      // N3-compaction-companion (2026-05-24): permission outcomes
      // are no longer projected to the record. Permission is a
      // user-machine interaction; Herta has nothing to add and
      // shouldn't comment on the user's clicks. Once permissions
      // are decided, the consequences (Writing / Running / Tests)
      // appear in the record via the resulting backend events.
      // See docs/superpowers/specs/2026-05-24-narrative-compaction-design.md §5.
      return null;
    }

    default:
      return null;
  }
}

/**
 * Map a backend tool name to a coarse workflow verb the user (and Herta)
 * recognise. Returns null for tools that are too internal to surface —
 * the corresponding `tool.call.started` event is dropped silently.
 * The return type is the digest's verb union so the projected block's
 * `digest.verb` and rendered body can never disagree.
 */
export function workflowLabel(
  tool: string,
  inputSummary = "",
): Extract<SystemBlockDigest, { kind: "op" }>["verb"] | null {
  switch (tool) {
    case "read_file":
    case "list_files":
    case "glob":
    // show_excerpt starts as a Reading row like any other read; what makes
    // it different is its FINISHED row, which carries the excerpt.
    case "show_excerpt":
    // command_output reads a background process's output; the arg says
    // `bg-N output` (2026-08-17 — was `Running bg-N`).
    case "command_output":
      return "Reading";
    case "search_text":
      return "Searching";
    case "edit_file":
    case "write_new_file":
      return "Writing";
    // Minimal contract (ADR 0040): one editor tool, four commands — the verb
    // comes from the summary's leading word, which the loop's summarizeInput
    // guarantees is the command (`view path` / `str_replace path` …).
    case "str_replace_editor":
      return /^view(\s|$)/.test(inputSummary) ? "Reading" : "Writing";
    case "run_command":
    case "bash":
      return "Running";
    case "command_stop":
      // Not a run. Herta reads these rows, and `Running bg-1` on the stop
      // call read as a second launch (real session 2026-08-16).
      return "Stopping";
    case "todo_write":
      return "Planning";
    case "git_status":
    case "git_diff":
      return "Inspecting";
    case "memory_save":
      return "Saving memory";
    case "digest_document":
      return "Digesting";
    default:
      return null;
  }
}

/** Canonical CN wording of the done-marker's record body — the exact wording
 *  the GUI zh catalog pins (`record.marker.*`) and the CLI zh passthrough
 *  displays raw. `stateWord` is resolved per report via STATUS_WORD. */
const CN_MARKER_LABELS = (stateWord: string): MarkerSummaryLabels => ({
  stateWord,
  file: (n) => `${n} 个文件`,
  tests: (passed, failed) =>
    failed === 0
      ? `测试 ${passed}/${passed}`
      : `测试 ${passed} 通过，${failed} 失败`,
  risk: (n) => `${n} 风险`,
  lines: (add, del) => `+${add} −${del}`,
  // Git outcome identity (ADR 0049 §4): a commit is remembered by its sha,
  // a push by where it landed.
  commit: (sha) => `提交 ${sha}`,
  pushed: (ref) => `推送 ${ref}`,
  aborted: "运行异常中止",
});

const STATUS_WORD: Record<string, string> = {
  completed: "完成",
  blocked: "受阻",
  failed: "失败",
  // The user's own Stop — never 失败 (audit 2026-07-24, 1.4). The record is
  // durable and Herta-visible, so calling a deliberate stop a failure made
  // her narrate that 板砖 broke and fed the next dispatch a phantom
  // prior-run failure through workingHistory.
  interrupted: "中断",
  partial: "部分完成",
};

/**
 * Build the run-terminal `差分协处理器` done-marker block from the backend's
 * `AgentExecutionReport`. The body is a terse status roll-up
 * (完成/受阻/失败/部分完成 · N files · tests P/F); `evidenceDetail` carries a
 * bounded roll-up (last command tail + changed files + residual risks) for
 * Herta's prompt. `role: "done-marker"` lets the renderer/actor recognise the
 * end of the run.
 */
/**
 * Added / removed line counts of a unified diff, or null when the text is not
 * one this can measure.
 *
 * `+++` / `---` are the file headers, not content — counting them would
 * inflate every single-file patch by one on each side. The `\ ` lines the
 * bounded differ emits (an omission marker, "no newline at end of file") are
 * not content either.
 */
export function countDiffLines(
  diff: string,
): { add: number; del: number } | null {
  if (diff.trim().length === 0) return null;
  return countDiffLinesShared(diff);
}

/**
 * Total added / removed lines across a report's changed files — or null when
 * ANY of them lacks a per-file diff.
 *
 * All-or-nothing on purpose. A file changed through a command (`sed -i`, a
 * heredoc, an `mv`) has no diff, and since 2026-08-25 the dispatch baseline
 * puts exactly those files into `changedFiles`. Summing only the measurable
 * ones would present a partial number as the whole truth, which is the
 * fabrication class this codebase has already paid to remove from `git_diff`.
 */
export function totalChangedLines(
  files: AgentExecutionReport["changedFiles"],
): { add: number; del: number } | null {
  if (files.length === 0) return null;
  let add = 0;
  let del = 0;
  for (const f of files) {
    const m = /^\s*\+(\d+)\s*[-−]\s*(\d+)\s*$/.exec(f.diffSummary ?? "");
    if (m === null) return null;
    add += Number.parseInt(m[1] as string, 10);
    del += Number.parseInt(m[2] as string, 10);
  }
  return { add, del };
}

export function buildDoneMarker(
  report: AgentExecutionReport,
  lastCommandTail: string | undefined,
  lastCommandEvidence: readonly EvidenceSection[] | undefined,
  gitOutcome?: GitOutcome,
): SystemBlock {
  const word = STATUS_WORD[report.status] ?? report.status;
  const fileCount = report.changedFiles.length;
  // Test counts computed once; feed both the canonical body and the structured
  // markerSummary so they can never drift.
  const testCounts =
    report.tests.length > 0
      ? {
          passed: report.tests.filter((t) => t.status === "passed").length,
          failed: report.tests.filter((t) => t.status === "failed").length,
        }
      : undefined;
  const riskCount = report.residualRisks.length;

  // Structured mirror for localizing renderers (the GUI). The body below stays
  // canonical (D7); this is display-only data, never read by Herta's prompt.
  const changedLines = totalChangedLines(report.changedFiles);
  // Git outcome identity (ADR 0049 §4): present only when the run actually
  // landed a commit/push — the field's absence IS the usual case.
  const git =
    gitOutcome !== undefined &&
    (gitOutcome.commit !== undefined || gitOutcome.pushedRef !== undefined)
      ? gitOutcome
      : undefined;
  const markerSummary: DoneMarkerSummary = {
    kind: "done",
    state: report.status,
    fileCount,
    ...(changedLines !== null ? { lines: changedLines } : {}),
    ...(testCounts !== undefined ? { tests: testCounts } : {}),
    ...(git !== undefined ? { git } : {}),
    riskCount,
  };

  // Canonical CN body, composed from the SAME structured summary through the
  // SAME core composer the localizing renderers use — body and display can
  // never drift. The wording mirrors the GUI zh catalog / ADR 0018 verbatim
  // (`N 个文件`, `测试 P/总`, `N 风险`). The first live GUI e2e (2026-07-17)
  // caught the previous hand-rolled body mixing English segments into the
  // record grammar (`完成 · 2 files`, `完成 · 1 file · 1 风险`) — the CLI's zh
  // passthrough displayed that mixed body raw.
  const body = composeMarkerSummary(markerSummary, CN_MARKER_LABELS(word));

  // The canonical string and its structured mirror are built from the SAME
  // values in the SAME order, so the detail pane can never show a different
  // roll-up than the prompt reads.
  const detailParts: string[] = [];
  const sections: EvidenceSection[] = [];
  if (lastCommandTail !== undefined) detailParts.push(lastCommandTail);
  if (lastCommandEvidence !== undefined) sections.push(...lastCommandEvidence);
  if (fileCount > 0) {
    const paths = report.changedFiles.map((f) => f.path).slice(0, 20);
    detailParts.push(`↳ 改动文件: ${paths.join(", ")}`);
    sections.push({ kind: "files", paths });
  }
  if (report.residualRisks.length > 0) {
    const items = report.residualRisks.slice(0, 5);
    detailParts.push(`↳ 风险: ${items.join("; ")}`);
    sections.push({ kind: "risks", items });
  }
  // Unfinished todos (ADR 0025 §2): folded from the report's nextActions so
  // the next dispatch inherits them through workingHistory (which reads the
  // marker body + evidenceDetail), and Herta can name what's still open.
  if (report.nextActions.length > 0) {
    const items = report.nextActions.slice(0, 5);
    detailParts.push(`↳ 待办: ${items.join("; ")}`);
    sections.push({ kind: "todos", items });
  }
  // The backend's own findings (R-1, persona re-test 2026-08-11). Everything
  // above is a BY-PRODUCT of the run — files touched, risks left, work
  // outstanding — and a run can legitimately produce none of them: a survey,
  // a read-only check, a search that came back empty, anything ending
  // `部分完成`. The marker then said a dispatch happened and nothing about
  // what it FOUND, and the hole got filled: asked what 板砖 concluded, Herta
  // narrated a critique of its output that appears nowhere in the record.
  // `report.evidence` is exactly "what it found", already structured by the
  // harness, and it was the one part of the report the record never carried.
  // Bounded like its siblings; `source` rides along when present because a
  // finding worth naming is worth locating.
  // Conclusions FIRST (ADR 0039): the backend's own cited findings are the
  // deliverable of an analysis brief and read before the receipts that
  // produced them. Listed apart from `↳ 依据` because a claim and a receipt
  // are different kinds of fact — Herta must be able to tell "板砖 concluded
  // X (see log.txt:33)" from "板砖 read log.txt".
  const findings = report.evidence.filter((e) => e.kind === "finding");
  const receipts = report.evidence.filter((e) => e.kind !== "finding");
  if (findings.length > 0) {
    const items = findings
      .slice(0, 8)
      .map((e) =>
        e.source !== undefined && e.source.length > 0
          ? `${e.summary}（${e.source}）`
          : e.summary,
      );
    detailParts.push(`↳ 结论: ${items.join("; ")}`);
    sections.push({ kind: "findings", items });
  }
  if (receipts.length > 0) {
    const items = receipts
      .slice(0, 6)
      .map((e) =>
        e.source !== undefined && e.source.length > 0
          ? `${e.summary}（${e.source}）`
          : e.summary,
      );
    detailParts.push(`↳ 依据: ${items.join("; ")}`);
    sections.push({ kind: "evidence", items });
  }
  const evidenceDetail =
    detailParts.length > 0 ? detailParts.join("\n") : undefined;

  return {
    kind: "system",
    label: "差分协处理器",
    body,
    role: "done-marker",
    markerSummary,
    ...(evidenceDetail !== undefined ? { evidenceDetail } : {}),
    ...(sections.length > 0 ? { evidence: sections } : {}),
  };
}

/** The digest's structured copy of the list. A fresh array of fresh objects,
 *  never the caller's — a record block is durable and must not alias the
 *  backend's live todo state. */
export function todoDigestItems(
  todos: readonly TodoItem[],
): readonly TodoDigestItem[] {
  return todos.map((t) => ({ content: t.content, status: t.status }));
}

/**
 * The dispatch's first todo layout as one record block (ADR 0025 §2
 * rendering). English chrome header (matching every other projected row's
 * chrome — renderers localize from the digest), item text verbatim as the
 * backend wrote it. Status marks mirror the todo states:
 * `[ ]` pending · `[~]` in_progress · `[x]` completed.
 */
export function buildTodoLayoutBlock(todos: readonly TodoItem[]): SystemBlock {
  const mark = (status: TodoStatus): string =>
    status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
  const completed = todos.filter((t) => t.status === "completed").length;
  const lines = todos.map((t) => `${mark(t.status)} ${t.content}`);
  return {
    kind: "system",
    label: "差分协处理器",
    body: [`todo list (${todos.length}):`, ...lines].join("\n"),
    // No `current` here — the layout's [~] mark already shows it; `current`
    // is the progress rows' field (buildTodoProgressBlock below). `items`,
    // by contrast, rides BOTH kinds: a renderer reading "the newest todo
    // digest" must find a list there whether or not an update has landed
    // yet, and one code path beats a layout-parse plus a counts-only path.
    digest: {
      kind: "todo",
      total: todos.length,
      completed,
      items: todoDigestItems(todos),
    },
  };
}

/**
 * A LATER todo_write update as one compact progress row (2026-07-23, user
 * request: with a 任务清单 in play, the record should show which step 板砖
 * is on). English chrome like every projected row; the in_progress item's
 * text rides both the body and the digest (`current`) so the GUI can render
 * a localized "步骤 k/n · <item>" line. Replaces the old "Planning k/n" op
 * row (suppressed at tool.call.started). Compaction and the dream digest
 * skip kind "todo" — working state, not an outcome — exactly as they did
 * for the Planning rows.
 *
 * The one-line body is deliberately lossy (counts + the in-flight step); the
 * digest's `items` carries the full list behind it, because under full-list
 * replacement the plan a renderer should show is the plan on THIS update,
 * not the one the layout block froze.
 */
export function buildTodoProgressBlock(
  todos: readonly TodoItem[],
): SystemBlock {
  const completed = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress")?.content;
  return {
    kind: "system",
    label: "差分协处理器",
    body: `todo ${completed}/${todos.length}${current === undefined ? "" : `: ${current}`}`,
    digest: {
      kind: "todo",
      total: todos.length,
      completed,
      ...(current === undefined ? {} : { current }),
      items: todoDigestItems(todos),
    },
  };
}

/** Dedup signature for todo progress: a rewrite that changes none of the
 *  list length, the completed count, or the in-flight item projects nothing.
 *
 *  `total` joined the signature on 2026-07-26. Full-list replacement lets
 *  板砖 legitimately grow or prune the plan mid-run, and with a
 *  `completed|current` signature an ADDED (or dropped) step while the same
 *  item stayed in flight projected NOTHING — so the record's last
 *  `todo k/n` row, and every renderer reading it, went on quoting a stale n
 *  for the rest of the dispatch.
 *
 *  Deliberately NOT in the signature: item text and ordering. A pending
 *  tail gets reworded constantly, and a row per reword would spam the
 *  record — which IS Herta's prompt, not just a screen. The trade is
 *  explicit: the newest projected digest's `items` can lag a pure reword of
 *  a non-in-flight item until the next update that does move a count or the
 *  in-flight step. The numbers and the step being worked — what a reader
 *  acts on — stay honest; item text is eventually consistent. */
export function todoProgressSignature(todos: readonly TodoItem[]): string {
  const completed = todos.filter((t) => t.status === "completed").length;
  const current = todos.find((t) => t.status === "in_progress")?.content ?? "";
  // Free text last: an item containing "|" then cannot collide across fields.
  return `${completed}|${todos.length}|${current}`;
}

/**
 * Terminal block for a true no-op delegation: `@板砖` was triggered but the
 * backend produced no file/directory/command work (e.g. Herta delegated
 * chitchat / public-data / out-of-scope). Emitting a concrete marker (instead
 * of a bare 完成) gives the next iteration's prompt something to react to,
 * preventing the duplicate-speech bug (2026-05-23). The `body` starts with
 * 无产出 so compact-record.ts digests it to （板砖无产出）. Carries
 * `role: "noop-marker"` so the synthesized block is structurally identifiable
 * (like the done-marker) and compaction can key on the role rather than the
 * body prefix. It is NOT a `role: "done-marker"` — this is not a completion
 * roll-up, so the compaction lifecycle folds it into the summary rather than
 * passing it through verbatim.
 */
export function buildNoopMarker(): SystemBlock {
  return {
    kind: "system",
    label: "差分协处理器",
    body: "无产出 — 这次没有触发任何文件、目录或命令操作。",
    role: "noop-marker",
  };
}

/**
 * Terminal block for an INFRA failure: `runBrief` itself threw (workspace
 * mkdir failure, double-brief guard, an internal bug) rather than returning
 * a `failed` report the way ordinary tool/provider failures do. Pre-fix the
 * bridge rethrew without returning `current`, so every block already
 * rendered via the sink existed on screen but in neither memory nor disk
 * (D7 divergence), and the GUI's activity group just stopped with no
 * terminal state. Converging on the same `role: "done-marker"` shape as an
 * ordinary failed run gives Herta a concrete 失败 marker to react to and
 * lets the GUI terminate the live activity group exactly like any other
 * run-terminal block. The raw error text rides `evidenceDetail` (prompt/
 * detail lane; sanitized by the caller like every backend-derived string).
 */
export function buildBridgeFailureMarker(err: unknown): SystemBlock {
  const message =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === "string"
        ? (err as { message: string }).message
        : String(err);
  return {
    kind: "system",
    label: "差分协处理器",
    body: "失败 · 运行异常中止",
    role: "done-marker",
    // `aborted` (not a synthetic riskCount: 1) mirrors the body's 运行异常中止:
    // localizing renderers compose "run aborted" instead of "1 risk".
    markerSummary: {
      kind: "done",
      state: "failed",
      fileCount: 0,
      riskCount: 0,
      aborted: true,
    },
    evidenceDetail: `↳ 错误: ${message}`,
    evidence: [{ kind: "error", message }],
  };
}
