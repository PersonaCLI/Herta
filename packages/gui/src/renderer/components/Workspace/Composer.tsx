import type { TerminalRecord } from "@herta/core";
import { pageElementWords } from "@herta/core/page-element";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import { useSessionLang } from "../../hooks/useActiveSession.js";
import {
  shallowEqualObjects,
  useSessionSelector,
} from "../../hooks/useSessionSelector.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { aliasBrickInput } from "../../lib/banzhuan-mention.js";
import {
  addChipAt,
  chipify,
  chipifyPicks,
  chipsAfterEdit,
  expandChips,
  findChipSpans,
  insertBrick,
  insertChip,
  insertPickChip,
  type MentionItem,
  type PagePick,
  pickLine,
  picksIn,
  withoutChip,
} from "../../lib/file-mention.js";
import {
  composeQuotedMessage,
  joinHeld,
  quotesBack,
} from "../../lib/quote-format.js";
import { recallLastUserMessage } from "../../lib/recall-last-message.js";
import { useEscapeStop, useShortcut } from "../../lib/shortcut-registry.js";
import { submitMessage } from "../../lib/submit-message.js";
import type { SessionStore } from "../../store/session-store.js";
import { stopAllVoice } from "../../voice/play-voice.js";
import { armHoverTip, hideHoverTip } from "../common/hover-tip.js";
import { useFileViewerOpen } from "../FileViewer/file-viewer-context.js";
import { Tooltip } from "../Tooltip/Tooltip.js";
import { AuraVisual } from "../UtilityRail/AuraVisual.js";
import { ChipMenu, renderWithChips } from "./ComposerChips.js";
import { ComposerHeldCard, ComposerResumeCard } from "./ComposerHeldCards.js";
import { ComposerMentions } from "./ComposerMentions.js";
import { ComposerQuotes } from "./ComposerQuotes.js";
import { ComposerStaged } from "./ComposerStaged.js";
import { useAttachmentIntake } from "./useAttachmentIntake.js";
import { COMPOSER_MIN_LINES, useComposerLines } from "./useComposerLines.js";
import { useComposerNotice } from "./useComposerNotice.js";
import { useFileChips } from "./useFileChips.js";
import { useMentionList } from "./useMentionList.js";

// Tested through this module (Composer.test.tsx).
export {
  COMPOSER_MAX_LINES,
  COMPOSER_MIN_LINES,
  composerLinePx,
  composerLines,
} from "./useComposerLines.js";

import { useLightbox } from "./ImageLightbox.js";
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
  // Where sending put the focus (ADR 0082 §11): the conversation itself.
  if (active.classList.contains("conversation")) return true;
  return active.closest(".approval-panel") !== null;
}

/** Every element picked on the page this composer knows of (ADR 0083 §4):
 *  the ones it placed and the ones the record's messages carry, by line. */
function knownPicksOf(
  placed: ReadonlyMap<string, PagePick>,
  record: TerminalRecord,
): PagePick[] {
  const all = new Map(placed);
  for (const b of record) {
    if (b.kind !== "user") continue;
    for (const p of b.picks ?? []) all.set(p.line, p);
  }
  return [...all.values()];
}

/** A picked element's chip label: the element in the session's words, as
 *  Herta reads it (`按钮「Sign in」`). */
const pickLabelIn =
  (lang: "zh" | "en") =>
  (pick: PagePick): string =>
    pageElementWords(pick.element, lang);

/** A message coming back into the composer (an edited or returned hold,
 *  ↑ recall, a rewind): its leading quotes become chips again, and the rest
 *  is what goes into the field (ADR 0078 amendment 2026-10-21). */
