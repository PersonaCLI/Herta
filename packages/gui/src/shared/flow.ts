/**
 * Flow as the renderer sees it (ADR 0084): plain data main maps from the
 * app-server's store, so the panel never depends on its internals. A post's
 * picture is a `herta-flow:` URL main serves from the store (§8), or null
 * for the designed cover.
 */

export interface FlowPostView {
  readonly id: string;
  readonly url: string;
  readonly site: string;
  /** The day the source gives, `YYYY-MM-DD`, or null. */
  readonly date: string | null;
  readonly title: string;
  readonly summary: string;
  readonly why: string;
  readonly detail: string;
  readonly points: readonly string[];
  /** Herta's word, or null when no candidate passed (§7). */
  readonly word: string | null;
  readonly picture: string | null;
}

export interface FlowHitView {
  readonly title: string;
  readonly site: string;
  readonly date: string | null;
  readonly url: string;
  /** Kept, or why it was dropped. */
  readonly fate: string;
}

/** How an issue was made (PHILOSOPHY §9): what was asked, found and read. */
export interface FlowEvidenceView {
  readonly queries: readonly string[];
  readonly hits: readonly FlowHitView[];
  readonly pages: readonly string[];
}

export interface FlowIssueView {
  readonly id: string;
  /** The broadcast's episode number, counting from the first issue. */
  readonly number: number;
  /** The local day it was made for, `YYYY-MM-DD`. */
  readonly localDate: string;
  readonly lang: "zh" | "en";
  readonly posts: readonly FlowPostView[];
  readonly evidence: FlowEvidenceView;
}

/** Why the day's issue did not come, in words the panel can say. */
export type FlowFailure =
  | "no_key"
  /** No source has anything to search for. */
  | "no_interests"
  | "balance"
  | "auth"
  | "network"
  | "other";

export interface FlowStateView {
  readonly enabled: boolean;
  /** The issue being gathered: its stage and, where it counts, i of n. */
  readonly gathering: {
    readonly stage: "queries" | "search" | "cards" | "detail" | "word";
    readonly i?: number;
    readonly n?: number;
  } | null;
  readonly failed: FlowFailure | null;
  /** The newest issue not yet opened, for the button's dot. */
  readonly unreadIssueId: string | null;
  /** Refreshes left today: three a day (§5). */
  readonly refreshesLeft: number;
}

/** What "Refresh now" did: started, or why not. */
export type FlowRefreshOutcome =
  | "started"
  | "off"
  | "no_key"
  | "running"
  | "limit";

export type FlowEvent =
  | { readonly kind: "state"; readonly state: FlowStateView }
  | { readonly kind: "issue"; readonly issue: FlowIssueView };

/** Flow's settings as Settings → Flow edits them (§4, amendment "topics
 *  are picked"): the switch and the picked keywords, by id. */
export interface FlowSettingsView {
  readonly enabled: boolean;
  readonly topics: readonly string[];
}
