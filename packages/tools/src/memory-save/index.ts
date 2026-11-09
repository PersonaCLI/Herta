import { randomUUID } from "node:crypto";
import {
  type HertaTool,
  type MemoryItem,
  type MemoryKind,
  memoryHandle,
  type ToolCallRequest,
  type ToolContext,
  type ToolResult,
  type ToolSchema,
} from "@herta/core";
import { formatInputIssues } from "../input-issues.js";
import { redactSecrets } from "../run-command/redactor.js";
import { memorySaveInputSchema, memorySaveJsonSchema } from "./schema.js";

export type { MemorySaveInput } from "./schema.js";

export interface MemorySaveData {
  id: string;
  kind: MemoryKind;
  text: string;
  why: string;
  /** The fact this one corrected, as the store held it (ADR 0077 amendment
   *  2026-11-09). */
  replaced?: { id: string; kind: MemoryKind; text: string };
}

/**
 * What is worth a later run's attention (ADR 0077), from where Claude Code,
 * Codex and ZCode converge: only what the workspace cannot tell a later run
 * by itself, with the reason it holds. The same list rides the schema's
 * descriptions; a contract line is added only if a lab shows it is needed
 * (the minimal contract's own rule: prompt text earns its place by measured
 * behaviour).
 */
export const MEMORY_SAVE_DESCRIPTION =
  "Save a fact about this project for later runs in this workspace: each later dispatch starts with the saved facts, their age and their reason. Save only what the workspace cannot tell a later run by itself — a preference or correction the user stated (how to run the tests, a style rule, what not to touch), a quirk found the hard way (a flaky test, a broken script and its workaround), a mistake not to repeat. Do NOT save what a later run can read from the code, the config or git (layout, what a function does, history), a recipe for the change you just made, progress on the current task, command output, or secrets. Saving the same fact again re-confirms it. If a fact from the project-memory list proved wrong or outdated in this run, save what holds now with `replaces` set to that fact's id, and say in `why` what showed it: the old fact is removed.";

export function memorySaveTool(): HertaTool {
  return {
    name: "memory_save",
    schema(): ToolSchema {
      return {
        name: "memory_save",
        description: MEMORY_SAVE_DESCRIPTION,
        inputSchema: memorySaveJsonSchema,
      };
    },
    async run(
      call: ToolCallRequest,
      ctx: ToolContext,
    ): Promise<ToolResult<MemorySaveData>> {
      const parsed = memorySaveInputSchema.safeParse(call.input);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: formatInputIssues(parsed.error),
            retryable: false,
          },
          suggestion: "usage: {kind, text, why, replaces?}",
          summary: "invalid input",
        };
      }
      const input = parsed.data;
      const redactedText = redactSecrets(input.text);
      const redactedWhy = redactSecrets(input.why);
      const now = new Date().toISOString();
      const item: MemoryItem = {
        id: randomUUID(),
        scope: "repo",
        kind: input.kind,
        text: redactedText,
        why: redactedWhy,
        sourceSession: ctx.sessionId,
        createdAt: now,
        lastSeen: now,
        confidence: 1.0,
      };
      if (input.replaces === undefined) {
        await ctx.memory.save(item);
        return {
          ok: true,
          data: {
            id: item.id,
            kind: item.kind,
            text: redactedText,
            why: redactedWhy,
          },
          summary: `remembered: ${input.kind}`,
        };
      }
      // A correction (ADR 0077 amendment 2026-11-09): the named fact goes,
      // this one takes its place. A name that fits no fact, or more than
      // one, writes nothing — saving it as new would leave the wrong fact
      // beside the right one, the state the correction exists to end.
      const outcome = await ctx.memory.replace(input.replaces, item);
      if (!outcome.ok) {
        const ambiguous = outcome.reason === "ambiguous";
        return {
          ok: false,
          error: {
            code: ambiguous ? "replaces_ambiguous" : "replaces_not_found",
            message: ambiguous
              ? `more than one saved fact has an id starting "${input.replaces}"`
              : `no saved fact has the id "${input.replaces}"`,
            retryable: true,
          },
          suggestion: ambiguous
            ? "Give more of the id, or the whole id."
            : "Copy the id from the fact's brackets in the project-memory list at the start of this brief (id:…), or leave replaces out to save this as a new fact.",
          summary: "nothing saved",
        };
      }
      const old = outcome.replaced;
      return {
        ok: true,
        data: {
          id: item.id,
          kind: item.kind,
          text: redactedText,
          why: redactedWhy,
          replaced: { id: old.id, kind: old.kind, text: old.text },
        },
        summary: `remembered: ${input.kind}, replacing ${memoryHandle(old.id) ?? "a saved fact"}`,
      };
    },
  };
}
