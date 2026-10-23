/**
 * The page steps' result rows (ADR 0083 §10): what browser_navigate,
 * browser_read, browser_act and browser_screenshot leave in the record.
 * Each finished step is one `→ 差分协处理器` row beside its op row: the body
 * says what came of it, the digest keeps it as data (route, title, counts),
 * and what was read rides the two-state lane, bounded — a tree's first
 * 1 500 chars, the console's first three errors, at most five failed
 * requests. Refs (`e12`) and a URL's query are bookkeeping and never enter
 * the record; a password is masked before it gets here.
 */
import type { EvidenceSection, SystemBlock } from "@herta/core";

/** browser_navigate's result data (`@herta/tools`' `BrowserNavigateData`;
 *  herta does not depend on tools). */
interface PageOpenData {
  readonly url: string;
  readonly title: string;
  readonly status: number | null;
  readonly go?: "back" | "forward" | "reload";
  readonly consoleErrors: readonly string[];
  readonly consoleErrorCount?: number;
}

/** browser_read's (`BrowserReadData`). */
interface PageReadData {
  readonly mode: "tree" | "find" | "text" | "console" | "network";
  readonly url: string;
  readonly title: string;
  readonly count: number;
  readonly truncated: boolean;
  readonly all?: boolean;
  readonly query?: string;
  readonly path?: string;
  readonly text: string;
}

/** browser_act's (`BrowserActData`). */
interface PageActData {
  readonly action: "click" | "type" | "key" | "scroll" | "select" | "resize";
  readonly url: string;
  readonly title: string;
  readonly target?: string;
  readonly hit?: string;
  readonly navigated: boolean;
  readonly typed?: string;
  readonly password?: boolean;
  readonly submit?: boolean;
  readonly key?: string;
  readonly direction?: "up" | "down";
  readonly value?: string;
  readonly preset?: "phone" | "tablet" | "desktop";
  readonly scheme?: "light" | "dark";
  readonly consoleErrors: readonly string[];
  readonly consoleErrorCount?: number;
}

/** browser_screenshot's (`BrowserScreenshotData`). */
interface PageShotData {
  readonly url: string;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly region: boolean;
}

/** How much of a tree or a page's text the record keeps (ADR 0083 §10). */
const PAGE_ROW_CHARS = 1500;
/** Console errors the record keeps. */
const PAGE_ROW_ERRORS = 3;
/** Failed requests the record keeps. */
const PAGE_ROW_FAILURES = 5;

/** A page's route: host, port and path — the app's own route, never the
 *  query or the fragment (ADR 0083 §10). */
export function pageRouteOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === "about:") return url;
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url.replace(/[?#].*$/su, "");
  }
}

const hostOfRoute = (route: string): string => route.split("/")[0] ?? route;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** `（另有 N 个未列出）` — what a bound left out, so no reader takes the list
 *  for the whole. */
const omittedNote = (n: number): string[] =>
  n > 0 ? [`（另有 ${n} 个未列出）`] : [];

/** Console errors as a row's detail: the first three, and how many more. */
function consoleSection(
  errors: readonly string[],
  total: number,
): Pick<SystemBlock, "evidenceDetail" | "evidence"> {
  const items = errors.slice(0, PAGE_ROW_ERRORS).map(oneLine);
  if (items.length === 0) return {};
  const omitted = Math.max(0, total - items.length);
  const text = items.join("\n");
  return {
    evidenceDetail: ["↳ 控制台错误:", text, ...omittedNote(omitted)].join("\n"),
    evidence: [{ kind: "page", mode: "console", text, omitted }],
  };
}

const errorsNote = (n: number): string =>
  n > 0 ? ` · ${n} console error${n === 1 ? "" : "s"}` : "";

/** `↳ opened <route>: "<title>"` — the page 板砖 opened, its status when it
 *  was an error, and the console errors the opening raised. */
export function projectPageOpen(data: PageOpenData): SystemBlock {
  const route = pageRouteOf(data.url);
  const title = oneLine(data.title);
  const errors = data.consoleErrorCount ?? data.consoleErrors.length;
  const status =
    data.status !== null && data.status >= 400 ? ` · HTTP ${data.status}` : "";
  return {
    kind: "system",
    label: "差分协处理器",
    body: `↳ opened ${route}${title !== "" ? `: "${title}"` : ""}${status}${errorsNote(errors)}`,
    digest: {
      kind: "page-open",
      route,
      title,
      status: data.status,
      ...(data.go !== undefined ? { go: data.go } : {}),
      errors,
    },
    ...consoleSection(data.consoleErrors, errors),
  };
}

/** A tree or find line without its ref: `button "Sign in" (disabled)`. */
const withoutRef = (line: string): string => line.replace(/^e\d+\s+/u, "");

