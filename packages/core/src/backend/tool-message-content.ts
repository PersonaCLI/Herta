import type { ToolResult } from "../types/tool.js";

/**
 * The ONE rendering of a tool result as the model's tool message
 * (2026-09-03). Three copies had grown — the provider's translate layer (the
 * wire truth), the context budget's estimator ("a mirror of translate") and
 * the oversized-result persister — and drifted: the estimator joined summary
 * and payload with one newline where the wire uses two, and never produced
 * the wire's `{}` for an empty result. Small, but the budget was sizing text
 * the model never saw. One definition, imported by all three.
 */

/** The structured part of the tool message — `data`, and for a failed
 *  result its `error` and `suggestion` — as JSON, or "" when there is
 *  none. The persister thresholds on this. */
export function toolResultPayloadJson(result: ToolResult): string {
  const payload = toolResultPayload(result);
  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : "";
}

/** The same payload before it is serialized: the persister writes it as a
 *  file that can be read a page at a time. */
export function toolResultPayload(result: ToolResult): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (result.data !== undefined) payload.data = result.data;
  if (!result.ok) {
    if (result.error !== undefined) payload.error = result.error;
    if (result.suggestion !== undefined) payload.suggestion = result.suggestion;
  }
  return payload;
}

/** The exact text the model sees as the tool message. A tool that authored
 *  its own model-facing text (ADR 0040, `modelText`) is sent verbatim — the
 *  harness fields are for the record, not the model. */
export function toolMessageContent(result: ToolResult): string {
  if (result.modelText !== undefined) return result.modelText;
  const payload = toolResultPayloadJson(result);
  if (result.summary.length > 0 && payload.length > 0) {
    return `${result.summary}\n\n${payload}`;
  }
  if (result.summary.length > 0) return result.summary;
  if (payload.length > 0) return payload;
  return "{}";
}
