/**
 * A bound on a load that can hang without ever rejecting (ADR 0057 §2.12).
 *
 * three's KTX2 transcoder is why this exists: its `WorkerPool.postMessage` has
 * no reject path and its workers have no `error` listener, so a worker that
 * dies before answering (a CSP refusing the transcoder's glue, a wasm that will
 * not instantiate) leaves the load — and `createDeviceScene` — pending forever,
 * with the card on its frosted glass until `SCENE_PATIENCE_MS`. A deadline
 * turns "no answer" into the failure the card already handles.
 *
 * The loser of the race keeps running: `onExpire` is where the caller stops
 * the underlying work (the transcoder's `dispose()` terminates its workers).
 */
export interface Deadline {
  /** The bound, ms. */
  readonly ms: number;
  /** The rejection message when the bound is hit. */
  readonly reason: string;
  /** Called once, just before the rejection, to stop the work. */
  readonly onExpire: () => void;
}

/** `work`, or a rejection with `reason` if it has not settled in `ms`. */
export function withDeadline<T>(
  work: Promise<T>,
  deadline: Deadline,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      deadline.onExpire();
      reject(new Error(deadline.reason));
    }, deadline.ms);
    // Attached immediately, so the losing side of the race is never an
    // unhandled rejection — whether it answers late or fails late.
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
