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

export function redactSecrets(text: string): string {
  let out = text.replace(PEM_BLOCK_RE, "[REDACTED:private_key]");
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED:${kind}]`);
  }
  out = out.replace(ENV_SECRET_RE, (_m, key, sep) => {
    return `${key}${sep}[REDACTED:env_secret]`;
  });
  return out;
}
