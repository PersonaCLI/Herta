import type { ProviderAdapter } from "@herta/core";
import type { ApiKey } from "../openai-compat/api-key.js";
import { OpenAICompatibleProvider } from "../openai-compat/provider.js";

export interface DeepseekProviderOpts {
  apiKey: ApiKey;
  model?: string;
  baseUrl?: string;
  /** Reasoning effort, sent as `reasoning_effort` with
   *  `thinking: {type:"enabled"}`. Per the official DeepSeek doc
   *  (2026-09-10) both `deepseek-flash` and `deepseek-v4-pro` accept
   *  "low" | "high" | "max". (For compatibility the API also maps
   *  "medium"/"xhigh" to "high"; we don't send those.)
   *
   *  `false` sends the block DISABLED. It used to omit the block — but an
   *  omitted block means the server DEFAULT, which is thinking ON at "high"
   *  (the doc says so, and the title provider learned it the hard way on
   *  2026-08-03), so every caller that asked for "off" — the digest sidecar,
   *  Settings → 差分协处理器 → "off" — had been reasoning all along.
   *  `undefined` still omits the block (the server default, on purpose). */
  thinking?: false | "low" | "high" | "max";
  temperature?: number;
  maxTokens?: number;
  /** Transport retries per call on 429/5xx (default: the retry loop's own,
   *  currently 2). The BACKEND passes 0 — its turn loop paces retries with
   *  its own policy, and two layers stacked (2026-09-03). */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export function deepseekProvider(opts: DeepseekProviderOpts): ProviderAdapter {
  const extraBody =
    opts.thinking === undefined
      ? undefined
      : opts.thinking === false
        ? { thinking: { type: "disabled" } }
        : {
            thinking: { type: "enabled" },
            reasoning_effort: opts.thinking,
          };

  return new OpenAICompatibleProvider({
    baseUrl: opts.baseUrl ?? "https://api.deepseek.com",
    apiKey: opts.apiKey,
    model: opts.model ?? "deepseek-v4-pro",
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    extraBody,
    fetchImpl: opts.fetchImpl,
  });
}
