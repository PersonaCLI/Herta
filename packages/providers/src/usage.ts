/**
 * What one model call cost, as the API itself counted it (perf audit
 * 2026-09-20).
 *
 * The runtime never read the `usage` block: token budgets run on the
 * harness's own estimate, and the prompt cache — the one thing the static
 * prefix, the tail-placed hints and the per-session toolset (ADR 0067) all
 * exist to protect — was judged by reading bytes, never by the number the
 * server reports. `prompt_cache_hit_tokens` answers it per call.
 *
 * DeepSeek states usage ON the chunk that carries `finish_reason`, on both
 * endpoints, with no `stream_options` asked for (probed live 2026-09-20;
 * asking only adds `"usage": null` to the other chunks). So reading it
 * changes no request byte and no consumer: every stream reader in the
 * codebase stops at `finish`, and the mapper has the numbers in hand one
 * statement before it yields that event. A gateway that follows OpenAI
 * instead — a trailing chunk with empty `choices` — is read too when a
 * consumer drains that far; when it does not, the call simply goes
 * uncounted.
 *
 * A process-wide injection point, like the transport (`transport.ts`), and
 * for the same reason: a dozen construction sites — actor, backend, router,
 * supervisor, judges, title, recap, digest, vision — are a dozen chances to
 * miss one. The host installs one sink; a provider that is handed an
 * explicit `onUsage` reports there as well.
 *
 * Numbers only. No prompt text, no completion text, no key, no session
 * identity: the sink learns which endpoint and model answered, how many
 * tokens moved, how long it took and which of the harness's roles asked,
 * nothing else.
 *
 * Every call leaves one line (review 2026-11-10). It used to leave one only
 * when the API stated its usage, so a call that timed out, failed or was
 * dropped by its reader left nothing, and the log could not show the cost
 * it was looked at for: a supervisor that waits out its deadline, a
 * dispatch held behind a verdict. Nor could a line say whose it was. A call
 * now ends as its usage (with `site` and `ms`) or as a failure
 * (`ProviderCallFailure`), never as neither.
 */
import { isAbortError } from "./openai-compat/abort.js";

export interface ProviderUsage {
  /** Which wire shape answered: chat (`/chat/completions`) or completion
   *  (`/beta/completions` — the narrative actor). */
  readonly endpoint: "chat" | "completion";
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Prompt tokens served from the provider's prefix cache / not. Both
   *  `null` when the provider does not say (a non-DeepSeek gateway). */
  readonly cacheHitTokens: number | null;
  readonly cacheMissTokens: number | null;
  /** Who made the call when it is not the session's own providers: "dream"
   *  for the idle pass (its client is @herta/knowledge's, not these).
   *  Absent = the actor, 板砖 or a sidecar. */
  readonly source?: "dream";
  /** Which of the harness's roles the provider was built for: "actor",
   *  "backend", "router", "supervisor", "title", … A provider's, not a
   *  call's: the supervisor's adapter also writes the recap. Absent on a
   *  provider nobody labelled. */
  readonly site?: string;
  /** Wall time from the request to the chunk that stated the usage. */
  readonly ms?: number;
}

/** A call that stated no usage: it failed, was aborted, or its reader left
 *  before the usage chunk. */
export interface ProviderCallFailure {
  readonly endpoint: "chat" | "completion";
  readonly model: string;
  readonly site?: string;
  /** A `ProviderError`'s code ("network", "http", "stall", "sse", …),
   *  "aborted" (an interrupt, a deadline), "unread" (the reader stopped
   *  before the usage arrived), "no_usage" (the call ran to its end and the
   *  API never stated one), or "unknown". */
  readonly outcome: string;
  /** Wall time from the request to the end of the call. */
  readonly ms: number;
}

export type ProviderFailureSink = (failure: ProviderCallFailure) => void;

export type ProviderUsageSink = (usage: ProviderUsage) => void;

let installed: ProviderUsageSink | undefined;

/** Install the process-wide usage sink. `undefined` removes it. */
export function setProviderUsageSink(
  sink: ProviderUsageSink | undefined,
): void {
  installed = sink;
}

/** Hand one call's usage to the installed sink. A sink that throws never
 *  reaches the stream it is observing. */
export function reportProviderUsage(usage: ProviderUsage): void {
  if (installed === undefined) return;
  try {
    installed(usage);
  } catch {
    // observation must not break the call it observes
  }
}

let installedFailure: ProviderFailureSink | undefined;

