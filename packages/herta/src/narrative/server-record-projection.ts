/**
 * The launcher's rows (ADR 0083 §5, §10): what `dev_server` leaves in the
 * record, and the `→ 系统` notes for a server the Trailblazer started or
 * stopped, or one a relaunch ended. A server reads as its name and where it
 * answers (`localhost:5173`); its log rides the two-state lane, bounded as
 * a background command's output is.
 */
import type { SystemBlock } from "@herta/core";
import { boundedTail } from "./bounded-tail.js";
import { pageRouteOf } from "./page-record-projection.js";

type ServerStateWord = "starting" | "ready" | "exited" | "stopped";

/** dev_server's result data (`@herta/tools`' `DevServerData`). */
interface DevServerResultData {
  readonly action: "list" | "start" | "logs" | "stop";
  readonly name?: string;
  readonly command?: string;
  readonly url?: string;
  readonly already?: boolean;
  readonly state?: ServerStateWord;
  readonly exitCode?: number | null;
  readonly wasRunning?: boolean;
  readonly text?: string;
  readonly entries?: readonly {
    readonly name: string;
    readonly state: ServerStateWord | "idle";
    readonly url: string;
  }[];
}

const row = (body: string, rest: Partial<SystemBlock>): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body,
  ...rest,
});

/** A finished `dev_server` step's row, or null when its data is missing. */
export function projectServerResult(data: unknown): SystemBlock | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as DevServerResultData;
  const name = d.name ?? "";
  switch (d.action) {
    case "start": {
      if (typeof d.url !== "string") return null;
      const route = pageRouteOf(d.url);
      return row(
        d.already === true
          ? `↳ dev server ${name}: ${route} already answers — nothing started`
          : `↳ dev server ${name}: ready at ${route}`,
        {
          digest: {
            kind: "server",
            action: "start",
            by: "banzhuan",
            name,
            command: d.command ?? "",
            route,
            already: d.already === true,
          },
        },
      );
    }
    case "stop":
      return row(
        d.wasRunning === true
          ? `↳ dev server ${name}: stopped`
          : `↳ dev server ${name}: was not running`,
        {
          digest: {
            kind: "server",
            action: "stop",
            by: "banzhuan",
            name,
            wasRunning: d.wasRunning === true,
          },
        },
      );
    case "logs": {
      const state = d.state ?? "ready";
      const tail = boundedTail(d.text ?? "", "", { sourceTruncated: false });
      const lines = (d.text ?? "").trimEnd();
      return row(
        `↳ dev server ${name} log: ${lines === "" ? 0 : lines.split("\n").length} lines · ${state}${state === "exited" && d.exitCode != null ? ` (${d.exitCode})` : ""}`,
        {
          digest: {
            kind: "server",
            action: "logs",
            name,
            state,
            ...(d.exitCode !== undefined ? { exitCode: d.exitCode } : {}),
          },
          ...(tail.text.length > 0
            ? {
                evidenceDetail: `↳ 输出:\n${tail.text}`,
                evidence: [{ kind: "output" as const, text: tail.text }],
              }
            : {}),
        },
      );
    }
    case "list": {
      const entries = (d.entries ?? []).map((e) => ({
        name: e.name,
        state: e.state,
        route: pageRouteOf(e.url),
      }));
      return row(
        `↳ dev servers: ${
          entries.length === 0
            ? "none"
            : entries
                .map((e) => `${e.name} (${e.state}, ${e.route})`)
                .join(", ")
        }`,
        { digest: { kind: "server", action: "list", entries } },
      );
    }
    default:
      return null;
  }
}

/** A launcher event outside 板砖's steps, as a `→ 系统` note (§5, §10). */
export type ServerNote =
  /** The Trailblazer's Run. `already`: its port answered, nothing started. */
  | {
      readonly kind: "started";
      readonly name: string;
      readonly command: string;
      readonly url: string;
      readonly already: boolean;
    }
  /** The Trailblazer's Stop. */
  | { readonly kind: "stopped"; readonly name: string }
  /** Servers the app's last exit left running, ended at this launch. */
  | { readonly kind: "reaped"; readonly names: readonly string[] };

/** The note's block — its canonical body in the record's Chinese chrome,
 *  as the ADR's example writes it; the digest carries it as data. The
 *  caller sanitizes it (`sanitizeSystemBlock`), as every block built
 *  outside the bridge is. */
export function serverNoteBlock(note: ServerNote): SystemBlock {
  switch (note.kind) {
    case "started": {
      const route = pageRouteOf(note.url);
      return {
        kind: "system",
        label: "系统",
        body: note.already
          ? `开拓者要启动开发服务器 ${note.name}，${route} 已经有服务在跑，没再启动`
          : `开拓者启动了开发服务器 ${note.name}（${note.command}），${route}`,
        digest: {
          kind: "server",
          action: "start",
          by: "trailblazer",
          name: note.name,
          command: note.command,
          route,
          already: note.already,
        },
      };
    }
    case "stopped":
      return {
        kind: "system",
        label: "系统",
        body: `开拓者停了开发服务器 ${note.name}`,
        digest: {
          kind: "server",
          action: "stop",
          by: "trailblazer",
          name: note.name,
          wasRunning: true,
        },
      };
    case "reaped":
      return {
        kind: "system",
        label: "系统",
        body: `上次应用退出时，开发服务器 ${note.names.join("、")} 还在跑；这次启动时已经停了`,
        digest: { kind: "server", action: "reaped", names: [...note.names] },
      };
  }
}
