import { execFile } from "node:child_process";

/**
 * Windows registry PATH recovery (ADR 0044) — the win32 twin of
 * `login-path.ts`'s macOS repair (audit S7).
 *
 * On Windows the GUI inherits PATH from whatever launched it — usually
 * Explorer, whose environment is a snapshot from ITS start. Install node (or
 * git, or a test runner) while the app is running, or launch through a
 * stale-environment parent (an updater, a shell that predates the install),
 * and the machine's real PATH — already correct in the registry, already
 * visible to any fresh cmd window — never reaches the harness's children:
 * `run_command` reports "binary not found: node" on a machine where `node -v`
 * works fine in a terminal (user report 2026-08-24, "部署过 node 但识别不出来").
 *
 * Recovery reads the two values the OS itself concatenates at logon — the
 * machine PATH (`HKLM\...\Session Manager\Environment`) then the user PATH
 * (`HKCU\Environment`) — expands `%VAR%` references, and APPENDS the entries
 * missing from the inherited PATH. Never removes or reorders inherited
 * entries, so an environment that already worked keeps winning lookups
 * exactly as before; the repair can only add resolution, not change it.
 *
 * HARNESS-set, like the macOS twin: this does not touch — and must not be
 * confused with — the model-facing env allowlist in
 * tools/run-command/env-guard.ts. The model still cannot set PATH; the app
 * simply starts with the machine's real one.
 */

/** Bound on each `reg query`, so a hung registry call cannot delay startup. */
const REG_PROBE_TIMEOUT_MS = 2000;

export type RegistryHive = "machine" | "user";

export interface WinPathDeps {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Injected for tests; defaults to querying the real registry. Returns the
   *  RAW (unexpanded) registry value, or null when the value is absent or
   *  the query fails. */
  readonly probe?: (hive: RegistryHive) => Promise<string | null>;
  /** Bound on each real `reg query`, in ms; defaults to the startup budget
   *  (REG_PROBE_TIMEOUT_MS). Injected by the real-registry test, which is
   *  about the query shape and the parser rather than the budget: a probe
   *  killed at its deadline reads as "hive unreadable", so under a
   *  saturated machine the startup bound would turn a slow HKLM read into
   *  a user-PATH-only answer. */
  readonly probeTimeoutMs?: number;
}

const HIVE_KEYS: Record<RegistryHive, string> = {
  machine:
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  user: "HKCU\\Environment",
};

/** Parse `reg query <key> /v Path` output down to the value text. The line
 *  shape is `    Path    REG_EXPAND_SZ    <value>` (REG_SZ for a user PATH
 *  that was set without variables). Exported for testing. */
export function parseRegPathOutput(stdout: string): string | null {
  const m = /^\s*Path\s+REG(?:_EXPAND)?_SZ\s+(.+?)\s*$/im.exec(stdout);
  if (m === null) return null;
  const value = (m[1] as string).trim();
  return value.length > 0 ? value : null;
}

/** Expand `%VAR%` references against `env`, case-insensitively (registry
 *  values are REG_EXPAND_SZ; `%SystemRoot%\system32` is the canonical first
 *  entry of every machine PATH). A reference with no matching variable stays
 *  literal — it resolves to nothing on lookup, which is exactly what the OS
 *  does with it too. Exported for testing. */
export function expandWindowsEnv(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const byLower = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) byLower.set(k.toLowerCase(), v);
  }
  return value.replace(
    /%([^%]+)%/g,
    (whole, name: string) => byLower.get(name.toLowerCase()) ?? whole,
  );
}

/** Append `extras` entries missing from `base`, preserving base order and
 *  spelling; case-insensitive dedupe (Windows path semantics), empties
 *  dropped. Exported for testing. */
export function mergeWindowsPath(
  base: string | undefined,
  extras: readonly string[],
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...(base ?? "").split(";"), ...extras]) {
    const entry = p.trim();
    const key = entry.toLowerCase();
    if (entry.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.join(";");
}

function realProbe(
  hive: RegistryHive,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    // Absolute reg.exe path: if the inherited PATH is broken enough to need
    // this repair, it may be too broken to resolve `reg` through it.
    const regExe = `${env.SystemRoot ?? env.windir ?? "C:\\Windows"}\\System32\\reg.exe`;
    const child = execFile(
      regExe,
      ["query", HIVE_KEYS[hive], "/v", "Path"],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        resolve(err !== null ? null : parseRegPathOutput(stdout));
      },
    );
    child.once("error", () => resolve(null));
  });
}

/**
 * The PATH the app should run with, or null when nothing should change
 * (not Windows, both hives unreadable, or the inherited PATH already covers
 * everything the registry lists). Never throws and never blocks longer than
 * the two probe timeouts.
 */
export async function resolveWindowsPath(
  deps: WinPathDeps,
): Promise<string | null> {
  if (deps.platform !== "win32") return null;
  const timeoutMs = deps.probeTimeoutMs ?? REG_PROBE_TIMEOUT_MS;
  const probe =
    deps.probe ??
    ((hive: RegistryHive) => realProbe(hive, deps.env, timeoutMs));
  // Machine before user — the order the OS concatenates them in at logon.
  const [machine, user] = await Promise.all([
    probe("machine").catch(() => null),
    probe("user").catch(() => null),
  ]);
  if (machine === null && user === null) return null;
  const extras = [machine, user]
    .filter((v): v is string => v !== null)
    .flatMap((v) => expandWindowsEnv(v, deps.env).split(";"));
  const current = deps.env.PATH ?? deps.env.Path;
  const merged = mergeWindowsPath(current, extras);
  return merged === (current ?? "") ? null : merged;
}

/**
 * Applies the recovered PATH to this process so every child spawned later
 * (run_command, the persistent shell, the rg probe) inherits it. Call once at
 * startup, before the session service is constructed — `detectRg` caches its
 * result for the process lifetime, so a later fix would not take effect.
 */
export async function applyWindowsPath(
  deps: WinPathDeps,
  setPath: (value: string) => void = (v) => {
    process.env.PATH = v;
  },
): Promise<string | null> {
  const next = await resolveWindowsPath(deps);
  if (next !== null) setPath(next);
  return next;
}
