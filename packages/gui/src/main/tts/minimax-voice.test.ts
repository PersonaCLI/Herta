import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "./minimax-api.js";
import {
  createMiniMaxVoiceService,
  isHertaVoiceId,
  LEGACY_REFERENCE_TAG,
  type MiniMaxVoiceRecord,
  type MiniMaxVoiceState,
  referenceTag,
} from "./minimax-voice.js";

const ok = { base_resp: { status_code: 0, status_msg: "success" } };

const REFERENCE = new Uint8Array([1, 2, 3, 4, 5]);
const TAG = createHash("sha256").update(REFERENCE).digest("hex").slice(0, 8);

/** A fake platform pair: the first host rejects the key, the second lists
 *  the account's clones (`clones`, in the platform's order), takes the
 *  upload and the clone. */
function platform(
  opts: {
    sensitive?: boolean;
    uploadFails?: boolean;
    clones?: { id: string; at?: string }[];
    /** get_voice answers this code instead of a list (the old probe shape). */
    listCode?: number;
  } = {},
) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const reply = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status });
    if (url.startsWith("https://api.minimax.io/")) {
      return reply({
        base_resp: { status_code: 2049, status_msg: "invalid api key" },
      });
    }
    if (url.endsWith("/v1/get_voice")) {
      if (opts.listCode !== undefined) {
        return reply({
          base_resp: { status_code: opts.listCode, status_msg: "as asked" },
        });
      }
      return reply({
        ...ok,
        voice_cloning: (opts.clones ?? []).map((c) => ({
          voice_id: c.id,
          created_time: c.at ?? "2026-09-08",
        })),
      });
    }
    if (url.endsWith("/v1/files/upload")) {
      if (opts.uploadFails === true) {
        return reply({
          base_resp: { status_code: 1000, status_msg: "unknown error" },
        });
      }
      return reply({ file: { file_id: 439506357502365, bytes: 5 }, ...ok });
    }
    if (url.endsWith("/v1/voice_clone")) {
      return reply({ ...ok, input_sensitive: opts.sensitive === true });
    }
    return reply({}, 404);
  };
  return { fetch, calls };
}

function service(
  fetch: FetchLike,
  over: {
    key?: string | null;
    planKey?: string | null;
    reference?: Uint8Array | null;
    initial?: MiniMaxVoiceRecord | null;
  } = {},
) {
  const saved: (MiniMaxVoiceRecord | null)[] = [];
  const changes: MiniMaxVoiceState[] = [];
  const logs: string[] = [];
  const svc = createMiniMaxVoiceService({
    fetch,
    key: () => (over.key === undefined ? "k" : over.key),
    planKey: () => over.planKey ?? null,
    readReference: async () =>
      over.reference === undefined ? REFERENCE : over.reference,
    initial: over.initial ?? null,
    save: async (r) => {
      saved.push(r);
    },
    onChange: (s) => changes.push(s),
    log: (l) => logs.push(l),
    now: () => new Date("2026-09-08T10:00:00.000Z"),
    random: () => "abc123def4",
    usedStampEveryMs: 0,
  });
  return { svc, saved, changes, logs };
}

const uploads = (calls: string[]) =>
  calls.filter((u) => u.endsWith("/v1/files/upload")).length;
const clonesMade = (calls: string[]) =>
  calls.filter((u) => u.endsWith("/v1/voice_clone")).length;

