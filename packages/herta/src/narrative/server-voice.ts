import type { SystemBlock, SystemBlockDigest } from "@herta/core";
import type { PromptLang } from "./prompt-lang.js";

/**
 * The launcher's rows as Herta reads them (ADR 0083 §10): which dev server
 * started, where it answers, who started or stopped it, what its log says —
 * in the session's language, never its log path.
 */

type ServerDigest = Extract<SystemBlockDigest, { kind: "server" }>;

const STATE: Record<PromptLang, Record<string, string>> = {
  zh: {
    starting: "启动中",
    ready: "在跑",
    exited: "退出了",
    stopped: "停了",
    idle: "没启动",
  },
  en: {
    starting: "starting",
    ready: "running",
    exited: "exited",
    stopped: "stopped",
    idle: "not started",
  },
};

/** One launcher row as she reads it. */
export function serverRowForHerta(
  block: SystemBlock,
  d: ServerDigest,
  lang: PromptLang,
): string {
  const zh = lang !== "en";
  switch (d.action) {
    case "start":
      if (d.already)
        return zh
          ? `${d.by === "trailblazer" ? "开拓者要启动" : "要启动"}开发服务器 ${d.name}，${d.route} 已经有服务在跑，没再启动`
          : `${d.by === "trailblazer" ? "The Trailblazer went to start" : "Went to start"} dev server ${d.name}: something already answers at ${d.route}, so nothing was started`;
      return d.by === "trailblazer"
        ? zh
          ? `开拓者启动了开发服务器 ${d.name}（${d.command}），${d.route}`
          : `The Trailblazer started dev server ${d.name} (${d.command}): ${d.route}`
        : zh
          ? `开发服务器 ${d.name} 起来了：${d.route}`
          : `Started dev server ${d.name}: ${d.route}`;
    case "stop":
      if (!d.wasRunning)
        return zh
          ? `开发服务器 ${d.name} 本来就没在跑`
          : `Dev server ${d.name} was not running`;
      return d.by === "trailblazer"
        ? zh
          ? `开拓者停了开发服务器 ${d.name}`
          : `The Trailblazer stopped dev server ${d.name}`
        : zh
          ? `停了开发服务器 ${d.name}`
          : `Stopped dev server ${d.name}`;
    case "logs": {
      const output = block.evidence?.find((e) => e.kind === "output");
      const text = output?.kind === "output" ? output.text : "";
      const head =
        d.state === "exited"
          ? zh
            ? `开发服务器 ${d.name} 已经退出${d.exitCode != null ? `（退出码 ${d.exitCode}）` : ""}，日志：`
            : `Dev server ${d.name} has exited${d.exitCode != null ? ` (exit code ${d.exitCode})` : ""}; its log:`
          : zh
            ? `开发服务器 ${d.name} 的日志：`
            : `Dev server ${d.name}'s log:`;
      return text === ""
        ? `${head}${zh ? "没有新输出" : " no new output"}`
        : `${head}\n${text}`;
    }
    case "list":
      return d.entries.length === 0
        ? zh
          ? "herta.launch.json 里没有开发服务器"
          : "herta.launch.json names no dev servers"
        : zh
          ? `开发服务器：${d.entries.map((e) => `${e.name}（${STATE.zh[e.state]}，${e.route}）`).join("、")}`
          : `Dev servers: ${d.entries.map((e) => `${e.name} (${STATE.en[e.state]}, ${e.route})`).join(", ")}`;
    case "reaped":
      return zh
        ? `上次应用退出时，开发服务器 ${d.names.join("、")} 还在跑；这次启动时已经停了`
        : `When the app last quit, dev server${d.names.length === 1 ? "" : "s"} ${d.names.join(", ")} ${d.names.length === 1 ? "was" : "were"} still running; stopped at this launch`;
  }
}

/** A launcher row folded: a server started or stopped, one that exited,
 *  one a relaunch ended. A list, a quiet log or a stop of nothing leave no
 *  line. */
export function serverFoldLine(
  d: ServerDigest,
  lang: PromptLang,
): string | null {
  const zh = lang !== "en";
  const tb =
    d.action !== "list" &&
    d.action !== "logs" &&
    d.action !== "reaped" &&
    d.by === "trailblazer";
  switch (d.action) {
    case "start":
      if (d.already)
        return zh
          ? `${d.route} 上已经有服务在跑`
          : `Something already answered at ${d.route}`;
      return zh
        ? `${tb ? "开拓者" : ""}起过开发服务器 ${d.name}（${d.route}）`
        : `${tb ? "The Trailblazer started" : "Started"} dev server ${d.name} (${d.route})`;
    case "stop":
      if (!d.wasRunning) return null;
      return zh
        ? `${tb ? "开拓者" : ""}停过开发服务器 ${d.name}`
        : `${tb ? "The Trailblazer stopped" : "Stopped"} dev server ${d.name}`;
    case "logs":
      return d.state === "exited"
        ? zh
          ? `开发服务器 ${d.name} 退出过${d.exitCode != null ? `（退出码 ${d.exitCode}）` : ""}`
          : `Dev server ${d.name} had exited${d.exitCode != null ? ` (exit code ${d.exitCode})` : ""}`
        : null;
    case "list":
      return null;
    case "reaped":
      return serverRowForHerta(
        { kind: "system", label: "系统", body: "" },
        d,
        lang,
      );
  }
}
