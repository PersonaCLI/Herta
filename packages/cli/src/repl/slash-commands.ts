import type {
  SessionApprovalCache,
  TerminalRecord,
  ToolRegistry,
  WorkspacePermissions,
} from "@herta/core";
import {
  defaultWorkspaceFor,
  errorMessage,
  listSessions,
  readSessionFile,
  SessionFileError,
  type SessionListEntry,
  type V2RecordPersister as V2RecordPersisterType,
} from "@herta/core";
import type { PromptLang, V2ActorDriver } from "@herta/herta";
import { validateWorkspaceRoot } from "@herta/tools";
import { aliasBanzhuanPlain } from "../render/banzhuan-alias.js";
import type { Style } from "../render/style.js";
import { V2RecordPersister } from "./v2-record-persister.js";

export interface SlashContext {
  tools: ToolRegistry;
  out: NodeJS.WritableStream;
  style: Style;
  /** This process's session interaction language (boot-time, session-constant:
   *  the renderer, static prefix, and driver were all built with it). /resume
   *  refuses a session born under the OTHER language — those surfaces cannot
   *  be rebuilt mid-process. Default "zh". */
  lang?: PromptLang;
  /**
   * Optional session approval cache for the /permissions slash command.
   * Wired by main.ts; tests may omit. When undefined, /permissions reports
   * an empty state and /permissions clear reports "cleared 0".
   */
  approvalCache?: SessionApprovalCache;
  /**
   * Optional workspace permission choices for `/permissions auto-review`.
   * Wired by main.ts; tests may omit.
   */
  workspacePermissions?: WorkspacePermissions;
  /** ADR 0075: an automatic reviewer is mounted — `/permissions
   *  auto-review on|off` switches it for this workspace. */
  autoReviewAvailable?: boolean;
  /**
   * Optional /resume dependencies. Wired by main.ts; tests may omit. When
   * any is undefined, /resume prints "/resume not available in this build"
   * and returns.
   */
  driver?: V2ActorDriver;
  /**
   * Rebind the driver's session-scoped inputs — prefix and own-dream
   * exclusions, recap runtime — to the session being resumed (ADR 0069 §3).
   * Wired by main.ts. Absent → /resume swaps only the record and persister,
   * and the loaded session reads the boot session's prefix and recap: the
   * pre-2026-09-23 behavior, left for tests that do not wire it.
   */
  rebindSession?: (sessionId: string, record: TerminalRecord) => Promise<void>;
  transcriptDir?: string;
  currentWorkspaceRoot?: string;
  /**
   * Optional /workspace dependencies. Wired by main.ts; tests may omit.
   * `workspaceHolder` is the single mutable holder shared with the backend
   * runtime factory — `/workspace set` mutates `.current` so the next
   * `@板砖` dispatch reads the new root. When undefined, /workspace reports
   * "not available in this build".
   */
  workspaceHolder?: { current: string };
  persister?: V2RecordPersisterType;
  home?: string;
  sessionId?: string;
}

export interface SlashResult {
  action: "continue" | "quit";
}

const HELP_LINES: readonly [string, string][] = [
  ["/help", "show this list"],
  ["/compact", "force older history into the recap"],
  ["/tools", "list registered tools"],
  ["/permissions", "list session approvals (subs: clear, auto-review on|off)"],
  ["/workspace", "show/set/reset the backend workspace (subs: set/reset)"],
  ["/resume", "list & resume prior sessions (subs: latest/all/<prefix>)"],
  ["/quit  /exit", "end session"],
];

export async function handleSlashCommand(
  line: string,
  ctx: SlashContext,
): Promise<SlashResult> {
  const parts = line.slice(1).trim().split(/\s+/);
  const cmd = parts[0] ?? "";
  switch (cmd) {
    case "help":
      renderHelp(ctx);
      return { action: "continue" };
    case "compact":
      renderCompact(ctx);
      return { action: "continue" };
    case "tools":
      renderTools(ctx);
      return { action: "continue" };
    case "permissions":
      renderPermissions(ctx, parts.slice(1));
      return { action: "continue" };
    case "workspace":
      handleWorkspace(ctx, parts.slice(1));
      return { action: "continue" };
    case "resume":
      await handleResume(ctx, parts[1]);
      return { action: "continue" };
    case "quit":
    case "exit":
      return { action: "quit" };
    default:
      ctx.out.write(`${ctx.style.red(`unknown command: /${cmd}`)}\n`);
      ctx.out.write(`${ctx.style.dim("type /help for the command list")}\n`);
      return { action: "continue" };
  }
}

