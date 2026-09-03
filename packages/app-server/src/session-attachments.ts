import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SystemBlock, TerminalRecord } from "@herta/core";
import type { PromptLang, V2ActorDriver } from "@herta/herta";
import { digestSidecarFor } from "@herta/tools";
import {
  attachmentDirFor,
  type ImageCaptioner,
  ingestAttachment,
  MAX_ATTACHMENTS_PER_ACTION,
} from "./attachments.js";
import {
  MAX_STAGED_IMAGES,
  type StagedImage,
  StagedImageStore,
} from "./staged-images.js";
import type {
  AttachedFile,
  AttachResult,
  RemoveAttachmentResult,
  StageImagesResult,
} from "./types.js";

/**
 * The session's documents and pictures (extracted from session.ts,
 * 2026-09-03): ingesting handed-over files into the record (ADR 0033),
 * taking one back (owner 2026-08-10), the composer's staged pictures
 * (ADR 0048 §4), and the stored-copy GC when a rewind withdraws the blocks
 * that cited them (owner 2026-08-26).
 *
 * Every record write here is idle-only: `appendSystemBlock` and
 * `replaceBlockAt` are only safe between turns (audit 2026-07-10, finding
 * 13), and the session's turn gate is consulted BEFORE and AFTER every await
 * — an await yields the event loop, a turn can start in that window, and an
 * out-of-turn append landing MID-turn drops the note, rewinds the sink
 * cursor, or duplicates JSONL lines. The session owns the gate and the
 * snapshot; this module asks for both through `deps`.
 */
export interface SessionAttachmentsDeps {
  readonly sessionId: string;
  readonly lang: PromptLang;
  /** The EFFECTIVE backend workspace holder, read fresh per operation: the
   *  block's path is what 板砖 later resolves, and it resolves against the
   *  backend root. A later workspace change strands the path the same way it
   *  strands every other relative path already in the record. */
  readonly wsHolder: { readonly current: string };
  /** The image-captioning instrument (ADR 0048); null = images are stored
   *  but not read (no key, tests, a failed call). */
  readonly captionImage: ImageCaptioner | null;
  readonly turnInFlight: () => boolean;
  readonly driver: Pick<
    V2ActorDriver,
    "getRecord" | "appendSystemBlock" | "replaceBlockAt"
  >;
  /** Blocks were APPENDED between turns: refresh the session's snapshot. */
  readonly onAppended: () => void;
  /** Blocks were REPLACED in place (a take-back): refresh the snapshot,
   *  re-seed the sink and push the corrected record to the renderer. */
  readonly onReplaced: () => void;
}

export class SessionAttachments {
  /** Pictures waiting in the composer (ADR 0048 §4) — stored and captioning,
   *  but not in the record until the message they belong to is sent. */
  private readonly staged: StagedImageStore;

  constructor(private readonly deps: SessionAttachmentsDeps) {
    this.staged = new StagedImageStore({
      // Reads the holder fresh: a workspace change between staging and send
      // must not delete (or fail to find) a copy under the old root.
      workspaceRoot: () => deps.wsHolder.current,
      sessionId: deps.sessionId,
      lang: deps.lang,
      caption: () => deps.captionImage,
    });
  }

  /**
   * Stage pictures in the composer (ADR 0048 §4) — stored and captioned now,
   * appended to the record only when the message is sent.
   *
   * Idle-only, like `attachFiles` and for a weaker but real version of the
   * same reason: nothing is appended here, but a staged image is meant to
   * ride the NEXT message, and mid-turn there is no next message to ride.
   *
   * Non-images come back as `not_image` rather than being stored — documents
   * ingest immediately through `attachFiles`, which is their own UX and stays
   * unchanged (ADR 0048 §4).
   */
  async stageImages(
    inputs: readonly {
      readonly path?: string;
      readonly bytes?: Uint8Array;
      readonly name?: string;
    }[],
  ): Promise<StageImagesResult> {
    if (this.deps.turnInFlight()) {
      return { ok: false, reason: "turn_in_progress" };
    }
    if (inputs.length === 0) return { ok: false, reason: "no_files" };
    // The per-MESSAGE picture cap (owner 2026-08-27): what is already staged
    // plus this batch. Tighter than the per-action attachment cap, so it is
    // the only ceiling staging can hit.
    if (inputs.length + this.staged.size > MAX_STAGED_IMAGES) {
      return { ok: false, reason: "too_many_images" };
    }
    const staged: StagedImage[] = [];
    const rejected: { readonly name: string; readonly reason: string }[] = [];
    for (const input of inputs) {
      const displayName =
        input.name ?? (input.path !== undefined ? basename(input.path) : "");
      if (displayName === "") {
        rejected.push({ name: "", reason: "read_error" });
        continue;
      }
      const result = await this.staged.stage({
        ...(input.path !== undefined ? { sourcePath: input.path } : {}),
        ...(input.bytes !== undefined
          ? { bytes: Buffer.from(input.bytes) }
          : {}),
        displayName,
      });
      if (result.ok) staged.push(result.image);
      else rejected.push({ name: displayName, reason: result.reason });
    }
    return { ok: true, staged, rejected };
  }

