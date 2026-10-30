import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { narrativeDirFor, trailblazerNotesFileName } from "@herta/core";
import {
  DEFAULT_FLOW_TOPICS,
  flowTopicNames,
  knownFlowTopics,
} from "./flow-topics.js";
import type { FlowLang, FlowSettings } from "./flow-types.js";

/**
 * What the topics come from (ADR 0084 §4, amendment "topics are picked"):
 * the keywords the Trailblazer picked, and what Herta knows of them. Read by
 * the harness — 板砖 never opens a workspace for this. Only the queries built
 * from this leave the machine as searches (§5); the side calls that write
 * them go to DeepSeek, which already reads her prefix every turn.
 *
 * The workspaces' libraries were a third source until the owner found the
 * issues "too technical" (2026-10-30): a project's dependencies are what it
 * is built with, not what its author reads about.
 */

/** Her notes on the Trailblazer: the opening of the page is the summary
 *  the dream pass keeps on top, and a query needs no more. */
export const NOTES_CHARS = 4000;
/** A notes page larger than this is not read. */
const MAX_NOTES_BYTES = 1024 * 1024;

/** Flow is off until the Trailblazer turns it on (§1, question 4), with a
 *  few broad topics picked. */
export const DEFAULT_FLOW_SETTINGS: FlowSettings = {
  enabled: false,
  topics: DEFAULT_FLOW_TOPICS,
};

/**
 * The `flow` section of the app settings as read from disk: anything
 * malformed falls back to the default, field by field, so a hand-edited
 * file cannot turn Flow on or break the panel. A section from before topics
 * were picked (free-text `interests`, three `sources`) gets the default
 * topics: its words were not keywords from the list.
 */
export function normalizeFlowSettings(raw: unknown): FlowSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_FLOW_SETTINGS;
  }
  const o = raw as Record<string, unknown>;
  const d = DEFAULT_FLOW_SETTINGS;
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : d.enabled,
    topics: Array.isArray(o.topics) ? knownFlowTopics(o.topics) : d.topics,
  };
}

export interface FlowInterests {
  /** The picked topics, in the issue's language. */
  readonly named: readonly string[];
  /** Her page on the Trailblazer; empty when there is none yet. */
  readonly notes: string;
}

export function hasInterests(i: FlowInterests): boolean {
  return i.named.length > 0 || i.notes.trim() !== "";
}

/**
 * Gather the topics and the notes. `workspaceRoots` are the workspaces of
 * the sessions used lately, most recent first; the notes come from the
 * first that has them (question 10: the workspace of the session used last).
 */
export async function gatherFlowInterests(opts: {
  readonly settings: FlowSettings;
  readonly workspaceRoots: readonly string[];
  readonly lang: FlowLang;
}): Promise<FlowInterests> {
  const { settings, workspaceRoots, lang } = opts;
  return {
    named: flowTopicNames(settings.topics, lang),
    notes: await notesOf(workspaceRoots, lang),
  };
}

async function readSmall(file: string): Promise<string | null> {
  try {
    const s = await stat(file);
    if (!s.isFile() || s.size > MAX_NOTES_BYTES) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Her page on the Trailblazer from the first workspace that has one: the
 *  issue's language first, the other when that one has none yet. */
async function notesOf(
  roots: readonly string[],
  lang: FlowLang,
): Promise<string> {
  const langs: FlowLang[] = lang === "en" ? ["en", "zh"] : ["zh", "en"];
  for (const root of roots) {
    for (const l of langs) {
      const file = join(narrativeDirFor(root, l), trailblazerNotesFileName(l));
      const text = await readSmall(file);
      if (text !== null && text.trim() !== "") {
        return Array.from(text.trim()).slice(0, NOTES_CHARS).join("");
      }
    }
  }
  return "";
}