function renderHelp(ctx: SlashContext): void {
  for (const [name, desc] of HELP_LINES) {
    const padded = name.padEnd(16);
    ctx.out.write(`${ctx.style.cyan(padded)}${ctx.style.dim(desc)}\n`);
  }
}

function renderCompact(ctx: SlashContext): void {
  if (ctx.driver === undefined) {
    ctx.out.write(
      `${ctx.style.dim("/compact: not available in this build")}\n`,
    );
    return;
  }
  ctx.driver.forceCompactNextTurn();
  // The record token 「先前记录」 stays CN inside the EN sentence (D2): it
  // names the canonical record heading the recap folds into.
  const confirmation =
    ctx.lang === "en"
      ? "next turn folds older dialogue into the 「先前记录」 recap."
      : "下次回合会把更早的对话压缩进「先前记录」。";
  ctx.out.write(`${ctx.style.dim(confirmation)}\n`);
}

function renderTools(ctx: SlashContext): void {
  for (const tool of ctx.tools.list()) {
    const schema = tool.schema();
    ctx.out.write(
      `${ctx.style.cyan(schema.name)} — ${ctx.style.dim(schema.description)}\n`,
    );
  }
}

function renderPermissions(ctx: SlashContext, args: readonly string[]): void {
  const sub = args[0];
  if (sub !== undefined && sub !== "clear" && sub !== "auto-review") {
    ctx.out.write(`${ctx.style.red(`unknown subcommand: ${sub}`)}\n`);
    ctx.out.write(
      `${ctx.style.dim("usage: /permissions (or clear, auto-review on|off)")}\n`,
    );
    return;
  }
  if (sub === "auto-review") {
    handleAutoReview(ctx, args[1]);
    return;
  }
  if (sub === "clear") {
    const n = ctx.approvalCache?.size() ?? 0;
    ctx.approvalCache?.clear();
    ctx.out.write(`${ctx.style.dim(`cleared ${n} session approval(s)`)}\n`);
    return;
  }
  const list = ctx.approvalCache?.list() ?? [];
  if (
    ctx.autoReviewAvailable === true &&
    ctx.workspacePermissions !== undefined
  ) {
    ctx.out.write(
      `${ctx.style.cyan("auto-review")} ${ctx.workspacePermissions.autoReview() === true ? "on" : "off"}\n`,
    );
  }
  if (list.length === 0) {
    ctx.out.write(
      `${ctx.style.dim("no session approvals — every workspace write will prompt")}\n`,
    );
    return;
  }
  ctx.out.write(`${ctx.style.cyan(`session approvals (${list.length})`)}\n`);
  for (const entry of list) ctx.out.write(`  ${entry}\n`);
  ctx.out.write(
    `\n${ctx.style.dim("(/permissions clear drops session approvals)")}\n`,
  );
}

/**
 * `/permissions auto-review [on|off]` (ADR 0075): automatic review for THIS
 * workspace — writes undo can take back run, a review model answers the
 * rest — stored in `.herta/permissions.json`, which no command may write.
 * It replaced workspace trust (ADR 0064 amendment 2026-10-10). Bare, it says
 * the state. Its decisions stay silent, as on the desktop.
 */
function handleAutoReview(ctx: SlashContext, value: string | undefined): void {
  if (
    ctx.autoReviewAvailable !== true ||
    ctx.workspacePermissions === undefined
  ) {
    ctx.out.write(
      `${ctx.style.dim("auto-review is not available in this build")}\n`,
    );
    return;
  }
  if (value === "on" || value === "off") {
    ctx.workspacePermissions.setAutoReview(value === "on");
  } else if (value !== undefined) {
    ctx.out.write(
      `${ctx.style.dim("usage: /permissions auto-review on|off")}\n`,
    );
    return;
  }
  ctx.out.write(
    `${ctx.style.dim(`auto-review: ${ctx.workspacePermissions.autoReview() === true ? "on" : "off"}`)}\n`,
  );
}

