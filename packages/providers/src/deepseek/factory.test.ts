import type { PromptFrame } from "@herta/core";
import { describe, expect, it } from "vitest";
import { deepseekProvider } from "./factory.js";

const userOnly: PromptFrame = {
  stableSystem: "",
  repoInstructions: "",
  memoryContext: "",
  retrievedLore: "",
  messages: [{ role: "user", text: "hi", ts: "t" }],
  toolSchemas: [],
};

async function captureRequestBody(
  factoryOpts: Parameters<typeof deepseekProvider>[0],
): Promise<{ url: string; body: Record<string, unknown> }> {
  let captured: { url: string; body: Record<string, unknown> } | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    captured = {
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    return new Response(
      `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
      { status: 200 },
    );
  };
  const provider = deepseekProvider({ ...factoryOpts, fetchImpl });
  for await (const _ of provider.streamChat(
    userOnly,
    new AbortController().signal,
  )) {
    /* drain */
  }
  if (captured === undefined) throw new Error("no request captured");
  return captured;
}

describe("deepseekProvider", () => {
  it("uses default baseUrl and model", async () => {
    const { url, body } = await captureRequestBody({ apiKey: "sk-test" });
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(body.model).toBe("deepseek-v4-pro");
  });

  it("respects model override", async () => {
    const { body } = await captureRequestBody({
      apiKey: "sk",
      model: "deepseek-flash",
    });
    expect(body.model).toBe("deepseek-flash");
  });

  it("does not include thinking fields by default", async () => {
    const { body } = await captureRequestBody({ apiKey: "sk" });
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("thinking:'high' injects thinking + reasoning_effort", async () => {
    const { body } = await captureRequestBody({
      apiKey: "sk",
      thinking: "high",
    });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
  });

  it("thinking:'low' injects thinking + reasoning_effort (flash tier since the 2026-07-31 update)", async () => {
    const { body } = await captureRequestBody({
      apiKey: "sk",
      thinking: "low",
    });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("low");
  });

  it("thinking:'max' injects thinking + reasoning_effort", async () => {
    const { body } = await captureRequestBody({
      apiKey: "k",
      thinking: "max",
    });
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("max");
  });

  it("thinking:false sends the block DISABLED — omitting it would mean the server default, thinking ON at high (doc 2026-09-10)", async () => {
    const { body } = await captureRequestBody({
      apiKey: "sk",
      thinking: false,
    });
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("forwards temperature and maxTokens", async () => {
    const { body } = await captureRequestBody({
      apiKey: "sk",
      temperature: 0.2,
      maxTokens: 256,
    });
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(256);
  });
});
