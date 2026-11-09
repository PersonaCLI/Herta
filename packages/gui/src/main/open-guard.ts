import { stat } from "node:fs/promises";

/**
 * What the viewer's 打开 hands to the OS's default handler, and what it shows
 * in its folder instead (review 2026-11-10).
 *
 * `shell.openPath` does what a double click does. For a document that is its
 * viewer. For a program, a script, a shortcut or an installer it is RUNNING
 * it — as the Trailblazer, with nothing asked. A write inside the workspace
 * is the kind the harness lets through without a question (undo takes it
 * back), so a file 板砖 wrote, or one a cloned repository brought along, was
 * one click on 打开 away from running, and `run_command`'s whole rule was
 * stepped around. Such a file is shown in its folder instead: running it from
 * there is the Trailblazer's own act, in the OS's own shell, with whatever
 * that shell asks first.
 *
 * Electron cannot say what would open one file, so this is a list: the types
 * whose usual handler runs them, per platform. It errs towards showing. A
 * `.js` on Windows opens in Windows Script Host unless someone changed that,
 * so it is shown, and on a machine where it opens in an editor that costs a
 * second click.
 */

/** Run wherever their runtime is installed: Wine registers the first two off
 *  Windows, a JRE the third. */
const ANYWHERE = ["exe", "msi", "jar"];

const WINDOWS = [
  // programs, screen savers, installers, control-panel and console snap-ins
  "com",
  "scr",
  "pif",
  "cpl",
  "msp",
  "msc",
  // the command shells
  "bat",
  "cmd",
  "ps1",
  // Windows Script Host and the HTML application host
  "vbs",
  "vbe",
  "js",
  "jse",
  "wsf",
  "wsh",
  "hta",
  // what the Python launcher registers
  "py",
  "pyw",
  "pyz",
  "pyzw",
  // shortcuts and shell files: each names something else to run or to load
  "lnk",
  "url",
  "scf",
  "reg",
  "chm",
  "application",
  "appref-ms",
  "settingcontent-ms",
  "diagcab",
];

const MAC = [
  // a bundle launches; these three run in Terminal
  "app",
  "command",
  "tool",
  "terminal",
  // Automator, installers, and the location files that open what they name
  "action",
  "workflow",
  "pkg",
  "mpkg",
  "prefpane",
  "inetloc",
  "fileloc",
];

const ELSEWHERE = ["desktop", "appimage", "run"];

function listFor(platform: NodeJS.Platform): ReadonlyArray<string> {
  if (platform === "win32") return WINDOWS;
  if (platform === "darwin") return MAC;
  return ELSEWHERE;
}

export interface OpenTarget {
  /** The path as resolved. Only its last segment is read. */
  readonly path: string;
  readonly platform: NodeJS.Platform;
  /** Windows: the machine's own `PATHEXT`. The shell runs every type in it,
   *  which is how an interpreter installed later (`.RB`, `.PL`) is known. */
  readonly pathext?: string;
  /** Not Windows: a regular file with an execute bit set. */
  readonly executable?: boolean;
}

/** The type a name ends in, lower-cased, without its dot; `""` for none. A
 *  leading dot is a type on Windows (`.exe` is a program there) and a hidden
 *  file's name everywhere else. */
function typeOf(name: string, platform: NodeJS.Platform): string {
  const dot = name.lastIndexOf(".");
  if (dot < (platform === "win32" ? 0 : 1)) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Whether opening this path would run it rather than show it.
 *
 * Pure: the caller supplies what the machine knows (`runsWhenOpened` below
 * does). A folder is judged by its name like a file — a macOS `.app` IS a
 * folder — and one that merely ends in `.exe` is shown in its parent, which
 * loses nothing.
 */
export function opensByRunning(target: OpenTarget): boolean {
  const { platform } = target;
  const windows = platform === "win32";
  const last = target.path.split(windows ? /[\\/]/ : "/").pop() ?? "";
  const runs = new Set<string>([...ANYWHERE, ...listFor(platform)]);
  if (windows) {
    for (const entry of (target.pathext ?? "").split(";")) {
      const type = entry.trim().replace(/^\./, "").toLowerCase();
      if (type.length > 0) runs.add(type);
    }
    // Win32 drops a name's trailing dots and spaces, and reads `name:stream`
    // as a part of `name`: every part is judged, so neither spelling hides a
    // type.
    return last
      .split(":")
      .some((part) => runs.has(typeOf(part.replace(/[. ]+$/, ""), platform)));
  }
  const type = typeOf(last, platform);
  if (runs.has(type)) return true;
  // A file with an execute bit and no type is a "Unix executable": Finder
  // runs it in Terminal, and a Linux desktop may run it too. With a type
  // (`build.sh`) it opens in that type's editor.
  return type === "" && target.executable === true;
}

/** `opensByRunning` for a path on THIS machine. A path that cannot be read
 *  is judged by its name alone. */
export async function runsWhenOpened(abs: string): Promise<boolean> {
  let executable = false;
  if (process.platform !== "win32") {
    try {
      const st = await stat(abs);
      executable = st.isFile() && (st.mode & 0o111) !== 0;
    } catch {
      executable = false;
    }
  }
  return opensByRunning({
    path: abs,
    platform: process.platform,
    pathext: process.env.PATHEXT,
    executable,
  });
}
