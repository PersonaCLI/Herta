import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/** The page steps' inputs (ADR 0083 §6). Every field says what it is for. */

export const browserNavigateInputSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .max(2048)
      .optional()
      .describe(
        "The page to open: an address on this machine, such as http://localhost:5173/login or localhost:5173. Give url or go, not both.",
      ),
    go: z
      .enum(["back", "forward", "reload"])
      .optional()
      .describe(
        "A history step instead of an address: back, forward or reload.",
      ),
  })
  .strict()
  .refine((v) => (v.url === undefined) !== (v.go === undefined), {
    message: "give exactly one of url or go",
  });

export type BrowserNavigateInput = z.infer<typeof browserNavigateInputSchema>;
export const browserNavigateJsonSchema = zodToJsonSchema(
  browserNavigateInputSchema,
);

export const browserReadInputSchema = z
  .object({
    mode: z
      .enum(["tree", "find", "text", "console", "network"])
      .describe(
        "What to read. tree: the elements you can act on, each with a ref (e12) for browser_act. find: the elements whose name holds a text. text: the page's visible text. console: messages and errors since the last console read. network: the last requests, failures marked.",
      ),
    ref: z
      .string()
      .max(16)
      .optional()
      .describe("tree only: read just this element's part of the page."),
    all: z
      .boolean()
      .optional()
      .describe(
        "tree only: every element with a role (headings, images, text), not only those you can act on.",
      ),
    query: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("find only: the text to look for in element names."),
    onlyErrors: z
      .boolean()
      .optional()
      .describe("console only: errors and uncaught exceptions alone."),
    pattern: z
      .string()
      .max(200)
      .optional()
      .describe("console only: keep only messages holding this text."),
  })
  .strict();

export type BrowserReadInput = z.infer<typeof browserReadInputSchema>;
export const browserReadJsonSchema = zodToJsonSchema(browserReadInputSchema);

const actFields = {
  action: z
    .enum(["click", "type", "key", "scroll", "select", "resize"])
    .describe(
      "click an element; type text into one; press a key; scroll the page; select an option in a select box (or toggle a checkbox); resize the page to a device width.",
    ),
  ref: z
    .string()
    .max(16)
    .optional()
    .describe(
      "The element to act on, as a ref from the latest browser_read or step result (e12). A ref ends with any navigation or newer read.",
    ),
  text: z
    .string()
    .max(4000)
    .optional()
    .describe("type only: the text to type into the element."),
  submit: z
    .boolean()
    .optional()
    .describe("type only: press Enter after the text."),
  key: z
    .string()
    .max(32)
    .optional()
    .describe(
      "key only: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, or one character.",
    ),
  direction: z
    .enum(["up", "down"])
    .optional()
    .describe("scroll only: which way."),
  amount: z
    .number()
    .min(0.25)
    .max(10)
    .optional()
    .describe("scroll only: how many screens; 1 by default."),
  value: z
    .string()
    .max(500)
    .optional()
    .describe(
      "select only: the option to choose, by its text or value. Leave it out to toggle a checkbox or radio.",
    ),
  preset: z
    .enum(["phone", "tablet", "desktop"])
    .optional()
    .describe(
      "resize only: phone is 375×812, tablet 768×1024, desktop the panel's own size.",
    ),
  scheme: z
    .enum(["light", "dark"])
    .optional()
    .describe(
      "resize only: the colour scheme the page is told the system uses.",
    ),
};

const coordFields = {
  x: z
    .number()
    .min(0)
    .max(10_000)
    .optional()
    .describe(
      "click or type by position instead of ref: x in the latest screenshot's pixels.",
    ),
  y: z
    .number()
    .min(0)
    .max(10_000)
    .optional()
    .describe(
      "click or type by position instead of ref: y in the latest screenshot's pixels.",
    ),
};

/** Without eyes, no coordinates: a position means reading a screenshot,
 *  which only a model that reads images can (ADR 0083 §6). */
export const browserActInputSchema = z.object(actFields).strict();
export const browserActWithCoordsInputSchema = z
  .object({ ...actFields, ...coordFields })
  .strict();

export type BrowserActInput = z.infer<typeof browserActWithCoordsInputSchema>;
export const browserActJsonSchema = zodToJsonSchema(browserActInputSchema);
export const browserActWithCoordsJsonSchema = zodToJsonSchema(
  browserActWithCoordsInputSchema,
);

export const browserScreenshotInputSchema = z
  .object({
    region: z
      .object({
        x: z.number().min(0).describe("Left edge, in the page's pixels."),
        y: z.number().min(0).describe("Top edge, in the page's pixels."),
        width: z
          .number()
          .min(1)
          .max(4000)
          .describe("Width, in the page's pixels."),
        height: z
          .number()
          .min(1)
          .max(4000)
          .describe("Height, in the page's pixels."),
      })
      .strict()
      .optional()
      .describe(
        "A part of the page to look at closely; the whole view without it.",
      ),
  })
  .strict();

export type BrowserScreenshotInput = z.infer<
  typeof browserScreenshotInputSchema
>;
export const browserScreenshotJsonSchema = zodToJsonSchema(
  browserScreenshotInputSchema,
);
