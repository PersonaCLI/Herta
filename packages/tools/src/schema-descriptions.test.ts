import { describe, expect, it } from "vitest";
import { createMinimalTools, createMvpTools } from "./index.js";

/**
 * Every tool's model-facing JSON schema describes every field (2026-09-18).
 *
 * The zod-derived schemas used to reach the model with names and types
 * alone, and the permission lab showed what that costs: 9 of 37
 * show_excerpt calls across 30 briefs were a first call with the wrong
 * shape, corrected only by the failure's hint on the second call. Codex
 * derives its schemas with per-field docs and Claude Code describes every
 * field; this guard keeps Herta there — a new tool or a new field without a
 * description fails here, not in a brief.
 */

type JsonSchema = {
  readonly type?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
};

/** Every `properties` entry, at any depth, as "tool.path" → description. */
function fieldDescriptions(
  schema: JsonSchema,
  prefix: string,
  out: Map<string, string | undefined>,
): void {
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const path = `${prefix}.${name}`;
    out.set(path, field.description);
    fieldDescriptions(field, path, out);
    if (field.items !== undefined)
      fieldDescriptions(field.items, `${path}[]`, out);
  }
}

/** The web tools mount only with a client (ADR 0080); a stub that never
 *  answers is enough for their schemas. */
const webClient = {
  search: async () => [],
  fetchPage: async () => ({ title: "", markdown: "" }),
};

describe("every tool schema describes every field", () => {
  const tools = [
    ...createMvpTools({
      digestModel: null,
      vision: true,
      lang: "zh",
      webClient,
    }),
    // The minimal contract's tools. A non-existent bash is fine here: the
    // schema builder only spells example paths with it, and shellPathsFor
    // falls back to an identity mapping when the probe cannot run.
    ...createMinimalTools({
      bashPath: "/nonexistent/bash",
      workspaceShellPath: () => "/ws",
      digestModel: null,
      vision: true,
      lang: "zh",
      webClient,
    }),
  ];

  it("covers both contracts", () => {
    const names = new Set(tools.map((t) => t.name));
    expect(names).toContain("bash");
    expect(names).toContain("str_replace_editor");
    expect(names).toContain("edit_file");
    expect(names).toContain("show_excerpt");
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
  });

  for (const tool of tools) {
    it(`${tool.name}: a description on the tool and on every field`, () => {
      const schema = tool.schema();
      expect(schema.description.trim().length).toBeGreaterThan(0);
      const fields = new Map<string, string | undefined>();
      fieldDescriptions(schema.inputSchema as JsonSchema, tool.name, fields);
      const missing = [...fields.entries()]
        .filter(([, d]) => d === undefined || d.trim().length === 0)
        .map(([path]) => path);
      expect(missing).toEqual([]);
    });
  }
});
