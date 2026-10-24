import { realpathSync, statSync } from "node:fs";
import { parse, resolve, sep } from "node:path";

export type WorkspaceRootCheck =
  | { ok: true; resolved: string }
  | {
      ok: false;
      code: "ws_not_found" | "ws_not_dir" | "ws_forbidden_root";
      message: string;
    };

/** Known OS/system directory prefixes (both platforms; checked equals-or-inside). */
const SYSTEM_DIRS = [
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/var",
  "/System",
  "/Library",
  "/private",
];

/**
 * Canonicalize a workspace root through symlinks (audit S8).
 *
 * `resolveSafePath` realpaths every candidate file and then prefix-compares it
 * against the root. If the root itself is a symlink, those two can never
 * match: with the root at `/tmp/proj`, `a.ts` canonicalizes to
 * `/private/tmp/proj/a.ts`, which does not start with `/tmp/proj`, so EVERY
 * file operation is denied as outside the workspace. That is the whole of
 * macOS's `/tmp` and `/var`, plus any project reached through a symlink or a
 * Windows junction. The test suite already knew: `testing/tmp-workspace.ts`
 * realpaths its own root precisely so the suite does not hit this.
 *
 * NATIVE realpath first (user report 2026-08-24): `resolveSafePath` uses
 * `fsPromises.realpath`, which has native semantics — on Windows it resolves
 * subst and mapped network drives (`F:\ws` → `C:\real\ws` or `\\srv\share\ws`),
 * which the JS `realpathSync` walk does not (a drive mapping is not a reparse
 * point on any path component). A root canonicalized with the JS walk while
 * candidates canonicalize natively re-creates the S8 symptom wholesale for a
 * workspace on a mapped drive: even `resolveSafePath(root, ".")` is denied,
 * so 板砖 cannot run a single command. Both sides must share ONE semantics.
 * The JS walk stays as the middle fallback: on filesystems where the native
 * call fails (some network redirectors), candidate realpaths fail too and
 * `resolveSafePath` degrades to lexical prefix checks — the JS result keeps
 * the root in that same un-resolved spelling, so the two still agree.
 *
 * Falls back to the lexical resolve when the path does not exist — the caller
 * is about to reject it anyway, and a fallback keeps the error "no such
 * directory" instead of an EIO from deep inside a resolver.
 */
export function canonicalWorkspaceRoot(input: string): string {
  const lexical = resolve(input);
  try {
    return realpathSync.native(lexical);
  } catch {
    try {
      return realpathSync(lexical);
    } catch {
      return lexical;
    }
  }
}

/**
 * macOS reaches `/etc`, `/var` and `/tmp` through symlinks into `/private`, so
 * canonicalizing turns every one of them into a `/private/...` path. Comparing
 * those against SYSTEM_DIRS directly gets both answers wrong at once:
 * `/private/etc` is genuinely a system directory but is not spelled like one,
 * and `/private/tmp/proj` is ordinary scratch space that would be refused
 * merely for living under the `/private` entry.
 *
 * Stripping the prefix before the comparison restores the intent of the list —
 * `/private/etc` → `/etc` (refused, correctly), `/private/tmp/proj` →
 * `/tmp/proj` (allowed). `/private` itself stays on the list for the literal
 * case.
 */
function stripPrivatePrefix(p: string): string {
  return p.startsWith("/private/") ? p.slice("/private".length) : p;
}

/**
 * Ordinary user-writable scratch space that happens to sit inside a
 * SYSTEM_DIRS entry. `/var` is on that list for Linux (`/var/log`,
 * `/var/lib`), but on macOS `/var/folders/<hash>/T` is simply where
 * `os.tmpdir()` points — the user's own per-account temp directory, with no
 * system files in it. Refusing it there while accepting `/tmp` on Linux was
 * an accident of the list, not a decision.
 */
const SCRATCH_EXCEPTIONS = [
  "/var/folders",
  // Where web projects conventionally live on Linux (platform review
  // 2026-09-23) — user content under the `/var` entry, like the one above.
  "/var/www",
];

