/**
 * Single source of truth for credential-material path patterns (audit T3.4).
 *
 * Two tool surfaces previously carried DIVERGENT denylists: `path-safety.ts`
 * (guards read_file / edit_file / write_new_file / search_text / glob
 * via resolveSafePath) and `run-command/classifier.ts` (guards allow-listed
 * shell readers). They disagreed — the classifier uniquely knew `.netrc` /
 * `.npmrc` / `credentials`; path-safety uniquely knew `*-api-key.txt` and the
 * `.env.example` allow-exception — and BOTH missed `.git-credentials`,
 * `.pgpass`, the `id_ecdsa`/`id_dsa` SSH stems, `*.p12` / `*.pfx` /
 * `*.keystore`, and the sensitive `.ssh` / `.aws` / `.gnupg` directory
 * segments. This module unifies them so a name is credential material in
 * EVERY tool or none.
 *
 * Deterministic harness code (D4: Herta cannot own safety) — pure string
 * logic, no fs access, so it serves both the async path-safety consumer
 * (which realpaths BEFORE calling this) and the synchronous, fs-free
 * classifier (classifier.ts:53-54 contract).
 *
 * Case policy: matching is UNCONDITIONALLY case-insensitive (fail-closed).
 * This makes the file tools stricter than before on POSIX (where the old
 * path-safety comparison was case-sensitive) — a `.ENV` is now denied — which
 * is the safe direction for credential material. Folded by `foldName`, not a
 * bare `toLowerCase()`.
 */

/**
 * A name as a case-folding filesystem opens it, for every comparison here:
 * NFKC, then lowercase. APFS folds `ſ` (U+017F, long s) to `s`, so
 * `~/.ſſh/id_rſa` IS `~/.ssh/id_rsa` on a Mac — but `toLowerCase()` leaves
 * `ſ` alone, and both read as no credential: `cat < .ſſh/id_rſa` was
 * allowed, and a `curl` sending it got a low review floor (Mac findings
 * 2026-10-24, item 5). `ſ` is the one alias of an ASCII letter
 * `toLowerCase()` misses (U+0080–U+2FFFF scanned); NFKC also folds the
 * fullwidth and ligature spellings, which only ever widens a denial.
 */
export function foldName(name: string): string {
  return name.normalize("NFKC").toLowerCase();
}

/** Basenames that are credential material verbatim (exact, case-insensitive).
 *  EXACT rather than suffix so ordinary source files whose names merely
 *  contain these words (credentials.ts, credentials.json) stay readable. SSH
 *  key stems are enumerated (not a broad `id_*` glob, which would false-
 *  positive on id_generator.ts / id_map). */
const EXACT_CREDENTIAL_BASENAMES: ReadonlySet<string> = new Set([
  ".env",
  ".netrc",
  ".npmrc",
  ".pgpass",
  ".git-credentials",
  "credentials",
  // Tool credentials (platform review 2026-09-23): PyPI upload tokens, and
  // Docker's pre-config.json auth file.
  ".pypirc",
  ".dockercfg",
  "id_rsa",
  "id_rsa.pub",
  "id_ed25519",
  "id_ed25519.pub",
  "id_ecdsa",
  "id_ecdsa.pub",
  "id_dsa",
  "id_dsa.pub",
]);

/** Suffixes that are essentially always key/cert material — safe to match by
 *  suffix (low false-positive risk). */
const CREDENTIAL_SUFFIXES: readonly string[] = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".keystore",
  "-api-key.txt",
];

/** Directory segments that hold credential material as a whole (any file
 *  inside is sensitive). Matched anywhere in a path, not just the tail —
 *  `.ssh/config`, `.aws/credentials`, `.gnupg/secring.gpg`. */
const SENSITIVE_SEGMENTS: ReadonlySet<string> = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
]);

/**
 * Credential material that is only credential in its HOME layout (platform
 * review 2026-09-23 — the POSIX tool credentials the lists above missed).
 * Sequences of segments rather than bare names, because the bare names are
 * ordinary repo content: `.docker/` holds Dockerfiles, `.kube/` manifests,
 * `usr/share/keyrings/` a Debian package's public keys. Case-insensitive like
 * everything here.
 *
 * DIRECTORY sequences make everything beneath them sensitive; FILE sequences
 * name one file (the sequence's last segment must be the path's last). Both
 * name the secret itself rather than the tool's whole folder, so a dotfiles
 * repo's `.config/gh/config.yml` (settings, no token) stays editable.
 */
