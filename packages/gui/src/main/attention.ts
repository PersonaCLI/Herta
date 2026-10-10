import type {
  OverlayEvent,
  RecordEvent,
  ResumeEvent,
  Session,
  SessionAgentEvent,
  TurnLifecycleEvent,
} from "@herta/app-server";
import { aliasBanzhuanPlain } from "@herta/core/banzhuan-alias";
import type { Locale } from "./app-global-settings.js";

/**
 * When the user is away from the window (ADR 0072 §1): an OS notification
 * when something needs them or has finished, and the machine kept awake
 * while 板砖 runs.
 *
 * Pure: Electron stays behind `AttentionHost` (attention-electron.ts), so
 * the rules unit-test under plain Node. One watcher per ACTIVE session — it
 * subscribes beside the renderer's forwarders and stops with them, so a
 * notification always concerns the session the window shows.
 *
 * What notifies, and only while the window is not attended (hidden,
 * minimized, or not focused) and the setting is on:
 *   - an approval waiting (each request once);
 *   - a 继续 on offer;
 *   - a turn that failed (not a Stop the user pressed);
 *   - a finished turn that ran 板砖 or lasted `LONG_TURN_MS` — a quick
 *     chat reply the user glanced away from is not worth a toast.
 * A turn that ends with a 继续 on offer notifies the offer only: the offer
 * is checked after the turn ends (session.ts, `refreshResumable`), so the
 * reply notice waits `RESUME_SETTLE_MS` and yields to an offer that arrives.
 */

export interface AttentionPrefs {
  /** OS notifications while the window is not attended. */
  readonly notifications: boolean;
  /** Keep the machine from sleeping while 板砖 runs. */
  readonly keepAwake: boolean;
}

export const DEFAULT_ATTENTION_PREFS: AttentionPrefs = {
  notifications: true,
  keepAwake: true,
};

export type AttentionKind = "approval" | "resume" | "failed" | "reply";

export interface AttentionNotice {
  readonly kind: AttentionKind;
  readonly title: string;
  readonly body: string;
}

export interface AttentionHost {
  /** The user is looking at the window: visible, not minimized, focused. */
  attended(): boolean;
  /** Read at every event, so a toggle applies to the next one. */
  prefs(): AttentionPrefs;
  /** The UI language the notices are written in. */
  locale(): Locale;
  notify(notice: AttentionNotice): void;
  /** Keep the machine awake until the returned release is called. */
  holdAwake(): () => void;
  /** Take back every notice still on screen (the watcher stopped: the
   *  window shows another session, or none). */
  dismiss?(): void;
  /** Timer seam (tests). Returns the cancel. */
  setTimer?(fn: () => void, ms: number): () => void;
  /** Clock seam (tests). */
  now?(): number;
}

/** A finished turn this long notifies even without a 板砖 run. */
export const LONG_TURN_MS = 30_000;
/** How long a reply notice waits for a 继续 offer to replace it. */
export const RESUME_SETTLE_MS = 800;
const BODY_MAX_CHARS = 120;

interface AttentionLabels {
  readonly app: string;
  readonly approval: string;
  readonly resume: string;
  readonly failed: string;
  readonly reply: string;
}

/** Main-process copies, like trayLabels: the renderer's catalog is not
 *  importable here. Formal register (UI copy); Herta's own words in a reply
 *  notice are hers. */
export function attentionLabels(locale: Locale): AttentionLabels {
  if (locale === "zh") {
    return {
      app: "黑塔",
      approval: "有一项操作正在等待批准。",
      resume: "板砖的上一次运行已中断，可以继续。",
      failed: "这一轮回复未能完成。",
      reply: "黑塔已回复。",
    };
  }
  return {
    app: "Herta",
    approval: "An operation is waiting for approval.",
    resume: "Brick's last run was interrupted and can be continued.",
    failed: "This reply could not be completed.",
    reply: "Herta has replied.",
  };
}

/**
 * The body of a reply notice: her last line of speech, prose only — a code
 * fence is left out (the code cards carry no copy affordance either,
 * HertaBubble.tsx) — one line, clipped. "" when nothing is left.
 */
export function replyExcerpt(text: string, lang: "zh" | "en"): string {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (prose.length === 0) return "";
  const shown = aliasBanzhuanPlain(prose, lang);
  const cps = [...shown];
  return cps.length <= BODY_MAX_CHARS
    ? shown
    : `${cps.slice(0, BODY_MAX_CHARS - 1).join("")}…`;
}

