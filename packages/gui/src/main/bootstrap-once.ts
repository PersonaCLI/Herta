/**
 * The session service's `start`, one bootstrap at a time (review 2026-11-10).
 *
 * `start` runs on every `did-finish-load` of the window: the first load
 * bootstraps, a later one (a renderer crash's reload, a dev reload) re-syncs
 * the renderer with what is already there. The bootstrap now first waits for
 * main's PATH recovery, which the window no longer waits for — up to 3 s on
 * macOS/Linux with the page already loaded. A second load in that time saw no
 * host yet and would have built a second one. Here a call that arrives while
 * a bootstrap runs waits for it, then is a re-sync like any later call. A
 * bootstrap that ended without a host (its failure is the error panel) is
 * tried again by the next call, as before.
 */
export function bootstrapOnce(parts: {
  /** Whether the service has its host. */
  readonly booted: () => boolean;
  /** The first start's work. Must not reject: a failure is its own panel. */
  readonly bootstrap: () => Promise<void>;
  /** Re-sync a reloaded renderer with what is already there. */
  readonly resync: () => void;
}): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return async () => {
    if (inFlight !== null) await inFlight;
    if (parts.booted()) {
      parts.resync();
      return;
    }
    inFlight = parts.bootstrap();
    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  };
}
