import type {
  EvidenceSection,
  SystemBlock,
  SystemBlockDigest,
} from "@herta/core";
import type { PromptLang } from "./prompt-lang.js";

/**
 * The page steps' rows as Herta reads them (ADR 0083 §10, in ADR 0079's
 * grammar): what 板砖 opened, read, did and saw, in the session's language.
 * A page reads as host, port and path — never a query, a ref or a stored
 * path — its elements by their role words and names, a password masked.
 * Rebuilt from the digest and the evidence, never from the canonical body.
 */

type PageDigest = Extract<
  SystemBlockDigest,
  { kind: "page-open" | "page-read" | "page-act" | "page-shot" }
>;
type ActDigest = Extract<SystemBlockDigest, { kind: "page-act" }>;
type PageSection = Extract<EvidenceSection, { kind: "page" }>;

export function isPageDigest(
  d: SystemBlockDigest | undefined,
): d is PageDigest {
  return (
    d?.kind === "page-open" ||
    d?.kind === "page-read" ||
    d?.kind === "page-act" ||
    d?.kind === "page-shot"
  );
}

const ROLE: Record<PromptLang, Record<string, string>> = {
  zh: {
    button: "按钮",
    link: "链接",
    textbox: "输入框",
    searchbox: "搜索框",
    checkbox: "复选框",
    radio: "单选按钮",
    combobox: "下拉框",
    listbox: "列表框",
    option: "选项",
    menuitem: "菜单项",
    menuitemcheckbox: "菜单项",
    menuitemradio: "菜单项",
    tab: "标签页",
    switch: "开关",
    slider: "滑块",
    spinbutton: "数字框",
    treeitem: "树节点",
    heading: "标题",
    img: "图片",
    dialog: "对话框",
    alert: "提示",
    navigation: "导航",
    list: "列表",
    listitem: "列表项",
    table: "表格",
    row: "行",
    cell: "单元格",
    form: "表单",
    paragraph: "段落",
  },
  en: {
    textbox: "text box",
    searchbox: "search box",
    combobox: "dropdown",
    listbox: "list box",
    menuitem: "menu item",
    menuitemcheckbox: "menu item",
    menuitemradio: "menu item",
    spinbutton: "number box",
    treeitem: "tree item",
    img: "image",
  },
};

/** One state word of a tree line, as she reads it. */
function stateWord(state: string, lang: PromptLang): string {
  const zh = lang !== "en";
  const quoted = /^(value|selected) "((?:[^"\\]|\\.)*)"$/u.exec(state);
  if (quoted !== null) {
    const v = unquote(`"${quoted[2] ?? ""}"`);
    return quoted[1] === "value"
      ? zh
        ? `内容「${v}」`
        : `holding "${v}"`
      : zh
        ? `选的是「${v}」`
        : `"${v}" selected`;
  }
  const level = /^level (\d+)$/u.exec(state);
  if (level !== null) return zh ? `${level[1]} 级` : state;
  if (!zh) return state;
  return (
    {
      disabled: "不可用",
      checked: "已勾选",
      unchecked: "未勾选",
      expanded: "已展开",
      password: "密码框",
      filled: "已填",
    }[state] ?? state
  );
}

function unquote(q: string): string {
  try {
    const v: unknown = JSON.parse(q);
    return typeof v === "string" ? v : q;
  } catch {
    return q.slice(1, -1);
  }
}

/**
 * An element as the page names it — a tree line, `button "Sign in"
 * (disabled)`, or a step's target — in her words: `按钮「Sign in」（不可用）`,
 * or in English the role word made readable. `article` puts "the" before an
 * English element named in a sentence.
 */
