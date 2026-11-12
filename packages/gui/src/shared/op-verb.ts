import { type BrowserOpVerb, browserOpVerb } from "@herta/core/browser-host";
import { type ServerOpVerb, serverOpVerb } from "@herta/core/server-host";

/** The op verbs a record row can carry for a live call. A record written
 *  on the standard set (ADR 0086) also holds `Inspecting`, `Searching` and
 *  `Stopping` rows; no live call makes one. */
export type LiveOpVerb =
  | BrowserOpVerb
  | ServerOpVerb
  | "Reading"
  | "Writing"
  | "Running"
  | "Saving memory"
  | "Digesting"
  | "Searching the web"
  | "Reading web page";

/**
 * The verb of the op row a call becomes — `workflowLabel` in the record
 * projection (`@herta/herta`), mirrored here because the desktop does not
 * import the harness. Null for a call with no op row (report_finding,
 * view_image). `viewing`: an editor call that only views a file (a read).
 *
 * Both the live feed (which numbers the calls that make op rows) and the
 * trace card (which names them) read it, so the two never disagree about
 * which calls count. A drift from the projection costs a moment: a live
 * step reads differently from the row that replaces it.
 */
export function opVerbOf(
  tool: string,
  viewing: boolean,
  /** The call's summary once dispatched: a page step's verb follows its
   *  mode or action (`browserOpVerb`, shared with the projection). */
  summary = "",
): LiveOpVerb | null {
  switch (tool) {
    case "show_excerpt":
      return "Reading";
    case "str_replace_editor":
      return viewing ? "Reading" : "Writing";
    case "bash":
      return "Running";
    case "memory_save":
      return "Saving memory";
    case "digest_document":
      return "Digesting";
    case "web_search":
      return "Searching the web";
    case "web_fetch":
      return "Reading web page";
    default:
      return browserOpVerb(tool, summary) ?? serverOpVerb(tool, summary);
  }
}
