import {
  reportUsageNote,
  type WebClient,
  WebClientError,
  type WebFailure,
  type WebPage,
  type WebSearchHit,
} from "@herta/core";
import { ProviderError } from "../errors.js";
import { isAbortError } from "../openai-compat/abort.js";
import type { ApiKey } from "../openai-compat/api-key.js";
import { readErrorBodyBounded } from "../openai-compat/fetch-deadline.js";
import { postJsonWithRetry } from "../openai-compat/retry-post.js";

/**
 * DeepSeek's Search and Fetch (ADR 0080): two plain endpoints on the model's
 * own key, `POST /v1/tools/search` and `POST /v1/tools/fetch`, billed per
 * successful call and limited to 5 calls a second each per account. Not a
 * model tool — the harness calls them for 板砖's `web_search` / `web_fetch`.
 *
 * Over the same retrying POST as every model call, so the desktop's
 * Chromium transport (OS proxy, PAC, corporate CA) carries them too.
 */
export interface DeepseekWebClientOpts {
  apiKey: ApiKey;
  baseUrl?: string;
  /** Results per search. Default 8 — the price is per call, not per
   *  result, and each result's summary is ~600–2 300 chars (probe
   *  2026-10-18). */
  count?: number;
  fetchImpl?: typeof fetch;
  /** Test seam for the 5-QPS spacing. */
  minIntervalMs?: number;
}

const DEFAULT_COUNT = 8;
/** 5 calls a second per endpoint, per account (DeepSeek's limit). */
const MIN_INTERVAL_MS = 200;
/** A page fetch answers once DeepSeek has the page — 5 s for a docs page,
 *  12 s for a missing one (probe 2026-10-18) — so its headers wait longer
 *  than a model call's. */
const FETCH_HEADERS_MS = 60_000;
const SEARCH_HEADERS_MS = 30_000;
/** A body that stalls after its headers reads as unavailable, not a hang. */
const BODY_MS = 60_000;
/** One retry for 408 / 429 / 5xx / the network (ADR 0080 §2). */
const MAX_RETRIES = 1;

/**
 * Undo the fetcher's Markdown escaping: every ASCII punctuation mark comes
 * back behind a backslash (`\#`, `\{`, `\.` — probe 2026-10-18), which is
 * valid Markdown and unreadable code. A doubled backslash becomes one, so a
 * page's own backslashes survive.
 */
export function unescapeFetchedMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/** Per endpoint and base URL, process-wide: two sessions share the
 *  account's limit, not one each. */
const nextSlot = new Map<string, number>();

async function waitForSlot(key: string, intervalMs: number): Promise<void> {
  if (intervalMs <= 0) return;
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(key) ?? 0);
  nextSlot.set(key, slot + intervalMs);
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

function failureFor(err: ProviderError): WebClientError {
  const status = err.status;
  const code: WebFailure =
    status === 404
      ? "not_found"
      : status === 403
        ? "rejected"
        : status === 402
          ? "balance"
          : status === 401
            ? "auth"
            : status === 400 || status === 413 || status === 422
              ? "invalid"
              : "unavailable";
  return new WebClientError(code, err.message, status);
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

export function deepseekWebClient(opts: DeepseekWebClientOpts): WebClient {
  const base = (opts.baseUrl ?? "https://api.deepseek.com").replace(/\/$/, "");
  const interval = opts.minIntervalMs ?? MIN_INTERVAL_MS;

  async function post(
    endpoint: "search" | "fetch",
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const started = Date.now();
    let ok = false;
    try {
      await waitForSlot(`${base}|${endpoint}`, interval);
      let res: Response;
      try {
        res = await postJsonWithRetry(
          {
            url: `${base}/v1/tools/${endpoint}`,
            apiKey: opts.apiKey,
            maxRetries: MAX_RETRIES,
            headersTimeoutMs:
              endpoint === "fetch" ? FETCH_HEADERS_MS : SEARCH_HEADERS_MS,
            ...(opts.fetchImpl !== undefined
              ? { fetchImpl: opts.fetchImpl }
              : {}),
          },
          JSON.stringify(body),
          signal,
        );
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (err instanceof ProviderError) throw failureFor(err);
        throw new WebClientError(
          "unavailable",
          err instanceof Error ? err.message : String(err),
        );
      }
      const text = await readErrorBodyBounded(res, BODY_MS);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new WebClientError(
          "unavailable",
          text === "" ? "empty response" : "response was not JSON",
        );
      }
      ok = true;
      return json;
    } finally {
      reportUsageNote({ kind: "web", endpoint, ok, ms: Date.now() - started });
    }
  }

  return {
    async search(query, signal) {
      const json = (await post(
        "search",
        { query, count: opts.count ?? DEFAULT_COUNT },
        signal,
      )) as { results?: unknown };
      const raw = Array.isArray(json.results) ? json.results : [];
      const hits: WebSearchHit[] = [];
      for (const r of raw) {
        if (r === null || typeof r !== "object") continue;
        const o = r as Record<string, unknown>;
        const url = str(o.url);
        if (!/^https?:\/\//i.test(url)) continue;
        const summary = str(o.summary).trim() || str(o.snippet).trim();
        hits.push({
          title: str(o.title).trim() || url,
          url,
          site: strOrNull(o.site_name),
          date: strOrNull(o.date),
          summary,
        });
      }
      return hits;
    },
    async fetchPage(url, signal): Promise<WebPage> {
      const json = (await post("fetch", { url }, signal)) as {
        title?: unknown;
        content?: unknown;
      };
      const markdown = unescapeFetchedMarkdown(str(json.content));
      if (markdown.trim() === "") {
        throw new WebClientError("not_found", "the page had no readable text");
      }
      return {
        title: unescapeFetchedMarkdown(str(json.title)).trim(),
        markdown,
      };
    },
  };
}
