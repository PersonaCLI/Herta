/**
 * The MiniMax speech API, as much of it as the cloud voice needs (ADR 0062):
 * find the platform a key belongs to, upload the reference, clone, and
 * synthesize one unit as raw PCM. Pure Node — `fetch` is injected (Electron's
 * proxy-aware `net.fetch` in the app, a fake in tests), the key is a plain
 * argument that is never logged.
 *
 * Two platforms answer the same API with the same key format: the
 * international host and the China host. A key belongs to exactly one; the
 * other answers 2049 "invalid api key". `probeHost` tries both with a cheap
 * authenticated call and remembers which one worked.
 */
export const MINIMAX_HOSTS: readonly string[] = [
  "https://api.minimax.io",
  "https://api.minimaxi.com",
];

export const MINIMAX_DEFAULT_MODEL = "speech-2.8-hd";

/** Deadlines for the control plane (probe, list, clone) and for the ~8 MB
 *  reference upload. Without them a connection that is accepted and never
 *  answered — a captive portal, a proxy that swallows the request — left
 *  the key row's save spinning for the session and `prepare()` in flight
 *  forever, which `reset()` awaits (2026-09-10). The synthesizer's per-unit
 *  deadline lives in minimax-synthesizer.ts. */
export const MINIMAX_CONTROL_TIMEOUT_MS = 30_000;
export const MINIMAX_UPLOAD_TIMEOUT_MS = 120_000;

export type MiniMaxFailure =
  | "no_key"
  | "invalid_key"
  | "auth"
  | "rate"
  | "quota"
  | "sensitive"
  | "voice_missing"
  | "invalid"
  | "network"
  | "http"
  | "cancelled"
  | "other";

export class MiniMaxError extends Error {
  constructor(
    readonly reason: MiniMaxFailure,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "MiniMaxError";
  }
}

export type FetchLike = (
  url: string,
  init: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string | FormData;
    readonly signal?: AbortSignal;
  },
) => Promise<Response>;

interface BaseResp {
  readonly status_code?: number;
  readonly status_msg?: string;
}

/** MiniMax's status codes, as far as the docs and one day's calls go:
 *  2049 the key is not this platform's; 1004 authentication; 1002/1039 rate
 *  limits; 1008 balance; 2054 "voice id not exist" (measured 2026-09-08);
 *  2013 invalid params — which older answers also used for a missing voice,
 *  told apart by the message. */
export function classifyStatus(
  code: number | undefined,
  msg: string | undefined,
): MiniMaxFailure {
  const m = (msg ?? "").toLowerCase();
  if (code === 2049) return "invalid_key";
  if (code === 1004) return "auth";
  if (code === 2054) return "voice_missing";
  if (code === 1002 || code === 1039) return "rate";
  if (code === 1008 || m.includes("balance") || m.includes("insufficient")) {
    return "quota";
  }
  if (m.includes("sensitive")) return "sensitive";
  if (m.includes("voice")) return "voice_missing";
  if (code === 2013) return "invalid";
  return "other";
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** A request that ended on its signal: the caller's cancel is `cancelled`;
 *  a deadline (`deadlineSignal`, whose reason is a TimeoutError) is the
 *  platform not answering — `network`, which is what the user can act on.
 *  Judged by the reason's NAME, not its class: the DOMException may come
 *  from another realm (jsdom in tests, a worker). */
function abortedAs(init: Parameters<FetchLike>[1]): MiniMaxFailure {
  const reason = init.signal?.reason as { name?: unknown } | undefined;
  return reason?.name === "TimeoutError" ? "network" : "cancelled";
}

/**
 * A signal that aborts with a TimeoutError after `ms`, or as soon as
 * `outer` aborts (with its reason). Built on AbortController + setTimeout
 * rather than `AbortSignal.timeout`/`any` so the same code runs under
 * Electron's Node and the test environment's DOM. `clear` releases the
 * timer once the call has settled.
 */
export function deadlineSignal(
  ms: number,
  outer?: AbortSignal,
): { readonly signal: AbortSignal; readonly clear: () => void } {
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort(new DOMException(`no answer within ${ms} ms`, "TimeoutError"));
  }, ms);
  const forward = (): void => ac.abort(outer?.reason);
  if (outer?.aborted === true) forward();
  else outer?.addEventListener("abort", forward, { once: true });
  return {
    signal: ac.signal,
    clear: () => {
      clearTimeout(timer);
      outer?.removeEventListener("abort", forward);
    },
  };
}