/** Lines kept whole up to a char budget; the count of the rest. */
function boundLines(
  lines: readonly string[],
  budget: number,
): { kept: string[]; omitted: number } {
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > budget && kept.length > 0) break;
    kept.push(line);
    size += line.length + 1;
  }
  return { kept, omitted: lines.length - kept.length };
}

/** A console read's messages: one per `[level] ` opening, a message's own
 *  line breaks kept inside it. */
function consoleMessages(text: string): { level: string; text: string }[] {
  if (text.trim() === "") return [];
  return text.split(/\n(?=\[[a-z]+\] )/u).map((m) => {
    const head = /^\[([a-z]+)\] ([\s\S]*)$/u.exec(m);
    return head !== null
      ? { level: head[1] ?? "", text: head[2] ?? "" }
      : { level: "", text: m };
  });
}

/** A network read's failed requests, as `POST /api/login 500`: the mark,
 *  the type and the time dropped, the page's own host left off. */
function failedRequests(text: string, route: string): string[] {
  const host = hostOfRoute(route);
  return text
    .split("\n")
    .filter((l) => l.startsWith("✗ "))
    .map((l) => {
      const parts = l
        .slice(2)
        .replace(/\s+\d+ms$/u, "")
        .split(" ");
      // method, host/path, status or failure…, type
      const [method = "", where = "", ...rest] = parts.slice(0, -1);
      const path = where.startsWith(host) ? where.slice(host.length) : where;
      return [method, path === "" ? "/" : path, ...rest].join(" ");
    });
}

/** What 板砖 read of the page, bounded for the record. */
export function projectPageRead(data: PageReadData): SystemBlock {
  const route = pageRouteOf(data.url);
  const title = oneLine(data.title);
  const base = {
    kind: "page-read" as const,
    mode: data.mode,
    route,
    title,
    count: data.count,
    truncated: data.truncated,
    ...(data.all === true ? { all: true as const } : {}),
    ...(data.query !== undefined ? { query: data.query } : {}),
    ...(data.path !== undefined ? { path: data.path } : {}),
  };
  const row = (
    body: string,
    detail: { header: string; text: string; omitted: number } | null,
    failures?: number,
  ): SystemBlock => ({
    kind: "system",
    label: "差分协处理器",
    body,
    digest: { ...base, ...(failures !== undefined ? { failures } : {}) },
    ...(detail !== null && detail.text !== ""
      ? {
          evidenceDetail: [
            detail.header,
            detail.text,
            ...(data.mode === "text"
              ? detail.omitted > 0
                ? ["…(truncated)"]
                : []
              : omittedNote(detail.omitted)),
          ].join("\n"),
          evidence: [
            {
              kind: "page" as const,
              mode: data.mode,
              text: detail.text,
              omitted: detail.omitted,
            },
          ] satisfies EvidenceSection[],
        }
      : {}),
  });
  switch (data.mode) {
    case "tree":
    case "find": {
      const lines = data.text
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map(withoutRef);
      const { kept, omitted } = boundLines(lines, PAGE_ROW_CHARS);
      // The tool showed 板砖 part of a longer tree: the rest counts too.
      const more = omitted + Math.max(0, data.count - lines.length);
      const body =
        data.mode === "find"
          ? `↳ ${data.count} element${data.count === 1 ? "" : "s"} match "${data.query ?? ""}"`
          : `↳ ${data.count} element${data.count === 1 ? "" : "s"} on ${route}`;
      return row(body, {
        header: data.mode === "find" ? "↳ 匹配元素:" : "↳ 页面元素:",
        text: kept.join("\n"),
        omitted: more,
      });
    }
    case "text": {
      const text = data.text.trim();
      const cut =
        text.length > PAGE_ROW_CHARS
          ? text.slice(0, PAGE_ROW_CHARS).trimEnd()
          : text;
      return row(`↳ page text: ${data.count} chars`, {
        header: "↳ 页面文字:",
        text: cut,
        omitted: data.count - cut.length,
      });
    }
    case "console": {
      const messages = consoleMessages(data.text);
      const errors = messages.filter((m) => m.level === "error");
      const items = errors
        .slice(0, PAGE_ROW_ERRORS)
        .map((m) => oneLine(m.text));
      return row(
        `↳ console: ${data.count} message${data.count === 1 ? "" : "s"}, ${errors.length} error${errors.length === 1 ? "" : "s"}`,
        {
          header: "↳ 控制台错误:",
          text: items.join("\n"),
          omitted: errors.length - items.length,
        },
        errors.length,
      );
    }
    case "network": {
      const failed = failedRequests(data.text, route);
      const items = failed.slice(0, PAGE_ROW_FAILURES);
      return row(
        `↳ network: ${data.count} request${data.count === 1 ? "" : "s"}, ${failed.length} failed`,
        {
          header: "↳ 失败的请求:",
          text: items.join("\n"),
          omitted: failed.length - items.length,
        },
        failed.length,
      );
    }
  }
}