function eqOrInside(child: string, parent: string): boolean {
  const c = child.toLowerCase();
  const p = parent.toLowerCase();
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Same equals-or-inside check but with a fixed "/" boundary, for comparing
 *  slash-normalized strings independent of the host platform separator. */
function eqOrInsideSlash(child: string, parent: string): boolean {
  const c = child.toLowerCase();
  const p = parent.toLowerCase();
  return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

/**
 * The system-directory decision, on slash-normalized strings (`canonical` and
 * `home` with macOS's `/private` already stripped). Exported for its tests:
 * the layouts it exists for cannot be built on a test machine.
 *
 * Inside the user's home is never a system directory, wherever the OS mounts
 * home (platform review 2026-09-23). Fedora's atomic desktops — Silverblue,
 * Kinoite, Bazzite, Bluefin — make `/home` a link to `/var/home`, so every
 * project canonicalized to `/var/home/<user>/…`, matched the `/var` entry, and
 * was refused: on those systems not one folder could be opened. `home` is
 * empty when the caller has none, and then nothing is exempt.
 *
 * Each spelling answers for itself (2026-10-24): a scratch exception one
 * spelling earns never covers the other's refusal. As one shared exemption, a
 * raw `/var/folders/…` or `/var/www/…` let through whatever the path LANDED
 * on — `/var/www/../../etc` as typed, or a link sitting there that points at
 * /etc — and /etc opened as a workspace.
 */
export function isRefusedSystemDir(
  canonical: string,
  raw: string,
  home: string,
): boolean {
  if (home.length > 0 && eqOrInsideSlash(canonical, home)) return false;
  return [canonical, raw].some(
    (p) =>
      !SCRATCH_EXCEPTIONS.some((s) => eqOrInsideSlash(p, s)) &&
      SYSTEM_DIRS.some((dir) => eqOrInsideSlash(p, dir.replace(/\\/g, "/"))),
  );
}

/**
 * Validate a USER-SUPPLIED backend-workspace root (deterministic, D4). Rejects
 * a drive/filesystem root, the home root itself, a directory that contains
 * the home root, OS/system dirs, and anything at or under `<home>/.herta`.
 * The managed default (under ~/.herta/workspaces) is set by trusted internal
 * code paths and must NOT pass through here.
 */
export function validateWorkspaceRoot(
  input: string,
  opts: { home: string },
): WorkspaceRootCheck {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, code: "ws_not_found", message: "empty path" };
  }
  // Canonical from here down (audit S8): this string becomes the workspace
  // root every later path check compares against, so it has to be the same
  // form resolveSafePath produces for the files inside it.
  const resolved = canonicalWorkspaceRoot(input);
  const home = canonicalWorkspaceRoot(opts.home);

  if (parse(resolved).root === resolved) {
    return {
      ok: false,
      code: "ws_forbidden_root",
      message: `refusing a filesystem root: ${resolved}`,
    };
  }
  if (resolved.toLowerCase() === home.toLowerCase()) {
    return {
      ok: false,
      code: "ws_forbidden_root",
      message: `refusing the home directory: ${resolved}`,
    };
  }
  // A directory CONTAINING home (platform review 2026-09-23): `/home`,
  // `/Users`, `C:\Users`. With one of those as the root, every profile and
  // credential file in the user's home is "inside the workspace", and the
  // only thing left between them and 板砖 is the credential basename list.
  if (opts.home.length > 0 && eqOrInside(home, resolved)) {
    return {
      ok: false,
      code: "ws_forbidden_root",
      message: `refusing a directory that contains the home directory: ${resolved}`,
    };
  }
  if (eqOrInside(resolved, resolve(home, ".herta"))) {
    return {
      ok: false,
      code: "ws_forbidden_root",
      message: `refusing a path under ~/.herta: ${resolved}`,
    };
  }
  // Match against the resolved path AND the raw, slash-normalized input so a
  // POSIX-style system path (e.g. "/etc") is rejected even on Windows, where
  // resolve() would rewrite it onto the current drive (C:\etc) and lose intent.
  //
  // On macOS the spelling the OS itself hands back for /tmp and /var (a
  // folder picker, a shell's physical cwd: `/private/tmp/proj`) is judged as
  // the canonical one is (2026-10-24), not refused for sitting under the
  // `/private` entry: `/private/etc` is still `/etc`, and `/private` itself
  // keeps its entry. Linux has no such links, so nothing is stripped there.
  const rawSlash = input.replace(/\\/g, "/");
  const rawNormalized =
    process.platform === "darwin" ? stripPrivatePrefix(rawSlash) : rawSlash;
  // Both forms, because each catches what the other cannot: the canonical one
  // catches a symlink the user made that points into /etc, the raw one catches
  // a POSIX system path typed on Windows, where resolve() would rewrite "/etc"
  // onto the current drive (C:\etc) and lose the intent.
  const canonical = stripPrivatePrefix(resolved.replace(/\\/g, "/"));
  const homeSlash =
    opts.home.length > 0 ? stripPrivatePrefix(home.replace(/\\/g, "/")) : "";
  if (isRefusedSystemDir(canonical, rawNormalized, homeSlash)) {
    return {
      ok: false,
      code: "ws_forbidden_root",
      message: `refusing a system directory: ${resolved}`,
    };
  }
  if (resolved.toLowerCase().split(sep).includes("system32")) {
    return {
      ok: false,
      code: "ws_forbidden_root",
      message: `refusing a system directory: ${resolved}`,
    };
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(resolved);
  } catch {
    return {
      ok: false,
      code: "ws_not_found",
      message: `no such directory: ${resolved}`,
    };
  }
  if (!st.isDirectory()) {
    return {
      ok: false,
      code: "ws_not_dir",
      message: `not a directory: ${resolved}`,
    };
  }
  return { ok: true, resolved };
}
