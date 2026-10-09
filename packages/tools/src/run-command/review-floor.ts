import { stripShellComments } from "../bash/shell-classifier.js";
import { isCredentialPath } from "../credential-denylist.js";

/**
 * The risk a command carries whatever a review model says (ADR 0075,
 * 2026-10-09). The proposed reviewer scores risk and the user's
 * authorization, and a fixed table turns the two into allow or deny. Its
 * replays showed the model stating these floors and not applying them every
 * time, and each slip was an allow. So the harness applies them: the risk
 * the table reads is the higher of the model's score and this floor.
 *
 * Each floor is a shape the text shows, taken from what Claude Code's auto
 * mode blocks by default, and none needs judgement:
 *   - a system change (`command_ask_system`) or a change to what git runs
 *     later (`command_ask_git_internals`) → high;
 *   - fetching a package and running it (`command_ask_download_exec`) →
 *     medium;
 *   - running what the same line downloads → high;
 *   - a flag that disarms a safety check (`--insecure`, `-k` to curl,
 *     `--trusted-host`, `--no-verify`, …) → high;
 *   - a tunnel that makes this machine reachable from outside → high;
 *   - a credential file the line names (`isCredentialPath`) → high, since
 *     what it prints enters the agent's context and so the model's provider
 *   - and critical when the line also reaches the network and no user
 *     message names that file: a credential leaving the machine unasked.
 */
export type ReviewRisk = "low" | "medium" | "high" | "critical";

export interface ReviewFloor {
  readonly risk: ReviewRisk;
  /** Why, one entry per floor that applied (empty at `low`). */
  readonly reasons: readonly string[];
}

const ORDER: readonly ReviewRisk[] = ["low", "medium", "high", "critical"];

/** The higher of two risks. */
export function maxReviewRisk(a: ReviewRisk, b: ReviewRisk): ReviewRisk {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

/** Flags and settings that turn a safety check off. */
const DISARMING =
  /(?:^|[\s"'])(?:--insecure|--no-check-certificate|--trusted-host|--no-verify|--insecure-skip-tls-verify|--disable-content-trust|--allow-unauthenticated|--allow-untrusted|--nogpgcheck|--no-gpg-checks|--skip-tls-verify|--tls-verify=false|--unsafe-perm|--strict-ssl=false|strict-ssl\s+false|sslverify\s+false|NODE_TLS_REJECT_UNAUTHORIZED=0|GIT_SSL_NO_VERIFY=\S|PYTHONHTTPSVERIFY=0)(?=[\s"'=]|$)/i;
/** curl's own short spelling of `--insecure`, alone or in a cluster. */
const CURL_K = /\bcurl(?:\.exe)?\b[^|;&\n]*\s-[A-Za-z]*k[A-Za-z]*(?=\s|$)/;
/** Tunnels that make a local service reachable from the public internet. */
const TUNNEL =
  /\bssh\b[^|;&\n]*\s-[A-Za-z]*R\b|\bngrok\b|\bcloudflared\s+tunnel\b|\blocaltunnel\b|\blt\s+--port\b|\bserveo\.net\b|\bbore\s+local\b|\bfrpc\b|\btailscale\s+funnel\b|\bdevtunnel\b/i;
/** A program that fetches over the network and the file it writes. */
const FETCH_OUTPUT =
  /\b(?:curl(?:\.exe)?|wget|iwr|Invoke-WebRequest|certutil)\b[^|;&\n]*?(?:\s-o\s+|\s-O\s+|\s--output[=\s]+|\s-OutFile\s+|-urlcache\s+(?:-f\s+)?\S+\s+)(["']?)([^\s"';&|)]+)\1/gi;

/** The tokens of a line that name files: words, with the `@`, `<` and
 *  `--opt=` prefixes data flags and redirects put on a path removed. */
function pathTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s|;&()]+/)) {
    const t = raw
      .replace(/^["']+|["']+$/g, "")
      .replace(/^[<>]+/, "")
      .replace(/^--?[A-Za-z][\w-]*=/, "")
      .replace(/^@/, "");
    if (t.length > 0 && /[\\/.~]/.test(t)) out.push(t);
  }
  return out;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

/** The file this line downloads to, when a later command of the line runs
 *  it — as the program, through an interpreter or installer — or makes it
 *  executable. Only a command's first word counts: `unzip x.zip` or `ls x`
 *  after the download only names it. */
function runsWhatItFetches(text: string): string | null {
  for (const m of text.matchAll(FETCH_OUTPUT)) {
    const file = m[2] as string;
    const rest = text.slice((m.index ?? 0) + m[0].length);
    const name = basename(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const at = `\\S*${name}(?=[\\s;&|)"']|$)`;
    const runs = new RegExp(
      // `rest` starts inside the fetch command itself (its URL may follow
      // the output file), so only a separator begins a command.
      `[;&|(\\n]\\s*(?:${at}|chmod\\s+[^;&|\\n]*\\+x\\s+${at}|(?:bash|sh|python3?|node|powershell|pwsh|msiexec\\s+/i|Start-Process)\\s+(?:-\\S+\\s+)*${at})`,
      "i",
    );
    if (runs.test(rest)) return file;
  }
  return null;
}

export function reviewRiskFloor(
  command: string,
  codes: readonly string[],
  userMessages: readonly string[],
): ReviewFloor {
  let risk: ReviewRisk = "low";
  const reasons: string[] = [];
  const raise = (to: ReviewRisk, why: string): void => {
    risk = maxReviewRisk(risk, to);
    reasons.push(why);
  };
  const text = stripShellComments(command);
  if (codes.includes("command_ask_system"))
    raise("high", "changes the system's or the user's settings");
  if (codes.includes("command_ask_git_internals"))
    raise("high", "changes what git runs later");
  if (codes.includes("command_ask_download_exec"))
    raise("medium", "fetches a package and runs it");
  const fetched = runsWhatItFetches(text);
  if (fetched !== null) raise("high", `runs what it downloads (${fetched})`);
  if (DISARMING.test(text) || CURL_K.test(text))
    raise("high", "turns a safety check off");
  if (TUNNEL.test(text))
    raise("high", "makes this machine reachable from outside");
  const creds = pathTokens(text).filter((t) => isCredentialPath(t));
  if (creds.length > 0) {
    raise("high", `names a credential file (${creds.join(", ")})`);
    const reachesOut = codes.some(
      (c) => c === "command_ask_network" || c === "command_ask_download_exec",
    );
    const asked = userMessages.join("\n").toLowerCase();
    const named = creds.some((c) => asked.includes(basename(c).toLowerCase()));
    if (reachesOut && !named)
      raise("critical", "sends a credential file no user message names");
  }
  return { risk, reasons };
}