  /** Drop a staged image and delete its stored copy. Nothing reached the
   *  record, so nothing is left behind to explain. */
  unstageImage(id: string): Promise<boolean> {
    return this.staged.unstage(id);
  }

  /** What is currently waiting in the composer — for a renderer that
   *  reconnects (reload, session switch) and needs to redraw the strip. */
  get stagedImageList(): readonly StagedImage[] {
    return this.staged.list();
  }

  /** Take the staged pictures for the message being sent (ADR 0048 §4):
   *  their blocks go in right after the user block. `commit` awaits the
   *  captions started at stage time — usually long since resolved under the
   *  user's typing. */
  commitStaged(ids: readonly string[]): Promise<readonly SystemBlock[]> {
    return this.staged.commit(ids);
  }

  /** Pictures still sitting in the composer at close never became part of
   *  anything: no record block ever mentioned them, so their stored copies
   *  are pure orphans (ADR 0048 §4). Best-effort — a copy that survives is a
   *  stray file, never a broken session. */
  clearStaged(): Promise<void> {
    return this.staged.clear();
  }

  /**
   * Ingest documents the 开拓者 handed over (ADR 0033): copy each into the
   * session's attachment directory under the EFFECTIVE backend workspace and
   * append one → 系统 block per file.
   *
   * Idle-only, same guard and rationale as setWorkspace (audit 2026-07-10,
   * finding 13): `appendSystemBlock` is only safe between turns.
   */
  async attachFiles(paths: readonly string[]): Promise<AttachResult> {
    if (this.deps.turnInFlight()) {
      return { ok: false, reason: "turn_in_progress" };
    }
    if (paths.length === 0) return { ok: false, reason: "no_files" };
    // Reject the whole action rather than ingesting a prefix: a user who
    // dropped 30 files and got 10 with no explanation would reasonably
    // believe all 30 arrived.
    if (paths.length > MAX_ATTACHMENTS_PER_ACTION) {
      return { ok: false, reason: "too_many" };
    }

    // Phase 1 — ingest (async, disk only, no record mutation). Phase 2 —
    // guard + append, all synchronous. The first cut appended inside the
    // await loop, which reopened exactly the hazard the idle-only guard
    // exists for: every await yields the event loop, submitText can start a
    // turn in that window, and an out-of-turn append lands MID-turn (dropped
    // note / rewound sink cursor / duplicate JSONL — audit 2026-07-10,
    // finding 13). setWorkspace never had this problem only because its
    // guard-to-append path contains no await; with ingest I/O in between,
    // the guard must be re-checked on the far side.
    const ingested = [];
    for (const sourcePath of paths) {
      ingested.push({
        sourcePath,
        result: await ingestAttachment({
          sourcePath,
          workspaceRoot: this.deps.wsHolder.current,
          sessionId: this.deps.sessionId,
          lang: this.deps.lang,
          captionImage: this.deps.captionImage,
        }),
      });
    }

    if (this.deps.turnInFlight()) {
      // A turn started while the files were being copied. The copies stay on
      // disk — harmless, content-hashed, and a retry of the same drop reuses
      // them byte-for-byte — but no record blocks may be appended now.
      return { ok: false, reason: "turn_in_progress" };
    }

    const files: AttachedFile[] = [];
    for (const { sourcePath, result } of ingested) {
      this.deps.driver.appendSystemBlock(result.block);
      files.push({
        name: basename(sourcePath),
        path: result.relPath,
        ...(result.unreadable !== undefined
          ? { unreadable: result.unreadable }
          : {}),
      });
    }
    this.deps.onAppended();
    return { ok: true, files };
  }

