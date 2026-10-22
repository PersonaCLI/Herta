import { MessageChannel, type MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { extractDocumentText } from "./document-text.js";
import {
  type DocumentWorker,
  extractDocument,
  serveDocumentExtraction,
  setDocumentExtractor,
  workerDocumentExtractor,
} from "./document-worker.js";
import {
  makePdf,
  type PdfPictureFixture,
} from "./testing/document-fixtures.js";

// A page with room under (a) and a small picture drawn there, as the
// extraction tests draw a handout's formula.
const underA: PdfPictureFixture = {
  at: [72, 610, 120, 40],
  width: 12,
  height: 10,
  kind: "rgb",
};
const pdf = (): Buffer =>
  makePdf([["Question 1.", "(a)", "(b)"], ["Page two"]], {
    lineGap: 60,
    pictures: [[underA], []],
  });

/** A worker stand-in over a MessageChannel: the "worker" end is served by
 *  the real `serveDocumentExtraction`, in this thread. */
function channelWorker(): {
  readonly worker: DocumentWorker;
  readonly inside: MessagePort;
  readonly die: () => void;
} {
  const { port1, port2 } = new MessageChannel();
  serveDocumentExtraction(port2);
  const exits: Array<(code: number) => void> = [];
  const worker: DocumentWorker = {
    postMessage: (value, transfer) =>
      port1.postMessage(value, transfer as ArrayBuffer[] | undefined),
    on: ((event: string, listener: (value: unknown) => void) => {
      if (event === "message") port1.on("message", listener);
      if (event === "exit") exits.push(listener as (code: number) => void);
      return worker;
    }) as DocumentWorker["on"],
    terminate: async () => {
      port1.close();
      port2.close();
      return 0;
    },
  };
  return {
    worker,
    inside: port2,
    die: () => {
      port1.close();
      port2.close();
      for (const exit of exits) exit(1);
    },
  };
}

afterEach(() => {
  setDocumentExtractor(null);
});

describe("reading a document on a worker (owner 2026-10-16)", () => {
  it("answers as the in-process reader does: the text, the pages, the pictures as Buffers, and each page's progress", async () => {
    const { worker } = channelWorker();
    const reader = workerDocumentExtractor(() => worker);
    const progress: Array<[number, number]> = [];
    const bytes = pdf();
    const r = await reader.extract("pdf", bytes, {
      pictures: true,
      lang: "en",
      onPage: (done, total) => progress.push([done, total]),
    });
    const local = await extractDocumentText("pdf", pdf(), {
      pictures: true,
      lang: "en",
    });
    expect(r.ok).toBe(true);
    if (!r.ok || !local.ok) return;
    expect(r.text).toBe(local.text);
    expect(r.pages).toBe(2);
    expect(r.pictures).toHaveLength(1);
    // The PNG crossed as a Uint8Array; the ingest reads a Buffer.
    expect(Buffer.isBuffer(r.pictures?.[0]?.png)).toBe(true);
    expect(
      r.pictures?.[0]?.png.equals(local.pictures?.[0]?.png ?? Buffer.alloc(0)),
    ).toBe(true);
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    // The caller's bytes are its own: only a copy crossed.
    expect(bytes.byteLength).toBeGreaterThan(0);
    await reader.close();
  });

  it("a worker that dies answers what it held with parse_error, and the next document starts a new one", async () => {
    const started: Array<ReturnType<typeof channelWorker>> = [];
    const reader = workerDocumentExtractor(() => {
      const w = channelWorker();
      started.push(w);
      return w.worker;
    });
    // It dies mid-document: started, and a page in.
    const held = reader.extract("pdf", pdf(), {
      onPage: () => started[0]?.die(),
    });
    expect(await held).toEqual({ ok: false, reason: "parse_error" });
    const next = await reader.extract("pdf", pdf(), {});
    expect(next.ok).toBe(true);
    expect(started).toHaveLength(2);
    await reader.close();
  });

  it("a worker that cannot start leaves the document to the in-process reader", async () => {
    const reader = workerDocumentExtractor(() => {
      throw new Error("no worker file");
    });
    const r = await reader.extract("pdf", pdf(), {});
    expect(r.ok).toBe(true);
  });

  /** A worker that never answers on its own: the test drives its events. */
  interface SilentWorker {
    readonly worker: DocumentWorker;
    readonly emit: (
      event: "message" | "error" | "exit",
      value: unknown,
    ) => void;
    terminated: number;
  }
  function silentWorker(): SilentWorker {
    const listeners = new Map<string, Array<(v: unknown) => void>>();
    const worker = {
      postMessage: () => undefined,
      on: ((event: string, listener: (v: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return worker;
      }) as DocumentWorker["on"],
      terminate: async () => {
        handle.terminated += 1;
        return 0;
      },
    } as DocumentWorker;
    const handle: SilentWorker = {
      worker,
      terminated: 0,
      emit: (event, value) => {
        for (const l of listeners.get(event) ?? []) l(value);
      },
    };
    return handle;
  }

  it("a worker whose file never loads — an error event before it is ready, not a throw — leaves what it held, and every later document, to the in-process reader (release review 2026-10-22)", async () => {
    const started: Array<ReturnType<typeof silentWorker>> = [];
    const reader = workerDocumentExtractor(() => {
      const w = silentWorker();
      started.push(w);
      return w.worker;
    });
    const held = reader.extract("pdf", pdf(), {});
    started[0]?.emit("error", new Error("Cannot find module"));
    started[0]?.emit("exit", 1);
    expect((await held).ok).toBe(true);
    expect((await reader.extract("pdf", pdf(), {})).ok).toBe(true);
    expect(started).toHaveLength(1);
    await reader.close();
  });

  it("a worker that holds a document and says nothing for the stall time is ended; what it held answers parse_error, and the next document starts a new one (release review 2026-10-22)", async () => {
    const started: Array<ReturnType<typeof silentWorker>> = [];
    const reader = workerDocumentExtractor(
      () => {
        const w = silentWorker();
        started.push(w);
        return w.worker;
      },
      { stallMs: 40 },
    );
    const stuck = reader.extract("pdf", pdf(), {});
    started[0]?.emit("message", { kind: "ready" });
    expect(await stuck).toEqual({ ok: false, reason: "parse_error" });
    expect(started[0]?.terminated).toBe(1);
    const next = reader.extract("pdf", pdf(), {});
    expect(started).toHaveLength(2);
    // A page keeps the clock from running out; the answer stops it.
    started[1]?.emit("message", { kind: "ready" });
    await new Promise((r) => setTimeout(r, 25));
    started[1]?.emit("message", { id: 2, kind: "page", done: 1, total: 2 });
    await new Promise((r) => setTimeout(r, 25));
    started[1]?.emit("message", {
      id: 2,
      kind: "done",
      result: { ok: true, text: "x", pages: 2 },
    });
    expect((await next).ok).toBe(true);
    expect(started[1]?.terminated).toBe(0);
    await reader.close();
  });

  it("the ingest reads through the installed reader, and in-process without one", async () => {
    const seen: string[] = [];
    setDocumentExtractor(async (format) => {
      seen.push(format);
      return { ok: false, reason: "unsupported" };
    });
    expect(await extractDocument("pdf", pdf())).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(seen).toEqual(["pdf"]);
    setDocumentExtractor(null);
    expect((await extractDocument("pdf", pdf())).ok).toBe(true);
  });
});
