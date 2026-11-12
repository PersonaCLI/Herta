import { abortError } from "@herta/core";
import {
  type DeepSeekChatResponse,
  type DeepSeekClient,
  DeepSeekHttpError,
  DeepSeekShapeError,
  type DisambiguationBatchInput,
} from "./types.js";

/** One call's token counts as the API stated them (numbers only). */
export interface KnowledgeCallUsage {
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** DeepSeek's prefix-cache split; null when the answer does not say. */
  readonly cacheHitTokens: number | null;
  readonly cacheMissTokens: number | null;
  /** Wall time of the call, its retries included. */
  readonly ms?: number;
}

/** A call that ended without an answer: what ended it, and how long it took
 *  with its retries. */
export interface KnowledgeCallFailure {
  readonly model: string;
  readonly outcome: "aborted" | "timeout" | "http" | "shape" | "network";
  readonly ms: number;
}

export interface RealDeepSeekClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxRetries?: number;
  backoffMs?: number;
  /** Told each successful call's usage. The dream pass is the one consumer
   *  of the key that runs while the user is away, and its calls never
   *  reached the host's usage log (dream review 2026-09-22, finding 4): the
   *  host forwards these into the providers' process-wide sink. A throw
   *  here never reaches the call. */
  onUsage?: (usage: KnowledgeCallUsage) => void;
  /**
   * Cuts every call of this client: the request in flight, a body being
   * read and the wait between two attempts. A cut call is not tried again.
   * The client took no signal (review 2026-11-10, second pass): nothing
   * could stop a pass's call, so a host being disposed left it running on
   * the key.
   */
  signal?: AbortSignal;
  /** One attempt's deadline. The client had none of its own: undici's five
   *  minutes bounded it, and the fetch the desktop installs has no bound. */
  timeoutMs?: number;
  /** Told each call that ended without an answer. A throw here never
   *  reaches the call. */
  onFailure?: (failure: KnowledgeCallFailure) => void;
}

type Attempt =
  | { readonly ok: true; readonly value: DeepSeekChatResponse }
  | { readonly ok: false; readonly error: unknown; readonly retry: boolean };

const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;
/** What undici allowed an attempt, kept as the client's own. */
const DEFAULT_TIMEOUT_MS = 300_000;

export class RealDeepSeekClient implements DeepSeekClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly onUsage: ((usage: KnowledgeCallUsage) => void) | undefined;
  private readonly onFailure:
    | ((failure: KnowledgeCallFailure) => void)
    | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly timeoutMs: number;

  constructor(opts: RealDeepSeekClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetch ?? fetch;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.onUsage = opts.onUsage;
    this.onFailure = opts.onFailure;
    this.signal = opts.signal;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async chatJson(
    input: DisambiguationBatchInput,
  ): Promise<DeepSeekChatResponse> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const body = JSON.stringify({
      model: input.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPayload },
      ],
      ...(input.reasoningEffort !== undefined
        ? {
            thinking: { type: "enabled" },
            reasoning_effort: input.reasoningEffort,
          }
        : {}),
    });

    const started = Date.now();
    try {
      if (this.maxRetries < 1) {
        throw new Error("DeepSeek client exhausted retries");
      }
      for (let attempt = 1; ; attempt++) {
        // A client already cut makes no request.
        if (this.isCut()) throw abortError();
        const tried = await this.attempt(url, body, input, started);
        if (tried.ok) return tried.value;
        // A cut call is never tried again, whatever it failed with.
        if (this.isCut()) throw abortError();
        if (!tried.retry || attempt >= this.maxRetries) throw tried.error;
        await sleep(this.backoffMs * 2 ** (attempt - 1), this.signal);
      }
    } catch (err) {
      this.failed(input.model, err, Date.now() - started);
      throw err;
    }
  }

  /** Read fresh each time: the signal changes across an await. */
  private isCut(): boolean {
    return this.signal?.aborted === true;
  }

  /** One request and its body, under the client's signal and the attempt's
   *  own deadline. */
  private async attempt(
    url: string,
    body: string,
    input: DisambiguationBatchInput,
    started: number,
  ): Promise<Attempt> {
    const cut = new AbortController();
    const onAbort = (): void => cut.abort();
    if (this.signal?.aborted === true) cut.abort();
    this.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cut.abort();
    }, this.timeoutMs);
    try {
      const resp = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body,
        signal: cut.signal,
      });
      if (!resp.ok) {
        const text = await safeReadText(resp);
        return {
          ok: false,
          error: new DeepSeekHttpError(resp.status, text),
          retry: resp.status >= 500,
        };
      }
      const json = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        model?: string;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          prompt_cache_hit_tokens?: number;
          prompt_cache_miss_tokens?: number;
        };
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        return {
          ok: false,
          error: new DeepSeekShapeError("missing choices[0].message.content"),
          retry: false,
        };
      }
      const u = json.usage;
      const promptTokens = count(u?.prompt_tokens);
      const completionTokens = count(u?.completion_tokens);
      if (
        this.onUsage !== undefined &&
        promptTokens !== null &&
        completionTokens !== null
      ) {
        try {
          this.onUsage({
            model: typeof json.model === "string" ? json.model : input.model,
            promptTokens,
            completionTokens,
            cacheHitTokens: count(u?.prompt_cache_hit_tokens),
            cacheMissTokens: count(u?.prompt_cache_miss_tokens),
            ms: Date.now() - started,
          });
        } catch {
          // observation must not break the call it observes
        }
      }
      return {
        ok: true,
        value: {
          rawJsonText: content,
          model: typeof json.model === "string" ? json.model : this.model,
          usage:
            json.usage === undefined
              ? undefined
              : {
                  promptTokens: json.usage.prompt_tokens,
                  completionTokens: json.usage.completion_tokens,
                  totalTokens: json.usage.total_tokens,
                },
        },
      };
    } catch (err) {
      // The attempt's own deadline is a failure like a dropped connection:
      // named, and tried again.
      if (timedOut && this.signal?.aborted !== true) {
        return {
          ok: false,
          error: Object.assign(
            new Error(`no answer within ${this.timeoutMs} ms`),
            { name: "TimeoutError" },
          ),
          retry: true,
        };
      }
      return { ok: false, error: err, retry: true };
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", onAbort);
    }
  }

  private failed(model: string, err: unknown, ms: number): void {
    if (this.onFailure === undefined) return;
    const name = (err as { name?: unknown } | null)?.name;
    const outcome: KnowledgeCallFailure["outcome"] =
      this.signal?.aborted === true
        ? "aborted"
        : err instanceof DeepSeekHttpError
          ? "http"
          : err instanceof DeepSeekShapeError
            ? "shape"
            : name === "TimeoutError"
              ? "timeout"
              : "network";
    try {
      this.onFailure({ model, outcome, ms });
    } catch {
      // observation must not break the call it observes
    }
  }
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

/** The wait between two attempts; the client's signal ends it at once. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
