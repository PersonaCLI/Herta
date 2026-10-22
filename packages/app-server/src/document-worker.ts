import {
  type DocumentFormat,
  type ExtractedDocument,
  type ExtractOptions,
  extractDocumentText,
} from "./document-text.js";

/**
 * Reading a document off the main thread (owner, 2026-10-16). pdfjs runs on
 * an in-process "fake worker" whose messages are microtasks, so in the
 * desktop app a page's operator list — every image it draws, decoded — ran
 * as one uninterrupted stretch of the main process: one page of 40 photos at
 * 3.6 MP held it 3.1 s (release review 2026-10-13), and nothing capped a page
 * of more. The 2026-10-01 pick was a decode ceiling over a background thread
 * (ADR 0038's PDF-pictures amendment); a ceiling bounds one image, not a
 * page, and a budget for the whole document could not tell a crowded page
 * from pictures spread one a page. So the desktop reads documents in a
 * worker thread: the same `extractDocumentText`, on a thread of its own.
 *
 * The host installs the worker-backed reader (`setDocumentExtractor`);
 * without one — the CLI, the tests — `extractDocument` reads in-process, as
 * before.
 */
export type DocumentExtractor = (
  format: DocumentFormat,
  bytes: Uint8Array,
  opts: ExtractOptions,
) => Promise<ExtractedDocument>;

let installed: DocumentExtractor | null = null;

/** Install the process's document reader (null: back to in-process). */
export function setDocumentExtractor(
  extractor: DocumentExtractor | null,
): void {
  installed = extractor;
}

/** Read a document with the installed reader, or in-process. */
export function extractDocument(
  format: DocumentFormat,
  bytes: Uint8Array,
  opts: ExtractOptions = {},
): Promise<ExtractedDocument> {
  return (installed ?? extractDocumentText)(format, bytes, opts);
}

/** One request: the options that cross a thread (the progress hook does
 *  not; it comes back as `page` replies). */
interface ExtractRequest {
  readonly id: number;
  readonly format: DocumentFormat;
  readonly bytes: Uint8Array;
  readonly lang?: ExtractOptions["lang"];
  readonly pictures?: boolean;
  readonly maxPages?: number;
}

type ExtractReply =
  | {
      /** The worker's module loaded and it is listening (sent once, first). */
      readonly kind: "ready";
    }
  | {
      readonly id: number;
      readonly kind: "page";
      readonly done: number;
      readonly total: number;
    }
  | {
      readonly id: number;
      readonly kind: "done";
      readonly result: ExtractedDocument;
    };

/** The slice of a `MessagePort` (the worker's `parentPort`) or a `Worker`
 *  this module uses. Structural, so a test can hand over a `MessageChannel`
 *  port. */
export interface DocumentPort {
  postMessage(value: unknown, transfer?: readonly ArrayBuffer[]): void;
  on(event: "message", listener: (value: unknown) => void): unknown;
}

/** The worker's side: answers every request on `port`. Never throws — the
 *  reader's own contract — so every request gets its `done`. Says `ready`
 *  first, so the host can tell a worker that never started from one that
 *  fell over on a document. */
export function serveDocumentExtraction(port: DocumentPort): void {
  port.postMessage({ kind: "ready" });
  port.on("message", (value) => {
    const req = value as ExtractRequest;
    void extractDocumentText(req.format, req.bytes, {
      ...(req.lang !== undefined ? { lang: req.lang } : {}),
      ...(req.pictures !== undefined ? { pictures: req.pictures } : {}),
      ...(req.maxPages !== undefined ? { maxPages: req.maxPages } : {}),
      onPage: (done, total) =>
        port.postMessage({ id: req.id, kind: "page", done, total }),
    })
      .catch((): ExtractedDocument => ({ ok: false, reason: "parse_error" }))
      .then((result) => port.postMessage({ id: req.id, kind: "done", result }));
  });
}

