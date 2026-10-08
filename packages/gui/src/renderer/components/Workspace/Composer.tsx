import { workspaceRelativeRepoPath } from "@herta/core/repo-path";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { attachmentImageUrl } from "../../../shared/attachment-image.js";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useSessionLang } from "../../hooks/useActiveSession.js";
import {
  shallowEqualObjects,
  useSessionSelector,
} from "../../hooks/useSessionSelector.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { aliasBrickInput } from "../../lib/banzhuan-mention.js";
import { renderBanzhuanText } from "../../lib/banzhuan-text.js";
import {
  brickComplete,
  findMentionQuery,
  insertBrick,
  insertMention,
  type MentionItem,
  mentionItems,
} from "../../lib/file-mention.js";
import { recallLastMessage } from "../../lib/recall-last-message.js";
import { submitMessage } from "../../lib/submit-message.js";
import { stopAllVoice } from "../../voice/play-voice.js";
import { Tooltip } from "../Tooltip/Tooltip.js";
import { AuraVisual } from "../UtilityRail/AuraVisual.js";
import { useLightbox } from "./ImageLightbox.js";
import { endPendingAttach, startPendingAttach } from "./pending-attach.js";
import { SendArrowIcon } from "./SendArrowIcon.js";
import { useStagedImages } from "./useStagedImages.js";
import { useWorkspaceRefs } from "./WorkspaceRefs.js";

/** Whether the ghost hint should show: caret is at the END of `value`, the
 *  char before it is `@`, that `@` is at the start or preceded by whitespace
 *  (a boundary), and it was not Esc-dismissed. */
function shouldHint(
  value: string,
  caret: number | null,
  escIdx: number,
): boolean {
  if (caret === null || caret !== value.length) return false;
  const at = caret - 1;
  if (at < 0 || value[at] !== "@") return false;
  if (at !== 0 && !/\s/.test(value[at - 1] ?? "")) return false;
  if (escIdx === at) return false;
  return true;
}

/**
 * Whether the composer may take the caret without taking it FROM anything
 * (UX review 2026-09-22, items 12-13): focus is nowhere (a disabled textarea
 * drops it silently), already in the composer, or on the approval panel of a
 * gate that has just been answered and is leaving. Focus anywhere else —
 * Settings' key field, the sidebar search, the file viewer — belongs to what
 * the user is doing there.
 */
function caretIsFree(form: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (
    active === null ||
    active === document.body ||
    active === document.documentElement
  ) {
    return true;
  }
  if (form?.contains(active)) return true;
  return active.closest(".approval-panel") !== null;
}

/** How long the rewind notice's slide-out runs before it unmounts. Must match
 *  the `.composer-notice.is-exiting` animation duration in reference-ux.css. */
const NOTICE_EXIT_MS = 240;

/** How long the workspace's file list is reused before `@` lists it again
 *  (ADR 0072 §2) — a file 板砖 just created shows up on the next mention. */
const MENTION_FILES_TTL_MS = 10_000;

/** Filename extension for a pasted image whose File carries no name. The
 *  MIME subtype is the only thing the clipboard tells us. */
function pasteName(mime: string): string {
  const sub = mime.split("/")[1] ?? "png";
  return `image.${sub === "jpeg" ? "jpg" : sub.replace(/[^a-z0-9]/gi, "")}`;
}

