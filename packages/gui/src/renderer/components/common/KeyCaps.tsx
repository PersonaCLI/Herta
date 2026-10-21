import { Fragment, memo } from "react";
import {
  type Binding,
  bindingCaps,
  type ShortcutId,
  shortcut,
} from "../../../shared/shortcuts.js";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";

/** Whether the keys are drawn for macOS (⌘ ⇧ ↩) or as words (Ctrl Shift). */
export function useMacKeys(): boolean {
  return useHertaBridge().bridge.platform === "darwin";
}

/**
 * A shortcut as keycaps (ADR 0082 §9): one cap per key, the alternatives side
 * by side. Pass the command's `id` (its keys from the table) or `keys`.
 * Memoized: a tooltip re-renders with its control (the composer's paperclip
 * on every keystroke), and its keys never change with it.
 */
export const KeyCaps = memo(function KeyCaps(props: {
  readonly id?: ShortcutId;
  readonly keys?: readonly Binding[];
  readonly className?: string;
  /** Inside a control that names its keys itself (`aria-keyshortcuts`):
   *  hidden from assistive technology, so the control's name stays its
   *  label. */
  readonly decorative?: boolean;
}): JSX.Element | null {
  const mac = useMacKeys();
  const keys =
    props.keys ?? (props.id !== undefined ? shortcut(props.id).keys : []);
  if (keys.length === 0) return null;
  return (
    <span
      className={`keycaps${props.className !== undefined ? ` ${props.className}` : ""}`}
      aria-hidden={props.decorative === true ? true : undefined}
    >
      {keys.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a binding list is fixed per command
        <Fragment key={i}>
          {i > 0 && <span className="keycaps__or" />}
          {bindingCaps(b, mac).map((cap, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: caps are positional
            <kbd key={j} className="keycap">
              {cap}
            </kbd>
          ))}
        </Fragment>
      ))}
    </span>
  );
});
