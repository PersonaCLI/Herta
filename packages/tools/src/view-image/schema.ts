import { z } from "zod";
import { toolJsonSchema } from "../json-schema.js";

/**
 * Paths to look at (ADR 0048 slice 3). An array rather than a single path
 * because comparison is a real ask — "which of these two screenshots has the
 * error" — and one call keeps both pictures in the same message.
 *
 * Strict, for the reason show_excerpt's schema records: non-strict zod
 * silently strips a wrong key name, so a call carrying `path` instead of
 * `paths` would be told it gave nothing at all.
 */
export const viewImageInputSchema = z
  .object({
    paths: z
      .array(z.string().min(1, "path must be non-empty"))
      .min(1, "give at least one path")
      .describe(
        "Image files to look at (PNG, JPEG, GIF, WebP, BMP), workspace-relative or an attachment's stored path. Several paths are shown together.",
      ),
  })
  .strict();

export type ViewImageInput = z.infer<typeof viewImageInputSchema>;

export const viewImageJsonSchema = toolJsonSchema(viewImageInputSchema);