/** Run one platform call under a fresh deadline. */
export async function withDeadline<T>(
  ms: number,
  outer: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const d = deadlineSignal(ms, outer);
  try {
    return await run(d.signal);
  } finally {
    d.clear();
  }
}

async function call(
  fetch: FetchLike,
  url: string,
  init: Parameters<FetchLike>[1],
): Promise<{ readonly json: Record<string, unknown>; readonly text: string }> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new MiniMaxError(
      isAbort(err) || init.signal?.aborted === true
        ? abortedAs(init)
        : "network",
      err instanceof Error ? err.message : String(err),
    );
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new MiniMaxError(
      isAbort(err) || init.signal?.aborted === true
        ? abortedAs(init)
        : "network",
      err instanceof Error ? err.message : String(err),
    );
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new MiniMaxError("http", `HTTP ${res.status}: non-JSON body`);
  }
  const base = (json.base_resp ?? {}) as BaseResp;
  if (!res.ok) {
    throw new MiniMaxError(
      classifyStatus(base.status_code, base.status_msg),
      `HTTP ${res.status} ${base.status_msg ?? ""}`.trim(),
      base.status_code,
    );
  }
  if (base.status_code !== undefined && base.status_code !== 0) {
    throw new MiniMaxError(
      classifyStatus(base.status_code, base.status_msg),
      `${base.status_code} ${base.status_msg ?? ""}`.trim(),
      base.status_code,
    );
  }
  return { json, text };
}

