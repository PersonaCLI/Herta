import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { SKIP_DIR_NAMES } from "../walker.js";

/**
 * ripgrep-backed candidate finder (ADR 0025 slice 3). rg is used purely
 * as a fast FINDER of candidate (path, line) pairs — every candidate is
 * then re-verified by the existing JS pipeline (per-file resolveSafePath,
 * binary sniff, redact-BEFORE-match, JS-regex probe, context slicing), so
 * the security properties and the result shape are byte-compatible with
 * the JS scanner. Divergences, both deliberate:
 *
 *   - rg respects .gitignore (the scaling win on real repos: a JS walk
 *     over an un-skipped vendored tree is exactly what times out today);
 *   - rg's Rust regex rejects lookarounds/backreferences — such patterns
 *     (exit code 2 with no candidates), like a missing rg binary, fall
 *     back to the JS scanner silently.
 *
 * `--hidden` restores dotfile visibility (the JS walker searches
 * dotfiles; only SKIP_DIR_NAMES are excluded, mirrored here as -g
 * negations). Credential files rg may touch are dropped at the
 * verification stage — nothing it reads can surface unvetted.
 */

export interface RgCandidate {
  relPath: string;
  line: number;
}

export interface RgFindings {
  candidates: RgCandidate[];
  /** rg was killed at the candidate cap (more matches likely exist). */
  capped: boolean;
  /** rg was killed at the scan deadline. */
  timedOut: boolean;
}

/** Cached per-process probe: resolves to the rg binary name, or null. */
let rgProbe: Promise<string | null> | undefined;

export function detectRg(): Promise<string | null> {
  rgProbe ??= new Promise((resolve) => {
    try {
      const child = spawn("rg", ["--version"], {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
      });
      child.once("error", () => resolve(null));
      child.once("exit", (code) => resolve(code === 0 ? "rg" : null));
    } catch {
      resolve(null);
    }
  });
  return rgProbe;
}

export function runRgFinder(opts: {
  rgBin: string;
  pattern: string;
  caseSensitive: boolean;
  relRoot: string;
  workspaceRoot: string;
  candidateCap: number;
  deadlineMs: number;
  signal: AbortSignal;
}): Promise<RgFindings | null> {
  return new Promise((resolve) => {
    const args = [
      "--json",
      "--hidden",
      "--max-filesize=1048576",
      ...(opts.caseSensitive ? [] : ["-i"]),
      ...[...SKIP_DIR_NAMES].flatMap((d) => ["-g", `!${d}/**`]),
      "-e",
      opts.pattern,
      "--",
      opts.relRoot === "" ? "." : opts.relRoot,
    ];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.rgBin, args, {
        cwd: opts.workspaceRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }

    const candidates: RgCandidate[] = [];
    let capped = false;
    let timedOut = false;
    let stderrTail = "";
    let settled = false;

    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill();
      },
      Math.max(0, opts.deadlineMs - Date.now()),
    );

    const onAbort = (): void => {
      child.kill();
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (value: RgFindings | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve(value);
    };

    if (child.stdout === null) {
      finish(null);
      return;
    }
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (capped || timedOut) return;
      try {
        const ev = JSON.parse(line) as {
          type?: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
          };
        };
        if (ev.type !== "match") return;
        const p = ev.data?.path?.text;
        const n = ev.data?.line_number;
        if (typeof p !== "string" || typeof n !== "number") return;
        // Normalize: backslashes on Windows, and the "./" prefix rg adds
        // when the search root is "." (the JS walker emits bare relatives).
        const rel = p.split("\\").join("/").replace(/^\.\//, "");
        candidates.push({ relPath: rel, line: n });
        if (candidates.length >= opts.candidateCap) {
          capped = true;
          child.kill();
        }
      } catch {
        // non-JSON noise on stdout — ignore the line
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2_000);
    });

    child.once("error", () => finish(null));
    child.once("close", (code) => {
      // 0 = matches, 1 = no matches. 2 = error: with zero candidates this
      // is an engine-level failure (bad pattern dialect, bad invocation) —
      // fall back to JS. With candidates it's per-file noise (unreadable
      // entries) alongside real results — accept them. A kill (cap /
      // deadline / abort) reports null code; the flags say why.
      if (
        code === 2 &&
        candidates.length === 0 &&
        !capped &&
        !timedOut &&
        !opts.signal.aborted
      ) {
        finish(null);
        return;
      }
      void stderrTail;
      finish({ candidates, capped, timedOut });
    });
  });
}
