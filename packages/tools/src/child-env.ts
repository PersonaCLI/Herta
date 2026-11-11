/**
 * The environment 板砖's own children run with (platform review 2026-09-23):
 * `process.env`, minus what the AppImage launcher put there for the APP.
 *
 * The Linux AppImage's AppRun prepends `$APPDIR` entries to `PATH`,
 * `LD_LIBRARY_PATH`, `XDG_DATA_DIRS` and `GSETTINGS_SCHEMA_DIR` before
 * starting Herta, and every shell, test run and git call 板砖 makes inherited
 * them — so a user's own `npm start` of an Electron or GTK app loaded HERTA's
 * bundled libraries (`$APPDIR/usr/lib`), and `$APPDIR` shadowed the user's
 * own binaries. The main process keeps its environment untouched (Chromium's
 * later helper processes may need those libraries); only the processes 板砖
 * starts get the cleaned copy. `APPIMAGE` / `APPDIR` / `OWD` / `ARGV0` go too:
 * they describe Herta's launch, and an electron-updater app started by 板砖
 * would otherwise take itself for Herta's AppImage.
 *
 * Outside an AppImage — Windows, macOS, a distro package — this is
 * `process.env` itself, byte for byte, unless it holds the harness's own key.
 *
 * The harness's own key never goes to a child (review 2026-11-10). Started
 * with `DEEPSEEK_API_KEY` in its environment — the CLI's usual way, and a
 * desktop launched from such a shell — Herta ran every shell, test run, git
 * call and dev server of 板砖's with the key it bills on. A test script in a
 * cloned repository could read it from its own environment under `npm test`,
 * which asks nothing. The desktop's stored key was never in the environment
 * and is not affected. What it costs: a project of the user's that reads
 * `DEEPSEEK_API_KEY` itself no longer finds it under 板砖, and needs it from
 * its own `.env`.
 */

/** The names the harness reads its key under: providers'
 *  `resolveDeepSeekKeyOrNull`, and knowledge's `DEEPSEEK_KEY_ENV`, which the
 *  lab scripts use too. */
const OWN_KEYS = new Set(["DEEPSEEK_API_KEY", "HERTA_DEEPSEEK_API_KEY"]);

/** Windows reads a variable's name whatever its case. */
const isOwnKey = (name: string): boolean => OWN_KEYS.has(name.toUpperCase());

const APPIMAGE_LISTS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
] as const;
const APPIMAGE_BOOKKEEPING = ["APPIMAGE", "APPDIR", "OWD", "ARGV0"] as const;

export function childProcessEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const appdir = base.APPDIR;
  if (base.APPIMAGE === undefined || appdir === undefined || appdir === "") {
    if (!Object.keys(base).some(isOwnKey)) return base;
    return withoutOwnKeys({ ...base });
  }
  const root = appdir.replace(/\/+$/, "");
  const ours = (entry: string): boolean =>
    entry === root || entry === `${root}/` || entry.startsWith(`${root}/`);
  const out: NodeJS.ProcessEnv = { ...base };
  for (const key of APPIMAGE_LISTS) {
    const value = out[key];
    if (value === undefined) continue;
    const kept = value
      .split(":")
      .filter((e) => e.length > 0 && !ours(e))
      .join(":");
    if (kept.length > 0) out[key] = kept;
    else delete out[key];
  }
  for (const key of APPIMAGE_BOOKKEEPING) delete out[key];
  return withoutOwnKeys(out);
}

/** `env`, which the caller owns, with the harness's key taken out. */
function withoutOwnKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of Object.keys(env)) {
    if (isOwnKey(name)) delete env[name];
  }
  return env;
}
