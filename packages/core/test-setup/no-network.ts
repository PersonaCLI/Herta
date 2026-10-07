/**
 * Vitest setup file (the node project, root `vitest.config.ts`): a test never
 * reaches the network (2026-10-08).
 *
 * The session tests' helpers pass stub providers for the roles they mean to
 * exercise — and every role they left out fell back to a real DeepSeek
 * provider. The intent router did, in every session test that ran a turn:
 * 42 requests to api.deepseek.com per run, each answered 401 for the dummy
 * `sk-test` key and caught by the driver's fallback, so nothing failed and
 * nobody noticed — until the machine went offline and the TLS attempts ate
 * the 5 s test budget. The seam now defaults an unstubbed role to an offline
 * provider (app-server/src/offline-providers.ts); this file is the net under
 * it, so the next leak is a named failure instead of a silent request.
 *
 * Mechanism: `globalThis.fetch` is wrapped. A request to anything but
 * loopback is refused at once (a TypeError, as a failed fetch is) and
 * recorded; an `afterEach` registered here fails the test that made it,
 * naming the URL — the caller may well swallow the rejection (a provider's
 * fallback does), so the refusal alone would not be seen. Loopback stays
 * open for tests that run a local server. A test that stubs fetch itself
 * (`vi.stubGlobal`, an injected `fetchImpl`) never reaches the wrapper.
 */
import { afterEach } from "vitest";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const realFetch = globalThis.fetch;
const refused: string[] = [];

function urlOf(input: Parameters<typeof fetch>[0]): URL | null {
  try {
    return new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
  } catch {
    return null;
  }
}

if (typeof realFetch === "function") {
  globalThis.fetch = ((input, init) => {
    const url = urlOf(input);
    if (url !== null && !LOOPBACK.has(url.hostname)) {
      refused.push(url.href);
      return Promise.reject(
        new TypeError(
          `fetch ${url.origin} refused: tests never reach the network (packages/core/test-setup/no-network.ts)`,
        ),
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

/** Drain the refusals recorded so far — for the guard's own test, which
 *  makes one on purpose. */
export function takeRefused(): string[] {
  return refused.splice(0, refused.length);
}

afterEach(() => {
  if (refused.length === 0) return;
  const urls = [...new Set(refused)];
  refused.length = 0;
  throw new Error(
    `this test reached for the network: ${urls.join(", ")} — stub the provider (SessionInternalDeps.providerOverrides) or inject a fetch`,
  );
});
