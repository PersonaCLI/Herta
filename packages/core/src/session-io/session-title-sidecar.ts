import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../atomic-write.js";

/**
 * One entry of the session's TOPIC history (2026-07-12, topic rail): every
 * time the periodic retitle produced a DIFFERENT title, the conversation had
 * drifted — the new title plus the record index (and text) of the first user
 * message of the window that produced it marks where the topic began. The
 * rail renders these as jump targets; labels come from the titles the app
 * already generates, so the history costs no extra model calls.
 */
export interface SessionTopic {
  readonly title: string;
  /** Absolute record index of the topic's anchoring USER block. */
  readonly anchorIndex: number;
  /** The anchoring user message, truncated — the rail card's preview line
   *  (self-contained: the block itself may not be loaded in the renderer's
   *  window). */
  readonly anchorText: string;
  readonly at: string;
  /**
   * Record length when this topic came into being — i.e. how much
   * conversation had to exist for the retitle that created it to happen.
   * A rewind that shrinks the record below this withdrew that very turn, so
   * the topic never happened either (see `pruneTopics`).
   *
   * Distinct from `anchorIndex`, and that distinction IS the bug it fixes
   * (user 2026-07-30): the anchor is the title WINDOW's first user block,
   * which on a re-entry retitle is an OLD message — it survives the rewind,
   * so anchor-liveness alone left a rail tick for a topic whose defining
   * turn was gone. Optional: sidecars written before 2026-07-30 have no
   * value, and those fall back to anchor-liveness (the old behaviour).
   */
  readonly bornAtLength?: number;
}

/**
 * Sidecar file holding a generated session title, written next to the
 * transcript JSONL: `<transcriptDir>/<sessionId>.title.json`. Kept separate
 * from the append-only transcript so the title can be (re)written once after
 * the first turn without rewriting the record header. Best-effort: callers
 * treat read failures as "no title yet". Since 2026-07-12 it also carries
 * the topic history (optional — pre-topic sidecars simply have none).
 */
interface TitleSidecar {
  readonly version: 1;
  readonly title: string;
  readonly generatedAt: string;
  readonly topics?: readonly SessionTopic[];
}

function sidecarPath(transcriptDir: string, sessionId: string): string {
  return join(transcriptDir, `${sessionId}.title.json`);
}

export function writeSessionTitle(
  transcriptDir: string,
  sessionId: string,
  title: string,
  topics?: readonly SessionTopic[],
): void {
  mkdirSync(transcriptDir, { recursive: true });
  const payload: TitleSidecar = {
    version: 1,
    title,
    generatedAt: new Date().toISOString(),
    ...(topics !== undefined && topics.length > 0 ? { topics } : {}),
  };
  // Atomic (audit BL7). A torn write here is not recoverable by
  // regeneration: `synthesizeInitialTopic` can only ever make ONE entry, so a
  // half-written sidecar erases the topic rail for that session permanently.
  writeFileAtomicSync(
    sidecarPath(transcriptDir, sessionId),
    `${JSON.stringify(payload)}\n`,
  );
}

function readSidecar(
  transcriptDir: string,
  sessionId: string,
): Partial<TitleSidecar> | null {
  let raw: string;
  try {
    raw = readFileSync(sidecarPath(transcriptDir, sessionId), "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as Partial<TitleSidecar>;
  } catch {
    return null; // malformed sidecar — treat as "no title"
  }
}

export function readSessionTitle(
  transcriptDir: string,
  sessionId: string,
): string | undefined {
  const parsed = readSidecar(transcriptDir, sessionId);
  if (
    parsed !== null &&
    parsed.version === 1 &&
    typeof parsed.title === "string"
  ) {
    return parsed.title;
  }
  return undefined;
}

/** The persisted topic history, [] when absent/malformed. Entries are
 *  validated individually — a bad one is dropped, not the whole list. */
export function readSessionTopics(
  transcriptDir: string,
  sessionId: string,
): SessionTopic[] {
  const parsed = readSidecar(transcriptDir, sessionId);
  if (parsed === null || parsed.version !== 1 || !Array.isArray(parsed.topics))
    return [];
  return parsed.topics.filter((t): t is SessionTopic => {
    if (typeof t !== "object" || t === null) return false;
    const topic = t as SessionTopic;
    // `bornAtLength` is optional (absent in pre-2026-07-30 sidecars), but a
    // PRESENT one must be a sane integer — a garbage value would prune live
    // topics rather than dead ones, so a bad entry is dropped like any other.
    const born = topic.bornAtLength;
    if (born !== undefined && (!Number.isInteger(born) || born < 0))
      return false;
    return (
      typeof topic.title === "string" &&
      Number.isInteger(topic.anchorIndex) &&
      topic.anchorIndex >= 0 &&
      typeof topic.anchorText === "string" &&
      typeof topic.at === "string"
    );
  });
}
