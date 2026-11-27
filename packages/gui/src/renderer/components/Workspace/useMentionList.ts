/**
 * The composer's @-mention list (ADR 0072 §2): the `@query` the caret is
 * in, the workspace's files that match it (listed by main, kept a few
 * seconds per session), the highlighted row, and the mention the user
 * dismissed. Split out of Composer.tsx (review 2026-11-10, moved
 * 2026-11-27). The hook holds no effect; picking a row edits the draft and
 * its chips, which stays in the composer.
 */
import { workspaceRelativeRepoPath } from "@herta/core/repo-path";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useMemo,
  useRef,
  useState,
} from "react";
import type { HertaBridge } from "../../ipc/bridge-types.js";
import {
  brickComplete,
  chipAt,
  type FileChip,
  findChipSpans,
  findMentionQuery,
  type MentionItem,
  mentionItems,
} from "../../lib/file-mention.js";
import type { SessionStore } from "../../store/session-store.js";

/** How long the workspace's file list is reused before `@` lists it again
 *  (ADR 0072 §2) — a file 板砖 just created shows up on the next mention. */
const MENTION_FILES_TTL_MS = 10_000;

/** The `@query` the caret is in: where its `@` is, and what follows it. */
export interface MentionQuery {
  readonly start: number;
  readonly query: string;
}

export interface MentionListDeps {
  readonly bridge: HertaBridge;
  readonly sessionStore: SessionStore;
  readonly sessionId: string | null;
  readonly lang: "zh" | "en";
  /** A chip's own token is not a query. */
  readonly chipsRef: MutableRefObject<readonly FileChip[]>;
}

export interface MentionList {
  readonly mention: MentionQuery | null;
  readonly setMention: Dispatch<SetStateAction<MentionQuery | null>>;
  readonly mentionIndex: number;
  readonly setMentionIndex: Dispatch<SetStateAction<number>>;
  /** The `@` whose list the user dismissed with Esc; -1 for none. */
  readonly mentionDismissed: MutableRefObject<number>;
  /** Follow the caret: open, move or close the list for `value`. */
  readonly updateMention: (value: string, caret: number | null) => void;
  readonly mentionMatches: MentionItem[];
  readonly mentionOpen: boolean;
  readonly mentionActive: MentionItem | undefined;
  /** A session change: the list, its files and its dismissal go. */
  readonly resetMentions: () => void;
}

export function useMentionList(deps: MentionListDeps): MentionList {
  const { bridge, sessionStore, sessionId, lang, chipsRef } = deps;
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
  // The mention list for the caret's `@query`, from the bare `@` on (owner
  // 2026-10-08: it waited for a query past what could still be `@板砖`, so a
  // bare `@` showed the ghost alone and the files went unnoticed). Not for
  // the token already typed out, nor for a mention the user dismissed. The
  // files are fetched once and kept for a few seconds, so typing does not
  // re-list; where the bridge cannot list them, the list offers `@板砖`
  // alone.
  const updateMention = (value: string, caret: number | null): void => {
    // A chip's own token is not a query: the caret at its end offers nothing.
    const onChip =
      caret !== null &&
      chipAt(findChipSpans(value, chipsRef.current), caret) !== null;
    const mq = onChip ? null : findMentionQuery(value, caret);
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
  const resetMentions = (): void => {
    setMention(null);
    setMentionFiles(null);
    mentionCache.current = null;
    mentionDismissed.current = -1;
  };
  return {
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
  };
}
