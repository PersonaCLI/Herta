// The outgoing send morph — one of the five state machines Conversation.tsx
// hosted; extracted on 2026-09-03 at the owner's request. On the pendingUser
// null→value edge a clone of the just-sent bubble flies from the composer to
// its resting slot in the flow (the flow bubble stays hidden until the landing
// hold ends), and the optimistic echo's own props — its pictures as bubble
// views, its send stamp — are derived here because the clone carries them.
// State: `outgoingClone`, `hidePendingUser`. Effects, in order: the detection
// LAYOUT effect (the edge) and the flight effect (keyed on the clone
// mounting) — the first two effects Conversation declares, as before.

import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { StagedImageInfo } from "../../ipc/bridge-types.js";
import {
  GLASS_MS,
  OUTGOING_FLIGHT_MS,
  SHADOW_SETTLE_MS,
} from "./conversation-timing.js";
import type { UserImageView } from "./UserBubble.js";
import {
  E_OUT_CUBIC,
  easeOutCubic,
  useRiseAnimation,
} from "./useRiseAnimation.js";

export interface OutgoingClone {
  readonly text: string;
  readonly images: readonly UserImageView[];
  /** The hidden pending row's strip width, so the clone's strip wraps
   *  EXACTLY like the one it will swap for — a max-content clone laid
   *  three pictures in one oversized line while the landed row wrapped
   *  them into two (seen live 2026-08-27). */
  readonly imagesWidthPx?: number;
}