/** Install the process-wide failure sink. `undefined` removes it. */
export function setProviderFailureSink(
  sink: ProviderFailureSink | undefined,
): void {
  installedFailure = sink;
}

export function reportProviderFailure(failure: ProviderCallFailure): void {
  if (installedFailure === undefined) return;
  try {
    installedFailure(failure);
  } catch {
    // observation must not break the call it observes
  }
}

function outcomeOf(err: unknown): string {
  if (isAbortError(err)) return "aborted";
  if (err !== null && typeof err === "object") {
    const e = err as { name?: unknown; code?: unknown };
    if (e.name === "TimeoutError") return "aborted";
    if (typeof e.code === "string" && e.code.length > 0) return e.code;
  }
  return "unknown";
}

type Observed = Pick<ProviderCallFailure, "endpoint" | "model" | "site">;
type Stated = (usage: Omit<ProviderUsage, "endpoint" | "model">) => void;

/** One call's clock and its one report. */
function observer(
  about: Observed,
  onUsage: ((usage: ProviderUsage) => void) | undefined,
  signal: AbortSignal | undefined,
): {
  stated: Stated;
  ended: (outcome: string) => void;
  thrown: (err: unknown) => void;
} {
  const started = Date.now();
  let reported = false;
  const ended = (outcome: string): void => {
    if (reported) return;
    reported = true;
    reportProviderFailure({ ...about, outcome, ms: Date.now() - started });
  };
  return {
    stated(usage) {
      reported = true;
      const whole: ProviderUsage = {
        ...about,
        ...usage,
        ms: Date.now() - started,
      };
      try {
        onUsage?.(whole);
      } catch {
        // a caller's own observer must not break the call either
      }
      reportProviderUsage(whole);
    },
    ended,
    // A call its own signal cut is aborted whatever the transport threw: a
    // deadline whose reason is a plain Error comes out of the stream reader
    // as a network error, and read as one in the log.
    thrown: (err) =>
      ended(signal?.aborted === true ? "aborted" : outcomeOf(err)),
  };
}

/**
 * One call, timed, that ends as exactly one report: its usage, or why there
 * is none. `run` is the call itself and is handed the function to state its
 * usage with. The clock starts when the stream is first read, which is when
 * the request goes out. `signal` is the call's own, read only to name an
 * abort as one.
 */
export async function* observedCall<T>(
  about: Observed,
  run: (stated: Stated) => AsyncGenerator<T, void, void>,
  onUsage?: (usage: ProviderUsage) => void,
  signal?: AbortSignal,
): AsyncGenerator<T, void, void> {
  const call = observer(about, onUsage, signal);
  let ranOut = false;
  try {
    yield* run(call.stated);
    ranOut = true;
  } catch (err) {
    call.thrown(err);
    throw err;
  } finally {
    // Nothing threw and no usage was stated: the stream ran to its end
    // without one, or the reader broke off before it.
    call.ended(ranOut ? "no_usage" : "unread");
  }
}

/** `observedCall` for the call that is one request and one body, not a
 *  stream (the caption). */
export async function observedRequest<T>(
  about: Observed,
  run: (stated: Stated) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const call = observer(about, undefined, signal);
  try {
    const value = await run(call.stated);
    call.ended("no_usage");
    return value;
  } catch (err) {
    call.thrown(err);
    throw err;
  }
}

const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * Read a stream chunk's `usage` object. `null` when the chunk carries none
 * (absent, or the `null` placeholder) or the block is not usage-shaped.
 * The cache pair is DeepSeek's spelling; OpenAI's
 * `prompt_tokens_details.cached_tokens` is accepted as the hit count.
 */
export function parseUsageChunk(
  chunk: unknown,
): Omit<ProviderUsage, "endpoint" | "model"> | null {
  if (chunk === null || typeof chunk !== "object") return null;
  const u = (chunk as { usage?: unknown }).usage;
  if (u === null || typeof u !== "object") return null;
  const raw = u as Record<string, unknown>;
  const promptTokens = count(raw.prompt_tokens);
  const completionTokens = count(raw.completion_tokens);
  if (promptTokens === null || completionTokens === null) return null;
  const details = raw.prompt_tokens_details;
  const hit =
    count(raw.prompt_cache_hit_tokens) ??
    (details !== null && typeof details === "object"
      ? count((details as Record<string, unknown>).cached_tokens)
      : null);
  const miss =
    count(raw.prompt_cache_miss_tokens) ??
    (hit !== null ? Math.max(0, promptTokens - hit) : null);
  return {
    promptTokens,
    completionTokens,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
  };
}