  /**
   * Take back an attached document (ADR 0033, owner 2026-08-10): delete the
   * stored file and MARK every block citing it `unreadable: "removed"`.
   *
   * Marked, not deleted. Dropping the block would shift every later index —
   * rewind, topic anchors and the sink cursor all count them — and, the real
   * reason, if Herta has already spoken about the document then erasing its
   * citation leaves her own words pointing at something that never happened.
   * The file goes; the record keeps saying one arrived and was withdrawn.
   *
   * The caller supplies a path from the RENDERER, so it is never trusted for
   * the delete: the block found by that path supplies its own harness-written
   * path, and that is re-checked against this session's attachment prefix
   * before anything is unlinked.
   *
   * Idle-only, like every other out-of-turn record write.
   */
  async removeAttachment(path: string): Promise<RemoveAttachmentResult> {
    if (this.deps.turnInFlight()) {
      return { ok: false, reason: "turn_in_progress" };
    }
    const record = this.deps.driver.getRecord();
    const targets: Array<{ index: number; block: SystemBlock }> = [];
    // A block is addressed by its text path, or — for a document whose
    // original was kept but whose text was not (a scanned PDF, an .xlsx;
    // ADR 0038 amendment) — by its source path, the only path the row has.
    const isTarget = (d: { path: string; source?: string }): boolean =>
      path.length > 0 && (d.path === path || d.source === path);
    record.forEach((b, index) => {
      if (b.kind !== "system") return;
      const d = b.digest;
      if (d?.kind !== "attachment") return;
      if (!isTarget(d)) return;
      if (d.unreadable === "removed") return; // already withdrawn
      targets.push({ index, block: b });
    });
    if (targets.length === 0) return { ok: false, reason: "not_found" };

    // Delete once, from the BLOCK's own paths, and only inside this session's
    // attachment directory — a renderer-supplied path never reaches unlink.
    const prefix = `${attachmentDirFor(this.deps.sessionId)}/`;
    const stored = targets[0]?.block.digest;
    if (stored?.kind !== "attachment")
      return { ok: false, reason: "not_found" };
    const under = (p: string | undefined): string | null =>
      p !== undefined && p.length > 0 && p.startsWith(prefix) ? p : null;
    const relPath = under(stored.path);
    // The original's copy (ADR 0038 amendment) goes with the text.
    const source = under(stored.source);
    if (relPath === null && source === null)
      return { ok: false, reason: "not_found" };
    // The outline sidecar (2026-08-23) goes with the text, under the same
    // prefix check — it is the document's own table of contents, and a
    // withdrawn document must not leave its chapter titles behind.
    const sidecar = under(stored.outline?.path);
    // …and the digest sidecar (ADR 0043), if 板砖 ever built one: same
    // directory, same prefix, derived from the text's own path.
    const toRemove = [
      ...(relPath === null ? [] : [relPath, digestSidecarFor(relPath)]),
      ...(source === null ? [] : [source]),
      ...(sidecar === null ? [] : [sidecar]),
    ];
    for (const rel of toRemove) {
      try {
        await rm(join(this.deps.wsHolder.current, ...rel.split("/")), {
          force: true,
        });
      } catch {
        // Best-effort: a file already gone (manual delete, workspace
        // switched) must not block the record from recording the withdrawal.
      }
    }

    // Guard re-check on the far side of the await — the same hole attachFiles
    // closed and this method then reintroduced: `rm` yields the event loop,
    // and a turn starting in that window would make the block replacement and
    // the sink re-seed below MID-turn mutations. Refusing here is self-healing:
    // the file is already gone, the block is not yet marked, and the retry
    // finds the same targets while `rm --force` tolerates the missing file.
    if (this.deps.turnInFlight()) {
      return { ok: false, reason: "turn_in_progress" };
    }

    for (const { index, block } of targets) {
      const d = block.digest;
      if (d?.kind !== "attachment") continue;
      // Drop the head excerpt with the file. Keeping prompt-visible content
      // for a document the user just took back would be the opposite of what
      // they asked for.
      const { evidenceDetail: _d, evidence: _e, ...rest } = block;
      // The outline citation goes too: its sidecar was just unlinked, and a
      // digest pointing at it would be a path to nothing. Same for the
      // original's copy.
      const { outline: _o, source: _s, ...digest } = d;
      this.deps.driver.replaceBlockAt(index, {
        ...rest,
        body: `附件 ${d.name} · 已移除`,
        digest: { ...digest, lines: 0, chars: 0, unreadable: "removed" },
      });
    }

    // The sink streams by a monotonic cursor and mirrors block REFERENCES, so
    // a mutation behind the cursor is invisible to it — the session re-seeds
    // with the new record (same move rewind makes after truncating), then
    // pushes the corrected record to the renderer.
    this.deps.onReplaced();
    return { ok: true, removed: targets.length };
  }

