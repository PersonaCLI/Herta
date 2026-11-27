/**
 * What the composer takes in (ADR 0033, ADR 0048 §4): the file picker, a
 * drop, a pasted picture. Pictures stage in the strip for the message they
 * belong to; documents are read at once, one batch at a time. Split out of
 * Composer.tsx (review 2026-11-10, moved 2026-11-27). The hook holds no
 * effect, so where the composer calls it changes nothing in the order its
 * effects run.
 */
import {
  type ClipboardEvent,
  type DragEvent,
  type MutableRefObject,
  type RefObject,
  useRef,
  useState,
} from "react";
import type { useT } from "../../i18n/LocaleProvider.js";
import type { HertaBridge } from "../../ipc/bridge-types.js";
import type { SessionStore } from "../../store/session-store.js";
import { endPendingAttach, startPendingAttach } from "./pending-attach.js";
import type { StagedImagesState } from "./useStagedImages.js";

/** Filename extension for a pasted image whose File carries no name. The
 *  MIME subtype is the only thing the clipboard tells us. */
function pasteName(mime: string): string {
  const sub = mime.split("/")[1] ?? "png";
  return `image.${sub === "jpeg" ? "jpg" : sub.replace(/[^a-z0-9]/gi, "")}`;
}

export interface AttachmentIntakeDeps {
  readonly bridge: HertaBridge;
  readonly sessionStore: SessionStore;
  readonly sessionId: string | null;
  readonly t: ReturnType<typeof useT>;
  /** The composer's staged pictures: a batch's pictures go there. */
  readonly images: StagedImagesState;
  /** The refusal about a turn in progress, which goes when the turn does. */
  readonly refuseForTurn: () => void;
  readonly busy: boolean;
  /** The caret goes back to the input after a pick or a drop. */
  readonly taRef: RefObject<HTMLTextAreaElement>;
  readonly setFocusWithin: (engaged: boolean) => void;
}

export interface AttachmentIntake {
  /** The OS file picker is up: the composer's height holds still. */
  readonly pickerOpen: MutableRefObject<boolean>;
  /** A document read is in flight: a send waits for it. */
  readonly reading: MutableRefObject<boolean>;
  readonly readingDoc: boolean;
  readonly showReadingNotice: (text: string) => void;
  /** A file is being dragged over the composer. */
  readonly dragOver: boolean;
  readonly onPickAttachments: () => void;
  readonly onPaste: (e: ClipboardEvent<HTMLFormElement>) => void;
  readonly onDragEnter: (e: DragEvent<HTMLFormElement>) => void;
  readonly onDragOver: (e: DragEvent<HTMLFormElement>) => void;
  readonly onDragLeave: () => void;
  readonly onDrop: (e: DragEvent<HTMLFormElement>) => void;
}

