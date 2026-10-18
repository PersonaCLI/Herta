import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { setUsageNoteSink, type UsageNote } from "@herta/core";
import { type ProviderUsage, setProviderUsageSink } from "@herta/providers";

/** One line per model call. Past this the file moves aside (one generation
 *  kept) — at ~130 bytes a line that is some thirty thousand calls. */
const ROTATE_AT_BYTES = 4 * 1024 * 1024;

/**
 * The usage log (perf audit 2026-09-20): every model call's token counts as
 * the API stated them, one JSON object per line —
 *
 *   {"at":"…","endpoint":"completion","model":"deepseek-v4-pro",
 *    "prompt":21930,"hit":21504,"miss":426,"completion":188}
 *
 * — so "is the prompt cache holding?" has a measured answer: `hit / prompt`
 * per call, by endpoint (completion = Herta; chat = 板砖 and the sidecars)
 * and model. Numbers only; see `ProviderUsage` for what is deliberately not
 * in it.
 *
 * Beside them, one line per 板砖 run and per Herta turn (long-run study item
 * 6, `UsageNote` in @herta/core), told apart by `note`:
 *
 *   {"at":"…","note":"backend-run","steps":37,"clearedSteps":12,
 *    "droppedSteps":3,"maxDropped":16,"peakSent":198000,
 *    "peakUntrimmed":260000,"budget":200000}
 *   {"at":"…","note":"actor-turn","calls":4,"firstPrompt":21930,
 *    "peakPrompt":38000,"highWater":…}
 *
 * — how often the backend trim bites, and how far Herta's prompt grows
 * inside a turn. Sizes there are the harness's estimates, the unit its
 * budgets are kept in. And one line per automatic review (ADR 0075), its
 * outcome and, for a card, why — the owner's screen is silent about it:
 *
 *   {"at":"…","note":"review","outcome":"card","why":"timeout","ms":20004}
 *
 * And one line per web call 板砖 made (ADR 0080), billed per success:
 *
 *   {"at":"…","note":"web","endpoint":"fetch","ok":true,"ms":4620}
 *
 * Installs the providers' and core's process-wide sinks, so one call covers
 * every provider and run the host builds. Writes are queued and
 * asynchronous — a model call never waits on the disk — and a failed write
 * is dropped: the log is an instrument, not a record. Returns the
 * uninstaller, which also resolves once the queue has drained (tests,
 * shutdown).
 */
export function installUsageLog(filePath: string): () => Promise<void> {
  let queue: Promise<void> = (async () => {
    try {
      await mkdir(dirname(filePath), { recursive: true });
      const info = await stat(filePath).catch(() => null);
      if (info !== null && info.size > ROTATE_AT_BYTES)
        await rename(filePath, `${filePath}.1`);
    } catch {
      // an unwritable directory just means no log
    }
  })();
  const write = (entry: Record<string, unknown>): void => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
    queue = queue
      .then(() => appendFile(filePath, line, "utf8"))
      .catch(() => {});
  };
  const sink = (u: ProviderUsage): void => {
    write({
      endpoint: u.endpoint,
      model: u.model,
      prompt: u.promptTokens,
      hit: u.cacheHitTokens,
      miss: u.cacheMissTokens,
      completion: u.completionTokens,
      // The idle dream pass says so: it spends while the user is away.
      ...(u.source !== undefined ? { source: u.source } : {}),
    });
  };
  const noteSink = (n: UsageNote): void => {
    const { kind, ...numbers } = n;
    write({ note: kind, ...numbers });
  };
  setProviderUsageSink(sink);
  setUsageNoteSink(noteSink);
  return async () => {
    setProviderUsageSink(undefined);
    setUsageNoteSink(undefined);
    await queue;
  };
}
