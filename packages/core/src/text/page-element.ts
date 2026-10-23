/**
 * An element of a page in the words of a session's language (ADR 0083
 * §4, §10): Herta's view of a page step and the composer's picked-element
 * chip name an element the same way — `按钮「Sign in」` — so the chip the
 * Trailblazer saw is what she reads. Shared through the
 * `@herta/core/page-element` subpath: the renderer bundle must not pull the
 * package root (node built-ins).
 */

type Lang = "zh" | "en";

const ROLE: Record<Lang, Record<string, string>> = {
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
function stateWord(state: string, lang: Lang): string {
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
export function pageElementWords(
  line: string,
  lang: Lang,
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

/**
 * A message with each element picked on the page (ADR 0083 §4) named in
 * the session's words in place of its line — what Herta, the sidebar and
 * the title read. 板砖 alone reads the line: the page's host and path, the
 * element and its HTML.
 */
export function namePickedElements(
  text: string,
  picks:
    | readonly { readonly line: string; readonly element: string }[]
    | undefined,
  lang: Lang,
): string {
  if (picks === undefined || picks.length === 0) return text;
  let out = text;
  for (const p of [...picks].sort((a, b) => b.line.length - a.line.length)) {
    if (p.line === "") continue;
    out = out.split(p.line).join(pageElementWords(p.element, lang));
  }
  return out;
}