export function pageElementForHerta(
  line: string,
  lang: PromptLang,
  article = false,
): string {
  const m = /^(?:e\d+\s+)?(\S+) ("(?:[^"\\]|\\.)*")(?: \((.*)\))?$/u.exec(
    line.trim(),
  );
  if (m === null) return line.trim();
  const roleRaw = m[1] ?? "";
  const role = ROLE[lang][roleRaw] ?? roleRaw;
  const name = unquote(m[2] ?? '""')
    .replace(/\s+/g, " ")
    .trim();
  const states = (m[3] ?? "")
    .match(/(?:value|selected) "(?:[^"\\]|\\.)*"|[^,]+/gu)
    ?.map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => stateWord(s, lang));
  if (lang === "en") {
    const head = `${article ? "the " : ""}${role}${name !== "" ? ` "${name}"` : ""}`;
    return states !== undefined && states.length > 0
      ? `${head} (${states.join(", ")})`
      : head;
  }
  const head = `${role}${name !== "" ? `「${name}」` : ""}`;
  return states !== undefined && states.length > 0
    ? `${head}（${states.join("，")}）`
    : head;
}

const more = (n: number, lang: PromptLang): string =>
  n > 0
    ? lang === "en"
      ? ` (${n} more not listed)`
      : `（还有 ${n} 个没列出）`
    : "";

/** A step's console errors (the row's evidence), as lines under it. */
function consoleLines(
  errors: number,
  section: PageSection | undefined,
  lang: PromptLang,
): string[] {
  if (errors === 0 || section === undefined) return [];
  const items = section.text.split("\n").filter((l) => l.length > 0);
  const zh = lang !== "en";
  if (items.length === 1 && section.omitted === 0)
    return [
      zh
        ? `控制台 1 个错误：${items[0]}`
        : `The console: 1 error — ${items[0]}`,
    ];
  return [
    zh
      ? `控制台 ${errors} 个错误：${more(section.omitted, lang)}`
      : `The console: ${errors} errors:${more(section.omitted, lang)}`,
    ...items,
  ];
}

const resizeWords = (d: ActDigest, lang: PromptLang): string => {
  const zh = lang !== "en";
  const scheme =
    d.scheme === undefined
      ? ""
      : zh
        ? d.scheme === "dark"
          ? "，深色"
          : "，浅色"
        : `, ${d.scheme}`;
  switch (d.preset) {
    case "phone":
      return zh
        ? `把页面调成手机宽度（375×812）${scheme}`
        : `Set the page to phone width (375×812)${scheme}`;
    case "tablet":
      return zh
        ? `把页面调成平板宽度（768×1024）${scheme}`
        : `Set the page to tablet width (768×1024)${scheme}`;
    default:
      return zh
        ? `把页面恢复成面板的宽度${scheme}`
        : `Set the page back to the panel's width${scheme}`;
  }
};

/** What a page step did, as one sentence. */
function actLine(d: ActDigest, lang: PromptLang): string {
  const zh = lang !== "en";
  const el = (s: string | undefined) =>
    s !== undefined ? pageElementForHerta(s, lang, true) : undefined;
  const target = el(d.target);
  let line: string;
  switch (d.action) {
    case "click":
      line = zh
        ? target !== undefined
          ? `点了${target}`
          : "点了页面上的一个位置"
        : target !== undefined
          ? `Clicked ${target}`
          : "Clicked a point on the page";
      break;
    case "type": {
      const typed =
        d.password === true
          ? (d.typed ?? "")
          : zh
            ? `「${d.typed ?? ""}」`
            : `"${d.typed ?? ""}"`;
      line = zh
        ? `${target !== undefined ? `在${target}里` : ""}输入了 ${typed}${d.submit === true ? "，按了回车" : ""}`
        : `Typed ${typed}${target !== undefined ? ` into ${target}` : ""}${d.submit === true ? ", then pressed Enter" : ""}`;
      break;
    }
    case "key":
      line = zh ? `按了 ${d.key ?? ""}` : `Pressed ${d.key ?? ""}`;
      break;
    case "scroll":
      line =
        d.direction === "up"
          ? zh
            ? "往上滚了一屏"
            : "Scrolled up a screen"
          : zh
            ? "往下滚了一屏"
            : "Scrolled down a screen";
      break;
    case "select":
      line =
        d.value !== undefined
          ? zh
            ? `在${target ?? "元素"}里选了「${d.value}」`
            : `Chose "${d.value}" in ${target ?? "the element"}`
          : zh
            ? `切换了${target ?? "元素"}`
            : `Toggled ${target ?? "the element"}`;
      break;
    case "resize":
      line = resizeWords(d, lang);
      break;
  }
  const hit = el(d.hit);
  if (hit !== undefined)
    line += zh ? `（实际点到的是${hit}）` : ` (the press landed on ${hit})`;
  if (d.navigated)
    line += zh ? `，页面转到 ${d.route}` : `; the page went to ${d.route}`;
  return line;
}

