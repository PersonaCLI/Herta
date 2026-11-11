import DOMPurify from "dompurify";

/**
 * The ONE door HTML strings take into the viewer's DOM (ADR 0054 §5).
 * Markdown and highlighted code both arrive as strings from their
 * libraries; both pass through DOMPurify here and are adopted as nodes —
 * the renderer never assigns innerHTML.
 *
 * Anchors lose their `href` (kept as `data-href` so the text can still show
 * where it pointed): the panel is display chrome inside the privileged
 * window, and `will-navigate` is the backstop, not the policy.
 *
 * What an element LOADS is read as well (review 2026-11-10). The page's
 * policy lets an image come from `'self'`, and on the packaged app's `file:`
 * page that is every `file:` URL — one that names a HOST included.
 * `![x](//host/share/x.png)` in a README made Windows open `\\host\share`,
 * and opening a share sends the user's NTLM hash to whoever runs the host.
 * An address that leaves the machine that way is taken off the element; a
 * local file, `data:` and `blob:` are left, and `http(s)` stays the policy's
 * to refuse. Inline `style` goes for the same reason and one more: its
 * `url(...)` loads the same way, and its `position` could draw over the app.
 */

/** The elements that load what an attribute names, and the attribute. */
const LOADERS: Readonly<Record<string, readonly string[]>> = {
  IMG: ["src", "srcset"],
  SOURCE: ["src", "srcset"],
  VIDEO: ["src", "poster"],
  AUDIO: ["src"],
  TRACK: ["src"],
};

/** Whether loading `raw` would open another machine's share. */
export function leavesTheMachine(raw: string): boolean {
  const value = raw.trim();
  // `//host/x` and `\\host\x`: a network path whatever the page's scheme.
  if (/^[\\/]{2}/u.test(value)) return true;
  let url: URL;
  try {
    url = new URL(value, document.baseURI);
  } catch {
    return true;
  }
  if (url.protocol !== "file:") return false;
  if (url.hostname !== "" && url.hostname !== "localhost") return true;
  // `file:////host/share` has no host and a path Windows reads as one.
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // an odd escape: judged as written
  }
  return /^\/\//u.test(path.replace(/\\/g, "/"));
}

/** `srcset` is a list of addresses, each with an optional size after it. */
function anyLeaves(attr: string, value: string): boolean {
  if (attr !== "srcset") return leavesTheMachine(value);
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/u)[0] ?? "")
    .some((address) => address !== "" && leavesTheMachine(address));
}

let hooked = false;
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    // An image map's <area> links as an anchor does.
    if (node.tagName === "A" || node.tagName === "AREA") {
      const href = node.getAttribute("href");
      if (href !== null) {
        node.setAttribute("data-href", href);
        node.removeAttribute("href");
      }
      node.removeAttribute("target");
    }
    for (const attr of LOADERS[node.tagName] ?? []) {
      const value = node.getAttribute(attr);
      if (value !== null && anyLeaves(attr, value)) node.removeAttribute(attr);
    }
  });
}

const CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  USE_PROFILES: { html: true },
  ADD_ATTR: ["data-href"],
  // No <style> from content: the viewer styles the page, the page does not.
  FORBID_TAGS: ["style", "form", "input", "button"],
  // Nor a `style` on an element, nor the old `background` that loads an
  // image for a table or a cell.
  FORBID_ATTR: ["style", "background"],
};

/**
 * Sanitize `html` and make it the whole content of `el`. With `onlyTags`,
 * those tags and no attribute at all, whatever the profile allows: for
 * text a web page shaped (Flow's article), where a kept `style` or `class`
 * could draw the app's own chrome — a fake note in Herta's hand.
 */
export function setSanitizedHtml(
  el: Element,
  html: string,
  onlyTags?: readonly string[],
): void {
  ensureHooks();
  const frag = DOMPurify.sanitize(
    html,
    onlyTags === undefined
      ? { ...CONFIG, RETURN_DOM_FRAGMENT: true }
      : {
          ALLOWED_TAGS: [...onlyTags],
          ALLOWED_ATTR: [],
          RETURN_DOM_FRAGMENT: true,
        },
  );
  el.replaceChildren(frag);
}

/** Sanitize `html` into a detached fragment (callers that post-process
 *  before insertion — the Markdown renderer swaps fences for diagrams). */
export function sanitizedFragment(html: string): DocumentFragment {
  ensureHooks();
  return DOMPurify.sanitize(html, { ...CONFIG, RETURN_DOM_FRAGMENT: true });
}