function takeBack(store: SessionStore, message: string): string {
  const back = quotesBack(message);
  for (const q of back.quotes) store.addComposerQuote(q);
  return back.rest;
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
    prediction,
    composerQuotes,
    composerPicks,
    composerSteer,
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
      prediction: s.prediction,
      composerQuotes: s.composerQuotes,
      composerPicks: s.composerPicks,
      composerSteer: s.composerSteer,
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
  // File chips (useFileChips.ts): each `@<name>` token drawn as a chip,
  // the chip menu, and the elements picked on the page. Called where the
  // chips' state was: its effect is the first of the composer's own.
  const {
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
  } = useFileChips({ text, setText, pendingCaret, taRef, sessionStore });
  // The @-mention list (useMentionList.ts).
  const {
    mention,
    setMention,
    mentionIndex,
    setMentionIndex,
    mentionDismissed,
    updateMention,
    mentionMatches,
    mentionOpen,
    mentionActive,
    resetMentions,
  } = useMentionList({ bridge, sessionStore, sessionId, lang, chipsRef });
  const openFile = useFileViewerOpen();
  const busy = status !== "idle";
  const suppressed = overlay?.kind === "pending-permission";
  // Composer predictions (owner 2026-10-10): the Trailblazer's likely next
  // line, shown where the placeholder is while the box is empty. Tab takes
  // it (nothing is sent); typing replaces it. In an EN session the trigger
  // is spelled the way this composer spells it, `@brick`.
  // A staged quote (ADR 0078 §6) is its own subject: no prediction for it.
  const suggestion =
    prediction !== null &&
    text.length === 0 &&
    composerQuotes.length === 0 &&
    !busy &&
    !suppressed
      ? lang === "en"
        ? prediction.replaceAll("@板砖", "@brick")
        : prediction
      : null;
  // A message while 板砖 works (ADR 0063). The hold exists ONLY while the
  // coprocessor runs — the one phase with a sampling boundary a steer can
  // reach (owner 2026-09-14: a conversation with Herta has no such
  // mechanism). Then the textarea stays enabled, Enter holds the text above
  // the composer instead of interrupting, and the button stays Stop. The
  // held text goes as the next turn when this one ends, unless the user
  // interjects it (`steerText`) or takes it back. Herta's own speech keeps
  // the composer as it was: disabled, with Stop.
  const running = busy && backendActive;
  const holding = running && !suppressed;
  const canSteer = holding && bridge.steerText !== undefined;
  // While 板砖 works the composer talks to Herta (ADR 0085 step 3): what is
  // sent goes to her, and she answers while the run goes on. The 插话 tag
  // sends it to the run as a steer instead. A bridge without talk (the
  // website demo) holds the message as ADR 0063 did.
  const canTalk = holding && bridge.talkText !== undefined;
  const steerOn = composerSteer && canSteer;
  // The tag belongs to the run it was set in, and an approval is part of
  // that run: the box closes for the card and the tag comes back with it.
  // Dropped there, a steer being typed went to Herta (review 2026-11-05).
  useEffect(() => {
    if (!running && composerSteer) sessionStore.setComposerSteer(false);
  }, [running, composerSteer, sessionStore]);
  // The turn-end delivery reads the latest held text and language from
  // refs: the effect is keyed on the busy edge, not on either.
  const heldRef = useRef<string | null>(null);
  heldRef.current = held;
  /** The user pressed Stop in this turn: a held message does not go. */
  const stopRequested = useRef(false);
  /** Stop, from the button or Escape (ADR 0082 §5). Cut any in-flight voice
   *  at once, not via the turn lifecycle: the opening's interrupt-as-SKIP
   *  finishes the turn normally (`finished`, no `failed`), so useVoiceCues'
   *  failed-cut never fires and the opening clip talked through the skip
   *  (user 2026-07-13). The stop IS the intent — silence immediately, then
   *  abort the turn. */
  const stopTurn = (): void => {
    stopAllVoice();
    stopRequested.current = true;
    void bridge.interrupt();
  };
  useEscapeStop(busy && !suppressed, stopTurn, taRef);
  // 停止运行 on the run's card and row (ADR 0085 §9) is this Stop, by its
  // command: the voice cut and the held message dropped as here. The buttons
  // stay on the screen under an approval, so this answers there too: an
  // interrupt ends the gate (Escape is the card's own, and denies).
  useShortcut(
    "stopRun",
    () => {
      stopTurn();
      return true;
    },
    busy,
  );
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
  // What the composer takes in (useAttachmentIntake.ts): the file picker,
  // a drop, a pasted picture. Pictures stage; documents are read at once.
  const {
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
  } = useAttachmentIntake({
    bridge,
    sessionStore,
    sessionId,
    t,
    images,
    refuseForTurn,
    busy,
    taRef,
    setFocusWithin,
  });

  // Shared submit path for the ↑ button (form submit) and Enter-to-send.
  const doSubmit = (): void => {
    if (busy) {
      // While 板砖 works the words are HELD, not sent (ADR 0063). Raw text:
      // the @brick alias is applied when the hold is delivered or steered,
      // so an edit puts back exactly what was typed.
      if (!holding) return;
      // The chips go as the paths they stand for (ADR 0072 amendment
      // 2026-10-20): a held message is plain text from here on. Its quotes
      // go with it, in front, as a send would carry them (ADR 0078
      // amendment 2026-10-21) — they used to stay staged, and the words
      // went without them. The alias at delivery skips fenced source.
      const pending = composeQuotedMessage(
        composerQuotes,
        expandChips(text, chips).text.trim(),
        lang,
      );
      if (pending.trim().length === 0) return;
      setText("");
      setChips([]);
      setHintActive(false);
      sessionStore.clearComposerQuotes();
      if (!canTalk && !steerOn) {
        sessionStore.holdMessage(pending, joinHeld);
        return;
      }
      // Sent now, to her or (with the tag) to 板砖. The @brick alias is
      // applied as a send applies it; a message the run could no longer take
      // (it ended between the keypress and the call) is held for the next
      // turn, as before.
      const words = aliasBrickInput(pending, lang);
      const picks = picksIn(
        pending,
        knownPicksOf(placedPicks.current, sessionStore.getSnapshot().record),
      );
      const holdIfQueued = (r: { readonly queued: true } | object): void => {
        if ("queued" in r) sessionStore.holdMessage(pending, joinHeld);
      };
      if (steerOn) {
        bridge
          .steerText?.(words, picks.length > 0 ? picks : undefined)
          .then(holdIfQueued, () =>
            sessionStore.holdMessage(pending, joinHeld),
          );
        return;
      }
      const mentions = expandChips(text, chips).mentions;
      sessionStore.markPendingTalk(
        words,
        mentions.length > 0 ? mentions : undefined,
        picks.length > 0 ? picks : undefined,
      );
      bridge
        .talkText?.(
          words,
          mentions.length > 0 ? mentions : undefined,
          picks.length > 0 ? picks : undefined,
        )
        .then(
          (r) => {
            if (!("queued" in r)) return;
            sessionStore.withdrawPendingUser(words);
            sessionStore.clearComposerDraft();
            sessionStore.holdMessage(pending, joinHeld);
          },
          () => {
            sessionStore.withdrawPendingUser(words);
          },
        );
      return;
    }
    // Each chip becomes its path; the user block records the paths, so the
    // bubble draws them as chips and Herta reads their names.
    const expanded = expandChips(text, chips);
    const trimmed = expanded.text.trim();
    // Quotes alone are a message (ADR 0078 §6): the source is what was said.
    if (trimmed.length === 0 && composerQuotes.length === 0) {
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
    // The quotes go first, as written (ADR 0078 §5): the alias applies to
    // what was typed, never to quoted source.
    const dispatched = composeQuotedMessage(
      composerQuotes,
      aliasBrickInput(trimmed, lang),
      lang,
    );
    // Take the staged pictures BEFORE dispatching: they ride this message,
    // and the strip must empty on the same frame the text does (ADR 0048 §4).
    const staged = images.take();
    // Optimistic echo + dispatch. With no DeepSeek key set, the backend
    // reports needsKey and submitMessage opens the no-key onboarding card.
    // The elements picked on the page go as their lines, recorded as picks
    // (ADR 0083 §4) — a chip's and a line that came back as words alike.
    const picks = picksIn(expanded.text, [
      ...expanded.picks,
      ...knownPicksOf(placedPicks.current, sessionStore.getSnapshot().record),
    ]);
    submitMessage(
      bridge,
      sessionStore,
      dispatched,
      staged.length > 0 ? staged : undefined,
      undefined,
      expanded.mentions.length > 0 ? expanded.mentions : undefined,
      picks.length > 0 ? picks : undefined,
    );
    setText("");
    setChips([]);
    setChipMenu(null);
    sessionStore.clearComposerQuotes();
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
        // Its picked elements come back as chips (ADR 0083 §4).
        const back = chipifyPicks(
          takeBack(sessionStore, pending),
          knownPicksOf(placedPicks.current, sessionStore.getSnapshot().record),
          pickLabelIn(langRef.current),
        );
        const words = back.text;
        // Quotes alone come back as chips with no words: what is typed
        // stays as it was, not pushed down two lines.
        if (words.length > 0) {
          setText((prev) =>
            prev.trim().length > 0 ? `${words}\n\n${prev}` : words,
          );
          setChips((c) => [...back.chips, ...c]);
          pendingCaret.current = words.length;
        }
      } else if (pending !== null) {
        // The clone lifts off from the card, not the input: measure it
        // BEFORE the clear unmounts it.
        const rect = heldCardRef.current?.getBoundingClientRect();
        const launch =
          rect !== undefined
            ? { left: rect.left + 16, top: rect.top }
            : undefined;
        sessionStore.clearHeld();
        const picks = picksIn(
          pending,
          knownPicksOf(placedPicks.current, sessionStore.getSnapshot().record),
        );
        submitMessage(
          bridge,
          sessionStore,
          aliasBrickInput(pending, langRef.current),
          undefined,
          launch,
          undefined,
          picks.length > 0 ? picks : undefined,
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
  }, [
    busy,
    suppressed,
    bridge,
    sessionStore,
    composerRef,
    setChips,
    placedPicks,
  ]);

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
    if (was && !holding && busy) {
      setFocusWithin(false);
      // The disable drops the caret to the page, where Tab starts over and
      // Escape stops the run unasked: the conversation takes it, as at the
      // turn's start (ADR 0082 §11; release review 2026-10-22).
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active === null || active === document.body)
          document
            .querySelector<HTMLElement>(".conversation")
            ?.focus({ preventScroll: true });
      });
    }
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
    const picks = picksIn(
      pending,
      knownPicksOf(placedPicks.current, sessionStore.getSnapshot().record),
    );
    steer(
      aliasBrickInput(pending, lang),
      picks.length > 0 ? picks : undefined,
    ).then(
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
    const back = chipifyPicks(
      takeBack(sessionStore, pending),
      knownPicksOf(placedPicks.current, sessionStore.getSnapshot().record),
      pickLabelIn(lang),
    );
    const words = back.text;
    if (words.length > 0) {
      setText((prev) => (prev.length > 0 ? `${words}\n\n${prev}` : words));
      setChips((c) => [...back.chips, ...c]);
    }
    taRef.current?.focus({ preventScroll: true });
    setFocusWithin(true);
  };

  // 撤销改动 pressed (ADR 0074 §4): take the withdrawn turn's edits back and
  // say what happened in the notice's place. The withdrawn turn is out of
  // the record, so this notice is the only place a file left alone shows.
  const undoWithdrawn = async (): Promise<void> => {
    const now = sessionStore.getSnapshot();
    if (now.rewindUndo !== "offer" || now.undoBusy) return;
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

  // The Composer stays mounted across session changes and the disconnected
  // state, so its local draft would otherwise leak into the next session (type
  // text, delete the session, connect a new one → the old text reappears).
  // Reset whenever the active session changes — a new/other session starts empty.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed on sessionId; the setters/ref are stable
  useEffect(() => {
    setText("");
    setChips([]);
    setChipMenu(null);
    setHintActive(false);
    escDismissed.current = -1;
    resetMentions();
  }, [sessionId]);

  const pickMention = (item: MentionItem): void => {
    if (mention === null) return;
    const caret = taRef.current?.selectionStart ?? text.length;
    if (item.kind === "file") {
      const next = insertChip(
        text,
        mention.start,
        caret,
        item.path,
        item.dir === true,
      );
      pendingCaret.current = next.caret;
      // In the text's order, so a same-name chip keeps its own path.
      setChips((c) =>
        addChipAt(c, findChipSpans(text, c), mention.start, next.chip),
      );
      setText(next.text);
      setMention(null);
      setHintActive(false);
      taRef.current?.focus({ preventScroll: true });
      return;
    }
    const next = insertBrick(
      text,
      mention.start,
      caret,
      lang === "en" ? "brick" : "板砖",
    );
    pendingCaret.current = next.caret;
    setText(next.text);
    setMention(null);
    setHintActive(false);
    taRef.current?.focus({ preventScroll: true });
  };

  // The menu closes on Esc and on any press outside it.
  useEffect(() => {
    if (chipMenu === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Marked: this Escape closed a menu, it does not stop the run
      // (ADR 0082 §5).
      e.preventDefault();
      setChipMenu(null);
      taRef.current?.focus({ preventScroll: true });
    };
    const onDown = (e: MouseEvent): void => {
      const t = e.target;
      if (t instanceof Element && t.closest(".composer-chip-menu") !== null)
        return;
      // A press in the textarea is the textarea's own: on a chip it opens
      // or toggles the menu — the press that opened it reaches this listener
      // too, added while it was still on its way up.
      if (t === taRef.current) return;
      setChipMenu(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [chipMenu, setChipMenu]);
  // The highlighted row stays in view as the arrows move it (the list
  // scrolls now — it holds more rows than fit).
  useEffect(() => {
    if (mention === null) return;
    document
      .getElementById(`composer-mention-${mentionIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [mentionIndex, mention]);
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
    // (UX review 2026-09-22, item 15). Its quotes come back as chips.
    const back = chipifyPicks(
      takeBack(sessionStore, composerDraft),
      knownPicksOf(placedPicks.current, sessionStore.getSnapshot().record),
      pickLabelIn(lang),
    );
    const words = back.text;
    if (words.length > 0) {
      setText((prev) =>
        prev.trim().length > 0 ? `${words}\n\n${prev}` : words,
      );
      setChips((c) => [...back.chips, ...c]);
    }
    if (composerDraftImages !== null) images.restore(composerDraftImages);
    setHintActive(false);
    pendingCaret.current = words.length;
    taRef.current?.focus({ preventScroll: true });
    sessionStore.clearComposerDraft();
  }, [composerDraft]);

  // An element picked on the page (ADR 0083 §4) lands as a chip at the
  // caret, and the caret comes back to the composer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the picks signal; the text and chips are this render's
  useEffect(() => {
    if (composerPicks.length === 0) return;
    let value = text;
    let caret = taRef.current?.selectionStart ?? value.length;
    let next = chips;
    for (const raw of composerPicks) {
      const pick: PagePick = {
        element: raw.element,
        route: raw.route,
        line: pickLine(raw),
      };
      placedPicks.current.set(pick.line, pick);
      const placed = insertPickChip(
        value,
        caret,
        pickLabelIn(lang)(pick),
        pick,
      );
      next = addChipAt(next, findChipSpans(value, next), caret, placed.chip);
      value = placed.text;
      caret = placed.caret;
    }
    sessionStore.clearComposerPicks();
    setChips(next);
    setText(value);
    pendingCaret.current = caret;
    taRef.current?.focus({ preventScroll: true });
    setFocusWithin(true);
  }, [composerPicks]);

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

  // The notice pill, held mounted through its slide-out
  // (useComposerNotice.ts).
  const { noticeText, noticeExiting } = useComposerNotice(composerNotice);

  // A file drag over the composer also expands it — a drop target should
  // not be at its smallest exactly while the user is aiming at it. Staged
  // pictures also hold it open: the strip is the only sign the pictures are
  // pending, and shrinking would clip it (ADR 0048 §4).
  const hasStaged = images.staged.length > 0;
  // The 插话 tag rides the quotes' row: the composer makes room for it.
  const hasQuotes = composerQuotes.length > 0 || steerOn;
  const shrunk = !focusWithin && !dragOver && !hasStaged && !hasQuotes;

  // The draft's lines and the line's height (useComposerLines.ts): every
  // height of the composer grows by the lines past two.
  const { measureRef, inputLines, linePx } = useComposerLines(text);

  // Ctrl/⌘+L and Ctrl/⌘+U (ADR 0082): the caret into the composer, and the
  // paperclip — each refused exactly when its control is (a disabled
  // textarea takes no caret; attaching waits for the turn to end).
  useShortcut("focusComposer", () => {
    taRef.current?.focus({ preventScroll: true });
    return true;
  });
  useShortcut("attachFiles", () => {
    if (!busy) onPickAttachments();
    return true;
  });
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
        <ComposerResumeCard t={t} sessionStore={sessionStore} />
      )}
      {held !== null && (
        <ComposerHeldCard
          heldCardRef={heldCardRef}
          suppressed={suppressed}
          t={t}
          held={held}
          canSteer={canSteer}
          onSteer={onSteer}
          onEditHeld={onEditHeld}
          sessionStore={sessionStore}
        />
      )}
      <form
        ref={composerRef}
        className={`composer${shrunk ? " is-shrunk" : ""}${hasStaged ? " has-staged" : ""}${hasQuotes ? " has-quotes" : ""}${suppressed ? " is-suppressed" : ""}${dragOver ? " is-dragover" : ""}`}
        style={
          {
            "--composer-extra-lines": String(inputLines - COMPOSER_MIN_LINES),
            "--composer-line": `${linePx}px`,
          } as CSSProperties
        }
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
        onPaste={onPaste}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
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
          <ComposerStaged images={images} openLightbox={openLightbox} t={t} />
        )}
        {/* The 插话 tag (ADR 0085 §9): while it shows, what is sent goes
          to 板砖's run as a steer; × gives the composer back to Herta.
          Quotes from the viewer's page (ADR 0078 §6): the source rides
          the message when it is sent; × takes one back. */}
        {hasQuotes && (
          <ComposerQuotes
            steerOn={steerOn}
            composerQuotes={composerQuotes}
            lang={lang}
            t={t}
            sessionStore={sessionStore}
          />
        )}
        {mentionOpen && (
          <ComposerMentions
            mentionMatches={mentionMatches}
            mentionActive={mentionActive}
            pickMention={pickMention}
            setMentionIndex={setMentionIndex}
            lang={lang}
            t={t}
          />
        )}
        <div className="composer-input-wrap">
          {/* The draft as the textarea wraps it, unseen: its height is how
              many lines the composer shows. The zero-width space keeps the
              empty line a trailing newline opens, as the textarea does. */}
          <div ref={measureRef} className="composer-measure" aria-hidden="true">
            {text}
            {"​"}
          </div>
          <div className="composer-highlight" aria-hidden="true">
            {renderWithChips(text, chipSpans, lang)}
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
            // No spellcheck (owner 2026-10-20: a chip's name showed the red
            // squiggle). A textarea checks all of its text or none, so a
            // chip's token is flagged like any word; most English typed here
            // is identifiers and file names, and the app offers no
            // corrections to act on a squiggle.
            spellCheck={false}
            placeholder={
              steerOn
                ? t("composer.steer.placeholder")
                : (suggestion ??
                  t(
                    composerQuotes.length > 0
                      ? "composer.quote.placeholder"
                      : "composer.placeholder",
                  ))
            }
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
              // The chips the edit touched go — placed by the caret, so of
              // two same-name chips the right one goes (release review
              // 2026-10-22).
              const value = e.target.value;
              const at = e.target.selectionStart;
              setChips((c) => chipsAfterEdit(text, value, at, c));
              setText(value);
              setHintActive(
                shouldHint(e.target.value, e.target.selectionStart, -1),
              );
              updateMention(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              // A chip is one piece: a caret that lands inside its token is
              // pushed out, the way it was travelling.
              const ta = e.currentTarget;
              const caret = ta.selectionStart;
              if (caret !== null && caret === ta.selectionEnd) {
                const inside = chipSpans.find(
                  (s) => s.start < caret && caret < s.end,
                );
                if (inside !== undefined) {
                  const to =
                    caret < lastCaret.current ? inside.start : inside.end;
                  ta.setSelectionRange(to, to);
                  lastCaret.current = to;
                  return;
                }
                lastCaret.current = caret;
              }
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
            onMouseDown={(e) => {
              // A chip is a control, not text: a press opens its menu.
              if (e.button !== 0) return;
              const hit = chipUnder(e.clientX, e.clientY);
              if (hit === null) {
                setChipMenu(null);
                return;
              }
              e.preventDefault();
              if (chipMenu?.span.start === chipSpans[hit.index]?.start) {
                setChipMenu(null);
                return;
              }
              openChipMenu(hit.index, hit.el);
            }}
            onContextMenu={(e) => {
              const hit = chipUnder(e.clientX, e.clientY);
              if (hit === null) return;
              e.preventDefault();
              openChipMenu(hit.index, hit.el);
            }}
            onMouseMove={(e) => {
              const hit = chipUnder(e.clientX, e.clientY);
              const index = hit?.index ?? -1;
              e.currentTarget.style.cursor = hit !== null ? "pointer" : "";
              if (index === hoverChip.current) return;
              hoverChip.current = index;
              hideHoverTip();
              const span = hit !== null ? chipSpans[index] : undefined;
              if (hit !== null && span !== undefined && chipMenu === null) {
                armHoverTip(
                  hit.el,
                  span.chip.pick !== undefined
                    ? span.chip.pick.route
                    : span.chip.dir === true
                      ? `${span.chip.path}/`
                      : span.chip.path,
                );
              }
            }}
            onMouseLeave={(e) => {
              hoverChip.current = -1;
              e.currentTarget.style.cursor = "";
              hideHoverTip();
            }}
            onKeyDown={(e) => {
              // Shift+F10 or the context-menu key with the caret at a chip
              // opens its menu, focused (ADR 0082 §10).
              if (
                (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) &&
                !(e.nativeEvent.isComposing || e.keyCode === 229)
              ) {
                const ta = e.currentTarget;
                const caret = ta.selectionStart;
                const index =
                  caret !== null && caret === ta.selectionEnd
                    ? chipSpans.findIndex(
                        (s) => s.end === caret || s.start === caret,
                      )
                    : -1;
                const el =
                  index === -1
                    ? null
                    : ta.previousElementSibling?.querySelector(
                        `[data-chip="${index}"]`,
                      );
                if (el instanceof HTMLElement) {
                  e.preventDefault();
                  openChipMenu(index, el, true);
                  return;
                }
              }
              // A chip goes whole (ADR 0072 amendment 2026-10-20): Backspace
              // at its end, Delete at its start.
              if (
                (e.key === "Backspace" || e.key === "Delete") &&
                !(e.nativeEvent.isComposing || e.keyCode === 229)
              ) {
                const ta = e.currentTarget;
                const caret = ta.selectionStart;
                if (caret !== null && caret === ta.selectionEnd) {
                  const span = chipSpans.find((s) =>
                    e.key === "Backspace" ? s.end === caret : s.start === caret,
                  );
                  if (span !== undefined) {
                    e.preventDefault();
                    pendingCaret.current = span.start;
                    setChips((c) => withoutChip(c, span.chip));
                    setText(
                      `${text.slice(0, span.start)}${text.slice(span.end)}`,
                    );
                    return;
                  }
                }
              }
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
                const last = recallLastUserMessage(
                  sessionStore.getSnapshot().record,
                  lang,
                );
                if (last !== null) {
                  e.preventDefault();
                  // The chips it was sent with come back as chips, and its
                  // quotes as quote chips — unless quotes are staged, which
                  // a recall must not double.
                  const words =
                    composerQuotes.length === 0
                      ? takeBack(sessionStore, last.text)
                      : quotesBack(last.text).rest;
                  const picked = chipifyPicks(
                    words,
                    last.picks ?? [],
                    pickLabelIn(lang),
                  );
                  const back = chipify(picked.text, last.mentions);
                  setChips([...picked.chips, ...back.chips]);
                  setText(back.text);
                  pendingCaret.current = back.text.length;
                }
                return;
              }
              if (
                e.key === "Tab" &&
                suggestion !== null &&
                !e.shiftKey &&
                !(e.nativeEvent.isComposing || e.keyCode === 229)
              ) {
                // Take the suggestion into the box — never send it.
                e.preventDefault();
                setText(suggestion);
                pendingCaret.current = suggestion.length;
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
            aria-description={
              suggestion !== null ? t("composer.predictionAria") : undefined
            }
            disabled={busy && !holding}
          />
          {suggestion !== null && (
            <span className="composer-prediction-key" aria-hidden="true">
              Tab
            </span>
          )}
          {chipMenu !== null && (
            <ChipMenu
              chip={chipMenu.span.chip}
              left={chipMenu.left}
              bottom={chipMenu.bottom}
              takeFocus={chipMenu.byKey}
              onDismiss={() => {
                setChipMenu(null);
                taRef.current?.focus({ preventScroll: true });
              }}
              copyOpen={chipCopyOpen}
              onCopyOpen={setChipCopyOpen}
              t={t}
              onCopyRelative={() =>
                copyText(
                  chipMenu.span.chip.dir === true
                    ? `${chipMenu.span.chip.path}/`
                    : chipMenu.span.chip.path,
                )
              }
              onCopyAbsolute={() =>
                copyText(absolutePath(chipMenu.span.chip.path))
              }
              onCopyName={() => copyText(chipMenu.span.chip.name)}
              {...(openFile !== null && chipMenu.span.chip.dir !== true
                ? {
                    onOpenViewer: () => {
                      openFile(chipMenu.span.chip.path, {});
                      setChipMenu(null);
                    },
                  }
                : {})}
              {...(bridge.openWorkspaceFile !== undefined &&
              sessionId !== null &&
              chipMenu.span.chip.dir !== true
                ? {
                    onOpenDefault: () => {
                      void bridge.openWorkspaceFile?.(
                        sessionId,
                        chipMenu.span.chip.path,
                      );
                      setChipMenu(null);
                    },
                  }
                : {})}
              {...(bridge.revealWorkspaceFile !== undefined &&
              sessionId !== null
                ? {
                    onReveal: () => {
                      void bridge.revealWorkspaceFile?.(
                        sessionId,
                        chipMenu.span.chip.path,
                      );
                      setChipMenu(null);
                    },
                  }
                : {})}
              onRemove={() => removeChip(chipMenu.span)}
            />
          )}
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
          keys="attachFiles"
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
          disabled={
            !busy &&
            ((text.trim().length === 0 && composerQuotes.length === 0) ||
              readingDoc)
          }
          onClick={busy ? stopTurn : undefined}
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