export function watchAttention(
  session: Session,
  host: AttentionHost,
): () => void {
  const setTimer =
    host.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  const now = host.now ?? Date.now;
  let live = true;
  const iterators: AsyncIterator<unknown>[] = [];

  // The turn in progress.
  let turnStartedAt: number | null = null;
  let ranBackend = false;
  let lastSpeech = "";
  let cancelReply: (() => void) | null = null;
  const notifiedRequests = new Set<string>();

  // Keep-awake: held while 板砖 runs.
  let releaseAwake: (() => void) | null = null;
  const awake = (on: boolean): void => {
    if (on && releaseAwake === null && host.prefs().keepAwake) {
      releaseAwake = host.holdAwake();
    } else if (!on && releaseAwake !== null) {
      releaseAwake();
      releaseAwake = null;
    }
  };

  // A watcher started mid-run — the window re-pointed after a reload, a
  // resync — saw no turn.started: the session's own state seeds it, so the
  // hold and the reply notice do not depend on having been there at the
  // start (review 2026-09-30).
  if (session.turnInFlight) turnStartedAt = now();
  if (session.backendActive === true) {
    ranBackend = true;
    awake(true);
  }

  const title = (): string => {
    const t = (session.title ?? "").trim();
    return t.length > 0
      ? aliasBanzhuanPlain(t, session.lang)
      : attentionLabels(host.locale()).app;
  };
  const send = (kind: AttentionKind, body: string): void => {
    if (!live || !host.prefs().notifications || host.attended()) return;
    host.notify({ kind, title: title(), body });
  };
  const dropReply = (): void => {
    cancelReply?.();
    cancelReply = null;
  };

  async function pump<T>(
    it: AsyncIterable<T>,
    on: (value: T) => void,
  ): Promise<void> {
    const iterator = it[Symbol.asyncIterator]();
    iterators.push(iterator);
    while (true) {
      const r = await iterator.next();
      if (r.done === true || !live) break;
      try {
        on(r.value);
      } catch {
        // observation must not break the stream it observes
      }
    }
  }

  void pump<TurnLifecycleEvent>(session.subscribeTurnLifecycle(), (e) => {
    // A composer prediction follows a turn's `finished`; it ends nothing.
    if (e.kind === "predicted") return;
    const labels = attentionLabels(host.locale());
    if (e.kind === "started") {
      dropReply();
      turnStartedAt = now();
      ranBackend = false;
      lastSpeech = "";
      return;
    }
    awake(false);
    const long =
      turnStartedAt !== null && now() - turnStartedAt >= LONG_TURN_MS;
    turnStartedAt = null;
    if (e.kind === "failed") {
      if (e.error.code !== "AbortError") send("failed", labels.failed);
      return;
    }
    if (!ranBackend && !long) return;
    const body = replyExcerpt(lastSpeech, session.lang) || labels.reply;
    dropReply();
    cancelReply = setTimer(() => {
      cancelReply = null;
      send("reply", body);
    }, RESUME_SETTLE_MS);
  });

  void pump<SessionAgentEvent>(session.subscribeAgentEvents(), (e) => {
    if (e.kind !== "agent" || e.event.layer !== "backend") return;
    if (e.event.type === "turn.started") {
      ranBackend = true;
      awake(true);
    } else if (
      e.event.type === "turn.finished" ||
      e.event.type === "turn.failed"
    ) {
      awake(false);
    }
  });

  void pump<RecordEvent>(session.subscribeRecord(), (e) => {
    if (e.kind !== "block") return;
    const b = e.block;
    if (b.kind === "herta" && b.surface === "speech") lastSpeech = b.text;
  });

  void pump<OverlayEvent>(session.subscribeOverlay(), (e) => {
    if (e.kind !== "pending" || e.overlay.kind === "idle") return;
    const id = e.overlay.requestId;
    if (notifiedRequests.has(id)) return;
    notifiedRequests.add(id);
    send("approval", attentionLabels(host.locale()).approval);
  });

  if (session.subscribeResume !== undefined) {
    void pump<ResumeEvent>(session.subscribeResume(), (e) => {
      if (e.kind !== "offer" || !e.resumable) return;
      // The offer says more than "she replied": it replaces a waiting reply.
      dropReply();
      send("resume", attentionLabels(host.locale()).resume);
    });
  }

  return () => {
    live = false;
    dropReply();
    awake(false);
    // A notice still on screen concerns the session the window showed when
    // it was sent; the window may show another now (review 2026-09-30).
    host.dismiss?.();
    for (const it of iterators) void it.return?.().catch(() => undefined);
  };
}
