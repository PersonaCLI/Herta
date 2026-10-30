/**
 * Flow's data shapes (ADR 0084): one issue per local day, each a few cards
 * with Herta's word on them, kept seven days. The internals say `flow`,
 * `issue` and `card` (D2); the surface calls a card a post.
 *
 * Everything here is plain JSON: an issue is written to disk as it is and
 * read back by the desktop's renderer.
 */

export type FlowLang = "zh" | "en";

/** The `flow` section of the app settings (ADR 0084 §10). */
export interface FlowSettings {
  /** Off until the Trailblazer turns it on (§1, question 4). */
  readonly enabled: boolean;
  /** The keywords picked from `FLOW_TOPIC_GROUPS`, by id, at most twelve.
   *  Her page on the Trailblazer is read beside them, always (§4, amendment
   *  "topics are picked"). */
  readonly topics: readonly string[];
}

/** A post as Herta's word is written from (§7): the shape `hertaWordOn`
 *  in @herta/herta takes, declared here so the pipeline stays decoupled. */
export interface FlowWordPost {
  readonly title: string;
  readonly site: string;
  readonly date: string | null;
  readonly summary: string;
  readonly why: string;
}

/** One post's data, as the pipeline wrote and code checked it (§5). */
export interface FlowCard {
  /** The source page: always one of the issue's search hits' URLs. */
  readonly url: string;
  /** The site's name, from the hit (or the URL's host). */
  readonly site: string;
  /** The hit's date, as the provider gave it (RFC 3339 or a day). */
  readonly date: string;
  /** ≤ 80 characters, plain text. */
  readonly title: string;
  /** ≤ 280 characters, plain text. */
  readonly summary: string;
  /** Why it is here, ≤ 80 characters; may be empty. */
  readonly why: string;
  /** The write-up from the fetched page, ≤ 1 500 characters; the hit's own
   *  summary when the page could not be read. */
  readonly detail: string;
  /** Key points, at most five of ≤ 80 characters. */
  readonly points: readonly string[];
  /** Herta's word on it (§7); null when she has none that passed. Never
   *  fallback text in her name. */
  readonly word: string | null;
  /** The page's preview picture (§8), kept as `images/<issueId>/<picture>`:
   *  its file name; null when the page named none or it failed the guard. */
  readonly picture: string | null;
}

/** Why a hit did not go on to the card call (§3's evidence). */
export type FlowHitFate =
  | "kept"
  | "stale"
  | "undated"
  | "seen"
  | "duplicate"
  | "over_budget";

export interface FlowEvidenceQuery {
  readonly text: string;
  /** Who wrote it: the side model, or code from the interests when the
   *  model's queries were unusable (§5 step 1). */
  readonly from: "model" | "fallback";
  /** Hits the search returned; 0 when it failed. */
  readonly hits: number;
  /** The web client's failure code, or null when the search answered. */
  readonly failure: string | null;
}

export interface FlowEvidenceHit {
  /** Index into `queries`: the search that found it. */
  readonly query: number;
  readonly title: string;
  readonly site: string;
  readonly date: string | null;
  readonly url: string;
  readonly fate: FlowHitFate;
}

export interface FlowEvidencePage {
  readonly url: string;
  /** The fetch answered. Its detail call may still have failed, and then
   *  the card's detail is the hit's own summary. */
  readonly ok: boolean;
  /** The page's own title, when read. */
  readonly title: string;
  /** The page's length in characters, when read. */
  readonly chars: number;
  /** Where the page was kept, relative to the flow dir; null when it was
   *  not read or not kept. */
  readonly file: string | null;
  /** Why it was not read: the web client's code, or `refused` when the URL
   *  failed `checkFetchUrl`. */
  readonly failure: string | null;
}

/** How many calls of each kind the issue made, retries included. Every
 *  call's cost is in `usage.jsonl` (§11). */
export interface FlowCallCounts {
  readonly queries: number;
  readonly search: number;
  readonly cards: number;
  readonly fetch: number;
  readonly detail: number;
  readonly word: number;
}

/** What was asked and found, shown behind the day's tab (§3,
 *  PHILOSOPHY §9). */
export interface FlowEvidence {
  readonly queries: readonly FlowEvidenceQuery[];
  readonly hits: readonly FlowEvidenceHit[];
  readonly pages: readonly FlowEvidencePage[];
  readonly calls: FlowCallCounts;
}

export interface FlowIssue {
  /** `<YYYY-MM-DD>-<n>`: the local date, and the n-th issue of that day
   *  (a refresh makes the next one). */
  readonly id: string;
  /** `YYYY-MM-DD`, local. */
  readonly localDate: string;
  /** The episode number, counting from the first issue ever (§3). */
  readonly number: number;
  /** The GUI's language when it was gathered; an issue keeps its own. */
  readonly lang: FlowLang;
  /** ISO 8601. */
  readonly createdAt: string;
  /** At most five; none is "nothing new", an issue all the same: its
   *  evidence says why. */
  readonly cards: readonly FlowCard[];
  readonly evidence: FlowEvidence;
}

/** Why an issue could not be made, for the panel's plain words (§3). */
export type FlowFailure =
  /** No key to call with. */
  | "no_key"
  /** No source has anything in it: nothing to search for. */
  | "no_interests"
  /** The account is out of credit. */
  | "balance"
  /** The key was refused. */
  | "auth"
  /** Every search failed for the network or the provider's availability. */
  | "network"
  /** Anything else: every search refused, the query or card call failed
   *  twice with nothing to fall back on, the store could not write. */
  | "error";

/** A run's stage, for the gathering state (§3). */
export type FlowStage = "queries" | "search" | "cards" | "detail" | "word";

export interface FlowStageInfo {
  readonly stage: FlowStage;
  /** 1-based step within the stage and the stage's count, for the
   *  per-item stages (search, detail, word). */
  readonly i?: number;
  readonly n?: number;
}

/** What the panel needs to draw its state. */
export interface FlowStatus {
  /** An issue is being gathered. */
  readonly running: boolean;
  /** The stage of the run in flight. */
  readonly stage: FlowStageInfo | null;
  /** The issue not yet opened, for the button's dot. An issue with no
   *  posts is never unread: there is nothing to pull the Trailblazer to. */
  readonly unread: string | null;
  /** When the last issue run started, ms epoch. */
  readonly lastAttemptAt: number | null;
  /** The last attempt's failure, until an attempt succeeds. */
  readonly lastFailure: {
    readonly at: number;
    readonly reason: FlowFailure;
  } | null;
  /** Manual refreshes left today (three a day, §5). */
  readonly refreshesLeft: number;
}

/** What `FlowService` tells its host. */
export type FlowEvent =
  | ({ readonly kind: "stage" } & FlowStageInfo)
  | {
      readonly kind: "landed";
      readonly issueId: string;
      readonly cards: number;
    }
  | { readonly kind: "failed"; readonly reason: FlowFailure }
  | { readonly kind: "state"; readonly status: FlowStatus };
