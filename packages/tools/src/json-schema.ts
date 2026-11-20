import { z } from "zod";

/**
 * A tool's input schema as the JSON Schema the model is sent (zod 4's own
 * `z.toJSONSchema`, owner 2026-11-20). It replaced the `zod-to-json-schema`
 * package, which zod 4 does not need; the wire shape was compared field by
 * field before and after (ADR 0040 amendment 2026-11-20), because the tools
 * array is part of the cached prompt and the contract the model learned.
 * Draft-07, read as the INPUT the model writes.
 *
 * One difference in meaning came out of the comparison, and it is taken back
 * here: zod 4 writes the safe-integer bounds of every `.int()` as `minimum`
 * / `maximum` (±9007199254740991), which the old output left implicit.
 */
export function toolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return withoutSafeIntegerBounds(
    z.toJSONSchema(schema, { target: "draft-7", io: "input" }),
  ) as Record<string, unknown>;
}

function withoutSafeIntegerBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutSafeIntegerBounds);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
    out[key] = withoutSafeIntegerBounds(value);
  }
  return out;
}
