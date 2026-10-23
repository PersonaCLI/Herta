/**
 * The harness's own read script (ADR 0083 §6, spike 2026-10-23): installed
 * once per document in an isolated world the debugger creates, so it shares
 * the page's DOM and none of its globals. It reads roles and names, keeps
 * the refs it hands out in its own map, scrolls an element into view before
 * a press, and — for a select box only — sets the chosen option the way a
 * user's pick would. It never runs anything 板砖 wrote: 板砖 names a step,
 * the harness calls one of these functions with plain arguments.
 *
 * Measured on four real pages: about 4 ms a read, at most 0.3 ms of the main
 * process's time, where Chromium's full accessibility tree cost 27–281 ms.
 */

/** What `snapshot` and `find` answer. */
export interface ReadElements {
  readonly lines: string;
  readonly count: number;
  readonly shown: number;
  readonly full: string;
}

/** What `locate` answers for a ref. */
export type Located =
  | { readonly missing: true }
  | { readonly stale: true }
  | {
      readonly x: number;
      readonly y: number;
      readonly target: string;
      /** What is on top at the element's centre, when it is not the
       *  element: a press there would land on it. */
      readonly hit: string | null;
      readonly password: boolean;
      readonly select: boolean;
      readonly toggle: boolean;
    };

export const READ_SCRIPT = String.raw`(() => {
  if (globalThis.__herta) return true;
  const refs = new Map();
  const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox",
    "checkbox", "radio", "combobox", "listbox", "option", "menuitem",
    "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider",
    "spinbutton", "treeitem"]);
  const SELECTOR = 'a[href],button,input,select,textarea,summary,[role],' +
    '[contenteditable=""],[contenteditable="true"],[tabindex]';
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r.split(" ")[0];
    const t = el.tagName;
    if (t === "A" && el.hasAttribute("href")) return "link";
    if (t === "BUTTON" || t === "SUMMARY") return "button";
    if (t === "SELECT") return el.multiple ? "listbox" : "combobox";
    if (t === "TEXTAREA") return "textbox";
    if (t === "INPUT") {
      const ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "hidden") return null;
      if (ty === "checkbox" || ty === "radio") return ty;
      if (ty === "range") return "slider";
      if (ty === "number") return "spinbutton";
      if (ty === "submit" || ty === "button" || ty === "reset" || ty === "image") return "button";
      return ty === "search" ? "searchbox" : "textbox";
    }
    if (el.isContentEditable) return "textbox";
    if (/^H[1-6]$/.test(t)) return "heading";
    if (t === "IMG") return "img";
    if (t === "NAV") return "navigation";
    if (t === "MAIN") return "main";
    if (t === "FORM") return "form";
    return null;
  };
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by.split(/\s+/).map((id) => {
        const n = document.getElementById(id);
        return n ? n.innerText || n.textContent : "";
      }).join(" ");
      if (clean(text)) return clean(text);
    }
    if (el.labels && el.labels.length > 0) return clean(el.labels[0].innerText);
    if (el.tagName === "IMG") return clean(el.getAttribute("alt"));
    if (el.tagName === "INPUT" && (el.type === "submit" || el.type === "button" || el.type === "reset"))
      return clean(el.value);
    const own = clean(el.innerText);
    if (own) return own;
    return clean(el.getAttribute("placeholder") || el.getAttribute("title") || "");
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  const stateOf = (el, role) => {
    const parts = [];
    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    if (role === "checkbox" || role === "radio" || role === "switch")
      parts.push(el.checked || el.getAttribute("aria-checked") === "true" ? "checked" : "unchecked");
    if (el.getAttribute("aria-expanded") === "true") parts.push("expanded");
    if (role === "textbox" || role === "searchbox") {
      if (el.type === "password") parts.push(el.value ? "password, filled" : "password");
      else if (el.value) parts.push("value " + JSON.stringify(String(el.value).slice(0, 40)));
    }
    if (role === "combobox" && el.tagName === "SELECT" && el.selectedOptions[0])
      parts.push("selected " + JSON.stringify(clean(el.selectedOptions[0].text)));
    if (role === "heading") parts.push("level " + el.tagName.slice(1));
    return parts.length > 0 ? " (" + parts.join(", ") + ")" : "";
  };
  const describe = (el) => {
    const role = roleOf(el) || el.tagName.toLowerCase();
    return role + " " + JSON.stringify(nameOf(el));
  };
  const bounded = (lines, budget) => {
    const out = [];
    let size = 0;
    for (const l of lines) {
      if (size + l.length + 1 > budget) break;
      out.push(l);
      size += l.length + 1;
    }
    return { lines: out.join("\n"), count: lines.length, shown: out.length, full: lines.join("\n") };
  };
  const walk = (root, all) => {
    refs.clear();
    const lines = [];
    let n = 0;
    for (const el of root.querySelectorAll(all ? "*" : SELECTOR)) {
      const role = roleOf(el);
      if (!role) continue;
      if (!all && !INTERACTIVE.has(role)) continue;
      if (!visible(el)) continue;
      n += 1;
      const ref = "e" + n;
      refs.set(ref, el);
      lines.push(ref + " " + role + " " + JSON.stringify(nameOf(el)) + stateOf(el, role));
    }
    return lines;
  };
  globalThis.__herta = {
    snapshot(all, rootRef, budget) {
      let root = document;
      if (rootRef) {
        const el = refs.get(rootRef);
        if (!el || !el.isConnected) return { missing: true };
        root = el;
      }
      return bounded(walk(root, all), budget);
    },
    find(query, max, budget) {
      const q = String(query).toLowerCase();
      const lines = walk(document, false).filter((l) => l.toLowerCase().includes(q));
      return bounded(lines.slice(0, max), budget);
    },
    text(budget) {
      const t = document.body ? document.body.innerText : "";
      return { lines: t.slice(0, budget), count: t.length, shown: Math.min(t.length, budget), full: t };
    },
    // The Trailblazer's pick (ADR 0083 §4): the nearest element one can act
    // on, a few levels up from what the click hit (a button's own text, say),
    // as the page names it, with its HTML.
    describeNode(el) {
      let n = el && el.nodeType === 1 ? el : el && el.parentElement;
      let chosen = n;
      for (let i = 0; n && i < 4; i += 1) {
        const r = roleOf(n);
        if (r && INTERACTIVE.has(r)) { chosen = n; break; }
        n = n.parentElement;
      }
      if (!chosen) return null;
      return { element: describe(chosen), html: String(chosen.outerHTML || "").slice(0, 2000) };
    },
    locate(ref) {
      const el = refs.get(ref);
      if (!el) return { missing: true };
      if (!el.isConnected) return { stale: true };
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      const on = !top || top === el || el.contains(top) || top.contains(el) ||
        (el.labels && Array.from(el.labels).some((l) => l.contains(top)));
      return {
        x, y,
        target: describe(el),
        hit: on ? null : describe(top),
        password: el.tagName === "INPUT" && el.type === "password",
        select: el.tagName === "SELECT",
        toggle: el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio"),
      };
    },
    at(x, y) {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      return {
        target: describe(el),
        password: el.tagName === "INPUT" && el.type === "password",
      };
    },
    choose(ref, value) {
      const el = refs.get(ref);
      if (!el || !el.isConnected || el.tagName !== "SELECT") return { chosen: null };
      const want = String(value).toLowerCase();
      const opt = Array.from(el.options).find((o) =>
        o.value.toLowerCase() === want || clean(o.text).toLowerCase() === want) ||
        Array.from(el.options).find((o) => clean(o.text).toLowerCase().includes(want));
      if (!opt) return { chosen: null, options: Array.from(el.options).slice(0, 20).map((o) => clean(o.text)) };
      el.value = opt.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { chosen: clean(opt.text) };
    },
    viewport() {
      return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
    },
  };
  return true;
})()`;
