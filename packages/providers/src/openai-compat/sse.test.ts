import { describe, expect, it } from "vitest";
import { parseSSE } from "./sse.js";

function streamFrom(
  chunks: (string | Uint8Array)[],
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      }
      controller.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("parseSSE", () => {
  it("parses simple data lines, stops on [DONE]", async () => {
    const stream = streamFrom([
      `data: {"a":1}\n\n`,
      `data: {"a":2}\n\n`,
      `data: [DONE]\n\n`,
      `data: {"a":3}\n\n`,
    ]);
    const ctl = new AbortController();
    const events = await collect(parseSSE(stream, ctl.signal));
    expect(events).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("handles UTF-8 multi-byte split across chunk boundaries", async () => {
    const enc = new TextEncoder();
    const full = enc.encode(`data: {"t":"你好"}\n\ndata: [DONE]\n\n`);
    // Split right after the first byte of 你 (0xE4) — ensures the decoder must
    // buffer across the chunk boundary to avoid corruption.
    const split = full.indexOf(0xe4) + 1;
    const stream = streamFrom([full.subarray(0, split), full.subarray(split)]);
    const ctl = new AbortController();
    const events = await collect(parseSSE(stream, ctl.signal));
    expect(events).toEqual([{ t: "你好" }]);
  });

  it("ignores comment lines (leading colon) and unknown prefixes", async () => {
    const stream = streamFrom([
      `: keepalive\n`,
      `event: foo\n`,
      `data: {"ok":true}\n\n`,
      `data: [DONE]\n\n`,
    ]);
    const ctl = new AbortController();
    const events = await collect(parseSSE(stream, ctl.signal));
    expect(events).toEqual([{ ok: true }]);
  });

  it("handles CRLF line endings", async () => {
    const stream = streamFrom([`data: {"x":1}\r\n\r\ndata: [DONE]\r\n\r\n`]);
    const ctl = new AbortController();
    const events = await collect(parseSSE(stream, ctl.signal));
    expect(events).toEqual([{ x: 1 }]);
  });

  it("yields nothing on empty stream", async () => {
    const stream = streamFrom([]);
    const ctl = new AbortController();
    const events = await collect(parseSSE(stream, ctl.signal));
    expect(events).toEqual([]);
  });

  it("throws AbortError when signal aborts mid-stream", async () => {
    const ctl = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        controller.enqueue(new TextEncoder().encode(`data: {"a":1}\n\n`));
        ctl.abort();
        await new Promise((r) => setTimeout(r, 5));
        controller.enqueue(new TextEncoder().encode(`data: {"a":2}\n\n`));
        controller.close();
      },
    });
    await expect(collect(parseSSE(stream, ctl.signal))).rejects.toThrow();
  });

  it("throws ProviderError on malformed JSON in a data line", async () => {
    const stream = streamFrom([`data: {not-json}\n\ndata: [DONE]\n\n`]);
    const ctl = new AbortController();
    await expect(collect(parseSSE(stream, ctl.signal))).rejects.toThrow(
      /sse|json/i,
    );
  });

  it("throws ProviderError{stall} when the stream goes silent past the idle deadline", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(`data: {"a":1}\n\n`));
        // Never enqueue again, never close — a provider that accepted the
        // request and then went silent (hang audit 2026-07-09, H1).
      },
    });
    const ctl = new AbortController();
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const v of parseSSE(stream, ctl.signal, {
          idleTimeoutMs: 25,
        })) {
          seen.push(v);
        }
      })(),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "stall",
      retryable: false,
    });
    // Bytes that arrived before the stall were consumed normally.
    expect(seen).toEqual([{ a: 1 }]);
  });

  it("wraps a raw mid-body transport error in ProviderError{network}", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc.encode(`data: {"a":1}\n\n`));
        // Socket cut mid-body: undici surfaces this as a raw TypeError
        // rejection out of reader.read() (E2E-4 X6b, 2026-07-19).
        controller.error(new TypeError("terminated"));
      },
    });
    const ctl = new AbortController();
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const v of parseSSE(stream, ctl.signal)) seen.push(v);
      })(),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "network",
      retryable: false,
      message: expect.stringContaining("stream terminated mid-response"),
    });
    // Bytes that arrived before the cut were consumed normally.
    expect(seen).toEqual([{ a: 1 }]);
  });

  it("lets an AbortError read rejection through unwrapped (user interrupt)", async () => {
    const abortErr = new Error("This operation was aborted");
    abortErr.name = "AbortError";
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(abortErr);
      },
    });
    const ctl = new AbortController();
    await expect(collect(parseSSE(stream, ctl.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("does not stall while bytes keep arriving within the idle window", async () => {
    const enc = new TextEncoder();
    // 5 chunks with ~15ms gaps: total wall time (~75ms) exceeds the 50ms
    // window, but each inter-chunk gap is inside it — keep-alive comment
    // bytes reset the watchdog, so the stream completes.
    const chunks = [
      `: keepalive\n`,
      `: keepalive\n`,
      `: keepalive\n`,
      `data: {"ok":true}\n\n`,
      `data: [DONE]\n\n`,
    ];
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 15));
        const c = chunks[i];
        i += 1;
        if (c === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(c));
      },
    });
    const ctl = new AbortController();
    const events = await collect(
      parseSSE(stream, ctl.signal, { idleTimeoutMs: 50 }),
    );
    expect(events).toEqual([{ ok: true }]);
  });
});

