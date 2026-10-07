import type {
  CompletionEvent,
  CompletionProviderAdapter,
  ProviderAdapter,
  ProviderEvent,
} from "@herta/core";

/**
 * The provider a TEST session gets for a role it did not stub (2026-10-08).
 *
 * `SessionInternalDeps.providerOverrides` is the test seam, and its rule was
 * already "under overrides, nothing reaches the network" for the digest and
 * caption models — but the router, supervisor, backend, title and actor fell
 * back to real DeepSeek providers when a test left them out. The intent
 * router did, in every session test that ran a turn: 42 real requests to
 * api.deepseek.com per run, each answered 401 for the dummy key and caught
 * by the driver's fallback. Offline, the TLS attempt ate the 5 s test
 * budget and the tests timed out.
 *
 * Failing at the first read is that same 401 path — every caller already
 * handles a provider that throws — only immediate, and named.
 */
function offlineIterable<T>(role: string): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        Promise.reject(
          new Error(
            `no ${role} provider stubbed in this test session — test sessions never reach the network`,
          ),
        ),
    }),
  };
}

export function offlineChatProvider(role: string): ProviderAdapter {
  return { streamChat: () => offlineIterable<ProviderEvent>(role) };
}

export function offlineCompletionProvider(
  role: string,
): CompletionProviderAdapter {
  return { streamCompletion: () => offlineIterable<CompletionEvent>(role) };
}
