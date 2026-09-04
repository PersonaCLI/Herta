/**
 * The demo workspace's FILES (2026-09-04, the 0.1.4 file viewer): what the
 * showcase record names, served to the renderer's viewer panel through the
 * demo bridge's `readWorkspaceFile` — the same read the desktop app makes
 * against the session's workspace (ADR 0050 §2), so a click on a file name
 * in the demo opens the real panel with the real renderers.
 *
 * Same honesty rule as the record rows: every file here is one the record
 * says exists, with the content the record's rows imply. The patched
 * event-bus.ts carries the preview's `+` lines verbatim; the alerts log has
 * the three WARN lines at exactly the excerpt's range; the crash log is the
 * 412-line file the attachment row measured, opening with the head the row
 * shows. Unknown paths read as `not_found`, which is what an unserveable
 * path IS here.
 */

/** The event bus after 板砖's patch. `note` is the language's @deprecated
 *  comment — the one line of the diff that differs between zh and en. The
 *  `+` lines of EVENT_BUS_DIFF (demo-bridge.ts) appear here verbatim. */
export function eventBusAfterPatch(note: string): string {
  return `import type { AgentEvent } from "./types/events.js";
import type { EventBus } from "./types/event-bus.js";
import { TypedQueues } from "./typed-queues.js";

/**
 * The shared bus (D2): every runtime event — actor and backend alike —
 * passes through here once. Consumers subscribe by TYPE and read the
 * events as an async iterable; the callback entry point below survives
 * only so the public signature holds.
 */
export class InMemoryEventBus implements EventBus<AgentEvent> {
  private readonly queues = new TypedQueues<AgentEvent>();

  publish(event: AgentEvent): void {
    this.queues.push(event);
  }

  /** ${note} */
  addListener(type: string, cb: (e: AgentEvent) => void): void {
    void this.drain(type, cb);
  }

  subscribe<T extends AgentEvent["type"]>(
    type: T,
  ): AsyncIterable<Extract<AgentEvent, { type: T }>> {
    return this.queues.open(type);
  }

  private async drain(
    type: string,
    cb: (e: AgentEvent) => void,
  ): Promise<void> {
    for await (const event of this.queues.open(type)) cb(event);
  }
}
`;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const hms = (minutes: number, seconds: number): string =>
  `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:${pad(seconds)}`;

/** The overnight alerts log the excerpt cites. Sixty lines; lines 41–43 are
 *  the three WARN lines the excerpt row shows, in the same words. */
export function alertsLog(): string {
  const lines: string[] = [];
  // 40 quiet readings, every ~4.7 minutes from midnight to just before the
  // first alert at 03:14.
  for (let i = 0; i < 40; i += 1) {
    const m = Math.floor((i * 190) / 60);
    const s = (i * 190) % 60;
    const temp = (38.2 + ((i * 7) % 11) / 10).toFixed(1);
    lines.push(`${hms(m, s)}  INFO  sensor-07  temp ${temp}  (ok)`);
  }
  lines.push("03:14:07  WARN  sensor-07  temp 41.2 > 40.0  (dwell 0.4s)");
  lines.push("04:02:51  WARN  sensor-07  temp 40.3 > 40.0  (dwell 0.2s)");
  lines.push("05:47:33  WARN  sensor-07  temp 40.1 > 40.0  (dwell 0.1s)");
  // 17 more readings, 05:50 → 07:58.
  for (let i = 0; i < 17; i += 1) {
    const m = 350 + i * 8;
    const temp = (38.4 + ((i * 5) % 9) / 10).toFixed(1);
    lines.push(`${hms(m, 12)}  INFO  sensor-07  temp ${temp}  (ok)`);
  }
  return `${lines.join("\n")}\n`;
}

/** The crash log ops sent over: the head the attachment row shows, then the
 *  restart echo the reply describes — 412 lines, as the row measured. */
export function crashLog(): string {
  const stamp = (secondsAfter: number): string => {
    const base = 3 * 3600 + 14 * 60 + 7 + secondsAfter;
    return `2026-08-02T${hms(Math.floor(base / 60), base % 60)}Z`;
  };
  const lines = [
    `${stamp(0)} FATAL  worker-3    heap out of memory`,
    "  at TelemetryBuffer.flush (telemetry/buffer.ts:88)",
    "  at Timeout._onTimeout (telemetry/buffer.ts:31)",
    `${stamp(0)} INFO   supervisor  worker-3 exited (code 134)`,
    `${stamp(2)} INFO   supervisor  worker-3 restarted`,
  ];
  // Fifty restart cycles, ~2 minutes apart: boot, arm the buffer, climb, die.
  for (let i = 0; i < 50; i += 1) {
    const t = 4 + i * 124;
    const heap = (1.61 + ((i * 3) % 7) / 20).toFixed(2);
    lines.push(
      `${stamp(t)} INFO   worker-3    booting (pid ${4021 + i})`,
      `${stamp(t + 1)} INFO   worker-3    telemetry buffer armed (interval 30s)`,
      `${stamp(t + 96)} WARN   worker-3    heap ${heap} GB / 2.00 GB`,
      `${stamp(t + 120)} FATAL  worker-3    heap out of memory`,
      "  at TelemetryBuffer.flush (telemetry/buffer.ts:88)",
      "  at Timeout._onTimeout (telemetry/buffer.ts:31)",
      `${stamp(t + 120)} INFO   supervisor  worker-3 exited (code 134)`,
      `${stamp(t + 122)} INFO   supervisor  worker-3 restarted`,
    );
  }
  lines.push(
    `${stamp(6204)} INFO   worker-3    booting (pid 4071)`,
    `${stamp(6205)} INFO   worker-3    telemetry buffer armed (interval 30s)`,
    `${stamp(6300)} WARN   worker-3    heap 1.71 GB / 2.00 GB`,
    `${stamp(6324)} FATAL  worker-3    heap out of memory`,
    "  at TelemetryBuffer.flush (telemetry/buffer.ts:88)",
    "  at Timeout._onTimeout (telemetry/buffer.ts:31)",
    `${stamp(6324)} INFO   supervisor  worker-3 exited (code 134)`,
  );
  return `${lines.join("\n")}\n`;
}

/** Stored path → content, keyed exactly as the showcase rows spell them. */
export function demoWorkspaceFiles(
  eventBusNote: string,
): Readonly<Record<string, string>> {
  return {
    "packages/core/src/event-bus.ts": eventBusAfterPatch(eventBusNote),
    "logs/alerts/2026-07-31.log": alertsLog(),
    ".herta/attachments/s-4f1c/crash-2026-08-02-3f9c1a20.log": crashLog(),
  };
}
