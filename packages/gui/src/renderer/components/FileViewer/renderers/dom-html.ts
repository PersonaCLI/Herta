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
 */
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
  });
}

const CONFIG: Parameters<typeof DOMPurify.sanitize>[1] = {
  USE_PROFILES: { html: true },
  ADD_ATTR: ["data-href"],
  // No <style> from content: the viewer styles the page, the page does not.
  FORBID_TAGS: ["style", "form", "input", "button"],
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
