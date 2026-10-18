export type { ResolveOpts } from "./config/resolve-deepseek-key.js";
export {
  resolveDeepSeekKey,
  resolveDeepSeekKeyOrNull,
} from "./config/resolve-deepseek-key.js";
export type {
  KeyValidation,
  ValidateKeyOpts,
} from "./config/validate-deepseek-key.js";
export { validateDeepSeekKey } from "./config/validate-deepseek-key.js";
export type { DeepseekCompletionProviderOpts } from "./deepseek/completion-factory.js";
export { deepseekCompletionProvider } from "./deepseek/completion-factory.js";
export type { DeepseekProviderOpts } from "./deepseek/factory.js";
export { deepseekProvider } from "./deepseek/factory.js";
export type { DeepseekVisionOpts } from "./deepseek/vision-factory.js";
export { deepseekVisionCaptioner } from "./deepseek/vision-factory.js";
export type { DeepseekWebClientOpts } from "./deepseek/web-client.js";
export {
  deepseekWebClient,
  unescapeFetchedMarkdown,
} from "./deepseek/web-client.js";
export type { ProviderErrorCode, ProviderErrorInit } from "./errors.js";
export { ProviderError } from "./errors.js";
export type { ApiKey } from "./openai-compat/api-key.js";
export { resolveApiKey } from "./openai-compat/api-key.js";
export type { OpenAICompatibleCompletionProviderOpts } from "./openai-compat/completion-provider.js";
export { OpenAICompatibleCompletionProvider } from "./openai-compat/completion-provider.js";
export type { OpenAICompatibleProviderOpts } from "./openai-compat/provider.js";
export { OpenAICompatibleProvider } from "./openai-compat/provider.js";
export type {
  VisionCaptioner,
  VisionCaptionerOpts,
  VisionCaptionRequest,
} from "./openai-compat/vision-caption.js";
export {
  DEFAULT_CAPTION_MAX_TOKENS,
  visionCaptioner,
} from "./openai-compat/vision-caption.js";
export {
  isTlsOrProxyFailure,
  providerFetch,
  setProviderFetch,
} from "./transport.js";
export type { ProviderUsage, ProviderUsageSink } from "./usage.js";
export {
  parseUsageChunk,
  reportProviderUsage,
  setProviderUsageSink,
} from "./usage.js";