  /**
   * Garbage-collect the STORED COPIES of attachments whose record blocks a
   * rewind just withdrew (owner decision 2026-08-26, amending D-Record-only —
   * see the 2026-06-21-rewind-last-turn spec). That rule still holds for
   * 板砖's real filesystem side-effects (files it edited, commands it ran);
   * the harness's own attachment store is record-keyed bookkeeping, and a
   * copy whose citing block no longer exists is a document the user can
   * neither see nor take back — the ✕ affordance left with the row.
   *
   * Same trust shape as removeAttachment: only paths the HARNESS wrote into
   * a block's digest are deleted, re-checked against this session's
   * attachment prefix — nothing renderer-supplied reaches unlink. A path a
   * SURVIVING block still cites is kept: content-hashed names make
   * re-attaching the same document idempotent, so two blocks can share one
   * stored file. Sidecars (outline, ADR 0043 digest) go with their text,
   * exactly as the ✕ takes them.
   *
   * PICTURES are the exception (owner 2026-08-27): a withdrawn image block
   * RESTAGES into the composer strip instead of being deleted — the copy is
   * on disk, the caption is paid for, and the rewound message's pictures
   * belong with its restored draft. Returns what was restaged so the rewind
   * result can hand them to the renderer. Capped at the strip's own
   * five-picture ceiling (counting what is already staged); overflow — and
   * a path already restaged once, so two withdrawn blocks citing one legacy
   * shared file cannot mint two owners — falls back to the GC.
   */
  async cleanUpWithdrawn(
    withdrawn: TerminalRecord,
    surviving: TerminalRecord,
  ): Promise<readonly StagedImage[]> {
    const prefix = `${attachmentDirFor(this.deps.sessionId)}/`;
    const kept = new Set<string>();
    for (const b of surviving) {
      if (b.kind !== "system" || b.digest?.kind !== "attachment") continue;
      if (b.digest.path.length > 0) kept.add(b.digest.path);
    }
    const toRemove: string[] = [];
    const restaged: StagedImage[] = [];
    const restagedPaths = new Set<string>();
    for (const b of withdrawn) {
      if (b.kind !== "system" || b.digest?.kind !== "attachment") continue;
      const d = b.digest;
      if (d.unreadable === "removed") continue; // the ✕ already took the files
      if (!d.path.startsWith(prefix)) continue; // harness-written, or nothing stored
      if (kept.has(d.path)) continue;
      if (d.image !== undefined) {
        if (restagedPaths.has(d.path)) continue; // one owner per file
        if (this.staged.size < MAX_STAGED_IMAGES) {
          const img = this.staged.restage(b);
          if (img !== null) {
            restaged.push(img);
            restagedPaths.add(d.path);
            continue;
          }
        }
        // Strip full, or not restageable after all — the GC takes it.
      }
      toRemove.push(d.path, digestSidecarFor(d.path));
      const outline = d.outline?.path;
      if (outline?.startsWith(prefix) === true) {
        toRemove.push(outline);
      }
    }
    for (const rel of toRemove) {
      try {
        await rm(join(this.deps.wsHolder.current, ...rel.split("/")), {
          force: true,
        });
      } catch {
        // Best-effort, mirroring removeAttachment: a file already gone
        // (manual delete, workspace switched) must not fail the rewind
        // whose record truncation has already landed.
      }
    }
    return restaged;
  }
}
