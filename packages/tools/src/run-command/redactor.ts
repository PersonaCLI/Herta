// PEM-style private-key blocks are redacted first and as a whole: matching
// per-line would strip the BEGIN/END headers but leave the base64 body. When
// truncation cut off the END marker, redact through end-of-text — over-eager
// but safe.
const PEM_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----|$)/g;

// Token-shaped secrets by known prefix. The 2026-07-10 audit (finding 2b)
// measured that the original four patterns missed the most common real keys —
// OpenAI/DeepSeek sk- / sk-proj-, Google AIza, Slack xox*, Stripe live, npm —
// so a `grep`/`cat` over an env file leaked them verbatim.
const PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  {
    kind: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  { kind: "bearer", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
  { kind: "api_key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { kind: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "stripe_key", re: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { kind: "npm_token", re: /\bnpm_[A-Za-z0-9]{30,}\b/g },
];

// Env-style assignments. Two audit-measured failure modes fixed here:
// - `\b(API_KEY|…)` never matched PREFIXED names (`DEEPSEEK_API_KEY`,
//   `AWS_SECRET_ACCESS_KEY`) because `_` is a word character — the leading
//   `[A-Z0-9_]*` absorbs any prefix/suffix around the sensitive stem.
// - the value group rejected quotes, so `PASSWORD="hunter2"` passed through —
//   quoted alternatives now match.
const ENV_SECRET_RE =
  /\b([A-Z0-9_]*(?:API_?KEY|ACCESS_KEY|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY)[A-Z0-9_]*)(\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s'"]+)/gi;

/** The token shapes by known prefix, for a check that refuses rather than
 *  redacts (the web fetch's URL check, ADR 0080 §2). Global regexes: test
 *  with a copy (`new RegExp(re.source)`), never `.test` on these. */
export const TOKEN_SECRET_PATTERNS = PATTERNS;

// A value that reads a secret rather than holds one: a member access or a
// call (`form.elements.password.value;`, `process.env.API_KEY`,
// `os.getenv(`), or the rest of a comparison, an arrow or a parenthesized
// expression (`password === x`, `secret = (s) => …`).
// The page-app lab (ADR 0083 step 7, 2026-10-24) found a sign-in form's
// `const password = form.elements.password.value;` masked in every read,
// and both agents spent a run on the line they could not see. A bare word,
// a quoted value and a one-dot value (`p.ssw0rd`) are still taken for a
// secret.
// A call's parenthesis holds no other and closes, or runs to the end (the
// value stops at a quote: `os.getenv(`, `os.environ[`). An optional close let
// each `(` end its group anywhere, and the review of 2026-10-30 timed a
// 37-character line at 22 s on the main thread.
const CODE_REFERENCE_RE =
  /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[[^\]\n]*(?:\]|$)|\([^()\n]*(?:\)|$))+[;,)]*$/;

