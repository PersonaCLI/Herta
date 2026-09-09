import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armHoverTip,
  getHoverTip,
  HOVER_TIP_DELAY_MS,
  hideHoverTip,
  hoverTipProps,
  showHoverTip,
  subscribeHoverTip,
} from "./hover-tip.js";

function anchor(): HTMLElement {
  const el = document.createElement("span");
  document.body.appendChild(el);
  el.getBoundingClientRect = () =>
    ({ left: 40, top: 300, width: 200, height: 18 }) as DOMRect;
  return el;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  hideHoverTip();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("hover-tip", () => {
  it("arms after the dwell with the anchor's rectangle; a leave before then shows nothing", () => {
    const changes: number[] = [];
    const unsub = subscribeHoverTip(() => changes.push(1));
    const el = anchor();
    armHoverTip(el, "归并排序本体加验证脚本，验证已跑过");
    vi.advanceTimersByTime(HOVER_TIP_DELAY_MS - 1);
    expect(getHoverTip()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(getHoverTip()).toEqual({
      text: "归并排序本体加验证脚本，验证已跑过",
      anchor: { left: 40, top: 300, width: 200, height: 18 },
    });
    hideHoverTip();
    expect(getHoverTip()).toBeNull();
    expect(changes).toHaveLength(2);
    // Leave during the dwell: cancelled, never shown.
    armHoverTip(el, "x");
    hideHoverTip();
    vi.advanceTimersByTime(HOVER_TIP_DELAY_MS + 10);
    expect(getHoverTip()).toBeNull();
    unsub();
  });

  it("focus shows at once; an anchor that left the DOM during the dwell raises no tip", () => {
    const el = anchor();
    showHoverTip(el, "now");
    expect(getHoverTip()?.text).toBe("now");
    hideHoverTip();
    armHoverTip(el, "later");
    el.remove();
    vi.advanceTimersByTime(HOVER_TIP_DELAY_MS + 10);
    expect(getHoverTip()).toBeNull();
  });

  it("hoverTipProps wires the four handlers, and none for an empty text", () => {
    expect(hoverTipProps("")).toEqual({});
    const props = hoverTipProps("subject");
    const el = anchor();
    props.onMouseEnter?.({
      currentTarget: el,
    } as unknown as React.MouseEvent<Element>);
    vi.advanceTimersByTime(HOVER_TIP_DELAY_MS + 1);
    expect(getHoverTip()?.text).toBe("subject");
    props.onMouseLeave?.();
    expect(getHoverTip()).toBeNull();
    props.onFocus?.({
      currentTarget: el,
    } as unknown as React.FocusEvent<Element>);
    expect(getHoverTip()?.text).toBe("subject");
    props.onBlur?.();
    expect(getHoverTip()).toBeNull();
  });
});