/** The element a step acted on, or what it pressed. */
function actWhat(data: PageActData): string {
  switch (data.action) {
    case "click":
      return `clicked ${data.target ?? "the point"}`;
    case "type":
      return `typed "${data.typed ?? ""}"${data.target !== undefined ? ` into ${data.target}` : ""}${data.submit === true ? " and pressed Enter" : ""}`;
    case "key":
      return `pressed ${data.key ?? ""}`;
    case "scroll":
      return `scrolled ${data.direction ?? "down"}`;
    case "select":
      return data.value !== undefined
        ? `selected "${data.value}" in ${data.target ?? "the element"}`
        : `toggled ${data.target ?? "the element"}`;
    case "resize":
      return `resized to ${data.preset ?? "desktop"}${data.scheme !== undefined ? ` (${data.scheme})` : ""}`;
  }
}

/** What 板砖 typed or chose, as the row keeps it: one line, 200 chars. A
 *  step may type 4 000 chars, and a body survives into every later prompt. */
const PAGE_ROW_TYPED = 200;
const clip = (s: string | undefined): string | undefined => {
  if (s === undefined) return undefined;
  const line = oneLine(s);
  return line.length > PAGE_ROW_TYPED
    ? `${line.slice(0, PAGE_ROW_TYPED - 1)}…`
    : line;
};

/** `↳ clicked button "Sign in"` — what 板砖 did, where the page went, what
 *  the press landed on when it was not the element asked for. */
export function projectPageAct(raw: PageActData): SystemBlock {
  const typed = clip(raw.typed);
  const value = clip(raw.value);
  const data: PageActData = {
    ...raw,
    ...(typed !== undefined ? { typed } : {}),
    ...(value !== undefined ? { value } : {}),
  };
  const route = pageRouteOf(data.url);
  const errors = data.consoleErrorCount ?? data.consoleErrors.length;
  return {
    kind: "system",
    label: "差分协处理器",
    body: `↳ ${actWhat(data)}${data.hit !== undefined ? ` (landed on ${data.hit})` : ""}${data.navigated ? ` → ${route}` : ""}${errorsNote(errors)}`,
    digest: {
      kind: "page-act",
      action: data.action,
      route,
      title: oneLine(data.title),
      navigated: data.navigated,
      ...(data.target !== undefined ? { target: data.target } : {}),
      ...(data.hit !== undefined ? { hit: data.hit } : {}),
      ...(data.typed !== undefined ? { typed: data.typed } : {}),
      ...(data.password === true ? { password: true as const } : {}),
      ...(data.submit === true ? { submit: true as const } : {}),
      ...(data.key !== undefined ? { key: data.key } : {}),
      ...(data.direction !== undefined ? { direction: data.direction } : {}),
      ...(data.value !== undefined ? { value: data.value } : {}),
      ...(data.preset !== undefined ? { preset: data.preset } : {}),
      ...(data.scheme !== undefined ? { scheme: data.scheme } : {}),
      errors,
    },
    ...consoleSection(data.consoleErrors, errors),
  };
}

/** `↳ screenshot <route> · W×H` — the picture is kept at `path`. */
export function projectPageShot(data: PageShotData): SystemBlock {
  const route = pageRouteOf(data.url);
  return {
    kind: "system",
    label: "差分协处理器",
    body: `↳ screenshot ${route}${data.region ? " (region)" : ""} · ${data.width}×${data.height}`,
    digest: {
      kind: "page-shot",
      route,
      path: data.path,
      width: data.width,
      height: data.height,
      region: data.region,
    },
  };
}

/** A finished page step's row, or null for any other tool or a result
 *  without the data its row needs. */
export function projectPageResult(
  tool: string,
  data: unknown,
): SystemBlock | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.url !== "string") return null;
  switch (tool) {
    case "browser_navigate":
      return Array.isArray(d.consoleErrors)
        ? projectPageOpen(d as unknown as PageOpenData)
        : null;
    case "browser_read":
      return typeof d.mode === "string" && typeof d.text === "string"
        ? projectPageRead(d as unknown as PageReadData)
        : null;
    case "browser_act":
      return typeof d.action === "string" && Array.isArray(d.consoleErrors)
        ? projectPageAct(d as unknown as PageActData)
        : null;
    case "browser_screenshot":
      return typeof d.path === "string"
        ? projectPageShot(d as unknown as PageShotData)
        : null;
    default:
      return null;
  }
}
