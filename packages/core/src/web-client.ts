/**
 * The web seam 板砖's two web tools run on (ADR 0080): a search and a page
 * fetch, both answered by the model provider's own endpoints.
 *
 * Declared here, implemented in `@herta/providers`, injected into
 * `@herta/tools` — the shape `DigestModel` set (ADR 0043): the tool package
 * depends on core only, so whatever reaches the network is handed to it.
 */

/** One search result, as 板砖 and the record read it. */
export interface WebSearchHit {
  readonly title: string;
  readonly url: string;
  /** The site's own name ("Vitest", "Stack Overflow"); null when the
   *  provider does not say. */
  readonly site: string | null;
  /** RFC 3339, when the provider knows the page's date. */
  readonly date: string | null;
  /** A model-oriented summary of the page (DeepSeek's `summary`), falling
   *  back to the display snippet. */
  readonly summary: string;
}

/** A fetched page, as Markdown. */
export interface WebPage {
  /** Empty when the page has none. */
  readonly title: string;
  readonly markdown: string;
}

/**
 * Why a web call failed, in the words the tools turn into a result:
 *
 *  - `not_found` — no usable content: unreachable, missing, or a type the
 *    fetcher does not read (a PDF);
 *  - `rejected` — the provider's own policy refused the URL;
 *  - `balance` — the account is out of credit;
 *  - `auth` — the key was refused;
 *  - `invalid` — the request itself was malformed;
 *  - `unavailable` — rate limit, timeout, a 5xx or the network, after the
 *    client's own retry.
 */
export type WebFailure =
  | "not_found"
  | "rejected"
  | "balance"
  | "auth"
  | "invalid"
  | "unavailable";

export class WebClientError extends Error {
  readonly code: WebFailure;
  readonly status?: number;

  constructor(code: WebFailure, message: string, status?: number) {
    super(message);
    this.name = "WebClientError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export interface WebClient {
  /** Up to the client's own result count; an empty list is a success. */
  search(query: string, signal: AbortSignal): Promise<readonly WebSearchHit[]>;
  /** Throws `WebClientError`; rethrows an abort. */
  fetchPage(url: string, signal: AbortSignal): Promise<WebPage>;
}
