// The 回到底部 (jump-to-latest) chip's lifecycle: when appended blocks light
// it, and its enter/exit presence. Extracted from Conversation.tsx on
// 2026-09-03 (owner's request: the file hosted five state machines). The
// chip's STATE (`pinnedState`, `newBelow`) and its click (`jumpToLatest`)
// live in the scroll engine; this hook is the record-growth trigger and the
// presence controller, kept here so they sit at the same point of the effect
// order they always had. The reveal's per-frame growth lights the chip
// through useSupervisorHold's `onRevealGrow` (same engine intent).

import type { TerminalRecord } from "@herta/app-server";
import { useEffect, useRef } from "react";
import { usePresence } from "../../hooks/usePresence.js";
import type { ConversationScroll } from "./useConversationScroll.js";

export function useJumpChip(opts: {
  readonly scroll: ConversationScroll;
  readonly record: TerminalRecord;
  readonly recordStart: number;
  readonly sessionId: string | null;
}): { mounted: boolean; open: boolean } {
  const { scroll, record, recordStart, sessionId } = opts;

  // Appended blocks light the chip the same way (record identity changes per
  // block, not per delta). Windowing (2026-07-12): compare ABSOLUTE end
  // indices so a "load earlier" PREPEND — which also changes record identity
  // while the reader is scrolled up — never lights the chip; only genuine
  // growth at the bottom does. A session switch re-baselines silently.
  const lastEndRef = useRef<{ sid: string | null; end: number }>({
    sid: null,
    end: 0,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scroll` is the engine handle (useConversationScroll's result, stable per biome.json) passed through this hook, not a varying input
  useEffect(() => {
    const end = recordStart + record.length;
    const prev = lastEndRef.current;
    lastEndRef.current = { sid: sessionId, end };
    if (prev.sid !== sessionId) return; // new session — baseline only
    if (end > prev.end) scroll.noteNewBelow();
  }, [record, recordStart, sessionId]);

  // Presence-managed chip: the entrance transition arms one frame after
  // mount, and hiding (click, manual scroll-back, re-pin) plays the reverse
  // slide-fade before the unmount (user 2026-07-11 — it used to vanish with
  // no motion). 240ms exit ≥ the CSS's 200ms transition.
  return usePresence(!scroll.pinnedState && scroll.newBelow, 240);
}