export function useOutgoingMorph(opts: {
  readonly pendingUser: string | null;
  readonly pendingUserImages: readonly StagedImageInfo[] | null;
  readonly reduced: boolean;
  readonly composerRef: RefObject<HTMLFormElement>;
  readonly overlayRef: RefObject<HTMLDivElement>;
  /** The `.conversation-flow` column — the flight watches its WIDTH. */
  readonly flowRef: RefObject<HTMLDivElement>;
  /** The scroll engine's `isReadingHistory`, as a getter: the engine is
   *  created AFTER this hook (it takes the clone flag this hook owns), so
   *  the predicate is read at effect time — exactly what the inline effect
   *  did through the `scroll` const declared below it. */
  readonly isReadingHistory: () => boolean;
}) {
  const {
    pendingUser,
    pendingUserImages,
    reduced,
    composerRef,
    overlayRef,
    flowRef,
    isReadingHistory,
  } = opts;

  // The optimistic echo's pictures as bubble views (ADR 0048 §4). No caption
  // yet — it is being computed main-side; the record row carries it. The
  // sniffed dimensions ride along so the echo reserves the real box before
  // the thumbnails load (the morph measures this slot).
  const pendingEchoImages = useMemo<readonly UserImageView[]>(
    () =>
      (pendingUserImages ?? []).map((s) => ({
        path: s.path,
        name: s.name,
        ...(s.width !== undefined ? { width: s.width } : {}),
        ...(s.height !== undefined ? { height: s.height } : {}),
      })),
    [pendingUserImages],
  );

  // Outgoing send morph: on the pendingUser null→value edge, mount a flying
  // clone in the workspace overlay and rise it from the composer to its
  // resting slot (crisp left/top). The flow bubble stays hidden until settle.
  const outgoingRise = useRiseAnimation();
  const cloneRef = useRef<HTMLDivElement>(null);
  const pendingUserBubbleRef = useRef<HTMLDivElement>(null);
  const [outgoingClone, setOutgoingClone] = useState<OutgoingClone | null>(
    null,
  );
  const [hidePendingUser, setHidePendingUser] = useState(false);
  const prevPendingUser = useRef<string | null>(null);
  /** Whether THIS send will actually fly a clone (set by the detection layout
   *  effect below, read by the send effect in the same commit). The sequenced
   *  travel is handed to the flight's settle, so a send with no flight has to
   *  keep travelling immediately or the reserved room never comes on screen. */
  const outgoingFlightArmedRef = useRef(false);
  /** The landing hold (SHADOW_SETTLE_MS): swap deferred while the parked
   *  clone's flight shadows fade. Cleared by every teardown path so a stale
   *  timer can't unhide a bubble a NEW flight just hid. */
  const outgoingSettleTimer = useRef<number | null>(null);

  // Detection: on the pendingUser null→value edge, mount the flying clone +
  // hide the flow bubble. Geometry/animation happens in the effect below,
  // AFTER the clone has committed (so cloneRef is attached).
  // LAYOUT effect, deliberately: a passive useEffect runs after the browser
  // paints, so the flow bubble got one painted frame at its final position
  // before the hide flag landed — a visible flash, then the rise replayed
  // from the composer (seen live 2026-06-13). Setting the flag before paint
  // means the bubble is never painted until the morph settles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on the pendingUser null→value edge
  useLayoutEffect(() => {
    const appeared = prevPendingUser.current === null && pendingUser !== null;
    prevPendingUser.current = pendingUser;
    if (pendingUser === null) {
      outgoingRise.cancel();
      if (outgoingSettleTimer.current !== null) {
        window.clearTimeout(outgoingSettleTimer.current);
        outgoingSettleTimer.current = null;
      }
      setOutgoingClone(null);
      setHidePendingUser(false);
      composerRef.current?.classList.remove("is-glass");
      return;
    }
    if (!appeared) return;
    // A fresh send while a previous landing hold is still fading: the stale
    // timer must not unhide the bubble this flight is about to fly for.
    if (outgoingSettleTimer.current !== null) {
      window.clearTimeout(outgoingSettleTimer.current);
      outgoingSettleTimer.current = null;
    }
    if (
      overlayRef.current === null ||
      composerRef.current === null ||
      reduced ||
      // Reading history: the send no longer yanks the pane (see the send
      // effect), so this clone's destination — the flow bubble's slot — is
      // below the fold. Flying to it would launch the bubble off the bottom
      // edge of a view the reader never asked to leave. Let the bubble land
      // in the flow unseen, exactly like the reduced-motion path.
      //
      // A DISCLOSURE unpin does not count as reading history, and must be
      // tested the same way here as in the send effect below — the two
      // decisions have to agree or the send hands its travel to a flight that
      // was never armed. Expanding a detail pane and then sending lost the
      // animation entirely until this matched (owner 2026-08-10).
      isReadingHistory()
    ) {
      // No overlay/composer or reduced motion → the flow bubble shows directly,
      // and nothing will fly. Recorded because the send effect below decides
      // whether to hand its travel to a flight that may not exist, and this
      // layout effect runs FIRST in the same commit, so the answer is current.
      outgoingFlightArmedRef.current = false;
      return;
    }
    outgoingFlightArmedRef.current = true;
    setHidePendingUser(true);
    // The clone carries the message's pictures too (set in the same store
    // emit as pendingUser, so this commit sees them): the strip's images
    // lift off with the bubble instead of popping in at the landing. The
    // hidden pending row is already in the DOM (this is a layout effect),
    // so its strip's width can be measured for the clone to reproduce.
    const rowStrip =
      pendingUserBubbleRef.current?.parentElement?.querySelector(
        ".message-images",
      );
    const imagesWidth = rowStrip?.getBoundingClientRect().width;
    setOutgoingClone({
      text: pendingUser,
      images: pendingEchoImages,
      ...(imagesWidth !== undefined && imagesWidth > 0
        ? { imagesWidthPx: imagesWidth }
        : {}),
    });
  }, [pendingUser, reduced]);

  // Animate once the clone has mounted (cloneRef attaches only after the portal
  // commits — measuring in the detection effect via rAF raced the commit and
  // left the clone unpositioned at the overlay's top-left). FLIP-style: measure
  // the real flow bubble's slot (held in layout via visibility:hidden) and rise
  // the clone to exactly that rect so it lands where the bubble actually goes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the clone mounting
  useEffect(() => {
    if (outgoingClone === null) return;
    const el = cloneRef.current;
    const composer = composerRef.current;
    const overlay = overlayRef.current;
    const slot = pendingUserBubbleRef.current;
    if (el === null || composer === null || overlay === null || slot === null)
      return;
    const ws = overlay.getBoundingClientRect();
    const comp = composer.getBoundingClientRect();
    const dest = slot.getBoundingClientRect();
    // Diagonal lift: start at the composer's left (the input), settle at the
    // flow bubble's actual slot (right-aligned, wherever it lands in the flow).
    const startLeft = comp.left + 20 - ws.left;
    const startTop = comp.top - ws.top + 6;
    const targetLeft = dest.left - ws.left;
    // `dest` is where the slot IS, and that is where the clone lands (2026-07-30).
    // It used to subtract the scroll still owed by an in-flight send glide,
    // because the page climbed into the reserved room WHILE the bubble crossed
    // it — the clone had to aim at where the slot would end up. The two are
    // sequenced now: the send parks at the bottom of the real content and the
    // climb waits for this flight's settle, so nothing is owed and the slot
    // cannot move underneath it.
    const targetTop = dest.top - ws.top;
    el.style.left = `${Math.round(startLeft)}px`;
    el.style.top = `${Math.round(startTop)}px`;
    el.classList.add("is-visible");
    composer.classList.add("is-glass");
    const glassTimer = window.setTimeout(() => {
      composer.classList.remove("is-glass");
    }, GLASS_MS);
    outgoingRise.start({
      el,
      from: { left: startLeft, top: startTop },
      to: { left: targetLeft, top: targetTop },
      durationMs: OUTGOING_FLIGHT_MS,
      easing: easeOutCubic,
      // Runs the flight on the COMPOSITOR (see useRiseAnimation): this rise
      // overlaps the heaviest main-thread moment in the app — the committed
      // turn's style/layout/paint plus, on a full page, the headroom glide —
      // and on a slow machine it used to freeze with it.
      cssEasing: E_OUT_CUBIC,
      // A sidebar toggle or the rail gutter easing in mid-flight moves the
      // slot with no window resize — settle early on a flow WIDTH change
      // (deferred-fix 2026-07-31).
      ...(flowRef.current !== null ? { watchWidthOf: flowRef.current } : {}),
      onSettle: () => {
        composer.classList.remove("is-glass");
        // Landing hold: the clone is parked exactly on the slot; keep it
        // there while `.is-settled` fades its flight shadows (the float
        // ::after, and — user variant — the rest shadow, since the real
        // user bubble carries none), THEN swap. Unmounting on this commit
        // popped the shadows off with no transition (owner 2026-08-27).
        outgoingSettleTimer.current = window.setTimeout(() => {
          outgoingSettleTimer.current = null;
          setHidePendingUser(false);
          setOutgoingClone(null);
        }, SHADOW_SETTLE_MS);
      },
    });
    return () => window.clearTimeout(glassTimer);
  }, [outgoingClone]);

  // The optimistic echo's send time, stamped once per pending message: a
  // fresh ISO string per render would change the bubble's `at` prop on every
  // reveal frame and defeat its memo. `pendingUser` always passes through
  // null between sends, so the memo cannot serve a stale stamp to a repeat
  // of the same text.
  const pendingUserAt = useMemo(
    () => (pendingUser === null ? undefined : new Date().toISOString()),
    [pendingUser],
  );

  /** Whether the send in this commit will fly a clone (the detection layout
   *  effect's verdict) — read by the send's follow in the same commit. */
  const isFlightArmed = useCallback(
    (): boolean => outgoingFlightArmedRef.current,
    [],
  );

  return {
    pendingEchoImages,
    pendingUserAt,
    outgoingClone,
    hidePendingUser,
    cloneRef,
    pendingUserBubbleRef,
    isFlightArmed,
  };
}