describe("createMiniMaxVoiceService", () => {
  it("prepare on an empty account: probes the platform, lists, uploads, clones under a tagged id, persists — absent → preparing → ready", async () => {
    const p = platform();
    const { svc, saved, changes, logs } = service(p.fetch);
    expect(svc.state()).toEqual({ phase: "absent" });
    expect(svc.voice()).toBeNull();
    const end = await svc.prepare();
    const voiceId = `herta-${TAG}-abc123def4`;
    expect(end).toEqual({
      phase: "ready",
      voiceId,
      host: "https://api.minimaxi.com",
      clonedAt: "2026-09-08T10:00:00.000Z",
    });
    expect(changes.map((c) => c.phase)).toEqual(["preparing", "ready"]);
    expect(saved).toEqual([
      { voiceId, host: "https://api.minimaxi.com", clonedAt: end.clonedAt },
    ]);
    expect(svc.voice()).toEqual({ voiceId, host: "https://api.minimaxi.com" });
    // The wrong platform was tried first and skipped; then the probe, the
    // list, the upload, the clone.
    expect(p.calls).toEqual([
      "https://api.minimax.io/v1/get_voice",
      "https://api.minimaxi.com/v1/get_voice",
      "https://api.minimaxi.com/v1/get_voice",
      "https://api.minimaxi.com/v1/files/upload",
      "https://api.minimaxi.com/v1/voice_clone",
    ]);
    expect(logs.at(-1)).toBe(`cloned ${voiceId} on https://api.minimaxi.com`);
    // A second prepare on a ready voice does nothing.
    const again = await svc.prepare();
    expect(again.phase).toBe("ready");
    expect(p.calls).toHaveLength(5);
  });

  // ── adopt before clone (§1.8) ─────────────────────────────────────────────

  it("adopts the newest clone on the account made from this reference — no upload, no clone, no fee", async () => {
    const p = platform({
      clones: [
        { id: `herta-${TAG}-older00001`, at: "2026-09-01" },
        { id: "someone_elses_voice", at: "2026-09-07" },
        { id: `herta-${TAG}-newer00002`, at: "2026-09-08" },
        { id: `herta-deadbeef-other0003`, at: "2026-09-09" }, // another reference
      ],
    });
    const { svc, saved, logs } = service(p.fetch);
    const end = await svc.prepare();
    expect(end).toMatchObject({
      phase: "ready",
      voiceId: `herta-${TAG}-newer00002`,
    });
    expect(uploads(p.calls)).toBe(0);
    expect(clonesMade(p.calls)).toBe(0);
    expect(saved[0]?.voiceId).toBe(`herta-${TAG}-newer00002`);
    expect(logs.at(-1)).toContain("adopted");
  });

  it("the untagged herta_ ids from before the tag are the legacy reference's — adoptable only while that is still the reference", () => {
    expect(isHertaVoiceId("herta_vhj9giztqy", LEGACY_REFERENCE_TAG)).toBe(true);
    expect(isHertaVoiceId("herta_vhj9giztqy", "0badf00d")).toBe(false);
    expect(isHertaVoiceId("herta-0badf00d-abc", "0badf00d")).toBe(true);
    expect(isHertaVoiceId("herta-0badf00d-abc", LEGACY_REFERENCE_TAG)).toBe(
      false,
    );
    expect(
      isHertaVoiceId("HertaLab_e72ref_20260908", LEGACY_REFERENCE_TAG),
    ).toBe(false);
    expect(referenceTag(REFERENCE)).toBe(TAG);
    expect(referenceTag(REFERENCE)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("a listing that fails for a reason other than the key is an empty account: cloning proceeds", async () => {
    const p = platform({ listCode: 2013 });
    const { svc, logs } = service(p.fetch);
    const end = await svc.prepare();
    expect(end.phase).toBe("ready");
    expect(clonesMade(p.calls)).toBe(1);
    expect(logs.some((l) => l.includes("could not list"))).toBe(true);
  });

  it("a rate-limited or out-of-balance listing is NOT an empty account: nothing is uploaded or cloned", async () => {
    // The account may hold the paid clone the listing exists to find; a
    // clone past the refusal is the ¥9.90 adoption saves (§1.8).
    for (const [code, reason] of [
      [1002, "rate"],
      [1039, "rate"],
      [1008, "quota"],
    ] as const) {
      const p = platform({ listCode: code });
      const { svc } = service(p.fetch);
      expect(await svc.prepare()).toEqual({ phase: "failed", error: reason });
      expect(uploads(p.calls)).toBe(0);
      expect(clonesMade(p.calls)).toBe(0);
    }
  });

  it("a platform that never answers fails as `network` at the deadline instead of holding prepare() forever", async () => {
    const calls: string[] = [];
    const hanging: FetchLike = (url, init) => {
      calls.push(url);
      return new Promise<Response>((_resolve, reject) => {
        const sig = init.signal;
        if (sig === undefined) return; // no deadline → hangs forever
        if (sig.aborted) {
          reject(sig.reason ?? new Error("aborted"));
          return;
        }
        sig.addEventListener("abort", () =>
          reject(sig.reason ?? new Error("aborted")),
        );
      });
    };
    const svc = createMiniMaxVoiceService({
      fetch: hanging,
      key: () => "k",
      readReference: async () => REFERENCE,
      initial: null,
      save: async () => undefined,
      onChange: () => undefined,
      log: () => undefined,
      timeoutMs: { control: 30, upload: 30 },
    });
    const end = await svc.prepare();
    expect(end).toEqual({ phase: "failed", error: "network" });
    // The probe tried both hosts, each to its deadline, then stopped.
    expect(calls.length).toBe(2);
    // And a reset — which awaits the in-flight run — returns promptly.
    expect(await svc.reset()).toEqual({ phase: "absent" });
  });

  // ── the token-plan key (§1.8) ─────────────────────────────────────────────

  it("with only a plan key: an existing clone is adopted; none → no_clone_key, nothing uploaded", async () => {
    const withClone = platform({ clones: [{ id: `herta-${TAG}-paid000001` }] });
    const a = service(withClone.fetch, { key: null, planKey: "cp" });
    expect(await a.svc.prepare()).toMatchObject({
      phase: "ready",
      voiceId: `herta-${TAG}-paid000001`,
    });
    expect(uploads(withClone.calls)).toBe(0);
    const empty = platform();
    const b = service(empty.fetch, { key: null, planKey: "cp" });
    const end = await b.svc.prepare();
    expect(end).toEqual({ phase: "failed", error: "no_clone_key" });
    expect(uploads(empty.calls)).toBe(0);
    expect(clonesMade(empty.calls)).toBe(0);
  });

  it("names the failure: no key at all, no reference, a rejected reference, an upload error", async () => {
    const noKey = service(platform().fetch, { key: null });
    expect((await noKey.svc.prepare()).error).toBe("no_key");
    const noRef = service(platform().fetch, { reference: null });
    expect((await noRef.svc.prepare()).error).toBe("reference");
    const sensitive = service(platform({ sensitive: true }).fetch);
    expect((await sensitive.svc.prepare()).error).toBe("sensitive");
    const upload = service(platform({ uploadFails: true }).fetch);
    const s = await upload.svc.prepare();
    expect(s.phase).toBe("failed");
    expect(s.error).toBe("other");
    expect(upload.svc.state().phase).toBe("failed");
  });

  it("starts ready from a persisted record; reset forgets it", async () => {
    const initial = {
      voiceId: "herta_old",
      host: "https://api.minimaxi.com",
      clonedAt: "2026-09-01T00:00:00.000Z",
    };
    const { svc, saved } = service(platform().fetch, { initial });
    expect(svc.state().phase).toBe("ready");
    const s = await svc.reset();
    expect(s).toEqual({ phase: "absent" });
    expect(saved).toEqual([null]);
    expect(svc.voice()).toBeNull();
  });

  it("markMissing forgets the voice and re-clones once, automatically", async () => {
    const p = platform();
    const initial = {
      voiceId: "herta_old",
      host: "https://api.minimaxi.com",
      clonedAt: "2026-09-01T00:00:00.000Z",
    };
    const { svc, changes } = service(p.fetch, { initial });
    svc.markMissing("someone-else"); // not ours: ignored
    expect(svc.state().phase).toBe("ready");
    svc.markMissing("herta_old");
    // Let the persist + re-clone run.
    for (let i = 0; i < 20 && svc.state().phase !== "ready"; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(svc.state()).toMatchObject({
      phase: "ready",
      voiceId: `herta-${TAG}-abc123def4`,
    });
    expect(changes.map((c) => c.phase)).toEqual([
      "absent",
      "preparing",
      "ready",
    ]);
  });

  it("stampUsed persists lastUsedAt, throttled", async () => {
    const initial = {
      voiceId: "herta_old",
      host: "https://api.minimaxi.com",
      clonedAt: "2026-09-01T00:00:00.000Z",
    };
    const { svc, saved } = service(platform().fetch, { initial });
    svc.stampUsed();
    await new Promise((r) => setTimeout(r, 0));
    expect(saved).toEqual([
      { ...initial, lastUsedAt: "2026-09-08T10:00:00.000Z" },
    ]);
  });

  it("concurrent prepare calls share one run", async () => {
    const p = platform();
    const { svc } = service(p.fetch);
    const [a, b] = await Promise.all([svc.prepare(), svc.prepare()]);
    expect(a.phase).toBe("ready");
    expect(b.phase).toBe("ready");
    expect(clonesMade(p.calls)).toBe(1);
  });
});
