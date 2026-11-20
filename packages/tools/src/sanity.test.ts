import type { HertaTool } from "@herta/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolJsonSchema } from "./json-schema.js";

describe("@herta/tools sanity", () => {
  it("compiles with workspace dep on @herta/core", () => {
    const t: Partial<HertaTool> = { name: "noop" };
    expect(t.name).toBe("noop");
  });

  it("zod resolves, and a schema converts to JSON Schema", () => {
    const schema = z.object({ x: z.number() });
    const json = toolJsonSchema(schema);
    expect(json).toBeDefined();
    expect(typeof json).toBe("object");
  });
});