export function useAttachmentIntake(
  deps: AttachmentIntakeDeps,
): AttachmentIntake {
  const {
    bridge,
    sessionStore,
    sessionId,
    t,
    images,
    refuseForTurn,
    busy,
    taRef,
    setFocusWithin,
  } = deps;
  // While the OS file picker is up it steals WINDOW focus, firing
  // focusout/focusin churn that says nothing about the user's intent —
  // freeze the height until the picker resolves (then the caret handoff
  // below decides).
  const pickerOpen = useRef(false);

  // A document's record block arrives only when main has read it — and, for
  // a PDF, transcribed its pictures (2026-09-30): seconds. The read in flight
  // shows as the files' own rows with a hairline (2026-10-01, the owner's
  // pick; pending-attach.ts), which replaced a "reading the file" notice here.
  // While a read is in flight a second batch is refused rather than queued,
  // and the SEND waits: `attachFiles` is idle-only, so a turn started
  // meanwhile makes main refuse the whole attach once it has read it,
  // transcripts already paid for (review on #6). The refusal notices are
  // remembered like `turnNotice`, so the answer clears its own notice and
  // never a newer one.
  const reading = useRef(false);
  const [readingDoc, setReadingDoc] = useState(false);
  const readingNotice = useRef<string | null>(null);
  const showReadingNotice = (text: string): void => {
    readingNotice.current = text;
    sessionStore.setComposerNotice(text);
  };
  const clearReadingNotice = (): void => {
    const shown = readingNotice.current;
    readingNotice.current = null;
    if (shown !== null && sessionStore.getSnapshot().composerNotice === shown) {
      sessionStore.clearComposerNotice();
    }
  };

  // ── Attachments (ADR 0033) ────────────────────────────────────────────────
  // `dragDepth` counts enter/leave rather than using a boolean: dragging over a
  // child element fires leave-then-enter, and a boolean flickers the highlight
  // off on every internal boundary crossing.
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);

  /**
   * A picked or dropped batch splits by KIND (ADR 0048 §4): pictures stage in
   * the strip and wait for the message they belong to; documents ingest
   * immediately, as they always have — their extraction takes seconds and the
   * early row is what tells the user the file is ready to ask about.
   *
   * Main decides which is which, by sniffing the bytes: the renderer holds
   * only a path and an extension, and an extension is the user's claim, not
   * the file's content.
   */
  const sendAttachments = (paths: readonly string[]): void => {
    if (paths.length === 0 || sessionId === null) return;
    void images.stagePaths(paths).then(({ notImages }) => {
      if (notImages.length > 0) ingestDocuments(paths, notImages);
    });
  };

  const ingestDocuments = (
    paths: readonly string[],
    notImages: readonly string[],
  ): void => {
    if (sessionId === null) return;
    // Match back to the ORIGINAL paths: main answers with display names, and
    // attachFiles needs the paths it was given.
    const names = new Set(notImages);
    const docs = paths.filter((p) => names.has(p.split(/[\\/]/).at(-1) ?? p));
    if (docs.length === 0) return;
    if (reading.current) {
      showReadingNotice(t("composer.attach.stillReading"));
      return;
    }
    reading.current = true;
    setReadingDoc(true);
    // The read shows as the files' own rows, with a hairline (2026-10-01,
    // pending-attach.ts) — placed where the record blocks will land.
    const snap = sessionStore.getSnapshot();
    const pendingId = startPendingAttach({
      sessionId,
      names: docs.map((p) => p.split(/[\\/]/).at(-1) ?? p),
      baseAbs: snap.recordStart + snap.record.length,
    });
    void bridge
      .attachFiles(sessionId, docs)
      .then((r) => {
        endPendingAttach(pendingId, r.ok);
        clearReadingNotice();
        // Refusals are SHOWN. `attachFiles` is idle-only, and a drop that
        // silently did nothing mid-turn would read as a broken drop target
        // (the same no-op-silently failure the M6 audit found on setWorkspace).
        if (!r.ok) {
          if (r.message === "a turn is in progress") {
            refuseForTurn();
            return;
          }
          sessionStore.setComposerNotice(
            r.message === "too many files at once"
              ? t("composer.attach.tooMany")
              : t("composer.attach.failed"),
          );
        }
      })
      // A rejected IPC call (handler threw) must land in the same notice, not
      // as an unhandled rejection with a drop that looked like it worked.
      .catch(() => {
        endPendingAttach(pendingId, false);
        clearReadingNotice();
        sessionStore.setComposerNotice(t("composer.attach.failed"));
      })
      .finally(() => {
        reading.current = false;
        setReadingDoc(false);
      });
  };

  const onPickAttachments = (): void => {
    // One picker at a time: a second Ctrl+U before the dialog was up opened
    // another (release review 2026-10-22).
    if (pickerOpen.current) return;
    pickerOpen.current = true;
    void bridge
      .pickAttachments()
      .then((paths) => {
        if (paths !== null) sendAttachments(paths);
      })
      .finally(() => {
        pickerOpen.current = false;
        // Caret handoff: whether the user picked files or cancelled, the
        // next act is typing — put the caret in the field. Any expansion the
        // dialog's close causes is then explained by a visible caret (the
        // owner's report: cancel re-expanded the composer with focus stuck
        // on the attach button and no caret anywhere). Explicit set beside
        // focus(), same rationale as the turn-end refocus.
        taRef.current?.focus({ preventScroll: true });
        setFocusWithin(true);
      });
  };

  const onPaste = (e: ClipboardEvent<HTMLFormElement>): void => {
    // A screenshot is Ctrl+V, not a file picker (ADR 0048 §4) — clipboard
    // bytes with no path at all, which is why staging takes bytes as a
    // first-class input rather than only paths.
    const files = Array.from(e.clipboardData.files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (files.length === 0) return; // ordinary text paste: leave it alone
    e.preventDefault();
    if (busy) {
      refuseForTurn();
      return;
    }
    void Promise.all(
      files.map(async (f) => ({
        // A pasted screenshot's File carries a generic name ("image.png")
        // or none; the fallback keeps the record row readable.
        name: f.name.length > 0 ? f.name : `pasted-${pasteName(f.type)}`,
        bytes: new Uint8Array(await f.arrayBuffer()),
      })),
    ).then((items) => images.stageBytes(items));
  };
  const onDragEnter = (e: DragEvent<HTMLFormElement>): void => {
    if (!e.dataTransfer.types.includes("Files")) return;
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragOver = (e: DragEvent<HTMLFormElement>): void => {
    // Without preventDefault the browser navigates to the dropped file and
    // the drop handler never runs — the classic silent-nothing-happens.
    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
  };
  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e: DragEvent<HTMLFormElement>): void => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    // Electron 43 removed File.path; only the preload can resolve a real
    // path (webUtils), so the File objects never leave this handler.
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => bridge.pathForFile(f))
      .filter((p) => p.length > 0);
    sendAttachments(paths);
    // Same caret handoff as the picker: after a drop you type the
    // message that goes with the files. Busy drops surface a refusal
    // notice instead — a disabled textarea can't take the caret.
    if (!busy) {
      taRef.current?.focus({ preventScroll: true });
      setFocusWithin(true);
    }
  };
  return {
    pickerOpen,
    reading,
    readingDoc,
    showReadingNotice,
    dragOver,
    onPickAttachments,
    onPaste,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
  };
}
