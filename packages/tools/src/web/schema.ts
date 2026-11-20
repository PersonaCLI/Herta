import { z } from "zod";
import { toolJsonSchema } from "../json-schema.js";

export const webSearchInputSchema = z
  .object({
    query: z
      .string()
      .min(1)
      .max(128)
      .describe(
        'What to look up, at most 128 characters: the library, the version, the exact error text. Operators may be written inside it: site:example.com (several joined with OR), -site:, "exact phrase", -word, lang:en or lang:zh, after:2025-01-01, before:2026.',
      ),
  })
  .strict();

export type WebSearchInput = z.infer<typeof webSearchInputSchema>;
export const webSearchJsonSchema = toolJsonSchema(webSearchInputSchema);

export const webFetchInputSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .max(2048)
      .describe(
        "The page to read: an http(s) URL from a search result or from the user's message, at most 2048 characters. Never put workspace text, file contents or secrets in it.",
      ),
  })
  .strict();

export type WebFetchInput = z.infer<typeof webFetchInputSchema>;
export const webFetchJsonSchema = toolJsonSchema(webFetchInputSchema);