function handleWorkspace(ctx: SlashContext, args: readonly string[]): void {
  const holder = ctx.workspaceHolder;
  if (holder === undefined) {
    ctx.out.write(
      `${ctx.style.dim("/workspace is not available in this build")}\n`,
    );
    return;
  }
  const sub = args[0];
  if (sub === undefined) {
    ctx.out.write(`${ctx.style.cyan("workspace")} ${holder.current}\n`);
    return;
  }
  if (sub === "reset") {
    if (ctx.home === undefined || ctx.sessionId === undefined) {
      ctx.out.write(
        `${ctx.style.dim("/workspace reset needs a session context")}\n`,
      );
      return;
    }
    const def = defaultWorkspaceFor(ctx.home, ctx.sessionId);
    holder.current = def;
    ctx.persister?.appendWorkspaceSet(def, new Date().toISOString());
    ctx.out.write(`${ctx.style.cyan("workspace reset")} ${def}\n`);
    // Out-of-turn → 系统 note so the reset is visible/persisted/resumable in
    // the canonical TerminalRecord (the cyan print above is the immediate
    // stdout confirmation; the note survives resume).
    ctx.driver?.appendSystemNote("系统", `workspace → ${def}`);
    return;
  }
  if (sub === "set") {
    const path = args.slice(1).join(" ");
    if (path.length === 0) {
      ctx.out.write(`${ctx.style.red("usage: /workspace set <path>")}\n`);
      return;
    }
    const check = validateWorkspaceRoot(path, { home: ctx.home ?? "" });
    if (!check.ok) {
      ctx.out.write(`${ctx.style.red(check.message)}\n`);
      return;
    }
    holder.current = check.resolved;
    ctx.persister?.appendWorkspaceSet(check.resolved, new Date().toISOString());
    ctx.out.write(`${ctx.style.cyan("workspace set")} ${check.resolved}\n`);
    // Out-of-turn → 系统 note so the change is visible/persisted/resumable in
    // the canonical TerminalRecord (the cyan print above is the immediate
    // stdout confirmation; the note survives resume).
    ctx.driver?.appendSystemNote("系统", `workspace → ${check.resolved}`);
    return;
  }
  ctx.out.write(`${ctx.style.red(`unknown: /workspace ${sub}`)}\n`);
}

async function handleResume(
  ctx: SlashContext,
  sub: string | undefined,
): Promise<void> {
  if (
    ctx.driver === undefined ||
    ctx.transcriptDir === undefined ||
    ctx.currentWorkspaceRoot === undefined
  ) {
    ctx.out.write(`${ctx.style.dim("/resume: not available in this build")}\n`);
    return;
  }
  if (sub === undefined) {
    // Bare /resume: list workspace-scoped sessions.
    const entries = listSessions({
      transcriptDir: ctx.transcriptDir,
      currentWorkspaceRoot: ctx.currentWorkspaceRoot,
    });
    renderSessionList(ctx, entries, "workspace");
    return;
  }
  if (sub === "all") {
    const entries = listSessions({
      transcriptDir: ctx.transcriptDir,
      currentWorkspaceRoot: ctx.currentWorkspaceRoot,
      allWorkspaces: true,
    });
    renderSessionList(ctx, entries, "all");
    return;
  }
  if (sub === "latest") {
    const entries = listSessions({
      transcriptDir: ctx.transcriptDir,
      currentWorkspaceRoot: ctx.currentWorkspaceRoot,
      limit: 1,
    });
    const latestEntry = entries[0];
    if (latestEntry === undefined) {
      ctx.out.write(`${ctx.style.dim("no sessions in this workspace yet")}\n`);
      return;
    }
    await loadSession(ctx, latestEntry);
    return;
  }
  // Treat sub as an id prefix. Look across ALL workspaces so the user can
  // resume a session from a sibling project if they remember the id.
  const candidates = listSessions({
    transcriptDir: ctx.transcriptDir,
    currentWorkspaceRoot: ctx.currentWorkspaceRoot,
    allWorkspaces: true,
    limit: Number.POSITIVE_INFINITY,
  }).filter((e) => e.sessionId.startsWith(sub));
  if (candidates.length === 0) {
    ctx.out.write(`${ctx.style.red(`no session matching '${sub}'`)}\n`);
    return;
  }
  if (candidates.length > 1) {
    ctx.out.write(
      `${ctx.style.red(`ambiguous prefix '${sub}' — ${candidates.length} matches:`)}\n`,
    );
    for (const c of candidates.slice(0, 10)) {
      ctx.out.write(`  ${c.sessionId}\n`);
    }
    return;
  }
  const uniqueCandidate = candidates[0];
  if (uniqueCandidate !== undefined) await loadSession(ctx, uniqueCandidate);
}

