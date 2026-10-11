import { join } from "node:path";
import type { SessionMeta } from "./read-session-file.js";

/** The managed root that holds per-session backend scratch dirs:
 *  `<home>/.herta/workspaces`. `home` is passed in (os.homedir()) so this is
 *  pure and testable. */
export function workspacesBaseDir(home: string): string {
  return join(home, ".herta", "workspaces");
}

/** The managed default backend workspace for a session:
 *  `<home>/.herta/workspaces/<sessionId>`. */
export function defaultWorkspaceFor(home: string, sessionId: string): string {
  return join(workspacesBaseDir(home), sessionId);
}

/** The per-language narrative dir: `<workspaceRoot>/.herta/narrative[-en]`.
 *  Herta's live 废案 corpus is split by interaction language so an EN workspace
 *  grows and reads its OWN English memories without ever mixing registers with
 *  the zh corpus (the "separate per-language corpora" design). zh keeps the
 *  original `narrative` dir (no migration); en gets a parallel `narrative-en`.
 *  SINGLE SOURCE OF TRUTH — the dream pass WRITES here and the actor prefix
 *  READS here, so the two must agree; a drift would make the actor read a dir
 *  nothing writes. */
export function narrativeDirFor(
  workspaceRoot: string,
  lang: "zh" | "en",
): string {
  return join(workspaceRoot, ".herta", narrativeDirName(lang));
}

/** Just the narrative dir's NAME (`narrative` | `narrative-en`), for callers
 *  that build a workspace-relative path rather than an absolute one (e.g. the
 *  static-prefix reader). */
export function narrativeDirName(lang: "zh" | "en"): string {
  return lang === "en" ? "narrative-en" : "narrative";
}

/** The filename of Herta's page on the Trailblazer in the narrative dir: the
 *  continuation of her bio's 第六章 that the dream pass rewrites as old 废案
 *  fade (knowledge `semanticize.ts`). Its title line is the name minus
 *  `.txt`. SINGLE SOURCE OF TRUTH — the dream pass writes the page, the actor
 *  prefix loads it as a `### 记录` file, and composer predictions read it back
 *  out of that prefix. The `### 记录` prefix is CN structural in both
 *  languages; only the title localizes. Keep it stable: renaming orphans
 *  every workspace's page. */
export function trailblazerNotesFileName(lang: "zh" | "en"): string {
  return lang === "en"
    ? "### 记录：About the Trailblazer.txt"
    : "### 记录：关于开拓者.txt";
}

/** The per-language dream bookkeeping dir (manifest + archive + lock), sibling
 *  of the narrative dir: `<workspaceRoot>/.herta/dream[-en]`. */
export function dreamDirFor(workspaceRoot: string, lang: "zh" | "en"): string {
  return join(workspaceRoot, ".herta", lang === "en" ? "dream-en" : "dream");
}

/** The effective backend workspace for a session, in precedence order:
 *  the latest `workspace_set` line, else the header's `backendWorkspace`
 *  (new sessions stamp this at creation), else the legacy `workspaceRoot`
 *  (sessions that predate the feature). */
export function resolveEffectiveWorkspace(
  meta: SessionMeta,
  latestWorkspaceSet?: string,
): string {
  if (latestWorkspaceSet !== undefined && latestWorkspaceSet.length > 0) {
    return latestWorkspaceSet;
  }
  if (meta.backendWorkspace !== undefined && meta.backendWorkspace.length > 0) {
    return meta.backendWorkspace;
  }
  return meta.workspaceRoot;
}
