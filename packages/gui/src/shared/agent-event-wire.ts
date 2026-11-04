import type { SessionAgentEvent } from "@herta/app-server";

/**
 * What the agent channel carries to the renderer: SIGNALS, not payloads.
 *
 * The session's agent stream is raw by contract — every bus event, whole,
 * for callers that want traces. The renderer is not one of them: its store
 * reads an event's type and layer, a report's status, an error's kind and
 * the actor's delta text, and ignores the rest. Forwarding the stream as it
 * came meant structured-cloning (once for the IPC, once more through the
 * context bridge) one event per 板砖 token, every tool result in full — a
 * 2000-line read, a `view_image` data URI of several megabytes — every
 * assistant message with its reasoning and tool inputs, every patch preview
 * and the whole execution report, and waking the renderer for each of them
 * to throw it away (perf audit 2026-09-20).
 *
 * So the forwarder decides per event type, here and nowhere else:
 *   – an event the renderer has no use for is not sent (`null`);
 *   – one it counts or branches on is sent with its heavy fields emptied,
 *     still a valid `AgentEvent`, so the wire type does not change.
 * What the user READS never rode this channel: record blocks, the approval
 * overlay and the turn lifecycle have their own.
 *
 * The switch is exhaustive on purpose. A new `AgentEvent` variant does not
 * compile until someone decides, here, whether the renderer needs it — the
 * default for a payload is "no".
 */
export function slimAgentEventForRenderer(
  e: SessionAgentEvent,
): SessionAgentEvent | null {
  if (e.kind !== "agent") return e;
  const ev = e.event;
  switch (ev.type) {
    // Herta's live bubble is the actor's deltas; 板砖's tokens are never
    // shown (D6/D7) — and they are the bulk of the stream.
    case "assistant.delta":
      return ev.layer === "actor" ? e : null;
    // Lifecycle edges the device card and the activity chrome key on.
    case "turn.started":
      return { kind: "agent", event: { ...ev, userText: "" } };
    case "turn.finished":
    case "turn.failed":
    case "recap.compaction":
    case "supervisor.check":
      return e;
    // In-flight counting: one started, one finished, nothing of the result.
    case "tool.call.started":
      return e;
    case "tool.call.finished":
      return {
        kind: "agent",
        event: {
          ...ev,
          result: { ok: ev.result.ok, summary: ev.result.summary },
        },
      };
    // The verdict: only `status` is read.
    case "agent.report":
      return {
        kind: "agent",
        event: {
          ...ev,
          report: {
            taskId: ev.report.taskId,
            status: ev.report.status,
            changedFiles: [],
            evidence: [],
            tests: [],
            permissions: [],
            residualRisks: [],
          },
        },
      };
    // Payloads with their own channel (record blocks, the approval overlay)
    // or no renderer reader at all.
    case "assistant.final":
    case "tool.call.progress":
    case "permission.requested":
    case "permission.resolved":
    case "patch.preview":
    case "verification.started":
    case "verification.finished":
    case "user.steer":
    case "user.talk":
      return null;
    // The live views (ADR 0073): a call's arguments a token at a time, a
    // command's output a chunk at a time. They reach the renderer folded and
    // throttled on their own channel (live-tool-feed.ts), never one per event.
    case "tool.call.delta":
    case "tool.call.output":
      return null;
    default: {
      const undecided: never = ev;
      return undecided;
    }
  }
}
