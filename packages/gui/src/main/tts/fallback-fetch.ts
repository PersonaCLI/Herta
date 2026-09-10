import { errorMessage } from "@herta/core";
import type { FetchLike } from "./minimax-api.js";

/**
 * Two network stacks for the cloud voice, the second only when the first
 * cannot even make a connection (ADR 0062 §1.4, amended 2026-09-08).
 *
 * The app routes its requests through Chromium's `net.fetch` for good
 * reasons (net-transport.ts: system proxy, the OS trust store). On the
 * owner's second machine that stack reached DeepSeek but failed the TLS
 * handshake to BOTH MiniMax hosts within 100 ms — `net::ERR_CONNECTION_
 * CLOSED`, four times in a row — so a wrong key could not be told from a
 * right one and was stored unchecked. Node's `fetch` is a different stack
 * (OpenSSL, no system proxy, its own ClientHello); where the failure is a
 * proxy rule or a middlebox that dislikes Chromium's handshake, it gets
 * through. Where the host is simply unreachable, both fail and the first
 * stack's error is the one reported.
 *
 * Only a REJECTED promise triggers the fallback — a connection that never
 * happened. An HTTP answer of any status resolves and is the platform's
 * word; an abort is the caller's. The stack that last answered is
 * remembered, so a machine where only the second works pays the first
 * stack's failure once, not per unit.
 */
export function createFallbackFetch(
  stacks: readonly [FetchLike, FetchLike],
  log: (line: string) => void = () => undefined,
): FetchLike {
  const [a, b] = stacks;
  let preferred = 0;
  return async (url, init) => {
    const first = preferred;
    const second = 1 - first;
    const primary = first === 0 ? a : b;
    const other = first === 0 ? b : a;
    try {
      return await primary(url, init);
    } catch (err) {
      if (init.signal?.aborted === true) throw err;
      log(
        `[herta-minimax] stack ${first} could not connect (${errorMessage(
          err,
        )}); trying stack ${second}`,
      );
      let res: Response;
      try {
        res = await other(url, init);
      } catch {
        // Both failed: the first stack's error is the one that describes
        // the machine's usual path.
        throw err;
      }
      preferred = second;
      return res;
    }
  };
}
