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
  // The classic tokens, and the fine-grained one (`github_pat_`), which is
  // longer and has underscores inside it (review 2026-11-10).
  {
    kind: "github_token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
  },
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
  return declares(before) || INDENTED_RE.test(before);
}

/** The key is a variable being declared, or an object's own field: `const
 *  token =`, `let apiKey =`, `this.token =`, `self.password =`. No config
 *  file opens a line this way. A dot alone does not say it: `db.password =`
 *  is a properties file's key. */
function declares(before: string): boolean {
  return (
    /(?:^|\s)(?:const|let|var|val|final|static|auto)\s+$/u.test(before) ||
    /(?:^|[^\w$.])(?:this|self)\.$/u.test(before)
  );
}

// What a value is when it holds nothing (review 2026-11-10, narrowed
// 2026-11-11). Until then the rule masked `self.token = None`,
// `max_tokens=4096`, `const tokens = [` and `password = ""`: on the default
// contract a file is read with `cat`, and 板砖 saw the marker in the place of
// each.

/** The punctuation of the statement or the call a value stands in:
 *  `None):`, `4096,`, `0;`, `{}`. */
const withoutClosers = (value: string): string =>
  value.replace(/[;,)\]}:]+$/u, "");

/** No value: a keyword every language spells nearly alike. */
const NO_VALUE_RE = /^(?:null|none|nil|undefined|true|false)$/iu;

/** A list or a block that opens here and is written on the lines after, or
 *  after the quote the value stopped at (`TOKENS = ["a", "b"]`). Masking the
 *  bracket hid nothing. */
