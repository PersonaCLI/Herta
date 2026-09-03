import type { AgentExecutionReport } from "../bridge/types.js";
import type { CommandConsequence, RiskLevel } from "../permission-engine.js";
import type { AgentError } from "./errors.js";
import type { TodoItem } from "./todo.js";
import type { ToolCallRequest, ToolResult } from "./tool.js";
import type { AssistantMessage } from "./transcript.js";

export type EventLayer = "actor" | "backend";

export interface PermissionRequest {
  id: string;
  call: ToolCallRequest;
  reason: string;
  risk: RiskLevel;
  /** Stable machine code for the ask class (rule-authored, e.g.
   *  "command_ask_unknown"). Lets display surfaces localize the summary
   *  while `reason` stays the neutral-English machine contract (D2). */
  code?: string;
  diff?: string;
  files?: readonly string[];
  /** Rule-derived effective program argv (ADR 0040); see RuleVerdict. */
  argv?: readonly string[];
  /** Rule-derived distinct programs of a shell line (cache scope only). */
  programs?: readonly string[];
  /** Every distinct ask class of a chained shell line, `code` first; the
   *  approval surface names the ones beyond the top label. */
  codes?: readonly string[];
  /** Consequence note code (ADR 0049 §5) — display-only; see
   *  `CommandConsequence` in permission-engine. */
  consequence?: CommandConsequence;
}

// Opaque in slice B; real shape lives in tools / dialogue specs.
// biome-ignore lint/complexity/noBannedTypes: deliberate placeholder
/** What a test run came back with. `passed` was added 2026-09-03 so the
 *  beat classifier can tell a green run (no beat — the synthesis reports
 *  it) from a red one (Herta reacts while 板砖 fixes it); absent when the
 *  emitter does not know. */
export type VerificationResult = { readonly passed?: boolean };

export interface TurnSummary {
  durationMs: number;
  toolCallCount: number;
  messageCount: number;
  endedAt: string;
}

export type AgentEvent =
  | { type: "turn.started"; layer: EventLayer; userText: string }
  | { type: "assistant.delta"; layer: EventLayer; text: string }
  | { type: "assistant.final"; layer: EventLayer; message: AssistantMessage }
  | {
      type: "tool.call.started";
      layer: EventLayer;
      id: string;
      tool: string;
      inputSummary: string;
    }
  | {
      type: "tool.call.progress";
      layer: EventLayer;
      id: string;
      message: string;
    }
  | {
      type: "tool.call.finished";
      layer: EventLayer;
      id: string;
      tool: string;
      result: ToolResult;
    }
  | {
      type: "permission.requested";
      layer: EventLayer;
      request: PermissionRequest;
    }
  | {
      type: "permission.resolved";
      layer: EventLayer;
      id: string;
      /** "allow"/"deny" are user decisions behind a permission.requested;
       *  "blocked" is the deterministic rule-deny where no prompt fired
       *  (audit 2026-07-10, finding 6) — no request precedes it, so `id` is
       *  the tool-call id and `tool` carries its own context. */
      decision: "allow" | "deny" | "blocked";
      tool?: string;
      /** blocked only (2026-08-26): the deny verdict's code and refused-risk
       *  tier, threaded so the status gate can tell a withheld READ (or a
       *  malformed call) from a refused mutation — the rule always had both
       *  in hand and used to drop them here. */
      code?: string;
      risk?: RiskLevel;
    }
  | { type: "patch.preview"; layer: EventLayer; diff: string; files: string[] }
  | { type: "verification.started"; layer: EventLayer; command: string }
  | {
      type: "verification.finished";
      layer: EventLayer;
      result: VerificationResult;
    }
  // Neutral name kept from the pre-ADR-0025 plan contract (D2); the
  // payload is the backend's full todo list after a `todo_write`.
  | { type: "plan.updated"; layer: EventLayer; todos: readonly TodoItem[] }
  | { type: "turn.finished"; layer: EventLayer; summary: TurnSummary }
  | { type: "turn.failed"; layer: EventLayer; error: AgentError }
  | { type: "agent.report"; layer: EventLayer; report: AgentExecutionReport }
  // Long-session recap compaction: a transient hint that the router model is
  // generating the recap (`start`) / has finished (`end`). Ephemeral UI only —
  // never enters the durable TerminalRecord. Emitted only when the summarizer
  // actually runs (not on reuse/no-op turns).
  | { type: "recap.compaction"; layer: EventLayer; phase: "start" | "end" }
  // Supervisor judgment window: a transient hint that the supervisor model is
  // evaluating a candidate speech (`start`) / has settled (`end` — OK, veto,
  // or fail-soft alike). Same contract as recap.compaction: ephemeral UI
  // only, never enters the durable TerminalRecord. Lets the renderer explain
  // a long reveal-hold (the paced stream parks its tail while the verdict is
  // pending) instead of showing a frozen cursor.
  | { type: "supervisor.check"; layer: EventLayer; phase: "start" | "end" };
