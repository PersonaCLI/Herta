import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureHertaGitignore } from "@herta/core";

/** Filename-safe projection of an id (audit 2026-07-13 T2.4). The callId is
 *  the provider's `call.id` straight off the SSE stream — model/provider
 *  controlled and never validated upstream — so it must not shape a path:
 *  `../../../../tmp/evil` escaped `.herta/logs`. A clean id passes through
 *  untouched (log filenames stay greppable by call id); a dirty one keeps
 *  its safe chars plus a short content hash so two hostile ids can't
 *  collide onto the same log file. */
function fileSafeId(id: string): string {
  if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) return id;
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 8);
  return cleaned.length > 0 ? `${cleaned}-${hash}` : hash;
}

export interface RunLogPayload {
  ts: string;
  cwd: string;
  argv: readonly string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  /** True observed byte total per stream (may exceed the captured text when
   *  the 1MB/stream capture cap was hit — see stdoutCapped/stderrCapped). */
  stdoutBytes: number;
  stderrBytes: number;
  /** The stream exceeded the capture cap; the log below is truncated to the
   *  first cap-worth of bytes (audit T3.4 advisory — a capped log was
   *  previously indistinguishable from a complete one). */
  stdoutCapped: boolean;
  stderrCapped: boolean;
}

export async function writeRunLog(
  workspaceRoot: string,
  sessionId: string,
  callId: string,
  payload: RunLogPayload,
): Promise<string> {
  // Both ids sanitized: callId is provider-controlled (see fileSafeId);
  // sessionId is host-minted, filtered anyway as defense-in-depth.
  const relPath = `.herta/logs/${fileSafeId(sessionId)}-${fileSafeId(callId)}.log`;
  const abs = join(workspaceRoot, relPath);
  await mkdir(dirname(abs), { recursive: true });
  // Keep the logs out of the user's next commit (audit BL6). Cheap: returns on
  // an existsSync once the file is there.
  ensureHertaGitignore(workspaceRoot);
  const cap = (label: string, bytes: number, capped: boolean): string =>
    capped
      ? `${label} (CAPPED — ${bytes} total bytes observed, output above the capture limit was dropped)`
      : `${label} (${bytes} bytes)`;
  const body = `${[
    "=== herta command log ===",
    `sessionId: ${sessionId}`,
    `callId: ${callId}`,
    `ts: ${payload.ts}`,
    `cwd: ${payload.cwd}`,
    `argv: ${JSON.stringify(payload.argv)}`,
    `exitCode: ${payload.exitCode === null ? "null" : payload.exitCode}`,
    `signal: ${payload.signal ?? "null"}`,
    `timedOut: ${payload.timedOut}`,
    `durationMs: ${payload.durationMs}`,
    cap("=== stdout ===", payload.stdoutBytes, payload.stdoutCapped),
    payload.stdout,
    cap("=== stderr ===", payload.stderrBytes, payload.stderrCapped),
    payload.stderr,
  ].join("\n")}\n`;
  await writeFile(abs, body, "utf-8");
  return relPath;
}