describe("parseSSE — a 200 that is not a stream (review 2026-11-10)", () => {
  const html =
    "<!DOCTYPE html>\n<html><head><title>Sign in to the network</title></head>\n<body>portal</body></html>\n";

  it("a page where a stream was expected is an error, not an empty answer", async () => {
    const ctl = new AbortController();
    await expect(
      collect(parseSSE(streamFrom([html]), ctl.signal)),
    ).rejects.toMatchObject({
      name: "ProviderError",
      code: "sse",
      retryable: true,
      message: expect.stringContaining("not an event stream: <!DOCTYPE html>"),
    });
  });

  it("so is a JSON error sent as one line with no line break", async () => {
    const ctl = new AbortController();
    await expect(
      collect(
        parseSSE(
          streamFrom(['{"error":{"message":"upstream ', 'unavailable"}}']),
          ctl.signal,
        ),
      ),
    ).rejects.toMatchObject({
      code: "sse",
      message: expect.stringContaining('{"error":{"message":"upstream'),
    });
  });

  it("the message carries a short single line of what came", async () => {
    const ctl = new AbortController();
    const page = `<html>\n${"<p>x</p>\t  ".repeat(200)}\n`;
    const err = await collect(parseSSE(streamFrom([page]), ctl.signal)).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    const shown = (err as Error).message.split("event stream: ")[1] ?? "";
    expect(shown).toBe("<html>");
  });

  it("a stream that only kept alive is still an empty one", async () => {
    const ctl = new AbortController();
    const events = await collect(
      parseSSE(streamFrom([": keepalive\n\n", ": keepalive\n\n"]), ctl.signal),
    );
    expect(events).toEqual([]);
  });

  it("a stray line among real events is still ignored", async () => {
    const ctl = new AbortController();
    const events = await collect(
      parseSSE(
        streamFrom([
          "garbage\n\n",
          `data: {"ok":true}\n\n`,
          "data: [DONE]\n\n",
        ]),
        ctl.signal,
      ),
    );
    expect(events).toEqual([{ ok: true }]);
  });

  it("a stray line before [DONE] is not an error either", async () => {
    const ctl = new AbortController();
    const events = await collect(
      parseSSE(streamFrom(["garbage\n\n", "data: [DONE]\n\n"]), ctl.signal),
    );
    expect(events).toEqual([]);
  });

  it("a body with no blank line in it is not held whole", async () => {
    // Never closes: without the bound the parser would wait for its end.
    const enc = new TextEncoder();
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(enc.encode("x".repeat(8_192)));
      },
    });
    const ctl = new AbortController();
    await expect(collect(parseSSE(endless, ctl.signal))).rejects.toMatchObject({
      code: "sse",
      retryable: true,
    });
    expect(sent).toBeLessThan(20);
  });
});