export function Composer(): JSX.Element {
  const t = useT();
  const { bridge, sessionStore } = useHertaBridge();
  const { composerRef, sendButtonRef } = useWorkspaceRefs();
  // Selector-based: the composer needs a handful of cold fields; the whole-
  // snapshot subscription re-rendered it (and its highlight overlay) per delta.
  const {
    status,
    overlay,
    sessionId,
    composerDraft,
    composerDraftImages,
    composerNotice,
    rewindUndo,
    backendActive,
    held,
    resumable,
    restagedImages,
  } = useSessionSelector(
    (s) => ({
      status: s.status,
      overlay: s.overlay,
      sessionId: s.sessionId,
      composerDraft: s.composerDraft,
      composerDraftImages: s.composerDraftImages,
      composerNotice: s.composerNotice,
      rewindUndo: s.rewindUndo,
      backendActive: s.backendActive,
      held: s.held,
      resumable: s.resumable,
      restagedImages: s.restagedImages,
    }),
    shallowEqualObjects,
  );
  // The conversation's language drives the 板砖→Brick surface alias: in an EN
  // session the ghost/insert use "brick" and a typed "@brick" is translated to
  // the wire token "@板砖" before dispatch.
  const lang = useSessionLang();
  const [text, setText] = useState("");
  // Focus-keyed height (owner 2026-08-20, superseding shrink-after-send):
  // the composer RESTS shrunk and holds full height only while it is
  // engaged. The two sides are deliberately ASYMMETRIC:
  //   - EXPAND only when the TEXTAREA gains focus (the caret is the
  //     expansion) — focus landing on the attach/send button from outside
  //     must NOT expand, or clicking attach in the resting state bounced
  //     the composer up and back down around the native file dialog
  //     (owner screenshots, same day).
  //   - HOLD while focus stays anywhere inside the FORM: clicking attach
  //     from the textarea blurs it while the pointer is still inside the
  //     composer, and shrinking there would move the button 18px under the
  //     cursor mid-click. Only a blur that leaves the form shrinks.
  // The disable-blur at turn start shrinks (set on the busy edge below —
  // Chrome fires no blur for it); an unsent draft keeps its first line
  // visible and survives; the turn-end auto-refocus expands again.
  const [focusWithin, setFocusWithin] = useState(false);
  // While the OS file picker is up it steals WINDOW focus, firing
  // focusout/focusin churn that says nothing about the user's intent —
  // freeze the height until the picker resolves (then the caret handoff
  // below decides).
  const pickerOpen = useRef(false);
  // Set around a focus() that gives the caret back WITHOUT the expansion
  // (the hold window opening, below): the textarea's onFocus skips the
  // expand while it is set, and the first keystroke expands instead.
  const quietFocus = useRef(false);
  const [hintActive, setHintActive] = useState(false);
  // The index of an `@` whose hint the user dismissed with Esc; re-enabled
  // once the text changes. -1 means "none dismissed".
  const escDismissed = useRef(-1);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // After a Tab insertion we must restore the caret AFTER the inserted 板砖,
  // applied post-render via this ref (React owns the controlled value).
  const pendingCaret = useRef<number | null>(null);
  // @-file mentions (ADR 0072 §2): the `@query` the caret is in, the
  // workspace's files (listed by main, kept briefly per session), the
  // highlighted match, and the `@` whose list the user dismissed with Esc
  // (it stays dismissed while the caret stays in that mention).
  const [mention, setMention] = useState<{
    readonly start: number;
    readonly query: string;
  } | null>(null);
  const [mentionFiles, setMentionFiles] = useState<readonly string[] | null>(
    null,
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionKey = useRef("");
  const mentionDismissed = useRef(-1);
  const mentionCache = useRef<{
    readonly sessionId: string;
    readonly at: number;
  } | null>(null);
  const busy = status !== "idle";
  const suppressed = overlay?.kind === "pending-permission";
  // A message while 板砖 works (ADR 0063). The hold exists ONLY while the
  // coprocessor runs — the one phase with a sampling boundary a steer can
  // reach (owner 2026-09-14: a conversation with Herta has no such
  // mechanism). Then the textarea stays enabled, Enter holds the text above
  // the composer instead of interrupting, and the button stays Stop. The
  // held text goes as the next turn when this one ends, unless the user
  // interjects it (`steerText`) or takes it back. Herta's own speech keeps
  // the composer as it was: disabled, with Stop.
  const holding = busy && backendActive && !suppressed;
  const canSteer = holding && bridge.steerText !== undefined;
  // The turn-end delivery reads the latest held text and language from
  // refs: the effect is keyed on the busy edge, not on either.
  const heldRef = useRef<string | null>(null);
  heldRef.current = held;
  /** The user pressed Stop in this turn: a held message does not go. */
  const stopRequested = useRef(false);
  /** The held card's DOM node — the flying clone lifts off from its rect. */
  const heldCardRef = useRef<HTMLElement>(null);
  const langRef = useRef(lang);
  langRef.current = lang;

  // "The current turn is still in progress" is a refusal ABOUT the turn: it
  // goes when the turn does. It shares the notice lane with the rewind's
  // file-edit spill, which persists until the next send — and so did this
  // one, long after the turn it described had ended (UX review 2026-09-22,
  // item 14). The text set is remembered so the turn's end clears exactly
  // that notice and never a newer one.
  const turnNotice = useRef<string | null>(null);
  const refuseForTurn = useCallback((): void => {
    const text = t("composer.attach.busy");
    turnNotice.current = text;
    sessionStore.setComposerNotice(text);
  }, [sessionStore, t]);

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

  // Staged pictures (ADR 0048 §4). Refusals go through the same notice lane
  // every other composer refusal uses.
  const onStageRefusal = useCallback(
    (reason: string) => {
      if (reason === "a turn is in progress") {
        refuseForTurn();
        return;
      }
      sessionStore.setComposerNotice(
        reason === "too many files at once"
          ? t("composer.attach.tooMany")
          : reason === "five images per message"
            ? t("composer.attach.imageLimit")
            : reason === "denied"
              ? t("composer.attach.denied")
              : t("composer.attach.failed"),
      );
    },
    [sessionStore, t, refuseForTurn],
  );
  const images = useStagedImages(sessionId, onStageRefusal);
  const openLightbox = useLightbox();

  // Shared submit path for the ↑ button (form submit) and Enter-to-send.
  const doSubmit = (): void => {
    if (busy) {
      // While 板砖 works the words are HELD, not sent (ADR 0063). Raw text:
      // the @brick alias is applied when the hold is delivered or steered,
      // so an edit puts back exactly what was typed.
      if (!holding) return;
      const pending = text.trim();
      if (pending.length === 0) return;
      sessionStore.holdMessage(pending);
      setText("");
      setHintActive(false);
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      // Pictures need words (owner 2026-08-27, reversing the first cut): an
      // empty user block is a degenerate moment in the record — （用户 说）
      // with nothing said, which the narrative actor then completes against.
      // Enter with staged pictures says WHY nothing was sent instead of
      // silently doing nothing; plain empty Enter stays a quiet no-op, as
      // it always was.
      if (images.staged.length > 0) {
        sessionStore.setComposerNotice(t("composer.attach.needText"));
      }
      return;
    }
    if (reading.current) {
      // See `reading`: a turn started now would cost the attach in flight.
      // The words stay in the field for when the read is done.
      showReadingNotice(t("composer.attach.waitToSend"));
      return;
    }
    // EN surface alias: translate a typed "@brick" (any case) back to the wire
    // trigger "@板砖" BEFORE it enters the record/dispatch — code spans exempt
    // (a backticked `@brick` is quotation). See aliasBrickInput, kept in
    // lockstep with the CLI's converter of the same name.
    const dispatched = aliasBrickInput(trimmed, lang);
    // Take the staged pictures BEFORE dispatching: they ride this message,
    // and the strip must empty on the same frame the text does (ADR 0048 §4).
    const staged = images.take();
    // Optimistic echo + dispatch. With no DeepSeek key set, the backend
    // reports needsKey and submitMessage opens the no-key onboarding card.
    submitMessage(
      bridge,
      sessionStore,
      dispatched,
      staged.length > 0 ? staged : undefined,
    );
    setText("");
    // The rewind file-edit notice persists through editing; clear it once the
    // (re-)send actually goes out (a session switch clears it via onReset).
    if (composerNotice !== null) sessionStore.clearComposerNotice();
  };

  // Refocus the input when a turn ends: `disabled={busy}` blurs it at turn
  // start, and without this every exchange needed a click before typing.
  // Skipped while an approval gate suppresses the composer (the panel owns
  // focus then) — the gate's `resolved` flips status later anyway.
  const prevBusy = useRef(false);
  useEffect(() => {
    const was = prevBusy.current;
    prevBusy.current = busy;
    if (!was && busy) {
      // Turn start disables the textarea, which SILENTLY drops focus —
      // Chrome moves activeElement off a disabled element without firing
      // blur/focusout (verified live 2026-08-20), so the form handler never
      // learns focus left. Clear the state here: the composer is shrunk for
      // the whole reply, which is the reading-room the shrink exists for.
      setFocusWithin(false);
      stopRequested.current = false;
    }
    if (was && !busy) {
      // A refusal about the turn goes with it — only if it is still the
      // notice showing (a newer one is not this effect's to clear).
      const refusal = turnNotice.current;
      turnNotice.current = null;
      if (
        refusal !== null &&
        sessionStore.getSnapshot().composerNotice === refusal
      ) {
        sessionStore.clearComposerNotice();
      }
      // The held message goes as the next turn the moment this one ends
      // (ADR 0063 — Codex's "do nothing"): through the ordinary submit path,
      // so the optimistic echo, the no-key card and the withdraw-on-refusal
      // all apply to it exactly as to a typed send.
      //
      // Only when the turn FINISHED (ADR 0063 §1.9, owner 2026-09-23). After
      // Stop the user has just said "not now"; after a failure (a 402, a
      // rejected key, a dropped connection) the held text would be sent
      // straight into the same failure, and the new turn's start wiped the
      // notice for the first. Either way the text comes back into the
      // composer, in front of anything typed since — nothing sent, nothing
      // lost.
      const pending = heldRef.current;
      const stopped = stopRequested.current;
      stopRequested.current = false;
      if (
        pending !== null &&
        (stopped || sessionStore.getSnapshot().turnFailed)
      ) {
        sessionStore.clearHeld();
        setText((prev) =>
          prev.trim().length > 0 ? `${pending}\n\n${prev}` : pending,
        );
        pendingCaret.current = pending.length;
      } else if (pending !== null) {
        // The clone lifts off from the card, not the input: measure it
        // BEFORE the clear unmounts it.
        const rect = heldCardRef.current?.getBoundingClientRect();
        const launch =
          rect !== undefined
            ? { left: rect.left + 16, top: rect.top }
            : undefined;
        sessionStore.clearHeld();
        submitMessage(
          bridge,
          sessionStore,
          aliasBrickInput(pending, langRef.current),
          undefined,
          launch,
        );
      }
    }
    // Only when the caret is free: a turn that ends while the user types a
    // key into Settings or searches the sidebar leaves them there (UX review
    // 2026-09-22, item 12 — the refocus used to be unconditional).
    if (was && !busy && !suppressed && caretIsFree(composerRef.current)) {
      taRef.current?.focus({ preventScroll: true });
      // "Caret back, ready to type" includes the height: expand directly
      // rather than relying on the focus() call's focusin reaching the form
      // handler (browsers deliver it; jsdom does not, and a focus() that
      // fails to take should still leave the composer ready).
      setFocusWithin(true);
    }
  }, [busy, suppressed, bridge, sessionStore, composerRef]);

  // The hold window closing while the turn goes on (板砖 done, Herta
  // speaking) disables the textarea again — silently, like the turn start
  // above — so the engaged height must let go here too.
  //
  // The window OPENING re-enables it — when 板砖 starts, and again when an
  // approval gate is answered — and the caret comes back with it if the
  // caret is free (UX review 2026-09-22, item 13: the disable at turn start
  // and the gate had taken it, and nothing gave it back until the turn
  // ended). QUIETLY: the composer rests shrunk through the reply (owner
  // 2026-08-20), so the caret returns without the expansion; the first
  // keystroke expands it.
  const prevHolding = useRef(false);
  useEffect(() => {
    const was = prevHolding.current;
    prevHolding.current = holding;
    if (was && !holding && busy) setFocusWithin(false);
    if (!was && holding && caretIsFree(composerRef.current)) {
      const ta = taRef.current;
      if (ta !== null && document.activeElement !== ta) {
        quietFocus.current = true;
        try {
          ta.focus({ preventScroll: true });
        } finally {
          quietFocus.current = false;
        }
      }
    }
  }, [holding, busy, composerRef]);

  // The held strip's three answers (ADR 0063).
  const onSteer = (): void => {
    const pending = held;
    const steer = bridge.steerText;
    if (pending === null || steer === undefined) return;
    steer(aliasBrickInput(pending, lang)).then(
      (r) => {
        // Accepted: it is in the record now, on its way to 板砖. Queued (the
        // run ended between the click and the call): it stays held and goes
        // as the next turn.
        if ("accepted" in r) sessionStore.clearHeld();
      },
      () => undefined,
    );
  };
  const onEditHeld = (): void => {
    const pending = held;
    if (pending === null) return;
    sessionStore.clearHeld();
    setText((prev) => (prev.length > 0 ? `${pending}\n\n${prev}` : pending));
    taRef.current?.focus({ preventScroll: true });
    setFocusWithin(true);
  };

  // The rewind file-edit notice is animated in AND out. composerNotice (store) is
  // the source; `noticeText` is the locally-held copy that stays mounted through
  // the slide-out (React would otherwise unmount it instantly, skipping the exit).
  const [noticeText, setNoticeText] = useState<string | null>(null);
  // 撤销改动 pressed (ADR 0074 §4): take the withdrawn turn's edits back and
  // say what happened in the notice's place. The withdrawn turn is out of
  // the record, so this notice is the only place a file left alone shows.
  const undoWithdrawn = async (): Promise<void> => {
    if (sessionStore.getSnapshot().rewindUndo !== "offer") return;
    sessionStore.setRewindUndo("busy");
    const r = await sessionStore.undoTurnEdits("withdrawn");
    // The session changed under the answer: the notice went with it.
    if (r === null) return;
    if (!r.ok) {
      sessionStore.setComposerNotice(t("workspace.undoFailed"));
      return;
    }
    const left = r.files
      .filter(
        (f) =>
          f.result !== "restored" &&
          f.result !== "deleted" &&
          f.result !== "unchanged",
      )
      .map((f) => f.path);
    sessionStore.setComposerNotice(
      left.length === 0
        ? t("workspace.editsUndone")
        : t("workspace.editsUndoneLeftAlone").replace(
            "{files}",
            left.length > 3
              ? `${left.slice(0, 3).join(t("workspace.listJoin"))}${t("workspace.listJoin")}…`
              : left.join(t("workspace.listJoin")),
          ),
    );
  };
  const [noticeExiting, setNoticeExiting] = useState(false);
  const noticeShown = useRef(false);
  const noticeTimer = useRef<number | null>(null);

  // The Composer stays mounted across session changes and the disconnected
  // state, so its local draft would otherwise leak into the next session (type
  // text, delete the session, connect a new one → the old text reappears).
  // Reset whenever the active session changes — a new/other session starts empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on sessionId; the setters/ref are stable
  useEffect(() => {
    setText("");
    setHintActive(false);
    escDismissed.current = -1;
    setMention(null);
    setMentionFiles(null);
    mentionCache.current = null;
    mentionDismissed.current = -1;
  }, [sessionId]);

  // The mention list for the caret's `@query`, from the bare `@` on (owner
  // 2026-10-08: it waited for a query past what could still be `@板砖`, so a
  // bare `@` showed the ghost alone and the files went unnoticed). Not for
  // the token already typed out, nor for a mention the user dismissed. The
  // files are fetched once and kept for a few seconds, so typing does not
  // re-list; where the bridge cannot list them, the list offers `@板砖`
  // alone.
  const updateMention = (value: string, caret: number | null): void => {
    const mq = findMentionQuery(value, caret);
    if (mq === null) mentionDismissed.current = -1;
    if (
      mq === null ||
      mq.start === mentionDismissed.current ||
      brickComplete(mq.query, lang)
    ) {
      mentionKey.current = "";
      setMention(null);
      return;
    }
    // The highlight resets only when the mention itself changes: React
    // re-reports the selection on key-up, and resetting there undid every
    // ArrowDown (live check 2026-09-29).
    const key = `${mq.start}:${mq.query}`;
    if (key !== mentionKey.current) {
      mentionKey.current = key;
      setMentionIndex(0);
    }
    setMention(mq);
    if (bridge.listWorkspaceFiles === undefined || sessionId === null) return;
    const cached = mentionCache.current;
    if (
      cached === null ||
      cached.sessionId !== sessionId ||
      Date.now() - cached.at > MENTION_FILES_TTL_MS
    ) {
      mentionCache.current = { sessionId, at: Date.now() };
      const asked = sessionId;
      void bridge.listWorkspaceFiles(asked).then(
        (r) => {
          if (mentionCache.current?.sessionId !== asked) return;
          setMentionFiles(r?.files ?? []);
        },
        () => setMentionFiles([]),
      );
    }
  };
  // A bare `@` offers the files being worked on first: the repository's
  // uncommitted paths, read from the store when the list is built (the
  // composer does not re-render on every repository probe).
  const mentionMatches = useMemo((): MentionItem[] => {
    if (mention === null) return [];
    const repo = sessionStore.getSnapshot().repo;
    const changed =
      repo === null
        ? []
        : repo.dirty.map((d) => workspaceRelativeRepoPath(d.path, repo.prefix));
    return mentionItems(mention.query, lang, mentionFiles, changed);
  }, [mention, mentionFiles, lang, sessionStore]);
  const mentionOpen = mention !== null && mentionMatches.length > 0;
  const mentionActive = mentionOpen
    ? mentionMatches[mentionIndex % mentionMatches.length]
    : undefined;
  const pickMention = (item: MentionItem): void => {
    if (mention === null) return;
    const caret = taRef.current?.selectionStart ?? text.length;
    const next =
      item.kind === "brick"
        ? insertBrick(
            text,
            mention.start,
            caret,
            lang === "en" ? "brick" : "板砖",
          )
        : insertMention(text, mention.start, caret, item.path);
    pendingCaret.current = next.caret;
    setText(next.text);
    setMention(null);
    setHintActive(false);
    taRef.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (pendingCaret.current !== null && taRef.current) {
      taRef.current.setSelectionRange(
        pendingCaret.current,
        pendingCaret.current,
      );
      pendingCaret.current = null;
    }
  });

  // Adopt a restored draft: a rewound turn — or a submit that failed before
  // any turn lifecycle, or a cancelled no-key card — returns its user text
  // here for editing. Load it into the input, focus + place the caret at the
  // end, then clear the one-shot so it isn't re-applied on the next render.
  // A failed submit's pictures come back too (their staged copies survived —
  // only a successful submit consumes them); a rewind never carries any.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the draft signal; setters/store/ref/restore are stable
  useEffect(() => {
    if (composerDraft === null) return;
    // In FRONT of whatever is being typed, never over it — the same rule the
    // held card's Edit follows. A rewind replaced an unsent draft outright
    // (UX review 2026-09-22, item 15).
    setText((prev) =>
      prev.trim().length > 0 ? `${composerDraft}\n\n${prev}` : composerDraft,
    );
    if (composerDraftImages !== null) images.restore(composerDraftImages);
    setHintActive(false);
    pendingCaret.current = composerDraft.length;
    taRef.current?.focus({ preventScroll: true });
    sessionStore.clearComposerDraft();
  }, [composerDraft]);

  // Adopt the pictures main still holds staged (a window that reloaded with
  // pictures in its strip — UX review 2026-09-22, item 7). Runs after the
  // strip's own session reset in the same commit, so the reset cannot wipe
  // what this puts back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the one-shot; the store and the strip's restore are stable
  useEffect(() => {
    if (restagedImages === null) return;
    images.restore(restagedImages);
    sessionStore.clearRestagedImages();
  }, [restagedImages]);

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

  // ── Attachments (ADR 0033) ────────────────────────────────────────────────
  // `dragDepth` counts enter/leave rather than using a boolean: dragging over a
  // child element fires leave-then-enter, and a boolean flickers the highlight
  // off on every internal boundary crossing.
  const dragDepth = useRef(0);
  const [dragOver, setDragOver] = useState(false);

  // A file drag over the composer also expands it — a drop target should
  // not be at its smallest exactly while the user is aiming at it. Staged
  // pictures also hold it open: the strip is the only sign the pictures are
  // pending, and shrinking would clip it (ADR 0048 §4).
  const hasStaged = images.staged.length > 0;
  const shrunk = !focusWithin && !dragOver && !hasStaged;

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

  return (
    <>
      {/* The notice pill (rewind spill, attach refusals) floats above the
          FOOTER, not the form: anchored to the form's top edge it landed
          exactly on the held card (owner 2026-09-16 — a picture pasted
          while a message waits is refused, and the refusal must not cover
          the message). `bottom: 100%` of the footer is the composer's top
          edge when nothing is held and the card's top edge when it is. */}
      {noticeText !== null && (
        <div
          className={`composer-notice${noticeExiting ? " is-exiting" : ""}`}
          role="status"
        >
          {noticeText}
          {/* 撤销改动 (ADR 0074 §4): the rewound turn's edits can still be
              taken back — until the next send, which clears this notice. */}
          {rewindUndo !== null && !noticeExiting && (
            <button
              type="button"
              className="composer-notice__action"
              disabled={rewindUndo === "busy"}
              onClick={() => void undoWithdrawn()}
            >
              {t("workspace.undoEdits")}
            </button>
          )}
        </div>
      )}
      {/* The held message (ADR 0063): sent while 板砖 worked, waiting to go
          as the next turn — or to be interjected into the running work, put
          back for editing, or discarded. Nothing here is in the record. A
          SIBLING of the composer, before it in the footer: a card behind the
          composer whose bottom edge tucks under it (Codex's shape, owner
          2026-09-15), and — because it is in flow, not inside the fixed-
          height composer — the footer grows by its height and the record
          above moves up instead of being covered. The interject offer needs
          both the window (板砖 still running) and a bridge that can steer;
          the other two are always there. The label ("sends when 板砖 is
          done") is the card's title, not a row of its own: the placeholder
          already said it, and the card reads as the message itself. */}
      {/* 继续 (ADR 0071 §1.4): 板砖's last run was interrupted — the app
          exited under it, or the user pressed Stop — and main can continue
          it. Offered in the held card's place and shape, only while the
          session is idle; pressing it sends the 继续 turn. */}
      {resumable && !busy && bridge.continueInterrupted !== undefined && (
        <section
          className="composer-held composer-resume"
          aria-label={t("composer.resume.aria")}
          data-testid="composer-resume"
        >
          <span className="composer-held__icon" aria-hidden="true">
            <svg
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="7" cy="7" r="5.6" />
              <path d="M5.6 4.6v4.8M8.4 4.6v4.8" />
            </svg>
          </span>
          <span className="composer-held__text">
            {t("composer.resume.text")}
          </span>
          <span className="composer-held__actions">
            <button
              type="button"
              className="composer-held__action composer-held__action--steer"
              onClick={() => void sessionStore.continueInterrupted()}
            >
              <svg
                viewBox="0 0 11 11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 2l5.5 3.5L3 9z" />
              </svg>
              {t("composer.resume.action")}
            </button>
          </span>
        </section>
      )}
      {held !== null && (
        <section
          ref={heldCardRef}
          className={`composer-held${suppressed ? " is-suppressed" : ""}`}
          aria-label={t("composer.hold.aria")}
          title={t("composer.hold.label")}
          data-testid="composer-held"
        >
          <span className="composer-held__icon" aria-hidden="true">
            <svg
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="7" cy="7" r="5.6" />
              <path d="M7 4.2V7l1.9 1.4" />
            </svg>
          </span>
          <span className="composer-held__text">{held}</span>
          <span className="composer-held__actions">
            {canSteer && (
              <button
                type="button"
                className="composer-held__action composer-held__action--steer"
                onClick={onSteer}
              >
                <svg
                  viewBox="0 0 11 11"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M1.5 5.5h8M6 2l3.5 3.5L6 9" />
                </svg>
                {t("composer.hold.steer")}
              </button>
            )}
            <button
              type="button"
              className="composer-held__action"
              onClick={onEditHeld}
            >
              {t("composer.hold.edit")}
            </button>
            <button
              type="button"
              className="composer-held__action composer-held__action--discard"
              aria-label={t("composer.hold.discard")}
              title={t("composer.hold.discard")}
              onClick={() => sessionStore.clearHeld()}
            >
              <svg
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
              </svg>
            </button>
          </span>
        </section>
      )}
      <form
        ref={composerRef}
        className={`composer${shrunk ? " is-shrunk" : ""}${hasStaged ? " has-staged" : ""}${suppressed ? " is-suppressed" : ""}${dragOver ? " is-dragover" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          doSubmit();
        }}
        onBlur={(e) => {
          // Height frozen while the OS picker is up — its window-focus churn
          // is not the user leaving the composer.
          if (pickerOpen.current) return;
          // Focus moving BETWEEN the form's own controls (textarea → attach,
          // attach → send) fires blur with the new holder as relatedTarget —
          // still inside, still expanded. Only a genuine exit (relatedTarget
          // outside the form, or null for a click on non-focusable ground /
          // the window deactivating) shrinks.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setFocusWithin(false);
        }}
        onPaste={(e) => {
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
        }}
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          dragDepth.current += 1;
          setDragOver(true);
        }}
        onDragOver={(e) => {
          // Without preventDefault the browser navigates to the dropped file and
          // the drop handler never runs — the classic silent-nothing-happens.
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragOver(false);
        }}
        onDrop={(e) => {
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
        }}
      >
        {/* Herta's tide wave living at the composer's floor (glass-wave merge,
          2026-07-05): inside the composer it tracks the composer's width when
          sidebars change, hides with is-suppressed during approval gates, and
          leaves the space above free for pop-ups. Decorative, behind the
          input/send (which are positioned), clipped by its own radius. */}
        <div className="composer-wave" aria-hidden="true">
          <AuraVisual />
        </div>
        {/* Staged pictures (ADR 0048 §4) — above the input, where the message
          they belong to is being written. Nothing here is in the record yet:
          the × removes a picture as if it had never arrived, which is the
          whole reason staging exists on an append-only record. */}
        {images.staged.length > 0 && (
          <ul className="composer-staged" aria-label={t("composer.staged")}>
            {images.staged.map((img) => (
              <li className="composer-staged__item" key={img.id}>
                {/* Click-to-enlarge (ADR 0048 §4a): checking WHICH screenshot
                  this is before sending is exactly when it matters — the ×
                  is the take-back, this is the look. */}
                <button
                  type="button"
                  className="composer-staged__open"
                  aria-label={`${t("lightbox.open")} ${img.name}`}
                  onClick={() => openLightbox(img)}
                >
                  <img
                    className="composer-staged__thumb"
                    src={attachmentImageUrl(img.path)}
                    alt={img.name}
                    title={img.name}
                    draggable={false}
                  />
                </button>
                <button
                  type="button"
                  className="composer-staged__remove"
                  aria-label={`${t("composer.staged.remove")} ${img.name}`}
                  onClick={() => images.unstage(img.id)}
                >
                  <svg
                    viewBox="0 0 10 10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
        {mentionOpen && (
          <div
            id="composer-mentions"
            className="composer-mentions"
            role="listbox"
            aria-label={t("composer.mentions.aria")}
          >
            {mentionMatches.map((item, i) => {
              const active = item === mentionActive;
              const firstFile =
                item.kind === "file" && mentionMatches[i - 1]?.kind !== "file";
              const option = (children: JSX.Element): JSX.Element => (
                <button
                  key={item.kind === "brick" ? "@brick" : item.path}
                  id={`composer-mention-${i}`}
                  type="button"
                  role="option"
                  // The caret stays in the textarea; the keys it takes move
                  // the highlight, so an option is never tabbed to.
                  tabIndex={-1}
                  aria-selected={active}
                  className={`composer-mentions__item${item.kind === "brick" ? " is-brick" : ""}${active ? " is-active" : ""}`}
                  // mousedown, not click: the textarea keeps the caret.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(item);
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                >
                  {children}
                </button>
              );
              if (item.kind === "brick") {
                return option(
                  <>
                    <span className="composer-mentions__name">
                      {lang === "en" ? "@brick" : "@板砖"}
                    </span>
                    <span className="composer-mentions__desc">
                      {t("composer.mentions.brick")}
                    </span>
                  </>,
                );
              }
              const cut = item.path.lastIndexOf("/");
              const name = item.path.slice(cut + 1);
              const dir = cut >= 0 ? item.path.slice(0, cut) : "";
              return (
                <Fragment key={item.path}>
                  {firstFile && (
                    // What the rows below are — the list says so itself.
                    <div
                      className="composer-mentions__section"
                      aria-hidden="true"
                    >
                      {t("composer.mentions.files")}
                    </div>
                  )}
                  {option(
                    <>
                      <span className="composer-mentions__name">{name}</span>
                      {dir.length > 0 && (
                        <span className="composer-mentions__dir">{dir}</span>
                      )}
                    </>,
                  )}
                </Fragment>
              );
            })}
          </div>
        )}
        <div className="composer-input-wrap">
          <div className="composer-highlight" aria-hidden="true">
            {renderBanzhuanText(text, "composer", lang)}
            {/* The ghost previews the token while its row is the one Tab
                or Enter would take — not once the highlight is on a file. */}
            {hintActive && (mentionActive?.kind ?? "brick") === "brick" && (
              <span className="composer-ghost">
                {lang === "en" ? "brick" : "板砖"}
              </span>
            )}
          </div>
          <textarea
            ref={taRef}
            className="composer-input"
            placeholder={t("composer.placeholder")}
            // The mention list is the textarea's: assistive technology hears
            // it open and follows the highlighted option (review 2026-09-30).
            aria-autocomplete="list"
            aria-controls={mentionOpen ? "composer-mentions" : undefined}
            aria-activedescendant={
              mentionOpen
                ? `composer-mention-${mentionIndex % mentionMatches.length}`
                : undefined
            }
            onFocus={() => {
              if (!quietFocus.current) setFocusWithin(true);
            }}
            value={text}
            onChange={(e) => {
              escDismissed.current = -1;
              // Typing is engagement: a caret given back quietly (the hold
              // window opening) expands on the first keystroke.
              setFocusWithin(true);
              setText(e.target.value);
              setHintActive(
                shouldHint(e.target.value, e.target.selectionStart, -1),
              );
              updateMention(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              setHintActive(
                shouldHint(
                  e.currentTarget.value,
                  e.currentTarget.selectionStart,
                  escDismissed.current,
                ),
              );
              updateMention(
                e.currentTarget.value,
                e.currentTarget.selectionStart,
              );
            }}
            onBlur={() => setMention(null)}
            onKeyDown={(e) => {
              // The @-mention list, while it is open (ADR 0072 §2): arrows
              // move, Enter or Tab inserts the row, Esc dismisses it — and
              // the ghost with it. An IME's pre-edit keeps every key: its
              // arrows walk the candidates, its Enter confirms one.
              if (
                mentionOpen &&
                mention !== null &&
                !(e.nativeEvent.isComposing || e.keyCode === 229)
              ) {
                const n = mentionMatches.length;
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIndex(
                    (i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n,
                  );
                  return;
                }
                if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                  e.preventDefault();
                  if (mentionActive !== undefined) pickMention(mentionActive);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  mentionDismissed.current = mention.start;
                  escDismissed.current = mention.start;
                  setHintActive(false);
                  setMention(null);
                  return;
                }
              }
              // Up-arrow recall (ADR 0072 §3): in an EMPTY composer, ↑ puts
              // back the last message sent in this session. Anything typed
              // keeps ↑ for moving the caret.
              if (
                e.key === "ArrowUp" &&
                text.length === 0 &&
                !e.shiftKey &&
                !e.altKey &&
                !e.ctrlKey &&
                !e.metaKey
              ) {
                // An IME whose pre-edit is not in the textarea yet leaves it
                // empty while composing: ↑ then moves its candidate, not the
                // history (review 2026-09-30).
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                const last = recallLastMessage(
                  sessionStore.getSnapshot().record,
                  lang,
                );
                if (last !== null) {
                  e.preventDefault();
                  setText(last);
                  pendingCaret.current = last.length;
                }
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                // IME safety (Chinese input): Enter during composition confirms
                // the candidate, it does NOT send. isComposing covers the spec
                // path; keyCode 229 covers engines that fire the keydown after
                // compositionend with isComposing already false.
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                e.preventDefault();
                doSubmit();
                return;
              }
              if (e.key === "Tab" && hintActive) {
                e.preventDefault();
                const caret = e.currentTarget.selectionStart ?? text.length;
                // EN completes to "brick" (→ "@brick", translated to the wire
                // token on submit); zh completes to the literal "板砖".
                const insert = lang === "en" ? "brick" : "板砖";
                const next = `${text.slice(0, caret)}${insert}${text.slice(caret)}`;
                pendingCaret.current = caret + insert.length;
                setText(next);
                setHintActive(false);
                return;
              }
              if (e.key === "Escape" && hintActive) {
                e.preventDefault();
                const caret = e.currentTarget.selectionStart ?? text.length;
                escDismissed.current = caret - 1; // the @ index
                setHintActive(false);
              }
            }}
            onScroll={(e) => {
              const hl = e.currentTarget
                .previousElementSibling as HTMLElement | null;
              if (hl) {
                hl.scrollTop = e.currentTarget.scrollTop;
                hl.scrollLeft = e.currentTarget.scrollLeft;
              }
            }}
            rows={2}
            aria-label={t("composer.aria")}
            disabled={busy && !holding}
          />
        </div>
        {/* ONE persistent button that morphs between SEND (↑) and STOP (■).
          While a turn runs it is wired to bridge.interrupt — previously a
          hung turn left the composer disabled forever with no affordance at
          all. The two glyphs are stacked in the same grid cell and
          cross-fade/scale via `.is-stop` (see reference-ux.css), so the mode
          change reads as the button transforming, not two buttons being
          swapped (user 2026-07-04). The stop square is a sized <span>, not a
          ■ text glyph — font metrics rendered the glyph tiny and
          inconsistent across fonts. */}
        {/* Attach. Disabled during a turn for the same reason the main-process
          handler refuses then: the ingest rides an out-of-turn record append.
          Showing it disabled beats letting a click produce a refusal notice.
          The hint is the app's styled Tooltip like the topbar icons — the
          first cut used the native `title`, which renders as the OS's own
          beige box and matches nothing (owner 2026-08-10). placement="top"
          because the composer sits at the window's bottom edge; align="end"
          because the button sits near the right one. */}
        <Tooltip
          label={t("composer.attach")}
          sub={t("composer.attach.formats")}
          placement="top"
          align="end"
        >
          <button
            type="button"
            className="composer-attach"
            aria-label={t("composer.attach")}
            disabled={busy}
            onClick={onPickAttachments}
          >
            {/* viewBox origin nudged by the path's own ink offset (owner asked
              me to check this button, 2026-08-10). Measured with getBBox: the
              paperclip's ink spans y 1.70–13.96 in a 0–14 box, so its centre
              sits 0.83 units low — ~0.95px at this size — and 0.32 right. The
              <svg> element is perfectly centred in the button; the drawing
              inside it is not, which no layout measurement can see. Shifting
              the window by that offset lands ink centre on box centre without
              touching the scale. */}
            <svg viewBox="0.32 0.83 14 14" aria-hidden="true" focusable="false">
              <path d="M9.5 4.2 5.3 8.4a1.6 1.6 0 0 0 2.3 2.3l4.2-4.2a3 3 0 0 0-4.2-4.2L3.2 6.6a4.3 4.3 0 0 0 6.1 6.1l3.4-3.4" />
            </svg>
          </button>
        </Tooltip>
        <button
          ref={sendButtonRef}
          type={busy ? "button" : "submit"}
          className={`composer-send${busy ? " is-stop" : ""}`}
          aria-label={busy ? t("composer.stop") : t("composer.send")}
          disabled={!busy && (text.trim().length === 0 || readingDoc)}
          onClick={
            busy
              ? () => {
                  // Cut any in-flight voice ON the click, not via the turn
                  // lifecycle: the opening's interrupt-as-SKIP finishes the
                  // turn normally (`finished`, no `failed`), so useVoiceCues'
                  // failed-cut never fires and the opening clip talked through
                  // the skip (user 2026-07-13). The stop click IS the intent —
                  // silence immediately, then abort the turn.
                  stopAllVoice();
                  stopRequested.current = true;
                  void bridge.interrupt();
                }
              : undefined
          }
        >
          <span
            className="composer-send__glyph composer-send__glyph--send"
            aria-hidden="true"
          >
            <SendArrowIcon />
          </span>
          <span
            className="composer-send__glyph composer-send__glyph--stop"
            aria-hidden="true"
          />
        </button>
      </form>
    </>
  );
}
