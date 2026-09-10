import type { ApiKey } from "../openai-compat/api-key.js";
import {
  DEFAULT_CAPTION_MAX_TOKENS,
  type VisionCaptioner,
  visionCaptioner,
} from "../openai-compat/vision-caption.js";

export interface DeepseekVisionOpts {
  apiKey: ApiKey;
  /** Default `deepseek-flash` — V4.1 Flash reads images (DeepSeek doc +
   *  live probe 2026-09-10; the 2026-08 `deepseek-v4-flash-vision-exp` is a
   *  retired name the API still serves with the same model). Overridable so
   *  the name can move again without a code change here. */
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
}

/** The image-captioning instrument (ADR 0048 §3). One call per attached
 *  image, at attach time; no history, no streaming, no tools. */
export function deepseekVisionCaptioner(
  opts: DeepseekVisionOpts,
): VisionCaptioner {
  return visionCaptioner({
    baseUrl: opts.baseUrl ?? "https://api.deepseek.com",
    apiKey: opts.apiKey,
    model: opts.model ?? "deepseek-flash",
    // A caption is description, not deliberation — but the model reasons
    // anyway, and the budget must cover that chain before any visible text
    // (see VisionCaptionerOpts.maxTokens for the measurements).
    maxTokens: opts.maxTokens ?? DEFAULT_CAPTION_MAX_TOKENS,
    // Low, like the digest sidecar: the same image handed over twice should
    // not describe itself two different ways in the record.
    temperature: 0.2,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
}