function auth(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

/**
 * The platform this key belongs to. A cheap authenticated call per host; a
 * host that says "invalid api key" (2049) is the wrong one, and one that
 * says "login fail" (1004) did not authenticate the key at all — a key
 * that is nobody's gets 1004 from BOTH hosts (measured 2026-09-08; the
 * first cut counted that as accepted and stored the wrong key as 已连接).
 * Any other answer — success or a parameter complaint — proves the key
 * authenticated there. Throws `invalid_key` when neither accepts it.
 */
export async function probeHost(
  fetch: FetchLike,
  key: string,
  signal?: AbortSignal,
  hosts: readonly string[] = MINIMAX_HOSTS,
  /** Per-host deadline; a host that never answers is a `network` failure
   *  for that host and the probe moves on (2026-09-10). */
  perHostTimeoutMs?: number,
): Promise<string> {
  let lastNetwork: MiniMaxError | null = null;
  for (const host of hosts) {
    try {
      const ask = (sig: AbortSignal | undefined): Promise<unknown> =>
        call(fetch, `${host}/v1/get_voice`, {
          method: "POST",
          headers: { ...auth(key), "Content-Type": "application/json" },
          body: JSON.stringify({ voice_type: "voice_cloning" }),
          signal: sig,
        });
      if (perHostTimeoutMs === undefined) await ask(signal);
      else await withDeadline(perHostTimeoutMs, signal, ask);
      return host;
    } catch (err) {
      if (!(err instanceof MiniMaxError)) throw err;
      if (err.reason === "invalid_key" || err.reason === "auth") continue;
      if (err.reason === "cancelled") throw err;
      if (err.reason === "network" || err.reason === "http") {
        lastNetwork = err;
        continue;
      }
      // Authenticated, whatever else it disliked.
      return host;
    }
  }
  throw (
    lastNetwork ??
    new MiniMaxError("invalid_key", "no platform accepted the key")
  );
}

export interface ClonedVoice {
  readonly voiceId: string;
  /** As the platform reports it — a date string; empty when absent. */
  readonly createdTime: string;
}

/** The account's cloned voices, as `get_voice` lists them. Only voices that
 *  have spoken at least once appear (measured 2026-09-08: a fresh, unused
 *  clone is not listed) — which is exactly the set whose first-use fee is
 *  already paid, so adopting one costs nothing (ADR 0062 §1.8). Any key of
 *  the account lists them, the token-plan key included. */
export async function listClones(
  fetch: FetchLike,
  host: string,
  key: string,
  signal?: AbortSignal,
): Promise<ClonedVoice[]> {
  const { json } = await call(fetch, `${host}/v1/get_voice`, {
    method: "POST",
    headers: { ...auth(key), "Content-Type": "application/json" },
    body: JSON.stringify({ voice_type: "voice_cloning" }),
    signal,
  });
  const raw = Array.isArray(json.voice_cloning) ? json.voice_cloning : [];
  const out: ClonedVoice[] = [];
  for (const v of raw as { voice_id?: unknown; created_time?: unknown }[]) {
    if (typeof v?.voice_id !== "string") continue;
    out.push({
      voiceId: v.voice_id,
      createdTime: typeof v.created_time === "string" ? v.created_time : "",
    });
  }
  return out;
}

/** Upload the reference audio for cloning; resolves the file id as the
 *  exact digit string the server sent (int64 — never through a JS number). */
export async function uploadReference(
  fetch: FetchLike,
  host: string,
  key: string,
  bytes: Uint8Array,
  filename: string,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.set("purpose", "voice_clone");
  // A fresh buffer of exactly the bytes: the DOM's BlobPart wants an
  // ArrayBuffer-backed view, and a slice of a shared buffer is not one.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  form.set("file", new Blob([copy.buffer], { type: "audio/wav" }), filename);
  const { text } = await call(fetch, `${host}/v1/files/upload`, {
    method: "POST",
    headers: auth(key),
    body: form,
    signal,
  });
  const m = /"file_id"\s*:\s*"?(\d+)"?/.exec(text);
  if (m === null) throw new MiniMaxError("other", "upload: no file_id");
  return m[1] as string;
}

/** A voice id MiniMax accepts: 8–256 chars, a letter first, letters / digits
 *  / `-` / `_`, not ending in `-` or `_`, unique per account — so a fresh
 *  random tail per clone (a deleted id may or may not be reusable). With a
 *  `tag` (the reference's fingerprint, ADR 0062 §1.8) the id says which
 *  reference it was cloned from — `herta-<tag>-<random>` — so a later
 *  install can adopt it instead of cloning again. */
export function makeVoiceId(
  random: () => string = defaultRandom,
  tag?: string,
): string {
  return tag === undefined ? `herta_${random()}` : `herta-${tag}-${random()}`;
}

function defaultRandom(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 10; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/** Clone a voice from an uploaded reference. No preview text — a preview is
 *  billed like synthesis and the app has nothing to play it on. */
export async function cloneVoice(
  fetch: FetchLike,
  host: string,
  key: string,
  fileId: string,
  voiceId: string,
  signal?: AbortSignal,
): Promise<void> {
  // `file_id` is an int64 on the wire; splice the digits in as a JSON number
  // without ever rounding them through a double.
  const body = JSON.stringify({
    file_id: "__FILE_ID__",
    voice_id: voiceId,
    need_noise_reduction: false, // clean game audio
    need_volume_normalization: true,
    accuracy: 0.7,
  }).replace('"__FILE_ID__"', fileId);
  const { json } = await call(fetch, `${host}/v1/voice_clone`, {
    method: "POST",
    headers: { ...auth(key), "Content-Type": "application/json" },
    body,
    signal,
  });
  if (json.input_sensitive === true) {
    throw new MiniMaxError(
      "sensitive",
      "the reference failed the content check",
    );
  }
}

export interface SynthesizeOptions {
  readonly voiceId: string;
  readonly text: string;
  readonly model?: string;
  readonly sampleRate?: number;
  readonly signal?: AbortSignal;
}

export interface SynthesizedPcm {
  readonly samples: Int16Array;
  readonly sampleRate: number;
  /** MiniMax's billable count for this call (≈ 1.8× the characters). */
  readonly billedChars: number;
}

/** One unit as raw 24 kHz mono PCM — the shape Herta's voiced reveal plays. */
export async function synthesizePcm(
  fetch: FetchLike,
  host: string,
  key: string,
  opts: SynthesizeOptions,
): Promise<SynthesizedPcm> {
  const sampleRate = opts.sampleRate ?? 24000;
  const { json } = await call(fetch, `${host}/v1/t2a_v2`, {
    method: "POST",
    headers: { ...auth(key), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model ?? MINIMAX_DEFAULT_MODEL,
      text: opts.text,
      voice_setting: { voice_id: opts.voiceId, speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: sampleRate, format: "pcm", channel: 1 },
      language_boost: "Chinese",
      output_format: "hex",
    }),
    signal: opts.signal,
  });
  const data = (json.data ?? {}) as { audio?: unknown };
  if (typeof data.audio !== "string" || data.audio.length === 0) {
    throw new MiniMaxError("other", "no audio in the response");
  }
  const pcm = Buffer.from(data.audio, "hex");
  const samples = new Int16Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i += 1)
    samples[i] = pcm.readInt16LE(i * 2);
  const extra = (json.extra_info ?? {}) as { usage_characters?: unknown };
  return {
    samples,
    sampleRate,
    billedChars:
      typeof extra.usage_characters === "number" ? extra.usage_characters : 0,
  };
}
