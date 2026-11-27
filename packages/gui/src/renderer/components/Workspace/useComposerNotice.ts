/**
 * The composer's notice pill (the rewind's file-edit spill, the attach
 * refusals): the store holds the notice, and the pill stays mounted through
 * its slide-out. Split out of Composer.tsx (review 2026-11-10, moved
 * 2026-11-27): the composer calls the hook where its two effects were, so
 * they run in the same place among the composer's own.
 */
import { useEffect, useRef, useState } from "react";

/** How long the rewind notice's slide-out runs before it unmounts. Must match
 *  the `.composer-notice.is-exiting` animation duration in reference-ux.css. */
const NOTICE_EXIT_MS = 240;

/** The notice to draw, and whether it is sliding out. */
export function useComposerNotice(composerNotice: string | null): {
  readonly noticeText: string | null;
  readonly noticeExiting: boolean;
} {
  // The rewind file-edit notice is animated in AND out. composerNotice (store) is
  // the source; `noticeText` is the locally-held copy that stays mounted through
  // the slide-out (React would otherwise unmount it instantly, skipping the exit).
  const [noticeText, setNoticeText] = useState<string | null>(null);
  const [noticeExiting, setNoticeExiting] = useState(false);
  const noticeShown = useRef(false);
  const noticeTimer = useRef<number | null>(null);

  // Drive the notice's enter/exit. On show: mount with the in-animation, cancel
  // any pending unmount. On clear: play the out-animation, then unmount after it
  // finishes. `noticeShown`/`noticeTimer` are refs so this keys only on the store
  // value (the setters/refs are stable, so deps stay exhaustive).
  useEffect(() => {
    if (composerNotice !== null) {
      if (noticeTimer.current !== null) {
        window.clearTimeout(noticeTimer.current);
        noticeTimer.current = null;
      }
      setNoticeText(composerNotice);
      setNoticeExiting(false);
      noticeShown.current = true;
    } else if (noticeShown.current) {
      setNoticeExiting(true);
      noticeTimer.current = window.setTimeout(() => {
        setNoticeText(null);
        setNoticeExiting(false);
        noticeShown.current = false;
        noticeTimer.current = null;
      }, NOTICE_EXIT_MS);
    }
  }, [composerNotice]);

  // Clear the pending unmount timer if the Composer itself unmounts mid-exit.
  useEffect(
    () => () => {
      if (noticeTimer.current !== null)
        window.clearTimeout(noticeTimer.current);
    },
    [],
  );
  return { noticeText, noticeExiting };
}