const openVerb = (
  go: "back" | "forward" | "reload" | undefined,
  lang: PromptLang,
): string =>
  lang === "en"
    ? go === "back"
      ? "Went back to"
      : go === "forward"
        ? "Went forward to"
        : go === "reload"
          ? "Reloaded"
          : "Opened"
    : go === "back"
      ? "退回页面"
      : go === "forward"
        ? "前进到页面"
        : go === "reload"
          ? "重新加载页面"
          : "打开页面";

/** A page as host:port/path and its title. */
const pageName = (route: string, title: string, lang: PromptLang): string =>
  lang === "en"
    ? `${route}${title !== "" ? `, "${title}"` : ""}`
    : `${route}${title !== "" ? `「${title}」` : ""}`;

/**
 * One page row as she reads it, from its digest and its evidence. Every
 * page row says something: a read that found nothing says so.
 */
export function pageRowForHerta(
  block: SystemBlock,
  d: PageDigest,
  lang: PromptLang,
): string {
  const zh = lang !== "en";
  const section = block.evidence?.find(
    (e): e is PageSection => e.kind === "page",
  );
  switch (d.kind) {
    case "page-open": {
      const status =
        d.status !== null && d.status >= 400
          ? `${zh ? "，" : ", "}HTTP ${d.status}`
          : "";
      return [
        `${openVerb(d.go, lang)} ${pageName(d.route, d.title, lang)}${status}`,
        ...consoleLines(d.errors, section, lang),
      ].join("\n");
    }
    case "page-act":
      return [actLine(d, lang), ...consoleLines(d.errors, section, lang)].join(
        "\n",
      );
    case "page-shot":
      return d.region
        ? zh
          ? `截了页面 ${d.route} 的一块（${d.width}×${d.height}）`
          : `Took a close-up of part of ${d.route} (${d.width}×${d.height})`
        : zh
          ? `截了一张页面图 ${d.route}（${d.width}×${d.height}）`
          : `Took a screenshot of ${d.route} (${d.width}×${d.height})`;
    case "page-read": {
      const lines = (section?.text ?? "")
        .split("\n")
        .filter((l) => l.length > 0);
      const omitted = section?.omitted ?? 0;
      switch (d.mode) {
        case "tree": {
          if (lines.length === 0)
            return zh
              ? d.all === true
                ? "页面上什么元素也没有"
                : "页面上没有能操作的元素"
              : d.all === true
                ? "Nothing on the page"
                : "Nothing on the page to act on";
          const items = lines.map((l) => pageElementForHerta(l, lang));
          return zh
            ? `${d.all === true ? "页面上的元素" : "页面上能操作的"}：${items.join("、")}${more(omitted, lang)}`
            : `${d.all === true ? "On the page" : "On the page you can act on"}: ${items.join(", ")}${more(omitted, lang)}`;
        }
        case "find": {
          const q = d.query ?? "";
          if (lines.length === 0)
            return zh
              ? `页面上没有名字含「${q}」的元素`
              : `Nothing on the page is named with "${q}"`;
          const items = lines.map((l) => pageElementForHerta(l, lang));
          return zh
            ? `页面上名字含「${q}」的：${items.join("、")}${more(omitted, lang)}`
            : `On the page, named with "${q}": ${items.join(", ")}${more(omitted, lang)}`;
        }
        case "text": {
          const text = section?.text ?? "";
          if (text === "")
            return zh ? "页面上没有文字" : "The page has no text";
          return [
            zh ? "页面文字：" : "The page's text:",
            text,
            ...(omitted > 0
              ? [zh ? "……（后面还有，没贴全）" : "…(more, not shown)"]
              : []),
          ].join("\n");
        }
        case "console": {
          const errors = d.failures ?? lines.length;
          if (errors === 0)
            return zh
              ? `控制台没有错误${d.count > 0 ? `（${d.count} 条消息）` : ""}`
              : `The console: no errors${d.count > 0 ? ` (${d.count} message${d.count === 1 ? "" : "s"})` : ""}`;
          return consoleLines(errors, section, lang).join("\n");
        }
        case "network": {
          const failed = d.failures ?? lines.length;
          if (failed === 0)
            return zh
              ? `网络：${d.count} 个请求，没有失败的`
              : `Network: ${d.count} request${d.count === 1 ? "" : "s"}, none failed`;
          if (lines.length === 1 && omitted === 0)
            return zh ? `网络：${lines[0]}` : `Network: ${lines[0]}`;
          return [
            zh
              ? `网络：${failed} 个请求失败：${more(omitted, lang)}`
              : `Network: ${failed} requests failed:${more(omitted, lang)}`,
            ...lines,
          ].join("\n");
        }
      }
    }
  }
}