const SENSITIVE_DIR_SEQUENCES: readonly (readonly string[])[] = [
  [".config", "gcloud", "legacy_credentials"],
  [".local", "share", "keyrings"], // GNOME keyring files
];
const SENSITIVE_FILE_SEQUENCES: readonly (readonly string[])[] = [
  [".docker", "config.json"], // registry auth
  [".kube", "config"], // cluster credentials
  [".config", "gh", "hosts.yml"], // the GitHub CLI's OAuth token
  [".config", "gcloud", "credentials.db"],
  [".config", "gcloud", "access_tokens.db"],
  [".config", "gcloud", "application_default_credentials.json"],
];
/** `Library/Keychains` is a keychain folder only where a home (or the
 *  system) keeps it: a Swift package's `Sources/Library/Keychains/` is code
 *  (review 2026-09-23). */
const KEYCHAINS: readonly string[] = ["library", "keychains"];

/** Whether the segment at `i` starts a home or the filesystem root:
 *  `Library/…` at the top, after `~` / `$HOME`, after `Users/<name>` or
 *  `home/<name>`, or in root's home `var/root`. */
function atHome(s: readonly string[], i: number): boolean {
  if (i === 0) return true;
  const prev = s[i - 1] as string;
  if (prev === "~" || prev === "$home" || prev === "${home}") return true;
  if (i < 2) return false;
  const up = s[i - 2] as string;
  return up === "users" || up === "home" || (up === "var" && prev === "root");
}

/** True when the segments contain a credential location from the sequence
 *  lists above. Callers pass split path segments (workspace-relative in
 *  path-safety, raw argv components in the classifier). */
export function hasCredentialSequence(segments: readonly string[]): boolean {
  const s = segments.map(foldName);
  const at = (i: number, seq: readonly string[]): boolean =>
    seq.every((part, k) => s[i + k] === part);
  for (let i = 0; i < s.length; i++) {
    for (const seq of SENSITIVE_DIR_SEQUENCES) {
      if (at(i, seq)) return true;
    }
    for (const seq of SENSITIVE_FILE_SEQUENCES) {
      if (i + seq.length === s.length && at(i, seq)) return true;
    }
    if (at(i, KEYCHAINS) && atHome(s, i)) return true;
  }
  return false;
}

/** Basenames that LOOK credential (match a rule above) but are safe templates
 *  and must stay readable/writable. Centralized so every consumer agrees —
 *  previously only path-safety honored `.env.example`; the classifier asked
 *  on it. */
const ALLOW_BASENAMES: ReadonlySet<string> = new Set([".env.example"]);

/** True when a single path COMPONENT (basename) names credential material.
 *  Callers that operate on resolved workspace-relative segments (path-safety)
 *  pass the final segment; the classifier passes a raw argv token's last
 *  component. */
export function isCredentialBasename(name: string): boolean {
  const n = foldName(name);
  if (ALLOW_BASENAMES.has(n)) return false;
  if (EXACT_CREDENTIAL_BASENAMES.has(n)) return true;
  // `.env.local`, `.env.production`, … (the allow-exception was cleared above).
  if (n.startsWith(".env.")) return true;
  for (const suffix of CREDENTIAL_SUFFIXES) {
    if (n.endsWith(suffix)) return true;
  }
  // A GLOB is matched against what it would EXPAND to, not against its own
  // spelling: `cat .env*` read the workspace's secrets while `cat .env` asked,
  // and no layer downstream could help — the literal `.env*` never realpaths,
  // so the async guard skipped it too (red team 2026-08-24). Strip the
  // wildcard tail and re-ask the question of the prefix.
  if (/[*?[]/.test(n)) {
    const prefix = n.split(/[*?[]/)[0] as string;
    if (prefix.length > 0) {
      if (EXACT_CREDENTIAL_BASENAMES.has(prefix)) return true;
      if (prefix.startsWith(".env")) return true;
      for (const base of EXACT_CREDENTIAL_BASENAMES) {
        if (base.startsWith(prefix)) return true;
      }
    }
    // `*env*`, `*secret*` — no usable prefix, but the literal fragments the
    // glob does carry name credential material. Kept to words that do not
    // appear in ordinary source names, so `*.ts` and `README*` stay allowed.
    const literal = n.replace(/[*?]|\[[^\]]*\]/g, "");
    if (
      /(^|[^a-z])(env|secret|secrets|credential|credentials|passwd|password|token)([^a-z]|$)/.test(
        literal,
      )
    ) {
      return true;
    }
  }
  return false;
}

/** True when a path SEGMENT is a credential directory (.ssh/.aws/.gnupg). */
export function isSensitiveSegment(seg: string): boolean {
  return SENSITIVE_SEGMENTS.has(foldName(seg));
}

/** True when a RAW path string (mixed `\`/`/` separators, possibly absolute
 *  or `~`-prefixed) names credential material — either its final component is
 *  a credential basename or any intermediate segment is a credential
 *  directory. For the classifier's raw argv tokens, which never went through
 *  resolveSafePath. */
export function isCredentialPath(rawPath: string): boolean {
  const segments = rawPath.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] as string;
    if (i === segments.length - 1 && isCredentialBasename(seg)) return true;
    if (isSensitiveSegment(seg)) return true;
  }
  return hasCredentialSequence(segments);
}
