import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./minimax-api.js";
import { createMiniMaxSynthesizer } from "./minimax-synthesizer.js";

const REQ = {
  utteranceId: "u1",
  seq: 0,
  text: "第一句。",
  lang: "zh" as const,
};

function pcmHex(samples: number[]): string {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => {
    b.writeInt16LE(s, i * 2);
  });
  return b.toString("hex");
}

/** A fake t2a_v2 that answers after `delayMs`, honouring the abort signal. */
function fakeT2a(opts: {
  samples?: number[];
  delayMs?: number;
  status?: { code: number; msg: string };
}): { fetch: FetchLike; calls: number } {
  const state = { calls: 0 };
  const fetch: FetchLike = (_url, init) =>
    new Promise((resolve, reject) => {
      state.calls += 1;
      const done = (): void => {
        const body =
          opts.status !== undefined
            ? {
                base_resp: {
                  status_code: opts.status.code,
                  status_msg: opts.status.msg,
                },
              }
            : {
                base_resp: { status_code: 0, status_msg: "success" },
                data: { audio: pcmHex(opts.samples ?? [1, 2, 3]), status: 2 },
                extra_info: { usage_characters: 7 },
              };
        resolve(new Response(JSON.stringify(body), { status: 200 }));
      };
      const t = setTimeout(done, opts.delayMs ?? 0);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  return {
    fetch,
    get calls() {
      return state.calls;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createMiniMaxSynthesizer", () => {
  it("available() needs the toggle, a key and a voice; synthesize returns PCM with the effect applied", async () => {
    const t2a = fakeT2a({ samples: [1000, -1000] });
    let enabled = true;
    let key: string | null = "k";
    let voice: { voiceId: string; host: string } | null = {
      voiceId: "v1",
      host: "https://h",
    };
    const used: number[] = [];
    const synth = createMiniMaxSynthesizer({
      fetch: t2a.fetch,
      key: () => key,
      voice: () => voice,
      enabled: () => enabled,
      applyEffect: (f) => f.map((x) => x / 2),
      onUsed: (n) => used.push(n),
      log: () => undefined,
    });
    expect(synth.available()).toBe(true);
    const out = await synth.synthesize(REQ);
    expect(out).not.toBeNull();
    expect([...(out as { samples: Int16Array }).samples]).toEqual([500, -500]);
    expect(out?.sampleRate).toBe(24000);
    expect(used).toEqual([7]);

    enabled = false;
    expect(synth.available()).toBe(false);
    enabled = true;
    key = null;
    expect(synth.available()).toBe(false);
    key = "k";
    voice = null;
    expect(synth.available()).toBe(false);
    await expect(synth.synthesize(REQ)).resolves.toBeNull();
  });

  it("warm() is always true: a cloud voice has no model to load (ADR 0042 §7d)", () => {
    const synth = createMiniMaxSynthesizer({
      fetch: fakeT2a({ delayMs: 0 }).fetch,
      key: () => "k",
      voice: () => ({ voiceId: "v", host: "https://h" }),
      enabled: () => true,
      log: () => undefined,
    });
    expect(synth.warm?.()).toBe(true);
    synth.dispose();
  });

  it("cancel aborts that utterance's in-flight requests and resolves them null", async () => {
    const t2a = fakeT2a({ delayMs: 10_000 });
    const synth = createMiniMaxSynthesizer({
      fetch: t2a.fetch,
      key: () => "k",
      voice: () => ({ voiceId: "v", host: "https://h" }),
      enabled: () => true,
      log: () => undefined,
    });
    const p1 = synth.synthesize(REQ);
    const p2 = synth.synthesize({ ...REQ, utteranceId: "u2" });
    await Promise.resolve();
    synth.cancel("u1");
    await expect(p1).resolves.toBeNull();
    // u2 is untouched by u1's cancel; dispose ends it.
    synth.dispose();
    await expect(p2).resolves.toBeNull();
  });

  it("a request past the deadline resolves null and types unvoiced", async () => {
    vi.useFakeTimers();
    const t2a = fakeT2a({ delayMs: 60_000 });
    const synth = createMiniMaxSynthesizer({
      fetch: t2a.fetch,
      key: () => "k",
      voice: () => ({ voiceId: "v", host: "https://h" }),
      enabled: () => true,
      requestTimeoutMs: 1_000,
      log: () => undefined,
    });
    const p = synth.synthesize(REQ);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(p).resolves.toBeNull();
  });

  it("a missing voice latches the engine off and reports it; a new voice id turns it back on", async () => {
    const t2a = fakeT2a({ status: { code: 2013, msg: "voice_id not found" } });
    let voice = { voiceId: "old", host: "https://h" };
    const missing: string[] = [];
    const synth = createMiniMaxSynthesizer({
      fetch: t2a.fetch,
      key: () => "k",
      voice: () => voice,
      enabled: () => true,
      onVoiceMissing: (id) => missing.push(id),
      log: () => undefined,
    });
    await expect(synth.synthesize(REQ)).resolves.toBeNull();
    expect(missing).toEqual(["old"]);
    expect(synth.available()).toBe(false);
    expect(synth.status().missingVoice).toBe("old");
    voice = { voiceId: "new", host: "https://h" };
    expect(synth.available()).toBe(true);
    expect(synth.status().missingVoice).toBeNull();
  });

  it("no more than maxInFlight requests run at once; the rest queue", async () => {
    const t2a = fakeT2a({ delayMs: 20 });
    const synth = createMiniMaxSynthesizer({
      fetch: t2a.fetch,
      key: () => "k",
      voice: () => ({ voiceId: "v", host: "https://h" }),
      enabled: () => true,
      maxInFlight: 2,
      log: () => undefined,
    });
    const ps = [0, 1, 2, 3].map((seq) => synth.synthesize({ ...REQ, seq }));
    await Promise.resolve();
    expect(t2a.calls).toBe(2);
    expect(synth.status().inFlight).toBe(2);
    const outs = await Promise.all(ps);
    expect(outs.every((o) => o !== null)).toBe(true);
    expect(t2a.calls).toBe(4);
    expect(synth.status().inFlight).toBe(0);
  });

  it("a rate limit or other failure is remembered in status and the unit types unvoiced", async () => {
    const t2a = fakeT2a({ status: { code: 1002, msg: "rate limit exceeded" } });
    const synth = createMiniMaxSynthesizer({
      fetch: t2a.fetch,
      key: () => "k",
      voice: () => ({ voiceId: "v", host: "https://h" }),
      enabled: () => true,
      log: () => undefined,
    });
    await expect(synth.synthesize(REQ)).resolves.toBeNull();
    expect(synth.status().lastFailure).toBe("rate");
    expect(synth.available()).toBe(true); // a transient failure does not latch
  });
});

describe("createMiniMaxSynthesizer — a refusal (ADR 0062 §5, the review's mid-reply case)", () => {
  const refusals = [
    { code: 1008, msg: "insufficient balance", reason: "quota" },
    { code: 1004, msg: "unauthorized", reason: "auth" },
    { code: 2049, msg: "invalid api key", reason: "invalid_key" },
  ] as const;

  for (const r of refusals) {
    it(`${r.reason}: the rest of the utterance sends no request; a new utterance probes once`, async () => {
      const t2a = fakeT2a({ status: { code: r.code, msg: r.msg } });
      const synth = createMiniMaxSynthesizer({
        fetch: t2a.fetch,
        key: () => "k",
        voice: () => ({ voiceId: "v", host: "https://h" }),
        enabled: () => true,
        log: () => undefined,
      });
      await expect(synth.synthesize({ ...REQ, seq: 0 })).resolves.toBeNull();
      expect(t2a.calls).toBe(1);
      await expect(synth.synthesize({ ...REQ, seq: 1 })).resolves.toBeNull();
      await expect(synth.synthesize({ ...REQ, seq: 2 })).resolves.toBeNull();
      expect(t2a.calls).toBe(1); // doomed: no more requests for u1
      expect(synth.status().lastFailure).toBe(r.reason);
      expect(synth.status().refusal).toBe(r.reason);
      // The next reply is a new utterance: one probe, then doomed again.
      await expect(
        synth.synthesize({ ...REQ, utteranceId: "u2", seq: 0 }),
      ).resolves.toBeNull();
      await expect(
        synth.synthesize({ ...REQ, utteranceId: "u2", seq: 1 }),
      ).resolves.toBeNull();
      expect(t2a.calls).toBe(2);
    });
  }

  it("a transient failure (rate) does not doom the utterance", async () => {
    const t2a = fakeT2a({ status: { code: 1002, msg: "rate limit exceeded" } });
    const synth = createMiniMaxSynthesizer({
      fetch: t2a.fetch,
      key: () => "k",
      voice: () => ({ voiceId: "v", host: "https://h" }),
      enabled: () => true,
      log: () => undefined,
    });
    await expect(synth.synthesize({ ...REQ, seq: 0 })).resolves.toBeNull();
    await expect(synth.synthesize({ ...REQ, seq: 1 })).resolves.toBeNull();
    expect(t2a.calls).toBe(2);
    expect(synth.status().refusal).toBeNull();
  });

  it("onRefusal fires once when the refusal is recorded and once when it clears — not per unit", async () => {
    let status: { code: number; msg: string } | undefined = {
      code: 1008,
      msg: "insufficient balance",
    };
    const t2a = fakeT2a({
      get status() {
        return status;
      },
    } as { status?: { code: number; msg: string } });
    const seen: (string | null)[] = [];
    const synth = createMiniMaxSynthesizer({
      fetch: t2a.fetch,
      key: () => "k",
      voice: () => ({ voiceId: "v", host: "https://h" }),
      enabled: () => true,
      onRefusal: (r) => seen.push(r),
      log: () => undefined,
    });
    await synth.synthesize({ ...REQ, seq: 0 });
    await synth.synthesize({ ...REQ, seq: 1 });
    await synth.synthesize({ ...REQ, utteranceId: "u2", seq: 0 });
    expect(seen).toEqual(["quota"]);
    status = undefined; // the account was topped up
    await expect(
      synth.synthesize({ ...REQ, utteranceId: "u3", seq: 0 }),
    ).resolves.not.toBeNull();
    expect(seen).toEqual(["quota", null]);
    expect(synth.status().refusal).toBeNull();
  });

  it("a refusal is about the key it was answered for: it clears when the key changes", async () => {
    const t2a = fakeT2a({ status: { code: 1004, msg: "unauthorized" } });
    let key = "old";
    const seen: (string | null)[] = [];
    const synth = createMiniMaxSynthesizer({
      fetch: t2a.fetch,
      key: () => key,
      voice: () => ({ voiceId: "v", host: "https://h" }),
      enabled: () => true,
      onRefusal: (r) => seen.push(r),
      log: () => undefined,
    });
    await synth.synthesize(REQ);
    expect(synth.status().refusal).toBe("auth");
    key = "new";
    expect(synth.status().refusal).toBeNull();
    expect(synth.status().lastFailure).toBeNull();
    expect(seen).toEqual(["auth", null]);
  });
});

describe("createMiniMaxSynthesizer — the toggle mid-reply (ADR 0042 §7c)", () => {
  it("a request while 实时语音 is off answers null without a request; cancelAll ends what is in flight", async () => {
    const t2a = fakeT2a({ delayMs: 10_000 });
    let on = true;
    const synth = createMiniMaxSynthesizer({
      fetch: t2a.fetch,
      key: () => "k",
      voice: () => ({ voiceId: "v", host: "https://h" }),
      enabled: () => on,
      log: () => undefined,
    });
    const p1 = synth.synthesize(REQ);
    const p2 = synth.synthesize({ ...REQ, utteranceId: "u2" });
    await Promise.resolve();
    expect(t2a.calls).toBe(2);
    on = false;
    await expect(synth.synthesize({ ...REQ, seq: 1 })).resolves.toBeNull();
    expect(t2a.calls).toBe(2);
    synth.cancelAll();
    await expect(p1).resolves.toBeNull();
    await expect(p2).resolves.toBeNull();
  });
});