// A value a shell works out when it runs: a substitution, or a variable. It
// holds no secret, and masking it cut the line in half
// (`TOKEN=[REDACTED:env_secret] auth token) npm publish`, review 2026-11-05,
// G8). `${NAME:-default}` is not here (the default is written down), and a
// `$` name must be upper-case: `PASSWORD=$ecret` is a password.
const SHELL_READ_RE =
  /^(?:\$\(.*|`.*|\$\{[A-Za-z_]\w*\}|\$[A-Z_][A-Z0-9_]*|"(?:\$\([^"\n]*\)|`[^"\n]*`|\$\{[A-Za-z_]\w*\}|\$[A-Z_][A-Z0-9_]*)")$/;

// What stands before a key on its line, when all of it is indentation: bare,
// or behind the gutter of `cat -n` and read_file, or of grep's `path:line:`.
// A gutter alone is not indentation: it is what the left edge of a config
// file looks like when it is printed.
const INDENTED_RE = /^(?:\s*\d+\t|\S*:\d+:)?\s+$/;

/** A variable's name, not its value: `api_key=OPENAI_API_KEY`. */
const SECRET_NAME_RE = /api_?key|access_?key|secret|passw(?:or)?d|token/i;

/** A long word with a digit in it: an opaque value, not a name. A log's
 *  `User(id=1, token=abc123def456.ghi789jkl012)` has the shape of code. */
const OPAQUE_WORD_RE = /(?=\w*\d)\b\w{12,}\b/u;

/** A keyword argument, whose value is code: inside a call this line opens, or
 *  on a line of its own in a call over several lines. `f(password=hunter2)`
 *  is a name in Python and a value anywhere else, so a bare word passes only
 *  when it is plainly a variable's name. */
function isKeywordArgument(before: string, value: string): boolean {
  if (OPAQUE_WORD_RE.test(value)) return false;
  const bare = value.replace(/[,)]+$/u, "");
  if (
    !CODE_REFERENCE_RE.test(value) &&
    !(/^[A-Za-z_]\w*$/u.test(bare) && SECRET_NAME_RE.test(bare))
  ) {
    return false;
  }
  if (/\w\([^()]*$/u.test(before) && /[(,]\s*$/u.test(before)) return true;
  if (!INDENTED_RE.test(before)) return false;
  return value.endsWith(",") || (value.endsWith(")") && !value.includes("("));
}

/** A dotted name with nothing else to tell it from a dotted password is code
 *  only where the line reads as code: a read of the environment, a statement's
 *  end, a declaration, an assignment to a member, or indentation.
 *  `password = correct.horse.battery` at a line's left edge is a config file
 *  (review 2026-11-05, G8). */
function writtenInCode(before: string, value: string): boolean {
  if (/(?:^|\.)env\.[A-Za-z_]/u.test(value)) return true;
  if (value.endsWith(";") || before.endsWith(".")) return true;
  if (/(?:^|\s)(?:const|let|var|val|final|static|auto)\s+$/u.test(before)) {
    return true;
  }
  return INDENTED_RE.test(before);
}

// The `.env` shape — a bare `=`, no space on either side — is a value
// written down, never code that reads one. The review of 2026-10-30 (G4)
// found `password=correct.horse.battery.staple`, `TOKEN=part1.part2.part3`,
// `DB_PASSWORD=foo(bar)` and `PASSWORD==hunter2` unmasked by the exemption
// below. Every line the lab met was spaced; a minified line is masked. Two
// things are not that shape and read one all the same: what a shell works out
// when it runs, and a keyword argument (review 2026-11-05, G8).
function readsASecret(sep: string, value: string, before: string): boolean {
  if (SHELL_READ_RE.test(value)) return true;
  if (sep === "=") return isKeywordArgument(before, value);
  if (/^[=>(]/u.test(value)) return true;
  if (!CODE_REFERENCE_RE.test(value)) return false;
  if (/[()[\];]/.test(value)) return true;
  const accesses = value.match(/\??\.[A-Za-z_$]/g)?.length ?? 0;
  return accesses >= 2 && writtenInCode(before, value);
}

/** How far back a key's line is read: a bound, because a minified line can
 *  hold thousands of keys and each would read all of it. */
const LINE_LOOKBACK = 200;

/** What stands before `offset` on its line, up to the bound. */
function lineBefore(text: string, offset: number): string {
  const head = text.slice(Math.max(0, offset - LINE_LOOKBACK), offset);
  return head.slice(head.lastIndexOf("\n") + 1);
}

export function redactSecrets(text: string): string {
  let out = text.replace(PEM_BLOCK_RE, "[REDACTED:private_key]");
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED:${kind}]`);
  }
  out = out.replace(
    ENV_SECRET_RE,
    (match, key, sep: string, value: string, at: number, whole: string) =>
      readsASecret(sep, value, lineBefore(whole, at))
        ? match
        : `${key}${sep}[REDACTED:env_secret]`,
  );
  return out;
}
