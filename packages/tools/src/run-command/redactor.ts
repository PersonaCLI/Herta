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
//
// Read in three steps, each linear (review 2026-11-05, G11): the key, its stem,
// its value. One pattern with `[A-Z0-9_]*` either side of the stem tried every
// stem in a word against the rest of that word: 300 KB of `TOKENTOKEN…` held
// the main thread over 11 s.
const ENV_KEY_RE = /\b[A-Z0-9_]+(?=\s*=)/gi;
const ENV_STEM_RE =
  /API_?KEY|ACCESS_KEY|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY/i;
const ENV_VALUE_RE = /(\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s'"]+)/y;

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
 *  `User(id=1, token=abc123def456.ghi789jkl012)` has the shape of code.
 *
 *  Two passes, each linear. As one pattern (`/(?=\w*\d)\b\w{12,}\b/`) the
 *  lookahead ran to the word's end from every character of it, so one long
 *  word with no digit — `TOKEN=` and 40 000 letters — held the main thread
 *  for 0.8 s, four times that at twice the length (review 2026-11-10).
 *  Exported for its test, which holds it to that pattern. */
export function hasOpaqueWord(value: string): boolean {
  for (const word of value.matchAll(/\w{12,}/g)) {
    if (/\d/.test(word[0])) return true;
  }
  return false;
}

/** A keyword argument, whose value is code: inside a call this line opens, or
 *  on a line of its own in a call over several lines. `f(password=hunter2)`
 *  is a name in Python and a value anywhere else, so a bare word passes only
 *  when it is plainly a variable's name. */
function isKeywordArgument(before: string, value: string): boolean {
  if (hasOpaqueWord(value)) return false;
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

function redactEnvSecrets(text: string): string {
  const keys = new RegExp(ENV_KEY_RE.source, ENV_KEY_RE.flags);
  const value = new RegExp(ENV_VALUE_RE.source, ENV_VALUE_RE.flags);
  let out = "";
  let copied = 0;
  for (let key = keys.exec(text); key !== null; key = keys.exec(text)) {
    if (!ENV_STEM_RE.test(key[0])) continue;
    value.lastIndex = key.index + key[0].length;
    const found = value.exec(text);
    if (found === null) continue;
    keys.lastIndex = value.lastIndex;
    const sep = found[1] ?? "";
    if (readsASecret(sep, found[2] ?? "", lineBefore(text, key.index))) {
      continue;
    }
    out += `${text.slice(copied, key.index)}${key[0]}${sep}[REDACTED:env_secret]`;
    copied = value.lastIndex;
  }
  return `${out}${text.slice(copied)}`;
}

const isWordChar = (c: string | undefined): boolean =>
  c !== undefined && /\w/u.test(c);

/** Where the run of a JWT piece's characters starting at `from` ends. */
function pieceEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && /[A-Za-z0-9_-]/u.test(text[i] as string)) i += 1;
  return i;
}

const JWT_PIECE_MIN = 10;

/**
 * The `jwt` pattern, walked forward (G11). The pattern started again at every
 * `eyJ` after a `-`, and each start read to the end of the word and back:
 * 300 KB of `eyJ-eyJ-…` held the main thread over 20 s. Every start in one
 * piece shares that piece's end and the two pieces after it, so one try per
 * piece answers for them all.
 */
function redactJwts(text: string): string {
  let out = "";
  let copied = 0;
  let at = text.indexOf("eyJ");
  while (at !== -1) {
    if (isWordChar(text[at - 1])) {
      at = text.indexOf("eyJ", at + 1);
      continue;
    }
    const first = pieceEnd(text, at);
    let end = -1;
    if (first - (at + 3) >= JWT_PIECE_MIN && text[first] === ".") {
      const second = pieceEnd(text, first + 1);
      if (second - (first + 1) >= JWT_PIECE_MIN && text[second] === ".") {
        let third = pieceEnd(text, second + 1);
        while (third > second + 1 && !isWordChar(text[third - 1])) third -= 1;
        if (third - (second + 1) >= JWT_PIECE_MIN) end = third;
      }
    }
    if (end === -1) {
      at = text.indexOf("eyJ", Math.max(first, at + 1));
      continue;
    }
    out += `${text.slice(copied, at)}[REDACTED:jwt]`;
    copied = end;
    at = text.indexOf("eyJ", end);
  }
  return `${out}${text.slice(copied)}`;
}

/** Everything but `jwt`, which has its own walk. */
const LINEAR_PATTERNS = PATTERNS.filter((p) => p.kind !== "jwt");

export function redactSecrets(text: string): string {
  let out = text.replace(PEM_BLOCK_RE, "[REDACTED:private_key]");
  for (const { kind, re } of LINEAR_PATTERNS) {
    out = out.replace(re, `[REDACTED:${kind}]`);
    if (kind === "github_token") out = redactJwts(out);
  }
  return redactEnvSecrets(out);
}
