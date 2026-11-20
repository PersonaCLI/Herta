import { z } from "zod";
import { toolJsonSchema } from "../json-schema.js";

/** One conclusion, one call. Bounds are presentation bounds: the claim is a
 *  record row and a marker line, not a report body. */
export const MAX_FINDING_CLAIM_CHARS = 400;
export const MAX_FINDING_CITES = 6;

/** `path`, `path:line`, or `path:from-to`. Windows drive letters never appear
 *  here (paths are workspace-relative), so the first `:` splits path from
 *  lines. */
export const CITE_PATTERN = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/;

export const reportFindingInputSchema = z
  .object({
    claim: z
      .string()
      .min(8, "claim must be a sentence, not a word")
      .max(
        MAX_FINDING_CLAIM_CHARS,
        `claim must be at most ${MAX_FINDING_CLAIM_CHARS} chars`,
      )
      .describe(
        `One conclusion as one sentence, at most ${MAX_FINDING_CLAIM_CHARS} characters, in the conversation's language.`,
      ),
    cites: z
      .array(z.string().min(1))
      .min(
        1,
        "cite at least one path:line — an uncited conclusion is not a finding",
      )
      .max(MAX_FINDING_CITES)
      .describe(
        `Where the claim rests: \`path\`, \`path:line\` or \`path:from-to\` (workspace-relative, lines you actually read). At most ${MAX_FINDING_CITES}.`,
      ),
  })
  .strict();

export type ReportFindingInput = z.infer<typeof reportFindingInputSchema>;

export const reportFindingJsonSchema = toolJsonSchema(reportFindingInputSchema);
