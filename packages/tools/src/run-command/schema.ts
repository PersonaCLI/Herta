import { z } from "zod";

/**
 * What the argv rule (`makeRunCommandRule`) is asked about: a program with
 * its arguments, and where it would run. It was `run_command`'s input; that
 * tool is deleted (ADR 0086) and nothing model-facing carries this shape
 * now — the one asker is the launcher, for a dev server's entry (ADR 0083
 * §5). Strict, so a caller that adds a field the rule does not judge hears
 * about it.
 */
export const runCommandInputSchema = z
  .object({
    argv: z
      .array(z.string().min(1, "argv entry must be non-empty"))
      .min(1, "argv must be non-empty")
      .describe(
        'The program and its arguments as separate strings, e.g. ["npm", "test"]. No shell: pipes and redirects are not interpreted.',
      ),
    cwd: z
      .string()
      .min(1, "cwd must be non-empty")
      .optional()
      .describe(
        "Workspace-relative working directory. Default: the workspace root.",
      ),
  })
  .strict();

export type RunCommandInput = z.infer<typeof runCommandInputSchema>;