function renderSessionList(
  ctx: SlashContext,
  entries: readonly SessionListEntry[],
  scope: "workspace" | "all",
): void {
  if (entries.length === 0) {
    const where =
      scope === "workspace" ? "in this workspace" : "across all workspaces";
    ctx.out.write(`${ctx.style.dim(`no sessions yet ${where}`)}\n`);
    return;
  }
  const heading =
    scope === "workspace"
      ? `recent sessions (${entries.length}, this workspace)`
      : `recent sessions (${entries.length}, all workspaces)`;
  ctx.out.write(`${ctx.style.cyan(heading)}\n`);
  for (const e of entries) {
    const shortId = e.sessionId.slice(0, 8);
    const rel = relativeTime(e.mtime);
    const wsSuffix =
      scope === "all" ? `  ${ctx.style.dim(`(${e.workspaceRoot})`)}` : "";
    // 板砖→Brick display alias, keyed on the SESSION's birth language (each
    // entry localizes its own preview; legacy headers without lang are zh).
    const preview = aliasBanzhuanPlain(e.preview, e.lang ?? "zh");
    ctx.out.write(
      `  [${ctx.style.cyan(shortId)}]  ${ctx.style.dim(rel.padEnd(8))}  ${preview}${wsSuffix}\n`,
    );
  }
  ctx.out.write(
    `\n${ctx.style.dim("use /resume <prefix> to load (8 chars usually unique)")}\n`,
  );
}

async function loadSession(
  ctx: SlashContext,
  entry: SessionListEntry,
): Promise<void> {
  if (ctx.driver === undefined) {
    ctx.out.write(`${ctx.style.dim("/resume: not available in this build")}\n`);
    return;
  }
  let loaded: ReturnType<typeof readSessionFile>;
  try {
    loaded = readSessionFile(entry.sessionFile);
  } catch (err) {
    if (err instanceof SessionFileError) {
      ctx.out.write(
        `${ctx.style.red(`/resume: could not load ${entry.sessionId.slice(0, 8)}: ${err.message}`)}\n`,
      );
      return;
    }
    throw err;
  }
  // Per-session language is pinned (ADR 0014): a session born under the other
  // language cannot be loaded into THIS process — the static prefix, hints,
  // renderer pacing, and @Brick input alias were all fixed at boot and cannot
  // be rebuilt here. A fresh invocation CAN honor the header (main.ts pins
  // --resume to meta.lang), so point the user there. Legacy headers (no lang)
  // load as before under the boot language.
  const sessionLang = loaded.meta.lang;
  if (sessionLang !== undefined && sessionLang !== (ctx.lang ?? "zh")) {
    ctx.out.write(
      `${ctx.style.red(
        `/resume: session ${entry.sessionId.slice(0, 8)} was created as ${sessionLang}, but this REPL is running as ${ctx.lang ?? "zh"}.`,
      )}\n${ctx.style.dim(
        `restart with: herta --resume ${entry.sessionId.slice(0, 8)} (it reopens in the session's own language)`,
      )}\n`,
    );
    return;
  }
  // The session's own prefix, exclusions and recap first (ADR 0069 §3): the
  // swap used to keep the boot session's, so the loaded session's own
  // dreams sat beside their verbatim source and the boot session's recap
  // could be spliced into its prompt. First, so a failure leaves the REPL
  // on the session it was on rather than half-switched.
  if (ctx.rebindSession !== undefined) {
    try {
      await ctx.rebindSession(entry.sessionId, loaded.record);
    } catch (err) {
      ctx.out.write(
        `${ctx.style.red(`/resume: could not prepare ${entry.sessionId.slice(0, 8)}: ${errorMessage(err)}`)}\n`,
      );
      return;
    }
  }
  ctx.driver.loadRecord(loaded.record);
  const newPersister = V2RecordPersister.forResume({
    sessionFile: entry.sessionFile,
  });
  ctx.driver.setPersister(newPersister);
  ctx.out.write(
    `${ctx.style.dim(`loaded session ${entry.sessionId.slice(0, 8)} — ${loaded.record.length} block${loaded.record.length === 1 ? "" : "s"} restored`)}\n`,
  );
}

/**
 * Format a Date as a relative-time string for the picker.
 * Examples: "2h ago", "3d ago", "2w ago", "5mo ago".
 */
function relativeTime(then: Date): string {
  const deltaMs = Date.now() - then.getTime();
  // Clamp negative deltas (clock skew, future timestamps) to 0 so we
  // don't print "-5s ago" etc.
  const deltaSec = Math.max(0, Math.floor(deltaMs / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.floor(deltaHr / 24);
  if (deltaDay < 7) return `${deltaDay}d ago`;
  const deltaWk = Math.floor(deltaDay / 7);
  if (deltaWk < 5) return `${deltaWk}w ago`;
  const deltaMo = Math.floor(deltaDay / 30);
  if (deltaMo < 12) return `${deltaMo}mo ago`;
  const deltaYr = Math.floor(deltaDay / 365);
  return `${deltaYr}y ago`;
}
