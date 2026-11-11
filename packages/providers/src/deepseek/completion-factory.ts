import type { CompletionProviderAdapter } from "@herta/core";
import type { ApiKey } from "../openai-compat/api-key.js";
import { OpenAICompatibleCompletionProvider } from "../openai-compat/completion-provider.js";

/**
 * DeepSeek completion-mode provider configuration.
 *
 * `model` is intentionally NOT a factory option — it lives on each
 * `CompletionRequest` so callers always state it explicitly per call.
 * Pinning a default here would invite silent regressions when DeepSeek
 * renames its completion model.
 *
 * `thinking` / `reasoning_effort` is also intentionally not accepted:
 * those apply to DeepSeek chat models, not /beta/completions.
 *
 * SPEC v0.2 §6.1.
 */
export interface DeepseekCompletionProviderOpts {
  apiKey: ApiKey;
  baseUrl?: string;
  /** Endpoint path override. Default "/beta/completions". */
  path?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryBaseMs?: number;
  /** Which of the harness's roles this provider serves; rides its usage
   *  lines. */
  site?: string;
}

export function deepseekCompletionProvider(
  opts: DeepseekCompletionProviderOpts,
): CompletionProviderAdapter {
  return new OpenAICompatibleCompletionProvider({
    baseUrl: opts.baseUrl ?? "https://api.deepseek.com",
    apiKey: opts.apiKey,
    path: opts.path ?? "/beta/completions",
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.retryBaseMs !== undefined
      ? { retryBaseMs: opts.retryBaseMs }
      : {}),
    ...(opts.site !== undefined ? { site: opts.site } : {}),
  });
}