/**
 * A page row folded into what came of it (ADR 0083 §10): the page looked
 * at (`看过页面 localhost:5173/login「Vite + React」`), the picture taken, the
 * console and the network as found, and a step that moved the page or
 * raised errors. Null leaves the row out: a click that changed nothing to
 * remember.
 */
export function pageFoldLine(d: PageDigest, lang: PromptLang): string | null {
  const zh = lang !== "en";
  const looked = (route: string, title: string) =>
    zh
      ? `看过页面 ${pageName(route, title, lang)}`
      : `Looked at ${pageName(route, title, lang)}`;
  switch (d.kind) {
    case "page-open":
      return `${looked(d.route, d.title)}${
        d.status !== null && d.status >= 400
          ? zh
            ? `（HTTP ${d.status}）`
            : ` (HTTP ${d.status})`
          : ""
      }${d.errors > 0 ? (zh ? `，控制台报了 ${d.errors} 个错误` : `; the console showed ${d.errors} error${d.errors === 1 ? "" : "s"}`) : ""}`;
    case "page-shot":
      return zh ? `截过图（${d.route}）` : `Took a screenshot of ${d.route}`;
    case "page-act":
      if (!d.navigated && d.errors === 0) return null;
      return `${actLine(d, lang)}${
        d.errors > 0
          ? zh
            ? `，控制台报了 ${d.errors} 个错误`
            : `; the console showed ${d.errors} error${d.errors === 1 ? "" : "s"}`
          : ""
      }`;
    case "page-read":
      switch (d.mode) {
        case "console": {
          const n = d.failures ?? 0;
          return n === 0
            ? zh
              ? "看过控制台，没有错误"
              : "Checked the console: no errors"
            : zh
              ? `控制台报过 ${n} 个错误（原文不在手边）`
              : `The console showed ${n} error${n === 1 ? "" : "s"} (not at hand)`;
        }
        case "network": {
          const n = d.failures ?? 0;
          return n === 0
            ? zh
              ? "看过网络请求，没有失败的"
              : "Checked the network: no failed requests"
            : zh
              ? `网络上有 ${n} 个请求失败（原文不在手边）`
              : `${n} request${n === 1 ? "" : "s"} failed on the network (not at hand)`;
        }
        default:
          return looked(d.route, d.title);
      }
  }
}