/** The slice of a `node:worker_threads` Worker the host side uses. */
export interface DocumentWorker extends DocumentPort {
  on(event: "message", listener: (value: unknown) => void): unknown;
  on(event: "error", listener: (err: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  unref?(): void;
  terminate(): Promise<number>;
}

/** How long a worker holding documents may say nothing — no page, no
 *  answer — before it is taken for stuck (release review 2026-10-22). A page
 *  of 40 photos took 3 s; this is far past any page. */
export const DOCUMENT_STALL_MS = 60_000;

/**
 * The host's side: a reader that sends each document to a worker, started
 * on the first one.
 *
 * - A worker that dies (an error, an exit) after it said `ready` answers what
 *   it held with `parse_error` — the document that took it down is not read
 *   again on the main thread — and the next document starts a new one.
 * - A worker that dies BEFORE `ready` never started: its module did not load
 *   (a packaging fault, an antivirus quarantine). What it held, and every
 *   later document, goes to the in-process reader, so attaching never stops
 *   working. `new Worker` reports that failure as an `error` event, not a
 *   throw — the throw is caught too (release review 2026-10-22: only the
 *   throw was, so such a worker answered every document 读取失败).
 * - A worker that holds documents and says nothing for `stallMs` is stuck on
 *   one: it is ended, what it held answers `parse_error`, and the next
 *   document starts a new one. Before, every later document waited behind
 *   it until the app quit.
 */
export function workerDocumentExtractor(
  start: () => DocumentWorker,
  opts: { readonly stallMs?: number } = {},
): {
  readonly extract: DocumentExtractor;
  readonly close: () => Promise<void>;
} {
  const stallMs = opts.stallMs ?? DOCUMENT_STALL_MS;
  let worker: DocumentWorker | null = null;
  /** No worker could start: the in-process reader from here on. */
  let broken = false;
  let nextId = 0;
  const pending = new Map<
    number,
    {
      readonly resolve: (result: ExtractedDocument) => void;
      readonly format: DocumentFormat;
      readonly bytes: Uint8Array;
      readonly opts: ExtractOptions;
    }
  >();
  let stall: ReturnType<typeof setTimeout> | null = null;
  const quiet = (): void => {
    if (stall !== null) clearTimeout(stall);
    stall = null;
  };
  /** (Re)start the stall clock while the current worker holds documents. */
  const watch = (): void => {
    quiet();
    const w = worker;
    if (w === null || pending.size === 0) return;
    stall = setTimeout(() => {
      if (worker !== w) return;
      failAll();
      void w.terminate().catch(() => undefined);
    }, stallMs);
    (stall as { unref?: () => void }).unref?.();
  };
  const failAll = (): void => {
    worker = null;
    quiet();
    for (const p of pending.values())
      p.resolve({ ok: false, reason: "parse_error" });
    pending.clear();
  };
  const inProcess = (
    format: DocumentFormat,
    bytes: Uint8Array,
    o: ExtractOptions,
  ): Promise<ExtractedDocument> =>
    extractDocumentText(format, bytes, o).catch(
      (): ExtractedDocument => ({ ok: false, reason: "parse_error" }),
    );
  /** The worker never started: what it held goes to the in-process reader,
   *  and so does everything after it. */
  const fallBack = (): void => {
    broken = true;
    worker = null;
    quiet();
    const held = [...pending.values()];
    pending.clear();
    for (const p of held)
      void inProcess(p.format, p.bytes, p.opts).then(p.resolve);
  };
  const ensure = (): DocumentWorker => {
    if (worker !== null) return worker;
    const w = start();
    let ready = false;
    const died = (): void => {
      if (worker !== w) return;
      if (ready) failAll();
      else fallBack();
    };
    w.on("message", (value) => {
      if (worker !== w) return;
      const reply = value as ExtractReply;
      watch();
      if (reply.kind === "ready") {
        ready = true;
        return;
      }
      const p = pending.get(reply.id);
      if (p === undefined) return;
      if (reply.kind === "page") {
        try {
          p.opts.onPage?.(reply.done, reply.total);
        } catch {
          // A display hook failing is not an extraction failing.
        }
        return;
      }
      pending.delete(reply.id);
      if (pending.size === 0) quiet();
      p.resolve(withBuffers(reply.result));
    });
    w.on("error", died);
    w.on("exit", died);
    // The worker never keeps the process alive; a request in flight is the
    // main process's own business.
    w.unref?.();
    worker = w;
    return w;
  };
  const extract: DocumentExtractor = (format, bytes, opts) => {
    if (broken) return inProcess(format, bytes, opts);
    let w: DocumentWorker;
    try {
      w = ensure();
    } catch {
      broken = true;
      return inProcess(format, bytes, opts);
    }
    nextId += 1;
    const id = nextId;
    // A copy the worker owns: the caller keeps the original for its hash —
    // and for the in-process reader, should the worker never start.
    const copy = new Uint8Array(bytes);
    return new Promise<ExtractedDocument>((resolve) => {
      pending.set(id, { resolve, format, bytes, opts });
      watch();
      const req: ExtractRequest = {
        id,
        format,
        bytes: copy,
        ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
        ...(opts.pictures !== undefined ? { pictures: opts.pictures } : {}),
        ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
      };
      w.postMessage(req, [copy.buffer as ArrayBuffer]);
    });
  };
  const close = async (): Promise<void> => {
    const w = worker;
    failAll();
    if (w !== null) await w.terminate().catch(() => undefined);
  };
  return { extract, close };
}

/** A picture's PNG crosses the thread as a plain Uint8Array; the ingest
 *  reads it as a Buffer. */
function withBuffers(result: ExtractedDocument): ExtractedDocument {
  if (!result.ok || result.pictures === undefined) return result;
  return {
    ...result,
    pictures: result.pictures.map((p) => ({
      ...p,
      png: Buffer.from(p.png.buffer, p.png.byteOffset, p.png.byteLength),
    })),
  };
}
