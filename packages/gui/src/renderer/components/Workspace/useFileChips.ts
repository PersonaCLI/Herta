/**
 * The composer's file chips (ADR 0072 amendment 2026-10-20) and the page
 * elements picked into it (ADR 0083 §4): each `@<name>` token the
 * highlight layer draws as a chip, the registry of what each stands for,
 * and the chip menu's state and actions. Split out of Composer.tsx (review
 * 2026-11-10, moved 2026-11-27). Its one effect, which drops the chips an
 * edit removed, runs where it ran: the composer calls the hook where the
 * chips' state was, before any effect of its own.
 */
import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ChipSpan,
  type FileChip,
  findChipSpans,
  type PagePick,
  pruneChips,
  withoutChip,
} from "../../lib/file-mention.js";
import type { SessionStore } from "../../store/session-store.js";
import { hideHoverTip } from "../common/hover-tip.js";

/** Where a chip's menu opens (over the chip), and how it was opened. */
export interface ChipMenuState {
  readonly span: ChipSpan;
  readonly left: number;
  readonly bottom: number;
  /** Opened from the keyboard: the menu takes the focus. */
  readonly byKey: boolean;
}

export interface FileChipsDeps {
  /** The draft: the chips are found in it, and a removal edits it. */
  readonly text: string;
  readonly setText: Dispatch<SetStateAction<string>>;
  /** Where the caret goes once the edited text has rendered. */
  readonly pendingCaret: MutableRefObject<number | null>;
  readonly taRef: RefObject<HTMLTextAreaElement>;
  readonly sessionStore: SessionStore;
}

export interface FileChips {
  readonly chips: readonly FileChip[];
  readonly setChips: Dispatch<SetStateAction<readonly FileChip[]>>;
  /** The chips as of the last render, for handlers that run before React
   *  sees the text a keystroke made. */
  readonly chipsRef: MutableRefObject<readonly FileChip[]>;
  readonly chipSpans: readonly ChipSpan[];
  readonly placedPicks: MutableRefObject<Map<string, PagePick>>;
  readonly chipMenu: ChipMenuState | null;
  readonly setChipMenu: Dispatch<SetStateAction<ChipMenuState | null>>;
  readonly chipCopyOpen: boolean;
  readonly setChipCopyOpen: Dispatch<SetStateAction<boolean>>;
  readonly hoverChip: MutableRefObject<number>;
  readonly lastCaret: MutableRefObject<number>;
  readonly chipUnder: (
    x: number,
    y: number,
  ) => { readonly index: number; readonly el: HTMLElement } | null;
  readonly openChipMenu: (
    index: number,
    el: HTMLElement,
    byKey?: boolean,
  ) => void;
  readonly removeChip: (span: ChipSpan) => void;
  readonly copyText: (value: string) => void;
  readonly absolutePath: (path: string) => string;
}

export function useFileChips(deps: FileChipsDeps): FileChips {
  const { text, setText, pendingCaret, taRef, sessionStore } = deps;
  // File chips (ADR 0072 amendment 2026-10-20): each picked file is an
  // `@<name>` token the highlight layer draws as a chip; the registry says
  // which path each token stands for. Read through a ref by the handlers,
  // which see the text a keystroke made before React does.
  const [chips, setChips] = useState<readonly FileChip[]>([]);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const chipSpans = useMemo(() => findChipSpans(text, chips), [text, chips]);
  // Elements picked on the page (ADR 0083 §4), by line: a line that comes
  // back as words — a hold, a rewind, a recall — still goes as a pick.
  const placedPicks = useRef(new Map<string, PagePick>());
  /** The chip menu: which chip, and where it opens (over the chip). */
  const [chipMenu, setChipMenu] = useState<{
    readonly span: ChipSpan;
    readonly left: number;
    readonly bottom: number;
    /** Opened from the keyboard: the menu takes the focus. */
    readonly byKey: boolean;
  } | null>(null);
  const [chipCopyOpen, setChipCopyOpen] = useState(false);
  const hoverChip = useRef(-1);
  /** The caret before the last selection change — which way a caret that
   *  lands inside a chip is pushed out. */
  const lastCaret = useRef(0);
  useEffect(() => {
    setChips((c) => pruneChips(text, c));
  }, [text]);

  // The chip under a pointer: the highlight layer's chip boxes (it takes no
  // pointer events itself), read at the moment of the event.
  const chipUnder = (
    x: number,
    y: number,
  ): { readonly index: number; readonly el: HTMLElement } | null => {
    const layer = taRef.current?.previousElementSibling;
    if (!(layer instanceof HTMLElement)) return null;
    for (const el of layer.querySelectorAll<HTMLElement>("[data-chip]")) {
      for (const r of el.getClientRects()) {
        if (
          x >= r.left - 2 &&
          x <= r.right + 2 &&
          y >= r.top - 1 &&
          y <= r.bottom + 1
        ) {
          return { index: Number(el.dataset.chip), el };
        }
      }
    }
    return null;
  };
  const openChipMenu = (
    index: number,
    el: HTMLElement,
    byKey = false,
  ): void => {
    const span = chipSpans[index];
    const wrap = taRef.current?.parentElement;
    if (span === undefined || wrap == null) return;
    const w = wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    hideHoverTip();
    setChipCopyOpen(false);
    setChipMenu({
      span,
      left: Math.max(0, r.left - w.left),
      bottom: w.bottom - r.top + 6,
      byKey,
    });
  };
  /** Take a chip's token out of the text, with the space after it. */
  const removeChip = (span: ChipSpan): void => {
    const end = text[span.end] === " " ? span.end + 1 : span.end;
    pendingCaret.current = span.start;
    setChips((c) => withoutChip(c, span.chip));
    setText(`${text.slice(0, span.start)}${text.slice(end)}`);
    setChipMenu(null);
    taRef.current?.focus({ preventScroll: true });
  };
  const copyText = (value: string): void => {
    void navigator.clipboard?.writeText(value).catch(() => undefined);
    setChipMenu(null);
    taRef.current?.focus({ preventScroll: true });
  };
  /** The chip's path on this machine: the session's workspace joined in its
   *  own separator. */
  const absolutePath = (path: string): string => {
    const root = sessionStore.getSnapshot().backendWorkspace;
    if (root === null) return path;
    const sep = root.includes("\\") ? "\\" : "/";
    return `${root.replace(/[\\/]+$/u, "")}${sep}${path.split("/").join(sep)}`;
  };
  return {
    chips,
    setChips,
    chipsRef,
    chipSpans,
    placedPicks,
    chipMenu,
    setChipMenu,
    chipCopyOpen,
    setChipCopyOpen,
    hoverChip,
    lastCaret,
    chipUnder,
    openChipMenu,
    removeChip,
    copyText,
    absolutePath,
  };
}