const OPENER_RE = /^[[{]$/u;

/** A count, a limit, a duration: decimal, and no longer than one is. A hex
 *  number can be a key, and is not here. */
const COUNT_RE = /^-?\d[\d_]{0,12}(?:\.\d+)?$/u;

/** A number, a version or an environment's name after the secret's word
 *  leaves the key a secret's: `PASSWORD_1`, `API_KEY_V2`, `TOKEN_PROD`. */
const KEY_TAIL_RE =
  /(?:[_-]?(?:v?\d+|prod(?:uction)?|dev(?:elopment)?|stag(?:e|ing)|test|live|local|old|new|backup|bak))+$/iu;

/** How much of a key's end is read for what it names. */
const KEY_END = 48;

/** Whether the key names a secret itself, where `max_tokens`,
 *  `TOKEN_TTL_MS` and `inputTokens` name a quantity. */
function namesASecret(key: string): boolean {
  const end = key.slice(-KEY_END);
  return (
    COLON_KEY_RE.test(end) || COLON_KEY_RE.test(end.replace(KEY_TAIL_RE, ""))
  );
}

/** What a variable starts at: `let token = 0;`, `this.retries = -1`. */
const START_RE = /^-?\d{1,3}$/u;

/** A word that starts an expression and is not one by itself:
 *  `await getToken()`, `new Map()`. */
const OPERATOR_WORD_RE =
  /^(?:await|new|typeof|void|yield|not|delete|async|function|lambda)$/u;

/** One name, as a variable is written. */
const NAME_RE = /^[A-Za-z_$][\w$]*$/u;

/** A JSX attribute whose value is a reference: `apiKey={state.apiKey}`. */
const JSX_REFERENCE_RE =
  /^\{[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\}[/>]*$/u;

/**
 * A value with no secret in it, whatever the file: nothing at all (`""`), a
 * keyword for nothing (`None`, `null`, `false`), a bracket that opens what
 * follows, or a number.
 *
 * The number is the one that turns on the key. Under a key that names a
 * quantity (`max_tokens`, `TOKEN_TTL_MS`, `inputTokens`: the stem is not
 * where the key ends) it is a count. Under a key that names a secret
 * (`PASSWORD=12345678`, `password = 123456`) it is one, unless the line
 * declares a variable and starts it small (`let token = 0;`):
 * `const password = 123456;` is a secret in code.
 */
function holdsNothing(key: string, value: string, before: string): boolean {
  if (value === '""' || value === "''") return true;
  const bare = withoutClosers(value);
  if (NO_VALUE_RE.test(bare) || OPENER_RE.test(bare)) return true;
  if (!COUNT_RE.test(bare)) return false;
  if (!namesASecret(key)) return true;
  return START_RE.test(bare) && declares(before);
}

/** A JSX attribute, which is written tight like a `.env` line. Told from
 *  one by where it stands: on a tag's line or indented under it, and by a
 *  name with no digit in it (`PASSWORD={hunter2}` is a password). */
function isJsxReference(before: string, value: string): boolean {
  if (!JSX_REFERENCE_RE.test(value) || /\d/u.test(value)) return false;
  return INDENTED_RE.test(before) || /<[A-Za-z][\w.-]*\s[^<>]*$/u.test(before);
}

/** A bare word that is a variable and not a password. After a declaration
 *  any name is one (`const apiKey = key`, `this.token = token`). Elsewhere
 *  it must plainly be a secret's NAME (`password = new_password`), with no
 *  digit in it, on a line that reads as code: `password = hunter` and
 *  `db.password = hunter2` are a config file's. */
function namesAVariable(value: string, before: string): boolean {
  const bare = withoutClosers(value);
  if (!NAME_RE.test(bare)) return false;
  if (declares(before)) return true;
  if (!SECRET_NAME_RE.test(bare) || /\d/u.test(bare)) return false;
  return value.endsWith(";") || INDENTED_RE.test(before);
}

// The `.env` shape — a bare `=`, no space on either side — is a value
// written down, never code that reads one. The review of 2026-10-30 (G4)
// found `password=correct.horse.battery.staple`, `TOKEN=part1.part2.part3`,
// `DB_PASSWORD=foo(bar)` and `PASSWORD==hunter2` unmasked by the exemption
// below. Every line the lab met was spaced; a minified line is masked. Two
// things are not that shape and read one all the same: what a shell works out
// when it runs, and a keyword argument (review 2026-11-05, G8).
function readsASecret(
  key: string,
  sep: string,
  value: string,
  before: string,
  after: string,
): boolean {
  if (SHELL_READ_RE.test(value)) return true;
  if (holdsNothing(key, value, before)) return true;
  if (sep === "=") {
    return isKeywordArgument(before, value) || isJsxReference(before, value);
  }
  if (/^[=>(]/u.test(value)) return true;
  // `await getToken()`: the word, and what it works on after it.
  if (
    OPERATOR_WORD_RE.test(withoutClosers(value)) &&
    /^[ \t]+\S/u.test(after)
  ) {
    return true;
  }
  if (!CODE_REFERENCE_RE.test(value)) return namesAVariable(value, before);
  if (/[()[\];]/.test(value)) return true;
  const accesses = value.match(/\??\.[A-Za-z_$]/g)?.length ?? 0;
  if (accesses >= 2) return writtenInCode(before, value);
  // One access (`options.token`) reads like a password with a dot in it
  // (`p.ssw0rd`, `first.last`): code only after a declaration or under
  // indentation, and never with a digit.
  return !/\d/u.test(value) && (declares(before) || INDENTED_RE.test(before));
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
    if (
      readsASecret(
        key[0],
        sep,
        found[2] ?? "",
        lineBefore(text, key.index),
        text.slice(value.lastIndex, value.lastIndex + 8),
      )
    ) {
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

// `Authorization: Basic <base64 of user:password>`: what `curl -v` prints of
// a request, and what a script writes down (review 2026-11-10). `Basic` alone
// says nothing (`Basic functionality`), so the header's name is part of the
// shape, with whatever stands between a name and its value in a header, an
// object or a call (`"Authorization", "Basic ..."`). One capitalised or
// lower-case word is the documentation's (`Authorization: Basic
// credentials`), and what a program works out has a character base64 has not
// (`Basic ${encoded}`).
const BASIC_AUTH_RE =
  /(\bAuthorization\b["']?\s*[:=,]\s*["']?Basic\s+)([A-Za-z0-9+/_-]{8,}={0,2})(?![A-Za-z0-9+/_=-]|[({$<%])/gi;

function redactBasicAuth(text: string): string {
  return text.replace(
    BASIC_AUTH_RE,
    (whole: string, head: string, held: string) =>
      /^[A-Za-z][a-z]+$/u.test(held) ? whole : `${head}[REDACTED:basic_auth]`,
  );
}

// A password inside a URL: `scheme://user:password@host` (review 2026-11-10).
// A git remote, a `DATABASE_URL`, a proxy setting and the command that used
// any of them all print one. Only the password is masked: the line still
// says which host and which user.
//
// Read from each `://` forward to where the authority ends: the path, the
// query, or whatever closes the URL in its text. An `@` further on belongs
// to a path (`https://unpkg.com/react@18.3.1/`, Vite's `/@fs/`) and is never
// read. No two reads overlap, so the walk is linear.
const URL_AUTHORITY_RE = /[^\s/?#"'`<>\\]*/y;
const URL_SCHEME_RE = /[A-Za-z][A-Za-z0-9+.-]*$/;
/** As long as a scheme gets (`mongodb+srv`), with room. */
const SCHEME_LOOKBACK = 24;

// A password a program fills in when it runs, or one already masked: a
// shell's or a template's variable (`$TOKEN`, `${pw}`, `{password}`,
// `{{.Values.pw}}`), a format's slot (`%s`), another tool's own mask
// (`***`), a marker of this file's.
const URL_PASSWORD_READ_RE =
  /^(?:\$[A-Za-z_]\w*|\$?\{[^{}]*\}|\$?\{\{[^{}]*\}\}|%(?:\([^()]*\))?[sdv]|\*+|\[REDACTED:\w+\])$/;

function redactUrlPasswords(text: string): string {
  const authority = new RegExp(URL_AUTHORITY_RE.source, URL_AUTHORITY_RE.flags);
  let out = "";
  let copied = 0;
  let at = text.indexOf("://");
  while (at !== -1) {
    const from = at + 3;
    if (
      !URL_SCHEME_RE.test(text.slice(Math.max(0, at - SCHEME_LOOKBACK), at))
    ) {
      at = text.indexOf("://", from);
      continue;
    }
    authority.lastIndex = from;
    const held = authority.exec(text)?.[0] ?? "";
    const host = held.lastIndexOf("@");
    const colon = held.indexOf(":");
    if (colon !== -1 && colon < host) {
      const password = held.slice(colon + 1, host);
      if (password !== "" && !URL_PASSWORD_READ_RE.test(password)) {
        out += `${text.slice(copied, from + colon + 1)}[REDACTED:url_password]`;
        copied = from + host;
      }
    }
    at = text.indexOf("://", from + held.length);
  }
  return `${out}${text.slice(copied)}`;
}

// The same keys under a colon: YAML, JSON, a header, a line of a log (review
// 2026-11-10; before it only `KEY=value` was read).
//
// A colon is also how code writes a type (`password: string`), a property
// (`token: session.token,`), a label (`"password": "Password"`), a
// dependency (`"jsonwebtoken": "^9.0.2"`) and a parser's complaint
// (`Unexpected token: punc`), and nothing on a line says which file it came
// from. So the rule is narrower than the one for `=`, twice over. The key
// must END in the stem: `max_tokens`, `tokenizer`, `token_type` and
// `secretName` hold no secret. And the value must look like one, which
// starts with having a digit in it: `POSTGRES_PASSWORD: example` is left,
// as `API_KEY: str` has to be.
const COLON_KEY_RE =
  /(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|password|passwd|token|private[_-]?key)$/i;

/** How far back from a colon its key is read. */
const KEY_LOOKBACK = 64;

/** The shortest string taken for a secret: under it are a lexer's `"eof"`
 *  and a version's `"9.0.2"`. */
const QUOTED_SECRET_MIN = 6;

// A value that is filled in when the file is used: a variable of a shell, a
// template or a format (`$DB_PASSWORD`, `${DB_PASSWORD}`, `${{secrets.X}}`,
// `{{.Values.pw}}`, `{password}`, `%(pw)s`), a tokenizer's piece
// (`<|reserved_special_token_0|>`), or a marker of this file's.
// `${NAME:-default}` is not here: the default is written down, and it is
// what gets read (`writtenDown`).
const COLON_READ_RE =
  /^(?:\$[A-Za-z_]\w*|\$\{[A-Za-z_][\w.]*\}|\$?\{\{[^{}]*\}\}|\{[^{}]*\}|<[^<>]*>|%(?:\([^()]*\))?[sdv]|\[REDACTED:\w+\])$/;

/** A file or an address, which names where a secret is kept. */
const PATH_OR_URL_RE =
  /^(?:[~.]{0,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z][A-Za-z0-9+.-]*:\/\/)/;

/** A version or a range of one: a manifest's `"jsonwebtoken": "^9.0.2"`. */
const VERSION_RE =
  /^(?:workspace:)?(?:[~^]|[<>]=?|=|v)?\d+(?:\.(?:\d+|[x*])){1,3}(?:[-+][0-9A-Za-z.+-]*)?$/;

/** `${NAME:-default}`, one level of it. */
const SHELL_DEFAULT_RE = /^\$\{[A-Za-z_]\w*:?[-=+](.*)\}$/;

/** What of a value is written down: a shell default's default, or all of
 *  it. The name in front says nothing (`${GITHUB_TOKEN_2024:-}`). */
const writtenDown = (value: string): string =>
  SHELL_DEFAULT_RE.exec(value)?.[1] ?? value;

const isKeyChar = (c: string | undefined): boolean =>
  c !== undefined && /[\w.-]/u.test(c);

const isBlank = (c: string | undefined): boolean => c === " " || c === "\t";

interface ColonKey {
  readonly name: string;
  readonly quoted: boolean;
}

/** The key a colon closes: quoted (`"token":`, with the spaces JSON allows
 *  before the colon) or bare and touching it (`api-key:`,
 *  `spring.datasource.password:`). Read back from the colon, to a bound, so a
 *  key is looked for once per colon whatever the word behind it is made of. */
function keyBefore(text: string, colon: number): ColonKey | null {
  let end = colon;
  while (end > 0 && colon - end < 4 && isBlank(text[end - 1])) end -= 1;
  const quote = text[end - 1];
  if (quote === '"' || quote === "'") {
    let start = end - 1;
    while (
      start > 0 &&
      end - 1 - start <= KEY_LOOKBACK &&
      isKeyChar(text[start - 1])
    ) {
      start -= 1;
    }
    if (start === end - 1 || text[start - 1] !== quote) return null;
    return { name: text.slice(start, end - 1), quoted: true };
  }
  if (end !== colon) return null;
  let start = colon;
  while (
    start > 0 &&
    colon - start <= KEY_LOOKBACK &&
    isKeyChar(text[start - 1])
  ) {
    start -= 1;
  }
  if (start === colon) return null;
  // Cut short by the bound, or a stylesheet's variable (`$token: 12px`).
  const before = text[start - 1];
  if (isKeyChar(before) || before === "$" || before === "@") return null;
  return { name: text.slice(start, colon), quoted: false };
}

/** A string under such a key is a secret when it is one run of characters
 *  with a digit in it. What that leaves: a label or a message (`"Password"`,
 *  `"Must be at least 8 characters"`), a name (`"access_token"`), a
 *  placeholder (`"your-password-here"`), an empty string. */
function holdsQuotedSecret(quoted: string): boolean {
  const value = writtenDown(quoted);
  if (value.length < QUOTED_SECRET_MIN || /\s/u.test(value)) return false;
  if (!/\d/u.test(value)) return false;
  return !(
    COLON_READ_RE.test(value) ||
    VERSION_RE.test(value) ||
    PATH_OR_URL_RE.test(value)
  );
}

/** A bare value is a secret when it is opaque: a long word with a digit in
 *  it, or a digit beside a character no name or type is written with. A
 *  short word with a digit (`hunter2`) is left, as `Uint8Array` has to be. */
function holdsBareSecret(bare: string): boolean {
  const value = writtenDown(bare);
  // A property or an argument in code, a call, an index.
  if (/[,;)\]}]$/u.test(value) || /[([]/u.test(value)) return false;
  // A number, a date; then YAML's own alias, anchor, tag and block marks.
  if (!/[A-Za-z]/u.test(value) || /^[*&!|>]/u.test(value)) return false;
  if (COLON_READ_RE.test(value) || PATH_OR_URL_RE.test(value)) return false;
  // What reads the environment: `process.env.GITHUB_TOKEN_2024`.
  if (/(?:^|\.)env\.[A-Za-z_]/u.test(value)) return false;
  return (
    hasOpaqueWord(value) ||
    (/\d/u.test(value) && /[!@#%^&*+=~/\\]/u.test(value))
  );
}

/** Where the secret under a key's colon stands, or null for none. */
function colonSecret(
  text: string,
  colon: number,
  key: ColonKey,
): { start: number; end: number } | null {
  let at = colon + 1;
  while (isBlank(text[at])) at += 1;
  const quote = text[at];
  if (quote === '"' || quote === "'") {
    let close = at + 1;
    while (
      close < text.length &&
      text[close] !== quote &&
      text[close] !== "\n"
    ) {
      close += text[close] === "\\" && text[close + 1] !== "\n" ? 2 : 1;
    }
    if (text[close] !== quote) return null;
    return holdsQuotedSecret(text.slice(at + 1, close))
      ? { start: at + 1, end: close }
      : null;
  }
  // JSON's secret is a string: `"max_tokens": 4096` and `"token": token` are
  // not one. And a bare key's colon has a blank after it: `token::Kind`,
  // `token := x` and `a:b` are not a key and its value.
  if (key.quoted || at === colon + 1) return null;
  let end = at;
  while (end < text.length && !/\s/u.test(text[end] as string)) end += 1;
  // Alone to the end of its line, or to a comment: `token: string | null`,
  // `token: expired, retrying` and `Authorization: token abc` are sentences.
  let rest = end;
  while (isBlank(text[rest])) rest += 1;
  const next = text[rest];
  if (
    next !== undefined &&
    next !== "\n" &&
    next !== "\r" &&
    !(next === "#" && rest > end)
  ) {
    return null;
  }
  // `echo "token: abc"` closes its quote after the value.
  while (end > at && /["'`]/u.test(text[end - 1] as string)) end -= 1;
  return holdsBareSecret(text.slice(at, end)) ? { start: at, end } : null;
}

function redactColonSecrets(text: string): string {
  let out = "";
  let copied = 0;
  let colon = text.indexOf(":");
  while (colon !== -1) {
    const key = keyBefore(text, colon);
    const held =
      key !== null && COLON_KEY_RE.test(key.name)
        ? colonSecret(text, colon, key)
        : null;
    if (held === null) {
      colon = text.indexOf(":", colon + 1);
      continue;
    }
    out += `${text.slice(copied, held.start)}[REDACTED:secret_value]`;
    copied = held.end;
    colon = text.indexOf(":", held.end);
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
  out = redactUrlPasswords(redactBasicAuth(out));
  return redactColonSecrets(redactEnvSecrets(out));
}
