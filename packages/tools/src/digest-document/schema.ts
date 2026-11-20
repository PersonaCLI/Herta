import { z } from "zod";
import { toolJsonSchema } from "../json-schema.js";

/** One input: the attached document's stored path. Strict, so a stray key
 *  (`file`, `focus`, …) is named rather than silently dropped. */
export const digestDocumentInputSchema = z
  .object({
    path: z
      .string()
      .min(1, "path must be non-empty")
      .describe(
        "The attached document's stored text path (under .herta/attachments/), as the record names it.",
      ),
  })
  .strict();

export type DigestDocumentInput = z.infer<typeof digestDocumentInputSchema>;

export const digestDocumentJsonSchema = toolJsonSchema(
  digestDocumentInputSchema,
);
