import { z } from "zod";
import { toolJsonSchema } from "../json-schema.js";

/**
 * Either an explicit line range OR a match + context window. Both are
 * harness-evaluated against the file on disk — the model never supplies the
 * text itself, which is what makes "verbatim" a guarantee rather than a
 * promise (see the tool's doc comment).
 */
export const showExcerptInputSchema = z
  .object({
    path: z
      .string()
      .min(1, "path must be non-empty")
      .describe("Workspace-relative path of the text file to show."),
    fromLine: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .optional()
      .describe(
        "First line to show, 1-based. Omit it and `match` to show the head of the file.",
      ),
    toLine: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .optional()
      .describe(
        "Last line to show, inclusive. Default: a dozen lines after `fromLine`.",
      ),
    /** Literal substring to centre the excerpt on (first match wins). */
    match: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Literal text to centre the excerpt on (first occurrence); an alternative to `fromLine`.",
      ),
    /** Lines of context each side of `match`. Default 6. */
    context: z
      .number()
      .int()
      .min(0)
      .max(60)
      .optional()
      .describe("Lines of context each side of `match`. Default 6."),
  })
  // Strict, because every range key is OPTIONAL: non-strict zod silently
  // STRIPPED wrong key names (`from`/`startLine`/…), so a call that did carry
  // a range was told "give either `match` or `fromLine`" — technically true,
  // actually misleading (live 板砖 run, user 2026-07-31). Strict names the
  // unrecognized keys instead, and advertises additionalProperties:false in
  // the model-facing JSON schema.
  //
  // A bare `{path}` is VALID (2026-09-18): it shows the head of the file. The
  // "give either `match` or `fromLine`" refine that used to reject it was
  // the single most frequent tool failure in the permission lab — 9 of 37
  // show_excerpt calls across 30 briefs, every one a first call with only
  // the path, corrected on the second call. The model's natural first ask
  // is "show me this file"; the harness answers with its head instead of a
  // rebuke.
  .strict()
  .refine(
    (v) =>
      v.toLine === undefined ||
      v.fromLine === undefined ||
      v.toLine >= v.fromLine,
    "toLine must be >= fromLine",
  );

export type ShowExcerptInput = z.infer<typeof showExcerptInputSchema>;

export const showExcerptJsonSchema = toolJsonSchema(showExcerptInputSchema);
